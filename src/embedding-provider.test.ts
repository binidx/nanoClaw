import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, dba } from './db.js';
import { OpenAIEmbeddingProvider } from './embedding/providers/openai.js';
import { embedAndStore } from './embedding/vector-store.js';
import type { EmbeddingProvider } from './embedding/provider.js';

describe('embedding provider dimensions', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('defaults Qwen3-Embedding-8B compatible providers to 4096 dimensions', () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'fake-key',
      baseUrl: 'https://embedding.example.com/v1',
      model: 'Qwen3-Embedding-8B-4bit-DWQ',
    });

    expect(provider.dimensions).toBe(4096);
  });

  it('stores the actual returned vector length instead of configured dimensions', async () => {
    const provider: EmbeddingProvider = {
      name: 'fake',
      configKey: 'fake:dimensions',
      dimensions: 1536,
      embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
      embedQuery: async () => [0.1, 0.2, 0.3],
    };

    await embedAndStore('knowledge', 'chunk-dimensions', 'hello', provider, 'provider-dimensions');

    const row = (await dba
      .prepare('SELECT dimensions FROM embedding_vectors WHERE owner_type = ? AND owner_id = ?')
      .get('knowledge', 'chunk-dimensions')) as { dimensions: number } | undefined;

    expect(row?.dimensions).toBe(3);
  });
});
