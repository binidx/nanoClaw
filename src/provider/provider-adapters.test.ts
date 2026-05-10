import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderAdapter } from './provider-adapters.js';

describe('provider-adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends custom headers and user agent for openai-compatible providers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          model: 'gpt-5.4',
          choices: [{ message: { content: 'ok' } }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ));
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const adapter = getProviderAdapter('openai_compatible');
    const result = await adapter.testConnection({
      id: 'provider-1',
      alias: 'Gateway',
      type: 'openai_compatible',
      api_key: 'secret',
      base_url: 'https://gateway.example.com',
      model: 'gpt-5.4',
      extra_config: JSON.stringify({
        userAgent: 'NanoClaw/1.0',
        headers: { 'X-Client': 'portable-ui' },
      }),
      is_default: 0,
      user_id: '__system__',
      visibility: 'public',
      created_by: '__system__',
      updated_by: '__system__',
      created_at: '2026-04-22T00:00:00.000Z',
      updated_at: '2026-04-22T00:00:00.000Z',
      deleted_at: null,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'X-Client': 'portable-ui',
        'User-Agent': 'NanoClaw/1.0',
      },
    });
  });
});
