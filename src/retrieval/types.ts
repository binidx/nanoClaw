export type RetrievalSource =
  | 'knowledge_chunk'
  | 'knowledge_wiki'
  | 'memory_doc'
  | 'user_memory'
  | 'identity_memory';

export interface RetrievalStrategy {
  multiQuery?: boolean;
  mmr?: boolean;
  rerank?: 'none' | 'local';
  candidateLimit?: number;
  requiredTags?: string[];
  queryVariants?: string[];
}

export interface RetrievalMemoryScope {
  scopes?: Array<'group' | 'global' | 'workspace'>;
  ownerType?: 'group' | 'global' | 'person';
  ownerId?: string;
  sourceTypes?: string[];
}

export interface RetrievalRequest {
  query: string;
  topK?: number;
  minScore?: number;
  kbIds?: string[];
  includeKnowledge?: boolean;
  includeMemory?: boolean;
  memory?: RetrievalMemoryScope;
  strategy?: RetrievalStrategy;
}

export interface RetrievalCandidate {
  id: string;
  source: RetrievalSource;
  sourceType: string;
  content: string;
  title?: string;
  score: number;
  rawScore: number;
  rank: number;
  queryVariant: string;
  metadata: Record<string, unknown>;
  evidence?: Array<{
    id: string;
    content: string;
    score?: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface RetrievalTraceStage {
  name: string;
  queryVariant?: string;
  candidateCount: number;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export interface RetrievalTrace {
  query: string;
  queryVariants: string[];
  stages: RetrievalTraceStage[];
  strategy: Required<Pick<RetrievalStrategy, 'multiQuery' | 'mmr' | 'rerank'>>;
  candidateCount: number;
  returnedCount: number;
  latencyMs: number;
}

export interface RetrievalResponse {
  candidates: RetrievalCandidate[];
  trace: RetrievalTrace;
}
