/**
 * Stock Analysis Backtest Engine
 *
 * Provides systematic backtesting of historical analysis reports:
 * - Direction accuracy (did the predicted trend match actual movement?)
 * - Take-profit / stop-loss hit rates
 * - Win/loss/flat classification
 * - Per-strategy evaluation
 * - Overall statistics
 */

import {
  listStockAnalysisReports,
} from '../db.js';
import {
  fetchStockMarketSnapshot,
  normalizeStockSymbol,
} from './stock-analysis-market-data.js';
import { normalizeStrategyInfo, toIsoTradeDate } from './stock-analysis-normalize.js';
import { average, clamp, round } from './stock-analysis-technical.js';
import type {
  StockAnalysisBacktestRequest,
  StockAnalysisBacktestResult,
  StockAnalysisBacktestStrategyResult,
  StockAnalysisBacktestTradeResult,
  StockAnalysisMarket,
  StockAnalysisStrategyInfo,
  StockAnalysisTradePlan,
} from './stock-analysis-types.js';
import type { StockAnalysisConfigMap } from './stock-analysis-config.js';
import { t } from '../i18n/index.js';

interface ParsedReportForBacktest {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  strategy: StockAnalysisStrategyInfo;
  recommendation: string;
  score: number;
  createdAt: string;
  dataAsOf: string | null;
  basePrice: number;
  tradePlan: StockAnalysisTradePlan | null;
  trend: string;
}

type BacktestMaType = 'ema' | 'sma' | 'unknown';

function parseReportForBacktest(
  row: Awaited<ReturnType<typeof listStockAnalysisReports>>[number],
): ParsedReportForBacktest | null {
  if (
    typeof row.current_price !== 'number' ||
    !Number.isFinite(row.current_price) ||
    row.current_price <= 0
  ) {
    return null;
  }

  let strategy: StockAnalysisStrategyInfo;
  let tradePlan: StockAnalysisTradePlan | null = null;
  try {
    const detail = JSON.parse(row.detail_json) as {
      strategy?: Partial<StockAnalysisStrategyInfo>;
      details?: {
        tradePlan?: StockAnalysisTradePlan;
      };
    };
    strategy = normalizeStrategyInfo(detail.strategy);
    tradePlan = detail.details?.tradePlan ?? null;
  } catch {
    strategy = normalizeStrategyInfo({ id: 'bull_trend' });
  }

  return {
    id: row.id,
    stockCode: row.stock_code,
    stockName: row.stock_name || row.stock_code,
    market: row.market as StockAnalysisMarket,
    strategy,
    recommendation: row.recommendation,
    score: row.score,
    createdAt: row.created_at,
    dataAsOf: row.data_as_of,
    basePrice: row.current_price,
    tradePlan,
    trend: row.trend,
  };
}

function resolveBacktestMaType(cacheKey: string): BacktestMaType {
  const matched = cacheKey.match(/(?:^|\|)ma:(ema|sma)(?:\||$)/);
  if (matched?.[1] === 'ema') return 'ema';
  if (matched?.[1] === 'sma') return 'sma';
  return 'unknown';
}

function summarizeMaTypePerformance(
  label: 'EMA' | 'SMA',
  trades: StockAnalysisBacktestTradeResult[],
): string {
  const tradeCount = trades.length;
  const winCount = trades.filter((item) => item.outcome === 'win').length;
  const directionCorrectCount = trades.filter((item) => item.directionCorrect).length;
  const returns = trades.map((item) => item.returnPct);
  const winRate = tradeCount > 0 ? round((winCount / tradeCount) * 100, 1) : null;
  const directionAccuracy =
    tradeCount > 0 ? round((directionCorrectCount / tradeCount) * 100, 1) : null;
  const avgReturnPct = round(average(returns), 2);
  return `${label} ${tradeCount} 笔（胜率 ${winRate ?? '-'}%，均收益 ${avgReturnPct ?? '-'}%，方向准确率 ${directionAccuracy ?? '-'}%）`;
}

function computeMaTypePerformanceSnapshot(
  trades: StockAnalysisBacktestTradeResult[],
): {
  tradeCount: number;
  avgReturnPct: number | null;
  directionAccuracy: number | null;
  winRate: number | null;
} {
  const tradeCount = trades.length;
  const returns = trades.map((item) => item.returnPct);
  return {
    tradeCount,
    avgReturnPct: round(average(returns), 2),
    directionAccuracy:
      tradeCount > 0
        ? round(
            (trades.filter((item) => item.directionCorrect).length / tradeCount) * 100,
            1,
          )
        : null,
    winRate:
      tradeCount > 0
        ? round(
            (trades.filter((item) => item.outcome === 'win').length / tradeCount) * 100,
            1,
          )
        : null,
  };
}

function buildMaCalibrationRecommendation(
  emaTrades: StockAnalysisBacktestTradeResult[],
  smaTrades: StockAnalysisBacktestTradeResult[],
): string | null {
  if (emaTrades.length === 0 || smaTrades.length === 0) {
    return null;
  }
  const ema = computeMaTypePerformanceSnapshot(emaTrades);
  const sma = computeMaTypePerformanceSnapshot(smaTrades);
  const avgReturnGap = (ema.avgReturnPct ?? 0) - (sma.avgReturnPct ?? 0);
  const directionGap = (ema.directionAccuracy ?? 0) - (sma.directionAccuracy ?? 0);
  const winRateGap = (ema.winRate ?? 0) - (sma.winRate ?? 0);
  const thinSample = ema.tradeCount < 5 || sma.tradeCount < 5;
  const prefix = thinSample ? t('stock.auto_8ee45b', {}, undefined) : '';

  if (avgReturnGap <= -1 || directionGap <= -8 || winRateGap <= -10) {
    return `${prefix}EMA 口径暂弱于 SMA，建议下一轮优先继续收紧 EMA 的 bias near-band / overheat / safety 阈值，不新增指标。`;
  }
  if (avgReturnGap >= 1 && directionGap >= 5 && winRateGap >= 5) {
    return `${prefix}EMA 口径整体优于 SMA，可继续观察现有 EMA 阈值，暂不新增指标；如需微调，优先小幅放宽 safety 或 near-band。`;
  }
  return `${prefix}EMA/SMA 表现暂时接近，下一轮继续围绕 bias near-band / overheat / safety 做小步校准即可，不建议新增指标。`;
}

export function buildBacktestMaCalibrationNotes(
  trades: StockAnalysisBacktestTradeResult[],
): string[] {
  if (trades.length === 0) return [];
  const maTypeBuckets = new Map<BacktestMaType, StockAnalysisBacktestTradeResult[]>();
  for (const trade of trades) {
    const maType = resolveBacktestMaType(trade.strategy.cacheKey);
    const bucket = maTypeBuckets.get(maType) || [];
    bucket.push(trade);
    maTypeBuckets.set(maType, bucket);
  }
  const emaTrades = maTypeBuckets.get('ema') || [];
  const smaTrades = maTypeBuckets.get('sma') || [];
  const unknownTrades = maTypeBuckets.get('unknown') || [];
  const notes: string[] = [];
  if (emaTrades.length > 0 && smaTrades.length > 0) {
    notes.push(
      `均线口径拆分：${summarizeMaTypePerformance('EMA', emaTrades)}；${summarizeMaTypePerformance('SMA', smaTrades)}。`,
    );
  } else if (emaTrades.length > 0) {
    notes.push(`本次回测仅包含 EMA 口径策略：${summarizeMaTypePerformance('EMA', emaTrades)}。`);
  } else if (smaTrades.length > 0) {
    notes.push(`本次回测仅包含 SMA 口径策略：${summarizeMaTypePerformance('SMA', smaTrades)}。`);
  }
  const recommendation = buildMaCalibrationRecommendation(emaTrades, smaTrades);
  if (recommendation) {
    notes.push(recommendation);
  }
  if (unknownTrades.length > 0) {
    notes.push(
      `仍有 ${unknownTrades.length} 笔历史报告未标注均线口径（旧缓存键）。建议补齐 cacheKey 以支持 EMA/SMA 对比校准。`,
    );
  }
  return notes;
}

export class StockAnalysisBacktestEngine {
  private readonly fetchImpl: typeof fetch;

  constructor(deps: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = deps.fetchImpl || fetch;
  }

  async runBacktest(
    request: StockAnalysisBacktestRequest,
    config: StockAnalysisConfigMap,
  ): Promise<StockAnalysisBacktestResult> {
    const lookaheadDays = clamp(
      Math.round(Number(request.lookaheadDays) || Number(config.backtestLookaheadDays) || 10),
      3,
      30,
    );
    const maxReports = clamp(
      Math.round(Number(request.limit) || Number(config.backtestMaxReports) || 120),
      20,
      500,
    );

    // Fetch historical reports
    const allRows = await listStockAnalysisReports(maxReports, 0, request.stockCode);
    const reports: ParsedReportForBacktest[] = [];

    for (const row of allRows) {
      const parsed = parseReportForBacktest(row);
      if (!parsed) continue;

      // Filter by strategy if specified
      if (request.strategyPreset && parsed.strategy.id !== request.strategyPreset) {
        continue;
      }

      reports.push(parsed);
    }

    // Evaluate each report against future price data
    const trades: StockAnalysisBacktestTradeResult[] = [];

    // Group reports by stock to minimize API calls
    const reportsByStock = new Map<string, ParsedReportForBacktest[]>();
    for (const report of reports) {
      const bucket = reportsByStock.get(report.stockCode) || [];
      bucket.push(report);
      reportsByStock.set(report.stockCode, bucket);
    }

    // Fetch market data in parallel batches instead of sequentially
    const BATCH_SIZE = 4;
    const stockEntries = [...reportsByStock.entries()];

    for (let batchStart = 0; batchStart < stockEntries.length; batchStart += BATCH_SIZE) {
      const batch = stockEntries.slice(batchStart, batchStart + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async ([stockCode, stockReports]) => {
          const firstReport = stockReports[0];
          const normalized = normalizeStockSymbol(stockCode, firstReport.market);
          const snapshot = await fetchStockMarketSnapshot(normalized, {
            fetchImpl: this.fetchImpl,
            historyDays: 365,
            timeoutMs: Number(config.requestTimeoutMs) || 12000,
          });
          return { stockReports, snapshot };
        }),
      );

      for (const result of batchResults) {
        if (result.status !== 'fulfilled') continue;
        const { stockReports, snapshot } = result.value;

        for (const report of stockReports) {
          const targetDate = toIsoTradeDate(report.dataAsOf || report.createdAt);
          if (!targetDate) continue;

          // Find bars N days after report date
          const futureBars = snapshot.bars.filter((bar) => {
            const date = toIsoTradeDate(bar.timestamp);
            return Boolean(date && date > targetDate);
          });

          if (futureBars.length === 0) continue;

          // Get the bar closest to lookaheadDays after report
          const exitBarIndex = Math.min(lookaheadDays - 1, futureBars.length - 1);
          const exitBar = futureBars[exitBarIndex];
          const exitPrice = exitBar.close;
          const returnPct =
            round(((exitPrice - report.basePrice) / report.basePrice) * 100, 2) || 0;

          // Check take-profit / stop-loss hits during the period
          const periodBars = futureBars.slice(0, exitBarIndex + 1);
          let takeProfitHit = false;
          let stopLossHit = false;

          if (report.tradePlan) {
            for (const bar of periodBars) {
              if (report.tradePlan.takeProfit !== null && bar.high >= report.tradePlan.takeProfit) {
                takeProfitHit = true;
              }
              if (report.tradePlan.stopLoss !== null && bar.low <= report.tradePlan.stopLoss) {
                stopLossHit = true;
              }
            }
          }

          // Direction accuracy
          const expectedBullish =
            report.recommendation === t('stock.auto_f2f24d', {}, undefined) || report.trend === 'bullish';
          const expectedBearish =
            report.recommendation === t('stock.auto_1d90bd', {}, undefined) || report.trend === 'bearish';
          const actualUp = returnPct > 0;
          const actualDown = returnPct < 0;
          const directionCorrect =
            (expectedBullish && actualUp) ||
            (expectedBearish && actualDown) ||
            (!expectedBullish && !expectedBearish && Math.abs(returnPct) <= 2);

          // Win/flat/loss
          const winThreshold = Number(config.feedbackWinThresholdPct) || 3;
          const lossThreshold = Number(config.feedbackLossThresholdPct) || -3;
          const outcome =
            returnPct >= winThreshold
              ? 'win'
              : returnPct <= lossThreshold
                ? 'loss'
                : 'flat';

          const holdingDays = Math.max(
            1,
            Math.round(
              (new Date(exitBar.timestamp).getTime() -
                new Date(targetDate).getTime()) /
                (24 * 60 * 60 * 1000),
            ),
          );

          trades.push({
            reportId: report.id,
            stockCode: report.stockCode,
            stockName: report.stockName,
            market: report.market,
            strategy: report.strategy,
            recommendation: report.recommendation,
            score: report.score,
            reportCreatedAt: report.createdAt,
            basePrice: report.basePrice,
            exitPrice: round(exitPrice, 2) || exitPrice,
            holdingDays,
            returnPct,
            takeProfitHit,
            stopLossHit,
            directionCorrect,
            outcome,
          });
        }
      }
    }

    // Calculate strategy-level statistics
    const strategyMap = new Map<string, StockAnalysisBacktestTradeResult[]>();
    for (const trade of trades) {
      const key = trade.strategy.cacheKey;
      const bucket = strategyMap.get(key) || [];
      bucket.push(trade);
      strategyMap.set(key, bucket);
    }

    const strategies: StockAnalysisBacktestStrategyResult[] = [];
    for (const [, strategyTrades] of strategyMap) {
      // Sort chronologically for drawdown calculation
      strategyTrades.sort(
        (a, b) =>
          new Date(a.reportCreatedAt).getTime() -
          new Date(b.reportCreatedAt).getTime(),
      );
      const strategy = strategyTrades[0].strategy;
      const tradeCount = strategyTrades.length;
      const winCount = strategyTrades.filter((t) => t.outcome === 'win').length;
      const lossCount = strategyTrades.filter((t) => t.outcome === 'loss').length;
      const flatCount = strategyTrades.filter((t) => t.outcome === 'flat').length;
      const returns = strategyTrades.map((t) => t.returnPct);

      // Max drawdown
      let maxDrawdown = 0;
      let peak = 0;
      let cumReturn = 0;
      for (const ret of returns) {
        cumReturn += ret;
        if (cumReturn > peak) peak = cumReturn;
        const drawdown = peak - cumReturn;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }

      // Profit factor
      const totalGains = returns.filter((r) => r > 0).reduce((s, r) => s + r, 0);
      const totalLosses = Math.abs(
        returns.filter((r) => r < 0).reduce((s, r) => s + r, 0),
      );

      strategies.push({
        strategy,
        tradeCount,
        winCount,
        lossCount,
        flatCount,
        winRate:
          tradeCount > 0 ? round((winCount / tradeCount) * 100, 1) : null,
        avgReturnPct: round(average(returns), 2),
        directionAccuracy:
          tradeCount > 0
            ? round(
                (strategyTrades.filter((t) => t.directionCorrect).length /
                  tradeCount) *
                  100,
                1,
              )
            : null,
        takeProfitHitRate:
          tradeCount > 0
            ? round(
                (strategyTrades.filter((t) => t.takeProfitHit).length /
                  tradeCount) *
                  100,
                1,
              )
            : null,
        stopLossHitRate:
          tradeCount > 0
            ? round(
                (strategyTrades.filter((t) => t.stopLossHit).length /
                  tradeCount) *
                  100,
                1,
              )
            : null,
        maxDrawdownPct: round(maxDrawdown, 2),
        profitFactor:
          totalLosses > 0 ? round(totalGains / totalLosses, 2) : null,
      });
    }

    // Sort strategies by win rate
    strategies.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

    // Overall statistics
    const totalTrades = trades.length;
    const allReturns = trades.map((t) => t.returnPct);

    return {
      generatedAt: new Date().toISOString(),
      lookaheadDays,
      totalTrades,
      overallWinRate:
        totalTrades > 0
          ? round(
              (trades.filter((t) => t.outcome === 'win').length / totalTrades) *
                100,
              1,
            )
          : null,
      overallAvgReturnPct: round(average(allReturns), 2),
      overallDirectionAccuracy:
        totalTrades > 0
          ? round(
              (trades.filter((t) => t.directionCorrect).length / totalTrades) *
                100,
              1,
            )
          : null,
      strategies,
      trades: trades
        .sort(
          (a, b) =>
            new Date(b.reportCreatedAt).getTime() -
            new Date(a.reportCreatedAt).getTime(),
        )
        .slice(0, 50),
      notes: [
        `回测基于 ${reports.length} 份历史报告，观测期 ${lookaheadDays} 天。`,
        `胜出阈值 ${Number(config.feedbackWinThresholdPct) || 3}%，失手阈值 ${Number(config.feedbackLossThresholdPct) || -3}%。`,
        ...buildBacktestMaCalibrationNotes(trades),
        totalTrades < reports.length
          ? `部分报告因后续行情数据不足被跳过。`
          : t('stock.auto_eb6278', {}, undefined),
        t('stock.auto_a02205', {}, undefined),
        t('stock.auto_02c002', {}, undefined),
      ],
    };
  }
}
