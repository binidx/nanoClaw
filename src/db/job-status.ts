import crypto from 'crypto';

import { getCurrentUserId } from '../tenant/tenant-context.js';
import type {
  AppendJobEventInput,
  CreateJobStatusInput,
  JobEventRecord,
  JobEventType,
  JobStatus,
  JobStatusRecord,
} from '../jobs/job-status.js';
import { dba } from './engine-access.js';

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function resolveUserId(userId?: string): string {
  return userId || getCurrentUserId();
}

export async function createJobStatus(
  input: CreateJobStatusInput,
): Promise<JobStatusRecord> {
  const now = input.now || new Date().toISOString();
  const id = input.id || crypto.randomUUID();
  const userId = resolveUserId(input.userId);
  await dba.prepare(
    `
    INSERT INTO job_statuses (
      id, source, subject_type, subject_id, run_key, status, title,
      started_at, finished_at, duration_ms, result_json, error, metadata_json,
      user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.source,
    input.subjectType,
    input.subjectId,
    input.runKey ?? null,
    input.status || 'queued',
    input.title ?? null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.durationMs ?? null,
    serializeJson(input.result),
    input.error ?? null,
    serializeJson(input.metadata),
    userId,
    now,
    now,
  );
  const record = await getJobStatus(id);
  if (!record) throw new Error(`Job status was not created: ${id}`);
  return record;
}

export async function updateJobStatus(
  id: string,
  input: {
    status?: JobStatus;
    title?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    result?: unknown;
    error?: string | null;
    metadata?: unknown;
    updatedAt?: string;
  },
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.status !== undefined) {
    fields.push('status = ?');
    values.push(input.status);
  }
  if (input.title !== undefined) {
    fields.push('title = ?');
    values.push(input.title);
  }
  if (input.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(input.startedAt);
  }
  if (input.finishedAt !== undefined) {
    fields.push('finished_at = ?');
    values.push(input.finishedAt);
  }
  if (input.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    values.push(input.durationMs);
  }
  if (input.result !== undefined) {
    fields.push('result_json = ?');
    values.push(serializeJson(input.result));
  }
  if (input.error !== undefined) {
    fields.push('error = ?');
    values.push(input.error);
  }
  if (input.metadata !== undefined) {
    fields.push('metadata_json = ?');
    values.push(serializeJson(input.metadata));
  }

  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(input.updatedAt || new Date().toISOString(), id);
  await dba.prepare(
    `UPDATE job_statuses SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export async function appendJobEvent(
  input: AppendJobEventInput,
): Promise<JobEventRecord> {
  const id = input.id || crypto.randomUUID();
  const createdAt = input.createdAt || new Date().toISOString();
  const userId = resolveUserId(input.userId);
  await dba.prepare(
    `
    INSERT INTO job_events (
      id, job_id, event_type, status, message, data_json, user_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.jobId,
    input.eventType,
    input.status ?? null,
    input.message ?? null,
    serializeJson(input.data),
    userId,
    createdAt,
  );
  const event = await dba.prepare(
    `SELECT * FROM job_events WHERE id = ?`,
  ).get(id) as JobEventRecord | undefined;
  if (!event) throw new Error(`Job event was not created: ${id}`);
  return event;
}

export async function startJobStatus(
  input: Omit<CreateJobStatusInput, 'status'> & {
    message?: string | null;
    eventData?: unknown;
  },
): Promise<JobStatusRecord> {
  const startedAt = input.startedAt || input.now || new Date().toISOString();
  const job = await createJobStatus({
    ...input,
    status: 'running',
    startedAt,
    now: input.now || startedAt,
  });
  await appendJobEvent({
    jobId: job.id,
    eventType: 'started',
    status: 'running',
    message: input.message ?? null,
    data: input.eventData,
    userId: input.userId,
    createdAt: startedAt,
  });
  return job;
}

export async function completeJobStatus(
  jobId: string,
  input: {
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled' | 'skipped'>;
    result?: unknown;
    error?: string | null;
    metadata?: unknown;
    message?: string | null;
    eventType?: JobEventType;
    eventData?: unknown;
    finishedAt?: string;
    durationMs?: number | null;
    userId?: string;
  },
): Promise<void> {
  const finishedAt = input.finishedAt || new Date().toISOString();
  await updateJobStatus(jobId, {
    status: input.status,
    finishedAt,
    durationMs: input.durationMs ?? null,
    result: input.result,
    error: input.error ?? null,
    metadata: input.metadata,
    updatedAt: finishedAt,
  });
  await appendJobEvent({
    jobId,
    eventType: input.eventType || input.status,
    status: input.status,
    message: input.message ?? null,
    data: input.eventData ?? input.result,
    userId: input.userId,
    createdAt: finishedAt,
  });
}

export async function getJobStatus(
  id: string,
): Promise<JobStatusRecord | undefined> {
  return await dba.prepare(
    `SELECT * FROM job_statuses WHERE id = ?`,
  ).get(id) as JobStatusRecord | undefined;
}

export async function listJobStatuses(filter?: {
  source?: string;
  subjectType?: string;
  subjectId?: string;
  status?: JobStatus;
  limit?: number;
}): Promise<JobStatusRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter?.source) {
    clauses.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.subjectType) {
    clauses.push('subject_type = ?');
    values.push(filter.subjectType);
  }
  if (filter?.subjectId) {
    clauses.push('subject_id = ?');
    values.push(filter.subjectId);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    values.push(filter.status);
  }
  const limit = Math.max(1, Math.min(500, Number(filter?.limit || 100)));
  values.push(limit);
  return await dba.prepare(
    `
    SELECT * FROM job_statuses
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...values) as JobStatusRecord[];
}

export async function listJobEvents(jobId: string): Promise<JobEventRecord[]> {
  return await dba.prepare(
    `
    SELECT * FROM job_events
    WHERE job_id = ?
    ORDER BY created_at ASC, id ASC
  `,
  ).all(jobId) as JobEventRecord[];
}
