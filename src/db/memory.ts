import crypto from 'crypto';
import {
  type AssistantConfig,
  createDefaultAssistantConfig,
  normalizeAssistantConfig,
  serializeAssistantConfig,
} from '../assistant/assistant-config.js';
import {
  type AssistantMcpBindingRecord,
  type AssistantMcpBindingSecretRecord,
  createAssistantMcpBindingId,
} from '../assistant/assistant-mcp.js';
import { ASSISTANT_NAME, DATA_DIR, STORE_DIR, invalidateStartupConfigCache } from '../config.js';
import {
  type DbEngine,
} from '../database/engine.js';
import { isValidGroupFolder } from '../group-folder.js';
import { createModuleLogger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { buildIdentityMemoryDocumentRecord } from '../memory/identity-documents.js';
import { buildDurableCandidateSummaryLines } from '../memory/promotion.js';
import {
  deleteMemorySearchIndexDocuments,
  initializeMemorySearchIndex,
  searchMemorySearchIndex,
  upsertMemorySearchIndexDocuments,
} from '../memory/search-index.js';
import {
  type ConversationIdentityBindingRecord,
  type ContextCompactionRecord,
  type ContextEntryRecord,
  type IdentityAliasRecord,
  type MemoryCompactionLatestSnapshot,
  type MemoryCompactionStatsSnapshot,
  type MemoryCompactionWorkerSnapshot,
  type MemoryDocumentRecord,
  type MemoryDocumentSyncStateRecord,
  type MemoryIdentityStatsSnapshot,
  type MemoryLedgerStatsSnapshot,
  type MemoryPromotionCandidate,
  type MemoryPromotionStatsSnapshot,
  type MemoryPromptStatsSnapshot,
  type MemorySearchGroupQualitySnapshot,
  type MemorySearchSourceQualitySnapshot,
  type MemorySearchScopeQualitySnapshot,
  type MemorySearchStatsSnapshot,
  type NewMessage,
  type PersonProfileRecord,
  type RegisteredGroup,
  type ScheduledTask,
  type TaskRunLog,
  type UserSoulRecord,
  type UserMemoryRecord,
  type UserMemoryObservationRecord,
  type PersonaInsightRecord,
  type MemoryConsolidationLogRecord,
  type MemoryExtractionLogRecord,
  type MemoryEventRecord,
  type MemorySkillRecord,
} from '../types.js';
import { adaptSql } from './sql-adapters.js';
import { dba, eng, getSqliteRawDatabase, isSqlite } from './engine-access.js';
import { createPlaceholders, estimateTokenCount, normalizeMemoryText } from './sql-utils.js';

const logger = createModuleLogger('database');

type MemorySearchEventType =
  | 'search_index_hit'
  | 'search_followup_read'
  | 'search_fallback_sync'
  | 'search_freshness_recheck'
  | 'search_stale_refresh'
  | 'sync_file_updated'
  | 'sync_file_skipped'
  | 'sync_file_deleted';

export async function getUserMemoryProjectionStats(options?: {
  userId?: string;
  timeScope?: 'current' | 'all';
  queryTime?: string;
}): Promise<MemorySearchStatsSnapshot['userMemoryProjection']> {
  const userId = normalizeMemoryText(options?.userId || '');
  const memoryParams: string[] = [];
  const memoryClauses: string[] = [];
  if (userId) {
    memoryClauses.push('user_id = ?');
    memoryParams.push(userId);
  }
  if ((options?.timeScope ?? 'current') === 'current') {
    const qt = options?.queryTime ?? new Date().toISOString();
    memoryClauses.push('(valid_from IS NULL OR valid_from <= ?)');
    memoryParams.push(qt);
    memoryClauses.push('(valid_to IS NULL OR valid_to > ?)');
    memoryParams.push(qt);
    memoryClauses.push('(expires_at IS NULL OR expires_at > ?)');
    memoryParams.push(qt);
  }
  const memoryWhere = memoryClauses.length > 0
    ? `WHERE ${memoryClauses.join(' AND ')}`
    : '';
  const memoryRows = await dba
    .prepare(`SELECT id FROM user_memories ${memoryWhere}`)
    .all(...memoryParams) as Array<{ id: string }>;

  const documentParams: string[] = [];
  const documentWhere = userId ? 'AND owner_id = ?' : '';
  if (userId) documentParams.push(userId);
  const documentRows = await dba
    .prepare(
      `
        SELECT path_ref
        FROM memory_documents
        WHERE source_type = 'user_memory'
        ${documentWhere}
      `,
    )
    .all(...documentParams) as Array<{ path_ref: string | null }>;

  const sourceIds = new Set(memoryRows.map((row) => row.id));
  const projectedIds = new Set(
    documentRows
      .map((row) => String(row.path_ref || ''))
      .filter((pathRef) => pathRef.startsWith('user_memory:'))
      .map((pathRef) => pathRef.slice('user_memory:'.length)),
  );

  let missingDocuments = 0;
  for (const id of sourceIds) {
    if (!projectedIds.has(id)) missingDocuments += 1;
  }

  let orphanDocuments = 0;
  for (const row of documentRows) {
    const pathRef = String(row.path_ref || '');
    if (!pathRef.startsWith('user_memory:')) {
      orphanDocuments += 1;
      continue;
    }
    if (!sourceIds.has(pathRef.slice('user_memory:'.length))) {
      orphanDocuments += 1;
    }
  }

  return {
    sourceMemories: memoryRows.length,
    projectedDocuments: documentRows.length,
    missingDocuments,
    orphanDocuments,
  };
}

export async function upsertMemoryDocuments(documents: MemoryDocumentRecord[]): Promise<void> {
  if (documents.length === 0) return;

  const upsertSqlStr = adaptSql(
    `INSERT INTO memory_documents (doc_id,scope,owner_type,owner_id,path_ref,source_type,title,body,metadata_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET scope=excluded.scope,owner_type=excluded.owner_type,owner_id=excluded.owner_id,path_ref=excluded.path_ref,source_type=excluded.source_type,title=excluded.title,body=excluded.body,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
  );

  const tx = dba.transaction(async (items: MemoryDocumentRecord[]) => {
    const normalizedItems: Array<{ docId: string; title: string | null; body: string; updatedAt: string }> = [];

    for (const item of items) {
      const title = normalizeMemoryText(item.title || '') || null;
      const body = normalizeMemoryText(item.body);
      const updatedAt = normalizeMemoryText(item.updated_at) || new Date().toISOString();
      normalizedItems.push({ docId: item.doc_id, title, body, updatedAt });
      await eng().run(upsertSqlStr, [
        item.doc_id, item.scope, item.owner_type, item.owner_id,
        item.path_ref || null, item.source_type, title, body,
        item.metadata_json || null, updatedAt,
      ]);
    }

    if (isSqlite() && normalizedItems.length > 0) {
      const placeholders = normalizedItems.map(() => '?').join(',');
      await eng().run(
        `DELETE FROM memory_documents_fts WHERE doc_id IN (${placeholders})`,
        normalizedItems.map((n) => n.docId),
      );
      const ftsPlaceholders = normalizedItems.map(() => '(?,?,?)').join(',');
      const ftsParams = normalizedItems.flatMap((n) => [n.docId, n.title || '', n.body]);
      await eng().run(
        `INSERT INTO memory_documents_fts (doc_id,title,body) VALUES ${ftsPlaceholders}`,
        ftsParams,
      );
    }

    if (getSqliteRawDatabase()) {
      upsertMemorySearchIndexDocuments(getSqliteRawDatabase()!,
        items.map((item) => ({
          docId: item.doc_id,
          scope: item.scope,
          ownerType: item.owner_type,
          ownerId: item.owner_id,
          pathRef: item.path_ref,
          sourceType: item.source_type,
          title: item.title,
          body: item.body,
          metadataJson: item.metadata_json,
          updatedAt: item.updated_at,
        })),
      );
    }
  });

  await tx(documents);
}

export async function listMemoryDocuments(options?: {
  ownerType?: MemoryDocumentRecord['owner_type'];
  ownerId?: string;
  scope?: MemoryDocumentRecord['scope'];
  sourceType?: MemoryDocumentRecord['source_type'];
  limit?: number;
}): Promise<MemoryDocumentRecord[]> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options?.ownerType) {
    clauses.push(`owner_type = ?`);
    params.push(options.ownerType);
  }
  if (options?.ownerId) {
    clauses.push(`owner_id = ?`);
    params.push(options.ownerId);
  }
  if (options?.scope) {
    clauses.push(`scope = ?`);
    params.push(options.scope);
  }
  if (options?.sourceType) {
    clauses.push(`source_type = ?`);
    params.push(options.sourceType);
  }
  const limit = Math.max(1, Math.min(options?.limit || 100, 500));
  params.push(limit);
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return await dba
    .prepare(
      `
        SELECT
          doc_id,
          scope,
          owner_type,
          owner_id,
          path_ref,
          source_type,
          title,
          body,
          metadata_json,
          updated_at
        FROM memory_documents
        ${whereSql}
        ORDER BY updated_at DESC, doc_id ASC
        LIMIT ?
      `,
    )
    .all(...params) as MemoryDocumentRecord[];
}

export async function listUserMemoryProjectionDocuments(options?: {
  userId?: string;
}): Promise<MemoryDocumentRecord[]> {
  const params: string[] = [];
  const ownerSql = options?.userId ? 'AND owner_id = ?' : '';
  if (options?.userId) params.push(options.userId);
  return await dba
    .prepare(
      `
        SELECT
          doc_id,
          scope,
          owner_type,
          owner_id,
          path_ref,
          source_type,
          title,
          body,
          metadata_json,
          updated_at
        FROM memory_documents
        WHERE source_type = 'user_memory'
        ${ownerSql}
        ORDER BY updated_at DESC, doc_id ASC
      `,
    )
    .all(...params) as MemoryDocumentRecord[];
}

/**
 * Paginated query for all memory documents that have a path_ref (file-backed).
 * Used by startup hydration to replay DB content to the filesystem.
 */
export async function listAllMemoryDocumentsForHydration(options?: {
  limit?: number;
  offset?: number;
  sourceTypes?: string[];
}): Promise<MemoryDocumentRecord[]> {
  const limit = Math.max(1, Math.min(options?.limit || 500, 2000));
  const offset = Math.max(0, options?.offset || 0);
  const clauses: string[] = ['path_ref IS NOT NULL'];
  const params: Array<string | number> = [];
  if (options?.sourceTypes && options.sourceTypes.length > 0) {
    clauses.push(
      `source_type IN (${options.sourceTypes.map(() => '?').join(', ')})`,
    );
    params.push(...options.sourceTypes);
  }
  params.push(limit, offset);
  return (await dba
    .prepare(
      `SELECT doc_id, scope, owner_type, owner_id, path_ref, source_type,
              title, body, metadata_json, updated_at
       FROM memory_documents
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params)) as MemoryDocumentRecord[];
}

export async function deleteMemoryDocumentsByPathRefs(pathRefs: string[]): Promise<void> {
  if (pathRefs.length === 0) return;
  const placeholders = createPlaceholders(pathRefs.length);
  const docIds = pathRefs.map((pathRef) => `memory-file:${pathRef}`);
  const docPlaceholders = createPlaceholders(docIds.length);
  const tx = dba.transaction(async () => {
    if (isSqlite()) {
      await eng().run(
        `DELETE FROM memory_documents_fts WHERE doc_id IN (${docPlaceholders})`,
        docIds,
      );
    }
    await dba.prepare(
      `DELETE FROM memory_documents WHERE path_ref IN (${placeholders})`,
    ).run(...pathRefs);
    if (getSqliteRawDatabase()) {
      deleteMemorySearchIndexDocuments(getSqliteRawDatabase()!, docIds);
    }
  });
  await tx();
}

export async function deleteMemoryDocuments(options: {
  docIds?: string[];
  ownerType?: MemoryDocumentRecord['owner_type'];
  ownerId?: string;
  scope?: MemoryDocumentRecord['scope'];
  sourceType?: MemoryDocumentRecord['source_type'];
  pathRefs?: string[];
}): Promise<void> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.docIds && options.docIds.length > 0) {
    clauses.push(`doc_id IN (${options.docIds.map(() => '?').join(', ')})`);
    params.push(...options.docIds);
  }
  if (options.ownerType) {
    clauses.push(`owner_type = ?`);
    params.push(options.ownerType);
  }
  if (options.ownerId) {
    clauses.push(`owner_id = ?`);
    params.push(options.ownerId);
  }
  if (options.scope) {
    clauses.push(`scope = ?`);
    params.push(options.scope);
  }
  if (options.sourceType) {
    clauses.push(`source_type = ?`);
    params.push(options.sourceType);
  }
  if (options.pathRefs && options.pathRefs.length > 0) {
    clauses.push(`path_ref IN (${options.pathRefs.map(() => '?').join(', ')})`);
    params.push(...options.pathRefs);
  }
  if (clauses.length === 0) return;
  const whereSql = `WHERE ${clauses.join(' AND ')}`;
  const rows = await dba
    .prepare(
      `
        SELECT doc_id
        FROM memory_documents
        ${whereSql}
      `,
    )
    .all(...params) as Array<{ doc_id: string }>;
  if (rows.length === 0) return;
  const docIds = rows.map((row) => row.doc_id);
  const docPlaceholders = createPlaceholders(docIds.length);
  const tx = dba.transaction(async () => {
    if (isSqlite()) {
      await eng().run(
        `DELETE FROM memory_documents_fts WHERE doc_id IN (${docPlaceholders})`,
        docIds,
      );
    }
    await dba.prepare(
      `
        DELETE FROM memory_documents
        ${whereSql}
      `,
    ).run(...params);
    if (getSqliteRawDatabase()) {
      deleteMemorySearchIndexDocuments(getSqliteRawDatabase()!, docIds);
    }
  });
  await tx();
}

export async function listMemoryDocumentSyncStates(options?: {
  scope?: MemoryDocumentSyncStateRecord['scope'];
  ownerType?: MemoryDocumentSyncStateRecord['owner_type'];
  ownerId?: string;
  sourceType?: MemoryDocumentSyncStateRecord['source_type'];
  pathRefs?: string[];
}): Promise<MemoryDocumentSyncStateRecord[]> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options?.scope) {
    clauses.push(`scope = ?`);
    params.push(options.scope);
  }
  if (options?.ownerType) {
    clauses.push(`owner_type = ?`);
    params.push(options.ownerType);
  }
  if (options?.ownerId) {
    clauses.push(`owner_id = ?`);
    params.push(options.ownerId);
  }
  if (options?.sourceType) {
    clauses.push(`source_type = ?`);
    params.push(options.sourceType);
  }
  if (options?.pathRefs && options.pathRefs.length > 0) {
    clauses.push(
      `path_ref IN (${options.pathRefs.map(() => '?').join(', ')})`,
    );
    params.push(...options.pathRefs);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return await dba
    .prepare(
      `
        SELECT
          path_ref,
          scope,
          owner_type,
          owner_id,
          source_type,
          file_mtime_ms,
          file_size,
          content_hash,
          last_synced_at
        FROM memory_document_sync_state
        ${whereSql}
        ORDER BY path_ref ASC
      `,
    )
    .all(...params) as MemoryDocumentSyncStateRecord[];
}

export async function upsertMemoryDocumentSyncStates(
  states: MemoryDocumentSyncStateRecord[],
): Promise<void> {
  if (states.length === 0) return;
  const upsertSql = `INSERT INTO memory_document_sync_state (path_ref,scope,owner_type,owner_id,source_type,file_mtime_ms,file_size,content_hash,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(path_ref) DO UPDATE SET scope=excluded.scope,owner_type=excluded.owner_type,owner_id=excluded.owner_id,source_type=excluded.source_type,file_mtime_ms=excluded.file_mtime_ms,file_size=excluded.file_size,content_hash=excluded.content_hash,last_synced_at=excluded.last_synced_at`;
  const tx = dba.transaction(async (items: MemoryDocumentSyncStateRecord[]) => {
    for (const state of items) {
      await dba.prepare(upsertSql).run(
        state.path_ref, state.scope, state.owner_type, state.owner_id,
        state.source_type, state.file_mtime_ms, state.file_size,
        state.content_hash, state.last_synced_at,
      );
    }
  });
  await tx(states);
}

export async function deleteMemoryDocumentSyncStates(pathRefs: string[]): Promise<void> {
  if (pathRefs.length === 0) return;
  const placeholders = createPlaceholders(pathRefs.length);
  await dba.prepare(
    `DELETE FROM memory_document_sync_state WHERE path_ref IN (${placeholders})`,
  ).run(...pathRefs);
}

export async function recordMemorySearchEvents(
  events: Array<{
    eventType: MemorySearchEventType;
    pathRef?: string | null;
    scope?: string | null;
    ownerType?: string | null;
    ownerId?: string | null;
    metadataJson?: string | null;
    createdAt?: string;
  }>,
): Promise<void> {
  if (events.length === 0) return;
  const insertSql = `INSERT INTO memory_search_events (event_type, path_ref, scope, owner_type, owner_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const tx = dba.transaction(async (
    items: Array<{
      eventType: MemorySearchEventType;
      pathRef?: string | null;
      scope?: string | null;
      ownerType?: string | null;
      ownerId?: string | null;
      metadataJson?: string | null;
      createdAt?: string;
    }>,
  ) => {
    for (const event of items) {
      await dba.prepare(insertSql).run(
        event.eventType,
        event.pathRef || null,
        event.scope || null,
        event.ownerType || null,
        event.ownerId || null,
        event.metadataJson || null,
        event.createdAt || new Date().toISOString(),
      );
    }
  });
  await tx(events);
}

export async function recordMemorySearchEvent(event: {
  eventType: MemorySearchEventType;
  pathRef?: string | null;
  scope?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  metadataJson?: string | null;
  createdAt?: string;
}): Promise<void> {
  await recordMemorySearchEvents([event]);
}

export async function searchMemoryDocuments(
  query: string,
  options?: {
    limit?: number;
    scopes?: MemoryDocumentRecord['scope'][];
    ownerType?: MemoryDocumentRecord['owner_type'];
    ownerId?: string;
    sourceTypes?: MemoryDocumentRecord['source_type'][];
  },
): Promise<Array<{
  docId: string;
  scope: string;
  ownerType: string;
  ownerId: string;
  pathRef: string | null;
  sourceType: string;
  title: string;
  body: string;
  metadataJson: string | null;
  updatedAt: string;
  score: number;
  textScore: number;
  sourceBoost: number;
  recencyBoost: number;
  exactMatchBoost: number;
}>> {
  if (getSqliteRawDatabase()) {
    initializeMemorySearchIndex(getSqliteRawDatabase()!);
    return searchMemorySearchIndex(getSqliteRawDatabase()!, query, {
      limit: options?.limit,
      scopes: options?.scopes,
      ownerType: options?.ownerType,
      ownerId: options?.ownerId,
      sourceTypeFilter: options?.sourceTypes,
    });
  }

  const limit = Math.max(1, Math.min(options?.limit ?? 8, 50));
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.scopes && options.scopes.length > 0) {
    conditions.push(`scope IN (${options.scopes.map(() => '?').join(',')})`);
    params.push(...options.scopes);
  }
  if (options?.ownerType) {
    conditions.push('owner_type = ?');
    params.push(options.ownerType);
  }
  if (options?.ownerId) {
    conditions.push('owner_id = ?');
    params.push(options.ownerId);
  }
  if (options?.sourceTypes && options.sourceTypes.length > 0) {
    conditions.push(`source_type IN (${options.sourceTypes.map(() => '?').join(',')})`);
    params.push(...options.sourceTypes);
  }
  conditions.push('(title LIKE ? OR body LIKE ?)');
  params.push(`%${query}%`, `%${query}%`);
  params.push(limit);

  try {
    const rows = (await dba
      .prepare(
        `SELECT * FROM memory_documents
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params)) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      docId: String(row.doc_id ?? ''),
      scope: String(row.scope ?? ''),
      ownerType: String(row.owner_type ?? ''),
      ownerId: String(row.owner_id ?? ''),
      pathRef: row.path_ref ? String(row.path_ref) : null,
      sourceType: String(row.source_type ?? ''),
      title: String(row.title ?? ''),
      body: String(row.body ?? ''),
      metadataJson: row.metadata_json ? String(row.metadata_json) : null,
      updatedAt: String(row.updated_at ?? ''),
      score: 0.5,
      textScore: 0.5,
      sourceBoost: 1,
      recencyBoost: 0,
      exactMatchBoost: 0,
    }));
  } catch (err) {
    logger.debug({ err }, 'searchMemoryDocuments LIKE fallback failed');
    return [];
  }
}

let lastPromptLaneSnapshot: Partial<MemoryPromptStatsSnapshot> | null = null;

export async function updateMemoryPromptStats(input: {
  scope?: string;
  lastAssembledTokenEstimate: number | null;
  lastRecentTokens: number | null;
  lastSummaryTokens: number | null;
  lastRecallTokens: number | null;
  lastRecentChatTokens?: number | null;
  lastRecentToolTokens?: number | null;
  lastMemoryRecallTokens?: number | null;
  lastCompactedSummaryTokens?: number | null;
  lastRecentChatCount?: number | null;
  lastRecentToolCount?: number | null;
  lastMemoryRecallCount?: number | null;
  lastCompactedSummaryCount?: number | null;
  activeChatCompactionId?: string | null;
  activeToolSummaryId?: string | null;
  toolContextMode?: 'recent' | 'summary' | 'mixed' | 'none' | null;
  updatedAt?: string;
}): Promise<void> {
  const updatedAt = input.updatedAt || new Date().toISOString();
  lastPromptLaneSnapshot = {
    lastRecentChatTokens: input.lastRecentChatTokens ?? null,
    lastRecentToolTokens: input.lastRecentToolTokens ?? null,
    lastMemoryRecallTokens: input.lastMemoryRecallTokens ?? null,
    lastCompactedSummaryTokens: input.lastCompactedSummaryTokens ?? null,
    lastRecentChatCount: input.lastRecentChatCount ?? null,
    lastRecentToolCount: input.lastRecentToolCount ?? null,
    lastMemoryRecallCount: input.lastMemoryRecallCount ?? null,
    lastCompactedSummaryCount: input.lastCompactedSummaryCount ?? null,
    activeChatCompactionId: input.activeChatCompactionId ?? null,
    activeToolSummaryId: input.activeToolSummaryId ?? null,
    toolContextMode: input.toolContextMode ?? null,
  };
  await dba.prepare(
    `
      INSERT INTO memory_prompt_stats (
        scope,
        last_assembled_token_estimate,
        last_recent_tokens,
        last_summary_tokens,
        last_recall_tokens,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        last_assembled_token_estimate = excluded.last_assembled_token_estimate,
        last_recent_tokens = excluded.last_recent_tokens,
        last_summary_tokens = excluded.last_summary_tokens,
        last_recall_tokens = excluded.last_recall_tokens,
        updated_at = excluded.updated_at
    `,
  ).run(
    normalizeMemoryText(input.scope || '') || 'global',
    input.lastAssembledTokenEstimate,
    input.lastRecentTokens,
    input.lastSummaryTokens,
    input.lastRecallTokens,
    updatedAt,
  );
}

export async function getMemoryPromptStats(): Promise<MemoryPromptStatsSnapshot> {
  const row = await dba
    .prepare(
      `
        SELECT
          last_assembled_token_estimate,
          last_recent_tokens,
          last_summary_tokens,
          last_recall_tokens
        FROM memory_prompt_stats
        ORDER BY updated_at DESC, scope ASC
        LIMIT 1
      `,
    )
    .get() as
    | {
        last_assembled_token_estimate: number | null;
        last_recent_tokens: number | null;
        last_summary_tokens: number | null;
        last_recall_tokens: number | null;
      }
    | undefined;

  return {
    lastAssembledTokenEstimate:
      row?.last_assembled_token_estimate ?? null,
    lastRecentTokens: row?.last_recent_tokens ?? null,
    lastSummaryTokens: row?.last_summary_tokens ?? null,
    lastRecallTokens: row?.last_recall_tokens ?? null,
    lastRecentChatTokens: lastPromptLaneSnapshot?.lastRecentChatTokens ?? null,
    lastRecentToolTokens: lastPromptLaneSnapshot?.lastRecentToolTokens ?? null,
    lastMemoryRecallTokens: lastPromptLaneSnapshot?.lastMemoryRecallTokens ?? null,
    lastCompactedSummaryTokens:
      lastPromptLaneSnapshot?.lastCompactedSummaryTokens ?? null,
    lastRecentChatCount: lastPromptLaneSnapshot?.lastRecentChatCount ?? null,
    lastRecentToolCount: lastPromptLaneSnapshot?.lastRecentToolCount ?? null,
    lastMemoryRecallCount: lastPromptLaneSnapshot?.lastMemoryRecallCount ?? null,
    lastCompactedSummaryCount:
      lastPromptLaneSnapshot?.lastCompactedSummaryCount ?? null,
    activeChatCompactionId: lastPromptLaneSnapshot?.activeChatCompactionId ?? null,
    activeToolSummaryId: lastPromptLaneSnapshot?.activeToolSummaryId ?? null,
    toolContextMode: lastPromptLaneSnapshot?.toolContextMode ?? null,
  };
}

export async function getMemoryIdentityStats(): Promise<MemoryIdentityStatsSnapshot> {
  const summary = await dba
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM person_profiles) AS total_profiles,
          (SELECT COUNT(*) FROM conversation_identity_bindings) AS bound_conversations,
          (SELECT COUNT(*) FROM identity_aliases) AS aliases
      `,
    )
    .get() as
    | {
        total_profiles: number | null;
        bound_conversations: number | null;
        aliases: number | null;
      }
    | undefined;

  return {
    totalProfiles: summary?.total_profiles || 0,
    boundConversations: summary?.bound_conversations || 0,
    aliases: summary?.aliases || 0,
  };
}

export async function getMemorySearchStats(options?: {
  now?: Date;
}): Promise<MemorySearchStatsSnapshot> {
  const createScopeQuality = (): MemorySearchScopeQualitySnapshot => ({
    indexedResults24h: 0,
    followupReads24h: 0,
    recalls24h: 0,
    followupReadRate24h: null,
  });
  const createSourceQuality = (): MemorySearchSourceQualitySnapshot => ({
    indexedResults24h: 0,
    followupReads24h: 0,
    recalls24h: 0,
    followupReadRate24h: null,
  });
  const cutoff = new Date(
    (options?.now || new Date()).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const summary = await dba
    .prepare(
      `
        SELECT
          COUNT(*) AS indexed_documents,
          MAX(updated_at) AS last_indexed_at
        FROM memory_documents
      `,
    )
    .get() as
    | {
        indexed_documents: number | null;
        last_indexed_at: string | null;
      }
    | undefined;
  const syncSummary = await dba
    .prepare(
      `
        SELECT
          COUNT(*) AS sync_state_documents,
          MAX(last_synced_at) AS last_sync_pass_at
        FROM memory_document_sync_state
      `,
    )
    .get() as
    | {
        sync_state_documents: number | null;
        last_sync_pass_at: string | null;
      }
    | undefined;
  const userMemoryProjection = await getUserMemoryProjectionStats();
  const recalls = await dba
    .prepare(
      `
        SELECT content_json, source_ref, group_folder
        FROM context_entries
        WHERE source_type = 'memory_recall'
          AND created_at >= ?
      `,
    )
    .all(cutoff) as Array<{
    content_json: string | null;
    source_ref: string | null;
    group_folder: string | null;
  }>;
  const recallBySource: Record<string, number> = {};
  const byScope: Record<'group' | 'global', MemorySearchScopeQualitySnapshot> =
    {
      group: createScopeQuality(),
      global: createScopeQuality(),
    };
  const sourceBuckets = new Map<string, MemorySearchSourceQualitySnapshot>();
  const getSourceBucket = (source: string): MemorySearchSourceQualitySnapshot => {
    const normalized = String(source || '').trim() || 'unknown';
    const existing = sourceBuckets.get(normalized);
    if (existing) return existing;
    const next = createSourceQuality();
    sourceBuckets.set(normalized, next);
    return next;
  };
  const events = await dba
    .prepare(
      `
        SELECT
          event_type,
          scope,
          owner_type,
          owner_id,
          metadata_json
        FROM memory_search_events
        WHERE created_at >= ?
      `,
    )
    .all(cutoff) as Array<{
    event_type: MemorySearchEventType;
    scope: string | null;
    owner_type: string | null;
    owner_id: string | null;
    metadata_json: string | null;
  }>;
  const eventsByType = new Map<MemorySearchEventType, number>();
  let indexedResultCount24h = 0;
  const groupBuckets = new Map<string, MemorySearchGroupQualitySnapshot>();
  const getGroupBucket = (groupFolder: string): MemorySearchGroupQualitySnapshot => {
    const normalized = String(groupFolder || '').trim();
    const existing = groupBuckets.get(normalized);
    if (existing) return existing;
    const next: MemorySearchGroupQualitySnapshot = {
      groupFolder: normalized,
      indexedResults24h: 0,
      followupReads24h: 0,
      recalls24h: 0,
      followupReadRate24h: null,
    };
    groupBuckets.set(normalized, next);
    return next;
  };
  for (const row of events) {
    eventsByType.set(row.event_type, (eventsByType.get(row.event_type) || 0) + 1);
    if (row.event_type === 'search_index_hit') {
      let resultCount = 0;
      let scopeCounts:
        | {
            group?: number | null;
            global?: number | null;
          }
        | null = null;
      let sourceTypeCounts: Record<string, number> | null = null;
      let memoryClassCounts: Record<string, number> | null = null;
      try {
        const parsed = row.metadata_json
          ? (JSON.parse(row.metadata_json) as {
              resultCount?: number | null;
              scopeCounts?: {
                group?: number | null;
                global?: number | null;
              } | null;
              sourceTypeCounts?: Record<string, number> | null;
              memoryClassCounts?: Record<string, number> | null;
            })
          : null;
        resultCount =
          typeof parsed?.resultCount === 'number' &&
          Number.isFinite(parsed.resultCount)
            ? Math.max(0, Math.trunc(parsed.resultCount))
            : 0;
        scopeCounts = parsed?.scopeCounts || null;
        sourceTypeCounts = parsed?.sourceTypeCounts || null;
        memoryClassCounts = parsed?.memoryClassCounts || null;
      } catch {
        resultCount = 0;
      }
      indexedResultCount24h += resultCount;
      if (scopeCounts) {
        byScope.group.indexedResults24h +=
          typeof scopeCounts.group === 'number' &&
          Number.isFinite(scopeCounts.group)
            ? Math.max(0, Math.trunc(scopeCounts.group))
            : 0;
        byScope.global.indexedResults24h +=
          typeof scopeCounts.global === 'number' &&
          Number.isFinite(scopeCounts.global)
            ? Math.max(0, Math.trunc(scopeCounts.global))
            : 0;
      } else if (row.scope === 'group' || row.scope === 'global') {
        byScope[row.scope].indexedResults24h += resultCount;
      }
      if (row.owner_type === 'group' && row.owner_id) {
        getGroupBucket(row.owner_id).indexedResults24h += resultCount;
      }
      const sourceCounts =
        memoryClassCounts && Object.keys(memoryClassCounts).length > 0
          ? memoryClassCounts
          : sourceTypeCounts;
      if (sourceCounts) {
        for (const [sourceKey, count] of Object.entries(sourceCounts)) {
          if (typeof count !== 'number' || !Number.isFinite(count)) continue;
          getSourceBucket(sourceKey).indexedResults24h += Math.max(
            0,
            Math.trunc(count),
          );
        }
      }
      continue;
    }
    if (row.event_type === 'search_followup_read') {
      const scope =
        row.scope === 'global'
          ? 'global'
          : row.scope === 'group'
            ? 'group'
            : null;
      if (scope) {
        byScope[scope].followupReads24h += 1;
      }
      if (row.owner_type === 'group' && row.owner_id) {
        getGroupBucket(row.owner_id).followupReads24h += 1;
      }
      let sourceKey = 'unknown';
      try {
        const parsed = row.metadata_json
          ? (JSON.parse(row.metadata_json) as {
              sourceType?: string;
              memoryClass?: string;
            })
          : null;
        sourceKey =
          normalizeMemoryText(parsed?.memoryClass || '') ||
          normalizeMemoryText(parsed?.sourceType || '') ||
          sourceKey;
      } catch {
        sourceKey = 'unknown';
      }
      getSourceBucket(sourceKey).followupReads24h += 1;
    }
  }

  for (const row of recalls) {
    let sourceKey = 'unknown';
    let scopeKey: 'group' | 'global' | null = null;
    try {
      const parsed = row.content_json
        ? (JSON.parse(row.content_json) as {
            scope?: string;
            path?: string;
            sourceType?: string;
            memoryClass?: string;
          })
        : null;
      if (parsed?.memoryClass) {
        sourceKey = parsed.memoryClass;
      } else if (parsed?.sourceType) {
        sourceKey = parsed.sourceType;
      }
      if (parsed?.scope) {
        scopeKey =
          parsed.scope === 'global'
            ? 'global'
            : parsed.scope === 'group'
              ? 'group'
              : null;
      } else if (parsed?.path && parsed.path.includes(':')) {
        sourceKey = parsed.path.split(':', 1)[0] || sourceKey;
        scopeKey =
          sourceKey === 'global'
            ? 'global'
            : sourceKey === 'group'
              ? 'group'
              : null;
      } else if (row.source_ref && row.source_ref.includes(':')) {
        sourceKey = row.source_ref.split(':', 1)[0] || sourceKey;
        scopeKey =
          sourceKey === 'global'
            ? 'global'
            : sourceKey === 'group'
              ? 'group'
              : null;
      }
    } catch {
      if (row.source_ref && row.source_ref.includes(':')) {
        sourceKey = row.source_ref.split(':', 1)[0] || sourceKey;
        scopeKey =
          sourceKey === 'global'
            ? 'global'
            : sourceKey === 'group'
              ? 'group'
              : null;
      }
    }
    recallBySource[sourceKey] = (recallBySource[sourceKey] || 0) + 1;
    getSourceBucket(sourceKey).recalls24h += 1;
    if (scopeKey) {
      byScope[scopeKey].recalls24h += 1;
    }
    if (row.group_folder) {
      getGroupBucket(row.group_folder).recalls24h += 1;
    }
  }

  const indexedHitCount24h = eventsByType.get('search_index_hit') || 0;
  const searchFollowupReadCount24h =
    eventsByType.get('search_followup_read') || 0;
  const followupReadRate24h =
    indexedResultCount24h > 0
      ? searchFollowupReadCount24h / indexedResultCount24h
      : null;
  const fallbackSyncCount24h =
    eventsByType.get('search_fallback_sync') || 0;
  const freshnessRecheckCount24h =
    eventsByType.get('search_freshness_recheck') || 0;
  const staleRefreshCount24h =
    eventsByType.get('search_stale_refresh') || 0;
  const filesSynced24h = eventsByType.get('sync_file_updated') || 0;
  const filesSkipped24h = eventsByType.get('sync_file_skipped') || 0;
  const filesDeleted24h = eventsByType.get('sync_file_deleted') || 0;
  for (const scope of ['group', 'global'] as const) {
    byScope[scope].followupReadRate24h =
      byScope[scope].indexedResults24h > 0
        ? byScope[scope].followupReads24h / byScope[scope].indexedResults24h
        : null;
  }
  const topGroups = [...groupBuckets.values()]
    .map((bucket) => ({
      ...bucket,
      followupReadRate24h:
        bucket.indexedResults24h > 0
          ? bucket.followupReads24h / bucket.indexedResults24h
          : null,
    }))
    .filter(
      (bucket) =>
        bucket.groupFolder &&
        (bucket.indexedResults24h > 0 ||
          bucket.followupReads24h > 0 ||
          bucket.recalls24h > 0),
    )
    .sort((left, right) => {
      if (right.indexedResults24h !== left.indexedResults24h) {
        return right.indexedResults24h - left.indexedResults24h;
      }
      if (right.followupReads24h !== left.followupReads24h) {
        return right.followupReads24h - left.followupReads24h;
      }
      if (right.recalls24h !== left.recalls24h) {
        return right.recalls24h - left.recalls24h;
      }
      return left.groupFolder.localeCompare(right.groupFolder);
    })
    .slice(0, 5);
  const bySourceEntries = [...sourceBuckets.entries()]
    .map(
      ([source, bucket]): [string, MemorySearchSourceQualitySnapshot] => [
        source,
        {
          ...bucket,
          followupReadRate24h:
            bucket.indexedResults24h > 0
              ? bucket.followupReads24h / bucket.indexedResults24h
              : null,
        },
      ],
    )
    .sort(([leftSource, leftBucket], [rightSource, rightBucket]) => {
      if (rightBucket.indexedResults24h !== leftBucket.indexedResults24h) {
        return rightBucket.indexedResults24h - leftBucket.indexedResults24h;
      }
      if (rightBucket.followupReads24h !== leftBucket.followupReads24h) {
        return rightBucket.followupReads24h - leftBucket.followupReads24h;
      }
      if (rightBucket.recalls24h !== leftBucket.recalls24h) {
        return rightBucket.recalls24h - leftBucket.recalls24h;
      }
      return leftSource.localeCompare(rightSource);
    });
  const bySource = Object.fromEntries(bySourceEntries);

  return {
    indexedDocuments: summary?.indexed_documents || 0,
    syncStateDocuments: syncSummary?.sync_state_documents || 0,
    userMemoryProjection,
    lastIndexedAt: summary?.last_indexed_at || null,
    lastSyncPassAt: syncSummary?.last_sync_pass_at || null,
    recallCount24h: recalls.length,
    recallBySource,
    indexedHitCount24h,
    indexedResultCount24h,
    searchFollowupReadCount24h,
    followupReadRate24h,
    fallbackSyncCount24h,
    freshnessRecheckCount24h,
    staleRefreshCount24h,
    filesSynced24h,
    filesSkipped24h,
    filesDeleted24h,
    byScope: {
      group: byScope.group,
      global: byScope.global,
    },
    bySource,
    topGroups,
    sync: {
      indexedHitCount24h,
      indexedResultCount24h,
      searchFollowupReadCount24h,
      followupReadRate24h,
      fallbackSyncCount24h,
      freshnessRecheckCount24h,
      staleRefreshCount24h,
      filesSynced24h,
      filesSkipped24h,
      filesDeleted24h,
      lastSyncPassAt: syncSummary?.last_sync_pass_at || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Embedding Vectors
// ---------------------------------------------------------------------------

export async function getEmbeddingByOwner(
  ownerType: string,
  ownerId: string,
  embeddingProviderId?: string | null,
): Promise<{ id: string; content_hash: string; embedding: Buffer } | null> {
  const providerSql = embeddingProviderId === undefined
    ? ''
    : embeddingProviderId === null
      ? ' AND embedding_provider_id IS NULL'
      : ' AND embedding_provider_id = ?';
  const providerParams =
    embeddingProviderId === undefined || embeddingProviderId === null
      ? []
      : [embeddingProviderId];
  const rows = (await dba
    .prepare(`SELECT id, content_hash, embedding FROM embedding_vectors WHERE owner_type = ? AND owner_id = ?${providerSql}`)
    .all(ownerType, ownerId, ...providerParams)) as Array<{ id: string; content_hash: string; embedding: Buffer }>;
  return rows[0] ?? null;
}

/** One query for many owners of the same type (e.g. batch embed). */
export async function getEmbeddingsByOwnerBatch(
  ownerType: string,
  ownerIds: string[],
  embeddingProviderId?: string | null,
): Promise<Map<string, { id: string; content_hash: string; embedding: Buffer }>> {
  const unique = [...new Set(ownerIds)];
  const result = new Map<string, { id: string; content_hash: string; embedding: Buffer }>();
  if (unique.length === 0) {
    return result;
  }
  const placeholders = unique.map(() => '?').join(', ');
  const providerSql = embeddingProviderId === undefined
    ? ''
    : embeddingProviderId === null
      ? ' AND embedding_provider_id IS NULL'
      : ' AND embedding_provider_id = ?';
  const providerParams =
    embeddingProviderId === undefined || embeddingProviderId === null
      ? []
      : [embeddingProviderId];
  const rows = (await dba
    .prepare(
      `SELECT id, owner_id, content_hash, embedding FROM embedding_vectors WHERE owner_type = ? AND owner_id IN (${placeholders})${providerSql}`,
    )
    .all(ownerType, ...unique, ...providerParams)) as Array<{
    id: string;
    owner_id: string;
    content_hash: string;
    embedding: Buffer;
  }>;
  for (const row of rows) {
    result.set(row.owner_id, {
      id: row.id,
      content_hash: row.content_hash,
      embedding: row.embedding,
    });
  }
  return result;
}

export async function upsertEmbeddingVector(
  id: string,
  ownerType: string,
  ownerId: string,
  embeddingProviderId: string | null,
  contentHash: string,
  embedding: Buffer,
  dimensions: number,
  modelName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(`INSERT OR REPLACE INTO embedding_vectors
        (id, owner_type, owner_id, embedding_provider_id, content_hash, embedding, dimensions, model_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    )
    .run(id, ownerType, ownerId, embeddingProviderId, contentHash, embedding, dimensions, modelName, now);
}

export async function getAllEmbeddingsByType(
  ownerType: string,
  embeddingProviderId?: string | null,
): Promise<Array<{ id: string; owner_id: string; owner_type: string; embedding: Buffer }>> {
  const providerSql = embeddingProviderId === undefined
    ? ''
    : embeddingProviderId === null
      ? ' AND embedding_provider_id IS NULL'
      : ' AND embedding_provider_id = ?';
  const providerParams =
    embeddingProviderId === undefined || embeddingProviderId === null
      ? []
      : [embeddingProviderId];
  return (await dba
    .prepare(`SELECT id, owner_id, owner_type, embedding FROM embedding_vectors WHERE owner_type = ?${providerSql}`)
    .all(ownerType, ...providerParams)) as Array<{ id: string; owner_id: string; owner_type: string; embedding: Buffer }>;
}

export async function deleteEmbeddingByOwner(
  ownerType: string,
  ownerId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM embedding_vectors WHERE owner_type = ? AND owner_id = ?`)
    .run(ownerType, ownerId);
}

// ---------------------------------------------------------------------------
// Knowledge Bases
// ---------------------------------------------------------------------------
