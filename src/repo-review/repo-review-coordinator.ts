import fs from 'fs/promises';
import path from 'path';

import type { ReviewOverall } from '../db.js';
import type { AiProvider } from '../db/assistants.js';
import { getDefaultProvider, getDefaultProviderForUser, getProvider, isProviderVisibleToUser } from '../db/assistants.js';
import { getProviderForModule } from '../tenant/tenant-db.js';
import { getProviderAdapter } from '../provider/provider-adapters.js';
import { recordPromptTrace, resolvePromptText } from '../prompt/prompt-service.js';
import { buildRepoReviewDiffIndex, getRepoReviewDiffSlice } from './repo-review-diff-index.js';
import { buildRepoReviewFindingEvidenceKey } from './repo-review-doc-render.js';
import { buildStructuredRepoReviewMarkdown } from './repo-review-messages.js';
import {
  stringValue,
  type RepoReviewCommitReview,
  type RepoReviewEvent,
  type RepoReviewExecutionStats,
  type RepoReviewFileReview,
  type RepoReviewProgressStep,
  type RepoReviewProgressStepKind,
  type RepoReviewProfile,
  type RepoReviewRepository,
  type RepoReviewRunFinding,
  type ReviewPreparedContext,
  asRecord,
} from './repo-review-model.js';
import {
  REPO_REVIEW_REDUCER_TEMPLATE,
  REPO_REVIEW_WORKER_TEMPLATE,
} from './repo-review-prompt-templates.js';
import { logger } from '../logger.js';

const MAX_FULL_FILE_BYTES_PER_FILE = 64 * 1024;
const MAX_TOTAL_FULL_FILE_BYTES = 240 * 1024;
const MAX_WORKER_CHUNK_BYTES = 60 * 1024;
const MAX_WORKER_CHUNK_FILE_COUNT = 8;
const WORKER_TIMEOUT_MS = 90_000;
const REDUCER_TIMEOUT_MS = 120_000;

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
  directReducerOnly: boolean;
}

export interface RepoReviewWorkerResult {
  chunk: RepoReviewEvidenceChunk;
  checkedFiles: string[];
  findings: RepoReviewRunFinding[];
  scopeLimitations: string[];
  confidence: 'high' | 'medium' | 'low';
  needsCrossFileReduction: boolean;
  failed: boolean;
  timedOut: boolean;
  rawOutput: string;
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
  return String(filePath || '').split('/').filter(Boolean);
}

function getGroupKey(filePath: string): string {
  const segments = splitPathSegments(filePath);
  const top = segments[0] || '(root)';
  const second = segments[1] || '';
  const isTest = /(?:^|[./_-])(test|tests|spec|specs)(?:$|[./_-])/i.test(filePath);
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
  const text = String(value || '').trim().toLowerCase();
  if (text === 'high' || text === 'medium' || text === 'low') return text;
  return 'low';
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const text = String(value || '').trim().toLowerCase();
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
      if (stringValue(record.suggestion)) {
        finding.suggestion = stringValue(record.suggestion);
      }
      return finding;
    })
    .filter((entry): entry is RepoReviewRunFinding => Boolean(entry));
}

function dedupeFindings(findings: RepoReviewRunFinding[]): RepoReviewRunFinding[] {
  const seen = new Set<string>();
  const deduped: RepoReviewRunFinding[] = [];
  for (const finding of findings) {
    const key = buildRepoReviewFindingEvidenceKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function buildStructuredMarkdownFallback(result: RepoReviewStructuredResult): string {
  return buildStructuredRepoReviewMarkdown({
    summary: result.summary,
    findings: result.findings,
    commitReviews: result.commitReviews,
    suggestions: result.suggestions,
  } as any);
}

function extractJsonObject(text: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function readWorkspaceFile(filePath: string): Promise<{
  content: string;
  bytes: number;
  source: 'workspace' | 'omitted' | 'unavailable';
  reason?: string;
}> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { content: '', bytes: 0, source: 'omitted', reason: 'not a file' };
    }
    if (stat.size > MAX_FULL_FILE_BYTES_PER_FILE) {
      return {
        content: '',
        bytes: 0,
        source: 'omitted',
        reason: `file too large (${stat.size} bytes)`,
      };
    }
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return { content: '', bytes: 0, source: 'omitted', reason: 'binary file' };
    }
    return {
      content: buffer.toString('utf8'),
      bytes: buffer.byteLength,
      source: 'workspace',
    };
  } catch {
    return { content: '', bytes: 0, source: 'unavailable', reason: 'file unavailable' };
  }
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
      const visible = await isProviderVisibleToUser(profileProviderId, input.userId);
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
  const moduleProvider = await getProviderForModule('code_review', input.userId);
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
  const timeout = new Promise<{ text: string; model?: string; timedOut: boolean }>((resolve) => {
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

function parseWorkerResult(output: string, chunk: RepoReviewEvidenceChunk): RepoReviewWorkerResult {
  try {
    const parsed = JSON.parse(extractJsonObject(output)) as Record<string, unknown>;
    return {
      chunk,
      checkedFiles: uniqueStrings(
        Array.isArray(parsed.checked_files)
          ? parsed.checked_files.map((item) => String(item || ''))
          : Array.isArray(parsed.checkedFiles)
            ? parsed.checkedFiles.map((item) => String(item || ''))
            : chunk.files.map((file) => file.filePath),
      ).filter((file) => chunk.files.some((entry) => entry.filePath === file)),
      findings: dedupeFindings(normalizeFindings(Array.isArray(parsed.findings) ? parsed.findings : [])),
      scopeLimitations: uniqueStrings(
        Array.isArray(parsed.scope_limitations)
          ? parsed.scope_limitations.map((item) => String(item || ''))
          : Array.isArray(parsed.scopeLimitations)
            ? parsed.scopeLimitations.map((item) => String(item || ''))
            : [],
      ),
      confidence: normalizeConfidence(parsed.confidence),
      needsCrossFileReduction: Boolean(parsed.needs_cross_file_reduction ?? parsed.needsCrossFileReduction),
      failed: false,
      timedOut: Boolean(parsed.timed_out ?? parsed.timedOut),
      rawOutput: output,
    };
  } catch {
    return {
      chunk,
      checkedFiles: chunk.files.map((file) => file.filePath),
      findings: [],
      scopeLimitations: ['worker returned unstructured output'],
      confidence: 'low',
      needsCrossFileReduction: false,
      failed: true,
      timedOut: false,
      rawOutput: output,
    };
  }
}

function parseReducerResult(output: string): RepoReviewStructuredResult {
  const parsed = JSON.parse(extractJsonObject(output)) as Record<string, unknown>;
  const markdownBody = String(parsed.markdown_body || parsed.markdownBody || '').trim();
  const findings = dedupeFindings(normalizeFindings(Array.isArray(parsed.findings) ? parsed.findings : []));
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
  const commitReviews = Array.isArray(parsed.commit_reviews || parsed.commitReviews)
    ? (parsed.commit_reviews || parsed.commitReviews) as RepoReviewCommitReview[]
    : [];
  const fileReviews = Array.isArray(parsed.file_reviews || parsed.fileReviews)
    ? (parsed.file_reviews || parsed.fileReviews) as RepoReviewFileReview[]
    : [];
  const result: RepoReviewStructuredResult = {
    overall: ((String(parsed.overall || '').trim() || 'warn') as ReviewOverall),
    summary: String(parsed.summary || '').trim() || '审查完成。',
    findings,
    scopeLimitations,
    suggestions,
    recommendedBlock: Boolean(parsed.recommended_block ?? parsed.recommendedBlock),
    markdownBody,
    rawModelOutput: output,
    commitReviews,
    fileReviews,
  };
  if (!result.markdownBody) {
    result.markdownBody = buildStructuredMarkdownFallback(result);
  }
  return result;
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

function buildWorkerPromptContext(chunk: RepoReviewEvidenceChunk): string {
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
      primaryLanguageBlock: input.repository.language ? `主要语言：${input.repository.language}` : '',
      stage: input.event.stage,
      source: input.event.source,
      actor: input.prepared.actor || '(unknown)',
      branch: input.prepared.branch || '(unknown)',
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange: buildRepoReviewDiffRange({ baseSha: input.prepared.baseSha, headSha: input.prepared.headSha }),
      workerId: input.chunk.id,
      workerTitle: input.chunk.title,
      workerFiles: input.chunk.files.map((file) => `- ${file.filePath}`).join('\n'),
      workerEvidence: buildWorkerPromptContext(input.chunk),
      customPromptBlock: formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim()),
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
      primaryLanguageBlock: input.repository.language ? `主要语言：${input.repository.language}` : '',
      stage: input.event.stage,
      source: input.event.source,
      actor: input.prepared.actor || '(unknown)',
      branch: input.prepared.branch || '(unknown)',
      baseSha: formatRepoReviewPromptSha(input.prepared.baseSha),
      headSha: formatRepoReviewPromptSha(input.prepared.headSha),
      diffRange: buildRepoReviewDiffRange({ baseSha: input.prepared.baseSha, headSha: input.prepared.headSha }),
      changedFiles: input.bundle.changedFiles.map((file) => `- ${file}`).join('\n'),
      workerResults: buildWorkerResultsPrompt(input.workerResults),
      customPromptBlock: formatRepoReviewCustomPromptBlock(input.profile.promptTemplate.trim()),
    },
    fallbackText: REPO_REVIEW_REDUCER_TEMPLATE,
  });
}

async function createEvidenceBundle(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  workspacePath?: string | null;
}): Promise<RepoReviewEvidenceBundle> {
  const workspacePath = input.workspacePath || input.repository.localRepoPath;
  const diffIndex = input.prepared.diffIndex || buildRepoReviewDiffIndex(input.prepared.diffText);
  const files: RepoReviewEvidenceFile[] = [];
  let totalFullFileBytes = 0;
  for (const filePath of input.prepared.changedFiles) {
    const diffText =
      getRepoReviewDiffSlice(diffIndex, [filePath]) ||
      '';
    const diffBytes = byteLength(diffText);
    let fileContent = '';
    let fileContentBytes = 0;
    let fileContentSource: RepoReviewEvidenceFile['fileContentSource'] = 'omitted';
    let fileContentReason: string | undefined;
    if (input.profile.includeFullFileContext && totalFullFileBytes < MAX_TOTAL_FULL_FILE_BYTES) {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspacePath, filePath);
      const readResult = await readWorkspaceFile(absolutePath);
      fileContent = readResult.content;
      fileContentBytes = readResult.bytes;
      fileContentSource = readResult.source;
      fileContentReason = readResult.reason;
      if (fileContentSource === 'workspace') {
        totalFullFileBytes += fileContentBytes;
      }
    } else if (!input.profile.includeFullFileContext) {
      fileContentReason = 'full file context disabled';
    } else {
      fileContentReason = 'full file budget exhausted';
    }
    files.push({
      filePath,
      diffText,
      diffBytes,
      fileContent,
      fileContentBytes,
      fileContentSource,
      fileContentReason,
      groupKey: getGroupKey(filePath),
      isTestFile: isTestFile(filePath),
      language: inferLanguage(filePath),
    });
  }
  const diffBytes = byteLength(input.prepared.diffText || '');
  const fileContentBytes = files.reduce((total, file) => total + file.fileContentBytes, 0);
  const totalPromptBytes = diffBytes + fileContentBytes;
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
    projectContextBlock:
      input.prepared.projectContextBlocks.length > 0
        ? `项目上下文：\n${input.prepared.projectContextBlocks.join('\n\n')}`
        : '项目上下文：暂无补充上下文。',
    directReducerOnly:
      input.prepared.changedFiles.length <= 8 && totalPromptBytes <= 60_000,
  };
}

function partitionEvidenceChunks(bundle: RepoReviewEvidenceBundle): RepoReviewEvidenceChunk[] {
  if (bundle.directReducerOnly) {
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
      ? { ...current, files: nextFiles, diffBytes: current.diffBytes + file.diffBytes, fileContentBytes: current.fileContentBytes + file.fileContentBytes, promptBytes: 0 }
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
): RepoReviewEvidenceChunk[] {
  return partitionEvidenceChunks(bundle);
}

async function runWorker(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  bundle: RepoReviewEvidenceBundle;
  chunk: RepoReviewEvidenceChunk;
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
}): Promise<RepoReviewWorkerResult> {
  const stepId = input.chunk.id;
  const stepLabel = `Worker ${input.chunk.title}`;
  await input.onProgressStep?.({
    id: stepId,
    label: stepLabel,
    status: 'running',
    detail: `等待 provider 响应：${input.chunk.files.length} 个文件`,
    kind: 'worker',
    inputText: `files:\n${input.chunk.files.map((file) => `- ${file.filePath}`).join('\n')}`,
  });
  const resolved = await resolveWorkerPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    chunk: input.chunk,
    targetUserId: input.userId,
  });
  const provider = await resolveReviewProvider({
    repository: input.repository,
    profile: input.profile,
    runId: input.runId,
    userId: input.userId,
  });
  if (input.executionStats) {
    input.executionStats.modelCallCount = (input.executionStats.modelCallCount || 0) + 1;
    input.executionStats.promptBytesBuilt =
      (input.executionStats.promptBytesBuilt || 0) + byteLength(resolved.text);
  }
  await recordPromptTrace({
    traceKind: 'direct_provider',
    promptKey: 'repo_review.worker',
    featureScope: 'repo_review',
    targetUserId: input.userId ?? '',
    provider: provider.type,
    model: provider.model || null,
    systemPromptText: null,
    userPromptText: resolved.text,
    providerInputText: resolved.text,
    resolution: [resolved.resolution],
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      chunkId: input.chunk.id,
      fileCount: input.chunk.files.length,
      promptBytes: byteLength(resolved.text),
    },
  }).catch((err) => logger.warn({ err }, 'Failed to persist repo review prompt trace'));
  const response = await runProviderTextCall({
    provider,
    prompt: resolved.text,
    promptKey: 'repo_review.worker',
    featureScope: 'repo_review',
    targetUserId: input.userId,
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      chunkId: input.chunk.id,
    },
    timeoutMs: WORKER_TIMEOUT_MS,
    maxTokens: 1400,
  });
  if (response.timedOut) {
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
      findings: [],
      scopeLimitations: ['worker timed out'],
      confidence: 'low',
      needsCrossFileReduction: false,
      failed: true,
      timedOut: true,
      rawOutput: '',
    };
  }
  const parsed = parseWorkerResult(response.text, input.chunk);
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
  return parsed;
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
    detail: input.workerResults.length > 0
      ? `合并 ${input.workerResults.length} 个 worker 结果`
      : '直接审查证据 bundle',
    kind: 'reducer',
    inputText: JSON.stringify(
      {
        changed_files: input.bundle.changedFiles.length,
        worker_results: input.workerResults.length,
        direct_reducer_only: input.bundle.directReducerOnly,
      },
      null,
      2,
    ),
  });
  const resolved = await resolveReducerPrompt({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    bundle: input.bundle,
    workerResults: input.workerResults,
    targetUserId: input.userId,
  });
  const provider = await resolveReviewProvider({
    repository: input.repository,
    profile: input.profile,
    runId: input.runId,
    userId: input.userId,
  });
  if (input.executionStats) {
    input.executionStats.modelCallCount = (input.executionStats.modelCallCount || 0) + 1;
    input.executionStats.promptBytesBuilt =
      (input.executionStats.promptBytesBuilt || 0) + byteLength(resolved.text);
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
    userPromptText: resolved.text,
    providerInputText: resolved.text,
    resolution: [resolved.resolution],
    metadata: {
      runId: input.runId,
      repositoryId: input.repository.id,
      workerCount: input.workerResults.length,
      promptBytes: byteLength(resolved.text),
    },
  }).catch((err) => logger.warn({ err }, 'Failed to persist repo review reducer prompt trace'));
  const response = await runProviderTextCall({
    provider,
    prompt: resolved.text,
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
  const mergedFindings = dedupeFindings([
    ...input.workerResults.flatMap((result) => result.findings),
    ...parsed.findings,
  ]);
  const finalResult: RepoReviewStructuredResult = {
    ...parsed,
    findings: mergedFindings,
    scopeLimitations: mergedLimitations,
    markdownBody: parsed.markdownBody || buildStructuredMarkdownFallback({ ...parsed, findings: mergedFindings, scopeLimitations: mergedLimitations }),
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
}): Promise<RepoReviewWorkerResult[]> {
  const workerResults: RepoReviewWorkerResult[] = [];
  for (let index = 0; index < input.chunks.length; index += 1) {
    const chunk = input.chunks[index]!;
    try {
      const result = await runWorker({
        repository: input.repository,
        profile: input.profile,
        event: input.event,
        prepared: input.prepared,
        bundle: input.bundle,
        chunk,
        runId: input.runId,
        userId: input.userId,
        executionStats: input.executionStats,
        onProgressStep: input.onProgressStep,
      });
      workerResults.push(result);
    } catch (err) {
      workerResults.push({
        chunk,
        checkedFiles: chunk.files.map((file) => file.filePath),
        findings: [],
        scopeLimitations: [err instanceof Error ? err.message : String(err)],
        confidence: 'low',
        needsCrossFileReduction: false,
        failed: true,
        timedOut: false,
        rawOutput: '',
      });
      await input.onProgressStep?.({
        id: chunk.id,
        label: buildWorkerScheduleLabel(index, input.chunks.length),
        status: 'failed',
        detail: 'worker failed',
        kind: 'worker',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

export async function runRepoReviewCoordinatedReview(input: {
  repository: RepoReviewRepository;
  profile: RepoReviewProfile;
  event: RepoReviewEvent;
  prepared: ReviewPreparedContext;
  runId: string;
  workspacePath?: string | null;
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
  parsed: RepoReviewStructuredResult;
  workerResults: RepoReviewWorkerResult[];
  bundle: RepoReviewEvidenceBundle;
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
        file_content_bytes: bundle.fileContentBytes,
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
        files_with_content: bundle.files.filter((file) => file.fileContentSource === 'workspace').length,
        diff_bytes: bundle.diffBytes,
        file_content_bytes: bundle.fileContentBytes,
      },
      null,
      2,
    ),
  });
  const workerChunks = partitionRepoReviewEvidenceChunks(bundle);
  if (input.executionStats) {
    input.executionStats.splitGroups = workerChunks.length;
    input.executionStats.fullFileBytesLoaded = bundle.fileContentBytes;
    input.executionStats.evidenceBundleBytes = bundle.totalPromptBytes;
    input.executionStats.workerCount = workerChunks.length;
    input.executionStats.peakReservedBytes = Math.max(
      input.executionStats.peakReservedBytes,
      bundle.totalPromptBytes,
    );
  }
  if (workerChunks.length === 0) {
    await input.onProgressStep?.({
      id: 'schedule_workers',
      label: '调度 Worker',
      status: 'skipped',
      detail: '小改动，直接进入 reducer',
      kind: 'stage',
      outputText: '未切分 worker，直接收敛。',
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
          max_files_per_chunk: MAX_WORKER_CHUNK_FILE_COUNT,
          max_chunk_bytes: MAX_WORKER_CHUNK_BYTES,
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
        detail: `${chunk.files.length} 个文件：${chunk.files.map((file) => file.filePath).slice(0, 4).join('、')}`,
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
          direct_reducer_only: false,
        },
        null,
        2,
      ),
    });
  }

  const workerResults = await runRepoReviewWorkers({
    repository: input.repository,
    profile: input.profile,
    event: input.event,
    prepared: input.prepared,
    bundle,
    chunks: workerChunks,
    runId: input.runId,
    userId: input.userId,
    executionStats: input.executionStats,
    onProgressStep: input.onProgressStep,
  });
  if (input.executionStats) {
    input.executionStats.completedWorkerCount = workerResults.filter((result) => !result.failed).length;
    input.executionStats.failedWorkerCount = workerResults.filter((result) => result.failed).length;
    input.executionStats.timedOutWorkerCount = workerResults.filter((result) => result.timedOut).length;
  }

  const parsed = await reduceRepoReviewWorkerResults({
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

  return {
    parsed,
    workerResults,
    bundle,
  };
}
