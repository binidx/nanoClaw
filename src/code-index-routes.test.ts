import express from 'express';
import inject from 'light-my-request';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  buildCodeIndexAsyncMock,
  enrichCodeIndexSnapshotAsyncMock,
  loadCodeIndexSnapshotMock,
  loadCodeIndexSearchDataMock,
  loadCodeIndexFileDataMock,
  loadCodeIndexFunctionsDataMock,
  loadCodeIndexFunctionGraphDataMock,
  getCodeIndexSnapshotMetaMock,
  listCodeIndexSnapshotMetasByStatusMock,
  saveCodeIndexSnapshotMock,
  saveCodeIndexSnapshotMetaMock,
  getReviewRepositoryByIdMock,
  listWorktreesMock,
  acquireWorktreeMock,
} = vi.hoisted(() => ({
  buildCodeIndexAsyncMock: vi.fn(),
  enrichCodeIndexSnapshotAsyncMock: vi.fn(),
  loadCodeIndexSnapshotMock: vi.fn(async () => null),
  loadCodeIndexSearchDataMock: vi.fn(async () => null),
  loadCodeIndexFileDataMock: vi.fn(async () => null),
  loadCodeIndexFunctionsDataMock: vi.fn(async () => null),
  loadCodeIndexFunctionGraphDataMock: vi.fn(async () => null),
  getCodeIndexSnapshotMetaMock: vi.fn(),
  listCodeIndexSnapshotMetasByStatusMock: vi.fn(async () => []),
  saveCodeIndexSnapshotMock: vi.fn(async () => undefined),
  saveCodeIndexSnapshotMetaMock: vi.fn(async () => undefined),
  getReviewRepositoryByIdMock: vi.fn(),
  listWorktreesMock: vi.fn(async () => []),
  acquireWorktreeMock: vi.fn(async () => null),
}));

vi.mock('./code-index-builder.js', () => ({
  buildCodeIndexAsync: buildCodeIndexAsyncMock,
  enrichCodeIndexSnapshotAsync: enrichCodeIndexSnapshotAsyncMock,
}));

vi.mock('./db/code-index-db.js', () => ({
  loadCodeIndexSnapshot: loadCodeIndexSnapshotMock,
  loadCodeIndexSearchData: loadCodeIndexSearchDataMock,
  loadCodeIndexFileData: loadCodeIndexFileDataMock,
  loadCodeIndexFunctionsData: loadCodeIndexFunctionsDataMock,
  loadCodeIndexFunctionGraphData: loadCodeIndexFunctionGraphDataMock,
  getCodeIndexSnapshotMeta: getCodeIndexSnapshotMetaMock,
  saveCodeIndexSnapshot: saveCodeIndexSnapshotMock,
  saveCodeIndexSnapshotMeta: saveCodeIndexSnapshotMetaMock,
  listCodeIndexSnapshotMetasByStatus: listCodeIndexSnapshotMetasByStatusMock,
}));

vi.mock('./db/review.js', () => ({
  getReviewRepositoryById: getReviewRepositoryByIdMock,
}));

vi.mock('./tenant-context.js', () => ({
  getCurrentUserId: vi.fn(() => 'test-user'),
}));

vi.mock('./worktree-manager.js', () => ({
  acquireWorktree: acquireWorktreeMock,
  listWorktrees: listWorktreesMock,
}));

vi.mock('./auth/resource-access-policy.js', () => ({
  canAccessRepositoryResource: vi.fn(async () => true),
}));

import { registerCodeIndexRoutes } from './routes/code-index-routes.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

describe('code-index routes', () => {
  afterEach(() => {
    vi.clearAllMocks();
    enrichCodeIndexSnapshotAsyncMock.mockReset();
    loadCodeIndexSnapshotMock.mockReset();
    loadCodeIndexSearchDataMock.mockReset();
    loadCodeIndexFileDataMock.mockReset();
    loadCodeIndexFunctionsDataMock.mockReset();
    loadCodeIndexFunctionGraphDataMock.mockReset();
    loadCodeIndexSearchDataMock.mockResolvedValue(null);
    loadCodeIndexFileDataMock.mockResolvedValue(null);
    loadCodeIndexFunctionsDataMock.mockResolvedValue(null);
    loadCodeIndexFunctionGraphDataMock.mockResolvedValue(null);
    listCodeIndexSnapshotMetasByStatusMock.mockReset();
    listCodeIndexSnapshotMetasByStatusMock.mockResolvedValue([]);
  });

  it('starts rebuild asynchronously and returns accepted immediately', async () => {
    let resolveBuild: ((value: unknown) => void) | null = null;
    const buildPromise = new Promise((resolve) => {
      resolveBuild = resolve;
    });
    buildCodeIndexAsyncMock.mockReturnValue(buildPromise);
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-1',
      name: 'Repo 1',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-1/rebuild?branch=main&force=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'started',
      progress: {
        status: 'building',
        stage: 'scan',
      },
    });
    expect(saveCodeIndexSnapshotMetaMock).toHaveBeenCalledTimes(1);
    expect(buildCodeIndexAsyncMock).toHaveBeenCalledTimes(1);
    expect(saveCodeIndexSnapshotMock).not.toHaveBeenCalled();

    resolveBuild?.({
      meta: {
        repositoryId: 'repo-1',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-1',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-04-23T00:00:00.000Z',
        stats: {
          fileCount: 1,
          chunkCount: 1,
          functionCount: 1,
          functionEdgeCount: 0,
          totalLines: 1,
          embeddedChunkCount: 0,
        },
        capabilities: {
          chunkSearch: true,
          fileSummaries: true,
          functionGraph: true,
          embeddings: false,
        },
        progress: {
          repositoryId: 'repo-1',
          branch: 'main',
          status: 'ready',
          stage: 'complete',
          processedFiles: 1,
          totalFiles: 1,
          message: 'done',
          error: null,
          startedAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
      files: [],
      chunks: [],
      functions: [],
      functionEdges: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saveCodeIndexSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('prefers a branch worktree over repository local_repo_path for remote-backed repositories', async () => {
    const worktreeRoot = process.cwd();
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-remote',
      name: 'Repo Remote',
      default_target_branch: 'main',
      local_repo_path: '/stale/mirror/path',
      clone_url: 'ssh://git@example.com/repo.git',
      remote_provider: 'gitea',
    });
    listWorktreesMock.mockResolvedValue([
      {
        branch: 'main',
        workDirectory: worktreeRoot,
        lastUsedAt: '2026-04-23T00:00:00.000Z',
      },
    ]);
    buildCodeIndexAsyncMock.mockResolvedValue({
      meta: {
        repositoryId: 'repo-remote',
        branch: 'main',
        rootDirectory: worktreeRoot,
        manifestHash: 'hash-remote',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-04-23T00:00:00.000Z',
        stats: {
          fileCount: 0,
          chunkCount: 0,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 0,
          embeddedChunkCount: 0,
        },
        capabilities: {
          chunkSearch: false,
          fileSummaries: false,
          functionGraph: false,
          embeddings: false,
        },
        progress: {
          status: 'ready',
          stage: 'complete',
          processedFiles: 0,
          totalFiles: 0,
          message: 'done',
          error: null,
          startedAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
      files: [],
      chunks: [],
      functions: [],
      functionEdges: [],
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-remote/rebuild?branch=main&force=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(202);
    expect(buildCodeIndexAsyncMock.mock.calls[0]?.[0]).toBe(worktreeRoot);
    expect(acquireWorktreeMock).not.toHaveBeenCalled();
  });

  it('runs background enrichment after the base snapshot when ai summaries are enabled', async () => {
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-enrich',
      name: 'Repo Enrich',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    const baseSnapshot = {
      meta: {
        repositoryId: 'repo-enrich',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-base',
        status: 'building',
        stage: 'summaries',
        generatedAt: null,
        stats: {
          fileCount: 1,
          chunkCount: 1,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 1,
          embeddedChunkCount: 0,
        },
        capabilities: {
          chunkSearch: true,
          fileSummaries: true,
          functionGraph: false,
          embeddings: false,
        },
        progress: {
          status: 'building',
          stage: 'summaries',
          processedFiles: 1,
          totalFiles: 1,
          message: '基础代码索引已完成，正在生成摘要',
          error: null,
          startedAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
      files: [],
      chunks: [],
      functions: [],
      functionEdges: [],
    };
    buildCodeIndexAsyncMock.mockResolvedValue(baseSnapshot);
    loadCodeIndexSnapshotMock.mockResolvedValue(baseSnapshot);
    enrichCodeIndexSnapshotAsyncMock.mockResolvedValue({
      ...baseSnapshot,
      meta: {
        ...baseSnapshot.meta,
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-04-23T00:01:00.000Z',
        progress: {
          ...baseSnapshot.meta.progress,
          status: 'ready',
          stage: 'complete',
          message: '代码索引已完成',
        },
      },
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-enrich/rebuild?branch=main&enableAiSummaries=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(buildCodeIndexAsyncMock).toHaveBeenCalledTimes(1);
    expect(enrichCodeIndexSnapshotAsyncMock).toHaveBeenCalledTimes(1);
    expect(buildCodeIndexAsyncMock.mock.calls[0]?.[3]).toMatchObject({
      summarizeWithAi: false,
      embedChunks: false,
    });
    expect(enrichCodeIndexSnapshotAsyncMock.mock.calls[0]?.[2]).toMatchObject({
      summarizeWithAi: true,
      embedChunks: false,
    });
  });

  it('returns source and readiness metadata from status', async () => {
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-status',
      name: 'Repo Status',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    getCodeIndexSnapshotMetaMock.mockResolvedValue({
      repositoryId: 'repo-status',
      branch: 'main',
      rootDirectory: process.cwd(),
      sourceKind: 'remote_worktree',
      sourceBranch: 'release',
      sourceHeadSha: 'abc123persisted',
      manifestHash: 'hash-status',
      status: 'ready',
      stage: 'complete',
      generatedAt: '2026-04-23T00:00:00.000Z',
      stats: {
        fileCount: 1,
        chunkCount: 2,
        functionCount: 1,
        functionEdgeCount: 0,
        totalLines: 10,
        embeddedChunkCount: 0,
      },
      capabilities: {
        chunkSearch: true,
        fileSummaries: true,
        functionGraph: true,
        embeddings: false,
      },
      progress: {
        status: 'ready',
        stage: 'complete',
        processedFiles: 1,
        totalFiles: 1,
        message: 'done',
        error: null,
        startedAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      },
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/api/code-index/repo-status/status?branch=main',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      meta: {
        sourceKind: 'remote_worktree',
        sourceBranch: 'release',
        sourceHeadSha: 'abc123persisted',
        baseReady: true,
        summaryReady: true,
        embeddingsReady: false,
      },
    });
  });

  it('keeps active enrichment visible as building instead of interrupted', async () => {
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-active-enrich',
      name: 'Repo Active Enrich',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    const baseSnapshot = {
      meta: {
        repositoryId: 'repo-active-enrich',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-active-enrich',
        status: 'building',
        stage: 'summaries',
        generatedAt: null,
        stats: {
          fileCount: 3,
          chunkCount: 6,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 60,
          embeddedChunkCount: 0,
        },
        capabilities: {
          chunkSearch: true,
          fileSummaries: true,
          functionGraph: false,
          embeddings: false,
        },
        progress: {
          status: 'building',
          stage: 'summaries',
          processedFiles: 0,
          totalFiles: 3,
          message: '基础代码索引已完成，正在生成摘要',
          error: null,
          startedAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
      files: [],
      chunks: [],
      functions: [],
      functionEdges: [],
    };
    buildCodeIndexAsyncMock.mockResolvedValue(baseSnapshot);
    loadCodeIndexSnapshotMock.mockResolvedValue(baseSnapshot);
    let resolveEnrich: (() => void) | null = null;
    enrichCodeIndexSnapshotAsyncMock.mockReturnValue(
      new Promise((resolve) => {
        resolveEnrich = () => resolve(baseSnapshot);
      }),
    );

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const rebuildResponse = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-active-enrich/rebuild?branch=main&enableAiSummaries=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(rebuildResponse.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    getCodeIndexSnapshotMetaMock.mockResolvedValue(baseSnapshot.meta);
    const statusResponse = await inject(app, {
      method: 'GET',
      url: '/api/code-index/repo-active-enrich/status?branch=main',
    });

    expect(statusResponse.statusCode).toBe(200);
    expect(JSON.parse(statusResponse.body)).toMatchObject({
      progress: {
        status: 'building',
        stage: 'summaries',
      },
    });

    resolveEnrich?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('surfaces interrupted building state from persisted meta when no worker is active', async () => {
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-interrupted',
      name: 'Repo Interrupted',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    getCodeIndexSnapshotMetaMock.mockResolvedValue({
      repositoryId: 'repo-interrupted',
      branch: 'main',
      rootDirectory: process.cwd(),
      manifestHash: 'hash-interrupted',
      status: 'building',
      stage: 'summaries',
      generatedAt: null,
      stats: {
        fileCount: 12,
        chunkCount: 48,
        functionCount: 30,
        functionEdgeCount: 12,
        totalLines: 1200,
        embeddedChunkCount: 0,
      },
      capabilities: {
        chunkSearch: true,
        fileSummaries: true,
        functionGraph: true,
        embeddings: false,
      },
      progress: {
        status: 'building',
        stage: 'summaries',
        processedFiles: 12,
        totalFiles: 12,
        message: '基础索引已完成，正在生成摘要',
        error: null,
        startedAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:30.000Z',
      },
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/api/code-index/repo-interrupted/status?branch=main',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      progress: {
        status: 'error',
        stage: 'idle',
        message: '上一次代码索引构建已中断，请重新触发重建。',
      },
    });
  });
});
