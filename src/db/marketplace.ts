import crypto from 'crypto';

import { getCurrentUserId } from '../tenant/tenant-context.js';
import { adaptSql } from './sql-adapters.js';
import { dba } from './engine-access.js';

// ---------------------------------------------------------------------------
// user_mcp_servers
// ---------------------------------------------------------------------------

export interface UserMcpServerRecord {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  command: string;
  args_json: string;
  env_json: string;
  metadata_json: string | null;
  enabled: number;
  visibility: string;
  source_type: string;
  source_ref: string | null;
  icon_url: string | null;
  tags_json: string | null;
  created_at: string;
  updated_at: string;
}

export function generateMcpServerId(): string {
  return `mcp_${crypto.randomBytes(12).toString('hex')}`;
}

export async function upsertUserMcpServer(record: UserMcpServerRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO user_mcp_servers
         (id, user_id, name, description, command, args_json, env_json, metadata_json, enabled,
          visibility, source_type, source_ref, icon_url, tags_json,
          created_by, updated_by, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ),
    )
    .run(
      record.id,
      record.user_id,
      record.name,
      record.description,
      record.command,
      record.args_json,
      record.env_json,
      record.metadata_json,
      record.enabled,
      record.visibility,
      record.source_type,
      record.source_ref,
      record.icon_url,
      record.tags_json,
      getCurrentUserId(),
      getCurrentUserId(),
      record.created_at,
      record.updated_at,
    );
}

export async function getUserMcpServer(id: string): Promise<UserMcpServerRecord | null> {
  const row = await dba
    .prepare(`SELECT * FROM user_mcp_servers WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return (row as UserMcpServerRecord) || null;
}

export async function listUserMcpServers(options: {
  userId?: string;
  visibility?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<UserMcpServerRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.visibility) {
    clauses.push('visibility = ?');
    params.push(options.visibility);
  }
  if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }

  clauses.push('deleted_at IS NULL');
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;

  return (await dba
    .prepare(`SELECT * FROM user_mcp_servers ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)) as UserMcpServerRecord[];
}

export async function listVisibleMcpServers(userId: string, limit = 200, offset = 0): Promise<UserMcpServerRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM user_mcp_servers
       WHERE (user_id = ? OR visibility = 'shared') AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset)) as UserMcpServerRecord[];
}

export async function deleteUserMcpServer(id: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE user_mcp_servers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
}

// ---------------------------------------------------------------------------
// user_skills
// ---------------------------------------------------------------------------

export interface UserSkillRecord {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  summary: string | null;
  skill_content: string | null;
  metadata_json: string | null;
  enabled: number;
  visibility: string;
  source_type: string;
  source_ref: string | null;
  icon_url: string | null;
  tags_json: string | null;
  created_at: string;
  updated_at: string;
}

export function generateSkillId(): string {
  return `skill_${crypto.randomBytes(12).toString('hex')}`;
}

export async function upsertUserSkill(record: UserSkillRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO user_skills
         (id, user_id, name, description, summary, skill_content, metadata_json, enabled,
          visibility, source_type, source_ref, icon_url, tags_json,
          created_by, updated_by, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ),
    )
    .run(
      record.id,
      record.user_id,
      record.name,
      record.description,
      record.summary,
      record.skill_content,
      record.metadata_json,
      record.enabled,
      record.visibility,
      record.source_type,
      record.source_ref,
      record.icon_url,
      record.tags_json,
      getCurrentUserId(),
      getCurrentUserId(),
      record.created_at,
      record.updated_at,
    );
}

export async function getUserSkill(id: string): Promise<UserSkillRecord | null> {
  const row = await dba
    .prepare(`SELECT * FROM user_skills WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return (row as UserSkillRecord) || null;
}

export async function listUserSkills(options: {
  userId?: string;
  visibility?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}): Promise<UserSkillRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.visibility) {
    clauses.push('visibility = ?');
    params.push(options.visibility);
  }
  if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }

  clauses.push('deleted_at IS NULL');
  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;

  return (await dba
    .prepare(`SELECT * FROM user_skills ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)) as UserSkillRecord[];
}

export async function listVisibleSkills(userId: string, limit = 200, offset = 0): Promise<UserSkillRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM user_skills
       WHERE (user_id = ? OR visibility = 'shared') AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(userId, limit, offset)) as UserSkillRecord[];
}

export async function deleteUserSkill(id: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE user_skills SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
}

// ---------------------------------------------------------------------------
// marketplace_sources
// ---------------------------------------------------------------------------

export interface MarketplaceSourceRecord {
  id: string;
  name: string;
  source: string;
  enabled: number;
  description: string | null;
  icon_url: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function generateMarketplaceSourceId(): string {
  return `mkt_${crypto.randomBytes(8).toString('hex')}`;
}

export async function upsertMarketplaceSource(record: MarketplaceSourceRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO marketplace_sources
         (id, name, source, enabled, description, icon_url, sort_order, created_by, updated_by, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ),
    )
    .run(
      record.id,
      record.name,
      record.source,
      record.enabled,
      record.description,
      record.icon_url,
      record.sort_order,
      record.created_by,
      record.created_by,
      record.created_at,
      record.updated_at,
    );
}

export async function getMarketplaceSource(id: string): Promise<MarketplaceSourceRecord | null> {
  const row = await dba
    .prepare(`SELECT * FROM marketplace_sources WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return (row as MarketplaceSourceRecord) || null;
}

export async function listMarketplaceSources(enabledOnly = false): Promise<MarketplaceSourceRecord[]> {
  const clauses = ['deleted_at IS NULL'];
  if (enabledOnly) clauses.push('enabled = 1');
  const where = `WHERE ${clauses.join(' AND ')}`;
  return (await dba
    .prepare(`SELECT * FROM marketplace_sources ${where} ORDER BY sort_order ASC, updated_at DESC`)
    .all()) as MarketplaceSourceRecord[];
}

export async function deleteMarketplaceSource(id: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE marketplace_sources SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, getCurrentUserId(), id);
}

// ---------------------------------------------------------------------------
// marketplace_installs
// ---------------------------------------------------------------------------

export interface MarketplaceInstallRecord {
  id: string;
  user_id: string;
  source_id: string | null;
  entry_name: string;
  entry_type: string;
  installed_version: string | null;
  target_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function generateInstallId(): string {
  return `inst_${crypto.randomBytes(12).toString('hex')}`;
}

export async function upsertMarketplaceInstall(record: MarketplaceInstallRecord): Promise<void> {
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO marketplace_installs
         (id, user_id, source_id, entry_name, entry_type, installed_version, target_id, status, created_by, updated_by, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ),
    )
    .run(
      record.id,
      record.user_id,
      record.source_id,
      record.entry_name,
      record.entry_type,
      record.installed_version,
      record.target_id,
      record.status,
      getCurrentUserId(),
      getCurrentUserId(),
      record.created_at,
      record.updated_at,
    );
}

export async function listMarketplaceInstalls(options: {
  userId?: string;
  entryType?: string;
  sourceId?: string;
  limit?: number;
  offset?: number;
}): Promise<MarketplaceInstallRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.userId) {
    clauses.push('user_id = ?');
    params.push(options.userId);
  }
  if (options.entryType) {
    clauses.push('entry_type = ?');
    params.push(options.entryType);
  }
  if (options.sourceId) {
    clauses.push('source_id = ?');
    params.push(options.sourceId);
  }

  clauses.push('deleted_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;

  return (await dba
    .prepare(`SELECT * FROM marketplace_installs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)) as MarketplaceInstallRecord[];
}

export async function deleteMarketplaceInstall(id: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE marketplace_installs SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, getCurrentUserId(), id);
}

export async function deleteMarketplaceInstallsByTarget(targetId: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE marketplace_installs SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE target_id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, getCurrentUserId(), targetId);
}
