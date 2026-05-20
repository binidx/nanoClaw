import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retrieveContextMock } = vi.hoisted(() => ({
  retrieveContextMock: vi.fn(async (request: unknown) => ({
    candidates: [],
    trace: {
      query: (request as { query?: string }).query ?? '',
      queryVariants: [(request as { query?: string }).query ?? ''],
      stages: [],
      strategy: { multiQuery: false, mmr: true, rerank: 'local' },
      candidateCount: 0,
      returnedCount: 0,
      latencyMs: 0,
    },
  })),
}));

vi.mock('./retrieval/service.js', () => ({
  retrieveContext: retrieveContextMock,
}));

import { createKnowledgeBase } from './db/assistants.js';
import { _initTestDatabase } from './db/init.js';
import { registerInternalRetrievalRoutes } from './routes/internal-retrieval-routes.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-retrieval',
  name: 'Retrieval KB',
  description: null,
  owner_type: 'system',
  owner_id: null,
  embedding_model: null,
  embedding_provider_id: null,
  chunk_size: 300,
  chunk_overlap: 60,
  cleanup_patterns: null,
  enabled: 1,
  user_id: '__system__',
  category: 'general',
  visibility: 'shared',
  enhancement_level: 'metadata',
  llm_provider_id: null,
  llm_model_override: null,
  temporal_half_life_days: 365,
  allow_query_backfill: 0,
  created_at: '2026-05-20T00:00:00.000Z',
  updated_at: '2026-05-20T00:00:00.000Z',
};

function createApp() {
  const app = express();
  app.use(express.json());
  registerInternalRetrievalRoutes(app, {
    requireInternalApi: (_req, _res, next) => next(),
  });
  return app;
}

describe('internal retrieval routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    retrieveContextMock.mockClear();
  });

  it('filters requested KBs to agent-accessible KBs before retrieval', async () => {
    await createKnowledgeBase(BASE_KB);
    await createKnowledgeBase({
      ...BASE_KB,
      id: 'kb-other',
      name: 'Other KB',
      user_id: 'other-user',
      visibility: 'private',
    });

    const response = await inject(createApp(), {
      method: 'POST',
      url: '/internal/retrieval/search',
      payload: {
        user_id: 'user-a',
        query: 'rag eval',
        kb_ids: ['kb-retrieval', 'kb-other'],
        include_memory: true,
        memory: { ownerType: 'global', ownerId: 'user-a', sourceTypes: ['user_memory'] },
        strategy: { multiQuery: true },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(retrieveContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'rag eval',
        kbIds: ['kb-retrieval'],
        includeMemory: true,
        memory: { ownerType: 'global', ownerId: 'user-a', sourceTypes: ['user_memory'] },
        strategy: { multiQuery: true },
      }),
    );
  });

  it('does not forward invalid min_score as NaN', async () => {
    await createKnowledgeBase(BASE_KB);

    const response = await inject(createApp(), {
      method: 'POST',
      url: '/internal/retrieval/search',
      payload: {
        user_id: 'user-a',
        query: 'rag eval',
        min_score: 'bad',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(retrieveContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        minScore: undefined,
      }),
    );
  });
});
