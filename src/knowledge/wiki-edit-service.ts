import { dba, getKnowledgeBase } from '../db.js';
import { adaptSql } from '../db/sql-adapters.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { safeAppendKbEvent } from './event-log.js';
import { syncWikiClaimsForPage } from './wiki-claims.js';
import { updateWikiSearchVector } from './wiki-maintainer.js';
import { t } from '../i18n/index.js';

const MAX_TITLE_LEN = 255;
/** 512 KB — wiki bodies are larger than backfill answers; split very large pages. */
const MAX_CONTENT_BYTES = 512 * 1024;

export class WikiEditError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WikiEditError';
  }
}

export interface ApplyWikiEditInput {
  pageId: string;
  userId: string;
  title: string;
  content: string;
  expectedVersion: number;
}

export interface ApplyWikiEditResult {
  id: string;
  version: number;
  updated_at: string;
  edited_by_human: 1;
  edited_at: string;
}

interface WikiPageRowForEdit {
  id: string;
  kb_id: string;
  page_type: string;
  version: number;
  source_doc_ids: string | null;
}

interface KbOwnerRow {
  user_id: string;
  visibility?: string | null;
}

/** Mirror of `isKbVisibleToUser` in `routes/knowledge-routes.ts` — keep in sync. */
function visibleToUser(kb: KbOwnerRow, userId: string): boolean {
  if (userId === SYSTEM_USER_ID) return true;
  if (kb.user_id === SYSTEM_USER_ID) return true;
  if (kb.user_id === userId) return true;
  return kb.visibility === 'shared';
}

async function loadEditablePage(
  pageId: string,
  userId: string,
): Promise<WikiPageRowForEdit> {
  const page = (await dba
    .prepare('SELECT id, kb_id, page_type, version, source_doc_ids FROM knowledge_wiki_pages WHERE id = ?')
    .get(pageId)) as WikiPageRowForEdit | undefined;
  if (!page) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  const kb = await getKnowledgeBase(String(page.kb_id));
  if (!kb) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  if (!visibleToUser(kb as KbOwnerRow, userId)) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  if (userId !== SYSTEM_USER_ID && (kb as KbOwnerRow).user_id !== userId) {
    throw new WikiEditError(t('knowledge.noPermission', {}, undefined), 403);
  }
  return page;
}

/**
 * Apply a human edit to a wiki page. Implements the PR Q-Edit contract:
 *   - validates body shape and size
 *   - rejects `overview` pages (auto-generated, non-editable)
 *   - SQL-level optimistic lock via `WHERE id = ? AND version = ?`
 *   - marks the row `edited_by_human = 1` so the LLM rebuild path skips it
 *   - syncs Wiki FTS and emits `wiki_update payload.mode='human_edit'`
 */
export async function applyWikiEdit(input: ApplyWikiEditInput): Promise<ApplyWikiEditResult> {
  const title = (input.title || '').trim();
  const content = input.content ?? '';
  if (!title) throw new WikiEditError(t('knowledge.auto_7bcb6e', {}, undefined), 400);
  if (title.length > MAX_TITLE_LEN) throw new WikiEditError(t('knowledge.auto_296535', {}, undefined), 400);
  if (!content.trim()) throw new WikiEditError(t('knowledge.auto_9f0dc1', {}, undefined), 400);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new WikiEditError(t('knowledge.auto_7203ed', {}, undefined), 413);
  }
  if (!Number.isFinite(input.expectedVersion) || input.expectedVersion < 1) {
    throw new WikiEditError(t('knowledge.auto_a91c2b', {}, undefined), 400);
  }

  const page = await loadEditablePage(input.pageId, input.userId);
  if (page.page_type === 'overview') {
    throw new WikiEditError(t('knowledge.auto_fa460e', {}, undefined), 400);
  }

  const currentVersion = Number(page.version) || 1;
  if (input.expectedVersion !== currentVersion) {
    throw new WikiEditError(t('knowledge.auto_534fc1', {}, undefined), 409, {
      current_version: currentVersion,
    });
  }

  const ts = new Date().toISOString();
  const nextVersion = currentVersion + 1;
  const result = (await dba
    .prepare(
      adaptSql(`UPDATE knowledge_wiki_pages
        SET title = ?, content = ?, version = ?, llm_model = 'human',
            edited_by_human = 1, edited_at = ?, updated_at = ?
        WHERE id = ? AND version = ?`),
    )
    .run(title, content, nextVersion, ts, ts, input.pageId, currentVersion)) as unknown as
      { changes?: number; affectedRows?: number };
  const affected = result?.changes ?? result?.affectedRows ?? 0;
  if (affected === 0) {
    const fresh = (await dba
      .prepare('SELECT version FROM knowledge_wiki_pages WHERE id = ?')
      .get(input.pageId)) as { version: number } | undefined;
    throw new WikiEditError(t('knowledge.auto_534fc1', {}, undefined), 409, {
      current_version: Number(fresh?.version) || currentVersion,
    });
  }

  await updateWikiSearchVector(input.pageId, title, content);
  await syncWikiClaimsForPage({
    pageId: input.pageId,
    content,
    sourceDocIds: page.source_doc_ids,
  });

  safeAppendKbEvent({
    kbId: String(page.kb_id),
    eventType: 'wiki_update',
    pageId: input.pageId,
    title: `人工编辑 ${title}`,
    payload: { mode: 'human_edit' },
  });

  return { id: input.pageId, version: nextVersion, updated_at: ts, edited_by_human: 1, edited_at: ts };
}

export interface RevertWikiEditInput {
  pageId: string;
  userId: string;
}

export interface RevertWikiEditResult {
  id: string;
  edited_by_human: 0;
}

/**
 * Clear the human-edit lock so the next LLM sweep is allowed to rewrite the
 * page. Does NOT restore prior content (no version history) and does NOT
 * touch `version` / `updated_at` (clearing a flag is not a content change).
 */
export async function revertWikiHumanEdit(input: RevertWikiEditInput): Promise<RevertWikiEditResult> {
  const page = (await dba
    .prepare('SELECT id, kb_id, title FROM knowledge_wiki_pages WHERE id = ?')
    .get(input.pageId)) as { id: string; kb_id: string; title: string } | undefined;
  if (!page) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  const kb = await getKnowledgeBase(String(page.kb_id));
  if (!kb) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  if (!visibleToUser(kb as KbOwnerRow, input.userId)) throw new WikiEditError(t('knowledge.wikiPageNotFound', {}, undefined), 404);
  if (input.userId !== SYSTEM_USER_ID && (kb as KbOwnerRow).user_id !== input.userId) {
    throw new WikiEditError(t('knowledge.noPermission', {}, undefined), 403);
  }

  await dba
    .prepare(
      adaptSql(`UPDATE knowledge_wiki_pages
        SET edited_by_human = 0, edited_at = NULL
        WHERE id = ?`),
    )
    .run(input.pageId);

  safeAppendKbEvent({
    kbId: String(page.kb_id),
    eventType: 'wiki_update',
    pageId: input.pageId,
    title: `回滚人工修正 ${page.title}`,
    payload: { mode: 'revert_human_edit' },
  });

  return { id: input.pageId, edited_by_human: 0 };
}
