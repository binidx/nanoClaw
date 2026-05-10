import fs from 'fs';
import path from 'path';

import {
  HISTORY_FILE_NAME,
  RUNTIME_FILE_NAME,
  SUBAGENT_DIR_NAME,
  type IndexedSubagentRuntimeRecord,
  type SubagentRunRecord,
  type SubagentRunRegistrySnapshot,
  type SubagentRunSnapshot,
  type SubagentRunTreeNode,
  type SubagentRunTreeSnapshot,
  type SubagentRunListQuery,
  type SubagentRuntimeDetail,
  type SubagentRuntimeCapabilities,
  type SubagentRuntimeControlReason,
  type SubagentRuntimeControlState,
  type SubagentRuntimeEntry,
  type SubagentRuntimeListQuery,
  type SubagentRuntimeProvider,
  type SubagentRuntimeSnapshot,
  type SubagentRuntimeSource,
  type SubagentRuntimeTreeNode,
  type SubagentRuntimeTreeSnapshot,
  buildCursor,
  compareEntries,
  compareRunRecords,
  isActiveStatus,
  isAfterCursor,
  isRunAfterCursor,
  isSupportedProvider,
  parseCursor,
} from './subagent-runtime-types.js';
import {
  getRunRegistryPath,
  parseRuntimeEntry,
  readRuntimeEntry,
  readRuntimeHistory,
  writeJsonFile,
  getRuntimeRegistryGroupsDir,
} from './subagent-runtime-fs.js';
import { isOrphanMarkedActiveSubagentRuntime } from './subagent-runtime-recovery.js';

const ephemeralRuntimeEntries = new Map<string, IndexedSubagentRuntimeRecord>();
let lastPersistedRunRegistrySignature = '';

function buildCapabilities(
  entry: SubagentRuntimeEntry,
  controlState: SubagentRuntimeControlState,
): SubagentRuntimeCapabilities {
  const active = isActiveStatus(entry.status);
  const topologyRole = entry.topologyRole || entry.role;
  const canStop = controlState === 'controllable' && active;
  const canSpawnChildren =
    entry.provider === 'codex' &&
    active &&
    entry.controlScope !== 'none' &&
    topologyRole !== 'leaf';
  const canMessage =
    canStop && entry.mode === 'team' && entry.provider === 'codex';
  const canSteer = canMessage && canSpawnChildren;
  return {
    canStop,
    canMessage,
    canSteer,
    canSpawnChildren,
    canResumeAfterRestart: false,
  };
}

function withEntryMetadata(
  entry: SubagentRuntimeEntry,
  source: SubagentRuntimeSource,
  runtimeDir?: string,
): IndexedSubagentRuntimeRecord {
  const active = isActiveStatus(entry.status);
  const fromLiveRuntime = source === 'runtime' && typeof runtimeDir === 'string';
  const isOrphanedActiveRuntime = isOrphanMarkedActiveSubagentRuntime(entry.id);
  const controlState: SubagentRuntimeControlState =
    fromLiveRuntime &&
    active &&
    entry.provider === 'codex' &&
    !isOrphanedActiveRuntime
      ? 'controllable'
      : 'read_only';
  const controlReason: SubagentRuntimeControlReason =
    fromLiveRuntime
      ? active
        ? isOrphanedActiveRuntime
          ? 'legacy_active_runtime'
          : controlState === 'controllable'
            ? 'active_runtime'
            : 'provider_read_only_runtime'
        : 'inactive_runtime'
      : active
        ? 'legacy_active_runtime'
        : 'history_only';
  const normalizedEntry: SubagentRuntimeEntry = {
    ...entry,
    runtimeKind:
      entry.runtimeKind ||
      (entry.provider === 'claude'
        ? 'ephemeral_snapshot'
        : entry.mode === 'team'
          ? 'managed_session'
          : 'managed_run'),
    providerSessionId: entry.providerSessionId || entry.id,
    controllable: controlState === 'controllable',
    source,
    controlState,
    controlReason,
  };
  normalizedEntry.capabilities = buildCapabilities(
    normalizedEntry,
    controlState,
  );
  return { runtimeDir, entry: normalizedEntry };
}

function buildRunRecord(entry: SubagentRuntimeEntry): SubagentRunRecord {
  return {
    runId: entry.id,
    runtimeId: entry.id,
    provider: entry.provider,
    mode: entry.mode,
    runtimeKind: entry.runtimeKind,
    providerSessionId: entry.providerSessionId,
    parentRuntimeId: entry.parentRuntimeId,
    controllerSessionKey: entry.controllerSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    originTurnId: entry.originTurnId,
    originToolCallId: entry.originToolCallId,
    topologyRole: entry.topologyRole || entry.role,
    workProfile: entry.workProfile,
    role: entry.role,
    controlScope: entry.controlScope,
    groupFolder: entry.groupFolder,
    chatJid: entry.chatJid,
    name: entry.name,
    task: entry.task,
    status: entry.status,
    depth: entry.depth,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
    stopRequestedAt: entry.stopRequestedAt,
    stoppedAt: entry.stoppedAt,
    exitCode: entry.exitCode,
    requestCount: entry.requestCount,
    lastAcceptedRequestId: entry.lastAcceptedRequestId,
    lastAcceptedRequestAt: entry.lastAcceptedRequestAt,
    lastAcceptedRequestKind: entry.lastAcceptedRequestKind,
    lastCompletedRequestId: entry.lastCompletedRequestId,
    lastCompletedRequestAt: entry.lastCompletedRequestAt,
    lastCompletedRequestKind: entry.lastCompletedRequestKind,
    lastCompletedRequestState: entry.lastCompletedRequestState,
    lastError: entry.lastError,
    lastResultPreview: entry.lastResultPreview,
    source: entry.source,
    controlState: entry.controlState,
    controlReason: entry.controlReason,
    childRuntimeIds: entry.childRuntimeIds,
    childCount: entry.childCount,
    descendantCount: entry.descendantCount,
    activeDescendantCount: entry.activeDescendantCount,
  };
}

function persistRunRegistrySnapshot(
  itemsById: Map<string, IndexedSubagentRuntimeRecord>,
): void {
  const snapshot = buildRunRegistrySnapshot(
    [...itemsById.values()].map((record) => buildRunRecord(record.entry)),
  );
  const signature = JSON.stringify({
    total: snapshot.total,
    activeCount: snapshot.activeCount,
    runs: snapshot.runs,
  });
  if (signature === lastPersistedRunRegistrySignature) {
    return;
  }
  writeJsonFile(getRunRegistryPath(), snapshot);
  lastPersistedRunRegistrySignature = signature;
}

function buildRunRegistrySnapshot(
  runs: SubagentRunRecord[],
  generatedAt = new Date().toISOString(),
): SubagentRunRegistrySnapshot {
  const sortedRuns = [...runs].sort(compareRunRecords);
  return {
    generatedAt,
    total: sortedRuns.length,
    activeCount: sortedRuns.filter((run) => isActiveStatus(run.status)).length,
    runs: sortedRuns,
  };
}

function getCurrentRunRegistrySnapshot(): SubagentRunRegistrySnapshot {
  const index = scanSubagentRuntimeIndex();
  return buildRunRegistrySnapshot(
    [...index.values()].map((record) => buildRunRecord(record.entry)),
  );
}

function readPersistedRunRegistrySnapshot():
  | SubagentRunRegistrySnapshot
  | null {
  const filePath = getRunRegistryPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const payload = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<SubagentRunRegistrySnapshot> | null;
    if (!payload || !Array.isArray(payload.runs)) return null;
    const runs = payload.runs
      .map((entry) =>
        parseRuntimeEntry({
          ...(entry as unknown as Partial<SubagentRuntimeEntry>),
          id:
            typeof (entry as { runtimeId?: unknown }).runtimeId === 'string'
              ? ((entry as { runtimeId: string }).runtimeId as string)
              : typeof (entry as { runId?: unknown }).runId === 'string'
                ? ((entry as { runId: string }).runId as string)
                : '',
        }),
      )
      .filter((item): item is SubagentRuntimeEntry => item !== null)
      .map((item) => buildRunRecord(item));
    return {
      generatedAt:
        typeof payload.generatedAt === 'string'
          ? payload.generatedAt
          : new Date().toISOString(),
      total: runs.length,
      activeCount: runs.filter((run) => isActiveStatus(run.status)).length,
      runs,
    };
  } catch {
    return null;
  }
}

function upsertIndexedEntry(
  itemsById: Map<string, IndexedSubagentRuntimeRecord>,
  record: IndexedSubagentRuntimeRecord,
): void {
  const existing = itemsById.get(record.entry.id) || null;
  itemsById.set(record.entry.id, keepNewerEntry(existing, record));
}

function buildEphemeralRuntimeRecord(
  entry: SubagentRuntimeEntry,
): IndexedSubagentRuntimeRecord {
  const nextEntry: SubagentRuntimeEntry = {
    ...entry,
    runtimeKind: entry.runtimeKind || 'ephemeral_snapshot',
    providerSessionId: entry.providerSessionId || entry.id,
    controllable: false,
    source: 'runtime',
    controlState: 'read_only',
    controlReason: 'provider_read_only_runtime',
  };
  nextEntry.capabilities = buildCapabilities(nextEntry, 'read_only');
  return { entry: nextEntry };
}

function keepNewerEntry(
  current: IndexedSubagentRuntimeRecord | null,
  candidate: IndexedSubagentRuntimeRecord,
): IndexedSubagentRuntimeRecord {
  if (!current) return candidate;
  const updatedAtOrder = candidate.entry.updatedAt.localeCompare(
    current.entry.updatedAt,
  );
  if (updatedAtOrder > 0) return candidate;
  if (updatedAtOrder < 0) return current;
  if (
    candidate.entry.source === 'runtime' &&
    current.entry.source !== 'runtime'
  ) {
    return candidate;
  }
  return current;
}

function applyRelationMetadata(
  itemsById: Map<string, IndexedSubagentRuntimeRecord>,
): Map<string, IndexedSubagentRuntimeRecord> {
  const childMap = new Map<string, string[]>();
  for (const [id, record] of itemsById) {
    const parentId = record.entry.parentRuntimeId?.trim();
    if (!parentId) continue;
    const children = childMap.get(parentId) || [];
    children.push(id);
    childMap.set(parentId, children);
  }

  const countDescendants = (
    runtimeId: string,
  ): { total: number; active: number } => {
    const children = childMap.get(runtimeId) || [];
    let total = children.length;
    let active = 0;
    for (const childId of children) {
      const childRecord = itemsById.get(childId);
      if (childRecord && isActiveStatus(childRecord.entry.status)) {
        active += 1;
      }
      const nested = countDescendants(childId);
      total += nested.total;
      active += nested.active;
    }
    return { total, active };
  };

  for (const [id, record] of itemsById) {
    const children = childMap.get(id) || [];
    const nested = countDescendants(id);
    record.entry.childRuntimeIds = [...children];
    record.entry.childCount = children.length;
    record.entry.descendantCount = nested.total;
    record.entry.activeDescendantCount = nested.active;
  }
  return itemsById;
}

function scanSubagentRuntimeIndex(): Map<string, IndexedSubagentRuntimeRecord> {
  const itemsById = new Map<string, IndexedSubagentRuntimeRecord>();
  const groupsDir = getRuntimeRegistryGroupsDir();

  try {
    const groupEntries = fs.readdirSync(groupsDir, { withFileTypes: true });
    for (const groupEntry of groupEntries) {
      if (!groupEntry.isDirectory()) continue;
      const runtimeRoot = path.join(
        groupsDir,
        groupEntry.name,
        SUBAGENT_DIR_NAME,
      );
      if (!fs.existsSync(runtimeRoot)) continue;
      const historyFile = path.join(runtimeRoot, HISTORY_FILE_NAME);
      for (const historyEntry of readRuntimeHistory(historyFile)) {
        upsertIndexedEntry(itemsById, withEntryMetadata(historyEntry, 'history'));
      }
      const runtimeEntries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
      for (const runtimeEntry of runtimeEntries) {
        if (!runtimeEntry.isDirectory()) continue;
        const runtimeDir = path.join(runtimeRoot, runtimeEntry.name);
        const runtimeFile = path.join(runtimeDir, RUNTIME_FILE_NAME);
        const record = readRuntimeEntry(runtimeFile);
        if (record) {
          upsertIndexedEntry(
            itemsById,
            withEntryMetadata(record, 'runtime', runtimeDir),
          );
        }
      }
    }
  } catch {
    return new Map();
  }

  for (const record of ephemeralRuntimeEntries.values()) {
    upsertIndexedEntry(itemsById, record);
  }

  const index = applyRelationMetadata(itemsById);
  try {
    persistRunRegistrySnapshot(index);
  } catch {
    // ignore persistence failures
  }
  return index;
}

function normalizeListQuery(
  queryOrLimit?: number | SubagentRuntimeListQuery,
): Required<Pick<SubagentRuntimeListQuery, 'activeOnly' | 'limit'>> &
  Omit<SubagentRuntimeListQuery, 'activeOnly' | 'limit'> {
  const query =
    typeof queryOrLimit === 'number'
      ? { limit: queryOrLimit }
      : queryOrLimit || {};
  return {
    provider:
      typeof query.provider === 'string' ? query.provider.trim() : undefined,
    groupFolder:
      typeof query.groupFolder === 'string'
        ? query.groupFolder.trim()
        : undefined,
    chatJid: typeof query.chatJid === 'string' ? query.chatJid.trim() : undefined,
    status: query.status,
    activeOnly: query.activeOnly === true,
    limit: Number.isFinite(query.limit)
      ? Math.max(1, Math.trunc(query.limit as number))
      : 20,
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
  };
}

function normalizeRunListQuery(
  queryOrLimit?: number | SubagentRunListQuery,
): Required<Pick<SubagentRunListQuery, 'activeOnly' | 'limit'>> &
  Omit<SubagentRunListQuery, 'activeOnly' | 'limit'> {
  const query =
    typeof queryOrLimit === 'number'
      ? { limit: queryOrLimit }
      : queryOrLimit || {};
  return {
    provider:
      typeof query.provider === 'string' ? query.provider.trim() : undefined,
    groupFolder:
      typeof query.groupFolder === 'string'
        ? query.groupFolder.trim()
        : undefined,
    chatJid: typeof query.chatJid === 'string' ? query.chatJid.trim() : undefined,
    status: query.status,
    activeOnly: query.activeOnly === true,
    limit: Number.isFinite(query.limit)
      ? Math.max(1, Math.trunc(query.limit as number))
      : 20,
    cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    runtimeId:
      typeof query.runtimeId === 'string' ? query.runtimeId.trim() : undefined,
    controllerSessionKey:
      typeof query.controllerSessionKey === 'string'
        ? query.controllerSessionKey.trim()
        : undefined,
    requesterSessionKey:
      typeof query.requesterSessionKey === 'string'
        ? query.requesterSessionKey.trim()
        : undefined,
    parentRuntimeId:
      typeof query.parentRuntimeId === 'string'
        ? query.parentRuntimeId.trim()
        : undefined,
    originTurnId:
      typeof query.originTurnId === 'string'
        ? query.originTurnId.trim()
        : undefined,
    originToolCallId:
      typeof query.originToolCallId === 'string'
        ? query.originToolCallId.trim()
        : undefined,
    descendantOf:
      typeof query.descendantOf === 'string'
        ? query.descendantOf.trim()
        : undefined,
  };
}

function filterEntries(
  items: SubagentRuntimeEntry[],
  query: ReturnType<typeof normalizeListQuery>,
): SubagentRuntimeEntry[] {
  const statusSet = Array.isArray(query.status)
    ? new Set(query.status)
    : query.status
      ? new Set([query.status])
      : null;
  return items.filter((item) => {
    if (query.provider && item.provider !== query.provider) return false;
    if (query.groupFolder && item.groupFolder !== query.groupFolder) return false;
    if (query.chatJid && item.chatJid !== query.chatJid) return false;
    if (query.activeOnly && !isActiveStatus(item.status)) return false;
    if (statusSet && !statusSet.has(item.status)) return false;
    return true;
  });
}

function buildPagedSnapshot(
  items: SubagentRuntimeEntry[],
  query: ReturnType<typeof normalizeListQuery>,
): SubagentRuntimeSnapshot {
  const activeCount = items.filter((item) => isActiveStatus(item.status)).length;
  const cursor = parseCursor(query.cursor);
  const itemsAfterCursor = items.filter((item) => isAfterCursor(item, cursor));
  const pagedItems = itemsAfterCursor.slice(0, query.limit);
  const nextCursor =
    itemsAfterCursor.length > pagedItems.length &&
    pagedItems[pagedItems.length - 1]
      ? buildCursor(
          pagedItems[pagedItems.length - 1].updatedAt,
          pagedItems[pagedItems.length - 1].id,
        )
      : undefined;
  return {
    activeCount,
    recentCount: items.length,
    items: pagedItems,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function collectDescendantRuntimeIds(
  runs: SubagentRunRecord[],
  runtimeId: string,
): Set<string> {
  const targetId = runtimeId.trim();
  if (!targetId) return new Set();
  const childrenByParent = new Map<string, string[]>();
  for (const run of runs) {
    const parentId = run.parentRuntimeId?.trim();
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId) || [];
    siblings.push(run.runtimeId);
    childrenByParent.set(parentId, siblings);
  }
  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(targetId) || [])];
  while (pending.length > 0) {
    const nextId = pending.shift();
    if (!nextId || descendants.has(nextId)) continue;
    descendants.add(nextId);
    pending.push(...(childrenByParent.get(nextId) || []));
  }
  return descendants;
}

function filterRunRecords(
  items: SubagentRunRecord[],
  query: ReturnType<typeof normalizeRunListQuery>,
): SubagentRunRecord[] {
  const statusSet = Array.isArray(query.status)
    ? new Set(query.status)
    : query.status
      ? new Set([query.status])
      : null;
  const descendantIds = query.descendantOf
    ? collectDescendantRuntimeIds(items, query.descendantOf)
    : null;
  return items.filter((item) => {
    if (query.provider && item.provider !== query.provider) return false;
    if (query.groupFolder && item.groupFolder !== query.groupFolder) return false;
    if (query.chatJid && item.chatJid !== query.chatJid) return false;
    if (query.activeOnly && !isActiveStatus(item.status)) return false;
    if (statusSet && !statusSet.has(item.status)) return false;
    if (query.runtimeId && item.runtimeId !== query.runtimeId) return false;
    if (
      query.controllerSessionKey &&
      item.controllerSessionKey !== query.controllerSessionKey
    ) {
      return false;
    }
    if (
      query.requesterSessionKey &&
      item.requesterSessionKey !== query.requesterSessionKey
    ) {
      return false;
    }
    if (query.parentRuntimeId && item.parentRuntimeId !== query.parentRuntimeId) {
      return false;
    }
    if (query.originTurnId && item.originTurnId !== query.originTurnId) {
      return false;
    }
    if (
      query.originToolCallId &&
      item.originToolCallId !== query.originToolCallId
    ) {
      return false;
    }
    if (descendantIds && !descendantIds.has(item.runtimeId)) {
      return false;
    }
    return true;
  });
}

function buildRunPagedSnapshot(
  snapshot: SubagentRunRegistrySnapshot,
  items: SubagentRunRecord[],
  query: ReturnType<typeof normalizeRunListQuery>,
): SubagentRunSnapshot {
  const cursor = parseCursor(query.cursor);
  const itemsAfterCursor = items.filter((item) => isRunAfterCursor(item, cursor));
  const pagedItems = itemsAfterCursor.slice(0, query.limit);
  const nextCursor =
    itemsAfterCursor.length > pagedItems.length &&
    pagedItems[pagedItems.length - 1]
      ? buildCursor(
          pagedItems[pagedItems.length - 1].updatedAt,
          pagedItems[pagedItems.length - 1].runtimeId,
        )
      : undefined;
  return {
    generatedAt: snapshot.generatedAt,
    activeCount: items.filter((item) => isActiveStatus(item.status)).length,
    recentCount: items.length,
    items: pagedItems,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function getFilteredEntries(
  queryOrLimit?: number | SubagentRuntimeListQuery,
): {
  query: ReturnType<typeof normalizeListQuery>;
  items: SubagentRuntimeEntry[];
  index: Map<string, IndexedSubagentRuntimeRecord>;
} {
  const query = normalizeListQuery(queryOrLimit);
  if (query.provider && !isSupportedProvider(query.provider)) {
    return { query, items: [], index: new Map() };
  }
  const index = scanSubagentRuntimeIndex();
  const items = filterEntries(
    [...index.values()].map((record) => record.entry).sort(compareEntries),
    query,
  );
  return { query, items, index };
}

export function listSubagentRuntimes(limit?: number): SubagentRuntimeSnapshot;
export function listSubagentRuntimes(
  query?: SubagentRuntimeListQuery,
): SubagentRuntimeSnapshot;
export function listSubagentRuntimes(
  queryOrLimit?: number | SubagentRuntimeListQuery,
): SubagentRuntimeSnapshot {
  const { query, items } = getFilteredEntries(queryOrLimit);
  return buildPagedSnapshot(items, query);
}

export function listSubagentRuntimeTree(
  queryOrLimit?: number | SubagentRuntimeListQuery,
): SubagentRuntimeTreeSnapshot {
  const { query, items } = getFilteredEntries(queryOrLimit);
  const paged = buildPagedSnapshot(items, query);
  const itemMap = new Map<string, SubagentRuntimeTreeNode>();
  const roots: SubagentRuntimeTreeNode[] = [];
  for (const entry of paged.items) {
    itemMap.set(entry.id, { entry, children: [] });
  }
  for (const node of itemMap.values()) {
    const parentId = node.entry.parentRuntimeId?.trim();
    const parent = parentId ? itemMap.get(parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { ...paged, roots };
}

export function listPersistedSubagentRuns(): SubagentRunRegistrySnapshot {
  return loadRunRegistrySnapshot();
}

export function listSubagentRuns(limit?: number): SubagentRunSnapshot;
export function listSubagentRuns(
  query?: SubagentRunListQuery,
): SubagentRunSnapshot;
export function listSubagentRuns(
  queryOrLimit?: number | SubagentRunListQuery,
): SubagentRunSnapshot {
  const query = normalizeRunListQuery(queryOrLimit);
  if (query.provider && !isSupportedProvider(query.provider)) {
    return {
      generatedAt: new Date().toISOString(),
      activeCount: 0,
      recentCount: 0,
      items: [],
    };
  }
  const snapshot = loadRunRegistrySnapshot();
  const items = filterRunRecords([...snapshot.runs].sort(compareRunRecords), query);
  return buildRunPagedSnapshot(snapshot, items, query);
}

export function listSubagentRunTree(
  queryOrLimit?: number | SubagentRunListQuery,
): SubagentRunTreeSnapshot {
  const query = normalizeRunListQuery(queryOrLimit);
  const snapshot = listSubagentRuns(query);
  const itemMap = new Map<string, SubagentRunTreeNode>();
  const roots: SubagentRunTreeNode[] = [];
  for (const entry of snapshot.items) {
    itemMap.set(entry.runtimeId, { entry, children: [] });
  }
  for (const node of itemMap.values()) {
    const parentId = node.entry.parentRuntimeId?.trim();
    const parent = parentId ? itemMap.get(parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { ...snapshot, roots };
}

export function listSubagentRunsForController(
  controllerSessionKey: string,
  query: Omit<SubagentRunListQuery, 'controllerSessionKey'> = {},
): SubagentRunSnapshot {
  return listSubagentRuns({
    ...query,
    controllerSessionKey,
  });
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  query: Omit<SubagentRunListQuery, 'requesterSessionKey'> = {},
): SubagentRunSnapshot {
  return listSubagentRuns({
    ...query,
    requesterSessionKey,
  });
}

export function listSubagentRunDescendants(
  runtimeId: string,
  query: Omit<SubagentRunListQuery, 'descendantOf'> = {},
): SubagentRunSnapshot {
  return listSubagentRuns({
    ...query,
    descendantOf: runtimeId,
  });
}

export function findIndexedRuntimeById(
  subagentId: string,
): IndexedSubagentRuntimeRecord | null {
  const targetId = subagentId.trim();
  if (!targetId) return null;
  return scanSubagentRuntimeIndex().get(targetId) || null;
}

export function getSubagentRuntime(
  subagentId: string,
): SubagentRuntimeEntry | null {
  const record = findIndexedRuntimeById(subagentId);
  return record?.entry || null;
}

export function getSubagentRuntimeDetail(
  subagentId: string,
): SubagentRuntimeDetail | null {
  const targetId = subagentId.trim();
  if (!targetId) return null;
  const index = scanSubagentRuntimeIndex();
  const record = index.get(targetId);
  if (!record) return null;
  const children = [...index.values()]
    .map((item) => item.entry)
    .filter((item) => item.parentRuntimeId === targetId)
    .sort(compareEntries);
  const descendants: SubagentRuntimeEntry[] = [];
  const pending = [...children.map((item) => item.id)];
  while (pending.length > 0) {
    const nextId = pending.shift();
    if (!nextId) continue;
    const next = index.get(nextId)?.entry;
    if (!next) continue;
    descendants.push(next);
    for (const candidate of index.values()) {
      if (candidate.entry.parentRuntimeId === next.id) {
        pending.push(candidate.entry.id);
      }
    }
  }
  return {
    entry: record.entry,
    parent: record.entry.parentRuntimeId
      ? index.get(record.entry.parentRuntimeId)?.entry || null
      : null,
    children,
    descendants: descendants.sort(compareEntries),
    controls: record.entry.capabilities || {
      canStop: false,
      canMessage: false,
      canSteer: false,
      canSpawnChildren: false,
      canResumeAfterRestart: false,
    },
  };
}

export function upsertEphemeralSubagentRuntime(
  entry: SubagentRuntimeEntry,
): void {
  const next = parseRuntimeEntry(entry);
  if (!next) return;
  ephemeralRuntimeEntries.set(next.id, buildEphemeralRuntimeRecord(next));
}

export function removeEphemeralSubagentRuntime(subagentId: string): void {
  const targetId = subagentId.trim();
  if (!targetId) return;
  ephemeralRuntimeEntries.delete(targetId);
}

export function clearEphemeralSubagentRuntimes(
  query: {
    provider?: SubagentRuntimeProvider;
    groupFolder?: string;
    chatJid?: string;
  } = {},
): void {
  for (const [id, record] of ephemeralRuntimeEntries) {
    if (query.provider && record.entry.provider !== query.provider) continue;
    if (query.groupFolder && record.entry.groupFolder !== query.groupFolder) {
      continue;
    }
    if (query.chatJid && record.entry.chatJid !== query.chatJid) continue;
    ephemeralRuntimeEntries.delete(id);
  }
}

export function loadRunRegistrySnapshot(): SubagentRunRegistrySnapshot {
  scanSubagentRuntimeIndex();
  const persisted = readPersistedRunRegistrySnapshot();
  if (persisted) {
    return persisted;
  }
  return getCurrentRunRegistrySnapshot();
}

export * from './subagent-runtime-types.js';
export * from './subagent-runtime-fs.js';
export { recoverOrphanedSubagentRuntimes } from './subagent-runtime-recovery.js';
export {
  requestMessageSubagentRuntime,
  requestSteerSubagentRuntime,
  requestStopSubagentRuntime,
  requestStopSubagentRuntimes,
} from './subagent-runtime-control.js';

// Wire up late-bound registry accessor so control.ts can call
// lookup functions without a direct import cycle.
import { _setRegistryLookup } from './subagent-runtime-types.js';
_setRegistryLookup({
  findIndexedRuntimeById,
  getSubagentRuntime,
  loadRunRegistrySnapshot,
});
