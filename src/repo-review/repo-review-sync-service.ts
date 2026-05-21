import type {
  RepoReviewBranchTriggerResult,
  RepoReviewExecutionSummary,
  RepoReviewEvent,
} from './repo-review-service.js';

export interface RepoReviewExecutionQueue<T> {
  enqueue(item: T): void;
  removeWhere(predicate: (item: T) => boolean): number;
  some(predicate: (item: T) => boolean): boolean;
}

export function createRepoReviewExecutionQueue<T>(input: {
  concurrency: number;
  execute: (item: T) => Promise<unknown>;
  onError?: (error: unknown, item: T) => void;
}): RepoReviewExecutionQueue<T> {
  const concurrency = Math.max(1, Math.floor(input.concurrency) || 1);
  const pending: T[] = [];
  const runningItems: T[] = [];

  const drain = () => {
    while (runningItems.length < concurrency && pending.length > 0) {
      const item = pending.shift()!;
      runningItems.push(item);
      input
        .execute(item)
        .catch((error) => {
          input.onError?.(error, item);
        })
        .finally(() => {
          const idx = runningItems.indexOf(item);
          if (idx >= 0) runningItems.splice(idx, 1);
          drain();
        });
    }
  };

  return {
    enqueue(item: T) {
      pending.push(item);
      drain();
    },
    removeWhere(predicate: (item: T) => boolean) {
      let removed = 0;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (predicate(pending[index]!)) {
          pending.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    some(predicate: (item: T) => boolean) {
      return pending.some(predicate) || runningItems.some(predicate);
    },
  };
}

export interface RepoReviewBranchExecutionHead {
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
}

export interface RepoReviewBranchExecutionState {
  headSha: string;
  status: string;
  resultState: string;
  lastRunId?: string;
}

export interface RepoReviewBranchExecutionBaseline {
  baseSha: string;
  baseBranch?: string;
  baselineSource?: string;
}

export interface RepoReviewPreparedBranchExecution {
  branch: string;
  head: RepoReviewBranchExecutionHead;
  baseline: RepoReviewBranchExecutionBaseline;
}

export async function mapWithConcurrencyLimit<T, TResult>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency) || 1);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(normalizedConcurrency, items.length || 1) },
      () => runWorker(),
    ),
  );
  return results;
}

export async function executePreparedRepoReviewBranches<TExecutionResult>(input: {
  branches: string[];
  defaultBranch: string;
  applyActiveWindow: boolean;
  activeWindowDays: number;
  concurrency: number;
  getHead: (branch: string) => RepoReviewBranchExecutionHead | undefined;
  getBranchState: (
    branch: string,
  ) => RepoReviewBranchExecutionState | undefined;
  isBranchActiveWithinWindow: (latestCommitAt: string, days: number) => boolean;
  resolveBaseline: (
    branch: string,
    head: RepoReviewBranchExecutionHead,
  ) => Promise<RepoReviewBranchExecutionBaseline>;
  executePreparedBranch: (
    prepared: RepoReviewPreparedBranchExecution,
  ) => Promise<TExecutionResult>;
  formatTriggeredResult: (
    prepared: RepoReviewPreparedBranchExecution,
    executionResult: TExecutionResult,
  ) => RepoReviewBranchTriggerResult;
}): Promise<RepoReviewBranchTriggerResult[]> {
  return mapWithConcurrencyLimit(
    input.branches,
    input.concurrency,
    async (branch) => {
      try {
        const head = input.getHead(branch);
        if (!head?.headSha) {
          return {
            branch,
            headSha: '',
            status: 'error',
            reason: '无法获取分支最新提交。',
          } satisfies RepoReviewBranchTriggerResult;
        }
        if (
          input.applyActiveWindow &&
          branch !== input.defaultBranch &&
          !input.isBranchActiveWithinWindow(
            head.latestCommitAt,
            input.activeWindowDays,
          )
        ) {
          return {
            branch,
            headSha: head.headSha,
            status: 'skipped',
            reason: `该分支不在最近 ${input.activeWindowDays} 天活跃窗口内`,
          } satisfies RepoReviewBranchTriggerResult;
        }
        const branchState = input.getBranchState(branch);
        if (
          branchState?.headSha === head.headSha &&
          (branchState.status === 'queued' || branchState.status === 'running')
        ) {
          return {
            branch,
            headSha: head.headSha,
            status: 'skipped',
            reason: '该分支已有审查任务执行中',
            runId: branchState.lastRunId || undefined,
          } satisfies RepoReviewBranchTriggerResult;
        }
        if (
          branchState?.headSha === head.headSha &&
          branchState.resultState &&
          branchState.resultState !== 'error'
        ) {
          return {
            branch,
            headSha: head.headSha,
            status: 'skipped',
            reason: '该分支当前提交已完成审查，无需重复执行。',
            runId: branchState.lastRunId || undefined,
          } satisfies RepoReviewBranchTriggerResult;
        }
        const baseline = await input.resolveBaseline(branch, head);
        if (!baseline.baseSha) {
          return {
            branch,
            headSha: head.headSha,
            status: 'skipped',
            reason: '无法确定审查基线提交。',
          } satisfies RepoReviewBranchTriggerResult;
        }
        const prepared = {
          branch,
          head,
          baseline,
        } satisfies RepoReviewPreparedBranchExecution;
        const executionResult = await input.executePreparedBranch(prepared);
        return input.formatTriggeredResult(prepared, executionResult);
      } catch (error) {
        return {
          branch,
          headSha: '',
          status: 'error',
          reason: error instanceof Error ? error.message : '分支审查执行失败。',
        } satisfies RepoReviewBranchTriggerResult;
      }
    },
  );
}

export function isReusedRepoReviewExecutionSummary(
  result: RepoReviewExecutionSummary | undefined,
): result is RepoReviewExecutionSummary & { reused: true } {
  return Boolean(result?.reused);
}

export function isRepoReviewEventForRepository(
  event: RepoReviewEvent,
  repositoryId: string,
): boolean {
  return event.repositoryId === repositoryId;
}
