import { dba } from '../db.js';
import { logger } from '../logger.js';
import { safeAppendKbEvent } from './event-log.js';

const ROOT_PREFIXES = new Set(['docs', 'help', 'api']);

const META_DATE_KEYS = ['article:published_time', 'og:updated_time', 'datePublished'] as const;

const DOC_EXTENSIONS = [
  '.asciidoc',
  '.markdown',
  '.html',
  '.adoc',
  '.json',
  '.xml',
  '.htm',
  '.rst',
  '.md',
  '.txt',
] as const;

const ENGLISH_MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';

function stripExtension(segment: string): string {
  const lower = segment.toLowerCase();
  for (const ext of DOC_EXTENSIONS) {
    if (lower.endsWith(ext)) return segment.slice(0, -ext.length);
  }
  return segment;
}

function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

function toIsoOrNull(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const chinese = trimmed.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
  );
  if (chinese) {
    const y = chinese[1];
    const mo = chinese[2].padStart(2, '0');
    const da = chinese[3].padStart(2, '0');
    const d = new Date(`${y}-${mo}-${da}T00:00:00.000Z`);
    if (!isValidDate(d)) {
      logger.warn({ raw: trimmed }, 'Unparseable date from Chinese calendar pattern');
      return null;
    }
    return d.toISOString();
  }

  const d = new Date(trimmed);
  if (!isValidDate(d)) {
    logger.warn({ raw: trimmed }, 'Unparseable date string');
    return null;
  }
  return d.toISOString();
}

function extractFromHtmlMeta(htmlMeta?: Record<string, string>): string | null {
  if (!htmlMeta) return null;
  for (const key of META_DATE_KEYS) {
    const val = htmlMeta[key];
    if (!val) continue;
    const iso = toIsoOrNull(val);
    if (iso) return iso;
  }
  return null;
}

function extractFromTimeTags(content: string): string | null {
  const re = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const iso = toIsoOrNull(m[1]);
    if (iso) return iso;
  }
  return null;
}

function pad2(n: string): string {
  return n.padStart(2, '0');
}

function extractFromUrl(sourceUrl?: string): string | null {
  if (!sourceUrl) return null;
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname;
    const slashDate = path.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
    if (slashDate) {
      const candidate = `${slashDate[1]}-${pad2(slashDate[2])}-${pad2(slashDate[3])}`;
      return toIsoOrNull(candidate);
    }
    const dashDate = path.match(/\/(\d{4})-(\d{1,2})-(\d{1,2})(?:\/|$)/);
    if (dashDate) {
      const candidate = `${dashDate[1]}-${pad2(dashDate[2])}-${pad2(dashDate[3])}`;
      return toIsoOrNull(candidate);
    }
  } catch {
    return null;
  }
  return null;
}

function extractFromContentText(content: string): string | null {
  const publishedZh = content.match(/发布于\s*(\d{4}-\d{1,2}-\d{1,2})/i);
  if (publishedZh) {
    const iso = toIsoOrNull(publishedZh[1]);
    if (iso) return iso;
  }

  const publishedEn = content.match(/Published\s*:\s*(\d{4}-\d{1,2}-\d{1,2})/i);
  if (publishedEn) {
    const iso = toIsoOrNull(publishedEn[1]);
    if (iso) return iso;
  }

  const updatedZh = content.match(/更新日期\s*[:：]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (updatedZh) {
    const y = updatedZh[1];
    const mo = updatedZh[2].padStart(2, '0');
    const da = updatedZh[3].padStart(2, '0');
    const iso = toIsoOrNull(`${y}年${mo}月${da}日`);
    if (iso) return iso;
  }

  const dateEn = content.match(
    new RegExp(`Date\\s*:\\s*(${ENGLISH_MONTHS})\\s+(\\d{1,2}),\\s+(\\d{4})`, 'i'),
  );
  if (dateEn) {
    const monthName = dateEn[1];
    const day = dateEn[2];
    const year = dateEn[3];
    const parsed = Date.parse(`${monthName} ${day}, ${year}`);
    const d = new Date(parsed);
    if (!isValidDate(d)) {
      logger.warn({ monthName, day, year }, 'Unparseable English month date');
    } else {
      return d.toISOString();
    }
  }

  return null;
}

/**
 * L1 metadata: extract document publish date (rule-based, no LLM).
 * Returns ISO 8601 or null.
 */
export function extractPublishedAt(
  content: string,
  sourceUrl?: string,
  htmlMeta?: Record<string, string>,
): string | null {
  return (
    extractFromHtmlMeta(htmlMeta) ??
    extractFromTimeTags(content) ??
    extractFromUrl(sourceUrl) ??
    extractFromContentText(content)
  );
}

function normalizePathInput(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '');
}

function stripRootPrefix(segments: string[]): string[] {
  if (segments.length === 0) return segments;
  const first = segments[0].toLowerCase();
  if (ROOT_PREFIXES.has(first)) return segments.slice(1);
  return segments;
}

function finalizeSegments(segments: string[]): { docPath: string | null; depth: number } {
  const cleaned = segments.filter((s) => s.length > 0);
  if (cleaned.length === 0) return { docPath: null, depth: 0 };
  const lastIdx = cleaned.length - 1;
  const last = stripExtension(cleaned[lastIdx] ?? '');
  if (!last) return { docPath: null, depth: 0 };
  const out = [...cleaned.slice(0, lastIdx), last];
  const docPath = out.join('/');
  return { docPath, depth: out.length };
}

/**
 * Build hierarchy path from URL or zip-relative path.
 */
export function buildDocPath(
  sourceUrl?: string,
  zipPath?: string,
): { docPath: string | null; depth: number } {
  if (sourceUrl) {
    try {
      const u = new URL(sourceUrl);
      let pathname = u.pathname || '';
      pathname = pathname.replace(/^\/+/, '');
      if (!pathname) return { docPath: null, depth: 0 };
      const segments = pathname.split('/').map((s) => safeDecodeURIComponent(s));
      const stripped = stripRootPrefix(segments);
      return finalizeSegments(stripped);
    } catch {
      return { docPath: null, depth: 0 };
    }
  }

  if (zipPath) {
    const norm = normalizePathInput(zipPath);
    if (!norm) return { docPath: null, depth: 0 };
    const segments = norm.split('/').map((s) => safeDecodeURIComponent(s));
    // ZIP archives preserve author-intended folders; keep a leading `docs/` segment.
    return finalizeSegments(segments);
  }

  return { docPath: null, depth: 0 };
}

function parentDocPath(docPath: string): string | null {
  const trimmed = docPath.trim();
  if (!trimmed.includes('/')) return null;
  const idx = trimmed.lastIndexOf('/');
  const parent = trimmed.slice(0, idx);
  return parent.length > 0 ? parent : null;
}

/**
 * Find parent document ID by hierarchical doc_path.
 */
export async function findParentDoc(kbId: string, docPath: string): Promise<string | null> {
  const parentPath = parentDocPath(docPath);
  if (!parentPath) return null;

  const row = (await dba
    .prepare(
      `SELECT id FROM knowledge_documents WHERE kb_id = ? AND doc_path = ? AND superseded_by IS NULL LIMIT 1`,
    )
    .get(kbId, parentPath)) as { id: string } | undefined;

  return row?.id ?? null;
}

async function candidateSupersedesDoc(candidateId: string, docId: string): Promise<boolean> {
  let current: string | null = docId;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    const row = (await dba
      .prepare(`SELECT superseded_by FROM knowledge_documents WHERE id = ?`)
      .get(current)) as { superseded_by: string | null } | undefined;
    const next = row?.superseded_by ?? null;
    if (next === candidateId) return true;
    current = next;
  }
  return false;
}

/**
 * Detect an older document in the same KB that this one should supersede.
 */
export async function detectSupersession(
  kbId: string,
  docId: string,
  sourceUrl: string | null,
  filename: string,
): Promise<string | null> {
  let candidateId: string | null = null;

  if (sourceUrl) {
    const row = (await dba
      .prepare(
        `SELECT id FROM knowledge_documents WHERE kb_id = ? AND source_url = ? AND id != ? AND superseded_by IS NULL ORDER BY COALESCE(published_at, created_at) ASC LIMIT 1`,
      )
      .get(kbId, sourceUrl, docId)) as { id: string } | undefined;
    candidateId = row?.id ?? null;
  }

  if (!candidateId) {
    const row = (await dba
      .prepare(
        `SELECT id FROM knowledge_documents WHERE kb_id = ? AND filename = ? AND id != ? AND superseded_by IS NULL ORDER BY COALESCE(published_at, created_at) ASC LIMIT 1`,
      )
      .get(kbId, filename, docId)) as { id: string } | undefined;
    candidateId = row?.id ?? null;
  }

  if (!candidateId) return null;

  if (await candidateSupersedesDoc(candidateId, docId)) return null;

  return candidateId;
}

/**
 * Mark an older document as superseded by a newer one.
 */
export async function markSuperseded(oldDocId: string, newDocId: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await dba
    .prepare(`UPDATE knowledge_documents SET superseded_by = ?, updated_at = ? WHERE id = ?`)
    .run(newDocId, updatedAt, oldDocId);

  // Best-effort event log; resolve titles for human-readable timeline.
  try {
    const rows = (await dba
      .prepare(
        `SELECT id, kb_id, filename FROM knowledge_documents WHERE id IN (?, ?)`,
      )
      .all(oldDocId, newDocId)) as Array<{ id: string; kb_id: string; filename: string }>;
    const oldRow = rows.find((r) => r.id === oldDocId);
    const newRow = rows.find((r) => r.id === newDocId);
    if (oldRow) {
      safeAppendKbEvent({
        kbId: oldRow.kb_id,
        eventType: 'supersede',
        docId: oldDocId,
        title: `${oldRow.filename} → ${newRow?.filename ?? newDocId}`,
        payload: { newDocId },
      });
    }
  } catch {
    /* event log is best-effort */
  }
}

/**
 * Sweep documents that should have a parent_doc_id but don't (e.g. children
 * indexed before their parent during URL crawl BFS). Capped per call so a
 * large backlog converges over a few sweeps without blocking the loop.
 */
export async function rebuildOrphanParents(limit: number = 500): Promise<number> {
  // Filter depth-1 docs in SQL: they have no parent by definition and would
  // otherwise consume the LIMIT budget on every sweep without ever being repaired.
  const orphans = (await dba
    .prepare(
      `SELECT id, kb_id, doc_path FROM knowledge_documents
       WHERE parent_doc_id IS NULL
         AND doc_path IS NOT NULL
         AND doc_path LIKE '%/%'
         AND superseded_by IS NULL
         AND deleted_at IS NULL
       LIMIT ?`,
    )
    .all(limit)) as Array<{ id: string; kb_id: string; doc_path: string }>;

  let repaired = 0;
  const updatedAt = new Date().toISOString();
  for (const doc of orphans) {
    const parentId = await findParentDoc(doc.kb_id, doc.doc_path);
    if (parentId && parentId !== doc.id) {
      await dba
        .prepare(`UPDATE knowledge_documents SET parent_doc_id = ?, updated_at = ? WHERE id = ?`)
        .run(parentId, updatedAt, doc.id);
      repaired++;
    }
  }
  if (repaired > 0) logger.info({ repaired, scanned: orphans.length }, 'Rebuilt orphan parent links');
  return repaired;
}
