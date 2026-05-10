import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listCandidateFiles, normalizeRelativePath } from './code-search-collect.js';
import { buildIndexedFile, resolveBuildOptions } from './code-search-index.js';
import { preloadTreeSitterGrammars } from './code-search-tree-sitter.js';
import type { CodeSearchFile } from './code-search-types.js';
import type {
  CodeMapBuildOptions,
  CodeMapEdge,
  CodeMapFile,
  CodeMapSnapshot,
  CodeMapSymbol,
} from './code-map-types.js';

const DEFAULT_CODE_MAP_OPTIONS: CodeMapBuildOptions = {
  maxFiles: 2_000,
  maxFileBytes: 256 * 1024,
  includeGlobs: [],
  excludeGlobs: [],
  pageRankIterations: 20,
  pageRankDamping: 0.85,
};

export function resolveCodeMapOptions(
  partial?: Partial<CodeMapBuildOptions>,
): CodeMapBuildOptions {
  return { ...DEFAULT_CODE_MAP_OPTIONS, ...partial };
}

// ---------------------------------------------------------------------------
// Import path resolution — language-aware
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

function resolveRelativeImportTarget(
  fromFileRelative: string,
  importPath: string,
  fileSet: Set<string>,
): string | null {
  if (!importPath.startsWith('.')) return null;

  const fromDir = path.posix.dirname(fromFileRelative);
  const resolved = path.posix.normalize(path.posix.join(fromDir, importPath));
  const cleaned = resolved.replace(/\.(js|mjs|cjs)$/, '');

  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = cleaned + ext;
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function loadTsConfigPaths(rootDirectory: string): Map<string, string> | null {
  const normalizedRoot = path.resolve(rootDirectory);
  const configNames = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];
  for (const configFile of configNames) {
    const configPath = path.join(normalizedRoot, configFile);
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw) as {
        compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string };
      };
      const paths = config?.compilerOptions?.paths;
      const baseUrlOpt = config?.compilerOptions?.baseUrl ?? '.';
      if (!paths || typeof paths !== 'object') continue;

      const configDir = path.dirname(configPath);
      const baseAbs = path.resolve(configDir, baseUrlOpt);
      let baseRel = path.relative(normalizedRoot, baseAbs).replace(/\\/g, '/');
      if (!baseRel || baseRel === '.') {
        baseRel = '';
      }

      const aliasMap = new Map<string, string>();
      for (const [alias, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const first = targets[0];
        if (typeof first !== 'string') continue;
        const cleanAlias = alias.replace(/\/\*$/, '');
        const cleanTarget = first.replace(/\/\*$/, '');
        const targetNorm = cleanTarget.replace(/\\/g, '/');
        const resolvedTarget = path.posix
          .normalize([baseRel, targetNorm].filter(Boolean).join('/'))
          .replace(/^\.\//, '');
        aliasMap.set(cleanAlias, resolvedTarget);
      }
      return aliasMap;
    } catch {
      continue;
    }
  }
  return null;
}

function loadGoModulePath(rootDirectory: string): string | null {
  const goModPath = path.join(path.resolve(rootDirectory), 'go.mod');
  try {
    const content = fs.readFileSync(goModPath, 'utf8');
    const match = content.match(/^module\s+(\S+)/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function resolveJavaImportTarget(
  importPath: string,
  fileSet: Set<string>,
  language: string,
  suffixIdx?: SuffixIndex,
): string[] {
  const extensions = language === 'scala' ? ['.scala', '.java'] : language === 'kotlin' ? ['.kt', '.java'] : ['.java'];

  if (importPath.endsWith('.*')) {
    const packagePrefix = importPath.slice(0, -2).replace(/\./g, '/');
    if (suffixIdx) {
      const matches: string[] = [];
      for (const [dir, files] of suffixIdx.byDir) {
        if (dir === packagePrefix || dir.endsWith('/' + packagePrefix)) {
          for (const f of files) {
            if (extensions.some((ext) => f.endsWith(ext))) matches.push(f);
          }
        }
      }
      return matches;
    }
    const matches: string[] = [];
    for (const file of fileSet) {
      const dir = path.posix.dirname(file);
      if (dir === packagePrefix || dir.endsWith('/' + packagePrefix)) {
        if (extensions.some((ext) => file.endsWith(ext))) matches.push(file);
      }
    }
    return matches;
  }

  const pathSuffix = importPath.replace(/\./g, '/');
  if (suffixIdx) {
    for (const ext of extensions) {
      const baseName = path.posix.basename(pathSuffix) + ext;
      const candidates = suffixIdx.bySuffix.get(baseName);
      if (!candidates) continue;
      for (const c of candidates) {
        if (c.endsWith(pathSuffix + ext)) return [c];
      }
    }
    return [];
  }
  for (const ext of extensions) {
    const suffix = pathSuffix + ext;
    for (const file of fileSet) {
      if (file.endsWith(suffix)) return [file];
    }
  }
  return [];
}

export function resolveGoImportTarget(
  importPath: string,
  fileSet: Set<string>,
  goModulePath?: string | null,
): string[] {
  const cleaned = importPath.replace(/^"/, '').replace(/"$/, '');

  if (
    goModulePath &&
    (cleaned === goModulePath || cleaned.startsWith(`${goModulePath}/`))
  ) {
    const localPath =
      cleaned === goModulePath ? '' : cleaned.slice(goModulePath.length + 1);
    if (localPath) {
      const matches: string[] = [];
      for (const file of fileSet) {
        if (!file.endsWith('.go')) continue;
        const fileDir = path.posix.dirname(file);
        if (fileDir === localPath || fileDir.endsWith('/' + localPath)) {
          matches.push(file);
        }
      }
      if (matches.length > 0) return matches;
    }
  }

  const segments = cleaned.split('/');
  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start).join('/');
    const matches: string[] = [];
    for (const file of fileSet) {
      if (!file.endsWith('.go')) continue;
      const fileDir = path.posix.dirname(file);
      if (fileDir === suffix || fileDir.endsWith('/' + suffix)) {
        matches.push(file);
      }
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

export function resolvePythonImportTarget(
  importPath: string,
  fileSet: Set<string>,
  fromFileRelative?: string,
): string[] {
  if (importPath.startsWith('.') && fromFileRelative) {
    const dots = importPath.match(/^(\.+)/)?.[1] || '.';
    const rest = importPath.slice(dots.length).replace(/^\./, '');
    let baseDir = path.posix.dirname(fromFileRelative);
    for (let i = 0; i < dots.length - 1; i++) {
      baseDir = path.posix.dirname(baseDir);
    }
    const subPath = rest ? rest.replace(/\./g, '/') : '';
    const resolved = subPath ? path.posix.join(baseDir, subPath) : baseDir;
    const candidates = [resolved + '.py', resolved + '/__init__.py'];
    for (const suffix of candidates) {
      for (const file of fileSet) {
        if (file === suffix || file.endsWith('/' + suffix)) return [file];
      }
    }
    return [];
  }

  const dotParts = importPath.split('.');
  const pathSuffix = dotParts.join('/');
  const candidates = [pathSuffix + '.py', pathSuffix + '/__init__.py'];
  for (const suffix of candidates) {
    for (const file of fileSet) {
      if (file === suffix || file.endsWith('/' + suffix)) return [file];
    }
  }
  return [];
}

export function resolveRustImportTarget(
  importPath: string,
  fileSet: Set<string>,
): string[] {
  const segments = importPath.replace(/::/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return [];
  for (let start = 0; start < segments.length; start++) {
    const suffix = segments.slice(start).join('/');
    const candidates = [suffix + '.rs', suffix + '/mod.rs'];
    for (const candidate of candidates) {
      for (const file of fileSet) {
        if (file === candidate || file.endsWith('/' + candidate)) return [file];
      }
    }
  }
  return [];
}

function resolveImportTargets(
  fromFileRelative: string,
  importPath: string,
  fileSet: Set<string>,
  language: string,
  suffixIdx?: SuffixIndex,
  tsAliasMap?: Map<string, string> | null,
  goModulePath?: string | null,
): string[] {
  switch (language) {
    case 'java':
    case 'scala':
    case 'kotlin':
      return resolveJavaImportTarget(importPath, fileSet, language, suffixIdx);
    case 'go':
      return resolveGoImportTarget(importPath, fileSet, goModulePath);
    case 'python':
      return resolvePythonImportTarget(importPath, fileSet, fromFileRelative);
    case 'rust':
      return resolveRustImportTarget(importPath, fileSet);
    default: {
      if (tsAliasMap) {
        for (const [alias, target] of tsAliasMap) {
          let remapped: string | null = null;
          if (importPath === alias) {
            remapped = target;
          } else if (importPath.startsWith(`${alias}/`)) {
            remapped = path.posix.normalize(
              path.posix.join(target, importPath.slice(alias.length + 1)),
            );
          }
          if (!remapped) continue;
          const withDot = remapped.startsWith('.')
            ? remapped
            : `./${remapped}`;
          const single = resolveRelativeImportTarget(
            fromFileRelative,
            withDot,
            fileSet,
          );
          if (single) return [single];
          const bare = remapped.replace(/^\.\//, '');
          for (const ext of RESOLVE_EXTENSIONS) {
            const candidate = bare + ext;
            if (fileSet.has(candidate)) return [candidate];
          }
        }
      }
      const single = resolveRelativeImportTarget(fromFileRelative, importPath, fileSet);
      return single ? [single] : [];
    }
  }
}

// ---------------------------------------------------------------------------
// Suffix index for O(1) import resolution
// ---------------------------------------------------------------------------

interface SuffixIndex {
  bySuffix: Map<string, string[]>;
  byDir: Map<string, string[]>;
}

function buildSuffixIndex(fileSet: Set<string>): SuffixIndex {
  const bySuffix = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();

  for (const file of fileSet) {
    const base = path.posix.basename(file);
    const arr = bySuffix.get(base) || [];
    arr.push(file);
    bySuffix.set(base, arr);

    const dir = path.posix.dirname(file);
    const dirArr = byDir.get(dir) || [];
    dirArr.push(file);
    byDir.set(dir, dirArr);
  }
  return { bySuffix, byDir };
}

// ---------------------------------------------------------------------------
// Build dependency edges from imports
// ---------------------------------------------------------------------------

function buildEdges(
  files: CodeSearchFile[],
  fileSet: Set<string>,
  rootDirectory?: string,
): CodeMapEdge[] {
  const suffixIdx = buildSuffixIndex(fileSet);
  const edgeMap = new Map<string, CodeMapEdge>();
  const tsAliasMap = rootDirectory ? loadTsConfigPaths(rootDirectory) : null;
  const goModulePath = rootDirectory ? loadGoModulePath(rootDirectory) : null;

  for (const file of files) {
    for (const imp of file.imports) {
      const targets = resolveImportTargets(
        file.relativePath,
        imp.modulePath,
        fileSet,
        file.language,
        suffixIdx,
        tsAliasMap,
        goModulePath,
      );
      for (const target of targets) {
        if (target === file.relativePath) continue;

        const key = `${file.relativePath}\0${target}`;
        const existing = edgeMap.get(key);
        if (existing) {
          if (imp.symbolName && !existing.symbols.includes(imp.symbolName)) {
            existing.symbols.push(imp.symbolName);
          }
        } else {
          edgeMap.set(key, {
            fromFile: file.relativePath,
            toFile: target,
            symbols: imp.symbolName ? [imp.symbolName] : [],
          });
        }
      }
    }
  }

  return Array.from(edgeMap.values());
}

// ---------------------------------------------------------------------------
// Simplified PageRank
// ---------------------------------------------------------------------------

function computePageRank(
  files: string[],
  edges: CodeMapEdge[],
  iterations: number,
  damping: number,
): Map<string, number> {
  const n = files.length;
  if (n === 0) return new Map();

  const rank = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const inLinks = new Map<string, string[]>();

  for (const f of files) {
    rank.set(f, 1.0 / n);
    outDegree.set(f, 0);
    inLinks.set(f, []);
  }

  for (const edge of edges) {
    if (!rank.has(edge.fromFile) || !rank.has(edge.toFile)) continue;
    outDegree.set(edge.fromFile, (outDegree.get(edge.fromFile) || 0) + 1);
    inLinks.get(edge.toFile)!.push(edge.fromFile);
  }

  const base = (1.0 - damping) / n;

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const f of files) {
      let sum = 0;
      for (const src of inLinks.get(f) || []) {
        const srcOut = outDegree.get(src) || 1;
        sum += (rank.get(src) || 0) / srcOut;
      }
      next.set(f, base + damping * sum);
    }
    for (const [k, v] of next) rank.set(k, v);
  }

  return rank;
}

function computeSymbolRank(
  file: CodeSearchFile,
  fileRank: number,
  edges: CodeMapEdge[],
): Map<string, number> {
  const symbolRank = new Map<string, number>();
  const symbolNames = new Set(file.symbols.map((s) => s.name));
  for (const name of symbolNames) {
    symbolRank.set(name, fileRank);
  }

  for (const edge of edges) {
    if (edge.toFile !== file.relativePath) continue;
    for (const sym of edge.symbols) {
      if (symbolNames.has(sym)) {
        symbolRank.set(sym, (symbolRank.get(sym) || 0) + 0.1);
      }
    }
  }
  return symbolRank;
}

// ---------------------------------------------------------------------------
// Manifest hash for incremental cache
// ---------------------------------------------------------------------------

export function computeCodeMapManifestHash(
  rootDirectory: string,
  files: Array<{ relativePath: string; byteSize: number; modifiedTimeMs: number }>,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        rootDirectory,
        files: files.map((f) => ({
          p: f.relativePath,
          s: f.byteSize,
          m: f.modifiedTimeMs,
        })),
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Public: build a code map from a directory
// ---------------------------------------------------------------------------

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const INDEX_CHUNK_SIZE = 100;

export function buildCodeMap(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeMapBuildOptions>,
): CodeMapSnapshot {
  return buildCodeMapCore(rootDirectory, repositoryId, branch, options);
}

export async function buildCodeMapAsync(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeMapBuildOptions>,
): Promise<CodeMapSnapshot> {
  await preloadTreeSitterGrammars();
  const opts = resolveCodeMapOptions(options);
  const normalizedRoot = path.resolve(rootDirectory);

  const searchOpts = resolveBuildOptions({
    maxFiles: opts.maxFiles,
    maxFileBytes: opts.maxFileBytes,
    includeGlobs: opts.includeGlobs,
    excludeGlobs: opts.excludeGlobs,
  });

  const candidatePaths = listCandidateFiles(normalizedRoot, searchOpts);

  const indexedFiles: CodeSearchFile[] = [];
  for (let i = 0; i < candidatePaths.length; i++) {
    const indexed = buildIndexedFile(normalizedRoot, candidatePaths[i], searchOpts);
    if (indexed) indexedFiles.push(indexed);
    if ((i + 1) % INDEX_CHUNK_SIZE === 0) await yieldTick();
  }

  return assembleSnapshot(normalizedRoot, repositoryId, branch, opts, candidatePaths, indexedFiles);
}

// Sync path: uses tree-sitter only if preloadTreeSitterGrammars() was
// previously awaited (e.g. via buildCodeMapAsync). Otherwise falls back to regex.
function buildCodeMapCore(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeMapBuildOptions>,
): CodeMapSnapshot {
  const opts = resolveCodeMapOptions(options);
  const normalizedRoot = path.resolve(rootDirectory);

  const searchOpts = resolveBuildOptions({
    maxFiles: opts.maxFiles,
    maxFileBytes: opts.maxFileBytes,
    includeGlobs: opts.includeGlobs,
    excludeGlobs: opts.excludeGlobs,
  });

  const candidatePaths = listCandidateFiles(normalizedRoot, searchOpts);

  const indexedFiles: CodeSearchFile[] = [];
  for (const absPath of candidatePaths) {
    const indexed = buildIndexedFile(normalizedRoot, absPath, searchOpts);
    if (indexed) indexedFiles.push(indexed);
  }

  return assembleSnapshot(normalizedRoot, repositoryId, branch, opts, candidatePaths, indexedFiles);
}

function assembleSnapshot(
  normalizedRoot: string,
  repositoryId: string,
  branch: string,
  opts: CodeMapBuildOptions,
  candidatePaths: string[],
  indexedFiles: CodeSearchFile[],
): CodeMapSnapshot {
  const fileSet = new Set(indexedFiles.map((f) => f.relativePath));
  const edges = buildEdges(indexedFiles, fileSet, normalizedRoot);
  const fileRanks = computePageRank(
    Array.from(fileSet),
    edges,
    opts.pageRankIterations,
    opts.pageRankDamping,
  );

  const mapFiles: CodeMapFile[] = indexedFiles.map((f) => {
    const rank = fileRanks.get(f.relativePath) || 0;
    const symRanks = computeSymbolRank(f, rank, edges);
    const exportCount = f.symbols.filter((s) =>
      s.signature.trimStart().startsWith('export'),
    ).length;

    const symbols: CodeMapSymbol[] = f.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      line: s.line,
      column: s.column,
      signature: s.signature,
      rank: symRanks.get(s.name) || rank,
    }));

    return {
      relativePath: f.relativePath,
      language: f.language,
      lineCount: f.lineCount,
      byteSize: f.byteSize,
      symbols,
      importCount: f.imports.length,
      exportCount,
      rank,
    };
  });

  mapFiles.sort((a, b) => b.rank - a.rank);

  const manifestEntries = candidatePaths.map((absPath) => {
    try {
      const st = fs.statSync(absPath);
      return {
        relativePath: normalizeRelativePath(normalizedRoot, absPath),
        byteSize: st.size,
        modifiedTimeMs: Math.trunc(st.mtimeMs),
      };
    } catch {
      return { relativePath: normalizeRelativePath(normalizedRoot, absPath), byteSize: 0, modifiedTimeMs: 0 };
    }
  });

  return {
    repositoryId,
    branch,
    rootDirectory: normalizedRoot,
    generatedAt: new Date().toISOString(),
    manifestHash: computeCodeMapManifestHash(normalizedRoot, manifestEntries),
    files: mapFiles,
    edges,
    stats: {
      fileCount: mapFiles.length,
      symbolCount: mapFiles.reduce((t, f) => t + f.symbols.length, 0),
      edgeCount: edges.length,
      totalLines: mapFiles.reduce((t, f) => t + f.lineCount, 0),
    },
  };
}
