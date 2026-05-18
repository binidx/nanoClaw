import { describe, expect, it } from 'vitest';

import {
  buildProjectGraphQueryOptions,
  filterPreparedProjectGraphContextForFiles,
} from './project-graph-context.js';

describe('project graph prepared context', () => {
  it('builds scoped query options for retrieval profiles', () => {
    expect(
      buildProjectGraphQueryOptions({
        intent: 'workflow',
        profile: 'tests',
      }),
    ).toMatchObject({
      depth: 2,
      maxNodes: 24,
      tokenBudget: 1400,
      relationFilter: ['contains', 'imports', 'references'],
    });
  });

  it('preserves readable community labels after file filtering', () => {
    const context = {
      status: 'ready' as const,
      repositoryId: 'repo-1',
      branch: 'main',
      intent: 'repo_review' as const,
      question: 'where is auth implemented',
      focusPaths: ['src/features/auth/login.ts', 'src/other.ts'],
      relationFilter: ['calls'],
      communities: ['src/features/auth', 'src/other'],
      nodeCount: 2,
      edgeCount: 1,
      tokenBudget: 1200,
      startNodes: [
        {
          id: 'file:src/features/auth/login.ts',
          type: 'file' as const,
          label: 'src/features/auth/login.ts',
          filePath: 'src/features/auth/login.ts',
          score: 12,
          reasons: ['term:file:auth'],
          community: 'community:001',
          communityLabel: 'src/features/auth',
        },
      ],
      topFiles: [
        {
          id: 'file:src/other.ts',
          type: 'file' as const,
          label: 'src/other.ts',
          filePath: 'src/other.ts',
          score: 6,
          reasons: ['term:file:other'],
          community: 'community:002',
          communityLabel: 'src/other',
        },
      ],
      topFunctions: [],
      topChunks: [],
      edges: [
        {
          fromId: 'file:src/features/auth/login.ts',
          fromType: 'file' as const,
          fromLabel: 'src/features/auth/login.ts',
          toId: 'file:src/other.ts',
          toType: 'file' as const,
          toLabel: 'src/other.ts',
          relation: 'calls' as const,
          confidence: 'EXTRACTED' as const,
        },
      ],
      planner: {
        strategy: 'mixed',
        forcedSeedCount: 1,
        communityHintCount: 1,
      },
      confidence: {
        seedScore: 0.8,
        graphScore: 0.7,
        contextScore: 0.75,
        overall: 0.76,
      },
      contextFilterStats: {
        candidateNodeCount: 2,
        selectedNodeCount: 2,
        droppedNodeCount: 0,
        selectedEdgeCount: 1,
        estimatedTokens: 150,
      },
      contextText: '',
    };

    const filtered = filterPreparedProjectGraphContextForFiles({
      context,
      files: ['src/features/auth/login.ts'],
    });

    expect(filtered.communities).toEqual(['src/features/auth']);
    expect(filtered.contextText).toContain('community=src/features/auth');
  });
});
