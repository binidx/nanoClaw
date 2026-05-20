import type { Express, RequestHandler } from 'express';

import { retrieveContext } from '../retrieval/service.js';
import { logger } from '../logger.js';
import { resolveAgentAccessibleKbs } from './internal-knowledge-routes.js';

interface InternalRetrievalRouteOptions {
  requireInternalApi: RequestHandler;
}

function parseTopK(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function parseOptionalScore(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function registerInternalRetrievalRoutes(
  app: Express,
  options: InternalRetrievalRouteOptions,
): void {
  app.post(
    '/internal/retrieval/search',
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

        const chatJid = String(req.body?.chat_jid || req.body?.chatJid || '').trim();
        const accessibleKbs = await resolveAgentAccessibleKbs(userId, chatJid);
        const visibleIds = accessibleKbs.map((kb) => kb.id);
        const requestedKbIds = parseStringArray(req.body?.kb_ids);
        const visibleSet = new Set(visibleIds);
        const kbIds = requestedKbIds
          ? requestedKbIds.filter((id) => visibleSet.has(id))
          : visibleIds;

        const response = await retrieveContext({
          query,
          kbIds,
          topK: parseTopK(req.body?.top_k),
          minScore: parseOptionalScore(req.body?.min_score),
          includeKnowledge: req.body?.include_knowledge !== false,
          includeMemory: req.body?.include_memory === true,
          memory: req.body?.memory && typeof req.body.memory === 'object'
            ? req.body.memory
            : undefined,
          strategy: req.body?.strategy && typeof req.body.strategy === 'object'
            ? req.body.strategy
            : undefined,
        });
        res.json(response);
      } catch (err) {
        logger.error({ err }, 'Failed internal retrieval search');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );
}
