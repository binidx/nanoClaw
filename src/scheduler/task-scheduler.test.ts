import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  listJobEvents,
  listJobStatuses,
} from '../db.js';
import { buildRunnerPromptPreview } from '../prompt/runner-prompt-runtime.js';
import {
  _resetSchedulerLoopForTests,
  buildScheduledTaskPromptEnvelope,
  computeTaskFailurePlan,
  computeNextRun,
  enqueueTaskRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    await createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = await getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');

    const jobs = await listJobStatuses({
      source: 'task_scheduler',
      subjectType: 'scheduled_task',
      subjectId: 'task-invalid-folder',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('failed');
    expect(jobs[0]?.error).toContain('Invalid group folder');

    const events = await listJobEvents(jobs[0]!.id);
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['started', 'failed']),
    );
  });

  it('pauses due tasks whose registered group no longer exists', async () => {
    await createTask({
      id: 'task-missing-group',
      group_folder: 'missing-group',
      chat_jid: 'missing@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = await getTaskById('task-missing-group');
    expect(task?.status).toBe('paused');
  });

  it('builds scheduled task prompt envelopes with lightweight runtime guidance', async () => {
    await createTask({
      id: 'task-envelope',
      group_folder: 'test-group',
      chat_jid: 'web:test-envelope',
      prompt: '提醒我下班打卡',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const task = await getTaskById('task-envelope');
    expect(task).toBeTruthy();

    const envelope = await buildScheduledTaskPromptEnvelope(task!, {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: '2026-02-22T00:00:00.000Z',
      requiresTrigger: false,
    });

    expect(envelope.prompt.text).toBe('提醒我下班打卡');
    expect(envelope.prompt.userPrompt).toBe('提醒我下班打卡');
    expect(envelope.prompt.stableSystemPrompt).toContain(
      'You are executing a scheduled assistant task for the user.',
    );
    expect(envelope.prompt.stableSystemPrompt).toContain(
      'This run was triggered by an existing scheduled task.',
    );
    expect(envelope.prompt.stableSystemPrompt).not.toContain(
      'You are a helpful coding assistant with access to tools.',
    );
    expect(envelope.prompt.stableSystemPrompt).not.toContain(
      'mcp__nanoclaw__browser_status',
    );
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('rejects duplicate manual enqueue while a task is already queued', async () => {
    await createTask({
      id: 'task-manual-dedupe',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueued: Array<() => Promise<void>> = [];
    const queue = {
      enqueueTask: vi.fn(
        (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
          enqueued.push(fn);
        },
      ),
    } as any;

    const deps = {
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue,
      onProcess: () => {},
      sendMessage: async () => {},
    };

    expect(await enqueueTaskRun('task-manual-dedupe', deps)).toEqual({
      ok: true,
    });
    expect(await enqueueTaskRun('task-manual-dedupe', deps)).toEqual({
      ok: false,
      error: 'Task is already queued or running',
    });
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(1);
  });

  it('scheduled runtime preview omits generic coding agent guidance', async () => {
    const preview = await buildRunnerPromptPreview({
      providerType: 'codex',
      projectDir: '/workspace/group',
      systemPromptProfile: 'scheduled_lightweight',
      managedSkillIds: ['imagegen'],
    });

    expect(preview.systemPromptText).toContain(
      'You are executing a scheduled assistant task for the user.',
    );
    expect(preview.systemPromptText).not.toContain(
      'You are a helpful coding assistant with access to tools.',
    );
    expect(preview.systemPromptText).not.toContain('web_search');
    expect(preview.systemPromptText).not.toContain('Sub-Agent Policy');
  });

  it('does not enqueue the same due task again while it is still queued', async () => {
    await createTask({
      id: 'task-due-dedupe',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueued: Array<() => Promise<void>> = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        enqueued.push(fn);
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'test@g.us': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: '2026-02-22T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(1);
  });

  it('schedules exponential retry when task failure is still within retry budget', () => {
    const now = new Date('2026-03-12T00:00:00.000Z').getTime();
    const plan = computeTaskFailurePlan(
      {
        id: 'task-retry',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'run',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-03-12T00:00:00.000Z',
        last_run: null,
        last_result: null,
        retry_limit: 2,
        retry_backoff_ms: 300000,
        failure_mode: 'continue',
        consecutive_failures: 0,
        last_error: null,
        status: 'active',
        created_at: '2026-03-12T00:00:00.000Z',
      },
      'network error',
      now,
    );

    expect(plan.retryScheduled).toBe(true);
    expect(plan.consecutiveFailures).toBe(1);
    expect(plan.nextRun).toBe('2026-03-12T00:05:00.000Z');
  });

  it('pauses tasks after retry budget is exhausted when failure mode is pause', () => {
    const now = new Date('2026-03-12T00:00:00.000Z').getTime();
    const plan = computeTaskFailurePlan(
      {
        id: 'task-pause',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'run',
        schedule_type: 'once',
        schedule_value: '2026-03-12T00:00:00.000Z',
        context_mode: 'isolated',
        next_run: '2026-03-12T00:00:00.000Z',
        last_run: null,
        last_result: null,
        retry_limit: 1,
        retry_backoff_ms: 60000,
        failure_mode: 'pause',
        consecutive_failures: 1,
        last_error: null,
        status: 'active',
        created_at: '2026-03-12T00:00:00.000Z',
      },
      'fatal error',
      now,
    );

    expect(plan.retryScheduled).toBe(false);
    expect(plan.status).toBe('paused');
    expect(plan.nextRun).toBeNull();
  });
});
