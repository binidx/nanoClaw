import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { dba } from '../db.js';
import { getProvider } from '../db/assistants.js';
import { adaptSql } from '../db/sql-adapters.js';
import { safeAppendKbEvent } from './event-log.js';
import { callKbLlm, type KbLlmConfig } from './llm-call.js';
import { syncWikiClaimsForPage } from './wiki-claims.js';
import type {
  KnowledgeWikiPageRecord,
  KnowledgeWikiPageType,
} from '../types/context.js';
import { t } from '../i18n/index.js';

const SYNTHESIS_TITLE = t('knowledge.auto_71cfc3', {}, undefined);

export interface WikiLintReport {
  orphanPages: string[];
  stalePages: string[];
  missingPages: string[];
  contradictions: string[];
  /** Pages currently locked from LLM rebuild because a human last wrote them. */
  humanEditedPages: string[];
}

interface WikiSourceDocContext {
  documentId: string;
  filename: string;
  docPath: string | null;
  publishedAt: string | null;
  summary: string;
  topics: string[];
  entities: Array<{ name?: string; type?: string; salience?: number }>;
  updatedAt: string;
}

interface SummaryIndexRow {
  document_id: string;
  updated_at: string | null;
  topics: string | null;
  entities: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIdArray(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function stableJson(ids: string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

function normTitle(t: string): string {
  return t.trim().toLowerCase();
}

function truncateText(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function normalizeSummaryPlainText(summary: string): string {
  return summary
    .replace(/^#+\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function splitSummaryIntoFacts(summary: string): string[] {
  return normalizeSummaryPlainText(summary)
    .split(/[。！？!\?\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

function normalizeTopicLabel(raw: string): string | null {
  const topic = raw.trim().replace(/\s+/g, ' ');
  if (!topic) return null;
  const useless = new Set([
    t('errors.auto_d81bb2', {}, undefined),
    t('knowledge.auto_aa05fd', {}, undefined),
    t('knowledge.auto_8a8b89', {}, undefined),
    t('knowledge.auto_325369', {}, undefined),
    t('knowledge.auto_997c7a', {}, undefined),
    t('knowledge.auto_f411d0', {}, undefined),
    t('knowledge.auto_f630b9', {}, undefined),
    t('knowledge.auto_2b6bc0', {}, undefined),
  ]);
  if (useless.has(topic)) return null;
  if (topic.length < 2) return null;
  return topic.length > 40 ? topic.slice(0, 40) : topic;
}

function normalizeEntityLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (!label) return null;
  return label.length > 80 ? label.slice(0, 80) : label;
}

function parseJsonArraySafe<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

async function resolveKbLlmModel(config: KbLlmConfig): Promise<string | null> {
  const provider = await getProvider(config.llmProviderId);
  return provider?.model || null;
}

function findPage(
  pages: KnowledgeWikiPageRecord[],
  title: string,
  pageType: KnowledgeWikiPageType,
): KnowledgeWikiPageRecord | undefined {
  const n = normTitle(title);
  return pages.find((p) => p.page_type === pageType && normTitle(p.title) === n);
}

function rowToWikiPage(row: Record<string, unknown>): KnowledgeWikiPageRecord {
  return {
    id: String(row.id),
    kb_id: String(row.kb_id),
    page_type: row.page_type as KnowledgeWikiPageRecord['page_type'],
    title: String(row.title),
    content: String(row.content ?? ''),
    source_doc_ids: row.source_doc_ids == null ? null : String(row.source_doc_ids),
    inbound_links: row.inbound_links == null ? null : String(row.inbound_links),
    outbound_links: row.outbound_links == null ? null : String(row.outbound_links),
    llm_model: row.llm_model == null ? null : String(row.llm_model),
    version: Number(row.version ?? 1),
    edited_by_human: Number(row.edited_by_human ?? 0),
    edited_at: row.edited_at == null ? null : String(row.edited_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function updateWikiSearchVector(pageId: string, title?: string, content?: string): Promise<void> {
  try {
    const { getActiveEngine } = await import('../database/engine.js');
    const engine = getActiveEngine();
    if (engine.dialect === 'postgres') {
      const { getPgFtsConfig } = await import('../database/pg-fts-config.js');
      const cfg = getPgFtsConfig();
      await dba.prepare(
        `UPDATE knowledge_wiki_pages SET search_vector = to_tsvector('${cfg}', COALESCE(title, '') || ' ' || COALESCE(content, '')) WHERE id = ?`,
      ).run(pageId);
    } else if (engine.dialect === 'sqlite') {
      const row = title != null && content != null
        ? { title, content }
        : (await dba.prepare('SELECT title, content FROM knowledge_wiki_pages WHERE id = ?').get(pageId)) as { title: string; content: string } | undefined;
      if (!row) return;
      const rowid = (await dba.prepare('SELECT rowid FROM knowledge_wiki_pages WHERE id = ?').get(pageId)) as { rowid: number } | undefined;
      if (!rowid) return;
      await dba.prepare(
        `INSERT OR REPLACE INTO knowledge_wiki_pages_fts (rowid, title, content) VALUES (?, ?, ?)`,
      ).run(rowid.rowid, row.title, row.content);
    }
  } catch (err) {
    logger.warn({ err, pageId }, 'Failed to update wiki search index (non-fatal)');
  }
}

async function loadWikiPages(kbId: string): Promise<KnowledgeWikiPageRecord[]> {
  const rows = (await dba
    .prepare('SELECT * FROM knowledge_wiki_pages WHERE kb_id = ?')
    .all(kbId)) as Record<string, unknown>[];
  return rows.map(rowToWikiPage);
}

async function deleteWikiPage(pageId: string): Promise<void> {
  try {
    const { getActiveEngine } = await import('../database/engine.js');
    const engine = getActiveEngine();
    if (engine.dialect === 'sqlite') {
      const rowid = (await dba.prepare('SELECT rowid FROM knowledge_wiki_pages WHERE id = ?').get(pageId)) as { rowid: number } | undefined;
      if (rowid) {
        await dba.prepare('DELETE FROM knowledge_wiki_pages_fts WHERE rowid = ?').run(rowid.rowid);
      }
    }
  } catch (err) {
    logger.warn({ err, pageId }, 'Failed to cleanup wiki FTS row before delete (non-fatal)');
  }
  await dba.prepare('DELETE FROM knowledge_wiki_claims WHERE page_id = ?').run(pageId);
  await dba.prepare('DELETE FROM knowledge_wiki_pages WHERE id = ?').run(pageId);
}

async function loadWikiSourceDocs(
  kbId: string,
  sourceDocIds: string[],
): Promise<WikiSourceDocContext[]> {
  const uniqueIds = [...new Set(sourceDocIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = (await dba
    .prepare(
      adaptSql(
        `SELECT d.id AS document_id,
                d.filename AS filename,
                d.doc_path AS doc_path,
                d.published_at AS published_at,
                d.updated_at AS updated_at,
                s.summary AS summary,
                s.topics AS topics,
                s.entities AS entities
         FROM knowledge_documents d
         LEFT JOIN knowledge_doc_summaries s ON s.document_id = d.id
         WHERE d.kb_id = ?
           AND d.deleted_at IS NULL
           AND d.id IN (${placeholders})
         ORDER BY d.updated_at DESC, d.created_at DESC`,
      ),
    )
    .all(kbId, ...uniqueIds)) as Array<{
    document_id: string;
    filename: string | null;
    doc_path: string | null;
    published_at: string | null;
    updated_at: string | null;
    summary: string | null;
    topics: string | null;
    entities: string | null;
  }>;

  return rows
    .map((row) => ({
      documentId: row.document_id,
      filename: String(row.filename ?? row.document_id),
      docPath: row.doc_path,
      publishedAt: row.published_at,
      summary: String(row.summary ?? '').trim(),
      topics: parseJsonArraySafe<string>(row.topics, []).filter((item) => typeof item === 'string'),
      entities: parseJsonArraySafe<Array<{ name?: string; type?: string; salience?: number }>[number]>(row.entities, []),
      updatedAt: String(row.updated_at ?? ''),
    }))
    .filter((row) => row.summary.length > 0);
}

async function loadSynthesisSourceDocIds(kbId: string, limit: number = 12): Promise<string[]> {
  const rows = (await dba
    .prepare(
      adaptSql(
        `SELECT d.id
         FROM knowledge_documents d
         INNER JOIN knowledge_doc_summaries s ON s.document_id = d.id
         WHERE d.kb_id = ?
           AND d.deleted_at IS NULL
           AND d.llm_status = 'done'
         ORDER BY d.updated_at DESC, d.created_at DESC
         LIMIT ?`,
      ),
    )
    .all(kbId, limit)) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function loadSummaryIndexRows(kbId: string): Promise<SummaryIndexRow[]> {
  return (await dba
    .prepare(
      adaptSql(
        `SELECT d.id AS document_id,
                d.updated_at AS updated_at,
                s.topics AS topics,
                s.entities AS entities
         FROM knowledge_documents d
         INNER JOIN knowledge_doc_summaries s ON s.document_id = d.id
         WHERE d.kb_id = ?
           AND d.deleted_at IS NULL
           AND d.llm_status = 'done'
         ORDER BY d.updated_at DESC, d.created_at DESC`,
      ),
    )
    .all(kbId)) as SummaryIndexRow[];
}

function collectActiveEntityTitles(rows: SummaryIndexRow[]): Set<string> {
  const titles = new Set<string>();
  for (const row of rows) {
    const entities = parseJsonArraySafe<Array<{ name?: string; salience?: number }>[number]>(row.entities, []);
    for (const entity of entities) {
      const label = typeof entity?.name === 'string' ? normalizeEntityLabel(entity.name) : null;
      const salience = typeof entity?.salience === 'number' ? entity.salience : 0;
      if (!label || salience < 0.6) continue;
      titles.add(normTitle(label));
    }
  }
  return titles;
}

function collectActiveTopicTitles(rows: SummaryIndexRow[]): Set<string> {
  const titles = new Set<string>();
  for (const row of rows) {
    const topics = parseJsonArraySafe<string>(row.topics, []);
    for (const topic of topics) {
      const normalized = normalizeTopicLabel(topic);
      if (!normalized) continue;
      titles.add(normTitle(normalized));
    }
  }
  return titles;
}

async function cleanupObsoleteWikiPages(
  kbId: string,
  doneCount: number,
): Promise<string[]> {
  const pages = await loadWikiPages(kbId);
  if (pages.length === 0) return [];

  const summaryRows = await loadSummaryIndexRows(kbId);
  const activeEntities = collectActiveEntityTitles(summaryRows);
  const activeTopics = collectActiveTopicTitles(summaryRows);
  const deleted: string[] = [];

  for (const page of pages) {
    if (Number(page.edited_by_human ?? 0) === 1) continue;
    if (page.page_type === 'entity' && !activeEntities.has(normTitle(page.title))) {
      await deleteWikiPage(page.id);
      deleted.push(page.id);
      continue;
    }
    if (page.page_type === 'concept' && !activeTopics.has(normTitle(page.title))) {
      await deleteWikiPage(page.id);
      deleted.push(page.id);
      continue;
    }
    if (page.page_type === 'synthesis' && doneCount < 3) {
      await deleteWikiPage(page.id);
      deleted.push(page.id);
    }
  }

  return deleted;
}

async function loadEntitySourceDocIds(kbId: string, entityName: string, limit: number = 12): Promise<string[]> {
  const normalized = normTitle(entityName);
  const rows = await loadSummaryIndexRows(kbId);
  const matched: string[] = [];
  for (const row of rows) {
    const entities = parseJsonArraySafe<Array<{ name?: string; salience?: number }>[number]>(row.entities, []);
    const hit = entities.some((entity) => {
      const label = typeof entity?.name === 'string' ? normalizeEntityLabel(entity.name) : null;
      const salience = typeof entity?.salience === 'number' ? entity.salience : 0;
      return !!label && salience >= 0.6 && normTitle(label) === normalized;
    });
    if (hit) matched.push(row.document_id);
    if (matched.length >= limit) break;
  }
  return matched;
}

async function loadTopicSourceDocIds(kbId: string, topicName: string, limit: number = 12): Promise<string[]> {
  const normalized = normalizeTopicLabel(topicName);
  if (!normalized) return [];
  const rows = await loadSummaryIndexRows(kbId);
  const matched: string[] = [];
  for (const row of rows) {
    const topics = parseJsonArraySafe<string>(row.topics, []);
    const hit = topics.some((topic) => normalizeTopicLabel(topic) === normalized);
    if (hit) matched.push(row.document_id);
    if (matched.length >= limit) break;
  }
  return matched;
}

function buildWikiSourceBundle(sourceDocs: WikiSourceDocContext[], maxDocs: number): string {
  return sourceDocs.slice(0, maxDocs).map((doc, index) => {
    const entityNames = doc.entities
      .slice(0, 8)
      .map((entity) => entity?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .join('、');
    const topicLine = doc.topics.length > 0 ? doc.topics.slice(0, 8).join('、') : t('errors.auto_d81bb2', {}, undefined);
    const meta = [
      t('knowledge.fileLabel', { filename: doc.filename }, undefined),
      doc.docPath ? t('knowledge.pathLabel', { path: doc.docPath }, undefined) : null,
      doc.publishedAt ? t('knowledge.publishedAtLabel', { date: doc.publishedAt }, undefined) : null,
      entityNames ? t('knowledge.keywordsLabel', { keywords: entityNames }, undefined) : null,
      t('knowledge.topicLabel', { topic: topicLine }, undefined),
    ].filter(Boolean).join('\n');
    return t('knowledge.sourceDocEntry', { index: index + 1, id: doc.documentId, meta, summary: truncateText(doc.summary, 900) }, undefined);
  }).join('\n\n');
}

function renderWikiSourcesSection(sourceDocs: WikiSourceDocContext[]): string {
  return sourceDocs
    .map((doc) => {
      const extras = [
        doc.docPath ? t('knowledge.pathLabel', { path: doc.docPath }, undefined) : null,
        doc.publishedAt ? t('knowledge.publishedAtLabel', { date: doc.publishedAt }, undefined) : null,
      ].filter(Boolean);
      return t('knowledge.sourceDocCompact', { id: doc.documentId, filename: doc.filename, extras: extras.length > 0 ? ` | ${extras.join(' | ')}` : '' }, undefined);
    })
    .join('\n');
}

function buildFallbackWikiPageContent(
  title: string,
  pageType: KnowledgeWikiPageType,
  sourceDocs: WikiSourceDocContext[],
): string {
  const facts = [...new Set(
    sourceDocs.flatMap((doc) => splitSummaryIntoFacts(doc.summary).slice(0, 3)),
  )].slice(0, 6);
  const terms = [...new Set(
    sourceDocs.flatMap((doc) => [
      ...doc.entities
        .map((entity) => (typeof entity?.name === 'string' ? normalizeEntityLabel(entity.name) : null))
        .filter((name): name is string => Boolean(name)),
      ...doc.topics
        .map((topic) => normalizeTopicLabel(topic))
        .filter((topic): topic is string => Boolean(topic)),
    ]),
  )].slice(0, 10);
  const contextLines = sourceDocs.slice(0, 4).map((doc) => {
    const pathStr = doc.docPath ? `，${doc.docPath}` : '';
    return t('knowledge.sourceDocWithTime', { filename: doc.filename, path: pathStr, time: doc.updatedAt || t('knowledge.unknownTime', {}, undefined) }, undefined);
  });
  const intro = pageType === 'synthesis'
    ? t('knowledge.wikiFromEnhanced', { count: sourceDocs.length }, undefined)
    : t('knowledge.wikiFromSources', { count: sourceDocs.length, title }, undefined);

  return [
    `# ${title}`,
    '',
    t('knowledge.auto_193755', {}, undefined),
    intro,
    '',
    t('knowledge.auto_6f9410', {}, undefined),
    ...(facts.length > 0 ? facts.map((fact) => `- ${fact}`) : [t('knowledge.auto_2245f8', {}, undefined)]),
    '',
    t('knowledge.auto_ef7df5', {}, undefined),
    ...(terms.length > 0 ? terms.map((term) => `- ${term}`) : [t('knowledge.auto_6711b9', {}, undefined)]),
    '',
    t('knowledge.auto_fb6f24', {}, undefined),
    ...(contextLines.length > 0 ? contextLines : [t('knowledge.auto_f20dd7', {}, undefined)]),
    '',
    t('knowledge.auto_e379a0', {}, undefined),
    t('knowledge.auto_fceb50', {}, undefined),
    '',
    t('knowledge.auto_83451a', {}, undefined),
    renderWikiSourcesSection(sourceDocs),
    '',
  ].join('\n');
}

function normalizeWikiPageMarkdown(
  title: string,
  pageType: KnowledgeWikiPageType,
  rawContent: string,
  sourceDocs: WikiSourceDocContext[],
): string {
  const trimmed = rawContent.trim();
  const fallback = buildFallbackWikiPageContent(title, pageType, sourceDocs);
  if (!trimmed || trimmed.length < 180) return fallback;

  const hasSummary = /^##\s+摘要/m.test(trimmed);
  const hasFacts = /^##\s+核心事实/m.test(trimmed);
  const hasSources = /^##\s+来源/m.test(trimmed);
  if (!hasSummary || !hasFacts || !hasSources) return fallback;

  let normalized = trimmed;
  if (!normalized.startsWith('# ')) {
    normalized = `# ${title}\n\n${normalized}`;
  }
  if (!/^##\s+差异与待确认/m.test(normalized)) {
    normalized += t('knowledge.auto_fec575', {}, undefined);
  }
  if (!/^##\s+来源/m.test(normalized)) {
    normalized += `\n\n${t('knowledge.auto_83451a', {}, undefined)}\n${renderWikiSourcesSection(sourceDocs)}`;
  }
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

async function generateWikiPageContent(
  kbId: string,
  title: string,
  pageType: KnowledgeWikiPageType,
  sourceDocIds: string[],
  config: KbLlmConfig,
): Promise<{ content: string; sourceDocIds: string[] }> {
  const sourceDocs = await loadWikiSourceDocs(kbId, sourceDocIds);
  if (sourceDocs.length === 0) {
    throw new Error(`No source summaries available for wiki page ${title}`);
  }
  const maxDocs = pageType === 'synthesis' ? 12 : 8;
  const sourceBundle = buildWikiSourceBundle(sourceDocs, maxDocs);
  const prompt = t('knowledge.wikiRewritePrompt', { title, pageType, summaries: sourceBundle }, undefined);

  const rawContent = await callKbLlm(config, prompt, {
    maxTokens: pageType === 'synthesis' ? 2200 : 1800,
    temperature: 0.2,
  });
  const content = normalizeWikiPageMarkdown(title, pageType, rawContent, sourceDocs);

  return {
    content,
    sourceDocIds: sourceDocs.slice(0, maxDocs).map((doc) => doc.documentId),
  };
}

async function createWikiPage(
  kbId: string,
  title: string,
  pageType: KnowledgeWikiPageType,
  sourceDocIds: string[],
  config: KbLlmConfig,
): Promise<KnowledgeWikiPageRecord> {
  const { content: text, sourceDocIds: normalizedSourceIds } = await generateWikiPageContent(
    kbId,
    title,
    pageType,
    sourceDocIds,
    config,
  );
  const model = await resolveKbLlmModel(config);

  const id = crypto.randomUUID();
  const ts = nowIso();
  const emptyLinks = '[]';
  const sourceIds = stableJson(normalizedSourceIds);

  await dba
    .prepare(
      adaptSql(`INSERT INTO knowledge_wiki_pages
        (id, kb_id, page_type, title, content, source_doc_ids, inbound_links, outbound_links,
         llm_model, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    )
    .run(
      id,
      kbId,
      pageType,
      title,
      text,
      sourceIds,
      emptyLinks,
      emptyLinks,
      model,
      1,
      ts,
      ts,
    );

  const created = (await dba.prepare('SELECT * FROM knowledge_wiki_pages WHERE id = ?').get(id)) as
    | Record<string, unknown>
    | undefined;
  if (!created) {
    throw new Error(`Failed to load wiki page after insert: ${id}`);
  }
  const page = rowToWikiPage(created);
  await updateWikiSearchVector(page.id, title, text);
  await syncWikiClaimsForPage({
    pageId: page.id,
    content: text,
    sourceDocIds: sourceIds,
  });
  return page;
}

async function updateWikiPage(
  page: KnowledgeWikiPageRecord,
  kbId: string,
  sourceDocIds: string[],
  config: KbLlmConfig,
): Promise<boolean> {
  if (Number(page.edited_by_human ?? 0) === 1) {
    logger.debug(
      { pageId: page.id, kbId: page.kb_id, sourceDocIds },
      'Skip wiki LLM rebuild — page is human-edited',
    );
    return false;
  }
  const { content: text, sourceDocIds: normalizedSourceIds } = await generateWikiPageContent(
    kbId,
    page.title,
    page.page_type,
    sourceDocIds,
    config,
  );
  const model = await resolveKbLlmModel(config);

  const ts = nowIso();
  const nextVersion = (Number(page.version) || 1) + 1;

  await dba
    .prepare(
      adaptSql(`UPDATE knowledge_wiki_pages
        SET content = ?, source_doc_ids = ?, version = ?, llm_model = ?, updated_at = ?
        WHERE id = ?`),
    )
    .run(text, stableJson(normalizedSourceIds), nextVersion, model ?? page.llm_model, ts, page.id);

  await updateWikiSearchVector(page.id, page.title, text);
  await syncWikiClaimsForPage({
    pageId: page.id,
    content: text,
    sourceDocIds: stableJson(normalizedSourceIds),
  });
  return true;
}

function computeOutboundLinks(
  content: string,
  allPages: KnowledgeWikiPageRecord[],
  selfId: string,
): string[] {
  const others = allPages
    .filter((p) => p.id !== selfId && p.title.trim().length > 0)
    .sort((a, b) => b.title.length - a.title.length);
  const out = new Set<string>();
  for (const p of others) {
    if (content.includes(p.title)) out.add(p.id);
  }
  return [...out];
}

function invertInbound(
  outboundByPageId: Map<string, string[]>,
): Map<string, string[]> {
  const inbound = new Map<string, Set<string>>();
  for (const [fromId, outs] of outboundByPageId) {
    for (const toId of outs) {
      if (!inbound.has(toId)) inbound.set(toId, new Set());
      inbound.get(toId)!.add(fromId);
    }
  }
  const res = new Map<string, string[]>();
  for (const [id, set] of inbound) {
    res.set(id, [...set]);
  }
  return res;
}

export async function maintainCrossReferences(
  kbId: string,
  affectedPageIds: string[],
): Promise<void> {
  if (affectedPageIds.length === 0) return;

  const pages = await loadWikiPages(kbId);
  if (pages.length === 0) return;

  const outboundById = new Map<string, string[]>();
  for (const p of pages) {
    outboundById.set(p.id, computeOutboundLinks(p.content, pages, p.id));
  }
  const inboundById = invertInbound(outboundById);

  const ts = nowIso();
  for (const p of pages) {
    const outbound = stableJson(outboundById.get(p.id) ?? []);
    const inbound = stableJson(inboundById.get(p.id) ?? []);
    const prevOut = stableJson(parseIdArray(p.outbound_links));
    const prevIn = stableJson(parseIdArray(p.inbound_links));
    if (outbound === prevOut && inbound === prevIn) continue;

    await dba
      .prepare(
        adaptSql(`UPDATE knowledge_wiki_pages
          SET inbound_links = ?, outbound_links = ?, updated_at = ?
          WHERE id = ?`),
      )
      .run(inbound, outbound, ts, p.id);
  }
}

export async function updateOrCreateWikiPages(
  kbId: string,
  docId: string,
  entities: Array<{ name: string; type: string; salience: number }>,
  topics: string[],
  _docSummary: string,
  config: KbLlmConfig,
): Promise<void> {
  let existing = await loadWikiPages(kbId);
  const affected = new Set<string>();

  for (const ent of entities) {
    if (typeof ent.salience === 'number' && ent.salience < 0.6) continue;
    const name = (ent.name || '').trim();
    if (!name) continue;

    const match = findPage(existing, name, 'entity');
    try {
      const sourceDocIds = await loadEntitySourceDocIds(kbId, name);
      const normalizedSourceDocIds = sourceDocIds.length > 0 ? sourceDocIds : [docId];
      if (match) {
        const wrote = await updateWikiPage(match, kbId, normalizedSourceDocIds, config);
        if (wrote) affected.add(match.id);
      } else {
        const created = await createWikiPage(kbId, name, 'entity', normalizedSourceDocIds, config);
        existing.push(created);
        affected.add(created.id);
      }
    } catch (err) {
      logger.warn({ err, kbId, docId, entity: name }, 'Wiki entity page create/update failed');
    }
  }

  for (const rawTopic of topics) {
    const topic = normalizeTopicLabel(rawTopic);
    if (!topic) continue;

    const match = findPage(existing, topic, 'concept');
    try {
      const sourceDocIds = await loadTopicSourceDocIds(kbId, topic);
      const normalizedSourceDocIds = sourceDocIds.length > 0 ? sourceDocIds : [docId];
      if (match) {
        const wrote = await updateWikiPage(match, kbId, normalizedSourceDocIds, config);
        if (wrote) affected.add(match.id);
      } else {
        const created = await createWikiPage(kbId, topic, 'concept', normalizedSourceDocIds, config);
        existing.push(created);
        affected.add(created.id);
      }
    } catch (err) {
      logger.warn({ err, kbId, docId, topic }, 'Wiki concept page create/update failed');
    }
  }

  const doneCountRow = (await dba
    .prepare(
      `SELECT COUNT(*) AS c FROM knowledge_documents
       WHERE kb_id = ? AND llm_status = 'done'`,
    )
    .get(kbId)) as { c: number | bigint } | undefined;
  const doneCount = Number(doneCountRow?.c ?? 0);

  const synthesis = existing.find((p) => p.page_type === 'synthesis');
  if (doneCount >= 3) {
    const synthesisSourceDocIds = await loadSynthesisSourceDocIds(kbId, 12);
    try {
      if (synthesis) {
        const wrote = await updateWikiPage(synthesis, kbId, synthesisSourceDocIds, config);
        if (wrote) affected.add(synthesis.id);
      } else {
        const created = await createWikiPage(
          kbId,
          SYNTHESIS_TITLE,
          'synthesis',
          synthesisSourceDocIds,
          config,
        );
        existing.push(created);
        affected.add(created.id);
      }
    } catch (err) {
      logger.warn({ err, kbId, docId }, 'Wiki synthesis page create/update failed');
    }
  }

  const deletedPageIds = await cleanupObsoleteWikiPages(kbId, doneCount);
  if (affected.size > 0 || deletedPageIds.length > 0) {
    await maintainCrossReferences(kbId, [...affected, ...deletedPageIds]);
  }

  if (affected.size > 0 || deletedPageIds.length > 0) {
    safeAppendKbEvent({
      kbId,
      eventType: 'wiki_update',
      docId,
      title: t('knowledge.wikiUpdateTitle', { count: affected.size }, undefined),
      payload: {
        mode: 'llm_rebuild',
        pageIds: [...affected],
        deletedPageIds,
      },
    });
  }
}

export async function lintWiki(kbId: string): Promise<WikiLintReport> {
  const pages = await loadWikiPages(kbId);
  const orphanPages: string[] = [];
  const stalePages: string[] = [];
  const humanEditedPages = pages
    .filter((p) => Number(p.edited_by_human ?? 0) === 1)
    .map((p) => p.id);
  const entityTitles = new Set(
    pages.filter((p) => p.page_type === 'entity').map((p) => normTitle(p.title)),
  );

  const supersededRows = (await dba
    .prepare(
      `SELECT id FROM knowledge_documents
       WHERE kb_id = ? AND superseded_by IS NOT NULL`,
    )
    .all(kbId)) as Array<{ id: string }>;
  const superseded = new Set(supersededRows.map((r) => r.id));

  for (const p of pages) {
    const inbound = parseIdArray(p.inbound_links);
    if (
      inbound.length === 0 &&
      p.page_type !== 'overview' &&
      p.page_type !== 'synthesis'
    ) {
      orphanPages.push(p.id);
    }

    const sources = parseIdArray(p.source_doc_ids);
    if (sources.some((id) => superseded.has(id))) {
      stalePages.push(p.id);
    }
  }

  const missingPages: string[] = [];
  const summaryRows = (await dba
    .prepare(
      `SELECT s.entities
       FROM knowledge_doc_summaries s
       JOIN knowledge_documents d ON d.id = s.document_id
       WHERE d.kb_id = ?`,
    )
    .all(kbId)) as Array<{ entities: string | null }>;

  /** normalized title -> first seen display label */
  const mentionedNormToLabel = new Map<string, string>();
  for (const row of summaryRows) {
    if (!row.entities) continue;
    try {
      const parsed = JSON.parse(row.entities) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const name = (item as { name?: unknown }).name;
        const salience = (item as { salience?: unknown }).salience;
        if (typeof name !== 'string' || !name.trim()) continue;
        if (typeof salience === 'number' && salience < 0.35) continue;
        const label = name.trim();
        const nn = normTitle(label);
        if (!mentionedNormToLabel.has(nn)) mentionedNormToLabel.set(nn, label);
      }
    } catch {
      /* ignore malformed entity JSON */
    }
  }
  for (const [nn, label] of mentionedNormToLabel) {
    if (!entityTitles.has(nn)) {
      missingPages.push(label);
    }
  }

  const contradictionRows = (await dba
    .prepare(
      `SELECT r.source_doc_id, r.target_doc_id
       FROM knowledge_doc_relations r
       JOIN knowledge_documents d1 ON d1.id = r.source_doc_id
       JOIN knowledge_documents d2 ON d2.id = r.target_doc_id
       WHERE d1.kb_id = ? AND d2.kb_id = ? AND r.relation_type = 'contradicts'`,
    )
    .all(kbId, kbId)) as Array<{ source_doc_id: string; target_doc_id: string }>;

  const contradictions = contradictionRows.map(
    (r) => `${r.source_doc_id} contradicts ${r.target_doc_id}`,
  );

  safeAppendKbEvent({
    kbId,
    eventType: 'lint',
    title: t('knowledge.lintTitleFull', { orphan: orphanPages.length, stale: stalePages.length, missing: missingPages.length, contradictions: contradictions.length, humanEdited: humanEditedPages.length }, undefined),
    payload: {
      orphanPages: orphanPages.length,
      stalePages: stalePages.length,
      missingPages: missingPages.length,
      contradictions: contradictions.length,
      humanEditedPages: humanEditedPages.length,
    },
  });

  return { orphanPages, stalePages, missingPages, contradictions, humanEditedPages };
}

/**
 * Pick the single `wiki_full` KB most overdue for a lint pass and run it.
 *
 * Wiring goal: called from the 5-minute sweep so every wiki_full KB gets a
 * health check roughly once every `intervalMs` (default 24h). Picks one KB per
 * sweep to bound cost — with N eligible KBs, it takes N sweeps to cover them
 * all (≤ N × 5min = tens of minutes even for large deployments).
 *
 * Returns the KB id that was linted, or `null` if nothing is overdue.
 */
export async function autoLintOneOverdueKb(
  intervalMs: number = 24 * 60 * 60 * 1000,
): Promise<string | null> {
  const cutoff = new Date(Date.now() - intervalMs).toISOString();
  const row = (await dba
    .prepare(
      adaptSql(
        `SELECT kb.id FROM knowledge_bases kb
         LEFT JOIN (
           SELECT kb_id, MAX(created_at) AS last_lint
           FROM knowledge_event_log
           WHERE event_type = 'lint'
           GROUP BY kb_id
         ) l ON l.kb_id = kb.id
         WHERE kb.enhancement_level = 'wiki_full'
           AND kb.enabled = 1
           AND kb.deleted_at IS NULL
           AND (l.last_lint IS NULL OR l.last_lint < ?)
         ORDER BY COALESCE(l.last_lint, '') ASC
         LIMIT 1`,
      ),
    )
    .get(cutoff)) as { id: string } | undefined;
  if (!row) return null;
  await lintWiki(row.id);
  return row.id;
}
