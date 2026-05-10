export type StockAnalysisMarket = 'cn' | 'hk' | 'us';
export type StockAnalysisMarketScope = StockAnalysisMarket | 'all' | 'both';
export type StockAnalysisReportType = 'brief' | 'standard' | 'detailed';
export type StockAnalysisMaType = 'sma' | 'ema';
export type StockAnalysisStrategyPreset =
  | 'bull_trend'
  | 'shrink_pullback'
  | 'volume_breakout'
  | 'ma_golden_cross'
  | 'box_oscillation';

/** Data provider identifier for multi-source failover. */
export type StockAnalysisDataProviderId =
  | 'yahoo'
  | 'efinance'
  | 'akshare';
export type StockAnalysisPriceSource = 'historical_close' | 'realtime_quote';

/** Trend state classification (7-level). */
export type StockAnalysisTrendState =
  | 'strong_bullish'
  | 'bullish'
  | 'weak_bullish'
  | 'neutral'
  | 'weak_bearish'
  | 'bearish'
  | 'strong_bearish';

/** Volume state classification (5-level). */
export type StockAnalysisVolumeState =
  | 'heavy_volume'
  | 'increased_volume'
  | 'normal'
  | 'decreased_volume'
  | 'extremely_low_volume';

/** MACD state classification (7-level). */
export type StockAnalysisMacdState =
  | 'golden_cross_above_zero'
  | 'golden_cross_below_zero'
  | 'bullish_above_zero'
  | 'neutral'
  | 'bearish_below_zero'
  | 'death_cross_above_zero'
  | 'death_cross_below_zero';

/** RSI state classification (5-level). */
export type StockAnalysisRsiState =
  | 'overbought'
  | 'strong'
  | 'neutral'
  | 'weak'
  | 'oversold';
export type StockAnalysisTaskResultMode = 'generated' | 'reused';
export type StockAnalysisTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface StockAnalysisTaskSummary {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  status: StockAnalysisTaskStatus;
  reportType: StockAnalysisReportType;
  strategyPreset: StockAnalysisStrategyPreset;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  reportId: string | null;
  resultMode: StockAnalysisTaskResultMode;
  dataAsOf: string | null;
}

export interface StockAnalysisTaskCollection {
  active: StockAnalysisTaskSummary[];
  recent: StockAnalysisTaskSummary[];
  failed: StockAnalysisTaskSummary[];
  pendingCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
}

export interface StockAnalysisWatchlistItem {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  createdAt: string;
  updatedAt: string;
}

export interface StockAnalysisHistoryItem {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  reportType: StockAnalysisReportType;
  score: number;
  trend: string;
  recommendation: string;
  currentPrice: number | null;
  changePct: number | null;
  createdAt: string;
  dataAsOf: string | null;
  historyDays: number;
}

export interface StockAnalysisMetricSnapshot {
  currentPrice: number;
  previousClose: number | null;
  changePct: number | null;
  /** Short-term moving averages. */
  ma5: number | null;
  ma10: number | null;
  biasToMa5: number | null;
  biasToMa20: number | null;
  ma20: number | null;
  ma60: number | null;
  high20: number | null;
  low20: number | null;
  /** MA alignment: true when MA5 > MA10 > MA20 > MA60. */
  maAligned: boolean;
  macdDiff: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  /** MACD state classification. */
  macdState: StockAnalysisMacdState;
  /** Multi-period RSI. */
  rsi6: number | null;
  rsi12: number | null;
  rsi14: number | null;
  rsi24: number | null;
  /** RSI state classification based on RSI14. */
  rsiState: StockAnalysisRsiState;
  momentum20: number | null;
  annualizedVolatility: number | null;
  /** Volume analysis. */
  volumeRatio5d20d: number | null;
  volumeState: StockAnalysisVolumeState;
  /** Trend state classification. */
  trendState: StockAnalysisTrendState;
  /** 60-day return percentage. */
  return60d: number | null;
  /** Bollinger Band upper (MA20 + 2σ). */
  bollingerUpper: number | null;
  /** Bollinger Band lower (MA20 − 2σ). */
  bollingerLower: number | null;
  /** Bollinger Band width as percentage of MA20. */
  bollingerWidth: number | null;
  /** Average True Range (14-period). */
  atr14: number | null;
}

export interface StockAnalysisSummary {
  headline: string;
  analysisSummary: string;
  operationAdvice: string;
  riskSignals: string[];
  catalystSignals: string[];
}

export interface StockAnalysisChartBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
}

export interface StockAnalysisDataSource {
  providerId: string;
  providerLabel: string;
  symbol: string;
  interval: string;
  priceSource: StockAnalysisPriceSource;
  priceSourceLabel: string;
  failoverTrace: string[];
}

export interface StockAnalysisFactorScore {
  key: string;
  title: string;
  score: number;
  maxScore: number;
  signal: 'positive' | 'neutral' | 'negative';
  summary: string;
}

export interface StockAnalysisTradePlan {
  idealBuy: number | null;
  secondaryBuy: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  style: string;
}

export interface PipelineStageLog {
  stage: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
}

export interface StockAnalysisNewsReference {
  title: string;
  source: string;
  publishedAt: string | null;
  summary: string;
  url: string | null;
}

export interface StockAnalysisNewsEvidence extends StockAnalysisNewsReference {
  sourceType: 'provider_reference' | 'fallback_snippet';
  fetchedAt: string | null;
  freshnessScore: number | null;
  qualityScore: number | null;
  includedInSummary: boolean;
  dropReason: string | null;
}

export interface StockAnalysisNewsEvidenceStats {
  total: number;
  included: number;
  dropped: number;
  stale: number;
  undated: number;
  lowQuality: number;
}

export interface StockAnalysisNewsIntel {
  status: 'ready' | 'disabled' | 'unavailable';
  sourceType: 'provider_web_search' | 'fallback_news_feed' | 'none';
  sourceLabel: string;
  usedExternalSearch: boolean;
  generatedAt: string | null;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  hotTopics: string[];
  bullishSignals: string[];
  riskSignals: string[];
  references: StockAnalysisNewsReference[];
  relatedSectors?: string[];
  sectorSignals?: string[];
  peerSignals?: string[];
  policySignals?: string[];
  evidence: StockAnalysisNewsEvidence[];
  evidenceStats: StockAnalysisNewsEvidenceStats;
}

export interface StockAnalysisStrategyInfo {
  id: StockAnalysisStrategyPreset;
  label: string;
  description: string;
  cacheKey: string;
  tuningNotes: string[];
}

export interface StockAnalysisDetail {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  reportType: StockAnalysisReportType;
  createdAt: string;
  modelUsed: string | null;
  score: number;
  trend: string;
  recommendation: string;
  dataAsOf: string | null;
  historyDays: number;
  strategy: StockAnalysisStrategyInfo;
  dataSource: StockAnalysisDataSource;
  metrics: StockAnalysisMetricSnapshot;
  summary: StockAnalysisSummary;
  details: {
    heuristicNotes: string[];
    supportLevels: number[];
    resistanceLevels: number[];
    recentCloses: number[];
    recentBars: StockAnalysisChartBar[];
    factorScores: StockAnalysisFactorScore[];
    tradePlan: StockAnalysisTradePlan;
    newsIntel: StockAnalysisNewsIntel;
    pipelineLog: PipelineStageLog[];
  };
}

export interface StockAnalysisDecisionDashboard {
  signal: 'green' | 'yellow' | 'red';
  verdict: string;
  keyMetrics: {
    price: number;
    changePct: number | null;
    maAligned: boolean;
    trendState: string;
    macdState: string;
    rsiState: string;
    volumeState: string;
  };
  factorChart: Array<{
    key: string;
    title: string;
    score: number;
    maxScore: number;
  }>;
  tradePlan: StockAnalysisTradePlan;
}

export interface StockAnalysisReportDetailBundle {
  report: StockAnalysisDetail;
  validation: StockAnalysisReportValidation;
  dashboard: StockAnalysisDecisionDashboard | null;
}

export interface StockAnalysisReportValidation {
  status: 'validated' | 'pending' | 'unavailable';
  targetDate: string | null;
  nextTradingDate: string | null;
  verdict: 'matched' | 'partially_matched' | 'mismatched' | 'pending';
  matchScore: number | null;
  nextDayReturnPct: number | null;
  nextDayClose: number | null;
  summary: string;
  reasons: string[];
}

export interface StockAnalysisMarketReview {
  id: string;
  marketScope: StockAnalysisMarketScope;
  createdAt: string;
  tradeDate: string | null;
  modelUsed: string | null;
  summary: {
    headline: string;
    overview: string;
    stance: string;
    keySignals: string[];
  };
  detail: {
    indices: Array<{
      symbol: string;
      name: string;
      price: number | null;
      changePct: number | null;
      providerLabel: string;
      priceSource: StockAnalysisPriceSource;
      priceSourceLabel: string;
      dataAsOf: string | null;
    }>;
    dataAsOfDates: string[];
    notes: string[];
  };
}

export interface StockAnalysisWorkbenchResponse {
  defaults: {
    marketScope: StockAnalysisMarketScope;
    reportType: StockAnalysisReportType;
    strategyPreset: StockAnalysisStrategyPreset;
    reportCacheTtlMinutes: number;
  };
  tasks: StockAnalysisTaskCollection;
  watchlist: {
    count: number;
    items: StockAnalysisWatchlistItem[];
  };
  history: {
    total: number;
    recent: StockAnalysisHistoryItem[];
  };
  dataProviders: StockAnalysisDataProviderReport;
}

export interface StockAnalysisReportCenterResponse {
  history: {
    items: StockAnalysisHistoryItem[];
    total: number;
    limit: number;
    offset: number;
  };
  tasks: StockAnalysisTaskCollection;
  feedback: StockAnalysisFeedbackSnapshot;
}

export interface StockAnalysisMarketDashboardResponse {
  review: StockAnalysisMarketReview | null;
  backtest: StockAnalysisBacktestResult;
  dataProviders: StockAnalysisDataProviderReport;
}

export interface StockAnalysisPortfolioDashboardResponse {
  watchlist: {
    items: StockAnalysisWatchlistItem[];
    total: number;
  };
  latestReports: StockAnalysisHistoryItem[];
}

export interface StockAnalysisFeedbackEvaluation {
  reportId: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  strategy: StockAnalysisStrategyInfo;
  recommendation: string;
  score: number;
  reportCreatedAt: string;
  basePrice: number;
  evaluationCreatedAt: string;
  evaluationPrice: number;
  holdingDays: number;
  realizedReturnPct: number;
  outcome: 'win' | 'flat' | 'loss';
}

export interface StockAnalysisStrategyFeedbackSummary {
  strategy: StockAnalysisStrategyInfo;
  sampleSize: number;
  evaluatedCount: number;
  bullishSampleSize: number;
  bullishWinRate: number | null;
  avgReturnPct: number | null;
}

export interface StockAnalysisFeedbackSnapshot {
  generatedAt: string;
  lookaheadDays: number;
  winThresholdPct: number;
  lossThresholdPct: number;
  summary: {
    sampleSize: number;
    evaluatedCount: number;
    bullishSampleSize: number;
    bullishWinRate: number | null;
    avgReturnPct: number | null;
  };
  strategies: StockAnalysisStrategyFeedbackSummary[];
  recentEvaluations: StockAnalysisFeedbackEvaluation[];
  notes: string[];
}

/* ──────────── Backtest types ──────────── */

export interface StockAnalysisBacktestRequest {
  /** Filter by strategy; omit for all. */
  strategyPreset?: StockAnalysisStrategyPreset;
  /** Filter by stock; omit for all. */
  stockCode?: string;
  /** Max reports to evaluate. */
  limit?: number;
  /** Days to look ahead from report date. */
  lookaheadDays?: number;
}

export interface StockAnalysisBacktestTradeResult {
  reportId: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  strategy: StockAnalysisStrategyInfo;
  recommendation: string;
  score: number;
  reportCreatedAt: string;
  basePrice: number;
  /** Price N days later. */
  exitPrice: number;
  holdingDays: number;
  returnPct: number;
  /** Whether take-profit was hit. */
  takeProfitHit: boolean;
  /** Whether stop-loss was hit. */
  stopLossHit: boolean;
  directionCorrect: boolean;
  outcome: 'win' | 'flat' | 'loss';
}

export interface StockAnalysisBacktestStrategyResult {
  strategy: StockAnalysisStrategyInfo;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  winRate: number | null;
  avgReturnPct: number | null;
  directionAccuracy: number | null;
  takeProfitHitRate: number | null;
  stopLossHitRate: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
}

export interface StockAnalysisBacktestResult {
  generatedAt: string;
  lookaheadDays: number;
  totalTrades: number;
  overallWinRate: number | null;
  overallAvgReturnPct: number | null;
  overallDirectionAccuracy: number | null;
  strategies: StockAnalysisBacktestStrategyResult[];
  trades: StockAnalysisBacktestTradeResult[];
  notes: string[];
}

/* ──────────── Data provider failover types ──────────── */

export interface StockAnalysisDataProviderStatus {
  providerId: StockAnalysisDataProviderId;
  providerLabel: string;
  available: boolean;
  lastChecked: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
}

export interface StockAnalysisDataProviderReport {
  activeProvider: StockAnalysisDataProviderId;
  providers: StockAnalysisDataProviderStatus[];
  failoverEnabled: boolean;
}
