const INTERNAL_API_BASE = String(
  process.env.NANOCLAW_INTERNAL_API_BASE || '',
).trim();
const INTERNAL_API_TOKEN = String(
  process.env.NANOCLAW_INTERNAL_API_TOKEN || '',
).trim();
const INTERNAL_API_TOKEN_HEADER = 'x-nanoclaw-internal-api-token';

function canUseReviewApi(): boolean {
  return Boolean(INTERNAL_API_BASE && INTERNAL_API_TOKEN);
}

let _cachedReviewRepoIds: string[] | undefined;

export function getReviewRepositoryIds(): string[] {
  if (_cachedReviewRepoIds !== undefined) return _cachedReviewRepoIds;
  try {
    const raw = process.env.NANOCLAW_REVIEW_REPOSITORY_IDS || '[]';
    const parsed = JSON.parse(raw);
    _cachedReviewRepoIds = Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    _cachedReviewRepoIds = [];
  }
  return _cachedReviewRepoIds;
}

export function isReviewEnabled(): boolean {
  return getReviewRepositoryIds().length > 0;
}

async function callReviewApi<T>(
  pathname: string,
  body: Record<string, unknown>,
): Promise<T> {
  if (!canUseReviewApi()) {
    throw new Error('Review internal API not configured');
  }
  const response = await fetch(`${INTERNAL_API_BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_API_TOKEN_HEADER]: INTERNAL_API_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const message =
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export interface ReviewQueryResult {
  results: Array<{
    runId: string;
    repositoryId: string;
    repositoryName: string;
    branch: string | null;
    overall: string;
    completedAt: string | null;
    findingCounts: { high: number; medium: number; low: number };
    topFindings: Array<{ severity: string; title: string; file?: string }>;
    worktreePath: string | null;
    worktreeStatus: 'active' | 'none';
  }>;
}

export async function queryReviewRuns(input: {
  repositoryIds: string[];
  branch?: string;
  severity?: string;
  limit?: number;
}): Promise<ReviewQueryResult> {
  return callReviewApi<ReviewQueryResult>('/internal/review/query', {
    repositoryIds: input.repositoryIds,
    branch: input.branch || undefined,
    severity: input.severity || undefined,
    limit: input.limit || 10,
  });
}

export interface ReviewDetailResult {
  runId: string;
  repositoryId: string;
  repositoryName: string;
  branch: string | null;
  overall: string;
  summary: string;
  completedAt: string | null;
  findingCounts: { high: number; medium: number; low: number };
  findings: {
    high: Array<{
      title: string;
      file?: string;
      detail: string;
      suggestion?: string;
    }>;
    medium: Array<{
      title: string;
      file?: string;
      detail: string;
      suggestion?: string;
    }>;
    low: Array<{
      title: string;
      file?: string;
      detail: string;
      suggestion?: string;
    }>;
  };
  worktreePath: string | null;
  worktreeStatus: 'active' | 'none';
}

export async function getReviewRunDetail(
  runId: string,
  repositoryIds: string[],
): Promise<ReviewDetailResult> {
  return callReviewApi<ReviewDetailResult>('/internal/review/detail', {
    runId,
    repositoryIds,
  });
}
