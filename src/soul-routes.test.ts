import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  addMemorySkill,
  getMemorySkill,
  getUserMemories,
  listMemorySkills,
  listPersonaInsights,
  listUserMemoryObservations,
  searchMemoryDocuments,
} from './db.js';
import { registerSoulRoutes } from './routes/soul-routes.js';
import { getUserByUsername } from './user/user-service.js';

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
