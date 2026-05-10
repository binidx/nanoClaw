import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase } from './db/assistants.js';
import { backfillQueryToWiki, QueryBackfillError } from './knowledge/query-backfill.js';
import { dba } from './db/engine-access.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-bf',
  name: 'Backfill KB',
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
  allow_query_backfill: 1,
  created_at: '2026-04-17T00:00:00.000Z',
  updated_at: '2026-04-17T00:00:00.000Z',
};

async function createKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<string> {
  const rec = { ...BASE_KB, ...overrides, id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}` };
  await createKnowledgeBase(rec);
  return rec.id;
}

async function countComparisonPages(kbId: string): Promise<number> {
  const row = (await dba
    .prepare("SELECT COUNT(*) AS n FROM knowledge_wiki_pages WHERE kb_id = ? AND page_type = 'comparison'")
    .get(kbId)) as { n: number };
  return Number(row.n);
}

describe('backfillQueryToWiki', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rejects when the KB has allow_query_backfill=0', async () => {
    const kbId = await createKb({ allow_query_backfill: 0 });
    await expect(
      backfillQueryToWiki({
        kbId,
        title: 'x',
        content: 'y',
        sourceQuery: '',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects when the KB does not exist (404)', async () => {
    await expect(
      backfillQueryToWiki({
        kbId: 'no-such-kb',
        title: 'x',
        content: 'y',
        sourceQuery: '',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects title > 255 chars (400)', async () => {
    const kbId = await createKb();
    const longTitle = 'a'.repeat(256);
    await expect(
      backfillQueryToWiki({ kbId, title: longTitle, content: 'y', sourceQuery: '', userId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects content above the 256KB ceiling (413)', async () => {
    const kbId = await createKb();
    const bigContent = 'a'.repeat(256 * 1024 + 1);
    await expect(
      backfillQueryToWiki({ kbId, title: 'ok', content: bigContent, sourceQuery: '', userId: 'user-1' }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('inserts a new comparison page on first save', async () => {
    const kbId = await createKb();
    const { pageId } = await backfillQueryToWiki({
      kbId,
      title: 'Q1',
      content: 'first answer',
      sourceQuery: 'what is X?',
      userId: 'user-1',
    });

    expect(pageId).toBeTruthy();
    expect(await countComparisonPages(kbId)).toBe(1);

    const row = (await dba
      .prepare('SELECT content, version FROM knowledge_wiki_pages WHERE id = ?')
      .get(pageId)) as { content: string; version: number };
    expect(row.content).toBe('first answer');
    expect(Number(row.version)).toBe(1);
  });

  it('upserts on repeated save of the same title (same row, version bumps)', async () => {
    const kbId = await createKb();
    const first = await backfillQueryToWiki({
      kbId,
      title: 'Q1',
      content: 'first',
      sourceQuery: '',
      userId: 'user-1',
    });
    const second = await backfillQueryToWiki({
      kbId,
      title: 'Q1',
      content: 'second',
      sourceQuery: '',
      userId: 'user-1',
    });

    expect(second.pageId).toBe(first.pageId);
    expect(await countComparisonPages(kbId)).toBe(1);

    const row = (await dba
      .prepare('SELECT content, version FROM knowledge_wiki_pages WHERE id = ?')
      .get(first.pageId)) as { content: string; version: number };
    expect(row.content).toBe('second');
    expect(Number(row.version)).toBe(2);
  });

  it('rate-limits to 5 saves/min per (user, kb); 6th returns 429', async () => {
    const kbId = await createKb();
    const uniqueUser = `user-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 5; i++) {
      await backfillQueryToWiki({
        kbId,
        title: `Q${i}`,
        content: `body ${i}`,
        sourceQuery: '',
        userId: uniqueUser,
      });
    }
    await expect(
      backfillQueryToWiki({
        kbId,
        title: 'Q6',
        content: 'body 6',
        sourceQuery: '',
        userId: uniqueUser,
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('QueryBackfillError is an instance of Error with statusCode', () => {
    const err = new QueryBackfillError('nope', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(400);
  });
});
