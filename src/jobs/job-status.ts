export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type JobEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface JobStatusRecord {
  id: string;
  source: string;
  subject_type: string;
  subject_id: string;
  run_key: string | null;
  status: JobStatus;
  title: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  result_json: string | null;
  error: string | null;
  metadata_json: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface JobEventRecord {
  id: string;
  job_id: string;
  event_type: JobEventType;
  status: JobStatus | null;
  message: string | null;
  data_json: string | null;
  user_id: string;
  created_at: string;
}

export interface CreateJobStatusInput {
  id?: string;
  source: string;
  subjectType: string;
  subjectId: string;
  runKey?: string | null;
  status?: JobStatus;
  title?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  result?: unknown;
  error?: string | null;
  metadata?: unknown;
  userId?: string;
  now?: string;
}

export interface AppendJobEventInput {
  id?: string;
  jobId: string;
  eventType: JobEventType;
  status?: JobStatus | null;
  message?: string | null;
  data?: unknown;
  userId?: string;
  createdAt?: string;
}
