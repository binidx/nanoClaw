import { afterEach, describe, expect, it } from 'vitest';

import {
  __testing,
  getInternalApiToken,
  isAuthorizedInternalApiRequest,
  isAuthorizedInternalBrowserApiRequest,
  INTERNAL_API_TOKEN_HEADER,
} from './auth/internal-api-auth.js';

describe('internal-api-auth', () => {
  afterEach(() => {
    __testing.resetInternalApiToken();
  });

  it('authorizes loopback requests with the runtime token', () => {
    const token = getInternalApiToken();

    expect(
      isAuthorizedInternalApiRequest({
        headers: { [INTERNAL_API_TOKEN_HEADER]: token },
        ip: '::1',
        socket: { remoteAddress: '127.0.0.1' } as any,
      } as any),
    ).toBe(true);
  });

  it('rejects non-loopback requests even with the correct token', () => {
    const token = getInternalApiToken();

    expect(
      isAuthorizedInternalApiRequest({
        headers: { [INTERNAL_API_TOKEN_HEADER]: token },
        ip: '198.51.100.10',
        socket: { remoteAddress: '198.51.100.10' } as any,
      } as any),
    ).toBe(false);
  });

  it('rejects requests with a missing or incorrect token', () => {
    getInternalApiToken();

    expect(
      isAuthorizedInternalApiRequest({
        headers: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' } as any,
      } as any),
    ).toBe(false);
    expect(
      isAuthorizedInternalApiRequest({
        headers: { [INTERNAL_API_TOKEN_HEADER]: 'wrong-token' },
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' } as any,
      } as any),
    ).toBe(false);
  });

  it('scopes the internal bypass to browser API paths only', () => {
    const token = getInternalApiToken();

    expect(
      isAuthorizedInternalBrowserApiRequest({
        path: '/browser/act',
        headers: { [INTERNAL_API_TOKEN_HEADER]: token },
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' } as any,
      } as any),
    ).toBe(true);
    expect(
      isAuthorizedInternalBrowserApiRequest({
        path: '/config',
        headers: { [INTERNAL_API_TOKEN_HEADER]: token },
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' } as any,
      } as any),
    ).toBe(false);
  });
});
