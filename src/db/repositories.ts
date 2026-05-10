import { nanoid } from 'nanoid';

import { dba } from './engine-access.js';

export interface RepositoryRecord {
  id: string;
  name: string;
  language: string | null;
  local_repo_path: string | null;
  remote_provider: string | null;
  remote_repo_slug: string | null;
  remote_base_url: string | null;
  clone_url: string | null;
  default_target_branch: string | null;
  ssh_key_id: string | null;
  auto_sync_enabled: number;
  auto_sync_interval_minutes: number;
  last_auto_sync_at: string | null;
  next_auto_sync_at: string | null;
  last_auto_sync_status: string | null;
  last_auto_sync_message: string | null;
  enabled: number;
  status: string | null;
  visibility: string | null;
  ai_description: string | null;
  tech_stack_json: string | null;
  user_id: string;
  created_by: string;
  updated_by: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RepositoryUpsertInput {
  id?: string;
  name: string;
  language?: string | null;
  local_repo_path?: string | null;
  remote_provider?: string | null;
  remote_repo_slug?: string | null;
  remote_base_url?: string | null;
  clone_url?: string | null;
  default_target_branch?: string | null;
  ssh_key_id?: string | null;
  auto_sync_enabled?: boolean;
  auto_sync_interval_minutes?: number;
  enabled?: boolean;
  status?: string;
  visibility?: string;
  ai_description?: string | null;
  tech_stack_json?: string | null;
}

export interface RepoFeatureRecord {
  id: string;
  repository_id: string;
  feature_type: string;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export async function listRepositories(
  userId?: string,
): Promise<RepositoryRecord[]> {
  if (userId) {
    return (await dba
      .prepare(
        'SELECT * FROM repositories WHERE deleted_at IS NULL AND user_id = ? ORDER BY updated_at DESC',
      )
      .all(userId)) as RepositoryRecord[];
  }
  return (await dba
    .prepare(
      'SELECT * FROM repositories WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    )
    .all()) as RepositoryRecord[];
}

export async function getRepositoryById(
  id: string,
  userId?: string,
): Promise<RepositoryRecord | undefined> {
  if (userId) {
    return (await dba
      .prepare(
        'SELECT * FROM repositories WHERE id = ? AND deleted_at IS NULL AND user_id = ?',
      )
      .get(id, userId)) as RepositoryRecord | undefined;
  }
  return (await dba
    .prepare(
      'SELECT * FROM repositories WHERE id = ? AND deleted_at IS NULL',
    )
    .get(id)) as RepositoryRecord | undefined;
}

export async function saveRepository(
  input: RepositoryUpsertInput,
  currentUserId: string,
): Promise<RepositoryRecord> {
  const now = new Date().toISOString();
  const id = input.id ?? nanoid();
  const existing = await getRepositoryById(id, currentUserId);

  const name = input.name;
  const language = input.language ?? null;
  const local_repo_path = input.local_repo_path ?? null;
  const remote_provider = input.remote_provider ?? null;
  const remote_repo_slug = input.remote_repo_slug ?? null;
  const remote_base_url = input.remote_base_url ?? null;
  const clone_url = input.clone_url ?? null;
  const default_target_branch = input.default_target_branch ?? null;
  const ssh_key_id = input.ssh_key_id ?? null;
  const auto_sync_enabled = input.auto_sync_enabled ? 1 : 0;
  const auto_sync_interval_minutes = input.auto_sync_interval_minutes ?? 30;
  const enabled = input.enabled !== false ? 1 : 0;
  const status = input.status ?? 'active';
  const visibility = input.visibility ?? null;
  const ai_description = input.ai_description ?? null;
  const tech_stack_json = input.tech_stack_json ?? null;

  if (existing) {
    await dba
      .prepare(
        `UPDATE repositories SET
          name = ?, language = ?, local_repo_path = ?, remote_provider = ?, remote_repo_slug = ?,
          remote_base_url = ?, clone_url = ?, default_target_branch = ?, ssh_key_id = ?,
          auto_sync_enabled = ?, auto_sync_interval_minutes = ?,
          last_auto_sync_at = ?, next_auto_sync_at = ?, last_auto_sync_status = ?, last_auto_sync_message = ?,
          enabled = ?, status = ?, visibility = ?, ai_description = ?, tech_stack_json = ?,
          updated_by = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND user_id = ?`,
      )
      .run(
        name,
        language,
        local_repo_path,
        remote_provider,
        remote_repo_slug,
        remote_base_url,
        clone_url,
        default_target_branch,
        ssh_key_id,
        auto_sync_enabled,
        auto_sync_interval_minutes,
        existing.last_auto_sync_at,
        existing.next_auto_sync_at,
        existing.last_auto_sync_status,
        existing.last_auto_sync_message,
        enabled,
        status,
        visibility,
        ai_description,
        tech_stack_json,
        currentUserId,
        now,
        id,
        currentUserId,
      );
    return (await getRepositoryById(id, currentUserId))!;
  }

  await dba
    .prepare(`INSERT INTO repositories (
    id, name, language, local_repo_path, remote_provider, remote_repo_slug,
    remote_base_url, clone_url, default_target_branch, ssh_key_id,
    auto_sync_enabled, auto_sync_interval_minutes,
    last_auto_sync_at, next_auto_sync_at, last_auto_sync_status, last_auto_sync_message,
    enabled, status, visibility, ai_description, tech_stack_json,
    user_id, created_by, updated_by, deleted_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      name,
      language,
      local_repo_path,
      remote_provider,
      remote_repo_slug,
      remote_base_url,
      clone_url,
      default_target_branch,
      ssh_key_id,
      auto_sync_enabled,
      auto_sync_interval_minutes,
      null,
      null,
      null,
      null,
      enabled,
      status,
      visibility,
      ai_description,
      tech_stack_json,
      currentUserId,
      currentUserId,
      currentUserId,
      null,
      now,
      now,
    );

  return (await getRepositoryById(id, currentUserId))!;
}

export async function updateRepository(
  id: string,
  updates: Partial<RepositoryUpsertInput>,
  userId: string,
): Promise<RepositoryRecord | undefined> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.language !== undefined) {
    setClauses.push('language = ?');
    values.push(updates.language);
  }
  if (updates.local_repo_path !== undefined) {
    setClauses.push('local_repo_path = ?');
    values.push(updates.local_repo_path);
  }
  if (updates.remote_provider !== undefined) {
    setClauses.push('remote_provider = ?');
    values.push(updates.remote_provider);
  }
  if (updates.remote_repo_slug !== undefined) {
    setClauses.push('remote_repo_slug = ?');
    values.push(updates.remote_repo_slug);
  }
  if (updates.remote_base_url !== undefined) {
    setClauses.push('remote_base_url = ?');
    values.push(updates.remote_base_url);
  }
  if (updates.clone_url !== undefined) {
    setClauses.push('clone_url = ?');
    values.push(updates.clone_url);
  }
  if (updates.default_target_branch !== undefined) {
    setClauses.push('default_target_branch = ?');
    values.push(updates.default_target_branch);
  }
  if (updates.ssh_key_id !== undefined) {
    setClauses.push('ssh_key_id = ?');
    values.push(updates.ssh_key_id);
  }
  if (updates.auto_sync_enabled !== undefined) {
    setClauses.push('auto_sync_enabled = ?');
    values.push(updates.auto_sync_enabled ? 1 : 0);
  }
  if (updates.auto_sync_interval_minutes !== undefined) {
    setClauses.push('auto_sync_interval_minutes = ?');
    values.push(updates.auto_sync_interval_minutes);
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.visibility !== undefined) {
    setClauses.push('visibility = ?');
    values.push(updates.visibility);
  }
  if (updates.ai_description !== undefined) {
    setClauses.push('ai_description = ?');
    values.push(updates.ai_description);
  }
  if (updates.tech_stack_json !== undefined) {
    setClauses.push('tech_stack_json = ?');
    values.push(updates.tech_stack_json);
  }

  if (!setClauses.length) {
    return getRepositoryById(id, userId);
  }

  const now = new Date().toISOString();
  setClauses.push('updated_by = ?');
  values.push(userId);
  setClauses.push('updated_at = ?');
  values.push(now);
  values.push(id, userId);

  await dba
    .prepare(
      `UPDATE repositories SET ${setClauses.join(', ')} WHERE id = ? AND deleted_at IS NULL AND user_id = ?`,
    )
    .run(...values);

  return getRepositoryById(id, userId);
}

export async function deleteRepository(
  id: string,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      'UPDATE repositories SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .run(now, userId, now, id, userId);
}

export async function listRepoFeatures(
  repositoryId: string,
  userId?: string,
): Promise<RepoFeatureRecord[]> {
  if (userId) {
    const repo = await getRepositoryById(repositoryId, userId);
    if (!repo) return [];
  }
  return (await dba
    .prepare('SELECT * FROM repo_features WHERE repository_id = ?')
    .all(repositoryId)) as RepoFeatureRecord[];
}

export async function listRepoFeaturesByRepositoryIds(
  ids: string[],
): Promise<RepoFeatureRecord[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return (await dba
    .prepare(
      `SELECT * FROM repo_features WHERE repository_id IN (${placeholders})`,
    )
    .all(...ids)) as RepoFeatureRecord[];
}

export async function upsertRepoFeature(
  repositoryId: string,
  featureType: string,
  enabled: boolean,
  configJson: string,
): Promise<RepoFeatureRecord> {
  const now = new Date().toISOString();
  const existing = (await dba
    .prepare(
      'SELECT * FROM repo_features WHERE repository_id = ? AND feature_type = ?',
    )
    .get(repositoryId, featureType)) as RepoFeatureRecord | undefined;

  if (existing) {
    await dba
      .prepare(
        'UPDATE repo_features SET enabled = ?, config_json = ?, updated_at = ? WHERE id = ?',
      )
      .run(enabled ? 1 : 0, configJson, now, existing.id);
  } else {
    const id = nanoid();
    await dba
      .prepare(
        `INSERT INTO repo_features (id, repository_id, feature_type, enabled, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, repositoryId, featureType, enabled ? 1 : 0, configJson, now, now);
  }

  return (await dba
    .prepare(
      'SELECT * FROM repo_features WHERE repository_id = ? AND feature_type = ?',
    )
    .get(repositoryId, featureType)) as RepoFeatureRecord;
}
