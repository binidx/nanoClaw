import crypto from 'crypto';
import { createModuleLogger } from '../logger.js';
import * as db from '../db/workteam.js';
import {
  buildTaskGraph,
  getReadyTasks,
  getSchedulingOrder,
  topologicalSort,
} from './workflow-engine.js';
import { WorkteamEventBus } from './event-bus.js';
import {
  TaskTimeoutMonitor,
  AgentHeartbeatMonitor,
} from './anti-starvation.js';
import {
  executeAgentTask,
  aggregateTaskOutputs,
  type AgentExecutionResult,
} from './agent-adapter.js';
import { parseEvalConfig, evaluateTaskOutput } from './evaluation-engine.js';
import { validateTeamConfig } from './workteam-manager.js';
import {
  findProfileById,
  formatMissingToolsError,
  validateProfileTools,
  type RunnerProfile,
} from './runner-profiles.js';
import type {
  WorkteamRunRecord,
  RunStatus,
  ProcessType,
  WorkteamTaskRecord,
  WorkteamAgentRecord,
  TaskGraph,
} from './types.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('workteam');

interface WorkflowConfig {
  heartbeat_interval_ms?: number;
  heartbeat_max_missed?: number;
  max_parallel_tasks?: number;
}

function parseWorkflowConfig(raw: string): WorkflowConfig {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return v as WorkflowConfig;
  } catch {
    return {};
  }
}

interface ApprovalConfig {
  required: boolean;
  prompt: string;
}

function parseApprovalConfig(evalConfigRaw: string): ApprovalConfig | null {
  if (!evalConfigRaw?.trim()) return null;
  try {
    const v = JSON.parse(evalConfigRaw) as Record<string, unknown>;
    const approval = v.approval as Record<string, unknown> | undefined;
    if (!approval || approval.required !== true) return null;
    return {
      required: true,
      prompt:
        typeof approval.prompt === 'string'
          ? approval.prompt
          : t('workteam.auto_4c4ae6', {}, undefined),
    };
  } catch {
    return null;
  }
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_MAX_MISSED = 3;
const DEFAULT_HIERARCHICAL_CONCURRENCY = 3;
const AGENT_MESSAGE_MAX_CHARS = 2000;

const activeOrchestrators = new Map<string, WorkteamOrchestrator>();

export function getOrchestrator(
  runId: string,
): WorkteamOrchestrator | undefined {
  return activeOrchestrators.get(runId);
}

export function removeOrchestrator(runId: string): void {
  activeOrchestrators.delete(runId);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class WorkteamOrchestrator {
  private readonly teamId: string;
  private readonly eventBus: WorkteamEventBus;
  private readonly timeoutMonitor = new TaskTimeoutMonitor();
  private readonly heartbeatMonitor = new AgentHeartbeatMonitor();

  private runId: string | undefined;
  private traceId: string | undefined;
  private taskGraph: TaskGraph | undefined;
  private runStatus: RunStatus | null = null;
  private processType: ProcessType = 'dag';

  private readonly completedOutputs = new Map<
    string,
    { taskName: string; output: string }
  >();
  private tasksById = new Map<string, WorkteamTaskRecord>();
  private agentsById = new Map<string, WorkteamAgentRecord>();
  private readonly runningRunTaskIds = new Set<string>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private workflowConfig: WorkflowConfig = {};
  private repositoryContext: string = '';
  private runnerProfile: RunnerProfile | undefined;

  private scheduleTail: Promise<void> = Promise.resolve();

  constructor(teamId: string) {
    this.teamId = teamId;
    this.eventBus = WorkteamEventBus.getInstance();
  }

  private emitEvent(
    event: Parameters<WorkteamEventBus['emit']>[1],
    payload: Record<string, unknown>,
  ): void {
    if (!this.runId) return;
    this.eventBus.emit(this.runId, event, {
      ...payload,
      traceId: this.traceId,
    });
  }

  async startRun(input: string): Promise<WorkteamRunRecord> {
    if (this.runId) {
      const prev = await db.getWorkteamRun(this.runId);
      if (prev && (prev.status === 'running' || prev.status === 'paused')) {
        throw new Error(
          `Workteam orchestrator already has an active run: ${this.runId}`,
        );
      }
      activeOrchestrators.delete(this.runId);
    }

    const snapshot = await db.getWorkteamSnapshot(this.teamId);
    if (!snapshot) {
      throw new Error(`Workteam not found: ${this.teamId}`);
    }
    const { valid, errors } = await validateTeamConfig(this.teamId);
    if (!valid) {
      throw new Error(errors.join('; ') || 'Invalid team configuration');
    }

    // Fail fast if the bound runner profile's required tools are missing.
    // Runs never enter the DB in `running` state on toolchain mismatch; the
    // caller sees a clear error instead.
    if (this.runnerProfile) {
      const check = validateProfileTools(this.runnerProfile);
      if (!check.ok) {
        throw new Error(
          formatMissingToolsError(this.runnerProfile, check.missing),
        );
      }
    }

    const run = await db.createWorkteamRun(this.teamId, input);
    this.runId = run.id;
    this.traceId = crypto.randomUUID();
    activeOrchestrators.set(run.id, this);

    this.completedOutputs.clear();
    this.tasksById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    this.agentsById = new Map(snapshot.agents.map((a) => [a.id, a]));
    this.taskGraph = buildTaskGraph(snapshot.tasks);
    this.processType = snapshot.team.process_type;
    this.workflowConfig = parseWorkflowConfig(snapshot.team.workflow_config);
    this.runStatus = 'running';

    try {
      for (const t of snapshot.tasks) {
        await db.createWorkteamRunTask(run.id, t.id, t.agent_id);
      }
    } catch (err) {
      activeOrchestrators.delete(run.id);
      this.runId = undefined;
      this.runStatus = null;
      await db
        .updateWorkteamRun(run.id, {
          status: 'failed',
          output: 'Failed to create run tasks',
          completed_at: nowIso(),
        })
        .catch(() => {});
      throw err;
    }

    const startedAt = nowIso();
    await db.updateWorkteamRun(run.id, {
      status: 'running',
      started_at: startedAt,
    });

    try {
      const layers = getSchedulingOrder(snapshot.tasks, this.processType);
      logger.debug(
        { runId: run.id, teamId: this.teamId, layers },
        'workteam startRun scheduling order',
      );
    } catch (err) {
      logger.warn(
        { err, runId: run.id },
        'workteam startRun: getSchedulingOrder skipped',
      );
    }

    this.startHeartbeat();

    const record = (await db.getWorkteamRun(run.id)) ?? {
      ...run,
      status: 'running' as const,
      started_at: startedAt,
    };
    this.enqueueSchedule();
    return record;
  }

  private enqueueSchedule(): void {
    this.scheduleTail = this.scheduleTail
      .then(() => this.runScheduleNextBatch())
      .catch((err) => {
        logger.error(
          { err, runId: this.runId, teamId: this.teamId },
          'workteam schedule chain error',
        );
        try {
          this.emitEvent('task_failed', {
            phase: 'schedule',
            message: String(err),
          });
        } catch (e) {
          logger.warn(
            { err: e },
            'workteam failed to emit schedule error event',
          );
        }
      });
  }

  private async runScheduleNextBatch(): Promise<void> {
    if (!this.runId || !this.taskGraph || this.runStatus !== 'running') {
      return;
    }
    const runId = this.runId;
    const graph = this.taskGraph;

    const runTasks = await db.getWorkteamRunTasks(runId);
    const successCompleted = new Set(this.completedOutputs.keys());
    const readyTaskIds = getReadyTasks(graph, successCompleted);

    const pendingReady = readyTaskIds.filter((tid) => {
      const rt = runTasks.find((r) => r.task_id === tid);
      return rt?.status === 'pending';
    });

    const allTerminal = runTasks.every(
      (rt) =>
        rt.status === 'completed' ||
        rt.status === 'failed' ||
        rt.status === 'skipped',
    );
    const hasWaitingApproval = runTasks.some(
      (rt) => rt.status === 'waiting_approval',
    );

    if (
      this.runningRunTaskIds.size > 0 &&
      pendingReady.length === 0 &&
      !allTerminal
    ) {
      return;
    }

    if (pendingReady.length > 0) {
      const maxConcurrent = this.getMaxConcurrent();
      const available = Math.max(
        0,
        maxConcurrent - this.runningRunTaskIds.size,
      );
      const toStart = pendingReady.slice(0, available);

      for (const taskId of toStart) {
        const rt = runTasks.find((r) => r.task_id === taskId);
        if (!rt || rt.status !== 'pending') continue;
        void this.executeTask(rt.id, taskId).catch((err) => {
          logger.error(
            { err, runId, taskId, runTaskId: rt.id },
            'workteam executeTask outer error',
          );
        });
      }
      return;
    }

    if (allTerminal) {
      await this.finalizeRun();
      return;
    }

    if (hasWaitingApproval) {
      return;
    }

    if (this.runningRunTaskIds.size === 0) {
      await this.failRunBlocked(
        'No runnable tasks remaining (deadlock or blocked by failures)',
      );
    }
  }

  private emitDownstreamHandoff(
    taskId: string,
    agentId: string,
    output: string,
  ): void {
    if (!this.taskGraph) return;
    const downstream = this.taskGraph.adjacency.get(taskId) ?? [];
    const agent = this.agentsById.get(agentId);
    const truncated =
      output.length > AGENT_MESSAGE_MAX_CHARS
        ? output.slice(0, AGENT_MESSAGE_MAX_CHARS)
        : output;
    for (const depTaskId of downstream) {
      const depTask = this.tasksById.get(depTaskId);
      const depAgentId = depTask?.agent_id ?? '';
      if (depAgentId && depAgentId !== agentId) {
        this.emitEvent('agent_message', {
          taskId,
          fromRole: agent?.role ?? '',
          content: truncated,
          agentId,
          targetAgentId: depAgentId,
        });
      }
    }
  }

  private getMaxConcurrent(): number {
    if (this.processType === 'sequential') return 1;
    const configured = this.workflowConfig.max_parallel_tasks;
    const fallback =
      this.processType === 'hierarchical'
        ? DEFAULT_HIERARCHICAL_CONCURRENCY
        : Infinity;
    const value = configured ?? fallback;
    return Math.max(1, value);
  }

  private async executeTask(runTaskId: string, taskId: string): Promise<void> {
    if (!this.runId) return;
    const runId = this.runId;
    const task = this.tasksById.get(taskId);
    const agent = task ? this.agentsById.get(task.agent_id) : undefined;
    if (!task || !agent) {
      logger.error(
        { runId, taskId },
        'workteam executeTask: missing task or agent',
      );
      await db.updateWorkteamRunTask(runTaskId, {
        status: 'failed',
        error: 'Missing task or agent configuration',
        completed_at: nowIso(),
      });
      this.emitEvent('task_failed', {
        taskId,
        runTaskId,
        reason: 'missing_config',
      });
      this.enqueueSchedule();
      return;
    }

    this.runningRunTaskIds.add(runTaskId);
    const abortCtrl = new AbortController();
    this.taskAbortControllers.set(runTaskId, abortCtrl);
    let settled = false;

    try {
      await db.updateWorkteamRunTask(runTaskId, {
        status: 'running',
        started_at: nowIso(),
      });
      this.emitEvent('task_started', { taskId, runTaskId, agentId: agent.id });

      this.heartbeatMonitor.recordHeartbeat(agent.id);

      this.timeoutMonitor.startTimer(taskId, task.timeout_ms, () => {
        if (settled) return;
        abortCtrl.abort();
        settled = true;
        this.timeoutMonitor.clearTimer(taskId);
        this.runningRunTaskIds.delete(runTaskId);
        this.taskAbortControllers.delete(runTaskId);
        const errMsg = `Task timed out after ${task.timeout_ms}ms`;
        logger.warn({ runId, taskId, runTaskId }, errMsg);
        db.updateWorkteamRunTask(runTaskId, {
          status: 'failed',
          error: errMsg,
          completed_at: nowIso(),
        }).catch((e) =>
          logger.warn(
            { err: e, runTaskId },
            'workteam timeout: failed to persist',
          ),
        );
        this.emitEvent('task_failed', { taskId, runTaskId, reason: 'timeout' });
        this.enqueueSchedule();
      });

      const context = await this.buildContextForTask(taskId);
      let result: AgentExecutionResult;
      try {
        result = await executeAgentTask(
          agent,
          task,
          context,
          abortCtrl.signal,
          this.runnerProfile,
        );
      } catch (err) {
        result = {
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      this.timeoutMonitor.clearTimer(taskId);
      if (settled) return;
      settled = true;
      this.runningRunTaskIds.delete(runTaskId);
      this.taskAbortControllers.delete(runTaskId);

      if (this.runStatus === 'cancelled') return;

      if (result.error === 'Task cancelled') {
        if (this.runStatus === 'paused') {
          return;
        }
        const rows = await db.getWorkteamRunTasks(runId);
        const current = rows.find((r) => r.id === runTaskId);
        if (
          current &&
          current.status !== 'skipped' &&
          current.status !== 'completed' &&
          current.status !== 'pending'
        ) {
          await db.updateWorkteamRunTask(runTaskId, {
            status: 'skipped',
            completed_at: nowIso(),
          });
          this.emitEvent('task_skipped', { taskId, runTaskId });
        }
        this.enqueueSchedule();
        return;
      }

      if (result.success) {
        const evalCfg = parseEvalConfig(task.eval_config);
        if (evalCfg) {
          const rtRow = (await db.getWorkteamRunTasks(runId)).find(
            (r) => r.id === runTaskId,
          );
          const prevError = rtRow?.error ?? '';
          const evalAttemptMatch = prevError.match(/^\[eval:(\d+)]/);
          const evalRetries = evalAttemptMatch
            ? parseInt(evalAttemptMatch[1], 10)
            : 0;
          const maxEvalRetries = evalCfg.eval_max_retries ?? 2;

          const evalResult = await evaluateTaskOutput(
            task.name,
            task.description,
            task.expected_output,
            result.output,
            evalCfg.criteria,
            evalCfg.required_patterns,
          );

          if (!evalResult.pass && evalRetries < maxEvalRetries) {
            await db.updateWorkteamRunTask(runTaskId, {
              status: 'pending',
              error: `[eval:${evalRetries + 1}] Evaluation failed: ${evalResult.feedback}`,
              started_at: '',
              completed_at: '',
            });
            this.emitEvent('task_failed', {
              taskId,
              runTaskId,
              reason: 'evaluation',
              retriable: true,
              retryCount: evalRetries + 1,
              feedback: evalResult.feedback,
              score: evalResult.score,
            });
            logger.info(
              { runId, taskId, evalScore: evalResult.score },
              'workteam eval: quality retry',
            );
            this.enqueueSchedule();
            return;
          }

          if (!evalResult.pass) {
            await db.updateWorkteamRunTask(runTaskId, {
              status: 'failed',
              output: result.output,
              error: `Evaluation failed after ${maxEvalRetries} retries: ${evalResult.feedback}`,
              completed_at: nowIso(),
            });
            this.emitEvent('task_failed', {
              taskId,
              runTaskId,
              reason: 'evaluation',
              retriable: false,
              feedback: evalResult.feedback,
              score: evalResult.score,
            });
            this.enqueueSchedule();
            return;
          }
        }

        const approvalConfig = parseApprovalConfig(task.eval_config);
        if (approvalConfig) {
          await db.updateWorkteamRunTask(runTaskId, {
            status: 'waiting_approval',
            output: result.output,
            error: '',
          });
          this.emitEvent('user_intervention', {
            taskId,
            runTaskId,
            agentId: agent.id,
            prompt: approvalConfig.prompt,
            output_summary:
              result.output.length > 500
                ? result.output.slice(0, 500) + '...'
                : result.output,
          });
          this.emitEvent('changelog', {
            action: 'waiting_approval',
            taskName: task.name,
            agentRole: agent.role,
            duration_ms: result.execution_ms,
          });
          return;
        }

        await db.updateWorkteamRunTask(runTaskId, {
          status: 'completed',
          output: result.output,
          error: '',
          completed_at: nowIso(),
        });
        this.completedOutputs.set(taskId, {
          taskName: task.name,
          output: result.output,
        });
        void this.writeCheckpoint();
        this.emitEvent('task_completed', {
          taskId,
          runTaskId,
          agentId: agent.id,
          execution_ms: result.execution_ms,
          poll_count: result.poll_count,
        });
        this.emitEvent('changelog', {
          action: 'task_completed',
          taskName: task.name,
          agentRole: agent.role,
          duration_ms: result.execution_ms,
          summary: result.output.slice(0, 200),
        });

        this.emitDownstreamHandoff(taskId, agent.id, result.output);

        this.enqueueSchedule();
        return;
      }

      const rtRow = (await db.getWorkteamRunTasks(runId)).find(
        (r) => r.id === runTaskId,
      );
      const retries = rtRow?.retry_count ?? 0;
      if (retries < task.retry_limit) {
        await db.updateWorkteamRunTask(runTaskId, {
          status: 'pending',
          retry_count: retries + 1,
          error: result.error ?? 'Unknown error',
          started_at: '',
          completed_at: '',
        });
        logger.info(
          { runId, taskId, runTaskId, retry: retries + 1 },
          'workteam task retry scheduled',
        );
        this.emitEvent('task_failed', {
          taskId,
          runTaskId,
          retriable: true,
          retryCount: retries + 1,
          message: result.error,
        });
        this.enqueueSchedule();
        return;
      }

      await db.updateWorkteamRunTask(runTaskId, {
        status: 'failed',
        error: result.error ?? 'Unknown error',
        completed_at: nowIso(),
      });
      this.emitEvent('task_failed', {
        taskId,
        runTaskId,
        retriable: false,
        message: result.error,
      });
      this.enqueueSchedule();
    } catch (err) {
      if (!settled) {
        settled = true;
        this.timeoutMonitor.clearTimer(taskId);
        this.runningRunTaskIds.delete(runTaskId);
        this.taskAbortControllers.delete(runTaskId);
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, runId, taskId, runTaskId },
          'workteam executeTask failed',
        );
        try {
          await db.updateWorkteamRunTask(runTaskId, {
            status: 'failed',
            error: msg,
            completed_at: nowIso(),
          });
        } catch (e) {
          logger.warn(
            { err: e },
            'workteam failed to persist run task failure',
          );
        }
        this.emitEvent('task_failed', { taskId, runTaskId, message: msg });
        this.enqueueSchedule();
      }
    }
  }

  private async buildContextForTask(taskId: string): Promise<string> {
    if (!this.taskGraph) return '';
    const deps = this.taskGraph.reverseAdjacency.get(taskId) ?? [];
    const items: Array<{ taskName: string; output: string }> = [];
    for (const depId of deps) {
      const out = this.completedOutputs.get(depId);
      if (out) items.push(out);
    }

    if (this.runId) {
      const task = this.tasksById.get(taskId);
      const agentId = task?.agent_id ?? '';
      if (agentId) {
        try {
          const msgs = await db.getAgentMessages(this.runId, agentId);
          for (const m of msgs) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(m.payload || '{}') as Record<string, unknown>;
            } catch {
              /* skip */
            }
            const content =
              typeof parsed.content === 'string' ? parsed.content : '';
            const fromRole =
              typeof parsed.fromRole === 'string'
                ? parsed.fromRole
                : m.source_agent_id;
            if (content) {
              items.push({
                taskName: `Message from ${fromRole}`,
                output: content,
              });
            }
          }
        } catch (err) {
          logger.warn(
            { err, runId: this.runId, taskId },
            'workteam: failed to load agent messages',
          );
        }
      }

      const runTasks = await db.getWorkteamRunTasks(this.runId);
      const rt = runTasks.find((r) => r.task_id === taskId);
      if (rt && rt.error) {
        const feedbackText = rt.error.replace(/^\[eval:\d+]\s*/, '');
        if (feedbackText) {
          items.push({
            taskName: 'Previous attempt feedback',
            output: feedbackText,
          });
        }
      }
    }

    if (this.repositoryContext) {
      items.push({
        taskName: 'Repository Context',
        output: this.repositoryContext,
      });
    }

    return aggregateTaskOutputs(items);
  }

  setRepositoryContext(context: string): void {
    this.repositoryContext = context;
  }

  /**
   * Bind a Runner Profile to this orchestrator before `startRun`. The profile's
   * required tools are validated at `startRun`; its env is injected into each
   * Agent spawn during `executeAgentTask`.
   */
  setRunnerProfile(profile: RunnerProfile | undefined): void {
    this.runnerProfile = profile;
  }

  async pauseRun(): Promise<void> {
    if (!this.runId) return;
    this.runStatus = 'paused';
    this.timeoutMonitor.clearAll();
    this.heartbeatMonitor.stopMonitoring();

    for (const [rtId, ctrl] of this.taskAbortControllers) {
      ctrl.abort();
      try {
        await db.updateWorkteamRunTask(rtId, {
          status: 'pending',
          started_at: '',
          completed_at: '',
        });
      } catch (e) {
        logger.warn(
          { err: e, runTaskId: rtId },
          'workteam pauseRun: failed to reset task',
        );
      }
    }
    this.taskAbortControllers.clear();
    this.runningRunTaskIds.clear();

    await db.updateWorkteamRun(this.runId, { status: 'paused' });
    this.emitEvent('run_paused', { teamId: this.teamId });
  }

  async resumeRun(): Promise<void> {
    if (!this.runId) return;
    this.runStatus = 'running';
    await db.updateWorkteamRun(this.runId, { status: 'running' });
    this.startHeartbeat();
    this.emitEvent('run_resumed', { teamId: this.teamId });
    this.enqueueSchedule();
  }

  private startHeartbeat(): void {
    const hbInterval =
      this.workflowConfig.heartbeat_interval_ms ??
      DEFAULT_HEARTBEAT_INTERVAL_MS;
    const hbMaxMissed =
      this.workflowConfig.heartbeat_max_missed ?? DEFAULT_HEARTBEAT_MAX_MISSED;
    this.heartbeatMonitor.startMonitoring(
      hbInterval,
      hbMaxMissed,
      (agentId) => {
        try {
          logger.warn(
            { agentId, runId: this.runId },
            'workteam agent heartbeat missed threshold',
          );
          this.emitEvent('heartbeat', { agentId, hung: true });
        } catch (e) {
          logger.warn(
            { err: e, agentId },
            'workteam heartbeat onHung handler failed',
          );
        }
      },
    );
  }

  async cancelRun(): Promise<void> {
    if (!this.runId) return;
    const runId = this.runId;
    this.runStatus = 'cancelled';
    this.timeoutMonitor.clearAll();
    for (const ctrl of this.taskAbortControllers.values()) ctrl.abort();
    this.taskAbortControllers.clear();
    this.heartbeatMonitor.stopMonitoring();

    const runTasks = await db.getWorkteamRunTasks(runId);
    for (const rt of runTasks) {
      if (
        ['pending', 'ready', 'waiting_approval', 'running'].includes(rt.status)
      ) {
        await db.updateWorkteamRunTask(rt.id, {
          status: 'skipped',
          completed_at: nowIso(),
        });
      }
    }

    await db.updateWorkteamRun(runId, {
      status: 'cancelled',
      completed_at: nowIso(),
    });
    this.emitEvent('run_cancelled', { teamId: this.teamId });
    removeOrchestrator(runId);
    this.eventBus.removeAllForRun(runId);
  }

  async reassignTask(runTaskId: string, newAgentId: string): Promise<void> {
    if (!this.runId) {
      throw new Error('No active run on this orchestrator');
    }
    const runTasks = await db.getWorkteamRunTasks(this.runId);
    const rt = runTasks.find((r) => r.id === runTaskId);
    if (!rt || rt.run_id !== this.runId) {
      throw new Error(`Run task not found for this run: ${runTaskId}`);
    }
    await db.updateWorkteamRunTask(runTaskId, { agent_id: newAgentId });
  }

  async skipTask(runTaskId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const ctrl = this.taskAbortControllers.get(runTaskId);
    if (ctrl) ctrl.abort();

    const runTasks = await db.getWorkteamRunTasks(this.runId);
    const rt = runTasks.find((r) => r.id === runTaskId);
    if (!rt) throw new Error('Run task not found');
    if (rt.status === 'completed' || rt.status === 'skipped') return;

    await db.updateWorkteamRunTask(runTaskId, {
      status: 'skipped',
      completed_at: nowIso(),
    });
    const taskDef = rt.task_id ? this.tasksById.get(rt.task_id) : undefined;
    if (taskDef) {
      this.completedOutputs.set(taskDef.id, {
        taskName: taskDef.name,
        output: '[skipped]',
      });
      void this.writeCheckpoint();
    }
    this.emitEvent('task_skipped', { taskId: rt.task_id ?? '', runTaskId });
    this.enqueueSchedule();
  }

  async retryTask(runTaskId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');

    const runTasks = await db.getWorkteamRunTasks(this.runId);
    const rt = runTasks.find((r) => r.id === runTaskId);
    if (!rt) throw new Error('Run task not found');
    if (rt.status !== 'failed')
      throw new Error('Only failed tasks can be retried');

    await db.updateWorkteamRunTask(runTaskId, {
      status: 'pending',
      retry_count: 0,
      error: '',
      started_at: '',
      completed_at: '',
    });
    this.enqueueSchedule();
  }

  async approveTask(runTaskId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');

    const runTasks = await db.getWorkteamRunTasks(this.runId);
    const rt = runTasks.find((r) => r.id === runTaskId);
    if (!rt) throw new Error('Run task not found');
    if (rt.status !== 'waiting_approval')
      throw new Error('Task is not waiting for approval');

    const task = this.tasksById.get(rt.task_id);
    await db.updateWorkteamRunTask(runTaskId, {
      status: 'completed',
      completed_at: nowIso(),
    });
    this.completedOutputs.set(rt.task_id, {
      taskName: task?.name ?? rt.task_id,
      output: rt.output,
    });
    void this.writeCheckpoint();
    this.emitEvent('task_completed', {
      taskId: rt.task_id,
      runTaskId,
      agentId: rt.agent_id,
      approved: true,
    });
    this.emitEvent('changelog', {
      action: 'approval_granted',
      taskName: task?.name ?? rt.task_id,
      agentRole: this.agentsById.get(rt.agent_id)?.role ?? 'unknown',
    });

    this.emitDownstreamHandoff(rt.task_id, rt.agent_id, rt.output ?? '');

    this.enqueueSchedule();
  }

  async rejectTask(runTaskId: string, reason?: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');

    const runTasks = await db.getWorkteamRunTasks(this.runId);
    const rt = runTasks.find((r) => r.id === runTaskId);
    if (!rt) throw new Error('Run task not found');
    if (rt.status !== 'waiting_approval')
      throw new Error('Task is not waiting for approval');

    await db.updateWorkteamRunTask(runTaskId, {
      status: 'pending',
      error: reason || 'Rejected by user',
      started_at: '',
      completed_at: '',
    });
    this.emitEvent('task_failed', {
      taskId: rt.task_id,
      runTaskId,
      reason: 'rejected',
      feedback: reason,
    });
    this.enqueueSchedule();
  }

  private async finalizeRun(): Promise<void> {
    if (!this.runId || !this.taskGraph) return;
    const runId = this.runId;
    this.timeoutMonitor.clearAll();
    this.heartbeatMonitor.stopMonitoring();

    const runTasks = await db.getWorkteamRunTasks(runId);
    const anyFailed = runTasks.some((r) => r.status === 'failed');
    const order = topologicalSort(this.taskGraph);
    const items: Array<{ taskName: string; output: string }> = [];
    for (const id of order) {
      const out = this.completedOutputs.get(id);
      if (out) items.push(out);
    }
    const aggregated = aggregateTaskOutputs(items);

    this.runStatus = anyFailed ? 'failed' : 'completed';

    const status = anyFailed ? 'failed' : 'completed';
    await db.updateWorkteamRun(runId, {
      status,
      output: aggregated,
      completed_at: nowIso(),
    });
    const completedCount = runTasks.filter(
      (r) => r.status === 'completed',
    ).length;
    const failedCount = runTasks.filter((r) => r.status === 'failed').length;
    const skippedCount = runTasks.filter((r) => r.status === 'skipped').length;
    this.emitEvent('changelog', {
      action: 'run_finalized',
      status,
      total: runTasks.length,
      completed: completedCount,
      failed: failedCount,
      skipped: skippedCount,
    });

    removeOrchestrator(runId);
    this.eventBus.removeAllForRun(runId);
    logger.info(
      { runId, teamId: this.teamId, status },
      'workteam run finalized',
    );
  }

  private async writeCheckpoint(): Promise<void> {
    if (!this.runId) return;
    try {
      const entries: Array<[string, { taskName: string; output: string }]> = [];
      for (const [k, v] of this.completedOutputs) entries.push([k, v]);
      const json = JSON.stringify({
        completedOutputs: entries,
        processType: this.processType,
        workflowConfig: this.workflowConfig,
        repositoryContext: this.repositoryContext || undefined,
        runnerProfileId: this.runnerProfile?.id,
      });
      await db.updateWorkteamRun(this.runId, { checkpoint: json });
    } catch (err) {
      logger.warn(
        { err, runId: this.runId },
        'workteam checkpoint write failed',
      );
    }
  }

  private async failRunBlocked(message: string): Promise<void> {
    if (!this.runId) return;
    const runId = this.runId;
    this.runStatus = 'failed';
    this.timeoutMonitor.clearAll();
    this.heartbeatMonitor.stopMonitoring();
    logger.error(
      { runId, teamId: this.teamId, message },
      'workteam run blocked',
    );
    await db.updateWorkteamRun(runId, {
      status: 'failed',
      output: message,
      completed_at: nowIso(),
    });
    this.emitEvent('task_failed', { phase: 'run', reason: 'blocked', message });
    removeOrchestrator(runId);
    this.eventBus.removeAllForRun(runId);
  }

  static async restoreFromRun(
    run: WorkteamRunRecord,
    snapshot: Awaited<ReturnType<typeof db.getWorkteamSnapshot>>,
  ): Promise<WorkteamOrchestrator | null> {
    if (!snapshot) return null;

    const runTasks = await db.getWorkteamRunTasks(run.id);
    for (const rt of runTasks) {
      if (rt.status === 'running') {
        await db.updateWorkteamRunTask(rt.id, {
          status: 'failed',
          error: 'Server restarted during execution',
          completed_at: nowIso(),
        });
      }
    }

    const orch = new WorkteamOrchestrator(snapshot.team.id);
    orch.runId = run.id;
    orch.traceId = crypto.randomUUID();
    orch.tasksById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    orch.agentsById = new Map(snapshot.agents.map((a) => [a.id, a]));
    orch.taskGraph = buildTaskGraph(snapshot.tasks);
    orch.processType = snapshot.team.process_type;
    orch.workflowConfig = parseWorkflowConfig(snapshot.team.workflow_config);

    const cp = parseCheckpoint(run.checkpoint);
    if (cp?.completedOutputs && Array.isArray(cp.completedOutputs)) {
      for (const entry of cp.completedOutputs) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [k, v] = entry as [unknown, unknown];
        if (typeof k !== 'string' || !v || typeof v !== 'object') continue;
        const rec = v as Record<string, unknown>;
        if (typeof rec.taskName !== 'string' || typeof rec.output !== 'string')
          continue;
        orch.completedOutputs.set(k, {
          taskName: rec.taskName,
          output: rec.output,
        });
      }
    } else {
      const freshRunTasks = await db.getWorkteamRunTasks(run.id);
      for (const rt of freshRunTasks) {
        if (rt.status === 'completed' && rt.output) {
          const taskDef = orch.tasksById.get(rt.task_id);
          if (taskDef) {
            orch.completedOutputs.set(rt.task_id, {
              taskName: taskDef.name,
              output: rt.output,
            });
          }
        }
      }
    }

    if (cp?.repositoryContext) {
      orch.repositoryContext = cp.repositoryContext;
    }
    if (cp?.runnerProfileId) {
      orch.runnerProfile = findProfileById(cp.runnerProfileId);
    }

    activeOrchestrators.set(run.id, orch);

    if (run.status === 'running') {
      orch.runStatus = 'running';
      orch.startHeartbeat();
      orch.enqueueSchedule();
    } else {
      orch.runStatus = 'paused';
    }

    return orch;
  }
}

interface CheckpointData {
  completedOutputs?: Array<[string, { taskName: string; output: string }]>;
  processType?: ProcessType;
  workflowConfig?: WorkflowConfig;
  repositoryContext?: string;
  runnerProfileId?: string;
}

function parseCheckpoint(raw: string): CheckpointData | null {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return v as CheckpointData;
  } catch {
    return null;
  }
}

export async function recoverActiveRuns(): Promise<number> {
  const activeRuns = await db.listActiveRuns();
  if (!activeRuns.length) return 0;

  let recovered = 0;
  for (const run of activeRuns) {
    if (activeOrchestrators.has(run.id)) continue;
    try {
      const snapshot = await db.getWorkteamSnapshot(run.team_id);
      if (!snapshot) {
        logger.warn(
          { runId: run.id, teamId: run.team_id },
          'workteam recovery: team snapshot missing, marking run failed',
        );
        await db.updateWorkteamRun(run.id, {
          status: 'failed',
          output: 'Team deleted during run',
          completed_at: nowIso(),
        });
        continue;
      }

      const orch = await WorkteamOrchestrator.restoreFromRun(run, snapshot);
      if (orch) {
        recovered += 1;
        logger.info(
          { runId: run.id, teamId: run.team_id, status: run.status },
          'workteam run recovered from checkpoint',
        );
      }
    } catch (err) {
      logger.error(
        { err, runId: run.id },
        'workteam recovery: failed to restore run',
      );
    }
  }

  return recovered;
}
