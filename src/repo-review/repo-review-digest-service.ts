import { execFile } from 'child_process';
import { promisify } from 'util';
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, TIMEZONE } from '../config.js';
import {
  hasCompletedDigestRunForSchedule,
  listReviewRepositories,
  saveDigestRun,
  updateDigestRun,
  updateReviewRepositoryDigestTimestamps,
  type ReviewRepositoryRecord,
  type DigestRunRecord,
} from '../db.js';
import { runAgentProcess, type AgentRunInput } from '../agent/agent-runner.js';
import { logger } from '../logger.js';
import { recordPromptTrace, resolvePromptText } from '../prompt/prompt-service.js';
import { getAssistantName } from '../config-store.js';
import type { RegisteredGroup, StructuredOutboundMessage } from '../types.js';
import { REPO_REVIEW_DIGEST_TEMPLATE } from './repo-review-prompt-templates.js';
import { buildRepoReviewReadOnlyAllowedDirectories } from './repo-review-model.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommitCategory =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'perf'
  | 'docs'
  | 'test'
  | 'chore'
  | 'other';

const DEFAULT_BRANCH_NAMES = new Set([
  'main', 'master', 'develop', 'dev', 'release', 'trunk',
]);

export interface DigestBranchSummary {
  name: string;
  commitCount: number;
  contributors: string[];
  commitsByCategory: Record<CommitCategory, number>;
  commitMessages: string[];
}

export interface DigestSampledCommit {
  branch: string;
  sha: string;
  author: string;
  date: string;
  message: string;
  category: CommitCategory;
  diffStat: string;
  diffContent: string;
}

export interface DigestData {
  repositoryName: string;
  periodStart: string;
  periodEnd: string;
  type: 'daily' | 'weekly';
  branches: DigestBranchSummary[];
  totalCommits: number;
  totalContributors: string[];
  sampledCommits: DigestSampledCommit[];
  categorySummary: Record<CommitCategory, number>;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// Commit categorization
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS: [RegExp, CommitCategory][] = [
  [/^feat(\(.+?\))?[!:]|^feature\b/i, 'feature'],
  [/^fix(\(.+?\))?[!:]|^bugfix\b|^hotfix\b/i, 'fix'],
  [/^refactor(\(.+?\))?[!:]/i, 'refactor'],
  [/^perf(\(.+?\))?[!:]/i, 'perf'],
  [/^docs?(\(.+?\))?[!:]/i, 'docs'],
  [/^tests?(\(.+?\))?[!:]/i, 'test'],
  [/^(?:chore|build|ci)(\(.+?\))?[!:]/i, 'chore'],
];

function categorizeCommit(message: string): CommitCategory {
  const trimmed = message.trim();
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(trimmed)) return category;
  }
  return 'other';
}

function emptyCategoryCounts(): Record<CommitCategory, number> {
  return { feature: 0, fix: 0, refactor: 0, perf: 0, docs: 0, test: 0, chore: 0, other: 0 };
}

// ---------------------------------------------------------------------------
// Timer / loop plumbing
// ---------------------------------------------------------------------------

const DIGEST_LOOP_INTERVAL_MS = 60_000;
const MAX_COMMITS_PER_BRANCH = 15;
const MAX_DIFF_LINES = 300;
const MAX_TOTAL_SAMPLED_COMMITS = 50;

let digestLoopStarted = false;
let digestTimerHandle: ReturnType<typeof setTimeout> | null = null;
const digestInFlight = new Set<string>();

let digestMessageSender:
  | ((jid: string, message: StructuredOutboundMessage) => Promise<void>)
  | null = null;

export function setDigestMessageSender(
  sender:
    | ((jid: string, message: StructuredOutboundMessage) => Promise<void>)
    | null,
): void {
  digestMessageSender = sender;
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

export function computeNextDigestAt(
  type: 'daily' | 'weekly',
  hour: number,
  weekDay?: number,
  now = new Date(),
  timezone = TIMEZONE,
): string {
  const interval = CronExpressionParser.parse(
    buildDigestCronExpression(type, hour, weekDay),
    {
      tz: timezone,
      currentDate: now,
    },
  );
  const next = interval.next();
  const nextIso = next.toISOString();
  if (!nextIso) {
    throw new Error('Failed to compute next digest slot');
  }
  return nextIso;
}

function buildDigestCronExpression(
  type: 'daily' | 'weekly',
  hour: number,
  weekDay?: number,
): string {
  const normalizedHour = Math.max(0, Math.min(23, Math.trunc(hour)));
  if (type === 'daily') {
    return `0 ${normalizedHour} * * *`;
  }
  const normalizedWeekDay = Math.max(1, Math.min(7, Math.trunc(weekDay ?? 5)));
  const cronWeekDay = normalizedWeekDay === 7 ? 0 : normalizedWeekDay;
  return `0 ${normalizedHour} * * ${cronWeekDay}`;
}

function computeDigestWindow(
  type: 'daily' | 'weekly',
  hour: number,
  scheduledFor: string,
  weekDay?: number,
  timezone = TIMEZONE,
): { periodStart: string; periodEnd: string } {
  const periodEnd = new Date(scheduledFor).toISOString();
  const interval = CronExpressionParser.parse(
    buildDigestCronExpression(type, hour, weekDay),
    {
      tz: timezone,
      currentDate: new Date(periodEnd),
    },
  );
  const previous = interval.prev();
  const previousIso = previous.toISOString();
  if (!previousIso) {
    throw new Error('Failed to compute previous digest slot');
  }
  return {
    periodStart: previousIso,
    periodEnd,
  };
}

function isDigestDue(
  repository: ReviewRepositoryRecord,
  type: 'daily' | 'weekly',
  nowIso: string,
): boolean {
  if (repository.enabled !== 1) return false;
  if (type === 'daily') {
    if (repository.digest_daily_enabled !== 1) return false;
    const next = repository.next_digest_daily_at;
    return Boolean(next) && String(next) <= nowIso;
  }
  if (repository.digest_weekly_enabled !== 1) return false;
  const next = repository.next_digest_weekly_at;
  return Boolean(next) && String(next) <= nowIso;
}

// ---------------------------------------------------------------------------
// Git data collection
// ---------------------------------------------------------------------------

function getRepoMirrorPath(repositoryId: string): string {
  return path.join(DATA_DIR, 'repo-mirrors', repositoryId);
}

let digestSshPermFixed = false;
let digestSshIdentityOverride: string | null = null;

function digestFixSshKeyPermissions(): void {
  if (digestSshPermFixed || process.platform === 'win32') return;
  digestSshPermFixed = true;
  const sshDirs = new Set<string>();
  sshDirs.add(path.join(os.homedir(), '.ssh'));
  if (process.env.HOME) sshDirs.add(path.join(process.env.HOME, '.ssh'));
  sshDirs.add('/root/.ssh');
  for (const sshDir of sshDirs) {
    for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa']) {
      const keyPath = path.join(sshDir, name);
      try {
        if (!fs.existsSync(keyPath)) continue;
        const tmp = path.join(os.tmpdir(), `nanoclaw-ssh-${name}`);
        fs.copyFileSync(keyPath, tmp);
        fs.chmodSync(tmp, 0o600);
        digestSshIdentityOverride = tmp;
        return;
      } catch { /* skip */ }
    }
  }
}

function digestGitSshEnv(): Record<string, string> {
  digestFixSshKeyPermissions();
  const cmd = digestSshIdentityOverride
    ? `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -i ${digestSshIdentityOverride}`
    : 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes';
  return { GIT_SSH_COMMAND: cmd, GIT_SSL_NO_VERIFY: '1' };
}

function digestBuildHttpsCloneUrl(repo: ReviewRepositoryRecord): string | null {
  if (!repo.platform_token || !repo.remote_repo_slug) return null;
  const provider = repo.remote_provider;
  if (!provider) return null;
  const token = repo.platform_token;
  const slug = repo.remote_repo_slug.trim();
  let host = '';
  const rawBase = (repo.remote_base_url || '').trim().replace(/\/+$/, '');
  if (rawBase) {
    try { host = new URL(rawBase.replace(/\/api\/v[14]$/, '')).host; } catch { /* */ }
  }
  if (!host && repo.clone_url) {
    const m = repo.clone_url.match(/^git@([^:]+):/)
      || repo.clone_url.match(/^ssh:\/\/[^@]*@([^:/]+)/i);
    if (m) host = m[1];
  }
  if (!host) {
    const d: Record<string, string> = { gitlab: 'gitlab.com', github: 'github.com' };
    host = d[provider] || 'gitea.com';
  }
  const enc = encodeURIComponent(token);
  if (provider === 'gitlab') return `https://oauth2:${enc}@${host}/${slug}.git`;
  if (provider === 'github') return `https://x-access-token:${enc}@${host}/${slug}.git`;
  return `https://${enc}@${host}/${slug}.git`;
}

async function gitExec(
  repoPath: string,
  args: string[],
  maxBuffer = 10 * 1024 * 1024,
  remoteRepositoryId?: string | false,
): Promise<string> {
  let envOverride: Record<string, string> | undefined;
  if (remoteRepositoryId) {
    const { gitEnvForRemoteAsync } = await import('./repo-review-git.js');
    envOverride = await gitEnvForRemoteAsync(remoteRepositoryId);
  } else if (remoteRepositoryId !== false) {
    // not explicitly disabled, but no id — use legacy filesystem env
  }
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer,
    timeout: 120_000,
    ...(envOverride
      ? { env: envOverride }
      : {}),
  });
  return stdout;
}

interface RawCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
  category: CommitCategory;
}

async function listRemoteBranches(repoPath: string): Promise<string[]> {
  const raw = await gitExec(repoPath, [
    'for-each-ref', 'refs/remotes/origin',
    '--format=%(refname:short)',
  ]);
  if (!raw.trim()) return [];
  return raw.trim().split('\n')
    .map((ref) => ref.replace(/^origin\//, ''))
    .filter((name) => name && name !== 'HEAD');
}

async function detectDefaultBranch(repoPath: string, branches: string[]): Promise<string> {
  try {
    const raw = await gitExec(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const ref = raw.trim().replace(/^refs\/remotes\/origin\//, '');
    if (ref && branches.includes(ref)) return ref;
  } catch { /* ignore */ }
  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    if (branches.includes(candidate)) return candidate;
  }
  return branches[0] || 'main';
}

async function collectBranchCommits(
  repoPath: string,
  branch: string,
  since: string,
  until: string,
): Promise<RawCommit[]> {
  let raw: string;
  try {
    raw = await gitExec(repoPath, [
      'log', `origin/${branch}`,
      `--since=${since}`, `--until=${until}`,
      '--format=%H%x00%an%x00%aI%x00%s',
    ]);
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  return raw.trim().split('\n')
    .map((line) => {
      const [sha, author, date, message] = line.split('\x00');
      return { sha, author, date, message, category: categorizeCommit(message) };
    })
    .filter((c) => c.sha);
}

/**
 * Deduplicate commits across branches. Feature branches claim commits first
 * so their work is attributed specifically; the default branch only keeps
 * commits unique to it (direct pushes, merge commits, etc.).
 */
function assignCommitsToBranches(
  branchCommitMap: Map<string, RawCommit[]>,
  defaultBranch: string,
): Map<string, RawCommit[]> {
  const assigned = new Set<string>();
  const result = new Map<string, RawCommit[]>();

  // Feature branches first, default branch last
  const sortedBranches = [...branchCommitMap.keys()].sort((a, b) => {
    const aIsDefault = (DEFAULT_BRANCH_NAMES.has(a) || a === defaultBranch) ? 1 : 0;
    const bIsDefault = (DEFAULT_BRANCH_NAMES.has(b) || b === defaultBranch) ? 1 : 0;
    return aIsDefault - bIsDefault;
  });

  for (const branch of sortedBranches) {
    const commits = branchCommitMap.get(branch) || [];
    const unique = commits.filter((c) => !assigned.has(c.sha));
    if (unique.length > 0) {
      result.set(branch, unique);
      unique.forEach((c) => assigned.add(c.sha));
    }
  }

  // Re-insert default branch first for presentation order
  if (result.has(defaultBranch)) {
    const defaultCommits = result.get(defaultBranch)!;
    result.delete(defaultBranch);
    const reordered = new Map<string, RawCommit[]>();
    reordered.set(defaultBranch, defaultCommits);
    for (const [k, v] of result) reordered.set(k, v);
    return reordered;
  }
  return result;
}

async function sampleCommitsForDigest(
  repoPath: string,
  commits: RawCommit[],
  branchName: string,
  maxPerBranch: number,
): Promise<DigestSampledCommit[]> {
  const selected = [...commits]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxPerBranch);
  const sampled: DigestSampledCommit[] = [];

  for (const commit of selected) {
    try {
      const diffStat = await gitExec(repoPath, [
        'diff', '--stat', `${commit.sha}^..${commit.sha}`,
      ]).catch(() => '');

      let diffContent = '';
      try {
        const rawDiff = await gitExec(repoPath, [
          'show', commit.sha, '--format=', '--patch',
        ]);
        const lines = rawDiff.split('\n');
        diffContent =
          lines.length > MAX_DIFF_LINES
            ? lines.slice(0, MAX_DIFF_LINES).join('\n') +
              `\n... (truncated, ${lines.length - MAX_DIFF_LINES} more lines)`
            : rawDiff;
      } catch {
        // merge commit or empty diff
      }

      sampled.push({
        branch: branchName,
        sha: commit.sha,
        author: commit.author,
        date: commit.date,
        message: commit.message,
        category: commit.category,
        diffStat: diffStat.trim(),
        diffContent,
      });
    } catch {
      // skip unreadable commits
    }
  }
  return sampled;
}

export async function collectDigestData(
  repository: ReviewRepositoryRecord,
  since: string,
  until: string,
  type: 'daily' | 'weekly',
): Promise<DigestData> {
  const repoPath =
    repository.local_repo_path || getRepoMirrorPath(repository.id);

  // Refresh refs — try SSH first, then HTTPS fallback
  try {
    await gitExec(repoPath, ['fetch', '--prune', '--all'], undefined, repository.id);
  } catch (sshErr) {
    const httpsUrl = digestBuildHttpsCloneUrl(repository);
    if (httpsUrl) {
      try {
        await gitExec(repoPath, ['remote', 'set-url', 'origin', httpsUrl]);
        await gitExec(repoPath, ['fetch', '--prune', '--all'], undefined, repository.id);
      } catch (httpsErr) {
        logger.warn(
          { err: httpsErr, repositoryId: repository.id },
          'Digest: HTTPS fetch fallback also failed, proceeding with stale data',
        );
      }
    } else {
      logger.warn(
        { err: sshErr, repositoryId: repository.id },
        'Digest: git fetch failed, proceeding with stale data',
      );
    }
  }

  // 1. List all remote branches and detect default
  const remoteBranches = await listRemoteBranches(repoPath);
  const defaultBranch = await detectDefaultBranch(repoPath, remoteBranches);

  // 2. Collect commits per branch in time window
  const branchCommitMap = new Map<string, RawCommit[]>();
  for (const branch of remoteBranches) {
    const commits = await collectBranchCommits(repoPath, branch, since, until);
    if (commits.length > 0) branchCommitMap.set(branch, commits);
  }

  // 3. Deduplicate: assign each commit to the most specific branch
  const dedupedMap = assignCommitsToBranches(branchCommitMap, defaultBranch);

  // 4. Build branch summaries
  const allContributors = new Set<string>();
  const branches: DigestBranchSummary[] = [];
  const globalCategorySummary = emptyCategoryCounts();
  let totalCommits = 0;

  for (const [branchName, branchCommits] of dedupedMap) {
    const contributors = [...new Set(branchCommits.map((c) => c.author))];
    contributors.forEach((c) => allContributors.add(c));

    const catCounts = emptyCategoryCounts();
    for (const c of branchCommits) {
      catCounts[c.category]++;
      globalCategorySummary[c.category]++;
    }
    totalCommits += branchCommits.length;

    branches.push({
      name: branchName,
      commitCount: branchCommits.length,
      contributors,
      commitsByCategory: catCounts,
      commitMessages: branchCommits.map((c) => c.message),
    });
  }

  // 5. Sample commits — distribute MAX_TOTAL_SAMPLED_COMMITS fairly across branches.
  const branchCount = dedupedMap.size;
  const budgetPerBranch = branchCount > 0
    ? Math.min(MAX_COMMITS_PER_BRANCH, Math.max(1, Math.floor(MAX_TOTAL_SAMPLED_COMMITS / branchCount)))
    : MAX_COMMITS_PER_BRANCH;
  const allSampled: DigestSampledCommit[] = [];
  for (const [branchName, branchCommits] of dedupedMap) {
    const sampled = await sampleCommitsForDigest(repoPath, branchCommits, branchName, budgetPerBranch);
    allSampled.push(...sampled);
  }

  return {
    repositoryName: repository.name,
    periodStart: since,
    periodEnd: until,
    type,
    branches,
    totalCommits,
    totalContributors: [...allContributors],
    sampledCommits: allSampled.slice(0, MAX_TOTAL_SAMPLED_COMMITS),
    categorySummary: globalCategorySummary,
    defaultBranch,
  };
}

// ---------------------------------------------------------------------------
// AI prompt
// ---------------------------------------------------------------------------

export async function resolveDigestPrompt(
  data: DigestData,
): Promise<Awaited<ReturnType<typeof resolvePromptText>>> {
  const typeLabel = data.type === 'daily' ? '日报' : '周报';
  const periodLabel = `${data.periodStart.slice(0, 10)} ~ ${data.periodEnd.slice(0, 10)}`;

  const branchDetails = data.branches
    .map((b) => {
      const msgList = b.commitMessages
        .map((m) => `  - ${m}`)
        .join('\n');
      const authors = b.contributors.join(', ') || '无';
      return [
        `### ${b.name}${b.name === data.defaultBranch ? '（默认分支）' : ''}`,
        `提交数：${b.commitCount}`,
        `贡献者：${authors}`,
        `分类统计：feature ${b.commitsByCategory.feature} / fix ${b.commitsByCategory.fix} / refactor ${b.commitsByCategory.refactor} / docs ${b.commitsByCategory.docs} / test ${b.commitsByCategory.test} / chore ${b.commitsByCategory.chore} / other ${b.commitsByCategory.other}`,
        '提交记录：',
        msgList || '  - 本周期没有提交记录',
      ].join('\n');
    })
    .join('\n\n');

  const sampledSection = data.sampledCommits
    .map(
      (s) =>
        `#### ${s.branch} — ${s.sha.slice(0, 8)} by ${s.author} (${s.date})\n` +
        `Message: ${s.message}\n` +
        `DiffStat: ${s.diffStat || '(no diffstat available)'}`,
    )
    .join('\n\n');

  return resolvePromptText({
    promptKey: 'repo_review.digest',
    variables: {
      typeLabel,
      repositoryName: data.repositoryName,
      periodLabel,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      branchCount: data.branches.length,
      totalCommits: data.totalCommits,
      contributorCount: data.totalContributors.length,
      defaultBranch: data.defaultBranch,
      branchDetails: branchDetails || '本周期没有分支提交记录。',
      sampledSection: sampledSection || '本周期没有可抽样的重点提交。',
    },
    fallbackText: REPO_REVIEW_DIGEST_TEMPLATE,
  });
}

export async function buildDigestPrompt(data: DigestData): Promise<string> {
  const resolved = await resolveDigestPrompt(data);
  return resolved.text;
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

function slugifyId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function runDigestAgent(
  repository: ReviewRepositoryRecord,
  prompt: string,
  runId: string,
): Promise<string> {
  const repoPath =
    repository.local_repo_path || getRepoMirrorPath(repository.id);
  const assistantName = await getAssistantName();
  const chatJid =
    repository.review_chat_jid || `repo-review:${repository.id}`;
  const group: RegisteredGroup = {
    name: `Repo Digest ${repository.name}`,
    folder: `digest-${slugifyId(repository.id)}`,
    trigger: '@repo-digest',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };
  const agentInput: AgentRunInput = {
    prompt: { text: prompt },
    groupFolder: group.folder,
    chatJid,
    isMain: false,
    isScheduledTask: true,
    disableDefaultWebSearch: true,
    assistantName,
    runtimeNamespace: runId,
    managedSkillIds: [],
    managedMcpServerIds: [],
    suppressDefaultSystemPrompt: true,
    suppressScheduledTaskPreamble: true,
  };
  if (repoPath) {
    const allowedDirectories = buildRepoReviewReadOnlyAllowedDirectories(
      repoPath,
      repository.local_repo_path,
    );
    agentInput.extraMounts = [
      { hostPath: repoPath, targetPath: '/workspace/extra', readonly: true },
    ];
    agentInput.accessModeOverride = 'readonly';
    agentInput.allowedDirectoriesOverride = allowedDirectories;
    agentInput.workingDirectory = '/workspace/extra';
  }

  let capturedResult = '';
  let latestAssistantText = '';

  const result = await runAgentProcess(
    group,
    agentInput,
    () => {},
    async (output) => {
      if (output.turnEvent && 'item' in output.turnEvent) {
        const ev = output.turnEvent;
        if (
          ev.type === 'item.completed' &&
          ev.item.type === 'assistant_message' &&
          ev.item.status === 'completed' &&
          ev.item.text?.trim()
        ) {
          latestAssistantText = ev.item.text.trim();
        }
      }
      if (output.result) {
        capturedResult = output.result;
      }
    },
  );
  if (latestAssistantText) return latestAssistantText;
  if (capturedResult) return capturedResult;
  if (result.result) return result.result;
  if (result.status !== 'success') {
    throw new Error(result.error || 'Digest agent did not return a result');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function publishDigestMessage(
  repository: ReviewRepositoryRecord,
  content: string,
): Promise<{
  deliveryStatus: 'pending' | 'delivered' | 'failed' | 'not_configured';
  deliveryError: string;
}> {
  const chatJid =
    repository.review_chat_jid || `repo-review:${repository.id}`;
  if (digestMessageSender) {
    try {
      await digestMessageSender(chatJid, { text: content });
      return {
        deliveryStatus: 'delivered',
        deliveryError: '',
      };
    } catch (err) {
      const deliveryError =
        err instanceof Error ? err.message : String(err);
      logger.error(
        { err, repositoryId: repository.id, chatJid },
        'Failed to send digest message',
      );
      return {
        deliveryStatus: 'failed',
        deliveryError,
      };
    }
  } else {
    logger.info(
      { repositoryId: repository.id, contentLength: content.length },
      'Digest message sender not configured, message logged only',
    );
    return {
      deliveryStatus: 'not_configured',
      deliveryError: '',
    };
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function generateDigestRunId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `digest-run-${ts}-${rand}`;
}

export async function executeDigest(
  repository: ReviewRepositoryRecord,
  type: 'daily' | 'weekly',
  scheduledFor?: string,
): Promise<DigestRunRecord | null> {
  const runId = generateDigestRunId();
  const startedAt = new Date().toISOString();
  const hour = type === 'daily'
    ? (repository.digest_daily_hour ?? 18)
    : (repository.digest_weekly_hour ?? 18);
  const weekDay = type === 'weekly' ? (repository.digest_weekly_day ?? 5) : undefined;
  const scheduledSlot =
    scheduledFor || computeNextDigestAt(type, hour, weekDay, new Date(), TIMEZONE);
  const { periodStart, periodEnd } = computeDigestWindow(
    type,
    hour,
    scheduledSlot,
    weekDay,
    TIMEZONE,
  );

  let run: DigestRunRecord;
  try {
    run = await saveDigestRun({
      id: runId,
      repository_id: repository.id,
      type,
      scheduled_for: scheduledSlot,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'running',
      timezone: TIMEZONE,
      started_at: startedAt,
    });
  } catch (err) {
    logger.error({ err, repositoryId: repository.id, type }, 'Failed to create digest run');
    return null;
  }

  try {
    // 1. Collect git data
    const data = await collectDigestData(repository, periodStart, periodEnd, type);

    await updateDigestRun(run.id, {
      branch_count: data.branches.length,
      commit_count: data.totalCommits,
      contributor_count: data.totalContributors.length,
    });

    // 2. Build prompt & run AI
    const prompt = await buildDigestPrompt(data);
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: 'repo_review.digest',
      featureScope: 'repo_review',
      userPromptText: prompt,
      providerInputText: prompt,
      metadata: {
        runId: run.id,
        repositoryId: repository.id,
        digestType: type,
        branchCount: data.branches.length,
      },
    });
    let aiResult: string;
    try {
      aiResult = await runDigestAgent(repository, prompt, runId);
    } catch (agentErr) {
      logger.warn(
        { err: agentErr, repositoryId: repository.id, runId },
        'Digest AI agent failed, using fallback summary',
      );
      aiResult = '';
    }

    if (!aiResult.trim()) {
      aiResult = buildFallbackSummary(data);
    }

    // 3. Deliver
    const typeLabel = type === 'daily' ? '日报' : '周报';
    const branchNames = data.branches.map((b) => b.name).join('、') || '无';
    const contributors = data.totalContributors.join('、') || '无';
    const header = `## ${repository.name} ${typeLabel}\n` +
      `周期：${periodStart.slice(0, 10)} 至 ${periodEnd.slice(0, 10)} · 分支：${branchNames} · 提交：${data.totalCommits} · 贡献者：${contributors}\n\n`;
    const delivery = await publishDigestMessage(repository, header + aiResult);

    // 4. Mark complete
    const completedAt = new Date().toISOString();
    await updateDigestRun(run.id, {
      status: 'completed',
      summary: aiResult,
      completed_at: completedAt,
      duration_ms: Math.max(
        0,
        Date.parse(completedAt) - Date.parse(startedAt),
      ),
      delivery_status: delivery.deliveryStatus,
      delivery_error: delivery.deliveryError,
    });

    return (await updateDigestRun(run.id, {})) || run;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const completedAt = new Date().toISOString();
    logger.error(
      { err, repositoryId: repository.id, runId, type },
      'Digest execution failed',
    );
    await updateDigestRun(run.id, {
      status: 'failed',
      error_message: errMsg,
      completed_at: completedAt,
      duration_ms: Math.max(
        0,
        Date.parse(completedAt) - Date.parse(startedAt),
      ),
    });
    return null;
  }
}

/**
 * Strip conventional-commit prefix (e.g. "fix(db): xxx" → "xxx") and
 * capitalise the first letter so bullet lists read naturally.
 */
function humaniseCommitMessage(raw: string): string {
  const stripped = raw.replace(/^(?:feat|fix|refactor|perf|docs?|tests?|chore|build|ci)(?:\([^)]*\))?[!:]?\s*/i, '').trim();
  if (!stripped) return raw.trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Deduplicate messages that only differ in casing or trailing punctuation. */
function deduplicateMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const msg of messages) {
    const key = msg.toLowerCase().replace(/[.。!！,，;；\s]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(msg);
  }
  return result;
}

function buildFallbackSummary(data: DigestData): string {
  if (data.totalCommits === 0) {
    return '本周期没有新的提交。';
  }

  const branchNames = data.branches.map((b) => b.name).join('、');

  // Section 1: narrative overview
  const overviewParts: string[] = [];
  if (data.categorySummary.feature > 0)
    overviewParts.push(`${data.categorySummary.feature} 个功能提交`);
  if (data.categorySummary.fix > 0)
    overviewParts.push(`${data.categorySummary.fix} 个修复提交`);
  if (data.categorySummary.refactor > 0)
    overviewParts.push(`${data.categorySummary.refactor} 个重构提交`);
  if (data.categorySummary.perf > 0)
    overviewParts.push(`${data.categorySummary.perf} 个性能优化提交`);
  const overviewLine = overviewParts.length > 0
    ? `本周期主要活跃分支：${branchNames || '无'}。共 ${data.totalCommits} 次提交，覆盖 ${overviewParts.join('，')}。`
    : `本周期主要活跃分支：${branchNames || '无'}。共 ${data.totalCommits} 次提交，未出现明显分类特征。`;
  const sections: string[] = [`## 总览\n${overviewLine}`];

  // Section 2: per-branch activity with key commits
  const branchLines = data.branches.map((b) => {
    const topMsgs = deduplicateMessages(b.commitMessages.map(humaniseCommitMessage)).slice(0, 5);
    const msgList = topMsgs.map((m) => `  - ${m}`).join('\n');
    const overflow = b.commitMessages.length > 5 ? `\n  - 还有 ${b.commitMessages.length - 5} 条提交未展开` : '';
    const contributors = b.contributors.join('、') || '无';
    return `- **${b.name}**（${contributors}）\n  提交数：${b.commitCount}\n${msgList}${overflow}`;
  }).join('\n');
  sections.push(`## 分支进展\n${branchLines || '- 本周期没有分支提交记录。'}`);

  // Section 3: file change heatmap from sampled diffs
  const fileHits = new Map<string, number>();
  for (const s of data.sampledCommits) {
    if (!s.diffStat) continue;
    for (const line of s.diffStat.split('\n')) {
      const m = line.match(/^\s*(.+?)\s+\|\s+\d+/);
      if (m) {
        const filePath = m[1].trim();
        fileHits.set(filePath, (fileHits.get(filePath) || 0) + 1);
      }
    }
  }
  if (fileHits.size > 0) {
    const topFiles = [...fileHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([f, count]) => `- ${f}：${count} 次出现在采样 diff 中`)
      .join('\n');
    sections.push(`## 重点文件\n${topFiles}`);
  }

  sections.push('## 后续关注\n- 如有发布或回归窗口，建议继续跟进测试、部署和风险收敛情况。');

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function runDigestOnce(repository: ReviewRepositoryRecord, type: 'daily' | 'weekly'): Promise<void> {
  const key = `${repository.id}:${type}`;
  if (digestInFlight.has(key)) return;
  const scheduledFor = type === 'daily'
    ? repository.next_digest_daily_at
    : repository.next_digest_weekly_at;
  if (!scheduledFor) return;

  const hour = type === 'daily'
    ? (repository.digest_daily_hour ?? 18)
    : (repository.digest_weekly_hour ?? 18);
  const weekDay = type === 'weekly' ? (repository.digest_weekly_day ?? 5) : undefined;
  const nextAt = computeNextDigestAt(type, hour, weekDay);

  // Advance next_digest_*_at BEFORE execution to prevent re-trigger on process restart.
  await updateReviewRepositoryDigestTimestamps({
    repositoryId: repository.id,
    type,
    nextDigestAt: nextAt,
  });

  if (
    await hasCompletedDigestRunForSchedule(
      repository.id,
      type,
      scheduledFor,
    )
  ) {
    logger.info(
      { repositoryId: repository.id, type, scheduledFor },
      'Digest skipped — completed run for schedule already exists',
    );
    return;
  }

  digestInFlight.add(key);
  try {
    logger.info({ repositoryId: repository.id, type }, 'Digest task starting');
    const result = await executeDigest(repository, type, scheduledFor);
    if (result) {
      await updateReviewRepositoryDigestTimestamps({
        repositoryId: repository.id,
        type,
        lastDigestAt: result.completed_at || new Date().toISOString(),
      });
    }
    logger.info({ repositoryId: repository.id, type, success: Boolean(result) }, 'Digest task finished');
  } catch (err) {
    logger.error({ err, repositoryId: repository.id, type }, 'Digest task failed');
  } finally {
    digestInFlight.delete(key);
  }
}

export function startRepoReviewDigestLoop(): void {
  if (digestLoopStarted) {
    logger.debug('Digest loop already running');
    return;
  }
  digestLoopStarted = true;
  logger.debug('Repo review digest loop started');

  const loop = async () => {
    try {
      const nowIso = new Date().toISOString();
      const repos = await listReviewRepositories();
      for (const repo of repos) {
        if (isDigestDue(repo, 'daily', nowIso)) {
          await runDigestOnce(repo, 'daily');
        }
        if (isDigestDue(repo, 'weekly', nowIso)) {
          await runDigestOnce(repo, 'weekly');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Digest loop iteration failed');
    }
    digestTimerHandle = setTimeout(loop, DIGEST_LOOP_INTERVAL_MS);
  };

  void loop();
}

/** @internal - for tests only. */
export function _resetDigestLoopForTests(): void {
  digestLoopStarted = false;
  if (digestTimerHandle !== null) {
    clearTimeout(digestTimerHandle);
    digestTimerHandle = null;
  }
  digestInFlight.clear();
}
