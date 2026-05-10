/**
 * Stock Analysis Service
 *
 * Refactored: thin API facade + pipeline orchestration.
 * Heavy logic has been extracted to:
 * - stock-analysis-technical.ts  → technical indicators, factor scores, trade plan
 * - stock-analysis-normalize.ts  → data normalization and sanitization
 * - stock-analysis-market-data.ts → multi-provider data fetching with failover
 * - stock-analysis-backtest.ts   → backtest engine
 * - stock-analysis-pipeline-news.ts → news intelligence pipeline
 * - stock-analysis-heuristic.ts  → bias safety + heuristic assessment
 */

import {
  createStockAnalysisMarketReview,
  createStockAnalysisReport,
  createStockAnalysisTask,
  deleteStockAnalysisTask,
  deleteStockAnalysisTasksByStatuses,
  deleteStockAnalysisWatchlistItem,
  getLatestStockAnalysisMarketReview,
  getStockAnalysisTask,
  listRunningStockAnalysisTasks,
  listStockAnalysisReports,
  upsertStockAnalysisWatchlistItem,
  updateStockAnalysisTask,
} from '../db.js';
import {
  deleteStockAnalysisCustomPreset,
  getStockAnalysisConfig,
  getStockAnalysisConfigMeta,
  listStockAnalysisCustomPresets,
  saveStockAnalysisCustomPreset,
  updateStockAnalysisConfig,
  type StockAnalysisConfigMap,
} from './stock-analysis-config.js';
import {
  fetchStockMarketSnapshot,
  getMarketIndexSymbols,
  normalizeStockSymbol,
  getDataProviderReport,
  prefetchDomesticRealtimeQuotes,
} from './stock-analysis-market-data.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import {
  average,
  buildFactorScores,
  buildRecentBars,
  buildTradePlan,
  computeMetrics,
  readNumericConfig,
  round,
} from './stock-analysis-technical.js';
import {
  extractJsonObject,
  formatPct,
  normalizeDataSource,
  normalizeMarketReviewDetail,
  normalizeReportValidation,
  normalizeStrategyInfo,
  normalizeStrategyPreset,
  normalizeSummaryPayload,
  STOCK_ANALYSIS_STRATEGIES,
  toIsoTradeDate,
} from './stock-analysis-normalize.js';
import { StockAnalysisBacktestEngine } from './stock-analysis-backtest.js';
import { buildHeuristicAssessment, resolveMaType } from './stock-analysis-heuristic.js';
import {
  maybeGenerateNewsIntel,
  resolveNewsStageLog,
} from './stock-analysis-pipeline-news.js';
import { buildFeedbackSnapshot } from './stock-analysis-feedback.js';
import {
  getHistoryDashboardById,
  getHistoryDetailById,
  listHistorySummaries,
  listTaskSummaries,
  listWatchlistItems,
  parseStrategyFromReportRow,
  toTaskSummary,
} from './stock-analysis-records.js';
import {
  buildAiSummaryPrompt,
  buildMarketReviewPrompt,
} from './stock-analysis-prompts.js';
import type {
  PipelineStageLog,
  StockAnalysisBacktestRequest,
  StockAnalysisBacktestResult,
  StockAnalysisDataProviderReport,
  StockAnalysisDecisionDashboard,
  StockAnalysisDetail,
  StockAnalysisFactorScore,
  StockAnalysisFeedbackSnapshot,
  StockAnalysisHistoryItem,
  StockAnalysisMarket,
  StockAnalysisMarketDashboardResponse,
  StockAnalysisMarketReview,
  StockAnalysisMarketScope,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsIntel,
  StockAnalysisPortfolioDashboardResponse,
  StockAnalysisReportType,
  StockAnalysisReportCenterResponse,
  StockAnalysisReportDetailBundle,
  StockAnalysisReportValidation,
  StockAnalysisStrategyInfo,
  StockAnalysisStrategyPreset,
  StockAnalysisSummary,
  StockAnalysisTaskCollection,
  StockAnalysisTaskSummary,
  StockAnalysisTaskStatus,
  StockAnalysisTradePlan,
  StockAnalysisWorkbenchResponse,
  StockAnalysisWatchlistItem,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

/* ──────────── Internal types ──────────── */

interface PendingTask {
  id: string;
  stockCode: string;
  market: StockAnalysisMarket;
  reportType: StockAnalysisReportType;
  strategyPreset: StockAnalysisStrategyPreset;
  forceRefresh: boolean;
  createdAt: string;
}

type TaskSubscriber = (event: {
  type: 'task';
  task: StockAnalysisTaskSummary;
}) => void;

/* ──────────── Utility ──────────── */

function getReportCacheTtlMs(config: StockAnalysisConfigMap): number {
  const ttlMinutes = Math.max(0, Number(config.reportCacheTtlMinutes) || 0);
  return ttlMinutes * 60 * 1000;
}

function buildTaskCollection(
  active: StockAnalysisTaskSummary[],
  recent: StockAnalysisTaskSummary[],
  failed: StockAnalysisTaskSummary[],
): StockAnalysisTaskCollection {
  return {
    active,
    recent,
    failed,
    pendingCount: active.filter((task) => task.status === 'pending').length,
    runningCount: active.filter((task) => task.status === 'running').length,
    completedCount: recent.length,
    failedCount: failed.length,
  };
}

function resolvePreferredMarketDataProvider(
  config: StockAnalysisConfigMap,
  market: StockAnalysisMarket,
): 'yahoo' | 'efinance' | 'akshare' {
  const configuredProvider = String(config.dataProvider || '').trim();
  const configuredPriority = String(config.dataProviderPriority || '').trim();
  if (
    market === 'hk' &&
    (!configuredProvider ||
      (configuredProvider === 'yahoo' &&
        (!configuredPriority ||
          configuredPriority === 'yahoo,efinance,akshare')))
  ) {
    return 'akshare';
  }
  if (
    configuredProvider === 'yahoo' ||
    configuredProvider === 'efinance' ||
    configuredProvider === 'akshare'
  ) {
    return configuredProvider;
  }
  return market === 'us' ? 'yahoo' : 'akshare';
}

function resolveMarketDataProviderPriority(
  config: StockAnalysisConfigMap,
  market: StockAnalysisMarket,
): string {
  const configuredPriority = String(config.dataProviderPriority || '').trim();
  if (
    configuredPriority &&
    configuredPriority !== 'yahoo,efinance,akshare'
  ) {
    return configuredPriority;
  }
  return market === 'us' ? 'yahoo' : 'akshare,efinance,yahoo';
}

function pushPipelineStageLog(
  pipelineLog: PipelineStageLog[],
  input: {
    stage: string;
    startedAt: number;
    status: PipelineStageLog['status'];
    note?: string;
  },
): void {
  pipelineLog.push({
    stage: input.stage,
    startedAt: input.startedAt,
    durationMs: Date.now() - input.startedAt,
    status: input.status,
    note: input.note,
  });
}

const VALID_TASK_STATUSES: StockAnalysisTaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
];

function resolveAiSummaryStageLog(
  config: StockAnalysisConfigMap,
  modelUsed: string | null,
): { status: PipelineStageLog['status']; note: string } {
  if (!config.aiSummaryEnabled) {
    return {
      status: 'skipped',
      note: 'disabled by config',
    };
  }
  if (modelUsed) {
    return {
      status: 'ok',
      note: `model: ${modelUsed}`,
    };
  }
  return {
    status: 'ok',
    note: 'fallback: heuristic summary',
  };
}

function buildStrategyInfo(
  preset: StockAnalysisStrategyPreset,
  config: StockAnalysisConfigMap,
): StockAnalysisStrategyInfo {
  const base = STOCK_ANALYSIS_STRATEGIES[preset];
  const maTypeSuffix = `|ma:${resolveMaType(config)}`;
  if (preset === 'bull_trend') {
    const trendBonus = readNumericConfig(config, 'bullTrendTrendBonus', 2);
    const macdBonus = readNumericConfig(config, 'bullTrendMacdBonus', 1);
    return {
      ...base,
      cacheKey: `${preset}|tb:${trendBonus}|mb:${macdBonus}${maTypeSuffix}`,
      tuningNotes: [
        `趋势额外加分 ${trendBonus}`,
        `MACD 额外加分 ${macdBonus}`,
        `均线类型 ${resolveMaType(config).toUpperCase()}`,
      ],
    };
  }
  if (preset === 'shrink_pullback') {
    const biasLower = readNumericConfig(config, 'shrinkPullbackBiasLowerPct', -4);
    const biasUpper = readNumericConfig(config, 'shrinkPullbackBiasUpperPct', 1);
    const volumeMax = readNumericConfig(config, 'shrinkPullbackVolumeRatioMax', 0.95);
    return {
      ...base,
      cacheKey: `${preset}|bl:${biasLower}|bu:${biasUpper}|vm:${volumeMax}${maTypeSuffix}`,
      tuningNotes: [
        `MA20 偏离区间 ${biasLower}% 到 ${biasUpper}%`,
        `缩量阈值 ${round(volumeMax, 2)}`,
        `均线类型 ${resolveMaType(config).toUpperCase()}`,
      ],
    };
  }
  if (preset === 'volume_breakout') {
    const volumeMin = readNumericConfig(config, 'volumeBreakoutVolumeRatioMin', 1.2);
    const roomMin = readNumericConfig(config, 'volumeBreakoutBreakoutRoomMin', -2);
    return {
      ...base,
      cacheKey: `${preset}|vr:${volumeMin}|rm:${roomMin}${maTypeSuffix}`,
      tuningNotes: [
        `放量阈值 ${round(volumeMin, 2)} 倍`,
        `距 20 日高点最小空间 ${roomMin}%`,
        `均线类型 ${resolveMaType(config).toUpperCase()}`,
      ],
    };
  }
  // ma_golden_cross and box_oscillation use simpler cache keys
  return {
    ...base,
    cacheKey: `${preset}${maTypeSuffix}`,
    tuningNotes: [`均线类型 ${resolveMaType(config).toUpperCase()}`],
  };
}


/* ──────────── Pipeline: AI Summary ──────────── */

async function maybeGenerateAiSummary(
  config: StockAnalysisConfigMap,
  base: {
    stockCode: string;
    stockName: string;
    market: StockAnalysisMarket;
    metrics: StockAnalysisMetricSnapshot;
    heuristic: ReturnType<typeof buildHeuristicAssessment>;
    factorScores: StockAnalysisFactorScore[];
    tradePlan: StockAnalysisTradePlan;
    strategy: StockAnalysisStrategyInfo;
    newsIntel: StockAnalysisNewsIntel;
  },
  deps: {
    generateText?: (prompt: string) => Promise<string>;
  },
): Promise<{ summary: StockAnalysisSummary; modelUsed: string | null }> {
  if (!config.aiSummaryEnabled) {
    return { summary: base.heuristic.summary, modelUsed: null };
  }

  try {
    const prompt = await buildAiSummaryPrompt({
      stockCode: base.stockCode,
      stockName: base.stockName,
      market: base.market,
      metrics: base.metrics,
      strategy: base.strategy,
      aiSummaryStyle: String(config.aiSummaryStyle || 'professional'),
      heuristic: {
        score: base.heuristic.score,
        trend: base.heuristic.trend,
        recommendation: base.heuristic.recommendation,
        riskSignals: base.heuristic.summary.riskSignals,
        catalystSignals: base.heuristic.summary.catalystSignals,
      },
      factorScores: base.factorScores,
      tradePlan: base.tradePlan,
      newsIntel: base.newsIntel,
    });

    const raw = await (deps.generateText || generateTextWithDefaultProvider)(
      prompt,
      deps.generateText
        ? undefined
        : {
            promptTrace: {
              promptKey: 'stock_analysis.ai_summary',
              featureScope: 'stock_analysis',
              metadata: {
                stockCode: base.stockCode,
                market: base.market,
              },
            },
          },
    );
    const parsed = extractJsonObject<StockAnalysisSummary>(raw);
    if (parsed) {
      return {
        summary: normalizeSummaryPayload(parsed, base.heuristic.summary),
        modelUsed: 'default-provider',
      };
    }
  } catch {
    // Fall back to heuristics if provider is unavailable or returns bad JSON.
  }

  return {
    summary: normalizeSummaryPayload(base.heuristic.summary, base.heuristic.summary),
    modelUsed: null,
  };
}


/* ──────────── Service Class ──────────── */

export class StockAnalysisService {
  private queue: PendingTask[] = [];

  private activeCount = 0;

  private queueWarmupPending = false;

  private queueWarmupPromise: Promise<void> = Promise.resolve();

  private activeCodes = new Set<string>();

  private subscribers = new Set<TaskSubscriber>();

  private readonly fetchImpl: typeof fetch;

  private readonly generateText?: (prompt: string) => Promise<string>;

  private readonly generateNewsIntel?: (
    prompt: string,
  ) => Promise<{ text: string; model?: string } | string>;

  private readonly newsFetchImpl?: typeof fetch;

  private readonly backtestEngine: StockAnalysisBacktestEngine;

  constructor(
    deps: {
      fetchImpl?: typeof fetch;
      newsFetchImpl?: typeof fetch;
      generateText?: (prompt: string) => Promise<string>;
      generateNewsIntel?: (
        prompt: string,
      ) => Promise<{ text: string; model?: string } | string>;
    } = {},
  ) {
    this.fetchImpl = deps.fetchImpl || fetch;
    this.newsFetchImpl = deps.newsFetchImpl || deps.fetchImpl;
    this.generateText = deps.generateText;
    this.generateNewsIntel = deps.generateNewsIntel;
    this.backtestEngine = new StockAnalysisBacktestEngine({
      fetchImpl: this.fetchImpl,
    });
    void this.failInterruptedRunningTasks();
  }

  private async failInterruptedRunningTasks(): Promise<void> {
    for (const task of await listRunningStockAnalysisTasks()) {
      await updateStockAnalysisTask(task.id, {
        status: 'failed',
        error: 'Runtime restarted before task completion',
        completed_at: new Date().toISOString(),
      });
    }
  }

  /* ─── Config ─── */

  getConfig() {
    return getStockAnalysisConfig();
  }

  getConfigMeta() {
    return getStockAnalysisConfigMeta();
  }

  updateConfig(input: {
    configVersion?: string;
    config?: Record<string, unknown>;
  }) {
    return updateStockAnalysisConfig(input);
  }

  listConfigPresets() {
    return listStockAnalysisCustomPresets();
  }

  saveConfigPreset(input: {
    id?: string;
    title?: string;
    description?: string | null;
    config?: Record<string, unknown>;
  }) {
    return saveStockAnalysisCustomPreset(input);
  }

  deleteConfigPreset(id: string) {
    return deleteStockAnalysisCustomPreset({ id });
  }

  /* ─── Data Provider Status ─── */

  getDataProviderStatus(): StockAnalysisDataProviderReport {
    return getDataProviderReport();
  }

  /* ─── Watchlist ─── */

  async listWatchlist(): Promise<{ items: StockAnalysisWatchlistItem[]; }> {
    return {
      items: await listWatchlistItems(),
    };
  }

  private async getTaskCollection(
    limit = 20,
  ): Promise<StockAnalysisTaskCollection> {
    const active = (
      await this.listTasks({
        statuses: ['pending', 'running'],
        limit,
      })
    ).tasks;
    const recent = (
      await this.listTasks({
        statuses: ['completed'],
        limit,
      })
    ).tasks;
    const failed = (
      await this.listTasks({
        statuses: ['failed'],
        limit,
      })
    ).tasks;
    return buildTaskCollection(active, recent, failed);
  }

  async getWorkbenchSnapshot(limit = 12): Promise<StockAnalysisWorkbenchResponse> {
    const config = (await this.getConfig()).config;
    const watchlist = (await this.listWatchlist()).items;
    const history = await this.listHistory({ limit });
    return {
      defaults: {
        marketScope:
          (config.defaultMarketScope as StockAnalysisMarketScope) || 'both',
        reportType:
          (config.defaultReportType as StockAnalysisReportType) || 'standard',
        strategyPreset: normalizeStrategyPreset(
          config.defaultStrategyPreset,
        ),
        reportCacheTtlMinutes: Math.max(
          0,
          Number(config.reportCacheTtlMinutes) || 0,
        ),
      },
      tasks: await this.getTaskCollection(limit),
      watchlist: {
        count: watchlist.length,
        items: watchlist.slice(0, limit),
      },
      history: {
        total: history.total,
        recent: history.items,
      },
      dataProviders: this.getDataProviderStatus(),
    };
  }

  async addWatchlist(input: {
    stockCodes?: string[];
    marketScope?: StockAnalysisMarketScope;
  }): Promise<{ items: StockAnalysisWatchlistItem[]; rejected: { stockCode: string; error: string; }[]; }> {
    const codes = Array.from(
      new Set(
        (input.stockCodes || [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    if (codes.length === 0) {
      throw new Error(t('stock.auto_2801ae', {}, undefined));
    }

    const config = (await this.getConfig()).config;
    const marketScope =
      input.marketScope ||
      (config.defaultMarketScope as StockAnalysisMarketScope);
    const added: StockAnalysisWatchlistItem[] = [];
    const rejected: Array<{ stockCode: string; error: string }> = [];

    for (const rawCode of codes) {
      try {
        const normalized = normalizeStockSymbol(rawCode, marketScope);
        await upsertStockAnalysisWatchlistItem({
          stock_code: normalized.stockCode,
          market: normalized.market,
          stock_name: normalized.displayName,
        });
        const created = (await listWatchlistItems()).find(
          (item) => item.stockCode === normalized.stockCode,
        );
        if (created) {
          added.push(created);
        }
      } catch (err) {
        rejected.push({
          stockCode: rawCode,
          error: err instanceof Error ? err.message : t('stock.auto_d24cb3', {}, undefined),
        });
      }
    }

    return {
      items: added,
      rejected,
    };
  }

  async removeWatchlist(stockCode: string): Promise<{ ok: true; }> {
    const rawCode = String(stockCode || '').trim();
    if (!rawCode) {
      throw new Error(t('stock.auto_1f54d7', {}, undefined));
    }
    const normalized = (() => {
      try {
        return normalizeStockSymbol(rawCode, 'both').stockCode;
      } catch {
        return rawCode.toUpperCase();
      }
    })();
    await deleteStockAnalysisWatchlistItem(normalized);
    return { ok: true };
  }

  /* ─── Task subscription ─── */

  subscribeTasks(subscriber: TaskSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private async notifyTask(taskId: string): Promise<void> {
    const task = await getStockAnalysisTask(taskId);
    if (!task) return;
    const payload = {
      type: 'task' as const,
      task: toTaskSummary(task),
    };
    for (const subscriber of this.subscribers) {
      subscriber(payload);
    }
  }

  /* ─── Analysis ─── */

  async analyze(input: {
    stockCodes?: string[];
    marketScope?: StockAnalysisMarketScope;
    reportType?: StockAnalysisReportType;
    strategyPreset?: StockAnalysisStrategyPreset;
    forceRefresh?: boolean;
  }): Promise<{ accepted: StockAnalysisTaskSummary[]; rejected: { stockCode: string; error: string; }[]; }> {
    const codes = Array.from(
      new Set(
        (input.stockCodes || [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    if (codes.length === 0) {
      throw new Error(t('stock.auto_2801ae', {}, undefined));
    }

    const config = (await this.getConfig()).config;
    const marketScope =
      input.marketScope ||
      (config.defaultMarketScope as StockAnalysisMarketScope);
    const reportType =
      input.reportType || (config.defaultReportType as StockAnalysisReportType);
    const strategyPreset = normalizeStrategyPreset(
      input.strategyPreset || config.defaultStrategyPreset,
    );
    const accepted: StockAnalysisTaskSummary[] = [];
    const rejected: Array<{ stockCode: string; error: string }> = [];
    const symbolsToPrefetch: Array<ReturnType<typeof normalizeStockSymbol>> = [];
    const normalizedSymbols: Array<{
      rawCode: string;
      normalized: ReturnType<typeof normalizeStockSymbol>;
    }> = [];

    for (const rawCode of codes) {
      let normalized;
      try {
        normalized = normalizeStockSymbol(rawCode, marketScope);
      } catch (err) {
        rejected.push({
          stockCode: rawCode,
          error: err instanceof Error ? err.message : t('stock.auto_d24cb3', {}, undefined),
        });
        continue;
      }
      normalizedSymbols.push({ rawCode, normalized });
    }

    for (const { rawCode, normalized } of normalizedSymbols) {
      if (this.activeCodes.has(normalized.stockCode)) {
        rejected.push({
          stockCode: rawCode,
          error: t('stock.auto_d76b29', {}, undefined),
        });
        continue;
      }

      const task: PendingTask = {
        id: `stock-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        stockCode: normalized.stockCode,
        market: normalized.market,
        reportType,
        strategyPreset,
        forceRefresh: Boolean(input.forceRefresh),
        createdAt: new Date().toISOString(),
      };
      if (!task.forceRefresh) {
        const reusableReport = await this.findReusableReport(task, config);
        if (reusableReport) {
          await createStockAnalysisTask({
            id: task.id,
            stock_code: task.stockCode,
            market: task.market,
            stock_name: reusableReport.stock_name,
            status: 'completed',
            report_type: task.reportType,
            strategy_preset: task.strategyPreset,
            force_refresh: 0,
            result_mode: 'reused',
            error: null,
            report_id: reusableReport.id,
            data_as_of: reusableReport.data_as_of,
            created_at: task.createdAt,
            started_at: null,
            completed_at: task.createdAt,
          });
          accepted.push(
            toTaskSummary((await getStockAnalysisTask(task.id))!),
          );
          this.notifyTask(task.id);
          continue;
        }
      }
      const created = await createStockAnalysisTask({
        id: task.id,
        stock_code: task.stockCode,
        market: task.market,
        stock_name: null,
        status: 'pending',
        report_type: task.reportType,
        strategy_preset: task.strategyPreset,
        force_refresh: task.forceRefresh,
        result_mode: 'generated',
        error: null,
        report_id: null,
        data_as_of: null,
        created_at: task.createdAt,
        started_at: null,
        completed_at: null,
      });
      if (!created) {
        rejected.push({
          stockCode: rawCode,
          error: t('stock.auto_d76b29', {}, undefined),
        });
        continue;
      }
      this.queue.push(task);
      this.activeCodes.add(task.stockCode);
      symbolsToPrefetch.push(normalized);
      accepted.push(toTaskSummary((await getStockAnalysisTask(task.id))!));
      this.notifyTask(task.id);
    }

    if (symbolsToPrefetch.length > 1) {
      this.scheduleQueueWarmup(
        prefetchDomesticRealtimeQuotes(symbolsToPrefetch, {
          fetchImpl: this.fetchImpl,
          timeoutMs: Number(config.requestTimeoutMs) || 12000,
        }),
      );
    } else {
      void this.processQueue();
    }
    return { accepted, rejected };
  }

  async retryTask(taskId: string): Promise<{ accepted: StockAnalysisTaskSummary[]; rejected: { stockCode: string; error: string; }[]; }> {
    const task = await getStockAnalysisTask(taskId);
    if (!task) {
      throw new Error(t('errors.auto_c0d836', {}, undefined));
    }
    if (task.status === 'pending' || task.status === 'running') {
      throw new Error(t('stock.auto_4fdf6b', {}, undefined));
    }
    return this.analyze({
      stockCodes: [task.stock_code],
      marketScope: task.market as StockAnalysisMarketScope,
      reportType: task.report_type as StockAnalysisReportType,
      strategyPreset: normalizeStrategyPreset(task.strategy_preset),
      forceRefresh: true,
    });
  }

  private async findReusableReport(
    task: PendingTask,
    config: StockAnalysisConfigMap,
  ) {
    const cacheTtlMs = getReportCacheTtlMs(config);
    if (cacheTtlMs <= 0) {
      return null;
    }
    const createdAfter = new Date(
      new Date(task.createdAt).getTime() - cacheTtlMs,
    ).toISOString();
    const records = await listStockAnalysisReports(20, 0, task.stockCode);
    for (const record of records) {
      if (
        record.stock_code !== task.stockCode ||
        record.market !== task.market ||
        record.report_type !== task.reportType ||
        record.created_at < createdAfter
      ) {
        continue;
      }
      try {
        const detail = JSON.parse(record.detail_json) as {
          strategy?: Partial<StockAnalysisStrategyInfo>;
        };
        if (
          normalizeStrategyInfo(detail.strategy).cacheKey ===
          buildStrategyInfo(task.strategyPreset, config).cacheKey
        ) {
          return record;
        }
      } catch {
        if (task.strategyPreset === 'bull_trend') {
          return record;
        }
      }
    }
    return null;
  }

  private processQueue(): void {
    if (this.queueWarmupPending) {
      return;
    }
    void (async () => {
      const cfg = await this.getConfig();
      const concurrency = Number(cfg.config.maxConcurrentTasks) || 2;
      while (this.activeCount < concurrency && this.queue.length > 0) {
        const nextTask = this.queue.shift();
        if (!nextTask) return;
        this.activeCount += 1;
        void this.runTask(nextTask).finally(() => {
          this.activeCount -= 1;
          this.activeCodes.delete(nextTask.stockCode);
          this.processQueue();
        });
      }
    })();
  }

  private scheduleQueueWarmup(warmup: Promise<unknown>): void {
    this.queueWarmupPending = true;
    const previous = this.queueWarmupPromise;
    let release: Promise<void>;
    release = previous
      .catch(() => undefined)
      .then(async () => {
        await warmup;
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.queueWarmupPromise === release) {
          this.queueWarmupPending = false;
          this.processQueue();
        }
      });
    this.queueWarmupPromise = release;
  }

  private async runTask(task: PendingTask): Promise<void> {
    const startedAt = new Date().toISOString();
    await updateStockAnalysisTask(task.id, {
      status: 'running',
      started_at: startedAt,
      error: null,
    });
    this.notifyTask(task.id);

    try {
      const detail = await this.buildReport(
        task.stockCode,
        task.market,
        task.reportType,
        task.strategyPreset,
      );
      await createStockAnalysisReport({
        id: detail.id,
        stock_code: detail.stockCode,
        market: detail.market,
        stock_name: detail.stockName,
        report_type: detail.reportType,
        score: detail.score,
        trend: detail.trend,
        recommendation: detail.recommendation,
        current_price: detail.metrics.currentPrice,
        change_pct: detail.metrics.changePct,
        data_as_of: detail.dataAsOf,
        history_days: detail.historyDays,
        summary_json: JSON.stringify(detail.summary),
        detail_json: JSON.stringify({
          strategy: detail.strategy,
          dataSource: detail.dataSource,
          metrics: detail.metrics,
          details: detail.details,
        }),
        model_used: detail.modelUsed,
        created_at: detail.createdAt,
      });
      await updateStockAnalysisTask(task.id, {
        status: 'completed',
        stock_name: detail.stockName,
        report_id: detail.id,
        result_mode: 'generated',
        data_as_of: detail.dataAsOf,
        completed_at: detail.createdAt,
      });
      this.notifyTask(task.id);
    } catch (err) {
      await updateStockAnalysisTask(task.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : t('stock.auto_6aee2d', {}, undefined),
        completed_at: new Date().toISOString(),
      });
      this.notifyTask(task.id);
    }
  }

  /**
   * Core analysis pipeline — orchestrates data → metrics → factors → heuristic → AI.
   */
  private async buildReport(
    stockCode: string,
    market: StockAnalysisMarket,
    reportType: StockAnalysisReportType,
    strategyPreset: StockAnalysisStrategyPreset,
  ): Promise<StockAnalysisDetail> {
    const config = (await this.getConfig()).config;
    const maType = resolveMaType(config);
    const strategy = buildStrategyInfo(strategyPreset, config);
    const normalized = normalizeStockSymbol(stockCode, market);
    const pipelineLog: PipelineStageLog[] = [];

    // ── Stage 1: Data fetch (with failover) ──
    const dataFetchStartedAt = Date.now();
    let snapshot: Awaited<ReturnType<typeof fetchStockMarketSnapshot>>;
    try {
      snapshot = await fetchStockMarketSnapshot(normalized, {
        fetchImpl: this.fetchImpl,
        historyDays: Number(config.historyDays) || 180,
        timeoutMs: Number(config.requestTimeoutMs) || 12000,
        preferredProvider: resolvePreferredMarketDataProvider(config, market),
        failoverEnabled:
          config.dataProviderFailover !== false &&
          config.dataProviderFailover !== 'false',
        providerPriority: resolveMarketDataProviderPriority(config, market),
      });
      pushPipelineStageLog(pipelineLog, {
        stage: 'data_fetch',
        startedAt: dataFetchStartedAt,
        status: 'ok',
        note: `provider: ${snapshot.source.providerId}, priceSource: ${snapshot.source.priceSource}`,
      });
    } catch (err) {
      pushPipelineStageLog(pipelineLog, {
        stage: 'data_fetch',
        startedAt: dataFetchStartedAt,
        status: 'failed',
        note: err instanceof Error ? err.message : 'fetch failed',
      });
      throw err;
    }

    // Filter bars first to keep closes and volumes arrays aligned
    const validBars = snapshot.bars.filter(
      (bar) => Number.isFinite(bar.close),
    );
    const closes = validBars.map((bar) => bar.close);
    const volumes = validBars.map((bar) => bar.volume);
    if (closes.length < 60) {
      throw new Error(t('stock.auto_135798', {}, undefined));
    }

    // ── Stage 2: Technical analysis ──
    const technicalStartedAt = Date.now();
    let metrics: StockAnalysisMetricSnapshot;
    let recentBars: StockAnalysisDetail['details']['recentBars'];
    try {
      metrics = computeMetrics(closes, volumes, snapshot.currentPrice, snapshot.previousClose, {
        ohlcBars: snapshot.bars,
        maType,
      });
      recentBars = buildRecentBars(snapshot.bars, 60, maType);
      pushPipelineStageLog(pipelineLog, {
        stage: 'technical_analysis',
        startedAt: technicalStartedAt,
        status: 'ok',
        note: `maType: ${maType}`,
      });
    } catch (err) {
      pushPipelineStageLog(pipelineLog, {
        stage: 'technical_analysis',
        startedAt: technicalStartedAt,
        status: 'failed',
        note: err instanceof Error ? err.message : 'technical analysis failed',
      });
      throw err;
    }

    // ── Stage 3: News intelligence ──
    const newsStartedAt = Date.now();
    const newsIntel = await maybeGenerateNewsIntel(
      config,
      {
        stockCode: normalized.stockCode,
        stockName: snapshot.symbol.displayName,
        market,
        metrics,
        strategy,
      },
      {
        newsFetchImpl: this.newsFetchImpl,
        generateText: this.generateText,
        generateNewsIntel: this.generateNewsIntel,
      },
    );
    const newsStageLog = resolveNewsStageLog(config, newsIntel);
    pushPipelineStageLog(pipelineLog, {
      stage: 'news_intel',
      startedAt: newsStartedAt,
      status: newsStageLog.status,
      note: newsStageLog.note,
    });

    // ── Stage 4: Factor scoring ──
    const factorStartedAt = Date.now();
    let factorScores: StockAnalysisFactorScore[];
    try {
      factorScores = buildFactorScores(
        metrics,
        recentBars,
        strategy,
        newsIntel,
        config,
      );
      pushPipelineStageLog(pipelineLog, {
        stage: 'factor_scoring',
        startedAt: factorStartedAt,
        status: 'ok',
        note: `strategy: ${strategy.id}`,
      });
    } catch (err) {
      pushPipelineStageLog(pipelineLog, {
        stage: 'factor_scoring',
        startedAt: factorStartedAt,
        status: 'failed',
        note: err instanceof Error ? err.message : 'factor scoring failed',
      });
      throw err;
    }

    // ── Stage 5: Heuristic assessment ──
    const heuristicStartedAt = Date.now();
    let heuristic: ReturnType<typeof buildHeuristicAssessment>;
    try {
      heuristic = buildHeuristicAssessment(
        normalized.stockCode,
        snapshot.symbol.displayName,
        metrics,
        factorScores,
        strategy,
        newsIntel,
        closes,
        volumes,
        config,
      );
      pushPipelineStageLog(pipelineLog, {
        stage: 'heuristic_assessment',
        startedAt: heuristicStartedAt,
        status: 'ok',
        note: `score: ${heuristic.score}, recommendation: ${heuristic.recommendation}`,
      });
    } catch (err) {
      pushPipelineStageLog(pipelineLog, {
        stage: 'heuristic_assessment',
        startedAt: heuristicStartedAt,
        status: 'failed',
        note: err instanceof Error ? err.message : 'heuristic assessment failed',
      });
      throw err;
    }

    // ── Stage 6: Trade plan ──
    const tradePlanStartedAt = Date.now();
    let tradePlan: StockAnalysisTradePlan;
    try {
      tradePlan = buildTradePlan(
        metrics,
        heuristic.supportLevels,
        heuristic.resistanceLevels,
        heuristic.trend,
        strategy,
      );
      pushPipelineStageLog(pipelineLog, {
        stage: 'trade_plan',
        startedAt: tradePlanStartedAt,
        status: 'ok',
        note: `style: ${tradePlan.style}`,
      });
    } catch (err) {
      pushPipelineStageLog(pipelineLog, {
        stage: 'trade_plan',
        startedAt: tradePlanStartedAt,
        status: 'failed',
        note: err instanceof Error ? err.message : 'trade plan failed',
      });
      throw err;
    }

    // ── Stage 7: AI summary ──
    const aiStartedAt = Date.now();
    const aiSummary = await maybeGenerateAiSummary(
      config,
      {
        stockCode: normalized.stockCode,
        stockName: snapshot.symbol.displayName,
        market,
        metrics,
        heuristic,
        factorScores,
        tradePlan,
        strategy,
        newsIntel,
      },
      { generateText: this.generateText },
    );
    const aiStageLog = resolveAiSummaryStageLog(config, aiSummary.modelUsed);
    pushPipelineStageLog(pipelineLog, {
      stage: 'ai_summary',
      startedAt: aiStartedAt,
      status: aiStageLog.status,
      note: aiStageLog.note,
    });

    const recentCloses =
      reportType === 'brief'
        ? closes.slice(-5)
        : reportType === 'standard'
          ? closes.slice(-10)
          : closes.slice(-20);
    const dataAsOf = snapshot.bars[snapshot.bars.length - 1]?.timestamp || null;
    const historyDays = Math.max(60, Number(config.historyDays) || 180);

    return {
      id: `stock-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stockCode: normalized.stockCode,
      stockName: snapshot.symbol.displayName,
      market,
      reportType,
      createdAt: new Date().toISOString(),
      modelUsed: aiSummary.modelUsed,
      score: heuristic.score,
      trend: heuristic.trend,
      recommendation: heuristic.recommendation,
      dataAsOf,
      historyDays,
      strategy,
      dataSource: normalizeDataSource(snapshot.source),
      metrics,
      summary: aiSummary.summary,
      details: {
        heuristicNotes: heuristic.heuristicNotes,
        supportLevels: heuristic.supportLevels,
        resistanceLevels: heuristic.resistanceLevels,
        recentCloses: recentCloses.map((value) => round(value, 2) || value),
        recentBars,
        factorScores,
        tradePlan,
        newsIntel,
        pipelineLog,
      },
    };
  }

  /* ─── History & Detail ─── */

  async listTasks(input: {
    limit?: number;
    statuses?: StockAnalysisTaskStatus[];
  } = {}): Promise<{ tasks: StockAnalysisTaskSummary[] }> {
    return await listTaskSummaries(input);
  }

  async deleteTask(taskId: string): Promise<{ ok: true; deleted: number; }> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error(t('errors.auto_c0d836', {}, undefined));
    }
    const task = await getStockAnalysisTask(normalizedTaskId);
    if (!task) {
      throw new Error(t('errors.auto_c0d836', {}, undefined));
    }
    if (task.status === 'pending' || task.status === 'running') {
      throw new Error(t('stock.auto_d520c7', {}, undefined));
    }
    return {
      ok: true,
      deleted: await deleteStockAnalysisTask(normalizedTaskId),
    };
  }

  async clearTasks(input: {
    statuses?: StockAnalysisTaskStatus[];
  } = {}): Promise<{ ok: true; deleted: number; }> {
    const requestedStatuses = Array.isArray(input.statuses)
      ? input.statuses.filter((status): status is StockAnalysisTaskStatus =>
          VALID_TASK_STATUSES.includes(status),
        )
      : [];
    const statuses: StockAnalysisTaskStatus[] =
      requestedStatuses.length > 0 ? requestedStatuses : ['failed'];
    if (statuses.includes('pending') || statuses.includes('running')) {
      throw new Error(t('stock.auto_a93a98', {}, undefined));
    }
    return {
      ok: true,
      deleted: await deleteStockAnalysisTasksByStatuses(statuses),
    };
  }

  async listHistory(
    input: { limit?: number; offset?: number; stockCode?: string } = {},
  ): Promise<{ items: StockAnalysisHistoryItem[]; total: number; }> {
    return await listHistorySummaries(input);
  }

  async getHistoryDetail(id: string): Promise<StockAnalysisDetail | null> {
    return await getHistoryDetailById(id);
  }

  async getHistoryDashboard(
    id: string,
  ): Promise<StockAnalysisDecisionDashboard | null> {
    return await getHistoryDashboardById(id);
  }

  async getReportCenterSnapshot(input: {
    limit?: number;
    offset?: number;
    stockCode?: string;
  } = {}): Promise<StockAnalysisReportCenterResponse> {
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
    const offset = Math.max(0, Number(input.offset) || 0);
    return {
      history: {
        ...(await this.listHistory({
          limit,
          offset,
          stockCode: input.stockCode,
        })),
        limit,
        offset,
      },
      tasks: await this.getTaskCollection(limit),
      feedback: await this.getFeedbackSnapshot(),
    };
  }

  async getPortfolioDashboardSnapshot(
    limit = 20,
  ): Promise<StockAnalysisPortfolioDashboardResponse> {
    const watchlist = (await this.listWatchlist()).items;
    const latestReports = (
      await Promise.all(
        watchlist.map((item) =>
          this.listHistory({ limit: 1, stockCode: item.stockCode }),
        ),
      )
    )
      .map((history) => history.items[0])
      .filter((item): item is StockAnalysisHistoryItem => Boolean(item));
    return {
      watchlist: {
        items: watchlist,
        total: watchlist.length,
      },
      latestReports,
    };
  }

  async getReportDetailBundle(
    id: string,
  ): Promise<StockAnalysisReportDetailBundle | null> {
    const report = await this.getHistoryDetail(id);
    if (!report) {
      return null;
    }
    return {
      report,
      validation: await this.getReportValidation(id),
      dashboard: await this.getHistoryDashboard(id),
    };
  }

  /* ─── Validation ─── */

  async getReportValidation(id: string): Promise<StockAnalysisReportValidation> {
    const report = await this.getHistoryDetail(id);
    if (!report) {
      throw new Error(t('errors.auto_4c08b4', {}, undefined));
    }
    const targetDate = toIsoTradeDate(report.dataAsOf || report.createdAt);
    if (
      !targetDate ||
      typeof report.metrics.currentPrice !== 'number' ||
      !Number.isFinite(report.metrics.currentPrice) ||
      report.metrics.currentPrice <= 0
    ) {
      return normalizeReportValidation({
        status: 'unavailable',
        targetDate,
        nextTradingDate: null,
        verdict: 'pending',
        matchScore: null,
        nextDayReturnPct: null,
        nextDayClose: null,
        summary: t('stock.auto_4c8ed8', {}, undefined),
        reasons: [t('stock.auto_ed2c7f', {}, undefined)],
      });
    }

    const normalized = normalizeStockSymbol(report.stockCode, report.market);
    const historyDays = Math.max(120, report.historyDays || 180);
    const analysisConfig = (await this.getConfig()).config;
    const snapshot = await fetchStockMarketSnapshot(normalized, {
      fetchImpl: this.fetchImpl,
      timeoutMs: Number(analysisConfig.requestTimeoutMs) || 12000,
      historyDays: Math.max(historyDays, 365),
      preferredProvider: resolvePreferredMarketDataProvider(
        analysisConfig,
        report.market,
      ),
      providerPriority: resolveMarketDataProviderPriority(
        analysisConfig,
        report.market,
      ),
    });
    const nextBar = snapshot.bars.find((bar) => {
      const date = toIsoTradeDate(bar.timestamp);
      return Boolean(date && date > targetDate);
    });
    if (!nextBar) {
      return normalizeReportValidation({
        status: 'pending',
        targetDate,
        nextTradingDate: null,
        verdict: 'pending',
        matchScore: null,
        nextDayReturnPct: null,
        nextDayClose: null,
        summary: t('stock.auto_f57bca', {}, undefined),
        reasons: [t('stock.auto_1917a2', {}, undefined)],
      });
    }

    const nextDayReturnPct =
      round(
        ((nextBar.close - report.metrics.currentPrice) / report.metrics.currentPrice) *
          100,
        2,
      ) || 0;
    const expectsBullish =
      report.recommendation === t('stock.auto_f2f24d', {}, undefined) || report.trend === 'bullish';
    const expectsDefensive =
      report.recommendation === t('stock.auto_1d90bd', {}, undefined) || report.trend === 'bearish';

    let matchScore = 60;
    if (expectsBullish) {
      matchScore =
        nextDayReturnPct >= 2
          ? 92
          : nextDayReturnPct > 0
            ? 78
            : nextDayReturnPct > -2
              ? 56
              : 28;
    } else if (expectsDefensive) {
      matchScore =
        nextDayReturnPct <= -2
          ? 90
          : nextDayReturnPct < 0
            ? 76
            : nextDayReturnPct < 2
              ? 54
              : 24;
    } else {
      const absReturn = Math.abs(nextDayReturnPct);
      matchScore = absReturn <= 1.5 ? 82 : absReturn <= 3 ? 64 : 38;
    }
    const verdict =
      matchScore >= 75
        ? 'matched'
        : matchScore >= 55
          ? 'partially_matched'
          : 'mismatched';
    const sortedFactors = [...report.details.factorScores].sort(
      (left, right) => right.score / right.maxScore - left.score / left.maxScore,
    );
    const positiveDrivers = sortedFactors
      .filter((item) => item.signal === 'positive')
      .slice(0, 2)
      .map((item) => `${item.title}偏强`);
    const negativeDrivers = report.details.factorScores
      .filter((item) => item.signal === 'negative')
      .slice(0, 2)
      .map((item) => `${item.title}拖累`);
    const reasons: string[] = [];
    if (expectsBullish) {
      reasons.push(
        nextDayReturnPct > 0
          ? t('stock.auto_529ab6', {}, undefined)
          : t('stock.auto_364cbc', {}, undefined),
      );
    } else if (expectsDefensive) {
      reasons.push(
        nextDayReturnPct < 0
          ? t('stock.auto_cf2b0b', {}, undefined)
          : t('stock.auto_c5f407', {}, undefined),
      );
    } else {
      reasons.push(
        Math.abs(nextDayReturnPct) <= 1.5
          ? t('stock.auto_c4e012', {}, undefined)
          : t('stock.auto_da7a55', {}, undefined),
      );
    }
    if (positiveDrivers.length > 0) {
      reasons.push(`报告主要依赖 ${positiveDrivers.join('、')}。`);
    }
    if (nextDayReturnPct < 0 && negativeDrivers.length > 0) {
      reasons.push(`次日走弱时，${negativeDrivers.join('、')} 的负面影响被放大。`);
    }
    if (
      report.details.newsIntel.status === 'ready' &&
      report.details.newsIntel.summary
    ) {
      reasons.push(`消息面参考为：${report.details.newsIntel.summary}`);
    }

    const verdictLabel =
      verdict === 'matched'
        ? t('stock.auto_f7eede', {}, undefined)
        : verdict === 'partially_matched'
          ? t('stock.auto_fe5489', {}, undefined)
          : t('stock.auto_4504eb', {}, undefined);
    return normalizeReportValidation({
      status: 'validated',
      targetDate,
      nextTradingDate: toIsoTradeDate(nextBar.timestamp),
      verdict,
      matchScore,
      nextDayReturnPct,
      nextDayClose: nextBar.close,
      summary: `报告交易日后的下一交易日为 ${toIsoTradeDate(nextBar.timestamp)}，收盘涨跌 ${formatPct(
        nextDayReturnPct,
      )}，与当时建议${verdictLabel}。`,
      reasons,
    });
  }

  /* ─── Feedback ─── */

  async getFeedbackSnapshot(
    input: {
      lookaheadDays?: number;
      limit?: number;
    } = {},
  ): Promise<StockAnalysisFeedbackSnapshot> {
    return await buildFeedbackSnapshot((await this.getConfig()).config, input);
  }

  /* ─── Market Review ─── */

  async getMarketDashboardSnapshot(input: {
    marketScope?: StockAnalysisMarketScope;
    strategyPreset?: StockAnalysisStrategyPreset;
    stockCode?: string;
    limit?: number;
    lookaheadDays?: number;
  } = {}): Promise<StockAnalysisMarketDashboardResponse> {
    return {
      review: await this.getLatestMarketReview(input.marketScope),
      backtest: await this.runBacktest({
        strategyPreset: input.strategyPreset,
        stockCode: input.stockCode,
        limit: input.limit,
        lookaheadDays: input.lookaheadDays,
      }),
      dataProviders: this.getDataProviderStatus(),
    };
  }

  async runMarketReview(
    input: {
      marketScope?: StockAnalysisMarketScope;
    } = {},
  ): Promise<StockAnalysisMarketReview> {
    const config = (await this.getConfig()).config;
    const marketScope =
      input.marketScope ||
      (config.marketReviewScope as StockAnalysisMarketScope);
    const indices = getMarketIndexSymbols(
      marketScope,
      Number(config.marketReviewIndicesPerMarket) || 3,
    );
    const snapshotResults = await Promise.allSettled(
      indices.map((symbol) =>
        fetchStockMarketSnapshot(symbol, {
          fetchImpl: this.fetchImpl,
          timeoutMs: Number(config.requestTimeoutMs) || 12000,
        }),
      ),
    );
    const snapshots: Awaited<ReturnType<typeof fetchStockMarketSnapshot>>[] = [];
    const failedIndices: Array<{
      symbol: string;
      name: string;
      error: string;
    }> = [];
    snapshotResults.forEach((result, index) => {
      const symbol = indices[index];
      if (!symbol) {
        return;
      }
      if (result.status === 'fulfilled') {
        snapshots.push(result.value);
        return;
      }
      const reason = result.reason;
      failedIndices.push({
        symbol: symbol.stockCode,
        name: symbol.displayName,
        error: reason instanceof Error ? reason.message : t('stock.auto_974e74', {}, undefined),
      });
    });
    if (snapshots.length === 0) {
      const failureDetails = failedIndices
        .map((item) => `${item.name}(${item.symbol}): ${item.error}`)
        .join('；');
      throw new Error(
        failureDetails
          ? `市场复盘失败：${failureDetails}`
          : t('stock.auto_44be5f', {}, undefined),
      );
    }
    const detail: StockAnalysisMarketReview['detail'] = {
      indices: snapshots.map((snapshot) => ({
        symbol: snapshot.symbol.stockCode,
        name: snapshot.symbol.displayName,
        price: round(snapshot.currentPrice, 2),
        changePct: round(snapshot.changePct, 2),
        providerLabel: snapshot.source.providerLabel,
        priceSource: snapshot.source.priceSource,
        priceSourceLabel: snapshot.source.priceSourceLabel,
        dataAsOf: snapshot.bars[snapshot.bars.length - 1]?.timestamp || null,
      })),
      dataAsOfDates: [],
      notes: [],
    };
    if (failedIndices.length > 0) {
      detail.notes.push(
        `有 ${failedIndices.length} 个指数暂不可用：${failedIndices
          .map((item) => item.name)
          .join('、')}。`,
      );
    }
    detail.dataAsOfDates = Array.from(
      new Set(
        detail.indices
          .map((item) => toIsoTradeDate(item.dataAsOf))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();
    const tradeDate =
      detail.dataAsOfDates.length > 0
        ? detail.dataAsOfDates[detail.dataAsOfDates.length - 1]
        : null;

    const strongest = [...detail.indices]
      .filter((item) => typeof item.changePct === 'number')
      .sort((left, right) => (right.changePct || 0) - (left.changePct || 0))[0];
    const weakest = [...detail.indices]
      .filter((item) => typeof item.changePct === 'number')
      .sort((left, right) => (left.changePct || 0) - (right.changePct || 0))[0];

    if (strongest) {
      detail.notes.push(
        `相对最强指数为 ${strongest.name}，涨跌幅 ${formatPct(strongest.changePct)}。`,
      );
    }
    if (weakest && weakest !== strongest) {
      detail.notes.push(
        `相对最弱指数为 ${weakest.name}，涨跌幅 ${formatPct(weakest.changePct)}。`,
      );
    }
    if (detail.dataAsOfDates.length > 1) {
      detail.notes.push(
        `当前复盘覆盖多个交易日：${detail.dataAsOfDates.join(' / ')}。`,
      );
    }
    const realtimeCount = detail.indices.filter(
      (item) => item.priceSource === 'realtime_quote',
    ).length;
    if (realtimeCount > 0) {
      detail.notes.push(
        `本次复盘有 ${realtimeCount} 个指数使用实时行情覆盖，其余指数沿用最近一根日线收盘。`,
      );
    } else if (detail.indices.length > 0) {
      detail.notes.push(t('stock.auto_65d984', {}, undefined));
    }

    const avgChange =
      average(
        detail.indices
          .map((item) => item.changePct)
          .filter((value): value is number => typeof value === 'number'),
      ) || 0;
    const stance = avgChange >= 1 ? t('stock.auto_cc00d9', {}, undefined) : avgChange <= -1 ? t('stock.auto_eab21e', {}, undefined) : t('stock.auto_62731a', {}, undefined);
    const review: StockAnalysisMarketReview = {
      id: `market-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      marketScope,
      createdAt: new Date().toISOString(),
      tradeDate,
      modelUsed: null,
      summary: {
        headline:
          marketScope === 'both'
            ? t('stock.auto_c76641', {}, undefined)
            : marketScope === 'cn'
              ? t('stock.auto_57801f', {}, undefined)
              : marketScope === 'hk'
                ? t('stock.auto_ae5638', {}, undefined)
                : marketScope === 'us'
                  ? t('stock.auto_5761c9', {}, undefined)
                  : t('stock.auto_957859', {}, undefined),
        overview: `指数均值表现 ${formatPct(avgChange)}，整体判断为${stance}。`,
        stance,
        keySignals: detail.notes,
      },
      detail,
    };

    if (config.aiSummaryEnabled) {
      try {
        const raw = await (
          this.generateText || generateTextWithDefaultProvider
        )(
          await buildMarketReviewPrompt({ reviewData: review }),
          this.generateText
            ? undefined
            : {
                promptTrace: {
                  promptKey: 'stock_analysis.market_review',
                  featureScope: 'stock_analysis',
                  metadata: {
                    marketScope,
                    tradeDate,
                  },
                },
              },
        );
        const parsed =
          extractJsonObject<StockAnalysisMarketReview['summary']>(raw);
        if (
          parsed &&
          typeof parsed.headline === 'string' &&
          typeof parsed.overview === 'string' &&
          typeof parsed.stance === 'string' &&
          Array.isArray(parsed.keySignals)
        ) {
          review.summary = parsed;
          review.modelUsed = 'default-provider';
        }
      } catch {
        // Fall through to deterministic market review summary.
      }
    }

    await createStockAnalysisMarketReview({
      id: review.id,
      market_scope: review.marketScope,
      trade_date: review.tradeDate,
      summary_json: JSON.stringify(review.summary),
      detail_json: JSON.stringify(review.detail),
      model_used: review.modelUsed,
      created_at: review.createdAt,
    });
    return review;
  }

  async getLatestMarketReview(
    marketScope?: StockAnalysisMarketScope,
  ): Promise<StockAnalysisMarketReview | null> {
    const record = await getLatestStockAnalysisMarketReview(marketScope);
    if (!record) return null;
    const detail = normalizeMarketReviewDetail(
      JSON.parse(record.detail_json) as Partial<
        StockAnalysisMarketReview['detail']
      >,
    );
    return {
      id: record.id,
      marketScope: record.market_scope as StockAnalysisMarketScope,
      createdAt: record.created_at,
      tradeDate:
        record.trade_date ||
        detail.dataAsOfDates[detail.dataAsOfDates.length - 1] ||
        null,
      modelUsed: record.model_used,
      summary: JSON.parse(
        record.summary_json,
      ) as StockAnalysisMarketReview['summary'],
      detail,
    };
  }

  /* ─── Backtest ─── */

  async runBacktest(
    request: StockAnalysisBacktestRequest = {},
  ): Promise<StockAnalysisBacktestResult> {
    const config = (await this.getConfig()).config;
    return this.backtestEngine.runBacktest(request, config);
  }

  /* ─── Misc ─── */

  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (this.activeCount > 0 || this.queue.length > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error('Timed out waiting for stock analysis queue');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

let singleton: StockAnalysisService | null = null;

export function getStockAnalysisService(): StockAnalysisService {
  if (!singleton) {
    singleton = new StockAnalysisService();
  }
  return singleton;
}

export function _resetStockAnalysisServiceForTests(): void {
  singleton = null;
}

export { resolveBiasSafetyThreshold, buildHeuristicAssessment } from './stock-analysis-heuristic.js';
