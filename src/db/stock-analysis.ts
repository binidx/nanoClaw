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
import { t } from '../i18n/index.js';

export interface StockAnalysisConfigEntry {
  key: string;
  value: string;
  updated_at: string;
}

export interface StockAnalysisConfigPresetRecord {
  id: string;
  title: string;
  description: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface StockAnalysisConfigHistoryRecord {
  id: string;
  version: number;
  config_entries_json: string;
  changed_keys_json: string;
  created_at: string;
}

interface StockAnalysisConfigStateRecord {
  scope: string;
  version: number;
  updated_at: string;
}

const STOCK_ANALYSIS_CONFIG_SCOPE = 'global';

export async function getStockAnalysisConfigEntries(): Promise<StockAnalysisConfigEntry[]> {
  return await dba
    .prepare(
      'SELECT key, value, updated_at FROM stock_analysis_config ORDER BY key ASC',
    )
    .all() as StockAnalysisConfigEntry[];
}

export async function setStockAnalysisConfig(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await dba
    .prepare('SELECT value FROM stock_analysis_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (existing?.value === value) {
    return;
  }

  await dba.transaction(async () => {
    await dba.prepare(
      `
        INSERT INTO stock_analysis_config (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    ).run(key, value, now);
    bumpStockAnalysisConfigVersion(now);
  })();
}

export async function deleteStockAnalysisConfig(key: string): Promise<void> {
  const now = new Date().toISOString();
  await dba.transaction(async () => {
    const result = await dba
      .prepare('DELETE FROM stock_analysis_config WHERE key = ?')
      .run(key);
    if (result.changes > 0) {
      bumpStockAnalysisConfigVersion(now);
    }
  })();
}

async function getStockAnalysisConfigState(): Promise<StockAnalysisConfigStateRecord> {
  return await dba
    .prepare(
      `
        SELECT scope, version, updated_at
        FROM stock_analysis_config_state
        WHERE scope = ?
      `,
    )
    .get(STOCK_ANALYSIS_CONFIG_SCOPE) as StockAnalysisConfigStateRecord;
}

async function bumpStockAnalysisConfigVersion(now: string): Promise<string> {
  const currentState = await getStockAnalysisConfigState();
  const nextVersion = currentState.version + 1;
  await dba.prepare(
    `
      UPDATE stock_analysis_config_state
      SET version = ?, updated_at = ?
      WHERE scope = ?
    `,
  ).run(nextVersion, now, STOCK_ANALYSIS_CONFIG_SCOPE);
  return String(nextVersion);
}

async function createStockAnalysisConfigHistory(
  now: string,
  version: string,
  changedKeys: string[],
): Promise<string> {
  const id = `stock-config-history-${version}`;
  const entries = await dba
    .prepare(
      `
        SELECT key, value, updated_at
        FROM stock_analysis_config
        ORDER BY key ASC
      `,
    )
    .all() as StockAnalysisConfigEntry[];
  await dba.prepare(
    `
      INSERT INTO stock_analysis_config_history (
        id,
        version,
        config_entries_json,
        changed_keys_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    Number(version),
    JSON.stringify(
      entries.map((entry) => ({ key: entry.key, value: entry.value })),
    ),
    JSON.stringify(changedKeys),
    now,
  );
  return id;
}

export async function updateStockAnalysisConfigEntries(input: {
  expectedVersion?: string;
  setValues: Record<string, string>;
  deleteKeys: string[];
}): Promise<{ configVersion: string; historyId: string | null }> {
  const now = new Date().toISOString();
  const apply = dba.transaction(async () => {
    const currentVersion = await getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error(t('stock.configChanged', {}, undefined));
    }

    let changed = false;

    for (const key of input.deleteKeys) {
      const result = await dba.prepare('DELETE FROM stock_analysis_config WHERE key = ?')
        .run(key);
      if (result.changes > 0) {
        changed = true;
      }
    }

    for (const [key, value] of Object.entries(input.setValues)) {
      const existing = await dba.prepare('SELECT value FROM stock_analysis_config WHERE key = ?')
        .get(key) as { value: string } | undefined;
      if (existing?.value === value) {
        continue;
      }
      await dba.prepare(
        `
          INSERT INTO stock_analysis_config (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      ).run(key, value, now);
      changed = true;
    }

    if (!changed) {
      return { configVersion: currentVersion, historyId: null };
    }
    const nextVersion = await bumpStockAnalysisConfigVersion(now);
    const historyId = await createStockAnalysisConfigHistory(now, nextVersion, [
      ...new Set([...input.deleteKeys, ...Object.keys(input.setValues)]),
    ]);
    return { configVersion: nextVersion, historyId };
  });

  return apply();
}

export async function getStockAnalysisConfigVersion(): Promise<string> {
  return String((await getStockAnalysisConfigState()).version);
}

export async function listStockAnalysisConfigHistory(
  limit: number,
): Promise<StockAnalysisConfigHistoryRecord[]> {
  return await dba
    .prepare(
      `
        SELECT id, version, config_entries_json, changed_keys_json, created_at
        FROM stock_analysis_config_history
        ORDER BY version DESC, created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as StockAnalysisConfigHistoryRecord[];
}

export async function getStockAnalysisConfigHistory(
  id: string,
): Promise<StockAnalysisConfigHistoryRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT id, version, config_entries_json, changed_keys_json, created_at
        FROM stock_analysis_config_history
        WHERE id = ?
      `,
    )
    .get(id) as StockAnalysisConfigHistoryRecord | undefined;
}

export async function restoreStockAnalysisConfigHistory(input: {
  id: string;
  expectedVersion?: string;
}): Promise<{ configVersion: string; historyId: string | null }> {
  const now = new Date().toISOString();
  const apply = dba.transaction(async () => {
    const currentVersion = await getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error(t('stock.configChanged', {}, undefined));
    }

    const snapshot = await getStockAnalysisConfigHistory(input.id);
    if (!snapshot) {
      throw new Error(t('stock.configHistoryNotFound', {}, undefined));
    }

    const targetEntries = JSON.parse(snapshot.config_entries_json) as Array<{
      key: string;
      value: string;
    }>;
    const targetMap = new Map(
      targetEntries.map((entry) => [entry.key, entry.value]),
    );
    const currentEntries = await getStockAnalysisConfigEntries();
    let changed = false;
    const changedKeys = new Set<string>();

    for (const current of currentEntries) {
      const targetValue = targetMap.get(current.key);
      if (targetValue === undefined) {
        await dba.prepare('DELETE FROM stock_analysis_config WHERE key = ?').run(
          current.key,
        );
        changed = true;
        changedKeys.add(current.key);
        continue;
      }
      if (targetValue !== current.value) {
        await dba.prepare(
          `
            UPDATE stock_analysis_config
            SET value = ?, updated_at = ?
            WHERE key = ?
          `,
        ).run(targetValue, now, current.key);
        changed = true;
        changedKeys.add(current.key);
      }
      targetMap.delete(current.key);
    }

    for (const [key, value] of targetMap.entries()) {
      await dba.prepare(
        `
          INSERT INTO stock_analysis_config (key, value, updated_at)
          VALUES (?, ?, ?)
        `,
      ).run(key, value, now);
      changed = true;
      changedKeys.add(key);
    }

    if (!changed) {
      return { configVersion: currentVersion, historyId: null };
    }

    const nextVersion = await bumpStockAnalysisConfigVersion(now);
    const historyId = await createStockAnalysisConfigHistory(
      now,
      nextVersion,
      Array.from(changedKeys).sort(),
    );
    return { configVersion: nextVersion, historyId };
  });

  return apply();
}

export async function listStockAnalysisConfigPresets(): Promise<StockAnalysisConfigPresetRecord[]> {
  return await dba
    .prepare(
      `
        SELECT id, title, description, config_json, created_at, updated_at
        FROM stock_analysis_config_presets
        ORDER BY updated_at DESC, id ASC
      `,
    )
    .all() as StockAnalysisConfigPresetRecord[];
}

export async function getStockAnalysisConfigPreset(
  id: string,
): Promise<StockAnalysisConfigPresetRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT id, title, description, config_json, created_at, updated_at
        FROM stock_analysis_config_presets
        WHERE id = ?
      `,
    )
    .get(id) as StockAnalysisConfigPresetRecord | undefined;
}

export async function upsertStockAnalysisConfigPreset(input: {
  id: string;
  title: string;
  description?: string | null;
  config_json: string;
}): Promise<void> {
  const existing = await dba
    .prepare(
      `
        SELECT created_at
        FROM stock_analysis_config_presets
        WHERE id = ?
      `,
    )
    .get(input.id) as { created_at: string } | undefined;
  const now = new Date().toISOString();
  await dba.prepare(
    `
      INSERT INTO stock_analysis_config_presets (
        id,
        title,
        description,
        config_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `,
  ).run(
    input.id,
    input.title,
    input.description || null,
    input.config_json,
    existing?.created_at || now,
    now,
  );
}

export async function deleteStockAnalysisConfigPreset(id: string): Promise<void> {
  await dba.prepare('DELETE FROM stock_analysis_config_presets WHERE id = ?').run(id);
}

// ── Stock Analysis task/report operations ──

export interface StockAnalysisTaskRecord {
  id: string;
  stock_code: string;
  market: string;
  stock_name: string | null;
  status: string;
  report_type: string;
  strategy_preset: string;
  force_refresh: number;
  result_mode: string;
  error: string | null;
  report_id: string | null;
  data_as_of: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface StockAnalysisReportRecord {
  id: string;
  stock_code: string;
  market: string;
  stock_name: string | null;
  report_type: string;
  score: number;
  trend: string;
  recommendation: string;
  current_price: number | null;
  change_pct: number | null;
  data_as_of: string | null;
  history_days: number;
  summary_json: string;
  detail_json: string;
  model_used: string | null;
  created_at: string;
}

export interface StockAnalysisMarketReviewRecord {
  id: string;
  market_scope: string;
  trade_date: string | null;
  summary_json: string;
  detail_json: string;
  model_used: string | null;
  created_at: string;
}

export interface StockAnalysisWatchlistRecord {
  stock_code: string;
  market: string;
  stock_name: string;
  created_at: string;
  updated_at: string;
}

export async function createStockAnalysisTask(
  task: Omit<StockAnalysisTaskRecord, 'force_refresh'> & {
    force_refresh: number | boolean;
  },
): Promise<boolean> {
  const result = await dba
    .prepare(
      `
      INSERT OR IGNORE INTO stock_analysis_tasks (
        id,
        stock_code,
        market,
        stock_name,
        status,
        report_type,
        strategy_preset,
        force_refresh,
        result_mode,
        error,
        report_id,
        data_as_of,
        created_at,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      task.id,
      task.stock_code,
      task.market,
      task.stock_name || null,
      task.status,
      task.report_type,
      task.strategy_preset,
      task.force_refresh ? 1 : 0,
      task.result_mode,
      task.error || null,
      task.report_id || null,
      task.data_as_of || null,
      task.created_at,
      task.started_at || null,
      task.completed_at || null,
    );
  return result.changes > 0;
}

export async function updateStockAnalysisTask(
  taskId: string,
  updates: Partial<StockAnalysisTaskRecord>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id') continue;
    fields.push(`${key} = ?`);
    values.push(value ?? null);
  }
  if (fields.length === 0) return;
  values.push(taskId);
  await dba.prepare(
    `UPDATE stock_analysis_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export async function listStockAnalysisTasks(
  input: {
    limit?: number;
    statuses?: string[];
  } = {},
): Promise<StockAnalysisTaskRecord[]> {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 50));
  const statuses = Array.isArray(input.statuses)
    ? input.statuses.map((value) => value.trim()).filter(Boolean)
    : [];

  if (statuses.length > 0) {
    const placeholders = createPlaceholders(statuses.length);
    return await dba
      .prepare(
        `
          SELECT *
          FROM stock_analysis_tasks
          WHERE status IN (${placeholders})
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(...statuses, limit) as StockAnalysisTaskRecord[];
  }

  return await dba
    .prepare(
      `
        SELECT *
        FROM stock_analysis_tasks
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as StockAnalysisTaskRecord[];
}

export async function getStockAnalysisTask(
  taskId: string,
): Promise<StockAnalysisTaskRecord | undefined> {
  return await dba
    .prepare('SELECT * FROM stock_analysis_tasks WHERE id = ?')
    .get(taskId) as StockAnalysisTaskRecord | undefined;
}

export async function deleteStockAnalysisTask(taskId: string): Promise<number> {
  const result = await dba
    .prepare('DELETE FROM stock_analysis_tasks WHERE id = ?')
    .run(taskId);
  return result.changes;
}

export async function deleteStockAnalysisTasksByStatuses(statuses: string[]): Promise<number> {
  const normalized = Array.from(
    new Set(statuses.map((value) => value.trim()).filter(Boolean)),
  );
  if (normalized.length === 0) {
    return 0;
  }
  const placeholders = createPlaceholders(normalized.length);
  const result = await dba
    .prepare(
      `DELETE FROM stock_analysis_tasks WHERE status IN (${placeholders})`,
    )
    .run(...normalized);
  return result.changes;
}

export async function listRunningStockAnalysisTasks(): Promise<StockAnalysisTaskRecord[]> {
  return await dba
    .prepare(
      `
        SELECT *
        FROM stock_analysis_tasks
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC
      `,
    )
    .all() as StockAnalysisTaskRecord[];
}

export async function createStockAnalysisReport(
  record: StockAnalysisReportRecord,
): Promise<void> {
  await dba.prepare(
    `
      INSERT INTO stock_analysis_reports (
        id,
        stock_code,
        market,
        stock_name,
        report_type,
        score,
        trend,
        recommendation,
        current_price,
        change_pct,
        data_as_of,
        history_days,
        summary_json,
        detail_json,
        model_used,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id,
    record.stock_code,
    record.market,
    record.stock_name || null,
    record.report_type,
    record.score,
    record.trend,
    record.recommendation,
    record.current_price ?? null,
    record.change_pct ?? null,
    record.data_as_of ?? null,
    record.history_days,
    record.summary_json,
    record.detail_json,
    record.model_used || null,
    record.created_at,
  );
}

export async function listStockAnalysisReports(
  limit: number,
  offset: number,
  stockCode?: string,
): Promise<StockAnalysisReportRecord[]> {
  if (stockCode?.trim()) {
    return await dba
      .prepare(
        `
          SELECT *
          FROM stock_analysis_reports
          WHERE stock_code = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(stockCode.trim(), limit, offset) as StockAnalysisReportRecord[];
  }

  return await dba
    .prepare(
      `
        SELECT *
        FROM stock_analysis_reports
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(limit, offset) as StockAnalysisReportRecord[];
}

export async function countStockAnalysisReports(stockCode?: string): Promise<number> {
  const row = stockCode?.trim()
    ? (await dba
        .prepare(
          'SELECT COUNT(*) AS count FROM stock_analysis_reports WHERE stock_code = ?',
        )
        .get(stockCode.trim()) as { count: number })
    : (await dba
        .prepare('SELECT COUNT(*) AS count FROM stock_analysis_reports')
        .get() as { count: number });
  return row.count;
}

export async function getStockAnalysisReport(
  id: string,
): Promise<StockAnalysisReportRecord | undefined> {
  return await dba
    .prepare('SELECT * FROM stock_analysis_reports WHERE id = ?')
    .get(id) as StockAnalysisReportRecord | undefined;
}

export async function getLatestStockAnalysisReportBySignature(input: {
  stockCode: string;
  market: string;
  reportType: string;
  createdAfter?: string;
}): Promise<StockAnalysisReportRecord | undefined> {
  if (input.createdAfter) {
    return await dba
      .prepare(
        `
          SELECT *
          FROM stock_analysis_reports
          WHERE stock_code = ?
            AND market = ?
            AND report_type = ?
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(
        input.stockCode,
        input.market,
        input.reportType,
        input.createdAfter,
      ) as StockAnalysisReportRecord | undefined;
  }

  return await dba
    .prepare(
      `
        SELECT *
        FROM stock_analysis_reports
        WHERE stock_code = ?
          AND market = ?
          AND report_type = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(input.stockCode, input.market, input.reportType) as
    | StockAnalysisReportRecord
    | undefined;
}

export async function createStockAnalysisMarketReview(
  record: StockAnalysisMarketReviewRecord,
): Promise<void> {
  await dba.prepare(
    `
      INSERT INTO stock_analysis_market_reviews (
        id,
        market_scope,
        trade_date,
        summary_json,
        detail_json,
        model_used,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id,
    record.market_scope,
    record.trade_date || null,
    record.summary_json,
    record.detail_json,
    record.model_used || null,
    record.created_at,
  );
}

export async function getLatestStockAnalysisMarketReview(
  scope?: string,
): Promise<StockAnalysisMarketReviewRecord | undefined> {
  if (scope?.trim()) {
    return await dba
      .prepare(
        `
          SELECT *
          FROM stock_analysis_market_reviews
          WHERE market_scope = ?
          ORDER BY COALESCE(trade_date, created_at) DESC, created_at DESC
          LIMIT 1
        `,
      )
      .get(scope.trim()) as StockAnalysisMarketReviewRecord | undefined;
  }

  return await dba
    .prepare(
      `
        SELECT *
        FROM stock_analysis_market_reviews
        ORDER BY COALESCE(trade_date, created_at) DESC, created_at DESC
        LIMIT 1
      `,
    )
    .get() as StockAnalysisMarketReviewRecord | undefined;
}

export async function upsertStockAnalysisWatchlistItem(input: {
  stock_code: string;
  market: string;
  stock_name: string;
}): Promise<void> {
  const existing = await dba
    .prepare(
      `
        SELECT created_at
        FROM stock_analysis_watchlist
        WHERE stock_code = ?
      `,
    )
    .get(input.stock_code) as { created_at: string } | undefined;
  const now = new Date().toISOString();
  await dba.prepare(
    `
      INSERT INTO stock_analysis_watchlist (
        stock_code,
        market,
        stock_name,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(stock_code) DO UPDATE SET
        market = excluded.market,
        stock_name = excluded.stock_name,
        updated_at = excluded.updated_at
    `,
  ).run(
    input.stock_code,
    input.market,
    input.stock_name,
    existing?.created_at || now,
    now,
  );
}

export async function listStockAnalysisWatchlist(): Promise<StockAnalysisWatchlistRecord[]> {
  return await dba
    .prepare(
      `
        SELECT stock_code, market, stock_name, created_at, updated_at
        FROM stock_analysis_watchlist
        ORDER BY updated_at DESC, stock_code ASC
      `,
    )
    .all() as StockAnalysisWatchlistRecord[];
}

export async function deleteStockAnalysisWatchlistItem(stockCode: string): Promise<void> {
  await dba.prepare('DELETE FROM stock_analysis_watchlist WHERE stock_code = ?').run(
    stockCode,
  );
}

// ── AI Provider operations ──
