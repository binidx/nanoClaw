import {
  useCallback,
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
  normalizeConversationMessagesResponse,
  normalizeConversationRealtimeEvent,
} from '../conversation-realtime';

type ChatStateUpdater = (
  jid: string | null | undefined,
  updater: (state: ConversationChatState) => ConversationChatState,
) => void;

export function shouldIgnoreConversationRealtimeSeq(
  state: ConversationChatState | undefined,
  seq: number | undefined,
): boolean {
  return (
    typeof seq === 'number' &&
    typeof state?.lastEventSeq === 'number' &&
    seq <= state.lastEventSeq
  );
}

function applyLastEventSeq(
  state: ConversationChatState,
  seq: number | undefined,
): ConversationChatState {
  if (!Number.isFinite(seq)) return state;
  if ((state.lastEventSeq ?? Number.NEGATIVE_INFINITY) >= (seq as number)) {
    return state;
  }
  return {
    ...state,
    lastEventSeq: seq,
  };
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

export function shouldIgnoreStructuredStreamEvent(): boolean {
  return false;
}

export function shouldEagerlyRefreshActiveConversationMessage(params: {
  jid: string;
  activeJid: string | null | undefined;
  isBot: boolean;
  seen: boolean;
}): boolean {
  return (
    params.isBot &&
    params.jid === params.activeJid &&
    !params.seen
  );
}

export function mergePersistedAndTransientTurns(
  persistedTurns: AssistantTurn[],
  currentTurns: AssistantTurn[],
): AssistantTurn[] {
  const transientById = new Map(
    currentTurns.map((turn) => [turn.id, turn]),
  );
  const merged: AssistantTurn[] = [];

  for (const persisted of persistedTurns) {
    const transient = transientById.get(persisted.id);
    if (transient?.isLive && (!persisted.isCompleted || transient.items.length > 0)) {
      merged.push(transient);
    } else {
      merged.push(persisted);
    }
    transientById.delete(persisted.id);
  }

  for (const [, remaining] of transientById) {
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
    turns: mergePersistedAndTransientTurns(data.turns, reconciled.turns),
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

  useLayoutEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

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
            return {
              ...snapshot,
              turns: mergePersistedAndTransientTurns(
                persistedTurns,
                snapshot.turns,
              ),
            };
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
    [
      activeJidRef,
      apiBase,
      epochRef,
      seenIdsRef,
      updateConversationChatState,
    ],
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
            const dedupedTurns = olderTurns.filter((t) => !existingTurnIds.has(t.id));

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

        const msgId =
          normalized.message.id ||
          `ws_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const alreadySeen = seenIdsRef.current.has(msgId);
        const shouldEagerRefresh = shouldEagerlyRefreshActiveConversationMessage({
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
        if (normalized.done) {
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
          updateConversationChatState(normalized.jid, (state) =>
            applyLastEventSeq(
              applyConversationStreamEvent(state, {
                chunk: normalized.chunk,
                timestamp: normalized.timestamp || new Date().toISOString(),
                runId: normalized.runId,
              }),
              normalized.seq,
            ),
          );
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
        updateConversationChatState(normalized.jid, (state) =>
          applyLastEventSeq(
            interruptConversationState(state, {
              timestamp: normalized.timestamp || new Date().toISOString(),
              reason: normalized.reason || i18n.t('common.stoppedReply'),
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
      epochRef,
      loadMessages,
      scheduleConversationsRefresh,
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
