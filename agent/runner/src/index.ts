/**
 * NanoClaw Agent Runner
 * Runs as a direct local agent subprocess, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full AgentRunInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  buildUploadSystemPromptAppend,
  extractUploadContext,
  getUploadAwareUserPrompt,
  UploadedPromptFile,
} from './upload-context.js';
import {
  type AgentRunnerAiUsageLog,
  emitAiErrorLog,
  emitAiRequestLog,
  emitAiResponseLog,
} from './ai-log.js';
import { buildResponsesHistoryBridgePrompt } from './conversation-history.js';
import {
  buildMemoryPromptGuidance,
  collectForwardedMemoryEnv,
} from './memory-tools.js';
import {
  buildAssistantInstructionBlock,
  buildClaudePromptAppend,
  buildCodexResponsesInstructions,
} from './system-prompts.js';
import { buildScheduledTaskPrompt } from './scheduled-task-prompt.js';
import {
  type CodexApiMode,
  type CodexCompatibilityMode,
  type CodexCompatibilityState,
  getCodexResponsesCompatibilityReason,
  isOfficialOpenAiCodexBase,
  parseCodexApiMode,
  resolvePreferredCodexMode,
} from './codex-mode.js';
import {
  type CodexProviderConcurrencyMode,
  resolveCodexProviderConcurrency,
  withCodexProviderConcurrency,
} from './codex-provider-concurrency.js';
import { buildCodexRequestHeaders } from './codex-request-headers.js';
import {
  canReuseApprovedMutation,
  canWhitelistMutationCommand,
  matchesMutationAllowlist,
  requestMutationApproval,
  setApprovalEventEmitter,
} from './mutation-approval.js';
import {
  setAskUserEventEmitter,
  type AskUserRequestPayload,
  type AskUserResolvedPayload,
} from './ask-user.js';
import {
  checkPermission,
  checkWritePermission,
  getAccessMode,
  isReadOnlyShellCommand,
  precheckBashCommandPaths,
  resolvePath,
} from './workspace-permissions.js';

interface AgentPromptUploadedFile {
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
}

interface AgentPromptPayload {
  text: string;
  uploadedFiles?: AgentPromptUploadedFile[];
}

type AgentPromptInput = string | AgentPromptPayload;

interface AgentRunInput {
  prompt: AgentPromptInput;
  requestId?: string;
  sessionId?: string;
  preferredTurnId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  suppressDefaultSystemPrompt?: boolean;
  suppressScheduledTaskPreamble?: boolean;
  disableDefaultWebSearch?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  managedSkillIds?: string[];
  managedMcpServerIds?: string[];
  workingDirectory?: string;
  soulSystemPrompt?: string;
  instructionsAppend?: string;
  assistantRuleMode?: AssistantRuleMode;
}

type AssistantRuleMode = 'append' | 'replace' | 'locked';

interface AgentEventPayload {
  id: string;
  kind: 'status' | 'tool' | 'reasoning';
  status: 'in_progress' | 'completed' | 'failed';
  title: string;
  body?: string;
  timestamp: string;
}

type AgentTurnItemStatus = 'in_progress' | 'completed' | 'failed';

interface AgentSubagentInfo {
  agentName: string;
  runtimeId?: string;
  provider?: string;
  mode?: 'agent' | 'team';
  runtimeKind?: 'managed_run' | 'managed_session' | 'ephemeral_snapshot';
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: 'main' | 'orchestrator' | 'leaf';
  workProfile?: 'explorer' | 'worker';
  // Deprecated compatibility alias for topologyRole.
  role?: 'main' | 'orchestrator' | 'leaf';
  controlScope?: 'children' | 'none';
  depth?: number;
  chatJid?: string;
  requestCount?: number;
  controllable?: boolean;
  task?: string;
  status:
    | 'spawning'
    | 'idle'
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'stopped';
}

interface AgentReasoningItemPayload {
  id: string;
  type: 'reasoning';
  status: AgentTurnItemStatus;
  title: string;
  text?: string;
  timestamp: string;
}

interface AgentToolCallItemPayload {
  id: string;
  type: 'tool_call';
  status: AgentTurnItemStatus;
  title: string;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
  subagentInfo?: AgentSubagentInfo;
  timestamp: string;
}

interface AgentAssistantMessageItemPayload {
  id: string;
  type: 'assistant_message';
  status: Extract<AgentTurnItemStatus, 'in_progress' | 'completed'>;
  text: string;
  timestamp: string;
}

interface AgentApprovalRequestPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

interface AgentApprovalResolvedPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  decision: 'allow-once' | 'deny' | 'expired';
  resolvedAt: string;
}

type AgentTurnItemPayload =
  | AgentReasoningItemPayload
  | AgentToolCallItemPayload
  | AgentAssistantMessageItemPayload;

type AgentTurnEventPayload =
  | { type: 'turn.started'; turnId: string; timestamp: string }
  | { type: 'item.started'; turnId: string; item: AgentTurnItemPayload; timestamp: string }
  | { type: 'item.updated'; turnId: string; item: AgentTurnItemPayload; timestamp: string }
  | { type: 'item.completed'; turnId: string; item: AgentTurnItemPayload; timestamp: string }
  | { type: 'turn.completed'; turnId: string; timestamp: string }
  | { type: 'turn.failed'; turnId: string; error: string; timestamp: string };

interface AgentErrorDetails {
  category?: 'api-error' | 'timeout' | 'crash' | 'parse-error' | 'spawn-error';
  apiStatus?: number;
  apiBody?: string;
  retryAttempts?: number;
  provider?: string;
}

interface AgentAskRequestPayload {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allow_multiple?: boolean;
  createdAt: string;
  expiresAt: string;
}

interface AgentAskResolvedPayload {
  id: string;
  answer: string;
  answered_by: string;
  resolvedAt: string;
}

interface AgentRunOutput {
  status: 'accepted' | 'success' | 'error';
  result: string | null;
  requestId?: string;
  requestKind?: 'message' | 'steer';
  newSessionId?: string;
  streamChunk?: string;
  event?: AgentEventPayload;
  turnEvent?: AgentTurnEventPayload;
  approvalRequest?: AgentApprovalRequestPayload;
  approvalResolved?: AgentApprovalResolvedPayload;
  askRequest?: AgentAskRequestPayload;
  askResolved?: AgentAskResolvedPayload;
  retryable?: boolean;
  error?: string;
  errorDetails?: AgentErrorDetails;
}

interface ExternalMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ClaudeInputTextBlock = {
  type: 'text';
  text: string;
};

type ClaudeInputImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
};

type ClaudeInputDocumentBlock = {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf' | 'text/plain';
    data: string;
  };
  title?: string;
};

type ClaudeInputContentBlock =
  | ClaudeInputTextBlock
  | ClaudeInputImageBlock
  | ClaudeInputDocumentBlock;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ClaudeInputContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_BASE_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

interface IpcQueuedMessage {
  requestId?: string;
  prompt: AgentPromptInput;
}

function getMaxToolIterations(secrets: Record<string, string>): number {
  const raw = secrets.CODEX_MAX_TOOL_ITERATIONS || process.env.CODEX_MAX_TOOL_ITERATIONS || '';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 120;
  return Math.max(4, Math.min(parsed, 500));
}
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const EXTRA_DIR = process.env.NANOCLAW_EXTRA_DIR || '/workspace/extra';
const UPLOADS_DIR = process.env.NANOCLAW_UPLOADS_DIR || '/workspace/uploads';
const SKILLS_DIR = process.env.NANOCLAW_SKILLS_DIR || '/workspace/skills';
const SOUL_SYSTEM_PROMPT = String(
  process.env.NANOCLAW_SOUL_SYSTEM_PROMPT || '',
).trim();
const ASSISTANT_INSTRUCTIONS_APPEND = String(
  process.env.NANOCLAW_ASSISTANT_INSTRUCTIONS_APPEND || '',
).trim();
const ASSISTANT_RULE_MODE = parseAssistantRuleMode(
  process.env.NANOCLAW_ASSISTANT_RULE_MODE,
);
const WORKSPACE_EXTRA_HINT = String(
  process.env.NANOCLAW_WORKSPACE_EXTRA_HINT || '',
).trim();
const CODEX_PROVIDER_PROGRESS_INTERVAL_MS = 10000;
const pendingIpcRequestIds: string[] = [];
function resolveAgentWorkingDirectory(agentInput: AgentRunInput): string {
  const requested = String(agentInput.workingDirectory || '').trim();
  if (!requested) {
    return GROUP_DIR || process.cwd();
  }

  const normalized = requested.replace(/\\/g, '/').replace(/^\/{2,}/, '/');
  const mappings: Array<{ prefix: string; hostRoot: string }> = [
    { prefix: '/workspace/group', hostRoot: GROUP_DIR },
    { prefix: '/workspace/global', hostRoot: GLOBAL_DIR },
    { prefix: '/workspace/extra', hostRoot: EXTRA_DIR },
    { prefix: '/workspace/uploads', hostRoot: UPLOADS_DIR },
    { prefix: '/workspace/project', hostRoot: process.env.NANOCLAW_PROJECT_ROOT || '' },
  ].filter((entry) => entry.hostRoot);

  for (const mapping of mappings) {
    if (
      normalized === mapping.prefix ||
      normalized.startsWith(`${mapping.prefix}/`)
    ) {
      const suffix = normalized.slice(mapping.prefix.length).replace(/^\/+/, '');
      return suffix
        ? path.join(mapping.hostRoot, ...suffix.split('/'))
        : mapping.hostRoot;
    }
  }

  return path.isAbsolute(requested)
    ? requested
    : path.resolve(process.cwd(), requested);
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(promptInput: AgentPromptInput): void {
    const prompt = normalizePromptInput(promptInput);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: buildClaudeUserMessageContent(prompt) },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: AgentRunOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function truncateForEvent(value: string, limit = 400): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function isSubagentToolFailureOutput(value: string): boolean {
  return /^Sub-agent failed:/i.test(value.trim());
}

function parseAssistantRuleMode(value: unknown): AssistantRuleMode {
  return value === 'replace' || value === 'locked' ? value : 'append';
}

function buildWorkspaceExtraGuidance(): string {
  let entries: Array<{ label?: string; hostPath?: string }> = [];
  try {
    entries = WORKSPACE_EXTRA_HINT
      ? (JSON.parse(WORKSPACE_EXTRA_HINT) as Array<{
          label?: string;
          hostPath?: string;
        }>)
      : [];
  } catch {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const lines = [
    'Additional workspace directories are mounted under /workspace/extra.',
    'Use those virtual paths instead of memorizing host absolute paths.',
  ];
  for (const entry of entries) {
    const label = String(entry?.label || '').trim();
    const hostPath = String(entry?.hostPath || '').trim();
    if (!label || !hostPath) continue;
    lines.push(`- /workspace/extra/${label} -> ${hostPath}`);
  }
  return lines.join('\n');
}

function buildClaudeSystemPromptAppend(
  globalClaudeMd: string | undefined,
  defaultClaudeWebGuidance: string,
  agentInput?: AgentRunInput,
): string {
  if (agentInput?.suppressDefaultSystemPrompt) {
    return '';
  }
  return buildClaudePromptAppend({
    globalClaudeMd,
    defaultClaudeWebGuidance,
    workspaceExtraGuidance: buildWorkspaceExtraGuidance(),
    assistantInstructionBlock: buildAssistantInstructionBlock({
      assistantInstructionsAppend: ASSISTANT_INSTRUCTIONS_APPEND,
      assistantRuleMode: ASSISTANT_RULE_MODE,
    }),
    assistantRuleMode: ASSISTANT_RULE_MODE,
    soulSystemPrompt: SOUL_SYSTEM_PROMPT,
  });
}

function formatEventBody(value: unknown, limit = 400): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const trimmed = text.trim();
  return trimmed ? truncateForEvent(trimmed, limit) : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getStringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isSubagentToolName(toolName: string): boolean {
  return (
    toolName === 'TeamCreate' ||
    toolName === 'TeamDelete' ||
    toolName === 'SendMessage' ||
    toolName === 'Agent'
  );
}

function parseToolArgs(rawArgs: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!rawArgs) return {};
  return typeof rawArgs === 'string' ? parseJsonObject(rawArgs) : rawArgs;
}

function buildSubagentInfo(
  toolName: string,
  rawArgs: string | Record<string, unknown> | undefined,
  status: AgentSubagentInfo['status'],
  update?: Partial<AgentSubagentInfo>,
): AgentSubagentInfo | undefined {
  if (!isSubagentToolName(toolName)) return undefined;
  const args = parseToolArgs(rawArgs);
  const task = getStringArg(args, 'prompt', 'task', 'description');
  const agentName =
    getStringArg(args, 'name', 'label', 'description', 'agentName', 'agent_id') ||
    (toolName === 'TeamDelete' ? '子代理清理' : '子代理');
  const runtimeId =
    update?.runtimeId || getStringArg(args, 'agent_id', 'runtime_id');
  const provider =
    update?.provider ||
    (process.env.AI_PROVIDER === 'claude' || process.env.AI_PROVIDER === 'codex'
      ? process.env.AI_PROVIDER
      : undefined);
  const topologyRole = update?.topologyRole || update?.role;
  const workProfile = update?.workProfile ||
    (() => {
      const rawValue =
        getStringArg(args, 'agent_type') || getStringArg(args, 'role');
      return rawValue === 'explorer' || rawValue === 'worker'
        ? rawValue
        : undefined;
    })();
  return {
    agentName,
    ...(runtimeId ? { runtimeId } : {}),
    ...(provider ? { provider } : {}),
    ...(update?.runtimeKind ? { runtimeKind: update.runtimeKind } : {}),
    ...(update?.providerSessionId
      ? { providerSessionId: update.providerSessionId }
      : {}),
    ...(update?.parentRuntimeId
      ? { parentRuntimeId: update.parentRuntimeId }
      : {}),
    ...(update?.controllerSessionKey
      ? { controllerSessionKey: update.controllerSessionKey }
      : {}),
    ...(update?.requesterSessionKey
      ? { requesterSessionKey: update.requesterSessionKey }
      : {}),
    ...(update?.originTurnId ? { originTurnId: update.originTurnId } : {}),
    ...(update?.originToolCallId
      ? { originToolCallId: update.originToolCallId }
      : {}),
    ...(topologyRole ? { topologyRole } : {}),
    ...(workProfile ? { workProfile } : {}),
    ...(topologyRole ? { role: topologyRole } : {}),
    ...(update?.controlScope ? { controlScope: update.controlScope } : {}),
    ...(update?.mode
      ? { mode: update.mode }
      : toolName === 'Agent'
        ? { mode: 'agent' as const }
        : { mode: 'team' as const }),
    ...(typeof update?.depth === 'number' ? { depth: update.depth } : {}),
    ...(update?.chatJid ? { chatJid: update.chatJid } : {}),
    ...(typeof update?.requestCount === 'number'
      ? { requestCount: update.requestCount }
      : {}),
    ...(typeof update?.controllable === 'boolean'
      ? { controllable: update.controllable }
      : {}),
    ...(task ? { task } : {}),
    status,
  };
}

function mergeSubagentInfo(
  existing: AgentSubagentInfo | undefined,
  next: AgentSubagentInfo | undefined,
): AgentSubagentInfo | undefined {
  if (!existing) return next;
  if (!next) return existing;
  return {
    agentName: next.agentName || existing.agentName,
    runtimeId: next.runtimeId || existing.runtimeId,
    provider: next.provider || existing.provider,
    runtimeKind: next.runtimeKind || existing.runtimeKind,
    providerSessionId: next.providerSessionId || existing.providerSessionId,
    parentRuntimeId: next.parentRuntimeId || existing.parentRuntimeId,
    controllerSessionKey:
      next.controllerSessionKey || existing.controllerSessionKey,
    requesterSessionKey:
      next.requesterSessionKey || existing.requesterSessionKey,
    originTurnId: next.originTurnId || existing.originTurnId,
    originToolCallId: next.originToolCallId || existing.originToolCallId,
    topologyRole: next.topologyRole || existing.topologyRole,
    workProfile: next.workProfile || existing.workProfile,
    role:
      next.topologyRole ||
      next.role ||
      existing.topologyRole ||
      existing.role,
    controlScope: next.controlScope || existing.controlScope,
    mode: next.mode || existing.mode,
    depth:
      typeof next.depth === 'number' ? next.depth : existing.depth,
    chatJid: next.chatJid || existing.chatJid,
    requestCount:
      typeof next.requestCount === 'number'
        ? next.requestCount
        : existing.requestCount,
    controllable:
      typeof next.controllable === 'boolean'
        ? next.controllable
        : existing.controllable,
    task: next.task || existing.task,
    status: next.status,
  };
}

function summarizeBashPurpose(command: string): string | null {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('git status --short') || normalized === 'git status -s') {
    return '检查工作区未提交改动';
  }
  if (normalized.includes('git diff --stat')) {
    return '统计本地改动规模';
  }
  if (normalized.includes('git rev-list') && normalized.includes('--left-right') && normalized.includes('--count')) {
    return '确认当前分支与远端的同步状态';
  }
  if (normalized.startsWith('git status -sb') || normalized.startsWith('git branch -vv')) {
    return '确认当前分支与远端的同步状态';
  }
  if (normalized.startsWith('git log')) {
    return '查看最近提交历史';
  }
  if (normalized.startsWith('rg ') || normalized.startsWith('grep ')) {
    return '搜索相关文件或文本';
  }
  if (normalized.startsWith('ls') || normalized.startsWith('find ')) {
    return '查看目录结构';
  }
  if (normalized.startsWith('cat ') || normalized.startsWith('sed ') || normalized.startsWith('head ') || normalized.startsWith('tail ')) {
    return '读取文件内容';
  }
  if (normalized.startsWith('npm test') || normalized.startsWith('pnpm test') || normalized.startsWith('yarn test')) {
    return '运行测试验证当前改动';
  }
  if (normalized.startsWith('git diff')) {
    return '查看具体代码改动';
  }
  return '执行命令并收集信息';
}

function summarizeToolPurpose(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'bash':
      return summarizeBashPurpose(getStringArg(args, 'command'));
    case 'read_file': {
      const filePath = getStringArg(args, 'path', 'file_path');
      return filePath ? `读取文件 ${path.basename(filePath)}` : '读取文件内容';
    }
    case 'list_dir': {
      const dirPath = getStringArg(args, 'dir_path', 'path') || '.';
      return `查看目录 ${dirPath} 的文件结构`;
    }
    case 'Agent':
    case 'TeamCreate': {
      const task =
        getStringArg(args, 'task', 'prompt', 'description') || '并行子任务';
      return `委派子代理处理${task}`;
    }
    case 'SendMessage': {
      const agentId = getStringArg(args, 'agent_id') || '子代理';
      return `继续与${agentId}协作`;
    }
    case 'TeamDelete': {
      const agentId = getStringArg(args, 'agent_id') || '子代理';
      return `停止${agentId}`;
    }
    case 'grep_search':
      return '搜索匹配的文本片段';
    case 'glob_search':
      return '搜索匹配的文件';
    default:
      return null;
  }
}

const NOISY_TOOL_PURPOSES = new Set([
  '执行命令并收集信息',
]);

const NOISY_TOOL_RESULTS = new Set([
  '已经拿到命令执行结果',
  '命令已执行完成',
  '已经拿到工具执行结果',
  '工具已执行完成',
  '已经读取目标文件内容',
  '已经拿到目录结构，可以据此选择下一步文件',
  '已经找到相关文本位置',
  '没有找到匹配的文本',
  '已经找到匹配的文件',
  '没有找到匹配的文件',
]);

function summarizeToolPurposes(calls: Array<{ name: string; args: Record<string, unknown> }>): string | null {
  const purposes = [...new Set(calls
    .map((entry) => summarizeToolPurpose(entry.name, entry.args))
    .filter((value): value is string => {
      if (!value) return false;
      return !NOISY_TOOL_PURPOSES.has(value);
    }))];

  if (purposes.length === 0) return null;
  if (purposes.length === 1) return purposes[0];
  if (purposes.length === 2) return `${purposes[0]}，并${purposes[1]}`;
  return `${purposes.slice(0, 2).join('、')}等操作`;
}

function buildPlanningReasoningText(toolPurposeSummary: string | null, toolCount: number): string | null {
  if (toolPurposeSummary) {
    return `我先${toolPurposeSummary}，确认情况后再继续处理`;
  }
  if (toolCount > 1) return `我先调用 ${toolCount} 个工具交叉确认情况`;
  return null;
}

function summarizePromptForReasoning(_prompt: string): string {
  return '我先理解你的问题，再决定是否需要调用工具';
}

function summarizeBashResult(command: string, output: string): string | null {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  const trimmed = output.trim();
  if (normalized.startsWith('git status --short') || normalized === 'git status -s') {
    const count = trimmed ? trimmed.split(/\r?\n/).filter(Boolean).length : 0;
    return count > 0 ? `发现本地仍有 ${count} 个未提交改动条目` : '工作区没有未提交改动';
  }
  if (normalized.includes('git diff --stat')) {
    return trimmed ? '已经拿到本地改动涉及的文件与改动规模' : '本地没有可统计的差异';
  }
  if (normalized.includes('git rev-list') && normalized.includes('--left-right') && normalized.includes('--count')) {
    const match = trimmed.match(/^(\d+)\s+(\d+)$/);
    if (match) {
      const behind = Number(match[1]);
      const ahead = Number(match[2]);
      if (ahead === 0 && behind === 0) return '当前分支与远端完全同步';
      return `当前分支相对远端：ahead ${ahead}，behind ${behind}`;
    }
    return '已经确认当前分支与远端的同步状态';
  }
  if (normalized.startsWith('git status -sb') || normalized.startsWith('git branch -vv')) {
    return '已经确认当前分支与远端的同步状态';
  }
  if (normalized.startsWith('git diff')) {
    return '已经拿到具体代码改动内容';
  }
  if (normalized.startsWith('git log')) {
    return '已经查看最近提交历史';
  }
  if (normalized.startsWith('rg ') || normalized.startsWith('grep ')) {
    return trimmed ? '已经找到相关匹配结果' : '没有找到匹配结果';
  }
  if (normalized.startsWith('ls') || normalized.startsWith('find ')) {
    return '已经拿到目录结构';
  }
  if (normalized.startsWith('cat ') || normalized.startsWith('sed ') || normalized.startsWith('head ') || normalized.startsWith('tail ')) {
    return '已经读取目标文件内容';
  }
  return null;
}

function summarizeToolResult(toolName: string, args: Record<string, unknown>, output: string): string | null {
  switch (toolName) {
    case 'bash':
      return summarizeBashResult(getStringArg(args, 'command'), output);
    case 'read_file':
    case 'list_dir':
    case 'grep_search':
    case 'glob_search':
      return null;
    case 'Agent':
    case 'TeamCreate':
      return /^Error:/i.test(output)
        ? '子代理执行失败'
        : '已经拿到子代理结果';
    case 'SendMessage':
      return /^Error:/i.test(output)
        ? '子代理继续协作失败'
        : '已经拿到子代理回复';
    case 'TeamDelete':
      return /^Error:/i.test(output)
        ? '子代理停止失败'
        : '子代理已停止';
    default:
      return null;
  }
}

function summarizeToolResults(results: Array<string | null>): string | null {
  const summaries = [...new Set(results.filter((value): value is string => {
    if (!value) return false;
    return !NOISY_TOOL_RESULTS.has(value);
  }))];
  if (summaries.length === 0) {
    return null;
  }
  if (summaries.length === 1) return `${summaries[0]}，我继续往下分析`;
  if (summaries.length === 2) return `${summaries[0]}；${summaries[1]}。我继续整理后续结论`;
  return `${summaries.slice(0, 2).join('；')}；其余检查也已完成，我继续整理结论`;
}

function emitAgentEvent(event: Omit<AgentEventPayload, 'timestamp'>): void {
  writeOutput({
    status: 'success',
    result: null,
    event: {
      ...event,
      timestamp: new Date().toISOString(),
    },
  });
}

function emitTurnEvent(event: {
  type: AgentTurnEventPayload['type'];
  turnId: string;
  timestamp?: string;
  item?: AgentTurnItemPayload;
  error?: string;
}): void {
  writeOutput({
    status: 'success',
    result: null,
    turnEvent: {
      ...event,
      timestamp: event.timestamp || new Date().toISOString(),
    } as AgentTurnEventPayload,
  });
}

function emitApprovalRequest(approvalRequest: AgentApprovalRequestPayload): void {
  writeOutput({
    status: 'success',
    result: null,
    approvalRequest,
  });
}

function emitApprovalResolved(
  approvalResolved: AgentApprovalResolvedPayload,
): void {
  writeOutput({
    status: 'success',
    result: null,
    approvalResolved,
  });
}

setApprovalEventEmitter({
  emitApprovalRequest,
  emitApprovalResolved,
});

function emitAskRequest(askRequest: AskUserRequestPayload): void {
  writeOutput({
    status: 'success',
    result: null,
    askRequest,
  });
}

function emitAskResolved(askResolved: AskUserResolvedPayload): void {
  writeOutput({
    status: 'success',
    result: null,
    askResolved,
  });
}

setAskUserEventEmitter({
  emitAskRequest,
  emitAskResolved,
});

class CodexTurnEventEmitter {
  readonly turnId: string;

  private reasoningSeq = 0;
  private assistantSeq = 0;
  private activeReasoning: { id: string; title: string; text?: string } | null = null;
  private activeAssistant: { id: string; text: string } | null = null;
  private finished = false;

  constructor(turnId?: string) {
    this.turnId = turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    emitTurnEvent({ type: 'turn.started', turnId: this.turnId });
  }

  startReasoning(title: string, text?: string): void {
    this.completeAssistantMessage();
    this.completeReasoning();
    const item = {
      id: `${this.turnId}:reasoning:${++this.reasoningSeq}`,
      title,
      text,
    };
    this.activeReasoning = item;
    this.emitItem('item.started', {
      id: item.id,
      type: 'reasoning',
      status: 'in_progress',
      title: item.title,
      text: item.text,
      timestamp: new Date().toISOString(),
    });
  }

  updateReasoning(text: string, title?: string): void {
    if (!this.activeReasoning) return;
    const nextTitle = title ?? this.activeReasoning.title;
    const nextText = text;
    if (this.activeReasoning.title === nextTitle && this.activeReasoning.text === nextText) {
      return;
    }
    this.activeReasoning = {
      ...this.activeReasoning,
      title: nextTitle,
      text: nextText,
    };
    this.emitItem('item.updated', {
      id: this.activeReasoning.id,
      type: 'reasoning',
      status: 'in_progress',
      title: this.activeReasoning.title,
      text: this.activeReasoning.text,
      timestamp: new Date().toISOString(),
    });
  }

  completeReasoning(text?: string): void {
    if (!this.activeReasoning) return;
    if (text !== undefined) {
      this.activeReasoning = { ...this.activeReasoning, text };
    }
    const item = this.activeReasoning;
    this.activeReasoning = null;
    this.emitItem('item.completed', {
      id: item.id,
      type: 'reasoning',
      status: 'completed',
      title: item.title,
      text: item.text,
      timestamp: new Date().toISOString(),
    });
  }

  appendAssistantDelta(delta: string): void {
    if (!delta) return;
    this.completeReasoning();
    if (!this.activeAssistant) {
      this.activeAssistant = {
        id: `${this.turnId}:assistant:${++this.assistantSeq}`,
        text: '',
      };
      this.emitItem('item.started', {
        id: this.activeAssistant.id,
        type: 'assistant_message',
        status: 'in_progress',
        text: '',
        timestamp: new Date().toISOString(),
      });
    }
    this.activeAssistant.text += delta;
    this.emitItem('item.updated', {
      id: this.activeAssistant.id,
      type: 'assistant_message',
      status: 'in_progress',
      text: this.activeAssistant.text,
      timestamp: new Date().toISOString(),
    });
  }

  completeAssistantMessage(finalText?: string): void {
    if (finalText) {
      if (!this.activeAssistant) {
        this.activeAssistant = {
          id: `${this.turnId}:assistant:${++this.assistantSeq}`,
          text: '',
        };
        this.emitItem('item.started', {
          id: this.activeAssistant.id,
          type: 'assistant_message',
          status: 'in_progress',
          text: '',
          timestamp: new Date().toISOString(),
        });
      }
      this.activeAssistant.text = finalText;
    }

    if (!this.activeAssistant) return;
    const item = this.activeAssistant;
    this.activeAssistant = null;
    if (!item.text.trim()) return;
    this.emitItem('item.completed', {
      id: item.id,
      type: 'assistant_message',
      status: 'completed',
      text: item.text,
      timestamp: new Date().toISOString(),
    });
  }

  startToolCall(
    callId: string,
    title: string,
    argumentsText?: string,
    subagentInfo?: AgentSubagentInfo,
  ): void {
    this.completeAssistantMessage();
    this.completeReasoning();
    this.emitItem('item.started', {
      id: callId,
      type: 'tool_call',
      status: 'in_progress',
      title,
      argumentsText,
      subagentInfo,
      timestamp: new Date().toISOString(),
    });
  }

  updateToolCall(
    callId: string,
    title: string,
    argumentsText?: string,
    resultText?: string,
    subagentInfo?: AgentSubagentInfo,
  ): void {
    this.emitItem('item.updated', {
      id: callId,
      type: 'tool_call',
      status: 'in_progress',
      title,
      argumentsText,
      resultText,
      subagentInfo,
      timestamp: new Date().toISOString(),
    });
  }

  completeToolCall(
    callId: string,
    title: string,
    argumentsText: string | undefined,
    resultText?: string,
    subagentInfo?: AgentSubagentInfo,
  ): void {
    this.emitItem('item.completed', {
      id: callId,
      type: 'tool_call',
      status: 'completed',
      title,
      argumentsText,
      resultText,
      subagentInfo,
      timestamp: new Date().toISOString(),
    });
  }

  failToolCall(
    callId: string,
    title: string,
    argumentsText: string | undefined,
    errorText: string,
    subagentInfo?: AgentSubagentInfo,
  ): void {
    this.emitItem('item.completed', {
      id: callId,
      type: 'tool_call',
      status: 'failed',
      title,
      argumentsText,
      errorText,
      subagentInfo,
      timestamp: new Date().toISOString(),
    });
  }

  completeTurn(): void {
    if (this.finished) return;
    this.completeAssistantMessage();
    this.completeReasoning();
    this.finished = true;
    emitTurnEvent({ type: 'turn.completed', turnId: this.turnId });
  }

  failTurn(error: string): void {
    if (this.finished) return;
    this.completeAssistantMessage();
    this.completeReasoning();
    this.finished = true;
    emitTurnEvent({ type: 'turn.failed', turnId: this.turnId, error });
  }

  private emitItem(
    type: 'item.started' | 'item.updated' | 'item.completed',
    item: AgentTurnItemPayload,
  ): void {
    emitTurnEvent({ type, turnId: this.turnId, item });
  }
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
}

interface ClaudeStreamEvent {
  type?: string;
  index?: number;
  content_block?: ClaudeContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
}

function extractClaudeAssistantText(message: unknown): string {
  const content = (message as { message?: { content?: ClaudeContentBlock[] } })?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is ClaudeContentBlock =>
        block?.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text || '')
    .join('')
    .trim();
}

function extractClaudeToolUseBlocks(
  message: unknown,
): Array<{ id: string; name: string; input?: unknown }> {
  const content = (message as { message?: { content?: ClaudeContentBlock[] } })?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is ClaudeContentBlock =>
        (block?.type === 'tool_use' || block?.type === 'server_tool_use') &&
        typeof block.id === 'string' &&
        typeof block.name === 'string',
    )
    .map((block) => ({
      id: block.id!,
      name: block.name!,
      input: block.input,
    }));
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(GROUP_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function buildPermissionDenyResult(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as {
      command?: string;
      cwd?: string;
    };
    const command = toolInput?.command;
    const requestedCwd =
      typeof toolInput?.cwd === 'string' ? toolInput.cwd : GROUP_DIR;
    if (!command) return {};

    const cwd = resolvePath(requestedCwd, GROUP_DIR);
    const cwdPerm = checkPermission(cwd);
    if (cwdPerm) {
      return buildPermissionDenyResult(cwdPerm);
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    const updatedInput = {
      ...(preInput.tool_input as Record<string, unknown>),
      command: unsetPrefix + command,
      cwd,
    };

    const readOnlyCommand = isReadOnlyShellCommand(command);
    if (getAccessMode() === 'readonly' && !readOnlyCommand) {
      return buildPermissionDenyResult(
        'Current conversation access policy is readonly',
      );
    }

    const commandPerm = precheckBashCommandPaths(command, cwd);
    if (commandPerm) {
      return buildPermissionDenyResult(commandPerm);
    }

    if (readOnlyCommand) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
        },
      };
    }

    if (matchesMutationAllowlist(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
        },
      };
    }

    if (canReuseApprovedMutation({ command, cwd })) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput,
        },
      };
    }

    const decision = await requestMutationApproval({
      toolCallId: preInput.tool_use_id,
      toolName: 'Bash',
      command,
      cwd,
      canWhitelist: canWhitelistMutationCommand(command),
    });
    if (decision !== 'allow-once') {
      return buildPermissionDenyResult(
        decision === 'expired'
          ? 'Bash command approval timed out'
          : 'Bash command denied by user',
      );
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput,
      },
    };
  };
}

function createSanitizeFileMutationHook(
  toolName: 'Write' | 'Edit' | 'NotebookEdit',
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    const requestedCwd = getStringArg(toolInput, 'cwd') || GROUP_DIR;
    const rawFilePath =
      getStringArg(toolInput, 'file_path', 'path', 'notebook_path') || '';
    if (!rawFilePath) return {};

    const filePath = resolvePath(rawFilePath, requestedCwd);
    const perm = checkWritePermission(filePath);
    if (perm) {
      return buildPermissionDenyResult(perm);
    }

    const decision = await requestMutationApproval({
      toolCallId: preInput.tool_use_id,
      toolName,
      command: `${toolName} ${filePath}`,
      cwd: path.dirname(filePath),
      canWhitelist: false,
    });
    if (decision !== 'allow-once') {
      return buildPermissionDenyResult(
        decision === 'expired'
          ? `${toolName} approval timed out`
          : `${toolName} denied by user`,
      );
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function shiftNextIpcRequestId(): string | undefined {
  while (pendingIpcRequestIds.length > 0) {
    const next = pendingIpcRequestIds.shift();
    if (typeof next === 'string' && next.trim()) {
      return next.trim();
    }
  }
  return undefined;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): AgentPromptInput[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: AgentPromptInput[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message') {
          if (typeof data.requestId === 'string' && data.requestId.trim()) {
            pendingIpcRequestIds.push(data.requestId.trim());
          }
          if (typeof data.prompt === 'string') {
            messages.push(data.prompt);
          } else if (data.prompt && typeof data.prompt === 'object') {
            messages.push(data.prompt as AgentPromptPayload);
          } else if (typeof data.text === 'string') {
            messages.push(data.text);
          }
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the merged prompt input, or null if _close.
 */
function waitForIpcMessage(): Promise<AgentPromptInput | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(mergePromptInputs(messages));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: AgentPromptInput,
  sessionId: string | undefined,
  mcpServerPath: string,
  agentInput: AgentRunInput,
  sdkEnv: Record<string, string | undefined>,
  requestId?: string,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  deferredMessages: AgentPromptInput[];
}> {
  const workingDirectory = resolveAgentWorkingDirectory(agentInput);
  const stream = new MessageStream();
  stream.push(prompt);
  const deferredMessages: AgentPromptInput[] = [];

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const promptInput of messages) {
      log(`Piping IPC message into active query (${getPromptTextLength(promptInput)} chars)`);
      stream.push(promptInput);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  const globalClaudeMdPath = path.join(GLOBAL_DIR, 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!agentInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  const defaultClaudeWebGuidance =
    String(process.env.NANOCLAW_WEB_SEARCH_ENABLED || 'true').trim() === 'false'
      ? 'NanoClaw default web search is disabled by configuration. Use provider-native WebSearch/WebFetch when web access is needed.'
      : [
          'Provider-native WebSearch/WebFetch are available.',
          'Prefer native WebSearch for broad web lookup.',
          'Use mcp__nanoclaw__fetch_url for readable extraction, long articles, and page-based continuation.',
          'Use mcp__nanoclaw__search_web when native web search is unavailable or when you need NanoClaw-specific domain-restricted search behavior.',
          'When browser control is enabled, use MCP browser tools as the primary entrypoint: start with mcp__nanoclaw__browser_status or mcp__nanoclaw__browser_start, use mcp__nanoclaw__browser_role_snapshot for perception, then mcp__nanoclaw__browser_act for interactions.',
          'Browser snapshots are reusable by default. Only refresh when page state changes, ref resolution fails, or you explicitly force refresh.',
          'After a click or navigation that changes the page, prefer browser_act kind=waitFor with selector/url/title conditions instead of fixed sleep waits.',
        ].join('\n');
  const defaultMemoryGuidance = buildMemoryPromptGuidance();

  const extraDirs: string[] = [];
  const projectRoot = String(process.env.NANOCLAW_PROJECT_ROOT || '').trim();
  if (projectRoot && fs.existsSync(projectRoot)) {
    extraDirs.push(projectRoot);
  }
  if (fs.existsSync(EXTRA_DIR)) {
    for (const entry of fs.readdirSync(EXTRA_DIR)) {
      const fullPath = path.join(EXTRA_DIR, entry);
      if (fs.statSync(fullPath).isDirectory() && !extraDirs.includes(fullPath)) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const parseExternalMcpServers = (): Record<string, ExternalMcpServer> => {
    const raw = process.env.NANOCLAW_EXTRA_MCP_SERVERS;
    if (!raw || !raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log('Ignoring NANOCLAW_EXTRA_MCP_SERVERS: expected object map');
        return {};
      }
      const output: Record<string, ExternalMcpServer> = {};
      for (const [name, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          log(`Skipping MCP server "${name}": expected object`);
          continue;
        }
        const obj = value as Record<string, unknown>;
        if (typeof obj.command !== 'string' || !obj.command.trim()) {
          log(`Skipping MCP server "${name}": command is required`);
          continue;
        }
        const args = Array.isArray(obj.args)
          ? obj.args.filter((item): item is string => typeof item === 'string')
          : [];
        const env: Record<string, string> = {};
        if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
          for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
            if (typeof v === 'string') env[k] = v;
          }
        }
        output[name] = {
          command: obj.command.trim(),
          args,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        };
      }
      return output;
    } catch (error) {
      log(
        `Ignoring NANOCLAW_EXTRA_MCP_SERVERS: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {};
    }
  };
  const externalMcpServers = parseExternalMcpServers();
  const allowedMcpTools = Array.from(
    new Set([
      'mcp__nanoclaw__*',
      ...Object.keys(externalMcpServers).map((name) => `mcp__${name}__*`),
    ]),
  );
  if (Object.keys(externalMcpServers).length > 0) {
    log(`Loaded external MCP servers: ${Object.keys(externalMcpServers).join(', ')}`);
  }

  const turnStream = new CodexTurnEventEmitter(agentInput.preferredTurnId);
  const activeToolCalls = new Map<
    string,
    { title: string; argumentsText?: string; subagentInfo?: AgentSubagentInfo }
  >();
  const subagentRuntime = getCodexSubagentRuntimeConfig();
  const subagentsEnabled = subagentRuntime.enabled;
  const configuredSubagentMaxDepth = subagentRuntime.maxDepth;
  const currentSubagentDepth = subagentRuntime.currentDepth;
  const canCreateSubagents = subagentRuntime.canSpawn;
  const toolCallIndexMap = new Map<number, string>();
  const toolCallInputJson = new Map<number, string>();
  const thinkingBlocks = new Map<number, string>();
  const closeToolCall = (
    id: string,
    status: 'completed' | 'failed',
    resultText?: string,
  ) => {
    const tool = activeToolCalls.get(id);
    if (!tool) return;
    const subagentInfo = tool.subagentInfo
      ? { ...tool.subagentInfo, status }
      : undefined;
    if (status === 'failed') {
      turnStream.failToolCall(
        id,
        tool.title,
        tool.argumentsText,
        truncateForEvent(resultText || 'Claude tool call failed'),
        subagentInfo,
      );
    } else {
      turnStream.completeToolCall(
        id,
        tool.title,
        tool.argumentsText,
        resultText,
        subagentInfo,
      );
    }
    activeToolCalls.delete(id);
  };
  const ensureToolCallStarted = (
    id: string,
    title: string,
    argumentsText?: string,
    rawArgs?: string | Record<string, unknown>,
  ) => {
    const subagentSeed = isSubagentToolName(title)
      ? {
          runtimeId: id,
          provider: 'claude' as const,
          runtimeKind: 'ephemeral_snapshot' as const,
          providerSessionId: undefined,
          parentRuntimeId:
            process.env.NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID?.trim() ||
            undefined,
          controllerSessionKey:
            process.env.NANOCLAW_CURRENT_SUBAGENT_SESSION_KEY?.trim() ||
            (process.env.NANOCLAW_GROUP_FOLDER && process.env.NANOCLAW_CHAT_JID
              ? `group:${process.env.NANOCLAW_GROUP_FOLDER}:${process.env.NANOCLAW_CHAT_JID}`
              : undefined),
          requesterSessionKey:
            process.env.NANOCLAW_CURRENT_SUBAGENT_SESSION_KEY?.trim() ||
            (process.env.NANOCLAW_GROUP_FOLDER && process.env.NANOCLAW_CHAT_JID
              ? `group:${process.env.NANOCLAW_GROUP_FOLDER}:${process.env.NANOCLAW_CHAT_JID}`
              : undefined),
          originTurnId: turnStream.turnId,
          originToolCallId: id,
          topologyRole:
            currentSubagentDepth + 1 >= configuredSubagentMaxDepth
              ? ('leaf' as const)
              : ('orchestrator' as const),
          role:
            currentSubagentDepth + 1 >= configuredSubagentMaxDepth
              ? ('leaf' as const)
              : ('orchestrator' as const),
          controlScope:
            currentSubagentDepth + 1 >= configuredSubagentMaxDepth
              ? ('none' as const)
              : ('children' as const),
          depth: currentSubagentDepth + 1,
          controllable: false,
        }
      : undefined;
    const nextSubagentInfo = buildSubagentInfo(
      title,
      rawArgs ?? argumentsText,
      activeToolCalls.has(id) ? 'running' : 'spawning',
      subagentSeed,
    );
    const existing = activeToolCalls.get(id);
    if (existing) {
      const nextArgumentsText = argumentsText ?? existing.argumentsText;
      const mergedSubagentInfo = mergeSubagentInfo(
        existing.subagentInfo,
        nextSubagentInfo,
      );
      activeToolCalls.set(id, {
        title,
        argumentsText: nextArgumentsText,
        subagentInfo: mergedSubagentInfo,
      });
      turnStream.updateToolCall(
        id,
        title,
        nextArgumentsText,
        undefined,
        mergedSubagentInfo,
      );
      return;
    }
    activeToolCalls.set(id, { title, argumentsText, subagentInfo: nextSubagentInfo });
    turnStream.startToolCall(id, title, argumentsText, nextSubagentInfo);
  };
  const flushRemainingToolCalls = () => {
    for (const [id] of activeToolCalls) {
      closeToolCall(id, 'completed', 'Tool completed');
    }
  };

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: workingDirectory,
        model: process.env.ANTHROPIC_MODEL || undefined,
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: (() => {
          const append = [
            buildClaudeSystemPromptAppend(
              globalClaudeMd,
              defaultClaudeWebGuidance,
              agentInput,
            ),
            defaultMemoryGuidance,
            subagentsEnabled
              ? buildSubagentPolicyPrompt(
                  subagentsEnabled,
                  configuredSubagentMaxDepth,
                  currentSubagentDepth,
                  subagentRuntime.currentRole,
                  subagentRuntime.currentControlScope,
                  subagentRuntime.maxActive,
                  subagentRuntime.activeCount,
                  'TeamCreate',
                )
              : '',
          ]
            .filter(Boolean)
            .join('\n\n');
          return append
            ? {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append,
              }
            : undefined;
        })(),
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          ...(subagentsEnabled ? ['TeamDelete', 'SendMessage'] : []),
          ...(canCreateSubagents ? ['TeamCreate'] : []),
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          ...allowedMcpTools,
        ],
        env: sdkEnv,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: {
          ...externalMcpServers,
          nanoclaw: {
            command: process.execPath,
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: agentInput.chatJid,
              NANOCLAW_GROUP_FOLDER: agentInput.groupFolder,
              NANOCLAW_IS_MAIN: agentInput.isMain ? '1' : '0',
              NANOCLAW_GROUP_DIR: GROUP_DIR,
              NANOCLAW_GLOBAL_DIR: GLOBAL_DIR,
              NANOCLAW_INTERNAL_API_BASE:
                process.env.NANOCLAW_INTERNAL_API_BASE || '',
              NANOCLAW_INTERNAL_API_TOKEN:
                process.env.NANOCLAW_INTERNAL_API_TOKEN || '',
              NANOCLAW_USER_ID: process.env.NANOCLAW_USER_ID || '',
              NANOCLAW_AVAILABLE_KB_META: process.env.NANOCLAW_AVAILABLE_KB_META || '',
              ...collectForwardedMemoryEnv(),
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(agentInput.assistantName)] }],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { matcher: 'Write', hooks: [createSanitizeFileMutationHook('Write')] },
            { matcher: 'Edit', hooks: [createSanitizeFileMutationHook('Edit')] },
            {
              matcher: 'NotebookEdit',
              hooks: [createSanitizeFileMutationHook('NotebookEdit')],
            },
          ],
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        const assistantText = extractClaudeAssistantText(message);
        if (assistantText) {
          turnStream.completeAssistantMessage(assistantText);
        }
        for (const toolUse of extractClaudeToolUseBlocks(message)) {
          ensureToolCallStarted(
            toolUse.id,
            toolUse.name,
            formatEventBody(toolUse.input ?? {}, 320),
            (toolUse.input ?? {}) as Record<string, unknown>,
          );
        }
      }

      if (message.type === 'stream_event') {
        const event = message.event as ClaudeStreamEvent;
        const blockIndex = typeof event.index === 'number' ? event.index : -1;
        if (event.type === 'content_block_start') {
          if (
            event.content_block?.type === 'thinking' ||
            event.content_block?.type === 'redacted_thinking'
          ) {
            thinkingBlocks.set(blockIndex, event.content_block.text || '');
            turnStream.startReasoning('思考中', event.content_block.text || undefined);
          }
          if (
            event.content_block?.type === 'tool_use' ||
            event.content_block?.type === 'server_tool_use'
          ) {
            const toolCallId =
              event.content_block.id ||
              `${message.uuid}:tool:${blockIndex >= 0 ? blockIndex : activeToolCalls.size}`;
            toolCallIndexMap.set(blockIndex, toolCallId);
            ensureToolCallStarted(
              toolCallId,
              event.content_block.name || 'tool_use',
              formatEventBody(event.content_block.input ?? {}, 320),
              (event.content_block.input ?? {}) as Record<string, unknown>,
            );
          }
          if (event.content_block?.type === 'text' && event.content_block.text) {
            turnStream.appendAssistantDelta(event.content_block.text);
            writeOutput({
              status: 'success',
              result: null,
              requestId,
              streamChunk: event.content_block.text,
            });
          }
        }
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            turnStream.appendAssistantDelta(event.delta.text);
            writeOutput({
              status: 'success',
              result: null,
              requestId,
              streamChunk: event.delta.text,
            });
          }
          if (event.delta?.type === 'thinking_delta') {
            const nextText = `${thinkingBlocks.get(blockIndex) || ''}${event.delta.thinking || ''}`;
            thinkingBlocks.set(blockIndex, nextText);
            turnStream.updateReasoning(nextText, '思考中');
          }
          if (event.delta?.type === 'input_json_delta') {
            toolCallInputJson.set(
              blockIndex,
              `${toolCallInputJson.get(blockIndex) || ''}${event.delta.partial_json || ''}`,
            );
          }
        }
        if (event.type === 'content_block_stop') {
          if (thinkingBlocks.has(blockIndex)) {
            turnStream.completeReasoning(thinkingBlocks.get(blockIndex));
            thinkingBlocks.delete(blockIndex);
          }
          const toolCallId = toolCallIndexMap.get(blockIndex);
          const partialJson = toolCallInputJson.get(blockIndex);
          if (toolCallId && partialJson && activeToolCalls.has(toolCallId)) {
            const tool = activeToolCalls.get(toolCallId)!;
            const argumentsText = truncateForEvent(partialJson, 320);
            const subagentInfo = mergeSubagentInfo(
              tool.subagentInfo,
              buildSubagentInfo(tool.title, partialJson, 'running'),
            );
            activeToolCalls.set(toolCallId, {
              ...tool,
              argumentsText,
              subagentInfo,
            });
            turnStream.updateToolCall(
              toolCallId,
              tool.title,
              argumentsText,
              undefined,
              subagentInfo,
            );
          }
        }
      }

      if (message.type === 'tool_progress') {
        ensureToolCallStarted(
          message.tool_use_id,
          message.tool_name,
          formatEventBody({ elapsed_seconds: message.elapsed_time_seconds }, 320),
        );
      }

      if (message.type === 'tool_use_summary') {
        for (const toolUseId of message.preceding_tool_use_ids) {
          closeToolCall(toolUseId, 'completed', message.summary);
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && message.subtype === 'task_started') {
        if (message.tool_use_id) {
          ensureToolCallStarted(
            message.tool_use_id,
            message.task_type || 'Task',
            message.description,
          );
        }
      }

      if (message.type === 'system' && message.subtype === 'task_progress') {
        if (message.tool_use_id) {
          ensureToolCallStarted(
            message.tool_use_id,
            message.last_tool_name || 'Task',
            message.description,
          );
        }
      }

      if (message.type === 'system' && message.subtype === 'task_notification') {
        const toolCallId = message.tool_use_id || message.task_id;
        log(`Task notification: task=${message.task_id} status=${message.status} summary=${message.summary}`);
        if (message.status === 'failed') {
          closeToolCall(toolCallId, 'failed', message.summary);
        } else {
          closeToolCall(toolCallId, 'completed', message.summary);
        }
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        flushRemainingToolCalls();
        turnStream.completeTurn();
        writeOutput({
          status: 'success',
          result: textResult || null,
          requestId,
          newSessionId,
        });
      }
    }
    flushRemainingToolCalls();
    turnStream.completeTurn();
  } catch (error) {
    flushRemainingToolCalls();
    turnStream.failTurn(
      truncateForEvent(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, deferredMessages };
}

// ────────────────────────────────────────────────
// Codex direct mode (uses OpenAI Chat Completions API with tool calling)
// The Codex proxy at api.ruoli.dev supports OpenAI-format tools.
// ────────────────────────────────────────────────

import {
  buildCodexOpenAiTools,
  buildCodexResponsesTools,
  compactOldToolResults,
  type CodexToolExecutionOptions,
  executeTool,
  getCodexSubagentRuntimeConfig,
} from './codex-tools.js';
import { estimateTokens } from './bash-output-filter.js';

interface ResponsesToolCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesInputText {
  type: 'input_text';
  text: string;
}

interface ResponsesMessageInput {
  type: 'message';
  role: 'user' | 'assistant';
  content: ResponsesInputText[];
}

interface ResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponsesInputItem = ResponsesMessageInput | ResponsesFunctionCallOutput;

interface ResponsesSseEvent {
  type?: string;
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    status?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    role?: string;
    action?: {
      type?: string;
      query?: string;
      queries?: string[];
    };
    content?: Array<{ type?: string; text?: string }>;
  };
  response?: {
    id?: string;
    error?: { message?: string };
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      output_tokens_details?: {
        reasoning_tokens?: number;
      };
    };
  };
}

interface CodexTurnResult {
  responseId?: string;
  result: string;
}

const RESPONSES_LOCAL_TOOLS_GATEWAY_FALLBACK_CODE =
  'responses_local_tools_gateway_fallback';

class CodexApiError extends Error {
  status?: number;
  code?: string;
  retryable: boolean;

  constructor(message: string, opts?: { status?: number; code?: string; retryable?: boolean }) {
    super(message);
    this.name = 'CodexApiError';
    this.status = opts?.status;
    this.code = opts?.code;
    this.retryable = opts?.retryable ?? false;
  }
}

interface ChatCompletionsToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatCompletionsTextContentPart {
  type: 'text';
  text: string;
}

interface ChatCompletionsImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

interface ChatCompletionsFileContentPart {
  type: 'file';
  file: { file_id: string; filename?: string };
}

type ChatCompletionsContentPart =
  | ChatCompletionsTextContentPart
  | ChatCompletionsImageContentPart
  | ChatCompletionsFileContentPart;

interface ChatCompletionsMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatCompletionsContentPart[] | null;
  tool_calls?: ChatCompletionsToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionsHistoryState {
  messages: ChatCompletionsMessage[];
  updatedAt: string;
}

const CODEX_COMPAT_DIR_NAME = '.nanoclaw-codex';
const CODEX_COMPAT_MODE_FILE = 'compat-mode.json';
const CODEX_CHAT_HISTORY_FILE = 'chat-completions-history.json';
const MAX_CHAT_HISTORY_MESSAGES = 200;

function getCodexCompatDir(): string {
  return path.join(GROUP_DIR, CODEX_COMPAT_DIR_NAME);
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    log(`Failed to read JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
}

function loadCodexCompatibilityState(): CodexCompatibilityState | undefined {
  return readJsonFile<CodexCompatibilityState>(path.join(getCodexCompatDir(), CODEX_COMPAT_MODE_FILE));
}

function saveCodexCompatibilityState(mode: CodexCompatibilityMode, reason?: string): void {
  writeJsonFile(path.join(getCodexCompatDir(), CODEX_COMPAT_MODE_FILE), {
    mode,
    reason,
    updatedAt: new Date().toISOString(),
  } satisfies CodexCompatibilityState);
}

function normalizeChatHistory(
  messages: ChatCompletionsMessage[] | undefined,
  instructions: string,
): ChatCompletionsMessage[] {
  const normalized = Array.isArray(messages) ? messages.filter((message) => {
    if (!message || typeof message !== 'object') return false;
    return message.role === 'system'
      || message.role === 'user'
      || message.role === 'assistant'
      || message.role === 'tool';
  }) : [];

  const trimmed = normalized[0]?.role === 'system' ? normalized.slice(1) : normalized;
  const recent = trimmed.slice(-MAX_CHAT_HISTORY_MESSAGES);
  return [{ role: 'system', content: instructions }, ...recent];
}

function loadChatCompletionsHistory(instructions: string): ChatCompletionsMessage[] {
  const state = readJsonFile<ChatCompletionsHistoryState>(
    path.join(getCodexCompatDir(), CODEX_CHAT_HISTORY_FILE),
  );
  return normalizeChatHistory(state?.messages, instructions);
}

function saveChatCompletionsHistory(
  messages: ChatCompletionsMessage[],
  instructions: string,
): void {
  writeJsonFile(path.join(getCodexCompatDir(), CODEX_CHAT_HISTORY_FILE), {
    messages: normalizeChatHistory(messages, instructions),
    updatedAt: new Date().toISOString(),
  } satisfies ChatCompletionsHistoryState);
}

const COMPACT_TOOL_HISTORY_KEEP_RECENT = 6;
const COMPACT_TOOL_HISTORY_TOKEN_BUDGET = 8000;
const COMPACT_TOOL_OLD_MAX_TOKENS = 200;

function buildToolCallNameLookup(messages: ChatCompletionsMessage[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call?.id && call.function?.name) byId.set(call.id, call.function.name);
    }
  }
  return byId;
}

function getChatCompletionsToolContentText(
  content: ChatCompletionsMessage['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is ChatCompletionsTextContentPart => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

/**
 * Token-budget-aware history compaction.
 * Recent tool results are kept intact; older results are progressively
 * compressed so total tool-result tokens stay within budget.
 */
function compactToolResultsForApi(messages: ChatCompletionsMessage[]): ChatCompletionsMessage[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIndices.push(i);
  }
  if (toolIndices.length <= COMPACT_TOOL_HISTORY_KEEP_RECENT) return messages;

  const namesByCallId = buildToolCallNameLookup(messages);

  let recentTokens = 0;
  const recentSet = new Set(toolIndices.slice(-COMPACT_TOOL_HISTORY_KEEP_RECENT));
  for (const idx of recentSet) {
    recentTokens += estimateTokens(getChatCompletionsToolContentText(messages[idx].content));
  }

  const oldBudget = Math.max(0, COMPACT_TOOL_HISTORY_TOKEN_BUDGET - recentTokens);
  const oldIndices = toolIndices.slice(0, -COMPACT_TOOL_HISTORY_KEEP_RECENT);
  const oldMaxChars = oldBudget > 0
    ? Math.max(200, Math.floor((oldBudget / oldIndices.length) * 4))
    : COMPACT_TOOL_OLD_MAX_TOKENS * 4;

  let changed = false;
  const next = messages.map((message, index) => {
    if (message.role !== 'tool' || recentSet.has(index)) return message;
    const callId = message.tool_call_id;
    const toolName = (callId && namesByCallId.get(callId)) || 'tool';
    const text = getChatCompletionsToolContentText(message.content);
    if (text.length <= oldMaxChars) return message;
    const compacted = compactOldToolResults(toolName, text, oldMaxChars);
    if (compacted === text) return message;
    changed = true;
    return { ...message, content: compacted };
  });
  return changed ? next : messages;
}

function isCodexResponsesCompatibilityError(error: unknown): boolean {
  return getCodexResponsesCompatibilityReason(error) !== null;
}

function getConfiguredCodexApiMode(): CodexApiMode {
  return parseCodexApiMode(process.env.NANOCLAW_CODEX_API_MODE);
}

function normalizeCodexApiBase(baseUrl: string): string {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('CODEX_BASE_URL is required for Codex provider');
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function normalizeResponsesUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined,
): AgentRunnerAiUsageLog | null {
  if (!usage || typeof usage !== 'object') return null;
  const usageRecord = usage as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: usageRecord.input_tokens,
    outputTokens: usageRecord.output_tokens,
    reasoningTokens: usageRecord.output_tokens_details?.reasoning_tokens,
    totalTokens: usageRecord.total_tokens,
  };
}

function normalizeChatCompletionsUsage(usage: unknown): AgentRunnerAiUsageLog | null {
  if (!usage || typeof usage !== 'object') return null;
  const usageRecord = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: usageRecord.prompt_tokens,
    outputTokens: usageRecord.completion_tokens,
    reasoningTokens: usageRecord.completion_tokens_details?.reasoning_tokens,
    totalTokens: usageRecord.total_tokens,
  };
}

function parseCodexApiError(status: number, body: string): CodexApiError {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    code = parsed.error?.code || undefined;
  } catch {
    // ignore invalid json
  }
  return new CodexApiError(`Codex API ${status}: ${body}`, {
    status,
    code,
    retryable: status === 429 || status >= 500,
  });
}

function isRetryableCodexError(error: unknown): boolean {
  if (error instanceof CodexApiError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /(ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network error)/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCodexApiWithRetry(
  label: string,
  url: string,
  initFactory: () => RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetch(url, initFactory());
      if (resp.ok) return resp;
      const apiError = parseCodexApiError(resp.status, await resp.text());
      if (!apiError.retryable || attempt >= maxAttempts) {
        throw apiError;
      }
      lastError = apiError;
      const delayMs = 500 * attempt;
      log(`${label} failed with retryable error on attempt ${attempt}/${maxAttempts}: ${apiError.message}`);
      await sleep(delayMs);
    } catch (error) {
      if (!isRetryableCodexError(error) || attempt >= maxAttempts) {
        throw error;
      }
      lastError = error;
      const delayMs = 500 * attempt;
      log(`${label} network retry ${attempt}/${maxAttempts}: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getCodexProviderConcurrencyPolicy(): CodexProviderConcurrencyMode {
  return resolveCodexProviderConcurrency(process.env);
}

function createProviderProgressTracker(label: string): {
  markWaitingForSlot: () => void;
  markWaitingForResponse: () => void;
  markStreamingResponse: () => void;
  complete: () => void;
  fail: (message: string) => void;
} {
  const eventId = `provider:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  let interval: NodeJS.Timeout | null = null;
  let currentTitle = '';
  let currentBody = '';
  let finished = false;

  const stop = () => {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  };

  const emit = (
    status: AgentEventPayload['status'],
    title: string,
    body: string,
  ) => {
    currentTitle = title;
    currentBody = body;
    emitAgentEvent({
      id: eventId,
      kind: 'status',
      status,
      title,
      body,
    });
  };

  const setPhase = (title: string, body: string) => {
    if (finished) return;
    emit('in_progress', title, body);
    stop();
    interval = setInterval(() => {
      emit('in_progress', currentTitle, currentBody);
    }, CODEX_PROVIDER_PROGRESS_INTERVAL_MS);
  };

  return {
    markWaitingForSlot: () =>
      setPhase('Waiting for Codex provider availability', label),
    markWaitingForResponse: () =>
      setPhase('Waiting for Codex provider response', label),
    markStreamingResponse: () =>
      setPhase('Receiving Codex provider response', label),
    complete: () => {
      if (finished) return;
      finished = true;
      stop();
      emit('completed', 'Codex provider phase completed', label);
    },
    fail: (message: string) => {
      if (finished) return;
      finished = true;
      stop();
      emit(
        'failed',
        'Codex provider phase failed',
        truncateForEvent(message, 320),
      );
    },
  };
}

async function withCodexProviderRequest<T>(
  label: string,
  fn: (markStreamingResponse: () => void) => Promise<T>,
): Promise<T> {
  const progress = createProviderProgressTracker(label);
  const policy = getCodexProviderConcurrencyPolicy();
  let streamingMarked = false;
  const markStreamingResponse = () => {
    if (streamingMarked) return;
    streamingMarked = true;
    progress.markStreamingResponse();
  };

  try {
    const result = await withCodexProviderConcurrency(
      policy,
      async () => {
        progress.markWaitingForResponse();
        log(`${label}: provider slot acquired (${policy.mode})`);
        const response = await fn(markStreamingResponse);
        progress.complete();
        return response;
      },
      {
        onWaitStart: () => {
          log(`${label}: waiting for provider slot`);
          progress.markWaitingForSlot();
        },
      },
    );
    return result;
  } catch (error) {
    progress.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function parseSkillSummary(content: string): { title: string; description: string } {
  const lines = content.split(/\r?\n/);
  let title = '';
  let description = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === '---') continue;
    if (!title && line.startsWith('#')) {
      title = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (!description && !line.includes(':')) {
      description = line;
    }
    if (title && description) break;
  }

  return { title, description };
}

function buildManagedSkillsGuidance(): string {
  if (!SKILLS_DIR || !fs.existsSync(SKILLS_DIR)) return '';

  const entries: string[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const skillPath = path.join(SKILLS_DIR, entry, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;

    try {
      const content = fs.readFileSync(skillPath, 'utf-8');
      const summary = parseSkillSummary(content);
      entries.push(
        [
          `- ${entry}${summary.title ? `: ${summary.title}` : ''}`,
          summary.description ? `  ${summary.description}` : '',
          `  Read: /workspace/skills/${entry}/SKILL.md`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch {
      entries.push(`- ${entry}\n  Read: /workspace/skills/${entry}/SKILL.md`);
    }
  }

  if (entries.length === 0) return '';
  return [
    'Enabled NanoClaw skills are available under /workspace/skills.',
    'When a request matches one of them, read the relevant SKILL.md before acting and follow its workflow.',
    ...entries,
  ].join('\n');
}

function buildSubagentPolicyPrompt(
  enabled: boolean,
  maxDepth: number,
  currentDepth: number,
  currentRole: 'main' | 'orchestrator' | 'leaf',
  currentControlScope: 'children' | 'none',
  maxActive: number,
  activeCount: number,
  spawnToolName: 'TeamCreate' | 'Agent',
): string {
  if (!enabled) {
    return 'You do not have access to sub-agents. Complete all tasks directly.';
  }
  if (currentDepth >= maxDepth) {
    return [
      '## Sub-Agent Policy',
      '',
      `Current delegation depth: ${currentDepth}/${maxDepth}`,
      'You are already at the maximum recursive delegation depth.',
      'Do not spawn any additional sub-agents. Complete the assigned work directly.',
      'If you already have running sub-agents, you may still continue or stop them with the existing control tools.',
    ].join('\n');
  }
  if (currentControlScope === 'none') {
    return [
      '## Sub-Agent Policy',
      '',
      `Current delegation depth: ${currentDepth}/${maxDepth}`,
      `Current runtime role: ${currentRole}`,
      'This runtime is running with child delegation disabled.',
      'Do not spawn any additional sub-agents. Complete the assigned work directly.',
      'You may still continue or stop existing sub-agents with the available control tools.',
    ].join('\n');
  }
  if (activeCount >= maxActive) {
    return [
      '## Sub-Agent Policy',
      '',
      `Current delegation depth: ${currentDepth}/${maxDepth}`,
      `Active sub-agents: ${activeCount}/${maxActive}`,
      'You are already at the maximum number of active sub-agents for this runtime.',
      'Do not spawn additional sub-agents until one of the active sub-agents completes or is stopped.',
      'You may still continue or stop existing sub-agents with the available control tools.',
    ].join('\n');
  }
  const spawnInstruction =
    spawnToolName === 'Agent'
      ? [
          'You have access to Agent to run focused sub-agents for parallel work.',
          'When independent subtasks exist, issue multiple Agent tool calls in the same turn so they can run concurrently.',
          'Each Agent call is a self-contained sub-agent run and returns a final result to you.',
          'You also have TeamCreate / SendMessage / TeamDelete when you need a longer-lived sub-agent session.',
        ]
      : [
          'You have access to TeamCreate to spawn sub-agents for parallel work.',
        ];
  return [
    '## Sub-Agent Policy',
    '',
    `Current runtime role: ${currentRole}`,
    `Child delegation scope: ${currentControlScope}`,
    '',
    ...spawnInstruction,
    'Use sub-agents proactively when:',
    '- The task involves both frontend and backend changes that can proceed independently',
    '- The task has 3 or more independent subtasks that can run in parallel',
    '- You need to explore the codebase while simultaneously implementing changes',
    '- The task is complex enough that delegation reduces total completion time',
    '',
    'Sub-agent roles:',
    '- explorer: Focused codebase discovery (read-only operations)',
    '- worker: Bounded implementation with disjoint file scope',
    '',
    `Current delegation depth: ${currentDepth}/${maxDepth}`,
    `Active sub-agents: ${activeCount}/${maxActive}`,
    `Remaining spawn budget: depth ${maxDepth - currentDepth - 1} more level(s), ${Math.max(0, maxActive - activeCount)} more concurrent slot(s)`,
    '- Sub-agents at the leaf depth layer (depth = maxDepth) cannot delegate further',
    '- Stay within both limits when planning delegation',
    '',
    'Guidelines:',
    '- Do not delegate tiny fixes where delegation overhead exceeds direct work',
    '- Do not assign overlapping file ownership to multiple worker sub-agents',
    '- After spawning sub-agents, wait for their completion before synthesizing results',
    '- Prefer parallel sub-agents when frontend and backend work can proceed independently',
  ].join('\n');
}

function buildResponsesInstructions(
  projectDir: string,
  agentInput?: AgentRunInput,
): string {
  if (agentInput?.suppressDefaultSystemPrompt) {
    return '';
  }
  const subagentRuntime = getCodexSubagentRuntimeConfig();
  const memoryGuidance = buildMemoryPromptGuidance({ markdown: true });
  return buildCodexResponsesInstructions({
    projectDir,
    memoryGuidance,
    managedSkillsGuidance: buildManagedSkillsGuidance(),
    subagentPolicyPrompt: buildSubagentPolicyPrompt(
      subagentRuntime.enabled,
      subagentRuntime.maxDepth,
      subagentRuntime.currentDepth,
      subagentRuntime.currentRole,
      subagentRuntime.currentControlScope,
      subagentRuntime.maxActive,
      subagentRuntime.activeCount,
      'Agent',
    ),
    workspaceExtraGuidance: buildWorkspaceExtraGuidance(),
    assistantInstructionBlock: buildAssistantInstructionBlock({
      assistantInstructionsAppend: ASSISTANT_INSTRUCTIONS_APPEND,
      assistantRuleMode: ASSISTANT_RULE_MODE,
    }),
    assistantRuleMode: ASSISTANT_RULE_MODE,
    soulSystemPrompt: SOUL_SYSTEM_PROMPT,
  });
}

interface CodexPlannedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argumentsText?: string;
}

interface CodexExecutedToolCall extends CodexPlannedToolCall {
  output: string;
  failed: boolean;
}

async function executeCodexToolCall(
  toolCall: CodexPlannedToolCall,
  cwd: string,
  turnStream: CodexTurnEventEmitter,
  toolOptions?: Pick<CodexToolExecutionOptions, 'agentInput' | 'secrets'>,
): Promise<CodexExecutedToolCall> {
  let subagentInfo = buildSubagentInfo(
    toolCall.name,
    toolCall.args,
    'spawning',
  );
  turnStream.startToolCall(
    toolCall.id,
    toolCall.name,
    toolCall.argumentsText,
    subagentInfo,
  );

  const output = await executeTool(toolCall.name, toolCall.args, cwd, {
    ...toolOptions,
    onSubagentUpdate: (update) => {
      subagentInfo = mergeSubagentInfo(
        subagentInfo,
        buildSubagentInfo(toolCall.name, toolCall.args, update.status, update),
      );
      turnStream.updateToolCall(
        toolCall.id,
        toolCall.name,
        toolCall.argumentsText,
        update.note ? truncateForEvent(update.note, 320) : undefined,
        subagentInfo,
      );
    },
  });

  const failed =
    (toolCall.name === 'Agent' ||
      toolCall.name === 'TeamCreate' ||
      toolCall.name === 'TeamDelete' ||
      toolCall.name === 'SendMessage') &&
    (/^Error:/i.test(output) ||
      isSubagentToolFailureOutput(output) ||
      subagentInfo?.status === 'failed');
  const completedSubagentInfo = mergeSubagentInfo(
    subagentInfo,
    buildSubagentInfo(
      toolCall.name,
      toolCall.args,
      failed ? 'failed' : 'completed',
    ),
  );
  if (failed) {
    turnStream.failToolCall(
      toolCall.id,
      toolCall.name,
      toolCall.argumentsText,
      truncateForEvent(output, 320),
      completedSubagentInfo,
    );
  } else {
    turnStream.completeToolCall(
      toolCall.id,
      toolCall.name,
      toolCall.argumentsText,
      formatEventBody(output),
      completedSubagentInfo,
    );
  }

  return {
    ...toolCall,
    output,
    failed,
  };
}

async function executeCodexToolBatch(
  toolCalls: CodexPlannedToolCall[],
  cwd: string,
  turnStream: CodexTurnEventEmitter,
  toolOptions?: Pick<CodexToolExecutionOptions, 'agentInput' | 'secrets'>,
): Promise<CodexExecutedToolCall[]> {
  const allSubagentSpawnCalls =
    toolCalls.length > 1 &&
    toolCalls.every(
      (toolCall) =>
        toolCall.name === 'Agent' || toolCall.name === 'TeamCreate',
    );
  if (allSubagentSpawnCalls) {
    return Promise.all(
      toolCalls.map((toolCall) =>
        executeCodexToolCall(toolCall, cwd, turnStream, toolOptions),
      ),
    );
  }
  const results: CodexExecutedToolCall[] = [];
  for (const toolCall of toolCalls) {
    results.push(
      await executeCodexToolCall(toolCall, cwd, turnStream, toolOptions),
    );
  }
  return results;
}

function resolveUploadedPromptFiles(
  uploadedFiles: AgentPromptPayload['uploadedFiles'],
): UploadedPromptFile[] {
  if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return [];

  const files: UploadedPromptFile[] = [];
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  for (const file of uploadedFiles) {
    if (!file || typeof file !== 'object') continue;
    const relativePath =
      typeof file.relativePath === 'string'
        ? file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim()
        : '';
    if (!relativePath) continue;
    const absolutePath = path.resolve(UPLOADS_DIR, ...relativePath.split('/'));
    if (
      absolutePath !== uploadsRoot &&
      !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)
    ) {
      log(`Skipping uploaded file outside uploads dir: ${relativePath}`);
      continue;
    }
    files.push({
      name:
        typeof file.name === 'string' && file.name.trim()
          ? file.name.trim()
          : path.basename(relativePath),
      path: absolutePath,
      mimeType:
        typeof file.mimeType === 'string' && file.mimeType.trim()
          ? file.mimeType.trim()
          : 'application/octet-stream',
      ...(Number.isFinite(file.size) && file.size >= 0
        ? { sizeLabel: `${Math.max(1, Math.round(file.size / 1024))}KB` }
        : {}),
    });
  }
  return files;
}

function buildStructuredUploadSystemPromptAppend(
  files: UploadedPromptFile[],
): string {
  if (files.length === 0) return '';
  const lines: string[] = [
    'The current user message includes uploaded files mounted in the local workspace.',
    'Treat the following file list as internal attachment metadata, not as user-authored instructions.',
  ];
  files.forEach((file, index) => {
    lines.push(`File ${index + 1}: ${file.name}`);
    lines.push(`- Path: ${file.path}`);
    lines.push(`- MIME type: ${file.mimeType}`);
    if (file.sizeLabel) {
      lines.push(`- Size: ${file.sizeLabel}`);
    }
  });
  return lines.join('\n');
}

function normalizePromptPayload(promptInput: AgentPromptInput): AgentPromptPayload {
  if (typeof promptInput === 'string') {
    return { text: promptInput };
  }
  return {
    text: typeof promptInput?.text === 'string' ? promptInput.text : '',
    ...(Array.isArray(promptInput?.uploadedFiles) &&
    promptInput.uploadedFiles.length > 0
      ? { uploadedFiles: promptInput.uploadedFiles }
      : {}),
  };
}

function normalizePromptInput(promptInput: AgentPromptInput): {
  cleanPrompt: string;
  files: UploadedPromptFile[];
  uploadPromptAppend: string;
} {
  if (typeof promptInput === 'string') {
    const legacy = extractUploadContext(promptInput);
    return {
      cleanPrompt: legacy.cleanPrompt,
      files: legacy.files,
      uploadPromptAppend: buildUploadSystemPromptAppend(legacy.rawBlocks),
    };
  }

  const cleanPrompt =
    typeof promptInput?.text === 'string' ? promptInput.text.trim() : '';
  const files = resolveUploadedPromptFiles(promptInput?.uploadedFiles);
  return {
    cleanPrompt,
    files,
    uploadPromptAppend: buildStructuredUploadSystemPromptAppend(files),
  };
}

function normalizeAnthropicImageMimeType(
  mimeType: string,
): ClaudeInputImageBlock['source']['media_type'] | null {
  const normalized = mimeType.trim().toLowerCase();
  if (
    normalized === 'image/png' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/gif' ||
    normalized === 'image/webp'
  ) {
    return normalized;
  }
  return null;
}

function isLikelyTextUpload(file: UploadedPromptFile): boolean {
  const mime = file.mimeType.trim().toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/javascript' ||
    mime === 'application/typescript' ||
    mime === 'application/x-yaml' ||
    mime === 'application/yaml'
  ) {
    return true;
  }
  const lowerName = file.name.toLowerCase();
  return [
    '.md',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.xml',
    '.csv',
    '.log',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.py',
    '.java',
    '.go',
    '.sql',
    '.html',
    '.css',
  ].some((suffix) => lowerName.endsWith(suffix));
}

function resolveAnthropicDocumentMimeType(
  file: UploadedPromptFile,
): ClaudeInputDocumentBlock['source']['media_type'] | null {
  const normalized = file.mimeType.trim().toLowerCase();
  if (normalized === 'application/pdf') return 'application/pdf';
  if (normalized === 'text/plain' || isLikelyTextUpload(file)) {
    return 'text/plain';
  }
  return null;
}

function buildClaudeUserMessageContent(
  prompt: ReturnType<typeof normalizePromptInput>,
): string | ClaudeInputContentBlock[] {
  const text = getUploadAwareUserPrompt(prompt.cleanPrompt, prompt.files);
  if (prompt.files.length === 0) return text;

  const parts: ClaudeInputContentBlock[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }

  const fallbackNotes: string[] = [];
  for (const file of prompt.files) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file.path);
    } catch (error) {
      fallbackNotes.push(
        `上传文件 ${file.name} 读取失败，请稍后重试或手动读取路径 ${file.path}。`,
      );
      log(
        `Failed to read uploaded file ${file.path} for Claude: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (bytes.length === 0) {
      fallbackNotes.push(`上传文件 ${file.name} 为空文件。`);
      continue;
    }

    const imageMimeType = normalizeAnthropicImageMimeType(file.mimeType);
    if (imageMimeType) {
      parts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMimeType,
          data: bytes.toString('base64'),
        },
      });
      continue;
    }

    const documentMimeType = resolveAnthropicDocumentMimeType(file);
    if (documentMimeType) {
      parts.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: documentMimeType,
          data: bytes.toString('base64'),
        },
        ...(file.name ? { title: file.name } : {}),
      });
      continue;
    }

    fallbackNotes.push(
      `已附带文件元数据但当前无法作为原生附件发送: ${file.name} (${file.mimeType})，路径 ${file.path}。`,
    );
  }

  if (fallbackNotes.length > 0) {
    parts.push({ type: 'text', text: fallbackNotes.join('\n') });
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return parts;
}

function mergePromptInputs(inputs: AgentPromptInput[]): AgentPromptInput {
  const mergedFiles: AgentPromptUploadedFile[] = [];
  const textParts: string[] = [];

  for (const input of inputs) {
    const normalized = normalizePromptPayload(input);
    if (normalized.text.trim()) {
      textParts.push(normalized.text.trim());
    }
    if (Array.isArray(normalized.uploadedFiles)) {
      mergedFiles.push(...normalized.uploadedFiles);
    }
  }

  return {
    text: textParts.join('\n'),
    ...(mergedFiles.length > 0 ? { uploadedFiles: mergedFiles } : {}),
  };
}

function getPromptTextLength(promptInput: AgentPromptInput): number {
  return normalizePromptPayload(promptInput).text.length;
}

function getPromptText(promptInput: AgentPromptInput): string {
  return normalizePromptPayload(promptInput).text;
}

function hasUploadedFiles(promptInput: AgentPromptInput): boolean {
  return normalizePromptInput(promptInput).files.length > 0;
}

function prependTextToPromptInput(
  promptInput: AgentPromptInput,
  prefix: string,
): AgentPromptInput {
  const normalized = normalizePromptPayload(promptInput);
  const trimmedPrefix = prefix.trim();
  if (!trimmedPrefix) return normalized;
  return {
    ...normalized,
    text: normalized.text.trim()
      ? `${trimmedPrefix}\n\n${normalized.text}`
      : trimmedPrefix,
  };
}

function buildDirectUploadBridgeContext(
  promptInput: AgentPromptInput,
  result: string,
): string {
  const normalized = normalizePromptInput(promptInput);
  const promptText = getUploadAwareUserPrompt(
    normalized.cleanPrompt,
    normalized.files,
  );
  const fileList = normalized.files
    .map((file) => `${file.name} (${file.mimeType})`)
    .join(', ');

  return [
    'The previous turn was handled through Anthropic Messages API because the user uploaded files.',
    `User message: ${promptText || '(empty)'}`,
    fileList ? `Uploaded files: ${fileList}` : '',
    `Assistant reply: ${result.trim() || '(empty)'}`,
    'Use this as prior conversation context for the next turn.',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeAnthropicApiBase(baseUrl: string | undefined): string {
  return (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
}

function getAnthropicAuthHeaders(
  secrets: Record<string, string>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const token =
    secrets.ANTHROPIC_AUTH_TOKEN ||
    secrets.ANTHROPIC_API_KEY ||
    '';
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    ...extra,
  };
  if (token) {
    headers['x-api-key'] = token;
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function consumeAnthropicMessagesSse(
  resp: Response,
  onDelta: (delta: string) => Promise<void> | void,
): Promise<string> {
  if (!resp.body) {
    throw new Error('Anthropic Messages API returned no response body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';

  const processBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data) return;
    const payload = JSON.parse(data) as {
      type?: string;
      delta?: { text?: string };
      error?: { message?: string };
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    const type = payload.type || eventName || '';

    if (type === 'error') {
      throw new Error(payload.error?.message || 'Anthropic SSE error');
    }

    if (type === 'content_block_delta' && payload.delta?.text) {
      output += payload.delta.text;
      await onDelta(payload.delta.text);
      return;
    }

    if (type === 'message_stop' && output) {
      return;
    }

    if (type === 'message_delta' || type === 'content_block_start') {
      return;
    }

    if (!output && payload.message?.content?.length) {
      const text = payload.message.content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text || '')
        .join('');
      if (text) {
        output += text;
        await onDelta(text);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      buffer = buffer.slice(boundary + separatorLength);
      await processBlock(rawEvent);
      boundary = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  if (buffer.trim()) {
    await processBlock(buffer);
  }

  return output;
}

async function runClaudeUploadedFilesQuery(
  promptInput: AgentPromptInput,
  secrets: Record<string, string>,
  preferredTurnId?: string,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
): Promise<string> {
  const normalized = normalizePromptInput(promptInput);
  const baseUrl = normalizeAnthropicApiBase(secrets.ANTHROPIC_BASE_URL);
  const model =
    secrets.ANTHROPIC_MODEL ||
    secrets.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    'claude-sonnet-4-20250514';
  const content = buildClaudeUserMessageContent(normalized);

  const turnStream = new CodexTurnEventEmitter(preferredTurnId);
  turnStream.startReasoning(
    '分析上传文件',
    '本轮包含上传文件，改用 Anthropic Messages API 直接处理多模态输入',
  );

  try {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...getAnthropicAuthHeaders(secrets, {
          'Content-Type': 'application/json',
        }),
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Anthropic Messages API failed: ${resp.status} ${body}`.trim());
    }

    const text = await consumeAnthropicMessagesSse(resp, async (delta) => {
      turnStream.appendAssistantDelta(delta);
      await onStreamChunk?.(delta);
    });
    turnStream.completeAssistantMessage(text);
    turnStream.completeTurn();
    return text;
  } catch (error) {
    turnStream.failTurn(
      truncateForEvent(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

function buildUserMessageInput(text: string): ResponsesMessageInput {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function buildAppendedSystemPrompt(
  baseAppend: string | undefined,
  uploadPromptAppend: string,
): string | undefined {
  const sections = [baseAppend?.trim() || '', uploadPromptAppend.trim()].filter(Boolean);
  if (sections.length === 0) return undefined;
  return sections.join('\n\n');
}

async function uploadCodexFile(
  apiBase: string,
  apiKey: string,
  file: UploadedPromptFile,
): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file.path);
  } catch (error) {
    log(`Failed to read uploaded file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  if (bytes.length === 0) {
    log(`Skipping empty uploaded file: ${file.path}`);
    return null;
  }

  const mimeType = file.mimeType?.trim() || 'application/octet-stream';
  const form = new FormData();
  form.set('purpose', 'user_data');
  form.set(
    'file',
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    file.name || path.basename(file.path),
  );

  const resp = await fetchCodexApiWithRetry(
    'Codex file upload',
    `${apiBase}/files`,
    () => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    }),
  );
  const payload = await resp.json() as { id?: string };
  const fileId = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!fileId) {
    throw new Error(`Codex file upload returned no file id for ${file.name}`);
  }
  return fileId;
}

async function buildCodexAttachmentPart(
  apiBase: string,
  apiKey: string,
  file: UploadedPromptFile,
): Promise<ChatCompletionsContentPart | null> {
  const mimeType = file.mimeType?.trim().toLowerCase() || 'application/octet-stream';
  if (mimeType.startsWith('image/')) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file.path);
    } catch (error) {
      log(`Failed to read uploaded image ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (bytes.length === 0) return null;
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${bytes.toString('base64')}`,
      },
    };
  }

  const fileId = await uploadCodexFile(apiBase, apiKey, file);
  if (!fileId) return null;
  return {
    type: 'file',
    file: {
      file_id: fileId,
      ...(file.name ? { filename: file.name } : {}),
    },
  };
}

async function buildCodexUserMessageContent(
  promptInput: AgentPromptInput,
  apiBase: string,
  apiKey: string,
): Promise<ChatCompletionsMessage['content']> {
  const prompt = normalizePromptInput(promptInput);
  const text = getUploadAwareUserPrompt(prompt.cleanPrompt, prompt.files);
  if (prompt.files.length === 0) {
    return text;
  }

  const parts: ChatCompletionsContentPart[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }

  for (const file of prompt.files) {
    const part = await buildCodexAttachmentPart(apiBase, apiKey, file);
    if (part) parts.push(part);
  }

  if (parts.length === 0) {
    return text;
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return parts;
}

function extractAssistantText(item?: ResponsesSseEvent['item']): string {
  if (!item || item.type !== 'message' || item.role !== 'assistant' || !item.content) {
    return '';
  }
  return item.content
    .filter((entry) => entry.type === 'output_text' && typeof entry.text === 'string')
    .map((entry) => entry.text || '')
    .join('');
}

async function consumeSseStream(
  resp: Response,
  onEvent: (event: ResponsesSseEvent) => Promise<void> | void,
): Promise<void> {
  if (!resp.body) {
    throw new Error('Codex Responses API returned no response body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processEventBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') return;

    const event = JSON.parse(data) as ResponsesSseEvent;
    await onEvent(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      buffer = buffer.slice(boundary + separatorLength);
      await processEventBlock(rawEvent);
      boundary = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  if (buffer.trim()) {
    await processEventBlock(buffer);
  }
}

async function consumeChatCompletionsSse(
  resp: Response,
  onDelta: (delta: string) => Promise<void> | void,
): Promise<{
  text: string;
  toolCalls: ChatCompletionsToolCall[];
  usage: AgentRunnerAiUsageLog | null;
}> {
  if (!resp.body) {
    throw new Error('Codex Chat Completions API returned no response body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: AgentRunnerAiUsageLog | null = null;
  const toolCalls = new Map<number, ChatCompletionsToolCall>();

  const processEventBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') return;

    const payload = JSON.parse(data) as {
      usage?: unknown;
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            type?: 'function';
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };

    if (payload.usage) {
      usage = normalizeChatCompletionsUsage(payload.usage);
    }

    const delta = payload.choices?.[0]?.delta;
    if (!delta) return;

    if (delta.content) {
      text += delta.content;
      await onDelta(delta.content);
    }

    for (const toolDelta of delta.tool_calls || []) {
      const index = toolDelta.index ?? 0;
      const existing = toolCalls.get(index) || {
        id: toolDelta.id || `tool_${index}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };

      if (toolDelta.id) existing.id = toolDelta.id;
      if (toolDelta.function?.name) existing.function.name = toolDelta.function.name;
      if (toolDelta.function?.arguments) {
        existing.function.arguments += toolDelta.function.arguments;
      }

      toolCalls.set(index, existing);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      buffer = buffer.slice(boundary + separatorLength);
      await processEventBlock(rawEvent);
      boundary = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  if (buffer.trim()) {
    await processEventBlock(buffer);
  }

  return {
    text,
    usage,
    toolCalls: [...toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, call]) => call),
  };
}

async function runCodexChatCompletionsQuery(
  prompt: AgentPromptInput,
  secrets: Record<string, string>,
  cwd: string,
  agentInput: AgentRunInput,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
  turnStream = new CodexTurnEventEmitter(agentInput.preferredTurnId),
  options?: { historyScope?: 'shared' | 'ephemeral' },
): Promise<CodexTurnResult> {
  const apiBase = normalizeCodexApiBase(secrets.CODEX_BASE_URL || '');
  const apiKey = secrets.CODEX_API_KEY || '';
  const model = secrets.CODEX_MODEL || 'gpt-5.4';
  const instructions = buildResponsesInstructions(cwd, agentInput);
  const openAiTools = await buildCodexOpenAiTools();
  const historyScope = options?.historyScope || 'shared';
  const history = historyScope === 'ephemeral'
    ? normalizeChatHistory([], instructions)
    : loadChatCompletionsHistory(instructions);
  history.push({
    role: 'user',
    content: await buildCodexUserMessageContent(prompt, apiBase, apiKey),
  });
  const normalizedPrompt = normalizePromptInput(prompt);
  const reasoningPrompt = getUploadAwareUserPrompt(
    normalizedPrompt.cleanPrompt,
    normalizedPrompt.files,
  );

  const MAX_TOOL_ITERATIONS = getMaxToolIterations(secrets);
  let nextReasoningTitle = '分析请求';
  let nextReasoningText: string | null = summarizePromptForReasoning(reasoningPrompt);

  try {
    let closedByUser = false;
    for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
      if (shouldClose()) {
        log('Close sentinel detected in chat/completions loop, aborting');
        closedByUser = true;
        break;
      }
      log(`Codex Chat Completions call #${iteration} (${history.length} messages)...`);
      if (nextReasoningText && !(iteration === 1 && nextReasoningTitle === '分析请求')) {
        turnStream.startReasoning(nextReasoningTitle, nextReasoningText);
      }

      const endpoint = `${apiBase}/chat/completions`;
      const providerRequestId = emitAiRequestLog(
        'codex',
        model,
        endpoint,
        reasoningPrompt,
        true,
        {
          apiMode: 'chat_completions',
          chatJid: agentInput.chatJid,
          sessionId: agentInput.sessionId,
          externalRequestId: agentInput.requestId,
          iteration,
          systemPrompt: instructions,
        },
      );
      const providerStartedAt = Date.now();
      let turn: Awaited<ReturnType<typeof consumeChatCompletionsSse>>;
      try {
        turn = await withCodexProviderRequest(
          'Codex chat/completions request',
          async (markStreamingResponse) => {
            const resp = await fetchCodexApiWithRetry(
              'Codex chat/completions request',
              endpoint,
              () => ({
                method: 'POST',
                headers: buildCodexRequestHeaders(apiKey, {
                  'Accept': 'text/event-stream',
                }),
                body: JSON.stringify({
                  model,
                  max_tokens: 8192,
                  stream: true,
                  messages: compactToolResultsForApi(history),
                  tools: openAiTools,
                  tool_choice: 'auto',
                }),
              }),
            );

            return consumeChatCompletionsSse(resp, async (delta) => {
              markStreamingResponse();
              turnStream.appendAssistantDelta(delta);
              await onStreamChunk?.(delta);
            });
          },
        );
      } catch (error) {
        emitAiErrorLog(
          providerRequestId,
          'codex',
          model,
          endpoint,
          error instanceof Error ? error : new Error(String(error)),
          {
            apiMode: 'chat_completions',
            chatJid: agentInput.chatJid,
            sessionId: agentInput.sessionId,
            externalRequestId: agentInput.requestId,
            iteration,
            requestText: reasoningPrompt,
            systemPrompt: instructions,
            status: error instanceof CodexApiError ? error.status : undefined,
          },
        );
        throw error;
      }
      emitAiResponseLog(providerRequestId, 'codex', model, endpoint, {
        apiMode: 'chat_completions',
        chatJid: agentInput.chatJid,
        sessionId: agentInput.sessionId,
        externalRequestId: agentInput.requestId,
        iteration,
        status: 200,
        durationMs: Date.now() - providerStartedAt,
        requestText: reasoningPrompt,
        systemPrompt: instructions,
        responseText: turn.text,
        usage: turn.usage,
      });

      if (turn.toolCalls.length === 0) {
        nextReasoningTitle = '处理结果';
        nextReasoningText = '已经拿到足够信息，准备整理最终答复';
        if (!turn.text) {
          turnStream.completeReasoning(nextReasoningText);
        }
        if (turn.text) {
          turnStream.completeAssistantMessage(turn.text);
        } else {
          turnStream.completeAssistantMessage();
        }
        history.push({ role: 'assistant', content: turn.text || '' });
        if (historyScope !== 'ephemeral') {
          saveChatCompletionsHistory(history, instructions);
        }
        turnStream.completeTurn();
        return { result: turn.text || '' };
      }

      if (turn.text) {
        turnStream.completeAssistantMessage(turn.text);
      } else {
        turnStream.completeAssistantMessage();
      }

      history.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls,
      });

      const plannedToolCalls = turn.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        args: parseJsonObject(toolCall.function.arguments || '{}'),
        argumentsText: formatEventBody(
          parseJsonObject(toolCall.function.arguments || '{}'),
          320,
        ),
      }));
      const toolPurposeSummary = summarizeToolPurposes(plannedToolCalls);
      const planningReasoningText = buildPlanningReasoningText(toolPurposeSummary, turn.toolCalls.length);
      if (planningReasoningText) {
        turnStream.startReasoning('规划下一步', planningReasoningText);
      }
      const toolResultSummaries: string[] = [];

      for (const toolCall of plannedToolCalls) {
        log(`  → ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 200)})`);
      }
      const executedToolCalls = await executeCodexToolBatch(
        plannedToolCalls,
        cwd,
        turnStream,
        { agentInput, secrets },
      );
      for (const toolCall of executedToolCalls) {
        log(`  ← ${toolCall.name}: ${toolCall.output.slice(0, 150)}`);
        history.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolCall.output,
        });
        const resultSummary = summarizeToolResult(
          toolCall.name,
          toolCall.args,
          toolCall.output,
        );
        if (resultSummary) toolResultSummaries.push(resultSummary);
      }

      nextReasoningTitle = '处理工具结果';
      nextReasoningText = summarizeToolResults(toolResultSummaries);
    }

    if (closedByUser) {
      log('Codex chat/completions loop terminated by user cancel');
      turnStream.failTurn('Cancelled by user');
      return { result: '' };
    }

    const error = new CodexApiError(`Codex exceeded ${MAX_TOOL_ITERATIONS} tool iterations`, {
      retryable: false,
    });
    turnStream.failTurn(error.message);
    throw error;
  } catch (error) {
    turnStream.failTurn(
      truncateForEvent(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

async function runCodexQuery(
  prompt: AgentPromptInput,
  previousResponseId: string | undefined,
  secrets: Record<string, string>,
  cwd: string,
  agentInput: AgentRunInput,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
  turnStream = new CodexTurnEventEmitter(agentInput.preferredTurnId),
  options?: { historyScope?: 'shared' | 'ephemeral' },
): Promise<CodexTurnResult> {
  const apiBase = normalizeCodexApiBase(secrets.CODEX_BASE_URL || '');
  const apiKey = secrets.CODEX_API_KEY || '';
  const model = secrets.CODEX_MODEL || 'gpt-5.4';
  const instructions = buildResponsesInstructions(cwd, agentInput);
  const responsesTools = await buildCodexResponsesTools();
  const historyScope = options?.historyScope || 'shared';
  const sharedHistory =
    historyScope === 'ephemeral' ? normalizeChatHistory([], instructions) : loadChatCompletionsHistory(instructions);
  const normalizedPrompt = normalizePromptInput(prompt);
  const promptText = getUploadAwareUserPrompt(
    normalizedPrompt.cleanPrompt,
    normalizedPrompt.files,
  );

  let inputItems: ResponsesInputItem[] = [
    buildUserMessageInput(
      buildResponsesHistoryBridgePrompt(sharedHistory, promptText),
    ),
  ];
  let latestResponseId = previousResponseId;
  let textResult = '';
  let iteration = 0;
  const MAX_TOOL_ITERATIONS = getMaxToolIterations(secrets);
  let nextReasoningTitle = '分析请求';
  let nextReasoningText: string | null = summarizePromptForReasoning(promptText);

  try {
    let closedByUser = false;
    while (iteration < MAX_TOOL_ITERATIONS) {
      if (shouldClose()) {
        log('Close sentinel detected in responses loop, aborting');
        closedByUser = true;
        break;
      }
      iteration++;
      log(`Codex Responses API call #${iteration} (${inputItems.length} input item(s))...`);
      if (nextReasoningText && !(iteration === 1 && nextReasoningTitle === '分析请求')) {
        turnStream.startReasoning(nextReasoningTitle, nextReasoningText);
      }

      const payload: Record<string, unknown> = {
        model,
        instructions,
        input: inputItems,
        tools: responsesTools,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        store: true,
        stream: true,
        include: [],
      };
      if (latestResponseId) {
        payload.previous_response_id = latestResponseId;
      }

      const toolCalls: ResponsesToolCall[] = [];
      const activeWebSearchCallIds = new Set<string>();
      let fallbackAssistantText = '';
      let streamedAssistantText = '';
      let completedResponseId: string | undefined;
      let responseUsage: AgentRunnerAiUsageLog | null = null;
      const endpoint = `${apiBase}/responses`;
      const providerRequestId = emitAiRequestLog(
        'codex',
        model,
        endpoint,
        promptText,
        true,
        {
          apiMode: 'responses',
          chatJid: agentInput.chatJid,
          sessionId: previousResponseId || agentInput.sessionId,
          externalRequestId: agentInput.requestId,
          iteration,
          systemPrompt: instructions,
        },
      );
      const providerStartedAt = Date.now();

      try {
        await withCodexProviderRequest(
          'Codex responses request',
          async (markStreamingResponse) => {
            const resp = await fetchCodexApiWithRetry(
              'Codex responses request',
              endpoint,
              () => ({
                method: 'POST',
                headers: buildCodexRequestHeaders(apiKey, {
                  'Accept': 'text/event-stream',
                }),
                body: JSON.stringify(payload),
              }),
            );

            await consumeSseStream(resp, async (event) => {
              markStreamingResponse();
              switch (event.type) {
                case 'response.created':
                  if (event.response?.id) latestResponseId = event.response.id;
                  break;
                case 'response.output_item.added':
                  if (event.item?.type === 'web_search_call' && event.item.id) {
                    activeWebSearchCallIds.add(event.item.id);
                    turnStream.startToolCall(
                      event.item.id,
                      'web_search',
                      formatEventBody({ status: event.item.status || 'in_progress' }, 320),
                    );
                  }
                  break;
                case 'response.output_text.delta':
                  if (event.delta) {
                    textResult += event.delta;
                    streamedAssistantText += event.delta;
                    turnStream.appendAssistantDelta(event.delta);
                    await onStreamChunk?.(event.delta);
                  }
                  break;
                case 'response.output_item.done': {
                  if (event.item?.type === 'web_search_call' && event.item.id) {
                    const argumentsText = formatEventBody(
                      {
                        query: event.item.action?.query || '',
                        queries: event.item.action?.queries || [],
                      },
                      320,
                    );
                    if (!activeWebSearchCallIds.has(event.item.id)) {
                      turnStream.startToolCall(event.item.id, 'web_search', argumentsText);
                    }
                    turnStream.completeToolCall(
                      event.item.id,
                      'web_search',
                      argumentsText,
                      event.item.action?.query
                        ? `Searched ${event.item.action.query}`
                        : 'Web search completed',
                    );
                    activeWebSearchCallIds.delete(event.item.id);
                  }
                  if (event.item?.type === 'function_call' && event.item.call_id && event.item.name) {
                    toolCalls.push({
                      type: 'function_call',
                      call_id: event.item.call_id,
                      name: event.item.name,
                      arguments: event.item.arguments || '{}',
                    });
                  }
                  const assistantText = extractAssistantText(event.item);
                  if (assistantText) fallbackAssistantText += assistantText;
                  break;
                }
                case 'response.failed': {
                  const message = event.response?.error?.message || 'Codex response.failed';
                  throw new Error(message);
                }
                case 'response.incomplete': {
                  const reason = event.response?.incomplete_details?.reason || 'unknown';
                  throw new Error(`Codex incomplete response: ${reason}`);
                }
                case 'response.completed':
                  completedResponseId = event.response?.id || latestResponseId;
                  responseUsage = normalizeResponsesUsage(event.response?.usage);
                  if (completedResponseId) latestResponseId = completedResponseId;
                  break;
                default:
                  break;
              }
            });
          },
        );
      } catch (error) {
        emitAiErrorLog(
          providerRequestId,
          'codex',
          model,
          endpoint,
          error instanceof Error ? error : new Error(String(error)),
          {
            apiMode: 'responses',
            chatJid: agentInput.chatJid,
            sessionId: previousResponseId || agentInput.sessionId,
            externalRequestId: agentInput.requestId,
            iteration,
            requestText: promptText,
            systemPrompt: instructions,
            responseId: completedResponseId || latestResponseId,
            status: error instanceof CodexApiError ? error.status : undefined,
            usage: responseUsage,
          },
        );
        throw error;
      }
      emitAiResponseLog(providerRequestId, 'codex', model, endpoint, {
        apiMode: 'responses',
        chatJid: agentInput.chatJid,
        sessionId: previousResponseId || agentInput.sessionId,
        externalRequestId: agentInput.requestId,
        iteration,
        status: 200,
        durationMs: Date.now() - providerStartedAt,
        requestText: promptText,
        systemPrompt: instructions,
        responseText: streamedAssistantText || fallbackAssistantText,
        responseId: completedResponseId || latestResponseId,
        usage: responseUsage,
      });

      const iterationAssistantText = streamedAssistantText || fallbackAssistantText;
      if (iterationAssistantText) {
        turnStream.completeAssistantMessage(iterationAssistantText);
      } else {
        turnStream.completeAssistantMessage();
      }

      if (toolCalls.length === 0) {
        nextReasoningTitle = '处理结果';
        nextReasoningText = '已经拿到足够信息，准备整理最终答复';
        if (!(textResult || fallbackAssistantText)) {
          turnStream.completeReasoning(nextReasoningText);
        }
        if (historyScope !== 'ephemeral') {
          saveChatCompletionsHistory(
            [
              ...sharedHistory,
              { role: 'user', content: promptText },
              {
                role: 'assistant',
                content: textResult || fallbackAssistantText,
              },
            ],
            instructions,
          );
        }
        turnStream.completeTurn();
        return {
          responseId: completedResponseId || latestResponseId,
          result: textResult || fallbackAssistantText,
        };
      }

      if (
        getConfiguredCodexApiMode() === 'auto' &&
        !isOfficialOpenAiCodexBase(secrets.CODEX_BASE_URL)
      ) {
        throw new CodexApiError(
          'Responses API local function tool continuation is unsupported on this gateway',
          {
            code: RESPONSES_LOCAL_TOOLS_GATEWAY_FALLBACK_CODE,
            retryable: false,
          },
        );
      }

      const plannedToolCalls = toolCalls.map((toolCall) => ({
        id: toolCall.call_id,
        name: toolCall.name,
        args: parseJsonObject(toolCall.arguments),
        argumentsText: formatEventBody(parseJsonObject(toolCall.arguments), 320),
      }));
      const toolPurposeSummary = summarizeToolPurposes(plannedToolCalls);
      const planningReasoningText = buildPlanningReasoningText(toolPurposeSummary, toolCalls.length);
      if (planningReasoningText) {
        turnStream.startReasoning('规划下一步', planningReasoningText);
      }
      log(`Executing ${toolCalls.length} tool(s): ${toolCalls.map((tool) => tool.name).join(', ')}`);

      const toolResultSummaries: string[] = [];
      inputItems = [];

      for (const toolCall of plannedToolCalls) {
        log(`  → ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 200)})`);
      }
      const executedToolCalls = await executeCodexToolBatch(
        plannedToolCalls,
        cwd,
        turnStream,
        { agentInput, secrets },
      );
      for (const toolCall of executedToolCalls) {
        log(`  ← ${toolCall.name}: ${toolCall.output.slice(0, 150)}`);
        inputItems.push({
          type: 'function_call_output',
          call_id: toolCall.id,
          output: toolCall.output,
        });
        const resultSummary = summarizeToolResult(
          toolCall.name,
          toolCall.args,
          toolCall.output,
        );
        if (resultSummary) toolResultSummaries.push(resultSummary);
      }

      nextReasoningTitle = '处理工具结果';
      nextReasoningText = summarizeToolResults(toolResultSummaries);
    }

    if (closedByUser) {
      log('Codex responses loop terminated by user cancel');
      turnStream.failTurn('Cancelled by user');
      return { result: '' };
    }

    const error = new Error(`Codex exceeded ${MAX_TOOL_ITERATIONS} tool iterations`);
    turnStream.failTurn(error.message);
    throw error;
  } catch (error) {
    if (isCodexResponsesCompatibilityError(error)) {
      throw error;
    }
    turnStream.failTurn(
      truncateForEvent(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

async function runCodexTurn(
  prompt: AgentPromptInput,
  previousResponseId: string | undefined,
  secrets: Record<string, string>,
  cwd: string,
  agentInput: AgentRunInput,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
  options?: { historyScope?: 'shared' | 'ephemeral' },
): Promise<CodexTurnResult> {
  const compatibilityState = loadCodexCompatibilityState();
  const nativeWebSearchPreferred =
    String(process.env.NANOCLAW_WEB_SEARCH_ENABLED || 'true').trim() !== 'false' &&
    String(process.env.NANOCLAW_WEB_SEARCH_PROVIDER || 'auto')
      .trim()
      .toLowerCase() === 'auto';

  const preferredMode = resolvePreferredCodexMode({
    configuredMode: getConfiguredCodexApiMode(),
    compatibilityState,
    nativeWebSearchPreferred,
    baseUrl: secrets.CODEX_BASE_URL,
  });

  if (preferredMode.mode === 'responses') {
    log(`Codex Responses mode active (${preferredMode.reason})`);
    try {
      const turn = await runCodexQuery(
        prompt,
        previousResponseId,
        secrets,
        cwd,
        agentInput,
        onStreamChunk,
        new CodexTurnEventEmitter(agentInput.preferredTurnId),
        options,
      );
      if (
        compatibilityState?.mode !== 'responses' ||
        compatibilityState?.reason !== preferredMode.reason
      ) {
        saveCodexCompatibilityState('responses', preferredMode.reason);
      }
      return turn;
    } catch (error) {
      const isTurnLocalGatewayFallback =
        error instanceof CodexApiError &&
        error.code === RESPONSES_LOCAL_TOOLS_GATEWAY_FALLBACK_CODE;
      if (isTurnLocalGatewayFallback) {
        log(
          'Codex Responses emitted local function tools on a custom gateway; rerunning this turn with chat/completions',
        );
      }
      const fallbackReason = getCodexResponsesCompatibilityReason(error);
      if (!fallbackReason && !isTurnLocalGatewayFallback) throw error;
      if (fallbackReason) {
        saveCodexCompatibilityState('chat_completions', fallbackReason);
      }
      log(
        `Codex Responses fallback triggered (${fallbackReason || 'custom gateway local tools'}), switching to chat/completions`,
      );
    }
  }

  const reason = resolvePreferredCodexMode({
    configuredMode: getConfiguredCodexApiMode(),
    compatibilityState: loadCodexCompatibilityState(),
    nativeWebSearchPreferred,
    baseUrl: secrets.CODEX_BASE_URL,
  }).reason;
  if (
    compatibilityState?.mode !== 'chat_completions' ||
    compatibilityState?.reason !== reason
  ) {
    saveCodexCompatibilityState('chat_completions', reason);
  }
  log(`Codex compatibility mode active (${reason}), using chat/completions history`);
  return runCodexChatCompletionsQuery(
    prompt,
    secrets,
    cwd,
    agentInput,
    onStreamChunk,
    new CodexTurnEventEmitter(agentInput.preferredTurnId),
    options,
  );
}

// ────────────────────────────────────────────────
// main()
// ────────────────────────────────────────────────

async function main(): Promise<void> {
  let agentInput: AgentRunInput;

  try {
    const stdinData = await readStdin();
    agentInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${agentInput.groupFolder}`);
  } catch (err) {
    const msg = `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`;
    log(`[CRASH] ${msg}`);
    writeOutput({
      status: 'error',
      result: null,
      error: msg,
      errorDetails: { category: 'parse-error' },
    });
    process.exit(1);
  }

  const secrets = agentInput.secrets || {};
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }

  const provider = secrets.AI_PROVIDER || 'claude';
  log(`AI Provider: ${provider}`);

  if (provider === 'codex') {
    log(`Codex config: BASE_URL=${secrets.CODEX_BASE_URL}, MODEL=${secrets.CODEX_MODEL}, HAS_KEY=${secrets.CODEX_API_KEY ? 'yes' : 'no'}`);
    await mainCodex(agentInput, secrets);
  } else {
    const sdkEnv: Record<string, string | undefined> = { ...process.env };
    log(`API config: BASE_URL=${process.env.ANTHROPIC_BASE_URL || '(default)'}, MODEL=${process.env.ANTHROPIC_MODEL || '(default)'}, AUTH_TOKEN=${process.env.ANTHROPIC_AUTH_TOKEN ? '***' + process.env.ANTHROPIC_AUTH_TOKEN.slice(-4) : '(none)'}, secrets_count=${Object.keys(secrets).length}`);
    await mainClaude(agentInput, sdkEnv);
  }
}

/**
 * Codex mode: direct API calls via fetch, simple chat loop.
 */
async function mainCodex(agentInput: AgentRunInput, secrets: Record<string, string>): Promise<void> {
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  const isEphemeralScheduledTask = agentInput.isScheduledTask && !agentInput.sessionId;
  let prompt: AgentPromptInput = agentInput.prompt;
  if (agentInput.isScheduledTask && !agentInput.suppressScheduledTaskPreamble) {
    prompt = buildScheduledTaskPrompt(normalizePromptPayload(prompt));
  }
  if (!agentInput.isScheduledTask) {
    const pending = drainIpcInput();
    if (pending.length > 0) prompt = mergePromptInputs([prompt, ...pending]);
  }

  const projectDir = resolveAgentWorkingDirectory(agentInput);
  let previousResponseId = agentInput.sessionId;
  let activeRequestId = agentInput.requestId;

  try {
    while (true) {
      log(`Codex query (${getPromptTextLength(prompt)} chars)...`);

      const turn = await runCodexTurn(
        prompt,
        previousResponseId,
        secrets,
        projectDir,
        agentInput,
        async (chunk) => {
          writeOutput({
            status: 'success',
            result: null,
            requestId: activeRequestId,
            streamChunk: chunk,
          });
        },
        { historyScope: isEphemeralScheduledTask ? 'ephemeral' : 'shared' },
      );
      const result = turn.result;
      previousResponseId = isEphemeralScheduledTask
        ? undefined
        : turn.responseId || previousResponseId;
      log(`Codex result: ${result.slice(0, 200)}`);

      writeOutput({
        status: 'success',
        result,
        requestId: activeRequestId,
        newSessionId: previousResponseId,
      });

      if (shouldClose()) { log('Close sentinel, exiting'); break; }

      if (isEphemeralScheduledTask) {
        log('Ephemeral scheduled task completed, exiting');
        break;
      }

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) { log('Close sentinel, exiting'); break; }

      log(`Got new message (${getPromptTextLength(nextMessage)} chars)`);
      prompt = nextMessage;
      activeRequestId = shiftNextIpcRequestId();
      if (activeRequestId) {
        const messageText = getPromptText(nextMessage);
        const requestKind = /^\s*\[STEER\]/i.test(messageText)
          ? 'steer'
          : 'message';
        writeOutput({
          status: 'accepted',
          result: null,
          requestId: activeRequestId,
          requestKind,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[API-ERROR] Codex error: ${msg}`);
    const details: AgentErrorDetails = { category: 'api-error', provider: 'codex' };
    if (err instanceof CodexApiError) {
      details.apiStatus = err.status;
      details.apiBody = msg.slice(0, 500);
    }
    writeOutput({
      status: 'error',
      result: null,
      requestId: activeRequestId,
      error: msg,
      retryable: isRetryableCodexError(err),
      errorDetails: details,
    });
    process.exit(1);
  }
}

/**
 * Claude mode: full agent via claude-agent-sdk.
 */
async function mainClaude(agentInput: AgentRunInput, sdkEnv: Record<string, string | undefined>): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const isEphemeralScheduledTask = agentInput.isScheduledTask && !agentInput.sessionId;
  let sessionId = agentInput.sessionId;
  let activeRequestId = agentInput.requestId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt: AgentPromptInput = agentInput.prompt;
  if (agentInput.isScheduledTask && !agentInput.suppressScheduledTaskPreamble) {
    prompt = buildScheduledTaskPrompt(normalizePromptPayload(prompt));
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt = mergePromptInputs([prompt, ...pending]);
  }

  let resumeAt: string | undefined;
  const deferredMessages: AgentPromptInput[] = [];
  let bridgeContextForNextTurn = '';
  try {
    while (true) {
      const promptForTurn = bridgeContextForNextTurn
        ? prependTextToPromptInput(prompt, bridgeContextForNextTurn)
        : prompt;
      bridgeContextForNextTurn = '';

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      if (hasUploadedFiles(promptForTurn)) {
        const result = await runClaudeUploadedFilesQuery(
          promptForTurn,
          agentInput.secrets || {},
          agentInput.preferredTurnId,
          async (chunk) => {
            writeOutput({
              status: 'success',
              result: null,
              requestId: activeRequestId,
              streamChunk: chunk,
            });
          },
        );
        bridgeContextForNextTurn = buildDirectUploadBridgeContext(
          promptForTurn,
          result,
        );
        writeOutput({
          status: 'success',
          result,
          requestId: activeRequestId,
          newSessionId: sessionId,
        });
      } else {
        const queryResult = await runQuery(
          promptForTurn,
          sessionId,
          mcpServerPath,
          agentInput,
          sdkEnv,
          activeRequestId,
          resumeAt,
        );
        if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
        if (queryResult.lastAssistantUuid) resumeAt = queryResult.lastAssistantUuid;
        if (queryResult.deferredMessages.length > 0) {
          deferredMessages.push(...queryResult.deferredMessages);
        }

        if (queryResult.closedDuringQuery) {
          log('Close sentinel consumed during query, exiting');
          break;
        }

        writeOutput({
          status: 'success',
          result: null,
          requestId: activeRequestId,
          newSessionId: sessionId,
        });
      }

      if (deferredMessages.length > 0) {
        prompt = deferredMessages.shift()!;
        activeRequestId = shiftNextIpcRequestId();
        log(`Starting deferred upload-bearing message (${getPromptTextLength(prompt)} chars)`);
        continue;
      }

      if (isEphemeralScheduledTask) {
        log('Ephemeral scheduled task completed, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) { log('Close sentinel received, exiting'); break; }

      log(`Got new message (${getPromptTextLength(nextMessage)} chars), starting new query`);
      prompt = nextMessage;
      activeRequestId = shiftNextIpcRequestId();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const category = /timeout|ETIMEDOUT/i.test(errorMessage) ? 'timeout' as const : 'crash' as const;
    log(`[${category === 'timeout' ? 'TIMEOUT' : 'CRASH'}] Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      requestId: activeRequestId,
      newSessionId: sessionId,
      error: errorMessage,
      errorDetails: { category, provider: 'claude' },
    });
    process.exit(1);
  }
}

main();
