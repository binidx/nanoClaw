import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase } from './db/assistants.js';
import { dba } from './db/engine-access.js';
import {
  applyWikiEdit,
  revertWikiHumanEdit,
  WikiEditError,
} from './knowledge/wiki-edit-service.js';
import { lintWiki, updateOrCreateWikiPages } from './knowledge/wiki-maintainer.js';
import type { KbLlmConfig } from './knowledge/llm-call.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-edit',
  name: 'Edit KB',
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
  created_at: '2026-04-17T00:00:00.000Z',
  updated_at: '2026-04-17T00:00:00.000Z',
};

async function createKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<string> {
  const rec = { ...BASE_KB, ...overrides, id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}` };
  await createKnowledgeBase(rec);
  return rec.id;
}

interface InsertedPage { id: string; createdAt: string }

async function insertWikiPage(
  kbId: string,
  opts: { title?: string; pageType?: string; editedByHuman?: 0 | 1; content?: string } = {},
): Promise<InsertedPage> {
  const id = `wp-${Math.random().toString(36).slice(2)}`;
  const ts = new Date().toISOString();
  const editedByHuman = opts.editedByHuman ?? 0;
  await dba
    .prepare(
      `INSERT INTO knowledge_wiki_pages
        (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
         llm_model, version, edited_by_human, edited_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      kbId,
      opts.pageType ?? 'entity',
      opts.title ?? 'Kubernetes',
      opts.content ?? '初版人工内容',
      '[]',
      '[]',
      '[]',
      editedByHuman ? 'human' : 'gpt-4',
      1,
      editedByHuman,
      editedByHuman ? ts : null,
      ts,
      ts,
    );
  return { id, createdAt: ts };
}

const NO_LLM_CONFIG: KbLlmConfig = { userId: '__system__', llmProviderId: 'fake-provider' };

describe('PR Q-Edit · wiki page human-edit lock', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('lintWiki returns humanEditedPages containing locked page ids', async () => {
    const kbId = await createKb();
    const locked = await insertWikiPage(kbId, { title: 'Kubernetes', editedByHuman: 1 });
    const free = await insertWikiPage(kbId, { title: 'Docker', editedByHuman: 0 });

    const report = await lintWiki(kbId);
    expect(report.humanEditedPages).toContain(locked.id);
    expect(report.humanEditedPages).not.toContain(free.id);
  });

  it('lintWiki humanEditedPages is empty when no page is locked', async () => {
    const kbId = await createKb();
    await insertWikiPage(kbId, { editedByHuman: 0 });
    const report = await lintWiki(kbId);
    expect(report.humanEditedPages).toEqual([]);
  });

  it('updateOrCreateWikiPages skips entity pages with edited_by_human=1 (no LLM call, content untouched)', async () => {
    const kbId = await createKb();
    const locked = await insertWikiPage(kbId, { title: 'Kubernetes', editedByHuman: 1, content: '人工保护内容' });

    // doc count below synthesis threshold (3) so the synthesis branch is skipped
    // and updateOrCreateWikiPages only touches the matching entity page, which
    // hits the human-edit guard and returns without calling the LLM.
    await updateOrCreateWikiPages(
      kbId,
      'doc-x',
      [{ name: 'Kubernetes', type: 'TECH', salience: 0.9 }],
      [],
      'k8s 是容器编排系统',
      NO_LLM_CONFIG,
    );

    const row = (await dba
      .prepare('SELECT content, version, edited_by_human FROM knowledge_wiki_pages WHERE id = ?')
      .get(locked.id)) as { content: string; version: number; edited_by_human: number };
    expect(row.content).toBe('人工保护内容');
    expect(Number(row.version)).toBe(1);
    expect(Number(row.edited_by_human)).toBe(1);

    // m-1 regression: a skipped human-edited page MUST NOT be added to `affected`,
    // so the LLM rebuild must not emit a wiki_update event referencing it
    // (otherwise audit logs report false positives — pages "rebuilt" that never were).
    const evt = (await dba
      .prepare(
        `SELECT COUNT(*) AS c FROM knowledge_event_log
         WHERE kb_id = ? AND event_type = 'wiki_update'`,
      )
      .get(kbId)) as { c: number | bigint };
    expect(Number(evt.c)).toBe(0);
  });

  it('schema migration: edited_by_human / edited_at columns exist with correct defaults', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { editedByHuman: 0 });
    const row = (await dba
      .prepare('SELECT edited_by_human, edited_at FROM knowledge_wiki_pages WHERE id = ?')
      .get(id)) as { edited_by_human: number; edited_at: string | null };
    expect(Number(row.edited_by_human)).toBe(0);
    expect(row.edited_at).toBeNull();
  });

  it('lock then revert flow: edited_by_human flips 1 -> 0, edited_at clears', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { editedByHuman: 1 });

    // Simulate the revert endpoint's UPDATE
    await dba
      .prepare(`UPDATE knowledge_wiki_pages SET edited_by_human = 0, edited_at = NULL WHERE id = ?`)
      .run(id);
    const row = (await dba
      .prepare('SELECT edited_by_human, edited_at FROM knowledge_wiki_pages WHERE id = ?')
      .get(id)) as { edited_by_human: number; edited_at: string | null };
    expect(Number(row.edited_by_human)).toBe(0);
    expect(row.edited_at).toBeNull();

    // After revert, the lint report no longer lists it
    const report = await lintWiki(kbId);
    expect(report.humanEditedPages).not.toContain(id);
  });
});

describe('PR Q-Edit · applyWikiEdit (route service)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('200: writes content, bumps version, locks, returns metadata', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { editedByHuman: 0 });
    const before = Date.now();
    const out = await applyWikiEdit({
      pageId: id,
      userId: '__system__',
      title: 'Kubernetes (人工)',
      content: '人工权威版本',
      expectedVersion: 1,
    });
    expect(out.id).toBe(id);
    expect(out.version).toBe(2);
    expect(out.edited_by_human).toBe(1);
    expect(Date.parse(out.edited_at)).toBeGreaterThanOrEqual(before);

    const row = (await dba
      .prepare('SELECT title, content, version, edited_by_human, llm_model FROM knowledge_wiki_pages WHERE id = ?')
      .get(id)) as { title: string; content: string; version: number; edited_by_human: number; llm_model: string };
    expect(row.title).toBe('Kubernetes (人工)');
    expect(row.content).toBe('人工权威版本');
    expect(Number(row.version)).toBe(2);
    expect(Number(row.edited_by_human)).toBe(1);
    expect(row.llm_model).toBe('human');
  });

  it('400: rejects empty title / empty content / missing expected_version', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId);
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: '   ', content: 'x', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: 't', content: '   ', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: 't', content: 'x', expectedVersion: 0 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('400: rejects editing overview pages', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { pageType: 'overview', title: '索引' });
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: '索引', content: 'x', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('413: rejects content over 512KB', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId);
    const huge = 'x'.repeat(512 * 1024 + 10);
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: 't', content: huge, expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  it('409: rejects when expected_version stale (mismatch detected before UPDATE)', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId);
    await expect(
      applyWikiEdit({ pageId: id, userId: '__system__', title: 't', content: 'x', expectedVersion: 99 }),
    ).rejects.toMatchObject({ statusCode: 409, details: { current_version: 1 } });
  });

  it('409: SQL-level optimistic lock catches concurrent writer (TOCTOU)', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId);
    // Simulate a concurrent UPDATE that bumps version between the JS-level
    // version check and the conditional UPDATE. The WHERE id=? AND version=?
    // clause must catch this and surface 409.
    let firstSqlPrepared = false;
    const origPrepare = dba.prepare.bind(dba);
    (dba as unknown as { prepare: typeof dba.prepare }).prepare = ((sql: string) => {
      if (!firstSqlPrepared && sql.includes('UPDATE knowledge_wiki_pages') && sql.includes('AND version = ?')) {
        firstSqlPrepared = true;
        const ts = new Date().toISOString();
        // synchronous race: bump version BEFORE the lock UPDATE runs
        dba.prepare(`UPDATE knowledge_wiki_pages SET version = 99, updated_at = ? WHERE id = ?`).run(ts, id);
      }
      return origPrepare(sql);
    }) as typeof dba.prepare;
    try {
      await expect(
        applyWikiEdit({ pageId: id, userId: '__system__', title: 't', content: 'x', expectedVersion: 1 }),
      ).rejects.toMatchObject({ statusCode: 409, details: { current_version: 99 } });
    } finally {
      (dba as unknown as { prepare: typeof dba.prepare }).prepare = origPrepare;
    }
  });

  it('403: non-owner non-SYSTEM cannot edit private kb', async () => {
    const kbId = await createKb({ user_id: 'owner-A', visibility: 'private' });
    const { id } = await insertWikiPage(kbId);
    await expect(
      applyWikiEdit({ pageId: id, userId: 'intruder-B', title: 't', content: 'x', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(WikiEditError);
  });

  it('404: missing page id', async () => {
    await expect(
      applyWikiEdit({ pageId: 'nope', userId: '__system__', title: 't', content: 'x', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('PR Q-Edit · revertWikiHumanEdit (route service)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('200: clears edited_by_human / edited_at, leaves content & version untouched', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { editedByHuman: 1, content: '人工内容' });
    const before = (await dba
      .prepare('SELECT content, version, updated_at FROM knowledge_wiki_pages WHERE id = ?')
      .get(id)) as { content: string; version: number; updated_at: string };

    const out = await revertWikiHumanEdit({ pageId: id, userId: '__system__' });
    expect(out).toEqual({ id, edited_by_human: 0 });

    const after = (await dba
      .prepare('SELECT content, version, updated_at, edited_by_human, edited_at FROM knowledge_wiki_pages WHERE id = ?')
      .get(id)) as { content: string; version: number; updated_at: string; edited_by_human: number; edited_at: string | null };
    expect(after.content).toBe(before.content);
    expect(Number(after.version)).toBe(Number(before.version));
    expect(after.updated_at).toBe(before.updated_at);
    expect(Number(after.edited_by_human)).toBe(0);
    expect(after.edited_at).toBeNull();
  });

  it('emits wiki_update event with payload.mode = revert_human_edit', async () => {
    const kbId = await createKb();
    const { id } = await insertWikiPage(kbId, { editedByHuman: 1 });
    await revertWikiHumanEdit({ pageId: id, userId: '__system__' });

    const evt = (await dba
      .prepare(
        `SELECT event_type, page_id, payload FROM knowledge_event_log
         WHERE kb_id = ? AND event_type = 'wiki_update' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(kbId)) as { event_type: string; page_id: string; payload: string } | undefined;
    expect(evt?.event_type).toBe('wiki_update');
    expect(evt?.page_id).toBe(id);
    const payload = JSON.parse(String(evt?.payload ?? '{}'));
    expect(payload.mode).toBe('revert_human_edit');
  });

  it('403: non-owner non-SYSTEM cannot revert private kb', async () => {
    const kbId = await createKb({ user_id: 'owner-A', visibility: 'private' });
    const { id } = await insertWikiPage(kbId, { editedByHuman: 1 });
    await expect(revertWikiHumanEdit({ pageId: id, userId: 'intruder-B' })).rejects.toBeInstanceOf(WikiEditError);
  });

  it('404: missing page id', async () => {
    await expect(revertWikiHumanEdit({ pageId: 'nope', userId: '__system__' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
