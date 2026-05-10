import type { Express, Request } from 'express';

import { getStockAnalysisService } from '../stock-analysis/stock-analysis-service.js';
import type {
  StockAnalysisMarketScope,
  StockAnalysisReportType,
  StockAnalysisStrategyPreset,
  StockAnalysisTaskStatus,
} from '../stock-analysis/stock-analysis-types.js';
import { t } from '../i18n/index.js';

function paramString(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

export interface StockAnalysisRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

export function registerStockAnalysisRoutes(
  app: Express,
  opts: StockAnalysisRouteOptions,
): void {
  const service = getStockAnalysisService();
  const viewGuard = opts.requirePermission('project.view', 'stock.view');
  const manageGuard = opts.requirePermission('project.manage', 'stock.manage');

  app.get('/api/stock-analysis/config', viewGuard, async (_req, res) => {
    try {
      res.json(await service.getConfig());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/config/meta', viewGuard, (_req, res) => {
    try {
      res.json(service.getConfigMeta());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/stock-analysis/config', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.config.update', 'high');
      const rawBody = req.body as {
        configVersion?: string;
        config?: Record<string, unknown>;
      } & Record<string, unknown>;
      const body =
        rawBody && typeof rawBody === 'object' && rawBody.config
          ? rawBody
          : {
              configVersion: rawBody?.configVersion,
              config: rawBody,
            };
      res.json(await service.updateConfig(body));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Invalid stock analysis config',
      });
    }
  });

  app.get('/api/stock-analysis/config/presets', viewGuard, async (_req, res) => {
    try {
      res.json(await service.listConfigPresets());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/stock-analysis/config/presets', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.config-preset.save', 'high');
      const body = req.body as {
        id?: string;
        title?: string;
        description?: string | null;
        config?: Record<string, unknown>;
      };
      res.json(await service.saveConfigPreset(body));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Invalid stock analysis config preset',
      });
    }
  });

  app.delete('/api/stock-analysis/config/presets/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.config-preset.delete', 'high');
      res.json(await service.deleteConfigPreset(paramString(req.params.id)));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Delete stock analysis config preset failed',
      });
    }
  });

  app.post('/api/stock-analysis/analyze', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.analyze');
      const body = req.body as {
        stockCodes?: string[];
        market?: StockAnalysisMarketScope;
        marketScope?: StockAnalysisMarketScope;
        reportType?: StockAnalysisReportType;
        strategyPreset?: StockAnalysisStrategyPreset;
        forceRefresh?: boolean;
      };
      res.json(
        await service.analyze({
          ...body,
          marketScope: body.marketScope || body.market,
        }),
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Analyze request failed',
      });
    }
  });

  app.get('/api/stock-analysis/watchlist', viewGuard, async (_req, res) => {
    try {
      res.json(await service.listWatchlist());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/stock-analysis/watchlist', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.watchlist.update');
      const body = req.body as {
        stockCodes?: string[];
        market?: StockAnalysisMarketScope;
        marketScope?: StockAnalysisMarketScope;
      };
      res.json(
        await service.addWatchlist({
          stockCodes: body.stockCodes,
          marketScope: body.marketScope || body.market,
        }),
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Watchlist update failed',
      });
    }
  });

  app.delete('/api/stock-analysis/watchlist/:stockCode', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.watchlist.delete');
      res.json(await service.removeWatchlist(paramString(req.params.stockCode)));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Watchlist delete failed',
      });
    }
  });

  app.get('/api/stock-analysis/workbench', viewGuard, async (_req, res) => {
    try {
      res.json(await service.getWorkbenchSnapshot());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/tasks', viewGuard, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      const statuses =
        typeof req.query.status === 'string'
          ? req.query.status
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined;
      res.json(
        await service.listTasks({
          limit,
          statuses: statuses as StockAnalysisTaskStatus[] | undefined,
        }),
      );
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/stock-analysis/tasks', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.task.clear', 'high');
      const statuses =
        typeof req.query.status === 'string'
          ? req.query.status
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined;
      res.json(
        await service.clearTasks({
          statuses: statuses as StockAnalysisTaskStatus[] | undefined,
        }),
      );
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Clear stock analysis tasks failed',
      });
    }
  });

  app.delete('/api/stock-analysis/tasks/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.task.delete', 'high');
      res.json(await service.deleteTask(paramString(req.params.id)));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Delete stock analysis task failed';
      res
        .status(message === t('errors.auto_c0d836', {}, req.locale) ? 404 : 400)
        .json({ error: message });
    }
  });

  app.post('/api/stock-analysis/tasks/:id/retry', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.task.retry');
      res.json(await service.retryTask(paramString(req.params.id)));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Retry stock analysis task failed';
      res
        .status(message === t('errors.auto_c0d836', {}, req.locale) ? 404 : 400)
        .json({ error: message });
    }
  });

  app.get('/api/stock-analysis/tasks/stream', viewGuard, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: string, payload: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent('connected', { connected: true });

    const unsubscribe = service.subscribeTasks(({ task }) => {
      sendEvent('task', task);
    });

    const heartbeat = setInterval(() => {
      sendEvent('heartbeat', { ts: new Date().toISOString() });
    }, 15_000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };

    _req.on('close', cleanup);
    _req.on('end', cleanup);
  });

  app.get('/api/stock-analysis/history', viewGuard, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 20;
      const offset = Number(req.query.offset) || 0;
      const stockCode =
        typeof req.query.stockCode === 'string'
          ? req.query.stockCode
          : undefined;
      res.json(await service.listHistory({ limit, offset, stockCode }));
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/report-center', viewGuard, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      const offset = Number(req.query.offset) || undefined;
      const stockCode =
        typeof req.query.stockCode === 'string'
          ? req.query.stockCode
          : undefined;
      res.json(
        await service.getReportCenterSnapshot({
          limit,
          offset,
          stockCode,
        }),
      );
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/history/:id', viewGuard, async (req, res) => {
    try {
      if (req.query.format === 'dashboard') {
        const dashboard = await service.getHistoryDashboard(paramString(req.params.id));
        if (!dashboard) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(dashboard);
        return;
      }
      const detail = await service.getHistoryDetail(paramString(req.params.id));
      if (!detail) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(detail);
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/history/:id/dashboard', viewGuard, async (req, res) => {
    try {
      const dashboard = await service.getHistoryDashboard(paramString(req.params.id));
      if (!dashboard) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(dashboard);
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/reports/:id/dashboard', viewGuard, async (req, res) => {
    try {
      const dashboard = await service.getHistoryDashboard(paramString(req.params.id));
      if (!dashboard) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(dashboard);
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/history/:id/validation', viewGuard, async (req, res) => {
    try {
      res.json(await service.getReportValidation(paramString(req.params.id)));
    } catch (err) {
      res.status(
        err instanceof Error && err.message === t('errors.auto_4c08b4', {}, req.locale) ? 404 : 500,
      ).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  app.get('/api/stock-analysis/reports/:id/detail-bundle', viewGuard, async (req, res) => {
    try {
      const bundle = await service.getReportDetailBundle(paramString(req.params.id));
      if (!bundle) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(bundle);
    } catch (err) {
      res.status(
        err instanceof Error && err.message === t('errors.auto_4c08b4', {}, req.locale) ? 404 : 500,
      ).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  app.get('/api/stock-analysis/feedback', viewGuard, async (req, res) => {
    try {
      const lookaheadDays = Number(req.query.lookaheadDays) || undefined;
      const limit = Number(req.query.limit) || undefined;
      res.json(
        await service.getFeedbackSnapshot({
          lookaheadDays,
          limit,
        }),
      );
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/portfolio-dashboard', viewGuard, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      res.json(await service.getPortfolioDashboardSnapshot(limit));
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/market-review', viewGuard, async (req, res) => {
    try {
      const scope =
        req.query.scope === 'cn' ||
        req.query.scope === 'hk' ||
        req.query.scope === 'us' ||
        req.query.scope === 'both' ||
        req.query.scope === 'all'
          ? req.query.scope
          : undefined;
      res.json({ review: await service.getLatestMarketReview(scope) });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/stock-analysis/market-dashboard', viewGuard, async (req, res) => {
    try {
      const marketScope =
        req.query.scope === 'cn' ||
        req.query.scope === 'hk' ||
        req.query.scope === 'us' ||
        req.query.scope === 'both' ||
        req.query.scope === 'all'
          ? req.query.scope
          : undefined;
      const strategyPreset =
        typeof req.query.strategyPreset === 'string'
          ? (req.query.strategyPreset as StockAnalysisStrategyPreset)
          : undefined;
      const stockCode =
        typeof req.query.stockCode === 'string'
          ? req.query.stockCode
          : undefined;
      const limit = Number(req.query.limit) || undefined;
      const lookaheadDays = Number(req.query.lookaheadDays) || undefined;
      res.json(
        await service.getMarketDashboardSnapshot({
          marketScope,
          strategyPreset,
          stockCode,
          limit,
          lookaheadDays,
        }),
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Market dashboard failed',
      });
    }
  });

  app.post('/api/stock-analysis/market-review/run', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.market-review.run');
      const body = req.body as {
        scope?: StockAnalysisMarketScope;
        marketScope?: StockAnalysisMarketScope;
      };
      res.json({
        review: await service.runMarketReview({
          marketScope: body.marketScope || body.scope,
        }),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Market review failed',
      });
    }
  });

  /* ─── Backtest routes ─── */

  app.post('/api/stock-analysis/backtest', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'stock-analysis.backtest.run');
      const body = req.body as {
        strategyPreset?: StockAnalysisStrategyPreset;
        stockCode?: string;
        limit?: number;
        lookaheadDays?: number;
      };
      res.json(await service.runBacktest(body));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Backtest failed',
      });
    }
  });

  app.get('/api/stock-analysis/backtest', viewGuard, async (req, res) => {
    try {
      const strategyPreset =
        typeof req.query.strategyPreset === 'string'
          ? (req.query.strategyPreset as StockAnalysisStrategyPreset)
          : undefined;
      const stockCode =
        typeof req.query.stockCode === 'string'
          ? req.query.stockCode
          : undefined;
      const limit = Number(req.query.limit) || undefined;
      const lookaheadDays = Number(req.query.lookaheadDays) || undefined;
      res.json(
        await service.runBacktest({
          strategyPreset,
          stockCode,
          limit,
          lookaheadDays,
        }),
      );
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Backtest failed',
      });
    }
  });

  /* ─── Data provider status ─── */

  app.get('/api/stock-analysis/data-providers', viewGuard, (_req, res) => {
    try {
      res.json(service.getDataProviderStatus());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
