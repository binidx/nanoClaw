import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from './config.js';
import { _initTestDatabase, createTavernPersona } from './db.js';
import { registerTavernRoutes } from './routes/tavern-routes.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp(getUserId: () => string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { tenantUserId?: string }).tenantUserId =
      getUserId();
    next();
  });
  registerTavernRoutes(app, {
    requirePermission: allowAllRequirePermission,
    listAvailableManagedSkills: () => [],
    listAvailableManagedMcpServers: () => [],
  });
  return app;
}

async function writeAvatar(relativePath: string, bytes: Buffer) {
  const absolutePath = path.join(DATA_DIR, 'tavern-avatars', relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);
}

describe('tavern routes', () => {
  beforeEach(async () => {
    _initTestDatabase();
    await fs.rm(path.join(DATA_DIR, 'tavern-avatars'), {
      recursive: true,
      force: true,
    });
  });

  it('serves only avatar files owned by the current user', async () => {
    let currentUserId = 'tavern-user-a';
    const app = createApp(() => currentUserId);
    await createTavernPersona('tavern-user-a', {
      name: 'Owner A',
      avatarPath: 'tavern-user-a/avatar-a.png',
    });
    await createTavernPersona('tavern-user-b', {
      name: 'Owner B',
      avatarPath: 'tavern-user-b/avatar-b.png',
    });
    await writeAvatar('tavern-user-a/avatar-a.png', Buffer.from('avatar-a'));
    await writeAvatar('tavern-user-b/avatar-b.png', Buffer.from('avatar-b'));

    currentUserId = 'tavern-user-b';
    const forbidden = await inject(app, {
      method: 'GET',
      url: `/api/tavern/avatar-file?path=${encodeURIComponent(
        'tavern-user-a/avatar-a.png',
      )}`,
    });
    expect(forbidden.statusCode).toBe(404);

    const allowed = await inject(app, {
      method: 'GET',
      url: `/api/tavern/avatar-file?path=${encodeURIComponent(
        'tavern-user-b/avatar-b.png',
      )}`,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe('avatar-b');
  });
});
