import { Router, type Express } from 'express';

import { getAuditLogById, listAuditLogs } from '../db/audit-log.js';

export function registerAdminAuditRoutes(
  app: Express,
  deps: {
    requirePermission: (perm: string) => import('express').RequestHandler;
  },
): void {
  const guard = deps.requirePermission('system.settings');
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const q = req.query;
      const page =
        typeof q.page === 'string' && q.page.trim() !== ''
          ? Number.parseInt(q.page, 10)
          : undefined;
      const pageSize =
        typeof q.pageSize === 'string' && q.pageSize.trim() !== ''
          ? Number.parseInt(q.pageSize, 10)
          : undefined;
      const userId = typeof q.userId === 'string' ? q.userId : undefined;
      const action = typeof q.action === 'string' ? q.action : undefined;
      const targetType =
        typeof q.targetType === 'string' ? q.targetType : undefined;

      const result = await listAuditLogs({
        page: Number.isFinite(page) ? page : undefined,
        pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
        userId,
        action,
        targetType,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const entry = await getAuditLogById(req.params.id ?? '');
      if (!entry) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      res.json({ ok: true, item: entry });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.use('/api/admin/audit-logs', guard, router);
}
