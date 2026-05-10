import { describe, expect, it } from 'vitest';

import { _selectMessagesFromFirstTriggerForTest } from './index.js';
import type { NewMessage } from './types.js';

function createMessage(
  id: string,
  content: string,
  timestamp: string,
): NewMessage {
  return {
    id,
    chat_jid: 'feishu:test-group',
    sender: 'user-1',
    sender_name: 'User 1',
    content,
    timestamp,
    is_from_me: false,
  };
}

describe('selectMessagesFromFirstTrigger', () => {
  it('drops earlier non-trigger messages when a later trigger arrives', () => {
    const messages = [
      createMessage('msg-1', 'hi', '2026-03-12T08:55:09.000Z'),
      createMessage('msg-2', '所有信息', '2026-03-12T08:55:23.000Z'),
      createMessage('msg-3', '@ADY hi', '2026-03-12T08:55:36.000Z'),
    ];

    const selected = _selectMessagesFromFirstTriggerForTest(
      messages,
      (message) => message.content.includes('@ADY'),
    );

    expect(selected.map((message) => message.id)).toEqual(['msg-3']);
  });

  it('keeps follow-up messages that arrive after the trigger', () => {
    const messages = [
      createMessage('msg-1', '之前那条不算', '2026-03-12T08:55:09.000Z'),
      createMessage('msg-2', '@ADY hi', '2026-03-12T08:55:36.000Z'),
      createMessage('msg-3', '补充一句', '2026-03-12T08:55:37.000Z'),
    ];

    const selected = _selectMessagesFromFirstTriggerForTest(
      messages,
      (message) => message.content.includes('@ADY'),
    );

    expect(selected.map((message) => message.id)).toEqual(['msg-2', 'msg-3']);
  });

  it('returns empty array when no trigger message exists', () => {
    const messages = [
      createMessage('msg-1', 'hi', '2026-03-12T08:55:09.000Z'),
      createMessage('msg-2', '所有信息', '2026-03-12T08:55:23.000Z'),
    ];

    const selected = _selectMessagesFromFirstTriggerForTest(
      messages,
      (message) => message.content.includes('@ADY'),
    );

    expect(selected).toEqual([]);
  });
});
