export interface CodeSearchBuildOptions {
  maxFiles: number;
  maxFileBytes: number;
  maxTermsPerFile: number;
  maxPreviewLines: number;
  includeGlobs: string[];
  excludeGlobs: string[];
}

export interface CodeSearchSymbol {
  name: string;
  kind:
    | 'class'
    | 'function'
    | 'interface'
    | 'namespace'
    | 'type'
    | 'enum'
    | 'const'
    | 'method'
    | 'table'
    | 'view'
    | 'struct'
    | 'trait'
    | 'variable'
    | 'module'
    | 'package'
    | 'unknown';
  line: number;
  column: number;
  signature: string;
}

export interface CodeSearchImport {
  modulePath: string;
  symbolName: string;
  line: number;
  signature: string;
}

export interface CodeSearchFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  language: string;
  byteSize: number;
  lineCount: number;
  terms: string[];
  symbols: CodeSearchSymbol[];
  imports: CodeSearchImport[];
  previews: string[];
}

export interface CodeSearchIndex {
  rootDirectory: string;
  generatedAt: string;
  options: CodeSearchBuildOptions;
  files: CodeSearchFile[];
  fileCount: number;
  symbolCount: number;
  termCount: number;
}

export interface CodeSearchQueryOptions {
  limit: number;
}

export interface CodeSearchResult {
  relativePath: string;
  language: string;
  score: number;
  matchedTerms: string[];
  matchedSymbols: Array<{
    name: string;
    kind: CodeSearchSymbol['kind'];
    line: number;
  }>;
  matchedImports: Array<{
    modulePath: string;
    symbolName: string;
    line: number;
  }>;
  previews: string[];
}

export interface CodeSymbolSearchResult {
  relativePath: string;
  language: string;
  score: number;
  matchedBy: 'symbol' | 'path' | 'content' | 'hybrid';
  symbol: {
    name: string;
    kind: CodeSearchSymbol['kind'];
    line: number;
    column: number;
    signature: string;
  };
  previews: string[];
}

export interface CodeReferenceHintResult {
  relativePath: string;
  language: string;
  score: number;
  matchedBy:
    | 'import'
    | 'static_import'
    | 'constructor'
    | 'invocation'
    | 'member_access'
    | 'comment'
    | 'content'
    | 'path'
    | 'package';
  symbol: string;
  line: number;
  preview: string;
}

export interface RelatedCodeSearchResult {
  kind: 'file' | 'symbol' | 'reference';
  relativePath: string;
  language: string;
  score: number;
  matchedBy: string;
  title: string;
  line: number;
  preview: string;
}

export interface CodeSearchPersistenceOptions {
  cacheKey?: string;
  buildOptions?: Partial<CodeSearchBuildOptions>;
  cacheNamespace?: string;
}

export interface CodeSearchCacheStatus {
  cacheKey: string;
  rootDirectory: string;
  status: 'missing' | 'fresh' | 'stale';
  manifestHash: string;
  persistedManifestHash: string | null;
  generatedAt: string | null;
  fileCount: number | null;
  symbolCount: number | null;
  termCount: number | null;
}

export interface CodeSearchLoadResult {
  cacheKey: string;
  rootDirectory: string;
  manifestHash: string;
  source: 'database' | 'rebuilt';
  index: CodeSearchIndex;
}
