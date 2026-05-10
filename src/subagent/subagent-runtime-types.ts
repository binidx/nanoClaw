export const SUBAGENT_DIR_NAME = '.nanoclaw-subagents';
export const RUNTIME_FILE_NAME = 'runtime.json';
export const HISTORY_FILE_NAME = 'history.json';
export const IPC_DIR_NAME = 'ipc';
export const IPC_INPUT_DIR_NAME = 'input';
export const CLOSE_SENTINEL_FILE_NAME = '_close';
export const GROUPS_DIR_OVERRIDE_ENV = 'NANOCLAW_GROUPS_DIR_OVERRIDE';
export const RUN_REGISTRY_PATH_OVERRIDE_ENV =
  'NANOCLAW_SUBAGENT_RUN_REGISTRY_PATH_OVERRIDE';
export const REQUEST_POLL_MS = 150;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type SubagentRuntimeStatus =
  | 'spawning'
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped';

export type SubagentRuntimeProvider = 'claude' | 'codex';
export type SubagentRuntimeKind =
  | 'managed_run'
  | 'managed_session'
  | 'ephemeral_snapshot';
export type SubagentRuntimeRole = 'main' | 'orchestrator' | 'leaf';
export type SubagentRuntimeWorkProfile = 'explorer' | 'worker';
export type SubagentRuntimeControlScope = 'children' | 'none';
export type SubagentRuntimeSource = 'runtime' | 'history';
export type SubagentRuntimeControlState = 'controllable' | 'read_only';
export type SubagentRuntimeControlReason =
  | 'active_runtime'
  | 'inactive_runtime'
  | 'history_only'
  | 'legacy_active_runtime'
  | 'provider_read_only_runtime';
export type SubagentRuntimeRequestKind = 'message' | 'steer';
export type SubagentRuntimeRequestState =
  | 'accepted'
  | 'completed'
  | 'failed';

export interface SubagentRuntimeCapabilities {
  canStop: boolean;
  canMessage: boolean;
  canSteer: boolean;
  canSpawnChildren: boolean;
  canResumeAfterRestart: boolean;
}

export interface SubagentRuntimeEntry {
  id: string;
  provider: SubagentRuntimeProvider;
  mode: 'agent' | 'team';
  runtimeKind?: SubagentRuntimeKind;
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: SubagentRuntimeRole;
  workProfile?: SubagentRuntimeWorkProfile;
  role?: SubagentRuntimeRole;
  controlScope?: SubagentRuntimeControlScope;
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
  lastAcceptedRequestKind?: SubagentRuntimeRequestKind;
  lastCompletedRequestId?: string;
  lastCompletedRequestAt?: string;
  lastCompletedRequestKind?: SubagentRuntimeRequestKind;
  lastCompletedRequestState?: SubagentRuntimeRequestState;
  exitCode?: number | null;
  lastError?: string;
  lastResultPreview?: string;
  controllable?: boolean;
  source?: SubagentRuntimeSource;
  controlState?: SubagentRuntimeControlState;
  controlReason?: SubagentRuntimeControlReason;
  capabilities?: SubagentRuntimeCapabilities;
  childRuntimeIds?: string[];
  childCount?: number;
  descendantCount?: number;
  activeDescendantCount?: number;
}

export interface SubagentRuntimeSnapshot {
  activeCount: number;
  recentCount: number;
  items: SubagentRuntimeEntry[];
  nextCursor?: string;
}

export interface SubagentRuntimeTreeNode {
  entry: SubagentRuntimeEntry;
  children: SubagentRuntimeTreeNode[];
}

export interface SubagentRuntimeTreeSnapshot extends SubagentRuntimeSnapshot {
  roots: SubagentRuntimeTreeNode[];
}

export interface SubagentRuntimeDetail {
  entry: SubagentRuntimeEntry;
  parent: SubagentRuntimeEntry | null;
  children: SubagentRuntimeEntry[];
  descendants: SubagentRuntimeEntry[];
  controls: SubagentRuntimeCapabilities;
}

export interface SubagentRuntimeStopResult {
  ok: boolean;
  status:
    | 'stop_requested'
    | 'already_stopped'
    | 'not_found'
    | 'not_controllable';
  entry?: SubagentRuntimeEntry;
}

export interface SubagentRuntimeCommandResult {
  ok: boolean;
  status:
    | 'accepted'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'busy'
    | 'not_found'
    | 'not_controllable';
  requestId?: string;
  entry?: SubagentRuntimeEntry;
  result?: string | null;
  error?: string;
}

export interface SubagentRuntimeBatchStopResult {
  matchedIds: string[];
  stopRequestedIds: string[];
  alreadyStoppedIds: string[];
  notControllableIds: string[];
}

export interface SubagentRuntimeRecoverySummary {
  recovered: number;
  failed: number;
  stopped: number;
  removedRuntimeDirs: number;
}

export interface SubagentRunRecord {
  runId: string;
  runtimeId: string;
  provider: SubagentRuntimeProvider;
  mode: 'agent' | 'team';
  runtimeKind?: SubagentRuntimeKind;
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: SubagentRuntimeRole;
  workProfile?: SubagentRuntimeWorkProfile;
  role?: SubagentRuntimeRole;
  controlScope?: SubagentRuntimeControlScope;
  groupFolder: string;
  chatJid: string;
  name: string;
  task: string;
  status: SubagentRuntimeStatus;
  depth: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  stopRequestedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  requestCount?: number;
  lastAcceptedRequestId?: string;
  lastAcceptedRequestAt?: string;
  lastAcceptedRequestKind?: SubagentRuntimeRequestKind;
  lastCompletedRequestId?: string;
  lastCompletedRequestAt?: string;
  lastCompletedRequestKind?: SubagentRuntimeRequestKind;
  lastCompletedRequestState?: SubagentRuntimeRequestState;
  lastError?: string;
  lastResultPreview?: string;
  source?: SubagentRuntimeSource;
  controlState?: SubagentRuntimeControlState;
  controlReason?: SubagentRuntimeControlReason;
  childRuntimeIds?: string[];
  childCount?: number;
  descendantCount?: number;
  activeDescendantCount?: number;
}

export interface SubagentRunRegistrySnapshot {
  generatedAt: string;
  total: number;
  activeCount: number;
  runs: SubagentRunRecord[];
}

export interface SubagentRunSnapshot {
  generatedAt: string;
  activeCount: number;
  recentCount: number;
  items: SubagentRunRecord[];
  nextCursor?: string;
}

export interface SubagentRunTreeNode {
  entry: SubagentRunRecord;
  children: SubagentRunTreeNode[];
}

export interface SubagentRunTreeSnapshot extends SubagentRunSnapshot {
  roots: SubagentRunTreeNode[];
}

export interface SubagentRuntimeRequestOptions {
  waitForResponse?: boolean;
  timeoutMs?: number;
}

export interface SubagentRuntimeListQuery {
  provider?: string;
  groupFolder?: string;
  chatJid?: string;
  status?: SubagentRuntimeStatus | SubagentRuntimeStatus[];
  activeOnly?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SubagentRunListQuery extends SubagentRuntimeListQuery {
  runtimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  parentRuntimeId?: string;
  originTurnId?: string;
  originToolCallId?: string;
  descendantOf?: string;
}

export interface SubagentRuntimeBatchStopQuery {
  provider?: SubagentRuntimeProvider;
  groupFolder?: string;
  chatJid?: string;
  originTurnId?: string;
  parentRuntimeId?: string;
  modes?: Array<'agent' | 'team'>;
}

export interface IndexedSubagentRuntimeRecord {
  entry: SubagentRuntimeEntry;
  runtimeDir?: string;
}

export function isActiveStatus(status: SubagentRuntimeStatus): boolean {
  return (
    status === 'spawning' ||
    status === 'idle' ||
    status === 'running' ||
    status === 'stopping'
  );
}

export function isSupportedProvider(
  value: string | undefined,
): value is SubagentRuntimeProvider {
  return value === 'claude' || value === 'codex';
}

export function isSupportedRuntimeKind(
  value: string | undefined,
): value is SubagentRuntimeKind {
  return (
    value === 'managed_run' ||
    value === 'managed_session' ||
    value === 'ephemeral_snapshot'
  );
}

export function isSupportedRole(
  value: string | undefined,
): value is SubagentRuntimeRole {
  return value === 'main' || value === 'orchestrator' || value === 'leaf';
}

export function isSupportedWorkProfile(
  value: string | undefined,
): value is SubagentRuntimeWorkProfile {
  return value === 'explorer' || value === 'worker';
}

export function isSupportedControlScope(
  value: string | undefined,
): value is SubagentRuntimeControlScope {
  return value === 'children' || value === 'none';
}

export function isSupportedRequestKind(
  value: string | undefined,
): value is SubagentRuntimeRequestKind {
  return value === 'message' || value === 'steer';
}

export function isSupportedRequestState(
  value: string | undefined,
): value is SubagentRuntimeRequestState {
  return value === 'accepted' || value === 'completed' || value === 'failed';
}

export function buildCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString(
    'base64url',
  );
}

export function parseCursor(
  cursor: string | undefined,
): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { updatedAt?: unknown; id?: unknown };
    return typeof payload.updatedAt === 'string' &&
      typeof payload.id === 'string'
      ? {
          updatedAt: payload.updatedAt,
          id: payload.id,
        }
      : null;
  } catch {
    return null;
  }
}

export function compareEntries(
  left: Pick<SubagentRuntimeEntry, 'updatedAt' | 'id'>,
  right: Pick<SubagentRuntimeEntry, 'updatedAt' | 'id'>,
): number {
  const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtOrder !== 0) return updatedAtOrder;
  return right.id.localeCompare(left.id);
}

export function compareRunRecords(
  left: Pick<SubagentRunRecord, 'updatedAt' | 'runtimeId'>,
  right: Pick<SubagentRunRecord, 'updatedAt' | 'runtimeId'>,
): number {
  const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtOrder !== 0) return updatedAtOrder;
  return right.runtimeId.localeCompare(left.runtimeId);
}

export function isAfterCursor(
  entry: Pick<SubagentRuntimeEntry, 'updatedAt' | 'id'>,
  cursor: { updatedAt: string; id: string } | null,
): boolean {
  if (!cursor) return true;
  return compareEntries(entry, cursor) > 0;
}

export function isRunAfterCursor(
  entry: Pick<SubagentRunRecord, 'updatedAt' | 'runtimeId'>,
  cursor: { updatedAt: string; id: string } | null,
): boolean {
  if (!cursor) return true;
  return compareRunRecords(entry, {
    updatedAt: cursor.updatedAt,
    runtimeId: cursor.id,
  }) > 0;
}

// Late-bound registry accessor — breaks the circular dependency
// between registry.ts ↔ control.ts. Registry sets this at module
// init; control.ts reads it at call-time.
export interface RegistryLookup {
  findIndexedRuntimeById(id: string): IndexedSubagentRuntimeRecord | null;
  getSubagentRuntime(id: string): SubagentRuntimeEntry | null;
  loadRunRegistrySnapshot(): SubagentRunRegistrySnapshot;
}

let _registryLookup: RegistryLookup | null = null;

export function _setRegistryLookup(lookup: RegistryLookup): void {
  _registryLookup = lookup;
}

export function _getRegistryLookup(): RegistryLookup {
  if (!_registryLookup) {
    throw new Error(
      'Subagent registry lookup not initialized — import subagent-runtime-registry.js first',
    );
  }
  return _registryLookup;
}
