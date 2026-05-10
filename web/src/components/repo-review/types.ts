import type {
  RepoReviewDigestRun,
  RepoReviewBranchSummary,
  RepoReviewChatMember,
  RepoReviewCommitInfo,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRepositoryDetection,
  RepoReviewRun,
} from '../../app-types';

export type RepoReviewOverview = {
  repositories: RepoReviewRepository[];
  profiles: RepoReviewProfile[];
  runs: RepoReviewRun[];
};

export type RepoReviewBranchStateItem = {
  name: string;
  defaultBranch: boolean;
  headSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
  isReviewing: boolean;
  lastRun: RepoReviewRun | null;
  targetProfiles: RepoReviewProfile[];
};

export type RepoReviewManualReviewMode =
  | 'auto'
  | 'last_reviewed'
  | 'history_run'
  | 'commit_sha'
  | 'full';

export type RepoReviewManualReviewRequest = {
  branch: string;
  mode: RepoReviewManualReviewMode;
  baselineRunId?: string;
  baselineSha?: string;
  allowRepeat?: boolean;
};

export type RepoReviewBranchListResponse = {
  branches: RepoReviewBranchSummary[];
};

export type RepoReviewBranchCommitListResponse = {
  commits: RepoReviewCommitInfo[];
};

export type RepoReviewChatMembersResponse = {
  members: RepoReviewChatMember[];
};

export type RepoReviewRunDetailResponse = {
  run: RepoReviewRun;
  repository?: RepoReviewRepository;
  profile?: RepoReviewProfile | null;
  branchState?: {
    branch: string;
    baselineSource?: string;
    resultState?: string;
    status?: string;
    reviewedAt?: string;
    updatedAt?: string;
  } | null;
};

export type RepoReviewSingleBranchSyncResponse = {
  queued: boolean;
  branch: string;
  headSha: string;
  reason: string;
  reused?: boolean;
  runId?: string;
  usedCachedBranchSummary?: boolean;
  error?: string;
};

export type RepoReviewRepositoryDetectionResponse = {
  detection: RepoReviewRepositoryDetection;
};

export type RepoReviewRunsSummaryResponse = {
  runs: RepoReviewRun[];
  total?: number;
};

export type RepoReviewDigestRunsResponse = {
  runs: RepoReviewDigestRun[];
};

export type RepoReviewDigestRunDetailResponse = {
  run: RepoReviewDigestRun;
  repository: RepoReviewRepository;
};

export type RepoReviewProfileListResponse = {
  profiles: RepoReviewProfile[];
};

export type RepoReviewRepositoryListResponse = {
  repositories: RepoReviewRepository[];
};

export type RepoReviewProfileSaveResponse = {
  profile?: RepoReviewProfile;
  error?: string;
};

export type RepoReviewCancelRunResponse = {
  run?: RepoReviewRun;
  cancelled: boolean;
  error?: string;
};

export type RepoReviewRerunRunResponse = {
  run?: RepoReviewRun;
  blocked?: boolean;
  reused?: boolean;
  message?: string;
  error?: string;
};
