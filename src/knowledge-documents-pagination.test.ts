import { beforeEach, describe, expect, it } from 'vitest';

describe('knowledge document pagination', () => {
  beforeEach(async () => {
    const db = await import('./db.js');
    db._initTestDatabase();
  });

  it('lists and counts knowledge documents with SQL pagination filters', async () => {
    const {
      countKnowledgeDocumentsForList,
      createKnowledgeBase,
      createKnowledgeDocument,
      listKnowledgeDocumentsPage,
    } = await import('./db.js');

    await createKnowledgeBase({
      id: 'kb-page',
      name: 'Paged KB',
      description: '',
      owner_type: 'user',
      owner_id: 'user-a',
      embedding_model: '',
      embedding_provider_id: null,
      chunk_size: 1000,
      chunk_overlap: 100,
      cleanup_patterns: null,
      enabled: 1,
      user_id: 'user-a',
      category: 'general',
      visibility: 'private',
      enhancement_level: 'metadata',
      llm_provider_id: null,
      llm_model_override: null,
      temporal_half_life_days: 365,
      allow_query_backfill: 0,
      created_at: '2026-05-03T00:00:00.000Z',
      updated_at: '2026-05-03T00:00:00.000Z',
    });

    for (let index = 0; index < 5; index++) {
      await createKnowledgeDocument({
        id: `doc-${index}`,
        kb_id: 'kb-page',
        filename: index % 2 === 0 ? `Alpha ${index}.md` : `Beta ${index}.md`,
        content_type: 'text/markdown',
        content_hash: `hash-${index}`,
        char_count: 10,
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
        created_at: `2026-05-03T00:00:0${index}.000Z`,
        updated_at: `2026-05-03T00:00:0${index}.000Z`,
      });
    }

    const page = await listKnowledgeDocumentsPage('kb-page', {
      search: 'alpha',
      limit: 2,
      offset: 1,
    });
    expect(page.map((doc) => doc.id)).toEqual(['doc-2', 'doc-0']);
    expect(
      await countKnowledgeDocumentsForList('kb-page', { search: 'alpha' }),
    ).toBe(3);
  });

  it('lists and counts visible knowledge bases with SQL pagination filters', async () => {
    const {
      countVisibleKnowledgeBases,
      createKnowledgeBase,
      listVisibleKnowledgeBasesPage,
    } = await import('./db.js');

    for (const entry of [
      {
        id: 'kb-owned-alpha-1',
        userId: 'user-a',
        visibility: 'private',
        createdAt: '2026-05-03T00:00:03.000Z',
      },
      {
        id: 'kb-owned-alpha-2',
        userId: 'user-a',
        visibility: 'private',
        createdAt: '2026-05-03T00:00:02.000Z',
      },
      {
        id: 'kb-shared-alpha',
        userId: 'user-b',
        visibility: 'shared',
        createdAt: '2026-05-03T00:00:01.000Z',
      },
      {
        id: 'kb-hidden-alpha',
        userId: 'user-b',
        visibility: 'private',
        createdAt: '2026-05-03T00:00:04.000Z',
      },
    ]) {
      await createKnowledgeBase({
        id: entry.id,
        name: entry.id.replace(/-/g, ' '),
        description: '',
        owner_type: 'user',
        owner_id: entry.userId,
        embedding_model: '',
        embedding_provider_id: null,
        chunk_size: 1000,
        chunk_overlap: 100,
        cleanup_patterns: null,
        enabled: 1,
        user_id: entry.userId,
        category: 'general',
        visibility: entry.visibility,
        enhancement_level: 'metadata',
        llm_provider_id: null,
        llm_model_override: null,
        temporal_half_life_days: 365,
        allow_query_backfill: 0,
        created_at: entry.createdAt,
        updated_at: entry.createdAt,
      });
    }

    const page = await listVisibleKnowledgeBasesPage('user-a', '__system__', {
      search: 'alpha',
      limit: 2,
      offset: 1,
    });
    expect(page.map((kb) => kb.id)).toEqual([
      'kb-owned-alpha-2',
      'kb-shared-alpha',
    ]);
    expect(
      await countVisibleKnowledgeBases('user-a', '__system__', {
        search: 'alpha',
      }),
    ).toBe(3);
  });
});
