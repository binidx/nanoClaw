import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  deleteCodeSearchSnapshot,
  getCodeSearchSnapshot,
  saveCodeSearchSnapshot,
  type CodeSearchSnapshotRecord,
} from '../db.js';
import {
  allSupportedSourceFileCache,
  exactQueryFallbackFileCache,
  buildCodeSearchIndex,
  resolveBuildOptions,
  DEFAULT_BUILD_OPTIONS,
} from './code-search-index.js';
import { listCandidateFiles, normalizeRelativePath } from './code-search-collect.js';
import type {
  CodeSearchBuildOptions,
  CodeSearchFile,
  CodeSearchImport,
  CodeSearchIndex,
  CodeSearchPersistenceOptions,
  CodeSearchCacheStatus,
  CodeSearchLoadResult,
  CodeSearchSymbol,
} from './code-search-types.js';

const DEFAULT_CACHE_NAMESPACE = 'code-search-index';

interface CodeSearchManifestEntry {
  absolutePath: string;
  relativePath: string;
  byteSize: number;
  modifiedTimeMs: number;
}

interface CodeSearchManifest {
  cacheKey: string;
  rootDirectory: string;
  manifestHash: string;
  options: CodeSearchBuildOptions;
  files: CodeSearchManifestEntry[];
}

function serializeImports(imports: CodeSearchImport[]): string {
  return JSON.stringify(
    imports.map((entry) => ({
      modulePath: entry.modulePath,
      symbolName: entry.symbolName,
      line: entry.line,
      signature: entry.signature,
    })),
  );
}

function restoreImports(raw: string | null | undefined): CodeSearchImport[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const modulePath = String(record.modulePath || '').trim();
      if (!modulePath) return [];
      return [
        {
          modulePath,
          symbolName: String(record.symbolName || '').trim(),
          line: Number(record.line) || 1,
          signature: String(record.signature || '').trim() || modulePath,
        } satisfies CodeSearchImport,
      ];
    });
  } catch {
    return [];
  }
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function isExistingDirectory(rootDirectory: string): boolean {
  try {
    return fs.statSync(rootDirectory).isDirectory();
  } catch {
    return false;
  }
}

export function resolveCodeSearchCacheKey(
  rootDirectory: string,
  cacheKey?: string,
  cacheNamespace = DEFAULT_CACHE_NAMESPACE,
): string {
  const normalizedRoot = path.resolve(rootDirectory).replace(/\\/g, '/');
  const explicitKey = typeof cacheKey === 'string' ? cacheKey.trim() : '';
  if (explicitKey) {
    return `${cacheNamespace}:${explicitKey.toLowerCase()}`;
  }
  return `${cacheNamespace}:root:${normalizedRoot.toLowerCase()}`;
}

function computeCodeSearchManifest(
  rootDirectory: string,
  options?: CodeSearchPersistenceOptions,
): CodeSearchManifest | null {
  const normalizedRoot = path.resolve(rootDirectory);
  if (!isExistingDirectory(normalizedRoot)) return null;

  const effectiveOptions = resolveBuildOptions(options?.buildOptions);
  const files = listCandidateFiles(normalizedRoot, effectiveOptions)
    .map((absolutePath) => {
      try {
        const stats = fs.statSync(absolutePath);
        if (!stats.isFile()) return null;
        return {
          absolutePath,
          relativePath: normalizeRelativePath(normalizedRoot, absolutePath),
          byteSize: stats.size,
          modifiedTimeMs: Math.trunc(stats.mtimeMs),
        } satisfies CodeSearchManifestEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is CodeSearchManifestEntry => entry !== null);

  const manifestHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        rootDirectory: normalizedRoot,
        options: effectiveOptions,
        files: files.map((file) => ({
          relativePath: file.relativePath,
          byteSize: file.byteSize,
          modifiedTimeMs: file.modifiedTimeMs,
        })),
      }),
    )
    .digest('hex');

  return {
    cacheKey: resolveCodeSearchCacheKey(
      normalizedRoot,
      options?.cacheKey,
      options?.cacheNamespace,
    ),
    rootDirectory: normalizedRoot,
    manifestHash,
    options: effectiveOptions,
    files,
  };
}

function restoreCodeSearchIndex(
  snapshot: CodeSearchSnapshotRecord,
): CodeSearchIndex {
  const parsedOptions = {
    ...DEFAULT_BUILD_OPTIONS,
    ...(() => {
      try {
        return JSON.parse(
          snapshot.index.build_options_json,
        ) as Partial<CodeSearchBuildOptions>;
      } catch {
        return {};
      }
    })(),
  };
  const filesByPath = new Map<string, CodeSearchFile>();

  snapshot.files.forEach((fileRecord) => {
    filesByPath.set(fileRecord.relative_path, {
      absolutePath: fileRecord.absolute_path,
      relativePath: fileRecord.relative_path,
      extension: fileRecord.extension,
      language: fileRecord.language,
      byteSize: fileRecord.byte_size,
      lineCount: fileRecord.line_count,
      terms: [],
      symbols: [],
      imports: restoreImports(fileRecord.imports_json),
      previews: safeParseStringArray(fileRecord.previews_json),
    });
  });

  snapshot.terms.forEach((termRecord) => {
    filesByPath.get(termRecord.relative_path)?.terms.push(termRecord.term);
  });
  snapshot.symbols.forEach((symbolRecord) => {
    filesByPath.get(symbolRecord.relative_path)?.symbols.push({
      name: symbolRecord.name,
      kind: symbolRecord.kind as CodeSearchSymbol['kind'],
      line: symbolRecord.line,
      column: symbolRecord.column_number,
      signature: symbolRecord.signature,
    });
  });

  const files = Array.from(filesByPath.values()).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const symbolCount = files.reduce(
    (total, file) => total + file.symbols.length,
    0,
  );
  const termCount = files.reduce((total, file) => total + file.terms.length, 0);

  return {
    rootDirectory: snapshot.index.root_directory,
    generatedAt: snapshot.index.generated_at,
    options: parsedOptions,
    files,
    fileCount: files.length,
    symbolCount,
    termCount,
  };
}

export async function getCodeSearchCacheStatus(
  rootDirectory: string,
  options?: CodeSearchPersistenceOptions,
): Promise<CodeSearchCacheStatus | null> {
  const manifest = computeCodeSearchManifest(rootDirectory, options);
  if (!manifest) return null;

  const snapshot = await getCodeSearchSnapshot(manifest.cacheKey);
  if (!snapshot) {
    return {
      cacheKey: manifest.cacheKey,
      rootDirectory: manifest.rootDirectory,
      status: 'missing',
      manifestHash: manifest.manifestHash,
      persistedManifestHash: null,
      generatedAt: null,
      fileCount: null,
      symbolCount: null,
      termCount: null,
    };
  }

  const isFresh =
    snapshot.index.root_directory === manifest.rootDirectory &&
    snapshot.index.manifest_hash === manifest.manifestHash;
  return {
    cacheKey: manifest.cacheKey,
    rootDirectory: manifest.rootDirectory,
    status: isFresh ? 'fresh' : 'stale',
    manifestHash: manifest.manifestHash,
    persistedManifestHash: snapshot.index.manifest_hash,
    generatedAt: snapshot.index.generated_at,
    fileCount: snapshot.index.file_count,
    symbolCount: snapshot.index.symbol_count,
    termCount: snapshot.index.term_count,
  };
}

export async function loadFreshCodeSearchIndexFromDb(
  rootDirectory: string,
  options?: CodeSearchPersistenceOptions,
): Promise<CodeSearchLoadResult | null> {
  const manifest = computeCodeSearchManifest(rootDirectory, options);
  if (!manifest) return null;

  const snapshot = await getCodeSearchSnapshot(manifest.cacheKey);
  if (!snapshot) return null;
  if (
    snapshot.index.root_directory !== manifest.rootDirectory ||
    snapshot.index.manifest_hash !== manifest.manifestHash
  ) {
    return null;
  }

  return {
    cacheKey: manifest.cacheKey,
    rootDirectory: manifest.rootDirectory,
    manifestHash: manifest.manifestHash,
    source: 'database',
    index: restoreCodeSearchIndex(snapshot),
  };
}

export async function rebuildCodeSearchIndexInDb(
  rootDirectory: string,
  options?: CodeSearchPersistenceOptions,
): Promise<CodeSearchLoadResult | null> {
  const manifest = computeCodeSearchManifest(rootDirectory, options);
  if (!manifest) return null;

  const index = buildCodeSearchIndex(manifest.rootDirectory, manifest.options);
  await saveCodeSearchSnapshot({
    cache_key: manifest.cacheKey,
    root_directory: manifest.rootDirectory,
    manifest_hash: manifest.manifestHash,
    build_options_json: JSON.stringify(index.options),
    generated_at: index.generatedAt,
    file_count: index.fileCount,
    symbol_count: index.symbolCount,
    term_count: index.termCount,
    files: index.files.map((file) => ({
      relative_path: file.relativePath,
      absolute_path: file.absolutePath,
      extension: file.extension,
      language: file.language,
      byte_size: file.byteSize,
      line_count: file.lineCount,
      imports_json: serializeImports(file.imports),
      previews_json: JSON.stringify(file.previews),
      terms: [...file.terms],
      symbols: file.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        column_number: symbol.column,
        signature: symbol.signature,
      })),
    })),
  });

  return {
    cacheKey: manifest.cacheKey,
    rootDirectory: manifest.rootDirectory,
    manifestHash: manifest.manifestHash,
    source: 'rebuilt',
    index,
  };
}

export async function loadOrBuildPersistentCodeSearchIndex(
  rootDirectory: string,
  options?: CodeSearchPersistenceOptions,
): Promise<CodeSearchLoadResult | null> {
  return (
    (await loadFreshCodeSearchIndexFromDb(rootDirectory, options)) ||
    (await rebuildCodeSearchIndexInDb(rootDirectory, options))
  );
}

export async function invalidatePersistedCodeSearchIndex(
  rootDirectory: string,
  options?: Pick<CodeSearchPersistenceOptions, 'cacheKey' | 'cacheNamespace'>,
): Promise<void> {
  const normalizedRoot = path.resolve(rootDirectory);
  allSupportedSourceFileCache.delete(normalizedRoot);
  exactQueryFallbackFileCache.delete(normalizedRoot);
  const cacheKey = resolveCodeSearchCacheKey(
    normalizedRoot,
    options?.cacheKey,
    options?.cacheNamespace,
  );
  await deleteCodeSearchSnapshot(cacheKey);
}
