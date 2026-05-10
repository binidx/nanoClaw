import type { Express, Request, Response } from 'express';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import { createModuleLogger } from '../logger.js';
import {
  isTrashableTable,
  listDeletedRecords,
  purgeRecord,
  restoreRecord,
  type TrashableTable,
} from '../db/trash.js';

const logger = createModuleLogger('admin-trash');

function paramStr(value: string | string[] | undefined): string {
  return typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value[0] ?? ''
      : '';
}

function firstQueryString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

function parseQueryInt(value: unknown, fallback: number): number {
  const raw = firstQueryString(value).trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export interface AdminTrashRouteDeps {
  requirePermission: RequirePermissionFn;
}

export function registerAdminTrashRoutes(
  app: Express,
  deps: AdminTrashRouteDeps,
): void {
  const guard = deps.requirePermission('system.settings');

  app.get(
    '/api/admin/trash/:type',
    guard,
    async (req: Request, res: Response) => {
      try {
        const type = paramStr(req.params.type);
        if (!isTrashableTable(type)) {
          res.status(400).json({ error: 'Invalid trash type' });
          return;
        }
        const table = type as TrashableTable;
        const page = parseQueryInt(req.query.page, 1);
        const pageSize = Math.min(
          200,
          parseQueryInt(req.query.pageSize, 20),
        );
        const { items, total } = await listDeletedRecords(table, {
          page,
          pageSize,
        });
        res.json({ items, total, page, pageSize });
      } catch (err) {
        logger.error({ err }, 'admin-trash: list failed');
        res.status(500).json({ error: 'Failed to list trash' });
      }
    },
  );

  app.post(
    '/api/admin/trash/:type/:id/restore',
    guard,
    async (req: Request, res: Response) => {
      try {
        const type = paramStr(req.params.type);
        if (!isTrashableTable(type)) {
          res.status(400).json({ error: 'Invalid trash type' });
          return;
        }
        const id = paramStr(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'Missing id' });
          return;
        }
        const ok = await restoreRecord(type as TrashableTable, id);
        if (!ok) {
          res.status(404).json({ error: 'Record not found or not in trash' });
          return;
        }
        await auditAdminAction(req, AUDIT_ACTIONS.TRASH_RESTORE, { targetType: type, targetId: id });
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'admin-trash: restore failed');
        res.status(500).json({ error: 'Failed to restore record' });
      }
    },
  );

  app.delete(
    '/api/admin/trash/:type/:id',
    guard,
    async (req: Request, res: Response) => {
      try {
        const type = paramStr(req.params.type);
        if (!isTrashableTable(type)) {
          res.status(400).json({ error: 'Invalid trash type' });
          return;
        }
        const id = paramStr(req.params.id);
        if (!id) {
          res.status(400).json({ error: 'Missing id' });
          return;
        }
        const ok = await purgeRecord(type as TrashableTable, id);
        if (!ok) {
          res.status(404).json({ error: 'Record not found or not in trash' });
          return;
        }
        await auditAdminAction(req, AUDIT_ACTIONS.TRASH_PURGE, { targetType: type, targetId: id });
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'admin-trash: purge failed');
        res.status(500).json({ error: 'Failed to purge record' });
      }
    },
  );
}
