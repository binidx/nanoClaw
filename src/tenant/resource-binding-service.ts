import {
  listBindingsByOwner,
  listBindingsByResource,
  getBindingById,
  createBinding,
  deleteBinding,
} from '../db/resource-bindings.js';
import { getRepositoryById } from '../db/repositories.js';

export interface ResourceBindingInfo {
  id: string;
  resourceType: string;
  resourceId: string;
  ownerType: string;
  ownerId: string;
  bindingKey: string;
  branch: string | null;
  workDirectory: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  repositoryName?: string;
  repositoryCloneUrl?: string;
}

function safeParseConfig(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toBindingInfo(
  record: {
    id: string;
    resource_type: string;
    resource_id: string;
    owner_type: string;
    owner_id: string;
    binding_key: string;
    branch: string | null;
    work_directory: string | null;
    config_json: string | null;
    created_at: string;
  },
  repoName?: string,
  repoCloneUrl?: string,
): ResourceBindingInfo {
  return {
    id: record.id,
    resourceType: record.resource_type,
    resourceId: record.resource_id,
    ownerType: record.owner_type,
    ownerId: record.owner_id,
    bindingKey: record.binding_key,
    branch: record.branch,
    workDirectory: record.work_directory,
    config: safeParseConfig(record.config_json),
    createdAt: record.created_at,
    repositoryName: repoName,
    repositoryCloneUrl: repoCloneUrl,
  };
}

export async function listOwnerBindings(
  ownerType: string,
  ownerId: string,
  userId?: string,
): Promise<ResourceBindingInfo[]> {
  const records = await listBindingsByOwner(ownerType, ownerId);
  const results: ResourceBindingInfo[] = [];
  for (const r of records) {
    let repoName: string | undefined;
    let repoCloneUrl: string | undefined;
    if (r.resource_type === 'repository') {
      const repo = await getRepositoryById(r.resource_id, userId);
      if (repo) {
        repoName = repo.name;
        repoCloneUrl = repo.clone_url ?? undefined;
      }
    }
    results.push(toBindingInfo(r, repoName, repoCloneUrl));
  }
  return results;
}

export async function listResourceBindings(
  resourceType: string,
  resourceId: string,
): Promise<ResourceBindingInfo[]> {
  const records = await listBindingsByResource(resourceType, resourceId);
  return records.map((r) => toBindingInfo(r));
}

export async function createRepositoryBinding(
  ownerType: string,
  ownerId: string,
  repositoryId: string,
  opts: { branch?: string; workDirectory?: string; bindingKey?: string; config?: Record<string, unknown> },
  userId: string,
): Promise<ResourceBindingInfo> {
  const repo = await getRepositoryById(repositoryId, userId);
  if (!repo || repo.deleted_at) {
    throw new Error('Repository not found or deleted');
  }

  const record = await createBinding(
    {
      resourceType: 'repository',
      resourceId: repositoryId,
      ownerType,
      ownerId,
      bindingKey: opts.bindingKey,
      branch: opts.branch,
      workDirectory: opts.workDirectory,
      configJson: opts.config ? JSON.stringify(opts.config) : null,
    },
    userId,
  );

  return toBindingInfo(record, repo.name, repo.clone_url ?? undefined);
}

export async function removeBinding(
  id: string,
): Promise<boolean> {
  return deleteBinding(id);
}

export async function getBinding(
  id: string,
): Promise<ResourceBindingInfo | undefined> {
  const record = await getBindingById(id);
  if (!record) return undefined;
  let repoName: string | undefined;
  let repoCloneUrl: string | undefined;
  if (record.resource_type === 'repository') {
    const repo = await getRepositoryById(record.resource_id);
    if (repo) {
      repoName = repo.name;
      repoCloneUrl = repo.clone_url ?? undefined;
    }
  }
  return toBindingInfo(record, repoName, repoCloneUrl);
}
