import type { AssistantRuleMode } from '../assistant/assistant-config.js';
import type { AccessMode } from '../auth/access-policy.js';
import type { AgentPromptInput } from '../types/agent.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
export const MEMORY_ENV_KEYS = [
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_MODE',
  'MEMORY_GLOBAL_WRITE_ENABLED',
  'MEMORY_AUTO_SAVE_ENABLED',
  'MEMORY_SEARCH_SCOPE_DEFAULT',
  'MEMORY_SEARCH_MAX_RESULTS',
  'MEMORY_PROMPT_INJECTION_ENABLED',
  'MEMORY_PROMPT_MAX_SNIPPETS',
  'MEMORY_COMPACTION_ENABLED',
  'MEMORY_COMPACTION_TRIGGER_ENTRIES',
  'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
] as const;

export interface AgentRunInput {
  prompt: AgentPromptInput;
  sessionId?: string;
  preferredTurnId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  systemPromptProfile?: 'default_agent' | 'scheduled_lightweight';
  /**
   * When true, skip the agent runner's default global system prompt assembly.
   * Use this for flows that already provide a fully-scoped request prompt and
   * must not inherit generic coding-assistant guidance.
   */
  suppressDefaultSystemPrompt?: boolean;
  /**
   * Set true to get the ephemeral / no-IPC-drain session semantics of a
   * scheduled task **without** getting the "[SYSTEM DISPATCH] ..." prompt
   * preamble. The preamble primes the model for short reminder-style replies
   * and confuses flows whose payload is a structured task (e.g. repo review).
   */
  suppressScheduledTaskPreamble?: boolean;
  disableDefaultWebSearch?: boolean;
  toolPolicy?: 'none' | 'readonly' | 'full';
  assistantName?: string;
  secrets?: Record<string, string>;
  runtimeNamespace?: string;
  managedSkillIds?: string[];
  managedMcpServerIds?: string[];
  userSkillIds?: string[];
  userMcpServerIds?: string[];
  managedKbIds?: string[];
  resolvedManagedMcpServers?: Array<{
    id: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
  providerOverrideId?: string;
  modelOverride?: string;
  soulSystemPrompt?: string;
  instructionsAppend?: string;
  assistantRuleMode?: AssistantRuleMode;
  accessModeOverride?: AccessMode;
  projectRootOverride?: string;
  restrictProjectRootInheritance?: boolean;
  workspaceExtraDirectories?: string[];
  allowedDirectoriesOverride?: string[];
  extraMounts?: Array<{
    hostPath: string;
    targetPath: string;
    readonly?: boolean;
  }>;
  workingDirectory?: string;
  userId?: string;
}

export interface AgentEventPayload {
  id: string;
  kind: 'status' | 'tool' | 'reasoning';
  status: 'in_progress' | 'completed' | 'failed';
  title: string;
  body?: string;
  timestamp: string;
}

export type AgentTurnItemStatus = 'in_progress' | 'completed' | 'failed';

export interface AgentSubagentInfo {
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

export interface AgentReasoningItemPayload {
  id: string;
  type: 'reasoning';
  status: AgentTurnItemStatus;
  title: string;
  text?: string;
  timestamp: string;
}

export interface AgentToolCallItemPayload {
  id: string;
  type: 'tool_call';
  status: AgentTurnItemStatus;
  title: string;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
  subagentInfo?: AgentSubagentInfo;
  startedAt?: string;
  completedAt?: string;
  timestamp: string;
}

export interface AgentAssistantMessageItemPayload {
  id: string;
  type: 'assistant_message';
  status: Extract<AgentTurnItemStatus, 'in_progress' | 'completed'>;
  text: string;
  timestamp: string;
}

export interface AgentApprovalRequestPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AgentApprovalResolvedPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  decision: 'allow-once' | 'deny' | 'expired';
  resolvedAt: string;
}

export interface AgentAskRequestPayload {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allow_multiple?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AgentAskResolvedPayload {
  id: string;
  answer: string;
  answered_by: string;
  resolvedAt: string;
}

export type AgentTurnItemPayload =
  | AgentReasoningItemPayload
  | AgentToolCallItemPayload
  | AgentAssistantMessageItemPayload;

export type AgentTurnEventPayload =
  | { type: 'turn.started'; turnId: string; timestamp: string }
  | {
      type: 'item.started';
      turnId: string;
      item: AgentTurnItemPayload;
      timestamp: string;
    }
  | {
      type: 'item.updated';
      turnId: string;
      item: AgentTurnItemPayload;
      timestamp: string;
    }
  | {
      type: 'item.completed';
      turnId: string;
      item: AgentTurnItemPayload;
      timestamp: string;
    }
  | { type: 'turn.completed'; turnId: string; timestamp: string }
  | { type: 'turn.failed'; turnId: string; error: string; timestamp: string };

export interface AgentErrorDetails {
  category?: 'api-error' | 'timeout' | 'crash' | 'parse-error' | 'spawn-error';
  apiStatus?: number;
  apiBody?: string;
  retryAttempts?: number;
  provider?: string;
}

export interface AgentRunOutput {
  status: 'success' | 'error';
  result: string | null;
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
