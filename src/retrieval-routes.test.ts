import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { retrieveContextMock, getCurrentUserIdMock } = vi.hoisted(() => ({
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
  getCurrentUserIdMock: vi.fn(() => 'user-a'),
}));

vi.mock('./retrieval/service.js', () => ({
  retrieveContext: retrieveContextMock,
}));

vi.mock('./tenant/tenant-context.js', () => ({
  getCurrentUserId: getCurrentUserIdMock,
  SYSTEM_USER_ID: '__system__',
}));

import { createKnowledgeBase } from './db/assistants.js';
import { _initTestDatabase } from './db/init.js';
import { registerRetrievalRoutes } from './routes/retrieval-routes.js';
import type { KnowledgeBaseRecord } from './types/context.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const BASE_KB: KnowledgeBaseRecord = {
  id: 'kb-public-retrieval',
  name: 'Public Retrieval KB',
  description: null,
  owner_type: 'user',
  owner_id: 'user-a',
  embedding_model: null,
  embedding_provider_id: null,
  chunk_size: 300,
  chunk_overlap: 60,
  cleanup_patterns: null,
  enabled: 1,
  user_id: 'user-a',
  category: 'general',
  visibility: 'private',
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
  registerRetrievalRoutes(app, {
    requirePermission: allowAllRequirePermission,
  });
  return app;
}

describe('retrieval routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    retrieveContextMock.mockClear();
    getCurrentUserIdMock.mockReturnValue('user-a');
  });

  it('derives public memory scope from the current user instead of trusting request body', async () => {
    await createKnowledgeBase(BASE_KB);

    const response = await inject(createApp(), {
      method: 'POST',
      url: '/api/retrieval/search',
      payload: {
        query: 'preferences',
        include_memory: true,
        memory: {
          scopes: ['global'],
          ownerType: 'global',
          ownerId: 'other-user',
          sourceTypes: ['memory_file'],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(retrieveContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeMemory: true,
        memory: {
          scopes: ['global'],
          ownerType: 'global',
          ownerId: 'user-a',
          sourceTypes: ['user_memory'],
        },
      }),
    );
  });

  it('does not forward invalid min_score as NaN', async () => {
    await createKnowledgeBase(BASE_KB);

    const response = await inject(createApp(), {
      method: 'POST',
      url: '/api/retrieval/search',
      payload: {
        query: 'rag',
        min_score: 'not-a-number',
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
