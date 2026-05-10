/**
 * Knowledge Base event log — append-only timeline of changes inside a KB.
 *
 * Used as both an audit trail (UI) and a source of "recent context" snippets
 * fed to LLM prompts for lint / wiki maintenance. All write paths are
 * fire-and-forget: failures are logged but never propagated to the caller, so
 * a transient DB hiccup cannot break the main ingest / search flow.
 *
 * Dirty-for-overview tracking is persisted on `knowledge_bases.overview_dirty_at`
 * (not an in-memory Set), so a process crash between an event write and the next
 * sweep cannot lose the "please regenerate the overview" signal.
 */

import { randomUUID } from 'node:crypto';
import { dba } from '../db/engine-access.js';
import { adaptSql } from '../db/sql-adapters.js';
import { logger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

export const KB_EVENT_TYPES = [
  'ingest',
  'reindex',
  'delete',
  'llm_enhance',
  'wiki_update',
  'lint',
  'query_backfill',
  'supersede',
] as const;

export type KbEventType = (typeof KB_EVENT_TYPES)[number];

export interface KbEventRow {
  id: string;
  kb_id: string;
  event_type: KbEventType;
  doc_id: string | null;
  page_id: string | null;
  title: string;
  payload: string | null;
  created_at: string;
  created_by: string;
}

export interface AppendKbEventInput {
  kbId: string;
  eventType: KbEventType;
  docId?: string | null;
  pageId?: string | null;
  title: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Persist a "please regenerate overview" flag for one KB. Fire-and-forget:
 * DB errors are logged but never re-thrown.
 *
 * Conditional UPDATE (`overview_dirty_at IS NULL`) keeps the common case —
 * multiple consecutive events on the same KB before the next sweep — from
 * producing redundant row writes. The flag semantically captures "first time
 * marked dirty since last regeneration", which is all the sweep needs.
 */
export async function markOverviewDirty(kbId: string): Promise<void> {
  try {
    await dba
      .prepare(adaptSql(
        `UPDATE knowledge_bases SET overview_dirty_at = ?
         WHERE id = ? AND overview_dirty_at IS NULL`,
      ))
      .run(new Date().toISOString(), kbId);
  } catch (err) {
    logger.warn({ err, kbId }, 'Failed to mark KB overview dirty (non-fatal)');
  }
}

/**
 * Consume the persistent dirty flag: return all KB ids currently flagged.
 * Caller is responsible for clearing the flag *after* successful regeneration.
 */
export async function listDirtyOverviewKbs(): Promise<string[]> {
  try {
    const rows = (await dba
      .prepare(adaptSql(
        `SELECT id FROM knowledge_bases
         WHERE overview_dirty_at IS NOT NULL AND deleted_at IS NULL`,
      ))
      .all()) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    logger.warn({ err }, 'Failed to list dirty-overview KBs (non-fatal)');
    return [];
  }
}

/** Clear the dirty flag for one KB after a successful regeneration. */
export async function clearOverviewDirty(kbId: string): Promise<void> {
  try {
    await dba
      .prepare(adaptSql(`UPDATE knowledge_bases SET overview_dirty_at = NULL WHERE id = ?`))
      .run(kbId);
  } catch (err) {
    logger.warn({ err, kbId }, 'Failed to clear overview dirty flag (non-fatal)');
  }
}

/**
 * Append one event row. Always fire-and-forget — the returned promise resolves
 * even on DB failure (errors are logged). Callers should NOT await on the
 * critical path; use `safeAppendKbEvent` if you need a void return.
 */
export async function appendKbEvent(input: AppendKbEventInput): Promise<void> {
  try {
    const sql = adaptSql(
      `INSERT INTO knowledge_event_log
        (id, kb_id, event_type, doc_id, page_id, title, payload, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await dba
      .prepare(sql)
      .run(
        randomUUID(),
        input.kbId,
        input.eventType,
        input.docId ?? null,
        input.pageId ?? null,
        input.title,
        input.payload ? JSON.stringify(input.payload) : null,
        new Date().toISOString(),
        getCurrentUserId(),
      );
    // Mark dirty only on successful event persistence. `markOverviewDirty`
    // handles its own errors internally, so this cannot re-throw.
    void markOverviewDirty(input.kbId);
  } catch (err) {
    logger.warn({ err, kbId: input.kbId, eventType: input.eventType }, 'Failed to append KB event (non-fatal)');
  }
}

/** Convenience wrapper for callers that don't want a dangling Promise. */
export function safeAppendKbEvent(input: AppendKbEventInput): void {
  void appendKbEvent(input);
}

export async function listRecentEvents(
  kbId: string,
  limit: number = 50,
  eventType?: KbEventType,
): Promise<KbEventRow[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const where = eventType ? `WHERE kb_id = ? AND event_type = ?` : `WHERE kb_id = ?`;
  const args: unknown[] = eventType ? [kbId, eventType, safeLimit] : [kbId, safeLimit];
  const sql = adaptSql(
    `SELECT id, kb_id, event_type, doc_id, page_id, title, payload, created_at, created_by
     FROM knowledge_event_log
     ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  );
  return (await dba.prepare(sql).all(...args)) as KbEventRow[];
}

/**
 * Render events as a Karpathy-style `log.md` markdown string.
 * Format: `## [YYYY-MM-DD] event_type | title`
 */
export function renderEventLogMarkdown(events: KbEventRow[], kbName?: string): string {
  const header = kbName ? `# ${kbName} — 事件日志\n` : t('errors.auto_c1d248', {}, undefined);
  if (events.length === 0) return `${header}\n_暂无事件记录_\n`;
  const lines = events.map((ev) => {
    const date = ev.created_at.slice(0, 10);
    return `## [${date}] ${ev.event_type} | ${ev.title}`;
  });
  return `${header}\n${lines.join('\n\n')}\n`;
}

/**
 * Drop the oldest events beyond `keepRecent` for one KB. Returns rows deleted.
 *
 * Two-step by explicit id: a timestamp-range DELETE (`created_at < cutoff`)
 * skips or double-counts rows that share a timestamp with the boundary;
 * deleting by id eliminates that ambiguity entirely.
 *   1. `SELECT id ... ORDER BY created_at DESC LIMIT ? OFFSET keepRecent`
 *      — small fixed OFFSET over the `(kb_id, created_at DESC)` index,
 *        returns at most `MAX_SINGLE_PRUNE` ids to drop.
 *   2. `DELETE WHERE id IN (...)` — one round-trip with a capped list.
 * Each sweep prunes at most `MAX_SINGLE_PRUNE` rows per KB; overflow is
 * picked up on the next 5-minute sweep, keeping transactions bounded and
 * safely under every dialect's placeholder limit.
 */
async function pruneOldEvents(kbId: string, keepRecent: number = 1000): Promise<number> {
  const MAX_SINGLE_PRUNE = 2000;
  try {
    const oldestIds = (await dba
      .prepare(adaptSql(
        `SELECT id FROM knowledge_event_log
         WHERE kb_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      ))
      .all(kbId, MAX_SINGLE_PRUNE, keepRecent)) as Array<{ id: string }>;
    if (oldestIds.length === 0) return 0;

    const placeholders = oldestIds.map(() => '?').join(',');
    const result = (await dba
      .prepare(adaptSql(
        `DELETE FROM knowledge_event_log WHERE id IN (${placeholders})`,
      ))
      .run(...oldestIds.map((r) => r.id))) as unknown as { changes?: number; affectedRows?: number };
    return result?.changes ?? result?.affectedRows ?? oldestIds.length;
  } catch (err) {
    logger.warn({ err, kbId }, 'Failed to prune KB event log (non-fatal)');
    return 0;
  }
}

/** Sweep all KBs that have any event log rows; bound work by `keepRecent`. */
export async function pruneAllEventLogs(keepRecent: number = 1000): Promise<number> {
  try {
    const kbs = (await dba
      .prepare(`SELECT DISTINCT kb_id FROM knowledge_event_log`)
      .all()) as Array<{ kb_id: string }>;
    let total = 0;
    for (const { kb_id } of kbs) {
      total += await pruneOldEvents(kb_id, keepRecent);
    }
    if (total > 0) logger.info({ pruned: total, kbs: kbs.length }, 'Event log sweep pruned old rows');
    return total;
  } catch (err) {
    logger.warn({ err }, 'Failed to enumerate KBs for event log prune (non-fatal)');
    return 0;
  }
}
