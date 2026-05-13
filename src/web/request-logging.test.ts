import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { getRequestContext } from '../request-context.js';
import {
  createHttpRequestLoggingMiddleware,
  shouldLogHttpRequest,
} from './request-logging.js';

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

  try {
    await run(`http://127.0.0.1:${address.port}`);
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

describe('request-logging middleware', () => {
  it('reuses request ids and exposes them to handlers and responses', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const app = express();

    app.use(createHttpRequestLoggingMiddleware({
      logger: { info, warn },
      quietPathPatterns: [],
      slowMs: 1000,
      generateRequestId: () => 'generated-request-id',
    }));
    app.get('/api/context', (_req, res) => {
      res.json({ requestId: getRequestContext()?.requestId ?? null });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/context`, {
        headers: { 'x-request-id': 'external-request-1' },
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('x-request-id')).toBe('external-request-1');
      await expect(response.json()).resolves.toEqual({
        requestId: 'external-request-1',
      });
    });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'external-request-1',
        method: 'GET',
        path: '/api/context',
        statusCode: 200,
      }),
      'HTTP request completed',
    );
  });

  it('generates request ids when callers do not provide one', async () => {
    const app = express();

    app.use(createHttpRequestLoggingMiddleware({
      logger: { info: vi.fn(), warn: vi.fn() },
      quietPathPatterns: [],
      generateRequestId: () => 'generated-request-id',
    }));
    app.get('/api/generated', (_req, res) => {
      res.json({ requestId: getRequestContext()?.requestId ?? null });
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/generated`);
      expect(response.headers.get('x-request-id')).toBe('generated-request-id');
      await expect(response.json()).resolves.toEqual({
        requestId: 'generated-request-id',
      });
    });
  });

  it('suppresses noisy read requests but preserves writes and slow reads', () => {
    expect(shouldLogHttpRequest({
      method: 'GET',
      path: '/api/repo-reviews/runs-summary',
      statusCode: 304,
      durationMs: 40,
      slowMs: 1000,
      quietPathPatterns: ['/api/repo-reviews/runs-summary'],
    })).toBe(false);

    expect(shouldLogHttpRequest({
      method: 'POST',
      path: '/api/repo-reviews/runs-summary',
      statusCode: 200,
      durationMs: 40,
      slowMs: 1000,
      quietPathPatterns: ['/api/repo-reviews/runs-summary'],
    })).toBe(true);

    expect(shouldLogHttpRequest({
      method: 'GET',
      path: '/api/repo-reviews/runs-summary',
      statusCode: 200,
      durationMs: 1800,
      slowMs: 1000,
      quietPathPatterns: ['/api/repo-reviews/runs-summary'],
    })).toBe(true);
  });
});
