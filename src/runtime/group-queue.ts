import { ChildProcess } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_AGENTS } from '../config.js';
import { logger } from '../logger.js';
import { AgentPromptInput } from '../types.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 2000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskAgent: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  agentLabel: string | null;
  groupFolder: string | null;
  retryCount: number;
}

type PromptInputFactory =
  | AgentPromptInput
  | (() => AgentPromptInput | Promise<AgentPromptInput>);

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private _activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskAgent: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        agentLabel: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  private requestIdleSlot(requestingGroupJid: string): boolean {
    for (const [groupJid, state] of this.groups) {
      if (groupJid === requestingGroupJid) continue;
      if (!state.active || !state.idleWaiting || state.isTaskAgent || !state.groupFolder) {
        continue;
      }
      state.idleWaiting = false;
      logger.info(
        { requestingGroupJid, preemptedGroupJid: groupJid },
        'Preempting idle agent to free concurrency slot',
      );
      this.closeStdin(groupJid);
      return true;
    }
    return false;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  activeCount(): number {
    return this._activeCount;
  }

  queuedCount(): number {
    let count = 0;
    for (const state of this.groups.values()) {
      if (state.pendingMessages) count++;
      count += state.pendingTasks.length;
    }
    return count;
  }

  getTaskRuntimeState(taskId: string): 'queued' | 'running' | null {
    for (const state of this.groups.values()) {
      if (state.runningTaskId === taskId) return 'running';
      if (state.pendingTasks.some((task) => task.id === taskId))
        return 'queued';
    }
    return null;
  }

  isMessageAgentActive(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state?.active && !state.isTaskAgent;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Agent active, message queued');
      return;
    }

    if (this._activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingMessages = true;
      this.requestIdleSlot(groupJid);
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this._activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Agent active, task queued');
      return;
    }

    if (this._activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.requestIdleSlot(groupJid);
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this._activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    agentLabel: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.agentLabel = agentLabel;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the agent as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle agent immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active agent via IPC file.
   * Returns true if the message was written, false if no active agent.
   */
  async sendMessage(
    groupJid: string,
    promptInput: PromptInputFactory,
  ): Promise<boolean> {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskAgent) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle
    const prompt =
      typeof promptInput === 'function'
        ? await Promise.resolve(promptInput())
        : promptInput;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', prompt }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch (err) {
      logger.warn({ err, groupJid }, 'Failed to send IPC message to agent');
      return false;
    }
  }

  /**
   * Signal the active agent to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  stopActiveProcess(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    const proc = state.process;
    if (!state.active || !proc || proc.killed) return false;

    state.idleWaiting = false;
    if (state.groupFolder) {
      this.closeStdin(groupJid);
    }

    try {
      proc.kill('SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskAgent = false;
    state.pendingMessages = false;
    this._activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this._activeCount },
      'Starting agent for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.agentLabel = null;
      state.groupFolder = null;
      this._activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskAgent = true;
    state.runningTaskId = task.id;
    this._activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this._activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskAgent = false;
      state.runningTaskId = null;
      state.process = null;
      state.agentLabel = null;
      state.groupFolder = null;
      this._activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = Math.min(
      BASE_RETRY_MS * Math.pow(2, state.retryCount - 1),
      10000,
    );
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this._activeCount < MAX_CONCURRENT_AGENTS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeAgents: string[] = [];
    const shutdowns: Array<Promise<void>> = [];

    for (const [groupJid, state] of this.groups) {
      const proc = state.process;
      if (!proc || proc.killed || !state.agentLabel) continue;
      activeAgents.push(state.agentLabel);
      shutdowns.push(this.stopProcess(groupJid, state, proc, gracePeriodMs));
    }

    logger.info(
      { activeCount: this._activeCount, activeAgents, gracePeriodMs },
      'GroupQueue shutting down (stopping active agents)',
    );

    await Promise.allSettled(shutdowns);
  }

  private async stopProcess(
    groupJid: string,
    state: GroupState,
    proc: ChildProcess,
    gracePeriodMs: number,
  ): Promise<void> {
    if (state.groupFolder) {
      try {
        this.closeStdin(groupJid);
      } catch {
        // ignore
      }
    }

    const exitPromise = once(proc, 'exit')
      .then(() => undefined)
      .catch(() => undefined);

    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }

    const exitedInTime = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), gracePeriodMs),
      ),
    ]);

    if (!exitedInTime && !proc.killed) {
      logger.warn(
        { groupJid, agentLabel: state.agentLabel },
        'Agent did not exit during shutdown grace period; sending SIGKILL',
      );
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      await exitPromise;
    }
  }
}
