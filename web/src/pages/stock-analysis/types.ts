export type StockAnalysisTab =
  | 'workbench'
  | 'reports'
  | 'market'
  | 'portfolio';
export type StockAnalysisMarket = 'cn' | 'hk' | 'us';
export type StockMarketScope = StockAnalysisMarket | 'both' | 'all';
export type StockAnalysisReportType = 'brief' | 'standard' | 'detailed';
export type StockAnalysisStrategyPreset =
  | 'bull_trend'
  | 'shrink_pullback'
  | 'volume_breakout'
  | 'ma_golden_cross'
  | 'box_oscillation';
export type HistorySortMode =
  | 'latest'
  | 'score-desc'
  | 'score-asc'
  | 'change-desc'
  | 'change-asc';
export type StockAnalysisConfigValue = string | number | boolean;
export type StockAnalysisConfigMap = Record<string, StockAnalysisConfigValue>;

export interface StockAnalysisConfigResponse {
  config: StockAnalysisConfigMap;
  configVersion: string;
  updatedAt: string | null;
}

export interface StockAnalysisSelectOption {
  value: string;
  label: string;
}

export interface StockAnalysisConfigField {
  key: string;
  title: string;
  type: 'text' | 'textarea' | 'number' | 'switch' | 'select';
  description: string;
  min?: number;
  max?: number;
  options?: StockAnalysisSelectOption[];
}

export interface StockAnalysisConfigSection {
  id: string;
  title: string;
  fields: StockAnalysisConfigField[];
}

export interface StockAnalysisConfigPreset {
  id: string;
  title: string;
  description: string;
  values: StockAnalysisConfigMap;
  kind: 'builtin' | 'custom';
  createdAt?: string;
  updatedAt?: string;
}

export interface StockAnalysisConfigMetaResponse {
  sections: StockAnalysisConfigSection[];
  defaults: StockAnalysisConfigMap;
  presets: StockAnalysisConfigPreset[];
}

export interface StockAnalysisTask {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  status: 'pending' | 'running' | 'completed' | 'failed';
  reportType: StockAnalysisReportType;
  strategyPreset: StockAnalysisStrategyPreset;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  reportId: string | null;
  resultMode?: 'generated' | 'reused';
  dataAsOf?: string | null;
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
  tradeDate?: string | null;
  dataAsOf?: string | null;
  historyDays?: number | null;
  isCached?: boolean | null;
  reusedFromReportId?: string | null;
}

export interface StockAnalysisHistoryResponse {
  items: StockAnalysisHistoryItem[];
  total: number;
}

export interface StockAnalysisWatchlistItem {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  createdAt?: string;
  updatedAt: string;
}

export interface StockAnalysisStrategyInfo {
  id: StockAnalysisStrategyPreset;
  label: string;
  description: string;
  cacheKey: string;
  tuningNotes: string[];
}

export interface StockAnalysisReport {
  id: string;
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  reportType: StockAnalysisReportType;
  createdAt: string;
  tradeDate?: string | null;
  dataAsOf?: string | null;
  historyDays?: number | null;
  isCached?: boolean | null;
  reusedFromReportId?: string | null;
  modelUsed: string | null;
  score: number;
  trend: string;
  recommendation: string;
  strategy: StockAnalysisStrategyInfo;
  dataSource: {
    providerId: string;
    providerLabel: string;
    symbol: string;
    interval: string;
    priceSource: 'historical_close' | 'realtime_quote';
    priceSourceLabel: string;
    failoverTrace: string[];
  };
  metrics: {
    currentPrice: number;
    previousClose: number | null;
    changePct: number | null;
    biasToMa20: number | null;
    ma20: number | null;
    ma60: number | null;
    high20: number | null;
    low20: number | null;
    macdDiff: number | null;
    macdSignal: number | null;
    macdHistogram: number | null;
    rsi14: number | null;
    momentum20: number | null;
    annualizedVolatility: number | null;
  };
  summary: {
    headline: string;
    analysisSummary: string;
    operationAdvice: string;
    riskSignals: string[];
    catalystSignals: string[];
  };
  details: {
    heuristicNotes: string[];
    supportLevels: number[];
    resistanceLevels: number[];
    recentCloses: number[];
    recentBars: Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number | null;
      ma20: number | null;
      ma60: number | null;
    }>;
    factorScores: Array<{
      key: string;
      title: string;
      score: number;
      maxScore: number;
      signal: 'positive' | 'neutral' | 'negative';
      summary: string;
    }>;
    tradePlan: {
      idealBuy: number | null;
      secondaryBuy: number | null;
      stopLoss: number | null;
      takeProfit: number | null;
      style: string;
    };
    newsIntel: {
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
      references: Array<{
        title: string;
        source: string;
        publishedAt: string | null;
        summary: string;
        url: string | null;
      }>;
      relatedSectors?: string[];
      sectorSignals?: string[];
      peerSignals?: string[];
      policySignals?: string[];
      evidence: Array<{
        title: string;
        source: string;
        publishedAt: string | null;
        summary: string;
        url: string | null;
        sourceType: 'provider_reference' | 'fallback_snippet';
        fetchedAt: string | null;
        freshnessScore: number | null;
        qualityScore: number | null;
        includedInSummary: boolean;
        dropReason: string | null;
      }>;
      evidenceStats: {
        total: number;
        included: number;
        dropped: number;
        stale: number;
        undated: number;
        lowQuality: number;
      };
    };
  };
}

export interface StockMarketReview {
  id: string;
  marketScope: StockMarketScope;
  createdAt: string;
  tradeDate?: string | null;
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
      priceSource: 'historical_close' | 'realtime_quote';
      priceSourceLabel: string;
      dataAsOf?: string | null;
    }>;
    dataAsOfDates?: string[];
    notes: string[];
  };
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
  strategies: Array<{
    strategy: StockAnalysisStrategyInfo;
    sampleSize: number;
    evaluatedCount: number;
    bullishSampleSize: number;
    bullishWinRate: number | null;
    avgReturnPct: number | null;
  }>;
  recentEvaluations: Array<{
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
  }>;
  notes: string[];
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
  tradePlan: {
    idealBuy: number | null;
    secondaryBuy: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    style: string;
  };
}

export interface StockAnalysisReportDetailBundle {
  report: StockAnalysisReport;
  validation: StockAnalysisReportValidation | null;
  dashboard: StockAnalysisDecisionDashboard | null;
}

export interface StockAnalysisBacktestRequest {
  strategyPreset?: StockAnalysisStrategyPreset;
  stockCode?: string;
  limit?: number;
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
  exitPrice: number;
  holdingDays: number;
  returnPct: number;
  takeProfitHit: boolean;
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

export interface StockAnalysisDataProviderStatus {
  providerId: 'yahoo' | 'efinance' | 'akshare';
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
  activeProvider: 'yahoo' | 'efinance' | 'akshare';
  providers: StockAnalysisDataProviderStatus[];
  failoverEnabled: boolean;
}

export interface StockAnalysisPageProps {
  apiBase: string;
}

export interface StockAnalysisAnalyzeResponse {
  accepted: StockAnalysisTask[];
  rejected: Array<{ stockCode: string; error: string }>;
}

export interface StockAnalysisWatchlistMutationResponse {
  items: StockAnalysisWatchlistItem[];
  rejected: Array<{ stockCode: string; error: string }>;
}

export interface StockAnalysisConfigPresetListResponse {
  items: StockAnalysisConfigPreset[];
}

export interface StockAnalysisConfigPresetMutationResponse {
  ok: boolean;
  preset: StockAnalysisConfigPreset;
}

export interface StockPickerCandidate {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  reportId: string;
  score: number;
  trend: string;
  recommendation: string;
  dataAsOf?: string | null;
  createdAt: string;
}
