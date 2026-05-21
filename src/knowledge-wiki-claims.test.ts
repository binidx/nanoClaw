import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeEmbeddingProvider } = vi.hoisted(() => ({
  fakeEmbeddingProvider: {
    name: 'fake-embedding',
    configKey: 'fake-embedding:claims',
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
  _initTestDatabase,
  createKnowledgeBase,
  createKnowledgeDocument,
  createProvider,
  dba,
  insertKnowledgeChunks,
  upsertEmbeddingVector,
} from './db.js';
import { serializeEmbedding } from './embedding/vector-store.js';
import { syncWikiClaimsForPage } from './knowledge/wiki-claims.js';
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from './types.js';

function kbRecord(): KnowledgeBaseRecord {
  return {
    id: 'kb-claim-vector',
    name: 'Claim Vector KB',
    description: null,
    owner_type: 'system',
    owner_id: null,
    embedding_model: null,
    embedding_provider_id: 'claim-embed-provider',
    chunk_size: 300,
    chunk_overlap: 60,
    cleanup_patterns: null,
    enabled: 1,
    user_id: '__system__',
    category: 'general',
    visibility: 'private',
    enhancement_level: 'wiki_full',
    llm_provider_id: null,
    llm_model_override: null,
    temporal_half_life_days: 365,
    allow_query_backfill: 0,
    created_at: '2026-05-21T00:00:00.000Z',
    updated_at: '2026-05-21T00:00:00.000Z',
  };
}

function docRecord(id: string, kbId: string): KnowledgeDocumentRecord {
  return {
    id,
    kb_id: kbId,
    filename: `${id}.md`,
    content_type: 'text/plain',
    content_hash: `hash-${id}`,
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

describe('wiki claim evidence selection', () => {
  beforeEach(() => {
    _initTestDatabase();
    fakeEmbeddingProvider.embedQuery.mockClear();
  });

  it('uses embedding similarity to select stronger claim evidence when lexical overlap disagrees', async () => {
    await createProvider({
      id: 'claim-embed-provider',
      alias: 'Claim Embedding',
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
    const kb = kbRecord();
    await createKnowledgeBase(kb);
    await createKnowledgeDocument(docRecord('doc-semantic', kb.id));
    await createKnowledgeDocument(docRecord('doc-lexical', kb.id));
    await insertKnowledgeChunks([
      {
        id: 'chunk-semantic',
        document_id: 'doc-semantic',
        chunk_index: 0,
        content: '面团膨胀来自二氧化碳被面筋网络包裹。',
        token_count: 20,
        created_at: '2026-05-21T00:00:00.000Z',
      },
      {
        id: 'chunk-lexical',
        document_id: 'doc-lexical',
        chunk_index: 0,
        content: '面团发酵需要足够时间，但这里没有说明面团膨胀原理。',
        token_count: 20,
        created_at: '2026-05-21T00:00:00.000Z',
      },
    ]);
    await upsertEmbeddingVector(
      'vec-semantic',
      'knowledge',
      'chunk-semantic',
      'claim-embed-provider',
      'hash-semantic',
      serializeEmbedding([1, 0]),
      2,
      'fake-embedding',
    );
    await upsertEmbeddingVector(
      'vec-lexical',
      'knowledge',
      'chunk-lexical',
      'claim-embed-provider',
      'hash-lexical',
      serializeEmbedding([0, 1]),
      2,
      'fake-embedding',
    );

    await dba.prepare(
      `INSERT INTO knowledge_wiki_pages
        (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
         llm_model, version, edited_by_human, edited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'wiki-claim',
      kb.id,
      'entity',
      '面团发酵',
      '# 面团发酵\n\n## 核心事实\n- 面团发酵需要足够时间。\n\n## 来源\n- doc',
      JSON.stringify(['doc-semantic', 'doc-lexical']),
      '[]',
      '[]',
      'gpt-test',
      1,
      0,
      null,
      '2026-05-21T00:00:00.000Z',
      '2026-05-21T00:00:00.000Z',
    );

    await syncWikiClaimsForPage({
      pageId: 'wiki-claim',
      content: '# 面团发酵\n\n## 核心事实\n- 面团发酵需要足够时间。\n\n## 来源\n- doc',
      sourceDocIds: ['doc-semantic', 'doc-lexical'],
    });

    const row = (await dba
      .prepare('SELECT evidence_chunk_id FROM knowledge_wiki_claims WHERE page_id = ?')
      .get('wiki-claim')) as { evidence_chunk_id: string | null } | undefined;

    expect(row?.evidence_chunk_id).toBe('chunk-semantic');
    expect(fakeEmbeddingProvider.embedQuery).toHaveBeenCalled();
  });
});
