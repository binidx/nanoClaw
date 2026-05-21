import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import type { ReviewOverall } from '../db.js';
import type { AiProvider } from '../db/assistants.js';
import {
  getDefaultProvider,
  getDefaultProviderForUser,
  getProvider,
  isProviderVisibleToUser,
} from '../db/assistants.js';
import {
  requestAgentClose,
  runAgentProcess,
  sendAgentPrompt,
  type AgentEventPayload,
  type AgentRunInput,
  type AgentRunOutput,
  type AgentTurnEventPayload,
  type AgentTurnItemPayload,
} from '../agent/agent-runner.js';
import { getProviderForModule } from '../tenant/tenant-db.js';
import { getProviderAdapter } from '../provider/provider-adapters.js';
import {
  recordPromptTrace,
  resolvePromptText,
} from '../prompt/prompt-service.js';
import {
  buildRepoReviewDiffIndex,
  getRepoReviewDiffSlice,
} from './repo-review-diff-index.js';
import { buildRepoReviewFindingEvidenceKey } from './repo-review-doc-render.js';
import { buildStructuredRepoReviewMarkdown } from './repo-review-messages.js';
import { mapWithConcurrencyLimit } from './repo-review-sync-service.js';
import {
  buildRepoReviewReadOnlyAllowedDirectories,
  stringValue,
  type RepoReviewCommitReview,
  type RepoReviewEvent,
  type RepoReviewExecutionStats,
  type RepoReviewFileReview,
  type RepoReviewProgressStep,
  type RepoReviewProgressStepKind,
  type RepoReviewProfile,
  type RepoReviewRepository,
  type RepoReviewAssistantTurn,
  type RepoReviewRunFinding,
  type RepoReviewTurnPhase,
  type ReviewEvidenceBundle as PreparedReviewEvidenceBundle,
  type ReviewPreparedContext,
  asRecord,
} from './repo-review-model.js';
import {
  REPO_REVIEW_FIXED_REPORT_TEMPLATE_BLOCK,
  REPO_REVIEW_REDUCER_TEMPLATE,
  REPO_REVIEW_WORKER_TEMPLATE,
} from './repo-review-prompt-templates.js';
import { REPO_REVIEW_AGENT_SYSTEM_PROMPT } from './repo-review-agent-system-prompt.js';
import type { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

const MAX_FULL_FILE_BYTES_PER_FILE = 64 * 1024;
const MAX_TOTAL_FULL_FILE_BYTES = 240 * 1024;
const MAX_WORKER_CHUNK_BYTES = 60 * 1024;
const MAX_WORKER_CHUNK_FILE_COUNT = 8;
const MAX_WORKER_CHUNK_MERGE_PROMPT_BYTES = 96 * 1024;
const MAX_WORKER_CHUNK_MERGE_FILE_COUNT = 12;
const DEFAULT_WORKER_TIMEOUT_MS = Math.max(
  50,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS) ||
    Number(process.env.NANOCLAW_REVIEW_WORKER_TIMEOUT_MS) ||
    420_000,
);
const WORKER_TIMEOUT_MS = Math.max(50, DEFAULT_WORKER_TIMEOUT_MS);
const WORKER_TIMEOUT_GRACE_MS = Math.max(
  25,
  Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS) ||
    Number(process.env.NANOCLAW_REVIEW_WORKER_TIMEOUT_GRACE_MS) ||
    180_000,
);
const MAIN_REVIEW_TIMEOUT_GRACE_MS = Math.max(
  25,
  Number(process.env.NANOCLAW_REVIEW_MAIN_TIMEOUT_GRACE_MS) ||
    Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS) ||
    180_000,
);
const DEFAULT_MAIN_REVIEW_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.NANOCLAW_REVIEW_MAIN_TIMEOUT_MS) || 0,
);
const REDUCER_TIMEOUT_MS = 120_000;
const MAX_DIRECT_MAIN_AGENT_PROMPT_BYTES = Math.max(
  16 * 1024,
  Number(process.env.NANOCLAW_REVIEW_MAIN_DIRECT_PROMPT_MAX_BYTES) || 96 * 1024,
);

export interface RepoReviewEvidenceFile {
  filePath: string;
  diffText: string;
  diffBytes: number;
  fileContent: string;
  fileContentBytes: number;
  fileContentSource: 'workspace' | 'omitted' | 'unavailable';
  fileContentReason?: string;
  groupKey: string;
  isTestFile: boolean;
  language: string;
}

export interface RepoReviewEvidenceChunk {
  id: string;
  title: string;
  files: RepoReviewEvidenceFile[];
  diffBytes: number;
  fileContentBytes: number;
  promptBytes: number;
}

export interface RepoReviewEvidenceBundle {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  workspacePath: string;
  diffIndex?: ReviewPreparedContext['diffIndex'];
  files: RepoReviewEvidenceFile[];
  changedFiles: string[];
  diffBytes: number;
  fileContentBytes: number;
  totalPromptBytes: number;
  commitSummaryBlock: string;
  projectContextBlock: string;
  graphEvidenceBundle?: PreparedReviewEvidenceBundle;
  directMainAgentReview: boolean;
}

export interface RepoReviewExecutionPlan {
  strategy: 'main_only' | 'worker_then_main';
  changedFileCount: number;
  diffSubagentThreshold: number;
  moduleCount: number;
  maxSubagents: number;
  maxWorkerCount: number;
  workerCount: number;
  includeFullFileContext: boolean;
  lazyFullFileContext: boolean;
}

export interface RepoReviewTimeoutFollowupSummary {
  summary: string;
  readFiles: string[];
  confirmedIssues: string[];
  remainingChecks: string[];
  confidence: 'high' | 'medium' | 'low';
  mainAgentQuestions: string[];
}

export interface RepoReviewWorkerResult {
  chunk: RepoReviewEvidenceChunk;
  checkedFiles: string[];
  reviewedFiles: string[];
  findings: RepoReviewRunFinding[];
  evidenceRequests: string[];
  scopeLimitations: string[];
  confidence: 'high' | 'medium' | 'low';
  needsCrossFileReduction: boolean;
  failed: boolean;
  timedOut: boolean;
  followupRequested: boolean;
  followupSummaryReceived: boolean;
  timeoutStatus?:
    | 'timeout_followup_requested'
    | 'timeout_followup_completed'
    | 'timeout_partial_output_preserved'
    | 'timeout_followup_failed'
    | 'timeout_killed';
  failureReason?: string;
  timeoutFollowupSummary?: RepoReviewTimeoutFollowupSummary;
  rawOutput: string;
  turns: RepoReviewAssistantTurn[];
}

export interface RepoReviewStructuredResult {
  overall: ReviewOverall;
  summary: string;
  findings: RepoReviewRunFinding[];
  scopeLimitations: string[];
  suggestions: string[];
  recommendedBlock: boolean;
  markdownBody: string;
  rawModelOutput: string;
  commitReviews: RepoReviewCommitReview[];
  fileReviews: RepoReviewFileReview[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value || '', 'utf8');
}

function trimBlock(value: string, maxBytes: number): string {
  const text = String(value || '').trim();
  if (!text) return '';
  if (byteLength(text) <= maxBytes) return text;
  return `${text.slice(0, Math.max(0, maxBytes - 1)).trimEnd()}…`;
}

function normalizeLine(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function splitPathSegments(filePath: string): string[] {
  return String(filePath || '')
    .split('/')
    .filter(Boolean);
}

function getGroupKey(filePath: string): string {
  const segments = splitPathSegments(filePath);
  const top = segments[0] || '(root)';
  const second = segments[1] || '';
  const isTest = /(?:^|[./_-])(test|tests|spec|specs)(?:$|[./_-])/i.test(
    filePath,
  );
  if (isTest) return `${top}/tests`;
  if (second) return `${top}/${second}`;
  return top;
}

function isTestFile(filePath: string): boolean {
  return /(?:^|[./_-])(test|tests|spec|specs)(?:$|[./_-])/i.test(filePath);
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'ts';
    case '.js':
    case '.jsx':
      return 'js';
    case '.py':
      return 'py';
    case '.go':
      return 'go';
    case '.rs':
      return 'rs';
    case '.java':
      return 'java';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    default:
      return ext.replace(/^\./, '') || 'text';
  }
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

function normalizeSeverity(value: unknown): 'high' | 'medium' | 'low' {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low') return text;
  return 'low';
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low') return text;
  return 'medium';
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeLine(String(value || ''));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeFindings(entries: unknown[]): RepoReviewRunFinding[] {
  return entries
    .map((entry): RepoReviewRunFinding | null => {
      const record = asRecord(entry);
      const title = normalizeLine(stringValue(record.title));
      const detail = normalizeLine(stringValue(record.detail));
      if (!title && !detail) return null;
      const finding: RepoReviewRunFinding = {
        severity: normalizeSeverity(record.severity),
        title: title || detail || '未命名问题',
        detail: detail || title || '暂无详细说明。',
      };
      if (stringValue(record.file)) {
        finding.file = stringValue(record.file);
      }
      if (stringValue(record.line)) {
        finding.line = stringValue(record.line);
      }
      if (stringValue(record.codeSnippet || record.code_snippet)) {
        finding.codeSnippet = stringValue(
          record.codeSnippet || record.code_snippet,
        );
      }
      if (stringValue(record.fixCode || record.fix_code)) {
        finding.fixCode = stringValue(record.fixCode || record.fix_code);
      }
      if (stringValue(record.evidence)) {
        finding.evidence = stringValue(record.evidence);
      }
      if (stringValue(record.evidenceKey || record.evidence_key)) {
        finding.evidenceKey = stringValue(
          record.evidenceKey || record.evidence_key,
        );
      }
      if (stringValue(record.suggestion)) {
        finding.suggestion = stringValue(record.suggestion);
      }
      return finding;
    })
    .filter((entry): entry is RepoReviewRunFinding => Boolean(entry));
}

function normalizeFindingDedupSegment(
  value: string | null | undefined,
  maxLength = 400,
): string {
  return normalizeLine(stringValue(value)).toLowerCase().slice(0, maxLength);
}

function buildFindingDedupKeys(finding: RepoReviewRunFinding): string[] {
  const file = stringValue(finding.file);
  const line = stringValue(finding.line);
  const severity = normalizeSeverity(finding.severity);
  const title = normalizeFindingDedupSegment(finding.title);
  const detail = normalizeFindingDedupSegment(finding.detail);
  const evidence = normalizeFindingDedupSegment(finding.evidence);
  const suggestion = normalizeFindingDedupSegment(finding.suggestion);
  const codeSnippet = normalizeFindingDedupSegment(finding.codeSnippet);
  const fixCode = normalizeFindingDedupSegment(finding.fixCode);
  const evidenceKey = normalizeFindingDedupSegment(finding.evidenceKey);
  const keys = new Set<string>();

  if (evidenceKey) {
    keys.add(`evidence:${evidenceKey}`);
  }
  const titleKey = buildRepoReviewFindingEvidenceKey(finding);
  if (titleKey.trim()) {
    keys.add(`title:${normalizeFindingDedupSegment(titleKey)}`);
  }
  if (file && detail) {
    keys.add(`detail:${file}::${detail}`);
  }
  if (file && line && severity) {
    if (codeSnippet && fixCode) {
      keys.add(`snippet_fix:${file}::${line}::${severity}::${codeSnippet}::${fixCode}`);
    }
    if (codeSnippet && suggestion) {
      keys.add(`snippet_suggestion:${file}::${line}::${severity}::${codeSnippet}::${suggestion}`);
    }
    if (codeSnippet && evidence) {
      keys.add(`snippet_evidence:${file}::${line}::${severity}::${codeSnippet}::${evidence}`);
    }
    if (codeSnippet && !fixCode && !suggestion && !evidence) {
      keys.add(`snippet:${file}::${line}::${severity}::${codeSnippet}`);
    }
  }

  return Array.from(keys.values());
}

function findingsOverlap(
  left: RepoReviewRunFinding,
  right: RepoReviewRunFinding,
): boolean {
  const leftKeys = buildFindingDedupKeys(left);
  if (leftKeys.length === 0) return false;
  const rightKeys = new Set(buildFindingDedupKeys(right));
  if (rightKeys.size === 0) return false;
  return leftKeys.some((key) => rightKeys.has(key));
}

function dedupeFindings(
  findings: RepoReviewRunFinding[],
): RepoReviewRunFinding[] {
  const deduped: RepoReviewRunFinding[] = [];
  for (const finding of findings) {
    if (deduped.some((existing) => findingsOverlap(existing, finding))) {
      continue;
    }
    deduped.push(finding);
  }
  return deduped;
}

export function mergeCanonicalRepoReviewFindings(
  canonicalFindings: RepoReviewRunFinding[],
  supplementalFindings: RepoReviewRunFinding[],
): RepoReviewRunFinding[] {
  return dedupeFindings([...canonicalFindings, ...supplementalFindings]);
}

function buildStructuredMarkdownFallback(
  result: RepoReviewStructuredResult,
): string {
  return buildStructuredRepoReviewMarkdown({
    summary: result.summary,
    findings: result.findings,
    commitReviews: result.commitReviews,
    suggestions: result.suggestions,
  } as any);
}

function slugifyId(value: string): string {
  return (
    String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'repo-review'
  );
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

function buildAgentRunInput(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prompt: string;
  runId: string;
  runtimeNamespace?: string;
  workspacePath?: string | null;
  userId?: string;
  providerOverrideId?: string;
  toolPolicy?: 'none' | 'readonly' | 'full';
  allowedDirectoriesOverride?: string[];
}): AgentRunInput {
  const reviewChatJid =
    input.repository.reviewChatJid || `repo-review:${input.repository.id}`;
  const agentInput: AgentRunInput = {
    prompt: {
      text: input.prompt,
      stableSystemPrompt: REPO_REVIEW_AGENT_SYSTEM_PROMPT,
    },
    groupFolder: buildReviewGroup(input.repository).folder,
    chatJid: reviewChatJid,
    isMain: false,
    isScheduledTask: true,
    suppressDefaultSystemPrompt: true,
    suppressScheduledTaskPreamble: true,
    disableDefaultWebSearch: true,
    ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
    assistantName: 'NanoClaw',
    runtimeNamespace: input.runtimeNamespace || input.runId,
    managedSkillIds: input.profile.skillIds,
    managedMcpServerIds: input.profile.mcpServerIds,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.providerOverrideId
      ? { providerOverrideId: input.providerOverrideId }
      : {}),
  };
  const reviewWorkspacePath =
    input.workspacePath || input.repository.localRepoPath;
  if (reviewWorkspacePath) {
    const allowedDirectories =
      input.allowedDirectoriesOverride &&
      input.allowedDirectoriesOverride.length > 0
        ? input.allowedDirectoriesOverride.map((entry) => path.resolve(entry))
        : buildRepoReviewReadOnlyAllowedDirectories(
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
  return agentInput;
}

function buildWorkerToolInstructionBlock(
  includeFullFileContext: boolean,
): string {
  const lines = [
    '## 工具使用要求',
    '- 你必须至少执行一次只读工具调用来核对关键证据。',
    '- 优先使用 `read_file` / `grep` / `glob` / `list_dir` / `bash` 的只读 git 命令。',
    '- 如果需要核对差异，优先用 `git diff` 或 `git show`。',
    '- 禁止写文件、禁止任何修改操作、禁止派生子代理。',
    includeFullFileContext
      ? '- 允许按需读取本 worker 变更文件的全文；未变更文件只读取与 1-hop 关系直接相关的小片段。'
      : '- 全文补证未开启；不要读取完整文件，只能用 diff 和必要的短片段核验证据。',
    '- 你只能在本任务提供的文件范围、1-hop 相关片段和只读工作区内探索。',
  ];
  return lines.join('\n');
}

interface RepoReviewTurnContext {
  groupKey: string;
  groupLabel: string;
  phase: RepoReviewTurnPhase;
}

function buildRepoReviewTurnContext(input: {
  groupKey: string;
  groupLabel: string;
  phase: RepoReviewTurnPhase;
}): RepoReviewTurnContext {
  return {
    groupKey: input.groupKey,
    groupLabel: input.groupLabel,
    phase: input.phase,
  };
}

function applyRepoReviewTurnContext(
  turn: RepoReviewAssistantTurn,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn {
  if (!context) return turn;
  return {
    ...turn,
    groupKey: turn.groupKey || context.groupKey,
    groupLabel: turn.groupLabel || context.groupLabel,
    phase: turn.phase || context.phase,
  };
}

function createRepoReviewTurn(
  turnId: string,
  timestamp: string,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn {
  return {
    id: turnId,
    timestamp,
    isLive: true,
    isCompleted: false,
    items: [],
    ...(context
      ? {
          groupKey: context.groupKey,
          groupLabel: context.groupLabel,
          phase: context.phase,
        }
      : {}),
  };
}

function upsertRepoReviewTurn(
  turns: RepoReviewAssistantTurn[],
  turnId: string,
  timestamp: string,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) {
    return [...turns, createRepoReviewTurn(turnId, timestamp, context)];
  }
  const copy = [...turns];
  copy[index] = {
    ...applyRepoReviewTurnContext(copy[index]!, context),
    timestamp: copy[index]!.timestamp || timestamp,
    isLive: true,
  };
  return copy;
}

function upsertRepoReviewTurnItem(
  turns: RepoReviewAssistantTurn[],
  event: Extract<
    AgentTurnEventPayload,
    { type: 'item.started' | 'item.updated' | 'item.completed' }
  >,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const turnIndex = turns.findIndex((turn) => turn.id === event.turnId);
  const baseTurn =
    turnIndex >= 0
      ? applyRepoReviewTurnContext(turns[turnIndex]!, context)
      : createRepoReviewTurn(event.turnId, event.timestamp, context);
  const items = [...baseTurn.items];
  const itemIndex = items.findIndex((item) => item.id === event.item.id);
  const nextItem = {
    ...event.item,
    timestamp: event.timestamp,
    ...(event.item.type === 'tool_call'
      ? { subagentInfo: event.item.subagentInfo }
      : {}),
  } as AgentTurnItemPayload;
  if (itemIndex < 0) {
    items.push(nextItem);
  } else {
    items[itemIndex] = {
      ...(items[itemIndex] as AgentTurnItemPayload),
      ...nextItem,
    };
  }
  const nextTurn: RepoReviewAssistantTurn = {
    ...baseTurn,
    timestamp: baseTurn.timestamp || event.timestamp,
    items,
    isLive: true,
    isCompleted: baseTurn.isCompleted,
  };
  const copy = turnIndex < 0 ? [...turns, nextTurn] : [...turns];
  if (turnIndex >= 0) copy[turnIndex] = nextTurn;
  return copy;
}

function markRepoReviewTurnCompleted(
  turns: RepoReviewAssistantTurn[],
  turnId: string,
  timestamp: string,
  error?: string,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  const index = turns.findIndex((turn) => turn.id === turnId);
  const turn =
    index >= 0
      ? applyRepoReviewTurnContext(turns[index]!, context)
      : createRepoReviewTurn(turnId, timestamp, context);
  const nextTurn: RepoReviewAssistantTurn = {
    ...turn,
    timestamp: turn.timestamp || timestamp,
    isLive: false,
    isCompleted: true,
    ...(error ? { error } : {}),
  };
  const copy = index < 0 ? [...turns, nextTurn] : [...turns];
  if (index >= 0) copy[index] = nextTurn;
  return copy;
}

function applyAgentTurnEvent(
  turns: RepoReviewAssistantTurn[],
  event: AgentTurnEventPayload,
  context?: RepoReviewTurnContext,
): RepoReviewAssistantTurn[] {
  if (event.type === 'turn.started') {
    return upsertRepoReviewTurn(turns, event.turnId, event.timestamp, context);
  }
  if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    return upsertRepoReviewTurnItem(turns, event, context);
  }
  if (event.type === 'turn.completed') {
    return markRepoReviewTurnCompleted(
      turns,
      event.turnId,
      event.timestamp,
      undefined,
      context,
    );
  }
  if (event.type === 'turn.failed') {
    return markRepoReviewTurnCompleted(
      turns,
      event.turnId,
      event.timestamp,
      event.error,
      context,
    );
  }
  return turns;
}

function extractLatestCompletedAssistantMessageText(
  turns: RepoReviewAssistantTurn[],
): string {
  return extractLatestRepoReviewAssistantMessageText(turns, {
    allowInProgress: false,
    requireUsableTerminalOutput: false,
    allowedTerminalKinds: ['main'],
  });
}

type RepoReviewTerminalOutputKind = 'main' | 'worker' | 'timeout_followup';

function parseRepoReviewTerminalRecord(
  text: string,
): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(extractJsonObject(trimmed)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractBalancedJson(source: string): string | null {
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
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
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractLatestRepoReviewAssistantMessageText(
  turns: RepoReviewAssistantTurn[],
  input: {
    allowInProgress: boolean;
    requireUsableTerminalOutput: boolean;
    allowedTerminalKinds: RepoReviewTerminalOutputKind[];
  },
): string {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex]!;
    for (
      let itemIndex = turn.items.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const item = turn.items[itemIndex]!;
      if (item.type !== 'assistant_message') continue;
      if (
        item.status !== 'completed' &&
        !(input.allowInProgress && item.status === 'in_progress')
      ) {
        continue;
      }
      const text = item.text.trim();
      if (
        input.requireUsableTerminalOutput &&
        !looksLikeRepoReviewTerminalOutput(text, input.allowedTerminalKinds)
      ) {
        continue;
      }
      if (text) return text;
    }
  }
  return '';
}

function buildRepoReviewAgentStatusText(event: AgentEventPayload): string {
  const body = String(event.body || '').trim();
  if (body && body !== event.title) return `${event.title}：${body}`;
  return event.title;
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

function extractJsonObject(text: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const balanced = extractBalancedJson(trimmed);
  if (balanced) return balanced;
  return trimmed;
}

function looksLikeRepoReviewTerminalOutput(
  text: string,
  allowedKinds: RepoReviewTerminalOutputKind[] = ['main'],
): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (
    allowedKinds.includes('main') &&
    /代码审查报告|markdown_body|raw_report_markdown/i.test(trimmed)
  ) {
    return true;
  }
  const parsed = parseRepoReviewTerminalRecord(trimmed);
  if (!parsed) return false;
  for (const kind of allowedKinds) {
    if (
      kind === 'main' &&
      (Boolean(stringValue(parsed.result_type || parsed.resultType)) ||
        parsed.final === true ||
        String(parsed.final || '')
          .trim()
          .toLowerCase() === 'true' ||
        (stringValue(parsed.overall) && stringValue(parsed.summary)) ||
        stringValue(parsed.markdown_body || parsed.markdownBody) ||
        stringValue(parsed.raw_report_markdown || parsed.rawReportMarkdown))
    ) {
      return true;
    }
    if (
      kind === 'worker' &&
      (Array.isArray(parsed.checked_files) ||
        Array.isArray(parsed.checkedFiles) ||
        Array.isArray(parsed.findings) ||
        Array.isArray(parsed.evidence_requests) ||
        Array.isArray(parsed.evidenceRequests) ||
        stringValue(parsed.confidence))
    ) {
      return true;
    }
    if (
      kind === 'timeout_followup' &&
      stringValue(parsed.summary) &&
      (Array.isArray(parsed.read_files) ||
        Array.isArray(parsed.readFiles) ||
        Array.isArray(parsed.remaining_checks) ||
        Array.isArray(parsed.remainingChecks) ||
        Array.isArray(parsed.main_agent_questions) ||
        Array.isArray(parsed.mainAgentQuestions))
    ) {
      return true;
    }
  }
  return false;
}

function hasBalancedRepoReviewTerminalOutput(
  text: string,
  allowedKinds: RepoReviewTerminalOutputKind[] = ['main'],
): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return (
    Boolean(extractBalancedJson(trimmed)) &&
    looksLikeRepoReviewTerminalOutput(trimmed, allowedKinds)
  );
}

function getRepoReviewTerminalOutputScore(text: string): number {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  if (hasBalancedRepoReviewTerminalOutput(trimmed)) return 3;
  if (looksLikeRepoReviewTerminalOutput(trimmed)) return 2;
  return 1;
}

function preferRepoReviewTerminalOutput(
  current: string,
  candidate: string,
): string {
  const currentScore = getRepoReviewTerminalOutputScore(current);
  const candidateScore = getRepoReviewTerminalOutputScore(candidate);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore === currentScore && String(candidate || '').trim()) {
    return candidate;
  }
  return current;
}

async function resolveReviewProvider(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  runId: string;
  userId?: string;
}): Promise<AiProvider> {
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
      profileProviderId = '';
    }
  }
  if (profileProviderId) {
    const provider = await getProvider(profileProviderId);
    if (provider) return provider;
  }
  if (input.userId) {
    const userDefault = await getDefaultProviderForUser(input.userId);
    if (userDefault) return userDefault;
  }
  const moduleProvider = await getProviderForModule(
    'code_review',
    input.userId,
  );
  if (moduleProvider) {
    const provider = await getProvider(moduleProvider.id);
    if (provider) return provider;
  }
  const fallbackProvider = input.userId
    ? await getDefaultProviderForUser(input.userId)
    : await getDefaultProvider();
  if (fallbackProvider) return fallbackProvider;
  throw new Error('No default AI provider configured');
}

async function runProviderTextCall(input: {
  provider: AiProvider;
  prompt: string;
  promptKey: string;
  featureScope: string;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
  timeoutMs: number;
  maxTokens: number;
  systemPromptText?: string | null;
}): Promise<{ text: string; model?: string; timedOut: boolean }> {
  const adapter = getProviderAdapter(input.provider.type);
  const start = Date.now();
  const request = adapter.generateText(input.provider, input.prompt, {
    maxTokens: input.maxTokens,
  });
  const timeout = new Promise<{
    text: string;
    model?: string;
    timedOut: boolean;
  }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ text: '', timedOut: true });
    }, input.timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([
    request.then((value) => ({ ...value, timedOut: false })),
    timeout,
  ]);
  logger.debug(
    {
      promptKey: input.promptKey,
      providerType: input.provider.type,
      model: input.provider.model || null,
      durationMs: Date.now() - start,
      timedOut: result.timedOut,
    },
    'Repo review provider call finished',
  );
  if (result.timedOut) {
    return result;
  }
  return {
    text: result.text || '',
    model: result.model,
    timedOut: false,
  };
}

async function runBoundedReviewAgent(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  prompt: string;
  runId: string;
  runtimeNamespace?: string;
  workspacePath?: string | null;
  userId?: string;
  providerOverrideId?: string;
  toolPolicy?: 'none' | 'readonly' | 'full';
  allowedDirectoriesOverride?: string[];
  turnContext?: RepoReviewTurnContext;
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
  onStatusEvent?: (event: AgentEventPayload) => Promise<void>;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  timeoutGraceMs?: number;
  timeoutFollowupPrompt?: string;
  onTimeoutFollowupDispatched?: () => void | Promise<void>;
}): Promise<{
  outputText: string;
  timedOut: boolean;
  timeoutFollowupSent: boolean;
  timeoutFollowupCompleted: boolean;
  timeoutFollowupOutputText: string;
  turns: RepoReviewAssistantTurn[];
}> {
  const group = buildReviewGroup(input.repository);
  const agentInput = buildAgentRunInput({
    repository: input.repository,
    profile: input.profile,
    prompt: input.prompt,
    runId: input.runtimeNamespace || input.runId,
    runtimeNamespace: input.runtimeNamespace || input.runId,
    workspacePath: input.workspacePath,
    userId: input.userId,
    providerOverrideId: input.providerOverrideId,
    toolPolicy: input.toolPolicy,
    allowedDirectoriesOverride: input.allowedDirectoriesOverride,
  });
  let agentProcess: import('child_process').ChildProcess | null = null;
  let reviewTurns: RepoReviewAssistantTurn[] = [];
  let streamedResult = '';
  let latestResultText = '';
  let latestCompletedAssistantMessageText = '';
  let latestUsableAssistantMessageText = '';
  let timeoutFollowupOutputText = '';
  let sawTurnEvent = false;
  let terminalOutputSeen = false;
  let closeRequested = false;
  let timedOut = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let idleTimeoutTimer: NodeJS.Timeout | null = null;
  let timeoutGraceTimer: NodeJS.Timeout | null = null;
  let timeoutFollowupSent = false;
  let timeoutFollowupCompleted = false;
  let timeoutFollowupTurnBoundary = -1;
  let currentPhase = input.turnContext?.phase || 'worker';
  let sawTerminalTurnBoundary = false;
  let earlyTerminalTimer: NodeJS.Timeout | null = null;
  const resolveAllowedTerminalKinds = (): RepoReviewTerminalOutputKind[] => {
    if (currentPhase === 'timeout_followup') {
      return ['timeout_followup', 'worker'];
    }
    if (currentPhase === 'worker') {
      return ['worker'];
    }
    return ['main'];
  };
  let earlyTerminalOutputResolved = false;
  let resolveEarlyTerminalOutput: ((value: AgentRunOutput) => void) | null =
    null;
  const earlyTerminalOutputPromise = new Promise<AgentRunOutput>((resolve) => {
    resolveEarlyTerminalOutput = resolve;
  });
  const emitTurns = async () => {
    await input.onTurnProgress?.(reviewTurns);
  };
  const settleEarlyTerminalOutputIfReady = (force = false) => {
    if (earlyTerminalOutputResolved || !terminalOutputSeen) return;
    if (!force && sawTurnEvent && !sawTerminalTurnBoundary) {
      if (!earlyTerminalTimer) {
        earlyTerminalTimer = setTimeout(() => {
          earlyTerminalTimer = null;
          settleEarlyTerminalOutputIfReady(true);
        }, 750);
        earlyTerminalTimer.unref?.();
      }
      return;
    }
    if (earlyTerminalTimer) {
      clearTimeout(earlyTerminalTimer);
      earlyTerminalTimer = null;
    }
    const text =
      streamedResult || latestResultText || latestUsableAssistantMessageText;
    if (!String(text || '').trim()) return;
    earlyTerminalOutputResolved = true;
    resolveEarlyTerminalOutput?.({
      status: 'success',
      result: text,
    });
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
      // Best effort.
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
          // Best effort.
        }
      }, 1_000).unref?.();
    } catch {
      // Best effort.
    }
  };
  const maybeRecordFollowupOutput = (text: string) => {
    if (!timeoutFollowupSent) return;
    if (!text.trim()) return;
    timeoutFollowupOutputText = text;
    timeoutFollowupCompleted = true;
  };
  const idleTimeoutMs =
    typeof input.idleTimeoutMs === 'number' &&
    Number.isFinite(input.idleTimeoutMs)
      ? Math.max(0, Math.trunc(input.idleTimeoutMs))
      : 0;
  let resolveIdleTimeoutResult: ((value: AgentRunOutput) => void) | null = null;
  const idleTimeoutPromise =
    idleTimeoutMs > 0
      ? new Promise<AgentRunOutput>((resolve) => {
          resolveIdleTimeoutResult = resolve;
        })
      : null;
  const scheduleIdleTimeout = () => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimeoutTimer) {
      clearTimeout(idleTimeoutTimer);
    }
    idleTimeoutTimer = setTimeout(() => {
      resolveIdleTimeoutResult?.({
        status: 'error',
        result: null,
        error: `Review agent idle timeout after ${Math.round(idleTimeoutMs / 1000)}s`,
      });
    }, idleTimeoutMs);
    idleTimeoutTimer.unref?.();
  };

  try {
    const processPromise = runAgentProcess(
      group,
      agentInput,
      (proc) => {
        agentProcess = proc;
      },
      async (output: AgentRunOutput) => {
        scheduleIdleTimeout();
        if (output.event) {
          await input.onStatusEvent?.(output.event);
        }
        if (output.turnEvent) {
          sawTurnEvent = true;
          reviewTurns = applyAgentTurnEvent(reviewTurns, output.turnEvent, {
            groupKey: input.turnContext?.groupKey || input.runId,
            groupLabel: input.turnContext?.groupLabel || input.runId,
            phase: currentPhase,
          });
          latestCompletedAssistantMessageText =
            extractLatestCompletedAssistantMessageText(reviewTurns) ||
            latestCompletedAssistantMessageText;
          latestUsableAssistantMessageText =
            extractLatestRepoReviewAssistantMessageText(reviewTurns, {
              allowInProgress: true,
              requireUsableTerminalOutput: true,
              allowedTerminalKinds: resolveAllowedTerminalKinds(),
            }) || latestUsableAssistantMessageText;
          await emitTurns();
          if (
            timeoutFollowupSent &&
            timeoutFollowupTurnBoundary >= 0 &&
            reviewTurns.length > timeoutFollowupTurnBoundary
          ) {
            const followupTurns = reviewTurns.slice(
              timeoutFollowupTurnBoundary,
            );
            const followupText = extractLatestRepoReviewAssistantMessageText(
              followupTurns,
              {
                allowInProgress: true,
                requireUsableTerminalOutput: true,
                allowedTerminalKinds: ['timeout_followup', 'worker'],
              },
            );
            if (followupText) {
              maybeRecordFollowupOutput(followupText);
            }
          }
          if (
            (output.turnEvent.type === 'item.completed' ||
              output.turnEvent.type === 'item.updated') &&
            output.turnEvent.item.type === 'assistant_message' &&
            (output.turnEvent.item.status === 'completed' ||
              output.turnEvent.item.status === 'in_progress') &&
            hasBalancedRepoReviewTerminalOutput(
              output.turnEvent.item.text,
              resolveAllowedTerminalKinds(),
            )
          ) {
            streamedResult = preferRepoReviewTerminalOutput(
              streamedResult,
              output.turnEvent.item.text,
            );
            maybeRecordFollowupOutput(output.turnEvent.item.text);
            terminalOutputSeen = true;
            closeAgentInput();
            settleEarlyTerminalOutputIfReady();
          }
          if (
            output.turnEvent.type === 'turn.completed' ||
            output.turnEvent.type === 'turn.failed'
          ) {
            sawTerminalTurnBoundary = true;
            closeAgentInput();
            settleEarlyTerminalOutputIfReady(true);
          }
        }
        if (output.result) {
          terminalOutputSeen = true;
          latestResultText = output.result;
          streamedResult = preferRepoReviewTerminalOutput(
            streamedResult,
            output.result,
          );
          maybeRecordFollowupOutput(output.result);
          if (
            !sawTurnEvent ||
            getRepoReviewTerminalOutputScore(output.result) >= 2
          ) {
            sawTerminalTurnBoundary = true;
            closeAgentInput();
            settleEarlyTerminalOutputIfReady(true);
          }
        } else if (output.status === 'error') {
          terminalOutputSeen = true;
          closeAgentInput();
        }
      },
    );

    const timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? Math.max(0, Math.trunc(input.timeoutMs))
        : WORKER_TIMEOUT_MS;
    scheduleIdleTimeout();
    const timeoutGraceMs =
      typeof input.timeoutGraceMs === 'number' &&
      Number.isFinite(input.timeoutGraceMs)
        ? Math.max(0, Math.trunc(input.timeoutGraceMs))
        : WORKER_TIMEOUT_GRACE_MS;
    const resolveTimeout = () => {
      timedOut = true;
      if (timeoutGraceTimer) {
        clearTimeout(timeoutGraceTimer);
        timeoutGraceTimer = null;
      }
      forceStopAgentProcess();
      return {
        status: 'error' as const,
        result: null,
        error: `Review agent timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    };
    const timeoutPromise =
      timeoutMs > 0
        ? new Promise<AgentRunOutput>((resolve) => {
            timeoutTimer = setTimeout(() => {
              if (
                input.timeoutFollowupPrompt &&
                !timeoutFollowupSent &&
                !closeRequested
              ) {
                timeoutFollowupSent = true;
                timeoutFollowupTurnBoundary = reviewTurns.length;
                currentPhase = 'timeout_followup';
                void input.onTimeoutFollowupDispatched?.();
                try {
                  sendAgentPrompt(
                    group.folder,
                    input.runtimeNamespace || input.runId,
                    { text: input.timeoutFollowupPrompt },
                    `${input.runId}-timeout-followup`,
                  );
                } catch {
                  resolve(resolveTimeout());
                  return;
                }
                timeoutGraceTimer = setTimeout(() => {
                  resolve(resolveTimeout());
                }, timeoutGraceMs);
                timeoutGraceTimer.unref?.();
                return;
              }
              resolve(resolveTimeout());
            }, timeoutMs);
          })
        : null;

    const result = timeoutPromise
      ? await Promise.race([
          processPromise,
          timeoutPromise,
          ...(idleTimeoutPromise ? [idleTimeoutPromise] : []),
          earlyTerminalOutputPromise,
        ])
      : await Promise.race([
          processPromise,
          ...(idleTimeoutPromise ? [idleTimeoutPromise] : []),
          earlyTerminalOutputPromise,
        ]);
    if (result.status === 'success' && typeof result.result === 'string') {
      terminalOutputSeen = true;
      latestResultText = result.result;
      streamedResult = preferRepoReviewTerminalOutput(
        streamedResult,
        result.result,
      );
    } else if (
      result.status !== 'success' &&
      /idle timeout/i.test(result.error || '')
    ) {
      timedOut = true;
      forceStopAgentProcess();
    }
    if (earlyTerminalOutputResolved) {
      forceStopAgentProcess();
    }
    if (
      result.status !== 'success' &&
      !timedOut &&
      !streamedResult &&
      !latestResultText &&
      !latestCompletedAssistantMessageText &&
      !latestUsableAssistantMessageText
    ) {
      throw new Error(result.error || 'Review agent did not return a result');
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
    if (idleTimeoutTimer) {
      clearTimeout(idleTimeoutTimer);
      idleTimeoutTimer = null;
    }
    if (earlyTerminalTimer) {
      clearTimeout(earlyTerminalTimer);
      earlyTerminalTimer = null;
    }
  }

  if (timeoutFollowupSent) {
    const followupTurns =
      timeoutFollowupTurnBoundary >= 0
        ? reviewTurns.slice(timeoutFollowupTurnBoundary)
        : reviewTurns;
    if (!timeoutFollowupOutputText) {
      timeoutFollowupOutputText =
        extractLatestRepoReviewAssistantMessageText(followupTurns, {
          allowInProgress: true,
          requireUsableTerminalOutput: true,
          allowedTerminalKinds: ['timeout_followup', 'worker'],
        }) || '';
    }
    timeoutFollowupCompleted = Boolean(timeoutFollowupOutputText.trim());
  }
  const outputText =
    streamedResult ||
    latestResultText ||
    latestUsableAssistantMessageText ||
    '';
  return {
    outputText,
    timedOut,
    timeoutFollowupSent,
    timeoutFollowupCompleted,
    timeoutFollowupOutputText,
    turns: reviewTurns,
  };
}

const MAIN_REVIEW_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.NANOCLAW_REVIEW_MAIN_IDLE_TIMEOUT_MS) || 900_000,
);

function resolveRepoReviewDefaultWorkerTimeoutSeconds(): number {
  return Math.max(1, Math.trunc(resolveRepoReviewWorkerTimeoutMs({}) / 1000));
}

async function prepareRepoReviewScopedWorkspace(input: {
  workspacePath: string;
  runId: string;
  changedFiles: string[];
  findings: RepoReviewRunFinding[];
}): Promise<string | null> {
  const sourceRoot = stringValue(input.workspacePath);
  if (!sourceRoot) return null;
  const scopedFiles = Array.from(
    new Set(
      [
        ...input.changedFiles,
        ...input.findings.map((finding) => stringValue(finding.file)),
      ]
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  if (scopedFiles.length === 0) return null;
  const targetRoot = path.join(
    os.tmpdir(),
    'nanoclaw-review-scoped',
    slugifyId(input.runId),
  );
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  for (const relativePath of scopedFiles) {
    const sourcePath = path.resolve(sourceRoot, relativePath);
    if (!sourcePath.startsWith(path.resolve(sourceRoot) + path.sep)) continue;
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) continue;
      const targetPath = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    } catch {
      // Best effort: missing files stay absent and should be reflected as scope limitations.
    }
  }
  return targetRoot;
}

function buildWorkerEvidenceText(chunk: RepoReviewEvidenceChunk): string {
  return trimBlock(
    chunk.files
      .map((file) => {
        const blocks = [
          `### ${file.filePath}`,
          `- group: ${file.groupKey}`,
          `- language: ${file.language}`,
          `- test file: ${file.isTestFile ? 'yes' : 'no'}`,
          file.diffText ? `#### diff\n${file.diffText}` : '',
          file.fileContent
            ? `#### full file\n${file.fileContent}`
            : file.fileContentReason
              ? `#### full file\n(omitted: ${file.fileContentReason})`
              : '',
        ].filter(Boolean);
        return blocks.join('\n');
      })
      .join('\n\n'),
    MAX_WORKER_CHUNK_BYTES,
  );
}

function buildWorkerResultsPrompt(results: RepoReviewWorkerResult[]): string {
  return trimBlock(
    JSON.stringify(
      results.map((result) => ({
        chunk_id: result.chunk.id,
        title: result.chunk.title,
        checked_files: result.checkedFiles,
        findings: result.findings,
        evidence_requests: result.evidenceRequests,
        scope_limitations: result.scopeLimitations,
        confidence: result.confidence,
        needs_cross_file_reduction: result.needsCrossFileReduction,
        failed: result.failed,
        timed_out: result.timedOut,
      })),
      null,
      2,
    ),
    36 * 1024,
  );
}

function buildRepoReviewTurnSummary(turns: RepoReviewAssistantTurn[]): string {
  const summary = turns.map((turn) => ({
    id: turn.id,
    group_key: turn.groupKey || turn.id,
    group_label: turn.groupLabel || '',
    phase: turn.phase || '',
    timestamp: turn.timestamp,
    is_live: turn.isLive,
    is_completed: turn.isCompleted,
    error: turn.error || '',
    items: turn.items.map((item) => {
      const base = {
        id: item.id,
        type: item.type,
        status: item.status,
        timestamp: item.timestamp,
      };
      if (item.type === 'reasoning') {
        return {
          ...base,
          title: stringValue(item.title),
          text: trimBlock(item.text || '', 1200),
        };
      }
      if (item.type === 'tool_call') {
        return {
          ...base,
          title: stringValue(item.title),
          arguments_text: trimBlock(item.argumentsText || '', 1200),
          result_text: trimBlock(item.resultText || '', 1200),
          error_text: trimBlock(item.errorText || '', 800),
        };
      }
      return {
        ...base,
        text: trimBlock(
          'text' in item ? String((item as { text?: string }).text || '') : '',
          1200,
        ),
      };
    }),
  }));
  return trimBlock(JSON.stringify(summary, null, 2), 24 * 1024);
}

function buildRepoReviewTimeoutFollowupPrompt(input: {
  repository: RepoReviewRepository;
  prepared: ReviewPreparedContext;
  chunk: RepoReviewEvidenceChunk;
  turnCount: number;
}): string {
  return [
    '## 超时进度追问',
    `Worker：${input.chunk.id}`,
    `已观察 turn 数：${input.turnCount}`,
    '',
    '停止继续扩展取证，只基于已经检查过的内容返回当前进度总结。',
    '只返回一个 JSON 对象，不要输出 Markdown 代码块。',
    'JSON 顶层字段必须包含：',
    '{',
    '  "schema_version": "repo_review.timeout_followup.v1",',
    '  "result_type": "repo_review_timeout_followup",',
    '  "final": true,',
    '  "summary": "当前进度总结",',
    '  "read_files": ["已读取文件"],',
    '  "confirmed_issues": ["已确认问题"],',
    '  "remaining_checks": ["未完成检查"],',
    '  "confidence": "high | medium | low",',
    '  "main_agent_questions": ["需要主代理继续确认的点"]',
    '}',
  ].join('\n');
}

function buildRepoReviewWorkerPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  chunk: RepoReviewEvidenceChunk;
}): string {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return [
    '## 受控审查 Worker',
    `仓库：${input.repository.name}`,
    input.repository.language ? `主要语言：${input.repository.language}` : '',
    `阶段：${input.event.stage}`,
    `来源：${input.event.source}`,
    `执行人：${input.prepared.actor || '(unknown)'}`,
    `分支：${input.prepared.branch || '(unknown)'}`,
    `基线提交：${formatRepoReviewPromptSha(input.prepared.baseSha)}`,
    `目标提交：${formatRepoReviewPromptSha(input.prepared.headSha)}`,
    `取证范围：${diffRange}`,
    `Worker ID：${input.chunk.id}`,
    `Worker 标题：${input.chunk.title}`,
    '文件列表：',
    input.chunk.files.map((file) => `- ${file.filePath}`).join('\n'),
    '项目/图谱上下文：',
    trimBlock(
      input.prepared.projectContextBlocks.join('\n\n') || '暂无补充上下文。',
      24 * 1024,
    ),
    '证据块：',
    buildWorkerEvidenceContext(input.chunk),
    '',
    buildWorkerToolInstructionBlock(input.profile.includeFullFileContext),
    '',
    formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim()),
    '',
    '## 约束',
    '- 你只能依据本提示中的证据、允许的只读工具核验和 1-hop 相关片段做局部审查。',
    '- 不要写文件、派生子代理或扩展到不相关文件。',
    '- 如果证据不足，把限制写入 scope_limitations，不要猜测。',
    '',
    '## 输出协议',
    '只返回一个 JSON 对象，不要输出 Markdown 代码块。',
    '{',
    '  "schema_version": "repo_review.worker.v1",',
    '  "result_type": "repo_review_worker",',
    '  "final": true,',
    '  "checked_files": ["已检查的文件路径"],',
    '  "findings": [',
    '    {',
    '      "severity": "high | medium | low",',
    '      "file": "相关文件，可为空",',
    '      "line": "相关行号或行号范围，例如 12 或 12-18",',
    '      "title": "问题标题",',
    '      "codeSnippet": "当前有问题的代码片段",',
    '      "fixCode": "修复后的代码示例，可为空",',
    '      "evidence": "补充证据或上下文，可为空",',
    '      "detail": "问题说明",',
    '      "suggestion": "修复建议，可为空"',
    '    }',
    '  ],',
    '  "evidence_requests": ["需要主代理进一步补证的问题或文件，可为空"],',
    '  "scope_limitations": ["证据限制"],',
    '  "confidence": "high | medium | low",',
    '  "needs_cross_file_reduction": false',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRepoReviewReducerPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  mainResult?: RepoReviewStructuredResult | null;
}): string {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  const sections = [
    '## 审查收敛器',
    `仓库：${input.repository.name}`,
    input.repository.language ? `主要语言：${input.repository.language}` : '',
    `阶段：${input.event.stage}`,
    `来源：${input.event.source}`,
    `执行人：${input.prepared.actor || '(unknown)'}`,
    `分支：${input.prepared.branch || '(unknown)'}`,
    `基线提交：${formatRepoReviewPromptSha(input.prepared.baseSha)}`,
    `目标提交：${formatRepoReviewPromptSha(input.prepared.headSha)}`,
    `取证范围：${diffRange}`,
    '已变更文件：',
    input.bundle.changedFiles.map((file) => `- ${file}`).join('\n'),
    '',
    'Worker 结果：',
    buildWorkerResultsPrompt(input.workerResults),
  ];
  if (input.mainResult) {
    sections.push(
      '',
      '主代理补审结果：',
      trimBlock(JSON.stringify(input.mainResult, null, 2), 20 * 1024),
    );
  }
  sections.push(
    '',
    formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim()),
    '',
    '## 约束',
    '- 你只能依据全局元数据和 worker 结构化结果收敛结论。',
    '- 不要重新读取仓库，不要回灌 worker 原始 Markdown 或 rawOutput。',
    '- 需要跨文件归因时，优先合并重复发现并写入 scope_limitations。',
    '',
    '## 输出协议',
    '只返回一个 JSON 对象，不要输出 Markdown 代码块。',
    '{',
    '  "schema_version": "repo_review.reducer.v1",',
    '  "result_type": "repo_review_final",',
    '  "final": true,',
    '  "overall": "pass | warn | fail | error | skipped",',
    '  "summary": "一句话总体结论",',
    '  "findings": [',
    '    {',
    '      "severity": "high | medium | low",',
    '      "file": "相关文件，可为空",',
    '      "line": "相关行号或行号范围，例如 12 或 12-18",',
    '      "title": "问题标题",',
    '      "codeSnippet": "当前有问题的代码片段",',
    '      "fixCode": "修复后的代码示例，可为空",',
    '      "evidence": "补充证据或上下文，可为空",',
    '      "detail": "问题说明",',
    '      "suggestion": "修复建议，可为空"',
    '    }',
    '  ],',
    '  "scope_limitations": ["证据限制"],',
    '  "suggestions": ["补充建议"],',
    '  "recommended_block": false,',
    '  "markdown_body": "可直接展示的人类可读报告"',
    '}',
  );
  return sections.filter(Boolean).join('\n');
}

function buildRepoReviewMainOutputContractBlock(): string {
  return [
    '## 输出协议',
    '只返回一个 JSON 对象，不要输出 Markdown 代码块。',
    '{',
    '  "schema_version": "repo_review.main.v1",',
    '  "result_type": "repo_review_final",',
    '  "final": true,',
    '  "overall": "pass | warn | fail | error | skipped",',
    '  "summary": "一句话总体结论",',
    '  "findings": [',
    '    {',
    '      "severity": "high | medium | low",',
    '      "file": "相关文件，可为空",',
    '      "line": "相关行号或行号范围，例如 12 或 12-18",',
    '      "title": "问题标题",',
    '      "codeSnippet": "当前有问题的代码片段",',
    '      "fixCode": "修复后的代码示例，可为空",',
    '      "evidence": "补充证据或上下文，可为空",',
    '      "detail": "问题说明",',
    '      "suggestion": "修复建议，可为空"',
    '    }',
    '  ],',
    '  "scope_limitations": ["证据限制"],',
    '  "suggestions": ["补充建议"],',
    '  "recommended_block": false,',
    '  "markdown_body": "可直接展示的人类可读报告"',
    '}',
  ].join('\n');
}

function resolveRepoReviewWorkerTimeoutMs(
  profile: Partial<Pick<RepoReviewProfile, 'subagentTimeoutSeconds'>>,
): number {
  const envMs =
    Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_MS) ||
    Number(process.env.NANOCLAW_REVIEW_WORKER_TIMEOUT_MS);
  if (Number.isFinite(envMs) && envMs > 0) {
    return Math.max(50, Math.trunc(envMs));
  }
  const seconds = Math.max(
    30,
    Math.trunc(Number(profile.subagentTimeoutSeconds) || 420),
  );
  return seconds * 1000;
}

function resolveRepoReviewWorkerTimeoutGraceMs(): number {
  const envMs =
    Number(process.env.NANOCLAW_REVIEW_SUBAGENT_TIMEOUT_GRACE_MS) ||
    Number(process.env.NANOCLAW_REVIEW_WORKER_TIMEOUT_GRACE_MS);
  if (Number.isFinite(envMs) && envMs > 0) {
    return Math.max(25, Math.trunc(envMs));
  }
  return WORKER_TIMEOUT_GRACE_MS;
}

function resolveRepoReviewMainTimeoutMs(
  directReview: boolean,
  phase: 'review' | 'finalize' = 'review',
): number {
  const phaseSpecific =
    phase === 'finalize'
      ? Number(process.env.NANOCLAW_REVIEW_MAIN_FINALIZE_TIMEOUT_MS)
      : 0;
  const strategySpecific = directReview
    ? Number(process.env.NANOCLAW_REVIEW_MAIN_DIRECT_TIMEOUT_MS)
    : Number(process.env.NANOCLAW_REVIEW_MAIN_FALLBACK_TIMEOUT_MS);
  return Math.max(
    0,
    Math.trunc(
      phaseSpecific || strategySpecific || DEFAULT_MAIN_REVIEW_TIMEOUT_MS || 0,
    ),
  );
}

type RepoReviewMissingEvidenceItem = {
  index: number;
  title: string;
  file?: string;
  severity: RepoReviewRunFinding['severity'];
  missingFields: string[];
};

function getRepoReviewMissingEvidenceItems(
  findings: RepoReviewRunFinding[],
): RepoReviewMissingEvidenceItem[] {
  return findings.flatMap((finding, index) => {
    const missingFields: string[] = [];
    if (!stringValue(finding.file)) missingFields.push('file');
    if (!stringValue(finding.line)) missingFields.push('line');
    if (!stringValue(finding.codeSnippet)) missingFields.push('codeSnippet');
    if (
      (finding.severity === 'high' || finding.severity === 'medium') &&
      !stringValue(finding.fixCode)
    ) {
      missingFields.push('fixCode');
    }
    if (missingFields.length === 0) return [];
    return [
      {
        index: index + 1,
        title: stringValue(finding.title) || `finding-${index + 1}`,
        file: stringValue(finding.file) || undefined,
        severity: finding.severity,
        missingFields,
      },
    ];
  });
}

function hasRepoReviewMissingEvidence(
  findings: RepoReviewRunFinding[],
): boolean {
  return getRepoReviewMissingEvidenceItems(findings).length > 0;
}

function buildRepoReviewMainReviewPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  workerTurns: RepoReviewAssistantTurn[];
  directReview: boolean;
}): string {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  const customSections = [
    input.profile.promptTemplate.trim()
      ? formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim())
      : '',
    input.workerResults.length > 0
      ? [
          '## Worker 结构化结果',
          buildWorkerResultsPrompt(input.workerResults),
        ].join('\n')
      : '',
    input.workerTurns.length > 0
      ? [
          '## Worker Turn 证据',
          buildRepoReviewTurnSummary(input.workerTurns),
        ].join('\n')
      : '',
    !input.directReview &&
    input.workerResults.some(
      (result) =>
        result.followupSummaryReceived && result.timeoutFollowupSummary,
    )
      ? [
          '## 超时追问摘要',
          JSON.stringify(
            input.workerResults
              .filter(
                (result) =>
                  result.followupSummaryReceived &&
                  result.timeoutFollowupSummary,
              )
              .map((result) => ({
                worker_id: result.chunk.id,
                summary: result.timeoutFollowupSummary,
              })),
            null,
            2,
          ),
        ].join('\n')
      : '',
  ].filter(Boolean);
  return [
    '## 审查范围',
    `仓库：${input.repository.name}`,
    input.repository.language ? `主要语言：${input.repository.language}` : '',
    `阶段：${input.event.stage}`,
    `来源：${input.event.source}`,
    `执行人：${input.prepared.actor || '(unknown)'}`,
    `分支：${input.prepared.branch || '(unknown)'}`,
    `基线提交：${formatRepoReviewPromptSha(input.prepared.baseSha)}`,
    `目标提交：${formatRepoReviewPromptSha(input.prepared.headSha)}`,
    `取证范围：${diffRange}`,
    '变更文件：',
    input.bundle.changedFiles.map((file) => `- ${file}`).join('\n'),
    '',
    '## Evidence Bundle / 图谱上下文',
    trimBlock(input.bundle.projectContextBlock, 36 * 1024),
    '',
    '## Lazy 补证权限',
    input.event.source === 'local-hook'
      ? '- 本地 hook 触发：只读工作区可用于核对直接相关代码和 git 信息。'
      : '- 远端或同步触发：工作区可能是临时只读镜像，可核对直接相关文件和提交范围。',
    input.profile.includeFullFileContext
      ? '- includeFullFileContext 已开启：你可以用只读工具按需读取 diff 涉及文件全文；未变更文件只读取 1-hop 相关小片段。'
      : '- includeFullFileContext 未开启：不要读取完整文件；仅用 diff、已给证据和必要短片段核验。',
    '- CodeMap/CodeIndex 若为 stale/missing/error，只能作为导航线索，结论必须回到 diff/worktree 证据。',
    '',
    '## 证据',
    input.bundle.files
      .map((file) =>
        [
          `### ${file.filePath}`,
          `- group: ${file.groupKey}`,
          `- language: ${file.language}`,
          `- test file: ${file.isTestFile ? 'yes' : 'no'}`,
          file.diffText ? `#### diff\n${file.diffText}` : '',
          file.fileContent
            ? `#### full file\n${file.fileContent}`
            : file.fileContentReason
              ? `#### full file\n(omitted: ${file.fileContentReason})`
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n'),
    '',
    ...customSections,
    '',
    '## 约束',
    input.directReview
      ? '- 本次由主代理直接审查，不会再进入后续 worker 阶段。'
      : '- 这是主代理补审，必须综合 worker 结构化结果和 worker turn 证据给出最终结论。',
    '- 必须至少执行一次工具取证；优先直接调用只读工具，不要把这些只读命令包进 `bash -lc`。',
    '- 只依据本提示提供的证据下结论；证据不足时必须写入 scope_limitations。',
    '- 最终结果必须由主代理自己产出，不要把终稿责任让给 worker。',
    '- markdown_body 必须严格使用固定模板，并展示实际有问题的代码片段。',
    '- 除了最终 JSON，不要输出其它格式。',
    '',
    REPO_REVIEW_FIXED_REPORT_TEMPLATE_BLOCK,
    '',
    buildRepoReviewMainOutputContractBlock(),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRepoReviewMainFormattingPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  draftOutput: string;
  parsedDraft: RepoReviewStructuredResult | null;
  missingEvidence: RepoReviewMissingEvidenceItem[];
}): string {
  const diffRange = buildRepoReviewDiffRange({
    baseSha: input.prepared.baseSha,
    headSha: input.prepared.headSha,
  });
  return [
    '## 主代理终稿整理',
    '你已经完成本次代码审查，现在只负责输出最终报告。',
    '不要新增输入中没有的事实，不要弱化已确认的问题。',
    '最终 JSON 和 markdown_body 必须都由主代理产出。',
    '允许你使用只读工具重新读取相关文件，只为补齐缺失的 line / codeSnippet / fixCode。',
    '',
    '## 审查范围',
    `仓库：${input.repository.name}`,
    input.repository.language ? `主要语言：${input.repository.language}` : '',
    `阶段：${input.event.stage}`,
    `来源：${input.event.source}`,
    `执行人：${input.prepared.actor || '(unknown)'}`,
    `分支：${input.prepared.branch || '(unknown)'}`,
    `取证范围：${diffRange}`,
    '',
    '## Evidence Bundle / 图谱上下文',
    trimBlock(input.bundle.projectContextBlock, 24 * 1024),
    '',
    '## 证据',
    input.bundle.files
      .map((file) =>
        [
          `### ${file.filePath}`,
          `- group: ${file.groupKey}`,
          file.diffText ? `#### diff\n${file.diffText}` : '',
          file.fileContent
            ? `#### full file\n${file.fileContent}`
            : file.fileContentReason
              ? `#### full file\n(omitted: ${file.fileContentReason})`
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n'),
    '',
    input.workerResults.length > 0
      ? [
          '## Worker 结构化结果',
          buildWorkerResultsPrompt(input.workerResults),
        ].join('\n')
      : '',
    input.parsedDraft
      ? [
          '## 已抽取的主代理草稿',
          JSON.stringify(
            {
              overall: input.parsedDraft.overall,
              summary: input.parsedDraft.summary,
              findings: input.parsedDraft.findings,
              scope_limitations: input.parsedDraft.scopeLimitations,
              suggestions: input.parsedDraft.suggestions,
              recommended_block: input.parsedDraft.recommendedBlock,
              markdown_body: input.parsedDraft.markdownBody,
            },
            null,
            2,
          ),
        ].join('\n')
      : '',
    input.missingEvidence.length > 0
      ? [
          '## 缺失证据清单',
          JSON.stringify(
            input.missingEvidence.map((item) => ({
              index: item.index,
              title: item.title,
              file: item.file || null,
              severity: item.severity,
              missing_fields: item.missingFields,
            })),
            null,
            2,
          ),
        ].join('\n')
      : '',
    '## 主代理上一版原始输出',
    trimBlock(input.draftOutput, 24 * 1024) || '(empty)',
    '',
    '## 要求',
    '- 只做终稿补证和终稿整理，不要重新扩展审查范围。',
    '- 优先补齐缺失的 file、line、codeSnippet、fixCode，再生成最终 markdown_body。',
    '- 可以读取变更文件和直接相关文件的小范围内容，但不要引入新的未确认问题。',
    '- markdown_body 必须严格使用固定模板，并尽量补齐具体问题代码片段。',
    '- 如果某个问题无法给出代码片段或行号，必须在 scope_limitations 里说明原因，不能省略问题本身。',
    '',
    REPO_REVIEW_FIXED_REPORT_TEMPLATE_BLOCK,
    '',
    buildRepoReviewMainOutputContractBlock(),
  ]
    .filter(Boolean)
    .join('\n');
}

function hasFixedRepoReviewMarkdownTemplate(markdownBody: string): boolean {
  const markdown = String(markdownBody || '').trim();
  if (!markdown) return false;
  return (
    /代码审查报告/.test(markdown) &&
    /(?:^|\n)#{1,6}\s*一、审查总结/m.test(markdown) &&
    /(?:^|\n)#{1,6}\s*六、总结/m.test(markdown)
  );
}

function parseWorkerResult(
  output: string,
  chunk: RepoReviewEvidenceChunk,
  turns: RepoReviewAssistantTurn[],
): RepoReviewWorkerResult {
  try {
    const parsed = JSON.parse(extractJsonObject(output)) as Record<
      string,
      unknown
    >;
    const checkedFiles = uniqueStrings(
      Array.isArray(parsed.checked_files)
        ? parsed.checked_files.map((item) => String(item || ''))
        : Array.isArray(parsed.checkedFiles)
          ? parsed.checkedFiles.map((item) => String(item || ''))
          : chunk.files.map((file) => file.filePath),
    ).filter((file) => chunk.files.some((entry) => entry.filePath === file));
    return {
      chunk,
      checkedFiles,
      reviewedFiles: checkedFiles,
      findings: dedupeFindings(
        normalizeFindings(
          Array.isArray(parsed.findings) ? parsed.findings : [],
        ),
      ),
      evidenceRequests: uniqueStrings(
        Array.isArray(parsed.evidence_requests)
          ? parsed.evidence_requests.map((item) => String(item || ''))
          : Array.isArray(parsed.evidenceRequests)
            ? parsed.evidenceRequests.map((item) => String(item || ''))
            : [],
      ),
      scopeLimitations: uniqueStrings(
        Array.isArray(parsed.scope_limitations)
          ? parsed.scope_limitations.map((item) => String(item || ''))
          : Array.isArray(parsed.scopeLimitations)
            ? parsed.scopeLimitations.map((item) => String(item || ''))
            : [],
      ),
      confidence: normalizeConfidence(parsed.confidence),
      needsCrossFileReduction: Boolean(
        parsed.needs_cross_file_reduction ?? parsed.needsCrossFileReduction,
      ),
      failed: false,
      timedOut: Boolean(parsed.timed_out ?? parsed.timedOut),
      followupRequested: false,
      followupSummaryReceived: false,
      rawOutput: output,
      turns,
    };
  } catch {
    return {
      chunk,
      checkedFiles: chunk.files.map((file) => file.filePath),
      reviewedFiles: chunk.files.map((file) => file.filePath),
      findings: [],
      evidenceRequests: [],
      scopeLimitations: ['worker returned unstructured output'],
      confidence: 'low',
      needsCrossFileReduction: false,
      failed: true,
      timedOut: false,
      followupRequested: false,
      followupSummaryReceived: false,
      failureReason: 'worker_unstructured_output',
      rawOutput: output,
      turns,
    };
  }
}

function parseRepoReviewTimeoutFollowupSummary(
  output: string,
): RepoReviewTimeoutFollowupSummary | null {
  try {
    const parsed = JSON.parse(extractJsonObject(output)) as Record<
      string,
      unknown
    >;
    const confidence = normalizeConfidence(parsed.confidence);
    return {
      summary: String(parsed.summary || '').trim(),
      readFiles: uniqueStrings(
        Array.isArray(parsed.read_files)
          ? parsed.read_files.map((item) => String(item || ''))
          : Array.isArray(parsed.readFiles)
            ? parsed.readFiles.map((item) => String(item || ''))
            : [],
      ),
      confirmedIssues: uniqueStrings(
        Array.isArray(parsed.confirmed_issues)
          ? parsed.confirmed_issues.map((item) => String(item || ''))
          : Array.isArray(parsed.confirmedIssues)
            ? parsed.confirmedIssues.map((item) => String(item || ''))
            : [],
      ),
      remainingChecks: uniqueStrings(
        Array.isArray(parsed.remaining_checks)
          ? parsed.remaining_checks.map((item) => String(item || ''))
          : Array.isArray(parsed.remainingChecks)
            ? parsed.remainingChecks.map((item) => String(item || ''))
            : [],
      ),
      confidence,
      mainAgentQuestions: uniqueStrings(
        Array.isArray(parsed.main_agent_questions)
          ? parsed.main_agent_questions.map((item) => String(item || ''))
          : Array.isArray(parsed.mainAgentQuestions)
            ? parsed.mainAgentQuestions.map((item) => String(item || ''))
            : [],
      ),
    };
  } catch {
    return null;
  }
}

function parseReducerResult(output: string): RepoReviewStructuredResult {
  const [jsonPart, separatedMarkdownBody] = String(output || '').includes(
    '---REVIEW_BODY---',
  )
    ? String(output || '').split('---REVIEW_BODY---', 2)
    : [output, ''];
  const parsed = JSON.parse(extractJsonObject(jsonPart)) as Record<
    string,
    unknown
  >;
  const markdownBody = String(
    separatedMarkdownBody ||
      parsed.markdown_body ||
      parsed.markdownBody ||
      parsed.raw_report_markdown ||
      parsed.rawReportMarkdown ||
      '',
  ).trim();
  const findings = dedupeFindings(
    normalizeFindings(Array.isArray(parsed.findings) ? parsed.findings : []),
  );
  const scopeLimitations = uniqueStrings(
    Array.isArray(parsed.scope_limitations)
      ? parsed.scope_limitations.map((entry) => String(entry || ''))
      : Array.isArray(parsed.scopeLimitations)
        ? parsed.scopeLimitations.map((entry) => String(entry || ''))
        : [],
  );
  const suggestions = uniqueStrings(
    Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((entry) => String(entry || ''))
      : [],
  );
  const commitReviews = Array.isArray(
    parsed.commit_reviews || parsed.commitReviews,
  )
    ? ((parsed.commit_reviews ||
        parsed.commitReviews) as RepoReviewCommitReview[])
    : [];
  const fileReviews = Array.isArray(parsed.file_reviews || parsed.fileReviews)
    ? ((parsed.file_reviews || parsed.fileReviews) as RepoReviewFileReview[])
    : [];
  const extracted = extractScopeLimitationsFromStructuredResult({
    findings,
    commitReviews,
    explicitLimitations: scopeLimitations,
  });
  const result: RepoReviewStructuredResult = {
    overall: (String(parsed.overall || '').trim() || 'warn') as ReviewOverall,
    summary: String(parsed.summary || '').trim() || '审查完成。',
    findings: extracted.findings,
    scopeLimitations: extracted.scopeLimitations,
    suggestions,
    recommendedBlock: Boolean(
      parsed.recommended_block ?? parsed.recommendedBlock,
    ),
    markdownBody,
    rawModelOutput: output,
    commitReviews: extracted.commitReviews,
    fileReviews,
  };
  return result;
}

function normalizeLooseRepoReviewSeverity(
  value: string,
): RepoReviewRunFinding['severity'] {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === '高' || normalized === 'high') return 'high';
  if (normalized === '低' || normalized === 'low') return 'low';
  return 'medium';
}

function extractLooseRepoReviewSummary(markdown: string): string {
  const summaryMatch = markdown.match(
    /(?:^|\n)(?:#+\s*)?(?:一、)?审查总结\s*\n+([\s\S]*?)(?=\n(?:#+\s*)?(?:二、|三、|四、|五、|六、)|$)/,
  );
  if (summaryMatch?.[1]) {
    return normalizeLine(summaryMatch[1]);
  }
  const prefix =
    markdown.split(/\n(?:重点问题|主要问题|发现的问题)\s*\n/, 2)[0] || '';
  const lines = prefix
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(?:代码审查报告|重点问题|主要问题|发现的问题)$/.test(line) &&
        !/^[一二三四五六七八九十]+、/.test(line),
    );
  return lines.slice(0, 3).join('\n');
}

function extractFirstMarkdownCodeFence(markdown: string): {
  fence: string;
  code: string;
} | null {
  const match = String(markdown || '').match(/```[^\n`]*\n([\s\S]*?)```/);
  if (!match?.[0]) return null;
  return {
    fence: match[0].trimEnd(),
    code: String(match[1] || '').trimEnd(),
  };
}

function parseLooseRepoReviewFindings(markdown: string): {
  findings: RepoReviewRunFinding[];
  suggestions: string[];
} {
  const findings: RepoReviewRunFinding[] = [];
  const suggestions: string[] = [];
  const target =
    markdown.split(/\n(?:重点问题|主要问题|发现的问题)\s*\n/, 2)[1] || markdown;
  const blockPattern =
    /(?:^|\n)(\d+)\.\s+([^\n]+?)(?:（(高|中|低)）|\((high|medium|low)\))?\s*\n([\s\S]*?)(?=(?:\n\d+\.\s+)|$)/g;
  for (const match of target.matchAll(blockPattern)) {
    const title = normalizeLine(match[2] || '');
    const severity = normalizeLooseRepoReviewSeverity(
      String(match[3] || match[4] || ''),
    );
    const blockBody = String(match[5] || '').trim();
    const codeMatch = blockBody.match(/```[^\n`]*\n([\s\S]*?)```/);
    const codeSnippet = codeMatch?.[1]?.trimEnd();
    const bodyWithoutCode = codeMatch
      ? blockBody.replace(codeMatch[0], '').trim()
      : blockBody;
    const lines = bodyWithoutCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    let file: string | undefined;
    let line: string | undefined;
    let suggestion: string | undefined;
    const detailLines: string[] = [];
    for (const entry of lines) {
      const locationMatch = entry.match(/^([A-Za-z0-9_./@-]+):(\d+(?:-\d+)?)$/);
      if (locationMatch && !file) {
        file = locationMatch[1];
        line = locationMatch[2];
        continue;
      }
      const suggestionMatch = entry.match(/^(?:修复建议|建议)[:：]\s*(.+)$/);
      if (suggestionMatch) {
        suggestion = normalizeLine(suggestionMatch[1] || '');
        continue;
      }
      detailLines.push(entry);
    }
    if (suggestion) suggestions.push(suggestion);
    if (!title && detailLines.length === 0 && !suggestion) continue;
    findings.push({
      severity,
      title: title || '未命名问题',
      detail:
        uniqueStrings([
          detailLines.join('\n\n'),
          codeMatch?.[0]?.trimEnd() || '',
        ])
          .filter(Boolean)
          .join('\n\n') ||
        suggestion ||
        '暂无详细说明。',
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
      ...(codeSnippet ? { codeSnippet } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return {
    findings,
    suggestions: uniqueStrings(suggestions),
  };
}

function buildLocalStructuredResultFallback(input: {
  outputText: string;
  workerResults: RepoReviewWorkerResult[];
}): RepoReviewStructuredResult {
  const markdown = input.outputText || '';
  const looseParsed = parseLooseRepoReviewFindings(markdown);
  const markdownFindings: RepoReviewRunFinding[] = [...looseParsed.findings];
  const markdownSummary = extractLooseRepoReviewSummary(markdown);
  const firstCodeFence = extractFirstMarkdownCodeFence(markdown);
  const issueMatch = markdown.match(
    /-\s*`([^`]+)`:\s*([^\n]+)[\s\S]*?证据[:：]([^\n]+)(?:[\s\S]*?影响[:：]([^\n]+))?[\s\S]*?修复建议[:：]([^\n]+)/,
  );
  if (issueMatch && markdownFindings.length === 0) {
    const severity: RepoReviewRunFinding['severity'] = /高风险|high/i.test(
      markdown,
    )
      ? 'high'
      : /低风险|low/i.test(markdown)
        ? 'low'
        : 'medium';
    const [file, line] = String(issueMatch[1] || '').split(':');
    const codeSnippet = firstCodeFence?.code || '';
    markdownFindings.push({
      severity,
      file: stringValue(file) || undefined,
      line: stringValue(line) || undefined,
      title: normalizeLine(issueMatch[2] || '未命名问题'),
      detail: [
        `证据：${normalizeLine(issueMatch[3] || '')}`,
        issueMatch[4] ? `影响：${normalizeLine(issueMatch[4] || '')}` : '',
        firstCodeFence?.fence || '',
      ]
        .filter(Boolean)
        .join('\n'),
      ...(codeSnippet ? { codeSnippet } : {}),
      suggestion: normalizeLine(issueMatch[5] || '') || undefined,
    });
  }
  if (firstCodeFence && markdownFindings.length > 0) {
    const firstFinding = markdownFindings[0]!;
    const hasFenceInDetail = String(firstFinding.detail || '').includes('```');
    markdownFindings[0] = {
      ...firstFinding,
      detail: hasFenceInDetail
        ? firstFinding.detail
        : uniqueStrings([firstFinding.detail, firstCodeFence.fence])
            .filter(Boolean)
            .join('\n\n'),
      ...(!stringValue(firstFinding.codeSnippet)
        ? { codeSnippet: firstCodeFence.code }
        : {}),
    };
  }
  const findings = dedupeFindings([
    ...input.workerResults.flatMap((result) => result.findings),
    ...markdownFindings,
  ]);
  const scopeLimitations = uniqueStrings([
    'main agent returned unstructured output; local structured fallback rendered the report',
    ...input.workerResults.flatMap((result) => result.scopeLimitations),
    ...input.workerResults.flatMap((result) =>
      result.evidenceRequests.map(
        (request) => `worker evidence request: ${request}`,
      ),
    ),
  ]);
  const hasHigh = findings.some((finding) => finding.severity === 'high');
  const hasFinding = findings.length > 0;
  const summary =
    markdownSummary ||
    normalizeLine(input.outputText).slice(0, 240) ||
    (hasFinding ? '审查完成，发现候选问题。' : '审查完成，未发现明确问题。');
  const looksLikeStructuredMarkdown =
    Boolean(markdownSummary) ||
    Boolean(issueMatch) ||
    markdownFindings.length > 0 ||
    /代码审查报告|重点问题|主要问题|发现的问题|###\s*[一二三四五六七八九十]/.test(
      markdown,
    );
  if (!looksLikeStructuredMarkdown) {
    const fallbackResult: RepoReviewStructuredResult = {
      overall: 'warn',
      summary: '模型输出未完全结构化，已回退展示原始审查结果。',
      findings: [
        {
          severity: 'medium',
          title: '审查输出格式不符合要求',
          detail: '无法从模型输出中提取结构化审查结论。',
        },
      ],
      scopeLimitations: uniqueStrings([
        'main agent returned unstructured output; local structured fallback rendered the report',
        ...input.workerResults.flatMap((result) => result.scopeLimitations),
        ...input.workerResults.flatMap((result) =>
          result.evidenceRequests.map(
            (request) => `worker evidence request: ${request}`,
          ),
        ),
      ]),
      suggestions: [],
      recommendedBlock: false,
      markdownBody: '',
      rawModelOutput: input.outputText,
      commitReviews: [],
      fileReviews: [],
    };
    fallbackResult.markdownBody =
      buildStructuredMarkdownFallback(fallbackResult);
    return fallbackResult;
  }
  const result: RepoReviewStructuredResult = {
    overall: hasHigh ? 'fail' : hasFinding ? 'warn' : 'pass',
    summary,
    findings,
    scopeLimitations,
    suggestions: looseParsed.suggestions,
    recommendedBlock: hasHigh,
    markdownBody: '',
    rawModelOutput: input.outputText,
    commitReviews: [],
    fileReviews: [],
  };
  result.markdownBody = buildStructuredMarkdownFallback(result);
  return result;
}

function looksLikeFinalizableLooseRepoReviewOutput(
  outputText: string,
): boolean {
  const text = String(outputText || '').trim();
  if (!text) return false;
  if (/代码审查报告|(?:^|\n)\s*#{1,6}\s*[一二三四五六七八九十]、/.test(text)) {
    return false;
  }
  return /重点问题|主要问题|发现的问题|高风险|中风险|低风险|修复建议|风险等级|(?:^|\n)\s*\d+\.\s+/i.test(
    text,
  );
}

function withGeneratedRepoReviewMarkdown(
  result: RepoReviewStructuredResult,
): RepoReviewStructuredResult {
  if (stringValue(result.markdownBody)) {
    return result;
  }
  return {
    ...result,
    markdownBody: buildStructuredMarkdownFallback(result),
  };
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

function isScopeLimitationText(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return REVIEW_SCOPE_LIMITATION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
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

function extractScopeLimitationsFromStructuredResult(input: {
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
    if (message) scopeLimitations.push(message);
    return false;
  });
  const commitReviews = input.commitReviews.map((review) => ({
    ...review,
    issues: review.issues.filter((issue) => {
      if (!isScopeLimitationText(issue)) return true;
      scopeLimitations.push(issue);
      return false;
    }),
  }));
  return {
    findings,
    scopeLimitations: uniqueStrings(scopeLimitations),
    commitReviews,
  };
}

function buildPromptFileBlock(file: RepoReviewEvidenceFile): string {
  return [
    `### ${file.filePath}`,
    `- group: ${file.groupKey}`,
    `- language: ${file.language}`,
    `- test file: ${file.isTestFile ? 'yes' : 'no'}`,
    `- diff bytes: ${file.diffBytes}`,
    `- full file bytes: ${file.fileContentBytes}`,
    file.diffText ? `#### diff\n${trimBlock(file.diffText, 12 * 1024)}` : '',
    file.fileContent
      ? `#### full file\n${trimBlock(file.fileContent, 12 * 1024)}`
      : file.fileContentReason
        ? `#### full file\n(omitted: ${file.fileContentReason})`
        : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildWorkerEvidenceContext(chunk: RepoReviewEvidenceChunk): string {
  return trimBlock(
    chunk.files.map((file) => buildPromptFileBlock(file)).join('\n\n'),
    40 * 1024,
  );
}

async function resolveWorkerPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  chunk: RepoReviewEvidenceChunk;
  targetUserId?: string;
}): Promise<Awaited<ReturnType<typeof resolvePromptText>>> {
  return resolvePromptText({
    promptKey: 'repo_review.worker',
    targetUserId: input.targetUserId || undefined,
    variables: {
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
      diffRange: buildRepoReviewDiffRange({
        baseSha: input.prepared.baseSha,
        headSha: input.prepared.headSha,
      }),
      workerId: input.chunk.id,
      workerTitle: input.chunk.title,
      workerFiles: input.chunk.files
        .map((file) => `- ${file.filePath}`)
        .join('\n'),
      workerEvidence: buildWorkerEvidenceContext(input.chunk),
      customPromptBlock: [
        buildWorkerToolInstructionBlock(input.profile.includeFullFileContext),
        formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim()),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    fallbackText: REPO_REVIEW_WORKER_TEMPLATE,
  });
}

async function resolveReducerPrompt(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  targetUserId?: string;
}): Promise<Awaited<ReturnType<typeof resolvePromptText>>> {
  return resolvePromptText({
    promptKey: 'repo_review.reducer',
    targetUserId: input.targetUserId || undefined,
    variables: {
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
      diffRange: buildRepoReviewDiffRange({
        baseSha: input.prepared.baseSha,
        headSha: input.prepared.headSha,
      }),
      changedFiles: input.bundle.changedFiles
        .map((file) => `- ${file}`)
        .join('\n'),
      workerResults: buildWorkerResultsPrompt(input.workerResults),
      customPromptBlock: formatRepoReviewCustomPromptBlock(
        input.profile.promptTemplate.trim(),
      ),
    },
    fallbackText: REPO_REVIEW_REDUCER_TEMPLATE,
  });
}

export function shouldDirectMainAgentReview(input: {
  changedFileCount: number;
  totalPromptBytes: number;
  diffSubagentThreshold: number;
  maxMainAgentPromptBytes?: number;
}): boolean {
  const threshold = Math.max(0, Math.trunc(input.diffSubagentThreshold));
  const maxMainAgentPromptBytes = Math.max(
    0,
    Math.trunc(input.maxMainAgentPromptBytes ?? 0),
  );
  return (
    input.changedFileCount < threshold &&
    (maxMainAgentPromptBytes <= 0 ||
      input.totalPromptBytes <= maxMainAgentPromptBytes)
  );
}

function buildGraphAwareGroupKeys(input: {
  changedFiles: string[];
  graphEvidenceBundle?: PreparedReviewEvidenceBundle;
}): Map<string, string> {
  const changedFileSet = new Set(input.changedFiles);
  const adjacency = new Map<string, Set<string>>();
  const addFile = (filePath: string) => {
    if (!changedFileSet.has(filePath)) return;
    if (!adjacency.has(filePath)) adjacency.set(filePath, new Set());
  };
  const connect = (left: string, right: string) => {
    if (
      !changedFileSet.has(left) ||
      !changedFileSet.has(right) ||
      left === right
    )
      return;
    addFile(left);
    addFile(right);
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  };
  for (const filePath of input.changedFiles) addFile(filePath);

  const graph = input.graphEvidenceBundle;
  if (graph) {
    const functionFileById = new Map(
      graph.impactGraph.functions.map((fn) => [fn.id, fn.filePath] as const),
    );
    for (const edge of graph.impactGraph.edges) {
      const fromFile =
        functionFileById.get(edge.fromFunctionId) ||
        edge.fromFunction?.filePath ||
        '';
      const toFile =
        functionFileById.get(edge.toFunctionId) ||
        edge.toFunction?.filePath ||
        '';
      connect(fromFile, toFile);
    }
  }

  const byStem = new Map<string, string[]>();
  for (const filePath of input.changedFiles) {
    const baseName = path
      .basename(filePath)
      .replace(/\.(test|spec)(?=\.)/i, '');
    const stem = baseName.replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem) continue;
    const files = byStem.get(stem) || [];
    files.push(filePath);
    byStem.set(stem, files);
  }
  for (const files of byStem.values()) {
    if (files.length < 2) continue;
    const [first, ...rest] = files;
    for (const file of rest) connect(first!, file);
  }

  const result = new Map<string, string>();
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const filePath of input.changedFiles) {
    if (visited.has(filePath)) continue;
    const stack = [filePath];
    const component: string[] = [];
    visited.add(filePath);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    component.sort((left, right) => left.localeCompare(right, 'en'));
    components.push(component);
  }
  components.sort((left, right) => left[0]!.localeCompare(right[0]!, 'en'));
  components.forEach((component, index) => {
    const fallback = getGroupKey(component[0] || '');
    const groupKey = component.length > 1 ? `graph/${index + 1}` : fallback;
    for (const filePath of component) result.set(filePath, groupKey);
  });
  return result;
}

function resolveRepoReviewCoordinatorWorkerLimit(
  maxSubagents?: number,
): number {
  return Math.max(1, Math.trunc(Number(maxSubagents) || 1));
}

async function createEvidenceBundle(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  workspacePath?: string | null;
}): Promise<RepoReviewEvidenceBundle> {
  const workspacePath = input.workspacePath || input.repository.localRepoPath;
  const diffIndex =
    input.prepared.diffIndex ||
    buildRepoReviewDiffIndex(input.prepared.diffText);
  const graphGroupKeys = buildGraphAwareGroupKeys({
    changedFiles: input.prepared.changedFiles,
    graphEvidenceBundle: input.prepared.evidenceBundle,
  });
  const files: RepoReviewEvidenceFile[] = [];
  for (const filePath of input.prepared.changedFiles) {
    const diffText = getRepoReviewDiffSlice(diffIndex, [filePath]) || '';
    const diffBytes = byteLength(diffText);
    let fileContent = '';
    let fileContentBytes = 0;
    let fileContentSource: RepoReviewEvidenceFile['fileContentSource'] =
      'omitted';
    let fileContentReason: string | undefined;
    if (input.profile.includeFullFileContext) {
      fileContentReason =
        'lazy full file context enabled; reviewer may read changed files on demand';
    } else {
      fileContentReason = 'full file context disabled';
    }
    files.push({
      filePath,
      diffText,
      diffBytes,
      fileContent,
      fileContentBytes,
      fileContentSource,
      fileContentReason,
      groupKey: graphGroupKeys.get(filePath) || getGroupKey(filePath),
      isTestFile: isTestFile(filePath),
      language: inferLanguage(filePath),
    });
  }
  const diffBytes = byteLength(input.prepared.diffText || '');
  const fileContentBytes = files.reduce(
    (total, file) => total + file.fileContentBytes,
    0,
  );
  const projectContextBlock =
    input.prepared.projectContextBlocks.length > 0
      ? `项目上下文：\n${input.prepared.projectContextBlocks.join('\n\n')}`
      : '项目上下文：暂无补充上下文。';
  const totalPromptBytes =
    diffBytes + fileContentBytes + byteLength(projectContextBlock);
  const directMainAgentReview = shouldDirectMainAgentReview({
    changedFileCount: input.prepared.changedFiles.length,
    totalPromptBytes,
    diffSubagentThreshold: input.profile.diffSubagentThreshold,
    maxMainAgentPromptBytes: MAX_DIRECT_MAIN_AGENT_PROMPT_BYTES,
  });
  return {
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    workspacePath,
    diffIndex,
    files,
    changedFiles: input.prepared.changedFiles.slice(),
    diffBytes,
    fileContentBytes,
    totalPromptBytes,
    commitSummaryBlock:
      input.prepared.commitSummaryLines.length > 0
        ? `Commits in this branch update:\n${input.prepared.commitSummaryLines.map((line) => `- ${line}`).join('\n')}`
        : '',
    projectContextBlock,
    graphEvidenceBundle: input.prepared.evidenceBundle,
    directMainAgentReview,
  };
}

function partitionEvidenceChunks(
  bundle: RepoReviewEvidenceBundle,
): RepoReviewEvidenceChunk[] {
  if (bundle.directMainAgentReview) {
    return [];
  }
  const sorted = [...bundle.files].sort((left, right) => {
    const groupCompare = left.groupKey.localeCompare(right.groupKey, 'en');
    if (groupCompare !== 0) return groupCompare;
    return left.filePath.localeCompare(right.filePath, 'en');
  });
  const chunks: RepoReviewEvidenceChunk[] = [];
  let current: RepoReviewEvidenceChunk | null = null;
  const flush = () => {
    if (current && current.files.length > 0) {
      current.promptBytes = byteLength(buildWorkerEvidenceText(current));
      chunks.push(current);
    }
    current = null;
  };
  for (const file of sorted) {
    const nextFiles = current ? [...current.files, file] : [file];
    const nextChunk: RepoReviewEvidenceChunk = current
      ? {
          ...current,
          files: nextFiles,
          diffBytes: current.diffBytes + file.diffBytes,
          fileContentBytes: current.fileContentBytes + file.fileContentBytes,
          promptBytes: 0,
        }
      : {
          id: `worker_chunk_${chunks.length + 1}`,
          title: `${chunks.length + 1}`,
          files: nextFiles,
          diffBytes: file.diffBytes,
          fileContentBytes: file.fileContentBytes,
          promptBytes: 0,
        };
    const nextPromptBytes = byteLength(buildWorkerEvidenceText(nextChunk));
    if (
      current &&
      (nextChunk.files.length > MAX_WORKER_CHUNK_FILE_COUNT ||
        nextPromptBytes > MAX_WORKER_CHUNK_BYTES)
    ) {
      flush();
      current = {
        id: `worker_chunk_${chunks.length + 1}`,
        title: `${chunks.length + 1}`,
        files: [file],
        diffBytes: file.diffBytes,
        fileContentBytes: file.fileContentBytes,
        promptBytes: 0,
      };
      continue;
    }
    current = nextChunk;
    current.promptBytes = nextPromptBytes;
  }
  flush();
  return chunks.map((chunk, index) => ({
    ...chunk,
    id: `worker_chunk_${index + 1}`,
    title: `${index + 1}/${chunks.length}`,
  }));
}

export async function buildRepoReviewEvidenceBundle(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  workspacePath?: string | null;
}): Promise<RepoReviewEvidenceBundle> {
  return createEvidenceBundle(input);
}

export function partitionRepoReviewEvidenceChunks(
  bundle: RepoReviewEvidenceBundle,
  maxChunkCount = Number.POSITIVE_INFINITY,
): RepoReviewEvidenceChunk[] {
  const chunks = partitionEvidenceChunks(bundle);
  const effectiveMaxChunkCount = Number.isFinite(maxChunkCount)
    ? Math.max(1, Math.trunc(maxChunkCount))
    : Number.POSITIVE_INFINITY;
  if (chunks.length <= effectiveMaxChunkCount) {
    return chunks;
  }

  const merged = chunks.map((chunk) => ({ ...chunk, files: [...chunk.files] }));
  while (merged.length > effectiveMaxChunkCount) {
    let mergeIndex = -1;
    let smallestPromptBytes = Number.POSITIVE_INFINITY;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const left = merged[index]!;
      const right = merged[index + 1]!;
      const combinedFileCount = left.files.length + right.files.length;
      const combinedPromptBytes = left.promptBytes + right.promptBytes;
      if (
        combinedFileCount > MAX_WORKER_CHUNK_MERGE_FILE_COUNT ||
        combinedPromptBytes > MAX_WORKER_CHUNK_MERGE_PROMPT_BYTES
      ) {
        continue;
      }
      if (combinedPromptBytes < smallestPromptBytes) {
        smallestPromptBytes = combinedPromptBytes;
        mergeIndex = index;
      }
    }
    if (mergeIndex < 0) break;
    const left = merged[mergeIndex]!;
    const right = merged[mergeIndex + 1]!;
    const nextChunk: RepoReviewEvidenceChunk = {
      ...left,
      files: [...left.files, ...right.files],
      diffBytes: left.diffBytes + right.diffBytes,
      fileContentBytes: left.fileContentBytes + right.fileContentBytes,
      promptBytes: 0,
    };
    nextChunk.promptBytes = byteLength(buildWorkerEvidenceText(nextChunk));
    merged.splice(mergeIndex, 2, nextChunk);
  }

  return merged.map((chunk, index) => ({
    ...chunk,
    id: `worker_chunk_${index + 1}`,
    title: `${index + 1}/${merged.length}`,
  }));
}

async function runWorker(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  chunk: RepoReviewEvidenceChunk;
  workerIndex: number;
  workerCount: number;
  runId: string;
  userId?: string;
  executionStats?: RepoReviewExecutionStats;
  onTurnProgress?: (turns: RepoReviewAssistantTurn[]) => Promise<void>;
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
}): Promise<RepoReviewWorkerResult> {
  const stepId = input.chunk.id;
  const stepLabel = `Worker ${input.chunk.title}`;
  const workerTimeoutMs = resolveRepoReviewWorkerTimeoutMs(input.profile);
  const workerTimeoutGraceMs = resolveRepoReviewWorkerTimeoutGraceMs();
  await input.onProgressStep?.({
    id: stepId,
    label: stepLabel,
    status: 'running',
    detail: `等待 agent 取证：${input.chunk.files.length} 个文件`,
    kind: 'worker',
    inputText: `files:\n${input.chunk.files.map((file) => `- ${file.filePath}`).join('\n')}`,
  });
  const workerPrompt = buildRepoReviewWorkerPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    chunk: input.chunk,
  });
  const provider = await resolveReviewProvider({
    repository: input.repository,
    profile: input.profile,
    runId: input.runId,
    userId: input.userId,
  }).catch(() => null);
  if (input.executionStats) {
    input.executionStats.modelCallCount =
      (input.executionStats.modelCallCount || 0) + 1;
    input.executionStats.promptBytesBuilt =
      (input.executionStats.promptBytesBuilt || 0) + byteLength(workerPrompt);
  }
  await recordPromptTrace({
    traceKind: 'agent_envelope',
    promptKey: 'repo_review.worker',
    featureScope: 'repo_review',
    targetUserId: input.userId ?? '',
    provider: provider?.type || 'agent-runtime-default',
    model: provider?.model || null,
    systemPromptText: null,
    userPromptText: workerPrompt,
    providerInputText: workerPrompt,
    resolution: [
      {
        promptKey: 'repo_review.worker',
        featureScope: 'repo_review',
        source: 'builtin',
        ownerUserId: '',
        configured: false,
      },
    ],
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      chunkId: input.chunk.id,
      fileCount: input.chunk.files.length,
      promptBytes: byteLength(workerPrompt),
    },
  }).catch((err) =>
    logger.warn({ err }, 'Failed to persist repo review prompt trace'),
  );
  await input.onProgressStep?.({
    id: stepId,
    label: stepLabel,
    status: 'running',
    detail: `等待 agent 取证：${input.chunk.files.length} 个文件`,
    kind: 'worker',
    inputText: formatProgressKeyValues([
      ['worker_index', input.workerIndex + 1],
      ['worker_count', input.workerCount],
      ['files', input.chunk.files.length],
      ['prompt_bytes', byteLength(workerPrompt)],
    ]),
  });
  const response = await runBoundedReviewAgent({
    repository: input.repository,
    profile: input.profile,
    prompt: workerPrompt,
    runId: input.runId,
    runtimeNamespace: `${input.runId}:worker:${input.chunk.id}`,
    workspacePath: input.bundle.workspacePath,
    userId: input.userId,
    providerOverrideId: provider?.id,
    turnContext: buildRepoReviewTurnContext({
      groupKey: stepId,
      groupLabel: stepLabel,
      phase: 'worker',
    }),
    onTurnProgress: async (turns) => {
      await input.onTurnProgress?.(turns);
    },
    timeoutMs: workerTimeoutMs,
    timeoutGraceMs: workerTimeoutGraceMs,
    timeoutFollowupPrompt: buildRepoReviewTimeoutFollowupPrompt({
      repository: input.repository,
      prepared: input.prepared,
      chunk: input.chunk,
      turnCount: input.chunk.files.length,
    }),
    onTimeoutFollowupDispatched: async () => {
      if (input.executionStats) {
        input.executionStats.timeoutFollowupCount =
          (input.executionStats.timeoutFollowupCount || 0) + 1;
      }
      await input.onProgressStep?.({
        id: 'worker_timeout_followup',
        label: 'Worker 超时追问',
        status: 'running',
        detail: `Worker ${input.chunk.title} 达到 ${Math.round(workerTimeoutMs / 1000)}s，发送同会话追问`,
        kind: 'worker',
        inputText: formatProgressKeyValues([
          ['worker', stepLabel],
          ['timeout_status', 'timeout_followup_requested'],
          ['timeout_ms', workerTimeoutMs],
          ['grace_ms', workerTimeoutGraceMs],
        ]),
      });
    },
    onStatusEvent: async (event) => {
      if (event.kind !== 'status') return;
      await input.onProgressStep?.({
        id: stepId,
        label: stepLabel,
        status: 'running',
        detail: buildRepoReviewAgentStatusText(event),
        kind: 'worker',
        metadataText: JSON.stringify(
          {
            ai_status: event.status,
            event_title: event.title,
            event_body: event.body || '',
          },
          null,
          2,
        ),
      });
    },
  });
  if (response.timedOut) {
    const followupPayload =
      response.timeoutFollowupOutputText || response.outputText || '';
    const followupSummary =
      response.timeoutFollowupCompleted && followupPayload
        ? parseRepoReviewTimeoutFollowupSummary(followupPayload)
        : null;
    if (followupSummary) {
      if (input.executionStats) {
        input.executionStats.partialWorkerResultCount =
          (input.executionStats.partialWorkerResultCount || 0) + 1;
      }
      const reviewedFiles = followupSummary.readFiles.filter((file) =>
        input.chunk.files.some((entry) => entry.filePath === file),
      );
      await input.onProgressStep?.({
        id: 'worker_timeout_followup',
        label: 'Worker 超时追问',
        status: 'completed',
        detail: `Worker ${input.chunk.title} 已返回进度总结`,
        kind: 'worker',
        outputText: formatProgressKeyValues([
          ['worker', stepLabel],
          ['timeout_status', 'timeout_followup_completed'],
          ['confidence', followupSummary.confidence],
        ]),
      });
      await input.onProgressStep?.({
        id: 'worker_timeout_partial_summary',
        label: 'Worker 部分结果保留',
        status: 'completed',
        detail: `保留 ${reviewedFiles.length || input.chunk.files.length} 个文件的部分取证结果`,
        kind: 'worker',
        outputText: JSON.stringify(
          {
            worker: stepLabel,
            read_files: reviewedFiles,
            confirmed_issues: followupSummary.confirmedIssues,
            remaining_checks: followupSummary.remainingChecks,
            main_agent_questions: followupSummary.mainAgentQuestions,
            confidence: followupSummary.confidence,
          },
          null,
          2,
        ),
      });
      await input.onProgressStep?.({
        id: stepId,
        label: stepLabel,
        status: 'completed',
        detail: `Worker 超时后已保留部分结果`,
        kind: 'worker',
        outputText: JSON.stringify(
          {
            reviewed_files: reviewedFiles,
            timed_out: true,
            followup_summary_received: true,
            confidence: followupSummary.confidence,
          },
          null,
          2,
        ),
      });
      return {
        chunk: input.chunk,
        checkedFiles: reviewedFiles,
        reviewedFiles,
        findings: [],
        evidenceRequests: followupSummary.mainAgentQuestions,
        scopeLimitations: uniqueStrings([
          'worker exceeded primary timeout; partial follow-up summary preserved',
          followupSummary.summary || '',
          ...followupSummary.remainingChecks,
          ...followupSummary.mainAgentQuestions,
        ]),
        confidence: followupSummary.confidence,
        needsCrossFileReduction: true,
        failed: false,
        timedOut: true,
        followupRequested: true,
        followupSummaryReceived: true,
        timeoutStatus: 'timeout_followup_completed',
        timeoutFollowupSummary: followupSummary,
        rawOutput: followupPayload,
        turns: response.turns,
      };
    }
    const followupParsed = followupPayload
      ? (() => {
          try {
            return parseWorkerResult(
              followupPayload,
              input.chunk,
              response.turns,
            );
          } catch {
            return null;
          }
        })()
      : null;
    if (followupParsed) {
      const timeoutStatus = response.timeoutFollowupSent
        ? 'timeout_followup_completed'
        : 'timeout_partial_output_preserved';
      if (input.executionStats) {
        input.executionStats.partialWorkerResultCount =
          (input.executionStats.partialWorkerResultCount || 0) + 1;
      }
      await input.onProgressStep?.({
        id: 'worker_timeout_followup',
        label: 'Worker 超时追问',
        status: 'completed',
        detail: response.timeoutFollowupSent
          ? `Worker ${input.chunk.title} 已返回可解析的部分结果`
          : `Worker ${input.chunk.title} 超时前已输出可解析结果`,
        kind: 'worker',
        outputText: formatProgressKeyValues([
          ['worker', stepLabel],
          ['timeout_status', timeoutStatus],
          ['confidence', followupParsed.confidence],
        ]),
      });
      await input.onProgressStep?.({
        id: 'worker_timeout_partial_summary',
        label: 'Worker 部分结果保留',
        status: 'completed',
        detail: `保留 ${followupParsed.reviewedFiles.length} 个文件的部分取证结果`,
        kind: 'worker',
        outputText: JSON.stringify(
          {
            worker: stepLabel,
            reviewed_files: followupParsed.reviewedFiles,
            findings: followupParsed.findings.length,
            confidence: followupParsed.confidence,
          },
          null,
          2,
        ),
      });
      await input.onProgressStep?.({
        id: stepId,
        label: stepLabel,
        status: 'completed',
        detail: `Worker 超时后保留了解析结果`,
        kind: 'worker',
        outputText: JSON.stringify(
          {
            reviewed_files: followupParsed.reviewedFiles,
            timed_out: true,
            followup_summary_received: response.timeoutFollowupSent,
            confidence: followupParsed.confidence,
          },
          null,
          2,
        ),
      });
      return {
        ...followupParsed,
        checkedFiles: followupParsed.reviewedFiles,
        reviewedFiles: followupParsed.reviewedFiles,
        scopeLimitations: uniqueStrings([
          'worker exceeded primary timeout; parsed terminal draft preserved',
          ...followupParsed.scopeLimitations,
        ]),
        failed: false,
        timedOut: true,
        followupRequested: response.timeoutFollowupSent,
        followupSummaryReceived: response.timeoutFollowupSent,
        timeoutStatus,
        failureReason: undefined,
        rawOutput: followupPayload,
        turns: response.turns,
      };
    }
    await input.onProgressStep?.({
      id: 'worker_timeout_followup',
      label: 'Worker 超时追问',
      status: 'failed',
      detail: `Worker ${input.chunk.title} 未在 grace window 内返回总结`,
      kind: 'worker',
      error: 'timeout_followup_failed',
      outputText: formatProgressKeyValues([
        ['worker', stepLabel],
        [
          'timeout_status',
          response.timeoutFollowupSent ? 'timeout_killed' : 'timeout_killed',
        ],
      ]),
    });
    await input.onProgressStep?.({
      id: stepId,
      label: stepLabel,
      status: 'failed',
      detail: `Worker 超时：${input.chunk.files.length} 个文件`,
      kind: 'worker',
      error: 'worker timed out',
    });
    return {
      chunk: input.chunk,
      checkedFiles: input.chunk.files.map((file) => file.filePath),
      reviewedFiles: input.chunk.files.map((file) => file.filePath),
      findings: [],
      evidenceRequests: [],
      scopeLimitations: ['worker timed out'],
      confidence: 'low',
      needsCrossFileReduction: false,
      failed: true,
      timedOut: true,
      followupRequested: response.timeoutFollowupSent,
      followupSummaryReceived: false,
      timeoutStatus: 'timeout_killed',
      failureReason: response.timeoutFollowupSent
        ? 'timeout_followup_failed'
        : 'timeout_killed',
      rawOutput:
        response.timeoutFollowupOutputText || response.outputText || '',
      turns: response.turns,
    };
  }
  const parsed = parseWorkerResult(
    response.outputText,
    input.chunk,
    response.turns,
  );
  await input.onProgressStep?.({
    id: stepId,
    label: stepLabel,
    status: 'completed',
    detail: `完成 ${input.chunk.files.length} 个文件`,
    kind: 'worker',
    outputText: JSON.stringify(
      {
        checked_files: parsed.checkedFiles,
        findings: parsed.findings.length,
        scope_limitations: parsed.scopeLimitations.length,
        confidence: parsed.confidence,
        needs_cross_file_reduction: parsed.needsCrossFileReduction,
      },
      null,
      2,
    ),
  });
  return {
    ...parsed,
    reviewedFiles: parsed.checkedFiles,
    followupRequested: response.timeoutFollowupSent,
    followupSummaryReceived: false,
  };
}

async function runReducer(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  runId: string;
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
}): Promise<RepoReviewStructuredResult> {
  await input.onProgressStep?.({
    id: 'reduce_results',
    label: 'Reducer 收敛审查结论',
    status: 'running',
    detail:
      input.workerResults.length > 0
        ? `合并 ${input.workerResults.length} 个 worker 结果`
        : '直接审查证据 bundle',
    kind: 'reducer',
    inputText: JSON.stringify(
      {
        changed_files: input.bundle.changedFiles.length,
        worker_results: input.workerResults.length,
        direct_main_agent_review: input.bundle.directMainAgentReview,
      },
      null,
      2,
    ),
  });
  const reducerPrompt = buildRepoReviewReducerPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    bundle: input.bundle,
    workerResults: input.workerResults,
  });
  const provider = await resolveReviewProvider({
    repository: input.repository,
    profile: input.profile,
    runId: input.runId,
    userId: input.userId,
  });
  if (input.executionStats) {
    input.executionStats.modelCallCount =
      (input.executionStats.modelCallCount || 0) + 1;
    input.executionStats.promptBytesBuilt =
      (input.executionStats.promptBytesBuilt || 0) + byteLength(reducerPrompt);
    input.executionStats.reducerCallCount =
      (input.executionStats.reducerCallCount || 0) + 1;
  }
  await recordPromptTrace({
    traceKind: 'direct_provider',
    promptKey: 'repo_review.reducer',
    featureScope: 'repo_review',
    targetUserId: input.userId ?? '',
    provider: provider.type,
    model: provider.model || null,
    systemPromptText: null,
    userPromptText: reducerPrompt,
    providerInputText: reducerPrompt,
    resolution: [
      {
        promptKey: 'repo_review.reducer',
        featureScope: 'repo_review',
        source: 'builtin',
        ownerUserId: '',
        configured: false,
      },
    ],
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      workerCount: input.workerResults.length,
      promptBytes: byteLength(reducerPrompt),
    },
  }).catch((err) =>
    logger.warn({ err }, 'Failed to persist repo review reducer prompt trace'),
  );
  const response = await runProviderTextCall({
    provider,
    prompt: reducerPrompt,
    promptKey: 'repo_review.reducer',
    featureScope: 'repo_review',
    targetUserId: input.userId,
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      workerCount: input.workerResults.length,
    },
    timeoutMs: REDUCER_TIMEOUT_MS,
    maxTokens: 2200,
  });
  if (response.timedOut) {
    throw new Error('Repo review reducer timed out');
  }
  const parsed = parseReducerResult(response.text);
  const mergedLimitations = uniqueStrings([
    ...parsed.scopeLimitations,
    ...input.workerResults.flatMap((result) => result.scopeLimitations),
  ]);
  const mergedFindings = mergeCanonicalRepoReviewFindings(
    parsed.findings,
    input.workerResults.flatMap((result) => result.findings),
  );
  const finalResult: RepoReviewStructuredResult = {
    ...parsed,
    findings: mergedFindings,
    scopeLimitations: mergedLimitations,
    markdownBody:
      parsed.markdownBody ||
      buildStructuredMarkdownFallback({
        ...parsed,
        findings: mergedFindings,
        scopeLimitations: mergedLimitations,
      }),
  };
  await input.onProgressStep?.({
    id: 'reduce_results',
    label: 'Reducer 收敛审查结论',
    status: 'completed',
    detail: `完成收敛：${finalResult.findings.length} 个问题`,
    kind: 'reducer',
    outputText: JSON.stringify(
      {
        overall: finalResult.overall,
        summary: finalResult.summary,
        findings: finalResult.findings.length,
        scope_limitations: finalResult.scopeLimitations.length,
        suggested_actions: finalResult.suggestions.length,
      },
      null,
      2,
    ),
  });
  return finalResult;
}

export async function runRepoReviewWorkers(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  chunks: RepoReviewEvidenceChunk[];
  runId: string;
  maxConcurrency?: number;
  userId?: string;
  executionStats?: RepoReviewExecutionStats;
  onTurnProgress?: (
    turnsByWorker: RepoReviewAssistantTurn[][],
  ) => Promise<void>;
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
}): Promise<RepoReviewWorkerResult[]> {
  const workerResults: RepoReviewWorkerResult[] = [];
  const turnsByWorker: RepoReviewAssistantTurn[][] = input.chunks.map(() => []);
  const results = await mapWithConcurrencyLimit(
    input.chunks,
    Math.max(
      1,
      Math.min(
        input.chunks.length || 1,
        Math.trunc(input.maxConcurrency || input.chunks.length || 1),
      ),
    ),
    async (chunk, index) => {
      try {
        const result = await runWorker({
          repository: input.repository,
          profile: input.profile,
          event: input.event,
          prepared: input.prepared,
          bundle: input.bundle,
          chunk,
          workerIndex: index,
          workerCount: input.chunks.length,
          runId: input.runId,
          userId: input.userId,
          executionStats: input.executionStats,
          onTurnProgress: async (turns) => {
            turnsByWorker[index] = turns;
            await input.onTurnProgress?.(turnsByWorker);
          },
          onProgressStep: input.onProgressStep,
        });
        turnsByWorker[index] = result.turns;
        await input.onTurnProgress?.(turnsByWorker);
        return result;
      } catch (err) {
        await input.onProgressStep?.({
          id: chunk.id,
          label: buildWorkerScheduleLabel(index, input.chunks.length),
          status: 'failed',
          detail: 'worker failed',
          kind: 'worker',
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          chunk,
          checkedFiles: chunk.files.map((file) => file.filePath),
          reviewedFiles: chunk.files.map((file) => file.filePath),
          findings: [],
          evidenceRequests: [],
          scopeLimitations: [err instanceof Error ? err.message : String(err)],
          confidence: 'low',
          needsCrossFileReduction: false,
          failed: true,
          timedOut: false,
          followupRequested: false,
          followupSummaryReceived: false,
          timeoutStatus: 'timeout_killed',
          failureReason: err instanceof Error ? err.message : String(err),
          rawOutput: '',
          turns: [],
        } satisfies RepoReviewWorkerResult;
      }
    },
  );
  workerResults.push(...results);
  return workerResults;
}

export async function reduceRepoReviewWorkerResults(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  workerResults: RepoReviewWorkerResult[];
  runId: string;
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
}): Promise<RepoReviewStructuredResult> {
  return runReducer(input);
}

export function renderRepoReviewMarkdownFromStructuredResult(
  result: Pick<
    RepoReviewStructuredResult,
    'summary' | 'findings' | 'commitReviews' | 'suggestions' | 'markdownBody'
  >,
): string {
  return String(result.markdownBody || '').trim()
    ? String(result.markdownBody || '').trim()
    : buildStructuredRepoReviewMarkdown({
        summary: result.summary,
        findings: result.findings,
        commitReviews: result.commitReviews,
        suggestions: result.suggestions,
      } as any);
}

function buildWorkerScheduleLabel(index: number, total: number): string {
  return `Worker ${index + 1}/${total}`;
}

export async function runRepoReviewGraphCoordinator(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
  maxWorkerCount?: number;
  userId?: string;
  executionStats?: RepoReviewExecutionStats;
  onTurnProgress?: (
    turnsByWorker: RepoReviewAssistantTurn[][],
  ) => Promise<void>;
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
  parsed: RepoReviewStructuredResult;
  workerResults: RepoReviewWorkerResult[];
  bundle: RepoReviewEvidenceBundle;
  plan: RepoReviewExecutionPlan;
  reviewTurns: RepoReviewAssistantTurn[];
}> {
  if (input.executionStats) {
    input.executionStats.diffFiles = input.prepared.changedFiles.length;
    input.executionStats.diffBytes = byteLength(input.prepared.diffText || '');
    input.executionStats.totalReadBudgetBytes = MAX_TOTAL_FULL_FILE_BYTES;
    input.executionStats.maxFullFileBytesPerFile = MAX_FULL_FILE_BYTES_PER_FILE;
  }
  const bundle = await buildRepoReviewEvidenceBundle({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    workspacePath: input.workspacePath,
  });
  await input.onProgressStep?.({
    id: 'build_evidence_bundle',
    label: '构建 Evidence Bundle',
    status: 'running',
    detail: `${bundle.changedFiles.length} 个变更文件`,
    kind: 'stage',
    inputText: JSON.stringify(
      {
        changed_files: bundle.changedFiles.length,
        diff_bytes: bundle.diffBytes,
        lazy_full_file_context: input.profile.includeFullFileContext,
        code_map_status:
          bundle.graphEvidenceBundle?.codeMapStatus.status || 'missing',
        code_index_status:
          bundle.graphEvidenceBundle?.codeIndexStatus.status || 'missing',
      },
      null,
      2,
    ),
  });
  await input.onProgressStep?.({
    id: 'build_evidence_bundle',
    label: '构建 Evidence Bundle',
    status: 'completed',
    detail: `${bundle.changedFiles.length} 个文件，${bundle.totalPromptBytes} bytes`,
    kind: 'stage',
    outputText: JSON.stringify(
      {
        changed_files: bundle.changedFiles.length,
        lazy_full_file_context: input.profile.includeFullFileContext,
        diff_bytes: bundle.diffBytes,
        changed_hunks: bundle.graphEvidenceBundle?.changedHunks.length || 0,
        changed_functions:
          bundle.graphEvidenceBundle?.changedFunctions.length || 0,
      },
      null,
      2,
    ),
  });
  const moduleCount = new Set(bundle.files.map((file) => file.groupKey)).size;
  const requestedMaxWorkerCount = resolveRepoReviewCoordinatorWorkerLimit(
    input.maxWorkerCount,
  );
  const workerChunks = partitionRepoReviewEvidenceChunks(
    bundle,
    requestedMaxWorkerCount,
  );
  const effectiveMaxWorkerCount = Math.max(
    1,
    workerChunks.length || requestedMaxWorkerCount,
  );
  const plan: RepoReviewExecutionPlan = {
    strategy: bundle.directMainAgentReview ? 'main_only' : 'worker_then_main',
    changedFileCount: bundle.changedFiles.length,
    diffSubagentThreshold: Math.max(
      0,
      Math.trunc(input.profile.diffSubagentThreshold),
    ),
    moduleCount,
    maxSubagents: Math.max(1, Math.trunc(Number(input.maxWorkerCount) || 1)),
    maxWorkerCount: effectiveMaxWorkerCount,
    workerCount: workerChunks.length,
    includeFullFileContext: input.profile.includeFullFileContext,
    lazyFullFileContext: input.profile.includeFullFileContext,
  };
  await input.onProgressStep?.({
    id: 'decide_execution_plan',
    label: '决定执行计划',
    status: 'completed',
    detail:
      plan.strategy === 'main_only'
        ? '变更文件数低于 worker 阈值，主代理直接审查'
        : `${plan.workerCount} 个 worker chunk，主代理统一汇总`,
    kind: 'stage',
    outputText: JSON.stringify(plan, null, 2),
  });
  if (input.executionStats) {
    input.executionStats.splitGroups = workerChunks.length;
    input.executionStats.fullFileBytesLoaded = bundle.fileContentBytes;
    input.executionStats.evidenceBundleBytes = bundle.totalPromptBytes;
    input.executionStats.workerCount = workerChunks.length;
    input.executionStats.plannedSubagentCount = workerChunks.length;
    input.executionStats.delegatedSubagentCount = workerChunks.length;
    input.executionStats.peakReservedBytes = Math.max(
      input.executionStats.peakReservedBytes,
      bundle.totalPromptBytes,
    );
  }

  let workerResults: RepoReviewWorkerResult[] = [];
  if (bundle.directMainAgentReview) {
    await input.onProgressStep?.({
      id: 'main_agent_review',
      label: '主代理直接审查',
      status: 'running',
      detail: '证据量足够小，主代理直接完成审查。',
      kind: 'main',
      inputText: JSON.stringify(
        {
          direct_main_agent_review: true,
          changed_files: bundle.changedFiles.length,
          evidence_bytes: bundle.totalPromptBytes,
          diff_threshold: input.profile.diffSubagentThreshold,
          execution_plan: plan,
        },
        null,
        2,
      ),
    });
  } else {
    await input.onProgressStep?.({
      id: 'schedule_workers',
      label: '调度 Worker',
      status: 'running',
      detail: `${workerChunks.length} 个 worker chunk`,
      kind: 'stage',
      inputText: JSON.stringify(
        {
          worker_chunks: workerChunks.length,
          execution_plan: plan,
          max_files_per_chunk: MAX_WORKER_CHUNK_FILE_COUNT,
          max_chunk_bytes: MAX_WORKER_CHUNK_BYTES,
          direct_main_agent_review: false,
        },
        null,
        2,
      ),
    });
    for (let index = 0; index < workerChunks.length; index += 1) {
      const chunk = workerChunks[index]!;
      await input.onProgressStep?.({
        id: chunk.id,
        label: buildWorkerScheduleLabel(index, workerChunks.length),
        status: 'queued',
        detail: `${chunk.files.length} 个文件：${chunk.files
          .map((file) => file.filePath)
          .slice(0, 4)
          .join('、')}`,
        kind: 'worker',
        inputText: JSON.stringify(
          {
            chunk_id: chunk.id,
            files: chunk.files.map((file) => file.filePath),
          },
          null,
          2,
        ),
      });
    }
    await input.onProgressStep?.({
      id: 'schedule_workers',
      label: '调度 Worker',
      status: 'completed',
      detail: `${workerChunks.length} 个 worker chunk 已排队`,
      kind: 'stage',
      outputText: JSON.stringify(
        {
          worker_chunks: workerChunks.length,
          direct_main_agent_review: false,
        },
        null,
        2,
      ),
    });
    workerResults = await runRepoReviewWorkers({
      repository: input.repository,
      profile: input.profile,
      event: input.event,
      prepared: input.prepared,
      bundle,
      chunks: workerChunks,
      runId: input.runId,
      maxConcurrency: effectiveMaxWorkerCount,
      userId: input.userId,
      executionStats: input.executionStats,
      onTurnProgress: input.onTurnProgress,
      onProgressStep: input.onProgressStep,
    });
    if (input.executionStats) {
      input.executionStats.completedWorkerCount = workerResults.filter(
        (result) => !result.failed,
      ).length;
      input.executionStats.failedWorkerCount = workerResults.filter(
        (result) => result.failed,
      ).length;
      input.executionStats.timedOutWorkerCount = workerResults.filter(
        (result) => result.timedOut,
      ).length;
    }
  }

  const workerTurns = workerResults.flatMap((result) => result.turns || []);
  const fallbackReviewedFiles = uniqueStrings(
    workerResults
      .filter((result) => result.failed || result.timedOut)
      .flatMap((result) => result.reviewedFiles || result.checkedFiles || []),
  );
  if (input.executionStats && !bundle.directMainAgentReview) {
    input.executionStats.fallbackMainReviewCount =
      (input.executionStats.fallbackMainReviewCount || 0) + 1;
    input.executionStats.fallbackReviewedFileCount = Math.max(
      input.executionStats.fallbackReviewedFileCount || 0,
      fallbackReviewedFiles.length,
    );
  }

  const mainReviewStepId = bundle.directMainAgentReview
    ? 'main_agent_review'
    : 'main_agent_fallback_review';
  const mainReviewStepLabel = bundle.directMainAgentReview
    ? '主代理直接审查'
    : '主代理补审';
  const mainReviewPrompt = buildRepoReviewMainReviewPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    bundle,
    workerResults,
    workerTurns,
    directReview: bundle.directMainAgentReview,
  });
  await input.onProgressStep?.({
    id: mainReviewStepId,
    label: mainReviewStepLabel,
    status: 'running',
    detail: bundle.directMainAgentReview
      ? '主代理直接审查当前证据。'
      : `主代理补审 ${workerResults.length} 个 worker 结果`,
    kind: 'main',
    inputText: JSON.stringify(
      {
        direct_main_agent_review: bundle.directMainAgentReview,
        worker_results: workerResults.length,
        fallback_reviewed_files: fallbackReviewedFiles.length,
      },
      null,
      2,
    ),
  });
  if (input.executionStats) {
    input.executionStats.modelCallCount =
      (input.executionStats.modelCallCount || 0) + 1;
    input.executionStats.promptBytesBuilt =
      (input.executionStats.promptBytesBuilt || 0) +
      byteLength(mainReviewPrompt);
  }
  const mainProvider = await resolveReviewProvider({
    repository: input.repository,
    profile: input.profile,
    runId: input.runId,
    userId: input.userId,
  }).catch(() => null);
  const mainReviewResponse = await runBoundedReviewAgent({
    repository: input.repository,
    profile: input.profile,
    prompt: mainReviewPrompt,
    runId: input.runId,
    runtimeNamespace: `${input.runId}:${mainReviewStepId}`,
    workspacePath:
      bundle.workspacePath ||
      input.workspacePath ||
      input.repository.localRepoPath,
    userId: input.userId,
    providerOverrideId: mainProvider?.id,
    timeoutMs: resolveRepoReviewMainTimeoutMs(bundle.directMainAgentReview),
    idleTimeoutMs: MAIN_REVIEW_IDLE_TIMEOUT_MS,
    timeoutGraceMs: MAIN_REVIEW_TIMEOUT_GRACE_MS,
    turnContext: buildRepoReviewTurnContext({
      groupKey: mainReviewStepId,
      groupLabel: mainReviewStepLabel,
      phase: bundle.directMainAgentReview
        ? 'main_agent_review'
        : 'main_agent_fallback_review',
    }),
    onTurnProgress: async (turns) => {
      await input.onTurnProgress?.([
        ...workerResults.map((result) => result.turns),
        turns,
      ]);
    },
    onStatusEvent: async (event) => {
      if (event.kind !== 'status') return;
      await input.onProgressStep?.({
        id: mainReviewStepId,
        label: mainReviewStepLabel,
        status: 'running',
        detail: buildRepoReviewAgentStatusText(event),
        kind: 'main',
        metadataText: JSON.stringify(
          {
            ai_status: event.status,
            event_title: event.title,
            event_body: event.body || '',
          },
          null,
          2,
        ),
      });
    },
  });

  let parsed: RepoReviewStructuredResult | null = null;
  let mainFinalizeTurns: RepoReviewAssistantTurn[] = [];
  let parsedDraft: RepoReviewStructuredResult | null = null;
  try {
    parsedDraft = parseReducerResult(mainReviewResponse.outputText || '');
    parsed = parsedDraft;
  } catch {
    parsed = null;
  }
  const parsedDraftMissingEvidence = parsedDraft
    ? getRepoReviewMissingEvidenceItems(parsedDraft.findings)
    : [];
  const needsMainFinalize =
    (Boolean(parsedDraft) &&
      Boolean(stringValue(parsedDraft?.markdownBody)) &&
      parsedDraftMissingEvidence.length > 0) ||
    (!parsedDraft &&
      looksLikeFinalizableLooseRepoReviewOutput(
        mainReviewResponse.outputText || '',
      ));
  if (needsMainFinalize) {
    parsed = null;
    const finalizeWorkspacePath =
      (await prepareRepoReviewScopedWorkspace({
        workspacePath:
          bundle.workspacePath ||
          input.workspacePath ||
          input.repository.localRepoPath ||
          '',
        runId: `${input.runId}-finalize`,
        changedFiles: input.prepared.changedFiles,
        findings: parsedDraft?.findings || [],
      })) ||
      bundle.workspacePath ||
      input.workspacePath ||
      input.repository.localRepoPath ||
      undefined;
    const finalizePrompt = buildRepoReviewMainFormattingPrompt({
      repository: input.repository,
      profile: input.profile,
      event: input.event,
      prepared: input.prepared,
      bundle,
      workerResults,
      draftOutput: mainReviewResponse.outputText || '',
      parsedDraft,
      missingEvidence: parsedDraftMissingEvidence,
    });
    await input.onProgressStep?.({
      id: 'main_agent_finalize',
      label: '主代理终稿补证',
      status: 'running',
      detail:
        parsedDraftMissingEvidence.length > 0
          ? `主代理正在补齐 ${parsedDraftMissingEvidence.length} 个 finding 的证据字段`
          : '主代理正在按固定模板整理最终输出',
      kind: 'main',
      inputText: JSON.stringify(
        {
          worker_results: workerResults.length,
          fixed_template_required: true,
          missing_evidence_findings: parsedDraftMissingEvidence.length,
        },
        null,
        2,
      ),
    });
    if (input.executionStats) {
      input.executionStats.modelCallCount =
        (input.executionStats.modelCallCount || 0) + 1;
      input.executionStats.promptBytesBuilt =
        (input.executionStats.promptBytesBuilt || 0) +
        byteLength(finalizePrompt);
    }
    try {
      const finalizeResponse = await runBoundedReviewAgent({
        repository: input.repository,
        profile: input.profile,
        prompt: finalizePrompt,
        runId: input.runId,
        runtimeNamespace: `${input.runId}:main-finalize`,
        workspacePath: finalizeWorkspacePath,
        userId: input.userId,
        providerOverrideId: mainProvider?.id,
        toolPolicy: 'readonly',
        timeoutMs: resolveRepoReviewMainTimeoutMs(
          bundle.directMainAgentReview,
          'finalize',
        ),
        idleTimeoutMs: MAIN_REVIEW_IDLE_TIMEOUT_MS,
        timeoutGraceMs: MAIN_REVIEW_TIMEOUT_GRACE_MS,
        allowedDirectoriesOverride: finalizeWorkspacePath
          ? [finalizeWorkspacePath]
          : undefined,
        turnContext: buildRepoReviewTurnContext({
          groupKey: 'main_agent_finalize',
          groupLabel: '主代理终稿补证',
          phase: bundle.directMainAgentReview
            ? 'main_agent_review'
            : 'main_agent_fallback_review',
        }),
        onTurnProgress: async (turns) => {
          mainFinalizeTurns = turns;
          await input.onTurnProgress?.([
            ...workerResults.map((result) => result.turns),
            mainReviewResponse.turns,
            turns,
          ]);
        },
        onStatusEvent: async (event) => {
          if (event.kind !== 'status') return;
          await input.onProgressStep?.({
            id: 'main_agent_finalize',
            label: '主代理终稿补证',
            status: 'running',
            detail: buildRepoReviewAgentStatusText(event),
            kind: 'main',
            metadataText: JSON.stringify(
              {
                ai_status: event.status,
                event_title: event.title,
                event_body: event.body || '',
              },
              null,
              2,
            ),
          });
        },
      });
      const finalized = parseReducerResult(finalizeResponse.outputText || '');
      if (
        hasFixedRepoReviewMarkdownTemplate(finalized.markdownBody) &&
        !hasRepoReviewMissingEvidence(finalized.findings)
      ) {
        parsed = finalized;
        await input.onProgressStep?.({
          id: 'main_agent_finalize',
          label: '主代理终稿补证',
          status: 'completed',
          detail: '主代理已补齐证据并输出终稿',
          kind: 'main',
          outputText: JSON.stringify(
            {
              overall: finalized.overall,
              findings: finalized.findings.length,
              markdown_template: 'fixed',
              missing_evidence_findings: 0,
            },
            null,
            2,
          ),
        });
      } else {
        await input.onProgressStep?.({
          id: 'main_agent_finalize',
          label: '主代理终稿补证',
          status: 'failed',
          detail: '主代理终稿补证后仍有模板或证据缺口，转入后备收敛',
          kind: 'main',
          error: hasFixedRepoReviewMarkdownTemplate(finalized.markdownBody)
            ? 'main_finalize_missing_evidence'
            : 'main_finalize_template_mismatch',
        });
      }
    } catch (err) {
      await input.onProgressStep?.({
        id: 'main_agent_finalize',
        label: '主代理终稿补证',
        status: 'failed',
        detail: '主代理终稿补证失败，转入后备收敛',
        kind: 'main',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!parsed) {
    if (parsedDraft) {
      parsed = withGeneratedRepoReviewMarkdown(parsedDraft);
      await input.onProgressStep?.({
        id: 'main_agent_finalize',
        label: '主代理终稿补证',
        status: 'completed',
        detail:
          '终稿补证未产出合格模板，已保留主代理结构化结论并由本地渲染报告',
        kind: 'main',
        outputText: JSON.stringify(
          {
            overall: parsed.overall,
            findings: parsed.findings.length,
            markdown_template: 'local_rendered',
            preserved_structured_draft: true,
          },
          null,
          2,
        ),
      });
    }
  }
  if (!parsed) {
    if (workerResults.length > 0) {
      try {
        parsed = await reduceRepoReviewWorkerResults({
          repository: input.repository,
          profile: input.profile,
          event: input.event,
          prepared: input.prepared,
          bundle,
          workerResults,
          runId: input.runId,
          userId: input.userId,
          executionStats: input.executionStats,
          onProgressStep: input.onProgressStep,
        });
      } catch {
        parsed = parsed || null;
      }
    }
  }
  if (!parsed) {
    parsed = buildLocalStructuredResultFallback({
      outputText: mainReviewResponse.outputText || '',
      workerResults,
    });
    if (input.executionStats) {
      input.executionStats.fallbackMainReviewCount =
        (input.executionStats.fallbackMainReviewCount || 0) + 1;
    }
  }
  parsed = {
    ...parsed,
    findings: mergeCanonicalRepoReviewFindings(
      parsed.findings,
      workerResults.flatMap((result) => result.findings),
    ),
    scopeLimitations: uniqueStrings([
      ...parsed.scopeLimitations,
      ...workerResults.flatMap((result) => result.scopeLimitations),
      ...workerResults.flatMap((result) =>
        result.evidenceRequests.map(
          (request) => `worker evidence request: ${request}`,
        ),
      ),
    ]),
  };
  if (!stringValue(parsed.markdownBody)) {
    parsed.markdownBody = buildStructuredRepoReviewMarkdown(
      {
        summary: parsed.summary,
        findings: parsed.findings,
        commitReviews: parsed.commitReviews,
        suggestions: parsed.suggestions,
      } as unknown as Pick<
        RepoReviewStructuredResult,
        'summary' | 'findings' | 'commitReviews' | 'suggestions'
      >,
      {
        repositoryName: input.repository.name,
        branch: input.prepared.branch,
        baseSha: input.prepared.baseSha,
        headSha: input.prepared.headSha,
        actor: input.prepared.actor,
        stage: input.event.stage,
        prMrNumber: input.event.prMrNumber,
        scopeLimitations: parsed.scopeLimitations,
      },
    );
  }
  await input.onProgressStep?.({
    id: mainReviewStepId,
    label: mainReviewStepLabel,
    status: 'completed',
    detail: bundle.directMainAgentReview
      ? '主代理已直接生成审查结论'
      : '主代理补审完成',
    kind: 'main',
    outputText: JSON.stringify(
      {
        overall: parsed.overall,
        summary: parsed.summary,
        findings: parsed.findings.length,
        scope_limitations: parsed.scopeLimitations.length,
      },
      null,
      2,
    ),
  });

  return {
    parsed,
    workerResults,
    bundle,
    plan,
    reviewTurns: [
      ...workerResults.flatMap((result) => result.turns || []),
      ...mainReviewResponse.turns,
      ...mainFinalizeTurns,
    ],
  };
}

export async function runRepoReviewCoordinatedReview(
  input: Parameters<typeof runRepoReviewGraphCoordinator>[0],
): Promise<Awaited<ReturnType<typeof runRepoReviewGraphCoordinator>>> {
  return runRepoReviewGraphCoordinator(input);
}
