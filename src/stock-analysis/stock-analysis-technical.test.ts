import { describe, expect, it } from 'vitest';

import {
  buildFactorScores,
  buildRecentBars,
  buildTradePlan,
  computeMetrics,
  identifySupportResistanceLevels,
} from './stock-analysis-technical.js';
import { buildBacktestMaCalibrationNotes } from './stock-analysis-backtest.js';
import type {
  StockAnalysisBacktestTradeResult,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsIntel,
  StockAnalysisStrategyInfo,
} from './stock-analysis-types.js';

function computeExpectedEma(values: number[], period: number): number {
  const multiplier = 2 / (period + 1);
  let ema = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    ema = values[index]! * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function createBarsFromCloses(closes: number[]) {
  return closes.map((close, index) => {
    const prevClose = index > 0 ? closes[index - 1]! : close - 0.5;
    return {
      timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      open: prevClose,
      high: Math.max(close, prevClose) + 1.2,
      low: Math.min(close, prevClose) - 1.2,
      close,
      volume: 1_000_000 + index * 12_000,
    };
  });
}

function createMetricForTradePlan(overrides: Partial<StockAnalysisMetricSnapshot> = {}): StockAnalysisMetricSnapshot {
  return {
    currentPrice: 100,
    previousClose: 99,
    changePct: 1.01,
    ma5: 100,
    ma10: 99,
    biasToMa5: 0,
    biasToMa20: 1,
    ma20: 98,
    ma60: 95,
    high20: 108,
    low20: 94,
    maAligned: true,
    macdDiff: 0.5,
    macdSignal: 0.2,
    macdHistogram: 0.3,
    macdState: 'bullish_above_zero',
    rsi6: 60,
    rsi12: 58,
    rsi14: 57,
    rsi24: 55,
    rsiState: 'strong',
    momentum20: 8,
    annualizedVolatility: 24,
    volumeRatio5d20d: 1.1,
    volumeState: 'increased_volume',
    trendState: 'bullish',
    return60d: 12,
    bollingerUpper: 106,
    bollingerLower: 94,
    bollingerWidth: 12,
    atr14: 2,
    ...overrides,
  };
}

const DEFAULT_STRATEGY: StockAnalysisStrategyInfo = {
  id: 'bull_trend',
  label: '多头趋势',
  description: 'test',
  cacheKey: 'bull_trend',
  tuningNotes: [],
};

function createNewsIntel(overrides: Partial<StockAnalysisNewsIntel> = {}): StockAnalysisNewsIntel {
  return {
    status: 'ready',
    sourceType: 'provider_web_search',
    sourceLabel: 'test',
    usedExternalSearch: false,
    generatedAt: null,
    confidence: 'medium',
    summary: '',
    hotTopics: [],
    bullishSignals: [],
    riskSignals: [],
    references: [],
    evidence: [],
    evidenceStats: {
      total: 0,
      included: 0,
      dropped: 0,
      stale: 0,
      undated: 0,
      lowQuality: 0,
    },
    ...overrides,
  };
}

function pickFactorScore(
  factors: ReturnType<typeof buildFactorScores>,
  key: string,
) {
  const found = factors.find((item) => item.key === key);
  expect(found).toBeTruthy();
  return found!;
}

let backtestTradeSeq = 0;

function createBacktestTrade(
  cacheKey: string,
  overrides: Partial<StockAnalysisBacktestTradeResult> = {},
): StockAnalysisBacktestTradeResult {
  backtestTradeSeq += 1;
  return {
    reportId: `report-${backtestTradeSeq}`,
    stockCode: '600519',
    stockName: '贵州茅台',
    market: 'cn',
    strategy: {
      ...DEFAULT_STRATEGY,
      cacheKey,
    },
    recommendation: '偏强跟踪',
    score: 75,
    reportCreatedAt: new Date(Date.UTC(2026, 2, 1)).toISOString(),
    basePrice: 100,
    exitPrice: 103,
    holdingDays: 5,
    returnPct: 3,
    takeProfitHit: false,
    stopLossHit: false,
    directionCorrect: true,
    outcome: 'win',
    ...overrides,
  };
}

describe('stock-analysis-technical', () => {
  it('uses SMA by default and supports EMA metrics/recent bars when configured', () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 20 + index * 0.45 + ((index % 6) - 2) * 0.7,
    );
    const bars = createBarsFromCloses(closes);
    const volumes = bars.map((bar) => bar.volume);
    const currentPrice = closes[closes.length - 1]!;
    const previousClose = closes[closes.length - 2]!;

    const smaMetrics = computeMetrics(closes, volumes, currentPrice, previousClose, {
      ohlcBars: bars,
    });
    const emaMetrics = computeMetrics(closes, volumes, currentPrice, previousClose, {
      ohlcBars: bars,
      maType: 'ema',
    });
    const emaRecentBars = buildRecentBars(bars, 60, 'ema');

    const expectedEma20 = computeExpectedEma(closes, 20);
    const expectedSma20 =
      closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;

    expect(smaMetrics.ma20).toBeCloseTo(expectedSma20, 2);
    expect(emaMetrics.ma20).toBeCloseTo(expectedEma20, 2);
    expect(emaMetrics.ma20).not.toBe(smaMetrics.ma20);
    expect(emaRecentBars.at(-1)?.ma20).toBe(emaMetrics.ma20);
  });

  it('weights nearby support levels by swing volume instead of first price match', () => {
    const prices = [
      12, 11.8, 11.4, 10.0, 11.3, 11.7, 12.1,
      11.9, 11.6, 10.08, 11.4, 11.8, 12.2,
    ];
    const volumes = [
      1000, 1000, 1000, 100, 1000, 1000, 1000,
      1000, 1000, 1_000_000, 1000, 1000, 1000,
    ];

    const levels = identifySupportResistanceLevels(
      prices,
      11,
      null,
      null,
      null,
      null,
      null,
      null,
      volumes,
    );

    expect(levels.supportLevels).toHaveLength(1);
    // The higher-volume swing at 10.08 should pull the clustered level upward.
    expect(levels.supportLevels[0]).toBeCloseTo(10.06, 2);
  });

  it('uses ATR-based dynamic stop-loss when atr14 is available', () => {
    const metricsWithAtr = createMetricForTradePlan({ atr14: 2 });
    const planWithAtr = buildTradePlan(
      metricsWithAtr,
      [99, 97],
      [106, 109],
      'bullish',
      DEFAULT_STRATEGY,
    );

    const metricsWithoutAtr = createMetricForTradePlan({ atr14: null });
    const planWithoutAtr = buildTradePlan(
      metricsWithoutAtr,
      [99, 97],
      [106, 109],
      'bullish',
      DEFAULT_STRATEGY,
    );

    expect(planWithAtr.stopLoss).toBe(93);
    expect(planWithoutAtr.stopLoss).toBeCloseTo(94.09, 2);
  });

  it('applies tighter EMA bias thresholds than SMA in factor scoring', () => {
    const bars = buildRecentBars(
      createBarsFromCloses(
        Array.from({ length: 40 }, (_item, index) => 90 + index * 0.5),
      ),
      40,
      'sma',
    );
    const metrics = createMetricForTradePlan({
      currentPrice: 103,
      ma20: 100,
      ma60: 104,
      ma5: 102,
      biasToMa20: 3,
      biasToMa5: 0.98,
      maAligned: false,
      trendState: 'weak_bullish',
      rsi14: 49,
      rsiState: 'neutral',
    });
    const newsIntel = createNewsIntel();

    const smaFactors = buildFactorScores(
      metrics,
      bars,
      { ...DEFAULT_STRATEGY, cacheKey: 'bull_trend|ma:sma' },
      newsIntel,
      {},
    );
    const emaFactors = buildFactorScores(
      metrics,
      bars,
      { ...DEFAULT_STRATEGY, cacheKey: 'bull_trend|ma:ema' },
      newsIntel,
      {},
    );

    const smaBias = pickFactorScore(smaFactors, 'bias');
    const emaBias = pickFactorScore(emaFactors, 'bias');
    expect(smaBias.signal).toBe('positive');
    expect(smaBias.score).toBe(18);
    expect(emaBias.signal).toBe('neutral');
    expect(emaBias.score).toBe(12);
    expect(emaBias.summary).toContain('EMA20');
  });

  it('marks moderate extension as negative in EMA mode earlier than SMA mode', () => {
    const bars = buildRecentBars(
      createBarsFromCloses(
        Array.from({ length: 40 }, (_item, index) => 88 + index * 0.6),
      ),
      40,
      'sma',
    );
    const metrics = createMetricForTradePlan({
      currentPrice: 107,
      ma20: 100,
      ma60: 104,
      ma5: 105.5,
      biasToMa20: 7,
      biasToMa5: 1.4,
      maAligned: false,
      trendState: 'weak_bullish',
      rsi14: 52,
      rsiState: 'neutral',
    });
    const newsIntel = createNewsIntel();

    const smaFactors = buildFactorScores(
      metrics,
      bars,
      { ...DEFAULT_STRATEGY, cacheKey: 'bull_trend|ma:sma' },
      newsIntel,
      {},
    );
    const emaFactors = buildFactorScores(
      metrics,
      bars,
      { ...DEFAULT_STRATEGY, cacheKey: 'bull_trend|ma:ema' },
      newsIntel,
      {},
    );

    const smaBias = pickFactorScore(smaFactors, 'bias');
    const emaBias = pickFactorScore(emaFactors, 'bias');
    expect(smaBias.signal).toBe('neutral');
    expect(smaBias.score).toBe(12);
    expect(emaBias.signal).toBe('negative');
    expect(emaBias.score).toBe(5);
  });

  it('builds MA-type split notes for backtest calibration observability', () => {
    const notes = buildBacktestMaCalibrationNotes([
      createBacktestTrade('bull_trend|ma:ema', {
        returnPct: 2.5,
        outcome: 'win',
        directionCorrect: true,
      }),
      createBacktestTrade('shrink_pullback|ma:ema', {
        returnPct: -1.2,
        outcome: 'flat',
        directionCorrect: false,
      }),
      createBacktestTrade('bull_trend|ma:sma', {
        returnPct: -4.1,
        outcome: 'loss',
        directionCorrect: false,
      }),
      createBacktestTrade('legacy-key-without-ma', {
        returnPct: 1.1,
        outcome: 'flat',
      }),
    ]);

    expect(notes[0]).toContain('均线口径拆分');
    expect(notes[0]).toContain('EMA 2 笔');
    expect(notes[0]).toContain('SMA 1 笔');
    expect(notes.some((item) => item.includes('未标注均线口径'))).toBe(true);
  });

  it('adds a threshold calibration recommendation when ema underperforms sma', () => {
    const notes = buildBacktestMaCalibrationNotes([
      createBacktestTrade('bull_trend|ma:ema', {
        returnPct: -2.8,
        outcome: 'loss',
        directionCorrect: false,
      }),
      createBacktestTrade('volume_breakout|ma:ema', {
        returnPct: -1.5,
        outcome: 'flat',
        directionCorrect: false,
      }),
      createBacktestTrade('shrink_pullback|ma:ema', {
        returnPct: 0.3,
        outcome: 'flat',
        directionCorrect: true,
      }),
      createBacktestTrade('bull_trend|ma:sma', {
        returnPct: 3.2,
        outcome: 'win',
        directionCorrect: true,
      }),
      createBacktestTrade('volume_breakout|ma:sma', {
        returnPct: 2.4,
        outcome: 'win',
        directionCorrect: true,
      }),
      createBacktestTrade('shrink_pullback|ma:sma', {
        returnPct: 1.4,
        outcome: 'flat',
        directionCorrect: true,
      }),
    ]);

    expect(notes.some((item) => item.includes('EMA 口径暂弱于 SMA'))).toBe(true);
    expect(notes.some((item) => item.includes('不新增指标'))).toBe(true);
  });
});
