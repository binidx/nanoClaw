import crypto from 'crypto';

import { dba } from '../db/engine-access.js';
import { listActiveMembers } from './im-membership-service.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface ImConversationPrefs {
  chat_jid: string;
  user_id: string;
  is_pinned: number;
  is_muted: number;
  is_archived: number;
  draft_text: string | null;
  updated_at: string;
}

export async function getConversationPrefs(
  chatJid: string,
  userId: string,
): Promise<ImConversationPrefs> {
  const row = (await dba
    .prepare(
      `SELECT chat_jid, user_id, is_pinned, is_muted, is_archived, draft_text, updated_at
       FROM im_conversation_prefs
       WHERE chat_jid = ? AND user_id = ?
       LIMIT 1`,
    )
    .get(chatJid, userId)) as ImConversationPrefs | undefined;
  return (
    row ?? {
      chat_jid: chatJid,
      user_id: userId,
      is_pinned: 0,
      is_muted: 0,
      is_archived: 0,
      draft_text: null,
      updated_at: nowIso(),
    }
  );
}

export async function upsertConversationPrefs(
  chatJid: string,
  userId: string,
  patch: Partial<
    Pick<
      ImConversationPrefs,
      'is_pinned' | 'is_muted' | 'is_archived' | 'draft_text'
    >
  >,
): Promise<ImConversationPrefs> {
  const current = await getConversationPrefs(chatJid, userId);
  const next: ImConversationPrefs = {
    ...current,
    is_pinned: patch.is_pinned ?? current.is_pinned,
    is_muted: patch.is_muted ?? current.is_muted,
    is_archived: patch.is_archived ?? current.is_archived,
    draft_text:
      patch.draft_text !== undefined ? patch.draft_text : current.draft_text,
    updated_at: nowIso(),
  };
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_conversation_prefs
       (chat_jid, user_id, is_pinned, is_muted, is_archived, draft_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      next.chat_jid,
      next.user_id,
      next.is_pinned,
      next.is_muted,
      next.is_archived,
      next.draft_text,
      next.updated_at,
    );
  return next;
}

export interface ImNotification {
  id: string;
  user_id: string;
  chat_jid: string | null;
  event_type: string;
  actor_id: string | null;
  message_id: string | null;
  title: string | null;
  body: string | null;
  is_read: number;
  created_at: string;
}

export async function createImNotification(input: {
  userId: string;
  chatJid?: string | null;
  eventType: string;
  actorId?: string | null;
  messageId?: string | null;
  title?: string | null;
  body?: string | null;
}): Promise<ImNotification> {
  const row: ImNotification = {
    id: crypto.randomUUID(),
    user_id: input.userId,
    chat_jid: input.chatJid ?? null,
    event_type: input.eventType,
    actor_id: input.actorId ?? null,
    message_id: input.messageId ?? null,
    title: input.title ?? null,
    body: input.body ?? null,
    is_read: 0,
    created_at: nowIso(),
  };
  await dba
    .prepare(
      `INSERT INTO im_notifications
       (id, user_id, chat_jid, event_type, actor_id, message_id, title, body, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.user_id,
      row.chat_jid,
      row.event_type,
      row.actor_id,
      row.message_id,
      row.title,
      row.body,
      row.is_read,
      row.created_at,
    );
  return row;
}

export async function listImNotifications(
  userId: string,
  limit = 50,
): Promise<ImNotification[]> {
  const lim = Math.min(Math.max(limit, 1), 100);
  return (await dba
    .prepare(
      `SELECT id, user_id, chat_jid, event_type, actor_id, message_id, title, body, is_read, created_at
       FROM im_notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(userId, lim)) as ImNotification[];
}

export async function countUnreadImNotifications(
  userId: string,
): Promise<number> {
  const row = (await dba
    .prepare(
      `SELECT COUNT(*) AS count FROM im_notifications WHERE user_id = ? AND is_read = 0`,
    )
    .get(userId)) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export async function markImNotificationsRead(
  userId: string,
  ids: string[],
): Promise<void> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) {
    await dba
      .prepare(
        `UPDATE im_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
      )
      .run(userId);
    return;
  }
  const placeholders = uniqueIds.map(() => '?').join(',');
  await dba
    .prepare(
      `UPDATE im_notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .run(userId, ...uniqueIds);
}

export async function recordMentionsForMessage(
  chatJid: string,
  messageId: string,
  content: string,
  actorId: string,
): Promise<string[]> {
  const members = await listActiveMembers(chatJid);
  const mentioned = members.filter((member) => {
    if (member.user_id === actorId) return false;
    const labels = [member.username, member.display_name, member.nickname]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().toLowerCase());
    const lower = content.toLowerCase();
    return labels.some((label) => lower.includes(`@${label}`));
  });
  const ts = nowIso();
  for (const member of mentioned) {
    await dba
      .prepare(
        `INSERT OR IGNORE INTO im_mentions (chat_jid, message_id, mentioned_user_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(chatJid, messageId, member.user_id, ts);
    await createImNotification({
      userId: member.user_id,
      chatJid,
      eventType: 'mention',
      actorId,
      messageId,
      title: 'Mention',
      body: content.slice(0, 200),
    });
  }
  return mentioned.map((member) => member.user_id);
}

export async function blockImUser(
  userId: string,
  blockedUserId: string,
): Promise<void> {
  if (userId === blockedUserId) throw new Error('Cannot block yourself');
  await dba
    .prepare(
      `INSERT OR IGNORE INTO im_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(userId, blockedUserId, nowIso());
}

export async function unblockImUser(
  userId: string,
  blockedUserId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM im_blocks WHERE user_id = ? AND blocked_user_id = ?`)
    .run(userId, blockedUserId);
}

export async function isImBlockedEither(
  userA: string,
  userB: string,
): Promise<boolean> {
  const row = (await dba
    .prepare(
      `SELECT 1 AS ok FROM im_blocks
       WHERE (user_id = ? AND blocked_user_id = ?)
          OR (user_id = ? AND blocked_user_id = ?)
       LIMIT 1`,
    )
    .get(userA, userB, userB, userA)) as { ok: number } | undefined;
  return Boolean(row);
}

export async function createImReport(input: {
  reporterId: string;
  chatJid?: string | null;
  messageId?: string | null;
  targetUserId?: string | null;
  reason: string;
  details?: string | null;
}): Promise<{ id: string; created_at: string }> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT INTO im_reports
       (id, reporter_id, chat_jid, message_id, target_user_id, reason, details, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
    )
    .run(
      id,
      input.reporterId,
      input.chatJid ?? null,
      input.messageId ?? null,
      input.targetUserId ?? null,
      input.reason,
      input.details ?? null,
      ts,
    );
  return { id, created_at: ts };
}

export async function pinImMessage(
  chatJid: string,
  messageId: string,
  userId: string,
): Promise<{ pinned_at: string }> {
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_pinned_messages (chat_jid, message_id, pinned_by, pinned_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(chatJid, messageId, userId, ts);
  return { pinned_at: ts };
}

export async function unpinImMessage(
  chatJid: string,
  messageId: string,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM im_pinned_messages WHERE chat_jid = ? AND message_id = ?`,
    )
    .run(chatJid, messageId);
}

export async function listPinnedImMessages(
  chatJid: string,
): Promise<
  Array<{ message_id: string; pinned_by: string; pinned_at: string }>
> {
  return (await dba
    .prepare(
      `SELECT message_id, pinned_by, pinned_at
       FROM im_pinned_messages
       WHERE chat_jid = ?
       ORDER BY pinned_at DESC`,
    )
    .all(chatJid)) as Array<{
    message_id: string;
    pinned_by: string;
    pinned_at: string;
  }>;
}

export async function upsertDeviceKey(
  userId: string,
  deviceId: string,
  publicKey: string,
): Promise<void> {
  const ts = nowIso();
  const existing = (await dba
    .prepare(
      `SELECT created_at FROM im_device_keys WHERE user_id = ? AND device_id = ? LIMIT 1`,
    )
    .get(userId, deviceId)) as { created_at: string } | undefined;
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_device_keys (user_id, device_id, public_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, deviceId, publicKey, existing?.created_at ?? ts, ts);
}

export async function listDeviceKeys(userIds: string[]): Promise<
  Array<{
    user_id: string;
    device_id: string;
    public_key: string;
    updated_at: string;
  }>
> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return (await dba
    .prepare(
      `SELECT user_id, device_id, public_key, updated_at
       FROM im_device_keys
       WHERE user_id IN (${placeholders})
       ORDER BY updated_at DESC`,
    )
    .all(...ids)) as Array<{
    user_id: string;
    device_id: string;
    public_key: string;
    updated_at: string;
  }>;
}

export async function setRoomEncryption(
  chatJid: string,
  enabled: boolean,
): Promise<void> {
  const ts = nowIso();
  const tx = dba.transaction(async () => {
    await dba
      .prepare(
        `UPDATE im_chat_meta SET e2ee_enabled = ?, updated_at = ? WHERE chat_jid = ?`,
      )
      .run(enabled ? 1 : 0, ts, chatJid);
    if (enabled) {
      await dba
        .prepare(
          `UPDATE im_ai_members SET status = 'removed' WHERE chat_jid = ? AND status = 'active'`,
        )
        .run(chatJid);
      await dba
        .prepare(
          `UPDATE im_ai_invocations
           SET status = 'failed', completed_at = ?, error_message = 'Encrypted rooms cannot invoke AI'
           WHERE chat_jid = ? AND status IN ('queued', 'running')`,
        )
        .run(ts, chatJid);
    }
  });
  await tx();
}

export async function isRoomEncrypted(chatJid: string): Promise<boolean> {
  const row = (await dba
    .prepare(`SELECT e2ee_enabled FROM im_chat_meta WHERE chat_jid = ? LIMIT 1`)
    .get(chatJid)) as { e2ee_enabled: number } | undefined;
  return Number(row?.e2ee_enabled ?? 0) === 1;
}

export async function saveEncryptedMessageEnvelope(input: {
  chatJid: string;
  messageId: string;
  version: number;
  algorithm: string;
  iv: string;
  aad?: string | null;
  ciphertext: string;
}): Promise<void> {
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_message_crypto
       (chat_jid, message_id, version, algorithm, iv, aad, ciphertext, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatJid,
      input.messageId,
      input.version,
      input.algorithm,
      input.iv,
      input.aad ?? null,
      input.ciphertext,
      nowIso(),
    );
}

export interface EncryptedMessageEnvelope {
  version: number;
  algorithm: string;
  iv: string;
  aad: string | null;
  ciphertext: string;
}

export async function getEncryptedEnvelopesForMessages(
  messageIds: string[],
): Promise<Map<string, EncryptedMessageEnvelope>> {
  const ids = [...new Set(messageIds.filter(Boolean))];
  const result = new Map<string, EncryptedMessageEnvelope>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = (await dba
    .prepare(
      `SELECT message_id, version, algorithm, iv, aad, ciphertext
       FROM im_message_crypto
       WHERE message_id IN (${placeholders})`,
    )
    .all(...ids)) as Array<{
    message_id: string;
    version: number;
    algorithm: string;
    iv: string;
    aad: string | null;
    ciphertext: string;
  }>;
  for (const row of rows) {
    result.set(row.message_id, {
      version: Number(row.version),
      algorithm: row.algorithm,
      iv: row.iv,
      aad: row.aad,
      ciphertext: row.ciphertext,
    });
  }
  return result;
}

export interface ImRoomKeyRow {
  chat_jid: string;
  user_id: string;
  device_id: string;
  wrapped_key: string;
  algorithm: string;
  created_at: string;
}

export async function listRoomKeysForDevice(
  chatJid: string,
  userId: string,
  deviceId?: string,
): Promise<ImRoomKeyRow[]> {
  if (deviceId?.trim()) {
    return (await dba
      .prepare(
        `SELECT chat_jid, user_id, device_id, wrapped_key, algorithm, created_at
         FROM im_room_keys
         WHERE chat_jid = ? AND user_id = ? AND device_id = ?
         ORDER BY created_at ASC`,
      )
      .all(chatJid, userId, deviceId.trim())) as ImRoomKeyRow[];
  }
  return (await dba
    .prepare(
      `SELECT chat_jid, user_id, device_id, wrapped_key, algorithm, created_at
       FROM im_room_keys
       WHERE chat_jid = ? AND user_id = ?
       ORDER BY created_at ASC`,
    )
    .all(chatJid, userId)) as ImRoomKeyRow[];
}

export async function upsertRoomKeys(
  chatJid: string,
  rows: Array<{
    userId: string;
    deviceId: string;
    wrappedKey: string;
    algorithm: string;
  }>,
): Promise<void> {
  const ts = nowIso();
  const tx = dba.transaction(async () => {
    for (const row of rows) {
      const userId = row.userId.trim();
      const deviceId = row.deviceId.trim();
      const wrappedKey = row.wrappedKey.trim();
      const algorithm = row.algorithm.trim() || 'ECDH-P256+HKDF-SHA256+A256GCM';
      if (!userId || !deviceId || !wrappedKey) {
        throw new Error('Invalid room key row');
      }
      const targetDeviceId = deviceId.slice(0, 128);
      const targetDevice = (await dba
        .prepare(
          `SELECT 1 FROM im_device_keys WHERE user_id = ? AND device_id = ? LIMIT 1`,
        )
        .get(userId, targetDeviceId)) as { 1?: number } | undefined;
      if (!targetDevice) {
        throw new Error(
          'Room key target device does not belong to target user',
        );
      }
      await dba
        .prepare(
          `INSERT OR REPLACE INTO im_room_keys
           (chat_jid, user_id, device_id, wrapped_key, algorithm, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chatJid,
          userId,
          targetDeviceId,
          wrappedKey,
          algorithm.slice(0, 128),
          ts,
        );
    }
  });
  await tx();
}

export async function createImCall(input: {
  chatJid: string;
  createdBy: string;
  callType: 'audio' | 'video';
}): Promise<{ id: string; status: string; created_at: string }> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT INTO im_calls (id, chat_jid, created_by, call_type, status, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, 'ringing', NULL, NULL, ?)`,
    )
    .run(id, input.chatJid, input.createdBy, input.callType, ts);
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_call_participants (call_id, user_id, status, joined_at, left_at)
       VALUES (?, ?, 'joined', ?, NULL)`,
    )
    .run(id, input.createdBy, ts);
  return { id, status: 'ringing', created_at: ts };
}

export async function updateImCallParticipant(
  callId: string,
  userId: string,
  status: 'joined' | 'left' | 'declined',
): Promise<void> {
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_call_participants (call_id, user_id, status, joined_at, left_at)
       VALUES (?, ?, ?, CASE WHEN ? = 'joined' THEN ? ELSE NULL END, CASE WHEN ? != 'joined' THEN ? ELSE NULL END)`,
    )
    .run(callId, userId, status, status, ts, status, ts);
}

export async function endImCall(callId: string): Promise<void> {
  await dba
    .prepare(`UPDATE im_calls SET status = 'ended', ended_at = ? WHERE id = ?`)
    .run(nowIso(), callId);
}

export async function getImCall(callId: string): Promise<{
  id: string;
  chat_jid: string;
  created_by: string;
  call_type: 'audio' | 'video';
  status: string;
  created_at: string;
} | null> {
  const row = (await dba
    .prepare(
      `SELECT id, chat_jid, created_by, call_type, status, created_at
       FROM im_calls
       WHERE id = ?
       LIMIT 1`,
    )
    .get(callId)) as
    | {
        id: string;
        chat_jid: string;
        created_by: string;
        call_type: 'audio' | 'video';
        status: string;
        created_at: string;
      }
    | undefined;
  return row ?? null;
}

export async function listActiveImCalls(chatJid: string): Promise<
  Array<{
    id: string;
    created_by: string;
    call_type: 'audio' | 'video';
    status: string;
    created_at: string;
  }>
> {
  return (await dba
    .prepare(
      `SELECT id, created_by, call_type, status, created_at
       FROM im_calls
       WHERE chat_jid = ? AND status != 'ended'
       ORDER BY created_at DESC`,
    )
    .all(chatJid)) as Array<{
    id: string;
    created_by: string;
    call_type: 'audio' | 'video';
    status: string;
    created_at: string;
  }>;
}

export async function addAiMember(input: {
  chatJid: string;
  assistantId: string;
  displayName: string;
  kind: 'assistant' | 'soul';
  createdBy: string;
}): Promise<void> {
  if (await isRoomEncrypted(input.chatJid)) {
    throw new Error('Encrypted rooms cannot include AI members');
  }
  await dba
    .prepare(
      `INSERT OR REPLACE INTO im_ai_members
       (chat_jid, assistant_id, display_name, kind, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      input.chatJid,
      input.assistantId,
      input.displayName,
      input.kind,
      input.createdBy,
      nowIso(),
    );
}

export async function listAiMembers(chatJid: string): Promise<
  Array<{
    assistant_id: string;
    display_name: string;
    kind: string;
    status: string;
  }>
> {
  return (await dba
    .prepare(
      `SELECT assistant_id, display_name, kind, status
       FROM im_ai_members
       WHERE chat_jid = ? AND status = 'active'
       ORDER BY created_at ASC`,
    )
    .all(chatJid)) as Array<{
    assistant_id: string;
    display_name: string;
    kind: string;
    status: string;
  }>;
}

export async function removeAiMember(
  chatJid: string,
  assistantId: string,
): Promise<void> {
  await dba
    .prepare(
      `UPDATE im_ai_members SET status = 'removed' WHERE chat_jid = ? AND assistant_id = ?`,
    )
    .run(chatJid, assistantId);
}

export async function createAiInvocation(input: {
  chatJid: string;
  assistantId: string;
  requestedBy: string;
  prompt: string;
  triggerMessageId?: string | null;
}): Promise<{ id: string; created_at: string }> {
  if (await isRoomEncrypted(input.chatJid)) {
    throw new Error('Encrypted rooms cannot invoke AI');
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  await dba
    .prepare(
      `INSERT INTO im_ai_invocations
       (id, chat_jid, assistant_id, trigger_message_id, requested_by, status, prompt, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL)`,
    )
    .run(
      id,
      input.chatJid,
      input.assistantId,
      input.triggerMessageId ?? null,
      input.requestedBy,
      input.prompt,
      ts,
    );
  return { id, created_at: ts };
}
