import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  addUserMemory,
  addMemorySkill,
  getMemorySkill,
  getUserMemories,
  listMemoryDocuments,
  listMemorySkills,
  listPersonaInsights,
  listUserMemoryObservations,
  searchMemoryDocuments,
  upsertMemoryDocuments,
} from './db.js';
import { registerSoulRoutes } from './routes/soul-routes.js';
import { getUserByUsername } from './user/user-service.js';
import type { UserMemoryRecord } from './types.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp() {
  const app = express();
  app.use(express.json());
  registerSoulRoutes(app, {
    getAuthenticatedUsername: () => 'soul-import-user',
    requirePermission: allowAllRequirePermission,
  });
  return app;
}

describe('soul routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('summarizes soul import dry-runs without writing data', async () => {
    const app = createApp();
    const response = await inject(app, {
      method: 'POST',
      url: '/api/soul/import',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        dryRun: true,
        data: {
          soul: { name: 'Dry Run Soul' },
          memories: [{ content: 'Prefers concise answers' }],
          observations: [{ content: 'Often asks for direct commands' }],
          insights: [{ content: 'Likes compact responses' }],
          skills: [{ name: 'Release checklist', body: 'Run tests.' }],
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      dryRun: true,
      summary: {
        soul: 1,
        memories: 1,
        observations: 1,
        insights: 1,
        skills: 1,
      },
    });

    const user = await getUserByUsername('soul-import-user');
    expect(user).toBeTruthy();
    expect(await getUserMemories(user!.id, { timeScope: 'all' })).toEqual([]);
  });

  it('imports memories with projections and skips duplicate memory imports', async () => {
    const app = createApp();
    const importPayload = {
      data: {
        soul: {
          name: 'Archive Soul',
          enabled: 1,
          auto_evolve: 1,
        },
        memories: [
          {
            content: 'User prefers concise answers',
            category: 'preference',
            importance: 7,
            scope: 'global',
            source: 'manual',
          },
        ],
        observations: [
          {
            content: 'User repeats release checklist requests',
            category: 'habit',
            confidence: 0.4,
          },
        ],
        insights: [
          {
            content: 'Use compact responses for routine tasks',
            insight_type: 'response_preference',
            confidence: 0.8,
            status: 'active',
          },
        ],
        skills: [
          {
            name: 'Release checklist',
            trigger_pattern: 'release',
            body: 'Run build and targeted tests.',
            status: 'active',
          },
        ],
      },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await inject(app, {
        method: 'POST',
        url: '/api/soul/import',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(importPayload),
      });
      expect(response.statusCode).toBe(200);
    }

    const user = await getUserByUsername('soul-import-user');
    expect(user).toBeTruthy();
    const memories = await getUserMemories(user!.id, { timeScope: 'all' });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toEqual(
      expect.objectContaining({
        content: 'User prefers concise answers',
        category: 'preference',
      }),
    );
    expect(
      await searchMemoryDocuments('concise answers', {
        ownerType: 'global',
        ownerId: user!.id,
        sourceTypes: ['user_memory'],
      }),
    ).toEqual([
      expect.objectContaining({
        sourceType: 'user_memory',
        pathRef: `user_memory:${memories[0]!.id}`,
      }),
    ]);
    expect(await listUserMemoryObservations(user!.id)).toHaveLength(1);
    expect(await listPersonaInsights(user!.id)).toHaveLength(1);
    expect(await listMemorySkills({ userId: user!.id })).toHaveLength(1);
  });

  it('repairs current user memory projections from the Soul API', async () => {
    const app = createApp();
    await inject(app, {
      method: 'GET',
      url: '/api/soul/memories',
    });
    const user = await getUserByUsername('soul-import-user');
    expect(user).toBeTruthy();
    const memory: UserMemoryRecord = {
      id: 'soul-projection-memory',
      user_id: user!.id,
      scope: 'global',
      conversation_id: null,
      category: 'preference',
      content: 'User wants memory UI to expose projection health.',
      importance: 7,
      confidence: 0.9,
      source: 'manual',
      tier: 'durable',
      promoted_from: null,
      last_verified_at: null,
      source_event_id: null,
      valid_from: '2026-05-20T00:00:00.000Z',
      valid_to: null,
      access_count: 0,
      last_accessed_at: null,
      expires_at: null,
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-05-20T00:00:00.000Z',
    };
    await addUserMemory(memory);
    await upsertMemoryDocuments([
      {
        doc_id: 'user-memory:soul-orphan-projection',
        scope: 'global',
        owner_type: 'global',
        owner_id: user!.id,
        path_ref: 'user_memory:soul-orphan-projection',
        source_type: 'user_memory',
        title: 'orphaned user memory',
        body: 'This projection should be removed by repair.',
        metadata_json: JSON.stringify({ memoryId: 'soul-orphan-projection' }),
        updated_at: '2026-05-20T00:01:00.000Z',
      },
    ]);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/soul/memory-documents/repair',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      checkedMemories: 1,
      projectedDocuments: 1,
      deletedOrphans: 1,
      after: {
        missingDocuments: 0,
        orphanDocuments: 0,
      },
    });
    expect(
      (
        await listMemoryDocuments({
          ownerType: 'global',
          ownerId: user!.id,
          sourceType: 'user_memory',
          limit: 10,
        })
      ).map((document) => document.path_ref),
    ).toEqual(['user_memory:soul-projection-memory']);
  });

  it('does not update or delete another user memory skill', async () => {
    const app = createApp();
    const now = new Date().toISOString();
    await addMemorySkill({
      id: 'skill-other-user',
      user_id: 'other-user',
      scope: 'global',
      name: 'Other skill',
      trigger_pattern: 'other',
      body: 'Original body',
      termination_condition: null,
      success_count: 0,
      failure_count: 0,
      last_used_at: null,
      last_verified_at: null,
      status: 'active',
      metadata_json: null,
      created_at: now,
      updated_at: now,
    });

    const updateResponse = await inject(app, {
      method: 'PUT',
      url: '/api/soul/memory-skills/skill-other-user',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'Tampered body' }),
    });
    expect(updateResponse.statusCode).toBe(404);
    expect(await getMemorySkill('skill-other-user')).toMatchObject({
      user_id: 'other-user',
      body: 'Original body',
    });

    const deleteResponse = await inject(app, {
      method: 'DELETE',
      url: '/api/soul/memory-skills/skill-other-user',
    });
    expect(deleteResponse.statusCode).toBe(404);
    expect(await getMemorySkill('skill-other-user')).toBeTruthy();
  });
});
