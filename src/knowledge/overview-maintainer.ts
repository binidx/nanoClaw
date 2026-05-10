/**
 * Overview wiki page maintainer — generates and refreshes the per-KB
 * `page_type='overview'` wiki page (Karpathy's `index.md` analogue).
 *
 * Pure rule-based: never calls the LLM, so it can run cheaply on every sweep
 * and the cost stays predictable as the KB grows.
 */

import { randomUUID } from 'node:crypto';
import { dba } from '../db/engine-access.js';
import { adaptSql } from '../db/sql-adapters.js';
import { logger } from '../logger.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import {
  clearOverviewDirty,
  listDirtyOverviewKbs,
  listRecentEvents,
  type KbEventRow,
} from './event-log.js';
import { updateWikiSearchVector } from './wiki-maintainer.js';
import { t } from '../i18n/index.js';

const OVERVIEW_TITLE = t('knowledge.auto_a2a62a', {}, undefined);
const OVERVIEW_PAGE_TYPE = 'overview';
const RECENT_EVENT_LIMIT = 20;

interface WikiPageBrief {
  id: string;
  page_type: string;
  title: string;
  content: string;
  version: number;
  source_doc_ids: string | null;
}

interface OverviewRow {
  id: string;
  content: string;
  version: number;
}

function countSourceDocs(raw: string | null): number {
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/** Extract the first sentence (up to 80 chars) as a one-line summary. */
function oneLinerFromContent(content: string): string {
  const first = content.replace(/^#.*\n+/gm, '').trim().split(/[.。！？\n]/)[0]?.trim() ?? '';
  if (!first) return '';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

function eventLine(ev: KbEventRow): string {
  const date = ev.created_at.slice(0, 10);
  return `- \`[${date}]\` ${ev.event_type} | ${ev.title}`;
}

/** Order matters: top of the index page lists the most consumable types first. */
const SECTIONS: Array<[label: string, pageType: string]> = [
  [t('knowledge.auto_edfbce', {}, undefined), 'synthesis'],
  [t('knowledge.auto_a7faed', {}, undefined), 'entity'],
  [t('knowledge.auto_16f877', {}, undefined), 'concept'],
  [t('knowledge.auto_684530', {}, undefined), 'comparison'],
];

function renderSection(label: string, pages: WikiPageBrief[]): string {
  const lines = [`## ${label}（${pages.length}）`];
  for (const p of pages) {
    const docCount = countSourceDocs(p.source_doc_ids);
    const meta: string[] = [];
    if (docCount > 0) meta.push(`${docCount} 篇源文档`);
    if (p.version > 1) meta.push(`v${p.version}`);
    const suffix = meta.length > 0 ? ` — ${meta.join('，')}` : '';
    const oneLiner = oneLinerFromContent(p.content);
    const blurb = oneLiner ? `\n  > ${oneLiner}` : '';
    lines.push(`- [${p.title}](wiki://${p.id})${suffix}${blurb}`);
  }
  return lines.join('\n');
}

function renderOverviewMarkdown(
  pages: WikiPageBrief[],
  events: KbEventRow[],
  generatedAt: string,
): string {
  const sections = SECTIONS
    .map(([label, type]) => {
      const inSection = pages.filter((p) => p.page_type === type);
      return inSection.length > 0 ? renderSection(label, inSection) : null;
    })
    .filter((s): s is string => s !== null);

  if (events.length > 0) {
    sections.push(
      [`## 近期事件（最近 ${events.length} 条）`, ...events.map(eventLine)].join('\n'),
    );
  }

  const header = `# ${OVERVIEW_TITLE}\n\n最近更新：${generatedAt.slice(0, 10)}`;
  return [header, ...sections].join('\n\n') + '\n';
}

/** Rebuild the overview wiki page for one KB. Idempotent — safe to call repeatedly. */
export async function regenerateOverviewPage(kbId: string): Promise<void> {
  const pages = (await dba
    .prepare(
      adaptSql(
        `SELECT id, page_type, title, content, version, source_doc_ids
         FROM knowledge_wiki_pages
         WHERE kb_id = ? AND page_type != ?
         ORDER BY page_type, title`,
      ),
    )
    .all(kbId, OVERVIEW_PAGE_TYPE)) as WikiPageBrief[];

  const events = await listRecentEvents(kbId, RECENT_EVENT_LIMIT);
  const ts = new Date().toISOString();
  const content = renderOverviewMarkdown(pages, events, ts);

  const existing = (await dba
    .prepare(
      adaptSql(
        `SELECT id, content, version FROM knowledge_wiki_pages
         WHERE kb_id = ? AND page_type = ? LIMIT 1`,
      ),
    )
    .get(kbId, OVERVIEW_PAGE_TYPE)) as OverviewRow | undefined;

  if (existing) {
    if (existing.content === content) return; // no-op when nothing changed
    const nextVersion = (Number(existing.version) || 1) + 1;
    await dba
      .prepare(
        adaptSql(
          `UPDATE knowledge_wiki_pages
           SET content = ?, version = ?, updated_at = ?
           WHERE id = ?`,
        ),
      )
      .run(content, nextVersion, ts, existing.id);
    await updateWikiSearchVector(existing.id, OVERVIEW_TITLE, content);
    return;
  }

  const id = randomUUID();
  await dba
    .prepare(
      adaptSql(
        `INSERT INTO knowledge_wiki_pages
          (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
           llm_model, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
    )
    .run(
      id,
      kbId,
      OVERVIEW_PAGE_TYPE,
      OVERVIEW_TITLE,
      content,
      '[]',
      '[]',
      '[]',
      null,
      1,
      ts,
      ts,
    );
  await updateWikiSearchVector(id, OVERVIEW_TITLE, content);
}

/**
 * Process all KBs whose `overview_dirty_at` column is non-null: regenerate the
 * overview page and only then clear the flag. A process crash between flag
 * set and regeneration is safe — the flag persists and is picked up on the
 * next sweep. One bad KB never blocks the rest.
 */
export async function regenerateAllDirtyOverviews(): Promise<number> {
  const kbIds = await listDirtyOverviewKbs();
  if (kbIds.length === 0) return 0;
  let regenerated = 0;
  for (const kbId of kbIds) {
    try {
      await regenerateOverviewPage(kbId);
      await clearOverviewDirty(kbId);
      regenerated += 1;
    } catch (err) {
      logger.warn({ err, kbId }, 'Overview page regeneration failed (non-fatal)');
    }
  }
  if (regenerated > 0) {
    logger.info({ regenerated, requested: kbIds.length, by: SYSTEM_USER_ID }, 'Overview pages refreshed');
  }
  return regenerated;
}
