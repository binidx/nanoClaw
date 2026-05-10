import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db/init.js';
import { createKnowledgeBase } from './db/assistants.js';
import {
  appendKbEvent,
  clearOverviewDirty,
  KB_EVENT_TYPES,
  listDirtyOverviewKbs,
  listRecentEvents,
  markOverviewDirty,
  pruneAllEventLogs,
} from './knowledge/event-log.js';
import { dba } from './db/engine-access.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-test',
  name: 'Test KB',
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
  enhancement_level: 'metadata',
  llm_provider_id: null,
  llm_model_override: null,
  temporal_half_life_days: 365,
  allow_query_backfill: 0,
  created_at: '2026-04-17T00:00:00.000Z',
  updated_at: '2026-04-17T00:00:00.000Z',
};

async function createFreshKb(overrides: Partial<KnowledgeBaseRecord> = {}): Promise<string> {
  const record = { ...BASE_KB, ...overrides, id: overrides.id ?? `kb-${Math.random().toString(36).slice(2)}` };
  await createKnowledgeBase(record);
  return record.id;
}

describe('knowledge event log', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('KB_EVENT_TYPES covers the documented 8 event categories', () => {
    expect(new Set(KB_EVENT_TYPES)).toEqual(
      new Set([
        'ingest',
        'reindex',
        'delete',
        'llm_enhance',
        'wiki_update',
        'lint',
        'query_backfill',
        'supersede',
      ]),
    );
  });

  it('appendKbEvent persists a row and auto-marks overview as dirty', async () => {
    const kbId = await createFreshKb();
    await appendKbEvent({ kbId, eventType: 'ingest', title: 'doc A 入库' });

    const rows = await listRecentEvents(kbId);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('ingest');
    expect(rows[0].title).toBe('doc A 入库');

    const dirty = await listDirtyOverviewKbs();
    expect(dirty).toContain(kbId);
  });

  it('listRecentEvents orders newest-first, honors limit, and filters by type', async () => {
    const kbId = await createFreshKb();
    for (let i = 0; i < 6; i++) {
      await appendKbEvent({ kbId, eventType: i % 2 === 0 ? 'ingest' : 'lint', title: `e${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }

    const all = await listRecentEvents(kbId, 3);
    expect(all.map((r) => r.title)).toEqual(['e5', 'e4', 'e3']);

    const onlyIngest = await listRecentEvents(kbId, 10, 'ingest');
    expect(onlyIngest.every((r) => r.event_type === 'ingest')).toBe(true);
    expect(onlyIngest.map((r) => r.title)).toEqual(['e4', 'e2', 'e0']);
  });

  it('markOverviewDirty / listDirtyOverviewKbs / clearOverviewDirty round-trip', async () => {
    const kbIdA = await createFreshKb({ id: 'kb-a' });
    const kbIdB = await createFreshKb({ id: 'kb-b' });

    await markOverviewDirty(kbIdA);
    await markOverviewDirty(kbIdB);
    expect(new Set(await listDirtyOverviewKbs())).toEqual(new Set([kbIdA, kbIdB]));

    await clearOverviewDirty(kbIdA);
    expect(await listDirtyOverviewKbs()).toEqual([kbIdB]);
  });

  it('pruneAllEventLogs keeps the N newest rows per KB and drops the rest', async () => {
    const kbId = await createFreshKb();

    // 1010 rows — 10 past the default keepRecent=1000 limit.
    // Explicit created_at so ordering is deterministic (setTimeout would be too slow).
    const insert = adaptedInsert();
    const { randomUUID } = await import('node:crypto');
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 1010; i++) {
      await insert(
        randomUUID(),
        kbId,
        'ingest',
        null,
        null,
        `row-${i}`,
        null,
        new Date(start + i * 1000).toISOString(),
        '__system__',
      );
    }

    const deleted = await pruneAllEventLogs(1000);
    expect(deleted).toBe(10);

    const remaining = (await dba
      .prepare('SELECT COUNT(*) AS n FROM knowledge_event_log WHERE kb_id = ?')
      .get(kbId)) as { n: number };
    expect(Number(remaining.n)).toBe(1000);

    const oldest = (await dba
      .prepare(
        'SELECT title FROM knowledge_event_log WHERE kb_id = ? ORDER BY created_at ASC LIMIT 1',
      )
      .get(kbId)) as { title: string };
    expect(oldest.title).toBe('row-10');
  });
});

/**
 * Helper: the real `appendKbEvent` normalizes writer identity and marks dirty,
 * which distorts a bulk-insert prune test. Talk to the DB directly instead.
 */
function adaptedInsert() {
  return async (
    id: string,
    kbId: string,
    eventType: string,
    docId: string | null,
    pageId: string | null,
    title: string,
    payload: string | null,
    createdAt: string,
    createdBy: string,
  ) => {
    await dba
      .prepare(
        `INSERT INTO knowledge_event_log
          (id, kb_id, event_type, doc_id, page_id, title, payload, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, kbId, eventType, docId, pageId, title, payload, createdAt, createdBy);
  };
}
