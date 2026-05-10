import { describe, expect, it } from 'vitest';

import {
  buildFeishuMarkdownCard,
  buildFeishuMentionPostMessagePayload,
  chunkFeishuText,
  resolveFeishuRenderMode,
  resolveFeishuReplyInThread,
  shouldUseFeishuCard,
} from './feishu-render.js';

describe('resolveFeishuRenderMode', () => {
  it('falls back to auto for unknown values', () => {
    expect(resolveFeishuRenderMode(undefined)).toBe('auto');
    expect(resolveFeishuRenderMode('weird')).toBe('auto');
  });

  it('accepts text and card', () => {
    expect(resolveFeishuRenderMode('text')).toBe('text');
    expect(resolveFeishuRenderMode('card')).toBe('card');
  });
});

describe('shouldUseFeishuCard', () => {
  it('detects markdown formatting that plain text cannot render', () => {
    expect(shouldUseFeishuCard('**bold** text')).toBe(true);
    expect(shouldUseFeishuCard('```ts\nconst x = 1\n```')).toBe(true);
    expect(shouldUseFeishuCard('| a | b |')).toBe(true);
  });

  it('keeps plain text as plain text', () => {
    expect(shouldUseFeishuCard('hello world')).toBe(false);
  });
});

describe('buildFeishuMarkdownCard', () => {
  it('builds an interactive markdown card payload', () => {
    expect(buildFeishuMarkdownCard('**hi**')).toEqual({
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '**hi**',
          },
        ],
      },
    });
  });
});

describe('buildFeishuMentionPostMessagePayload', () => {
  it('builds a post payload with feishu @ mentions', () => {
    expect(
      buildFeishuMentionPostMessagePayload('第一行\n第二行', [
        { channel: 'feishu', id: 'ou_123', name: 'Alice' },
      ]),
    ).toEqual({
      msgType: 'post',
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              { tag: 'at', user_id: 'ou_123', user_name: 'Alice' },
              { tag: 'text', text: ' 请关注以下审查结果' },
            ],
            [{ tag: 'text', text: '第一行' }],
            [{ tag: 'text', text: '第二行' }],
          ],
        },
      }),
    });
  });

  it('supports mention-only payloads without adding blank lines', () => {
    expect(
      buildFeishuMentionPostMessagePayload('', [
        { channel: 'feishu', id: 'ou_123', name: 'Alice' },
      ]),
    ).toEqual({
      msgType: 'post',
      content: JSON.stringify({
        zh_cn: {
          content: [
            [
              { tag: 'at', user_id: 'ou_123', user_name: 'Alice' },
              { tag: 'text', text: ' 请关注以下审查结果' },
            ],
          ],
        },
      }),
    });
  });
});

describe('chunkFeishuText', () => {
  it('splits long text by limit', () => {
    expect(chunkFeishuText('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('resolveFeishuReplyInThread', () => {
  it('parses boolean-ish values', () => {
    expect(resolveFeishuReplyInThread('true')).toBe(true);
    expect(resolveFeishuReplyInThread('1')).toBe(true);
    expect(resolveFeishuReplyInThread('false')).toBe(false);
    expect(resolveFeishuReplyInThread(undefined)).toBe(false);
  });
});
