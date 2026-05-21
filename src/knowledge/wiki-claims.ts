import crypto from 'node:crypto';
import { dba } from '../db.js';
import { adaptSql } from '../db/sql-adapters.js';
import type { KnowledgeWikiClaimRecord } from '../types/context.js';

export interface KnowledgeWikiEvidence {
  chunkId: string;
  documentId: string;
  filename: string | null;
  docPath: string | null;
  chunkIndex: number;
  content: string;
}

export interface KnowledgeWikiClaimWithEvidence extends KnowledgeWikiClaimRecord {
  evidence: KnowledgeWikiEvidence | null;
}

interface CandidateChunk {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  filename: string | null;
  doc_path: string | null;
}

const CLAIM_LIMIT_PER_PAGE = 12;

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueTokens(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  )];
}

function scoreChunkForClaim(claim: string, chunk: CandidateChunk): number {
  const tokens = uniqueTokens(claim);
  if (tokens.length === 0) return 0;
  const haystack = `${chunk.filename ?? ''}\n${chunk.content}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function normalizeClaimLine(line: string): string | null {
  const cleaned = line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 8) return null;
  if (/^暂无/.test(cleaned)) return null;
  return cleaned.length > 500 ? cleaned.slice(0, 500) : cleaned;
}

export function extractWikiClaimsFromMarkdown(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const claims: string[] = [];
  let inFacts = false;
  for (const line of lines) {
    if (/^##\s+核心事实\s*$/u.test(line.trim())) {
      inFacts = true;
      continue;
    }
    if (inFacts && /^##\s+/u.test(line.trim())) break;
    if (!inFacts) continue;
    const claim = normalizeClaimLine(line);
    if (claim) claims.push(claim);
  }
  return [...new Set(claims)].slice(0, CLAIM_LIMIT_PER_PAGE);
}

function parseSourceDocIds(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function loadCandidateChunks(sourceDocIds: string[]): Promise<CandidateChunk[]> {
  const ids = [...new Set(sourceDocIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return (await dba
    .prepare(
      adaptSql(
        `SELECT c.id AS chunk_id,
                c.document_id AS document_id,
                c.chunk_index AS chunk_index,
                c.content AS content,
                d.filename AS filename,
                d.doc_path AS doc_path
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.document_id IN (${placeholders})
           AND d.deleted_at IS NULL
         ORDER BY c.document_id, c.chunk_index`,
      ),
    )
    .all(...ids)) as CandidateChunk[];
}

function chooseEvidence(
  claimText: string,
  chunks: CandidateChunk[],
): { chunk: CandidateChunk | null; confidence: number } {
  let best: CandidateChunk | null = null;
  let bestScore = 0;
  for (const chunk of chunks) {
    const score = scoreChunkForClaim(claimText, chunk);
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.18) return { chunk: null, confidence: 0.25 };
  return { chunk: best, confidence: Math.max(0.55, Math.min(0.95, bestScore)) };
}

async function buildVectorScoreMapForClaim(
  pageId: string,
  claimText: string,
  chunks: CandidateChunk[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (chunks.length === 0) return out;

  const page = (await dba.prepare(
    `SELECT kb.embedding_provider_id AS embedding_provider_id
     FROM knowledge_wiki_pages wp
     JOIN knowledge_bases kb ON kb.id = wp.kb_id
     WHERE wp.id = ?`,
  ).get(pageId)) as { embedding_provider_id: string | null } | undefined;
  const providerId = page?.embedding_provider_id;
  if (!providerId) return out;

  const [
    { getProvider, getEmbeddingsByOwnerBatch },
    { buildEmbeddingProviderFromAiProvider },
    { cachedEmbedQuery, cosineSimilarity, deserializeEmbedding },
  ] = await Promise.all([
    import('../db.js'),
    import('../embedding/resolve.js'),
    import('../embedding/vector-store.js'),
  ]);
  const providerRecord = await getProvider(providerId);
  const provider = providerRecord ? buildEmbeddingProviderFromAiProvider(providerRecord) : null;
  if (!providerRecord || !provider) return out;

  const queryVec = await cachedEmbedQuery(provider, claimText);
  const embeddingRows = await getEmbeddingsByOwnerBatch(
    'knowledge',
    chunks.map((chunk) => chunk.chunk_id),
    providerRecord.id,
  );
  for (const chunk of chunks) {
    const row = embeddingRows.get(chunk.chunk_id);
    if (!row) continue;
    const vec = deserializeEmbedding(row.embedding);
    if (vec.length !== queryVec.length) continue;
    out.set(chunk.chunk_id, Math.max(0, cosineSimilarity(queryVec, vec)));
  }
  return out;
}

async function chooseEvidenceWithVector(
  pageId: string,
  claimText: string,
  chunks: CandidateChunk[],
): Promise<{ chunk: CandidateChunk | null; confidence: number }> {
  if (chunks.length === 0) return { chunk: null, confidence: 0.25 };

  let vectorScores = new Map<string, number>();
  try {
    vectorScores = await buildVectorScoreMapForClaim(pageId, claimText, chunks);
  } catch {
    vectorScores = new Map<string, number>();
  }

  if (vectorScores.size === 0) return chooseEvidence(claimText, chunks);

  let best: CandidateChunk | null = null;
  let bestScore = 0;
  for (const chunk of chunks) {
    const lexical = scoreChunkForClaim(claimText, chunk);
    const vector = vectorScores.get(chunk.chunk_id) ?? 0;
    const score = lexical * 0.45 + vector * 0.55;
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  if (!best || bestScore < 0.18) return { chunk: null, confidence: 0.25 };
  return { chunk: best, confidence: Math.max(0.55, Math.min(0.95, bestScore)) };
}

export async function syncWikiClaimsForPage(input: {
  pageId: string;
  content: string;
  sourceDocIds: string | string[] | null | undefined;
}): Promise<void> {
  const claimTexts = extractWikiClaimsFromMarkdown(input.content);
  const ts = nowIso();
  await dba.prepare('DELETE FROM knowledge_wiki_claims WHERE page_id = ?').run(input.pageId);
  if (claimTexts.length === 0) return;

  const chunks = await loadCandidateChunks(parseSourceDocIds(input.sourceDocIds));
  for (const claimText of claimTexts) {
    const { chunk, confidence } = await chooseEvidenceWithVector(input.pageId, claimText, chunks);
    await dba
      .prepare(
        adaptSql(
          `INSERT INTO knowledge_wiki_claims
            (id, page_id, claim_text, source_doc_id, evidence_chunk_id, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
      )
      .run(
        crypto.randomUUID(),
        input.pageId,
        claimText,
        chunk?.document_id ?? null,
        chunk?.chunk_id ?? null,
        confidence,
        ts,
        ts,
      );
  }
}

export async function loadWikiClaimsWithEvidence(pageIds: string[]): Promise<Map<string, KnowledgeWikiClaimWithEvidence[]>> {
  const ids = [...new Set(pageIds.filter(Boolean))];
  const result = new Map<string, KnowledgeWikiClaimWithEvidence[]>();
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => '?').join(', ');
  const rows = (await dba
    .prepare(
      adaptSql(
        `SELECT wc.id AS id,
                wc.page_id AS page_id,
                wc.claim_text AS claim_text,
                wc.source_doc_id AS source_doc_id,
                wc.evidence_chunk_id AS evidence_chunk_id,
                wc.confidence AS confidence,
                wc.created_at AS created_at,
                wc.updated_at AS updated_at,
                c.document_id AS evidence_document_id,
                c.chunk_index AS evidence_chunk_index,
                c.content AS evidence_content,
                d.filename AS evidence_filename,
                d.doc_path AS evidence_doc_path
         FROM knowledge_wiki_claims wc
         LEFT JOIN knowledge_chunks c ON c.id = wc.evidence_chunk_id
         LEFT JOIN knowledge_documents d ON d.id = c.document_id
         WHERE wc.page_id IN (${placeholders})
         ORDER BY wc.confidence DESC, wc.created_at ASC`,
      ),
    )
    .all(...ids)) as Array<{
    id: string;
    page_id: string;
    claim_text: string;
    source_doc_id: string | null;
    evidence_chunk_id: string | null;
    confidence: number;
    created_at: string;
    updated_at: string;
    evidence_document_id: string | null;
    evidence_chunk_index: number | null;
    evidence_content: string | null;
    evidence_filename: string | null;
    evidence_doc_path: string | null;
  }>;

  for (const row of rows) {
    const evidence = row.evidence_chunk_id && row.evidence_document_id && row.evidence_content != null
      ? {
        chunkId: row.evidence_chunk_id,
        documentId: row.evidence_document_id,
        filename: row.evidence_filename,
        docPath: row.evidence_doc_path,
        chunkIndex: Number(row.evidence_chunk_index ?? 0),
        content: row.evidence_content.length > 520
          ? `${row.evidence_content.slice(0, 517)}...`
          : row.evidence_content,
      }
      : null;
    const item: KnowledgeWikiClaimWithEvidence = {
      id: row.id,
      page_id: row.page_id,
      claim_text: row.claim_text,
      source_doc_id: row.source_doc_id,
      evidence_chunk_id: row.evidence_chunk_id,
      confidence: Number(row.confidence ?? 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      evidence,
    };
    const list = result.get(row.page_id) ?? [];
    list.push(item);
    result.set(row.page_id, list);
  }
  return result;
}
