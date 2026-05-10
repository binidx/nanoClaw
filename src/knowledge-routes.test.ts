import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createKnowledgeLlmRunMock,
  getKnowledgeLlmRunMock,
  indexDocumentMock,
  listKnowledgeProcessingActivityMock,
  loadKnowledgeLlmRunMock,
  getKnowledgeLlmConcurrencyMock,
  runKnowledgeLlmEnhancementPoolMock,
} = vi.hoisted(() => ({
  createKnowledgeLlmRunMock: vi.fn((kbId: string, total: number, concurrency: number, mode: string) => ({
    runId: `run-${kbId}`,
    kbId,
    mode,
    total,
    queued: total,
    completed: 0,
    failed: 0,
    concurrency,
    status: 'running',
    startedAt: '2026-04-27T00:00:10.000Z',
    updatedAt: '2026-04-27T00:00:10.000Z',
    finishedAt: null,
  })),
  getKnowledgeLlmRunMock: vi.fn(() => null),
  indexDocumentMock: vi.fn(),
  listKnowledgeProcessingActivityMock: vi.fn(() => []),
  loadKnowledgeLlmRunMock: vi.fn(async () => null),
  getKnowledgeLlmConcurrencyMock: vi.fn(async () => 4),
  runKnowledgeLlmEnhancementPoolMock: vi.fn(async () => undefined),
}));

vi.mock('./knowledge/pipeline.js', () => ({
  createKnowledgeLlmRun: createKnowledgeLlmRunMock,
  indexDocument: indexDocumentMock,
  DEFAULT_KB_LLM_CONCURRENCY: 4,
  getKnowledgeLlmConcurrency: getKnowledgeLlmConcurrencyMock,
  getKnowledgeLlmRun: getKnowledgeLlmRunMock,
  listKnowledgeProcessingActivity: listKnowledgeProcessingActivityMock,
  loadKnowledgeLlmRun: loadKnowledgeLlmRunMock,
  runKnowledgeLlmEnhancementPool: runKnowledgeLlmEnhancementPoolMock,
}));

vi.mock('./tenant-context.js', () => ({
  getCurrentUserId: vi.fn(() => 'test-user'),
  SYSTEM_USER_ID: '__system__',
}));

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase, createKnowledgeDocument, updateKnowledgeDocument } from './db/assistants.js';
import { dba } from './db/engine-access.js';
import { getActiveEngine } from './database/engine.js';
import { createKnowledgeSearchEngine } from './knowledge/knowledge-search-engine.js';
import { registerKnowledgeRoutes } from './routes/knowledge-routes.js';
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from './types/context.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-routes',
  name: 'Route KB',
  description: null,
  owner_type: 'user',
  owner_id: 'test-user',
  embedding_model: null,
  chunk_size: 300,
  chunk_overlap: 60,
  cleanup_patterns: null,
  enabled: 1,
  user_id: 'test-user',
  category: 'general',
  visibility: 'private',
  enhancement_level: 'wiki_full',
  llm_provider_id: 'provider-1',
  llm_model_override: null,
  temporal_half_life_days: 365,
  allow_query_backfill: 0,
  created_at: '2026-04-27T00:00:00.000Z',
  updated_at: '2026-04-27T00:00:00.000Z',
};

function createApp() {
  const app = express();
  app.use(express.json());
  registerKnowledgeRoutes(app, {
    requirePermission: allowAllRequirePermission,
  });
  return app;
}

async function createKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<KnowledgeBaseRecord> {
  const record: KnowledgeBaseRecord = {
    ...BASE_KB,
    ...overrides,
    id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}`,
  };
  await createKnowledgeBase(record);
  return record;
}

async function insertIndexedDoc(
  kbId: string,
  id: string,
  filename: string,
  llmStatus: KnowledgeDocumentRecord['llm_status'],
  createdAt: string,
): Promise<void> {
  const record: KnowledgeDocumentRecord = {
    id,
    kb_id: kbId,
    filename,
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
    created_at: createdAt,
    updated_at: createdAt,
  };
  await createKnowledgeDocument(record);
  if (llmStatus !== null) {
    await updateKnowledgeDocument(id, { llm_status: llmStatus });
  }
}

async function insertWikiPage(input: {
  id: string;
  kbId: string;
  pageType: string;
  title: string;
  content: string;
  sourceDocIds: string[];
  updatedAt: string;
}): Promise<void> {
  await dba.prepare(
    `INSERT INTO knowledge_wiki_pages
      (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
       llm_model, version, edited_by_human, edited_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kbId,
    input.pageType,
    input.title,
    input.content,
    JSON.stringify(input.sourceDocIds),
    '[]',
    '[]',
    'gpt-test',
    1,
    0,
    null,
    input.updatedAt,
    input.updatedAt,
  );
  const row = (await dba.prepare('SELECT rowid FROM knowledge_wiki_pages WHERE id = ?').get(input.id)) as { rowid: number };
  await dba.prepare(
    `INSERT OR REPLACE INTO knowledge_wiki_pages_fts (rowid, title, content) VALUES (?, ?, ?)`,
  ).run(row.rowid, input.title, input.content);
}

async function insertWikiClaim(input: {
  id: string;
  pageId: string;
  claimText: string;
  sourceDocId: string | null;
  evidenceChunkId: string | null;
  confidence: number;
  createdAt: string;
}): Promise<void> {
  await dba.prepare(
    `INSERT INTO knowledge_wiki_claims
      (id, page_id, claim_text, source_doc_id, evidence_chunk_id, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.pageId,
    input.claimText,
    input.sourceDocId,
    input.evidenceChunkId,
    input.confidence,
    input.createdAt,
    input.createdAt,
  );
}

describe('knowledge routes', () => {
  beforeEach(async () => {
    _initTestDatabase();
    await createKnowledgeSearchEngine(getActiveEngine().dialect).initialize(getActiveEngine());
    vi.clearAllMocks();
    getKnowledgeLlmRunMock.mockReturnValue(null);
    loadKnowledgeLlmRunMock.mockResolvedValue(null);
    getKnowledgeLlmConcurrencyMock.mockResolvedValue(4);
    listKnowledgeProcessingActivityMock.mockReturnValue([]);
    runKnowledgeLlmEnhancementPoolMock.mockResolvedValue(undefined);
  });

  it('queues every eligible document for manual llm processing without mass-marking backlog as pending', async () => {
    const kb = await createKb();
    for (let i = 0; i < 12; i += 1) {
      const status = i % 3 === 0 ? null : i % 3 === 1 ? 'pending' : 'failed';
      await insertIndexedDoc(
        kb.id,
        `doc-${i}`,
        `Doc ${i}.md`,
        status,
        `2026-04-27T00:00:${String(i).padStart(2, '0')}.000Z`,
      );
    }
    await insertIndexedDoc(kb.id, 'doc-done', 'done.md', 'done', '2026-04-27T00:01:00.000Z');
    await insertIndexedDoc(kb.id, 'doc-processing', 'processing.md', 'processing', '2026-04-27T00:01:01.000Z');

    const app = createApp();
    const response = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/bases/${kb.id}/llm-process`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'started',
      mode: 'recover',
      run_id: `run-${kb.id}`,
      queued: 12,
      eligible_total: 12,
      concurrency: 4,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runKnowledgeLlmEnhancementPoolMock).toHaveBeenCalledTimes(1);
    expect(runKnowledgeLlmEnhancementPoolMock.mock.calls[0]?.[1]).toHaveLength(12);
    expect(runKnowledgeLlmEnhancementPoolMock.mock.calls[0]?.[2]).toBe(4);

    const pendingRow = (await dba
      .prepare(
        `SELECT COUNT(*) AS n
         FROM knowledge_documents
         WHERE kb_id = ? AND llm_status = 'pending'`,
      )
      .get(kb.id)) as { n: number };
    expect(Number(pendingRow.n)).toBe(4);

    const nullRow = (await dba
      .prepare(
        `SELECT COUNT(*) AS n
         FROM knowledge_documents
         WHERE kb_id = ? AND llm_status IS NULL`,
      )
      .get(kb.id)) as { n: number };
    expect(Number(nullRow.n)).toBe(4);

    const failedRow = (await dba
      .prepare(
        `SELECT COUNT(*) AS n
         FROM knowledge_documents
         WHERE kb_id = ? AND llm_status = 'failed'`,
      )
      .get(kb.id)) as { n: number };
    expect(Number(failedRow.n)).toBe(4);
  });

  it('returns aggregated processing progress and parsed latest lint summary', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-a', 'A.md', null, '2026-04-27T00:00:00.000Z');
    await insertIndexedDoc(kb.id, 'doc-b', 'B.md', 'pending', '2026-04-27T00:00:01.000Z');
    await insertIndexedDoc(kb.id, 'doc-c', 'C.md', 'processing', '2026-04-27T00:00:02.000Z');
    await insertIndexedDoc(kb.id, 'doc-d', 'D.md', 'done', '2026-04-27T00:00:03.000Z');
    await insertIndexedDoc(kb.id, 'doc-e', 'E.md', 'done', '2026-04-27T00:00:04.000Z');
    await insertIndexedDoc(kb.id, 'doc-f', 'F.md', 'failed', '2026-04-27T00:00:05.000Z');

    listKnowledgeProcessingActivityMock.mockReturnValue([
      {
        docId: 'doc-wiki',
        kbId: kb.id,
        filename: 'Synthesis.md',
        stage: 'wiki',
        updatedAt: '2026-04-27T00:02:00.000Z',
      },
    ]);

    await dba.prepare(
      `INSERT INTO knowledge_event_log
        (id, kb_id, event_type, doc_id, page_id, title, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'evt-lint',
      kb.id,
      'lint',
      null,
      null,
      'Lint 完成',
      JSON.stringify({
        orphanPages: 2,
        stalePages: 1,
        missingPages: 3,
        contradictions: 1,
        humanEditedPages: 4,
      }),
      '2026-04-27T00:03:00.000Z',
      'test-user',
    );

    const app = createApp();
    const response = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${kb.id}/processing-status`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      run_id: null,
      run_mode: null,
      concurrency_used: null,
      started_at: null,
      finished_at: null,
      eligible_total: 6,
      pending: 2,
      queued: 0,
      processing: 1,
      active_total: 1,
      wiki_processing: 1,
      done: 2,
      failed: 1,
      processed_total: 3,
      progress_percent: 50,
      stage: 'wiki_building',
      active_docs: [
        {
          id: 'doc-wiki',
          filename: 'Synthesis.md',
          llm_status: 'wiki',
          updated_at: '2026-04-27T00:02:00.000Z',
        },
      ],
      last_lint: {
        ran_at: '2026-04-27T00:03:00.000Z',
        orphan_count: 2,
        stale_count: 1,
        missing_count: 3,
        contradiction_count: 1,
        human_locked_count: 4,
      },
    });
  });

  it('rebuilds one indexed document through rebuild_docs mode', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-a', 'A.md', 'done', '2026-04-27T00:00:00.000Z');

    const app = createApp();
    const response = await inject(app, {
      method: 'POST',
      url: `/api/knowledge/documents/doc-a/rebuild-llm`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'started',
      mode: 'rebuild_docs',
      queued: 1,
      eligible_total: 1,
      concurrency: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runKnowledgeLlmEnhancementPoolMock).toHaveBeenCalledTimes(1);
    expect(runKnowledgeLlmEnhancementPoolMock.mock.calls[0]?.[1]).toEqual([
      { id: 'doc-a', filename: 'A.md' },
    ]);
    expect(runKnowledgeLlmEnhancementPoolMock.mock.calls[0]?.[2]).toBe(1);
  });

  it('returns graph nodes with processed flags, llm status, and computed degree', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-root', 'Root.md', 'done', '2026-04-27T00:00:00.000Z');
    await insertIndexedDoc(kb.id, 'doc-child', 'Child.md', 'pending', '2026-04-27T00:00:01.000Z');
    await insertIndexedDoc(kb.id, 'doc-ref', 'Ref.md', 'failed', '2026-04-27T00:00:02.000Z');

    await updateKnowledgeDocument('doc-child', { parent_doc_id: 'doc-root', depth: 1 });
    await updateKnowledgeDocument('doc-ref', { depth: 1 });

    await dba.prepare(
      `INSERT INTO knowledge_doc_relations
        (id, source_doc_id, target_doc_id, relation_type, confidence, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rel-1',
      'doc-root',
      'doc-ref',
      'references',
      0.88,
      'root references ref',
      '2026-04-27T00:05:00.000Z',
    );

    await dba.prepare(
      `INSERT INTO knowledge_wiki_pages
        (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
         llm_model, version, edited_by_human, edited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'wiki-1',
      kb.id,
      'synthesis',
      '综合页',
      'summary',
      JSON.stringify(['doc-root']),
      '[]',
      '[]',
      'gpt-test',
      1,
      0,
      null,
      '2026-04-27T00:06:00.000Z',
      '2026-04-27T00:06:00.000Z',
    );

    const app = createApp();
    const response = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${kb.id}/graph?view=full&min_confidence=0`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      nodes: Array<Record<string, unknown>>;
      links: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
      truncated: boolean;
    };
    const nodeById = new Map(body.nodes.map((node) => [String(node.id), node]));

    expect(nodeById.get('doc-root')).toMatchObject({
      type: 'document',
      processed: true,
      llmStatus: 'done',
      status: 'indexed',
      degree: 3,
    });
    expect(nodeById.get('doc-child')).toMatchObject({
      type: 'document',
      processed: false,
      llmStatus: 'pending',
      degree: 1,
    });
    expect(nodeById.get('wiki-1')).toMatchObject({
      type: 'wiki',
      processed: true,
      status: 'ready',
      degree: 1,
    });
    expect(body.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'doc-root', target: 'doc-child', type: 'parent_of' }),
      expect.objectContaining({ source: 'doc-root', target: 'doc-ref', type: 'references', confidence: 0.88 }),
      expect.objectContaining({ source: 'doc-root', target: 'wiki-1', type: 'wiki_source' }),
    ]));
    expect(body.stats).toMatchObject({ view: 'full', total_nodes: 4, visible_nodes: 4 });
    expect(body.truncated).toBe(false);
  });

  it('returns overview graph metadata with default pruning and focus subgraphs', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-a', 'A.md', 'done', '2026-04-27T00:00:00.000Z');
    await insertIndexedDoc(kb.id, 'doc-b', 'B.md', 'done', '2026-04-27T00:00:01.000Z');
    await insertIndexedDoc(kb.id, 'doc-c', 'C.md', 'pending', '2026-04-27T00:00:02.000Z');
    await insertIndexedDoc(kb.id, 'doc-root', 'Root.md', 'done', '2026-04-27T00:00:02.500Z');
    await insertIndexedDoc(kb.id, 'doc-leaf', 'Leaf.md', 'done', '2026-04-27T00:00:02.800Z');
    await updateKnowledgeDocument('doc-leaf', { parent_doc_id: 'doc-root', depth: 1 });
    await dba.prepare(
      `INSERT INTO knowledge_doc_relations
        (id, source_doc_id, target_doc_id, relation_type, confidence, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'rel-strong',
      'doc-a',
      'doc-b',
      'references',
      0.9,
      null,
      '2026-04-27T00:05:00.000Z',
      'rel-weak',
      'doc-a',
      'doc-c',
      'references',
      0.2,
      null,
      '2026-04-27T00:05:01.000Z',
    );

    const app = createApp();
    const overview = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${kb.id}/graph`,
    });
    expect(overview.statusCode).toBe(200);
    const overviewBody = JSON.parse(overview.body) as {
      nodes: Array<{ id: string }>;
      links: Array<{ source: string; target: string; type: string }>;
      stats: Record<string, unknown>;
      hidden_counts: Record<string, unknown>;
      truncated: boolean;
    };
    expect(overviewBody.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['doc-a', 'doc-b']));
    expect(overviewBody.nodes.map((node) => node.id)).not.toContain('doc-c');
    expect(overviewBody.nodes.map((node) => node.id)).not.toContain('doc-leaf');
    expect(overviewBody.links).toEqual([
      expect.objectContaining({ source: 'doc-a', target: 'doc-b', type: 'references' }),
    ]);
    expect(overviewBody.stats).toMatchObject({ view: 'overview', min_confidence: 0.7 });
    expect(overviewBody.hidden_counts).toMatchObject({
      unprocessed_nodes: 1,
      tree_leaf_nodes: 1,
      low_confidence_relations: 1,
    });
    expect(overviewBody.truncated).toBe(true);

    const focus = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${kb.id}/graph?view=focus&focus_id=doc-a&min_confidence=0`,
    });
    expect(focus.statusCode).toBe(200);
    const focusBody = JSON.parse(focus.body) as { nodes: Array<{ id: string }>; stats: Record<string, unknown> };
    expect(focusBody.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['doc-a', 'doc-b', 'doc-c']));
    expect(focusBody.stats).toMatchObject({ view: 'focus', focus_id: 'doc-a' });
  });

  it('returns wiki page claims with chunk evidence', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-claim', 'Claims.md', 'done', '2026-04-27T00:00:00.000Z');
    await dba.prepare(
      `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-claim',
      'doc-claim',
      0,
      '核心事实说明 NanoClaw 支持 Wiki claim evidence 绑定。',
      16,
      '2026-04-27T00:00:00.000Z',
    );
    await dba.prepare(
      `INSERT INTO knowledge_wiki_pages
        (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
         llm_model, version, edited_by_human, edited_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'wiki-claim',
      kb.id,
      'concept',
      'Claim Evidence',
      '# Claim Evidence\n\n## 核心事实\n- NanoClaw 支持 Wiki claim evidence 绑定。\n\n## 来源\n- Claims.md',
      JSON.stringify(['doc-claim']),
      '[]',
      '[]',
      'gpt-test',
      1,
      0,
      null,
      '2026-04-27T00:06:00.000Z',
      '2026-04-27T00:06:00.000Z',
    );
    const { syncWikiClaimsForPage } = await import('./knowledge/wiki-claims.js');
    await syncWikiClaimsForPage({
      pageId: 'wiki-claim',
      content: '# Claim Evidence\n\n## 核心事实\n- NanoClaw 支持 Wiki claim evidence 绑定。\n\n## 来源\n- Claims.md',
      sourceDocIds: JSON.stringify(['doc-claim']),
    });

    const app = createApp();
    const response = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/wiki-pages/wiki-claim',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { claims: Array<Record<string, unknown>> };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]).toMatchObject({
      claim_text: 'NanoClaw 支持 Wiki claim evidence 绑定。',
      source_doc_id: 'doc-claim',
      evidence_chunk_id: 'chunk-claim',
    });
    expect(body.claims[0]?.evidence).toMatchObject({
      chunkId: 'chunk-claim',
      documentId: 'doc-claim',
      filename: 'Claims.md',
    });
  });

  it('prefers exact-title wiki pages with evidenced claims in search results', async () => {
    const kb = await createKb();
    await insertIndexedDoc(kb.id, 'doc-best', 'Best.md', 'done', '2026-04-27T00:00:00.000Z');
    await insertIndexedDoc(kb.id, 'doc-alt', 'Alt.md', 'done', '2026-04-27T00:00:01.000Z');
    await dba.prepare(
      `INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'chunk-best',
      'doc-best',
      0,
      'NanoClaw 部署指南说明了完整部署流程和环境准备。',
      20,
      '2026-04-27T00:00:00.000Z',
    );

    await insertWikiPage({
      id: 'wiki-best',
      kbId: kb.id,
      pageType: 'entity',
      title: 'NanoClaw 部署指南',
      content: '# NanoClaw 部署指南\n\n## 核心事实\n- 先准备环境再部署。\n\n## 来源\n- Best.md',
      sourceDocIds: ['doc-best'],
      updatedAt: '2026-04-27T00:00:02.000Z',
    });
    await insertWikiPage({
      id: 'wiki-alt',
      kbId: kb.id,
      pageType: 'comparison',
      title: 'NanoClaw 指南',
      content: '# NanoClaw 指南\n\n## 核心事实\n- 泛化说明。\n\n## 来源\n- Alt.md',
      sourceDocIds: ['doc-alt'],
      updatedAt: '2026-04-27T00:00:02.000Z',
    });
    await insertWikiClaim({
      id: 'claim-best',
      pageId: 'wiki-best',
      claimText: '先准备环境再部署。',
      sourceDocId: 'doc-best',
      evidenceChunkId: 'chunk-best',
      confidence: 0.92,
      createdAt: '2026-04-27T00:00:03.000Z',
    });

    const app = createApp();
    const response = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/search',
      payload: {
        query: 'NanoClaw 部署指南',
        kb_ids: [kb.id],
        top_k: 5,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      wiki: Array<{ pageId: string; title: string; claimEvidence?: unknown[] }>;
    };
    expect(body.wiki[0]).toMatchObject({
      pageId: 'wiki-best',
      title: 'NanoClaw 部署指南',
    });
    expect(body.wiki[0]?.claimEvidence).toHaveLength(1);
  });
});
