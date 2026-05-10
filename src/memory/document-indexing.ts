import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  deleteMemoryDocumentSyncStates,
  deleteMemoryDocumentsByPathRefs,
  listMemoryDocumentSyncStates,
  recordMemorySearchEvents,
  upsertMemoryDocuments,
  upsertMemoryDocumentSyncStates,
} from '../db.js';
import { resolveEmbeddingProvider } from '../embedding/resolve.js';
import { embedAndStore } from '../embedding/vector-store.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type {
  MemoryDocumentRecord,
  MemoryDocumentSyncStateRecord,
} from '../types.js';

export type IndexedMemoryScope = 'group' | 'global' | 'all';

export interface IndexedMemoryFileRef {
  scope: Exclude<IndexedMemoryScope, 'all'>;
  relPath: string;
  pathRef: string;
  absolutePath: string;
}

type SyncMemoryFileOutcome = 'updated' | 'skipped' | 'missing';

function getConfiguredGroupDir(groupFolder?: string): string {
  if (process.env.NANOCLAW_GROUP_DIR) {
    return process.env.NANOCLAW_GROUP_DIR;
  }
  if (groupFolder) {
    return resolveGroupFolderPath(groupFolder);
  }
  return '/workspace/group';
}

function getConfiguredGlobalDir(): string {
  return process.env.NANOCLAW_GLOBAL_DIR || path.join(GROUPS_DIR, 'global');
}

function normalizeRelativePath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

function isAllowedMemoryRelativePath(relPath: string): boolean {
  if (!relPath || relPath.includes('..')) return false;
  if (relPath === 'MEMORY.md') return true;
  if (/^memory\/identity\//i.test(relPath)) return false;
  return /^memory\/.+\.md$/i.test(relPath);
}

function getScopeRoot(
  scope: Exclude<IndexedMemoryScope, 'all'>,
  groupFolder?: string,
): string {
  return scope === 'group'
    ? getConfiguredGroupDir(groupFolder)
    : getConfiguredGlobalDir();
}

function resolveScopeRoots(
  scope: IndexedMemoryScope,
): Array<Exclude<IndexedMemoryScope, 'all'>> {
  if (scope === 'all') return ['group', 'global'];
  return [scope];
}

export function buildMemoryPathRef(
  scope: Exclude<IndexedMemoryScope, 'all'>,
  relPath: string,
): string {
  return `${scope}:${relPath}`;
}

function enumerateMarkdownFiles(
  dirPath: string,
  baseDir: string,
  out: string[],
): void {
  if (!fs.existsSync(dirPath)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      enumerateMarkdownFiles(absolutePath, baseDir, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const relPath = normalizeRelativePath(path.relative(baseDir, absolutePath));
    if (isAllowedMemoryRelativePath(relPath)) {
      out.push(relPath);
    }
  }
}

export function listIndexedMemoryFiles(
  scope: IndexedMemoryScope = 'all',
  options?: { groupFolder?: string },
): IndexedMemoryFileRef[] {
  const results: IndexedMemoryFileRef[] = [];
  for (const scopeName of resolveScopeRoots(scope)) {
    const rootDir = getScopeRoot(scopeName, options?.groupFolder);
    if (!rootDir || !fs.existsSync(rootDir)) continue;

    const relPaths: string[] = [];
    const memoryMdPath = path.join(rootDir, 'MEMORY.md');
    if (fs.existsSync(memoryMdPath)) {
      relPaths.push('MEMORY.md');
    }
    enumerateMarkdownFiles(path.join(rootDir, 'memory'), rootDir, relPaths);

    const seen = new Set<string>();
    for (const relPath of relPaths) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      results.push({
        scope: scopeName,
        relPath,
        pathRef: buildMemoryPathRef(scopeName, relPath),
        absolutePath: path.join(rootDir, ...relPath.split('/')),
      });
    }
  }
  return results;
}

export function resolveIndexedMemoryPathRef(
  pathRef: string,
  options?: { groupFolder?: string },
): IndexedMemoryFileRef {
  const raw = String(pathRef || '').trim();
  const colonIndex = raw.indexOf(':');
  const scopeRaw =
    colonIndex >= 0 ? raw.slice(0, colonIndex).trim().toLowerCase() : 'group';
  const relRaw = colonIndex >= 0 ? raw.slice(colonIndex + 1) : raw;
  if (scopeRaw !== 'group' && scopeRaw !== 'global') {
    throw new Error(`Invalid memory scope: ${scopeRaw || '(empty)'}`);
  }
  const relPath = normalizeRelativePath(relRaw);
  if (!isAllowedMemoryRelativePath(relPath)) {
    throw new Error(`Memory path is not allowed: ${raw}`);
  }
  return {
    scope: scopeRaw,
    relPath,
    pathRef: buildMemoryPathRef(scopeRaw, relPath),
    absolutePath: path.join(
      getScopeRoot(scopeRaw, options?.groupFolder),
      ...relPath.split('/'),
    ),
  };
}

function buildMemoryDocumentRecord(input: {
  file: IndexedMemoryFileRef;
  groupFolder: string;
  body: string;
  updatedAt?: string;
}): MemoryDocumentRecord {
  const ownerType = input.file.scope === 'group' ? 'group' : 'global';
  return {
    doc_id: `memory-file:${input.file.pathRef}`,
    scope: input.file.scope,
    owner_type: ownerType,
    owner_id: input.file.scope === 'group' ? input.groupFolder : 'global',
    path_ref: input.file.pathRef,
    source_type: 'memory_file',
    title: input.file.relPath,
    body: input.body,
    metadata_json: JSON.stringify({
      relPath: input.file.relPath,
      scope: input.file.scope,
    }),
    updated_at: input.updatedAt || new Date().toISOString(),
  };
}

function hashMemoryContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createSyncStateRecord(input: {
  file: IndexedMemoryFileRef;
  groupFolder: string;
  stat: fs.Stats;
  contentHash: string;
  lastSyncedAt?: string;
}): MemoryDocumentSyncStateRecord {
  return {
    path_ref: input.file.pathRef,
    scope: input.file.scope,
    owner_type: input.file.scope === 'group' ? 'group' : 'global',
    owner_id: input.file.scope === 'group' ? input.groupFolder : 'global',
    source_type: 'memory_file',
    file_mtime_ms: Math.trunc(input.stat.mtimeMs),
    file_size: input.stat.size,
    content_hash: input.contentHash,
    last_synced_at: input.lastSyncedAt || new Date().toISOString(),
  };
}

async function syncMemoryFileIfChanged(input: {
  file: IndexedMemoryFileRef;
  groupFolder: string;
  existingState?: MemoryDocumentSyncStateRecord;
  updatedAt?: string;
}): Promise<SyncMemoryFileOutcome> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.file.absolutePath);
  } catch {
    return 'missing';
  }
  const mtimeMs = Math.trunc(stat.mtimeMs);
  if (
    input.existingState &&
    input.existingState.file_mtime_ms === mtimeMs &&
    input.existingState.file_size === stat.size
  ) {
    return 'skipped';
  }

  const body = fs.readFileSync(input.file.absolutePath, 'utf-8');
  const contentHash = hashMemoryContent(body);
  const syncState = createSyncStateRecord({
    file: input.file,
    groupFolder: input.groupFolder,
    stat,
    contentHash,
    lastSyncedAt: input.updatedAt,
  });
  if (input.existingState?.content_hash === contentHash) {
    await upsertMemoryDocumentSyncStates([syncState]);
    return 'skipped';
  }

  const document = buildMemoryDocumentRecord({
    file: input.file,
    groupFolder: input.groupFolder,
    body,
    updatedAt: input.updatedAt,
  });
  await upsertMemoryDocuments([document]);
  await upsertMemoryDocumentSyncStates([syncState]);

  try {
    const provider = await resolveEmbeddingProvider();
    if (provider && body.length > 10) {
      await embedAndStore('memory_doc', document.doc_id, body, provider);
    }
  } catch (err) {
    logger.debug({ err, docId: document.doc_id }, 'Failed to embed memory document, vector search will rely on BM25');
  }

  return 'updated';
}

export async function syncIndexedMemoryFile(input: {
  pathRef: string;
  groupFolder: string;
  updatedAt?: string;
}): Promise<IndexedMemoryFileRef | null> {
  const file = resolveIndexedMemoryPathRef(input.pathRef, {
    groupFolder: input.groupFolder,
  });
  const existingStates = await listMemoryDocumentSyncStates({
    pathRefs: [file.pathRef],
  });
  const existingState = existingStates[0];
  try {
    await syncMemoryFileIfChanged({
      file,
      groupFolder: input.groupFolder,
      existingState,
      updatedAt: input.updatedAt,
    });
  } catch {
    return null;
  }
  return file;
}

/**
 * Write memory content directly to DB (DB-first path used by agent API).
 * The file is expected to already exist on disk for immediate AI reads.
 */
export async function saveMemoryFileContentToDb(input: {
  pathRef: string;
  groupFolder: string;
  content: string;
}): Promise<void> {
  const file = resolveIndexedMemoryPathRef(input.pathRef, {
    groupFolder: input.groupFolder,
  });
  const document = buildMemoryDocumentRecord({
    file,
    groupFolder: input.groupFolder,
    body: input.content,
  });
  await upsertMemoryDocuments([document]);
}

/**
 * Write a memory document from DB back to the filesystem.
 * Used by startup hydration and DB→file reverse sync.
 */
export function syncMemoryDocumentToFile(
  pathRef: string,
  content: string,
  options?: { groupFolder?: string },
): void {
  const file = resolveIndexedMemoryPathRef(pathRef, options);
  fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
  fs.writeFileSync(file.absolutePath, content, 'utf-8');
}

function getOwnerBoundary(input: {
  scope: IndexedMemoryScope;
  groupFolder: string;
}): {
  scope: Exclude<IndexedMemoryScope, 'all'>;
  ownerType: 'group' | 'global';
  ownerId: string;
}[] {
  if (input.scope === 'all') {
    return [
      {
        scope: 'group',
        ownerType: 'group',
        ownerId: input.groupFolder,
      },
      {
        scope: 'global',
        ownerType: 'global',
        ownerId: 'global',
      },
    ];
  }
  if (input.scope === 'group') {
    return [
      {
        scope: 'group',
        ownerType: 'group',
        ownerId: input.groupFolder,
      },
    ];
  }
  return [
    {
      scope: 'global',
      ownerType: 'global',
      ownerId: 'global',
    },
  ];
}

async function deleteMissingSyncStateEntries(input: {
  scope: IndexedMemoryScope;
  groupFolder: string;
  currentPathRefs: Set<string>;
  updatedAt?: string;
}): Promise<void> {
  for (const boundary of getOwnerBoundary(input)) {
    const existingStates = await listMemoryDocumentSyncStates({
      scope: boundary.scope,
      ownerType: boundary.ownerType,
      ownerId: boundary.ownerId,
      sourceType: 'memory_file',
    });
    const stalePathRefs = existingStates
      .map((state) => state.path_ref)
      .filter((pathRef) => !input.currentPathRefs.has(pathRef));
    if (stalePathRefs.length === 0) continue;
    await deleteMemoryDocumentsByPathRefs(stalePathRefs);
    await deleteMemoryDocumentSyncStates(stalePathRefs);
    await recordMemorySearchEvents(
      stalePathRefs.map((pathRef) => ({
        eventType: 'sync_file_deleted',
        pathRef,
        scope: boundary.scope,
        ownerType: boundary.ownerType,
        ownerId: boundary.ownerId,
        createdAt: input.updatedAt,
      })),
    );
  }
}

export async function refreshIndexedMemoryPathRefsForSearch(input: {
  pathRefs: string[];
  groupFolder: string;
  updatedAt?: string;
}): Promise<{ checkedCount: number; refreshedCount: number; deletedCount: number; }> {
  const uniquePathRefs = [...new Set(
    input.pathRefs
      .map((pathRef) => String(pathRef || '').trim())
      .filter(Boolean),
  )];
  if (uniquePathRefs.length === 0) {
    return {
      checkedCount: 0,
      refreshedCount: 0,
      deletedCount: 0,
    };
  }

  const syncStateRows = await listMemoryDocumentSyncStates({
    pathRefs: uniquePathRefs,
  });
  const syncStates = new Map<string, MemoryDocumentSyncStateRecord>(
    syncStateRows.map((state) => [state.path_ref, state]),
  );
  const events: Array<{
    eventType:
      | 'search_freshness_recheck'
      | 'search_stale_refresh'
      | 'sync_file_updated'
      | 'sync_file_skipped'
      | 'sync_file_deleted';
    pathRef?: string | null;
    scope?: string | null;
    ownerType?: string | null;
    ownerId?: string | null;
    createdAt?: string;
  }> = [];
  let refreshedCount = 0;
  let deletedCount = 0;

  for (const pathRef of uniquePathRefs) {
    let file: IndexedMemoryFileRef;
    try {
      file = resolveIndexedMemoryPathRef(pathRef, {
        groupFolder: input.groupFolder,
      });
    } catch {
      continue;
    }
    const ownerType = file.scope === 'group' ? 'group' : 'global';
    const ownerId = file.scope === 'group' ? input.groupFolder : 'global';
    events.push({
      eventType: 'search_freshness_recheck',
      pathRef: file.pathRef,
      scope: file.scope,
      ownerType,
      ownerId,
      createdAt: input.updatedAt,
    });

    const existingState = syncStates.get(file.pathRef);
    if (!existingState) {
      const outcome = await syncMemoryFileIfChanged({
        file,
        groupFolder: input.groupFolder,
        updatedAt: input.updatedAt,
      });
      if (outcome === 'updated') {
        refreshedCount += 1;
        events.push({
          eventType: 'search_stale_refresh',
          pathRef: file.pathRef,
          scope: file.scope,
          ownerType,
          ownerId,
          createdAt: input.updatedAt,
        });
        events.push({
          eventType: 'sync_file_updated',
          pathRef: file.pathRef,
          scope: file.scope,
          ownerType,
          ownerId,
          createdAt: input.updatedAt,
        });
      }
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.absolutePath);
    } catch {
      await deleteMemoryDocumentsByPathRefs([file.pathRef]);
      await deleteMemoryDocumentSyncStates([file.pathRef]);
      deletedCount += 1;
      events.push({
        eventType: 'search_stale_refresh',
        pathRef: file.pathRef,
        scope: file.scope,
        ownerType,
        ownerId,
        createdAt: input.updatedAt,
      });
      events.push({
        eventType: 'sync_file_deleted',
        pathRef: file.pathRef,
        scope: file.scope,
        ownerType,
        ownerId,
        createdAt: input.updatedAt,
      });
      continue;
    }

    const mtimeMs = Math.trunc(stat.mtimeMs);
    if (
      existingState.file_mtime_ms === mtimeMs &&
      existingState.file_size === stat.size
    ) {
      continue;
    }

    const outcome = await syncMemoryFileIfChanged({
      file,
      groupFolder: input.groupFolder,
      existingState,
      updatedAt: input.updatedAt,
    });
    events.push({
      eventType: 'search_stale_refresh',
      pathRef: file.pathRef,
      scope: file.scope,
      ownerType,
      ownerId,
      createdAt: input.updatedAt,
    });
    if (outcome === 'updated') {
      refreshedCount += 1;
      events.push({
        eventType: 'sync_file_updated',
        pathRef: file.pathRef,
        scope: file.scope,
        ownerType,
        ownerId,
        createdAt: input.updatedAt,
      });
    } else if (outcome === 'skipped') {
      events.push({
        eventType: 'sync_file_skipped',
        pathRef: file.pathRef,
        scope: file.scope,
        ownerType,
        ownerId,
        createdAt: input.updatedAt,
      });
    } else if (outcome === 'missing') {
      await deleteMemoryDocumentsByPathRefs([file.pathRef]);
      await deleteMemoryDocumentSyncStates([file.pathRef]);
      deletedCount += 1;
      events.push({
        eventType: 'sync_file_deleted',
        pathRef: file.pathRef,
        scope: file.scope,
        ownerType,
        ownerId,
        createdAt: input.updatedAt,
      });
    }
  }

  await recordMemorySearchEvents(events);
  return {
    checkedCount: uniquePathRefs.length,
    refreshedCount,
    deletedCount,
  };
}

export async function syncIndexedMemoryFilesForSearch(input: {
  scope: IndexedMemoryScope;
  groupFolder: string;
  updatedAt?: string;
}): Promise<Map<string, IndexedMemoryFileRef>> {
  const files = listIndexedMemoryFiles(input.scope, {
    groupFolder: input.groupFolder,
  });
  const currentPathRefs = new Set(files.map((file) => file.pathRef));
  await deleteMissingSyncStateEntries({
    scope: input.scope,
    groupFolder: input.groupFolder,
    currentPathRefs,
    updatedAt: input.updatedAt,
  });
  const syncStateRowsForFiles = await listMemoryDocumentSyncStates({
    pathRefs: [...currentPathRefs],
  });
  const existingStates = new Map<string, MemoryDocumentSyncStateRecord>(
    syncStateRowsForFiles.map((state) => [state.path_ref, state]),
  );
  for (const file of files) {
    const outcome = await syncMemoryFileIfChanged({
      file,
      groupFolder: input.groupFolder,
      existingState: existingStates.get(file.pathRef),
      updatedAt: input.updatedAt,
    });
    if (outcome === 'updated' || outcome === 'skipped') {
      await recordMemorySearchEvents([
        {
          eventType: outcome === 'updated' ? 'sync_file_updated' : 'sync_file_skipped',
          pathRef: file.pathRef,
          scope: file.scope,
          ownerType: file.scope === 'group' ? 'group' : 'global',
          ownerId: file.scope === 'group' ? input.groupFolder : 'global',
          createdAt: input.updatedAt,
        },
      ]);
    }
  }
  return new Map(files.map((file) => [file.pathRef, file]));
}
