import {
  dba,
  getEmbeddingsByOwnerBatch,
  getKnowledgeChunksByIds,
  getChunkKbIdMap,
  getProvider,
  listKnowledgeBases,
} from '../db.js';
import { getActiveEngine } from '../database/engine.js';
import { getPgFtsConfig } from '../database/pg-fts-config.js';
import { isMySqlFullTextUnsupportedError } from '../database/mysql-fulltext.js';
import { buildEmbeddingProviderFromAiProvider } from '../embedding/resolve.js';
import {
  cachedEmbedQuery,
  cosineSimilarity,
  deserializeEmbedding,
} from '../embedding/vector-store.js';
import {
  getKnowledgeSearchEngine,
  type KnowledgeFTSResult,
} from './knowledge-search-engine.js';
import { createModuleLogger } from '../logger.js';
import type { KnowledgeBaseRecord } from '../types.js';

const logger = createModuleLogger('knowledge');

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  chunkIndex: number;
  filename?: string;
  kbName?: string;
  docPath?: string | null;
  publishedAt?: string | null;
  docSummary?: string | null;
  parentSummary?: string | null;
  enhancementLevel?: string;
}

export interface WikiSearchResult {
  pageId: string;
  kbId: string;
  title: string;
  content: string;
  pageType: string;
  score: number;
  updatedAt: string;
  sourceDocIds: string[];
  isStale: boolean;
  evidenceChunks: Array<{
    chunkId: string;
    documentId: string;
    filename?: string;
    kbName?: string;
    content: string;
    chunkIndex: number;
    score: number;
  }>;
  claimEvidence?: Array<{
    claimId: string;
    claimText: string;
    confidence: number;
    chunkId: string | null;
    documentId: string | null;
    filename?: string;
    content?: string;
  }>;
}

function normalizeWikiSearchQuery(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeKnowledgeQuery(s: string): string[] {
  return normalizeWikiSearchQuery(s)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function buildWikiFts5Match(q: string): string {
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

const STALE_WIKI_SCORE_FACTOR = 0.5;
const WIKI_EVIDENCE_CHUNKS_PER_PAGE = 2;
const MAX_WIKI_EVIDENCE_PAGES = 4;
const MIN_FTS_CANDIDATES = 40;
const MAX_FTS_CANDIDATES = 120;
const FTS_CANDIDATE_MULTIPLIER = 12;
const VECTOR_BLEND_ALPHA = 0.55;
const SLOW_KNOWLEDGE_SEARCH_WARN_MS = 1500;

export function computeWikiQualityMultiplier(
  pageType: string,
  sourceDocCount: number,
  content: string,
  claimCount = 0,
  evidencedClaimCount = 0,
): number {
  let factor = 1;
  if (pageType === 'overview') factor *= 0.22;
  else if (pageType === 'comparison') factor *= 0.78;
  else if (pageType === 'synthesis') factor *= 1.1;
  else factor *= 1.04;

  if (sourceDocCount <= 0) factor *= 0.5;
  else if (sourceDocCount === 1) factor *= 0.82;
  else if (sourceDocCount >= 3) factor *= 1.08;

  const contentLength = content.trim().length;
  if (contentLength < 120) factor *= 0.55;
  else if (contentLength < 260) factor *= 0.8;

  if (claimCount > 0) {
    factor *= 1 + Math.min(claimCount, 4) * 0.03;
    const evidenceRatio = Math.max(0, Math.min(1, evidencedClaimCount / claimCount));
    factor *= 0.92 + evidenceRatio * 0.16;
  } else if (pageType !== 'overview') {
    factor *= 0.9;
  }

  return factor;
}

export function computeWikiTitleMultiplier(
  title: string,
  normalizedQuery: string,
  queryTokens: string[],
): number {
  const normalizedTitle = normalizeWikiSearchQuery(title).toLowerCase();
  const normalizedQueryLower = normalizedQuery.toLowerCase();
  if (!normalizedTitle) return 1;
  if (normalizedQueryLower && normalizedTitle === normalizedQueryLower) return 1.22;
  if (normalizedQueryLower && normalizedTitle.includes(normalizedQueryLower)) return 1.12;
  if (queryTokens.length === 0) return 1;

  let matched = 0;
  for (const token of queryTokens) {
    if (normalizedTitle.includes(token)) matched += 1;
  }
  const coverage = matched / queryTokens.length;
  if (coverage >= 0.8) return 1.08;
  if (coverage >= 0.5) return 1.04;
  return 1;
}

function scoreWikiEvidenceChunk(
  normalizedQuery: string,
  queryTokens: string[],
  content: string,
  filename: string,
): number {
  const haystack = `${filename}\n${content}`.toLowerCase();
  let score = 0;
  if (normalizedQuery && haystack.includes(normalizedQuery.toLowerCase())) {
    score += 3;
  }
  let matched = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) matched += 1;
  }
  if (queryTokens.length > 0) {
    score += (matched / queryTokens.length) * 2;
  }
  if (filename && queryTokens.some((token) => filename.toLowerCase().includes(token))) {
    score += 0.35;
  }
  return score;
}

async function searchWikiPages(
  query: string,
  kbIds: string[],
  topK: number,
): Promise<WikiSearchResult[]> {
  if (kbIds.length === 0) return [];

  const normalized = normalizeWikiSearchQuery(query);
  if (!normalized) return [];
  const queryTokens = tokenizeKnowledgeQuery(query);

  const engine = getActiveEngine();
  const dialect = engine.dialect;

  const kbPlaceholders = kbIds.map(() => '?').join(', ');
  let rows: Array<{
    id: string;
    kb_id: string;
    title: string;
    content: string;
    page_type: string;
    updated_at: string;
    source_doc_ids: string | null;
    rank?: number;
    relevance?: number;
  }>;

  if (dialect === 'sqlite') {
    const matchQuery = buildWikiFts5Match(normalized);
    if (!matchQuery) return [];
    rows = (await dba
      .prepare(
        `SELECT wp.id, wp.kb_id, wp.title, wp.content, wp.page_type, wp.updated_at, wp.source_doc_ids,
                bm25(knowledge_wiki_pages_fts) AS rank
         FROM knowledge_wiki_pages_fts fts
         JOIN knowledge_wiki_pages wp ON wp.rowid = fts.rowid
         WHERE knowledge_wiki_pages_fts MATCH ? AND wp.kb_id IN (${kbPlaceholders})
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(matchQuery, ...kbIds, topK)) as typeof rows;
    if (rows.length === 0) {
      const terms = normalized.split(/\s+/).filter(Boolean);
      if (terms.length > 0) {
        const likeParts = terms.map(() => '(title LIKE ? OR content LIKE ?)');
        const likeParams: unknown[] = [];
        for (const term of terms) {
          const like = `%${term}%`;
          likeParams.push(like, like);
        }
        rows = (await dba
          .prepare(
            `SELECT id, kb_id, title, content, page_type, updated_at, source_doc_ids,
                    0 as relevance
             FROM knowledge_wiki_pages
             WHERE (${likeParts.join(' AND ')}) AND kb_id IN (${kbPlaceholders})
             ORDER BY updated_at DESC, id ASC
             LIMIT ?`,
          )
          .all(...likeParams, ...kbIds, topK)) as typeof rows;
      }
    }
  } else if (dialect === 'mysql') {
    try {
      rows = (await dba
        .prepare(
          `SELECT id, kb_id, title, content, page_type, updated_at, source_doc_ids,
                  MATCH(title, content) AGAINST(? IN BOOLEAN MODE) as relevance
           FROM knowledge_wiki_pages
           WHERE MATCH(title, content) AGAINST(? IN BOOLEAN MODE) AND kb_id IN (${kbPlaceholders})
           ORDER BY relevance DESC
           LIMIT ?`,
        )
        .all(normalized, normalized, ...kbIds, topK)) as typeof rows;
    } catch (err) {
      if (!isMySqlFullTextUnsupportedError(err)) throw err;
      const terms = normalized.split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const likeParts = terms.map(() => '(title LIKE ? OR content LIKE ?)');
      const likeParams: unknown[] = [];
      for (const term of terms) {
        const like = `%${term}%`;
        likeParams.push(like, like);
      }
      rows = (await dba
        .prepare(
          `SELECT id, kb_id, title, content, page_type, updated_at, source_doc_ids,
                  0 as relevance
           FROM knowledge_wiki_pages
           WHERE (${likeParts.join(' AND ')}) AND kb_id IN (${kbPlaceholders})
           ORDER BY updated_at DESC, id ASC
           LIMIT ?`,
        )
        .all(...likeParams, ...kbIds, topK)) as typeof rows;
    }
  } else {
    const cfg = getPgFtsConfig();
    if (!normalized.trim()) return [];
    rows = (await dba
      .prepare(
        `SELECT id, kb_id, title, content, page_type, updated_at, source_doc_ids,
                ts_rank(search_vector, plainto_tsquery('${cfg}', ?)) as relevance
         FROM knowledge_wiki_pages
         WHERE search_vector @@ plainto_tsquery('${cfg}', ?) AND kb_id IN (${kbPlaceholders})
         ORDER BY relevance DESC
         LIMIT ?`,
      )
      .all(normalized, normalized, ...kbIds, topK)) as typeof rows;
  }

  const parsed = rows.map((row) => {
    const sourceDocIds: string[] = (() => {
      try {
        const arr = JSON.parse(row.source_doc_ids || '[]');
        return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : [];
      } catch { return []; }
    })();
    return { row, sourceDocIds };
  });

  const pageClaimStats = new Map<string, { claimCount: number; evidencedClaimCount: number }>();
  if (parsed.length > 0) {
    const pageIds = parsed.map((item) => item.row.id);
    const placeholders = pageIds.map(() => '?').join(', ');
    const claimRows = (await dba.prepare(
      `SELECT page_id,
              COUNT(*) AS claim_count,
              SUM(CASE WHEN evidence_chunk_id IS NOT NULL THEN 1 ELSE 0 END) AS evidenced_claim_count
       FROM knowledge_wiki_claims
       WHERE page_id IN (${placeholders})
       GROUP BY page_id`,
    ).all(...pageIds)) as Array<{
      page_id: string;
      claim_count: number;
      evidenced_claim_count: number | null;
    }>;
    for (const row of claimRows) {
      pageClaimStats.set(row.page_id, {
        claimCount: Number(row.claim_count ?? 0),
        evidencedClaimCount: Number(row.evidenced_claim_count ?? 0),
      });
    }
  }

  const allSourceIds = [...new Set(parsed.flatMap((p) => p.sourceDocIds))];
  const docMaxUpdated = new Map<string, string>();
  if (allSourceIds.length > 0) {
    const batchSize = 200;
    for (let i = 0; i < allSourceIds.length; i += batchSize) {
      const batch = allSourceIds.slice(i, i + batchSize);
      const ph = batch.map(() => '?').join(', ');
      const docRows = (await dba
        .prepare(`SELECT id, updated_at FROM knowledge_documents WHERE id IN (${ph})`)
        .all(...batch)) as Array<{ id: string; updated_at: string }>;
      for (const d of docRows) docMaxUpdated.set(d.id, d.updated_at);
    }
  }

  const results: WikiSearchResult[] = parsed.map(({ row, sourceDocIds }) => {
    const claimStats = pageClaimStats.get(row.id);
    let isStale = false;
    if (sourceDocIds.length > 0) {
      const latestSrc = sourceDocIds.reduce<string | null>((max, id) => {
        const u = docMaxUpdated.get(id);
        return u && (!max || u > max) ? u : max;
      }, null);
      if (latestSrc && latestSrc > row.updated_at) isStale = true;
    }
    // Stale wiki pages still surface (UI may flag them) but rank below fresh ones.
    const baseScore = Math.abs(row.rank ?? row.relevance ?? 0);
    const freshnessScore = isStale ? baseScore * STALE_WIKI_SCORE_FACTOR : baseScore;
    const score = freshnessScore
      * computeWikiTitleMultiplier(row.title, normalized, queryTokens)
      * computeWikiQualityMultiplier(
        row.page_type,
        sourceDocIds.length,
        row.content,
        claimStats?.claimCount ?? 0,
        claimStats?.evidencedClaimCount ?? 0,
      );
    return {
      pageId: row.id, kbId: row.kb_id, title: row.title, content: row.content,
      pageType: row.page_type, score,
      updatedAt: row.updated_at, sourceDocIds, isStale, evidenceChunks: [],
    };
  }).sort((a, b) => b.score - a.score);

  await attachWikiEvidenceChunks(
    query,
    results.slice(0, Math.min(results.length, MAX_WIKI_EVIDENCE_PAGES)),
  );
  return results;
}

async function attachWikiEvidenceChunks(
  query: string,
  results: WikiSearchResult[],
): Promise<void> {
  if (results.length === 0) return;
  const { loadWikiClaimsWithEvidence } = await import('./wiki-claims.js');
  const claimMap = await loadWikiClaimsWithEvidence(results.map((result) => result.pageId));
  const claimBackedChunkIds = new Set<string>();
  for (const result of results) {
    const claims = claimMap.get(result.pageId) ?? [];
    const claimEvidence = claims
      .map((claim) => ({
        claimId: claim.id,
        claimText: claim.claim_text,
        confidence: claim.confidence,
        chunkId: claim.evidence?.chunkId ?? null,
        documentId: claim.evidence?.documentId ?? claim.source_doc_id,
        filename: claim.evidence?.filename ?? undefined,
        content: claim.evidence?.content,
      }))
      .slice(0, WIKI_EVIDENCE_CHUNKS_PER_PAGE);
    result.claimEvidence = claimEvidence;
    for (const claim of claims) {
      if (claim.evidence?.chunkId) claimBackedChunkIds.add(claim.evidence.chunkId);
    }
    result.evidenceChunks = claims
      .filter((claim) => claim.evidence)
      .slice(0, WIKI_EVIDENCE_CHUNKS_PER_PAGE)
      .map((claim) => ({
        chunkId: claim.evidence!.chunkId,
        documentId: claim.evidence!.documentId,
        filename: claim.evidence!.filename ?? undefined,
        kbName: undefined,
        content: claim.evidence!.content,
        chunkIndex: claim.evidence!.chunkIndex,
        score: claim.confidence + 1,
      }));
  }
  const docIds = [...new Set(results.flatMap((result) => result.sourceDocIds))];
  if (docIds.length === 0) return;
  const placeholders = docIds.map(() => '?').join(', ');
  const rows = (await dba.prepare(
    `SELECT c.id AS chunk_id,
            c.document_id AS document_id,
            c.chunk_index AS chunk_index,
            c.content AS content,
            d.filename AS filename,
            d.kb_id AS kb_id,
            kb.name AS kb_name
     FROM knowledge_chunks c
     INNER JOIN knowledge_documents d ON d.id = c.document_id AND d.deleted_at IS NULL
     INNER JOIN knowledge_bases kb ON kb.id = d.kb_id AND kb.deleted_at IS NULL
     WHERE c.document_id IN (${placeholders})`,
  ).all(...docIds)) as Array<{
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    filename: string | null;
    kb_id: string;
    kb_name: string | null;
  }>;

  const chunksByDocId = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = chunksByDocId.get(row.document_id) ?? [];
    list.push(row);
    chunksByDocId.set(row.document_id, list);
  }

  const normalizedQuery = normalizeWikiSearchQuery(query);
  const queryTokens = tokenizeKnowledgeQuery(query);
  for (const result of results) {
    if (result.evidenceChunks.length >= WIKI_EVIDENCE_CHUNKS_PER_PAGE) continue;
    const candidates = result.sourceDocIds.flatMap((docId) => chunksByDocId.get(docId) ?? []);
    const scored = candidates
      .filter((candidate) => !claimBackedChunkIds.has(candidate.chunk_id))
      .map((candidate) => ({
        chunkId: candidate.chunk_id,
        documentId: candidate.document_id,
        filename: candidate.filename ?? undefined,
        kbName: candidate.kb_name ?? undefined,
        content: candidate.content.length > 420 ? `${candidate.content.slice(0, 417)}...` : candidate.content,
        chunkIndex: candidate.chunk_index,
        score: scoreWikiEvidenceChunk(
          normalizedQuery,
          queryTokens,
          candidate.content,
          candidate.filename ?? '',
        ),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.chunkIndex - right.chunkIndex);
    result.evidenceChunks = [
      ...result.evidenceChunks,
      ...scored.slice(0, WIKI_EVIDENCE_CHUNKS_PER_PAGE - result.evidenceChunks.length),
    ];
  }
}

function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => (max > 0 ? 1 : 0));
  return scores.map((s) => (s - min) / range);
}

function buildKnowledgeFtsCandidateLimit(topK: number): number {
  const requested = Math.max(topK * FTS_CANDIDATE_MULTIPLIER, MIN_FTS_CANDIDATES);
  return Math.min(requested, MAX_FTS_CANDIDATES);
}

const DEFAULT_TEMPORAL_HALF_LIFE_DAYS = 365;

function buildHalfLifeMap(kbIdList: string[], allKbs: KnowledgeBaseRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of kbIdList) {
    const kb = allKbs.find((k) => k.id === id);
    const halfLife = kb?.temporal_half_life_days;
    m.set(id, halfLife && halfLife > 0 ? halfLife : DEFAULT_TEMPORAL_HALF_LIFE_DAYS);
  }
  return m;
}

async function filterSuperseded(chunkIds: string[]): Promise<Set<string>> {
  if (chunkIds.length === 0) return new Set();
  const excluded = new Set<string>();
  const batchSize = 200;
  for (let i = 0; i < chunkIds.length; i += batchSize) {
    const batch = chunkIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = (await dba
      .prepare(
        `SELECT c.id FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.id IN (${placeholders}) AND d.superseded_by IS NOT NULL`,
      )
      .all(...batch)) as Array<{ id: string }>;
    for (const r of rows) excluded.add(r.id);
  }
  return excluded;
}

async function applyTemporalBoost(
  scored: Array<{ chunkId: string; documentId: string; combinedScore: number }>,
  halfLifeMap: Map<string, number>,
): Promise<void> {
  if (scored.length === 0 || halfLifeMap.size === 0) return;
  const docIds = [...new Set(scored.map((s) => s.documentId).filter(Boolean))];
  if (docIds.length === 0) return;
  const placeholders = docIds.map(() => '?').join(', ');
  const docs = (await dba
    .prepare(
      `SELECT id, kb_id, published_at, created_at FROM knowledge_documents WHERE id IN (${placeholders})`,
    )
    .all(...docIds)) as Array<{
      id: string;
      kb_id: string;
      published_at: string | null;
      created_at: string;
    }>;
  const docInfoMap = new Map<string, { time: number; kbId: string }>();
  const now = Date.now();
  for (const d of docs) {
    const dateStr = d.published_at || d.created_at;
    const t = new Date(dateStr).getTime();
    if (!Number.isFinite(t)) continue;
    docInfoMap.set(d.id, { time: t, kbId: d.kb_id });
  }
  for (const item of scored) {
    const info = docInfoMap.get(item.documentId);
    if (!info) continue;
    const halfLifeDays = halfLifeMap.get(info.kbId) ?? DEFAULT_TEMPORAL_HALF_LIFE_DAYS;
    const daysSince = (now - info.time) / 86400000;
    const recencyFactor = Math.max(0, 1 - daysSince / halfLifeDays);
    item.combinedScore *= 1 + recencyFactor * 0.4;
  }
}

/**
 * When several retrieved documents share the same parent_doc_id, lightly boost them
 * (sibling cluster signal). Requires at least two distinct documents under one parent.
 */
async function applySiblingBoost(
  scored: Array<{ chunkId: string; documentId: string; combinedScore: number }>,
): Promise<void> {
  const docIds = [...new Set(scored.map((s) => s.documentId).filter(Boolean))];
  if (docIds.length === 0) return;
  const placeholders = docIds.map(() => '?').join(', ');
  const docs = (await dba
    .prepare(`SELECT id, parent_doc_id FROM knowledge_documents WHERE id IN (${placeholders})`)
    .all(...docIds)) as Array<{ id: string; parent_doc_id: string | null }>;

  const byParent = new Map<string, Set<string>>();
  for (const d of docs) {
    if (!d.parent_doc_id) continue;
    if (!byParent.has(d.parent_doc_id)) byParent.set(d.parent_doc_id, new Set());
    byParent.get(d.parent_doc_id)!.add(d.id);
  }
  const boostedParents = new Set<string>();
  for (const [parent, set] of byParent) {
    if (set.size >= 2) boostedParents.add(parent);
  }
  if (boostedParents.size === 0) return;

  const parentByDoc = new Map(docs.map((d) => [d.id, d.parent_doc_id]));
  for (const item of scored) {
    const p = parentByDoc.get(item.documentId);
    if (p && boostedParents.has(p)) {
      item.combinedScore *= 1.1;
    }
  }
}

async function buildKnowledgeVectorScoreMap(
  query: string,
  candidateChunkIds: string[],
  kbEmbeddingProviderMap: Map<string, string | null>,
  minScore: number,
): Promise<Map<string, number>> {
  const uniqueChunkIds = [...new Set(candidateChunkIds)];
  const out = new Map<string, number>();
  if (uniqueChunkIds.length === 0) return out;

  const chunkKbMap = await getChunkKbIdMap(uniqueChunkIds);
  const chunksByProvider = new Map<string, string[]>();
  for (const chunkId of uniqueChunkIds) {
    const kbId = chunkKbMap.get(chunkId);
    if (!kbId) continue;
    const providerId = kbEmbeddingProviderMap.get(kbId);
    if (!providerId) continue;
    const list = chunksByProvider.get(providerId) ?? [];
    list.push(chunkId);
    chunksByProvider.set(providerId, list);
  }

  for (const [providerId, chunkIds] of chunksByProvider.entries()) {
    try {
      const providerRecord = await getProvider(providerId);
      const embeddingProvider = providerRecord
        ? buildEmbeddingProviderFromAiProvider(providerRecord)
        : null;
      if (!providerRecord || !embeddingProvider) {
        logger.warn(
          { providerId, candidateCount: chunkIds.length },
          'Knowledge vector rerank skipped invalid embedding provider',
        );
        continue;
      }

      const queryVec = await cachedEmbedQuery(embeddingProvider, query);
      const embeddingRows = await getEmbeddingsByOwnerBatch(
        'knowledge',
        chunkIds,
        providerRecord.id,
      );
      let dimensionMismatchCount = 0;
      for (const chunkId of chunkIds) {
        const row = embeddingRows.get(chunkId);
        if (!row) continue;
        const vec = deserializeEmbedding(row.embedding);
        if (vec.length !== queryVec.length) {
          dimensionMismatchCount += 1;
          continue;
        }
        const score = cosineSimilarity(queryVec, vec);
        if (score >= minScore) out.set(chunkId, score);
      }
      if (dimensionMismatchCount > 0) {
        logger.warn(
          {
            providerId,
            expectedDimensions: queryVec.length,
            skipped: dimensionMismatchCount,
            candidateCount: chunkIds.length,
          },
          'Knowledge vector rerank skipped candidate embeddings with mismatched dimensions',
        );
      }
    } catch (err) {
      logger.warn(
        { err, providerId, candidateCount: chunkIds.length },
        'Knowledge vector rerank failed for embedding provider, using FTS-only candidates',
      );
    }
  }

  return out;
}

async function enrichSearchResults(
  results: KnowledgeSearchResult[],
  kbEnhancementMap: Map<string, string>,
): Promise<void> {
  if (results.length === 0) return;

  const docIds = [...new Set(results.map((r) => r.documentId).filter(Boolean))];
  if (docIds.length === 0) return;

  const docPlaceholders = docIds.map(() => '?').join(', ');
  const docMetas = (await dba
    .prepare(
      `SELECT id, doc_path, published_at, parent_doc_id, kb_id FROM knowledge_documents WHERE id IN (${docPlaceholders})`,
    )
    .all(...docIds)) as Array<{
    id: string;
    doc_path: string | null;
    published_at: string | null;
    parent_doc_id: string | null;
    kb_id: string;
  }>;
  const docMetaMap = new Map(docMetas.map((d) => [d.id, d]));

  const summaryDocIds = new Set<string>();
  for (const result of results) {
    const meta = docMetaMap.get(result.documentId);
    if (!meta) continue;
    const level = kbEnhancementMap.get(meta.kb_id);
    if (level === 'wiki_lite' || level === 'wiki_full') {
      summaryDocIds.add(result.documentId);
      if (meta.parent_doc_id) summaryDocIds.add(meta.parent_doc_id);
    }
  }

  const summaryMap = new Map<string, string>();
  if (summaryDocIds.size > 0) {
    const summaryIds = [...summaryDocIds];
    const sumPlaceholders = summaryIds.map(() => '?').join(', ');
    const summaries = (await dba
      .prepare(
        `SELECT document_id, summary FROM knowledge_doc_summaries WHERE document_id IN (${sumPlaceholders})`,
      )
      .all(...summaryIds)) as Array<{ document_id: string; summary: string }>;
    for (const s of summaries) summaryMap.set(s.document_id, s.summary);
  }

  for (const result of results) {
    const meta = docMetaMap.get(result.documentId);
    if (meta) {
      result.docPath = meta.doc_path;
      result.publishedAt = meta.published_at;
      result.enhancementLevel = kbEnhancementMap.get(meta.kb_id);
    }

    const level = result.enhancementLevel;
    if (level === 'wiki_lite' || level === 'wiki_full') {
      result.docSummary = summaryMap.get(result.documentId) ?? null;
      result.parentSummary = meta?.parent_doc_id
        ? (summaryMap.get(meta.parent_doc_id) ?? null)
        : null;
    } else {
      result.docSummary = null;
      result.parentSummary = null;
    }
  }
}

export async function searchKnowledge(
  query: string,
  opts?: { kbIds?: string[]; topK?: number; minScore?: number },
): Promise<{ chunks: KnowledgeSearchResult[]; wiki: WikiSearchResult[] }> {
  const startedAt = Date.now();
  const topK = opts?.topK ?? 5;
  const minScore = opts?.minScore ?? 0.3;

  const allKbs = await listKnowledgeBases();

  // Resolve which KBs to search (enabled ones or explicit list)
  const enabledKbIds = new Set<string>();
  if (opts?.kbIds) {
    for (const id of opts.kbIds) enabledKbIds.add(id);
  } else {
    for (const kb of allKbs) {
      if (kb.enabled) enabledKbIds.add(kb.id);
    }
  }
  if (enabledKbIds.size === 0) return { chunks: [], wiki: [] };

  const kbIdList = [...enabledKbIds];
  const wikiFullKbIds = allKbs
    .filter((kb) => kbIdList.includes(kb.id) && kb.enhancement_level === 'wiki_full')
    .map((kb) => kb.id);
  const halfLifeMap = buildHalfLifeMap(kbIdList, allKbs);
  const candidateLimit = buildKnowledgeFtsCandidateLimit(topK);
  let ftsMs = 0;
  let vectorMs = 0;
  let wikiMs = 0;

  const kbEnhancementMap = new Map<string, string>();
  const kbEmbeddingProviderMap = new Map<string, string | null>();
  for (const kb of allKbs) {
    if (kbIdList.includes(kb.id)) {
      kbEnhancementMap.set(kb.id, kb.enhancement_level);
      kbEmbeddingProviderMap.set(kb.id, kb.embedding_provider_id ?? null);
    }
  }

  const wikiPromise =
    wikiFullKbIds.length > 0
      ? (async () => {
        const wikiStartedAt = Date.now();
        try {
          return await searchWikiPages(query, wikiFullKbIds, topK);
        } catch (err) {
          logger.warn({ err }, 'Wiki page search failed (non-fatal)');
          return [] as WikiSearchResult[];
        } finally {
          wikiMs = Date.now() - wikiStartedAt;
        }
      })()
      : Promise.resolve([] as WikiSearchResult[]);

  // --- FTS search (always runs, no external dependency) ---
  let ftsResults: KnowledgeFTSResult[] = [];
  const ftsStartedAt = Date.now();
  try {
    const ftsEngine = getKnowledgeSearchEngine();
    ftsResults = await ftsEngine.search(getActiveEngine(), query, {
      kbIds: kbIdList,
      limit: candidateLimit,
    });
  } catch (err) {
    logger.warn({ err }, 'Knowledge FTS search failed');
  } finally {
    ftsMs = Date.now() - ftsStartedAt;
  }

  const supersededChunkIds = await filterSuperseded(ftsResults.map((r) => r.chunkId));
  if (supersededChunkIds.size > 0) {
    ftsResults = ftsResults.filter((r) => !supersededChunkIds.has(r.chunkId));
  }

  // --- Vector rerank over lexical candidates only ---
  let vectorScoreMap = new Map<string, number>();
  const vectorStartedAt = Date.now();
  if (ftsResults.length > 0) {
    vectorScoreMap = await buildKnowledgeVectorScoreMap(
      query,
      ftsResults.map((result) => result.chunkId),
      kbEmbeddingProviderMap,
      minScore,
    );
  }
  vectorMs = Date.now() - vectorStartedAt;

  // --- Merge & rank ---
  // FTS results — SQLite BM25 returns negative scores (lower = better),
  // MySQL/PG return positive scores (higher = better). Negate SQLite scores
  // so normalization is always "higher = better".
  const dialect = getActiveEngine().dialect;
  const rawFtsScores = ftsResults.map((r) =>
    dialect === 'sqlite' ? -r.score : r.score,
  );
  const normFts = normalizeScores(rawFtsScores);
  const scored = ftsResults.map((result, index) => {
    const ftsScore = normFts[index] ?? 0;
    const vecScore = vectorScoreMap.get(result.chunkId) ?? 0;
    const combinedScore =
      vecScore > 0
        ? VECTOR_BLEND_ALPHA * vecScore + (1 - VECTOR_BLEND_ALPHA) * ftsScore
        : ftsScore;
    return {
      chunkId: result.chunkId,
      documentId: result.documentId,
      combinedScore,
    };
  });

  await applyTemporalBoost(scored, halfLifeMap);
  await applySiblingBoost(scored);

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const topChunkIds = scored.slice(0, topK).map((s) => s.chunkId);
  const scoreMap = new Map(scored.map((s) => [s.chunkId, s.combinedScore]));

  // Hydrate chunk details
  const chunks = await getKnowledgeChunksByIds(topChunkIds);

  const output: KnowledgeSearchResult[] = [];
  for (const c of chunks) {
    if (c.kb_id && !enabledKbIds.has(c.kb_id)) continue;
    output.push({
      chunkId: c.id,
      documentId: c.document_id,
      content: c.content,
      score: scoreMap.get(c.id) ?? 0,
      chunkIndex: c.chunk_index,
      filename: c.filename ?? undefined,
      kbName: c.kb_name ?? undefined,
    });
  }

  output.sort((a, b) => b.score - a.score);
  await enrichSearchResults(output, kbEnhancementMap);
  const wikiResults = await wikiPromise;
  const totalMs = Date.now() - startedAt;
  const logPayload = {
    query: query.slice(0, 50),
    ftsCandidates: ftsResults.length,
    vectorCandidates: vectorScoreMap.size,
    results: output.length,
    wiki: wikiResults.length,
    ftsMs,
    vectorMs,
    wikiMs,
    totalMs,
    candidateStrategy: 'fts_candidates_then_vector_rerank',
  };
  if (totalMs >= SLOW_KNOWLEDGE_SEARCH_WARN_MS) {
    logger.warn(logPayload, 'Knowledge search slow');
  } else {
    logger.debug(logPayload, 'Knowledge hybrid search');
  }
  return { chunks: output.slice(0, topK), wiki: wikiResults };
}
