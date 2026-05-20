import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import inject from 'light-my-request';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_DIR } from './config.js';

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
  saveCodeIndexStateDeltaMock,
  saveCodeIndexSnapshotMock,
  saveCodeIndexSnapshotMetaMock,
  saveCodeIndexSummaryDeltaMock,
  loadCodeMapFromDbMock,
  saveCodeMapToDbMock,
  getReviewRepositoryByIdMock,
  listWorktreesMock,
  acquireWorktreeMock,
  generateTextWithDefaultProviderMock,
  cachedEmbedQueryMock,
  resolvePromptTextMock,
  resolveEmbeddingProviderMock,
  searchByVectorMock,
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
  saveCodeIndexStateDeltaMock: vi.fn(async () => undefined),
  saveCodeIndexSnapshotMock: vi.fn(async () => undefined),
  saveCodeIndexSnapshotMetaMock: vi.fn(async () => undefined),
  saveCodeIndexSummaryDeltaMock: vi.fn(async () => undefined),
  loadCodeMapFromDbMock: vi.fn(async () => null),
  saveCodeMapToDbMock: vi.fn(async () => undefined),
  getReviewRepositoryByIdMock: vi.fn(),
  listWorktreesMock: vi.fn(async () => []),
  acquireWorktreeMock: vi.fn(async () => null),
  generateTextWithDefaultProviderMock: vi.fn(async () => 'AI answer'),
  cachedEmbedQueryMock: vi.fn(async () => [0.1, 0.2, 0.3]),
  resolvePromptTextMock: vi.fn(async () => ({ text: 'Use only provided context.' })),
  resolveEmbeddingProviderMock: vi.fn(async () => null),
  searchByVectorMock: vi.fn(async () => []),
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
  saveCodeIndexStateDelta: saveCodeIndexStateDeltaMock,
  saveCodeIndexSnapshot: saveCodeIndexSnapshotMock,
  saveCodeIndexSnapshotMeta: saveCodeIndexSnapshotMetaMock,
  saveCodeIndexSummaryDelta: saveCodeIndexSummaryDeltaMock,
  listCodeIndexSnapshotMetasByStatus: listCodeIndexSnapshotMetasByStatusMock,
}));

vi.mock('./code-intelligence/code-map-persist.js', () => ({
  loadCodeMapFromDb: loadCodeMapFromDbMock,
  saveCodeMapToDb: saveCodeMapToDbMock,
}));

vi.mock('./provider/provider-api.js', () => ({
  generateTextWithDefaultProvider: generateTextWithDefaultProviderMock,
}));

vi.mock('./embedding/resolve.js', () => ({
  resolveEmbeddingProvider: resolveEmbeddingProviderMock,
}));

vi.mock('./embedding/vector-store.js', () => ({
  cachedEmbedQuery: cachedEmbedQueryMock,
  searchByVector: searchByVectorMock,
}));

vi.mock('./prompt/prompt-service.js', () => ({
  resolvePromptText: resolvePromptTextMock,
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
    saveCodeIndexStateDeltaMock.mockReset();
    saveCodeIndexStateDeltaMock.mockResolvedValue(undefined);
    cachedEmbedQueryMock.mockReset();
    cachedEmbedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
    loadCodeMapFromDbMock.mockReset();
    loadCodeMapFromDbMock.mockResolvedValue(null);
    resolveEmbeddingProviderMock.mockReset();
    resolveEmbeddingProviderMock.mockResolvedValue(null);
    saveCodeIndexSummaryDeltaMock.mockReset();
    saveCodeIndexSummaryDeltaMock.mockResolvedValue(undefined);
    searchByVectorMock.mockReset();
    searchByVectorMock.mockResolvedValue([]);
    saveCodeMapToDbMock.mockReset();
    generateTextWithDefaultProviderMock.mockReset();
    generateTextWithDefaultProviderMock.mockResolvedValue('AI answer');
    resolvePromptTextMock.mockReset();
    resolvePromptTextMock.mockResolvedValue({
      text: 'Use only provided context.',
    });
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
    expect(buildCodeIndexAsyncMock.mock.calls[0]?.[3]).toMatchObject({
      codeMapSnapshot: null,
    });
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

  it('passes an existing code map snapshot into the unified index build', async () => {
    const existingCodeMapSnapshot = {
      repositoryId: 'repo-with-map',
      branch: 'main',
      rootDirectory: process.cwd(),
      generatedAt: '2026-04-23T00:00:00.000Z',
      manifestHash: 'hash-map',
      files: [],
      edges: [],
      stats: {
        fileCount: 0,
        symbolCount: 0,
        edgeCount: 0,
        totalLines: 0,
      },
    };
    loadCodeMapFromDbMock.mockResolvedValue(existingCodeMapSnapshot);
    buildCodeIndexAsyncMock.mockResolvedValue({
      meta: {
        repositoryId: 'repo-with-map',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-map',
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
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-with-map',
      name: 'Repo With Map',
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
      url: '/api/code-index/repo-with-map/rebuild?branch=main&force=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(202);
    expect(buildCodeIndexAsyncMock.mock.calls[0]?.[3]).toMatchObject({
      codeMapSnapshot: existingCodeMapSnapshot,
    });
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

  it('routes enrichment snapshots through summary and state delta persistence', async () => {
    getCodeIndexSnapshotMetaMock.mockResolvedValue(null);
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-enrich-deltas',
      name: 'Repo Enrich Deltas',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    const baseSnapshot = {
      meta: {
        repositoryId: 'repo-enrich-deltas',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-delta',
        status: 'building',
        stage: 'summaries',
        generatedAt: null,
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
          status: 'building',
          stage: 'summaries',
          processedFiles: 0,
          totalFiles: 1,
          message: 'building summaries',
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
    const summarySnapshot = {
      ...baseSnapshot,
      meta: {
        ...baseSnapshot.meta,
        stage: 'embeddings',
        progress: {
          ...baseSnapshot.meta.progress,
          stage: 'embeddings',
          processedFiles: 1,
          message: 'embedding next',
        },
      },
    };
    const finalSnapshot = {
      ...baseSnapshot,
      meta: {
        ...baseSnapshot.meta,
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-04-23T00:01:00.000Z',
        stats: {
          ...baseSnapshot.meta.stats,
          embeddedChunkCount: 1,
        },
        capabilities: {
          ...baseSnapshot.meta.capabilities,
          embeddings: true,
        },
        progress: {
          ...baseSnapshot.meta.progress,
          status: 'ready',
          stage: 'complete',
          processedFiles: 1,
          message: 'done',
        },
      },
    };

    buildCodeIndexAsyncMock.mockResolvedValue(baseSnapshot);
    loadCodeIndexSnapshotMock.mockResolvedValue(baseSnapshot);
    enrichCodeIndexSnapshotAsyncMock.mockImplementation(async (_root, _snapshot, options) => {
      await options?.onSnapshot?.(summarySnapshot as never);
      await options?.onSnapshot?.(finalSnapshot as never);
      return finalSnapshot as never;
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-enrich-deltas/rebuild?branch=main&enableAiSummaries=1&enableEmbeddings=1',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(saveCodeIndexSnapshotMock).toHaveBeenCalledTimes(1);
    expect(saveCodeIndexSummaryDeltaMock).toHaveBeenCalledTimes(1);
    expect(saveCodeIndexSummaryDeltaMock).toHaveBeenCalledWith(
      summarySnapshot,
      'test-user',
    );
    expect(saveCodeIndexStateDeltaMock).toHaveBeenCalledTimes(1);
    expect(saveCodeIndexStateDeltaMock).toHaveBeenCalledWith(
      finalSnapshot,
      'test-user',
    );
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

  it('maps vector hits back to chunks by content hash for code search', async () => {
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-search',
      name: 'Repo Search',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    loadCodeIndexSearchDataMock.mockResolvedValue({
      meta: {
        repositoryId: 'repo-search',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'hash-search',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-04-23T00:00:00.000Z',
        stats: {
          fileCount: 1,
          chunkCount: 2,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 10,
          embeddedChunkCount: 2,
        },
        capabilities: {
          chunkSearch: true,
          fileSummaries: true,
          functionGraph: false,
          embeddings: true,
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
      },
      files: [
        {
          relativePath: 'src/search.ts',
          language: 'typescript',
          byteSize: 100,
          lineCount: 4,
          fileHash: 'file-hash',
          rank: 1,
          importCount: 0,
          exportCount: 1,
          summary: 'search file',
          summarySource: 'fallback',
        },
      ],
      chunks: [
        {
          id: 'chunk-1',
          filePath: 'src/search.ts',
          chunkIndex: 0,
          startLine: 1,
          endLine: 2,
          content: 'export const alpha = 1;',
          tokenCount: 5,
          summary: 'alpha chunk',
          contentHash: 'shared-hash',
          summarySource: 'fallback',
        },
        {
          id: 'chunk-2',
          filePath: 'src/search.ts',
          chunkIndex: 1,
          startLine: 3,
          endLine: 4,
          content: 'export const beta = 2;',
          tokenCount: 5,
          summary: 'beta chunk',
          contentHash: 'other-hash',
          summarySource: 'fallback',
        },
      ],
    });
    resolveEmbeddingProviderMock.mockResolvedValue({ id: 'provider-1' });
    searchByVectorMock.mockResolvedValue([
      { id: 'vec-1', ownerId: 'shared-hash', ownerType: 'code_chunk', score: 0.92 },
    ]);

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-search/search?branch=main',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'zzznomatch', limit: 5 },
    });

    expect(response.statusCode).toBe(200);
    expect(searchByVectorMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body)).toMatchObject({
      results: [
        {
          chunkId: 'chunk-1',
          matchedBy: 'vector',
        },
      ],
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

  it('queries the project graph for implementation-focused questions', async () => {
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-graph',
      name: 'Repo Graph',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    loadCodeIndexSnapshotMock.mockResolvedValue({
      meta: {
        repositoryId: 'repo-graph',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'graph-hash',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-05-18T00:00:00.000Z',
        stats: {
          fileCount: 2,
          chunkCount: 2,
          functionCount: 2,
          functionEdgeCount: 1,
          totalLines: 100,
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
          processedFiles: 2,
          totalFiles: 2,
          message: 'done',
          error: null,
          startedAt: '2026-05-18T00:00:00.000Z',
          updatedAt: '2026-05-18T00:00:00.000Z',
        },
      },
      files: [
        {
          relativePath: 'src/auth/login.ts',
          language: 'ts',
          byteSize: 600,
          lineCount: 30,
          fileHash: 'a',
          rank: 9,
          importCount: 1,
          exportCount: 1,
          summary: 'Login flow implementation.',
          summarySource: 'fallback',
        },
        {
          relativePath: 'src/auth/session.ts',
          language: 'ts',
          byteSize: 500,
          lineCount: 20,
          fileHash: 'b',
          rank: 7,
          importCount: 0,
          exportCount: 1,
          summary: 'Session creation helper.',
          summarySource: 'fallback',
        },
      ],
      chunks: [
        {
          id: 'chunk-login',
          filePath: 'src/auth/login.ts',
          chunkIndex: 0,
          startLine: 1,
          endLine: 12,
          content: 'export async function loginUser(input) { return createSession(input); }',
          tokenCount: 20,
          summary: 'Login entrypoint.',
          contentHash: 'c1',
          summarySource: 'fallback',
        },
        {
          id: 'chunk-session',
          filePath: 'src/auth/session.ts',
          chunkIndex: 0,
          startLine: 1,
          endLine: 8,
          content: 'export function createSession(input) { return { token: input.userId }; }',
          tokenCount: 18,
          summary: 'Session creator.',
          contentHash: 'c2',
          summarySource: 'fallback',
        },
      ],
      functions: [
        {
          id: 'fn-login',
          filePath: 'src/auth/login.ts',
          name: 'loginUser',
          kind: 'function',
          signature: 'export async function loginUser(input)',
          startLine: 1,
          endLine: 12,
          line: 1,
          column: 1,
          parentFunctionId: null,
        },
        {
          id: 'fn-session',
          filePath: 'src/auth/session.ts',
          name: 'createSession',
          kind: 'function',
          signature: 'export function createSession(input)',
          startLine: 1,
          endLine: 8,
          line: 1,
          column: 1,
          parentFunctionId: null,
        },
      ],
      functionEdges: [
        {
          id: 'edge-1',
          fromFunctionId: 'fn-login',
          toFunctionId: 'fn-session',
          edgeType: 'call',
          symbol: 'createSession',
          line: 3,
        },
      ],
    });
    loadCodeMapFromDbMock.mockResolvedValue({
      repositoryId: 'repo-graph',
      branch: 'main',
      rootDirectory: process.cwd(),
      generatedAt: '2026-05-18T00:00:00.000Z',
      manifestHash: 'graph-hash',
      files: [],
      edges: [
        {
          fromFile: 'src/auth/login.ts',
          toFile: 'src/auth/session.ts',
          symbols: ['createSession'],
        },
      ],
      stats: {
        fileCount: 2,
        symbolCount: 0,
        edgeCount: 1,
        totalLines: 50,
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
      url: '/api/code-index/repo-graph/graph/query?branch=main',
      headers: { 'content-type': 'application/json' },
      payload: {
        question: 'where is login implemented',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      result: {
        matches: {
          files: [
            {
              filePath: 'src/auth/login.ts',
            },
          ],
          functions: [
            {
              label: 'loginUser',
            },
          ],
        },
      },
    });
  });

  it('answers project questions with graph-grounded context', async () => {
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: 'repo-ask',
      name: 'Repo Ask',
      default_target_branch: 'main',
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    loadCodeIndexSnapshotMock.mockResolvedValue({
      meta: {
        repositoryId: 'repo-ask',
        branch: 'main',
        rootDirectory: process.cwd(),
        manifestHash: 'ask-hash',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-05-18T00:00:00.000Z',
        stats: {
          fileCount: 1,
          chunkCount: 1,
          functionCount: 1,
          functionEdgeCount: 0,
          totalLines: 20,
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
          startedAt: '2026-05-18T00:00:00.000Z',
          updatedAt: '2026-05-18T00:00:00.000Z',
        },
      },
      files: [
        {
          relativePath: 'src/auth/login.ts',
          language: 'ts',
          byteSize: 600,
          lineCount: 20,
          fileHash: 'a',
          rank: 10,
          importCount: 0,
          exportCount: 1,
          summary: 'Login flow implementation.',
          summarySource: 'fallback',
        },
      ],
      chunks: [
        {
          id: 'chunk-login',
          filePath: 'src/auth/login.ts',
          chunkIndex: 0,
          startLine: 1,
          endLine: 12,
          content: 'export async function loginUser(input) { return input; }',
          tokenCount: 16,
          summary: 'Login entrypoint.',
          contentHash: 'c1',
          summarySource: 'fallback',
        },
      ],
      functions: [
        {
          id: 'fn-login',
          filePath: 'src/auth/login.ts',
          name: 'loginUser',
          kind: 'function',
          signature: 'export async function loginUser(input)',
          startLine: 1,
          endLine: 12,
          line: 1,
          column: 1,
          parentFunctionId: null,
        },
      ],
      functionEdges: [],
    });
    loadCodeMapFromDbMock.mockResolvedValue({
      repositoryId: 'repo-ask',
      branch: 'main',
      rootDirectory: process.cwd(),
      generatedAt: '2026-05-18T00:00:00.000Z',
      manifestHash: 'ask-hash',
      files: [],
      edges: [],
      stats: {
        fileCount: 1,
        symbolCount: 0,
        edgeCount: 0,
        totalLines: 20,
      },
    });
    generateTextWithDefaultProviderMock.mockResolvedValue(
      'Likely implemented in src/auth/login.ts:1-12 via loginUser.',
    );

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/code-index/repo-ask/ask?branch=main',
      headers: { 'content-type': 'application/json' },
      payload: {
        question: 'where is login implemented',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      answer: 'Likely implemented in src/auth/login.ts:1-12 via loginUser.',
      qa: {
        retrievalProfile: 'implementation',
        focusPaths: [],
        exploration: {
          selectedFiles: ['src/auth/login.ts'],
          matchedFunctionCount: 1,
          matchedChunkCount: 1,
        },
      },
    });
    expect(generateTextWithDefaultProviderMock).toHaveBeenCalledTimes(1);
    expect(String(generateTextWithDefaultProviderMock.mock.calls[0]?.[0] || '')).toContain(
      'Focused exploration evidence:',
    );
    expect(String(generateTextWithDefaultProviderMock.mock.calls[0]?.[0] || '')).toContain(
      'file: src/auth/login.ts',
    );
  });

  it('persists graph query artifacts and exposes list/detail endpoints', async () => {
    const artifactRepoId = 'repo-graph-artifacts';
    const artifactBranch = 'main';
    fs.rmSync(
      path.join(DATA_DIR, 'project-graph-queries', artifactRepoId, artifactBranch),
      { recursive: true, force: true },
    );
    getReviewRepositoryByIdMock.mockResolvedValue({
      id: artifactRepoId,
      name: 'Repo Graph Artifacts',
      default_target_branch: artifactBranch,
      local_repo_path: process.cwd(),
      clone_url: null,
    });
    loadCodeIndexSnapshotMock.mockResolvedValue({
      meta: {
        repositoryId: artifactRepoId,
        branch: artifactBranch,
        rootDirectory: process.cwd(),
        manifestHash: 'artifact-hash',
        status: 'ready',
        stage: 'complete',
        generatedAt: '2026-05-18T00:00:00.000Z',
        stats: {
          fileCount: 1,
          chunkCount: 1,
          functionCount: 1,
          functionEdgeCount: 0,
          totalLines: 20,
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
          startedAt: '2026-05-18T00:00:00.000Z',
          updatedAt: '2026-05-18T00:00:00.000Z',
        },
      },
      files: [
        {
          relativePath: 'src/auth/login.ts',
          language: 'ts',
          byteSize: 600,
          lineCount: 20,
          fileHash: 'a',
          rank: 10,
          importCount: 0,
          exportCount: 1,
          summary: 'Login flow implementation.',
          summarySource: 'fallback',
        },
      ],
      chunks: [
        {
          id: 'chunk-login',
          filePath: 'src/auth/login.ts',
          chunkIndex: 0,
          startLine: 1,
          endLine: 12,
          content: 'export async function loginUser(input) { return input; }',
          tokenCount: 16,
          summary: 'Login entrypoint.',
          contentHash: 'c1',
          summarySource: 'fallback',
        },
      ],
      functions: [
        {
          id: 'fn-login',
          filePath: 'src/auth/login.ts',
          name: 'loginUser',
          kind: 'function',
          signature: 'export async function loginUser(input)',
          startLine: 1,
          endLine: 12,
          line: 1,
          column: 1,
          parentFunctionId: null,
        },
      ],
      functionEdges: [],
    });
    loadCodeMapFromDbMock.mockResolvedValue({
      repositoryId: artifactRepoId,
      branch: artifactBranch,
      rootDirectory: process.cwd(),
      generatedAt: '2026-05-18T00:00:00.000Z',
      manifestHash: 'artifact-hash',
      files: [],
      edges: [],
      stats: {
        fileCount: 1,
        symbolCount: 0,
        edgeCount: 0,
        totalLines: 20,
      },
    });

    const app = express();
    app.use(express.json());
    registerCodeIndexRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
    });

    const queryResponse = await inject(app, {
      method: 'POST',
      url: `/api/code-index/${artifactRepoId}/graph/query?branch=${artifactBranch}`,
      headers: { 'content-type': 'application/json' },
      payload: {
        question: 'where is login implemented',
      },
    });

    expect(queryResponse.statusCode).toBe(200);
    const queryPayload = JSON.parse(queryResponse.body);
    expect(queryPayload.artifact?.id).toBeTruthy();
    expect(queryPayload.artifact?.observability).toMatchObject({
      source: 'code-index.graph.query',
      kind: 'query',
      status: 'ready',
      nodeCount: expect.any(Number),
      edgeCount: expect.any(Number),
      selectedFiles: ['src/auth/login.ts'],
      selectedFileCount: 1,
      confidence: {
        overall: expect.any(Number),
      },
      planner: {
        strategy: expect.any(String),
      },
    });
    expect(queryPayload.artifact.observability.durationMs).toBeGreaterThanOrEqual(
      0,
    );

    const listResponse = await inject(app, {
      method: 'GET',
      url: `/api/code-index/${artifactRepoId}/graph/queries?branch=${artifactBranch}`,
    });
    expect(listResponse.statusCode).toBe(200);
    const listPayload = JSON.parse(listResponse.body);
    expect(listPayload.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: queryPayload.artifact.id,
          question: 'where is login implemented',
          observability: expect.objectContaining({
            source: 'code-index.graph.query',
            kind: 'query',
            status: 'ready',
            selectedFiles: ['src/auth/login.ts'],
          }),
        }),
      ]),
    );

    const detailResponse = await inject(app, {
      method: 'GET',
      url: `/api/code-index/${artifactRepoId}/graph/queries/${queryPayload.artifact.id}?branch=${artifactBranch}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      artifact: {
        id: queryPayload.artifact.id,
        question: 'where is login implemented',
        observability: {
          source: 'code-index.graph.query',
          kind: 'query',
          status: 'ready',
          selectedFileCount: 1,
        },
      },
    });
  });
});
