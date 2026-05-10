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

const CONFIG_CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { value: string | undefined; expiresAt: number }>();
let configCacheAllSnapshot: { data: Record<string, string>; expiresAt: number } | null = null;

export function invalidateConfigCache(key?: string): void {
  if (key) {
    configCache.delete(key);
  } else {
    configCache.clear();
  }
  configCacheAllSnapshot = null;
}

export function getConfigCachedSync(key: string): string | undefined {
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return undefined;
}

export async function getConfig(key: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const row = await dba.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  configCache.set(key, { value: row?.value, expiresAt: now + CONFIG_CACHE_TTL_MS });
  return row?.value;
}

export async function getConfigBatch(keys: string[]): Promise<Record<string, string | undefined>> {
  if (keys.length === 0) return {};
  const now = Date.now();
  const result: Record<string, string | undefined> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const cached = configCache.get(key);
    if (cached && cached.expiresAt > now) {
      result[key] = cached.value;
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const placeholders = createPlaceholders(missing.length);
    const rows = await dba
      .prepare(`SELECT key, value FROM config WHERE key IN (${placeholders})`)
      .all(...missing) as { key: string; value: string }[];
    const found = new Set<string>();
    for (const row of rows) {
      result[row.key] = row.value;
      configCache.set(row.key, { value: row.value, expiresAt: now + CONFIG_CACHE_TTL_MS });
      found.add(row.key);
    }
    for (const key of missing) {
      if (!found.has(key)) {
        result[key] = undefined;
        configCache.set(key, { value: undefined, expiresAt: now + CONFIG_CACHE_TTL_MS });
      }
    }
  }
  return result;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await dba.prepare(
    'INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)',
  ).run(key, value, new Date().toISOString());
  configCache.set(key, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  configCacheAllSnapshot = null;
  invalidateStartupConfigCache();
}

export async function getAllConfig(): Promise<Record<string, string>> {
  const now = Date.now();
  if (configCacheAllSnapshot && configCacheAllSnapshot.expiresAt > now) {
    return { ...configCacheAllSnapshot.data };
  }
  const rows = await dba.prepare('SELECT key, value FROM config').all() as {
    key: string;
    value: string;
  }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
    configCache.set(row.key, { value: row.value, expiresAt: now + CONFIG_CACHE_TTL_MS });
  }
  configCacheAllSnapshot = { data: { ...result }, expiresAt: now + CONFIG_CACHE_TTL_MS };
  return result;
}

export async function deleteConfig(key: string): Promise<void> {
  await dba.prepare('DELETE FROM config WHERE key = ?').run(key);
  invalidateConfigCache(key);
  invalidateStartupConfigCache();
}

// ── Stock Analysis config operations ──
