import express from 'express';
import { describe, expect, it } from 'vitest';

import { registerPublicLibraryRoutes } from './routes/public-library-routes.js';
import { registerRegistryRoutes } from './routes/registry-routes.js';
import { registerRuntimeCustomizationRoutes } from './routes/runtime-customization-routes.js';
import { registerUserMcpRoutes } from './routes/user-mcp-routes.js';
import { registerUserSkillRoutes } from './routes/user-skill-routes.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function denyLocalInstall() {
  return (_req: express.Request, res: express.Response) => {
    res.status(403).json({
      error: 'Local capability unavailable',
      capability: 'localInstall',
      reason: 'permission_denied',
    });
  };
}

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

describe('local install route guards', () => {
  it('blocks user skill import when local install capability is denied', async () => {
    const app = express();
    app.use(express.json());
    registerUserSkillRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: () => denyLocalInstall(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/skills/import-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: '/tmp/demo-skill' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        capability: 'localInstall',
      });
    });
  });

  it('blocks user mcp json import when local install capability is denied', async () => {
    const app = express();
    app.use(express.json());
    registerUserMcpRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: () => denyLocalInstall(),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/mcp-servers/import-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: '{"command":"npx"}' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        capability: 'localInstall',
      });
    });
  });

  it('blocks runtime customization install endpoints when local install capability is denied', async () => {
    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: () => denyLocalInstall(),
      auditMutation: () => {},
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: () => {},
      installManagedMcpServerFromInput: () => ({ ok: true }),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'skill-id',
      createSkillWithAiFromInput: async () => ({ ok: true }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/mcp-servers/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: '/tmp/demo-mcp' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        capability: 'localInstall',
      });
    });
  });

  it('blocks public library and registry installs when local install capability is denied', async () => {
    const app = express();
    app.use(express.json());
    registerPublicLibraryRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: () => denyLocalInstall(),
    });
    registerRegistryRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: () => denyLocalInstall(),
    });

    await withServer(app, async (baseUrl) => {
      const libraryResponse = await fetch(`${baseUrl}/api/public-library/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: 'skill-demo', itemType: 'skill' }),
      });
      expect(libraryResponse.status).toBe(403);

      const registryResponse = await fetch(`${baseUrl}/api/registry/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'demo-skill' }),
      });
      expect(registryResponse.status).toBe(403);
    });
  });
});
