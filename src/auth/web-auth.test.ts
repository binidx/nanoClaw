import { describe, expect, it, vi } from 'vitest';

import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_MS,
  createSessionStore,
  parseCookies,
  serializeAuthCookie,
  serializeExpiredAuthCookie,
} from './web-auth.js';

describe('web-auth', () => {
  it('parses cookies into a key-value map', () => {
    expect(parseCookies('a=1; b=two%20words')).toEqual({
      a: '1',
      b: 'two words',
    });
  });

  it('creates random sessions and validates them before expiry', () => {
    const now = vi.fn(() => 1_000);
    const store = createSessionStore(now);

    const session = store.create('admin');

    expect(session.username).toBe('admin');
    expect(store.get(session.token)?.username).toBe('admin');
    expect(store.size()).toBe(1);
  });

  it('purges expired sessions on access', () => {
    let currentTime = 1_000;
    const store = createSessionStore(() => currentTime);
    const session = store.create('admin');

    currentTime += AUTH_SESSION_TTL_MS + 1;

    expect(store.get(session.token)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('does not need to sweep all sessions for a valid lookup', () => {
    let currentTime = 1_000;
    const store = createSessionStore(() => currentTime);
    const expired = store.create('expired');

    currentTime += AUTH_SESSION_TTL_MS - 100;
    const active = store.create('active');
    currentTime += 150;

    expect(store.get(active.token)?.username).toBe('active');
    expect(store.get(expired.token)).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it('serializes auth cookies with expiry and security flags', () => {
    const cookie = serializeAuthCookie('token123', true);
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=token123`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=86400');
    expect(cookie).toContain('Secure');
  });

  it('serializes an expired cookie for logout', () => {
    expect(serializeExpiredAuthCookie(false)).toContain('Max-Age=0');
  });
});
