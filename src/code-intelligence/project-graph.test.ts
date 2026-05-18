import { describe, expect, it } from 'vitest';

import {
  buildProjectGraph,
  buildProjectGraphFallbackAnswer,
  explainProjectGraphNode,
  queryProjectGraph,
  shortestProjectGraphPath,
} from './project-graph.js';

const codeIndexSnapshot = {
  meta: {
    repositoryId: 'repo-1',
    branch: 'main',
    rootDirectory: '/repo',
    sourceKind: 'workspace' as const,
    sourceBranch: 'main',
    sourceHeadSha: 'head123',
    manifestHash: 'manifest-1',
    status: 'ready' as const,
    stage: 'complete' as const,
    generatedAt: '2026-05-18T00:00:00.000Z',
    stats: {
      fileCount: 2,
      chunkCount: 3,
      functionCount: 3,
      functionEdgeCount: 2,
      totalLines: 120,
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
      relativePath: 'src/features/auth/login.ts',
      language: 'ts',
      byteSize: 1200,
      lineCount: 60,
      fileHash: 'a',
      rank: 12,
      importCount: 2,
      exportCount: 1,
      summary: 'Implements the login flow and session creation.',
      summarySource: 'fallback' as const,
    },
    {
      relativePath: 'src/features/auth/session.ts',
      language: 'ts',
      byteSize: 800,
      lineCount: 40,
      fileHash: 'b',
      rank: 8,
      importCount: 1,
      exportCount: 2,
      summary: 'Builds and validates auth sessions.',
      summarySource: 'fallback' as const,
    },
  ],
  chunks: [
    {
      id: 'chunk-1',
      filePath: 'src/features/auth/login.ts',
      chunkIndex: 0,
      startLine: 1,
      endLine: 20,
      content: 'export async function loginUser(input) { return createSession(input); }',
      tokenCount: 20,
      summary: 'Login entrypoint calling createSession.',
      contentHash: 'c1',
      summarySource: 'fallback' as const,
    },
    {
      id: 'chunk-2',
      filePath: 'src/features/auth/login.ts',
      chunkIndex: 1,
      startLine: 21,
      endLine: 40,
      content: 'function validatePassword(input) { return input.password.length > 0; }',
      tokenCount: 18,
      summary: 'Password validation helper.',
      contentHash: 'c2',
      summarySource: 'fallback' as const,
    },
    {
      id: 'chunk-3',
      filePath: 'src/features/auth/session.ts',
      chunkIndex: 0,
      startLine: 1,
      endLine: 20,
      content: 'export function createSession(input) { return { token: input.userId }; }',
      tokenCount: 19,
      summary: 'Creates a session token.',
      contentHash: 'c3',
      summarySource: 'fallback' as const,
    },
  ],
  functions: [
    {
      id: 'fn-login',
      filePath: 'src/features/auth/login.ts',
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
      id: 'fn-validate',
      filePath: 'src/features/auth/login.ts',
      name: 'validatePassword',
      kind: 'function',
      signature: 'function validatePassword(input)',
      startLine: 21,
      endLine: 28,
      line: 21,
      column: 1,
      parentFunctionId: null,
    },
    {
      id: 'fn-session',
      filePath: 'src/features/auth/session.ts',
      name: 'createSession',
      kind: 'function',
      signature: 'export function createSession(input)',
      startLine: 1,
      endLine: 10,
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
      edgeType: 'call' as const,
      symbol: 'createSession',
      line: 5,
    },
    {
      id: 'edge-2',
      fromFunctionId: 'fn-login',
      toFunctionId: 'fn-validate',
      edgeType: 'call' as const,
      symbol: 'validatePassword',
      line: 3,
    },
  ],
};

const codeMapSnapshot = {
  repositoryId: 'repo-1',
  branch: 'main',
  rootDirectory: '/repo',
  generatedAt: '2026-05-18T00:00:00.000Z',
  manifestHash: 'manifest-1',
  files: [
    {
      relativePath: 'src/features/auth/login.ts',
      language: 'ts',
      lineCount: 60,
      byteSize: 1200,
      symbols: [
        {
          name: 'loginUser',
          kind: 'function',
          line: 1,
          column: 1,
          signature: 'export async function loginUser(input)',
          rank: 0.9,
        },
      ],
      importCount: 2,
      exportCount: 1,
      rank: 0.7,
    },
    {
      relativePath: 'src/features/auth/session.ts',
      language: 'ts',
      lineCount: 40,
      byteSize: 800,
      symbols: [
        {
          name: 'createSession',
          kind: 'function',
          line: 1,
          column: 1,
          signature: 'export function createSession(input)',
          rank: 0.8,
        },
      ],
      importCount: 1,
      exportCount: 2,
      rank: 0.6,
    },
  ],
  edges: [
    {
      fromFile: 'src/features/auth/login.ts',
      toFile: 'src/features/auth/session.ts',
      symbols: ['createSession'],
    },
  ],
  stats: {
    fileCount: 2,
    symbolCount: 2,
    edgeCount: 1,
    totalLines: 100,
  },
};

describe('project graph', () => {
  it('builds file, chunk, function, and directory nodes with edges', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: codeIndexSnapshot as any,
      codeMapSnapshot: codeMapSnapshot as any,
    });

    expect(graph.stats.fileCount).toBe(2);
    expect(graph.stats.chunkCount).toBe(3);
    expect(graph.stats.functionCount).toBe(3);
    expect(graph.stats.directoryCount).toBeGreaterThanOrEqual(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'imports',
          fromId: 'file:src/features/auth/login.ts',
          toId: 'file:src/features/auth/session.ts',
        }),
        expect.objectContaining({
          relation: 'calls',
          fromId: 'function:fn-login',
          toId: 'function:fn-session',
        }),
      ]),
    );
    expect(graph.communities.length).toBeGreaterThan(0);
    expect(graph.communities[0]?.label).toContain('src/features/auth');
  });

  it('queries the graph and finds implementation points for a feature question', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: codeIndexSnapshot as any,
      codeMapSnapshot: codeMapSnapshot as any,
    });

    const result = queryProjectGraph(graph, 'where is login implemented');

    expect(result.startNodes[0]?.filePath).toBe('src/features/auth/login.ts');
    expect(result.matches.functions[0]?.label).toBe('loginUser');
    expect(result.matches.chunks[0]?.filePath).toBe('src/features/auth/login.ts');
    expect(result.communities.length).toBeGreaterThan(0);
    expect(result.confidence.overall).toBeGreaterThan(0);
    expect(result.contextFilterStats.selectedNodeCount).toBeLessThanOrEqual(36);
    expect(result.contextText).toContain('Top function matches');
    expect(result.contextText).toContain('Relevant communities');
    expect(result.contextText).toContain('loginUser');
  });

  it('explains a node and returns incoming/outgoing edges', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: codeIndexSnapshot as any,
      codeMapSnapshot: codeMapSnapshot as any,
    });

    const result = explainProjectGraphNode(graph, 'createSession');

    expect(result?.node.filePath).toBe('src/features/auth/session.ts');
    expect(result?.incoming).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'calls',
        }),
      ]),
    );
  });

  it('finds a shortest path between related implementation points', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: codeIndexSnapshot as any,
      codeMapSnapshot: codeMapSnapshot as any,
    });

    const result = shortestProjectGraphPath(
      graph,
      'loginUser',
      'createSession',
    );

    expect(result?.hops).toBe(1);
    expect(result?.edges[0]?.relation).toBe('calls');
    expect(result?.score).toBeGreaterThan(0);
    expect(result?.confidence).toBeGreaterThan(0.5);
  });

  it('builds a useful fallback answer without an AI provider', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: codeIndexSnapshot as any,
      codeMapSnapshot: codeMapSnapshot as any,
    });
    const result = queryProjectGraph(graph, 'where is login implemented');

    const answer = buildProjectGraphFallbackAnswer(
      'where is login implemented',
      result,
    );

    expect(answer).toContain('Most likely implementation points');
    expect(answer).toContain('src/features/auth/login.ts:1-12');
    expect(answer).toContain('src/features/auth/session.ts');
  });

  it('uses inferred file tags to boost route-style implementation lookup', () => {
    const graph = buildProjectGraph({
      codeIndexSnapshot: {
        ...codeIndexSnapshot,
        files: [
          {
            relativePath: 'src/http/login-handler.ts',
            language: 'ts',
            byteSize: 900,
            lineCount: 45,
            fileHash: 'route-a',
            rank: 9,
            importCount: 1,
            exportCount: 1,
            summary: 'Endpoint for auth login requests.',
            summarySource: 'fallback',
          },
          {
            relativePath: 'src/config/auth-settings.ts',
            language: 'ts',
            byteSize: 400,
            lineCount: 20,
            fileHash: 'config-b',
            rank: 7,
            importCount: 0,
            exportCount: 1,
            summary: 'Auth settings and token values.',
            summarySource: 'fallback',
          },
        ],
        chunks: [],
        functions: [],
        functionEdges: [],
        meta: {
          ...codeIndexSnapshot.meta,
          stats: {
            ...codeIndexSnapshot.meta.stats,
            fileCount: 2,
            chunkCount: 0,
            functionCount: 0,
            functionEdgeCount: 0,
          },
        },
      } as any,
      codeMapSnapshot: null,
    });

    const result = queryProjectGraph(graph, 'where is the auth api implemented');

    expect(result.matches.files[0]?.filePath).toBe('src/http/login-handler.ts');
    expect(result.matches.files[0]?.reasons).toContain('term:tag:api');
  });
});
