import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeEmbeddingProvider } = vi.hoisted(() => ({
  fakeEmbeddingProvider: {
    name: 'fake-embedding',
    configKey: 'fake-embedding:test',
    dimensions: 2,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
    embedQuery: vi.fn(async () => [1, 0]),
  },
}));

vi.mock('./embedding/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('./embedding/resolve.js')>('./embedding/resolve.js');
  return {
    ...actual,
    buildEmbeddingProviderFromAiProvider: vi.fn(() => fakeEmbeddingProvider),
  };
});

import {
  computeWikiQualityMultiplier,
  computeWikiTitleMultiplier,
  searchKnowledge,
} from './knowledge/retrieval.js';
import {
  _initTestDatabase,
  createKnowledgeBase,
  createKnowledgeDocument,
  createProvider,
  insertKnowledgeChunks,
  upsertEmbeddingVector,
} from './db.js';
import { serializeEmbedding } from './embedding/vector-store.js';
import { getActiveEngine } from './database/engine.js';
import { createKnowledgeSearchEngine } from './knowledge/knowledge-search-engine.js';
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from './types.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-vector-direct',
  name: 'Vector Direct KB',
  description: null,
  owner_type: 'system',
  owner_id: null,
  embedding_model: null,
  embedding_provider_id: 'embed-provider',
  chunk_size: 300,
  chunk_overlap: 60,
  cleanup_patterns: null,
  enabled: 1,
  user_id: '__system__',
  category: 'general',
  visibility: 'private',
  enhancement_level: 'metadata',
  llm_provider_id: null,
  llm_model_override: null,
  temporal_half_life_days: 365,
  allow_query_backfill: 0,
  created_at: '2026-05-21T00:00:00.000Z',
  updated_at: '2026-05-21T00:00:00.000Z',
};

function docRecord(kbId: string): KnowledgeDocumentRecord {
  return {
    id: 'doc-vector-only',
    kb_id: kbId,
    filename: 'semantic-only.md',
    content_type: 'text/plain',
    content_hash: 'hash-vector-only',
    char_count: 100,
    chunk_count: 1,
    status: 'indexed',
    error_message: null,
    source_url: null,
    published_at: null,
    superseded_by: null,
    parent_doc_id: null,
    doc_path: null,
    depth: 0,
    llm_status: null,
    created_at: '2026-05-21T00:00:00.000Z',
    updated_at: '2026-05-21T00:00:00.000Z',
  };
}

describe('knowledge wiki ranking helpers', () => {
  beforeEach(() => {
    fakeEmbeddingProvider.embedQuery.mockClear();
  });

  it('boosts exact title matches above partial matches', () => {
    const exact = computeWikiTitleMultiplier('NanoClaw 部署指南', 'nanoclaw 部署指南', ['nanoclaw', '部署', '指南']);
    const partial = computeWikiTitleMultiplier('NanoClaw 指南', 'nanoclaw 部署指南', ['nanoclaw', '部署', '指南']);

    expect(exact).toBeGreaterThan(partial);
    expect(exact).toBeGreaterThan(1);
  });

  it('penalizes overview pages and rewards synthesis pages with evidenced claims', () => {
    const overview = computeWikiQualityMultiplier('overview', 4, 'x'.repeat(600), 0, 0);
    const synthesis = computeWikiQualityMultiplier('synthesis', 4, 'x'.repeat(600), 4, 4);

    expect(synthesis).toBeGreaterThan(overview);
  });

  it('prefers pages with evidenced claims over equally sized pages without claims', () => {
    const noClaims = computeWikiQualityMultiplier('entity', 3, 'x'.repeat(600), 0, 0);
    const withClaims = computeWikiQualityMultiplier('entity', 3, 'x'.repeat(600), 3, 3);

    expect(withClaims).toBeGreaterThan(noClaims);
  });

  it('recalls vector-only chunks when FTS has no lexical hit', async () => {
    _initTestDatabase();
    await createKnowledgeSearchEngine(getActiveEngine().dialect).initialize(getActiveEngine());
    await createProvider({
      id: 'embed-provider',
      alias: 'Fake Embedding',
      type: 'openai_compatible',
      capability: 'embedding',
      api_key: 'fake-key',
      base_url: 'https://embedding.example.com/v1',
      model: 'Qwen3-Embedding-8B-4bit-DWQ',
      dimensions: 2,
      extra_config: null,
      is_default: 0,
      user_id: '__system__',
      visibility: 'private',
    });
    await createKnowledgeBase(BASE_KB);
    await createKnowledgeDocument(docRecord(BASE_KB.id));
    await insertKnowledgeChunks([{
      id: 'chunk-vector-only',
      document_id: 'doc-vector-only',
      chunk_index: 0,
      content: '烘焙流程要求先静置面团，再低温发酵。',
      token_count: 20,
      created_at: '2026-05-21T00:00:00.000Z',
    }]);
    await upsertEmbeddingVector(
      'vec-vector-only',
      'knowledge',
      'chunk-vector-only',
      'embed-provider',
      'hash-vector-only',
      serializeEmbedding([1, 0]),
      2,
      'fake-embedding',
    );

    const result = await searchKnowledge('完全不匹配的关键词', {
      kbIds: [BASE_KB.id],
      topK: 3,
      minScore: 0.2,
    });

    expect(result.chunks).toEqual([
      expect.objectContaining({
        chunkId: 'chunk-vector-only',
        filename: 'semantic-only.md',
      }),
    ]);
    expect(fakeEmbeddingProvider.embedQuery).toHaveBeenCalled();
  });
});
