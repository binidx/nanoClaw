import express from 'express';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { registerResourceBindingRoutes } from './routes/resource-binding-routes.js';

const {
  getAssistantMock,
  getWorkflowMock,
  listOwnerBindingsMock,
  listResourceBindingsMock,
  createRepositoryBindingMock,
  removeBindingMock,
  getBindingMock,
} = vi.hoisted(() => ({
  getAssistantMock: vi.fn(),
  getWorkflowMock: vi.fn(),
  listOwnerBindingsMock: vi.fn(),
  listResourceBindingsMock: vi.fn(),
  createRepositoryBindingMock: vi.fn(),
  removeBindingMock: vi.fn(),
  getBindingMock: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getAssistant: getAssistantMock,
}));

vi.mock('./db/workflows.js', () => ({
  getWorkflow: getWorkflowMock,
}));

vi.mock('./tenant/resource-binding-service.js', () => ({
  listOwnerBindings: listOwnerBindingsMock,
  listResourceBindings: listResourceBindingsMock,
  createRepositoryBinding: createRepositoryBindingMock,
  removeBinding: removeBindingMock,
  getBinding: getBindingMock,
}));

vi.mock('./tenant/tenant-request.js', () => ({
  getTenantUserId: vi.fn(() => 'test-user'),
}));

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

function createApp() {
  const app = express();
  app.use(express.json());
  registerResourceBindingRoutes(app, {
    requirePermission: vi.fn(() => async (_req, _res, next) => next()),
    auditMutation: vi.fn(),
  });
  return app;
}

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
  });
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

describe('resource binding routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAssistantMock.mockResolvedValue({
      id: 'assistant-1',
      user_id: 'test-user',
      visibility: 'private',
    });
    getWorkflowMock.mockResolvedValue({
      id: 'workflow-1',
      user_id: 'test-user',
      name: 'Workflow One',
    });
    listOwnerBindingsMock.mockResolvedValue([
      {
        id: 'binding-1',
        resourceType: 'repository',
        resourceId: 'repo-1',
        ownerType: 'workflow',
        ownerId: 'workflow-1',
        bindingKey: 'sdlc',
        branch: 'main',
        workDirectory: null,
        config: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        repositoryName: 'Demo Repo',
      },
    ]);
    listResourceBindingsMock.mockResolvedValue([]);
    createRepositoryBindingMock.mockResolvedValue({
      id: 'binding-2',
      resourceType: 'repository',
      resourceId: 'repo-2',
      ownerType: 'workflow',
      ownerId: 'workflow-1',
      bindingKey: 'sdlc',
      branch: 'develop',
      workDirectory: null,
      config: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      repositoryName: 'Repo Two',
    });
    removeBindingMock.mockResolvedValue(true);
    getBindingMock.mockResolvedValue({
      id: 'binding-1',
      resourceType: 'repository',
      resourceId: 'repo-1',
      ownerType: 'workflow',
      ownerId: 'workflow-1',
      bindingKey: 'sdlc',
      branch: 'main',
      workDirectory: null,
      config: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      repositoryName: 'Demo Repo',
    });
  });

  it('lists workflow bindings', async () => {
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/resource-bindings?ownerType=workflow&ownerId=workflow-1`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        bindings: [
          expect.objectContaining({
            ownerType: 'workflow',
            ownerId: 'workflow-1',
            bindingKey: 'sdlc',
          }),
        ],
      });
    });
  });

  it('creates workflow bindings', async () => {
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/resource-bindings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerType: 'workflow',
          ownerId: 'workflow-1',
          repositoryId: 'repo-2',
          bindingKey: 'sdlc',
        }),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          ownerType: 'workflow',
          ownerId: 'workflow-1',
          bindingKey: 'sdlc',
        }),
      );
    });

    expect(createRepositoryBindingMock).toHaveBeenCalledWith(
      'workflow',
      'workflow-1',
      'repo-2',
      expect.objectContaining({
        bindingKey: 'sdlc',
      }),
      'test-user',
    );
  });
});
