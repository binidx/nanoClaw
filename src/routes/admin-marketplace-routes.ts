import type { Express, Request, Response } from 'express';

import {
  createMarketplaceSource,
  updateMarketplaceSource,
  removeMarketplaceSource,
  listAllMarketplaceSources,
  getMarketplaceSourceView,
} from '../extension/marketplace-source-service.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { logger } from '../logger.js';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';

function paramStr(value: string | string[] | undefined): string {
  return typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? (value[0] ?? '')
      : '';
}

export interface AdminMarketplaceRouteOptions {
  requirePermission: RequirePermissionFn;
}

export function registerAdminMarketplaceRoutes(
  app: Express,
  opts: AdminMarketplaceRouteOptions,
): void {
  const adminGuard = opts.requirePermission(
    'admin.settings.write',
    'marketplace.manage_sources',
  );

  app.get(
    '/api/admin/marketplace-sources',
    adminGuard,
    async (_req: Request, res: Response) => {
      try {
        const sources = await listAllMarketplaceSources();
        res.json(sources);
      } catch (err) {
        logger.error({ err }, 'admin-marketplace: list failed');
        res.status(500).json({ error: 'Failed to list marketplace sources' });
      }
    },
  );

  app.get(
    '/api/admin/marketplace-sources/:id',
    adminGuard,
    async (req: Request, res: Response) => {
      try {
        const source = await getMarketplaceSourceView(paramStr(req.params.id));
        if (!source) {
          res.status(404).json({ error: 'Marketplace source not found' });
          return;
        }
        res.json(source);
      } catch (err) {
        logger.error({ err }, 'admin-marketplace: get failed');
        res.status(500).json({ error: 'Failed to get marketplace source' });
      }
    },
  );

  app.post(
    '/api/admin/marketplace-sources',
    adminGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getCurrentUserId();
        const { id, name, source, enabled, description, iconUrl, sortOrder } =
          req.body;
        if (!name || !source) {
          res.status(400).json({ error: 'name and source are required' });
          return;
        }
        const result = await createMarketplaceSource(userId, {
          id,
          name,
          source,
          enabled,
          description,
          iconUrl,
          sortOrder,
        });
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'admin-marketplace: create failed');
        res.status(500).json({ error: 'Failed to create marketplace source' });
      }
    },
  );

  app.put(
    '/api/admin/marketplace-sources/:id',
    adminGuard,
    async (req: Request, res: Response) => {
      try {
        const result = await updateMarketplaceSource(
          paramStr(req.params.id),
          req.body,
        );
        if (!result) {
          res.status(404).json({ error: 'Marketplace source not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        logger.error({ err }, 'admin-marketplace: update failed');
        res.status(500).json({ error: 'Failed to update marketplace source' });
      }
    },
  );

  app.delete(
    '/api/admin/marketplace-sources/:id',
    adminGuard,
    async (req: Request, res: Response) => {
      try {
        const ok = await removeMarketplaceSource(paramStr(req.params.id));
        if (!ok) {
          res.status(404).json({ error: 'Marketplace source not found' });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'admin-marketplace: delete failed');
        res.status(500).json({ error: 'Failed to delete marketplace source' });
      }
    },
  );

  // Public endpoint: list enabled sources (no admin required)
  app.get('/api/marketplace-sources', async (_req: Request, res: Response) => {
    try {
      const sources = await listAllMarketplaceSources(true);
      res.json(sources);
    } catch (err) {
      logger.error({ err }, 'marketplace-sources: list failed');
      res.status(500).json({ error: 'Failed to list marketplace sources' });
    }
  });
}
