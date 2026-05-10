import type {
  RepoReviewBranchSummary,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRun,
} from '../../app-types';
import { getRepoReviewRunLatestActivityTime } from './run-list-helpers';
import type { RepoReviewBranchStateItem } from './types';

const ACTIVE_BRANCH_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BranchWorkspaceStatusFilter =
  | 'all'
  | 'pending_manual'
  | 'unreviewed'
  | string;

export type BranchWorkspaceRow = RepoReviewBranchStateItem & {
  visible: boolean;
  status: string;
  latestSummary: string;
  latestActivityAt: string;
  pendingManual: boolean;
};

export function normalizeBranchWorkspaceRows(input: {
  repository: Pick<RepoReviewRepository, 'defaultTargetBranch'>;
  remoteBranches: RepoReviewBranchSummary[];
  runs: RepoReviewRun[];
  pushProfiles: RepoReviewProfile[];
  nowMs?: number;
}): BranchWorkspaceRow[] {
  const { repository, remoteBranches, runs, pushProfiles } = input;
  const nowMs = input.nowMs ?? Date.now();
  const branchNames = new Set<string>();

  for (const branch of remoteBranches) {
    if (branch.name) branchNames.add(branch.name);
  }
  for (const run of runs) {
    if (run.branch) branchNames.add(run.branch);
  }
  if (repository.defaultTargetBranch) {
    branchNames.add(repository.defaultTargetBranch);
  }

  return Array.from(branchNames)
    .sort((left, right) => {
      if (left === repository.defaultTargetBranch) return -1;
      if (right === repository.defaultTargetBranch) return 1;
      return left.localeCompare(right, 'en');
    })
    .map((branchName) => {
      const remoteBranch =
        remoteBranches.find((entry) => entry.name === branchName) || null;
      const branchRuns = runs.filter((entry) => entry.branch === branchName);
      const lastRun = getLatestBranchRun(branchRuns);
      const hasExplicitTargetProfile = pushProfiles.some((profile) =>
        profile.targetBranches.includes(branchName),
      );
      const hasRecentRemoteActivity = isTimestampWithinDays(
        remoteBranch?.latestCommitAt || '',
        ACTIVE_BRANCH_WINDOW_DAYS,
        nowMs,
      );
      const hasRecentRunActivity =
        isTimestampWithinDays(lastRun?.createdAt || '', ACTIVE_BRANCH_WINDOW_DAYS, nowMs) ||
        isTimestampWithinDays(lastRun?.startedAt || '', ACTIVE_BRANCH_WINDOW_DAYS, nowMs) ||
        isTimestampWithinDays(lastRun?.completedAt || '', ACTIVE_BRANCH_WINDOW_DAYS, nowMs);
      const isReviewing =
        lastRun?.status === 'queued' || lastRun?.status === 'running';
      const targetProfiles = pushProfiles.filter(
        (profile) =>
          profile.targetBranches.length === 0 ||
          profile.targetBranches.includes(branchName),
      );
      const pendingManual = isPendingManualRun(lastRun);
      const latestSummary = lastRun?.summary || remoteBranch?.title || '';
      const status = pendingManual
        ? 'pending_manual'
        : lastRun?.overall || lastRun?.status || 'unreviewed';

      return {
        name: branchName,
        defaultBranch:
          remoteBranch?.defaultBranch ||
          branchName === repository.defaultTargetBranch,
        headSha: remoteBranch?.headSha || lastRun?.headSha || '',
        actor: remoteBranch?.actor || lastRun?.actor || '',
        title: remoteBranch?.title || lastRun?.summary || '',
        latestCommitAt: remoteBranch?.latestCommitAt || '',
        isReviewing,
        lastRun,
        targetProfiles,
        visible:
          remoteBranch?.defaultBranch ||
          branchName === repository.defaultTargetBranch ||
          hasExplicitTargetProfile ||
          hasRecentRemoteActivity ||
          hasRecentRunActivity ||
          isReviewing,
        status,
        latestSummary,
        latestActivityAt: getLatestActivityAt(remoteBranch, lastRun),
        pendingManual,
      };
    })
    .sort((left, right) => {
      if (left.visible && !right.visible) return -1;
      if (!left.visible && right.visible) return 1;
      if (left.defaultBranch && !right.defaultBranch) return -1;
      if (!left.defaultBranch && right.defaultBranch) return 1;
      const leftTime = getLatestTimestamp([
        left.latestCommitAt,
        left.lastRun?.startedAt || '',
        left.lastRun?.completedAt || '',
        left.lastRun?.createdAt || '',
        left.lastRun?.updatedAt || '',
      ]);
      const rightTime = getLatestTimestamp([
        right.latestCommitAt,
        right.lastRun?.startedAt || '',
        right.lastRun?.completedAt || '',
        right.lastRun?.createdAt || '',
        right.lastRun?.updatedAt || '',
      ]);
      if (!Number.isNaN(leftTime) || !Number.isNaN(rightTime)) {
        if (Number.isNaN(leftTime)) return 1;
        if (Number.isNaN(rightTime)) return -1;
        if (rightTime !== leftTime) return rightTime - leftTime;
      }
      return left.name.localeCompare(right.name, 'en');
    });
}

export function filterBranchWorkspaceRows(
  rows: BranchWorkspaceRow[],
  filters: {
    search: string;
    status: BranchWorkspaceStatusFilter;
  },
): BranchWorkspaceRow[] {
  const keyword = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== 'all') {
      if (filters.status === 'pending_manual') {
        if (!row.pendingManual) return false;
      } else if (filters.status === 'unreviewed') {
        if (row.status !== 'unreviewed') return false;
      } else if (row.status !== filters.status) {
        return false;
      }
    }

    if (!keyword) return true;

    return [
      row.name,
      row.actor,
      row.title,
      row.latestSummary,
      row.lastRun?.summary || '',
    ]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(keyword));
  });
}

export function selectDefaultBranchWorkspaceRow<T extends { name: string; defaultBranch?: boolean }>(
  rows: T[],
  selectedBranchName?: string,
): T | null {
  if (selectedBranchName) {
    const matching = rows.find((row) => row.name === selectedBranchName);
    if (matching) return matching;
  }
  return rows.find((row) => row.defaultBranch) || rows[0] || null;
}

export function paginateBranchWorkspaceRows<T>(
  rows: T[],
  input: { page: number; pageSize: number },
): {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
} {
  const pageSize = Math.max(1, Math.floor(input.pageSize) || 1);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(input.page) || 1), totalPages);
  const start = (page - 1) * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
  };
}

function getLatestBranchRun(runs: RepoReviewRun[]): RepoReviewRun | null {
  if (runs.length === 0) return null;
  return [...runs].sort((left, right) => {
    const timeDiff =
      getRepoReviewRunLatestActivityTime(right) -
      getRepoReviewRunLatestActivityTime(left);
    if (timeDiff !== 0) return timeDiff;
    return right.id.localeCompare(left.id, 'en');
  })[0] || null;
}

function isPendingManualRun(run: RepoReviewRun | null): boolean {
  return Boolean(
    run &&
      run.stage === 'push' &&
      run.passDecisionMode === 'human' &&
      !run.manualDecision &&
      run.status === 'completed' &&
      run.overall !== 'error' &&
      run.overall !== 'skipped',
  );
}

function parseTimestamp(value: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function isTimestampWithinDays(
  value: string,
  days: number,
  nowMs: number,
): boolean {
  const timestamp = parseTimestamp(value);
  if (Number.isNaN(timestamp)) return false;
  return nowMs - timestamp <= days * DAY_MS;
}

function getLatestTimestamp(values: string[]): number {
  let latest = Number.NaN;
  for (const value of values) {
    const timestamp = parseTimestamp(value);
    if (!Number.isNaN(timestamp) && (Number.isNaN(latest) || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function getLatestActivityAt(
  remoteBranch: RepoReviewBranchSummary | null,
  lastRun: RepoReviewRun | null,
): string {
  const candidates = [
    remoteBranch?.latestCommitAt || '',
    lastRun?.updatedAt || '',
    lastRun?.completedAt || '',
    lastRun?.startedAt || '',
    lastRun?.createdAt || '',
  ];
  let latestValue = '';
  let latestTime = Number.NaN;
  for (const value of candidates) {
    const timestamp = parseTimestamp(value);
    if (!Number.isNaN(timestamp) && (Number.isNaN(latestTime) || timestamp > latestTime)) {
      latestTime = timestamp;
      latestValue = value;
    }
  }
  return latestValue;
}
