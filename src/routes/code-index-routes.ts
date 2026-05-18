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
  saveCodeIndexStateDelta,
  saveCodeIndexSnapshot,
  saveCodeIndexSnapshotMeta,
  saveCodeIndexSummaryDelta,
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
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import { computeCodeMapManifestHash } from '../code-intelligence/code-map-builder.js';
import {
  buildProjectGraphFallbackAnswer,
  explainProjectGraphNode,
  loadProjectGraph,
  queryProjectGraph,
  shortestProjectGraphPath,
} from '../code-intelligence/project-graph.js';
import {
  buildProjectGraphQueryOptions,
  type ProjectGraphRetrievalProfile,
} from '../code-intelligence/project-graph-context.js';
import {
  listProjectGraphQueryArtifacts,
  loadProjectGraphQueryArtifact,
  saveProjectGraphQueryArtifact,
} from '../code-intelligence/project-graph-query-store.js';
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
import { resolvePromptText } from '../prompt/prompt-service.js';
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

function buildProjectQaPrompt(input: {
  question: string;
  contextText: string;
  explorationText?: string;
}): string {
  return [
    'Answer the repository question using only the graph-grounded evidence below.',
    'Prefer concrete implementation locations over broad architecture prose.',
    'When you mention an implementation point, cite file path and line range when available.',
    'If evidence is partial, say "likely" instead of overstating certainty.',
    'Keep the answer concise and high-signal.',
    '',
    `Question: ${input.question}`,
    '',
    'Graph retrieval context:',
    input.contextText,
    '',
    'Focused exploration evidence:',
    input.explorationText || 'No additional exploration evidence.',
    '',
    'Synthesize the answer from graph retrieval first, then use the focused exploration evidence to confirm or narrow the result.',
    'Output only the answer.',
  ].join('\n');
}

function inferProjectQaProfile(
  question: string,
): ProjectGraphRetrievalProfile {
  const normalized = question.toLowerCase();
  if (/(test|spec|coverage|verify|验证|测试)/.test(normalized)) {
    return 'tests';
  }
  if (/(config|env|setting|flag|配置)/.test(normalized)) {
    return 'config';
  }
  if (/(impact|dependency|blast radius|影响|依赖|谁调用|谁引用)/.test(normalized)) {
    return 'impact';
  }
  if (/(workflow|pipeline|orchestrator|agent|工作流|编排)/.test(normalized)) {
    return 'workflow';
  }
  if (/(where|implement|location|入口|实现|在哪|功能)/.test(normalized)) {
    return 'implementation';
  }
  return 'default';
}

function normalizeProjectQaFocusPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function buildProjectQaExploration(input: {
  question: string;
  snapshot: CodeIndexSnapshot | null;
  queryResult: ReturnType<typeof queryProjectGraph>;
  focusPaths: string[];
  maxFiles?: number;
  maxFunctionsPerFile?: number;
  maxChunksPerFile?: number;
}): {
  selectedFiles: string[];
  matchedFunctionCount: number;
  matchedChunkCount: number;
  contextText: string;
} {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return {
      selectedFiles: [],
      matchedFunctionCount: 0,
      matchedChunkCount: 0,
      contextText: 'Project QA exploration:\nstatus: missing_snapshot',
    };
  }
  const maxFiles = Math.max(1, input.maxFiles || 4);
  const maxFunctionsPerFile = Math.max(1, input.maxFunctionsPerFile || 3);
  const maxChunksPerFile = Math.max(1, input.maxChunksPerFile || 2);
  const selectedFileSet = new Set<string>(input.focusPaths);
  const addFile = (filePath?: string) => {
    if (!filePath || selectedFileSet.size >= maxFiles) return;
    selectedFileSet.add(filePath);
  };
  for (const node of input.queryResult.startNodes) addFile(node.filePath);
  for (const node of input.queryResult.matches.files) addFile(node.filePath);
  for (const node of input.queryResult.matches.functions) addFile(node.filePath);
  for (const node of input.queryResult.matches.chunks) addFile(node.filePath);
  const selectedFiles = Array.from(selectedFileSet).slice(0, maxFiles);
  const filesByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file] as const),
  );
  const matchedFunctionsByFile = new Map<string, typeof input.queryResult.matches.functions>();
  for (const fn of input.queryResult.matches.functions) {
    if (!fn.filePath || !selectedFileSet.has(fn.filePath)) continue;
    const bucket = matchedFunctionsByFile.get(fn.filePath) || [];
    bucket.push(fn);
    matchedFunctionsByFile.set(fn.filePath, bucket);
  }
  const matchedChunksByFile = new Map<string, typeof input.queryResult.matches.chunks>();
  for (const chunk of input.queryResult.matches.chunks) {
    if (!chunk.filePath || !selectedFileSet.has(chunk.filePath)) continue;
    const bucket = matchedChunksByFile.get(chunk.filePath) || [];
    bucket.push(chunk);
    matchedChunksByFile.set(chunk.filePath, bucket);
  }
  const resultEdgeNodeIds = new Set(input.queryResult.nodes.map((node) => node.id));
  const relevantEdges = input.queryResult.edges.filter(
    (edge) => resultEdgeNodeIds.has(edge.fromId) && resultEdgeNodeIds.has(edge.toId),
  );
  let matchedFunctionCount = 0;
  let matchedChunkCount = 0;
  const lines = [
    'Project QA exploration:',
    `question: ${input.question}`,
    `selected_files: ${selectedFiles.length}`,
  ];
  for (const filePath of selectedFiles) {
    const file = filesByPath.get(filePath);
    const functions = (matchedFunctionsByFile.get(filePath) || []).slice(
      0,
      maxFunctionsPerFile,
    );
    const chunks = (matchedChunksByFile.get(filePath) || []).slice(
      0,
      maxChunksPerFile,
    );
    matchedFunctionCount += functions.length;
    matchedChunkCount += chunks.length;
    lines.push(
      '',
      `file: ${filePath}`,
      `summary: ${file?.summary || '(no file summary)'}`,
    );
    if (functions.length > 0) {
      lines.push('matched_functions:');
      for (const fn of functions) {
        lines.push(
          `- ${fn.label} [${fn.startLine || '?'}-${fn.endLine || '?'}] | score=${fn.score.toFixed(2)} | reasons=${fn.reasons.join(', ') || '-'}`,
        );
      }
    }
    if (chunks.length > 0) {
      lines.push('matched_chunks:');
      for (const chunk of chunks) {
        const preview = String(chunk.snippet || '')
          .replace(/\s+/g, ' ')
          .slice(0, 220);
        lines.push(
          `- L${chunk.startLine || '?'}-${chunk.endLine || '?'} | score=${chunk.score.toFixed(2)} | ${preview || '(no snippet)'}`,
        );
      }
    }
    const fileEdges = relevantEdges
      .filter((edge) => {
        const fromNode = input.queryResult.nodes.find((node) => node.id === edge.fromId);
        const toNode = input.queryResult.nodes.find((node) => node.id === edge.toId);
        return fromNode?.filePath === filePath || toNode?.filePath === filePath;
      })
      .slice(0, 4);
    if (fileEdges.length > 0) {
      lines.push('relevant_edges:');
      for (const edge of fileEdges) {
        lines.push(
          `- ${edge.relation} | ${edge.fromId} -> ${edge.toId}${edge.symbol ? ` | ${edge.symbol}` : ''}`,
        );
      }
    }
  }
  if (selectedFiles.length === 0) {
    lines.push('status: no_selected_files');
  }
  return {
    selectedFiles,
    matchedFunctionCount,
    matchedChunkCount,
    contextText: lines.join('\n'),
  };
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
  let summaryPersisted = false;
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
      if (input.summarizeWithAi && !summaryPersisted) {
        summaryPersisted = true;
        await saveCodeIndexSummaryDelta(nextSnapshot, input.userId);
        return;
      }
      if (input.embedChunks) {
        await saveCodeIndexStateDelta(nextSnapshot, input.userId);
        return;
      }
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
          const allowedContentHashes = new Set(
            snapshot.chunks.map((chunk) => chunk.contentHash),
          );
          const vectorScoresByContentHash = new Map(
            raw
              .filter((entry) => allowedContentHashes.has(entry.ownerId))
              .map((entry) => [entry.ownerId, entry.score]),
          );
          vectorScores = new Map(
            snapshot.chunks.map((chunk) => [
              chunk.id,
              vectorScoresByContentHash.get(chunk.contentHash) || 0,
            ]),
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

  app.get(
    '/api/code-index/:repositoryId/graph/stats',
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
        const graph = await loadProjectGraph(repositoryId, branch);
        if (!graph) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }
        res.json({
          repositoryId,
          branch,
          manifestHash: graph.manifestHash,
          generatedAt: graph.generatedAt,
          stats: graph.stats,
          communities: graph.communities.slice(0, 16),
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.post(
    '/api/code-index/:repositoryId/graph/query',
    guard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        const repo = await requireRepositoryAccess(req, res, repositoryId);
        if (!repo) return;
        const branch =
          String(req.query.branch || req.body?.branch || '').trim() ||
          resolveDefaultBranch(repo);
        const question = String(req.body?.question || req.body?.query || '').trim();
        if (!question) {
          res
            .status(400)
            .json({ error: t('errors.auto_913994', {}, req.locale) });
          return;
        }
        const graph = await loadProjectGraph(repositoryId, branch);
        if (!graph) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }
        const result = queryProjectGraph(graph, question, {
          mode: req.body?.mode === 'dfs' ? 'dfs' : 'bfs',
          depth: Number(req.body?.depth) || 2,
          tokenBudget: Number(req.body?.tokenBudget) || 2200,
          maxSeeds: Number(req.body?.maxSeeds) || 5,
          maxNodes: Number(req.body?.maxNodes) || 36,
          relationFilter: Array.isArray(req.body?.relationFilter)
            ? req.body.relationFilter
            : undefined,
          seedNodeIds: Array.isArray(req.body?.seedNodeIds)
            ? req.body.seedNodeIds
            : undefined,
        });
        const artifact = saveProjectGraphQueryArtifact({
          repositoryId,
          branch,
          manifestHash: graph.manifestHash,
          source: 'code-index.graph.query',
          kind: 'query',
          status: 'ready',
          question,
          focusPaths: Array.isArray(req.body?.focusPaths)
            ? req.body.focusPaths
            : [],
          metadata: {
            planner: result.planner,
            confidence: result.confidence,
            contextFilterStats: result.contextFilterStats,
          },
          payload: {
            question,
            options: {
              mode: req.body?.mode === 'dfs' ? 'dfs' : 'bfs',
              depth: Number(req.body?.depth) || 2,
              tokenBudget: Number(req.body?.tokenBudget) || 2200,
              maxSeeds: Number(req.body?.maxSeeds) || 5,
              maxNodes: Number(req.body?.maxNodes) || 36,
              relationFilter: Array.isArray(req.body?.relationFilter)
                ? req.body.relationFilter
                : undefined,
              seedNodeIds: Array.isArray(req.body?.seedNodeIds)
                ? req.body.seedNodeIds
                : undefined,
            },
            result,
          },
        });
        res.json({
          repositoryId,
          branch,
          manifestHash: graph.manifestHash,
          stats: graph.stats,
          artifact,
          result,
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/graph/queries',
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
        const artifacts = listProjectGraphQueryArtifacts({
          repositoryId,
          branch,
          limit: Number(req.query.limit) || 20,
        });
        res.json({
          repositoryId,
          branch,
          artifacts,
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/graph/queries/:queryId',
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
        const queryId = decodeURIComponent(String(req.params.queryId || ''));
        if (!queryId) {
          res
            .status(400)
            .json({ error: t('errors.auto_913994', {}, req.locale) });
          return;
        }
        const artifact = loadProjectGraphQueryArtifact({
          repositoryId,
          branch,
          id: queryId,
        });
        if (!artifact) {
          res.status(404).json({ error: 'query_artifact_not_found' });
          return;
        }
        res.json({
          repositoryId,
          branch,
          artifact,
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/graph/path',
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
        const source = String(req.query.source || '').trim();
        const target = String(req.query.target || '').trim();
        if (!source || !target) {
          res
            .status(400)
            .json({ error: t('errors.auto_913994', {}, req.locale) });
          return;
        }
        const graph = await loadProjectGraph(repositoryId, branch);
        if (!graph) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }
        const result = shortestProjectGraphPath(
          graph,
          source,
          target,
          Math.min(Math.max(Number(req.query.maxHops) || 8, 1), 12),
        );
        if (!result) {
          res.status(404).json({ error: 'path_not_found' });
          return;
        }
        res.json({
          repositoryId,
          branch,
          manifestHash: graph.manifestHash,
          result,
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.get(
    '/api/code-index/:repositoryId/graph/explain',
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
        const label = String(req.query.label || req.query.node || '').trim();
        if (!label) {
          res
            .status(400)
            .json({ error: t('errors.auto_913994', {}, req.locale) });
          return;
        }
        const graph = await loadProjectGraph(repositoryId, branch);
        if (!graph) {
          res
            .status(404)
            .json({ error: t('errors.auto_ec3333', {}, req.locale) });
          return;
        }
        const result = explainProjectGraphNode(graph, label);
        if (!result) {
          res.status(404).json({ error: 'node_not_found' });
          return;
        }
        res.json({
          repositoryId,
          branch,
          manifestHash: graph.manifestHash,
          result,
        });
      } catch (err) {
        res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
      }
    },
  );

  app.post('/api/code-index/:repositoryId/ask', guard, async (req, res) => {
    try {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const repo = await requireRepositoryAccess(req, res, repositoryId);
      if (!repo) return;
      const branch =
        String(req.query.branch || req.body?.branch || '').trim() ||
        resolveDefaultBranch(repo);
      const question = String(req.body?.question || '').trim();
      const focusPaths = normalizeProjectQaFocusPaths(req.body?.focusPaths);
      const retrievalProfile =
        String(req.body?.profile || '').trim() || inferProjectQaProfile(question);
      if (!question) {
        res
          .status(400)
          .json({ error: t('errors.auto_913994', {}, req.locale) });
        return;
      }
      const graph = await loadProjectGraph(repositoryId, branch);
      if (!graph) {
        res
          .status(404)
          .json({ error: t('errors.auto_ec3333', {}, req.locale) });
        return;
      }
      const snapshot = await loadCodeIndexSnapshot(repositoryId, branch);
      const focusSeedNodeIds = graph.nodes
        .filter(
          (node) =>
            node.type === 'file' &&
            node.filePath &&
            focusPaths.includes(node.filePath),
        )
        .map((node) => node.id);
      const queryOptions = {
        ...buildProjectGraphQueryOptions({
          intent: 'question_answering',
          profile: retrievalProfile as ProjectGraphRetrievalProfile,
          queryOptions: {
            mode: req.body?.mode === 'dfs' ? 'dfs' : 'bfs',
            depth: Number(req.body?.depth) || undefined,
            tokenBudget: Number(req.body?.tokenBudget) || undefined,
            maxSeeds: Number(req.body?.maxSeeds) || undefined,
            maxNodes: Number(req.body?.maxNodes) || undefined,
            relationFilter: Array.isArray(req.body?.relationFilter)
              ? req.body.relationFilter
              : undefined,
            seedNodeIds: Array.isArray(req.body?.seedNodeIds)
              ? req.body.seedNodeIds
              : focusSeedNodeIds.length > 0
                ? focusSeedNodeIds
                : undefined,
          },
        }),
      };
      const result = queryProjectGraph(graph, question, {
        ...queryOptions,
      });
      const exploration = buildProjectQaExploration({
        question,
        snapshot,
        queryResult: result,
        focusPaths,
        maxFiles: Number(req.body?.maxExplorationFiles) || undefined,
        maxFunctionsPerFile: Number(req.body?.maxFunctionsPerFile) || undefined,
        maxChunksPerFile: Number(req.body?.maxChunksPerFile) || undefined,
      });

      const fallbackAnswer = buildProjectGraphFallbackAnswer(question, result);
      let answer = fallbackAnswer;
      let noAi = false;
      try {
        const systemPrompt = await resolvePromptText({
          promptKey: 'code_index.project_qa_guard',
          fallbackText:
            'Answer only from the provided repository graph context. Cite file paths and line ranges when available. Do not invent files or functions.',
        });
        answer = await generateTextWithDefaultProvider(
          [
            systemPrompt.text,
            '',
            buildProjectQaPrompt({
              question,
              contextText: result.contextText,
              explorationText: exploration.contextText,
            }),
          ].join('\n'),
          {
            maxTokens: 700,
          },
        );
      } catch (err) {
        const isNoProvider =
          err instanceof Error && err.message.includes('No default AI provider');
        if (!isNoProvider) throw err;
        noAi = true;
      }

      const artifact = saveProjectGraphQueryArtifact({
        repositoryId,
        branch,
        manifestHash: graph.manifestHash,
        source: 'code-index.ask',
        kind: 'ask',
        status: noAi ? 'fallback' : 'ready',
        question,
        focusPaths: Array.isArray(req.body?.focusPaths)
          ? req.body.focusPaths
          : [],
        metadata: {
          noAi,
          retrievalProfile,
          exploration: {
            selectedFiles: exploration.selectedFiles,
            matchedFunctionCount: exploration.matchedFunctionCount,
            matchedChunkCount: exploration.matchedChunkCount,
          },
          planner: result.planner,
          confidence: result.confidence,
          contextFilterStats: result.contextFilterStats,
        },
        payload: {
          question,
          answer,
          fallbackAnswer,
          noAi,
          qa: {
            retrievalProfile,
            focusPaths,
            exploration,
          },
          result,
        },
      });

      res.json({
        repositoryId,
        branch,
        manifestHash: graph.manifestHash,
        stats: graph.stats,
        artifact,
        answer,
        fallbackAnswer,
        noAi,
        qa: {
          retrievalProfile,
          focusPaths,
          exploration,
        },
        result,
      });
    } catch (err) {
      res.status(500).json({ error: t('errors.auto_c989d4', {}, undefined) });
    }
  });
}
