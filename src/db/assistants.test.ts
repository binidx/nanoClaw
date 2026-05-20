import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createProvider,
  dba,
  getDefaultProvider,
  getDefaultProviderForUser,
} from '../db.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

describe('assistant provider defaults', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('falls back to an older own LLM provider when the newest own provider is embedding-only', async () => {
    await createProvider({
      id: 'own-llm',
      alias: 'Own LLM',
      type: 'openai',
      capability: 'llm',
      api_key: 'key-llm',
      base_url: 'https://llm.example.com',
      model: 'gpt-5.4',
      extra_config: null,
      is_default: 0,
      user_id: 'user-provider-owner',
      visibility: 'private',
    });
    await createProvider({
      id: 'own-embedding',
      alias: 'Own Embedding',
      type: 'openai',
      capability: 'embedding',
      api_key: 'key-embedding',
      base_url: 'https://embedding.example.com',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      extra_config: null,
      is_default: 0,
      user_id: 'user-provider-owner',
      visibility: 'private',
    });
    await dba
      .prepare('UPDATE ai_providers SET updated_at = ? WHERE id = ?')
      .run('2026-05-20T00:00:01.000Z', 'own-llm');
    await dba
      .prepare('UPDATE ai_providers SET updated_at = ? WHERE id = ?')
      .run('2026-05-20T00:00:02.000Z', 'own-embedding');

    await expect(
      getDefaultProviderForUser('user-provider-owner'),
    ).resolves.toEqual(expect.objectContaining({ id: 'own-llm' }));
  });

  it('resolves system defaults through the same user-visible provider path', async () => {
    await createProvider({
      id: 'system-private-default',
      alias: 'System Private Default',
      type: 'openai',
      capability: 'llm',
      api_key: 'key-system',
      base_url: 'https://system.example.com',
      model: 'gpt-5.4',
      extra_config: null,
      is_default: 1,
      user_id: SYSTEM_USER_ID,
      visibility: 'private',
    });

    await expect(getDefaultProvider()).resolves.toEqual(
      expect.objectContaining({ id: 'system-private-default' }),
    );
  });
});
