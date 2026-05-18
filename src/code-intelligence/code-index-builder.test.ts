import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  batchEmbedAndStoreMock,
  resolveEmbeddingProviderMock,
} = vi.hoisted(() => ({
  batchEmbedAndStoreMock: vi.fn(async () => 0),
  resolveEmbeddingProviderMock: vi.fn(async () => null),
}));

vi.mock('../embedding/resolve.js', () => ({
  resolveEmbeddingProvider: resolveEmbeddingProviderMock,
}));

vi.mock('../embedding/vector-store.js', () => ({
  batchEmbedAndStore: batchEmbedAndStoreMock,
}));

import { buildCodeIndex, enrichCodeIndexSnapshotAsync } from './code-index-builder.js';
import { buildCodeMap } from './code-map-builder.js';
import { _initTestDatabase } from '../db.js';
import { loadCodeIndexSnapshot, saveCodeIndexSnapshot } from '../db/code-index-db.js';

const tempRoots: string[] = [];

beforeEach(() => {
  _initTestDatabase();
  resolveEmbeddingProviderMock.mockReset();
  resolveEmbeddingProviderMock.mockResolvedValue(null);
  batchEmbedAndStoreMock.mockReset();
  batchEmbedAndStoreMock.mockResolvedValue(0);
});

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

describe('buildCodeIndex', () => {
  it('builds chunks and function dependency edges across files', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/format.ts', [
      'export function formatName(input: string) {',
      '  return input.trim().toUpperCase();',
      '}',
    ].join('\n'));
    writeFile(root, 'src/run.ts', [
      "import { formatName } from './format';",
      '',
      'function helper(input: string) {',
      '  return formatName(input);',
      '}',
      '',
      'export function runTask(name: string) {',
      '  return helper(name);',
      '}',
    ].join('\n'));

    const snapshot = await buildCodeIndex(root, 'repo-1', 'main', {
      embedChunks: false,
    });

    expect(snapshot.meta.stats.fileCount).toBe(2);
    expect(snapshot.chunks.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['formatName', 'helper', 'runTask']),
    );

    const functionNamesById = new Map(snapshot.functions.map((fn) => [fn.id, fn.name]));
    const edgePairs = snapshot.functionEdges.map((edge) => ({
      from: functionNamesById.get(edge.fromFunctionId),
      to: functionNamesById.get(edge.toFunctionId),
    }));

    expect(edgePairs).toEqual(
      expect.arrayContaining([
        { from: 'helper', to: 'formatName' },
        { from: 'runTask', to: 'helper' },
      ]),
    );
  });

  it('round-trips through code index persistence', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/index.ts', [
      'export function main() {',
      "  return 'ok';",
      '}',
    ].join('\n'));

    const snapshot = await buildCodeIndex(root, 'repo-roundtrip', 'main', {
      embedChunks: false,
    });
    await saveCodeIndexSnapshot(snapshot);

    const loaded = await loadCodeIndexSnapshot('repo-roundtrip', 'main');
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.stats.chunkCount).toBe(snapshot.meta.stats.chunkCount);
    expect(loaded?.functions.map((fn) => fn.name)).toEqual(snapshot.functions.map((fn) => fn.name));
  });

  it('tracks member calls, aliased imports, namespace imports, and nested functions in ts/js', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/utils.ts', [
      'export function formatName(input: string) {',
      '  return input.trim().toUpperCase();',
      '}',
      '',
      'export function joinName(input: string) {',
      '  return `${input}!`;',
      '}',
    ].join('\n'));
    writeFile(root, 'src/service.ts', [
      "import { formatName as formatAlias } from './utils';",
      "import * as utils from './utils';",
      '',
      'class Service {',
      '  render(name: string) {',
      '    return this.wrap(formatAlias(name)) + utils.joinName(name);',
      '  }',
      '',
      '  wrap(value: string) {',
      '    return value;',
      '  }',
      '}',
      '',
      'export const runTask = () => {',
      '  function normalize(value: string) {',
      '    return value.trim();',
      '  }',
      '  return normalize(" demo ");',
      '};',
    ].join('\n'));

    const snapshot = await buildCodeIndex(root, 'repo-ts-graph', 'main', {
      embedChunks: false,
    });

    expect(snapshot.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['render', 'wrap', 'runTask', 'normalize', 'formatName', 'joinName']),
    );

    const normalizeFn = snapshot.functions.find((fn) => fn.name === 'normalize');
    const runTaskFn = snapshot.functions.find((fn) => fn.name === 'runTask');
    expect(normalizeFn?.parentFunctionId).toBe(runTaskFn?.id);

    const namesById = new Map(snapshot.functions.map((fn) => [fn.id, fn.name]));
    const edgePairs = snapshot.functionEdges.map((edge) => ({
      from: namesById.get(edge.fromFunctionId),
      to: namesById.get(edge.toFunctionId),
    }));

    expect(edgePairs).toEqual(
      expect.arrayContaining([
        { from: 'render', to: 'wrap' },
        { from: 'render', to: 'formatName' },
        { from: 'render', to: 'joinName' },
        { from: 'runTask', to: 'normalize' },
      ]),
    );
  });

  it('persists ai-generated file and chunk summaries when a summary generator is provided', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/service.ts', [
      'export function loadUserProfile(userId: string) {',
      '  return fetch(`/api/users/${userId}`).then((resp) => resp.json());',
      '}',
      '',
      'export function formatProfileName(name: string) {',
      '  return name.trim().toUpperCase();',
      '}',
    ].join('\n'));

    const snapshot = await buildCodeIndex(root, 'repo-summary', 'main', {
      embedChunks: false,
      generateSummaryText: async () => JSON.stringify({
        file_summary: '负责拉取用户资料并格式化展示名称。',
        chunk_summaries: [
          { chunk_index: 0, summary: '用户资料加载逻辑。' },
          { chunk_index: 1, summary: '名称格式化逻辑。' },
        ],
      }),
    });

    expect(snapshot.files[0]?.summary).toBe('负责拉取用户资料并格式化展示名称。');
    expect(snapshot.chunks[0]?.summary).toBe('用户资料加载逻辑。');
    expect(snapshot.chunks[1]?.summary).toBe('名称格式化逻辑。');
  });

  it('emits a base snapshot before ai summaries complete', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/service.ts', [
      'export function loadUserProfile(userId: string) {',
      '  return fetch(`/api/users/${userId}`).then((resp) => resp.json());',
      '}',
    ].join('\n'));

    let releaseSummary: (() => void) | null = null;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const emittedSnapshots: Array<{
      status: string;
      stage: string;
      summarySource: string;
    }> = [];

    const buildPromise = buildCodeIndex(root, 'repo-base-snapshot', 'main', {
      embedChunks: false,
      onSnapshot: async (snapshot) => {
        emittedSnapshots.push({
          status: snapshot.meta.status,
          stage: snapshot.meta.stage,
          summarySource: snapshot.files[0]?.summarySource || 'fallback',
        });
      },
      generateSummaryText: async () => {
        await summaryGate;
        return JSON.stringify({
          file_summary: '负责拉取用户资料。',
          chunk_summaries: [{ chunk_index: 0, summary: '资料加载逻辑。' }],
        });
      },
    });

    while (emittedSnapshots.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(emittedSnapshots[0]).toMatchObject({
      status: 'building',
      stage: 'summaries',
      summarySource: 'fallback',
    });

    releaseSummary?.();
    const snapshot = await buildPromise;
    expect(snapshot.files[0]?.summarySource).toBe('ai');
    expect(emittedSnapshots.at(-1)).toMatchObject({
      status: 'ready',
      stage: 'complete',
      summarySource: 'ai',
    });
  });

  it('reuses a provided code map snapshot when the manifest matches', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/format.ts', [
      'export function formatName(input: string) {',
      '  return input.trim().toUpperCase();',
      '}',
    ].join('\n'));
    writeFile(root, 'src/run.ts', [
      "import { formatName } from './format';",
      'export function runTask(name: string) {',
      '  return formatName(name);',
      '}',
    ].join('\n'));

    const providedCodeMapSnapshot = buildCodeMap(root, 'repo-reuse-map', 'main');
    const targetFile = providedCodeMapSnapshot.files.find(
      (file) => file.relativePath === 'src/format.ts',
    );
    expect(targetFile).toBeDefined();
    targetFile!.rank = 42.4242;

    const snapshot = await buildCodeIndex(root, 'repo-reuse-map', 'main', {
      embedChunks: false,
      codeMapSnapshot: providedCodeMapSnapshot,
    });

    expect(
      snapshot.files.find((file) => file.relativePath === 'src/format.ts')?.rank,
    ).toBe(42.4242);
  });

  it('emits the code map snapshot before index assembly continues', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/index.ts', [
      'export function main() {',
      "  return 'ok';",
      '}',
    ].join('\n'));

    const seenSnapshots: string[] = [];
    const snapshot = await buildCodeIndex(root, 'repo-codemap-callback', 'main', {
      embedChunks: false,
      onCodeMapSnapshot: async (codeMapSnapshot) => {
        seenSnapshots.push(codeMapSnapshot.manifestHash);
      },
    });

    expect(seenSnapshots).toEqual([snapshot.meta.manifestHash]);
  });

  it('reuses cached summaries for unchanged files and only regenerates changed files', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/a.ts', [
      'export function alpha() {',
      "  return 'a';",
      '}',
    ].join('\n'));
    writeFile(root, 'src/b.ts', [
      'export function beta() {',
      "  return 'b';",
      '}',
    ].join('\n'));

    const summaryMock = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce(JSON.stringify({
        file_summary: 'alpha file',
        chunk_summaries: [{ chunk_index: 0, summary: 'alpha chunk' }],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        file_summary: 'beta file',
        chunk_summaries: [{ chunk_index: 0, summary: 'beta chunk' }],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        file_summary: 'beta file updated',
        chunk_summaries: [{ chunk_index: 0, summary: 'beta chunk updated' }],
      }));

    const first = await buildCodeIndex(root, 'repo-reuse', 'main', {
      embedChunks: false,
      generateSummaryText: summaryMock,
    });
    await saveCodeIndexSnapshot(first);
    expect(summaryMock).toHaveBeenCalledTimes(2);

    writeFile(root, 'src/b.ts', [
      'export function beta() {',
      "  return 'b2';",
      '}',
    ].join('\n'));

    const second = await buildCodeIndex(root, 'repo-reuse', 'main', {
      embedChunks: false,
      generateSummaryText: summaryMock,
    });

    expect(summaryMock).toHaveBeenCalledTimes(3);
    const aFile = second.files.find((file) => file.relativePath === 'src/a.ts');
    const bFile = second.files.find((file) => file.relativePath === 'src/b.ts');
    expect(aFile?.summary).toBe('alpha file');
    expect(bFile?.summary).toBe('beta file updated');
    expect(second.chunks.find((chunk) => chunk.filePath === 'src/a.ts')?.summary).toBe('alpha chunk');
    expect(second.chunks.find((chunk) => chunk.filePath === 'src/b.ts')?.summary).toBe('beta chunk updated');
  });

  it('reports enrichment summary progress against the actual target file count', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/a.ts', [
      'export function alpha() {',
      "  return 'a';",
      '}',
    ].join('\n'));
    writeFile(root, 'src/b.ts', [
      'export function beta() {',
      "  return 'b';",
      '}',
    ].join('\n'));

    const baseSnapshot = await buildCodeIndex(root, 'repo-enrich-summary', 'main', {
      summarizeWithAi: false,
      embedChunks: false,
    });
    const progressEvents: Array<{ stage: string; processed: number; total: number }> = [];
    let summaryCallIndex = 0;

    await enrichCodeIndexSnapshotAsync(root, baseSnapshot, {
      summarizeWithAi: true,
      embedChunks: false,
      generateSummaryText: async () => {
        summaryCallIndex += 1;
        return JSON.stringify(
          summaryCallIndex === 1
            ? {
                file_summary: 'alpha file',
                chunk_summaries: [{ chunk_index: 0, summary: 'alpha chunk' }],
              }
            : {
                file_summary: 'beta file',
                chunk_summaries: [{ chunk_index: 0, summary: 'beta chunk' }],
              },
        );
      },
      onProgress: async (progress) => {
        progressEvents.push({
          stage: progress.stage,
          processed: progress.processedFiles,
          total: progress.totalFiles,
        });
      },
    });

    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { stage: 'summaries', processed: 1, total: 2 },
        { stage: 'summaries', processed: 2, total: 2 },
      ]),
    );
  });

  it('reports embeddings progress from zero to total chunk count during enrichment', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/worker.ts', Array.from({ length: 220 }, (_, index) => `export const line${index} = ${index};`).join('\n'));

    const baseSnapshot = await buildCodeIndex(root, 'repo-enrich-embeddings', 'main', {
      summarizeWithAi: false,
      embedChunks: false,
    });
    resolveEmbeddingProviderMock.mockResolvedValue({ id: 'mock-provider' });
    batchEmbedAndStoreMock.mockImplementation(async (_ownerType, items) => items.length);
    const progressEvents: Array<{ stage: string; processed: number; total: number }> = [];

    const enriched = await enrichCodeIndexSnapshotAsync(root, baseSnapshot, {
      summarizeWithAi: false,
      embedChunks: true,
      onProgress: async (progress) => {
        progressEvents.push({
          stage: progress.stage,
          processed: progress.processedFiles,
          total: progress.totalFiles,
        });
      },
    });

    expect(baseSnapshot.chunks.length).toBeGreaterThan(1);
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        { stage: 'embeddings', processed: 0, total: baseSnapshot.chunks.length },
        { stage: 'embeddings', processed: baseSnapshot.chunks.length, total: baseSnapshot.chunks.length },
      ]),
    );
    expect(enriched.meta.stats.embeddedChunkCount).toBe(baseSnapshot.chunks.length);
  });
});
