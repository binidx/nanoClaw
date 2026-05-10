import { describe, expect, it, vi } from 'vitest';

import { createWebAuthRuntime } from './web-auth-runtime.js';

describe('web-auth-runtime', () => {
  it('falls back to the default admin credentials without logging secrets', () => {
    const warn = vi.fn();
    const runtime = createWebAuthRuntime({
      getConfigEntry: () => undefined,
      getConfigValueEntry: () => '',
      readEnvEntries: () => ({}),
      env: {},
      logger: { warn },
    });

    const first = runtime.getLoginCredentials();
    const second = runtime.getLoginCredentials();

    expect(first).toEqual({
      username: 'admin',
      password: 'admin123',
      bootstrapMode: false,
      weakCredentials: true,
    });
    expect(second).toEqual(first);
    expect(warn).not.toHaveBeenCalled();

    runtime.clearBootstrapCredentials();
    const third = runtime.getLoginCredentials();
    expect(third).toEqual(first);
  });

  it('uses configured credentials and reports weak defaults', () => {
    const runtime = createWebAuthRuntime({
      getConfigEntry: (key) =>
        key === 'WEB_LOGIN_USERNAME'
          ? 'admin'
          : key === 'WEB_LOGIN_PASSWORD'
            ? 'admin123'
            : undefined,
      getConfigValueEntry: (key) => (key === 'WEB_LOGIN_ENABLED' ? 'true' : ''),
      readEnvEntries: () => ({}),
      env: {},
    });

    expect(runtime.getLoginCredentials()).toEqual({
      username: 'admin',
      password: 'admin123',
      bootstrapMode: false,
      weakCredentials: true,
    });
  });

  it('reads authenticated username from auth session cookie', () => {
    const runtime = createWebAuthRuntime({
      getConfigEntry: () => undefined,
      getConfigValueEntry: (key) => (key === 'WEB_LOGIN_ENABLED' ? 'true' : ''),
      readEnvEntries: () => ({}),
      env: {},
    });
    const session = runtime.authSessions.create('alice');

    expect(
      runtime.getAuthenticatedUsername(`nanoclaw_auth=${session.token}`),
    ).toBe('alice');
    expect(
      runtime.isAuthenticatedRequest({
        headers: { cookie: `nanoclaw_auth=${session.token}` },
      } as any),
    ).toBe(true);
  });
});
