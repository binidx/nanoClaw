import type {
  StockAnalysisAnalyzeResponse,
  StockAnalysisBacktestRequest,
  StockAnalysisBacktestResult,
  StockAnalysisConfigMap,
  StockAnalysisConfigMetaResponse,
  StockAnalysisConfigPresetListResponse,
  StockAnalysisConfigPresetMutationResponse,
  StockAnalysisConfigResponse,
  StockAnalysisDataProviderReport,
  StockAnalysisFeedbackSnapshot,
  StockAnalysisHistoryResponse,
  StockAnalysisReportDetailBundle,
  StockAnalysisReport,
  StockAnalysisReportValidation,
  StockAnalysisStrategyPreset,
  StockAnalysisTask,
  StockAnalysisWatchlistItem,
  StockAnalysisWatchlistMutationResponse,
  StockMarketReview,
  StockMarketScope,
} from './types';

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchConfigBundle(apiBase: string): Promise<{
  configResponse: StockAnalysisConfigResponse;
  metaResponse: StockAnalysisConfigMetaResponse;
}> {
  const [configResponse, metaResponse] = await Promise.all([
    readJson<StockAnalysisConfigResponse>(`${apiBase}/api/stock-analysis/config`),
    readJson<StockAnalysisConfigMetaResponse>(
      `${apiBase}/api/stock-analysis/config/meta`,
    ),
  ]);
  return { configResponse, metaResponse };
}

export async function fetchTasks(
  apiBase: string,
  statuses?: string,
  limit = 20,
): Promise<StockAnalysisTask[]> {
  const response = await readJson<{ tasks: StockAnalysisTask[] }>(
    `${apiBase}/api/stock-analysis/tasks?limit=${limit}${
      statuses ? `&status=${encodeURIComponent(statuses)}` : ''
    }`,
  );
  return response.tasks;
}

export async function fetchDataProviderReport(
  apiBase: string,
): Promise<StockAnalysisDataProviderReport> {
  return readJson<StockAnalysisDataProviderReport>(
    `${apiBase}/api/stock-analysis/data-providers`,
  );
}

export async function fetchWatchlistItems(
  apiBase: string,
): Promise<StockAnalysisWatchlistItem[]> {
  const response = await readJson<{ items: StockAnalysisWatchlistItem[] }>(
    `${apiBase}/api/stock-analysis/watchlist`,
  );
  return response.items;
}

export async function fetchConfigPresetItems(
  apiBase: string,
): Promise<StockAnalysisConfigPresetListResponse['items']> {
  const response = await readJson<StockAnalysisConfigPresetListResponse>(
    `${apiBase}/api/stock-analysis/config/presets`,
  );
  return response.items;
}

export async function fetchHistory(
  apiBase: string,
  limit: number,
  offset = 0,
): Promise<StockAnalysisHistoryResponse> {
  return readJson<StockAnalysisHistoryResponse>(
    `${apiBase}/api/stock-analysis/history?limit=${limit}&offset=${offset}`,
  );
}

export async function fetchReportDetail(
  apiBase: string,
  reportId: string,
): Promise<StockAnalysisReport> {
  return readJson<StockAnalysisReport>(
    `${apiBase}/api/stock-analysis/history/${reportId}`,
  );
}

export async function fetchReportDetailBundle(
  apiBase: string,
  reportId: string,
): Promise<StockAnalysisReportDetailBundle> {
  return readJson<StockAnalysisReportDetailBundle>(
    `${apiBase}/api/stock-analysis/reports/${reportId}/detail-bundle`,
  );
}

export async function fetchReportValidation(
  apiBase: string,
  reportId: string,
): Promise<StockAnalysisReportValidation> {
  return readJson<StockAnalysisReportValidation>(
    `${apiBase}/api/stock-analysis/history/${reportId}/validation`,
  );
}

export async function fetchFeedbackSnapshot(
  apiBase: string,
): Promise<StockAnalysisFeedbackSnapshot> {
  return readJson<StockAnalysisFeedbackSnapshot>(
    `${apiBase}/api/stock-analysis/feedback`,
  );
}

export async function fetchMarketReview(
  apiBase: string,
  scope: StockMarketScope,
): Promise<StockMarketReview | null> {
  const response = await readJson<{ review: StockMarketReview | null }>(
    `${apiBase}/api/stock-analysis/market-review?scope=${scope}`,
  );
  return response.review;
}

export async function analyzeStocks(
  apiBase: string,
  input: {
    marketScope: StockMarketScope;
    stockCodes: string[];
    reportType: string;
    strategyPreset: StockAnalysisStrategyPreset;
    forceRefresh: boolean;
  },
): Promise<StockAnalysisAnalyzeResponse> {
  return readJson<StockAnalysisAnalyzeResponse>(
    `${apiBase}/api/stock-analysis/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function retryTaskAnalysis(
  apiBase: string,
  taskId: string,
): Promise<StockAnalysisAnalyzeResponse> {
  return readJson<StockAnalysisAnalyzeResponse>(
    `${apiBase}/api/stock-analysis/tasks/${taskId}/retry`,
    {
      method: 'POST',
    },
  );
}

export async function deleteTaskAnalysis(
  apiBase: string,
  taskId: string,
): Promise<void> {
  await readJson<{ ok: boolean }>(
    `${apiBase}/api/stock-analysis/tasks/${taskId}`,
    {
      method: 'DELETE',
    },
  );
}

export async function clearTaskAnalyses(
  apiBase: string,
  status: 'failed',
): Promise<void> {
  await readJson<{ ok: boolean }>(
    `${apiBase}/api/stock-analysis/tasks?status=${encodeURIComponent(status)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function addWatchlistItems(
  apiBase: string,
  input: {
    stockCodes: string[];
    marketScope: StockMarketScope;
  },
): Promise<StockAnalysisWatchlistMutationResponse> {
  return readJson<StockAnalysisWatchlistMutationResponse>(
    `${apiBase}/api/stock-analysis/watchlist`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function removeWatchlistItem(
  apiBase: string,
  stockCode: string,
): Promise<void> {
  await readJson<{ ok: boolean }>(
    `${apiBase}/api/stock-analysis/watchlist/${encodeURIComponent(stockCode)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function runMarketReviewNow(
  apiBase: string,
  marketScope: StockMarketScope,
): Promise<StockMarketReview> {
  const response = await readJson<{ review: StockMarketReview }>(
    `${apiBase}/api/stock-analysis/market-review/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketScope }),
    },
  );
  return response.review;
}

export async function runBacktestAnalysis(
  apiBase: string,
  input: StockAnalysisBacktestRequest,
): Promise<StockAnalysisBacktestResult> {
  return readJson<StockAnalysisBacktestResult>(
    `${apiBase}/api/stock-analysis/backtest`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function saveConfigPresetDraft(
  apiBase: string,
  input: {
    id?: string;
    title: string;
    config: StockAnalysisConfigMap;
  },
): Promise<StockAnalysisConfigPresetMutationResponse> {
  return readJson<StockAnalysisConfigPresetMutationResponse>(
    `${apiBase}/api/stock-analysis/config/presets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteConfigPresetDraft(
  apiBase: string,
  presetId: string,
): Promise<void> {
  await readJson<{ ok: boolean }>(
    `${apiBase}/api/stock-analysis/config/presets/${encodeURIComponent(
      presetId,
    )}`,
    {
      method: 'DELETE',
    },
  );
}

export async function saveStockAnalysisConfig(
  apiBase: string,
  input: {
    configVersion: string;
    config: StockAnalysisConfigMap;
  },
): Promise<{ configVersion: string }> {
  const response = await readJson<{ ok: boolean; configVersion: string }>(
    `${apiBase}/api/stock-analysis/config`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return { configVersion: response.configVersion };
}
