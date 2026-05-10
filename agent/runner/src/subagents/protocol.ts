export type SubagentRuntimeStatus =
  | 'spawning'
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped';

export type PersistedSubagentMode = 'agent' | 'team';
export type PersistedSubagentProvider = 'claude' | 'codex';
export type PersistedSubagentRuntimeKind =
  | 'managed_run'
  | 'managed_session'
  | 'ephemeral_snapshot';
export type PersistedSubagentRole = 'main' | 'orchestrator' | 'leaf';
export type PersistedSubagentWorkProfile = 'explorer' | 'worker';
export type PersistedSubagentControlScope = 'children' | 'none';
export type PersistedSubagentRequestKind = 'message' | 'steer';
export type PersistedSubagentRequestState =
  | 'accepted'
  | 'completed'
  | 'failed';

export interface PersistedSubagentRuntimeRecord {
  id: string;
  provider: PersistedSubagentProvider;
  mode: PersistedSubagentMode;
  runtimeKind?: PersistedSubagentRuntimeKind;
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: PersistedSubagentRole;
  workProfile?: PersistedSubagentWorkProfile;
  // Deprecated compatibility alias for topologyRole.
  role?: PersistedSubagentRole;
  controlScope?: PersistedSubagentControlScope;
  groupFolder: string;
  chatJid: string;
  name: string;
  task: string;
  status: SubagentRuntimeStatus;
  depth: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pid?: number;
  activeRequestId?: string;
  requestCount?: number;
  stopRequestedAt?: string;
  stoppedAt?: string;
  lastAcceptedRequestId?: string;
  lastAcceptedRequestAt?: string;
  lastAcceptedRequestKind?: PersistedSubagentRequestKind;
  lastCompletedRequestId?: string;
  lastCompletedRequestAt?: string;
  lastCompletedRequestKind?: PersistedSubagentRequestKind;
  lastCompletedRequestState?: PersistedSubagentRequestState;
  exitCode?: number | null;
  lastError?: string;
  lastResultPreview?: string;
}

export interface SubagentMessageRequest {
  type: 'message';
  requestId: string;
  prompt: string;
  createdAt: string;
}

export interface SubagentCloseRequest {
  type: 'close';
  requestId: string;
  reason?: string;
  createdAt: string;
}

export type SubagentIpcRequest = SubagentMessageRequest | SubagentCloseRequest;

export interface AgentRunOutputPayload {
  status?: 'accepted' | 'success' | 'error';
  requestId?: string;
  requestKind?: PersistedSubagentRequestKind;
  result?: string | null;
  error?: string;
}

export function createSubagentRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
