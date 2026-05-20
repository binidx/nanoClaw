import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  completeJobStatus,
  createJobStatus,
  getJobStatus,
  listJobEvents,
  listJobStatuses,
  startJobStatus,
} from '../db.js';

describe('job status persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores reusable job status records and ordered events', async () => {
    const job = await startJobStatus({
      id: 'job-1',
      source: 'task_scheduler',
      subjectType: 'scheduled_task',
      subjectId: 'task-1',
      runKey: 'task-1:2026-05-20T00:00:00.000Z',
      title: 'Daily summary',
      startedAt: '2026-05-20T00:00:00.000Z',
      metadata: { scheduleType: 'once' },
      message: 'Started',
      eventData: { queue: 'tasks' },
    });

    expect(job.status).toBe('running');
    expect(job.metadata_json).toBe(JSON.stringify({ scheduleType: 'once' }));

    await completeJobStatus(job.id, {
      status: 'succeeded',
      finishedAt: '2026-05-20T00:00:02.000Z',
      durationMs: 2000,
      result: { summary: 'done' },
      message: 'Completed',
    });

    const stored = await getJobStatus(job.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.duration_ms).toBe(2000);
    expect(stored?.result_json).toBe(JSON.stringify({ summary: 'done' }));

    const events = await listJobEvents(job.id);
    expect(events.map((event) => event.event_type)).toEqual([
      'started',
      'succeeded',
    ]);
    expect(events[0]?.data_json).toBe(JSON.stringify({ queue: 'tasks' }));
  });

  it('lists statuses by source and subject without coupling to a domain table', async () => {
    await createJobStatus({
      id: 'job-task',
      source: 'task_scheduler',
      subjectType: 'scheduled_task',
      subjectId: 'task-2',
      status: 'queued',
    });
    await createJobStatus({
      id: 'job-other',
      source: 'other_worker',
      subjectType: 'scheduled_task',
      subjectId: 'task-2',
      status: 'queued',
    });

    const statuses = await listJobStatuses({
      source: 'task_scheduler',
      subjectType: 'scheduled_task',
      subjectId: 'task-2',
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.id).toBe('job-task');
  });
});
