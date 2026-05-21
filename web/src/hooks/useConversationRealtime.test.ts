import { describe, expect, it } from 'vitest';

import {
  applyConversationMessageEvent,
  applyConversationStreamEvent,
  applyConversationTurnEvent,
  applyConversationTypingEvent,
  buildChatTimelineEntries,
  clearConversationTransientReplyState,
  deriveConversationReplyState,
  ensureOptimisticWaitingTurn,
} from '../app-helpers';
import type { ConversationChatState } from '../app-types';
import {
  applyConversationMessagesSnapshot,
  mergePersistedAndTransientTurns,
  shouldEagerlyRefreshActiveConversationMessage,
  shouldIgnoreConversationRealtimeSeq,
  shouldIgnoreStructuredStreamEvent,
} from './useConversationRealtime';

function createEmptyState(): ConversationChatState {
  return {
    messages: [],
    pendingMessages: [],
    turns: [],
    approvals: [],
  };
}

describe('useConversationRealtime structured stream handling', () => {
  it('eagerly refreshes the active conversation after a new bot message arrives', () => {
    expect(
      shouldEagerlyRefreshActiveConversationMessage({
        jid: 'web:test',
        activeJid: 'web:test',
        isBot: true,
        seen: false,
      }),
    ).toBe(true);

    expect(
      shouldEagerlyRefreshActiveConversationMessage({
        jid: 'web:test',
        activeJid: 'web:test',
        isBot: false,
        seen: false,
      }),
    ).toBe(false);

    expect(
      shouldEagerlyRefreshActiveConversationMessage({
        jid: 'web:test',
        activeJid: 'web:test',
        isBot: true,
        seen: true,
      }),
    ).toBe(false);

    expect(
      shouldEagerlyRefreshActiveConversationMessage({
        jid: 'web:other',
        activeJid: 'web:test',
        isBot: true,
        seen: false,
      }),
    ).toBe(false);
  });

  it('applies structured stream events to the matching turn for faster text updates', () => {
    let state = createEmptyState();
    const timestamp = '2026-03-15T02:00:00.000Z';

    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-claude-1',
      timestamp,
      runId: 'run-claude-1',
    });
    state = applyConversationTurnEvent(state, {
      type: 'item.started',
      turnId: 'run-claude-1',
      timestamp,
      runId: 'run-claude-1',
      item: {
        id: 'run-claude-1:assistant:1',
        type: 'assistant_message',
        status: 'in_progress',
        text: '',
        timestamp,
      },
    });
    state = applyConversationTurnEvent(state, {
      type: 'item.updated',
      turnId: 'run-claude-1',
      timestamp,
      runId: 'run-claude-1',
      item: {
        id: 'run-claude-1:assistant:1',
        type: 'assistant_message',
        status: 'in_progress',
        text: 'Hello from Claude',
        timestamp,
      },
    });

    expect(shouldIgnoreStructuredStreamEvent('run-claude-1')).toBe(false);

    state = applyConversationStreamEvent(state, {
      chunk: 'Hello from Claude',
      timestamp,
      runId: 'run-claude-1',
    });

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.items).toHaveLength(1);
    expect(state.turns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'Hello from Claude',
      status: 'in_progress',
    });
  });

  it('still applies legacy stream events when no structured run id exists', () => {
    const state = applyConversationStreamEvent(createEmptyState(), {
      chunk: 'legacy partial',
      timestamp: '2026-03-15T02:00:01.000Z',
    });

    expect(shouldIgnoreStructuredStreamEvent(undefined)).toBe(false);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'legacy partial',
      status: 'in_progress',
    });
  });

  it('renders an empty live turn as an in-progress assistant reply placeholder', () => {
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-placeholder-1',
      timestamp: '2026-03-23T10:00:00.000Z',
      runId: 'run-placeholder-1',
    });

    const timeline = buildChatTimelineEntries({
      messages: state.messages,
      turns: state.turns,
      approvals: state.approvals,
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'assistant_message',
      turnId: 'run-placeholder-1',
      status: 'in_progress',
      text: '',
    });
  });

  it('ignores structured assistant_message turn events because text is rendered from stream chunks', () => {
    const timestamp = '2026-03-15T02:00:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-claude-2',
      timestamp,
      runId: 'run-claude-2',
    });

    state = applyConversationTurnEvent(state, {
      type: 'item.updated',
      turnId: 'run-claude-2',
      timestamp,
      runId: 'run-claude-2',
      item: {
        id: 'run-claude-2:assistant:1',
        type: 'assistant_message',
        status: 'in_progress',
        text: 'slow-path text',
        timestamp,
      },
    });

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.items).toHaveLength(0);
  });

  it('marks structured assistant replies as completed when the assistant item finishes', () => {
    const timestamp = '2026-03-23T09:00:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-claude-3',
      timestamp,
      runId: 'run-claude-3',
    });
    state = applyConversationStreamEvent(state, {
      chunk: 'final answer',
      timestamp,
      runId: 'run-claude-3',
    });

    state = applyConversationTurnEvent(state, {
      type: 'item.completed',
      turnId: 'run-claude-3',
      timestamp: '2026-03-23T09:00:02.000Z',
      runId: 'run-claude-3',
      item: {
        id: 'run-claude-3:assistant:1',
        type: 'assistant_message',
        status: 'completed',
        text: 'final answer',
        timestamp: '2026-03-23T09:00:02.000Z',
      },
    });

    expect(state.turns[0]).toMatchObject({
      id: 'run-claude-3',
      isLive: false,
      isCompleted: true,
    });
    expect(state.turns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'final answer',
      status: 'completed',
    });
  });

  it('closes the live turn when a structured stream sends done', () => {
    const timestamp = '2026-03-23T09:05:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-claude-4',
      timestamp,
      runId: 'run-claude-4',
    });
    state = applyConversationStreamEvent(state, {
      chunk: 'partial answer',
      timestamp,
      runId: 'run-claude-4',
    });

    state = applyConversationStreamEvent(state, {
      done: true,
      timestamp: '2026-03-23T09:05:03.000Z',
      runId: 'run-claude-4',
    });

    expect(state.turns[0]).toMatchObject({
      id: 'run-claude-4',
      isLive: false,
      isCompleted: true,
    });
    expect(state.turns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'partial answer',
      status: 'completed',
    });
  });

  it('falls back to closing the latest live turn when stream done has no run id', () => {
    const timestamp = '2026-03-23T09:06:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-claude-fallback',
      timestamp,
      runId: 'run-claude-fallback',
    });
    state = applyConversationStreamEvent(state, {
      chunk: 'fallback answer',
      timestamp,
      runId: 'run-claude-fallback',
    });

    state = applyConversationStreamEvent(state, {
      done: true,
      timestamp: '2026-03-23T09:06:03.000Z',
    });

    expect(state.turns[0]).toMatchObject({
      id: 'run-claude-fallback',
      isLive: false,
      isCompleted: true,
    });
    expect(state.turns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'fallback answer',
      status: 'completed',
    });
  });

  it('keeps completed transient turns until the persisted turn snapshot arrives', () => {
    const timestamp = '2026-03-19T03:00:00.000Z';
    const botMessage = {
      id: 'bot-1',
      sender: 'NanoClaw',
      sender_name: 'NanoClaw',
      content: '已处理完成',
      timestamp: '2026-03-19T03:00:04.000Z',
      turn_id: 'turn-1',
      run_id: 'turn-1',
      is_bot_message: 1 as const,
    };

    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'turn-1',
      timestamp,
      runId: 'turn-1',
    });
    state = applyConversationTurnEvent(state, {
      type: 'item.started',
      turnId: 'turn-1',
      timestamp: '2026-03-19T03:00:01.000Z',
      runId: 'turn-1',
      item: {
        id: 'tool-1',
        type: 'tool_call',
        status: 'in_progress',
        title: 'read_file',
        argumentsText: '{"path":"src/index.ts"}',
        timestamp: '2026-03-19T03:00:01.000Z',
      },
    });
    state = applyConversationTurnEvent(state, {
      type: 'item.completed',
      turnId: 'turn-1',
      timestamp: '2026-03-19T03:00:04.000Z',
      runId: 'turn-1',
      item: {
        id: 'tool-1',
        type: 'tool_call',
        status: 'completed',
        title: 'read_file',
        argumentsText: '{"path":"src/index.ts"}',
        resultText: 'ok',
        timestamp: '2026-03-19T03:00:04.000Z',
      },
    });
    state = applyConversationMessageEvent(state, {
      message: botMessage,
      turnId: 'turn-1',
      displayContent: '已处理完成',
    });

    const snapshot = applyConversationMessagesSnapshot({
      state,
      data: {
        messages: [botMessage],
        turns: [],
        approvals: [],
        total: 1,
        last_event_seq: 12,
      },
    });

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      id: 'turn-1',
      isLive: false,
      persistedMessageId: 'bot-1',
    });
    expect(snapshot.turns[0]?.items[0]).toMatchObject({
      id: 'tool-1',
      startedAt: '2026-03-19T03:00:01.000Z',
      completedAt: '2026-03-19T03:00:04.000Z',
    });

    const timeline = buildChatTimelineEntries({
      messages: snapshot.messages,
      turns: snapshot.turns,
      approvals: snapshot.approvals,
    });

    expect(timeline.some((entry) => entry.kind === 'tool_call')).toBe(true);
    expect(
      timeline.some(
        (entry) =>
          entry.kind === 'assistant_message' && entry.turnId === 'turn-1',
      ),
    ).toBe(true);
  });

  it('does not advance websocket event watermarks from message snapshots', () => {
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'turn-1',
      timestamp: '2026-03-19T04:00:00.000Z',
      runId: 'turn-1',
    });
    state = {
      ...state,
      lastEventSeq: 4,
    };

    const snapshot = applyConversationMessagesSnapshot({
      state,
      data: {
        messages: [],
        turns: [],
        approvals: [],
        total: 0,
        last_event_seq: 9,
      },
    });

    expect(snapshot.lastEventSeq).toBe(4);
    expect(shouldIgnoreConversationRealtimeSeq(snapshot, 5)).toBe(false);
    expect(shouldIgnoreConversationRealtimeSeq(snapshot, 4)).toBe(true);

    const completedState = applyConversationTurnEvent(snapshot, {
      type: 'turn.completed',
      turnId: 'turn-1',
      timestamp: '2026-03-19T04:00:02.000Z',
      runId: 'turn-1',
    });

    expect(completedState.turns[0]).toMatchObject({
      id: 'turn-1',
      isLive: false,
      isCompleted: true,
    });
  });

  it('clears empty live typing turns when typing=false arrives', () => {
    let state = createEmptyState();
    state = applyConversationTypingEvent(state, {
      isTyping: true,
      timestamp: '2026-03-20T11:00:00.000Z',
    });

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      isLive: true,
      items: [],
    });

    state = applyConversationTypingEvent(state, {
      isTyping: false,
      timestamp: '2026-03-20T11:00:02.000Z',
    });

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      isLive: false,
      isCompleted: true,
      items: [],
    });

    const timeline = buildChatTimelineEntries({
      messages: state.messages,
      turns: state.turns,
      approvals: state.approvals,
    });

    expect(
      timeline.some(
        (entry) =>
          entry.kind === 'reasoning' &&
          entry.item.status === 'in_progress' &&
          entry.item.title === '处理中',
      ),
    ).toBe(false);
  });

  it('preserves live streaming turn in merge when persisted data arrives mid-stream', () => {
    const timestamp = '2026-04-03T07:00:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-stream-1',
      timestamp,
      runId: 'run-stream-1',
    });
    state = applyConversationStreamEvent(state, {
      chunk: '正在流式输出',
      timestamp,
      runId: 'run-stream-1',
    });

    const oldPersistedTurns = [
      {
        id: 'run-old',
        clientKey: 'run-old',
        timestamp: '2026-04-03T06:50:00.000Z',
        items: [
          {
            id: 'run-old:assistant',
            type: 'assistant_message' as const,
            status: 'completed' as const,
            text: '旧回复',
            timestamp: '2026-04-03T06:50:00.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
      },
    ];

    const merged = mergePersistedAndTransientTurns(
      oldPersistedTurns,
      state.turns,
    );

    expect(merged).toHaveLength(2);
    const streamingTurn = merged.find((t) => t.id === 'run-stream-1');
    expect(streamingTurn).toBeDefined();
    expect(streamingTurn).toMatchObject({ isLive: true });
    expect(streamingTurn?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: '正在流式输出',
      status: 'in_progress',
    });
  });

  it('does not re-append completed persisted turns that disappeared from a fresh snapshot', () => {
    const deletedTurn = {
      id: 'run-deleted',
      clientKey: 'run-deleted',
      timestamp: '2026-04-03T07:02:00.000Z',
      items: [
        {
          id: 'run-deleted:assistant',
          type: 'assistant_message' as const,
          status: 'completed' as const,
          text: '旧回复',
          timestamp: '2026-04-03T07:02:00.000Z',
        },
      ],
      isLive: false,
      isCompleted: true,
      persistedMessageId: 'bot-deleted',
    };

    const merged = mergePersistedAndTransientTurns([], [deletedTurn]);

    expect(merged).toEqual([]);
  });

  it('preserves live turn with items even when persisted is completed', () => {
    const timestamp = '2026-04-03T07:10:00.000Z';
    let state = createEmptyState();
    state = applyConversationTurnEvent(state, {
      type: 'turn.started',
      turnId: 'run-tool-1',
      timestamp,
      runId: 'run-tool-1',
    });
    state = applyConversationTurnEvent(state, {
      type: 'item.started',
      turnId: 'run-tool-1',
      timestamp,
      runId: 'run-tool-1',
      item: {
        id: 'run-tool-1:tool:1',
        type: 'tool_call',
        status: 'in_progress',
        title: 'read_file',
        argumentsText: '{"path":"src/index.ts"}',
        timestamp,
      },
    });

    const completedPersisted = [
      {
        id: 'run-tool-1',
        clientKey: 'run-tool-1',
        timestamp,
        items: [
          {
            id: 'run-tool-1:tool:1',
            type: 'tool_call' as const,
            status: 'completed' as const,
            title: 'read_file',
            argumentsText: '{"path":"src/index.ts"}',
            resultText: 'ok',
            timestamp,
          },
          {
            id: 'run-tool-1:assistant',
            type: 'assistant_message' as const,
            status: 'completed' as const,
            text: '完成',
            timestamp,
          },
        ],
        isLive: false,
        isCompleted: true,
      },
    ];

    const merged = mergePersistedAndTransientTurns(
      completedPersisted,
      state.turns,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'run-tool-1', isLive: true });
    expect(merged[0]?.items[0]).toMatchObject({
      type: 'tool_call',
      status: 'in_progress',
    });
  });

  it('replaces empty stuck live turn with persisted completed turn', () => {
    const emptyLiveTurn = [
      {
        id: 'run-stuck',
        clientKey: 'run-stuck',
        timestamp: '2026-04-03T06:00:00.000Z',
        items: [] as never[],
        isLive: true,
        isCompleted: false,
      },
    ];
    const completedPersisted = [
      {
        id: 'run-stuck',
        clientKey: 'run-stuck',
        timestamp: '2026-04-03T06:00:02.000Z',
        items: [
          {
            id: 'run-stuck:assistant',
            type: 'assistant_message' as const,
            status: 'completed' as const,
            text: '完成',
            timestamp: '2026-04-03T06:00:02.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
      },
    ];

    const merged = mergePersistedAndTransientTurns(
      completedPersisted,
      emptyLiveTurn,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'run-stuck',
      isLive: false,
      isCompleted: true,
    });
  });

  it('clears optimistic turn via snapshot reconciliation after bot reply', () => {
    let state = createEmptyState();
    state = {
      ...state,
      turns: ensureOptimisticWaitingTurn(
        state.turns,
        '2026-04-03T06:54:00.000Z',
      ),
      pendingMessages: [
        {
          clientId: 'local_1',
          id: 'local_1',
          sender: 'web_user',
          sender_name: 'You',
          content: '你是',
          timestamp: '2026-04-03T06:54:00.000Z',
          is_from_me: true,
          is_bot_message: 0,
        },
      ],
    };

    expect(deriveConversationReplyState(state).busy).toBe(true);

    const snapshot = applyConversationMessagesSnapshot({
      state,
      data: {
        messages: [
          {
            id: 'msg-user-1',
            chat_jid: 'feishu:test',
            sender: 'web_user',
            sender_name: 'You',
            content: '@Andy 你是',
            timestamp: '2026-04-03T06:54:00.000Z',
            client_id: 'local_1',
            is_from_me: true,
            is_bot_message: 0,
          },
          {
            id: 'msg-bot-1',
            chat_jid: 'feishu:test',
            sender: 'bot',
            sender_name: 'Andy',
            content: '我是 Andy，你的 AI 助手。',
            timestamp: '2026-04-03T06:54:02.000Z',
            is_from_me: false,
            is_bot_message: 1,
          },
        ],
        turns: [
          {
            id: 'run-abc',
            clientKey: 'run-abc',
            timestamp: '2026-04-03T06:54:02.000Z',
            items: [
              {
                id: 'run-abc:assistant',
                type: 'assistant_message',
                status: 'completed',
                text: '我是 Andy，你的 AI 助手。',
                timestamp: '2026-04-03T06:54:02.000Z',
              },
            ],
            isLive: false,
            isCompleted: true,
          },
        ],
        approvals: [],
        total: 2,
        last_event_seq: 10,
      },
    });

    expect(snapshot.pendingMessages).toHaveLength(0);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      id: 'run-abc',
      isLive: false,
      isCompleted: true,
    });
    expect(deriveConversationReplyState(snapshot).busy).toBe(false);
  });

  it('clears stale transient reply state before reopening a conversation', () => {
    const state = clearConversationTransientReplyState({
      messages: [],
      pendingMessages: [
        {
          clientId: 'local-1',
          id: 'local-1',
          sender: 'web_user',
          sender_name: 'You',
          content: 'still pending',
          timestamp: '2026-03-24T10:00:00.000Z',
          is_from_me: true,
          is_bot_message: 0,
        },
      ],
      turns: [
        {
          id: 'turn-live',
          clientKey: 'turn-live',
          timestamp: '2026-03-24T10:00:01.000Z',
          items: [],
          isLive: true,
          isCompleted: false,
        },
        {
          id: 'turn-completed',
          clientKey: 'turn-completed',
          timestamp: '2026-03-24T10:00:03.000Z',
          items: [
            {
              id: 'assistant-1',
              type: 'assistant_message',
              status: 'completed',
              text: 'done',
              timestamp: '2026-03-24T10:00:03.000Z',
            },
          ],
          isLive: false,
          isCompleted: true,
        },
      ],
      approvals: [
        {
          id: 'approval-1',
          toolCallId: 'tool-1',
          toolName: 'shell',
          command: 'dir',
          createdAt: '2026-03-24T10:00:02.000Z',
          expiresAt: '2026-03-24T10:10:02.000Z',
        },
      ],
    });

    expect(state.pendingMessages).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.id).toBe('turn-completed');
    expect(deriveConversationReplyState(state).busy).toBe(false);
  });
});
