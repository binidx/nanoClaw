import type { Express } from 'express';

import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import {
  assignUserRole,
  createRole,
  createUser,
  deleteUser,
  isMultiUserMode,
  listPermissions,
  listRolesWithPermissions,
  listUsers,
  replaceRolePermissions,
  revokeUserRole,
  updateUser,
} from '../user/user-service.js';
import { t } from '../i18n/index.js';

export interface UserRouteOptions {
  requirePermission: (...codes: string[]) => import('express').RequestHandler;
}

export function registerUserRoutes(
  app: Express,
  opts: UserRouteOptions,
): void {
  app.get(
    '/api/users/multi-user-mode',
    async (_req, res) => {
      try {
        res.json({ ok: true, enabled: await isMultiUserMode() });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.get(
    '/api/users',
    opts.requirePermission('system.users', 'system.users.view'),
    async (_req, res) => {
      try {
        res.json({ ok: true, users: await listUsers() });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/users',
    opts.requirePermission('system.users', 'system.users.create'),
    async (req, res) => {
      try {
        const { username, password, displayName, email, roleNames } = req.body;
        if (!username) {
          res.status(400).json({ ok: false, error: t('auth.usernameRequired', {}, req.locale) });
          return;
        }
        const user = await createUser({
          username,
          password:
            typeof password === 'string' && password.trim()
              ? password
              : 'admin123',
          displayName,
          email,
          roleNames,
        });
        await auditAdminAction(req, AUDIT_ACTIONS.USER_CREATE, { targetType: 'users', targetId: user.id, targetName: username });
        res.json({ ok: true, user });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('UNIQUE') || msg.includes('Duplicate')) {
          res.status(409).json({ ok: false, error: t('auth.usernameExists', {}, req.locale) });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.put(
    '/api/users/:id',
    opts.requirePermission('system.users', 'system.users.edit'),
    async (req, res) => {
      try {
        const { displayName, email, password, status } = req.body;
        const userId = String(req.params.id);
        await updateUser(userId, {
          displayName,
          email,
          password,
          status,
        });
        await auditAdminAction(req, AUDIT_ACTIONS.USER_UPDATE, { targetType: 'users', targetId: userId });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.delete(
    '/api/users/:id',
    opts.requirePermission('system.users', 'system.users.delete'),
    async (req, res) => {
      try {
        const userId = String(req.params.id);
        await deleteUser(userId);
        await auditAdminAction(req, AUDIT_ACTIONS.USER_DELETE, { targetType: 'users', targetId: userId });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.get(
    '/api/roles',
    opts.requirePermission('system.users', 'system.users.view'),
    async (_req, res) => {
      try {
        res.json({ ok: true, roles: await listRolesWithPermissions() });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/roles',
    opts.requirePermission('system.users', 'system.users.assign_role'),
    async (req, res) => {
      try {
        const { name, description } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
          res.status(400).json({ ok: false, error: t('user.roleNameRequired', {}, req.locale) });
          return;
        }
        const role = await createRole(name.trim(), String(description || ''));
        await auditAdminAction(req, AUDIT_ACTIONS.ROLE_CREATE, { targetType: 'roles', targetId: role.id, targetName: name.trim() });
        res.json({ ok: true, role });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes(t('errors.auto_cb9519', {}, req.locale))) {
          res.status(409).json({ ok: false, error: msg });
        } else {
          res.status(500).json({ ok: false, error: msg });
        }
      }
    },
  );

  app.get(
    '/api/permissions',
    opts.requirePermission('system.users', 'system.users.view'),
    async (_req, res) => {
      try {
        res.json({ ok: true, permissions: await listPermissions() });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/users/:id/roles',
    opts.requirePermission('system.users', 'system.users.assign_role'),
    async (req, res) => {
      try {
        const { roleId } = req.body;
        const targetUserId = String(req.params.id);
        await assignUserRole(targetUserId, roleId);
        await auditAdminAction(req, AUDIT_ACTIONS.USER_ROLE_ASSIGN, { targetType: 'user_roles', targetId: targetUserId, details: { roleId } });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.delete(
    '/api/users/:id/roles/:roleId',
    opts.requirePermission('system.users', 'system.users.assign_role'),
    async (req, res) => {
      try {
        const targetUserId = String(req.params.id);
        const roleId = String(req.params.roleId);
        await revokeUserRole(targetUserId, roleId);
        await auditAdminAction(req, AUDIT_ACTIONS.USER_ROLE_REMOVE, { targetType: 'user_roles', targetId: targetUserId, details: { roleId } });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.put(
    '/api/roles/:roleId/permissions',
    opts.requirePermission('system.users', 'system.users.assign_role'),
    async (req, res) => {
      try {
        const roleId = String(req.params.roleId || '');
        const { permissionCodes } = req.body;
        if (!Array.isArray(permissionCodes)) {
          res.status(400).json({ ok: false, error: 'permissionCodes must be an array' });
          return;
        }
        await replaceRolePermissions(roleId, permissionCodes);
        await auditAdminAction(req, AUDIT_ACTIONS.ROLE_UPDATE, { targetType: 'roles', targetId: roleId, details: { permissionCodes } });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );
}
