import {
  getDigestRunById,
  getReviewProfileById,
  getReviewRepositoryById,
  listDigestRunsByRepository,
  listReviewProfiles,
  listReviewRepositories,
  listReviewRepositoriesForUser,
  listReviewRunsSummary,
  parseReviewRunRecord,
  type DigestRunRecord,
  type ReviewProfileRecord,
  type ReviewRepositoryRecord,
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
import type {
  RepoReviewExecutionStats,
  RepoReviewObservabilityConfidenceSummary,
  RepoReviewObservabilityPlannerSummary,
  RepoReviewProgressSnapshot,
  RepoReviewProgressStep,
  RepoReviewRunObservabilitySummary,
} from './repo-review-model.js';

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

function normalizeRepositorySummaryRecord(
  record: ReviewRepositoryRecord,
  profileCount: number,
): RepoReviewRepository {
  const provider = record.remote_provider || '';
  return {
    id: record.id,
    name: record.name,
    language: record.language || '',
    localRepoPath: record.local_repo_path || '',
    remoteProvider: provider,
    remoteRepoSlug: record.remote_repo_slug || '',
    remoteBaseUrl: '',
    cloneUrl: '',
    defaultTargetBranch: record.default_target_branch || '',
    reviewChatJid: record.review_chat_jid || `repo-review:${record.id}`,
    actorMentionMappings: [],
    autoSyncEnabled: record.auto_sync_enabled === 1,
    autoSyncIntervalMinutes: Math.max(
      5,
      Math.min(1440, Number(record.auto_sync_interval_minutes) || 30),
    ),
    lastAutoSyncAt: record.last_auto_sync_at || '',
    nextAutoSyncAt: '',
    lastAutoSyncStatus: record.last_auto_sync_status || '',
    lastAutoSyncMessage: '',
    digestDailyEnabled: false,
    digestWeeklyEnabled: false,
    digestDailyHour: 18,
    digestWeeklyDay: 5,
    digestWeeklyHour: 18,
    lastDigestDailyAt: '',
    nextDigestDailyAt: '',
    lastDigestWeeklyAt: '',
    nextDigestWeeklyAt: '',
    enabled: record.enabled === 1,
    allowAiFix: false,
    hasWebhookSecret: false,
    hasPlatformToken: false,
    profileCount,
    ...(record.ssh_key_id ? { sshKeyId: record.ssh_key_id } : {}),
  };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const normalized = stringValue(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeObservabilityConfidence(
  value: unknown,
): RepoReviewObservabilityConfidenceSummary | undefined {
  const record = asRecord(value);
  const overall = Number(record.overall);
  if (!Number.isFinite(overall)) return undefined;
  const seedScore = Number(record.seedScore);
  const graphScore = Number(record.graphScore);
  const contextScore = Number(record.contextScore);
  return {
    overall: Math.max(0, overall),
    ...(Number.isFinite(seedScore)
      ? { seedScore: Math.max(0, seedScore) }
      : {}),
    ...(Number.isFinite(graphScore)
      ? { graphScore: Math.max(0, graphScore) }
      : {}),
    ...(Number.isFinite(contextScore)
      ? { contextScore: Math.max(0, contextScore) }
      : {}),
  };
}

function normalizeObservabilityPlanner(
  value: unknown,
): RepoReviewObservabilityPlannerSummary | undefined {
  const record = asRecord(value);
  const strategy = stringValue(record.strategy);
  if (!strategy) return undefined;
  const forcedSeedCount = numberValue(record.forcedSeedCount);
  const communityHintCount = numberValue(record.communityHintCount);
  const workerCount = numberValue(record.workerCount);
  const splitGroups = numberValue(record.splitGroups);
  return {
    strategy,
    ...(forcedSeedCount > 0 ? { forcedSeedCount } : {}),
    ...(communityHintCount > 0 ? { communityHintCount } : {}),
    ...(workerCount > 0 ? { workerCount } : {}),
    ...(splitGroups > 0 ? { splitGroups } : {}),
  };
}

function normalizeSummaryExecutionStats(
  value: unknown,
): Partial<RepoReviewExecutionStats> {
  const record = asRecord(value);
  const codeMapContextStatus = stringValue(record.codeMapContextStatus);
  const codeIndexContextStatus = stringValue(record.codeIndexContextStatus);
  const projectGraphConfidence = normalizeObservabilityConfidence(
    record.projectGraphConfidence,
  );
  const projectGraphPlanner = normalizeObservabilityPlanner(
    record.projectGraphPlanner,
  );
  return {
    diffFiles: numberValue(record.diffFiles),
    diffBytes: numberValue(record.diffBytes),
    splitGroups: numberValue(record.splitGroups),
    promptBytesBuilt: numberValue(record.promptBytesBuilt),
    modelCallCount: numberValue(record.modelCallCount),
    workerCount: numberValue(record.workerCount),
    completedWorkerCount: numberValue(record.completedWorkerCount),
    failedWorkerCount: numberValue(record.failedWorkerCount),
    timedOutWorkerCount: numberValue(record.timedOutWorkerCount),
    mainReadonlyToolCallCount: numberValue(record.mainReadonlyToolCallCount),
    subagentToolCallCount: numberValue(record.subagentToolCallCount),
    ...(codeMapContextStatus
      ? {
          codeMapContextStatus:
            codeMapContextStatus as RepoReviewExecutionStats['codeMapContextStatus'],
        }
      : {}),
    ...(codeIndexContextStatus
      ? {
          codeIndexContextStatus:
            codeIndexContextStatus as RepoReviewExecutionStats['codeIndexContextStatus'],
        }
      : {}),
    projectGraphNodeCount: numberValue(record.projectGraphNodeCount),
    projectGraphEdgeCount: numberValue(record.projectGraphEdgeCount),
    projectGraphSelectedFiles: normalizeStringArray(
      record.projectGraphSelectedFiles,
    ).slice(0, 50),
    ...(projectGraphConfidence ? { projectGraphConfidence } : {}),
    ...(projectGraphPlanner ? { projectGraphPlanner } : {}),
  };
}

function normalizeSummaryReviewProgress(
  value: unknown,
): RepoReviewProgressSnapshot | undefined {
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

function buildRepoReviewRunObservabilitySummary(input: {
  source: string;
  status: string;
  durationMs: number;
  diffBytes: number;
  changedFiles: string[];
  executionStats: Partial<RepoReviewExecutionStats>;
  reviewProgress?: RepoReviewProgressSnapshot;
}): RepoReviewRunObservabilitySummary {
  const stats = input.executionStats;
  const selectedFiles =
    stats.projectGraphSelectedFiles && stats.projectGraphSelectedFiles.length > 0
      ? stats.projectGraphSelectedFiles
      : input.changedFiles.slice(0, 50);
  const workerCount = numberValue(stats.workerCount);
  const splitGroups = numberValue(stats.splitGroups);
  const planner =
    stats.projectGraphPlanner ||
    (workerCount > 0 || splitGroups > 0
      ? ({
          strategy: workerCount > 0 ? 'worker' : 'direct',
          ...(workerCount > 0 ? { workerCount } : {}),
          ...(splitGroups > 0 ? { splitGroups } : {}),
        } satisfies RepoReviewObservabilityPlannerSummary)
      : undefined);
  return {
    source: input.source,
    kind: 'repo_review_run',
    status: input.status,
    durationMs: Math.max(0, input.durationMs),
    nodeCount: numberValue(stats.projectGraphNodeCount),
    edgeCount: numberValue(stats.projectGraphEdgeCount),
    selectedFileCount: selectedFiles.length,
    selectedFiles,
    ...(stats.projectGraphConfidence
      ? { confidence: stats.projectGraphConfidence }
      : {}),
    ...(planner ? { planner } : {}),
    metrics: {
      diffFiles:
        numberValue(stats.diffFiles) || Math.max(0, input.changedFiles.length),
      diffBytes: numberValue(stats.diffBytes) || Math.max(0, input.diffBytes),
      promptBytesBuilt: numberValue(stats.promptBytesBuilt),
      modelCallCount: numberValue(stats.modelCallCount),
      workerCount,
      completedWorkerCount: numberValue(stats.completedWorkerCount),
      failedWorkerCount: numberValue(stats.failedWorkerCount),
      timedOutWorkerCount: numberValue(stats.timedOutWorkerCount),
      readonlyToolCallCount:
        numberValue(stats.mainReadonlyToolCallCount) +
        numberValue(stats.subagentToolCallCount),
      progressStepCount: input.reviewProgress?.steps?.length || 0,
      ...(stats.codeMapContextStatus
        ? { codeMapContextStatus: stats.codeMapContextStatus }
        : {}),
      ...(stats.codeIndexContextStatus
        ? { codeIndexContextStatus: stats.codeIndexContextStatus }
        : {}),
    },
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
  const executionStats = normalizeSummaryExecutionStats(
    callbackContext?.executionStats,
  );
  const changedFiles = normalizeStringArray(parsed.changedFiles);
  const durationMs = Number(record.duration_ms || 0);
  const observability = buildRepoReviewRunObservabilitySummary({
    source: record.source,
    status: record.status,
    durationMs,
    diffBytes: record.diff_bytes,
    changedFiles,
    executionStats,
    reviewProgress,
  });

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
    observability,
    durationMs,
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

export async function listRepoReviewRepositorySummariesRead(
  userId?: string,
) {
  const repositoryRecords = userId
    ? await listReviewRepositoriesForUser(userId)
    : await listReviewRepositories();
  const profileCounts = new Map<string, number>();
  for (const profile of await listReviewProfiles()) {
    profileCounts.set(
      profile.repository_id,
      (profileCounts.get(profile.repository_id) || 0) + 1,
    );
  }
  return repositoryRecords.map((record) =>
    normalizeRepositorySummaryRecord(
      record,
      profileCounts.get(record.id) || 0,
    ),
  );
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
