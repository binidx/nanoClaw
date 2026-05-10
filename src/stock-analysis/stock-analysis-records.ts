import {
  countStockAnalysisReports,
  getStockAnalysisReport,
  getStockAnalysisTask,
  listStockAnalysisReports,
  listStockAnalysisTasks,
  listStockAnalysisWatchlist,
} from '../db.js';
import {
  normalizeDataSource,
  normalizeDetailPayload,
  normalizeMetricSnapshot,
  normalizeStrategyInfo,
  normalizeStrategyPreset,
  normalizeSummaryPayload,
} from './stock-analysis-normalize.js';
import type {
  StockAnalysisDataSource,
  StockAnalysisDecisionDashboard,
  StockAnalysisDetail,
  StockAnalysisHistoryItem,
  StockAnalysisMarket,
  StockAnalysisReportType,
  StockAnalysisStrategyInfo,
  StockAnalysisSummary,
  StockAnalysisTaskStatus,
  StockAnalysisTaskSummary,
  StockAnalysisWatchlistItem,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

const VALID_TASK_STATUSES: StockAnalysisTaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
];

type TaskRow = NonNullable<Awaited<ReturnType<typeof getStockAnalysisTask>>>;
type ReportRow = Awaited<ReturnType<typeof listStockAnalysisReports>>[number];
type WatchlistRow = Awaited<ReturnType<typeof listStockAnalysisWatchlist>>[number];

interface ParsedReportPayload {
  summary: Partial<StockAnalysisSummary>;
  detail: {
    strategy?: Partial<StockAnalysisStrategyInfo>;
    dataSource?: Partial<StockAnalysisDataSource>;
    metrics?: StockAnalysisDetail['metrics'];
    details?: Partial<StockAnalysisDetail['details']>;
  };
}

export function toTaskSummary(row: TaskRow): StockAnalysisTaskSummary {
  return {
    id: row.id,
    stockCode: row.stock_code,
    stockName: row.stock_name || row.stock_code,
    market: row.market as StockAnalysisMarket,
    status: row.status as StockAnalysisTaskStatus,
    reportType: row.report_type as StockAnalysisReportType,
    strategyPreset: normalizeStrategyPreset(row.strategy_preset),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    reportId: row.report_id,
    resultMode: row.result_mode as StockAnalysisTaskSummary['resultMode'],
    dataAsOf: row.data_as_of,
  };
}

export function toHistoryItem(row: ReportRow): StockAnalysisHistoryItem {
  return {
    id: row.id,
    stockCode: row.stock_code,
    stockName: row.stock_name || row.stock_code,
    market: row.market as StockAnalysisMarket,
    reportType: row.report_type as StockAnalysisReportType,
    score: row.score,
    trend: row.trend,
    recommendation: row.recommendation,
    currentPrice: row.current_price,
    changePct: row.change_pct,
    createdAt: row.created_at,
    dataAsOf: row.data_as_of,
    historyDays: row.history_days,
  };
}

export function toWatchlistItem(row: WatchlistRow): StockAnalysisWatchlistItem {
  return {
    stockCode: row.stock_code,
    stockName: row.stock_name,
    market: row.market as StockAnalysisMarket,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseReportPayload(row: ReportRow): ParsedReportPayload {
  let summary: Partial<StockAnalysisSummary> = {};
  let detail: ParsedReportPayload['detail'] = {};

  try {
    summary = JSON.parse(row.summary_json) as Partial<StockAnalysisSummary>;
  } catch {
    summary = {};
  }

  try {
    detail = JSON.parse(row.detail_json) as ParsedReportPayload['detail'];
  } catch {
    detail = {};
  }

  return { summary, detail };
}

export function parseStrategyFromReportRow(
  row: ReportRow,
): StockAnalysisStrategyInfo {
  return normalizeStrategyInfo(parseReportPayload(row).detail.strategy);
}

function buildFallbackSummary(row: ReportRow): StockAnalysisSummary {
  return {
    headline: `${row.stock_name || row.stock_code}(${row.stock_code})`,
    analysisSummary: t('stock.auto_07ceb4', {}, undefined),
    operationAdvice: t('stock.auto_53bb71', {}, undefined),
    riskSignals: [t('stock.auto_72f978', {}, undefined)],
    catalystSignals: [t('stock.auto_a29115', {}, undefined)],
  };
}

function toHistoryDetail(row: ReportRow): StockAnalysisDetail {
  const payload = parseReportPayload(row);
  return {
    id: row.id,
    stockCode: row.stock_code,
    stockName: row.stock_name || row.stock_code,
    market: row.market as StockAnalysisMarket,
    reportType: row.report_type as StockAnalysisReportType,
    createdAt: row.created_at,
    modelUsed: row.model_used,
    score: row.score,
    trend: row.trend,
    recommendation: row.recommendation,
    dataAsOf: row.data_as_of,
    historyDays: row.history_days,
    strategy: normalizeStrategyInfo(payload.detail.strategy),
    dataSource: normalizeDataSource(payload.detail.dataSource),
    metrics: normalizeMetricSnapshot(payload.detail.metrics, {
      currentPrice: row.current_price ?? 0,
      changePct: row.change_pct ?? null,
    }),
    summary: normalizeSummaryPayload(
      payload.summary,
      buildFallbackSummary(row),
    ),
    details: normalizeDetailPayload(payload.detail.details),
  };
}

export function buildDecisionDashboard(
  detail: StockAnalysisDetail,
): StockAnalysisDecisionDashboard {
  return {
    signal: detail.score >= 72 ? 'green' : detail.score >= 52 ? 'yellow' : 'red',
    verdict: `${detail.stockName}(${detail.stockCode}) 当前结论：${detail.recommendation}。`,
    keyMetrics: {
      price: detail.metrics.currentPrice,
      changePct: detail.metrics.changePct,
      maAligned: detail.metrics.maAligned,
      trendState: detail.metrics.trendState,
      macdState: detail.metrics.macdState,
      rsiState: detail.metrics.rsiState,
      volumeState: detail.metrics.volumeState,
    },
    factorChart: detail.details.factorScores.map((item) => ({
      key: item.key,
      title: item.title,
      score: item.score,
      maxScore: item.maxScore,
    })),
    tradePlan: detail.details.tradePlan,
  };
}

export async function listTaskSummaries(input: {
  limit?: number;
  statuses?: StockAnalysisTaskStatus[];
}): Promise<{ tasks: StockAnalysisTaskSummary[]; }> {
  const requestedStatuses = Array.isArray(input.statuses)
    ? input.statuses.filter((status): status is StockAnalysisTaskStatus =>
        VALID_TASK_STATUSES.includes(status),
      )
    : [];
  const rows = await listStockAnalysisTasks({
    limit: Math.max(1, Math.min(100, Number(input.limit) || 50)),
    statuses: requestedStatuses,
  });
  return {
    tasks: rows.map((task) => toTaskSummary(task)),
  };
}

export async function listHistorySummaries(
  input: { limit?: number; offset?: number; stockCode?: string } = {},
): Promise<{ items: StockAnalysisHistoryItem[]; total: number; }> {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const offset = Math.max(0, Number(input.offset) || 0);
  const stockCode = input.stockCode?.trim();
  return {
    items: (await listStockAnalysisReports(limit, offset, stockCode)).map((row) =>
      toHistoryItem(row),
    ),
    total: await countStockAnalysisReports(stockCode),
  };
}

export async function getHistoryDetailById(id: string): Promise<StockAnalysisDetail | null> {
  const record = await getStockAnalysisReport(id);
  if (!record) {
    return null;
  }
  return toHistoryDetail(record);
}

export async function getHistoryDashboardById(
  id: string,
): Promise<StockAnalysisDecisionDashboard | null> {
  const detail = await getHistoryDetailById(id);
  return detail ? buildDecisionDashboard(detail) : null;
}

export async function listWatchlistItems(): Promise<StockAnalysisWatchlistItem[]> {
  return (await listStockAnalysisWatchlist()).map((item) => toWatchlistItem(item));
}
