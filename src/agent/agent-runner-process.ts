import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  IDLE_TIMEOUT,
} from '../config.js';
import {
  resolveGroupFolderPath,
  resolveGroupRuntimeIpcPath,
} from '../group-folder.js';
import { createModuleLogger, logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import type { AgentRunInput, AgentRunOutput } from './agent-runner-types.js';
import {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from './agent-runner-types.js';
import {
  buildVolumeMounts,
  resolveRunAccessPolicy,
  resolveRunExecutionContext,
} from './agent-runner-mounts.js';
import { ProviderResolutionError, readSecrets, spawnAgent } from './agent-runner-spawn.js';
import { t } from '../i18n/index.js';

function shouldResetTimeoutForOutput(output: AgentRunOutput): boolean {
  return Boolean(
    output.streamChunk ||
      output.event ||
      output.turnEvent ||
      output.approvalRequest ||
      output.approvalResolved ||
      output.result !== null ||
      output.error,
  );
}

function shouldTreatTimeoutAfterOutputAsSuccess(output: AgentRunOutput): boolean {
  const turnEvent = output.turnEvent;
  return Boolean(
    output.streamChunk ||
      output.result !== null ||
      turnEvent?.type === 'turn.completed' ||
      (turnEvent?.type === 'item.completed' &&
        turnEvent.item.type === 'assistant_message' &&
        turnEvent.item.status === 'completed'),
  );
}

function getStructuredTimeoutResetKey(output: AgentRunOutput): string | null {
  if (
    output.streamChunk ||
    output.approvalRequest ||
    output.approvalResolved ||
    output.result !== null ||
    output.error
  ) {
    return null;
  }

  const event = output.event;
  if (event?.kind === 'status' && event.status === 'in_progress') {
    return JSON.stringify({
      scope: 'event',
      id: event.id || '',
      kind: event.kind,
      status: event.status,
      title: event.title,
      body: event.body || '',
    });
  }

  return null;
}

const IPC_INPUT_CLOSE_SENTINEL_NAME = '_close';

function resolveAgentInputDir(
  groupFolder: string,
  runtimeNamespace?: string,
): string {
  const groupIpcDir = resolveGroupRuntimeIpcPath(
    groupFolder,
    runtimeNamespace,
  );
  const inputDir = path.join(groupIpcDir, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  return inputDir;
}
const LOGGED_AGENT_OUTPUT_EXCERPT_LIMIT = 2_000;
const AGENT_RUNNER_AI_LOG_PREFIX = '[agent-runner-ai]';
const providerLog = createModuleLogger('provider');

interface BridgedAgentAiLogPayload {
  kind?: 'ai_request' | 'ai_response' | 'ai_error';
  [key: string]: unknown;
}

function summarizeCapturedAgentOutput(value: string): {
  excerpt: string;
  totalChars: number;
} {
  const totalChars = value.length;
  if (totalChars <= LOGGED_AGENT_OUTPUT_EXCERPT_LIMIT) {
    return {
      excerpt: value,
      totalChars,
    };
  }
  const notice =
    `\n...[truncated for structured log; total ${totalChars} chars]...\n`;
  const budget = Math.max(0, LOGGED_AGENT_OUTPUT_EXCERPT_LIMIT - notice.length);
  const head = Math.ceil(budget * 0.75);
  const tail = Math.max(0, budget - head);
  return {
    excerpt: `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(-tail) : ''}`,
    totalChars,
  };
}

function parseAgentAiLogLine(line: string): BridgedAgentAiLogPayload | null {
  if (!line.startsWith(AGENT_RUNNER_AI_LOG_PREFIX)) {
    return null;
  }
  const raw = line.slice(AGENT_RUNNER_AI_LOG_PREFIX.length).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BridgedAgentAiLogPayload;
  } catch {
    return null;
  }
}

function bridgeAgentAiLog(
  groupName: string,
  agentLabel: string,
  payload: BridgedAgentAiLogPayload,
): boolean {
  if (!payload.kind) return false;
  const message =
    payload.kind === 'ai_request'
      ? 'AI request sent'
      : payload.kind === 'ai_response'
        ? 'AI response received'
        : 'AI request failed';
  const fields = {
    group: groupName,
    agentLabel,
    runtime: 'agent-runner',
    ...payload,
  };
  if (payload.kind === 'ai_error') {
    providerLog.error(fields, message);
  } else {
    providerLog.info(fields, message);
  }
  return true;
}

export function requestAgentClose(
  groupFolder: string,
  runtimeNamespace?: string,
): void {
  const inputDir = resolveAgentInputDir(groupFolder, runtimeNamespace);
  fs.writeFileSync(
    path.join(inputDir, IPC_INPUT_CLOSE_SENTINEL_NAME),
    '',
    'utf8',
  );
}

export function sendAgentPrompt(
  groupFolder: string,
  runtimeNamespace: string | undefined,
  prompt: AgentRunInput['prompt'],
  requestId?: string,
): void {
  const inputDir = resolveAgentInputDir(groupFolder, runtimeNamespace);
  const safeRequestId = String(requestId || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const fileName = [
    Date.now(),
    process.pid,
    Math.random().toString(36).slice(2, 8),
    safeRequestId || 'message',
  ].join('-');
  fs.writeFileSync(
    path.join(inputDir, `${fileName}.json`),
    JSON.stringify({
      type: 'message',
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
      prompt,
    }),
    'utf8',
  );
}

export async function runAgentProcess(
  group: RegisteredGroup,
  input: AgentRunInput,
  onProcess: (proc: ChildProcess, agentLabel: string) => void,
  onOutput?: (output: AgentRunOutput) => Promise<void>,
): Promise<AgentRunOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const accessPolicy = await resolveRunAccessPolicy(group, input);
  const executionContext = resolveRunExecutionContext(
    group,
    input,
    accessPolicy,
  );
  const mounts = await buildVolumeMounts(
    group,
    input.isMain,
    input,
    executionContext,
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentLabel = `nanoclaw-${safeName}-${Date.now()}`;

  logger.debug(
    {
      group: group.name,
      agentLabel,
      mounts: mounts.map(
        (m) => `${m.hostPath} -> ${m.targetPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Agent mount configuration',
  );

  logger.info(
    {
      group: group.name,
      agentLabel,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise<AgentRunOutput>(async (resolve) => {
    let settled = false;
    const settle = (value: AgentRunOutput) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let agentProcess: ChildProcess;
    try {
      agentProcess = await spawnAgent(
        group,
        mounts,
        input,
        accessPolicy,
        executionContext,
      );
    } catch (err) {
      logger.error({ group: group.name, agentLabel, error: err }, 'Failed to spawn agent');
      settle({
        status: 'error',
        result: null,
        error: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let earlyError: Error | null = null;
    agentProcess.on('error', (err) => { earlyError = err; });

    onProcess(agentProcess, agentLabel);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    let resolvedSecrets: Record<string, string>;
    try {
      resolvedSecrets = input.secrets || (await readSecrets(input));
    } catch (err) {
      if (err instanceof ProviderResolutionError) {
        agentProcess.kill();
        settle({ status: 'error', result: null, error: err.message, retryable: false });
        return;
      }
      throw err;
    }
    input.secrets = resolvedSecrets;

    const isCodex = resolvedSecrets.AI_PROVIDER === 'codex';
    const hasCredentials = isCodex
      ? !!(resolvedSecrets.CODEX_API_KEY)
      : !!(resolvedSecrets.ANTHROPIC_API_KEY || resolvedSecrets.ANTHROPIC_AUTH_TOKEN || resolvedSecrets.CLAUDE_CODE_OAUTH_TOKEN);
    if (!hasCredentials) {
      const providerLabel = isCodex ? 'Codex' : 'Claude';
      const errMsg = t(
        'errors.providerCredentialsMissing',
        { providerName: providerLabel },
        undefined,
      );
      logger.error({ group: group.name, agentLabel, provider: resolvedSecrets.AI_PROVIDER || 'claude' }, errMsg);
      agentProcess.kill();
      settle({ status: 'error', result: null, error: errMsg, retryable: false });
      return;
    }

    if (earlyError) {
      const errMsg = (earlyError as Error).message || String(earlyError);
      logger.error({ group: group.name, agentLabel, error: earlyError }, 'Agent spawn error (early)');
      settle({ status: 'error', result: null, error: `Agent spawn error: ${errMsg}` });
      return;
    }
    const isCodexProvider = resolvedSecrets.AI_PROVIDER === 'codex';
    logger.debug(
      {
        secretKeys: Object.keys(resolvedSecrets),
        provider: resolvedSecrets.AI_PROVIDER || 'claude',
        BASE_URL: isCodexProvider
          ? resolvedSecrets.CODEX_BASE_URL || '(none)'
          : resolvedSecrets.ANTHROPIC_BASE_URL || '(none)',
        MODEL: isCodexProvider
          ? resolvedSecrets.CODEX_MODEL || '(none)'
          : resolvedSecrets.ANTHROPIC_MODEL || '(none)',
        HAS_TOKEN: isCodexProvider
          ? resolvedSecrets.CODEX_API_KEY
            ? 'yes'
            : 'no'
          : resolvedSecrets.ANTHROPIC_AUTH_TOKEN
            ? 'yes'
            : 'no',
      },
      'Secrets resolved for agent',
    );
    const stdin = agentProcess.stdin;
    if (stdin) {
      stdin.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code || '';
        if (
          code === 'EOF' ||
          code === 'EPIPE' ||
          code === 'ERR_STREAM_DESTROYED'
        ) {
          logger.warn(
            { group: group.name, agentLabel, code },
            'Agent stdin closed before input finished writing',
          );
          return;
        }
        logger.error(
          { group: group.name, agentLabel, err },
          'Agent stdin write failed',
        );
      });
      try {
        stdin.end(JSON.stringify(input));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code || '';
        if (
          code !== 'EOF' &&
          code !== 'EPIPE' &&
          code !== 'ERR_STREAM_DESTROYED'
        ) {
          throw err;
        }
        logger.warn(
          { group: group.name, agentLabel, code },
          'Agent stdin closed before input write could start',
        );
      }
    }
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let stderrLineBuffer = '';
    let newSessionId: string | undefined;
    let lastErrorRetryable: boolean | undefined;
    let outputChain = Promise.resolve();
    const seenStructuredTimeoutResetKeys = new Set<string>();

    agentProcess.stdout!.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        if (parseBuffer.length > AGENT_MAX_OUTPUT_SIZE) {
          const overflow = parseBuffer.length - AGENT_MAX_OUTPUT_SIZE;
          parseBuffer = parseBuffer.slice(overflow);
          logger.warn(
            {
              group: group.name,
              overflowChars: overflow,
              cap: AGENT_MAX_OUTPUT_SIZE,
            },
            'Agent stdout parse buffer truncated from start (size limit; possible missing OUTPUT_END_MARKER)',
          );
        }
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: AgentRunOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            if (parsed.status === 'error' && parsed.retryable !== undefined) {
              lastErrorRetryable = parsed.retryable;
            }
            if (shouldTreatTimeoutAfterOutputAsSuccess(parsed)) {
              hadStreamingOutput = true;
            }
            if (shouldResetTimeoutForOutput(parsed)) {
              const resetKey = getStructuredTimeoutResetKey(parsed);
              if (!resetKey || !seenStructuredTimeoutResetKeys.has(resetKey)) {
                resetTimeout();
                if (resetKey) {
                  seenStructuredTimeoutResetKeys.add(resetKey);
                }
              }
            }
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed)).catch((outputErr) => {
              logger.error({ group: group.name, error: outputErr }, 'onOutput handler failed');
            });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    const processStderrChunk = (chunk: string, flush = false) => {
      const combined = `${stderrLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stderrLineBuffer = flush ? '' : lines.pop() || '';
      const completeLines = flush ? lines.filter(Boolean) : lines;
      for (const line of completeLines) {
        if (!line) continue;
        const bridged = bridgeAgentAiLog(group.name, agentLabel, parseAgentAiLogLine(line) || {});
        if (!bridged) {
          logger.debug({ groupFolder: group.folder }, line);
        }
      }
    };

    agentProcess.stderr!.on('data', (data) => {
      const chunk = data.toString();
      processStderrChunk(chunk);
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.agentConfig?.timeout || AGENT_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, agentLabel },
        'Agent timeout, stopping gracefully',
      );
      agentProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!agentProcess.killed) agentProcess.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    agentProcess.on('close', (code) => {
      clearTimeout(timeout);
      processStderrChunk('', true);
      const duration = Date.now() - startTime;

      const workspaceExtraRoot = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'workspace-extra',
      );
      try {
        fs.rmSync(workspaceExtraRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; non-critical if it fails
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Agent: ${agentLabel}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // agent process being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, agentLabel, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            settle({
              status: 'success',
              result: null,
              newSessionId,
            });
          }).catch((chainErr) => {
            logger.error({ group: group.name, error: chainErr }, 'Output chain failed during timeout cleanup');
            settle({ status: 'error', result: null, error: 'Output chain failed' });
          });
          return;
        }

        logger.error(
          { group: group.name, agentLabel, duration, code },
          'Agent timed out with no output',
        );

        settle({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.text.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      logLines.push(
        `=== Mounts ===`,
        mounts
          .map(
            (m) =>
              isVerbose || isError
                ? `${m.hostPath} -> ${m.targetPath}${m.readonly ? ' (ro)' : ''}`
                : `${m.targetPath}${m.readonly ? ' (ro)' : ''}`,
          )
          .join('\n'),
        ``,
      );

      if (stderr.trim()) {
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
        );
      }

      if (isVerbose || isError) {
        logLines.push(
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        const stderrSummary = summarizeCapturedAgentOutput(stderr);
        const stdoutSummary = summarizeCapturedAgentOutput(stdout);
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderrSummary.excerpt,
            stdout: stdoutSummary.excerpt,
            stderrChars: stderrSummary.totalChars,
            stdoutChars: stdoutSummary.totalChars,
            stdoutTruncated,
            stderrTruncated,
            logFile,
          },
          'Agent exited with error',
        );

        settle({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-2000)}`,
          retryable: lastErrorRetryable,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        }).catch((chainErr) => {
          logger.error({ group: group.name, error: chainErr }, 'Output chain failed on close');
          resolve({ status: 'error', result: null, error: 'Output chain failed' });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: AgentRunOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Agent completed',
        );

        settle(output);
      } catch (err) {
        const stdoutSummary = summarizeCapturedAgentOutput(stdout);
        const stderrSummary = summarizeCapturedAgentOutput(stderr);
        logger.error(
          {
            group: group.name,
            stdout: stdoutSummary.excerpt,
            stderr: stderrSummary.excerpt,
            error: err,
          },
          'Failed to parse agent output',
        );

        settle({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    agentProcess.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, agentLabel, error: err },
        'Agent spawn error',
      );
      settle({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}
