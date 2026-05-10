import path from 'node:path';

import {
  getCodeSearchSnapshot,
  saveCodeSearchSnapshot,
  deleteCodeSearchSnapshot,
} from '../db.js';
import type {
  CodeMapEdge,
  CodeMapFile,
  CodeMapSnapshot,
  CodeMapSymbol,
} from './code-map-types.js';
import type { CodeSearchSymbol } from './code-search-types.js';

const CODE_MAP_NAMESPACE = 'code-map';

export function resolveCodeMapCacheKey(
  repositoryId: string,
  branch: string,
): string {
  return `${CODE_MAP_NAMESPACE}:${repositoryId}:${branch}`.toLowerCase();
}

interface FileRankPayload {
  rank: number;
  exportCount: number;
  importCount: number;
  symbolRanks: Record<string, number>;
}

export async function saveCodeMapToDb(
  snapshot: CodeMapSnapshot,
): Promise<void> {
  const cacheKey = resolveCodeMapCacheKey(snapshot.repositoryId, snapshot.branch);

  await saveCodeSearchSnapshot({
    cache_key: cacheKey,
    root_directory: snapshot.rootDirectory,
    manifest_hash: snapshot.manifestHash,
    build_options_json: JSON.stringify({
      edges: snapshot.edges,
      repositoryId: snapshot.repositoryId,
      branch: snapshot.branch,
    }),
    generated_at: snapshot.generatedAt,
    file_count: snapshot.stats.fileCount,
    symbol_count: snapshot.stats.symbolCount,
    term_count: snapshot.stats.edgeCount,
    files: snapshot.files.map((file) => {
      const payload: FileRankPayload = {
        rank: file.rank,
        exportCount: file.exportCount,
        importCount: file.importCount,
        symbolRanks: Object.fromEntries(
          file.symbols.map((s) => [`${s.name}:${s.line}`, s.rank]),
        ),
      };
      return {
        relative_path: file.relativePath,
        absolute_path: path.posix.join(snapshot.rootDirectory, file.relativePath),
        extension: path.extname(file.relativePath),
        language: file.language,
        byte_size: file.byteSize,
        line_count: file.lineCount,
        imports_json: null,
        previews_json: JSON.stringify(payload),
        terms: [],
        symbols: file.symbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          line: s.line,
          column_number: s.column,
          signature: s.signature,
        })),
      };
    }),
  });
}

export async function loadCodeMapFromDb(
  repositoryId: string,
  branch: string,
): Promise<CodeMapSnapshot | null> {
  const cacheKey = resolveCodeMapCacheKey(repositoryId, branch);
  const snapshot = await getCodeSearchSnapshot(cacheKey);
  if (!snapshot) return null;

  let edges: CodeMapEdge[] = [];
  let storedRepoId = repositoryId;
  let storedBranch = branch;
  try {
    const parsed = JSON.parse(snapshot.index.build_options_json) as {
      edges?: CodeMapEdge[];
      repositoryId?: string;
      branch?: string;
    };
    edges = Array.isArray(parsed.edges) ? parsed.edges : [];
    storedRepoId = parsed.repositoryId || repositoryId;
    storedBranch = parsed.branch || branch;
  } catch { /* use defaults */ }

  const symbolsByPath = new Map<string, typeof snapshot.symbols>();
  for (const sym of snapshot.symbols) {
    const arr = symbolsByPath.get(sym.relative_path) || [];
    arr.push(sym);
    symbolsByPath.set(sym.relative_path, arr);
  }

  const files: CodeMapFile[] = snapshot.files.map((fileRecord) => {
    let payload: FileRankPayload = { rank: 0, exportCount: 0, importCount: 0, symbolRanks: {} };
    try {
      const parsed = JSON.parse(fileRecord.previews_json) as FileRankPayload;
      if (parsed && typeof parsed.rank === 'number') payload = parsed;
    } catch { /* use defaults */ }

    const fileSymbols = symbolsByPath.get(fileRecord.relative_path) || [];
    const symbols: CodeMapSymbol[] = fileSymbols.map((s) => ({
      name: s.name,
      kind: s.kind as CodeSearchSymbol['kind'],
      line: s.line,
      column: s.column_number,
      signature: s.signature,
      rank: payload.symbolRanks[`${s.name}:${s.line}`]
        ?? payload.symbolRanks[s.name]
        ?? payload.rank,
    }));

    return {
      relativePath: fileRecord.relative_path,
      language: fileRecord.language,
      lineCount: fileRecord.line_count,
      byteSize: fileRecord.byte_size,
      symbols,
      importCount: payload.importCount,
      exportCount: payload.exportCount,
      rank: payload.rank,
    };
  });

  files.sort((a, b) => b.rank - a.rank);

  return {
    repositoryId: storedRepoId,
    branch: storedBranch,
    rootDirectory: snapshot.index.root_directory,
    generatedAt: snapshot.index.generated_at,
    manifestHash: snapshot.index.manifest_hash,
    files,
    edges,
    stats: {
      fileCount: snapshot.index.file_count,
      symbolCount: snapshot.index.symbol_count,
      edgeCount: snapshot.index.term_count,
      totalLines: files.reduce((t, f) => t + f.lineCount, 0),
    },
  };
}

export async function deleteCodeMapFromDb(
  repositoryId: string,
  branch: string,
): Promise<void> {
  const cacheKey = resolveCodeMapCacheKey(repositoryId, branch);
  await deleteCodeSearchSnapshot(cacheKey);
}
