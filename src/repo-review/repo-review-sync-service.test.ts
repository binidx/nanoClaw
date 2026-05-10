import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRepoReviewExecutionQueue,
  executePreparedRepoReviewBranches,
  mapWithConcurrencyLimit,
} from './repo-review-sync-service.js';

describe('repo-review-sync-service', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('maps work with a fixed concurrency ceiling while preserving order', async () => {
    let running = 0;
    let maxRunning = 0;

    const results = await mapWithConcurrencyLimit(
      ['a', 'b', 'c', 'd'],
      2,
      async (value, index) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5 - index));
        running -= 1;
        return `${index}:${value}`;
      },
    );

    expect(maxRunning).toBe(2);
    expect(results).toEqual(['0:a', '1:b', '2:c', '3:d']);
  });

  it('executes prepared branch reviews with skip and trigger semantics', async () => {
    const executePreparedBranch = vi.fn(async ({ branch }) => ({
      run: {
        id: `run-${branch}`,
        summary: `queued ${branch}`,
      },
    }));

    const results = await executePreparedRepoReviewBranches({
      branches: ['main', 'stale', 'running'],
      defaultBranch: 'main',
      applyActiveWindow: true,
      activeWindowDays: 14,
      concurrency: 2,
      getHead: (branch) => ({
        headSha: `head-${branch}`,
        parentSha: `parent-${branch}`,
        actor: branch,
        title: branch,
        latestCommitAt:
          branch === 'stale'
            ? '2026-01-01T00:00:00.000Z'
            : '2026-03-18T00:00:00.000Z',
      }),
      getBranchState: (branch) =>
        branch === 'running'
          ? {
              headSha: 'head-running',
              status: 'running',
              resultState: '',
              lastRunId: 'run-running-existing',
            }
          : undefined,
      isBranchActiveWithinWindow: (latestCommitAt) =>
        latestCommitAt.startsWith('2026-03'),
      resolveBaseline: async (branch) => ({
        baseSha: `base-${branch}`,
        baseBranch: 'main',
        baselineSource: 'default-branch-head',
      }),
      executePreparedBranch,
      formatTriggeredResult: (prepared, result) => ({
        branch: prepared.branch,
        headSha: prepared.head.headSha,
        status: 'triggered',
        reason: result.run.summary,
        runId: result.run.id,
      }),
    });

    expect(results).toEqual([
      {
        branch: 'main',
        headSha: 'head-main',
        status: 'triggered',
        reason: 'queued main',
        runId: 'run-main',
      },
      {
        branch: 'stale',
        headSha: 'head-stale',
        status: 'skipped',
        reason: '该分支不在最近 14 天活跃窗口内',
      },
      {
        branch: 'running',
        headSha: 'head-running',
        status: 'skipped',
        reason: '该分支已有审查任务执行中',
        runId: 'run-running-existing',
      },
    ]);
    expect(executePreparedBranch).toHaveBeenCalledTimes(1);
  });

  it('removes pending items from the execution queue without touching running work', async () => {
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const queue = createRepoReviewExecutionQueue<string>({
      concurrency: 1,
      execute: async (item) => {
        calls.push(item);
        if (item === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });

    queue.enqueue('first');
    queue.enqueue('second');
    queue.enqueue('third');
    queue.removeWhere((item) => item === 'second');
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(['first', 'third']);
  });

  it('some() detects items that are currently running, not just pending', async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const queue = createRepoReviewExecutionQueue<string>({
      concurrency: 1,
      execute: async (item) => {
        if (item === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else if (item === 'second') {
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
        }
      },
    });

    queue.enqueue('first');
    queue.enqueue('second');

    // 'first' is running (dequeued from pending), 'second' is pending
    expect(queue.some((i) => i === 'first')).toBe(true);
    expect(queue.some((i) => i === 'second')).toBe(true);
    expect(queue.some((i) => i === 'third')).toBe(false);

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // after 'first' completes, 'second' moved to running
    expect(queue.some((i) => i === 'first')).toBe(false);
    expect(queue.some((i) => i === 'second')).toBe(true);

    releaseSecond?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queue.some((i) => i === 'second')).toBe(false);
  });
});
