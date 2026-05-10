import type { Express, Response } from 'express';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { normalizeBrowserUrl } from '../browser/policy.js';
import { getBrowserService } from '../browser/service.js';
import {
  BrowserError,
  type BrowserAction,
  type BrowserErrorResponse,
  type BrowserServiceLike,
} from '../browser/types.js';
import { logger } from '../logger.js';

export interface BrowserRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
  service?: BrowserServiceLike;
}

function normalizeUrl(value: unknown): string {
  return normalizeBrowserUrl(value);
}

function requireText(value: unknown, field: string): string {
  const text = String(value || '').trim();
  if (!text) {
    throw new BrowserError(400, `${field} is required`);
  }
  return text;
}

function requireRefOrSelector(
  record: Record<string, unknown>,
): { ref?: string; selector?: string } {
  const ref = String(record.ref || '').trim();
  const selector = String(record.selector || '').trim();
  if (!ref && !selector) {
    throw new BrowserError(400, 'ref or selector is required');
  }
  return {
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
  };
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text === 'true' || text === '1') {
    return true;
  }
  if (text === 'false' || text === '0') {
    return false;
  }
  throw new BrowserError(400, 'Boolean query params must be true/false/1/0');
}

function parseOptionalInteger(value: unknown, field: string): number | undefined {
  const text = String(value || '').trim();
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new BrowserError(400, `${field} must be a number`);
  }
  return Math.floor(parsed);
}

function parseBrowserAction(body: unknown): {
  targetId?: string;
  action: BrowserAction;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BrowserError(400, 'Request body must be an object');
  }
  const record = body as Record<string, unknown>;
  const actionRecord =
    record.action && typeof record.action === 'object' && !Array.isArray(record.action)
      ? (record.action as Record<string, unknown>)
      : record;
  const kind = requireText(actionRecord.kind, 'kind');

  switch (kind) {
    case 'navigate':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          url: normalizeUrl(actionRecord.url),
          timeoutMs:
            typeof actionRecord.timeoutMs === 'number'
              ? Math.floor(actionRecord.timeoutMs)
              : undefined,
        },
      };
    case 'click':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind: 'click',
          ...requireRefOrSelector(actionRecord),
          ...(typeof actionRecord.clickCount === 'number' && actionRecord.clickCount > 1
            ? { clickCount: Math.floor(actionRecord.clickCount) }
            : {}),
        } as Extract<BrowserAction, { kind: 'click' }>,
      };
    case 'hover':
    case 'scrollIntoView':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...requireRefOrSelector(actionRecord),
        } as Extract<
          BrowserAction,
          { kind: 'click' | 'hover' | 'scrollIntoView' }
        >,
      };
    case 'type':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...requireRefOrSelector(actionRecord),
          text:
            typeof actionRecord.text === 'string' && actionRecord.text.length > 0
              ? actionRecord.text
              : (() => {
                  throw new BrowserError(400, 'text is required');
                })(),
        },
      };
    case 'press':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          key: requireText(actionRecord.key, 'key'),
        },
      };
    case 'wait':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          timeMs:
            typeof actionRecord.timeMs === 'number'
              ? Math.floor(actionRecord.timeMs)
              : undefined,
        },
      };
    case 'waitFor': {
      const selector = String(actionRecord.selector || '').trim();
      const urlIncludes = String(actionRecord.urlIncludes || '').trim();
      const titleIncludes = String(actionRecord.titleIncludes || '').trim();
      if (!selector && !urlIncludes && !titleIncludes) {
        throw new BrowserError(
          400,
          'waitFor requires selector, urlIncludes, or titleIncludes',
        );
      }
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...(selector ? { selector } : {}),
          ...(urlIncludes ? { urlIncludes } : {}),
          ...(titleIncludes ? { titleIncludes } : {}),
          ...(typeof actionRecord.timeoutMs === 'number'
            ? { timeoutMs: Math.floor(actionRecord.timeoutMs) }
            : {}),
          ...(typeof actionRecord.pollIntervalMs === 'number'
            ? { pollIntervalMs: Math.floor(actionRecord.pollIntervalMs) }
            : {}),
        },
      };
    }
    case 'close':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: { kind },
      };
    case 'back':
    case 'forward':
    case 'reload':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...(typeof actionRecord.timeoutMs === 'number'
            ? { timeoutMs: Math.floor(actionRecord.timeoutMs) }
            : {}),
        },
      };
    case 'select':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...requireRefOrSelector(actionRecord),
          value: typeof actionRecord.value === 'string' && actionRecord.value.length > 0
            ? actionRecord.value
            : (() => { throw new BrowserError(400, 'value is required for select'); })(),
        },
      };
    case 'scroll': {
      const ref = String(actionRecord.ref || '').trim();
      const selector = String(actionRecord.selector || '').trim();
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          ...(typeof actionRecord.x === 'number' ? { x: actionRecord.x } : {}),
          ...(typeof actionRecord.y === 'number' ? { y: actionRecord.y } : {}),
          ...(ref ? { ref } : {}),
          ...(selector ? { selector } : {}),
        },
      };
    }
    case 'evaluate':
      return {
        targetId: String(record.targetId || '').trim() || undefined,
        action: {
          kind,
          expression: typeof actionRecord.expression === 'string' && actionRecord.expression.trim().length > 0
            ? actionRecord.expression.trim()
            : (() => { throw new BrowserError(400, 'expression is required for evaluate'); })(),
        },
      };
    default:
      throw new BrowserError(400, `Unsupported browser action: ${kind}`);
  }
}

function respondError(res: Response, err: unknown): void {
  const browserError =
    err instanceof BrowserError
      ? err
      : new BrowserError(
          500,
          err instanceof Error ? err.message : 'Internal error',
        );
  const errorContext =
    browserError.details &&
    (browserError.details.action ||
      browserError.details.ref ||
      browserError.details.selector)
      ? {
          ...(browserError.details.action
            ? { action: browserError.details.action }
            : {}),
          ...(browserError.details.ref ? { ref: browserError.details.ref } : {}),
          ...(browserError.details.selector
            ? { selector: browserError.details.selector }
            : {}),
        }
      : undefined;
  const payload: BrowserErrorResponse = {
    error: browserError.message,
    ...(errorContext ? { errorContext } : {}),
    ...(browserError.details?.suggestion
      ? { suggestion: browserError.details.suggestion }
      : {}),
  };
  res.status(browserError.status).json(payload);
}

export function registerBrowserRoutes(
  app: Express,
  options: BrowserRouteOptions,
): void {
  const service = options.service || getBrowserService();
  const guard =
    options.requireLocalCapability?.('browserControl') ||
    options.requirePermission('browser.control');

  app.get('/api/browser/status', guard, async (_req, res) => {
    try {
      res.json(await service.getStatus());
    } catch (err) {
      logger.error({ err }, 'Failed to read browser status');
      respondError(res, err);
    }
  });

  app.post('/api/browser/start', guard, async (_req, res) => {
    try {
      res.json(await service.start());
    } catch (err) {
      logger.error({ err }, 'Failed to start managed browser');
      respondError(res, err);
    }
  });

  app.post('/api/browser/stop', guard, async (_req, res) => {
    try {
      res.json(await service.stop());
    } catch (err) {
      logger.error({ err }, 'Failed to stop managed browser');
      respondError(res, err);
    }
  });

  app.get('/api/browser/tabs', guard, async (_req, res) => {
    try {
      res.json(await service.listTabs());
    } catch (err) {
      logger.error({ err }, 'Failed to list browser tabs');
      respondError(res, err);
    }
  });

  app.post('/api/browser/tabs/open', guard, async (req, res) => {
    try {
      res.json(
        await service.openTab(normalizeUrl((req.body as { url?: unknown })?.url)),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to open browser tab');
      respondError(res, err);
    }
  });

  app.post('/api/browser/tabs/focus', guard, async (req, res) => {
    try {
      const targetId = requireText(
        (req.body as { targetId?: unknown })?.targetId,
        'targetId',
      );
      await service.focusTab(targetId);
      res.json({ ok: true, targetId });
    } catch (err) {
      logger.error({ err }, 'Failed to focus browser tab');
      respondError(res, err);
    }
  });

  app.delete('/api/browser/tabs/:targetId', guard, async (req, res) => {
    try {
      const targetId = requireText(req.params.targetId, 'targetId');
      await service.closeTab(targetId);
      res.json({ ok: true, targetId });
    } catch (err) {
      logger.error({ err }, 'Failed to close browser tab');
      respondError(res, err);
    }
  });

  app.get('/api/browser/snapshot', guard, async (req, res) => {
    try {
      const targetId = String(req.query.targetId || '').trim() || undefined;
      const maxNodes = parseOptionalInteger(req.query.maxNodes, 'maxNodes');
      const force = parseOptionalBoolean(req.query.force);
      res.json(await service.getSnapshot({ targetId, maxNodes, force }));
    } catch (err) {
      logger.error({ err }, 'Failed to create browser snapshot');
      respondError(res, err);
    }
  });

  app.get('/api/browser/role-snapshot', guard, async (req, res) => {
    try {
      const targetId = String(req.query.targetId || '').trim() || undefined;
      const maxNodes = parseOptionalInteger(req.query.maxNodes, 'maxNodes');
      const force = parseOptionalBoolean(req.query.force);
      res.json(
        await service.getRoleSnapshot({
          targetId,
          interactive: parseOptionalBoolean(req.query.interactive),
          compact: parseOptionalBoolean(req.query.compact),
          maxDepth: parseOptionalInteger(req.query.maxDepth, 'maxDepth'),
          maxChars: parseOptionalInteger(req.query.maxChars, 'maxChars'),
          maxNodes,
          force,
        }),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to create browser role snapshot');
      respondError(res, err);
    }
  });

  app.get('/api/browser/screenshot', guard, async (req, res) => {
    try {
      const targetId = String(req.query.targetId || '').trim() || undefined;
      const formatRaw = String(req.query.format || '').trim().toLowerCase();
      const format = (['png', 'jpeg', 'webp'] as const).includes(formatRaw as any)
        ? (formatRaw as 'png' | 'jpeg' | 'webp')
        : undefined;
      const quality = parseOptionalInteger(req.query.quality, 'quality');
      res.json(await service.getScreenshot({ targetId, format, quality }));
    } catch (err) {
      logger.error({ err }, 'Failed to capture browser screenshot');
      respondError(res, err);
    }
  });

  app.get('/api/browser/logs', guard, async (req, res) => {
    try {
      const targetId = String(req.query.targetId || '').trim() || undefined;
      res.json(await service.getLogs({ targetId }));
    } catch (err) {
      logger.error({ err }, 'Failed to read browser logs');
      respondError(res, err);
    }
  });

  app.post('/api/browser/act', guard, async (req, res) => {
    try {
      res.json(await service.act(parseBrowserAction(req.body)));
    } catch (err) {
      logger.error({ err }, 'Failed to run browser action');
      respondError(res, err);
    }
  });
}
