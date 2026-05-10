import type { Express, Request, Response } from 'express';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import {
  queryPublicLibrary,
  type PublicLibraryItemType,
} from '../extension/public-library-service.js';
import { installSharedMcpToUser, adminRemoveMcpServer } from '../user/user-mcp-service.js';
import { installSharedSkillToUser, adminRemoveSkill } from '../user/user-skill-service.js';
import { logger } from '../logger.js';

export interface PublicLibraryRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
}

export function registerPublicLibraryRoutes(app: Express, opts: PublicLibraryRouteOptions): void {
  const viewGuard = opts.requirePermission('marketplace.view', 'mcp.view', 'skill.view');
  const installGuard = opts.requirePermission('marketplace.install');
  const localInstallGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');
  const adminGuard = opts.requirePermission('marketplace.manage_sources', 'admin.settings.write');

  app.get('/api/public-library', viewGuard, async (req: Request, res: Response) => {
    try {
      const type = req.query.type as PublicLibraryItemType | undefined;
      const search = req.query.search as string | undefined;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const result = await queryPublicLibrary({ type, search, limit, offset });
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'public-library: query failed');
      res.status(500).json({ error: 'Failed to query public library' });
    }
  });

  app.post('/api/public-library/install', installGuard, localInstallGuard, async (req: Request, res: Response) => {
    try {
      const userId = getCurrentUserId();
      const { itemId, itemType } = req.body as { itemId?: string; itemType?: string };
      if (!itemId || !itemType) {
        res.status(400).json({ error: 'itemId and itemType are required' });
        return;
      }

      let result: unknown;
      if (itemType === 'mcp') {
        result = await installSharedMcpToUser(userId, itemId);
      } else if (itemType === 'skill') {
        result = await installSharedSkillToUser(userId, itemId);
      } else {
        res.status(400).json({ error: 'Invalid itemType, must be "mcp" or "skill"' });
        return;
      }

      if (!result) {
        res.status(404).json({ error: 'Item not found or not shared' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'public-library: install failed');
      res.status(500).json({ error: 'Failed to install item' });
    }
  });

  app.delete('/api/public-library/:itemType/:itemId', adminGuard, async (req: Request, res: Response) => {
    try {
      const itemType = typeof req.params.itemType === 'string' ? req.params.itemType : '';
      const itemId = typeof req.params.itemId === 'string' ? req.params.itemId : '';
      let ok = false;
      if (itemType === 'mcp') {
        ok = await adminRemoveMcpServer(itemId);
      } else if (itemType === 'skill') {
        ok = await adminRemoveSkill(itemId);
      } else {
        res.status(400).json({ error: 'Invalid itemType, must be "mcp" or "skill"' });
        return;
      }
      if (!ok) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'public-library: admin delete failed');
      res.status(500).json({ error: 'Failed to delete item' });
    }
  });
}
