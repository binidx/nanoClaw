import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveEmbeddingProvider } from '../embedding/resolve.js';
import { batchEmbedAndStore } from '../embedding/vector-store.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import {
  buildCodeMap,
  buildCodeMapAsync,
  computeCodeMapManifestHash,
} from './code-map-builder.js';
import type { CodeMapSnapshot } from './code-map-types.js';
import {
  buildIndexedFile,
  getFileImports,
  readFileLines,
  resolveBuildOptions,
} from './code-search-index.js';
import type { CodeSearchFile, CodeSearchSymbol } from './code-search-types.js';
import { loadCodeIndexSnapshot } from '../db/code-index-db.js';
import {
  listCandidateFiles,
  normalizeRelativePath,
} from './code-search-collect.js';
import {
  preloadTreeSitterGrammars,
  type TsJsFunctionGraph,
  type TsJsFunctionGraphNode,
} from './code-search-tree-sitter.js';
import { estimateTokens } from '../knowledge/chunker.js';
import type {
  CodeIndexChunkRecord,
  CodeIndexFileRecord,
  CodeIndexFunctionEdgeRecord,
  CodeIndexFunctionRecord,
  CodeIndexProgress,
  CodeIndexSnapshot,
  CodeIndexSnapshotMeta,
  CodeIndexStage,
  CodeIndexStats,
} from './code-index-types.js';
import { t } from '../i18n/index.js';

export interface CodeIndexBuildOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  embedChunks?: boolean;
  summarizeWithAi?: boolean;
  summaryConcurrency?: number;
  generateSummaryText?: (prompt: string) => Promise<string>;
  onSnapshot?: (snapshot: CodeIndexSnapshot) => void | Promise<void>;
  onCodeMapSnapshot?: (snapshot: CodeMapSnapshot) => void | Promise<void>;
  onProgress?: (
    progress: Omit<CodeIndexProgress, 'repositoryId' | 'branch'>,
  ) => void | Promise<void>;
  sourceInfo?: {
    sourceKind?: CodeIndexSnapshotMeta['sourceKind'];
    sourceBranch?: string;
    sourceHeadSha?: string;
  };
  codeMapSnapshot?: CodeMapSnapshot | null;
}

interface BuildContext {
  indexedFiles: CodeSearchFile[];
  mapSnapshot: CodeMapSnapshot;
}

const DEFAULT_CHUNK_TARGET_LINES = 80;
const MAX_CHUNK_LINES = 140;
const CHUNK_LINE_OVERLAP = 12;
const CALLABLE_KINDS = new Set(['function', 'method']);
const CALL_NAME_SKIP = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'new',
  'super',
  'console',
  'await',
]);

function shortHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function buildSnapshotId(repositoryId: string, branch: string): string {
  return `cis_${shortHash(`${repositoryId}\0${branch}`)}`;
}

function buildFunctionId(
  repositoryId: string,
  branch: string,
  manifestHash: string,
  filePath: string,
  localId: string,
): string {
  return `cif_${shortHash(
    `${repositoryId}\0${branch}\0${manifestHash}\0${filePath}\0${localId}`,
  )}`;
}

function buildChunkId(
  repositoryId: string,
  branch: string,
  manifestHash: string,
  filePath: string,
  startLine: number,
  endLine: number,
  contentHash: string,
): string {
  return `cic_${shortHash(
    `${repositoryId}\0${branch}\0${manifestHash}\0${filePath}\0${startLine}\0${endLine}\0${contentHash}`,
  )}`;
}

function chunkEmbeddingOwnerId(
  chunk: Pick<CodeIndexChunkRecord, 'contentHash'>,
): string {
  return chunk.contentHash;
}

function chunkEmbeddingText(
  chunk: Pick<CodeIndexChunkRecord, 'content'>,
): string {
  return chunk.content.trim();
}

function countChar(text: string, char: string): number {
  return [...text].filter((item) => item === char).length;
}

function estimateFunctionEndLine(
  lines: string[],
  startLine: number,
  _nextStartLine: number,
  signature: string,
): number {
  const hardLimit = lines.length;
  let depth = 0;
  let seenBrace = false;
  for (let lineIndex = startLine - 1; lineIndex < hardLimit; lineIndex += 1) {
    const line = lines[lineIndex] || '';
    const openCount = countChar(line, '{');
    const closeCount = countChar(line, '}');
    if (openCount > 0) seenBrace = true;
    if (seenBrace) {
      depth += openCount;
      depth -= closeCount;
      if (depth <= 0 && openCount > 0) return lineIndex + 1;
      if (depth === 0 && closeCount > 0) return lineIndex + 1;
    }
  }
  if (/=>/.test(signature) && !/{/.test(signature)) return startLine;
  return hardLimit;
}

function attachParentFunctions(
  nodes: TsJsFunctionGraphNode[],
): TsJsFunctionGraphNode[] {
  const sorted = [...nodes].sort((left, right) => {
    if (left.startLine !== right.startLine)
      return left.startLine - right.startLine;
    return right.endLine - left.endLine;
  });
  const stack: TsJsFunctionGraphNode[] = [];
  for (const node of sorted) {
    while (
      stack.length > 0 &&
      (stack[stack.length - 1]?.endLine || 0) < node.startLine
    ) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    node.parentLocalId = parent ? parent.localId : null;
    stack.push(node);
  }
  return sorted;
}

function buildTsJsHeuristicGraph(file: CodeSearchFile): TsJsFunctionGraph {
  const lines = readFileLines(file.absolutePath);
  const callableSymbols = [...file.symbols]
    .filter(callableFromSymbol)
    .sort((left, right) => left.line - right.line);

  const functions = attachParentFunctions(
    callableSymbols.map((symbol, index) => {
      const next = callableSymbols[index + 1];
      const endLine = estimateFunctionEndLine(
        lines,
        symbol.line,
        next?.line ?? lines.length + 1,
        symbol.signature,
      );
      return {
        localId: `${symbol.name}:${symbol.line}:${symbol.column}`,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        column: symbol.column,
        signature: symbol.signature,
        startLine: symbol.line,
        endLine,
        parentLocalId: null,
      };
    }),
  );

  const calls: TsJsFunctionGraph['calls'] = [];
  for (const fn of functions) {
    for (
      let lineNumber = fn.startLine;
      lineNumber <= fn.endLine;
      lineNumber += 1
    ) {
      const line = lines[lineNumber - 1] || '';
      for (const match of line.matchAll(
        /\b(this|super|[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g,
      )) {
        const qualifier = match[1] || null;
        const calleeName = match[2] || '';
        if (!calleeName) continue;
        calls.push({
          fromLocalId: fn.localId,
          calleeName,
          qualifier,
          line: lineNumber,
        });
      }
      for (const match of line.matchAll(
        /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g,
      )) {
        const calleeName = match[2] || '';
        if (!calleeName || CALL_NAME_SKIP.has(calleeName)) continue;
        calls.push({
          fromLocalId: fn.localId,
          calleeName,
          qualifier: null,
          line: lineNumber,
        });
      }
    }
  }

  return { functions, calls };
}

function getTsJsFunctionGraph(file: CodeSearchFile): TsJsFunctionGraph {
  return buildTsJsHeuristicGraph(file);
}

function callableFromSymbol(symbol: CodeSearchSymbol): boolean {
  if (CALLABLE_KINDS.has(symbol.kind)) return true;
  if (symbol.kind !== 'const' && symbol.kind !== 'variable') return false;
  return looksCallableSignature(symbol.signature);
}

function looksCallableSignature(signature: string): boolean {
  const text = signature.trim();
  return (
    /\bfunction\b/.test(text) ||
    /=>/.test(text) ||
    /\w+\s*\([^)]*\)\s*\{?/.test(text)
  );
}

function sliceLines(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  return lines
    .slice(startLine - 1, endLine)
    .join('\n')
    .trim();
}

function buildFileSummary(file: CodeSearchFile, rank: number): string {
  const topSymbols = file.symbols.slice(0, 5).map((symbol) => symbol.name);
  const imports = getFileImports(file);
  const parts = [
    t(
      'prompts.fileSymbolSummary',
      { filePath: file.relativePath, count: file.symbols.length },
      undefined,
    ),
    topSymbols.length > 0
      ? t('prompts.coreSymbols', { symbols: topSymbols.join('、') }, undefined)
      : t('prompts.auto_6da495', {}, undefined),
    imports.length > 0
      ? t('prompts.importCount', { count: imports.length }, undefined)
      : t('prompts.auto_88d3e4', {}, undefined),
    t('prompts.structWeight', { weight: rank.toFixed(4) }, undefined),
  ];
  return parts.join('；') + '。';
}

function buildChunkSummary(
  file: CodeSearchFile,
  startLine: number,
  endLine: number,
): string {
  const relatedSymbols = file.symbols
    .filter((symbol) => symbol.line >= startLine && symbol.line <= endLine)
    .slice(0, 4)
    .map((symbol) => symbol.name);
  if (relatedSymbols.length > 0) {
    return t(
      'prompts.chunkSummaryWithSymbols',
      {
        filePath: file.relativePath,
        startLine,
        endLine,
        symbols: relatedSymbols.join('、'),
      },
      undefined,
    );
  }
  return t(
    'prompts.chunkSummaryGeneric',
    { filePath: file.relativePath, startLine, endLine },
    undefined,
  );
}

interface FileSummaryBundle {
  fileSummary: string;
  chunkSummaries: Map<number, string>;
}

function truncateSnippet(text: string, maxChars = 420): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}...`;
}

function buildFileSummaryPrompt(
  file: CodeSearchFile,
  chunks: CodeIndexChunkRecord[],
): string {
  const topSymbols = file.symbols
    .slice(0, 10)
    .map((symbol) => `${symbol.kind} ${symbol.name} @L${symbol.line}`);
  const chunkBlock = chunks
    .map((chunk) =>
      [
        `<chunk index="${chunk.chunkIndex}" start_line="${chunk.startLine}" end_line="${chunk.endLine}">`,
        truncateSnippet(chunk.content),
        '</chunk>',
      ].join('\n'),
    )
    .join('\n');

  return [
    t('prompts.auto_d18627', {}, undefined),
    'JSON schema:',
    '{"file_summary":"string","chunk_summaries":[{"chunk_index":number,"summary":"string"}]}',
    '',
    t('prompts.fileLabel', { filePath: file.relativePath }, undefined),
    t('prompts.languageLabel', { language: file.language }, undefined),
    `符号: ${topSymbols.join(', ') || t('errors.auto_d81bb2', {}, undefined)}`,
    '',
    chunkBlock,
    '',
    t('prompts.auto_df6ebe', {}, undefined),
    t('prompts.auto_84ae9f', {}, undefined),
    t('prompts.auto_2bdccd', {}, undefined),
    t('prompts.auto_5b5979', {}, undefined),
  ].join('\n');
}

function parseFileSummaryBundle(
  raw: string,
  file: CodeSearchFile,
  chunks: CodeIndexChunkRecord[],
): FileSummaryBundle | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as {
      file_summary?: unknown;
      chunk_summaries?: Array<{ chunk_index?: unknown; summary?: unknown }>;
    };
    const fileSummary =
      typeof parsed.file_summary === 'string' ? parsed.file_summary.trim() : '';
    const chunkSummaries = new Map<number, string>();
    for (const item of parsed.chunk_summaries || []) {
      const index =
        typeof item.chunk_index === 'number'
          ? item.chunk_index
          : Number(item.chunk_index);
      const summary =
        typeof item.summary === 'string' ? item.summary.trim() : '';
      if (Number.isInteger(index) && summary) {
        chunkSummaries.set(index, summary);
      }
    }
    if (!fileSummary && chunkSummaries.size === 0) return null;
    return {
      fileSummary: fileSummary || buildFileSummary(file, 0),
      chunkSummaries,
    };
  } catch {
    return null;
  }
}

function buildChunkRangesForFile(
  file: CodeSearchFile,
  lines: string[],
): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  const orderedSymbols = [...file.symbols]
    .filter((symbol) => symbol.line >= 1 && symbol.line <= lines.length)
    .sort((left, right) => left.line - right.line);

  if (orderedSymbols.length === 0) {
    return splitRange(1, lines.length);
  }

  const firstSymbolLine = orderedSymbols[0]?.line ?? 1;
  if (firstSymbolLine > 1) {
    ranges.push(...splitRange(1, firstSymbolLine - 1));
  }

  for (let index = 0; index < orderedSymbols.length; index += 1) {
    const current = orderedSymbols[index]!;
    const next = orderedSymbols[index + 1];
    const startLine = current.line;
    const endLine = Math.max(
      startLine,
      Math.min(lines.length, (next?.line ?? lines.length + 1) - 1),
    );
    ranges.push(...splitRange(startLine, endLine));
  }

  return ranges.filter((range) => range.startLine <= range.endLine);
}

function splitRange(
  startLine: number,
  endLine: number,
): Array<{ startLine: number; endLine: number }> {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let cursor = startLine;
  while (cursor <= endLine) {
    const chunkEnd = Math.min(endLine, cursor + DEFAULT_CHUNK_TARGET_LINES - 1);
    if (chunkEnd - cursor + 1 > MAX_CHUNK_LINES) {
      ranges.push({ startLine: cursor, endLine: cursor + MAX_CHUNK_LINES - 1 });
      cursor += MAX_CHUNK_LINES - CHUNK_LINE_OVERLAP;
    } else {
      ranges.push({ startLine: cursor, endLine: chunkEnd });
      cursor = chunkEnd + 1;
    }
  }
  return ranges;
}

function buildChunks(
  files: CodeSearchFile[],
  snapshot: CodeMapSnapshot,
): CodeIndexChunkRecord[] {
  const rankByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file.rank]),
  );
  const chunks: CodeIndexChunkRecord[] = [];
  for (const file of files) {
    const lines = readFileLines(file.absolutePath);
    const ranges = buildChunkRangesForFile(file, lines);
    ranges.forEach((range, index) => {
      const content = sliceLines(lines, range.startLine, range.endLine);
      if (!content) return;
      const summary = buildChunkSummary(file, range.startLine, range.endLine);
      const contentHash = shortHash(
        `${file.relativePath}\0${range.startLine}\0${range.endLine}\0${content}`,
      );
      chunks.push({
        id: buildChunkId(
          snapshot.repositoryId,
          snapshot.branch,
          snapshot.manifestHash,
          file.relativePath,
          range.startLine,
          range.endLine,
          contentHash,
        ),
        filePath: file.relativePath,
        chunkIndex: index,
        startLine: range.startLine,
        endLine: range.endLine,
        content,
        tokenCount: estimateTokens(content),
        summary,
        contentHash,
        summarySource: 'fallback',
      });
    });
    void rankByPath;
  }
  return chunks;
}

async function enhanceSummariesWithAi(
  files: CodeSearchFile[],
  fileRecords: CodeIndexFileRecord[],
  chunks: CodeIndexChunkRecord[],
  filePathsNeedingSummary: Set<string>,
  options?: Partial<CodeIndexBuildOptions>,
  onProgress?: (
    processed: number,
    total: number,
    detail?: {
      activeFiles: string[];
      queuedFiles: number;
      failedFiles: number;
      concurrency: number;
    },
  ) => void | Promise<void>,
): Promise<void> {
  if (options?.summarizeWithAi === false) return;
  if (filePathsNeedingSummary.size === 0) return;
  const generateSummary =
    options?.generateSummaryText || generateTextWithDefaultProvider;
  let canUseAi = true;

  const fileByPath = new Map(files.map((file) => [file.relativePath, file]));
  const chunkGroups = new Map<string, CodeIndexChunkRecord[]>();
  const totalSummaries = filePathsNeedingSummary.size;
  let processedSummaries = 0;
  let failedSummaries = 0;
  let cursor = 0;
  const activeFiles = new Set<string>();
  for (const chunk of chunks) {
    const list = chunkGroups.get(chunk.filePath) || [];
    list.push(chunk);
    chunkGroups.set(chunk.filePath, list);
  }

  const targets = fileRecords.filter((fileRecord) =>
    filePathsNeedingSummary.has(fileRecord.relativePath),
  );
  const concurrency = Math.max(
    1,
    Math.min(options?.summaryConcurrency || 1, targets.length || 1, 16),
  );
  const report = async () => {
    await onProgress?.(processedSummaries, totalSummaries, {
      activeFiles: Array.from(activeFiles),
      queuedFiles: Math.max(
        0,
        totalSummaries - processedSummaries - activeFiles.size,
      ),
      failedFiles: failedSummaries,
      concurrency,
    });
  };

  const processFile = async (fileRecord: CodeIndexFileRecord) => {
    const file = fileByPath.get(fileRecord.relativePath);
    const fileChunks = (chunkGroups.get(fileRecord.relativePath) || []).sort(
      (left, right) => left.chunkIndex - right.chunkIndex,
    );
    if (!file || fileChunks.length === 0) {
      processedSummaries += 1;
      await report();
      return;
    }
    activeFiles.add(fileRecord.relativePath);
    await report();
    try {
      const raw = await generateSummary(
        buildFileSummaryPrompt(file, fileChunks),
      );
      const parsed = parseFileSummaryBundle(raw, file, fileChunks);
      if (!parsed) return;
      if (parsed.fileSummary) fileRecord.summary = parsed.fileSummary;
      fileRecord.summarySource = 'ai';
      for (const chunk of fileChunks) {
        const summary = parsed.chunkSummaries.get(chunk.chunkIndex);
        if (summary) {
          chunk.summary = summary;
          chunk.summarySource = 'ai';
        }
      }
    } catch (err) {
      if (err instanceof Error && /No default AI provider/i.test(err.message)) {
        canUseAi = false;
      } else {
        failedSummaries += 1;
      }
    } finally {
      activeFiles.delete(fileRecord.relativePath);
      processedSummaries += 1;
      await report();
    }
  };

  const worker = async () => {
    while (canUseAi) {
      const nextIndex = cursor;
      cursor += 1;
      const fileRecord = targets[nextIndex];
      if (!fileRecord) break;
      await processFile(fileRecord);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function reuseCachedSummaries(
  previousSnapshot: CodeIndexSnapshot | null,
  fileRecords: CodeIndexFileRecord[],
  chunks: CodeIndexChunkRecord[],
): Set<string> {
  const filePathsNeedingSummary = new Set(
    fileRecords.map((file) => file.relativePath),
  );
  if (!previousSnapshot) return filePathsNeedingSummary;

  const previousFilesByPath = new Map(
    previousSnapshot.files.map((file) => [file.relativePath, file]),
  );
  const previousChunkGroups = new Map<string, CodeIndexChunkRecord[]>();
  const chunkGroups = new Map<string, CodeIndexChunkRecord[]>();
  for (const chunk of previousSnapshot.chunks) {
    const list = previousChunkGroups.get(chunk.filePath) || [];
    list.push(chunk);
    previousChunkGroups.set(chunk.filePath, list);
  }
  for (const chunk of chunks) {
    const list = chunkGroups.get(chunk.filePath) || [];
    list.push(chunk);
    chunkGroups.set(chunk.filePath, list);
  }

  for (const fileRecord of fileRecords) {
    const previousFile = previousFilesByPath.get(fileRecord.relativePath);
    const currentChunks = [
      ...(chunkGroups.get(fileRecord.relativePath) || []),
    ].sort((left, right) => left.chunkIndex - right.chunkIndex);
    const previousChunks = [
      ...(previousChunkGroups.get(fileRecord.relativePath) || []),
    ].sort((left, right) => left.chunkIndex - right.chunkIndex);

    if (
      previousFile &&
      previousFile.fileHash === fileRecord.fileHash &&
      previousFile.summary &&
      currentChunks.length === previousChunks.length
    ) {
      let allChunksReusable = true;
      for (let index = 0; index < currentChunks.length; index += 1) {
        const currentChunk = currentChunks[index]!;
        const previousChunk = previousChunks[index];
        if (
          !previousChunk ||
          previousChunk.contentHash !== currentChunk.contentHash ||
          !previousChunk.summary
        ) {
          allChunksReusable = false;
          break;
        }
      }
      if (allChunksReusable) {
        fileRecord.summary = previousFile.summary;
        fileRecord.summarySource = 'cache';
        for (let index = 0; index < currentChunks.length; index += 1) {
          currentChunks[index]!.summary = previousChunks[index]!.summary;
          currentChunks[index]!.summarySource = 'cache';
        }
        filePathsNeedingSummary.delete(fileRecord.relativePath);
        continue;
      }
    }

    const previousChunksByHash = new Map(
      previousChunks.map((chunk) => [chunk.contentHash, chunk] as const),
    );
    for (const chunk of currentChunks) {
      const previousChunk = previousChunksByHash.get(chunk.contentHash);
      if (previousChunk?.summary) {
        chunk.summary = previousChunk.summary;
        chunk.summarySource = 'cache';
      }
    }
  }

  return filePathsNeedingSummary;
}

function buildFunctions(
  files: CodeSearchFile[],
  snapshot: CodeMapSnapshot,
): CodeIndexFunctionRecord[] {
  const functions: CodeIndexFunctionRecord[] = [];
  for (const file of files) {
    if (file.language === 'typescript' || file.language === 'javascript') {
      const graph = getTsJsFunctionGraph(file);
      graph.functions.forEach((fn) => {
        functions.push({
          id: buildFunctionId(
            snapshot.repositoryId,
            snapshot.branch,
            snapshot.manifestHash,
            file.relativePath,
            fn.localId,
          ),
          filePath: file.relativePath,
          name: fn.name,
          kind: fn.kind,
          signature: fn.signature,
          startLine: fn.startLine,
          endLine: fn.endLine,
          line: fn.line,
          column: fn.column,
          parentFunctionId: fn.parentLocalId
            ? buildFunctionId(
                snapshot.repositoryId,
                snapshot.branch,
                snapshot.manifestHash,
                file.relativePath,
                fn.parentLocalId,
              )
            : null,
        });
      });
      continue;
    }

    const callableSymbols = [...file.symbols]
      .filter(callableFromSymbol)
      .sort((left, right) => left.line - right.line);
    callableSymbols.forEach((symbol, index) => {
      const next = callableSymbols[index + 1];
      const endLine = Math.max(
        symbol.line,
        Math.min(file.lineCount, (next?.line ?? file.lineCount + 1) - 1),
      );
      functions.push({
        id: buildFunctionId(
          snapshot.repositoryId,
          snapshot.branch,
          snapshot.manifestHash,
          file.relativePath,
          `${symbol.name}:${symbol.line}:${symbol.column}`,
        ),
        filePath: file.relativePath,
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
        startLine: symbol.line,
        endLine,
        line: symbol.line,
        column: symbol.column,
        parentFunctionId: null,
      });
    });
  }
  return functions;
}

interface ImportBinding {
  localName: string;
  importedName: string;
}

function parseTsImportBindings(file: CodeSearchFile): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const lines = readFileLines(file.absolutePath);
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:import|export)\s+(.+?)\s+from\s+['"][^'"]+['"]/,
    );
    if (!match?.[1]) continue;
    const clause = match[1].trim();
    const namedBlock = clause.match(/\{([^}]+)\}/);
    if (namedBlock?.[1]) {
      namedBlock[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const aliasMatch = entry.match(
            /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/i,
          );
          if (!aliasMatch?.[1]) return;
          bindings.push({
            importedName: aliasMatch[1],
            localName: aliasMatch[2] || aliasMatch[1],
          });
        });
    }

    const withoutNamed = clause.replace(/\{[^}]+\}/, '').trim();
    withoutNamed
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const namespaceMatch = entry.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (namespaceMatch?.[1]) {
          bindings.push({ importedName: '*', localName: namespaceMatch[1] });
          return;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
          bindings.push({ importedName: 'default', localName: entry });
        }
      });
  }
  return bindings;
}

function inferDefaultImportTargets(
  targetFile: string,
  functionByFileAndName: Map<string, CodeIndexFunctionRecord[]>,
): CodeIndexFunctionRecord[] {
  const candidates = Array.from(functionByFileAndName.entries())
    .filter(([key]) => key.startsWith(`${targetFile}\0`))
    .flatMap(([, records]) => records)
    .sort((left, right) => left.line - right.line);
  if (candidates.length <= 1) return candidates;
  const exported = candidates.filter((candidate) =>
    /\bexport\b/.test(candidate.signature),
  );
  return exported.length > 0 ? exported : [candidates[0]];
}

function inferAllImportTargets(
  targetFile: string,
  functionByFileAndName: Map<string, CodeIndexFunctionRecord[]>,
): CodeIndexFunctionRecord[] {
  return Array.from(functionByFileAndName.entries())
    .filter(([key]) => key.startsWith(`${targetFile}\0`))
    .flatMap(([, records]) => records);
}

function buildFunctionEdges(
  files: CodeSearchFile[],
  functions: CodeIndexFunctionRecord[],
  snapshot: CodeMapSnapshot,
): CodeIndexFunctionEdgeRecord[] {
  const edges: CodeIndexFunctionEdgeRecord[] = [];
  const functionsByFile = new Map<string, CodeIndexFunctionRecord[]>();
  const functionByFileAndName = new Map<string, CodeIndexFunctionRecord[]>();
  for (const fn of functions) {
    const byFile = functionsByFile.get(fn.filePath) || [];
    byFile.push(fn);
    functionsByFile.set(fn.filePath, byFile);
    const byNameKey = `${fn.filePath}\0${fn.name}`;
    const byName = functionByFileAndName.get(byNameKey) || [];
    byName.push(fn);
    functionByFileAndName.set(byNameKey, byName);
  }

  const fileEdgesBySource = new Map<string, CodeMapSnapshot['edges']>();
  for (const edge of snapshot.edges) {
    const list = fileEdgesBySource.get(edge.fromFile) || [];
    list.push(edge);
    fileEdgesBySource.set(edge.fromFile, list);
  }

  const seen = new Set<string>();
  for (const file of files) {
    const fileFunctions = (functionsByFile.get(file.relativePath) || []).sort(
      (left, right) => left.startLine - right.startLine,
    );
    if (fileFunctions.length === 0) continue;

    const lines = readFileLines(file.absolutePath);
    const localByName = new Map<string, CodeIndexFunctionRecord[]>();
    for (const fn of fileFunctions) {
      const list = localByName.get(fn.name) || [];
      list.push(fn);
      localByName.set(fn.name, list);
    }

    const importedBindings =
      file.language === 'typescript' || file.language === 'javascript'
        ? parseTsImportBindings(file)
        : [];
    const importedBindingByLocal = new Map<string, ImportBinding[]>();
    for (const binding of importedBindings) {
      const list = importedBindingByLocal.get(binding.localName) || [];
      list.push(binding);
      importedBindingByLocal.set(binding.localName, list);
    }

    const importedTargets = new Map<string, CodeIndexFunctionRecord[]>();
    const possibleEdges = fileEdgesBySource.get(file.relativePath) || [];
    const scriptLike =
      file.language === 'typescript' || file.language === 'javascript';
    if (scriptLike) {
      for (const [localName, bindings] of importedBindingByLocal) {
        const bucket = importedTargets.get(localName) || [];
        for (const binding of bindings) {
          const matchingEdges = possibleEdges.filter(
            (edge) =>
              edge.symbols.length === 0 ||
              edge.symbols.includes(localName) ||
              (binding.importedName !== '*' &&
                binding.importedName !== 'default' &&
                edge.symbols.includes(binding.importedName)),
          );
          for (const edge of matchingEdges) {
            if (binding.importedName === '*') {
              const records = inferAllImportTargets(
                edge.toFile,
                functionByFileAndName,
              );
              records.forEach((record) => bucket.push(record));
              continue;
            }
            if (binding.importedName === 'default') {
              inferDefaultImportTargets(
                edge.toFile,
                functionByFileAndName,
              ).forEach((record) => bucket.push(record));
              continue;
            }
            const records =
              functionByFileAndName.get(
                `${edge.toFile}\0${binding.importedName}`,
              ) || [];
            records.forEach((record) => bucket.push(record));
          }
        }
        importedTargets.set(localName, bucket);
      }
    } else {
      for (const importEntry of getFileImports(file)) {
        for (const edge of possibleEdges) {
          if (
            edge.symbols.length > 0 &&
            !edge.symbols.includes(importEntry.symbolName)
          )
            continue;
          const candidates =
            functionByFileAndName.get(
              `${edge.toFile}\0${importEntry.symbolName}`,
            ) || [];
          if (candidates.length === 0) continue;
          const existing = importedTargets.get(importEntry.symbolName) || [];
          for (const candidate of candidates) existing.push(candidate);
          importedTargets.set(importEntry.symbolName, existing);
        }
      }
    }

    if (scriptLike) {
      const graph = getTsJsFunctionGraph(file);
      const fileFunctionByLocalId = new Map(
        fileFunctions.map((fn) => [`${fn.name}:${fn.line}:${fn.column}`, fn]),
      );

      for (const call of graph.calls) {
        const fromFunction = fileFunctionByLocalId.get(call.fromLocalId);
        if (!fromFunction) continue;
        if (!call.calleeName || CALL_NAME_SKIP.has(call.calleeName)) continue;
        const localTargets = (localByName.get(call.calleeName) || []).filter(
          (candidate) => candidate.id !== fromFunction.id,
        );
        let remoteTargets: CodeIndexFunctionRecord[] = [];
        if (
          call.qualifier === null ||
          call.qualifier === 'this' ||
          call.qualifier === 'super'
        ) {
          remoteTargets = importedTargets.get(call.calleeName) || [];
        } else {
          const qualified = importedTargets.get(call.qualifier) || [];
          if (qualified.length > 0) {
            remoteTargets = qualified.filter(
              (candidate) => candidate.name === call.calleeName,
            );
          } else {
            remoteTargets = localByName.get(call.calleeName) || [];
          }
        }
        const candidates = [...localTargets, ...remoteTargets];
        for (const target of candidates) {
          const key = `${fromFunction.id}\0${target.id}\0${call.line}\0${call.calleeName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            id: `cife_${shortHash(key)}`,
            fromFunctionId: fromFunction.id,
            toFunctionId: target.id,
            edgeType: 'call',
            symbol: call.calleeName,
            line: call.line,
          });
        }
      }
      continue;
    }

    for (const fn of fileFunctions) {
      for (
        let lineNumber = fn.startLine;
        lineNumber <= fn.endLine;
        lineNumber += 1
      ) {
        const line = lines[lineNumber - 1] || '';
        const matches = line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
        for (const match of matches) {
          const symbol = match[1];
          if (!symbol || CALL_NAME_SKIP.has(symbol)) continue;
          const localTargets = (localByName.get(symbol) || []).filter(
            (candidate) => candidate.id !== fn.id,
          );
          const remoteTargets = importedTargets.get(symbol) || [];
          const candidates = [...localTargets, ...remoteTargets];
          for (const target of candidates) {
            const key = `${fn.id}\0${target.id}\0${lineNumber}\0${symbol}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
              id: `cife_${shortHash(key)}`,
              fromFunctionId: fn.id,
              toFunctionId: target.id,
              edgeType: 'call',
              symbol,
              line: lineNumber,
            });
          }
        }
      }
    }
  }

  return edges;
}

function toFiles(
  snapshot: CodeMapSnapshot,
  indexedFiles: CodeSearchFile[],
): CodeIndexFileRecord[] {
  const fileByPath = new Map(
    indexedFiles.map((file) => [file.relativePath, file]),
  );
  return snapshot.files.map((file) => {
    const indexed = fileByPath.get(file.relativePath);
    const content = indexed
      ? readFileLines(indexed.absolutePath).join('\n')
      : '';
    return {
      relativePath: file.relativePath,
      language: file.language,
      byteSize: file.byteSize,
      lineCount: file.lineCount,
      fileHash: shortHash(content || `${file.relativePath}\0${file.byteSize}`),
      rank: file.rank,
      importCount: file.importCount,
      exportCount: file.exportCount,
      summary: indexed
        ? buildFileSummary(indexed, file.rank)
        : t(
            'prompts.fileSummaryUnavailable',
            { filePath: file.relativePath },
            undefined,
          ),
      summarySource: 'fallback',
    };
  });
}

function buildStats(
  snapshot: CodeMapSnapshot,
  chunks: CodeIndexChunkRecord[],
  functions: CodeIndexFunctionRecord[],
  functionEdges: CodeIndexFunctionEdgeRecord[],
  embeddedChunkCount: number,
): CodeIndexStats {
  return {
    fileCount: snapshot.stats.fileCount,
    chunkCount: chunks.length,
    functionCount: functions.length,
    functionEdgeCount: functionEdges.length,
    totalLines: snapshot.stats.totalLines,
    embeddedChunkCount,
  };
}

async function reportProgress(
  repositoryId: string,
  branch: string,
  onProgress: CodeIndexBuildOptions['onProgress'],
  progress: Omit<CodeIndexProgress, 'repositoryId' | 'branch'>,
): Promise<void> {
  void repositoryId;
  void branch;
  if (!onProgress) return;
  await onProgress(progress);
}

async function reportSnapshot(
  onSnapshot: CodeIndexBuildOptions['onSnapshot'],
  snapshot: CodeIndexSnapshot,
): Promise<void> {
  if (!onSnapshot) return;
  await onSnapshot(snapshot);
}

function buildCodeIndexSnapshotFromParts(input: {
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  manifestHash: string;
  startedAt: string;
  sourceInfo?: CodeIndexBuildOptions['sourceInfo'];
  status: CodeIndexSnapshotMeta['status'];
  stage: CodeIndexSnapshotMeta['stage'];
  generatedAt: string | null;
  message: string;
  error?: string | null;
  progressProcessed: number;
  progressTotal: number;
  files: CodeIndexFileRecord[];
  chunks: CodeIndexChunkRecord[];
  functions: CodeIndexFunctionRecord[];
  functionEdges: CodeIndexFunctionEdgeRecord[];
  mapSnapshot: CodeMapSnapshot;
  embeddedChunkCount: number;
  embeddingsEnabled: boolean;
}): CodeIndexSnapshot {
  const progress = createProgress(
    input.stage,
    input.progressTotal,
    input.progressProcessed,
    input.message,
    input.startedAt,
    input.error ?? null,
  );
  const stats = buildStats(
    input.mapSnapshot,
    input.chunks,
    input.functions,
    input.functionEdges,
    input.embeddedChunkCount,
  );
  return {
    meta: {
      repositoryId: input.repositoryId,
      branch: input.branch,
      rootDirectory: input.rootDirectory,
      sourceKind: input.sourceInfo?.sourceKind,
      sourceBranch: input.sourceInfo?.sourceBranch || input.branch,
      sourceHeadSha: input.sourceInfo?.sourceHeadSha || '',
      manifestHash: input.manifestHash,
      status: input.status,
      stage: input.stage,
      generatedAt: input.generatedAt,
      stats,
      capabilities: {
        chunkSearch: input.chunks.length > 0,
        fileSummaries: input.files.length > 0,
        functionGraph: input.functions.length > 0,
        embeddings: input.embeddingsEnabled,
      },
      progress,
    },
    files: input.files,
    chunks: input.chunks,
    functions: input.functions,
    functionEdges: input.functionEdges,
  };
}

function createProgress(
  stage: CodeIndexStage,
  totalFiles: number,
  processedFiles: number,
  message: string,
  startedAt: string | null,
  error: string | null = null,
  detail?: {
    activeFiles?: string[];
    queuedFiles?: number;
    failedFiles?: number;
    concurrency?: number;
  },
): Omit<CodeIndexProgress, 'repositoryId' | 'branch'> {
  return {
    status: error ? 'error' : stage === 'complete' ? 'ready' : 'building',
    stage,
    processedFiles,
    totalFiles,
    queuedFiles: detail?.queuedFiles,
    activeFiles: detail?.activeFiles,
    failedFiles: detail?.failedFiles,
    concurrency: detail?.concurrency,
    message,
    error,
    startedAt,
    updatedAt: new Date().toISOString(),
  };
}

async function collectBuildContext(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeIndexBuildOptions>,
  useAsync = true,
): Promise<BuildContext> {
  const searchOptions = resolveBuildOptions({
    maxFiles: options?.maxFiles,
    maxFileBytes: options?.maxFileBytes,
    includeGlobs: options?.includeGlobs,
    excludeGlobs: options?.excludeGlobs,
  });
  const candidatePaths = listCandidateFiles(rootDirectory, searchOptions);
  const indexedFiles = candidatePaths
    .map((absolutePath) =>
      buildIndexedFile(rootDirectory, absolutePath, searchOptions),
    )
    .filter((file): file is CodeSearchFile => file !== null);
  const manifestEntries = candidatePaths.map((absolutePath) => {
    try {
      const stat = fs.statSync(absolutePath);
      return {
        relativePath: normalizeRelativePath(rootDirectory, absolutePath),
        byteSize: stat.size,
        modifiedTimeMs: Math.trunc(stat.mtimeMs),
      };
    } catch {
      return {
        relativePath: normalizeRelativePath(rootDirectory, absolutePath),
        byteSize: 0,
        modifiedTimeMs: 0,
      };
    }
  });
  const manifestHash = computeCodeMapManifestHash(
    path.resolve(rootDirectory),
    manifestEntries,
  );
  const mapOptions = {
    maxFiles: options?.maxFiles,
    maxFileBytes: options?.maxFileBytes,
    includeGlobs: options?.includeGlobs,
    excludeGlobs: options?.excludeGlobs,
  };
  const providedMapSnapshot = options?.codeMapSnapshot || null;
  const canReuseProvidedMap =
    providedMapSnapshot?.manifestHash === manifestHash &&
    path.resolve(providedMapSnapshot.rootDirectory) ===
      path.resolve(rootDirectory);
  const mapSnapshot = canReuseProvidedMap
    ? providedMapSnapshot
    : useAsync
      ? await buildCodeMapAsync(rootDirectory, repositoryId, branch, mapOptions)
      : buildCodeMap(rootDirectory, repositoryId, branch, mapOptions);
  return { indexedFiles, mapSnapshot };
}

async function buildCodeIndexCore(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeIndexBuildOptions>,
  useAsync = true,
): Promise<CodeIndexSnapshot> {
  const startedAt = new Date().toISOString();
  const context = await collectBuildContext(
    rootDirectory,
    repositoryId,
    branch,
    options,
    useAsync,
  );
  if (options?.onCodeMapSnapshot) {
    await options.onCodeMapSnapshot(context.mapSnapshot);
  }
  const totalFiles = context.indexedFiles.length;
  const previousSnapshot = await loadCodeIndexSnapshot(repositoryId, branch);

  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    createProgress(
      'scan',
      totalFiles,
      totalFiles,
      t('prompts.auto_cf06fc', {}, undefined),
      startedAt,
    ),
  );

  const files = toFiles(context.mapSnapshot, context.indexedFiles);
  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    createProgress(
      'symbols',
      totalFiles,
      totalFiles,
      t('prompts.auto_abad41', {}, undefined),
      startedAt,
    ),
  );

  const chunks = buildChunks(context.indexedFiles, context.mapSnapshot);
  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    createProgress(
      'chunks',
      totalFiles,
      totalFiles,
      t('prompts.auto_bc4c4d', {}, undefined),
      startedAt,
    ),
  );

  const functions = buildFunctions(context.indexedFiles, context.mapSnapshot);
  const functionEdges = buildFunctionEdges(
    context.indexedFiles,
    functions,
    context.mapSnapshot,
  );
  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    createProgress(
      'functions',
      totalFiles,
      totalFiles,
      t('prompts.auto_7deea7', {}, undefined),
      startedAt,
    ),
  );

  let embeddedChunkCount = 0;
  let embeddingsEnabled = false;
  const filePathsNeedingSummary = reuseCachedSummaries(
    previousSnapshot,
    files,
    chunks,
  );
  const shouldRunAiSummaries =
    options?.summarizeWithAi !== false && filePathsNeedingSummary.size > 0;
  const shouldRunEmbeddings =
    options?.embedChunks !== false && chunks.length > 0;

  const buildSnapshot = (input: {
    status: CodeIndexSnapshotMeta['status'];
    stage: CodeIndexSnapshotMeta['stage'];
    generatedAt: string | null;
    message: string;
    error?: string | null;
    progressProcessed: number;
    progressTotal: number;
  }): CodeIndexSnapshot =>
    buildCodeIndexSnapshotFromParts({
      repositoryId,
      branch,
      rootDirectory,
      manifestHash: context.mapSnapshot.manifestHash,
      startedAt,
      sourceInfo: options?.sourceInfo,
      status: input.status,
      stage: input.stage,
      generatedAt: input.generatedAt,
      message: input.message,
      error: input.error,
      progressProcessed: input.progressProcessed,
      progressTotal: input.progressTotal,
      files,
      chunks,
      functions,
      functionEdges,
      mapSnapshot: context.mapSnapshot,
      embeddedChunkCount,
      embeddingsEnabled,
    });

  const baseStage = shouldRunAiSummaries
    ? 'summaries'
    : shouldRunEmbeddings
      ? 'embeddings'
      : 'complete';
  const baseStatus = baseStage === 'complete' ? 'ready' : 'building';
  const baseMessage =
    baseStage === 'summaries'
      ? t('prompts.auto_8975b3', {}, undefined)
      : baseStage === 'embeddings'
        ? t('prompts.auto_865147', {}, undefined)
        : t('prompts.auto_553d28', {}, undefined);
  const baseSnapshot = buildSnapshot({
    status: baseStatus,
    stage: baseStage,
    generatedAt: baseStage === 'complete' ? new Date().toISOString() : null,
    message: baseMessage,
    progressProcessed: 0,
    progressTotal:
      baseStage === 'summaries'
        ? filePathsNeedingSummary.size
        : baseStage === 'embeddings'
          ? chunks.length
          : totalFiles,
  });
  await reportSnapshot(options?.onSnapshot, baseSnapshot);
  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    baseSnapshot.meta.progress,
  );
  if (!shouldRunAiSummaries && !shouldRunEmbeddings) {
    return baseSnapshot;
  }

  if (shouldRunAiSummaries) {
    await enhanceSummariesWithAi(
      context.indexedFiles,
      files,
      chunks,
      filePathsNeedingSummary,
      options,
      async (processed, total, detail) => {
        await reportProgress(
          repositoryId,
          branch,
          options?.onProgress,
          createProgress(
            'summaries',
            total,
            processed,
            t('prompts.auto_1a5570', {}, undefined),
            startedAt,
            null,
            detail,
          ),
        );
      },
    );
    const summaryStage = shouldRunEmbeddings ? 'embeddings' : 'complete';
    const summaryStatus = summaryStage === 'complete' ? 'ready' : 'building';
    const summaryMessage =
      summaryStage === 'embeddings'
        ? t('prompts.auto_e833ce', {}, undefined)
        : t('prompts.auto_643bcf', {}, undefined);
    const summarySnapshot = buildSnapshot({
      status: summaryStatus,
      stage: summaryStage,
      generatedAt:
        summaryStage === 'complete' ? new Date().toISOString() : null,
      message: summaryMessage,
      progressProcessed: filePathsNeedingSummary.size,
      progressTotal:
        summaryStage === 'embeddings'
          ? chunks.length
          : filePathsNeedingSummary.size,
    });
    await reportSnapshot(options?.onSnapshot, summarySnapshot);
    await reportProgress(
      repositoryId,
      branch,
      options?.onProgress,
      summarySnapshot.meta.progress,
    );
  }

  if (shouldRunEmbeddings) {
    const provider = await resolveEmbeddingProvider();
    if (provider) {
      embeddingsEnabled = true;
      embeddedChunkCount = await batchEmbedAndStore(
        'code_chunk',
        chunks.map((chunk) => ({
          ownerId: chunkEmbeddingOwnerId(chunk),
          text: chunkEmbeddingText(chunk),
        })),
        provider,
      );
    }
  }
  const finalSnapshot = buildSnapshot({
    status: 'ready',
    stage: 'complete',
    generatedAt: new Date().toISOString(),
    message: shouldRunEmbeddings
      ? t('prompts.auto_8f3d2c', {}, undefined)
      : t('prompts.auto_553d28', {}, undefined),
    progressProcessed: shouldRunEmbeddings ? chunks.length : totalFiles,
    progressTotal: shouldRunEmbeddings ? chunks.length : totalFiles,
  });
  await reportSnapshot(options?.onSnapshot, finalSnapshot);
  await reportProgress(
    repositoryId,
    branch,
    options?.onProgress,
    finalSnapshot.meta.progress,
  );
  return finalSnapshot;
}

export async function buildCodeIndexAsync(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeIndexBuildOptions>,
): Promise<CodeIndexSnapshot> {
  return await buildCodeIndexCore(
    rootDirectory,
    repositoryId,
    branch,
    options,
    true,
  );
}

export async function enrichCodeIndexSnapshotAsync(
  rootDirectory: string,
  snapshot: CodeIndexSnapshot,
  options?: Partial<CodeIndexBuildOptions>,
): Promise<CodeIndexSnapshot> {
  const startedAt = new Date().toISOString();
  const effectiveOptions = resolveBuildOptions({
    maxFiles: options?.maxFiles,
    maxFileBytes: options?.maxFileBytes,
    includeGlobs: options?.includeGlobs,
    excludeGlobs: options?.excludeGlobs,
  });
  const files = snapshot.files.map((file) => ({ ...file }));
  const chunks = snapshot.chunks.map((chunk) => ({ ...chunk }));
  const functions = snapshot.functions.map((fn) => ({ ...fn }));
  const functionEdges = snapshot.functionEdges.map((edge) => ({ ...edge }));
  const snapshotFilePaths = new Set(files.map((file) => file.relativePath));
  const indexedFiles = files
    .map((file) =>
      buildIndexedFile(
        rootDirectory,
        path.join(rootDirectory, file.relativePath),
        effectiveOptions,
      ),
    )
    .filter((file): file is CodeSearchFile => file !== null)
    .filter((file) => snapshotFilePaths.has(file.relativePath));
  const summaryTargets = new Set(
    files
      .filter(
        (file) => file.summarySource !== 'ai' && file.summarySource !== 'cache',
      )
      .map((file) => file.relativePath),
  );
  let embeddedChunkCount = snapshot.meta.stats.embeddedChunkCount;
  let embeddingsEnabled = snapshot.meta.capabilities.embeddings;

  const buildSnapshot = (input: {
    status: CodeIndexSnapshotMeta['status'];
    stage: CodeIndexSnapshotMeta['stage'];
    generatedAt: string | null;
    message: string;
    error?: string | null;
    progressProcessed: number;
    progressTotal: number;
  }): CodeIndexSnapshot =>
    buildCodeIndexSnapshotFromParts({
      repositoryId: snapshot.meta.repositoryId,
      branch: snapshot.meta.branch,
      rootDirectory,
      manifestHash: snapshot.meta.manifestHash,
      startedAt,
      sourceInfo: options?.sourceInfo || {
        sourceKind: snapshot.meta.sourceKind,
        sourceBranch: snapshot.meta.sourceBranch,
        sourceHeadSha: snapshot.meta.sourceHeadSha,
      },
      status: input.status,
      stage: input.stage,
      generatedAt: input.generatedAt,
      message: input.message,
      error: input.error,
      progressProcessed: input.progressProcessed,
      progressTotal: input.progressTotal,
      files,
      chunks,
      functions,
      functionEdges,
      mapSnapshot: {
        repositoryId: snapshot.meta.repositoryId,
        branch: snapshot.meta.branch,
        rootDirectory,
        generatedAt: snapshot.meta.generatedAt || startedAt,
        manifestHash: snapshot.meta.manifestHash,
        files: [],
        edges: [],
        stats: {
          fileCount: snapshot.meta.stats.fileCount,
          symbolCount: 0,
          edgeCount: 0,
          totalLines: snapshot.meta.stats.totalLines,
        },
      },
      embeddedChunkCount,
      embeddingsEnabled,
    });

  if (
    options?.summarizeWithAi !== false &&
    summaryTargets.size > 0 &&
    indexedFiles.length > 0
  ) {
    await enhanceSummariesWithAi(
      indexedFiles,
      files,
      chunks,
      summaryTargets,
      options,
      async (processed, total, detail) => {
        await reportProgress(
          snapshot.meta.repositoryId,
          snapshot.meta.branch,
          options?.onProgress,
          createProgress(
            'summaries',
            total,
            processed,
            t('prompts.auto_dab1f0', {}, undefined),
            startedAt,
            null,
            detail,
          ),
        );
      },
    );
    const summarySnapshot = buildSnapshot({
      status: options?.embedChunks ? 'building' : 'ready',
      stage: options?.embedChunks ? 'embeddings' : 'complete',
      generatedAt: options?.embedChunks ? null : new Date().toISOString(),
      message: options?.embedChunks
        ? t('prompts.auto_57d5e9', {}, undefined)
        : t('prompts.auto_934cbf', {}, undefined),
      progressProcessed: options?.embedChunks ? 0 : summaryTargets.size,
      progressTotal: options?.embedChunks ? chunks.length : summaryTargets.size,
    });
    await reportSnapshot(options?.onSnapshot, summarySnapshot);
    await reportProgress(
      snapshot.meta.repositoryId,
      snapshot.meta.branch,
      options?.onProgress,
      summarySnapshot.meta.progress,
    );
  }

  if (options?.embedChunks) {
    const provider = await resolveEmbeddingProvider();
    if (provider && chunks.length > 0) {
      await reportProgress(
        snapshot.meta.repositoryId,
        snapshot.meta.branch,
        options?.onProgress,
        createProgress(
          'embeddings',
          chunks.length,
          0,
          t('prompts.auto_116be6', {}, undefined),
          startedAt,
        ),
      );
      embeddingsEnabled = true;
      embeddedChunkCount += await batchEmbedAndStore(
        'code_chunk',
        chunks.map((chunk) => ({
          ownerId: chunkEmbeddingOwnerId(chunk),
          text: chunkEmbeddingText(chunk),
        })),
        provider,
      );
      await reportProgress(
        snapshot.meta.repositoryId,
        snapshot.meta.branch,
        options?.onProgress,
        createProgress(
          'embeddings',
          chunks.length,
          chunks.length,
          t('prompts.auto_8f3d2c', {}, undefined),
          startedAt,
        ),
      );
    }
  }

  const finalSnapshot = buildSnapshot({
    status: 'ready',
    stage: 'complete',
    generatedAt: new Date().toISOString(),
    message: options?.embedChunks
      ? t('prompts.auto_8f3d2c', {}, undefined)
      : t('prompts.auto_553d28', {}, undefined),
    progressProcessed: options?.embedChunks ? chunks.length : files.length,
    progressTotal: options?.embedChunks ? chunks.length : files.length,
  });
  await reportSnapshot(options?.onSnapshot, finalSnapshot);
  await reportProgress(
    snapshot.meta.repositoryId,
    snapshot.meta.branch,
    options?.onProgress,
    finalSnapshot.meta.progress,
  );
  return finalSnapshot;
}

export async function buildCodeIndex(
  rootDirectory: string,
  repositoryId: string,
  branch: string,
  options?: Partial<CodeIndexBuildOptions>,
): Promise<CodeIndexSnapshot> {
  await preloadTreeSitterGrammars();
  return await buildCodeIndexCore(
    rootDirectory,
    repositoryId,
    branch,
    options,
    false,
  );
}

export function resolveCodeIndexSnapshotId(
  repositoryId: string,
  branch: string,
): string {
  return buildSnapshotId(repositoryId, branch);
}
