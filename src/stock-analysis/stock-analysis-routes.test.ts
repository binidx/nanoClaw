import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerStockAnalysisRoutes } from '../routes/stock-analysis-routes.js';

const allowAllRequirePermission: import('../auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const {
  clearTasks,
  deleteTask,
  getMarketDashboardSnapshot,
  getReportCenterSnapshot,
  getReportDetailBundle,
  getStockAnalysisService,
  getWorkbenchSnapshot,
} = vi.hoisted(() => {
  const clearTasks = vi.fn();
  const deleteTask = vi.fn();
  const getWorkbenchSnapshot = vi.fn();
  const getReportCenterSnapshot = vi.fn();
  const getReportDetailBundle = vi.fn();
  const getMarketDashboardSnapshot = vi.fn();
  const getStockAnalysisService = vi.fn(() => ({
    clearTasks,
    deleteTask,
    getWorkbenchSnapshot,
    getReportCenterSnapshot,
    getReportDetailBundle,
    getMarketDashboardSnapshot,
  }));
  return {
    clearTasks,
    deleteTask,
    getMarketDashboardSnapshot,
    getReportCenterSnapshot,
    getReportDetailBundle,
    getStockAnalysisService,
    getWorkbenchSnapshot,
  };
});

vi.mock('./stock-analysis-service.js', () => ({
  getStockAnalysisService,
}));

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('stock analysis task cleanup routes', () => {
  beforeEach(() => {
    clearTasks.mockReset();
    deleteTask.mockReset();
    getWorkbenchSnapshot.mockReset();
    getReportCenterSnapshot.mockReset();
    getReportDetailBundle.mockReset();
    getMarketDashboardSnapshot.mockReset();
    getStockAnalysisService.mockClear();
  });

  it('deletes a single task by id', async () => {
    deleteTask.mockReturnValue({ ok: true, deleted: 1 });
    const auditMutation = vi.fn();

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/tasks/task-delete-1`,
        {
          method: 'DELETE',
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        deleted: 1,
      });
    });

    expect(deleteTask).toHaveBeenCalledWith('task-delete-1');
    expect(auditMutation).toHaveBeenCalledWith(
      expect.any(Object),
      'stock-analysis.task.delete',
      'high',
    );
  });

  it('returns 404 when deleting a missing task', async () => {
    deleteTask.mockImplementation(() => {
      throw new Error('任务不存在');
    });

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/tasks/missing-task`,
        {
          method: 'DELETE',
        },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: '任务不存在' });
    });
  });

  it('clears tasks by queried status list', async () => {
    clearTasks.mockReturnValue({ ok: true, deleted: 2 });
    const auditMutation = vi.fn();

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/tasks?status=failed,completed`,
        {
          method: 'DELETE',
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        deleted: 2,
      });
    });

    expect(clearTasks).toHaveBeenCalledWith({
      statuses: ['failed', 'completed'],
    });
    expect(auditMutation).toHaveBeenCalledWith(
      expect.any(Object),
      'stock-analysis.task.clear',
      'high',
    );
  });

  it('returns 400 when cleanup validation fails', async () => {
    clearTasks.mockImplementation(() => {
      throw new Error('运行中的任务不能批量清理');
    });

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/tasks?status=failed,running`,
        {
          method: 'DELETE',
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: '运行中的任务不能批量清理',
      });
    });
  });

  it('returns workbench aggregate snapshot', async () => {
    getWorkbenchSnapshot.mockReturnValue({
      defaults: {
        marketScope: 'both',
        reportType: 'standard',
        strategyPreset: 'bull_trend',
        reportCacheTtlMinutes: 30,
      },
      tasks: {
        active: [],
        recent: [],
        failed: [],
        pendingCount: 0,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
      },
      watchlist: { count: 0, items: [] },
      history: { total: 0, recent: [] },
      dataProviders: { activeProvider: 'yahoo', providers: [] },
    });

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/stock-analysis/workbench`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        defaults: { marketScope: 'both' },
        watchlist: { count: 0 },
      });
    });

    expect(getWorkbenchSnapshot).toHaveBeenCalledWith();
  });

  it('forwards report-center query params to aggregate snapshot', async () => {
    getReportCenterSnapshot.mockReturnValue({
      history: { items: [], total: 0, limit: 20, offset: 20 },
      tasks: {
        active: [],
        recent: [],
        failed: [],
        pendingCount: 0,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
      },
      feedback: { generatedAt: '2026-03-19T00:00:00.000Z', lookaheadDays: 10 },
    });

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/report-center?limit=20&offset=20&stockCode=600519`,
      );
      expect(response.status).toBe(200);
    });

    expect(getReportCenterSnapshot).toHaveBeenCalledWith({
      limit: 20,
      offset: 20,
      stockCode: '600519',
    });
  });

  it('returns 404 for a missing detail bundle', async () => {
    getReportDetailBundle.mockResolvedValue(null);

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/reports/report-missing/detail-bundle`,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    });
  });

  it('forwards market dashboard filters', async () => {
    getMarketDashboardSnapshot.mockResolvedValue({
      review: null,
      backtest: {
        generatedAt: '2026-03-19T00:00:00.000Z',
        lookaheadDays: 5,
        totalTrades: 0,
        overallWinRate: null,
        overallAvgReturnPct: null,
        overallDirectionAccuracy: null,
        strategies: [],
        trades: [],
        notes: [],
      },
      dataProviders: { activeProvider: 'yahoo', providers: [] },
    });

    const app = express();
    app.use(express.json());
    registerStockAnalysisRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/stock-analysis/market-dashboard?scope=cn&strategyPreset=bull_trend&stockCode=600519&limit=10&lookaheadDays=5`,
      );
      expect(response.status).toBe(200);
    });

    expect(getMarketDashboardSnapshot).toHaveBeenCalledWith({
      marketScope: 'cn',
      strategyPreset: 'bull_trend',
      stockCode: '600519',
      limit: 10,
      lookaheadDays: 5,
    });
  });
});
