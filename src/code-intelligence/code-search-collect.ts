import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { CodeSearchBuildOptions } from './code-search-types.js';

const FALLBACK_SOURCE_FILE_SCAN_LIMIT = 50_000;

const DIRECTORY_PRIORITY_PATTERNS: Array<{
  pattern: RegExp;
  weight: number;
}> = [
  { pattern: /src[\\/]main[\\/]scala(?:[\\/]|$)/, weight: 72 },
  { pattern: /src[\\/](main|core)[\\/](java|go|python|rust)(?:[\\/]|$)/, weight: 60 },
  { pattern: /src[\\/](main|core)(?:[\\/]|$)/, weight: 22 },
  { pattern: /src[\\/](test|tests)[\\/](java|scala|go|python|rust)(?:[\\/]|$)/, weight: 28 },
  { pattern: /src[\\/](test|tests)(?:[\\/]|$)/, weight: 12 },
  { pattern: /(?:^|[\\/])(pkg|internal|cmd|app|lib)(?:[\\/]|$)/, weight: 52 },
];

const MODULE_PRIORITY_PATTERNS: Array<{
  pattern: RegExp;
  weight: number;
}> = [
  { pattern: /^(core|server|backend|service|services|metadata|raft)(?:\/|$)/, weight: 18 },
  { pattern: /^(api|apis|app|apps|internal|pkg|lib)(?:\/|$)/, weight: 14 },
  { pattern: /^(examples?|samples?|benchmarks?|docs?|tests?)(?:\/|$)/, weight: -20 },
  { pattern: /^[^/]+\/src\/main(?:\/|$)/, weight: 10 },
];

const PATH_INTENT_PRIORITY_PATTERNS: Array<{
  pattern: RegExp;
  weight: number;
}> = [
  { pattern: /\/server(?:\/|$)/, weight: 24 },
  { pattern: /\/controller(?:\/|$)/, weight: 20 },
  { pattern: /\/metadata(?:\/|$)/, weight: 18 },
  { pattern: /\/coordinator(?:\/|$)/, weight: 16 },
  { pattern: /\/raft(?:\/|$)/, weight: 14 },
  { pattern: /\/replica(?:\/|$)/, weight: 12 },
  { pattern: /\/broker(?:\/|$)/, weight: 10 },
  { pattern: /\/network(?:\/|$)/, weight: 8 },
  { pattern: /\/admin(?:\/|$)/, weight: -10 },
  { pattern: /\/common(?:\/|$)/, weight: -4 },
  { pattern: /\/examples?(?:\/|$)/, weight: -20 },
  { pattern: /\/benchmarks?(?:\/|$)/, weight: -24 },
  { pattern: /\/generated(?:\/|$)/, weight: -18 },
  { pattern: /\/(?:test|tests)(?:\/|$)/, weight: -12 },
];

const COMMON_NAMESPACE_SEGMENTS = new Set([
  'org',
  'com',
  'io',
  'net',
  'dev',
  'src',
  'main',
  'core',
  'test',
  'tests',
  'java',
  'scala',
  'python',
  'go',
]);

const LOW_SIGNAL_PARENT_SEGMENTS = new Set([
  'impl',
  'internal',
  'internals',
  'generated',
  'common',
  'shared',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.java',
  '.scala',
  '.kt',
  '.go',
  '.rs',
  '.sql',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  'tmp',
  'temp',
]);

function resolveMaxFileSelectionLimit(options: CodeSearchBuildOptions): number {
  return options.maxFiles <= 0 ? Number.MAX_SAFE_INTEGER : options.maxFiles;
}

function normalizeGlobPattern(pattern: string): string {
  return pattern
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function compileGlobPattern(pattern: string): RegExp {
  const normalized = normalizeGlobPattern(pattern);
  const tokenized = normalized
    .replace(/\*\*/g, '::GLOBSTAR::')
    .replace(/\*/g, '::STAR::')
    .replace(/\?/g, '::QMARK::');
  const escaped = escapeRegex(tokenized)
    .replace(/::GLOBSTAR::/g, '.*')
    .replace(/::STAR::/g, '[^/]*')
    .replace(/::QMARK::/g, '[^/]');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesGlobPattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  const normalizedPattern = normalizeGlobPattern(pattern);
  if (!normalizedPattern) return false;
  const regex = compileGlobPattern(normalizedPattern);
  if (regex.test(normalizedPath)) return true;
  if (!normalizedPattern.includes('/')) {
    return normalizedPath.split('/').some((segment) => regex.test(segment));
  }
  return false;
}

export function normalizeRelativePath(
  rootDirectory: string,
  absolutePath: string,
): string {
  return path.relative(rootDirectory, absolutePath).replace(/\\/g, '/');
}

export function normalizeSelectionPath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim().replace(/\s+\d+$/, ''))
    .filter(Boolean)
    .join('/');
}

export function detectLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    case '.scala':
      return 'scala';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.sql':
      return 'sql';
    case '.json':
      return 'json';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.sh':
    case '.bash':
      return 'shell';
    default:
      return extension.replace(/^\./, '') || 'text';
  }
}

export function computeDirectoryPriority(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  let weight = 0;
  for (const entry of DIRECTORY_PRIORITY_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      weight += entry.weight;
    }
  }
  if (weight === 0) {
    const depth = normalized.split('/').length;
    weight = Math.max(1, Math.min(depth, 5));
  }
  return weight;
}

export function compareCandidateEntries(
  left: {
    relativePath: string;
    weight: number;
    normalizedPath: string;
  },
  right: {
    relativePath: string;
    weight: number;
    normalizedPath: string;
  },
): number {
  if (right.weight !== left.weight) return right.weight - left.weight;
  if (left.normalizedPath !== right.normalizedPath) {
    return left.normalizedPath.localeCompare(right.normalizedPath);
  }
  return left.relativePath.localeCompare(right.relativePath);
}

export function computeCandidatePriority(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  const language = detectLanguage(relativePath);
  return (
    computeDirectoryPriority(normalized) +
    computeSelectionModuleWeight(normalized) +
    computePathIntentPriority(normalized) +
    computeFileNamePriority(normalized) +
    computeLanguagePriority(language)
  );
}

export function computeSelectionModuleWeight(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  let weight = 0;
  for (const entry of MODULE_PRIORITY_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      weight += entry.weight;
    }
  }
  const topLevelModule = extractSelectionModuleKey(normalized);
  if (topLevelModule !== normalized) {
    weight += Math.max(4, 18 - topLevelModule.length);
  }
  return weight;
}

export function computePathIntentPriority(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  let weight = 0;
  for (const entry of PATH_INTENT_PRIORITY_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      weight += entry.weight;
    }
  }
  return weight;
}

function computeFileNamePriority(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  const extension = path.posix.extname(normalized);
  const baseName = path.posix.basename(normalized, extension);
  let weight = 0;
  if (/^[A-Z][A-Za-z0-9]+$/.test(baseName)) {
    weight += 8;
  }
  if (
    /(?:Controller|Manager|Server|Broker|Replica|Coordinator|Metadata|Apis)$/.test(
      baseName,
    )
  ) {
    weight += 8;
  }
  if (/(?:Metrics|Metric|Builder|Options|Result|Spec|Factory)$/.test(baseName)) {
    weight -= 6;
  }
  if (/package-info$/.test(baseName)) {
    weight -= 18;
  } else if (/(?:Benchmark|Benchmarks|Example|Examples)$/.test(baseName)) {
    weight -= 14;
  } else if (/(?:Test|Tests)$/.test(baseName)) {
    weight -= 8;
  }
  if (/^(?:Mock|Fake)/.test(baseName)) {
    weight -= 8;
  }
  return weight;
}

export function computeLanguagePriority(language: string): number {
  switch (language) {
    case 'scala':
      return 24;
    case 'java':
      return 22;
    case 'go':
      return 18;
    case 'python':
      return 16;
    case 'typescript':
      return 15;
    case 'javascript':
      return 13;
    case 'rust':
      return 11;
    case 'sql':
      return 8;
    case 'json':
    case 'yaml':
      return 4;
    case 'shell':
      return 3;
    default:
      return 2;
  }
}

function extractSelectionModuleKey(relativePath: string): string {
  const normalized = normalizeSelectionPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return normalized;
  if (segments[0] === 'src' && segments.length >= 3) {
    return segments.slice(0, 3).join('/');
  }
  if (
    (segments[0] === 'pkg' || segments[0] === 'internal') &&
    segments.length >= 2
  ) {
    return segments.slice(0, 2).join('/');
  }
  return segments[0];
}

function extractSelectionBucketKey(relativePath: string): string {
  const normalized = normalizeSelectionPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return normalized;
  return `${extractSelectionModuleKey(normalized)}:${extractSelectionFocusKey(segments)}`;
}

function extractSelectionFocusKey(segments: string[]): string {
  const sourceEndIndex = findSelectionSourceEndIndex(segments);
  const parentSegments = segments
    .slice(sourceEndIndex + 1, -1)
    .filter((segment) => !COMMON_NAMESPACE_SEGMENTS.has(segment));
  if (parentSegments.length === 0) {
    return segments[segments.length - 2] || '<root>';
  }
  const lastSegment = parentSegments[parentSegments.length - 1];
  if (
    LOW_SIGNAL_PARENT_SEGMENTS.has(lastSegment) &&
    parentSegments.length > 1
  ) {
    return parentSegments[parentSegments.length - 2];
  }
  return lastSegment;
}

export function findSelectionSourceEndIndex(segments: string[]): number {
  const sourceIndex = segments.indexOf('src');
  if (sourceIndex >= 0) {
    const phase = segments[sourceIndex + 1] || '';
    const scope = segments[sourceIndex + 2] || '';
    if (
      (phase === 'main' ||
        phase === 'core' ||
        phase === 'test' ||
        phase === 'tests') &&
      (scope === 'java' ||
        scope === 'scala' ||
        scope === 'python' ||
        scope === 'go' ||
        scope === 'rust' ||
        scope === 'resources')
    ) {
      return sourceIndex + 2;
    }
    if (
      phase === 'main' ||
      phase === 'core' ||
      phase === 'test' ||
      phase === 'tests'
    ) {
      return sourceIndex + 1;
    }
    return sourceIndex;
  }
  if (
    segments[0] === 'pkg' ||
    segments[0] === 'internal' ||
    segments[0] === 'cmd' ||
    segments[0] === 'app' ||
    segments[0] === 'lib'
  ) {
    return 0;
  }
  return -1;
}

function tryCollectWithRipgrep(rootDirectory: string): string[] {
  const command = spawnSync(
    'rg',
    [
      '--files',
      '--hidden',
      '-g',
      '!.git',
      '-g',
      '!node_modules',
      '-g',
      '!dist',
      '-g',
      '!build',
      '.',
    ],
    {
      cwd: rootDirectory,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (command.error || command.status !== 0 || !command.stdout) return [];
  return command.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => path.resolve(rootDirectory, line));
}

function collectWithFileSystem(
  rootDirectory: string,
  maxFiles: number,
): string[] {
  const files: string[] = [];
  const visit = (currentDirectory: string) => {
    if (files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(currentDirectory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name)) continue;
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSupportedSourceFile(absolutePath)) continue;
      files.push(absolutePath);
    }
  };

  visit(rootDirectory);
  return files;
}

function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function isSupportedSourceFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension);
}

function includesIgnoredDirectory(
  filePath: string,
  rootDirectory: string,
): boolean {
  const relativePath = path.relative(rootDirectory, filePath);
  if (!relativePath || relativePath.startsWith('..')) return false;
  const segments = relativePath.split(/[\\/]+/);
  return segments.some((segment) => shouldIgnoreDirectory(segment));
}

export function shouldIncludeFileByGlobs(
  filePath: string,
  rootDirectory: string,
  options: CodeSearchBuildOptions,
): boolean {
  const relativePath = normalizeRelativePath(rootDirectory, filePath);
  if (!relativePath || relativePath.startsWith('..')) return false;
  const includePatterns = options.includeGlobs
    .map(normalizeGlobPattern)
    .filter(Boolean);
  const excludePatterns = options.excludeGlobs
    .map(normalizeGlobPattern)
    .filter(Boolean);
  if (
    includePatterns.length > 0 &&
    !includePatterns.some((pattern) => matchesGlobPattern(relativePath, pattern))
  ) {
    return false;
  }
  if (excludePatterns.some((pattern) => matchesGlobPattern(relativePath, pattern))) {
    return false;
  }
  return true;
}

function filterCollectedFiles(
  filePaths: string[],
  rootDirectory: string,
  options: CodeSearchBuildOptions,
): string[] {
  return filePaths
    .filter((filePath) => isSupportedSourceFile(filePath))
    .filter((filePath) => !includesIgnoredDirectory(filePath, rootDirectory))
    .filter((filePath) =>
      shouldIncludeFileByGlobs(filePath, rootDirectory, options),
    );
}

function collectCandidateFiles(
  rootDirectory: string,
  options: CodeSearchBuildOptions,
): string[] {
  const rgResult = tryCollectWithRipgrep(rootDirectory);
  if (rgResult.length > 0) {
    return filterCollectedFiles(rgResult, rootDirectory, options);
  }
  return filterCollectedFiles(
    collectWithFileSystem(
      rootDirectory,
      resolveMaxFileSelectionLimit(options),
    ),
    rootDirectory,
    options,
  );
}

export function collectAllSupportedSourceFiles(rootDirectory: string): string[] {
  const rgResult = tryCollectWithRipgrep(rootDirectory);
  if (rgResult.length > 0) {
    return rgResult
      .filter((filePath) => isSupportedSourceFile(filePath))
      .filter((filePath) => !includesIgnoredDirectory(filePath, rootDirectory));
  }
  return collectWithFileSystem(rootDirectory, FALLBACK_SOURCE_FILE_SCAN_LIMIT);
}

export function listCandidateFiles(
  rootDirectory: string,
  options: CodeSearchBuildOptions,
): string[] {
  const dedupedCandidates = new Map<
    string,
    {
      absolutePath: string;
      relativePath: string;
      normalizedPath: string;
      bucketKey: string;
      weight: number;
    }
  >();

  collectCandidateFiles(rootDirectory, options)
    .map((absolutePath) => {
      const relativePath = normalizeRelativePath(rootDirectory, absolutePath);
      const normalizedPath = normalizeSelectionPath(relativePath);
      return {
        absolutePath,
        relativePath,
        normalizedPath,
        bucketKey: extractSelectionBucketKey(normalizedPath),
        weight: computeCandidatePriority(relativePath),
      };
    })
    .filter((entry) => entry.weight > 0)
    .forEach((entry) => {
      const existing = dedupedCandidates.get(entry.normalizedPath);
      if (!existing || compareCandidateEntries(entry, existing) < 0) {
        dedupedCandidates.set(entry.normalizedPath, entry);
      }
    });

  const candidates = Array.from(dedupedCandidates.values());

  const groupedCandidates = new Map<
    string,
    Array<{
      absolutePath: string;
      relativePath: string;
      normalizedPath: string;
      bucketKey: string;
      weight: number;
    }>
  >();

  candidates.forEach((entry) => {
    const items = groupedCandidates.get(entry.bucketKey) ?? [];
    items.push(entry);
    groupedCandidates.set(entry.bucketKey, items);
  });

  const groups = Array.from(groupedCandidates.entries())
    .map(([bucketKey, items]) => ({
      bucketKey,
      weight:
        Math.max(...items.map((item) => item.weight)) *
        Math.max(1, Math.sqrt(items.length)),
      items: items.sort((left, right) => compareCandidateEntries(left, right)),
      cursor: 0,
      selectedCount: 0,
    }))
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return left.bucketKey.localeCompare(right.bucketKey);
    });

  const selected: string[] = [];
  const maxFiles = resolveMaxFileSelectionLimit(options);
  while (selected.length < maxFiles) {
    let bestGroup:
      | {
          bucketKey: string;
          weight: number;
          items: Array<{
            absolutePath: string;
            relativePath: string;
            normalizedPath: string;
            bucketKey: string;
            weight: number;
          }>;
          cursor: number;
          selectedCount: number;
        }
      | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const group of groups) {
      const next = group.items[group.cursor];
      if (!next) continue;
      const allocationScore = group.weight / (group.selectedCount + 1);
      if (allocationScore > bestScore) {
        bestGroup = group;
        bestScore = allocationScore;
        continue;
      }
      if (allocationScore < bestScore || !bestGroup) continue;
      const currentBest = bestGroup.items[bestGroup.cursor];
      if (!currentBest || compareCandidateEntries(next, currentBest) < 0) {
        bestGroup = group;
      }
    }
    if (!bestGroup) break;
    selected.push(bestGroup.items[bestGroup.cursor].absolutePath);
    bestGroup.cursor += 1;
    bestGroup.selectedCount += 1;
  }

  return selected;
}
