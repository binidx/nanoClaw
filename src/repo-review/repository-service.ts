import {
  listRepositories,
  getRepositoryById,
  saveRepository,
  updateRepository,
  deleteRepository,
  listRepoFeatures,
  listRepoFeaturesByRepositoryIds,
  upsertRepoFeature,
} from '../db/repositories.js';
import type {
  RepositoryRecord,
  RepositoryUpsertInput,
  RepoFeatureRecord,
} from '../db/repositories.js';
import { getAssistant } from '../db.js';
import { listBindingsByResource } from '../db/resource-bindings.js';
import { getWorkteam } from '../db/workteam.js';
import { getWorkflow } from '../db/workflows.js';
import { AUTO_PROFILE_ID } from '../workteam/runner-profile-resolver.js';
import { findProfileById } from '../workteam/runner-profiles.js';

export interface RepositoryInfo {
  id: string;
  name: string;
  language: string | null;
  localRepoPath: string | null;
  remoteProvider: string | null;
  remoteRepoSlug: string | null;
  remoteBaseUrl: string | null;
  cloneUrl: string | null;
  defaultTargetBranch: string | null;
  sshKeyId: string | null;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  lastAutoSyncAt: string | null;
  lastAutoSyncStatus: string | null;
  enabled: boolean;
  status: string | null;
  visibility: string | null;
  aiDescription: string | null;
  techStack: string[] | null;
  createdAt: string;
  updatedAt: string;
  features: RepoFeatureInfo[];
}

export interface RepoFeatureInfo {
  featureType: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface RepositoryAssistantRelationship {
  bindingId: string;
  assistantId: string;
  assistantName: string | null;
  branch: string | null;
  worktreePath: string | null;
}

export interface RepositoryWorkteamRelationship {
  ownerType?: 'workteam' | 'workflow';
  bindingId: string;
  workteamId: string;
  workteamName: string | null;
  bindingKey: string;
  branch: string | null;
}

export interface RepositoryRunnerProfileRelationship {
  profileId: string;
  profileName: string;
}

export interface RepositoryRelationships {
  repositoryId: string;
  assistantBindings: RepositoryAssistantRelationship[];
  workteamBindings: RepositoryWorkteamRelationship[];
  runnerProfile: RepositoryRunnerProfileRelationship | null;
}

function toRepositoryInfo(
  record: RepositoryRecord,
  features: RepoFeatureRecord[],
): RepositoryInfo {
  let techStack: string[] | null = null;
  try {
    techStack = record.tech_stack_json ? JSON.parse(record.tech_stack_json) : null;
  } catch {
    techStack = null;
  }

  return {
    id: record.id,
    name: record.name,
    language: record.language,
    localRepoPath: record.local_repo_path,
    remoteProvider: record.remote_provider,
    remoteRepoSlug: record.remote_repo_slug,
    remoteBaseUrl: record.remote_base_url,
    cloneUrl: record.clone_url,
    defaultTargetBranch: record.default_target_branch,
    sshKeyId: record.ssh_key_id,
    autoSyncEnabled: record.auto_sync_enabled === 1,
    autoSyncIntervalMinutes: record.auto_sync_interval_minutes,
    lastAutoSyncAt: record.last_auto_sync_at,
    lastAutoSyncStatus: record.last_auto_sync_status,
    enabled: record.enabled === 1,
    status: record.status,
    visibility: record.visibility,
    aiDescription: record.ai_description,
    techStack,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    features: features.map((f) => ({
      featureType: f.feature_type,
      enabled: f.enabled === 1,
      config: safeParseConfig(f.config_json),
    })),
  };
}

function safeParseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeParseNullableConfig(
  raw: string | null,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function getRepositoryList(
  userId?: string,
): Promise<RepositoryInfo[]> {
  const records = await listRepositories(userId);
  const ids = records.map((r) => r.id);
  const allFeatures = await listRepoFeaturesByRepositoryIds(ids);
  const byRepo = new Map<string, RepoFeatureRecord[]>();
  for (const f of allFeatures) {
    const list = byRepo.get(f.repository_id);
    if (list) list.push(f);
    else byRepo.set(f.repository_id, [f]);
  }
  return records.map((r) =>
    toRepositoryInfo(r, byRepo.get(r.id) ?? []),
  );
}

export async function getRepository(
  id: string,
  userId?: string,
): Promise<RepositoryInfo | undefined> {
  const record = await getRepositoryById(id, userId);
  if (!record) return undefined;
  return toRepositoryInfo(record, await listRepoFeatures(id, userId));
}

export async function createOrUpdateRepository(
  input: RepositoryUpsertInput,
  currentUserId: string,
): Promise<RepositoryInfo> {
  const record = await saveRepository(input, currentUserId);
  return toRepositoryInfo(
    record,
    await listRepoFeatures(record.id, currentUserId),
  );
}

export async function patchRepository(
  id: string,
  updates: Partial<RepositoryUpsertInput>,
  userId: string,
): Promise<RepositoryInfo | undefined> {
  const record = await updateRepository(id, updates, userId);
  if (!record) return undefined;
  return toRepositoryInfo(record, await listRepoFeatures(id, userId));
}

export async function removeRepository(
  id: string,
  userId: string,
): Promise<void> {
  await deleteRepository(id, userId);
}

export async function getFeatures(
  repositoryId: string,
  userId?: string,
): Promise<RepoFeatureInfo[]> {
  return (await listRepoFeatures(repositoryId, userId)).map((f) => ({
    featureType: f.feature_type,
    enabled: f.enabled === 1,
    config: safeParseConfig(f.config_json),
  }));
}

export async function setFeature(
  repositoryId: string,
  featureType: string,
  enabled: boolean,
  config: Record<string, unknown>,
): Promise<RepoFeatureInfo> {
  const record = await upsertRepoFeature(
    repositoryId,
    featureType,
    enabled,
    JSON.stringify(config),
  );
  return {
    featureType: record.feature_type,
    enabled: record.enabled === 1,
    config: safeParseConfig(record.config_json),
  };
}

export async function getRepositoryRelationships(
  repositoryId: string,
  userId?: string,
): Promise<RepositoryRelationships | undefined> {
  const repository = await getRepository(repositoryId, userId);
  if (!repository) return undefined;

  const bindings = await listBindingsByResource('repository', repositoryId);
  const assistantBindings: RepositoryAssistantRelationship[] = [];
  const workteamBindings: RepositoryWorkteamRelationship[] = [];
  let runnerProfile: RepositoryRunnerProfileRelationship | null = null;

  for (const binding of bindings) {
    if (binding.owner_type === 'assistant') {
      const assistant = await getAssistant(binding.owner_id);
      const config = safeParseNullableConfig(binding.config_json);
      assistantBindings.push({
        bindingId: binding.id,
        assistantId: binding.owner_id,
        assistantName: assistant?.name ?? null,
        branch: binding.branch,
        worktreePath:
          typeof config.worktree_path === 'string'
            ? config.worktree_path
            : null,
      });
      continue;
    }

    if (binding.owner_type === 'workteam') {
      const team = await getWorkteam(binding.owner_id);
      workteamBindings.push({
        ownerType: 'workteam',
        bindingId: binding.id,
        workteamId: binding.owner_id,
        workteamName: team?.name ?? null,
        bindingKey: binding.binding_key,
        branch: binding.branch,
      });
      continue;
    }

    if (binding.owner_type === 'workflow') {
      const workflow = await getWorkflow(binding.owner_id);
      workteamBindings.push({
        ownerType: 'workflow',
        bindingId: binding.id,
        workteamId: binding.owner_id,
        workteamName: workflow?.name ?? null,
        bindingKey: binding.binding_key,
        branch: binding.branch,
      });
      continue;
    }

    if (
      binding.owner_type === 'repository' &&
      binding.owner_id === repositoryId &&
      binding.binding_key === 'runner_profile'
    ) {
      const config = safeParseNullableConfig(binding.config_json);
      const profileId =
        typeof config.profile_id === 'string' ? config.profile_id.trim() : '';
      if (!profileId) continue;
      runnerProfile = {
        profileId,
        profileName:
          profileId === AUTO_PROFILE_ID
            ? 'Auto Detect'
            : findProfileById(profileId)?.name || profileId,
      };
    }
  }

  return {
    repositoryId,
    assistantBindings,
    workteamBindings,
    runnerProfile,
  };
}
