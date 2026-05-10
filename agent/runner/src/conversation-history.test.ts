import { describe, expect, it } from 'vitest';

import {
  buildResponsesHistoryBridgePrompt,
  extractChatMessageText,
} from './conversation-history.js';

describe('conversation history bridge', () => {
  it('extracts text from multipart chat content', () => {
    expect(
      extractChatMessageText([
        { type: 'text', text: 'first' },
        { type: 'ignored', text: 'skip' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('bridges the most recent conversation turns instead of the oldest ones', () => {
    const prompt = buildResponsesHistoryBridgePrompt(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'old-user' },
        { role: 'assistant', content: 'old-assistant' },
        { role: 'user', content: 'recent-user' },
        { role: 'assistant', content: 'recent-assistant' },
      ],
      'current-question',
    );

    expect(prompt).toContain('User: recent-user');
    expect(prompt).toContain('Assistant: recent-assistant');
    expect(prompt).toContain('Current user message:\ncurrent-question');
    expect(prompt).toContain('User: old-user');
  });

  it('limits the bridge to the latest twelve visible turns', () => {
    const history = [{ role: 'system' as const, content: 'sys' }];
    for (let index = 1; index <= 14; index++) {
      history.push({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `message-${index}`,
      });
    }

    const prompt = buildResponsesHistoryBridgePrompt(history, 'latest');
    const lines = prompt.split('\n');

    expect(prompt).toContain('message-14');
    expect(prompt).toContain('message-3');
    expect(lines).not.toContain('User: message-1');
    expect(lines).not.toContain('Assistant: message-2');
  });
});
