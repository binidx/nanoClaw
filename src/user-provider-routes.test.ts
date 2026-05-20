import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerUserProviderRoutes } from './routes/user-provider-routes.js';

const testRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const {
  getProvidersForUser,
  getProvider,
  getDefaultProviderForUser,
  getKnowledgeBaseProviderUsage,
  getProviderShareList,
  isProviderVisibleToUser,
  revokeProviderShare,
  setUserDefaultProviderPreference,
  shareProviderWithUser,
  updateProvider,
  createProvider,
  deleteProvider,
  testAiProviderConnection,
} = vi.hoisted(() => ({
  getProvidersForUser: vi.fn(() => []),
  getProvider: vi.fn(),
  getDefaultProviderForUser: vi.fn(),
  getKnowledgeBaseProviderUsage: vi.fn(() => ({ llmRefs: 0, embeddingRefs: 0 })),
  getProviderShareList: vi.fn(() => []),
  isProviderVisibleToUser: vi.fn(() => false),
  revokeProviderShare: vi.fn(),
  setUserDefaultProviderPreference: vi.fn(),
  shareProviderWithUser: vi.fn(),
  updateProvider: vi.fn(),
  createProvider: vi.fn(),
  deleteProvider: vi.fn(),
  testAiProviderConnection: vi.fn(async () => ({ ok: true, status: 'success', message: 'ok' })),
}));

vi.mock('./db.js', () => ({
  createProvider,
  deleteProvider,
  getProvidersForUser,
  getProvider,
  getDefaultProviderForUser,
  getKnowledgeBaseProviderUsage,
  getProviderShareList,
  isProviderVisibleToUser,
  revokeProviderShare,
  setUserDefaultProviderPreference,
  shareProviderWithUser,
  updateProvider,
}));

vi.mock('./tenant/tenant-request.js', () => ({
  getTenantUserId: () => 'user-current',
}));

vi.mock('./crypto.js', () => ({
  encryptValue: (value: string) => `enc:${value}`,
  maskApiKey: (value: string) => `****${value.slice(-4)}`,
}));

vi.mock('./provider/provider-registry.js', () => ({
  isValidProviderType: (type: string, capability?: string) =>
    capability === 'embedding'
      ? ['openai', 'zhipu', 'ollama'].includes(type)
      : ['openai', 'codex', 'claude'].includes(type),
}));

vi.mock('./provider/provider-api.js', () => ({
  testAiProviderConnection,
}));

vi.mock('./logger.js', () => ({
  createModuleLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

function normalizeFetchHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const baseUrl = 'http://local.test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(rawUrl);
    if (url.origin !== baseUrl) return originalFetch(input, init);
    const response = await inject(app, {
      method: init?.method || 'GET',
      url: `${url.pathname}${url.search}`,
      headers: normalizeFetchHeaders(init?.headers),
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  }) as typeof fetch;
  try {
    await run(baseUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  registerUserProviderRoutes(app, { requirePermission: testRequirePermission });
  return app;
}

describe('user provider routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProvidersForUser.mockResolvedValue([]);
    getProvider.mockResolvedValue(undefined);
    getDefaultProviderForUser.mockResolvedValue(undefined);
    getKnowledgeBaseProviderUsage.mockResolvedValue({ llmRefs: 0, embeddingRefs: 0 });
    getProviderShareList.mockResolvedValue([]);
    isProviderVisibleToUser.mockResolvedValue(false);
    revokeProviderShare.mockResolvedValue(undefined);
    setUserDefaultProviderPreference.mockResolvedValue(undefined);
    shareProviderWithUser.mockResolvedValue(undefined);
    updateProvider.mockResolvedValue(undefined);
    createProvider.mockResolvedValue(undefined);
    deleteProvider.mockResolvedValue(undefined);
    testAiProviderConnection.mockResolvedValue({ ok: true, status: 'success', message: 'ok' });
  });

  it('sets and clears the current user default provider preference', async () => {
    const app = buildApp();

    await withServer(app, async (baseUrl) => {
      const setResponse = await fetch(`${baseUrl}/api/user/providers/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-shared' }),
      });
      expect(setResponse.status).toBe(200);
      expect(setUserDefaultProviderPreference).toHaveBeenCalledWith(
        'user-current',
        'provider-shared',
        'user-current',
      );

      const clearResponse = await fetch(`${baseUrl}/api/user/providers/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: null }),
      });
      expect(clearResponse.status).toBe(200);
      expect(setUserDefaultProviderPreference).toHaveBeenCalledWith(
        'user-current',
        null,
        'user-current',
      );
    });
  });

  it('shares and revokes an owned personal provider', async () => {
    const app = buildApp();

    await withServer(app, async (baseUrl) => {
      const shareResponse = await fetch(`${baseUrl}/api/user/providers/provider-own/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'user-target' }),
      });
      expect(shareResponse.status).toBe(200);
      expect(shareProviderWithUser).toHaveBeenCalledWith(
        'provider-own',
        'user-target',
        'user-current',
      );

      const revokeResponse = await fetch(
        `${baseUrl}/api/user/providers/provider-own/shares/user-target`,
        { method: 'DELETE' },
      );
      expect(revokeResponse.status).toBe(200);
      expect(revokeProviderShare).toHaveBeenCalledWith(
        'provider-own',
        'user-target',
        'user-current',
      );
    });
  });

  it('does not allow editing a provider owned by another user through personal routes', async () => {
    getProvider.mockResolvedValue({
      id: 'provider-shared',
      alias: 'Shared',
      type: 'openai',
      api_key: 'key',
      base_url: null,
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      user_id: 'user-owner',
      visibility: 'private',
      created_by: 'user-owner',
      updated_by: 'user-owner',
      created_at: 'now',
      updated_at: 'now',
      deleted_at: null,
    });
    const app = buildApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers/provider-shared`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'Mutated' }),
      });
      expect(response.status).toBe(404);
      expect(updateProvider).not.toHaveBeenCalled();
    });
  });

  it('rejects setting an embedding provider as the default chat provider', async () => {
    const app = buildApp();

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: 'Embeddings',
          type: 'openai',
          capability: 'embedding',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          is_default: true,
        }),
      });
      expect(response.status).toBe(400);
      expect(createProvider).not.toHaveBeenCalled();
    });
  });

  it('returns requiresKnowledgeReembed when an in-use embedding provider changes material fields', async () => {
    getProvider.mockResolvedValue({
      id: 'provider-embedding',
      alias: 'Embeddings',
      type: 'openai',
      capability: 'embedding',
      api_key: 'enc:key',
      base_url: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      extra_config: null,
      is_default: 0,
      user_id: 'user-current',
      visibility: 'private',
      created_by: 'user-current',
      updated_by: 'user-current',
      created_at: 'now',
      updated_at: 'now',
      deleted_at: null,
    });
    getKnowledgeBaseProviderUsage.mockResolvedValue({ llmRefs: 0, embeddingRefs: 2 });

    const app = buildApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers/provider-embedding`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: 'embedding',
          type: 'openai',
          model: 'text-embedding-3-large',
          dimensions: 3072,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        requiresKnowledgeReembed: true,
        knowledgeBaseRefs: 2,
      });
    });
  });

  it('clears an owned provider API key only through an explicit secret action', async () => {
    getProvider.mockResolvedValue({
      id: 'provider-own',
      alias: 'Mine',
      type: 'openai',
      capability: 'llm',
      api_key: 'enc:old-key',
      base_url: null,
      model: 'gpt-4.1',
      dimensions: null,
      extra_config: null,
      is_default: 0,
      user_id: 'user-current',
      visibility: 'private',
      created_by: 'user-current',
      updated_by: 'user-current',
      created_at: 'now',
      updated_at: 'now',
      deleted_at: null,
    });

    const app = buildApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers/provider-own`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alias: 'Mine',
          api_key: '',
          api_key_action: 'clear',
        }),
      });
      expect(response.status).toBe(200);
      expect(updateProvider).toHaveBeenCalledWith(
        'provider-own',
        expect.objectContaining({
          api_key: null,
          updated_by: 'user-current',
        }),
      );
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        apiKeyAction: 'clear',
        apiKeyChanged: true,
      });
    });
  });

  it('rejects rotate secret action without a new unmasked API key', async () => {
    getProvider.mockResolvedValue({
      id: 'provider-own',
      alias: 'Mine',
      type: 'openai',
      capability: 'llm',
      api_key: 'enc:old-key',
      base_url: null,
      model: 'gpt-4.1',
      dimensions: null,
      extra_config: null,
      is_default: 0,
      user_id: 'user-current',
      visibility: 'private',
      created_by: 'user-current',
      updated_by: 'user-current',
      created_at: 'now',
      updated_at: 'now',
      deleted_at: null,
    });

    const app = buildApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers/provider-own`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: '********',
          api_key_action: 'rotate',
        }),
      });
      expect(response.status).toBe(400);
      expect(updateProvider).not.toHaveBeenCalled();
    });
  });

  it('returns diagnostic provider probe status', async () => {
    getProvider.mockResolvedValue({
      id: 'provider-own',
      alias: 'Mine',
      type: 'openai',
      capability: 'llm',
      api_key: 'enc:key',
      base_url: null,
      model: 'gpt-4.1',
      dimensions: null,
      extra_config: null,
      is_default: 0,
      user_id: 'user-current',
      visibility: 'private',
      created_by: 'user-current',
      updated_by: 'user-current',
      created_at: 'now',
      updated_at: 'now',
      deleted_at: null,
    });
    isProviderVisibleToUser.mockResolvedValue(true);
    testAiProviderConnection.mockResolvedValue({
      ok: false,
      status: 'http_error',
      message: 'API error 401',
      httpStatus: 401,
      providerType: 'openai',
      capability: 'llm',
    });

    const app = buildApp();
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/user/providers/provider-own/test`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        status: 'http_error',
        httpStatus: 401,
        providerType: 'openai',
        capability: 'llm',
      });
    });
  });
});
