import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

import type { AccessMode } from '../auth/access-policy.js';
import {
  canWhitelistBashCommand,
  commandMatchesBashApprovalAllowlist,
  normalizeBashApprovalAllowlist,
} from '../security/bash-approval-allowlist.js';
import { getWebChannel } from '../channels/web.js';
import * as workflowDb from '../db/workflows.js';
import { WorkflowEventBus } from '../workflow/event-bus.js';
import type { WorkflowRealtimeEnvelope } from '../workflow/types.js';
import type { RuntimeApprovalPatchRecord } from '../conversation/conversation-admin-support.js';
import { checkConversationOwnership } from '../conversation/conversation-ownership.js';
import { isActiveMember } from '../im/im-membership-service.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { createModuleLogger } from '../logger.js';
import { SYSTEM_USER_ID, runWithTenantAsync } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

const wsLog = createModuleLogger('websocket');

interface SlashCommandExecutionResult {
  handled: boolean;
  success: boolean;
  output: string;
}

export interface RealtimeWebSocketHandlerOptions {
  refreshTaskSnapshots?: () => void;
  executeSlashCommand: (input: {
    jid: string;
    rawText: string;
    refreshTaskSnapshots?: () => void;
  }) => Promise<SlashCommandExecutionResult>;
  persistWebCommandInboundMessage: (
    jid: string,
    senderName: string,
    rawContent: string,
  ) =>
    | { id: string; timestamp: string }
    | Promise<{ id: string; timestamp: string }>;
  persistWebCommandAssistantMessage: (
    jid: string,
    text: string,
  ) => { id: string; timestamp: string } | Promise<{ id: string; timestamp: string }>;
  formatSlashCommandResultOutput: (
    result: SlashCommandExecutionResult,
    extras?: { uploadsIgnored?: boolean },
  ) => string;
  resolveSocketTenantUserId?: (
    cookie?: string,
  ) => string | Promise<string>;
}

export interface ManagedTerminalConversationState {
  jid: string;
  groupFolder: string;
  accessMode: AccessMode;
  allowedDirectories: string[];
  runtimeApprovalPatches: RuntimeApprovalPatchRecord[];
}

export interface TerminalWebSocketHandlerOptions {
  getConversationRuntime: (
    jid: string,
  ) =>
    | ManagedTerminalConversationState
    | null
    | Promise<ManagedTerminalConversationState | null>;
  resolveSocketTenantUserId?: (
    cookie?: string,
  ) => string | Promise<string>;
}

interface ApprovalResponsePayload {
  decision?: 'allow-once' | 'deny';
  resolvedAt?: string;
}

interface TerminalApprovalRequestPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

interface ManagedTerminalSession {
  ws: WebSocket;
  jid: string;
  runtime: ManagedTerminalConversationState;
  cwd: string | null;
  inputBuffer: string;
  child: ChildProcessWithoutNullStreams | null;
}

const TERMINAL_APPROVAL_TIMEOUT_MS = 120_000;
const TERMINAL_APPROVAL_POLL_MS = 100;
const TERMINAL_APPROVAL_ALLOWLIST = (() => {
  try {
    return normalizeBashApprovalAllowlist(
      process.env.NANOCLAW_BASH_APPROVAL_ALLOWLIST || '[]',
    );
  } catch {
    return [];
  }
})();

const canonicalPathCache = new Map<string, { value: string; expiresAt: number }>();
const CANONICAL_PATH_TTL_MS = 60_000;
const CANONICAL_PATH_CACHE_MAX = 256;

function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const now = Date.now();
  const cached = canonicalPathCache.get(resolved);
  if (cached && cached.expiresAt > now) return cached.value;

  const missingParts: string[] = [];
  let cursor = resolved;

  while (!fs.existsSync(cursor)) {
    const parsed = path.parse(cursor);
    const base = path.basename(cursor);
    if (!base || cursor === parsed.root) {
      return resolved;
    }
    missingParts.unshift(base);
    cursor = path.dirname(cursor);
  }

  let result: string;
  try {
    const realCursor = fs.realpathSync(cursor);
    result = missingParts.length > 0
      ? path.join(realCursor, ...missingParts)
      : realCursor;
  } catch {
    result = resolved;
  }

  if (canonicalPathCache.size >= CANONICAL_PATH_CACHE_MAX) {
    const firstKey = canonicalPathCache.keys().next().value as string;
    canonicalPathCache.delete(firstKey);
  }
  canonicalPathCache.set(resolved, { value: result, expiresAt: now + CANONICAL_PATH_TTL_MS });
  return result;
}

function normalizePathKey(targetPath: string): string {
  return resolveCanonicalPath(targetPath).toLowerCase().replace(/\\/g, '/');
}

function isPathWithinAllowedDirectories(
  targetPath: string,
  allowedDirectories: string[],
): boolean {
  const normalizedTarget = normalizePathKey(targetPath);
  return allowedDirectories.some((dir) => {
    const normalizedDir = normalizePathKey(dir);
    return (
      normalizedTarget === normalizedDir ||
      normalizedTarget.startsWith(`${normalizedDir}/`)
    );
  });
}

function resolveManagedPath(targetPath: string, cwd: string): string {
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
}

function extractShellPathCandidates(command: string): string[] {
  const matches =
    command.match(
      /(^|[\s"'=])((?:\.{1,2}[\\/][^\s"'`;&|()]+)|(?:\/[^\s"'`;&|()]+)|(?:[A-Za-z]:\\[^\s"'`;&|()]+))/g,
    ) || [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const rawMatch of matches) {
    const candidate = rawMatch.replace(/^[\s"'=]+/, '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function precheckManagedCommandPaths(
  command: string,
  cwd: string,
  allowedDirectories: string[],
): string | null {
  for (const candidate of extractShellPathCandidates(command)) {
    const resolved = resolveManagedPath(candidate, cwd);
    if (!isPathWithinAllowedDirectories(resolved, allowedDirectories)) {
      return `命令引用了未授权路径：${candidate}`;
    }
  }
  return null;
}

function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return true;

  const dangerousTokens = [
    /\brm\b/,
    /\bmv\b/,
    /\bcp\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bmkdir\b/,
    /\brmdir\b/,
    /\btouch\b/,
    /\btee\b/,
    /\bsed\s+-i\b/,
    /\bperl\s+-pi\b/,
    /\bnpm\s+(install|update|uninstall|run build)\b/,
    /\bpnpm\s+(install|add|update|remove)\b/,
    /\byarn\s+(add|remove|install|upgrade)\b/,
    /\bpip(?:3)?\s+install\b/,
    /\bgit\s+(reset|clean|checkout\s+--|restore\b|revert\b|commit\b|push\b|merge\b|rebase\b|apply\b|am\b)\b/,
    /(^|[^<])>/,
    /\|\s*(sh|bash|pwsh|powershell)\b/,
  ];
  if (dangerousTokens.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const readOnlyPatterns = [
    /^ls\b/,
    /^dir\b/,
    /^pwd\b/,
    /^cat\b/,
    /^type\b/,
    /^less\b/,
    /^more\b/,
    /^head\b/,
    /^tail\b/,
    /^sed\s+-n\b/,
    /^wc\b/,
    /^(which|where)\b/,
    /^echo\b/,
    /^printf\b/,
    /^git\s+(status|diff|log|show|branch)\b/,
    /^(node|npm|pnpm|python|python3)\s+(-v|--version)\b/,
  ];
  return readOnlyPatterns.some((pattern) => pattern.test(normalized));
}

function normalizeApprovalCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function hasReusableRuntimeApproval(
  patches: RuntimeApprovalPatchRecord[],
  command: string,
  cwd: string,
): boolean {
  const normalizedCommand = normalizeApprovalCommand(command);
  const normalizedCwd = cwd.trim();
  const now = Date.now();
  return patches.some((patch) => {
    if (patch.scope !== 'current_runtime') return false;
    if (Date.parse(patch.expiresAt) <= now) return false;
    return (
      normalizeApprovalCommand(patch.command) === normalizedCommand &&
      (patch.cwd?.trim() || '') === normalizedCwd
    );
  });
}

function getTerminalApprovalPaths(groupFolder: string) {
  const approvalsDir = path.join(resolveGroupIpcPath(groupFolder), 'approvals');
  return {
    requestsDir: path.join(approvalsDir, 'requests'),
    responsesDir: path.join(approvalsDir, 'responses'),
  };
}

async function requestTerminalCommandApproval(input: {
  jid: string;
  groupFolder: string;
  toolCallId: string;
  command: string;
  cwd: string;
  canWhitelist: boolean;
}): Promise<'allow-once' | 'deny' | 'expired'> {
  const { requestsDir, responsesDir } = getTerminalApprovalPaths(
    input.groupFolder,
  );
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });

  const now = Date.now();
  const request: TerminalApprovalRequestPayload = {
    id: `approval_${now}_${Math.random().toString(36).slice(2, 8)}`,
    toolCallId: input.toolCallId,
    toolName: 'Terminal',
    command: input.command,
    cwd: input.cwd,
    canWhitelist: input.canWhitelist,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TERMINAL_APPROVAL_TIMEOUT_MS).toISOString(),
  };

  fs.writeFileSync(
    path.join(requestsDir, `${request.id}.json`),
    JSON.stringify(request),
  );
  getWebChannel()?.notifyApprovalRequest(input.jid, request);

  const responsePath = path.join(responsesDir, `${request.id}.json`);
  const expiresAtMs = Date.parse(request.expiresAt);

  const result = await new Promise<'allow-once' | 'deny' | 'expired'>((resolve) => {
    let watcher: fs.FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const tryRead = (): boolean => {
      if (!fs.existsSync(responsePath)) return false;
      try {
        const response = JSON.parse(
          fs.readFileSync(responsePath, 'utf-8'),
        ) as ApprovalResponsePayload;
        cleanup();
        resolve(response.decision === 'allow-once' ? 'allow-once' : 'deny');
        return true;
      } catch (err) {
        wsLog.warn({ err, jid: input.jid }, 'Failed to read terminal approval response');
        cleanup();
        resolve('deny');
        return true;
      }
    };

    if (tryRead()) return;

    timer = setTimeout(() => { cleanup(); resolve('expired'); }, Math.max(0, expiresAtMs - Date.now()));

    try {
      watcher = fs.watch(responsesDir, (_event, filename) => {
        if (!filename || filename === `${request.id}.json`) tryRead();
      });
      watcher.on('error', () => { /* fs.watch error is non-fatal, timeout will expire */ });
    } catch {
      // fs.watch unsupported — fallback to polling
      const poll = () => {
        if (Date.now() >= expiresAtMs) { cleanup(); resolve('expired'); return; }
        if (!tryRead()) setTimeout(poll, TERMINAL_APPROVAL_POLL_MS);
      };
      setTimeout(poll, TERMINAL_APPROVAL_POLL_MS);
    }
  });

  if (result !== 'expired') {
    getWebChannel()?.notifyApprovalResolved(input.jid, {
      id: request.id,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      decision: result,
      resolvedAt: new Date().toISOString(),
    });
    return result;
  }

  getWebChannel()?.notifyApprovalResolved(input.jid, {
    id: request.id,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    decision: 'expired',
    resolvedAt: new Date().toISOString(),
  });
  return 'expired';
}

function writeTerminal(ws: WebSocket, data: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

function renderPrompt(session: ManagedTerminalSession): void {
  const cwdLabel = session.cwd || t('errors.auto_984770', {}, undefined);
  writeTerminal(session.ws, `\r\nnanoclaw:${cwdLabel}> `);
}

function getDefaultAuthorizedCwd(
  allowedDirectories: string[],
  currentCwd?: string | null,
): string | null {
  if (
    currentCwd &&
    isPathWithinAllowedDirectories(currentCwd, allowedDirectories)
  ) {
    return currentCwd;
  }
  return allowedDirectories[0] || null;
}

function sendNoAccessHint(session: ManagedTerminalSession): void {
  writeTerminal(
    session.ws,
    t('errors.auto_4d4f41', {}, undefined),
  );
}

async function refreshSessionRuntime(
  session: ManagedTerminalSession,
  opts: TerminalWebSocketHandlerOptions,
): Promise<boolean> {
  const runtime = await Promise.resolve(
    opts.getConversationRuntime(session.jid),
  );
  if (!runtime) {
    writeTerminal(session.ws, t('errors.auto_0730a7', {}, undefined));
    return false;
  }
  session.runtime = runtime;
  session.cwd = getDefaultAuthorizedCwd(runtime.allowedDirectories, session.cwd);
  return true;
}

function printHelp(session: ManagedTerminalSession): void {
  writeTerminal(
    session.ws,
    t('errors.auto_f90a78', {}, undefined) +
      t('errors.auto_d8e4aa', {}, undefined) +
      t('errors.auto_d94aef', {}, undefined) +
      t('errors.auto_b71da1', {}, undefined) +
      t('errors.auto_a718c0', {}, undefined) +
      t('errors.auto_5c6b22', {}, undefined),
  );
}

function getManagedCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
    TERM_PROGRAM: 'NanoClaw',
  };
}

function startManagedCommand(
  session: ManagedTerminalSession,
  command: string,
): void {
  const child = spawn(command, {
    cwd: session.cwd || undefined,
    env: getManagedCommandEnv(),
    shell: true,
    stdio: 'pipe',
    windowsHide: true,
  });
  session.child = child;

  child.stdout.on('data', (data) => {
    writeTerminal(session.ws, data.toString());
  });
  child.stderr.on('data', (data) => {
    writeTerminal(session.ws, data.toString());
  });
  child.on('error', (err) => {
    writeTerminal(session.ws, `\r\n命令启动失败：${err.message}\r\n`);
  });
  child.on('close', (code) => {
    session.child = null;
    if (code && code !== 0) {
      writeTerminal(session.ws, `\r\n[exit ${code}]\r\n`);
    }
    renderPrompt(session);
  });
}

async function executeManagedLine(
  session: ManagedTerminalSession,
  opts: TerminalWebSocketHandlerOptions,
  rawLine: string,
): Promise<void> {
  const line = rawLine.trim();
  if (!line) {
    renderPrompt(session);
    return;
  }
  if (!(await refreshSessionRuntime(session, opts))) {
    renderPrompt(session);
    return;
  }

  if (line === 'help') {
    printHelp(session);
    renderPrompt(session);
    return;
  }
  if (line === 'clear') {
    writeTerminal(session.ws, '\x1b[2J\x1b[H');
    renderPrompt(session);
    return;
  }

  if (session.runtime.allowedDirectories.length === 0) {
    sendNoAccessHint(session);
    renderPrompt(session);
    return;
  }

  if (line === 'pwd') {
    writeTerminal(session.ws, `\r\n${session.cwd || ''}\r\n`);
    renderPrompt(session);
    return;
  }

  if (line === 'cd' || line.startsWith('cd ')) {
    const target = line === 'cd' ? session.runtime.allowedDirectories[0] : line.slice(3).trim();
    if (!target) {
      writeTerminal(session.ws, t('errors.auto_f1e86d', {}, undefined));
      renderPrompt(session);
      return;
    }
    const nextCwd = resolveManagedPath(target, session.cwd || process.cwd());
    if (
      !isPathWithinAllowedDirectories(
        nextCwd,
        session.runtime.allowedDirectories,
      )
    ) {
      writeTerminal(session.ws, t('errors.auto_394f19', {}, undefined));
      renderPrompt(session);
      return;
    }
    if (!fs.existsSync(nextCwd) || !fs.statSync(nextCwd).isDirectory()) {
      writeTerminal(session.ws, t('errors.auto_1e8e64', {}, undefined));
      renderPrompt(session);
      return;
    }
    session.cwd = nextCwd;
    renderPrompt(session);
    return;
  }

  const cwd = session.cwd;
  if (!cwd) {
    sendNoAccessHint(session);
    renderPrompt(session);
    return;
  }
  const commandPathPerm = precheckManagedCommandPaths(
    line,
    cwd,
    session.runtime.allowedDirectories,
  );
  if (commandPathPerm) {
    writeTerminal(session.ws, `\r\n${commandPathPerm}\r\n`);
    renderPrompt(session);
    return;
  }

  const readOnlyCommand = isReadOnlyShellCommand(line);
  if (session.runtime.accessMode === 'readonly' && !readOnlyCommand) {
    writeTerminal(session.ws, t('errors.auto_78cb7c', {}, undefined));
    renderPrompt(session);
    return;
  }

  if (
    !readOnlyCommand &&
    !commandMatchesBashApprovalAllowlist(line, TERMINAL_APPROVAL_ALLOWLIST) &&
    !hasReusableRuntimeApproval(session.runtime.runtimeApprovalPatches, line, cwd)
  ) {
    const decision = await requestTerminalCommandApproval({
      jid: session.jid,
      groupFolder: session.runtime.groupFolder,
      toolCallId: `terminal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      command: line,
      cwd,
      canWhitelist: canWhitelistBashCommand(line),
    });
    if (decision !== 'allow-once') {
      writeTerminal(
        session.ws,
        `\r\n${
          decision === 'expired'
            ? t('errors.auto_9d1e54', {}, undefined)
            : t('errors.auto_44a1d8', {}, undefined)
        }\r\n`,
      );
      renderPrompt(session);
      return;
    }
  }

  writeTerminal(session.ws, '\r\n');
  startManagedCommand(session, line);
}

async function handleTerminalInputChunk(
  session: ManagedTerminalSession,
  opts: TerminalWebSocketHandlerOptions,
  chunk: string,
): Promise<void> {
  if (session.child) {
    if (chunk.includes('\u0003')) {
      session.child.kill();
      session.child = null;
      writeTerminal(session.ws, '\r\n^C');
      renderPrompt(session);
      return;
    }
    if (!session.child.stdin.destroyed) {
      session.child.stdin.write(chunk);
    }
    return;
  }

  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      const line = session.inputBuffer;
      session.inputBuffer = '';
      await executeManagedLine(session, opts, line);
      continue;
    }
    if (char === '\u0003') {
      session.inputBuffer = '';
      writeTerminal(session.ws, '^C');
      renderPrompt(session);
      continue;
    }
    if (char === '\u0008' || char === '\u007f') {
      if (session.inputBuffer.length > 0) {
        session.inputBuffer = session.inputBuffer.slice(0, -1);
        writeTerminal(session.ws, '\b \b');
      }
      continue;
    }
    if (char === '\u001b') {
      continue;
    }
    session.inputBuffer += char;
    writeTerminal(session.ws, char);
  }
}

export function attachTerminalWebSocketHandler(
  terminalWss: WebSocketServer,
  opts: TerminalWebSocketHandlerOptions,
): void {
  terminalWss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const requestUrl = new URL(
      request.url || '/ws/terminal',
      `http://${request.headers.host || 'localhost'}`,
    );
    const jid = requestUrl.searchParams.get('jid')?.trim() || '';
    if (!jid) {
      writeTerminal(ws, t('errors.auto_9ab68b', {}, undefined));
      ws.close();
      return;
    }

    const cookie = request.headers.cookie ?? undefined;
    let tenantUserId: string;
    if (opts.resolveSocketTenantUserId) {
      try {
        tenantUserId = await Promise.resolve(opts.resolveSocketTenantUserId(cookie));
      } catch (err) {
        wsLog.warn({ err }, 'Terminal WebSocket: failed to resolve tenant user');
        writeTerminal(ws, t('errors.auto_dd1e8a', {}, undefined));
        ws.close();
        return;
      }
    } else {
      tenantUserId = SYSTEM_USER_ID;
    }

    const allowed = await checkConversationOwnership(jid, tenantUserId);
    if (!allowed) {
      wsLog.debug(
        { jid, tenantUserId },
        'Managed terminal WebSocket rejected: not owner',
      );
      writeTerminal(ws, t('errors.auto_2b47ee', {}, undefined));
      ws.close();
      return;
    }

    const runtime = await Promise.resolve(opts.getConversationRuntime(jid));
    if (!runtime) {
      writeTerminal(ws, t('errors.auto_7864da', {}, undefined));
      ws.close();
      return;
    }

    const session: ManagedTerminalSession = {
      ws,
      jid,
      runtime,
      cwd: getDefaultAuthorizedCwd(runtime.allowedDirectories),
      inputBuffer: '',
      child: null,
    };

    wsLog.debug(
      {
        jid,
        accessMode: runtime.accessMode,
        allowedDirectories: runtime.allowedDirectories,
        remoteAddress: request.socket?.remoteAddress,
        host: request.headers.host,
        url: request.url,
      },
      'Managed terminal WebSocket connected',
    );

    writeTerminal(
      ws,
      t('errors.auto_5b1df8', {}, undefined),
    );
    if (runtime.allowedDirectories.length === 0) {
      sendNoAccessHint(session);
    }
    renderPrompt(session);

    ws.on('message', (data) => {
      const raw = data.toString();
      try {
        const control = JSON.parse(raw) as { type?: string };
        if (control.type === 'resize') return;
      } catch {
        // treat as terminal input
      }
      void handleTerminalInputChunk(session, opts, raw).catch((err) => {
        wsLog.warn({ err, jid }, 'Managed terminal input handling failed');
        writeTerminal(
          ws,
          `\r\n终端处理失败：${err instanceof Error ? err.message : String(err)}\r\n`,
        );
        renderPrompt(session);
      });
    });

    ws.on('close', (code, reason) => {
      if (session.child && !session.child.killed) {
        session.child.kill();
      }
      wsLog.debug(
        {
          jid,
          code,
          reason: reason?.toString(),
          remoteAddress: request.socket?.remoteAddress,
        },
        'Managed terminal WebSocket closed',
      );
    });
  });
}

const TENANT_RESOLUTION_FAILED = '__tenant_resolution_failed__';
const socketTenantMap = new WeakMap<WebSocket, string>();
const socketTenantReady = new WeakMap<WebSocket, Promise<string>>();

export function getSocketTenantUserId(ws: WebSocket): string {
  return socketTenantMap.get(ws) ?? SYSTEM_USER_ID;
}

/**
 * Wait for the socket's tenant to be resolved before proceeding.
 * All subscribe/send operations MUST await this to prevent the race
 * where messages arrive before the async tenant resolution completes.
 */
function awaitSocketTenant(ws: WebSocket): Promise<string> {
  return socketTenantReady.get(ws) ?? Promise.resolve(SYSTEM_USER_ID);
}

function isImJid(jid: string): boolean {
  return jid.startsWith('im_dm_') || jid.startsWith('im_grp_');
}

export async function checkRealtimeConversationAccess(
  jid: string,
  tenantUserId: string,
): Promise<boolean> {
  if (isImJid(jid)) {
    return tenantUserId === SYSTEM_USER_ID || isActiveMember(jid, tenantUserId);
  }
  return checkConversationOwnership(jid, tenantUserId);
}

export function attachRealtimeWebSocketHandler(
  wss: WebSocketServer,
  opts: RealtimeWebSocketHandlerOptions,
): void {
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const cookie = request.headers.cookie ?? undefined;
    const ready = (opts.resolveSocketTenantUserId
      ? Promise.resolve(opts.resolveSocketTenantUserId(cookie))
      : Promise.resolve(SYSTEM_USER_ID)
    ).then((uid) => {
      socketTenantMap.set(ws, uid);
      return uid;
    }).catch((err) => {
      wsLog.warn(
        {
          err,
          remoteAddress: request.socket?.remoteAddress,
          host: request.headers.host,
          url: request.url,
        },
        'WebSocket tenant resolution failed, closing connection',
      );
      ws.close(4001, 'Tenant resolution failed');
      return TENANT_RESOLUTION_FAILED;
    });
    socketTenantReady.set(ws, ready);

    wsLog.debug(
      {
        remoteAddress: request.socket?.remoteAddress,
        host: request.headers.host,
        url: request.url,
      },
      'WebSocket client connected',
    );

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'subscribe' && data.jid) {
          void handleWsSubscribe(ws, data.jid);
          return;
        }
        if (data.type === 'send' && data.jid && data.content) {
          void handleWsSend(ws, data, opts);
        }
      } catch (err) {
        wsLog.warn({ err }, 'Invalid WebSocket message');
      }
    });

    ws.on('close', (code, reason) => {
      wsLog.debug(
        {
          code,
          reason: reason?.toString(),
          remoteAddress: request.socket?.remoteAddress,
        },
        'WebSocket client disconnected',
      );
    });
  });
}

async function handleWsSubscribe(ws: WebSocket, jid: string): Promise<void> {
  const webChannel = getWebChannel();
  if (!webChannel) return;

  const tenantUserId = await awaitSocketTenant(ws);
  if (tenantUserId === TENANT_RESOLUTION_FAILED) return;

  if (jid === '*') {
    if (tenantUserId !== SYSTEM_USER_ID) {
      wsLog.debug(
        { tenantUserId },
        'Wildcard subscribe rejected in multi-user mode',
      );
      return;
    }
    webChannel.addClient('*', ws);
    return;
  }

  if (jid.startsWith('workflow:')) {
    const runId = jid.slice('workflow:'.length);
    const run = await workflowDb.getWorkflowRun(runId);
    if (!run) return;
    const workflow = await workflowDb.getWorkflow(run.workflow_id);
    if (
      !workflow ||
      (tenantUserId !== SYSTEM_USER_ID && workflow.user_id !== tenantUserId)
    ) {
      wsLog.debug({ tenantUserId, runId }, 'Workflow subscribe rejected: not owner');
      return;
    }
    const bus = WorkflowEventBus.getInstance();
    const handler = (envelope: WorkflowRealtimeEnvelope) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(envelope));
      }
    };
    bus.on(runId, handler);
    ws.on('close', () => bus.off(runId, handler));
    return;
  }

  const allowed = await checkRealtimeConversationAccess(jid, tenantUserId);
  if (allowed) {
    webChannel.addClient(jid, ws);
  } else {
    wsLog.debug(
      { jid, tenantUserId },
      'WebSocket subscribe rejected: not owner',
    );
  }
}

async function handleWsSend(
  ws: WebSocket,
  data: { jid: string; content: unknown; senderName?: unknown },
  opts: RealtimeWebSocketHandlerOptions,
): Promise<void> {
  const webChannel = getWebChannel();
  if (!webChannel) return;

  const tenantUserId = await awaitSocketTenant(ws);
  if (tenantUserId === TENANT_RESOLUTION_FAILED) return;

  if (isImJid(data.jid)) {
    wsLog.debug(
      { jid: data.jid, tenantUserId },
      'WebSocket send rejected: IM messages must use /api/im routes',
    );
    return;
  }

  const allowed = await checkRealtimeConversationAccess(data.jid, tenantUserId);
  if (!allowed) {
    wsLog.debug(
      { jid: data.jid, tenantUserId },
      'WebSocket send rejected: not owner',
    );
    return;
  }

  const senderName =
    typeof data.senderName === 'string' && data.senderName.trim()
      ? data.senderName.trim()
      : 'Web User';
  const content =
    typeof data.content === 'string' ? data.content.trim() : '';

  const runWs = <T>(fn: () => Promise<T>) =>
    runWithTenantAsync({ userId: tenantUserId }, fn);

  if (content.startsWith('/')) {
    void runWs(() =>
      Promise.resolve(
        opts.persistWebCommandInboundMessage(data.jid, senderName, content),
      ),
    );
    void runWs(() =>
      opts
        .executeSlashCommand({
          jid: data.jid,
          rawText: content,
          refreshTaskSnapshots: opts.refreshTaskSnapshots,
        })
        .then(async (commandResult) => {
          if (!commandResult.handled) return;
          await Promise.resolve(
            opts.persistWebCommandAssistantMessage(
              data.jid,
              opts.formatSlashCommandResultOutput(commandResult),
            ),
          );
        })
        .catch(async (err) => {
          await Promise.resolve(
            opts.persistWebCommandAssistantMessage(
              data.jid,
              opts.formatSlashCommandResultOutput({
                handled: true,
                success: false,
                output:
                  err instanceof Error
                    ? t('slashCommands.commandFailed', { message: err.message }, undefined)
                    : t('errors.auto_7b0b90', {}, undefined),
              }),
            ),
          );
        }),
    );
    return;
  }

  void runWs(() =>
    webChannel.handleInboundMessage(data.jid, content, senderName),
  ).catch((err) => {
    wsLog.error(
      { err, jid: data.jid },
      'Failed to handle inbound web message',
    );
  });
}
