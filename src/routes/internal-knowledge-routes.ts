import type { Express, RequestHandler } from 'express';

import { dba, getKnowledgeBase, listKnowledgeBases } from '../db.js';
import { logger } from '../logger.js';
import { searchKnowledge } from '../knowledge/retrieval.js';
import { listUserKnowledgeBindings } from '../knowledge/user-kb-service.js';
import { runWithTenantAsync, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

interface InternalKnowledgeRouteOptions {
  requireInternalApi: RequestHandler;
}

function isKbVisibleToUser(
  kb: { user_id?: string | null; visibility?: string | null },
  userId: string,
): boolean {
  if (userId === SYSTEM_USER_ID) return true;
  if (kb.user_id === SYSTEM_USER_ID) return true;
  if (kb.user_id === userId) return true;
  return kb.visibility === 'shared';
}

async function resolveAgentAccessibleKbs(
  userId: string,
): Promise<Array<{
  id: string;
  user_enabled: number;
  enabled: number;
  user_id: string;
  visibility: string;
}>> {
  const bases = await listKnowledgeBases();
  const visible = bases.filter((kb) => isKbVisibleToUser(kb, userId));
  if (userId === SYSTEM_USER_ID) {
    return visible.map((kb) => ({
      ...kb,
      user_enabled: 1,
    }));
  }

  const bindings = await listUserKnowledgeBindings(userId);
  const bindingMap = new Map(bindings.map((binding) => [binding.kb_id, binding.enabled]));
  return visible
    .map((kb) => ({
      ...kb,
      user_enabled: bindingMap.get(kb.id) ?? 0,
    }))
    .filter((kb) => kb.enabled === 1 && (kb.user_enabled === 1 || kb.visibility === 'shared'));
}

export function registerInternalKnowledgeRoutes(
  app: Express,
  options: InternalKnowledgeRouteOptions,
): void {
  app.get(
    '/internal/knowledge/bases',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const userId = String(req.query.user_id || '').trim();
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }
        res.json(await resolveAgentAccessibleKbs(userId));
      } catch (err) {
        logger.error({ err }, 'Failed to list internal knowledge bases');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/knowledge/search',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const query = String(req.body?.query ?? '').trim();
        const userId = String(req.body?.user_id ?? '').trim();
        if (!query) {
          res.status(400).json({ error: 'query is required' });
          return;
        }
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }

        let topK: number | undefined;
        const topKRaw = req.body?.top_k;
        if (topKRaw !== undefined && topKRaw !== null && topKRaw !== '') {
          const parsed =
            typeof topKRaw === 'number' && Number.isFinite(topKRaw)
              ? Math.trunc(topKRaw)
              : Number.parseInt(String(topKRaw), 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
            res.status(400).json({ error: 'top_k must be between 1 and 50' });
            return;
          }
          topK = parsed;
        }

        let minScore: number | undefined;
        const minScoreRaw = req.body?.min_score;
        if (minScoreRaw !== undefined && minScoreRaw !== null && minScoreRaw !== '') {
          const parsed =
            typeof minScoreRaw === 'number' && Number.isFinite(minScoreRaw)
              ? minScoreRaw
              : Number.parseFloat(String(minScoreRaw));
          if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            res.status(400).json({ error: 'min_score must be between 0 and 1' });
            return;
          }
          minScore = parsed;
        }

        const accessibleKbs = await resolveAgentAccessibleKbs(userId);
        const visibleIds = accessibleKbs.map((kb) => kb.id);

        const kbIdsBody = req.body?.kb_ids;
        let kbIdsForSearch: string[];
        if (Array.isArray(kbIdsBody) && kbIdsBody.length > 0) {
          const visibleSet = new Set(visibleIds);
          kbIdsForSearch = kbIdsBody.filter(
            (kid: unknown) => typeof kid === 'string' && visibleSet.has(kid),
          );
        } else {
          kbIdsForSearch = visibleIds;
        }

        const results = await searchKnowledge(query, {
          kbIds: kbIdsForSearch,
          topK,
          minScore,
        });
        res.json(results);
      } catch (err) {
        logger.error({ err }, 'Failed internal knowledge search');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.get(
    '/internal/knowledge/wiki-pages',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const kbId = String(req.query.kb_id ?? '').trim();
        const userId = String(req.query.user_id ?? '').trim();
        if (!kbId) {
          res.status(400).json({ error: 'kb_id is required' });
          return;
        }
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }
        const kb = await getKnowledgeBase(kbId);
        if (!kb || !isKbVisibleToUser(kb, userId)) {
          res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
          return;
        }

        const pageType = String(req.query.page_type ?? '').trim();
        const limitRaw = req.query.limit;
        let limit = 50;
        if (limitRaw !== undefined && limitRaw !== '' && limitRaw !== null) {
          const parsed = Number.parseInt(String(limitRaw), 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
            res.status(400).json({ error: 'limit must be between 1 and 200' });
            return;
          }
          limit = parsed;
        }

        const rows = (await dba.prepare(
          pageType
            ? `SELECT id, kb_id, page_type, title, version, edited_by_human, updated_at, source_doc_ids
               FROM knowledge_wiki_pages
               WHERE kb_id = ? AND page_type = ?
               ORDER BY page_type, title
               LIMIT ?`
            : `SELECT id, kb_id, page_type, title, version, edited_by_human, updated_at, source_doc_ids
               FROM knowledge_wiki_pages
               WHERE kb_id = ?
               ORDER BY page_type, title
               LIMIT ?`,
        ).all(...(pageType ? [kbId, pageType, limit] : [kbId, limit]))) as Array<{
          id: string;
          kb_id: string;
          page_type: string;
          title: string;
          version: number;
          edited_by_human: number;
          updated_at: string;
          source_doc_ids: string | null;
        }>;

        res.json(rows.map((row) => {
          let sourceDocCount = 0;
          try {
            const parsed = JSON.parse(row.source_doc_ids || '[]') as unknown;
            sourceDocCount = Array.isArray(parsed) ? parsed.length : 0;
          } catch {
            sourceDocCount = 0;
          }
          return {
            ...row,
            source_doc_count: sourceDocCount,
          };
        }));
      } catch (err) {
        logger.error({ err }, 'Failed to list internal knowledge wiki pages');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.get(
    '/internal/knowledge/wiki-page',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const userId = String(req.query.user_id ?? '').trim();
        const pageId = String(req.query.page_id ?? '').trim();
        const kbId = String(req.query.kb_id ?? '').trim();
        const title = String(req.query.title ?? '').trim();
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }
        if (!pageId && !(kbId && title)) {
          res.status(400).json({ error: 'page_id or (kb_id and title) is required' });
          return;
        }

        const row = (await dba.prepare(
          pageId
            ? `SELECT * FROM knowledge_wiki_pages WHERE id = ? LIMIT 1`
            : `SELECT * FROM knowledge_wiki_pages WHERE kb_id = ? AND title = ? ORDER BY updated_at DESC LIMIT 1`,
        ).get(...(pageId ? [pageId] : [kbId, title]))) as Record<string, unknown> | undefined;
        if (!row) {
          res.status(404).json({ error: t('knowledge.wikiPageNotFound', {}, req.locale) });
          return;
        }
        const pageKbId = String(row.kb_id ?? '');
        const kb = await getKnowledgeBase(pageKbId);
        if (!kb || !isKbVisibleToUser(kb, userId)) {
          res.status(404).json({ error: t('knowledge.wikiPageNotFound', {}, req.locale) });
          return;
        }
        res.json(row);
      } catch (err) {
        logger.error({ err }, 'Failed to read internal knowledge wiki page');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.get(
    '/internal/knowledge/events',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const kbId = String(req.query.kb_id ?? '').trim();
        const userId = String(req.query.user_id ?? '').trim();
        if (!kbId) {
          res.status(400).json({ error: 'kb_id is required' });
          return;
        }
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }
        const kb = await getKnowledgeBase(kbId);
        if (!kb || !isKbVisibleToUser(kb, userId)) {
          res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
          return;
        }

        const limitRaw = req.query.limit;
        let limit: number | undefined;
        if (limitRaw !== undefined && limitRaw !== '' && limitRaw !== null) {
          const parsed = Number.parseInt(String(limitRaw), 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
            res.status(400).json({ error: 'limit must be between 1 and 100' });
            return;
          }
          limit = parsed;
        }

        const { KB_EVENT_TYPES, listRecentEvents } = await import('../knowledge/event-log.js');
        const typeRaw = req.query.type ? String(req.query.type).trim() : '';
        let eventType: (typeof KB_EVENT_TYPES)[number] | undefined;
        if (typeRaw) {
          if (!(KB_EVENT_TYPES as readonly string[]).includes(typeRaw)) {
            res.status(400).json({ error: `type must be one of: ${KB_EVENT_TYPES.join(', ')}` });
            return;
          }
          eventType = typeRaw as (typeof KB_EVENT_TYPES)[number];
        }

        const rows = await listRecentEvents(kbId, limit, eventType);
        res.json(rows);
      } catch (err) {
        logger.error({ err }, 'Failed internal knowledge events listing');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.post(
    '/internal/knowledge/backfill-wiki',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const kbId = String(req.body?.kb_id ?? '').trim();
        const userId = String(req.body?.user_id ?? '').trim();
        const title = String(req.body?.title ?? '').trim();
        const content = String(req.body?.content ?? '').trim();
        const sourceQuery = String(req.body?.source_query ?? '').trim();
        if (!kbId) {
          res.status(400).json({ error: 'kb_id is required' });
          return;
        }
        if (!userId) {
          res.status(400).json({ error: 'user_id is required' });
          return;
        }
        const kb = await getKnowledgeBase(kbId);
        if (!kb || !isKbVisibleToUser(kb, userId)) {
          res.status(404).json({ error: t('knowledge.notFound', {}, req.locale) });
          return;
        }

        const { backfillQueryToWiki, QueryBackfillError } = await import('../knowledge/query-backfill.js');
        try {
          const { pageId } = await runWithTenantAsync({ userId }, async () =>
            backfillQueryToWiki({
              kbId,
              userId,
              title,
              content,
              sourceQuery,
            }),
          );
          res.json({ ok: true, page_id: pageId });
        } catch (e) {
          if (e instanceof QueryBackfillError) {
            res.status(e.statusCode).json({ error: e.message });
            return;
          }
          throw e;
        }
      } catch (err) {
        logger.error({ err }, 'Failed internal knowledge wiki backfill');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
}
