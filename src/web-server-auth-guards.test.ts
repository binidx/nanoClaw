import { describe, expect, it, vi } from 'vitest';

import { createApiProtectionMiddleware } from './web/web-server.js';

function createResponseMock() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  } as any;
  response.status.mockReturnValue(response);
  return response;
}

describe('web server API protection middleware', () => {
  it('allows internal browser API mutations without trusted browser origin', () => {
    const next = vi.fn();
    const warn = vi.fn();
    const { requireTrustedOrigin, requireAuth } = createApiProtectionMiddleware(
      {
        hasTrustedOrigin: () => false,
        isUnsafeMethod: () => true,
        isAuthorizedInternalBrowserApiRequest: (req) =>
          req.path === '/browser/act',
        isAuthenticatedRequest: () => false,
        logger: { warn },
      },
    );

    const req = {
      method: 'POST',
      path: '/browser/act',
      headers: {
        origin: 'https://evil.example',
        host: 'localhost:3377',
      },
    } as any;
    const res = createResponseMock();

    requireTrustedOrigin(req, res, next);
    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still blocks non-browser API mutations from untrusted origins', () => {
    const next = vi.fn();
    const warn = vi.fn();
    const { requireTrustedOrigin } = createApiProtectionMiddleware({
      hasTrustedOrigin: () => false,
      isUnsafeMethod: () => true,
      isAuthorizedInternalBrowserApiRequest: () => false,
      isAuthenticatedRequest: () => false,
      logger: { warn },
    });

    const req = {
      method: 'POST',
      path: '/config',
      headers: {
        origin: 'https://evil.example',
        host: 'localhost:3377',
      },
    } as any;
    const res = createResponseMock();

    requireTrustedOrigin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden origin' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still requires auth for non-browser API requests', () => {
    const next = vi.fn();
    const { requireAuth } = createApiProtectionMiddleware({
      hasTrustedOrigin: () => true,
      isUnsafeMethod: () => true,
      isAuthorizedInternalBrowserApiRequest: () => false,
      isAuthenticatedRequest: () => false,
      logger: { warn: vi.fn() },
    });

    const req = {
      method: 'POST',
      path: '/config',
      headers: {},
    } as any;
    const res = createResponseMock();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('lets safe methods through trusted-origin checks even without bypass', () => {
    const next = vi.fn();
    const { requireTrustedOrigin } = createApiProtectionMiddleware({
      hasTrustedOrigin: () => false,
      isUnsafeMethod: (method) => method !== 'GET',
      isAuthorizedInternalBrowserApiRequest: () => false,
      isAuthenticatedRequest: () => false,
      logger: { warn: vi.fn() },
    });

    const req = {
      method: 'GET',
      path: '/browser/status',
      headers: {
        origin: 'https://evil.example',
        host: 'localhost:3377',
      },
    } as any;
    const res = createResponseMock();

    requireTrustedOrigin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
