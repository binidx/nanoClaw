import path from 'node:path';

import {
  allSupportedSourceFileCache,
  buildIndexedFile,
  DEFAULT_BUILD_OPTIONS,
  exactQueryFallbackFileCache,
  getFileImports,
  readFileLines,
  STOP_TERMS,
  tokenize,
} from './code-search-index.js';
import {
  collectAllSupportedSourceFiles,
  compareCandidateEntries,
  computeCandidatePriority,
  computeDirectoryPriority,
  computeLanguagePriority,
  computePathIntentPriority,
  computeSelectionModuleWeight,
  detectLanguage,
  findSelectionSourceEndIndex,
  normalizeRelativePath,
  normalizeSelectionPath,
  shouldIncludeFileByGlobs,
} from './code-search-collect.js';
import type {
  CodeSearchBuildOptions,
  CodeSearchFile,
  CodeSearchImport,
  CodeSearchIndex,
  CodeSearchQueryOptions,
  CodeReferenceHintResult,
  CodeSearchResult,
  CodeSearchSymbol,
  CodeSymbolSearchResult,
  RelatedCodeSearchResult,
} from './code-search-types.js';

interface SearchableFile {
  file: CodeSearchFile;
  termSet: Set<string>;
  symbolTermSet: Set<string>;
  pathTerms: Set<string>;
  importTermSet: Set<string>;
}

const DEFAULT_QUERY_OPTIONS: CodeSearchQueryOptions = {
  limit: 8,
};

const EXACT_QUERY_FALLBACK_FILE_LIMIT = 24;

function getExactQueryFallbackCacheBucket(
  rootDirectory: string,
): Map<string, CodeSearchFile[]> {
  const normalizedRoot = path.resolve(rootDirectory);
  const cached = exactQueryFallbackFileCache.get(normalizedRoot);
  if (cached) return cached;
  const bucket = new Map<string, CodeSearchFile[]>();
  exactQueryFallbackFileCache.set(normalizedRoot, bucket);
  return bucket;
}

function createExactQueryFallbackCacheKey(
  options: CodeSearchBuildOptions,
  normalizedQuery: string,
): string {
  return JSON.stringify({
    normalizedQuery,
    maxFileBytes: options.maxFileBytes,
    maxTermsPerFile: options.maxTermsPerFile,
    maxPreviewLines: options.maxPreviewLines,
  });
}

function shouldUseExactQueryFallback(
  query: string,
  normalizedTerms: string[],
  normalizedQuery: string,
): boolean {
  const raw = String(query || '').trim();
  if (!raw || !normalizedQuery) return false;
  if (isCamelCaseLikeQuery(raw)) return true;
  if (normalizedTerms.length > 1) return normalizedQuery.length >= 8;
  return /^[A-Z][A-Za-z0-9_]*$/.test(raw) && normalizedQuery.length >= 8;
}

function fileLikelyContainsExactQueryMatch(
  file: CodeSearchFile,
  normalizedQuery: string,
): boolean {
  return (
    fileBaseNameMatchesNormalizedQuery(file.relativePath, normalizedQuery) ||
    file.symbols.some(
      (symbol) => normalizeSymbolIdentity(symbol.name) === normalizedQuery,
    )
  );
}

function fileBaseNameMatchesNormalizedQuery(
  relativePath: string,
  normalizedQuery: string,
): boolean {
  const extension = path.posix.extname(relativePath);
  const baseName = path.posix.basename(relativePath, extension);
  return normalizeSymbolIdentity(baseName) === normalizedQuery;
}

function normalizeQueryTerms(query: string): string[] {
  return Array.from(new Set(tokenize(query))).filter(
    (term) => !STOP_TERMS.has(term),
  );
}

function normalizeSymbolIdentity(value: string): string {
  return tokenize(value).join('');
}

function isCamelCaseLikeQuery(value: string): boolean {
  const raw = String(value || '').trim();
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) &&
    /[A-Z]/.test(raw) &&
    raw !== raw.toUpperCase()
  );
}

function listAllSupportedFiles(rootDirectory: string): string[] {
  const normalizedRoot = path.resolve(rootDirectory);
  const cached = allSupportedSourceFileCache.get(normalizedRoot);
  if (cached) return cached;
  const files = collectAllSupportedSourceFiles(normalizedRoot);
  allSupportedSourceFileCache.set(normalizedRoot, files);
  return files;
}

function loadExactQueryFallbackFiles(
  index: CodeSearchIndex,
  query: string,
): CodeSearchFile[] {
  const normalizedTerms = normalizeQueryTerms(query);
  const normalizedQuery = normalizeSymbolIdentity(query);
  if (
    !shouldUseExactQueryFallback(query, normalizedTerms, normalizedQuery) ||
    index.files.some((file) =>
      fileLikelyContainsExactQueryMatch(file, normalizedQuery),
    )
  ) {
    return [];
  }

  const cacheKey = createExactQueryFallbackCacheKey(index.options, normalizedQuery);
  const cacheBucket = getExactQueryFallbackCacheBucket(index.rootDirectory);
  const cached = cacheBucket.get(cacheKey);
  if (cached) return cached;

  const existingPaths = new Set(index.files.map((file) => file.relativePath));
  const fallbackFiles = listAllSupportedFiles(index.rootDirectory)
    .map((absolutePath) => ({
      absolutePath,
      relativePath: normalizeRelativePath(index.rootDirectory, absolutePath),
    }))
    .filter(
      ({ relativePath }) =>
        !existingPaths.has(relativePath) &&
        shouldIncludeFileByGlobs(
          path.resolve(index.rootDirectory, relativePath),
          index.rootDirectory,
          index.options,
        ) &&
        fileBaseNameMatchesNormalizedQuery(relativePath, normalizedQuery),
    )
    .map(({ absolutePath, relativePath }) => ({
      absolutePath,
      relativePath,
      normalizedPath: normalizeSelectionPath(relativePath),
      weight: computeCandidatePriority(relativePath),
    }))
    .sort(compareCandidateEntries)
    .slice(0, EXACT_QUERY_FALLBACK_FILE_LIMIT)
    .map((entry) =>
      buildIndexedFile(index.rootDirectory, entry.absolutePath, index.options),
    )
    .filter((entry): entry is CodeSearchFile => entry !== null);
  cacheBucket.set(cacheKey, fallbackFiles);
  return fallbackFiles;
}

function getSearchFilesForQuery(
  index: CodeSearchIndex,
  query: string,
): CodeSearchFile[] {
  const fallbackFiles = loadExactQueryFallbackFiles(index, query);
  if (fallbackFiles.length === 0) return index.files;
  return [...index.files, ...fallbackFiles];
}

function toSearchableFile(file: CodeSearchFile): SearchableFile {
  const symbolTerms = new Set<string>();
  for (const symbol of file.symbols) {
    for (const term of tokenize(symbol.name)) {
      symbolTerms.add(term);
    }
  }
  const importTerms = new Set<string>();
  getFileImports(file).forEach((entry) => {
    tokenize(`${entry.modulePath} ${entry.symbolName}`).forEach((term) => {
      importTerms.add(term);
    });
  });
  return {
    file,
    termSet: new Set(file.terms),
    symbolTermSet: symbolTerms,
    pathTerms: new Set(tokenize(file.relativePath)),
    importTermSet: importTerms,
  };
}

function scoreFile(
  entry: SearchableFile,
  queryTerms: string[],
): CodeSearchResult | null {
  let score = 0;
  const matchedTerms: string[] = [];
  const matchedSymbols: CodeSearchResult['matchedSymbols'] = [];
  const matchedImports: CodeSearchResult['matchedImports'] = [];

  for (const queryTerm of queryTerms) {
    if (entry.pathTerms.has(queryTerm)) {
      score += 6;
      matchedTerms.push(queryTerm);
      continue;
    }
    if (entry.symbolTermSet.has(queryTerm)) {
      score += 8;
      matchedTerms.push(queryTerm);
      continue;
    }
    if (entry.importTermSet.has(queryTerm)) {
      score += 5;
      matchedTerms.push(queryTerm);
      continue;
    }
    if (entry.termSet.has(queryTerm)) {
      score += 3;
      matchedTerms.push(queryTerm);
    }
  }

  for (const symbol of entry.file.symbols) {
    const symbolTerms = tokenize(symbol.name);
    if (queryTerms.every((term) => symbolTerms.includes(term))) {
      matchedSymbols.push({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
      });
      score += 12;
    }
  }

  for (const importEntry of getFileImports(entry.file)) {
    const importTerms = tokenize(
      `${importEntry.modulePath} ${importEntry.symbolName}`,
    );
    if (!queryTerms.every((term) => importTerms.includes(term))) continue;
    matchedImports.push({
      modulePath: importEntry.modulePath,
      symbolName: importEntry.symbolName,
      line: importEntry.line,
    });
    score += 10;
  }

  score += computeSearchFileQualityBonus(entry.file.relativePath);

  if (score <= 0) return null;

  return {
    relativePath: entry.file.relativePath,
    language: entry.file.language,
    score,
    matchedTerms: Array.from(new Set(matchedTerms)).sort(),
    matchedSymbols: matchedSymbols.slice(0, 4),
    matchedImports: matchedImports.slice(0, 4),
    previews: buildPreviewLines(entry.file, queryTerms),
  };
}

function buildPreviewLines(
  file: CodeSearchFile,
  queryTerms: string[],
): string[] {
  const previews = new Set<string>();
  const fileLines = readFileLines(file.absolutePath);
  for (const symbol of file.symbols) {
    const symbolTerms = tokenize(symbol.name);
    if (!queryTerms.some((term) => symbolTerms.includes(term))) continue;
    previews.add(buildContextPreview(fileLines, symbol.line - 1));
  }
  for (const entry of getFileImports(file)) {
    const importTerms = tokenize(`${entry.modulePath} ${entry.symbolName}`);
    if (!queryTerms.some((term) => importTerms.includes(term))) continue;
    previews.add(
      buildContextPreview(fileLines, entry.line - 1) ||
        `${entry.line}: ${entry.signature}`,
    );
  }
  for (const preview of file.previews) {
    if (
      previews.size >= DEFAULT_BUILD_OPTIONS.maxPreviewLines ||
      !queryTerms.some((term) => preview.toLowerCase().includes(term))
    ) {
      continue;
    }
    previews.add(preview);
  }
  if (previews.size === 0) {
    file.previews
      .slice(0, DEFAULT_BUILD_OPTIONS.maxPreviewLines)
      .forEach((preview) => previews.add(preview));
  }
  return Array.from(previews).slice(0, DEFAULT_BUILD_OPTIONS.maxPreviewLines);
}

function buildContextPreview(
  lines: string[],
  targetIndex: number,
  radius = 1,
): string {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const safeIndex = Math.max(0, Math.min(targetIndex, lines.length - 1));
  const start = Math.max(0, safeIndex - radius);
  const end = Math.min(lines.length - 1, safeIndex + radius);
  const snippet: string[] = [];
  for (let index = start; index <= end; index += 1) {
    snippet.push(`${index + 1}: ${lines[index]?.trimEnd() ?? ''}`);
  }
  return snippet.join('\n').trim();
}

function symbolTokensMatchNormalized(
  symbolName: string,
  normalizedTerms: string[],
): boolean {
  const tokens = tokenize(symbolName);
  if (tokens.length === 0 || tokens.length !== normalizedTerms.length) return false;
  return normalizedTerms.every((term, index) => term === tokens[index]);
}

function computeSymbolSpecificityAdjustment(
  symbolName: string,
  normalizedTerms: string[],
  normalizedQuery: string,
  camelCaseLikeQuery: boolean,
): number {
  if (!normalizedQuery) return 0;
  const normalizedSymbolName = normalizeSymbolIdentity(symbolName);
  if (!normalizedSymbolName || normalizedSymbolName === normalizedQuery) {
    return 0;
  }

  let score = 0;
  if (normalizedSymbolName.startsWith(normalizedQuery)) {
    score += 6;
  }
  if (
    normalizedTerms.length > 1 &&
    startsWithTermSequence(tokenize(symbolName), normalizedTerms)
  ) {
    score += 4;
  }
  if (camelCaseLikeQuery && !normalizedSymbolName.includes(normalizedQuery)) {
    score -= 18;
  }
  return score;
}

function startsWithTermSequence(tokens: string[], normalizedTerms: string[]): boolean {
  if (normalizedTerms.length === 0 || tokens.length < normalizedTerms.length) {
    return false;
  }
  return normalizedTerms.every((term, index) => tokens[index] === term);
}

function computeSearchFileQualityBonus(relativePath: string): number {
  const normalized = normalizeSelectionPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const language = detectLanguage(relativePath);
  let score = 0;

  score += Math.round((computeDirectoryPriority(normalized) - 1) / 10);
  score += Math.round(computeSelectionModuleWeight(normalized) / 10);
  score += Math.round(computePathIntentPriority(normalized) / 8);
  score += Math.round(computeLanguagePriority(language) / 12);

  if (findSelectionSourceEndIndex(segments) >= 0) {
    score += 1;
  }
  if (segments.includes('test') || segments.includes('tests')) {
    score -= 4;
  }
  if (
    segments.some((segment) =>
      /^(examples?|samples?|benchmarks?|docs?)$/.test(segment),
    )
  ) {
    score -= 6;
  }

  return Math.max(-10, Math.min(18, score));
}

function computeReferenceContextAdjustment(input: {
  matchedBy: CodeReferenceHintResult['matchedBy'];
  rawQuery: string;
  normalizedTerms: string[];
  definesExactSymbol: boolean;
  line: string;
}): number {
  const normalizedLine = input.line.trim();
  let score = 0;
  const commentLine = looksLikeCommentLine(normalizedLine);
  const importLine = looksLikeImportLine(normalizedLine);
  const executableMatch =
    input.matchedBy === 'constructor' ||
    input.matchedBy === 'invocation' ||
    input.matchedBy === 'member_access';

  if (input.matchedBy === 'constructor') {
    score += 16;
  } else if (input.matchedBy === 'invocation') {
    score += 14;
  } else if (input.matchedBy === 'member_access') {
    score += 11;
  } else if (input.matchedBy === 'import') {
    score -= 8;
  } else if (input.matchedBy === 'static_import') {
    score -= 14;
  } else if (input.matchedBy === 'package') {
    score -= 3;
  } else if (input.matchedBy === 'comment') {
    score -= 8;
  } else if (input.matchedBy === 'content') {
    score -= 2;
  }

  if (input.definesExactSymbol) {
    if (
      input.matchedBy === 'import' ||
      input.matchedBy === 'static_import' ||
      input.matchedBy === 'package'
    ) {
      score -= 12;
    } else if (executableMatch) {
      score -= 14;
    } else if (
      input.matchedBy === 'content' ||
      input.matchedBy === 'path' ||
      input.matchedBy === 'comment'
    ) {
      score -= 6;
    }
  } else if (executableMatch) {
    score += 4;
  }

  if (looksLikeDefinitionLine(normalizedLine, input.rawQuery)) {
    score -= input.definesExactSymbol ? 10 : 4;
  }

  if (importLine) {
    score -= 4;
  }

  if (commentLine) {
    score -= executableMatch ? 18 : 10;
  } else if (
    executableMatch &&
    looksLikeExecutableUsageLine(normalizedLine, input.rawQuery)
  ) {
    score += 8;
  }

  if (
    input.normalizedTerms.length === 1 &&
    normalizedLine.length <= 48 &&
    !normalizedLine.includes('(')
  ) {
    score -= 2;
  }

  return score;
}

function computeExactQueryLineSpecificityAdjustment(input: {
  rawQuery: string;
  camelCaseLikeQuery: boolean;
  matchedBy: CodeReferenceHintResult['matchedBy'];
  definesExactSymbol: boolean;
  line: string;
}): number {
  if (
    !input.camelCaseLikeQuery ||
    input.definesExactSymbol ||
    lineContainsExactQueryToken(input.line, input.rawQuery)
  ) {
    return 0;
  }
  if (input.matchedBy === 'import') return -10;
  if (input.matchedBy === 'static_import') return -8;
  if (
    input.matchedBy === 'package' ||
    input.matchedBy === 'path' ||
    input.matchedBy === 'content' ||
    input.matchedBy === 'comment'
  ) {
    return -12;
  }
  return 0;
}

function trimmedPreview(value: string): string {
  return String(value || '').trim();
}

function lineContainsExactQueryToken(value: string, rawQuery: string): boolean {
  if (!value || !rawQuery) return false;
  return new RegExp(`\\b${escapeForRegExp(rawQuery)}\\b`).test(value);
}

function looksLikeImportLine(value: string): boolean {
  return /^(?:import|from|use|require)\b/i.test(value);
}

function looksLikeStaticImportLine(value: string): boolean {
  return /^\s*import\s+static\b/i.test(value);
}

function looksLikeCommentLine(value: string): boolean {
  return /^(?:\/\/|\/\*|\*|#|--|<!--)/.test(value) || /\*\/\s*$/.test(value);
}

function looksLikeExecutableUsageLine(value: string, rawQuery: string): boolean {
  if (!value || !rawQuery) return false;
  const escaped = escapeForRegExp(rawQuery);
  const patterns = [
    new RegExp(`\\bnew\\s+${escaped}\\b`, 'i'),
    new RegExp(`\\b${escaped}\\s*\\(`, 'i'),
    new RegExp(`\\.${escaped}\\s*\\(`, 'i'),
    new RegExp(`\\b${escaped}\\b\\s*[=,)]`, 'i'),
    new RegExp(`\\breturn\\s+.*\\b${escaped}\\b`, 'i'),
  ];
  return (
    patterns.some((pattern) => pattern.test(value)) ||
    /[;{}]/.test(value)
  );
}

function detectExecutableReferenceMatch(
  trimmed: string,
  rawQuery: string,
):
  | {
      matchedBy: Extract<
        CodeReferenceHintResult['matchedBy'],
        'constructor' | 'invocation' | 'member_access'
      >;
      score: number;
    }
  | null {
  if (!trimmed || !rawQuery) return null;
  if (looksLikeExecutableDefinitionLine(trimmed, rawQuery)) return null;
  if (looksLikeStringLiteralOnlyMention(trimmed, rawQuery)) return null;
  const executableSource = stripStringLiteralContent(trimmed);
  const escaped = escapeForRegExp(rawQuery);
  const patterns: Array<{
    matchedBy: 'constructor' | 'invocation' | 'member_access';
    regex: RegExp;
    score: number;
  }> = [
    {
      matchedBy: 'constructor',
      regex: new RegExp(`\\bnew\\s+${escaped}\\b`, 'i'),
      score: 12,
    },
    {
      matchedBy: 'invocation',
      regex: new RegExp(`\\.${escaped}\\s*\\(`, 'i'),
      score: 10,
    },
    {
      matchedBy: 'invocation',
      regex: new RegExp(`\\b${escaped}\\s*\\(`, 'i'),
      score: 9,
    },
    {
      matchedBy: 'member_access',
      regex: new RegExp(`\\b${escaped}\\b\\s*\\.`, 'i'),
      score: 7,
    },
  ];
  for (const pattern of patterns) {
    if (pattern.regex.test(executableSource)) {
      return {
        matchedBy: pattern.matchedBy,
        score: pattern.score,
      };
    }
  }
  return null;
}

function looksLikeExecutableDefinitionLine(
  value: string,
  rawQuery: string,
): boolean {
  if (!value || !rawQuery) return false;
  const escaped = escapeForRegExp(rawQuery);
  const patterns = [
    new RegExp(
      `^(?:public|private|protected|internal|final|sealed|abstract|static|synchronized|native|inline|override|open|data|case|suspend|async|\\s)+\\s*${escaped}\\s*\\(`,
      'i',
    ),
    new RegExp(`^(?:def|func(?:tion)?|fun)\\s+${escaped}\\s*\\(`, 'i'),
    new RegExp(`^(?:class|interface|enum|trait|object|type|struct)\\s+${escaped}\\b`, 'i'),
    new RegExp(`^${escaped}\\s*\\([^)]*\\)\\s*(?:\\{|,|throws\\b|$)`, 'i'),
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function looksLikeStringLiteralOnlyMention(
  value: string,
  rawQuery: string,
): boolean {
  if (!value || !rawQuery) return false;
  const escaped = escapeForRegExp(rawQuery);
  const executableSource = stripStringLiteralContent(value);
  if (
    new RegExp(`["'\`][^"'\`]*\\b${escaped}\\b[^"'\`]*["'\`]`, 'i').test(value) &&
    !new RegExp(`\\bnew\\s+${escaped}\\b`, 'i').test(executableSource) &&
    !new RegExp(`\\.${escaped}\\s*\\(`, 'i').test(executableSource) &&
    !new RegExp(`\\b${escaped}\\s*\\(`, 'i').test(executableSource)
  ) {
    return true;
  }
  return false;
}

function stripStringLiteralContent(value: string): string {
  if (!value) return value;
  return value.replace(
    /(["'`])(?:\\.|(?!\1)[^\\])*\1/g,
    '""',
  );
}

function looksLikeDefinitionLine(value: string, rawQuery: string): boolean {
  if (!value || !rawQuery) return false;
  const escaped = escapeForRegExp(rawQuery);
  return new RegExp(
    `\\b(?:class|interface|enum|trait|object|type|struct|func(?:tion)?|def)\\s+${escaped}\\b`,
    'i',
  ).test(value);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreImportMatch(
  entry: CodeSearchImport,
  normalizedTerms: string[],
  normalizedQuery: string,
  camelCaseLikeQuery: boolean,
  moduleSegments: string[],
  filePathSegments: string[],
): number {
  let score = 22 + normalizedTerms.length * 3;
  if (moduleSegments.length > 0) {
    const moduleMatchCount = normalizedTerms.filter((term) =>
      moduleSegments.includes(term),
    ).length;
    score += moduleMatchCount * 2;
  }

  const sharedSegments = countSharedSegments(moduleSegments, filePathSegments);
  score += sharedSegments * 2;

  const pathTermMatchCount = countTermSegmentMatches(
    filePathSegments,
    normalizedTerms,
  );
  score += pathTermMatchCount * 2;

  if (entry.symbolName) {
    const symbolNormalized = entry.symbolName.toLowerCase();
    if (normalizedTerms.every((term) => symbolNormalized.includes(term))) {
      score += 4;
    } else if (normalizedTerms.some((term) => symbolNormalized.includes(term))) {
      score += 2;
    }
    score += computeImportSymbolSpecificityAdjustment(
      entry.symbolName,
      normalizedQuery,
      camelCaseLikeQuery,
    );
  }

  return score;
}

function computeImportSymbolSpecificityAdjustment(
  symbolName: string,
  normalizedQuery: string,
  camelCaseLikeQuery: boolean,
): number {
  if (!symbolName || !normalizedQuery) return 0;
  const normalizedSymbolName = normalizeSymbolIdentity(symbolName);
  if (!normalizedSymbolName) return 0;
  if (normalizedSymbolName === normalizedQuery) return 12;
  if (camelCaseLikeQuery) {
    if (normalizedSymbolName.includes(normalizedQuery)) {
      return -14;
    }
    return -10;
  }
  return 0;
}

function extractModuleSegments(value: string): string[] {
  return value
    .split(/[\\/\\.]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
}

function toNormalizedPathSegments(value: string): string[] {
  return value
    .split(/[\\/]+/)
    .flatMap((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, ' ')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
}

function countSharedSegments(source: string[], target: string[]): number {
  const targetSet = new Set(target);
  return source.filter((segment) => targetSet.has(segment)).length;
}

function detectCallPattern(trimmed: string, rawQuery: string): number {
  if (!rawQuery) return 0;
  const escaped = escapeForRegExp(rawQuery);
  const patterns = [
    { regex: new RegExp(`\\b${escaped}\\s*\\(`, 'i'), score: 10 },
    { regex: new RegExp(`\\.${escaped}\\s*\\(`, 'i'), score: 8 },
    { regex: new RegExp(`\\bnew\\s+${escaped}\\b`, 'i'), score: 6 },
    { regex: new RegExp(`\\b${escaped}\\s*\\.`, 'i'), score: 5 },
  ];
  for (const pattern of patterns) {
    if (pattern.regex.test(trimmed)) {
      return pattern.score;
    }
  }
  return 0;
}

function countTermSegmentMatches(
  segments: string[],
  terms: string[],
): number {
  return terms.filter((term) => hasTermInSegments(term, segments)).length;
}

function hasTermInSegments(term: string, segments: string[]): boolean {
  return segments.some((segment) => matchesSegment(term, segment));
}

function matchesSegment(term: string, segment: string): boolean {
  if (!term || !segment) return false;
  if (segment === term || segment === `${term}s` || term === `${segment}s`) {
    return true;
  }
  return segment.startsWith(term) || term.startsWith(segment);
}

function scoreSymbolSearchResult(
  file: CodeSearchFile,
  symbol: CodeSearchSymbol,
  normalizedTerms: string[],
  normalizedQuery: string,
  camelCaseLikeQuery: boolean,
): CodeSymbolSearchResult | null {
  const pathTerms = new Set(tokenize(file.relativePath));
  const contentTerms = new Set(file.terms);
  const symbolTerms = new Set(tokenize(symbol.name));
  const matchedTerms = normalizedTerms.filter((term) => symbolTerms.has(term));
  if (matchedTerms.length === 0) return null;

  let score = matchedTerms.length * 10;
  let matchedBy: CodeSymbolSearchResult['matchedBy'] = 'symbol';
  const normalizedSymbolName = normalizeSymbolIdentity(symbol.name);
  if (normalizedQuery && normalizedSymbolName === normalizedQuery) {
    score += 80;
  } else if (
    normalizedQuery &&
    normalizedSymbolName.includes(normalizedQuery)
  ) {
    score += 18;
  }
  score += computeSymbolSpecificityAdjustment(
    symbol.name,
    normalizedTerms,
    normalizedQuery,
    camelCaseLikeQuery,
  );
  if (normalizedTerms.every((term) => symbolTerms.has(term))) {
    score += 16;
  }
  if (
    camelCaseLikeQuery &&
    symbol.kind === 'package' &&
    normalizedSymbolName !== normalizedQuery
  ) {
    score -= 24;
  }
  if (normalizedTerms.some((term) => pathTerms.has(term))) {
    score += 4;
    matchedBy = matchedBy === 'symbol' ? 'hybrid' : matchedBy;
  }
  if (normalizedTerms.some((term) => contentTerms.has(term))) {
    score += 2;
    matchedBy = matchedBy === 'symbol' ? 'hybrid' : matchedBy;
  }
  if (symbolTokensMatchNormalized(symbol.name, normalizedTerms)) {
    score += 24;
    matchedBy = 'symbol';
  }
  if (symbol.kind === 'package') {
    score -= 12;
  }
  score += computeSearchFileQualityBonus(file.relativePath);
  if (score <= 0) return null;

  const fileLines = readFileLines(file.absolutePath);
  return {
    relativePath: file.relativePath,
    language: file.language,
    score,
    matchedBy,
    symbol: {
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      column: symbol.column,
      signature: symbol.signature,
    },
    previews: [
      buildContextPreview(fileLines, symbol.line - 1),
      ...file.previews,
    ].filter(Boolean).slice(0, DEFAULT_BUILD_OPTIONS.maxPreviewLines),
  };
}

export function searchCodeIndex(
  index: CodeSearchIndex,
  query: string,
  options?: Partial<CodeSearchQueryOptions>,
): CodeSearchResult[] {
  const effectiveOptions: CodeSearchQueryOptions = {
    ...DEFAULT_QUERY_OPTIONS,
    ...options,
  };
  const normalizedTerms = normalizeQueryTerms(query);
  if (normalizedTerms.length === 0) return [];

  const searchableFiles = getSearchFilesForQuery(index, query).map(
    toSearchableFile,
  );
  const results = searchableFiles
    .map((entry) => scoreFile(entry, normalizedTerms))
    .filter(
      (
        entry,
      ): entry is CodeSearchResult & {
        score: number;
      } => entry !== null,
    )
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.relativePath.localeCompare(right.relativePath);
    });

  return results.slice(0, effectiveOptions.limit);
}

export function searchCodeSymbols(
  index: CodeSearchIndex,
  query: string,
  options?: Partial<CodeSearchQueryOptions>,
): CodeSymbolSearchResult[] {
  const effectiveOptions: CodeSearchQueryOptions = {
    ...DEFAULT_QUERY_OPTIONS,
    ...options,
  };
  const normalizedTerms = normalizeQueryTerms(query);
  if (normalizedTerms.length === 0) return [];
  const normalizedQuery = normalizeSymbolIdentity(query);
  const camelCaseLikeQuery = isCamelCaseLikeQuery(query);

  const results: CodeSymbolSearchResult[] = [];
  for (const file of getSearchFilesForQuery(index, query)) {
    for (const symbol of file.symbols) {
      const scored = scoreSymbolSearchResult(
        file,
        symbol,
        normalizedTerms,
        normalizedQuery,
        camelCaseLikeQuery,
      );
      if (scored) results.push(scored);
    }
  }

  return results
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.relativePath !== right.relativePath) {
        return left.relativePath.localeCompare(right.relativePath);
      }
      return left.symbol.line - right.symbol.line;
    })
    .slice(0, effectiveOptions.limit);
}

export function searchCodeReferenceHints(
  index: CodeSearchIndex,
  query: string,
  options?: Partial<CodeSearchQueryOptions>,
): CodeReferenceHintResult[] {
  const effectiveOptions: CodeSearchQueryOptions = {
    ...DEFAULT_QUERY_OPTIONS,
    ...options,
  };
  const normalizedTerms = normalizeQueryTerms(query);
  const rawQuery = String(query || '').trim();
  const normalizedQuery = normalizeSymbolIdentity(query);
  const camelCaseLikeQuery = isCamelCaseLikeQuery(query);
  if (!rawQuery || normalizedTerms.length === 0) return [];

  const results: CodeReferenceHintResult[] = [];
  const seen = new Set<string>();

  for (const file of getSearchFilesForQuery(index, query)) {
    const filePathSegments = toNormalizedPathSegments(file.relativePath);
    const directorySegments = filePathSegments.slice(0, -1);
    const pathTerms = new Set(tokenize(file.relativePath));
    const lines = readFileLines(file.absolutePath);
    const definesExactSymbol =
      normalizedQuery.length > 0 &&
      file.symbols.some(
        (symbol) => normalizeSymbolIdentity(symbol.name) === normalizedQuery,
      );
    const fileImports = getFileImports(file);
    for (const entry of fileImports) {
      const normalizedModuleSegments = extractModuleSegments(entry.modulePath);
      const importTokens = tokenize(`${entry.modulePath} ${entry.symbolName}`);
      const normalizedSymbolName = entry.symbolName.toLowerCase();
      if (
        !normalizedTerms.every((term) =>
          normalizedModuleSegments.includes(term),
        ) &&
        !normalizedTerms.every((term) => importTokens.includes(term)) &&
        !normalizedTerms.every((term) =>
          normalizedSymbolName.includes(term),
        )
      ) {
        continue;
      }
      const key = `${file.relativePath}:${entry.line}:import:${entry.symbolName}:${entry.modulePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const importScore = scoreImportMatch(
        entry,
        normalizedTerms,
        normalizedQuery,
        camelCaseLikeQuery,
        normalizedModuleSegments,
        filePathSegments,
      );
      const rankingScore =
        importScore +
        computeSearchFileQualityBonus(file.relativePath) +
        computeReferenceContextAdjustment({
          matchedBy: looksLikeStaticImportLine(lines[entry.line - 1] || '')
            ? 'static_import'
            : 'import',
          rawQuery,
          normalizedTerms,
          definesExactSymbol,
          line: lines[entry.line - 1]?.trim() || '',
        }) +
        computeExactQueryLineSpecificityAdjustment({
          rawQuery,
          camelCaseLikeQuery,
          matchedBy: looksLikeStaticImportLine(lines[entry.line - 1] || '')
            ? 'static_import'
            : 'import',
          definesExactSymbol,
          line: lines[entry.line - 1]?.trim() || '',
        });
      if (rankingScore <= 0) continue;
      const matchedBy = looksLikeStaticImportLine(lines[entry.line - 1] || '')
        ? 'static_import'
        : 'import';
      results.push({
        relativePath: file.relativePath,
        language: file.language,
        score: rankingScore,
        matchedBy,
        symbol: rawQuery,
        line: entry.line,
        preview:
          buildContextPreview(lines, entry.line - 1) ||
            `${entry.line}: ${entry.signature}`,
      });
    }

    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (looksLikeImportLine(trimmed)) return;
      const lowered = trimmed.toLowerCase();
      const lineTerms = new Set(tokenize(trimmed));
      if (
        normalizedTerms.length === 1 &&
        !lowered.includes(rawQuery.toLowerCase()) &&
        !lineTerms.has(normalizedTerms[0]!)
      ) {
        return;
      }
      if (
        normalizedTerms.length > 1 &&
        !normalizedTerms.every((term) => lineTerms.has(term))
      ) {
        return;
      }

      const commentLine = looksLikeCommentLine(trimmed);
      let matchedBy: CodeReferenceHintResult['matchedBy'] = commentLine
        ? 'comment'
        : 'content';
      let score = 5 + normalizedTerms.length * 2;
      const executableMatch = detectExecutableReferenceMatch(trimmed, rawQuery);
      if (!commentLine && executableMatch) {
        matchedBy = executableMatch.matchedBy;
        score += executableMatch.score;
      } else {
        const packageMatch = countTermSegmentMatches(directorySegments, normalizedTerms);
        if (packageMatch > 0) {
          matchedBy = 'package';
          score += packageMatch * 3;
        }
        if (normalizedTerms.some((term) => hasTermInSegments(term, filePathSegments))) {
          if (matchedBy !== 'package') {
            matchedBy = 'path';
          }
          score += 2;
        }
      }
      score += computeSearchFileQualityBonus(file.relativePath);
      score += computeReferenceContextAdjustment({
        matchedBy,
        rawQuery,
        normalizedTerms,
        definesExactSymbol,
        line: trimmed,
      });
      score += computeExactQueryLineSpecificityAdjustment({
        rawQuery,
        camelCaseLikeQuery,
        matchedBy,
        definesExactSymbol,
        line: trimmed,
      });
      if (score <= 0) return;

      const key = `${file.relativePath}:${lineIndex + 1}:${matchedBy}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        relativePath: file.relativePath,
        language: file.language,
        score,
        matchedBy,
        symbol: rawQuery,
        line: lineIndex + 1,
        preview:
          buildContextPreview(lines, lineIndex) ||
          `${lineIndex + 1}: ${trimmed}`,
      });
    });
  }

  const sorted = results
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.relativePath !== right.relativePath) {
        return left.relativePath.localeCompare(right.relativePath);
      }
      return left.line - right.line;
    });

  const deduped: CodeReferenceHintResult[] = [];
  const emitted = new Set<string>();
  for (const entry of sorted) {
    const key = `${entry.relativePath}:${entry.line}:${entry.matchedBy}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    deduped.push(entry);
    if (deduped.length >= effectiveOptions.limit) break;
  }
  return deduped;
}

export function searchRelatedCode(
  index: CodeSearchIndex,
  query: string,
  options?: Partial<CodeSearchQueryOptions>,
): RelatedCodeSearchResult[] {
  const effectiveOptions: CodeSearchQueryOptions = {
    ...DEFAULT_QUERY_OPTIONS,
    ...options,
  };
  const fileResults = searchCodeIndex(index, query, {
    limit: effectiveOptions.limit,
  });
  const symbolResults = searchCodeSymbols(index, query, {
    limit: effectiveOptions.limit,
  });
  const referenceResults = searchCodeReferenceHints(index, query, {
    limit: effectiveOptions.limit,
  });

  return [
    ...fileResults.map((entry) => ({
      kind: 'file' as const,
      relativePath: entry.relativePath,
      language: entry.language,
      score: entry.score,
      matchedBy: 'hybrid',
      title: entry.relativePath,
      line: entry.matchedSymbols[0]?.line || 1,
      preview: entry.previews[0] || entry.relativePath,
    })),
    ...symbolResults.map((entry) => ({
      kind: 'symbol' as const,
      relativePath: entry.relativePath,
      language: entry.language,
      score: entry.score + 4,
      matchedBy: entry.matchedBy,
      title: `${entry.symbol.kind} ${entry.symbol.name}`,
      line: entry.symbol.line,
      preview: entry.previews[0] || entry.symbol.signature,
    })),
    ...referenceResults.map((entry) => ({
      kind: 'reference' as const,
      relativePath: entry.relativePath,
      language: entry.language,
      score: entry.score,
      matchedBy: entry.matchedBy,
      title: entry.symbol,
      line: entry.line,
      preview: entry.preview,
    })),
  ]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.relativePath !== right.relativePath) {
        return left.relativePath.localeCompare(right.relativePath);
      }
      return left.line - right.line;
    })
    .slice(0, effectiveOptions.limit);
}
