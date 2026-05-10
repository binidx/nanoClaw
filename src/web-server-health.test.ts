import express from 'express';
import { describe, expect, it } from 'vitest';

import {
  buildPublicHealthStatus,
  registerPublicHealthRoutes,
} from './web/web-server.js';

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

describe('public health routes', () => {
  it('builds a stable health payload shape', () => {
    const status = buildPublicHealthStatus(
      new Date('2026-03-25T00:00:00.000Z'),
    );

    expect(status).toMatchObject({
      status: 'ok',
      service: 'nanoclaw',
      timestamp: '2026-03-25T00:00:00.000Z',
    });
    expect(typeof status.uptime).toBe('number');
  });

  it('serves anonymous health endpoints for probes', async () => {
    const app = express();
    registerPublicHealthRoutes(app);

    await withServer(app, async (baseUrl) => {
      for (const route of ['/healthz', '/readyz']) {
        const response = await fetch(`${baseUrl}${route}`);
        expect(response.ok).toBe(true);

        const payload = (await response.json()) as {
          status?: string;
          service?: string;
          timestamp?: string;
          uptime?: number;
        };

        expect(payload.status).toBe('ok');
        expect(payload.service).toBe('nanoclaw');
        expect(typeof payload.timestamp).toBe('string');
        expect(typeof payload.uptime).toBe('number');
      }
    });
  });
});
