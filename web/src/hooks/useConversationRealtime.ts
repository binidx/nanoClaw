import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import i18n from '../i18n/index.ts';
import type {
  AssistantTurn,
  Conversation,
  ConversationChatState,
  ConversationMessagesResponse,
  Message,
} from '../app-types';
import {
  applyConversationLegacyEvent,
  applyConversationMessageEvent,
  applyConversationStreamEvent,
  applyConversationTurnEvent,
  applyConversationTypingEvent,
  getConversationMentionCandidates,
  getConversationTitle,
  getDisplayContent,
  interruptConversationState,
  reconcileConversationMessages,
  removeConversationApproval,
  resetConversationState,
  upsertConversationApproval,
} from '../app-helpers';
import {
  applyConversationRealtimeWatermark,
  normalizeConversationMessagesResponse,
  normalizeConversationRealtimeEvent,
  shouldIgnoreConversationRealtimeSeq,
} from '../conversation-realtime';

type ChatStateUpdater = (
  jid: string | null | undefined,
  updater: (state: ConversationChatState) => ConversationChatState,
) => void;

function applyLastEventSeq(
  state: ConversationChatState,
  seq: number | undefined,
): ConversationChatState {
  return applyConversationRealtimeWatermark(state, seq, 'live');
}

type UseConversationRealtimeParams = {
  apiBase: string;
  activeConversation: Conversation | null;
  activeJidRef: MutableRefObject<string | null>;
  chatStateRef: { readonly current: Record<string, ConversationChatState> };
  epochRef: MutableRefObject<number>;
  seenIdsRef: MutableRefObject<Set<string>>;
  updateConversationChatState: ChatStateUpdater;
  scheduleConversationsRefresh: (delay?: number) => void;
  setUnreadRepliesByJid: Dispatch<SetStateAction<Record<string, number>>>;
  setInterruptingConversationJid: Dispatch<SetStateAction<string | null>>;
};

export const MESSAGE_PAGE_SIZE = 50;
const STREAM_BUFFER_FLUSH_MS = 48;
const CANCELLED_TURN_TTL_MS = 10 * 60 * 1000;
const LEGACY_STREAM_INTERRUPT_SUPPRESS_MS = 2_000;

export { shouldIgnoreConversationRealtimeSeq };

type BufferedStreamPatch = {
  jid: string;
  chunks: string[];
  timestamp: string;
  runId?: string;
  seq?: number;
};

function getStreamBufferKey(jid: string, runId?: string): string {
  return `${jid}\u0000${runId || 'legacy'}`;
}

function shouldKeepUnpersistedTurn(
  turn: AssistantTurn,
  visibleMessageIds?: ReadonlySet<string>,
): boolean {
  return (
    turn.isLive ||
    !turn.isCompleted ||
    !turn.persistedMessageId ||
    visibleMessageIds?.has(turn.persistedMessageId) ||
    turn.items.some((item) => item.status === 'in_progress')
  );
}

export function shouldIgnoreStructuredStreamEvent(): boolean {
  return false;
}

export function shouldEagerlyRefreshActiveConversationMessage(params: {
  jid: string;
  activeJid: string | null | undefined;
  isBot: boolean;
  seen: boolean;
}): boolean {
  return params.isBot && params.jid === params.activeJid && !params.seen;
}

export function mergePersistedAndTransientTurns(
  persistedTurns: AssistantTurn[],
  currentTurns: AssistantTurn[],
  visibleMessageIds?: ReadonlySet<string>,
): AssistantTurn[] {
  const transientById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const merged: AssistantTurn[] = [];

  for (const persisted of persistedTurns) {
    const transient = transientById.get(persisted.id);
    if (
      transient?.isLive &&
      (!persisted.isCompleted || transient.items.length > 0)
    ) {
      merged.push(transient);
    } else {
      merged.push(persisted);
    }
    transientById.delete(persisted.id);
  }

  for (const [, remaining] of transientById) {
    if (!shouldKeepUnpersistedTurn(remaining, visibleMessageIds)) continue;
    merged.push(remaining);
  }

  return merged;
}

export function applyConversationMessagesSnapshot(params: {
  state: ConversationChatState;
  data: ConversationMessagesResponse;
  channel?: string;
  conversationName?: string;
}): ConversationChatState {
  const { state, data, channel, conversationName } = params;
  const reconciled = reconcileConversationMessages({
    state,
    messages: data.messages,
    channel,
    conversationName,
  }).state;

  return {
    ...reconciled,
    ...applyConversationRealtimeWatermark(
      reconciled,
      data.last_event_seq,
      'snapshot',
    ),
    turns: mergePersistedAndTransientTurns(
      data.turns,
      reconciled.turns,
      new Set(data.messages.map((message) => message.id)),
    ),
    approvals: data.approvals ?? state.approvals,
  };
}

export function useConversationRealtime({
  apiBase,
  activeConversation,
  activeJidRef,
  chatStateRef,
  epochRef,
  seenIdsRef,
  updateConversationChatState,
  scheduleConversationsRefresh,
  setUnreadRepliesByJid,
  setInterruptingConversationJid,
}: UseConversationRealtimeParams) {
  const activeConversationRef = useRef(activeConversation);
  const streamBuffersRef = useRef<Map<string, BufferedStreamPatch>>(new Map());
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const cancelledTurnIdsRef = useRef<Map<string, number>>(new Map());
  const legacyStreamSuppressedUntilByJidRef = useRef<Map<string, number>>(
    new Map(),
  );

  useLayoutEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  const flushBufferedStreams = useCallback(
    (jid?: string) => {
      const pending: BufferedStreamPatch[] = [];
      for (const [key, buffer] of streamBuffersRef.current) {
        if (jid && buffer.jid !== jid) continue;
        pending.push(buffer);
        streamBuffersRef.current.delete(key);
      }

      for (const buffer of pending) {
        const chunk = buffer.chunks.join('');
        if (!chunk) continue;
        updateConversationChatState(buffer.jid, (state) => {
          if (shouldIgnoreConversationRealtimeSeq(state, buffer.seq)) {
            return state;
          }
          return applyLastEventSeq(
            applyConversationStreamEvent(state, {
              chunk,
              timestamp: buffer.timestamp,
              runId: buffer.runId,
            }),
            buffer.seq,
          );
        });
      }
    },
    [updateConversationChatState],
  );

  const discardBufferedStreams = useCallback((jid: string, runId?: string) => {
    if (runId) {
      streamBuffersRef.current.delete(getStreamBufferKey(jid, runId));
      return;
    }
    for (const [key, buffer] of streamBuffersRef.current) {
      if (buffer.jid === jid) {
        streamBuffersRef.current.delete(key);
      }
    }
  }, []);

  const markCancelledTurn = useCallback(
    (jid: string, turnId?: string) => {
      const now = Date.now();
      for (const [key, expiresAt] of cancelledTurnIdsRef.current) {
        if (expiresAt <= now) cancelledTurnIdsRef.current.delete(key);
      }
      if (turnId) {
        cancelledTurnIdsRef.current.set(
          getStreamBufferKey(jid, turnId),
          now + CANCELLED_TURN_TTL_MS,
        );
        discardBufferedStreams(jid, turnId);
      }
      legacyStreamSuppressedUntilByJidRef.current.set(
        jid,
        now + LEGACY_STREAM_INTERRUPT_SUPPRESS_MS,
      );
    },
    [discardBufferedStreams],
  );

  const isCancelledTurn = useCallback((jid: string, turnId?: string) => {
    const now = Date.now();
    if (!turnId) {
      const suppressUntil =
        legacyStreamSuppressedUntilByJidRef.current.get(jid);
      if (!suppressUntil) return false;
      if (suppressUntil <= now) {
        legacyStreamSuppressedUntilByJidRef.current.delete(jid);
        return false;
      }
      return true;
    }
    const key = getStreamBufferKey(jid, turnId);
    const expiresAt = cancelledTurnIdsRef.current.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
      cancelledTurnIdsRef.current.delete(key);
      return false;
    }
    return true;
  }, []);

  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushTimerRef.current !== null) return;
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null;
      flushBufferedStreams();
    }, STREAM_BUFFER_FLUSH_MS);
  }, [flushBufferedStreams]);

  useEffect(
    () => () => {
      if (streamFlushTimerRef.current !== null) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      streamBuffersRef.current.clear();
      cancelledTurnIdsRef.current.clear();
      legacyStreamSuppressedUntilByJidRef.current.clear();
    },
    [],
  );

  const loadMessages = useCallback(
    async (jid: string, epoch: number) => {
      try {
        const res = await fetch(
          `${apiBase}/api/conversations/${encodeURIComponent(jid)}/messages?limit=${MESSAGE_PAGE_SIZE}`,
        );
        if (!res.ok || epoch !== epochRef.current) return;

        const data = normalizeConversationMessagesResponse(await res.json());
        const msgs: Message[] = data.messages;
        const persistedTurns: AssistantTurn[] = Array.isArray(data.turns)
          ? data.turns
          : [];
        const isActiveConversation = jid === activeJidRef.current;

        if (isActiveConversation) {
          seenIdsRef.current = new Set(msgs.map((message) => message.id));
        }
        const conv = activeConversationRef.current;
        const conversationName = isActiveConversation
          ? getConversationTitle(conv)
          : undefined;
        const conversationChannel = isActiveConversation
          ? conv?.channel
          : undefined;
        updateConversationChatState(jid, (state) => {
          const hasOlderMessages = state.messages.length > msgs.length;
          if (hasOlderMessages) {
            const newIds = new Set(msgs.map((m) => m.id));
            const olderOnly = state.messages.filter((m) => !newIds.has(m.id));
            const merged = [...olderOnly, ...msgs];
            const snapshot = applyConversationMessagesSnapshot({
              state,
              data: { ...data, messages: merged, turns: persistedTurns },
              channel: conversationChannel,
              conversationName,
            });
            return snapshot;
          }
          return applyConversationMessagesSnapshot({
            state,
            data: { ...data, messages: msgs, turns: persistedTurns },
            channel: conversationChannel,
            conversationName,
          });
        });
      } catch {
        /* offline */
      }
    },
    [activeJidRef, apiBase, epochRef, seenIdsRef, updateConversationChatState],
  );

  const loadOlderMessages = useCallback(
    async (jid: string, before: string, epoch: number): Promise<number> => {
      try {
        const url =
          `${apiBase}/api/conversations/${encodeURIComponent(jid)}/messages` +
          `?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`;
        const res = await fetch(url);
        if (!res.ok || epoch !== epochRef.current) return 0;

        const data = normalizeConversationMessagesResponse(await res.json());
        const olderMsgs: Message[] = data.messages;
        const olderTurns: AssistantTurn[] = Array.isArray(data.turns)
          ? data.turns
          : [];
        if (olderMsgs.length === 0) return 0;

        const currentState = chatStateRef.current[jid];
        const existingIds = new Set(currentState?.messages.map((m) => m.id));
        const deduped = olderMsgs.filter((m) => !existingIds.has(m.id));
        const insertedCount = deduped.length;

        if (insertedCount > 0) {
          updateConversationChatState(jid, (state) => {
            const freshIds = new Set(state.messages.map((m) => m.id));
            const toInsert = olderMsgs.filter((m) => !freshIds.has(m.id));

            const existingTurnIds = new Set(state.turns.map((t) => t.id));
            const dedupedTurns = olderTurns.filter(
              (t) => !existingTurnIds.has(t.id),
            );

            return {
              ...state,
              messages: [...toInsert, ...state.messages],
              turns: [...dedupedTurns, ...state.turns],
            };
          });
        }
        return insertedCount;
      } catch {
        return 0;
      }
    },
    [apiBase, chatStateRef, epochRef, updateConversationChatState],
  );

  const handleWsMessage = useCallback(
    (data: Record<string, unknown>) => {
      const normalized = normalizeConversationRealtimeEvent(data);
      if (!normalized) return;

      const activeJid = activeJidRef.current;
      const currentEpoch = epochRef.current;
      const currentState = chatStateRef.current[normalized.jid];
      if (shouldIgnoreConversationRealtimeSeq(currentState, normalized.seq)) {
        return;
      }

      if (normalized.kind === 'message') {
        if (currentEpoch !== epochRef.current) return;
        const messageTurnId =
          normalized.message.turn_id || normalized.message.run_id;
        if (
          normalized.isBot &&
          isCancelledTurn(normalized.jid, messageTurnId)
        ) {
          return;
        }
        flushBufferedStreams(normalized.jid);

        const msgId =
          normalized.message.id ||
          `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const alreadySeen = seenIdsRef.current.has(msgId);
        const shouldEagerRefresh =
          shouldEagerlyRefreshActiveConversationMessage({
            jid: normalized.jid,
            activeJid,
            isBot: normalized.isBot,
            seen: alreadySeen,
          });

        if (!alreadySeen && normalized.jid === activeJid) {
          seenIdsRef.current.add(msgId);
          const convRef = activeConversationRef.current;
          const displayContent = getDisplayContent(
            normalized.message.content,
            normalized.isBot,
            convRef?.channel,
            getConversationMentionCandidates(convRef),
          );

          updateConversationChatState(normalized.jid, (state) =>
            applyLastEventSeq(
              applyConversationMessageEvent(state, {
                message: {
                  ...normalized.message,
                  id: msgId,
                  is_bot_message: normalized.isBot
                    ? 1
                    : normalized.message.is_bot_message,
                },
                turnId: normalized.message.turn_id ?? null,
                displayContent,
              }),
              normalized.seq,
            ),
          );
          if (shouldEagerRefresh) {
            void loadMessages(normalized.jid, currentEpoch);
          }
        } else if (normalized.isBot) {
          if (normalized.jid !== activeJid) {
            setUnreadRepliesByJid((prev) => ({
              ...prev,
              [normalized.jid]: (prev[normalized.jid] || 0) + 1,
            }));
          }
          void loadMessages(normalized.jid, currentEpoch);
        }

        scheduleConversationsRefresh();
        return;
      }

      if (normalized.kind === 'turn_event') {
        if (currentEpoch !== epochRef.current) return;
        if (isCancelledTurn(normalized.jid, normalized.event.turnId)) {
          discardBufferedStreams(normalized.jid, normalized.event.turnId);
          return;
        }
        flushBufferedStreams(normalized.jid);

        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            applyConversationTurnEvent(state, normalized.event),
            normalized.seq ?? normalized.event.seq,
          ),
        );

        if (
          normalized.event.type === 'turn.completed' ||
          normalized.event.type === 'turn.failed'
        ) {
          scheduleConversationsRefresh();
        }
        return;
      }

      if (normalized.kind === 'stream') {
        if (currentEpoch !== epochRef.current) return;
        if (isCancelledTurn(normalized.jid, normalized.runId)) {
          discardBufferedStreams(normalized.jid, normalized.runId);
          return;
        }
        if (normalized.done) {
          flushBufferedStreams(normalized.jid);
          if (normalized.jid === activeJid) {
            updateConversationChatState(normalized.jid, (state) =>
              applyLastEventSeq(
                applyConversationStreamEvent(state, {
                  done: true,
                  timestamp: normalized.timestamp || new Date().toISOString(),
                  runId: normalized.runId,
                }),
                normalized.seq,
              ),
            );
          }
          scheduleConversationsRefresh();
          return;
        }
        if (normalized.jid === activeJid) {
          const key = getStreamBufferKey(normalized.jid, normalized.runId);
          const existing = streamBuffersRef.current.get(key);
          const timestamp = normalized.timestamp || new Date().toISOString();
          const seq =
            typeof normalized.seq === 'number'
              ? Math.max(
                  existing?.seq ?? Number.NEGATIVE_INFINITY,
                  normalized.seq,
                )
              : existing?.seq;
          if (existing) {
            existing.chunks.push(normalized.chunk);
            existing.timestamp = timestamp;
            existing.seq = seq;
          } else {
            streamBuffersRef.current.set(key, {
              jid: normalized.jid,
              chunks: [normalized.chunk],
              timestamp,
              runId: normalized.runId,
              seq,
            });
          }
          scheduleStreamFlush();
        }
        return;
      }

      if (normalized.kind === 'typing') {
        if (currentEpoch !== epochRef.current) return;
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            applyConversationTypingEvent(state, {
              isTyping: normalized.isTyping,
              timestamp: normalized.timestamp || new Date().toISOString(),
            }),
            normalized.seq,
          ),
        );
        return;
      }

      if (normalized.kind === 'agent_event') {
        if (currentEpoch !== epochRef.current) return;
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            applyConversationLegacyEvent(state, normalized.event),
            normalized.seq,
          ),
        );
        return;
      }

      if (normalized.kind === 'approval_request') {
        if (currentEpoch !== epochRef.current) return;
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            upsertConversationApproval(state, normalized.approval),
            normalized.seq,
          ),
        );
        return;
      }

      if (normalized.kind === 'approval_resolved') {
        if (currentEpoch !== epochRef.current) return;
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            removeConversationApproval(state, normalized.resolution.id),
            normalized.seq,
          ),
        );
        return;
      }

      if (normalized.kind === 'reset') {
        if (currentEpoch !== epochRef.current) return;
        if (normalized.jid === activeJid) {
          seenIdsRef.current = new Set();
        }
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            resetConversationState(state, {
              clearMessages: normalized.jid === activeJid,
            }),
            normalized.seq,
          ),
        );
        if (normalized.jid === activeJid) {
          void loadMessages(normalized.jid, currentEpoch);
        }
        scheduleConversationsRefresh();
        return;
      }

      if (normalized.kind === 'interrupted') {
        if (currentEpoch !== epochRef.current) return;
        const interruptedTurnId = normalized.turnId || normalized.runId;
        markCancelledTurn(normalized.jid, interruptedTurnId);
        discardBufferedStreams(normalized.jid, interruptedTurnId);
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            interruptConversationState(state, {
              timestamp: normalized.timestamp || new Date().toISOString(),
              reason: normalized.reason || i18n.t('common.stoppedReply'),
              turnId: interruptedTurnId,
            }),
            normalized.seq,
          ),
        );
        setInterruptingConversationJid((current) =>
          current === normalized.jid ? null : current,
        );
        void loadMessages(normalized.jid, currentEpoch);
        scheduleConversationsRefresh();
      }
    },
    [
      activeJidRef,
      chatStateRef,
      discardBufferedStreams,
      epochRef,
      flushBufferedStreams,
      isCancelledTurn,
      loadMessages,
      markCancelledTurn,
      scheduleConversationsRefresh,
      scheduleStreamFlush,
      seenIdsRef,
      setInterruptingConversationJid,
      setUnreadRepliesByJid,
      updateConversationChatState,
    ],
  );

  return {
    loadMessages,
    loadOlderMessages,
    handleWsMessage,
  };
}
