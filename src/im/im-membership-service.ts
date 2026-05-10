import { dba } from '../db/engine-access.js';
import type { ImMembership } from './im-types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface MemberWithUser extends ImMembership {
  username: string;
  display_name: string | null;
}

export async function checkMembership(
  chatJid: string,
  userId: string,
): Promise<ImMembership | null> {
  const row = (await dba
    .prepare(
      `
    SELECT chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at
    FROM im_memberships
    WHERE chat_jid = ? AND user_id = ?
    LIMIT 1
  `,
    )
    .get(chatJid, userId)) as ImMembership | undefined;
  return row ?? null;
}

export async function isActiveMember(chatJid: string, userId: string): Promise<boolean> {
  const m = await checkMembership(chatJid, userId);
  return Boolean(m && m.status === 'active');
}

export async function listActiveMembers(chatJid: string): Promise<MemberWithUser[]> {
  return (await dba
    .prepare(
      `
    SELECT m.chat_jid, m.user_id, m.role, m.nickname, m.status, m.muted_until, m.joined_at, m.updated_at,
           u.username, u.display_name
    FROM im_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.chat_jid = ? AND m.status = 'active'
    ORDER BY m.joined_at ASC
  `,
    )
    .all(chatJid)) as MemberWithUser[];
}

export async function addMembers(
  chatJid: string,
  userIds: string[],
  role: ImMembership['role'] = 'member',
  skipMaxCheck = false,
): Promise<void> {
  const ts = nowIso();
  const uniq = Array.from(new Set(userIds.filter(Boolean)));
  if (!skipMaxCheck && uniq.length > 0) {
    const meta = (await dba
      .prepare(`SELECT max_members FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
      .get(chatJid)) as { max_members: number } | undefined;
    if (meta) {
      const current = await getMemberCount(chatJid);
      if (current + uniq.length > meta.max_members) {
        throw new Error(`Exceeds max_members limit (${meta.max_members})`);
      }
    }
  }
  for (const uid of uniq) {
    await dba
      .prepare(
        `
      INSERT OR IGNORE INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
      VALUES (?, ?, ?, NULL, 'active', NULL, ?, ?)
    `,
      )
      .run(chatJid, uid, role, ts, ts);
  }
}

export async function removeMember(
  chatJid: string,
  userId: string,
  reason: 'left' | 'kicked',
): Promise<void> {
  const m = await checkMembership(chatJid, userId);
  if (!m || m.status !== 'active') {
    throw new Error('Member not found or already inactive');
  }
  const ts = nowIso();
  await dba
    .prepare(
      `
    UPDATE im_memberships
    SET status = ?, updated_at = ?
    WHERE chat_jid = ? AND user_id = ? AND status = 'active'
  `,
    )
    .run(reason, ts, chatJid, userId);
}

export async function setMemberRole(
  chatJid: string,
  userId: string,
  role: ImMembership['role'],
): Promise<void> {
  const m = await checkMembership(chatJid, userId);
  if (!m || m.status !== 'active') {
    throw new Error('Active member not found');
  }
  const ts = nowIso();
  await dba
    .prepare(
      `
    UPDATE im_memberships
    SET role = ?, updated_at = ?
    WHERE chat_jid = ? AND user_id = ? AND status = 'active'
  `,
    )
    .run(role, ts, chatJid, userId);
}

export async function getMemberCount(chatJid: string): Promise<number> {
  const row = (await dba
    .prepare(
      `SELECT COUNT(*) AS c FROM im_memberships WHERE chat_jid = ? AND status = 'active'`,
    )
    .get(chatJid)) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export async function assertRole(
  chatJid: string,
  userId: string,
  ...roles: ImMembership['role'][]
): Promise<void> {
  const m = await checkMembership(chatJid, userId);
  if (!m || m.status !== 'active') {
    throw new Error('Not a member of this conversation');
  }
  if (!roles.includes(m.role)) {
    throw new Error('Insufficient permissions');
  }
}
