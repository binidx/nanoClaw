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

export async function listAllUserIds(): Promise<string[]> {
  const rows = (await dba
    .prepare(`SELECT DISTINCT user_id FROM user_souls WHERE enabled = 1`)
    .all()) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}
