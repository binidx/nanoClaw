import type { Express, Request, Response } from 'express';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  grantResourceAccess,
  revokeResourceAccess,
  listResourceAccessUsers,
  listUserAccessibleResources,
  grantPermissionOverride,
  revokePermissionOverride,
  listPermissionOverrides,
  invalidatePermissionCache,
} from '../auth/permission-engine.js';
import { logger } from '../logger.js';

const VALID_ACCESS_LEVELS = new Set(['viewer', 'editor', 'manager']);

export interface ResourceAccessRouteOptions {
  requirePermission: RequirePermissionFn;
}

export function registerResourceAccessRoutes(
  app: Express,
  opts: ResourceAccessRouteOptions,
): void {
  const adminGuard = opts.requirePermission('system.users', 'system.users.edit');

  app.get('/api/resource-access/:resourceType/:resourceId', adminGuard, async (req: Request, res: Response) => {
    try {
      const users = await listResourceAccessUsers(
        String(req.params.resourceType),
        String(req.params.resourceId),
      );
      res.json({ ok: true, users });
    } catch (err) {
      logger.error({ err }, 'resource-access: list failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/resource-access', adminGuard, async (req: Request, res: Response) => {
    try {
      const { resourceType, resourceId, userId, accessLevel, expiresAt } = req.body;
      if (!resourceType || !resourceId || !userId || !accessLevel) {
        res.status(400).json({ ok: false, error: 'Missing required fields' });
        return;
      }
      if (!VALID_ACCESS_LEVELS.has(accessLevel)) {
        res.status(400).json({ ok: false, error: `accessLevel must be one of: ${[...VALID_ACCESS_LEVELS].join(', ')}` });
        return;
      }
      const grantedBy = getTenantUserId(req);
      await grantResourceAccess(resourceType, resourceId, userId, accessLevel, grantedBy, expiresAt);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'resource-access: grant failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/resource-access/:resourceType/:resourceId/:userId', adminGuard, async (req: Request, res: Response) => {
    try {
      await revokeResourceAccess(
        String(req.params.resourceType),
        String(req.params.resourceId),
        String(req.params.userId),
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'resource-access: revoke failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/resource-access/user/:userId/:resourceType', adminGuard, async (req: Request, res: Response) => {
    try {
      const resources = await listUserAccessibleResources(
        String(req.params.userId),
        String(req.params.resourceType),
      );
      res.json({ ok: true, resources });
    } catch (err) {
      logger.error({ err }, 'resource-access: user resources failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Permission overrides ──
  app.get('/api/permission-overrides/:userId', adminGuard, async (req: Request, res: Response) => {
    try {
      const overrides = await listPermissionOverrides(String(req.params.userId));
      res.json({ ok: true, overrides });
    } catch (err) {
      logger.error({ err }, 'permission-overrides: list failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/permission-overrides', adminGuard, async (req: Request, res: Response) => {
    try {
      const { userId, permissionCode, effect } = req.body;
      if (!userId || !permissionCode || !effect) {
        res.status(400).json({ ok: false, error: 'Missing required fields' });
        return;
      }
      if (effect !== 'allow' && effect !== 'deny') {
        res.status(400).json({ ok: false, error: 'effect must be "allow" or "deny"' });
        return;
      }
      const grantedBy = getTenantUserId(req);
      await grantPermissionOverride(userId, permissionCode, effect, grantedBy);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'permission-overrides: grant failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/permission-overrides/:userId/:permissionCode', adminGuard, async (req: Request, res: Response) => {
    try {
      const uid = String(req.params.userId);
      const code = String(req.params.permissionCode);
      await revokePermissionOverride(uid, code);
      invalidatePermissionCache(uid);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'permission-overrides: revoke failed');
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
