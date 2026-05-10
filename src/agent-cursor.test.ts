import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getConversationMessages,
  storeChatMetadata,
  storeMessage,
} from './db.js';

import {
  _acknowledgePendingAgentOutputViaIpc,
  _acknowledgePendingAgentTimestamp,
  _clearIpcAcknowledgedOutput,
  _clearPendingAgentTimestamp,
  _finalizeInterruptedAgentRun,
  _finalizeSuccessfulAgentRun,
  _getAgentCursorState,
  _getEffectiveAgentTimestamp,
  _handleBuiltinInboundMessageForTest,
  _hasIpcAcknowledgedOutput,
  _markPendingAgentTimestamp,
  _resolveDispatchCandidateMessages,
  _reconcilePersistedPendingAgentTimestamps,
  _setAgentCursorState,
  _shouldDispatchRealtimeInboundMessageForTest,
} from './index.js';

describe('agent cursor state', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setAgentCursorState({});
  });

  it('uses pending cursor to suppress duplicate follow-ups', () => {
    _setAgentCursorState({ 'chat-1': '2024-01-01T00:00:00.000Z' });

    _markPendingAgentTimestamp('chat-1', '2024-01-01T00:00:05.000Z');

    expect(_getEffectiveAgentTimestamp('chat-1')).toBe(
      '2024-01-01T00:00:05.000Z',
    );
    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:00.000Z' },
      pending: { 'chat-1': '2024-01-01T00:00:05.000Z' },
    });
  });

  it('commits pending cursor only after output acknowledgement', () => {
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:05.000Z' },
    );

    _acknowledgePendingAgentTimestamp('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:05.000Z' },
      pending: {},
    });
  });

  it('drops pending cursor on rollback without changing committed cursor', () => {
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:05.000Z' },
    );

    _clearPendingAgentTimestamp('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:00.000Z' },
      pending: {},
    });
    expect(_getEffectiveAgentTimestamp('chat-1')).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('commits pending cursor when IPC sends a visible message', () => {
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:05.000Z' },
    );

    _acknowledgePendingAgentOutputViaIpc('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:05.000Z' },
      pending: {},
    });
    expect(_hasIpcAcknowledgedOutput('chat-1')).toBe(true);

    _clearIpcAcknowledgedOutput('chat-1');
    expect(_hasIpcAcknowledgedOutput('chat-1')).toBe(false);
  });

  it('ignores IPC acknowledgement when no pending cursor exists', () => {
    _setAgentCursorState({ 'chat-1': '2024-01-01T00:00:00.000Z' });

    _acknowledgePendingAgentOutputViaIpc('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:00.000Z' },
      pending: {},
    });
    expect(_hasIpcAcknowledgedOutput('chat-1')).toBe(false);
  });

  it('commits persisted pending cursor when a bot reply was already stored', async () => {
    await storeChatMetadata('chat-1', '2024-01-01T00:00:00.000Z');
    await storeMessage({
      id: 'user-1',
      chat_jid: 'chat-1',
      sender: 'user',
      sender_name: 'User',
      content: 'create tmp',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessage({
      id: 'bot-1',
      chat_jid: 'chat-1',
      sender: 'ADY',
      sender_name: 'ADY',
      content: 'tmp already exists',
      timestamp: '2024-01-01T00:00:06.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:05.000Z' },
    );

    await _reconcilePersistedPendingAgentTimestamps();

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:05.000Z' },
      pending: {},
    });
  });

  it('clears persisted pending cursor without a stored bot reply so recovery can retry', async () => {
    await storeChatMetadata('chat-1', '2024-01-01T00:00:00.000Z');
    await storeMessage({
      id: 'user-1',
      chat_jid: 'chat-1',
      sender: 'user',
      sender_name: 'User',
      content: 'create tmp',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:05.000Z' },
    );

    await _reconcilePersistedPendingAgentTimestamps();

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:00.000Z' },
      pending: {},
    });
  });

  it('commits the latest pending cursor when a reply is explicitly interrupted', () => {
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:07.000Z' },
    );

    _finalizeInterruptedAgentRun('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:07.000Z' },
      pending: {},
    });
  });

  it('commits the latest pending cursor when an agent run finishes successfully', () => {
    _setAgentCursorState(
      { 'chat-1': '2024-01-01T00:00:00.000Z' },
      { 'chat-1': '2024-01-01T00:00:10.000Z' },
    );

    _finalizeSuccessfulAgentRun('chat-1');

    expect(_getAgentCursorState()).toEqual({
      committed: { 'chat-1': '2024-01-01T00:00:10.000Z' },
      pending: {},
    });
    expect(_getEffectiveAgentTimestamp('chat-1')).toBe(
      '2024-01-01T00:00:10.000Z',
    );
  });

  it('drops fallback group messages already covered by the pending cursor', () => {
    expect(
      _resolveDispatchCandidateMessages(
        '2024-01-01T00:00:05.000Z',
        [],
        [
          {
            id: 'msg-1',
            chat_jid: 'chat-1',
            sender: 'user',
            sender_name: 'User',
            content: 'hello',
            timestamp: '2024-01-01T00:00:05.000Z',
            is_from_me: false,
            is_bot_message: false,
          },
        ],
      ),
    ).toEqual([]);
  });

  it('keeps fallback group messages only when they are newer than the effective cursor', () => {
    expect(
      _resolveDispatchCandidateMessages(
        '2024-01-01T00:00:05.000Z',
        [],
        [
          {
            id: 'msg-2',
            chat_jid: 'chat-1',
            sender: 'user',
            sender_name: 'User',
            content: 'hello again',
            timestamp: '2024-01-01T00:00:06.000Z',
            is_from_me: false,
            is_bot_message: false,
          },
        ],
      ).map((item) => item.id),
    ).toEqual(['msg-2']);
  });

  it('persists builtin inbound messages and commits the cursor immediately for non-web chats', async () => {
    await storeChatMetadata('feishu:test', '2024-01-01T00:00:00.000Z');

    const handled = await _handleBuiltinInboundMessageForTest('feishu:test', {
      id: 'msg-builtin',
      chat_jid: 'feishu:test',
      sender: 'web_user',
      sender_name: 'Web User',
      content: '@Andy 你是谁',
      timestamp: '2024-01-01T00:00:05.000Z',
      run_id: 'run-builtin',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(handled).toBe(true);
    expect(
      (await getConversationMessages('feishu:test', 10, 0)).map((message) => ({
        sender: message.sender,
        content: message.content,
        runId: message.run_id,
        isBot: message.is_bot_message,
      })),
    ).toEqual([
      {
        sender: 'web_user',
        content: '@Andy 你是谁',
        runId: 'run-builtin',
        isBot: 0,
      },
      {
        sender: 'Andy',
        content: '我是 Andy。',
        runId: null,
        isBot: 1,
      },
    ]);
    expect(_getAgentCursorState()).toEqual({
      committed: { 'feishu:test': '2024-01-01T00:00:05.000Z' },
      pending: {},
    });
  });

  it('keeps web builtin-looking prompts on the normal realtime path', async () => {
    expect(
      await _handleBuiltinInboundMessageForTest('web:test', {
        id: 'msg-web-builtin',
        chat_jid: 'web:test',
        sender: 'web_user',
        sender_name: 'Web User',
        content: '@Andy 你是谁',
        timestamp: '2024-01-01T00:00:05.000Z',
        is_from_me: false,
        is_bot_message: false,
      }),
    ).toBe(false);

    expect(
      await _shouldDispatchRealtimeInboundMessageForTest('web:test', {
        id: 'msg-web-builtin',
        chat_jid: 'web:test',
        sender: 'web_user',
        sender_name: 'Web User',
        content: '@Andy 你是谁',
        timestamp: '2024-01-01T00:00:05.000Z',
        is_from_me: false,
        is_bot_message: false,
      }),
    ).toBe(true);

    expect(
      await _shouldDispatchRealtimeInboundMessageForTest('feishu:test', {
        id: 'msg-builtin',
        chat_jid: 'feishu:test',
        sender: 'web_user',
        sender_name: 'Web User',
        content: '@Andy 你是谁',
        timestamp: '2024-01-01T00:00:05.000Z',
        is_from_me: false,
        is_bot_message: false,
      }),
    ).toBe(false);

    expect(
      await _shouldDispatchRealtimeInboundMessageForTest('web:test', {
        id: 'msg-normal',
        chat_jid: 'web:test',
        sender: 'web_user',
        sender_name: 'Web User',
        content: '@Andy hi',
        timestamp: '2024-01-01T00:00:06.000Z',
        is_from_me: false,
        is_bot_message: false,
      }),
    ).toBe(true);
  });
});
