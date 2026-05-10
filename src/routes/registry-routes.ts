import type { Express, Request, Response } from 'express';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import {
  fetchRegistryCatalog,
  installFromRegistry,
} from '../extension/registry-service.js';
import { logger } from '../logger.js';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';

export interface RegistryRouteOptions {
  requirePermission: RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
}

export function registerRegistryRoutes(
  app: Express,
  opts: RegistryRouteOptions,
): void {
  const viewGuard = opts.requirePermission('marketplace.view');
  const installGuard = opts.requirePermission('marketplace.install');
  const localInstallGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');

  app.get('/api/registry/catalog', viewGuard, async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const type = typeof req.query.type === 'string'
        ? (req.query.type as 'skill' | 'mcp' | 'bundle')
        : undefined;
      const forceRefresh = req.query.refresh === '1';
      const catalog = await fetchRegistryCatalog({ search, type, forceRefresh });
      res.json(catalog);
    } catch (err) {
      logger.error({ err }, 'registry: catalog fetch failed');
      res.status(500).json({ error: 'Failed to fetch registry catalog' });
    }
  });

  app.post('/api/registry/install', installGuard, localInstallGuard, async (req: Request, res: Response) => {
    try {
      const userId = getCurrentUserId();
      const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
      if (!slug) {
        res.status(400).json({ error: 'slug is required' });
        return;
      }
      const results = await installFromRegistry(userId, slug);
      res.json({ ok: true, installed: results });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Install failed';
      logger.error({ err }, 'registry: install failed');
      res.status(500).json({ error: message });
    }
  });
}
