import { afterEach, describe, expect, it } from 'vitest';

import { encryptValue } from '../crypto.js';
import type { AiProvider } from '../db/assistants.js';
import { buildAgentEnv } from './provider-registry.js';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'provider-1',
    alias: 'Gateway',
    type: 'openai',
    capability: 'llm',
    api_key: 'secret',
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
    ...overrides,
  };
}

describe('provider-registry runtime secrets', () => {
  afterEach(() => {
    if (ORIGINAL_ENCRYPTION_KEY === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    }
  });

  it('decrypts encrypted provider keys before building agent env', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    const env = buildAgentEnv(
      provider({ api_key: encryptValue('runtime-secret') }),
      'gpt-5.4',
      { CODEX_MAX_TOOL_ITERATIONS: '120' },
    );

    expect(env.OPENAI_API_KEY).toBe('runtime-secret');
    expect(env.CODEX_MAX_TOOL_ITERATIONS).toBe('120');
  });
});
