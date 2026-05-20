import { searchMemoryDocuments } from '../db.js';
import { searchKnowledge } from '../knowledge/retrieval.js';
import { buildQueryVariants } from './query-planner.js';
import {
  applyLocalRerank,
  applyTextMmr,
  filterCandidatesByTags,
  fuseCandidates,
} from './fusion.js';
import type {
  RetrievalCandidate,
  RetrievalMemoryScope,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalSource,
  RetrievalTrace,
  RetrievalTraceStage,
} from './types.js';

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 50;
const DEFAULT_CANDIDATE_LIMIT = 32;
const MAX_CANDIDATE_LIMIT = 80;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? Math.trunc(value)
    : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sourceForMemoryType(sourceType: string): RetrievalSource {
  if (sourceType === 'identity_memory') return 'identity_memory';
  if (sourceType === 'user_memory') return 'user_memory';
  return 'memory_doc';
}

function normalizeMemoryScope(input?: RetrievalMemoryScope): RetrievalMemoryScope {
  return {
    scopes: input?.scopes?.filter((scope) =>
      scope === 'group' || scope === 'global' || scope === 'workspace',
    ),
    ownerType: input?.ownerType,
    ownerId: input?.ownerId,
    sourceTypes: input?.sourceTypes?.filter((value) => typeof value === 'string' && value),
  };
}

async function collectKnowledgeCandidates(input: {
  queryVariant: string;
  kbIds?: string[];
  limit: number;
  minScore: number;
  stages: RetrievalTraceStage[];
}): Promise<RetrievalCandidate[]> {
  const startedAt = Date.now();
  const result = await searchKnowledge(input.queryVariant, {
    kbIds: input.kbIds,
    topK: input.limit,
    minScore: input.minScore,
  });
  const candidates: RetrievalCandidate[] = [];
  let rank = 1;
  for (const chunk of result.chunks) {
    candidates.push({
      id: `knowledge_chunk:${chunk.chunkId}`,
      source: 'knowledge_chunk',
      sourceType: 'knowledge_chunk',
      title: chunk.filename,
      content: chunk.content,
      rawScore: chunk.score,
      score: chunk.score,
      rank,
      queryVariant: input.queryVariant,
      metadata: {
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        chunkIndex: chunk.chunkIndex,
        filename: chunk.filename,
        kbName: chunk.kbName,
        docPath: chunk.docPath,
        publishedAt: chunk.publishedAt,
        docSummary: chunk.docSummary,
        parentSummary: chunk.parentSummary,
        enhancementLevel: chunk.enhancementLevel,
      },
    });
    rank += 1;
  }

  for (const wiki of result.wiki) {
    candidates.push({
      id: `knowledge_wiki:${wiki.pageId}`,
      source: 'knowledge_wiki',
      sourceType: wiki.pageType,
      title: wiki.title,
      content: wiki.content,
      rawScore: wiki.score,
      score: wiki.score,
      rank,
      queryVariant: input.queryVariant,
      metadata: {
        pageId: wiki.pageId,
        kbId: wiki.kbId,
        pageType: wiki.pageType,
        sourceDocIds: wiki.sourceDocIds,
        isStale: wiki.isStale,
      },
      evidence: [
        ...wiki.evidenceChunks.map((chunk) => ({
          id: `knowledge_chunk:${chunk.chunkId}`,
          content: chunk.content,
          score: chunk.score,
          metadata: {
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            filename: chunk.filename,
            chunkIndex: chunk.chunkIndex,
          },
        })),
        ...(wiki.claimEvidence ?? []).map((claim) => ({
          id: claim.claimId,
          content: claim.claimText,
          score: claim.confidence,
          metadata: {
            chunkId: claim.chunkId,
            documentId: claim.documentId,
            filename: claim.filename,
          },
        })),
      ],
    });
    rank += 1;
  }

  input.stages.push({
    name: 'knowledge',
    queryVariant: input.queryVariant,
    candidateCount: candidates.length,
    latencyMs: Date.now() - startedAt,
    metadata: {
      chunks: result.chunks.length,
      wiki: result.wiki.length,
    },
  });
  return candidates;
}

async function collectMemoryCandidates(input: {
  queryVariant: string;
  limit: number;
  memory?: RetrievalMemoryScope;
  stages: RetrievalTraceStage[];
}): Promise<RetrievalCandidate[]> {
  const startedAt = Date.now();
  const memory = normalizeMemoryScope(input.memory);
  const rows = await searchMemoryDocuments(input.queryVariant, {
    limit: input.limit,
    scopes: memory.scopes,
    ownerType: memory.ownerType,
    ownerId: memory.ownerId,
    sourceTypes: memory.sourceTypes as any,
  });
  const candidates = rows.map((row, index): RetrievalCandidate => ({
    id: `memory:${row.docId}`,
    source: sourceForMemoryType(row.sourceType),
    sourceType: row.sourceType,
    title: row.title,
    content: row.body,
    rawScore: row.score,
    score: row.score,
    rank: index + 1,
    queryVariant: input.queryVariant,
    metadata: {
      ...parseJsonObject(row.metadataJson),
      docId: row.docId,
      scope: row.scope,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      pathRef: row.pathRef,
      updatedAt: row.updatedAt,
      textScore: row.textScore,
      sourceBoost: row.sourceBoost,
      recencyBoost: row.recencyBoost,
      exactMatchBoost: row.exactMatchBoost,
    },
  }));
  input.stages.push({
    name: 'memory',
    queryVariant: input.queryVariant,
    candidateCount: candidates.length,
    latencyMs: Date.now() - startedAt,
    metadata: {
      ownerType: memory.ownerType,
      ownerId: memory.ownerId,
      sourceTypes: memory.sourceTypes,
    },
  });
  return candidates;
}

export async function retrieveContext(
  request: RetrievalRequest,
): Promise<RetrievalResponse> {
  const startedAt = Date.now();
  const topK = clampInt(request.topK, DEFAULT_TOP_K, 1, MAX_TOP_K);
  const strategy = request.strategy ?? {};
  const candidateLimit = clampInt(
    strategy.candidateLimit,
    Math.max(DEFAULT_CANDIDATE_LIMIT, topK * 4),
    topK,
    MAX_CANDIDATE_LIMIT,
  );
  const minScore = typeof request.minScore === 'number' && Number.isFinite(request.minScore)
    ? request.minScore
    : 0.3;
  const includeKnowledge = request.includeKnowledge !== false;
  const includeMemory = request.includeMemory === true;
  const queryVariants = buildQueryVariants(request.query, strategy);
  const stages: RetrievalTraceStage[] = [];

  const collected: RetrievalCandidate[] = [];
  for (const queryVariant of queryVariants) {
    const variantTasks: Array<Promise<RetrievalCandidate[]>> = [];
    if (includeKnowledge) {
      variantTasks.push(
        collectKnowledgeCandidates({
          queryVariant,
          kbIds: request.kbIds,
          limit: candidateLimit,
          minScore,
          stages,
        }),
      );
    }
    if (includeMemory) {
      variantTasks.push(
        collectMemoryCandidates({
          queryVariant,
          limit: candidateLimit,
          memory: request.memory,
          stages,
        }),
      );
    }
    const results = await Promise.all(variantTasks);
    collected.push(...results.flat());
  }

  const filtered = filterCandidatesByTags(collected, strategy.requiredTags);
  let ranked = fuseCandidates(filtered);
  if ((strategy.rerank ?? 'local') === 'local') {
    ranked = applyLocalRerank(request.query, ranked.slice(0, candidateLimit));
  }
  ranked = strategy.mmr === false
    ? ranked.slice(0, topK)
    : applyTextMmr(ranked, topK);
  ranked = ranked.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));

  const trace: RetrievalTrace = {
    query: request.query,
    queryVariants,
    stages,
    strategy: {
      multiQuery: strategy.multiQuery === true,
      mmr: strategy.mmr !== false,
      rerank: strategy.rerank ?? 'local',
    },
    candidateCount: collected.length,
    returnedCount: ranked.length,
    latencyMs: Date.now() - startedAt,
  };

  return { candidates: ranked, trace };
}
