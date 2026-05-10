import i18n from '../../i18n/index.ts';

export interface CodeMapSymbol {
  name: string;
  kind: string;
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

export interface CodeMapStats {
  repositoryId: string;
  branch: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  totalLines: number;
  generatedAt: string | null;
  status: 'fresh' | 'stale' | 'building' | 'missing';
}

export type CodeIndexStatus = 'missing' | 'building' | 'ready' | 'error';
export type CodeIndexSummarySource = 'fallback' | 'ai' | 'cache';
export type CodeIndexSourceKind =
  | 'remote_worktree'
  | 'mirror'
  | 'workspace'
  | 'unknown';
export type CodeIndexStage =
  | 'idle'
  | 'scan'
  | 'symbols'
  | 'chunks'
  | 'functions'
  | 'summaries'
  | 'embeddings'
  | 'complete';

export interface CodeIndexProgress {
  repositoryId: string;
  branch: string;
  status: CodeIndexStatus;
  stage: CodeIndexStage;
  processedFiles: number;
  totalFiles: number;
  message: string;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface CodeIndexCapabilities {
  chunkSearch: boolean;
  fileSummaries: boolean;
  functionGraph: boolean;
  embeddings: boolean;
}

export interface CodeIndexStats {
  fileCount: number;
  chunkCount: number;
  functionCount: number;
  functionEdgeCount: number;
  totalLines: number;
  embeddedChunkCount: number;
}

export interface CodeIndexMeta {
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
  progress: CodeIndexProgress;
}

export interface CodeIndexStatusResponse {
  meta: CodeIndexMeta | null;
  progress: CodeIndexProgress;
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

export interface CodeIndexFileDetail {
  file: CodeIndexFileRecord | null;
  chunks: CodeIndexChunkRecord[];
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

export interface CodeIndexFunctionDepsResponse {
  focus: CodeIndexFunctionRecord | null;
  upstream: Array<{ edge: CodeIndexFunctionEdgeRecord; node: CodeIndexFunctionRecord }>;
  downstream: Array<{ edge: CodeIndexFunctionEdgeRecord; node: CodeIndexFunctionRecord }>;
}

export interface CodeMapFetchResult {
  source: string;
  snapshot: CodeMapSnapshot | null;
  status?: string;
}

export async function fetchCodeMap(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<CodeMapFetchResult> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchCodeMapStats(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<CodeMapStats> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/stats?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchAiSummary(
  apiBase: string,
  repositoryId: string,
  branch: string,
  target: { filePath?: string; dirPath?: string },
): Promise<{ summary: string; cached: boolean }> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/ai-summary?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export interface CodeRef {
  file: string;
  line: number;
  snippet: string;
  label: string;
}

export interface AiSection {
  id: string;
  title: string;
  description: string;
  codeRefs: CodeRef[];
  children?: AiSection[];
}

export interface AiAnalysis {
  title: string;
  summary: string;
  sections: AiSection[];
}

export interface AiAnalysisStreamCallbacks {
  onStatus?: (message: string) => void;
  onChunk?: (text: string) => void;
  onDone?: (analysis: AiAnalysis, cached: boolean) => void;
  onError?: (message: string) => void;
}

export async function fetchAiAnalysisStream(
  apiBase: string,
  repositoryId: string,
  branch: string,
  target: { filePath?: string; dirPath?: string; forceRefresh?: boolean },
  callbacks: AiAnalysisStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/ai-analysis?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
    signal,
  });

  if (!resp.ok) {
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await resp.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
    }
    throw new Error(`HTTP ${resp.status}`);
  }

  const contentType = resp.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const json = await resp.json() as { analysis: AiAnalysis; cached: boolean };
    callbacks.onDone?.(json.analysis, json.cached);
    return;
  }

  if (!resp.body) throw new Error('No response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const lines = part.split('\n');
        let eventType = '';
        let eventData = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) eventData = line.slice(6);
        }
        if (!eventType || !eventData) continue;

        try {
          const parsed = JSON.parse(eventData);
          switch (eventType) {
            case 'status':
              callbacks.onStatus?.(parsed.message || '');
              break;
            case 'chunk':
              callbacks.onChunk?.(parsed.text || '');
              break;
            case 'done':
              callbacks.onDone?.(parsed.analysis, !!parsed.cached);
              break;
            case 'error':
              callbacks.onError?.(parsed.message || i18n.t('api.unknownError', { ns: 'codeMap' }));
              break;
          }
        } catch { /* skip malformed events */ }
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchAiAnalysisCached(
  apiBase: string,
  repositoryId: string,
  branch: string,
  target: { filePath?: string; dirPath?: string },
): Promise<{ analysis: AiAnalysis | null; cached: boolean }> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/ai-analysis?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, cacheOnly: true }),
  });
  if (!resp.ok) return { analysis: null, cached: false };
  return resp.json();
}

export async function fetchFileContent(
  apiBase: string,
  repositoryId: string,
  branch: string,
  filePath: string,
): Promise<{ content: string; language: string; lineCount: number; filePath: string }> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/file-content?branch=${encodeURIComponent(branch)}&file=${encodeURIComponent(filePath)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function rebuildCodeMap(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<void> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/rebuild?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  await rebuildCodeIndex(apiBase, repositoryId, branch);
}

export async function fetchCodeIndexStatus(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<CodeIndexStatusResponse> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/status?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchCodeIndexProgress(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<CodeIndexProgress> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/progress?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function rebuildCodeIndex(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<CodeIndexMeta | null> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/rebuild?branch=${encodeURIComponent(branch)}&enableAiSummaries=1&enableEmbeddings=1`;
  const resp = await fetch(url, { method: 'POST' });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  const json = await resp.json() as { meta?: CodeIndexMeta | null };
  return json.meta ?? null;
}

export async function searchCodeIndex(
  apiBase: string,
  repositoryId: string,
  branch: string,
  query: string,
  limit = 8,
): Promise<{ results: CodeIndexSearchResult[]; meta: CodeIndexMeta }> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/search?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function listCodeIndexFunctions(
  apiBase: string,
  repositoryId: string,
  branch: string,
  params: { filePath?: string; query?: string; line?: number },
): Promise<{ functions: CodeIndexFunctionRecord[] }> {
  const search = new URLSearchParams({ branch });
  if (params.filePath) search.set('filePath', params.filePath);
  if (params.query) search.set('query', params.query);
  if (params.line) search.set('line', String(params.line));
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/functions?${search.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchCodeIndexFunctionDeps(
  apiBase: string,
  repositoryId: string,
  branch: string,
  functionId: string,
  depth = 1,
): Promise<CodeIndexFunctionDepsResponse> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/functions/${encodeURIComponent(functionId)}/deps?branch=${encodeURIComponent(branch)}&depth=${depth}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchCodeIndexFileDetail(
  apiBase: string,
  repositoryId: string,
  branch: string,
  filePath: string,
): Promise<CodeIndexFileDetail> {
  const url = `${apiBase}/api/code-index/${encodeURIComponent(repositoryId)}/files/${encodeURIComponent(filePath)}?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// --- Repo Description ---

export interface RepoModule {
  name: string;
  directory: string;
  description: string;
  keyFiles: string[];
  fileCount: number;
  lineCount: number;
}

export interface RepoEntryPoint {
  file: string;
  description: string;
}

export interface RepoDescription {
  repositoryId: string;
  branch: string;
  manifestHash: string;
  overview: string;
  techStack: string[];
  architecture: string;
  modules: RepoModule[];
  entryPoints: RepoEntryPoint[];
  stats: {
    languages: Record<string, number>;
    totalFiles: number;
    totalLines: number;
    totalSymbols: number;
  };
  generatedAt: string;
}

export async function fetchRepoDescription(
  apiBase: string,
  repositoryId: string,
  branch: string,
): Promise<{ description: RepoDescription | null; cached: boolean }> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/repo-description?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function generateRepoDescription(
  apiBase: string,
  repositoryId: string,
  branch: string,
  forceRefresh = false,
): Promise<{ description: RepoDescription; cached: boolean; noAi?: boolean }> {
  const url = `${apiBase}/api/code-map/${encodeURIComponent(repositoryId)}/repo-description?branch=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceRefresh }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export function getKindLabels(): Record<string, string> {
  return {
    class: i18n.t('symbols.class', { ns: 'codeMap' }),
    interface: i18n.t('symbols.interface', { ns: 'codeMap' }),
    type: i18n.t('symbols.type', { ns: 'codeMap' }),
    enum: i18n.t('symbols.enum', { ns: 'codeMap' }),
    function: i18n.t('symbols.function', { ns: 'codeMap' }),
    method: i18n.t('symbols.method', { ns: 'codeMap' }),
    const: i18n.t('symbols.const', { ns: 'codeMap' }),
    struct: i18n.t('symbols.struct', { ns: 'codeMap' }),
    trait: i18n.t('symbols.trait', { ns: 'codeMap' }),
    variable: i18n.t('symbols.variable', { ns: 'codeMap' }),
    module: i18n.t('symbols.module', { ns: 'codeMap' }),
    package: i18n.t('symbols.package', { ns: 'codeMap' }),
    namespace: i18n.t('symbols.namespace', { ns: 'codeMap' }),
    table: i18n.t('symbols.table', { ns: 'codeMap' }),
    view: i18n.t('symbols.view', { ns: 'codeMap' }),
    unknown: i18n.t('symbols.unknown', { ns: 'codeMap' }),
  };
}

/** @deprecated Use getKindLabels() for i18n-aware labels */
export const KIND_LABELS: Record<string, string> = getKindLabels();

export const KIND_COLORS: Record<string, string> = {
  class: '#3b82f6', interface: '#3b82f6',
  type: '#3b82f6', enum: '#f59e0b',
  function: '#8b5cf6', method: '#8b5cf6',
  const: '#10b981', variable: '#10b981',
  struct: '#f59e0b', trait: '#8b5cf6',
  module: '#6366f1', package: '#6366f1', namespace: '#6366f1',
  table: '#f59e0b', view: '#f59e0b',
  unknown: '#64748b',
};
