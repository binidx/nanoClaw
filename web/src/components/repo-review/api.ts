import i18n from '../../i18n/index.ts';
import type {
  RepoReviewDigestRun,
  RepoReviewBranchSummary,
  RepoReviewChatMember,
  RepoReviewCommitInfo,
  RepoReviewRun,
} from '../../app-types';
import type {
  RepoReviewBranchListResponse,
  RepoReviewBranchCommitListResponse,
  RepoReviewDigestRunDetailResponse,
  RepoReviewDigestRunsResponse,
  RepoReviewManualReviewRequest,
  RepoReviewCancelRunResponse,
  RepoReviewRerunRunResponse,
  RepoReviewChatMembersResponse,
  RepoReviewOverview,
  RepoReviewProfileListResponse,
  RepoReviewRepositoryDetailResponse,
  RepoReviewRepositoryListResponse,
  RepoReviewRunDetailResponse,
  RepoReviewSingleBranchSyncResponse,
  RepoReviewRunsSummaryResponse,
} from './types';

const REPO_REVIEW_FETCH_TIMEOUT_MS = 15000;

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

export const readRepoReviewJson = readJson;

async function fetchRepoReview(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REPO_REVIEW_FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(i18n.t('error.requestTimeout', { seconds: REPO_REVIEW_FETCH_TIMEOUT_MS / 1000, ns: 'repoReview' }));
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requireOk<T>(
  response: Response,
  fallbackMessage: string,
): Promise<T> {
  const data = await readJson<T & { error?: string }>(response).catch(
    () => ({} as T & { error?: string }),
  );
  if (!response.ok) {
    throw new Error(data.error || fallbackMessage);
  }
  return data;
}

export async function fetchRepoReviewOverview(
  apiBase: string,
  repositoryId?: string,
): Promise<RepoReviewOverview> {
  const runsQuery = repositoryId
    ? `?repositoryId=${encodeURIComponent(repositoryId)}`
    : '';
  const [repositoriesResponse, profilesResponse, runsResponse] =
    await Promise.all([
      fetchRepoReview(`${apiBase}/api/repo-reviews/repositories`),
      fetchRepoReview(`${apiBase}/api/repo-reviews/profiles`),
      fetchRepoReview(`${apiBase}/api/repo-reviews/runs-summary${runsQuery}`),
    ]);

  const repositories = await requireOk<RepoReviewRepositoryListResponse>(
    repositoriesResponse,
    i18n.t('error.loadRepositories', { ns: 'repoReview' }),
  );
  const profiles = await requireOk<RepoReviewProfileListResponse>(
    profilesResponse,
    i18n.t('error.loadProfiles', { ns: 'repoReview' }),
  );
  const runs = await requireOk<RepoReviewRunsSummaryResponse>(
    runsResponse,
    i18n.t('error.loadRuns', { ns: 'repoReview' }),
  );

  return {
    repositories: Array.isArray(repositories.repositories)
      ? repositories.repositories
      : [],
    profiles: Array.isArray(profiles.profiles) ? profiles.profiles : [],
    runs: Array.isArray(runs.runs) ? runs.runs : [],
  };
}

export async function fetchRepoReviewRepositories(
  apiBase: string,
  options: {
    summary?: boolean;
  } = {},
): Promise<RepoReviewRepositoryListResponse['repositories']> {
  const query = options.summary ? '?summary=1' : '';
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories${query}`,
  );
  const data = await requireOk<RepoReviewRepositoryListResponse>(
    response,
    i18n.t('error.loadRepositories', { ns: 'repoReview' }),
  );
  return Array.isArray(data.repositories) ? data.repositories : [];
}

export async function fetchRepoReviewRepositoryDetail(
  apiBase: string,
  repositoryId: string,
): Promise<RepoReviewRepositoryDetailResponse> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryId)}`,
  );
  return requireOk<RepoReviewRepositoryDetailResponse>(
    response,
    i18n.t('error.loadRepositories', { ns: 'repoReview' }),
  );
}

export async function fetchRepoReviewProfiles(
  apiBase: string,
  repositoryId?: string,
): Promise<RepoReviewProfileListResponse['profiles']> {
  const query = repositoryId
    ? `?repositoryId=${encodeURIComponent(repositoryId)}`
    : '';
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/profiles${query}`,
  );
  const data = await requireOk<RepoReviewProfileListResponse>(
    response,
    i18n.t('error.loadProfiles', { ns: 'repoReview' }),
  );
  return Array.isArray(data.profiles) ? data.profiles : [];
}

export async function fetchRepoReviewRemoteBranches(
  apiBase: string,
  repositoryId: string,
  force = false,
): Promise<RepoReviewBranchSummary[]> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryId)}/branches${force ? '?force=1' : ''}`,
  );
  const data = await requireOk<RepoReviewBranchListResponse>(
    response,
    i18n.t('error.loadRemoteBranches', { ns: 'repoReview' }),
  );
  return Array.isArray(data.branches) ? data.branches : [];
}

export async function fetchRepoReviewBranchCommits(
  apiBase: string,
  repositoryId: string,
  branch: string,
  limit = 20,
): Promise<RepoReviewCommitInfo[]> {
  const params = new URLSearchParams();
  params.set('branch', branch);
  params.set('limit', String(limit));
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryId)}/branch-commits?${params.toString()}`,
  );
  const data = await requireOk<RepoReviewBranchCommitListResponse>(
    response,
    i18n.t('error.branchCommitFailed', { ns: 'repoReview' }),
  );
  return Array.isArray(data.commits) ? data.commits : [];
}

export async function fetchRepoReviewChatMembers(
  apiBase: string,
  chatJid: string,
): Promise<RepoReviewChatMember[]> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/review-chat-members?chatJid=${encodeURIComponent(chatJid)}`,
  );
  const data = await requireOk<RepoReviewChatMembersResponse>(
    response,
    i18n.t('error.loadFeishuMembers', { ns: 'repoReview' }),
  );
  return Array.isArray(data.members) ? data.members : [];
}

export async function fetchRepoReviewRunDetail(
  apiBase: string,
  runId: string,
): Promise<RepoReviewRunDetailResponse> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/runs/${encodeURIComponent(runId)}/detail`,
  );
  return requireOk<RepoReviewRunDetailResponse>(response, i18n.t('error.loadRunDetail', { ns: 'repoReview' }));
}

export async function fetchRepoReviewRunSummaries(
  apiBase: string,
  input: {
    repositoryId?: string;
    status?: string;
    keyword?: string;
    branch?: string;
    limit?: number;
  } = {},
): Promise<RepoReviewRun[]> {
  const params = new URLSearchParams();
  if (input.repositoryId) params.set('repositoryId', input.repositoryId);
  if (input.status) params.set('status', input.status);
  if (input.keyword) params.set('keyword', input.keyword);
  if (input.branch) params.set('branch', input.branch);
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    params.set('limit', String(input.limit));
  }
  const query = params.toString();
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/runs-summary${query ? `?${query}` : ''}`,
  );
  const data = await requireOk<RepoReviewRunsSummaryResponse>(
    response,
    i18n.t('error.loadRuns', { ns: 'repoReview' }),
  );
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function fetchRepoReviewDigestRuns(
  apiBase: string,
  repositoryId: string,
  limit = 20,
): Promise<RepoReviewDigestRun[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryId)}/digest-runs?${params.toString()}`,
  );
  const data = await requireOk<RepoReviewDigestRunsResponse>(
    response,
    i18n.t('error.loadDigestRuns', { ns: 'repoReview' }),
  );
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function fetchRepoReviewDigestRunDetail(
  apiBase: string,
  runId: string,
): Promise<RepoReviewDigestRunDetailResponse> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/digest-runs/${encodeURIComponent(runId)}`,
  );
  return requireOk<RepoReviewDigestRunDetailResponse>(
    response,
    i18n.t('error.loadDigestRunDetail', { ns: 'repoReview' }),
  );
}

export async function triggerRepoReviewManualBranch(
  apiBase: string,
  repositoryId: string,
  input: RepoReviewManualReviewRequest,
): Promise<RepoReviewSingleBranchSyncResponse> {
  const payload =
    input.mode === 'auto'
      ? {
          branch: input.branch,
        }
      : input.mode === 'history_run'
        ? {
            branch: input.branch,
            baselineMode: 'history_run',
            baselineRunId: input.baselineRunId,
            reviewMode: 'incremental',
            allowRepeat: input.allowRepeat ?? true,
          }
        : input.mode === 'commit_sha'
          ? {
              branch: input.branch,
              baselineMode: 'commit_sha',
              baselineSha: input.baselineSha,
              reviewMode: 'incremental',
              allowRepeat: input.allowRepeat ?? true,
            }
        : input.mode === 'full'
          ? {
              branch: input.branch,
              baselineMode: 'default_branch',
              reviewMode: 'full',
              allowRepeat: input.allowRepeat ?? true,
            }
          : {
              branch: input.branch,
              baselineMode: 'last_reviewed',
              reviewMode: 'incremental',
              allowRepeat: input.allowRepeat ?? true,
            };
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/repositories/${encodeURIComponent(repositoryId)}/sync-branch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return requireOk<RepoReviewSingleBranchSyncResponse>(
    response,
    i18n.t('error.triggerBranch', { ns: 'repoReview' }),
  );
}

export async function cancelRepoReviewRun(
  apiBase: string,
  runId: string,
): Promise<RepoReviewCancelRunResponse> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return requireOk<RepoReviewCancelRunResponse>(
    response,
    i18n.t('error.cancelFailed', { ns: 'repoReview' }),
  );
}

export async function rerunRepoReviewRun(
  apiBase: string,
  runId: string,
): Promise<RepoReviewRerunRunResponse> {
  const response = await fetchRepoReview(
    `${apiBase}/api/repo-reviews/runs/${encodeURIComponent(runId)}/rerun`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return requireOk<RepoReviewRerunRunResponse>(
    response,
    i18n.t('error.rerunFailed', { ns: 'repoReview' }),
  );
}
