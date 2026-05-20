import type { Express } from 'express';

import {
  addMembers,
  assertRole,
  checkMembership,
  listActiveMembers,
  removeMember,
  setMemberRole,
} from '../im/im-membership-service.js';
import {
  approveImJoinRequest,
  createImJoinRequest,
  listImJoinRequests,
  rejectImJoinRequest,
  searchPublicGroups,
} from '../im/im-service.js';
import type { ImMembership } from '../im/im-types.js';
import { getTenantUserId } from '../tenant/tenant-request.js';

export interface ImGroupRouteOptions {
  getAuthenticatedUsername: (cookie: string | undefined) => string | null | undefined;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function pr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function parseLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 100);
}

export function registerImGroupRoutes(app: Express, opts: ImGroupRouteOptions): void {
  const guard = opts.requirePermission('im.view', 'conversation.view');
  const writeGuard = opts.requirePermission('im.send', 'conversation.send');
  const manageGuard = opts.requirePermission('im.manage_groups');

  app.get('/api/im/conversations/:jid/members', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const members = await listActiveMembers(jid);
      res.json({ ok: true, members });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/conversations/:jid/members', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      await assertRole(jid, userId, 'owner', 'admin');
      const body = req.body as { userIds?: string[] };
      const ids = Array.isArray(body.userIds) ? body.userIds.filter((x) => typeof x === 'string') : [];
      if (ids.length === 0) {
        res.status(400).json({ ok: false, error: 'userIds is required' });
        return;
      }
      await addMembers(jid, ids, 'member');
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.delete('/api/im/conversations/:jid/members/:memberUserId', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      const target = pr(req.params.memberUserId);
      if (target === userId) {
        await removeMember(jid, userId, 'left');
        res.json({ ok: true });
        return;
      }
      await assertRole(jid, userId, 'owner', 'admin');
      await removeMember(jid, target, 'kicked');
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('not found') || msg.includes('inactive')) {
        res.status(404).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.patch('/api/im/conversations/:jid/members/:memberUserId/role', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      const target = pr(req.params.memberUserId);
      await assertRole(jid, userId, 'owner');
      const body = req.body as { role?: ImMembership['role'] };
      const role = body.role;
      if (role === 'owner') {
        res.status(400).json({ ok: false, error: 'Cannot assign owner role via this endpoint' });
        return;
      }
      if (role !== 'admin' && role !== 'member') {
        res.status(400).json({ ok: false, error: 'Invalid role' });
        return;
      }
      const meta = await checkMembership(jid, target);
      if (!meta || meta.status !== 'active') {
        res.status(404).json({ ok: false, error: 'Member not found' });
        return;
      }
      if (meta.role === 'owner') {
        res.status(400).json({ ok: false, error: 'Cannot change the owner role via this endpoint' });
        return;
      }
      await setMemberRole(jid, target, role);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/groups/search', guard, async (_req, res) => {
    try {
      const q = typeof _req.query.q === 'string' ? _req.query.q : '';
      const limit = parseLimit(_req.query.limit, 20);
      const groups = await searchPublicGroups(q, limit);
      res.json({ ok: true, groups });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/groups/:jid/join-request', writeGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      const body = req.body as { message?: string };
      const request = await createImJoinRequest(jid, userId, body.message);
      res.json({ ok: true, request });
    } catch (err) {
      const msg = String(err);
      if (
        msg.includes('not open') ||
        msg.includes('Already a member') ||
        msg.includes('already pending') ||
        msg.includes('not found')
      ) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/groups/:jid/join-requests', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      await assertRole(jid, userId, 'owner', 'admin');
      const requests = await listImJoinRequests(jid);
      res.json({ ok: true, requests });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/im/groups/:jid/join-requests/:id/approve', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      await assertRole(jid, userId, 'owner', 'admin');
      await approveImJoinRequest(jid, pr(req.params.id), userId);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('not found') || msg.includes('not pending')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/im/groups/:jid/join-requests/:id/reject', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = pr(req.params.jid);
      await assertRole(jid, userId, 'owner', 'admin');
      await rejectImJoinRequest(jid, pr(req.params.id), userId);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('not found') || msg.includes('not pending')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });
}
