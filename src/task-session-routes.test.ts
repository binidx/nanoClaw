import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequirePermissionFn } from './auth/auth-middleware.js';
import {
  _initTestDatabase,
  createTask,
  getTaskById,
} from './db.js';
import { registerTaskSessionRoutes } from './routes/task-session-routes.js';
import { runWithTenantAsync } from './tenant/tenant-context.js';

const allowAllRequirePermission: RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp(
  userId: string,
  runTaskNow = vi.fn(async () => ({ ok: true })),
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { tenantUserId?: string }).tenantUserId = userId;
    next();
  });
  registerTaskSessionRoutes(app, {
    requirePermission: allowAllRequirePermission,
    auditMutation: vi.fn(),
    refreshTaskSnapshots: vi.fn(),
    runTaskNow,
    getTaskRuntimeState: () => null,
    clearCodexConversationState: vi.fn(),
    deriveTaskTitle: (title, prompt) =>
      String(title || prompt || 'Untitled').trim().slice(0, 80),
    generateAiTaskDraft: async () => ({}),
  });
  return app;
}

async function seedTask(input: {
  id: string;
  userId: string;
  chatJid: string;
  prompt: string;
}): Promise<void> {
  await runWithTenantAsync({ userId: input.userId }, async () => {
    await createTask({
      id: input.id,
      group_folder: `folder-${input.userId}`,
      chat_jid: input.chatJid,
      prompt: input.prompt,
      schedule_type: 'once',
      schedule_value: '2026-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-20T00:00:00.000Z',
    });
  });
}

describe('task session route ownership', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('lists only tasks owned by the current tenant user', async () => {
    await seedTask({
      id: 'task-user-a',
      userId: 'user-a',
      chatJid: 'chat-a@g.us',
      prompt: 'owned by a',
    });
    await seedTask({
      id: 'task-user-b',
      userId: 'user-b',
      chatJid: 'chat-b@g.us',
      prompt: 'owned by b',
    });

    const app = createApp('user-a');
    const response = await inject(app, {
      method: 'GET',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).tasks.map((task: { id: string }) => task.id)).toEqual([
      'task-user-a',
    ]);

    const filtered = await inject(app, {
      method: 'GET',
      url: '/api/tasks?chat_jid=chat-b%40g.us',
    });
    expect(filtered.statusCode).toBe(200);
    expect(JSON.parse(filtered.body).tasks).toEqual([]);
  });

  it('lists legacy system tasks without requiring a conversation filter', async () => {
    await seedTask({
      id: 'task-user-a',
      userId: 'user-a',
      chatJid: 'chat-a@g.us',
      prompt: 'owned by a',
    });
    await createTask({
      id: 'task-system',
      group_folder: 'folder-system',
      chat_jid: 'chat-system@g.us',
      prompt: 'legacy system task',
      schedule_type: 'once',
      schedule_value: '2026-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-05-20T00:00:01.000Z',
    });

    const response = await inject(createApp('user-a'), {
      method: 'GET',
      url: '/api/tasks',
    });

    expect(response.statusCode).toBe(200);
    expect(
      JSON.parse(response.body).tasks.map((task: { id: string }) => task.id),
    ).toEqual(['task-system', 'task-user-a']);
  });

  it('does not update another user task', async () => {
    await seedTask({
      id: 'task-user-b',
      userId: 'user-b',
      chatJid: 'chat-b@g.us',
      prompt: 'do not edit',
    });

    const response = await inject(createApp('user-a'), {
      method: 'PATCH',
      url: '/api/tasks/task-user-b',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ prompt: 'edited by a' }),
    });

    expect(response.statusCode).toBe(404);
    expect(await getTaskById('task-user-b')).toMatchObject({
      prompt: 'do not edit',
      status: 'active',
    });
  });

  it('does not delete or manually run another user task', async () => {
    await seedTask({
      id: 'task-user-b',
      userId: 'user-b',
      chatJid: 'chat-b@g.us',
      prompt: 'do not run or delete',
    });

    const runTaskNow = vi.fn(async () => ({ ok: true }));
    const app = createApp('user-a', runTaskNow);
    const runResponse = await inject(app, {
      method: 'POST',
      url: '/api/tasks/task-user-b/run',
    });
    const deleteResponse = await inject(app, {
      method: 'DELETE',
      url: '/api/tasks/task-user-b',
    });

    expect(runResponse.statusCode).toBe(404);
    expect(runTaskNow).not.toHaveBeenCalled();
    expect(deleteResponse.statusCode).toBe(404);
    expect(await getTaskById('task-user-b')).toBeDefined();
  });
});
