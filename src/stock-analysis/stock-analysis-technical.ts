/**
 * Stock Analysis Technical Engine
 *
 * Extracted from the monolithic stock-analysis-service.ts.
 * Contains all technical indicator computations:
 * - Moving averages (MA5/MA10/MA20/MA60) & alignment detection
 * - Multi-period RSI (6/12/14/24)
 * - MACD with state classification (golden cross / death cross / zero axis)
 * - Volume analysis with state enumeration
 * - Trend state classification (7-level)
 * - Support / resistance identification
 * - Factor scoring engine
 */

import type {
  StockAnalysisChartBar,
  StockAnalysisFactorScore,
  StockAnalysisMaType,
  StockAnalysisMacdState,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsIntel,
  StockAnalysisRsiState,
  StockAnalysisStrategyInfo,
  StockAnalysisTradePlan,
  StockAnalysisTrendState,
  StockAnalysisVolumeState,
} from './stock-analysis-types.js';
import type { StockAnalysisConfigMap } from './stock-analysis-config.js';
import { t } from '../i18n/index.js';

/* ──────────── Utility helpers ──────────── */

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundOrValue(value: number, digits = 2): number {
  return round(value, digits) ?? value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readNumericConfig(
  config: StockAnalysisConfigMap,
  key: keyof StockAnalysisConfigMap,
  fallback: number,
): number {
  const raw = config[key];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/* ──────────── Core math ──────────── */

function computeEmaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    ema.push(values[index] * multiplier + ema[index - 1] * (1 - multiplier));
  }
  return ema;
}

function computeAverageSeries(
  values: number[],
  period: number,
): Array<number | null> {
  const series: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) {
    return series;
  }
  let windowSum = 0;
  for (let i = 0; i < period; i += 1) {
    windowSum += values[i];
  }
  series[period - 1] = windowSum / period;
  for (let i = period; i < values.length; i += 1) {
    windowSum += values[i] - values[i - period];
    series[i] = windowSum / period;
  }
  return series;
}

function computeMovingAverageSeriesByType(
  values: number[],
  period: number,
  maType: StockAnalysisMaType,
): Array<number | null> {
  if (maType === 'ema') {
    const emaSeries = computeEmaSeries(values, period);
    return emaSeries.map((value, index) => (index + 1 >= period ? value : null));
  }
  return computeAverageSeries(values, period);
}

function computeRsi(values: number[], period: number, precomputed?: { gains: number[]; losses: number[] }): number | null {
  if (values.length <= period) return null;
  const gains = precomputed?.gains ?? values.slice(1).map((price, index) => (price > values[index] ? price - values[index] : 0));
  const losses = precomputed?.losses ?? values.slice(1).map((price, index) => (price < values[index] ? values[index] - price : 0));
  let avgGain = average(gains.slice(0, period)) || 0;
  let avgLoss = average(losses.slice(0, period)) || 0;
  for (let index = period; index < gains.length; index += 1) {
    avgGain = (avgGain * (period - 1) + gains[index]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[index]) / period;
  }
  if (avgLoss === 0) return 100;
  const relativeStrength = avgGain / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export function computeMovingAverage(
  prices: number[],
  index: number,
  period: number,
): number | null {
  if (index + 1 < period) return null;
  const window = prices.slice(index + 1 - period, index + 1);
  return average(window);
}

/* ──────────── State classifiers ──────────── */

export function classifyTrendState(
  currentPrice: number,
  ma5: number | null,
  ma10: number | null,
  ma20: number | null,
  ma60: number | null,
  maAligned: boolean,
): StockAnalysisTrendState {
  if (maAligned && ma20 !== null && ma60 !== null && currentPrice > ma5!) {
    return 'strong_bullish';
  }
  if (ma20 !== null && ma60 !== null && currentPrice > ma20 && ma20 > ma60) {
    return 'bullish';
  }
  if (ma20 !== null && currentPrice > ma20) {
    return 'weak_bullish';
  }
  if (ma20 !== null && ma60 !== null && currentPrice < ma20 && ma20 < ma60) {
    if (ma10 !== null && currentPrice < ma10) {
      return 'strong_bearish';
    }
    return 'bearish';
  }
  if (ma20 !== null && currentPrice < ma20) {
    return 'weak_bearish';
  }
  return 'neutral';
}

export function classifyVolumeState(
  volumeRatio: number | null,
  changePct: number | null,
): StockAnalysisVolumeState {
  if (volumeRatio === null) return 'normal';
  if (volumeRatio >= 2.0) return 'heavy_volume';
  if (volumeRatio >= 1.2) return 'increased_volume';
  if (volumeRatio <= 0.5) return 'extremely_low_volume';
  if (volumeRatio <= 0.75) return 'decreased_volume';
  return 'normal';
}

export function classifyMacdState(
  macdDiff: number | null,
  macdSignal: number | null,
  prevMacdDiff: number | null,
  prevMacdSignal: number | null,
): StockAnalysisMacdState {
  if (macdDiff === null || macdSignal === null) return 'neutral';

  const isCrossUp =
    prevMacdDiff !== null &&
    prevMacdSignal !== null &&
    prevMacdDiff <= prevMacdSignal &&
    macdDiff > macdSignal;
  const isCrossDown =
    prevMacdDiff !== null &&
    prevMacdSignal !== null &&
    prevMacdDiff >= prevMacdSignal &&
    macdDiff < macdSignal;

  if (isCrossUp) {
    return macdDiff >= 0 ? 'golden_cross_above_zero' : 'golden_cross_below_zero';
  }
  if (isCrossDown) {
    return macdDiff >= 0 ? 'death_cross_above_zero' : 'death_cross_below_zero';
  }
  if (macdDiff > macdSignal && macdDiff >= 0) return 'bullish_above_zero';
  if (macdDiff < macdSignal && macdDiff < 0) return 'bearish_below_zero';
  return 'neutral';
}

export function classifyRsiState(rsi14: number | null): StockAnalysisRsiState {
  if (rsi14 === null) return 'neutral';
  if (rsi14 >= 80) return 'overbought';
  if (rsi14 >= 55) return 'strong';
  if (rsi14 >= 40) return 'neutral';
  if (rsi14 >= 20) return 'weak';
  return 'oversold';
}

/* ──────────── Main metrics computation ──────────── */

export function computeMetrics(
  prices: number[],
  volumes: Array<number | null>,
  currentPrice: number,
  previousClose: number | null,
  opts: {
    ohlcBars?: Array<{ high: number; low: number; close: number }>;
    maType?: StockAnalysisMaType;
  } = {},
): StockAnalysisMetricSnapshot {
  const maType = opts.maType === 'ema' ? 'ema' : 'sma';
  const last20 = prices.slice(-20);
  const latestPriceIndex = prices.length - 1;
  const maSeries = precomputeMaSeries(prices, [5, 10, 20, 60], maType);
  const returns = prices.slice(1).map((price, index) => {
    const prev = prices[index];
    if (!prev) return 0;
    return (price - prev) / prev;
  });
  const returnsMean = average(returns) || 0;

  // Moving averages
  const ma5 = maSeries.get(5)?.[latestPriceIndex] ?? null;
  const ma10 = maSeries.get(10)?.[latestPriceIndex] ?? null;
  const ma20 = maSeries.get(20)?.[latestPriceIndex] ?? null;
  const ma60 = maSeries.get(60)?.[latestPriceIndex] ?? null;
  const high20 = last20.length ? Math.max(...last20) : null;
  const low20 = last20.length ? Math.min(...last20) : null;

  // MA alignment: MA5 > MA10 > MA20 > MA60
  const maAligned =
    ma5 !== null &&
    ma10 !== null &&
    ma20 !== null &&
    ma60 !== null &&
    ma5 > ma10 &&
    ma10 > ma20 &&
    ma20 > ma60;

  // Bias calculations
  const biasToMa5 =
    ma5 && ma5 > 0 ? ((currentPrice - ma5) / ma5) * 100 : null;
  const biasToMa20 =
    ma20 && ma20 > 0 ? ((currentPrice - ma20) / ma20) * 100 : null;

  // Momentum
  const base20 = prices[Math.max(0, prices.length - 21)] || null;
  const momentum20 =
    base20 && base20 > 0 ? ((currentPrice - base20) / base20) * 100 : null;

  // 60-day return
  const base60 = prices[Math.max(0, prices.length - 61)] || null;
  const return60d =
    base60 && base60 > 0 ? ((currentPrice - base60) / base60) * 100 : null;

  // MACD
  const ema12 = computeEmaSeries(prices, 12);
  const ema26 = computeEmaSeries(prices, 26);
  const macdSeries = prices.map((_value, index) => ema12[index] - ema26[index]);
  const signalSeries = computeEmaSeries(macdSeries, 9);
  const macdDiff = macdSeries[macdSeries.length - 1] ?? null;
  const macdSignal = signalSeries[signalSeries.length - 1] ?? null;
  const macdHistogram =
    macdDiff !== null && macdSignal !== null ? macdDiff - macdSignal : null;

  // Previous MACD values for cross detection
  const prevMacdDiff = macdSeries.length >= 2 ? macdSeries[macdSeries.length - 2] : null;
  const prevMacdSignal = signalSeries.length >= 2 ? signalSeries[signalSeries.length - 2] : null;
  const macdState = classifyMacdState(macdDiff, macdSignal, prevMacdDiff, prevMacdSignal);

  // Multi-period RSI — precompute shared deltas/gains/losses once
  const rsiGains = prices.slice(1).map((price, index) => (price > prices[index] ? price - prices[index] : 0));
  const rsiLosses = prices.slice(1).map((price, index) => (price < prices[index] ? prices[index] - price : 0));
  const rsiPrecomputed = { gains: rsiGains, losses: rsiLosses };
  const rsi6 = computeRsi(prices, 6, rsiPrecomputed);
  const rsi12 = computeRsi(prices, 12, rsiPrecomputed);
  const rsi14 = computeRsi(prices, 14, rsiPrecomputed);
  const rsi24 = computeRsi(prices, 24, rsiPrecomputed);
  const rsiState = classifyRsiState(rsi14);

  // Volume analysis
  const latestVolumes = volumes.slice(-5).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const baseVolumes = volumes.slice(-20).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  const avgVol5 = average(latestVolumes);
  const avgVol20 = average(baseVolumes);
  const volumeRatio5d20d =
    avgVol20 && avgVol20 > 0 && avgVol5 ? avgVol5 / avgVol20 : null;

  const changePct =
    currentPrice && previousClose
      ? ((currentPrice - previousClose) / previousClose) * 100
      : null;

  const volumeState = classifyVolumeState(volumeRatio5d20d, changePct);

  // Trend state
  const trendState = classifyTrendState(
    currentPrice,
    ma5,
    ma10,
    ma20,
    ma60,
    maAligned,
  );

  // Volatility
  const volatility =
    returns.length > 1
      ? Math.sqrt(
          average(returns.map((ret) => (ret - returnsMean) ** 2)) || 0,
        ) *
        Math.sqrt(252) *
        100
      : null;

  // Bollinger Bands (based on MA20 ± 2σ of last 20 closes)
  let bollingerUpper: number | null = null;
  let bollingerLower: number | null = null;
  let bollingerWidth: number | null = null;
  if (ma20 !== null && last20.length >= 20) {
    const stdDev20 = Math.sqrt(
      last20.reduce((sum, p) => sum + (p - ma20) ** 2, 0) / last20.length,
    );
    bollingerUpper = ma20 + 2 * stdDev20;
    bollingerLower = ma20 - 2 * stdDev20;
    bollingerWidth = ma20 > 0 ? ((bollingerUpper - bollingerLower) / ma20) * 100 : null;
  }

  // ATR (Average True Range, 14-period Wilder smoothing)
  let atr14: number | null = null;
  if (opts.ohlcBars && opts.ohlcBars.length >= 15) {
    const trueRanges: number[] = [];
    for (let i = 1; i < opts.ohlcBars.length; i += 1) {
      const high = opts.ohlcBars[i].high;
      const low = opts.ohlcBars[i].low;
      const prevClose = opts.ohlcBars[i - 1].close;
      trueRanges.push(
        Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
      );
    }
    const atrPeriod = 14;
    if (trueRanges.length >= atrPeriod) {
      let atr = average(trueRanges.slice(0, atrPeriod)) || 0;
      for (let i = atrPeriod; i < trueRanges.length; i += 1) {
        atr = (atr * (atrPeriod - 1) + trueRanges[i]) / atrPeriod;
      }
      atr14 = atr;
    }
  }

  return {
    currentPrice: round(currentPrice, 2) || 0,
    previousClose: round(previousClose, 2),
    changePct: round(changePct, 2),
    ma5: round(ma5, 2),
    ma10: round(ma10, 2),
    biasToMa5: round(biasToMa5, 2),
    biasToMa20: round(biasToMa20, 2),
    ma20: round(ma20, 2),
    ma60: round(ma60, 2),
    high20: round(high20, 2),
    low20: round(low20, 2),
    maAligned,
    macdDiff: round(macdDiff, 3),
    macdSignal: round(macdSignal, 3),
    macdHistogram: round(macdHistogram, 3),
    macdState,
    rsi6: round(rsi6, 2),
    rsi12: round(rsi12, 2),
    rsi14: round(rsi14, 2),
    rsi24: round(rsi24, 2),
    rsiState,
    momentum20: round(momentum20, 2),
    annualizedVolatility: round(volatility, 2),
    volumeRatio5d20d: round(volumeRatio5d20d, 2),
    volumeState,
    trendState,
    return60d: round(return60d, 2),
    bollingerUpper: round(bollingerUpper, 2),
    bollingerLower: round(bollingerLower, 2),
    bollingerWidth: round(bollingerWidth, 2),
    atr14: round(atr14, 2),
  };
}

/* ──────────── Sliding-window MA precomputation ──────────── */

const MA_SERIES_CACHE_MAX = 24;
const maSeriesCache = new Map<string, Map<number, Array<number | null>>>();

function buildMaSeriesCacheKey(
  prices: number[],
  periods: number[],
  maType: StockAnalysisMaType,
): string {
  const normalizedPeriods = [...new Set(periods)].sort((left, right) => left - right);
  return `${maType}|${normalizedPeriods.join(',')}|${prices.length}|${prices.join(',')}`;
}

/**
 * Precompute multiple MA series in a single pass using a sliding-window accumulator.
 * Returns a Map from period → array of MA values (null where insufficient data).
 * Complexity: O(n × k) where k = number of periods, vs. the previous O(n × k × period).
 */
function precomputeMaSeries(
  prices: number[],
  periods: number[],
  maType: StockAnalysisMaType,
): Map<number, Array<number | null>> {
  const normalizedPeriods = [...new Set(periods)].sort((left, right) => left - right);
  const cacheKey = buildMaSeriesCacheKey(prices, normalizedPeriods, maType);
  const cached = maSeriesCache.get(cacheKey);
  if (cached) {
    // LRU promote
    maSeriesCache.delete(cacheKey);
    maSeriesCache.set(cacheKey, cached);
    return cached;
  }

  const result = new Map<number, Array<number | null>>();
  for (const period of normalizedPeriods) {
    result.set(period, computeMovingAverageSeriesByType(prices, period, maType));
  }

  if (maSeriesCache.size >= MA_SERIES_CACHE_MAX) {
    const oldestKey = maSeriesCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      maSeriesCache.delete(oldestKey);
    }
  }
  maSeriesCache.set(cacheKey, result);

  return result;
}

/* ──────────── Recent bars builder ──────────── */

export function buildRecentBars(
  bars: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }>,
  maxBars = 60,
  maType: StockAnalysisMaType = 'sma',
): StockAnalysisChartBar[] {
  const normalizedMaxBars = Math.max(20, maxBars);
  const prices = bars.map((bar) => bar.close);

  // Precompute all MA series in a single pass using sliding-window accumulators
  // instead of calling computeMovingAverage() per bar per period (O(n) vs O(n*m))
  const maSeries = precomputeMaSeries(prices, [5, 10, 20, 60], maType);

  return bars.slice(-normalizedMaxBars).map((bar, offset, windowBars) => {
    const sourceIndex = bars.length - windowBars.length + offset;
    return {
      timestamp: bar.timestamp,
      open: roundOrValue(bar.open),
      high: roundOrValue(bar.high),
      low: roundOrValue(bar.low),
      close: roundOrValue(bar.close),
      volume:
        typeof bar.volume === 'number' && Number.isFinite(bar.volume)
          ? Math.round(bar.volume)
          : null,
      ma5: round(maSeries.get(5)?.[sourceIndex] ?? null, 2),
      ma10: round(maSeries.get(10)?.[sourceIndex] ?? null, 2),
      ma20: round(maSeries.get(20)?.[sourceIndex] ?? null, 2),
      ma60: round(maSeries.get(60)?.[sourceIndex] ?? null, 2),
    };
  });
}

/* ──────────── Factor score helpers ──────────── */

export function createFactorScore(
  key: string,
  title: string,
  score: number,
  maxScore: number,
  signal: StockAnalysisFactorScore['signal'],
  summary: string,
): StockAnalysisFactorScore {
  return {
    key,
    title,
    score: Math.max(0, Math.min(maxScore, Math.round(score))),
    maxScore,
    signal,
    summary,
  };
}

function averageVolume(values: Array<number | null | undefined>): number | null {
  const normalized = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return average(normalized);
}

export function buildCatalystFactor(
  newsIntel: StockAnalysisNewsIntel,
): StockAnalysisFactorScore {
  if (newsIntel.status === 'disabled') {
    return createFactorScore(
      'catalyst',
      t('stock.auto_ade330', {}, undefined),
      5,
      10,
      'neutral',
      t('stock.auto_a62f03', {}, undefined),
    );
  }
  if (newsIntel.status !== 'ready') {
    return createFactorScore(
      'catalyst',
      t('stock.auto_ade330', {}, undefined),
      5,
      10,
      'neutral',
      t('stock.auto_7f3f39', {}, undefined),
    );
  }

  const bullishCount = newsIntel.bullishSignals.length;
  const riskCount = newsIntel.riskSignals.length;
  const confidenceBoost =
    newsIntel.confidence === 'high'
      ? 2
      : newsIntel.confidence === 'medium'
        ? 1
        : 0;
  if (bullishCount > riskCount) {
    return createFactorScore(
      'catalyst',
      t('stock.auto_ade330', {}, undefined),
      clamp(6 + bullishCount + confidenceBoost - Math.max(0, riskCount - 1), 0, 10),
      10,
      'positive',
      newsIntel.bullishSignals[0] ||
        newsIntel.summary ||
        t('stock.auto_1b26c4', {}, undefined),
    );
  }
  if (riskCount > bullishCount) {
    return createFactorScore(
      'catalyst',
      t('stock.auto_ade330', {}, undefined),
      clamp(4 - confidenceBoost - Math.max(0, riskCount - bullishCount - 1), 0, 10),
      10,
      'negative',
      newsIntel.riskSignals[0] ||
        newsIntel.summary ||
        t('stock.auto_65185b', {}, undefined),
    );
  }
  return createFactorScore(
    'catalyst',
    t('stock.auto_ade330', {}, undefined),
    clamp(5 + confidenceBoost, 0, 10),
    10,
    bullishCount > 0 ? 'positive' : 'neutral',
    newsIntel.summary || t('stock.auto_b6c371', {}, undefined),
  );
}

export function computeCompositeScore(factorScores: StockAnalysisFactorScore[]): number {
  const totalScore = factorScores.reduce((sum, item) => sum + item.score, 0);
  const totalMax = factorScores.reduce((sum, item) => sum + item.maxScore, 0);
  if (totalMax <= 0) return 0;
  return Math.round((totalScore / totalMax) * 100);
}

interface StrategyFactorAdjustment {
  factorKey: string;
  delta: number;
  signal: StockAnalysisFactorScore['signal'];
  summary: string;
}

interface StrategyBlueprintContext {
  metrics: StockAnalysisMetricSnapshot;
  biasToMa20: number | null;
  volumeRatio: number | null;
  upsideRoom: number | null;
  bars: StockAnalysisChartBar[];
  config: StockAnalysisConfigMap;
  newsIntel: StockAnalysisNewsIntel;
  catalystSignal: StockAnalysisFactorScore['signal'];
  trendSignal: StockAnalysisFactorScore['signal'];
  rsiCrossUp: boolean;
}

interface StrategyBlueprint {
  id: StockAnalysisStrategyInfo['id'];
  condition: (ctx: StrategyBlueprintContext) => boolean;
  adjustments: (ctx: StrategyBlueprintContext) => StrategyFactorAdjustment[];
}

type FactorScoreMaMode = 'sma' | 'ema';

interface BiasFactorThresholdProfile {
  nearBandPct: number;
  overheatPct: number;
  oversoldPct: number;
}

const BIAS_FACTOR_THRESHOLD_BY_MA_MODE: Record<
  FactorScoreMaMode,
  BiasFactorThresholdProfile
> = {
  sma: {
    nearBandPct: 3,
    overheatPct: 8,
    oversoldPct: -6,
  },
  // EMA tracks price faster, so absolute bias distribution is tighter than SMA.
  ema: {
    nearBandPct: 2.2,
    overheatPct: 6.5,
    oversoldPct: -5,
  },
};

function resolveFactorScoreMaMode(strategy: StockAnalysisStrategyInfo): FactorScoreMaMode {
  const matched = strategy.cacheKey.match(/(?:^|\|)ma:(ema|sma)(?:\||$)/);
  return matched?.[1] === 'ema' ? 'ema' : 'sma';
}

function hasRecentMaGoldenCross(ctx: StrategyBlueprintContext): boolean {
  const prevBar = ctx.bars.length >= 2 ? ctx.bars[ctx.bars.length - 2] : null;
  const prevMa5 = prevBar?.ma5 ?? null;
  const prevMa10 = prevBar?.ma10 ?? null;
  const isAbove =
    ctx.metrics.ma5 !== null &&
    ctx.metrics.ma10 !== null &&
    ctx.metrics.ma5 > ctx.metrics.ma10;
  const isRecentCross =
    isAbove &&
    prevMa5 !== null &&
    prevMa10 !== null &&
    prevMa5 <= prevMa10;
  const recentCrossInBars =
    isAbove &&
    !isRecentCross &&
    ctx.bars.length >= 5 &&
    ctx.bars
      .slice(-5, -1)
      .some((bar) => bar.ma5 !== null && bar.ma10 !== null && bar.ma5 <= bar.ma10);
  return isRecentCross || recentCrossInBars;
}

const STRATEGY_BLUEPRINTS: StrategyBlueprint[] = [
  {
    id: 'shrink_pullback',
    condition: (ctx) => {
      const biasLower = readNumericConfig(ctx.config, 'shrinkPullbackBiasLowerPct', -4);
      const biasUpper = readNumericConfig(ctx.config, 'shrinkPullbackBiasUpperPct', 1);
      const volumeMax = readNumericConfig(
        ctx.config,
        'shrinkPullbackVolumeRatioMax',
        0.95,
      );
      return Boolean(
        ctx.biasToMa20 !== null &&
          ctx.biasToMa20 >= biasLower &&
          ctx.biasToMa20 <= biasUpper &&
          ctx.volumeRatio !== null &&
          ctx.volumeRatio <= volumeMax &&
          (ctx.metrics.rsi14 === null || ctx.metrics.rsi14 <= 62),
      );
    },
    adjustments: (ctx) => {
      const biasLower = readNumericConfig(ctx.config, 'shrinkPullbackBiasLowerPct', -4);
      const biasUpper = readNumericConfig(ctx.config, 'shrinkPullbackBiasUpperPct', 1);
      const volumeMax = readNumericConfig(
        ctx.config,
        'shrinkPullbackVolumeRatioMax',
        0.95,
      );
      return [
        {
          factorKey: 'bias',
          delta: 3,
          signal: 'positive',
          summary: `缩量回踩策略命中，当前相对 MA20 偏离 ${round(ctx.biasToMa20, 1)}%，落在配置区间 ${biasLower}% 到 ${biasUpper}% 内。`,
        },
        {
          factorKey: 'volume',
          delta: 2,
          signal: 'positive',
          summary: `近 5 日均量约为 20 日均量的 ${round(ctx.volumeRatio, 2)} 倍，低于缩量阈值 ${round(volumeMax, 2)}。`,
        },
        {
          factorKey: 'rsi',
          delta: 1,
          signal: 'positive',
          summary: `RSI14 为 ${ctx.metrics.rsi14 ?? '-'}，未进入过热区，更适合回踩低吸节奏。`,
        },
      ];
    },
  },
  {
    id: 'volume_breakout',
    condition: (ctx) => {
      const volumeMin = readNumericConfig(ctx.config, 'volumeBreakoutVolumeRatioMin', 1.2);
      const roomMin = readNumericConfig(ctx.config, 'volumeBreakoutBreakoutRoomMin', -2);
      return Boolean(
        ctx.volumeRatio !== null &&
          ctx.volumeRatio >= volumeMin &&
          ctx.upsideRoom !== null &&
          ctx.upsideRoom >= roomMin &&
          ctx.metrics.macdDiff !== null &&
          ctx.metrics.macdSignal !== null &&
          ctx.metrics.macdDiff >= ctx.metrics.macdSignal,
      );
    },
    adjustments: (ctx) => {
      const volumeMin = readNumericConfig(ctx.config, 'volumeBreakoutVolumeRatioMin', 1.2);
      const roomMin = readNumericConfig(ctx.config, 'volumeBreakoutBreakoutRoomMin', -2);
      const items: StrategyFactorAdjustment[] = [
        {
          factorKey: 'volume',
          delta: 4,
          signal: 'positive',
          summary: `放量突破策略命中，近 5 日均量约为 20 日均量的 ${round(ctx.volumeRatio, 2)} 倍，高于阈值 ${round(volumeMin, 2)}。`,
        },
        {
          factorKey: 'setup',
          delta: 2,
          signal: 'positive',
          summary: `当前价格接近 20 日高点，距前高空间 ${round(ctx.upsideRoom, 1)}%，满足阈值 ${roomMin}%。`,
        },
        {
          factorKey: 'macd',
          delta: 2,
          signal: 'positive',
          summary: t('stock.auto_d7c59d', {}, undefined),
        },
      ];
      if (ctx.catalystSignal === 'positive') {
        items.push({
          factorKey: 'catalyst',
          delta: 1,
          signal: 'positive',
          summary: `${ctx.newsIntel.summary || '外部消息'} 与放量突破节奏匹配，催化一致性更强。`,
        });
      }
      return items;
    },
  },
  {
    id: 'bull_trend',
    condition: (ctx) =>
      Boolean(
        ctx.trendSignal === 'positive' &&
          (ctx.metrics.rsi14 === null || ctx.metrics.rsi14 >= 50) &&
          ctx.metrics.macdHistogram !== null &&
          ctx.metrics.macdHistogram >= 0,
      ),
    adjustments: (ctx) => {
      const trendBonus = readNumericConfig(ctx.config, 'bullTrendTrendBonus', 2);
      const macdBonus = readNumericConfig(ctx.config, 'bullTrendMacdBonus', 1);
      const items: StrategyFactorAdjustment[] = [
        {
          factorKey: 'trend',
          delta: trendBonus,
          signal: 'positive',
          summary: `多头趋势策略优先确认均线多头和顺势跟随，当前结构匹配度较高，趋势加分 ${trendBonus}${ctx.metrics.maAligned ? '，均线完美排列额外加持' : ''}。`,
        },
        {
          factorKey: 'macd',
          delta: macdBonus,
          signal: 'positive',
          summary: `MACD 柱体位于零轴上方，更符合顺势跟踪策略，动能加分 ${macdBonus}。`,
        },
      ];
      if (ctx.catalystSignal === 'positive') {
        items.push({
          factorKey: 'catalyst',
          delta: 1,
          signal: 'positive',
          summary: `${ctx.newsIntel.summary || t('stock.auto_ade330', {}, undefined)} 与趋势跟随方向一致。`,
        });
      }
      return items;
    },
  },
  {
    id: 'ma_golden_cross',
    condition: (ctx) =>
      hasRecentMaGoldenCross(ctx) &&
      ctx.metrics.rsi14 !== null &&
      ctx.metrics.rsi14 >= 40 &&
      ctx.metrics.rsi14 <= 65,
    adjustments: (ctx) => {
      const items: StrategyFactorAdjustment[] = [
        {
          factorKey: 'trend',
          delta: 4,
          signal: 'positive',
          summary: t('stock.auto_c9d908', {}, undefined),
        },
      ];
      if (
        ctx.metrics.macdState === 'golden_cross_above_zero' ||
        ctx.metrics.macdState === 'golden_cross_below_zero'
      ) {
        items.push({
          factorKey: 'macd',
          delta: 3,
          signal: 'positive',
          summary: t('stock.auto_422229', {}, undefined),
        });
      }
      if (ctx.rsiCrossUp) {
        items.push({
          factorKey: 'rsi',
          delta: 2,
          signal: 'positive',
          summary: t('stock.auto_4393c8', {}, undefined),
        });
      }
      return items;
    },
  },
  {
    id: 'box_oscillation',
    condition: (ctx) =>
      Boolean(
        ctx.metrics.annualizedVolatility !== null &&
          ctx.metrics.annualizedVolatility <= 40 &&
          ctx.biasToMa20 !== null &&
          ctx.biasToMa20 >= -3 &&
          ctx.biasToMa20 <= 2 &&
          ctx.volumeRatio !== null &&
          ctx.volumeRatio <= 1.1,
      ),
    adjustments: (ctx) => {
      const items: StrategyFactorAdjustment[] = [
        {
          factorKey: 'bias',
          delta: 3,
          signal: 'positive',
          summary: `箱体震荡策略命中，价格接近箱体下沿，MA20 偏离 ${round(ctx.biasToMa20, 1)}%，波动率温和。`,
        },
        {
          factorKey: 'volume',
          delta: 1,
          signal: 'neutral',
          summary: t('stock.auto_7554b2', {}, undefined),
        },
      ];
      if (ctx.metrics.rsi14 !== null && ctx.metrics.rsi14 <= 45) {
        items.push({
          factorKey: 'rsi',
          delta: 2,
          signal: 'positive',
          summary: t('stock.auto_67e82e', {}, undefined),
        });
      }
      return items;
    },
  },
];

/* ──────────── Factor scores builder ──────────── */

export function buildFactorScores(
  metrics: StockAnalysisMetricSnapshot,
  bars: StockAnalysisChartBar[],
  strategy: StockAnalysisStrategyInfo,
  newsIntel: StockAnalysisNewsIntel,
  config: StockAnalysisConfigMap,
): StockAnalysisFactorScore[] {
  const maMode = resolveFactorScoreMaMode(strategy);
  const biasThreshold = BIAS_FACTOR_THRESHOLD_BY_MA_MODE[maMode];
  const maLabel = maMode === 'ema' ? 'EMA20' : 'MA20';
  const latestVolumes = bars.slice(-5).map((bar) => bar.volume);
  const baseVolumes = bars.slice(-20).map((bar) => bar.volume);
  const volumeRatioBase = averageVolume(baseVolumes);
  const volumeRatioRecent = averageVolume(latestVolumes);
  const volumeRatio =
    volumeRatioBase && volumeRatioBase > 0 && volumeRatioRecent
      ? volumeRatioRecent / volumeRatioBase
      : null;
  const biasToMa20 =
    metrics.ma20 && metrics.ma20 > 0
      ? ((metrics.currentPrice - metrics.ma20) / metrics.ma20) * 100
      : null;
  const upsideRoom =
    metrics.high20 && metrics.currentPrice > 0
      ? ((metrics.high20 - metrics.currentPrice) / metrics.currentPrice) * 100
      : null;

  // ── Trend factor: now includes MA5/MA10 alignment ──
  const trend =
    metrics.maAligned && metrics.currentPrice > (metrics.ma5 ?? 0)
      ? createFactorScore(
          'trend',
          t('stock.auto_6d7343', {}, undefined),
          30,
          30,
          'positive',
          t('stock.auto_2bee40', {}, undefined),
        )
      : metrics.ma20 !== null &&
          metrics.ma60 !== null &&
          metrics.currentPrice > metrics.ma20 &&
          metrics.ma20 > metrics.ma60
        ? createFactorScore(
            'trend',
            t('stock.auto_6d7343', {}, undefined),
            24,
            30,
            'positive',
            t('stock.auto_167e7d', {}, undefined),
          )
        : metrics.ma20 !== null &&
            metrics.ma60 !== null &&
            metrics.currentPrice > metrics.ma20
          ? createFactorScore(
              'trend',
              t('stock.auto_6d7343', {}, undefined),
              18,
              30,
              'neutral',
              t('stock.auto_0e50cb', {}, undefined),
            )
          : createFactorScore(
              'trend',
              t('stock.auto_6d7343', {}, undefined),
              8,
              30,
              'negative',
              t('stock.auto_177f0c', {}, undefined),
            );

  // ── Pullback / bias factor with MA5 bias ──
  const effectiveBias = metrics.biasToMa5 ?? biasToMa20;
  const pullback =
    biasToMa20 === null
      ? createFactorScore(
          'bias',
          t('stock.auto_6a4464', {}, undefined),
          10,
          20,
          'neutral',
          t('stock.auto_ce6ab6', {}, undefined),
        )
      : Math.abs(biasToMa20) <= biasThreshold.nearBandPct
        ? createFactorScore(
            'bias',
            t('stock.auto_6a4464', {}, undefined),
            18,
            20,
            'positive',
            `当前价贴近 ${maLabel}，偏离 ${round(biasToMa20, 1)}%${effectiveBias !== null ? `，MA5 偏离 ${round(effectiveBias, 1)}%` : ''}，更适合等待低吸确认。`,
          )
        : biasToMa20 > biasThreshold.overheatPct
          ? createFactorScore(
              'bias',
              t('stock.auto_6a4464', {}, undefined),
              5,
              20,
              'negative',
              `当前价高于 ${maLabel} ${round(biasToMa20, 1)}%，超过追高阈值 ${biasThreshold.overheatPct}%，短线性价比偏低。`,
            )
          : biasToMa20 < biasThreshold.oversoldPct
            ? createFactorScore(
                'bias',
                t('stock.auto_6a4464', {}, undefined),
                7,
                20,
                'negative',
                `当前价低于 ${maLabel} ${Math.abs(round(biasToMa20, 1) || 0)}%，低于回撤阈值 ${Math.abs(biasThreshold.oversoldPct)}%，需先观察支撑是否修复。`,
              )
            : createFactorScore(
                'bias',
                t('stock.auto_6a4464', {}, undefined),
                12,
                20,
                'neutral',
                `当前价与 ${maLabel} 偏离 ${round(biasToMa20, 1)}%，仍需等更合适的进场节奏。`,
              );

  // ── Volume factor with state enumeration ──
  const volumeStateLabel =
    metrics.volumeState === 'heavy_volume'
      ? t('stock.auto_b7d321', {}, undefined)
      : metrics.volumeState === 'increased_volume'
        ? t('stock.auto_d55f2c', {}, undefined)
        : metrics.volumeState === 'decreased_volume'
          ? t('stock.auto_e4fcc0', {}, undefined)
          : metrics.volumeState === 'extremely_low_volume'
            ? t('stock.auto_3e9c64', {}, undefined)
            : t('stock.auto_fd6e80', {}, undefined);
  const volume =
    volumeRatio === null
      ? createFactorScore(
          'volume',
          t('stock.auto_f2c4eb', {}, undefined),
          8,
          15,
          'neutral',
          t('stock.auto_2b4801', {}, undefined),
        )
      : volumeRatio >= 1.15 && (metrics.changePct || 0) >= 0
        ? createFactorScore(
            'volume',
            t('stock.auto_f2c4eb', {}, undefined),
            13,
            15,
            'positive',
            `${volumeStateLabel}，近 5 日均量约为 20 日均量的 ${round(volumeRatio, 2)} 倍，量价配合较好。`,
          )
        : volumeRatio <= 0.75 && (metrics.changePct || 0) < 0
          ? createFactorScore(
              'volume',
              t('stock.auto_f2c4eb', {}, undefined),
              5,
              15,
              'negative',
              `${volumeStateLabel}，近 5 日均量仅为 20 日均量的 ${round(volumeRatio, 2)} 倍，下跌修复力度不足。`,
            )
          : createFactorScore(
              'volume',
              t('stock.auto_f2c4eb', {}, undefined),
              9,
              15,
              'neutral',
              `${volumeStateLabel}，近 5 日均量约为 20 日均量的 ${round(volumeRatio, 2)} 倍，量能暂未明显放大。`,
            );

  // ── MACD factor with state classification ──
  const macdStateLabel = {
    golden_cross_above_zero: t('stock.auto_c7cda1', {}, undefined),
    golden_cross_below_zero: t('stock.auto_366dba', {}, undefined),
    bullish_above_zero: t('stock.auto_0228a4', {}, undefined),
    neutral: t('stock.auto_cee784', {}, undefined),
    bearish_below_zero: t('stock.auto_74c2fc', {}, undefined),
    death_cross_above_zero: t('stock.auto_2594f3', {}, undefined),
    death_cross_below_zero: t('stock.auto_189470', {}, undefined),
  }[metrics.macdState];

  const macd =
    metrics.macdDiff === null ||
    metrics.macdSignal === null ||
    metrics.macdHistogram === null
      ? createFactorScore(
          'macd',
          'MACD',
          7,
          15,
          'neutral',
          t('stock.auto_8536b8', {}, undefined),
        )
      : metrics.macdState === 'golden_cross_above_zero'
        ? createFactorScore(
            'macd',
            'MACD',
            15,
            15,
            'positive',
            `${macdStateLabel}，DIF ${metrics.macdDiff} 上穿 DEA ${metrics.macdSignal}，趋势强势确认。`,
          )
        : metrics.macdState === 'golden_cross_below_zero'
          ? createFactorScore(
              'macd',
              'MACD',
              12,
              15,
              'positive',
              `${macdStateLabel}，DIF ${metrics.macdDiff} 上穿 DEA ${metrics.macdSignal}，有望反转。`,
            )
          : metrics.macdState === 'bullish_above_zero'
            ? createFactorScore(
                'macd',
                'MACD',
                13,
                15,
                'positive',
                `${macdStateLabel}，趋势延续运行。`,
              )
            : metrics.macdState === 'death_cross_above_zero' ||
                metrics.macdState === 'death_cross_below_zero'
              ? createFactorScore(
                  'macd',
                  'MACD',
                  3,
                  15,
                  'negative',
                  `${macdStateLabel}，趋势走弱信号明显。`,
                )
              : metrics.macdState === 'bearish_below_zero'
                ? createFactorScore(
                    'macd',
                    'MACD',
                    4,
                    15,
                    'negative',
                    `${macdStateLabel}，空头力量延续。`,
                  )
                : createFactorScore(
                    'macd',
                    'MACD',
                    8,
                    15,
                    'neutral',
                    `${macdStateLabel}，DIF ${metrics.macdDiff} 与 DEA ${metrics.macdSignal} 接近，等待方向确认。`,
                  );

  // ── RSI factor with multi-period ──
  const rsiDesc: string[] = [];
  if (metrics.rsi6 !== null) rsiDesc.push(`RSI6=${metrics.rsi6}`);
  if (metrics.rsi12 !== null) rsiDesc.push(`RSI12=${metrics.rsi12}`);
  if (metrics.rsi14 !== null) rsiDesc.push(`RSI14=${metrics.rsi14}`);
  if (metrics.rsi24 !== null) rsiDesc.push(`RSI24=${metrics.rsi24}`);
  const rsiMultiInfo = rsiDesc.length > 0 ? `(${rsiDesc.join(', ')})` : '';

  // RSI golden/death cross: RSI6 above/below RSI12
  // Note: True cross detection would need previous-bar RSI values.
  // Here we use relative position as a proxy signal.
  const rsiCrossUp =
    metrics.rsi6 !== null && metrics.rsi12 !== null && metrics.rsi6 > metrics.rsi12;
  const rsiCrossDown =
    metrics.rsi6 !== null && metrics.rsi12 !== null && metrics.rsi6 < metrics.rsi12;

  const rsi =
    metrics.rsi14 === null
      ? createFactorScore(
          'rsi',
          'RSI',
          5,
          10,
          'neutral',
          t('stock.auto_ab2c2d', {}, undefined),
        )
      : metrics.rsiState === 'strong'
        ? createFactorScore(
            'rsi',
            'RSI',
            rsiCrossUp ? 9 : 8,
            10,
            'positive',
            `RSI 处于偏强区域 ${rsiMultiInfo}，多头力量较稳定${rsiCrossUp ? '，短周期 RSI6 领先 RSI12' : ''}。`,
          )
        : metrics.rsiState === 'overbought'
          ? createFactorScore(
              'rsi',
              'RSI',
              2,
              10,
              'negative',
              `RSI 已进入超买区 ${rsiMultiInfo}，追高风险上升。`,
            )
          : metrics.rsiState === 'oversold'
            ? createFactorScore(
                'rsi',
                'RSI',
                4,
                10,
                rsiCrossUp ? 'positive' : 'negative',
                `RSI 处于超卖区 ${rsiMultiInfo}${rsiCrossUp ? '，短周期 RSI6 领先 RSI12，或有反弹机会' : '，需等待反转信号'}。`,
              )
            : metrics.rsiState === 'weak'
              ? createFactorScore(
                  'rsi',
                  'RSI',
                  4,
                  10,
                  'negative',
                  `RSI 处于弱势区 ${rsiMultiInfo}，需等待反转信号。`,
                )
              : createFactorScore(
                  'rsi',
                  'RSI',
                  6,
                  10,
                  'neutral',
                  `RSI 震荡偏中性 ${rsiMultiInfo}，需结合其他信号判断。`,
                );

  // ── Setup factor with Bollinger Band enhancement ──
  // Determine Bollinger position for scoring adjustment
  const bollingerNote =
    metrics.bollingerLower !== null && metrics.bollingerUpper !== null
      ? metrics.currentPrice <= metrics.bollingerLower
        ? t('stock.auto_03d7ba', {}, undefined)
        : metrics.currentPrice >= metrics.bollingerUpper
          ? t('stock.auto_45ef90', {}, undefined)
          : null
      : null;
  const bollingerAdjust =
    metrics.bollingerLower !== null && metrics.bollingerUpper !== null
      ? metrics.currentPrice <= metrics.bollingerLower
        ? 2  // near lower band: bonus
        : metrics.currentPrice >= metrics.bollingerUpper
          ? -2  // near upper band: penalty
          : 0
      : 0;

  const setup =
    upsideRoom !== null && metrics.low20 !== null
      ? upsideRoom >= 6
        ? createFactorScore(
            'setup',
            t('stock.auto_a13003', {}, undefined),
            clamp(8 + bollingerAdjust, 0, 10),
            10,
            bollingerAdjust < 0 ? 'neutral' : 'positive',
            `距 20 日高点仍有 ${round(upsideRoom, 1)}% 空间，下方参考支撑在 ${metrics.low20}${bollingerNote || ''}。`,
          )
        : createFactorScore(
            'setup',
            t('stock.auto_a13003', {}, undefined),
            clamp(5 + bollingerAdjust, 0, 10),
            10,
            bollingerAdjust > 0 ? 'positive' : 'neutral',
            `距 20 日高点空间仅 ${round(upsideRoom, 1)}%，更适合等回踩或突破确认${bollingerNote || ''}。`,
          )
      : createFactorScore(
          'setup',
          t('stock.auto_a13003', {}, undefined),
          clamp(5 + bollingerAdjust, 0, 10),
          10,
          bollingerAdjust > 0 ? 'positive' : 'neutral',
          `高低点数据不足，暂按中性空间处理${bollingerNote || ''}。`,
        );

  const catalyst = buildCatalystFactor(newsIntel);
  const factors = [trend, pullback, volume, macd, rsi, setup, catalyst];
  const getFactor = (key: string) => factors.find((item) => item.key === key);
  const adjustFactor = (
    key: string,
    delta: number,
    signal: StockAnalysisFactorScore['signal'],
    summary: string,
  ) => {
    const factor = getFactor(key);
    if (!factor) return;
    factor.score = Math.max(0, Math.min(factor.maxScore, factor.score + delta));
    factor.signal = signal;
    factor.summary = summary;
  };

  // ── Strategy-specific adjustments ──
  const blueprint = STRATEGY_BLUEPRINTS.find((item) => item.id === strategy.id);
  if (
    blueprint &&
    blueprint.condition({
      metrics,
      biasToMa20,
      volumeRatio,
      upsideRoom,
      bars,
      config,
      newsIntel,
      catalystSignal: catalyst.signal,
      trendSignal: trend.signal,
      rsiCrossUp,
    })
  ) {
    for (const adjustment of blueprint.adjustments({
      metrics,
      biasToMa20,
      volumeRatio,
      upsideRoom,
      bars,
      config,
      newsIntel,
      catalystSignal: catalyst.signal,
      trendSignal: trend.signal,
      rsiCrossUp,
    })) {
      adjustFactor(
        adjustment.factorKey,
        adjustment.delta,
        adjustment.signal,
        adjustment.summary,
      );
    }
  }

  return factors;
}

/* ──────────── Support / Resistance identification ──────────── */

export function identifySupportResistanceLevels(
  prices: number[],
  currentPrice: number,
  ma5: number | null,
  ma10: number | null,
  ma20: number | null,
  ma60: number | null,
  high20: number | null,
  low20: number | null,
  volumes?: Array<number | null>,
): { supportLevels: number[]; resistanceLevels: number[] } {
  interface WeightedLevelPoint {
    price: number;
    weight: number;
  }

  function toLevelWeight(volume: number | null | undefined): number {
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) {
      return 1;
    }
    // Compress large turnover differences while preserving relative significance.
    return Math.max(1, Math.log10(volume + 1));
  }

  function pushWeightedLevel(
    bucket: WeightedLevelPoint[],
    price: number,
    weight = 1,
  ): void {
    if (Number.isFinite(price) && price > 0) {
      bucket.push({ price, weight: Math.max(1, weight) });
    }
  }

  function clusterLevels(points: WeightedLevelPoint[]): WeightedLevelPoint[] {
    if (points.length === 0) return [];
    const sorted = [...points].sort((left, right) => left.price - right.price);
    const clusters: WeightedLevelPoint[] = [];
    let weightedPriceSum = sorted[0]!.price * sorted[0]!.weight;
    let totalWeight = sorted[0]!.weight;

    for (let index = 1; index < sorted.length; index += 1) {
      const point = sorted[index]!;
      const centroid = weightedPriceSum / totalWeight;
      const distance = Math.abs(point.price - centroid) / Math.max(Math.abs(centroid), 1e-9);
      if (distance <= 0.01) {
        weightedPriceSum += point.price * point.weight;
        totalWeight += point.weight;
      } else {
        clusters.push({
          price: weightedPriceSum / totalWeight,
          weight: totalWeight,
        });
        weightedPriceSum = point.price * point.weight;
        totalWeight = point.weight;
      }
    }

    clusters.push({
      price: weightedPriceSum / totalWeight,
      weight: totalWeight,
    });
    return clusters;
  }

  function finalizeLevels(
    points: WeightedLevelPoint[],
    sortComparator: (left: number, right: number) => number,
  ): number[] {
    const clustered = clusterLevels(points);
    const scoreByRoundedPrice = new Map<number, number>();
    for (const point of clustered) {
      const roundedPrice = round(point.price, 2);
      if (roundedPrice === null) continue;
      scoreByRoundedPrice.set(
        roundedPrice,
        (scoreByRoundedPrice.get(roundedPrice) || 0) + point.weight,
      );
    }

    const topByWeight = [...scoreByRoundedPrice.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([price]) => price);

    return topByWeight.sort(sortComparator).slice(0, 5);
  }

  const supports: WeightedLevelPoint[] = [];
  const resistances: WeightedLevelPoint[] = [];

  // MA-based levels
  if (ma5 !== null && ma5 < currentPrice) pushWeightedLevel(supports, ma5);
  if (ma10 !== null && ma10 < currentPrice) pushWeightedLevel(supports, ma10);
  if (ma20 !== null && ma20 < currentPrice) pushWeightedLevel(supports, ma20);
  if (ma60 !== null && ma60 < currentPrice) pushWeightedLevel(supports, ma60);
  if (low20 !== null && low20 < currentPrice) pushWeightedLevel(supports, low20);

  if (ma5 !== null && ma5 > currentPrice) pushWeightedLevel(resistances, ma5);
  if (ma10 !== null && ma10 > currentPrice) pushWeightedLevel(resistances, ma10);
  if (ma20 !== null && ma20 > currentPrice) pushWeightedLevel(resistances, ma20);
  if (ma60 !== null && ma60 > currentPrice) pushWeightedLevel(resistances, ma60);
  if (high20 !== null && high20 > currentPrice) pushWeightedLevel(resistances, high20);

  // Enhanced swing detection with configurable lookback (3 bars)
  // and optional volume weighting for significance
  const lookback = 3;
  if (prices.length >= lookback * 2 + 1) {
    for (let i = lookback; i < prices.length - lookback; i++) {
      const p = prices[i];
      let isLocalMin = true;
      let isLocalMax = true;
      for (let j = 1; j <= lookback; j++) {
        if (p >= prices[i - j] || p >= prices[i + j]) isLocalMin = false;
        if (p <= prices[i - j] || p <= prices[i + j]) isLocalMax = false;
      }
      const volumeWeight = toLevelWeight(volumes?.[i]);
      if (isLocalMin && p < currentPrice) {
        pushWeightedLevel(supports, p, volumeWeight);
      }
      if (isLocalMax && p > currentPrice) {
        pushWeightedLevel(resistances, p, volumeWeight);
      }
    }
  }

  return {
    supportLevels: finalizeLevels(supports, (left, right) => right - left),
    resistanceLevels: finalizeLevels(resistances, (left, right) => left - right),
  };
}

/* ──────────── Trade plan builder ──────────── */

export function buildTradePlan(
  metrics: StockAnalysisMetricSnapshot,
  supportLevels: number[],
  resistanceLevels: number[],
  trend: string,
  strategy: StockAnalysisStrategyInfo,
): StockAnalysisTradePlan {
  const sortedSupport = [...supportLevels].sort((left, right) => right - left);
  const sortedResistance = [...resistanceLevels].sort((left, right) => left - right);
  const idealBuy =
    sortedSupport.find((value) => value < metrics.currentPrice) ??
    metrics.ma20 ??
    null;
  const secondaryBuy =
    sortedSupport.find((value) => value < (idealBuy || metrics.currentPrice) - 0.01) ??
    metrics.low20 ??
    null;
  const stopLossBase = secondaryBuy ?? idealBuy ?? metrics.low20 ?? null;
  // Use ATR-based dynamic stop-loss when available (2×ATR below support),
  // falling back to fixed 3% below support
  const stopLoss =
    metrics.atr14 !== null && stopLossBase && stopLossBase > 0
      ? stopLossBase - 2 * metrics.atr14
      : stopLossBase && stopLossBase > 0
        ? stopLossBase * 0.97
        : null;
  const takeProfitBase =
    sortedResistance.find((value) => value > metrics.currentPrice) ??
    metrics.high20 ??
    null;
  const isBullishTrend =
    trend === 'bullish' || trend === 'strong_bullish' || trend === 'weak_bullish';
  const takeProfit =
    takeProfitBase && takeProfitBase > metrics.currentPrice
      ? takeProfitBase
      : metrics.currentPrice * (isBullishTrend ? 1.1 : 1.05);

  return {
    idealBuy: round(idealBuy, 2),
    secondaryBuy: round(secondaryBuy, 2),
    stopLoss: round(stopLoss, 2),
    takeProfit: round(takeProfit, 2),
    style:
      strategy.id === 'shrink_pullback'
        ? t('stock.auto_0ffc39', {}, undefined)
        : strategy.id === 'volume_breakout'
          ? t('stock.auto_290db2', {}, undefined)
          : strategy.id === 'ma_golden_cross'
            ? t('stock.auto_48b1c4', {}, undefined)
            : strategy.id === 'box_oscillation'
              ? t('stock.auto_d0989f', {}, undefined)
              : trend === 'strong_bullish' || trend === 'bullish'
                ? t('stock.auto_e06f4d', {}, undefined)
                : trend === 'weak_bullish'
                  ? t('stock.auto_433bba', {}, undefined)
                  : trend === 'neutral'
                    ? t('stock.auto_fd21ea', {}, undefined)
                    : trend === 'weak_bearish'
                      ? t('stock.auto_e6fe8d', {}, undefined)
                      : t('stock.auto_f21d7b', {}, undefined),
  };
}
