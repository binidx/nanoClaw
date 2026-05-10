import {
  countStockAnalysisReports,
  listStockAnalysisReports,
} from '../db.js';
import type { StockAnalysisConfigMap } from './stock-analysis-config.js';
import { readNumericConfig, round, clamp } from './stock-analysis-technical.js';
import {
  parseStrategyFromReportRow,
} from './stock-analysis-records.js';
import type {
  StockAnalysisFeedbackEvaluation,
  StockAnalysisFeedbackSnapshot,
  StockAnalysisMarket,
  StockAnalysisStrategyFeedbackSummary,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

type ReportRow = Awaited<ReturnType<typeof listStockAnalysisReports>>[number];

function groupRowsByStock(rows: ReportRow[]): Map<string, ReportRow[]> {
  const rowsByStock = new Map<string, ReportRow[]>();
  rows.forEach((row) => {
    const bucket = rowsByStock.get(row.stock_code) || [];
    bucket.push(row);
    rowsByStock.set(row.stock_code, bucket);
  });
  return rowsByStock;
}

function buildEvaluations(
  rows: ReportRow[],
  lookaheadDays: number,
  winThresholdPct: number,
  lossThresholdPct: number,
): StockAnalysisFeedbackEvaluation[] {
  const evaluations: StockAnalysisFeedbackEvaluation[] = [];
  groupRowsByStock(rows).forEach((stockRows) => {
    const ordered = [...stockRows].sort(
      (left, right) =>
        new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
    );
    ordered.forEach((row, index) => {
      const basePrice = row.current_price;
      if (
        typeof basePrice !== 'number' ||
        !Number.isFinite(basePrice) ||
        basePrice <= 0
      ) {
        return;
      }
      const reportTime = new Date(row.created_at).getTime();
      const future = ordered
        .slice(index + 1)
        .filter((candidate) => {
          if (
            typeof candidate.current_price !== 'number' ||
            !Number.isFinite(candidate.current_price)
          ) {
            return false;
          }
          const diffDays =
            (new Date(candidate.created_at).getTime() - reportTime) /
            (24 * 60 * 60 * 1000);
          return diffDays > 0 && diffDays <= lookaheadDays;
        })
        .at(-1);
      if (!future || typeof future.current_price !== 'number') {
        return;
      }
      const realizedReturnPct =
        round(((future.current_price - basePrice) / basePrice) * 100, 2) || 0;
      const outcome =
        realizedReturnPct >= winThresholdPct
          ? 'win'
          : realizedReturnPct <= lossThresholdPct
            ? 'loss'
            : 'flat';
      evaluations.push({
        reportId: row.id,
        stockCode: row.stock_code,
        stockName: row.stock_name || row.stock_code,
        market: row.market as StockAnalysisMarket,
        strategy: parseStrategyFromReportRow(row),
        recommendation: row.recommendation,
        score: row.score,
        reportCreatedAt: row.created_at,
        basePrice,
        evaluationCreatedAt: future.created_at,
        evaluationPrice: future.current_price,
        holdingDays: Math.max(
          1,
          Math.round(
            (new Date(future.created_at).getTime() - reportTime) /
              (24 * 60 * 60 * 1000),
          ),
        ),
        realizedReturnPct,
        outcome,
      });
    });
  });
  return evaluations;
}

function buildStrategySummaries(
  rows: ReportRow[],
  evaluations: StockAnalysisFeedbackEvaluation[],
): StockAnalysisStrategyFeedbackSummary[] {
  const sampleRows = rows.filter(
    (row) =>
      typeof row.current_price === 'number' &&
      Number.isFinite(row.current_price) &&
      row.current_price > 0,
  );
  const strategyMap = new Map<string, StockAnalysisStrategyFeedbackSummary>();

  sampleRows.forEach((row) => {
    const strategy = parseStrategyFromReportRow(row);
    const key = strategy.cacheKey;
    if (!strategyMap.has(key)) {
      strategyMap.set(key, {
        strategy,
        sampleSize: 0,
        evaluatedCount: 0,
        bullishSampleSize: 0,
        bullishWinRate: null,
        avgReturnPct: null,
      });
    }
    const summary = strategyMap.get(key)!;
    summary.sampleSize += 1;
    if (row.recommendation === t('stock.auto_f2f24d', {}, undefined)) {
      summary.bullishSampleSize += 1;
    }
  });

  strategyMap.forEach((summary, key) => {
    const matched = evaluations.filter((item) => item.strategy.cacheKey === key);
    summary.evaluatedCount = matched.length;
    summary.avgReturnPct =
      matched.length > 0
        ? round(
            matched.reduce((sum, item) => sum + item.realizedReturnPct, 0) /
              matched.length,
            2,
          )
        : null;
    const bullish = matched.filter((item) => item.recommendation === t('stock.auto_f2f24d', {}, undefined));
    summary.bullishWinRate =
      bullish.length > 0
        ? round(
            (bullish.filter((item) => item.outcome === 'win').length /
              bullish.length) *
              100,
            1,
          )
        : null;
  });

  return [...strategyMap.values()].sort((left, right) => {
    const leftRate = left.bullishWinRate ?? -1;
    const rightRate = right.bullishWinRate ?? -1;
    if (rightRate !== leftRate) {
      return rightRate - leftRate;
    }
    return right.sampleSize - left.sampleSize;
  });
}

export async function buildFeedbackSnapshot(
  config: StockAnalysisConfigMap,
  input: {
    lookaheadDays?: number;
    limit?: number;
  } = {},
): Promise<StockAnalysisFeedbackSnapshot> {
  const lookaheadDays = clamp(
    Math.round(
      Number(input.lookaheadDays) || Number(config.feedbackLookaheadDays) || 10,
    ),
    3,
    30,
  );
  const winThresholdPct = readNumericConfig(
    config,
    'feedbackWinThresholdPct',
    3,
  );
  const lossThresholdPct = readNumericConfig(
    config,
    'feedbackLossThresholdPct',
    -3,
  );
  const totalReports = await countStockAnalysisReports();
  const reportLimit = clamp(
    Math.round(Number(input.limit) || totalReports),
    20,
    240,
  );
  const rows = await listStockAnalysisReports(reportLimit, 0);
  const sampleRows = rows.filter(
    (row) =>
      typeof row.current_price === 'number' &&
      Number.isFinite(row.current_price) &&
      row.current_price > 0,
  );
  const evaluations = buildEvaluations(
    rows,
    lookaheadDays,
    winThresholdPct,
    lossThresholdPct,
  );
  const bullishEvaluations = evaluations.filter(
    (item) => item.recommendation === t('stock.auto_f2f24d', {}, undefined),
  );

  return {
    generatedAt: new Date().toISOString(),
    lookaheadDays,
    winThresholdPct,
    lossThresholdPct,
    summary: {
      sampleSize: sampleRows.length,
      evaluatedCount: evaluations.length,
      bullishSampleSize: sampleRows.filter(
        (row) => row.recommendation === t('stock.auto_f2f24d', {}, undefined),
      ).length,
      bullishWinRate:
        bullishEvaluations.length > 0
          ? round(
              (bullishEvaluations.filter((item) => item.outcome === 'win').length /
                bullishEvaluations.length) *
                100,
              1,
            )
          : null,
      avgReturnPct:
        evaluations.length > 0
          ? round(
              evaluations.reduce((sum, item) => sum + item.realizedReturnPct, 0) /
                evaluations.length,
              2,
            )
          : null,
    },
    strategies: buildStrategySummaries(rows, evaluations),
    recentEvaluations: evaluations
      .sort(
        (left, right) =>
          new Date(right.reportCreatedAt).getTime() -
          new Date(left.reportCreatedAt).getTime(),
      )
      .slice(0, 8),
    notes: [
      `当前反馈基于本地历史报告，在报告发出后 ${lookaheadDays} 天内找到的后续报告价格进行回看。`,
      `收益率高于 ${winThresholdPct}% 记为胜出，低于 ${lossThresholdPct}% 记为失手。`,
      reportLimit < totalReports
        ? `当前仅统计最近 ${reportLimit} 份报告，完整结果会随历史增多继续更新。`
        : t('stock.auto_f6ff6f', {}, undefined),
    ],
  };
}
