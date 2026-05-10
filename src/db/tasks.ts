import crypto from 'crypto';
import {
  type AssistantConfig,
  createDefaultAssistantConfig,
  normalizeAssistantConfig,
  serializeAssistantConfig,
} from '../assistant/assistant-config.js';
import {
  type AssistantMcpBindingRecord,
  type AssistantMcpBindingSecretRecord,
  createAssistantMcpBindingId,
} from '../assistant/assistant-mcp.js';
import { ASSISTANT_NAME, DATA_DIR, STORE_DIR, invalidateStartupConfigCache } from '../config.js';
import {
  type DbEngine,
} from '../database/engine.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { buildIdentityMemoryDocumentRecord } from '../memory/identity-documents.js';
import { buildDurableCandidateSummaryLines } from '../memory/promotion.js';
import {
  deleteMemorySearchIndexDocuments,
  initializeMemorySearchIndex,
  searchMemorySearchIndex,
  upsertMemorySearchIndexDocuments,
} from '../memory/search-index.js';
import {
  type ConversationIdentityBindingRecord,
  type ContextCompactionRecord,
  type ContextEntryRecord,
  type IdentityAliasRecord,
  type MemoryCompactionLatestSnapshot,
  type MemoryCompactionStatsSnapshot,
  type MemoryCompactionWorkerSnapshot,
  type MemoryDocumentRecord,
  type MemoryDocumentSyncStateRecord,
  type MemoryIdentityStatsSnapshot,
  type MemoryLedgerStatsSnapshot,
  type MemoryPromotionCandidate,
  type MemoryPromotionStatsSnapshot,
  type MemoryPromptStatsSnapshot,
  type MemorySearchGroupQualitySnapshot,
  type MemorySearchSourceQualitySnapshot,
  type MemorySearchScopeQualitySnapshot,
  type MemorySearchStatsSnapshot,
  type NewMessage,
  type PersonProfileRecord,
  type RegisteredGroup,
  type ScheduledTask,
  type TaskRunLog,
  type UserSoulRecord,
  type UserMemoryRecord,
  type UserMemoryObservationRecord,
  type PersonaInsightRecord,
  type MemoryConsolidationLogRecord,
  type MemoryExtractionLogRecord,
  type MemoryEventRecord,
  type MemorySkillRecord,
} from '../types.js';
import { adaptSql } from './sql-adapters.js';
import { dba, eng, getSqliteRawDatabase, isSqlite } from './engine-access.js';
import { createPlaceholders, estimateTokenCount, normalizeMemoryText } from './sql-utils.js';
import { t } from '../i18n/index.js';

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await dba.prepare(
    `
    INSERT INTO scheduled_tasks (id, title, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, retry_limit, retry_backoff_ms, failure_mode, consecutive_failures, last_error, status, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    (task.title || task.prompt || t('tasks.unnamedTask', {}, undefined)).trim().slice(0, 80),
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    Math.max(0, Number(task.retry_limit || 0)),
    Math.max(1000, Number(task.retry_backoff_ms || 300000)),
    task.failure_mode === 'pause' ? 'pause' : 'continue',
    Math.max(0, Number(task.consecutive_failures || 0)),
    task.last_error || null,
    task.status,
    task.created_at,
    task.created_at,
    getCurrentUserId(),
    getCurrentUserId(),
  );
}

export async function getTaskById(id: string): Promise<ScheduledTask | undefined> {
  return await dba.prepare('SELECT * FROM scheduled_tasks WHERE id = ? AND deleted_at IS NULL').get(id) as
    | ScheduledTask
    | undefined;
}

export async function getTasksForGroup(groupFolder: string): Promise<ScheduledTask[]> {
  return await dba
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export async function getTasksForChat(chatJid: string): Promise<ScheduledTask[]> {
  return await dba
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE chat_jid = ? AND deleted_at IS NULL ORDER BY created_at DESC',
    )
    .all(chatJid) as ScheduledTask[];
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  return await dba
    .prepare('SELECT * FROM scheduled_tasks WHERE deleted_at IS NULL ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export interface TaskSnapshot {
  id: string;
  groupFolder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  retry_limit: number;
  retry_backoff_ms: number;
  failure_mode: string;
  status: string;
  next_run: string | null;
}

const TASK_RUNTIME_LEASE_MS = 30 * 60 * 1000;

export async function getTaskSnapshots(groupFolder?: string): Promise<TaskSnapshot[]> {
  const sql = groupFolder
    ? `
      SELECT
        id,
        group_folder AS groupFolder,
        prompt,
        schedule_type,
        schedule_value,
        retry_limit,
        retry_backoff_ms,
        failure_mode,
        status,
        next_run
      FROM scheduled_tasks
      WHERE group_folder = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `
    : `
      SELECT
        id,
        group_folder AS groupFolder,
        prompt,
        schedule_type,
        schedule_value,
        retry_limit,
        retry_backoff_ms,
        failure_mode,
        status,
        next_run
      FROM scheduled_tasks
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
    `;
  return groupFolder
    ? (await dba.prepare(sql).all(groupFolder) as unknown as TaskSnapshot[])
    : (await dba.prepare(sql).all() as unknown as TaskSnapshot[]);
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'title'
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'next_run'
      | 'retry_limit'
      | 'retry_backoff_ms'
      | 'failure_mode'
      | 'consecutive_failures'
      | 'last_error'
      | 'runtime_claimed_at'
      | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.retry_limit !== undefined) {
    fields.push('retry_limit = ?');
    values.push(updates.retry_limit);
  }
  if (updates.retry_backoff_ms !== undefined) {
    fields.push('retry_backoff_ms = ?');
    values.push(updates.retry_backoff_ms);
  }
  if (updates.failure_mode !== undefined) {
    fields.push('failure_mode = ?');
    values.push(updates.failure_mode);
  }
  if (updates.consecutive_failures !== undefined) {
    fields.push('consecutive_failures = ?');
    values.push(updates.consecutive_failures);
  }
  if (updates.last_error !== undefined) {
    fields.push('last_error = ?');
    values.push(updates.last_error);
  }
  if (updates.runtime_claimed_at !== undefined) {
    fields.push('runtime_claimed_at = ?');
    values.push(updates.runtime_claimed_at);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  await dba.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
  ).run(...values);
}

export async function deleteTask(id: string): Promise<void> {
  // Delete child records first (FK constraint)
  await dba.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  const ts = new Date().toISOString();
  await dba
    .prepare(
      'UPDATE scheduled_tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    .run(ts, ts, id);
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const leaseCutoff = new Date(
    Date.now() - TASK_RUNTIME_LEASE_MS,
  ).toISOString();
  return await dba
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active'
      AND deleted_at IS NULL
      AND next_run IS NOT NULL
      AND next_run <= ?
      AND (runtime_claimed_at IS NULL OR runtime_claimed_at <= ?)
    ORDER BY next_run
  `,
    )
    .all(now, leaseCutoff) as ScheduledTask[];
}

export async function claimTaskExecution(
  id: string,
  options?: { requireDue?: boolean; now?: string },
): Promise<boolean> {
  const now = options?.now || new Date().toISOString();
  const leaseCutoff = new Date(
    new Date(now).getTime() - TASK_RUNTIME_LEASE_MS,
  ).toISOString();
  const sql = options?.requireDue
    ? `
      UPDATE scheduled_tasks
      SET runtime_claimed_at = ?
      WHERE id = ?
        AND status = 'active'
        AND deleted_at IS NULL
        AND next_run IS NOT NULL
        AND next_run <= ?
        AND (runtime_claimed_at IS NULL OR runtime_claimed_at <= ?)
    `
    : `
      UPDATE scheduled_tasks
      SET runtime_claimed_at = ?
      WHERE id = ?
        AND status = 'active'
        AND deleted_at IS NULL
        AND (runtime_claimed_at IS NULL OR runtime_claimed_at <= ?)
    `;
  const result = options?.requireDue
    ? await dba.prepare(sql).run(now, id, now, leaseCutoff)
    : await dba.prepare(sql).run(now, id, leaseCutoff);
  return result.changes > 0;
}

export async function updateTaskAfterRun(
  id: string,
  input: {
    nextRun: string | null;
    lastResult: string;
    status?: ScheduledTask['status'];
    consecutiveFailures?: number;
    lastError?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const nextStatus =
    input.status ?? (input.nextRun === null ? 'completed' : undefined);
  updateTask(id, {
    next_run: input.nextRun,
    status: nextStatus,
    consecutive_failures: input.consecutiveFailures,
    last_error: input.lastError,
    runtime_claimed_at: null,
  });
  await dba.prepare(
    `
    UPDATE scheduled_tasks
    SET last_run = ?, last_result = ?
    WHERE id = ? AND deleted_at IS NULL
  `,
  ).run(now, input.lastResult, id);
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await dba.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export async function getLatestTaskRunLogs(): Promise<TaskRunLog[]> {
  return await getLatestTaskRunLogsForTaskIds((await getAllTasks()).map((task) => task.id));
}

export async function getLatestTaskRunLogsForTaskIds(
  taskIds: string[],
): Promise<TaskRunLog[]> {
  if (taskIds.length === 0) return [];
  const placeholders = createPlaceholders(taskIds.length);
  return await dba
    .prepare(
      `
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM (
      SELECT
        task_id,
        run_at,
        duration_ms,
        status,
        result,
        error,
        ROW_NUMBER() OVER (
          PARTITION BY task_id
          ORDER BY run_at DESC, id DESC
        ) AS row_num
      FROM task_run_logs
      WHERE task_id IN (${placeholders})
    )
    WHERE row_num = 1
    ORDER BY run_at DESC
  `,
    )
    .all(...taskIds) as TaskRunLog[];
}
