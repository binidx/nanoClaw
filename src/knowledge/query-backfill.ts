import crypto from 'node:crypto';
import { dba, getKnowledgeBase } from '../db.js';
import { adaptSql } from '../db/sql-adapters.js';
import { safeAppendKbEvent } from './event-log.js';
import { syncWikiClaimsForPage } from './wiki-claims.js';
import { updateWikiSearchVector } from './wiki-maintainer.js';
import { t } from '../i18n/index.js';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const MAX_TITLE_LEN = 255;
/** 256 KB — aligns with the per-chunk upload ceiling; larger answers should be split. */
const MAX_CONTENT_BYTES = 256 * 1024;

const rateBuckets = new Map<string, number[]>();

export class QueryBackfillError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'QueryBackfillError';
  }
}

export interface BackfillQueryToWikiInput {
  kbId: string;
  title: string;
  content: string;
  sourceQuery: string;
  userId: string;
}

function rateLimitKey(userId: string, kbId: string): string {
  return `${userId}\0${kbId}`;
}

function takeRateSlot(userId: string, kbId: string): boolean {
  const key = rateLimitKey(userId, kbId);
  const now = Date.now();
  const prev = rateBuckets.get(key) ?? [];
  const fresh = prev.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    rateBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return true;
}

function kbAllowsBackfill(kb: { allow_query_backfill?: number | null }): boolean {
  return Number(kb.allow_query_backfill ?? 0) === 1;
}

/**
 * Persist a knowledge_search-style answer as a `page_type='comparison'` wiki page.
 * Enforces `allow_query_backfill` on the KB and a per-(user, kb) sliding window of 5 writes/minute.
 *
 * Upsert by (kb_id, page_type='comparison', title): if a page with the same title
 * already exists, its content is replaced and version is bumped by 1; otherwise
 * a new row is inserted. This keeps repeated saves of the same question from
 * creating duplicate pages.
 */
export async function backfillQueryToWiki(input: BackfillQueryToWikiInput): Promise<{ pageId: string }> {
  const title = (input.title || '').trim();
  const content = (input.content || '').trim();
  const sourceQuery = (input.sourceQuery || '').trim();
  if (!title) throw new QueryBackfillError(t('knowledge.auto_7bcb6e', {}, undefined), 400);
  if (!content) throw new QueryBackfillError(t('knowledge.auto_9f0dc1', {}, undefined), 400);
  if (title.length > MAX_TITLE_LEN) throw new QueryBackfillError(t('knowledge.auto_296535', {}, undefined), 400);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new QueryBackfillError(t('knowledge.auto_a5fedc', {}, undefined), 413);
  }

  const kb = await getKnowledgeBase(input.kbId);
  if (!kb) throw new QueryBackfillError(t('knowledge.notFound', {}, undefined), 404);
  if (!kbAllowsBackfill(kb)) {
    throw new QueryBackfillError(t('knowledge.auto_954db7', {}, undefined), 403);
  }

  if (!takeRateSlot(input.userId, input.kbId)) {
    throw new QueryBackfillError(t('knowledge.auto_bbe33d', {}, undefined), 429);
  }

  const ts = new Date().toISOString();
  const existing = (await dba
    .prepare(
      adaptSql(
        `SELECT id, version FROM knowledge_wiki_pages
         WHERE kb_id = ? AND page_type = ? AND title = ?
         LIMIT 1`,
      ),
    )
    .get(input.kbId, 'comparison', title)) as { id: string; version: number } | undefined;

  let pageId: string;
  if (existing) {
    pageId = existing.id;
    await dba
      .prepare(
        adaptSql(
          `UPDATE knowledge_wiki_pages
           SET content = ?, version = ?, updated_at = ?
           WHERE id = ?`,
        ),
      )
      .run(content, existing.version + 1, ts, pageId);
  } else {
    pageId = crypto.randomUUID();
    const emptyJsonArray = '[]';
    await dba
      .prepare(
        adaptSql(`INSERT INTO knowledge_wiki_pages
          (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
           llm_model, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      )
      .run(
        pageId,
        input.kbId,
        'comparison',
        title,
        content,
        emptyJsonArray,
        emptyJsonArray,
        emptyJsonArray,
        null,
        1,
        ts,
        ts,
      );
  }

  await updateWikiSearchVector(pageId, title, content);
  await syncWikiClaimsForPage({
    pageId,
    content,
    sourceDocIds: '[]',
  });

  safeAppendKbEvent({
    kbId: input.kbId,
    eventType: 'query_backfill',
    pageId,
    title: `查询答案保存为 ${title}`,
    payload: sourceQuery ? { source_query: sourceQuery } : null,
  });

  return { pageId };
}
