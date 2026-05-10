import { describe, expect, it } from 'vitest';

import {
  buildGmailJid,
  decodeBase64Url,
  deriveGmailGroupFolder,
  encodeBase64Url,
  normalizeSubject,
  parseAddress,
  parseGmailJid,
} from './gmail.js';

describe('gmail channel helpers', () => {
  it('builds and parses instance-aware JIDs', () => {
    expect(buildGmailJid('default', 'thread-1')).toBe('gmail:thread-1');
    expect(buildGmailJid('ops', 'thread-1')).toBe('gmail:ops:thread-1');
    expect(parseGmailJid('gmail:thread-1')).toEqual({
      instanceId: 'default',
      threadId: 'thread-1',
      explicit: false,
    });
    expect(parseGmailJid('gmail:ops:thread-1')).toEqual({
      instanceId: 'ops',
      threadId: 'thread-1',
      explicit: true,
    });
  });

  it('derives stable group folders', () => {
    expect(deriveGmailGroupFolder('default', 'thread-1')).toMatch(
      /^gmail_default_[a-f0-9]{12}$/,
    );
    expect(deriveGmailGroupFolder('ops team', 'thread-1')).toMatch(
      /^gmail_ops_team_[a-f0-9]{12}$/,
    );
    expect(deriveGmailGroupFolder('ops team', 'thread-1')).toBe(
      deriveGmailGroupFolder('ops team', 'thread-1'),
    );
  });

  it('normalizes reply subjects', () => {
    expect(normalizeSubject('Hello')).toBe('Re: Hello');
    expect(normalizeSubject('re: Existing')).toBe('re: Existing');
    expect(normalizeSubject('   ')).toBe('Re: NanoClaw Gmail Thread');
  });

  it('parses email addresses with and without display names', () => {
    expect(parseAddress('Alice <alice@example.com>')).toEqual({
      email: 'alice@example.com',
      name: 'Alice',
    });
    expect(parseAddress('bob@example.com')).toEqual({
      email: 'bob@example.com',
      name: 'bob@example.com',
    });
  });

  it('round-trips base64url encoding', () => {
    const original = 'Hello Gmail +/=?\n第二行';
    expect(decodeBase64Url(encodeBase64Url(original))).toBe(original);
  });
});
