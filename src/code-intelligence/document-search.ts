import fs from 'node:fs';
import path from 'node:path';

export interface ProjectDocumentSearchOptions {
  includeGlobs?: string[];
  excludeGlobs?: string[];
  limit?: number;
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface ProjectDocumentSearchResult {
  relativePath: string;
  title: string;
  score: number;
  matchedTerms: string[];
  preview: string;
}

export interface ProjectDocumentFileRef {
  absolutePath: string;
  relativePath: string;
}

const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_FILES = 200;

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGlobPattern(pattern: string): string {
  return String(pattern || '')
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
  if (normalizedPattern.startsWith('**/')) {
    const fallbackPattern = normalizedPattern.slice(3);
    if (fallbackPattern && compileGlobPattern(fallbackPattern).test(normalizedPath)) {
      return true;
    }
  }
  if (!normalizedPattern.includes('/')) {
    return normalizedPath.split('/').some((segment) => regex.test(segment));
  }
  return false;
}

function normalizeRelativePath(rootDirectory: string, absolutePath: string): string {
  return path.relative(rootDirectory, absolutePath).replace(/\\/g, '/');
}

function isSupportedDocument(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function shouldIncludePath(
  relativePath: string,
  options: Required<Pick<ProjectDocumentSearchOptions, 'includeGlobs' | 'excludeGlobs'>>,
): boolean {
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

function collectDocumentFiles(
  rootDirectory: string,
  options: ProjectDocumentSearchOptions,
): string[] {
  const files: string[] = [];
  const maxFiles = Math.max(1, options.maxFiles || DEFAULT_MAX_FILES);
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
      if (entry.name.startsWith('.git')) continue;
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !isSupportedDocument(absolutePath)) continue;
      const relativePath = normalizeRelativePath(rootDirectory, absolutePath);
      if (
        shouldIncludePath(relativePath, {
          includeGlobs: options.includeGlobs || [],
          excludeGlobs: options.excludeGlobs || [],
        })
      ) {
        files.push(absolutePath);
      }
    }
  };
  visit(rootDirectory);
  return files;
}

export function listProjectDocumentFiles(
  rootDirectory: string,
  options?: ProjectDocumentSearchOptions,
): ProjectDocumentFileRef[] {
  const normalizedRoot = path.resolve(rootDirectory);
  if (!normalizedRoot || !fs.existsSync(normalizedRoot)) return [];
  return collectDocumentFiles(normalizedRoot, options || {}).map((absolutePath) => ({
    absolutePath,
    relativePath: normalizeRelativePath(normalizedRoot, absolutePath),
  }));
}

function extractQueryTerms(query: string): string[] {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) return [];
  return Array.from(
    new Set(normalized.match(/[\p{L}\p{N}_-]+/gu) || []),
  ).filter(Boolean);
}

function buildPreview(lines: string[], queryTerms: string[]): string {
  if (lines.length === 0) return '';
  const hit = lines.find((line) => {
    const normalized = line.toLowerCase();
    return queryTerms.some((term) => normalized.includes(term));
  });
  return normalizeWhitespace(hit || lines[0] || '').slice(0, 240);
}

function scoreDocument(
  relativePath: string,
  body: string,
  query: string,
  queryTerms: string[],
): { score: number; matchedTerms: string[] } {
  const pathText = relativePath.toLowerCase();
  const bodyText = body.toLowerCase();
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  const matchedTerms = queryTerms.filter(
    (term) => pathText.includes(term) || bodyText.includes(term),
  );
  let score = matchedTerms.length * 4;
  if (normalizedQuery && pathText.includes(normalizedQuery)) score += 8;
  if (normalizedQuery && bodyText.includes(normalizedQuery)) score += 5;
  if (relativePath.toLowerCase().endsWith('/readme.md')) score += 1;
  return { score, matchedTerms };
}

export function searchProjectDocuments(
  rootDirectory: string,
  query: string,
  options?: ProjectDocumentSearchOptions,
): ProjectDocumentSearchResult[] {
  const normalizedRoot = path.resolve(rootDirectory);
  if (!normalizedRoot || !fs.existsSync(normalizedRoot)) return [];
  const queryTerms = extractQueryTerms(query);
  if (queryTerms.length === 0) return [];
  const maxFileBytes = Math.max(1, options?.maxFileBytes || DEFAULT_MAX_FILE_BYTES);
  const results: ProjectDocumentSearchResult[] = [];
  for (const absolutePath of collectDocumentFiles(normalizedRoot, options || {})) {
    let content = '';
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile() || stat.size > maxFileBytes) continue;
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const relativePath = normalizeRelativePath(normalizedRoot, absolutePath);
    const lines = content.split(/\r?\n/);
    const scored = scoreDocument(relativePath, content, query, queryTerms);
    if (scored.score <= 0 || scored.matchedTerms.length === 0) continue;
    results.push({
      relativePath,
      title: path.basename(relativePath),
      score: scored.score,
      matchedTerms: scored.matchedTerms,
      preview: buildPreview(lines, queryTerms),
    });
  }
  return results
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.relativePath.localeCompare(right.relativePath);
    })
    .slice(0, Math.max(1, options?.limit || 6));
}
