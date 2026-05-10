import fs from 'fs';
import path from 'path';

import {
  notifyMemoryIndexedFile,
  saveMemoryFileViaApi,
  searchIndexedMemory,
  searchUserMemoryViaApi,
  saveUserMemoryViaApi,
  touchUserMemoryRecallViaApi,
} from './internal-memory-api.js';

export type MemoryScope = 'group' | 'global' | 'all';

export interface MemoryFileRef {
  scope: Exclude<MemoryScope, 'all'>;
  relPath: string;
  pathRef: string;
  absolutePath: string;
}

export interface MemorySearchResult {
  path: string;
  scope: Exclude<MemoryScope, 'all'>;
  lineStart: number;
  lineEnd: number;
  score: number;
  snippet: string;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
}

export interface MemorySearchResponse {
  query: string;
  resultCount: number;
  results: MemorySearchResult[];
  renderedText: string;
}

export interface MemoryReadResult {
  path: string;
  scope: Exclude<MemoryScope, 'all'>;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface MemorySaveResult {
  path: string;
  scope: Exclude<MemoryScope, 'all'>;
  lineStart: number;
  lineEnd: number;
  appendedText: string;
}

export interface MemorySearchFollowupMetadata {
  searchQuery: string;
  searchRank: number;
  searchMatchedAt: string;
  searchResultCount: number;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
}

export type MemoryWriteMode = 'disabled' | 'daily-only';

export interface MemoryRuntimeConfig {
  enabled: boolean;
  readEnabled: boolean;
  writeMode: MemoryWriteMode;
  globalWriteEnabled: boolean;
  searchScopeDefault: MemoryScope;
  searchMaxResults: number;
  promptInjectionEnabled: boolean;
}

const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '/workspace/group';
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '/workspace/global';
const MAX_SEARCH_RESULTS = 8;
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_READ_LINES = 40;
const RECENT_MEMORY_SEARCH_TTL_MS = 10 * 60 * 1000;
const RECENT_MEMORY_SEARCH_LIMIT = 64;

interface RecentMemorySearchHit {
  path: string;
  lineStart: number;
  lineEnd: number;
  query: string;
  rank: number;
  resultCount: number;
  matchedAt: string;
  matchedAtMs: number;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
}

const recentMemorySearchHits: RecentMemorySearchHit[] = [];

function readEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

function pruneRecentMemorySearchHits(nowMs = Date.now()): void {
  for (let index = recentMemorySearchHits.length - 1; index >= 0; index -= 1) {
    if (
      nowMs - recentMemorySearchHits[index].matchedAtMs >
      RECENT_MEMORY_SEARCH_TTL_MS
    ) {
      recentMemorySearchHits.splice(index, 1);
    }
  }
  if (recentMemorySearchHits.length > RECENT_MEMORY_SEARCH_LIMIT) {
    recentMemorySearchHits.splice(
      0,
      recentMemorySearchHits.length - RECENT_MEMORY_SEARCH_LIMIT,
    );
  }
}

function rememberRecentMemorySearchHits(
  query: string,
  results: MemorySearchResult[],
): void {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery || results.length === 0) {
    pruneRecentMemorySearchHits();
    return;
  }
  const matchedAtDate = new Date();
  const matchedAt = matchedAtDate.toISOString();
  const matchedAtMs = matchedAtDate.getTime();
  pruneRecentMemorySearchHits(matchedAtMs);
  for (const [index, result] of results.entries()) {
    recentMemorySearchHits.push({
      path: result.path,
      lineStart: result.lineStart,
      lineEnd: result.lineEnd,
      query: normalizedQuery,
      rank: index + 1,
      resultCount: results.length,
      matchedAt,
      matchedAtMs,
      sourceType: result.sourceType || null,
      memoryClass: result.memoryClass || null,
      ownerType: result.ownerType || null,
      ownerId: result.ownerId || null,
    });
  }
  pruneRecentMemorySearchHits(matchedAtMs);
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function getRecentMemorySearchFollowup(input: {
  path: string;
  lineStart: number;
  lineEnd: number;
}): MemorySearchFollowupMetadata | null {
  const normalizedPath = String(input.path || '').trim();
  if (!normalizedPath) return null;
  pruneRecentMemorySearchHits();
  const candidates = recentMemorySearchHits
    .filter((entry) => entry.path === normalizedPath)
    .sort((left, right) => {
      if (right.matchedAtMs !== left.matchedAtMs) {
        return right.matchedAtMs - left.matchedAtMs;
      }
      return left.rank - right.rank;
    });
  if (candidates.length === 0) return null;
  const candidate =
    candidates.find((entry) =>
      rangesOverlap(
        entry.lineStart,
        entry.lineEnd,
        input.lineStart,
        input.lineEnd,
      ),
    ) || candidates[0];
  return {
    searchQuery: candidate.query,
    searchRank: candidate.rank,
    searchMatchedAt: candidate.matchedAt,
    searchResultCount: candidate.resultCount,
    sourceType: candidate.sourceType || null,
    memoryClass: candidate.memoryClass || null,
    ownerType: candidate.ownerType || null,
    ownerId: candidate.ownerId || null,
  };
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = readEnv(name).toLowerCase();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return defaultValue;
}

function parseIntegerEnv(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = readEnv(name);
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function parseMemoryScope(
  raw: string,
  defaultValue: MemoryScope,
): MemoryScope {
  const normalized = String(raw || '').trim().toLowerCase();
  if (
    normalized === 'group' ||
    normalized === 'global' ||
    normalized === 'all'
  ) {
    return normalized;
  }
  return defaultValue;
}

function parseMemoryWriteMode(raw: string): MemoryWriteMode {
  const normalized = String(raw || '').trim().toLowerCase();
  if (
    normalized === 'disabled' ||
    normalized === 'disable' ||
    normalized === 'off' ||
    normalized === 'none' ||
    normalized === 'read-only' ||
    normalized === 'readonly'
  ) {
    return 'disabled';
  }
  return 'daily-only';
}

export function getMemoryRuntimeConfig(): MemoryRuntimeConfig {
  const enabled = parseBooleanEnv('MEMORY_ENABLED', true);
  const readEnabled =
    enabled && parseBooleanEnv('MEMORY_READ_ENABLED', true);
  const writeMode = enabled
    ? parseMemoryWriteMode(readEnv('MEMORY_WRITE_MODE'))
    : 'disabled';
  const globalWriteEnabled =
    enabled &&
    writeMode !== 'disabled' &&
    parseBooleanEnv('MEMORY_GLOBAL_WRITE_ENABLED', false);

  return {
    enabled,
    readEnabled,
    writeMode,
    globalWriteEnabled,
    searchScopeDefault: parseMemoryScope(
      readEnv('MEMORY_SEARCH_SCOPE_DEFAULT'),
      'group',
    ),
    searchMaxResults: parseIntegerEnv(
      'MEMORY_SEARCH_MAX_RESULTS',
      DEFAULT_SEARCH_RESULTS,
      1,
      MAX_SEARCH_RESULTS,
    ),
    promptInjectionEnabled:
      enabled &&
      parseBooleanEnv('MEMORY_PROMPT_INJECTION_ENABLED', true),
  };
}

export function isMemoryReadAvailable(
  config = getMemoryRuntimeConfig(),
): boolean {
  return config.enabled && config.readEnabled;
}

export function isMemoryWriteAvailable(
  config = getMemoryRuntimeConfig(),
): boolean {
  return config.enabled && config.writeMode !== 'disabled';
}

export function isMemoryGlobalWriteAllowed(
  config = getMemoryRuntimeConfig(),
): boolean {
  return isMemoryWriteAvailable(config) && config.globalWriteEnabled;
}

export function getMemoryReadDisabledMessage(): string {
  const config = getMemoryRuntimeConfig();
  if (!config.enabled) {
    return 'Memory is disabled by configuration.';
  }
  return 'Memory read tools are disabled by configuration.';
}

export function getMemoryWriteDisabledMessage(
  scope: Exclude<MemoryScope, 'all'> = 'group',
): string {
  const config = getMemoryRuntimeConfig();
  if (!config.enabled) {
    return 'Memory is disabled by configuration.';
  }
  if (!isMemoryWriteAvailable(config)) {
    return 'Memory writes are disabled by configuration.';
  }
  if (scope === 'global' && !config.globalWriteEnabled) {
    return 'Global memory writes are disabled by configuration.';
  }
  return '';
}

export function buildMemoryPromptGuidance(options?: {
  markdown?: boolean;
}): string {
  const config = getMemoryRuntimeConfig();
  if (!config.promptInjectionEnabled || !config.enabled) return '';

  const markdown = options?.markdown === true;
  const toolRef = (name: string) => (markdown ? `\`${name}\`` : name);
  const pathRef = (value: string) => (markdown ? `\`${value}\`` : value);
  const lines: string[] = [];

  if (isMemoryReadAvailable(config)) {
    lines.push(
      `Before answering questions about prior work, decisions, dates, preferences, or todos, use ${toolRef('memory_search')}, then ${toolRef('memory_get')} for the exact lines you need.`,
    );
    lines.push(
      `Memory path refs use explicit scopes like ${pathRef('group:MEMORY.md')} or ${pathRef('global:memory/YYYY-MM-DD.md')}.`,
    );
    if (config.searchScopeDefault !== 'all') {
      lines.push(
        `Default memory search scope is ${config.searchScopeDefault}.`,
      );
    }
  }

  if (isMemoryWriteAvailable(config)) {
    const scopeNote = config.globalWriteEnabled
      ? 'Global writes remain more restricted and still require the main session.'
      : 'Global writes stay disabled unless explicitly enabled by configuration.';
    lines.push(
      `Use ${toolRef('memory_save')} only for durable notes worth keeping; it appends to today's daily memory file. ${scopeNote}`,
    );
  }

  return lines.join('\n');
}

export function collectForwardedMemoryEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith('MEMORY_') && typeof entry[1] === 'string',
    ),
  );
}

function normalizeRelativePath(input: string): string {
  return String(input || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isAllowedMemoryRelativePath(relPath: string): boolean {
  if (!relPath || relPath.includes('..')) return false;
  if (relPath === 'MEMORY.md') return true;
  return /^memory\/.+\.md$/i.test(relPath);
}

function getScopeRoot(scope: Exclude<MemoryScope, 'all'>): string {
  return scope === 'group' ? GROUP_DIR : GLOBAL_DIR;
}

function resolveScopeRoots(scope: MemoryScope): Array<Exclude<MemoryScope, 'all'>> {
  if (scope === 'all') return ['group', 'global'];
  return [scope];
}

function buildPathRef(scope: Exclude<MemoryScope, 'all'>, relPath: string): string {
  return `${scope}:${relPath}`;
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function enumerateMarkdownFiles(dirPath: string, baseDir: string, out: string[]): void {
  if (!fs.existsSync(dirPath)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      enumerateMarkdownFiles(absolutePath, baseDir, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const relPath = toPortablePath(path.relative(baseDir, absolutePath));
    if (isAllowedMemoryRelativePath(relPath)) {
      out.push(relPath);
    }
  }
}

export function listMemoryFiles(scope: MemoryScope = 'all'): MemoryFileRef[] {
  const results: MemoryFileRef[] = [];
  for (const scopeName of resolveScopeRoots(scope)) {
    const rootDir = getScopeRoot(scopeName);
    if (!rootDir || !fs.existsSync(rootDir)) continue;

    const relPaths: string[] = [];
    const memoryMdPath = path.join(rootDir, 'MEMORY.md');
    if (fs.existsSync(memoryMdPath)) {
      relPaths.push('MEMORY.md');
    }
    enumerateMarkdownFiles(path.join(rootDir, 'memory'), rootDir, relPaths);

    const seen = new Set<string>();
    for (const relPath of relPaths) {
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      results.push({
        scope: scopeName,
        relPath,
        pathRef: buildPathRef(scopeName, relPath),
        absolutePath: path.join(rootDir, ...relPath.split('/')),
      });
    }
  }
  return results;
}

export function resolveMemoryPathRef(pathRef: string): MemoryFileRef {
  const raw = String(pathRef || '').trim();
  const colonIndex = raw.indexOf(':');
  const scopeRaw = colonIndex >= 0 ? raw.slice(0, colonIndex).trim().toLowerCase() : 'group';
  const relRaw = colonIndex >= 0 ? raw.slice(colonIndex + 1) : raw;
  if (scopeRaw !== 'group' && scopeRaw !== 'global') {
    throw new Error(`Invalid memory scope: ${scopeRaw || '(empty)'}`);
  }
  const relPath = normalizeRelativePath(relRaw);
  if (!isAllowedMemoryRelativePath(relPath)) {
    throw new Error(`Memory path is not allowed: ${raw}`);
  }
  const absolutePath = path.join(getScopeRoot(scopeRaw), ...relPath.split('/'));
  return {
    scope: scopeRaw,
    relPath,
    pathRef: buildPathRef(scopeRaw, relPath),
    absolutePath,
  };
}

function formatNumberedLines(lines: string[], startLine: number): string {
  return lines
    .map((line, index) => `${String(startLine + index).padStart(6)}|${line}`)
    .join('\n');
}

function resolveLocalDateParts(date = new Date()): {
  dateStamp: string;
  timeStamp: string;
} {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return {
    dateStamp: `${year}-${month}-${day}`,
    timeStamp: `${hours}:${minutes}`,
  };
}

function tokenizeQuery(query: string): { phrase: string; tokens: string[] } {
  const phrase = String(query || '').trim().toLowerCase();
  if (!phrase) return { phrase: '', tokens: [] };
  const roughTokens = phrase
    .split(/[\s,.;:!?()[\]{}"'`~|/\\<>@#$%^&*+=-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokens = [...new Set(roughTokens.filter((token) => token.length >= 2))];
  if (tokens.length === 0) {
    tokens.push(phrase);
  } else if (!tokens.includes(phrase) && phrase.length <= 80) {
    tokens.unshift(phrase);
  }
  return { phrase, tokens };
}

function countOccurrences(text: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const nextIndex = text.indexOf(token, fromIndex);
    if (nextIndex === -1) break;
    count += 1;
    fromIndex = nextIndex + token.length;
  }
  return count;
}

function scoreLine(text: string, phrase: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (phrase) {
    score += countOccurrences(lower, phrase) * Math.max(4, Math.min(10, phrase.length));
  }
  for (const token of tokens) {
    if (!token || token === phrase) continue;
    score += countOccurrences(lower, token) * Math.max(1, Math.min(6, token.length));
  }
  return score;
}

export function searchMemory(
  query: string,
  options?: { scope?: MemoryScope; maxResults?: number },
): MemorySearchResult[] {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) return [];
  const { phrase, tokens } = tokenizeQuery(trimmedQuery);
  const runtimeConfig = getMemoryRuntimeConfig();
  const maxResults = Math.max(
    1,
    Math.min(
      options?.maxResults ?? runtimeConfig.searchMaxResults,
      MAX_SEARCH_RESULTS,
    ),
  );
  const hits: MemorySearchResult[] = [];

  for (const file of listMemoryFiles(options?.scope ?? runtimeConfig.searchScopeDefault)) {
    if (!fs.existsSync(file.absolutePath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(file.absolutePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const windows = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const lineScore = scoreLine(lines[index] || '', phrase, tokens);
      if (lineScore <= 0) continue;
      const lineStart = Math.max(1, index);
      const lineEnd = Math.min(lines.length, index + 3);
      const key = `${file.pathRef}:${lineStart}:${lineEnd}`;
      if (windows.has(key)) continue;
      windows.add(key);
      const excerpt = lines.slice(lineStart - 1, lineEnd);
      hits.push({
        path: file.pathRef,
        scope: file.scope,
        lineStart,
        lineEnd,
        score: lineScore,
        snippet: formatNumberedLines(excerpt, lineStart),
      });
    }
  }

  return hits
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.lineStart - b.lineStart;
    })
    .slice(0, maxResults);
}

export async function searchMemoryRuntime(
  query: string,
  options?: { scope?: MemoryScope; maxResults?: number },
): Promise<MemorySearchResult[]> {
  // Try per-user DB memory first
  const userResults = await searchUserMemoryViaApi(query, {
    scope: options?.scope === 'all' ? undefined : options?.scope,
    maxResults: options?.maxResults,
  });
  if (userResults !== null && userResults.length > 0) {
    const mapped: MemorySearchResult[] = userResults.map((m) => ({
      path: `user:memory/${m.id}`,
      scope: 'group' as const,
      lineStart: 1,
      lineEnd: 1,
      score: m.importance / 10,
      snippet: `[${m.category}] ${m.content}`,
    }));
    for (const m of userResults) {
      touchUserMemoryRecallViaApi(m.id).catch(() => {});
    }
    rememberRecentMemorySearchHits(query, mapped);
    return mapped;
  }

  // Fallback to indexed file-based search
  const indexedResults = await searchIndexedMemory({
    query,
    scope: options?.scope,
    maxResults: options?.maxResults,
  });
  if (indexedResults !== null) {
    rememberRecentMemorySearchHits(query, indexedResults);
    return indexedResults;
  }
  const fallbackResults = searchMemory(query, options);
  rememberRecentMemorySearchHits(query, fallbackResults);
  return fallbackResults;
}

function renderMemorySearchResponse(response: {
  query: string;
  results: MemorySearchResult[];
}): string {
  const trimmedQuery = String(response.query || '').trim();
  if (response.results.length === 0) {
    return `No memory matches found for "${trimmedQuery}".`;
  }
  return [
    `Memory matches for "${trimmedQuery}":`,
    ...response.results.map(
      (result, index) =>
        [
          `${index + 1}. ${result.path}#L${result.lineStart}-L${result.lineEnd} (score=${result.score})`,
          result.snippet,
        ].join('\n'),
    ),
  ].join('\n\n');
}

export function buildMemorySearchResponse(
  query: string,
  results: MemorySearchResult[],
): MemorySearchResponse {
  const normalizedResults = [...results];
  return {
    query: String(query || '').trim(),
    resultCount: normalizedResults.length,
    results: normalizedResults,
    renderedText: renderMemorySearchResponse({
      query,
      results: normalizedResults,
    }),
  };
}

export function formatMemorySearchResults(
  query: string,
  results: MemorySearchResult[],
): string {
  return buildMemorySearchResponse(query, results).renderedText;
}

export function readMemoryFile(
  pathRef: string,
  options?: { from?: number; lines?: number },
): MemoryReadResult {
  const resolved = resolveMemoryPathRef(pathRef);
  if (!fs.existsSync(resolved.absolutePath)) {
    throw new Error(`Memory file not found: ${resolved.pathRef}`);
  }
  const content = fs.readFileSync(resolved.absolutePath, 'utf-8');
  const allLines = content.split(/\r?\n/);
  const startLine = Math.max(1, Math.floor(options?.from ?? 1));
  const maxLines = Math.max(1, Math.min(Math.floor(options?.lines ?? DEFAULT_READ_LINES), 400));
  const endLine = Math.min(allLines.length, startLine + maxLines - 1);
  const slice = allLines.slice(startLine - 1, endLine);
  return {
    path: resolved.pathRef,
    scope: resolved.scope,
    lineStart: startLine,
    lineEnd: endLine,
    text: formatNumberedLines(slice, startLine),
  };
}

export function saveMemoryNote(
  note: string,
  options?: { scope?: Exclude<MemoryScope, 'all'>; now?: Date },
): MemorySaveResult {
  const content = String(note || '').trim();
  if (!content) {
    throw new Error('Memory note cannot be empty.');
  }
  const scope = options?.scope ?? 'group';
  if (scope !== 'group' && scope !== 'global') {
    throw new Error(`Invalid memory scope: ${String(scope)}`);
  }

  // Try per-user DB save first (non-blocking, best-effort)
  const userIdEnv = String(process.env.NANOCLAW_USER_ID || '').trim();
  if (userIdEnv) {
    saveUserMemoryViaApi(content, {
      scope: scope === 'global' ? 'global' : 'conversation',
    }).catch(() => {});
  }

  const disabledMessage = getMemoryWriteDisabledMessage(scope);
  if (disabledMessage) {
    throw new Error(disabledMessage);
  }
  if (scope === 'global' && process.env.NANOCLAW_IS_MAIN !== '1') {
    throw new Error('Global memory writes are only allowed in the main session.');
  }

  const rootDir = getScopeRoot(scope);
  const { dateStamp, timeStamp } = resolveLocalDateParts(options?.now);
  const relPath = `memory/${dateStamp}.md`;
  const absolutePath = path.join(rootDir, 'memory', `${dateStamp}.md`);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const existed = fs.existsSync(absolutePath);
  const previousContent = existed ? fs.readFileSync(absolutePath, 'utf-8') : '';
  const previousLines = previousContent ? previousContent.split(/\r?\n/) : [];
  const lineStart = previousLines.length > 0 ? previousLines.length + 1 : 1;
  const header = `# Daily Memory ${dateStamp}`;
  const block = `- ${timeStamp} ${content}`;
  const appendedText = existed
    ? `\n${block}\n`
    : `${header}\n\n${block}\n`;
  fs.appendFileSync(absolutePath, appendedText, 'utf-8');

  const pathRef = buildPathRef(scope, relPath);
  const fullContent = fs.readFileSync(absolutePath, 'utf-8');
  saveMemoryFileViaApi(fullContent, { scope, pathRef }).then((saved) => {
    if (!saved) void notifyMemoryIndexedFile({ path: pathRef });
  }).catch(() => {
    void notifyMemoryIndexedFile({ path: pathRef });
  });

  const appendedLines = appendedText
    .replace(/\r/g, '')
    .split('\n')
    .filter((_, index, array) => !(index === array.length - 1 && array[index] === ''));
  return {
    path: pathRef,
    scope,
    lineStart,
    lineEnd: lineStart + Math.max(0, appendedLines.length - 1),
    appendedText: formatNumberedLines(appendedLines, lineStart),
  };
}
