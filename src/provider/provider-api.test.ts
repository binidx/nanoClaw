import { describe, expect, it } from 'vitest';

import {
  normalizeCodexApiBase,
  readFirstCodexChatCompletionText,
} from './provider-api.js';

describe('provider-api', () => {
  it('normalizes codex api base to v1', () => {
    expect(normalizeCodexApiBase('https://api.example.com')).toBe(
      'https://api.example.com/v1',
    );
    expect(normalizeCodexApiBase('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1',
    );
  });

  it('extracts concatenated text from codex chat completions', async () => {
    const response = new Response(
      JSON.stringify({
        model: 'gpt-test',
        choices: [
          {
            message: {
              content: [
                { type: 'output_text', text: 'hello ' },
                { type: 'output_text', text: 'world' },
              ],
            },
          },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    await expect(readFirstCodexChatCompletionText(response)).resolves.toEqual({
      text: 'hello world',
      model: 'gpt-test',
    });
  });
});
