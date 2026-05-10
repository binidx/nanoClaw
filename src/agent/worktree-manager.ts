import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';

import { nanoid } from 'nanoid';
import { DATA_DIR } from '../config.js';
import { dba } from '../db/engine-access.js';
import { logger } from '../logger.js';
import {
  ensureRepositoryMirror,
  getRepositoryMirrorPath,
  gitEnvForRemoteAsync,
} from '../repo-review/repo-review-git.js';
import { REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS } from '../repo-review/repo-review-model.js';

const execFileAsync = promisify(execFile);

const WORKTREE_META_FILE = '.nanoclaw-meta.json';

function worktreeBasePath(repositoryId: string): string {
  return path.join(DATA_DIR, 'review-workspaces', repositoryId);
}

function slugifyBranch(branch: string): string {
  const base = branch.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const hash = crypto.createHash('sha256').update(branch).digest('hex').slice(0, 8);
  return `${base}__${hash}`;
}

export interface WorktreeInfo {
  branch: string;
  workDirectory: string;
  lastUsedAt: string;
}

interface WorktreeRow {
  id: string;
  repository_id: string;
  branch: string;
  work_directory: string;
  status: string;
  created_at: string;
  last_used_at: string;
}

const inflightLocks = new Map<string, Promise<string | null>>();
const inflightMirrorEnsures = new Map<string, Promise<string | null>>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingRegisteredWorktreeError(err: unknown): boolean {
  const message = errorMessage(err);
  return (
    message.includes('missing but already registered worktree') ||
    message.includes('already registered worktree')
  );
}

async function pruneRepositoryWorktrees(
  mirrorPath: string,
  repositoryId: string,
  reason: string,
): Promise<void> {
  if (!fs.existsSync(path.join(mirrorPath, '.git'))) return;
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: mirrorPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    logger.info({ repositoryId, reason }, 'Pruned repository worktree registry');
  } catch (err) {
    logger.warn(
      { err, repositoryId, reason },
      'Failed to prune repository worktree registry',
    );
  }
}

function ensureRepositoryMirrorOnce(
  cloneUrl: string,
  repositoryId: string,
): Promise<string | null> {
  const existing = inflightMirrorEnsures.get(repositoryId);
  if (existing) return existing;
  const promise = ensureRepositoryMirror(cloneUrl, repositoryId).finally(() =>
    inflightMirrorEnsures.delete(repositoryId),
  );
  inflightMirrorEnsures.set(repositoryId, promise);
  return promise;
}

// ── public API ─────────────────────────────────────────────────

export async function acquireWorktree(input: {
  repositoryId: string;
  branch: string;
  cloneUrl?: string;
  checkoutRef?: string;
  purpose?: string;
}): Promise<string | null> {
  const { repositoryId, branch, cloneUrl, checkoutRef, purpose } = input;
  if (!branch) return null;

  const lockKey = `${repositoryId}:${branch}`;
  const existing = inflightLocks.get(lockKey);
  if (existing) return existing;

  const promise = acquireImpl(repositoryId, branch, cloneUrl, checkoutRef, purpose)
    .finally(() => inflightLocks.delete(lockKey));
  inflightLocks.set(lockKey, promise);
  return promise;
}

export async function listWorktrees(repositoryId: string): Promise<WorktreeInfo[]> {
  const rows = (await dba
    .prepare(`SELECT branch, work_directory, last_used_at FROM repository_worktrees WHERE repository_id = ? AND status = 'active' ORDER BY last_used_at DESC`)
    .all(repositoryId)) as Pick<WorktreeRow, 'branch' | 'work_directory' | 'last_used_at'>[];
  return rows.map((r) => ({
    branch: r.branch,
    workDirectory: r.work_directory,
    lastUsedAt: r.last_used_at,
  }));
}

export async function cleanupWorktrees(maxAgeDays = 3): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600_000).toISOString();
  const stale = (await dba
    .prepare(`SELECT id, repository_id, branch, work_directory FROM repository_worktrees WHERE status = 'active' AND last_used_at < ?`)
    .all(cutoff)) as Pick<WorktreeRow, 'id' | 'repository_id' | 'branch' | 'work_directory'>[];

  const prunedRepos = new Set<string>();
  for (const row of stale) {
    const mirrorPath = getRepositoryMirrorPath(row.repository_id);
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', row.work_directory], {
        cwd: mirrorPath, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });
    } catch (err) {
      logger.warn({ err, repoId: row.repository_id, dir: row.work_directory }, 'git worktree remove failed, falling back to rmSync');
    }
    try { fs.rmSync(row.work_directory, { recursive: true, force: true }); } catch { /* ok */ }

    await dba.prepare(`UPDATE repository_worktrees SET status = 'removed' WHERE id = ?`).run(row.id);
    prunedRepos.add(row.repository_id);
    logger.info({ repoId: row.repository_id, branch: row.branch }, 'Cleaned up stale worktree');
  }

  for (const repoId of prunedRepos) {
    const mirrorPath = getRepositoryMirrorPath(repoId);
    if (fs.existsSync(path.join(mirrorPath, '.git'))) {
      try {
        await execFileAsync('git', ['worktree', 'prune'], {
          cwd: mirrorPath, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        });
      } catch { /* best-effort */ }
    }

    const basePath = worktreeBasePath(repoId);
    try {
      const remaining = fs.readdirSync(basePath);
      if (remaining.length === 0) fs.rmdirSync(basePath);
    } catch { /* ok */ }
  }
}

/**
 * One-time startup migration. Order matters:
 * 1. Rename assistant-repo-* mirror dirs → real repositories.id (deletes stale worktree dirs)
 * 2. Scan remaining review-workspaces for .nanoclaw-meta.json → INSERT into repository_worktrees
 * 3. Cleanup old entries
 */
export async function migrateWorktreesFromLegacy(): Promise<void> {
  await migrateMirrorKeys();
  await migrateWorktreeMeta();
  await cleanupWorktrees(3);
}

// ── private helpers ────────────────────────────────────────────

async function acquireImpl(
  repositoryId: string,
  branch: string,
  cloneUrl?: string,
  checkoutRef?: string,
  purpose?: string,
): Promise<string | null> {
  const mirrorPath = getRepositoryMirrorPath(repositoryId);
  if (!fs.existsSync(path.join(mirrorPath, '.git'))) {
    if (!cloneUrl) return null;
    const created = await ensureRepositoryMirrorOnce(cloneUrl, repositoryId);
    if (!created) return null;
  }

  try {
    await execFileAsync('git', ['fetch', 'origin', '--prune'], {
      cwd: mirrorPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: REPO_REVIEW_REMOTE_WORKSPACE_CLONE_TIMEOUT_MS,
      env: await gitEnvForRemoteAsync(repositoryId),
    });
  } catch (err) {
    logger.warn({ err, repositoryId, branch }, 'Worktree mirror fetch failed');
    if (!cloneUrl) return null;
    const recovered = await ensureRepositoryMirrorOnce(cloneUrl, repositoryId);
    if (!recovered) return null;
  }

  const basePath = worktreeBasePath(repositoryId);
  const wtPath = path.join(basePath, slugifyBranch(branch));
  const now = new Date().toISOString();
  const targetRef = checkoutRef || `origin/${branch}`;

  if (fs.existsSync(wtPath)) {
    try {
      await execFileAsync(
        'git', ['checkout', '--detach', targetRef],
        { cwd: wtPath, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
      );
      await execFileAsync(
        'git', ['reset', '--hard', targetRef],
        { cwd: wtPath, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
      );
      await execFileAsync(
        'git', ['clean', '-fd'],
        { cwd: wtPath, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
      );
      await upsertRecord(repositoryId, branch, wtPath, now);
      return wtPath;
    } catch (err) {
      logger.warn({ err, repositoryId, branch }, 'Worktree update failed, recreating');
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], {
          cwd: mirrorPath, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        });
      } catch { /* ignore */ }
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(basePath, { recursive: true });

  // A worktree directory can be deleted while git still keeps a registration
  // in the mirror. Prune before creating so the deterministic path can be
  // reused instead of failing with "missing but already registered worktree".
  if (!fs.existsSync(wtPath)) {
    await pruneRepositoryWorktrees(mirrorPath, repositoryId, 'before-add');
  }

  const addWorktree = async () =>
    execFileAsync(
      'git',
      ['worktree', 'add', '--detach', wtPath, targetRef],
      {
        cwd: mirrorPath,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      },
    );

  try {
    try {
      await addWorktree();
    } catch (err) {
      if (!isMissingRegisteredWorktreeError(err)) {
        throw err;
      }
      await pruneRepositoryWorktrees(
        mirrorPath,
        repositoryId,
        'retry-missing-registered',
      );
      await addWorktree();
    }
    await upsertRecord(repositoryId, branch, wtPath, now);
    logger.info({ repositoryId, branch, purpose }, 'Worktree acquired');
    return wtPath;
  } catch (err) {
    logger.warn({ err, repositoryId, branch }, 'Failed to create worktree');
    fs.rmSync(wtPath, { recursive: true, force: true });
    return null;
  }
}

async function upsertRecord(
  repositoryId: string,
  branch: string,
  workDirectory: string,
  now: string,
): Promise<void> {
  const existingRow = (await dba
    .prepare(`SELECT id FROM repository_worktrees WHERE repository_id = ? AND branch = ?`)
    .get(repositoryId, branch)) as Pick<WorktreeRow, 'id'> | undefined;
  if (existingRow) {
    await dba
      .prepare(`UPDATE repository_worktrees SET work_directory = ?, status = 'active', last_used_at = ? WHERE id = ?`)
      .run(workDirectory, now, existingRow.id);
  } else {
    await dba
      .prepare(`INSERT INTO repository_worktrees (id, repository_id, branch, work_directory, status, created_at, last_used_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(nanoid(), repositoryId, branch, workDirectory, now, now);
  }
}

async function migrateWorktreeMeta(): Promise<void> {
  const wsRoot = path.join(DATA_DIR, 'review-workspaces');
  if (!fs.existsSync(wsRoot)) return;

  let repoDirs: fs.Dirent[];
  try { repoDirs = fs.readdirSync(wsRoot, { withFileTypes: true }); } catch { return; }

  let migrated = 0;
  for (const repoDir of repoDirs) {
    if (!repoDir.isDirectory()) continue;
    const repoBasePath = path.join(wsRoot, repoDir.name);
    let branchDirs: fs.Dirent[];
    try { branchDirs = fs.readdirSync(repoBasePath, { withFileTypes: true }); } catch { continue; }

    for (const branchDir of branchDirs) {
      if (!branchDir.isDirectory()) continue;
      const wtPath = path.join(repoBasePath, branchDir.name);
      const metaPath = path.join(wtPath, WORKTREE_META_FILE);
      try {
        const raw = fs.readFileSync(metaPath, 'utf8');
        const meta = JSON.parse(raw) as { branch?: string; repositoryId?: string; createdAt?: string };
        const repoId = meta.repositoryId || repoDir.name;
        const branch = meta.branch || branchDir.name;
        const createdAt = meta.createdAt || new Date().toISOString();

        const exists = (await dba
          .prepare(`SELECT id FROM repository_worktrees WHERE repository_id = ? AND branch = ?`)
          .get(repoId, branch)) as Pick<WorktreeRow, 'id'> | undefined;
        if (!exists) {
          await dba
            .prepare(`INSERT INTO repository_worktrees (id, repository_id, branch, work_directory, status, created_at, last_used_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
            .run(nanoid(), repoId, branch, wtPath, createdAt, createdAt);
          migrated++;
        }
      } catch {
        /* skip directories without valid meta */
      }
    }
  }
  if (migrated > 0) {
    logger.info({ count: migrated }, 'Migrated legacy worktree metadata to repository_worktrees table');
  }
}

const LEGACY_KEY_RE = /^assistant-repo-([A-Za-z0-9_-]{10,})$/;

async function migrateMirrorKeys(): Promise<void> {
  const mirrorsRoot = path.join(DATA_DIR, 'repo-mirrors');
  if (!fs.existsSync(mirrorsRoot)) return;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(mirrorsRoot, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(LEGACY_KEY_RE);
    if (!match) continue;

    const bindingId = match[1];
    const rb = (await dba
      .prepare(`SELECT resource_id FROM resource_bindings WHERE id = ? AND owner_type = 'assistant' AND resource_type = 'repository'`)
      .get(bindingId)) as { resource_id: string } | undefined;
    if (!rb) {
      logger.warn({ bindingId, dir: entry.name }, 'Legacy mirror dir has no matching resource_binding, skipping');
      continue;
    }

    const realRepoId = rb.resource_id;
    const oldPath = path.join(mirrorsRoot, entry.name);
    const newPath = path.join(mirrorsRoot, realRepoId);

    if (fs.existsSync(newPath)) {
      logger.info({ oldPath, newPath }, 'New mirror already exists, removing legacy duplicate');
      try { fs.rmSync(oldPath, { recursive: true, force: true }); } catch { /* ok */ }
    } else {
      try {
        fs.renameSync(oldPath, newPath);
        logger.info({ oldPath, newPath }, 'Renamed legacy mirror directory');
      } catch (err) {
        logger.warn({ err, oldPath, newPath }, 'Failed to rename legacy mirror directory');
      }
    }

    // Remove stale worktree dirs and DB rows keyed by the old legacy id
    const legacyWsDir = path.join(DATA_DIR, 'review-workspaces', entry.name);
    if (fs.existsSync(legacyWsDir)) {
      try { fs.rmSync(legacyWsDir, { recursive: true, force: true }); } catch { /* ok */ }
      logger.info({ legacyWsDir }, 'Removed legacy worktree directory');
    }
    await dba
      .prepare(`DELETE FROM repository_worktrees WHERE repository_id = ?`)
      .run(entry.name);
  }
}
