import i18n from './i18n/index.ts';
import type {
  AssistantTurn,
  ApprovalRequest,
  ChatTimelineEntry,
  ConfigEffect,
  Conversation,
  ConversationItem,
  PendingMessage,
  ConversationChatState,
  Message,
  TurnEvent,
  TurnItem,
  TurnItemStatus,
} from './app-types';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

export function formatTime(ts: string) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatUptime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function stripLeadingMention(content: string, name?: string | string[]) {
  if (!content) return '';

  const names = Array.isArray(name) ? name : [name];
  const candidates = ['Web User', 'Web', ...names]
    .filter((candidate): candidate is string => !!candidate?.trim())
    .sort((left, right) => right.length - left.length);

  let nextContent = content;

  for (const candidate of candidates) {
    const pattern = new RegExp(
      `^@${escapeRegExp(candidate)}(?=\\s|[,，:：!！—-]|$)`,
      'i',
    );
    if (pattern.test(nextContent)) {
      nextContent = nextContent.replace(pattern, '');
      break;
    }
  }

  nextContent = nextContent
    .replace(/^@[^\s,，:：!！—-]+(?=\s|[,，:：!！—-]|$)/, '')
    .replace(/^[\s,，:：!！—-]+/, '')
    .trimStart();

  return nextContent;
}

function stripMessagesEnvelope(content: string) {
  const trimmed = content.trimStart();
  const isEnvelope =
    /^<messages(?:\s|>)/i.test(trimmed) ||
    /^<message\b[^>]*\bsender=/i.test(trimmed);
  if (!isEnvelope) return content;

  return content
    .replace(/<\/message>\s*<message\b[^>]*>/gi, '\n\n')
    .replace(/<\/?messages\b[^>]*>/gi, '')
    .replace(/<message\b[^>]*>/gi, '')
    .replace(/<\/message>/gi, '')
    .trim();
}

export function getDisplayContent(
  content: string,
  isBot: boolean,
  channel?: string,
  name?: string | string[],
) {
  const normalizedContent = isBot ? stripMessagesEnvelope(content) : content;

  if (channel === 'web') {
    return stripLeadingMention(normalizedContent, name);
  }

  if (isBot) {
    return normalizedContent;
  }

  return stripLeadingMention(normalizedContent, name);
}

export function appendStreamChunk(previous: string, chunk: string) {
  return `${previous}${chunk}`;
}

export function formatConfigEffectLabel(effect: ConfigEffect) {
  switch (effect) {
    case 'instant':
      return i18n.t('common.formatConfigEffect.instant');
    case 'new_agent':
      return i18n.t('common.formatConfigEffect.newAgent');
    case 'restart':
      return i18n.t('common.formatConfigEffect.restart');
  }
}

export function buildConfigSaveMessage(
  effects?: Record<ConfigEffect, string[]>,
  changedKeys?: string[],
) {
  if (!changedKeys || changedKeys.length === 0) {
    return i18n.t('common.buildConfigSave.noChange');
  }

  const parts: string[] = [];
  if (effects?.instant?.length) {
    parts.push(
      i18n.t('common.buildConfigSave.instantEffect', {
        items: effects.instant.join('、'),
      }),
    );
  }
  if (effects?.new_agent?.length) {
    parts.push(
      i18n.t('common.buildConfigSave.newAgentEffect', {
        items: effects.new_agent.join('、'),
      }),
    );
  }
  if (effects?.restart?.length) {
    parts.push(
      i18n.t('common.buildConfigSave.restartEffect', {
        items: effects.restart.join('、'),
      }),
    );
  }

  return parts.length > 0
    ? parts.join('；')
    : i18n.t('common.buildConfigSave.saved');
}

function normalizeComparedMessageContent(
  content: string,
  isBot: boolean,
  channel?: string,
  name?: string,
) {
  return getDisplayContent(content, isBot, channel, name)
    .replace(/\[上传文件\][^\n\r]*/g, '[上传文件]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPendingMessageResolved(
  pendingMessage: PendingMessage,
  persistedMessage: Message,
  channel?: string,
  name?: string,
) {
  if (pendingMessage.is_bot_message || persistedMessage.is_bot_message)
    return false;
  if (
    pendingMessage.clientId &&
    persistedMessage.client_id &&
    pendingMessage.clientId === persistedMessage.client_id
  ) {
    return true;
  }
  if (
    pendingMessage.runId &&
    persistedMessage.run_id &&
    pendingMessage.runId === persistedMessage.run_id
  ) {
    return true;
  }

  const pendingContent = normalizeComparedMessageContent(
    pendingMessage.content,
    false,
    channel,
    name,
  );
  const persistedContent = normalizeComparedMessageContent(
    persistedMessage.content,
    false,
    channel,
    name,
  );

  if (!pendingContent || pendingContent !== persistedContent) return false;

  const pendingTime = Date.parse(pendingMessage.timestamp);
  const persistedTime = Date.parse(persistedMessage.timestamp);
  if (!Number.isFinite(pendingTime) || !Number.isFinite(persistedTime))
    return false;

  // Only allow matching with a persisted message that is not older than the
  // optimistic pending message (except tiny clock jitter). This prevents
  // resolving against an earlier identical user message and avoids UI jump.
  const maxEarlyJitterMs = 5000;
  return (
    persistedTime >= pendingTime - maxEarlyJitterMs &&
    persistedTime - pendingTime <= 120000
  );
}

export function truncatePreview(text: string, limit = 160) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}…`;
}

export function compareConversationItems(
  left: ConversationItem,
  right: ConversationItem,
) {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }

  return left.order - right.order;
}

function pickLatestTimestamp(current: string, incoming?: string) {
  if (!incoming) return current;

  const currentMs = Date.parse(current);
  const incomingMs = Date.parse(incoming);
  if (Number.isFinite(currentMs) && Number.isFinite(incomingMs)) {
    return new Date(Math.max(currentMs, incomingMs)).toISOString();
  }

  return incoming || current;
}

export function compareTimelineEntries(
  left: ChatTimelineEntry,
  right: ChatTimelineEntry,
) {
  const isRealtimeEntry = (entry: ChatTimelineEntry) => {
    if (entry.kind === 'user_message') {
      return entry.pending;
    }

    if (entry.kind === 'assistant_message') {
      return (
        Boolean(entry.turnId) &&
        (entry.status === 'in_progress' || !entry.messageId)
      );
    }

    if (entry.kind === 'reasoning' || entry.kind === 'tool_call') {
      return entry.item.status === 'in_progress';
    }

    if (entry.kind === 'approval') {
      return Boolean(entry.turnId);
    }

    return false;
  };

  const leftRealtime = isRealtimeEntry(left);
  const rightRealtime = isRealtimeEntry(right);

  const leftPendingUser = left.kind === 'user_message' && left.pending;
  const rightPendingUser = right.kind === 'user_message' && right.pending;
  const leftRealtimeNonUser = leftRealtime && !(left.kind === 'user_message');
  const rightRealtimeNonUser =
    rightRealtime && !(right.kind === 'user_message');

  // Keep pending user message in front of live assistant/reasoning/tool entries
  // to avoid "AI loading appears first, user bubble appears later" jumping.
  if (leftPendingUser && rightRealtimeNonUser) return -1;
  if (rightPendingUser && leftRealtimeNonUser) return 1;

  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }

  const realtimeRank = (entry: ChatTimelineEntry) => {
    if (entry.kind === 'user_message' && entry.pending) return 0;
    if (entry.kind === 'assistant_message') return 1;
    if (entry.kind === 'reasoning') return 2;
    if (entry.kind === 'tool_call') return 3;
    if (entry.kind === 'approval') return 4;
    return 5;
  };

  // Same timestamp: keep user messages in front to avoid "AI first, user later" jumps.
  if (left.kind === 'user_message' && right.kind !== 'user_message') return -1;
  if (left.kind !== 'user_message' && right.kind === 'user_message') return 1;

  if (leftRealtime && rightRealtime) {
    const leftRank = realtimeRank(left);
    const rightRank = realtimeRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
  } else if (leftRealtime !== rightRealtime) {
    const leftRank = realtimeRank(left);
    const rightRank = realtimeRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  return left.order - right.order;
}

export function deriveConversationReplyState(chatState: ConversationChatState) {
  const streaming = chatState.turns.some((turn) =>
    turn.items.some(
      (item) =>
        item.type === 'assistant_message' && item.status === 'in_progress',
    ),
  );
  const waitingReply =
    chatState.pendingMessages.length > 0 ||
    chatState.approvals.length > 0 ||
    chatState.turns.some((turn) => turn.isLive);
  const typing = waitingReply && !streaming;

  return {
    typing,
    streaming,
    waitingReply,
    busy: typing || streaming || waitingReply,
  };
}

export function buildChatTimelineEntries(params: {
  messages: Array<Message | PendingMessage>;
  turns: AssistantTurn[];
  approvals: ApprovalRequest[];
}) {
  const entries: ChatTimelineEntry[] = [];
  const attachedBotMessageIds = new Set<string>();
  const attachedTurnIds = new Set<string>();
  const attachedRunIds = new Set<string>();
  const approvalsByToolCallId = new Map<string, ApprovalRequest[]>();
  for (const approval of params.approvals) {
    const list = approvalsByToolCallId.get(approval.toolCallId) || [];
    list.push(approval);
    approvalsByToolCallId.set(approval.toolCallId, list);
  }

  for (const turn of params.turns) {
    if (turn.persistedMessageId) {
      attachedBotMessageIds.add(turn.persistedMessageId);
    }
    if (turn.id) {
      attachedTurnIds.add(turn.id);
      attachedRunIds.add(turn.id);
    }
  }

  let order = 0;
  for (const message of params.messages) {
    const pending = 'clientId' in message;
    if (message.is_bot_message) {
      const messageTurnId = message.turn_id?.trim();
      const messageRunId = message.run_id?.trim();
      const isAttachedToTurn =
        attachedBotMessageIds.has(message.id) ||
        (!!messageTurnId && attachedTurnIds.has(messageTurnId)) ||
        (!!messageRunId && attachedRunIds.has(messageRunId));
      if (isAttachedToTurn) {
        continue;
      }
      entries.push({
        kind: 'assistant_message',
        key: `message:${message.id}`,
        timestamp: message.timestamp,
        order: order++,
        text: message.content,
        status: 'completed',
        messageId: message.id,
      });
      continue;
    }

    entries.push({
      kind: 'user_message',
      key: `message:${message.id}`,
      timestamp: message.timestamp,
      order: order++,
      message,
      pending,
    });
  }

  const attachedApprovalIds = new Set<string>();
  for (const turn of params.turns) {
    const turnKey = turn.clientKey || turn.id;
    let turnHasRenderableEntry = false;

    for (const item of turn.items) {
      if (item.type === 'reasoning') {
        turnHasRenderableEntry = true;
        entries.push({
          kind: 'reasoning',
          key: `turn:${turnKey}:reasoning:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          item,
          turnId: turn.id,
        });
        continue;
      }

      if (item.type === 'tool_call') {
        turnHasRenderableEntry = true;
        const itemApprovals = approvalsByToolCallId.get(item.id) || [];
        itemApprovals.forEach((approval) =>
          attachedApprovalIds.add(approval.id),
        );
        entries.push({
          kind: 'tool_call',
          key: `turn:${turnKey}:tool:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          item,
          turnId: turn.id,
          approval: itemApprovals[0],
        });
        continue;
      }

      if (item.text?.trim()) {
        turnHasRenderableEntry = true;
        entries.push({
          kind: 'assistant_message',
          key: `turn:${turnKey}:assistant:${item.id}`,
          timestamp: item.timestamp || turn.timestamp,
          order: order++,
          text: item.text,
          status: item.status,
          turnId: turn.id,
          messageId: turn.persistedMessageId,
        });
      }
    }

    if (!turnHasRenderableEntry && turn.isLive) {
      entries.push({
        kind: 'assistant_message',
        key: `turn:${turnKey}:assistant:${turn.id}:stream-assistant`,
        timestamp: turn.timestamp,
        order: order++,
        text: '',
        status: 'in_progress',
        turnId: turn.id,
      });
    }

    if (turn.error) {
      entries.push({
        kind: 'turn_error',
        key: `turn:${turnKey}:error`,
        timestamp: turn.timestamp,
        order: order++,
        error: turn.error,
        turnId: turn.id,
      });
    }
  }

  for (const approval of params.approvals) {
    if (attachedApprovalIds.has(approval.id)) continue;
    entries.push({
      kind: 'approval',
      key: `approval:${approval.id}`,
      timestamp: approval.createdAt,
      order: order++,
      approval,
    });
  }

  return entries.sort(compareTimelineEntries);
}

export function upsertTurn(
  turns: AssistantTurn[],
  turnId: string,
  timestamp: string,
): AssistantTurn[] {
  const existingIndex = turns.findIndex((turn) => turn.id === turnId);
  if (existingIndex >= 0) {
    const next = [...turns];
    next[existingIndex] = {
      ...next[existingIndex],
      timestamp: pickLatestTimestamp(next[existingIndex].timestamp, timestamp),
      isLive: true,
    };
    return next;
  }

  return [
    ...turns,
    {
      id: turnId,
      clientKey: turnId,
      timestamp,
      items: [],
      isLive: true,
      isCompleted: false,
    },
  ];
}

export function upsertTurnItem(
  turns: AssistantTurn[],
  event: Extract<
    TurnEvent,
    { type: 'item.started' | 'item.updated' | 'item.completed' }
  >,
): AssistantTurn[] {
  const next = upsertTurn(turns, event.turnId, event.timestamp);
  const turnIndex = next.findIndex((turn) => turn.id === event.turnId);
  if (turnIndex < 0) return next;

  const turn = stripOptimisticThinkingFromTurn(next[turnIndex]);
  const baseItems =
    event.item.type === 'assistant_message'
      ? stripLegacyAssistantItems(turn.items)
      : turn.items;
  const itemIndex = baseItems.findIndex((item) => item.id === event.item.id);
  const existingItem = itemIndex >= 0 ? baseItems[itemIndex] : undefined;
  const items = [...baseItems];
  let nextItem = event.item;
  if (event.item.type === 'tool_call') {
    nextItem = {
      ...event.item,
      startedAt:
        event.item.startedAt ||
        (existingItem?.type === 'tool_call'
          ? existingItem.startedAt
          : undefined) ||
        (event.type === 'item.started' ? event.item.timestamp : undefined),
      completedAt:
        event.item.completedAt ||
        (event.type === 'item.completed' || event.item.status !== 'in_progress'
          ? event.item.timestamp
          : existingItem?.type === 'tool_call'
            ? existingItem.completedAt
            : undefined),
    };
  }
  if (itemIndex >= 0) {
    items[itemIndex] = { ...items[itemIndex], ...nextItem };
  } else {
    items.push(nextItem);
  }

  next[turnIndex] = {
    ...turn,
    timestamp: pickLatestTimestamp(
      turn.timestamp,
      event.timestamp || event.item.timestamp,
    ),
    isLive:
      event.type !== 'item.completed' ||
      event.item.type !== 'assistant_message' ||
      event.item.status === 'in_progress',
    items,
  };
  return next;
}

export function markTurnCompleted(
  turns: AssistantTurn[],
  turnId: string,
  timestamp: string,
  error?: string,
): AssistantTurn[] {
  const next = upsertTurn(turns, turnId, timestamp);
  const index = next.findIndex((turn) => turn.id === turnId);
  if (index < 0) return next;
  const stripped = stripOptimisticThinkingFromTurn(next[index]);
  const completedItems = stripped.items.map((item) =>
    item.type === 'assistant_message' && item.status === 'in_progress'
      ? { ...item, status: 'completed' as const, timestamp }
      : item,
  );
  next[index] = {
    ...stripped,
    items: completedItems,
    timestamp: pickLatestTimestamp(stripped.timestamp, timestamp),
    isLive: false,
    isCompleted: true,
    error,
  };
  return next;
}

const OPTIMISTIC_TURN_PREFIX = 'optimistic-turn:';
const OPTIMISTIC_THINKING_SUFFIX = ':optimistic-thinking';

export function isOptimisticTurnId(turnId: string) {
  return turnId.startsWith(OPTIMISTIC_TURN_PREFIX);
}

export function isOptimisticThinkingItem(itemId: string) {
  return itemId.includes(OPTIMISTIC_THINKING_SUFFIX);
}

function stripOptimisticThinkingItems(items: TurnItem[]): TurnItem[] {
  const filtered = items.filter((item) => !isOptimisticThinkingItem(item.id));
  return filtered.length === items.length ? items : filtered;
}

function isLegacyAssistantItemId(itemId: string) {
  return (
    itemId.includes(':legacy-assistant:') || itemId.includes(':legacy-final:')
  );
}

function stripLegacyAssistantItems(items: TurnItem[]): TurnItem[] {
  const filtered = items.filter(
    (item) =>
      !(item.type === 'assistant_message' && isLegacyAssistantItemId(item.id)),
  );
  return filtered.length === items.length ? items : filtered;
}

function stripOptimisticThinkingFromTurn(turn: AssistantTurn): AssistantTurn {
  const items = stripOptimisticThinkingItems(turn.items);
  return items === turn.items ? turn : { ...turn, items };
}

export function clearOptimisticTurns(turns: AssistantTurn[]): AssistantTurn[] {
  const filtered = turns.filter(
    (turn) => !turn.id.startsWith(OPTIMISTIC_TURN_PREFIX),
  );
  return filtered.length === turns.length ? turns : filtered;
}

export function adoptOptimisticTurn(
  turns: AssistantTurn[],
  turnId: string,
  timestamp: string,
): AssistantTurn[] {
  if (turns.some((turn) => turn.id === turnId)) return turns;
  const index = turns.findIndex(
    (turn) =>
      turn.isLive &&
      (turn.id.startsWith(OPTIMISTIC_TURN_PREFIX) ||
        turn.id.startsWith('legacy-turn-')),
  );
  if (index < 0) return turns;
  const next = [...turns];
  next[index] = {
    ...next[index],
    id: turnId,
    timestamp: pickLatestTimestamp(next[index].timestamp, timestamp),
    isLive: true,
  };
  return next;
}

export function ensureOptimisticWaitingTurn(
  turns: AssistantTurn[],
  timestamp: string,
): AssistantTurn[] {
  const next = clearOptimisticTurns(turns);
  if (next.some((turn) => turn.isLive)) return next;

  const turnId = `${OPTIMISTIC_TURN_PREFIX}${Date.now()}`;
  return [
    ...next,
    {
      id: turnId,
      clientKey: turnId,
      timestamp,
      isLive: true,
      isCompleted: false,
      items: [
        {
          id: `${turnId}${OPTIMISTIC_THINKING_SUFFIX}`,
          type: 'reasoning',
          status: 'in_progress',
          title: i18n.t('common.processing'),
          timestamp,
        },
      ],
    },
  ];
}

export function ensureLegacyLiveTurn(
  turns: AssistantTurn[],
  timestamp: string,
): AssistantTurn[] {
  const liveTurn = turns.find((turn) => turn.isLive);
  if (liveTurn) return turns;

  const turnId = `legacy-turn-${Date.now()}`;
  return [
    ...turns,
    {
      id: turnId,
      clientKey: turnId,
      timestamp,
      items: [],
      isLive: true,
      isCompleted: false,
    },
  ];
}

export function appendLegacyStreamToTurns(
  turns: AssistantTurn[],
  chunk: string,
  timestamp: string,
): AssistantTurn[] {
  const next = ensureLegacyLiveTurn(turns, timestamp);
  const liveIndex = next.findIndex((turn) => turn.isLive);
  if (liveIndex < 0) return next;

  const liveTurn = stripOptimisticThinkingFromTurn(next[liveIndex]);
  const lastItem = liveTurn.items[liveTurn.items.length - 1];
  const nextItems = [...liveTurn.items];
  if (
    lastItem?.type === 'assistant_message' &&
    lastItem.status === 'in_progress'
  ) {
    nextItems[nextItems.length - 1] = {
      ...lastItem,
      text: appendStreamChunk(lastItem.text, chunk),
      timestamp,
    };
  } else {
    nextItems.push({
      id: `${liveTurn.id}:legacy-assistant:${Date.now()}`,
      type: 'assistant_message',
      status: 'in_progress',
      text: chunk,
      timestamp,
    });
  }

  next[liveIndex] = { ...liveTurn, timestamp, items: nextItems };
  return next;
}

export function appendStreamToTurn(
  turns: AssistantTurn[],
  turnId: string,
  chunk: string,
  timestamp: string,
): AssistantTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    return appendLegacyStreamToTurns(turns, chunk, timestamp);
  }

  const next = [...turns];
  const turn = stripOptimisticThinkingFromTurn(next[index]);
  const items = [...turn.items];
  const lastItem = items[items.length - 1];

  if (
    lastItem?.type === 'assistant_message' &&
    lastItem.status === 'in_progress'
  ) {
    items[items.length - 1] = {
      ...lastItem,
      text: appendStreamChunk(lastItem.text, chunk),
      timestamp,
    };
  } else {
    items.push({
      id: `${turn.id}:stream-assistant`,
      type: 'assistant_message',
      status: 'in_progress',
      text: chunk,
      timestamp,
    });
  }

  next[index] = {
    ...turn,
    timestamp: pickLatestTimestamp(turn.timestamp, timestamp),
    isLive: true,
    items,
  };
  return next;
}

function completeAssistantTurn(
  turns: AssistantTurn[],
  turnId: string,
  timestamp: string,
  text?: string,
): AssistantTurn[] {
  const next = upsertTurn(turns, turnId, timestamp);
  const index = next.findIndex((turn) => turn.id === turnId);
  if (index < 0) return next;

  const turn = stripOptimisticThinkingFromTurn(next[index]);
  const items = [...turn.items];
  let completedAssistant = false;
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item?.type !== 'assistant_message') continue;
    items[itemIndex] = {
      ...item,
      status: 'completed',
      text: text?.trim() ? text : item.text,
      timestamp: pickLatestTimestamp(item.timestamp, timestamp),
    };
    completedAssistant = true;
    break;
  }

  if (!completedAssistant && text?.trim()) {
    items.push({
      id: `${turnId}:completed-assistant`,
      type: 'assistant_message',
      status: 'completed',
      text,
      timestamp,
    });
  }

  next[index] = {
    ...turn,
    timestamp: pickLatestTimestamp(turn.timestamp, timestamp),
    items,
    isLive: false,
    isCompleted: true,
  };
  return next;
}

function completeLatestLiveTurn(
  turns: AssistantTurn[],
  timestamp: string,
): AssistantTurn[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn?.isLive) continue;
    return completeAssistantTurn(turns, turn.id, timestamp);
  }
  return turns;
}

export function applyLegacyAgentEvent(
  turns: AssistantTurn[],
  incoming: {
    id: string;
    kind: 'status' | 'tool' | 'reasoning';
    status: TurnItemStatus;
    title: string;
    body?: string;
    timestamp: string;
  },
): AssistantTurn[] {
  const next = ensureLegacyLiveTurn(turns, incoming.timestamp);
  const liveIndex = next.findIndex((turn) => turn.isLive);
  if (liveIndex < 0) return next;

  const turn = stripOptimisticThinkingFromTurn(next[liveIndex]);
  const type = incoming.kind === 'tool' ? 'tool_call' : 'reasoning';
  const item: TurnItem =
    type === 'tool_call'
      ? {
          id: incoming.id,
          type: 'tool_call',
          status: incoming.status,
          title: incoming.title,
          argumentsText:
            incoming.status === 'in_progress' ? incoming.body : undefined,
          resultText:
            incoming.status === 'completed' ? incoming.body : undefined,
          errorText: incoming.status === 'failed' ? incoming.body : undefined,
          startedAt:
            incoming.status === 'in_progress' ? incoming.timestamp : undefined,
          completedAt:
            incoming.status === 'completed' || incoming.status === 'failed'
              ? incoming.timestamp
              : undefined,
          timestamp: incoming.timestamp,
        }
      : {
          id: incoming.id,
          type: 'reasoning',
          status: incoming.status,
          title: incoming.title,
          text: incoming.body,
          timestamp: incoming.timestamp,
        };

  const itemIndex = turn.items.findIndex((entry) => entry.id === item.id);
  const items = [...turn.items];
  if (itemIndex >= 0) {
    items[itemIndex] = { ...items[itemIndex], ...item } as TurnItem;
  } else {
    items.push(item);
  }

  next[liveIndex] = { ...turn, timestamp: incoming.timestamp, items };
  return next;
}

export function attachTurnMessage(
  turns: AssistantTurn[],
  turnId: string,
  messageId: string,
  timestamp: string,
  text?: string,
): AssistantTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return turns;
  const next = [...turns];
  const turn = stripOptimisticThinkingFromTurn(next[index]);
  const items = [...turn.items];
  const lastItem = items[items.length - 1];
  const effectiveTimestamp = pickLatestTimestamp(turn.timestamp, timestamp);

  if (text?.trim()) {
    if (lastItem?.type === 'assistant_message') {
      items[items.length - 1] = {
        ...lastItem,
        status: 'completed',
        text,
        timestamp: pickLatestTimestamp(lastItem.timestamp, effectiveTimestamp),
      };
    } else {
      items.push({
        id: `${turnId}:attached-message:${messageId}`,
        type: 'assistant_message',
        status: 'completed',
        text,
        timestamp: effectiveTimestamp,
      });
    }
  }

  next[index] = {
    ...turn,
    items,
    timestamp: effectiveTimestamp,
    persistedMessageId: messageId,
    isLive: false,
    isCompleted: true,
  };
  return next;
}

export function finalizeLegacyLiveTurn(
  turns: AssistantTurn[],
  payload: { id: string; timestamp: string; text: string },
): AssistantTurn[] {
  const next = [...turns];
  const liveIndex = next.findIndex((turn) => turn.isLive);
  if (liveIndex === -1) return next;

  const turn = stripOptimisticThinkingFromTurn(next[liveIndex]);
  const lastItem = turn.items[turn.items.length - 1];
  const items = [...turn.items];
  const effectiveTimestamp = pickLatestTimestamp(
    turn.timestamp,
    payload.timestamp,
  );
  if (lastItem?.type === 'assistant_message') {
    items[items.length - 1] = {
      ...lastItem,
      status: 'completed',
      text: payload.text,
      timestamp: pickLatestTimestamp(lastItem.timestamp, effectiveTimestamp),
    };
  } else if (payload.text) {
    items.push({
      id: `${turn.id}:legacy-final:${Date.now()}`,
      type: 'assistant_message',
      status: 'completed',
      text: payload.text,
      timestamp: effectiveTimestamp,
    });
  }

  next[liveIndex] = {
    ...turn,
    timestamp: effectiveTimestamp,
    items,
    persistedMessageId: payload.id,
    isLive: false,
    isCompleted: true,
  };
  return next;
}

export function hasRenderableTurnContent(turn: AssistantTurn) {
  if (turn.isLive) return true;
  if (turn.error) return true;
  return turn.items.some((turnItem) =>
    turnItem.type === 'assistant_message' ? !!turnItem.text?.trim() : true,
  );
}

export function shouldRenderTurn(turn: AssistantTurn) {
  return hasRenderableTurnContent(turn);
}

export function getConversationTitle(
  conversation: Conversation | null | undefined,
) {
  return (
    conversation?.custom_title?.trim() ||
    conversation?.display_name?.trim() ||
    conversation?.name?.trim() ||
    conversation?.jid ||
    ''
  );
}

export function getConversationBaseTitle(
  conversation: Conversation | null | undefined,
) {
  return (
    conversation?.display_name?.trim() ||
    conversation?.name?.trim() ||
    conversation?.jid ||
    ''
  );
}

export function getConversationMentionCandidates(
  conversation: Conversation | null | undefined,
) {
  return uniqueNonEmpty([
    getConversationTitle(conversation),
    getConversationBaseTitle(conversation),
    conversation?.display_name,
    conversation?.name,
    conversation?.jid,
  ]);
}

export function getConversationChannelLabel(
  conversation: Conversation | null | undefined,
) {
  const explicitLabel = conversation?.channel_label?.trim();
  if (explicitLabel) return explicitLabel;

  switch (conversation?.channel) {
    case 'web':
      return 'Web';
    case 'feishu':
      return i18n.t('common.channel.feishu');
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'slack':
      return 'Slack';
    case 'gmail':
      return 'Gmail';
    case 'whatsapp':
      return 'WhatsApp';
    default:
      return conversation?.channel || '';
  }
}

export function formatConversationMarkdown(
  conversation: Conversation | null,
  items: ConversationItem[],
  assistantName: string,
) {
  const title =
    getConversationTitle(conversation) || conversation?.jid || 'conversation';
  const mentionCandidates = getConversationMentionCandidates(conversation);
  const lines = [`# ${title}`, ''];

  for (const item of items) {
    if (item.kind === 'message') {
      const message = item.message;
      const isBot = !!message.is_bot_message;
      const sender = isBot
        ? assistantName
        : message.sender_name || message.sender || 'You';
      lines.push(`## ${sender}`);
      lines.push(
        i18n.t('common.export.time', { timestamp: message.timestamp }),
      );
      lines.push('');
      lines.push(
        getDisplayContent(
          message.content,
          isBot,
          conversation?.channel,
          mentionCandidates,
        ) || '',
      );
      lines.push('');
      continue;
    }

    const turn = item.turn;
    lines.push(`## ${assistantName}`);
    lines.push(i18n.t('common.export.time', { timestamp: turn.timestamp }));
    lines.push('');

    for (const turnItem of turn.items) {
      if (turnItem.type === 'assistant_message') {
        lines.push(turnItem.text || '');
        lines.push('');
        continue;
      }
      if (turnItem.type === 'reasoning') {
        lines.push(
          i18n.t('common.export.reasoning', {
            status: turnItem.status,
            title: turnItem.title,
            text: turnItem.text ? `: ${turnItem.text}` : '',
          }),
        );
        continue;
      }
      const detail =
        turnItem.status === 'failed'
          ? turnItem.errorText
          : turnItem.resultText || turnItem.argumentsText;
      lines.push(
        i18n.t('common.export.tool', {
          status: turnItem.status,
          title: turnItem.title,
          detail: detail ? `: ${detail}` : '',
        }),
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatTimelineMarkdown(
  conversation: Conversation | null,
  entries: ChatTimelineEntry[],
  assistantName: string,
) {
  const title =
    getConversationTitle(conversation) || conversation?.jid || 'conversation';
  const mentionCandidates = getConversationMentionCandidates(conversation);
  const lines = [`# ${title}`, ''];

  for (const entry of entries) {
    if (entry.kind === 'user_message') {
      const sender = entry.message.sender_name || entry.message.sender || 'You';
      lines.push(`## ${sender}`);
      lines.push(i18n.t('common.export.time', { timestamp: entry.timestamp }));
      if (entry.pending) lines.push(i18n.t('common.export.statusPending'));
      lines.push('');
      lines.push(
        getDisplayContent(
          entry.message.content,
          false,
          conversation?.channel,
          mentionCandidates,
        ) || '',
      );
      lines.push('');
      continue;
    }

    if (entry.kind === 'assistant_message') {
      lines.push(`## ${assistantName}`);
      lines.push(i18n.t('common.export.time', { timestamp: entry.timestamp }));
      if (entry.status !== 'completed')
        lines.push(i18n.t('common.export.status', { status: entry.status }));
      lines.push('');
      lines.push(
        getDisplayContent(
          entry.text,
          true,
          conversation?.channel,
          mentionCandidates,
        ) || '',
      );
      lines.push('');
      continue;
    }

    if (entry.kind === 'reasoning') {
      lines.push(
        i18n.t('common.export.reasoning', {
          status: entry.item.status,
          title: entry.item.title,
          text: entry.item.text ? `: ${entry.item.text}` : '',
        }),
      );
      continue;
    }

    if (entry.kind === 'tool_call') {
      const detail =
        entry.item.status === 'failed'
          ? entry.item.errorText
          : entry.item.resultText || entry.item.argumentsText;
      lines.push(
        i18n.t('common.export.tool', {
          status: entry.item.status,
          title: entry.item.title,
          detail: detail ? `: ${detail}` : '',
        }),
      );
      if (entry.approval) {
        lines.push(
          i18n.t('common.export.approval', { command: entry.approval.command }),
        );
      }
      continue;
    }

    if (entry.kind === 'approval') {
      lines.push(
        i18n.t('common.export.approval', { command: entry.approval.command }),
      );
      continue;
    }

    lines.push(i18n.t('common.export.error', { error: entry.error }));
  }

  return lines.join('\n');
}

export function reconcileConversationMessages(params: {
  state: ConversationChatState;
  messages: Message[];
  channel?: string;
  conversationName?: string;
}) {
  const { state, messages, channel, conversationName } = params;
  let nextPending = state.pendingMessages;

  if (state.pendingMessages.length > 0) {
    nextPending = state.pendingMessages.filter(
      (pendingMessage) =>
        !messages.some((persistedMessage) =>
          isPendingMessageResolved(
            pendingMessage,
            persistedMessage,
            channel,
            conversationName,
          ),
        ),
    );
  }

  const latestMessage = messages[messages.length - 1];
  const resolvedPending =
    state.pendingMessages.length > 0 &&
    nextPending.length < state.pendingMessages.length;

  return {
    resolvedPending,
    state: {
      ...state,
      messages,
      pendingMessages: nextPending,
      turns:
        nextPending.length === 0 && !!latestMessage?.is_bot_message
          ? clearOptimisticTurns(state.turns)
          : state.turns,
    },
  };
}

export function applyConversationMessageEvent(
  state: ConversationChatState,
  payload: { message: Message; turnId?: string | null; displayContent: string },
) {
  const { message, turnId, displayContent } = payload;
  const isBot = !!message.is_bot_message;
  const hasMatchingTurn =
    !!turnId && state.turns.some((turn) => turn.id === turnId);
  const hasLiveTurn = state.turns.some((turn) => turn.isLive);

  if (isBot && hasMatchingTurn && turnId) {
    return {
      ...state,
      turns: attachTurnMessage(
        adoptOptimisticTurn(state.turns, turnId, message.timestamp),
        turnId,
        message.id,
        message.timestamp,
        displayContent,
      ),
    };
  }

  if (isBot && hasLiveTurn) {
    return {
      ...state,
      turns: finalizeLegacyLiveTurn(state.turns, {
        id: message.id,
        timestamp: message.timestamp,
        text: displayContent,
      }),
    };
  }

  return {
    ...state,
    pendingMessages: message.client_id
      ? state.pendingMessages.filter(
          (pendingMessage) => pendingMessage.clientId !== message.client_id,
        )
      : state.pendingMessages,
    turns: isBot ? clearOptimisticTurns(state.turns) : state.turns,
    messages: [...state.messages, message],
  };
}

export function applyConversationTurnEvent(
  state: ConversationChatState,
  event: TurnEvent,
) {
  const timestamp = event.timestamp || new Date().toISOString();
  let nextTurns = state.turns;

  if (
    (event.type === 'item.started' || event.type === 'item.updated') &&
    event.item.type === 'assistant_message'
  ) {
    return {
      ...state,
      turns: nextTurns,
    };
  }

  if (event.type === 'turn.started') {
    nextTurns = upsertTurn(
      adoptOptimisticTurn(state.turns, event.turnId, timestamp),
      event.turnId,
      timestamp,
    );
  } else if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    const current = adoptOptimisticTurn(state.turns, event.turnId, timestamp);
    if (
      event.type === 'item.completed' &&
      event.item.type === 'assistant_message'
    ) {
      nextTurns = completeAssistantTurn(
        current,
        event.turnId,
        timestamp,
        event.item.text,
      );
    } else {
      nextTurns = upsertTurnItem(current, event);
    }
  } else if (event.type === 'turn.completed') {
    nextTurns = markTurnCompleted(
      adoptOptimisticTurn(state.turns, event.turnId, timestamp),
      event.turnId,
      timestamp,
    );
  } else if (event.type === 'turn.failed') {
    nextTurns = markTurnCompleted(
      adoptOptimisticTurn(state.turns, event.turnId, timestamp),
      event.turnId,
      timestamp,
      event.error,
    );
  }

  return {
    ...state,
    turns: nextTurns,
  };
}

export function applyConversationStreamEvent(
  state: ConversationChatState,
  payload: {
    chunk?: string;
    done?: boolean;
    timestamp: string;
    runId?: string;
  },
) {
  if (payload.done) {
    if (
      payload.runId &&
      state.turns.some((turn) => turn.id === payload.runId)
    ) {
      return {
        ...state,
        turns: completeAssistantTurn(
          state.turns,
          payload.runId,
          payload.timestamp,
        ),
      };
    }
    return {
      ...state,
      turns: completeLatestLiveTurn(state.turns, payload.timestamp),
    };
  }
  if (!payload.chunk) return state;
  if (payload.runId && state.turns.some((turn) => turn.id === payload.runId)) {
    return {
      ...state,
      turns: appendStreamToTurn(
        state.turns,
        payload.runId,
        payload.chunk,
        payload.timestamp,
      ),
    };
  }
  return {
    ...state,
    turns: appendLegacyStreamToTurns(
      state.turns,
      payload.chunk,
      payload.timestamp,
    ),
  };
}

export function applyConversationTypingEvent(
  state: ConversationChatState,
  payload: { isTyping: boolean; timestamp: string },
) {
  if (!payload.isTyping) {
    const nextTurns = state.turns.map((turn) => {
      if (!turn.isLive) return turn;
      const stripped = stripOptimisticThinkingFromTurn(turn);
      if (stripped.items.length > 0 || stripped.error) return stripped;
      return {
        ...stripped,
        timestamp: pickLatestTimestamp(stripped.timestamp, payload.timestamp),
        isLive: false,
        isCompleted: true,
      };
    });
    return nextTurns === state.turns ? state : { ...state, turns: nextTurns };
  }
  return {
    ...state,
    turns: ensureLegacyLiveTurn(state.turns, payload.timestamp),
  };
}

export function applyConversationLegacyEvent(
  state: ConversationChatState,
  payload: {
    id: string;
    kind: 'status' | 'tool' | 'reasoning';
    status: TurnItemStatus;
    title: string;
    body?: string;
    timestamp: string;
  },
) {
  return {
    ...state,
    turns: applyLegacyAgentEvent(state.turns, payload),
  };
}

export function upsertConversationApproval(
  state: ConversationChatState,
  approval: ApprovalRequest,
) {
  const next = state.approvals.filter((current) => current.id !== approval.id);
  next.push(approval);
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    ...state,
    approvals: next,
  };
}

export function removeConversationApproval(
  state: ConversationChatState,
  approvalId: string,
) {
  return {
    ...state,
    approvals: state.approvals.filter((approval) => approval.id !== approvalId),
  };
}

export function resetConversationState(
  state: ConversationChatState,
  options?: { clearMessages?: boolean },
) {
  return {
    ...state,
    messages: options?.clearMessages ? [] : state.messages,
    pendingMessages: [],
    approvals: [],
    turns: [],
  };
}

export function clearConversationTransientReplyState(
  state: ConversationChatState,
): ConversationChatState {
  const nextTurns = state.turns.filter((turn) => !turn.isLive);
  if (
    state.pendingMessages.length === 0 &&
    state.approvals.length === 0 &&
    nextTurns.length === state.turns.length
  ) {
    return state;
  }
  return {
    ...state,
    pendingMessages: [],
    approvals: [],
    turns: nextTurns,
  };
}

export function interruptConversationState(
  state: ConversationChatState,
  payload?: { reason?: string; timestamp?: string; turnId?: string },
) {
  const timestamp = payload?.timestamp || new Date().toISOString();
  const reason = payload?.reason?.trim() || i18n.t('common.stoppedReply');
  const targetTurnId = payload?.turnId?.trim();
  const hadLiveTurn = state.turns.some(
    (turn) => turn.isLive && (!targetTurnId || turn.id === targetTurnId),
  );
  const interruptedTurns = state.turns.map((turn) => {
    if (!turn.isLive || (targetTurnId && turn.id !== targetTurnId)) {
      return turn;
    }
    const stripped = stripOptimisticThinkingFromTurn(turn);
    const completedItems = stripped.items.map((item) =>
      item.type === 'assistant_message' && item.status === 'in_progress'
        ? { ...item, status: 'completed' as const, timestamp }
        : item,
    );
    return {
      ...stripped,
      items: completedItems,
      timestamp,
      isLive: false,
      isCompleted: true,
      error: turn.error || reason,
    };
  });

  if (
    hadLiveTurn ||
    (state.pendingMessages.length === 0 && state.approvals.length === 0)
  ) {
    return {
      ...state,
      pendingMessages: [],
      approvals: [],
      turns: interruptedTurns,
    };
  }

  const turnId = `interrupted-turn:${Date.now()}`;

  return {
    ...state,
    pendingMessages: [],
    approvals: [],
    turns: [
      ...clearOptimisticTurns(interruptedTurns),
      {
        id: turnId,
        clientKey: turnId,
        timestamp,
        items: [],
        isLive: false,
        isCompleted: true,
        error: reason,
      },
    ],
  };
}

export function expireLiveConversationTurns(
  state: ConversationChatState,
): ConversationChatState {
  return {
    ...state,
    turns: state.turns.map((turn) => {
      const hasStuckItem = turn.items.some((i) => i.status === 'in_progress');
      if (!turn.isLive && !hasStuckItem) return turn;
      return {
        ...turn,
        isLive: false,
        isCompleted: true,
        items: turn.items.map((item): TurnItem => {
          if (item.status !== 'in_progress') return item;
          return { ...item, status: 'completed' as const };
        }),
      };
    }),
  };
}
