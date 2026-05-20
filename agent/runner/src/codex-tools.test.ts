import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./codex-mcp-tools.js', () => ({
  listCodexMcpTools: vi.fn(async () => []),
  executeCodexMcpTool: vi.fn(async () => null),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 4321;
  return proc;
}

let fakeProc = createFakeProcess();

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

const testIpcDir = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('fs');
  const nodePath = require('node:path') as typeof import('path');
  const root = nodePath.join(process.cwd(), 'tmp', 'vitest-nanoclaw-ipc');
  nodeFs.mkdirSync(nodePath.join(root, 'approvals', 'requests'), {
    recursive: true,
  });
  nodeFs.mkdirSync(nodePath.join(root, 'approvals', 'responses'), {
    recursive: true,
  });
  process.env.NANOCLAW_IPC_DIR = root;
  return root;
});

import {
  __testing,
  buildCodexOpenAiTools,
  buildCodexResponsesTools,
  executeTool,
} from './codex-tools.js';
import { executeCodexMcpTool, listCodexMcpTools } from './codex-mcp-tools.js';
import { setApprovalEventEmitter } from './mutation-approval.js';
import { spawn, spawnSync } from 'child_process';

const npxAvailable = (() => {
  try {
    const probe = spawnSync('npx', ['--version'], { encoding: 'utf-8' });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
})();

const rgAvailable = (() => {
  try {
    const probe = spawnSync('rg', ['--version'], { encoding: 'utf-8' });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
})();

const createdPaths: string[] = [];

function denyApprovalRequestsForTest() {
  setApprovalEventEmitter({
    emitApprovalRequest: (request) => {
      const responsesDir = path.join(testIpcDir, 'approvals', 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });
      fs.writeFileSync(
        path.join(responsesDir, `${request.id}.json`),
        JSON.stringify({
          decision: 'deny',
          resolvedAt: new Date().toISOString(),
        }),
      );
    },
  });
}

afterEach(() => {
  setApprovalEventEmitter(null);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  __testing.resetManagedSubagentsForTests();
  fakeProc = createFakeProcess();
  for (const target of createdPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('codex web tool selection', () => {
  it('prefers native web_search in Responses mode when provider is auto', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('NANOCLAW_WEB_SEARCH_PROVIDER', 'auto');
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS', '["example.com"]');

    const tools = await buildCodexResponsesTools();
    const nativeTool = tools.find((tool) => tool.type === 'web_search');
    const functionToolNames = tools
      .filter(
        (tool): tool is { type: 'function'; name: string } =>
          tool.type === 'function',
      )
      .map((tool) => tool.name);

    expect(__testing.isCodexNativeWebSearchPreferred()).toBe(true);
    expect(nativeTool).toEqual({
      type: 'web_search',
      external_web_access: true,
      filters: {
        allowed_domains: ['example.com'],
      },
    });
    expect(functionToolNames).not.toContain('search_web');
    expect(functionToolNames).toContain('fetch_url');
  });

  it('keeps local search_web when an explicit NanoClaw provider is configured', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('NANOCLAW_WEB_SEARCH_PROVIDER', 'searxng');

    const tools = await buildCodexResponsesTools();
    const functionToolNames = tools
      .filter(
        (tool): tool is { type: 'function'; name: string } =>
          tool.type === 'function',
      )
      .map((tool) => tool.name);

    expect(__testing.isCodexNativeWebSearchPreferred()).toBe(false);
    expect(tools.some((tool) => tool.type === 'web_search')).toBe(false);
    expect(functionToolNames).toContain('search_web');
  });

  it('keeps local search_web for chat/completions fallback', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('NANOCLAW_WEB_SEARCH_PROVIDER', 'auto');

    const tools = await buildCodexOpenAiTools();
    const functionToolNames = tools.map((tool) => tool.function.name);

    expect(functionToolNames).toContain('search_web');
    expect(functionToolNames).toContain('fetch_url');
  });

  it('hides all local tools when toolPolicy is none', async () => {
    const responsesTools = await buildCodexResponsesTools({
      toolPolicy: 'none',
    });
    const chatTools = await buildCodexOpenAiTools({ toolPolicy: 'none' });

    expect(responsesTools).toEqual([]);
    expect(chatTools).toEqual([]);
  });

  it('keeps only read-only tools when toolPolicy is readonly', async () => {
    vi.stubEnv('NANOCLAW_WEB_SEARCH_ENABLED', 'true');
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '2');

    const tools = await buildCodexOpenAiTools({ toolPolicy: 'readonly' });
    const names = tools.map((tool) => tool.function.name);

    expect(names).toContain('bash');
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('TeamCreate');
  });
});

describe('codex subagent tool gating', () => {
  it('exposes Codex subagent tools when subagents are enabled and depth is below max', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '2');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

    const tools = await buildCodexOpenAiTools();
    const names = tools.map((tool) => tool.function.name);

    expect(__testing.getCodexSubagentRuntimeConfig()).toEqual({
      enabled: true,
      maxDepth: 2,
      currentDepth: 0,
      currentRole: 'main',
      currentControlScope: 'children',
      maxActive: 4,
      activeCount: 0,
      canSpawn: true,
    });
    expect(names).toContain('TeamCreate');
    expect(names).toContain('SendMessage');
    expect(names).toContain('TeamDelete');
    expect(names).toContain('Agent');
  });

  it('hides spawn tools when the current depth already reached the configured max', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '1');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '1');

    const tools = await buildCodexResponsesTools();
    const names = tools
      .filter(
        (tool): tool is { type: 'function'; name: string } =>
          tool.type === 'function',
      )
      .map((tool) => tool.name);

    expect(__testing.getCodexSubagentRuntimeConfig()).toEqual({
      enabled: true,
      maxDepth: 1,
      currentDepth: 1,
      currentRole: 'main',
      currentControlScope: 'children',
      maxActive: 4,
      activeCount: 0,
      canSpawn: false,
    });
    expect(names).not.toContain('TeamCreate');
    expect(names).not.toContain('Agent');
    expect(names).toContain('SendMessage');
    expect(names).toContain('TeamDelete');
  });

  it('hides spawn tools when the current runtime control scope is none', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '1');
    vi.stubEnv('NANOCLAW_SUBAGENT_ROLE', 'leaf');
    vi.stubEnv('NANOCLAW_SUBAGENT_CONTROL_SCOPE', 'none');

    const tools = await buildCodexOpenAiTools();
    const names = tools.map((tool) => tool.function.name);

    expect(__testing.getCodexSubagentRuntimeConfig()).toEqual({
      enabled: true,
      maxDepth: 3,
      currentDepth: 1,
      currentRole: 'leaf',
      currentControlScope: 'none',
      maxActive: 4,
      activeCount: 0,
      canSpawn: false,
    });
    expect(names).not.toContain('TeamCreate');
    expect(names).not.toContain('Agent');
    expect(names).toContain('SendMessage');
    expect(names).toContain('TeamDelete');
  });
});

describe('codex bash workspace path mapping', () => {
  it('executes commands that reference /workspace/extra inside the command body', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-extra-'));
    createdPaths.push(tempDir);
    vi.stubEnv('NANOCLAW_EXTRA_DIR', tempDir);

    const output = await executeTool(
      'bash',
      { command: 'cd /workspace/extra && pwd' },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'review-room',
          chatJid: 'review@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
          toolPolicy: 'readonly',
        },
      },
    );

    expect(output.trim()).toBe(tempDir);
  });

  it('rejects tools disabled by toolPolicy at execution time', async () => {
    const output = await executeTool(
      'read_file',
      { file_path: 'package.json' },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'review-room',
          chatJid: 'review@g.us',
          isMain: false,
          toolPolicy: 'none',
        },
      },
    );

    expect(output).toContain('disabled by the current tool policy (none)');
  });
});

describe('codex persistent subagent tools', () => {
  function emitStructuredOutput(
    proc: ReturnType<typeof createFakeProcess>,
    payload: {
      status: 'success' | 'error';
      result: string | null;
      error?: string;
      requestId?: string;
    },
  ) {
    proc.stdout.push(
      `---NANOCLAW_OUTPUT_START---\n${JSON.stringify(payload)}\n---NANOCLAW_OUTPUT_END---\n`,
    );
  }

  it('supports TeamCreate followed by SendMessage and TeamDelete', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-subagents-'));
    createdPaths.push(tempDir);
    vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);
    let childInputRaw = '';
    const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
    vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
      if (chunk) childInputRaw += chunk.toString();
      return realEnd(chunk);
    }) as any);

    const createPromise = executeTool(
      'TeamCreate',
      {
        prompt: 'Inspect the codebase',
        name: 'Scout',
        role: 'explorer',
        keep_alive: true,
      },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'team-room',
          chatJid: 'team@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
        },
        secrets: {
          AI_PROVIDER: 'codex',
          CODEX_BASE_URL: 'https://example.com',
          CODEX_API_KEY: 'test-key',
          CODEX_MODEL: 'gpt-5.4',
        },
        originTurnId: 'turn-parent',
        originToolCallId: 'tool-parent',
      },
    );

    await Promise.resolve();
    fakeProc.emit('spawn');
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: JSON.parse(childInputRaw).requestId,
      result: 'initial result from subagent',
    });
    const createOutput = await createPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(createOutput).toContain('Scout');
    expect(createOutput).toContain('initial result from subagent');
    const runtimeRoot = path.join(tempDir, '.nanoclaw-subagents');
    const [agentId] = fs.readdirSync(runtimeRoot);
    expect(agentId).toBeTruthy();
    const runtimeMetadata = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, agentId!, 'runtime.json'), 'utf8'),
    ) as {
      originTurnId?: string;
      originToolCallId?: string;
      topologyRole?: string;
      workProfile?: string;
      role?: string;
      controlScope?: string;
    };
    expect(runtimeMetadata).toMatchObject({
      originTurnId: 'turn-parent',
      originToolCallId: 'tool-parent',
      topologyRole: 'orchestrator',
      workProfile: 'explorer',
      role: 'orchestrator',
      controlScope: 'children',
    });

    expect(childInputRaw).toContain('"groupFolder":"team-room"');
    expect(childInputRaw).toContain('"chatJid":"team@g.us"');

    const sendPromise = executeTool(
      'SendMessage',
      { agent_id: agentId, prompt: 'Continue with the next step' },
      process.cwd(),
    );
    await Promise.resolve();

    const ipcInputDir = path.join(runtimeRoot, agentId, 'ipc', 'input');
    const ipcFiles = fs
      .readdirSync(ipcInputDir)
      .filter((entry) => entry.endsWith('.json'));
    expect(ipcFiles.length).toBeGreaterThan(0);
    const followUpPayload = JSON.parse(
      fs.readFileSync(path.join(ipcInputDir, ipcFiles[0]), 'utf8'),
    ) as { requestId?: string; prompt?: string };
    expect(followUpPayload.requestId).toBeTruthy();
    expect(followUpPayload.prompt).toContain('Continue with the next step');
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: followUpPayload.requestId,
      result: 'follow-up result',
    });
    const sendOutput = await sendPromise;
    expect(sendOutput).toContain('follow-up result');

    const deletePromise = executeTool(
      'TeamDelete',
      { agent_id: agentId },
      process.cwd(),
    );
    await Promise.resolve();
    fakeProc.emit('close', 0);
    const deleteOutput = await deletePromise;
    expect(deleteOutput).toContain('Scout');
    expect(deleteOutput).toContain('stopped');
  });

  it('keeps descendant runtime records under the inherited top-level runtime root', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '1');
    vi.stubEnv('NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID', 'parent-runtime');

    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-subagents-'));
    createdPaths.push(tempDir);
    const topRuntimeRoot = path.join(tempDir, '.nanoclaw-subagents');
    const nestedGroupDir = path.join(topRuntimeRoot, 'parent-runtime', 'group');
    fs.mkdirSync(nestedGroupDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GROUP_DIR', nestedGroupDir);
    vi.stubEnv('NANOCLAW_SUBAGENT_RUNTIME_ROOT', topRuntimeRoot);

    let childInputRaw = '';
    const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
    vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
      if (chunk) childInputRaw += chunk.toString();
      return realEnd(chunk);
    }) as any);

    const createPromise = executeTool(
      'TeamCreate',
      {
        prompt: 'Inspect a nested module',
        name: 'Grandchild',
        keep_alive: true,
      },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'team-room',
          chatJid: 'team@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
        },
        secrets: {
          AI_PROVIDER: 'codex',
          CODEX_BASE_URL: 'https://example.com',
          CODEX_API_KEY: 'test-key',
          CODEX_MODEL: 'gpt-5.4',
        },
      },
    );

    await Promise.resolve();
    fakeProc.emit('spawn');
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: JSON.parse(childInputRaw).requestId,
      result: 'nested result',
    });
    await createPromise;

    const runtimeIds = fs
      .readdirSync(topRuntimeRoot)
      .filter((entry) => entry !== 'parent-runtime');
    expect(runtimeIds).toHaveLength(1);
    const [agentId] = runtimeIds;
    expect(
      fs.existsSync(
        path.join(
          nestedGroupDir,
          '.nanoclaw-subagents',
          agentId!,
          'runtime.json',
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(topRuntimeRoot, agentId!, 'runtime.json')),
    ).toBe(true);

    const spawnEnv = vi.mocked(spawn).mock.calls[0]?.[2]
      ?.env as NodeJS.ProcessEnv;
    expect(spawnEnv.NANOCLAW_SUBAGENT_RUNTIME_ROOT).toBe(topRuntimeRoot);
    expect(spawnEnv.NANOCLAW_GROUP_DIR).toBe(
      path.join(topRuntimeRoot, agentId!, 'group'),
    );

    const runtimeMetadata = JSON.parse(
      fs.readFileSync(
        path.join(topRuntimeRoot, agentId!, 'runtime.json'),
        'utf8',
      ),
    ) as { parentRuntimeId?: string; depth?: number };
    expect(runtimeMetadata).toMatchObject({
      parentRuntimeId: 'parent-runtime',
      depth: 2,
    });
  });

  it('times out TeamCreate when the initial managed subagent result never arrives', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
      vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
      vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

      const tempRoot = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tempRoot, { recursive: true });
      const tempDir = fs.mkdtempSync(
        path.join(tempRoot, 'nanoclaw-subagents-'),
      );
      createdPaths.push(tempDir);
      vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);

      const createPromise = executeTool(
        'TeamCreate',
        { prompt: 'Inspect the codebase', name: 'Scout', timeout_ms: 1 },
        process.cwd(),
      );

      await Promise.resolve();
      fakeProc.emit('spawn');
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      await expect(createPromise).resolves.toContain(
        'TeamCreate sub-agent timed out after 300000ms',
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('times out SendMessage when the managed subagent does not answer', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
      vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
      vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

      const tempRoot = path.join(process.cwd(), 'tmp');
      fs.mkdirSync(tempRoot, { recursive: true });
      const tempDir = fs.mkdtempSync(
        path.join(tempRoot, 'nanoclaw-subagents-'),
      );
      createdPaths.push(tempDir);
      vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);
      let childInputRaw = '';
      const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
      vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
        if (chunk) childInputRaw += chunk.toString();
        return realEnd(chunk);
      }) as any);

      const createPromise = executeTool(
        'TeamCreate',
        { prompt: 'Inspect the codebase', name: 'Scout', keep_alive: true },
        process.cwd(),
      );

      await Promise.resolve();
      fakeProc.emit('spawn');
      emitStructuredOutput(fakeProc, {
        status: 'success',
        requestId: JSON.parse(childInputRaw).requestId,
        result: 'initial result from subagent',
      });
      await createPromise;

      const runtimeRoot = path.join(tempDir, '.nanoclaw-subagents');
      const [agentId] = fs.readdirSync(runtimeRoot);
      const sendPromise = executeTool(
        'SendMessage',
        { agent_id: agentId, prompt: 'Continue', timeout_ms: 1 },
        process.cwd(),
      );

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      await expect(sendPromise).resolves.toContain(
        'SendMessage sub-agent timed out after 300000ms',
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('surfaces sub-agent startup failures without converting them into hard tool errors', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-subagents-'));
    createdPaths.push(tempDir);
    vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);
    let childInputRaw = '';
    const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
    vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
      if (chunk) childInputRaw += chunk.toString();
      return realEnd(chunk);
    }) as any);

    const createPromise = executeTool(
      'TeamCreate',
      {
        prompt: 'Inspect the codebase',
        name: 'Scout',
        role: 'explorer',
        keep_alive: true,
      },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'team-room',
          chatJid: 'team@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
        },
        secrets: {
          AI_PROVIDER: 'codex',
          CODEX_BASE_URL: 'https://example.com',
          CODEX_API_KEY: 'test-key',
          CODEX_MODEL: 'gpt-5.4',
        },
      },
    );

    await Promise.resolve();
    fakeProc.emit('spawn');
    emitStructuredOutput(fakeProc, {
      status: 'error',
      requestId: JSON.parse(childInputRaw).requestId,
      result: null,
      error:
        "ENOENT: no such file or directory, mkdir 'D:\\open_source\\nanoclaw\\groups\\global\\.nanoclaw-codex-provider-lock'",
    });

    const output = await createPromise;
    expect(output).toContain('Sub-agent failed:');
    expect(output).toContain('Continue the parent task without this sub-agent');
    expect(output.startsWith('Error:')).toBe(false);
  });

  it('rejects concurrent follow-up requests to the same live subagent', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');

    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-subagents-'));
    createdPaths.push(tempDir);
    vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);
    let childInputRaw = '';
    const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
    vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
      if (chunk) childInputRaw += chunk.toString();
      return realEnd(chunk);
    }) as any);

    const createPromise = executeTool(
      'TeamCreate',
      { prompt: 'Inspect the codebase', name: 'Scout', keep_alive: true },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'team-room',
          chatJid: 'team@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
        },
        secrets: {
          AI_PROVIDER: 'codex',
          CODEX_BASE_URL: 'https://example.com',
          CODEX_API_KEY: 'test-key',
          CODEX_MODEL: 'gpt-5.4',
        },
      },
    );

    await Promise.resolve();
    fakeProc.emit('spawn');
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: JSON.parse(childInputRaw).requestId,
      result: 'initial result from subagent',
    });
    await createPromise;

    const runtimeRoot = path.join(tempDir, '.nanoclaw-subagents');
    const [agentId] = fs.readdirSync(runtimeRoot);

    const firstSendPromise = executeTool(
      'SendMessage',
      { agent_id: agentId, prompt: 'Continue with the next step' },
      process.cwd(),
    );
    await Promise.resolve();

    const secondSendOutput = await executeTool(
      'SendMessage',
      { agent_id: agentId, prompt: 'Do another thing' },
      process.cwd(),
    );
    expect(secondSendOutput).toContain('already has an active request');

    const ipcInputDir = path.join(runtimeRoot, agentId, 'ipc', 'input');
    const ipcFiles = fs
      .readdirSync(ipcInputDir)
      .filter((entry) => entry.endsWith('.json'));
    expect(ipcFiles.length).toBeGreaterThan(0);
    const followUpPayload = JSON.parse(
      fs.readFileSync(path.join(ipcInputDir, ipcFiles[0]), 'utf8'),
    ) as { requestId?: string };
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: followUpPayload.requestId,
      result: 'follow-up result',
    });
    await expect(firstSendPromise).resolves.toContain('follow-up result');
  });

  it('enforces the maximum number of active subagents', async () => {
    vi.stubEnv('NANOCLAW_SUBAGENTS_ENABLED', '1');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_DEPTH', '3');
    vi.stubEnv('NANOCLAW_SUBAGENT_DEPTH', '0');
    vi.stubEnv('NANOCLAW_SUBAGENTS_MAX_ACTIVE', '1');

    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'nanoclaw-subagents-'));
    createdPaths.push(tempDir);
    vi.stubEnv('NANOCLAW_GROUP_DIR', tempDir);
    let childInputRaw = '';
    const realEnd = fakeProc.stdin.end.bind(fakeProc.stdin);
    vi.spyOn(fakeProc.stdin, 'end').mockImplementation(((chunk?: any) => {
      if (chunk) childInputRaw += chunk.toString();
      return realEnd(chunk);
    }) as any);

    const createPromise = executeTool(
      'TeamCreate',
      { prompt: 'Inspect the codebase', name: 'Scout', keep_alive: true },
      process.cwd(),
      {
        agentInput: {
          groupFolder: 'team-room',
          chatJid: 'team@g.us',
          isMain: false,
          workingDirectory: process.cwd(),
        },
        secrets: {
          AI_PROVIDER: 'codex',
          CODEX_BASE_URL: 'https://example.com',
          CODEX_API_KEY: 'test-key',
          CODEX_MODEL: 'gpt-5.4',
        },
      },
    );

    await Promise.resolve();
    fakeProc.emit('spawn');
    emitStructuredOutput(fakeProc, {
      status: 'success',
      requestId: JSON.parse(childInputRaw).requestId,
      result: 'initial result from subagent',
    });
    await createPromise;

    expect(__testing.getCodexSubagentRuntimeConfig()).toEqual({
      enabled: true,
      maxDepth: 3,
      currentDepth: 0,
      currentRole: 'main',
      currentControlScope: 'children',
      maxActive: 1,
      activeCount: 1,
      canSpawn: false,
    });

    const tools = await buildCodexOpenAiTools();
    const names = tools.map((tool) => tool.function.name);
    expect(names).not.toContain('TeamCreate');
    expect(names).not.toContain('Agent');

    const secondCreateOutput = await executeTool(
      'TeamCreate',
      { prompt: 'Inspect another module', name: 'Builder', keep_alive: true },
      process.cwd(),
    );
    expect(secondCreateOutput).toContain(
      'Maximum active sub-agent limit reached',
    );
  });
});

describe('codex tool output limits', () => {
  it('truncates oversized read_file output before returning it', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-'),
    );
    createdPaths.push(tempDir);
    const filePath = path.join(tempDir, 'huge.log');
    const hugeLine = 'x'.repeat(320_000);
    fs.writeFileSync(filePath, `${hugeLine}\n${hugeLine}\n`, 'utf8');

    const output = await executeTool(
      'read_file',
      { file_path: filePath, offset: 1, limit: 10 },
      process.cwd(),
    );

    expect(output.length).toBeLessThanOrEqual(250_000);
    expect(output).toContain('[read_file output truncated:');
    expect(output).toContain('→ ~62500 tokens');
  });
});

describe('codex workspace path enforcement', () => {
  it('reads files through /workspace/extra virtual mappings', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-workspace-'),
    );
    createdPaths.push(tempDir);

    const sharedDir = path.join(tempDir, 'shared');
    const extraRoot = path.join(tempDir, 'workspace-extra');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'ticket.md'), 'ticket body', 'utf8');
    fs.symlinkSync(sharedDir, path.join(extraRoot, '02-shared'), 'dir');

    vi.stubEnv('NANOCLAW_EXTRA_DIR', extraRoot);
    vi.stubEnv('NANOCLAW_ALLOWED_DIRS', JSON.stringify([sharedDir]));
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowlist');

    const output = await executeTool(
      'read_file',
      {
        file_path: '/workspace/extra/02-shared/ticket.md',
      },
      process.cwd(),
    );

    expect(output).toContain('ticket body');
  });

  it('blocks symlink escapes that resolve outside allowed directories', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-symlink-'),
    );
    createdPaths.push(tempDir);

    const allowedDir = path.join(tempDir, 'allowed');
    const extraRoot = path.join(tempDir, 'workspace-extra');
    const secretDir = path.join(tempDir, 'secret');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret', 'utf8');
    fs.symlinkSync(secretDir, path.join(allowedDir, 'secret-link'), 'dir');
    fs.symlinkSync(allowedDir, path.join(extraRoot, '02-allowed'), 'dir');

    vi.stubEnv('NANOCLAW_EXTRA_DIR', extraRoot);
    vi.stubEnv('NANOCLAW_ALLOWED_DIRS', JSON.stringify([allowedDir]));
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowlist');
    denyApprovalRequestsForTest();

    const output = await executeTool(
      'read_file',
      {
        file_path: '/workspace/extra/02-allowed/secret-link/secret.txt',
      },
      process.cwd(),
    );

    expect(output).toContain('Permission denied:');
  });

  it('uses DirectoryAccess allow-once without persisting the allowed directory', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-allow-once-'),
    );
    createdPaths.push(tempDir);

    const allowedDir = path.join(tempDir, 'allowed');
    const secretDir = path.join(tempDir, 'secret');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret', 'utf8');

    vi.stubEnv('NANOCLAW_ALLOWED_DIRS', JSON.stringify([allowedDir]));
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowlist');
    setApprovalEventEmitter({
      emitApprovalRequest: (request) => {
        const responsesDir = path.join(testIpcDir, 'approvals', 'responses');
        fs.mkdirSync(responsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(responsesDir, `${request.id}.json`),
          JSON.stringify({
            decision: 'allow-once',
            resolvedAt: new Date().toISOString(),
          }),
        );
      },
    });

    const output = await executeTool(
      'read_file',
      {
        file_path: path.join(secretDir, 'secret.txt'),
      },
      allowedDir,
    );

    expect(output).toContain('top secret');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(process.env.NANOCLAW_ALLOWED_DIRS || '[]')).toEqual([
      allowedDir,
    ]);
  });

  it('blocks bash commands that obviously reference paths outside the workspace', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-bash-'),
    );
    createdPaths.push(tempDir);

    const allowedDir = path.join(tempDir, 'allowed');
    const secretDir = path.join(tempDir, 'secret');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret', 'utf8');

    vi.stubEnv('NANOCLAW_ALLOWED_DIRS', JSON.stringify([allowedDir]));
    vi.stubEnv('NANOCLAW_PROJECT_ROOT', allowedDir);
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowlist');

    const output = await executeTool(
      'bash',
      {
        command: `cat "${path.join(secretDir, 'secret.txt')}"`,
      },
      allowedDir,
    );

    expect(output).toContain(
      'Permission denied: bash command references path outside the workspace',
    );
  });

  it('does not map /workspace/project when no project root is configured', async () => {
    const tempRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(
      path.join(tempRoot, 'nanoclaw-codex-tools-no-project-root-'),
    );
    createdPaths.push(tempDir);

    const groupDir = path.join(tempDir, 'group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'note.txt'), 'group note', 'utf8');

    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_PROJECT_ROOT', '');
    vi.stubEnv('NANOCLAW_ALLOWED_DIRS', JSON.stringify([groupDir]));
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowlist');
    denyApprovalRequestsForTest();

    const output = await executeTool(
      'read_file',
      {
        file_path: '/workspace/project/note.txt',
      },
      groupDir,
    );

    expect(output).toContain('Permission denied:');
  });
});

describe('codex MCP browser tools', () => {
  it('includes MCP browser tools in responses and chat-completions tool lists', async () => {
    vi.mocked(listCodexMcpTools).mockResolvedValue([
      {
        name: 'mcp__nanoclaw__browser_role_snapshot',
        description: '[MCP:nanoclaw] Browser role snapshot',
        parameters: {
          type: 'object',
          properties: {
            target_id: { type: 'string' },
          },
        },
      },
      {
        name: 'mcp__nanoclaw__browser_act',
        description: '[MCP:nanoclaw] Browser act',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
          },
        },
      },
    ]);

    const responsesTools = await buildCodexResponsesTools();
    const responseNames = responsesTools
      .filter(
        (tool): tool is { type: 'function'; name: string } =>
          tool.type === 'function',
      )
      .map((tool) => tool.name);
    expect(responseNames).toContain('mcp__nanoclaw__browser_role_snapshot');
    expect(responseNames).toContain('mcp__nanoclaw__browser_act');

    const chatTools = await buildCodexOpenAiTools();
    const chatNames = chatTools.map((tool) => tool.function.name);
    expect(chatNames).toContain('mcp__nanoclaw__browser_role_snapshot');
    expect(chatNames).toContain('mcp__nanoclaw__browser_act');
  });

  it('forwards MCP browser tool execution to the MCP executor', async () => {
    vi.mocked(executeCodexMcpTool).mockResolvedValue(
      'Browser action completed for target tab-1.',
    );
    const input = {
      kind: 'waitFor',
      selector: '.toast-success',
      url_includes: '/done',
      timeout_ms: 8000,
      poll_interval_ms: 200,
    };

    const output = await executeTool(
      'mcp__nanoclaw__browser_act',
      input,
      process.cwd(),
    );

    expect(executeCodexMcpTool).toHaveBeenCalledWith(
      'mcp__nanoclaw__browser_act',
      input,
    );
    expect(output).toBe('Browser action completed for target tab-1.');
  });
});

describe('codex tool execution coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tools-test-'));
    vi.mocked(executeCodexMcpTool).mockResolvedValue(null);
    vi.stubEnv('NANOCLAW_ACCESS_MODE', 'allowall');
    setApprovalEventEmitter({
      emitApprovalRequest: (request) => {
        const responsesDir = path.join(testIpcDir, 'approvals', 'responses');
        fs.mkdirSync(responsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(responsesDir, `${request.id}.json`),
          JSON.stringify({
            decision: 'allow-once',
            resolvedAt: new Date().toISOString(),
          }),
        );
      },
    });
  });

  afterEach(() => {
    setApprovalEventEmitter(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write_file writes a file with the expected content', async () => {
    const target = path.join(tmpDir, 'out.txt');
    const output = await executeTool(
      'write_file',
      { file_path: target, content: 'hello codex' },
      tmpDir,
    );
    expect(output).toContain('File written');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello codex');
  });

  it('write_file creates parent directories for nested paths', async () => {
    const target = path.join(tmpDir, 'nested', 'deep', 'note.md');
    await executeTool(
      'write_file',
      { file_path: target, content: 'nested' },
      tmpDir,
    );
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('nested');
  });

  it('edit_file replaces old_string with new_string', async () => {
    const target = path.join(tmpDir, 'edit-me.txt');
    fs.writeFileSync(target, 'alpha\nbeta\ngamma\n', 'utf8');
    const output = await executeTool(
      'edit_file',
      {
        file_path: target,
        old_string: 'beta',
        new_string: 'BETA',
      },
      tmpDir,
    );
    expect(output).toContain('File edited');
    expect(fs.readFileSync(target, 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('edit_file errors when old_string is not found', async () => {
    const target = path.join(tmpDir, 'no-match.txt');
    fs.writeFileSync(target, 'only one line\n', 'utf8');
    const output = await executeTool(
      'edit_file',
      {
        file_path: target,
        old_string: 'missing',
        new_string: 'x',
      },
      tmpDir,
    );
    expect(output).toContain('old_string not found');
  });

  it('glob returns matching file paths', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.txt'), 'a', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b', 'utf8');
    const output = await executeTool(
      'glob',
      { pattern: '*.txt', dir: tmpDir },
      tmpDir,
    );
    const lines = output.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((line) => line.includes(`${path.sep}a.txt`))).toBe(true);
    expect(lines.some((line) => line.includes(`${path.sep}b.txt`))).toBe(true);
  });

  it('glob returns (no matches) when nothing matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'only.js'), '// x', 'utf8');
    const output = await executeTool(
      'glob',
      { pattern: '**/*.missing_ext_xyz', dir: tmpDir },
      tmpDir,
    );
    expect(output.trim()).toBe('(no matches)');
  });

  it.skipIf(!rgAvailable)(
    'grep returns matching lines for a regex pattern',
    async () => {
      const filePath = path.join(tmpDir, 'sample.log');
      fs.writeFileSync(
        filePath,
        ['line one', 'needle here', 'line three'].join('\n'),
        'utf8',
      );
      const output = await executeTool(
        'grep',
        { pattern: 'needle', path: tmpDir },
        tmpDir,
      );
      expect(output).toContain('needle here');
    },
  );

  it.skipIf(!rgAvailable)(
    'grep returns (no matches) when the pattern does not match',
    async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'empty-ish.txt'),
        'nothing to see',
        'utf8',
      );
      const output = await executeTool(
        'grep',
        { pattern: 'zzzznotfound', path: tmpDir },
        tmpDir,
      );
      expect(output.trim()).toBe('(no matches)');
    },
  );

  it('list_dir lists directory entries with structure markers', async () => {
    fs.mkdirSync(path.join(tmpDir, 'folder'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'x', 'utf8');
    const output = await executeTool(
      'list_dir',
      { dir_path: tmpDir, depth: 1 },
      tmpDir,
    );
    expect(output).toContain('📁 folder');
    expect(output).toContain('📄 readme.txt');
  });

  it('list_dir walks nested directories when depth > 1', async () => {
    fs.mkdirSync(path.join(tmpDir, 'outer', 'inner'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'outer', 'inner', 'leaf.txt'),
      'x',
      'utf8',
    );
    const output = await executeTool(
      'list_dir',
      { dir_path: tmpDir, depth: 3 },
      tmpDir,
    );
    expect(output).toContain('outer');
    expect(output).toContain('inner');
    expect(output).toContain('leaf.txt');
  });

  it.skipIf(!npxAvailable)(
    'read_lints runs on a valid TypeScript file without crashing',
    async () => {
      const tsPath = path.join(tmpDir, 'valid.ts');
      fs.writeFileSync(tsPath, 'export const value: number = 1;\n', 'utf8');
      const output = await executeTool(
        'read_lints',
        { paths: [tsPath] },
        tmpDir,
      );
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    },
  );

  it('read_lints reports no lint targets when paths are missing on disk', async () => {
    const missing = path.join(tmpDir, 'missing.ts');
    expect(fs.existsSync(missing)).toBe(false);
    const output = await executeTool(
      'read_lints',
      { paths: [missing] },
      tmpDir,
    );
    expect(output).toContain('No lint issues found');
  });

  it('semantic_search returns the no-results tip when KB and memory are unavailable', async () => {
    vi.stubEnv('MEMORY_ENABLED', 'false');
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', '');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', '');
    const output = await executeTool(
      'semantic_search',
      { query: 'anything' },
      tmpDir,
    );
    expect(output).toContain('No semantic search results');
    expect(output).toContain('Tip:');
  });

  it('semantic_search returns an error for an empty query without throwing', async () => {
    vi.stubEnv('MEMORY_ENABLED', 'false');
    const output = await executeTool('semantic_search', { query: '' }, tmpDir);
    expect(output).toContain('Error:');
    expect(output).toContain('query');
  });

  it.skipIf(!rgAvailable)(
    'grep output truncation uses the per-tool 100K limit',
    async () => {
      const filePath = path.join(tmpDir, 'wide.log');
      const lineLength = 400;
      const lineCount = 450;
      const body = Array.from(
        { length: lineCount },
        (_, i) =>
          `${String(i).padStart(5, '0')}:HIT:${'x'.repeat(Math.max(0, lineLength - 10))}`,
      ).join('\n');
      fs.writeFileSync(filePath, `${body}\n`, 'utf8');
      const output = await executeTool(
        'grep',
        { pattern: 'HIT', path: filePath, head_limit: 500 },
        tmpDir,
      );
      expect(output).toContain('[grep output truncated:');
      expect(output).toContain('~25000');
      expect(output).not.toContain('~62500');
    },
  );
});
