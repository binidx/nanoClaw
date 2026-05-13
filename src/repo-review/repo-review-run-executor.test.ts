import { describe, expect, it } from 'vitest';

import {
  buildRepoReviewCodeIndexContextBlock,
  buildRepoReviewCodeMapContextBlock,
  buildRepoReviewDiffAwareEvidenceBundle,
  buildRepoReviewEvidenceBundleBlock,
  resolveRepoReviewAgenticSubagentPrompt,
  splitDiffByFile,
  stripRepoReviewExecutionContext,
} from './repo-review-run-executor.js';
import { buildRepoReviewDiffIndex } from './repo-review-diff-index.js';

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

describe('repo review evidence bundle context', () => {
  const codeMapSnapshot = {
    repositoryId: 'repo-1',
    branch: 'main',
    rootDirectory: '/repo',
    generatedAt: '2026-04-23T00:00:00.000Z',
    manifestHash: 'map-hash',
    files: [
      {
        relativePath: 'src/a.ts',
        language: 'ts',
        lineCount: 80,
        byteSize: 1200,
        symbols: [
          {
            name: 'runReview',
            kind: 'function' as const,
            line: 10,
            column: 1,
            signature: 'export function runReview()',
            rank: 0.8,
          },
        ],
        importCount: 2,
        exportCount: 1,
        rank: 0.42,
      },
      {
        relativePath: 'src/helper.ts',
        language: 'ts',
        lineCount: 30,
        byteSize: 600,
        symbols: [],
        importCount: 0,
        exportCount: 1,
        rank: 0.16,
      },
    ],
    edges: [
      {
        fromFile: 'src/helper.ts',
        toFile: 'src/a.ts',
        symbols: ['runReview'],
      },
    ],
    stats: {
      fileCount: 2,
      symbolCount: 1,
      edgeCount: 1,
      totalLines: 110,
    },
  };

  it('builds a CodeMap impact context for changed files and neighbors', () => {
    const block = buildRepoReviewCodeMapContextBlock({
      snapshot: codeMapSnapshot,
      repositoryId: 'repo-1',
      branch: 'main',
      changedFiles: ['src/a.ts'],
    });

    expect(block).toContain('CodeMap 影响图：');
    expect(block).toContain('changed_files_with_map: 1/1');
    expect(block).toContain('src/a.ts');
    expect(block).toContain('dependents=1');
    expect(block).toContain('function runReview@10');
    expect(block).toContain('相关未变更邻居文件');
    expect(block).toContain('src/helper.ts');
  });

  it('maps changed diff hunks to Code Index functions and one-hop callers', () => {
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,5 +10,6 @@ export function runReview() {',
      ' const existing = true;',
      '+const changed = true;',
      ' helper();',
      ' return existing;',
      '}',
    ].join('\n');
    const codeIndexSnapshot = {
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
          fileCount: 2,
          chunkCount: 0,
          functionCount: 2,
          functionEdgeCount: 1,
          totalLines: 120,
          embeddedChunkCount: 0,
        },
        capabilities: {
          chunkSearch: false,
          fileSummaries: false,
          functionGraph: true,
          embeddings: false,
        },
        progress: {
          status: 'ready' as const,
          stage: 'complete' as const,
          processedFiles: 2,
          totalFiles: 2,
          message: '',
          error: null,
          startedAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
      files: [],
      functions: [
        {
          id: 'fn-a',
          filePath: 'src/a.ts',
          name: 'runReview',
          kind: 'function',
          signature: 'export function runReview()',
          startLine: 10,
          endLine: 20,
          line: 10,
          column: 1,
          parentFunctionId: null,
        },
        {
          id: 'fn-b',
          filePath: 'src/helper.ts',
          name: 'callReview',
          kind: 'function',
          signature: 'export function callReview()',
          startLine: 1,
          endLine: 5,
          line: 1,
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
          line: 3,
        },
      ],
    };

    const bundle = buildRepoReviewDiffAwareEvidenceBundle({
      prepared: {
        diffText,
        changedFiles: ['src/a.ts'],
        baseSha: 'base123',
        headSha: 'head123',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
        commitSummaryLines: [],
        commitDetails: [],
        projectContextBlocks: [],
      },
      codeMapSnapshot,
      codeIndexSnapshot,
      branch: 'main',
    });

    expect(bundle.changedHunks).toHaveLength(1);
    expect(bundle.changedFunctions).toHaveLength(1);
    expect(bundle.changedFunctions[0]).toMatchObject({
      id: 'fn-a',
      filePath: 'src/a.ts',
      name: 'runReview',
      changedHunkCount: 1,
      changedLineNumbers: [11],
    });
    expect(bundle.impactGraph.edges).toEqual([
      expect.objectContaining({
        direction: 'upstream',
        fromFunctionId: 'fn-b',
        toFunctionId: 'fn-a',
      }),
    ]);
    expect(bundle.codeIndexStatus.status).toBe('ready');
  });

  it('combines diff, CodeMap, and Code Index into one evidence bundle', () => {
    const block = buildRepoReviewEvidenceBundleBlock({
      diffSummaryBlock: '- src/a.ts | +3 / -1 | hunks 1 | 120 bytes',
      codeMapContextBlock: 'CodeMap 影响图：\nstatus: ready',
      codeIndexContextBlock: 'Code Index 上下文：\nstatus: ready',
    });

    expect(block).toContain('Review Evidence Bundle');
    expect(block).toContain('Diff 文件摘要');
    expect(block).toContain('CodeMap 影响图');
    expect(block).toContain('Code Index 上下文');
  });

  it('filters subagent evidence bundle to task files only', async () => {
    const diffText = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-export const a = false;',
      '+export const a = true;',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-export const b = false;',
      '+export const b = true;',
    ].join('\n');
    const resolved = await resolveRepoReviewAgenticSubagentPrompt({
      repository: {
        name: 'demo-repo',
        language: 'TypeScript',
      } as any,
      profile: {
        promptTemplate: '',
        includeFullFileContext: false,
      } as any,
      event: {
        stage: 'push',
        source: 'local-hook',
      } as any,
      budget: {
        maxSubagents: 2,
        delegationFileThreshold: 1,
        fullFileReviewEnabled: false,
        maxFullFileBytesPerFile: 0,
        maxTotalReadBytes: 0,
        maxReviewRounds: 1,
        extractorEnabled: true,
      } as any,
      task: {
        id: 'task-a',
        title: 'A only',
        objective: 'Review A',
        files: ['src/a.ts'],
        focus: 'A',
        fullFileFiles: [],
      },
      prepared: {
        diffText,
        diffIndex: buildRepoReviewDiffIndex(diffText),
        changedFiles: ['src/a.ts', 'src/b.ts'],
        baseSha: 'base',
        headSha: 'head',
        branch: 'main',
        ref: 'refs/heads/main',
        actor: 'alice',
        commitSummaryLines: [],
        commitDetails: [],
        projectContextBlocks: [],
        evidenceBundle: {
          diffSummary: {
            fileCount: 2,
            hunkCount: 2,
            addedLines: 2,
            removedLines: 2,
            diffBytes: Buffer.byteLength(diffText, 'utf8'),
            files: [
              {
                filePath: 'src/a.ts',
                addedLines: 1,
                removedLines: 1,
                hunkCount: 1,
                estimatedBytes: 80,
              },
              {
                filePath: 'src/b.ts',
                addedLines: 1,
                removedLines: 1,
                hunkCount: 1,
                estimatedBytes: 80,
              },
            ],
          },
          changedFiles: ['src/a.ts', 'src/b.ts'],
          changedHunks: [
            {
              filePath: 'src/a.ts',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLineCount: 1,
              oldEnd: 1,
              newStart: 1,
              newLineCount: 1,
              newEnd: 1,
              addedLineNumbers: [1],
              removedLineNumbers: [1],
            },
            {
              filePath: 'src/b.ts',
              header: '@@ -1 +1 @@',
              oldStart: 1,
              oldLineCount: 1,
              oldEnd: 1,
              newStart: 1,
              newLineCount: 1,
              newEnd: 1,
              addedLineNumbers: [1],
              removedLineNumbers: [1],
            },
          ],
          changedFunctions: [
            {
              id: 'fn-a',
              filePath: 'src/a.ts',
              name: 'a',
              kind: 'function',
              signature: 'function a()',
              startLine: 1,
              endLine: 1,
              line: 1,
              parentFunctionId: null,
              changedHunkCount: 1,
              changedLineNumbers: [1],
            },
            {
              id: 'fn-b',
              filePath: 'src/b.ts',
              name: 'b',
              kind: 'function',
              signature: 'function b()',
              startLine: 1,
              endLine: 1,
              line: 1,
              parentFunctionId: null,
              changedHunkCount: 1,
              changedLineNumbers: [1],
            },
          ],
          impactGraph: {
            functions: [],
            edges: [],
          },
          codeMapStatus: { status: 'ready' },
          codeIndexStatus: { status: 'ready' },
          missingContext: [],
        },
      },
    });

    expect(resolved.text).toContain('src/a.ts');
    expect(resolved.text).not.toContain('src/b.ts');
  });

  it('keeps quoted diff paths in fallback file splitting', () => {
    const diffText = [
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
      'index 1234567..89abcde 100644',
      '--- "a/src/foo bar.ts"',
      '+++ "b/src/foo bar.ts"',
      '@@ -1 +1 @@',
      '-export const mode = "before";',
      '+export const mode = "after";',
    ].join('\n');

    const parts = splitDiffByFile(diffText);

    expect(parts.get('src/foo bar.ts')).toContain(
      'diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"',
    );
  });
});
