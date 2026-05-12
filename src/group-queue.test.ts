import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

import { GroupQueue } from './runtime/group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_AGENTS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const mkdirSync = vi.fn();
  const writeFileSync = vi.fn();
  const renameSync = vi.fn();
  return {
    ...actual,
    mkdirSync,
    writeFileSync,
    renameSync,
    default: {
      ...actual,
      mkdirSync,
      writeFileSync,
      renameSync,
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one agent per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_AGENTS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 2000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 4000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  it('signals and kills active processes during shutdown', async () => {
    const queueAny = queue as unknown as { getGroup: (jid: string) => any };
    const state = queueAny.getGroup('group1@g.us');
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    let killedWith: string[] = [];
    const proc = {
      killed: false,
      kill: vi.fn((signal?: string) => {
        killedWith.push(signal || 'SIGTERM');
        if (signal === 'SIGKILL') {
          proc.killed = true;
          for (const fn of listeners.exit || []) fn(0, signal);
        }
        return true;
      }),
      once: vi.fn((event: string, fn: (...args: any[]) => void) => {
        listeners[event] ||= [];
        listeners[event].push(fn);
        return proc;
      }),
      removeListener: vi.fn((event: string, fn: (...args: any[]) => void) => {
        listeners[event] = (listeners[event] || []).filter(
          (item) => item !== fn,
        );
        return proc;
      }),
    };
    state.process = proc;
    state.agentLabel = 'agent-1';
    state.groupFolder = 'web_deadbeef';
    state.active = true;

    const shutdownPromise = queue.shutdown(10);
    await vi.advanceTimersByTimeAsync(11);
    await shutdownPromise;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(killedWith[0]).toBe('SIGTERM');
  });

  it('stops an active process on demand', () => {
    const queueAny = queue as unknown as { getGroup: (jid: string) => any };
    const state = queueAny.getGroup('group1@g.us');
    const proc = {
      killed: false,
      kill: vi.fn(() => true),
    };

    state.process = proc;
    state.groupFolder = 'test-group';
    state.active = true;

    const stopped = queue.stopActiveProcess('group1@g.us');

    expect(stopped).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 3 retries (MAX_RETRIES = 3)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 2000ms, Retry 2: 4000ms, Retry 3: 8000ms
    const retryDelays = [2000, 4000, 8000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 3 retries (4 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active agent when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');

    // Enqueue a task while an agent is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (agent is working, not idle)
    const writeFileSync = vi.mocked(fs.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle agent when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (agent is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts an idle agent in another group when concurrency is full', async () => {
    const fs = await import('fs');
    const completionCallbacks = new Map<string, () => void>();
    const started: string[] = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      started.push(groupJid);
      await new Promise<void>((resolve) => {
        completionCallbacks.set(groupJid, resolve);
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'group-1-folder');
    queue.notifyIdle('group1@g.us');

    const writeFileSync = vi.mocked(fs.writeFileSync);
    writeFileSync.mockClear();

    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(String(closeWrites[0]?.[0])).toContain('group-1-folder');

    completionCallbacks.get('group1@g.us')?.();
    await vi.advanceTimersByTimeAsync(10);

    expect(started).toContain('group3@g.us');
  });

  it('treats idle keepalive agents as not actively replying', async () => {
    const queueAny = queue as unknown as { getGroup: (jid: string) => any };
    const state = queueAny.getGroup('group1@g.us');
    state.active = true;
    state.isTaskAgent = false;
    state.idleWaiting = false;

    expect(queue.isMessageAgentActive('group1@g.us')).toBe(true);
    expect(queue.isMessageAgentReplyInProgress('group1@g.us')).toBe(true);

    queue.notifyIdle('group1@g.us');

    expect(queue.isMessageAgentActive('group1@g.us')).toBe(true);
    expect(queue.isMessageAgentReplyInProgress('group1@g.us')).toBe(false);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');

    // Agent becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    await queue.sendMessage('group1@g.us', { text: 'hello' });

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task agents so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskAgent = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');

    // sendMessage should return false — user messages must not go to task agents
    const result = await queue.sendMessage('group1@g.us', { text: 'hello' });
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage writes structured prompt payload to IPC', async () => {
    const queueAny = queue as unknown as { getGroup: (jid: string) => any };
    const state = queueAny.getGroup('group1@g.us');
    state.active = true;
    state.groupFolder = 'test-group';
    state.isTaskAgent = false;

    const result = await queue.sendMessage('group1@g.us', {
      text: 'hello',
      uploadedFiles: [
        {
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 123,
          relativePath: 'chat_abc/spec.txt',
        },
      ],
    });

    expect(result).toBe(true);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining(
        '"prompt":{"text":"hello","uploadedFiles":[{"name":"spec.txt","mimeType":"text/plain","size":123,"relativePath":"chat_abc/spec.txt"}]}',
      ),
    );
  });

  it('sendMessage builds prompt lazily for active agents', async () => {
    const queueAny = queue as unknown as { getGroup: (jid: string) => any };
    const state = queueAny.getGroup('group1@g.us');
    state.active = true;
    state.groupFolder = 'test-group';
    state.isTaskAgent = false;

    const buildPrompt = vi.fn(() => ({
      text: 'hello from builder',
    }));

    const result = await queue.sendMessage('group1@g.us', buildPrompt);

    expect(result).toBe(true);
    expect(buildPrompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('"prompt":{"text":"hello from builder"}'),
    );
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess('group1@g.us', {} as any, 'agent-1', 'test-group');

    const writeFileSync = vi.mocked(fs.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now the agent becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
