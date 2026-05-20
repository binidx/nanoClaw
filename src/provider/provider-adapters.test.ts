import { afterEach, describe, expect, it, vi } from 'vitest';

import { encryptValue } from '../crypto.js';
import { getProviderAdapter } from './provider-adapters.js';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('provider-adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_ENCRYPTION_KEY === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    }
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
      capability: 'llm',
      api_key: 'secret',
      base_url: 'https://gateway.example.com',
      model: 'gpt-5.4',
      dimensions: null,
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

  it('decrypts encrypted provider keys before sending requests', async () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
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
      capability: 'llm',
      api_key: encryptValue('runtime-secret'),
      base_url: 'https://gateway.example.com',
      model: 'gpt-5.4',
      dimensions: null,
      extra_config: null,
      is_default: 0,
      user_id: 'user-1',
      visibility: 'private',
      created_by: 'user-1',
      updated_by: 'user-1',
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-05-20T00:00:00.000Z',
      deleted_at: null,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: 'Bearer runtime-secret',
      },
    });
  });
});
