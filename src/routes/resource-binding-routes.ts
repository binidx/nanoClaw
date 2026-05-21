import type { Express, Request, Response } from 'express';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { getAssistant } from '../db.js';
import { getWorkflow } from '../db/workflows.js';
import {
  listOwnerBindings,
  listResourceBindings,
  createRepositoryBinding,
  removeBinding,
  getBinding,
} from '../tenant/resource-binding-service.js';
import { getRepositoryById } from '../db/repositories.js';
import { t } from '../i18n/index.js';

export interface ResourceBindingRouteOptions {
  requirePermission: RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

const VALID_OWNER_TYPES = ['assistant', 'workflow'] as const;
type OwnerType = (typeof VALID_OWNER_TYPES)[number];

function isValidOwnerType(v: unknown): v is OwnerType {
  return typeof v === 'string' && VALID_OWNER_TYPES.includes(v as OwnerType);
}

function permissionForOwner(ownerType: OwnerType, mode: 'view' | 'manage'): string[] {
  if (ownerType === 'assistant') {
    return mode === 'view'
      ? ['assistant.manage', 'assistant.view']
      : ['assistant.manage', 'assistant.edit'];
  }
  return mode === 'view'
    ? ['project.view', 'workteam.view']
    : ['project.manage', 'workteam.manage'];
}

async function verifyOwnerAccess(
  ownerType: OwnerType,
  ownerId: string,
  userId: string,
  mode: 'view' | 'manage' = 'manage',
): Promise<boolean> {
  if (ownerType === 'assistant') {
    const assistant = await getAssistant(ownerId);
    if (!assistant) return false;
    if (assistant.user_id === userId) return true;
    if (assistant.user_id === SYSTEM_USER_ID && userId === SYSTEM_USER_ID) return true;
    if (mode === 'view') return (assistant as { visibility?: string }).visibility === 'shared';
    return false;
  }
  if (ownerType === 'workflow') {
    const resource = await getWorkflow(ownerId);
    if (!resource) return false;
    if (resource.user_id === userId) return true;
    return resource.user_id === SYSTEM_USER_ID && userId === SYSTEM_USER_ID;
  }
  return false;
}

async function enforcePermission(
  req: Request,
  res: Response,
  guard: ReturnType<RequirePermissionFn>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    guard(req, res, (err?: unknown) => {
      if (err) { resolve(false); return; }
      if (res.headersSent) { resolve(false); return; }
      resolve(true);
    });
  });
}

export function registerResourceBindingRoutes(
  app: Express,
  opts: ResourceBindingRouteOptions,
): void {
  app.get(
    '/api/resource-bindings',
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const { ownerType, ownerId, resourceType, resourceId } = req.query as Record<string, string | undefined>;

        if (ownerType && ownerId) {
        if (!isValidOwnerType(ownerType)) {
            res.status(400).json({ error: 'ownerType must be assistant or workflow' });
            return;
          }
          const ok = await enforcePermission(
            req,
            res,
            opts.requirePermission(...permissionForOwner(ownerType, 'view')),
          );
          if (!ok) return;

          const hasAccess = await verifyOwnerAccess(ownerType, ownerId, userId, 'view');
          if (!hasAccess) {
            res.status(404).json({ error: `${ownerType} not found` });
            return;
          }

          const bindings = await listOwnerBindings(ownerType, ownerId, userId);
          res.json({ bindings });
          return;
        }

        if (resourceType && resourceId) {
          const repoOk = await enforcePermission(req, res, opts.requirePermission('repository.view'));
          if (!repoOk) return;
          if (resourceType === 'repository') {
            const repo = await getRepositoryById(resourceId, userId);
            if (!repo) {
              res.status(404).json({ error: 'Repository not found' });
              return;
            }
          }
          const bindings = await listResourceBindings(resourceType, resourceId);
          res.json({ bindings });
          return;
        }

        res.status(400).json({ error: 'ownerType+ownerId or resourceType+resourceId required' });
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.post(
    '/api/resource-bindings',
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const body = req.body as Record<string, unknown>;
        const ownerType = body.ownerType as string | undefined;
        const ownerId = body.ownerId as string | undefined;
        const repositoryId = body.repositoryId as string | undefined;

        if (!isValidOwnerType(ownerType)) {
          res.status(400).json({ error: 'ownerType must be assistant or workflow' });
          return;
        }
        if (!ownerId || typeof ownerId !== 'string') {
          res.status(400).json({ error: 'ownerId is required' });
          return;
        }
        if (!repositoryId || typeof repositoryId !== 'string') {
          res.status(400).json({ error: 'repositoryId is required' });
          return;
        }

        const ok = await enforcePermission(
          req,
          res,
          opts.requirePermission(...permissionForOwner(ownerType, 'manage')),
        );
        if (!ok) return;

        const hasAccess = await verifyOwnerAccess(ownerType, ownerId, userId, 'manage');
        if (!hasAccess) {
          res.status(404).json({ error: `${ownerType} not found` });
          return;
        }

        opts.auditMutation(req, 'resource_binding.create');

        const binding = await createRepositoryBinding(
          ownerType,
          ownerId,
          repositoryId,
          {
            branch: (body.branch as string) || undefined,
            workDirectory: (body.workDirectory as string) || undefined,
            bindingKey: (body.bindingKey as string) || undefined,
            config: body.config && typeof body.config === 'object' && !Array.isArray(body.config)
              ? (body.config as Record<string, unknown>)
              : undefined,
          },
          userId,
        );

        res.status(201).json(binding);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'Repository not found or deleted') {
          res.status(404).json({ error: msg });
          return;
        }
        const errCode = (err as Record<string, unknown>).code;
        if (
          msg.includes('UNIQUE constraint') ||
          msg.includes('Duplicate entry') ||
          msg.includes('duplicate key value') ||
          errCode === '23505' ||
          errCode === 'ER_DUP_ENTRY'
        ) {
          res.status(409).json({ error: t('errors.auto_73a7cb', {}, req.locale) });
          return;
        }
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.delete(
    '/api/resource-bindings/:id',
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const id = typeof req.params.id === 'string' ? req.params.id : '';

        const existing = await getBinding(id);
        if (!existing) {
          res.status(404).json({ error: 'Binding not found' });
          return;
        }

        if (!isValidOwnerType(existing.ownerType)) {
          res.status(403).json({ error: 'Cannot delete binding with unknown owner type' });
          return;
        }

        const ok = await enforcePermission(
          req,
          res,
          opts.requirePermission(...permissionForOwner(existing.ownerType as OwnerType, 'manage')),
        );
        if (!ok) return;

        const hasAccess = await verifyOwnerAccess(existing.ownerType, existing.ownerId, userId, 'manage');
        if (!hasAccess) {
          res.status(403).json({ error: 'No access to owner resource' });
          return;
        }

        opts.auditMutation(req, 'resource_binding.delete');
        await removeBinding(id);
        res.json({ success: true });
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );
}
