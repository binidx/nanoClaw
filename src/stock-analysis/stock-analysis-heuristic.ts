/**
 * Stock analysis heuristic assessment: MA type resolution, bias safety thresholds,
 * and composite heuristic scoring used by the analysis pipeline.
 */

import type { StockAnalysisConfigMap } from './stock-analysis-config.js';
import { formatPct } from './stock-analysis-normalize.js';
import {
  computeCompositeScore,
  identifySupportResistanceLevels,
  readNumericConfig,
  round,
} from './stock-analysis-technical.js';
import type {
  StockAnalysisFactorScore,
  StockAnalysisMaType,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsIntel,
  StockAnalysisStrategyInfo,
  StockAnalysisSummary,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

export function resolveMaType(config: StockAnalysisConfigMap): StockAnalysisMaType {
  return config.maType === 'ema' ? 'ema' : 'sma';
}

const EMA_BIAS_SAFETY_SCALE = 6.5 / 8;

export function resolveBiasSafetyThreshold(
  config?: StockAnalysisConfigMap,
): number {
  const baseThreshold = config
    ? readNumericConfig(config, 'biasSafetyThresholdPct', 5)
    : 5;
  if (baseThreshold <= 0 || !config) {
    return baseThreshold;
  }
  if (resolveMaType(config) !== 'ema') {
    return baseThreshold;
  }
  // Keep the same relative cushion as the EMA overheat threshold (6.5%) vs SMA (8%).
  return round(baseThreshold * EMA_BIAS_SAFETY_SCALE, 1) ?? baseThreshold;
}

export function buildHeuristicAssessment(
  stockCode: string,
  stockName: string,
  metrics: StockAnalysisMetricSnapshot,
  factorScores: StockAnalysisFactorScore[],
  strategy: StockAnalysisStrategyInfo,
  newsIntel: StockAnalysisNewsIntel,
  closes: number[],
  volumes: Array<number | null>,
  config?: StockAnalysisConfigMap,
): {
  score: number;
  trend: string;
  recommendation: string;
  summary: StockAnalysisSummary;
  heuristicNotes: string[];
  supportLevels: number[];
  resistanceLevels: number[];
} {
  let score = computeCompositeScore(factorScores);
  const notes: string[] = [];
  const riskSignals: string[] = [];
  const catalystSignals: string[] = [];

  // MA alignment detection
  if (metrics.maAligned) {
    catalystSignals.push(t('stock.auto_4ac215', {}, undefined));
  } else if (metrics.ma20 !== null && metrics.currentPrice > metrics.ma20) {
    catalystSignals.push(t('stock.auto_b0859a', {}, undefined));
  } else if (metrics.ma20 !== null) {
    riskSignals.push(t('stock.auto_21f604', {}, undefined));
  }

  if (
    metrics.ma20 !== null &&
    metrics.ma60 !== null &&
    metrics.ma20 > metrics.ma60
  ) {
    notes.push(t('stock.auto_183b2d', {}, undefined));
  } else if (metrics.ma20 !== null && metrics.ma60 !== null) {
    notes.push(t('stock.auto_51b170', {}, undefined));
  }

  // Trend state
  notes.push(`趋势状态: ${metrics.trendState}`);

  // MACD state
  if (
    metrics.macdState === 'golden_cross_above_zero' ||
    metrics.macdState === 'golden_cross_below_zero'
  ) {
    catalystSignals.push(`MACD 金叉信号 (${metrics.macdState})。`);
  } else if (
    metrics.macdState === 'death_cross_above_zero' ||
    metrics.macdState === 'death_cross_below_zero'
  ) {
    riskSignals.push(`MACD 死叉信号 (${metrics.macdState})。`);
  }

  // Volume state
  if (metrics.volumeState === 'heavy_volume' || metrics.volumeState === 'increased_volume') {
    notes.push(`量能状态: ${metrics.volumeState}，量比 ${metrics.volumeRatio5d20d ?? '-'}`);
  } else if (
    metrics.volumeState === 'decreased_volume' ||
    metrics.volumeState === 'extremely_low_volume'
  ) {
    notes.push(`量能状态: ${metrics.volumeState}，量比 ${metrics.volumeRatio5d20d ?? '-'}`);
  }

  if (metrics.momentum20 !== null && metrics.momentum20 >= 12) {
    catalystSignals.push(t('stock.auto_c5c418', {}, undefined));
  } else if (metrics.momentum20 !== null && metrics.momentum20 <= -10) {
    riskSignals.push(t('stock.auto_e23b54', {}, undefined));
  }

  if (metrics.changePct !== null && metrics.changePct >= 3) {
    notes.push(t('stock.auto_0da6e3', {}, undefined));
  } else if (metrics.changePct !== null && metrics.changePct <= -3) {
    notes.push(t('stock.auto_e01e79', {}, undefined));
  }

  if (
    metrics.annualizedVolatility !== null &&
    metrics.annualizedVolatility >= 45
  ) {
    riskSignals.push(t('stock.auto_28426b', {}, undefined));
  } else if (
    metrics.annualizedVolatility !== null &&
    metrics.annualizedVolatility <= 25
  ) {
    notes.push(t('stock.auto_c17621', {}, undefined));
  }

  if (newsIntel.status === 'ready') {
    const relatedSectors = newsIntel.relatedSectors || [];
    const sectorSignals = newsIntel.sectorSignals || [];
    const peerSignals = newsIntel.peerSignals || [];
    const policySignals = newsIntel.policySignals || [];
    notes.push(`消息催化摘要: ${newsIntel.summary}`);
    catalystSignals.push(...newsIntel.bullishSignals.slice(0, 2));
    riskSignals.push(...newsIntel.riskSignals.slice(0, 2));
    if (newsIntel.hotTopics.length > 0) {
      notes.push(`关联热点: ${newsIntel.hotTopics.join(' / ')}`);
    }
    if (relatedSectors.length > 0) {
      notes.push(`关联板块/题材: ${relatedSectors.join(' / ')}`);
    }
    catalystSignals.push(...sectorSignals.slice(0, 1));
    catalystSignals.push(...policySignals.slice(0, 1));
    notes.push(...peerSignals.slice(0, 1).map((item) => `同行联动: ${item}`));
  } else if (newsIntel.status === 'disabled') {
    notes.push(t('stock.auto_03a1f3', {}, undefined));
  } else {
    notes.push(t('stock.auto_da5624', {}, undefined));
  }

  score = Math.max(0, Math.min(100, score));

  const trend =
    metrics.trendState === 'strong_bullish' || metrics.trendState === 'bullish'
      ? 'bullish'
      : metrics.trendState === 'strong_bearish' || metrics.trendState === 'bearish'
        ? 'bearish'
        : 'neutral';

  let recommendation =
    score >= 72 ? t('stock.auto_f2f24d', {}, undefined) : score >= 52 ? t('stock.auto_9f406a', {}, undefined) : t('stock.auto_1d90bd', {}, undefined);

  // Bias safety: auto-downgrade recommendation when price deviates too far from MA5
  const biasSafetyThreshold = resolveBiasSafetyThreshold(config);
  const biasSafetyLabel =
    config && resolveMaType(config) === 'ema' ? 'EMA5' : 'MA5';
  if (
    biasSafetyThreshold > 0 &&
    metrics.biasToMa5 !== null &&
    metrics.biasToMa5 > biasSafetyThreshold &&
    recommendation === t('stock.auto_f2f24d', {}, undefined)
  ) {
    recommendation = t('stock.auto_9f406a', {}, undefined);
    riskSignals.push(
      `${biasSafetyLabel} 偏离 ${round(metrics.biasToMa5, 1)}% 超过安全阈值 ${biasSafetyThreshold}%，自动降级为观察。`,
    );
  }
  const headline = `${stockName}(${stockCode}) ${strategy.label} · ${recommendation}`;
  const analysisSummary = [
    `当前价格 ${metrics.currentPrice.toFixed(2)}`,
    `策略 ${strategy.label}`,
    metrics.changePct !== null
      ? `日涨跌 ${formatPct(metrics.changePct)}`
      : null,
    metrics.ma5 !== null ? `MA5 ${metrics.ma5.toFixed(2)}` : null,
    metrics.ma10 !== null ? `MA10 ${metrics.ma10.toFixed(2)}` : null,
    metrics.ma20 !== null ? `MA20 ${metrics.ma20.toFixed(2)}` : null,
    metrics.ma60 !== null ? `MA60 ${metrics.ma60.toFixed(2)}` : null,
    metrics.maAligned ? t('stock.auto_7581ee', {}, undefined) : null,
  ]
    .filter(Boolean)
    .join('，');

  const operationAdvice =
    recommendation === t('stock.auto_f2f24d', {}, undefined)
      ? `优先按「${strategy.label}」策略等待确认后跟踪，不建议盲目追高。`
      : recommendation === t('stock.auto_9f406a', {}, undefined)
        ? `当前更适合把它放在「${strategy.label}」观察列表，等待触发条件。`
        : t('stock.auto_4b102f', {}, undefined);

  // Improved support/resistance
  const { supportLevels, resistanceLevels } = identifySupportResistanceLevels(
    closes,
    metrics.currentPrice,
    metrics.ma5,
    metrics.ma10,
    metrics.ma20,
    metrics.ma60,
    metrics.high20,
    metrics.low20,
    volumes,
  );

  return {
    score,
    trend,
    recommendation,
    summary: {
      headline,
      analysisSummary,
      operationAdvice,
      riskSignals:
        riskSignals.length > 0
          ? riskSignals
          : [t('stock.auto_a1a062', {}, undefined)],
      catalystSignals:
        catalystSignals.length > 0
          ? catalystSignals
          : [t('stock.auto_2e171a', {}, undefined)],
    },
    heuristicNotes: [
      `当前采用策略：${strategy.label}。`,
      ...notes,
      ...factorScores.map((item) => `${item.title}: ${item.summary}`),
    ],
    supportLevels,
    resistanceLevels,
  };
}
