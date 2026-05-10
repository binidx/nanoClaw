import express from 'express';
import { describe, expect, it, vi } from 'vitest';

const {
  createOrUpdateRepositoryMock,
  getRepositoryRelationshipsMock,
} = vi.hoisted(() => ({
  createOrUpdateRepositoryMock: vi.fn(async () => ({
    id: 'repo-1',
    name: 'NanoClaw',
    language: 'TypeScript',
    localRepoPath: 'D:/repos/nanoclaw',
    remoteProvider: 'github',
    remoteRepoSlug: 'open-source/nanoclaw',
    remoteBaseUrl: 'https://github.com',
    cloneUrl: 'https://github.com/open-source/nanoclaw.git',
    defaultTargetBranch: 'main',
    sshKeyId: null,
    autoSyncEnabled: true,
    autoSyncIntervalMinutes: 30,
    lastAutoSyncAt: null,
    lastAutoSyncStatus: null,
    enabled: true,
    status: 'active',
    visibility: 'private',
    aiDescription: null,
    techStack: ['TypeScript'],
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    features: [],
  })),
  getRepositoryRelationshipsMock: vi.fn(async () => ({
    repositoryId: 'repo-1',
    assistantBindings: [
      {
        bindingId: 'arb-1',
        assistantId: 'assistant-1',
        assistantName: '代码助手',
        branch: 'main',
        worktreePath: 'D:/worktrees/a1-main',
      },
    ],
    workteamBindings: [
      {
        bindingId: 'wtb-1',
        workteamId: 'team-1',
        workteamName: '交付团队',
        bindingKey: 'sdlc',
        branch: 'release',
      },
    ],
    runnerProfile: {
      profileId: 'java8',
      profileName: 'Java 8',
    },
  })),
}));

vi.mock('./tenant-request.js', () => ({
  getTenantUserId: vi.fn(() => 'test-user'),
}));

vi.mock('./repository-service.js', () => ({
  createOrUpdateRepository: createOrUpdateRepositoryMock,
  getFeatures: vi.fn(async () => []),
  getRepository: vi.fn(async (id: string) =>
    id === 'repo-1'
      ? {
          id: 'repo-1',
          name: 'NanoClaw',
          language: 'TypeScript',
          localRepoPath: 'D:/repos/nanoclaw',
          remoteProvider: 'github',
          remoteRepoSlug: 'open-source/nanoclaw',
          remoteBaseUrl: 'https://github.com',
          cloneUrl: 'https://github.com/open-source/nanoclaw.git',
          defaultTargetBranch: 'main',
          sshKeyId: null,
          autoSyncEnabled: true,
          autoSyncIntervalMinutes: 30,
          lastAutoSyncAt: null,
          lastAutoSyncStatus: null,
          enabled: true,
          status: 'active',
          visibility: 'private',
          aiDescription: null,
          techStack: ['TypeScript'],
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          features: [],
        }
      : undefined),
  getRepositoryList: vi.fn(async () => []),
  getRepositoryRelationships: getRepositoryRelationshipsMock,
  patchRepository: vi.fn(),
  removeRepository: vi.fn(),
  setFeature: vi.fn(),
}));

import { registerRepositoryRoutes } from './routes/repository-routes.js';

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

describe('repository routes', () => {
  it('creates repositories via POST /api/repositories', async () => {
    const app = express();
    app.use(express.json());
    registerRepositoryRoutes(app, {
      auditMutation: vi.fn(),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'NanoClaw' }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        id: 'repo-1',
        name: 'NanoClaw',
      });
    });
  });

  it('returns repository relationship summaries', async () => {
    const app = express();
    app.use(express.json());
    registerRepositoryRoutes(app, {
      auditMutation: vi.fn(),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/repositories/repo-1/relationships`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        repositoryId: 'repo-1',
        assistantBindings: [
          expect.objectContaining({
            assistantId: 'assistant-1',
            assistantName: '代码助手',
          }),
        ],
        workteamBindings: [
          expect.objectContaining({
            workteamId: 'team-1',
            bindingKey: 'sdlc',
          }),
        ],
        runnerProfile: {
          profileId: 'java8',
          profileName: 'Java 8',
        },
      });
    });
  });
});
