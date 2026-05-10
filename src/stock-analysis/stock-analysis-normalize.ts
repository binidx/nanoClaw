/**
 * Stock Analysis Normalize Functions
 *
 * Extracted from the monolithic stock-analysis-service.ts.
 * Contains all data normalization / sanitization helpers.
 */

import type {
  PipelineStageLog,
  StockAnalysisChartBar,
  StockAnalysisDataSource,
  StockAnalysisDetail,
  StockAnalysisFactorScore,
  StockAnalysisMarketReview,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsEvidence,
  StockAnalysisNewsEvidenceStats,
  StockAnalysisNewsIntel,
  StockAnalysisNewsReference,
  StockAnalysisReportValidation,
  StockAnalysisMaType,
  StockAnalysisStrategyInfo,
  StockAnalysisStrategyPreset,
  StockAnalysisSummary,
  StockAnalysisTradePlan,
} from './stock-analysis-types.js';
import { round, roundOrValue } from './stock-analysis-technical.js';
import { t } from '../i18n/index.js';

/* ──────────── Text helpers ──────────── */

export function toCleanText(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

export function toCleanStringList(
  value: unknown,
  maxItems: number,
  fallback: string[] = [],
): string[] {
  const items = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
  return items.length > 0 ? items : fallback;
}

export function formatPct(value: number | null): string {
  if (value === null) return t('stock.auto_1622dc', {}, undefined);
  return `${value >= 0 ? '+' : ''}${round(value, 2)}%`;
}

export function addDays(isoDate: string, days: number): string | null {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function toIsoTradeDate(value: string | null | undefined): string | null {
  if (!value || value.length < 10) return null;
  const dateStr = value.slice(0, 10);
  // Basic YYYY-MM-DD format check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return dateStr;
}

/* ──────────── Strategy definitions ──────────── */

export const STOCK_ANALYSIS_STRATEGIES: Record<
  StockAnalysisStrategyPreset,
  StockAnalysisStrategyInfo
> = {
  bull_trend: {
    id: 'bull_trend',
    label: t('stock.auto_dfedff', {}, undefined),
    description: t('stock.auto_3031df', {}, undefined),
    cacheKey: 'bull_trend',
    tuningNotes: [],
  },
  shrink_pullback: {
    id: 'shrink_pullback',
    label: t('stock.auto_f8b8d6', {}, undefined),
    description: t('stock.auto_07755a', {}, undefined),
    cacheKey: 'shrink_pullback',
    tuningNotes: [],
  },
  volume_breakout: {
    id: 'volume_breakout',
    label: t('stock.auto_de2dbe', {}, undefined),
    description: t('stock.auto_bdce06', {}, undefined),
    cacheKey: 'volume_breakout',
    tuningNotes: [],
  },
  ma_golden_cross: {
    id: 'ma_golden_cross',
    label: t('stock.auto_735fd1', {}, undefined),
    description: t('stock.auto_cafc61', {}, undefined),
    cacheKey: 'ma_golden_cross',
    tuningNotes: [],
  },
  box_oscillation: {
    id: 'box_oscillation',
    label: t('stock.auto_78e56e', {}, undefined),
    description: t('stock.auto_bb9cd5', {}, undefined),
    cacheKey: 'box_oscillation',
    tuningNotes: [],
  },
};

/* ──────────── Normalizers ──────────── */

export function normalizeStrategyPreset(
  value: unknown,
): StockAnalysisStrategyPreset {
  if (
    value === 'bull_trend' ||
    value === 'shrink_pullback' ||
    value === 'volume_breakout' ||
    value === 'ma_golden_cross' ||
    value === 'box_oscillation'
  ) {
    return value;
  }
  return 'bull_trend';
}

export function normalizeStrategyInfo(
  value: Partial<StockAnalysisStrategyInfo> | null | undefined,
): StockAnalysisStrategyInfo {
  const preset = normalizeStrategyPreset(value?.id);
  const base = STOCK_ANALYSIS_STRATEGIES[preset];
  const tuningNotes = Array.isArray(value?.tuningNotes)
    ? value.tuningNotes.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
    : base.tuningNotes;
  const rawCacheKey =
    typeof value?.cacheKey === 'string' && value.cacheKey.trim()
      ? value.cacheKey
      : base.cacheKey;
  const matchedMaType = rawCacheKey.match(/(?:^|\|)ma:(ema|sma)(?:\||$)/)?.[1];
  const inferredMaType: StockAnalysisMaType =
    matchedMaType === 'ema'
      ? 'ema'
      : matchedMaType === 'sma'
        ? 'sma'
        : tuningNotes.some((item) => /均线类型\s*EMA/i.test(item))
          ? 'ema'
          : 'sma';
  return {
    id: preset,
    label:
      typeof value?.label === 'string' && value.label.trim()
        ? value.label
        : base.label,
    description:
      typeof value?.description === 'string' && value.description.trim()
        ? value.description
        : base.description,
    cacheKey:
      matchedMaType === 'ema' || matchedMaType === 'sma'
        ? rawCacheKey
        : `${rawCacheKey}|ma:${inferredMaType}`,
    tuningNotes,
  };
}

export function normalizeDataSource(
  value: Partial<StockAnalysisDataSource> | null | undefined,
): StockAnalysisDataSource {
  return {
    providerId:
      typeof value?.providerId === 'string' && value.providerId.trim()
        ? value.providerId
        : 'yahoo',
    providerLabel:
      typeof value?.providerLabel === 'string' && value.providerLabel.trim()
        ? value.providerLabel
        : 'Yahoo Finance',
    symbol:
      typeof value?.symbol === 'string' && value.symbol.trim()
        ? value.symbol
        : '-',
    interval:
      typeof value?.interval === 'string' && value.interval.trim()
        ? value.interval
        : '1d',
    priceSource:
      value?.priceSource === 'realtime_quote' ? 'realtime_quote' : 'historical_close',
    priceSourceLabel:
      typeof value?.priceSourceLabel === 'string' && value.priceSourceLabel.trim()
        ? value.priceSourceLabel
        : value?.priceSource === 'realtime_quote'
          ? t('stock.auto_2d395e', {}, undefined)
          : t('stock.auto_53d6b2', {}, undefined),
    failoverTrace: Array.isArray(value?.failoverTrace)
      ? value.failoverTrace.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [],
  };
}

export function normalizeNewsIntelPayload(
  value: Partial<StockAnalysisNewsIntel> | null | undefined,
): StockAnalysisNewsIntel {
  const fallbackSummary =
    typeof value?.status === 'string' && value.status === 'disabled'
      ? t('stock.auto_2ed270', {}, undefined)
      : t('stock.auto_349f4b', {}, undefined);
  const references = Array.isArray(value?.references)
    ? value.references
        .map((item): StockAnalysisNewsReference | null => {
          if (!item || typeof item.title !== 'string' || typeof item.source !== 'string') {
            return null;
          }
          return {
            title: toCleanText(item.title, t('stock.auto_30d1aa', {}, undefined), 120),
            source: toCleanText(item.source, t('stock.auto_36cead', {}, undefined), 48),
            publishedAt:
              typeof item.publishedAt === 'string' && item.publishedAt.trim()
                ? item.publishedAt.trim().slice(0, 40)
                : null,
            summary: toCleanText(item.summary, t('stock.auto_ab9cb6', {}, undefined), 180),
            url:
              typeof item.url === 'string' && item.url.trim()
                ? item.url.trim().slice(0, 500)
                : null,
          };
        })
        .filter((item): item is StockAnalysisNewsReference => Boolean(item))
        .slice(0, 5)
    : [];
  const evidence = Array.isArray(value?.evidence)
    ? value.evidence
        .map((item): StockAnalysisNewsEvidence | null => {
          if (!item || typeof item.title !== 'string' || typeof item.source !== 'string') {
            return null;
          }
          return {
            title: toCleanText(item.title, t('stock.auto_30d1aa', {}, undefined), 120),
            source: toCleanText(item.source, t('stock.auto_36cead', {}, undefined), 48),
            publishedAt:
              typeof item.publishedAt === 'string' && item.publishedAt.trim()
                ? item.publishedAt.trim().slice(0, 40)
                : null,
            summary: toCleanText(item.summary, t('stock.auto_ab9cb6', {}, undefined), 180),
            url:
              typeof item.url === 'string' && item.url.trim()
                ? item.url.trim().slice(0, 500)
                : null,
            sourceType:
              item.sourceType === 'provider_reference' ||
              item.sourceType === 'fallback_snippet'
                ? item.sourceType
                : 'fallback_snippet',
            fetchedAt:
              typeof item.fetchedAt === 'string' && item.fetchedAt.trim()
                ? item.fetchedAt.trim().slice(0, 40)
                : null,
            freshnessScore:
              typeof item.freshnessScore === 'number' && Number.isFinite(item.freshnessScore)
                ? Math.max(0, Math.min(100, Math.round(item.freshnessScore)))
                : null,
            qualityScore:
              typeof item.qualityScore === 'number' && Number.isFinite(item.qualityScore)
                ? Math.max(0, Math.min(100, Math.round(item.qualityScore)))
                : null,
            includedInSummary: Boolean(item.includedInSummary),
            dropReason:
              typeof item.dropReason === 'string' && item.dropReason.trim()
                ? item.dropReason.trim().slice(0, 80)
                : null,
          };
        })
        .filter((item): item is StockAnalysisNewsEvidence => Boolean(item))
        .slice(0, 12)
    : [];
  const evidenceStats: StockAnalysisNewsEvidenceStats = {
    total:
      typeof value?.evidenceStats?.total === 'number' && Number.isFinite(value.evidenceStats.total)
        ? Math.max(0, Math.round(value.evidenceStats.total))
        : evidence.length,
    included:
      typeof value?.evidenceStats?.included === 'number' &&
      Number.isFinite(value.evidenceStats.included)
        ? Math.max(0, Math.round(value.evidenceStats.included))
        : evidence.filter((item) => item.includedInSummary).length,
    dropped:
      typeof value?.evidenceStats?.dropped === 'number' && Number.isFinite(value.evidenceStats.dropped)
        ? Math.max(0, Math.round(value.evidenceStats.dropped))
        : evidence.filter((item) => !item.includedInSummary).length,
    stale:
      typeof value?.evidenceStats?.stale === 'number' && Number.isFinite(value.evidenceStats.stale)
        ? Math.max(0, Math.round(value.evidenceStats.stale))
        : evidence.filter((item) => item.dropReason === 'stale').length,
    undated:
      typeof value?.evidenceStats?.undated === 'number' && Number.isFinite(value.evidenceStats.undated)
        ? Math.max(0, Math.round(value.evidenceStats.undated))
        : evidence.filter((item) => item.dropReason === 'missing_publish_time').length,
    lowQuality:
      typeof value?.evidenceStats?.lowQuality === 'number' &&
      Number.isFinite(value.evidenceStats.lowQuality)
        ? Math.max(0, Math.round(value.evidenceStats.lowQuality))
        : evidence.filter((item) => item.dropReason === 'low_quality').length,
  };
  return {
    status:
      value?.status === 'ready' ||
      value?.status === 'disabled' ||
      value?.status === 'unavailable'
        ? value.status
        : 'unavailable',
    sourceType:
      value?.sourceType === 'provider_web_search' ||
      value?.sourceType === 'fallback_news_feed'
        ? value.sourceType
        : 'none',
    sourceLabel: toCleanText(value?.sourceLabel, t('stock.auto_cdcd30', {}, undefined), 80),
    usedExternalSearch: Boolean(value?.usedExternalSearch),
    generatedAt:
      typeof value?.generatedAt === 'string' && value.generatedAt.trim()
        ? value.generatedAt.trim()
        : null,
    confidence:
      value?.confidence === 'high' ||
      value?.confidence === 'low' ||
      value?.confidence === 'medium'
        ? value.confidence
        : 'low',
    summary: toCleanText(value?.summary, fallbackSummary, 220),
    hotTopics: toCleanStringList(value?.hotTopics, 4),
    bullishSignals: toCleanStringList(value?.bullishSignals, 3),
    riskSignals: toCleanStringList(value?.riskSignals, 3),
    references,
    relatedSectors: toCleanStringList(value?.relatedSectors, 4),
    sectorSignals: toCleanStringList(value?.sectorSignals, 3),
    peerSignals: toCleanStringList(value?.peerSignals, 3),
    policySignals: toCleanStringList(value?.policySignals, 3),
    evidence,
    evidenceStats,
  };
}

export function normalizeSummaryPayload(
  value: Partial<StockAnalysisSummary> | null | undefined,
  fallback: StockAnalysisSummary,
): StockAnalysisSummary {
  return {
    headline: toCleanText(value?.headline, fallback.headline, 120),
    analysisSummary: toCleanText(
      value?.analysisSummary,
      fallback.analysisSummary,
      220,
    ),
    operationAdvice: toCleanText(
      value?.operationAdvice,
      fallback.operationAdvice,
      180,
    ),
    riskSignals: toCleanStringList(value?.riskSignals, 3, fallback.riskSignals),
    catalystSignals: toCleanStringList(
      value?.catalystSignals,
      3,
      fallback.catalystSignals,
    ),
  };
}

function toRoundedNumber(
  value: unknown,
  digits = 2,
): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? round(value, digits)
    : null;
}

export function normalizeMetricSnapshot(
  value: Partial<StockAnalysisMetricSnapshot> | null | undefined,
  fallback: Partial<StockAnalysisMetricSnapshot> = {},
): StockAnalysisMetricSnapshot {
  const currentPrice =
    toRoundedNumber(value?.currentPrice, 2) ??
    toRoundedNumber(fallback.currentPrice, 2) ??
    0;
  return {
    currentPrice,
    previousClose:
      toRoundedNumber(value?.previousClose, 2) ??
      toRoundedNumber(fallback.previousClose, 2),
    changePct:
      toRoundedNumber(value?.changePct, 2) ??
      toRoundedNumber(fallback.changePct, 2),
    ma5: toRoundedNumber(value?.ma5, 2),
    ma10: toRoundedNumber(value?.ma10, 2),
    biasToMa5: toRoundedNumber(value?.biasToMa5, 2),
    biasToMa20: toRoundedNumber(value?.biasToMa20, 2),
    ma20: toRoundedNumber(value?.ma20, 2),
    ma60: toRoundedNumber(value?.ma60, 2),
    high20: toRoundedNumber(value?.high20, 2),
    low20: toRoundedNumber(value?.low20, 2),
    maAligned: value?.maAligned === true,
    macdDiff: toRoundedNumber(value?.macdDiff, 3),
    macdSignal: toRoundedNumber(value?.macdSignal, 3),
    macdHistogram: toRoundedNumber(value?.macdHistogram, 3),
    macdState:
      value?.macdState === 'golden_cross_above_zero' ||
      value?.macdState === 'golden_cross_below_zero' ||
      value?.macdState === 'bullish_above_zero' ||
      value?.macdState === 'neutral' ||
      value?.macdState === 'bearish_below_zero' ||
      value?.macdState === 'death_cross_above_zero' ||
      value?.macdState === 'death_cross_below_zero'
        ? value.macdState
        : 'neutral',
    rsi6: toRoundedNumber(value?.rsi6, 2),
    rsi12: toRoundedNumber(value?.rsi12, 2),
    rsi14: toRoundedNumber(value?.rsi14, 2),
    rsi24: toRoundedNumber(value?.rsi24, 2),
    rsiState:
      value?.rsiState === 'overbought' ||
      value?.rsiState === 'strong' ||
      value?.rsiState === 'neutral' ||
      value?.rsiState === 'weak' ||
      value?.rsiState === 'oversold'
        ? value.rsiState
        : 'neutral',
    momentum20: toRoundedNumber(value?.momentum20, 2),
    annualizedVolatility: toRoundedNumber(value?.annualizedVolatility, 2),
    volumeRatio5d20d: toRoundedNumber(value?.volumeRatio5d20d, 2),
    volumeState:
      value?.volumeState === 'heavy_volume' ||
      value?.volumeState === 'increased_volume' ||
      value?.volumeState === 'normal' ||
      value?.volumeState === 'decreased_volume' ||
      value?.volumeState === 'extremely_low_volume'
        ? value.volumeState
        : 'normal',
    trendState:
      value?.trendState === 'strong_bullish' ||
      value?.trendState === 'bullish' ||
      value?.trendState === 'weak_bullish' ||
      value?.trendState === 'neutral' ||
      value?.trendState === 'weak_bearish' ||
      value?.trendState === 'bearish' ||
      value?.trendState === 'strong_bearish'
        ? value.trendState
        : 'neutral',
    return60d: toRoundedNumber(value?.return60d, 2),
    bollingerUpper: toRoundedNumber(value?.bollingerUpper, 2),
    bollingerLower: toRoundedNumber(value?.bollingerLower, 2),
    bollingerWidth: toRoundedNumber(value?.bollingerWidth, 2),
    atr14: toRoundedNumber(value?.atr14, 2),
  };
}

export function normalizeDetailPayload(
  details: Partial<StockAnalysisDetail['details']> | null | undefined,
): StockAnalysisDetail['details'] {
  const recentCloses = Array.isArray(details?.recentCloses)
    ? details.recentCloses.filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value),
      )
    : [];
  const recentBars = Array.isArray(details?.recentBars)
    ? details.recentBars
        .map((bar): StockAnalysisChartBar | null => {
          if (
            !bar ||
            typeof bar.timestamp !== 'string' ||
            typeof bar.open !== 'number' ||
            typeof bar.high !== 'number' ||
            typeof bar.low !== 'number' ||
            typeof bar.close !== 'number'
          ) {
            return null;
          }
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
            ma5:
              typeof bar.ma5 === 'number' && Number.isFinite(bar.ma5)
                ? round(bar.ma5, 2)
                : null,
            ma10:
              typeof bar.ma10 === 'number' && Number.isFinite(bar.ma10)
                ? round(bar.ma10, 2)
                : null,
            ma20:
              typeof bar.ma20 === 'number' && Number.isFinite(bar.ma20)
                ? round(bar.ma20, 2)
                : null,
            ma60:
              typeof bar.ma60 === 'number' && Number.isFinite(bar.ma60)
                ? round(bar.ma60, 2)
                : null,
          };
        })
        .filter((bar): bar is StockAnalysisChartBar => Boolean(bar))
    : [];
  const factorScores = Array.isArray(details?.factorScores)
    ? details.factorScores
        .map((item): StockAnalysisFactorScore | null => {
          if (
            !item ||
            typeof item.key !== 'string' ||
            typeof item.title !== 'string' ||
            typeof item.score !== 'number' ||
            typeof item.maxScore !== 'number' ||
            typeof item.summary !== 'string'
          ) {
            return null;
          }
          return {
            key: item.key,
            title: item.title,
            score: Math.max(0, Math.round(item.score)),
            maxScore: Math.max(1, Math.round(item.maxScore)),
            signal:
              item.signal === 'positive' ||
              item.signal === 'neutral' ||
              item.signal === 'negative'
                ? item.signal
                : 'neutral',
            summary: item.summary,
          };
        })
        .filter((item): item is StockAnalysisFactorScore => Boolean(item))
    : [];
  const tradePlan: StockAnalysisTradePlan = {
    idealBuy:
      typeof details?.tradePlan?.idealBuy === 'number' &&
      Number.isFinite(details.tradePlan.idealBuy)
        ? round(details.tradePlan.idealBuy, 2)
        : null,
    secondaryBuy:
      typeof details?.tradePlan?.secondaryBuy === 'number' &&
      Number.isFinite(details.tradePlan.secondaryBuy)
        ? round(details.tradePlan.secondaryBuy, 2)
        : null,
    stopLoss:
      typeof details?.tradePlan?.stopLoss === 'number' &&
      Number.isFinite(details.tradePlan.stopLoss)
        ? round(details.tradePlan.stopLoss, 2)
        : null,
    takeProfit:
      typeof details?.tradePlan?.takeProfit === 'number' &&
      Number.isFinite(details.tradePlan.takeProfit)
        ? round(details.tradePlan.takeProfit, 2)
        : null,
    style:
      typeof details?.tradePlan?.style === 'string' &&
      details.tradePlan.style.trim()
        ? details.tradePlan.style
        : t('stock.auto_70f361', {}, undefined),
  };
  const pipelineLog = Array.isArray(details?.pipelineLog)
    ? details.pipelineLog
        .map((item): PipelineStageLog | null => {
          if (
            !item ||
            typeof item.stage !== 'string' ||
            typeof item.startedAt !== 'number' ||
            !Number.isFinite(item.startedAt) ||
            typeof item.durationMs !== 'number' ||
            !Number.isFinite(item.durationMs)
          ) {
            return null;
          }
          return {
            stage: item.stage.trim().slice(0, 64) || 'unknown',
            startedAt: Math.round(item.startedAt),
            durationMs: Math.max(0, Math.round(item.durationMs)),
            status:
              item.status === 'ok' ||
              item.status === 'skipped' ||
              item.status === 'failed'
                ? item.status
                : 'ok',
            note:
              typeof item.note === 'string' && item.note.trim()
                ? item.note.trim().slice(0, 180)
                : undefined,
          };
        })
        .filter((item): item is PipelineStageLog => Boolean(item))
    : [];
  return {
    heuristicNotes: Array.isArray(details?.heuristicNotes)
      ? details.heuristicNotes.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    supportLevels: Array.isArray(details?.supportLevels)
      ? details.supportLevels.filter(
          (value): value is number => typeof value === 'number' && Number.isFinite(value),
        )
      : [],
    resistanceLevels: Array.isArray(details?.resistanceLevels)
      ? details.resistanceLevels.filter(
          (value): value is number => typeof value === 'number' && Number.isFinite(value),
        )
      : [],
    recentCloses,
    recentBars,
    factorScores,
    tradePlan,
    newsIntel: normalizeNewsIntelPayload(details?.newsIntel),
    pipelineLog,
  };
}

export function normalizeReportValidation(
  value: Partial<StockAnalysisReportValidation>,
): StockAnalysisReportValidation {
  return {
    status:
      value.status === 'validated' ||
      value.status === 'pending' ||
      value.status === 'unavailable'
        ? value.status
        : 'unavailable',
    targetDate:
      typeof value.targetDate === 'string' && value.targetDate.trim()
        ? value.targetDate
        : null,
    nextTradingDate:
      typeof value.nextTradingDate === 'string' && value.nextTradingDate.trim()
        ? value.nextTradingDate
        : null,
    verdict:
      value.verdict === 'matched' ||
      value.verdict === 'partially_matched' ||
      value.verdict === 'mismatched' ||
      value.verdict === 'pending'
        ? value.verdict
        : 'pending',
    matchScore:
      typeof value.matchScore === 'number' && Number.isFinite(value.matchScore)
        ? round(value.matchScore, 0)
        : null,
    nextDayReturnPct:
      typeof value.nextDayReturnPct === 'number' &&
      Number.isFinite(value.nextDayReturnPct)
        ? round(value.nextDayReturnPct, 2)
        : null,
    nextDayClose:
      typeof value.nextDayClose === 'number' && Number.isFinite(value.nextDayClose)
        ? round(value.nextDayClose, 2)
        : null,
    summary: toCleanText(
      value.summary,
      t('stock.auto_5a5f76', {}, undefined),
      220,
    ),
    reasons: toCleanStringList(value.reasons, 4, [
      t('stock.auto_5a5f76', {}, undefined),
    ]),
  };
}

export function normalizeMarketReviewDetail(
  detail: Partial<StockAnalysisMarketReview['detail']> | null | undefined,
): StockAnalysisMarketReview['detail'] {
  const indices = Array.isArray(detail?.indices)
    ? detail.indices.map((item) => ({
        symbol: item.symbol,
        name: item.name,
        price: item.price ?? null,
        changePct: item.changePct ?? null,
        providerLabel:
          typeof item.providerLabel === 'string' && item.providerLabel.trim()
            ? item.providerLabel
            : t('stock.auto_36cead', {}, undefined),
        priceSource:
          item.priceSource === 'realtime_quote'
            ? ('realtime_quote' as const)
            : ('historical_close' as const),
        priceSourceLabel:
          typeof item.priceSourceLabel === 'string' && item.priceSourceLabel.trim()
            ? item.priceSourceLabel
            : item.priceSource === 'realtime_quote'
              ? t('stock.auto_2d395e', {}, undefined)
              : t('stock.auto_53d6b2', {}, undefined),
        dataAsOf: item.dataAsOf ?? null,
      }))
    : [];
  const dataAsOfDates = Array.isArray(detail?.dataAsOfDates)
    ? detail.dataAsOfDates.filter(
        (value): value is string => typeof value === 'string',
      )
    : Array.from(
        new Set(
          indices
            .map((item) => toIsoTradeDate(item.dataAsOf))
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort();
  return {
    indices,
    dataAsOfDates,
    notes: Array.isArray(detail?.notes) ? detail.notes : [],
  };
}

export function extractJsonObject<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    // Try to repair common JSON issues (trailing commas, unquoted keys)
    try {
      const cleaned = text
        .slice(start, end + 1)
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}
