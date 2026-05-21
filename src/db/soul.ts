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
import {
  ASSISTANT_NAME,
  DATA_DIR,
  STORE_DIR,
  invalidateStartupConfigCache,
} from '../config.js';
import { type DbEngine } from '../database/engine.js';
import { getPgFtsConfig } from '../database/pg-fts-config.js';
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
import {
  createPlaceholders,
  estimateTokenCount,
  normalizeMemoryText,
} from './sql-utils.js';

export async function getUserSoul(
  userId: string,
): Promise<UserSoulRecord | undefined> {
  return (await dba
    .prepare(`SELECT * FROM user_souls WHERE user_id = ?`)
    .get(userId)) as UserSoulRecord | undefined;
}

export async function upsertUserSoul(soul: UserSoulRecord): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getUserSoul(soul.user_id);
  if (existing) {
    await dba
      .prepare(
        adaptSql(`
          UPDATE user_souls
          SET name = ?, emoji = ?, emoji_enabled = ?, creature = ?, vibe = ?,
              persona_prompt = ?, tone = ?, language_preference = ?,
              extra_instructions = ?, user_nickname = ?, behavior_rules = ?,
              auto_evolve = ?, consolidation_config = ?, enabled = ?,
              updated_at = ?
          WHERE user_id = ?
        `),
      )
      .run(
        soul.name,
        soul.emoji,
        soul.emoji_enabled,
        soul.creature,
        soul.vibe,
        soul.persona_prompt,
        soul.tone,
        soul.language_preference,
        soul.extra_instructions,
        soul.user_nickname,
        soul.behavior_rules,
        soul.auto_evolve,
        soul.consolidation_config,
        soul.enabled,
        now,
        soul.user_id,
      );
  } else {
    await dba
      .prepare(
        adaptSql(`
          INSERT INTO user_souls (id, user_id, name, emoji, emoji_enabled,
            creature, vibe, persona_prompt, tone, language_preference,
            extra_instructions, user_nickname, behavior_rules, auto_evolve,
            consolidation_config, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
      )
      .run(
        soul.id,
        soul.user_id,
        soul.name,
        soul.emoji,
        soul.emoji_enabled,
        soul.creature,
        soul.vibe,
        soul.persona_prompt,
        soul.tone,
        soul.language_preference,
        soul.extra_instructions,
        soul.user_nickname,
        soul.behavior_rules,
        soul.auto_evolve,
        soul.consolidation_config,
        soul.enabled,
        now,
        now,
      );
  }
}

export async function deleteUserSoul(userId: string): Promise<void> {
  await dba.prepare(`DELETE FROM user_souls WHERE user_id = ?`).run(userId);
}

// ---------------------------------------------------------------------------
// User Memories (unified per-user memory system)
// ---------------------------------------------------------------------------

export async function getUserMemories(
  userId: string,
  opts?: {
    scope?: string;
    category?: string;
    conversationId?: string;
    tier?: string;
    limit?: number;
    timeScope?: 'current' | 'all';
    queryTime?: string;
  },
): Promise<UserMemoryRecord[]> {
  const limit = opts?.limit ?? 50;
  const timeScope = opts?.timeScope ?? 'current';
  const conditions = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (opts?.scope) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts?.category) {
    conditions.push('category = ?');
    params.push(opts.category);
  }
  if (opts?.conversationId) {
    conditions.push('conversation_id = ?');
    params.push(opts.conversationId);
  }
  if (opts?.tier) {
    conditions.push('tier = ?');
    params.push(opts.tier);
  }
  if (timeScope === 'current') {
    const qt = opts?.queryTime ?? new Date().toISOString();
    conditions.push('(valid_from IS NULL OR valid_from <= ?)');
    params.push(qt);
    conditions.push('(valid_to IS NULL OR valid_to > ?)');
    params.push(qt);
    conditions.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(qt);
  }

  params.push(limit);
  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params)) as UserMemoryRecord[];
}

export async function listUserMemoriesForProjectionRepair(options?: {
  userId?: string;
  limit?: number;
}): Promise<UserMemoryRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options?.userId) {
    conditions.push('user_id = ?');
    params.push(options.userId);
  }
  const limit = options?.limit
    ? Math.max(1, Math.min(Math.trunc(options.limit), 10000))
    : null;
  if (limit) params.push(limit);
  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY updated_at DESC, id ASC
       ${limit ? 'LIMIT ?' : ''}`,
    )
    .all(...params)) as UserMemoryRecord[];
}

export async function getUserMemoryById(
  id: string,
  userId?: string,
): Promise<UserMemoryRecord | undefined> {
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  return (await dba
    .prepare(
      `SELECT * FROM user_memories WHERE ${conditions.join(' AND ')} LIMIT 1`,
    )
    .get(...params)) as UserMemoryRecord | undefined;
}

export async function getUserCoreMemories(
  userId: string,
  opts?: { queryTime?: string },
): Promise<UserMemoryRecord[]> {
  const qt = opts?.queryTime ?? new Date().toISOString();
  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       WHERE user_id = ? AND importance >= 8
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC, updated_at DESC`,
    )
    .all(userId, qt, qt, qt)) as UserMemoryRecord[];
}

export async function searchUserMemories(
  userId: string,
  query: string,
  opts?: {
    scope?: string;
    conversationId?: string;
    limit?: number;
    timeScope?: 'current' | 'all';
    queryTime?: string;
  },
): Promise<UserMemoryRecord[]> {
  const limit = opts?.limit ?? 10;
  const dialect = eng().dialect;
  const timeScope = opts?.timeScope ?? 'current';

  const conditions: string[] = [];
  const params: unknown[] = [];

  function applyTimeScopeConditions(prefix: string) {
    if (timeScope !== 'current') return;
    const qt = opts?.queryTime ?? new Date().toISOString();
    conditions.push(
      `(${prefix}valid_from IS NULL OR ${prefix}valid_from <= ?)`,
    );
    params.push(qt);
    conditions.push(`(${prefix}valid_to IS NULL OR ${prefix}valid_to > ?)`);
    params.push(qt);
    conditions.push(`(${prefix}expires_at IS NULL OR ${prefix}expires_at > ?)`);
    params.push(qt);
  }

  if (dialect === 'postgres') {
    conditions.push('um.user_id = ?');
    params.push(userId);
    if (opts?.scope) {
      conditions.push('um.scope = ?');
      params.push(opts.scope);
    }
    if (opts?.conversationId) {
      conditions.push("(um.scope = 'global' OR um.conversation_id = ?)");
      params.push(opts.conversationId);
    }
    applyTimeScopeConditions('um.');
    const cfg = getPgFtsConfig();
    conditions.push(
      `to_tsvector('${cfg}', um.content) @@ plainto_tsquery('${cfg}', ?)`,
    );
    params.push(query);
    params.push(query); // second ref for ts_rank ORDER BY
    params.push(limit);

    try {
      return (await dba
        .prepare(
          `SELECT um.* FROM user_memories um
           WHERE ${conditions.join(' AND ')}
           ORDER BY ts_rank(to_tsvector('${cfg}', um.content), plainto_tsquery('${cfg}', ?)) DESC, um.importance DESC
           LIMIT ?`,
        )
        .all(...params)) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE fallback
    }
  } else if (dialect === 'mysql') {
    conditions.push('um.user_id = ?');
    params.push(userId);
    if (opts?.scope) {
      conditions.push('um.scope = ?');
      params.push(opts.scope);
    }
    if (opts?.conversationId) {
      conditions.push("(um.scope = 'global' OR um.conversation_id = ?)");
      params.push(opts.conversationId);
    }
    applyTimeScopeConditions('um.');
    conditions.push('MATCH(um.content) AGAINST(? IN BOOLEAN MODE)');
    params.push(query);
    params.push(query); // second ref for relevance scoring in SELECT
    params.push(limit);

    try {
      return (await dba
        .prepare(
          `SELECT um.*, MATCH(um.content) AGAINST(? IN BOOLEAN MODE) AS relevance
           FROM user_memories um
           WHERE ${conditions.join(' AND ')}
           ORDER BY relevance DESC, um.importance DESC
           LIMIT ?`,
        )
        .all(...params)) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE fallback
    }
  } else {
    // SQLite: try FTS5 first
    conditions.push('um.user_id = ?');
    params.push(userId);
    if (opts?.scope) {
      conditions.push('um.scope = ?');
      params.push(opts.scope);
    }
    if (opts?.conversationId) {
      conditions.push("(um.scope = 'global' OR um.conversation_id = ?)");
      params.push(opts.conversationId);
    }
    applyTimeScopeConditions('um.');
    params.push(query, limit);

    try {
      return (await dba
        .prepare(
          `SELECT um.* FROM user_memories um
           JOIN user_memories_fts fts ON um.rowid = fts.rowid
           WHERE ${conditions.join(' AND ')}
             AND user_memories_fts MATCH ?
           ORDER BY um.importance DESC
           LIMIT ?`,
        )
        .all(...params)) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE fallback
    }
  }

  // Universal LIKE fallback
  const fbConditions = ['user_id = ?'];
  const fbParams: unknown[] = [userId];
  if (opts?.scope) {
    fbConditions.push('scope = ?');
    fbParams.push(opts.scope);
  }
  if (opts?.conversationId) {
    fbConditions.push("(scope = 'global' OR conversation_id = ?)");
    fbParams.push(opts.conversationId);
  }
  if (timeScope === 'current') {
    const qt = opts?.queryTime ?? new Date().toISOString();
    fbConditions.push('(valid_from IS NULL OR valid_from <= ?)');
    fbParams.push(qt);
    fbConditions.push('(valid_to IS NULL OR valid_to > ?)');
    fbParams.push(qt);
    fbConditions.push('(expires_at IS NULL OR expires_at > ?)');
    fbParams.push(qt);
  }
  fbConditions.push('content LIKE ?');
  fbParams.push(`%${query}%`, limit);

  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       WHERE ${fbConditions.join(' AND ')}
       ORDER BY importance DESC
       LIMIT ?`,
    )
    .all(...fbParams)) as UserMemoryRecord[];
}

export async function addUserMemory(memory: UserMemoryRecord): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO user_memories
          (id, user_id, scope, conversation_id, category, content,
           importance, confidence, source, tier, promoted_from,
           last_verified_at, source_event_id, valid_from, valid_to,
           access_count, last_accessed_at,
           expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      memory.id,
      memory.user_id,
      memory.scope,
      memory.conversation_id,
      memory.category,
      memory.content,
      memory.importance,
      memory.confidence ?? 0.5,
      memory.source,
      memory.tier ?? 'durable',
      memory.promoted_from ?? null,
      memory.last_verified_at ?? null,
      memory.source_event_id ?? null,
      memory.valid_from ?? now,
      memory.valid_to ?? null,
      0,
      null,
      memory.expires_at,
      now,
      now,
    );
}

export async function updateUserMemory(
  id: string,
  userId: string,
  updates: {
    content?: string;
    category?: string;
    importance?: number;
    confidence?: number;
    scope?: string;
    tier?: string;
    validFrom?: string | null;
    validTo?: string | null;
    expiresAt?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content);
  }
  if (updates.category !== undefined) {
    sets.push('category = ?');
    params.push(updates.category);
  }
  if (updates.importance !== undefined) {
    sets.push('importance = ?');
    params.push(updates.importance);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(updates.confidence);
  }
  if (updates.scope !== undefined) {
    sets.push('scope = ?');
    params.push(updates.scope);
  }
  if (updates.tier !== undefined) {
    sets.push('tier = ?');
    params.push(updates.tier);
  }
  if (updates.validFrom !== undefined) {
    sets.push('valid_from = ?');
    params.push(updates.validFrom);
  }
  if (updates.validTo !== undefined) {
    sets.push('valid_to = ?');
    params.push(updates.validTo);
  }
  if (updates.expiresAt !== undefined) {
    sets.push('expires_at = ?');
    params.push(updates.expiresAt);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id, userId);
  await dba
    .prepare(
      `UPDATE user_memories SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    )
    .run(...params);
}

export async function deleteUserMemory(
  id: string,
  userId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM user_memories WHERE id = ? AND user_id = ?`)
    .run(id, userId);
}

export async function touchUserMemoryAccess(id: string): Promise<void> {
  await dba
    .prepare(
      `UPDATE user_memories
       SET access_count = access_count + 1,
           last_accessed_at = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
}

export async function findSimilarUserMemories(
  userId: string,
  category: string,
  query: string,
  limit = 5,
): Promise<UserMemoryRecord[]> {
  const dialect = eng().dialect;
  const now = new Date().toISOString();

  if (dialect === 'postgres') {
    const cfg = getPgFtsConfig();
    try {
      return (await dba
        .prepare(
          `SELECT * FROM user_memories
           WHERE user_id = ? AND category = ?
             AND (valid_from IS NULL OR valid_from <= ?)
             AND (valid_to IS NULL OR valid_to > ?)
             AND (expires_at IS NULL OR expires_at > ?)
             AND to_tsvector('${cfg}', content) @@ plainto_tsquery('${cfg}', ?)
           LIMIT ?`,
        )
        .all(
          userId,
          category,
          now,
          now,
          now,
          query,
          limit,
        )) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE
    }
  } else if (dialect === 'mysql') {
    try {
      return (await dba
        .prepare(
          `SELECT * FROM user_memories
           WHERE user_id = ? AND category = ?
             AND (valid_from IS NULL OR valid_from <= ?)
             AND (valid_to IS NULL OR valid_to > ?)
             AND (expires_at IS NULL OR expires_at > ?)
             AND MATCH(content) AGAINST(? IN BOOLEAN MODE)
           LIMIT ?`,
        )
        .all(
          userId,
          category,
          now,
          now,
          now,
          query,
          limit,
        )) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE
    }
  } else {
    try {
      return (await dba
        .prepare(
          `SELECT um.* FROM user_memories um
           JOIN user_memories_fts fts ON um.rowid = fts.rowid
           WHERE um.user_id = ? AND um.category = ?
             AND (um.valid_from IS NULL OR um.valid_from <= ?)
             AND (um.valid_to IS NULL OR um.valid_to > ?)
             AND (um.expires_at IS NULL OR um.expires_at > ?)
             AND user_memories_fts MATCH ?
           LIMIT ?`,
        )
        .all(
          userId,
          category,
          now,
          now,
          now,
          query,
          limit,
        )) as UserMemoryRecord[];
    } catch {
      // fall through to LIKE
    }
  }

  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       WHERE user_id = ? AND category = ? AND content LIKE ?
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT ?`,
    )
    .all(
      userId,
      category,
      `%${query}%`,
      now,
      now,
      now,
      limit,
    )) as UserMemoryRecord[];
}

export async function getRecentlyAccessedMemories(
  userId: string,
  limit = 5,
): Promise<UserMemoryRecord[]> {
  const now = new Date().toISOString();
  return (await dba
    .prepare(
      `SELECT * FROM user_memories
       WHERE user_id = ? AND last_accessed_at IS NOT NULL
         AND (valid_from IS NULL OR valid_from <= ?)
         AND (valid_to IS NULL OR valid_to > ?)
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY last_accessed_at DESC
       LIMIT ?`,
    )
    .all(userId, now, now, now, limit)) as UserMemoryRecord[];
}

export async function addMemoryExtractionLog(
  record: MemoryExtractionLogRecord,
): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO memory_extraction_log
          (id, user_id, conversation_id, source_message_ids,
           extracted_memories, model_used, tokens_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      record.id,
      record.user_id,
      record.conversation_id,
      record.source_message_ids,
      record.extracted_memories,
      record.model_used,
      record.tokens_used,
      record.created_at,
    );
}

export async function evictStaleUserMemories(): Promise<number> {
  const now = new Date();
  const thirtyDaysAgo = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ninetyDaysAgo = new Date(
    now.getTime() - 90 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const deleteResult = await dba
    .prepare(
      `DELETE FROM user_memories
       WHERE importance <= 2 AND access_count = 0 AND created_at < ?`,
    )
    .run(thirtyDaysAgo);

  await dba
    .prepare(
      `UPDATE user_memories
       SET expires_at = ?
       WHERE importance <= 4
         AND (last_accessed_at IS NULL OR last_accessed_at < ?)
         AND expires_at IS NULL`,
    )
    .run(now.toISOString(), ninetyDaysAgo);

  return typeof deleteResult === 'object' &&
    deleteResult !== null &&
    'changes' in deleteResult
    ? (deleteResult as { changes: number }).changes
    : 0;
}

// ---------------------------------------------------------------------------
// User Memory Observations CRUD
// ---------------------------------------------------------------------------

export async function listUserMemoryObservations(
  userId: string,
  opts?: { observationType?: string; limit?: number; unpromoted?: boolean },
): Promise<UserMemoryObservationRecord[]> {
  const limit = opts?.limit ?? 50;
  const clauses = ['user_id = ?'];
  const params: Array<string | number> = [userId];
  if (opts?.observationType) {
    clauses.push('observation_type = ?');
    params.push(opts.observationType);
  }
  if (opts?.unpromoted) {
    clauses.push('promoted_to IS NULL');
  }
  params.push(limit);
  return (await dba
    .prepare(
      `SELECT * FROM user_memory_observations
       WHERE ${clauses.join(' AND ')}
       ORDER BY frequency DESC, confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params)) as UserMemoryObservationRecord[];
}

export async function addUserMemoryObservation(
  record: UserMemoryObservationRecord,
): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO user_memory_observations
          (id, user_id, conversation_id, category, content, observation_type,
           frequency, last_seen_at, confidence, source, promoted_to,
           expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      record.id,
      record.user_id,
      record.conversation_id,
      record.category,
      record.content,
      record.observation_type,
      record.frequency,
      record.last_seen_at,
      record.confidence,
      record.source,
      record.promoted_to,
      record.expires_at,
      record.created_at,
      record.updated_at,
    );
}

export async function updateUserMemoryObservation(
  id: string,
  userId: string,
  updates: {
    frequency?: number;
    confidence?: number;
    last_seen_at?: string;
    promoted_to?: string;
    content?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (updates.frequency !== undefined) {
    sets.push('frequency = ?');
    params.push(updates.frequency);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(updates.confidence);
  }
  if (updates.last_seen_at !== undefined) {
    sets.push('last_seen_at = ?');
    params.push(updates.last_seen_at);
  }
  if (updates.promoted_to !== undefined) {
    sets.push('promoted_to = ?');
    params.push(updates.promoted_to);
  }
  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id, userId);
  await dba
    .prepare(
      `UPDATE user_memory_observations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    )
    .run(...params);
}

export async function deleteUserMemoryObservation(
  id: string,
  userId: string,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM user_memory_observations WHERE id = ? AND user_id = ?`,
    )
    .run(id, userId);
}

export async function findSimilarObservations(
  userId: string,
  category: string,
  content: string,
): Promise<UserMemoryObservationRecord[]> {
  const keywords = content
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5);
  if (keywords.length === 0) return [];
  const likeClauses = keywords.map(() => 'content LIKE ?');
  const params: Array<string | number> = [userId, category];
  for (const kw of keywords) params.push(`%${kw}%`);
  return (await dba
    .prepare(
      `SELECT * FROM user_memory_observations
       WHERE user_id = ? AND category = ?
         AND (${likeClauses.join(' OR ')})
       ORDER BY frequency DESC LIMIT 5`,
    )
    .all(...params)) as UserMemoryObservationRecord[];
}

export async function pruneExpiredObservations(
  userId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const result = await dba
    .prepare(
      `DELETE FROM user_memory_observations
       WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .run(userId, now);
  return typeof result === 'object' && result !== null && 'changes' in result
    ? (result as { changes: number }).changes
    : 0;
}

export async function getPromotionCandidateObservations(
  userId: string,
  minFrequency: number,
  minConfidence: number,
): Promise<UserMemoryObservationRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM user_memory_observations
       WHERE user_id = ? AND promoted_to IS NULL
         AND frequency >= ? AND confidence >= ?
       ORDER BY frequency DESC, confidence DESC
       LIMIT 50`,
    )
    .all(userId, minFrequency, minConfidence)) as UserMemoryObservationRecord[];
}

// ---------------------------------------------------------------------------
// Persona Insights CRUD
// ---------------------------------------------------------------------------

export async function listPersonaInsights(
  userId: string,
  opts?: { status?: string; insightType?: string; limit?: number },
): Promise<PersonaInsightRecord[]> {
  const limit = opts?.limit ?? 50;
  const clauses = ['user_id = ?'];
  const params: Array<string | number> = [userId];
  if (opts?.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.insightType) {
    clauses.push('insight_type = ?');
    params.push(opts.insightType);
  }
  params.push(limit);
  return (await dba
    .prepare(
      `SELECT * FROM persona_insights
       WHERE ${clauses.join(' AND ')}
       ORDER BY confidence DESC, evidence_count DESC
       LIMIT ?`,
    )
    .all(...params)) as PersonaInsightRecord[];
}

export async function getActivePersonaInsights(
  userId: string,
): Promise<PersonaInsightRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM persona_insights
       WHERE user_id = ? AND status = 'active'
       ORDER BY confidence DESC`,
    )
    .all(userId)) as PersonaInsightRecord[];
}

export async function addPersonaInsight(
  record: PersonaInsightRecord,
): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO persona_insights
          (id, user_id, insight_type, content, evidence_count,
           confidence, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      record.id,
      record.user_id,
      record.insight_type,
      record.content,
      record.evidence_count,
      record.confidence,
      record.status,
      record.created_at,
      record.updated_at,
    );
}

export async function updatePersonaInsight(
  id: string,
  userId: string,
  updates: {
    content?: string;
    evidence_count?: number;
    confidence?: number;
    status?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: Array<string | number> = [];
  if (updates.content !== undefined) {
    sets.push('content = ?');
    params.push(updates.content);
  }
  if (updates.evidence_count !== undefined) {
    sets.push('evidence_count = ?');
    params.push(updates.evidence_count);
  }
  if (updates.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(updates.confidence);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id, userId);
  await dba
    .prepare(
      `UPDATE persona_insights SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
    )
    .run(...params);
}

export async function deletePersonaInsight(
  id: string,
  userId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM persona_insights WHERE id = ? AND user_id = ?`)
    .run(id, userId);
}

export async function findSimilarInsights(
  userId: string,
  insightType: string,
  content: string,
): Promise<PersonaInsightRecord[]> {
  const keywords = content
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5);
  if (keywords.length === 0) return [];
  const likeClauses = keywords.map(() => 'content LIKE ?');
  const params: Array<string | number> = [userId, insightType];
  for (const kw of keywords) params.push(`%${kw}%`);
  return (await dba
    .prepare(
      `SELECT * FROM persona_insights
       WHERE user_id = ? AND insight_type = ?
         AND (${likeClauses.join(' OR ')})
       ORDER BY confidence DESC LIMIT 5`,
    )
    .all(...params)) as PersonaInsightRecord[];
}

// ---------------------------------------------------------------------------
// Memory Consolidation Log CRUD
// ---------------------------------------------------------------------------

export async function addMemoryConsolidationLog(
  record: MemoryConsolidationLogRecord,
): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO memory_consolidation_log
          (id, user_id, run_type, observations_reviewed, promoted,
           merged, pruned, insights_generated, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      record.id,
      record.user_id,
      record.run_type,
      record.observations_reviewed,
      record.promoted,
      record.merged,
      record.pruned,
      record.insights_generated,
      record.duration_ms,
      record.created_at,
    );
}

export async function listMemoryConsolidationLogs(
  userId: string,
  limit = 20,
): Promise<MemoryConsolidationLogRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM memory_consolidation_log
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit)) as MemoryConsolidationLogRecord[];
}

export async function getLastConsolidationTime(
  userId: string,
): Promise<string | null> {
  const row = (await dba
    .prepare(
      `SELECT created_at FROM memory_consolidation_log
       WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(userId)) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

// ---------------------------------------------------------------------------
// Memory Events (Raw Ledger) CRUD
// ---------------------------------------------------------------------------

export async function recordMemoryEvent(
  event: Omit<MemoryEventRecord, 'id' | 'created_at'> & {
    id?: string;
    created_at?: string;
  },
): Promise<string> {
  const id = event.id || crypto.randomUUID();
  const createdAt = event.created_at || new Date().toISOString();
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO memory_events
          (id, user_id, scope, action_type, target_type, target_id,
           conversation_id, source_message_id,
           before_snapshot, after_snapshot, decision_reason,
           metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      id,
      event.user_id,
      event.scope,
      event.action_type,
      event.target_type,
      event.target_id,
      event.conversation_id,
      event.source_message_id,
      event.before_snapshot,
      event.after_snapshot,
      event.decision_reason,
      event.metadata_json,
      createdAt,
    );
  return id;
}

export async function listMemoryEvents(options: {
  userId?: string;
  targetType?: string;
  targetId?: string;
  actionType?: string;
  limit?: number;
  offset?: number;
}): Promise<MemoryEventRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.targetType) {
    clauses.push('target_type = ?');
    params.push(options.targetType);
  }
  if (options.targetId) {
    clauses.push('target_id = ?');
    params.push(options.targetId);
  }
  if (options.actionType) {
    clauses.push('action_type = ?');
    params.push(options.actionType);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = options.limit ?? 50;
  const offset = Math.max(0, Number(options.offset) || 0);
  params.push(limit, offset);
  return (await dba
    .prepare(
      adaptSql(`
        SELECT * FROM memory_events
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `),
    )
    .all(...params)) as MemoryEventRecord[];
}

export async function countMemoryEvents(options: {
  userId?: string;
  targetType?: string;
  targetId?: string;
  actionType?: string;
}): Promise<number> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.targetType) {
    clauses.push('target_type = ?');
    params.push(options.targetType);
  }
  if (options.targetId) {
    clauses.push('target_id = ?');
    params.push(options.targetId);
  }
  if (options.actionType) {
    clauses.push('action_type = ?');
    params.push(options.actionType);
  }
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = (await dba
    .prepare(
      adaptSql(`
        SELECT COUNT(*) AS cnt FROM memory_events
        ${whereClause}
      `),
    )
    .get(...params)) as { cnt?: number } | undefined;
  return Number(row?.cnt || 0);
}

export async function getMemoryEventCountSince(
  since: string,
  actionType?: string,
): Promise<number> {
  const clauses = ['created_at >= ?'];
  const params: unknown[] = [since];
  if (actionType) {
    clauses.push('action_type = ?');
    params.push(actionType);
  }
  const row = (await dba
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memory_events WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params)) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// Memory Skills (Procedural Memory) CRUD
// ---------------------------------------------------------------------------

export async function addMemorySkill(skill: MemorySkillRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(`
        INSERT INTO memory_skills
          (id, user_id, scope, name, trigger_pattern, body,
           termination_condition, success_count, failure_count,
           last_used_at, last_verified_at, status,
           metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    )
    .run(
      skill.id,
      skill.user_id,
      skill.scope,
      skill.name,
      skill.trigger_pattern,
      skill.body,
      skill.termination_condition,
      skill.success_count,
      skill.failure_count,
      skill.last_used_at,
      skill.last_verified_at,
      skill.status,
      skill.metadata_json,
      skill.created_at,
      skill.updated_at,
    );
}

export async function getMemorySkill(
  id: string,
): Promise<MemorySkillRecord | undefined> {
  return (await dba
    .prepare(`SELECT * FROM memory_skills WHERE id = ?`)
    .get(id)) as MemorySkillRecord | undefined;
}

export async function listMemorySkills(opts: {
  userId?: string;
  scope?: string;
  status?: string;
  limit?: number;
}): Promise<MemorySkillRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    conditions.push('user_id = ?');
    params.push(opts.userId);
  }
  if (opts.scope) {
    conditions.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(opts.limit ?? 50);
  return (await dba
    .prepare(
      `SELECT * FROM memory_skills
       ${whereClause}
       ORDER BY success_count DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params)) as MemorySkillRecord[];
}

export async function updateMemorySkill(
  id: string,
  updates: Partial<
    Pick<
      MemorySkillRecord,
      | 'name'
      | 'trigger_pattern'
      | 'body'
      | 'termination_condition'
      | 'success_count'
      | 'failure_count'
      | 'last_used_at'
      | 'last_verified_at'
      | 'status'
      | 'metadata_json'
    >
  >,
  userId?: string,
): Promise<boolean> {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      params.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  const where = userId ? 'WHERE id = ? AND user_id = ?' : 'WHERE id = ?';
  if (userId) params.push(userId);
  const result = await dba
    .prepare(`UPDATE memory_skills SET ${sets.join(', ')} ${where}`)
    .run(...params);
  return Number(result.changes || 0) > 0;
}

export async function recordSkillUsage(
  id: string,
  success: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const field = success ? 'success_count' : 'failure_count';
  await dba
    .prepare(
      `UPDATE memory_skills
       SET ${field} = ${field} + 1, last_used_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(now, now, id);
}

export async function deleteMemorySkill(
  id: string,
  userId?: string,
): Promise<boolean> {
  const result = userId
    ? await dba
        .prepare(`DELETE FROM memory_skills WHERE id = ? AND user_id = ?`)
        .run(id, userId)
    : await dba.prepare(`DELETE FROM memory_skills WHERE id = ?`).run(id);
  return Number(result.changes || 0) > 0;
}
