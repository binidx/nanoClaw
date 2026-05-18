import path from 'path';

import type { RepoReviewCloudDocSection } from './repo-review-doc-render.js';
import type { RepoReviewDiffIndex } from './repo-review-diff-index.js';
import type { PreparedProjectGraphContext } from '../code-intelligence/project-graph-context.js';
import type {
  ReviewBlockingMode,
  ReviewOverall,
  ReviewRemoteProvider,
  ReviewScope,
  ReviewSourceMode,
  ReviewStage,
} from '../db.js';
import type { AgentTurnItemPayload } from '../agent/agent-runner.js';
import { t } from '../i18n/index.js';

export interface RepoReviewRepository {
  id: string;
  name: string;
  language: string;
  localRepoPath: string;
  remoteProvider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  reviewChatJid: string;
  actorMentionMappings: RepoReviewActorMentionMapping[];
  reviewerUsernames?: string[];
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  lastAutoSyncAt: string;
  nextAutoSyncAt: string;
  lastAutoSyncStatus: string;
  lastAutoSyncMessage: string;
  digestDailyEnabled: boolean;
  digestWeeklyEnabled: boolean;
  digestDailyHour: number;
  digestWeeklyDay: number;
  digestWeeklyHour: number;
  lastDigestDailyAt: string;
  nextDigestDailyAt: string;
  lastDigestWeeklyAt: string;
  nextDigestWeeklyAt: string;
  enabled: boolean;
  allowAiFix: boolean;
  hasWebhookSecret: boolean;
  hasPlatformToken: boolean;
  webhookSecretPreview?: string;
  platformTokenPreview?: string;
  webhookUrl?: string;
}

export interface RepoReviewRepositoryDetection {
  provider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  repositoryName: string;
  source: 'local_repo' | 'remote_url';
  detectedRemoteName: string;
  availableRemotes: RepoReviewRepositoryRemoteOption[];
  warnings: string[];
}

export interface RepoReviewRepositorySaveResult {
  repository: RepoReviewRepository;
  autoCreatedProfiles: RepoReviewProfile[];
  warnings: string[];
}

export interface RepoReviewRepositoryRemoteOption {
  remoteName: string;
  provider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  repositoryName: string;
}

export interface RepoReviewActorMentionMapping {
  actor: string;
  channel: 'feishu';
  id: string;
  name: string;
}

export function normalizeActorMentionKey(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function buildActorMentionLookupKeys(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const normalized = normalizeActorMentionKey(raw);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);

  const emailMatch = raw.match(
    /<?([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/,
  );
  if (emailMatch?.[1]) {
    keys.add(normalizeActorMentionKey(emailMatch[1]));
    keys.add(normalizeActorMentionKey(emailMatch[0]));
  }

  return Array.from(keys).filter(Boolean);
}

export function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function normalizeReviewerUsernames(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : [];
  const deduped = new Set<string>();
  for (const entry of rawValues) {
    const normalized = String(entry || '')
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return Array.from(deduped.values()).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

export function normalizeReviewerUsername(value: string): string {
  return stringValue(value).toLowerCase();
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function normalizeBranchName(value: string): string {
  return value.trim().replace(/^refs\/heads\//, '');
}

export function shortSha(value: string): string {
  return value ? value.slice(0, 12) : '';
}

export function buildRepoReviewReadOnlyAllowedDirectories(
  ...paths: Array<string | null | undefined>
): string[] {
  const directories = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = stringValue(value);
    if (!normalized) return;
    directories.add(path.resolve(normalized));
  };

  for (const value of paths) {
    add(value);
  }

  add(process.cwd());
  add(path.join(process.cwd(), 'data', 'review-workspaces'));

  return Array.from(directories.values()).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

export interface RepoReviewProfile {
  id: string;
  repositoryId: string;
  name: string;
  stage: ReviewStage;
  sourceMode: ReviewSourceMode;
  blockingMode: ReviewBlockingMode;
  passDecisionMode: 'ai' | 'human';
  reviewScope: ReviewScope;
  targetBranches: string[];
  skillIds: string[];
  mcpServerIds: string[];
  promptTemplate: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  includeFullFileContext: boolean;
  maxFiles: number;
  maxDiffBytes: number;
  writeToChat: boolean;
  writeToPlatform: boolean;
  reviewOutputMode: 'message' | 'share_link';
  diffSubagentThreshold: number;
  enabled: boolean;
  /** When set, review agent runs use this provider instead of the user's default. */
  provider_id?: string;
}

export interface RepoReviewRunFinding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: string;
  codeSnippet?: string;
  fixCode?: string;
  evidence?: string;
  evidenceKey?: string;
  codeSnippetSource?: 'model' | 'diff' | 'workspace' | 'unavailable';
  needsSnippetHydration?: boolean;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface RepoReviewFileReview {
  file: string;
  summary: string;
  positives?: string[];
  risks?: string[];
  suggestions?: string[];
}

export interface RepoReviewCommitReview {
  commit: string;
  title: string;
  author: string;
  positives: string[];
  issues: string[];
}

export interface RepoReviewSupplementalFileReviewResult {
  summary: string;
  findings: RepoReviewRunFinding[];
  suggestions: string[];
  scopeLimitations: string[];
  overallImpact: 'none' | 'warn' | 'fail';
  recommendedBlock: boolean;
}

export interface RepoReviewSupplementalPreparedFileTask {
  filePath: string;
  fileDiff: string;
  fileContent: string;
  relatedFindings: RepoReviewRunFinding[];
}

export type ReviewEvidenceContextStatusValue =
  | 'ready'
  | 'stale'
  | 'missing'
  | 'error';

export interface ReviewEvidenceContextStatus {
  status: ReviewEvidenceContextStatusValue;
  branch?: string;
  sourceBranch?: string;
  sourceHeadSha?: string;
  reason?: string;
  message?: string;
  fileCount?: number;
  functionCount?: number;
  edgeCount?: number;
}

export interface ReviewEvidenceChangedHunk {
  filePath: string;
  header: string;
  oldStart: number;
  oldLineCount: number;
  oldEnd: number;
  newStart: number;
  newLineCount: number;
  newEnd: number;
  addedLineNumbers: number[];
  removedLineNumbers: number[];
}

export interface ReviewEvidenceDiffSummary {
  fileCount: number;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
  diffBytes: number;
  files: Array<{
    filePath: string;
    addedLines: number;
    removedLines: number;
    hunkCount: number;
    estimatedBytes: number;
  }>;
}

export interface ReviewEvidenceImpactFunction {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  signature: string;
  startLine: number;
  endLine: number;
  line: number;
  parentFunctionId: string | null;
  changedHunkCount: number;
  changedLineNumbers: number[];
}

export interface ReviewEvidenceImpactEdge {
  direction: 'upstream' | 'downstream';
  fromFunctionId: string;
  toFunctionId: string;
  symbol: string;
  line: number;
  fromFunction?: Pick<
    ReviewEvidenceImpactFunction,
    'id' | 'filePath' | 'name' | 'kind' | 'startLine' | 'endLine'
  >;
  toFunction?: Pick<
    ReviewEvidenceImpactFunction,
    'id' | 'filePath' | 'name' | 'kind' | 'startLine' | 'endLine'
  >;
}

export interface ReviewEvidenceImpactFile {
  filePath: string;
  language: string;
  rank: number;
  lineCount: number;
  importCount: number;
  exportCount: number;
  dependentCount: number;
  dependencyCount: number;
  topSymbols: string[];
  changed: boolean;
  linkScore?: number;
  summary?: string;
}

export interface ReviewEvidenceImpactFileEdge {
  fromFile: string;
  toFile: string;
  symbols: string[];
}

export interface ReviewEvidenceBundle {
  diffSummary: ReviewEvidenceDiffSummary;
  changedFiles: string[];
  changedHunks: ReviewEvidenceChangedHunk[];
  changedFunctions: ReviewEvidenceImpactFunction[];
  projectGraphContext?: PreparedProjectGraphContext;
  impactGraph: {
    functions: ReviewEvidenceImpactFunction[];
    edges: ReviewEvidenceImpactEdge[];
  };
  fileImpact?: {
    changedFiles: ReviewEvidenceImpactFile[];
    relatedFiles: ReviewEvidenceImpactFile[];
    edges: ReviewEvidenceImpactFileEdge[];
  };
  codeMapStatus: ReviewEvidenceContextStatus;
  codeIndexStatus: ReviewEvidenceContextStatus;
  missingContext: string[];
}

export interface RepoReviewExecutionStats {
  diffFiles: number;
  diffBytes: number;
  splitGroups: number;
  peakReservedBytes: number;
  fullFileBytesLoaded: number;
  promptBytesBuilt: number;
  progressSnapshotBytes: number;
  extraRepoReadCount: number;
  fullFileBatchReservedBytes: number[];
  modelCallCount?: number;
  delegatedSubagentCount?: number;
  plannedSubagentCount?: number;
  totalReadBudgetBytes?: number;
  maxFullFileBytesPerFile?: number;
  extractorAttempts?: number;
  workerCount?: number;
  completedWorkerCount?: number;
  failedWorkerCount?: number;
  timedOutWorkerCount?: number;
  reducerCallCount?: number;
  evidenceBundleBytes?: number;
  codeMapContextStatus?: ReviewEvidenceContextStatusValue;
  codeIndexContextStatus?: ReviewEvidenceContextStatusValue;
  changedFunctionCount?: number;
  subagentToolCallCount?: number;
  mainReadonlyToolCallCount?: number;
  timeoutFollowupCount?: number;
  partialWorkerResultCount?: number;
  fallbackMainReviewCount?: number;
  fallbackReviewedFileCount?: number;
}

export interface RepoReviewProgressSnapshot {
  snapshotVersion?: number;
  heartbeatAt?: string;
  runTerminal?: boolean;
  turnCount: number;
  latestAssistantText: string;
  latestErrorText: string | null;
  hasTerminalOutput: boolean;
  steps?: RepoReviewProgressStep[];
}

export type RepoReviewProgressStepKind =
  | 'stage'
  | 'main'
  | 'subagent'
  | 'extractor'
  | 'formatter'
  | 'worker'
  | 'reducer';

export type RepoReviewTurnPhase =
  | 'worker'
  | 'timeout_followup'
  | 'main_agent_review'
  | 'main_agent_fallback_review'
  | 'reducer'
  | 'formatter';

export type RepoReviewTurnOwnerKind =
  | 'main'
  | 'subagent'
  | 'worker'
  | 'reducer'
  | 'formatter';

export interface RepoReviewProgressStep {
  id: string;
  label: string;
  kind?: RepoReviewProgressStepKind;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  activeStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
  inputText?: string;
  outputText?: string;
  metadataText?: string;
  error?: string;
}

export interface RepoReviewSupplementalExecutionResult {
  fileReview: RepoReviewFileReview | null;
  findings: RepoReviewRunFinding[];
  scopeLimitations: string[];
  suggestions: string[];
  recommendedBlock: boolean;
  overallImpact: RepoReviewSupplementalFileReviewResult['overallImpact'];
  failed: boolean;
}

export interface RepoReviewCommitInfo {
  commit: string;
  sha?: string;
  title: string;
  author: string;
  message: string;
  url?: string;
  timestamp?: string;
}

export interface RepoReviewBranchSummary {
  name: string;
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
  defaultBranch: boolean;
}

export function compareRepoReviewBranchSummaries(
  left: RepoReviewBranchSummary,
  right: RepoReviewBranchSummary,
): number {
  if (left.defaultBranch && !right.defaultBranch) return -1;
  if (!left.defaultBranch && right.defaultBranch) return 1;
  const leftTime = Date.parse(left.latestCommitAt);
  const rightTime = Date.parse(right.latestCommitAt);
  if (!Number.isNaN(leftTime) || !Number.isNaN(rightTime)) {
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    if (rightTime !== leftTime) return rightTime - leftTime;
  }
  return left.name.localeCompare(right.name, 'en');
}

export type RepoReviewBranchSummaryCacheEntry = {
  branches: RepoReviewBranchSummary[];
  fetchedAt: number;
  refreshPromise?: Promise<RepoReviewBranchSummary[]>;
};

export type LocalGitRemoteMetadataCacheEntry = {
  repoPath: string;
  remoteName: string;
  defaultBranch: string;
  fetchedAt: number;
};

export type LocalGitRemoteMetadataInput = {
  local_repo_path?: string | null;
  clone_url?: string | null;
  remote_provider?: ReviewRemoteProvider | '' | null;
  default_target_branch?: string | null;
};

export interface RepoReviewBranchTriggerResult {
  branch: string;
  headSha: string;
  status: 'triggered' | 'skipped' | 'error';
  reason: string;
  runId?: string;
}

export interface RepoReviewBranchTriggerSummary {
  branches: RepoReviewBranchTriggerResult[];
  triggered: number;
  skipped: number;
  failed: number;
  skippedReasons: Array<{
    reason: string;
    count: number;
  }>;
  errorReasons: Array<{
    reason: string;
    count: number;
  }>;
  activeWindowDays: number;
}

export interface RepoReviewProfileSaveResult {
  profile: RepoReviewProfile;
}

export interface RepoReviewRun {
  id: string;
  repositoryId: string;
  profileId: string;
  source: string;
  stage: ReviewStage;
  status: string;
  idempotencyKey?: string;
  overall: ReviewOverall | '';
  passDecisionMode: 'ai' | 'human';
  recommendedBlock: boolean;
  blockingEnforced: boolean;
  baselineSource?: string;
  baselineRef?: string;
  baselineLabel?: string;
  resultState?: string;
  ref: string;
  branch: string;
  baseSha: string;
  headSha: string;
  prMrNumber: string;
  actor: string;
  summary: string;
  findings: RepoReviewRunFinding[];
  fileReviews?: RepoReviewFileReview[];
  scopeLimitations: string[];
  reviewTurns: RepoReviewAssistantTurn[];
  reviewProgress?: RepoReviewProgressSnapshot;
  commitDetails: RepoReviewCommitInfo[];
  commitReviews: RepoReviewCommitReview[];
  suggestions: string[];
  changedFiles: string[];
  diffBytes: number;
  executionStats?: RepoReviewExecutionStats;
  durationMs?: number;
  platformStatus: string;
  chatDeliveryStatus?: string;
  platformStatusDeliveryStatus?: string;
  platformCommentDeliveryStatus?: string;
  platformCommentId?: string;
  platformCommentUrl: string;
  cloudDocToken?: string;
  cloudDocUrl?: string;
  cloudDocTitle?: string;
  cloudDocStatus?: string;
  cloudDocLastError?: string;
  lastDeliveryError?: string;
  deliveryRetryCount?: number;
  effectiveRules?: Record<string, unknown>;
  markdownBody?: string;
  rawModelOutput?: string;
  manualDecision: '' | 'pass' | 'fail';
  manualDecisionBy: string;
  manualDecisionAt: string;
  error: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type RepoReviewFeishuConversationType = 'group' | 'dm';

export interface RepoReviewCloudDocPrepareResult {
  documentId: string;
  title?: string;
  creationStatus?: string;
}

export interface RepoReviewCloudDocResult {
  documentId: string;
  url: string;
  title: string;
  conversationType: RepoReviewFeishuConversationType;
  creationStatus: string;
  populationStatus: string;
  resultStatus:
    | 'success'
    | 'success_with_authorization_warnings'
    | 'content_population_failed'
    | 'creation_failed'
    | 'url_resolution_failed';
  authorizationStrategy: string;
  authorizationStatus: 'complete' | 'partial' | 'failed' | 'skipped';
  authorizationWarnings: string[];
  targetResults: Array<{
    targetType: 'chat' | 'user';
    targetId: string;
    status: 'success' | 'failed';
    error?: string;
  }>;
  lastError?: string;
}

export interface RepoReviewCloudDocHandlers {
  prepareFeishuCloudDoc(input: {
    chatJid: string;
    title: string;
    conversationType: RepoReviewFeishuConversationType;
    idempotencyKey?: string;
  }): Promise<RepoReviewCloudDocPrepareResult>;
  continueFeishuCloudDocProvision(input: {
    chatJid: string;
    documentId: string;
    title: string;
    conversationType: RepoReviewFeishuConversationType;
    sections: RepoReviewCloudDocSection[];
    idempotencyKey?: string;
  }): Promise<RepoReviewCloudDocResult>;
}

export interface RepoReviewBranchState {
  repositoryId: string;
  stage: ReviewStage;
  branch: string;
  lastRunId: string;
  headSha: string;
  baselineSha: string;
  baselineSource: string;
  resultState: string;
  status: string;
  actor: string;
  summary: string;
  reviewedAt: string;
  updatedAt: string;
}

export interface RepoReviewRunDetail {
  run: RepoReviewRun;
  repository: RepoReviewRepository;
  profile: RepoReviewProfile | null;
  branchState: RepoReviewBranchState | null;
}

export interface RepoReviewDigestRun {
  id: string;
  repositoryId: string;
  type: 'daily' | 'weekly';
  status: string;
  timezone: string;
  scheduledFor: string;
  periodStart: string;
  periodEnd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  branchCount: number;
  commitCount: number;
  contributorCount: number;
  summary: string;
  cloudDocUrl: string;
  cloudDocStatus: string;
  deliveryStatus: string;
  deliveryError: string;
  errorMessage: string;
  createdAt: string;
}

export interface RepoReviewDigestRunDetail {
  run: RepoReviewDigestRun;
  repository: RepoReviewRepository;
}

export interface RepoReviewAssistantTurn {
  id: string;
  clientKey?: string;
  groupKey?: string;
  groupLabel?: string;
  parentToolCallId?: string;
  ownerKind?: RepoReviewTurnOwnerKind;
  ownerLabel?: string;
  phase?: RepoReviewTurnPhase;
  timestamp: string;
  items: AgentTurnItemPayload[];
  isLive: boolean;
  isCompleted: boolean;
  persistedMessageId?: string;
  error?: string;
}

export interface RepoReviewOverview {
  repositories: RepoReviewRepository[];
  profiles: RepoReviewProfile[];
  runs: RepoReviewRun[];
}

export interface RepoReviewChatMember {
  id: string;
  name: string;
  chatJid: string;
  source: string;
}

export interface RepoReviewEvent {
  source: 'local-hook' | 'github' | 'gitlab' | 'gitea';
  stage: ReviewStage;
  repositoryId: string;
  /** When set, agent runs use this tenant's provider configuration. */
  userId?: string;
  idempotencyKey?: string;
  ref?: string;
  branch?: string;
  baseSha?: string;
  headSha?: string;
  baselineSource?: string;
  prMrNumber?: string;
  actor?: string;
  blockingExpected: boolean;
  changedFiles?: string[];
  diffText?: string;
  callbackContext?: Record<string, unknown>;
  profileId?: string;
}

export type RepoReviewManualBaselineMode =
  | 'auto'
  | 'last_reviewed'
  | 'default_branch'
  | 'parent_commit'
  | 'history_run'
  | 'commit_sha';

export type RepoReviewManualReviewMode = 'incremental' | 'full';

export interface RepoReviewManualReviewOptions {
  baselineMode?: RepoReviewManualBaselineMode;
  baselineRunId?: string;
  baselineSha?: string;
  reviewMode?: RepoReviewManualReviewMode;
  allowRepeat?: boolean;
}

export function normalizeManualReviewBaselineMode(
  value: unknown,
): RepoReviewManualBaselineMode {
  const normalized = stringValue(value);
  if (
    normalized === 'last_reviewed' ||
    normalized === 'default_branch' ||
    normalized === 'parent_commit' ||
    normalized === 'history_run' ||
    normalized === 'commit_sha'
  ) {
    return normalized;
  }
  return 'auto';
}

export function normalizeManualReviewMode(
  value: unknown,
): RepoReviewManualReviewMode {
  return stringValue(value) === 'full' ? 'full' : 'incremental';
}

export function parseManualReviewOptions(
  callbackContext: Record<string, unknown> | null | undefined,
): RepoReviewManualReviewOptions {
  const record = asRecord(asRecord(callbackContext).manualReview);
  return {
    baselineMode: normalizeManualReviewBaselineMode(record.baselineMode),
    baselineRunId: stringValue(record.baselineRunId) || undefined,
    baselineSha: stringValue(record.baselineSha) || undefined,
    reviewMode: normalizeManualReviewMode(record.reviewMode),
    allowRepeat: normalizeBoolean(record.allowRepeat),
  };
}

export function buildManualReviewKey(
  options: RepoReviewManualReviewOptions | undefined,
  baseSha = '',
): string {
  const normalized = options || {};
  return [
    normalizeManualReviewBaselineMode(normalized.baselineMode),
    stringValue(normalized.baselineRunId) || 'none',
    stringValue(normalized.baselineSha) || 'no-sha',
    normalizeManualReviewMode(normalized.reviewMode),
    normalized.allowRepeat ? 'repeat' : 'once',
    stringValue(baseSha) || 'no-base',
  ].join(':');
}

export interface RepoReviewExecutionSummary {
  run: RepoReviewRun;
  allowed: boolean;
  blocking: boolean;
  reused?: boolean;
  reuseReason?: string;
  usedCachedBranchSummary?: boolean;
}

export interface RepoReviewRunSummaryFilters {
  repositoryId?: string;
  status?: string;
  keyword?: string;
  limit?: number;
}

export interface QueuedRepoReviewBranchResult {
  branch: string;
  headSha: string;
  status: 'triggered' | 'skipped' | 'error';
  reason: string;
  runId?: string;
  usedCachedBranchSummary?: boolean;
}

export interface QueuedRepoReviewBranchResultSummary {
  repository: RepoReviewRepository;
  provider: ReviewRemoteProvider;
  branches: QueuedRepoReviewBranchResult[];
  summary: RepoReviewBranchTriggerSummary;
}

export interface QueuedRepoReviewSingleBranchResult {
  queued: boolean;
  branch: string;
  headSha: string;
  reason: string;
  reused?: boolean;
  runId?: string;
  usedCachedBranchSummary?: boolean;
}

export interface RepoReviewQueueItem {
  runId: string;
  repositoryId: string;
  stage: ReviewStage;
  branch: string;
  headSha: string;
  baseSha: string;
  manualReviewKey: string;
}

export interface ReviewPreparedContext {
  diffText: string;
  diffIndex?: RepoReviewDiffIndex;
  changedFiles: string[];
  baseSha: string;
  headSha: string;
  branch: string;
  ref: string;
  actor: string;
  commitSummaryLines: string[];
  commitDetails: RepoReviewCommitInfo[];
  projectContextBlocks: string[];
  evidenceBundle?: ReviewEvidenceBundle;
  overall?: ReviewOverall;
  summary?: string;
}

export interface NormalizedScmConfig {
  provider: ReviewRemoteProvider;
  slug: string;
  token: string;
  apiBase: string;
}

export type RepoRemoteCandidate = {
  name: string;
  fetchUrl: string;
  provider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
};

export const REVIEW_STATUS_CONTEXT = 'nanoclaw-ai-review';
export const HOOK_MARKER_START = '# >>> nanoclaw repo review >>>';
export const HOOK_MARKER_END = '# <<< nanoclaw repo review <<<';
export const REPO_REVIEW_AUTO_SYNC_LOOP_INTERVAL_MS = 60_000;
export const REPO_REVIEW_ALL_BRANCHES_ACTIVE_WINDOW_DAYS = 14;
export const REPO_REVIEW_SYNC_PREPARATION_CONCURRENCY = 3;
export const REPO_REVIEW_FULL_FILE_REVIEW_CONCURRENCY = 4;
export const REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.NANOCLAW_REVIEW_CLONE_TIMEOUT_MS) || 120_000,
);
export const REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.NANOCLAW_REVIEW_GIT_TIMEOUT_MS) || 30_000,
);
export const REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH = 64;
export const REPO_REVIEW_PERMISSION_DENIED_MESSAGE = t(
  'errors.auto_398a59',
  {},
  undefined,
);
