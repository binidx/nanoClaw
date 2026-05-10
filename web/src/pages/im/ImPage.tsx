import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useMobileDetect } from '../../hooks/useMobileDetect';
import {
  addReaction,
  createDm,
  deleteMessage,
  dissolveGroup,
  editMessage,
  getConversationDetail,
  getConversationEvents,
  getConversations,
  getFriends,
  getMembers,
  getMessages,
  markAsRead,
  removeReaction,
  sendMessage,
  type ImConversation,
  type ImConversationDetail,
  type ImFriend,
  type ImMember,
  type ImMessage,
} from './im-api';
import {
  decryptMessages,
  encryptMessagePayload,
  ensureRegisteredDevice,
  getImE2eeDeviceStatus,
  shareExistingRoomKey,
  type ImE2eeDeviceStatus,
  type PlainAttachmentMeta,
} from './im-e2ee';
import {
  type ImConversationSnapshot,
  shouldFetchConversationSnapshot,
} from './im-cache';
import { createImUuid } from './im-random';
import { ImChatView } from './components/ImChatView';
import { ImCreateGroupDialog } from './components/ImCreateGroupDialog';
import { ImEditMessageDialog } from './components/ImEditMessageDialog';
import { ImFriendRequestDialog } from './components/ImFriendRequestDialog';
import { ImInfoPanel } from './components/ImInfoPanel';
import { ImSidebar, type ImSidebarTab } from './components/ImSidebar';

const MESSAGE_PAGE_SIZE = 50;
const CONVERSATION_CACHE_TTL_MS = 30_000;

function sortMessages(list: ImMessage[]): ImMessage[] {
  return [...list].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

function mergeMessages(prev: ImMessage[], batch: ImMessage[]): ImMessage[] {
  const map = new Map<string, ImMessage>();
  for (const m of batch) map.set(m.id, m);
  for (const m of prev) {
    if (!map.has(m.id)) map.set(m.id, m);
  }
  return sortMessages([...map.values()]);
}

function bumpConversationList(
  list: ImConversation[],
  msg: ImMessage,
): ImConversation[] {
  const idx = list.findIndex((c) => c.jid === msg.chat_jid);
  if (idx < 0) return list;
  const next = [...list];
  const c = next[idx];
  next[idx] = {
    ...c,
    last_message_time: msg.timestamp,
    last_message_content: msg.deleted_at
      ? i18n.t('im.消息已撤回')
      : msg.content,
    last_message_sender: msg.sender_name || msg.sender,
  };
  return next;
}

function coerceImMessage(
  raw: Record<string, unknown>,
  fallbackJid: string,
): ImMessage | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const chat_jid =
    typeof raw.chat_jid === 'string' && raw.chat_jid
      ? raw.chat_jid
      : fallbackJid;
  if (!id || !chat_jid) return null;
  const msg: ImMessage = {
    id,
    chat_jid,
    sender: typeof raw.sender === 'string' ? raw.sender : '',
    sender_name: typeof raw.sender_name === 'string' ? raw.sender_name : null,
    content: typeof raw.content === 'string' ? raw.content : '',
    timestamp:
      typeof raw.timestamp === 'string'
        ? raw.timestamp
        : new Date().toISOString(),
    client_id:
      typeof raw.client_id === 'string' || raw.client_id === null
        ? (raw.client_id as string | null)
        : null,
  };
  if (typeof raw.im_seq === 'number') msg.im_seq = raw.im_seq;
  else if (typeof raw.room_seq === 'number') msg.im_seq = raw.room_seq;
  if (typeof raw.reply_to_id === 'string') msg.reply_to_id = raw.reply_to_id;
  if (typeof raw.edited_at === 'string') msg.edited_at = raw.edited_at;
  else if (raw.edited_at === null) msg.edited_at = null;
  if (typeof raw.deleted_at === 'string') msg.deleted_at = raw.deleted_at;
  else if (raw.deleted_at === null) msg.deleted_at = null;
  if (Array.isArray(raw.reactions))
    msg.reactions = raw.reactions as ImMessage['reactions'];
  if (Array.isArray(raw.attachments))
    msg.attachments = raw.attachments as ImMessage['attachments'];
  if (raw.encrypted && typeof raw.encrypted === 'object') {
    msg.encrypted = raw.encrypted as ImMessage['encrypted'];
  }
  return msg;
}

function tryParseImWsMessage(data: Record<string, unknown>): ImMessage | null {
  const hint =
    (typeof data.chat_jid === 'string' && data.chat_jid) ||
    (typeof data.jid === 'string' ? data.jid : '');
  const nested = data.message ?? data.payload ?? data.im_message ?? data.body;
  if (nested && typeof nested === 'object') {
    const m = coerceImMessage(nested as Record<string, unknown>, hint);
    if (m) return m;
  }
  if (
    typeof data.id === 'string' &&
    (typeof data.chat_jid === 'string' || Boolean(hint))
  ) {
    return coerceImMessage(
      data,
      typeof data.chat_jid === 'string' ? data.chat_jid : hint,
    );
  }
  return null;
}

function unwrapRealtimeEnvelope(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (
    data.kind !== 'realtime' ||
    !data.payload ||
    typeof data.payload !== 'object'
  ) {
    return data;
  }
  const payload = data.payload as Record<string, unknown>;
  return {
    ...payload,
    jid:
      typeof payload.jid === 'string'
        ? payload.jid
        : typeof data.jid === 'string'
          ? data.jid
          : '',
    type:
      typeof payload.type === 'string'
        ? payload.type
        : typeof data.event_type === 'string'
          ? data.event_type
          : '',
    seq: typeof data.seq === 'number' ? data.seq : payload.seq,
  };
}

function getRealtimeSeq(data: Record<string, unknown>): number | null {
  const raw =
    data.kind === 'realtime' && data.payload && typeof data.payload === 'object'
      ? (data.payload as Record<string, unknown>)
      : data;
  const value = raw.room_seq;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type ReactionGroups = Array<{ emoji: string; count: number; users: string[] }>;

function applyReactionDelta(
  reactions: ImMessage['reactions'],
  action: 'add' | 'remove',
  emoji: string,
  userId: string,
): ReactionGroups {
  const groups: ReactionGroups = (reactions || []).map((r) => ({
    ...r,
    users: [...(r.users ?? [])],
  }));
  if (action === 'add') {
    const g = groups.find((r) => r.emoji === emoji);
    if (g) {
      if (!g.users.includes(userId)) {
        g.users.push(userId);
        g.count = g.users.length;
      }
    } else {
      groups.push({ emoji, count: 1, users: [userId] });
    }
  } else {
    const gi = groups.findIndex((r) => r.emoji === emoji);
    if (gi >= 0) {
      const g = groups[gi]!;
      g.users = g.users.filter((u) => u !== userId);
      g.count = g.users.length;
      if (g.count === 0) groups.splice(gi, 1);
    }
  }
  return groups;
}

export function ImPage() {
  const { t } = useTranslation('im');
  const isMobile = useMobileDetect();
  const [currentUserId, setCurrentUserId] = useState('');
  const [sidebarTab, setSidebarTab] = useState<ImSidebarTab>('conversations');
  const [conversations, setConversations] = useState<ImConversation[]>([]);
  const [friends, setFriends] = useState<ImFriend[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listsLoading, setListsLoading] = useState(true);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const activeJidRef = useRef<string | null>(null);
  const lastSeqByJidRef = useRef<Map<string, number>>(new Map());
  const [editingMessage, setEditingMessage] = useState<ImMessage | null>(null);

  useEffect(() => {
    void fetch('/api/auth/status')
      .then((r) => r.json())
      .then((data: { userId?: string }) => {
        if (data.userId) setCurrentUserId(data.userId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    void ensureRegisteredDevice().catch(() => {});
  }, [currentUserId]);

  const [messages, setMessages] = useState<ImMessage[]>([]);
  const [members, setMembers] = useState<ImMember[]>([]);
  const [detail, setDetail] = useState<ImConversationDetail | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [e2eeDeviceStatus, setE2eeDeviceStatus] =
    useState<ImE2eeDeviceStatus | null>(null);
  const olderBusyRef = useRef(false);

  const [infoOpen, setInfoOpen] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [friendReqOpen, setFriendReqOpen] = useState(false);
  const [dissolveBusy, setDissolveBusy] = useState(false);
  const conversationCacheRef = useRef<Map<string, ImConversationSnapshot>>(
    new Map(),
  );

  const cacheConversationSnapshot = useCallback(
    (jid: string, snapshot: ImConversationSnapshot) => {
      conversationCacheRef.current.set(jid, snapshot);
    },
    [],
  );

  const updateCachedConversation = useCallback(
    (
      jid: string,
      updater: (snapshot: ImConversationSnapshot) => ImConversationSnapshot,
    ) => {
      const previous = conversationCacheRef.current.get(jid);
      if (!previous) return;
      conversationCacheRef.current.set(jid, updater(previous));
    },
    [],
  );

  useEffect(() => {
    activeJidRef.current = activeJid;
  }, [activeJid]);

  const reloadLists = useCallback(async () => {
    setListError(null);
    setListsLoading(true);
    try {
      const [cRes, fRes] = await Promise.all([
        getConversations(),
        getFriends(),
      ]);
      setConversations(cRes.conversations);
      setFriends(fRes.friends);
    } catch (e) {
      setListError(e instanceof Error ? e.message : t('im.加载失败'));
    } finally {
      setListsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadLists();
  }, [reloadLists]);

  const messagesRef = useRef<ImMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!activeJid || messages.length === 0) return;
    const last = [...messages]
      .reverse()
      .find((message) => !message.delivery_status);
    if (!last?.id) return;
    void markAsRead(activeJid, last.id)
      .then(() => {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.jid === activeJid
              ? { ...conversation, unread_count: 0 }
              : conversation,
          ),
        );
      })
      .catch(() => {});
  }, [activeJid, messages]);

  const isLastMessage = useCallback(
    (jid: string, messageId: string): boolean => {
      if (jid !== activeJidRef.current) return false;
      const msgs = messagesRef.current;
      return msgs.length > 0 && msgs[msgs.length - 1]?.id === messageId;
    },
    [],
  );

  const applyIncomingMessage = useCallback(
    (msg: ImMessage) => {
      setConversations((prev) => bumpConversationList(prev, msg));
      updateCachedConversation(msg.chat_jid, (snapshot) => ({
        ...snapshot,
        messages: (() => {
          const existing = snapshot.messages.some((m) => m.id === msg.id);
          if (existing) {
            return snapshot.messages.map((m) =>
              m.id === msg.id ? { ...m, ...msg } : m,
            );
          }
          return mergeMessages(snapshot.messages, [msg]);
        })(),
      }));
      setMessages((prev) => {
        if (msg.chat_jid !== activeJidRef.current) return prev;
        const existing = prev.some((m) => m.id === msg.id);
        if (existing) {
          return prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m));
        }
        return mergeMessages(prev, [msg]);
      });
    },
    [updateCachedConversation],
  );

  const onImWsMessage = useCallback(
    (raw: Record<string, unknown>) => {
      const data = unwrapRealtimeEnvelope(raw);
      const eventType = typeof data.type === 'string' ? data.type : '';
      const jidForSeq = typeof data.jid === 'string' ? data.jid : '';
      const seq = getRealtimeSeq(data);
      if (jidForSeq && seq != null) {
        const prevSeq = lastSeqByJidRef.current.get(jidForSeq) ?? 0;
        if (seq <= prevSeq) return;
        lastSeqByJidRef.current.set(jidForSeq, seq);
      }

      if (eventType === 'im_message_edited') {
        const jid = typeof data.jid === 'string' ? data.jid : '';
        const messageId =
          typeof data.message_id === 'string' ? data.message_id : '';
        const content = typeof data.content === 'string' ? data.content : '';
        const editedAt =
          typeof data.edited_at === 'string'
            ? data.edited_at
            : new Date().toISOString();
        if (!messageId || !jid) return;
        updateCachedConversation(jid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId ? { ...m, content, edited_at: editedAt } : m,
          ),
        }));
        setMessages((prev) => {
          if (jid !== activeJidRef.current) return prev;
          return prev.map((m) =>
            m.id === messageId ? { ...m, content, edited_at: editedAt } : m,
          );
        });
        if (isLastMessage(jid, messageId)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.jid === jid ? { ...c, last_message_content: content } : c,
            ),
          );
        }
        return;
      }

      if (eventType === 'im_message_deleted') {
        const jid = typeof data.jid === 'string' ? data.jid : '';
        const messageId =
          typeof data.message_id === 'string' ? data.message_id : '';
        const deletedAt =
          typeof data.deleted_at === 'string'
            ? data.deleted_at
            : new Date().toISOString();
        if (!messageId || !jid) return;
        updateCachedConversation(jid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId ? { ...m, deleted_at: deletedAt } : m,
          ),
        }));
        setMessages((prev) => {
          if (jid !== activeJidRef.current) return prev;
          return prev.map((m) =>
            m.id === messageId ? { ...m, deleted_at: deletedAt } : m,
          );
        });
        if (isLastMessage(jid, messageId)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.jid === jid
                ? { ...c, last_message_content: t('im.消息已撤回') }
                : c,
            ),
          );
        }
        return;
      }

      if (eventType === 'im_reaction' || eventType === 'im_reaction_changed') {
        const jid = typeof data.jid === 'string' ? data.jid : '';
        const messageId =
          typeof data.message_id === 'string' ? data.message_id : '';
        const userId = typeof data.user_id === 'string' ? data.user_id : '';
        const emoji = typeof data.emoji === 'string' ? data.emoji : '';
        const action =
          data.action === 'add' || data.action === 'remove' ? data.action : '';
        if (!messageId || !emoji || !jid || !userId || !action) return;
        updateCachedConversation(jid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  reactions: applyReactionDelta(
                    m.reactions,
                    action,
                    emoji,
                    userId,
                  ),
                }
              : m,
          ),
        }));
        setMessages((prev) => {
          if (jid !== activeJidRef.current) return prev;
          return prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  reactions: applyReactionDelta(
                    m.reactions,
                    action,
                    emoji,
                    userId,
                  ),
                }
              : m,
          );
        });
        return;
      }

      if (eventType === 'im_e2ee_updated') {
        const jid = typeof data.jid === 'string' ? data.jid : '';
        const enabled = data.enabled === true || data.enabled === 1;
        if (!jid) return;
        setConversations((prev) =>
          prev.map((c) =>
            c.jid === jid ? { ...c, e2ee_enabled: enabled ? 1 : 0 } : c,
          ),
        );
        if (jid === activeJidRef.current) {
          setDetail((prev) =>
            prev && prev.jid === jid
              ? { ...prev, e2ee_enabled: enabled ? 1 : 0 }
              : prev,
          );
        }
        updateCachedConversation(jid, (snapshot) => ({
          ...snapshot,
          detail: snapshot.detail
            ? { ...snapshot.detail, e2ee_enabled: enabled ? 1 : 0 }
            : snapshot.detail,
        }));
        return;
      }

      if (eventType === 'im_e2ee_room_keys_updated') {
        const jid = typeof data.jid === 'string' ? data.jid : '';
        if (jid && jid === activeJidRef.current) {
          void shareExistingRoomKey(jid)
            .then(() =>
              currentUserId ? getImE2eeDeviceStatus(jid, currentUserId) : null,
            )
            .then(async (status) => {
              if (status) setE2eeDeviceStatus(status);
              if (currentUserId) {
                const decrypted = await decryptMessages(
                  jid,
                  currentUserId,
                  messagesRef.current,
                );
                setMessages(decrypted);
              }
            })
            .catch(() => {});
        }
        return;
      }

      if (
        eventType === 'im_member_changed' ||
        eventType === 'im_prefs_updated' ||
        eventType === 'im_pinned_message_changed' ||
        eventType === 'im_call_started' ||
        eventType === 'im_call_ended' ||
        eventType === 'im_call_participant_changed' ||
        eventType === 'im_ai_invoked' ||
        eventType === 'im_ai_invocation_running' ||
        eventType === 'im_ai_invocation_completed' ||
        eventType === 'im_ai_invocation_failed'
      ) {
        return;
      }

      if (
        eventType === 'im_typing' ||
        eventType === 'im_read_update' ||
        eventType === 'im_read_updated'
      )
        return;

      const msg = tryParseImWsMessage(data);
      if (!msg) return;
      if (msg.encrypted && currentUserId) {
        void decryptMessages(msg.chat_jid, currentUserId, [msg])
          .then(([decrypted]) => applyIncomingMessage(decrypted || msg))
          .catch(() => applyIncomingMessage(msg));
        return;
      }
      applyIncomingMessage(msg);
    },
    [
      applyIncomingMessage,
      currentUserId,
      isLastMessage,
      updateCachedConversation,
    ],
  );

  const catchUpConversation = useCallback(
    async (jid: string) => {
      const afterSeq = lastSeqByJidRef.current.get(jid) ?? 0;
      const res = await getConversationEvents(jid, afterSeq, 200);
      for (const event of res.events) {
        onImWsMessage({
          kind: 'realtime',
          event_type: 'im_event',
          jid,
          seq: event.seq,
          timestamp: event.created_at,
          payload: event.payload,
        });
      }
      if (res.events.length === 0 && typeof res.last_seq === 'number') {
        const prevSeq = lastSeqByJidRef.current.get(jid) ?? 0;
        if (res.last_seq > prevSeq)
          lastSeqByJidRef.current.set(jid, res.last_seq);
      }
    },
    [onImWsMessage],
  );

  const { subscribeAll, onReconnectRef } = useWebSocket(onImWsMessage);

  useEffect(() => {
    subscribeAll(conversations.map((c) => c.jid));
  }, [conversations, subscribeAll]);

  useEffect(() => {
    onReconnectRef.current = () => {
      for (const conversation of conversations) {
        void catchUpConversation(conversation.jid).catch(() => {});
      }
    };
    return () => {
      onReconnectRef.current = null;
    };
  }, [catchUpConversation, conversations, onReconnectRef]);

  useEffect(() => {
    if (!activeJid) {
      setInfoOpen(false);
      setMessages([]);
      setMembers([]);
      setDetail(null);
      setE2eeDeviceStatus(null);
      setChatError(null);
      setChatLoading(false);
      setHasMoreOlder(true);
      setHighlightedMessageId(null);
      return;
    }
    let cancelled = false;
    setChatError(null);
    const cached = conversationCacheRef.current.get(activeJid);
    const shouldFetch = shouldFetchConversationSnapshot(
      cached,
      Date.now(),
      CONVERSATION_CACHE_TTL_MS,
    );
    if (cached) {
      setMessages(cached.messages);
      setMembers(cached.members);
      setDetail(cached.detail);
      setHasMoreOlder(cached.hasMoreOlder);
      setChatLoading(false);
      if (!shouldFetch) {
        return () => {
          cancelled = true;
        };
      }
    } else {
      setMessages([]);
      setMembers([]);
      setDetail(null);
      setHasMoreOlder(true);
      setChatLoading(true);
    }
    (async () => {
      try {
        const [msgRes, memRes, detRes] = await Promise.all([
          getMessages(activeJid, undefined, MESSAGE_PAGE_SIZE),
          getMembers(activeJid),
          getConversationDetail(activeJid),
        ]);
        if (cancelled) return;
        const sortedMessages = sortMessages(msgRes.messages);
        const isEncryptedConversation =
          Number(detRes.conversation.e2ee_enabled || 0) === 1;
        const nextE2eeStatus =
          isEncryptedConversation && currentUserId
            ? await getImE2eeDeviceStatus(activeJid, currentUserId)
            : null;
        const displayMessages =
          isEncryptedConversation && currentUserId
            ? await decryptMessages(activeJid, currentUserId, sortedMessages)
            : sortedMessages;
        if (typeof msgRes.last_seq === 'number') {
          lastSeqByJidRef.current.set(activeJid, msgRes.last_seq);
        } else {
          const maxMessageSeq = sortedMessages.reduce(
            (max, message) => Math.max(max, message.im_seq || 0),
            0,
          );
          if (maxMessageSeq > 0)
            lastSeqByJidRef.current.set(activeJid, maxMessageSeq);
        }
        const hasMore = msgRes.messages.length >= MESSAGE_PAGE_SIZE;
        setMessages(displayMessages);
        setMembers(memRes.members);
        setDetail(detRes.conversation);
        setE2eeDeviceStatus(nextE2eeStatus);
        setHasMoreOlder(hasMore);
        cacheConversationSnapshot(activeJid, {
          messages: displayMessages,
          members: memRes.members,
          detail: detRes.conversation,
          hasMoreOlder: hasMore,
          lastLoadedAt: Date.now(),
        });
      } catch (e) {
        if (!cancelled) {
          setChatError(e instanceof Error ? e.message : t('im.加载会话失败'));
        }
      } finally {
        if (!cancelled) setChatLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeJid, cacheConversationSnapshot, currentUserId]);

  const refreshE2eeDeviceStatus = useCallback(
    async (jid: string) => {
      if (!currentUserId) return;
      try {
        const status = await getImE2eeDeviceStatus(jid, currentUserId);
        setE2eeDeviceStatus(status);
      } catch {
        setE2eeDeviceStatus(null);
      }
    },
    [currentUserId],
  );

  const loadOlder = useCallback(async () => {
    if (!activeJid || loadingOlder || !hasMoreOlder || olderBusyRef.current) {
      return;
    }
    const oldest = messages[0]?.timestamp;
    if (!oldest) return;
    olderBusyRef.current = true;
    setLoadingOlder(true);
    try {
      const { messages: rawBatch } = await getMessages(
        activeJid,
        oldest,
        MESSAGE_PAGE_SIZE,
      );
      const batch =
        Number(detail?.e2ee_enabled || 0) === 1 && currentUserId
          ? await decryptMessages(activeJid, currentUserId, rawBatch)
          : rawBatch;
      const nextHasMore = rawBatch.length >= MESSAGE_PAGE_SIZE;
      let mergedMessages: ImMessage[] = [];
      setMessages((prev) => {
        mergedMessages = mergeMessages(prev, batch);
        return mergedMessages;
      });
      setHasMoreOlder(nextHasMore);
      updateCachedConversation(activeJid, (snapshot) => ({
        ...snapshot,
        messages: mergedMessages,
        hasMoreOlder: nextHasMore,
        lastLoadedAt: Date.now(),
      }));
    } catch (e) {
      setChatError(e instanceof Error ? e.message : t('im.加载历史消息失败'));
    } finally {
      setLoadingOlder(false);
      olderBusyRef.current = false;
    }
  }, [
    activeJid,
    currentUserId,
    detail?.e2ee_enabled,
    hasMoreOlder,
    loadingOlder,
    messages,
    updateCachedConversation,
  ]);

  const activeConversation = useMemo((): ImConversation | null => {
    if (!activeJid) return null;
    const fromList = conversations.find((c) => c.jid === activeJid);
    if (!fromList) return null;
    if (!detail || detail.jid !== activeJid) return fromList;
    return { ...fromList, ...detail };
  }, [activeJid, conversations, detail]);

  const onStartDm = useCallback(
    async (friendUserId: string) => {
      try {
        const { jid } = await createDm(friendUserId);
        conversationCacheRef.current.delete(jid);
        await reloadLists();
        setActiveJid(jid);
        setSidebarTab('conversations');
      } catch (e) {
        setListError(e instanceof Error ? e.message : t('im.创建私聊失败'));
      }
    },
    [reloadLists],
  );

  const onSend = useCallback(
    async (
      text: string,
      attachmentIds: string[],
      encryptedAttachments?: PlainAttachmentMeta[],
    ) => {
      if (!activeJid) return;
      const tempId = `local-${createImUuid()}`;
      const retryPayload = {
        retry_text: text,
        retry_attachment_ids: attachmentIds,
        retry_encrypted_attachments: encryptedAttachments,
      };
      const optimistic: ImMessage = {
        id: tempId,
        chat_jid: activeJid,
        sender: currentUserId,
        sender_name: null,
        content: text || (attachmentIds.length > 0 ? '[文件]' : ''),
        timestamp: new Date().toISOString(),
        client_id: tempId,
        delivery_status: 'sending',
        ...retryPayload,
      };
      setMessages((prev) => mergeMessages(prev, [optimistic]));
      try {
        const isEncrypted = Number(activeConversation?.e2ee_enabled || 0) === 1;
        const encrypted = isEncrypted
          ? await encryptMessagePayload(
              activeJid,
              currentUserId,
              text,
              encryptedAttachments || [],
            )
          : undefined;
        const { message: storedMessage } = await sendMessage(
          activeJid,
          isEncrypted ? '' : text,
          attachmentIds.length > 0 ? attachmentIds : undefined,
          undefined,
          encrypted,
        );
        const message =
          encrypted && currentUserId
            ? (
                await decryptMessages(activeJid, currentUserId, [storedMessage])
              )[0] || storedMessage
            : storedMessage;
        setMessages((prev) =>
          mergeMessages(
            prev.filter((item) => item.id !== tempId),
            [message],
          ),
        );
        updateCachedConversation(activeJid, (snapshot) => ({
          ...snapshot,
          messages: mergeMessages(snapshot.messages, [message]),
          lastLoadedAt: Date.now(),
        }));
        setConversations((prev) => bumpConversationList(prev, message));
      } catch (e) {
        const message = e instanceof Error ? e.message : t('im.发送失败');
        setMessages((prev) =>
          prev.map((item) =>
            item.id === tempId
              ? {
                  ...item,
                  delivery_status: 'failed',
                  delivery_error: message,
                  ...retryPayload,
                }
              : item,
          ),
        );
        setChatError(message);
        throw e;
      }
    },
    [
      activeConversation?.e2ee_enabled,
      activeJid,
      currentUserId,
      t,
      updateCachedConversation,
    ],
  );

  const onRetryMessage = useCallback(
    async (messageId: string) => {
      const failed = messagesRef.current.find(
        (message) => message.id === messageId,
      );
      if (!failed || failed.delivery_status !== 'failed') return;
      setMessages((prev) => prev.filter((message) => message.id !== messageId));
      await onSend(
        failed.retry_text ?? failed.content,
        failed.retry_attachment_ids ?? [],
        failed.retry_encrypted_attachments as PlainAttachmentMeta[] | undefined,
      );
    },
    [onSend],
  );

  const onDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!activeJid) return;
      try {
        await deleteMessage(messageId, activeJid);
        const ts = new Date().toISOString();
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, deleted_at: ts } : m)),
        );
        updateCachedConversation(activeJid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId ? { ...m, deleted_at: ts } : m,
          ),
          lastLoadedAt: Date.now(),
        }));
        if (isLastMessage(activeJid, messageId)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.jid === activeJid
                ? { ...c, last_message_content: t('im.消息已撤回') }
                : c,
            ),
          );
        }
      } catch (e) {
        setChatError(e instanceof Error ? e.message : t('im.删除失败'));
      }
    },
    [activeJid, isLastMessage],
  );

  const onEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!activeJid) return;
      try {
        await editMessage(messageId, activeJid, newContent);
        const ts = new Date().toISOString();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, content: newContent, edited_at: ts }
              : m,
          ),
        );
        updateCachedConversation(activeJid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId
              ? { ...m, content: newContent, edited_at: ts }
              : m,
          ),
          lastLoadedAt: Date.now(),
        }));
        if (isLastMessage(activeJid, messageId)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.jid === activeJid
                ? { ...c, last_message_content: newContent }
                : c,
            ),
          );
        }
        setEditingMessage(null);
      } catch (e) {
        setChatError(e instanceof Error ? e.message : t('im.编辑失败'));
      }
    },
    [activeJid, isLastMessage],
  );

  const onReactMessage = useCallback(
    async (messageId: string, emoji: string) => {
      if (!activeJid) return;
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (!msg) return;
      const alreadyReacted = msg.reactions?.some(
        (r) => r.emoji === emoji && r.users?.includes(currentUserId),
      );
      const action: 'add' | 'remove' = alreadyReacted ? 'remove' : 'add';
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                reactions: applyReactionDelta(
                  m.reactions,
                  action,
                  emoji,
                  currentUserId,
                ),
              }
            : m,
        ),
      );
      updateCachedConversation(activeJid, (snapshot) => ({
        ...snapshot,
        messages: snapshot.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                reactions: applyReactionDelta(
                  m.reactions,
                  action,
                  emoji,
                  currentUserId,
                ),
              }
            : m,
        ),
        lastLoadedAt: Date.now(),
      }));
      try {
        if (action === 'remove') {
          await removeReaction(messageId, activeJid, emoji);
        } else {
          await addReaction(messageId, activeJid, emoji);
        }
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  reactions: applyReactionDelta(
                    m.reactions,
                    alreadyReacted ? 'add' : 'remove',
                    emoji,
                    currentUserId,
                  ),
                }
              : m,
          ),
        );
        updateCachedConversation(activeJid, (snapshot) => ({
          ...snapshot,
          messages: snapshot.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  reactions: applyReactionDelta(
                    m.reactions,
                    alreadyReacted ? 'add' : 'remove',
                    emoji,
                    currentUserId,
                  ),
                }
              : m,
          ),
          lastLoadedAt: Date.now(),
        }));
        setChatError(e instanceof Error ? e.message : t('im.操作失败'));
      }
    },
    [activeJid, currentUserId, updateCachedConversation],
  );

  const onStartEdit = useCallback((messageId: string) => {
    const msg = messagesRef.current.find((m) => m.id === messageId);
    if (msg) setEditingMessage(msg);
  }, []);

  const onDissolveGroup = useCallback(
    async (jid: string) => {
      setDissolveBusy(true);
      try {
        await dissolveGroup(jid);
        conversationCacheRef.current.delete(jid);
        setActiveJid(null);
        await reloadLists();
      } catch (e) {
        setChatError(e instanceof Error ? e.message : t('im.解散失败'));
      } finally {
        setDissolveBusy(false);
      }
    },
    [reloadLists],
  );

  const onCreatedGroup = useCallback(
    async (jid: string) => {
      conversationCacheRef.current.delete(jid);
      await reloadLists();
      setActiveJid(jid);
    },
    [reloadLists],
  );

  const sidebarNode = (
    <ImSidebar
      tab={sidebarTab}
      onTabChange={setSidebarTab}
      conversations={conversations}
      friends={friends}
      activeJid={activeJid}
      listsLoading={listsLoading}
      onSelectConversation={setActiveJid}
      onStartDm={onStartDm}
      onOpenCreateGroup={() => setCreateGroupOpen(true)}
      onOpenFriendRequests={() => setFriendReqOpen(true)}
      listError={listError}
      fullWidth={isMobile}
    />
  );

  const chatNode = (
    <ImChatView
      conversation={activeConversation}
      messages={messages}
      currentUserId={currentUserId}
      chatLoading={chatLoading}
      loadingOlder={loadingOlder}
      hasMoreOlder={hasMoreOlder}
      roomKeyAvailable={
        Number(activeConversation?.e2ee_enabled || 0) === 1
          ? (e2eeDeviceStatus?.roomKeyAvailable ?? false)
          : true
      }
      onLoadOlder={() => void loadOlder()}
      onSend={onSend}
      onToggleInfo={() => setInfoOpen((v) => !v)}
      infoPanelOpen={infoOpen}
      onBack={isMobile ? () => setActiveJid(null) : undefined}
      onDeleteMessage={onDeleteMessage}
      onEditMessage={onStartEdit}
      onReactMessage={onReactMessage}
      onRetryMessage={(messageId) =>
        void onRetryMessage(messageId).catch((err) => {
          setChatError(err instanceof Error ? err.message : t('im.发送失败'));
        })
      }
      highlightedMessageId={highlightedMessageId}
    />
  );

  useEffect(() => {
    if (isMobile || !activeJid) return;
    setInfoOpen(true);
  }, [activeJid, isMobile]);

  const infoNode =
    detail && activeJid ? (
      <ImInfoPanel
        open={infoOpen}
        mode={isMobile ? 'overlay' : 'docked'}
        onClose={() => setInfoOpen(false)}
        conversation={detail}
        members={members}
        currentUserId={currentUserId}
        onDissolveGroup={onDissolveGroup}
        busy={dissolveBusy}
        e2eeDeviceStatus={e2eeDeviceStatus}
        onRedistributeRoomKey={
          activeJid
            ? () =>
                shareExistingRoomKey(activeJid).then(() =>
                  refreshE2eeDeviceStatus(activeJid),
                )
            : undefined
        }
        onJumpToMessage={(messageId) => {
          setHighlightedMessageId(messageId);
          window.setTimeout(() => setHighlightedMessageId(null), 2000);
        }}
        onChanged={() => {
          if (activeJid) conversationCacheRef.current.delete(activeJid);
          void reloadLists();
          if (activeJid) void refreshE2eeDeviceStatus(activeJid);
        }}
      />
    ) : null;

  const showSidebar = isMobile ? !activeJid : true;
  const showChat = isMobile ? !!activeJid : true;
  const showDockedInfo = !isMobile && !!infoNode && infoOpen;

  return (
    <div className="page-view im-page-shell">
      <div className="im-workspace">
        {showSidebar && sidebarNode}
        {showChat && chatNode}
        {showDockedInfo ? infoNode : null}
      </div>
      {isMobile && infoOpen ? infoNode : null}
      {chatError ? (
        <div className="im-chat-error">
          <span>{chatError}</span>
          <button
            type="button"
            onClick={() => setChatError(null)}
            className="im-chat-error-close"
            title={t('im.关闭')}
          >
            ×
          </button>
        </div>
      ) : null}

      <ImCreateGroupDialog
        open={createGroupOpen}
        onClose={() => setCreateGroupOpen(false)}
        friends={friends}
        onCreated={(jid) => void onCreatedGroup(jid)}
      />
      <ImEditMessageDialog
        message={editingMessage}
        onClose={() => setEditingMessage(null)}
        onSubmit={onEditMessage}
      />
      <ImFriendRequestDialog
        open={friendReqOpen}
        onClose={() => setFriendReqOpen(false)}
        onChanged={() => void reloadLists()}
      />
    </div>
  );
}
