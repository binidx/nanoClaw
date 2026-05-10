import { describe, expect, it } from 'vitest';

import type {
  StockAnalysisHistoryItem,
  StockAnalysisReport,
  StockAnalysisTask,
} from './types';
import {
  applyTaskStreamUpdate,
  buildUnavailableValidation,
  resolveHistorySelection,
  sortTasksByLatest,
  upsertTask,
} from './useStockAnalysisRemoteData';

function createTask(
  id: string,
  status: StockAnalysisTask['status'],
  overrides: Partial<StockAnalysisTask> = {},
): StockAnalysisTask {
  return {
    id,
    stockCode: `CODE-${id}`,
    stockName: `Name ${id}`,
    market: 'cn',
    status,
    reportType: 'standard',
    strategyPreset: 'bull_trend',
    createdAt: '2026-03-18T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
    error: null,
    reportId: null,
    ...overrides,
  };
}

function createHistoryItem(
  id: string,
  overrides: Partial<StockAnalysisHistoryItem> = {},
): StockAnalysisHistoryItem {
  return {
    id,
    stockCode: `CODE-${id}`,
    stockName: `Name ${id}`,
    market: 'cn',
    reportType: 'standard',
    score: 80,
    trend: 'bullish',
    recommendation: '偏强跟踪',
    currentPrice: 10,
    changePct: 2,
    createdAt: '2026-03-18T09:00:00.000Z',
    ...overrides,
  };
}

function createReport(
  overrides: Partial<StockAnalysisReport> = {},
): StockAnalysisReport {
  return {
    id: 'report-1',
    stockCode: '600519',
    stockName: '贵州茅台',
    market: 'cn',
    reportType: 'standard',
    createdAt: '2026-03-18T09:00:00.000Z',
    tradeDate: '2026-03-18',
    dataAsOf: '2026-03-18T15:00:00.000Z',
    historyDays: 180,
    isCached: false,
    reusedFromReportId: null,
    modelUsed: 'gpt-5.4',
    score: 85,
    trend: 'bullish',
    recommendation: '偏强跟踪',
    strategy: {
      id: 'bull_trend',
      label: 'Bull Trend',
      description: 'trend following',
      cacheKey: 'bull_trend',
      tuningNotes: [],
    },
    dataSource: {
      providerId: 'yahoo',
      providerLabel: 'Yahoo',
      symbol: '600519.SS',
      interval: '1d',
      priceSource: 'historical_close',
      priceSourceLabel: 'Historical Close',
      failoverTrace: [],
    },
    metrics: {
      currentPrice: 1500,
      previousClose: 1490,
      changePct: 0.67,
      biasToMa20: 1.2,
      ma20: 1480,
      ma60: 1450,
      high20: 1520,
      low20: 1400,
      macdDiff: 1,
      macdSignal: 0.8,
      macdHistogram: 0.2,
      rsi14: 60,
      momentum20: 5,
      annualizedVolatility: 20,
    },
    summary: {
      headline: 'headline',
      analysisSummary: 'summary',
      operationAdvice: 'advice',
      riskSignals: [],
      catalystSignals: [],
    },
    details: {
      heuristicNotes: [],
      supportLevels: [],
      resistanceLevels: [],
      recentCloses: [],
      recentBars: [],
      factorScores: [],
      tradePlan: {
        idealBuy: null,
        secondaryBuy: null,
        stopLoss: null,
        takeProfit: null,
        style: 'swing',
      },
      newsIntel: {
        status: 'disabled',
        sourceType: 'none',
        sourceLabel: 'none',
        usedExternalSearch: false,
        generatedAt: null,
        confidence: 'low',
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
      },
    },
    ...overrides,
  };
}

describe('useStockAnalysisRemoteData helpers', () => {
  it('sorts tasks by latest completion, start, or creation time', () => {
    const completed = createTask('completed', 'completed', {
      createdAt: '2026-03-18T08:00:00.000Z',
      completedAt: '2026-03-18T10:00:00.000Z',
    });
    const running = createTask('running', 'running', {
      createdAt: '2026-03-18T07:00:00.000Z',
      startedAt: '2026-03-18T09:30:00.000Z',
    });
    const pending = createTask('pending', 'pending', {
      createdAt: '2026-03-18T09:00:00.000Z',
    });

    expect(sortTasksByLatest([running, pending, completed]).map((task) => task.id))
      .toEqual(['completed', 'running', 'pending']);
  });

  it('keeps only one task per id and caps recent results to 20 items', () => {
    const tasks = Array.from({ length: 20 }, (_item, index) =>
      createTask(`task-${index}`, 'completed', {
        completedAt: `2026-03-18T09:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );
    const updated = upsertTask(
      tasks,
      createTask('task-5', 'completed', {
        completedAt: '2026-03-18T10:30:00.000Z',
      }),
    );

    expect(updated).toHaveLength(20);
    expect(updated[0]?.id).toBe('task-5');
    expect(updated.filter((task) => task.id === 'task-5')).toHaveLength(1);
  });

  it('moves running tasks into active tasks without forcing dependent refresh', () => {
    const staleRunning = createTask('task-1', 'pending', {
      createdAt: '2026-03-18T08:00:00.000Z',
    });
    const recentResult = createTask('task-1', 'completed', {
      completedAt: '2026-03-18T09:00:00.000Z',
    });
    const nextRunning = createTask('task-1', 'running', {
      startedAt: '2026-03-18T10:00:00.000Z',
    });

    const nextState = applyTaskStreamUpdate(
      [staleRunning],
      [recentResult],
      nextRunning,
    );

    expect(nextState.shouldRefreshRelatedData).toBe(false);
    expect(nextState.activeTasks).toHaveLength(1);
    expect(nextState.activeTasks[0]).toMatchObject({
      id: 'task-1',
      status: 'running',
    });
    expect(nextState.recentTaskResults).toEqual([]);
  });

  it('moves completed tasks out of active tasks and requests related refresh', () => {
    const activeTasks = [
      createTask('task-1', 'running', {
        startedAt: '2026-03-18T10:00:00.000Z',
      }),
      createTask('task-2', 'pending'),
    ];
    const recentTaskResults = [createTask('task-3', 'completed')];
    const completedTask = createTask('task-1', 'completed', {
      completedAt: '2026-03-18T10:15:00.000Z',
      reportId: 'report-1',
    });

    const nextState = applyTaskStreamUpdate(
      activeTasks,
      recentTaskResults,
      completedTask,
    );

    expect(nextState.shouldRefreshRelatedData).toBe(true);
    expect(nextState.activeTasks.map((task) => task.id)).toEqual(['task-2']);
    expect(nextState.recentTaskResults[0]?.id).toBe('task-1');
  });

  it('resolves history selection from the preferred report when available', () => {
    const items = [createHistoryItem('report-1'), createHistoryItem('report-2')];

    expect(resolveHistorySelection(items, null)).toBe('report-1');
    expect(resolveHistorySelection(items, 'report-2')).toBe('report-2');
    expect(resolveHistorySelection(items, 'missing')).toBeNull();
    expect(resolveHistorySelection([], 'report-1')).toBeNull();
  });

  it('builds an unavailable validation snapshot from report timing fields', () => {
    const validation = buildUnavailableValidation(
      createReport({
        createdAt: '2026-03-18T09:00:00.000Z',
        dataAsOf: null,
      }),
    );

    expect(validation).toMatchObject({
      status: 'unavailable',
      targetDate: '2026-03-18T09:00:00.000Z',
      verdict: 'pending',
    });
    expect(validation.reasons).toContain('当前无法拉取用于自动验证的后续行情。');
  });
});
