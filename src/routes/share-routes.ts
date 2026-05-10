import crypto from 'crypto';
import type { Express } from 'express';

import { getShareBaseUrl } from '../config-store.js';
import {
  createShare,
  deleteShare,
  getShareById,
  incrementShareViewCount,
  listUserShares,
} from '../db/shares.js';
import { logger } from '../logger.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { t } from '../i18n/index.js';

function routePathParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function generateShareId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Public routes — registered BEFORE requireAuth so they bypass session checks.
 */
export function registerPublicShareRoutes(app: Express): void {
  app.get('/api/share/:shareId', async (req, res) => {
    try {
      const shareId = routePathParam(req.params.shareId);
      const share = await getShareById(shareId);
      if (!share) {
        res.status(404).json({ error: t('share.notFound', {}, req.locale) });
        return;
      }

      void incrementShareViewCount(shareId).catch(() => {});

      let entries: unknown[];
      try {
        entries = JSON.parse(share.content);
      } catch {
        entries = [];
      }

      res.json({
        id: share.id,
        title: share.title,
        entries,
        assistantName: share.assistant_name,
        createdBy: share.created_by,
        createdAt: share.created_at,
        viewCount: share.view_count,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

export interface ShareRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

/**
 * Authenticated routes — registered AFTER requireAuth.
 */
export function registerShareRoutes(app: Express, opts: ShareRouteOptions): void {
  const guard = opts.requirePermission('conversation.share', 'conversation.own');

  app.post('/api/conversations/share', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const { jid, title, entries, assistantName } = req.body as {
        jid?: string;
        title?: string;
        entries?: unknown[];
        assistantName?: string;
      };

      if (!jid || !entries || !Array.isArray(entries) || entries.length === 0) {
        res.status(400).json({ error: t('share.paramsRequired', {}, req.locale) });
        return;
      }

      const shareId = generateShareId();
      const content = JSON.stringify(entries);

      await createShare(
        shareId,
        jid,
        title || null,
        content,
        assistantName || null,
        userId,
        userId,
      );

      const baseUrl = await getShareBaseUrl();
      res.json({ shareId, url: `${baseUrl}/share/${shareId}` });
    } catch (err) {
      logger.error({ err }, 'Failed to create share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/my-shares', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const jid = typeof req.query.jid === 'string' ? req.query.jid : undefined;

      const result = await listUserShares(userId, limit, offset, jid);
      const shareBaseUrl = await getShareBaseUrl();
      res.json({ ...result, shareBaseUrl });
    } catch (err) {
      logger.error({ err }, 'Failed to list shares');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/share/:shareId', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const shareId = routePathParam(req.params.shareId);
      const deleted = await deleteShare(shareId, userId);
      if (!deleted) {
        res.status(404).json({ error: t('share.noPermission', {}, req.locale) });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete share');
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
