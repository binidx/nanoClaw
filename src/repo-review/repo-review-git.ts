import crypto from 'crypto';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type { ReviewRemoteProvider, ReviewRepositoryRecord } from '../db.js';
import { logger } from '../logger.js';
import {
  compareRepoReviewBranchSummaries,
  normalizeBranchName,
  stringValue,
  type LocalGitRemoteMetadataCacheEntry,
  type LocalGitRemoteMetadataInput,
  type RepoRemoteCandidate,
  type RepoReviewBranchSummary,
} from './repo-review-model.js';
import {
  REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH,
  REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
  REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
} from './repo-review-model.js';

export function normalizeRemoteBaseUrlValue(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function inferProviderFromHost(host: string): ReviewRemoteProvider | '' {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('github')) return 'github';
  if (normalized.includes('gitlab')) return 'gitlab';
  if (normalized.includes('gitea')) return 'gitea';
  return '';
}

export function normalizeRepoSlugValue(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
}

export function parseRepositoryUrlCandidate(
  rawValue: string,
  providerHint?: ReviewRemoteProvider | '',
): RepoRemoteCandidate | null {
  const value = rawValue.trim();
  if (!value) return null;

  const sshMatch = value.match(
    /^(?<user>[^@]+)@(?<host>[^:]+):(?<slug>.+?)(?:\.git)?$/i,
  );
  if (sshMatch?.groups?.host && sshMatch.groups.slug) {
    const host = sshMatch.groups.host.trim();
    const provider =
      providerHint || inferProviderFromHost(host) || providerHint || '';
    return {
      name: 'ssh',
      fetchUrl: value,
      provider,
      remoteRepoSlug: normalizeRepoSlugValue(sshMatch.groups.slug),
      remoteBaseUrl: `https://${host}`,
      cloneUrl: value,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return null;
  }

  const pathParts = parsedUrl.pathname
    .split('/')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const providerFromHost = inferProviderFromHost(parsedUrl.hostname);
  const proxiedHost = !providerFromHost ? pathParts[0] || '' : '';
  const providerFromProxyPath = inferProviderFromHost(proxiedHost);
  const provider =
    providerHint || providerFromHost || providerFromProxyPath || '';

  const resolvedOrigin = providerFromProxyPath
    ? `https://${proxiedHost}`
    : parsedUrl.protocol === 'ssh:'
      ? `https://${parsedUrl.hostname}`
      : parsedUrl.origin;

  if (pathParts.length === 0) {
    return {
      name: parsedUrl.hostname,
      fetchUrl: value,
      provider,
      remoteRepoSlug: '',
      remoteBaseUrl: normalizeRemoteBaseUrlValue(resolvedOrigin),
      cloneUrl: value,
    };
  }

  const pathWithoutApi =
    pathParts[0] === 'api' ? pathParts.slice(2) : [...pathParts];
  const normalizedPathParts =
    providerFromProxyPath && pathWithoutApi[0] === proxiedHost
      ? pathWithoutApi.slice(1)
      : pathWithoutApi;
  const slugParts = [...normalizedPathParts];
  if (slugParts[0] === '-') slugParts.splice(0, 1);
  if (slugParts.at(-1)?.toLowerCase() === 'repository') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'files') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'merge_requests') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'pull') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'pulls') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'tree') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'commit') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'commits') slugParts.pop();
  if (slugParts.at(-1)?.toLowerCase() === 'blob') slugParts.pop();
  while (slugParts.length > 2) {
    const tail = slugParts.at(-1)?.toLowerCase() || '';
    if (
      [
        'merge_requests',
        'merge_request',
        'pulls',
        'pull',
        'pipelines',
        'pipeline',
        'tree',
        'blob',
        'commit',
        'commits',
      ].includes(tail)
    ) {
      slugParts.pop();
      continue;
    }
    break;
  }

  const normalizedSlug = normalizeRepoSlugValue(slugParts.join('/'));
  const canonicalCloneUrl =
    providerFromProxyPath && provider === 'github'
      ? `https://${proxiedHost}/${normalizedSlug}.git`
      : value;

  return {
    name: parsedUrl.hostname,
    fetchUrl: value,
    provider,
    remoteRepoSlug: normalizedSlug,
    remoteBaseUrl: normalizeRemoteBaseUrlValue(resolvedOrigin),
    cloneUrl: canonicalCloneUrl,
  };
}

export function parseGitRemoteCandidates(
  text: string,
  providerHint?: ReviewRemoteProvider | '',
): RepoRemoteCandidate[] {
  const candidates = new Map<string, RepoRemoteCandidate>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, remoteName, remoteUrl, direction] = match;
    if (direction !== 'fetch') continue;
    const parsed = parseRepositoryUrlCandidate(remoteUrl, providerHint);
    if (!parsed) continue;
    candidates.set(remoteName, {
      ...parsed,
      name: remoteName,
    });
  }
  return Array.from(candidates.values());
}

export function pickBestRemoteCandidate(
  candidates: RepoRemoteCandidate[],
  providerHint?: ReviewRemoteProvider | '',
): RepoRemoteCandidate | null {
  if (candidates.length === 0) return null;
  if (providerHint) {
    const exact = candidates.find(
      (candidate) => candidate.provider === providerHint,
    );
    if (exact) return exact;
  }
  const origin = candidates.find((candidate) => candidate.name === 'origin');
  if (origin?.provider) return origin;
  const namedCompany = candidates.find(
    (candidate) => candidate.name === 'company',
  );
  if (namedCompany?.provider) return namedCompany;
  const recognized = candidates.find((candidate) =>
    Boolean(candidate.provider),
  );
  return recognized || origin || candidates[0] || null;
}


export function runGitCommand(
  repoPath: string,
  args: string[],
  allowFailure = false,
): string {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(
      `git ${args.join(' ')} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export const execFileAsync = promisify(execFile);

/**
 * Non-blocking async version of runGitCommand.
 * Use this in async code paths to avoid blocking the Node.js event loop.
 * Synchronous runGitCommand is retained for pre-commit/pre-push CLI hooks
 * where the process is short-lived and blocking is acceptable.
 */
export async function runGitCommandAsync(
  repoPath: string,
  args: string[],
  allowFailure = false,
  timeoutMs?: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch (err) {
    if (allowFailure) return '';
    throw new Error(
      `git ${args.join(' ')} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function resolveRepositoryLocalRepoPath(
  repository: Pick<ReviewRepositoryRecord, 'local_repo_path'>,
): string {
  return getLocalGitRemoteMetadata(repository).repoPath;
}

export function listGitRemoteFetchEntries(repoPath: string): Array<{
  name: string;
  url: string;
}> {
  const remotesText = runGitCommand(repoPath, ['remote', '-v'], true);
  const entries: Array<{ name: string; url: string }> = [];
  for (const rawLine of remotesText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, direction] = match;
    if (direction !== 'fetch') continue;
    entries.push({ name, url });
  }
  return entries;
}

const LOCAL_GIT_REMOTE_METADATA_TTL_MS = 30_000;
const localGitRemoteMetadataCache = new Map<
  string,
  LocalGitRemoteMetadataCacheEntry
>();

export function buildLocalGitRemoteMetadataCacheKey(
  repository: LocalGitRemoteMetadataInput,
): string {
  return [
    stringValue(repository.local_repo_path),
    stringValue(repository.clone_url),
    stringValue(repository.remote_provider),
    stringValue(repository.default_target_branch),
  ].join('\0');
}

export function resolveRepositoryRemoteNameFromEntries(
  repository: {
    clone_url?: string | null;
    remote_provider?: ReviewRemoteProvider | '' | null;
  },
  remoteEntries: Array<{ name: string; url: string }>,
): string {
  const cloneUrl = stringValue(repository.clone_url);
  if (cloneUrl) {
    const exact = remoteEntries.find((entry) => entry.url.trim() === cloneUrl);
    if (exact) return exact.name;
  }
  const parsedCandidates = parseGitRemoteCandidates(
    remoteEntries
      .map((entry) => `${entry.name} ${entry.url} (fetch)`)
      .join('\n'),
    repository.remote_provider || '',
  );
  const picked = pickBestRemoteCandidate(
    parsedCandidates,
    repository.remote_provider || '',
  );
  if (picked?.name) return picked.name;
  return remoteEntries[0]?.name || '';
}

export function resolveLocalRemoteDefaultBranchFromRepoPath(
  repository: {
    default_target_branch?: string | null;
  },
  repoPath: string,
  remoteName: string,
): string {
  if (!repoPath || !remoteName) {
    return normalizeBranchName(repository.default_target_branch || '');
  }
  if (repository.default_target_branch) {
    return normalizeBranchName(repository.default_target_branch);
  }
  const remoteHead = runGitCommand(
    repoPath,
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`],
    true,
  ).replace(`${remoteName}/`, '');
  if (remoteHead) return normalizeBranchName(remoteHead);
  const branches = runGitCommand(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    true,
  )
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== remoteName)
    .filter((entry) => !entry.startsWith(`${remoteName}/HEAD`))
    .map((entry) => normalizeBranchName(entry.replace(`${remoteName}/`, '')));
  return branches[0] || '';
}

export function getLocalGitRemoteMetadata(
  repository: LocalGitRemoteMetadataInput,
): LocalGitRemoteMetadataCacheEntry {
  const cacheKey = buildLocalGitRemoteMetadataCacheKey(repository);
  const cached = localGitRemoteMetadataCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.fetchedAt < LOCAL_GIT_REMOTE_METADATA_TTL_MS
  ) {
    if (cached.repoPath && cached.remoteName && !cached.defaultBranch) {
      const refreshed: LocalGitRemoteMetadataCacheEntry = {
        ...cached,
        defaultBranch: resolveLocalRemoteDefaultBranchFromRepoPath(
          repository,
          cached.repoPath,
          cached.remoteName,
        ),
        fetchedAt: Date.now(),
      };
      localGitRemoteMetadataCache.set(cacheKey, refreshed);
      return refreshed;
    }
    return cached;
  }

  const repoPath = stringValue(repository.local_repo_path);
  let resolvedRepoPath = '';
  let remoteName = '';
  let defaultBranch = normalizeBranchName(repository.default_target_branch || '');

  if (
    repoPath &&
    fs.existsSync(repoPath) &&
    fs.statSync(repoPath).isDirectory() &&
    runGitCommand(repoPath, ['rev-parse', '--git-dir'], true)
  ) {
    resolvedRepoPath = repoPath;
    const remoteEntries = listGitRemoteFetchEntries(repoPath);
    remoteName = resolveRepositoryRemoteNameFromEntries(repository, remoteEntries);
    defaultBranch = resolveLocalRemoteDefaultBranchFromRepoPath(
      repository,
      resolvedRepoPath,
      remoteName,
    );
  }

  const entry: LocalGitRemoteMetadataCacheEntry = {
    repoPath: resolvedRepoPath,
    remoteName,
    defaultBranch,
    fetchedAt: Date.now(),
  };
  localGitRemoteMetadataCache.set(cacheKey, entry);
  return entry;
}

export function clearLocalGitRemoteMetadataCache(): void {
  localGitRemoteMetadataCache.clear();
}

export function resolveRepositoryRemoteName(
  repository: LocalGitRemoteMetadataInput,
): string {
  return getLocalGitRemoteMetadata(repository).remoteName;
}

export function hasLocalGitRemoteAccess(
  repository: LocalGitRemoteMetadataInput,
): boolean {
  const metadata = getLocalGitRemoteMetadata(repository);
  return Boolean(metadata.repoPath && metadata.remoteName);
}

export async function refreshRepositoryRemoteRefs(
  repository: Pick<ReviewRepositoryRecord, 'id'> & LocalGitRemoteMetadataInput,
): Promise<{ repoPath: string; remoteName: string } | null> {
  const metadata = getLocalGitRemoteMetadata(repository);
  if (!metadata.repoPath || !metadata.remoteName) return null;
  await execFileAsync('git', ['fetch', '--prune', metadata.remoteName], {
    cwd: metadata.repoPath,
    encoding: 'utf8',
    windowsHide: true,
    timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
    env: await gitEnvForRemoteAsync(repository.id),
  });
  localGitRemoteMetadataCache.set(
    buildLocalGitRemoteMetadataCacheKey(repository),
    {
      repoPath: metadata.repoPath,
      remoteName: metadata.remoteName,
      defaultBranch: normalizeBranchName(repository.default_target_branch || ''),
      fetchedAt: Date.now(),
    },
  );
  return { repoPath: metadata.repoPath, remoteName: metadata.remoteName };
}


export function getRepositoryMirrorPath(repositoryId: string): string {
  return path.join(DATA_DIR, 'repo-mirrors', repositoryId);
}

let sshKeyPermFixed = false;
let sshIdentityOverride: string | null = null;

export function fixSshKeyPermissions(): void {
  if (sshKeyPermFixed || process.platform === 'win32') return;
  sshKeyPermFixed = true;

  const sshDirs = new Set<string>();
  sshDirs.add(path.join(os.homedir(), '.ssh'));
  if (process.env.HOME) sshDirs.add(path.join(process.env.HOME, '.ssh'));
  sshDirs.add('/root/.ssh');

  logger.info({ dirs: [...sshDirs] }, 'Scanning SSH key directories');

  for (const sshDir of sshDirs) {
    for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa']) {
      const keyPath = path.join(sshDir, name);
      try {
        if (!fs.existsSync(keyPath)) continue;
        const tmp = path.join(os.tmpdir(), `nanoclaw-ssh-${name}`);
        fs.copyFileSync(keyPath, tmp);
        fs.chmodSync(tmp, 0o600);
        sshIdentityOverride = tmp;
        logger.info({ keyPath, tmp }, 'Copied SSH key with correct permissions');
        return;
      } catch (err) {
        logger.warn({ err, keyPath }, 'Failed to copy SSH key');
      }
    }
  }
  logger.info('No SSH keys found in any standard location');
}

const sshKeyTmpCache = new Map<string, string>();

export function invalidateSshKeyTmpCache(keyId?: string): void {
  if (keyId) {
    const p = sshKeyTmpCache.get(keyId);
    if (p) { try { fs.unlinkSync(p); } catch { /* ok */ } }
    sshKeyTmpCache.delete(keyId);
  } else {
    for (const p of sshKeyTmpCache.values()) {
      try { fs.unlinkSync(p); } catch { /* ok */ }
    }
    sshKeyTmpCache.clear();
  }
}

async function resolveSshKeyPath(
  repositoryId?: string,
): Promise<string | null> {
  const { getReviewRepositoryById, getSshKeyById, getDefaultSshKey } =
    await import('../db.js');

  let keyRecord;
  if (repositoryId) {
    const repo = await getReviewRepositoryById(repositoryId);
    if (repo?.ssh_key_id) {
      keyRecord = await getSshKeyById(repo.ssh_key_id);
    }
  }
  if (!keyRecord) {
    keyRecord = await getDefaultSshKey();
  }
  if (!keyRecord) return null;

  const cached = sshKeyTmpCache.get(keyRecord.id);
  if (cached && fs.existsSync(cached)) return cached;

  const tmpPath = path.join(os.tmpdir(), `nanoclaw-ssh-db-${keyRecord.id}`);
  fs.writeFileSync(tmpPath, keyRecord.private_key, { mode: 0o600 });
  sshKeyTmpCache.set(keyRecord.id, tmpPath);
  return tmpPath;
}

function buildSshCommand(keyPath: string | null): string {
  const base = 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes';
  return keyPath ? `${base} -i ${keyPath}` : base;
}

export function gitEnvForRemote(keyPathOverride?: string | null): Record<string, string> {
  fixSshKeyPermissions();
  const effectiveKey = keyPathOverride ?? sshIdentityOverride;
  return {
    ...process.env as Record<string, string>,
    GIT_SSH_COMMAND: buildSshCommand(effectiveKey),
    GIT_SSL_NO_VERIFY: '1',
  };
}

export async function gitEnvForRemoteAsync(
  repositoryId?: string,
): Promise<Record<string, string>> {
  const dbKey = await resolveSshKeyPath(repositoryId);
  if (dbKey) return gitEnvForRemote(dbKey);
  return gitEnvForRemote();
}

export function buildHttpsCloneUrl(repository: ReviewRepositoryRecord): string | null {
  if (!repository.platform_token || !repository.remote_repo_slug) return null;
  const provider = repository.remote_provider;
  if (!provider) return null;
  const token = repository.platform_token;
  const slug = repository.remote_repo_slug.trim();

  let host = '';
  const rawBase = (repository.remote_base_url || '').trim().replace(/\/+$/, '');
  if (rawBase) {
    try {
      host = new URL(rawBase.replace(/\/api\/v[14]$/, '')).host;
    } catch { /* ignore */ }
  }
  if (!host && repository.clone_url) {
    const m = repository.clone_url.match(/^git@([^:]+):/)
      || repository.clone_url.match(/^ssh:\/\/[^@]*@([^:/]+)/i);
    if (m) host = m[1];
  }
  if (!host) {
    const defaults: Record<string, string> = { gitlab: 'gitlab.com', github: 'github.com' };
    host = defaults[provider] || 'gitea.com';
  }

  const encodedToken = encodeURIComponent(token);
  if (provider === 'gitlab') {
    return `https://oauth2:${encodedToken}@${host}/${slug}.git`;
  }
  if (provider === 'github') {
    return `https://x-access-token:${encodedToken}@${host}/${slug}.git`;
  }
  return `https://${encodedToken}@${host}/${slug}.git`;
}

function cleanGitLocks(repoDir: string): void {
  const gitDir = path.join(repoDir, '.git');
  if (!fs.existsSync(gitDir)) return;
  const lockFiles = [
    path.join(gitDir, 'index.lock'),
    path.join(gitDir, 'HEAD.lock'),
  ];
  const refsHeads = path.join(gitDir, 'refs', 'heads');
  if (fs.existsSync(refsHeads)) {
    try {
      for (const f of fs.readdirSync(refsHeads)) {
        if (f.endsWith('.lock')) lockFiles.push(path.join(refsHeads, f));
      }
    } catch { /* ignore */ }
  }
  for (const lockFile of lockFiles) {
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
        logger.warn({ lockFile }, 'Removed stale git lock file');
      }
    } catch (err) {
      logger.warn({ err, lockFile }, 'Failed to remove git lock file');
    }
  }
}

export async function ensureRepositoryMirror(
  cloneUrl: string,
  repositoryId: string,
  fallbackCloneUrl?: string,
): Promise<string | null> {
  if (!cloneUrl) return null;
  const gitEnv = await gitEnvForRemoteAsync(repositoryId);
  const mirrorPath = getRepositoryMirrorPath(repositoryId);
  if (fs.existsSync(path.join(mirrorPath, '.git'))) {
    cleanGitLocks(mirrorPath);
    try {
      await execFileAsync(
        'git',
        ['remote', 'set-branches', 'origin', '*'],
        { cwd: mirrorPath, encoding: 'utf8', windowsHide: true },
      ).catch((err) => {
        logger.debug({ err, mirrorPath }, 'Failed to set remote branches (non-critical)');
      });
      await execFileAsync('git', ['fetch', 'origin', '--prune'], {
        cwd: mirrorPath,
        encoding: 'utf8',
        windowsHide: true,
        timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
        env: gitEnv,
      });
      return mirrorPath;
    } catch {
      if (fallbackCloneUrl) {
        try {
          await execFileAsync(
            'git',
            ['remote', 'set-url', 'origin', fallbackCloneUrl],
            { cwd: mirrorPath, encoding: 'utf8', windowsHide: true },
          );
          await execFileAsync('git', ['fetch', 'origin', '--prune'], {
            cwd: mirrorPath,
            encoding: 'utf8',
            windowsHide: true,
            timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
            env: gitEnv,
          });
          return mirrorPath;
        } catch { /* HTTPS fetch also failed, delete mirror */ }
      }
      fs.rmSync(mirrorPath, { recursive: true, force: true });
    }
  }
  const urlsToTry = [cloneUrl];
  if (fallbackCloneUrl && fallbackCloneUrl !== cloneUrl) {
    urlsToTry.push(fallbackCloneUrl);
  }
  for (const url of urlsToTry) {
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    try {
      await execFileAsync(
        'git',
        ['clone', '--depth', '64', '--no-single-branch', url, mirrorPath],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
          env: gitEnv,
        },
      );
      return mirrorPath;
    } catch (err) {
      fs.rmSync(mirrorPath, { recursive: true, force: true });
      const isLast = url === urlsToTry[urlsToTry.length - 1];
      logger.warn(
        { err, repositoryId, cloneUrl: url, isLast },
        isLast
          ? 'Failed to create repository mirror'
          : 'Mirror clone failed, trying fallback URL',
      );
    }
  }
  return null;
}

const MIRROR_RECOVERY_COOLDOWN_MS = 5 * 60_000;
const mirrorRecoveryCooldowns = new Map<string, number>();

export async function tryRecoverLocalMirror(
  repository: ReviewRepositoryRecord,
): Promise<boolean> {
  if (!repository.clone_url) return false;

  const lastAttempt = mirrorRecoveryCooldowns.get(repository.id);
  if (lastAttempt && Date.now() - lastAttempt < MIRROR_RECOVERY_COOLDOWN_MS) {
    return false;
  }
  mirrorRecoveryCooldowns.set(repository.id, Date.now());

  try {
    const httpsUrl = buildHttpsCloneUrl(repository) || undefined;
    const mirrorPath = await ensureRepositoryMirror(
      repository.clone_url,
      repository.id,
      httpsUrl,
    );
    if (!mirrorPath) return false;
    if (mirrorPath !== repository.local_repo_path) {
      repository.local_repo_path = mirrorPath;
    }
    clearLocalGitRemoteMetadataCache();
    const ok = hasLocalGitRemoteAccess(repository);
    if (ok) mirrorRecoveryCooldowns.delete(repository.id);
    return ok;
  } catch (err) {
    logger.warn(
      { err, repositoryId: repository.id },
      'Failed to recover local mirror for branch listing',
    );
    return false;
  }
}

export async function cloneRemoteWorkspace(
  url: string,
  branch: string,
  workspacePath: string,
  repositoryId?: string,
): Promise<void> {
  await execFileAsync(
    'git',
    [
      'clone',
      '--depth',
      String(REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH),
      '--branch',
      branch,
      url,
      workspacePath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
      env: await gitEnvForRemoteAsync(repositoryId),
    },
  );
}

export async function prepareRemoteWorkspace(
  repository: ReviewRepositoryRecord,
  branch: string,
  headSha: string,
  baseSha = '',
): Promise<string | null> {
  const cloneUrl = stringValue(repository.clone_url);
  if (!cloneUrl || !branch) return null;
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-review-remote-'),
  );

  const httpsUrl = buildHttpsCloneUrl(repository);
  const urlsToTry = [cloneUrl];
  if (httpsUrl && httpsUrl !== cloneUrl) urlsToTry.push(httpsUrl);

  let cloned = false;
  for (const url of urlsToTry) {
    try {
      await cloneRemoteWorkspace(url, branch, workspacePath, repository.id);
      cloned = true;
      break;
    } catch (err) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      if (url === urlsToTry[urlsToTry.length - 1]) {
        logger.warn(
          { err, repositoryId: repository.id, branch },
          'Failed to prepare remote workspace, fallback to diff-only review',
        );
      }
      if (urlsToTry.indexOf(url) < urlsToTry.length - 1) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }
    }
  }
  if (!cloned) return null;

  try {
    const requiredRefs = Array.from(
      new Set([headSha, baseSha].map((entry) => stringValue(entry)).filter(Boolean)),
    );
    if (requiredRefs.length > 0) {
      await runGitCommandAsync(
        workspacePath,
        [
          'fetch',
          '--depth',
          String(REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH),
          'origin',
          ...requiredRefs,
        ],
        false,
        REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
      );
    }
    if (headSha) {
      const currentHead = await runGitCommandAsync(
        workspacePath,
        ['rev-parse', 'HEAD'],
        true,
        REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
      );
      if (currentHead && currentHead !== headSha) {
        await runGitCommandAsync(
          workspacePath,
          [
            'fetch',
            '--depth',
            String(REPO_REVIEW_REMOTE_WORKSPACE_CLONE_DEPTH),
            'origin',
            headSha,
          ],
          false,
          REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
        );
        await runGitCommandAsync(
          workspacePath,
          ['checkout', '--detach', headSha],
          false,
          REPO_REVIEW_REMOTE_WORKSPACE_GIT_TIMEOUT_MS,
        );
      }
    }
    return workspacePath;
  } catch (err) {
    logger.warn(
      { err, repositoryId: repository.id, branch },
      'Failed to prepare remote workspace, fallback to diff-only review',
    );
    fs.rmSync(workspacePath, { recursive: true, force: true });
    return null;
  }
}


export async function listBranchesViaLsRemote(
  repository: ReviewRepositoryRecord,
): Promise<RepoReviewBranchSummary[]> {
  const cloneUrl = stringValue(repository.clone_url);
  if (!cloneUrl) return [];
  const defaultBranch = normalizeBranchName(
    repository.default_target_branch || '',
  );
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--heads', cloneUrl],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        env: await gitEnvForRemoteAsync(repository.id),
      },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        const name = normalizeBranchName(
          (ref || '').replace(/^refs\/heads\//, ''),
        );
        if (!name) return null;
        return {
          name,
          headSha: stringValue(sha),
          parentSha: '',
          actor: '',
          title: '',
          latestCommitAt: '',
          defaultBranch: name === defaultBranch,
        };
      })
      .filter((entry): entry is RepoReviewBranchSummary => Boolean(entry))
      .sort(compareRepoReviewBranchSummaries);
  } catch (err) {
    logger.warn(
      { err, repositoryId: repository.id },
      'git ls-remote --heads failed for branch listing',
    );
    return [];
  }
}

export interface RepoReviewContributor {
  name: string;
  email: string;
}

/**
 * Shallow-clone a remote URL into a temp dir and read unique commit authors.
 * Cleans up the temp dir regardless of success/failure.
 */
export async function fetchContributorsFromRemoteUrl(
  cloneUrl: string,
  repositoryId?: string,
): Promise<RepoReviewContributor[]> {
  const tmpDir = path.join(os.tmpdir(), `nanoclaw-contributors-${Date.now()}`);
  try {
    await execFileAsync(
      'git',
      ['clone', '--bare', '--depth', '50', '--no-single-branch', cloneUrl, tmpDir],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
        env: await gitEnvForRemoteAsync(repositoryId),
      },
    );
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--all', '--format=%aN\x1f%aE'],
      {
        cwd: tmpDir,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    const seen = new Set<string>();
    const contributors: RepoReviewContributor[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [name, email] = trimmed.split('\x1f');
      const key = `${(name || '').toLowerCase()}|${(email || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      contributors.push({ name: name || '', email: email || '' });
    }
    return contributors;
  } catch (err) {
    logger.warn({ err, cloneUrl }, 'fetchContributorsFromRemoteUrl failed');
    return [];
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Async variants of sync git helpers — avoid blocking the event loop
// ---------------------------------------------------------------------------

export async function listGitRemoteFetchEntriesAsync(repoPath: string): Promise<Array<{
  name: string;
  url: string;
}>> {
  const remotesText = await runGitCommandAsync(repoPath, ['remote', '-v'], true);
  const entries: Array<{ name: string; url: string }> = [];
  for (const rawLine of remotesText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, direction] = match;
    if (direction !== 'fetch') continue;
    entries.push({ name, url });
  }
  return entries;
}

export async function resolveLocalRemoteDefaultBranchFromRepoPathAsync(
  repository: { default_target_branch?: string | null },
  repoPath: string,
  remoteName: string,
): Promise<string> {
  if (!repoPath || !remoteName) {
    return normalizeBranchName(repository.default_target_branch || '');
  }
  if (repository.default_target_branch) {
    return normalizeBranchName(repository.default_target_branch);
  }
  const remoteHead = (await runGitCommandAsync(
    repoPath,
    ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`],
    true,
  )).replace(`${remoteName}/`, '');
  if (remoteHead) return normalizeBranchName(remoteHead);
  const branchesRaw = await runGitCommandAsync(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    true,
  );
  const branches = branchesRaw
    .split('\n')
    .map((e) => e.trim())
    .filter(Boolean)
    .filter((e) => e !== remoteName)
    .filter((e) => !e.startsWith(`${remoteName}/HEAD`))
    .map((e) => normalizeBranchName(e.replace(`${remoteName}/`, '')));
  return branches[0] || '';
}

export async function hasLocalGitRemoteAccessAsync(
  repository: LocalGitRemoteMetadataInput,
): Promise<boolean> {
  const metadata = getLocalGitRemoteMetadata(repository);
  return Boolean(metadata.repoPath && metadata.remoteName);
}

export async function resolveRepositoryRemoteNameAsync(
  repository: LocalGitRemoteMetadataInput,
): Promise<string> {
  return getLocalGitRemoteMetadata(repository).remoteName;
}
