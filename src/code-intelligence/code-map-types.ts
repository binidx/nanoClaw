import type { CodeSearchSymbol } from './code-search-types.js';

export interface CodeMapBuildOptions {
  maxFiles: number;
  maxFileBytes: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  pageRankIterations: number;
  pageRankDamping: number;
}

export interface CodeMapSymbol {
  name: string;
  kind: CodeSearchSymbol['kind'];
  line: number;
  column: number;
  signature: string;
  rank: number;
}

export interface CodeMapEdge {
  fromFile: string;
  toFile: string;
  symbols: string[];
}

export interface CodeMapFile {
  relativePath: string;
  language: string;
  lineCount: number;
  byteSize: number;
  symbols: CodeMapSymbol[];
  importCount: number;
  exportCount: number;
  rank: number;
}

export interface CodeMapSnapshot {
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  generatedAt: string;
  manifestHash: string;
  files: CodeMapFile[];
  edges: CodeMapEdge[];
  stats: {
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    totalLines: number;
  };
}

export interface CodeMapRenderOptions {
  maxTokens: number;
  groupByDirectory: boolean;
}

export interface CodeMapStats {
  repositoryId: string;
  branch: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  totalLines: number;
  generatedAt: string;
  status: 'fresh' | 'stale' | 'building' | 'missing';
}
