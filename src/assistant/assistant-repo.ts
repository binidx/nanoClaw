import { nanoid } from 'nanoid';
import { dba } from '../db/engine-access.js';
import { adaptSql } from '../db/sql-adapters.js';
import { getRepositoryMirrorPath } from '../repo-review/repo-review-git.js';
import { acquireWorktree } from '../agent/worktree-manager.js';
import { logger } from '../logger.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import {
  listBindingsByOwner,
  createBinding,
  deleteBinding,
  getBindingById,
  updateBindingConfig,
} from '../db/resource-bindings.js';
import type { ResourceBindingRecord } from '../db/resource-bindings.js';
import { getRepositoryById } from '../db/repositories.js';
import type { RepositoryRecord } from '../db/repositories.js';

/**
 * 助手仓库绑定对外视图。
 *
 * 实际持久化已全部归并到 `resource_bindings`（owner_type='assistant', resource_type='repository'）。
 * legacy 表 `assistant_repo_bindings` 仅用于一次性迁移脚本读取，不再参与运行时读写。
 */
export interface AssistantRepoBinding {
  id: string;
  assistant_id: string;
  repository_id: string;
  repo_url: string;
  name: string;
  description: string | null;
  local_path: string | null;
  default_branch: string;
  branch_filter: string[];
  active_branch: string | null;
  worktree_path: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface BindingConfig {
  display_name?: string;
  description?: string | null;
  /** 数组形式存储；老数据可能是 JSON 字符串，由 `parseBranchFilter` 兼容。 */
  branch_filter?: string | string[];
  active_branch?: string | null;
  worktree_path?: string | null;
  enabled?: boolean;
}

function parseConfig(raw: string | null): BindingConfig {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as BindingConfig)
      : {};
  } catch {
    return {};
  }
}

function parseBranchFilter(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch { return []; }
  }
  return [];
}

function toBinding(
  rb: ResourceBindingRecord,
  repo: Pick<RepositoryRecord, 'name' | 'clone_url'> | undefined,
): AssistantRepoBinding {
  const config = parseConfig(rb.config_json);
  return {
    id: rb.id,
    assistant_id: rb.owner_id,
    repository_id: rb.resource_id,
    repo_url: repo?.clone_url ?? '',
    name: config.display_name ?? repo?.name ?? '',
    description: config.description ?? null,
    local_path: rb.work_directory,
    default_branch: rb.branch ?? 'main',
    branch_filter: parseBranchFilter(config.branch_filter),
    active_branch: config.active_branch ?? null,
    worktree_path: config.worktree_path ?? null,
    enabled: config.enabled === false ? 0 : 1,
    created_at: rb.created_at,
    updated_at: rb.created_at,
  };
}

/** 取属于该 assistant 的 repository 类型 binding 原始记录，权限/类型校验失败返回 undefined。 */
async function loadOwnedRb(
  assistantId: string,
  bindingId: string,
): Promise<ResourceBindingRecord | undefined> {
  const rb = await getBindingById(bindingId);
  if (!rb
    || rb.owner_type !== 'assistant'
    || rb.owner_id !== assistantId
    || rb.resource_type !== 'repository'
  ) {
    return undefined;
  }
  return rb;
}

export async function listAssistantRepoBindings(
  assistantId: string,
): Promise<AssistantRepoBinding[]> {
  const bindings = await listBindingsByOwner('assistant', assistantId);
  const results: AssistantRepoBinding[] = [];
  for (const rb of bindings) {
    if (rb.resource_type !== 'repository') continue;
    const repo = await getRepositoryById(rb.resource_id);
    results.push(toBinding(rb, repo ?? undefined));
  }
  return results;
}

export async function getAssistantRepoBinding(
  assistantId: string,
  bindingId: string,
): Promise<AssistantRepoBinding | undefined> {
  const rb = await loadOwnedRb(assistantId, bindingId);
  if (!rb) return undefined;
  const repo = await getRepositoryById(rb.resource_id);
  return toBinding(rb, repo ?? undefined);
}

/**
 * 创建助手仓库绑定。
 *
 * 若 `repoUrl` 对应的 `repositories` 不存在，会自动创建一条（向后兼容旧 API 的"任意 URL 绑定"语义）。
 */
export async function createAssistantRepoBinding(input: {
  assistantId: string;
  repoUrl: string;
  name: string;
  description?: string | null;
  defaultBranch?: string;
  branchFilter?: string[];
}): Promise<AssistantRepoBinding> {
  if (!input.repoUrl) {
    throw new Error('repoUrl is required to create an assistant repo binding');
  }

  const id = nanoid(27);
  const now = new Date().toISOString();
  const defaultBranch = input.defaultBranch ?? 'main';

  const existing = (await dba
    .prepare(adaptSql('SELECT id FROM repositories WHERE clone_url = ? AND deleted_at IS NULL LIMIT 1'))
    .get(input.repoUrl)) as { id: string } | undefined;
  const repoId = existing?.id ?? ('arb_' + id);
  if (!existing) {
    await dba
      .prepare(adaptSql(`INSERT INTO repositories (
        id, name, clone_url, default_target_branch,
        auto_sync_enabled, auto_sync_interval_minutes, enabled,
        status, user_id, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 30, 1, 'active', ?, ?, ?, ?, ?)`))
      .run(repoId, input.name, input.repoUrl, defaultBranch, SYSTEM_USER_ID, SYSTEM_USER_ID, SYSTEM_USER_ID, now, now);
  }

  const config: BindingConfig = {
    display_name: input.name,
    description: input.description ?? null,
    branch_filter: input.branchFilter ?? [],
    active_branch: null,
    worktree_path: null,
    enabled: true,
  };
  await createBinding(
    {
      id,
      resourceType: 'repository',
      resourceId: repoId,
      ownerType: 'assistant',
      ownerId: input.assistantId,
      branch: defaultBranch,
      configJson: JSON.stringify(config),
    },
    SYSTEM_USER_ID,
  );

  const created = await getAssistantRepoBinding(input.assistantId, id);
  if (!created) {
    throw new Error('Failed to create assistant repo binding');
  }
  return created;
}

export async function updateAssistantRepoBinding(
  assistantId: string,
  bindingId: string,
  updates: Partial<{
    name: string;
    description: string | null;
    defaultBranch: string;
    branchFilter: string[];
    activeBranch: string | null;
    localPath: string | null;
    worktreePath: string | null;
    enabled: boolean;
  }>,
): Promise<AssistantRepoBinding | undefined> {
  const rb = await loadOwnedRb(assistantId, bindingId);
  if (!rb) return undefined;

  const config = parseConfig(rb.config_json);
  if (updates.name !== undefined) config.display_name = updates.name;
  if (updates.description !== undefined) config.description = updates.description;
  if (updates.branchFilter !== undefined) config.branch_filter = updates.branchFilter;
  if (updates.activeBranch !== undefined) config.active_branch = updates.activeBranch;
  if (updates.worktreePath !== undefined) config.worktree_path = updates.worktreePath;
  if (updates.enabled !== undefined) config.enabled = updates.enabled;
  await updateBindingConfig(bindingId, JSON.stringify(config));

  // branch 和 work_directory 是 resource_bindings 的一级字段，需要单独 UPDATE
  const colUpdates: string[] = [];
  const colParams: unknown[] = [];
  if (updates.defaultBranch !== undefined) { colUpdates.push('branch = ?'); colParams.push(updates.defaultBranch); }
  if (updates.localPath !== undefined) { colUpdates.push('work_directory = ?'); colParams.push(updates.localPath); }
  if (colUpdates.length > 0) {
    colParams.push(bindingId);
    await dba
      .prepare(adaptSql(`UPDATE resource_bindings SET ${colUpdates.join(', ')} WHERE id = ?`))
      .run(...colParams);
  }

  return getAssistantRepoBinding(assistantId, bindingId);
}

export async function deleteAssistantRepoBinding(
  assistantId: string,
  bindingId: string,
): Promise<boolean> {
  const rb = await loadOwnedRb(assistantId, bindingId);
  if (!rb) return false;
  return deleteBinding(bindingId);
}

export async function provisionAssistantRepoWorktree(
  assistantId: string,
  bindingId: string,
): Promise<string | null> {
  const rb = await loadOwnedRb(assistantId, bindingId);
  if (!rb) return null;
  const binding = toBinding(rb, await getRepositoryById(rb.resource_id));
  const branch = binding.active_branch || binding.default_branch || 'main';

  try {
    const worktreePath = await acquireWorktree({
      repositoryId: rb.resource_id,
      branch,
      cloneUrl: binding.repo_url,
      purpose: 'assistant',
    });
    if (!worktreePath) {
      logger.warn({ bindingId, branch }, 'Assistant repo worktree creation failed');
      return null;
    }

    const mirrorPath = getRepositoryMirrorPath(rb.resource_id);
    await updateAssistantRepoBinding(assistantId, bindingId, {
      localPath: mirrorPath,
      worktreePath,
      activeBranch: branch,
    });

    return worktreePath;
  } catch (err) {
    logger.error({ err, bindingId }, 'provisionAssistantRepoWorktree failed');
    return null;
  }
}

export async function switchAssistantRepoBranch(
  assistantId: string,
  bindingId: string,
  branch: string,
): Promise<string | null> {
  const rb = await loadOwnedRb(assistantId, bindingId);
  if (!rb) return null;
  const binding = toBinding(rb, await getRepositoryById(rb.resource_id));

  try {
    const worktreePath = await acquireWorktree({
      repositoryId: rb.resource_id,
      branch,
      cloneUrl: binding.repo_url,
      purpose: 'assistant',
    });
    if (!worktreePath) return null;

    const mirrorPath = getRepositoryMirrorPath(rb.resource_id);
    await updateAssistantRepoBinding(assistantId, bindingId, {
      worktreePath,
      activeBranch: branch,
      localPath: mirrorPath,
    });

    return worktreePath;
  } catch (err) {
    logger.error({ err, bindingId, branch }, 'switchAssistantRepoBranch failed');
    return null;
  }
}
