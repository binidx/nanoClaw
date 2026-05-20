import type { Express } from 'express';

import { listKnowledgeBases } from '../db.js';
import { retrieveContext } from '../retrieval/service.js';
import { getCurrentUserId, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { logger } from '../logger.js';

export interface RetrievalRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function getTenantUserId(req: import('express').Request): string {
  return (req as import('express').Request & { tenantUserId?: string }).tenantUserId || getCurrentUserId();
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

export function registerRetrievalRoutes(app: Express, opts: RetrievalRouteOptions): void {
  const guard = opts.requirePermission('assistant.manage', 'knowledge.view');

  app.post('/api/retrieval/search', guard, async (req, res) => {
    try {
      const query = String(req.body?.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      const userId = getTenantUserId(req);
      const visibleIds = (await listKnowledgeBases())
        .filter((kb) => isKbVisibleToUser(kb, userId))
        .map((kb) => kb.id);
      const requestedKbIds = parseStringArray(req.body?.kb_ids);
      const visibleSet = new Set(visibleIds);
      const kbIds = requestedKbIds
        ? requestedKbIds.filter((id) => visibleSet.has(id))
        : visibleIds;
      const includeMemory = req.body?.include_memory === true;

      const response = await retrieveContext({
        query,
        kbIds,
        topK: req.body?.top_k,
        minScore: parseOptionalScore(req.body?.min_score),
        includeKnowledge: req.body?.include_knowledge !== false,
        includeMemory,
        memory: includeMemory
          ? {
            scopes: ['global'],
            ownerType: 'global',
            ownerId: userId,
            sourceTypes: ['user_memory'],
          }
          : undefined,
        strategy: req.body?.strategy && typeof req.body.strategy === 'object'
          ? req.body.strategy
          : undefined,
      });
      res.json(response);
    } catch (err) {
      logger.error({ err }, 'Failed retrieval search');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
