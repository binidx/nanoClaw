import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase } from './db/assistants.js';
import { dba } from './db/engine-access.js';
import { upsertUserKnowledgeBinding } from './knowledge/user-kb-service.js';
import { registerInternalKnowledgeRoutes } from './routes/internal-knowledge-routes.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-internal',
  name: 'Internal KB',
  description: null,
  owner_type: 'system',
  owner_id: null,
  embedding_model: null,
  embedding_provider_id: null,
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
  created_at: '2026-04-28T00:00:00.000Z',
  updated_at: '2026-04-28T00:00:00.000Z',
};

async function createKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<string> {
  const record = {
    ...BASE_KB,
    ...overrides,
    id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}`,
  };
  await createKnowledgeBase(record);
  return record.id;
}

async function insertWikiPage(
  kbId: string,
  id: string,
  title: string,
  pageType: string,
  sourceDocIds: string[] = [],
): Promise<void> {
  const ts = '2026-04-28T00:00:01.000Z';
  await dba.prepare(
    `INSERT INTO knowledge_wiki_pages
      (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
       llm_model, version, edited_by_human, edited_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kbId,
    pageType,
    title,
    `# ${title}\n\n正文内容`,
    JSON.stringify(sourceDocIds),
    '[]',
    '[]',
    'gpt-test',
    2,
    0,
    null,
    ts,
    ts,
  );
}

describe('internal knowledge routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('lists wiki pages for a visible knowledge base', async () => {
    const kbId = await createKb();
    await insertWikiPage(kbId, 'page-overview', '知识库索引', 'overview', []);
    await insertWikiPage(kbId, 'page-entity', 'Kubernetes', 'entity', ['doc-a', 'doc-b']);

    const app = express();
    registerInternalKnowledgeRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'GET',
      url: `/internal/knowledge/wiki-pages?kb_id=${encodeURIComponent(kbId)}&user_id=__system__`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'page-entity',
        page_type: 'entity',
        title: 'Kubernetes',
        source_doc_count: 2,
      }),
      expect.objectContaining({
        id: 'page-overview',
        page_type: 'overview',
        title: '知识库索引',
        source_doc_count: 0,
      }),
    ]);
  });

  it('reads a wiki page by page_id and by kb_id + title', async () => {
    const kbId = await createKb();
    await insertWikiPage(kbId, 'page-entity', 'Kubernetes', 'entity', ['doc-a']);

    const app = express();
    registerInternalKnowledgeRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const byId = await inject(app, {
      method: 'GET',
      url: `/internal/knowledge/wiki-page?page_id=page-entity&user_id=__system__`,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toEqual(
      expect.objectContaining({
        id: 'page-entity',
        kb_id: kbId,
        title: 'Kubernetes',
        page_type: 'entity',
      }),
    );

    const byTitle = await inject(app, {
      method: 'GET',
      url: `/internal/knowledge/wiki-page?kb_id=${encodeURIComponent(kbId)}&title=${encodeURIComponent('Kubernetes')}&user_id=__system__`,
    });
    expect(byTitle.statusCode).toBe(200);
    expect(byTitle.json()).toEqual(
      expect.objectContaining({
        id: 'page-entity',
        kb_id: kbId,
        title: 'Kubernetes',
        page_type: 'entity',
      }),
    );
  });

  it('lists only enabled shared or explicitly subscribed KBs for non-system users', async () => {
    const sharedKbId = await createKb({
      id: 'kb-shared',
      name: 'Shared KB',
      visibility: 'shared',
      enabled: 1,
      user_id: '__system__',
    });
    await createKb({
      id: 'kb-private-owner',
      name: 'Private Owner KB',
      visibility: 'private',
      enabled: 1,
      user_id: 'user-a',
    });
    const subscribedKbId = await createKb({
      id: 'kb-subscribed',
      name: 'Subscribed KB',
      visibility: 'private',
      enabled: 1,
      user_id: 'user-a',
    });
    await createKb({
      id: 'kb-disabled',
      name: 'Disabled KB',
      visibility: 'shared',
      enabled: 0,
      user_id: '__system__',
    });
    await upsertUserKnowledgeBinding('user-a', subscribedKbId, true);

    const app = express();
    registerInternalKnowledgeRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/internal/knowledge/bases?user_id=user-a',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: sharedKbId, user_enabled: 0 }),
      expect.objectContaining({ id: subscribedKbId, user_enabled: 1 }),
    ]);
  });

  it('accepts internal knowledge search POST bodies and returns structured results', async () => {
    const kbId = await createKb();

    const app = express();
    app.use(express.json());
    registerInternalKnowledgeRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/knowledge/search',
      headers: {
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        query: '订单规则',
        user_id: '__system__',
        kb_ids: [kbId],
        top_k: 5,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        chunks: expect.any(Array),
        wiki: expect.any(Array),
      }),
    );
  });
});
