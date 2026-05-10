import { describe, expect, it, vi } from 'vitest';

import {
  applyProcessConfigSideEffects,
  createAuditMutation,
  getSanitizedWebConfig,
  hasTrustedOrigin,
  isUnsafeMethod,
  parseBoundedInteger,
  summarizeConfigEffects,
} from './web/web-server-support.js';

describe('web-server-support', () => {
  it('checks trusted origin against host header', () => {
    expect(
      hasTrustedOrigin({
        headers: { origin: 'http://localhost:3377', host: 'localhost:3377' },
      } as any),
    ).toBe(true);
    expect(
      hasTrustedOrigin({
        headers: { origin: 'https://evil.example', host: 'localhost:3377' },
      } as any),
    ).toBe(false);
  });

  it('falls back to referer when origin is missing', () => {
    expect(
      hasTrustedOrigin({
        headers: { referer: 'http://localhost:3377/', host: 'localhost:3377' },
      } as any),
    ).toBe(true);
    expect(
      hasTrustedOrigin({
        headers: { referer: 'https://evil.example/page', host: 'localhost:3377' },
      } as any),
    ).toBe(false);
  });

  it('allows requests with neither origin nor referer', () => {
    expect(
      hasTrustedOrigin({ headers: { host: 'localhost:3377' } } as any),
    ).toBe(true);
  });

  it('parses bounded integers and rejects unsafe methods', () => {
    expect(parseBoundedInteger('9', 1, { min: 3, max: 5 })).toBe(5);
    expect(parseBoundedInteger('abc', 4)).toBe(4);
    expect(isUnsafeMethod('POST')).toBe(true);
    expect(isUnsafeMethod('GET')).toBe(false);
  });

  it('records audit metadata with actor and client', () => {
    const info = vi.fn();
    const auditMutation = createAuditMutation({
      logger: { info },
      getAuthenticatedUsername: () => 'admin',
      getRequestClientKey: () => '127.0.0.1',
    });

    auditMutation(
      {
        headers: { cookie: 'x=1' },
        method: 'POST',
        path: '/api/config',
      } as any,
      'config.update',
      'high',
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'config.update',
        risk: 'high',
        actor: 'admin',
        client: '127.0.0.1',
      }),
      'Protected mutation request',
    );
  });

  it('applies process config side effects and summarizes config effects', () => {
    const env: NodeJS.ProcessEnv = {};
    applyProcessConfigSideEffects({ ALLOW_INSECURE_TLS: 'true' }, { env });
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');

    const summary = summarizeConfigEffects(['FOO', 'BAR'], {
      webConfigKeys: ['FOO', 'BAR'],
      getConfigKeyMetadataFn: ((key: string) => ({
        key,
        label: key === 'FOO' ? 'Foo' : 'Bar',
        effect: key === 'FOO' ? 'instant' : 'restart',
        summary: '',
      })) as any,
    });
    expect(summary).toEqual({
      instant: ['Foo'],
      new_agent: [],
      restart: ['Bar'],
    });
  });

  it('masks sensitive config keys', async () => {
    expect(
      await getSanitizedWebConfig(new Set(['SECRET']), () => ({
        SECRET: 'abc',
        VISIBLE: 'ok',
      })),
    ).toEqual({
      SECRET: '',
      VISIBLE: 'ok',
    });
  });
});
