import { describe, expect, it } from 'vitest';

import { renderCodeMapText, renderCodeMapSummary } from './code-map-render.js';
import type { CodeMapSnapshot } from './code-map-types.js';

function makeSnapshot(overrides?: Partial<CodeMapSnapshot>): CodeMapSnapshot {
  return {
    repositoryId: 'test-repo',
    branch: 'main',
    rootDirectory: '/tmp/test',
    generatedAt: '2025-01-01T00:00:00Z',
    manifestHash: 'abc123',
    files: [],
    edges: [],
    stats: { fileCount: 0, symbolCount: 0, edgeCount: 0, totalLines: 0 },
    ...overrides,
  };
}

describe('renderCodeMapText', () => {
  it('renders empty snapshot without crashing', () => {
    const text = renderCodeMapText(makeSnapshot());
    expect(text).toContain('Code Map');
    expect(text).toContain('0 files');
  });

  it('truncates when token budget is small', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      relativePath: `src/file${i}.ts`,
      language: 'typescript',
      lineCount: 100,
      byteSize: 5000,
      symbols: [
        { name: `Func${i}`, kind: 'function' as const, line: 1, column: 1, signature: `export function Func${i}()`, rank: 0.5 },
        { name: `Class${i}`, kind: 'class' as const, line: 10, column: 1, signature: `export class Class${i}`, rank: 0.3 },
      ],
      importCount: 2,
      exportCount: 2,
      rank: 1.0 - i * 0.01,
    }));

    const snapshot = makeSnapshot({
      files,
      stats: { fileCount: 50, symbolCount: 100, edgeCount: 20, totalLines: 5000 },
    });

    const text = renderCodeMapText(snapshot, { maxTokens: 100 });
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(2000);
  });

  it('renders grouped by directory', () => {
    const snapshot = makeSnapshot({
      files: [
        {
          relativePath: 'src/utils/format.ts',
          language: 'typescript',
          lineCount: 20,
          byteSize: 500,
          symbols: [{ name: 'format', kind: 'function', line: 1, column: 1, signature: 'export function format()', rank: 0.5 }],
          importCount: 0,
          exportCount: 1,
          rank: 0.5,
        },
        {
          relativePath: 'src/utils/parse.ts',
          language: 'typescript',
          lineCount: 15,
          byteSize: 400,
          symbols: [{ name: 'parse', kind: 'function', line: 1, column: 1, signature: 'export function parse()', rank: 0.4 }],
          importCount: 0,
          exportCount: 1,
          rank: 0.4,
        },
      ],
      stats: { fileCount: 2, symbolCount: 2, edgeCount: 0, totalLines: 35 },
    });

    const grouped = renderCodeMapText(snapshot, { groupByDirectory: true });
    expect(grouped).toContain('src/utils/:');

    const flat = renderCodeMapText(snapshot, { groupByDirectory: false });
    expect(flat).not.toContain('src/utils/:');
    expect(flat).toContain('src/utils/format.ts:');
  });
});

describe('renderCodeMapSummary', () => {
  it('renders empty snapshot', () => {
    const text = renderCodeMapSummary(makeSnapshot());
    expect(text).toContain('Files: 0');
  });

  it('shows top N files', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      relativePath: `src/mod${i}.ts`,
      language: 'typescript',
      lineCount: 10,
      byteSize: 200,
      symbols: [{ name: `fn${i}`, kind: 'function' as const, line: 1, column: 1, signature: `fn${i}()`, rank: 0.1 }],
      importCount: 0,
      exportCount: 1,
      rank: 1.0 - i * 0.05,
    }));

    const text = renderCodeMapSummary(
      makeSnapshot({ files, stats: { fileCount: 20, symbolCount: 20, edgeCount: 0, totalLines: 200 } }),
      5,
    );
    const fileLines = text.split('\n').filter((l) => l.includes('src/mod'));
    expect(fileLines.length).toBe(5);
  });
});
