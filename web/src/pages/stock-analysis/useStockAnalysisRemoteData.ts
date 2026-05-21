import { useCallback, useEffect, useRef, useState } from 'react';

import i18n from '../../i18n/index.ts';
import {
  addWatchlistItems,
  clearTaskAnalyses,
  deleteTaskAnalysis,
  deleteConfigPresetDraft,
  fetchConfigBundle,
  fetchConfigPresetItems,
  fetchDataProviderReport,
  fetchFeedbackSnapshot,
  fetchHistory,
  fetchMarketReview,
  fetchReportDetailBundle,
  fetchReportDetail,
  fetchReportValidation,
  fetchTasks,
  fetchWatchlistItems,
  removeWatchlistItem,
  retryTaskAnalysis,
  runMarketReviewNow,
  saveConfigPresetDraft,
  saveStockAnalysisConfig,
} from './api';
import type {
  StockAnalysisAnalyzeResponse,
  StockAnalysisConfigMap,
  StockAnalysisConfigMetaResponse,
  StockAnalysisConfigPreset,
  StockAnalysisDecisionDashboard,
  StockAnalysisDataProviderReport,
  StockAnalysisFeedbackSnapshot,
  StockAnalysisHistoryItem,
  StockAnalysisReport,
  StockAnalysisReportValidation,
  StockAnalysisTask,
  StockAnalysisWatchlistItem,
  StockAnalysisWatchlistMutationResponse,
  StockMarketReview,
  StockMarketScope,
} from './types';

const HISTORY_PAGE_SIZE = 20;

export function sortTasksByLatest(
  tasks: StockAnalysisTask[],
): StockAnalysisTask[] {
  return [...tasks].sort((left, right) => {
    const leftTime = new Date(
      left.completedAt || left.startedAt || left.createdAt,
    ).getTime();
    const rightTime = new Date(
      right.completedAt || right.startedAt || right.createdAt,
    ).getTime();
    return rightTime - leftTime;
  });
}

export function buildUnavailableValidation(
  detail: StockAnalysisReport,
): StockAnalysisReportValidation {
  return {
    status: 'unavailable',
    targetDate: detail.dataAsOf || detail.createdAt,
    nextTradingDate: null,
    verdict: 'pending',
    matchScore: null,
    nextDayReturnPct: null,
    nextDayClose: null,
    summary: i18n.t('validation.unavailableSummary', { ns: 'stock' }),
    reasons: [i18n.t('validation.unavailableReason', { ns: 'stock' })],
  };
}

export function resolveHistorySelection(
  items: StockAnalysisHistoryItem[],
  selectedReportId?: string | null,
): string | null {
  if (items.length === 0) {
    return null;
  }
  if (!selectedReportId) {
    return items[0]?.id ?? null;
  }
  return items.some((item) => item.id === selectedReportId)
    ? selectedReportId
    : null;
}

export function applyTaskStreamUpdate(
  activeTasks: StockAnalysisTask[],
  recentTaskResults: StockAnalysisTask[],
  task: StockAnalysisTask,
): {
  activeTasks: StockAnalysisTask[];
  recentTaskResults: StockAnalysisTask[];
  shouldRefreshRelatedData: boolean;
} {
  if (task.status === 'pending' || task.status === 'running') {
    return {
      activeTasks: upsertTask(activeTasks, task),
      recentTaskResults: recentTaskResults.filter((item) => item.id !== task.id),
      shouldRefreshRelatedData: false,
    };
  }

  return {
    activeTasks: activeTasks.filter((item) => item.id !== task.id),
    recentTaskResults: upsertTask(recentTaskResults, task).slice(0, 20),
    shouldRefreshRelatedData: true,
  };
}

interface UseStockAnalysisRemoteDataOptions {
  apiBase: string;
  reviewScope: StockMarketScope;
  urlReportId?: string | null;
  onBootstrapError?: (message: string) => void;
  onConfigHydrated?: (config: StockAnalysisConfigMap) => void;
}

export function useStockAnalysisRemoteData({
  apiBase,
  reviewScope,
  urlReportId,
  onBootstrapError,
  onConfigHydrated,
}: UseStockAnalysisRemoteDataOptions) {
  const [configVersion, setConfigVersion] = useState('1');
  const [config, setConfig] = useState<StockAnalysisConfigMap>({});
  const [savedConfig, setSavedConfig] = useState<StockAnalysisConfigMap>({});
  const [configDefaults, setConfigDefaults] = useState<StockAnalysisConfigMap>(
    {},
  );
  const [configMeta, setConfigMeta] = useState<
    StockAnalysisConfigMetaResponse['sections']
  >([]);
  const [builtinConfigPresets, setBuiltinConfigPresets] = useState<
    StockAnalysisConfigPreset[]
  >([]);
  const [customConfigPresets, setCustomConfigPresets] = useState<
    StockAnalysisConfigPreset[]
  >([]);
  const [configUpdatedAt, setConfigUpdatedAt] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null);
  const [activeTasks, setActiveTasks] = useState<StockAnalysisTask[]>([]);
  const [recentTaskResults, setRecentTaskResults] = useState<
    StockAnalysisTask[]
  >([]);
  const [taskStreamConnected, setTaskStreamConnected] = useState(false);
  const [dataProviderReport, setDataProviderReport] =
    useState<StockAnalysisDataProviderReport | null>(null);
  const [history, setHistory] = useState<StockAnalysisHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [selectedReport, setSelectedReport] =
    useState<StockAnalysisReport | null>(null);
  const [selectedValidation, setSelectedValidation] =
    useState<StockAnalysisReportValidation | null>(null);
  const [selectedDashboard, setSelectedDashboard] =
    useState<StockAnalysisDecisionDashboard | null>(null);
  const [feedback, setFeedback] = useState<StockAnalysisFeedbackSnapshot | null>(
    null,
  );
  const [watchlist, setWatchlist] = useState<StockAnalysisWatchlistItem[]>([]);
  const [review, setReview] = useState<StockMarketReview | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [updatingWatchlist, setUpdatingWatchlist] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [clearingFailedTasks, setClearingFailedTasks] = useState(false);
  const activeTasksRef = useRef<StockAnalysisTask[]>([]);
  const recentTaskResultsRef = useRef<StockAnalysisTask[]>([]);
  const selectedReportIdRef = useRef<string | null>(null);
  const urlReportIdRef = useRef<string | null>(urlReportId ?? null);
  const historyLimitRef = useRef(HISTORY_PAGE_SIZE);
  const historyOffsetRef = useRef(0);

  const loadConfig = useCallback(async () => {
    const { configResponse, metaResponse } = await fetchConfigBundle(apiBase);
    setConfig({ ...configResponse.config });
    setSavedConfig({ ...configResponse.config });
    setConfigVersion(configResponse.configVersion);
    setConfigUpdatedAt(configResponse.updatedAt);
    setConfigMeta(metaResponse.sections);
    setConfigDefaults({ ...metaResponse.defaults });
    setBuiltinConfigPresets(
      metaResponse.presets.map((preset) => ({
        ...preset,
        values: { ...preset.values },
        kind: 'builtin' as const,
      })),
    );
    onConfigHydrated?.(configResponse.config);
  }, [apiBase, onConfigHydrated]);

  const loadTasks = useCallback(
    async (statuses?: string, limit = 20): Promise<StockAnalysisTask[]> =>
      fetchTasks(apiBase, statuses, limit),
    [apiBase],
  );

  const loadActiveTasks = useCallback(async () => {
    setActiveTasks(sortTasksByLatest(await loadTasks('pending,running', 20)));
  }, [loadTasks]);

  const loadRecentTaskResults = useCallback(async () => {
    setRecentTaskResults(
      sortTasksByLatest(await loadTasks('completed,failed', 20)),
    );
  }, [loadTasks]);

  const loadDataProviderStatus = useCallback(async () => {
    setDataProviderReport(await fetchDataProviderReport(apiBase));
  }, [apiBase]);

  const loadWatchlist = useCallback(async () => {
    setWatchlist(await fetchWatchlistItems(apiBase));
  }, [apiBase]);

  const loadConfigPresets = useCallback(async () => {
    setCustomConfigPresets(
      (await fetchConfigPresetItems(apiBase)).map((preset) => ({
        ...preset,
        values: { ...preset.values },
        kind: 'custom' as const,
      })),
    );
  }, [apiBase]);

  const loadReportDetail = useCallback(
    async (reportId: string) => {
      setSelectedValidation(null);
      setSelectedDashboard(null);
      try {
        const bundle = await fetchReportDetailBundle(apiBase, reportId);
        selectedReportIdRef.current = bundle.report.id;
        setSelectedReport(bundle.report);
        setSelectedDashboard(bundle.dashboard);
        setSelectedValidation(
          bundle.validation || buildUnavailableValidation(bundle.report),
        );
        return bundle.report;
      } catch {
        const detail = await fetchReportDetail(apiBase, reportId);
        selectedReportIdRef.current = detail.id;
        setSelectedReport(detail);
        void fetchReportValidation(apiBase, reportId)
          .then((validation) => {
            setSelectedValidation(validation);
          })
          .catch(() => {
            setSelectedValidation(buildUnavailableValidation(detail));
          });
        return detail;
      }
    },
    [apiBase],
  );

  const loadHistory = useCallback(
    async (
      options: {
        selectedReportId?: string | null;
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const limit = Math.max(1, options.limit ?? historyLimitRef.current);
      const offset = Math.max(0, options.offset ?? historyOffsetRef.current);
      const response = await fetchHistory(apiBase, limit, offset);
      historyLimitRef.current = limit;
      historyOffsetRef.current = offset;
      setHistoryLimit(limit);
      setHistoryOffset(offset);
      setHistory(response.items);
      setHistoryTotal(response.total);
      if (response.items.length === 0) {
        if (urlReportIdRef.current) {
          await loadReportDetail(urlReportIdRef.current);
          return;
        }
        if (response.total > 0 && offset > 0) {
          const fallbackOffset = Math.max(0, offset - limit);
          await loadHistory({
            selectedReportId: options.selectedReportId,
            limit,
            offset: fallbackOffset,
          });
          return;
        }
        selectedReportIdRef.current = null;
        setSelectedReport(null);
        setSelectedValidation(null);
        setSelectedDashboard(null);
        return;
      }

      const requestedReportId =
        options.selectedReportId ??
        urlReportIdRef.current ??
        selectedReportIdRef.current;
      const selectedReportId = resolveHistorySelection(response.items, requestedReportId);
      if (!selectedReportId) {
        if (requestedReportId && requestedReportId === urlReportIdRef.current) {
          await loadReportDetail(requestedReportId);
          return;
        }
        await loadReportDetail(response.items[0].id);
        return;
      }

      const matched = response.items.find((item) => item.id === selectedReportId);
      if (!matched) {
        await loadReportDetail(response.items[0].id);
        return;
      }

      await loadReportDetail(matched.id);
    },
    [apiBase, loadReportDetail],
  );

  const clearSelectedReport = useCallback(() => {
    selectedReportIdRef.current = null;
    setSelectedReport(null);
    setSelectedValidation(null);
    setSelectedDashboard(null);
  }, []);

  const loadFeedback = useCallback(async () => {
    setFeedback(await fetchFeedbackSnapshot(apiBase));
  }, [apiBase]);

  const loadReview = useCallback(async () => {
    setReview(await fetchMarketReview(apiBase, reviewScope));
  }, [apiBase, reviewScope]);

  const refreshAfterAnalyze = useCallback(async () => {
    await Promise.all([
      loadActiveTasks(),
      loadRecentTaskResults(),
      loadDataProviderStatus(),
      loadHistory(),
    ]);
  }, [
    loadActiveTasks,
    loadDataProviderStatus,
    loadHistory,
    loadRecentTaskResults,
  ]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      loadConfig(),
      loadConfigPresets(),
      loadActiveTasks(),
      loadRecentTaskResults(),
      loadDataProviderStatus(),
      loadHistory(),
      loadFeedback(),
      loadWatchlist(),
    ]);
  }, [
    loadActiveTasks,
    loadConfig,
    loadConfigPresets,
    loadDataProviderStatus,
    loadFeedback,
    loadHistory,
    loadRecentTaskResults,
    loadWatchlist,
  ]);

  const loadMoreHistory = useCallback(async () => {
    setLoadingMoreHistory(true);
    try {
      await loadHistory({
        selectedReportId: selectedReportIdRef.current,
        limit: historyLimitRef.current,
        offset: historyOffsetRef.current + historyLimitRef.current,
      });
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [loadHistory]);

  const setHistoryPage = useCallback(
    async (page: number): Promise<void> => {
      const nextPage = Math.max(1, page);
      setLoadingMoreHistory(true);
      try {
        await loadHistory({
          selectedReportId: selectedReportIdRef.current,
          limit: historyLimitRef.current,
          offset: (nextPage - 1) * historyLimitRef.current,
        });
      } finally {
        setLoadingMoreHistory(false);
      }
    },
    [loadHistory],
  );

  const setHistoryPageSize = useCallback(
    async (pageSize: number): Promise<void> => {
      const nextLimit = Math.max(1, pageSize);
      setLoadingMoreHistory(true);
      try {
        await loadHistory({
          selectedReportId: selectedReportIdRef.current,
          limit: nextLimit,
          offset: 0,
        });
      } finally {
        setLoadingMoreHistory(false);
      }
    },
    [loadHistory],
  );

  const retryTask = useCallback(
    async (taskId: string): Promise<StockAnalysisAnalyzeResponse> => {
      setRetryingTaskId(taskId);
      try {
        const response = await retryTaskAnalysis(apiBase, taskId);
        await Promise.all([
          loadActiveTasks(),
          loadRecentTaskResults(),
          loadDataProviderStatus(),
        ]);
        return response;
      } finally {
        setRetryingTaskId(null);
      }
    },
    [apiBase, loadActiveTasks, loadDataProviderStatus, loadRecentTaskResults],
  );

  const deleteTaskResult = useCallback(
    async (taskId: string): Promise<void> => {
      setDeletingTaskId(taskId);
      try {
        await deleteTaskAnalysis(apiBase, taskId);
        await Promise.all([
          loadActiveTasks(),
          loadRecentTaskResults(),
          loadDataProviderStatus(),
        ]);
      } finally {
        setDeletingTaskId(null);
      }
    },
    [apiBase, loadActiveTasks, loadDataProviderStatus, loadRecentTaskResults],
  );

  const clearFailedTaskResults = useCallback(async (): Promise<void> => {
    setClearingFailedTasks(true);
    try {
      await clearTaskAnalyses(apiBase, 'failed');
      await Promise.all([
        loadActiveTasks(),
        loadRecentTaskResults(),
        loadDataProviderStatus(),
      ]);
    } finally {
      setClearingFailedTasks(false);
    }
  }, [apiBase, loadActiveTasks, loadDataProviderStatus, loadRecentTaskResults]);

  const addWatchlist = useCallback(
    async (input: {
      stockCodes: string[];
      marketScope: StockMarketScope;
    }): Promise<StockAnalysisWatchlistMutationResponse> => {
      setUpdatingWatchlist(true);
      try {
        const response = await addWatchlistItems(apiBase, input);
        await loadWatchlist();
        return response;
      } finally {
        setUpdatingWatchlist(false);
      }
    },
    [apiBase, loadWatchlist],
  );

  const removeWatchlist = useCallback(
    async (stockCode: string): Promise<void> => {
      setUpdatingWatchlist(true);
      try {
        await removeWatchlistItem(apiBase, stockCode);
        await loadWatchlist();
      } finally {
        setUpdatingWatchlist(false);
      }
    },
    [apiBase, loadWatchlist],
  );

  const runReview = useCallback(async (): Promise<StockMarketReview> => {
    setLoadingReview(true);
    try {
      const nextReview = await runMarketReviewNow(apiBase, reviewScope);
      setReview(nextReview);
      return nextReview;
    } finally {
      setLoadingReview(false);
    }
  }, [apiBase, reviewScope]);

  const saveConfigPreset = useCallback(
    async (input: {
      id?: string;
      title: string;
      config: StockAnalysisConfigMap;
    }): Promise<{ preset: StockAnalysisConfigPreset }> => {
      setSavingPreset(true);
      try {
        const response = await saveConfigPresetDraft(apiBase, input);
        await loadConfigPresets();
        return { preset: response.preset };
      } finally {
        setSavingPreset(false);
      }
    },
    [apiBase, loadConfigPresets],
  );

  const deleteConfigPreset = useCallback(
    async (presetId: string): Promise<void> => {
      setDeletingPresetId(presetId);
      try {
        await deleteConfigPresetDraft(apiBase, presetId);
        await loadConfigPresets();
      } finally {
        setDeletingPresetId(null);
      }
    },
    [apiBase, loadConfigPresets],
  );

  const saveConfig = useCallback(
    async (input: {
      configVersion: string;
      config: StockAnalysisConfigMap;
    }): Promise<{ configVersion: string }> => {
      setSavingConfig(true);
      try {
        const response = await saveStockAnalysisConfig(apiBase, input);
        setConfigVersion(response.configVersion);
        await Promise.all([loadConfig(), loadFeedback()]);
        return response;
      } finally {
        setSavingConfig(false);
      }
    },
    [apiBase, loadConfig, loadFeedback],
  );

  useEffect(() => {
    activeTasksRef.current = activeTasks;
  }, [activeTasks]);

  useEffect(() => {
    recentTaskResultsRef.current = recentTaskResults;
  }, [recentTaskResults]);

  useEffect(() => {
    selectedReportIdRef.current = selectedReport?.id ?? null;
  }, [selectedReport?.id]);

  useEffect(() => {
    urlReportIdRef.current = urlReportId ?? null;
  }, [urlReportId]);

  useEffect(() => {
    historyLimitRef.current = historyLimit;
  }, [historyLimit]);

  useEffect(() => {
    historyOffsetRef.current = historyOffset;
  }, [historyOffset]);

  useEffect(() => {
    void refreshAll().catch((error) => {
      onBootstrapError?.(error instanceof Error ? error.message : i18n.t('msg.bootstrapFailed', { ns: 'stock' }));
    });
  }, [onBootstrapError, refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadHistory({
        selectedReportId: selectedReportIdRef.current,
        limit: historyLimitRef.current,
        offset: historyOffsetRef.current,
      }).catch(() => {});
      void loadFeedback().catch(() => {});
      void loadDataProviderStatus().catch(() => {});
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadDataProviderStatus, loadFeedback, loadHistory]);

  useEffect(() => {
    void loadReview().catch(() => {});
  }, [loadReview]);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/stock-analysis/tasks/stream`, {
      withCredentials: true,
    });

    const handleTaskEvent = (event: MessageEvent<string>) => {
      try {
        const task = JSON.parse(event.data) as StockAnalysisTask;
        const nextState = applyTaskStreamUpdate(
          activeTasksRef.current,
          recentTaskResultsRef.current,
          task,
        );
        setActiveTasks(nextState.activeTasks);
        setRecentTaskResults(nextState.recentTaskResults);
        if (!nextState.shouldRefreshRelatedData) {
          return;
        }
        void Promise.all([
          loadHistory({
            selectedReportId: selectedReportIdRef.current,
            limit: historyLimitRef.current,
            offset: historyOffsetRef.current,
          }),
          loadFeedback(),
          loadDataProviderStatus(),
        ]).catch(() => {});
      } catch {
        // Ignore malformed task events.
      }
    };

    stream.addEventListener('connected', () => {
      setTaskStreamConnected(true);
    });
    stream.addEventListener('task', handleTaskEvent as EventListener);
    stream.addEventListener('heartbeat', () => {
      setTaskStreamConnected(true);
    });
    stream.onerror = () => {
      setTaskStreamConnected(false);
    };

    return () => {
      setTaskStreamConnected(false);
      stream.close();
    };
  }, [
    apiBase,
    loadDataProviderStatus,
    loadFeedback,
    loadHistory,
  ]);

  return {
    activeTasks,
    addWatchlist,
    builtinConfigPresets,
    config,
    configDefaults,
    configMeta,
    configUpdatedAt,
    clearFailedTaskResults,
    clearSelectedReport,
    configVersion,
    customConfigPresets,
    dataProviderReport,
    deleteConfigPreset,
    deleteTaskResult,
    deletingPresetId,
    deletingTaskId,
    feedback,
    history,
    historyLimit,
    historyOffset,
    historyTotal,
    loadMoreHistory,
    loadReportDetail,
    loadingMoreHistory,
    setHistoryPage,
    setHistoryPageSize,
    loadingReview,
    refreshAfterAnalyze,
    recentTaskResults,
    removeWatchlist,
    retryTask,
    retryingTaskId,
    review,
    runReview,
    savedConfig,
    saveConfig,
    saveConfigPreset,
    clearingFailedTasks,
    savingConfig,
    savingPreset,
    selectedReport,
    selectedDashboard,
    selectedValidation,
    setConfig,
    taskStreamConnected,
    updatingWatchlist,
    watchlist,
  };
}

export function upsertTask(
  tasks: StockAnalysisTask[],
  task: StockAnalysisTask,
): StockAnalysisTask[] {
  const next = tasks.filter((item) => item.id !== task.id);
  next.unshift(task);
  return sortTasksByLatest(next).slice(0, 20);
}
