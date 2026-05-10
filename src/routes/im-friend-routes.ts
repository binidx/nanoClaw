import type { Express } from 'express';

import {
  acceptFriendRequest,
  getFriends,
  getPendingFriendRequests,
  getSentFriendRequests,
  isFriend,
  rejectFriendRequest,
  removeFriend,
  searchUsers,
  sendFriendRequest,
} from '../im/im-friend-service.js';
import { getTenantUserId } from '../tenant/tenant-request.js';

export interface ImFriendRouteOptions {
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

export function registerImFriendRoutes(
  app: Express,
  opts: ImFriendRouteOptions,
): void {
  const guard = opts.requirePermission('im.view', 'conversation.view');

  app.get('/api/im/users/search', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const limit = parseLimit(req.query.limit, 20);
      const users = await searchUsers(q, userId, limit);
      res.json({ ok: true, users });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/friends', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const friends = await getFriends(userId);
      res.json({ ok: true, friends });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/friends/check', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const target = typeof req.query.targetUserId === 'string' ? req.query.targetUserId : '';
      if (!target) {
        res.status(400).json({ ok: false, error: 'targetUserId is required' });
        return;
      }
      const friend = await isFriend(userId, target);
      res.json({ ok: true, isFriend: friend });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/friends/requests', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { toUserId?: string; message?: string };
      const toUserId = typeof body.toUserId === 'string' ? body.toUserId.trim() : '';
      if (!toUserId) {
        res.status(400).json({ ok: false, error: 'toUserId is required' });
        return;
      }
      const request = await sendFriendRequest(userId, toUserId, body.message);
      res.json({ ok: true, request });
    } catch (err) {
      const msg = String(err);
      if (
        msg.includes('Already friends') ||
        msg.includes('pending') ||
        msg.includes('Cannot send') ||
        msg.includes('not found')
      ) {
        res.status(409).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/friends/requests', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const [received, sent] = await Promise.all([
        getPendingFriendRequests(userId),
        getSentFriendRequests(userId),
      ]);
      res.json({ ok: true, received, sent });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/friends/requests/pending', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const requests = await getPendingFriendRequests(userId);
      res.json({ ok: true, requests });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/friends/requests/sent', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const requests = await getSentFriendRequests(userId);
      res.json({ ok: true, requests });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/friends/requests/:id/accept', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      await acceptFriendRequest(pr(req.params.id), userId);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found') || msg.includes('Not authorized') || msg.includes('not pending')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/im/friends/requests/:id/reject', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      await rejectFriendRequest(pr(req.params.id), userId);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found') || msg.includes('Not authorized') || msg.includes('not pending')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.delete('/api/im/friends/:friendId', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      await removeFriend(userId, pr(req.params.friendId));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
