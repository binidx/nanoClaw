import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequirePermissionFn } from './auth/auth-middleware.js';
import { _initTestDatabase } from './db.js';
import { registerChannelInstanceRoutes } from './routes/channel-instance-routes.js';

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function createApp(allowedPermissions: string[]) {
  const reloadChannels = vi.fn(async () => ({
    disconnected: [],
    connected: ['telegram'],
    errors: [],
  }));
  const requirePermission: RequirePermissionFn =
    (...codes: string[]) =>
    async (_req, res, next) => {
      if (!codes.some((code) => allowedPermissions.includes(code))) {
        res.status(403).json({ error: 'Forbidden', required: codes });
        return;
      }
      next();
    };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { tenantUserId?: string }).tenantUserId =
      'user-a';
    next();
  });
  registerChannelInstanceRoutes(app, { requirePermission, reloadChannels });
  return { app, reloadChannels };
}

describe('user channel instance routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('requires the dedicated personal channel permissions', async () => {
    const { app } = createApp(['channel.personal.create']);

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/user/channels`);
      expect(listResponse.status).toBe(403);

      const createResponse = await fetch(`${baseUrl}/api/user/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'telegram',
          name: 'User A Telegram',
          config: { botToken: 'tg-token-a' },
        }),
      });
      expect(createResponse.status).toBe(200);

      const { id } = (await createResponse.json()) as { id: string };
      const updateResponse = await fetch(`${baseUrl}/api/user/channels/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(updateResponse.status).toBe(403);
    });
  });

  it('reloads the main runtime after create, update, and delete', async () => {
    const { app, reloadChannels } = createApp([
      'channel.own',
      'channel.personal.create',
      'channel.personal.edit',
    ]);

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/user/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'telegram',
          name: 'User A Telegram',
          config: { botToken: 'tg-token-a' },
        }),
      });
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { id: string };

      const listResponse = await fetch(`${baseUrl}/api/user/channels`);
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toEqual([
        expect.objectContaining({
          id: created.id,
          type: 'telegram',
          visibility: 'private',
          owner_id: 'user-a',
          config: expect.objectContaining({ botToken: 'tg-t****' }),
        }),
      ]);

      const updateResponse = await fetch(
        `${baseUrl}/api/user/channels/${created.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'User A Telegram Updated' }),
        },
      );
      expect(updateResponse.status).toBe(200);

      const deleteResponse = await fetch(
        `${baseUrl}/api/user/channels/${created.id}`,
        { method: 'DELETE' },
      );
      expect(deleteResponse.status).toBe(200);
    });

    expect(reloadChannels).toHaveBeenCalledTimes(3);
  });
});
