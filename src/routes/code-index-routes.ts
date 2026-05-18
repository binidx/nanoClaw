import fs from 'node:fs';
import path from 'node:path';

import type { Express, Request } from 'express';

import {
  buildCodeIndexAsync,
  enrichCodeIndexSnapshotAsync,
  type CodeIndexBuildOptions,
} from '../code-index-builder.js';
import type {
  CodeIndexProgress,
  CodeIndexSearchResult,
  CodeIndexSnapshot,
  CodeIndexSnapshotMeta,
} from '../code-intelligence/code-index-types.js';
import {
  loadCodeIndexSnapshot,
  loadCodeIndexSearchData,
  loadCodeIndexFileData,
  loadCodeIndexFunctionsData,
  loadCodeIndexFunctionGraphData,
  getCodeIndexSnapshotMeta,
  listCodeIndexSnapshotMetasByStatus,
  saveCodeIndexSnapshot,
  saveCodeIndexSnapshotMeta,
} from '../db/code-index-db.js';
import {
  loadCodeMapFromDb,
  saveCodeMapToDb,
} from '../code-intelligence/code-map-persist.js';
import {
  getReviewRepositoryById,
  type ReviewRepositoryRecord,
} from '../db/review.js';
import { cachedEmbedQuery, searchByVector } from '../embedding/vector-store.js';
import { resolveEmbeddingProvider } from '../embedding/resolve.js';
import { computeCodeMapManifestHash } from '../code-intelligence/code-map-builder.js';
import { canAccessRepositoryResource } from '../auth/resource-access-policy.js';
import {
  listCandidateFiles,
  normalizeRelativePath,
} from '../code-intelligence/code-search-collect.js';
import {
  resolveBuildOptions,
  tokenize,
} from '../code-intelligence/code-search-index.js';
import { getCurrentUserId } from '../tenant-context.js';
import { acquireWorktree, listWorktrees } from '../worktree-manager.js';
import { DATA_DIR } from '../config.js';
import { runGitCommand } from '../repo-review/repo-review-git.js';
import { t } from '../i18n/index.js';

export interface CodeIndexRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

const progressCache = new Map<string, CodeIndexProgress>();
const buildingSet = new Set<string>();
const enrichingSet = new Set<string>();
let codeIndexRecoveryStarted = false;
type CodeIndexSourceInfo = NonNullable<CodeIndexBuildOptions['sourceInfo']>;

function progressKey(repositoryId: string, branch: string): string {
  return `${repositoryId}\0${branch}`;
}

function resolveDefaultBranch(repo: {
  default_target_branch?: string | null;
}): string {
  return repo.default_target_branch?.trim() || 'main';
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

async function resolveCodeRootDirectory(
  repo: ReviewRepositoryRecord,
  branch: string,
): Promise<string | null> {
  const shouldPreferRemoteSource = Boolean(
    repo.clone_url || repo.remote_provider,
  );
  const worktrees = await listWorktrees(repo.id);
  const match = worktrees.find((worktree) => worktree.branch === branch);
  if (match?.workDirectory && isExistingDirectory(match.workDirectory))
    return match.workDirectory;
  if (shouldPreferRemoteSource) {
    return await acquireWorktree({
      repositoryId: repo.id,
      branch,
      cloneUrl: repo.clone_url || undefined,
      purpose: 'code-index',
    });
  }
  if (repo.local_repo_path && isExistingDirectory(repo.local_repo_path)) {
    return repo.local_repo_path;
  }
  return null;
}

async function resolveCurrentManifestHash(
  rootDirectory: string,
): Promise<string> {
  const searchOptions = resolveBuildOptions({ maxFiles: 2000 });
  const candidatePaths = listCandidateFiles(rootDirectory, searchOptions);
  const manifestEntries = candidatePaths.map((absolutePath) => {
    try {
      const stat = fs.statSync(absolutePath);
      return {
        relativePath: normalizeRelativePath(rootDirectory, absolutePath),
        byteSize: stat.size,
        modifiedTimeMs: Math.trunc(stat.mtimeMs),
      };
    } catch {
      return {
        relativePath: normalizeRelativePath(rootDirectory, absolutePath),
        byteSize: 0,
        modifiedTimeMs: 0,
      };
    }
  });
  return computeCodeMapManifestHash(
    path.resolve(rootDirectory),
    manifestEntries,
  );
}

function updateProgress(
  repositoryId: string,
  branch: string,
  progress: CodeIndexProgress,
): void {
  progressCache.set(progressKey(repositoryId, branch), progress);
}

function currentProgress(
  repositoryId: string,
  branch: string,
): CodeIndexProgress | null {
  return progressCache.get(progressKey(repositoryId, branch)) || null;
}

function resolveCodeIndexSourceKind(
  rootDirectory: string,
): CodeIndexSnapshotMeta['sourceKind'] {
  const resolved = path.resolve(rootDirectory || '');
  if (!resolved) return 'unknown';
  const worktreeRoot = path.resolve(path.join(DATA_DIR, 'review-workspaces'));
  const mirrorRoot = path.resolve(path.join(DATA_DIR, 'repo-mirrors'));
  if (
    resolved === worktreeRoot ||
    resolved.startsWith(`${worktreeRoot}${path.sep}`)
  ) {
    return 'remote_worktree';
  }
  if (
    resolved === mirrorRoot ||
    resolved.startsWith(`${mirrorRoot}${path.sep}`)
  ) {
    return 'mirror';
  }
  return 'workspace';
}

function resolveCodeIndexHeadSha(rootDirectory: string): string {
  if (!rootDirectory || !isExistingDirectory(rootDirectory)) return '';
  return runGitCommand(rootDirectory, ['rev-parse', 'HEAD'], true);
}

function buildCodeIndexSourceInfo(
  rootDirectory: string,
  branch: string,
): CodeIndexSourceInfo {
  return {
    sourceKind: resolveCodeIndexSourceKind(rootDirectory),
    sourceBranch: branch,
    sourceHeadSha: resolveCodeIndexHeadSha(rootDirectory),
  };
}

function hasActiveCodeIndexWorker(key: string): boolean {
  return buildingSet.has(key) || enrichingSet.has(key);
}

function enrichCodeIndexMeta(
  repositoryId: string,
  branch: string,
  meta: CodeIndexSnapshotMeta | null,
): CodeIndexSnapshotMeta | null {
  if (!meta) return null;
  const sourceKind =
    meta.sourceKind || resolveCodeIndexSourceKind(meta.rootDirectory);
  const sourceHeadSha =
    meta.sourceHeadSha || resolveCodeIndexHeadSha(meta.rootDirectory);
  const baseReady = meta.status === 'ready' || meta.stage !== 'scan';
  const summaryReady =
    meta.status === 'ready' ||
    (meta.stage !== 'summaries' &&
      meta.capabilities.fileSummaries &&
      meta.stats.fileCount > 0);
  const embeddingsReady =
    meta.status === 'ready' && meta.capabilities.embeddings;
  return {
    ...meta,
    repositoryId,
    branch,
    sourceKind,
    sourceBranch: meta.sourceBranch || branch,
    sourceHeadSha,
    baseReady,
    summaryReady,
    embeddingsReady,
  };
}

function resolveVisibleProgress(
  repositoryId: string,
  branch: string,
  meta: CodeIndexSnapshot['meta'] | CodeIndexSnapshotMeta | null,
): CodeIndexProgress {
  const key = progressKey(repositoryId, branch);
  const memoryProgress = currentProgress(repositoryId, branch);
  const progress: CodeIndexProgress = memoryProgress
    ? memoryProgress
    : meta?.progress
      ? {
          repositoryId,
          branch,
          ...meta.progress,
        }
      : toMissingProgress(repositoryId, branch);
  if (progress.status === 'building' && !hasActiveCodeIndexWorker(key)) {
    return {
      ...progress,
      status: 'error',
      stage: 'idle',
      message: t('errors.auto_aaede9', {}, undefined),
      error: progress.error || 'code index build interrupted',
      updatedAt: new Date().toISOString(),
    };
  }
  return progress;
}

function toMissingProgress(
  repositoryId: string,
  branch: string,
): CodeIndexProgress {
  return {
    repositoryId,
    branch,
    status: 'missing',
    stage: 'idle',
    processedFiles: 0,
    totalFiles: 0,
    message: t('errors.auto_84302b', {}, undefined),
    error: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSearchResults(
  snapshot: Pick<CodeIndexSnapshot, 'meta' | 'files' | 'chunks'>,
  vectorScores: Map<string, number>,
  query: string,
  limit: number,
): CodeIndexSearchResult[] {
  const fileSummaryByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file.summary]),
  );
  const fileSummarySourceByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file.summarySource]),
  );
  const queryTerms = tokenize(query).slice(0, 10);
  const rawQuery = query.trim().toLowerCase();
  const termScores = new Map<string, number>();

  for (const chunk of snapshot.chunks) {
    const haystack = `${chunk.filePath}\n${chunk.summary}\n${fileSummaryByPath.get(chunk.filePath) || ''}\n${chunk.content}`;
    const loweredHaystack = haystack.toLowerCase();
    const terms = new Set(tokenize(haystack));
    let score = 0;
    for (const queryTerm of queryTerms) {
      if (chunk.filePath.toLowerCase().includes(queryTerm)) score += 8;
      else if (
        (fileSummaryByPath.get(chunk.filePath) || '')
          .toLowerCase()
          .includes(queryTerm)
      )
        score += 5;
      else if (chunk.summary.toLowerCase().includes(queryTerm)) score += 4;
      else if (terms.has(queryTerm)) score += 1.5;
    }
    if (
      score <= 0 &&
      rawQuery &&
      queryTerms.length === 0 &&
      loweredHaystack.includes(rawQuery)
    ) {
      score = 2.5;
    }
    if (score > 0) termScores.set(chunk.id, score);
  }

  const maxTerm = Math.max(...termScores.values(), 0);
  const rows: CodeIndexSearchResult[] = [];
  for (const chunk of snapshot.chunks) {
    const termScore = termScores.get(chunk.id) || 0;
    const vectorScore = vectorScores.get(chunk.id) || 0;
    if (termScore <= 0 && vectorScore <= 0) continue;
    const normalizedTerm = maxTerm > 0 ? termScore / maxTerm : 0;
    const score =
      vectorScore > 0 && normalizedTerm > 0
        ? normalizedTerm * 0.45 + vectorScore * 0.55
        : Math.max(normalizedTerm, vectorScore);
    rows.push({
      chunkId: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      matchedBy:
        vectorScore > 0 && normalizedTerm > 0
          ? 'hybrid'
          : vectorScore > 0
            ? 'vector'
            : 'term',
      summary: chunk.summary,
      summarySource: chunk.summarySource,
      fileSummary: fileSummaryByPath.get(chunk.filePath) || '',
      fileSummarySource:
        fileSummarySourceByPath.get(chunk.filePath) || 'fallback',
      preview:
        chunk.content.length > 280
          ? `${chunk.content.slice(0, 280)}...`
          : chunk.content,
    });
  }
  rows.sort((left, right) => right.score - left.score);
  return rows.slice(0, limit);
}

function collectFunctionDeps(
  snapshot: Pick<CodeIndexSnapshot, 'functions' | 'functionEdges'>,
  functionId: string,
  direction: 'upstream' | 'downstream',
  depth: number,
) {
  const results: Array<{
    edge: CodeIndexSnapshot['functionEdges'][number];
    node: CodeIndexSnapshot['functions'][number];
  }> = [];
  const functionsById = new Map(snapshot.functions.map((fn) => [fn.id, fn]));
  const edges =
    direction === 'downstream'
      ? snapshot.functionEdges
      : snapshot.functionEdges.map((edge) => ({
          ...edge,
          fromFunctionId: edge.toFunctionId,
          toFunctionId: edge.fromFunctionId,
        }));
  const adjacency = new Map<string, typeof edges>();
  for (const edge of edges) {
    const bucket = adjacency.get(edge.fromFunctionId) || [];
    bucket.push(edge);
    adjacency.set(edge.fromFunctionId, bucket);
  }

  const queue: Array<{ id: string; depth: number }> = [
    { id: functionId, depth: 0 },
  ];
  const seen = new Set([functionId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    const outgoing = adjacency.get(current.id) || [];
    for (const edge of outgoing) {
      const node = functionsById.get(edge.toFunctionId);
      if (!node) continue;
      results.push({ edge, node });
      if (!seen.has(node.id)) {
        seen.add(node.id);
        queue.push({ id: node.id, depth: current.depth + 1 });
      }
    }
  }

  return results;
}

function getTenantUserId(req: Request): string {
  return (
    (req as Request & { tenantUserId?: string }).tenantUserId ||
    getCurrentUserId()
  );
}

async function startCodeIndexRebuild(
  repositoryId: string,
  branch: string,
  rootDirectory: string,
  userId: string,
  options: {
    summarizeWithAi: boolean;
    embedChunks: boolean;
  },
): Promise<void> {
  const key = progressKey(repositoryId, branch);
  const startedAt = new Date().toISOString();
  const initialProgress: CodeIndexProgress = {
    repositoryId,
    branch,
    status: 'building',
    stage: 'scan',
    processedFiles: 0,
    totalFiles: 0,
    message: t('errors.auto_e5fe60', {}, undefined),
    error: null,
    startedAt,
    updatedAt: startedAt,
  };
  buildingSet.add(key);
  updateProgress(repositoryId, branch, initialProgress);
  const sourceInfo = buildCodeIndexSourceInfo(rootDirectory, branch);
  const existingCodeMapSnapshot = await loadCodeMapFromDb(repositoryId, branch);
  await saveCodeIndexSnapshotMeta({
    repositoryId,
    branch,
    rootDirectory,
    sourceKind: sourceInfo.sourceKind,
    sourceBranch: sourceInfo.sourceBranch,
    sourceHeadSha: sourceInfo.sourceHeadSha,
    manifestHash: '',
    progress: initialProgress,
    userId,
  });
  let persistedSnapshot = false;

  void buildCodeIndexAsync(rootDirectory, repositoryId, branch, {
    summarizeWithAi: false,
    embedChunks: false,
    codeMapSnapshot: existingCodeMapSnapshot,
    sourceInfo,
    onCodeMapSnapshot: async (codeMapSnapshot) => {
      await saveCodeMapToDb(codeMapSnapshot);
    },
    onProgress: async (progress) => {
      const persisted: CodeIndexProgress = {
        repositoryId,
        branch,
        ...progress,
      };
      updateProgress(repositoryId, branch, persisted);
      await saveCodeIndexSnapshotMeta({
        repositoryId,
        branch,
        rootDirectory,
        sourceKind: sourceInfo.sourceKind,
        sourceBranch: sourceInfo.sourceBranch,
        sourceHeadSha: sourceInfo.sourceHeadSha,
        manifestHash: '',
        progress,
        userId,
      });
    },
    onSnapshot: async (snapshot) => {
      persistedSnapshot = true;
      updateProgress(repositoryId, branch, {
        repositoryId,
        branch,
        ...snapshot.meta.progress,
      });
      await saveCodeIndexSnapshot(snapshot, userId);
    },
  })
    .then(async (baseSnapshot) => {
      if (!persistedSnapshot) {
        await saveCodeIndexSnapshot(baseSnapshot, userId);
      }
      updateProgress(repositoryId, branch, {
        repositoryId,
        branch,
        ...baseSnapshot.meta.progress,
      });
      if (!options.summarizeWithAi && !options.embedChunks) return baseSnapshot;
      await startCodeIndexEnrichment({
        repositoryId,
        branch,
        rootDirectory,
        userId,
        summarizeWithAi: options.summarizeWithAi,
        embedChunks: options.embedChunks,
      });
      return baseSnapshot;
    })
    .catch(async (err) => {
      const message =
        err instanceof Error
          ? err.message
          : t('errors.auto_798ce2', {}, undefined);
      updateProgress(repositoryId, branch, {
        repositoryId,
        branch,
        status: 'error',
        stage: 'idle',
        processedFiles: 0,
        totalFiles: 0,
        message: t('errors.auto_798ce2', {}, undefined),
        error: message,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
      await saveCodeIndexSnapshotMeta({
        repositoryId,
        branch,
        rootDirectory,
        sourceKind: sourceInfo.sourceKind,
        sourceBranch: sourceInfo.sourceBranch,
        sourceHeadSha: sourceInfo.sourceHeadSha,
        manifestHash: '',
        progress: {
          status: 'error',
          stage: 'idle',
          processedFiles: 0,
          totalFiles: 0,
          message: t('errors.auto_798ce2', {}, undefined),
          error: message,
          startedAt,
          updatedAt: new Date().toISOString(),
        },
        userId,
      });
    })
    .finally(() => {
      buildingSet.delete(key);
    });
}

async function startCodeIndexEnrichment(input: {
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  userId: string;
  summarizeWithAi: boolean;
  embedChunks: boolean;
}): Promise<void> {
  const key = progressKey(input.repositoryId, input.branch);
  if (enrichingSet.has(key)) return;
  const snapshot = await loadCodeIndexSnapshot(
    input.repositoryId,
    input.branch,
  );
  if (!snapshot) return;
  const sourceInfo = buildCodeIndexSourceInfo(
    input.rootDirectory,
    input.branch,
  );
  enrichingSet.add(key);
  void enrichCodeIndexSnapshotAsync(input.rootDirectory, snapshot, {
    summarizeWithAi: input.summarizeWithAi,
    embedChunks: input.embedChunks,
    sourceInfo,
    onProgress: async (progress) => {
      const persisted: CodeIndexProgress = {
        repositoryId: input.repositoryId,
        branch: input.branch,
        ...progress,
      };
      updateProgress(input.repositoryId, input.branch, persisted);
      await saveCodeIndexSnapshotMeta({
        repositoryId: input.repositoryId,
        branch: input.branch,
        rootDirectory: input.rootDirectory,
        sourceKind: sourceInfo.sourceKind,
        sourceBranch: sourceInfo.sourceBranch,
        sourceHeadSha: sourceInfo.sourceHeadSha,
        manifestHash: snapshot.meta.manifestHash,
        progress,
        userId: input.userId,
      });
    },
    onSnapshot: async (nextSnapshot) => {
      updateProgress(input.repositoryId, input.branch, {
        repositoryId: input.repositoryId,
        branch: input.branch,
        ...nextSnapshot.meta.progress,
      });
      await saveCodeIndexSnapshot(nextSnapshot, input.userId);
    },
  })
    .catch(async (err) => {
      const message =
        err instanceof Error
          ? err.message
          : t('errors.auto_b94ec4', {}, undefined);
      await saveCodeIndexSnapshotMeta({
        repositoryId: input.repositoryId,
        branch: input.branch,
        rootDirectory: input.rootDirectory,
        sourceKind: sourceInfo.sourceKind,
        sourceBranch: sourceInfo.sourceBranch,
        sourceHeadSha: sourceInfo.sourceHeadSha,
        manifestHash: snapshot.meta.manifestHash,
        progress: {
          status: 'error',
          stage: 'idle',
          processedFiles: snapshot.meta.stats.fileCount,
          totalFiles: snapshot.meta.stats.fileCount,
          message: t('errors.auto_b94ec4', {}, undefined),
          error: message,
          startedAt: snapshot.meta.progress.startedAt,
          updatedAt: new Date().toISOString(),
        },
        userId: input.userId,
      });
      updateProgress(input.repositoryId, input.branch, {
        repositoryId: input.repositoryId,
        branch: input.branch,
        status: 'error',
        stage: 'idle',
        processedFiles: snapshot.meta.stats.fileCount,
        totalFiles: snapshot.meta.stats.fileCount,
        message: t('errors.auto_b94ec4', {}, undefined),
        error: message,
        startedAt: snapshot.meta.progress.startedAt,
        updatedAt: new Date().toISOString(),
      });
    })
    .finally(() => {
      enrichingSet.delete(key);
    });
}

async function recoverPendingCodeIndexEnrichments(): Promise<void> {
  const metas = await listCodeIndexSnapshotMetasByStatus({
    status: 'building',
    stages: ['summaries', 'embeddings'],
  });
  for (const meta of metas) {
    const repository = await getReviewRepositoryById(meta.repositoryId);
    if (!repository) continue;
    const rootDirectory =
      (await resolveCodeRootDirectory(repository, meta.branch)) ||
      meta.rootDirectory;
    if (!rootDirectory || !isExistingDirectory(rootDirectory)) continue;
    await startCodeIndexEnrichment({
      repositoryId: meta.repositoryId,
      branch: meta.branch,
      rootDirectory,
      userId: '__system__',
      summarizeWithAi:
        meta.stage === 'summaries' || meta.stage === 'embeddings',
      embedChunks: meta.stage === 'embeddings',
    });
  }
}

function ensureCodeIndexRecoveryLoop(): void {
  if (codeIndexRecoveryStarted) return;
  codeIndexRecoveryStarted = true;
  void recoverPendingCodeIndexEnrichments().catch(() => {});
  setInterval(() => {
    void recoverPendingCodeIndexEnrichments().catch(() => {});
  }, 60_000);
}

export function registerCodeIndexRoutes(
  app: Express,
  opts: CodeIndexRouteOptions,
): void {
  ensureCodeIndexRecoveryLoop();
  const guard = opts.requirePermission('project.view', 'codemap.view');
  const manageGuard = opts.requirePermission(
    'project.manage',
    'codemap.manage',
  );

  async function requireRepositoryAccess(
    req: Request,
    res: import('express').Response,
    repositoryId: string,
    requiredLevel = 'viewer',
  ): Promise<ReviewRepositoryRecord | null> {
    const repo = await getReviewRepositoryById(repositoryId);
    if (!repo) {
      res.status(404).json({ error: t('repo.notFound', {}, req.locale) });
      return null;
    }
    if (
      !(await canAccessRepositoryResource(
        getTenantUserId(req),
        repositoryId,
        requiredLevel,
      ))
    ) {
      res.status(403).json({ error: t('repo.noPermission', {}, req.locale) });
      return null;
    }
    return repo;
  }

  app.get('/api/code-index/:repositoryId/status', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;

      const branch =
        String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const meta = enrichCodeIndexMeta(
        repositoryId,
        branch,
        await getCodeIndexSnapshotMeta(repositoryId, branch),
      );
      res.json({
        meta,
        progress: resolveVisibleProgress(repositoryId, branch, meta),
      });
    } catch (err) {
      res.status(500).json({ error: t('errors.auto_d25f65', {}, req.locale) });
    }
  });

  app.get('/api/code-index/:repositoryId/progress', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;
      const branch =
        String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
      const meta = enrichCodeIndexMeta(
        repositoryId,
        branch,
        await getCodeIndexSnapshotMeta(repositoryId, branch),
      );
      res.json(resolveVisibleProgress(repositoryId, branch, meta));
    } catch (err) {
      res.status(500).json({ error: t('errors.auto_ebc870', {}, req.locale) });
    }
  });

  app.post(
    '/api/code-index/:repositoryId/rebuild',
    manageGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'code-index.rebuild', 'normal');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        const repo = await requireRepositoryAccess(
          req,
          res,
          repositoryId,
          'manager',
        );
        if (!repo) return;

        const branch =
          String(req.query.branch || req.body?.branch || '').trim() ||
          resolveDefaultBranch(repo);
        const key = progressKey(repositoryId, branch);
        if (hasActiveCodeIndexWorker(key)) {
          res.status(202).json({
            status: 'already_building',
            progress: currentProgress(repositoryId, branch),
          });
          return;
        }

        const rootDirectory = await resolveCodeRootDirectory(repo, branch);
        if (!rootDirectory) {
          res.status(400).json({
            error: t(
              'errors.codeIndexWorkdirUnavailable',
              { branch },
              req.locale,
            ),
          });
          return;
        }

        const force = req.query.force === '1' || req.body?.force === true;
        if (!force) {
          const existingMeta = await getCodeIndexSnapshotMeta(
            repositoryId,
            branch,
          );
          if (existingMeta) {
            const currentManifestHash =
              await resolveCurrentManifestHash(rootDirectory);
            if (currentManifestHash === existingMeta.manifestHash) {
              res.json({
                status: 'unchanged',
                meta: enrichCodeIndexMeta(repositoryId, branch, existingMeta),
              });
              return;
            }
          }
        }

        const summarizeWithAi =
          req.query.enableAiSummaries === '1' ||
          req.body?.enableAiSummaries === true;
        const embedChunks =
          req.query.enableEmbeddings === '1' ||
          req.body?.enableEmbeddings === true;

        await startCodeIndexRebuild(
          repositoryId,
          branch,
          rootDirectory,
          getTenantUserId(req),
          {
            summarizeWithAi,
            embedChunks,
          },
        );
        res.status(202).json({
          status: 'started',
          progress: currentProgress(repositoryId, branch),
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c6f86c', {}, undefined) });
      }
    },
  );

  app.post('/api/code-index/:repositoryId/search', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;
      const branch =
        String(req.query.branch || req.body?.branch || '').trim() ||
        resolveDefaultBranch(repo);
      const query = String(req.body?.query || '').trim();
      const limit = Math.min(Math.max(Number(req.body?.limit) || 8, 1), 30);
      if (!query) {
        res
          .status(400)
          .json({ error: t('errors.auto_913994', {}, req.locale) });
        return;
      }
      const snapshot = await loadCodeIndexSearchData(repositoryId, branch);
      if (!snapshot) {
        res
          .status(404)
          .json({ error: t('errors.auto_ec3333', {}, req.locale) });
        return;
      }

      let vectorScores = new Map<string, number>();
      if (snapshot.meta.capabilities.embeddings) {
        const provider = await resolveEmbeddingProvider();
        if (provider) {
          const queryVec = await cachedEmbedQuery(provider, query);
          const raw = await searchByVector(
            queryVec,
            'code_chunk',
            limit * 4,
            0.18,
          );
          const allowed = new Set(snapshot.chunks.map((chunk) => chunk.id));
          vectorScores = new Map(
            raw
              .filter((entry) => allowed.has(entry.ownerId))
              .map((entry) => [entry.ownerId, entry.score]),
          );
        }
      }

      const results = normalizeSearchResults(
        snapshot,
        vectorScores,
        query,
        limit,
      );
      res.json({ results, meta: snapshot.meta });
    } catch (err) {
      res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
    }
  });

  app.get(
    '/api/code-index/:repositoryId/files/:filePath',
    guard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        const filePath = decodeURIComponent(String(req.params.filePath || ''));
        const repo = await requireRepositoryAccess(req, res, repositoryId);
        if (!repo) return;
        const branch =
          String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
        const detail = await loadCodeIndexFileData(
          repositoryId,
          branch,
          filePath,
        );
        if (!detail) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }
        if (!detail.file) {
          res
            .status(404)
            .json({ error: t('errors.auto_7a226e', {}, req.locale) });
          return;
        }
        res.json({ file: detail.file, chunks: detail.chunks });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_cd6c24', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/functions',
    guard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        const repo = await requireRepositoryAccess(req, res, repositoryId);
        if (!repo) return;
        const branch =
          String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
        const filePath = String(req.query.filePath || '').trim();
        const query = String(req.query.query || '')
          .trim()
          .toLowerCase();
        const line = Number(req.query.line);
        const snapshot = await loadCodeIndexFunctionsData(repositoryId, branch);
        if (!snapshot) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }

        let functions = snapshot.functions;
        if (filePath)
          functions = functions.filter((fn) => fn.filePath === filePath);
        if (query) {
          functions = functions.filter(
            (fn) =>
              fn.name.toLowerCase().includes(query) ||
              fn.signature.toLowerCase().includes(query),
          );
        }
        if (Number.isFinite(line) && line > 0) {
          functions = functions.filter(
            (fn) =>
              fn.line === line || (fn.startLine <= line && fn.endLine >= line),
          );
        }
        res.json({ functions });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_4a5bee', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/functions/:functionId/deps',
    guard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        const functionId = decodeURIComponent(
          String(req.params.functionId || ''),
        );
        const repo = await requireRepositoryAccess(req, res, repositoryId);
        if (!repo) return;
        const branch =
          String(req.query.branch || '').trim() || resolveDefaultBranch(repo);
        const depth = Math.min(Math.max(Number(req.query.depth) || 1, 1), 3);
        const snapshot = await loadCodeIndexFunctionGraphData(
          repositoryId,
          branch,
        );
        if (!snapshot) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }

        const focus =
          snapshot.functions.find((fn) => fn.id === functionId) || null;
        if (!focus) {
          res
            .status(404)
            .json({ error: t('errors.auto_0d936a', {}, req.locale) });
          return;
        }
        const upstream = collectFunctionDeps(
          snapshot,
          functionId,
          'upstream',
          depth,
        );
        const downstream = collectFunctionDeps(
          snapshot,
          functionId,
          'downstream',
          depth,
        );
        res.json({ focus, upstream, downstream });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_355e30', {}, undefined) });
      }
    },
  );
}
