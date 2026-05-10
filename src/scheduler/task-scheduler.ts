import { ChildProcess } from 'child_process';
import fs from 'fs';

import { SCHEDULER_POLL_INTERVAL } from '../config.js';
import {
  AgentRunOutput,
  runAgentProcess,
  writeTasksSnapshot,
} from '../agent/agent-runner.js';
import {
  claimTaskExecution,
  getDueTasks,
  getTaskById,
  getTaskSnapshots,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from '../db.js';
import { GroupQueue } from '../runtime/group-queue.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { getAssistantName } from '../config-store.js';
import { RegisteredGroup, ScheduledTask } from '../types.js';
import { computeInitialNextRun } from './task-schedule.js';
import { createModuleLogger } from '../logger.js';
import { runWithTenant, SYSTEM_USER_ID } from '../tenant/tenant-context.js';

const schedulerLog = createModuleLogger('scheduler');

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    return computeInitialNextRun('cron', task.schedule_value);
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      schedulerLog.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface TaskFailurePlan {
  nextRun: string | null;
  status?: ScheduledTask['status'];
  consecutiveFailures: number;
  lastResult: string;
  lastError: string;
  retryScheduled: boolean;
}

export function computeTaskFailurePlan(
  task: ScheduledTask,
  error: string,
  now = Date.now(),
): TaskFailurePlan {
  const consecutiveFailures =
    Math.max(0, Number(task.consecutive_failures || 0)) + 1;
  const retryLimit = Math.max(0, Number(task.retry_limit || 0));
  const retryBackoffMs = Math.max(
    1000,
    Number(task.retry_backoff_ms || 300000),
  );

  if (consecutiveFailures <= retryLimit) {
    const delayMs = retryBackoffMs * Math.pow(2, consecutiveFailures - 1);
    return {
      nextRun: new Date(now + delayMs).toISOString(),
      consecutiveFailures,
      lastResult: `Error: ${error}`,
      lastError: error,
      retryScheduled: true,
    };
  }

  const nextRegularRun = computeNextRun(task);
  if (task.failure_mode === 'pause') {
    return {
      nextRun: task.schedule_type === 'once' ? null : nextRegularRun,
      status: 'paused',
      consecutiveFailures,
      lastResult: `Error: ${error}`,
      lastError: error,
      retryScheduled: false,
    };
  }

  return {
    nextRun: nextRegularRun,
    status: nextRegularRun === null ? 'completed' : task.status,
    consecutiveFailures,
    lastResult: `Error: ${error}`,
    lastError: error,
    retryScheduled: false,
  };
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    agentLabel: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const scheduledTaskIds = new Set<string>();

function markTaskScheduled(taskId: string): boolean {
  if (scheduledTaskIds.has(taskId)) {
    return false;
  }
  scheduledTaskIds.add(taskId);
  return true;
}

function clearTaskScheduled(taskId: string): void {
  scheduledTaskIds.delete(taskId);
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    await updateTask(task.id, { status: 'paused', runtime_claimed_at: null });
    schedulerLog.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    await logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  schedulerLog.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    const error = `Group not found: ${task.group_folder}`;
    await updateTask(task.id, { status: 'paused', runtime_claimed_at: null });
    schedulerLog.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    await logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }

  // Update tasks snapshot for the agent runtime to read (filtered by group)
  const isMain = group.isMain === true;
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    await getTaskSnapshots(isMain ? undefined : task.group_folder),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the agent promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      schedulerLog.debug({ taskId: task.id }, 'Closing task agent after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runAgentProcess(
      group,
      {
        prompt: { text: task.prompt },
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: await getAssistantName(),
      },
      (proc, agentLabel) =>
        deps.onProcess(task.chat_jid, proc, agentLabel, task.group_folder),
      async (streamedOutput: AgentRunOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    schedulerLog.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    schedulerLog.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  await logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  if (error) {
    const failurePlan = computeTaskFailurePlan(task, error, Date.now());
    await updateTaskAfterRun(task.id, {
      nextRun: failurePlan.nextRun,
      lastResult: failurePlan.lastResult,
      status: failurePlan.status,
      consecutiveFailures: failurePlan.consecutiveFailures,
      lastError: failurePlan.lastError,
    });
    schedulerLog.warn(
      {
        taskId: task.id,
        retryScheduled: failurePlan.retryScheduled,
        nextRun: failurePlan.nextRun,
        status: failurePlan.status,
        consecutiveFailures: failurePlan.consecutiveFailures,
      },
      'Task run failed',
    );
    return;
  }

  const nextRun = computeNextRun(task);
  const resultSummary = result ? result.slice(0, 200) : 'Completed';
  await updateTaskAfterRun(task.id, {
    nextRun,
    lastResult: resultSummary,
    status: nextRun === null ? 'completed' : task.status,
    consecutiveFailures: 0,
    lastError: null,
  });
}

export async function enqueueTaskRun(
  taskId: string,
  deps: SchedulerDependencies,
): Promise<{ ok: boolean; error?: string | undefined; }> {
  const currentTask = await getTaskById(taskId);
  if (!currentTask) {
    return { ok: false, error: 'Task not found' };
  }
  if (currentTask.status !== 'active') {
    return { ok: false, error: 'Task is not active' };
  }
  if (!markTaskScheduled(currentTask.id)) {
    return { ok: false, error: 'Task is already queued or running' };
  }
  if (!await claimTaskExecution(currentTask.id)) {
    clearTaskScheduled(currentTask.id);
    return { ok: false, error: 'Task is already claimed for execution' };
  }

  try {
    deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, async () => {
      try {
        await runWithTenant(
          { userId: currentTask.created_by || SYSTEM_USER_ID },
          () => runTask(currentTask, deps),
        );
      } finally {
        clearTaskScheduled(currentTask.id);
      }
    });
  } catch (err) {
    clearTaskScheduled(currentTask.id);
    throw err;
  }
  return { ok: true };
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    schedulerLog.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  schedulerLog.debug('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = await getDueTasks();
      if (dueTasks.length > 0) {
        schedulerLog.info(
          { count: dueTasks.length, taskIds: dueTasks.map((t) => t.id) },
          'Found due tasks',
        );
      }

      for (const task of dueTasks) {
        if (!markTaskScheduled(task.id)) {
          schedulerLog.debug(
            { taskId: task.id },
            'Skipping due task because it is already queued or running',
          );
          continue;
        }
        if (!await claimTaskExecution(task.id, { requireDue: true })) {
          clearTaskScheduled(task.id);
          schedulerLog.debug(
            { taskId: task.id },
            'Skipping due task because it is already claimed',
          );
          continue;
        }

        try {
          deps.queue.enqueueTask(
            task.chat_jid,
            task.id,
            async () => {
              try {
                await runWithTenant(
                  { userId: task.created_by || SYSTEM_USER_ID },
                  () => runTask(task, deps),
                );
              } finally {
                clearTaskScheduled(task.id);
              }
            },
          );
        } catch (err) {
          clearTaskScheduled(task.id);
          throw err;
        }
      }
    } catch (err) {
      schedulerLog.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  scheduledTaskIds.clear();
}
