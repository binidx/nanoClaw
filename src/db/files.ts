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
import { logger } from '../logger.js';
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

// ---------------------------------------------------------------------------
// pending_uploads CRUD (runtime state persistence)
// ---------------------------------------------------------------------------

export interface PendingUploadRecord {
  id: string;
  chat_jid: string;
  message_id: string;
  files_json: string;
  upload_timestamp: string;
  created_at: string;
}

export async function savePendingUpload(record: PendingUploadRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO pending_uploads (id, chat_jid, message_id, files_json, upload_timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET files_json = excluded.files_json, upload_timestamp = excluded.upload_timestamp
      `),
    )
    .run(record.id, record.chat_jid, record.message_id, record.files_json, record.upload_timestamp, record.created_at);
}

export async function getPendingUploadsByChat(chatJid: string): Promise<PendingUploadRecord[]> {
  return (await dba
    .prepare(`SELECT * FROM pending_uploads WHERE chat_jid = ?`)
    .all(chatJid)) as PendingUploadRecord[];
}

export async function getAllPendingUploads(): Promise<PendingUploadRecord[]> {
  return (await dba
    .prepare(`SELECT * FROM pending_uploads ORDER BY created_at ASC`)
    .all()) as PendingUploadRecord[];
}

export async function deletePendingUpload(id: string): Promise<void> {
  await dba.prepare(`DELETE FROM pending_uploads WHERE id = ?`).run(id);
}

export async function deletePendingUploadsByChat(chatJid: string): Promise<void> {
  await dba.prepare(`DELETE FROM pending_uploads WHERE chat_jid = ?`).run(chatJid);
}

// ---------------------------------------------------------------------------
// runtime_state CRUD
// ---------------------------------------------------------------------------

export async function setRuntimeState(key: string, value: string): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO runtime_state (state_key, state_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = excluded.updated_at
      `),
    )
    .run(key, value, new Date().toISOString());
}

export async function getRuntimeState(key: string): Promise<string | null> {
  const row = (await dba
    .prepare(`SELECT state_value FROM runtime_state WHERE state_key = ?`)
    .get(key)) as { state_value: string } | undefined;
  return row?.state_value ?? null;
}

export async function deleteRuntimeState(key: string): Promise<void> {
  await dba.prepare(`DELETE FROM runtime_state WHERE state_key = ?`).run(key);
}

// ---------------------------------------------------------------------------
// file_store CRUD
// ---------------------------------------------------------------------------

export interface FileStoreRecord {
  id?: number;
  category: string;
  path_ref: string;
  content: string;
  content_hash: string | null;
  metadata_json: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export async function upsertFileStoreEntry(entry: Omit<FileStoreRecord, 'id'>): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(
        `INSERT INTO file_store (category, path_ref, content, content_hash, metadata_json, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(category, path_ref, user_id) DO UPDATE SET
           content = excluded.content,
           content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      ),
    )
    .run(
      entry.category,
      entry.path_ref,
      entry.content,
      entry.content_hash || null,
      entry.metadata_json || null,
      entry.user_id || getCurrentUserId(),
      entry.created_at || now,
      entry.updated_at || now,
    );
}

export async function listFileStoreEntries(options?: {
  category?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<FileStoreRecord[]> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options?.category) {
    clauses.push('category = ?');
    params.push(options.category);
  }
  if (options?.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  const limit = Math.max(1, Math.min(options?.limit || 500, 2000));
  const offset = Math.max(0, options?.offset || 0);
  params.push(limit, offset);
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return (await dba
    .prepare(
      `SELECT id, category, path_ref, content, content_hash, metadata_json,
              user_id, created_at, updated_at
       FROM file_store
       ${whereSql}
       ORDER BY updated_at ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params)) as FileStoreRecord[];
}

export async function getFileStoreEntry(
  category: string,
  pathRef: string,
  userId?: string,
): Promise<FileStoreRecord | null> {
  const rows = (await dba
    .prepare(
      `SELECT id, category, path_ref, content, content_hash, metadata_json,
              user_id, created_at, updated_at
       FROM file_store
       WHERE category = ? AND path_ref = ? AND user_id = ?
       LIMIT 1`,
    )
    .all(category, pathRef, userId || getCurrentUserId())) as FileStoreRecord[];
  return rows[0] || null;
}

export async function deleteFileStoreEntry(
  category: string,
  pathRef: string,
  userId?: string,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM file_store WHERE category = ? AND path_ref = ? AND user_id = ?`,
    )
    .run(category, pathRef, userId || getCurrentUserId());
}
