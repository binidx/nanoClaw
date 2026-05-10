import fs from 'node:fs';
import path from 'node:path';

import { listCandidateFiles } from './code-search-collect.js';
import type {
  CodeSearchBuildOptions,
  CodeSearchFile,
  CodeSearchImport,
  CodeSearchIndex,
  CodeSearchSymbol,
} from './code-search-types.js';
import { isTreeSitterReady, extractSymbolsTS } from './code-search-tree-sitter.js';

export const DEFAULT_BUILD_OPTIONS: CodeSearchBuildOptions = {
  maxFiles: 1_500,
  maxFileBytes: 256 * 1024,
  maxTermsPerFile: 48,
  maxPreviewLines: 3,
  includeGlobs: [],
  excludeGlobs: [],
};

export const allSupportedSourceFileCache = new Map<string, string[]>();
export const exactQueryFallbackFileCache = new Map<
  string,
  Map<string, CodeSearchFile[]>
>();

export const STOP_TERMS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'const',
  'class',
  'function',
  'return',
  'import',
  'export',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'await',
  'void',
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'default',
  'value',
  'props',
  'param',
  'params',
  'result',
  'data',
  'item',
  'items',
]);

export function resolveBuildOptions(
  options?: Partial<CodeSearchBuildOptions>,
): CodeSearchBuildOptions {
  const includeGlobs = Array.isArray(options?.includeGlobs)
    ? options.includeGlobs
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    : DEFAULT_BUILD_OPTIONS.includeGlobs;
  const excludeGlobs = Array.isArray(options?.excludeGlobs)
    ? options.excludeGlobs
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    : DEFAULT_BUILD_OPTIONS.excludeGlobs;
  return {
    ...DEFAULT_BUILD_OPTIONS,
    ...options,
    maxFiles:
      typeof options?.maxFiles === 'number' && Number.isFinite(options.maxFiles)
        ? Math.max(0, Math.trunc(options.maxFiles))
        : DEFAULT_BUILD_OPTIONS.maxFiles,
    maxFileBytes:
      typeof options?.maxFileBytes === 'number' &&
      Number.isFinite(options.maxFileBytes)
        ? Math.max(1, Math.trunc(options.maxFileBytes))
        : DEFAULT_BUILD_OPTIONS.maxFileBytes,
    maxTermsPerFile:
      typeof options?.maxTermsPerFile === 'number' &&
      Number.isFinite(options.maxTermsPerFile)
        ? Math.max(1, Math.trunc(options.maxTermsPerFile))
        : DEFAULT_BUILD_OPTIONS.maxTermsPerFile,
    maxPreviewLines:
      typeof options?.maxPreviewLines === 'number' &&
      Number.isFinite(options.maxPreviewLines)
        ? Math.max(1, Math.trunc(options.maxPreviewLines))
        : DEFAULT_BUILD_OPTIONS.maxPreviewLines,
    includeGlobs,
    excludeGlobs,
  };
}

export function buildCodeSearchIndex(
  rootDirectory: string,
  options?: Partial<CodeSearchBuildOptions>,
): CodeSearchIndex {
  const normalizedRoot = path.resolve(rootDirectory);
  allSupportedSourceFileCache.delete(normalizedRoot);
  exactQueryFallbackFileCache.delete(normalizedRoot);
  const effectiveOptions = resolveBuildOptions(options);
  const candidates = listCandidateFiles(normalizedRoot, effectiveOptions);

  const files: CodeSearchFile[] = [];
  let symbolCount = 0;
  let termCount = 0;
  for (const absolutePath of candidates) {
    const indexed = buildIndexedFile(
      normalizedRoot,
      absolutePath,
      effectiveOptions,
    );
    if (!indexed) continue;
    files.push(indexed);
    symbolCount += indexed.symbols.length;
    termCount += indexed.terms.length;
  }

  return {
    rootDirectory: normalizedRoot,
    generatedAt: new Date().toISOString(),
    options: effectiveOptions,
    files,
    fileCount: files.length,
    symbolCount,
    termCount,
  };
}

export function buildIndexedFile(
  rootDirectory: string,
  absolutePath: string,
  options: CodeSearchBuildOptions,
): CodeSearchFile | null {
  let stats: fs.Stats;
  let rawBuffer: Buffer;
  try {
    stats = fs.statSync(absolutePath);
    if (!stats.isFile() || stats.size > options.maxFileBytes) return null;
    rawBuffer = fs.readFileSync(absolutePath);
  } catch {
    return null;
  }
  if (looksBinary(rawBuffer)) return null;

  const content = rawBuffer.toString('utf8');
  const rawLines = content.split(/\r?\n/);
  const language = detectLanguage(absolutePath);
  const relativePath = normalizeRelativePath(rootDirectory, absolutePath);
  let symbols: CodeSearchSymbol[];
  if (isTreeSitterReady(language)) {
    try {
      symbols = dedupeSymbols(extractSymbolsTS(language, content, rawLines));
    } catch {
      symbols = extractSymbolsRegex(language, rawLines);
    }
  } else {
    symbols = extractSymbolsRegex(language, rawLines);
  }
  const imports = extractImports(language, rawLines);
  const lines = rawLines;
  const terms = extractTermsFromFile(relativePath, content, symbols, imports).slice(
    0,
    options.maxTermsPerFile,
  );
  const previews = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, options.maxPreviewLines);

  return {
    absolutePath,
    relativePath,
    extension: path.extname(absolutePath).toLowerCase(),
    language,
    byteSize: stats.size,
    lineCount: lines.length,
    terms,
    symbols,
    imports,
    previews,
  };
}

function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 512);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function normalizeRelativePath(
  rootDirectory: string,
  absolutePath: string,
): string {
  return path.relative(rootDirectory, absolutePath).replace(/\\/g, '/');
}

function normalizeSelectionPath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim().replace(/\s+\d+$/, ''))
    .filter(Boolean)
    .join('/');
}

function detectLanguage(filePath: string): string {
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
    case '.kt':
    case '.kts':
      return 'kotlin';
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

const SIGNATURE_START_RE = /^\s*(?:public|private|protected|internal|open|abstract|sealed|override|static|final|default|synchronized|native|strictfp|suspend|inline|infix|operator|tailrec|fun|def|val|var|class|interface|enum|trait|object|void|int|long|short|byte|char|float|double|boolean|String|List|Map|Set|Optional|CompletableFuture)\b/;
const MAX_MERGE_LINES = 5;

export function joinMultilineSignatures(lines: string[]): string[] {
  const result: string[] = [];
  let pending = '';
  let pendingLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (pending) {
      pending += ' ' + trimmed;
      pendingLineCount++;
      if (trimmed.includes('{') || trimmed.includes(';') || trimmed.startsWith(')') || pendingLineCount >= MAX_MERGE_LINES) {
        result.push(pending);
        pending = '';
        pendingLineCount = 0;
      }
      continue;
    }
    const openParens = (trimmed.match(/\(/g) || []).length;
    const closeParens = (trimmed.match(/\)/g) || []).length;
    if (
      openParens > closeParens &&
      SIGNATURE_START_RE.test(trimmed) &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('/*')
    ) {
      pending = line;
      pendingLineCount = 1;
      continue;
    }
    result.push(line);
  }
  if (pending) result.push(pending);
  return result;
}

function extractSymbols(language: string, lines: string[]): CodeSearchSymbol[] {
  const symbols: CodeSearchSymbol[] = [];
  const patterns = getSymbolPatterns(language);

  lines.forEach((line, lineIndex) => {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match?.[1]) continue;
      const name = match[1].trim();
      if (!name) continue;
      symbols.push({
        name,
        kind: pattern.kind,
        line: lineIndex + 1,
        column: (match.index ?? 0) + 1,
        signature: line.trim(),
      });
      break;
    }
  });

  if (language === 'python') {
    for (const sym of symbols) {
      const decorators: string[] = [];
      for (let i = sym.line - 2; i >= 0; i--) {
        const prevLine = lines[i]?.trim() || '';
        if (prevLine.startsWith('@')) {
          decorators.unshift(prevLine);
        } else if (prevLine === '' || prevLine.startsWith('#')) {
          continue;
        } else {
          break;
        }
      }
      if (decorators.length > 0) {
        sym.signature = `${decorators.join(' ')} ${sym.signature}`;
      }
    }
  }

  return dedupeSymbols(symbols);
}

function getSymbolPatterns(language: string): Array<{
  kind: CodeSearchSymbol['kind'];
  regex: RegExp;
}> {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return [
        {
          kind: 'class',
          regex:
            /^\s*export\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'function',
          regex:
            /^\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'class',
          regex:
            /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'interface',
          regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'type',
          regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'enum',
          regex: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'function',
          regex:
            /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'namespace',
          regex:
            /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+([A-Za-z_$][\w$]*)/,
        },
        {
          kind: 'const',
          regex:
            /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?\s*=\s*(?:async\s*)?(?:(?:function\s*\()|(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\()|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|\()/,
        },
        {
          kind: 'method',
          regex:
            /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
        },
      ];
    case 'python':
      return [
        { kind: 'class', regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
        {
          kind: 'function',
          regex: /^\s*async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
        },
        { kind: 'function', regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
      ];
    case 'java':
      return [
        {
          kind: 'package',
          regex: /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/,
        },
        {
          kind: 'class',
          regex:
            /^\s*(?:public|private|protected)?\s*(?:static\s+)?record\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'class',
          regex:
            /^\s*(?:public|private|protected)?\s*(?:(?:abstract|final|sealed|static)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'interface',
          regex:
            /^\s*(?:public|private|protected)?\s*@interface\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'interface',
          regex:
            /^\s*(?:public|private|protected)?\s*(?:(?:sealed|non-sealed|static)\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'enum',
          regex:
            /^\s*(?:public|private|protected)?\s*(?:static\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'method',
          regex:
            /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected)\s+)?(?:(?:static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[A-Za-z_][\w]*(?:<[^>]*>)?(?:\[\])*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
        },
      ];
    case 'scala':
      return [
        {
          kind: 'package',
          regex: /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)/,
        },
        {
          kind: 'class',
          regex:
            /^\s*(?:(?:final|sealed|abstract|case)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'trait',
          regex: /^\s*(?:(?:sealed|abstract)\s+)*trait\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'module',
          regex: /^\s*(?:final\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'type',
          regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'function',
          regex:
            /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]+\])?\s*\(/,
        },
        {
          kind: 'const',
          regex: /^\s*val\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        },
      ];
    case 'go':
      return [
        { kind: 'package', regex: /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/ },
        {
          kind: 'method',
          regex: /^\s*func\s+\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
        },
        {
          kind: 'function',
          regex: /^\s*func\s+New[A-Z][A-Za-z0-9_]*\s*\(/,
        },
        { kind: 'function', regex: /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
        {
          kind: 'struct',
          regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/,
        },
        {
          kind: 'interface',
          regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\b/,
        },
        {
          kind: 'type',
          regex: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z_][A-Za-z0-9_]*/,
        },
        {
          kind: 'const',
          regex: /^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        },
        {
          kind: 'variable',
          regex: /^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        },
      ];
    case 'kotlin':
      return [
        {
          kind: 'package',
          regex: /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)/,
        },
        {
          kind: 'class',
          regex:
            /^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|inner|value)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'interface',
          regex:
            /^\s*(?:(?:public|private|protected|internal|sealed|fun)\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'module',
          regex:
            /^\s*(?:(?:public|private|protected|internal)\s+)?(?:companion\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'enum',
          regex:
            /^\s*(?:(?:public|private|protected|internal)\s+)?enum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'function',
          regex:
            /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|infix|operator|tailrec)\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
        },
        {
          kind: 'const',
          regex: /^\s*(?:(?:public|private|protected|internal|override|const)\s+)*val\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        },
        {
          kind: 'variable',
          regex: /^\s*(?:(?:public|private|protected|internal|override)\s+)*var\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
        },
        {
          kind: 'type',
          regex: /^\s*typealias\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
      ];
    case 'rust':
      return [
        {
          kind: 'function',
          regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
        },
        {
          kind: 'struct',
          regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'enum',
          regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
        {
          kind: 'trait',
          regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/,
        },
      ];
    case 'sql':
      return [
        {
          kind: 'table',
          regex:
            /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/i,
        },
        {
          kind: 'view',
          regex: /^\s*create\s+(?:or\s+replace\s+)?view\s+([A-Za-z_][\w.]*)/i,
        },
      ];
    default:
      return [];
  }
}

function extractImports(language: string, lines: string[]): CodeSearchImport[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractScriptImports(lines);
    case 'python':
      return extractPythonImports(lines);
    case 'java':
      return extractJavaImports(lines);
    case 'scala':
      return extractScalaImports(lines);
    case 'kotlin':
      return extractKotlinImports(lines);
    case 'go':
      return extractGoImports(lines);
    case 'rust':
      return extractRustImports(lines);
    default:
      return [];
  }
}

function extractScriptImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const fromMatch = line.match(
      /^\s*(?:import|export)\s+(.+?)\s+from\s+['"]([^'"]+)['"]/,
    );
    if (fromMatch) {
      const clause = fromMatch[1] || '';
      const modulePath = fromMatch[2] || '';
      const namedSymbols = extractScriptImportSymbols(clause);
      if (namedSymbols.length === 0) {
        imports.push({
          modulePath,
          symbolName: '',
          line: lineIndex + 1,
          signature: line.trim(),
        });
      } else {
        namedSymbols.forEach((symbolName) => {
          imports.push({
            modulePath,
            symbolName,
            line: lineIndex + 1,
            signature: line.trim(),
          });
        });
      }
      return;
    }
    const sideEffectMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
    if (!sideEffectMatch) return;
    imports.push({
      modulePath: sideEffectMatch[1] || '',
      symbolName: '',
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractScriptImportSymbols(clause: string): string[] {
  const normalized = clause.trim();
  if (!normalized) return [];
  const symbols: string[] = [];
  const namedMatch = normalized.match(/\{([^}]+)\}/);
  if (namedMatch?.[1]) {
    namedMatch[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const [name] = entry.split(/\s+as\s+/i);
        if (name) symbols.push(name.trim());
      });
  }
  const clauseWithoutNamed = normalized.replace(/\{[^}]+\}/, '').trim();
  clauseWithoutNamed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const namespaceMatch = entry.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (namespaceMatch?.[1]) {
        symbols.push(namespaceMatch[1]);
        return;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) {
        symbols.push(entry);
      }
    });
  return Array.from(new Set(symbols));
}

function extractPythonImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch?.[1]) {
      importMatch[1]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const base = entry.split(/\s+as\s+/i)[0]?.trim() || '';
          if (!base) return;
          imports.push({
            modulePath: base,
            symbolName: '',
            line: lineIndex + 1,
            signature: line.trim(),
          });
        });
      return;
    }
    const fromMatch = line.match(
      /^\s*from\s+(\.{1,3}[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\s+(.+)$/,
    );
    if (!fromMatch?.[1] || !fromMatch[2]) return;
    fromMatch[2]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const base = entry.split(/\s+as\s+/i)[0]?.trim() || '';
        imports.push({
          modulePath: fromMatch[1] || '',
          symbolName: base === '*' ? '' : base,
          line: lineIndex + 1,
          signature: line.trim(),
        });
      });
  });
  return imports;
}

function extractJavaImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/);
    if (!match?.[1]) return;
    const raw = match[1];
    const pieces = raw.split('.');
    const tail = pieces[pieces.length - 1] || '';
    imports.push({
      modulePath: raw,
      symbolName: tail === '*' ? '' : tail,
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractScalaImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^\s*import\s+(.+)$/);
    if (!match?.[1]) return;
    const raw = match[1].trim();
    const blockMatch = raw.match(/^([A-Za-z0-9_.]+)\.\{(.+)\}$/);
    if (blockMatch?.[1] && blockMatch[2]) {
      blockMatch[2]
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const base = entry.split(/\s*=>\s*/)[0]?.trim() || '';
          imports.push({
            modulePath: blockMatch[1] || '',
            symbolName: base === '_' ? '' : base,
            line: lineIndex + 1,
            signature: line.trim(),
          });
        });
      return;
    }
    const pieces = raw.split('.');
    const tail = pieces[pieces.length - 1] || '';
    imports.push({
      modulePath: raw,
      symbolName: tail,
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractGoImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  let inBlock = false;
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('import (')) {
      inBlock = true;
      return;
    }
    if (inBlock && trimmed === ')') {
      inBlock = false;
      return;
    }
    const target = inBlock
      ? trimmed
      : trimmed.startsWith('import ')
        ? trimmed.slice('import '.length).trim()
        : '';
    if (!target) return;
    const match = target.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s+|_\s+)?["`]([^"`]+)["`]/);
    if (!match?.[1]) return;
    imports.push({
      modulePath: match[1],
      symbolName: '',
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractKotlinImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^\s*import\s+([A-Za-z0-9_.*]+)\s*$/);
    if (!match?.[1]) return;
    const raw = match[1];
    const pieces = raw.split('.');
    const tail = pieces[pieces.length - 1] || '';
    imports.push({
      modulePath: raw,
      symbolName: tail === '*' ? '' : tail,
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractRustImports(lines: string[]): CodeSearchImport[] {
  const imports: CodeSearchImport[] = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^\s*(?:pub\s+)?use\s+(.+?)\s*;/);
    if (!match?.[1]) return;
    const raw = match[1].trim();
    const braceMatch = raw.match(/^([A-Za-z0-9_:]+)::\{(.+)\}$/);
    if (braceMatch?.[1] && braceMatch[2]) {
      braceMatch[2]
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const name = entry.split(/\s+as\s+/)[0]?.trim() || '';
          imports.push({
            modulePath: braceMatch[1] || '',
            symbolName: name === 'self' ? '' : name,
            line: lineIndex + 1,
            signature: line.trim(),
          });
        });
      return;
    }
    const pieces = raw.split('::');
    const tail = pieces[pieces.length - 1] || '';
    imports.push({
      modulePath: raw,
      symbolName: tail === '*' ? '' : tail,
      line: lineIndex + 1,
      signature: line.trim(),
    });
  });
  return imports;
}

function extractSymbolsRegex(language: string, rawLines: string[]): CodeSearchSymbol[] {
  const linesForSymbols =
    language === 'java' || language === 'scala' || language === 'kotlin'
      ? joinMultilineSignatures(rawLines)
      : rawLines;
  return extractSymbols(language, linesForSymbols);
}

function dedupeSymbols(symbols: CodeSearchSymbol[]): CodeSearchSymbol[] {
  const deduped = new Map<string, CodeSearchSymbol>();
  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line}`;
    if (!deduped.has(key)) {
      deduped.set(key, symbol);
    }
  }
  return Array.from(deduped.values()).sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    return left.name.localeCompare(right.name);
  });
}

function extractTermsFromFile(
  relativePath: string,
  content: string,
  symbols: CodeSearchSymbol[],
  imports: CodeSearchImport[],
): string[] {
  const frequency = new Map<string, number>();
  const pathTerms = tokenize(relativePath);
  const contentTerms = tokenize(content).slice(0, 2_000);
  const symbolTerms = symbols.flatMap((symbol) => tokenize(symbol.name));
  const importTerms = imports.flatMap((entry) =>
    tokenize(`${entry.modulePath} ${entry.symbolName}`),
  );

  for (const term of [
    ...pathTerms,
    ...symbolTerms,
    ...importTerms,
    ...contentTerms,
  ]) {
    if (!term || STOP_TERMS.has(term)) continue;
    frequency.set(term, (frequency.get(term) || 0) + 1);
  }

  return Array.from(frequency.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .map(([term]) => term);
}

export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .flatMap((part) => splitCompoundToken(part))
    .filter((part) => part.length >= 2 && part.length <= 48);
}

export function splitCompoundToken(token: string): string[] {
  if (!token) return [];
  const pieces = token.split(/_+/).filter(Boolean);
  if (pieces.length > 1) return pieces;
  return [token];
}

export function getFileImports(file: CodeSearchFile): CodeSearchImport[] {
  if (file.imports.length > 0) return file.imports;
  const lines = readFileLines(file.absolutePath);
  return extractImports(file.language, lines);
}

export function readFileLines(absolutePath: string): string[] {
  try {
    return fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}
