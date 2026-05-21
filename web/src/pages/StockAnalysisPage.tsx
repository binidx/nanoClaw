import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useNavigatedTab } from '../hooks/useNavigatedTab';

import {
  getDefaultMarketScopeOptions,
  getDefaultReportTypeOptions,
  getDefaultStrategyOptions,
  resolveConfigMarketScope,
  resolveConfigReportType,
  resolveConfigStrategyPreset,
  resolveSelectOptions,
} from './stock-analysis/options';
import { analyzeStocks, runBacktestAnalysis } from './stock-analysis/api';
import type {
  HistorySortMode,
  StockAnalysisBacktestRequest,
  StockAnalysisBacktestResult,
  StockAnalysisConfigMap,
  StockAnalysisConfigPreset,
  StockAnalysisDecisionDashboard,
  StockAnalysisFeedbackSnapshot,
  StockAnalysisHistoryItem,
  StockAnalysisPageProps,
  StockAnalysisReport,
  StockAnalysisReportType,
  StockAnalysisReportValidation,
  StockAnalysisStrategyPreset,
  StockAnalysisTab,
  StockAnalysisTask,
  StockAnalysisWatchlistItem,
  StockMarketReview,
  StockMarketScope,
  StockPickerCandidate,
} from './stock-analysis/types';
import { useStockAnalysisRemoteData } from './stock-analysis/useStockAnalysisRemoteData';
import { NcSelect } from '../components/common/NcSelect';
import i18n from '../i18n';

const VALID_STOCK_TABS: ReadonlySet<string> = new Set<StockAnalysisTab>(['workbench', 'reports', 'market', 'portfolio']);

type StockAnalysisHistoryView = 'reports' | 'recent' | 'feedback' | 'failed';
type StockAnalysisHistoryListMode = 'grouped' | 'flat';
type StockAnalysisHistoryDateRange = 'all' | '7d' | '30d' | '90d' | '180d';
type StockAnalysisHistoryGroupSort = 'latest' | 'score-desc' | 'count-desc';
type StockAnalysisOverviewSection = 'core' | 'advanced';
type StockAnalysisDetailView = 'overview' | 'intel' | 'factors' | 'reference';
type StockAnalysisIntelView = 'summary' | 'structure' | 'evidence';
type StockAnalysisFeedbackView = 'strategies' | 'evaluations' | 'notes';
type StockAnalysisFeedbackStrategySort =
  | 'sample-desc'
  | 'winrate-desc'
  | 'return-desc';
type StockAnalysisFeedbackMinSample = 'all' | '5' | '10' | '20';
type StockAnalysisFeedbackEvaluationSort = 'latest' | 'return-desc';
type StockAnalysisFeedbackOutcomeFilter = 'all' | 'win' | 'flat' | 'loss';
type StockAnalysisRecentResultMode = 'all' | 'generated' | 'reused';
type StockAnalysisMarketView = 'review' | 'backtest' | 'providers';

function decodePathPart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveRouteReportId(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'stock-analysis' || parts[1] !== 'reports') {
    return null;
  }
  return decodePathPart(parts[2]);
}

function stockReportsPath(reportId?: string | null): string {
  return reportId
    ? `/stock-analysis/reports/${encodeURIComponent(reportId)}`
    : '/stock-analysis/reports';
}

function splitStockCodes(input: string): string[] {
  return input
    .split(/[\n,，\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeConfigMap(config: StockAnalysisConfigMap): string {
  return JSON.stringify(
    Object.keys(config)
      .sort()
      .map((key) => [key, config[key]]),
  );
}

function resolveConfigDiffKeys(
  current: StockAnalysisConfigMap,
  baseline: StockAnalysisConfigMap,
): string[] {
  return Array.from(
    new Set([...Object.keys(current), ...Object.keys(baseline)]),
  )
    .sort()
    .filter((key) => current[key] !== baseline[key]);
}

function resolveMatchingPreset(
  config: StockAnalysisConfigMap,
  presets: StockAnalysisConfigPreset[],
): StockAnalysisConfigPreset | null {
  const serialized = serializeConfigMap(config);
  return (
    presets.find(
      (preset) => serializeConfigMap(preset.values) === serialized,
    ) || null
  );
}

function resolveWatchlistScope(
  items: StockAnalysisWatchlistItem[],
): StockMarketScope {
  const markets = new Set(items.map((item) => item.market));
  if (markets.size === 0) {
    return 'both';
  }
  if (markets.size === 1) {
    return items[0]?.market || 'both';
  }
  return markets.has('us') ? 'all' : 'both';
}

function resolveItemMarketScope(
  items: Array<{ market: StockAnalysisWatchlistItem['market'] }>,
): StockMarketScope {
  const markets = new Set(items.map((item) => item.market));
  if (markets.size === 0) {
    return 'both';
  }
  if (markets.size === 1) {
    return items[0]?.market || 'both';
  }
  return markets.has('us') ? 'all' : 'both';
}

function resolveConfigNumber(
  value: string | number | boolean | undefined,
  fallback: number,
): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatRejectedItems(
  items: Array<{ stockCode: string; error: string }>,
): string {
  return items.map((item) => `${item.stockCode}: ${item.error}`).join('；');
}

function resolveReviewSentimentClass(
  stance: string | null | undefined,
): string {
  if (stance === '偏强') return 'risk-on';
  if (stance === '偏弱') return 'defensive';
  return 'balanced';
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatMaybePercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return formatPercent(value);
}

function formatMaybeNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatCompactVolume(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 100_000_000) {
    return i18n.t("stock.volume.yi", { value: (value / 100_000_000).toFixed(2) });
  }
  if (Math.abs(value) >= 10_000) {
    return i18n.t("stock.volume.wan", { value: (value / 10_000).toFixed(2) });
  }
  return String(Math.round(value));
}

function describeFreshness(value: string | null | undefined): string {
  if (!value) return i18n.t('stock.freshness.unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t('stock.freshness.unknown');
  const diffMinutes = Math.max(
    0,
    Math.round((Date.now() - date.getTime()) / 60_000),
  );
  if (diffMinutes < 60) {
    return i18n.t('stock.freshness.minutesAgo', { diffMinutes });
  }
  if (diffMinutes < 24 * 60) {
    return i18n.t('stock.freshness.hoursAgo', { hours: Math.round(diffMinutes / 60) });
  }
  return i18n.t('stock.freshness.daysAgo', { days: Math.round(diffMinutes / (24 * 60)) });
}

function resolveDataAgeState(value: string | null | undefined): {
  label: string;
  tone: 'fresh' | 'cached' | 'subtle';
} {
  if (!value) return { label: i18n.t('stock.freshness.unknown'), tone: 'subtle' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return { label: i18n.t('stock.freshness.unknown'), tone: 'subtle' };
  const diffHours = (Date.now() - date.getTime()) / 3_600_000;
  if (diffHours <= 24) {
    return { label: i18n.t('stock.freshness.within1Day'), tone: 'fresh' };
  }
  if (diffHours <= 72) {
    return { label: i18n.t('stock.freshness.1to3Days'), tone: 'cached' };
  }
  return { label: i18n.t('stock.freshness.historical'), tone: 'subtle' };
}

function resolveGeneratedAt<T extends { createdAt: string }>(value: T): string {
  return value.createdAt;
}

function resolveCacheStatus(value: {
  resultMode?: 'generated' | 'reused' | null;
  isCached?: boolean | null;
  reusedFromReportId?: string | null;
}): { label: string; tone: 'fresh' | 'cached' } {
  if (
    value.resultMode === 'reused' ||
    value.isCached ||
    value.reusedFromReportId
  ) {
    return { label: i18n.t('stock.cache.cached'), tone: 'cached' };
  }
  return { label: i18n.t('stock.cache.new'), tone: 'fresh' };
}

function resolveMarketReviewDataAsOf(
  review: StockMarketReview | null,
): string | null {
  if (!review) return null;
  const values = review.detail.indices
    .map((item) => item.dataAsOf || null)
    .filter((value): value is string => Boolean(value))
    .sort();
  return values[values.length - 1] || null;
}

function formatMarket(value: StockAnalysisWatchlistItem['market']): string {
  if (value === 'cn') return i18n.t('stock.market.aShare');
  if (value === 'hk') return i18n.t('stock.market.hk');
  return i18n.t('stock.market.us');
}

function formatRecommendation(value: string): string {
  if (value === 'buy') return i18n.t('stock.recommendation.buy');
  if (value === 'reduce') return i18n.t('stock.recommendation.reduce');
  if (value === 'watch') return i18n.t('stock.recommendation.watch');
  return value;
}

function formatReportTypeLabel(value: StockAnalysisReportType): string {
  if (value === 'brief') return i18n.t('stock.reportType.brief');
  if (value === 'detailed') return i18n.t('stock.reportType.detailed');
  return i18n.t('stock.reportType.standard');
}

function resolveFactorSignalTone(
  value: 'positive' | 'neutral' | 'negative',
): 'good' | 'neutral' | 'bad' {
  return value === 'positive'
    ? 'good'
    : value === 'negative'
      ? 'bad'
      : 'neutral';
}

function resolveFeedbackOutcomeTone(
  value: 'win' | 'flat' | 'loss',
): 'good' | 'neutral' | 'bad' {
  return value === 'win' ? 'good' : value === 'loss' ? 'bad' : 'neutral';
}

function formatOutcomeLabel(value: 'win' | 'flat' | 'loss'): string {
  return value === 'win' ? i18n.t('stock.outcome.win') : value === 'loss' ? i18n.t('stock.outcome.loss') : i18n.t('stock.outcome.flat');
}

function resolveValidationTone(
  value: StockAnalysisReportValidation | null,
): 'good' | 'neutral' | 'bad' {
  if (!value || value.verdict === 'pending') return 'neutral';
  return value.verdict === 'matched'
    ? 'good'
    : value.verdict === 'mismatched'
      ? 'bad'
      : 'neutral';
}

function formatValidationVerdict(
  value: StockAnalysisReportValidation['verdict'],
): string {
  return value === 'matched'
    ? i18n.t('stock.validation.matched')
    : value === 'partially_matched'
      ? i18n.t('stock.validation.partiallyMatched')
      : value === 'mismatched'
        ? i18n.t('stock.validation.mismatched')
        : i18n.t('stock.validation.pending');
}

function resolveNewsIntelTone(
  value: StockAnalysisReport['details']['newsIntel'],
): 'good' | 'neutral' | 'bad' {
  if (value.status !== 'ready') return 'neutral';
  if (value.riskSignals.length > value.bullishSignals.length) return 'bad';
  if (value.bullishSignals.length > 0) return 'good';
  return 'neutral';
}

function formatTrend(value: string): string {
  if (value === 'bullish') return i18n.t('stock.trend.bullish');
  if (value === 'bearish') return i18n.t('stock.trend.bearish');
  if (value === 'neutral') return i18n.t('stock.trend.neutral');
  return value;
}

function formatTaskStatus(value: StockAnalysisTask['status']): string {
  return value === 'pending'
    ? i18n.t('stock.taskStatus.pending')
    : value === 'running'
      ? i18n.t('stock.taskStatus.running')
      : value === 'completed'
        ? i18n.t('stock.taskStatus.completed')
        : i18n.t('stock.taskStatus.failed');
}

function deriveTaskProgress(value: StockAnalysisTask['status']): number {
  return value === 'pending' ? 32 : value === 'running' ? 68 : 100;
}

function describeTaskStatus(task: StockAnalysisTask): string {
  if (task.status === 'pending') {
    return i18n.t('stock.taskDesc.pending');
  }
  if (task.status === 'running') {
    return i18n.t('stock.taskDesc.running');
  }
  if (task.status === 'completed') {
    return task.reportId ? i18n.t('stock.taskDesc.reportReady') : i18n.t('stock.taskDesc.completed');
  }
  return task.error || i18n.t('stock.taskDesc.analysisFailed');
}

function formatCacheHint(value: string | number | boolean | undefined): string {
  const ttlMinutes = Math.max(
    0,
    typeof value === 'number' ? value : Number(value) || 0,
  );
  if (ttlMinutes <= 0) {
    return i18n.t('stock.cacheHint.disabled');
  }
  return i18n.t('stock.cacheHint.enabled', { ttlMinutes });
}

function matchesFreshnessWindow(
  value: string | null | undefined,
  maxDays: number,
): boolean {
  if (maxDays <= 0) return true;
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= maxDays * 24 * 60 * 60 * 1000;
}

function matchesHistoryDateRange(
  value: string | null | undefined,
  range: StockAnalysisHistoryDateRange,
): boolean {
  if (range === 'all') return true;
  const days =
    range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 180;
  return matchesFreshnessWindow(value, days);
}

function formatChartDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function buildLinePath(
  values: Array<number | null>,
  width: number,
  mapY: (value: number) => number,
): string {
  const points = values
    .map((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      const x =
        values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
      return `${x},${mapY(value)}`;
    })
    .filter((value): value is string => Boolean(value));
  if (points.length === 0) return '';
  return `M ${points.join(' L ')}`;
}

function StockAnalysisChartCard({ report }: { report: StockAnalysisReport }) {
  const { t } = useTranslation('stock');
  const bars = useMemo(
    () =>
      Array.isArray(report.details.recentBars)
        ? report.details.recentBars.slice(-60)
        : [],
    [report.details.recentBars],
  );
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const latestBar = bars[bars.length - 1] || null;
  const firstBar = bars[0] || null;
  const dataAgeState = resolveDataAgeState(report.dataAsOf || report.createdAt);
  const activeBar =
    hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < bars.length
      ? bars[hoveredIndex]
      : latestBar;
  const chart = useMemo(() => {
    if (!bars.length) return null;
    const width = 760;
    const height = 360;
    const padding = { top: 16, right: 12, bottom: 28, left: 12 };
    const plotWidth = width - padding.left - padding.right;
    const priceSectionHeight = 228;
    const volumeSectionTop = padding.top + priceSectionHeight + 18;
    const volumeSectionHeight = 72;
    const allValues = bars.flatMap((bar) =>
      [bar.low, bar.high, bar.ma20, bar.ma60].filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      ),
    );
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const rangeBase = maxValue - minValue || maxValue * 0.02 || 1;
    const paddedMin = minValue - rangeBase * 0.06;
    const paddedMax = maxValue + rangeBase * 0.06;
    const scale = paddedMax - paddedMin || 1;
    const mapY = (value: number) =>
      padding.top + ((paddedMax - value) / scale) * priceSectionHeight;
    const bandWidth = plotWidth / bars.length;
    const bodyWidth = Math.max(4, Math.min(10, bandWidth * 0.58));
    const volumeMax = Math.max(
      ...bars.map((bar) =>
        typeof bar.volume === 'number' && Number.isFinite(bar.volume)
          ? bar.volume
          : 0,
      ),
      1,
    );

    const candles = bars.map((bar, index) => {
      const centerX = padding.left + bandWidth * index + bandWidth / 2;
      const openY = mapY(bar.open);
      const closeY = mapY(bar.close);
      const highY = mapY(bar.high);
      const lowY = mapY(bar.low);
      const top = Math.min(openY, closeY);
      const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
      const bullish = bar.close >= bar.open;
      return {
        key: `${bar.timestamp}-${index}`,
        centerX,
        highY,
        lowY,
        bodyX: centerX - bodyWidth / 2,
        bodyY: top,
        bodyHeight,
        bullish,
        volumeHeight:
          typeof bar.volume === 'number' && Number.isFinite(bar.volume)
            ? Math.max(1.5, (bar.volume / volumeMax) * volumeSectionHeight)
            : 0,
      };
    });

    const gridValues = Array.from({ length: 4 }, (_item, index) => {
      const ratio = index / 3;
      const value = paddedMax - (paddedMax - paddedMin) * ratio;
      return {
        key: `grid-${index}`,
        y: padding.top + priceSectionHeight * ratio,
        label: value.toFixed(2),
      };
    });

    const axisLabels = bars
      .map((bar, index) => ({ bar, index }))
      .filter(({ index }) =>
        bars.length <= 6
          ? true
          : index === 0 || index === bars.length - 1 || index % 10 === 0,
      )
      .map(({ bar, index }) => ({
        key: `${bar.timestamp}-${index}`,
        x: padding.left + bandWidth * index + bandWidth / 2,
        label: formatChartDateLabel(bar.timestamp),
      }));

    return {
      width,
      height,
      plotLeft: padding.left,
      plotRight: width - padding.right,
      plotBottom: height - padding.bottom,
      priceBottom: padding.top + priceSectionHeight,
      gridValues,
      axisLabels,
      candles,
      ma20Path: buildLinePath(
        bars.map((bar) => bar.ma20),
        plotWidth,
        mapY,
      ),
      ma60Path: buildLinePath(
        bars.map((bar) => bar.ma60),
        plotWidth,
        mapY,
      ),
      mapPathOffset: `translate(${padding.left} ${0})`,
      candleBodyWidth: bodyWidth,
      candleCenters: candles.map((candle) => candle.centerX),
      plotTop: padding.top,
      volumeTop: volumeSectionTop,
      volumeBottom: volumeSectionTop + volumeSectionHeight,
    };
  }, [bars]);

  function handleChartHover(event: ReactMouseEvent<SVGSVGElement>): void {
    if (!bars.length || !chart) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const ratio = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width),
    );
    const nextIndex = Math.max(
      0,
      Math.min(bars.length - 1, Math.round(ratio * (bars.length - 1))),
    );
    setHoveredIndex(nextIndex);
  }

  return (
    <div className="stock-analysis-detail-card stock-analysis-chart-card">
      <div className="stock-analysis-chart-header">
        <div>
          <h4>{t('stock.chart.dailyKline')}</h4>
          <p className="stock-analysis-subtle">
            {t('stock.chart.recentTradingDays', { count: bars.length || report.details.recentCloses.length })},
            {firstBar && latestBar
              ? t('stock.chart.range', { start: formatDateOnly(firstBar.timestamp), end: formatDateOnly(latestBar.timestamp) })
              : t('stock.chart.legacyOHLC')}
          </p>
        </div>
        <div className="stock-analysis-meta-strip compact">
          <span className={`stock-analysis-meta-chip ${dataAgeState.tone}`}>
            {dataAgeState.label}
          </span>
          <span className="stock-analysis-meta-chip subtle">{t('stock.chart.kline')}</span>
          <span className="stock-analysis-meta-chip subtle">{t('stock.chart.volume')}</span>
          <span className="stock-analysis-meta-chip subtle">MA20</span>
          <span className="stock-analysis-meta-chip subtle">MA60</span>
        </div>
      </div>

      {chart ? (
        <>
          <div className="stock-analysis-chart-canvas">
            <svg
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="img"
              aria-label={t('stock.chart.klineTitle', { stockName: report.stockName })}
              onMouseMove={handleChartHover}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {chart.gridValues.map((item) => (
                <g key={item.key}>
                  <line
                    x1={chart.plotLeft}
                    x2={chart.plotRight}
                    y1={item.y}
                    y2={item.y}
                    className="stock-analysis-chart-grid"
                  />
                  <text
                    x={chart.plotRight - 2}
                    y={item.y - 4}
                    textAnchor="end"
                    className="stock-analysis-chart-axis"
                  >
                    {item.label}
                  </text>
                </g>
              ))}

              <line
                x1={chart.plotLeft}
                x2={chart.plotRight}
                y1={chart.volumeTop - 8}
                y2={chart.volumeTop - 8}
                className="stock-analysis-chart-grid"
              />
              <text
                x={chart.plotRight - 2}
                y={chart.volumeTop - 12}
                textAnchor="end"
                className="stock-analysis-chart-axis"
              >
                VOL
              </text>

              {chart.ma60Path ? (
                <path
                  d={chart.ma60Path}
                  transform={chart.mapPathOffset}
                  className="stock-analysis-chart-line ma60"
                />
              ) : null}
              {chart.ma20Path ? (
                <path
                  d={chart.ma20Path}
                  transform={chart.mapPathOffset}
                  className="stock-analysis-chart-line ma20"
                />
              ) : null}

              {chart.candles.map((candle) => (
                <g key={candle.key}>
                  <line
                    x1={candle.centerX}
                    x2={candle.centerX}
                    y1={candle.highY}
                    y2={candle.lowY}
                    className={`stock-analysis-chart-wick ${
                      candle.bullish ? 'up' : 'down'
                    }`}
                  />
                  <rect
                    x={candle.bodyX}
                    y={chart.volumeBottom - candle.volumeHeight}
                    width={chart.candleBodyWidth}
                    height={candle.volumeHeight}
                    rx={1.5}
                    className={`stock-analysis-chart-volume ${
                      candle.bullish ? 'up' : 'down'
                    }`}
                  />
                  <rect
                    x={candle.bodyX}
                    y={candle.bodyY}
                    width={chart.candleBodyWidth}
                    height={candle.bodyHeight}
                    rx={1.5}
                    className={`stock-analysis-chart-body ${
                      candle.bullish ? 'up' : 'down'
                    }`}
                  />
                </g>
              ))}

              {hoveredIndex !== null && activeBar ? (
                <g>
                  <line
                    x1={chart.candleCenters[hoveredIndex] || chart.plotLeft}
                    x2={chart.candleCenters[hoveredIndex] || chart.plotLeft}
                    y1={chart.plotTop}
                    y2={chart.plotBottom}
                    className="stock-analysis-chart-crosshair"
                  />
                  <g
                    transform={`translate(${Math.min(
                      chart.plotRight - 138,
                      Math.max(
                        chart.plotLeft + 6,
                        (chart.candleCenters[hoveredIndex] || chart.plotLeft) +
                          10,
                      ),
                    )} ${chart.plotTop + 8})`}
                  >
                    <rect
                      width="132"
                      height="90"
                      rx="10"
                      className="stock-analysis-chart-tooltip"
                    />
                    <text
                      x="10"
                      y="18"
                      className="stock-analysis-chart-tooltip-title"
                    >
                      {formatDateOnly(activeBar.timestamp)}
                    </text>
                    <text
                      x="10"
                      y="34"
                      className="stock-analysis-chart-tooltip-text"
                    >
                      {t('stock.chart.open')} {formatMaybeNumber(activeBar.open)} {t('stock.chart.close')}{' '}
                      {formatMaybeNumber(activeBar.close)}
                    </text>
                    <text
                      x="10"
                      y="50"
                      className="stock-analysis-chart-tooltip-text"
                    >
                      {t('stock.chart.high')} {formatMaybeNumber(activeBar.high)} {t('stock.chart.low')}{' '}
                      {formatMaybeNumber(activeBar.low)}
                    </text>
                    <text
                      x="10"
                      y="66"
                      className="stock-analysis-chart-tooltip-text"
                    >
                      MA20 {formatMaybeNumber(activeBar.ma20)} / MA60{' '}
                      {formatMaybeNumber(activeBar.ma60)}
                    </text>
                    <text
                      x="10"
                      y="82"
                      className="stock-analysis-chart-tooltip-text"
                    >
                      {t('stock.chart.vol')} {formatCompactVolume(activeBar.volume)}
                    </text>
                  </g>
                </g>
              ) : null}

              {chart.axisLabels.map((item) => (
                <text
                  key={item.key}
                  x={item.x}
                  y={chart.plotBottom + 16}
                  textAnchor="middle"
                  className="stock-analysis-chart-axis"
                >
                  {item.label}
                </text>
              ))}
            </svg>
          </div>
          {activeBar ? (
            <div className="stock-analysis-chart-summary">
              <span>
                {hoveredIndex !== null
                  ? formatDateOnly(activeBar.timestamp)
                  : t('stock.sort.latest')}
              </span>
              <span>{t('stock.chart.open')} {formatMaybeNumber(activeBar.open)}</span>
              <span>{t('stock.chart.high')} {formatMaybeNumber(activeBar.high)}</span>
              <span>{t('stock.chart.low')} {formatMaybeNumber(activeBar.low)}</span>
              <span>{t('stock.chart.close')} {formatMaybeNumber(activeBar.close)}</span>
              <span>{t('stock.chart.vol')} {formatCompactVolume(activeBar.volume)}</span>
              <span
                className={
                  activeBar.close >= activeBar.open ? 'delta-up' : 'delta-down'
                }
              >
                {activeBar.close >= activeBar.open ? t('stock.c7da8d83') : t('stock.e4fae75e')}
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="stock-analysis-chart-empty">
          <p>{t('stock.53c233e7')}</p>
          <p className="stock-analysis-subtle">
            {t('stock.7261f4b1')}
          </p>
        </div>
      )}
    </div>
  );
}

function StockAnalysisReferenceCard({
  report,
}: {
  report: StockAnalysisReport;
}) {
  const { t } = useTranslation('stock');
  const newsIntel = report.details.newsIntel;
  const dataAgeState = resolveDataAgeState(report.dataAsOf || report.createdAt);
  return (
    <div className="stock-analysis-detail-card">
      <h4>{t('stock.7dd3f43d')}</h4>
      <ul>
        <li>{t('stock.e3065c7b')}</li>
        <li>
          {t('stock.34baa6ae')} {report.strategy.label}，{t('stock.3a7c56a2')}{' '}
          {report.strategy.description}
        </li>
        {report.strategy.tuningNotes.length > 0 ? (
          <li>{t('stock.543058cd')}：{report.strategy.tuningNotes.join('；')}。</li>
        ) : null}
        <li>
          {t('stock.3703dbc4')} {report.dataSource.providerLabel}，{t('stock.dd19770c')}{' '}
          {report.dataSource.symbol}，{t('stock.2d842318')} {report.dataSource.interval}。
        </li>
        <li>{t('stock.bef4593f')} {report.dataSource.priceSourceLabel}。</li>
        {report.dataSource.failoverTrace.length > 0 ? (
          <li>
            {t('stock.506371bb')}：{report.dataSource.failoverTrace.join(' → ')}。
          </li>
        ) : null}
        <li>
          {t('stock.b8b6432a')}：{dataAgeState.label}，
          {describeFreshness(report.dataAsOf || report.createdAt)}。
        </li>
        <li>
          MA20、MA60、{t('stock.224c963e')}
          {report.historyDays || 180}
          {t('stock.9b474a13')}
        </li>
        <li>
          {report.modelUsed
            ? t('stock.534b6655', { model: report.modelUsed })
            : t('stock.intel.noModelEnhancement')}
        </li>
        <li>
          {newsIntel.usedExternalSearch
            ? newsIntel.sourceType === 'fallback_news_feed'
              ? t('stock.84f3f151', {
                  source: newsIntel.sourceLabel,
                  confidence: newsIntel.confidence,
                })
              : `${t('stock.4c007081_part1')} ${newsIntel.sourceLabel} ${t('stock.4c007081', {
                  source: newsIntel.sourceLabel,
                  confidence: newsIntel.confidence,
                })}`
            : newsIntel.status === 'disabled'
              ? t('stock.intel.catalystDisabled')
              : t('stock.intel.noExternalResults')}
        </li>
        <li>
          {t('stock.c375ae1a')}
        </li>
        <li>
          {t('stock.bd356bd2')}{' '}
          {formatDateTime(report.dataAsOf || report.createdAt)}。
        </li>
      </ul>
    </div>
  );
}

function StockAnalysisNewsIntelCard({
  report,
}: {
  report: StockAnalysisReport;
}) {
  const { t } = useTranslation('stock');
  const [intelView, setIntelView] = useState<StockAnalysisIntelView>('summary');
  const formatEvidenceDropReason = (value: string | null) => {
    if (value === 'stale') return t('stock.evidence.stale');
    if (value === 'missing_publish_time') return t('stock.evidence.missingDate');
    if (value === 'low_quality') return t('stock.evidence.lowQuality');
    return value || t('stock.9c2a61ff');
  };
  const intel = report.details.newsIntel;
  const tone = resolveNewsIntelTone(intel);
  const relatedSectors = intel.relatedSectors ?? [];
  const sectorSignals = intel.sectorSignals ?? [];
  const peerSignals = intel.peerSignals ?? [];
  const policySignals = intel.policySignals ?? [];
  const evidence = intel.evidence ?? [];
  const evidenceStats = intel.evidenceStats ?? {
    total: 0,
    included: 0,
    dropped: 0,
    stale: 0,
    undated: 0,
    lowQuality: 0,
  };
  const structuredBlocks = [
    { title: t('stock.section.relatedSectors'), items: relatedSectors },
    { title: t('stock.e2b0b12e'), items: sectorSignals },
    { title: t('stock.section.peerLinkage'), items: peerSignals },
    { title: t('stock.section.policyCatalyst'), items: policySignals },
  ].filter((item) => item.items.length > 0);
  const structuredFallback =
    !intel.usedExternalSearch || intel.sourceType === 'none';
  const sourceLabel = structuredFallback ? t('stock.e65d92ac') : intel.sourceLabel;
  const freshnessLabel = structuredFallback
    ? t('stock.28b9d501')
    : t('stock.efd215d6', { confidence: intel.confidence });
  return (
    <div className="stock-analysis-detail-card">
      <div className="stock-analysis-task-header">
        <h4>{t('stock.ac1c7822')}</h4>
        <span className={`score-pill ${tone}`}>
          {intel.usedExternalSearch
            ? intel.sourceType === 'fallback_news_feed'
              ? t('stock.f48822ef')
              : t('stock.intel.externalEnabled')
            : t('stock.e65d92ac')}
        </span>
      </div>
      <p className="stock-analysis-report-copy">{intel.summary}</p>
      <div className="stock-analysis-meta-strip compact">
        <span className="stock-analysis-meta-chip subtle">
          {t('stock.26ca20b1')} {sourceLabel}
        </span>
        <span className="stock-analysis-meta-chip subtle">
          {freshnessLabel}
        </span>
        <span className="stock-analysis-meta-chip subtle">
          {intel.generatedAt
            ? t('stock.589a837d') + ' ' + formatDateTime(intel.generatedAt)
            : t('stock.21a0f096')}
        </span>
      </div>
      <div className="stock-analysis-tabs stock-analysis-tabs-compact stock-analysis-intel-tabs">
        <button
          className={`stock-analysis-tab ${intelView === 'summary' ? 'active' : ''}`}
          type="button"
          onClick={() => setIntelView('summary')}
        >
          {t('stock.052ae998')}
        </button>
        <button
          className={`stock-analysis-tab ${intelView === 'structure' ? 'active' : ''}`}
          type="button"
          onClick={() => setIntelView('structure')}
        >
          {t('stock.ea495659')}
        </button>
        <button
          className={`stock-analysis-tab ${intelView === 'evidence' ? 'active' : ''}`}
          type="button"
          onClick={() => setIntelView('evidence')}
        >
          {t('stock.897dac82')}
        </button>
      </div>
      {intelView === 'summary' ? (
        <div className="stock-analysis-intel-panel">
          {intel.hotTopics.length > 0 ? (
            <div className="stock-analysis-highlights">
              {intel.hotTopics.map((item) => (
                <span key={item} className="stock-analysis-chip">
                  {item}
                </span>
              ))}
            </div>
          ) : null}
          {evidenceStats.total > 0 ? (
            <div className="stock-analysis-meta-strip compact">
              <span className="stock-analysis-meta-chip subtle">
                {t('stock.a1619f59')} {evidenceStats.included}/{evidenceStats.total} {t('stock.49970ba6')}
              </span>
              {evidenceStats.dropped > 0 ? (
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.evidence.dropped')} {evidenceStats.dropped}
                  {evidenceStats.stale > 0
                    ? ` · {t('stock.evidence.stale')} ${evidenceStats.stale}`
                    : ''}
                  {evidenceStats.undated > 0
                    ? ` · {t('stock.evidence.undated')} ${evidenceStats.undated}`
                    : ''}
                  {evidenceStats.lowQuality > 0
                    ? ` · {t('stock.evidence.lowQuality')} ${evidenceStats.lowQuality}`
                    : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="stock-analysis-intel-grid">
            <div>
              <strong>{t('stock.a9036579')}</strong>
              <ul>
                {intel.bullishSignals.length > 0 ? (
                  intel.bullishSignals.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>{t('stock.8bc63864')}</li>
                )}
              </ul>
            </div>
            <div>
              <strong>{t('stock.6d576357')}</strong>
              <ul>
                {intel.riskSignals.length > 0 ? (
                  intel.riskSignals.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>{t('stock.5c1a40bb')}</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      ) : null}
      {intelView === 'structure' ? (
        <div className="stock-analysis-intel-panel">
          <p className="stock-analysis-subtle">
            {structuredFallback
              ? t('stock.6678d8fa')
              : t('stock.section.structure')}
          </p>
          {structuredBlocks.length > 0 ? (
            <div className="stock-analysis-intel-grid">
              {structuredBlocks.map((block) => (
                <div key={block.title}>
                  <strong>{block.title}</strong>
                  <ul>
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="stock-analysis-empty-state">
              <p>{t('stock.dc2031b4')}</p>
            </div>
          )}
        </div>
      ) : null}
      {intelView === 'evidence' ? (
        <div className="stock-analysis-intel-panel">
          {evidenceStats.total > 0 ? (
            <div className="stock-analysis-meta-strip compact">
              <span className="stock-analysis-meta-chip subtle">
                {t('stock.a1619f59')} {evidenceStats.included}/{evidenceStats.total} {t('stock.49970ba6')}
              </span>
              {evidenceStats.dropped > 0 ? (
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.evidence.dropped')} {evidenceStats.dropped}
                  {evidenceStats.stale > 0
                    ? ` · {t('stock.evidence.stale')} ${evidenceStats.stale}`
                    : ''}
                  {evidenceStats.undated > 0
                    ? ` · {t('stock.evidence.undated')} ${evidenceStats.undated}`
                    : ''}
                  {evidenceStats.lowQuality > 0
                    ? ` · {t('stock.evidence.lowQuality')} ${evidenceStats.lowQuality}`
                    : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          {intel.references.length > 0 ? (
            <div className="stock-analysis-reference-list">
              <strong>{t('stock.9cc2ec76')}</strong>
              <ol>
                {intel.references.map((item, index) => (
                  <li key={`${item.title}-${index}`}>
                    <div className="stock-analysis-task-header">
                      <span>
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </span>
                      <span className="stock-analysis-subtle">
                        {item.source}
                        {item.publishedAt ? ` · ${item.publishedAt}` : ''}
                      </span>
                    </div>
                    <p className="stock-analysis-subtle">{item.summary}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {evidence.length > 0 ? (
            <div className="stock-analysis-reference-list">
              <strong>{t('stock.cb243824')}</strong>
              <ol>
                {evidence.map((item, index) => (
                  <li key={`${item.title}-${item.sourceType}-${index}`}>
                    <div className="stock-analysis-task-header">
                      <span>
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </span>
                      <span className="stock-analysis-subtle">
                        {item.includedInSummary
                          ? t('stock.status.included')
                          : `${t('stock.evidence.dropped')} · ${formatEvidenceDropReason(item.dropReason)}`}
                      </span>
                    </div>
                    <p className="stock-analysis-subtle">
                      {item.source}
                      {item.publishedAt
                        ? ` · ${item.publishedAt}`
                        : ` · ${t('stock.evidence.missingDate')}`}
                      {item.freshnessScore !== null
                        ? ` · ${t('stock.evidence.freshness')} ${item.freshnessScore}`
                        : ''}
                      {item.qualityScore !== null
                        ? ` · ${t('stock.evidence.quality')} ${item.qualityScore}`
                        : ''}
                    </p>
                    <p className="stock-analysis-subtle">{item.summary}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {intel.references.length === 0 && evidence.length === 0 ? (
            <div className="stock-analysis-empty-state">
              <p>{t('stock.eea4824a')}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StockAnalysisFactorCard({ report }: { report: StockAnalysisReport }) {
  const { t } = useTranslation('stock');
  return (
    <div className="stock-analysis-detail-card">
      <h4>{t('stock.9177a6e2')}</h4>
      <div className="stock-analysis-factor-list">
        {report.details.factorScores.map((item) => (
          <div key={item.key} className="stock-analysis-factor-item">
            <div className="stock-analysis-task-header">
              <strong>{item.title}</strong>
              <span
                className={`score-pill ${resolveFactorSignalTone(item.signal)}`}
              >
                {item.score}/{item.maxScore}
              </span>
            </div>
            <p className="stock-analysis-subtle">{item.summary}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function StockAnalysisTradePlanCard({
  report,
}: {
  report: StockAnalysisReport;
}) {
  const { t } = useTranslation('stock');
  const tradePlan = report.details.tradePlan;
  return (
    <div className="stock-analysis-detail-card">
      <h4>{t('stock.0065443d')}</h4>
      <dl>
        <div>
          <dt>{t('stock.91fdff46')}</dt>
          <dd>{formatMaybeNumber(tradePlan.idealBuy)}</dd>
        </div>
        <div>
          <dt>{t('stock.6e7c0ac7')}</dt>
          <dd>{formatMaybeNumber(tradePlan.secondaryBuy)}</dd>
        </div>
        <div>
          <dt>{t('stock.22b90fc9')}</dt>
          <dd>{formatMaybeNumber(tradePlan.stopLoss)}</dd>
        </div>
        <div>
          <dt>{t('stock.c9f603b5')}</dt>
          <dd>{formatMaybeNumber(tradePlan.takeProfit)}</dd>
        </div>
        <div>
          <dt>{t('stock.ab2950b4')}</dt>
          <dd>{tradePlan.style}</dd>
        </div>
      </dl>
    </div>
  );
}

function StockAnalysisValidationCard({
  validation,
}: {
  validation: StockAnalysisReportValidation | null;
}) {
  const { t } = useTranslation('stock');
  if (!validation) {
    return (
      <div className="stock-analysis-detail-card">
        <h4>{t('stock.d4485787')}</h4>
        <p className="stock-analysis-subtle">{t('stock.9f5d857b')}</p>
      </div>
    );
  }

  return (
    <div className="stock-analysis-detail-card">
      <div className="stock-analysis-task-header">
        <h4>{t('stock.d4485787')}</h4>
        <span className={`score-pill ${resolveValidationTone(validation)}`}>
          {formatValidationVerdict(validation.verdict)}
        </span>
      </div>
      <p className="stock-analysis-report-copy">{validation.summary}</p>
      <div className="stock-analysis-meta-strip compact">
        <span className="stock-analysis-meta-chip subtle">
          {t('stock.feeb06ee')} {formatDateOnly(validation.targetDate)}
        </span>
        <span className="stock-analysis-meta-chip subtle">
          {t('stock.365d9951')} {formatDateOnly(validation.nextTradingDate)}
        </span>
        <span className="stock-analysis-meta-chip subtle">
          {t('stock.e11d044e')} {validation.matchScore ?? '-'}
        </span>
      </div>
      <div className="stock-analysis-report-grid">
        <div>
          <strong>{t('stock.ccc675ce')}</strong>
          <p
            className={
              (validation.nextDayReturnPct || 0) >= 0
                ? 'delta-up'
                : 'delta-down'
            }
          >
            {formatMaybePercent(validation.nextDayReturnPct)}
          </p>
        </div>
        <div>
          <strong>{t('stock.89faf8c8')}</strong>
          <p>{formatMaybeNumber(validation.nextDayClose)}</p>
        </div>
      </div>
      <ul className="stock-analysis-feedback-notes">
        {validation.reasons.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function StockAnalysisOptionTabs<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <div className="stock-analysis-filter-group">
      <span className="stock-analysis-subtle">{label}</span>
      <div className="stock-analysis-tabs stock-analysis-tabs-compact stock-analysis-filter-tabs">
        {options.map((option) => (
          <button
            key={option.value}
            className={`stock-analysis-tab ${value === option.value ? 'active' : ''}`}
            type="button"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StockAnalysisFeedbackCard({
  feedback,
  onSelectReport,
}: {
  feedback: StockAnalysisFeedbackSnapshot | null;
  onSelectReport: (reportId: string) => void;
}) {
  const { t } = useTranslation('stock');
  const [feedbackView, setFeedbackView] =
    useState<StockAnalysisFeedbackView>('strategies');
  const [strategySort, setStrategySort] =
    useState<StockAnalysisFeedbackStrategySort>('sample-desc');
  const [minSample, setMinSample] =
    useState<StockAnalysisFeedbackMinSample>('all');
  const [evaluationSort, setEvaluationSort] =
    useState<StockAnalysisFeedbackEvaluationSort>('latest');
  const [outcomeFilter, setOutcomeFilter] =
    useState<StockAnalysisFeedbackOutcomeFilter>('all');

  if (!feedback) {
    return (
      <div className="stock-analysis-detail-card">
        <h4>{t('stock.4f53fca8')}</h4>
        <p className="stock-analysis-subtle">
          {t('stock.43ea1452')}
        </p>
      </div>
    );
  }

  const minSampleSize = minSample === 'all' ? 0 : Number(minSample);
  const sortedStrategies = feedback.strategies
    .filter((item) => item.evaluatedCount >= minSampleSize)
    .sort((left, right) => {
      if (strategySort === 'winrate-desc') {
        return (
          (right.bullishWinRate || -Infinity) -
          (left.bullishWinRate || -Infinity)
        );
      }
      if (strategySort === 'return-desc') {
        return (
          (right.avgReturnPct || -Infinity) - (left.avgReturnPct || -Infinity)
        );
      }
      return right.evaluatedCount - left.evaluatedCount;
    });
  const filteredEvaluations = feedback.recentEvaluations
    .filter((item) => outcomeFilter === 'all' || item.outcome === outcomeFilter)
    .sort((left, right) => {
      if (evaluationSort === 'return-desc') {
        return right.realizedReturnPct - left.realizedReturnPct;
      }
      return (
        new Date(right.evaluationCreatedAt).getTime() -
        new Date(left.evaluationCreatedAt).getTime()
      );
    });
  const hasStrategyFilters =
    strategySort !== 'sample-desc' || minSample !== 'all';
  const hasEvaluationFilters =
    outcomeFilter !== 'all' || evaluationSort !== 'latest';

  return (
    <div className="stock-analysis-detail-card">
      <div className="stock-analysis-task-header">
        <h4>{t('stock.4f53fca8')}</h4>
        <span className="stock-analysis-meta-chip subtle">
          {feedback.lookaheadDays} {t('stock.2f126da6')}
        </span>
      </div>
      <div className="stock-analysis-report-grid">
        <div>
          <strong>{t('stock.98e8c00f')}</strong>
          <p>{feedback.summary.sampleSize}</p>
        </div>
        <div>
          <strong>{t('stock.aaf3eaaa')}</strong>
          <p>{feedback.summary.evaluatedCount}</p>
        </div>
        <div>
          <strong>{t('stock.6647a9a0')}</strong>
          <p>{formatMaybePercent(feedback.summary.bullishWinRate)}</p>
        </div>
        <div>
          <strong>{t('stock.daf783c8')}</strong>
          <p
            className={
              (feedback.summary.avgReturnPct || 0) >= 0
                ? 'delta-up'
                : 'delta-down'
            }
          >
            {formatMaybePercent(feedback.summary.avgReturnPct)}
          </p>
        </div>
      </div>
      <div className="stock-analysis-tabs stock-analysis-tabs-compact">
        <button
          className={`stock-analysis-tab ${
            feedbackView === 'strategies' ? 'active' : ''
          }`}
          type="button"
          onClick={() => setFeedbackView('strategies')}
        >
          {t('stock.65ca09fb')}
        </button>
        <button
          className={`stock-analysis-tab ${
            feedbackView === 'evaluations' ? 'active' : ''
          }`}
          type="button"
          onClick={() => setFeedbackView('evaluations')}
        >
          {t('stock.5274779b')}
        </button>
        <button
          className={`stock-analysis-tab ${
            feedbackView === 'notes' ? 'active' : ''
          }`}
          type="button"
          onClick={() => setFeedbackView('notes')}
        >
          {t('stock.5f304595')}
        </button>
      </div>
      {feedbackView === 'strategies' ? (
        <>
          <div className="stock-analysis-inline-actions stock-analysis-section-toolbar">
            <span className="stock-analysis-subtle">
              {t('stock.cfcc3d85')}
            </span>
            <div className="stock-analysis-filter-strip">
              <StockAnalysisOptionTabs
                label={t("stock.c360e994")}
                value={strategySort}
                options={[
                  { value: 'sample-desc', label: t('stock.feedbackSort.sampleDesc') },
                  { value: 'winrate-desc', label: t('stock.feedbackSort.winrateDesc') },
                  { value: 'return-desc', label: t('stock.feedbackSort.returnDesc') },
                ]}
                onChange={setStrategySort}
              />
              <StockAnalysisOptionTabs
                label={t("stock.2f698b5e")}
                value={minSample}
                options={[
                  { value: 'all', label: t('stock.filter.all') },
                  { value: '5', label: '5+' },
                  { value: '10', label: '10+' },
                  { value: '20', label: '20+' },
                ]}
                onChange={setMinSample}
              />
              {hasStrategyFilters ? (
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => {
                    setStrategySort('sample-desc');
                    setMinSample('all');
                  }}
                >
                  {t('stock.4b9c3271')}
                </button>
              ) : null}
            </div>
          </div>
          <div className="stock-analysis-meta-strip compact">
            <span className="stock-analysis-meta-chip subtle">
              {t('stock.c9314034')} {sortedStrategies.length} {t('stock.66914536')}
            </span>
            {minSample !== 'all' ? (
              <span className="stock-analysis-meta-chip subtle">
                {t('stock.ceca3749')} {minSample}+
              </span>
            ) : null}
          </div>
          {sortedStrategies.length > 0 ? (
            <div className="stock-analysis-feedback-list">
              {sortedStrategies.map((item) => (
                <div
                  key={item.strategy.cacheKey}
                  className="stock-analysis-feedback-item"
                >
                  <div className="stock-analysis-task-header">
                    <strong>{item.strategy.label}</strong>
                    <span className="stock-analysis-subtle">
                      {t('stock.98e8c00f')} {item.evaluatedCount}/{item.sampleSize}
                    </span>
                  </div>
                  <p className="stock-analysis-subtle">
                    {item.strategy.tuningNotes.join('；') ||
                      item.strategy.description}
                  </p>
                  <div className="stock-analysis-meta-strip compact">
                    <span className="stock-analysis-meta-chip subtle">
                      {t('stock.6647a9a0')} {formatMaybePercent(item.bullishWinRate)}
                    </span>
                    <span
                      className={`stock-analysis-meta-chip ${
                        (item.avgReturnPct || 0) >= 0 ? 'fresh' : 'cached'
                      }`}
                    >
                      {t('stock.daf783c8')} {formatMaybePercent(item.avgReturnPct)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="stock-analysis-empty-state">
              <p>{t('stock.084bad85')}</p>
            </div>
          )}
        </>
      ) : null}
      {feedbackView === 'evaluations' ? (
        feedback.recentEvaluations.length > 0 ? (
          <>
            <div className="stock-analysis-inline-actions stock-analysis-section-toolbar">
              <span className="stock-analysis-subtle">
                {t('stock.6143ac08')}
              </span>
              <div className="stock-analysis-filter-strip">
                <StockAnalysisOptionTabs
                  label={t("stock.5ad7f5a8")}
                  value={outcomeFilter}
                  options={[
                    { value: 'all', label: t('stock.filter.all') },
                    { value: 'win', label: t('stock.feedbackOutcome.win') },
                    { value: 'flat', label: t('stock.feedbackOutcome.flat') },
                    { value: 'loss', label: t('stock.feedbackOutcome.loss') },
                  ]}
                  onChange={setOutcomeFilter}
                />
                <StockAnalysisOptionTabs
                  label={t("stock.c360e994")}
                  value={evaluationSort}
                  options={[
                    { value: 'latest', label: t('stock.feedbackEvalSort.latest') },
                    { value: 'return-desc', label: t('stock.feedbackEvalSort.returnDesc') },
                  ]}
                  onChange={setEvaluationSort}
                />
                {hasEvaluationFilters ? (
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => {
                      setOutcomeFilter('all');
                      setEvaluationSort('latest');
                    }}
                  >
                    {t('stock.4b9c3271')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="stock-analysis-meta-strip compact">
              <span className="stock-analysis-meta-chip subtle">
                {t('stock.c9314034')} {filteredEvaluations.length} {t('stock.1b696453')}
              </span>
              {outcomeFilter !== 'all' ? (
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.5ad7f5a8')} {formatOutcomeLabel(outcomeFilter)}
                </span>
              ) : null}
            </div>
            {filteredEvaluations.length > 0 ? (
              <div className="stock-analysis-reference-list">
                <strong>{t('stock.5274779b')}</strong>
                <ol>
                  {filteredEvaluations.map((item) => (
                    <li key={item.reportId}>
                      <button
                        type="button"
                        className="stock-analysis-feedback-link"
                        onClick={() => onSelectReport(item.reportId)}
                      >
                        {item.stockName}({item.stockCode}) ·{' '}
                        {item.strategy.label}
                      </button>
                      <div className="stock-analysis-meta-strip compact">
                        <span
                          className={`score-pill ${resolveFeedbackOutcomeTone(item.outcome)}`}
                        >
                          {formatOutcomeLabel(item.outcome)}
                        </span>
                        <span className="stock-analysis-meta-chip subtle">
                          {item.holdingDays} {t('stock.17fbc240')}
                        </span>
                        <span className="stock-analysis-meta-chip subtle">
                          {formatDateOnly(item.evaluationCreatedAt)}
                        </span>
                        <span
                          className={
                            item.realizedReturnPct >= 0
                              ? 'delta-up'
                              : 'delta-down'
                          }
                        >
                          {formatMaybePercent(item.realizedReturnPct)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : (
              <div className="stock-analysis-empty-state">
                <p>{t('stock.0dce2eea')}</p>
              </div>
            )}
          </>
        ) : (
          <div className="stock-analysis-empty-state">
            <p>{t('stock.2f5c7472')}</p>
          </div>
        )
      ) : null}
      {feedbackView === 'notes' ? (
        <ul className="stock-analysis-feedback-notes">
          {feedback.notes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StockAnalysisTaskCard({
  task,
  onSelectHistory,
  onRetry,
  retrying,
  extraActions,
}: {
  task: StockAnalysisTask;
  onSelectHistory: (reportId: string) => void;
  onRetry?: (task: StockAnalysisTask) => void;
  retrying?: boolean;
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation('stock');
  return (
    <div className="stock-analysis-task-card">
      <div className="stock-analysis-task-header">
        <div>
          <strong>
            {task.stockName || task.stockCode}
            <span className="stock-analysis-subtle">
              {' '}
              {formatMarket(task.market)}
            </span>
          </strong>
          <div className="stock-analysis-subtle">
            {task.stockCode} · {task.reportType}
          </div>
          <div className="stock-analysis-meta-strip compact">
            <span
              className={`stock-analysis-meta-chip ${
                resolveCacheStatus(task).tone
              }`}
            >
              {resolveCacheStatus(task).label}
            </span>
            <span className="stock-analysis-meta-chip subtle">
              {formatDateTime(task.completedAt || task.createdAt)}
            </span>
            <span className="stock-analysis-meta-chip subtle">
              {describeFreshness(task.dataAsOf || task.completedAt)}
            </span>
          </div>
        </div>
        <span className={`task-status-badge ${task.status}`}>
          {formatTaskStatus(task.status)}
        </span>
      </div>
      <div className="stock-analysis-task-progress">
        <div
          className="stock-analysis-task-progress-fill"
          style={{ width: `${deriveTaskProgress(task.status)}%` }}
        />
      </div>
      <div className="stock-analysis-task-footer">
        <span>{describeTaskStatus(task)}</span>
        <div className="stock-analysis-task-actions">
          {extraActions}
          {task.status === 'failed' && onRetry ? (
            <button
              className="btn-outline btn-sm"
              type="button"
              onClick={() => onRetry(task)}
              disabled={retrying}
            >
              {retrying ? t('stock.btn.submitting') : t('stock.action.retry')}
            </button>
          ) : null}
          {task.reportId ? (
            <button
              className="btn-outline btn-sm"
              type="button"
              onClick={() => onSelectHistory(task.reportId || '')}
            >
              {t('stock.25934145')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StockAnalysisDecisionDashboardCard({
  dashboard,
}: {
  dashboard: StockAnalysisDecisionDashboard | null;
}) {
  const { t } = useTranslation('stock');
  if (!dashboard) {
    return (
      <div className="stock-analysis-detail-card">
        <h4>{t('stock.77771e60')}</h4>
        <p className="stock-analysis-subtle">{t('stock.64c83053')}</p>
      </div>
    );
  }

  return (
    <div className="stock-analysis-detail-card">
      <div className="stock-analysis-task-header">
        <h4>{t('stock.77771e60')}</h4>
        <span
          className={`stock-analysis-meta-chip ${
            dashboard.signal === 'green'
              ? 'fresh'
              : dashboard.signal === 'red'
                ? 'cached'
                : 'subtle'
          }`}
        >
          {dashboard.verdict}
        </span>
      </div>
      <dl>
        <div>
          <dt>{t('stock.a839d2c0')}</dt>
          <dd>{formatTrend(dashboard.keyMetrics.trendState)}</dd>
        </div>
        <div>
          <dt>{t('stock.c2da1574')}</dt>
          <dd>{dashboard.keyMetrics.volumeState}</dd>
        </div>
        <div>
          <dt>MA {t('stock.c4428b58')}</dt>
          <dd>{dashboard.keyMetrics.maAligned ? t('stock.pattern.bullishAlignment') : t('stock.pattern.notFormed')}</dd>
        </div>
        <div>
          <dt>MACD / RSI</dt>
          <dd>
            {dashboard.keyMetrics.macdState} / {dashboard.keyMetrics.rsiState}
          </dd>
        </div>
      </dl>
      {dashboard.factorChart.length ? (
        <div className="stock-analysis-factor-list">
          {dashboard.factorChart.slice(0, 4).map((item) => (
            <div key={item.key} className="stock-analysis-factor-item">
              <div className="stock-analysis-task-header">
                <strong>{item.title}</strong>
                <span className="stock-analysis-meta-chip subtle">
                  {item.score}/{item.maxScore}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StockAnalysisPage({ apiBase }: StockAnalysisPageProps) {
  const { t } = useTranslation('stock');
  const location = useLocation();
  const navigate = useNavigate();
  const routeReportId = useMemo(
    () => resolveRouteReportId(location.pathname),
    [location.pathname],
  );
  const hydratedRouteReportIdRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useNavigatedTab<StockAnalysisTab>('stock-analysis', VALID_STOCK_TABS, 'workbench');
  const [historyView, setHistoryView] =
    useState<StockAnalysisHistoryView>('reports');
  const [historyListMode, setHistoryListMode] =
    useState<StockAnalysisHistoryListMode>('grouped');
  const [overviewSection, setOverviewSection] =
    useState<StockAnalysisOverviewSection>('core');
  const [detailView, setDetailView] =
    useState<StockAnalysisDetailView>('overview');
  const [marketView, setMarketView] =
    useState<StockAnalysisMarketView>('review');
  const [codeInput, setCodeInput] = useState('600519\n00700');
  const [marketScope, setMarketScope] = useState<StockMarketScope>('both');
  const [reviewScope, setReviewScope] = useState<StockMarketScope>('both');
  const [reportType, setReportType] =
    useState<StockAnalysisReportType>('standard');
  const [strategyPreset, setStrategyPreset] =
    useState<StockAnalysisStrategyPreset>('bull_trend');
  const [forceRefresh, setForceRefresh] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  const [presetTitleInput, setPresetTitleInput] = useState('');
  const [pickerMinScore, setPickerMinScore] = useState(65);
  const [pickerTrend, setPickerTrend] = useState<'all' | 'bullish' | 'neutral'>(
    'bullish',
  );
  const [pickerRecommendation, setPickerRecommendation] = useState<
    'all' | '偏强跟踪' | '继续观察'
  >('all');
  const [pickerFreshnessDays, setPickerFreshnessDays] = useState(10);
  const [historySearch, setHistorySearch] = useState('');
  const [historyMarketFilter, setHistoryMarketFilter] = useState<
    'all' | StockAnalysisHistoryItem['market']
  >('all');
  const [historyDateRange, setHistoryDateRange] =
    useState<StockAnalysisHistoryDateRange>('90d');
  const [historyGroupSort, setHistoryGroupSort] =
    useState<StockAnalysisHistoryGroupSort>('latest');
  const [historySortMode, setHistorySortMode] =
    useState<HistorySortMode>('latest');
  const [recentResultMarketFilter, setRecentResultMarketFilter] = useState<
    'all' | StockAnalysisTask['market']
  >('all');
  const [recentResultModeFilter, setRecentResultModeFilter] =
    useState<StockAnalysisRecentResultMode>('all');
  const [hiddenFailedTaskIds, setHiddenFailedTaskIds] = useState<string[]>([]);
  const [expandedHistoryGroups, setExpandedHistoryGroups] = useState<string[]>(
    [],
  );
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isMobileReportModalOpen, setIsMobileReportModalOpen] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [backtestDraft, setBacktestDraft] =
    useState<StockAnalysisBacktestRequest>({});
  const [backtestResult, setBacktestResult] =
    useState<StockAnalysisBacktestResult | null>(null);
  const [runningBacktest, setRunningBacktest] = useState(false);

  const handleBootstrapError = useCallback((message: string) => {
    setPageError(message);
  }, []);
  const handleConfigHydrated = useCallback(
    (nextConfig: StockAnalysisConfigMap) => {
      const nextMarketScope = resolveConfigMarketScope(
        nextConfig.defaultMarketScope,
      );
      if (nextMarketScope) {
        setMarketScope(nextMarketScope);
      }
      const nextReviewScope = resolveConfigMarketScope(
        nextConfig.marketReviewScope,
      );
      if (nextReviewScope) {
        setReviewScope(nextReviewScope);
      }
      const nextReportType = resolveConfigReportType(
        nextConfig.defaultReportType,
      );
      if (nextReportType) {
        setReportType(nextReportType);
      }
      const nextStrategyPreset = resolveConfigStrategyPreset(
        nextConfig.defaultStrategyPreset,
      );
      if (nextStrategyPreset) {
        setStrategyPreset(nextStrategyPreset);
      }
      setPickerMinScore(resolveConfigNumber(nextConfig.pickerMinScore, 65));
      setPickerFreshnessDays(
        resolveConfigNumber(nextConfig.pickerFreshnessDays, 10),
      );
    },
    [],
  );
  const {
    activeTasks,
    addWatchlist,
    builtinConfigPresets,
    clearSelectedReport,
    config,
    configDefaults,
    configMeta,
    configUpdatedAt,
    configVersion,
    customConfigPresets,
    dataProviderReport,
    deleteConfigPreset,
    deletingPresetId,
    feedback,
    history,
    historyLimit,
    historyOffset,
    historyTotal,
    loadReportDetail,
    loadingMoreHistory,
    loadingReview,
    refreshAfterAnalyze,
    recentTaskResults,
    deleteTaskResult,
    deletingTaskId,
    clearFailedTaskResults,
    clearingFailedTasks,
    removeWatchlist,
    retryTask,
    retryingTaskId,
    review,
    runReview,
    savedConfig,
    saveConfig,
    saveConfigPreset,
    savingConfig,
    savingPreset,
    selectedDashboard,
    selectedReport,
    selectedValidation,
    setConfig,
    setHistoryPage,
    setHistoryPageSize,
    taskStreamConnected,
    updatingWatchlist,
    watchlist,
  } = useStockAnalysisRemoteData({
    apiBase,
    reviewScope,
    urlReportId: routeReportId,
    onBootstrapError: handleBootstrapError,
    onConfigHydrated: handleConfigHydrated,
  });

  const codes = useMemo(() => splitStockCodes(codeInput), [codeInput]);
  const forceRefreshHint = useMemo(
    () => formatCacheHint(config.reportCacheTtlMinutes),
    [config.reportCacheTtlMinutes],
  );
  const reviewGeneratedAt = review ? resolveGeneratedAt(review) : null;
  const reviewDataAsOf = resolveMarketReviewDataAsOf(review);
  const reportCacheStatus = selectedReport
    ? resolveCacheStatus(selectedReport)
    : null;
  const reviewSentimentClass = resolveReviewSentimentClass(
    review?.summary.stance,
  );
  const allConfigPresets = useMemo(
    () => [...builtinConfigPresets, ...customConfigPresets],
    [builtinConfigPresets, customConfigPresets],
  );
  const analysisMarketOptions = useMemo(
    () =>
      resolveSelectOptions(
        configMeta,
        'defaultMarketScope',
        getDefaultMarketScopeOptions(t),
      ),
    [configMeta, t],
  );
  const reviewMarketOptions = useMemo(
    () =>
      resolveSelectOptions(
        configMeta,
        'marketReviewScope',
        getDefaultMarketScopeOptions(t),
      ),
    [configMeta, t],
  );
  const reportTypeOptions = useMemo(
    () =>
      resolveSelectOptions(
        configMeta,
        'defaultReportType',
        getDefaultReportTypeOptions(t),
      ),
    [configMeta, t],
  );
  const strategyOptions = useMemo(
    () =>
      resolveSelectOptions(
        configMeta,
        'defaultStrategyPreset',
        getDefaultStrategyOptions(t),
      ),
    [configMeta, t],
  );
  const configDirtyKeys = useMemo(
    () => resolveConfigDiffKeys(config, savedConfig),
    [config, savedConfig],
  );
  const activeConfigPreset = useMemo(
    () => resolveMatchingPreset(config, allConfigPresets),
    [config, allConfigPresets],
  );
  const isConfigDirty = configDirtyKeys.length > 0;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => setIsCompactLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!routeReportId) {
      hydratedRouteReportIdRef.current = null;
      return undefined;
    }

    if (selectedReport?.id === routeReportId) {
      hydratedRouteReportIdRef.current = routeReportId;
      setHistoryView('reports');
      if (isCompactLayout) {
        setIsMobileReportModalOpen(true);
      }
      return undefined;
    }

    if (hydratedRouteReportIdRef.current === routeReportId) {
      return undefined;
    }

    let cancelled = false;
    hydratedRouteReportIdRef.current = routeReportId;
    void loadReportDetail(routeReportId)
      .then((detail) => {
        if (cancelled) return;
        setHistoryView('reports');
        setDetailView('overview');
        setOverviewSection('core');
        setIsMobileReportModalOpen(isCompactLayout);
        setExpandedHistoryGroups((current) =>
          current.includes(detail.stockCode)
            ? current
            : [...current, detail.stockCode],
        );
      })
      .catch((error) => {
        if (cancelled) return;
        hydratedRouteReportIdRef.current = null;
        setPageError(
          error instanceof Error ? error.message : t('stock.msg.loadReportFailed'),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    isCompactLayout,
    loadReportDetail,
    routeReportId,
    selectedReport?.id,
    t,
  ]);

  useEffect(() => {
    setBacktestDraft((current) => ({
      strategyPreset: current.strategyPreset || strategyPreset,
      stockCode:
        current.stockCode ??
        (selectedReport?.stockCode || watchlist[0]?.stockCode || ''),
      limit:
        current.limit ?? resolveConfigNumber(config.backtestMaxReports, 120),
      lookaheadDays:
        current.lookaheadDays ??
        resolveConfigNumber(config.backtestLookaheadDays, 10),
    }));
  }, [
    config.backtestLookaheadDays,
    config.backtestMaxReports,
    selectedReport?.stockCode,
    strategyPreset,
    watchlist,
  ]);

  useEffect(() => {
    if (!isCompactLayout) {
      setIsMobileReportModalOpen(false);
    }
  }, [isCompactLayout]);

  const latestHistoryByStock = useMemo(() => {
    const map = new Map<string, StockAnalysisHistoryItem>();
    const ordered = [...history].sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    );
    ordered.forEach((item) => {
      if (!map.has(item.stockCode)) {
        map.set(item.stockCode, item);
      }
    });
    return map;
  }, [history]);
  const stockPickerCandidates = useMemo(() => {
    const items: StockPickerCandidate[] = [];
    watchlist.forEach((item) => {
      const report = latestHistoryByStock.get(item.stockCode);
      if (!report) return;
      items.push({
        stockCode: item.stockCode,
        stockName: item.stockName,
        market: item.market,
        reportId: report.id,
        score: report.score,
        trend: report.trend,
        recommendation: report.recommendation,
        dataAsOf: report.dataAsOf,
        createdAt: report.createdAt,
      });
    });
    return items
      .filter((item) => item.score >= pickerMinScore)
      .filter((item) => pickerTrend === 'all' || item.trend === pickerTrend)
      .filter(
        (item) =>
          pickerRecommendation === 'all' ||
          item.recommendation === pickerRecommendation,
      )
      .filter((item) =>
        matchesFreshnessWindow(
          item.dataAsOf || item.createdAt,
          pickerFreshnessDays,
        ),
      )
      .sort((left, right) => right.score - left.score);
  }, [
    latestHistoryByStock,
    pickerFreshnessDays,
    pickerMinScore,
    pickerRecommendation,
    pickerTrend,
    watchlist,
  ]);
  const filteredHistory = useMemo(() => {
    const keyword = historySearch.trim().toLowerCase();
    const items = history.filter((item) => {
      if (
        historyMarketFilter !== 'all' &&
        item.market !== historyMarketFilter
      ) {
        return false;
      }
      if (
        !matchesHistoryDateRange(
          item.dataAsOf || item.createdAt,
          historyDateRange,
        )
      ) {
        return false;
      }
      if (!keyword) return true;
      return (
        item.stockCode.toLowerCase().includes(keyword) ||
        item.stockName.toLowerCase().includes(keyword)
      );
    });
    const ordered = [...items];
    ordered.sort((left, right) => {
      if (historySortMode === 'score-desc') return right.score - left.score;
      if (historySortMode === 'score-asc') return left.score - right.score;
      if (historySortMode === 'change-desc') {
        return (right.changePct || -Infinity) - (left.changePct || -Infinity);
      }
      if (historySortMode === 'change-asc') {
        return (left.changePct || Infinity) - (right.changePct || Infinity);
      }
      return (
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );
    });
    return ordered;
  }, [
    history,
    historyDateRange,
    historyMarketFilter,
    historySearch,
    historySortMode,
  ]);
  const groupedHistory = useMemo(() => {
    const groups = new Map<
      string,
      {
        stockCode: string;
        stockName: string;
        market: StockAnalysisHistoryItem['market'];
        items: StockAnalysisHistoryItem[];
      }
    >();
    filteredHistory.forEach((item) => {
      const current = groups.get(item.stockCode);
      if (current) {
        current.items.push(item);
        return;
      }
      groups.set(item.stockCode, {
        stockCode: item.stockCode,
        stockName: item.stockName,
        market: item.market,
        items: [item],
      });
    });
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        latest: group.items[0],
        bestScore: Math.max(...group.items.map((item) => item.score)),
      }))
      .sort((left, right) => {
        if (historyGroupSort === 'score-desc') {
          return right.bestScore - left.bestScore;
        }
        if (historyGroupSort === 'count-desc') {
          return right.items.length - left.items.length;
        }
        return (
          new Date(resolveGeneratedAt(right.latest)).getTime() -
          new Date(resolveGeneratedAt(left.latest)).getTime()
        );
      });
  }, [filteredHistory, historyGroupSort]);
  const historyPage = Math.floor(historyOffset / historyLimit) + 1;
  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyLimit));
  const selectedReportHistoryIndex = useMemo(() => {
    if (!selectedReport) return -1;
    return filteredHistory.findIndex((item) => item.id === selectedReport.id);
  }, [filteredHistory, selectedReport]);
  const previousHistoryReport =
    selectedReportHistoryIndex > 0
      ? filteredHistory[selectedReportHistoryIndex - 1] || null
      : null;
  const nextHistoryReport =
    selectedReportHistoryIndex >= 0 &&
    selectedReportHistoryIndex < filteredHistory.length - 1
      ? filteredHistory[selectedReportHistoryIndex + 1] || null
      : null;
  const recentCompletedResults = useMemo(
    () => recentTaskResults.filter((task) => task.status === 'completed'),
    [recentTaskResults],
  );
  const filteredRecentCompletedResults = useMemo(
    () =>
      recentCompletedResults.filter((task) => {
        if (
          recentResultMarketFilter !== 'all' &&
          task.market !== recentResultMarketFilter
        ) {
          return false;
        }
        if (
          recentResultModeFilter !== 'all' &&
          (task.resultMode || 'generated') !== recentResultModeFilter
        ) {
          return false;
        }
        return true;
      }),
    [recentCompletedResults, recentResultMarketFilter, recentResultModeFilter],
  );
  const hasRecentResultFilters =
    recentResultMarketFilter !== 'all' || recentResultModeFilter !== 'all';
  const recentFailedResults = useMemo(
    () => recentTaskResults.filter((task) => task.status === 'failed'),
    [recentTaskResults],
  );
  const visibleFailedResults = useMemo(
    () =>
      recentFailedResults.filter(
        (task) => !hiddenFailedTaskIds.includes(task.id),
      ),
    [hiddenFailedTaskIds, recentFailedResults],
  );
  const hiddenFailedTaskCount =
    recentFailedResults.length - visibleFailedResults.length;
  const hasHistoryFilters =
    historySearch.trim().length > 0 ||
    historyMarketFilter !== 'all' ||
    historyDateRange !== '90d';
  const pendingTaskCount = activeTasks.filter(
    (task) => task.status === 'pending',
  ).length;
  const runningTaskCount = activeTasks.filter(
    (task) => task.status === 'running',
  ).length;
  const renderHistoryCard = (
    item: StockAnalysisHistoryItem,
    className?: string,
  ) => (
    <button
      key={item.id}
      className={`stock-analysis-history-card ${
        selectedReport?.id === item.id ? 'active' : ''
      } ${className || ''}`.trim()}
      type="button"
      onClick={() => handleSelectHistory(item.id)}
    >
      <div className="stock-analysis-task-header">
        <div>
          <strong>{item.stockName}</strong>
          <div className="stock-analysis-subtle">
            {item.stockCode} · {formatMarket(item.market)}
          </div>
          <div className="stock-analysis-history-summary">
            <span>{formatRecommendation(item.recommendation)}</span>
            <span>{formatTrend(item.trend)}</span>
            <span className="stock-analysis-subtle">
              {formatReportTypeLabel(item.reportType)}{t('stock.a5cd4ea1')}
            </span>
          </div>
          <div className="stock-analysis-history-caption">
            <span>{formatDateTime(resolveGeneratedAt(item))}</span>
            <span>{resolveCacheStatus(item).label}</span>
            <span>
              {item.historyDays || Number(config.historyDays) || 180}{t('stock.e7075785')}
            </span>
          </div>
          {item.reusedFromReportId ? (
            <div className="stock-analysis-history-caption">
              {t('stock.3f3c2b4b')} {item.reusedFromReportId}
            </div>
          ) : null}
        </div>
        <span
          className={`score-pill ${
            item.score >= 70 ? 'good' : item.score <= 45 ? 'bad' : 'neutral'
          }`}
        >
          {item.score}
        </span>
      </div>
      <div className="stock-analysis-history-meta">
        <span className="stock-analysis-meta-chip subtle">
          {selectedReport?.id === item.id ? t('stock.label.currentView') : t('stock.action.clickForDetails')}
        </span>
        <span
          className={(item.changePct || 0) >= 0 ? 'delta-up' : 'delta-down'}
        >
          {formatMaybePercent(item.changePct)}
        </span>
      </div>
    </button>
  );
  const submitAnalysis = async (input: {
    stockCodes: string[];
    marketScope: StockMarketScope;
    emptyMessage: string;
    syncInput?: boolean;
  }) => {
    if (input.stockCodes.length === 0) {
      setPageError(input.emptyMessage);
      return;
    }
    if (input.syncInput) {
      setCodeInput(input.stockCodes.join('\n'));
    }
    setMarketScope(input.marketScope);
    setActiveTab('workbench');
    setSubmitting(true);
    setPageError(null);
    try {
      const response = await analyzeStocks(apiBase, {
        marketScope: input.marketScope,
        stockCodes: input.stockCodes,
        reportType,
        strategyPreset,
        forceRefresh,
      });
      if (response.rejected.length > 0) {
        setPageError(formatRejectedItems(response.rejected));
      }
      await refreshAfterAnalyze();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAnalyze = async () => {
    await submitAnalysis({
      stockCodes: codes,
      marketScope,
      emptyMessage: t('stock.msg.enterStockCode'),
    });
  };

  const handleRetryTask = async (task: StockAnalysisTask) => {
    setPageError(null);
    try {
      const response = await retryTask(task.id);
      if (response.rejected.length > 0) {
        setPageError(formatRejectedItems(response.rejected));
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.retryFailed'));
    }
  };

  const handleHideFailedTask = (taskId: string) => {
    setHiddenFailedTaskIds((current) =>
      current.includes(taskId) ? current : [...current, taskId],
    );
  };

  const handleRestoreFailedTasks = () => {
    setHiddenFailedTaskIds([]);
  };

  const handleDeleteFailedTask = async (taskId: string) => {
    setPageError(null);
    try {
      await deleteTaskResult(taskId);
      setHiddenFailedTaskIds((current) =>
        current.filter((item) => item !== taskId),
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.deleteFailedRecordFailed'));
    }
  };

  const handleClearFailedTasks = async () => {
    setPageError(null);
    try {
      await clearFailedTaskResults();
      setHiddenFailedTaskIds([]);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.clearFailedRecordsFailed'));
    }
  };

  const handleToggleHistoryGroup = (stockCode: string) => {
    setExpandedHistoryGroups((current) =>
      current.includes(stockCode)
        ? current.filter((item) => item !== stockCode)
        : [...current, stockCode],
    );
  };

  const handleAddToWatchlist = async () => {
    if (codes.length === 0) {
      setPageError(t('stock.0a2d23b1'));
      return;
    }
    setPageError(null);
    setConfigMessage(null);
    try {
      const response = await addWatchlist({
        stockCodes: codes,
        marketScope,
      });
      if (response.items.length > 0) {
        setConfigMessage(
          response.rejected.length > 0
            ? t('stock.msg.addedToWatchlistPartial', { count: response.items.length, rejected: response.rejected.length })
            : t('stock.msg.addedToWatchlist', { count: response.items.length }),
        );
      } else {
        setConfigMessage(null);
      }
      if (response.rejected.length > 0) {
        setPageError(formatRejectedItems(response.rejected));
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.addToWatchlistFailed'));
    }
  };

  const handleRemoveWatchlistItem = async (stockCode: string) => {
    setPageError(null);
    try {
      await removeWatchlist(stockCode);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.removeFromWatchlistFailed'));
    }
  };

  const handleUseWatchlistItem = (item: StockAnalysisWatchlistItem) => {
    setCodeInput(item.stockCode);
    setMarketScope(item.market);
    setPageError(null);
    setActiveTab('workbench');
  };

  const handleAnalyzeWatchlistItem = async (
    item: StockAnalysisWatchlistItem,
  ) => {
    await submitAnalysis({
      stockCodes: [item.stockCode],
      marketScope: item.market,
      emptyMessage: t('stock.msg.watchlistEmpty'),
      syncInput: true,
    });
  };

  const handleAnalyzeWatchlist = async () => {
    await submitAnalysis({
      stockCodes: watchlist.map((item) => item.stockCode),
      marketScope: resolveWatchlistScope(watchlist),
      emptyMessage: t('stock.msg.watchlistStillEmpty'),
      syncInput: true,
    });
  };

  const handleUseStockPickerCandidates = () => {
    if (stockPickerCandidates.length === 0) {
      setPageError(t('stock.msg.noCandidateToBackfill'));
      return;
    }
    setPageError(null);
    setCodeInput(
      stockPickerCandidates.map((item) => item.stockCode).join('\n'),
    );
    setMarketScope(resolveItemMarketScope(stockPickerCandidates));
    setConfigMessage(t('stock.msg.backfilledCandidates', { count: stockPickerCandidates.length }));
    setActiveTab('workbench');
  };

  const handleAnalyzeStockPickerCandidates = async () => {
    await submitAnalysis({
      stockCodes: stockPickerCandidates.map((item) => item.stockCode),
      marketScope: resolveItemMarketScope(stockPickerCandidates),
      emptyMessage: t('stock.msg.noCandidateToAnalyze'),
      syncInput: true,
    });
  };

  const handleCloseReportDetail = useCallback(() => {
    setIsMobileReportModalOpen(false);
    clearSelectedReport();
    navigate(stockReportsPath(), { replace: true });
  }, [clearSelectedReport, navigate]);

  const handleSelectHistory = async (reportId: string) => {
    try {
      const detail = await loadReportDetail(reportId);
      navigate(stockReportsPath(detail.id));
      setHistoryView('reports');
      setDetailView('overview');
      setOverviewSection('core');
      setIsMobileReportModalOpen(isCompactLayout);
      setExpandedHistoryGroups((current) =>
        current.includes(detail.stockCode)
          ? current
          : [...current, detail.stockCode],
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.loadReportFailed'));
    }
  };

  const handleHistoryPageChange = async (page: number) => {
    if (page < 1 || page > historyTotalPages) {
      return;
    }
    try {
      await setHistoryPage(page);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.switchPageFailed'));
    }
  };

  const handleHistoryPageSizeChange = async (pageSize: number) => {
    try {
      await setHistoryPageSize(pageSize);
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : t('stock.msg.switchPageSizeFailed'),
      );
    }
  };

  const handleRunReview = async () => {
    setPageError(null);
    try {
      await runReview();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.generateReviewFailed'));
    }
  };

  const handleConfigChange = (
    key: string,
    value: string | number | boolean,
  ) => {
    setConfigMessage(null);
    setConfig((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleApplyConfigPreset = (preset: StockAnalysisConfigPreset) => {
    setPageError(null);
    setConfigMessage(t('stock.msg.presetApplied', { title: preset.title }));
    setConfig({ ...preset.values });
    if (preset.kind === 'custom') {
      setPresetTitleInput(preset.title);
    }
  };

  const handleResetConfigDraft = () => {
    setPageError(null);
    setConfigMessage(t('stock.msg.configRestored'));
    setConfig({ ...savedConfig });
  };

  const handleResetConfigDefaults = () => {
    setPageError(null);
    setConfigMessage(t('stock.msg.configDefaultRestored'));
    setConfig({ ...configDefaults });
  };

  const handleSaveConfigPreset = async () => {
    const title = presetTitleInput.trim();
    if (!title) {
      setPageError(t('stock.eabd7b74'));
      return;
    }
    setPageError(null);
    try {
      const response = await saveConfigPreset({
        id:
          activeConfigPreset?.kind === 'custom' &&
          activeConfigPreset.title === title
            ? activeConfigPreset.id
            : undefined,
        title,
        config,
      });
      setPresetTitleInput(response.preset.title);
      setConfigMessage(t('stock.msg.presetSaved', { title: response.preset.title }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.savePresetFailed'));
    }
  };

  const handleDeleteConfigPreset = async (
    preset: StockAnalysisConfigPreset,
  ) => {
    setPageError(null);
    try {
      await deleteConfigPreset(preset.id);
      if (activeConfigPreset?.id === preset.id) {
        setPresetTitleInput('');
      }
      setConfigMessage(t('stock.msg.presetDeleted', { title: preset.title }));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.deletePresetFailed'));
    }
  };

  const handleSaveConfig = async () => {
    setPageError(null);
    try {
      await saveConfig({
        configVersion,
        config,
      });
      setConfigMessage(t('stock.1c9e1c25'));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.saveConfigFailed'));
    }
  };

  const handleRefillSelectedReport = () => {
    if (!selectedReport) return;
    setCodeInput(selectedReport.stockCode);
    setMarketScope(selectedReport.market);
    setActiveTab('workbench');
    setPageError(null);
  };

  const handleReanalyzeSelectedReport = async () => {
    if (!selectedReport) return;
    await submitAnalysis({
      stockCodes: [selectedReport.stockCode],
      marketScope: selectedReport.market,
      emptyMessage: t('stock.msg.noStockToReanalyze'),
      syncInput: true,
    });
  };

  const handleRunBacktest = async () => {
    setPageError(null);
    setRunningBacktest(true);
    try {
      const result = await runBacktestAnalysis(apiBase, {
        strategyPreset: backtestDraft.strategyPreset,
        stockCode: backtestDraft.stockCode?.trim() || undefined,
        limit: backtestDraft.limit,
        lookaheadDays: backtestDraft.lookaheadDays,
      });
      setBacktestResult(result);
      setMarketView('backtest');
      setActiveTab('market');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : t('stock.msg.backtestFailed'));
    } finally {
      setRunningBacktest(false);
    }
  };

  const workflowTabs: Array<{
    key: StockAnalysisTab;
    label: string;
    summary: string;
  }> = [
    {
      key: 'workbench',
      label: t('stock.tab.workbench'),
      summary: t('stock.workbench.codesToAnalyze', {
        count: codes.length,
        running: runningTaskCount,
        pending: pendingTaskCount,
      }),
    },
    {
      key: 'reports',
      label: t('stock.tab.reports'),
      summary: `${t('stock.reports.historyTotal', { count: historyTotal })} · ${
        selectedReport
          ? `${t('stock.label.currentView')} ${selectedReport.stockCode}`
          : t('stock.reports.waitingSelect')
      }`,
    },
    {
      key: 'market',
      label: t('stock.tab.market'),
      summary: review
        ? `${review.summary.stance} · ${review.summary.headline}`
        : backtestResult
          ? t('stock.market.backtestSamples', { count: backtestResult.totalTrades })
          : t('stock.market.waitingReview'),
    },
    {
      key: 'portfolio',
      label: t('stock.tab.portfolio'),
      summary:
        stockPickerCandidates.length > 0
          ? t('stock.workbench.watchlistItems', { count: watchlist.length, candidates: stockPickerCandidates.length })
          : t('stock.workbench.watchlistWaiting', { count: watchlist.length }),
    },
  ];

  const stockAnalysisSummaryCards = [
    {
      label: t('stock.tab.workbench'),
      value: t('stock.workbench.codesCount', { count: codes.length }),
      detail:
        codes.length > 0
          ? t('stock.msg.enterCodeToAnalyze')
          : t('stock.workbench.inputToStart'),
    },
    {
      label: t('stock.tab.portfolio'),
      value: t('stock.workbench.watchlistCount', { count: watchlist.length }),
      detail:
        stockPickerCandidates.length > 0
          ? t('stock.workbench.candidateHit', { count: stockPickerCandidates.length })
          : t('stock.workbench.watchlistManage'),
    },
    {
      label: t('stock.tab.reports'),
      value: t('stock.reports.historyTotal', { count: historyTotal }),
      detail:
        recentFailedResults.length > 0
          ? t('stock.reports.failedPending', { count: recentFailedResults.length })
          : t('stock.workbench.historyManage'),
    },
    {
      label: t('stock.tab.market'),
      value: review?.summary.stance || t('stock.stance.notReviewed'),
      detail: selectedReport
        ? `${t('stock.label.currentView')} ${selectedReport.stockName}`
        : backtestResult
          ? t('stock.market.backtestSamples', { count: backtestResult.totalTrades })
          : t('stock.market.reviewBacktestStatus'),
    },
  ];
  const reviewPreviewIndices = review?.detail.indices.slice(0, 2) ?? [];
  const reportExecutiveSummary = selectedReport
    ? [
        {
          label: t('stock.section.advice'),
          value: formatRecommendation(selectedReport.recommendation),
          detail: selectedReport.summary.operationAdvice,
        },
        {
          label: t('stock.section.signals'),
          value:
            selectedDashboard?.verdict || formatTrend(selectedReport.trend),
          detail: `${t('stock.4bcb44ce')} ${selectedReport.score} · ${selectedReport.strategy.label}`,
        },
        {
          label: t('stock.label.validationStatus'),
          value: selectedValidation
            ? formatValidationVerdict(selectedValidation.verdict)
            : t('stock.validation.pending'),
          detail:
            selectedValidation?.summary || t('stock.f7671d22'),
        },
        {
          label: t('stock.label.riskCatalyst'),
          value: `${selectedReport.summary.riskSignals.length} / ${selectedReport.summary.catalystSignals.length}`,
          detail: t('stock.section.riskFirst'),
        },
        {
          label: t('stock.section.tradePlan'),
          value: selectedReport.details.tradePlan.style,
          detail: `${t('stock.91fdff46')} ${formatMaybeNumber(
            selectedReport.details.tradePlan.idealBuy,
          )} · ${t('stock.e4f3a2f4')} ${formatMaybeNumber(
            selectedReport.details.tradePlan.stopLoss,
          )}`,
        },
        {
          label: t('stock.section.priceStatus'),
          value: `${formatMaybeNumber(selectedReport.metrics.currentPrice)} / ${formatMaybePercent(selectedReport.metrics.changePct)}`,
          detail: t('stock.chart.currentPrice'),
        },
        {
          label: t('stock.label.freshness'),
          value: describeFreshness(
            selectedReport.dataAsOf ||
              selectedReport.tradeDate ||
              resolveGeneratedAt(selectedReport),
          ),
          detail: `${t('stock.5e68f591')} ${selectedReport.historyDays || Number(config.historyDays) || 180} ${t('stock.3edddd85')}`,
        },
      ]
    : [];

  const stockPickerPanel = (
    <section className="stock-analysis-side-section">
      <div className="section-header">
        <div>
          <h3>{t('stock.b8dcbb09')}</h3>
          <p className="stock-analysis-subtle">
            {t('stock.99137334')}
          </p>
        </div>
        <div className="stock-analysis-meta-strip compact">
          <span className="stock-analysis-meta-chip">
            {t('stock.68ea25aa')} {stockPickerCandidates.length}
          </span>
          <span className="stock-analysis-meta-chip subtle">{t('stock.d0f40f0c')}</span>
        </div>
      </div>
      <div className="stock-analysis-inline-grid stock-analysis-picker-grid">
        <label className="settings-field">
          <span className="settings-label">{t('stock.1c4017b3')}</span>
          <input
            className="nc-input"
            type="number"
            min={0}
            max={100}
            value={pickerMinScore}
            onChange={(event) =>
              setPickerMinScore(
                Math.max(0, Math.min(100, Number(event.target.value) || 0)),
              )
            }
          />
        </label>
        <label className="settings-field">
          <span className="settings-label">{t('stock.a2e479a4')}</span>
          <NcSelect
            className="settings-input"
            value={pickerTrend}
            onChange={(event) =>
              setPickerTrend(
                event.target.value as 'all' | 'bullish' | 'neutral',
              )
            }
          >
            <option value="bullish">{t('stock.6c39af23')}</option>
            <option value="neutral">{t('stock.e589ddde')}</option>
            <option value="all">{t('stock.b2c7a1c2')}</option>
          </NcSelect>
        </label>
        <label className="settings-field">
          <span className="settings-label">{t('stock.section.advice')}</span>
          <NcSelect
            className="settings-input"
            value={pickerRecommendation}
            onChange={(event) =>
              setPickerRecommendation(
                event.target.value as 'all' | '偏强跟踪' | '继续观察',
              )
            }
          >
            <option value="all">{t('stock.b2c7a1c2')}</option>
            <option value="偏强跟踪">{t('stock.stance.strongTracking')}</option>
            <option value="继续观察">{t('stock.9f406ac0')}</option>
          </NcSelect>
        </label>
        <label className="settings-field">
          <span className="settings-label">{t('stock.7c838d06')}</span>
          <NcSelect
            className="settings-input"
            value={String(pickerFreshnessDays)}
            onChange={(event) =>
              setPickerFreshnessDays(Number(event.target.value) || 0)
            }
          >
            <option value="3">{t('stock.c4bc3796')}</option>
            <option value="10">{t('stock.6fa443b3')}</option>
            <option value="30">{t('stock.c059bed7')}</option>
            <option value="0">{t('stock.8441b348')}</option>
          </NcSelect>
        </label>
      </div>
      {stockPickerCandidates.length ? (
        <>
          <div className="stock-analysis-candidate-list">
            {stockPickerCandidates.slice(0, 8).map((item) => (
              <button
                key={item.stockCode}
                className="stock-analysis-candidate-chip"
                type="button"
                onClick={() => handleSelectHistory(item.reportId)}
              >
                <strong>{item.stockName}</strong>
                <span>
                  {item.stockCode} · {item.score} {t('stock.daf783c8')} · {formatTrend(item.trend)}
                </span>
              </button>
            ))}
          </div>
          <div className="stock-analysis-inline-actions">
            <button
              className="btn-outline btn-sm"
              type="button"
              onClick={handleUseStockPickerCandidates}
            >
              {t('stock.e4c7e99a')}
            </button>
            <button
              className="btn-outline btn-sm"
              type="button"
              onClick={handleAnalyzeStockPickerCandidates}
              disabled={submitting}
            >
              {t('stock.6f482518')}
            </button>
          </div>
        </>
      ) : (
        <div className="settings-hint">
          {t('stock.38a92571')}
        </div>
      )}
    </section>
  );

  const watchlistPanel = (
    <section className="stock-analysis-side-section">
      <div className="section-header">
        <div>
          <h3>{t('stock.3c02d967')}</h3>
          <p className="stock-analysis-subtle">
            {t('stock.0cf3a582')}
          </p>
        </div>
        <button
          className="btn-outline btn-sm"
          type="button"
          onClick={handleAnalyzeWatchlist}
          disabled={submitting || watchlist.length === 0}
        >
          {t('stock.f711c66a')}
        </button>
      </div>
      {watchlist.length ? (
        <div className="stock-analysis-watchlist-list">
          {watchlist.map((item) => (
            <div key={item.stockCode} className="stock-analysis-watchlist-item">
              <div>
                <strong>{item.stockName}</strong>
                <div className="stock-analysis-subtle">
                  {item.stockCode} · {formatMarket(item.market)}
                </div>
                <div className="stock-analysis-meta-strip compact">
                  <span className="stock-analysis-meta-chip subtle">
                    {t('stock.3a6d9cd5')} {formatDateTime(item.updatedAt)}
                  </span>
                </div>
              </div>
              <div className="stock-analysis-watchlist-actions">
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => handleUseWatchlistItem(item)}
                >
                  {t('stock.action.fillIn')}
                </button>
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => handleAnalyzeWatchlistItem(item)}
                  disabled={submitting}
                >
                  {t('stock.action.analyze')}
                </button>
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => handleRemoveWatchlistItem(item.stockCode)}
                  disabled={updatingWatchlist}
                >
                  {t('stock.action.remove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="settings-hint">
          {t('stock.d63edaa4')}
        </div>
      )}
    </section>
  );

  const selectedReportPanel = (
    <section
      className={`stock-analysis-panel stock-analysis-report-panel ${
        isCompactLayout ? 'compact-layout' : ''
      } ${isMobileReportModalOpen ? 'mobile-open' : ''}`.trim()}
    >
      {!isMobileReportModalOpen ? (
        <div className="section-header">
          <h3>{t('stock.086ce972')}</h3>
          {isCompactLayout ? (
            <button
              className="btn-outline btn-sm"
              type="button"
              onClick={handleCloseReportDetail}
            >
              {t('stock.action.close')}
            </button>
          ) : null}
        </div>
      ) : null}
      {selectedReport ? (
        <div className="stock-analysis-report">
          <div className="stock-analysis-report-headline stock-analysis-report-headline-sticky">
            <div>
              <h3>{selectedReport.stockName}</h3>
              <p>
                {selectedReport.stockCode} ·{' '}
                {formatMarket(selectedReport.market)}
              </p>
              <div className="stock-analysis-meta-strip compact">
                <span
                  className={`stock-analysis-meta-chip ${
                    reportCacheStatus?.tone || 'fresh'
                  }`}
                >
                  {reportCacheStatus?.label || t('stock.cache.new')}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.589a837d')} {formatDateTime(resolveGeneratedAt(selectedReport))}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.ce41382a')}{' '}
                  {formatDateOnly(
                    selectedReport.tradeDate || selectedReport.dataAsOf,
                  )}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {selectedReport.historyDays ||
                    Number(config.historyDays) ||
                    180}
                  {t('stock.e7075785')}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.66914536')} {selectedReport.strategy.label}
                </span>
              </div>
              {selectedReport.reusedFromReportId ? (
                <div className="stock-analysis-subtle">
                  {t('stock.3f3c2b4b')} {selectedReport.reusedFromReportId}
                </div>
              ) : null}
              <div className="stock-analysis-inline-actions stock-analysis-report-actions">
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => {
                    if (previousHistoryReport) {
                      void handleSelectHistory(previousHistoryReport.id);
                    }
                  }}
                  disabled={!previousHistoryReport}
                >
                  {t('stock.action.previous')}
                </button>
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => {
                    if (nextHistoryReport) {
                      void handleSelectHistory(nextHistoryReport.id);
                    }
                  }}
                  disabled={!nextHistoryReport}
                >
                  {t('stock.action.next')}
                </button>
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={handleRefillSelectedReport}
                >
                  {t('stock.action.refill')}
                </button>
                <button
                  className="btn-outline btn-sm"
                  type="button"
                  onClick={() => {
                    void handleReanalyzeSelectedReport();
                  }}
                  disabled={submitting}
                >
                  {submitting ? t('stock.btn.submitting') : t('stock.2f6db36d')}
                </button>
              </div>
            </div>
            <div className="stock-analysis-score-block">
              <span className="stock-analysis-subtle">
                {selectedReportHistoryIndex >= 0
                  ? `${selectedReportHistoryIndex + 1} / ${filteredHistory.length}`
                  : t('stock.reports.historyTotal', { count: historyTotal })}
              </span>
              <strong>{selectedReport.score}</strong>
              <span>{formatRecommendation(selectedReport.recommendation)}</span>
            </div>
          </div>

          <section className="stock-analysis-report-brief">
            <div className="stock-analysis-report-brief-lead">
              <p className="stock-analysis-report-summary">
                {selectedReport.summary.headline}
              </p>
              <p className="stock-analysis-report-copy">
                {selectedReport.summary.analysisSummary}
              </p>
            </div>
            <div className="stock-analysis-report-brief-grid">
              {reportExecutiveSummary.map((item) => (
                <div key={item.label} className="stock-analysis-detail-card">
                  <span className="stock-analysis-subtle">{item.label}</span>
                  <strong>{item.value}</strong>
                  <p className="stock-analysis-subtle">{item.detail}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="stock-analysis-tabs">
            <button
              className={`stock-analysis-tab ${
                detailView === 'overview' ? 'active' : ''
              }`}
              type="button"
              onClick={() => setDetailView('overview')}
            >
              {t('stock.tab.overview')}
            </button>
            <button
              className={`stock-analysis-tab ${
                detailView === 'intel' ? 'active' : ''
              }`}
              type="button"
              onClick={() => setDetailView('intel')}
            >
              {t('stock.tab.intel')}
            </button>
            <button
              className={`stock-analysis-tab ${
                detailView === 'factors' ? 'active' : ''
              }`}
              type="button"
              onClick={() => setDetailView('factors')}
            >
              {t('stock.tab.factors')}
            </button>
            <button
              className={`stock-analysis-tab ${
                detailView === 'reference' ? 'active' : ''
              }`}
              type="button"
              onClick={() => setDetailView('reference')}
            >
              {t('stock.tab.reference')}
            </button>
          </div>

          {detailView === 'overview' ? (
            <>
              <div className="stock-analysis-tabs stock-analysis-tabs-compact">
                <button
                  className={`stock-analysis-tab ${
                    overviewSection === 'core' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setOverviewSection('core')}
                >
                  {t('stock.tab.core')}
                </button>
                <button
                  className={`stock-analysis-tab ${
                    overviewSection === 'advanced' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setOverviewSection('advanced')}
                >
                  {t('stock.tab.advanced')}
                </button>
              </div>
              {overviewSection === 'core' ? (
                <>
                  <div className="stock-analysis-report-grid">
                    <StockAnalysisDecisionDashboardCard
                      dashboard={selectedDashboard}
                    />
                    <div className="stock-analysis-detail-card">
                      <h4>{t('stock.9e75621e')}</h4>
                      <dl>
                        <div>
                          <dt>{t('stock.09c7f2e8')}</dt>
                          <dd>
                            {formatMaybeNumber(
                              selectedReport.metrics.currentPrice,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('stock.6b82157c')}</dt>
                          <dd
                            className={
                              (selectedReport.metrics.changePct || 0) >= 0
                                ? 'delta-up'
                                : 'delta-down'
                            }
                          >
                            {formatMaybePercent(
                              selectedReport.metrics.changePct,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t('stock.c50cfdb8')}</dt>
                          <dd>{selectedReport.summary.operationAdvice}</dd>
                        </div>
                        <div>
                          <dt>{t('stock.0f97b026')}</dt>
                          <dd>
                            {describeFreshness(
                              selectedReport.dataAsOf ||
                                selectedReport.tradeDate ||
                                resolveGeneratedAt(selectedReport),
                            )}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <StockAnalysisTradePlanCard report={selectedReport} />
                  </div>
                  <StockAnalysisChartCard report={selectedReport} />
                  <StockAnalysisValidationCard
                    validation={selectedValidation}
                  />
                </>
              ) : (
                <div className="stock-analysis-report-grid">
                  <StockAnalysisChartCard report={selectedReport} />
                  <div className="stock-analysis-detail-card">
                    <h4>{t('stock.fa6e71b7')}</h4>
                    <dl>
                      <div>
                        <dt>MA20 / MA60</dt>
                        <dd>
                          {formatMaybeNumber(selectedReport.metrics.ma20)} /{' '}
                          {formatMaybeNumber(selectedReport.metrics.ma60)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('stock.a7661d31')}(MA20)</dt>
                        <dd
                          className={
                            (selectedReport.metrics.biasToMa20 || 0) >= 0
                              ? 'delta-up'
                              : 'delta-down'
                          }
                        >
                          {formatMaybePercent(
                            selectedReport.metrics.biasToMa20,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>MACD(DIF / DEA)</dt>
                        <dd>
                          {formatMaybeNumber(selectedReport.metrics.macdDiff)} /{' '}
                          {formatMaybeNumber(selectedReport.metrics.macdSignal)}
                        </dd>
                      </div>
                      <div>
                        <dt>MACD {t('stock.2ced9bfa')} / RSI14</dt>
                        <dd>
                          {formatMaybeNumber(
                            selectedReport.metrics.macdHistogram,
                          )}{' '}
                          / {formatMaybeNumber(selectedReport.metrics.rsi14)}
                        </dd>
                      </div>
                      <div>
                        <dt>20 {t('stock.0fdc42b4')}</dt>
                        <dd>
                          {formatMaybeNumber(selectedReport.metrics.high20)} /{' '}
                          {formatMaybeNumber(selectedReport.metrics.low20)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
              )}
            </>
          ) : null}

          {detailView === 'intel' ? (
            <div className="stock-analysis-report-grid">
              <StockAnalysisNewsIntelCard
                key={selectedReport.id}
                report={selectedReport}
              />
              <div className="stock-analysis-detail-card">
                <h4>{t('stock.6d576357')}</h4>
                <ul>
                  {selectedReport.summary.riskSignals.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="stock-analysis-detail-card">
                <h4>{t('stock.dc5da7f0')}</h4>
                <ul>
                  {selectedReport.summary.catalystSignals.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p className="settings-hint">
                  {t('stock.4b826f95')}：{selectedReport.details.recentCloses.length}
                </p>
              </div>
            </div>
          ) : null}

          {detailView === 'factors' ? (
            <div className="stock-analysis-report-grid">
              <StockAnalysisFactorCard report={selectedReport} />
              <div className="stock-analysis-detail-card">
                <h4>{t('stock.51309f0b')}</h4>
                <ul>
                  {selectedReport.details.heuristicNotes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {detailView === 'reference' ? (
            <div className="stock-analysis-report-grid">
              <StockAnalysisReferenceCard report={selectedReport} />
              <StockAnalysisValidationCard validation={selectedValidation} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="settings-hint">{t('stock.1a1e16fa')}</div>
      )}
    </section>
  );

  return (
    <div className="page-view stock-analysis-page">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('stock.e44bb4cf')}</h2>
          <p>
            {t('stock.5cb856f4')} A
            {t('stock.4e7e6707')}
          </p>
        </div>
      </div>

      <div className="page-body stock-analysis-body">
        {pageError ? (
          <div className="stock-analysis-alert error">{pageError}</div>
        ) : null}
        {configMessage ? (
          <div className="stock-analysis-alert success">{configMessage}</div>
        ) : null}

        <section className="stock-analysis-summary-grid">
          {stockAnalysisSummaryCards.map((item) => (
            <div key={item.label} className="stock-analysis-summary-card">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.detail}</p>
            </div>
          ))}
        </section>

        <div className="stock-analysis-command-bar">
          <button
            className="btn-primary btn-sm"
            type="button"
            onClick={handleAnalyze}
            disabled={submitting}
          >
            {submitting ? t('stock.btn.submitting') : `${t('stock.workbench.startAnalysis', { count: codes.length || '' })}`.trim()}
          </button>
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={handleAddToWatchlist}
            disabled={updatingWatchlist}
          >
            {updatingWatchlist ? t('stock.btn.submitting') : t('stock.action.addToWatchlist')}
          </button>
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={() => setActiveTab('portfolio')}
          >
            {t('stock.section.managePortfolio')}
          </button>
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={() => setIsConfigModalOpen(true)}
          >
            {t('stock.section.advancedSettings')}
          </button>
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={() => {
              setActiveTab('market');
              setMarketView('backtest');
            }}
          >
            {t('stock.action.openBacktest')}
          </button>
          <button
            className="btn-outline btn-sm"
            type="button"
            onClick={handleRunReview}
            disabled={loadingReview}
          >
            {loadingReview ? t('stock.c1d07c5a') : t('stock.e559d0fa')}
          </button>
        </div>

        <section className="stock-analysis-hero">
          <div className="stock-analysis-hero-main">
            <section className="stock-analysis-form stock-analysis-launcher-card">
              <div className="section-header">
                <div>
                  <h3>{t('stock.38f39614')}</h3>
                  <p className="stock-analysis-subtle">
                    {t('stock.7dee5651')}
                  </p>
                </div>
                <span className="stock-analysis-meta-chip fresh">
                  {t('stock.eb62d953')}
                </span>
              </div>
              <label className="settings-field">
                <span className="settings-label">{t('stock.814244af')}</span>
                <textarea
                  className="settings-textarea stock-analysis-code-input"
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
                  placeholder={t('stock.770cf3a5')}
                />
                <span className="settings-hint">
                  {t('stock.699395b5')} {codes.length} {t('stock.e6f2257d')}。
                </span>
              </label>
              <div className="stock-analysis-inline-grid">
                <label className="settings-field">
                  <span className="settings-label">{t('stock.20acae99')}</span>
                  <NcSelect
                    className="settings-input"
                    value={marketScope}
                    onChange={(event) =>
                      setMarketScope(event.target.value as StockMarketScope)
                    }
                  >
                    {analysisMarketOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NcSelect>
                </label>
                <label className="settings-field">
                  <span className="settings-label">{t('stock.8b2e4570')}</span>
                  <NcSelect
                    className="settings-input"
                    value={reportType}
                    onChange={(event) =>
                      setReportType(
                        event.target.value as StockAnalysisReportType,
                      )
                    }
                  >
                    {reportTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NcSelect>
                </label>
                <label className="settings-field">
                  <span className="settings-label">{t('stock.a66a6b7e')}</span>
                  <NcSelect
                    className="settings-input"
                    value={strategyPreset}
                    onChange={(event) =>
                      setStrategyPreset(
                        event.target.value as StockAnalysisStrategyPreset,
                      )
                    }
                  >
                    {strategyOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NcSelect>
                </label>
              </div>
              <label className="settings-switch" htmlFor="stock-force-refresh">
                <input
                  id="stock-force-refresh"
                  type="checkbox"
                  checked={forceRefresh}
                  onChange={(event) => setForceRefresh(event.target.checked)}
                />
                <span>
                  {t('stock.92d9d082')}
                  <br />
                  <span className="settings-hint">{forceRefreshHint}</span>
                </span>
              </label>
              <div className="stock-analysis-meta-strip compact">
                <span className="stock-analysis-meta-chip">
                  {t('stock.3328781a')}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.21369a9d')}
                </span>
              </div>
            </section>

            <section className="stock-analysis-review-card">
              <div className="section-header">
                <div>
                  <h3>{t('stock.dc9413db')}</h3>
                  <p className="stock-analysis-subtle">
                    {t('stock.8b8c3037')}
                  </p>
                </div>
                <span className={`review-sentiment ${reviewSentimentClass}`}>
                  {review?.summary.stance || t('stock.da3b420e')}
                </span>
              </div>
              <div className="stock-analysis-inline-grid stock-analysis-review-controls">
                <label className="settings-field">
                  <span className="settings-label">{t('stock.e4e39d25')}</span>
                  <NcSelect
                    className="settings-input"
                    value={reviewScope}
                    onChange={(event) =>
                      setReviewScope(event.target.value as StockMarketScope)
                    }
                  >
                    {reviewMarketOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </NcSelect>
                </label>
              </div>
              {review ? (
                <div className="stock-analysis-meta-strip">
                  <span className="stock-analysis-meta-chip">
                    {t('stock.ce41382a')} {formatDateOnly(review.tradeDate || reviewDataAsOf)}
                  </span>
                  <span className="stock-analysis-meta-chip">
                    {t('stock.589a837d')} {formatDateTime(reviewGeneratedAt)}
                  </span>
                  <span className="stock-analysis-meta-chip subtle">
                    {describeFreshness(reviewDataAsOf || reviewGeneratedAt)}
                  </span>
                </div>
              ) : null}
              {review ? (
                <>
                  <p className="stock-analysis-review-summary">
                    <strong>{review.summary.headline}</strong>
                    <br />
                    {review.summary.overview}
                  </p>
                  <div className="stock-analysis-meta-strip">
                    {reviewPreviewIndices.map((item) => (
                      <span
                        key={item.symbol}
                        className="stock-analysis-meta-chip subtle"
                      >
                        {item.name} {formatMaybePercent(item.changePct)}
                      </span>
                    ))}
                    {review.detail.indices.length >
                    reviewPreviewIndices.length ? (
                      <span className="stock-analysis-meta-chip subtle">
                        {t('stock.e990cfba')}{' '}
                        {review.detail.indices.length -
                          reviewPreviewIndices.length}{' '}
                        {t('stock.e455ac38')}
                      </span>
                    ) : null}
                  </div>
                  <div className="stock-analysis-highlights">
                    {review.summary.keySignals.slice(0, 3).map((item) => (
                      <span key={item} className="stock-analysis-chip">
                        {item}
                      </span>
                    ))}
                  </div>
                  <div className="stock-analysis-inline-actions">
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={() => setActiveTab('market')}
                    >
                      {t('stock.action.openMarketAndBacktest')}
                    </button>
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={() => setActiveTab('reports')}
                    >
                      {t('stock.action.openReportCenter')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="stock-analysis-empty-state">
                  <p>{t('stock.76b25a8d')}</p>
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={handleRunReview}
                    disabled={loadingReview}
                  >
                    {loadingReview ? t('stock.c1d07c5a') : t('stock.02a35cca')}
                  </button>
                </div>
              )}
            </section>
          </div>
        </section>

        <div className="stock-analysis-workflow-nav">
          {workflowTabs.map((item) => (
            <button
              key={item.key}
              className={`stock-analysis-workflow-step ${
                activeTab === item.key ? 'active' : ''
              }`}
              type="button"
              onClick={() => setActiveTab(item.key)}
            >
              <strong>{item.label}</strong>
              <span className="stock-analysis-step-summary">
                {item.summary}
              </span>
            </button>
          ))}
        </div>

        {activeTab === 'workbench' && (
          <section className="stock-analysis-workspace">
            <div className="stock-analysis-primary-column">
              <section className="stock-analysis-panel">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.2488f577')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.7abf158f')}
                    </p>
                  </div>
                  <span className="stock-analysis-subtle">
                    {taskStreamConnected ? t('stock.sse.connected') : t('stock.sse.reconnecting')}
                  </span>
                </div>
                {activeTasks.length ? (
                  <div className="stock-analysis-task-list">
                    {activeTasks.map((task) => (
                      <StockAnalysisTaskCard
                        key={task.id}
                        task={task}
                        onSelectHistory={(reportId) => {
                          void handleSelectHistory(reportId);
                        }}
                        onRetry={(retryTask) => {
                          void handleRetryTask(retryTask);
                        }}
                        retrying={retryingTaskId === task.id}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="stock-analysis-empty-state">
                    <p>{t('stock.c41da891')}</p>
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={handleAnalyze}
                      disabled={submitting || codes.length === 0}
                    >
                      {submitting ? t('stock.btn.submitting') : t('stock.2ff90d7e')}
                    </button>
                  </div>
                )}
              </section>
            </div>
            <aside className="stock-analysis-side-column">
              <section className="stock-analysis-side-section">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.beb11abe')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.4e0024f8')}
                    </p>
                  </div>
                  <span className="stock-analysis-meta-chip">
                    {watchlist.length} {t('stock.9fcf4333')}
                  </span>
                </div>
                <div className="stock-analysis-quick-grid">
                  <button
                    className="stock-analysis-quick-card"
                    type="button"
                    onClick={() => setActiveTab('portfolio')}
                  >
                    <strong>{t('stock.abe85f07')}</strong>
                    <p>{t('stock.abeb76e4')}</p>
                  </button>
                  <div className="stock-analysis-detail-card">
                    <strong>{t('stock.b57fca87')}</strong>
                    <p className="stock-analysis-subtle">
                      {stockPickerCandidates.length > 0
                        ? t('stock.msg.currentConditionHit', { count: stockPickerCandidates.length })
                        : t('stock.7044a876')}
                    </p>
                  </div>
                </div>
                <div className="stock-analysis-inline-actions">
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={handleAnalyzeWatchlist}
                    disabled={submitting || watchlist.length === 0}
                  >
                    {t('stock.902a9673')}
                  </button>
                </div>
              </section>
              <section className="stock-analysis-side-section">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.e7253c92')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.b1b2046e')}
                    </p>
                  </div>
                  <span className="stock-analysis-meta-chip subtle">
                    {t('stock.c827d8db')} {historyTotal}
                  </span>
                </div>
                <div className="stock-analysis-quick-grid">
                  <button
                    className="stock-analysis-quick-card"
                    type="button"
                    onClick={() => setActiveTab('reports')}
                  >
                    <strong>{t('stock.8300ac6d')}</strong>
                    <p>{t('stock.a40316a0')}</p>
                  </button>
                  <div className="stock-analysis-meta-strip">
                    <span className="stock-analysis-meta-chip subtle">
                      {t('stock.5d6f7412')} {recentCompletedResults.length}
                    </span>
                    <span className="stock-analysis-meta-chip subtle">
                      {t('stock.bec049ca')} {recentFailedResults.length}
                    </span>
                    <span className="stock-analysis-meta-chip subtle">
                      {t('stock.4f53fca8')} {feedback?.strategies.length || 0}
                    </span>
                  </div>
                </div>
              </section>
              <section className="stock-analysis-side-section">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.tab.market')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.6f1cd4a9')}
                    </p>
                  </div>
                  <span className={`review-sentiment ${reviewSentimentClass}`}>
                    {review?.summary.stance || t('stock.da3b420e')}
                  </span>
                </div>
                <p className="stock-analysis-subtle">
                  {review?.summary.overview || t('stock.76b25a8d')}
                </p>
                <div className="stock-analysis-inline-actions">
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => setActiveTab('market')}
                  >
                    {t('stock.action.openMarketAndBacktest')}
                  </button>
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => setMarketView('backtest')}
                  >
                    {t('stock.section.configBacktest')}
                  </button>
                </div>
              </section>
            </aside>
          </section>
        )}

        {activeTab === 'reports' && (
          <div className="stock-analysis-history-layout">
            <section className="stock-analysis-panel">
              <div className="section-header">
                <h3>{t('stock.cad9a24e')}</h3>
                <span className="stock-analysis-subtle">
                  {t('stock.ac007746')} {historyPage} / {historyTotalPages} {t('stock.5fccd018')} · {t('stock.c9314034')}{' '}
                  {filteredHistory.length} {t('stock.cc1bacb5')}
                </span>
              </div>
              <div className="stock-analysis-meta-strip compact">
                <span className="stock-analysis-meta-chip">
                  {t('stock.c827d8db')} {historyTotal}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.5d6f7412')} {recentCompletedResults.length}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.bec049ca')} {recentFailedResults.length}
                </span>
                <span className="stock-analysis-meta-chip subtle">
                  {t('stock.4f53fca8')} {feedback?.strategies.length || 0}
                </span>
              </div>
              <div className="stock-analysis-quick-grid stock-analysis-report-hub-grid">
                <button
                  className={`stock-analysis-quick-card ${
                    historyView === 'reports' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setHistoryView('reports')}
                >
                  <strong>{t('stock.cad9a24e')}</strong>
                  <p>{t('stock.95259d0b')}</p>
                </button>
                <button
                  className={`stock-analysis-quick-card ${
                    historyView === 'recent' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setHistoryView('recent')}
                >
                  <strong>{t('stock.0fb9614a')}</strong>
                  <p>{t('stock.d7deb436')}</p>
                </button>
                <button
                  className={`stock-analysis-quick-card ${
                    historyView === 'feedback' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setHistoryView('feedback')}
                >
                  <strong>{t('stock.4f53fca8')}</strong>
                  <p>{t('stock.6c8d5275')}</p>
                </button>
                <button
                  className={`stock-analysis-quick-card ${
                    historyView === 'failed' ? 'active' : ''
                  }`}
                  type="button"
                  onClick={() => setHistoryView('failed')}
                >
                  <strong>{t('stock.bec049ca')}</strong>
                  <p>{t('stock.0b511b86')}</p>
                </button>
              </div>
              {historyView === 'recent' ? (
                recentCompletedResults.length ? (
                  <>
                    <div className="stock-analysis-inline-actions stock-analysis-section-toolbar">
                      <span className="stock-analysis-subtle">
                        {t('stock.d5eed780')}
                      </span>
                      <div className="stock-analysis-filter-strip">
                        <StockAnalysisOptionTabs
                          label={t("stock.label.market")}
                          value={recentResultMarketFilter}
                          options={[
                            { value: 'all', label: t('stock.market.all') },
                            { value: 'cn', label: t('stock.market.aShare') },
                            { value: 'hk', label: t('stock.market.hk') },
                            { value: 'us', label: t('stock.market.us') },
                          ]}
                          onChange={(value) =>
                            setRecentResultMarketFilter(
                              value as 'all' | StockAnalysisTask['market'],
                            )
                          }
                        />
                        <StockAnalysisOptionTabs
                          label={t("stock.4e003d37")}
                          value={recentResultModeFilter}
                          options={[
                            { value: 'all', label: t('stock.filter.allResults') },
                            { value: 'generated', label: t('stock.cache.new') },
                            { value: 'reused', label: t('stock.filter.reusedResults') },
                          ]}
                          onChange={setRecentResultModeFilter}
                        />
                        {hasRecentResultFilters ? (
                          <button
                            className="btn-outline btn-sm"
                            type="button"
                            onClick={() => {
                              setRecentResultMarketFilter('all');
                              setRecentResultModeFilter('all');
                            }}
                          >
                            {t('stock.4b9c3271')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="stock-analysis-meta-strip compact">
                      <span className="stock-analysis-meta-chip subtle">
                        {t('stock.c9314034')} {filteredRecentCompletedResults.length} /{' '}
                        {recentCompletedResults.length} {t('stock.04ca36cb')}
                      </span>
                      {recentResultMarketFilter !== 'all' ? (
                        <span className="stock-analysis-meta-chip subtle">
                          {t('stock.label.market')} {formatMarket(recentResultMarketFilter)}
                        </span>
                      ) : null}
                      {recentResultModeFilter !== 'all' ? (
                        <span className="stock-analysis-meta-chip subtle">
                          {t('stock.label.source')}{' '}
                          {recentResultModeFilter === 'generated'
                            ? t('stock.label.newGenerated')
                            : t('stock.label.reusedResults')}
                        </span>
                      ) : null}
                    </div>
                    {filteredRecentCompletedResults.length ? (
                      <div className="stock-analysis-task-list">
                        {filteredRecentCompletedResults.map((task) => (
                          <StockAnalysisTaskCard
                            key={task.id}
                            task={task}
                            onSelectHistory={(reportId) => {
                              void handleSelectHistory(reportId);
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="stock-analysis-empty-state">
                        <p>{t('stock.39edeeb0')}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="stock-analysis-empty-state">
                    <p>{t('stock.424b31f9')}</p>
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={() => setHistoryView('reports')}
                    >
                      {t('stock.action.goToHistoryReports')}
                    </button>
                  </div>
                )
              ) : null}
              {historyView === 'feedback' ? (
                <StockAnalysisFeedbackCard
                  feedback={feedback}
                  onSelectReport={(reportId) => {
                    void handleSelectHistory(reportId);
                  }}
                />
              ) : null}
              {historyView === 'failed' ? (
                <>
                  <div className="stock-analysis-inline-actions stock-analysis-section-toolbar">
                    <span className="stock-analysis-subtle">
                      {t('stock.eb1e4218')}
                    </span>
                    <div className="stock-analysis-inline-actions">
                      {hiddenFailedTaskCount > 0 ? (
                        <button
                          className="btn-outline btn-sm"
                          type="button"
                          onClick={handleRestoreFailedTasks}
                        >
                          {t('stock.0bf44a03')} {hiddenFailedTaskCount}
                        </button>
                      ) : null}
                      {recentFailedResults.length > 0 ? (
                        <button
                          className="btn-outline btn-sm"
                          type="button"
                          onClick={() => {
                            void handleClearFailedTasks();
                          }}
                          disabled={clearingFailedTasks}
                        >
                          {clearingFailedTasks
                            ? t('stock.e329328e')
                            : t('stock.da1dbebc')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {visibleFailedResults.length ? (
                    <div className="stock-analysis-task-list">
                      {visibleFailedResults.map((task) => (
                        <StockAnalysisTaskCard
                          key={task.id}
                          task={task}
                          onSelectHistory={(reportId) => {
                            void handleSelectHistory(reportId);
                          }}
                          onRetry={(retryTask) => {
                            void handleRetryTask(retryTask);
                          }}
                          retrying={retryingTaskId === task.id}
                          extraActions={
                            <>
                              <button
                                className="btn-outline btn-sm"
                                type="button"
                                onClick={() => handleHideFailedTask(task.id)}
                              >
                                {t('stock.action.removeFromCurrentView')}
                              </button>
                              <button
                                className="btn-outline btn-sm"
                                type="button"
                                onClick={() => {
                                  void handleDeleteFailedTask(task.id);
                                }}
                                disabled={deletingTaskId === task.id}
                              >
                                {deletingTaskId === task.id
                                  ? t('stock.btn.deleting')
                                  : t('stock.96d2b75f')}
                              </button>
                            </>
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="stock-analysis-empty-state">
                      <p>
                        {recentFailedResults.length > 0
                          ? t('stock.msg.failedRecordsHidden')
                          : t('stock.8d58d56d')}
                      </p>
                      {hiddenFailedTaskCount > 0 ? (
                        <button
                          className="btn-outline btn-sm"
                          type="button"
                          onClick={handleRestoreFailedTasks}
                        >
                          {t('stock.action.restoreFailedRecords')}
                        </button>
                      ) : null}
                    </div>
                  )}
                </>
              ) : null}
              {historyView === 'reports' ? (
                history.length ? (
                  <>
                    <div className="stock-analysis-history-toolbar">
                      <input
                        className="settings-input"
                        type="text"
                        value={historySearch}
                        onChange={(event) =>
                          setHistorySearch(event.target.value)
                        }
                        placeholder={t('stock.797c03a5')}
                      />
                    </div>
                    <div className="stock-analysis-inline-actions stock-analysis-section-toolbar">
                      <span className="stock-analysis-subtle">
                        {t('stock.98a52d2b')}
                      </span>
                      <div className="stock-analysis-filter-strip">
                        <StockAnalysisOptionTabs
                          label={t("stock.label.market")}
                          value={historyMarketFilter}
                          options={[
                            { value: 'all', label: t('stock.market.all') },
                            { value: 'cn', label: t('stock.market.aShare') },
                            { value: 'hk', label: t('stock.market.hk') },
                            { value: 'us', label: t('stock.market.us') },
                          ]}
                          onChange={(value) =>
                            setHistoryMarketFilter(
                              value as
                                | 'all'
                                | StockAnalysisHistoryItem['market'],
                            )
                          }
                        />
                        <StockAnalysisOptionTabs
                          label={t("stock.19fcb9eb")}
                          value={historyDateRange}
                          options={[
                            { value: 'all', label: t('stock.filter.all') },
                            { value: '7d', label: t('stock.period.7d') },
                            { value: '30d', label: t('stock.period.30d') },
                            { value: '90d', label: t('stock.period.90d') },
                            { value: '180d', label: t('stock.period.180d') },
                          ]}
                          onChange={setHistoryDateRange}
                        />
                        <StockAnalysisOptionTabs
                          label={t("stock.label.layout")}
                          value={historyListMode}
                          options={[
                            { value: 'grouped', label: t('stock.layout.grouped') },
                            { value: 'flat', label: t('stock.layout.flat') },
                          ]}
                          onChange={setHistoryListMode}
                        />
                        <label className="stock-analysis-inline-field">
                          <span className="stock-analysis-subtle">{t('stock.c360e994')}</span>
                          <NcSelect
                            className="settings-input"
                            value={historySortMode}
                            onChange={(event) =>
                              setHistorySortMode(
                                event.target.value as HistorySortMode,
                              )
                            }
                          >
                            <option value="latest">{t('stock.046c6233')}</option>
                            <option value="score-desc">{t('stock.87139a58')}</option>
                            <option value="score-asc">{t('stock.17c28464')}</option>
                            <option value="change-desc">{t('stock.d23b8143')}</option>
                            <option value="change-asc">{t('stock.96a06a03')}</option>
                          </NcSelect>
                        </label>
                        <StockAnalysisOptionTabs
                          label={t("stock.c464334e")}
                          value={String(historyLimit)}
                          options={[
                            { value: '20', label: t('stock.pageSize.20') },
                            { value: '50', label: t('stock.pageSize.50') },
                            { value: '100', label: t('stock.pageSize.100') },
                          ]}
                          onChange={(value) => {
                            void handleHistoryPageSizeChange(
                              Number(value) || 20,
                            );
                          }}
                        />
                        {historyListMode === 'grouped' ? (
                          <StockAnalysisOptionTabs
                            label={t("stock.label.groupSort")}
                            value={historyGroupSort}
                            options={[
                              { value: 'latest', label: t('stock.6e249652') },
                              { value: 'score-desc', label: t('stock.da21e885') },
                              { value: 'count-desc', label: t('stock.reports.count') },
                            ]}
                            onChange={setHistoryGroupSort}
                          />
                        ) : null}
                        {hasHistoryFilters ? (
                          <button
                            className="btn-outline btn-sm"
                            type="button"
                            onClick={() => {
                              setHistorySearch('');
                              setHistoryMarketFilter('all');
                              setHistoryDateRange('90d');
                            }}
                          >
                            {t('stock.4b9c3271')}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="stock-analysis-meta-strip compact">
                      <span className="stock-analysis-meta-chip subtle">
                        {t('stock.445c2116')} {filteredHistory.length} / {history.length}{' '}
                        {t('stock.label.items')}
                      </span>
                      {historySearch.trim() ? (
                        <span className="stock-analysis-meta-chip subtle">
                          {t('stock.e5f71fc3')} {historySearch.trim()}
                        </span>
                      ) : null}
                      {historyMarketFilter !== 'all' ? (
                        <span className="stock-analysis-meta-chip subtle">
                          {t('stock.label.market')} {formatMarket(historyMarketFilter)}
                        </span>
                      ) : null}
                      {historyDateRange !== '90d' ? (
                        <span className="stock-analysis-meta-chip subtle">
                          {t('stock.label.time')}{' '}
                          {historyDateRange === 'all'
                            ? t('stock.filter.all')
                            : historyDateRange === '7d'
                              ? t('stock.period.7d')
                              : historyDateRange === '30d'
                                ? t('stock.period.30d')
                                : t('stock.period.180d')}
                        </span>
                      ) : null}
                    </div>
                    {filteredHistory.length ? (
                      historyListMode === 'grouped' ? (
                        <div className="stock-analysis-history-groups">
                          {groupedHistory.map((group) => {
                            const isExpanded =
                              expandedHistoryGroups.includes(group.stockCode) ||
                              selectedReport?.stockCode === group.stockCode;
                            return (
                              <div
                                key={group.stockCode}
                                className={`stock-analysis-history-group ${
                                  isExpanded ? 'expanded' : ''
                                }`}
                              >
                                <button
                                  className="stock-analysis-history-group-toggle"
                                  type="button"
                                  onClick={() =>
                                    handleToggleHistoryGroup(group.stockCode)
                                  }
                                >
                                  <div>
                                    <strong>{group.stockName}</strong>
                                    <div className="stock-analysis-subtle">
                                      {group.stockCode} ·{' '}
                                      {formatMarket(group.market)}
                                    </div>
                                  </div>
                                  <div className="stock-analysis-history-group-meta">
                                    <span className="stock-analysis-meta-chip subtle">
                                      {group.items.length} {t('stock.62a8d630')}
                                    </span>
                                    <span className="stock-analysis-meta-chip subtle">
                                      {t('stock.da21e885')} {group.bestScore}
                                    </span>
                                    <span
                                      className={`score-pill ${
                                        group.latest.score >= 70
                                          ? 'good'
                                          : group.latest.score <= 45
                                            ? 'bad'
                                            : 'neutral'
                                      }`}
                                    >
                                      {t('stock.8818d483')} {group.latest.score}
                                    </span>
                                    <span className="stock-analysis-meta-chip subtle">
                                      {formatDateOnly(
                                        resolveGeneratedAt(group.latest),
                                      )}
                                    </span>
                                  </div>
                                </button>
                                {isExpanded ? (
                                  <div className="stock-analysis-history-group-body">
                                    {group.items.map((item) =>
                                      renderHistoryCard(
                                        item,
                                        'stock-analysis-history-card-nested',
                                      ),
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="stock-analysis-history-list">
                          {filteredHistory.map((item) =>
                            renderHistoryCard(item),
                          )}
                        </div>
                      )
                    ) : (
                      <div className="settings-hint">
                        {t('stock.b008d033')}
                      </div>
                    )}
                    <div className="stock-analysis-inline-actions stock-analysis-history-pagination">
                      <button
                        className="btn-outline btn-sm"
                        type="button"
                        onClick={() => {
                          void handleHistoryPageChange(historyPage - 1);
                        }}
                        disabled={loadingMoreHistory || historyPage <= 1}
                      >
                        {t('stock.action.previousPage')}
                      </button>
                      <span className="stock-analysis-meta-chip subtle">
                        {t('stock.ac007746')} {historyPage} / {historyTotalPages} {t('stock.5fccd018')}
                      </span>
                      <button
                        className="btn-outline btn-sm"
                        type="button"
                        onClick={() => {
                          void handleHistoryPageChange(historyPage + 1);
                        }}
                        disabled={
                          loadingMoreHistory || historyPage >= historyTotalPages
                        }
                      >
                        {t('stock.action.nextPage')}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="settings-hint">{t('stock.be98fbfe')}</div>
                )
              ) : null}
            </section>

            {!isCompactLayout ? selectedReportPanel : null}
          </div>
        )}

        {activeTab === 'market' && (
          <section className="stock-analysis-workspace">
            <div className="stock-analysis-primary-column">
              <section className="stock-analysis-panel">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.tab.market')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.64a23d21')}
                    </p>
                  </div>
                  <div className="stock-analysis-inline-actions">
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={handleRunReview}
                      disabled={loadingReview}
                    >
                      {loadingReview ? t('stock.c1d07c5a') : t('stock.action.refreshReview')}
                    </button>
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={() => setMarketView('backtest')}
                    >
                      {t('stock.section.configBacktest')}
                    </button>
                  </div>
                </div>
                <div className="stock-analysis-tabs">
                  <button
                    className={`stock-analysis-tab ${
                      marketView === 'review' ? 'active' : ''
                    }`}
                    type="button"
                    onClick={() => setMarketView('review')}
                  >
                    {t('stock.tab.marketReview')}
                  </button>
                  <button
                    className={`stock-analysis-tab ${
                      marketView === 'backtest' ? 'active' : ''
                    }`}
                    type="button"
                    onClick={() => setMarketView('backtest')}
                  >
                    {t('stock.tab.backtestResults')}
                  </button>
                  <button
                    className={`stock-analysis-tab ${
                      marketView === 'providers' ? 'active' : ''
                    }`}
                    type="button"
                    onClick={() => setMarketView('providers')}
                  >
                    {t('stock.tab.dataSources')}
                  </button>
                </div>
                {marketView === 'review' ? (
                  review ? (
                    <>
                      <div className="stock-analysis-meta-strip">
                        <span className="stock-analysis-meta-chip">
                          {t('stock.ce41382a')}{' '}
                          {formatDateOnly(review.tradeDate || reviewDataAsOf)}
                        </span>
                        <span
                          className={`review-sentiment ${reviewSentimentClass}`}
                        >
                          {review.summary.stance}
                        </span>
                        <span className="stock-analysis-meta-chip subtle">
                          {describeFreshness(
                            reviewDataAsOf || reviewGeneratedAt,
                          )}
                        </span>
                      </div>
                      <div className="stock-analysis-detail-card">
                        <h4>{review.summary.headline}</h4>
                        <p className="stock-analysis-report-copy">
                          {review.summary.overview}
                        </p>
                        <div className="stock-analysis-highlights">
                          {review.summary.keySignals.map((item) => (
                            <span key={item} className="stock-analysis-chip">
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="stock-analysis-index-grid">
                        {review.detail.indices.map((item) => (
                          <div
                            key={item.symbol}
                            className="stock-analysis-index-card"
                          >
                            <strong>{item.name}</strong>
                            <span>{formatMaybeNumber(item.price)}</span>
                            <span
                              className={
                                (item.changePct || 0) >= 0
                                  ? 'delta-up'
                                  : 'delta-down'
                              }
                            >
                              {formatMaybePercent(item.changePct)}
                            </span>
                            <span className="stock-analysis-subtle">
                              {item.providerLabel}
                            </span>
                            <span className="stock-analysis-subtle">
                              {item.priceSourceLabel}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="stock-analysis-empty-state">
                      <p>{t('stock.76b25a8d')}</p>
                      <button
                        className="btn-outline btn-sm"
                        type="button"
                        onClick={handleRunReview}
                        disabled={loadingReview}
                      >
                        {loadingReview ? t('stock.c1d07c5a') : t('stock.02a35cca')}
                      </button>
                    </div>
                  )
                ) : null}
                {marketView === 'backtest' ? (
                  <>
                    <div className="stock-analysis-detail-card stock-analysis-inline-backtest-panel">
                      <div className="stock-analysis-task-header">
                        <div>
                          <h4>{t('stock.4a1e9d1b')}</h4>
                          <p className="stock-analysis-subtle">
                            {t('stock.91fc3ae3')}
                          </p>
                        </div>
                      </div>
                      <div className="stock-analysis-config-grid">
                        <label className="settings-field">
                          <span className="settings-label">{t('stock.66914536')}</span>
                          <NcSelect
                            className="settings-input"
                            value={backtestDraft.strategyPreset || ''}
                            onChange={(event) =>
                              setBacktestDraft((current) => ({
                                ...current,
                                strategyPreset: event.target.value
                                  ? (event.target.value as StockAnalysisStrategyPreset)
                                  : undefined,
                              }))
                            }
                          >
                            <option value="">{t('stock.689ee216')}</option>
                            {strategyOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NcSelect>
                        </label>
                        <label className="settings-field">
                          <span className="settings-label">{t('stock.814244af')}</span>
                          <input
                            className="settings-input"
                            type="text"
                            value={backtestDraft.stockCode || ''}
                            onChange={(event) =>
                              setBacktestDraft((current) => ({
                                ...current,
                                stockCode: event.target.value,
                              }))
                            }
                            placeholder={t('stock.ae9c6675')}
                          />
                        </label>
                        <label className="settings-field">
                          <span className="settings-label">{t('stock.a93ed268')}</span>
                          <input
                            className="nc-input"
                            type="number"
                            min={10}
                            max={500}
                            value={String(backtestDraft.limit || 120)}
                            onChange={(event) =>
                              setBacktestDraft((current) => ({
                                ...current,
                                limit: Number(event.target.value) || 120,
                              }))
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span className="settings-label">{t('stock.ced10102')}</span>
                          <input
                            className="nc-input"
                            type="number"
                            min={1}
                            max={30}
                            value={String(backtestDraft.lookaheadDays || 10)}
                            onChange={(event) =>
                              setBacktestDraft((current) => ({
                                ...current,
                                lookaheadDays: Number(event.target.value) || 10,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className="stock-analysis-inline-actions">
                        <button
                          className="btn-primary btn-sm"
                          type="button"
                          onClick={() => {
                            void handleRunBacktest();
                          }}
                          disabled={runningBacktest}
                        >
                          {runningBacktest ? t('stock.0da17288') : t('stock.ff4e495f')}
                        </button>
                      </div>
                    </div>
                  {backtestResult ? (
                    <>
                      <div className="stock-analysis-report-grid">
                        <div className="stock-analysis-detail-card">
                          <h4>{t('stock.187fa28c')}</h4>
                          <dl>
                            <div>
                              <dt>{t('stock.2e70f1d6')}</dt>
                              <dd>{backtestResult.totalTrades}</dd>
                            </div>
                            <div>
                              <dt>{t('stock.feedbackSort.winrateDesc')}</dt>
                              <dd>
                                {formatMaybePercent(
                                  backtestResult.overallWinRate,
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('stock.daf783c8')}</dt>
                              <dd>
                                {formatMaybePercent(
                                  backtestResult.overallAvgReturnPct,
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('stock.6f1ec03d')}</dt>
                              <dd>
                                {formatMaybePercent(
                                  backtestResult.overallDirectionAccuracy,
                                )}
                              </dd>
                            </div>
                          </dl>
                        </div>
                        <div className="stock-analysis-detail-card">
                          <h4>{t('stock.a45c7720')}</h4>
                          <div className="stock-analysis-meta-strip">
                            <span className="stock-analysis-meta-chip subtle">
                              {t('stock.66914536')} {backtestDraft.strategyPreset || t('stock.689ee216')}
                            </span>
                            <span className="stock-analysis-meta-chip subtle">
                              {t('stock.dd19770c')} {backtestDraft.stockCode?.trim() || t('stock.689ee216')}
                            </span>
                            <span className="stock-analysis-meta-chip subtle">
                              {t('stock.a93ed268')} {backtestDraft.limit || '-'}
                            </span>
                            <span className="stock-analysis-meta-chip subtle">
                              {t('stock.7c088026')} {backtestDraft.lookaheadDays || '-'} {t('stock.249aba76')}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="stock-analysis-feedback-list">
                        {backtestResult.strategies.map((item) => (
                          <div
                            key={item.strategy.id}
                            className="stock-analysis-feedback-item"
                          >
                            <div className="stock-analysis-task-header">
                              <strong>{item.strategy.label}</strong>
                              <span className="score-pill neutral">
                                {item.tradeCount} {t('stock.9fb4dafd')}
                              </span>
                            </div>
                            <div className="stock-analysis-meta-strip compact">
                              <span className="stock-analysis-meta-chip subtle">
                                {t('stock.feedbackSort.winrateDesc')} {formatMaybePercent(item.winRate)}
                              </span>
                              <span className="stock-analysis-meta-chip subtle">
                                {t('stock.daf783c8')} {formatMaybePercent(item.avgReturnPct)}
                              </span>
                              <span className="stock-analysis-meta-chip subtle">
                                {t('stock.3c7d9eed')}{' '}
                                {formatMaybePercent(item.directionAccuracy)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {backtestResult.notes.length ? (
                        <ul className="stock-analysis-feedback-notes">
                          {backtestResult.notes.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : (
                    <div className="stock-analysis-empty-state">
                      <p>{t('stock.9c1a0ffd')}</p>
                    </div>
                  )
                  }
                  </>
                ) : null}
                {marketView === 'providers' ? (
                  dataProviderReport ? (
                    <div className="stock-analysis-index-grid">
                      {dataProviderReport.providers.map((provider) => (
                        <div
                          key={provider.providerId}
                          className="stock-analysis-index-card"
                        >
                          <strong>{provider.providerLabel}</strong>
                          <span
                            className={
                              provider.available ? 'delta-up' : 'delta-down'
                            }
                          >
                            {provider.available ? t('stock.status.available') : t('stock.status.degraded')}
                          </span>
                          <span className="stock-analysis-subtle">
                            {t('stock.330363df')} {provider.successCount} / {t('stock.taskStatus.failed')}{' '}
                            {provider.failureCount}
                          </span>
                          <span className="stock-analysis-subtle">
                            {t('stock.e56a0df0')} {provider.consecutiveFailures}
                          </span>
                          <span className="stock-analysis-subtle">
                            {t('stock.c0e76c19')} {formatDateTime(provider.lastChecked)}
                          </span>
                          <span className="stock-analysis-subtle">
                            {provider.lastError
                              ? `${t('stock.1c372786', { error: provider.lastError })}`
                              : `${t('stock.f56de200', { time: formatDateTime(provider.lastSuccessAt) })}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="stock-analysis-empty-state">
                      <p>{t('stock.d1e8cb8a')}</p>
                    </div>
                  )
                ) : null}
              </section>
            </div>
            <aside className="stock-analysis-side-column">
              <section className="stock-analysis-side-section">
                <div className="section-header">
                  <div>
                    <h3>{t('stock.ee2fff7a')}</h3>
                    <p className="stock-analysis-subtle">
                      {t('stock.cf1b14f1')}
                    </p>
                  </div>
                </div>
                <div className="stock-analysis-inline-actions">
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => setActiveTab('reports')}
                  >
                    {t('stock.action.openReportCenter')}
                  </button>
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => setActiveTab('portfolio')}
                  >
                    {t('stock.action.openPortfolio')}
                  </button>
                  <button
                    className="btn-outline btn-sm"
                    type="button"
                    onClick={() => setIsConfigModalOpen(true)}
                  >
                    {t('stock.section.advancedSettings')}
                  </button>
                </div>
              </section>
            </aside>
          </section>
        )}

        {activeTab === 'portfolio' && (
          <section className="stock-analysis-workspace">
            <div className="stock-analysis-primary-column">
              {watchlistPanel}
            </div>
            <aside className="stock-analysis-side-column">
              {stockPickerPanel}
            </aside>
          </section>
        )}

        {isCompactLayout && isMobileReportModalOpen && selectedReport ? (
          <div
            className="modal-overlay"
            onClick={handleCloseReportDetail}
          >
            <div
              className="modal stock-analysis-report-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-header">
                <div>
                  <h3>
                    {selectedReport.stockName} · {selectedReport.stockCode}
                  </h3>
                  <p className="stock-analysis-subtle">
                    {formatMarket(selectedReport.market)} · {t('stock.4bcb44ce')}{' '}
                    {selectedReport.score} ·{' '}
                    {formatRecommendation(selectedReport.recommendation)}
                  </p>
                </div>
                <button
                  className="modal-close-btn"
                  type="button"
                  onClick={handleCloseReportDetail}
                  aria-label={t('stock.config.closeReportDialog')}
                >
                  ×
                </button>
              </div>
              {selectedReportPanel}
            </div>
          </div>
        ) : null}

        {isConfigModalOpen ? (
          <div
            className="modal-overlay"
            onClick={() => setIsConfigModalOpen(false)}
          >
            <div
              className="modal stock-analysis-settings-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-header">
                <div>
                  <h3>{t('stock.f5d1644f')}</h3>
                  <div className="stock-analysis-meta-strip compact">
                    <span
                      className={`stock-analysis-meta-chip ${
                        isConfigDirty ? 'fresh' : 'subtle'
                      }`}
                    >
                      {isConfigDirty
                        ? t('stock.fd8203b9', { count: configDirtyKeys.length })
                        : t('stock.config.inSync')}
                    </span>
                    <span className="stock-analysis-meta-chip subtle">
                      {t('stock.9b601b8e')} {configVersion}
                    </span>
                    {configUpdatedAt ? (
                      <span className="stock-analysis-meta-chip subtle">
                        {t('stock.3a6d9cd5')} {formatDateTime(configUpdatedAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  className="modal-close-btn"
                  type="button"
                  onClick={() => setIsConfigModalOpen(false)}
                  aria-label={t('stock.config.closeConfigDialog')}
                >
                  ×
                </button>
              </div>
              <div className="stock-analysis-config-toolbar">
                <div className="stock-analysis-config-preset-group">
                  <div className="stock-analysis-subtle">{t('stock.9c45bf00')}</div>
                  <div className="tasks-presets stock-analysis-config-presets">
                    {builtinConfigPresets.map((preset) => (
                      <button
                        key={preset.id}
                        className={`tasks-preset-chip ${
                          activeConfigPreset?.id === preset.id ? 'active' : ''
                        }`}
                        type="button"
                        onClick={() => handleApplyConfigPreset(preset)}
                      >
                        {preset.title}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="stock-analysis-config-preset-group">
                  <div className="stock-analysis-subtle">{t('stock.7d52ef52')}</div>
                  <div className="stock-analysis-preset-form">
                    <input
                      className="settings-input"
                      type="text"
                      value={presetTitleInput}
                      onChange={(event) =>
                        setPresetTitleInput(event.target.value)
                      }
                      placeholder={t('stock.config.saveHint')}
                    />
                    <button
                      className="btn-outline btn-sm"
                      type="button"
                      onClick={handleSaveConfigPreset}
                      disabled={savingPreset}
                    >
                      {savingPreset
                        ? t('stock.btn.saving')
                        : activeConfigPreset?.kind === 'custom' &&
                            activeConfigPreset.title === presetTitleInput.trim()
                          ? t('stock.action.updatePreset')
                          : t('stock.action.savePreset')}
                    </button>
                  </div>
                  {customConfigPresets.length ? (
                    <div className="stock-analysis-custom-preset-list">
                      {customConfigPresets.map((preset) => (
                        <div
                          key={preset.id}
                          className={`stock-analysis-custom-preset-chip ${
                            activeConfigPreset?.id === preset.id ? 'active' : ''
                          }`}
                        >
                          <button
                            className="stock-analysis-custom-preset-main"
                            type="button"
                            onClick={() => handleApplyConfigPreset(preset)}
                          >
                            {preset.title}
                          </button>
                          <button
                            className="stock-analysis-custom-preset-delete"
                            type="button"
                            onClick={() => handleDeleteConfigPreset(preset)}
                            disabled={deletingPresetId === preset.id}
                            aria-label={t('stock.action.deletePreset', { title: preset.title })}
                          >
                            {deletingPresetId === preset.id ? '...' : '×'}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-hint">
                      {t('stock.f9fa5d4e')}
                    </div>
                  )}
                </div>
              </div>
              <div className="stock-analysis-config-sections">
                {configMeta.map((section) => (
                  <div key={section.id} className="settings-section">
                    <div className="section-header">
                      <h3>{section.title}</h3>
                    </div>
                    <div className="stock-analysis-config-grid">
                      {section.fields.map((field) => {
                        const fieldValue = config[field.key];
                        return (
                          <label key={field.key} className="settings-field">
                            <span className="settings-label">
                              {field.title}
                            </span>
                            {field.type === 'switch' ? (
                              <div className="settings-switch">
                                <input
                                  type="checkbox"
                                  checked={fieldValue === true}
                                  onChange={(event) =>
                                    handleConfigChange(
                                      field.key,
                                      event.target.checked,
                                    )
                                  }
                                />
                                <span>
                                  {fieldValue === true ? t('stock.status.enabled') : t('stock.status.disabled')}
                                </span>
                              </div>
                            ) : field.type === 'select' ? (
                              <NcSelect
                                className="settings-input"
                                value={String(fieldValue ?? '')}
                                onChange={(event) =>
                                  handleConfigChange(
                                    field.key,
                                    event.target.value,
                                  )
                                }
                              >
                                {(field.options || []).map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {option.label}
                                  </option>
                                ))}
                              </NcSelect>
                            ) : field.type === 'textarea' ? (
                              <textarea
                                className="settings-textarea"
                                value={String(fieldValue ?? '')}
                                onChange={(event) =>
                                  handleConfigChange(
                                    field.key,
                                    event.target.value,
                                  )
                                }
                              />
                            ) : (
                              <input
                                className="settings-input"
                                type={
                                  field.type === 'number' ? 'number' : 'text'
                                }
                                min={field.min}
                                max={field.max}
                                value={String(fieldValue ?? '')}
                                onChange={(event) =>
                                  handleConfigChange(
                                    field.key,
                                    field.type === 'number'
                                      ? Number(event.target.value)
                                      : event.target.value,
                                  )
                                }
                              />
                            )}
                            <span className="settings-hint">
                              {field.description}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="modal-actions stock-analysis-config-actions">
                <button
                  className="btn-outline"
                  type="button"
                  onClick={handleResetConfigDraft}
                  disabled={!isConfigDirty || savingConfig}
                >
                  {t('stock.action.discardUnsavedChanges')}
                </button>
                <button
                  className="btn-outline"
                  type="button"
                  onClick={handleResetConfigDefaults}
                  disabled={
                    savingConfig ||
                    Object.keys(configDefaults).length === 0 ||
                    serializeConfigMap(config) ===
                      serializeConfigMap(configDefaults)
                  }
                >
                  {t('stock.action.restoreDefaults')}
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={handleSaveConfig}
                  disabled={savingConfig}
                >
                  {savingConfig ? t('stock.btn.saving') : t('stock.config.save')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </div>
  );
}
