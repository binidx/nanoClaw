import { describe, expect, it } from 'vitest';

import {
  createLoginThrottleStore,
  getRequestClientAddress,
  isFeatureEnabled,
  isTrustedRequestOrigin,
} from './auth/web-security.js';

describe('web-security', () => {
  it('parses feature flags safely', () => {
    expect(isFeatureEnabled('true')).toBe(true);
    expect(isFeatureEnabled('1')).toBe(true);
    expect(isFeatureEnabled('on')).toBe(true);
    expect(isFeatureEnabled('false')).toBe(false);
    expect(isFeatureEnabled(undefined)).toBe(false);
  });

  it('accepts only same-host origins when present', () => {
    expect(isTrustedRequestOrigin(undefined, 'localhost:3377')).toBe(true);
    expect(
      isTrustedRequestOrigin('http://localhost:3377', 'localhost:3377'),
    ).toBe(true);
    expect(
      isTrustedRequestOrigin('https://evil.example', 'localhost:3377'),
    ).toBe(false);
    expect(isTrustedRequestOrigin('not-a-url', 'localhost:3377')).toBe(false);
  });

  it('only trusts forwarded client IPs from a loopback proxy', () => {
    expect(
      getRequestClientAddress({
        ip: '::1',
        socketRemoteAddress: '127.0.0.1',
        forwardedFor: '198.51.100.20, 127.0.0.1',
      }),
    ).toBe('198.51.100.20');

    expect(
      getRequestClientAddress({
        ip: '203.0.113.10',
        socketRemoteAddress: '203.0.113.10',
        forwardedFor: '198.51.100.20',
      }),
    ).toBe('203.0.113.10');
  });

  it('blocks repeated login failures for a cooldown window', () => {
    let current = 0;
    const store = createLoginThrottleStore(() => current, {
      maxAttempts: 3,
      windowMs: 1000,
      blockMs: 5000,
    });

    expect(store.isBlocked('ip').blocked).toBe(false);
    store.recordFailure('ip');
    store.recordFailure('ip');
    const result = store.recordFailure('ip');
    expect(result.blocked).toBe(true);
    expect(store.isBlocked('ip').blocked).toBe(true);

    current = 5001;
    expect(store.isBlocked('ip').blocked).toBe(false);
  });

  it('resets throttle state after success', () => {
    const store = createLoginThrottleStore(() => 0, {
      maxAttempts: 2,
      windowMs: 1000,
      blockMs: 5000,
    });

    store.recordFailure('ip');
    store.reset('ip');
    expect(store.isBlocked('ip').blocked).toBe(false);
  });
});
