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
import { type DbEngine, getActiveEngine } from '../database/engine.js';
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
import type { RepositoryRecord, RepoFeatureRecord } from './repositories.js';

export type ReviewRemoteProvider = 'github' | 'gitlab' | 'gitea';
export type ReviewStage = 'commit' | 'push';
export type ReviewSourceMode = 'local' | 'remote' | 'both';
export type ReviewBlockingMode = 'hard_fail' | 'soft_fail';
export type ReviewScope =
  | 'auto'
  | 'staged_diff'
  | 'commit_range'
  | 'pr_compare'
  | 'compare';
export type ReviewResultState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'warned'
  | 'failed'
  | 'error'
  | 'skipped'
  | 'pending_manual'
  | 'manual_passed'
  | 'manual_failed';
export type ReviewDeliveryStatus =
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'skipped'
  | 'not_configured';
export type ReviewRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'error'
  | 'skipped';
export type ReviewOverall = 'pass' | 'warn' | 'fail' | 'error' | 'skipped';

export interface ReviewRepositoryRecord {
  id: string;
  name: string;
  language: string | null;
  local_repo_path: string | null;
  remote_provider: ReviewRemoteProvider | null;
  remote_repo_slug: string | null;
  remote_base_url: string | null;
  clone_url: string | null;
  default_target_branch: string | null;
  review_chat_jid: string | null;
  actor_mention_mappings_json: string;
  reviewer_usernames_json: string;
  local_hook_secret: string | null;
  webhook_secret: string | null;
  platform_token: string | null;
  auto_sync_enabled: number;
  auto_sync_interval_minutes: number;
  last_auto_sync_at: string | null;
  next_auto_sync_at: string | null;
  last_auto_sync_status: string | null;
  last_auto_sync_message: string | null;
  digest_daily_enabled: number;
  digest_weekly_enabled: number;
  digest_daily_hour: number;
  digest_weekly_day: number;
  digest_weekly_hour: number;
  last_digest_daily_at: string | null;
  next_digest_daily_at: string | null;
  last_digest_weekly_at: string | null;
  next_digest_weekly_at: string | null;
  enabled: number;
  allow_ai_fix: number;
  ssh_key_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReviewProfileRecord {
  id: string;
  repository_id: string;
  name: string;
  stage: ReviewStage;
  source_mode: ReviewSourceMode;
  blocking_mode: ReviewBlockingMode;
  pass_decision_mode: 'ai' | 'human';
  review_scope: ReviewScope;
  target_branches: string;
  skill_ids: string;
  mcp_server_ids: string;
  prompt_template: string | null;
  include_globs: string;
  exclude_globs: string;
  include_full_file_context: number;
  max_files: number;
  max_diff_bytes: number;
  write_to_chat: number;
  write_to_platform: number;
  provider_id: string | null;
  review_output_mode: string | null;
  diff_subagent_threshold: number;
  enabled: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReviewRunRecord {
  id: string;
  repository_id: string;
  profile_id: string | null;
  source: string;
  stage: ReviewStage;
  status: ReviewRunStatus;
  idempotency_key: string | null;
  baseline_source: string | null;
  result_state: ReviewResultState | null;
  overall: ReviewOverall | null;
  recommended_block: number;
  blocking_enforced: number;
  ref: string | null;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pr_mr_number: string | null;
  actor: string | null;
  user_id: string | null;
  summary: string | null;
  findings_json: string;
  file_reviews_json: string;
  commit_reviews_json: string;
  suggestions_json: string;
  changed_files_json: string;
  diff_bytes: number;
  callback_context_json: string | null;
  duration_ms: number | null;
  chat_delivery_status: ReviewDeliveryStatus | null;
  platform_status_delivery_status: ReviewDeliveryStatus | null;
  platform_comment_delivery_status: ReviewDeliveryStatus | null;
  platform_comment_id: string | null;
  platform_status: string | null;
  platform_comment_url: string | null;
  cloud_doc_token: string | null;
  cloud_doc_url: string | null;
  cloud_doc_title: string | null;
  cloud_doc_status: string | null;
  cloud_doc_last_error: string | null;
  last_delivery_error: string | null;
  delivery_retry_count: number;
  effective_rules_json: string | null;
  markdown_body: string | null;
  raw_model_output: string | null;
  manual_decision: string | null;
  manual_decision_by: string | null;
  manual_decision_at: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewBranchStateRecord {
  repository_id: string;
  stage: ReviewStage;
  branch: string;
  head_sha: string | null;
  baseline_sha: string | null;
  last_run_id: string | null;
  baseline_source: string | null;
  result_state: ReviewResultState | null;
  status: string | null;
  actor: string | null;
  summary: string | null;
  reviewed_at: string | null;
  updated_at: string;
}

export interface ReviewConversationBindingRecord {
  repository_id: string;
  chat_jid: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewRemoteBranchCacheRecord {
  repository_id: string;
  branches_json: string;
  fetched_at: string;
  updated_at: string;
}

/** Persisted code search index header (see `code_search_indexes` table). */
export interface CodeSearchIndexRecord {
  cache_key: string;
  root_directory: string;
  manifest_hash: string;
  build_options_json: string;
  generated_at: string;
  file_count: number;
  symbol_count: number;
  term_count: number;
  created_at: string;
  updated_at: string;
}

export interface CodeSearchIndexFileRecord {
  cache_key: string;
  relative_path: string;
  absolute_path: string;
  extension: string;
  language: string;
  byte_size: number;
  line_count: number;
  imports_json: string;
  previews_json: string;
}

export interface CodeSearchIndexSymbolRecord {
  cache_key: string;
  relative_path: string;
  ordinal: number;
  name: string;
  kind: string;
  line: number;
  column_number: number;
  signature: string;
}

export interface CodeSearchIndexTermRecord {
  cache_key: string;
  relative_path: string;
  ordinal: number;
  term: string;
}

export interface CodeSearchSnapshotRecord {
  index: CodeSearchIndexRecord;
  files: CodeSearchIndexFileRecord[];
  symbols: CodeSearchIndexSymbolRecord[];
  terms: CodeSearchIndexTermRecord[];
}

export type CodeSearchFileRecord = CodeSearchIndexFileRecord;
export type CodeSearchSymbolRecord = CodeSearchIndexSymbolRecord;
export type CodeSearchTermRecord = CodeSearchIndexTermRecord;

export interface CodeSearchSymbolUpsertInput {
  name: string;
  kind: string;
  line: number;
  column_number: number;
  signature: string;
}

export interface CodeSearchFileUpsertInput {
  relative_path: string;
  absolute_path: string;
  extension: string;
  language: string;
  byte_size: number;
  line_count: number;
  imports_json?: string | null;
  previews_json?: string | null;
  terms: string[];
  symbols: CodeSearchSymbolUpsertInput[];
}

export interface CodeSearchSnapshotUpsertInput {
  cache_key: string;
  root_directory: string;
  manifest_hash: string;
  build_options_json: string;
  generated_at: string;
  file_count: number;
  symbol_count: number;
  term_count: number;
  files: CodeSearchFileUpsertInput[];
}

export function safeParseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

export function safeParseJson<T>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface ReviewRepositoryUpsertInput {
  id: string;
  name: string;
  language?: string | null;
  local_repo_path?: string | null;
  remote_provider?: ReviewRemoteProvider | null;
  remote_repo_slug?: string | null;
  remote_base_url?: string | null;
  clone_url?: string | null;
  default_target_branch?: string | null;
  review_chat_jid?: string | null;
  actor_mention_mappings_json?: string | null;
  reviewer_usernames_json?: string | null;
  local_hook_secret?: string | null;
  webhook_secret?: string | null;
  platform_token?: string | null;
  auto_sync_enabled?: boolean;
  auto_sync_interval_minutes?: number;
  last_auto_sync_at?: string | null;
  next_auto_sync_at?: string | null;
  last_auto_sync_status?: string | null;
  last_auto_sync_message?: string | null;
  digest_daily_enabled?: boolean;
  digest_weekly_enabled?: boolean;
  digest_daily_hour?: number;
  digest_weekly_day?: number;
  digest_weekly_hour?: number;
  last_digest_daily_at?: string | null;
  next_digest_daily_at?: string | null;
  last_digest_weekly_at?: string | null;
  next_digest_weekly_at?: string | null;
  enabled: boolean;
  allow_ai_fix?: boolean;
  ssh_key_id?: string | null;
}

export interface ReviewProfileUpsertInput {
  id: string;
  repository_id: string;
  name: string;
  stage: ReviewStage;
  source_mode: ReviewSourceMode;
  blocking_mode: ReviewBlockingMode;
  pass_decision_mode: 'ai' | 'human';
  review_scope: ReviewScope;
  target_branches: string[];
  skill_ids: string[];
  mcp_server_ids: string[];
  prompt_template?: string | null;
  include_globs: string[];
  exclude_globs: string[];
  include_full_file_context: boolean;
  max_files: number;
  max_diff_bytes: number;
  write_to_chat: boolean;
  write_to_platform: boolean;
  provider_id?: string | null;
  review_output_mode?: string;
  diff_subagent_threshold: number;
  enabled: boolean;
}

export interface ReviewRunCreateInput {
  id: string;
  repository_id: string;
  userId?: string;
  profile_id?: string | null;
  source: string;
  stage: ReviewStage;
  status: ReviewRunStatus;
  idempotency_key?: string | null;
  baseline_source?: string | null;
  result_state?: ReviewResultState | null;
  ref?: string | null;
  branch?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  pr_mr_number?: string | null;
  actor?: string | null;
  chat_delivery_status?: ReviewDeliveryStatus | null;
  platform_status_delivery_status?: ReviewDeliveryStatus | null;
  platform_comment_delivery_status?: ReviewDeliveryStatus | null;
  platform_comment_id?: string | null;
  last_delivery_error?: string | null;
  delivery_retry_count?: number;
  effective_rules?: Record<string, unknown> | null;
  callback_context?: Record<string, unknown> | null;
}

export interface ReviewRunUpdateInput {
  idempotency_key?: string | null;
  status?: ReviewRunStatus;
  baseline_source?: string | null;
  result_state?: ReviewResultState | null;
  overall?: ReviewOverall | null;
  recommended_block?: boolean;
  blocking_enforced?: boolean;
  actor?: string | null;
  summary?: string | null;
  findings?: unknown[];
  file_reviews?: unknown[];
  commit_reviews?: unknown[];
  suggestions?: string[];
  changed_files?: string[];
  diff_bytes?: number;
  duration_ms?: number | null;
  chat_delivery_status?: ReviewDeliveryStatus | null;
  platform_status_delivery_status?: ReviewDeliveryStatus | null;
  platform_comment_delivery_status?: ReviewDeliveryStatus | null;
  platform_comment_id?: string | null;
  platform_status?: string | null;
  platform_comment_url?: string | null;
  cloud_doc_token?: string | null;
  cloud_doc_url?: string | null;
  cloud_doc_title?: string | null;
  cloud_doc_status?: string | null;
  cloud_doc_last_error?: string | null;
  last_delivery_error?: string | null;
  delivery_retry_count?: number;
  effective_rules?: Record<string, unknown> | null;
  markdown_body?: string | null;
  raw_model_output?: string | null;
  manual_decision?: string | null;
  manual_decision_by?: string | null;
  manual_decision_at?: string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  callback_context?: Record<string, unknown> | null;
}

export interface ReviewBranchStateUpsertInput {
  repository_id: string;
  stage: ReviewStage;
  branch: string;
  head_sha?: string | null;
  baseline_sha?: string | null;
  last_run_id?: string | null;
  baseline_source?: string | null;
  result_state?: ReviewResultState | null;
  status?: string | null;
  actor?: string | null;
  summary?: string | null;
  reviewed_at?: string | null;
}

export interface ReviewConversationBindingUpsertInput {
  repository_id: string;
  chat_jid: string;
}

function mergeRepoToReviewRecord(
  repo: RepositoryRecord,
  feature?: RepoFeatureRecord,
): ReviewRepositoryRecord {
  let cfg: Record<string, unknown> = {};
  if (feature) {
    try {
      cfg = JSON.parse(feature.config_json || '{}');
    } catch {
      cfg = {};
    }
  }
  return {
    id: repo.id,
    name: repo.name,
    language: repo.language,
    local_repo_path: repo.local_repo_path,
    remote_provider: repo.remote_provider as ReviewRemoteProvider | null,
    remote_repo_slug: repo.remote_repo_slug,
    remote_base_url: repo.remote_base_url,
    clone_url: repo.clone_url,
    default_target_branch: repo.default_target_branch,
    review_chat_jid: (cfg.review_chat_jid as string) ?? null,
    actor_mention_mappings_json:
      (cfg.actor_mention_mappings_json as string) ?? '[]',
    reviewer_usernames_json: (cfg.reviewer_usernames_json as string) ?? '[]',
    local_hook_secret: (cfg.local_hook_secret as string) ?? null,
    webhook_secret: (cfg.webhook_secret as string) ?? null,
    platform_token: (cfg.platform_token as string) ?? null,
    auto_sync_enabled: repo.auto_sync_enabled,
    auto_sync_interval_minutes: repo.auto_sync_interval_minutes,
    last_auto_sync_at: repo.last_auto_sync_at,
    next_auto_sync_at: repo.next_auto_sync_at,
    last_auto_sync_status: repo.last_auto_sync_status,
    last_auto_sync_message: repo.last_auto_sync_message,
    digest_daily_enabled: Number(cfg.digest_daily_enabled ?? 0),
    digest_weekly_enabled: Number(cfg.digest_weekly_enabled ?? 0),
    digest_daily_hour: Number(cfg.digest_daily_hour ?? 18),
    digest_weekly_day: Number(cfg.digest_weekly_day ?? 5),
    digest_weekly_hour: Number(cfg.digest_weekly_hour ?? 18),
    last_digest_daily_at: (cfg.last_digest_daily_at as string) ?? null,
    next_digest_daily_at: (cfg.next_digest_daily_at as string) ?? null,
    last_digest_weekly_at: (cfg.last_digest_weekly_at as string) ?? null,
    next_digest_weekly_at: (cfg.next_digest_weekly_at as string) ?? null,
    enabled: repo.enabled,
    allow_ai_fix: Number(cfg.allow_ai_fix ?? 0),
    ssh_key_id: repo.ssh_key_id ?? null,
    created_by: repo.created_by,
    updated_by: repo.updated_by,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    deleted_at: repo.deleted_at,
  };
}

async function tryReadRepoAsReviewRecord(
  id: string,
): Promise<ReviewRepositoryRecord | undefined> {
  const repo = (await dba
    .prepare('SELECT * FROM repositories WHERE id = ? AND deleted_at IS NULL')
    .get(id)) as RepositoryRecord | undefined;
  if (!repo) return undefined;
  const feature = (await dba
    .prepare(
      'SELECT * FROM repo_features WHERE repository_id = ? AND feature_type = ?',
    )
    .get(id, 'code_review')) as RepoFeatureRecord | undefined;
  return mergeRepoToReviewRecord(repo, feature);
}

async function tryListReposAsReviewRecords(
  orderSql: string,
  ...args: unknown[]
): Promise<ReviewRepositoryRecord[]> {
  const repos = (await dba
    .prepare(orderSql)
    .all(...args)) as RepositoryRecord[];
  if (repos.length === 0) return [];
  const placeholders = repos.map(() => '?').join(',');
  const features = (await dba
    .prepare(
      `SELECT * FROM repo_features WHERE repository_id IN (${placeholders}) AND feature_type = 'code_review'`,
    )
    .all(...repos.map((r) => r.id))) as RepoFeatureRecord[];
  const featureMap = new Map(features.map((f) => [f.repository_id, f]));
  return repos.map((r) => mergeRepoToReviewRecord(r, featureMap.get(r.id)));
}

export async function listReviewRepositories(): Promise<
  ReviewRepositoryRecord[]
> {
  try {
    return await tryListReposAsReviewRecords(
      `SELECT r.* FROM repositories r
       INNER JOIN repo_features f ON f.repository_id = r.id AND f.feature_type = 'code_review'
       WHERE r.deleted_at IS NULL
       ORDER BY r.enabled DESC, r.updated_at DESC, r.name ASC`,
    );
  } catch (err) {
    logger.warn(
      '[review] dual-read listReviewRepositories fallback: %s',
      String(err),
    );
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_repositories WHERE deleted_at IS NULL ORDER BY enabled DESC, updated_at DESC, name ASC`,
    )
    .all()) as ReviewRepositoryRecord[];
}

export async function listDueReviewRepositoriesForAutoSync(
  nowIso: string,
): Promise<ReviewRepositoryRecord[]> {
  try {
    return await tryListReposAsReviewRecords(
      `SELECT r.* FROM repositories r
       INNER JOIN repo_features f ON f.repository_id = r.id AND f.feature_type = 'code_review'
       WHERE r.deleted_at IS NULL
         AND r.enabled = 1
         AND r.auto_sync_enabled = 1
         AND r.remote_provider IS NOT NULL
         AND r.remote_provider <> ''
         AND r.next_auto_sync_at IS NOT NULL
         AND r.next_auto_sync_at <= ?
       ORDER BY r.next_auto_sync_at ASC, r.updated_at DESC, r.name ASC`,
      nowIso,
    );
  } catch (err) {
    logger.warn(
      '[review] dual-read listDueReviewRepositoriesForAutoSync fallback: %s',
      String(err),
    );
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_repositories
       WHERE deleted_at IS NULL
         AND enabled = 1
         AND auto_sync_enabled = 1
         AND remote_provider IS NOT NULL
         AND remote_provider <> ''
         AND next_auto_sync_at IS NOT NULL
         AND next_auto_sync_at <= ?
       ORDER BY next_auto_sync_at ASC, updated_at DESC, name ASC`,
    )
    .all(nowIso)) as ReviewRepositoryRecord[];
}

export async function listReviewRepositoriesForUser(
  userId: string,
): Promise<ReviewRepositoryRecord[]> {
  const nowIso = new Date().toISOString();
  try {
    return await tryListReposAsReviewRecords(
      `SELECT DISTINCT r.* FROM repositories r
       INNER JOIN repo_features f ON f.repository_id = r.id AND f.feature_type = 'code_review'
       WHERE r.deleted_at IS NULL AND r.id IN (
         SELECT m.repository_id FROM review_repository_members m WHERE m.user_id = ?
         UNION
         SELECT ra.resource_id FROM resource_access ra
           WHERE ra.resource_type IN ('review_repository', 'repository') AND ra.user_id = ?
           AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       )
       ORDER BY r.enabled DESC, r.updated_at DESC, r.name ASC`,
      userId,
      userId,
      nowIso,
    );
  } catch (err) {
    logger.warn(
      '[review] dual-read listReviewRepositoriesForUser fallback: %s',
      String(err),
    );
  }
  return (await dba
    .prepare(
      `SELECT DISTINCT r.* FROM review_repositories r
       WHERE r.deleted_at IS NULL AND r.id IN (
         SELECT m.repository_id FROM review_repository_members m WHERE m.user_id = ?
         UNION
         SELECT ra.resource_id FROM resource_access ra
           WHERE ra.resource_type IN ('review_repository', 'repository') AND ra.user_id = ?
           AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       )
       ORDER BY r.enabled DESC, r.updated_at DESC, r.name ASC`,
    )
    .all(userId, userId, nowIso)) as ReviewRepositoryRecord[];
}

export interface ReviewRepositoryMemberRecord {
  repository_id: string;
  user_id: string;
  access_level: string;
  granted_at: string;
  granted_by: string | null;
}

export async function listReviewRepositoryMembers(
  repositoryId: string,
): Promise<ReviewRepositoryMemberRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM review_repository_members WHERE repository_id = ? ORDER BY granted_at ASC`,
    )
    .all(repositoryId)) as ReviewRepositoryMemberRecord[];
}

export async function getReviewRepositoryMember(
  repositoryId: string,
  userId: string,
): Promise<ReviewRepositoryMemberRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_repository_members WHERE repository_id = ? AND user_id = ? LIMIT 1`,
    )
    .get(repositoryId, userId)) as ReviewRepositoryMemberRecord | undefined;
}

export async function upsertReviewRepositoryMember(
  repositoryId: string,
  userId: string,
  accessLevel: string,
  grantedBy: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO review_repository_members
         (repository_id, user_id, access_level, granted_at, granted_by)
         VALUES (?, ?, ?, ?, ?)`,
      ),
    )
    .run(repositoryId, userId, accessLevel, now, grantedBy);
}

export async function deleteReviewRepositoryMember(
  repositoryId: string,
  userId: string,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM review_repository_members WHERE repository_id = ? AND user_id = ?`,
    )
    .run(repositoryId, userId);
}

export async function isUserReviewRepositoryMember(
  repositoryId: string,
  userId: string,
  requiredLevel?: string,
): Promise<boolean> {
  const member = await getReviewRepositoryMember(repositoryId, userId);
  if (!member) return false;
  if (!requiredLevel) return true;
  const levels = ['viewer', 'reviewer', 'manager'];
  return levels.indexOf(member.access_level) >= levels.indexOf(requiredLevel);
}

export async function getReviewRepositoryById(
  id: string,
): Promise<ReviewRepositoryRecord | undefined> {
  try {
    const result = await tryReadRepoAsReviewRecord(id);
    if (result) return result;
  } catch (err) {
    logger.warn(
      '[review] dual-read getReviewRepositoryById fallback: %s',
      String(err),
    );
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_repositories WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(id)) as ReviewRepositoryRecord | undefined;
}

export async function saveReviewRepository(
  input: ReviewRepositoryUpsertInput,
): Promise<ReviewRepositoryRecord> {
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  const existing = await getReviewRepositoryById(input.id);

  await dba.transaction(async () => {
    const existingRepo = (await dba
      .prepare('SELECT * FROM repositories WHERE id = ? AND deleted_at IS NULL')
      .get(input.id)) as RepositoryRecord | undefined;

    if (existingRepo) {
      await dba
        .prepare(
          `UPDATE repositories SET
          name = ?, language = ?, local_repo_path = ?, remote_provider = ?, remote_repo_slug = ?,
          remote_base_url = ?, clone_url = ?, default_target_branch = ?, ssh_key_id = ?,
          auto_sync_enabled = ?, auto_sync_interval_minutes = ?,
          last_auto_sync_at = ?, next_auto_sync_at = ?, last_auto_sync_status = ?, last_auto_sync_message = ?,
          enabled = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          input.name,
          input.language || null,
          input.local_repo_path || null,
          input.remote_provider || null,
          input.remote_repo_slug || null,
          input.remote_base_url || null,
          input.clone_url || null,
          input.default_target_branch || null,
          input.ssh_key_id || null,
          input.auto_sync_enabled ? 1 : 0,
          input.auto_sync_interval_minutes || 30,
          input.last_auto_sync_at || null,
          input.next_auto_sync_at || null,
          input.last_auto_sync_status || null,
          input.last_auto_sync_message || null,
          input.enabled ? 1 : 0,
          userId,
          now,
          input.id,
        );
    } else {
      await dba
        .prepare(
          `INSERT INTO repositories (
          id, name, language, local_repo_path, remote_provider, remote_repo_slug,
          remote_base_url, clone_url, default_target_branch, ssh_key_id,
          auto_sync_enabled, auto_sync_interval_minutes,
          last_auto_sync_at, next_auto_sync_at, last_auto_sync_status, last_auto_sync_message,
          enabled, status, user_id, created_by, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.language || null,
          input.local_repo_path || null,
          input.remote_provider || null,
          input.remote_repo_slug || null,
          input.remote_base_url || null,
          input.clone_url || null,
          input.default_target_branch || null,
          input.ssh_key_id || null,
          input.auto_sync_enabled ? 1 : 0,
          input.auto_sync_interval_minutes || 30,
          input.last_auto_sync_at || null,
          input.next_auto_sync_at || null,
          input.last_auto_sync_status || null,
          input.last_auto_sync_message || null,
          input.enabled ? 1 : 0,
          'active',
          userId,
          userId,
          userId,
          now,
          now,
        );
    }

    const configJson = JSON.stringify({
      review_chat_jid: input.review_chat_jid || null,
      actor_mention_mappings_json: input.actor_mention_mappings_json || '[]',
      reviewer_usernames_json: input.reviewer_usernames_json || '[]',
      local_hook_secret: input.local_hook_secret || null,
      webhook_secret: input.webhook_secret || null,
      platform_token: input.platform_token || null,
      digest_daily_enabled: input.digest_daily_enabled ? 1 : 0,
      digest_weekly_enabled: input.digest_weekly_enabled ? 1 : 0,
      digest_daily_hour: input.digest_daily_hour ?? 18,
      digest_weekly_day: input.digest_weekly_day ?? 5,
      digest_weekly_hour: input.digest_weekly_hour ?? 18,
      last_digest_daily_at:
        existing?.last_digest_daily_at || input.last_digest_daily_at || null,
      next_digest_daily_at:
        existing?.next_digest_daily_at || input.next_digest_daily_at || null,
      last_digest_weekly_at:
        existing?.last_digest_weekly_at || input.last_digest_weekly_at || null,
      next_digest_weekly_at:
        existing?.next_digest_weekly_at || input.next_digest_weekly_at || null,
      allow_ai_fix: input.allow_ai_fix ? 1 : 0,
    });

    const existingFeature = (await dba
      .prepare(
        'SELECT * FROM repo_features WHERE repository_id = ? AND feature_type = ?',
      )
      .get(input.id, 'code_review')) as RepoFeatureRecord | undefined;
    if (existingFeature) {
      await dba
        .prepare(
          'UPDATE repo_features SET enabled = 1, config_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(configJson, now, existingFeature.id);
    } else {
      await dba
        .prepare(
          'INSERT INTO repo_features (id, repository_id, feature_type, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
        )
        .run('cr_' + input.id, input.id, 'code_review', configJson, now, now);
    }
  })();

  const result = await getReviewRepositoryById(input.id);
  if (!result)
    throw new Error(
      `Failed to read back review repository ${input.id} after save`,
    );
  return result;
}

export async function updateReviewRepositoryAutoSync(input: {
  repositoryId: string;
  lastAutoSyncAt?: string | null;
  nextAutoSyncAt?: string | null;
  lastAutoSyncStatus?: string | null;
  lastAutoSyncMessage?: string | null;
}): Promise<void> {
  const fields = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (input.lastAutoSyncAt !== undefined) {
    fields.push('last_auto_sync_at = ?');
    values.push(input.lastAutoSyncAt || null);
  }
  if (input.nextAutoSyncAt !== undefined) {
    fields.push('next_auto_sync_at = ?');
    values.push(input.nextAutoSyncAt || null);
  }
  if (input.lastAutoSyncStatus !== undefined) {
    fields.push('last_auto_sync_status = ?');
    values.push(input.lastAutoSyncStatus || null);
  }
  if (input.lastAutoSyncMessage !== undefined) {
    fields.push('last_auto_sync_message = ?');
    values.push(input.lastAutoSyncMessage || null);
  }

  values.push(input.repositoryId);
  await dba
    .prepare(
      `UPDATE repositories SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(...values);
}

export async function updateReviewRepositoryDigestTimestamps(input: {
  repositoryId: string;
  type: 'daily' | 'weekly';
  lastDigestAt?: string | null;
  nextDigestAt?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const feature = (await dba
    .prepare(
      'SELECT * FROM repo_features WHERE repository_id = ? AND feature_type = ?',
    )
    .get(input.repositoryId, 'code_review')) as RepoFeatureRecord | undefined;
  if (!feature) return;

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(feature.config_json || '{}');
  } catch {
    cfg = {};
  }

  const lastKey =
    input.type === 'daily' ? 'last_digest_daily_at' : 'last_digest_weekly_at';
  const nextKey =
    input.type === 'daily' ? 'next_digest_daily_at' : 'next_digest_weekly_at';
  if (input.lastDigestAt !== undefined)
    cfg[lastKey] = input.lastDigestAt || null;
  if (input.nextDigestAt !== undefined)
    cfg[nextKey] = input.nextDigestAt || null;

  await dba
    .prepare(
      'UPDATE repo_features SET config_json = ?, updated_at = ? WHERE id = ?',
    )
    .run(JSON.stringify(cfg), now, feature.id);
}

export interface DigestRunRecord {
  id: string;
  repository_id: string;
  type: string;
  scheduled_for: string;
  period_start: string;
  period_end: string;
  status: string;
  timezone: string;
  started_at: string;
  duration_ms: number;
  branch_count: number;
  commit_count: number;
  contributor_count: number;
  summary: string;
  cloud_doc_url: string;
  cloud_doc_status: string;
  delivery_status: string;
  delivery_error: string;
  error_message: string;
  created_at: string;
  completed_at: string;
}

export async function saveDigestRun(input: {
  id: string;
  repository_id: string;
  type: 'daily' | 'weekly';
  scheduled_for: string;
  period_start: string;
  period_end: string;
  status: string;
  timezone: string;
  started_at: string;
}): Promise<DigestRunRecord> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      `INSERT OR REPLACE INTO review_digest_runs (
      id, repository_id, type, scheduled_for, period_start, period_end, status,
      timezone, started_at, duration_ms,
      branch_count, commit_count, contributor_count, summary,
      cloud_doc_url, cloud_doc_status, delivery_status, delivery_error, error_message,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '', '', '', 'pending', '', '', ?, '')`,
    )
    .run(
      input.id,
      input.repository_id,
      input.type,
      input.scheduled_for,
      input.period_start,
      input.period_end,
      input.status,
      input.timezone,
      input.started_at,
      now,
    );
  return (await getDigestRunById(input.id))!;
}

export async function updateDigestRun(
  id: string,
  updates: Partial<
    Pick<
      DigestRunRecord,
      | 'status'
      | 'branch_count'
      | 'commit_count'
      | 'contributor_count'
      | 'summary'
      | 'cloud_doc_url'
      | 'cloud_doc_status'
      | 'delivery_status'
      | 'delivery_error'
      | 'error_message'
      | 'completed_at'
      | 'duration_ms'
    >
  >,
): Promise<DigestRunRecord | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return getDigestRunById(id);
  values.push(id);
  await dba
    .prepare(`UPDATE review_digest_runs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return getDigestRunById(id);
}

export async function getDigestRunById(
  id: string,
): Promise<DigestRunRecord | null> {
  return (
    ((await dba
      .prepare(`SELECT * FROM review_digest_runs WHERE id = ? LIMIT 1`)
      .get(id)) as DigestRunRecord | undefined) || null
  );
}

export async function listDigestRunsByRepository(
  repositoryId: string,
  limit = 20,
): Promise<DigestRunRecord[]> {
  return (await dba
    .prepare(
      adaptSql(
        `SELECT * FROM review_digest_runs WHERE repository_id = ? ORDER BY scheduled_for DESC, created_at DESC LIMIT ? OFFSET ?`,
      ),
    )
    .all(repositoryId, limit, 0)) as DigestRunRecord[];
}

export async function hasCompletedDigestRunForSchedule(
  repositoryId: string,
  type: 'daily' | 'weekly',
  scheduledFor: string,
): Promise<boolean> {
  const row = await dba
    .prepare(
      `SELECT 1 FROM review_digest_runs
     WHERE repository_id = ? AND type = ? AND scheduled_for = ? AND status = 'completed'
     LIMIT 1`,
    )
    .get(repositoryId, type, scheduledFor);
  return Boolean(row);
}

export async function hasRecentCompletedDigestRun(
  repositoryId: string,
  type: 'daily' | 'weekly',
  sinceIso: string,
): Promise<boolean> {
  const row = await dba
    .prepare(
      adaptSql(
        `SELECT 1 FROM review_digest_runs WHERE repository_id = ? AND type = ? AND status = 'completed' AND created_at >= ? LIMIT ? OFFSET ?`,
      ),
    )
    .get(repositoryId, type, sinceIso, 1, 0);
  return Boolean(row);
}

export async function deleteReviewRepository(id: string): Promise<void> {
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  await dba.transaction(async () => {
    await dba
      .prepare(
        `DELETE FROM review_conversation_bindings WHERE repository_id = ?`,
      )
      .run(id);
    await dba
      .prepare(`DELETE FROM review_remote_branch_cache WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(`DELETE FROM review_branch_states WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(
        `UPDATE review_profiles SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE repository_id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, userId, id);
    await dba
      .prepare(`DELETE FROM review_runs WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(`DELETE FROM review_digest_runs WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(`DELETE FROM code_map_ai_analyses WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(`DELETE FROM repo_features WHERE repository_id = ?`)
      .run(id);
    await dba
      .prepare(
        `UPDATE repositories SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, userId, id);
    await dba
      .prepare(
        `UPDATE review_repositories SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, userId, id);
  })();
}

export async function listReviewProfiles(
  repositoryId?: string,
): Promise<ReviewProfileRecord[]> {
  if (repositoryId) {
    return (await dba
      .prepare(
        `SELECT * FROM review_profiles WHERE repository_id = ? AND deleted_at IS NULL ORDER BY enabled DESC, updated_at DESC, name ASC`,
      )
      .all(repositoryId)) as ReviewProfileRecord[];
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_profiles WHERE deleted_at IS NULL ORDER BY enabled DESC, updated_at DESC, name ASC`,
    )
    .all()) as ReviewProfileRecord[];
}

export async function getReviewProfileById(
  id: string,
): Promise<ReviewProfileRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_profiles WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(id)) as ReviewProfileRecord | undefined;
}

export async function findMatchingReviewProfile(input: {
  repositoryId: string;
  stage: ReviewStage;
  sourceMode: Extract<ReviewSourceMode, 'local' | 'remote'>;
}): Promise<ReviewProfileRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_profiles
       WHERE repository_id = ?
         AND deleted_at IS NULL
         AND stage = ?
         AND enabled = 1
         AND source_mode IN (?, 'both')
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    )
    .get(input.repositoryId, input.stage, input.sourceMode)) as
    | ReviewProfileRecord
    | undefined;
}

export async function listMatchingReviewProfiles(input: {
  repositoryId: string;
  stage: ReviewStage;
  sourceMode: Extract<ReviewSourceMode, 'local' | 'remote'>;
}): Promise<ReviewProfileRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM review_profiles
       WHERE repository_id = ?
         AND deleted_at IS NULL
         AND stage = ?
         AND enabled = 1
         AND source_mode IN (?, 'both')
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(
      input.repositoryId,
      input.stage,
      input.sourceMode,
    )) as ReviewProfileRecord[];
}

export async function saveReviewProfile(
  input: ReviewProfileUpsertInput,
): Promise<ReviewProfileRecord> {
  const now = new Date().toISOString();
  const existing = await getReviewProfileById(input.id);
  await dba
    .prepare(
      `INSERT OR REPLACE INTO review_profiles (
      id, repository_id, name, stage, source_mode, blocking_mode, pass_decision_mode, review_scope,
      target_branches, skill_ids, mcp_server_ids, prompt_template, include_globs, exclude_globs,
      include_full_file_context, max_files, max_diff_bytes, write_to_chat, write_to_platform, provider_id,
      review_output_mode, diff_subagent_threshold, enabled, created_by, updated_by, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.id,
      input.repository_id,
      input.name,
      input.stage,
      input.source_mode,
      input.blocking_mode,
      input.pass_decision_mode,
      input.review_scope,
      JSON.stringify(input.target_branches),
      JSON.stringify(input.skill_ids),
      JSON.stringify(input.mcp_server_ids),
      input.prompt_template || null,
      JSON.stringify(input.include_globs),
      JSON.stringify(input.exclude_globs),
      input.include_full_file_context ? 1 : 0,
      input.max_files,
      input.max_diff_bytes,
      input.write_to_chat ? 1 : 0,
      input.write_to_platform ? 1 : 0,
      input.provider_id || null,
      input.review_output_mode || 'share_link',
      input.diff_subagent_threshold,
      input.enabled ? 1 : 0,
      existing?.created_by || getCurrentUserId(),
      getCurrentUserId(),
      existing?.created_at || now,
      now,
    );
  return (await getReviewProfileById(input.id))!;
}

export async function deleteReviewProfile(id: string): Promise<void> {
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  await dba.transaction(async () => {
    await dba
      .prepare(`UPDATE review_runs SET profile_id = NULL WHERE profile_id = ?`)
      .run(id);
    await dba
      .prepare(
        `UPDATE review_profiles SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, now, userId, id);
  })();
}

export async function createReviewRun(
  input: ReviewRunCreateInput,
): Promise<ReviewRunRecord> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      `INSERT INTO review_runs (
      id, repository_id, profile_id, idempotency_key, source, stage, status,
      baseline_source, result_state, ref, branch, base_sha, head_sha,
      pr_mr_number, actor, user_id, chat_delivery_status,
      platform_status_delivery_status, platform_comment_delivery_status,
      effective_rules_json, callback_context_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.repository_id,
      input.profile_id || null,
      input.idempotency_key != null && input.idempotency_key !== ''
        ? input.idempotency_key
        : null,
      input.source,
      input.stage,
      input.status,
      input.baseline_source || null,
      input.result_state || null,
      input.ref || null,
      input.branch || null,
      input.base_sha || null,
      input.head_sha || null,
      input.pr_mr_number || null,
      input.actor || null,
      input.userId || getCurrentUserId(),
      input.chat_delivery_status || null,
      input.platform_status_delivery_status || null,
      input.platform_comment_delivery_status || null,
      input.effective_rules ? JSON.stringify(input.effective_rules) : '{}',
      input.callback_context ? JSON.stringify(input.callback_context) : null,
      now,
      now,
    );
  return (await getReviewRunById(input.id))!;
}

export async function getReviewRunById(
  id: string,
): Promise<ReviewRunRecord | undefined> {
  return (await dba
    .prepare(`SELECT * FROM review_runs WHERE id = ? LIMIT 1`)
    .get(id)) as ReviewRunRecord | undefined;
}

export async function getReviewRunByIdempotencyKey(input: {
  repositoryId: string;
  idempotencyKey: string;
}): Promise<ReviewRunRecord | undefined> {
  if (!input.idempotencyKey) return undefined;
  return (await dba
    .prepare(
      `SELECT * FROM review_runs
       WHERE repository_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .get(input.repositoryId, input.idempotencyKey)) as
    | ReviewRunRecord
    | undefined;
}

export async function listRecentCompletedReviewRuns(
  repositoryId: string,
  limit = 10,
): Promise<ReviewRunRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM review_runs
       WHERE repository_id = ? AND status = 'completed'
       ORDER BY completed_at DESC, created_at DESC
       LIMIT ?`,
    )
    .all(repositoryId, limit)) as ReviewRunRecord[];
}

export async function listReviewRuns(
  repositoryId?: string,
): Promise<ReviewRunRecord[]> {
  if (repositoryId) {
    return (await dba
      .prepare(
        `SELECT * FROM review_runs
         WHERE repository_id = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 100`,
      )
      .all(repositoryId)) as ReviewRunRecord[];
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_runs
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 100`,
    )
    .all()) as ReviewRunRecord[];
}

export async function listReviewRunsForUser(
  userId: string,
  repositoryId?: string,
): Promise<ReviewRunRecord[]> {
  const nowIso = new Date().toISOString();
  const accessibleRepos = `(
    SELECT m.repository_id FROM review_repository_members m WHERE m.user_id = ?
    UNION
    SELECT ra.resource_id FROM resource_access ra
      WHERE ra.resource_type = 'review_repository' AND ra.user_id = ?
      AND (ra.expires_at IS NULL OR ra.expires_at > ?)
  )`;
  const runAccess = `(
    SELECT ra2.resource_id FROM resource_access ra2
      WHERE ra2.resource_type = 'review_run' AND ra2.user_id = ?
      AND (ra2.expires_at IS NULL OR ra2.expires_at > ?)
  )`;

  if (repositoryId) {
    return (await dba
      .prepare(
        `SELECT DISTINCT rr.* FROM review_runs rr
         WHERE (rr.repository_id IN ${accessibleRepos} OR rr.id IN ${runAccess})
         AND rr.repository_id = ?
         ORDER BY rr.updated_at DESC, rr.created_at DESC
         LIMIT 100`,
      )
      .all(
        userId,
        userId,
        nowIso,
        userId,
        nowIso,
        repositoryId,
      )) as ReviewRunRecord[];
  }
  return (await dba
    .prepare(
      `SELECT DISTINCT rr.* FROM review_runs rr
       WHERE rr.repository_id IN ${accessibleRepos} OR rr.id IN ${runAccess}
       ORDER BY rr.updated_at DESC, rr.created_at DESC
       LIMIT 100`,
    )
    .all(userId, userId, nowIso, userId, nowIso)) as ReviewRunRecord[];
}

/**
 * Returns all runs with status 'queued' or 'running' — used for stale-run
 * recovery at startup. Unlike listReviewRuns, this query has no LIMIT so it
 * will find every stuck run regardless of history depth.
 */
export async function listActiveReviewRuns(
  repositoryId?: string,
): Promise<ReviewRunRecord[]> {
  if (repositoryId) {
    return (await dba
      .prepare(
        `SELECT * FROM review_runs WHERE repository_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC`,
      )
      .all(repositoryId)) as ReviewRunRecord[];
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`,
    )
    .all()) as ReviewRunRecord[];
}

export interface ReviewRunSummaryQueryInput {
  repositoryId?: string;
  status?: string;
  branch?: string;
  keyword?: string;
  limit?: number;
  userId?: string;
}

const REVIEW_RUN_SUMMARY_COLUMNS = `
  rr.id, rr.repository_id, rr.profile_id, rr.source, rr.stage, rr.status, rr.idempotency_key,
  rr.baseline_source, rr.result_state, rr.overall, rr.recommended_block, rr.blocking_enforced,
  rr.ref, rr.branch, rr.base_sha, rr.head_sha, rr.pr_mr_number, rr.actor, rr.summary, rr.diff_bytes,
  rr.duration_ms, rr.chat_delivery_status, rr.platform_status_delivery_status,
  rr.platform_comment_delivery_status, rr.platform_comment_id, rr.platform_status,
  rr.platform_comment_url, rr.last_delivery_error, rr.delivery_retry_count,
  rr.cloud_doc_token, rr.cloud_doc_url, rr.cloud_doc_title, rr.cloud_doc_status,
  rr.cloud_doc_last_error, rr.callback_context_json,
  rr.manual_decision, rr.manual_decision_by, rr.manual_decision_at,
  rr.error, rr.started_at, rr.completed_at, rr.created_at, rr.updated_at
`.trim();

/**
 * Lightweight version of listReviewRuns that omits heavy JSON blob columns
 * (findings_json, file_reviews_json, commit_reviews_json, suggestions_json, changed_files_json,
 * callback_context_json, effective_rules_json) to reduce payload for list views.
 */
export async function listReviewRunsSummary(
  query: ReviewRunSummaryQueryInput = {},
): Promise<ReviewRunRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const repositoryId = String(query.repositoryId || '').trim();
  const status = String(query.status || '').trim();
  const branch = String(query.branch || '').trim();
  const keyword = String(query.keyword || '')
    .trim()
    .toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 100));
  const userId = String(query.userId || '').trim();

  if (repositoryId) {
    conditions.push(`rr.repository_id = ?`);
    values.push(repositoryId);
  }
  if (status) {
    conditions.push(`COALESCE(NULLIF(rr.overall, ''), rr.status) = ?`);
    values.push(status);
  }
  if (branch) {
    conditions.push(`rr.branch = ?`);
    values.push(branch);
  }
  if (keyword) {
    const parts = [
      "COALESCE(repo.name, legacy_repo.name, '')",
      "COALESCE(profile.name, '')",
      "COALESCE(rr.summary, '')",
      "COALESCE(rr.actor, '')",
      "COALESCE(rr.branch, '')",
      "COALESCE(rr.head_sha, '')",
      "COALESCE(rr.ref, '')",
    ];
    const concatExpr =
      getActiveEngine().dialect === 'mysql'
        ? `CONCAT_WS(' ', ${parts.join(', ')})`
        : parts.join(" || ' ' || ");
    conditions.push(`LOWER(TRIM(${concatExpr})) LIKE ?`);
    values.push(`%${keyword}%`);
  }
  if (userId) {
    const nowIso = new Date().toISOString();
    conditions.push(`(
      rr.repository_id IN (
        SELECT m.repository_id FROM review_repository_members m WHERE m.user_id = ?
        UNION
        SELECT ra.resource_id FROM resource_access ra
        WHERE ra.resource_type = 'review_repository'
          AND ra.user_id = ?
          AND (ra.expires_at IS NULL OR ra.expires_at > ?)
      )
      OR rr.id IN (
        SELECT ra2.resource_id FROM resource_access ra2
        WHERE ra2.resource_type = 'review_run'
          AND ra2.user_id = ?
          AND (ra2.expires_at IS NULL OR ra2.expires_at > ?)
      )
    )`);
    values.push(userId, userId, nowIso, userId, nowIso);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return (await dba
    .prepare(
      `SELECT ${REVIEW_RUN_SUMMARY_COLUMNS},
              '[]' AS findings_json,
              '[]' AS file_reviews_json,
              '[]' AS commit_reviews_json,
              '[]' AS suggestions_json,
              '[]' AS changed_files_json,
              rr.callback_context_json AS callback_context_json,
              NULL AS effective_rules_json
       FROM review_runs rr
       LEFT JOIN repositories repo ON repo.id = rr.repository_id AND repo.deleted_at IS NULL
       LEFT JOIN review_repositories legacy_repo ON legacy_repo.id = rr.repository_id AND legacy_repo.deleted_at IS NULL
       LEFT JOIN review_profiles profile ON profile.id = rr.profile_id AND profile.deleted_at IS NULL
       ${where}
       ORDER BY COALESCE(
         NULLIF(rr.completed_at, ''),
         NULLIF(rr.started_at, ''),
         NULLIF(rr.updated_at, ''),
         rr.created_at
       ) DESC,
       rr.created_at DESC,
       rr.id DESC
       LIMIT ?`,
    )
    .all(...values, limit)) as ReviewRunRecord[];
}

export interface ReviewRunFindingSummary {
  id: string;
  repository_id: string;
  branch: string | null;
  overall: string | null;
  status: string;
  summary: string | null;
  findings_json: string;
  completed_at: string | null;
  created_at: string;
}

export async function listReviewRunsForQuery(input: {
  repositoryIds?: string[];
  branch?: string;
  limit?: number;
}): Promise<ReviewRunFindingSummary[]> {
  const conditions: string[] = [`rr.status = 'completed'`];
  const values: unknown[] = [];
  if (input.repositoryIds && input.repositoryIds.length > 0) {
    const placeholders = input.repositoryIds.map(() => '?').join(', ');
    conditions.push(`rr.repository_id IN (${placeholders})`);
    values.push(...input.repositoryIds);
  }
  if (input.branch) {
    conditions.push(`rr.branch LIKE ?`);
    values.push(`%${input.branch}%`);
  }
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 10));
  const where = conditions.join(' AND ');
  return (await dba
    .prepare(
      `SELECT rr.id, rr.repository_id, rr.branch, rr.overall, rr.status,
              rr.summary, rr.findings_json, rr.completed_at, rr.created_at
       FROM review_runs rr
       WHERE ${where}
       ORDER BY COALESCE(NULLIF(rr.completed_at, ''), rr.created_at) DESC,
              rr.created_at DESC
       LIMIT ?`,
    )
    .all(...values, limit)) as ReviewRunFindingSummary[];
}

export async function updateReviewRun(
  id: string,
  updates: ReviewRunUpdateInput,
): Promise<ReviewRunRecord> {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];
  if (updates.idempotency_key !== undefined) {
    fields.push('idempotency_key = ?');
    values.push(
      updates.idempotency_key != null && updates.idempotency_key !== ''
        ? updates.idempotency_key
        : null,
    );
  }
  if (updates.baseline_source !== undefined) {
    fields.push('baseline_source = ?');
    values.push(updates.baseline_source || null);
  }
  if (updates.result_state !== undefined) {
    fields.push('result_state = ?');
    values.push(updates.result_state || null);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.overall !== undefined) {
    fields.push('overall = ?');
    values.push(updates.overall);
  }
  if (updates.recommended_block !== undefined) {
    fields.push('recommended_block = ?');
    values.push(updates.recommended_block ? 1 : 0);
  }
  if (updates.blocking_enforced !== undefined) {
    fields.push('blocking_enforced = ?');
    values.push(updates.blocking_enforced ? 1 : 0);
  }
  if (updates.actor !== undefined) {
    fields.push('actor = ?');
    values.push(updates.actor || null);
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary || null);
  }
  if (updates.findings !== undefined) {
    fields.push('findings_json = ?');
    values.push(JSON.stringify(updates.findings));
  }
  if (updates.file_reviews !== undefined) {
    fields.push('file_reviews_json = ?');
    values.push(JSON.stringify(updates.file_reviews));
  }
  if (updates.commit_reviews !== undefined) {
    fields.push('commit_reviews_json = ?');
    values.push(JSON.stringify(updates.commit_reviews));
  }
  if (updates.suggestions !== undefined) {
    fields.push('suggestions_json = ?');
    values.push(JSON.stringify(updates.suggestions));
  }
  if (updates.changed_files !== undefined) {
    fields.push('changed_files_json = ?');
    values.push(JSON.stringify(updates.changed_files));
  }
  if (updates.diff_bytes !== undefined) {
    fields.push('diff_bytes = ?');
    values.push(updates.diff_bytes);
  }
  if (updates.duration_ms !== undefined) {
    fields.push('duration_ms = ?');
    values.push(updates.duration_ms ?? null);
  }
  if (updates.chat_delivery_status !== undefined) {
    fields.push('chat_delivery_status = ?');
    values.push(updates.chat_delivery_status || null);
  }
  if (updates.platform_status_delivery_status !== undefined) {
    fields.push('platform_status_delivery_status = ?');
    values.push(updates.platform_status_delivery_status || null);
  }
  if (updates.platform_comment_delivery_status !== undefined) {
    fields.push('platform_comment_delivery_status = ?');
    values.push(updates.platform_comment_delivery_status || null);
  }
  if (updates.platform_comment_id !== undefined) {
    fields.push('platform_comment_id = ?');
    values.push(updates.platform_comment_id || null);
  }
  if (updates.platform_status !== undefined) {
    fields.push('platform_status = ?');
    values.push(updates.platform_status || null);
  }
  if (updates.platform_comment_url !== undefined) {
    fields.push('platform_comment_url = ?');
    values.push(updates.platform_comment_url || null);
  }
  if (updates.cloud_doc_token !== undefined) {
    fields.push('cloud_doc_token = ?');
    values.push(updates.cloud_doc_token || null);
  }
  if (updates.cloud_doc_url !== undefined) {
    fields.push('cloud_doc_url = ?');
    values.push(updates.cloud_doc_url || null);
  }
  if (updates.cloud_doc_title !== undefined) {
    fields.push('cloud_doc_title = ?');
    values.push(updates.cloud_doc_title || null);
  }
  if (updates.cloud_doc_status !== undefined) {
    fields.push('cloud_doc_status = ?');
    values.push(updates.cloud_doc_status || null);
  }
  if (updates.cloud_doc_last_error !== undefined) {
    fields.push('cloud_doc_last_error = ?');
    values.push(updates.cloud_doc_last_error || null);
  }
  if (updates.last_delivery_error !== undefined) {
    fields.push('last_delivery_error = ?');
    values.push(updates.last_delivery_error || null);
  }
  if (updates.delivery_retry_count !== undefined) {
    fields.push('delivery_retry_count = ?');
    values.push(updates.delivery_retry_count);
  }
  if (updates.effective_rules !== undefined) {
    fields.push('effective_rules_json = ?');
    values.push(
      updates.effective_rules ? JSON.stringify(updates.effective_rules) : '{}',
    );
  }
  if (updates.markdown_body !== undefined) {
    fields.push('markdown_body = ?');
    values.push(updates.markdown_body || null);
  }
  if (updates.raw_model_output !== undefined) {
    fields.push('raw_model_output = ?');
    values.push(updates.raw_model_output || null);
  }
  if (updates.manual_decision !== undefined) {
    fields.push('manual_decision = ?');
    values.push(updates.manual_decision || null);
  }
  if (updates.manual_decision_by !== undefined) {
    fields.push('manual_decision_by = ?');
    values.push(updates.manual_decision_by || null);
  }
  if (updates.manual_decision_at !== undefined) {
    fields.push('manual_decision_at = ?');
    values.push(updates.manual_decision_at || null);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error || null);
  }
  if (updates.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(updates.started_at || null);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at || null);
  }
  if (updates.callback_context !== undefined) {
    fields.push('callback_context_json = ?');
    values.push(
      updates.callback_context
        ? JSON.stringify(updates.callback_context)
        : null,
    );
  }
  values.push(id);
  await dba
    .prepare(`UPDATE review_runs SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return (await getReviewRunById(id))!;
}

/**
 * Atomically set the manual decision fields on a review run, but ONLY if
 * `manual_decision` is still NULL. Returns the updated record, or `null` if
 * the row was already decided by another request (lost the race).
 */
export async function setReviewRunManualDecision(input: {
  runId: string;
  resultState: string;
  manualDecision: string;
  manualDecisionBy: string;
  manualDecisionAt: string;
}): Promise<ReviewRunRecord | null> {
  const now = new Date().toISOString();
  const result = await dba
    .prepare(
      `UPDATE review_runs
         SET result_state = ?, manual_decision = ?, manual_decision_by = ?,
             manual_decision_at = ?, updated_at = ?
       WHERE id = ? AND (manual_decision IS NULL OR manual_decision = '')`,
    )
    .run(
      input.resultState,
      input.manualDecision,
      input.manualDecisionBy,
      input.manualDecisionAt,
      now,
      input.runId,
    );
  if (result.changes === 0) return null;
  return (await getReviewRunById(input.runId))!;
}

export async function listReviewBranchStates(
  repositoryId: string,
  stage?: ReviewStage,
): Promise<ReviewBranchStateRecord[]> {
  if (stage) {
    return (await dba
      .prepare(
        `SELECT * FROM review_branch_states
         WHERE repository_id = ? AND stage = ?
         ORDER BY updated_at DESC, branch ASC`,
      )
      .all(repositoryId, stage)) as ReviewBranchStateRecord[];
  }
  return (await dba
    .prepare(
      `SELECT * FROM review_branch_states
       WHERE repository_id = ?
       ORDER BY updated_at DESC, stage ASC, branch ASC`,
    )
    .all(repositoryId)) as ReviewBranchStateRecord[];
}

export async function getReviewBranchState(input: {
  repositoryId: string;
  stage: ReviewStage;
  branch: string;
}): Promise<ReviewBranchStateRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_branch_states
       WHERE repository_id = ? AND stage = ? AND branch = ?
       LIMIT 1`,
    )
    .get(input.repositoryId, input.stage, input.branch)) as
    | ReviewBranchStateRecord
    | undefined;
}

export async function upsertReviewBranchState(
  input: ReviewBranchStateUpsertInput & { stage: ReviewStage },
): Promise<ReviewBranchStateRecord> {
  const now = new Date().toISOString();
  const existing = await getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  });
  await dba
    .prepare(
      `INSERT OR REPLACE INTO review_branch_states (
      repository_id, stage, branch, last_run_id, head_sha, baseline_sha,
      baseline_source, result_state, status, actor, summary, reviewed_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.repository_id,
      input.stage,
      input.branch,
      input.last_run_id || existing?.last_run_id || null,
      input.head_sha || existing?.head_sha || null,
      input.baseline_sha || existing?.baseline_sha || null,
      input.baseline_source || existing?.baseline_source || null,
      input.result_state || existing?.result_state || null,
      input.status || existing?.status || null,
      input.actor || existing?.actor || null,
      input.summary || existing?.summary || null,
      input.reviewed_at || existing?.reviewed_at || now,
      now,
    );
  return (await getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  }))!;
}

export async function getReviewConversationBindingByChatJid(
  chatJid: string,
): Promise<ReviewConversationBindingRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_conversation_bindings WHERE chat_jid = ? LIMIT 1`,
    )
    .get(chatJid)) as ReviewConversationBindingRecord | undefined;
}

export async function listReviewConversationBindingsByChatJid(
  chatJid: string,
): Promise<ReviewConversationBindingRecord[]> {
  return (await dba
    .prepare(`SELECT * FROM review_conversation_bindings WHERE chat_jid = ?`)
    .all(chatJid)) as ReviewConversationBindingRecord[];
}

export async function getReviewConversationBindingByRepositoryId(
  repositoryId: string,
): Promise<ReviewConversationBindingRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_conversation_bindings WHERE repository_id = ? LIMIT 1`,
    )
    .get(repositoryId)) as ReviewConversationBindingRecord | undefined;
}

export async function saveReviewConversationBinding(
  input: ReviewConversationBindingUpsertInput,
): Promise<ReviewConversationBindingRecord> {
  const now = new Date().toISOString();
  const existing = await getReviewConversationBindingByRepositoryId(
    input.repository_id,
  );
  await dba
    .prepare(
      `INSERT OR REPLACE INTO review_conversation_bindings (
      repository_id, chat_jid, created_at, updated_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run(input.repository_id, input.chat_jid, existing?.created_at || now, now);
  return (await getReviewConversationBindingByRepositoryId(
    input.repository_id,
  ))!;
}

export async function deleteReviewConversationBindingByRepositoryId(
  repositoryId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM review_conversation_bindings WHERE repository_id = ?`)
    .run(repositoryId);
}

export async function getReviewRemoteBranchCache(
  repositoryId: string,
): Promise<ReviewRemoteBranchCacheRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM review_remote_branch_cache WHERE repository_id = ? LIMIT 1`,
    )
    .get(repositoryId)) as ReviewRemoteBranchCacheRecord | undefined;
}

export async function saveReviewRemoteBranchCache(input: {
  repository_id: string;
  branches_json: string;
  fetched_at: string;
}): Promise<ReviewRemoteBranchCacheRecord> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      `INSERT OR REPLACE INTO review_remote_branch_cache (
      repository_id, branches_json, fetched_at, updated_at
    ) VALUES (?, ?, ?, ?)`,
    )
    .run(input.repository_id, input.branches_json, input.fetched_at, now);
  return (await getReviewRemoteBranchCache(input.repository_id))!;
}

export async function deleteReviewRemoteBranchCache(
  repositoryId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM review_remote_branch_cache WHERE repository_id = ?`)
    .run(repositoryId);
}

export async function parseReviewProfileRecord(
  record: ReviewProfileRecord,
): Promise<
  ReviewProfileRecord & {
    targetBranches: string[];
    skillIds: string[];
    mcpServerIds: string[];
    includeGlobs: string[];
    excludeGlobs: string[];
    includeFullFileContext: boolean;
    writeToChat: boolean;
    writeToPlatform: boolean;
    enabledBool: boolean;
  }
> {
  return {
    ...record,
    pass_decision_mode: record.pass_decision_mode === 'human' ? 'human' : 'ai',
    targetBranches: safeParseJsonArray(record.target_branches),
    skillIds: safeParseJsonArray(record.skill_ids),
    mcpServerIds: safeParseJsonArray(record.mcp_server_ids),
    includeGlobs: safeParseJsonArray(record.include_globs),
    excludeGlobs: safeParseJsonArray(record.exclude_globs),
    includeFullFileContext: record.include_full_file_context === 1,
    writeToChat: record.write_to_chat === 1,
    writeToPlatform: record.write_to_platform === 1,
    enabledBool: record.enabled === 1,
  };
}

export async function parseReviewRepositoryRecord(
  record: ReviewRepositoryRecord,
): Promise<
  ReviewRepositoryRecord & {
    enabledBool: boolean;
    actorMentionMappings: unknown[];
    reviewerUsernames: string[];
  }
> {
  return {
    ...record,
    enabledBool: record.enabled === 1,
    actorMentionMappings: safeParseJson<unknown[]>(
      record.actor_mention_mappings_json,
      [],
    ),
    reviewerUsernames: safeParseJsonArray(record.reviewer_usernames_json),
  };
}

export async function parseReviewRunRecord(record: ReviewRunRecord): Promise<
  ReviewRunRecord & {
    findings: unknown[];
    fileReviews: unknown[];
    commitReviews: unknown[];
    suggestions: string[];
    changedFiles: string[];
    callbackContext: Record<string, unknown> | null;
    effectiveRules: Record<string, unknown>;
    recommendedBlock: boolean;
    blockingEnforced: boolean;
  }
> {
  return {
    ...record,
    findings: safeParseJson<unknown[]>(record.findings_json, []),
    fileReviews: safeParseJson<unknown[]>(record.file_reviews_json, []),
    commitReviews: safeParseJson<unknown[]>(record.commit_reviews_json, []),
    suggestions: safeParseJson<string[]>(record.suggestions_json, []),
    changedFiles: safeParseJson<string[]>(record.changed_files_json, []),
    callbackContext: safeParseJson<Record<string, unknown> | null>(
      record.callback_context_json,
      null,
    ),
    effectiveRules: safeParseJson<Record<string, unknown>>(
      record.effective_rules_json,
      {},
    ),
    recommendedBlock: record.recommended_block === 1,
    blockingEnforced: record.blocking_enforced === 1,
  };
}

export async function parseReviewRemoteBranchCacheRecord(
  record: ReviewRemoteBranchCacheRecord,
): Promise<
  ReviewRemoteBranchCacheRecord & {
    branches: unknown[];
  }
> {
  return {
    ...record,
    branches: safeParseJson<unknown[]>(record.branches_json, []),
  };
}

// ---------------------------------------------------------------------------
// SSH Keys
// ---------------------------------------------------------------------------

export interface SshKeyRecord {
  id: string;
  name: string;
  fingerprint: string | null;
  key_type: string | null;
  private_key: string;
  public_key: string | null;
  is_default: number;
  created_by?: string;
  updated_by?: string;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSshKeys(): Promise<SshKeyRecord[]> {
  return (await dba
    .prepare(
      'SELECT * FROM ssh_keys WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at ASC',
    )
    .all()) as SshKeyRecord[];
}

export async function getSshKeyById(
  id: string,
): Promise<SshKeyRecord | undefined> {
  return (await dba
    .prepare(
      'SELECT * FROM ssh_keys WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    )
    .get(id)) as SshKeyRecord | undefined;
}

export async function saveSshKey(
  input: Omit<SshKeyRecord, 'created_at' | 'updated_at'>,
): Promise<SshKeyRecord> {
  const now = new Date().toISOString();
  const existing = await getSshKeyById(input.id);
  await dba
    .prepare(
      `INSERT OR REPLACE INTO ssh_keys (
        id, name, fingerprint, key_type, private_key, public_key,
        is_default, created_by, updated_by, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.fingerprint || null,
      input.key_type || null,
      input.private_key,
      input.public_key || null,
      input.is_default,
      existing?.created_by || getCurrentUserId(),
      getCurrentUserId(),
      null,
      existing?.created_at || now,
      now,
    );
  const { invalidateSshKeyTmpCache } =
    await import('../repo-review/repo-review-git.js');
  invalidateSshKeyTmpCache(input.id);
  return (await getSshKeyById(input.id))!;
}

export async function deleteSshKey(id: string): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      'UPDATE ssh_keys SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(now, now, id);
  await dba
    .prepare(
      'UPDATE review_repositories SET ssh_key_id = NULL WHERE ssh_key_id = ? AND deleted_at IS NULL',
    )
    .run(id);
  const { invalidateSshKeyTmpCache } =
    await import('../repo-review/repo-review-git.js');
  invalidateSshKeyTmpCache(id);
}

export async function setDefaultSshKey(id: string): Promise<void> {
  await dba
    .prepare('UPDATE ssh_keys SET is_default = 0 WHERE deleted_at IS NULL')
    .run();
  await dba
    .prepare(
      'UPDATE ssh_keys SET is_default = 1 WHERE id = ? AND deleted_at IS NULL',
    )
    .run(id);
}

export async function getDefaultSshKey(): Promise<SshKeyRecord | undefined> {
  return (await dba
    .prepare(
      'SELECT * FROM ssh_keys WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1',
    )
    .get()) as SshKeyRecord | undefined;
}
