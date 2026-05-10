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
// Live2D Models
// ---------------------------------------------------------------------------

export interface Live2DModelRecord {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  visibility: string;
  format: string;
  model_data: Buffer | null;
  thumbnail: Buffer | null;
  file_size: number;
  entry_file: string | null;
  /** Set on rows loaded from the DB; new records may omit until persisted. */
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface Live2DEmotionMappingRecord {
  id: string;
  model_id: string;
  emotion: string;
  motion_group: string | null;
  expression_name: string | null;
  priority: number;
}

export interface Live2DUserPreferencesRecord {
  id: string;
  user_id: string;
  enabled: number;
  selected_model_id: string | null;
  position: string;
  panel_width: number;
  opacity: number;
  emotion_provider_id: string | null;
  model_scale: number;
  model_offset_y: number;
  updated_at: string;
}

export async function getLive2DModels(userId: string): Promise<Omit<Live2DModelRecord, 'model_data'>[]> {
  return (await dba
    .prepare(
      `SELECT id, name, description, user_id, visibility, format, file_size, entry_file,
              created_by, updated_by, created_at, updated_at, deleted_at
       FROM live2d_models
       WHERE deleted_at IS NULL AND (visibility = 'public' OR user_id = ?)
       ORDER BY updated_at DESC`,
    )
    .all(userId)) as Omit<Live2DModelRecord, 'model_data'>[];
}

export async function getLive2DModel(id: string): Promise<Live2DModelRecord | undefined> {
  return (await dba
    .prepare('SELECT * FROM live2d_models WHERE id = ? AND deleted_at IS NULL')
    .get(id)) as Live2DModelRecord | undefined;
}

export async function getLive2DModelMeta(id: string): Promise<Omit<Live2DModelRecord, 'model_data' | 'thumbnail'> | undefined> {
  return (await dba
    .prepare(
      `SELECT id, name, description, user_id, visibility, format, file_size, entry_file,
              created_by, updated_by, created_at, updated_at, deleted_at
       FROM live2d_models WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(id)) as Omit<Live2DModelRecord, 'model_data' | 'thumbnail'> | undefined;
}

export async function insertLive2DModel(record: Live2DModelRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(`INSERT INTO live2d_models
        (id, name, description, user_id, visibility, format, model_data, thumbnail, file_size, entry_file,
         created_by, updated_by, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    )
    .run(
      record.id, record.name, record.description, record.user_id,
      record.visibility, record.format, record.model_data, record.thumbnail,
      record.file_size, record.entry_file, record.created_by, record.updated_by,
      record.deleted_at, record.created_at, record.updated_at,
    );
}

export async function updateLive2DModel(id: string, updates: Partial<Pick<Live2DModelRecord, 'name' | 'description' | 'visibility'>>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.visibility !== undefined) { sets.push('visibility = ?'); params.push(updates.visibility); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  await dba.prepare(`UPDATE live2d_models SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
}

export async function deleteLive2DModel(id: string): Promise<void> {
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  await dba.prepare('DELETE FROM live2d_emotion_mappings WHERE model_id = ?').run(id);
  await dba
    .prepare(
      'UPDATE live2d_models SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(now, now, userId, id);
}

export async function updateLive2DModelThumbnail(id: string, thumbnail: Buffer): Promise<void> {
  await dba.prepare('UPDATE live2d_models SET thumbnail = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(thumbnail, new Date().toISOString(), id);
}

export async function getLive2DModelData(id: string): Promise<Buffer | null> {
  const row = (await dba
    .prepare('SELECT model_data FROM live2d_models WHERE id = ? AND deleted_at IS NULL')
    .get(id)) as { model_data: Buffer | null } | undefined;
  return row?.model_data ?? null;
}

export async function getLive2DModelThumbnail(id: string): Promise<Buffer | null> {
  const row = (await dba
    .prepare('SELECT thumbnail FROM live2d_models WHERE id = ? AND deleted_at IS NULL')
    .get(id)) as { thumbnail: Buffer | null } | undefined;
  return row?.thumbnail ?? null;
}

// ---------------------------------------------------------------------------
// Live2D Emotion Mappings
// ---------------------------------------------------------------------------

export async function getLive2DEmotionMappings(modelId: string): Promise<Live2DEmotionMappingRecord[]> {
  return (await dba
    .prepare('SELECT * FROM live2d_emotion_mappings WHERE model_id = ? ORDER BY priority DESC')
    .all(modelId)) as Live2DEmotionMappingRecord[];
}

export async function setLive2DEmotionMappings(
  modelId: string,
  mappings: Omit<Live2DEmotionMappingRecord, 'id'>[],
): Promise<void> {
  await dba.prepare('DELETE FROM live2d_emotion_mappings WHERE model_id = ?').run(modelId);
  for (const m of mappings) {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await dba
      .prepare(
        adaptSql(`INSERT INTO live2d_emotion_mappings (id, model_id, emotion, motion_group, expression_name, priority)
          VALUES (?, ?, ?, ?, ?, ?)`),
      )
      .run(id, modelId, m.emotion, m.motion_group, m.expression_name, m.priority);
  }
}

// ---------------------------------------------------------------------------
// Live2D User Preferences
// ---------------------------------------------------------------------------

export async function getLive2DUserPreferences(userId: string): Promise<Live2DUserPreferencesRecord | undefined> {
  return (await dba
    .prepare('SELECT * FROM live2d_user_preferences WHERE user_id = ?')
    .get(userId)) as Live2DUserPreferencesRecord | undefined;
}

export async function upsertLive2DUserPreferences(
  userId: string,
  prefs: Partial<Omit<Live2DUserPreferencesRecord, 'id' | 'user_id' | 'updated_at'>>,
): Promise<void> {
  const existing = await getLive2DUserPreferences(userId);
  const now = new Date().toISOString();
  if (existing) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (prefs.enabled !== undefined) { sets.push('enabled = ?'); params.push(prefs.enabled); }
    if (prefs.selected_model_id !== undefined) { sets.push('selected_model_id = ?'); params.push(prefs.selected_model_id); }
    if (prefs.position !== undefined) { sets.push('position = ?'); params.push(prefs.position); }
    if (prefs.panel_width !== undefined) { sets.push('panel_width = ?'); params.push(prefs.panel_width); }
    if (prefs.opacity !== undefined) { sets.push('opacity = ?'); params.push(prefs.opacity); }
    if (prefs.emotion_provider_id !== undefined) { sets.push('emotion_provider_id = ?'); params.push(prefs.emotion_provider_id); }
    if (prefs.model_scale !== undefined) { sets.push('model_scale = ?'); params.push(prefs.model_scale); }
    if (prefs.model_offset_y !== undefined) { sets.push('model_offset_y = ?'); params.push(prefs.model_offset_y); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now);
    params.push(userId);
    await dba.prepare(`UPDATE live2d_user_preferences SET ${sets.join(', ')} WHERE user_id = ?`).run(...params);
  } else {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await dba
      .prepare(
        adaptSql(`INSERT INTO live2d_user_preferences
          (id, user_id, enabled, selected_model_id, position, panel_width, opacity, emotion_provider_id, model_scale, model_offset_y, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      )
      .run(
        id, userId,
        prefs.enabled ?? 0,
        prefs.selected_model_id ?? null,
        prefs.position ?? 'right',
        prefs.panel_width ?? 280,
        prefs.opacity ?? 100,
        prefs.emotion_provider_id ?? null,
        prefs.model_scale ?? 1.0,
        prefs.model_offset_y ?? 0,
        now,
      );
  }
}
