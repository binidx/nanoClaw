import crypto from 'crypto';

import { dba } from '../db/engine-access.js';
import { eng } from '../db/engine-access.js';
import { buildLikeContainsSql } from '../database/dialect.js';
import type { FriendRequest } from './im-types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function escapeImLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface UserSearchHit {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  status: string;
}

export interface FriendWithUser {
  friend_id: string;
  username: string;
  display_name: string | null;
  remark: string | null;
  created_at: string;
}

export interface FriendRequestWithSender extends FriendRequest {
  sender_username: string;
  sender_display_name: string | null;
}

export async function searchUsers(
  query: string,
  currentUserId: string,
  limit = 20,
): Promise<UserSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const pat = `%${escapeImLikePattern(q)}%`;
  const likeUsernameSql = buildLikeContainsSql(eng().dialect, 'username');
  const likeDisplayNameSql = buildLikeContainsSql(eng().dialect, 'display_name');
  const rows = (await dba
    .prepare(
      `
    SELECT id, username, display_name, email, status
    FROM users
    WHERE id != ?
      AND status = 'active'
      AND deleted_at IS NULL
      AND (${likeUsernameSql} OR ${likeDisplayNameSql})
    ORDER BY username ASC
    LIMIT ?
  `,
    )
    .all(currentUserId, pat, pat, Math.min(Math.max(limit, 1), 100))) as UserSearchHit[];
  return rows;
}

export async function getFriends(userId: string): Promise<FriendWithUser[]> {
  return (await dba
    .prepare(
      `
    SELECT uf.friend_id, u.username, u.display_name, uf.remark, uf.created_at
    FROM user_friends uf
    JOIN users u ON u.id = uf.friend_id AND u.deleted_at IS NULL
    WHERE uf.user_id = ? AND uf.deleted_at IS NULL
    ORDER BY u.username ASC
  `,
    )
    .all(userId)) as FriendWithUser[];
}

export async function isFriend(userId: string, targetId: string): Promise<boolean> {
  if (userId === targetId) return false;
  const row = (await dba
    .prepare(
      `SELECT 1 AS ok FROM user_friends WHERE user_id = ? AND friend_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(userId, targetId)) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

export async function sendFriendRequest(
  fromUserId: string,
  toUserId: string,
  message?: string,
): Promise<FriendRequest> {
  if (fromUserId === toUserId) {
    throw new Error('Cannot send friend request to yourself');
  }
  const target = (await dba
    .prepare(`SELECT id, status FROM users WHERE id = ? LIMIT 1`)
    .get(toUserId)) as { id: string; status: string } | undefined;
  if (!target || target.status !== 'active') {
    throw new Error('Target user not found');
  }
  if (await isFriend(fromUserId, toUserId)) {
    throw new Error('Already friends');
  }
  const pending = (await dba
    .prepare(
      `
    SELECT id FROM friend_requests
    WHERE status = 'pending'
      AND (
        (from_user_id = ? AND to_user_id = ?)
        OR (from_user_id = ? AND to_user_id = ?)
      )
    LIMIT 1
  `,
    )
    .get(fromUserId, toUserId, toUserId, fromUserId)) as { id: string } | undefined;
  if (pending) {
    throw new Error('A pending friend request already exists');
  }
  const id = crypto.randomUUID();
  const created = nowIso();
  await dba
    .prepare(
      `
    INSERT INTO friend_requests (id, from_user_id, to_user_id, message, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, 'pending', ?, NULL)
  `,
    )
    .run(id, fromUserId, toUserId, message?.trim() || null, created);
  return {
    id,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    message: message?.trim() || null,
    status: 'pending',
    created_at: created,
    resolved_at: null,
  };
}

export async function getPendingFriendRequests(
  userId: string,
): Promise<FriendRequestWithSender[]> {
  return (await dba
    .prepare(
      `
    SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.message, fr.status, fr.created_at, fr.resolved_at,
           u.username AS sender_username, u.display_name AS sender_display_name
    FROM friend_requests fr
    JOIN users u ON u.id = fr.from_user_id
    WHERE fr.to_user_id = ? AND fr.status = 'pending'
    ORDER BY fr.created_at DESC
  `,
    )
    .all(userId)) as FriendRequestWithSender[];
}

export interface SentFriendRequestWithTarget extends FriendRequest {
  to_username: string;
  to_display_name: string | null;
}

export async function getSentFriendRequests(userId: string): Promise<SentFriendRequestWithTarget[]> {
  return (await dba
    .prepare(
      `
    SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.message, fr.status, fr.created_at, fr.resolved_at,
           u.username AS to_username, u.display_name AS to_display_name
    FROM friend_requests fr
    JOIN users u ON u.id = fr.to_user_id
    WHERE fr.from_user_id = ?
    ORDER BY fr.created_at DESC
  `,
    )
    .all(userId)) as SentFriendRequestWithTarget[];
}

export async function acceptFriendRequest(
  requestId: string,
  userId: string,
): Promise<void> {
  const req = (await dba
    .prepare(
      `SELECT id, from_user_id, to_user_id, status FROM friend_requests WHERE id = ? LIMIT 1`,
    )
    .get(requestId)) as
    | {
        id: string;
        from_user_id: string;
        to_user_id: string;
        status: string;
      }
    | undefined;
  if (!req) throw new Error('Friend request not found');
  if (req.to_user_id !== userId) throw new Error('Not authorized to accept this request');
  if (req.status !== 'pending') throw new Error('Friend request is not pending');
  const resolved = nowIso();
  const tx = dba.transaction(async () => {
    const result = await dba
      .prepare(
        `UPDATE friend_requests SET status = 'accepted', resolved_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(resolved, requestId);
    const affected = (result as { changes?: number }).changes ?? 1;
    if (affected === 0) throw new Error('Friend request is not pending or already resolved');
    await dba
      .prepare(
        `UPDATE user_friends SET deleted_at = NULL WHERE user_id = ? AND friend_id = ?`,
      )
      .run(req.from_user_id, req.to_user_id);
    await dba
      .prepare(
        `UPDATE user_friends SET deleted_at = NULL WHERE user_id = ? AND friend_id = ?`,
      )
      .run(req.to_user_id, req.from_user_id);
    await dba
      .prepare(
        `
      INSERT OR IGNORE INTO user_friends (user_id, friend_id, remark, created_at)
      VALUES (?, ?, NULL, ?)
    `,
      )
      .run(req.from_user_id, req.to_user_id, resolved);
    await dba
      .prepare(
        `
      INSERT OR IGNORE INTO user_friends (user_id, friend_id, remark, created_at)
      VALUES (?, ?, NULL, ?)
    `,
      )
      .run(req.to_user_id, req.from_user_id, resolved);
  });
  await tx();
}

export async function rejectFriendRequest(
  requestId: string,
  userId: string,
): Promise<void> {
  const req = (await dba
    .prepare(`SELECT id, to_user_id, status FROM friend_requests WHERE id = ? LIMIT 1`)
    .get(requestId)) as
    | { id: string; to_user_id: string; status: string }
    | undefined;
  if (!req) throw new Error('Friend request not found');
  if (req.to_user_id !== userId) throw new Error('Not authorized to reject this request');
  if (req.status !== 'pending') throw new Error('Friend request is not pending');
  const resolved = nowIso();
  await dba
    .prepare(
      `UPDATE friend_requests SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    )
    .run(resolved, requestId);
}

export async function removeFriend(userId: string, friendId: string): Promise<void> {
  const ts = nowIso();
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `UPDATE user_friends SET deleted_at = ? WHERE user_id = ? AND friend_id = ? AND deleted_at IS NULL`,
      )
      .run(ts, userId, friendId);
    await dba
      .prepare(
        `UPDATE user_friends SET deleted_at = ? WHERE user_id = ? AND friend_id = ? AND deleted_at IS NULL`,
      )
      .run(ts, friendId, userId);
  });
  await tx();
}
