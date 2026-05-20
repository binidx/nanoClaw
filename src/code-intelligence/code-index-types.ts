export type CodeIndexStatus = 'missing' | 'building' | 'ready' | 'error';
export type CodeIndexSummarySource = 'fallback' | 'ai' | 'cache';

export type CodeIndexStage =
  | 'idle'
  | 'scan'
  | 'symbols'
  | 'chunks'
  | 'functions'
  | 'summaries'
  | 'embeddings'
  | 'complete';

export interface CodeIndexCapabilities {
  chunkSearch: boolean;
  fileSummaries: boolean;
  functionGraph: boolean;
  embeddings: boolean;
}

export type CodeIndexSourceKind =
  | 'remote_worktree'
  | 'mirror'
  | 'workspace'
  | 'unknown';

export interface CodeIndexStats {
  fileCount: number;
  chunkCount: number;
  functionCount: number;
  functionEdgeCount: number;
  totalLines: number;
  embeddedChunkCount: number;
}

export interface CodeIndexProgress {
  repositoryId: string;
  branch: string;
  status: CodeIndexStatus;
  stage: CodeIndexStage;
  processedFiles: number;
  totalFiles: number;
  queuedFiles?: number;
  activeFiles?: string[];
  failedFiles?: number;
  concurrency?: number;
  message: string;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface CodeIndexSnapshotMeta {
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  sourceKind?: CodeIndexSourceKind;
  sourceBranch?: string;
  sourceHeadSha?: string;
  manifestHash: string;
  status: CodeIndexStatus;
  stage: CodeIndexStage;
  generatedAt: string | null;
  stats: CodeIndexStats;
  capabilities: CodeIndexCapabilities;
  baseReady?: boolean;
  summaryReady?: boolean;
  embeddingsReady?: boolean;
  progress: Omit<CodeIndexProgress, 'repositoryId' | 'branch'>;
}

export interface CodeIndexFileRecord {
  relativePath: string;
  language: string;
  byteSize: number;
  lineCount: number;
  fileHash: string;
  rank: number;
  importCount: number;
  exportCount: number;
  summary: string;
  summarySource: CodeIndexSummarySource;
}

export interface CodeIndexChunkRecord {
  id: string;
  filePath: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  summary: string;
  contentHash: string;
  summarySource: CodeIndexSummarySource;
}

export interface CodeIndexFunctionRecord {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  line: number;
  column: number;
  parentFunctionId: string | null;
}

export interface CodeIndexFunctionEdgeRecord {
  id: string;
  fromFunctionId: string;
  toFunctionId: string;
  edgeType: 'call';
  symbol: string;
  line: number;
}

export interface CodeIndexSnapshot {
  meta: CodeIndexSnapshotMeta;
  files: CodeIndexFileRecord[];
  chunks: CodeIndexChunkRecord[];
  functions: CodeIndexFunctionRecord[];
  functionEdges: CodeIndexFunctionEdgeRecord[];
}

export interface CodeIndexSearchResult {
  chunkId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  matchedBy: 'hybrid' | 'vector' | 'term';
  summary: string;
  summarySource: CodeIndexSummarySource;
  fileSummary: string;
  fileSummarySource: CodeIndexSummarySource;
  preview: string;
}

export interface CodeIndexFileDetail {
  file: CodeIndexFileRecord | null;
  chunks: CodeIndexChunkRecord[];
}

export interface CodeIndexFunctionDependencyResponse {
  focus: CodeIndexFunctionRecord | null;
  upstream: Array<{ edge: CodeIndexFunctionEdgeRecord; node: CodeIndexFunctionRecord }>;
  downstream: Array<{ edge: CodeIndexFunctionEdgeRecord; node: CodeIndexFunctionRecord }>;
}
