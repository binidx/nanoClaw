import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callKbLlmMock } = vi.hoisted(() => ({
  callKbLlmMock: vi.fn(),
}));

vi.mock('./knowledge/llm-call.js', () => ({
  callKbLlm: callKbLlmMock,
}));

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase, createKnowledgeDocument, updateKnowledgeDocument } from './db/assistants.js';
import { dba } from './db/engine-access.js';
import { updateOrCreateWikiPages } from './knowledge/wiki-maintainer.js';
import type { KbLlmConfig } from './knowledge/llm-call.js';
import type { KnowledgeBaseRecord, KnowledgeDocumentRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-wiki-rebuild',
  name: 'Wiki Rebuild KB',
  description: null,
  owner_type: 'system',
  owner_id: null,
  embedding_model: null,
  chunk_size: 300,
  chunk_overlap: 60,
  cleanup_patterns: null,
  enabled: 1,
  user_id: '__system__',
  category: 'general',
  visibility: 'private',
  enhancement_level: 'wiki_full',
  llm_provider_id: 'fake-provider',
  llm_model_override: 'gpt-test',
  temporal_half_life_days: 365,
  allow_query_backfill: 0,
  created_at: '2026-04-27T00:00:00.000Z',
  updated_at: '2026-04-27T00:00:00.000Z',
};

const TEST_LLM_CONFIG: KbLlmConfig = {
  userId: '__system__',
  llmProviderId: 'fake-provider',
  llmModelOverride: 'gpt-test',
};

async function createKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<string> {
  const rec = { ...BASE_KB, ...overrides, id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}` };
  await createKnowledgeBase(rec);
  return rec.id;
}

async function insertIndexedDoc(
  kbId: string,
  id: string,
  filename: string,
  summary: string,
  opts: {
    topics?: string[];
    entities?: Array<{ name: string; type: string; salience: number }>;
    llmStatus?: KnowledgeDocumentRecord['llm_status'];
    updatedAt?: string;
  } = {},
): Promise<void> {
  const updatedAt = opts.updatedAt ?? new Date().toISOString();
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
    created_at: updatedAt,
    updated_at: updatedAt,
  };
  await createKnowledgeDocument(record);
  await updateKnowledgeDocument(id, { llm_status: opts.llmStatus ?? 'done' });
  await dba.prepare(
    `INSERT INTO knowledge_doc_summaries
      (id, document_id, summary, entities, topics, llm_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `sum-${id}`,
    id,
    summary,
    JSON.stringify(opts.entities ?? []),
    JSON.stringify(opts.topics ?? []),
    'gpt-test',
    updatedAt,
    updatedAt,
  );
}

async function insertWikiPage(
  kbId: string,
  id: string,
  title: string,
  sourceDocIds: string[],
  content: string,
): Promise<void> {
  const ts = new Date().toISOString();
  await dba.prepare(
    `INSERT INTO knowledge_wiki_pages
      (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
       llm_model, version, edited_by_human, edited_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kbId,
    'entity',
    title,
    content,
    JSON.stringify(sourceDocIds),
    '[]',
    '[]',
    'gpt-test',
    1,
    0,
    null,
    ts,
    ts,
  );
}

describe('wiki rebuild generation', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('rebuilds an entity page from all source summaries instead of old page content', async () => {
    const kbId = await createKb();
    await insertIndexedDoc(kbId, 'doc-a', 'a.md', '旧文档摘要：介绍 Kubernetes 集群基础。', {
      topics: ['k8s'],
      entities: [{ name: 'Kubernetes', type: 'term', salience: 0.9 }],
      updatedAt: '2026-04-27T00:00:01.000Z',
    });
    await insertIndexedDoc(kbId, 'doc-b', 'b.md', '新文档摘要：补充调度器、节点和命名空间。', {
      topics: ['scheduler'],
      entities: [{ name: 'Kubernetes', type: 'term', salience: 0.95 }],
      updatedAt: '2026-04-27T00:00:02.000Z',
    });
    await insertWikiPage(kbId, 'page-1', 'Kubernetes', ['doc-a'], '这是旧页面内容，不应该原样喂给模型');
    callKbLlmMock.mockResolvedValue('新的 Kubernetes Wiki 页面');

    await updateOrCreateWikiPages(
      kbId,
      'doc-b',
      [{ name: 'Kubernetes', type: 'term', salience: 0.95 }],
      [],
      'ignored current summary',
      TEST_LLM_CONFIG,
    );

    expect(callKbLlmMock).toHaveBeenCalledTimes(1);
    const prompt = String(callKbLlmMock.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('旧文档摘要：介绍 Kubernetes 集群基础。');
    expect(prompt).toContain('新文档摘要：补充调度器、节点和命名空间。');
    expect(prompt).not.toContain('这是旧页面内容，不应该原样喂给模型');

    const row = (await dba.prepare(
      'SELECT content, source_doc_ids, version FROM knowledge_wiki_pages WHERE id = ?',
    ).get('page-1')) as { content: string; source_doc_ids: string; version: number };
    expect(row.content).toContain('# Kubernetes');
    expect(row.content).toContain('## 摘要');
    expect(row.content).toContain('## 来源');
    expect(row.content).not.toContain('这是旧页面内容，不应该原样喂给模型');
    expect(row.source_doc_ids).toBe(JSON.stringify(['doc-a', 'doc-b']));
    expect(Number(row.version)).toBe(2);
  });

  it('builds synthesis pages from multiple completed document summaries', async () => {
    const kbId = await createKb();
    await insertIndexedDoc(kbId, 'doc-1', 'one.md', '文档一摘要：系统架构概览。', { updatedAt: '2026-04-27T00:00:01.000Z' });
    await insertIndexedDoc(kbId, 'doc-2', 'two.md', '文档二摘要：部署与运行步骤。', { updatedAt: '2026-04-27T00:00:02.000Z' });
    await insertIndexedDoc(kbId, 'doc-3', 'three.md', '文档三摘要：排障与常见问题。', { updatedAt: '2026-04-27T00:00:03.000Z' });
    callKbLlmMock.mockResolvedValue('知识库综合页');

    await updateOrCreateWikiPages(
      kbId,
      'doc-3',
      [],
      [],
      'ignored synthesis summary',
      TEST_LLM_CONFIG,
    );

    expect(callKbLlmMock).toHaveBeenCalledTimes(1);
    const prompt = String(callKbLlmMock.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('文档一摘要：系统架构概览。');
    expect(prompt).toContain('文档二摘要：部署与运行步骤。');
    expect(prompt).toContain('文档三摘要：排障与常见问题。');

    const row = (await dba.prepare(
      `SELECT title, page_type, source_doc_ids, content
       FROM knowledge_wiki_pages
       WHERE kb_id = ? AND page_type = 'synthesis'`,
    ).get(kbId)) as { title: string; page_type: string; source_doc_ids: string; content: string };
    expect(row.title).toBe('知识库综合');
    expect(row.page_type).toBe('synthesis');
    expect(JSON.parse(row.source_doc_ids)).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(row.content).toContain('# 知识库综合');
    expect(row.content).toContain('## 核心事实');
    expect(row.content).toContain('源文档 doc-3 | three.md');
  });

  it('falls back to a structured wiki page when the model output is too short', async () => {
    const kbId = await createKb();
    await insertIndexedDoc(kbId, 'doc-fallback', 'guide.md', '部署流程包含环境检查、配置发布与结果验证。', {
      topics: ['部署流程'],
      entities: [{ name: '部署流程', type: 'concept', salience: 0.92 }],
      updatedAt: '2026-04-27T00:00:01.000Z',
    });
    callKbLlmMock.mockResolvedValue('太短');

    await updateOrCreateWikiPages(
      kbId,
      'doc-fallback',
      [{ name: '部署流程', type: 'concept', salience: 0.92 }],
      ['部署流程'],
      'ignored',
      TEST_LLM_CONFIG,
    );

    const row = (await dba.prepare(
      `SELECT title, page_type, content
       FROM knowledge_wiki_pages
       WHERE kb_id = ? AND title = ?`,
    ).get(kbId, '部署流程')) as { title: string; page_type: string; content: string };
    expect(row.page_type).toBe('entity');
    expect(row.content).toContain('# 部署流程');
    expect(row.content).toContain('## 摘要');
    expect(row.content).toContain('## 核心事实');
    expect(row.content).toContain('## 来源');
    expect(row.content).toContain('源文档 doc-fallback | guide.md');
  });

  it('recomputes concept page source docs from current topic matches in the KB', async () => {
    const kbId = await createKb();
    await insertIndexedDoc(kbId, 'doc-topic-a', 'a.md', '订单规则文档一：解释触发条件与优先级。', {
      topics: ['订单规则'],
      updatedAt: '2026-04-27T00:00:01.000Z',
    });
    await insertIndexedDoc(kbId, 'doc-topic-b', 'b.md', '订单规则文档二：补充执行流程与例外场景。', {
      topics: ['订单规则'],
      updatedAt: '2026-04-27T00:00:02.000Z',
    });
    callKbLlmMock.mockResolvedValue(`
# 订单规则

## 摘要
订单规则综述。

## 核心事实
- 条件一

## 来源
- placeholder
`.trim());

    await updateOrCreateWikiPages(
      kbId,
      'doc-topic-b',
      [],
      ['订单规则'],
      'ignored',
      TEST_LLM_CONFIG,
    );

    const row = (await dba.prepare(
      `SELECT page_type, source_doc_ids
       FROM knowledge_wiki_pages
       WHERE kb_id = ? AND title = ?`,
    ).get(kbId, '订单规则')) as { page_type: string; source_doc_ids: string };
    expect(row.page_type).toBe('concept');
    expect(JSON.parse(row.source_doc_ids)).toEqual(['doc-topic-a', 'doc-topic-b']);
  });
});
