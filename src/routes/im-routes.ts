import type { Express } from 'express';

import { getAssistant } from '../db.js';
import { dba } from '../db/engine-access.js';
import { isFriend } from '../im/im-friend-service.js';
import { notifyImEvent } from '../im/im-notification.js';
import { tryConsumeQuota } from '../im/im-quota-service.js';
import {
  assertRole,
  checkMembership,
  listActiveMembers,
  removeMember,
} from '../im/im-membership-service.js';
import {
  addImReaction,
  createDmConversation,
  createGroupConversation,
  deleteImMessage,
  dissolveGroup,
  editImMessage,
  getAttachmentsForMessages,
  getGroupMetaForAccess,
  getImConversationDetail,
  getImConversations,
  getImMessageByClientId,
  getImMessages,
  getImReadCursors,
  getImRoomLastSeq,
  getOtherDmPeer,
  getReactionsForMessages,
  listImEventsAfter,
  removeImReaction,
  recordImEvent,
  recordImEventWithSeq,
  searchImMessages,
  sendImMessageWithReply,
  updateGroupInfo,
  updateImReadCursor,
} from '../im/im-service.js';
import {
  addAiMember,
  blockImUser,
  countUnreadImNotifications,
  createAiInvocation,
  createImCall,
  createImNotification,
  createImReport,
  endImCall,
  getConversationPrefs,
  getEncryptedEnvelopesForMessages,
  getImCall,
  isImBlockedEither,
  isRoomEncrypted,
  listRoomKeysForDevice,
  listActiveImCalls,
  listAiMembers,
  listDeviceKeys,
  listImNotifications,
  listPinnedImMessages,
  markImNotificationsRead,
  pinImMessage,
  recordMentionsForMessage,
  removeAiMember,
  setRoomEncryption,
  unblockImUser,
  unpinImMessage,
  updateImCallParticipant,
  upsertRoomKeys,
  upsertConversationPrefs,
  upsertDeviceKey,
  saveEncryptedMessageEnvelope,
} from '../im/im-social-service.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { t } from '../i18n/index.js';

export interface ImRouteOptions {
  getAuthenticatedUsername: (
    cookie: string | undefined,
  ) => string | null | undefined;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

async function resolveSenderName(userId: string): Promise<string> {
  const row = (await dba
    .prepare(
      `SELECT username, display_name FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(userId)) as
    | { username: string; display_name: string | null }
    | undefined;
  if (!row) return userId;
  const dn = row.display_name?.trim();
  return dn || row.username || userId;
}

function parseLimit(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 200);
}

function p(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function boolToInt(value: unknown): 0 | 1 | undefined {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  return undefined;
}

interface ImEncryptedPayload {
  version: number;
  algorithm: string;
  iv: string;
  aad?: string | null;
  ciphertext: string;
}

function parseEncryptedPayload(raw: unknown): ImEncryptedPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const version =
    typeof rec.version === 'number' ? rec.version : Number(rec.version);
  const algorithm =
    typeof rec.algorithm === 'string' ? rec.algorithm.trim() : '';
  const iv = typeof rec.iv === 'string' ? rec.iv.trim() : '';
  const aad =
    typeof rec.aad === 'string' ? rec.aad : rec.aad === null ? null : undefined;
  const ciphertext =
    typeof rec.ciphertext === 'string' ? rec.ciphertext.trim() : '';
  if (
    !Number.isFinite(version) ||
    version <= 0 ||
    !algorithm ||
    !iv ||
    !ciphertext
  ) {
    return null;
  }
  return { version, algorithm, iv, aad, ciphertext };
}

async function requireActiveImMember(
  jid: string,
  userId: string,
): Promise<boolean> {
  const membership = await checkMembership(jid, userId);
  return Boolean(membership && membership.status === 'active');
}

async function emitImStateEvent(
  jid: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = await recordImEvent(jid, eventType, payload);
  notifyImEvent(jid, event.payload);
}

function getTurnServersFromEnv(): Array<Record<string, string | string[]>> {
  const urls = (
    process.env.NANOCLAW_IM_TURN_URLS ||
    process.env.NANOCLAW_IM_STUN_URLS ||
    ''
  )
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }
  const server: Record<string, string | string[]> = { urls };
  if (process.env.NANOCLAW_IM_TURN_USERNAME) {
    server.username = process.env.NANOCLAW_IM_TURN_USERNAME;
  }
  if (process.env.NANOCLAW_IM_TURN_CREDENTIAL) {
    server.credential = process.env.NANOCLAW_IM_TURN_CREDENTIAL;
  }
  return [server];
}

export function registerImRoutes(app: Express, opts: ImRouteOptions): void {
  const viewGuard = opts.requirePermission('im.view', 'conversation.view');
  const sendGuard = opts.requirePermission('im.send', 'conversation.send');

  app.get('/api/im/conversations', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const conversations = await getImConversations(userId);
      res.json({ ok: true, conversations });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/conversations/dm', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { targetUserId?: string };
      const target =
        typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
      if (!target) {
        res.status(400).json({ ok: false, error: 'targetUserId is required' });
        return;
      }
      if (await isImBlockedEither(userId, target)) {
        res
          .status(403)
          .json({ ok: false, error: 'Blocked users cannot create a DM' });
        return;
      }
      const jid = await createDmConversation(userId, target);
      res.json({ ok: true, jid });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cannot create DM')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.post('/api/im/conversations/group', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as {
        name?: string;
        memberIds?: string[];
        visibility?: 'private' | 'public';
      };
      const name = typeof body.name === 'string' ? body.name : '';
      const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
      const visibility = body.visibility === 'public' ? 'public' : 'private';
      const jid = await createGroupConversation(
        userId,
        name,
        memberIds,
        visibility,
      );
      res.json({ ok: true, jid });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('required') || msg.includes('empty')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get(
    '/api/im/conversations/:jid/messages',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        const before =
          typeof req.query.before === 'string' ? req.query.before : undefined;
        const limit = parseLimit(req.query.limit, 50);
        const m = await checkMembership(jid, userId);
        if (!m || m.status !== 'active') {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const rawMessages = await getImMessages(jid, before, limit);
        const ids = rawMessages.map((m2) => m2.id);
        const [attMap, reactMap, cryptoMap] = await Promise.all([
          getAttachmentsForMessages(ids),
          getReactionsForMessages(ids),
          getEncryptedEnvelopesForMessages(ids),
        ]);
        const messages = rawMessages.map((m2) => {
          const atts = attMap.get(m2.id) || [];
          const reactions = reactMap.get(m2.id) || [];
          const encrypted = cryptoMap.get(m2.id);
          return {
            ...m2,
            attachments: atts.map((a) => ({
              id: a.id,
              fileName: a.file_name,
              mimeType: a.mime_type,
              size: a.size,
              url: `/api/im/files/${a.id}`,
            })),
            reactions,
            ...(encrypted ? { encrypted } : {}),
          };
        });
        res.json({ ok: true, messages, last_seq: await getImRoomLastSeq(jid) });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/im/conversations/:jid/messages',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        const body = req.body as {
          content?: string;
          clientId?: string;
          attachmentIds?: string[];
          replyToId?: string;
          encrypted?: unknown;
        };
        const content = typeof body.content === 'string' ? body.content : '';
        const clientId =
          typeof body.clientId === 'string' ? body.clientId : undefined;
        const replyToId =
          typeof body.replyToId === 'string'
            ? body.replyToId.trim() || undefined
            : undefined;
        const attachmentIds = Array.isArray(body.attachmentIds)
          ? body.attachmentIds.filter((v) => typeof v === 'string')
          : [];
        const encryptedPayload = parseEncryptedPayload(body.encrypted);

        const m = await checkMembership(jid, userId);
        if (!m || m.status !== 'active') {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }

        const meta = await getGroupMetaForAccess(jid);
        if (meta?.chat_type === 'dm') {
          const peer = await getOtherDmPeer(jid, userId);
          if (peer && (await isImBlockedEither(userId, peer))) {
            res.status(403).json({
              ok: false,
              error: 'Blocked users cannot exchange messages',
            });
            return;
          }
          if (peer && !(await isFriend(userId, peer))) {
            const consumed = await tryConsumeQuota(userId, peer);
            if (!consumed) {
              res.status(429).json({
                ok: false,
                error: 'Non-friend daily message quota exceeded',
              });
              return;
            }
          }
        }

        const encryptedRoom = await isRoomEncrypted(jid);
        if (encryptedRoom && !encryptedPayload) {
          res.status(400).json({
            ok: false,
            error: 'Encrypted rooms require encrypted payloads',
          });
          return;
        }
        if (!encryptedRoom && encryptedPayload) {
          res.status(400).json({
            ok: false,
            error: 'Encrypted payloads require E2EE to be enabled',
          });
          return;
        }

        const hasContent = encryptedPayload ? true : content.trim().length > 0;
        const hasAttachments = attachmentIds.length > 0;
        if (!hasContent && !hasAttachments) {
          res.status(400).json({
            ok: false,
            error: 'Message content or attachments required',
          });
          return;
        }

        if (clientId) {
          const existing = await getImMessageByClientId(jid, userId, clientId);
          if (existing) {
            const [attMap, reactMap, cryptoMap] = await Promise.all([
              getAttachmentsForMessages([existing.id]),
              getReactionsForMessages([existing.id]),
              getEncryptedEnvelopesForMessages([existing.id]),
            ]);
            const attachments = (attMap.get(existing.id) || []).map((a) => ({
              id: a.id,
              fileName: a.file_name,
              mimeType: a.mime_type,
              size: a.size,
              url: `/api/im/files/${a.id}`,
            }));
            res.json({
              ok: true,
              message: {
                ...existing,
                attachments,
                reactions: reactMap.get(existing.id) || [],
                ...(cryptoMap.get(existing.id)
                  ? { encrypted: cryptoMap.get(existing.id) }
                  : {}),
              },
            });
            return;
          }
        }

        const senderName = await resolveSenderName(userId);
        const storedContent = encryptedPayload
          ? '[encrypted]'
          : hasContent
            ? content
            : t('errors.auto_6daeae', {}, req.locale);
        const message = await sendImMessageWithReply(
          jid,
          userId,
          senderName,
          storedContent,
          replyToId,
          clientId,
        );
        if (encryptedPayload) {
          await saveEncryptedMessageEnvelope({
            chatJid: jid,
            messageId: message.id,
            version: encryptedPayload.version,
            algorithm: encryptedPayload.algorithm.slice(0, 128),
            iv: encryptedPayload.iv,
            aad: encryptedPayload.aad ?? null,
            ciphertext: encryptedPayload.ciphertext,
          });
        }

        let attachments: Array<{
          id: string;
          fileName: string;
          mimeType: string;
          size: number;
          url: string;
        }> = [];
        if (hasAttachments) {
          const placeholders = attachmentIds.map(() => '?').join(',');
          await dba
            .prepare(
              `UPDATE im_attachments SET message_id = ? WHERE id IN (${placeholders}) AND uploaded_by = ? AND message_id IS NULL`,
            )
            .run(message.id, ...attachmentIds, userId);

          attachments = (
            (await dba
              .prepare(
                `SELECT id, file_name, mime_type, size FROM im_attachments WHERE message_id = ?`,
              )
              .all(message.id)) as Array<{
              id: string;
              file_name: string;
              mime_type: string;
              size: number;
            }>
          ).map((a) => ({
            id: a.id,
            fileName: a.file_name,
            mimeType: a.mime_type,
            size: a.size,
            url: `/api/im/files/${a.id}`,
          }));
        }

        const messagePayload = {
          id: message.id,
          chat_jid: message.chat_jid,
          sender: message.sender,
          sender_name: message.sender_name,
          content: message.content,
          timestamp: message.timestamp,
          client_id: message.client_id,
          reply_to_id: replyToId,
          edited_at: message.edited_at,
          deleted_at: message.deleted_at,
          im_seq: message.im_seq,
          attachments,
          ...(encryptedPayload ? { encrypted: encryptedPayload } : {}),
        };
        const event =
          typeof message.im_seq === 'number'
            ? await recordImEventWithSeq(
                jid,
                message.im_seq,
                'im_message_created',
                { message: messagePayload, ...messagePayload },
                message.timestamp,
              )
            : await recordImEvent(
                jid,
                'im_message_created',
                { message: messagePayload, ...messagePayload },
                message.timestamp,
              );
        notifyImEvent(jid, event.payload);
        if (hasContent && !encryptedPayload) {
          await recordMentionsForMessage(jid, message.id, content, userId);
        }
        const activeMembers = await listActiveMembers(jid);
        await Promise.all(
          activeMembers
            .filter((member) => member.user_id !== userId)
            .map(async (member) => {
              const prefs = await getConversationPrefs(jid, member.user_id);
              if (prefs.is_muted) return;
              await createImNotification({
                userId: member.user_id,
                chatJid: jid,
                eventType: 'message',
                actorId: userId,
                messageId: message.id,
                title: senderName,
                body: encryptedPayload
                  ? '[encrypted]'
                  : hasContent
                    ? content.slice(0, 200)
                    : t('errors.auto_6daeae', {}, req.locale),
              });
            }),
        );

        res.json({
          ok: true,
          message: {
            ...message,
            reply_to_id: replyToId,
            attachments,
            ...(encryptedPayload ? { encrypted: encryptedPayload } : {}),
          },
        });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('Not a member') || msg.includes('Forbidden')) {
          res.status(403).json({ ok: false, error: msg });
          return;
        }
        if (msg.includes('empty')) {
          res.status(400).json({ ok: false, error: msg });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.get('/api/im/conversations/:jid', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const { meta, members } = await getImConversationDetail(
        p(req.params.jid),
        userId,
      );
      res.json({
        ok: true,
        conversation: {
          jid: meta.chat_jid,
          chat_type: meta.chat_type,
          name: meta.name,
          visibility: meta.visibility,
          notice: meta.notice,
          e2ee_enabled: meta.e2ee_enabled,
          owner_id: meta.owner_id,
          member_count: members.length,
        },
        members,
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Not a member') || msg.includes('not found')) {
        res.status(404).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/conversations/:jid/events', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const afterSeqRaw =
        typeof req.query.afterSeq === 'string'
          ? Number(req.query.afterSeq)
          : Number(req.query.after_seq);
      const afterSeq =
        Number.isFinite(afterSeqRaw) && afterSeqRaw > 0
          ? Math.floor(afterSeqRaw)
          : 0;
      const limit = parseLimit(req.query.limit, 200);
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const events = await listImEventsAfter(jid, afterSeq, limit);
      const lastSeq = await getImRoomLastSeq(jid);
      res.json({
        ok: true,
        events: events.map((event) => ({
          seq: event.seq,
          event_id: event.event_id,
          event_type: event.event_type,
          created_at: event.created_at,
          payload: event.payload,
        })),
        last_seq: lastSeq,
        limited:
          events.length >= limit && events[events.length - 1]!.seq < lastSeq,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/conversations/:jid/prefs', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      if (!(await requireActiveImMember(jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const prefs = await getConversationPrefs(jid, userId);
      res.json({ ok: true, prefs });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.patch('/api/im/conversations/:jid/prefs', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      if (!(await requireActiveImMember(jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const body = req.body as {
        is_pinned?: unknown;
        is_muted?: unknown;
        is_archived?: unknown;
        draft_text?: unknown;
      };
      const prefs = await upsertConversationPrefs(jid, userId, {
        ...(boolToInt(body.is_pinned) !== undefined
          ? { is_pinned: boolToInt(body.is_pinned) }
          : {}),
        ...(boolToInt(body.is_muted) !== undefined
          ? { is_muted: boolToInt(body.is_muted) }
          : {}),
        ...(boolToInt(body.is_archived) !== undefined
          ? { is_archived: boolToInt(body.is_archived) }
          : {}),
        ...(body.draft_text !== undefined
          ? {
              draft_text:
                typeof body.draft_text === 'string'
                  ? body.draft_text.slice(0, 4000)
                  : null,
            }
          : {}),
      });
      await emitImStateEvent(jid, 'im_prefs_updated', {
        user_id: userId,
        prefs: {
          is_pinned: prefs.is_pinned,
          is_muted: prefs.is_muted,
          is_archived: prefs.is_archived,
          updated_at: prefs.updated_at,
        },
      });
      res.json({ ok: true, prefs });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/notifications', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const limit = parseLimit(req.query.limit, 50);
      const [notifications, unread_count] = await Promise.all([
        listImNotifications(userId, limit),
        countUnreadImNotifications(userId),
      ]);
      res.json({ ok: true, notifications, unread_count });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.patch('/api/im/notifications/read', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { ids?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id) => typeof id === 'string')
        : [];
      await markImNotificationsRead(userId, ids);
      res.json({
        ok: true,
        unread_count: await countUnreadImNotifications(userId),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post(
    '/api/im/security/blocks/:targetUserId',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const targetUserId = p(req.params.targetUserId).trim();
        if (!targetUserId) {
          res
            .status(400)
            .json({ ok: false, error: 'targetUserId is required' });
          return;
        }
        await blockImUser(userId, targetUserId);
        res.json({ ok: true });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('yourself')) {
          res.status(400).json({ ok: false, error: msg });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.delete(
    '/api/im/security/blocks/:targetUserId',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        await unblockImUser(userId, p(req.params.targetUserId));
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post('/api/im/security/reports', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as {
        chatJid?: unknown;
        messageId?: unknown;
        targetUserId?: unknown;
        reason?: unknown;
        details?: unknown;
      };
      const chatJid = typeof body.chatJid === 'string' ? body.chatJid : null;
      if (chatJid && !(await requireActiveImMember(chatJid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) {
        res.status(400).json({ ok: false, error: 'reason is required' });
        return;
      }
      const report = await createImReport({
        reporterId: userId,
        chatJid,
        messageId: typeof body.messageId === 'string' ? body.messageId : null,
        targetUserId:
          typeof body.targetUserId === 'string' ? body.targetUserId : null,
        reason: reason.slice(0, 128),
        details:
          typeof body.details === 'string' ? body.details.slice(0, 4000) : null,
      });
      res.json({ ok: true, report });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get(
    '/api/im/conversations/:jid/pinned-messages',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        res.json({ ok: true, pinned: await listPinnedImMessages(jid) });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/im/conversations/:jid/pinned-messages',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const body = req.body as { messageId?: unknown };
        const messageId =
          typeof body.messageId === 'string' ? body.messageId.trim() : '';
        if (!messageId) {
          res.status(400).json({ ok: false, error: 'messageId is required' });
          return;
        }
        const pinned = await pinImMessage(jid, messageId, userId);
        await emitImStateEvent(jid, 'im_pinned_message_changed', {
          action: 'pin',
          message_id: messageId,
          pinned_by: userId,
          pinned_at: pinned.pinned_at,
        });
        res.json({ ok: true, pinned });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.delete(
    '/api/im/conversations/:jid/pinned-messages/:messageId',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const messageId = p(req.params.messageId);
        await unpinImMessage(jid, messageId);
        await emitImStateEvent(jid, 'im_pinned_message_changed', {
          action: 'unpin',
          message_id: messageId,
          pinned_by: userId,
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post('/api/im/e2ee/device-key', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { deviceId?: unknown; publicKey?: unknown };
      const deviceId =
        typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
      const publicKey =
        typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
      if (!deviceId || !publicKey) {
        res
          .status(400)
          .json({ ok: false, error: 'deviceId and publicKey are required' });
        return;
      }
      await upsertDeviceKey(userId, deviceId.slice(0, 128), publicKey);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get(
    '/api/im/conversations/:jid/e2ee/device-keys',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const members = await listActiveMembers(jid);
        const keys = await listDeviceKeys(
          members.map((member) => member.user_id),
        );
        res.json({ ok: true, keys });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.get(
    '/api/im/conversations/:jid/e2ee/room-keys',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const deviceId =
          typeof req.query.deviceId === 'string'
            ? req.query.deviceId.trim()
            : undefined;
        const keys = await listRoomKeysForDevice(jid, userId, deviceId);
        res.json({ ok: true, keys });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/im/conversations/:jid/e2ee/room-keys',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const body = req.body as { keys?: unknown };
        const rawKeys = Array.isArray(body.keys) ? body.keys : [];
        if (rawKeys.length === 0 || rawKeys.length > 500) {
          res
            .status(400)
            .json({ ok: false, error: 'keys must contain 1-500 entries' });
          return;
        }
        const activeMemberIds = new Set(
          (await listActiveMembers(jid)).map((member) => member.user_id),
        );
        const keys = rawKeys.map((entry) => {
          const rec =
            entry && typeof entry === 'object'
              ? (entry as Record<string, unknown>)
              : {};
          const targetUserId =
            typeof rec.userId === 'string'
              ? rec.userId.trim()
              : typeof rec.user_id === 'string'
                ? rec.user_id.trim()
                : '';
          const deviceId =
            typeof rec.deviceId === 'string'
              ? rec.deviceId.trim()
              : typeof rec.device_id === 'string'
                ? rec.device_id.trim()
                : '';
          const wrappedKey =
            typeof rec.wrappedKey === 'string'
              ? rec.wrappedKey.trim()
              : typeof rec.wrapped_key === 'string'
                ? rec.wrapped_key.trim()
                : '';
          const algorithm =
            typeof rec.algorithm === 'string'
              ? rec.algorithm.trim()
              : 'ECDH-P256+HKDF-SHA256+A256GCM';
          if (!activeMemberIds.has(targetUserId)) {
            throw new Error('Room keys can only target active members');
          }
          return { userId: targetUserId, deviceId, wrappedKey, algorithm };
        });
        await upsertRoomKeys(jid, keys);
        await emitImStateEvent(jid, 'im_e2ee_room_keys_updated', {
          updated_by: userId,
          target_count: keys.length,
        });
        res.json({ ok: true });
      } catch (err) {
        const msg = String(err);
        if (
          msg.includes('active members') ||
          msg.includes('Invalid room key')
        ) {
          res.status(400).json({ ok: false, error: msg });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.patch('/api/im/conversations/:jid/e2ee', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const meta = await getGroupMetaForAccess(jid);
      if (!meta) {
        res.status(404).json({ ok: false, error: 'Conversation not found' });
        return;
      }
      if (meta.chat_type === 'group') {
        await assertRole(jid, userId, 'owner', 'admin');
      } else if (!(await requireActiveImMember(jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const enabled = boolToInt((req.body as { enabled?: unknown }).enabled);
      if (enabled === undefined) {
        res.status(400).json({ ok: false, error: 'enabled is required' });
        return;
      }
      const pendingAiInvocations =
        enabled === 1
          ? ((await dba
              .prepare(
                `SELECT id, assistant_id
               FROM im_ai_invocations
               WHERE chat_jid = ? AND status IN ('queued', 'running')`,
              )
              .all(jid)) as Array<{ id: string; assistant_id: string }>)
          : [];
      await setRoomEncryption(jid, enabled === 1);
      if (enabled === 1) {
        const aiMembers = await listAiMembers(jid);
        await Promise.all(
          aiMembers.map((member) => removeAiMember(jid, member.assistant_id)),
        );
      }
      await emitImStateEvent(jid, 'im_e2ee_updated', {
        enabled: enabled === 1,
        updated_by: userId,
      });
      for (const invocation of pendingAiInvocations) {
        await emitImStateEvent(jid, 'im_ai_invocation_failed', {
          invocation_id: invocation.id,
          assistant_id: invocation.assistant_id,
          status: 'failed',
          error: 'Encrypted rooms cannot invoke AI',
        });
      }
      res.json({ ok: true, e2ee_enabled: enabled });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/calls/config', viewGuard, (_req, res) => {
    res.json({ ok: true, iceServers: getTurnServersFromEnv() });
  });

  app.get('/api/im/conversations/:jid/calls', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      if (!(await requireActiveImMember(jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      res.json({ ok: true, calls: await listActiveImCalls(jid) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/im/conversations/:jid/calls', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      if (!(await requireActiveImMember(jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const type =
        (req.body as { callType?: unknown }).callType === 'video'
          ? 'video'
          : 'audio';
      const call = await createImCall({
        chatJid: jid,
        createdBy: userId,
        callType: type,
      });
      await emitImStateEvent(jid, 'im_call_started', {
        call_id: call.id,
        call_type: type,
        created_by: userId,
        status: call.status,
        created_at: call.created_at,
      });
      res.json({ ok: true, call });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post(
    '/api/im/calls/:callId/actions/:action',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const callId = p(req.params.callId);
        const action = p(req.params.action);
        const call = await getImCall(callId);
        if (!call) {
          res.status(404).json({ ok: false, error: 'Call not found' });
          return;
        }
        if (!(await requireActiveImMember(call.chat_jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        if (action === 'join' || action === 'leave' || action === 'decline') {
          const status =
            action === 'join'
              ? 'joined'
              : action === 'leave'
                ? 'left'
                : 'declined';
          await updateImCallParticipant(callId, userId, status);
          await emitImStateEvent(call.chat_jid, 'im_call_participant_changed', {
            call_id: callId,
            user_id: userId,
            status,
          });
          res.json({ ok: true });
          return;
        }
        if (action === 'end') {
          await endImCall(callId);
          await emitImStateEvent(call.chat_jid, 'im_call_ended', {
            call_id: callId,
            ended_by: userId,
          });
          res.json({ ok: true });
          return;
        }
        res.status(400).json({ ok: false, error: 'Invalid call action' });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post('/api/im/calls/:callId/signal', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const callId = p(req.params.callId);
      const call = await getImCall(callId);
      if (!call) {
        res.status(404).json({ ok: false, error: 'Call not found' });
        return;
      }
      if (!(await requireActiveImMember(call.chat_jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const body = req.body as {
        targetUserId?: unknown;
        signalType?: unknown;
        data?: unknown;
      };
      const signalType =
        typeof body.signalType === 'string' ? body.signalType : '';
      if (!signalType || body.data === undefined) {
        res
          .status(400)
          .json({ ok: false, error: 'signalType and data are required' });
        return;
      }
      notifyImEvent(call.chat_jid, {
        type: 'im_call_signal',
        jid: call.chat_jid,
        call_id: callId,
        from_user_id: userId,
        target_user_id:
          typeof body.targetUserId === 'string' ? body.targetUserId : null,
        signal_type: signalType,
        data: body.data,
        timestamp: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get(
    '/api/im/conversations/:jid/ai-members',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        res.json({ ok: true, ai_members: await listAiMembers(jid) });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.post(
    '/api/im/conversations/:jid/ai-members',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        await assertRole(jid, userId, 'owner', 'admin');
        if (await isRoomEncrypted(jid)) {
          res.status(409).json({
            ok: false,
            error: 'Encrypted rooms cannot include AI members',
          });
          return;
        }
        const body = req.body as {
          assistantId?: unknown;
          displayName?: unknown;
          kind?: unknown;
        };
        const assistantId =
          typeof body.assistantId === 'string' ? body.assistantId.trim() : '';
        const displayName =
          typeof body.displayName === 'string' ? body.displayName.trim() : '';
        const kind = body.kind === 'soul' ? 'soul' : 'assistant';
        if (!assistantId || !displayName) {
          res.status(400).json({
            ok: false,
            error: 'assistantId and displayName are required',
          });
          return;
        }
        if (kind === 'assistant' && !(await getAssistant(assistantId))) {
          res.status(404).json({ ok: false, error: 'Assistant not found' });
          return;
        }
        if (
          kind === 'soul' &&
          !(await requireActiveImMember(jid, assistantId))
        ) {
          res
            .status(404)
            .json({ ok: false, error: 'Soul user not found in this room' });
          return;
        }
        await addAiMember({
          chatJid: jid,
          assistantId,
          displayName,
          kind,
          createdBy: userId,
        });
        await emitImStateEvent(jid, 'im_member_changed', {
          action: 'ai_added',
          assistant_id: assistantId,
          display_name: displayName,
          kind,
          changed_by: userId,
        });
        res.json({
          ok: true,
          ai_member: {
            assistant_id: assistantId,
            display_name: displayName,
            kind,
            status: 'active',
          },
        });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('Insufficient') || msg.includes('Not a member')) {
          res.status(403).json({ ok: false, error: msg });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.delete(
    '/api/im/conversations/:jid/ai-members/:assistantId',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        await assertRole(jid, userId, 'owner', 'admin');
        const assistantId = p(req.params.assistantId);
        await removeAiMember(jid, assistantId);
        await emitImStateEvent(jid, 'im_member_changed', {
          action: 'ai_removed',
          assistant_id: assistantId,
          changed_by: userId,
        });
        res.json({ ok: true });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('Insufficient') || msg.includes('Not a member')) {
          res.status(403).json({ ok: false, error: msg });
          return;
        }
        res.status(500).json({ ok: false, error: msg });
      }
    },
  );

  app.post(
    '/api/im/conversations/:jid/ai-invocations',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        if (await isRoomEncrypted(jid)) {
          res
            .status(409)
            .json({ ok: false, error: 'Encrypted rooms cannot invoke AI' });
          return;
        }
        const body = req.body as {
          assistantId?: unknown;
          prompt?: unknown;
          triggerMessageId?: unknown;
        };
        const assistantId =
          typeof body.assistantId === 'string' ? body.assistantId.trim() : '';
        const prompt =
          typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!assistantId || !prompt) {
          res
            .status(400)
            .json({ ok: false, error: 'assistantId and prompt are required' });
          return;
        }
        const activeAi = await listAiMembers(jid);
        if (!activeAi.some((member) => member.assistant_id === assistantId)) {
          res.status(404).json({ ok: false, error: 'AI member not found' });
          return;
        }
        const invocation = await createAiInvocation({
          chatJid: jid,
          assistantId,
          requestedBy: userId,
          prompt: prompt.slice(0, 8000),
          triggerMessageId:
            typeof body.triggerMessageId === 'string'
              ? body.triggerMessageId
              : null,
        });
        await emitImStateEvent(jid, 'im_ai_invoked', {
          invocation_id: invocation.id,
          assistant_id: assistantId,
          requested_by: userId,
          trigger_message_id:
            typeof body.triggerMessageId === 'string'
              ? body.triggerMessageId
              : null,
          status: 'queued',
          created_at: invocation.created_at,
        });
        res.json({ ok: true, invocation: { ...invocation, status: 'queued' } });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.get(
    '/api/im/conversations/:jid/ai-invocations',
    viewGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const jid = p(req.params.jid);
        if (!(await requireActiveImMember(jid, userId))) {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const limit = parseLimit(req.query.limit, 20);
        const invocations = (await dba
          .prepare(
            `SELECT id, chat_jid, assistant_id, trigger_message_id, requested_by, status, prompt, error_message, created_at, completed_at
           FROM im_ai_invocations
           WHERE chat_jid = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          )
          .all(jid, limit)) as Array<Record<string, unknown>>;
        res.json({ ok: true, invocations });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.patch('/api/im/conversations/:jid', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      await assertRole(jid, userId, 'owner', 'admin');
      const body = req.body as {
        name?: string;
        notice?: string | null;
        visibility?: 'private' | 'public';
      };
      await updateGroupInfo(jid, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.notice !== undefined ? { notice: body.notice } : {}),
        ...(body.visibility !== undefined
          ? { visibility: body.visibility }
          : {}),
      });
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Insufficient') || msg.includes('Not a member')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('Only group') || msg.includes('empty')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.delete('/api/im/conversations/:jid', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const meta = await getGroupMetaForAccess(jid);
      if (!meta) {
        res.status(404).json({ ok: false, error: 'Conversation not found' });
        return;
      }
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      if (meta.chat_type === 'group') {
        if (meta.owner_id === userId) {
          await dissolveGroup(jid);
        } else {
          await removeMember(jid, userId, 'left');
        }
      } else {
        await removeMember(jid, userId, 'left');
      }
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Only group')) {
        res.status(400).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Message edit ──
  app.patch('/api/im/messages/:id', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { content?: string; chatJid?: string };
      const chatJid = typeof body.chatJid === 'string' ? body.chatJid : '';
      const content = typeof body.content === 'string' ? body.content : '';
      if (!chatJid) {
        res.status(400).json({ ok: false, error: 'chatJid required' });
        return;
      }
      const m = await checkMembership(chatJid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      if (await isRoomEncrypted(chatJid)) {
        res.status(409).json({
          ok: false,
          error: 'Encrypted messages cannot be edited on the server',
        });
        return;
      }
      const msgId = p(req.params.id);
      const editedAt = await editImMessage(msgId, chatJid, userId, content);
      const event = await recordImEvent(
        chatJid,
        'im_message_edited',
        {
          message_id: msgId,
          content: content.trim(),
          edited_by: userId,
          edited_at: editedAt,
        },
        editedAt,
      );
      notifyImEvent(chatJid, event.payload);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('own messages') || msg.includes('deleted')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Message delete ──
  app.delete('/api/im/messages/:id', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const chatJid =
        typeof req.query.chatJid === 'string' ? req.query.chatJid : '';
      if (!chatJid) {
        res.status(400).json({ ok: false, error: 'chatJid required' });
        return;
      }
      const m = await checkMembership(chatJid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const msgId = p(req.params.id);
      const deletedAt = await deleteImMessage(msgId, chatJid, userId);
      const event = await recordImEvent(
        chatJid,
        'im_message_deleted',
        {
          message_id: msgId,
          deleted_by: userId,
          deleted_at: deletedAt,
        },
        deletedAt,
      );
      notifyImEvent(chatJid, event.payload);
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found')) {
        res.status(404).json({ ok: false, error: msg });
        return;
      }
      if (msg.includes('own messages') || msg.includes('already deleted')) {
        res.status(403).json({ ok: false, error: msg });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // ── Reactions ──
  app.post('/api/im/messages/:id/reactions', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { emoji?: string; chatJid?: string };
      const chatJid = typeof body.chatJid === 'string' ? body.chatJid : '';
      const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';
      if (!chatJid || !emoji) {
        res
          .status(400)
          .json({ ok: false, error: 'chatJid and emoji required' });
        return;
      }
      const m = await checkMembership(chatJid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const msgId = p(req.params.id);
      await addImReaction(msgId, chatJid, userId, emoji);
      const event = await recordImEvent(chatJid, 'im_reaction_changed', {
        message_id: msgId,
        user_id: userId,
        emoji,
        action: 'add',
      });
      notifyImEvent(chatJid, event.payload);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete(
    '/api/im/messages/:id/reactions/:emoji',
    sendGuard,
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const chatJid =
          typeof req.query.chatJid === 'string' ? req.query.chatJid : '';
        if (!chatJid) {
          res.status(400).json({ ok: false, error: 'chatJid required' });
          return;
        }
        const m = await checkMembership(chatJid, userId);
        if (!m || m.status !== 'active') {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        const msgId = p(req.params.id);
        const emoji = p(req.params.emoji);
        await removeImReaction(msgId, userId, emoji);
        const event = await recordImEvent(chatJid, 'im_reaction_changed', {
          message_id: msgId,
          user_id: userId,
          emoji,
          action: 'remove',
        });
        notifyImEvent(chatJid, event.payload);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  // ── Read receipts ──
  app.post('/api/im/conversations/:jid/read', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const body = req.body as { messageId?: string };
      const messageId =
        typeof body.messageId === 'string' ? body.messageId : '';
      if (!messageId) {
        res.status(400).json({ ok: false, error: 'messageId required' });
        return;
      }
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const cursor = await updateImReadCursor(jid, userId, messageId);
      const event = await recordImEvent(
        jid,
        'im_read_updated',
        {
          user_id: userId,
          last_read_message_id: messageId,
          last_read_seq: cursor.last_read_seq,
          last_read_at: cursor.last_read_at,
        },
        cursor.last_read_at,
      );
      notifyImEvent(jid, event.payload);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/im/conversations/:jid/read', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const cursors = await getImReadCursors(jid);
      res.json({ ok: true, cursors });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Message search (scoped to user's conversations) ──
  app.get('/api/im/messages/search', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const chatJid =
        typeof req.query.jid === 'string' ? req.query.jid : undefined;
      const before =
        typeof req.query.before === 'string' ? req.query.before : undefined;
      const limit = parseLimit(req.query.limit, 50);
      if (!q.trim()) {
        res.status(400).json({ ok: false, error: 'query is required' });
        return;
      }
      if (chatJid) {
        const m = await checkMembership(chatJid, userId);
        if (!m || m.status !== 'active') {
          res.status(403).json({ ok: false, error: 'Forbidden' });
          return;
        }
        if (await isRoomEncrypted(chatJid)) {
          res.json({ ok: true, messages: [] });
          return;
        }
      }
      const messages = await searchImMessages(
        q,
        chatJid,
        before,
        limit,
        userId,
      );
      res.json({ ok: true, messages });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Typing indicator (WebSocket relay) ──
  app.post('/api/im/conversations/:jid/typing', sendGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const jid = p(req.params.jid);
      const m = await checkMembership(jid, userId);
      if (!m || m.status !== 'active') {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      const senderName = await resolveSenderName(userId);
      notifyImEvent(jid, {
        type: 'im_typing',
        user_id: userId,
        sender_name: senderName,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
