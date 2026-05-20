import crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_TIMEOUT, DATA_DIR } from '../config.js';
import { isDuplicateKeyError } from '../db/sql-adapters.js';
import { loadCodeIndexReviewContextData } from '../db/code-index-db.js';
import { loadCodeMapFromDb } from '../code-intelligence/code-map-persist.js';
import {
  buildRepoReviewProjectGraphQuestion,
  filterPreparedProjectGraphContextForFiles,
  prepareProjectGraphContext,
} from '../code-intelligence/project-graph-context.js';

import {
  backfillConversationParticipantsFromMessages,
  listConversationParticipants,
  createReviewRun,
  deleteReviewConversationBindingByRepositoryId,
  deleteReviewRemoteBranchCache,
  deleteReviewProfile,
  deleteReviewRepository,
  getConversationSummaryByJid,
  getReviewBranchState,
  getReviewConversationBindingByChatJid,
  listReviewConversationBindingsByChatJid,
  getReviewProfileById,
  getReviewRemoteBranchCache,
  getReviewRepositoryById,
  getReviewRunById,
  getReviewRunByIdempotencyKey,
  getRegisteredGroup,
  listDueReviewRepositoriesForAutoSync,
  listMatchingReviewProfiles,
  listReviewBranchStates,
  listReviewProfiles,
  listReviewRepositories,
  listReviewRuns,
  listReviewRunsSummary,
  listActiveReviewRuns,
  parseReviewProfileRecord,
  parseReviewRemoteBranchCacheRecord,
  parseReviewRepositoryRecord,
  parseReviewRunRecord,
  saveReviewProfile,
  saveReviewConversationBinding,
  saveReviewRemoteBranchCache,
  saveReviewRepository,
  storeChatMetadata,
  storeMessageDirect,
  upsertReviewBranchState,
  upsertConversationParticipant,
  updateReviewRepositoryAutoSync,
  updateReviewRepositoryDigestTimestamps,
  updateConversationMeta,
  updateReviewRun,
  setReviewRunManualDecision,
  type ReviewBlockingMode,
  type ReviewBranchStateRecord,
  type ReviewDeliveryStatus,
  type ReviewOverall,
  type ReviewProfileRecord,
  type ReviewProfileUpsertInput,
  type ReviewRemoteProvider,
  type ReviewResultState,
  type ReviewRepositoryRecord,
  type ReviewRepositoryUpsertInput,
  type ReviewRunRecord,
  type ReviewRunUpdateInput,
  type ReviewScope,
  type ReviewSourceMode,
  type ReviewStage,
} from '../db.js';
import { isProviderVisibleToUser } from '../db/assistants.js';
import {
  requestAgentClose,
  runAgentProcess,
  sendAgentPrompt,
  type AgentRunInput,
  type AgentEventPayload,
  type AgentSubagentInfo,
  type AgentTurnEventPayload,
  type AgentTurnItemPayload,
} from '../agent/agent-runner.js';
import { listFeishuChatMembersByJid } from '../channels/feishu.js';
import { getWebChannel } from '../channels/web.js';
import { logger } from '../logger.js';
import {
  recordPromptTrace,
  resolvePromptText,
} from '../prompt/prompt-service.js';
import {
  REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE,
  REPO_REVIEW_AGENTIC_FINAL_TEMPLATE,
  REPO_REVIEW_AGENTIC_PLAN_TEMPLATE,
  REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE,
  REPO_REVIEW_DIFF_WORKER_TEMPLATE,
  REPO_REVIEW_PRIMARY_TEMPLATE,
  REPO_REVIEW_SPLIT_MAIN_TEMPLATE,
  REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE,
  REPO_REVIEW_SUPPLEMENTAL_ORCHESTRATOR_TEMPLATE,
} from './repo-review-prompt-templates.js';
import { REPO_REVIEW_AGENT_SYSTEM_PROMPT } from './repo-review-agent-system-prompt.js';
import {
  getAssistantName,
  getConfiguredChannelInstances,
  getConfigValue,
  getExternalBaseUrl,
  getShareBaseUrl,
} from '../config-store.js';
import { sanitizeTurnEventForWeb } from '../conversation/conversation-turn-visibility.js';
import {
  parseSubagentsConfig,
  WEB_SUBAGENTS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import type { RegisteredGroup, StructuredOutboundMessage } from '../types.js';
import { buildFeishuJid } from '../channels/feishu.js';
import {
  createRepoReviewExecutionQueue,
  executePreparedRepoReviewBranches,
  mapWithConcurrencyLimit,
} from './repo-review-sync-service.js';
import {
  estimateRepoReviewPayloadBytes,
  splitTasksByByteBudget,
} from './repo-review-budget.js';
import {
  buildRepoReviewDiffIndex,
  getRepoReviewDiffSlice,
  type RepoReviewDiffHunkEntry,
} from './repo-review-diff-index.js';
import {
  buildRepoReviewCloudDoc,
  buildRepoReviewFindingEvidenceKey,
  buildRepoReviewSummaryMessage,
  type RepoReviewCloudDocSection,
} from './repo-review-doc-render.js';
import { runRepoReviewGraphCoordinator } from './repo-review-coordinator.js';
import { computeNextDigestAt } from './repo-review-digest-service.js';
import { getProviderForModule } from '../tenant/tenant-db.js';
import { runWithTenant, SYSTEM_USER_ID } from '../tenant/tenant-context.js';

import type {
  RepoReviewRepository,
  RepoReviewRepositoryDetection,
  RepoReviewRepositorySaveResult,
  RepoReviewRepositoryRemoteOption,
  RepoReviewActorMentionMapping,
  RepoReviewProfile,
  RepoReviewRunFinding,
  RepoReviewFileReview,
  RepoReviewCommitReview,
  RepoReviewCommitInfo,
  RepoReviewBranchSummary,
  RepoReviewBranchTriggerResult,
  RepoReviewBranchTriggerSummary,
  RepoReviewProfileSaveResult,
  RepoReviewRun,
  RepoReviewCloudDocResult,
  RepoReviewBranchState,
  RepoReviewRunDetail,
  RepoReviewAssistantTurn,
  RepoReviewOverview,
  RepoReviewChatMember,
  RepoReviewEvent,
  RepoReviewExecutionStats,
  RepoReviewProgressSnapshot,
  RepoReviewProgressStep,
  RepoReviewProgressStepKind,
  RepoReviewExecutionSummary,
  RepoReviewRunSummaryFilters,
  QueuedRepoReviewBranchResult,
  QueuedRepoReviewBranchResultSummary,
  QueuedRepoReviewSingleBranchResult,
  ReviewEvidenceBundle,
  ReviewEvidenceChangedHunk,
  ReviewEvidenceContextStatus,
  ReviewEvidenceImpactFile,
  ReviewEvidenceImpactFunction,
} from './repo-review-model.js';
import type {
  CodeIndexFunctionEdgeRecord,
  CodeIndexFunctionRecord,
  CodeIndexSnapshot,
} from '../code-intelligence/code-index-types.js';
import type { CodeMapSnapshot } from '../code-intelligence/code-map-types.js';
import type {
  LocalGitRemoteMetadataCacheEntry,
  LocalGitRemoteMetadataInput,
  NormalizedScmConfig,
  RepoReviewBranchSummaryCacheEntry,
  RepoReviewCloudDocHandlers,
  RepoReviewCloudDocPrepareResult,
  RepoReviewFeishuConversationType,
  RepoReviewManualBaselineMode,
  RepoReviewManualReviewMode,
  RepoReviewManualReviewOptions,
  RepoReviewQueueItem,
  RepoReviewSupplementalExecutionResult,
  RepoReviewSupplementalFileReviewResult,
  RepoReviewSupplementalPreparedFileTask,
  RepoRemoteCandidate,
  ReviewPreparedContext,
} from './repo-review-model.js';
import {
  asRecord,
  buildActorMentionLookupKeys,
  buildRepoReviewReadOnlyAllowedDirectories,
  buildManualReviewKey,
  compareRepoReviewBranchSummaries,
  HOOK_MARKER_END,
  HOOK_MARKER_START,
  normalizeActorMentionKey,
  normalizeBoolean,
  normalizeBranchName,
  normalizeManualReviewBaselineMode,
  normalizeManualReviewMode,
  normalizeReviewerUsernames,
  normalizeReviewerUsername,
  parseManualReviewOptions,
  REPO_REVIEW_ALL_BRANCHES_ACTIVE_WINDOW_DAYS,
  REPO_REVIEW_AUTO_SYNC_LOOP_INTERVAL_MS,
  REPO_REVIEW_FULL_FILE_REVIEW_CONCURRENCY,
  REPO_REVIEW_PERMISSION_DENIED_MESSAGE,
  REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH,
  REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
  REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
  REPO_REVIEW_SYNC_PREPARATION_CONCURRENCY,
  REVIEW_STATUS_CONTEXT,
  shortSha,
  stringValue,
} from './repo-review-model.js';
import {
  buildHttpsCloneUrl,
  clearLocalGitRemoteMetadataCache,
  ensureRepositoryMirror,
  execFileAsync,
  getLocalGitRemoteMetadata,
  hasLocalGitRemoteAccess,
  listBranchesViaLsRemote,
  normalizeRemoteBaseUrlValue,
  normalizeRepoSlugValue,
  parseGitRemoteCandidates,
  parseRepositoryUrlCandidate,
  pickBestRemoteCandidate,
  prepareRemoteWorkspace,
  refreshRepositoryRemoteRefs,
  resolveRepositoryLocalRepoPath,
  resolveRepositoryRemoteName,
  runGitCommand,
  runGitCommandAsync,
  tryRecoverLocalMirror,
} from './repo-review-git.js';
import { acquireWorktree, listWorktrees } from '../agent/worktree-manager.js';
import {
  branchConclusionLine,
  buildStructuredRepoReviewMarkdown,
  formatRepoReviewCompletedMessage,
  formatRepoReviewManualDecisionMessage,
  formatRepoReviewMarkdownMessage,
  formatRepoReviewPlatformCommentMessage,
  formatRepoReviewShareLinkMessage,
  formatRepoReviewStartedMessage,
  overallLabel,
  resolveRepoReviewVisibleBody,
} from './repo-review-messages.js';
import { t } from '../i18n/index.js';

async function normalizeReviewChatJidInput(value: unknown): Promise<string> {
  const raw = stringValue(value);
  if (!raw) return '';
  if (!raw.startsWith('oc_')) return raw;

  const feishuInstances = (await getConfiguredChannelInstances()).filter(
    (entry) => entry.enabled && entry.type === 'feishu',
  );
  const defaultInstance = feishuInstances.find(
    (entry) => entry.id === 'default',
  );
  if (defaultInstance) {
    return buildFeishuJid(defaultInstance.id, raw);
  }
  if (feishuInstances.length === 1) {
    return buildFeishuJid(feishuInstances[0]!.id, raw);
  }
  if (feishuInstances.length === 0) {
    throw new Error(t('repoReview.auto_b5bd8e', {}, undefined));
  }
  throw new Error(t('repoReview.auto_1cf9c9', {}, undefined));
}

const STALE_REVIEW_RUN_GRACE_MS = Math.max(
  AGENT_TIMEOUT + 5 * 60_000,
  35 * 60_000,
);
const QUEUED_REMOTE_REVIEW_CONTEXT_KEY = 'queuedRemoteReview';
const REPO_REVIEW_CANCELLED_SUMMARY = 'Review execution cancelled.';
const repoReviewCancellationRequestedRunIds = new Set<string>();
const REMOTE_PROJECT_CONTEXT_CANDIDATES = [
  'AGENTS.md',
  '.nanoclaw/review.md',
  '.nanoclaw/review.txt',
  'README.md',
  'package.json',
  'pnpm-workspace.yaml',
  'pom.xml',
  'build.gradle',
  'go.mod',
  'Cargo.toml',
];

const REPO_REVIEW_GROUP_MAX_WEIGHT = 20_000;
const REPO_REVIEW_GROUP_DEFAULT_MAX_COUNT = 4;
// Repo review subagents each spawn a full agent-runner Node process that
// drives its own LLM turns + tool calls. Running the global subagent cap (4)
// concurrently for review tends to saturate small hosts. Allow operators to
// cap review fan-out lower via env without touching the global cap.
const REPO_REVIEW_SUBAGENT_CEILING = (() => {
  const parsed = Number.parseInt(
    process.env.NANOCLAW_REPO_REVIEW_MAX_SUBAGENTS || '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();
const REPO_REVIEW_FULL_FILE_BATCH_MAX_BYTES = Math.max(
  32_000,
  Number(process.env.NANOCLAW_REVIEW_FULL_FILE_BATCH_MAX_BYTES) || 120_000,
);
const REPO_REVIEW_AGENTIC_DEFAULT_MAX_SUBAGENTS = 2;
const REPO_REVIEW_AGENTIC_DEFAULT_MAX_FULL_FILE_BYTES_PER_FILE = Math.max(
  16_000,
  Number(process.env.NANOCLAW_REVIEW_MAX_FULL_FILE_BYTES_PER_FILE) || 64_000,
);
const REPO_REVIEW_AGENTIC_DEFAULT_MAX_TOTAL_READ_BYTES = Math.max(
  64_000,
  Number(process.env.NANOCLAW_REVIEW_MAX_TOTAL_READ_BYTES) || 240_000,
);
const REPO_REVIEW_AGENTIC_MAX_REVIEW_ROUNDS = Math.max(
  2,
  Number(process.env.NANOCLAW_REVIEW_MAX_REVIEW_ROUNDS) || 2,
);
const REPO_REVIEW_SUBAGENT_RESULT_MAX_CHARS = Math.max(
  8_000,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_RESULT_MAX_CHARS) || 60_000,
);
const REPO_REVIEW_SUBAGENT_PROMPT_PREVIEW_MAX_CHARS = Math.max(
  800,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_PROMPT_PREVIEW_MAX_CHARS) ||
    2_400,
);
const REPO_REVIEW_AGENTIC_SUBAGENT_DIFF_MAX_CHARS = Math.max(
  8_000,
  Number(process.env.NANOCLAW_REVIEW_AGENTIC_SUBAGENT_DIFF_MAX_CHARS) || 16_000,
);
const REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS = Math.max(
  1_200,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS) || 4_000,
);
const REPO_REVIEW_SUBAGENT_TIMEOUT_MS = Math.max(
  50,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS) || 420_000,
);
const REPO_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS = Math.max(
  25,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS) || 20_000,
);

function resolveRepoReviewProfileSubagentTimeoutMs(
  profile: Pick<RepoReviewProfile, 'subagentTimeoutSeconds'>,
): number {
  const seconds = Math.max(
    30,
    Math.trunc(
      Number(profile.subagentTimeoutSeconds) ||
        Math.trunc(REPO_REVIEW_SUBAGENT_TIMEOUT_MS / 1000),
    ),
  );
  return seconds * 1000;
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

async function resolveRepoReviewMaxSubagents(): Promise<number> {
  const raw = await getConfigValue(WEB_SUBAGENTS_CONFIG_KEY);
  const config = parseSubagentsConfig(raw ?? undefined);
  const base = config.enabled
    ? config.maxActive
    : REPO_REVIEW_GROUP_DEFAULT_MAX_COUNT;
  // When an operator has set NANOCLAW_REPO_REVIEW_MAX_SUBAGENTS, clamp the
  // review-specific fan-out below the global subagent budget without
  // lowering it for non-review flows.
  if (REPO_REVIEW_SUBAGENT_CEILING) {
    return Math.max(1, Math.min(base, REPO_REVIEW_SUBAGENT_CEILING));
  }
  return Math.max(1, base);
}

export function groupFilesForReview(
  tasks: RepoReviewSupplementalPreparedFileTask[],
  maxGroups: number = REPO_REVIEW_GROUP_DEFAULT_MAX_COUNT,
): RepoReviewSupplementalPreparedFileTask[][] {
  if (tasks.length === 0) return [];
  const effectiveMax = Math.max(1, Math.min(maxGroups, tasks.length));
  if (tasks.length <= effectiveMax) {
    return tasks.map((t) => [t]);
  }
  // In lean-prompt mode, fileContent / fileDiff are empty strings (the
  // subagent reads the file itself via tools), so byte-weight would be 0 for
  // every task. Fall back to "count each task as 1" so the bin-packing
  // spreads work evenly across groups instead of dumping everything into
  // group[0] (the previous tie-breaker kept the first group because
  // `g.weight < lightest.weight` is false when both sides are 0).
  const byteWeight = (t: RepoReviewSupplementalPreparedFileTask) =>
    (t.fileContent?.length || 0) + (t.fileDiff?.length || 0);
  const hasByteWeight = tasks.some((t) => byteWeight(t) > 0);
  const weight = hasByteWeight
    ? byteWeight
    : (_t: RepoReviewSupplementalPreparedFileTask) => 1;
  const sorted = [...tasks].sort((a, b) => {
    const communityCompare = String(a.communityLabel || a.communityId || '').localeCompare(
      String(b.communityLabel || b.communityId || ''),
      'en',
    );
    if (communityCompare !== 0) return communityCompare;
    return weight(b) - weight(a);
  });
  const groups = sorted
    .slice(0, effectiveMax)
    .map((t) => ({ tasks: [t], weight: weight(t) }));
  for (const task of sorted.slice(effectiveMax)) {
    let lightest = groups[0]!;
    const preferred = groups.find((group) =>
      group.tasks.some(
        (entry) =>
          entry.communityId &&
          entry.communityId === task.communityId,
      ),
    );
    if (preferred) {
      preferred.tasks.push(task);
      preferred.weight += weight(task);
      continue;
    }
    for (const g of groups) {
      if (g.weight < lightest.weight) lightest = g;
    }
    lightest.tasks.push(task);
    lightest.weight += weight(task);
  }
  return groups.map((g) => g.tasks);
}

function getRepoReviewUtf8Bytes(value: string): number {
  return Buffer.byteLength(value || '', 'utf8');
}

function getRepoReviewJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

function collectRepoReviewProjectGraphSelectedFiles(
  context: ReviewEvidenceBundle['projectGraphContext'] | undefined,
  fallbackFiles: string[],
): string[] {
  if (!context || context.status !== 'ready') return fallbackFiles.slice(0, 50);
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const node of [
    ...context.startNodes,
    ...context.topFiles,
    ...context.topFunctions,
    ...context.topChunks,
  ]) {
    const filePath = stringValue(node.filePath);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    selected.push(filePath);
  }
  for (const filePath of fallbackFiles) {
    const normalized = stringValue(filePath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push(normalized);
  }
  return selected.slice(0, 50);
}

export function getRepoReviewProjectGraphFileCommunity(input: {
  prepared: ReviewPreparedContext;
  filePath: string;
}): { communityId?: string; communityLabel?: string } {
  const context = input.prepared.evidenceBundle?.projectGraphContext;
  if (!context || context.status !== 'ready') return {};
  const candidates = [
    ...context.startNodes,
    ...context.topFiles,
    ...context.topFunctions,
    ...context.topChunks,
  ].filter((node) => node.filePath === input.filePath && node.community);
  const communityId = candidates[0]?.community;
  if (!communityId) return {};
  return {
    communityId,
    communityLabel: candidates[0]?.communityLabel || communityId,
  };
}

function buildInitialRepoReviewExecutionStats(input: {
  diffText: string;
  changedFiles: string[];
  evidenceBundle?: ReviewEvidenceBundle;
}): RepoReviewExecutionStats {
  const projectGraphContext = input.evidenceBundle?.projectGraphContext;
  return {
    diffFiles: input.changedFiles.length,
    diffBytes: getRepoReviewUtf8Bytes(input.diffText),
    splitGroups: 0,
    peakReservedBytes: 0,
    fullFileBytesLoaded: 0,
    promptBytesBuilt: 0,
    progressSnapshotBytes: 0,
    extraRepoReadCount: 0,
    fullFileBatchReservedBytes: [],
    modelCallCount: 0,
    delegatedSubagentCount: 0,
    plannedSubagentCount: 0,
    totalReadBudgetBytes: REPO_REVIEW_AGENTIC_DEFAULT_MAX_TOTAL_READ_BYTES,
    maxFullFileBytesPerFile:
      REPO_REVIEW_AGENTIC_DEFAULT_MAX_FULL_FILE_BYTES_PER_FILE,
    extractorAttempts: 0,
    timeoutFollowupCount: 0,
    partialWorkerResultCount: 0,
    fallbackMainReviewCount: 0,
    fallbackReviewedFileCount: 0,
    subagentToolCallCount: 0,
    mainReadonlyToolCallCount: 0,
    ...(input.evidenceBundle
      ? {
          evidenceBundleBytes: getRepoReviewJsonBytes(input.evidenceBundle),
          codeMapContextStatus: input.evidenceBundle.codeMapStatus.status,
          codeIndexContextStatus: input.evidenceBundle.codeIndexStatus.status,
          changedFunctionCount: input.evidenceBundle.changedFunctions.length,
          projectGraphNodeCount:
            projectGraphContext?.status === 'ready'
              ? projectGraphContext.nodeCount
              : 0,
          projectGraphEdgeCount:
            projectGraphContext?.status === 'ready'
              ? projectGraphContext.edgeCount
              : 0,
          projectGraphSelectedFiles: collectRepoReviewProjectGraphSelectedFiles(
            projectGraphContext,
            input.changedFiles,
          ),
          ...(projectGraphContext?.status === 'ready'
            ? {
                projectGraphConfidence: projectGraphContext.confidence,
                projectGraphPlanner: projectGraphContext.planner,
                ...(projectGraphContext.artifact?.id
                  ? { projectGraphArtifactId: projectGraphContext.artifact.id }
                  : {}),
              }
            : {}),
        }
      : {
          evidenceBundleBytes: 0,
          changedFunctionCount: 0,
          projectGraphNodeCount: 0,
          projectGraphEdgeCount: 0,
          projectGraphSelectedFiles: input.changedFiles.slice(0, 50),
        }),
  };
}

function recordRepoReviewPromptBytes(
  stats: RepoReviewExecutionStats | undefined,
  prompt: string,
): void {
  if (!stats) return;
  stats.promptBytesBuilt = Math.max(
    stats.promptBytesBuilt,
    getRepoReviewUtf8Bytes(prompt),
  );
}

function countRepoReviewToolCalls(
  turns: RepoReviewAssistantTurn[],
  title: string,
): number {
  let count = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (
        item.type === 'tool_call' &&
        stringValue(item.title).toLowerCase() === title.toLowerCase()
      ) {
        count += 1;
      }
    }
  }
  return count;
}

function normalizeRepoReviewPathValue(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
}

function parseRepoReviewToolCallArgs(
  rawArgs: string,
): Record<string, unknown> | null {
  const text = stringValue(rawArgs);
  if (!text) return null;
  try {
    return JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractRepoReviewReadTargetsFromToolCall(
  item: RepoReviewAssistantTurn['items'][number],
): string[] {
  if (item.type !== 'tool_call') return [];
  const title = stringValue(item.title).toLowerCase();
  const rawArgs = stringValue(item.argumentsText);
  if (!rawArgs) return [];
  const toPaths = (value: unknown): string[] => {
    if (typeof value === 'string') {
      const normalized = normalizeRepoReviewPathValue(value);
      return normalized ? [normalized] : [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((entry) => toPaths(entry));
    }
    return [];
  };
  if (title === 'read_file') {
    const parsed = parseRepoReviewToolCallArgs(rawArgs);
    if (parsed) {
      return [
        ...toPaths(parsed.path),
        ...toPaths(parsed.file),
        ...toPaths(parsed.filePath),
        ...toPaths(parsed.files),
      ];
    }
    return [];
  }
  return [];
}

function extractRepoReviewShellCommand(
  item: RepoReviewAssistantTurn['items'][number],
): string {
  if (item.type !== 'tool_call') return '';
  const title = stringValue(item.title).toLowerCase();
  if (
    title !== 'bash' &&
    title !== 'shell' &&
    title !== 'terminal' &&
    title !== 'exec_command'
  ) {
    return '';
  }
  const parsed = parseRepoReviewToolCallArgs(item.argumentsText || '');
  if (parsed) {
    return stringValue(parsed.cmd || parsed.command || parsed.argv);
  }
  return stringValue(item.argumentsText);
}

function isRepoReviewReadonlyEvidenceToolCall(
  item: RepoReviewAssistantTurn['items'][number],
): boolean {
  if (item.type !== 'tool_call') return false;
  const title = stringValue(item.title).toLowerCase();
  if (
    title === 'read_file' ||
    title === 'rg' ||
    title === 'grep' ||
    title === 'glob' ||
    title === 'find' ||
    title === 'ls'
  ) {
    return true;
  }
  const shellCommand = extractRepoReviewShellCommand(item);
  if (!shellCommand) return false;
  return /(^|\s)(git\s+(diff|show|log)|rg\b|grep\b|sed\b|nl\b|wc\b|cat\b|head\b|tail\b|find\b|ls\b)/i.test(
    shellCommand,
  );
}

function countRepoReviewReadonlyEvidenceToolCalls(
  turns: RepoReviewAssistantTurn[],
): number {
  let count = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      if (isRepoReviewReadonlyEvidenceToolCall(item)) {
        count += 1;
      }
    }
  }
  return count;
}

function countRepoReviewOutOfScopeReads(
  turns: RepoReviewAssistantTurn[],
  allowedFiles: string[],
): number {
  const allowed = allowedFiles.map(normalizeRepoReviewPathValue);
  let count = 0;
  for (const turn of turns) {
    for (const item of turn.items) {
      const targets = extractRepoReviewReadTargetsFromToolCall(item);
      for (const target of targets) {
        const normalized = normalizeRepoReviewPathValue(target);
        if (!normalized) continue;
        const isAllowed = allowed.some(
          (file) =>
            normalized === file ||
            normalized.endsWith(`/${file}`) ||
            file.endsWith(`/${normalized}`),
        );
        if (!isAllowed) count += 1;
      }
    }
  }
  return count;
}

function recordRepoReviewFullFileBatchStats<
  T extends { estimatedBytes: number },
>(stats: RepoReviewExecutionStats | undefined, taskGroups: T[][]): void {
  if (!stats || taskGroups.length === 0) return;
  const batchBytes = taskGroups.map((group) =>
    group.reduce((total, task) => total + Math.max(0, task.estimatedBytes), 0),
  );
  stats.fullFileBatchReservedBytes = batchBytes;
  stats.splitGroups = Math.max(stats.splitGroups, taskGroups.length);
  const peakBatchBytes = Math.max(...batchBytes);
  stats.peakReservedBytes = Math.max(stats.peakReservedBytes, peakBatchBytes);
}

function normalizeReviewEvidenceStatusValue(
  value: unknown,
): RepoReviewExecutionStats['codeMapContextStatus'] {
  const normalized = stringValue(value);
  return normalized === 'ready' ||
    normalized === 'stale' ||
    normalized === 'missing' ||
    normalized === 'error'
    ? normalized
    : undefined;
}

function normalizeRepoReviewObservabilityConfidence(
  value: unknown,
): RepoReviewExecutionStats['projectGraphConfidence'] {
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

function normalizeRepoReviewObservabilityPlanner(
  value: unknown,
): RepoReviewExecutionStats['projectGraphPlanner'] {
  const record = asRecord(value);
  const strategy = stringValue(record.strategy);
  if (!strategy) return undefined;
  const forcedSeedCount = Number(record.forcedSeedCount);
  const communityHintCount = Number(record.communityHintCount);
  const workerCount = Number(record.workerCount);
  const splitGroups = Number(record.splitGroups);
  return {
    strategy,
    ...(Number.isFinite(forcedSeedCount)
      ? { forcedSeedCount: Math.max(0, forcedSeedCount) }
      : {}),
    ...(Number.isFinite(communityHintCount)
      ? { communityHintCount: Math.max(0, communityHintCount) }
      : {}),
    ...(Number.isFinite(workerCount)
      ? { workerCount: Math.max(0, workerCount) }
      : {}),
    ...(Number.isFinite(splitGroups)
      ? { splitGroups: Math.max(0, splitGroups) }
      : {}),
  };
}

function normalizeRepoReviewExecutionStats(
  value: unknown,
): RepoReviewExecutionStats | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const fullFileBatchReservedBytes = Array.isArray(
    record.fullFileBatchReservedBytes,
  )
    ? record.fullFileBatchReservedBytes
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry) && entry >= 0)
    : [];
  return {
    diffFiles: Math.max(0, Number(record.diffFiles) || 0),
    diffBytes: Math.max(0, Number(record.diffBytes) || 0),
    splitGroups: Math.max(0, Number(record.splitGroups) || 0),
    peakReservedBytes: Math.max(0, Number(record.peakReservedBytes) || 0),
    fullFileBytesLoaded: Math.max(0, Number(record.fullFileBytesLoaded) || 0),
    promptBytesBuilt: Math.max(0, Number(record.promptBytesBuilt) || 0),
    progressSnapshotBytes: Math.max(
      0,
      Number(record.progressSnapshotBytes) || 0,
    ),
    extraRepoReadCount: Math.max(0, Number(record.extraRepoReadCount) || 0),
    fullFileBatchReservedBytes,
    modelCallCount: Math.max(0, Number(record.modelCallCount) || 0),
    delegatedSubagentCount: Math.max(
      0,
      Number(record.delegatedSubagentCount) || 0,
    ),
    plannedSubagentCount: Math.max(0, Number(record.plannedSubagentCount) || 0),
    totalReadBudgetBytes: Math.max(0, Number(record.totalReadBudgetBytes) || 0),
    maxFullFileBytesPerFile: Math.max(
      0,
      Number(record.maxFullFileBytesPerFile) || 0,
    ),
    extractorAttempts: Math.max(0, Number(record.extractorAttempts) || 0),
    workerCount: Math.max(0, Number(record.workerCount) || 0),
    completedWorkerCount: Math.max(0, Number(record.completedWorkerCount) || 0),
    failedWorkerCount: Math.max(0, Number(record.failedWorkerCount) || 0),
    timedOutWorkerCount: Math.max(0, Number(record.timedOutWorkerCount) || 0),
    reducerCallCount: Math.max(0, Number(record.reducerCallCount) || 0),
    evidenceBundleBytes: Math.max(0, Number(record.evidenceBundleBytes) || 0),
    codeMapContextStatus: normalizeReviewEvidenceStatusValue(
      record.codeMapContextStatus,
    ),
    codeIndexContextStatus: normalizeReviewEvidenceStatusValue(
      record.codeIndexContextStatus,
    ),
    changedFunctionCount: Math.max(0, Number(record.changedFunctionCount) || 0),
    subagentToolCallCount: Math.max(
      0,
      Number(record.subagentToolCallCount) || 0,
    ),
    mainReadonlyToolCallCount: Math.max(
      0,
      Number(record.mainReadonlyToolCallCount) || 0,
    ),
    timeoutFollowupCount: Math.max(0, Number(record.timeoutFollowupCount) || 0),
    partialWorkerResultCount: Math.max(
      0,
      Number(record.partialWorkerResultCount) || 0,
    ),
    fallbackMainReviewCount: Math.max(
      0,
      Number(record.fallbackMainReviewCount) || 0,
    ),
    fallbackReviewedFileCount: Math.max(
      0,
      Number(record.fallbackReviewedFileCount) || 0,
    ),
    projectGraphNodeCount: Math.max(
      0,
      Number(record.projectGraphNodeCount) || 0,
    ),
    projectGraphEdgeCount: Math.max(
      0,
      Number(record.projectGraphEdgeCount) || 0,
    ),
    projectGraphSelectedFiles: normalizeStringArray(
      record.projectGraphSelectedFiles,
    ).slice(0, 50),
    projectGraphConfidence: normalizeRepoReviewObservabilityConfidence(
      record.projectGraphConfidence,
    ),
    projectGraphPlanner: normalizeRepoReviewObservabilityPlanner(
      record.projectGraphPlanner,
    ),
    projectGraphArtifactId: stringValue(record.projectGraphArtifactId) || undefined,
  };
}

function normalizeRepoReviewProgressSnapshot(
  value: unknown,
): RepoReviewProgressSnapshot | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  const latestErrorText = stringValue(record.latestErrorText);
  const steps = normalizeRepoReviewProgressSteps(record.steps);
  return {
    snapshotVersion:
      Math.max(0, Number(record.snapshotVersion) || 0) || undefined,
    heartbeatAt: stringValue(record.heartbeatAt) || undefined,
    runTerminal: Boolean(record.runTerminal),
    turnCount: Math.max(0, Number(record.turnCount) || 0),
    latestAssistantText: stringValue(record.latestAssistantText),
    latestErrorText: latestErrorText || null,
    hasTerminalOutput: Boolean(record.hasTerminalOutput),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

function normalizeRepoReviewProgressStepKind(
  value: unknown,
): RepoReviewProgressStepKind | undefined {
  const kind = stringValue(value);
  if (
    kind === 'stage' ||
    kind === 'main' ||
    kind === 'subagent' ||
    kind === 'extractor' ||
    kind === 'worker' ||
    kind === 'reducer'
  ) {
    return kind;
  }
  return undefined;
}

function normalizeRepoReviewProgressStepStatus(
  value: unknown,
): RepoReviewProgressStep['status'] {
  const status = stringValue(value);
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'skipped'
  ) {
    return status;
  }
  return 'running';
}

function normalizeRepoReviewProgressSteps(
  value: unknown,
): RepoReviewProgressStep[] {
  if (!Array.isArray(value)) return [];
  const steps: RepoReviewProgressStep[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    const id = stringValue(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = stringValue(record.label) || id;
    const kind = normalizeRepoReviewProgressStepKind(record.kind);
    const startedAt = stringValue(record.startedAt);
    const activeStartedAt = stringValue(record.activeStartedAt);
    const completedAt = stringValue(record.completedAt);
    const durationMs = Math.max(0, Number(record.durationMs) || 0);
    steps.push({
      id,
      label,
      ...(kind ? { kind } : {}),
      status: normalizeRepoReviewProgressStepStatus(record.status),
      startedAt,
      ...(activeStartedAt ? { activeStartedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(stringValue(record.detail)
        ? { detail: stringValue(record.detail) }
        : {}),
      ...(stringValue(record.inputText)
        ? { inputText: stringValue(record.inputText) }
        : {}),
      ...(stringValue(record.outputText)
        ? { outputText: stringValue(record.outputText) }
        : {}),
      ...(stringValue(record.metadataText)
        ? { metadataText: stringValue(record.metadataText) }
        : {}),
      ...(stringValue(record.error)
        ? { error: stringValue(record.error) }
        : {}),
    });
  }
  return steps;
}

let repoReviewMessageSender:
  | ((jid: string, message: StructuredOutboundMessage) => Promise<void>)
  | null = null;
let repoReviewCloudDocHandlersForTests: RepoReviewCloudDocHandlers | null =
  null;
let repoReviewAutoSyncLoopStarted = false;
let repoReviewAutoSyncTimerHandle: ReturnType<typeof setTimeout> | null = null;
let repoReviewStartupRecoveryApplied = false;
const REPO_REVIEW_PROCESS_STARTED_AT = new Date().toISOString();
const repoReviewAutoSyncInFlight = new Set<string>();

function slugifyId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 48) || crypto.randomUUID().slice(0, 8);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = stringValue(entry);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
    if (normalized.length >= 200) break;
  }
  return normalized;
}

function normalizeCommitInfoArray(value: unknown): RepoReviewCommitInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry),
    )
    .map((entry) => {
      const sha =
        stringValue(entry.sha || entry.fullSha || entry.full_sha) ||
        (/^[0-9a-f]{12,40}$/i.test(stringValue(entry.commit))
          ? stringValue(entry.commit)
          : '');
      return {
        commit: shortSha(stringValue(entry.commit || sha)),
        sha: sha || undefined,
        title:
          stringValue(entry.title) ||
          t('repoReview.auto_f38c68', {}, undefined),
        author: stringValue(entry.author),
        message: stringValue(entry.message),
        url: stringValue(entry.url) || undefined,
        timestamp: stringValue(entry.timestamp) || undefined,
      };
    })
    .filter((entry) => entry.commit || entry.title);
}

function normalizeActorMentionMappings(
  value: unknown,
): RepoReviewActorMentionMapping[] {
  if (!Array.isArray(value)) return [];
  const normalized: RepoReviewActorMentionMapping[] = [];
  const seenActors = new Set<string>();
  for (const rawEntry of value) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const actor = normalizeActorMentionKey(stringValue(entry.actor));
    const id = stringValue(entry.id || entry.openId || entry.open_id);
    if (!actor || !id || seenActors.has(actor)) continue;
    seenActors.add(actor);
    normalized.push({
      actor,
      channel: 'feishu',
      id,
      name:
        stringValue(entry.name || entry.displayName || entry.display_name) ||
        actor,
    });
    if (normalized.length >= 200) break;
  }
  return normalized;
}

function parseActorMentionMappingsJson(
  raw: string | null | undefined,
): RepoReviewActorMentionMapping[] {
  if (!raw) return [];
  try {
    return normalizeActorMentionMappings(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function buildRepositoryRemoteOption(
  repoPath: string,
  remote: RepoRemoteCandidate,
): RepoReviewRepositoryRemoteOption {
  const defaultRemoteBranch = runGitCommand(
    repoPath,
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote.name}/HEAD`],
    true,
  ).replace(`${remote.name}/`, '');
  const currentBranch = runGitCommand(
    repoPath,
    ['branch', '--show-current'],
    true,
  );
  const repositoryName = path.basename(repoPath);

  return {
    remoteName: remote.name,
    provider: remote.provider,
    remoteRepoSlug: remote.remoteRepoSlug,
    remoteBaseUrl: remote.remoteBaseUrl,
    cloneUrl: remote.cloneUrl,
    defaultTargetBranch: defaultRemoteBranch || currentBranch || 'main',
    repositoryName,
  };
}

function readLocalRepositoryDetection(input: {
  localRepoPath: string;
  providerHint?: ReviewRemoteProvider | '';
  remoteName?: string;
}): RepoReviewRepositoryDetection {
  const repoPath = input.localRepoPath.trim();
  if (!repoPath) {
    throw new Error(t('repoReview.auto_2faa3c', {}, undefined));
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(
      t('repoReview.localRepoPathNotFound', { repoPath }, undefined),
    );
  }

  const remotesText = runGitCommand(repoPath, ['remote', '-v'], true);
  const remoteCandidates = parseGitRemoteCandidates(
    remotesText,
    input.providerHint,
  );
  const explicitRemote = input.remoteName
    ? remoteCandidates.find((candidate) => candidate.name === input.remoteName)
    : null;
  const remote =
    explicitRemote ||
    pickBestRemoteCandidate(remoteCandidates, input.providerHint);
  if (!remote) {
    throw new Error(t('repoReview.auto_bcfadf', {}, undefined));
  }
  const remoteOptions = remoteCandidates
    .map((candidate) => buildRepositoryRemoteOption(repoPath, candidate))
    .sort((left, right) => {
      if (left.remoteName === remote.name) return -1;
      if (right.remoteName === remote.name) return 1;
      if (left.remoteName === 'origin') return -1;
      if (right.remoteName === 'origin') return 1;
      if (left.remoteName === 'company') return -1;
      if (right.remoteName === 'company') return 1;
      return left.remoteName.localeCompare(right.remoteName);
    });
  const selectedRemote = remoteOptions.find(
    (candidate) => candidate.remoteName === remote.name,
  );
  if (!selectedRemote) {
    throw new Error(t('repoReview.auto_307814', {}, undefined));
  }
  const multipleRemotes = remoteOptions.length > 1;

  return {
    provider: selectedRemote.provider || input.providerHint || '',
    remoteRepoSlug: selectedRemote.remoteRepoSlug,
    remoteBaseUrl: selectedRemote.remoteBaseUrl,
    cloneUrl: selectedRemote.cloneUrl,
    defaultTargetBranch: selectedRemote.defaultTargetBranch,
    repositoryName: selectedRemote.repositoryName,
    source: 'local_repo',
    detectedRemoteName: remote.name,
    availableRemotes: remoteOptions,
    warnings: inferDetectionWarnings({
      provider: selectedRemote.provider,
      providerHint: input.providerHint,
      cloneUrl: selectedRemote.cloneUrl,
      warnings: [
        ...(selectedRemote.provider || input.providerHint
          ? []
          : [t('repoReview.auto_b58d2c', {}, undefined)]),
        ...(multipleRemotes && !explicitRemote
          ? [
              t(
                'repoReview.multipleGitRemotesHint',
                { remoteName: remote.name },
                undefined,
              ),
            ]
          : []),
      ],
    }),
  };
}

function inferRepositoryNameFromSlug(slug: string): string {
  const normalized = normalizeRepoSlugValue(slug);
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || '';
}

function inferDetectionWarnings(input: {
  provider: ReviewRemoteProvider | '';
  providerHint?: ReviewRemoteProvider | '';
  cloneUrl: string;
  warnings: string[];
}): string[] {
  const warnings = [...input.warnings];
  if (!input.provider && !input.providerHint) {
    warnings.push(t('repoReview.auto_67b495', {}, undefined));
  }
  if (/^[^@]+@[^:]+:.+/i.test(input.cloneUrl.trim())) {
    warnings.push(t('repoReview.auto_dd0ec9', {}, undefined));
  }
  return warnings;
}

function detectRepositoryFromRemoteUrl(input: {
  remoteUrl: string;
  providerHint?: ReviewRemoteProvider | '';
}): RepoReviewRepositoryDetection {
  const parsed = parseRepositoryUrlCandidate(
    input.remoteUrl,
    input.providerHint,
  );
  if (!parsed) {
    throw new Error(t('repoReview.auto_badad6', {}, undefined));
  }
  return {
    provider: parsed.provider || input.providerHint || '',
    remoteRepoSlug: parsed.remoteRepoSlug,
    remoteBaseUrl: parsed.remoteBaseUrl,
    cloneUrl: parsed.cloneUrl,
    defaultTargetBranch: '',
    repositoryName: inferRepositoryNameFromSlug(parsed.remoteRepoSlug),
    source: 'remote_url',
    detectedRemoteName: '',
    availableRemotes: [],
    warnings: inferDetectionWarnings({
      provider: parsed.provider,
      providerHint: input.providerHint,
      cloneUrl: parsed.cloneUrl,
      warnings: [],
    }),
  };
}

function sanitizeDetectedRemoteFields(input: {
  provider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  warnings: string[];
}): {
  provider: ReviewRemoteProvider | '';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  warnings: string[];
} {
  const parsedFromBase = parseRepositoryUrlCandidate(
    input.remoteBaseUrl,
    input.provider,
  );
  let remoteBaseUrl = normalizeRemoteBaseUrlValue(input.remoteBaseUrl);
  let remoteRepoSlug = normalizeRepoSlugValue(input.remoteRepoSlug);
  let provider = input.provider;
  let cloneUrl = input.cloneUrl.trim();
  const warnings = [...input.warnings];

  if (parsedFromBase?.remoteRepoSlug) {
    if (!remoteRepoSlug) {
      remoteRepoSlug = parsedFromBase.remoteRepoSlug;
    }
    remoteBaseUrl = parsedFromBase.remoteBaseUrl;
    provider = provider || parsedFromBase.provider;
    warnings.push(t('repoReview.auto_3134d3', {}, undefined));
  }

  const parsedFromClone = parseRepositoryUrlCandidate(cloneUrl, provider);
  if (parsedFromClone) {
    provider = provider || parsedFromClone.provider;
    if (!remoteRepoSlug) {
      remoteRepoSlug = parsedFromClone.remoteRepoSlug;
    }
    if (!remoteBaseUrl) {
      remoteBaseUrl = parsedFromClone.remoteBaseUrl;
    }
  }

  return {
    provider,
    remoteRepoSlug,
    remoteBaseUrl,
    cloneUrl,
    defaultTargetBranch: input.defaultTargetBranch.trim(),
    warnings,
  };
}

async function buildWebhookUrl(
  repositoryId: string,
  provider: string,
): Promise<string | undefined> {
  if (!provider) return undefined;
  const base = await getExternalBaseUrl();
  return `${base}/webhooks/repo-reviews/${provider}/${repositoryId}`;
}

async function normalizeRepositoryRecord(
  record: ReviewRepositoryRecord,
): Promise<RepoReviewRepository> {
  const parsed = await parseReviewRepositoryRecord(record);
  const provider = record.remote_provider || '';
  return {
    id: record.id,
    name: record.name,
    language: record.language || '',
    localRepoPath: record.local_repo_path || '',
    remoteProvider: provider,
    remoteRepoSlug: record.remote_repo_slug || '',
    remoteBaseUrl: record.remote_base_url || '',
    cloneUrl: record.clone_url || '',
    defaultTargetBranch: record.default_target_branch || '',
    reviewChatJid: record.review_chat_jid || `repo-review:${record.id}`,
    actorMentionMappings: normalizeActorMentionMappings(
      parsed.actorMentionMappings,
    ),
    reviewerUsernames: parsed.reviewerUsernames,
    autoSyncEnabled: record.auto_sync_enabled === 1,
    autoSyncIntervalMinutes: normalizeInteger(
      record.auto_sync_interval_minutes,
      30,
      5,
      1440,
    ),
    lastAutoSyncAt: record.last_auto_sync_at || '',
    nextAutoSyncAt: record.next_auto_sync_at || '',
    lastAutoSyncStatus: record.last_auto_sync_status || '',
    lastAutoSyncMessage: record.last_auto_sync_message || '',
    digestDailyEnabled: record.digest_daily_enabled === 1,
    digestWeeklyEnabled: record.digest_weekly_enabled === 1,
    digestDailyHour: normalizeInteger(record.digest_daily_hour, 18, 0, 23),
    digestWeeklyDay: normalizeInteger(record.digest_weekly_day, 5, 1, 7),
    digestWeeklyHour: normalizeInteger(record.digest_weekly_hour, 18, 0, 23),
    lastDigestDailyAt: record.last_digest_daily_at || '',
    nextDigestDailyAt: record.next_digest_daily_at || '',
    lastDigestWeeklyAt: record.last_digest_weekly_at || '',
    nextDigestWeeklyAt: record.next_digest_weekly_at || '',
    enabled: record.enabled === 1,
    allowAiFix: record.allow_ai_fix === 1,
    hasWebhookSecret: Boolean(record.webhook_secret),
    hasPlatformToken: Boolean(record.platform_token),
    webhookSecretPreview: maskSensitivePreview(record.webhook_secret || ''),
    platformTokenPreview: maskSensitivePreview(record.platform_token || ''),
    webhookUrl: await buildWebhookUrl(record.id, provider),
    ...(record.ssh_key_id ? { sshKeyId: record.ssh_key_id } : {}),
  };
}

export async function normalizeRepoReviewRepositoryRecord(
  record: ReviewRepositoryRecord,
): Promise<RepoReviewRepository> {
  return normalizeRepositoryRecord(record);
}

function maskSensitivePreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 4) return `${trimmed[0] || ''}***`;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
  }
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

async function normalizeProfileRecord(
  record: ReviewProfileRecord,
): Promise<RepoReviewProfile> {
  const parsed = await parseReviewProfileRecord(record);
  const providerId = stringValue(record.provider_id);
  return {
    id: record.id,
    repositoryId: record.repository_id,
    name: record.name,
    stage: record.stage,
    sourceMode: record.source_mode,
    blockingMode: record.blocking_mode,
    passDecisionMode: record.pass_decision_mode === 'human' ? 'human' : 'ai',
    reviewScope: record.review_scope,
    targetBranches: parsed.targetBranches,
    skillIds: parsed.skillIds,
    mcpServerIds: parsed.mcpServerIds,
    promptTemplate: record.prompt_template || '',
    includeGlobs: parsed.includeGlobs,
    excludeGlobs: parsed.excludeGlobs,
    includeFullFileContext: parsed.includeFullFileContext,
    maxFiles: record.max_files,
    maxDiffBytes: record.max_diff_bytes,
    writeToChat: parsed.writeToChat,
    writeToPlatform: parsed.writeToPlatform,
    reviewOutputMode: normalizeReviewOutputMode(record.review_output_mode),
    diffSubagentThreshold: record.diff_subagent_threshold ?? 15,
    subagentTimeoutSeconds:
      record.subagent_timeout_seconds ??
      Math.max(
        1,
        Math.trunc(
          (Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS) ||
            Number(process.env.NANOCLAW_REVIEW_WORKER_TIMEOUT_MS) ||
            420_000) / 1000,
        ),
      ),
    enabled: parsed.enabledBool,
    ...(providerId ? { provider_id: providerId } : {}),
  };
}

async function resolveReviewProviderOverrideId(input: {
  profile: RepoReviewProfile;
  repository: RepoReviewRepository;
  runId: string;
  userId?: string;
}): Promise<string | undefined> {
  let profileProviderId = stringValue(input.profile.provider_id);
  if (profileProviderId) {
    if (input.userId) {
      const visible = await isProviderVisibleToUser(
        profileProviderId,
        input.userId,
      );
      if (!visible) {
        logger.warn(
          {
            providerId: profileProviderId,
            userId: input.userId,
            repositoryId: input.repository.id,
            runId: input.runId,
          },
          'Review profile provider override not visible to user; ignoring',
        );
        profileProviderId = '';
      }
    } else {
      logger.debug(
        { providerId: profileProviderId, runId: input.runId },
        'Review run has no userId; skipping profile provider override for safety',
      );
      profileProviderId = '';
    }
  }
  if (profileProviderId) return profileProviderId;

  const moduleProvider = await getProviderForModule(
    'code_review',
    input.userId,
  );
  return stringValue(moduleProvider?.id) || undefined;
}

function normalizeReviewOutputMode(value: unknown): 'message' | 'share_link' {
  const str = String(value || '').trim();
  if (str === 'message') return 'message';
  return 'share_link';
}

async function normalizeRunRecord(
  record: ReviewRunRecord,
  profileHint?: ReviewProfileRecord | null,
): Promise<RepoReviewRun> {
  const parsed = await parseReviewRunRecord(record);
  const commitDetails = normalizeCommitInfoArray(
    asRecord(parsed.callbackContext).commitDetails,
  );
  const scopeLimitations = normalizeReviewScopeLimitations(
    asRecord(parsed.callbackContext).scopeLimitations,
  );
  const baselineRef = stringValue(asRecord(parsed.callbackContext).baselineRef);
  const baselineLabel = stringValue(
    asRecord(parsed.callbackContext).baselineLabel,
  );
  const reviewTurns = normalizeReviewTurns(
    asRecord(parsed.callbackContext).reviewTurns,
  );
  const reviewProgress = normalizeRepoReviewProgressSnapshot(
    asRecord(parsed.callbackContext).reviewProgress,
  );
  const executionStats = normalizeRepoReviewExecutionStats(
    asRecord(parsed.callbackContext).executionStats,
  );
  // Use the caller-provided profile when available to avoid an N+1 DB lookup
  // per run in list contexts. Falls back to a direct lookup for single-run use.
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
    baselineRef,
    baselineLabel,
    resultState: record.result_state || '',
    ref: record.ref || '',
    branch: record.branch || '',
    baseSha: record.base_sha || '',
    headSha: record.head_sha || '',
    prMrNumber: record.pr_mr_number || '',
    actor: record.actor || '',
    summary: normalizeLegacyRepoReviewText(record.summary),
    findings: parsed.findings as RepoReviewRunFinding[],
    fileReviews: parsed.fileReviews as RepoReviewFileReview[],
    scopeLimitations,
    reviewTurns,
    reviewProgress,
    commitDetails,
    commitReviews: parsed.commitReviews as RepoReviewCommitReview[],
    suggestions: parsed.suggestions,
    changedFiles: parsed.changedFiles,
    diffBytes: record.diff_bytes,
    executionStats,
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
    effectiveRules: parsed.effectiveRules,
    markdownBody: record.markdown_body || '',
    rawModelOutput: record.raw_model_output || '',
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

export async function normalizeRepoReviewRunRecord(
  record: ReviewRunRecord,
): Promise<RepoReviewRun> {
  return normalizeRunRecord(record);
}

function normalizeBranchStateRecord(
  record: ReviewBranchStateRecord,
): RepoReviewBranchState {
  return {
    repositoryId: record.repository_id,
    stage: record.stage,
    branch: record.branch,
    lastRunId: record.last_run_id || '',
    headSha: record.head_sha || '',
    baselineSha: record.baseline_sha || '',
    baselineSource: record.baseline_source || '',
    resultState: record.result_state || '',
    status: record.status || '',
    actor: record.actor || '',
    summary: normalizeLegacyRepoReviewText(record.summary),
    reviewedAt: record.reviewed_at || '',
    updatedAt: record.updated_at,
  };
}

function normalizeReviewTurnItem(item: unknown): AgentTurnItemPayload | null {
  const record = asRecord(item);
  const type = stringValue(record.type);
  const id = stringValue(record.id);
  const timestamp = stringValue(record.timestamp);
  const status = stringValue(record.status);
  if (!id || !timestamp) return null;
  if (
    status !== 'in_progress' &&
    status !== 'completed' &&
    status !== 'failed'
  ) {
    return null;
  }
  if (type === 'reasoning') {
    return {
      id,
      type,
      status,
      title:
        stringValue(record.title) || t('repoReview.auto_5d459d', {}, undefined),
      text: stringValue(record.text),
      timestamp,
    };
  }
  if (type === 'tool_call') {
    const rawSubagentInfo = asRecord(record.subagentInfo);
    const subagentStatus = stringValue(rawSubagentInfo?.status);
    let subagentInfo: AgentSubagentInfo | undefined;
    if (
      rawSubagentInfo &&
      stringValue(rawSubagentInfo.agentName) &&
      (subagentStatus === 'spawning' ||
        subagentStatus === 'idle' ||
        subagentStatus === 'running' ||
        subagentStatus === 'stopping' ||
        subagentStatus === 'completed' ||
        subagentStatus === 'failed' ||
        subagentStatus === 'stopped')
    ) {
      subagentInfo = {
        agentName:
          stringValue(rawSubagentInfo.agentName) ||
          t('errors.auto_6cb1ed', {}, undefined),
        runtimeId: stringValue(rawSubagentInfo.runtimeId),
        provider: stringValue(rawSubagentInfo.provider),
        mode:
          stringValue(rawSubagentInfo.mode) === 'agent' ||
          stringValue(rawSubagentInfo.mode) === 'team'
            ? (stringValue(rawSubagentInfo.mode) as 'agent' | 'team')
            : undefined,
        runtimeKind:
          stringValue(rawSubagentInfo.runtimeKind) === 'managed_run' ||
          stringValue(rawSubagentInfo.runtimeKind) === 'managed_session' ||
          stringValue(rawSubagentInfo.runtimeKind) === 'ephemeral_snapshot'
            ? (stringValue(rawSubagentInfo.runtimeKind) as
                | 'managed_run'
                | 'managed_session'
                | 'ephemeral_snapshot')
            : undefined,
        providerSessionId: stringValue(rawSubagentInfo.providerSessionId),
        parentRuntimeId: stringValue(rawSubagentInfo.parentRuntimeId),
        controllerSessionKey: stringValue(rawSubagentInfo.controllerSessionKey),
        requesterSessionKey: stringValue(rawSubagentInfo.requesterSessionKey),
        originTurnId: stringValue(rawSubagentInfo.originTurnId),
        originToolCallId: stringValue(rawSubagentInfo.originToolCallId),
        topologyRole:
          stringValue(rawSubagentInfo.topologyRole) === 'main' ||
          stringValue(rawSubagentInfo.topologyRole) === 'orchestrator' ||
          stringValue(rawSubagentInfo.topologyRole) === 'leaf'
            ? (stringValue(rawSubagentInfo.topologyRole) as
                | 'main'
                | 'orchestrator'
                | 'leaf')
            : stringValue(rawSubagentInfo.role) === 'main' ||
                stringValue(rawSubagentInfo.role) === 'orchestrator' ||
                stringValue(rawSubagentInfo.role) === 'leaf'
              ? (stringValue(rawSubagentInfo.role) as
                  | 'main'
                  | 'orchestrator'
                  | 'leaf')
              : undefined,
        workProfile:
          stringValue(rawSubagentInfo.workProfile) === 'explorer' ||
          stringValue(rawSubagentInfo.workProfile) === 'worker'
            ? (stringValue(rawSubagentInfo.workProfile) as
                | 'explorer'
                | 'worker')
            : undefined,
        role:
          stringValue(rawSubagentInfo.role) === 'main' ||
          stringValue(rawSubagentInfo.role) === 'orchestrator' ||
          stringValue(rawSubagentInfo.role) === 'leaf'
            ? (stringValue(rawSubagentInfo.role) as
                | 'main'
                | 'orchestrator'
                | 'leaf')
            : undefined,
        controlScope:
          stringValue(rawSubagentInfo.controlScope) === 'children' ||
          stringValue(rawSubagentInfo.controlScope) === 'none'
            ? (stringValue(rawSubagentInfo.controlScope) as 'children' | 'none')
            : undefined,
        depth:
          typeof rawSubagentInfo.depth === 'number' &&
          Number.isFinite(rawSubagentInfo.depth)
            ? rawSubagentInfo.depth
            : undefined,
        chatJid: stringValue(rawSubagentInfo.chatJid),
        requestCount:
          typeof rawSubagentInfo.requestCount === 'number' &&
          Number.isFinite(rawSubagentInfo.requestCount)
            ? rawSubagentInfo.requestCount
            : undefined,
        controllable:
          typeof rawSubagentInfo.controllable === 'boolean'
            ? rawSubagentInfo.controllable
            : undefined,
        task: stringValue(rawSubagentInfo.task),
        status: subagentStatus,
      };
    }
    return {
      id,
      type,
      status,
      title:
        stringValue(record.title) || t('repoReview.auto_850b4e', {}, undefined),
      argumentsText: stringValue(record.argumentsText),
      resultText: stringValue(record.resultText),
      errorText: stringValue(record.errorText),
      subagentInfo,
      startedAt: stringValue(record.startedAt) || undefined,
      completedAt: stringValue(record.completedAt) || undefined,
      timestamp,
    };
  }
  if (type === 'assistant_message' && status !== 'failed') {
    const text = stringValue(record.text);
    return {
      id,
      type,
      status,
      text: text ? formatVisibleRepoReviewAssistantMessage(text) : '',
      timestamp,
    };
  }
  return null;
}

function normalizeReviewTurns(value: unknown): RepoReviewAssistantTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: RepoReviewAssistantTurn[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = stringValue(record.id);
    const timestamp = stringValue(record.timestamp);
    if (!id || !timestamp) continue;
    const items = Array.isArray(record.items)
      ? record.items
          .map((item) => normalizeReviewTurnItem(item))
          .filter((item): item is AgentTurnItemPayload => Boolean(item))
      : [];
    const rawPhase = stringValue(record.phase);
    const phase =
      rawPhase === 'worker' ||
      rawPhase === 'timeout_followup' ||
      rawPhase === 'main_agent_review' ||
      rawPhase === 'main_agent_fallback_review' ||
      rawPhase === 'reducer' ||
      rawPhase === 'formatter'
        ? rawPhase
        : undefined;
    const rawOwnerKind = stringValue(record.ownerKind);
    const ownerKind =
      rawOwnerKind === 'main' ||
      rawOwnerKind === 'subagent' ||
      rawOwnerKind === 'worker' ||
      rawOwnerKind === 'reducer' ||
      rawOwnerKind === 'formatter'
        ? rawOwnerKind
        : undefined;
    turns.push({
      id,
      clientKey: stringValue(record.clientKey) || undefined,
      groupKey: stringValue(record.groupKey) || undefined,
      groupLabel: stringValue(record.groupLabel) || undefined,
      parentToolCallId: stringValue(record.parentToolCallId) || undefined,
      ownerKind,
      ownerLabel: stringValue(record.ownerLabel) || undefined,
      phase,
      timestamp,
      items,
      isLive: normalizeBoolean(record.isLive),
      isCompleted: normalizeBoolean(record.isCompleted),
      persistedMessageId: stringValue(record.persistedMessageId) || undefined,
      error: stringValue(record.error) || undefined,
    });
  }
  return turns;
}

function upsertReviewTurn(
  turns: RepoReviewAssistantTurn[],
  turnId: string,
  timestamp: string,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index === -1) {
    return [
      ...turns,
      {
        id: turnId,
        clientKey: turnId,
        timestamp,
        items: [],
        isLive: true,
        isCompleted: false,
        ...(context
          ? {
              groupKey: context.groupKey,
              groupLabel: context.groupLabel,
              phase: context.phase,
              parentToolCallId: context.parentToolCallId,
              ownerKind: context.ownerKind,
              ownerLabel: context.ownerLabel,
            }
          : {}),
      },
    ];
  }
  const next = [...turns];
  next[index] = {
    ...next[index],
    timestamp,
    isLive: true,
    ...(context
      ? {
          groupKey: next[index]?.groupKey || context.groupKey,
          groupLabel: next[index]?.groupLabel || context.groupLabel,
          phase: next[index]?.phase || context.phase,
          parentToolCallId:
            next[index]?.parentToolCallId || context.parentToolCallId,
          ownerKind: next[index]?.ownerKind || context.ownerKind,
          ownerLabel: next[index]?.ownerLabel || context.ownerLabel,
        }
      : {}),
  };
  return next;
}

function upsertReviewTurnItem(
  turns: RepoReviewAssistantTurn[],
  event: Extract<
    AgentTurnEventPayload,
    { type: 'item.started' | 'item.updated' | 'item.completed' }
  >,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const next = upsertReviewTurn(turns, event.turnId, event.timestamp, context);
  const index = next.findIndex((turn) => turn.id === event.turnId);
  if (index < 0) return next;
  const turn = next[index];
  const itemIndex = turn.items.findIndex((item) => item.id === event.item.id);
  const items = [...turn.items];
  if (itemIndex >= 0) {
    items[itemIndex] = { ...items[itemIndex], ...event.item };
  } else {
    items.push(event.item);
  }
  next[index] = {
    ...turn,
    timestamp: event.timestamp || event.item.timestamp,
    items,
    isLive:
      event.type !== 'item.completed' ||
      event.item.type !== 'assistant_message' ||
      event.item.status === 'in_progress',
    ...(context
      ? {
          groupKey: turn.groupKey || context.groupKey,
          groupLabel: turn.groupLabel || context.groupLabel,
          phase: turn.phase || context.phase,
          parentToolCallId: turn.parentToolCallId || context.parentToolCallId,
          ownerKind: turn.ownerKind || context.ownerKind,
          ownerLabel: turn.ownerLabel || context.ownerLabel,
        }
      : {}),
  };
  return next;
}

function markReviewTurnCompleted(
  turns: RepoReviewAssistantTurn[],
  turnId: string,
  timestamp: string,
  error?: string,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const next = upsertReviewTurn(turns, turnId, timestamp, context);
  const index = next.findIndex((turn) => turn.id === turnId);
  if (index < 0) return next;
  next[index] = {
    ...next[index],
    timestamp,
    isLive: false,
    isCompleted: true,
    error,
    ...(context
      ? {
          groupKey: next[index]?.groupKey || context.groupKey,
          groupLabel: next[index]?.groupLabel || context.groupLabel,
          phase: next[index]?.phase || context.phase,
          parentToolCallId:
            next[index]?.parentToolCallId || context.parentToolCallId,
          ownerKind: next[index]?.ownerKind || context.ownerKind,
          ownerLabel: next[index]?.ownerLabel || context.ownerLabel,
        }
      : {}),
  };
  return next;
}

function extractLatestCompletedAssistantMessageText(
  turns: RepoReviewAssistantTurn[],
): string {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    for (
      let itemIndex = turn.items.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const item = turn.items[itemIndex];
      if (item.type !== 'assistant_message') continue;
      if (item.status !== 'completed') continue;
      const text = item.text.trim();
      if (text) return text;
    }
  }
  return '';
}

function isStructuredRepoReviewAssistantMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(extractJsonObject(trimmed)) as Record<
      string,
      unknown
    >;
    const reviewPlan = asRecord(parsed.review_plan || parsed.reviewPlan);
    if (Object.keys(reviewPlan).length > 0) return true;
    return Boolean(
      Array.isArray(parsed.checked_files) ||
        Array.isArray(parsed.checkedFiles) ||
        Array.isArray(parsed.findings) ||
        stringValue(parsed.summary) ||
        stringValue(parsed.overall) ||
        stringValue(parsed.result_type || parsed.resultType) ||
        normalizeBoolean(parsed.final),
    );
  } catch {
    return false;
  }
}

function extractLatestProgressAssistantMessageText(
  turns: RepoReviewAssistantTurn[],
): string {
  const completed = extractLatestCompletedAssistantMessageText(turns);
  if (completed) return completed;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    for (
      let itemIndex = turn.items.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const item = turn.items[itemIndex];
      if (item.type !== 'assistant_message') continue;
      if (item.status !== 'in_progress') continue;
      if (!item.text.trim()) continue;
      if (!isStructuredRepoReviewAssistantMessage(item.text)) continue;
      return item.text.trim();
    }
  }
  return '';
}

function buildIntermediateRepoReviewProgressTurns(
  turns: RepoReviewAssistantTurn[],
): RepoReviewAssistantTurn[] {
  return turns
    .map((turn) => {
      const items = turn.items.filter((item) => {
        if (item.type === 'assistant_message') {
          if (!item.text.trim()) return false;
          if (item.status === 'completed') {
            return true;
          }
          return (
            item.status === 'in_progress' &&
            isStructuredRepoReviewAssistantMessage(item.text)
          );
        }
        if (item.type === 'tool_call') {
          return item.status === 'completed' || item.status === 'failed';
        }
        return false;
      });
      if (items.length === 0 && !turn.error?.trim()) return null;
      return {
        ...turn,
        items,
      };
    })
    .filter((turn): turn is RepoReviewAssistantTurn => Boolean(turn));
}

function extractLatestRepoReviewTurnErrorText(
  turns: RepoReviewAssistantTurn[],
): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (turn.error?.trim()) return turn.error.trim();
    for (
      let itemIndex = turn.items.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const item = turn.items[itemIndex];
      if (item.status !== 'failed') continue;
      const text =
        ('text' in item ? stringValue(item.text) : '') ||
        ('resultText' in item ? stringValue(item.resultText) : '') ||
        stringValue(item.title);
      if (text) return text;
    }
  }
  return null;
}

function buildRepoReviewProgressSnapshot(
  turns: RepoReviewAssistantTurn[],
  steps: RepoReviewProgressStep[] = [],
  options: { runTerminal?: boolean } = {},
): RepoReviewProgressSnapshot {
  const latestAssistantText = extractLatestProgressAssistantMessageText(turns);
  return {
    snapshotVersion: 1,
    heartbeatAt: new Date().toISOString(),
    runTerminal: Boolean(options.runTerminal),
    turnCount: turns.length,
    latestAssistantText: latestAssistantText
      ? formatVisibleRepoReviewAssistantMessage(latestAssistantText)
      : '',
    latestErrorText: extractLatestRepoReviewTurnErrorText(turns),
    hasTerminalOutput: turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.status === 'completed' ||
          item.status === 'failed' ||
          (item.type === 'assistant_message' &&
            item.status === 'in_progress' &&
            isStructuredRepoReviewAssistantMessage(item.text)),
      ),
    ),
    ...(steps.length > 0 ? { steps } : {}),
  };
}

function upsertRepoReviewProgressStep(
  steps: RepoReviewProgressStep[],
  input: {
    id: string;
    label: string;
    kind?: RepoReviewProgressStepKind;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
    now?: string;
  },
): RepoReviewProgressStep[] {
  const now = input.now || new Date().toISOString();
  const existingIndex = steps.findIndex((step) => step.id === input.id);
  const existing = existingIndex >= 0 ? steps[existingIndex]! : null;
  const existingTerminal =
    existing?.status === 'completed' ||
    existing?.status === 'failed' ||
    existing?.status === 'skipped';
  const incomingTerminal =
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'skipped';
  const nextStatus =
    existingTerminal && !incomingTerminal ? existing.status : input.status;
  const startedAt = existing?.startedAt || now;
  const activeStartedAt =
    existing?.activeStartedAt || (nextStatus === 'running' ? now : undefined);
  const terminal =
    nextStatus === 'completed' ||
    nextStatus === 'failed' ||
    nextStatus === 'skipped';
  const completedAt = terminal ? now : existing?.completedAt;
  const durationMs =
    completedAt && activeStartedAt
      ? Math.max(0, Date.parse(completedAt) - Date.parse(activeStartedAt))
      : existing?.durationMs;
  const next: RepoReviewProgressStep = {
    id: input.id,
    label: input.label,
    kind: input.kind || existing?.kind,
    status: nextStatus,
    startedAt,
    ...(activeStartedAt ? { activeStartedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.detail || existing?.detail
      ? { detail: input.detail || existing?.detail || '' }
      : {}),
    ...(input.inputText || existing?.inputText
      ? { inputText: input.inputText || existing?.inputText || '' }
      : {}),
    ...(input.outputText || existing?.outputText
      ? { outputText: input.outputText || existing?.outputText || '' }
      : {}),
    ...(input.metadataText || existing?.metadataText
      ? { metadataText: input.metadataText || existing?.metadataText || '' }
      : {}),
    ...(input.error || existing?.error
      ? { error: input.error || existing?.error || '' }
      : {}),
  };
  if (existingIndex < 0) return [...steps, next];
  const copy = [...steps];
  copy[existingIndex] = next;
  return copy;
}

function repairTerminalRepoReviewProgressSteps(
  steps: RepoReviewProgressStep[],
  terminalStatus: 'completed' | 'failed' | 'skipped',
  error?: string,
): RepoReviewProgressStep[] {
  let next = steps;
  for (const step of steps) {
    if (step.status !== 'running' && step.status !== 'queued') continue;
    next = upsertRepoReviewProgressStep(next, {
      id: step.id,
      label: step.label,
      kind: step.kind,
      status: terminalStatus === 'completed' ? 'completed' : terminalStatus,
      detail: step.detail,
      inputText: step.inputText,
      outputText: step.outputText,
      metadataText: step.metadataText,
      error: terminalStatus === 'failed' ? error || step.error : step.error,
    });
  }
  return next;
}

function errorMessageForProgress(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatProgressKeyValues(
  entries: Array<[string, string | number | boolean | null | undefined]>,
): string {
  return entries
    .filter(
      ([, value]) => value !== undefined && value !== null && `${value}`.trim(),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

function formatRepoReviewAgentStatusText(event: AgentEventPayload): string {
  const title = event.title.trim();
  const body = event.body?.trim();
  return body ? `${title}\n${body}` : title;
}

function buildRepoReviewSubagentPromptPreview(input: {
  label: string;
  task: string;
  files?: string[];
  focus?: string;
  fullFileFiles?: string[];
}): string {
  return trimContextBlock(
    [
      `任务：${input.task}`,
      input.files && input.files.length > 0
        ? `文件：${input.files.join(', ')}`
        : '',
      input.focus ? `重点：${input.focus}` : '',
      input.fullFileFiles && input.fullFileFiles.length > 0
        ? `允许全文读取：${input.fullFileFiles.join(', ')}`
        : '',
      `运行模式：${input.label}`,
      '工具策略：none（子代理不调用工具）',
    ]
      .filter(Boolean)
      .join('\n'),
    REPO_REVIEW_SUBAGENT_PROMPT_PREVIEW_MAX_CHARS,
  );
}

function buildRepoReviewAgentStatusProgressHandler(input: {
  id: string;
  label: string;
  kind?: RepoReviewProgressStepKind;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}) {
  return async (event: AgentEventPayload) => {
    if (!input.onProgressStep || event.kind !== 'status') return;
    await input.onProgressStep({
      id: input.id,
      label: input.label,
      status: 'running',
      detail: formatRepoReviewAgentStatusText(event),
      kind: input.kind,
      metadataText: formatProgressKeyValues([
        ['ai_status', event.status],
        ['event_title', event.title],
        ['event_body', event.body || '-'],
      ]),
    });
  };
}

function capRepoReviewSyntheticToolText(
  value: string | undefined,
): string | undefined {
  if (!value) return value;
  if (value.length <= REPO_REVIEW_SUBAGENT_RESULT_MAX_CHARS) return value;
  return `${value.slice(0, REPO_REVIEW_SUBAGENT_RESULT_MAX_CHARS)}\n...(truncated)`;
}

function buildRepoReviewSyntheticSubagentToolTurn(input: {
  turnId: string;
  toolCallId: string;
  runtimeId?: string;
  parentRuntimeId?: string;
  originTurnId?: string;
  originToolCallId?: string;
  groupKey?: string;
  label: string;
  task: string;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
  status: 'in_progress' | 'completed' | 'failed';
  timestamp?: string;
}): RepoReviewAssistantTurn {
  const timestamp = input.timestamp || new Date().toISOString();
  return {
    id: input.turnId,
    groupKey: input.groupKey || input.turnId,
    groupLabel: input.label,
    parentToolCallId: input.originToolCallId,
    ownerKind: 'subagent',
    ownerLabel: input.label,
    phase: 'worker',
    timestamp,
    isLive: input.status === 'in_progress',
    isCompleted: input.status !== 'in_progress',
    items: [
      {
        id: input.toolCallId,
        type: 'tool_call',
        status: input.status,
        title: 'Agent',
        argumentsText: capRepoReviewSyntheticToolText(input.argumentsText),
        resultText: capRepoReviewSyntheticToolText(input.resultText),
        errorText: capRepoReviewSyntheticToolText(input.errorText),
        startedAt: timestamp,
        ...(input.status !== 'in_progress' ? { completedAt: timestamp } : {}),
        timestamp,
      },
    ],
  };
}

function hasUsableRepoReviewFinalResult(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes('---REVIEW_BODY---')) return true;
  try {
    const json = extractBalancedJson(trimmed) ?? extractJsonObject(trimmed);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const resultType = stringValue(parsed.result_type || parsed.resultType);
    const overall = stringValue(parsed.overall);
    const summary = stringValue(parsed.summary);
    return Boolean(
      (resultType && /repo_review/i.test(resultType)) ||
      normalizeBoolean(parsed.final, false) ||
      (overall && summary) ||
      stringValue(parsed.markdown_body || parsed.markdownBody) ||
      stringValue(parsed.raw_report_markdown || parsed.rawReportMarkdown),
    );
  } catch {
    return false;
  }
}

function isUsableRepoReviewAssistantTerminalMessage(text: string): boolean {
  return hasUsableRepoReviewFinalResult(text);
}

function normalizeRepoReviewMarkdownHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .trim();
}

function isRepoReviewMarkdownSectionHeading(
  line: string,
  sectionNumber: string,
  title: string,
): boolean {
  const normalized = normalizeRepoReviewMarkdownHeading(line);
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titlePattern =
    title === '低风险问题' ? `${escapedTitle}(?:\\s*[/／].*)?` : escapedTitle;
  return new RegExp(
    `^(?:${sectionNumber}[、.：:]|${sectionNumber})\\s*${titlePattern}$`,
  ).test(normalized);
}

function findRepoReviewMarkdownSection(
  lines: string[],
  sectionNumber: string,
  title: string,
): string {
  const startIndex = lines.findIndex((line) =>
    isRepoReviewMarkdownSectionHeading(line, sectionNumber, title),
  );
  if (startIndex < 0) return '';
  const nextSectionIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      /^#{0,6}\s*[一二三四五六七八九十]+[、.：:]/.test(
        normalizeRepoReviewMarkdownHeading(line),
      ),
  );
  const endIndex =
    nextSectionIndex > startIndex ? nextSectionIndex : lines.length;
  return lines
    .slice(startIndex + 1, endIndex)
    .join('\n')
    .trim();
}

function parseRepoReviewMarkdownFindingBlock(
  block: string,
  severity: 'high' | 'medium' | 'low',
): RepoReviewRunFinding | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const titleLine = lines[0]!;
  const inlineFileTitle = titleLine.match(
    /^[-*]\s*`?([^`：:\s]+)`?\s*[:：]\s*(.+)$/,
  );
  const title = (inlineFileTitle?.[2] || titleLine)
    .replace(/^[-*]\s*/, '')
    .replace(/^[🔴🟡🔵]\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim();
  const normalizeLabelLine = (line: string) =>
    line
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
  const labelValue = (line: string, label: string) => {
    const normalized = normalizeLabelLine(line);
    const match = normalized.match(new RegExp(`^${label}[:：]\\s*(.*)$`));
    return match?.[1]?.trim().replace(/^`|`$/g, '') || '';
  };
  const isLabelLine = (line: string, labels: string[]) => {
    const normalized = normalizeLabelLine(line);
    return labels.some((label) =>
      new RegExp(`^${label}[:：]`).test(normalized),
    );
  };
  const fileLine = lines.find((line) => isLabelLine(line, ['文件']));
  const suggestionLineIndex = lines.findIndex((line) =>
    isLabelLine(line, ['修复建议']),
  );
  const detailEndIndex =
    suggestionLineIndex >= 0 ? suggestionLineIndex : lines.length;
  const detailLines = lines.slice(1, detailEndIndex).filter((line) => {
    return !isLabelLine(line, ['文件', '风险等级']);
  });
  const suggestionEndIndex =
    suggestionLineIndex >= 0
      ? lines.findIndex(
          (line, index) =>
            index > suggestionLineIndex && isLabelLine(line, ['风险等级']),
        )
      : -1;
  const suggestion =
    suggestionLineIndex >= 0
      ? lines
          .slice(
            suggestionLineIndex,
            suggestionEndIndex > suggestionLineIndex
              ? suggestionEndIndex
              : lines.length,
          )
          .join('\n')
          .replace(/^[-*]\s*(?:\*\*)?修复建议[:：](?:\*\*)?\s*/m, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join('\n')
      : '';
  const detail = detailLines.join('\n').trim();
  return {
    severity,
    file: fileLine
      ? labelValue(fileLine, '文件')
      : inlineFileTitle?.[1]?.trim(),
    title: title || 'Issue',
    detail: detail || '暂无详细说明。',
    suggestion: suggestion || undefined,
  };
}

function isRepoReviewFindingStartLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[🔴🟡🔵]\s+/.test(trimmed)) return true;
  if (/^[-*]\s*[🔴🟡🔵]\s+/.test(trimmed)) return true;
  if (/^[-*]\s*\[[^\]]+\]\s+/.test(trimmed)) return true;
  if (/^[-*]\s*`?[^`\n：:]{2,160}`?\s*[:：]\s+\S/.test(trimmed)) {
    return true;
  }
  return false;
}

function splitRepoReviewMarkdownFindingBlocks(section: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of section.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && isRepoReviewFindingStartLine(line)) {
      if (current.some((entry) => entry.trim())) {
        blocks.push(current.join('\n').trim());
      }
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.some((entry) => entry.trim())) {
    blocks.push(current.join('\n').trim());
  }
  return blocks.filter(Boolean);
}

function parseRepoReviewMarkdownResult(text: string): {
  overall: ReviewOverall;
  summary: string;
  findings: RepoReviewRunFinding[];
  fileReviews: RepoReviewFileReview[];
  scopeLimitations: string[];
  commitReviews: RepoReviewCommitReview[];
  suggestions: string[];
  recommendedBlock: boolean;
  markdownBody: string;
  rawModelOutput: string;
} | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  const reportIndex = lines.findIndex(
    (line) => normalizeRepoReviewMarkdownHeading(line) === '代码审查报告',
  );
  if (reportIndex < 0) return null;

  const summaryBlock = findRepoReviewMarkdownSection(lines, '一', '审查总结');
  const highBlock = findRepoReviewMarkdownSection(lines, '二', '高风险问题');
  const mediumBlock = findRepoReviewMarkdownSection(lines, '三', '中风险问题');
  const lowBlock = findRepoReviewMarkdownSection(lines, '四', '低风险问题');
  const highlightsBlock = findRepoReviewMarkdownSection(
    lines,
    '五',
    '代码亮点',
  );
  const summaryTail = findRepoReviewMarkdownSection(lines, '六', '总结');

  const summaryLine = summaryBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const summary =
    summaryLine?.replace(/^分支结论[:：]\s*/, '').trim() ||
    summaryBlock.replace(/^分支结论[:：]\s*/m, '').trim() ||
    '模型未返回摘要。';

  const parseFindingSection = (
    block: string,
    severity: 'high' | 'medium' | 'low',
  ) => {
    const normalized = block.trim();
    if (!normalized || /未发现.*问题|暂无.*问题/.test(normalized)) return [];
    const result: RepoReviewRunFinding[] = [];
    const blocks = splitRepoReviewMarkdownFindingBlocks(normalized);
    if (blocks.length > 0) {
      for (const blockText of blocks) {
        const parsed = parseRepoReviewMarkdownFindingBlock(blockText, severity);
        if (parsed) result.push(parsed);
      }
      if (result.length > 0) return result;
    }

    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];
    const title = lines[0]!.replace(/^[-*]\s*/, '').replace(/^[🔴🟡🔵]\s*/, '');
    const fileLine = lines.find((line) => /^文件[:：]/.test(line));
    const suggestionLine = lines.find((line) => /^修复建议[:：]/.test(line));
    const detail = lines
      .slice(1)
      .filter(
        (line) =>
          !/^文件[:：]/.test(line) &&
          !/^修复建议[:：]/.test(line) &&
          !/^风险等级[:：]/.test(line),
      )
      .join('\n')
      .trim();
    result.push({
      severity,
      file: fileLine ? fileLine.replace(/^文件[:：]\s*/, '').trim() : undefined,
      title: title || 'Issue',
      detail: detail || title || '暂无详细说明。',
      suggestion: suggestionLine
        ? suggestionLine.replace(/^修复建议[:：]\s*/, '').trim() || undefined
        : undefined,
    });
    return result;
  };

  const findings = [
    ...parseFindingSection(highBlock, 'high'),
    ...parseFindingSection(mediumBlock, 'medium'),
    ...parseFindingSection(lowBlock, 'low'),
  ];

  const overall = (() => {
    const summaryHint = `${summaryBlock}\n${summaryTail}`.toLowerCase();
    if (/不通过|阻塞|fail/.test(summaryHint)) return 'fail' as const;
    if (/需要关注|warn|中风险/.test(summaryHint)) return 'warn' as const;
    if (findings.some((finding) => finding.severity === 'high'))
      return 'fail' as const;
    if (findings.some((finding) => finding.severity === 'medium'))
      return 'warn' as const;
    return 'pass' as const;
  })();

  const suggestions = Array.from(
    new Set(
      summaryTail
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s*/, ''))
        .filter(
          (line) =>
            line &&
            !/^建议优先处理[:：]/.test(line) &&
            !/^风险统计[:：]/.test(line) &&
            !/^\|/.test(line),
        )
        .map((line) => line.replace(/^建议优先处理[:：]\s*/, '').trim())
        .filter(Boolean),
    ),
  );

  const commitPositives = highlightsBlock
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line && !/^未发现/.test(line));
  const commitReviews = commitPositives.length
    ? [
        {
          commit: '',
          title: '代码亮点',
          author: '',
          positives: commitPositives,
          issues: [],
        },
      ]
    : [];

  return {
    overall,
    summary,
    findings,
    fileReviews: [],
    scopeLimitations: [],
    commitReviews,
    suggestions,
    recommendedBlock:
      overall === 'fail' ||
      findings.some((finding) => finding.severity === 'high'),
    markdownBody: trimmed,
    rawModelOutput: text,
  };
}

function hasCompletedAssistantMessageForTurn(
  turns: RepoReviewAssistantTurn[],
  turnId: string,
): boolean {
  const turn = turns.find((entry) => entry.id === turnId);
  if (!turn) return false;
  return turn.items.some(
    (item) =>
      item.type === 'assistant_message' &&
      item.status === 'completed' &&
      item.text.trim().length > 0,
  );
}

function formatVisibleRepoReviewAssistantMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(extractJsonObject(trimmed)) as Record<
      string,
      unknown
    >;
    const plan = asRecord(parsed.review_plan || parsed.reviewPlan);
    if (Object.keys(plan).length > 0) {
      const tasks = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
      const shouldDelegate = normalizeBoolean(
        plan.should_delegate ?? plan.shouldDelegate,
        tasks > 0,
      );
      return [
        '主代理审查计划',
        shouldDelegate
          ? `计划委派 ${tasks} 个子代理任务`
          : '计划由主代理独立审查',
        stringValue(plan.delegation_reason || plan.delegationReason),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (
      Array.isArray(parsed.checked_files) ||
      Array.isArray(parsed.checkedFiles)
    ) {
      const checkedFiles = normalizeStringArray(
        parsed.checked_files || parsed.checkedFiles,
      );
      const findingsCount = Array.isArray(parsed.findings)
        ? parsed.findings.length
        : 0;
      return [
        '子代理局部审查结果',
        checkedFiles.length > 0 ? `已检查 ${checkedFiles.length} 个文件` : '',
        findingsCount > 0 ? `发现 ${findingsCount} 个问题` : '未发现结构化问题',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const overall = overallLabel(stringValue(parsed.overall) || 'warn');
    const summary = stringValue(parsed.summary) || '模型未返回摘要。';
    const findingsCount = Array.isArray(parsed.findings)
      ? parsed.findings.length
      : 0;
    const lines = [
      'AI 审查阶段结果',
      `结论: ${overall}`,
      summary,
      findingsCount > 0 ? `发现 ${findingsCount} 个关键问题` : '',
    ].filter(Boolean);
    return lines.join('\n');
  } catch {
    return trimmed;
  }
}

function shouldPersistRepoReviewTurnProgressEvent(
  event: AgentTurnEventPayload,
): boolean {
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    return true;
  }
  if (event.type !== 'item.started' && event.type !== 'item.completed') {
    return false;
  }
  if (event.item.type === 'assistant_message') {
    return event.type === 'item.completed' && event.item.status === 'completed';
  }
  return true;
}

function sanitizeReviewTurnEventForWeb(
  event: AgentTurnEventPayload,
  turns: RepoReviewAssistantTurn[],
): AgentTurnEventPayload | null {
  const visible = sanitizeTurnEventForWeb(event);
  if (!visible) return null;
  if (
    (visible.type === 'item.started' || visible.type === 'item.updated') &&
    visible.item.type === 'assistant_message'
  ) {
    return null;
  }
  if (
    visible.type === 'item.completed' &&
    visible.item.type === 'assistant_message'
  ) {
    const renderedText = formatVisibleRepoReviewAssistantMessage(
      visible.item.text,
    );
    if (!renderedText) return null;
    return {
      ...visible,
      item: {
        ...visible.item,
        text: renderedText,
      },
    };
  }
  if (
    visible.type === 'turn.failed' &&
    hasCompletedAssistantMessageForTurn(turns, visible.turnId)
  ) {
    return {
      type: 'turn.completed',
      turnId: visible.turnId,
      timestamp: visible.timestamp,
    };
  }
  return visible;
}

function shouldCloseReviewAgentForTurnEvent(
  event: AgentTurnEventPayload,
): boolean {
  return event.type === 'turn.completed' || event.type === 'turn.failed';
}

interface RepoReviewTurnContext {
  groupKey: string;
  groupLabel: string;
  phase: NonNullable<RepoReviewAssistantTurn['phase']>;
  parentToolCallId?: string;
  ownerKind?: RepoReviewAssistantTurn['ownerKind'];
  ownerLabel?: string;
}

function applyReviewTurnEvent(
  turns: RepoReviewAssistantTurn[],
  event: AgentTurnEventPayload,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  if (event.type === 'turn.started') {
    return upsertReviewTurn(turns, event.turnId, event.timestamp, context);
  }
  if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    return upsertReviewTurnItem(turns, event, context);
  }
  if (event.type === 'turn.completed') {
    return markReviewTurnCompleted(
      turns,
      event.turnId,
      event.timestamp,
      undefined,
      context,
    );
  }
  if (event.type === 'turn.failed') {
    return markReviewTurnCompleted(
      turns,
      event.turnId,
      event.timestamp,
      event.error,
      context,
    );
  }
  return turns;
}

async function requireRepository(id: string): Promise<ReviewRepositoryRecord> {
  const repository = await getReviewRepositoryById(id);
  if (!repository) {
    throw new Error(`Review repository not found: ${id}`);
  }
  return repository;
}

async function requireProfile(id: string): Promise<ReviewProfileRecord> {
  const profile = await getReviewProfileById(id);
  if (!profile) {
    throw new Error(`Review profile not found: ${id}`);
  }
  return profile;
}

function normalizeSensitiveValueMode(
  value: unknown,
  existingValue?: string | null,
  inputValue?: string,
): 'preserve' | 'replace' | 'clear' {
  if (value === 'preserve' || value === 'replace' || value === 'clear') {
    return value;
  }
  if ((inputValue || '').trim()) return 'replace';
  return existingValue ? 'preserve' : 'replace';
}

async function normalizeRepositoryInput(
  payload: Record<string, unknown>,
  existing?: ReviewRepositoryRecord,
): Promise<{
  input: ReviewRepositoryUpsertInput;
  warnings: string[];
  sensitiveValueModes: {
    webhookSecret: 'replace' | 'preserve' | 'clear';
    platformToken: 'replace' | 'preserve' | 'clear';
  };
}> {
  const suggestedId = stringValue(payload.id);
  const id =
    suggestedId ||
    existing?.id ||
    `repo-${slugifyId(
      stringValue(payload.name) || stringValue(payload.localRepoPath),
    )}`;
  const name = stringValue(payload.name) || existing?.name || id;
  const remoteProviderRaw = stringValue(
    payload.remoteProvider || payload.remote_provider,
  );
  const remoteProvider = (
    ['github', 'gitlab', 'gitea'].includes(remoteProviderRaw)
      ? remoteProviderRaw
      : ''
  ) as ReviewRemoteProvider | '';
  const webhookSecretInput = stringValue(
    payload.webhookSecret || payload.webhook_secret,
  );
  const platformTokenInput = stringValue(
    payload.platformToken || payload.platform_token,
  );
  const webhookSecretMode = normalizeSensitiveValueMode(
    payload.webhookSecretMode || payload.webhook_secret_mode,
    existing?.webhook_secret,
    webhookSecretInput,
  );
  const platformTokenMode = normalizeSensitiveValueMode(
    payload.platformTokenMode || payload.platform_token_mode,
    existing?.platform_token,
    platformTokenInput,
  );
  const autoSyncEnabled =
    payload.autoSyncEnabled !== undefined ||
    payload.auto_sync_enabled !== undefined
      ? normalizeBoolean(
          payload.autoSyncEnabled ?? payload.auto_sync_enabled,
          existing?.auto_sync_enabled === 1,
        )
      : existing?.auto_sync_enabled === 1;
  const autoSyncIntervalMinutes = normalizeInteger(
    payload.autoSyncIntervalMinutes || payload.auto_sync_interval_minutes,
    existing?.auto_sync_interval_minutes || 30,
    5,
    1440,
  );
  const autoSyncConfigChanged =
    payload.autoSyncEnabled !== undefined ||
    payload.auto_sync_enabled !== undefined ||
    payload.autoSyncIntervalMinutes !== undefined ||
    payload.auto_sync_interval_minutes !== undefined;
  const localRepoPath =
    stringValue(payload.localRepoPath || payload.local_repo_path) ||
    existing?.local_repo_path ||
    '';
  const cloneUrlInput =
    stringValue(payload.cloneUrl || payload.clone_url) ||
    existing?.clone_url ||
    '';
  const normalizedReviewChatJidInput = await normalizeReviewChatJidInput(
    payload.reviewChatJid || payload.review_chat_jid,
  );
  const detected = (() => {
    try {
      if (localRepoPath) {
        return readLocalRepositoryDetection({
          localRepoPath,
          providerHint: remoteProvider || existing?.remote_provider || '',
        });
      }
      if (cloneUrlInput) {
        return detectRepositoryFromRemoteUrl({
          remoteUrl: cloneUrlInput,
          providerHint: remoteProvider || existing?.remote_provider || '',
        });
      }
      return null;
    } catch {
      return null;
    }
  })();
  const remoteFields = sanitizeDetectedRemoteFields({
    provider:
      remoteProvider || existing?.remote_provider || detected?.provider || '',
    remoteRepoSlug:
      stringValue(payload.remoteRepoSlug || payload.remote_repo_slug) ||
      existing?.remote_repo_slug ||
      detected?.remoteRepoSlug ||
      '',
    remoteBaseUrl:
      stringValue(payload.remoteBaseUrl || payload.remote_base_url) ||
      existing?.remote_base_url ||
      detected?.remoteBaseUrl ||
      '',
    cloneUrl: cloneUrlInput || detected?.cloneUrl || '',
    defaultTargetBranch:
      stringValue(
        payload.defaultTargetBranch || payload.default_target_branch,
      ) ||
      existing?.default_target_branch ||
      detected?.defaultTargetBranch ||
      '',
    warnings: detected?.warnings || [],
  });
  return {
    input: {
      id,
      name,
      language: stringValue(payload.language) || existing?.language || null,
      local_repo_path: localRepoPath || null,
      remote_provider: remoteFields.provider || null,
      remote_repo_slug: remoteFields.remoteRepoSlug || null,
      remote_base_url: remoteFields.remoteBaseUrl || null,
      clone_url: remoteFields.cloneUrl || null,
      default_target_branch: remoteFields.defaultTargetBranch || null,
      review_chat_jid:
        normalizedReviewChatJidInput ||
        existing?.review_chat_jid ||
        `repo-review:${id}`,
      actor_mention_mappings_json: JSON.stringify(
        payload.actorMentionMappings !== undefined ||
          payload.actor_mention_mappings !== undefined
          ? normalizeActorMentionMappings(
              payload.actorMentionMappings || payload.actor_mention_mappings,
            )
          : parseActorMentionMappingsJson(
              existing?.actor_mention_mappings_json,
            ),
      ),
      reviewer_usernames_json: JSON.stringify(
        payload.reviewerUsernames !== undefined ||
          payload.reviewer_usernames !== undefined
          ? normalizeReviewerUsernames(
              payload.reviewerUsernames || payload.reviewer_usernames,
            )
          : existing
            ? (await parseReviewRepositoryRecord(existing)).reviewerUsernames
            : [],
      ),
      webhook_secret:
        webhookSecretMode === 'clear'
          ? null
          : webhookSecretMode === 'preserve'
            ? existing?.webhook_secret || null
            : webhookSecretInput || null,
      platform_token:
        platformTokenMode === 'clear'
          ? null
          : platformTokenMode === 'preserve'
            ? existing?.platform_token || null
            : platformTokenInput || null,
      auto_sync_enabled: autoSyncEnabled,
      auto_sync_interval_minutes: autoSyncIntervalMinutes,
      last_auto_sync_at: existing?.last_auto_sync_at || null,
      next_auto_sync_at: autoSyncEnabled
        ? autoSyncConfigChanged ||
          existing?.auto_sync_enabled !== 1 ||
          !existing?.next_auto_sync_at
          ? computeNextAutoSyncAt(autoSyncIntervalMinutes)
          : existing.next_auto_sync_at
        : null,
      last_auto_sync_status: autoSyncEnabled
        ? existing?.last_auto_sync_status || null
        : null,
      last_auto_sync_message: autoSyncEnabled
        ? existing?.last_auto_sync_message || null
        : null,
      digest_daily_enabled: normalizeBoolean(
        payload.digestDailyEnabled ?? payload.digest_daily_enabled,
        existing?.digest_daily_enabled === 1,
      ),
      digest_weekly_enabled: normalizeBoolean(
        payload.digestWeeklyEnabled ?? payload.digest_weekly_enabled,
        existing?.digest_weekly_enabled === 1,
      ),
      digest_daily_hour: normalizeInteger(
        payload.digestDailyHour ??
          payload.digest_daily_hour ??
          existing?.digest_daily_hour,
        18,
        0,
        23,
      ),
      digest_weekly_day: normalizeInteger(
        payload.digestWeeklyDay ??
          payload.digest_weekly_day ??
          existing?.digest_weekly_day,
        5,
        1,
        7,
      ),
      digest_weekly_hour: normalizeInteger(
        payload.digestWeeklyHour ??
          payload.digest_weekly_hour ??
          existing?.digest_weekly_hour,
        18,
        0,
        23,
      ),
      enabled: normalizeBoolean(payload.enabled, existing?.enabled !== 0),
      allow_ai_fix: normalizeBoolean(
        payload.allowAiFix ?? payload.allow_ai_fix,
        existing?.allow_ai_fix === 1,
      ),
    },
    warnings: remoteFields.warnings,
    sensitiveValueModes: {
      webhookSecret: webhookSecretMode,
      platformToken: platformTokenMode,
    },
  };
}

function validateRepositoryInput(
  input: ReviewRepositoryUpsertInput,
  existing?: ReviewRepositoryRecord,
  sensitiveValueModes?: {
    webhookSecret: 'preserve' | 'replace' | 'clear';
    platformToken: 'preserve' | 'replace' | 'clear';
  },
): void {
  if (!input.name.trim()) {
    throw new Error(t('repoReview.auto_ea90e6', {}, undefined));
  }

  const provider = input.remote_provider || '';
  const autoSyncEnabled = input.auto_sync_enabled;
  const remoteSlug = normalizeRepoSlugValue(input.remote_repo_slug || '');
  const remoteBaseUrl = normalizeRemoteBaseUrlValue(
    input.remote_base_url || '',
  );
  const cloneUrl = (input.clone_url || '').trim();
  const hasLocalRemoteAccess = hasLocalGitRemoteAccess({
    local_repo_path: input.local_repo_path || null,
    clone_url: input.clone_url || null,
    remote_provider: input.remote_provider || null,
  });
  const platformTokenMode = sensitiveValueModes?.platformToken || 'replace';
  const hasPlatformToken =
    platformTokenMode === 'clear'
      ? Boolean((input.platform_token || '').trim())
      : platformTokenMode === 'preserve'
        ? Boolean(existing?.platform_token || '')
        : Boolean((input.platform_token || '').trim());

  if (!input.local_repo_path && !cloneUrl && !provider) {
    return;
  }

  if (provider) {
    if (!remoteSlug && !hasLocalRemoteAccess) {
      throw new Error(t('repoReview.auto_d24a27', {}, undefined));
    }
    if (autoSyncEnabled && !hasPlatformToken && !hasLocalRemoteAccess) {
      if (provider === 'gitlab') {
        throw new Error(t('repoReview.auto_c8ad4a', {}, undefined));
      }
      if (provider === 'github') {
        throw new Error(t('repoReview.auto_cc6338', {}, undefined));
      }
      if (provider === 'gitea') {
        throw new Error(t('repoReview.auto_906c15', {}, undefined));
      }
    }
    if (
      (provider === 'github' ||
        provider === 'gitea' ||
        provider === 'gitlab') &&
      autoSyncEnabled &&
      !cloneUrl &&
      !hasLocalRemoteAccess
    ) {
      throw new Error(t('repoReview.auto_ac5d39', {}, undefined));
    }
    if (remoteBaseUrl) {
      const parsed = parseRepositoryUrlCandidate(remoteBaseUrl, provider);
      if (parsed?.remoteRepoSlug && parsed.remoteRepoSlug === remoteSlug) {
        throw new Error(
          t(
            'repoReview.remoteBaseUrlLooksLikeRepoPage',
            { remoteBaseUrl: parsed.remoteBaseUrl, remoteSlug },
            undefined,
          ),
        );
      }
    }
  }
}

function computeNextAutoSyncAt(
  intervalMinutes: number,
  now = new Date(),
): string {
  return new Date(
    now.getTime() + normalizeInteger(intervalMinutes, 30, 5, 1440) * 60_000,
  ).toISOString();
}

async function recoverStaleRepoReviewRuns(
  repositoryId?: string,
  now = new Date(),
): Promise<void> {
  const nowMs = now.getTime();
  for (const run of await listActiveReviewRuns(repositoryId)) {
    if (run.status === 'queued') {
      const replayableEvent =
        await buildRepoReviewEventFromQueuedRunRecord(run);
      if (replayableEvent) {
        await enqueueQueuedRepoReviewRun(run);
        continue;
      }
    }
    const startedAt = stringValue(run.started_at || run.created_at);
    if (!startedAt) continue;
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) continue;
    if (nowMs - startedMs < STALE_REVIEW_RUN_GRACE_MS) continue;
    const updated = await updateReviewRun(run.id, {
      status: 'error',
      result_state: 'error',
      overall: 'error',
      summary: '审查运行长时间无进展，已标记为失败。',
      error: '运行在超时窗口内未完成，系统已终止该次审查状态。',
      completed_at: now.toISOString(),
    });
    updateBranchStateFromRun(await normalizeRunRecord(updated));
  }
}

async function recoverInterruptedRepoReviewRuns(
  now = new Date(),
): Promise<void> {
  const processStartedMs = Date.parse(REPO_REVIEW_PROCESS_STARTED_AT);
  for (const run of await listActiveReviewRuns()) {
    const activityAt = stringValue(
      run.updated_at || run.started_at || run.created_at,
    );
    const activityMs = Date.parse(activityAt);
    if (
      Number.isFinite(processStartedMs) &&
      Number.isFinite(activityMs) &&
      activityMs >= processStartedMs
    ) {
      continue;
    }
    if (run.status === 'queued') {
      const replayableEvent =
        await buildRepoReviewEventFromQueuedRunRecord(run);
      if (replayableEvent) {
        await enqueueQueuedRepoReviewRun(run);
        continue;
      }
    }
    const updated = await updateReviewRun(run.id, {
      status: 'error',
      result_state: 'error',
      overall: 'error',
      summary: '服务重启前存在未完成的审查运行，已标记为失败。',
      error:
        '该审查运行因 NanoClaw 重启而被中断，无法安全恢复，请重新触发审查。',
      completed_at: now.toISOString(),
    });
    updateBranchStateFromRun(await normalizeRunRecord(updated));
  }
}

let repoReviewStartupRecoveryPromise: Promise<void> | null = null;

function ensureRepoReviewStartupRecovery(): void {
  if (repoReviewStartupRecoveryApplied) return;
  repoReviewStartupRecoveryApplied = true;
  repoReviewStartupRecoveryPromise = recoverInterruptedRepoReviewRuns()
    .catch((err) => logger.error({ err }, 'Startup recovery failed'))
    .finally(() => {
      repoReviewStartupRecoveryPromise = null;
    });
}

export function getStartupRecoveryPromise(): Promise<void> | null {
  return repoReviewStartupRecoveryPromise;
}

async function executeQueuedRepoReviewRun(
  runId: string,
): Promise<RepoReviewExecutionSummary> {
  const runRecord = await getReviewRunById(runId);
  if (!runRecord) {
    throw new Error(`Queued review run not found: ${runId}`);
  }
  if (runRecord.status === 'running' || runRecord.status === 'completed') {
    logger.warn(
      { runId, status: runRecord.status },
      'Skipping duplicate execution: run already in progress or completed',
    );
    return buildRepoReviewExecutionSummary(
      await normalizeRunRecord(runRecord),
      { reused: true, reuseReason: t('repoReview.auto_99ffaa', {}, undefined) },
    );
  }
  const event = await buildRepoReviewEventFromQueuedRunRecord(runRecord);
  if (!event) {
    throw new Error(`Queued review run is not replayable: ${runId}`);
  }
  const repository = await requireRepository(runRecord.repository_id);
  if (hasLocalGitRemoteAccess(repository)) {
    await persistRepoReviewRunProgressStep({
      runId,
      id: 'refresh_remote_refs',
      label: '拉取远端 refs',
      status: 'running',
      detail: '执行 git fetch --prune',
    });
    try {
      await refreshRepositoryRemoteRefs(repository);
      await persistRepoReviewRunProgressStep({
        runId,
        id: 'refresh_remote_refs',
        label: '拉取远端 refs',
        status: 'completed',
        detail: '远端 refs 已更新',
      });
    } catch (err) {
      await persistRepoReviewRunProgressStep({
        runId,
        id: 'refresh_remote_refs',
        label: '拉取远端 refs',
        status: 'failed',
        detail: 'fetch 失败，将继续尝试后续审查流程',
        error: errorMessageForProgress(err),
      });
      logger.warn(
        { err, repositoryId: repository.id, branch: event.branch, runId },
        'Failed to refresh local remote refs before executing queued repo review',
      );
    }
  } else {
    await persistRepoReviewRunProgressStep({
      runId,
      id: 'refresh_remote_refs',
      label: '拉取远端 refs',
      status: 'skipped',
      detail: '仓库没有可用的本地 remote 元数据',
    });
  }
  return await executeRepoReviewEvent(event, runId);
}

async function failQueuedRepoReviewRun(
  runId: string,
  errorMessage: string,
): Promise<void> {
  const runRecord = await getReviewRunById(runId);
  if (!runRecord) return;
  const updated = await updateReviewRun(runId, {
    status: 'error',
    result_state: 'error',
    overall: 'error',
    summary: '审查运行执行失败。',
    error: errorMessage,
    completed_at: new Date().toISOString(),
  });
  updateBranchStateFromRun(await normalizeRunRecord(updated));
}

function getAutoSyncIntervalMinutes(
  repository: ReviewRepositoryRecord,
): number {
  return normalizeInteger(repository.auto_sync_interval_minutes, 30, 5, 1440);
}

async function updateRepositoryAutoSyncSchedule(
  repository: ReviewRepositoryRecord,
  now = new Date(),
): Promise<void> {
  if (repository.auto_sync_enabled !== 1) return;
  const timestamp = now.toISOString();
  await updateReviewRepositoryAutoSync({
    repositoryId: repository.id,
    lastAutoSyncAt: timestamp,
    nextAutoSyncAt: computeNextAutoSyncAt(
      getAutoSyncIntervalMinutes(repository),
      now,
    ),
  });
}

function summarizeAutoSyncResult(input: {
  triggered: number;
  skipped: number;
  failed: number;
}): { status: string; message: string } {
  const { triggered, skipped, failed } = input;
  const status =
    failed > 0
      ? triggered > 0
        ? 'partial'
        : 'error'
      : triggered > 0
        ? 'success'
        : 'idle';
  return {
    status,
    message: t(
      'repoReview.pollCompleted',
      { triggered, skipped, failed },
      undefined,
    ),
  };
}

async function normalizeProfileInput(
  payload: Record<string, unknown>,
  existing?: ReviewProfileRecord,
): Promise<ReviewProfileUpsertInput> {
  const existingNormalized = existing
    ? await parseReviewProfileRecord(existing)
    : undefined;
  const repositoryId =
    stringValue(payload.repositoryId || payload.repository_id) ||
    existing?.repository_id ||
    '';
  if (!repositoryId) {
    throw new Error('repositoryId is required');
  }
  const id =
    stringValue(payload.id) ||
    existing?.id ||
    `profile-${slugifyId(`${repositoryId}-${stringValue(payload.name) || 'default'}`)}`;
  const stageRaw = stringValue(payload.stage) || existing?.stage || 'push';
  const stage = (stageRaw === 'commit' ? 'commit' : 'push') as ReviewStage;
  const sourceModeRaw =
    stringValue(payload.sourceMode || payload.source_mode) ||
    existing?.source_mode ||
    'both';
  const sourceMode = (
    ['local', 'remote', 'both'].includes(sourceModeRaw) ? sourceModeRaw : 'both'
  ) as ReviewSourceMode;
  const blockingModeRaw =
    stringValue(payload.blockingMode || payload.blocking_mode) ||
    existing?.blocking_mode ||
    'soft_fail';
  const blockingMode = (
    blockingModeRaw === 'hard_fail' ? 'hard_fail' : 'soft_fail'
  ) as ReviewBlockingMode;
  const passDecisionModeRaw =
    stringValue(payload.passDecisionMode || payload.pass_decision_mode) ||
    existing?.pass_decision_mode ||
    'ai';
  const passDecisionMode = (
    stage === 'push' && passDecisionModeRaw === 'human' ? 'human' : 'ai'
  ) as 'ai' | 'human';
  const reviewScopeRaw =
    stringValue(payload.reviewScope || payload.review_scope) ||
    existing?.review_scope ||
    'auto';
  const reviewScope = (
    ['auto', 'staged_diff', 'commit_range', 'pr_compare', 'compare'].includes(
      reviewScopeRaw,
    )
      ? reviewScopeRaw
      : 'auto'
  ) as ReviewScope;
  const providerIdRaw =
    payload.providerId !== undefined || payload.provider_id !== undefined
      ? (payload.providerId ?? payload.provider_id)
      : existing?.provider_id;
  const providerId = stringValue(providerIdRaw) || null;
  return {
    id,
    repository_id: repositoryId,
    name: stringValue(payload.name) || existing?.name || id,
    stage,
    source_mode: sourceMode,
    blocking_mode: blockingMode,
    pass_decision_mode: passDecisionMode,
    review_scope: reviewScope,
    target_branches:
      payload.targetBranches !== undefined ||
      payload.target_branches !== undefined
        ? normalizeStringArray(
            payload.targetBranches || payload.target_branches,
          )
        : existingNormalized?.targetBranches || [],
    skill_ids:
      payload.skillIds !== undefined || payload.skill_ids !== undefined
        ? normalizeStringArray(payload.skillIds || payload.skill_ids)
        : existingNormalized?.skillIds || [],
    mcp_server_ids:
      payload.mcpServerIds !== undefined || payload.mcp_server_ids !== undefined
        ? normalizeStringArray(payload.mcpServerIds || payload.mcp_server_ids)
        : existingNormalized?.mcpServerIds || [],
    prompt_template:
      stringValue(payload.promptTemplate || payload.prompt_template) ||
      existing?.prompt_template ||
      null,
    include_globs:
      payload.includeGlobs !== undefined || payload.include_globs !== undefined
        ? normalizeStringArray(payload.includeGlobs || payload.include_globs)
        : existingNormalized?.includeGlobs || [],
    exclude_globs:
      payload.excludeGlobs !== undefined || payload.exclude_globs !== undefined
        ? normalizeStringArray(payload.excludeGlobs || payload.exclude_globs)
        : existingNormalized?.excludeGlobs || [],
    include_full_file_context: normalizeBoolean(
      payload.includeFullFileContext ?? payload.include_full_file_context,
      existing?.include_full_file_context === 1,
    ),
    max_files: normalizeInteger(
      payload.maxFiles || payload.max_files,
      existing?.max_files || 80,
      1,
      1000,
    ),
    max_diff_bytes: normalizeInteger(
      payload.maxDiffBytes || payload.max_diff_bytes,
      existing?.max_diff_bytes || 200000,
      1024,
      5_000_000,
    ),
    write_to_chat: normalizeBoolean(
      payload.writeToChat ?? payload.write_to_chat,
      existing?.write_to_chat !== 0,
    ),
    write_to_platform: normalizeBoolean(
      payload.writeToPlatform ?? payload.write_to_platform,
      existing?.write_to_platform !== 0,
    ),
    provider_id: providerId,
    review_output_mode: normalizeReviewOutputMode(
      payload.reviewOutputMode ??
        payload.review_output_mode ??
        existing?.review_output_mode,
    ),
    diff_subagent_threshold: normalizeInteger(
      payload.diffSubagentThreshold ?? payload.diff_subagent_threshold,
      existing?.diff_subagent_threshold ?? 15,
      0,
      1000,
    ),
    subagent_timeout_seconds: normalizeInteger(
      payload.subagentTimeoutSeconds ?? payload.subagent_timeout_seconds,
      existing?.subagent_timeout_seconds ?? 420,
      30,
      3600,
    ),
    enabled: normalizeBoolean(payload.enabled, existing?.enabled !== 0),
  };
}

function extractBalancedJson(source: string): string | null {
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function extractJsonObject(text: string): string {
  const fenceStart = text.match(/```json\s*/i);
  if (fenceStart?.index !== undefined) {
    const afterFence = text.slice(fenceStart.index + fenceStart[0].length);
    const balanced = extractBalancedJson(afterFence);
    if (balanced) return balanced;
  }
  const balanced = extractBalancedJson(text);
  if (balanced) return balanced;
  return text.trim();
}

const REVIEW_SCOPE_LIMITATION_PATTERNS = [
  /仅基于当前分支总 diff/i,
  /无法确认.*冲突/i,
  /无法还原.*merge/i,
  /无法精确核对/i,
  /审查粒度受限/i,
  /上下文不足/i,
  /冲突取舍/i,
  /覆盖上游变更/i,
  /合并提交.*局限/i,
  /merge commit/i,
];

function normalizeReviewScopeLimitations(value: unknown): string[] {
  const normalized = normalizeStringArray(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seenKeys = new Set<string>();
  for (const entry of normalized) {
    const key = getScopeLimitationKey(entry);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(entry);
  }
  return deduped.slice(0, 3);
}

function isScopeLimitationText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return REVIEW_SCOPE_LIMITATION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function getScopeLimitationKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    /当前分支总 diff|merge commit|父提交差异|冲突取舍|覆盖上游/.test(normalized)
  ) {
    return 'merge-context';
  }
  return normalized.replace(/[^\p{L}\p{N}]+/gu, '');
}

function isScopeLimitationFinding(finding: RepoReviewRunFinding): boolean {
  if (
    finding.file &&
    finding.file !== 'N/A' &&
    finding.file !== '(none)' &&
    finding.file !== 'unknown'
  ) {
    return false;
  }
  return isScopeLimitationText(
    [finding.title, finding.detail, finding.suggestion || ''].join(' '),
  );
}

function extractScopeLimitations(input: {
  findings: RepoReviewRunFinding[];
  commitReviews: RepoReviewCommitReview[];
  explicitLimitations: string[];
}): {
  findings: RepoReviewRunFinding[];
  scopeLimitations: string[];
  commitReviews: RepoReviewCommitReview[];
} {
  const scopeLimitations = [...input.explicitLimitations];
  const findings = input.findings.filter((finding) => {
    if (!isScopeLimitationFinding(finding)) {
      return true;
    }
    const message = [finding.title, finding.detail].filter(Boolean).join(' - ');
    if (message) {
      scopeLimitations.push(message);
    }
    return false;
  });
  const commitReviews = input.commitReviews
    .map((review) => {
      const retainedIssues: string[] = [];
      for (const issue of review.issues) {
        if (isScopeLimitationText(issue)) {
          scopeLimitations.push(issue);
        } else {
          retainedIssues.push(issue);
        }
      }
      return {
        ...review,
        issues: retainedIssues,
      };
    })
    .filter(
      (review) =>
        review.issues.length > 0 ||
        review.positives.length > 0 ||
        !/^merge\b/i.test(review.title.trim()),
    );
  return {
    findings,
    scopeLimitations: normalizeReviewScopeLimitations(scopeLimitations),
    commitReviews,
  };
}

function splitReviewBodyFromJson(text: string): {
  jsonPart: string;
  markdownBody: string;
} {
  const marker = '---REVIEW_BODY---';
  const jsonObj = extractBalancedJson(text);
  if (jsonObj) {
    const jsonEnd = text.indexOf(jsonObj) + jsonObj.length;
    const remainder = text.slice(jsonEnd);
    const markerIdx = remainder.indexOf(marker);
    if (markerIdx >= 0) {
      return {
        jsonPart: jsonObj,
        markdownBody: remainder.slice(markerIdx + marker.length).trim(),
      };
    }
    return { jsonPart: jsonObj, markdownBody: '' };
  }
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    return {
      jsonPart: text.slice(0, idx).trim(),
      markdownBody: text.slice(idx + marker.length).trim(),
    };
  }
  return { jsonPart: text, markdownBody: '' };
}

function parseReviewResult(text: string): {
  overall: ReviewOverall;
  summary: string;
  findings: RepoReviewRunFinding[];
  fileReviews: RepoReviewFileReview[];
  scopeLimitations: string[];
  commitReviews: RepoReviewCommitReview[];
  suggestions: string[];
  recommendedBlock: boolean;
  markdownBody: string;
  rawModelOutput: string;
} {
  const rawModelOutput = text;
  let extractedMarkdown = '';
  try {
    const { jsonPart, markdownBody } = splitReviewBodyFromJson(text);
    extractedMarkdown = markdownBody;
    const parsed = JSON.parse(
      extractBalancedJson(jsonPart) ?? extractJsonObject(jsonPart || text),
    ) as Record<string, unknown>;
    const overallRaw = stringValue(parsed.overall);
    const overall = (
      ['pass', 'warn', 'fail', 'error', 'skipped'].includes(overallRaw)
        ? overallRaw
        : 'warn'
    ) as ReviewOverall;
    const findings: RepoReviewRunFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === 'object' && !Array.isArray(entry),
          )
          .map((entry) => ({
            severity: (stringValue(entry.severity) === 'high'
              ? 'high'
              : stringValue(entry.severity) === 'low'
                ? 'low'
                : 'medium') as RepoReviewRunFinding['severity'],
            file: stringValue(entry.file) || undefined,
            line: stringValue(entry.line) || undefined,
            codeSnippet:
              stringValue(entry.codeSnippet || entry.code_snippet) || undefined,
            fixCode: stringValue(entry.fixCode || entry.fix_code) || undefined,
            evidence: stringValue(entry.evidence) || undefined,
            evidenceKey:
              stringValue(entry.evidenceKey || entry.evidence_key) || undefined,
            codeSnippetSource:
              stringValue(
                entry.codeSnippetSource || entry.code_snippet_source,
              ) === 'model' ||
              stringValue(
                entry.codeSnippetSource || entry.code_snippet_source,
              ) === 'diff' ||
              stringValue(
                entry.codeSnippetSource || entry.code_snippet_source,
              ) === 'workspace' ||
              stringValue(
                entry.codeSnippetSource || entry.code_snippet_source,
              ) === 'unavailable'
                ? (stringValue(
                    entry.codeSnippetSource || entry.code_snippet_source,
                  ) as RepoReviewRunFinding['codeSnippetSource'])
                : stringValue(entry.codeSnippet || entry.code_snippet)
                  ? 'model'
                  : undefined,
            needsSnippetHydration: normalizeBoolean(
              entry.needsSnippetHydration || entry.needs_snippet_hydration,
              !stringValue(entry.codeSnippet || entry.code_snippet),
            ),
            title: stringValue(entry.title) || 'Issue',
            detail: stringValue(entry.detail) || stringValue(entry.description),
            suggestion: stringValue(entry.suggestion) || undefined,
          }))
      : [];
    const fileReviewEntries = Array.isArray(parsed.file_reviews)
      ? parsed.file_reviews
      : Array.isArray(parsed.fileReviews)
        ? parsed.fileReviews
        : [];
    const fileReviews: RepoReviewFileReview[] = fileReviewEntries
      .filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
      .map((entry) => {
        const positives = normalizeStringArray(entry.positives).slice(0, 5);
        const risks = normalizeStringArray(entry.risks).slice(0, 5);
        const suggestions = normalizeStringArray(entry.suggestions).slice(0, 5);
        const summaryParts = [
          stringValue(entry.summary),
          positives.length > 0
            ? t(
                'repoReview.positivesHighlight',
                { positives: positives.join('；') },
                undefined,
              )
            : '',
          risks.length > 0
            ? t(
                'repoReview.risksToWatch',
                { risks: risks.join('；') },
                undefined,
              )
            : '',
          suggestions.length > 0
            ? t(
                'repoReview.suggestionsPriority',
                { suggestions: suggestions.join('；') },
                undefined,
              )
            : '',
        ].filter(Boolean);
        return {
          file: stringValue(entry.file),
          summary:
            summaryParts.join('\n\n') || t('errors.auto_3766f4', {}, undefined),
        };
      })
      .filter((entry) => entry.file);
    const scopeLimitations = normalizeReviewScopeLimitations(
      parsed.scope_limitations || parsed.scopeLimitations,
    );
    const commitReviewEntries = Array.isArray(parsed.commit_reviews)
      ? parsed.commit_reviews
      : Array.isArray(parsed.commitReviews)
        ? parsed.commitReviews
        : [];
    const commitReviews: RepoReviewCommitReview[] = commitReviewEntries
      .filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
      .map((entry) => ({
        commit: shortSha(stringValue(entry.commit || entry.sha)),
        title:
          stringValue(entry.title) ||
          t('repoReview.auto_f38c68', {}, undefined),
        author: stringValue(entry.author),
        positives: normalizeStringArray(entry.positives).slice(0, 5),
        issues: normalizeStringArray(entry.issues).slice(0, 5),
      }))
      .filter((entry) => entry.commit || entry.title);
    const extracted = extractScopeLimitations({
      findings,
      commitReviews,
      explicitLimitations: scopeLimitations,
    });
    const rawReportMarkdown =
      stringValue(parsed.markdown_body) ||
      stringValue(parsed.markdownBody) ||
      stringValue(parsed.raw_report_markdown) ||
      stringValue(parsed.rawReportMarkdown);
    const summary = stringValue(parsed.summary) || '模型未返回摘要。';
    const suggestions = normalizeStringArray(parsed.suggestions);
    const finalMarkdownBody =
      markdownBody ||
      rawReportMarkdown ||
      buildStructuredRepoReviewMarkdown({
        summary,
        findings: extracted.findings,
        commitReviews: extracted.commitReviews,
        suggestions,
      });
    return {
      overall,
      summary,
      findings: extracted.findings,
      fileReviews,
      scopeLimitations: extracted.scopeLimitations,
      commitReviews: extracted.commitReviews,
      suggestions,
      recommendedBlock: normalizeBoolean(parsed.recommended_block, false),
      markdownBody: finalMarkdownBody,
      rawModelOutput,
    };
  } catch (err) {
    const markdownParsed = parseRepoReviewMarkdownResult(text);
    if (markdownParsed) {
      return markdownParsed;
    }
    const fallbackMarkdown = extractedMarkdown || text.trim();
    return {
      overall: 'warn',
      summary: '模型输出未完全结构化，已回退展示原始审查结果。',
      findings: [
        {
          severity: 'medium',
          title: '审查输出格式不符合要求',
          detail: err instanceof Error ? err.message : '无法解析模型输出。',
        },
      ],
      fileReviews: [],
      scopeLimitations: [],
      commitReviews: [],
      suggestions: [],
      recommendedBlock: false,
      markdownBody: fallbackMarkdown,
      rawModelOutput,
    };
  }
}

function normalizeSupplementalFindingTitle(title: string): string {
  const normalized =
    stringValue(title) || t('repoReview.auto_ea04ef', {}, undefined);
  return normalized.startsWith(t('errors.auto_fce2f8', {}, undefined))
    ? normalized
    : t('repoReview.fullFilePrefix', { title: normalized }, undefined);
}

function dedupeRepoReviewFindings(
  findings: RepoReviewRunFinding[],
): RepoReviewRunFinding[] {
  const deduped = new Map<string, RepoReviewRunFinding>();
  for (const finding of findings) {
    const key = [
      stringValue(finding.file),
      stringValue(finding.title),
      stringValue(finding.detail),
      stringValue(finding.suggestion),
      stringValue(finding.severity),
    ].join('::');
    if (!key.trim()) continue;
    deduped.set(key, finding);
  }
  return Array.from(deduped.values());
}

function mergeRepoReviewSummaryWithSupplementalFindings(input: {
  summary: string;
  supplementalFindings: RepoReviewRunFinding[];
  supplementalReviewCompleted: boolean;
  supplementalReviewFailed: boolean;
}): string {
  const summary =
    stringValue(input.summary) || t('errors.auto_39dc7e', {}, undefined);
  if (input.supplementalFindings.length > 0) {
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const finding of input.supplementalFindings) {
      if (finding.severity === 'high') {
        high += 1;
      } else if (finding.severity === 'low') {
        low += 1;
      } else {
        medium += 1;
      }
    }
    const note = t(
      'repoReview.supplementalFindingsNote',
      { total: input.supplementalFindings.length, high, medium, low },
      undefined,
    );
    return summary.includes(note) ? summary : `${summary}\n\n${note}`;
  }
  if (input.supplementalReviewFailed) {
    const note = t('repoReview.auto_40b78d', {}, undefined);
    return summary.includes(note) ? summary : `${summary}\n\n${note}`;
  }
  if (!input.supplementalReviewCompleted) {
    return summary;
  }
  const note = t('repoReview.auto_a645d2', {}, undefined);
  return summary.includes(note) ? summary : `${summary}\n\n${note}`;
}

function mergeRepoReviewOverallWithSupplementalFindings(
  overall: ReviewOverall,
  supplementalFindings: RepoReviewRunFinding[],
  overallImpact: 'none' | 'warn' | 'fail',
): ReviewOverall {
  if (overall === 'error' || overall === 'skipped' || overall === 'fail') {
    return overall;
  }
  if (overallImpact === 'fail') return 'fail';
  if (overallImpact === 'warn') {
    return overall === 'pass' ? 'warn' : overall;
  }
  if (supplementalFindings.length === 0) {
    return overall;
  }
  return supplementalFindings.some((finding) => finding.severity === 'high')
    ? 'fail'
    : overall === 'pass'
      ? 'warn'
      : overall;
}

function buildSupplementalRecommendedBlock(
  supplementalFindings: RepoReviewRunFinding[],
  explicitRecommendedBlock: boolean,
): boolean {
  return (
    explicitRecommendedBlock ||
    supplementalFindings.some((finding) => finding.severity === 'high')
  );
}

function buildFallbackRepoReviewFileReviews(input: {
  changedFiles: string[];
  findings: RepoReviewRunFinding[];
  fileReviews: RepoReviewFileReview[];
  includeFullFileContext: boolean;
}): RepoReviewFileReview[] {
  if (!input.includeFullFileContext || input.changedFiles.length === 0) {
    return [];
  }

  const existingByFile = new Map(
    input.fileReviews
      .filter((entry) => stringValue(entry.file))
      .map((entry) => [
        stringValue(entry.file),
        {
          file: stringValue(entry.file),
          summary:
            stringValue(entry.summary) ||
            t('errors.auto_3766f4', {}, undefined),
        },
      ]),
  );

  return input.changedFiles.map((filePath) => {
    const normalizedFile = stringValue(filePath);
    const existing = existingByFile.get(normalizedFile);
    if (existing) {
      return existing;
    }

    const relatedFindings = input.findings.filter(
      (finding) => stringValue(finding.file) === normalizedFile,
    );
    const risks = relatedFindings
      .map(
        (finding) =>
          `[${finding.severity.toUpperCase()}] ${stringValue(finding.title)}`,
      )
      .filter(Boolean)
      .slice(0, 5);
    const suggestions = relatedFindings
      .map((finding) => stringValue(finding.suggestion))
      .filter(Boolean)
      .slice(0, 5);
    const hasSupplementalFinding = relatedFindings.some((finding) =>
      stringValue(finding.title)
        .replace(/\s+/g, ' ')
        .startsWith(t('errors.auto_fce2f8', {}, undefined)),
    );

    return {
      file: normalizedFile,
      summary:
        hasSupplementalFinding || risks.length > 0
          ? [
              t('repoReview.auto_5a900d', {}, undefined),
              risks.length > 0
                ? t(
                    'repoReview.risksToWatch',
                    { risks: risks.join('；') },
                    undefined,
                  )
                : '',
              suggestions.length > 0
                ? t(
                    'repoReview.suggestionsPriority',
                    { suggestions: suggestions.join('；') },
                    undefined,
                  )
                : '',
            ]
              .filter(Boolean)
              .join('\n\n')
          : t('repoReview.auto_3b4d5d', {}, undefined),
    };
  });
}

function parseSupplementalFileReviewResult(
  text: string,
  filePath: string,
): RepoReviewSupplementalFileReviewResult {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as Record<
      string,
      unknown
    >;
    const findings: RepoReviewRunFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .filter(
            (entry): entry is Record<string, unknown> =>
              !!entry && typeof entry === 'object' && !Array.isArray(entry),
          )
          .map((entry) => {
            return {
              severity: (stringValue(entry.severity) === 'high'
                ? 'high'
                : stringValue(entry.severity) === 'low'
                  ? 'low'
                  : 'medium') as RepoReviewRunFinding['severity'],
              file: filePath,
              title: normalizeSupplementalFindingTitle(
                stringValue(entry.title),
              ),
              detail:
                stringValue(entry.detail) || stringValue(entry.description),
              suggestion: stringValue(entry.suggestion) || undefined,
            };
          })
          .filter((entry) => entry.detail)
      : [];
    const overallImpactRaw = stringValue(
      parsed.overall_impact || parsed.overallImpact,
    );
    return {
      summary:
        stringValue(parsed.summary) ||
        t('repoReview.auto_69f9a7', {}, undefined),
      findings,
      suggestions: normalizeStringArray(parsed.suggestions),
      scopeLimitations: normalizeReviewScopeLimitations(
        parsed.scope_limitations || parsed.scopeLimitations,
      ),
      overallImpact:
        overallImpactRaw === 'fail'
          ? 'fail'
          : overallImpactRaw === 'warn'
            ? 'warn'
            : 'none',
      recommendedBlock: normalizeBoolean(parsed.recommended_block, false),
    };
  } catch (err) {
    const trimmed = text.trim();
    const markdownLines = trimmed.split(/\r?\n/);
    const conclusionSection = findMarkdownSectionByTitles(trimmed, ['结论']);
    const findingsSection = findMarkdownSectionByTitles(trimmed, ['确认问题']);
    const remainingSection = findMarkdownSectionByTitles(trimmed, [
      '需要主代理继续确认',
      '需要主代理确认',
    ]);
    const findings: RepoReviewRunFinding[] =
      splitRepoReviewMarkdownFindingBlocks(findingsSection).flatMap((block) => {
        const severity: RepoReviewRunFinding['severity'] = block.includes('🔴')
          ? 'high'
          : block.includes('🔵')
            ? 'low'
            : 'medium';
        const parsedFinding = parseRepoReviewMarkdownFindingBlock(
          block,
          severity,
        );
        if (!parsedFinding) return [];
        return [
          {
            ...parsedFinding,
            file: filePath,
          } as RepoReviewRunFinding,
        ];
      });
    const summary =
      conclusionSection ||
      markdownLines.find((line) => normalizeRepoReviewMarkdownHeading(line)) ||
      t('repoReview.auto_e2c4df', {}, undefined);
    const confidence = parseRepoReviewSubagentConfidence(trimmed);
    const overallImpact = findings.some(
      (finding) => finding.severity === 'high',
    )
      ? 'fail'
      : findings.some((finding) => finding.severity === 'medium')
        ? 'warn'
        : 'none';
    return {
      summary,
      findings,
      suggestions: extractMarkdownBulletValues(remainingSection),
      scopeLimitations: normalizeReviewScopeLimitations([
        remainingSection || '',
        t(
          'repoReview.fullFileReviewParseFailed',
          {
            file: filePath,
            error: err instanceof Error ? err.message : String(err),
          },
          undefined,
        ),
        `置信度：${confidence}`,
      ]),
      overallImpact,
      recommendedBlock: overallImpact === 'fail',
    };
  }
}

function buildSupplementalExecutionResult(
  filePath: string,
  parsed: RepoReviewSupplementalFileReviewResult,
  failed = false,
  extraScopeLimitations: string[] = [],
): RepoReviewSupplementalExecutionResult {
  const suggestions = [
    ...parsed.suggestions,
    ...parsed.findings
      .map((finding) => stringValue(finding.suggestion))
      .filter(Boolean),
  ];
  return {
    fileReview: {
      file: filePath,
      summary: parsed.summary,
    },
    findings: parsed.findings,
    scopeLimitations: normalizeReviewScopeLimitations([
      ...extraScopeLimitations,
      ...parsed.scopeLimitations,
    ]),
    suggestions,
    recommendedBlock: parsed.recommendedBlock,
    overallImpact: parsed.overallImpact,
    failed,
  };
}

function buildSupplementalUnreadableFileResult(
  filePath: string,
): RepoReviewSupplementalExecutionResult {
  return {
    fileReview: {
      file: filePath,
      summary: t('repoReview.auto_d6c4a0', {}, undefined),
    },
    findings: [],
    scopeLimitations: [
      t('repoReview.fullFileContentReadFailed', { file: filePath }, undefined),
    ],
    suggestions: [],
    recommendedBlock: false,
    overallImpact: 'none',
    failed: true,
  };
}

function hasRepoReviewSubagentUsage(turns: RepoReviewAssistantTurn[]): boolean {
  return turns.some((turn) =>
    turn.items.some(
      (item) =>
        item.type === 'tool_call' &&
        Boolean(item.subagentInfo?.agentName) &&
        (item.title === 'Agent' || item.title === 'TeamCreate'),
    ),
  );
}

function parseSupplementalBatchFileReviewResults(
  text: string,
  expectedFilePaths: Set<string>,
): {
  resultsByFile: Map<string, RepoReviewSupplementalExecutionResult>;
  scopeLimitations: string[];
} {
  try {
    const parsed = JSON.parse(extractJsonObject(text)) as Record<
      string,
      unknown
    >;
    const entries = Array.isArray(parsed.files)
      ? parsed.files
      : Array.isArray(parsed.results)
        ? parsed.results
        : [];
    const resultsByFile = new Map<
      string,
      RepoReviewSupplementalExecutionResult
    >();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const filePath =
        stringValue(record.file) ||
        stringValue(record.file_path) ||
        stringValue(record.path);
      if (
        !filePath ||
        !expectedFilePaths.has(filePath) ||
        resultsByFile.has(filePath)
      ) {
        continue;
      }
      const parsedFileReview = parseSupplementalFileReviewResult(
        JSON.stringify(record),
        filePath,
      );
      resultsByFile.set(
        filePath,
        buildSupplementalExecutionResult(filePath, parsedFileReview),
      );
    }
    return {
      resultsByFile,
      scopeLimitations: normalizeReviewScopeLimitations(
        parsed.scope_limitations || parsed.scopeLimitations,
      ),
    };
  } catch (err) {
    return {
      resultsByFile: new Map<string, RepoReviewSupplementalExecutionResult>(),
      scopeLimitations: [
        t(
          'repoReview.orchestratorParseFailed',
          { error: err instanceof Error ? err.message : String(err) },
          undefined,
        ),
      ],
    };
  }
}

function buildRemoteTrackingRef(remoteName: string, branch: string): string {
  return `refs/remotes/${remoteName}/${normalizeBranchName(branch)}`;
}

function resolveLocalRemoteDefaultBranch(
  repository: ReviewRepositoryRecord,
): string {
  return getLocalGitRemoteMetadata(repository).defaultBranch;
}

function listLocalRemoteBranches(repository: ReviewRepositoryRecord): string[] {
  const repoPath = resolveRepositoryLocalRepoPath(repository);
  const remoteName = resolveRepositoryRemoteName(repository);
  if (!repoPath || !remoteName) return [];
  return runGitCommand(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    true,
  )
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== remoteName)
    .filter((entry) => !entry.startsWith(`${remoteName}/HEAD`))
    .map((entry) => normalizeBranchName(entry.replace(`${remoteName}/`, '')))
    .filter(Boolean);
}

function listLocalRemoteBranchSummaries(
  repository: ReviewRepositoryRecord,
): RepoReviewBranchSummary[] {
  const repoPath = resolveRepositoryLocalRepoPath(repository);
  const remoteName = resolveRepositoryRemoteName(repository);
  if (!repoPath || !remoteName) return [];
  const defaultBranch = resolveLocalRemoteDefaultBranch(repository);
  const payload = runGitCommand(
    repoPath,
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(authorname)%00%(subject)%00%(authordate:iso-strict)%00%(parent)',
      `refs/remotes/${remoteName}`,
    ],
    true,
  );
  return payload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [refName, headSha, actor, title, latestCommitAt, parentsLine] =
        line.split('\0');
      const shortRef = stringValue(refName);
      if (!shortRef || shortRef === remoteName) return null;
      if (shortRef.startsWith(`${remoteName}/HEAD`)) return null;
      const name = normalizeBranchName(shortRef.replace(`${remoteName}/`, ''));
      if (!name) return null;
      return {
        name,
        headSha: stringValue(headSha),
        parentSha: stringValue(parentsLine).split(/\s+/)[0] || '',
        actor: stringValue(actor),
        title: stringValue(title),
        latestCommitAt: stringValue(latestCommitAt),
        defaultBranch: name === defaultBranch,
      };
    })
    .filter((entry): entry is RepoReviewBranchSummary => Boolean(entry))
    .sort(compareRepoReviewBranchSummaries);
}

async function fetchLocalRemoteBranchHead(
  repository: ReviewRepositoryRecord,
  branch: string,
): Promise<{
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
}> {
  const repoPath = resolveRepositoryLocalRepoPath(repository);
  const remoteName = resolveRepositoryRemoteName(repository);
  const normalizedBranch = normalizeBranchName(branch);
  if (!repoPath || !remoteName || !normalizedBranch) {
    return {
      headSha: '',
      parentSha: '',
      actor: '',
      title: '',
      latestCommitAt: '',
    };
  }
  const ref = buildRemoteTrackingRef(remoteName, normalizedBranch);
  const payload = await runGitCommandAsync(
    repoPath,
    ['log', '-1', '--format=%H%n%P%n%an%n%s%n%aI', ref],
    true,
  );
  const [headSha, parentsLine, actor, title, latestCommitAt] =
    payload.split('\n');
  return {
    headSha: stringValue(headSha),
    parentSha: stringValue(parentsLine).split(/\s+/)[0] || '',
    actor: stringValue(actor),
    title: stringValue(title),
    latestCommitAt: stringValue(latestCommitAt),
  };
}

async function fetchLocalRemoteBranchCommitDetails(
  repository: ReviewRepositoryRecord,
  branch: string,
  limit = 10,
): Promise<RepoReviewCommitInfo[]> {
  const repoPath = resolveRepositoryLocalRepoPath(repository);
  const remoteName = resolveRepositoryRemoteName(repository);
  const normalizedBranch = normalizeBranchName(branch);
  if (!repoPath || !remoteName || !normalizedBranch) return [];
  const ref = buildRemoteTrackingRef(remoteName, normalizedBranch);
  const payload = await runGitCommandAsync(
    repoPath,
    [
      'log',
      `-n`,
      String(Math.max(1, Math.min(limit, 100))),
      '--format=%H%x1f%an%x1f%aI%x1f%s',
      ref,
    ],
    true,
  );
  return payload
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, timestamp, title] = line.split('\x1f');
      return {
        commit: shortSha(stringValue(sha)),
        sha: stringValue(sha) || undefined,
        title: stringValue(title),
        author: stringValue(author),
        message: stringValue(title),
        url: '',
        timestamp: stringValue(timestamp),
      };
    });
}

async function resolveLocalRemoteReviewContext(
  repository: ReviewRepositoryRecord,
  event: RepoReviewEvent,
): Promise<ReviewPreparedContext> {
  const repoPath = resolveRepositoryLocalRepoPath(repository);
  if (!repoPath) {
    throw new Error('Local repo path is not configured');
  }
  const branch =
    normalizeBranchName(event.branch || '') ||
    normalizeBranchName(repository.default_target_branch || '') ||
    'main';
  const branchHead = await fetchLocalRemoteBranchHead(repository, branch);
  const headSha = stringValue(event.headSha) || branchHead.headSha;
  if (!headSha) {
    throw new Error(`Unable to resolve remote head for ${branch}`);
  }
  const fallbackParent =
    branchHead.parentSha ||
    (await runGitCommandAsync(repoPath, ['rev-parse', `${headSha}^`], true));
  const baseSha = stringValue(event.baseSha) || fallbackParent;
  const diffRange = baseSha ? `${baseSha}..${headSha}` : `${headSha}^!`;
  const eventCommitSummaryLines = readEventCommitSummaryLines(event);
  const commitSummaryLines =
    eventCommitSummaryLines.length > 0
      ? eventCommitSummaryLines
      : (
          await runGitCommandAsync(
            repoPath,
            ['log', '--format=%h %s', diffRange],
            true,
          )
        )
          .split('\n')
          .map((entry) => trimMessageLine(entry))
          .filter(Boolean)
          .slice(0, 20);
  const commitDetails =
    readEventCommitDetails(event).length > 0
      ? readEventCommitDetails(event)
      : (
          await runGitCommandAsync(
            repoPath,
            ['log', '--format=%H%x1f%an%x1f%aI%x1f%s', diffRange],
            true,
          )
        )
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [sha, author, timestamp, title] = entry.split('\x1f');
            return {
              commit: shortSha(stringValue(sha)),
              title: stringValue(title),
              author: stringValue(author),
              message: stringValue(title),
              url: '',
              timestamp: stringValue(timestamp),
            };
          });
  return {
    diffText: await runGitCommandAsync(
      repoPath,
      ['diff', '--find-renames', '--no-color', diffRange],
      true,
    ),
    changedFiles: (
      await runGitCommandAsync(
        repoPath,
        ['diff', '--name-only', diffRange],
        true,
      )
    )
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
    baseSha,
    headSha,
    branch,
    ref: event.ref || `refs/heads/${branch}`,
    actor:
      stringValue(event.actor) || commitDetails[0]?.author || branchHead.actor,
    commitSummaryLines,
    commitDetails,
    projectContextBlocks: [],
  };
}

function trimMessageLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCommitSummaryLines(value: unknown): string[] {
  return normalizeStringArray(value)
    .map((entry) => trimMessageLine(entry))
    .filter(Boolean)
    .slice(0, 20);
}

function firstLine(value: string): string {
  return trimMessageLine(value.split('\n')[0] || '');
}

function readEventCommitSummaryLines(event: RepoReviewEvent): string[] {
  const context = asRecord(event.callbackContext);
  const commitDetails = normalizeCommitInfoArray(context.commitDetails);
  if (commitDetails.length > 0) {
    return commitDetails
      .map((entry) =>
        trimMessageLine(
          `${entry.commit || '(no-sha)'} ${entry.title}${entry.author ? ` · ${entry.author}` : ''}`,
        ),
      )
      .slice(0, 20);
  }
  const lines = normalizeCommitSummaryLines(context.commitSummaryLines);
  if (lines.length > 0) return lines;
  const title = stringValue(context.title);
  if (title) {
    return [event.prMrNumber ? `#${event.prMrNumber} ${title}` : title];
  }
  return [];
}

function readEventCommitDetails(
  event: RepoReviewEvent,
): RepoReviewCommitInfo[] {
  return normalizeCommitInfoArray(
    asRecord(event.callbackContext).commitDetails,
  );
}

function mergeCallbackContext(
  original: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(original || {}),
    ...patch,
  };
}

const REPO_REVIEW_RERUN_RESET_KEYS = new Set([
  'commitSummaryLines',
  'commitDetails',
  'reviewTurns',
  'reviewProgress',
  'scopeLimitations',
  'fileReviews',
  'commitReviews',
  'executionStats',
]);

export function stripRepoReviewExecutionContext(
  callbackContext: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(callbackContext || {}) };
  for (const key of REPO_REVIEW_RERUN_RESET_KEYS) {
    delete next[key];
  }
  return next;
}

async function persistRepoReviewRunProgressStep(input: {
  runId: string;
  id: string;
  label: string;
  kind?: RepoReviewProgressStepKind;
  status: RepoReviewProgressStep['status'];
  detail?: string;
  inputText?: string;
  outputText?: string;
  metadataText?: string;
  error?: string;
}): Promise<void> {
  const run = await getReviewRunById(input.runId);
  if (!run) return;
  const parsed = await parseReviewRunRecord(run);
  const callbackContext = asRecord(parsed.callbackContext);
  const existingProgress = normalizeRepoReviewProgressSnapshot(
    asRecord(callbackContext).reviewProgress,
  );
  const steps = upsertRepoReviewProgressStep(existingProgress?.steps || [], {
    id: input.id,
    label: input.label,
    kind: input.kind,
    status: input.status,
    detail: input.detail,
    inputText: input.inputText,
    outputText: input.outputText,
    metadataText: input.metadataText,
    error: input.error,
  });
  await updateReviewRun(input.runId, {
    callback_context: mergeCallbackContext(callbackContext, {
      reviewProgress: {
        turnCount: existingProgress?.turnCount || 0,
        latestAssistantText: existingProgress?.latestAssistantText || '',
        latestErrorText: existingProgress?.latestErrorText || null,
        hasTerminalOutput: Boolean(existingProgress?.hasTerminalOutput),
        steps,
      } satisfies RepoReviewProgressSnapshot,
    }),
  });
}

function withManualReviewContext(
  callbackContext: Record<string, unknown> | null | undefined,
  input: RepoReviewManualReviewOptions & {
    baselineRef?: string;
    baselineLabel?: string;
  },
): Record<string, unknown> {
  const baselineMode = normalizeManualReviewBaselineMode(input.baselineMode);
  const reviewMode = normalizeManualReviewMode(input.reviewMode);
  return mergeCallbackContext(callbackContext, {
    manualReview: {
      baselineMode,
      baselineRunId: stringValue(input.baselineRunId) || null,
      baselineSha: stringValue(input.baselineSha) || null,
      reviewMode,
      allowRepeat: Boolean(input.allowRepeat),
      key: buildManualReviewKey(
        {
          baselineMode,
          baselineRunId: stringValue(input.baselineRunId) || undefined,
          baselineSha: stringValue(input.baselineSha) || undefined,
          reviewMode,
          allowRepeat: Boolean(input.allowRepeat),
        },
        '',
      ),
    },
    baselineRef: stringValue(input.baselineRef) || null,
    baselineLabel: stringValue(input.baselineLabel) || null,
  });
}

function markQueuedRemoteReviewContext(
  event: RepoReviewEvent,
): Record<string, unknown> {
  return mergeCallbackContext(event.callbackContext, {
    [QUEUED_REMOTE_REVIEW_CONTEXT_KEY]: {
      replayEligible: true,
      blockingExpected: event.blockingExpected,
    },
  });
}

function parseQueuedRemoteReviewContext(
  callbackContext: Record<string, unknown> | null | undefined,
): {
  replayEligible: boolean;
  blockingExpected: boolean;
} | null {
  const queuedContext =
    asRecord(callbackContext)[QUEUED_REMOTE_REVIEW_CONTEXT_KEY];
  const record = asRecord(queuedContext);
  if (!normalizeBoolean(record.replayEligible)) return null;
  return {
    replayEligible: true,
    blockingExpected: normalizeBoolean(record.blockingExpected),
  };
}

async function resolveLocalActor(
  repoPath: string,
  event: RepoReviewEvent,
): Promise<string> {
  const fromEvent = stringValue(event.actor);
  if (fromEvent) return fromEvent;
  const localName = await runGitCommandAsync(
    repoPath,
    ['config', '--local', '--get', 'user.name'],
    true,
  );
  if (localName) return localName;
  const localEmail = await runGitCommandAsync(
    repoPath,
    ['config', '--local', '--get', 'user.email'],
    true,
  );
  if (localEmail) return localEmail;
  const name = await runGitCommandAsync(
    repoPath,
    ['config', '--get', 'user.name'],
    true,
  );
  if (name) return name;
  const email = await runGitCommandAsync(
    repoPath,
    ['config', '--get', 'user.email'],
    true,
  );
  return email || t('repoReview.auto_52f7ba', {}, undefined);
}

function branchMatchesProfile(
  profile: RepoReviewProfile,
  branch: string,
): boolean {
  const targets = normalizeTargetBranches(profile.targetBranches);
  if (targets.length === 0) return true;
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) return false;
  return targets.includes(normalizedBranch);
}

function normalizeTargetBranches(branches: string[]): string[] {
  return Array.from(
    new Set(
      branches.map((entry) => normalizeBranchName(entry)).filter(Boolean),
    ),
  );
}

function hasAllBranchesTarget(profile: RepoReviewProfile): boolean {
  return normalizeTargetBranches(profile.targetBranches).length === 0;
}

function profileSupportsRemotePushReview(profile: RepoReviewProfile): boolean {
  return (
    profile.enabled &&
    profile.stage === 'push' &&
    (profile.sourceMode === 'remote' || profile.sourceMode === 'both')
  );
}

function isBranchActiveWithinWindow(
  latestCommitAt: string,
  activeWindowDays: number,
  now = new Date(),
): boolean {
  if (!latestCommitAt) return true;
  const timestamp = Date.parse(latestCommitAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp >= now.getTime() - activeWindowDays * 24 * 60 * 60 * 1000;
}

function summarizeBranchTriggerResults(
  branches: RepoReviewBranchTriggerResult[],
  activeWindowDays = 0,
): RepoReviewBranchTriggerSummary {
  const skippedReasonCounts = new Map<string, number>();
  const errorReasonCounts = new Map<string, number>();
  let triggered = 0;
  let skipped = 0;
  let failed = 0;

  for (const branch of branches) {
    if (branch.status === 'triggered') {
      triggered += 1;
      continue;
    }
    if (branch.status === 'skipped') {
      skipped += 1;
      skippedReasonCounts.set(
        branch.reason,
        (skippedReasonCounts.get(branch.reason) || 0) + 1,
      );
      continue;
    }
    failed += 1;
    errorReasonCounts.set(
      branch.reason,
      (errorReasonCounts.get(branch.reason) || 0) + 1,
    );
  }

  const toSortedEntries = (source: Map<string, number>) =>
    Array.from(source.entries())
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        return left[0].localeCompare(right[0], 'zh-Hans-CN');
      })
      .map(([reason, count]) => ({ reason, count }));

  return {
    branches,
    triggered,
    skipped,
    failed,
    skippedReasons: toSortedEntries(skippedReasonCounts),
    errorReasons: toSortedEntries(errorReasonCounts),
    activeWindowDays,
  };
}

function resolveRemoteSyncBranches(input: {
  profiles: RepoReviewProfile[];
  remoteBranches: string[];
  defaultBranch: string;
}): string[] {
  const hasAllBranchesProfile = input.profiles.some((profile) =>
    hasAllBranchesTarget(profile),
  );
  const branches = hasAllBranchesProfile
    ? input.remoteBranches
    : input.profiles.flatMap((profile) =>
        normalizeTargetBranches(profile.targetBranches),
      );
  const normalized = Array.from(
    new Set(
      branches.map((branch) => normalizeBranchName(branch)).filter(Boolean),
    ),
  );
  if (normalized.length > 0) return normalized;
  return input.defaultBranch ? [input.defaultBranch] : [];
}

function resolveEventBranchHint(
  repository: ReviewRepositoryRecord,
  event: RepoReviewEvent,
): string {
  if (event.branch) return normalizeBranchName(event.branch);
  if (event.ref) return normalizeBranchName(event.ref);
  if (event.source === 'local-hook' && repository.local_repo_path) {
    return (
      runGitCommand(
        repository.local_repo_path,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        true,
      ) ||
      runGitCommand(
        repository.local_repo_path,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        true,
      ) ||
      ''
    );
  }
  return '';
}

async function selectMatchingProfileRecord(
  repository: ReviewRepositoryRecord,
  event: RepoReviewEvent,
): Promise<ReviewProfileRecord | undefined> {
  if (event.profileId) {
    return requireProfile(event.profileId);
  }
  const trigger = stringValue(asRecord(event.callbackContext).trigger);
  const branch = resolveEventBranchHint(repository, event);
  const matchingRecords = await listMatchingReviewProfiles({
    repositoryId: event.repositoryId,
    stage: event.stage,
    sourceMode: event.source === 'local-hook' ? 'local' : 'remote',
  });
  const candidates = (
    await Promise.all(
      matchingRecords.map(async (record) => ({
        record,
        profile: await normalizeProfileRecord(record),
      })),
    )
  ).sort((left, right) => {
    const leftSpecific = left.profile.targetBranches.length > 0 ? 1 : 0;
    const rightSpecific = right.profile.targetBranches.length > 0 ? 1 : 0;
    if (rightSpecific !== leftSpecific) {
      return rightSpecific - leftSpecific;
    }
    const leftGenerated =
      left.record.name === 'Commit Local Default' ||
      left.record.name === 'Push Remote Default';
    const rightGenerated =
      right.record.name === 'Commit Local Default' ||
      right.record.name === 'Push Remote Default';
    if (leftGenerated !== rightGenerated) {
      return leftGenerated ? 1 : -1;
    }
    const updatedAtDelta = right.record.updated_at.localeCompare(
      left.record.updated_at,
    );
    if (updatedAtDelta !== 0) {
      return updatedAtDelta;
    }
    return right.record.created_at.localeCompare(left.record.created_at);
  });
  const matching = candidates.filter(({ profile }) =>
    branchMatchesProfile(profile, branch),
  );
  if (trigger !== 'manual-sync') {
    return matching[0]?.record;
  }
  return (matching[0] || candidates[0])?.record;
}

async function resolveLocalReviewContext(
  repository: RepoReviewRepository,
  profile: RepoReviewProfile,
  event: RepoReviewEvent,
): Promise<ReviewPreparedContext> {
  const repoPath = repository.localRepoPath;
  if (!repoPath) {
    throw new Error('Local repo path is not configured');
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Local repo path does not exist: ${repoPath}`);
  }
  const branch =
    normalizeBranchName(event.branch || '') ||
    (await runGitCommandAsync(
      repoPath,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      true,
    )) ||
    (await runGitCommandAsync(
      repoPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      true,
    )) ||
    'HEAD';
  const headSha =
    event.headSha ||
    (await runGitCommandAsync(repoPath, ['rev-parse', 'HEAD'], true));
  const actor = await resolveLocalActor(repoPath, event);

  if (event.stage === 'commit' || profile.reviewScope === 'staged_diff') {
    const eventCommitSummaryLines = readEventCommitSummaryLines(event);
    return {
      diffText:
        event.diffText ||
        (await runGitCommandAsync(repoPath, [
          'diff',
          '--cached',
          '--find-renames',
          '--no-color',
        ])),
      changedFiles:
        event.changedFiles ||
        (
          await runGitCommandAsync(repoPath, [
            'diff',
            '--cached',
            '--name-only',
          ])
        )
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean),
      baseSha: event.baseSha || '',
      headSha,
      branch,
      ref: event.ref || `refs/heads/${branch}`,
      actor,
      commitSummaryLines:
        eventCommitSummaryLines.length > 0
          ? eventCommitSummaryLines
          : [t('repoReview.auto_f95376', {}, undefined)],
      commitDetails: readEventCommitDetails(event),
      projectContextBlocks: [],
    };
  }

  let upstream =
    (await runGitCommandAsync(
      repoPath,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      true,
    )) || '';
  if (!upstream) {
    const fallbackBranch = repository.defaultTargetBranch || 'main';
    const candidates = [`origin/${fallbackBranch}`, fallbackBranch];
    for (const entry of candidates) {
      if (
        await runGitCommandAsync(
          repoPath,
          ['rev-parse', '--verify', entry],
          true,
        )
      ) {
        upstream = entry;
        break;
      }
    }
  }
  if (!upstream) {
    // No upstream found — use the empty tree SHA as the base so the diff
    // shows all files in the current tree rather than producing an empty diff
    // (which would happen if baseSha == headSha).
    upstream = '4b825dc642cb6eb9a060e54bf899d69f82b63154';
  }
  const baseSha =
    event.baseSha ||
    (await runGitCommandAsync(
      repoPath,
      ['merge-base', 'HEAD', upstream],
      true,
    )) ||
    upstream;
  const diffRange = baseSha ? `${baseSha}..HEAD` : 'HEAD';
  const eventCommitSummaryLines = readEventCommitSummaryLines(event);
  const commitSummaryLines =
    eventCommitSummaryLines.length > 0
      ? eventCommitSummaryLines
      : (
          await runGitCommandAsync(
            repoPath,
            ['log', '--format=%h %s', diffRange],
            true,
          )
        )
          .split('\n')
          .map((entry) => trimMessageLine(entry))
          .filter(Boolean)
          .slice(0, 20);
  return {
    diffText:
      event.diffText ||
      (await runGitCommandAsync(repoPath, [
        'diff',
        '--find-renames',
        '--no-color',
        diffRange,
      ])),
    changedFiles:
      event.changedFiles ||
      (await runGitCommandAsync(repoPath, ['diff', '--name-only', diffRange]))
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean),
    baseSha,
    headSha,
    branch,
    ref: event.ref || `refs/heads/${branch}`,
    actor,
    commitSummaryLines,
    commitDetails: readEventCommitDetails(event),
    projectContextBlocks: [],
  };
}

const wildcardRegexCache = new Map<string, RegExp>();

function wildcardToRegex(pattern: string): RegExp {
  let cached = wildcardRegexCache.get(pattern);
  if (!cached) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    cached = new RegExp(`^${regex}$`);
    wildcardRegexCache.set(pattern, cached);
  }
  return cached;
}

function filterChangedFiles(
  files: string[],
  includeGlobs: string[],
  excludeGlobs: string[],
): string[] {
  let next = files;
  if (includeGlobs.length > 0) {
    const patterns = includeGlobs.map(wildcardToRegex);
    next = next.filter((file) =>
      patterns.some((pattern) => pattern.test(file)),
    );
  }
  if (excludeGlobs.length > 0) {
    const patterns = excludeGlobs.map(wildcardToRegex);
    next = next.filter(
      (file) => !patterns.some((pattern) => pattern.test(file)),
    );
  }
  return next;
}

function buildFilteredDiff(
  diffText: string,
  allowedFiles: Set<string>,
  diffIndex?: ReviewPreparedContext['diffIndex'],
): string {
  if (allowedFiles.size === 0) return '';
  if (diffIndex) {
    const requestedFiles = Array.from(allowedFiles);
    const hasCompleteCoverage = requestedFiles.every((filePath) =>
      diffIndex.entriesByFile.has(filePath),
    );
    if (hasCompleteCoverage) {
      const sliced = getRepoReviewDiffSlice(diffIndex, requestedFiles);
      if (sliced.trim()) return sliced;
    }
  }
  const lines = diffText.split('\n');
  const kept: string[] = [];
  let currentFile: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentFile && allowedFiles.has(currentFile)) {
      kept.push(...buffer);
    }
    currentFile = null;
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match?.[2] || match?.[1] || null;
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return kept.join('\n').trim();
}

function summarizeRepoReviewDiffSlice(diffText: string): {
  added: number;
  removed: number;
  hunks: number;
} {
  const lines = String(diffText || '').split('\n');
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      hunks += 1;
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      added += 1;
      continue;
    }
    if (line.startsWith('-')) {
      removed += 1;
    }
  }
  return { added, removed, hunks };
}

function buildRepoReviewDiffSummaryBlock(input: {
  prepared?: ReviewPreparedContext;
  summary?: ReviewEvidenceBundle['diffSummary'];
}): string {
  const summary =
    input.summary ||
    (input.prepared
      ? buildRepoReviewDiffSummary(input.prepared)
      : {
          fileCount: 0,
          hunkCount: 0,
          addedLines: 0,
          removedLines: 0,
          diffBytes: 0,
          files: [],
        });
  const lines: string[] = [];
  for (const file of summary.files) {
    lines.push(
      `- ${file.filePath} | +${file.addedLines} / -${file.removedLines} | hunks ${file.hunkCount} | ${file.estimatedBytes} bytes`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : '- (none)';
}

type ReviewCodeIndexContextData = Pick<
  CodeIndexSnapshot,
  'meta' | 'files' | 'functions' | 'functionEdges'
>;

function ensureRepoReviewDiffIndex(
  prepared: ReviewPreparedContext,
): NonNullable<ReviewPreparedContext['diffIndex']> {
  const existing = prepared.diffIndex;
  if (
    existing &&
    Array.isArray((existing as { hunks?: unknown }).hunks) &&
    (existing as { hunksByFile?: unknown }).hunksByFile instanceof Map
  ) {
    return existing;
  }
  return buildRepoReviewDiffIndex(prepared.diffText || '');
}

function buildRepoReviewDiffSummary(
  prepared: ReviewPreparedContext,
): ReviewEvidenceBundle['diffSummary'] {
  const diffIndex = ensureRepoReviewDiffIndex(prepared);
  const files = prepared.changedFiles.map((filePath) => {
    const slice = getRepoReviewDiffSlice(diffIndex, [filePath]);
    const summary = summarizeRepoReviewDiffSlice(slice);
    const hunkCount =
      (diffIndex.hunksByFile.get(filePath) || []).length || summary.hunks;
    return {
      filePath,
      addedLines: summary.added,
      removedLines: summary.removed,
      hunkCount,
      estimatedBytes:
        diffIndex.entriesByFile.get(filePath)?.estimatedBytes ||
        Buffer.byteLength(slice || '', 'utf8'),
    };
  });
  return {
    fileCount: files.length,
    hunkCount: files.reduce((total, file) => total + file.hunkCount, 0),
    addedLines: files.reduce((total, file) => total + file.addedLines, 0),
    removedLines: files.reduce((total, file) => total + file.removedLines, 0),
    diffBytes: Buffer.byteLength(prepared.diffText || '', 'utf8'),
    files,
  };
}

function toReviewEvidenceChangedHunk(
  hunk: RepoReviewDiffHunkEntry,
): ReviewEvidenceChangedHunk {
  return {
    filePath: hunk.filePath,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLineCount: hunk.oldLineCount,
    oldEnd: hunk.oldEnd,
    newStart: hunk.newStart,
    newLineCount: hunk.newLineCount,
    newEnd: hunk.newEnd,
    addedLineNumbers: hunk.addedLineNumbers,
    removedLineNumbers: hunk.removedLineNumbers,
  };
}

function getRepoReviewHunkChangedLineNumbers(
  hunk: ReviewEvidenceChangedHunk,
): number[] {
  const lines = new Set<number>();
  for (const line of hunk.addedLineNumbers) {
    if (line > 0) lines.add(line);
  }
  if (lines.size === 0) {
    const end = hunk.newLineCount > 0 ? hunk.newEnd : hunk.newStart;
    for (let line = hunk.newStart; line <= end; line += 1) {
      if (line > 0) lines.add(line);
    }
  }
  if (lines.size === 0 && hunk.newStart > 0) {
    lines.add(hunk.newStart);
  }
  return Array.from(lines.values()).sort((left, right) => left - right);
}

function hunkIntersectsCodeIndexFunction(
  hunk: ReviewEvidenceChangedHunk,
  fn: CodeIndexFunctionRecord,
): boolean {
  if (hunk.filePath !== fn.filePath) return false;
  const changedLines = getRepoReviewHunkChangedLineNumbers(hunk);
  if (changedLines.some((line) => line >= fn.startLine && line <= fn.endLine)) {
    return true;
  }
  const hunkEnd = hunk.newLineCount > 0 ? hunk.newEnd : hunk.newStart;
  return hunk.newStart <= fn.endLine && hunkEnd >= fn.startLine;
}

function toReviewEvidenceImpactFunction(
  fn: CodeIndexFunctionRecord,
  hunks: ReviewEvidenceChangedHunk[],
): ReviewEvidenceImpactFunction {
  const changedLineNumbers = new Set<number>();
  for (const hunk of hunks) {
    for (const line of getRepoReviewHunkChangedLineNumbers(hunk)) {
      if (line >= fn.startLine && line <= fn.endLine) {
        changedLineNumbers.add(line);
      }
    }
  }
  return {
    id: fn.id,
    filePath: fn.filePath,
    name: fn.name,
    kind: fn.kind,
    signature: fn.signature,
    startLine: fn.startLine,
    endLine: fn.endLine,
    line: fn.line,
    parentFunctionId: fn.parentFunctionId,
    changedHunkCount: hunks.length,
    changedLineNumbers: Array.from(changedLineNumbers.values()).sort(
      (left, right) => left - right,
    ),
  };
}

function toReviewEvidenceFunctionRef(fn: CodeIndexFunctionRecord) {
  return {
    id: fn.id,
    filePath: fn.filePath,
    name: fn.name,
    kind: fn.kind,
    startLine: fn.startLine,
    endLine: fn.endLine,
  };
}

function buildReviewEvidenceFileSymbols(input: {
  codeMapSymbols?: Array<{
    name: string;
    kind: string;
    line: number;
    rank: number;
  }>;
  functions?: CodeIndexFunctionRecord[];
}): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const symbol of [...(input.codeMapSymbols || [])]
    .sort((left, right) => right.rank - left.rank)
    .slice(0, 6)) {
    const label = `${symbol.kind} ${symbol.name}@${symbol.line}`;
    if (seen.has(label)) continue;
    seen.add(label);
    symbols.push(label);
  }
  for (const fn of (input.functions || []).slice(0, 6)) {
    const label = `${fn.kind} ${fn.name}@${fn.line}`;
    if (seen.has(label)) continue;
    seen.add(label);
    symbols.push(label);
  }
  return symbols.slice(0, 6);
}

function buildReviewEvidenceFileImpact(input: {
  changedFiles: string[];
  codeMapSnapshot: CodeMapSnapshot | null;
  codeIndexSnapshot: ReviewCodeIndexContextData | null;
}): {
  fileImpact: NonNullable<ReviewEvidenceBundle['fileImpact']>;
  missingContext: string[];
} {
  const missingContext: string[] = [];
  const changedFileSet = new Set(input.changedFiles);
  const functionsById = new Map(
    (input.codeIndexSnapshot?.functions || []).map((fn) => [fn.id, fn]),
  );
  const functionsByFile = new Map<string, CodeIndexFunctionRecord[]>();
  for (const fn of input.codeIndexSnapshot?.functions || []) {
    const entries = functionsByFile.get(fn.filePath) || [];
    entries.push(fn);
    functionsByFile.set(fn.filePath, entries);
  }

  const nodeMap = new Map<
    string,
    {
      filePath: string;
      language: string;
      rank: number;
      lineCount: number;
      importCount: number;
      exportCount: number;
      topSymbols: string[];
      summary?: string;
    }
  >();
  for (const file of input.codeIndexSnapshot?.files || []) {
    nodeMap.set(file.relativePath, {
      filePath: file.relativePath,
      language: file.language,
      rank: file.rank,
      lineCount: file.lineCount,
      importCount: file.importCount,
      exportCount: file.exportCount,
      summary: file.summary || undefined,
      topSymbols: buildReviewEvidenceFileSymbols({
        functions: functionsByFile.get(file.relativePath) || [],
      }),
    });
  }
  for (const file of input.codeMapSnapshot?.files || []) {
    const existing = nodeMap.get(file.relativePath);
    nodeMap.set(file.relativePath, {
      filePath: file.relativePath,
      language: file.language || existing?.language || 'text',
      rank: file.rank || existing?.rank || 0,
      lineCount: file.lineCount || existing?.lineCount || 0,
      importCount: file.importCount ?? existing?.importCount ?? 0,
      exportCount: file.exportCount ?? existing?.exportCount ?? 0,
      summary: existing?.summary,
      topSymbols: buildReviewEvidenceFileSymbols({
        codeMapSymbols: file.symbols,
        functions: functionsByFile.get(file.relativePath) || [],
      }),
    });
  }

  const edgeMap = new Map<
    string,
    { fromFile: string; toFile: string; symbols: Set<string> }
  >();
  const pushEdge = (fromFile: string, toFile: string, symbols: string[]) => {
    if (!fromFile || !toFile) return;
    const key = `${fromFile}\0${toFile}`;
    const existing = edgeMap.get(key) || {
      fromFile,
      toFile,
      symbols: new Set<string>(),
    };
    for (const symbol of symbols) {
      if (symbol) existing.symbols.add(symbol);
    }
    edgeMap.set(key, existing);
  };
  for (const edge of input.codeMapSnapshot?.edges || []) {
    pushEdge(edge.fromFile, edge.toFile, edge.symbols);
  }
  for (const edge of input.codeIndexSnapshot?.functionEdges || []) {
    const from = functionsById.get(edge.fromFunctionId);
    const to = functionsById.get(edge.toFunctionId);
    if (!from?.filePath || !to?.filePath || from.filePath === to.filePath) {
      continue;
    }
    pushEdge(from.filePath, to.filePath, [edge.symbol || to.name || 'call']);
  }

  const incomingByFile = new Map<string, number>();
  const outgoingByFile = new Map<string, number>();
  for (const edge of edgeMap.values()) {
    outgoingByFile.set(
      edge.fromFile,
      (outgoingByFile.get(edge.fromFile) || 0) + 1,
    );
    incomingByFile.set(
      edge.toFile,
      (incomingByFile.get(edge.toFile) || 0) + 1,
    );
  }

  const relatedScores = new Map<string, number>();
  for (const edge of edgeMap.values()) {
    if (changedFileSet.has(edge.fromFile) && !changedFileSet.has(edge.toFile)) {
      relatedScores.set(
        edge.toFile,
        (relatedScores.get(edge.toFile) || 0) + 1 + edge.symbols.size,
      );
    }
    if (changedFileSet.has(edge.toFile) && !changedFileSet.has(edge.fromFile)) {
      relatedScores.set(
        edge.fromFile,
        (relatedScores.get(edge.fromFile) || 0) + 1 + edge.symbols.size,
      );
    }
  }

  const toImpactFile = (
    filePath: string,
    options: { changed: boolean; linkScore?: number },
  ): ReviewEvidenceImpactFile | null => {
    const node = nodeMap.get(filePath);
    if (!node) return null;
    return {
      filePath,
      language: node.language || 'text',
      rank: node.rank || 0,
      lineCount: node.lineCount || 0,
      importCount: node.importCount || 0,
      exportCount: node.exportCount || 0,
      dependentCount: incomingByFile.get(filePath) || 0,
      dependencyCount: outgoingByFile.get(filePath) || 0,
      topSymbols: node.topSymbols,
      changed: options.changed,
      ...(options.linkScore !== undefined
        ? { linkScore: options.linkScore }
        : {}),
      ...(node.summary ? { summary: node.summary } : {}),
    };
  };

  const changedFiles = input.changedFiles
    .map((filePath) => toImpactFile(filePath, { changed: true }))
    .filter((file): file is ReviewEvidenceImpactFile => Boolean(file));
  const relatedFiles = [...relatedScores.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0], 'en');
    })
    .slice(0, 16)
    .map(([filePath, score]) =>
      toImpactFile(filePath, { changed: false, linkScore: score }),
    )
    .filter((file): file is ReviewEvidenceImpactFile => Boolean(file));

  const visibleFiles = new Set<string>([
    ...changedFiles.map((file) => file.filePath),
    ...relatedFiles.map((file) => file.filePath),
  ]);
  const visibleEdges = [...edgeMap.values()]
    .filter(
      (edge) =>
        visibleFiles.has(edge.fromFile) &&
        visibleFiles.has(edge.toFile) &&
        (changedFileSet.has(edge.fromFile) || changedFileSet.has(edge.toFile)),
    )
    .map((edge) => ({
      fromFile: edge.fromFile,
      toFile: edge.toFile,
      symbols: Array.from(edge.symbols.values()).slice(0, 6),
    }))
    .sort((left, right) =>
      left.fromFile === right.fromFile
        ? left.toFile.localeCompare(right.toFile, 'en')
        : left.fromFile.localeCompare(right.fromFile, 'en'),
    );

  if (input.changedFiles.length > 0 && changedFiles.length === 0) {
    missingContext.push(
      '未能为变更文件构建文件级结构画像，可能是索引缺失或变更文件不在当前代码图谱中。',
    );
  }
  if (!input.codeMapSnapshot && input.codeIndexSnapshot) {
    missingContext.push(
      'CodeMap 缺失，文件级影响图回退为 Code Index 函数调用聚合视图。',
    );
  }
  if (!input.codeMapSnapshot && !input.codeIndexSnapshot) {
    missingContext.push('CodeMap 和 Code Index 均不可用，无法构建文件级影响图。');
  }

  return {
    fileImpact: {
      changedFiles,
      relatedFiles,
      edges: visibleEdges,
    },
    missingContext,
  };
}

function buildReviewEvidenceFunctionImpact(input: {
  changedHunks: ReviewEvidenceChangedHunk[];
  codeIndexSnapshot: ReviewCodeIndexContextData | null;
}): {
  changedFunctions: ReviewEvidenceImpactFunction[];
  impactGraph: ReviewEvidenceBundle['impactGraph'];
  missingContext: string[];
} {
  const missingContext: string[] = [];
  const snapshot = input.codeIndexSnapshot;
  if (!snapshot) {
    if (input.changedHunks.length > 0) {
      missingContext.push(
        'Code Index 不可用，无法将 diff hunk 映射到函数或调用邻域。',
      );
    }
    return {
      changedFunctions: [],
      impactGraph: { functions: [], edges: [] },
      missingContext,
    };
  }

  const changedFunctions: ReviewEvidenceImpactFunction[] = [];
  const changedFunctionIds = new Set<string>();
  const hunksByFunctionId = new Map<string, ReviewEvidenceChangedHunk[]>();
  for (const fn of snapshot.functions) {
    const matchingHunks = input.changedHunks.filter((hunk) =>
      hunkIntersectsCodeIndexFunction(hunk, fn),
    );
    if (matchingHunks.length === 0) continue;
    hunksByFunctionId.set(fn.id, matchingHunks);
    changedFunctionIds.add(fn.id);
    changedFunctions.push(toReviewEvidenceImpactFunction(fn, matchingHunks));
  }
  changedFunctions.sort((left, right) =>
    left.filePath === right.filePath
      ? left.startLine - right.startLine
      : left.filePath.localeCompare(right.filePath, 'en'),
  );

  if (input.changedHunks.length > 0 && changedFunctions.length === 0) {
    missingContext.push(
      'Code Index 未定位到被 diff hunk 覆盖的函数，可能是非代码文件、顶层模块改动或索引过期。',
    );
  }

  const functionById = new Map(snapshot.functions.map((fn) => [fn.id, fn]));
  const graphFunctionIds = new Set(changedFunctionIds);
  const edges: ReviewEvidenceBundle['impactGraph']['edges'] = [];
  const seenEdges = new Set<string>();
  const pushEdge = (
    direction: 'upstream' | 'downstream',
    edge: CodeIndexFunctionEdgeRecord,
  ) => {
    const key = `${direction}:${edge.id}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const from = functionById.get(edge.fromFunctionId);
    const to = functionById.get(edge.toFunctionId);
    if (from) graphFunctionIds.add(from.id);
    if (to) graphFunctionIds.add(to.id);
    edges.push({
      direction,
      fromFunctionId: edge.fromFunctionId,
      toFunctionId: edge.toFunctionId,
      symbol: edge.symbol,
      line: edge.line,
      ...(from ? { fromFunction: toReviewEvidenceFunctionRef(from) } : {}),
      ...(to ? { toFunction: toReviewEvidenceFunctionRef(to) } : {}),
    });
  };
  for (const edge of snapshot.functionEdges) {
    if (changedFunctionIds.has(edge.fromFunctionId)) {
      pushEdge('downstream', edge);
    }
    if (changedFunctionIds.has(edge.toFunctionId)) {
      pushEdge('upstream', edge);
    }
  }

  const changedFunctionById = new Map(
    changedFunctions.map((fn) => [fn.id, fn]),
  );
  const graphFunctions = Array.from(graphFunctionIds.values())
    .map((id) => {
      const changed = changedFunctionById.get(id);
      if (changed) return changed;
      const fn = functionById.get(id);
      return fn ? toReviewEvidenceImpactFunction(fn, []) : null;
    })
    .filter((fn): fn is ReviewEvidenceImpactFunction => Boolean(fn))
    .sort((left, right) =>
      left.filePath === right.filePath
        ? left.startLine - right.startLine
        : left.filePath.localeCompare(right.filePath, 'en'),
    );
  return {
    changedFunctions,
    impactGraph: {
      functions: graphFunctions,
      edges,
    },
    missingContext,
  };
}

export function buildRepoReviewCodeMapContextBlock(input: {
  snapshot: CodeMapSnapshot | null;
  repositoryId: string;
  branch: string;
  changedFiles: string[];
}): string {
  const branch = normalizeBranchName(input.branch || '');
  if (!input.snapshot) {
    return [
      'CodeMap 影响图：unavailable',
      `repository_id: ${input.repositoryId}`,
      `branch: ${branch || '(unknown)'}`,
      'reason: missing_snapshot',
    ].join('\n');
  }

  const snapshot = input.snapshot;
  const fileByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file]),
  );
  const changedFileSet = new Set(input.changedFiles);
  const incomingEdgesByFile = new Map<string, typeof snapshot.edges>();
  const outgoingEdgesByFile = new Map<string, typeof snapshot.edges>();
  for (const edge of snapshot.edges) {
    const outgoing = outgoingEdgesByFile.get(edge.fromFile) || [];
    outgoing.push(edge);
    outgoingEdgesByFile.set(edge.fromFile, outgoing);
    const incoming = incomingEdgesByFile.get(edge.toFile) || [];
    incoming.push(edge);
    incomingEdgesByFile.set(edge.toFile, incoming);
  }

  const relatedFileScores = new Map<string, number>();
  for (const filePath of input.changedFiles) {
    for (const edge of outgoingEdgesByFile.get(filePath) || []) {
      if (!changedFileSet.has(edge.toFile)) {
        relatedFileScores.set(
          edge.toFile,
          (relatedFileScores.get(edge.toFile) || 0) + 1,
        );
      }
    }
    for (const edge of incomingEdgesByFile.get(filePath) || []) {
      if (!changedFileSet.has(edge.fromFile)) {
        relatedFileScores.set(
          edge.fromFile,
          (relatedFileScores.get(edge.fromFile) || 0) + 1,
        );
      }
    }
  }

  const lines = [
    'CodeMap 影响图：',
    `status: ready`,
    `branch: ${snapshot.branch || branch || '(unknown)'}`,
    `manifest_hash: ${snapshot.manifestHash || '(unknown)'}`,
    `stats: files=${snapshot.stats.fileCount}, symbols=${snapshot.stats.symbolCount}, edges=${snapshot.stats.edgeCount}`,
    `changed_files_with_map: ${input.changedFiles.filter((file) => fileByPath.has(file)).length}/${input.changedFiles.length}`,
    '',
    '变更文件结构角色：',
  ];

  for (const filePath of input.changedFiles.slice(0, 24)) {
    const file = fileByPath.get(filePath);
    if (!file) {
      lines.push(`- ${filePath}: no_codemap_entry`);
      continue;
    }
    const incoming = incomingEdgesByFile.get(filePath) || [];
    const outgoing = outgoingEdgesByFile.get(filePath) || [];
    const topSymbols = [...file.symbols]
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 6);
    lines.push(
      [
        `- ${filePath}`,
        `language=${file.language || 'text'}`,
        `rank=${file.rank.toFixed(4)}`,
        `lines=${file.lineCount}`,
        `imports=${file.importCount}`,
        `exports=${file.exportCount}`,
        `dependents=${incoming.length}`,
        `dependencies=${outgoing.length}`,
      ].join(' | '),
    );
    if (topSymbols.length > 0) {
      lines.push(
        `  top_symbols: ${topSymbols
          .map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`)
          .join(', ')}`,
      );
    }
    const relatedEdges = [...incoming, ...outgoing]
      .filter(
        (edge) =>
          changedFileSet.has(edge.fromFile) || changedFileSet.has(edge.toFile),
      )
      .slice(0, 6);
    if (relatedEdges.length > 0) {
      lines.push(
        `  local_edges: ${relatedEdges
          .map((edge) => {
            const symbols =
              edge.symbols.length > 0
                ? ` [${edge.symbols.slice(0, 3).join(', ')}]`
                : '';
            return `${edge.fromFile} -> ${edge.toFile}${symbols}`;
          })
          .join('; ')}`,
      );
    }
  }

  const relatedFiles = [...relatedFileScores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12);
  if (relatedFiles.length > 0) {
    lines.push('', '相关未变更邻居文件（仅作导航线索）：');
    for (const [filePath, score] of relatedFiles) {
      const file = fileByPath.get(filePath);
      lines.push(
        `- ${filePath} | links=${score} | rank=${file ? file.rank.toFixed(4) : 'unknown'}`,
      );
    }
  }
  if (input.changedFiles.length > 24) {
    lines.push(
      `- ...(还有 ${input.changedFiles.length - 24} 个变更文件未展开)`,
    );
  }
  return lines.join('\n');
}

export function buildRepoReviewCodeIndexContextBlock(input: {
  snapshot: ReviewCodeIndexContextData | null;
  repositoryId: string;
  branch: string;
  headSha?: string;
  changedFiles: string[];
}): string {
  const branch = normalizeBranchName(input.branch || '');
  if (!input.snapshot) {
    return [
      'Code Index 上下文：unavailable',
      `repository_id: ${input.repositoryId}`,
      `branch: ${branch || '(unknown)'}`,
      'reason: missing_snapshot',
    ].join('\n');
  }

  const snapshot = input.snapshot;
  const meta = snapshot.meta;
  const sourceHeadSha = stringValue(meta.sourceHeadSha);
  const headSha = stringValue(input.headSha);
  const isReady = meta.status === 'ready' && meta.stage === 'complete';
  const isStale = Boolean(
    sourceHeadSha &&
    headSha &&
    sourceHeadSha !== headSha &&
    !headSha.startsWith(sourceHeadSha) &&
    !sourceHeadSha.startsWith(headSha),
  );
  const fileByPath = new Map(
    snapshot.files.map((file) => [file.relativePath, file]),
  );
  const functionsByFile = new Map<string, typeof snapshot.functions>();
  for (const fn of snapshot.functions) {
    const entries = functionsByFile.get(fn.filePath) || [];
    entries.push(fn);
    functionsByFile.set(fn.filePath, entries);
  }
  const functionById = new Map(snapshot.functions.map((fn) => [fn.id, fn]));
  const incomingByFile = new Map<string, number>();
  const outgoingByFile = new Map<string, number>();
  for (const edge of snapshot.functionEdges) {
    const from = functionById.get(edge.fromFunctionId);
    const to = functionById.get(edge.toFunctionId);
    if (from?.filePath) {
      outgoingByFile.set(
        from.filePath,
        (outgoingByFile.get(from.filePath) || 0) + 1,
      );
    }
    if (to?.filePath) {
      incomingByFile.set(
        to.filePath,
        (incomingByFile.get(to.filePath) || 0) + 1,
      );
    }
  }

  const lines = [
    'Code Index 上下文：',
    `status: ${isReady ? 'ready' : meta.status}`,
    `stage: ${meta.stage}`,
    `source_branch: ${meta.sourceBranch || meta.branch || branch || '(unknown)'}`,
    `source_head_sha: ${sourceHeadSha || '(unknown)'}`,
    `freshness: ${isStale ? 'stale' : 'current_or_unknown'}`,
    `changed_files_with_index: ${input.changedFiles.filter((file) => fileByPath.has(file)).length}/${input.changedFiles.length}`,
    '',
    '变更文件角色与依赖摘要：',
  ];

  for (const filePath of input.changedFiles.slice(0, 32)) {
    const file = fileByPath.get(filePath);
    if (!file) {
      lines.push(`- ${filePath}: no_index_entry`);
      continue;
    }
    const symbols = (functionsByFile.get(filePath) || []).slice(0, 8);
    lines.push(
      [
        `- ${filePath}`,
        `language=${file.language || 'text'}`,
        `lines=${file.lineCount}`,
        `imports=${file.importCount}`,
        `exports=${file.exportCount}`,
        `rank=${file.rank}`,
        `incoming_calls=${incomingByFile.get(filePath) || 0}`,
        `outgoing_calls=${outgoingByFile.get(filePath) || 0}`,
      ].join(' | '),
    );
    if (file.summary) {
      lines.push(`  summary: ${trimContextBlock(file.summary, 400)}`);
    }
    if (symbols.length > 0) {
      lines.push(
        `  symbols: ${symbols
          .map((fn) => `${fn.kind} ${fn.name}@${fn.line}`)
          .join(', ')}`,
      );
    }
  }

  if (input.changedFiles.length > 32) {
    lines.push(
      `- ...(还有 ${input.changedFiles.length - 32} 个变更文件未展开)`,
    );
  }
  if (isStale) {
    lines.push(
      '',
      '注意：Code Index 的 head 与本次审查 head 不一致，只作为低权重导航线索，结论仍以 diff/worktree 为准。',
    );
  }
  return lines.join('\n');
}

function contextErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : stringValue(value);
}

function isCodeIndexEvidenceStale(input: {
  snapshot: ReviewCodeIndexContextData;
  headSha?: string;
}): boolean {
  const sourceHeadSha = stringValue(input.snapshot.meta.sourceHeadSha);
  const headSha = stringValue(input.headSha);
  return Boolean(
    sourceHeadSha &&
    headSha &&
    sourceHeadSha !== headSha &&
    !headSha.startsWith(sourceHeadSha) &&
    !sourceHeadSha.startsWith(headSha),
  );
}

function buildCodeMapEvidenceStatus(input: {
  snapshot: CodeMapSnapshot | null;
  branch: string;
  error?: unknown;
}): ReviewEvidenceContextStatus {
  if (input.error) {
    return {
      status: 'error',
      branch: input.branch,
      reason: 'load_failed',
      message: contextErrorMessage(input.error),
    };
  }
  if (!input.snapshot) {
    return {
      status: 'missing',
      branch: input.branch,
      reason: 'missing_snapshot',
    };
  }
  return {
    status: 'ready',
    branch: input.snapshot.branch || input.branch,
    fileCount: input.snapshot.stats.fileCount,
    edgeCount: input.snapshot.stats.edgeCount,
  };
}

function buildCodeIndexEvidenceStatus(input: {
  snapshot: ReviewCodeIndexContextData | null;
  branch: string;
  headSha?: string;
  error?: unknown;
}): ReviewEvidenceContextStatus {
  if (input.error) {
    return {
      status: 'error',
      branch: input.branch,
      reason: 'load_failed',
      message: contextErrorMessage(input.error),
    };
  }
  if (!input.snapshot) {
    return {
      status: 'missing',
      branch: input.branch,
      reason: 'missing_snapshot',
    };
  }
  const meta = input.snapshot.meta;
  const ready = meta.status === 'ready' && meta.stage === 'complete';
  const stale = isCodeIndexEvidenceStale({
    snapshot: input.snapshot,
    headSha: input.headSha,
  });
  return {
    status: stale ? 'stale' : ready ? 'ready' : 'missing',
    branch: meta.branch || input.branch,
    sourceBranch: meta.sourceBranch || meta.branch || input.branch,
    sourceHeadSha: stringValue(meta.sourceHeadSha),
    reason: ready ? undefined : `${meta.status}:${meta.stage}`,
    fileCount: meta.stats.fileCount,
    functionCount: meta.stats.functionCount,
    edgeCount: meta.stats.functionEdgeCount,
  };
}

export function buildRepoReviewDiffAwareEvidenceBundle(input: {
  prepared: ReviewPreparedContext;
  codeMapSnapshot: CodeMapSnapshot | null;
  codeIndexSnapshot: ReviewCodeIndexContextData | null;
  projectGraphContext?: ReviewEvidenceBundle['projectGraphContext'];
  branch: string;
  codeMapError?: unknown;
  codeIndexError?: unknown;
}): ReviewEvidenceBundle {
  const diffIndex = ensureRepoReviewDiffIndex(input.prepared);
  const changedFileSet = new Set(input.prepared.changedFiles);
  const changedHunks = diffIndex.hunks
    .filter((hunk) => changedFileSet.has(hunk.filePath))
    .map(toReviewEvidenceChangedHunk);
  const fileImpact = buildReviewEvidenceFileImpact({
    changedFiles: input.prepared.changedFiles,
    codeMapSnapshot: input.codeMapSnapshot,
    codeIndexSnapshot: input.codeIndexSnapshot,
  });
  const functionImpact = buildReviewEvidenceFunctionImpact({
    changedHunks,
    codeIndexSnapshot: input.codeIndexSnapshot,
  });
  const codeMapStatus = buildCodeMapEvidenceStatus({
    snapshot: input.codeMapSnapshot,
    branch: input.branch,
    error: input.codeMapError,
  });
  const codeIndexStatus = buildCodeIndexEvidenceStatus({
    snapshot: input.codeIndexSnapshot,
    branch: input.branch,
    headSha: input.prepared.headSha,
    error: input.codeIndexError,
  });
  const missingContext = [
    ...fileImpact.missingContext,
    ...functionImpact.missingContext,
  ];
  if (codeMapStatus.status !== 'ready') {
    missingContext.push(
      `CodeMap ${codeMapStatus.status}: ${codeMapStatus.reason || 'unavailable'}`,
    );
  }
  if (codeIndexStatus.status !== 'ready') {
    missingContext.push(
      `Code Index ${codeIndexStatus.status}: ${codeIndexStatus.reason || 'unavailable'}`,
    );
  }
  if (input.projectGraphContext?.status !== 'ready') {
    missingContext.push(
      `Project Graph ${input.projectGraphContext?.status || 'missing'}: ${input.projectGraphContext?.message || 'unavailable'}`,
    );
  }
  return {
    diffSummary: buildRepoReviewDiffSummary(input.prepared),
    changedFiles: input.prepared.changedFiles,
    changedHunks,
    changedFunctions: functionImpact.changedFunctions,
    projectGraphContext: input.projectGraphContext,
    fileImpact: fileImpact.fileImpact,
    impactGraph: functionImpact.impactGraph,
    codeMapStatus,
    codeIndexStatus,
    missingContext: Array.from(new Set(missingContext.filter(Boolean))),
  };
}

function formatEvidenceStatus(status: ReviewEvidenceContextStatus): string {
  return [
    status.status,
    status.reason ? `reason=${status.reason}` : '',
    status.sourceHeadSha ? `source_head=${shortSha(status.sourceHeadSha)}` : '',
    status.fileCount !== undefined ? `files=${status.fileCount}` : '',
    status.functionCount !== undefined
      ? `functions=${status.functionCount}`
      : '',
    status.edgeCount !== undefined ? `edges=${status.edgeCount}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatEvidenceFunction(fn: ReviewEvidenceImpactFunction): string {
  return `${fn.filePath}:${fn.startLine}-${fn.endLine} ${fn.kind} ${fn.name}`;
}

function buildRepoReviewProjectGraphContextBlock(
  context: ReviewEvidenceBundle['projectGraphContext'] | undefined,
): string {
  return context?.contextText || 'Project Graph Retrieval:\nstatus: missing';
}

function renderRepoReviewEvidenceBundleBlock(
  bundle: ReviewEvidenceBundle,
): string {
  const lines = [
    'Review Evidence Bundle：',
    '说明：以下上下文由系统在模型调用前预构建；stale/missing/error 只作为限制或导航线索，结论仍以 diff/worktree 为准。',
    '',
    'Evidence 状态：',
    `- CodeMap: ${formatEvidenceStatus(bundle.codeMapStatus)}`,
    `- Code Index: ${formatEvidenceStatus(bundle.codeIndexStatus)}`,
    `- bundle: files=${bundle.changedFiles.length}, hunks=${bundle.changedHunks.length}, changed_functions=${bundle.changedFunctions.length}, file_edges=${bundle.fileImpact?.edges.length || 0}, impact_edges=${bundle.impactGraph.edges.length}`,
    '',
    'Diff 文件摘要：',
    buildRepoReviewDiffSummaryBlock({
      summary: bundle.diffSummary,
    }),
    '',
    buildRepoReviewProjectGraphContextBlock(bundle.projectGraphContext),
    '',
    'File impact（changed files + 1-hop file neighbors）：',
  ];
  for (const file of bundle.fileImpact?.changedFiles.slice(0, 32) || []) {
    lines.push(
      `- changed ${file.filePath} | lang=${file.language} | rank=${file.rank.toFixed(4)} | lines=${file.lineCount} | imports=${file.importCount} | exports=${file.exportCount} | dependents=${file.dependentCount} | dependencies=${file.dependencyCount}`,
    );
    if (file.summary) {
      lines.push(`  summary: ${trimContextBlock(file.summary, 240)}`);
    }
    if (file.topSymbols.length > 0) {
      lines.push(`  top_symbols: ${file.topSymbols.join(', ')}`);
    }
  }
  if ((bundle.fileImpact?.changedFiles.length || 0) === 0) {
    lines.push('- (none)');
  }

  lines.push('', 'Related file neighbors：');
  for (const file of bundle.fileImpact?.relatedFiles.slice(0, 24) || []) {
    lines.push(
      `- related ${file.filePath} | link_score=${file.linkScore || 0} | lang=${file.language} | rank=${file.rank.toFixed(4)} | dependents=${file.dependentCount} | dependencies=${file.dependencyCount}`,
    );
    if (file.summary) {
      lines.push(`  summary: ${trimContextBlock(file.summary, 200)}`);
    }
    if (file.topSymbols.length > 0) {
      lines.push(`  top_symbols: ${file.topSymbols.join(', ')}`);
    }
  }
  if ((bundle.fileImpact?.relatedFiles.length || 0) === 0) {
    lines.push('- (none)');
  }

  lines.push('', 'File edges：');
  for (const edge of bundle.fileImpact?.edges.slice(0, 80) || []) {
    lines.push(
      `- ${edge.fromFile} -> ${edge.toFile} | symbols=${edge.symbols.join(', ') || '-'}`,
    );
  }
  if ((bundle.fileImpact?.edges.length || 0) === 0) lines.push('- (none)');

  lines.push(
    '',
    'Changed hunks：',
  );
  for (const hunk of bundle.changedHunks.slice(0, 64)) {
    lines.push(
      `- ${hunk.filePath} | ${hunk.header} | new ${hunk.newStart}-${hunk.newEnd} | added ${hunk.addedLineNumbers.join(',') || '-'} | removed ${hunk.removedLineNumbers.join(',') || '-'}`,
    );
  }
  if (bundle.changedHunks.length === 0) lines.push('- (none)');
  if (bundle.changedHunks.length > 64) {
    lines.push(`- ...(还有 ${bundle.changedHunks.length - 64} 个 hunk 未展开)`);
  }

  lines.push('', 'Changed functions：');
  for (const fn of bundle.changedFunctions.slice(0, 48)) {
    lines.push(
      `- ${formatEvidenceFunction(fn)} | hunks=${fn.changedHunkCount} | changed_lines=${fn.changedLineNumbers.join(',') || '-'}`,
    );
    if (fn.signature) {
      lines.push(`  signature: ${trimContextBlock(fn.signature, 240)}`);
    }
  }
  if (bundle.changedFunctions.length === 0) lines.push('- (none)');
  if (bundle.changedFunctions.length > 48) {
    lines.push(
      `- ...(还有 ${bundle.changedFunctions.length - 48} 个函数未展开)`,
    );
  }

  lines.push('', 'Impact graph（1-hop function calls）：');
  for (const edge of bundle.impactGraph.edges.slice(0, 80)) {
    const from = edge.fromFunction
      ? `${edge.fromFunction.filePath}:${edge.fromFunction.startLine} ${edge.fromFunction.name}`
      : edge.fromFunctionId;
    const to = edge.toFunction
      ? `${edge.toFunction.filePath}:${edge.toFunction.startLine} ${edge.toFunction.name}`
      : edge.toFunctionId;
    lines.push(
      `- ${edge.direction}: ${from} -> ${to} | symbol=${edge.symbol || '-'} | line=${edge.line || '-'}`,
    );
  }
  if (bundle.impactGraph.edges.length === 0) lines.push('- (none)');
  if (bundle.impactGraph.edges.length > 80) {
    lines.push(
      `- ...(还有 ${bundle.impactGraph.edges.length - 80} 条调用边未展开)`,
    );
  }

  lines.push('', 'Context limitations：');
  if (bundle.missingContext.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of bundle.missingContext) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join('\n');
}

export function buildRepoReviewEvidenceBundleBlock(input: {
  bundle?: ReviewEvidenceBundle;
  diffSummaryBlock?: string;
  projectGraphContextBlock?: string;
  codeMapContextBlock?: string;
  codeIndexContextBlock?: string;
}): string {
  if (input.bundle) {
    return renderRepoReviewEvidenceBundleBlock(input.bundle);
  }
  return [
    'Review Evidence Bundle：',
    '说明：以下上下文由系统在模型调用前预构建，优先级低于实际 diff 和工作区取证；stale/missing 时只作为导航线索。',
    '',
    'Diff 文件摘要：',
    input.diffSummaryBlock || '- (none)',
    '',
    input.projectGraphContextBlock || 'Project Graph Retrieval:\nstatus: missing',
    '',
    input.codeMapContextBlock || 'CodeMap 影响图：unavailable',
    '',
    input.codeIndexContextBlock || 'Code Index 上下文：unavailable',
  ].join('\n');
}

function filterRepoReviewEvidenceBundleForFiles(input: {
  bundle: ReviewEvidenceBundle;
  files: string[];
}): ReviewEvidenceBundle {
  const fileSet = new Set(input.files);
  const diffFiles = input.bundle.diffSummary.files.filter((file) =>
    fileSet.has(file.filePath),
  );
  const changedHunks = input.bundle.changedHunks.filter((hunk) =>
    fileSet.has(hunk.filePath),
  );
  const changedFunctions = input.bundle.changedFunctions.filter((fn) =>
    fileSet.has(fn.filePath),
  );
  const changedFunctionIds = new Set(changedFunctions.map((fn) => fn.id));
  const edgeByChangedFunction = input.bundle.impactGraph.edges.filter(
    (edge) =>
      changedFunctionIds.has(edge.fromFunctionId) ||
      changedFunctionIds.has(edge.toFunctionId),
  );
  const graphFunctionIds = new Set(changedFunctionIds);
  for (const edge of edgeByChangedFunction) {
    graphFunctionIds.add(edge.fromFunctionId);
    graphFunctionIds.add(edge.toFunctionId);
  }
  const graphFunctions = input.bundle.impactGraph.functions.filter((fn) =>
    graphFunctionIds.has(fn.id),
  );
  const fileImpactEdges = (input.bundle.fileImpact?.edges || []).filter(
    (edge) => fileSet.has(edge.fromFile) || fileSet.has(edge.toFile),
  );
  const visibleFileImpactPaths = new Set<string>(input.files);
  for (const edge of fileImpactEdges) {
    visibleFileImpactPaths.add(edge.fromFile);
    visibleFileImpactPaths.add(edge.toFile);
  }
  return {
    ...input.bundle,
    diffSummary: {
      fileCount: diffFiles.length,
      hunkCount: diffFiles.reduce((total, file) => total + file.hunkCount, 0),
      addedLines: diffFiles.reduce((total, file) => total + file.addedLines, 0),
      removedLines: diffFiles.reduce(
        (total, file) => total + file.removedLines,
        0,
      ),
      diffBytes: diffFiles.reduce(
        (total, file) => total + file.estimatedBytes,
        0,
      ),
      files: diffFiles,
    },
    changedFiles: input.bundle.changedFiles.filter((file) => fileSet.has(file)),
    changedHunks,
    changedFunctions,
    projectGraphContext: input.bundle.projectGraphContext
      ? filterPreparedProjectGraphContextForFiles({
          context: input.bundle.projectGraphContext,
          files: input.files,
        })
      : undefined,
    fileImpact: input.bundle.fileImpact
      ? {
          changedFiles: input.bundle.fileImpact.changedFiles.filter((file) =>
            fileSet.has(file.filePath),
          ),
          relatedFiles: input.bundle.fileImpact.relatedFiles.filter((file) =>
            visibleFileImpactPaths.has(file.filePath),
          ),
          edges: fileImpactEdges,
        }
      : undefined,
    impactGraph: {
      functions: graphFunctions,
      edges: edgeByChangedFunction,
    },
    missingContext:
      changedHunks.length > 0 && changedFunctions.length === 0
        ? [
            ...input.bundle.missingContext,
            '该任务 slice 未定位到变更函数，按 diff hunk 和文件级证据审查。',
          ]
        : input.bundle.missingContext,
  };
}

function buildRepoReviewProjectContextBlock(input: {
  prepared: ReviewPreparedContext;
  files?: string[];
}): string {
  if (input.prepared.evidenceBundle) {
    const bundle =
      input.files && input.files.length > 0
        ? filterRepoReviewEvidenceBundleForFiles({
            bundle: input.prepared.evidenceBundle,
            files: input.files,
          })
        : input.prepared.evidenceBundle;
    return `项目上下文：\n${buildRepoReviewEvidenceBundleBlock({ bundle })}`;
  }
  return input.prepared.projectContextBlocks.length > 0
    ? `项目上下文：\n${input.prepared.projectContextBlocks.join('\n\n')}`
    : '项目上下文：暂无补充上下文。';
}

function buildRepoReviewImpactGraphBlock(
  bundle: ReviewEvidenceBundle | undefined,
): string {
  if (!bundle) return 'Impact Graph：unavailable';
  const lines = [
    'Impact Graph：',
    `changed_files=${bundle.fileImpact?.changedFiles.length || 0}`,
    `related_files=${bundle.fileImpact?.relatedFiles.length || 0}`,
    `file_edges=${bundle.fileImpact?.edges.length || 0}`,
    `changed_functions=${bundle.changedFunctions.length}`,
    `one_hop_edges=${bundle.impactGraph.edges.length}`,
  ];
  for (const edge of bundle.fileImpact?.edges.slice(0, 20) || []) {
    lines.push(
      `- file: ${edge.fromFile} -> ${edge.toFile} | symbols=${edge.symbols.join(', ') || '-'}`,
    );
  }
  for (const edge of bundle.impactGraph.edges.slice(0, 40)) {
    const from = edge.fromFunction
      ? `${edge.fromFunction.filePath}:${edge.fromFunction.startLine} ${edge.fromFunction.name}`
      : edge.fromFunctionId;
    const to = edge.toFunction
      ? `${edge.toFunction.filePath}:${edge.toFunction.startLine} ${edge.toFunction.name}`
      : edge.toFunctionId;
    lines.push(`- ${edge.direction}: ${from} -> ${to}`);
  }
  if (bundle.impactGraph.edges.length === 0) lines.push('- (none)');
  return lines.join('\n');
}

function buildRepoReviewContextLimitationsBlock(
  bundle: ReviewEvidenceBundle | undefined,
): string {
  if (!bundle) return 'Context Limitations：\n- evidence bundle unavailable';
  return [
    'Context Limitations：',
    ...(bundle.missingContext.length > 0
      ? bundle.missingContext.map((entry) => `- ${entry}`)
      : ['- (none)']),
  ].join('\n');
}

async function enrichReviewPreparedContextWithCodeIntelligence(input: {
  repository: RepoReviewRepository;
  prepared: ReviewPreparedContext;
}): Promise<ReviewPreparedContext> {
  const branch = normalizeBranchName(input.prepared.branch || '');
  if (!branch || input.prepared.changedFiles.length === 0) {
    return input.prepared;
  }
  let codeIndexSnapshot: ReviewCodeIndexContextData | null = null;
  let codeMapSnapshot: CodeMapSnapshot | null = null;
  let projectGraphContext: ReviewEvidenceBundle['projectGraphContext'];
  let codeIndexError: unknown;
  let codeMapError: unknown;
  const projectGraphQuestion = buildRepoReviewProjectGraphQuestion({
    repositoryName: input.repository.name,
    branch,
    changedFiles: input.prepared.changedFiles,
    commitSummaryLines: input.prepared.commitSummaryLines,
    actor: input.prepared.actor,
  });
  const [codeIndexResult, codeMapResult, projectGraphResult] =
    await Promise.allSettled([
      loadCodeIndexReviewContextData(input.repository.id, branch),
      loadCodeMapFromDb(input.repository.id, branch),
    prepareProjectGraphContext({
      repositoryId: input.repository.id,
      branch,
      intent: 'repo_review',
      question: projectGraphQuestion,
      focusPaths: input.prepared.changedFiles,
      persist: {
        source: 'repo-review',
        kind: 'prepared_context',
        metadata: {
          branch,
          changedFiles: input.prepared.changedFiles,
          headSha: input.prepared.headSha,
          baseSha: input.prepared.baseSha,
        },
      },
    }),
    ]);
  if (codeIndexResult.status === 'fulfilled') {
    codeIndexSnapshot = codeIndexResult.value;
  } else {
    codeIndexError = codeIndexResult.reason;
    logger.warn(
      {
        err: codeIndexResult.reason,
        repositoryId: input.repository.id,
        branch,
      },
      'Failed to load repo review Code Index context',
    );
  }
  if (codeMapResult.status === 'fulfilled') {
    codeMapSnapshot = codeMapResult.value;
  } else {
    codeMapError = codeMapResult.reason;
    logger.warn(
      {
        err: codeMapResult.reason,
        repositoryId: input.repository.id,
        branch,
      },
      'Failed to load repo review CodeMap context',
    );
  }
  if (projectGraphResult.status === 'fulfilled') {
    projectGraphContext = projectGraphResult.value;
  } else {
    projectGraphContext = {
      status: 'error',
      repositoryId: input.repository.id,
      branch,
      intent: 'repo_review',
      question: projectGraphQuestion,
      focusPaths: [...input.prepared.changedFiles],
      relationFilter: [],
      communities: [],
      nodeCount: 0,
      edgeCount: 0,
      tokenBudget: 0,
      startNodes: [],
      topFiles: [],
      topFunctions: [],
      topChunks: [],
      edges: [],
      planner: {
        strategy: 'failed',
        forcedSeedCount: 0,
        communityHintCount: 0,
      },
      confidence: {
        seedScore: 0,
        graphScore: 0,
        contextScore: 0,
        overall: 0,
      },
      contextFilterStats: {
        candidateNodeCount: 0,
        selectedNodeCount: 0,
        droppedNodeCount: 0,
        selectedEdgeCount: 0,
        estimatedTokens: 0,
      },
      contextText: 'Project Graph Retrieval:\nstatus: error',
      message:
        projectGraphResult.reason instanceof Error
          ? projectGraphResult.reason.message
          : 'graph_query_failed',
    };
    logger.warn(
      {
        err: projectGraphResult.reason,
        repositoryId: input.repository.id,
        branch,
      },
      'Failed to load repo review Project Graph context',
    );
  }

  const evidenceBundle = buildRepoReviewDiffAwareEvidenceBundle({
    prepared: input.prepared,
    codeMapSnapshot,
    codeIndexSnapshot,
    projectGraphContext,
    branch,
    codeMapError,
    codeIndexError,
  });
  const evidenceBundleBlock = buildRepoReviewEvidenceBundleBlock({
    bundle: evidenceBundle,
  });

  return {
    ...input.prepared,
    evidenceBundle,
    projectContextBlocks: [
      ...input.prepared.projectContextBlocks,
      evidenceBundleBlock,
    ].filter(Boolean),
  };
}

const REPO_REVIEW_EVIDENCE_MAX_LINES = 28;
const REPO_REVIEW_EVIDENCE_CONTEXT_BEFORE = 3;
const REPO_REVIEW_EVIDENCE_CONTEXT_AFTER = 6;

interface RepoReviewDiffHunk {
  text: string;
  newStart: number;
  newLineCount: number;
  addedLines: string[];
  contextLines: string[];
}

interface RepoReviewFullFileTaskManifest {
  stepIndex: number;
  filePath: string;
  diffFiles: string[];
  estimatedDiffBytes: number;
  estimatedFileBytes: number;
  estimatedBytes: number;
  relatedFindings: RepoReviewRunFinding[];
  communityId?: string;
  communityLabel?: string;
}

interface RepoReviewHydratedFullFileTask extends RepoReviewSupplementalPreparedFileTask {
  stepIndex: number;
  estimatedBytes: number;
  scopeLimitations: string[];
}

function parseRepoReviewDiffHunks(diffText: string): RepoReviewDiffHunk[] {
  const lines = diffText.split('\n');
  const hunks: RepoReviewDiffHunk[] = [];
  let fileHeader: string[] = [];
  let currentHunk: string[] = [];
  let currentNewStart = 1;
  let currentNewLineCount = 1;

  const flush = () => {
    if (currentHunk.length === 0) return;
    const addedLines = currentHunk
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
    const contextLines = currentHunk
      .filter((line) => line.startsWith(' '))
      .map((line) => line.slice(1));
    hunks.push({
      text: [...fileHeader, ...currentHunk].join('\n').trim(),
      newStart: currentNewStart,
      newLineCount: currentNewLineCount,
      addedLines,
      contextLines,
    });
    currentHunk = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      fileHeader = [line];
      continue;
    }
    if (
      fileHeader.length > 0 &&
      currentHunk.length === 0 &&
      (line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        /^[a-z].*mode \d+$/i.test(line))
    ) {
      fileHeader.push(line);
      continue;
    }
    if (line.startsWith('@@ ')) {
      flush();
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      currentNewStart = Number.parseInt(match?.[1] || '1', 10) || 1;
      currentNewLineCount = Number.parseInt(match?.[2] || '1', 10) || 1;
      currentHunk = [line];
      continue;
    }
    if (currentHunk.length > 0) {
      currentHunk.push(line);
    }
  }

  flush();
  return hunks;
}

function buildRepoReviewFindingSearchTerms(
  finding: RepoReviewRunFinding,
): string[] {
  const terms = new Set<string>();
  const file = stringValue(finding.file);
  const basename = file.split(/[\\/]/).at(-1) || '';
  const stem = basename.replace(/\.[^.]+$/, '');
  if (stem) {
    terms.add(stem.toLowerCase());
  }

  for (const value of [
    finding.title,
    finding.detail,
    finding.suggestion || '',
  ]) {
    const matches =
      String(value || '').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
    for (const match of matches) {
      terms.add(match.toLowerCase());
    }
  }

  return Array.from(terms).slice(0, 16);
}

function scoreRepoReviewEvidenceHunk(
  hunk: RepoReviewDiffHunk,
  searchTerms: string[],
): number {
  const normalized = hunk.text.toLowerCase();
  let score = 0;
  for (const term of searchTerms) {
    if (!term) continue;
    if (normalized.includes(term)) {
      score += Math.max(4, term.length);
    }
  }
  const changedLineCount = (hunk.text.match(/^[+-](?![+-])/gm) || []).length;
  return score + changedLineCount;
}

function extractAfterStateFromDiffHunk(hunkText: string): string {
  return hunkText
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('diff --git ') &&
        !line.startsWith('index ') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ ') &&
        !line.startsWith('@@ ') &&
        !/^[a-z].*mode \d+$/i.test(line) &&
        !line.startsWith('-'),
    )
    .map((line) => {
      if (line.startsWith('+')) return line.slice(1);
      if (line.startsWith(' ')) return line.slice(1);
      return line;
    })
    .join('\n')
    .trim();
}

function trimRepoReviewEvidenceSnippet(snippet: string): string {
  const lines = snippet.split('\n');
  if (lines.length <= REPO_REVIEW_EVIDENCE_MAX_LINES) {
    return snippet.trim();
  }
  return `${lines.slice(0, REPO_REVIEW_EVIDENCE_MAX_LINES).join('\n')}\n...`;
}

function normalizeRepoReviewCodeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function isRepoReviewBoilerplateLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  return (
    normalized.startsWith('package ') ||
    normalized.startsWith('import ') ||
    normalized === '{' ||
    normalized === '}' ||
    normalized === '};' ||
    normalized === ');' ||
    normalized === '(' ||
    normalized === ')' ||
    normalized === '/**' ||
    normalized === '/*' ||
    normalized === '*/' ||
    normalized.startsWith('*')
  );
}

function buildRepoReviewAnchorCandidates(hunk: RepoReviewDiffHunk): string[] {
  const candidates = [...hunk.addedLines, ...hunk.contextLines]
    .map(normalizeRepoReviewCodeLine)
    .filter((line) => line && !isRepoReviewBoilerplateLine(line));
  return Array.from(new Set(candidates)).sort((left, right) => {
    const leftPenalty = isRepoReviewBoilerplateLine(left) ? 1 : 0;
    const rightPenalty = isRepoReviewBoilerplateLine(right) ? 1 : 0;
    if (leftPenalty !== rightPenalty) {
      return leftPenalty - rightPenalty;
    }
    return right.length - left.length;
  });
}

function findRepoReviewAnchorLine(
  lines: string[],
  hunk: RepoReviewDiffHunk,
  searchTerms: string[],
): number {
  const candidates = buildRepoReviewAnchorCandidates(hunk);
  if (candidates.length === 0) {
    return hunk.newStart;
  }

  let bestLine = hunk.newStart;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    for (let index = 0; index < lines.length; index += 1) {
      const normalizedLine = normalizeRepoReviewCodeLine(lines[index] || '');
      if (!normalizedLine || normalizedLine !== candidate) continue;

      let score = candidate.length;
      if (!isRepoReviewBoilerplateLine(candidate)) {
        score += 20;
      }
      for (const term of searchTerms) {
        if (term && normalizedLine.toLowerCase().includes(term)) {
          score += Math.max(6, term.length);
        }
      }
      score -= Math.min(Math.abs(index + 1 - hunk.newStart), 80);
      if (score > bestScore) {
        bestScore = score;
        bestLine = index + 1;
      }
    }
  }
  return bestLine;
}

function extractRepoReviewFinalCodeSnippet(
  fileContent: string,
  hunk: RepoReviewDiffHunk,
  searchTerms: string[],
): string {
  const lines = fileContent.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0) {
    return '';
  }
  const anchorLine = findRepoReviewAnchorLine(lines, hunk, searchTerms);
  const startLine = Math.max(
    1,
    anchorLine - REPO_REVIEW_EVIDENCE_CONTEXT_BEFORE,
  );
  const estimatedEnd =
    anchorLine +
    Math.max(hunk.newLineCount, 1) +
    REPO_REVIEW_EVIDENCE_CONTEXT_AFTER -
    1;
  const endLine = Math.min(lines.length, estimatedEnd);
  const snippet = lines
    .slice(startLine - 1, endLine)
    .join('\n')
    .trim();
  return trimRepoReviewEvidenceSnippet(snippet);
}

function scoreRepoReviewEvidenceSnippet(
  snippet: string,
  searchTerms: string[],
): number {
  const normalized = snippet.toLowerCase();
  let score = 0;
  for (const term of searchTerms) {
    if (!term) continue;
    if (normalized.includes(term)) {
      score += Math.max(6, term.length);
    }
  }
  const nonBoilerplateLines = snippet
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isRepoReviewBoilerplateLine(line)).length;
  const boilerplateLines = snippet
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && isRepoReviewBoilerplateLine(line)).length;
  return score + nonBoilerplateLines * 3 - boilerplateLines * 2;
}

export function splitDiffByFile(diffText: string): Map<string, string> {
  const result = new Map<string, string>();
  const diffIndex = buildRepoReviewDiffIndex(diffText);
  for (const entry of diffIndex.entries) {
    const slice = diffText.slice(entry.startOffset, entry.endOffset).trim();
    if (!slice) continue;
    result.set(entry.filePath, slice);
  }
  return result;
}

async function readRepoReviewWorkspaceFile(filePath: string): Promise<{
  content: string;
  source: 'workspace' | 'omitted' | 'unavailable';
}> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { content: '', source: 'omitted' };
    if (stat.size > REPO_REVIEW_AGENTIC_DEFAULT_MAX_FULL_FILE_BYTES_PER_FILE) {
      return { content: '', source: 'omitted' };
    }
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.includes(0)) return { content: '', source: 'omitted' };
    return { content: buffer.toString('utf8'), source: 'workspace' };
  } catch {
    return { content: '', source: 'unavailable' };
  }
}

async function buildRepoReviewFindingEvidence(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  diffText?: string;
}): Promise<Record<string, string>> {
  const evidence: Record<string, string> = {};
  const hasLocalRepo = !!(
    input.repository.localRepoPath &&
    input.run.baseSha &&
    input.run.headSha
  );
  const hasDiffText = !!input.diffText?.trim();
  if (!hasLocalRepo && !hasDiffText) {
    return evidence;
  }

  const diffByFile =
    hasDiffText && !hasLocalRepo ? splitDiffByFile(input.diffText!) : null;

  if (hasLocalRepo) {
    const refsToFetch = [input.run.baseSha, input.run.headSha].filter(Boolean);
    if (refsToFetch.length > 0) {
      try {
        await runGitCommandAsync(
          input.repository.localRepoPath,
          ['fetch', 'origin', ...refsToFetch],
          false,
          REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
        );
      } catch {
        // best-effort; shallow repos may not resolve all SHAs
      }
    }
  }

  for (const finding of input.run.findings) {
    const filePath = stringValue(finding.file);
    if (!filePath) continue;

    try {
      let fileDiff: string;
      let finalFileContent: string | null = null;

      if (hasLocalRepo) {
        fileDiff = await runGitCommandAsync(
          input.repository.localRepoPath,
          [
            'diff',
            '--unified=3',
            input.run.baseSha,
            input.run.headSha,
            '--',
            filePath,
          ],
          true,
        );
        if (!fileDiff.trim()) continue;
        finalFileContent = await runGitCommandAsync(
          input.repository.localRepoPath,
          ['show', `${input.run.headSha}:${filePath.replace(/\\/g, '/')}`],
          true,
        );
      } else {
        fileDiff = diffByFile?.get(filePath) || '';
        if (!fileDiff.trim()) continue;
      }

      const hunks = parseRepoReviewDiffHunks(fileDiff);
      if (hunks.length === 0) continue;

      const searchTerms = buildRepoReviewFindingSearchTerms(finding);

      if (finalFileContent?.trim()) {
        let bestSnippet = '';
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const hunk of hunks) {
          const snippet = extractRepoReviewFinalCodeSnippet(
            finalFileContent,
            hunk,
            searchTerms,
          );
          const score =
            scoreRepoReviewEvidenceHunk(hunk, searchTerms) +
            scoreRepoReviewEvidenceSnippet(snippet, searchTerms);
          if (score > bestScore) {
            bestScore = score;
            bestSnippet = snippet;
          }
        }
        if (bestSnippet) {
          evidence[buildRepoReviewFindingEvidenceKey(finding)] = bestSnippet;
          continue;
        }
      }

      let bestHunkText = '';
      let bestHunkScore = Number.NEGATIVE_INFINITY;
      for (const hunk of hunks) {
        const score = scoreRepoReviewEvidenceHunk(hunk, searchTerms);
        if (score > bestHunkScore) {
          bestHunkScore = score;
          bestHunkText = hunk.text;
        }
      }
      if (bestHunkText) {
        evidence[buildRepoReviewFindingEvidenceKey(finding)] =
          trimRepoReviewEvidenceSnippet(
            extractAfterStateFromDiffHunk(bestHunkText),
          );
      }
    } catch {
      continue;
    }
  }

  return evidence;
}

async function hydrateRepoReviewFindingSnippets(input: {
  findings: RepoReviewRunFinding[];
  prepared: ReviewPreparedContext;
  workspacePath?: string | null;
}): Promise<RepoReviewRunFinding[]> {
  const diffIndex =
    input.prepared.diffIndex ||
    buildRepoReviewDiffIndex(input.prepared.diffText || '');
  return Promise.all(
    input.findings.map(async (finding) => {
      const evidenceKey =
        finding.evidenceKey || buildRepoReviewFindingEvidenceKey(finding);
      if (finding.codeSnippet?.trim()) {
        return {
          ...finding,
          evidenceKey,
          codeSnippetSource: finding.codeSnippetSource || 'model',
          needsSnippetHydration: false,
        };
      }
      const filePath = stringValue(finding.file);
      if (!filePath) {
        return {
          ...finding,
          evidenceKey,
          codeSnippetSource: 'unavailable' as const,
          needsSnippetHydration: true,
        };
      }

      const diffSlice =
        getRepoReviewDiffSlice(diffIndex, [filePath]) ||
        buildFilteredDiff(
          input.prepared.diffText,
          new Set([filePath]),
          diffIndex,
        );
      const hunks = parseRepoReviewDiffHunks(diffSlice);
      const searchTerms = buildRepoReviewFindingSearchTerms(finding);
      let bestSnippet = '';
      let bestSource: RepoReviewRunFinding['codeSnippetSource'] = 'unavailable';

      if (input.workspacePath) {
        const fullPath = path.resolve(input.workspacePath, filePath);
        try {
          const read = await readRepoReviewWorkspaceFile(fullPath);
          if (read.content.trim() && hunks.length > 0) {
            let bestScore = Number.NEGATIVE_INFINITY;
            for (const hunk of hunks) {
              const snippet = extractRepoReviewFinalCodeSnippet(
                read.content,
                hunk,
                searchTerms,
              );
              const score =
                scoreRepoReviewEvidenceHunk(hunk, searchTerms) +
                scoreRepoReviewEvidenceSnippet(snippet, searchTerms);
              if (score > bestScore) {
                bestScore = score;
                bestSnippet = snippet;
                bestSource = 'workspace';
              }
            }
          } else if (read.content.trim()) {
            const lineNumber = Number.parseInt(
              String(finding.line || '').match(/\d+/)?.[0] || '',
              10,
            );
            const lines = read.content.replace(/\r\n/g, '\n').split('\n');
            if (Number.isFinite(lineNumber) && lineNumber > 0) {
              const start = Math.max(
                1,
                lineNumber - REPO_REVIEW_EVIDENCE_CONTEXT_BEFORE,
              );
              const end = Math.min(
                lines.length,
                lineNumber + REPO_REVIEW_EVIDENCE_CONTEXT_AFTER,
              );
              bestSnippet = trimRepoReviewEvidenceSnippet(
                lines.slice(start - 1, end).join('\n'),
              );
              bestSource = 'workspace';
            }
          }
        } catch {
          // Diff fallback below still gives the formatter a concrete snippet.
        }
      }

      if (!bestSnippet && hunks.length > 0) {
        let bestHunkText = '';
        let bestHunkScore = Number.NEGATIVE_INFINITY;
        for (const hunk of hunks) {
          const score = scoreRepoReviewEvidenceHunk(hunk, searchTerms);
          if (score > bestHunkScore) {
            bestHunkScore = score;
            bestHunkText = hunk.text;
          }
        }
        if (bestHunkText) {
          bestSnippet = trimRepoReviewEvidenceSnippet(
            extractAfterStateFromDiffHunk(bestHunkText),
          );
          bestSource = 'diff';
        }
      }

      return {
        ...finding,
        evidenceKey,
        ...(bestSnippet ? { codeSnippet: bestSnippet } : {}),
        codeSnippetSource: bestSource,
        needsSnippetHydration: !bestSnippet,
      };
    }),
  );
}

function sanitizePreparedContext(
  prepared: ReviewPreparedContext,
  profile: RepoReviewProfile,
): ReviewPreparedContext {
  const totalFiles = prepared.changedFiles.length;
  const filteredFiles = filterChangedFiles(
    prepared.changedFiles,
    profile.includeGlobs,
    profile.excludeGlobs,
  );

  if (filteredFiles.length === 0) {
    const parts = [
      t('repoReview.noFilesMatchProfile', { total: totalFiles }, undefined),
    ];
    if (profile.includeGlobs.length > 0)
      parts.push(`include: [${profile.includeGlobs.join(', ')}]`);
    if (profile.excludeGlobs.length > 0)
      parts.push(`exclude: [${profile.excludeGlobs.join(', ')}]`);
    if (totalFiles === 0)
      parts.push(t('repoReview.auto_44b087', {}, undefined));
    return {
      ...prepared,
      changedFiles: [],
      diffText: '',
      overall: 'skipped',
      summary: parts.join('，'),
    };
  }

  const needsGlobFilter =
    profile.includeGlobs.length > 0 || profile.excludeGlobs.length > 0;
  const effectiveFiles = filteredFiles;
  const filteredDiff = needsGlobFilter
    ? buildFilteredDiff(
        prepared.diffText,
        new Set(effectiveFiles),
        prepared.diffIndex,
      )
    : prepared.diffText;

  if (!filteredDiff.trim()) {
    return {
      ...prepared,
      changedFiles: [],
      diffText: '',
      overall: 'skipped',
      summary: t(
        'repoReview.diffFilteredEmpty',
        { total: totalFiles, filtered: filteredFiles.length },
        undefined,
      ),
    };
  }

  if (Buffer.byteLength(filteredDiff, 'utf8') > profile.maxDiffBytes) {
    return {
      ...prepared,
      changedFiles: effectiveFiles,
      diffText: filteredDiff.slice(0, profile.maxDiffBytes),
      overall: 'warn',
      summary: t(
        'repoReview.diffSizeTruncated',
        { max: profile.maxDiffBytes },
        undefined,
      ),
    };
  }

  return {
    ...prepared,
    changedFiles: effectiveFiles,
    diffText: filteredDiff,
  };
}

// ── Diff subagent split review ──────────────────────────────────

type ParsedReviewResult = ReturnType<typeof parseReviewResult>;
type ResolvedRepoReviewPrompt = Awaited<ReturnType<typeof resolvePromptText>>;

function buildRepoReviewDiffRange(input: {
  baseSha?: string | null;
  headSha?: string | null;
}): string {
  const baseSha = stringValue(input.baseSha);
  const headSha = stringValue(input.headSha);
  if (baseSha && headSha) return `${baseSha}..${headSha}`;
  if (headSha) return `${headSha}^!`;
  if (baseSha) return `${baseSha}..HEAD`;
  return 'HEAD';
}

function formatRepoReviewPromptSha(value?: string | null): string {
  return stringValue(value) || '(none)';
}

function formatRepoReviewCustomPromptBlock(customPrompt: string): string {
  const trimmed = customPrompt
    .trim()
    .replace(/^(?:#+\s*)?附加审查要求[:：]?\s*/u, '');
  if (!trimmed) return '';
  return `附加审查要求：\n${trimmed}`;
}

function normalizeMarkdownSectionHeading(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .trim();
}

function findMarkdownSectionByTitles(text: string, titles: string[]): string {
  const lines = text.split(/\r?\n/);
  const normalizedTitles = new Set(titles.map((title) => title.trim()));
  const startIndex = lines.findIndex((line) =>
    normalizedTitles.has(normalizeMarkdownSectionHeading(line)),
  );
  if (startIndex < 0) return '';
  const endIndex = lines.findIndex(
    (line, index) => index > startIndex && /^#{1,6}\s+\S/.test(line.trim()),
  );
  const slice = lines.slice(
    startIndex + 1,
    endIndex > startIndex ? endIndex : lines.length,
  );
  return slice.join('\n').trim();
}

function extractMarkdownBulletValues(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[-*]\s+/, '')
        .replace(/^`|`$/g, '')
        .trim(),
    )
    .filter(Boolean);
}

function parseRepoReviewSubagentConfidence(
  text: string,
): 'high' | 'medium' | 'low' {
  const match = text.match(/置信度[:：]\s*(high|medium|low)/i);
  const raw = String(match?.[1] || '').toLowerCase();
  return raw === 'high' || raw === 'low' ? raw : 'medium';
}

function parseRepoReviewSubagentFindingBlocks(
  section: string,
): RepoReviewRunFinding[] {
  const findings: RepoReviewRunFinding[] = [];
  const blocks = splitRepoReviewMarkdownFindingBlocks(section);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || /未发现|暂无/.test(trimmed)) continue;
    let severity: RepoReviewRunFinding['severity'] = 'medium';
    if (/^[🔴]/.test(trimmed) || /\bhigh\b/i.test(trimmed)) severity = 'high';
    if (/^[🔵]/.test(trimmed) || /\blow\b/i.test(trimmed)) severity = 'low';
    const parsed = parseRepoReviewMarkdownFindingBlock(block, severity);
    if (parsed) findings.push(parsed);
  }
  return findings;
}

function buildRepoReviewSubagentTimeoutFollowupPrompt(input: {
  task: Pick<RepoReviewAgenticPlanTask, 'id' | 'title' | 'files'>;
}): string {
  return [
    '请停止扩展取证，只基于已经检查过的内容返回当前进度总结。',
    '主代理即将接管。',
    '',
    `任务 ID：${input.task.id}`,
    `任务标题：${input.task.title}`,
    `允许文件：${input.task.files.join(', ') || '-'}`,
    '',
    '只输出一个 Markdown 报告，必须包含：',
    '## 任务范围',
    '## 已检查内容',
    '## 确认问题',
    '## 需要主代理继续确认',
    '## 结论',
    '',
    '要求：',
    '- 不要输出 JSON。',
    '- 不要新增未确认的问题。',
    '- 在结论里写明这是当前进度总结。',
    '- 在结论里给出置信度：high | medium | low。',
  ].join('\n');
}

function formatRepoReviewFindingForPrompt(
  finding: RepoReviewRunFinding,
): string {
  const parts = [`- [${finding.severity}] ${finding.title || '未命名问题'}`];
  if (finding.file) {
    parts.push(`  文件：${finding.file}`);
  }
  if (finding.detail) {
    parts.push(`  说明：${finding.detail}`);
  }
  if (finding.suggestion) {
    parts.push(`  建议：${finding.suggestion}`);
  }
  return parts.join('\n');
}

type DiffWorkerPromptInput = {
  groupFiles: string[];
  event: RepoReviewEvent;
  repository: RepoReviewRepository;
  customPrompt: string;
  targetUserId?: string;
};

export async function resolveDiffWorkerPrompt(
  input: DiffWorkerPromptInput,
): Promise<ResolvedRepoReviewPrompt> {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.event.baseSha,
    headSha: input.event.headSha,
  });
  return resolvePromptText({
    promptKey: 'repo_review.diff_worker',
    targetUserId: input.targetUserId,
    variables: {
      customPromptBlock: formatRepoReviewCustomPromptBlock(input.customPrompt),
      repositoryName: input.repository.name,
      baseSha: formatRepoReviewPromptSha(input.event.baseSha),
      headSha: formatRepoReviewPromptSha(input.event.headSha),
      diffRange,
      branch: input.event.branch || '(unknown)',
      fileCount: input.groupFiles.length,
      groupFiles: input.groupFiles.map((f) => `- ${f}`).join('\n'),
    },
    fallbackText: REPO_REVIEW_DIFF_WORKER_TEMPLATE,
  });
}

export async function buildDiffWorkerPrompt(
  input: DiffWorkerPromptInput,
): Promise<string> {
  const resolved = await resolveDiffWorkerPrompt(input);
  return resolved.text;
}

type SplitDiffMainPromptInput = {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  workerFindings: RepoReviewRunFinding[];
  targetUserId?: string;
};

export async function resolveSplitDiffMainPrompt(
  input: SplitDiffMainPromptInput,
): Promise<ResolvedRepoReviewPrompt> {
  const customPrompt = input.profile.promptTemplate.trim();
  const findingsText =
    input.workerFindings.length > 0
      ? input.workerFindings
          .map(
            (finding, i) =>
              `${i + 1}. ${formatRepoReviewFindingForPrompt(finding)}`,
          )
          .join('\n')
      : '暂无子代理发现。';
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return resolvePromptText({
    promptKey: 'repo_review.split_main',
    targetUserId: input.targetUserId,
    variables: {
      repositoryName: input.repository.name,
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange,
      branch: input.prepared.branch || '(unknown)',
      actor: input.prepared.actor || '(unknown)',
      commitSummaryBlock:
        input.prepared.commitSummaryLines.length > 0
          ? `提交摘要：\n${input.prepared.commitSummaryLines.map((l) => `- ${l}`).join('\n')}`
          : '',
      changedFileCount: input.prepared.changedFiles.length,
      changedFiles: input.prepared.changedFiles.map((f) => `- ${f}`).join('\n'),
      workerFindings: findingsText,
      customPromptBlock: formatRepoReviewCustomPromptBlock(customPrompt),
    },
    fallbackText: REPO_REVIEW_SPLIT_MAIN_TEMPLATE,
  });
}

export async function buildSplitDiffMainPrompt(
  input: SplitDiffMainPromptInput,
): Promise<string> {
  const resolved = await resolveSplitDiffMainPrompt(input);
  return resolved.text;
}

const REVIEW_OVERALL_RANK: Record<string, number> = {
  fail: 3,
  error: 2,
  warn: 1,
  pass: 0,
  skipped: -1,
};

function mergeReviewResults(
  mainResult: ParsedReviewResult,
  workerResults: ParsedReviewResult[],
): ParsedReviewResult {
  const allFindings = [
    ...workerResults.flatMap((r) => r.findings),
    ...mainResult.findings,
  ];
  let worstOverall = mainResult.overall;
  for (const r of workerResults) {
    if (
      (REVIEW_OVERALL_RANK[r.overall] ?? 0) >
      (REVIEW_OVERALL_RANK[worstOverall] ?? 0)
    ) {
      worstOverall = r.overall;
    }
  }
  return {
    overall: worstOverall,
    summary: mainResult.summary,
    findings: dedupeRepoReviewFindings(allFindings),
    fileReviews: [
      ...workerResults.flatMap((r) => r.fileReviews),
      ...mainResult.fileReviews,
    ],
    scopeLimitations: [
      ...new Set([
        ...mainResult.scopeLimitations,
        ...workerResults.flatMap((r) => r.scopeLimitations),
      ]),
    ],
    commitReviews: mainResult.commitReviews,
    suggestions: [
      ...mainResult.suggestions,
      ...workerResults.flatMap((r) => r.suggestions),
    ],
    recommendedBlock:
      mainResult.recommendedBlock ||
      workerResults.some((r) => r.recommendedBlock),
    markdownBody: mainResult.markdownBody,
    rawModelOutput: mainResult.rawModelOutput,
  };
}

async function runSplitDiffReview(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
  userId?: string;
  onPhase1Progress: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
  executionStats?: RepoReviewExecutionStats;
}): Promise<ParsedReviewResult> {
  const { repository, profile, event, prepared, runId, workspacePath, userId } =
    input;
  const maxSubagents = await resolveRepoReviewMaxSubagents();
  const customPrompt = profile.promptTemplate.trim();
  // Step A: build tasks and groups for worker subagents
  const tasks: RepoReviewSupplementalPreparedFileTask[] =
    prepared.changedFiles.map((f) => ({
      filePath: f,
      fileDiff: buildFilteredDiff(
        prepared.diffText,
        new Set([f]),
        prepared.diffIndex,
      ),
      fileContent: '',
      relatedFindings: [],
      ...getRepoReviewProjectGraphFileCommunity({
        prepared,
        filePath: f,
      }),
    }));
  const taskGroups = groupFilesForReview(tasks, maxSubagents);
  if (input.executionStats) {
    input.executionStats.splitGroups = Math.max(
      input.executionStats.splitGroups,
      taskGroups.length,
    );
  }
  const workerTurnsByGroup: RepoReviewAssistantTurn[][] = Array.from(
    { length: taskGroups.length || prepared.changedFiles.length },
    () => [],
  );
  let mainTurns: RepoReviewAssistantTurn[] = [];
  const describeWorkerFiles = (files: string[]) => {
    const visible = files.slice(0, 4).join('、');
    const omitted = files.length > 4 ? ` 等 ${files.length} 个文件` : '';
    return `${files.length} 个文件：${visible}${omitted}`;
  };
  await input.onProgressStep?.({
    id: 'split_diff_workers',
    label: 'Diff Worker 并行审查',
    status: 'running',
    detail: `${prepared.changedFiles.length} 个变更文件，分为 ${taskGroups.length} 个 Diff Worker，并发上限 ${maxSubagents}`,
  });
  for (let groupIndex = 0; groupIndex < taskGroups.length; groupIndex += 1) {
    const groupFiles = taskGroups[groupIndex]!.map((task) => task.filePath);
    await input.onProgressStep?.({
      id: `split_diff_worker_${groupIndex + 1}`,
      label: `Diff Worker ${groupIndex + 1}/${taskGroups.length}`,
      status: 'queued',
      detail: describeWorkerFiles(groupFiles),
    });
  }
  const updateExtraRepoReadCount = () => {
    if (!input.executionStats) return;
    input.executionStats.extraRepoReadCount =
      countRepoReviewToolCalls(mainTurns, 'read_file') +
      workerTurnsByGroup.reduce(
        (total, turns) => total + countRepoReviewToolCalls(turns, 'read_file'),
        0,
      );
  };
  const emitMergedPhase1Progress = async () => {
    const mergedTurns = [...workerTurnsByGroup.flat(), ...mainTurns];
    updateExtraRepoReadCount();
    await input.onPhase1Progress(mergedTurns);
  };

  // Step B: run worker subagents in parallel
  const workerResults = await mapWithConcurrencyLimit(
    taskGroups,
    maxSubagents,
    async (group, groupIndex) => {
      const groupFiles = group.map((t) => t.filePath);
      const workerStepId = `split_diff_worker_${groupIndex + 1}`;
      const workerLabel = `Diff Worker ${groupIndex + 1}/${taskGroups.length}`;
      await input.onProgressStep?.({
        id: workerStepId,
        label: workerLabel,
        status: 'running',
        detail: `正在审查 ${describeWorkerFiles(groupFiles)}`,
      });
      try {
        const prompt = await buildDiffWorkerPrompt({
          groupFiles,
          event,
          repository,
          customPrompt,
          targetUserId: userId,
        });
        recordRepoReviewPromptBytes(input.executionStats, prompt);
        await recordPromptTrace({
          traceKind: 'direct_provider',
          promptKey: 'repo_review.diff_worker',
          featureScope: 'repo_review',
          targetUserId: userId ?? '',
          userPromptText: prompt,
          providerInputText: prompt,
          metadata: {
            runId,
            repositoryId: repository.id,
            groupIndex,
            fileCount: groupFiles.length,
          },
        });
        const reviewResult = await runReviewAgent({
          repository,
          profile,
          prompt,
          runId,
          runtimeNamespace: `${runId}:diff-worker:${groupIndex + 1}`,
          workspacePath,
          userId,
          onTurnProgress: async (turns) => {
            workerTurnsByGroup[groupIndex] = turns;
            await emitMergedPhase1Progress();
          },
          onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
            id: workerStepId,
            label: workerLabel,
            onProgressStep: input.onProgressStep,
          }),
        });
        const parsed = parseReviewResult(reviewResult.outputText);
        await input.onProgressStep?.({
          id: workerStepId,
          label: workerLabel,
          status: 'completed',
          detail: `完成 ${describeWorkerFiles(groupFiles)}，发现 ${parsed.findings.length} 个问题`,
        });
        return parsed;
      } catch (err) {
        await input.onProgressStep?.({
          id: workerStepId,
          label: workerLabel,
          status: 'failed',
          detail: `审查失败：${describeWorkerFiles(groupFiles)}`,
          error: errorMessageForProgress(err),
        });
        throw err;
      }
    },
  );
  throwIfRepoReviewRunCancelled(runId);

  // Step C: run main agent for cross-file analysis
  const allWorkerFindings = workerResults.flatMap((r) => r.findings);
  const mainPrompt = await buildSplitDiffMainPrompt({
    repository,
    profile,
    event,
    prepared,
    workerFindings: allWorkerFindings,
    targetUserId: userId,
  });
  recordRepoReviewPromptBytes(input.executionStats, mainPrompt);
  await recordPromptTrace({
    traceKind: 'direct_provider',
    promptKey: 'repo_review.split_main',
    featureScope: 'repo_review',
    targetUserId: userId ?? '',
    userPromptText: mainPrompt,
    providerInputText: mainPrompt,
    metadata: {
      runId,
      repositoryId: repository.id,
      changedFileCount: prepared.changedFiles.length,
    },
  });
  await input.onProgressStep?.({
    id: 'split_diff_main',
    label: 'Diff Worker 汇总结论',
    status: 'running',
    detail: `正在合并 ${workerResults.length} 个 Diff Worker 的审查结果`,
  });
  let mainParsed: ParsedReviewResult;
  try {
    const mainReviewResult = await runReviewAgent({
      repository,
      profile,
      prompt: mainPrompt,
      runId,
      runtimeNamespace: `${runId}:split-main`,
      workspacePath,
      userId,
      onTurnProgress: async (turns) => {
        mainTurns = turns;
        await emitMergedPhase1Progress();
      },
      onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
        id: 'split_diff_main',
        label: 'Diff Worker 汇总结论',
        onProgressStep: input.onProgressStep,
      }),
    });
    throwIfRepoReviewRunCancelled(runId);
    mainParsed = parseReviewResult(mainReviewResult.outputText);
    await input.onProgressStep?.({
      id: 'split_diff_main',
      label: 'Diff Worker 汇总结论',
      status: 'completed',
      detail: `已合并 ${workerResults.length} 个 Diff Worker 的审查结果`,
    });
  } catch (err) {
    await input.onProgressStep?.({
      id: 'split_diff_main',
      label: 'Diff Worker 汇总结论',
      status: 'failed',
      detail: `合并 ${workerResults.length} 个 Diff Worker 的审查结果失败`,
      error: errorMessageForProgress(err),
    });
    throw err;
  }

  return mergeReviewResults(mainParsed, workerResults);
}

// ── Standard single-agent review prompt ──────────────────────────

type ReviewPromptInput = {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  reviewMode?: 'standard' | 'direct';
  targetUserId?: string;
};

export async function resolveReviewPrompt(
  input: ReviewPromptInput,
): Promise<ResolvedRepoReviewPrompt> {
  const customPrompt = input.profile.promptTemplate.trim();
  const fullFileReviewInstructions =
    input.reviewMode === 'direct'
      ? [
          '本次由主代理直接审查，不会再进入后续补充子代理阶段。',
          '优先使用系统已准备的 diff/evidence；如果需要全文确认，请直接使用只读工具核对相关文件，不要等待后续阶段。',
        ].join('\n')
      : input.profile.includeFullFileContext
        ? [
            '本次已开启“全文件补充审查”。',
            '主审查可以先聚焦 diff / 分支主线；系统会在后续阶段按固定文件任务补做完整文件 CR。',
            '如果你已经确认了重要问题，可以直接写入报告；需要后续全文确认的点也可以作为风险或限制说明。',
          ].join('\n')
        : '本次未开启全文件补充审查；请基于可用 evidence 完成审查。';
  const workspaceInspectionInstructions =
    input.event.source === 'local-hook'
      ? '本地 hook 触发：只读工作区可用于核对直接相关代码和 git 信息。'
      : [
          '远端或同步触发：工作区可能是临时只读镜像。',
          '如需补充取证，可以核对直接相关文件和提交范围；上下文不足时在报告中说明。',
        ].join('\n');
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return resolvePromptText({
    promptKey: 'repo_review.primary',
    targetUserId: input.targetUserId,
    variables: {
      workspaceInspectionInstructions,
      fullFileReviewInstructions,
      repositoryName: input.repository.name,
      primaryLanguageBlock: input.repository.language
        ? `主要语言：${input.repository.language}`
        : '',
      stage: input.event.stage,
      source: input.event.source,
      actor: input.prepared.actor || '(unknown)',
      branch: input.prepared.branch || '(unknown)',
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange,
      commitSummaryBlock:
        input.prepared.commitSummaryLines.length > 0
          ? `Commits in this branch update:\n${input.prepared.commitSummaryLines.map((line) => `- ${line}`).join('\n')}`
          : '',
      diffSummaryBlock: buildRepoReviewDiffSummaryBlock({
        prepared: input.prepared,
      }),
      projectContextBlock: buildRepoReviewProjectContextBlock({
        prepared: input.prepared,
      }),
      evidenceBundleBlock: input.prepared.evidenceBundle
        ? buildRepoReviewEvidenceBundleBlock({
            bundle: input.prepared.evidenceBundle,
          })
        : '',
      impactGraphBlock: buildRepoReviewImpactGraphBlock(
        input.prepared.evidenceBundle,
      ),
      contextLimitationsBlock: buildRepoReviewContextLimitationsBlock(
        input.prepared.evidenceBundle,
      ),
      changedFileCount: input.prepared.changedFiles.length,
      changedFiles:
        input.prepared.changedFiles.length > 0
          ? input.prepared.changedFiles.map((file) => `- ${file}`).join('\n')
          : '- (none)',
      diffText: trimContextBlock(
        input.prepared.diffText || '(empty diff)',
        120_000,
      ),
      customPromptBlock: formatRepoReviewCustomPromptBlock(customPrompt),
    },
    fallbackText: REPO_REVIEW_PRIMARY_TEMPLATE,
  });
}

export async function buildReviewPrompt(
  input: ReviewPromptInput,
): Promise<string> {
  const resolved = await resolveReviewPrompt(input);
  return resolved.text;
}

interface RepoReviewAgenticBudget {
  maxSubagents: number;
  delegationFileThreshold: number;
  fullFileReviewEnabled: boolean;
  maxFullFileBytesPerFile: number;
  maxTotalReadBytes: number;
  maxReviewRounds: number;
  extractorEnabled: boolean;
}

interface RepoReviewAgenticPlanTask {
  id: string;
  title: string;
  objective: string;
  files: string[];
  focus: string;
  fullFileFiles: string[];
}

interface RepoReviewAgenticPlan {
  shouldDelegate: boolean;
  delegationReason: string;
  tasks: RepoReviewAgenticPlanTask[];
  fullFileReviewFiles: string[];
  riskAreas: string[];
  notes: string[];
  rawPlan: Record<string, unknown>;
  legacyDirectResult?: ParsedReviewResult;
}

interface RepoReviewAgenticSubagentResult {
  task: RepoReviewAgenticPlanTask;
  checkedFiles: string[];
  readEvidence: Array<{
    file: string;
    evidence: string;
    lines?: string;
  }>;
  findings: RepoReviewRunFinding[];
  fileReviews: RepoReviewFileReview[];
  scopeLimitations: string[];
  confidence: 'high' | 'medium' | 'low';
  failed: boolean;
  timedOut: boolean;
  progressSummary: string;
  remainingChecks: string[];
  outOfScopeReadCount: number;
  rawOutput: string;
}

function inferRepoReviewGraphRiskAreas(files: string[]): string[] {
  const joined = files.join(' ').toLowerCase();
  const areas: string[] = [];
  if (/(^|\s|\/)(tests?|__tests__|spec)(\/|\.|\s|$)|\.(test|spec)\./.test(joined)) {
    areas.push('确认变更行为是否已有测试覆盖，或是否需要同步补充回归测试。');
  }
  if (/(config|settings|env|feature-flag|flag)/.test(joined)) {
    areas.push('确认配置、环境变量或特性开关是否与实现变更保持一致。');
  }
  if (/(schema|migration|sql|db|database|model)/.test(joined)) {
    areas.push('确认数据结构、迁移脚本和持久化读写路径是否一致。');
  }
  if (/(route|router|controller|api|handler)/.test(joined)) {
    areas.push('确认接口入口、参数校验和调用链下游是否完整覆盖。');
  }
  if (/(auth|login|session|permission|role|token)/.test(joined)) {
    areas.push('确认鉴权、会话和权限边界没有被这次修改破坏。');
  }
  if (/(workflow|pipeline|orchestrator|agent)/.test(joined)) {
    areas.push('确认工作流编排、节点输入输出或代理协作链路没有回归。');
  }
  return areas;
}

function buildRepoReviewGraphSuggestedGroups(input: {
  prepared: ReviewPreparedContext;
  maxSubagents: number;
}): Array<{
  communityLabel: string;
  files: string[];
  focus: string;
}> {
  const tasks = input.prepared.changedFiles.map((filePath) => ({
    filePath,
    fileDiff: '',
    fileContent: '',
    relatedFindings: [],
    ...getRepoReviewProjectGraphFileCommunity({
      prepared: input.prepared,
      filePath,
    }),
  }));
  const groups = groupFilesForReview(tasks, input.maxSubagents);
  return groups.map((group) => {
    const communityLabels = Array.from(
      new Set(
        group
          .map((task) => task.communityLabel || task.communityId || 'ungrouped')
          .filter(Boolean),
      ),
    );
    const files = group.map((task) => task.filePath);
    return {
      communityLabel:
        communityLabels.length === 1
          ? communityLabels[0]!
          : communityLabels.join(' + '),
      files,
      focus:
        communityLabels.length === 1
          ? `围绕实现社区 ${communityLabels[0]} 做完整审查，并核对跨文件调用链。`
          : `这是一个跨社区组合任务，重点核对 ${communityLabels.join('、')} 之间的接口边界和依赖关系。`,
    };
  });
}

export function buildRepoReviewGraphPlanningBlock(input: {
  prepared: ReviewPreparedContext;
  maxSubagents: number;
}): string {
  const graphContext = input.prepared.evidenceBundle?.projectGraphContext;
  if (!graphContext || graphContext.status !== 'ready') {
    return '图谱规划提示：\n- Project Graph unavailable，按 diff 和现有 evidence 制定审查计划。';
  }
  const groups = buildRepoReviewGraphSuggestedGroups(input);
  const topChangedFiles = graphContext.topFiles
    .filter((node) => node.filePath && input.prepared.changedFiles.includes(node.filePath))
    .slice(0, 6)
    .map((node) => `${node.filePath} (${node.score.toFixed(1)})`);
  const riskAreas = inferRepoReviewGraphRiskAreas(input.prepared.changedFiles);
  const lines = [
    '图谱规划提示：',
    `- graph_confidence: ${graphContext.confidence.overall.toFixed(2)}`,
    `- graph_communities: ${graphContext.communities.join(', ') || '(none)'}`,
    `- suggested_parallel_groups: ${groups.length}`,
  ];
  if (topChangedFiles.length > 0) {
    lines.push(`- top_changed_files: ${topChangedFiles.join(' ; ')}`);
  }
  if (riskAreas.length > 0) {
    lines.push('- graph_risk_areas:');
    for (const area of riskAreas) lines.push(`  - ${area}`);
  }
  lines.push('- suggested_review_slices:');
  for (const [index, group] of groups.entries()) {
    lines.push(
      `  - slice_${index + 1}: community=${group.communityLabel} | files=${group.files.join(', ')} | focus=${group.focus}`,
    );
  }
  return lines.join('\n');
}

function buildRepoReviewAgenticBudget(input: {
  profile: RepoReviewProfile;
  maxSubagents: number;
}): RepoReviewAgenticBudget {
  return {
    maxSubagents: Math.max(
      1,
      Math.trunc(
        input.maxSubagents || REPO_REVIEW_AGENTIC_DEFAULT_MAX_SUBAGENTS,
      ),
    ),
    delegationFileThreshold: Math.max(
      0,
      Math.trunc(input.profile.diffSubagentThreshold ?? 15),
    ),
    fullFileReviewEnabled: input.profile.includeFullFileContext,
    maxFullFileBytesPerFile:
      REPO_REVIEW_AGENTIC_DEFAULT_MAX_FULL_FILE_BYTES_PER_FILE,
    maxTotalReadBytes: REPO_REVIEW_AGENTIC_DEFAULT_MAX_TOTAL_READ_BYTES,
    maxReviewRounds: REPO_REVIEW_AGENTIC_MAX_REVIEW_ROUNDS,
    extractorEnabled: true,
  };
}

function buildRepoReviewAgenticPromptVariables(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  budget: RepoReviewAgenticBudget;
}): Record<string, unknown> {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  const fullFileReviewInstructions = input.profile.includeFullFileContext
    ? [
        '本次允许主代理和子代理按预算读取变更文件或直接相关文件全文。',
        '不要预加载所有文件全文；只在结论需要上下文时读取。',
        '大文件、二进制或生成文件应跳过全文读取并写入 scope limitation。',
      ].join('\n')
    : '本次未开启全文读取能力；请以 diff、提交摘要和必要的 git 取证为主。';
  const workspaceInspectionInstructions =
    input.event.source === 'local-hook'
      ? '本地 hook 触发：工作区代表本地仓库当前状态，可以直接使用 /workspace/extra 取证。'
      : [
          '远端或同步触发：工作区是只读镜像。',
          '先用 git log、git diff 和目标分支确认当前提交范围。',
          '如果镜像缺少某些引用，请把限制写进 scope_limitations。',
        ].join('\n');
  const graphPlanningBlock = buildRepoReviewGraphPlanningBlock({
    prepared: input.prepared,
    maxSubagents: input.budget.maxSubagents,
  });

  return {
    workspaceInspectionInstructions,
    fullFileReviewInstructions,
    repositoryName: input.repository.name,
    primaryLanguageBlock: input.repository.language
      ? `主要语言：${input.repository.language}`
      : '',
    stage: input.event.stage,
    source: input.event.source,
    actor: input.prepared.actor || '(unknown)',
    branch: input.prepared.branch || '(unknown)',
    baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
    headSha: formatRepoReviewPromptSha(input.prepared.headSha),
    diffRange,
    commitSummaryBlock:
      input.prepared.commitSummaryLines.length > 0
        ? `Commits in this branch update:\n${input.prepared.commitSummaryLines.map((line) => `- ${line}`).join('\n')}`
        : '',
    diffSummaryBlock: buildRepoReviewDiffSummaryBlock({
      prepared: input.prepared,
    }),
    projectContextBlock: buildRepoReviewProjectContextBlock({
      prepared: input.prepared,
    }),
    evidenceBundleBlock: input.prepared.evidenceBundle
      ? buildRepoReviewEvidenceBundleBlock({
          bundle: input.prepared.evidenceBundle,
        })
      : '',
    graphPlanningBlock,
    impactGraphBlock: buildRepoReviewImpactGraphBlock(
      input.prepared.evidenceBundle,
    ),
    contextLimitationsBlock: buildRepoReviewContextLimitationsBlock(
      input.prepared.evidenceBundle,
    ),
    changedFileCount: input.prepared.changedFiles.length,
    changedFiles:
      input.prepared.changedFiles.length > 0
        ? input.prepared.changedFiles.map((file) => `- ${file}`).join('\n')
        : '- (none)',
    diffBytes: Buffer.byteLength(input.prepared.diffText || '', 'utf8'),
    delegationFileThreshold: input.budget.delegationFileThreshold,
    maxSubagents: input.budget.maxSubagents,
    fullFileReviewEnabled: input.budget.fullFileReviewEnabled
      ? 'enabled'
      : 'disabled',
    maxFullFileBytesPerFile: input.budget.maxFullFileBytesPerFile,
    maxTotalReadBytes: input.budget.maxTotalReadBytes,
    maxReviewRounds: input.budget.maxReviewRounds,
    extractorEnabled: input.budget.extractorEnabled ? 'enabled' : 'disabled',
    customPromptBlock: formatRepoReviewCustomPromptBlock(
      input.profile.promptTemplate.trim(),
    ),
  };
}

function buildRepoReviewAgenticPlanOnlyInstructions(input: {
  budget: RepoReviewAgenticBudget;
}): {
  fullFileReviewInstructions: string;
  workspaceInspectionInstructions: string;
} {
  return {
    fullFileReviewInstructions: input.budget.fullFileReviewEnabled
      ? [
          '计划阶段不要实际读取全文，只标记后续可能需要全文确认的变更文件。',
          'tasks[].full_file_files 和 full_file_review_files 只能包含变更文件列表内的路径。',
          '大文件、二进制或生成文件不要列入全文读取计划，可在 notes 说明限制。',
        ].join('\n')
      : [
          '本次未开启全文读取能力。',
          'tasks[].full_file_files 和 full_file_review_files 必须返回空数组 []。',
          '不要把全文读取作为委派、审查或阻断计划的前置条件。',
        ].join('\n'),
    workspaceInspectionInstructions: [
      '计划阶段不调用工具，只使用本提示中的 Review Evidence Bundle、diff 摘要和提交摘要制定 review_plan。',
      '需要后续继续取证的内容写入 risk_areas 或 notes，由后续审查阶段处理。',
    ].join('\n'),
  };
}

export async function resolveRepoReviewAgenticPlanPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  budget: RepoReviewAgenticBudget;
  correction?: string;
  targetUserId?: string;
}): Promise<ResolvedRepoReviewPrompt> {
  const variables = buildRepoReviewAgenticPromptVariables(input);
  const planOnlyInstructions =
    buildRepoReviewAgenticPlanOnlyInstructions(input);
  return resolvePromptText({
    promptKey: 'repo_review.agentic_plan',
    targetUserId: input.targetUserId,
    variables: {
      ...variables,
      ...planOnlyInstructions,
      customPromptBlock: [
        stringValue(variables.customPromptBlock),
        input.correction ? `\n## 计划修正要求\n${input.correction}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    fallbackText: REPO_REVIEW_AGENTIC_PLAN_TEMPLATE,
  });
}

function normalizeRepoReviewAgenticPlanTask(
  value: unknown,
  index: number,
): RepoReviewAgenticPlanTask | null {
  const record = asRecord(value);
  const files = normalizeStringArray(record.files);
  const id = stringValue(record.id) || `task-${index + 1}`;
  const title = stringValue(record.title) || `子审查任务 ${index + 1}`;
  const objective = stringValue(record.objective || record.goal) || title;
  const focus = stringValue(
    record.focus || record.riskTheme || record.risk_theme,
  );
  const fullFileFiles = normalizeStringArray(
    record.full_file_files || record.fullFileFiles,
  );
  if (files.length === 0) return null;
  return {
    id,
    title,
    objective,
    files,
    focus,
    fullFileFiles,
  };
}

function sanitizeRepoReviewAgenticPlanForBudget(input: {
  plan: RepoReviewAgenticPlan;
  budget: RepoReviewAgenticBudget;
  changedFileCount: number;
}): RepoReviewAgenticPlan {
  let plan = input.plan;
  if (
    plan.shouldDelegate &&
    input.changedFileCount <= input.budget.delegationFileThreshold
  ) {
    const reason = `变更文件数 ${input.changedFileCount} 未超过委派阈值 ${input.budget.delegationFileThreshold}，主代理独立审查。`;
    plan = {
      ...plan,
      shouldDelegate: false,
      delegationReason: reason,
      tasks: [],
      notes: [...plan.notes, reason],
      rawPlan: {
        ...plan.rawPlan,
        should_delegate: false,
        delegation_reason: reason,
        tasks: [],
      },
    };
  }
  if (input.budget.fullFileReviewEnabled) return plan;
  const requestedFullFiles =
    plan.fullFileReviewFiles.length +
    plan.tasks.reduce((total, task) => total + task.fullFileFiles.length, 0);
  if (requestedFullFiles === 0) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      fullFileFiles: [],
    })),
    fullFileReviewFiles: [],
    notes: [
      ...plan.notes,
      'Profile 未启用全文读取，系统已忽略计划中的全文读取请求。',
    ],
    rawPlan: {
      ...plan.rawPlan,
      full_file_review_files: [],
      tasks: plan.tasks.map((task) => ({
        ...task,
        full_file_files: [],
      })),
    },
  };
}

function parseRepoReviewAgenticPlan(text: string): RepoReviewAgenticPlan {
  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  if (
    !parsed.review_plan &&
    !parsed.reviewPlan &&
    stringValue(parsed.overall)
  ) {
    return {
      shouldDelegate: false,
      delegationReason:
        '主代理返回了旧版结构化审查结果，系统按不委派审查结果兼容处理。',
      tasks: [],
      fullFileReviewFiles: [],
      riskAreas: [],
      notes: ['legacy-direct-result'],
      rawPlan: {
        should_delegate: false,
        delegation_reason:
          '主代理返回了旧版结构化审查结果，系统按不委派审查结果兼容处理。',
        tasks: [],
      },
      legacyDirectResult: parseReviewResult(text),
    };
  }
  const root = asRecord(parsed.review_plan || parsed.reviewPlan || parsed);
  const tasks = Array.isArray(root.tasks)
    ? root.tasks
        .map((entry, index) => normalizeRepoReviewAgenticPlanTask(entry, index))
        .filter((entry): entry is RepoReviewAgenticPlanTask => Boolean(entry))
    : [];
  return {
    shouldDelegate: normalizeBoolean(
      root.should_delegate ?? root.shouldDelegate,
      tasks.length > 0,
    ),
    delegationReason:
      stringValue(root.delegation_reason || root.delegationReason) ||
      (tasks.length > 0
        ? '主代理选择委派局部审查任务。'
        : '主代理选择独立完成审查。'),
    tasks,
    fullFileReviewFiles: normalizeStringArray(
      root.full_file_review_files || root.fullFileReviewFiles,
    ),
    riskAreas: normalizeStringArray(root.risk_areas || root.riskAreas),
    notes: normalizeStringArray(root.notes),
    rawPlan: root,
  };
}

function validateRepoReviewAgenticPlan(input: {
  plan: RepoReviewAgenticPlan;
  changedFiles: string[];
  budget: RepoReviewAgenticBudget;
}): string[] {
  const errors: string[] = [];
  const changed = new Set(input.changedFiles);
  if (input.plan.shouldDelegate && input.plan.tasks.length === 0) {
    errors.push('计划要求委派，但 tasks 为空。');
  }
  if (input.plan.tasks.length > input.budget.maxSubagents) {
    errors.push(
      `计划包含 ${input.plan.tasks.length} 个子代理任务，超过预算 ${input.budget.maxSubagents}。`,
    );
  }
  for (const task of input.plan.tasks) {
    const invalid = task.files.filter((file) => !changed.has(file));
    if (invalid.length > 0) {
      errors.push(`任务 ${task.id} 包含非变更范围文件：${invalid.join(', ')}`);
    }
    if (task.fullFileFiles.some((file) => !changed.has(file))) {
      errors.push(`任务 ${task.id} 的全文读取列表包含非变更范围文件。`);
    }
  }
  const invalidFullFile = input.plan.fullFileReviewFiles.filter(
    (file) => !changed.has(file),
  );
  if (invalidFullFile.length > 0) {
    errors.push(
      `主计划全文读取列表包含非变更范围文件：${invalidFullFile.join(', ')}`,
    );
  }
  return errors;
}

function buildFallbackRepoReviewAgenticPlan(input: {
  reason: string;
  changedFiles: string[];
}): RepoReviewAgenticPlan {
  return {
    shouldDelegate: false,
    delegationReason: input.reason,
    tasks: [],
    fullFileReviewFiles: [],
    riskAreas: [],
    notes: [input.reason],
    rawPlan: {
      should_delegate: false,
      delegation_reason: input.reason,
      tasks: [],
    },
  };
}

function buildGraphFallbackRepoReviewAgenticPlan(input: {
  prepared: ReviewPreparedContext;
  budget: RepoReviewAgenticBudget;
  reason: string;
}): RepoReviewAgenticPlan | null {
  if (input.prepared.changedFiles.length <= input.budget.delegationFileThreshold) {
    return null;
  }
  const groups = buildRepoReviewGraphSuggestedGroups({
    prepared: input.prepared,
    maxSubagents: input.budget.maxSubagents,
  }).filter((group) => group.files.length > 0);
  if (groups.length <= 1) return null;
  const riskAreas = inferRepoReviewGraphRiskAreas(input.prepared.changedFiles);
  return {
    shouldDelegate: true,
    delegationReason:
      '主代理计划未成功生成，系统按 Project Graph 社区聚类回退为并行局部审查计划。',
    tasks: groups.map((group, index) => ({
      id: `graph-fallback-${index + 1}`,
      title: `图谱分组审查 ${index + 1}`,
      objective: group.focus,
      files: group.files,
      focus: group.communityLabel,
      fullFileFiles: [],
    })),
    fullFileReviewFiles: [],
    riskAreas,
    notes: [input.reason, 'graph-suggested-fallback-plan'],
    rawPlan: {
      should_delegate: true,
      delegation_reason:
        '主代理计划未成功生成，系统按 Project Graph 社区聚类回退为并行局部审查计划。',
      tasks: groups.map((group, index) => ({
        id: `graph-fallback-${index + 1}`,
        title: `图谱分组审查 ${index + 1}`,
        objective: group.focus,
        files: group.files,
        focus: group.communityLabel,
        full_file_files: [],
      })),
      risk_areas: riskAreas,
      notes: [input.reason, 'graph-suggested-fallback-plan'],
    },
  };
}

function compactJsonForPrompt(value: unknown, maxChars = 60_000): string {
  let text = '';
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n...(truncated)`
    : text;
}

async function runRepoReviewMainPlan(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
  userId?: string;
  budget: RepoReviewAgenticBudget;
  onTurnProgress: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  executionStats?: RepoReviewExecutionStats;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}): Promise<RepoReviewAgenticPlan> {
  await input.onProgressStep?.({
    id: 'agentic_main_plan',
    label: '主代理制定审查计划',
    status: 'running',
    detail: '主代理正在制定分工与取证计划',
    kind: 'main',
    inputText: formatProgressKeyValues([
      ['changed_files', input.prepared.changedFiles.join(', ') || '-'],
      ['delegation_threshold', input.budget.delegationFileThreshold],
      ['max_subagents', input.budget.maxSubagents],
    ]),
  });
  let correction = '';
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveRepoReviewAgenticPlanPrompt({
      repository: input.repository,
      profile: input.profile,
      event: input.event,
      prepared: input.prepared,
      budget: input.budget,
      correction,
      targetUserId: input.userId,
    });
    recordRepoReviewPromptBytes(input.executionStats, resolved.text);
    input.executionStats &&
      (input.executionStats.modelCallCount =
        (input.executionStats.modelCallCount || 0) + 1);
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: 'repo_review.agentic_plan',
      featureScope: 'repo_review',
      targetUserId: input.userId ?? '',
      userPromptText: resolved.text,
      providerInputText: resolved.text,
      metadata: {
        runId: input.runId,
        repositoryId: input.repository.id,
        attempt,
        changedFileCount: input.prepared.changedFiles.length,
      },
    });
    let output = '';
    try {
      output = (
        await runReviewAgent({
          repository: input.repository,
          profile: input.profile,
          prompt: resolved.text,
          runId: input.runId,
          runtimeNamespace: `${input.runId}:main-plan:${attempt + 1}`,
          workspacePath: input.workspacePath,
          userId: input.userId,
          toolPolicy: 'none',
          turnContext: {
            groupKey: 'agentic_main_plan',
            groupLabel: '主代理制定审查计划',
            phase: 'main_agent_review',
            ownerKind: 'main',
            ownerLabel: '主代理',
          },
          onTurnProgress: input.onTurnProgress,
          onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
            id: 'agentic_main_plan',
            label: '主代理制定审查计划',
            kind: 'main',
            onProgressStep: input.onProgressStep,
          }),
        })
      ).outputText;
    } catch (err) {
      lastErrors = [errorMessageForProgress(err)];
      await input.onProgressStep?.({
        id: 'agentic_main_plan',
        label: '主代理制定审查计划',
        status: 'running',
        detail: '计划代理未按时返回，要求主代理修正一次',
        kind: 'main',
        error: lastErrors.join('；'),
        outputText: '计划代理未返回有效 review_plan，进入修正重试。',
      });
      correction = [
        '上一次计划代理调用未成功完成，请严格按协议只输出 review_plan JSON。',
        `调用错误：${errorMessageForProgress(err)}`,
      ].join('\n');
      continue;
    }
    try {
      const plan = sanitizeRepoReviewAgenticPlanForBudget({
        plan: parseRepoReviewAgenticPlan(output),
        budget: input.budget,
        changedFileCount: input.prepared.changedFiles.length,
      });
      const errors = validateRepoReviewAgenticPlan({
        plan,
        changedFiles: input.prepared.changedFiles,
        budget: input.budget,
      });
      if (errors.length === 0) {
        input.executionStats &&
          (input.executionStats.plannedSubagentCount = plan.shouldDelegate
            ? plan.tasks.length
            : 0);
        await input.onProgressStep?.({
          id: 'agentic_main_plan',
          label: '主代理制定审查计划',
          status: 'completed',
          detail: plan.shouldDelegate
            ? `已制定 ${plan.tasks.length} 个子代理任务`
            : plan.delegationReason,
          kind: 'main',
          outputText: formatProgressKeyValues([
            ['should_delegate', plan.shouldDelegate],
            ['tasks', plan.tasks.length],
            ['full_file_review_files', plan.fullFileReviewFiles.length],
          ]),
        });
        return plan;
      }
      lastErrors = errors;
      await input.onProgressStep?.({
        id: 'agentic_main_plan',
        label: '主代理制定审查计划',
        status: 'running',
        detail: '计划校验未通过，要求主代理修正一次',
        kind: 'main',
        error: errors.join('；'),
        outputText: '计划校验未通过。',
      });
      correction = [
        '上一次 review_plan 被系统拒绝，请只修正计划，不输出最终审查结论。',
        ...errors.map((entry) => `- ${entry}`),
      ].join('\n');
    } catch (err) {
      lastErrors = [errorMessageForProgress(err)];
      correction = [
        '上一次输出无法解析为 review_plan JSON，请严格按协议只输出 JSON。',
        `解析错误：${errorMessageForProgress(err)}`,
      ].join('\n');
    }
  }
  const reason = `主代理计划非法，已降级为主代理单独审查：${lastErrors.join('；')}`;
  const graphFallbackPlan = buildGraphFallbackRepoReviewAgenticPlan({
    prepared: input.prepared,
    budget: input.budget,
    reason,
  });
  if (graphFallbackPlan) {
    await input.onProgressStep?.({
      id: 'agentic_main_plan',
      label: '主代理制定审查计划',
      status: 'completed',
      detail: `主代理计划失败，系统按图谱社区回退为 ${graphFallbackPlan.tasks.length} 个并行任务`,
      kind: 'main',
      outputText: formatProgressKeyValues([
        ['should_delegate', graphFallbackPlan.shouldDelegate],
        ['tasks', graphFallbackPlan.tasks.length],
        ['fallback', 'project_graph_communities'],
      ]),
    });
    return graphFallbackPlan;
  }
  await input.onProgressStep?.({
    id: 'agentic_main_plan',
    label: '主代理制定审查计划',
    status: 'skipped',
    detail: reason,
    kind: 'main',
    outputText: reason,
  });
  return buildFallbackRepoReviewAgenticPlan({
    reason,
    changedFiles: input.prepared.changedFiles,
  });
}

export async function resolveRepoReviewAgenticSubagentPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  budget: RepoReviewAgenticBudget;
  task: RepoReviewAgenticPlanTask;
  targetUserId?: string;
}): Promise<ResolvedRepoReviewPrompt> {
  const base = buildRepoReviewAgenticPromptVariables(input);
  const diffSlice =
    getRepoReviewDiffSlice(input.prepared.diffIndex!, input.task.files) ||
    buildFilteredDiff(
      input.prepared.diffText,
      new Set(input.task.files),
      input.prepared.diffIndex,
    );
  return resolvePromptText({
    promptKey: 'repo_review.agentic_subagent',
    targetUserId: input.targetUserId,
    variables: {
      ...base,
      taskId: input.task.id,
      taskTitle: input.task.title,
      taskObjective: input.task.objective,
      taskFocus: input.task.focus || '按任务目标审查',
      taskFiles: input.task.files.map((file) => `- ${file}`).join('\n'),
      fullFileFiles:
        input.task.fullFileFiles.length > 0
          ? input.task.fullFileFiles.map((file) => `- ${file}`).join('\n')
          : '- (none)',
      projectContextBlock: buildRepoReviewProjectContextBlock({
        prepared: input.prepared,
        files: input.task.files,
      }),
      evidenceBundleBlock: input.prepared.evidenceBundle
        ? buildRepoReviewEvidenceBundleBlock({
            bundle: filterRepoReviewEvidenceBundleForFiles({
              bundle: input.prepared.evidenceBundle,
              files: input.task.files,
            }),
          })
        : '',
      impactGraphBlock: buildRepoReviewImpactGraphBlock(
        input.prepared.evidenceBundle
          ? filterRepoReviewEvidenceBundleForFiles({
              bundle: input.prepared.evidenceBundle,
              files: input.task.files,
            })
          : undefined,
      ),
      contextLimitationsBlock: buildRepoReviewContextLimitationsBlock(
        input.prepared.evidenceBundle
          ? filterRepoReviewEvidenceBundleForFiles({
              bundle: input.prepared.evidenceBundle,
              files: input.task.files,
            })
          : undefined,
      ),
      diffSlice:
        trimContextBlock(
          diffSlice,
          REPO_REVIEW_AGENTIC_SUBAGENT_DIFF_MAX_CHARS,
        ) || '(diff slice unavailable)',
    },
    fallbackText: REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE,
  });
}

function parseRepoReviewAgenticSubagentResult(
  output: string,
  task: RepoReviewAgenticPlanTask,
): RepoReviewAgenticSubagentResult {
  const allowedFiles = new Set(task.files);
  try {
    const parsed = JSON.parse(extractJsonObject(output)) as Record<
      string,
      unknown
    >;
    const checkedFiles = normalizeStringArray(
      parsed.checked_files || parsed.checkedFiles,
    ).filter((file) => allowedFiles.has(file));
    const rawReadEvidence = parsed.read_evidence || parsed.readEvidence;
    const readEvidence = Array.isArray(rawReadEvidence)
      ? rawReadEvidence
          .map((entry) => {
            const record = asRecord(entry);
            const file = stringValue(record.file);
            if (!file || !allowedFiles.has(file)) return null;
            return {
              file,
              evidence: stringValue(record.evidence || record.summary),
              ...(stringValue(record.lines)
                ? { lines: stringValue(record.lines) }
                : {}),
            };
          })
          .filter(
            (
              entry,
            ): entry is { file: string; evidence: string; lines?: string } =>
              Boolean(entry),
          )
      : [];
    const result = parseReviewResult(
      JSON.stringify({
        overall: 'pass',
        summary: 'subagent',
        findings: parsed.findings,
        file_reviews: parsed.file_reviews || parsed.fileReviews,
        scope_limitations: parsed.scope_limitations || parsed.scopeLimitations,
        suggestions: parsed.suggestions,
        recommended_block: false,
      }),
    );
    const outOfScopeFindingCount = result.findings.filter(
      (finding) => finding.file && !allowedFiles.has(finding.file),
    ).length;
    const confidenceRaw = stringValue(parsed.confidence);
    const confidence =
      confidenceRaw === 'high' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium';
    return {
      task,
      checkedFiles,
      readEvidence,
      findings: result.findings.filter(
        (finding) => !finding.file || allowedFiles.has(finding.file),
      ),
      fileReviews: result.fileReviews.filter((entry) =>
        allowedFiles.has(entry.file),
      ),
      scopeLimitations: normalizeReviewScopeLimitations([
        ...result.scopeLimitations,
        ...(outOfScopeFindingCount > 0
          ? [
              `子代理 ${task.id} 返回了 ${outOfScopeFindingCount} 条越权文件发现，已忽略。`,
            ]
          : []),
      ]),
      confidence,
      failed: false,
      timedOut: normalizeBoolean(parsed.timed_out ?? parsed.timedOut, false),
      progressSummary: stringValue(
        parsed.progress_summary || parsed.progressSummary,
      ),
      remainingChecks: normalizeStringArray(
        parsed.remaining_checks || parsed.remainingChecks,
      ),
      outOfScopeReadCount: 0,
      rawOutput: output,
    };
  } catch {
    const checkedSection = findMarkdownSectionByTitles(output, [
      '已检查内容',
      '已检查范围',
    ]);
    const findingsSection = findMarkdownSectionByTitles(output, ['确认问题']);
    const remainingSection = findMarkdownSectionByTitles(output, [
      '需要主代理继续确认',
      '未完成检查',
    ]);
    const conclusionSection = findMarkdownSectionByTitles(output, ['结论']);
    const checkedFiles = extractMarkdownBulletValues(checkedSection)
      .map((value) => {
        const normalized = value.replace(/^文件[:：]\s*/, '').trim();
        return task.files.find(
          (file) => normalized === file || normalized.includes(file),
        );
      })
      .filter((file): file is string => Boolean(file));
    const findings = parseRepoReviewSubagentFindingBlocks(
      findingsSection,
    ).filter((finding) => !finding.file || allowedFiles.has(finding.file));
    const scopeLimitations = normalizeReviewScopeLimitations(
      remainingSection ||
        '子代理返回了 Markdown 结果，主代理需要结合原文继续判断。',
    );
    const progressSummary =
      conclusionSection ||
      checkedSection ||
      '子代理已返回 Markdown 结论，主代理将继续汇总。';
    return {
      task,
      checkedFiles,
      readEvidence: checkedFiles.map((file) => ({
        file,
        evidence: `子代理在 Markdown 结果中确认已检查 ${file}。`,
      })),
      findings,
      fileReviews: [],
      scopeLimitations,
      confidence: parseRepoReviewSubagentConfidence(
        conclusionSection || output,
      ),
      failed: false,
      timedOut: /超时前|当前进度总结/.test(conclusionSection || output),
      progressSummary,
      remainingChecks: extractMarkdownBulletValues(remainingSection),
      outOfScopeReadCount: 0,
      rawOutput: output,
    };
  }
}

async function runRepoReviewAgenticSubagents(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
  userId?: string;
  budget: RepoReviewAgenticBudget;
  tasks: RepoReviewAgenticPlanTask[];
  onTurnProgress: (turnsByTask: RepoReviewAssistantTurn[][]) => Promise<void>;
  executionStats?: RepoReviewExecutionStats;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}): Promise<RepoReviewAgenticSubagentResult[]> {
  const turnsByTask: RepoReviewAssistantTurn[][] = input.tasks.map(() => []);
  const emitProgress = async () => input.onTurnProgress(turnsByTask);
  for (let index = 0; index < input.tasks.length; index += 1) {
    const task = input.tasks[index]!;
    await input.onProgressStep?.({
      id: `agentic_subagent_${index + 1}`,
      label: `子代理 ${index + 1}/${input.tasks.length}`,
      status: 'queued',
      detail: `${task.title}：${task.files.join('、')}`,
      kind: 'subagent',
      inputText: formatProgressKeyValues([
        ['task_id', task.id],
        ['files', task.files.join(', ') || '-'],
      ]),
    });
  }
  const results = await mapWithConcurrencyLimit(
    input.tasks,
    input.budget.maxSubagents,
    async (task, index) => {
      const stepId = `agentic_subagent_${index + 1}`;
      const toolTurnId = `${input.runId}:agentic-subagent-tool:${task.id}:${slugifyId(
        task.files.join(','),
      )}`;
      const toolCallId = `${toolTurnId}:agent`;
      const runtimeNamespace = `${input.runId}:subagent:${index + 1}`;
      let syntheticToolTurn: RepoReviewAssistantTurn | null = null;
      let childTurns: RepoReviewAssistantTurn[] = [];
      let resolvedPromptText = '';
      const setWorkerTurns = async () => {
        turnsByTask[index] = [
          ...(syntheticToolTurn ? [syntheticToolTurn] : []),
          ...childTurns,
        ];
        await emitProgress();
      };
      await input.onProgressStep?.({
        id: stepId,
        label: `子代理 ${index + 1}/${input.tasks.length}`,
        status: 'running',
        detail: `${task.title}：${task.files.join('、')}`,
        kind: 'subagent',
        inputText: formatProgressKeyValues([
          ['task_id', task.id],
          ['title', task.title],
          ['files', task.files.join(', ') || '-'],
        ]),
      });
      try {
        const subagentTimeoutMs = resolveRepoReviewProfileSubagentTimeoutMs(
          input.profile,
        );
        const resolved = await resolveRepoReviewAgenticSubagentPrompt({
          repository: input.repository,
          profile: input.profile,
          event: input.event,
          prepared: input.prepared,
          budget: input.budget,
          task,
          targetUserId: input.userId,
        });
        resolvedPromptText = resolved.text;
        recordRepoReviewPromptBytes(input.executionStats, resolved.text);
        input.executionStats &&
          (input.executionStats.modelCallCount =
            (input.executionStats.modelCallCount || 0) + 1);
        await recordPromptTrace({
          traceKind: 'direct_provider',
          promptKey: 'repo_review.agentic_subagent',
          featureScope: 'repo_review',
          targetUserId: input.userId ?? '',
          userPromptText: resolved.text,
          providerInputText: resolved.text,
          metadata: {
            runId: input.runId,
            repositoryId: input.repository.id,
            taskId: task.id,
            fileCount: task.files.length,
          },
        });
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label: `子代理 ${index + 1}/${input.tasks.length}`,
          task: task.files.length === 1 ? task.files[0]! : task.title,
          argumentsText: buildRepoReviewSubagentPromptPreview({
            label: `子代理 ${index + 1}/${input.tasks.length}`,
            task: task.title,
            files: task.files,
            focus: task.focus,
            fullFileFiles: task.fullFileFiles,
          }),
          status: 'in_progress',
        });
        await setWorkerTurns();
        const reviewResult = await runReviewAgent({
          repository: input.repository,
          profile: input.profile,
          prompt: resolved.text,
          runId: input.runId,
          runtimeNamespace,
          workspacePath: input.workspacePath,
          userId: input.userId,
          toolPolicy: 'none',
          turnContext: {
            groupKey: stepId,
            groupLabel: `子代理 ${index + 1}/${input.tasks.length}`,
            phase: 'worker',
            parentToolCallId: toolCallId,
            ownerKind: 'subagent',
            ownerLabel: `子代理 ${index + 1}/${input.tasks.length}`,
          },
          timeoutMs: subagentTimeoutMs,
          timeoutGraceMs: REPO_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS,
          timeoutFollowupPrompt: buildRepoReviewSubagentTimeoutFollowupPrompt({
            task,
          }),
          onTimeoutFollowupDispatched: async () => {
            await input.onProgressStep?.({
              id: stepId,
              label: `子代理 ${index + 1}/${input.tasks.length}`,
              status: 'running',
              detail: `${task.title} 超时，已请求当前进度总结`,
              kind: 'subagent',
              metadataText: formatProgressKeyValues([
                ['timeout_ms', subagentTimeoutMs],
                ['grace_ms', REPO_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS],
                ['takeover', 'pending'],
              ]),
            });
          },
          onTurnProgress: async (turns) => {
            childTurns = turns;
            await setWorkerTurns();
          },
          onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
            id: stepId,
            label: `子代理 ${index + 1}/${input.tasks.length}`,
            kind: 'subagent',
            onProgressStep: input.onProgressStep,
          }),
        });
        const parsed = parseRepoReviewAgenticSubagentResult(
          reviewResult.outputText,
          task,
        );
        const outOfScopeReadCount = countRepoReviewOutOfScopeReads(
          childTurns,
          task.files,
        );
        const subagentToolCallCount =
          countRepoReviewReadonlyEvidenceToolCalls(childTurns);
        if (input.executionStats) {
          input.executionStats.subagentToolCallCount =
            (input.executionStats.subagentToolCallCount || 0) +
            subagentToolCallCount;
        }
        const augmentedScopeLimitations = normalizeReviewScopeLimitations([
          ...parsed.scopeLimitations,
          ...(outOfScopeReadCount > 0
            ? [
                `子代理 ${task.id} 发生 ${outOfScopeReadCount} 次越权读取，仅作为低置信度参考。`,
              ]
            : []),
        ]);
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label: `子代理 ${index + 1}/${input.tasks.length}`,
          task: task.files.length === 1 ? task.files[0]! : task.title,
          argumentsText: buildRepoReviewSubagentPromptPreview({
            label: `子代理 ${index + 1}/${input.tasks.length}`,
            task: task.title,
            files: task.files,
            focus: task.focus,
            fullFileFiles: task.fullFileFiles,
          }),
          resultText: [
            `子代理只读补证次数：${subagentToolCallCount}`,
            reviewResult.outputText,
          ].join('\n\n'),
          status: 'completed',
        });
        await setWorkerTurns();
        await input.onProgressStep?.({
          id: stepId,
          label: `子代理 ${index + 1}/${input.tasks.length}`,
          status: 'completed',
          detail: reviewResult.timedOut
            ? `${task.title} 超时后已返回当前进度总结`
            : `完成 ${task.files.length} 个文件，发现 ${parsed.findings.length} 个问题`,
          kind: 'subagent',
          outputText: formatProgressKeyValues([
            ['checked_files', parsed.checkedFiles.join(', ') || '-'],
            ['findings', parsed.findings.length],
            ['scope_limitations', augmentedScopeLimitations.length],
            ['timed_out', reviewResult.timedOut],
            ['out_of_scope_reads', outOfScopeReadCount],
            ['readonly_evidence_calls', subagentToolCallCount],
          ]),
        });
        return {
          ...parsed,
          scopeLimitations: augmentedScopeLimitations,
          timedOut: reviewResult.timedOut || parsed.timedOut,
          outOfScopeReadCount,
        };
      } catch (err) {
        const error = errorMessageForProgress(err);
        const subagentToolCallCount =
          countRepoReviewReadonlyEvidenceToolCalls(childTurns);
        if (input.executionStats) {
          input.executionStats.subagentToolCallCount =
            (input.executionStats.subagentToolCallCount || 0) +
            subagentToolCallCount;
        }
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label: `子代理 ${index + 1}/${input.tasks.length}`,
          task: task.files.length === 1 ? task.files[0]! : task.title,
          argumentsText:
            resolvedPromptText ||
            buildRepoReviewSubagentPromptPreview({
              label: `子代理 ${index + 1}/${input.tasks.length}`,
              task: task.title,
              files: task.files,
              focus: task.focus,
              fullFileFiles: task.fullFileFiles,
            }),
          errorText: [
            `子代理只读补证次数：${subagentToolCallCount}`,
            error,
          ].join('\n\n'),
          status: 'failed',
        });
        await setWorkerTurns();
        await input.onProgressStep?.({
          id: stepId,
          label: `子代理 ${index + 1}/${input.tasks.length}`,
          status: 'failed',
          detail: `${task.title} 执行失败`,
          kind: 'subagent',
          error,
          outputText: formatProgressKeyValues([
            ['readonly_evidence_calls', subagentToolCallCount],
            ['error', error],
          ]),
        });
        return {
          task,
          checkedFiles: [],
          readEvidence: [],
          findings: [],
          fileReviews: [],
          scopeLimitations: [`子代理 ${task.id} 执行失败：${error}`],
          confidence: 'low' as const,
          failed: true,
          timedOut: /timed out/i.test(error),
          progressSummary: '',
          remainingChecks: [],
          outOfScopeReadCount: 0,
          rawOutput: '',
        };
      }
    },
  );
  input.executionStats &&
    (input.executionStats.delegatedSubagentCount = results.filter(
      (result) => !result.failed,
    ).length);
  return results;
}

function buildRepoReviewSubagentResultsPrompt(
  results: RepoReviewAgenticSubagentResult[],
): string {
  if (results.length === 0) return '未委派子代理。';
  return compactJsonForPrompt(
    results.map((result) => ({
      task: {
        id: result.task.id,
        title: result.task.title,
        files: result.task.files,
        focus: result.task.focus,
      },
      confidence: result.confidence,
      status: result.timedOut ? 'timed_out' : 'completed',
      checked_files: result.checkedFiles,
      findings: result.findings.map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        title: finding.title,
        detail: trimContextBlock(
          finding.detail || '',
          REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS,
        ),
        suggestion: trimContextBlock(
          finding.suggestion || '',
          REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS,
        ),
      })),
      scope_limitations: result.scopeLimitations.map((line) =>
        trimContextBlock(line, REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS),
      ),
      progress_summary: trimContextBlock(
        result.progressSummary || '',
        REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS,
      ),
      remaining_checks: result.remainingChecks.map((line) =>
        trimContextBlock(line, REPO_REVIEW_SUBAGENT_RESULT_PROMPT_MAX_CHARS),
      ),
      out_of_scope_reads: result.outOfScopeReadCount,
    })),
  );
}

function buildRepoReviewSupplementalResultsPrompt(
  results: RepoReviewSupplementalExecutionResult[],
): string {
  if (results.length === 0) return '未执行补充子代理。';
  return compactJsonForPrompt(
    results.map((result) => ({
      file_review: result.fileReview,
      findings: result.findings,
      scope_limitations: result.scopeLimitations,
      suggestions: result.suggestions,
      overall_impact: result.overallImpact,
      recommended_block: result.recommendedBlock,
      failed: result.failed,
    })),
  );
}

export async function resolveRepoReviewAgenticFinalPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  budget: RepoReviewAgenticBudget;
  plan: RepoReviewAgenticPlan;
  subagentResults: RepoReviewAgenticSubagentResult[];
  targetUserId?: string;
}): Promise<ResolvedRepoReviewPrompt> {
  const variables = buildRepoReviewAgenticPromptVariables(input);
  return resolvePromptText({
    promptKey: 'repo_review.agentic_final',
    targetUserId: input.targetUserId,
    variables: {
      ...variables,
      reviewPlan: compactJsonForPrompt(input.plan.rawPlan),
      subagentResults: buildRepoReviewSubagentResultsPrompt(
        input.subagentResults,
      ),
    },
    fallbackText: REPO_REVIEW_AGENTIC_FINAL_TEMPLATE,
  });
}

export async function resolveRepoReviewAgenticExtractorPrompt(input: {
  mainReportMarkdown: string;
  subagentResults: RepoReviewAgenticSubagentResult[];
  subagentResultsText?: string;
  targetUserId?: string;
}): Promise<ResolvedRepoReviewPrompt> {
  return resolvePromptText({
    promptKey: 'repo_review.agentic_extractor',
    targetUserId: input.targetUserId,
    variables: {
      mainReportMarkdown: input.mainReportMarkdown,
      subagentResults:
        input.subagentResultsText ||
        buildRepoReviewSubagentResultsPrompt(input.subagentResults),
    },
    fallbackText: REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE,
  });
}

function buildFallbackExtractedRepoReviewResult(
  mainReportMarkdown: string,
  limitations: string[],
): ParsedReviewResult {
  const summary =
    mainReportMarkdown
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) || '主审查报告已生成，但格式化整理失败。';
  return {
    overall: 'warn',
    summary,
    findings: [],
    fileReviews: [],
    scopeLimitations: normalizeReviewScopeLimitations(limitations),
    commitReviews: [],
    suggestions: [],
    recommendedBlock: false,
    markdownBody: mainReportMarkdown,
    rawModelOutput: mainReportMarkdown,
  };
}

async function extractRepoReviewStructuredResult(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  mainReportMarkdown: string;
  subagentResults: RepoReviewAgenticSubagentResult[];
  subagentResultsText?: string;
  runId: string;
  workspacePath?: string | null;
  userId?: string;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
  onTurnProgress: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  executionStats?: RepoReviewExecutionStats;
}): Promise<ParsedReviewResult> {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveRepoReviewAgenticExtractorPrompt({
      mainReportMarkdown: input.mainReportMarkdown,
      subagentResults: input.subagentResults,
      subagentResultsText: input.subagentResultsText,
      targetUserId: input.userId,
    });
    recordRepoReviewPromptBytes(input.executionStats, resolved.text);
    if (input.executionStats) {
      input.executionStats.modelCallCount =
        (input.executionStats.modelCallCount || 0) + 1;
      input.executionStats.extractorAttempts =
        (input.executionStats.extractorAttempts || 0) + 1;
    }
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: 'repo_review.agentic_extractor',
      featureScope: 'repo_review',
      targetUserId: input.userId ?? '',
      userPromptText: resolved.text,
      providerInputText: resolved.text,
      metadata: {
        runId: input.runId,
        repositoryId: input.repository.id,
        attempt,
      },
    });
    try {
      const output = (
        await runReviewAgent({
          repository: input.repository,
          profile: input.profile,
          prompt: resolved.text,
          runId: input.runId,
          runtimeNamespace: `${input.runId}:extractor:${attempt + 1}`,
          workspacePath: input.workspacePath,
          userId: input.userId,
          attachWorkspace: false,
          toolPolicy: 'none',
          turnContext: {
            groupKey: 'agentic_structured_extract',
            groupLabel: '格式化整理',
            phase: 'formatter',
            ownerKind: 'formatter',
            ownerLabel: '格式化整理',
          },
          onTurnProgress: input.onTurnProgress,
          onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
            id: 'agentic_structured_extract',
            label: '格式化整理',
            kind: 'extractor',
            onProgressStep: input.onProgressStep,
          }),
        })
      ).outputText;
      const parsed = parseReviewResult(output);
      return {
        ...parsed,
        rawModelOutput: output,
      };
    } catch (err) {
      failures.push(errorMessageForProgress(err));
    }
  }
  return buildFallbackExtractedRepoReviewResult(input.mainReportMarkdown, [
    `格式化整理失败：${failures.join('；')}`,
  ]);
}

async function runRepoReviewAgenticReview(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
  userId?: string;
  budget: RepoReviewAgenticBudget;
  onPhaseProgress: (turns: {
    planTurns: RepoReviewAssistantTurn[];
    subagentTurns: RepoReviewAssistantTurn[][];
    finalTurns: RepoReviewAssistantTurn[];
    extractorTurns: RepoReviewAssistantTurn[];
  }) => Promise<void>;
  executionStats?: RepoReviewExecutionStats;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}): Promise<{
  parsed: ParsedReviewResult;
  reviewTurns: RepoReviewAssistantTurn[];
  plan: RepoReviewAgenticPlan;
  subagentResults: RepoReviewAgenticSubagentResult[];
}> {
  if (
    input.prepared.changedFiles.length <= input.budget.delegationFileThreshold
  ) {
    const reason = `变更文件数 ${input.prepared.changedFiles.length} 未超过委派阈值 ${input.budget.delegationFileThreshold}，主代理直接审查。`;
    await input.onProgressStep?.({
      id: 'agentic_main_summary',
      label: '主代理直接审查',
      status: 'running',
      detail: reason,
      kind: 'main',
      inputText: formatProgressKeyValues([
        ['changed_files', input.prepared.changedFiles.join(', ') || '-'],
        ['delegation_threshold', input.budget.delegationFileThreshold],
      ]),
      outputText: formatProgressKeyValues([
        ['changed_files', input.prepared.changedFiles.length],
        ['delegation_threshold', input.budget.delegationFileThreshold],
      ]),
    });
    const directPrompt = await resolveReviewPrompt({
      repository: input.repository,
      profile: input.profile,
      event: input.event,
      prepared: input.prepared,
      reviewMode: 'direct',
      targetUserId: input.userId,
    });
    recordRepoReviewPromptBytes(input.executionStats, directPrompt.text);
    input.executionStats &&
      (input.executionStats.modelCallCount =
        (input.executionStats.modelCallCount || 0) + 1);
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: 'repo_review.primary',
      featureScope: 'repo_review',
      targetUserId: input.userId ?? '',
      userPromptText: directPrompt.text,
      providerInputText: directPrompt.text,
      metadata: {
        runId: input.runId,
        repositoryId: input.repository.id,
        directReview: true,
      },
    });
    let directTurns: RepoReviewAssistantTurn[] = [];
    const mainReportResult = await runReviewAgent({
      repository: input.repository,
      profile: input.profile,
      prompt: directPrompt.text,
      runId: input.runId,
      runtimeNamespace: `${input.runId}:main-direct`,
      workspacePath: input.workspacePath,
      userId: input.userId,
      turnContext: {
        groupKey: 'agentic_main_summary',
        groupLabel: '主代理直接审查',
        phase: 'main_agent_review',
        ownerKind: 'main',
        ownerLabel: '主代理',
      },
      onTurnProgress: async (turns) => {
        directTurns = turns;
        if (input.executionStats) {
          input.executionStats.mainReadonlyToolCallCount =
            countRepoReviewReadonlyEvidenceToolCalls(directTurns);
        }
        await input.onPhaseProgress({
          planTurns: [],
          subagentTurns: [],
          finalTurns: turns,
          extractorTurns: [],
        });
      },
      onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
        id: 'agentic_main_summary',
        label: '主代理直接审查',
        kind: 'main',
        onProgressStep: input.onProgressStep,
      }),
    });
    const parsed = parseReviewResult(mainReportResult.outputText);
    await input.onProgressStep?.({
      id: 'agentic_main_summary',
      label: '主代理直接审查',
      status: 'completed',
      detail: '主代理已直接生成审查结论',
      kind: 'main',
      inputText: formatProgressKeyValues([
        ['prompt_mode', 'direct'],
        ['changed_files', input.prepared.changedFiles.join(', ') || '-'],
      ]),
      outputText: formatProgressKeyValues([
        ['overall', parsed.overall],
        ['summary', parsed.summary],
        ['findings', parsed.findings.length],
        ['branch', input.prepared.branch || '-'],
        [
          'review_range',
          buildRepoReviewDiffRange({
            baseSha: input.prepared.baseSha,
            headSha: input.prepared.headSha,
          }),
        ],
        [
          'main_readonly_evidence_calls',
          input.executionStats?.mainReadonlyToolCallCount || 0,
        ],
      ]),
      metadataText: formatProgressKeyValues([
        ['review_turns', directTurns.length],
        ['diff_files', input.prepared.changedFiles.length],
      ]),
    });
    return {
      parsed,
      reviewTurns: directTurns,
      plan: buildFallbackRepoReviewAgenticPlan({
        reason,
        changedFiles: input.prepared.changedFiles,
      }),
      subagentResults: [],
    };
  }
  let planTurns: RepoReviewAssistantTurn[] = [];
  let subagentTurns: RepoReviewAssistantTurn[][] = [];
  let finalTurns: RepoReviewAssistantTurn[] = [];
  let extractorTurns: RepoReviewAssistantTurn[] = [];
  const emitProgress = async () =>
    input.onPhaseProgress({
      planTurns,
      subagentTurns,
      finalTurns,
      extractorTurns,
    });

  const plan = await runRepoReviewMainPlan({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    runId: input.runId,
    workspacePath: input.workspacePath,
    userId: input.userId,
    budget: input.budget,
    executionStats: input.executionStats,
    onProgressStep: input.onProgressStep,
    onTurnProgress: async (turns) => {
      planTurns = turns;
      await emitProgress();
    },
  });
  if (plan.legacyDirectResult) {
    await input.onProgressStep?.({
      id: 'agentic_subagents',
      label: '执行子代理局部审查',
      status: 'skipped',
      detail: plan.delegationReason,
      kind: 'main',
      outputText: plan.delegationReason,
    });
    await input.onProgressStep?.({
      id: 'agentic_main_summary',
      label: '主代理汇总结论',
      status: 'completed',
      detail: '已兼容旧版结构化审查结果',
      kind: 'main',
      outputText: formatProgressKeyValues([
        ['overall', plan.legacyDirectResult.overall],
        ['summary', plan.legacyDirectResult.summary],
      ]),
    });
    await input.onProgressStep?.({
      id: 'agentic_structured_extract',
      label: '格式化整理',
      status: 'skipped',
      detail: '主代理已直接返回结构化结果',
      kind: 'extractor',
      outputText: '主代理已直接返回结构化结果，跳过独立提取器。',
    });
    return {
      parsed: plan.legacyDirectResult,
      reviewTurns: planTurns,
      plan,
      subagentResults: [],
    };
  }
  if (
    plan.shouldDelegate &&
    plan.tasks.length > 0 &&
    !input.prepared.diffIndex
  ) {
    await input.onProgressStep?.({
      id: 'build_diff_index',
      label: '构建 Diff Index',
      status: 'running',
      detail: `${input.prepared.changedFiles.length} 个变更文件`,
      kind: 'stage',
      inputText: formatProgressKeyValues([
        ['changed_files', input.prepared.changedFiles.join(', ') || '-'],
        [
          'diff_bytes',
          Buffer.byteLength(input.prepared.diffText || '', 'utf8'),
        ],
      ]),
    });
    input.prepared.diffIndex = buildRepoReviewDiffIndex(
      input.prepared.diffText,
    );
    await input.onProgressStep?.({
      id: 'build_diff_index',
      label: '构建 Diff Index',
      status: 'completed',
      detail: `${Buffer.byteLength(input.prepared.diffText || '', 'utf8')} bytes`,
      kind: 'stage',
      outputText: formatProgressKeyValues([
        ['files_indexed', input.prepared.diffIndex.files.length],
        ['diff_entries', input.prepared.diffIndex.entries.length],
        [
          'diff_bytes',
          Buffer.byteLength(input.prepared.diffText || '', 'utf8'),
        ],
      ]),
      metadataText: formatProgressKeyValues([
        ['indexed_files', input.prepared.diffIndex.files.join(', ') || '-'],
      ]),
    });
  }
  const effectiveTasks = plan.shouldDelegate ? plan.tasks : [];
  let subagentResults: RepoReviewAgenticSubagentResult[] = [];
  if (effectiveTasks.length > 0) {
    await input.onProgressStep?.({
      id: 'agentic_subagents',
      label: '执行子代理局部审查',
      status: 'running',
      detail: `${effectiveTasks.length} 个子代理任务，并发上限 ${input.budget.maxSubagents}`,
      kind: 'main',
      inputText: formatProgressKeyValues([
        ['tasks', effectiveTasks.length],
        ['max_subagents', input.budget.maxSubagents],
      ]),
    });
    subagentResults = await runRepoReviewAgenticSubagents({
      repository: input.repository,
      profile: input.profile,
      event: input.event,
      prepared: input.prepared,
      runId: input.runId,
      workspacePath: input.workspacePath,
      userId: input.userId,
      budget: input.budget,
      tasks: effectiveTasks,
      executionStats: input.executionStats,
      onProgressStep: input.onProgressStep,
      onTurnProgress: async (turns) => {
        subagentTurns = turns;
        await emitProgress();
      },
    });
    await input.onProgressStep?.({
      id: 'agentic_subagents',
      label: '执行子代理局部审查',
      status: 'completed',
      detail: `完成 ${subagentResults.filter((result) => !result.failed).length}/${effectiveTasks.length} 个子代理任务`,
      kind: 'main',
      outputText: formatProgressKeyValues([
        [
          'completed',
          subagentResults.filter((result) => !result.failed).length,
        ],
        ['failed', subagentResults.filter((result) => result.failed).length],
        [
          'subagent_readonly_evidence_calls',
          input.executionStats?.subagentToolCallCount || 0,
        ],
      ]),
    });
  } else {
    await input.onProgressStep?.({
      id: 'agentic_subagents',
      label: '执行子代理局部审查',
      status: 'skipped',
      detail: plan.delegationReason,
      kind: 'main',
      outputText: plan.delegationReason,
    });
  }

  await input.onProgressStep?.({
    id: 'agentic_main_summary',
    label: '主代理汇总结论',
    status: 'running',
    detail:
      subagentResults.length > 0
        ? `汇总 ${subagentResults.length} 个子代理结果`
        : '主代理基于自身取证汇总结论',
    kind: 'main',
    inputText: formatProgressKeyValues([
      ['plan_should_delegate', plan.shouldDelegate],
      ['subagent_results', subagentResults.length],
      ['workspace_path', input.workspacePath || '-'],
    ]),
  });
  const finalPrompt = await resolveRepoReviewAgenticFinalPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    budget: input.budget,
    plan,
    subagentResults,
    targetUserId: input.userId,
  });
  recordRepoReviewPromptBytes(input.executionStats, finalPrompt.text);
  input.executionStats &&
    (input.executionStats.modelCallCount =
      (input.executionStats.modelCallCount || 0) + 1);
  await recordPromptTrace({
    traceKind: 'direct_provider',
    promptKey: 'repo_review.agentic_final',
    featureScope: 'repo_review',
    targetUserId: input.userId ?? '',
    userPromptText: finalPrompt.text,
    providerInputText: finalPrompt.text,
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      delegatedSubagents: subagentResults.length,
    },
  });
  const mainReportResult = await runReviewAgent({
    repository: input.repository,
    profile: input.profile,
    prompt: finalPrompt.text,
    runId: input.runId,
    runtimeNamespace: `${input.runId}:main-final`,
    workspacePath: input.workspacePath,
    userId: input.userId,
    turnContext: {
      groupKey: 'agentic_main_summary',
      groupLabel: '主代理汇总结论',
      phase: 'main_agent_fallback_review',
      ownerKind: 'main',
      ownerLabel: '主代理',
    },
    onTurnProgress: async (turns) => {
      finalTurns = turns;
      if (input.executionStats) {
        input.executionStats.mainReadonlyToolCallCount =
          countRepoReviewReadonlyEvidenceToolCalls(finalTurns);
      }
      await emitProgress();
    },
    onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
      id: 'agentic_main_summary',
      label: '主代理汇总结论',
      kind: 'main',
      onProgressStep: input.onProgressStep,
    }),
  });
  throwIfRepoReviewRunCancelled(input.runId);
  const finalOutput = mainReportResult.outputText;
  let parsed: ParsedReviewResult;
  let usedExtractor = false;
  try {
    parsed = parseReviewResult(finalOutput);
  } catch {
    parsed = await extractRepoReviewStructuredResult({
      repository: input.repository,
      profile: input.profile,
      mainReportMarkdown: finalOutput,
      subagentResults,
      runId: input.runId,
      workspacePath: input.workspacePath,
      userId: input.userId,
      executionStats: input.executionStats,
      onTurnProgress: async (turns) => {
        extractorTurns = turns;
        await emitProgress();
      },
      onProgressStep: input.onProgressStep,
    });
    usedExtractor = true;
  }
  await input.onProgressStep?.({
    id: 'agentic_main_summary',
    label: '主代理汇总结论',
    status: 'completed',
    detail: usedExtractor
      ? '主代理报告已生成，已通过 formatter 兜底结构化'
      : '主代理已直接生成结构化结论',
    kind: 'main',
    outputText: formatProgressKeyValues([
      ['overall', parsed.overall],
      ['summary', parsed.summary],
      ['subagent_results', subagentResults.length],
      ['branch', input.prepared.branch || '-'],
      [
        'review_range',
        buildRepoReviewDiffRange({
          baseSha: input.prepared.baseSha,
          headSha: input.prepared.headSha,
        }),
      ],
      [
        'main_readonly_evidence_calls',
        input.executionStats?.mainReadonlyToolCallCount || 0,
      ],
    ]),
  });
  if (usedExtractor) {
    await input.onProgressStep?.({
      id: 'agentic_structured_extract',
      label: '格式化整理',
      status: 'completed',
      detail: `${input.executionStats?.extractorAttempts || 0} 次提取尝试`,
      kind: 'extractor',
      outputText: formatProgressKeyValues([
        ['overall', parsed.overall],
        ['summary', parsed.summary],
        ['attempts', input.executionStats?.extractorAttempts || 0],
      ]),
    });
  } else {
    await input.onProgressStep?.({
      id: 'agentic_structured_extract',
      label: '格式化整理',
      status: 'skipped',
      detail: '主代理已直接返回结构化 JSON',
      kind: 'extractor',
      outputText: '主代理已直接返回结构化 JSON，跳过独立 formatter。',
    });
  }
  return {
    parsed,
    reviewTurns: [
      ...planTurns,
      ...subagentTurns.flat(),
      ...finalTurns,
      ...extractorTurns,
    ],
    plan,
    subagentResults,
  };
}

type SupplementalFileReviewPromptInput = {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prepared: ReviewPreparedContext;
  filePath: string;
  fileDiff?: string;
  fileContent?: string;
  relatedFindings: RepoReviewRunFinding[];
  primarySummary: string;
  targetUserId?: string;
};

export async function resolveSupplementalFileReviewPrompt(
  input: SupplementalFileReviewPromptInput,
): Promise<ResolvedRepoReviewPrompt> {
  const customPrompt = input.profile.promptTemplate.trim();
  const relatedFindingsText =
    input.relatedFindings.length > 0
      ? input.relatedFindings
          .map((finding) => formatRepoReviewFindingForPrompt(finding))
          .join('\n')
      : '暂无关联发现。';
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return resolvePromptText({
    promptKey: 'repo_review.supplemental_file',
    targetUserId: input.targetUserId,
    variables: {
      repositoryName: input.repository.name,
      primaryLanguageBlock: input.repository.language
        ? `主要语言：${input.repository.language}`
        : '',
      branch: input.prepared.branch || '(unknown)',
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange,
      filePath: input.filePath,
      primarySummary: input.primarySummary || '暂无主审查摘要。',
      relatedFindings: relatedFindingsText,
      fileDiff: trimContextBlock(input.fileDiff || '(empty file diff)', 40_000),
      fileContent:
        input.fileContent?.trim() ||
        '完整内容不可用；请将此限制写入 scope_limitations。',
      customPromptBlock: formatRepoReviewCustomPromptBlock(customPrompt),
    },
    fallbackText: REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE,
  });
}

export async function buildSupplementalFileReviewPrompt(
  input: SupplementalFileReviewPromptInput,
): Promise<string> {
  const resolved = await resolveSupplementalFileReviewPrompt(input);
  return resolved.text;
}

function buildSupplementalFullFileManifestTaskBlock(
  input: RepoReviewFullFileTaskManifest,
): string {
  const relatedFindingsText =
    input.relatedFindings.length > 0
      ? input.relatedFindings
          .map((finding) => formatRepoReviewFindingForPrompt(finding))
          .join('\n')
      : '暂无关联发现。';
  return [
    `文件路径：${input.filePath}`,
    input.communityLabel ? `实现社区：${input.communityLabel}` : '',
    `估算 diff 大小：${input.estimatedDiffBytes} bytes`,
    `估算全文大小：${input.estimatedFileBytes} bytes`,
    `估算 payload 大小：${input.estimatedBytes} bytes`,
    '相关发现：',
    relatedFindingsText,
  ].join('\n');
}

type SupplementalFullFileReviewOrchestratorPromptInput = {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prepared: ReviewPreparedContext;
  primarySummary: string;
  tasks: RepoReviewFullFileTaskManifest[];
  taskGroups: RepoReviewFullFileTaskManifest[][];
  maxSubagents?: number;
  targetUserId?: string;
};

export async function resolveSupplementalFullFileReviewOrchestratorPrompt(
  input: SupplementalFullFileReviewOrchestratorPromptInput,
): Promise<ResolvedRepoReviewPrompt> {
  const customPrompt = input.profile.promptTemplate.trim();
  const useGrouped =
    input.taskGroups.length > 0 && input.taskGroups.length < input.tasks.length;
  const taskBlocks = useGrouped
    ? input.taskGroups
        .map((group, gi) =>
          [
            `### \u5206\u7ec4\u4efb\u52a1 ${gi + 1}\uff08${group.length} \u4e2a\u6587\u4ef6\uff09`,
            ...group.map((task) =>
              buildSupplementalFullFileManifestTaskBlock(task),
            ),
          ].join('\n'),
        )
        .join('\n\n')
    : input.tasks
        .map((task, index) =>
          [
            `### \u6587\u4ef6\u4efb\u52a1 ${index + 1}`,
            buildSupplementalFullFileManifestTaskBlock(task),
          ].join('\n'),
        )
        .join('\n\n');
  const dispatchInstruction = useGrouped
    ? `1. \u6309\u7167\u4ee5\u4e0b\u5206\u7ec4\u521b\u5efa Agent \u5b50\u4ee3\u7406\uff0c\u6bcf\u4e2a\u5b50\u4ee3\u7406\u8d1f\u8d23\u4e00\u4e2a\u5206\u7ec4\u4e2d\u7684\u6240\u6709\u6587\u4ef6\u3002\u5171 ${input.taskGroups.length} \u4e2a\u5206\u7ec4\uff0c\u4f46\u4e0d\u8981\u4e3a\u4e86\u7528\u6ee1\u4e0a\u9650\u800c\u4e00\u6b21\u6027\u5206\u914d\u5168\u90e8\u5b50\u4ee3\u7406\uff1b\u5e94\u8be5\u6839\u636e\u5206\u7ec4\u7684\u91cd\u8981\u6027\u548c\u4f9d\u8d56\u5173\u7cfb\u5148\u540e\u6d3e\u53d1\u3002`
    : '1. \u4e3a\u4e0b\u9762\u6bcf\u4e2a\u6587\u4ef6\u4efb\u52a1\u521b\u5efa\u4e00\u4e2a Agent \u5b50\u4ee3\u7406\uff0c\u4f18\u5148\u5728\u540c\u4e00\u8f6e\u4e2d\u5e76\u884c\u521b\u5efa\u591a\u4e2a\u5b50\u4ee3\u7406\uff1b\u5982\u679c\u53d7\u6d3b\u8dc3\u5b50\u4ee3\u7406\u6570\u91cf\u9650\u5236\uff0c\u5219\u5206\u6279\u5b8c\u6210\uff0c\u4f46\u5fc5\u987b\u8986\u76d6\u5168\u90e8\u6587\u4ef6\u4efb\u52a1\u3002';
  const perAgentSchema = useGrouped
    ? '2. \u6bcf\u4e2a\u5b50\u4ee3\u7406\u8d1f\u8d23\u5176\u5206\u7ec4\u5185\u7684\u6240\u6709\u6587\u4ef6\uff0c\u8f93\u51fa\u4e14\u53ea\u8f93\u51fa\u4e00\u4e2a JSON \u5bf9\u8c61\uff0c\u5b57\u6bb5\u5fc5\u987b\u4e3a\uff1a{"files":[{"file":"\u6587\u4ef6\u8def\u5f84","summary":"\u4e2d\u6587\u6587\u4ef6\u7ea7\u5b8c\u6574\u5ba1\u67e5\u7ed3\u8bba","findings":[{"severity":"high|medium|low","title":"\u4e2d\u6587\u95ee\u9898\u6807\u9898","detail":"\u4e2d\u6587\u95ee\u9898\u8bf4\u660e","suggestion":"\u4e2d\u6587\u4fee\u590d\u5efa\u8bae"}],"suggestions":["\u4e2d\u6587\u5efa\u8bae"],"scope_limitations":["\u4e2d\u6587\u9650\u5236\u8bf4\u660e"],"overall_impact":"none|warn|fail","recommended_block":false}]}'
    : '2. \u6bcf\u4e2a\u5b50\u4ee3\u7406\u53ea\u8d1f\u8d23\u4e00\u4e2a\u6587\u4ef6\uff0c\u8f93\u51fa\u4e14\u53ea\u8f93\u51fa\u4e00\u4e2a JSON \u5bf9\u8c61\uff0c\u5b57\u6bb5\u5fc5\u987b\u4e3a\uff1a{"summary":"\u4e2d\u6587\u6587\u4ef6\u7ea7\u5b8c\u6574\u5ba1\u67e5\u7ed3\u8bba\uff0c\u53ef\u81ea\u7136\u5206\u6bb5","findings":[{"severity":"high|medium|low","title":"\u4e2d\u6587\u95ee\u9898\u6807\u9898","detail":"\u4e2d\u6587\u95ee\u9898\u8bf4\u660e","suggestion":"\u4e2d\u6587\u4fee\u590d\u5efa\u8bae"}],"suggestions":["\u4e2d\u6587\u5efa\u8bae"],"scope_limitations":["\u4e2d\u6587\u9650\u5236\u8bf4\u660e"],"overall_impact":"none|warn|fail","recommended_block":false}';
  const maxSub = input.maxSubagents ?? REPO_REVIEW_GROUP_DEFAULT_MAX_COUNT;
  const concurrencyHint = `\u5f53\u524d\u5b50\u4ee3\u7406\u5e76\u53d1\u4e0a\u9650\u4e3a ${maxSub}\uff0c\u5171 ${input.taskGroups.length || input.tasks.length} \u4e2a\u5e76\u884c\u4efb\u52a1\uff0c\u8bf7\u4e25\u683c\u63a7\u5236\u540c\u65f6\u6d3b\u8dc3\u7684\u5b50\u4ee3\u7406\u6570\u4e0d\u8d85\u8fc7 ${maxSub}\u3002`;
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return resolvePromptText({
    promptKey: 'repo_review.supplemental_orchestrator',
    targetUserId: input.targetUserId,
    variables: {
      concurrencyHint,
      dispatchInstruction,
      perAgentSchema,
      repositoryName: input.repository.name,
      primaryLanguageBlock: input.repository.language
        ? `主要语言：${input.repository.language}`
        : '',
      branch: input.prepared.branch || '(unknown)',
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange,
      primarySummary: input.primarySummary || '暂无主审查摘要。',
      customPromptBlock: formatRepoReviewCustomPromptBlock(customPrompt),
      taskBlocks,
    },
    fallbackText: REPO_REVIEW_SUPPLEMENTAL_ORCHESTRATOR_TEMPLATE,
  });
}

export async function buildSupplementalFullFileReviewOrchestratorPrompt(
  input: SupplementalFullFileReviewOrchestratorPromptInput,
): Promise<string> {
  const resolved =
    await resolveSupplementalFullFileReviewOrchestratorPrompt(input);
  return resolved.text;
}

function normalizeCloudDocErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldIncludeRepoReviewCloudDocLink(
  result: RepoReviewCloudDocResult | null,
): boolean {
  return (
    result?.resultStatus === 'success' ||
    result?.resultStatus === 'success_with_authorization_warnings'
  );
}

function isSuccessfulRepoReviewCloudDocStatus(status?: string): boolean {
  return (
    status === 'success' || status === 'success_with_authorization_warnings'
  );
}

function isCloudDocAuthorizationIncomplete(
  result: RepoReviewCloudDocResult | null,
): boolean {
  return (
    result?.resultStatus === 'success_with_authorization_warnings' ||
    result?.authorizationStatus === 'partial' ||
    result?.authorizationStatus === 'failed'
  );
}

function mapCloudDocResultToRunUpdate(
  result: RepoReviewCloudDocResult,
): ReviewRunUpdateInput {
  const authorizationWarnings = (result.authorizationWarnings || [])
    .map((entry) => stringValue(entry))
    .filter(Boolean);
  const lastError =
    stringValue(result.lastError) ||
    authorizationWarnings.join('; ') ||
    (result.resultStatus === 'success' ? null : result.resultStatus);
  return {
    cloud_doc_token: result.documentId || null,
    cloud_doc_url: result.url || null,
    cloud_doc_title: result.title || null,
    cloud_doc_status: result.resultStatus || null,
    cloud_doc_last_error: lastError,
  };
}

async function loadRepoReviewCloudDocHandlers(): Promise<RepoReviewCloudDocHandlers | null> {
  if (repoReviewCloudDocHandlersForTests) {
    return repoReviewCloudDocHandlersForTests;
  }
  const modulePath = './feishu-doc-service.js';
  try {
    const loaded = (await import(
      modulePath
    )) as Partial<RepoReviewCloudDocHandlers>;
    if (
      typeof loaded.prepareFeishuCloudDoc === 'function' &&
      typeof loaded.continueFeishuCloudDocProvision === 'function'
    ) {
      return loaded as RepoReviewCloudDocHandlers;
    }
    return null;
  } catch (error) {
    const message = normalizeCloudDocErrorMessage(error);
    if (
      /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve module specifier/i.test(
        message,
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function resolveRepoReviewFeishuConversationType(
  chatJid: string,
): Promise<RepoReviewFeishuConversationType | null> {
  const summary = await getConversationSummaryByJid(chatJid);
  if (summary && summary.channel?.startsWith('feishu')) {
    return summary.is_group === 1 ? 'group' : 'dm';
  }
  const lastColon = chatJid.lastIndexOf(':');
  if (lastColon > 0) {
    const feishuChatId = chatJid.slice(lastColon + 1);
    if (feishuChatId.startsWith('oc_')) return 'group';
    if (feishuChatId.startsWith('ou_') || feishuChatId.startsWith('p2p'))
      return 'dm';
  }
  return null;
}

async function maybeProvisionRepoReviewCloudDoc(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  diffText?: string;
}): Promise<{
  run: RepoReviewRun;
  result: RepoReviewCloudDocResult | null;
}> {
  const chatJid =
    input.repository.reviewChatJid || `repo-review:${input.repository.id}`;
  if (!chatJid.startsWith('feishu:')) {
    return { run: input.run, result: null };
  }
  const handlers = await loadRepoReviewCloudDocHandlers();
  if (!handlers) {
    return { run: input.run, result: null };
  }
  const conversationType =
    await resolveRepoReviewFeishuConversationType(chatJid);
  if (!conversationType) {
    logger.warn(
      { chatJid, repositoryId: input.repository.id, runId: input.run.id },
      'Skipping repo-review cloud-doc creation because the Feishu conversation type is unknown',
    );
    return { run: input.run, result: null };
  }

  const findingEvidence = await buildRepoReviewFindingEvidence({
    repository: input.repository,
    run: input.run,
    diffText: input.diffText,
  });
  const rendered = buildRepoReviewCloudDoc({
    repository: input.repository,
    run: input.run,
    findingEvidence,
  });

  let currentRun = input.run;
  if (
    currentRun.cloudDocUrl &&
    isSuccessfulRepoReviewCloudDocStatus(currentRun.cloudDocStatus)
  ) {
    return { run: currentRun, result: null };
  }
  let documentId = currentRun.cloudDocToken;
  let title = currentRun.cloudDocTitle || rendered.title;

  try {
    if (!documentId) {
      const prepared = await handlers.prepareFeishuCloudDoc({
        chatJid,
        title,
        conversationType,
        idempotencyKey: currentRun.id,
      });
      documentId = stringValue(prepared.documentId);
      title = stringValue(prepared.title) || title;
      const preparedRecord = await updateReviewRun(currentRun.id, {
        cloud_doc_token: documentId || null,
        cloud_doc_title: title || null,
        cloud_doc_status: 'created',
        cloud_doc_last_error: null,
      });
      currentRun = await normalizeRunRecord(preparedRecord);
    }

    if (!documentId) {
      throw new Error(
        'Feishu cloud doc prepare step did not return a documentId',
      );
    }

    const result = await handlers.continueFeishuCloudDocProvision({
      chatJid,
      documentId,
      title,
      conversationType,
      sections: rendered.sections,
      idempotencyKey: currentRun.id,
    });
    const updatedRecord = await updateReviewRun(
      currentRun.id,
      mapCloudDocResultToRunUpdate(result),
    );
    return {
      run: await normalizeRunRecord(updatedRecord),
      result,
    };
  } catch (error) {
    const updatedRecord = await updateReviewRun(currentRun.id, {
      cloud_doc_token: documentId || null,
      cloud_doc_title: title || null,
      cloud_doc_status: currentRun.cloudDocToken
        ? 'continuation_failed'
        : 'creation_failed',
      cloud_doc_last_error: normalizeCloudDocErrorMessage(error),
    });
    logger.warn(
      {
        err: error,
        chatJid,
        repositoryId: input.repository.id,
        runId: input.run.id,
      },
      'Failed to provision repo-review Feishu cloud doc',
    );
    return {
      run: await normalizeRunRecord(updatedRecord),
      result: null,
    };
  }
}

async function publishRepoReviewCompletionMessage(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
  decisionMode: 'ai' | 'human';
  diffText?: string;
  reviewOutputMode?: 'message' | 'share_link';
}): Promise<RepoReviewRun> {
  let run = input.run;
  const outputMode = input.reviewOutputMode || 'share_link';
  const mentions = resolveRepoReviewMentions(input.repository, run.actor);
  const hasStructuredMentions = (mentions ?? []).length > 0;

  if (outputMode === 'share_link') {
    const hasReviewContent =
      resolveRepoReviewVisibleBody(run) ||
      stringValue(run.summary) ||
      (run.findings ?? []).length > 0;
    if (hasReviewContent) {
      const shareUrl = await createRepoReviewShareLink({
        repository: input.repository,
        run,
      });
      const content = formatRepoReviewShareLinkMessage(
        input.repository,
        run,
        shareUrl,
        { skipActorMention: hasStructuredMentions },
      );
      return await applyRunChatDeliveryResult(
        run,
        await publishReviewMessage({
          repository: input.repository,
          runId: run.id,
          content,
          mentions,
        }),
      );
    }
  }

  const content = formatRepoReviewMarkdownMessage(input.repository, run, {
    skipActorMention: hasStructuredMentions,
  });
  return await applyRunChatDeliveryResult(
    run,
    await publishReviewMessage({
      repository: input.repository,
      runId: run.id,
      content,
      mentions,
    }),
  );
}

async function resolveRepoOwnerUserId(repositoryId: string): Promise<string> {
  const { listReviewRepositoryMembers } = await import('../db/review.js');
  // Members are ordered by granted_at ASC; first member is treated as the repo owner.
  const members = await listReviewRepositoryMembers(repositoryId);
  if (members.length > 0) return members[0]!.user_id;
  return SYSTEM_USER_ID;
}

async function createRepoReviewShareLink(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
}): Promise<string> {
  const { createShare } = await import('../db/shares.js');
  const { run, repository } = input;
  const shareId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const title = `代码审查报告 · ${repository.name} · ${run.branch || 'unknown'}`;
  const high = run.findings.filter((f) => f.severity === 'high').length;
  const medium = run.findings.filter((f) => f.severity === 'medium').length;
  const low = run.findings.filter((f) => f.severity === 'low').length;
  const summaryHeader = [
    `AI 审查完成 · ${repository.name}`,
    `结论: ${overallLabel(run.overall || run.status)} | 风险: 高 ${high} / 中 ${medium} / 低 ${low}`,
    branchConclusionLine(run.summary),
  ]
    .filter(Boolean)
    .join('\n');
  const body = resolveRepoReviewVisibleBody(run);
  const fullContent = body ? `${summaryHeader}\n\n${body}` : summaryHeader;
  const entries = [
    {
      key: `review_${run.id}`,
      kind: 'assistant_message',
      text: fullContent,
    },
  ];
  const chatJid = repository.reviewChatJid || `repo-review:${repository.id}`;
  const ownerId = await resolveRepoOwnerUserId(repository.id);
  await createShare(
    shareId,
    chatJid,
    title,
    JSON.stringify(entries),
    null,
    ownerId,
    ownerId,
  );
  const base = await getShareBaseUrl();
  return `${base}/share/${shareId}`;
}

function isSyntheticReviewChat(chatJid: string): boolean {
  return !chatJid || chatJid.startsWith('repo-review:');
}

function isLocalManagedReviewChat(chatJid: string): boolean {
  return isSyntheticReviewChat(chatJid) || chatJid.startsWith('web:');
}

function shouldPublishRepoReviewStartedMessage(
  repository: RepoReviewRepository,
): boolean {
  const chatJid = repository.reviewChatJid || `repo-review:${repository.id}`;
  return !isLocalManagedReviewChat(chatJid);
}

async function storeReviewMessageLocally(input: {
  repository: RepoReviewRepository;
  chatJid: string;
  content: string;
  runId: string;
  synthetic: boolean;
}): Promise<void> {
  const timestamp = new Date().toISOString();
  const messageId = `repo_review_msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  if (input.synthetic) {
    await storeChatMetadata(
      input.chatJid,
      timestamp,
      `Repo Review · ${input.repository.name}`,
      'repo-review',
      false,
    );
    await updateConversationMeta(input.chatJid, {
      customTitle: `Repo Review · ${input.repository.name}`,
    });
  } else {
    await storeChatMetadata(input.chatJid, timestamp);
  }
  await storeMessageDirect({
    id: messageId,
    chat_jid: input.chatJid,
    sender: 'nanoclaw-review',
    sender_name: await getAssistantName(),
    content: input.content,
    timestamp,
    is_from_me: true,
    is_bot_message: true,
    run_id: input.runId,
  });
  getWebChannel()?.notifyMessage(input.chatJid, {
    id: messageId,
    content: input.content,
    sender: 'nanoclaw-review',
    sender_name: await getAssistantName(),
    timestamp,
    is_bot: true,
    run_id: input.runId,
    is_from_me: true,
  });
}

async function publishReviewMessage(input: {
  repository: RepoReviewRepository;
  runId: string;
  content: string;
  mentions?: StructuredOutboundMessage['mentions'];
}): Promise<{
  status: ReviewDeliveryStatus;
  error?: string;
}> {
  const chatJid =
    input.repository.reviewChatJid || `repo-review:${input.repository.id}`;
  const localManaged = isLocalManagedReviewChat(chatJid);
  if (!localManaged && repoReviewMessageSender) {
    try {
      await repoReviewMessageSender(chatJid, {
        text: input.content,
        mentions: input.mentions,
      });
      return { status: 'delivered' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn(
        { err, chatJid, repositoryId: input.repository.id },
        'Failed to deliver repo review message via channel, falling back to local persistence',
      );
      storeReviewMessageLocally({
        repository: input.repository,
        chatJid,
        content: input.content,
        runId: input.runId,
        synthetic: false,
      });
      return { status: 'failed', error };
    }
  }
  if (!localManaged) {
    const error = 'Repo review message sender is not configured';
    storeReviewMessageLocally({
      repository: input.repository,
      chatJid,
      content: input.content,
      runId: input.runId,
      synthetic: false,
    });
    return { status: 'not_configured', error };
  }
  storeReviewMessageLocally({
    repository: input.repository,
    chatJid,
    content: input.content,
    runId: input.runId,
    synthetic: isSyntheticReviewChat(chatJid),
  });
  return { status: 'delivered' };
}

function resolveRepoReviewMentions(
  repository: RepoReviewRepository,
  actor: string,
): StructuredOutboundMessage['mentions'] {
  if (!repository.reviewChatJid.startsWith('feishu:')) return [];
  const keys = buildActorMentionLookupKeys(actor);
  if (keys.length === 0) return [];
  const mapping = repository.actorMentionMappings.find((entry) =>
    keys.includes(normalizeActorMentionKey(entry.actor)),
  );
  if (!mapping) return [];
  return [
    {
      channel: 'feishu',
      id: mapping.id,
      name: mapping.name || actor.trim(),
    },
  ];
}

function mapOverallToStatus(
  provider: ReviewRemoteProvider,
  overall: ReviewOverall,
  decisionMode: 'ai' | 'human' = 'ai',
): string {
  if (decisionMode === 'human') {
    return 'pending';
  }
  if (provider === 'gitlab') {
    if (overall === 'fail' || overall === 'error') return 'failed';
    return 'success';
  }
  if (overall === 'fail' || overall === 'error') return 'failure';
  return 'success';
}

function mapManualDecisionToStatus(
  provider: ReviewRemoteProvider,
  decision: 'pass' | 'fail',
): string {
  if (provider === 'gitlab') {
    return decision === 'pass' ? 'success' : 'failed';
  }
  return decision === 'pass' ? 'success' : 'failure';
}

function shortDescription(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

function getScmConfig(
  repository: ReviewRepositoryRecord,
): NormalizedScmConfig | null {
  if (
    !repository.remote_provider ||
    !repository.remote_repo_slug ||
    !repository.platform_token
  ) {
    return null;
  }
  const slug = repository.remote_repo_slug.trim();
  const provider = repository.remote_provider;
  const configuredBase = (repository.remote_base_url || '')
    .trim()
    .replace(/\/+$/, '');
  if (provider === 'github') {
    return {
      provider,
      slug,
      token: repository.platform_token,
      apiBase: configuredBase || 'https://api.github.com',
    };
  }
  if (provider === 'gitlab') {
    const apiBase = configuredBase
      ? configuredBase.endsWith('/api/v4')
        ? configuredBase
        : `${configuredBase}/api/v4`
      : 'https://gitlab.com/api/v4';
    return { provider, slug, token: repository.platform_token, apiBase };
  }
  const apiBase = configuredBase
    ? configuredBase.endsWith('/api/v1')
      ? configuredBase
      : `${configuredBase}/api/v1`
    : 'https://gitea.com/api/v1';
  return { provider, slug, token: repository.platform_token, apiBase };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function fetchJsonArray(
  url: string,
  init: RequestInit,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Array<Record<string, unknown>>;
}

async function postJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function postAndRequireOk(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
}

function encodePathSegments(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function trimContextBlock(value: string, maxChars = 3500): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...(truncated)`;
}

const FULL_FILE_CONTEXT_MAX_CHARS_PER_FILE = 12000;

function estimateChangedFileBytesForReview(input: {
  repository: ReviewRepositoryRecord;
  event: RepoReviewEvent;
  filePath: string;
  estimatedDiffBytes: number;
}): number {
  const normalizedPath = input.filePath.replace(/\\/g, '/');
  if (
    input.event.source === 'local-hook' ||
    hasLocalGitRemoteAccess(input.repository)
  ) {
    const repoPath = resolveRepositoryLocalRepoPath(input.repository);
    if (repoPath) {
      const absolutePath = path.join(repoPath, ...normalizedPath.split('/'));
      try {
        if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
          return Math.max(0, fs.statSync(absolutePath).size);
        }
      } catch {
        // Fall through to heuristic estimate.
      }
    }
  }
  return Math.max(4096, input.estimatedDiffBytes * 4);
}

function buildRepoReviewFullFileTaskManifest(input: {
  repository: ReviewRepositoryRecord;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  stepIndex: number;
  filePath: string;
  primaryFindings: RepoReviewRunFinding[];
}): RepoReviewFullFileTaskManifest {
  const filePath = stringValue(input.filePath);
  const diffEntry = input.prepared.diffIndex?.entriesByFile.get(filePath);
  const estimatedDiffBytes =
    diffEntry?.estimatedBytes ??
    getRepoReviewUtf8Bytes(
      buildFilteredDiff(input.prepared.diffText, new Set([filePath])),
    );
  const relatedFindings = input.primaryFindings.filter(
    (finding) => stringValue(finding.file) === filePath,
  );
  const estimatedFileBytes = estimateChangedFileBytesForReview({
    repository: input.repository,
    event: input.event,
    filePath,
    estimatedDiffBytes,
  });
  return {
    stepIndex: input.stepIndex,
    filePath,
    diffFiles: [filePath],
    estimatedDiffBytes,
    estimatedFileBytes,
    estimatedBytes: estimateRepoReviewPayloadBytes({
      diffBytes: estimatedDiffBytes,
      fileContentBytes: estimatedFileBytes,
      relatedFindingBytes: getRepoReviewJsonBytes(relatedFindings),
    }),
    relatedFindings,
    ...getRepoReviewProjectGraphFileCommunity({
      prepared: input.prepared,
      filePath,
    }),
  };
}

async function hydrateRepoReviewFullFileTaskManifest(input: {
  repository: ReviewRepositoryRecord;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  manifest: RepoReviewFullFileTaskManifest;
  executionStats?: RepoReviewExecutionStats;
}): Promise<
  RepoReviewHydratedFullFileTask | RepoReviewSupplementalExecutionResult
> {
  const fileContent = await fetchChangedFileContentForReview({
    repository: input.repository,
    event: input.event,
    prepared: input.prepared,
    filePath: input.manifest.filePath,
  });
  if (!fileContent || fileContent.includes('\0')) {
    return buildSupplementalUnreadableFileResult(input.manifest.filePath);
  }
  input.executionStats &&
    (input.executionStats.fullFileBytesLoaded +=
      getRepoReviewUtf8Bytes(fileContent));
  const trimmedFileContent = trimContextBlock(
    fileContent,
    FULL_FILE_CONTEXT_MAX_CHARS_PER_FILE,
  );
  const scopeLimitations: string[] = [];
  if (trimmedFileContent.length < fileContent.length) {
    scopeLimitations.push(
      t(
        'repoReview.fullFileContentTooLarge',
        {
          file: input.manifest.filePath,
          maxChars: FULL_FILE_CONTEXT_MAX_CHARS_PER_FILE,
        },
        undefined,
      ),
    );
  }
  const fileDiff = buildFilteredDiff(
    input.prepared.diffText,
    new Set(input.manifest.diffFiles),
    input.prepared.diffIndex,
  );
  return {
    stepIndex: input.manifest.stepIndex,
    filePath: input.manifest.filePath,
    fileDiff,
    fileContent: trimmedFileContent,
    relatedFindings: input.manifest.relatedFindings,
    communityId: input.manifest.communityId,
    communityLabel: input.manifest.communityLabel,
    estimatedBytes: estimateRepoReviewPayloadBytes({
      diffBytes: getRepoReviewUtf8Bytes(fileDiff),
      fileContentBytes: getRepoReviewUtf8Bytes(trimmedFileContent),
      relatedFindingBytes: getRepoReviewJsonBytes(
        input.manifest.relatedFindings,
      ),
    }),
    scopeLimitations,
  };
}
const FULL_FILE_CONTEXT_MAX_TOTAL_BYTES = 180000;

async function fetchRemoteFileContentAtRef(
  repository: ReviewRepositoryRecord,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const scm = getScmConfig(repository);
  if (!scm || !filePath || !ref) return null;
  if (scm.provider === 'github' || scm.provider === 'gitea') {
    const headers: Record<string, string> =
      scm.provider === 'github'
        ? {
            Authorization: `Bearer ${scm.token}`,
            Accept: 'application/vnd.github+json',
          }
        : {
            Authorization: `token ${scm.token}`,
            Accept: 'application/json',
          };
    const payload = (await fetchJson(
      `${scm.apiBase}/repos/${scm.slug}/contents/${encodePathSegments(
        filePath,
      )}?ref=${encodeURIComponent(ref)}`,
      { headers },
    ).catch((err) => {
      if (err instanceof Error && /HTTP 404/i.test(err.message)) {
        return null;
      }
      throw err;
    })) as Record<string, unknown> | null;
    if (!payload) return null;
    const encoded = stringValue(payload.content).replace(/\n/g, '');
    if (!encoded) return null;
    return Buffer.from(encoded, 'base64').toString('utf8');
  }
  const project = encodeURIComponent(scm.slug);
  return fetchTextIfOk(
    `${scm.apiBase}/projects/${project}/repository/files/${encodeURIComponent(
      filePath,
    )}/raw?ref=${encodeURIComponent(ref)}`,
    {
      headers: { 'PRIVATE-TOKEN': scm.token },
    },
  );
}

async function fetchChangedFileContentForReview(input: {
  repository: ReviewRepositoryRecord;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  filePath: string;
}): Promise<string | null> {
  const normalizedPath = stringValue(input.filePath);
  if (!normalizedPath) return null;
  if (input.event.source === 'local-hook') {
    const repoPath = resolveRepositoryLocalRepoPath(input.repository);
    if (!repoPath) return null;
    try {
      const stagedContent = await runGitCommandAsync(
        repoPath,
        ['show', `:${normalizedPath.replace(/\\/g, '/')}`],
        true,
      );
      if (stagedContent.trim()) {
        return stagedContent;
      }
      const headRef = stringValue(input.prepared.headSha);
      if (headRef) {
        const headContent = await runGitCommandAsync(
          repoPath,
          ['show', `${headRef}:${normalizedPath.replace(/\\/g, '/')}`],
          true,
        );
        if (headContent.trim()) {
          return headContent;
        }
      }
      const absolutePath = path.join(repoPath, ...normalizedPath.split('/'));
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
        return fs.readFileSync(absolutePath, 'utf8');
      }
      return null;
    } catch {
      return null;
    }
  }

  const ref =
    stringValue(input.prepared.headSha) || stringValue(input.prepared.branch);
  if (!ref) return null;
  if (hasLocalGitRemoteAccess(input.repository)) {
    const repoPath = resolveRepositoryLocalRepoPath(input.repository);
    if (!repoPath) return null;
    const showRef = `${ref}:${normalizedPath}`;
    try {
      return await runGitCommandAsync(repoPath, ['show', showRef], true);
    } catch {
      try {
        await runGitCommandAsync(
          repoPath,
          ['fetch', 'origin', ref],
          false,
          REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
        );
        return await runGitCommandAsync(repoPath, ['show', showRef], true);
      } catch {
        return null;
      }
    }
  }

  try {
    return await fetchRemoteFileContentAtRef(
      input.repository,
      normalizedPath,
      ref,
    );
  } catch (err) {
    logger.warn(
      { err, repositoryId: input.repository.id, filePath: normalizedPath, ref },
      'Failed to load changed file content for repo review',
    );
    return null;
  }
}

async function runSupplementalFullFileReview(input: {
  repositoryRecord: ReviewRepositoryRecord;
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  primary?: {
    findings: RepoReviewRunFinding[];
    fileReviews: RepoReviewFileReview[];
    scopeLimitations: string[];
    suggestions: string[];
    overall: ReviewOverall;
    summary: string;
    recommendedBlock: boolean;
  };
  runId: string;
  workspacePath?: string | null;
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  maxSubagents?: number;
  userId?: string;
  executionStats?: RepoReviewExecutionStats;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}): Promise<{
  overall: ReviewOverall;
  summary: string;
  findings: RepoReviewRunFinding[];
  fileReviews: RepoReviewFileReview[];
  scopeLimitations: string[];
  suggestions: string[];
  recommendedBlock: boolean;
  supplementalResults: RepoReviewSupplementalExecutionResult[];
}> {
  const primaryFindings = input.primary?.findings ?? [];
  const primaryFileReviews = input.primary?.fileReviews ?? [];
  const primarySummary = input.primary?.summary ?? '';
  const maxSubagents = Math.max(
    1,
    input.maxSubagents ?? REPO_REVIEW_GROUP_DEFAULT_MAX_COUNT,
  );

  if (
    !input.profile.includeFullFileContext ||
    input.prepared.changedFiles.length === 0
  ) {
    const baseFindings = primaryFindings;
    const baseFR = buildFallbackRepoReviewFileReviews({
      changedFiles: input.prepared.changedFiles,
      findings: baseFindings,
      fileReviews: primaryFileReviews,
      includeFullFileContext: input.profile.includeFullFileContext,
    });
    return {
      overall: input.primary?.overall ?? 'pass',
      summary: primarySummary,
      findings: baseFindings,
      fileReviews: baseFR,
      scopeLimitations: input.primary?.scopeLimitations ?? [],
      suggestions: input.primary?.suggestions ?? [],
      recommendedBlock: input.primary?.recommendedBlock ?? false,
      supplementalResults: [],
    };
  }

  const preparedManifests: RepoReviewFullFileTaskManifest[] = [];
  for (const [index, rawFilePath] of input.prepared.changedFiles.entries()) {
    const filePath = stringValue(rawFilePath);
    if (!filePath) continue;
    preparedManifests.push(
      buildRepoReviewFullFileTaskManifest({
        repository: input.repositoryRecord,
        event: input.event,
        prepared: input.prepared,
        stepIndex: index + 1,
        filePath,
        primaryFindings,
      }),
    );
  }

  const taskGroups = splitTasksByByteBudget(
    preparedManifests,
    REPO_REVIEW_FULL_FILE_BATCH_MAX_BYTES,
  );
  recordRepoReviewFullFileBatchStats(input.executionStats, taskGroups);

  const supplementalResults = await runSupplementalFullFileReviewBatchWorkers({
    repository: input.repository,
    repositoryRecord: input.repositoryRecord,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    primarySummary,
    runId: input.runId,
    workspacePath: input.workspacePath,
    userId: input.userId,
    manifests: preparedManifests,
    onTurnProgress: input.onTurnProgress,
    maxSubagents,
    executionStats: input.executionStats,
    onProgressStep: input.onProgressStep,
  });
  if (input.executionStats) {
    input.executionStats.plannedSubagentCount = preparedManifests.length;
    input.executionStats.delegatedSubagentCount = supplementalResults.filter(
      (result) => !result.failed,
    ).length;
  }

  const supplementalFileReviews = supplementalResults
    .map((result) => result.fileReview)
    .filter((entry): entry is RepoReviewFileReview => entry !== null);
  const supplementalFindings = supplementalResults.flatMap(
    (result) => result.findings,
  );
  const resultScopeLimitations = supplementalResults.flatMap(
    (result) => result.scopeLimitations,
  );
  const supplementalSuggestions = supplementalResults.flatMap(
    (result) => result.suggestions,
  );
  const supplementalRecommendedBlock = supplementalResults.some(
    (result) => result.recommendedBlock,
  );
  const supplementalOverallImpact = supplementalResults.reduce<
    RepoReviewSupplementalFileReviewResult['overallImpact']
  >((current, result) => {
    if (current === 'fail' || result.overallImpact === 'fail') return 'fail';
    if (current === 'warn' || result.overallImpact === 'warn') return 'warn';
    return 'none';
  }, 'none');
  const supplementalReviewFailed = supplementalResults.some(
    (result) => result.failed,
  );

  const mergedFindings = dedupeRepoReviewFindings([
    ...primaryFindings,
    ...supplementalFindings,
  ]);
  const mergedFileReviews = buildFallbackRepoReviewFileReviews({
    changedFiles: input.prepared.changedFiles,
    findings: mergedFindings,
    fileReviews: [...primaryFileReviews, ...supplementalFileReviews],
    includeFullFileContext: true,
  });
  const baseOverall = input.primary?.overall ?? 'pass';
  return {
    overall: mergeRepoReviewOverallWithSupplementalFindings(
      baseOverall,
      supplementalFindings,
      supplementalOverallImpact,
    ),
    summary: mergeRepoReviewSummaryWithSupplementalFindings({
      summary: primarySummary,
      supplementalFindings,
      supplementalReviewCompleted: supplementalFileReviews.length > 0,
      supplementalReviewFailed,
    }),
    findings: mergedFindings,
    fileReviews: mergedFileReviews,
    scopeLimitations: normalizeReviewScopeLimitations([
      ...(input.primary?.scopeLimitations ?? []),
      ...resultScopeLimitations,
    ]),
    suggestions: normalizeStringArray([
      ...(input.primary?.suggestions ?? []),
      ...supplementalSuggestions,
    ]),
    recommendedBlock:
      (input.primary?.recommendedBlock ?? false) ||
      supplementalRecommendedBlock ||
      buildSupplementalRecommendedBlock(
        supplementalFindings,
        supplementalRecommendedBlock,
      ),
    supplementalResults,
  };
}

async function runSupplementalFullFileReviewWithOrchestrator(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prepared: ReviewPreparedContext;
  primarySummary: string;
  runId: string;
  workspacePath?: string | null;
  tasks: RepoReviewFullFileTaskManifest[];
  taskGroups: RepoReviewFullFileTaskManifest[][];
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  maxSubagents?: number;
  userId?: string;
  executionStats?: RepoReviewExecutionStats;
}): Promise<{
  resultsByFile: Map<string, RepoReviewSupplementalExecutionResult>;
  scopeLimitations: string[];
}> {
  const expectedFilePaths = new Set(input.tasks.map((task) => task.filePath));
  const prompt = await buildSupplementalFullFileReviewOrchestratorPrompt({
    repository: input.repository,
    profile: input.profile,
    prepared: input.prepared,
    primarySummary: input.primarySummary,
    tasks: input.tasks,
    taskGroups: input.taskGroups,
    maxSubagents: input.maxSubagents,
    targetUserId: input.userId,
  });
  recordRepoReviewPromptBytes(input.executionStats, prompt);
  await recordPromptTrace({
    traceKind: 'direct_provider',
    promptKey: 'repo_review.supplemental_orchestrator',
    featureScope: 'repo_review',
    targetUserId: input.userId ?? '',
    userPromptText: prompt,
    providerInputText: prompt,
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      taskCount: input.tasks.length,
      taskGroupCount: input.taskGroups.length,
    },
  });
  let reviewTurns: RepoReviewAssistantTurn[] = [];
  let output = '';
  try {
    output = (
      await runReviewAgent({
        repository: input.repository,
        profile: input.profile,
        prompt,
        runId: input.runId,
        runtimeNamespace: `${input.runId}:full-file-orchestrator`,
        workspacePath: input.workspacePath,
        userId: input.userId,
        onTurnProgress: async (turns) => {
          reviewTurns = turns;
          await input.onTurnProgress?.(turns);
        },
      })
    ).outputText;
  } catch (err) {
    return {
      resultsByFile: new Map<string, RepoReviewSupplementalExecutionResult>(),
      scopeLimitations: [
        `\u5168\u6587\u8865\u5145\u5ba1\u67e5 orchestrator \u6267\u884c\u5931\u8d25\uff0c\u5df2\u56de\u9000\u5230\u6279\u91cf\u8865\u5145\u5ba1\u67e5\uff1a${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  if (!hasRepoReviewSubagentUsage(reviewTurns)) {
    logger.warn(
      { repositoryId: input.repository.id, runId: input.runId },
      'Supplemental repo review orchestrator did not use subagents, falling back to direct per-file reviews',
    );
    return {
      resultsByFile: new Map<string, RepoReviewSupplementalExecutionResult>(),
      scopeLimitations: [t('repoReview.auto_e3e3fa', {}, undefined)],
    };
  }

  const parsed = parseSupplementalBatchFileReviewResults(
    output,
    expectedFilePaths,
  );
  return parsed.resultsByFile.size > 0
    ? parsed
    : {
        resultsByFile: new Map<string, RepoReviewSupplementalExecutionResult>(),
        scopeLimitations: [
          ...parsed.scopeLimitations,
          t('repoReview.auto_b3cb3c', {}, undefined),
        ],
      };
}

async function runSupplementalFullFileReviewBatchWorkers(input: {
  repository: RepoReviewRepository;
  repositoryRecord: ReviewRepositoryRecord;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  primarySummary: string;
  runId: string;
  workspacePath?: string | null;
  manifests: RepoReviewFullFileTaskManifest[];
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  userId?: string;
  maxSubagents: number;
  executionStats?: RepoReviewExecutionStats;
  onProgressStep?: (step: {
    id: string;
    label: string;
    status: RepoReviewProgressStep['status'];
    detail?: string;
    kind?: RepoReviewProgressStepKind;
    inputText?: string;
    outputText?: string;
    metadataText?: string;
    error?: string;
  }) => Promise<void>;
}): Promise<RepoReviewSupplementalExecutionResult[]> {
  const allWorkerTurns: RepoReviewAssistantTurn[][] = [];
  const emitProgress = async () => {
    if (!input.onTurnProgress) return;
    await input.onTurnProgress(allWorkerTurns.flat());
  };
  for (const manifest of input.manifests) {
    await input.onProgressStep?.({
      id: `full_file_subagent_${manifest.stepIndex}`,
      label: `全文补充子代理 ${manifest.stepIndex}/${input.manifests.length}`,
      status: 'queued',
      detail: manifest.filePath,
    });
  }
  const maxWorkerCount = Math.max(
    1,
    Math.min(
      input.maxSubagents,
      REPO_REVIEW_FULL_FILE_REVIEW_CONCURRENCY,
      input.manifests.length || 1,
    ),
  );
  const results = await mapWithConcurrencyLimit(
    input.manifests,
    maxWorkerCount,
    async (manifest, manifestIndex) => {
      const stepId = `full_file_subagent_${manifest.stepIndex}`;
      const label = `全文补充子代理 ${manifest.stepIndex}/${input.manifests.length}`;
      const turnIndex = manifestIndex;
      const toolTurnId = `${input.runId}:full-file-subagent-tool:${manifest.stepIndex}:${slugifyId(manifest.filePath)}`;
      const toolCallId = `${toolTurnId}:agent`;
      const runtimeNamespace = `${input.runId}:full-file-subagent:${manifest.stepIndex}:${slugifyId(manifest.filePath)}`;
      let syntheticToolTurn: RepoReviewAssistantTurn | null = null;
      let childTurns: RepoReviewAssistantTurn[] = [];
      const setWorkerTurns = async () => {
        allWorkerTurns[turnIndex] = [
          ...(syntheticToolTurn ? [syntheticToolTurn] : []),
          ...childTurns,
        ];
        await emitProgress();
      };
      allWorkerTurns[turnIndex] = [];
      await input.onProgressStep?.({
        id: stepId,
        label,
        status: 'running',
        detail: manifest.filePath,
      });
      const hydrated = await hydrateRepoReviewFullFileTaskManifest({
        repository: input.repositoryRecord,
        event: input.event,
        prepared: input.prepared,
        manifest,
        executionStats: input.executionStats,
      });
      if ('fileReview' in hydrated) {
        await input.onProgressStep?.({
          id: stepId,
          label,
          status: 'failed',
          detail: manifest.filePath,
          error: hydrated.scopeLimitations.join('；'),
        });
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label,
          task: manifest.filePath,
          resultText: JSON.stringify(hydrated, null, 2),
          errorText: hydrated.scopeLimitations.join('；'),
          status: 'failed',
        });
        await setWorkerTurns();
        return hydrated;
      }
      if (input.executionStats) {
        input.executionStats.peakReservedBytes = Math.max(
          input.executionStats.peakReservedBytes,
          hydrated.estimatedBytes,
        );
      }
      const prompt = await buildSupplementalFileReviewPrompt({
        repository: input.repository,
        profile: input.profile,
        prepared: input.prepared,
        filePath: hydrated.filePath,
        fileDiff: hydrated.fileDiff,
        fileContent: hydrated.fileContent,
        relatedFindings: hydrated.relatedFindings,
        primarySummary: input.primarySummary,
        targetUserId: input.userId,
      });
      recordRepoReviewPromptBytes(input.executionStats, prompt);
      if (input.executionStats) {
        input.executionStats.modelCallCount =
          (input.executionStats.modelCallCount || 0) + 1;
      }
      await recordPromptTrace({
        traceKind: 'direct_provider',
        promptKey: 'repo_review.supplemental_file',
        featureScope: 'repo_review',
        targetUserId: input.userId ?? '',
        userPromptText: prompt,
        providerInputText: prompt,
        metadata: {
          runId: input.runId,
          repositoryId: input.repository.id,
          filePath: hydrated.filePath,
          evidenceBytes: hydrated.estimatedBytes,
        },
      });
      syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
        turnId: toolTurnId,
        toolCallId,
        runtimeId: runtimeNamespace,
        parentRuntimeId: input.runId,
        groupKey: stepId,
        label,
        task: hydrated.filePath,
        argumentsText: buildRepoReviewSubagentPromptPreview({
          label,
          task: hydrated.filePath,
          files: [hydrated.filePath],
        }),
        status: 'in_progress',
      });
      await setWorkerTurns();
      try {
        const output = (
          await runReviewAgent({
            repository: input.repository,
            profile: input.profile,
            prompt,
            runId: input.runId,
            runtimeNamespace,
            workspacePath: input.workspacePath,
            userId: input.userId,
            attachWorkspace: false,
            toolPolicy: 'none',
            turnContext: {
              groupKey: stepId,
              groupLabel: label,
              phase: 'worker',
              parentToolCallId: toolCallId,
              ownerKind: 'subagent',
              ownerLabel: label,
            },
            onTurnProgress: async (turns) => {
              childTurns = turns;
              await setWorkerTurns();
            },
            onStatusEvent: buildRepoReviewAgentStatusProgressHandler({
              id: stepId,
              label,
              onProgressStep: input.onProgressStep,
            }),
          })
        ).outputText;
        const parsed = parseSupplementalFileReviewResult(
          output,
          hydrated.filePath,
        );
        const outOfScopeReadCount = countRepoReviewOutOfScopeReads(childTurns, [
          hydrated.filePath,
        ]);
        const supplementalScopeLimitations = [
          ...hydrated.scopeLimitations,
          ...(outOfScopeReadCount > 0
            ? [
                `全文补充子代理 ${hydrated.filePath} 发生 ${outOfScopeReadCount} 次越权读取，仅作为低置信度参考。`,
              ]
            : []),
        ];
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label,
          task: hydrated.filePath,
          argumentsText: buildRepoReviewSubagentPromptPreview({
            label,
            task: hydrated.filePath,
            files: [hydrated.filePath],
          }),
          resultText: output,
          status: 'completed',
        });
        await setWorkerTurns();
        await input.onProgressStep?.({
          id: stepId,
          label,
          status: 'completed',
          detail: `${hydrated.filePath}，发现 ${parsed.findings.length} 个问题`,
          metadataText: formatProgressKeyValues([
            ['out_of_scope_reads', outOfScopeReadCount],
            ['timed_out', false],
          ]),
        });
        return buildSupplementalExecutionResult(
          hydrated.filePath,
          parsed,
          false,
          supplementalScopeLimitations,
        );
      } catch (err) {
        const error = errorMessageForProgress(err);
        syntheticToolTurn = buildRepoReviewSyntheticSubagentToolTurn({
          turnId: toolTurnId,
          toolCallId,
          runtimeId: runtimeNamespace,
          parentRuntimeId: input.runId,
          groupKey: stepId,
          label,
          task: hydrated.filePath,
          argumentsText: buildRepoReviewSubagentPromptPreview({
            label,
            task: hydrated.filePath,
            files: [hydrated.filePath],
          }),
          errorText: error,
          status: 'failed',
        });
        await setWorkerTurns();
        await input.onProgressStep?.({
          id: stepId,
          label,
          status: 'failed',
          detail: hydrated.filePath,
          metadataText: formatProgressKeyValues([
            [
              'out_of_scope_reads',
              countRepoReviewOutOfScopeReads(childTurns, [hydrated.filePath]),
            ],
          ]),
          error,
        });
        return buildSupplementalExecutionResult(
          hydrated.filePath,
          {
            summary: '全文补充审查执行失败。',
            findings: [],
            suggestions: [],
            scopeLimitations: [
              `文件 ${hydrated.filePath} 的全文补充审查执行失败：${error}`,
            ],
            overallImpact: 'none',
            recommendedBlock: false,
          },
          true,
          [
            ...hydrated.scopeLimitations,
            ...(countRepoReviewOutOfScopeReads(childTurns, [
              hydrated.filePath,
            ]) > 0
              ? [
                  `全文补充子代理 ${hydrated.filePath} 存在越权读取，请主代理谨慎采信。`,
                ]
              : []),
          ],
        );
      }
    },
  );
  return results;
}

async function fetchTextIfOk(
  url: string,
  init: RequestInit,
): Promise<string | null> {
  const response = await fetch(url, init);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.text()).trim();
}

async function fetchRemoteProjectContextBlocks(
  repository: ReviewRepositoryRecord,
  branch: string,
): Promise<string[]> {
  const scm = getScmConfig(repository);
  if (!scm || !branch) return [];

  try {
    if (scm.provider === 'github' || scm.provider === 'gitea') {
      const headers: Record<string, string> =
        scm.provider === 'github'
          ? {
              Authorization: `Bearer ${scm.token}`,
              Accept: 'application/vnd.github+json',
            }
          : {
              Authorization: `token ${scm.token}`,
              Accept: 'application/json',
            };
      const results = await Promise.allSettled(
        REMOTE_PROJECT_CONTEXT_CANDIDATES.map(async (filePath) => {
          const payload = (await fetchJson(
            `${scm.apiBase}/repos/${scm.slug}/contents/${encodePathSegments(
              filePath,
            )}?ref=${encodeURIComponent(branch)}`,
            { headers },
          ).catch((err) => {
            if (err instanceof Error && /HTTP 404/i.test(err.message)) {
              return null;
            }
            throw err;
          })) as Record<string, unknown> | null;
          if (!payload) return '';
          const encoded = stringValue(payload.content).replace(/\n/g, '');
          const encoding = stringValue(payload.encoding);
          const decoded =
            encoding === 'base64' && encoded
              ? Buffer.from(encoded, 'base64').toString('utf8')
              : '';
          const text = trimContextBlock(decoded);
          if (!text) return '';
          return `File: ${filePath}\n${text}`;
        }),
      );
      return results
        .filter(
          (r): r is PromiseFulfilledResult<string> =>
            r.status === 'fulfilled' && r.value !== '',
        )
        .map((r) => r.value)
        .slice(0, 4);
    }

    const headers: Record<string, string> = { 'PRIVATE-TOKEN': scm.token };
    const project = encodeURIComponent(scm.slug);
    const results = await Promise.allSettled(
      REMOTE_PROJECT_CONTEXT_CANDIDATES.map(async (filePath) => {
        const text = await fetchTextIfOk(
          `${scm.apiBase}/projects/${project}/repository/files/${encodeURIComponent(
            filePath,
          )}/raw?ref=${encodeURIComponent(branch)}`,
          { headers },
        );
        if (!text) return '';
        return `File: ${filePath}\n${trimContextBlock(text)}`;
      }),
    );
    return results
      .filter(
        (r): r is PromiseFulfilledResult<string> =>
          r.status === 'fulfilled' && r.value !== '',
      )
      .map((r) => r.value)
      .slice(0, 4);
  } catch (err) {
    logger.warn(
      { err, repositoryId: repository.id, branch },
      'Failed to load remote project context files',
    );
    return [];
  }
}

async function fetchGitLabRemoteBranchEntries(
  repository: ReviewRepositoryRecord,
): Promise<Record<string, unknown>[]> {
  const scm = getScmConfig(repository);
  if (!scm || scm.provider !== 'gitlab') return [];
  const project = encodeURIComponent(scm.slug);
  return fetchJsonArray(
    `${scm.apiBase}/projects/${project}/repository/branches?per_page=100`,
    {
      headers: { 'PRIVATE-TOKEN': scm.token },
    },
  );
}

function normalizeGitLabBranchSummary(
  entry: Record<string, unknown>,
  defaultBranch: string,
): RepoReviewBranchSummary | null {
  const name = normalizeBranchName(stringValue(entry.name));
  if (!name) return null;
  const commit = asRecord(entry.commit);
  const parentIds = Array.isArray(commit.parent_ids)
    ? (commit.parent_ids as unknown[])
    : [];
  const normalizedDefaultBranch = normalizeBranchName(defaultBranch);
  return {
    name,
    headSha: stringValue(commit.id),
    parentSha: stringValue(parentIds[0]),
    actor: stringValue(commit.author_name || commit.committer_name),
    title: firstLine(stringValue(commit.title || commit.message)),
    latestCommitAt: stringValue(
      commit.created_at || commit.authored_date || commit.committed_date,
    ),
    defaultBranch: Boolean(entry.default) || name === normalizedDefaultBranch,
  };
}

async function fetchGitLabProjectDefaultBranch(
  repository: ReviewRepositoryRecord,
): Promise<string> {
  const scm = getScmConfig(repository);
  if (!scm || scm.provider !== 'gitlab') return '';
  const project = encodeURIComponent(scm.slug);
  const response = await fetchJson(`${scm.apiBase}/projects/${project}`, {
    headers: { 'PRIVATE-TOKEN': scm.token },
  });
  return stringValue(response.default_branch);
}

async function postGitLabCommitComment(input: {
  scm: NormalizedScmConfig;
  sha: string;
  body: string;
}): Promise<Record<string, unknown>> {
  const project = encodeURIComponent(input.scm.slug);
  const commentBody = new URLSearchParams({
    note: input.body,
  });
  return postJson(
    `${input.scm.apiBase}/projects/${project}/repository/commits/${encodeURIComponent(
      input.sha,
    )}/comments`,
    {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': input.scm.token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: commentBody,
    },
  );
}

async function fetchRemoteRepositoryDefaultBranch(
  repository: ReviewRepositoryRecord,
): Promise<string> {
  if (hasLocalGitRemoteAccess(repository)) {
    return resolveLocalRemoteDefaultBranch(repository);
  }
  const scm = getScmConfig(repository);
  if (!scm) return '';
  if (repository.default_target_branch) {
    return repository.default_target_branch;
  }
  const cachedDefaultBranch = getCachedRemoteDefaultBranch(repository.id);
  if (cachedDefaultBranch) return cachedDefaultBranch;
  if (scm.provider === 'github' || scm.provider === 'gitea') {
    const headers: Record<string, string> =
      scm.provider === 'github'
        ? {
            Authorization: `Bearer ${scm.token}`,
            Accept: 'application/vnd.github+json',
          }
        : { Authorization: `token ${scm.token}` };
    const response = await fetchJson(`${scm.apiBase}/repos/${scm.slug}`, {
      headers,
    });
    return stringValue(response.default_branch);
  }
  const branches = await fetchGitLabRemoteBranchEntries(repository);
  const listedDefaultBranch = branches
    .map((entry) => normalizeGitLabBranchSummary(entry, ''))
    .find((entry) => entry?.defaultBranch)?.name;
  if (listedDefaultBranch) return listedDefaultBranch;
  return fetchGitLabProjectDefaultBranch(repository);
}

async function listRemoteBranches(
  repository: ReviewRepositoryRecord,
): Promise<string[]> {
  if (hasLocalGitRemoteAccess(repository)) {
    return listLocalRemoteBranches(repository);
  }
  const scm = getScmConfig(repository);
  if (!scm) return [];
  if (scm.provider === 'github') {
    const branches = await fetchJsonArray(
      `${scm.apiBase}/repos/${scm.slug}/branches?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${scm.token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    return branches.map((entry) => stringValue(entry.name)).filter(Boolean);
  }
  if (scm.provider === 'gitlab') {
    const branches = await fetchGitLabRemoteBranchEntries(repository);
    return branches.map((entry) => stringValue(entry.name)).filter(Boolean);
  }
  const branches = await fetchJsonArray(
    `${scm.apiBase}/repos/${scm.slug}/branches?limit=100`,
    {
      headers: { Authorization: `token ${scm.token}` },
    },
  );
  return branches.map((entry) => stringValue(entry.name)).filter(Boolean);
}

async function fetchGitHubRemoteBranchEntries(
  repository: ReviewRepositoryRecord,
): Promise<Record<string, unknown>[]> {
  const scm = getScmConfig(repository);
  if (!scm || scm.provider !== 'github') return [];
  return fetchJsonArray(
    `${scm.apiBase}/repos/${scm.slug}/branches?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${scm.token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
}

async function fetchGiteaRemoteBranchEntries(
  repository: ReviewRepositoryRecord,
): Promise<Record<string, unknown>[]> {
  const scm = getScmConfig(repository);
  if (!scm || scm.provider !== 'gitea') return [];
  return fetchJsonArray(`${scm.apiBase}/repos/${scm.slug}/branches?limit=100`, {
    headers: { Authorization: `token ${scm.token}` },
  });
}

function normalizeGitHubLikeBranchSummary(
  entry: Record<string, unknown>,
  defaultBranch: string,
): RepoReviewBranchSummary | null {
  const name = normalizeBranchName(stringValue(entry.name));
  if (!name) return null;
  const commit = asRecord(entry.commit);
  const nestedCommit = asRecord(commit.commit);
  const nestedAuthor = asRecord(nestedCommit.author);
  const parents = Array.isArray(commit.parents)
    ? (commit.parents as Array<Record<string, unknown>>)
    : [];
  const parentIds = Array.isArray(commit.parent_ids)
    ? (commit.parent_ids as unknown[])
    : [];
  const normalizedDefaultBranch = normalizeBranchName(defaultBranch);
  return {
    name,
    headSha: stringValue(commit.sha || commit.id),
    parentSha: stringValue(parents[0]?.sha) || stringValue(parentIds[0]) || '',
    actor:
      stringValue(asRecord(commit.author).login) ||
      stringValue(commit.author_name || commit.committer_name) ||
      stringValue(nestedAuthor.name),
    title:
      firstLine(
        stringValue(nestedCommit.message || commit.message || commit.title),
      ) || '',
    latestCommitAt: stringValue(
      nestedAuthor.date ||
        commit.created_at ||
        commit.authored_date ||
        commit.committed_date,
    ),
    defaultBranch: Boolean(entry.default) || name === normalizedDefaultBranch,
  };
}

async function fetchRemoteCommitSummaryByRef(
  repository: ReviewRepositoryRecord,
  ref: string,
): Promise<{
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
}> {
  const scm = getScmConfig(repository);
  if (!scm || !ref) {
    return {
      headSha: '',
      parentSha: '',
      actor: '',
      title: '',
      latestCommitAt: '',
    };
  }
  if (scm.provider === 'github') {
    const commits = await fetchJsonArray(
      `${scm.apiBase}/repos/${scm.slug}/commits?sha=${encodeURIComponent(
        ref,
      )}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${scm.token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    const commit = commits[0] || {};
    const parents = Array.isArray(commit.parents)
      ? (commit.parents as Array<Record<string, unknown>>)
      : [];
    return {
      headSha: stringValue(commit.sha),
      parentSha: stringValue(parents[0]?.sha),
      actor:
        stringValue(asRecord(commit.author).login) ||
        stringValue(asRecord(asRecord(commit.commit).author).name),
      title: firstLine(stringValue(asRecord(commit.commit).message)),
      latestCommitAt: stringValue(
        asRecord(asRecord(commit.commit).author).date,
      ),
    };
  }
  if (scm.provider === 'gitlab') {
    const project = encodeURIComponent(scm.slug);
    const payload = await fetchJson(
      `${scm.apiBase}/projects/${project}/repository/branches/${encodeURIComponent(
        ref,
      )}`,
      {
        headers: { 'PRIVATE-TOKEN': scm.token },
      },
    );
    const summary = normalizeGitLabBranchSummary(
      payload,
      stringValue(repository.default_target_branch),
    );
    return summary
      ? {
          headSha: summary.headSha,
          parentSha: summary.parentSha,
          actor: summary.actor,
          title: summary.title,
          latestCommitAt: summary.latestCommitAt,
        }
      : {
          headSha: '',
          parentSha: '',
          actor: '',
          title: '',
          latestCommitAt: '',
        };
  }
  const commits = await fetchJsonArray(
    `${scm.apiBase}/repos/${scm.slug}/commits?sha=${encodeURIComponent(
      ref,
    )}&limit=1`,
    {
      headers: { Authorization: `token ${scm.token}` },
    },
  );
  const commit = commits[0] || {};
  const parents = Array.isArray(commit.parents)
    ? (commit.parents as Array<Record<string, unknown>>)
    : [];
  return {
    headSha: stringValue(commit.sha),
    parentSha: stringValue(parents[0]?.sha),
    actor:
      stringValue(asRecord(commit.author).login) ||
      stringValue(asRecord(asRecord(commit.commit).author).name),
    title: firstLine(stringValue(asRecord(commit.commit).message)),
    latestCommitAt: stringValue(asRecord(asRecord(commit.commit).author).date),
  };
}

async function fetchRemoteBranchHead(
  repository: ReviewRepositoryRecord,
  branch: string,
): Promise<{
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
}> {
  if (hasLocalGitRemoteAccess(repository)) {
    return await fetchLocalRemoteBranchHead(repository, branch);
  }
  const cached = getCachedRemoteBranchSummary(repository.id, branch);
  if (cached) {
    return {
      headSha: cached.headSha,
      parentSha: cached.parentSha,
      actor: cached.actor,
      title: cached.title,
      latestCommitAt: cached.latestCommitAt,
    };
  }
  const scm = getScmConfig(repository);
  if (!scm) {
    return {
      headSha: '',
      parentSha: '',
      actor: '',
      title: '',
      latestCommitAt: '',
    };
  }
  return fetchRemoteCommitSummaryByRef(repository, branch);
}

async function fetchRemoteBranchCommitDetails(
  repository: ReviewRepositoryRecord,
  branch: string,
  limit = 10,
): Promise<RepoReviewCommitInfo[]> {
  if (hasLocalGitRemoteAccess(repository)) {
    return await fetchLocalRemoteBranchCommitDetails(repository, branch, limit);
  }
  const scm = getScmConfig(repository);
  if (!scm) return [];
  const cappedLimit = Math.max(1, Math.min(limit, 100));
  if (scm.provider === 'github') {
    const commits = await fetchJsonArray(
      `${scm.apiBase}/repos/${scm.slug}/commits?sha=${encodeURIComponent(
        branch,
      )}&per_page=${cappedLimit}`,
      {
        headers: {
          Authorization: `Bearer ${scm.token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    return commits.map((commit) => ({
      commit: shortSha(stringValue(commit.sha)),
      sha: stringValue(commit.sha) || undefined,
      title: firstLine(stringValue(asRecord(commit.commit).message)),
      author:
        stringValue(asRecord(commit.author).login) ||
        stringValue(asRecord(asRecord(commit.commit).author).name),
      message: stringValue(asRecord(commit.commit).message),
      url: stringValue(commit.html_url),
      timestamp: stringValue(asRecord(asRecord(commit.commit).author).date),
    }));
  }
  if (scm.provider === 'gitlab') {
    const project = encodeURIComponent(scm.slug);
    const commits = await fetchJsonArray(
      `${scm.apiBase}/projects/${project}/repository/commits?ref_name=${encodeURIComponent(
        branch,
      )}&per_page=${cappedLimit}`,
      {
        headers: { 'PRIVATE-TOKEN': scm.token },
      },
    );
    return commits.map((commit) => ({
      commit: shortSha(stringValue(commit.id)),
      sha: stringValue(commit.id) || undefined,
      title: firstLine(stringValue(commit.title || commit.message)),
      author: stringValue(commit.author_name || commit.committer_name),
      message: stringValue(commit.message),
      url: stringValue(commit.web_url),
      timestamp: stringValue(commit.created_at || commit.committed_date),
    }));
  }
  const commits = await fetchJsonArray(
    `${scm.apiBase}/repos/${scm.slug}/commits?sha=${encodeURIComponent(
      branch,
    )}&limit=${cappedLimit}`,
    {
      headers: { Authorization: `token ${scm.token}` },
    },
  );
  return commits.map((commit) => ({
    commit: shortSha(stringValue(commit.sha)),
    sha: stringValue(commit.sha) || undefined,
    title: firstLine(stringValue(asRecord(commit.commit).message)),
    author:
      stringValue(asRecord(commit.author).login) ||
      stringValue(asRecord(asRecord(commit.commit).author).name),
    message: stringValue(asRecord(commit.commit).message),
    url: stringValue(commit.html_url || commit.url),
    timestamp: stringValue(asRecord(asRecord(commit.commit).author).date),
  }));
}

async function resolveRemoteReviewContext(
  repository: ReviewRepositoryRecord,
  event: RepoReviewEvent,
): Promise<ReviewPreparedContext> {
  let scm = getScmConfig(repository);
  let localAccessible = hasLocalGitRemoteAccess(repository);

  // Attempt mirror recovery if local access is unavailable
  if (!localAccessible && repository.clone_url) {
    localAccessible = await tryRecoverLocalMirror(repository);
    if (localAccessible) {
      await refreshRepositoryRemoteRefs(repository);
    }
  }

  if (localAccessible) {
    const localContext = await resolveLocalRemoteReviewContext(
      repository,
      event,
    );
    if (localContext.changedFiles.length > 0 && localContext.diffText.trim()) {
      return localContext;
    }
    if (!scm) {
      return localContext;
    }
    logger.warn(
      {
        repositoryId: repository.id,
        branch: normalizeBranchName(event.branch || ''),
        baseSha: event.baseSha,
        headSha: event.headSha,
      },
      'Local remote review context was empty, falling back to SCM compare API',
    );
  }
  if (!scm) {
    throw new Error('Remote provider config is incomplete');
  }

  if (scm.provider === 'github') {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${scm.token}`,
      Accept: 'application/vnd.github+json',
    };
    if (event.prMrNumber) {
      const files = await fetchJsonArray(
        `${scm.apiBase}/repos/${scm.slug}/pulls/${encodeURIComponent(
          event.prMrNumber,
        )}/files?per_page=100`,
        { headers },
      );
      const changedFiles = files
        .map((file) => stringValue(file.filename))
        .filter(Boolean);
      const diffText = files
        .map((file) => {
          const fileName = stringValue(file.filename);
          const patch = stringValue(file.patch);
          if (!fileName || !patch) return '';
          return `diff --git a/${fileName} b/${fileName}\n${patch}`;
        })
        .filter(Boolean)
        .join('\n');
      return {
        diffText,
        changedFiles,
        baseSha: event.baseSha || '',
        headSha: event.headSha || '',
        branch: normalizeBranchName(event.branch || ''),
        ref: event.ref || '',
        actor: stringValue(event.actor),
        commitSummaryLines: readEventCommitSummaryLines(event),
        commitDetails: readEventCommitDetails(event),
        projectContextBlocks: await fetchRemoteProjectContextBlocks(
          repository,
          normalizeBranchName(event.branch || ''),
        ),
      };
    }
    const compare = await fetchJson(
      `${scm.apiBase}/repos/${scm.slug}/compare/${encodeURIComponent(
        event.baseSha || '',
      )}...${encodeURIComponent(event.headSha || '')}`,
      { headers },
    );
    const files = Array.isArray(compare.files)
      ? (compare.files as Array<Record<string, unknown>>)
      : [];
    const commits = Array.isArray(compare.commits)
      ? (compare.commits as Array<Record<string, unknown>>)
      : [];
    const commitSummaryLines = readEventCommitSummaryLines(event);
    const branch = normalizeBranchName(event.branch || '');
    return {
      diffText: files
        .map((file) => {
          const fileName = stringValue(file.filename);
          const patch = stringValue(file.patch);
          if (!fileName || !patch) return '';
          return `diff --git a/${fileName} b/${fileName}\n${patch}`;
        })
        .filter(Boolean)
        .join('\n'),
      changedFiles: files
        .map((file) => stringValue(file.filename))
        .filter(Boolean),
      baseSha: event.baseSha || '',
      headSha: event.headSha || '',
      branch,
      ref: event.ref || '',
      actor: stringValue(event.actor),
      commitSummaryLines:
        commitSummaryLines.length > 0
          ? commitSummaryLines
          : commits
              .map((commit) => {
                const sha = shortSha(stringValue(commit.sha));
                const title = firstLine(
                  stringValue(asRecord(commit.commit).message),
                );
                return trimMessageLine(`${sha} ${title}`);
              })
              .filter(Boolean)
              .slice(0, 20),
      commitDetails: readEventCommitDetails(event),
      projectContextBlocks: await fetchRemoteProjectContextBlocks(
        repository,
        branch,
      ),
    };
  }

  if (scm.provider === 'gitlab') {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': scm.token };
    const project = encodeURIComponent(scm.slug);
    if (event.prMrNumber) {
      const response = await fetchJson(
        `${scm.apiBase}/projects/${project}/merge_requests/${encodeURIComponent(
          event.prMrNumber,
        )}/changes`,
        { headers },
      );
      const changes = Array.isArray(response.changes)
        ? (response.changes as Array<Record<string, unknown>>)
        : [];
      return {
        diffText: changes
          .map((file) => {
            const fileName =
              stringValue(file.new_path) || stringValue(file.old_path);
            const diff = stringValue(file.diff);
            if (!fileName || !diff) return '';
            return `diff --git a/${fileName} b/${fileName}\n${diff}`;
          })
          .filter(Boolean)
          .join('\n'),
        changedFiles: changes
          .map(
            (file) => stringValue(file.new_path) || stringValue(file.old_path),
          )
          .filter(Boolean),
        baseSha: event.baseSha || '',
        headSha: event.headSha || '',
        branch: normalizeBranchName(event.branch || ''),
        ref: event.ref || '',
        actor: stringValue(event.actor),
        commitSummaryLines: readEventCommitSummaryLines(event),
        commitDetails: readEventCommitDetails(event),
        projectContextBlocks: await fetchRemoteProjectContextBlocks(
          repository,
          normalizeBranchName(event.branch || ''),
        ),
      };
    }
    const response = await fetchJson(
      `${scm.apiBase}/projects/${project}/repository/compare?from=${encodeURIComponent(
        event.baseSha || '',
      )}&to=${encodeURIComponent(event.headSha || '')}`,
      { headers },
    );
    const diffs = Array.isArray(response.diffs)
      ? (response.diffs as Array<Record<string, unknown>>)
      : [];
    const commits = Array.isArray(response.commits)
      ? (response.commits as Array<Record<string, unknown>>)
      : [];
    const commitSummaryLines = readEventCommitSummaryLines(event);
    const branch = normalizeBranchName(event.branch || '');
    return {
      diffText: diffs
        .map((file) => {
          const fileName =
            stringValue(file.new_path) || stringValue(file.old_path);
          const diff = stringValue(file.diff);
          if (!fileName || !diff) return '';
          return `diff --git a/${fileName} b/${fileName}\n${diff}`;
        })
        .filter(Boolean)
        .join('\n'),
      changedFiles: diffs
        .map((file) => stringValue(file.new_path) || stringValue(file.old_path))
        .filter(Boolean),
      baseSha: event.baseSha || '',
      headSha: event.headSha || '',
      branch,
      ref: event.ref || '',
      actor: stringValue(event.actor),
      commitSummaryLines:
        commitSummaryLines.length > 0
          ? commitSummaryLines
          : commits
              .map((commit) => {
                const sha = shortSha(stringValue(commit.id));
                const title = firstLine(
                  stringValue(commit.title || commit.message),
                );
                return trimMessageLine(`${sha} ${title}`);
              })
              .filter(Boolean)
              .slice(0, 20),
      commitDetails: readEventCommitDetails(event),
      projectContextBlocks: await fetchRemoteProjectContextBlocks(
        repository,
        branch,
      ),
    };
  }

  const headers: Record<string, string> = {
    Authorization: `token ${scm.token}`,
  };
  if (event.prMrNumber) {
    const files = await fetchJsonArray(
      `${scm.apiBase}/repos/${scm.slug}/pulls/${encodeURIComponent(
        event.prMrNumber,
      )}/files`,
      { headers },
    );
    return {
      diffText: files
        .map((file) => {
          const fileName = stringValue(file.filename);
          const patch = stringValue(file.patch);
          if (!fileName || !patch) return '';
          return `diff --git a/${fileName} b/${fileName}\n${patch}`;
        })
        .filter(Boolean)
        .join('\n'),
      changedFiles: files
        .map((file) => stringValue(file.filename))
        .filter(Boolean),
      baseSha: event.baseSha || '',
      headSha: event.headSha || '',
      branch: normalizeBranchName(event.branch || ''),
      ref: event.ref || '',
      actor: stringValue(event.actor),
      commitSummaryLines: readEventCommitSummaryLines(event),
      commitDetails: readEventCommitDetails(event),
      projectContextBlocks: await fetchRemoteProjectContextBlocks(
        repository,
        normalizeBranchName(event.branch || ''),
      ),
    };
  }

  const compare = await fetchJson(
    `${scm.apiBase}/repos/${scm.slug}/compare/${encodeURIComponent(
      event.baseSha || '',
    )}...${encodeURIComponent(event.headSha || '')}`,
    { headers },
  );
  let files = Array.isArray(compare.files)
    ? (compare.files as Array<Record<string, unknown>>)
    : [];
  const commits = Array.isArray(compare.commits)
    ? (compare.commits as Array<Record<string, unknown>>)
    : [];

  // Gitea compare API nests files inside each commit, not at the top level.
  if (files.length === 0 && commits.length > 0) {
    const seen = new Set<string>();
    for (const commit of commits) {
      const commitFiles = Array.isArray(commit.files)
        ? (commit.files as Array<Record<string, unknown>>)
        : [];
      for (const f of commitFiles) {
        const name = stringValue(f.filename);
        if (name && !seen.has(name)) {
          seen.add(name);
          files.push(f);
        }
      }
    }
  }

  const commitSummaryLines = readEventCommitSummaryLines(event);
  const branch = normalizeBranchName(event.branch || '');

  let diffText = files
    .map((file) => {
      const fileName = stringValue(file.filename);
      const patch = stringValue(file.patch);
      if (!fileName || !patch) return '';
      return `diff --git a/${fileName} b/${fileName}\n${patch}`;
    })
    .filter(Boolean)
    .join('\n');

  const changedFiles = files
    .map((file) => stringValue(file.filename))
    .filter(Boolean);

  // Gitea commit files lack patch content; fall back to a local clone diff.
  if (!diffText && changedFiles.length > 0) {
    const ws = await prepareRemoteWorkspace(
      repository,
      branch,
      event.headSha || '',
      event.baseSha || '',
    );
    if (ws) {
      try {
        const baseSha = event.baseSha || '';
        const headSha = event.headSha || '';
        const diffRange = baseSha ? `${baseSha}..${headSha}` : `${headSha}^!`;
        diffText = await runGitCommandAsync(
          ws,
          ['diff', '--find-renames', '--no-color', diffRange],
          true,
          REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
        );
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    }
  }

  return {
    diffText,
    changedFiles,
    baseSha: event.baseSha || '',
    headSha: event.headSha || '',
    branch,
    ref: event.ref || '',
    actor: stringValue(event.actor),
    commitSummaryLines:
      commitSummaryLines.length > 0
        ? commitSummaryLines
        : commits
            .map((commit) => {
              const sha = shortSha(stringValue(commit.sha));
              const title = firstLine(
                stringValue(asRecord(commit.commit).message || commit.message),
              );
              return trimMessageLine(`${sha} ${title}`);
            })
            .filter(Boolean)
            .slice(0, 20),
    commitDetails: readEventCommitDetails(event),
    projectContextBlocks: await fetchRemoteProjectContextBlocks(
      repository,
      branch,
    ),
  };
}

async function publishPlatformResult(
  repository: ReviewRepositoryRecord,
  run: RepoReviewRun,
  profile: RepoReviewProfile,
  overrides?: {
    state?: string;
    description?: string;
    body?: string;
  },
): Promise<{
  status: string;
  statusDeliveryStatus: ReviewDeliveryStatus;
  commentDeliveryStatus: ReviewDeliveryStatus;
  commentId?: string;
  commentUrl?: string;
}> {
  const scm = getScmConfig(repository);
  if (!scm || !run.headSha) {
    return {
      status: 'not-configured',
      statusDeliveryStatus: 'not_configured',
      commentDeliveryStatus: 'not_configured',
    };
  }
  const overall = (run.overall || 'error') as ReviewOverall;
  const state =
    overrides?.state ||
    mapOverallToStatus(scm.provider, overall, profile.passDecisionMode);
  const description =
    overrides?.description ||
    shortDescription(run.summary || run.error || 'NanoClaw review completed');
  const body =
    overrides?.body ||
    formatRepoReviewPlatformCommentMessage(
      await normalizeRepositoryRecord(repository),
      run,
      profile.passDecisionMode,
    );
  let commentUrl = '';
  let commentId = '';

  if (scm.provider === 'github') {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${scm.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    await postJson(`${scm.apiBase}/repos/${scm.slug}/statuses/${run.headSha}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        state,
        context: REVIEW_STATUS_CONTEXT,
        description,
      }),
    });
    if (run.prMrNumber) {
      const response = run.platformCommentId
        ? await postJson(
            `${scm.apiBase}/repos/${scm.slug}/issues/comments/${encodeURIComponent(
              run.platformCommentId,
            )}`,
            {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ body }),
            },
          )
        : await postJson(
            `${scm.apiBase}/repos/${scm.slug}/issues/${encodeURIComponent(
              run.prMrNumber,
            )}/comments`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ body }),
            },
          );
      commentId = stringValue(response.id);
      commentUrl = stringValue(response.html_url) || stringValue(response.url);
    }
    return {
      status: state,
      statusDeliveryStatus: 'delivered',
      commentDeliveryStatus: run.prMrNumber ? 'delivered' : 'skipped',
      commentId: commentId || undefined,
      commentUrl,
    };
  }

  if (scm.provider === 'gitlab') {
    const project = encodeURIComponent(scm.slug);
    const formHeaders: Record<string, string> = {
      'PRIVATE-TOKEN': scm.token,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const statusBody = new URLSearchParams({
      state,
      name: REVIEW_STATUS_CONTEXT,
      description,
    });
    await postAndRequireOk(
      `${scm.apiBase}/projects/${project}/statuses/${encodeURIComponent(
        run.headSha,
      )}`,
      {
        method: 'POST',
        headers: formHeaders,
        body: statusBody,
      },
    );
    if (run.prMrNumber) {
      const response = run.platformCommentId
        ? await postJson(
            `${scm.apiBase}/projects/${project}/merge_requests/${encodeURIComponent(
              run.prMrNumber,
            )}/notes/${encodeURIComponent(run.platformCommentId)}`,
            {
              method: 'PUT',
              headers: {
                'PRIVATE-TOKEN': scm.token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body }),
            },
          )
        : await postJson(
            `${scm.apiBase}/projects/${project}/merge_requests/${encodeURIComponent(
              run.prMrNumber,
            )}/notes`,
            {
              method: 'POST',
              headers: {
                'PRIVATE-TOKEN': scm.token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body }),
            },
          );
      commentId = stringValue(response.id);
      commentUrl = stringValue(response.web_url) || stringValue(response.url);
    } else {
      const response = await postGitLabCommitComment({
        scm,
        sha: run.headSha,
        body,
      });
      commentId = stringValue(response.id);
      commentUrl = stringValue(response.web_url) || stringValue(response.url);
    }
    return {
      status: state,
      statusDeliveryStatus: 'delivered',
      commentDeliveryStatus: 'delivered',
      commentId: commentId || undefined,
      commentUrl,
    };
  }

  const headers: Record<string, string> = {
    Authorization: `token ${scm.token}`,
    'Content-Type': 'application/json',
  };
  await postJson(`${scm.apiBase}/repos/${scm.slug}/statuses/${run.headSha}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      state,
      context: REVIEW_STATUS_CONTEXT,
      description,
    }),
  });
  if (run.prMrNumber) {
    const response = run.platformCommentId
      ? await postJson(
          `${scm.apiBase}/repos/${scm.slug}/issues/comments/${encodeURIComponent(
            run.platformCommentId,
          )}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ body }),
          },
        )
      : await postJson(
          `${scm.apiBase}/repos/${scm.slug}/issues/${encodeURIComponent(
            run.prMrNumber,
          )}/comments`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ body }),
          },
        );
    commentId = stringValue(response.id);
    commentUrl = stringValue(response.html_url) || stringValue(response.url);
  }
  return {
    status: state,
    statusDeliveryStatus: 'delivered',
    commentDeliveryStatus: run.prMrNumber ? 'delivered' : 'skipped',
    commentId: commentId || undefined,
    commentUrl,
  };
}

function buildReviewGroup(repository: RepoReviewRepository): RegisteredGroup {
  return {
    name: `Repo Review ${repository.name}`,
    folder: `review-${slugifyId(repository.id)}`,
    trigger: '@repo-review',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
}

function createRepoReviewCancellationError(runId: string): Error {
  const error = new Error('Review task was cancelled by user.');
  Object.assign(error, {
    code: 'REPO_REVIEW_CANCELLED',
    runId,
  });
  return error;
}

function isRepoReviewCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as Error & { code?: string }).code === 'REPO_REVIEW_CANCELLED' ||
      error.message === 'Review task was cancelled by user.')
  );
}

function throwIfRepoReviewRunCancelled(runId: string): void {
  if (repoReviewCancellationRequestedRunIds.has(runId)) {
    throw createRepoReviewCancellationError(runId);
  }
}

async function markRepoReviewRunCancelled(
  runRecord: ReviewRunRecord,
  reason: string,
): Promise<RepoReviewRun> {
  const updated = await updateReviewRun(runRecord.id, {
    status: 'error',
    result_state: 'error',
    overall: 'error',
    summary: REPO_REVIEW_CANCELLED_SUMMARY,
    error: reason,
    completed_at: new Date().toISOString(),
  });
  const normalized = await normalizeRunRecord(updated);
  await updateBranchStateFromRun(normalized);
  return normalized;
}

async function buildRepoReviewConversationAgentConfig(
  repositories: RepoReviewRepository[],
  existing?: RegisteredGroup,
): Promise<RegisteredGroup['agentConfig']> {
  const allDirs: string[] = [];
  const writableDirNames: string[] = [];
  const readonlyDirNames: string[] = [];
  const repoIds: string[] = [];
  let anyAiFix = false;
  let latestWorktreePath: string | undefined;
  let latestWorktreeTime = '';

  const instructionSections: string[] = [
    t('repoReview.auto_2a484e', {}, undefined),
    '',
    t('repoReview.auto_add6cd', {}, undefined),
  ];

  for (const repo of repositories) {
    repoIds.push(repo.id);
    const repoPath = stringValue(repo.localRepoPath);
    if (repoPath) allDirs.push(repoPath);
    if (repo.allowAiFix) anyAiFix = true;

    const worktrees = await listWorktrees(repo.id);
    const repoWtPaths = worktrees.map((w) => w.workDirectory);
    allDirs.push(...repoWtPaths);

    const repoDirs = repoPath ? [repoPath, ...repoWtPaths] : repoWtPaths;
    if (repo.allowAiFix) {
      writableDirNames.push(...repoDirs);
    } else {
      readonlyDirNames.push(...repoDirs);
    }

    for (const wt of worktrees) {
      if (wt.lastUsedAt > latestWorktreeTime) {
        latestWorktreeTime = wt.lastUsedAt;
        latestWorktreePath = wt.workDirectory;
      }
    }

    const fixLabel = repo.allowAiFix
      ? t('errors.auto_0a60ac', {}, undefined)
      : t('repoReview.auto_c9744f', {}, undefined);
    instructionSections.push(
      '',
      t('repoReview.repoFixLabel', { name: repo.name, fixLabel }, undefined),
    );

    if (worktrees.length > 0) {
      instructionSections.push(t('repoReview.auto_5a4d64', {}, undefined));
      for (const wt of worktrees) {
        instructionSections.push(`- ${wt.branch} → ${wt.workDirectory}`);
      }
    }
  }

  instructionSections.push(
    '',
    t('repoReview.auto_50d3db', {}, undefined),
    t('repoReview.auto_213361', {}, undefined),
    t('repoReview.auto_df2816', {}, undefined),
    t('repoReview.auto_6161a3', {}, undefined),
    '',
    t('repoReview.auto_4bb0af', {}, undefined),
    '',
    t('repoReview.auto_ebbaea', {}, undefined),
    t('repoReview.auto_ec640d', {}, undefined),
    t('repoReview.auto_0b0184', {}, undefined),
    t('repoReview.auto_377305', {}, undefined),
    '',
    t('repoReview.auto_7dedca', {}, undefined),
    t('repoReview.auto_9358d9', {}, undefined),
  );

  if (anyAiFix) {
    instructionSections.push(t('repoReview.auto_78c610', {}, undefined));
    for (const d of writableDirNames) {
      instructionSections.push(`  - ${d}`);
    }
    instructionSections.push(t('repoReview.auto_3665a7', {}, undefined));
    if (readonlyDirNames.length > 0) {
      instructionSections.push(t('repoReview.auto_1c144b', {}, undefined));
      for (const d of readonlyDirNames) {
        instructionSections.push(`  - ${d}`);
      }
    }
  }

  instructionSections.push(
    '',
    t('repoReview.auto_9d1ebb', {}, undefined),
    t('repoReview.auto_29b2fe', {}, undefined),
    t('repoReview.auto_b528f1', {}, undefined),
    t('repoReview.auto_9d10b7', {}, undefined),
    t('repoReview.auto_c388d1', {}, undefined),
  );

  const accessMode = anyAiFix ? 'allowlist' : 'readonly';
  const effectiveRoot =
    latestWorktreePath ||
    (repositories[0] ? stringValue(repositories[0].localRepoPath) : '') ||
    existing?.agentConfig?.projectRoot;

  return {
    ...existing?.agentConfig,
    accessPolicy:
      allDirs.length > 0
        ? { mode: accessMode, directories: allDirs }
        : existing?.agentConfig?.accessPolicy,
    allowedDirectories: allDirs.length > 0 ? allDirs : [],
    strictAllowedDirectories: allDirs.length > 0,
    projectRoot: effectiveRoot || existing?.agentConfig?.projectRoot,
    workingDirectory: effectiveRoot || existing?.agentConfig?.workingDirectory,
    customInstructions: instructionSections.join('\n'),
    reviewRepositoryIds: repoIds,
  };
}

export async function getRepoReviewConversationBinding(
  chatJid: string,
): Promise<{
  repositoryId: string;
  repositoryIds: string[];
  group: RegisteredGroup;
} | null> {
  const normalizedChatJid = stringValue(chatJid);
  if (!normalizedChatJid) return null;

  const bindings =
    await listReviewConversationBindingsByChatJid(normalizedChatJid);

  if (bindings.length === 0) {
    const binding =
      await getReviewConversationBindingByChatJid(normalizedChatJid);
    if (!binding) {
      const fallbackRecord = (await listReviewRepositories()).find((entry) => {
        const boundChatJid = entry.review_chat_jid || `repo-review:${entry.id}`;
        return boundChatJid === normalizedChatJid;
      });
      if (!fallbackRecord) return null;
      const repo = await normalizeRepositoryRecord(fallbackRecord);
      const existing = await getRegisteredGroup(normalizedChatJid);
      const baseGroup = existing || buildReviewGroup(repo);
      return {
        repositoryId: repo.id,
        repositoryIds: [repo.id],
        group: {
          ...baseGroup,
          requiresTrigger: false,
          isMain: false,
          agentConfig: await buildRepoReviewConversationAgentConfig(
            [repo],
            existing || baseGroup,
          ),
        },
      };
    }
    bindings.push(binding);
  }

  const repositories: RepoReviewRepository[] = [];
  for (const b of bindings) {
    const record = await getReviewRepositoryById(b.repository_id);
    if (record && record.enabled === 1) {
      repositories.push(await normalizeRepositoryRecord(record));
    }
  }
  if (repositories.length === 0) return null;

  const existing = await getRegisteredGroup(normalizedChatJid);
  const baseGroup = existing || buildReviewGroup(repositories[0]!);
  return {
    repositoryId: repositories[0]!.id,
    repositoryIds: repositories.map((r) => r.id),
    group: {
      ...baseGroup,
      requiresTrigger: false,
      isMain: false,
      agentConfig: await buildRepoReviewConversationAgentConfig(
        repositories,
        existing || baseGroup,
      ),
    },
  };
}

async function runReviewAgent(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prompt: string;
  runId: string;
  runtimeNamespace?: string;
  workspacePath?: string | null;
  userId?: string;
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  timeoutMs?: number;
  timeoutFollowupPrompt?: string;
  timeoutGraceMs?: number;
  onTimeoutFollowupDispatched?: () => void | Promise<void>;
  onStatusEvent?: (event: AgentEventPayload) => Promise<void>;
  attachWorkspace?: boolean;
  toolPolicy?: AgentRunInput['toolPolicy'];
  turnContext?: RepoReviewTurnContext;
}): Promise<{
  outputText: string;
  timedOut: boolean;
  timeoutFollowupSent: boolean;
}> {
  const group = buildReviewGroup(input.repository);
  const reviewChatJid =
    input.repository.reviewChatJid || `repo-review:${input.repository.id}`;
  const providerOverrideId = await resolveReviewProviderOverrideId({
    profile: input.profile,
    repository: input.repository,
    runId: input.runId,
    userId: input.userId,
  });
  const agentInput: AgentRunInput = {
    prompt: {
      text: input.prompt,
      stableSystemPrompt: REPO_REVIEW_AGENT_SYSTEM_PROMPT,
    },
    groupFolder: group.folder,
    chatJid: reviewChatJid,
    isMain: false,
    isScheduledTask: true,
    suppressDefaultSystemPrompt: true,
    // Borrow the ephemeral-session / skip-IPC-drain semantics of scheduled
    // tasks, but opt out of the "[SYSTEM DISPATCH]" preamble — that preamble
    // is tuned for short reminder dispatches and derails repo review agents
    // (gpt-5.4 etc. refuse when structured-JSON instructions collide with
    // "do not mention task creation/configuration" hard directives).
    suppressScheduledTaskPreamble: true,
    disableDefaultWebSearch: true,
    toolPolicy: input.toolPolicy || 'readonly',
    assistantName: await getAssistantName(),
    runtimeNamespace: input.runtimeNamespace || input.runId,
    managedSkillIds: input.profile.skillIds,
    managedMcpServerIds: input.profile.mcpServerIds,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(providerOverrideId ? { providerOverrideId } : {}),
  };
  const reviewWorkspacePath =
    input.workspacePath || input.repository.localRepoPath;
  if (input.attachWorkspace !== false && reviewWorkspacePath) {
    const allowedDirectories = buildRepoReviewReadOnlyAllowedDirectories(
      reviewWorkspacePath,
      input.repository.localRepoPath,
    );
    agentInput.extraMounts = [
      {
        hostPath: reviewWorkspacePath,
        targetPath: '/workspace/extra',
        readonly: true,
      },
    ];
    agentInput.accessModeOverride = 'readonly';
    agentInput.allowedDirectoriesOverride = allowedDirectories;
    agentInput.workingDirectory = '/workspace/extra';
  }
  let agentProcess: ChildProcess | null = null;
  let streamedResult = '';
  let reviewTurns: RepoReviewAssistantTurn[] = [];
  let closeRequested = false;
  let latestCompletedAssistantMessageText = '';
  let sawTurnEvent = false;
  let sawTerminalTurnEvent = false;
  let terminalOutputSeen = false;
  let latestTurnsForProgressPersist: RepoReviewAssistantTurn[] | null = null;
  let progressPersistScheduled = false;
  let progressPersistPromise: Promise<void> = Promise.resolve();
  let progressPersistTimer: NodeJS.Timeout | null = null;
  let earlyFinalTimer: NodeJS.Timeout | null = null;
  let timeoutGraceTimer: NodeJS.Timeout | null = null;
  let earlyFinalResolved = false;
  let timedOut = false;
  let timeoutFollowupSent = false;
  let resolveEarlyFinal: (() => void) | null = null;
  const earlyFinalPromise = new Promise<void>((resolve) => {
    resolveEarlyFinal = resolve;
  });
  const resolveEarlyFinalIfReady = (force = false) => {
    if (earlyFinalResolved || !terminalOutputSeen) return;
    if (!force && sawTurnEvent && !sawTerminalTurnEvent) {
      if (!earlyFinalTimer) {
        earlyFinalTimer = setTimeout(() => {
          earlyFinalTimer = null;
          resolveEarlyFinalIfReady(true);
        }, 750);
        earlyFinalTimer.unref?.();
      }
      return;
    }
    earlyFinalResolved = true;
    if (earlyFinalTimer) {
      clearTimeout(earlyFinalTimer);
      earlyFinalTimer = null;
    }
    resolveEarlyFinal?.();
  };
  const flushProgressPersist = async () => {
    if (progressPersistTimer) {
      clearTimeout(progressPersistTimer);
      progressPersistTimer = null;
    }
    if (latestTurnsForProgressPersist) {
      const finalTurns = latestTurnsForProgressPersist;
      latestTurnsForProgressPersist = null;
      await input.onTurnProgress?.(finalTurns);
    }
    await progressPersistPromise;
  };
  const queueReviewProgressPersist = (turns: RepoReviewAssistantTurn[]) => {
    latestTurnsForProgressPersist = turns;
    if (progressPersistScheduled) {
      return;
    }
    progressPersistScheduled = true;
    progressPersistTimer = setTimeout(() => {
      progressPersistPromise = progressPersistPromise.then(async () => {
        while (latestTurnsForProgressPersist) {
          const snapshot = latestTurnsForProgressPersist;
          latestTurnsForProgressPersist = null;
          try {
            await input.onTurnProgress?.(snapshot);
          } catch (err) {
            logger.warn(
              { err, repositoryId: input.repository.id, runId: input.runId },
              'Failed to persist intermediate repo review turn progress',
            );
          }
        }
        progressPersistScheduled = false;
        progressPersistTimer = null;
        if (latestTurnsForProgressPersist) {
          queueReviewProgressPersist(latestTurnsForProgressPersist);
        }
      });
    }, 250);
  };
  const closeAgentInput = () => {
    if (closeRequested) return;
    closeRequested = true;
    requestAgentClose(group.folder, input.runtimeNamespace || input.runId);
    if (
      !agentProcess?.stdin ||
      agentProcess.stdin.destroyed ||
      agentProcess.stdin.writableEnded
    ) {
      return;
    }
    try {
      agentProcess.stdin.end();
    } catch {
      // Best-effort close so single-turn review agents do not wait for
      // another IPC message after already returning the final result.
    }
  };
  const forceStopAgentProcess = () => {
    closeAgentInput();
    if (!agentProcess || agentProcess.killed) return;
    try {
      agentProcess.kill('SIGTERM');
      setTimeout(() => {
        if (!agentProcess || agentProcess.killed) return;
        try {
          agentProcess.kill('SIGKILL');
        } catch {
          // Best-effort cleanup after timeout/cancel.
        }
      }, 1_000).unref?.();
    } catch {
      // Best-effort cleanup after timeout/cancel.
    }
  };
  const maybeCloseAgentInput = () => {
    if (closeRequested) return;
    if (sawTurnEvent) {
      if (
        !sawTerminalTurnEvent ||
        (!terminalOutputSeen && !latestCompletedAssistantMessageText.trim())
      ) {
        return;
      }
      closeAgentInput();
      return;
    }
    if (terminalOutputSeen) {
      closeAgentInput();
    }
  };
  let result: Awaited<ReturnType<typeof runAgentProcess>>;
  let timeoutTimer: NodeJS.Timeout | null = null;
  try {
    const processPromise = runAgentProcess(
      group,
      agentInput,
      (proc) => {
        agentProcess = proc;
      },
      async (output) => {
        const webChannel = getWebChannel();
        if (output.event) {
          await input.onStatusEvent?.(output.event);
        }
        if (output.turnEvent) {
          sawTurnEvent = true;
          const nextTurns = applyReviewTurnEvent(
            reviewTurns,
            output.turnEvent,
            input.turnContext,
          );
          if (nextTurns !== reviewTurns) {
            reviewTurns = nextTurns;
            latestCompletedAssistantMessageText =
              extractLatestCompletedAssistantMessageText(reviewTurns) ||
              latestCompletedAssistantMessageText;
            if (shouldPersistRepoReviewTurnProgressEvent(output.turnEvent)) {
              queueReviewProgressPersist(reviewTurns);
            }
          }
          if (
            output.turnEvent.type === 'item.completed' &&
            output.turnEvent.item.type === 'assistant_message' &&
            output.turnEvent.item.status === 'completed' &&
            output.turnEvent.item.text.trim()
          ) {
            if (
              isUsableRepoReviewAssistantTerminalMessage(
                output.turnEvent.item.text,
              )
            ) {
              terminalOutputSeen = true;
              streamedResult = output.turnEvent.item.text;
              closeAgentInput();
              resolveEarlyFinalIfReady();
            }
          }
          const visibleTurnEvent = sanitizeReviewTurnEventForWeb(
            output.turnEvent,
            reviewTurns,
          );
          if (visibleTurnEvent) {
            webChannel?.notifyTurnEvent(reviewChatJid, visibleTurnEvent);
          }
          if (shouldCloseReviewAgentForTurnEvent(output.turnEvent)) {
            sawTerminalTurnEvent = true;
            maybeCloseAgentInput();
            resolveEarlyFinalIfReady(true);
          }
        }
        if (output.streamChunk) {
          // Repo review final model output is structured JSON, so we keep it
          // internal for parsing and only surface tool/reasoning progress live.
        }
        if (output.approvalRequest) {
          webChannel?.notifyApprovalRequest(
            reviewChatJid,
            output.approvalRequest,
          );
        }
        if (output.approvalResolved) {
          webChannel?.notifyApprovalResolved(
            reviewChatJid,
            output.approvalResolved,
          );
        }
        if (output.result) {
          terminalOutputSeen = true;
          streamedResult = output.result;
          maybeCloseAgentInput();
          resolveEarlyFinalIfReady();
        } else if (output.status === 'error') {
          terminalOutputSeen = true;
          maybeCloseAgentInput();
        }
      },
    );
    processPromise.catch((err) => {
      logger.warn(
        { err, repositoryId: input.repository.id, runId: input.runId },
        'Repo review agent process ended after forced close',
      );
    });
    const timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? Math.max(0, Math.trunc(input.timeoutMs))
        : 0;
    const timeoutGraceMs =
      typeof input.timeoutGraceMs === 'number' &&
      Number.isFinite(input.timeoutGraceMs)
        ? Math.max(0, Math.trunc(input.timeoutGraceMs))
        : REPO_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS;
    const earlyCompletionPromise = earlyFinalPromise.then(
      () =>
        ({
          status: 'success' as const,
          result: null,
        }) satisfies Awaited<ReturnType<typeof runAgentProcess>>,
    );
    const timeoutPromise =
      timeoutMs > 0
        ? new Promise<Awaited<ReturnType<typeof runAgentProcess>>>(
            (resolve) => {
              timeoutTimer = setTimeout(() => {
                const resolveTimeout = () => {
                  timedOut = true;
                  forceStopAgentProcess();
                  resolve({
                    status: 'error',
                    result: null,
                    error: `Review agent timed out after ${Math.round(timeoutMs / 1000)}s`,
                  });
                };
                if (
                  input.timeoutFollowupPrompt &&
                  !timeoutFollowupSent &&
                  !closeRequested
                ) {
                  timeoutFollowupSent = true;
                  try {
                    sendAgentPrompt(
                      group.folder,
                      input.runtimeNamespace || input.runId,
                      { text: input.timeoutFollowupPrompt },
                      `${input.runId}-timeout-followup`,
                    );
                    void input.onTimeoutFollowupDispatched?.();
                  } catch {
                    resolveTimeout();
                    return;
                  }
                  timeoutGraceTimer = setTimeout(
                    resolveTimeout,
                    timeoutGraceMs,
                  );
                  timeoutGraceTimer.unref?.();
                  return;
                }
                resolveTimeout();
              }, timeoutMs);
            },
          )
        : null;
    result = timeoutPromise
      ? await Promise.race([
          processPromise,
          earlyCompletionPromise,
          timeoutPromise,
        ])
      : await Promise.race([processPromise, earlyCompletionPromise]);
    if (earlyFinalResolved) {
      forceStopAgentProcess();
    }
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (timeoutGraceTimer) {
      clearTimeout(timeoutGraceTimer);
      timeoutGraceTimer = null;
    }
    if (earlyFinalTimer) {
      clearTimeout(earlyFinalTimer);
      earlyFinalTimer = null;
    }
    await flushProgressPersist();
  }
  if (hasUsableRepoReviewFinalResult(streamedResult)) {
    return {
      outputText: streamedResult,
      timedOut,
      timeoutFollowupSent,
    };
  }
  if (hasUsableRepoReviewFinalResult(result.result || '')) {
    return {
      outputText: result.result!,
      timedOut,
      timeoutFollowupSent,
    };
  }
  if (latestCompletedAssistantMessageText) {
    return {
      outputText: latestCompletedAssistantMessageText,
      timedOut,
      timeoutFollowupSent,
    };
  }
  if (streamedResult) {
    return {
      outputText: streamedResult,
      timedOut,
      timeoutFollowupSent,
    };
  }
  if (result.result) {
    return {
      outputText: result.result,
      timedOut,
      timeoutFollowupSent,
    };
  }
  if (result.status !== 'success') {
    throw new Error(result.error || 'Review agent did not return a result');
  }
  throw new Error('Review agent did not return a result');
}

async function prepareReviewContext(
  repository: RepoReviewRepository,
  profile: RepoReviewProfile,
  event: RepoReviewEvent,
): Promise<ReviewPreparedContext> {
  let prepared: ReviewPreparedContext;
  if (event.diffText && event.changedFiles?.length) {
    prepared = sanitizePreparedContext(
      {
        diffText: event.diffText,
        changedFiles: event.changedFiles,
        baseSha: event.baseSha || '',
        headSha: event.headSha || '',
        branch: normalizeBranchName(event.branch || ''),
        ref: event.ref || '',
        actor: stringValue(event.actor),
        commitSummaryLines: readEventCommitSummaryLines(event),
        commitDetails: readEventCommitDetails(event),
        projectContextBlocks: [],
      },
      profile,
    );
  } else if (event.source === 'local-hook') {
    prepared = sanitizePreparedContext(
      await resolveLocalReviewContext(repository, profile, event),
      profile,
    );
  } else {
    prepared = sanitizePreparedContext(
      await resolveRemoteReviewContext(
        await requireRepository(repository.id),
        event,
      ),
      profile,
    );
  }
  return enrichReviewPreparedContextWithCodeIntelligence({
    repository,
    prepared,
  });
}

function computeBlocking(
  profile: RepoReviewProfile,
  overall: ReviewOverall,
  recommendedBlock: boolean,
): boolean {
  if (profile.stage === 'push' && profile.passDecisionMode === 'human') {
    return false;
  }
  if (profile.blockingMode !== 'hard_fail') return false;
  if (overall === 'error') return true;
  return overall === 'fail' && recommendedBlock;
}

function computeRunResultState(input: {
  profile: RepoReviewProfile;
  status: string;
  overall?: ReviewOverall | '';
  blocking?: boolean;
  manualDecision?: '' | 'pass' | 'fail';
}): ReviewResultState {
  if (input.manualDecision === 'pass') return 'manual_passed';
  if (input.manualDecision === 'fail') return 'manual_failed';
  if (input.status === 'queued') return 'queued';
  if (input.status === 'running') return 'running';
  if (input.status === 'error' || input.overall === 'error') return 'error';
  if (input.status === 'skipped' || input.overall === 'skipped')
    return 'skipped';
  if (
    input.profile.stage === 'push' &&
    input.profile.passDecisionMode === 'human'
  ) {
    return 'pending_manual';
  }
  if (input.blocking) return 'failed';
  if (input.overall === 'pass') return 'passed';
  if (input.overall === 'warn') return 'warned';
  if (input.overall === 'fail') return 'failed';
  return 'error';
}

async function updateBranchStateFromRun(run: RepoReviewRun): Promise<void> {
  const branch = normalizeBranchName(run.branch);
  if (!branch) return;
  await upsertReviewBranchState({
    repository_id: run.repositoryId,
    stage: run.stage,
    branch,
    last_run_id: run.id,
    head_sha: run.headSha || null,
    baseline_sha: run.baseSha || null,
    baseline_source: run.baselineSource || null,
    result_state: (run.resultState || null) as ReviewResultState | null,
    status: run.status || null,
    actor: run.actor || null,
    summary: run.summary || null,
    reviewed_at: run.completedAt || run.updatedAt || new Date().toISOString(),
  });
}

function bumpDeliveryRetryCount(run: RepoReviewRun): number {
  return (Number(run.deliveryRetryCount) || 0) + 1;
}

function shouldReuseIdempotentRun(record: ReviewRunRecord): boolean {
  return record.status !== 'error' && record.overall !== 'error';
}

/**
 * Build idempotency key for all remote review events (webhook, auto-sync, manual-sync).
 * Events with identical repo/profile/source/stage/branch/head/base share a key so that
 * duplicate webhook deliveries and overlapping sync triggers are deduplicated.
 */
function buildRemoteReviewIdempotencyKey(input: {
  event: RepoReviewEvent;
  profileId?: string | null;
}): string {
  if (input.event.source === 'local-hook') return '';
  const manualReview = parseManualReviewOptions(input.event.callbackContext);
  if (manualReview.allowRepeat) {
    return '';
  }
  const headSha = stringValue(input.event.headSha);
  if (!headSha) return '';
  const baseSha = stringValue(input.event.baseSha);
  const branch =
    normalizeBranchName(input.event.branch || '') ||
    normalizeBranchName(input.event.ref || '') ||
    'unknown';
  return [
    input.event.repositoryId,
    input.profileId || 'no-profile',
    input.event.source,
    input.event.stage,
    branch,
    headSha,
    baseSha || 'no-base',
    buildManualReviewKey(manualReview, baseSha),
  ].join(':');
}

function computeDurationMs(startedAt: string, completedAt: string): number {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return 0;
  return Math.max(0, completedMs - startedMs);
}

async function applyRunChatDeliveryResult(
  run: RepoReviewRun,
  delivery: { status: ReviewDeliveryStatus; error?: string },
): Promise<RepoReviewRun> {
  const updates: Parameters<typeof updateReviewRun>[1] = {
    chat_delivery_status: delivery.status,
  };
  if (delivery.error) {
    updates.last_delivery_error = delivery.error;
  } else if (delivery.status === 'delivered' || delivery.status === 'skipped') {
    updates.last_delivery_error = null;
  }
  if (delivery.status === 'failed') {
    updates.delivery_retry_count = bumpDeliveryRetryCount(run);
  }
  return normalizeRunRecord(await updateReviewRun(run.id, updates));
}

async function applyRunPlatformDeliveryResult(
  run: RepoReviewRun,
  delivery: {
    status?: string;
    statusDeliveryStatus?: ReviewDeliveryStatus;
    commentDeliveryStatus?: ReviewDeliveryStatus;
    commentId?: string;
    commentUrl?: string;
    error?: string;
  },
): Promise<RepoReviewRun> {
  const updates: Parameters<typeof updateReviewRun>[1] = {};
  if (delivery.status !== undefined) {
    updates.platform_status = delivery.status || null;
  }
  if (delivery.statusDeliveryStatus !== undefined) {
    updates.platform_status_delivery_status = delivery.statusDeliveryStatus;
  }
  if (delivery.commentDeliveryStatus !== undefined) {
    updates.platform_comment_delivery_status = delivery.commentDeliveryStatus;
  }
  if (delivery.commentId !== undefined) {
    updates.platform_comment_id = delivery.commentId || null;
  }
  if (delivery.commentUrl !== undefined) {
    updates.platform_comment_url = delivery.commentUrl || null;
  }
  if (delivery.error) {
    updates.last_delivery_error = delivery.error;
  } else if (
    delivery.statusDeliveryStatus === 'delivered' ||
    delivery.statusDeliveryStatus === 'skipped' ||
    delivery.commentDeliveryStatus === 'delivered' ||
    delivery.commentDeliveryStatus === 'skipped'
  ) {
    updates.last_delivery_error = null;
  }
  if (
    delivery.statusDeliveryStatus === 'failed' ||
    delivery.commentDeliveryStatus === 'failed'
  ) {
    updates.delivery_retry_count = bumpDeliveryRetryCount(run);
  }
  return normalizeRunRecord(await updateReviewRun(run.id, updates));
}

async function resolveRemoteReviewBaseline(input: {
  repository: ReviewRepositoryRecord;
  stage: ReviewStage;
  branch: string;
  headSha: string;
  parentSha?: string;
  eventBaseSha?: string;
  defaultBranch?: string;
  manualReview?: RepoReviewManualReviewOptions;
  selectedBaselineRun?: ReviewRunRecord | null;
}): Promise<{
  baseSha: string;
  baselineSource: string;
  baseBranch: string;
  baselineRef?: string;
  baselineLabel?: string;
  branchState?: ReviewBranchStateRecord;
}> {
  const branchState = await getReviewBranchState({
    repositoryId: input.repository.id,
    stage: input.stage,
    branch: input.branch,
  });
  const manualReview = input.manualReview || {};
  const baselineMode = normalizeManualReviewBaselineMode(
    manualReview.baselineMode,
  );
  const reviewMode = normalizeManualReviewMode(manualReview.reviewMode);
  const eventBaseSha = stringValue(input.eventBaseSha);
  if (eventBaseSha && eventBaseSha !== input.headSha) {
    return {
      baseSha: eventBaseSha,
      baselineSource: 'event-base-sha',
      baseBranch: input.branch,
      baselineRef: shortSha(eventBaseSha),
      baselineLabel: t(
        'repoReview.explicitBaseline',
        { sha: shortSha(eventBaseSha) },
        undefined,
      ),
      branchState,
    };
  }
  if (
    baselineMode === 'history_run' &&
    input.selectedBaselineRun?.head_sha &&
    input.selectedBaselineRun.head_sha !== input.headSha
  ) {
    return {
      baseSha: input.selectedBaselineRun.head_sha,
      baselineSource: 'manual-history-run-head',
      baseBranch: input.branch,
      baselineRef: shortSha(input.selectedBaselineRun.head_sha),
      baselineLabel: t(
        'repoReview.historicalReviewPoint',
        { sha: shortSha(input.selectedBaselineRun.head_sha) },
        undefined,
      ),
      branchState,
    };
  }
  if (
    baselineMode === 'commit_sha' &&
    stringValue(manualReview.baselineSha) &&
    stringValue(manualReview.baselineSha) !== input.headSha
  ) {
    return {
      baseSha: stringValue(manualReview.baselineSha),
      baselineSource: 'manual-selected-commit',
      baseBranch: input.branch,
      baselineRef: shortSha(stringValue(manualReview.baselineSha)),
      baselineLabel: t(
        'repoReview.specifiedCommit',
        { sha: shortSha(stringValue(manualReview.baselineSha)) },
        undefined,
      ),
      branchState,
    };
  }
  if (
    baselineMode === 'last_reviewed' &&
    branchState?.baseline_sha &&
    branchState.baseline_sha !== input.headSha
  ) {
    return {
      baseSha: branchState.baseline_sha,
      baselineSource: 'manual-last-baseline',
      baseBranch: input.branch,
      baselineRef: shortSha(branchState.baseline_sha),
      baselineLabel: t(
        'repoReview.lastBaseline',
        { sha: shortSha(branchState.baseline_sha) },
        undefined,
      ),
      branchState,
    };
  }
  if (
    reviewMode !== 'full' &&
    baselineMode === 'auto' &&
    branchState?.head_sha &&
    branchState.head_sha !== input.headSha &&
    branchState.result_state !== 'error' &&
    branchState.result_state !== 'queued' &&
    branchState.result_state !== 'running'
  ) {
    return {
      baseSha: branchState.head_sha,
      baselineSource: 'branch-last-reviewed-head',
      baseBranch: input.branch,
      baselineRef: shortSha(branchState.head_sha),
      baselineLabel: t(
        'repoReview.recentlyReviewedCommit',
        { sha: shortSha(branchState.head_sha) },
        undefined,
      ),
      branchState,
    };
  }
  const defaultBranch =
    normalizeBranchName(input.defaultBranch || '') ||
    normalizeBranchName(
      await fetchRemoteRepositoryDefaultBranch(input.repository),
    ) ||
    normalizeBranchName(input.repository.default_target_branch || '') ||
    'main';
  if (
    (reviewMode === 'full' ||
      baselineMode === 'default_branch' ||
      baselineMode === 'auto') &&
    defaultBranch &&
    defaultBranch !== input.branch
  ) {
    const defaultHead = await fetchRemoteBranchHead(
      input.repository,
      defaultBranch,
    );
    if (defaultHead.headSha && defaultHead.headSha !== input.headSha) {
      return {
        baseSha: defaultHead.headSha,
        baselineSource:
          reviewMode === 'full' || baselineMode === 'default_branch'
            ? 'manual-default-branch-head'
            : 'default-branch-head',
        baseBranch: defaultBranch,
        baselineRef: shortSha(defaultHead.headSha),
        baselineLabel:
          reviewMode === 'full'
            ? t(
                'repoReview.overallBaselineLabel',
                { branch: defaultBranch, sha: shortSha(defaultHead.headSha) },
                undefined,
              )
            : `${defaultBranch}@${shortSha(defaultHead.headSha)}`,
        branchState,
      };
    }
  }
  const parentSha = stringValue(input.parentSha);
  if (
    (baselineMode === 'parent_commit' || baselineMode === 'auto') &&
    parentSha &&
    parentSha !== input.headSha
  ) {
    return {
      baseSha: parentSha,
      baselineSource:
        baselineMode === 'parent_commit'
          ? 'manual-parent-commit'
          : 'parent-commit',
      baseBranch: input.branch,
      baselineRef: shortSha(parentSha),
      baselineLabel: t(
        'repoReview.parentCommit',
        { sha: shortSha(parentSha) },
        undefined,
      ),
      branchState,
    };
  }
  return {
    baseSha: '',
    baselineSource: '',
    baseBranch: defaultBranch,
    branchState,
  };
}

function computeReviewIdempotencyKey(
  repositoryId: string,
  profileId: string,
  event: RepoReviewEvent,
): string {
  if (event.source === 'local-hook') return '';
  return buildRemoteReviewIdempotencyKey({
    event: {
      ...event,
      repositoryId,
    },
    profileId,
  });
}

function buildEffectiveRulesSnapshot(
  repository: RepoReviewRepository,
  profile: RepoReviewProfile,
): Record<string, unknown> {
  return {
    repository: {
      id: repository.id,
      name: repository.name,
      language: repository.language,
      defaultTargetBranch: repository.defaultTargetBranch,
      reviewChatJid: repository.reviewChatJid,
    },
    profile: {
      id: profile.id,
      name: profile.name,
      stage: profile.stage,
      sourceMode: profile.sourceMode,
      blockingMode: profile.blockingMode,
      passDecisionMode: profile.passDecisionMode,
      reviewScope: profile.reviewScope,
      targetBranches: profile.targetBranches,
      skillIds: profile.skillIds,
      mcpServerIds: profile.mcpServerIds,
      includeGlobs: profile.includeGlobs,
      excludeGlobs: profile.excludeGlobs,
      includeFullFileContext: profile.includeFullFileContext,
      maxFiles: profile.maxFiles,
      maxDiffBytes: profile.maxDiffBytes,
      writeToChat: profile.writeToChat,
      writeToPlatform: profile.writeToPlatform,
      promptTemplate: profile.promptTemplate,
    },
  };
}

async function resolveBaselineSource(
  event: RepoReviewEvent,
  profile?: RepoReviewProfile | null,
): Promise<string> {
  const callbackContext = asRecord(event.callbackContext);
  const explicit = stringValue(callbackContext.baselineSource);
  if (explicit) return explicit;
  if (event.prMrNumber) return 'pr_compare';
  if (event.source === 'local-hook') {
    return profile?.reviewScope === 'staged_diff'
      ? 'staged_diff'
      : 'local_compare';
  }
  const branch = normalizeBranchName(event.branch || event.ref || '');
  if (branch) {
    const previousState = await getReviewBranchState({
      repositoryId: event.repositoryId,
      stage: event.stage,
      branch,
    });
    if (
      previousState?.head_sha &&
      previousState.head_sha === stringValue(event.baseSha)
    ) {
      return 'previous_reviewed_head';
    }
  }
  return event.baseSha ? 'compare' : '';
}

function summarizeBlockingFromRun(run: RepoReviewRun): boolean {
  return (
    run.blockingEnforced ||
    run.resultState === 'manual_failed' ||
    run.resultState === 'failed'
  );
}

function buildRepoReviewExecutionSummary(
  run: RepoReviewRun,
  options: {
    reused?: boolean;
    reuseReason?: string;
    usedCachedBranchSummary?: boolean;
  } = {},
): RepoReviewExecutionSummary {
  return {
    run,
    allowed: !summarizeBlockingFromRun(run),
    blocking: summarizeBlockingFromRun(run),
    reused: options.reused,
    reuseReason: options.reuseReason,
    usedCachedBranchSummary: options.usedCachedBranchSummary,
  };
}

async function findRepositoryByLocalPath(
  repoPath: string,
): Promise<ReviewRepositoryRecord | undefined> {
  const target = path.resolve(repoPath);
  return (await listReviewRepositories()).find((repository) => {
    if (!repository.local_repo_path) return false;
    return path.resolve(repository.local_repo_path) === target;
  });
}

function resolveReviewRunUserId(event: RepoReviewEvent): string | undefined {
  const direct = stringValue(event.userId);
  if (direct) return direct;
  const ctx = event.callbackContext ? asRecord(event.callbackContext) : {};
  const fromCtx = stringValue(ctx.userId) || stringValue(ctx.user_id);
  return fromCtx || undefined;
}

async function executeRepoReviewEvent(
  event: RepoReviewEvent,
  existingRunId?: string,
  options: {
    skipIdempotencyReuse?: boolean;
  } = {},
): Promise<RepoReviewExecutionSummary> {
  const tenantUserId = resolveReviewRunUserId(event) ?? SYSTEM_USER_ID;
  return runWithTenant({ userId: tenantUserId }, async () => {
    const repositoryRecord = await requireRepository(event.repositoryId);
    if (repositoryRecord.enabled !== 1) {
      throw new Error(`Review repository is disabled: ${event.repositoryId}`);
    }
    const repository = await normalizeRepositoryRecord(repositoryRecord);
    const profileRecord = await selectMatchingProfileRecord(
      repositoryRecord,
      event,
    );
    const candidateProfile = profileRecord
      ? profileRecord.enabled === 1
        ? await normalizeProfileRecord(profileRecord)
        : null
      : null;
    const idempotencyKey = computeReviewIdempotencyKey(
      event.repositoryId,
      profileRecord?.id || stringValue(event.profileId),
      event,
    );
    const existingRunRecord = await getReviewRunByIdempotencyKey({
      repositoryId: event.repositoryId,
      idempotencyKey,
    });
    if (
      idempotencyKey &&
      existingRunRecord &&
      existingRunRecord.id !== existingRunId &&
      !options.skipIdempotencyReuse
    ) {
      if (!shouldReuseIdempotentRun(existingRunRecord)) {
        await updateReviewRun(existingRunRecord.id, {
          idempotency_key: null,
        });
      } else {
        const existingRun = await normalizeRunRecord(existingRunRecord);
        return buildRepoReviewExecutionSummary(existingRun, {
          reused: true,
          reuseReason: '相同提交范围的审查已存在，本次复用已有运行。',
        });
      }
    }
    const baselineSource = await resolveBaselineSource(event, candidateProfile);
    const effectiveRules = candidateProfile
      ? buildEffectiveRulesSnapshot(repository, candidateProfile)
      : {};
    const shouldWriteToChat = Boolean(candidateProfile?.writeToChat);
    const shouldWriteToPlatform =
      Boolean(candidateProfile?.writeToPlatform) &&
      event.source !== 'local-hook' &&
      Boolean(repositoryRecord.remote_provider);

    let runRecord: ReviewRunRecord;
    if (existingRunId) {
      const existingRunRecord = await getReviewRunById(existingRunId);
      if (!existingRunRecord) {
        throw new Error(`Queued review run not found: ${existingRunId}`);
      }
      runRecord = existingRunRecord;
    } else {
      try {
        runRecord = await createReviewRun({
          id: `review-run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          repository_id: event.repositoryId,
          profile_id: profileRecord?.id || null,
          idempotency_key: idempotencyKey,
          source: event.source,
          stage: event.stage,
          status: 'queued',
          baseline_source: baselineSource || null,
          result_state: 'queued',
          ref: event.ref || null,
          branch: event.branch || null,
          base_sha: event.baseSha || null,
          head_sha: event.headSha || null,
          pr_mr_number: event.prMrNumber || null,
          actor: event.actor || null,
          effective_rules: effectiveRules,
          userId: resolveReviewRunUserId(event),
          callback_context: event.callbackContext || null,
        });
      } catch (err) {
        if (
          idempotencyKey &&
          isDuplicateKeyError(err) &&
          !options.skipIdempotencyReuse
        ) {
          const raceRecord = await getReviewRunByIdempotencyKey({
            repositoryId: event.repositoryId,
            idempotencyKey,
          });
          if (raceRecord && shouldReuseIdempotentRun(raceRecord)) {
            const raceRun = await normalizeRunRecord(raceRecord);
            return buildRepoReviewExecutionSummary(raceRun, {
              reused: true,
              reuseReason: '相同提交范围的审查已存在，本次复用已有运行。',
            });
          }
        }
        throw err;
      }
    }
    let reviewTurns: RepoReviewAssistantTurn[] = [];
    let executionStats: RepoReviewExecutionStats | undefined;
    let runCallbackContext = asRecord(
      (await parseReviewRunRecord(runRecord)).callbackContext,
    );
    let progressSteps =
      normalizeRepoReviewProgressSnapshot(
        asRecord(runCallbackContext).reviewProgress,
      )?.steps || [];
    let reviewRunTerminal = false;
    const REPO_REVIEW_PROGRESS_PERSIST_DEBOUNCE_MS = 750;
    let persistReviewProgressQueue: Promise<void> = Promise.resolve();
    let persistReviewProgressTimer: NodeJS.Timeout | null = null;
    let pendingPersistPatch: Record<string, unknown> = {};
    let pendingPersistIncludeFullTurns = false;
    let pendingPersistForce = false;
    let lastPersistedProgressSnapshot = '';
    const buildReviewProgressContext = (
      patch: Record<string, unknown> = {},
      options: { includeFullTurns?: boolean } = {},
    ) => {
      const reviewProgress = buildRepoReviewProgressSnapshot(
        reviewTurns,
        progressSteps,
        { runTerminal: reviewRunTerminal },
      );
      const persistedReviewTurns =
        (options.includeFullTurns ?? reviewRunTerminal)
          ? reviewTurns
          : buildIntermediateRepoReviewProgressTurns(reviewTurns);
      const nextContext = mergeCallbackContext(runCallbackContext, {
        ...patch,
        reviewTurns: persistedReviewTurns,
        reviewProgress,
        ...(executionStats ? { executionStats } : {}),
      });
      if (executionStats) {
        executionStats.progressSnapshotBytes = Math.max(
          executionStats.progressSnapshotBytes,
          getRepoReviewJsonBytes(nextContext),
        );
      }
      return nextContext;
    };
    const persistReviewProgressNow = async (
      patch: Record<string, unknown> = {},
      options: { includeFullTurns?: boolean; force?: boolean } = {},
    ): Promise<void> => {
      runCallbackContext = buildReviewProgressContext(patch, options);
      const serialized = JSON.stringify(runCallbackContext);
      if (!options.force && serialized === lastPersistedProgressSnapshot) {
        return;
      }
      await updateReviewRun(runRecord.id, {
        callback_context: runCallbackContext,
      });
      lastPersistedProgressSnapshot = serialized;
    };
    const flushPersistReviewProgress = async (): Promise<void> => {
      if (persistReviewProgressTimer) {
        clearTimeout(persistReviewProgressTimer);
        persistReviewProgressTimer = null;
      }
      const patch = pendingPersistPatch;
      const includeFullTurns = pendingPersistIncludeFullTurns;
      const force = pendingPersistForce;
      pendingPersistPatch = {};
      pendingPersistIncludeFullTurns = false;
      pendingPersistForce = false;
      const nextPersist = persistReviewProgressQueue.then(() =>
        persistReviewProgressNow(patch, { includeFullTurns, force }),
      );
      persistReviewProgressQueue = nextPersist.catch(() => undefined);
      await nextPersist;
    };
    const persistReviewProgress = async (
      patch: Record<string, unknown> = {},
      options: { flush?: boolean; includeFullTurns?: boolean; force?: boolean } = {},
    ): Promise<void> => {
      pendingPersistPatch = mergeCallbackContext(pendingPersistPatch, patch);
      pendingPersistIncludeFullTurns =
        pendingPersistIncludeFullTurns || Boolean(options.includeFullTurns);
      pendingPersistForce = pendingPersistForce || Boolean(options.force);
      if (options.flush) {
        await flushPersistReviewProgress();
        return;
      }
      if (persistReviewProgressTimer) return;
      persistReviewProgressTimer = setTimeout(() => {
        persistReviewProgressTimer = null;
        void flushPersistReviewProgress().catch((err) => {
          logger.warn(
            { err, runId: runRecord.id },
            'Failed to persist repo review progress snapshot',
          );
        });
      }, REPO_REVIEW_PROGRESS_PERSIST_DEBOUNCE_MS);
      persistReviewProgressTimer.unref?.();
    };
    const setProgressStep = async (
      id: string,
      label: string,
      status: RepoReviewProgressStep['status'],
      detail?: string,
      error?: string,
      extra?: {
        kind?: RepoReviewProgressStepKind;
        inputText?: string;
        outputText?: string;
        metadataText?: string;
      },
    ): Promise<void> => {
      progressSteps = upsertRepoReviewProgressStep(progressSteps, {
        id,
        label,
        kind: extra?.kind,
        status,
        detail,
        inputText: extra?.inputText,
        outputText: extra?.outputText,
        metadataText: extra?.metadataText,
        error,
      });
      await persistReviewProgress();
    };
    const failPendingProgressSteps = async (error: string): Promise<void> => {
      const pendingSteps = progressSteps.filter(
        (step) => step.status === 'running' || step.status === 'queued',
      );
      if (pendingSteps.length === 0) return;
      for (const step of pendingSteps) {
        progressSteps = upsertRepoReviewProgressStep(progressSteps, {
          id: step.id,
          label: step.label,
          kind: step.kind,
          status: 'failed',
          detail: step.detail,
          inputText: step.inputText,
          outputText: step.outputText,
          metadataText: step.metadataText,
          error,
        });
      }
      await persistReviewProgress();
    };
    await setProgressStep(
      'queued',
      '任务已入队',
      'completed',
      existingRunId ? '复用已入队的远端审查运行' : '已创建审查运行记录',
      undefined,
      {
        kind: 'stage',
        inputText: formatProgressKeyValues([
          ['repository_id', repositoryRecord.id],
          ['stage', event.stage],
          ['source', event.source],
          ['branch', event.branch || '-'],
          ['head_sha', stringValue(event.headSha) || '-'],
        ]),
        outputText: existingRunId
          ? '复用已存在的远端审查运行。'
          : '已创建新的审查运行记录。',
        metadataText: idempotencyKey
          ? formatProgressKeyValues([['idempotency_key', idempotencyKey]])
          : undefined,
      },
    );
    const queuedRun = await normalizeRunRecord(runRecord);
    await updateBranchStateFromRun(queuedRun);
    await updateReviewRun(runRecord.id, {
      chat_delivery_status: shouldWriteToChat ? 'pending' : 'skipped',
      platform_status_delivery_status: shouldWriteToPlatform
        ? 'pending'
        : 'skipped',
      platform_comment_delivery_status:
        shouldWriteToPlatform && event.prMrNumber ? 'pending' : 'skipped',
    });
    const startedAtIso = new Date().toISOString();

    if (!profileRecord || profileRecord.enabled !== 1) {
      await setProgressStep(
        'select_profile',
        '匹配审查 Profile',
        'skipped',
        '没有启用的审查 profile 匹配此事件',
      );
      reviewRunTerminal = true;
      progressSteps = repairTerminalRepoReviewProgressSteps(
        progressSteps,
        'skipped',
      );
      await persistReviewProgress({}, {
        flush: true,
        includeFullTurns: true,
        force: true,
      });
      const updated = await updateReviewRun(runRecord.id, {
        status: 'skipped',
        result_state: 'skipped',
        overall: 'skipped',
        summary: '没有启用的审查 profile 匹配此事件，已跳过审查。',
        callback_context: runCallbackContext,
        completed_at: startedAtIso,
      });
      const normalized = await normalizeRunRecord(updated);
      await updateBranchStateFromRun(normalized);
      return buildRepoReviewExecutionSummary(normalized);
    }

    const profile = await normalizeProfileRecord(profileRecord);
    const reviewUserId = resolveReviewRunUserId(event);
    await setProgressStep(
      'select_profile',
      '匹配审查 Profile',
      'completed',
      profile.name,
      undefined,
      {
        kind: 'stage',
        inputText: formatProgressKeyValues([
          ['stage', event.stage],
          ['source', event.source],
          ['branch', event.branch || '-'],
        ]),
        outputText: formatProgressKeyValues([
          ['profile', profile.name],
          ['review_scope', profile.reviewScope],
          ['blocking_mode', profile.blockingMode],
        ]),
      },
    );
    await setProgressStep(
      'mark_running',
      '运行状态落库',
      'running',
      undefined,
      undefined,
      {
        kind: 'stage',
        inputText: formatProgressKeyValues([
          ['run_id', runRecord.id],
          ['next_status', 'running'],
          ['started_at', startedAtIso],
        ]),
      },
    );
    await updateReviewRun(runRecord.id, {
      status: 'running',
      result_state: 'running',
      started_at: startedAtIso,
    });
    await setProgressStep(
      'mark_running',
      '运行状态落库',
      'completed',
      undefined,
      undefined,
      {
        kind: 'stage',
        outputText: formatProgressKeyValues([
          ['status', 'running'],
          ['result_state', 'running'],
        ]),
      },
    );
    {
      const runningRecord = await getReviewRunById(runRecord.id);
      if (!runningRecord) {
        throw new Error(
          `Review run missing after status update: ${runRecord.id}`,
        );
      }
      await updateBranchStateFromRun(await normalizeRunRecord(runningRecord));
    }
    let remoteWorkspacePath: string | null = null;
    let reviewWorkspacePath: string | null =
      event.source === 'local-hook'
        ? repositoryRecord.local_repo_path || null
        : null;
    const wtBranch = normalizeBranchName(event.branch || '');
    if (event.source === 'local-hook') {
      await setProgressStep(
        'acquire_worktree',
        '准备 Review Worktree',
        'skipped',
        '本地 hook 审查直接使用本地仓库，以保留暂存区状态',
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['source', event.source],
            ['local_repo_path', repositoryRecord.local_repo_path || '-'],
          ]),
          outputText: '本地 hook 审查直接复用本地仓库工作区。',
        },
      );
    } else if (wtBranch) {
      await setProgressStep(
        'acquire_worktree',
        '准备 Review Worktree',
        'running',
        `分支 ${wtBranch}`,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['branch', wtBranch],
            ['checkout_ref', stringValue(event.headSha) || '-'],
            ['clone_url', repositoryRecord.clone_url || '-'],
            ['purpose', 'review'],
          ]),
        },
      );
      try {
        const acquiredWorktreePath = await acquireWorktree({
          repositoryId: repositoryRecord.id,
          branch: wtBranch,
          cloneUrl: repositoryRecord.clone_url || undefined,
          checkoutRef: stringValue(event.headSha) || undefined,
          purpose: 'review',
        });
        reviewWorkspacePath = acquiredWorktreePath || null;
        await setProgressStep(
          'acquire_worktree',
          '准备 Review Worktree',
          acquiredWorktreePath ? 'completed' : 'skipped',
          acquiredWorktreePath
            ? `复用持久 worktree：${acquiredWorktreePath}`
            : '持久 worktree 不可用，将尝试临时工作区兜底',
          undefined,
          {
            kind: 'stage',
            outputText: acquiredWorktreePath
              ? formatProgressKeyValues([
                  ['workspace_path', acquiredWorktreePath],
                  ['mode', 'persistent_worktree'],
                ])
              : '持久 Review Worktree 不可用，转入临时远端工作区兜底。',
          },
        );
      } catch (err) {
        await setProgressStep(
          'acquire_worktree',
          '准备 Review Worktree',
          'failed',
          `分支 ${wtBranch}`,
          errorMessageForProgress(err),
          {
            kind: 'stage',
            outputText: '持久 Review Worktree 获取失败。',
          },
        );
        logger.warn(
          { err, repositoryId: repositoryRecord.id, branch: wtBranch },
          'Failed to create review worktree before review start',
        );
      }
    } else {
      await setProgressStep(
        'acquire_worktree',
        '准备 Review Worktree',
        'skipped',
        '没有可用分支名',
        undefined,
        {
          kind: 'stage',
          outputText: '当前事件未提供可用分支名，跳过持久 worktree 获取。',
        },
      );
    }

    if (event.source === 'local-hook') {
      await setProgressStep(
        'prepare_remote_workspace',
        '准备临时远端工作区',
        'skipped',
        '本地 hook 审查直接使用本地仓库',
        undefined,
        {
          kind: 'stage',
          outputText: '本地 hook 场景不创建临时远端工作区。',
        },
      );
    } else if (reviewWorkspacePath) {
      await setProgressStep(
        'prepare_remote_workspace',
        '准备临时远端工作区',
        'skipped',
        '已复用持久 Review Worktree',
        undefined,
        {
          kind: 'stage',
          outputText: formatProgressKeyValues([
            ['workspace_path', reviewWorkspacePath],
            ['mode', 'persistent_worktree_reused'],
          ]),
        },
      );
    } else {
      await setProgressStep(
        'prepare_remote_workspace',
        '准备临时远端工作区',
        'running',
        `分支 ${wtBranch || '-'}`,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['branch', wtBranch || '-'],
            ['base_sha', stringValue(event.baseSha) || '-'],
            ['head_sha', stringValue(event.headSha) || '-'],
          ]),
        },
      );
      remoteWorkspacePath = await prepareRemoteWorkspace(
        repositoryRecord,
        wtBranch,
        stringValue(event.headSha),
        stringValue(event.baseSha),
      );
      reviewWorkspacePath = remoteWorkspacePath;
      await setProgressStep(
        'prepare_remote_workspace',
        '准备临时远端工作区',
        remoteWorkspacePath ? 'completed' : 'skipped',
        remoteWorkspacePath
          ? '临时远端工作区已准备完成'
          : '远端工作区不可用，回退为 diff-only 审查',
        undefined,
        {
          kind: 'stage',
          outputText: remoteWorkspacePath
            ? formatProgressKeyValues([
                ['workspace_path', remoteWorkspacePath],
                ['mode', 'temporary_remote_workspace'],
              ])
            : '远端工作区不可用，将仅基于 diff 和上下文继续审查。',
        },
      );
    }

    try {
      throwIfRepoReviewRunCancelled(runRecord.id);
      await setProgressStep(
        'prepare_context',
        '解析 Diff 与提交上下文',
        'running',
        undefined,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['base_sha', stringValue(event.baseSha) || '-'],
            ['head_sha', stringValue(event.headSha) || '-'],
            ['branch', event.branch || '-'],
            ['source', event.source],
          ]),
        },
      );
      const prepared = await prepareReviewContext(repository, profile, event);
      await setProgressStep(
        'prepare_context',
        '解析 Diff 与提交上下文',
        'completed',
        `${prepared.changedFiles.length} 个变更文件`,
        undefined,
        {
          kind: 'stage',
          outputText: formatProgressKeyValues([
            ['changed_files', prepared.changedFiles.length],
            ['commit_summary_lines', prepared.commitSummaryLines.length],
            ['commit_details', prepared.commitDetails.length],
          ]),
          metadataText: formatProgressKeyValues([
            ['changed_files', prepared.changedFiles.join(', ') || '-'],
          ]),
        },
      );
      throwIfRepoReviewRunCancelled(runRecord.id);
      const runDurationMs = () => Date.now() - Date.parse(startedAtIso);
      if (prepared.overall && prepared.summary) {
        throwIfRepoReviewRunCancelled(runRecord.id);
        await setProgressStep(
          'persist_result',
          '保存审查结果',
          'running',
          '无需 AI 审查的快速结果',
        );
        const resultState = computeRunResultState({
          profile,
          status: prepared.overall === 'skipped' ? 'skipped' : 'completed',
          overall: prepared.overall,
          blocking: false,
        });
        runCallbackContext = mergeCallbackContext(runCallbackContext, {
          commitSummaryLines: prepared.commitSummaryLines,
          commitDetails: prepared.commitDetails,
        });
        reviewRunTerminal = true;
        progressSteps = repairTerminalRepoReviewProgressSteps(
          progressSteps,
          prepared.overall === 'skipped' ? 'skipped' : 'completed',
        );
        await persistReviewProgress({}, {
          flush: true,
          includeFullTurns: true,
          force: true,
        });
        const updated = await updateReviewRun(runRecord.id, {
          status: prepared.overall === 'skipped' ? 'skipped' : 'completed',
          baseline_source: baselineSource || null,
          result_state: resultState,
          overall: prepared.overall,
          actor: prepared.actor,
          summary: prepared.summary,
          changed_files: prepared.changedFiles,
          diff_bytes: Buffer.byteLength(prepared.diffText || '', 'utf8'),
          duration_ms: runDurationMs(),
          callback_context: runCallbackContext,
          completed_at: new Date().toISOString(),
        });
        let normalized = await normalizeRunRecord(updated);
        if (profile.writeToChat) {
          normalized = await publishRepoReviewCompletionMessage({
            repository,
            run: normalized,
            decisionMode: profile.passDecisionMode,
            diffText: prepared.diffText,
            reviewOutputMode: profile.reviewOutputMode,
          });
        }
        await updateBranchStateFromRun(normalized);
        await setProgressStep('persist_result', '保存审查结果', 'completed');
        return {
          run: normalized,
          allowed: true,
          blocking: false,
        };
      }

      runCallbackContext = mergeCallbackContext(runCallbackContext, {
        commitSummaryLines: prepared.commitSummaryLines,
        commitDetails: prepared.commitDetails,
      });
      await updateReviewRun(runRecord.id, {
        actor: prepared.actor,
        changed_files: prepared.changedFiles,
        diff_bytes: Buffer.byteLength(prepared.diffText, 'utf8'),
        callback_context: runCallbackContext,
      });
      if (
        profile.writeToChat &&
        shouldPublishRepoReviewStartedMessage(repository)
      ) {
        await setProgressStep(
          'publish_started_message',
          '发送开始通知',
          'running',
          undefined,
          undefined,
          {
            kind: 'stage',
            inputText: formatProgressKeyValues([
              ['write_to_chat', profile.writeToChat],
              ['stage', profile.stage],
              ['source', event.source],
            ]),
          },
        );
        const startedRunRecord = await getReviewRunById(runRecord.id);
        if (!startedRunRecord) {
          throw new Error(`Review run missing after start: ${runRecord.id}`);
        }
        applyRunChatDeliveryResult(
          await normalizeRunRecord(startedRunRecord),
          await publishReviewMessage({
            repository,
            runId: runRecord.id,
            content: formatRepoReviewStartedMessage({
              repository,
              profile,
              event,
              prepared,
            }),
          }),
        );
        await setProgressStep(
          'publish_started_message',
          '发送开始通知',
          'completed',
          undefined,
          undefined,
          {
            kind: 'stage',
            outputText: '开始通知已发送。',
          },
        );
      } else {
        await setProgressStep(
          'publish_started_message',
          '发送开始通知',
          'skipped',
          'Profile 未启用开始通知',
          undefined,
          {
            kind: 'stage',
            outputText: '当前 Profile 未启用开始通知。',
          },
        );
      }
      executionStats = buildInitialRepoReviewExecutionStats({
        diffText: prepared.diffText,
        changedFiles: prepared.changedFiles,
        evidenceBundle: prepared.evidenceBundle,
      });
      const activeExecutionStats = executionStats;
      const maxWorkerCount = await resolveRepoReviewMaxSubagents();
      await persistReviewProgress();
      await setProgressStep(
        'prepare_review_evidence',
        '准备 Review Evidence',
        'completed',
        `${prepared.changedFiles.length} 个文件，diff ${Buffer.byteLength(prepared.diffText, 'utf8')} bytes`,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['changed_files', prepared.changedFiles.join(', ') || '-'],
            ['diff_bytes', Buffer.byteLength(prepared.diffText, 'utf8')],
            ['workspace_path', reviewWorkspacePath || '-'],
            [
              'full_file_context_mode',
              profile.includeFullFileContext ? 'lazy' : 'disabled',
            ],
            [
              'codemap_status',
              activeExecutionStats.codeMapContextStatus || 'unknown',
            ],
            [
              'codeindex_status',
              activeExecutionStats.codeIndexContextStatus || 'unknown',
            ],
          ]),
          outputText: formatProgressKeyValues([
            ['prepared_files', prepared.changedFiles.length],
            ['diff_bytes', Buffer.byteLength(prepared.diffText, 'utf8')],
            [
              'evidence_bundle_bytes',
              activeExecutionStats.evidenceBundleBytes || 0,
            ],
            [
              'changed_functions',
              activeExecutionStats.changedFunctionCount || 0,
            ],
          ]),
        },
      );
      let parsed: ParsedReviewResult | null = null;
      let finalReview: {
        overall: ReviewOverall;
        summary: string;
        findings: RepoReviewRunFinding[];
        fileReviews: RepoReviewFileReview[];
        scopeLimitations: string[];
        suggestions: string[];
        recommendedBlock: boolean;
      } | null = null;
      const coordinatedReview = await runRepoReviewGraphCoordinator({
        repository,
        profile,
        event,
        prepared,
        runId: runRecord.id,
        workspacePath: reviewWorkspacePath,
        userId: reviewUserId,
        maxWorkerCount,
        executionStats: activeExecutionStats,
        onTurnProgress: async (turnGroups) => {
          reviewTurns = turnGroups.flat();
          activeExecutionStats.extraRepoReadCount = countRepoReviewToolCalls(
            reviewTurns,
            'read_file',
          );
          activeExecutionStats.subagentToolCallCount = countRepoReviewToolCalls(
            reviewTurns.filter((turn) => turn.phase === 'worker'),
            'read_file',
          );
          activeExecutionStats.mainReadonlyToolCallCount =
            countRepoReviewToolCalls(
              reviewTurns.filter(
                (turn) =>
                  turn.phase === 'main_agent_review' ||
                  turn.phase === 'main_agent_fallback_review',
              ),
              'read_file',
            );
          await persistReviewProgress();
        },
        onProgressStep: async (step) => {
          await setProgressStep(
            step.id,
            step.label,
            step.status,
            step.detail,
            step.error,
            {
              kind: step.kind,
              inputText: step.inputText,
              outputText: step.outputText,
              metadataText: step.metadataText,
            },
          );
        },
      });
      throwIfRepoReviewRunCancelled(runRecord.id);
      reviewTurns = coordinatedReview.reviewTurns;
      parsed = coordinatedReview.parsed;
      const hydratedFindings = await hydrateRepoReviewFindingSnippets({
        findings: parsed.findings,
        prepared,
        workspacePath: reviewWorkspacePath,
      });
      finalReview = {
        overall: parsed.overall,
        summary: parsed.summary,
        findings: hydratedFindings,
        fileReviews: parsed.fileReviews,
        scopeLimitations: parsed.scopeLimitations,
        suggestions: parsed.suggestions,
        recommendedBlock: parsed.recommendedBlock,
      };
      const finalMarkdownBody =
        stringValue(parsed.markdownBody) ||
        buildStructuredRepoReviewMarkdown(
          {
            summary: finalReview.summary,
            findings: finalReview.findings,
            fileReviews: finalReview.fileReviews,
            commitReviews: parsed.commitReviews,
            suggestions: finalReview.suggestions,
          } as unknown as Pick<
            RepoReviewRun,
            'summary' | 'findings' | 'commitReviews' | 'suggestions'
          >,
          {
            repositoryName: repository.name,
            branch: prepared.branch,
            baseSha: prepared.baseSha,
            headSha: prepared.headSha,
            actor: prepared.actor,
            stage: event.stage,
            prMrNumber: event.prMrNumber,
            scopeLimitations: finalReview.scopeLimitations,
          },
        );
      const blocking = computeBlocking(
        profile,
        finalReview.overall,
        finalReview.recommendedBlock,
      );
      const resultState = computeRunResultState({
        profile,
        status: 'completed',
        overall: finalReview.overall,
        blocking,
      });
      reviewRunTerminal = true;
      await setProgressStep('persist_result', '保存审查结果', 'running');
      progressSteps = upsertRepoReviewProgressStep(progressSteps, {
        id: 'persist_result',
        label: '保存审查结果',
        status: 'completed',
      });
      progressSteps = repairTerminalRepoReviewProgressSteps(
        progressSteps,
        'completed',
      );
      await persistReviewProgress(
        {
          commitSummaryLines: prepared.commitSummaryLines,
          commitDetails: prepared.commitDetails,
          scopeLimitations: finalReview.scopeLimitations,
          fileReviews: finalReview.fileReviews,
          commitReviews: parsed.commitReviews,
        },
        {
          flush: true,
          includeFullTurns: true,
          force: true,
        },
      );
      const updated = await updateReviewRun(runRecord.id, {
        status: 'completed',
        baseline_source: baselineSource || null,
        result_state: resultState,
        overall: finalReview.overall,
        recommended_block: finalReview.recommendedBlock,
        blocking_enforced: blocking,
        summary: finalReview.summary,
        findings: finalReview.findings,
        file_reviews: finalReview.fileReviews,
        commit_reviews: parsed.commitReviews,
        suggestions: finalReview.suggestions,
        changed_files: prepared.changedFiles,
        markdown_body: finalMarkdownBody,
        raw_model_output: parsed.rawModelOutput || null,
        diff_bytes: Buffer.byteLength(prepared.diffText, 'utf8'),
        duration_ms: runDurationMs(),
        callback_context: runCallbackContext,
        completed_at: new Date().toISOString(),
      });
      let normalized = await normalizeRunRecord(updated);
      await setProgressStep(
        'persist_result',
        '保存审查结果',
        'completed',
        undefined,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['overall', finalReview.overall],
            ['blocking', blocking],
            ['changed_files', prepared.changedFiles.length],
          ]),
          outputText: formatProgressKeyValues([
            ['result_state', resultState],
            ['summary', finalReview.summary],
          ]),
        },
      );
      if (profile.writeToChat) {
        await setProgressStep(
          'publish_completion',
          '发送完成通知',
          'running',
          undefined,
          undefined,
          {
            kind: 'stage',
            inputText: formatProgressKeyValues([
              ['write_to_chat', profile.writeToChat],
              ['review_output_mode', profile.reviewOutputMode],
            ]),
          },
        );
        normalized = await publishRepoReviewCompletionMessage({
          repository,
          run: normalized,
          decisionMode: profile.passDecisionMode,
          diffText: prepared.diffText,
          reviewOutputMode: profile.reviewOutputMode,
        });
        await setProgressStep(
          'publish_completion',
          '发送完成通知',
          'completed',
          undefined,
          undefined,
          {
            kind: 'stage',
            outputText: '完成通知已发送。',
          },
        );
      } else {
        await setProgressStep(
          'publish_completion',
          '发送完成通知',
          'skipped',
          'Profile 未启用结果通知',
          undefined,
          {
            kind: 'stage',
            outputText: '当前 Profile 未启用结果通知。',
          },
        );
      }
      if (
        profile.writeToPlatform &&
        event.source !== 'local-hook' &&
        repositoryRecord.remote_provider
      ) {
        await setProgressStep(
          'platform_writeback',
          '平台状态/评论回写',
          'running',
          undefined,
          undefined,
          {
            kind: 'stage',
            inputText: formatProgressKeyValues([
              ['remote_provider', repositoryRecord.remote_provider || '-'],
              ['write_to_platform', profile.writeToPlatform],
            ]),
          },
        );
        try {
          const publish = await publishPlatformResult(
            repositoryRecord,
            normalized,
            profile,
          );
          if (publish.statusDeliveryStatus === 'not_configured') {
            logger.info(
              { repositoryId: repositoryRecord.id, runId: normalized.id },
              'Platform token not configured, skipping platform delivery',
            );
          }
          normalized = await applyRunPlatformDeliveryResult(normalized, {
            status: publish.status,
            statusDeliveryStatus: publish.statusDeliveryStatus,
            commentDeliveryStatus: publish.commentDeliveryStatus,
            commentId: publish.commentId || undefined,
            commentUrl: publish.commentUrl || undefined,
          });
          await setProgressStep(
            'platform_writeback',
            '平台状态/评论回写',
            'completed',
            undefined,
            undefined,
            {
              kind: 'stage',
              outputText: formatProgressKeyValues([
                ['status_delivery', publish.statusDeliveryStatus],
                ['comment_delivery', publish.commentDeliveryStatus],
              ]),
            },
          );
        } catch (publishErr) {
          const error =
            publishErr instanceof Error
              ? publishErr.message
              : String(publishErr);
          normalized = await applyRunPlatformDeliveryResult(normalized, {
            status: `error: ${error}`,
            statusDeliveryStatus: 'failed',
            commentDeliveryStatus:
              event.prMrNumber || repositoryRecord.remote_provider === 'gitlab'
                ? 'failed'
                : 'skipped',
            error,
          });
          await setProgressStep(
            'platform_writeback',
            '平台状态/评论回写',
            'failed',
            undefined,
            error,
            {
              kind: 'stage',
              outputText: '平台回写失败。',
            },
          );
        }
      } else {
        await setProgressStep(
          'platform_writeback',
          '平台状态/评论回写',
          'skipped',
          'Profile 未启用平台回写或本次不是远端审查',
          undefined,
          {
            kind: 'stage',
            outputText: '当前 Profile 未启用平台回写，或本次不是远端审查。',
          },
        );
      }
      await setProgressStep(
        'branch_state_update',
        '更新分支状态',
        'running',
        undefined,
        undefined,
        {
          kind: 'stage',
          inputText: formatProgressKeyValues([
            ['branch', normalized.branch || event.branch || '-'],
            ['stage', normalized.stage || event.stage],
          ]),
        },
      );
      await updateBranchStateFromRun(normalized);
      await setProgressStep(
        'branch_state_update',
        '更新分支状态',
        'completed',
        undefined,
        undefined,
        {
          kind: 'stage',
          outputText: '分支状态已更新。',
        },
      );
      reviewRunTerminal = true;
      progressSteps = repairTerminalRepoReviewProgressSteps(
        progressSteps,
        'completed',
      );
      await persistReviewProgress({}, {
        flush: true,
        includeFullTurns: true,
        force: true,
      });
      return {
        run: normalized,
        allowed: !blocking,
        blocking,
      };
    } catch (err) {
      try {
        await setProgressStep(
          'run_failed',
          '审查运行失败',
          'failed',
          undefined,
          errorMessageForProgress(err),
          {
            kind: 'stage',
            outputText: errorMessageForProgress(err),
          },
        );
        await failPendingProgressSteps(errorMessageForProgress(err));
      } catch (progressErr) {
        logger.warn(
          { err: progressErr, runId: runRecord.id },
          'Failed to persist repo review failure progress',
        );
      }
      const errorRunRecord = await getReviewRunById(runRecord.id);
      const cancelled =
        isRepoReviewCancellationError(err) ||
        repoReviewCancellationRequestedRunIds.has(runRecord.id);
      repoReviewCancellationRequestedRunIds.delete(runRecord.id);
      const durationMs = Date.now() - Date.parse(startedAtIso);
      reviewRunTerminal = true;
      progressSteps = repairTerminalRepoReviewProgressSteps(
        progressSteps,
        'failed',
        errorMessageForProgress(err),
      );
      await persistReviewProgress({}, {
        flush: true,
        includeFullTurns: true,
        force: true,
      });
      const updated = await updateReviewRun(runRecord.id, {
        status: 'error',
        result_state: 'error',
        overall: 'error',
        actor: event.actor || null,
        error: cancelled
          ? 'Review task was cancelled by user.'
          : err instanceof Error
            ? err.message
            : String(err),
        summary: cancelled
          ? REPO_REVIEW_CANCELLED_SUMMARY
          : 'Review execution failed.',
        duration_ms: durationMs,
        callback_context: runCallbackContext,
        completed_at: new Date().toISOString(),
      });
      let normalized = await normalizeRunRecord(updated);
      if (profile.writeToChat) {
        const completionMentions = resolveRepoReviewMentions(
          repository,
          normalized.actor,
        );
        normalized = await applyRunChatDeliveryResult(
          normalized,
          await publishReviewMessage({
            repository,
            runId: normalized.id,
            content: formatRepoReviewCompletedMessage(
              repository,
              normalized,
              profile.passDecisionMode,
              { skipActorMention: (completionMentions ?? []).length > 0 },
            ),
            mentions: completionMentions,
          }),
        );
      }
      await updateBranchStateFromRun(normalized);
      return {
        run: normalized,
        allowed: profile.blockingMode !== 'hard_fail',
        blocking: profile.blockingMode === 'hard_fail',
      };
    } finally {
      repoReviewCancellationRequestedRunIds.delete(runRecord.id);
      if (remoteWorkspacePath) {
        fs.rmSync(remoteWorkspacePath, { recursive: true, force: true });
      }
    }
  });
}

export async function listRepoReviewRepositories(): Promise<
  RepoReviewRepository[]
> {
  return await Promise.all(
    (await listReviewRepositories()).map((record) =>
      normalizeRepositoryRecord(record),
    ),
  );
}

export async function listRepoReviewProfiles(
  repositoryId?: string,
): Promise<RepoReviewProfile[]> {
  return await Promise.all(
    (await listReviewProfiles(repositoryId)).map((record) =>
      normalizeProfileRecord(record),
    ),
  );
}

export async function listRepoReviewRuns(
  repositoryId?: string,
): Promise<RepoReviewRun[]> {
  return await Promise.all(
    (await listReviewRuns(repositoryId)).map((r) => normalizeRunRecord(r)),
  );
}

export async function listRepoReviewRunsSummary(
  filters: RepoReviewRunSummaryFilters = {},
): Promise<RepoReviewRun[]> {
  const statusFilter = stringValue(filters.status);
  const keyword = stringValue(filters.keyword).toLowerCase();
  const limit = normalizeInteger(filters.limit, 100, 1, 200);
  const runs = await listReviewRunsSummary({
    repositoryId: filters.repositoryId,
    status: statusFilter || undefined,
    keyword: keyword || undefined,
    limit,
  });
  const profileIds = new Set(
    runs.map((record) => record.profile_id).filter(Boolean) as string[],
  );
  const profileMap = new Map<string, ReviewProfileRecord>();
  for (const profileId of profileIds) {
    const profile = await getReviewProfileById(profileId);
    if (profile) profileMap.set(profileId, profile);
  }

  const normalized = (
    await Promise.all(
      runs.map((record) =>
        normalizeRunRecord(
          record,
          record.profile_id
            ? (profileMap.get(record.profile_id) ?? null)
            : null,
        ),
      ),
    )
  ).filter((run) => {
    if (statusFilter && (run.overall || run.status) !== statusFilter) {
      return false;
    }
    if (!keyword) return true;
    return [
      run.summary,
      run.actor,
      run.branch,
      run.ref,
      run.headSha,
      run.baseSha,
      run.prMrNumber,
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
  return normalized.slice(0, limit);
}

export async function listRepoReviewBranchStatesForRepository(
  repositoryId: string,
  stage?: ReviewStage,
): Promise<RepoReviewBranchState[]> {
  return (await listReviewBranchStates(repositoryId, stage)).map(
    normalizeBranchStateRecord,
  );
}

async function createDefaultProfilesForRepository(
  repository: ReviewRepositoryRecord,
): Promise<RepoReviewProfile[]> {
  const created: RepoReviewProfile[] = [];
  const repositoryId = repository.id;

  if (repository.remote_provider) {
    created.push(
      await normalizeProfileRecord(
        await saveReviewProfile({
          id: `profile-${slugifyId(`${repositoryId}-push-remote-default`)}`,
          repository_id: repositoryId,
          name: 'Push Remote Default',
          stage: 'push',
          source_mode: 'remote',
          blocking_mode: 'soft_fail',
          pass_decision_mode: 'ai',
          review_scope: 'commit_range',
          target_branches: [],
          skill_ids: [],
          mcp_server_ids: [],
          prompt_template: null,
          include_globs: [],
          exclude_globs: [],
          include_full_file_context: false,
          max_files: 80,
          max_diff_bytes: 200000,
          write_to_chat: true,
          write_to_platform: true,
          diff_subagent_threshold: 15,
          subagent_timeout_seconds: 420,
          enabled: true,
        }),
      ),
    );
  } else {
    created.push(
      await normalizeProfileRecord(
        await saveReviewProfile({
          id: `profile-${slugifyId(`${repositoryId}-commit-local-default`)}`,
          repository_id: repositoryId,
          name: 'Commit Local Default',
          stage: 'commit',
          source_mode: 'local',
          blocking_mode: 'soft_fail',
          pass_decision_mode: 'ai',
          review_scope: 'staged_diff',
          target_branches: [],
          skill_ids: [],
          mcp_server_ids: [],
          prompt_template: null,
          include_globs: [],
          exclude_globs: [],
          include_full_file_context: false,
          max_files: 60,
          max_diff_bytes: 150000,
          write_to_chat: true,
          write_to_platform: false,
          diff_subagent_threshold: 15,
          subagent_timeout_seconds: 420,
          enabled: true,
        }),
      ),
    );
  }

  return created;
}

export function inspectRepoReviewRepositoryCandidate(input: {
  localRepoPath?: string;
  remoteUrl?: string;
  remoteProvider?: ReviewRemoteProvider | '';
  remoteName?: string;
}): RepoReviewRepositoryDetection {
  const providerHint =
    input.remoteProvider &&
    ['github', 'gitlab', 'gitea'].includes(input.remoteProvider)
      ? input.remoteProvider
      : '';
  if (stringValue(input.localRepoPath)) {
    return readLocalRepositoryDetection({
      localRepoPath: stringValue(input.localRepoPath),
      providerHint,
      remoteName: stringValue(input.remoteName),
    });
  }
  if (stringValue(input.remoteUrl)) {
    return detectRepositoryFromRemoteUrl({
      remoteUrl: stringValue(input.remoteUrl),
      providerHint,
    });
  }
  throw new Error(t('repoReview.auto_fa159a', {}, undefined));
}

export async function saveRepoReviewRepositoryConfig(
  payload: Record<string, unknown>,
): Promise<RepoReviewRepositorySaveResult> {
  const existing = stringValue(payload.id)
    ? await getReviewRepositoryById(stringValue(payload.id))
    : undefined;
  const normalized = await normalizeRepositoryInput(payload, existing);
  validateRepositoryInput(
    normalized.input,
    existing,
    normalized.sensitiveValueModes,
  );
  if (!normalized.input.local_repo_path && normalized.input.clone_url) {
    const httpsUrl =
      buildHttpsCloneUrl(
        normalized.input as unknown as ReviewRepositoryRecord,
      ) || undefined;
    const mirrorPath = await ensureRepositoryMirror(
      normalized.input.clone_url,
      normalized.input.id,
      httpsUrl,
    );
    if (mirrorPath) {
      normalized.input.local_repo_path = mirrorPath;
    }
  }
  const saved = await saveReviewRepository(normalized.input);
  clearLocalGitRemoteMetadataCache();
  clearRemoteBranchSummariesCache(saved.id);

  const dailyEnabled = normalized.input.digest_daily_enabled === true;
  const weeklyEnabled = normalized.input.digest_weekly_enabled === true;
  const dailyHour = normalizeInteger(
    normalized.input.digest_daily_hour,
    18,
    0,
    23,
  );
  const weeklyHour = normalizeInteger(
    normalized.input.digest_weekly_hour,
    18,
    0,
    23,
  );
  const weeklyDay = normalizeInteger(
    normalized.input.digest_weekly_day,
    5,
    1,
    7,
  );
  const dailyConfigChanged =
    dailyEnabled !== (existing?.digest_daily_enabled === 1) ||
    dailyHour !== normalizeInteger(existing?.digest_daily_hour, 18, 0, 23);
  const weeklyConfigChanged =
    weeklyEnabled !== (existing?.digest_weekly_enabled === 1) ||
    weeklyHour !== normalizeInteger(existing?.digest_weekly_hour, 18, 0, 23) ||
    weeklyDay !== normalizeInteger(existing?.digest_weekly_day, 5, 1, 7);

  if (dailyEnabled && (dailyConfigChanged || !saved.next_digest_daily_at)) {
    await updateReviewRepositoryDigestTimestamps({
      repositoryId: saved.id,
      type: 'daily',
      nextDigestAt: computeNextDigestAt('daily', dailyHour),
    });
  } else if (!dailyEnabled && saved.next_digest_daily_at) {
    await updateReviewRepositoryDigestTimestamps({
      repositoryId: saved.id,
      type: 'daily',
      nextDigestAt: null,
    });
  }
  if (weeklyEnabled && (weeklyConfigChanged || !saved.next_digest_weekly_at)) {
    await updateReviewRepositoryDigestTimestamps({
      repositoryId: saved.id,
      type: 'weekly',
      nextDigestAt: computeNextDigestAt('weekly', weeklyHour, weeklyDay),
    });
  } else if (!weeklyEnabled && saved.next_digest_weekly_at) {
    await updateReviewRepositoryDigestTimestamps({
      repositoryId: saved.id,
      type: 'weekly',
      nextDigestAt: null,
    });
  }

  await saveReviewConversationBinding({
    repository_id: saved.id,
    chat_jid: saved.review_chat_jid || `repo-review:${saved.id}`,
  });
  const autoCreatedProfiles =
    (await listReviewProfiles(saved.id)).length === 0
      ? await createDefaultProfilesForRepository(saved)
      : [];
  return {
    repository: await normalizeRepositoryRecord(
      (await getReviewRepositoryById(saved.id)) || saved,
    ),
    autoCreatedProfiles,
    warnings: normalized.warnings,
  };
}

export async function getRepoReviewOverview(
  repositoryId?: string,
): Promise<RepoReviewOverview> {
  return {
    repositories: await listRepoReviewRepositories(),
    profiles: await listRepoReviewProfiles(repositoryId),
    runs: await listRepoReviewRunsSummary({ repositoryId }),
  };
}

async function createQueuedReviewRunForEvent(
  event: RepoReviewEvent,
): Promise<
  { runRecord: ReviewRunRecord } | { summary: RepoReviewExecutionSummary }
> {
  const repositoryRecord = await requireRepository(event.repositoryId);
  if (repositoryRecord.enabled !== 1) {
    throw new Error(`Review repository is disabled: ${event.repositoryId}`);
  }
  const profileRecord = await selectMatchingProfileRecord(
    repositoryRecord,
    event,
  );
  const candidateProfile = profileRecord
    ? profileRecord.enabled === 1
      ? await normalizeProfileRecord(profileRecord)
      : null
    : null;
  const idempotencyKey = computeReviewIdempotencyKey(
    event.repositoryId,
    profileRecord?.id || stringValue(event.profileId),
    event,
  );
  const existingRunRecord = await getReviewRunByIdempotencyKey({
    repositoryId: event.repositoryId,
    idempotencyKey,
  });
  if (idempotencyKey && existingRunRecord) {
    if (!shouldReuseIdempotentRun(existingRunRecord)) {
      await updateReviewRun(existingRunRecord.id, {
        idempotency_key: null,
      });
    } else {
      return {
        summary: buildRepoReviewExecutionSummary(
          await normalizeRunRecord(existingRunRecord),
          {
            reused: true,
            reuseReason: '相同提交范围的审查已存在，本次复用已有运行。',
          },
        ),
      };
    }
  }
  const baselineSource = await resolveBaselineSource(event, candidateProfile);
  const effectiveRules = candidateProfile
    ? buildEffectiveRulesSnapshot(
        await normalizeRepositoryRecord(repositoryRecord),
        candidateProfile,
      )
    : {};

  try {
    const runRecord = await createReviewRun({
      id: `review-run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      repository_id: event.repositoryId,
      profile_id: profileRecord?.id || null,
      idempotency_key: idempotencyKey,
      source: event.source,
      stage: event.stage,
      status: 'queued',
      baseline_source: baselineSource || null,
      result_state: 'queued',
      ref: event.ref || null,
      branch: event.branch || null,
      base_sha: event.baseSha || null,
      head_sha: event.headSha || null,
      pr_mr_number: event.prMrNumber || null,
      actor: event.actor || null,
      effective_rules: effectiveRules,
      userId: resolveReviewRunUserId(event),
      callback_context: markQueuedRemoteReviewContext(event),
    });
    await persistRepoReviewRunProgressStep({
      runId: runRecord.id,
      id: 'queued',
      label: '任务已入队',
      status: 'completed',
      detail: '远端审查任务已加入执行队列',
    });
    updateBranchStateFromRun(await normalizeRunRecord(runRecord));
    return { runRecord };
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const raceRecord = await getReviewRunByIdempotencyKey({
        repositoryId: event.repositoryId,
        idempotencyKey,
      });
      if (raceRecord && shouldReuseIdempotentRun(raceRecord)) {
        return {
          summary: buildRepoReviewExecutionSummary(
            await normalizeRunRecord(raceRecord),
            {
              reused: true,
              reuseReason: '相同提交范围的审查已存在，本次复用已有运行。',
            },
          ),
        };
      }
    }
    throw err;
  }
}

async function buildQueueItemFromRunRecord(
  runRecord: ReviewRunRecord,
): Promise<RepoReviewQueueItem> {
  const parsed = await parseReviewRunRecord(runRecord);
  const callbackContext = asRecord(parsed.callbackContext);
  return {
    runId: runRecord.id,
    repositoryId: runRecord.repository_id,
    stage: runRecord.stage,
    branch:
      normalizeBranchName(runRecord.branch || '') || runRecord.branch || '',
    headSha: stringValue(runRecord.head_sha),
    baseSha: stringValue(runRecord.base_sha),
    manualReviewKey: buildManualReviewKey(
      parseManualReviewOptions(callbackContext),
      stringValue(runRecord.base_sha),
    ),
  };
}

async function buildRepoReviewEventFromQueuedRunRecord(
  runRecord: ReviewRunRecord,
): Promise<RepoReviewEvent | null> {
  const parsed = await parseReviewRunRecord(runRecord);
  const callbackContext = asRecord(parsed.callbackContext);
  const queuedContext = parseQueuedRemoteReviewContext(callbackContext);
  if (!queuedContext) return null;
  if (
    runRecord.source !== 'github' &&
    runRecord.source !== 'gitlab' &&
    runRecord.source !== 'gitea'
  ) {
    return null;
  }
  return {
    source: runRecord.source,
    stage: runRecord.stage,
    repositoryId: runRecord.repository_id,
    userId: runRecord.user_id || undefined,
    profileId: runRecord.profile_id || undefined,
    ref: runRecord.ref || undefined,
    branch: runRecord.branch || undefined,
    baseSha: runRecord.base_sha || undefined,
    headSha: runRecord.head_sha || undefined,
    baselineSource: runRecord.baseline_source || undefined,
    prMrNumber: runRecord.pr_mr_number || undefined,
    actor: runRecord.actor || undefined,
    blockingExpected: queuedContext.blockingExpected,
    callbackContext,
  };
}

async function buildRepoReviewEventFromExistingRunRecord(
  runRecord: ReviewRunRecord,
): Promise<RepoReviewEvent> {
  const parsed = await parseReviewRunRecord(runRecord);
  const callbackContext = asRecord(parsed.callbackContext);
  return {
    source: runRecord.source as RepoReviewEvent['source'],
    stage: runRecord.stage,
    repositoryId: runRecord.repository_id,
    userId: runRecord.user_id || undefined,
    profileId: runRecord.profile_id || undefined,
    ref: runRecord.ref || undefined,
    branch: runRecord.branch || undefined,
    baseSha: runRecord.base_sha || undefined,
    headSha: runRecord.head_sha || undefined,
    baselineSource: runRecord.baseline_source || undefined,
    prMrNumber: runRecord.pr_mr_number || undefined,
    actor: runRecord.actor || undefined,
    blockingExpected: runRecord.source === 'local-hook',
    callbackContext,
  };
}

export async function listRepoReviewChatMembers(
  chatJid: string,
): Promise<RepoReviewChatMember[]> {
  const normalizedChatJid = stringValue(chatJid);
  if (!normalizedChatJid) return [];

  const channel = normalizedChatJid.startsWith('feishu:') ? 'feishu' : '';
  if (channel) {
    try {
      const members = await listFeishuChatMembersByJid(normalizedChatJid);
      for (const member of members) {
        await upsertConversationParticipant({
          chatJid: normalizedChatJid,
          channel,
          memberId: member.id,
          memberName: member.name,
          source: member.source,
        });
      }
    } catch (err) {
      logger.warn(
        { err, chatJid: normalizedChatJid },
        'Failed to refresh Feishu members for repo review chat',
      );
    }
  }

  await backfillConversationParticipantsFromMessages(
    normalizedChatJid,
    channel,
  );
  return (await listConversationParticipants(normalizedChatJid))
    .map((participant) => ({
      id: stringValue(participant.member_id),
      name:
        stringValue(participant.member_name) ||
        stringValue(participant.member_id),
      chatJid: normalizedChatJid,
      source: stringValue(participant.source) || 'message',
    }))
    .filter((participant) => participant.id)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

export async function getRepoReviewRun(
  runId: string,
): Promise<RepoReviewRun | null> {
  const record = await getReviewRunById(runId);
  return record ? await normalizeRunRecord(record) : null;
}

export async function getRepoReviewRunDetail(
  runId: string,
): Promise<RepoReviewRunDetail | null> {
  const runRecord = await getReviewRunById(runId);
  if (!runRecord) return null;
  const repositoryRecord = await requireRepository(runRecord.repository_id);
  const profileRecord = runRecord.profile_id
    ? await getReviewProfileById(runRecord.profile_id)
    : null;
  const branchStateRecord =
    runRecord.branch && runRecord.stage
      ? await getReviewBranchState({
          repositoryId: runRecord.repository_id,
          stage: runRecord.stage,
          branch: normalizeBranchName(runRecord.branch) || runRecord.branch,
        })
      : undefined;
  return {
    run: await normalizeRunRecord(runRecord),
    repository: await normalizeRepositoryRecord(repositoryRecord),
    profile: profileRecord ? await normalizeProfileRecord(profileRecord) : null,
    branchState: branchStateRecord
      ? normalizeBranchStateRecord(branchStateRecord)
      : null,
  };
}

export async function cancelRepoReviewRun(input: {
  runId: string;
  cancelledBy?: string;
}): Promise<RepoReviewRun> {
  const runRecord = await getReviewRunById(stringValue(input.runId));
  if (!runRecord) {
    throw new Error(t('repoReview.auto_3946fd', {}, undefined));
  }
  if (runRecord.status !== 'queued' && runRecord.status !== 'running') {
    throw new Error(t('repoReview.auto_2f33f3', {}, undefined));
  }

  const cancelledBy = stringValue(input.cancelledBy) || 'web-user';
  const reason =
    runRecord.status === 'queued'
      ? `Review task was cancelled by ${cancelledBy} before execution started.`
      : `Review task was cancelled by ${cancelledBy} while it was running.`;

  repoReviewCancellationRequestedRunIds.add(runRecord.id);

  const repositoryRecord = await requireRepository(runRecord.repository_id);
  const repository = await normalizeRepositoryRecord(repositoryRecord);
  const reviewChatJid =
    repository.reviewChatJid || `repo-review:${repository.id}`;
  getWebChannel()?.notifyInterrupted(reviewChatJid, {
    timestamp: new Date().toISOString(),
    reason: `Repo review cancelled: ${runRecord.id}`,
  });

  if (runRecord.status === 'queued') {
    reviewExecutionQueue.removeWhere((item) => item.runId === runRecord.id);
    repoReviewCancellationRequestedRunIds.delete(runRecord.id);
    return await markRepoReviewRunCancelled(runRecord, reason);
  }

  const normalized = await markRepoReviewRunCancelled(runRecord, reason);
  requestAgentClose(buildReviewGroup(repository).folder, runRecord.id);
  return normalized;
}

export async function rerunRepoReviewRun(input: {
  runId: string;
  userId?: string;
}): Promise<RepoReviewExecutionSummary> {
  const runRecord = await getReviewRunById(stringValue(input.runId));
  if (!runRecord) {
    throw new Error(t('repoReview.auto_3946fd', {}, undefined));
  }
  if (runRecord.status === 'queued' || runRecord.status === 'running') {
    throw new Error(t('repoReview.auto_477ec4', {}, undefined));
  }
  const event = await buildRepoReviewEventFromExistingRunRecord(runRecord);
  if (input.userId) {
    event.userId = input.userId;
  }
  event.callbackContext = mergeCallbackContext(
    stripRepoReviewExecutionContext(event.callbackContext),
    {
      rerunOfRunId: runRecord.id,
    },
  );
  return executeRepoReviewEvent(event, undefined, {
    skipIdempotencyReuse: true,
  });
}

export async function decideRepoReviewRunByHuman(input: {
  runId: string;
  decision: 'pass' | 'fail';
  decidedBy?: string;
}): Promise<RepoReviewRun> {
  if (input.decision !== 'pass' && input.decision !== 'fail') {
    throw new Error(t('repoReview.auto_44e85a', {}, undefined));
  }
  const runRecord = await getReviewRunById(stringValue(input.runId));
  if (!runRecord) {
    throw new Error(t('repoReview.auto_3946fd', {}, undefined));
  }
  const profileRecord = runRecord.profile_id
    ? await getReviewProfileById(runRecord.profile_id)
    : null;
  if (!profileRecord) {
    throw new Error(t('repoReview.auto_b160d4', {}, undefined));
  }
  if (profileRecord.stage !== 'push') {
    throw new Error(t('repoReview.auto_c62b68', {}, undefined));
  }
  if (profileRecord.pass_decision_mode !== 'human') {
    throw new Error(t('repoReview.auto_71961e', {}, undefined));
  }
  if (runRecord.status === 'queued' || runRecord.status === 'running') {
    throw new Error(t('repoReview.auto_e0ec52', {}, undefined));
  }
  if (runRecord.status !== 'completed') {
    throw new Error(t('repoReview.auto_e28922', {}, undefined));
  }
  if (runRecord.overall === 'error' || runRecord.overall === 'skipped') {
    throw new Error(t('repoReview.auto_fa6f57', {}, undefined));
  }

  const repositoryRecord = await requireRepository(runRecord.repository_id);
  const repository = await normalizeRepositoryRecord(repositoryRecord);
  const profile = await normalizeProfileRecord(profileRecord);
  const decision = input.decision;
  const decidedBy = stringValue(input.decidedBy) || 'web-user';
  const reviewerUsernames = repository.reviewerUsernames || [];
  if (reviewerUsernames.length > 0) {
    const normalizedDecider = normalizeReviewerUsername(decidedBy);
    if (!reviewerUsernames.includes(normalizedDecider)) {
      throw new Error(REPO_REVIEW_PERMISSION_DENIED_MESSAGE);
    }
  }
  const decidedAt = new Date().toISOString();
  const resultState =
    decision === 'pass'
      ? ('manual_passed' as const)
      : ('manual_failed' as const);

  // Atomic conditional update — only succeeds if manual_decision is still NULL.
  // This prevents duplicate side effects when two concurrent requests race.
  const updatedRecord = await setReviewRunManualDecision({
    runId: runRecord.id,
    resultState,
    manualDecision: decision,
    manualDecisionBy: decidedBy,
    manualDecisionAt: decidedAt,
  });
  if (!updatedRecord) {
    throw new Error(t('repoReview.auto_b39446', {}, undefined));
  }
  let normalized = await normalizeRunRecord(updatedRecord);

  const manualMentions = resolveRepoReviewMentions(
    repository,
    normalized.actor,
  );
  const manualMessage = formatRepoReviewManualDecisionMessage({
    repository,
    run: normalized,
    decision,
    decidedBy,
    decidedAt,
    skipActorMention: (manualMentions ?? []).length > 0,
  });

  if (profile.writeToChat) {
    normalized = await applyRunChatDeliveryResult(
      normalized,
      await publishReviewMessage({
        repository,
        runId: normalized.id,
        content: manualMessage,
        mentions: manualMentions,
      }),
    );
  }

  if (
    profile.writeToPlatform &&
    runRecord.source !== 'local-hook' &&
    repositoryRecord.remote_provider
  ) {
    try {
      const publish = await publishPlatformResult(
        repositoryRecord,
        normalized,
        profile,
        {
          state: mapManualDecisionToStatus(
            repositoryRecord.remote_provider,
            decision,
          ),
          description: shortDescription(
            decision === 'pass'
              ? t(
                  'repoReview.manualReviewPass',
                  {
                    summary:
                      normalized.summary ||
                      t('repoReview.manualReviewPassFallback', {}, undefined),
                  },
                  undefined,
                )
              : t(
                  'repoReview.manualReviewFail',
                  {
                    summary:
                      normalized.summary ||
                      t('repoReview.manualReviewFailFallback', {}, undefined),
                  },
                  undefined,
                ),
          ),
          body: manualMessage,
        },
      );
      normalized = await applyRunPlatformDeliveryResult(normalized, {
        status: publish.status,
        statusDeliveryStatus: publish.statusDeliveryStatus,
        commentDeliveryStatus: publish.commentDeliveryStatus,
        commentId: publish.commentId || undefined,
        commentUrl: publish.commentUrl || undefined,
      });
    } catch (publishErr) {
      const error =
        publishErr instanceof Error ? publishErr.message : String(publishErr);
      normalized = await applyRunPlatformDeliveryResult(normalized, {
        status: `error: ${error}`,
        statusDeliveryStatus: 'failed',
        commentDeliveryStatus:
          runRecord.pr_mr_number ||
          repositoryRecord.remote_provider === 'gitlab'
            ? 'failed'
            : 'skipped',
        error,
      });
    }
  }

  await updateBranchStateFromRun(normalized);
  return normalized;
}

export async function getRepoReviewRepositoryRecord(
  repositoryId: string,
): Promise<ReviewRepositoryRecord | undefined> {
  return await getReviewRepositoryById(repositoryId);
}

async function listRemoteBranchSummaries(
  repository: ReviewRepositoryRecord,
): Promise<RepoReviewBranchSummary[]> {
  if (hasLocalGitRemoteAccess(repository)) {
    return listLocalRemoteBranchSummaries(repository);
  }
  const scm = getScmConfig(repository);
  if (scm?.provider === 'gitlab') {
    const branchEntries = await fetchGitLabRemoteBranchEntries(repository);
    let defaultBranch =
      normalizeBranchName(repository.default_target_branch || '') ||
      branchEntries
        .map((entry) => normalizeGitLabBranchSummary(entry, ''))
        .find((entry) => entry?.defaultBranch)?.name ||
      '';
    if (!defaultBranch && branchEntries.length > 0) {
      defaultBranch = await fetchGitLabProjectDefaultBranch(repository);
    }
    return branchEntries
      .map((entry) => normalizeGitLabBranchSummary(entry, defaultBranch))
      .filter((entry): entry is RepoReviewBranchSummary => Boolean(entry))
      .sort(compareRepoReviewBranchSummaries);
  }
  if (scm?.provider === 'github' || scm?.provider === 'gitea') {
    const defaultBranch = await fetchRemoteRepositoryDefaultBranch(repository);
    const branchEntries =
      scm.provider === 'github'
        ? await fetchGitHubRemoteBranchEntries(repository)
        : await fetchGiteaRemoteBranchEntries(repository);
    const baseSummaries = branchEntries
      .map((entry) => normalizeGitHubLikeBranchSummary(entry, defaultBranch))
      .filter((entry): entry is RepoReviewBranchSummary => Boolean(entry));
    const detailPromiseByRef = new Map<
      string,
      Promise<Awaited<ReturnType<typeof fetchRemoteCommitSummaryByRef>>>
    >();
    for (const entry of baseSummaries) {
      const ref = entry.headSha || entry.name;
      if (!ref || detailPromiseByRef.has(ref)) continue;
      detailPromiseByRef.set(
        ref,
        fetchRemoteCommitSummaryByRef(repository, ref),
      );
    }
    const detailByRef = new Map<
      string,
      Awaited<ReturnType<typeof fetchRemoteCommitSummaryByRef>>
    >();
    await Promise.all(
      Array.from(detailPromiseByRef.entries()).map(async ([ref, promise]) => {
        detailByRef.set(ref, await promise);
      }),
    );
    return baseSummaries
      .map((entry) => {
        const detail = detailByRef.get(entry.headSha || entry.name);
        return {
          ...entry,
          headSha: detail?.headSha || entry.headSha,
          parentSha: detail?.parentSha || entry.parentSha,
          actor: detail?.actor || entry.actor,
          title: detail?.title || entry.title,
          latestCommitAt: detail?.latestCommitAt || entry.latestCommitAt,
        };
      })
      .sort(compareRepoReviewBranchSummaries);
  }
  if (scm) {
    const defaultBranch = await fetchRemoteRepositoryDefaultBranch(repository);
    const branches = await listRemoteBranches(repository);
    const summaries = await Promise.all(
      branches.map(async (branch) => {
        const head = await fetchRemoteBranchHead(repository, branch);
        return {
          name: branch,
          headSha: head.headSha,
          parentSha: head.parentSha,
          actor: head.actor,
          title: head.title,
          latestCommitAt: head.latestCommitAt,
          defaultBranch: branch === defaultBranch,
        };
      }),
    );
    return summaries.sort(compareRepoReviewBranchSummaries);
  }
  return listBranchesViaLsRemote(repository);
}

const REMOTE_BRANCH_SUMMARY_CACHE_TTL_MS = 90_000;
const remoteBranchSummaryCache = new Map<
  string,
  RepoReviewBranchSummaryCacheEntry
>();

function getFreshRemoteBranchSummariesCache(
  repositoryId: string,
): RepoReviewBranchSummary[] {
  const cached = remoteBranchSummaryCache.get(repositoryId);
  if (!cached || cached.fetchedAt <= 0) return [];
  if (Date.now() - cached.fetchedAt >= REMOTE_BRANCH_SUMMARY_CACHE_TTL_MS) {
    return [];
  }
  return cached.branches;
}

function getCachedRemoteBranchSummary(
  repositoryId: string,
  branch: string,
): RepoReviewBranchSummary | null {
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) return null;
  return (
    getFreshRemoteBranchSummariesCache(repositoryId).find(
      (entry) => normalizeBranchName(entry.name) === normalizedBranch,
    ) || null
  );
}

function getCachedRemoteDefaultBranch(repositoryId: string): string {
  return (
    getFreshRemoteBranchSummariesCache(repositoryId).find(
      (entry) => entry.defaultBranch,
    )?.name || ''
  );
}

async function setRemoteBranchSummariesCache(
  repositoryId: string,
  branches: RepoReviewBranchSummary[],
  fetchedAtMs: number,
): Promise<void> {
  const fetchedAtIso = new Date(fetchedAtMs).toISOString();
  remoteBranchSummaryCache.set(repositoryId, {
    branches,
    fetchedAt: fetchedAtMs,
  });
  await saveReviewRemoteBranchCache({
    repository_id: repositoryId,
    branches_json: JSON.stringify(branches),
    fetched_at: fetchedAtIso,
  });
}

function seedRemoteBranchSummariesCache(
  repositoryId: string,
  branches: RepoReviewBranchSummary[],
): void {
  remoteBranchSummaryCache.set(repositoryId, {
    branches,
    fetchedAt: 0,
  });
}

async function clearRemoteBranchSummariesCache(
  repositoryId: string,
): Promise<void> {
  remoteBranchSummaryCache.delete(repositoryId);
  await deleteReviewRemoteBranchCache(repositoryId);
}

function normalizeRepoReviewBranchSummary(
  value: unknown,
): RepoReviewBranchSummary | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const name = stringValue(entry.name);
  if (!name) return null;
  return {
    name,
    headSha: stringValue(entry.headSha),
    parentSha: stringValue(entry.parentSha),
    actor: stringValue(entry.actor),
    title: stringValue(entry.title),
    latestCommitAt: stringValue(entry.latestCommitAt),
    defaultBranch: Boolean(entry.defaultBranch),
  };
}

function normalizeRepoReviewBranchSummaries(
  value: unknown,
): RepoReviewBranchSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRepoReviewBranchSummary(entry))
    .filter((entry): entry is RepoReviewBranchSummary => Boolean(entry));
}

async function refreshRemoteBranchSummariesCache(
  repository: ReviewRepositoryRecord,
): Promise<RepoReviewBranchSummary[]> {
  const cached = remoteBranchSummaryCache.get(repository.id);
  if (cached?.refreshPromise) {
    return cached.refreshPromise;
  }

  remoteBranchSummaryCache.set(repository.id, {
    branches: cached?.branches || [],
    fetchedAt: 0,
  });

  const refreshPromise = (async () => {
    if (hasLocalGitRemoteAccess(repository)) {
      await refreshRepositoryRemoteRefs(repository);
    } else if (repository.clone_url) {
      await tryRecoverLocalMirror(repository);
    }
    const branches = await listRemoteBranchSummaries(repository);
    setRemoteBranchSummariesCache(repository.id, branches, Date.now());
    return branches;
  })();

  remoteBranchSummaryCache.set(repository.id, {
    branches: cached?.branches || [],
    fetchedAt: 0,
    refreshPromise,
  });

  try {
    return await refreshPromise;
  } finally {
    const latest = remoteBranchSummaryCache.get(repository.id);
    if (latest?.refreshPromise === refreshPromise) {
      remoteBranchSummaryCache.set(repository.id, {
        branches: latest.branches,
        fetchedAt: latest.fetchedAt,
      });
    }
  }
}

export async function listRepoReviewRemoteBranches(
  repositoryId: string,
  options: {
    force?: boolean;
  } = {},
): Promise<RepoReviewBranchSummary[]> {
  const repository = await requireRepository(repositoryId);
  if (!repository.remote_provider) {
    throw new Error('Repository does not have a remote provider configured');
  }

  if (options.force) {
    return await refreshRemoteBranchSummariesCache(repository);
  }

  const cached = remoteBranchSummaryCache.get(repository.id);
  if (cached && cached.fetchedAt > 0) {
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs >= REMOTE_BRANCH_SUMMARY_CACHE_TTL_MS) {
      void (await refreshRemoteBranchSummariesCache(repository).catch((err) => {
        logger.warn(
          { err, repositoryId: repository.id },
          'Failed to refresh cached repo review remote branches',
        );
      }));
    }
    return cached.branches;
  }

  if (cached?.branches.length) {
    if (!cached.refreshPromise) {
      void (await refreshRemoteBranchSummariesCache(repository).catch((err) => {
        logger.warn(
          { err, repositoryId: repository.id },
          'Failed to refresh provisional repo review remote branches cache',
        );
      }));
    }
    return cached.branches;
  }

  const persisted = await getReviewRemoteBranchCache(repository.id);
  if (persisted) {
    const parsed = await parseReviewRemoteBranchCacheRecord(persisted);
    const branches = normalizeRepoReviewBranchSummaries(parsed.branches);
    const fetchedAtMs = Date.parse(parsed.fetched_at);
    if (!Number.isNaN(fetchedAtMs)) {
      remoteBranchSummaryCache.set(repository.id, {
        branches,
        fetchedAt: fetchedAtMs,
      });
      if (Date.now() - fetchedAtMs >= REMOTE_BRANCH_SUMMARY_CACHE_TTL_MS) {
        void (await refreshRemoteBranchSummariesCache(repository).catch(
          (err) => {
            logger.warn(
              { err, repositoryId: repository.id },
              'Failed to refresh persisted repo review remote branches cache',
            );
          },
        ));
      }
      return branches;
    }
  }

  if (hasLocalGitRemoteAccess(repository)) {
    const localBranches = listLocalRemoteBranchSummaries(repository);
    if (localBranches.length > 0) {
      seedRemoteBranchSummariesCache(repository.id, localBranches);
      void (await refreshRemoteBranchSummariesCache(repository).catch((err) => {
        logger.warn(
          { err, repositoryId: repository.id },
          'Failed to refresh local repo review remote branches after seeding',
        );
      }));
      return localBranches;
    }
  }

  return await refreshRemoteBranchSummariesCache(repository);
}

export async function listRepoReviewRemoteBranchCommits(
  repositoryId: string,
  branch: string,
  options: {
    limit?: number;
  } = {},
): Promise<RepoReviewCommitInfo[]> {
  const repository = await requireRepository(repositoryId);
  if (!repository.remote_provider) {
    throw new Error('Repository does not have a remote provider configured');
  }
  const normalizedBranch = normalizeBranchName(branch);
  if (!normalizedBranch) {
    throw new Error('branch is required');
  }
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
  if (hasLocalGitRemoteAccess(repository)) {
    await refreshRepositoryRemoteRefs(repository);
    return fetchLocalRemoteBranchCommitDetails(
      repository,
      normalizedBranch,
      limit,
    );
  }
  if (!hasLocalGitRemoteAccess(repository) && repository.clone_url) {
    const recovered = await tryRecoverLocalMirror(repository);
    if (recovered && hasLocalGitRemoteAccess(repository)) {
      return fetchLocalRemoteBranchCommitDetails(
        repository,
        normalizedBranch,
        limit,
      );
    }
  }
  return await fetchRemoteBranchCommitDetails(
    repository,
    normalizedBranch,
    limit,
  );
}

function hasPendingQueuedRepoReviewEvent(event: RepoReviewEvent): boolean {
  const baseSha = stringValue(event.baseSha);
  const manualReviewKey = buildManualReviewKey(
    parseManualReviewOptions(event.callbackContext),
    baseSha,
  );
  return reviewExecutionQueue.some(
    (queued) =>
      !repoReviewCancellationRequestedRunIds.has(queued.runId) &&
      queued.repositoryId === event.repositoryId &&
      queued.stage === event.stage &&
      normalizeBranchName(queued.branch) ===
        normalizeBranchName(event.branch || '') &&
      queued.headSha === stringValue(event.headSha) &&
      queued.baseSha === baseSha &&
      queued.manualReviewKey === manualReviewKey,
  );
}

async function enqueueQueuedRepoReviewRun(
  runRecord: ReviewRunRecord,
): Promise<void> {
  const item = await buildQueueItemFromRunRecord(runRecord);
  if (reviewExecutionQueue.some((queued) => queued.runId === item.runId)) {
    return;
  }
  reviewExecutionQueue.enqueue(item);
}

async function buildQueuedRemoteBranchResult(input: {
  repository: ReviewRepositoryRecord;
  branch: string;
  userId?: string;
  head: {
    headSha: string;
    parentSha: string;
    actor: string;
  };
  defaultBranch: string;
  trigger: 'manual-sync' | 'auto-sync' | 'profile-save';
  usedCachedBranchSummary?: boolean;
  manualReview?: RepoReviewManualReviewOptions;
}): Promise<QueuedRepoReviewBranchResult> {
  const branch = normalizeBranchName(input.branch);
  const headSha = stringValue(input.head.headSha);
  const manualReview = input.manualReview || {};
  if (!headSha) {
    return {
      branch,
      headSha: '',
      status: 'error',
      reason: '无法获取分支最新提交。',
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }

  const activeBranchState = await getReviewBranchState({
    repositoryId: input.repository.id,
    stage: 'push',
    branch,
  });
  if (
    activeBranchState?.head_sha === headSha &&
    (activeBranchState.status === 'queued' ||
      activeBranchState.status === 'running')
  ) {
    return {
      branch,
      headSha,
      status: 'skipped',
      reason: '该分支已有审查任务执行中',
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }
  if (
    activeBranchState?.head_sha === headSha &&
    activeBranchState.result_state &&
    activeBranchState.result_state !== 'error' &&
    !manualReview.allowRepeat
  ) {
    return {
      branch,
      headSha,
      status: 'skipped',
      reason: '该分支当前提交已完成审查，无需重复执行。',
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }

  let selectedBaselineRun: ReviewRunRecord | null = null;
  if (stringValue(manualReview.baselineRunId)) {
    const runRecord = await getReviewRunById(
      stringValue(manualReview.baselineRunId),
    );
    if (!runRecord) {
      return {
        branch,
        headSha,
        status: 'error',
        reason: '指定的基线审查运行不存在。',
        usedCachedBranchSummary: input.usedCachedBranchSummary,
      };
    }
    if (
      runRecord.repository_id !== input.repository.id ||
      normalizeBranchName(runRecord.branch || '') !== branch ||
      runRecord.stage !== 'push'
    ) {
      return {
        branch,
        headSha,
        status: 'error',
        reason: '指定的基线审查运行不属于当前仓库或分支。',
        usedCachedBranchSummary: input.usedCachedBranchSummary,
      };
    }
    if (!stringValue(runRecord.head_sha)) {
      return {
        branch,
        headSha,
        status: 'error',
        reason: '指定的基线审查运行缺少 head 提交。',
        usedCachedBranchSummary: input.usedCachedBranchSummary,
      };
    }
    selectedBaselineRun = runRecord;
  }

  const baseline = await resolveRemoteReviewBaseline({
    repository: input.repository,
    stage: 'push',
    branch,
    headSha,
    parentSha: stringValue(input.head.parentSha),
    defaultBranch: input.defaultBranch,
    manualReview,
    selectedBaselineRun,
  });
  if (!baseline.baseSha) {
    return {
      branch,
      headSha,
      status: 'skipped',
      reason: '无法确定审查基线提交。',
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }

  const event: RepoReviewEvent = {
    source: input.repository.remote_provider!,
    stage: 'push',
    repositoryId: input.repository.id,
    userId: input.userId,
    ref: `refs/heads/${branch}`,
    branch,
    baseSha: baseline.baseSha,
    headSha,
    actor: input.head.actor || 'manual-sync',
    blockingExpected: false,
    callbackContext: withManualReviewContext(
      {
        trigger: input.trigger,
        baseBranch: baseline.baseBranch,
        baselineSource: baseline.baselineSource,
      },
      {
        ...manualReview,
        baselineRef: baseline.baselineRef,
        baselineLabel: baseline.baselineLabel,
      },
    ),
  };
  if (hasPendingQueuedRepoReviewEvent(event)) {
    return {
      branch,
      headSha,
      status: 'skipped',
      reason: '未创建新的审查运行。',
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }

  const queued = await createQueuedReviewRunForEvent(event);
  if ('summary' in queued) {
    return {
      branch,
      headSha,
      status: 'skipped',
      reason:
        queued.summary.reuseReason ||
        '相同提交范围的审查已存在，本次复用已有运行。',
      runId: queued.summary.run.id,
      usedCachedBranchSummary: input.usedCachedBranchSummary,
    };
  }
  await enqueueQueuedRepoReviewRun(queued.runRecord);
  return {
    branch,
    headSha,
    status: 'triggered',
    reason: '已创建审查任务。',
    runId: queued.runRecord.id,
    usedCachedBranchSummary: input.usedCachedBranchSummary,
  };
}

export async function queueRemoteBranchReview(input: {
  repositoryId: string;
  branch: string;
  userId?: string;
  baselineMode?: RepoReviewManualBaselineMode;
  baselineRunId?: string;
  baselineSha?: string;
  reviewMode?: RepoReviewManualReviewMode;
  allowRepeat?: boolean;
}): Promise<QueuedRepoReviewSingleBranchResult> {
  ensureRepoReviewStartupRecovery();
  const repository = await requireRepository(input.repositoryId);
  if (!repository.remote_provider) {
    throw new Error('Repository does not have a remote provider configured');
  }
  const branch = normalizeBranchName(input.branch);
  if (!branch) {
    throw new Error('branch is required');
  }

  await recoverStaleRepoReviewRuns(repository.id);

  const cachedBranchSummary = getCachedRemoteBranchSummary(
    repository.id,
    branch,
  );
  const usedCachedBranchSummary = Boolean(cachedBranchSummary);
  if (!cachedBranchSummary && hasLocalGitRemoteAccess(repository)) {
    await refreshRepositoryRemoteRefs(repository);
  }
  const defaultBranch =
    getCachedRemoteDefaultBranch(repository.id) ||
    (cachedBranchSummary?.defaultBranch ? branch : '') ||
    (await fetchRemoteRepositoryDefaultBranch(repository));
  const branchHead = cachedBranchSummary
    ? {
        headSha: cachedBranchSummary.headSha,
        parentSha: cachedBranchSummary.parentSha,
        actor: cachedBranchSummary.actor,
      }
    : await fetchRemoteBranchHead(repository, branch);
  const queuedResult = await buildQueuedRemoteBranchResult({
    repository,
    branch,
    userId: input.userId,
    head: branchHead,
    defaultBranch,
    trigger: 'manual-sync',
    usedCachedBranchSummary,
    manualReview: {
      baselineMode: normalizeManualReviewBaselineMode(input.baselineMode),
      baselineRunId: stringValue(input.baselineRunId) || undefined,
      baselineSha: stringValue(input.baselineSha) || undefined,
      reviewMode: normalizeManualReviewMode(input.reviewMode),
      allowRepeat: Boolean(input.allowRepeat),
    },
  });

  return {
    queued: queuedResult.status === 'triggered',
    branch: queuedResult.branch,
    headSha: queuedResult.headSha,
    reason: queuedResult.reason,
    reused: queuedResult.status === 'skipped',
    runId: queuedResult.runId,
    usedCachedBranchSummary,
  };
}

export async function queueRemoteRepoReview(input: {
  repositoryId: string;
  userId?: string;
}): Promise<QueuedRepoReviewBranchResultSummary> {
  ensureRepoReviewStartupRecovery();
  const repositoryRecord = await requireRepository(input.repositoryId);
  await recoverStaleRepoReviewRuns(repositoryRecord.id);
  if (repositoryRecord.enabled !== 1) {
    throw new Error(`Review repository is disabled: ${repositoryRecord.id}`);
  }
  if (!repositoryRecord.remote_provider) {
    throw new Error('Repository remote provider is not configured');
  }
  let canUseLocalRemote = hasLocalGitRemoteAccess(repositoryRecord);
  if (canUseLocalRemote) {
    await refreshRepositoryRemoteRefs(repositoryRecord);
  } else if (repositoryRecord.clone_url) {
    canUseLocalRemote = await tryRecoverLocalMirror(repositoryRecord);
    if (canUseLocalRemote) {
      await refreshRepositoryRemoteRefs(repositoryRecord);
    }
  }
  if (
    !canUseLocalRemote &&
    (!repositoryRecord.remote_repo_slug || !repositoryRecord.platform_token)
  ) {
    throw new Error('Repository remote slug or platform token is missing');
  }

  const profiles = (
    await Promise.all(
      (
        await listMatchingReviewProfiles({
          repositoryId: repositoryRecord.id,
          stage: 'push',
          sourceMode: 'remote',
        })
      ).map((record) => normalizeProfileRecord(record)),
    )
  ).filter(profileSupportsRemotePushReview);
  if (profiles.length === 0) {
    const emptySummary = summarizeBranchTriggerResults([], 0);
    return {
      repository: await normalizeRepositoryRecord(repositoryRecord),
      provider: repositoryRecord.remote_provider,
      branches: emptySummary.branches,
      summary: emptySummary,
    };
  }

  const branchSummaries = await listRemoteBranchSummaries(repositoryRecord);
  setRemoteBranchSummariesCache(
    repositoryRecord.id,
    branchSummaries,
    Date.now(),
  );
  const branchSummaryByName = new Map(
    branchSummaries.map((entry) => [normalizeBranchName(entry.name), entry]),
  );
  const defaultBranch =
    branchSummaries.find((entry) => entry.defaultBranch)?.name ||
    normalizeBranchName(repositoryRecord.default_target_branch || '') ||
    'main';
  const uniqueBranches = resolveRemoteSyncBranches({
    profiles,
    remoteBranches: branchSummaries.map((entry) => entry.name),
    defaultBranch,
  });
  const applyActiveWindow = profiles.some((profile) =>
    hasAllBranchesTarget(profile),
  );
  const activeWindowDays = applyActiveWindow
    ? REPO_REVIEW_ALL_BRANCHES_ACTIVE_WINDOW_DAYS
    : 0;

  const branchResults = await mapWithConcurrencyLimit(
    uniqueBranches,
    REPO_REVIEW_SYNC_PREPARATION_CONCURRENCY,
    async (branch) => {
      const head = branchSummaryByName.get(branch);
      if (!head?.headSha) {
        return {
          branch,
          headSha: '',
          status: 'error',
          reason: '无法获取分支最新提交。',
        } satisfies QueuedRepoReviewBranchResult;
      }
      if (
        applyActiveWindow &&
        branch !== defaultBranch &&
        !isBranchActiveWithinWindow(head.latestCommitAt, activeWindowDays)
      ) {
        return {
          branch,
          headSha: head.headSha,
          status: 'skipped',
          reason: t(
            'repoReview.branchNotInActiveWindow',
            { days: activeWindowDays },
            undefined,
          ),
        } satisfies QueuedRepoReviewBranchResult;
      }

      return buildQueuedRemoteBranchResult({
        repository: repositoryRecord,
        branch,
        userId: input.userId,
        head: {
          headSha: head.headSha,
          parentSha: head.parentSha,
          actor: head.actor,
        },
        defaultBranch,
        trigger: 'manual-sync',
      });
    },
  );

  return {
    repository: await normalizeRepositoryRecord(repositoryRecord),
    provider: repositoryRecord.remote_provider!,
    branches: branchResults,
    summary: summarizeBranchTriggerResults(branchResults, activeWindowDays),
  };
}

export async function triggerRemoteBranchReview(input: {
  repositoryId: string;
  branch: string;
  userId?: string;
}): Promise<RepoReviewExecutionSummary> {
  ensureRepoReviewStartupRecovery();
  const repository = await requireRepository(input.repositoryId);
  if (!repository.remote_provider) {
    throw new Error('Repository does not have a remote provider configured');
  }
  const branch = normalizeBranchName(input.branch);
  if (!branch) {
    throw new Error('branch is required');
  }

  await recoverStaleRepoReviewRuns(repository.id);

  const cachedBranchSummary = getCachedRemoteBranchSummary(
    repository.id,
    branch,
  );
  const usedCachedBranchSummary = Boolean(cachedBranchSummary);
  if (!cachedBranchSummary && hasLocalGitRemoteAccess(repository)) {
    await refreshRepositoryRemoteRefs(repository);
  }
  const defaultBranch =
    getCachedRemoteDefaultBranch(repository.id) ||
    (cachedBranchSummary?.defaultBranch ? branch : '') ||
    (await fetchRemoteRepositoryDefaultBranch(repository));
  const branchHead = cachedBranchSummary
    ? {
        headSha: cachedBranchSummary.headSha,
        parentSha: cachedBranchSummary.parentSha,
        actor: cachedBranchSummary.actor,
        title: cachedBranchSummary.title,
        latestCommitAt: cachedBranchSummary.latestCommitAt,
      }
    : await fetchRemoteBranchHead(repository, branch);
  if (!branchHead.headSha) {
    throw new Error(`Unable to resolve branch head for ${branch}`);
  }
  const activeBranchState = await getReviewBranchState({
    repositoryId: repository.id,
    stage: 'push',
    branch,
  });
  if (
    activeBranchState?.head_sha === branchHead.headSha &&
    (activeBranchState.status === 'queued' ||
      activeBranchState.status === 'running') &&
    activeBranchState.last_run_id
  ) {
    const activeRunRecord = await getReviewRunById(
      activeBranchState.last_run_id,
    );
    if (activeRunRecord) {
      return buildRepoReviewExecutionSummary(
        await normalizeRunRecord(activeRunRecord),
        {
          reused: true,
          reuseReason: '该分支已有审查任务执行中，重复点击已忽略。',
          usedCachedBranchSummary,
        },
      );
    }
  }
  const baseline = await resolveRemoteReviewBaseline({
    repository,
    stage: 'push',
    branch,
    headSha: branchHead.headSha,
    parentSha: branchHead.parentSha,
    defaultBranch,
  });
  if (!baseline.baseSha) {
    throw new Error('无法确定审查基线提交。');
  }
  return executeRepoReviewEvent({
    source: repository.remote_provider,
    stage: 'push',
    repositoryId: repository.id,
    userId: input.userId,
    ref: `refs/heads/${branch}`,
    branch,
    baseSha: baseline.baseSha,
    headSha: branchHead.headSha,
    actor: branchHead.actor || 'manual-sync',
    blockingExpected: false,
    callbackContext: {
      manualSync: true,
      baseBranch: baseline.baseBranch,
      baselineSource: baseline.baselineSource,
    },
  }).then((result) => ({
    ...result,
    usedCachedBranchSummary,
  }));
}

export async function upsertRepoReviewRepository(
  payload: Record<string, unknown>,
): Promise<RepoReviewRepository> {
  return (await saveRepoReviewRepositoryConfig(payload)).repository;
}

export async function removeRepoReviewRepository(
  repositoryId: string,
): Promise<void> {
  clearLocalGitRemoteMetadataCache();
  clearRemoteBranchSummariesCache(repositoryId);
  repoReviewAutoSyncInFlight.delete(repositoryId);
  reviewExecutionQueue.removeWhere(
    (item) => item.repositoryId === repositoryId,
  );
  await deleteReviewConversationBindingByRepositoryId(repositoryId);
  await deleteReviewRepository(repositoryId);
}

export async function saveRepoReviewProfileConfig(
  payload: Record<string, unknown>,
): Promise<RepoReviewProfileSaveResult> {
  const existing = stringValue(payload.id)
    ? await getReviewProfileById(stringValue(payload.id))
    : undefined;
  const saved = await normalizeProfileRecord(
    await saveReviewProfile(await normalizeProfileInput(payload, existing)),
  );
  return { profile: saved };
}

export async function upsertRepoReviewProfile(
  payload: Record<string, unknown>,
): Promise<RepoReviewProfile> {
  const existing = stringValue(payload.id)
    ? await getReviewProfileById(stringValue(payload.id))
    : undefined;
  const saved = await saveReviewProfile(
    await normalizeProfileInput(payload, existing),
  );
  return await normalizeProfileRecord(saved);
}

export async function removeRepoReviewProfile(
  profileId: string,
): Promise<void> {
  await deleteReviewProfile(profileId);
}

export async function triggerLocalRepoReview(input: {
  repositoryId?: string;
  repoPath?: string;
  stage: ReviewStage;
  profileId?: string;
  userId?: string;
}): Promise<{
  blocked: boolean;
  message: string;
  runs: Array<{
    profile: RepoReviewProfile;
    run: RepoReviewRun;
    blocked: boolean;
  }>;
}> {
  ensureRepoReviewStartupRecovery();
  const repository = input.repositoryId
    ? await getReviewRepositoryById(input.repositoryId)
    : input.repoPath
      ? await findRepositoryByLocalPath(input.repoPath)
      : undefined;
  if (!repository) {
    throw new Error('No configured review repository matched this request');
  }
  const matchedProfile = input.profileId
    ? await getReviewProfileById(input.profileId)
    : await selectMatchingProfileRecord(repository, {
        source: 'local-hook',
        stage: input.stage,
        repositoryId: repository.id,
        blockingExpected: true,
      });
  const result = await executeRepoReviewEvent({
    source: 'local-hook',
    stage: input.stage,
    repositoryId: repository.id,
    userId: input.userId,
    blockingExpected: true,
    profileId: stringValue(input.profileId) || matchedProfile?.id || undefined,
  });
  const profile: RepoReviewProfile = matchedProfile
    ? await normalizeProfileRecord(matchedProfile)
    : {
        id: '',
        repositoryId: repository.id,
        name: 'No matching profile',
        stage: input.stage,
        sourceMode: 'local',
        blockingMode: 'soft_fail',
        passDecisionMode: 'ai',
        reviewScope: 'auto',
        targetBranches: [],
        skillIds: [],
        mcpServerIds: [],
        promptTemplate: '',
        includeGlobs: [],
        excludeGlobs: [],
        includeFullFileContext: false,
        maxFiles: 0,
        maxDiffBytes: 0,
        writeToChat: false,
        writeToPlatform: false,
        reviewOutputMode: 'message',
        diffSubagentThreshold: 15,
        enabled: false,
      };
  return {
    blocked: result.blocking,
    message: result.run.summary || 'Review completed.',
    runs: [
      {
        profile,
        run: result.run,
        blocked: result.blocking,
      },
    ],
  };
}

async function syncRemoteRepoReviewInternal(input: {
  repositoryRecord: ReviewRepositoryRecord;
  profiles: RepoReviewProfile[];
  explicitBranches?: string[];
  trigger: 'manual-sync' | 'auto-sync' | 'profile-save';
  updateAutoSyncScheduleAfterRun: boolean;
  userId?: string;
}): Promise<{
  repository: RepoReviewRepository;
  provider: ReviewRemoteProvider;
  branches: RepoReviewBranchTriggerResult[];
  summary: RepoReviewBranchTriggerSummary;
}> {
  ensureRepoReviewStartupRecovery();
  const { repositoryRecord } = input;
  await recoverStaleRepoReviewRuns(repositoryRecord.id);
  if (repositoryRecord.enabled !== 1) {
    throw new Error(`Review repository is disabled: ${repositoryRecord.id}`);
  }
  if (!repositoryRecord.remote_provider) {
    throw new Error('Repository remote provider is not configured');
  }
  let canUseLocalRemote = hasLocalGitRemoteAccess(repositoryRecord);
  if (canUseLocalRemote) {
    await refreshRepositoryRemoteRefs(repositoryRecord);
  } else if (repositoryRecord.clone_url) {
    canUseLocalRemote = await tryRecoverLocalMirror(repositoryRecord);
    if (canUseLocalRemote) {
      await refreshRepositoryRemoteRefs(repositoryRecord);
    }
  }
  if (
    !canUseLocalRemote &&
    (!repositoryRecord.remote_repo_slug || !repositoryRecord.platform_token)
  ) {
    throw new Error('Repository remote slug or platform token is missing');
  }

  const profiles = input.profiles.filter(profileSupportsRemotePushReview);
  if (profiles.length === 0) {
    const emptySummary = summarizeBranchTriggerResults([], 0);
    return {
      repository: await normalizeRepositoryRecord(repositoryRecord),
      provider: repositoryRecord.remote_provider,
      branches: emptySummary.branches,
      summary: emptySummary,
    };
  }

  const branchSummaries = await listRemoteBranchSummaries(repositoryRecord);
  setRemoteBranchSummariesCache(
    repositoryRecord.id,
    branchSummaries,
    Date.now(),
  );
  const branchSummaryByName = new Map(
    branchSummaries.map((entry) => [normalizeBranchName(entry.name), entry]),
  );
  const defaultBranch =
    branchSummaries.find((entry) => entry.defaultBranch)?.name ||
    normalizeBranchName(repositoryRecord.default_target_branch || '') ||
    'main';
  const explicitBranches = normalizeTargetBranches(
    input.explicitBranches || [],
  );
  const uniqueBranches =
    explicitBranches.length > 0
      ? explicitBranches
      : resolveRemoteSyncBranches({
          profiles,
          remoteBranches: branchSummaries.map((entry) => entry.name),
          defaultBranch,
        });
  const applyActiveWindow =
    explicitBranches.length === 0 &&
    profiles.some((profile) => hasAllBranchesTarget(profile));
  const activeWindowDays = applyActiveWindow
    ? REPO_REVIEW_ALL_BRANCHES_ACTIVE_WINDOW_DAYS
    : 0;

  const branchStateByName = new Map(
    (await listReviewBranchStates(repositoryRecord.id, 'push')).map((entry) => [
      normalizeBranchName(entry.branch),
      entry,
    ]),
  );
  const branchResults = await executePreparedRepoReviewBranches({
    branches: uniqueBranches,
    defaultBranch,
    applyActiveWindow,
    activeWindowDays,
    concurrency: REPO_REVIEW_SYNC_PREPARATION_CONCURRENCY,
    getHead: (branch) => {
      const head = branchSummaryByName.get(branch);
      if (!head) return undefined;
      return {
        headSha: head.headSha,
        parentSha: head.parentSha,
        actor: head.actor,
        title: head.title,
        latestCommitAt: head.latestCommitAt,
      };
    },
    getBranchState: (branch) => {
      const branchState = branchStateByName.get(branch);
      if (!branchState) return undefined;
      return {
        headSha: branchState.head_sha || '',
        status: branchState.status || '',
        resultState: branchState.result_state || '',
        lastRunId: branchState.last_run_id || undefined,
      };
    },
    isBranchActiveWithinWindow,
    resolveBaseline: async (branch, head) =>
      resolveRemoteReviewBaseline({
        repository: repositoryRecord,
        stage: 'push',
        branch,
        headSha: head.headSha,
        parentSha: head.parentSha,
        defaultBranch,
      }),
    executePreparedBranch: async (prepared) =>
      executeRepoReviewEvent({
        source: repositoryRecord.remote_provider!,
        stage: 'push',
        repositoryId: repositoryRecord.id,
        userId: input.userId,
        ref: `refs/heads/${prepared.branch}`,
        branch: prepared.branch,
        baseSha: prepared.baseline.baseSha,
        headSha: prepared.head.headSha,
        actor: prepared.head.actor,
        blockingExpected: false,
        callbackContext: {
          trigger: input.trigger,
          baseBranch: prepared.baseline.baseBranch,
          baselineSource: prepared.baseline.baselineSource,
        },
      }),
    formatTriggeredResult: (prepared, result) => ({
      branch: prepared.branch,
      headSha: prepared.head.headSha,
      status: 'triggered',
      reason: result.run.summary || t('repoReview.auto_d7ee47', {}, undefined),
      runId: result.run.id,
    }),
  });

  if (input.updateAutoSyncScheduleAfterRun) {
    updateRepositoryAutoSyncSchedule(repositoryRecord);
  }

  const summary = summarizeBranchTriggerResults(
    branchResults,
    activeWindowDays,
  );
  return {
    repository: await normalizeRepositoryRecord(repositoryRecord),
    provider: repositoryRecord.remote_provider,
    branches: branchResults,
    summary,
  };
}

export async function syncRemoteRepoReview(input: {
  repositoryId: string;
  userId?: string;
}): Promise<{
  repository: RepoReviewRepository;
  provider: ReviewRemoteProvider;
  branches: RepoReviewBranchTriggerResult[];
  summary: RepoReviewBranchTriggerSummary;
}> {
  const repositoryRecord = await requireRepository(input.repositoryId);
  const enabledPushProfiles = (
    await Promise.all(
      (
        await listMatchingReviewProfiles({
          repositoryId: repositoryRecord.id,
          stage: 'push',
          sourceMode: 'remote',
        })
      ).map((record) => normalizeProfileRecord(record)),
    )
  ).filter(profileSupportsRemotePushReview);
  return syncRemoteRepoReviewInternal({
    repositoryRecord,
    profiles: enabledPushProfiles,
    trigger: 'manual-sync',
    updateAutoSyncScheduleAfterRun: true,
    userId: input.userId,
  });
}

async function runRepoReviewAutoSyncOnce(
  repository: ReviewRepositoryRecord,
): Promise<void> {
  if (repoReviewAutoSyncInFlight.has(repository.id)) {
    return;
  }
  repoReviewAutoSyncInFlight.add(repository.id);
  const startedAt = new Date();
  try {
    await updateReviewRepositoryAutoSync({
      repositoryId: repository.id,
      lastAutoSyncAt: startedAt.toISOString(),
      lastAutoSyncStatus: 'running',
      lastAutoSyncMessage: t('repoReview.auto_7ed3f2', {}, undefined),
      nextAutoSyncAt: computeNextAutoSyncAt(
        getAutoSyncIntervalMinutes(repository),
        startedAt,
      ),
    });
    logger.info(
      { repositoryId: repository.id, repositoryName: repository.name },
      'Running scheduled repo review auto sync',
    );
    const profiles = (
      await Promise.all(
        (
          await listMatchingReviewProfiles({
            repositoryId: repository.id,
            stage: 'push',
            sourceMode: 'remote',
          })
        ).map((record) => normalizeProfileRecord(record)),
      )
    ).filter(profileSupportsRemotePushReview);
    const result = await syncRemoteRepoReviewInternal({
      repositoryRecord: repository,
      profiles,
      trigger: 'auto-sync',
      updateAutoSyncScheduleAfterRun: false,
    });
    const triggered = result.branches.filter(
      (entry) => entry.status === 'triggered',
    ).length;
    const skipped = result.branches.filter(
      (entry) => entry.status === 'skipped',
    ).length;
    const failed = result.branches.filter(
      (entry) => entry.status === 'error',
    ).length;
    const summary = summarizeAutoSyncResult({
      triggered,
      skipped,
      failed,
    });
    await updateReviewRepositoryAutoSync({
      repositoryId: repository.id,
      lastAutoSyncAt: new Date().toISOString(),
      lastAutoSyncStatus: summary.status,
      lastAutoSyncMessage: summary.message,
      nextAutoSyncAt: computeNextAutoSyncAt(
        getAutoSyncIntervalMinutes(repository),
      ),
    });
  } catch (err) {
    logger.error(
      { err, repositoryId: repository.id },
      'Scheduled repo review auto sync failed',
    );
    await updateReviewRepositoryAutoSync({
      repositoryId: repository.id,
      lastAutoSyncAt: new Date().toISOString(),
      lastAutoSyncStatus: 'error',
      lastAutoSyncMessage: err instanceof Error ? err.message : String(err),
      nextAutoSyncAt: computeNextAutoSyncAt(
        getAutoSyncIntervalMinutes(repository),
      ),
    });
  } finally {
    repoReviewAutoSyncInFlight.delete(repository.id);
  }
}

export function startRepoReviewAutoSyncLoop(): void {
  if (repoReviewAutoSyncLoopStarted) {
    logger.debug('Repo review auto sync loop already running');
    return;
  }
  ensureRepoReviewStartupRecovery();
  void recoverStaleRepoReviewRuns();
  repoReviewAutoSyncLoopStarted = true;
  logger.debug('Repo review auto sync loop started');

  const loop = async () => {
    try {
      await recoverStaleRepoReviewRuns();
      const nowIso = new Date().toISOString();
      const dueRepositories =
        await listDueReviewRepositoriesForAutoSync(nowIso);
      for (const repository of dueRepositories) {
        // Sequential execution keeps SCM/API pressure predictable.
        // eslint-disable-next-line no-await-in-loop
        await runRepoReviewAutoSyncOnce(repository);
      }
    } catch (err) {
      logger.error({ err }, 'Repo review auto sync loop failed');
    }
    repoReviewAutoSyncTimerHandle = setTimeout(
      loop,
      REPO_REVIEW_AUTO_SYNC_LOOP_INTERVAL_MS,
    );
  };

  void loop();
}

/** @internal - for tests only. */
export function _resetRepoReviewAutoSyncLoopForTests(): void {
  repoReviewAutoSyncLoopStarted = false;
  if (repoReviewAutoSyncTimerHandle !== null) {
    clearTimeout(repoReviewAutoSyncTimerHandle);
    repoReviewAutoSyncTimerHandle = null;
  }
  repoReviewStartupRecoveryApplied = false;
  repoReviewAutoSyncInFlight.clear();
}

/** @internal - for tests only. */
export async function _executeQueuedRepoReviewRunForTests(
  runId: string,
): Promise<RepoReviewExecutionSummary> {
  return await executeQueuedRepoReviewRun(runId);
}

/** @internal - for tests only. */
export async function _provisionRepoReviewCloudDocForTests(input: {
  repository: RepoReviewRepository;
  run: RepoReviewRun;
}): Promise<{
  run: RepoReviewRun;
  result: RepoReviewCloudDocResult | null;
}> {
  return await maybeProvisionRepoReviewCloudDoc(input);
}

const REVIEW_QUEUE_MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.NANOCLAW_REVIEW_QUEUE_CONCURRENCY) || 2,
);
const reviewExecutionQueue =
  createRepoReviewExecutionQueue<RepoReviewQueueItem>({
    concurrency: REVIEW_QUEUE_MAX_CONCURRENCY,
    execute: (item) => executeQueuedRepoReviewRun(item.runId),
    onError: (err, item) => {
      failQueuedRepoReviewRun(
        item.runId,
        err instanceof Error ? err.message : String(err),
      );
      logger.error({ err, item }, 'Failed to execute queued repo review');
    },
  });

export async function enqueueRemoteRepoReview(event: RepoReviewEvent): Promise<{
  queued: boolean;
  reused: boolean;
  runId?: string | undefined;
  reason?: string | undefined;
}> {
  const queued = await createQueuedReviewRunForEvent(event);
  if ('runRecord' in queued) {
    await enqueueQueuedRepoReviewRun(queued.runRecord);
    return {
      queued: true,
      reused: false,
      runId: queued.runRecord.id,
    };
  }
  return {
    queued: false,
    reused: Boolean(queued.summary.reused),
    runId: queued.summary.run.id,
    reason: queued.summary.reuseReason || queued.summary.run.summary || '',
  };
}

function buildHookBody(
  repositoryId: string,
  stage: ReviewStage,
  nanoclawRoot: string,
): string {
  const stageLabel =
    stage === 'commit'
      ? t('repoReview.auto_fed3f9', {}, undefined)
      : t('repoReview.auto_b65fc9', {}, undefined);
  return [
    HOOK_MARKER_START,
    'if [ -n "$SKIP_NANOCLAW_REVIEW" ]; then',
    '  exit 0',
    'fi',
    t('repoReview.shellReviewStart', { stageLabel }, undefined),
    `node "${nanoclawRoot}/dist/cli.js" --nanoclaw-root "${nanoclawRoot}" review-trigger --repository-id "${repositoryId}" --stage ${stage}`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    t('repoReview.shellReviewFailed', { stageLabel }, undefined),
    '  exit "$status"',
    'fi',
    t('repoReview.shellReviewPassed', { stageLabel }, undefined),
    HOOK_MARKER_END,
  ].join('\n');
}

export function setRepoReviewMessageSender(
  sender:
    | ((jid: string, message: StructuredOutboundMessage) => Promise<void>)
    | null,
): void {
  repoReviewMessageSender = sender;
}

/** @internal - for tests only. */
export function setRepoReviewCloudDocHandlersForTests(
  handlers: RepoReviewCloudDocHandlers | null,
): void {
  repoReviewCloudDocHandlersForTests = handlers;
}

function upsertHookSnippet(filePath: string, body: string): void {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '#!/bin/sh\n';
  const next = existing.includes(HOOK_MARKER_START)
    ? existing.replace(
        new RegExp(`${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}`, 'm'),
        body,
      )
    : `${existing.trimEnd()}\n\n${body}\n`;
  fs.writeFileSync(filePath, next, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function removeHookSnippet(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (!existing.includes(HOOK_MARKER_START)) return;
  const next = existing
    .replace(
      new RegExp(`\n?${HOOK_MARKER_START}[\\s\\S]*?${HOOK_MARKER_END}\n?`, 'm'),
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n');
  if (!next.trim() || next.trim() === '#!/bin/sh') {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.writeFileSync(filePath, next, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

export async function installRepoReviewHooks(input: {
  repositoryId: string;
  nanoclawRoot: string;
}): Promise<{
  repository: RepoReviewRepository;
  hooksPath: string;
  hooks: string[];
}> {
  const repository = await requireRepository(input.repositoryId);
  const repoPath = stringValue(repository.local_repo_path);
  if (!repoPath) {
    throw new Error('Repository does not have local_repo_path');
  }
  const hooksDir = path.join(repoPath, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const nanoclawRoot = path.resolve(input.nanoclawRoot);
  upsertHookSnippet(
    path.join(hooksDir, 'pre-commit'),
    buildHookBody(input.repositoryId, 'commit', nanoclawRoot),
  );
  upsertHookSnippet(
    path.join(hooksDir, 'pre-push'),
    buildHookBody(input.repositoryId, 'push', nanoclawRoot),
  );
  return {
    repository: await normalizeRepositoryRecord(repository),
    hooksPath: hooksDir,
    hooks: ['pre-commit', 'pre-push'],
  };
}

export async function uninstallRepoReviewHooks(input: {
  repositoryId: string;
}): Promise<{
  repository: RepoReviewRepository;
  hooksPath: string;
  hooks: string[];
}> {
  const repository = await requireRepository(input.repositoryId);
  const repoPath = stringValue(repository.local_repo_path);
  if (!repoPath) {
    throw new Error('Repository does not have local_repo_path');
  }
  const hooksDir = path.join(repoPath, '.git', 'hooks');
  removeHookSnippet(path.join(hooksDir, 'pre-commit'));
  removeHookSnippet(path.join(hooksDir, 'pre-push'));
  return {
    repository: await normalizeRepositoryRecord(repository),
    hooksPath: hooksDir,
    hooks: ['pre-commit', 'pre-push'],
  };
}
