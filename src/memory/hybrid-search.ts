import type Database from 'better-sqlite3';
import {
  searchMemorySearchIndex,
  type MemorySearchIndexSearchOptions,
  type MemorySearchIndexResult,
} from './search-index.js';
import { getProvider, listKnowledgeBases } from '../db.js';
import { buildEmbeddingProviderFromAiProvider, resolveEmbeddingProvider } from '../embedding/resolve.js';
import { cachedEmbedQuery, searchByVector } from '../embedding/vector-store.js';
import { getConfigValue } from '../config-store.js';
import { logger } from '../logger.js';

export interface HybridSearchResult {
  id: string;
  content: string;
  source: 'memory' | 'knowledge' | 'context';
  sourceType: string;
  bm25Score: number;
  vectorScore: number;
  hybridScore: number;
  recencyScore: number;
  finalScore: number;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface HybridSearchOptions extends MemorySearchIndexSearchOptions {
  vectorWeight?: number;
  includeKnowledge?: boolean;
  minVectorScore?: number;
}

function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => (max > 0 ? 1 : 0));
  return scores.map((s) => (s - min) / range);
}

export async function hybridSearch(
  db: Database.Database,
  query: string,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResult[]> {
  const limit = options.limit ?? 10;
  const minVectorScore = options.minVectorScore ?? 0.25;

  let alpha: number;
  if (options.vectorWeight !== undefined) {
    alpha = options.vectorWeight;
  } else {
    const cfgVal = await getConfigValue('VECTOR_SEARCH_ALPHA').catch(() => '0.6');
    alpha = parseFloat(cfgVal) || 0.6;
  }

  const bm25Results = searchMemorySearchIndex(db, query, {
    ...options,
    limit: limit * 3,
  });

  const provider = await resolveEmbeddingProvider();

  let vectorResults: Array<{ ownerId: string; score: number }> = [];
  if (provider) {
    const vectorEnabled = await getConfigValue('VECTOR_SEARCH_ENABLED').catch(() => 'true');
    if (vectorEnabled !== 'false') {
      try {
        const queryVec = await cachedEmbedQuery(provider, query);
        const memoryHits = await searchByVector(queryVec, 'memory_doc', limit * 3, minVectorScore);
        vectorResults.push(...memoryHits.map((h) => ({ ownerId: h.ownerId, score: h.score })));

        if (options.includeKnowledge !== false) {
          const allKbs = await listKnowledgeBases();
          const kbGroups = new Map<string, string[]>();
          for (const kb of allKbs) {
            if (!kb.enabled || !kb.embedding_provider_id) continue;
            const group = kbGroups.get(kb.embedding_provider_id) ?? [];
            group.push(kb.id);
            kbGroups.set(kb.embedding_provider_id, group);
          }
          for (const [providerId] of kbGroups) {
            const providerRecord = await getProvider(providerId);
            const kbProvider = providerRecord
              ? buildEmbeddingProviderFromAiProvider(providerRecord)
              : null;
            if (!providerRecord || !kbProvider) continue;
            const kbQueryVec = await cachedEmbedQuery(kbProvider, query);
            const kbHits = await searchByVector(
              kbQueryVec,
              'knowledge',
              limit * 2,
              minVectorScore,
              providerId,
            );
            vectorResults.push(...kbHits.map((h) => ({ ownerId: h.ownerId, score: h.score })));
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Vector search failed, falling back to BM25 only');
      }
    }
  }

  if (vectorResults.length === 0) {
    return bm25Results.slice(0, limit).map((r) => ({
      id: r.docId,
      content: r.body,
      source: 'memory' as const,
      sourceType: r.sourceType,
      bm25Score: r.score,
      vectorScore: 0,
      hybridScore: r.score,
      recencyScore: r.recencyBoost,
      finalScore: r.score,
      updatedAt: r.updatedAt,
      metadata: r.metadataJson ? tryParseJson(r.metadataJson) : undefined,
    }));
  }

  const merged = new Map<string, HybridSearchResult>();

  const bm25Scores = bm25Results.map((r) => r.score);
  const normalizedBm25 = normalizeScores(bm25Scores);

  for (let i = 0; i < bm25Results.length; i++) {
    const r = bm25Results[i];
    merged.set(r.docId, {
      id: r.docId,
      content: r.body,
      source: 'memory',
      sourceType: r.sourceType,
      bm25Score: normalizedBm25[i],
      vectorScore: 0,
      hybridScore: 0,
      recencyScore: r.recencyBoost,
      finalScore: 0,
      updatedAt: r.updatedAt,
      metadata: r.metadataJson ? tryParseJson(r.metadataJson) : undefined,
    });
  }

  for (const vr of vectorResults) {
    const existing = merged.get(vr.ownerId);
    if (existing) {
      existing.vectorScore = vr.score;
    } else {
      merged.set(vr.ownerId, {
        id: vr.ownerId,
        content: '',
        source: 'memory',
        sourceType: 'vector_match',
        bm25Score: 0,
        vectorScore: vr.score,
        hybridScore: 0,
        recencyScore: 0,
        finalScore: 0,
        updatedAt: '',
      });
    }
  }

  for (const result of merged.values()) {
    result.hybridScore = alpha * result.vectorScore + (1 - alpha) * result.bm25Score;
    result.finalScore = result.hybridScore + result.recencyScore;
  }

  const sorted = [...merged.values()].sort((a, b) => b.finalScore - a.finalScore);
  return sorted.slice(0, limit);
}

function tryParseJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
