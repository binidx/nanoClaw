import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  deleteConversationMessages,
  getConversationMessages,
  getConversationTurns,
  storeChatMetadata,
  storeMessageDirectWithTurn,
  type PersistedAssistantTurn,
} from './db.js';
import {
  _buildWebTurnFailureEventsForTest,
  finalizePersistedTurnForMessage,
  persistTurnEventSnapshot,
} from './index.js';

describe('conversation turn persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores final bot reply and completed turn snapshot together', async () => {
    await storeChatMetadata(
      'web:test',
      '2026-03-10T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );

    const turn: PersistedAssistantTurn = {
      id: 'turn-1',
      clientKey: 'turn-1',
      timestamp: '2026-03-10T10:00:05.000Z',
      isLive: false,
      isCompleted: true,
      persistedMessageId: 'bot-1',
      items: [
        {
          id: 'reason-1',
          type: 'reasoning',
          status: 'completed',
          title: '分析问题',
          text: '先确认现有保存策略',
          timestamp: '2026-03-10T10:00:01.000Z',
        },
        {
          id: 'tool-1',
          type: 'tool_call',
          status: 'completed',
          title: 'read_file',
          argumentsText: '{"path":"src/index.ts"}',
          resultText: 'ok',
          subagentInfo: {
            agentName: 'frontend-worker',
            task: '检查聊天页工具渲染',
            status: 'completed',
          },
          timestamp: '2026-03-10T10:00:03.000Z',
        },
        {
          id: 'msg-1',
          type: 'assistant_message',
          status: 'completed',
          text: '已完成保存。',
          timestamp: '2026-03-10T10:00:05.000Z',
        },
      ],
    };

    await storeMessageDirectWithTurn(
      {
        id: 'bot-1',
        chat_jid: 'web:test',
        sender: 'NanoClaw',
        sender_name: 'NanoClaw',
        content: '已完成保存。',
        timestamp: '2026-03-10T10:00:05.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      turn,
    );

    expect(await getConversationMessages('web:test', 50, 0)).toHaveLength(1);
    expect(await getConversationTurns('web:test', 50, 0)).toEqual([turn]);
  });

  it('deletes persisted turns together with conversation messages', async () => {
    await storeChatMetadata(
      'web:test',
      '2026-03-10T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );

    await storeMessageDirectWithTurn(
      {
        id: 'bot-1',
        chat_jid: 'web:test',
        sender: 'NanoClaw',
        sender_name: 'NanoClaw',
        content: 'done',
        timestamp: '2026-03-10T10:00:05.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-1',
        clientKey: 'turn-1',
        timestamp: '2026-03-10T10:00:05.000Z',
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-1',
        items: [
          {
            id: 'msg-1',
            type: 'assistant_message',
            status: 'completed',
            text: 'done',
            timestamp: '2026-03-10T10:00:05.000Z',
          },
        ],
      },
    );

    await deleteConversationMessages('web:test');

    expect(await getConversationMessages('web:test', 50, 0)).toEqual([]);
    expect(await getConversationTurns('web:test', 50, 0)).toEqual([]);
  });

  it('updates an incremental turn snapshot in place when the final bot reply arrives', async () => {
    await storeChatMetadata(
      'web:test',
      '2026-03-10T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );

    const drafts = new Map<string, PersistedAssistantTurn>();

    await persistTurnEventSnapshot('web:test', drafts, {
      type: 'turn.started',
      turnId: 'turn-2',
      timestamp: '2026-03-10T10:00:01.000Z',
    });
    await persistTurnEventSnapshot('web:test', drafts, {
      type: 'item.started',
      turnId: 'turn-2',
      timestamp: '2026-03-10T10:00:02.000Z',
      item: {
        id: 'tool-2',
        type: 'tool_call',
        status: 'in_progress',
        title: 'read_file',
        argumentsText: '{"path":"web/src/pages/ChatPage.tsx"}',
        timestamp: '2026-03-10T10:00:02.000Z',
      },
    });
    await persistTurnEventSnapshot('web:test', drafts, {
      type: 'item.completed',
      turnId: 'turn-2',
      timestamp: '2026-03-10T10:00:05.000Z',
      item: {
        id: 'tool-2',
        type: 'tool_call',
        status: 'completed',
        title: 'read_file',
        argumentsText: '{"path":"web/src/pages/ChatPage.tsx"}',
        resultText: 'ok',
        timestamp: '2026-03-10T10:00:05.000Z',
      },
    });

    expect(await getConversationTurns('web:test', 50, 0)).toEqual([
      {
        id: 'turn-2',
        clientKey: 'turn-2',
        timestamp: '2026-03-10T10:00:05.000Z',
        isLive: true,
        isCompleted: false,
        items: [
          {
            id: 'tool-2',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"web/src/pages/ChatPage.tsx"}',
            resultText: 'ok',
            startedAt: '2026-03-10T10:00:02.000Z',
            completedAt: '2026-03-10T10:00:05.000Z',
            timestamp: '2026-03-10T10:00:05.000Z',
          },
        ],
      },
    ]);

    const completedTurn = finalizePersistedTurnForMessage(
      drafts.get('turn-2'),
      'bot-2',
      '2026-03-10T10:00:04.000Z',
      '已完成。',
    );
    expect(completedTurn).toBeDefined();

    await storeMessageDirectWithTurn(
      {
        id: 'bot-2',
        chat_jid: 'web:test',
        sender: 'NanoClaw',
        sender_name: 'NanoClaw',
        content: '已完成。',
        timestamp: '2026-03-10T10:00:04.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      completedTurn!,
    );

    expect(await getConversationMessages('web:test', 50, 0)).toHaveLength(1);
    expect(await getConversationTurns('web:test', 50, 0)).toEqual([completedTurn!]);
  });

  it('reuses the active turn id when building process failure events', () => {
    const events = _buildWebTurnFailureEventsForTest({
      error: 'provider crashed',
      turnId: 'turn-live-1',
      timestamp: '2026-03-24T12:00:00.000Z',
    });

    expect(events).toEqual([
      {
        type: 'turn.failed',
        turnId: 'turn-live-1',
        timestamp: '2026-03-24T12:00:00.000Z',
        error: 'provider crashed',
      },
    ]);
  });
});
