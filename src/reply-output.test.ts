import { describe, expect, it } from 'vitest';

import {
  appendReplyPart,
  mergeStreamingText,
  resolveFinalReplyText,
} from './conversation/reply-output.js';

describe('mergeStreamingText', () => {
  it('keeps the larger snapshot when chunks are cumulative', () => {
    expect(mergeStreamingText('Hello', 'Hello world')).toBe('Hello world');
    expect(mergeStreamingText('Hello world', 'Hello')).toBe('Hello world');
  });

  it('merges overlapping stream fragments', () => {
    expect(mergeStreamingText('你好，世', '世界')).toBe('你好，世界');
  });
});

describe('appendReplyPart', () => {
  it('drops identical duplicate finals', () => {
    expect(appendReplyPart(['Hello world'], 'Hello world')).toEqual([
      'Hello world',
    ]);
  });

  it('replaces a shorter snapshot with a longer one', () => {
    expect(appendReplyPart(['Hello'], 'Hello world')).toEqual(['Hello world']);
  });

  it('preserves distinct final replies', () => {
    expect(appendReplyPart(['First'], 'Second')).toEqual(['First', 'Second']);
  });
});

describe('resolveFinalReplyText', () => {
  it('falls back to streamed text when no final result exists', () => {
    expect(resolveFinalReplyText([], 'stream only answer')).toBe(
      'stream only answer',
    );
  });

  it('dedupes final text against the streamed draft', () => {
    expect(resolveFinalReplyText(['Hello world'], 'Hello world')).toBe(
      'Hello world',
    );
  });

  it('keeps distinct final replies combined', () => {
    expect(resolveFinalReplyText(['First', 'Second'], 'Second')).toBe(
      'First\n\nSecond',
    );
  });
});
