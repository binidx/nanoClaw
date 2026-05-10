import type { Express, Request } from 'express';

import {
  createTask,
  deleteSession,
  deleteTask,
  getAllSessions,
  getAllTasks,
  getLatestTaskRunLogsForTaskIds,
  getTaskById,
  getTasksForChat,
  updateTask,
  getConversationDisplayNames,
  getRegisteredGroup,
} from '../db.js';
import { logger } from '../logger.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  computeInitialNextRun,
  normalizeScheduleValue,
} from '../scheduler/task-schedule.js';

function paramString(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

export interface TaskSessionRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  refreshTaskSnapshots?: () => void;
  runTaskNow?: (
    taskId: string,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  getTaskRuntimeState?: (taskId: string) => 'queued' | 'running' | null;
  clearCodexConversationState: (folder: string) => void;
  deriveTaskTitle: (title: unknown, prompt: unknown) => string;
  generateAiTaskDraft: (request: string) => Promise<unknown>;
}

export function registerTaskSessionRoutes(
  app: Express,
  opts: TaskSessionRouteOptions,
): void {
  const viewGuard = opts.requirePermission('project.view', 'task.view');
  const manageGuard = opts.requirePermission('project.manage', 'task.edit');

  app.get('/api/sessions', viewGuard, async (_req, res) => {
    try {
      res.json(await getAllSessions());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/sessions/:folder', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'sessions.delete', 'high');
      const folder = paramString(req.params.folder);
      await deleteSession(folder);
      opts.clearCodexConversationState(folder);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/tasks', viewGuard, async (req, res) => {
    try {
      const chatJid =
        typeof req.query.chat_jid === 'string' ? req.query.chat_jid : '';
      const registeredGroup = chatJid ? await getRegisteredGroup(chatJid) : undefined;
      const tasks = chatJid ? await getTasksForChat(chatJid) : await getAllTasks();
      const taskIds = [...new Set(tasks.map((task) => task.id))];
      const chatJids = [...new Set(tasks.map((task) => task.chat_jid))];
      const conversationNames = await getConversationDisplayNames(
        chatJids,
        getTenantUserId(req),
      );
      const latestRunMap = new Map(
        (await getLatestTaskRunLogsForTaskIds(taskIds)).map((log) => [
          log.task_id,
          log,
        ]),
      );
      res.json({
        tasks: tasks.map((task) => ({
          ...task,
          title: opts.deriveTaskTitle(task.title, task.prompt),
          conversation_name: conversationNames[task.chat_jid] || task.chat_jid,
          group_folder_active: registeredGroup
            ? registeredGroup.folder === task.group_folder
            : true,
          latest_run: latestRunMap.get(task.id) || null,
          runtime_status: opts.getTaskRuntimeState?.(task.id) || null,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list tasks');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/tasks', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.create', 'normal');
      const {
        chatJid,
        title,
        prompt,
        scheduleType,
        scheduleValue,
        contextMode,
        retryLimit,
        retryBackoffMs,
        failureMode,
      } = req.body as {
        chatJid?: string;
        title?: string;
        prompt?: string;
        scheduleType?: 'cron' | 'interval' | 'once';
        scheduleValue?: string;
        contextMode?: 'group' | 'isolated';
        retryLimit?: number;
        retryBackoffMs?: number;
        failureMode?: 'continue' | 'pause';
      };
      if (
        !chatJid ||
        !prompt?.trim() ||
        !scheduleType ||
        !scheduleValue?.trim()
      ) {
        res.status(400).json({
          error: 'chatJid, prompt, scheduleType, scheduleValue are required',
        });
        return;
      }
      const group = await getRegisteredGroup(chatJid);
      if (!group) {
        res.status(404).json({ error: 'Conversation group not found' });
        return;
      }
      const normalizedScheduleValue = normalizeScheduleValue(
        scheduleType,
        scheduleValue,
      );
      const nextRun = computeInitialNextRun(
        scheduleType,
        normalizedScheduleValue,
      );
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await createTask({
        id: taskId,
        title: opts.deriveTaskTitle(title, prompt),
        group_folder: group.folder,
        chat_jid: chatJid,
        prompt: prompt.trim(),
        schedule_type: scheduleType,
        schedule_value: normalizedScheduleValue,
        context_mode: contextMode === 'isolated' ? 'isolated' : 'group',
        next_run: nextRun,
        retry_limit: Math.max(0, Number(retryLimit || 0)),
        retry_backoff_ms: Math.max(1000, Number(retryBackoffMs || 300000)),
        failure_mode: failureMode === 'pause' ? 'pause' : 'continue',
        consecutive_failures: 0,
        last_error: null,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      opts.refreshTaskSnapshots?.();
      res.json({
        ok: true,
        taskId,
        nextRun,
        title: opts.deriveTaskTitle(title, prompt),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to create task');
      res
        .status(500)
        .json({ error: 'Internal error' });
    }
  });

  app.post('/api/tasks/ai-draft', manageGuard, async (req, res) => {
    try {
      const { request } = req.body as { request?: string };
      if (!request?.trim()) {
        res.status(400).json({ error: 'request is required' });
        return;
      }
      res.json(await opts.generateAiTaskDraft(request));
    } catch (err) {
      logger.error({ err }, 'Failed to generate AI task draft');
      res
        .status(500)
        .json({ error: 'Internal error' });
    }
  });

  app.patch('/api/tasks/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.update', 'normal');
      const task = await getTaskById(paramString(req.params.id));
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const {
        title,
        prompt,
        scheduleType,
        scheduleValue,
        contextMode,
        retryLimit,
        retryBackoffMs,
        failureMode,
      } = req.body as {
        title?: string;
        prompt?: string;
        scheduleType?: 'cron' | 'interval' | 'once';
        scheduleValue?: string;
        contextMode?: 'group' | 'isolated';
        retryLimit?: number;
        retryBackoffMs?: number;
        failureMode?: 'continue' | 'pause';
      };

      const nextPrompt =
        typeof prompt === 'string' && prompt.trim()
          ? prompt.trim()
          : task.prompt;
      const nextScheduleType = scheduleType || task.schedule_type;
      const nextScheduleValue = scheduleValue?.trim()
        ? normalizeScheduleValue(nextScheduleType, scheduleValue)
        : task.schedule_value;
      const nextContextMode =
        contextMode === 'isolated'
          ? 'isolated'
          : contextMode === 'group'
            ? 'group'
            : task.context_mode;
      const nextTitle = opts.deriveTaskTitle(title, nextPrompt);
      const nextRun = computeInitialNextRun(
        nextScheduleType,
        nextScheduleValue,
      );

      await updateTask(task.id, {
        title: nextTitle,
        prompt: nextPrompt,
        schedule_type: nextScheduleType,
        schedule_value: nextScheduleValue,
        context_mode: nextContextMode,
        next_run: nextRun,
        retry_limit:
          retryLimit === undefined
            ? task.retry_limit
            : Math.max(0, Number(retryLimit || 0)),
        retry_backoff_ms:
          retryBackoffMs === undefined
            ? task.retry_backoff_ms
            : Math.max(1000, Number(retryBackoffMs || 300000)),
        failure_mode:
          failureMode === undefined
            ? task.failure_mode
            : failureMode === 'pause'
              ? 'pause'
              : 'continue',
      });
      opts.refreshTaskSnapshots?.();
      res.json({
        ok: true,
        title: nextTitle,
        prompt: nextPrompt,
        scheduleType: nextScheduleType,
        scheduleValue: nextScheduleValue,
        contextMode: nextContextMode,
        retryLimit:
          retryLimit === undefined
            ? task.retry_limit
            : Math.max(0, Number(retryLimit || 0)),
        retryBackoffMs:
          retryBackoffMs === undefined
            ? task.retry_backoff_ms
            : Math.max(1000, Number(retryBackoffMs || 300000)),
        failureMode:
          failureMode === undefined
            ? task.failure_mode
            : failureMode === 'pause'
              ? 'pause'
              : 'continue',
        nextRun,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update task');
      res
        .status(500)
        .json({ error: 'Internal error' });
    }
  });

  app.post('/api/tasks/:id/run', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.run', 'normal');
      if (!opts.runTaskNow) {
        res
          .status(501)
          .json({ error: 'Manual task execution is not available' });
        return;
      }
      const result = await Promise.resolve(opts.runTaskNow(paramString(req.params.id)));
      if (!result.ok) {
        res
          .status(result.error === 'Task not found' ? 404 : 400)
          .json({ error: result.error || 'Unable to run task' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to run task manually');
      res
        .status(500)
        .json({ error: 'Internal error' });
    }
  });

  app.post('/api/tasks/:id/pause', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.pause', 'normal');
      const task = await getTaskById(paramString(req.params.id));
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      await updateTask(task.id, { status: 'paused' });
      opts.refreshTaskSnapshots?.();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to pause task');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/tasks/:id/resume', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.resume', 'normal');
      const task = await getTaskById(paramString(req.params.id));
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      await updateTask(task.id, { status: 'active' });
      opts.refreshTaskSnapshots?.();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to resume task');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/tasks/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'tasks.delete', 'normal');
      const task = await getTaskById(paramString(req.params.id));
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      await deleteTask(task.id);
      opts.refreshTaskSnapshots?.();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete task');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
