import { describe, expect, it } from 'vitest';

import {
  sanitizeAgentEventForWeb,
  sanitizePersistedTurnsForWeb,
  sanitizeTurnEventForWeb,
} from './conversation-turn-visibility.js';
import type { PersistedAssistantTurn } from '../db.js';

describe('conversation turn visibility', () => {
  it('filters hidden memory tool calls from persisted turns', () => {
    const turns: PersistedAssistantTurn[] = [
      {
        id: 'turn-1',
        clientKey: 'turn-1',
        timestamp: '2026-03-19T10:00:05.000Z',
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-1',
        items: [
          {
            id: 'tool-memory',
            type: 'tool_call',
            status: 'completed',
            title: 'memory_search',
            argumentsText: '{"query":"deadline"}',
            resultText: '[]',
            timestamp: '2026-03-19T10:00:01.000Z',
          },
          {
            id: 'tool-visible',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"README.md"}',
            resultText: 'ok',
            timestamp: '2026-03-19T10:00:02.000Z',
          },
          {
            id: 'msg-1',
            type: 'assistant_message',
            status: 'completed',
            text: '已整理结果。',
            timestamp: '2026-03-19T10:00:05.000Z',
          },
        ],
      },
      {
        id: 'turn-2',
        clientKey: 'turn-2',
        timestamp: '2026-03-19T10:01:00.000Z',
        isLive: false,
        isCompleted: true,
        items: [
          {
            id: 'tool-memory-only',
            type: 'tool_call',
            status: 'completed',
            title: 'memory_get',
            argumentsText: '{"path":"group:memory/2026-03-19.md"}',
            resultText: 'content',
            timestamp: '2026-03-19T10:01:00.000Z',
          },
        ],
      },
    ];

    expect(sanitizePersistedTurnsForWeb(turns)).toEqual([
      {
        ...turns[0],
        items: turns[0]!.items.filter(
          (item) => !(item.type === 'tool_call' && item.title === 'memory_search'),
        ),
      },
    ]);
  });

  it('drops realtime item events for hidden memory tool calls only', () => {
    expect(
      sanitizeTurnEventForWeb({
        type: 'item.completed',
        turnId: 'turn-1',
        timestamp: '2026-03-19T10:00:01.000Z',
        item: {
          id: 'tool-memory',
          type: 'tool_call',
          status: 'completed',
          title: 'memory_save',
          argumentsText: '{"text":"note"}',
          resultText: 'saved',
          timestamp: '2026-03-19T10:00:01.000Z',
        },
      }),
    ).toBeNull();

    expect(
      sanitizeTurnEventForWeb({
        type: 'item.completed',
        turnId: 'turn-1',
        timestamp: '2026-03-19T10:00:02.000Z',
        item: {
          id: 'tool-visible',
          type: 'tool_call',
          status: 'completed',
          title: 'read_file',
          argumentsText: '{"path":"README.md"}',
          resultText: 'ok',
          timestamp: '2026-03-19T10:00:02.000Z',
        },
      }),
    ).toEqual({
      type: 'item.completed',
      turnId: 'turn-1',
      timestamp: '2026-03-19T10:00:02.000Z',
      item: {
        id: 'tool-visible',
        type: 'tool_call',
        status: 'completed',
        title: 'read_file',
        argumentsText: '{"path":"README.md"}',
        resultText: 'ok',
        timestamp: '2026-03-19T10:00:02.000Z',
      },
    });

    expect(
      sanitizeTurnEventForWeb({
        type: 'turn.completed',
        turnId: 'turn-1',
        timestamp: '2026-03-19T10:00:05.000Z',
      }),
    ).toEqual({
      type: 'turn.completed',
      turnId: 'turn-1',
      timestamp: '2026-03-19T10:00:05.000Z',
    });
  });

  it('drops codex provider phase status events from web visibility', () => {
    expect(
      sanitizeAgentEventForWeb({
        id: 'provider-phase:completed',
        kind: 'status',
        status: 'completed',
        title: 'Codex provider phase completed',
        body: 'Codex chat/completions request',
        timestamp: '2026-03-25T10:00:00.000Z',
      }),
    ).toBeNull();

    expect(
      sanitizeAgentEventForWeb({
        id: 'visible-tool',
        kind: 'tool',
        status: 'completed',
        title: 'read_file',
        body: '{"path":"README.md"}',
        timestamp: '2026-03-25T10:00:01.000Z',
      }),
    ).toEqual({
      id: 'visible-tool',
      kind: 'tool',
      status: 'completed',
      title: 'read_file',
      body: '{"path":"README.md"}',
      timestamp: '2026-03-25T10:00:01.000Z',
    });
  });
});
