import {
  getDigestRunById,
  getReviewProfileById,
  getReviewRepositoryById,
  listDigestRunsByRepository,
  listReviewRepositoriesForUser,
  listReviewRunsSummary,
  parseReviewRunRecord,
  type DigestRunRecord,
  type ReviewProfileRecord,
  type ReviewRunSummaryQueryInput,
  type ReviewRunRecord,
} from '../db.js';
import {
  getRepoReviewRunDetail,
  listRepoReviewProfiles,
  listRepoReviewRepositories,
  normalizeRepoReviewRepositoryRecord,
  type RepoReviewDigestRun,
  type RepoReviewDigestRunDetail,
  type RepoReviewProfile,
  type RepoReviewRepository,
  type RepoReviewRun,
} from './repo-review-service.js';
import type { RepoReviewProgressStep } from './repo-review-model.js';

export interface RepoReviewRunSummaryQuery {
  repositoryId?: string;
  status?: string;
  keyword?: string;
  branch?: string;
  limit?: number;
  userId?: string;
}

export interface RepoReviewRunsSummaryReadResult {
  runs: RepoReviewRun[];
  total: number;
}

function normalizeDigestRunRecord(
  record: DigestRunRecord,
): RepoReviewDigestRun {
  return {
    id: record.id,
    repositoryId: record.repository_id,
    type: record.type === 'weekly' ? 'weekly' : 'daily',
    status: stringValue(record.status),
    timezone: stringValue(record.timezone),
    scheduledFor: stringValue(record.scheduled_for),
    periodStart: stringValue(record.period_start),
    periodEnd: stringValue(record.period_end),
    startedAt: stringValue(record.started_at),
    completedAt: stringValue(record.completed_at),
    durationMs: Math.max(0, Number(record.duration_ms) || 0),
    branchCount: Math.max(0, Number(record.branch_count) || 0),
    commitCount: Math.max(0, Number(record.commit_count) || 0),
    contributorCount: Math.max(0, Number(record.contributor_count) || 0),
    summary: stringValue(record.summary),
    cloudDocUrl: stringValue(record.cloud_doc_url),
    cloudDocStatus: stringValue(record.cloud_doc_status),
    deliveryStatus: stringValue(record.delivery_status),
    deliveryError: stringValue(record.delivery_error),
    errorMessage: stringValue(record.error_message),
    createdAt: stringValue(record.created_at),
  };
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeLegacyRepoReviewText(value: unknown): string {
  const text = stringValue(value);
  if (text === 'auto_9b7955') {
    return '服务重启前存在未完成的审查运行，已标记为失败。';
  }
  if (text === 'auto_d61a54') {
    return '该审查运行因 NanoClaw 重启而被中断，无法安全恢复，请重新触发审查。';
  }
  if (text === 'auto_5b708c') {
    return '审查运行长时间无进展，已标记为失败。';
  }
  if (text === 'auto_fb8c04') {
    return '运行在超时窗口内未完成，系统已终止该次审查状态。';
  }
  return text;
}

function normalizeSummaryReviewProgress(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const latestAssistantText = stringValue(record.latestAssistantText);
  const latestErrorText = stringValue(record.latestErrorText);
  const turnCount = Math.max(0, Number(record.turnCount) || 0);
  const hasTerminalOutput = Boolean(record.hasTerminalOutput);
  const steps: RepoReviewProgressStep[] = Array.isArray(record.steps)
    ? record.steps
        .map((entry): RepoReviewProgressStep | null => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
          }
          const step = entry as Record<string, unknown>;
          const id = stringValue(step.id);
          if (!id) return null;
          const rawStatus = stringValue(step.status);
          const status: RepoReviewProgressStep['status'] =
            rawStatus === 'queued' ||
            rawStatus === 'running' ||
            rawStatus === 'completed' ||
            rawStatus === 'failed' ||
            rawStatus === 'skipped'
              ? rawStatus
              : 'running';
          const activeStartedAt = stringValue(step.activeStartedAt);
          const completedAt = stringValue(step.completedAt);
          const durationMs = Math.max(0, Number(step.durationMs) || 0);
          const detail = stringValue(step.detail);
          const inputText = stringValue(step.inputText);
          const outputText = stringValue(step.outputText);
          const metadataText = stringValue(step.metadataText);
          const error = stringValue(step.error);
          return {
            id,
            label: stringValue(step.label) || id,
            kind:
              stringValue(step.kind) === 'stage' ||
              stringValue(step.kind) === 'main' ||
              stringValue(step.kind) === 'subagent' ||
              stringValue(step.kind) === 'extractor' ||
              stringValue(step.kind) === 'worker' ||
              stringValue(step.kind) === 'reducer'
                ? (stringValue(step.kind) as RepoReviewProgressStep['kind'])
                : undefined,
            status,
            startedAt: stringValue(step.startedAt),
            ...(activeStartedAt ? { activeStartedAt } : {}),
            ...(completedAt ? { completedAt } : {}),
            ...(durationMs > 0 ? { durationMs } : {}),
            ...(detail ? { detail } : {}),
            ...(inputText ? { inputText } : {}),
            ...(outputText ? { outputText } : {}),
            ...(metadataText ? { metadataText } : {}),
            ...(error ? { error } : {}),
          };
        })
        .filter((step): step is RepoReviewProgressStep => Boolean(step))
    : [];
  if (
    turnCount === 0 &&
    !latestAssistantText &&
    !latestErrorText &&
    !hasTerminalOutput &&
    steps.length === 0
  ) {
    return undefined;
  }
  return {
    snapshotVersion: Math.max(0, Number(record.snapshotVersion) || 0) || undefined,
    heartbeatAt: stringValue(record.heartbeatAt) || undefined,
    runTerminal: Boolean(record.runTerminal),
    turnCount,
    latestAssistantText,
    latestErrorText: latestErrorText || null,
    hasTerminalOutput,
    ...(steps.length > 0 ? { steps } : {}),
  };
}

async function normalizeSummaryRunRecord(
  record: ReviewRunRecord,
  profileHint?: ReviewProfileRecord | null,
): Promise<RepoReviewRun> {
  const parsed = await parseReviewRunRecord(record);
  const callbackContext =
    parsed.callbackContext && typeof parsed.callbackContext === 'object'
      ? parsed.callbackContext
      : null;
  const profile =
    profileHint !== undefined
      ? profileHint
      : record.profile_id
        ? await getReviewProfileById(record.profile_id)
        : null;
  const manualDecision =
    record.manual_decision === 'pass' || record.manual_decision === 'fail'
      ? record.manual_decision
      : '';
  const reviewProgress = normalizeSummaryReviewProgress(
    callbackContext?.reviewProgress,
  );

  return {
    id: record.id,
    repositoryId: record.repository_id,
    profileId: record.profile_id || '',
    source: record.source,
    stage: record.stage,
    status: record.status,
    idempotencyKey: record.idempotency_key || '',
    overall: record.overall || '',
    passDecisionMode: profile?.pass_decision_mode === 'human' ? 'human' : 'ai',
    recommendedBlock: parsed.recommendedBlock,
    blockingEnforced: parsed.blockingEnforced,
    baselineSource: record.baseline_source || '',
    baselineRef:
      typeof callbackContext?.baselineRef === 'string'
        ? callbackContext.baselineRef
        : '',
    baselineLabel:
      typeof callbackContext?.baselineLabel === 'string'
        ? callbackContext.baselineLabel
        : '',
    resultState: record.result_state || '',
    ref: record.ref || '',
    branch: record.branch || '',
    baseSha: record.base_sha || '',
    headSha: record.head_sha || '',
    prMrNumber: record.pr_mr_number || '',
    actor: record.actor || '',
    summary: normalizeLegacyRepoReviewText(record.summary),
    findings: [],
    scopeLimitations: [],
    reviewTurns: [],
    reviewProgress,
    commitDetails: [],
    commitReviews: [],
    suggestions: [],
    changedFiles: [],
    diffBytes: record.diff_bytes,
    durationMs: Number(record.duration_ms || 0),
    platformStatus: record.platform_status || '',
    chatDeliveryStatus: record.chat_delivery_status || '',
    platformStatusDeliveryStatus: record.platform_status_delivery_status || '',
    platformCommentDeliveryStatus:
      record.platform_comment_delivery_status || '',
    platformCommentId: record.platform_comment_id || '',
    platformCommentUrl: record.platform_comment_url || '',
    cloudDocToken: record.cloud_doc_token || '',
    cloudDocUrl: record.cloud_doc_url || '',
    cloudDocTitle: record.cloud_doc_title || '',
    cloudDocStatus: record.cloud_doc_status || '',
    cloudDocLastError: record.cloud_doc_last_error || '',
    lastDeliveryError: record.last_delivery_error || '',
    deliveryRetryCount: Number(record.delivery_retry_count || 0),
    effectiveRules: {},
    manualDecision,
    manualDecisionBy: record.manual_decision_by || '',
    manualDecisionAt: record.manual_decision_at || '',
    error: normalizeLegacyRepoReviewText(record.error),
    startedAt: record.started_at || '',
    completedAt: record.completed_at || '',
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

async function buildRepoReviewRunSummaries(
  query: RepoReviewRunSummaryQuery = {},
): Promise<RepoReviewRunsSummaryReadResult> {
  const repositoryId = stringValue(query.repositoryId);
  const status = stringValue(query.status);
  const keyword = stringValue(query.keyword).toLowerCase();
  const branch = stringValue(query.branch);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 100));
  const runs = await listReviewRunsSummary({
    repositoryId: repositoryId || undefined,
    status: status || undefined,
    branch: branch || undefined,
    keyword: keyword || undefined,
    limit,
    userId: stringValue(query.userId) || undefined,
  } satisfies ReviewRunSummaryQueryInput);
  const profileIds = new Set(
    runs.map((record) => record.profile_id).filter(Boolean) as string[],
  );
  const profileMap = new Map<string, ReviewProfileRecord>();
  for (const profileId of profileIds) {
    const profile = await getReviewProfileById(profileId);
    if (profile) profileMap.set(profileId, profile);
  }

  const normalizedRuns = await Promise.all(
    runs.map((record) =>
      normalizeSummaryRunRecord(
        record,
        record.profile_id ? (profileMap.get(record.profile_id) ?? null) : null,
      ),
    ),
  );

  return {
    runs: normalizedRuns,
    total: normalizedRuns.length,
  };
}

export async function listRepoReviewRunSummaries(
  query: RepoReviewRunSummaryQuery = {},
): Promise<RepoReviewRun[]> {
  return (await buildRepoReviewRunSummaries(query)).runs;
}

export async function listRepoReviewRunsSummaryRead(
  query: RepoReviewRunSummaryQuery = {},
): Promise<RepoReviewRun[]> {
  return (await buildRepoReviewRunSummaries(query)).runs;
}

export function listRepoReviewRepositoriesRead() {
  return listRepoReviewRepositories();
}

export function listRepoReviewProfilesRead(repositoryId?: string) {
  return listRepoReviewProfiles(repositoryId);
}

export async function listRepoReviewRunSummariesResult(
  query: RepoReviewRunSummaryQuery = {},
): Promise<RepoReviewRunsSummaryReadResult> {
  return await buildRepoReviewRunSummaries(query);
}

export async function getRepoReviewOverviewRead(
  repositoryId?: string,
  userId?: string,
): Promise<{
  repositories: RepoReviewRepository[];
  profiles: RepoReviewProfile[];
  runs: RepoReviewRun[];
}> {
  let repositories: RepoReviewRepository[];
  if (userId) {
    repositories = await Promise.all(
      (await listReviewRepositoriesForUser(userId)).map((r) =>
        normalizeRepoReviewRepositoryRecord(r),
      ),
    );
    if (repositoryId) {
      repositories = repositories.filter((r) => r.id === repositoryId);
    }
  } else {
    repositories = await listRepoReviewRepositories();
  }
  const repoIds = new Set(repositories.map((r) => r.id));
  const profiles = (await listRepoReviewProfiles(repositoryId)).filter((p) =>
    repoIds.has(p.repositoryId),
  );
  const runs = (
    await listRepoReviewRunsSummaryRead({ repositoryId, userId })
  ).filter((r) => repoIds.has(r.repositoryId));
  return { repositories, profiles, runs };
}

export function getRepoReviewRunDetailRead(runId: string) {
  return getRepoReviewRunDetail(runId);
}

export async function listRepoReviewDigestRunsRead(
  repositoryId: string,
  limit = 20,
): Promise<RepoReviewDigestRun[]> {
  return (await listDigestRunsByRepository(repositoryId, limit)).map(
    normalizeDigestRunRecord,
  );
}

export async function getRepoReviewDigestRunDetailRead(
  runId: string,
): Promise<RepoReviewDigestRunDetail | null> {
  const record = await getDigestRunById(runId);
  if (!record) return null;
  const repositoryRecord = await getReviewRepositoryById(record.repository_id);
  if (!repositoryRecord) return null;
  return {
    run: normalizeDigestRunRecord(record),
    repository: await normalizeRepoReviewRepositoryRecord(repositoryRecord),
  };
}
