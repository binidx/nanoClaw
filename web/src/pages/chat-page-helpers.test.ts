import { describe, expect, it } from 'vitest';

import type { ChatTimelineEntry } from '../app-types';
import {
  buildChatTimelineEntries,
  deriveConversationReplyState,
  ensureOptimisticWaitingTurn,
} from '../app-helpers';
import {
  extractGeneratedImageWorkspacePaths,
  getLatestRegeneratableAssistantTurnId,
  shouldShowInlineAssistantLoading,
} from './chat-page-helpers';

describe('chat-page helpers', () => {
  it('shows inline loading while the first optimistic waiting placeholder is still hidden from the timeline', () => {
    const timelineEntries: ChatTimelineEntry[] = [
      {
        kind: 'reasoning',
        key: 'turn:1:reasoning:optimistic',
        timestamp: '2026-03-27T10:00:00.000Z',
        order: 0,
        turnId: 'optimistic-turn:1',
        item: {
          id: 'optimistic-turn:1:optimistic-thinking',
          type: 'reasoning',
          status: 'in_progress',
          title: '处理中',
          timestamp: '2026-03-27T10:00:00.000Z',
        },
      },
    ];

    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: true,
        streaming: false,
      }),
    ).toBe(true);
  });

  it('hides inline loading when a real in-progress tool call is already visible', () => {
    const timelineEntries: ChatTimelineEntry[] = [
      {
        kind: 'reasoning',
        key: 'turn:1:reasoning:optimistic',
        timestamp: '2026-03-27T10:00:00.000Z',
        order: 0,
        turnId: 'turn-1',
        item: {
          id: 'turn-1:optimistic-thinking',
          type: 'reasoning',
          status: 'in_progress',
          title: '处理中',
          timestamp: '2026-03-27T10:00:00.000Z',
        },
      },
      {
        kind: 'tool_call',
        key: 'turn:1:tool:read',
        timestamp: '2026-03-27T10:00:01.000Z',
        order: 1,
        turnId: 'turn-1',
        item: {
          id: 'tool-1',
          type: 'tool_call',
          status: 'in_progress',
          title: 'read_file',
          timestamp: '2026-03-27T10:00:01.000Z',
        },
      },
    ];

    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: true,
        streaming: false,
      }),
    ).toBe(false);
  });

  it('hides inline loading when an approval slot is already visible for the first reply', () => {
    const timelineEntries: ChatTimelineEntry[] = [
      {
        kind: 'reasoning',
        key: 'turn:1:reasoning:optimistic',
        timestamp: '2026-03-27T10:00:00.000Z',
        order: 0,
        turnId: 'optimistic-turn:1',
        item: {
          id: 'optimistic-turn:1:optimistic-thinking',
          type: 'reasoning',
          status: 'in_progress',
          title: '处理中',
          timestamp: '2026-03-27T10:00:00.000Z',
        },
      },
      {
        kind: 'approval',
        key: 'approval:1',
        timestamp: '2026-03-27T10:00:01.000Z',
        order: 1,
        approval: {
          id: 'approval-1',
          toolCallId: 'tool-1',
          toolName: 'shell_command',
          command: 'dir',
          createdAt: '2026-03-27T10:00:01.000Z',
          expiresAt: '2026-03-27T10:05:01.000Z',
        },
      },
    ];

    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: true,
        streaming: false,
      }),
    ).toBe(false);
  });

  it('hides inline loading when a real in-progress assistant placeholder is already visible', () => {
    const timelineEntries: ChatTimelineEntry[] = [
      {
        kind: 'assistant_message',
        key: 'turn:1:assistant',
        timestamp: '2026-03-27T10:00:02.000Z',
        order: 0,
        turnId: 'turn-1',
        status: 'in_progress',
        text: '',
      },
    ];

    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: true,
        streaming: false,
      }),
    ).toBe(false);
  });

  it('shows inline loading when only the user message is visible and assistant work has not rendered yet', () => {
    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries: [
          {
            kind: 'user_message',
            key: 'message:user-1',
            timestamp: '2026-03-27T10:00:00.000Z',
            order: 0,
            pending: true,
            message: {
              id: 'user-1',
              sender: 'web_user',
              sender_name: 'You',
              content: 'hi',
              timestamp: '2026-03-27T10:00:00.000Z',
              is_from_me: true,
              is_bot_message: 0,
            },
          },
        ],
        typing: true,
        streaming: false,
      }),
    ).toBe(true);
  });

  it('shows the bottom inline loading for the first optimistic reply turn', () => {
    const timestamp = '2026-03-27T10:00:00.000Z';
    const state = {
      messages: [],
      pendingMessages: [
        {
          clientId: 'local-1',
          id: 'local-1',
          sender: 'web_user',
          sender_name: 'You',
          content: 'hi',
          timestamp,
          is_from_me: true,
          is_bot_message: 0 as const,
        },
      ],
      turns: ensureOptimisticWaitingTurn([], timestamp),
      approvals: [],
    };
    const replyState = deriveConversationReplyState(state);
    const timelineEntries = buildChatTimelineEntries({
      messages: [...state.messages, ...state.pendingMessages],
      turns: state.turns,
      approvals: state.approvals,
    });

    expect(
      timelineEntries.some(
        (entry) =>
          entry.kind === 'reasoning' && entry.item.title === '处理中',
      ),
    ).toBe(true);
    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: replyState.typing,
        streaming: replyState.streaming,
      }),
    ).toBe(true);
  });

  it('still shows inline loading for later turns when only historical completed assistant entries exist', () => {
    const timelineEntries: ChatTimelineEntry[] = [
      {
        kind: 'assistant_message',
        key: 'turn:history:assistant',
        timestamp: '2026-03-27T09:59:00.000Z',
        order: 0,
        turnId: 'turn-history',
        status: 'completed',
        text: 'done',
      },
      {
        kind: 'user_message',
        key: 'message:user-2',
        timestamp: '2026-03-27T10:01:00.000Z',
        order: 1,
        pending: true,
        message: {
          id: 'user-2',
          sender: 'web_user',
          sender_name: 'You',
          content: 'second turn',
          timestamp: '2026-03-27T10:01:00.000Z',
          is_from_me: true,
          is_bot_message: 0,
        },
      },
      {
        kind: 'reasoning',
        key: 'turn:2:reasoning:optimistic',
        timestamp: '2026-03-27T10:01:01.000Z',
        order: 2,
        turnId: 'optimistic-turn:2',
        item: {
          id: 'optimistic-turn:2:optimistic-thinking',
          type: 'reasoning',
          status: 'in_progress',
          title: '处理中',
          timestamp: '2026-03-27T10:01:01.000Z',
        },
      },
    ];

    expect(
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing: true,
        streaming: false,
      }),
    ).toBe(true);
  });

  it('extracts generated image workspace paths from tool output text', () => {
    expect(
      extractGeneratedImageWorkspacePaths(
        [
          'Generated 2 image(s) with gpt-image-1.',
          '1. /workspace/group/.nanoclaw/generated-images/a.png (1024x1024)',
          '2. /workspace/group/.nanoclaw/generated-images/b.webp (1024x1024)',
        ].join('\n'),
      ),
    ).toEqual([
      '/workspace/group/.nanoclaw/generated-images/a.png',
      '/workspace/group/.nanoclaw/generated-images/b.webp',
    ]);
  });

  it('returns the latest completed assistant turn id for regeneration', () => {
    const entries: ChatTimelineEntry[] = [
      {
        kind: 'assistant_message',
        key: 'turn:old:assistant',
        timestamp: '2026-03-27T09:59:00.000Z',
        order: 0,
        turnId: 'turn-old',
        status: 'completed',
        text: 'old',
      },
      {
        kind: 'assistant_message',
        key: 'turn:new:assistant',
        timestamp: '2026-03-27T10:00:00.000Z',
        order: 1,
        turnId: 'turn-new',
        status: 'completed',
        text: 'new',
      },
    ];

    expect(getLatestRegeneratableAssistantTurnId(entries)).toBe('turn-new');
  });

  it('ignores in-progress assistant entries when resolving regenerate targets', () => {
    const entries: ChatTimelineEntry[] = [
      {
        kind: 'assistant_message',
        key: 'turn:done:assistant',
        timestamp: '2026-03-27T09:59:00.000Z',
        order: 0,
        turnId: 'turn-done',
        status: 'completed',
        text: 'done',
      },
      {
        kind: 'assistant_message',
        key: 'turn:live:assistant',
        timestamp: '2026-03-27T10:00:00.000Z',
        order: 1,
        turnId: 'turn-live',
        status: 'in_progress',
        text: '',
      },
    ];

    expect(getLatestRegeneratableAssistantTurnId(entries)).toBe('turn-done');
  });
});
