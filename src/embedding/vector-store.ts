import crypto from 'crypto';
import {
  getEmbeddingByOwner,
  getEmbeddingsByOwnerBatch,
  upsertEmbeddingVector,
  getAllEmbeddingsByType,
  deleteEmbeddingByOwner,
} from '../db.js';
import type { EmbeddingProvider } from './provider.js';
import { createModuleLogger } from '../logger.js';

const logger = createModuleLogger('embedding');

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function serializeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

export function deserializeEmbedding(buf: Buffer): number[] {
  const len = buf.length / 4;
  const vec = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    vec[i] = buf.readFloatLE(i * 4);
  }
  return vec;
}

export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Cosine similarity (application-layer, all DBs)
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

interface VectorRowCacheEntry {
  rows: Array<{ id: string; owner_id: string; owner_type: string; embedding: Buffer }>;
  expiresAt: number;
}

const vectorRowCache = new Map<string, VectorRowCacheEntry>();
const VECTOR_ROW_CACHE_TTL_MS = 30_000;

const queryEmbeddingCache = new Map<string, { vec: number[]; expiresAt: number }>();
const QUERY_EMBEDDING_CACHE_MAX = 64;
const QUERY_EMBEDDING_CACHE_TTL_MS = 120_000;

export function invalidateVectorRowCache(ownerType?: string): void {
  if (ownerType) {
    for (const key of [...vectorRowCache.keys()]) {
      if (key === ownerType || key.startsWith(`${ownerType}:`)) {
        vectorRowCache.delete(key);
      }
    }
  } else {
    vectorRowCache.clear();
  }
}

function getCachedQueryEmbedding(key: string): number[] | null {
  const entry = queryEmbeddingCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.vec;
  if (entry) queryEmbeddingCache.delete(key);
  return null;
}

function setCachedQueryEmbedding(key: string, vec: number[]): void {
  if (queryEmbeddingCache.size >= QUERY_EMBEDDING_CACHE_MAX) {
    const firstKey = queryEmbeddingCache.keys().next().value as string;
    queryEmbeddingCache.delete(firstKey);
  }
  queryEmbeddingCache.set(key, { vec, expiresAt: Date.now() + QUERY_EMBEDDING_CACHE_TTL_MS });
}

export function queryEmbeddingCacheKey(text: string, providerKey: string): string {
  return crypto.createHash('sha256').update(`${providerKey}:${text}`).digest('hex').slice(0, 24);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface VectorSearchResult {
  id: string;
  ownerId: string;
  ownerType: string;
  score: number;
}

export async function embedAndStore(
  ownerType: string,
  ownerId: string,
  text: string,
  provider: EmbeddingProvider,
  embeddingProviderId: string | null = null,
): Promise<string> {
  const hash = contentHash(text);
  const existing = await getEmbeddingByOwner(ownerType, ownerId, embeddingProviderId);

  if (existing && existing.content_hash === hash) {
    return existing.id;
  }

  const vec = await provider.embedQuery(text);
  const blob = serializeEmbedding(vec);
  const id = existing?.id ?? crypto.randomUUID();

  await upsertEmbeddingVector(
    id, ownerType, ownerId, embeddingProviderId, hash,
    blob, provider.dimensions, provider.name,
  );
  invalidateVectorRowCache(ownerType);
  return id;
}

export async function batchEmbedAndStore(
  ownerType: string,
  items: Array<{ ownerId: string; text: string }>,
  provider: EmbeddingProvider,
  embeddingProviderId: string | null = null,
): Promise<number> {
  const toEmbed: Array<{ ownerId: string; text: string; hash: string; existingId: string | null }> = [];

  const existingByOwner = await getEmbeddingsByOwnerBatch(
    ownerType,
    items.map((i) => i.ownerId),
    embeddingProviderId,
  );
  for (const item of items) {
    const hash = contentHash(item.text);
    const existing = existingByOwner.get(item.ownerId) ?? null;
    if (!existing || existing.content_hash !== hash) {
      toEmbed.push({ ...item, hash, existingId: existing?.id ?? null });
    }
  }

  if (toEmbed.length === 0) return 0;

  const vectors = await provider.embed(toEmbed.map((e) => e.text));

  for (let i = 0; i < toEmbed.length; i++) {
    const { ownerId, hash, existingId } = toEmbed[i];
    const blob = serializeEmbedding(vectors[i]);
    const id = existingId ?? crypto.randomUUID();
    await upsertEmbeddingVector(
      id, ownerType, ownerId, embeddingProviderId, hash,
      blob, provider.dimensions, provider.name,
    );
  }

  invalidateVectorRowCache(ownerType);
  logger.info({ ownerType, count: toEmbed.length }, 'Batch embedded vectors');
  return toEmbed.length;
}

export async function searchByVector(
  queryVec: number[],
  ownerType: string,
  topK: number = 10,
  minScore: number = 0.3,
  embeddingProviderId?: string | null,
): Promise<VectorSearchResult[]> {
  const now = Date.now();
  let rows: Array<{ id: string; owner_id: string; owner_type: string; embedding: Buffer }>;
  const cacheKey = `${ownerType}:${embeddingProviderId ?? '__all__'}`;

  const cached = vectorRowCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    rows = cached.rows;
  } else {
    rows = await getAllEmbeddingsByType(ownerType, embeddingProviderId);
    vectorRowCache.set(cacheKey, { rows, expiresAt: now + VECTOR_ROW_CACHE_TTL_MS });
  }

  const scored: VectorSearchResult[] = [];
  let dimensionMismatchCount = 0;
  for (const row of rows) {
    const vec = deserializeEmbedding(row.embedding);
    if (vec.length !== queryVec.length) {
      dimensionMismatchCount++;
      continue;
    }
    const score = cosineSimilarity(queryVec, vec);
    if (score >= minScore) {
      scored.push({ id: row.id, ownerId: row.owner_id, ownerType: row.owner_type, score });
    }
  }
  if (dimensionMismatchCount > 0) {
    logger.warn(
      { ownerType, expected: queryVec.length, skipped: dimensionMismatchCount, total: rows.length },
      'Skipped embedding rows with mismatched dimensions — re-embed existing data or check EMBEDDING_MODEL config',
    );
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Cached wrapper around provider.embedQuery.
 * Avoids re-embedding the same query text within the TTL window.
 */
export async function cachedEmbedQuery(
  provider: EmbeddingProvider,
  text: string,
): Promise<number[]> {
  const providerKey = provider.configKey || provider.name;
  const key = queryEmbeddingCacheKey(text, providerKey);
  const hit = getCachedQueryEmbedding(key);
  if (hit) return hit;
  const vec = await provider.embedQuery(text);
  setCachedQueryEmbedding(key, vec);
  return vec;
}

export { deleteEmbeddingByOwner };
