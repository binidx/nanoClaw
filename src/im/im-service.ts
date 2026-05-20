import crypto from 'crypto';

import { dba } from '../db/engine-access.js';
import { eng } from '../db/engine-access.js';
import { buildLikeContainsSql, likeEscapeSql } from '../database/dialect.js';
import {
  IM_USER_ID,
  type ImChatMeta,
  type ImConversationListItem,
  type ImJoinRequest,
} from './im-types.js';
import { escapeImLikePattern } from './im-friend-service.js';
import {
  addMembers,
  checkMembership,
  isActiveMember,
  listActiveMembers,
} from './im-membership-service.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface ImEventRow {
  chat_jid: string;
  seq: number;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function allocateImRoomSeq(chatJid: string): Promise<number> {
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT OR IGNORE INTO im_room_state (chat_jid, last_seq, updated_at) VALUES (?, 0, ?)`,
    )
    .run(chatJid, ts);
  await dba
    .prepare(
      `UPDATE im_room_state SET last_seq = last_seq + 1, updated_at = ? WHERE chat_jid = ?`,
    )
    .run(ts, chatJid);
  const row = (await dba
    .prepare(`SELECT last_seq FROM im_room_state WHERE chat_jid = ? LIMIT 1`)
    .get(chatJid)) as { last_seq: number } | undefined;
  const seq = Number(row?.last_seq ?? 0);
  if (!Number.isFinite(seq) || seq <= 0) {
    throw new Error('Failed to allocate IM room sequence');
  }
  return seq;
}

export async function recordImEventWithSeq(
  chatJid: string,
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt = nowIso(),
): Promise<ImEventRow> {
  const eventId = crypto.randomUUID();
  const normalizedPayload = {
    ...payload,
    type: eventType,
    jid: chatJid,
    room_seq: seq,
    timestamp:
      typeof payload.timestamp === 'string' ? payload.timestamp : createdAt,
  };
  await dba
    .prepare(
      `INSERT INTO im_events (chat_jid, seq, event_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatJid,
      seq,
      eventId,
      eventType,
      JSON.stringify(normalizedPayload),
      createdAt,
    );
  return {
    chat_jid: chatJid,
    seq,
    event_id: eventId,
    event_type: eventType,
    payload: normalizedPayload,
    created_at: createdAt,
  };
}

export async function recordImEvent(
  chatJid: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt = nowIso(),
): Promise<ImEventRow> {
  const seq = await allocateImRoomSeq(chatJid);
  return recordImEventWithSeq(chatJid, seq, eventType, payload, createdAt);
}

export async function listImEventsAfter(
  chatJid: string,
  afterSeq: number,
  limit = 200,
): Promise<ImEventRow[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const rows = (await dba
    .prepare(
      `SELECT chat_jid, seq, event_id, event_type, payload_json, created_at
       FROM im_events
       WHERE chat_jid = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(chatJid, afterSeq, lim)) as Array<{
    chat_jid: string;
    seq: number;
    event_id: string;
    event_type: string;
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object') {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
    return {
      chat_jid: row.chat_jid,
      seq: Number(row.seq),
      event_id: row.event_id,
      event_type: row.event_type,
      payload,
      created_at: row.created_at,
    };
  });
}

export async function getImRoomLastSeq(chatJid: string): Promise<number> {
  const row = (await dba
    .prepare(`SELECT last_seq FROM im_room_state WHERE chat_jid = ? LIMIT 1`)
    .get(chatJid)) as { last_seq: number } | undefined;
  return Number(row?.last_seq ?? 0);
}

function dmPair(
  userId: string,
  targetUserId: string,
): {
  jid: string;
  ownerId: string;
  memberId: string;
} {
  const sorted = [userId, targetUserId].sort((x, y) => x.localeCompare(y));
  const ownerId = sorted[0]!;
  const memberId = sorted[1]!;
  return { jid: `im_dm_${ownerId}_${memberId}`, ownerId, memberId };
}

export async function createDmConversation(
  userId: string,
  targetUserId: string,
): Promise<string> {
  if (userId === targetUserId) {
    throw new Error('Cannot create DM with yourself');
  }
  const { jid, ownerId, memberId } = dmPair(userId, targetUserId);
  const existing = (await dba
    .prepare(`SELECT chat_jid FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
    .get(jid)) as { chat_jid: string } | undefined;
  if (existing) {
    const ts = nowIso();
    await dba
      .prepare(
        `UPDATE im_memberships SET status = 'active', updated_at = ? WHERE chat_jid = ? AND status != 'active'`,
      )
      .run(ts, jid);
    return jid;
  }

  const ts = nowIso();
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `
      INSERT OR IGNORE INTO chats (jid, name, is_group, channel, user_id, last_message_time)
      VALUES (?, NULL, 0, 'web', ?, ?)
    `,
      )
      .run(jid, IM_USER_ID, ts);
    await dba
      .prepare(
        `
      INSERT OR REPLACE INTO im_chat_meta (
        chat_jid, chat_type, visibility, owner_id, name, avatar_url, notice, e2ee_enabled, max_members, created_by, updated_by, deleted_at, created_at, updated_at
      ) VALUES (?, 'dm', 'private', ?, NULL, NULL, NULL, 1, 200, ?, ?, NULL, ?, ?)
    `,
      )
      .run(jid, ownerId, getCurrentUserId(), getCurrentUserId(), ts, ts);
    await addMembers(jid, [ownerId], 'owner', true);
    await addMembers(jid, [memberId], 'member', true);
  });
  await tx();
  return jid;
}

export async function createGroupConversation(
  ownerId: string,
  name: string,
  memberIds: string[],
  visibility: 'private' | 'public' = 'private',
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Group name is required');
  const uniqueMembers = [...new Set(memberIds)].filter(
    (id) => id && id !== ownerId,
  );
  const jid = `im_grp_${crypto.randomUUID()}`;
  const ts = nowIso();
  const all = new Set<string>([ownerId, ...uniqueMembers]);
  all.delete('');
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `
      INSERT OR IGNORE INTO chats (jid, name, is_group, channel, user_id, last_message_time)
      VALUES (?, ?, 1, 'web', ?, ?)
    `,
      )
      .run(jid, trimmed, IM_USER_ID, ts);
    await dba
      .prepare(
        `
      INSERT OR REPLACE INTO im_chat_meta (
        chat_jid, chat_type, visibility, owner_id, name, avatar_url, notice, max_members, created_by, updated_by, deleted_at, created_at, updated_at
      ) VALUES (?, 'group', ?, ?, ?, NULL, NULL, 200, ?, ?, NULL, ?, ?)
    `,
      )
      .run(
        jid,
        visibility,
        ownerId,
        trimmed,
        getCurrentUserId(),
        getCurrentUserId(),
        ts,
        ts,
      );
    if (all.size > 200) throw new Error('Exceeds max_members limit (200)');
    const ids = Array.from(all);
    for (const uid of ids) {
      const role: 'owner' | 'member' = uid === ownerId ? 'owner' : 'member';
      await addMembers(jid, [uid], role, true);
    }
  });
  await tx();
  return jid;
}

export async function getImConversations(
  userId: string,
): Promise<ImConversationListItem[]> {
  return (await dba
    .prepare(
      `
    SELECT
      c.jid AS jid,
      meta.chat_type AS chat_type,
      meta.name AS name,
      meta.visibility AS visibility,
      meta.e2ee_enabled AS e2ee_enabled,
      COALESCE(pref.is_pinned, 0) AS is_pinned,
      COALESCE(pref.is_muted, 0) AS is_muted,
      COALESCE(pref.is_archived, 0) AS is_archived,
      c.last_message_time AS last_message_time,
      (
        SELECT content FROM messages
        WHERE chat_jid = c.jid
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS last_message_content,
      (
        SELECT sender_name FROM messages
        WHERE chat_jid = c.jid
        ORDER BY timestamp DESC
        LIMIT 1
      ) AS last_message_sender,
      (
        SELECT COUNT(*) FROM im_memberships m2
        WHERE m2.chat_jid = c.jid AND m2.status = 'active'
      ) AS member_count,
      (
        SELECT COUNT(*) FROM messages unread_msg
        WHERE unread_msg.chat_jid = c.jid
          AND unread_msg.deleted_at IS NULL
          AND COALESCE(unread_msg.im_seq, 0) > COALESCE((
            SELECT last_read_seq FROM im_read_cursors rc
            WHERE rc.chat_jid = c.jid AND rc.user_id = ?
            LIMIT 1
          ), 0)
          AND unread_msg.sender != ?
      ) AS unread_count
    FROM im_memberships mem
    JOIN im_chat_meta meta ON meta.chat_jid = mem.chat_jid
    JOIN chats c ON c.jid = mem.chat_jid AND c.deleted_at IS NULL
    LEFT JOIN im_conversation_prefs pref ON pref.chat_jid = c.jid AND pref.user_id = mem.user_id
    WHERE mem.user_id = ? AND mem.status = 'active'
    ORDER BY COALESCE(pref.is_pinned, 0) DESC, unread_count DESC, c.last_message_time DESC
  `,
    )
    .all(userId, userId, userId)) as ImConversationListItem[];
}

export async function getImConversationDetail(
  jid: string,
  userId: string,
): Promise<{
  meta: ImChatMeta;
  members: Awaited<ReturnType<typeof listActiveMembers>>;
}> {
  if (!(await isActiveMember(jid, userId))) {
    throw new Error('Not a member of this conversation');
  }
  const meta = (await dba
    .prepare(
      `
    SELECT chat_jid, chat_type, visibility, owner_id, name, avatar_url, notice, e2ee_enabled, max_members, created_at, updated_at
    FROM im_chat_meta
    WHERE chat_jid = ?
    LIMIT 1
  `,
    )
    .get(jid)) as ImChatMeta | undefined;
  if (!meta) throw new Error('Conversation metadata not found');
  const members = await listActiveMembers(jid);
  return { meta, members };
}

export async function updateGroupInfo(
  jid: string,
  updates: {
    name?: string;
    notice?: string | null;
    visibility?: 'private' | 'public';
  },
): Promise<void> {
  const meta = (await dba
    .prepare(`SELECT chat_type FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
    .get(jid)) as { chat_type: string } | undefined;
  if (!meta || meta.chat_type !== 'group') {
    throw new Error('Only group conversations can be updated');
  }
  const fields: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) {
    const n = updates.name.trim();
    if (!n) throw new Error('Name cannot be empty');
    fields.push('name = ?');
    params.push(n);
    await dba
      .prepare(`UPDATE chats SET name = ? WHERE jid = ? AND deleted_at IS NULL`)
      .run(n, jid);
  }
  if (updates.notice !== undefined) {
    fields.push('notice = ?');
    params.push(updates.notice);
  }
  if (updates.visibility !== undefined) {
    fields.push('visibility = ?');
    params.push(updates.visibility);
  }
  if (fields.length === 0) return;
  const ts = nowIso();
  fields.push('updated_at = ?');
  params.push(ts);
  params.push(jid);
  await dba
    .prepare(`UPDATE im_chat_meta SET ${fields.join(', ')} WHERE chat_jid = ?`)
    .run(...params);
}

export async function dissolveGroup(jid: string): Promise<void> {
  const meta = (await dba
    .prepare(`SELECT chat_type FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
    .get(jid)) as { chat_type: string } | undefined;
  if (!meta) return;
  if (meta.chat_type !== 'group') {
    throw new Error('Only group conversations can be dissolved');
  }
  const ts = nowIso();
  const tx = dba.transaction(async () => {
    // Clean satellite tables that reference messages in this chat
    await dba
      .prepare(
        `DELETE FROM im_reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_jid = ?)`,
      )
      .run(jid);
    await dba
      .prepare(
        `DELETE FROM im_message_edits WHERE message_id IN (SELECT id FROM messages WHERE chat_jid = ?)`,
      )
      .run(jid);
    await dba
      .prepare(`DELETE FROM im_read_cursors WHERE chat_jid = ?`)
      .run(jid);
    await dba.prepare(`DELETE FROM im_attachments WHERE chat_jid = ?`).run(jid);
    await dba.prepare(`DELETE FROM messages WHERE chat_jid = ?`).run(jid);
    await dba.prepare(`DELETE FROM im_memberships WHERE chat_jid = ?`).run(jid);
    await dba
      .prepare(`DELETE FROM im_join_requests WHERE chat_jid = ?`)
      .run(jid);
    await dba
      .prepare(
        `UPDATE im_chat_meta SET deleted_at = ?, updated_at = ? WHERE chat_jid = ? AND deleted_at IS NULL`,
      )
      .run(ts, ts, jid);
    await dba
      .prepare(
        `UPDATE chats SET deleted_at = ?, updated_at = ? WHERE jid = ? AND deleted_at IS NULL`,
      )
      .run(ts, ts, jid);
  });
  await tx();
}

export interface ImMessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  client_id: string | null;
  is_from_me: number;
  is_bot_message: number;
  user_id: string | null;
  reply_to_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  im_seq: number | null;
}

const IM_MSG_COLS =
  'id, chat_jid, sender, sender_name, content, timestamp, client_id, is_from_me, is_bot_message, user_id, reply_to_id, edited_at, deleted_at, im_seq';

export async function getImMessages(
  jid: string,
  before?: string,
  limit = 50,
): Promise<ImMessageRow[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  if (before) {
    return (await dba
      .prepare(
        `SELECT ${IM_MSG_COLS} FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(jid, before, lim)) as ImMessageRow[];
  }
  return (await dba
    .prepare(
      `SELECT ${IM_MSG_COLS} FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(jid, lim)) as ImMessageRow[];
}

export async function getImMessageByClientId(
  jid: string,
  senderId: string,
  clientId: string,
): Promise<ImMessageRow | null> {
  const trimmed = clientId.trim();
  if (!trimmed) return null;
  const row = (await dba
    .prepare(
      `SELECT ${IM_MSG_COLS}
       FROM messages
       WHERE chat_jid = ? AND sender = ? AND client_id = ?
       LIMIT 1`,
    )
    .get(jid, senderId, trimmed)) as ImMessageRow | undefined;
  return row ?? null;
}

export interface ImAttachmentRow {
  id: string;
  message_id: string;
  file_name: string;
  mime_type: string;
  size: number;
}

export async function getAttachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, ImAttachmentRow[]>> {
  const result = new Map<string, ImAttachmentRow[]>();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = (await dba
    .prepare(
      `SELECT id, message_id, file_name, mime_type, size FROM im_attachments WHERE message_id IN (${placeholders})`,
    )
    .all(...messageIds)) as ImAttachmentRow[];
  for (const r of rows) {
    const list = result.get(r.message_id) || [];
    list.push(r);
    result.set(r.message_id, list);
  }
  return result;
}

export async function sendImMessage(
  jid: string,
  senderId: string,
  senderName: string,
  content: string,
  clientId?: string,
): Promise<ImMessageRow> {
  if (!(await isActiveMember(jid, senderId))) {
    throw new Error('Not a member of this conversation');
  }
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Message content is empty');
  const id = crypto.randomUUID();
  const ts = nowIso();
  const seq = await allocateImRoomSeq(jid);
  await dba
    .prepare(
      `
    INSERT OR REPLACE INTO messages (
      id, chat_jid, sender, sender_name, content, timestamp, client_id, run_id, is_from_me, is_bot_message, user_id, im_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?, ?)
  `,
    )
    .run(
      id,
      jid,
      senderId,
      senderName,
      trimmed,
      ts,
      clientId?.trim() || null,
      senderId,
      seq,
    );
  await dba
    .prepare(
      `UPDATE chats SET last_message_time = ? WHERE jid = ? AND deleted_at IS NULL`,
    )
    .run(ts, jid);
  const row = (await dba
    .prepare(
      `
    SELECT ${IM_MSG_COLS}
    FROM messages
    WHERE chat_jid = ? AND id = ?
    LIMIT 1
  `,
    )
    .get(jid, id)) as ImMessageRow | undefined;
  if (!row) throw new Error('Failed to read stored message');
  return row;
}

export async function getOtherDmPeer(
  jid: string,
  userId: string,
): Promise<string | null> {
  const meta = (await dba
    .prepare(`SELECT chat_type FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
    .get(jid)) as { chat_type: string } | undefined;
  if (!meta || meta.chat_type !== 'dm') return null;
  const rows = (await dba
    .prepare(
      `
    SELECT user_id FROM im_memberships
    WHERE chat_jid = ? AND status = 'active'
  `,
    )
    .all(jid)) as Array<{ user_id: string }>;
  const others = rows.map((r) => r.user_id).filter((id) => id !== userId);
  return others[0] ?? null;
}

export async function getGroupMetaForAccess(
  jid: string,
): Promise<{ chat_type: string; visibility: string; owner_id: string } | null> {
  const row = (await dba
    .prepare(
      `SELECT chat_type, visibility, owner_id FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`,
    )
    .get(jid)) as
    | { chat_type: string; visibility: string; owner_id: string }
    | undefined;
  return row ?? null;
}

export interface PublicGroupSearchHit {
  chat_jid: string;
  name: string | null;
  visibility: string;
  member_count: number;
}

export async function searchPublicGroups(
  query: string,
  limit = 20,
): Promise<PublicGroupSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const pat = `%${escapeImLikePattern(q)}%`;
  const lim = Math.min(Math.max(limit, 1), 100);
  const nameLikeSql = buildLikeContainsSql(eng().dialect, 'meta.name');
  return (await dba
    .prepare(
      `
    SELECT
      meta.chat_jid AS chat_jid,
      meta.name AS name,
      meta.visibility AS visibility,
      (
        SELECT COUNT(*) FROM im_memberships m2
        WHERE m2.chat_jid = meta.chat_jid AND m2.status = 'active'
      ) AS member_count
    FROM im_chat_meta meta
    WHERE meta.chat_type = 'group'
      AND meta.visibility = 'public'
      AND meta.deleted_at IS NULL
      AND ${nameLikeSql}
    ORDER BY meta.name ASC
    LIMIT ?
  `,
    )
    .all(pat, lim)) as PublicGroupSearchHit[];
}

export async function createImJoinRequest(
  chatJid: string,
  userId: string,
  message?: string,
): Promise<ImJoinRequest> {
  const meta = (await dba
    .prepare(
      `SELECT chat_type, visibility FROM im_chat_meta WHERE chat_jid = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(chatJid)) as { chat_type: string; visibility: string } | undefined;
  if (!meta || meta.chat_type !== 'group') {
    throw new Error('Group not found');
  }
  if (meta.visibility !== 'public') {
    throw new Error('This group is not open for join requests');
  }
  if (await isActiveMember(chatJid, userId)) {
    throw new Error('Already a member');
  }
  const pending = (await dba
    .prepare(
      `
    SELECT id FROM im_join_requests
    WHERE chat_jid = ? AND user_id = ? AND status = 'pending'
    LIMIT 1
  `,
    )
    .get(chatJid, userId)) as { id: string } | undefined;
  if (pending) {
    throw new Error('Join request already pending');
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  await dba
    .prepare(
      `
    INSERT INTO im_join_requests (id, chat_jid, user_id, message, status, handled_by, created_at, resolved_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
  `,
    )
    .run(id, chatJid, userId, message?.trim() || null, ts);
  return {
    id,
    chat_jid: chatJid,
    user_id: userId,
    message: message?.trim() || null,
    status: 'pending',
    handled_by: null,
    created_at: ts,
    resolved_at: null,
  };
}

export async function listImJoinRequests(
  chatJid: string,
): Promise<ImJoinRequest[]> {
  return (await dba
    .prepare(
      `
    SELECT id, chat_jid, user_id, message, status, handled_by, created_at, resolved_at
    FROM im_join_requests
    WHERE chat_jid = ?
    ORDER BY created_at DESC
  `,
    )
    .all(chatJid)) as ImJoinRequest[];
}

export async function approveImJoinRequest(
  chatJid: string,
  requestId: string,
  handlerId: string,
): Promise<void> {
  const row = (await dba
    .prepare(
      `SELECT id, chat_jid, user_id, status FROM im_join_requests WHERE id = ? LIMIT 1`,
    )
    .get(requestId)) as
    | { id: string; chat_jid: string; user_id: string; status: string }
    | undefined;
  if (!row || row.chat_jid !== chatJid)
    throw new Error('Join request not found');
  if (row.status !== 'pending') throw new Error('Join request is not pending');
  const ts = nowIso();
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `
      UPDATE im_join_requests
      SET status = 'approved', handled_by = ?, resolved_at = ?
      WHERE id = ?
    `,
      )
      .run(handlerId, ts, requestId);
    await addMembers(chatJid, [row.user_id], 'member');
  });
  await tx();
}

export async function rejectImJoinRequest(
  chatJid: string,
  requestId: string,
  handlerId: string,
): Promise<void> {
  const row = (await dba
    .prepare(
      `SELECT id, chat_jid, status FROM im_join_requests WHERE id = ? LIMIT 1`,
    )
    .get(requestId)) as
    | { id: string; chat_jid: string; status: string }
    | undefined;
  if (!row || row.chat_jid !== chatJid)
    throw new Error('Join request not found');
  if (row.status !== 'pending') throw new Error('Join request is not pending');
  const ts = nowIso();
  await dba
    .prepare(
      `
    UPDATE im_join_requests
    SET status = 'rejected', handled_by = ?, resolved_at = ?
    WHERE id = ?
  `,
    )
    .run(handlerId, ts, requestId);
}

// ── Enhanced IM features: edit / delete / reactions / read / search ──

export async function editImMessage(
  messageId: string,
  chatJid: string,
  editorId: string,
  newContent: string,
): Promise<string> {
  const row = (await dba
    .prepare(
      `SELECT id, chat_jid, sender, content, deleted_at FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid)) as
    | {
        id: string;
        chat_jid: string;
        sender: string;
        content: string;
        deleted_at: string | null;
      }
    | undefined;
  if (!row) throw new Error('Message not found');
  if (row.deleted_at) throw new Error('Cannot edit deleted message');
  if (row.sender !== editorId) throw new Error('Can only edit own messages');
  const trimmed = newContent.trim();
  if (!trimmed) throw new Error('Content cannot be empty');
  const ts = nowIso();
  const editId = crypto.randomUUID();
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `INSERT INTO im_message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(editId, messageId, row.content, editorId, ts);
    await dba
      .prepare(
        `UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND chat_jid = ?`,
      )
      .run(trimmed, ts, messageId, chatJid);
  });
  await tx();
  return ts;
}

export async function deleteImMessage(
  messageId: string,
  chatJid: string,
  userId: string,
): Promise<string> {
  const row = (await dba
    .prepare(
      `SELECT id, sender, deleted_at FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(messageId, chatJid)) as
    | { id: string; sender: string; deleted_at: string | null }
    | undefined;
  if (!row) throw new Error('Message not found');
  if (row.deleted_at) throw new Error('Message already deleted');
  if (row.sender !== userId) throw new Error('Can only delete own messages');
  const ts = nowIso();
  await dba
    .prepare(`UPDATE messages SET deleted_at = ? WHERE id = ? AND chat_jid = ?`)
    .run(ts, messageId, chatJid);
  return ts;
}

export async function addImReaction(
  messageId: string,
  chatJid: string,
  userId: string,
  emoji: string,
): Promise<void> {
  const msg = (await dba
    .prepare(
      `SELECT id FROM messages WHERE id = ? AND chat_jid = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(messageId, chatJid)) as { id: string } | undefined;
  if (!msg) throw new Error('Message not found');
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT OR IGNORE INTO im_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(messageId, userId, emoji, ts);
}

export async function removeImReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM im_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
    )
    .run(messageId, userId, emoji);
}

export interface ImReactionGroup {
  emoji: string;
  count: number;
  users: string[];
}

export async function getReactionsForMessages(
  messageIds: string[],
): Promise<Map<string, ImReactionGroup[]>> {
  const result = new Map<string, ImReactionGroup[]>();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = (await dba
    .prepare(
      `SELECT message_id, user_id, emoji FROM im_reactions WHERE message_id IN (${placeholders}) ORDER BY created_at`,
    )
    .all(...messageIds)) as Array<{
    message_id: string;
    user_id: string;
    emoji: string;
  }>;
  for (const r of rows) {
    const groups = result.get(r.message_id) || [];
    let group = groups.find((g) => g.emoji === r.emoji);
    if (!group) {
      group = { emoji: r.emoji, count: 0, users: [] };
      groups.push(group);
    }
    group.count++;
    group.users.push(r.user_id);
    result.set(r.message_id, groups);
  }
  return result;
}

export async function updateImReadCursor(
  chatJid: string,
  userId: string,
  messageId: string,
): Promise<{ last_read_at: string; last_read_seq: number | null }> {
  const ts = nowIso();
  const row = (await dba
    .prepare(
      `SELECT im_seq FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1`,
    )
    .get(chatJid, messageId)) as { im_seq: number | null } | undefined;
  const lastReadSeq =
    typeof row?.im_seq === 'number' && Number.isFinite(row.im_seq)
      ? row.im_seq
      : null;
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_read_cursors (chat_jid, user_id, last_read_message_id, last_read_seq, last_read_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(chatJid, userId, messageId, lastReadSeq, ts);
  return { last_read_at: ts, last_read_seq: lastReadSeq };
}

export interface ImReadCursor {
  user_id: string;
  last_read_message_id: string | null;
  last_read_seq: number | null;
  last_read_at: string;
}

export async function getImReadCursors(
  chatJid: string,
): Promise<ImReadCursor[]> {
  return (await dba
    .prepare(
      `SELECT user_id, last_read_message_id, last_read_seq, last_read_at FROM im_read_cursors WHERE chat_jid = ?`,
    )
    .all(chatJid)) as ImReadCursor[];
}

export async function searchImMessages(
  query: string,
  chatJid?: string,
  before?: string,
  limit = 50,
  userId?: string,
): Promise<ImMessageRow[]> {
  const q = query.trim();
  if (!q) return [];
  const pat = `%${escapeImLikePattern(q)}%`;
  const lim = Math.min(Math.max(limit, 1), 200);
  const dialect = eng().dialect;
  const contentLikeSql = buildLikeContainsSql(dialect, 'content');
  if (chatJid) {
    if (before) {
      return (await dba
        .prepare(
          `SELECT ${IM_MSG_COLS} FROM messages
         WHERE chat_jid = ?
           AND chat_jid NOT IN (SELECT chat_jid FROM im_chat_meta WHERE e2ee_enabled = 1)
           AND ${contentLikeSql}
           AND deleted_at IS NULL
           AND timestamp < ?
         ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(chatJid, pat, before, lim)) as ImMessageRow[];
    }
    return (await dba
      .prepare(
        `SELECT ${IM_MSG_COLS} FROM messages
       WHERE chat_jid = ?
         AND chat_jid NOT IN (SELECT chat_jid FROM im_chat_meta WHERE e2ee_enabled = 1)
         AND ${contentLikeSql}
         AND deleted_at IS NULL
       ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(chatJid, pat, lim)) as ImMessageRow[];
  }
  const memberScope = userId
    ? `AND chat_jid IN (SELECT chat_jid FROM im_memberships WHERE user_id = ? AND status = 'active')`
    : `AND chat_jid LIKE 'im\\_%' ${likeEscapeSql(dialect)}`;
  const params: unknown[] = userId ? [pat, userId] : [pat];
  if (before) {
    return (await dba
      .prepare(
        `SELECT ${IM_MSG_COLS} FROM messages
       WHERE ${contentLikeSql}
         AND deleted_at IS NULL
         AND chat_jid NOT IN (SELECT chat_jid FROM im_chat_meta WHERE e2ee_enabled = 1)
         ${memberScope}
         AND timestamp < ?
       ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(...params, before, lim)) as ImMessageRow[];
  }
  return (await dba
    .prepare(
      `SELECT ${IM_MSG_COLS} FROM messages
     WHERE ${contentLikeSql}
       AND deleted_at IS NULL
       AND chat_jid NOT IN (SELECT chat_jid FROM im_chat_meta WHERE e2ee_enabled = 1)
       ${memberScope}
     ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...params, lim)) as ImMessageRow[];
}

export async function sendImMessageWithReply(
  jid: string,
  senderId: string,
  senderName: string,
  content: string,
  replyToId?: string,
  clientId?: string,
): Promise<ImMessageRow> {
  if (!(await isActiveMember(jid, senderId))) {
    throw new Error('Not a member of this conversation');
  }
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Message content is empty');
  if (replyToId) {
    const parent = (await dba
      .prepare(
        `SELECT id FROM messages WHERE id = ? AND chat_jid = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(replyToId, jid)) as { id: string } | undefined;
    if (!parent) replyToId = undefined;
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  const seq = await allocateImRoomSeq(jid);
  await dba
    .prepare(
      `INSERT OR REPLACE INTO messages (
        id, chat_jid, sender, sender_name, content, timestamp, client_id, run_id, is_from_me, is_bot_message, user_id, reply_to_id, im_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, 0, ?, ?, ?)`,
    )
    .run(
      id,
      jid,
      senderId,
      senderName,
      trimmed,
      ts,
      clientId?.trim() || null,
      senderId,
      replyToId || null,
      seq,
    );
  await dba
    .prepare(
      `UPDATE chats SET last_message_time = ? WHERE jid = ? AND deleted_at IS NULL`,
    )
    .run(ts, jid);
  const row = (await dba
    .prepare(
      `SELECT ${IM_MSG_COLS} FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1`,
    )
    .get(jid, id)) as ImMessageRow | undefined;
  if (!row) throw new Error('Failed to read stored message');
  return row;
}

export async function sendImAiMessage(input: {
  jid: string;
  assistantId: string;
  displayName: string;
  content: string;
  replyToId?: string | null;
  runId?: string | null;
}): Promise<ImMessageRow> {
  const trimmed = input.content.trim();
  if (!trimmed) throw new Error('Message content is empty');
  let replyToId = input.replyToId?.trim() || null;
  if (replyToId) {
    const parent = (await dba
      .prepare(
        `SELECT id FROM messages WHERE id = ? AND chat_jid = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(replyToId, input.jid)) as { id: string } | undefined;
    if (!parent) replyToId = null;
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  const seq = await allocateImRoomSeq(input.jid);
  await dba
    .prepare(
      `INSERT OR REPLACE INTO messages (
        id, chat_jid, sender, sender_name, content, timestamp, client_id, run_id, is_from_me, is_bot_message, user_id, reply_to_id, im_seq
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 1, NULL, ?, ?)`,
    )
    .run(
      id,
      input.jid,
      input.assistantId,
      input.displayName,
      trimmed,
      ts,
      input.runId ?? null,
      replyToId,
      seq,
    );
  await dba
    .prepare(
      `UPDATE chats SET last_message_time = ? WHERE jid = ? AND deleted_at IS NULL`,
    )
    .run(ts, input.jid);
  const row = (await dba
    .prepare(
      `SELECT ${IM_MSG_COLS} FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1`,
    )
    .get(input.jid, id)) as ImMessageRow | undefined;
  if (!row) throw new Error('Failed to read stored AI message');
  return row;
}
