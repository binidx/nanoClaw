import { describe, expect, it } from 'vitest';

import {
  buildRepoReviewCodeIndexContextBlock,
  stripRepoReviewExecutionContext,
} from './repo-review-run-executor.js';

describe('repo review rerun context', () => {
  it('drops inherited execution progress while preserving rerun metadata', () => {
    const result = stripRepoReviewExecutionContext({
      manualReview: {
        baselineMode: 'last_reviewed',
      },
      commitSummaryLines: ['old summary'],
      commitDetails: [{ commit: 'abc123', title: 'old' }],
      reviewTurns: [{ id: 'turn-1' }],
      reviewProgress: { turnCount: 1 },
      scopeLimitations: ['old limit'],
      fileReviews: [{ file: 'src/a.ts' }],
      commitReviews: [{ commit: 'abc123' }],
      executionStats: { workerCount: 9 },
    });

    expect(result).toEqual({
      manualReview: {
        baselineMode: 'last_reviewed',
      },
    });
  });
});

describe('repo review Code Index context', () => {
  const baseSnapshot = {
    meta: {
      repositoryId: 'repo-1',
      branch: 'main',
      rootDirectory: '/repo',
      sourceKind: 'workspace' as const,
      sourceBranch: 'main',
      sourceHeadSha: 'head123',
      manifestHash: 'hash',
      status: 'ready' as const,
      stage: 'complete' as const,
      generatedAt: '2026-04-23T00:00:00.000Z',
      stats: {
        fileCount: 1,
        chunkCount: 1,
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
        status: 'ready' as const,
        stage: 'complete' as const,
        processedFiles: 1,
        totalFiles: 1,
        message: '',
        error: null,
        startedAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      },
    },
    files: [
      {
        relativePath: 'src/a.ts',
        language: 'ts',
        byteSize: 1200,
        lineCount: 80,
        fileHash: 'filehash',
        rank: 10,
        importCount: 2,
        exportCount: 1,
        summary: 'Handles repository review execution.',
        summarySource: 'fallback' as const,
      },
    ],
    chunks: [],
    functions: [
      {
        id: 'fn-a',
        filePath: 'src/a.ts',
        name: 'runReview',
        kind: 'function',
        signature: 'function runReview()',
        startLine: 10,
        endLine: 30,
        line: 10,
        column: 1,
        parentFunctionId: null,
      },
      {
        id: 'fn-b',
        filePath: 'src/b.ts',
        name: 'helper',
        kind: 'function',
        signature: 'function helper()',
        startLine: 5,
        endLine: 8,
        line: 5,
        column: 1,
        parentFunctionId: null,
      },
    ],
    functionEdges: [
      {
        id: 'edge-1',
        fromFunctionId: 'fn-b',
        toFunctionId: 'fn-a',
        edgeType: 'call' as const,
        symbol: 'runReview',
        line: 7,
      },
    ],
  };

  it('builds a ready Code Index context for changed files', () => {
    const block = buildRepoReviewCodeIndexContextBlock({
      snapshot: baseSnapshot,
      repositoryId: 'repo-1',
      branch: 'main',
      headSha: 'head123',
      changedFiles: ['src/a.ts'],
    });

    expect(block).toContain('status: ready');
    expect(block).toContain('freshness: current_or_unknown');
    expect(block).toContain('src/a.ts');
    expect(block).toContain('incoming_calls=1');
    expect(block).toContain('function runReview@10');
  });

  it('marks stale Code Index context as low-weight evidence', () => {
    const block = buildRepoReviewCodeIndexContextBlock({
      snapshot: baseSnapshot,
      repositoryId: 'repo-1',
      branch: 'main',
      headSha: 'new-head',
      changedFiles: ['src/a.ts'],
    });

    expect(block).toContain('freshness: stale');
    expect(block).toContain('低权重导航线索');
  });

  it('returns usable context when the Code Index snapshot is missing', () => {
    const block = buildRepoReviewCodeIndexContextBlock({
      snapshot: null,
      repositoryId: 'repo-1',
      branch: 'main',
      changedFiles: ['src/a.ts'],
    });

    expect(block).toContain('Code Index 上下文：unavailable');
    expect(block).toContain('reason: missing_snapshot');
  });
});
