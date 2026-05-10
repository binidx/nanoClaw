import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  evaluateExtensionHealth,
  parseExtensionMetadata,
  serializeExtensionMetadata,
  type ExtensionHealthStatus,
  type ExtensionMetadata,
} from '../extension/extension-metadata.js';
import {
  type UserSkillRecord,
  generateSkillId,
  upsertUserSkill,
  getUserSkill,
  listUserSkills,
  listVisibleSkills,
  deleteUserSkill,
  deleteMarketplaceInstallsByTarget,
} from '../db.js';
import { logger } from '../logger.js';
import { resolveSkillSourceDirectory } from '../runtime/runtime-customization-service.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';

export interface UserSkillInput {
  name: string;
  description?: string;
  summary?: string;
  skillContent?: string;
  enabled?: boolean;
  visibility?: 'private' | 'shared';
  sourceType?: string;
  sourceRef?: string | null;
  iconUrl?: string;
  tags?: string[];
  metadata?: ExtensionMetadata;
}

export interface UserSkillImportPathInput {
  sourcePath: string;
  name?: string;
  visibility?: 'private' | 'shared';
}

export interface UserSkillView {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  summary: string | null;
  skillContent: string | null;
  enabled: boolean;
  visibility: 'private' | 'shared';
  sourceType: string;
  sourceRef: string | null;
  iconUrl: string | null;
  tags: string[];
  metadata: ExtensionMetadata;
  healthStatus: ExtensionHealthStatus;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
}

function recordToView(record: UserSkillRecord, currentUserId?: string): UserSkillView {
  const metadata = parseExtensionMetadata(record.metadata_json);
  return {
    id: record.id,
    userId: record.user_id,
    name: record.name,
    description: record.description,
    summary: record.summary,
    skillContent: record.skill_content,
    enabled: record.enabled === 1,
    visibility: record.visibility as 'private' | 'shared',
    sourceType: record.source_type,
    sourceRef: record.source_ref,
    iconUrl: record.icon_url,
    tags: safeParse<string[]>(record.tags_json, []),
    metadata,
    healthStatus: evaluateExtensionHealth({
      metadata,
      baseDir: path.join(getUserSkillDir(record.user_id), record.id),
    }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    isOwner: currentUserId ? record.user_id === currentUserId : undefined,
  };
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const HYDRATE_PAGE_SIZE = 500;

async function ensureUserDiskHydrated(userId: string): Promise<void> {
  const { ensureUserHydrated } = await import('../runtime/startup-hydration.js');
  await ensureUserHydrated(userId);
}

async function listAllSkillRecordsForHydration(options: {
  userId?: string;
  visibility?: string;
}): Promise<UserSkillRecord[]> {
  const out: UserSkillRecord[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await listUserSkills({
      ...options,
      limit: HYDRATE_PAGE_SIZE,
      offset,
    });
    out.push(...chunk);
    if (chunk.length < HYDRATE_PAGE_SIZE) break;
    offset += chunk.length;
  }
  return out;
}

function getUserSkillDir(userId: string): string {
  return path.join(DATA_DIR, 'users', userId, 'skills');
}

function getSharedSkillDir(): string {
  return path.join(DATA_DIR, 'shared', 'skills');
}

function syncSkillToDisk(record: UserSkillRecord): void {
  const userDir = path.join(getUserSkillDir(record.user_id), record.id);
  fs.mkdirSync(userDir, { recursive: true });

  if (record.skill_content) {
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), record.skill_content, 'utf-8');
  }

  const meta = {
    id: record.id,
    name: record.name,
    description: record.description,
    summary: record.summary,
    metadata: parseExtensionMetadata(record.metadata_json),
    enabled: record.enabled === 1,
    sourceType: record.source_type,
  };
  fs.writeFileSync(path.join(userDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  if (record.visibility === 'shared') {
    const sharedDir = path.join(getSharedSkillDir(), record.id);
    fs.mkdirSync(sharedDir, { recursive: true });
    if (record.skill_content) {
      fs.writeFileSync(path.join(sharedDir, 'SKILL.md'), record.skill_content, 'utf-8');
    }
    fs.writeFileSync(path.join(sharedDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }
}

function removeSkillFromDisk(userId: string, skillId: string): void {
  try {
    const userDir = path.join(getUserSkillDir(userId), skillId);
    if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
    const sharedDir = path.join(getSharedSkillDir(), skillId);
    if (fs.existsSync(sharedDir)) fs.rmSync(sharedDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, skillId }, 'user-skill: failed to remove from disk');
  }
}

function parseSkillNameFromContent(content: string): string | null {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || null;
}

export async function createUserSkill(
  userId: string,
  input: UserSkillInput,
): Promise<UserSkillView> {
  const now = new Date().toISOString();
  const record: UserSkillRecord = {
    id: generateSkillId(),
    user_id: userId,
    name: input.name,
    description: input.description ?? null,
    summary: input.summary ?? null,
    skill_content: input.skillContent ?? null,
    metadata_json: serializeExtensionMetadata(input.metadata),
    enabled: input.enabled !== false ? 1 : 0,
    visibility: input.visibility ?? 'private',
    source_type: input.sourceType ?? 'manual',
    source_ref: input.sourceRef ?? null,
    icon_url: input.iconUrl ?? null,
    tags_json: input.tags ? JSON.stringify(input.tags) : null,
    created_at: now,
    updated_at: now,
  };
  await upsertUserSkill(record);
  try { syncSkillToDisk(record); } catch (err) {
    logger.warn({ err, skillId: record.id }, 'user-skill: disk sync failed after create');
  }
  return recordToView(record, userId);
}

export async function importUserSkillFromPath(
  userId: string,
  input: UserSkillImportPathInput,
): Promise<{
  skill: UserSkillView;
  imported: {
    path: string;
  };
}> {
  const sourcePath = String(input.sourcePath || '').trim();
  if (!sourcePath) {
    throw new Error('sourcePath is required');
  }
  const sourceDir = resolveSkillSourceDirectory(sourcePath);
  const skillContent = fs.readFileSync(
    path.join(sourceDir, 'SKILL.md'),
    'utf-8',
  );
  const skill = await createUserSkill(userId, {
    name:
      String(input.name || '').trim() ||
      parseSkillNameFromContent(skillContent) ||
      path.basename(sourceDir),
    description: `Imported from ${sourcePath}`,
    skillContent,
    visibility: input.visibility === 'shared' ? 'shared' : 'private',
    sourceType: 'import',
    sourceRef: path.resolve(sourceDir),
    metadata: {
      capabilities: [],
      generator: {
        kind: 'imported',
      },
    },
  });

  const targetDir = path.join(getUserSkillDir(userId), skill.id);
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
  });
  fs.writeFileSync(path.join(targetDir, 'SKILL.md'), skillContent, 'utf-8');
  fs.writeFileSync(
    path.join(targetDir, 'meta.json'),
    JSON.stringify(
      {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        summary: skill.summary,
        metadata: skill.metadata,
        enabled: skill.enabled,
        sourceType: skill.sourceType,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    skill,
    imported: {
      path: targetDir,
    },
  };
}

export async function updateUserSkill(
  userId: string,
  skillId: string,
  input: Partial<UserSkillInput>,
): Promise<UserSkillView | null> {
  const existing = await getUserSkill(skillId);
  if (!existing || existing.user_id !== userId) return null;

  const now = new Date().toISOString();
  const updated: UserSkillRecord = {
    ...existing,
    name: input.name ?? existing.name,
    description: input.description !== undefined ? (input.description ?? null) : existing.description,
    summary: input.summary !== undefined ? (input.summary ?? null) : existing.summary,
    skill_content: input.skillContent !== undefined ? (input.skillContent ?? null) : existing.skill_content,
    metadata_json:
      input.metadata !== undefined
        ? serializeExtensionMetadata(input.metadata)
        : existing.metadata_json,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    visibility: input.visibility ?? existing.visibility,
    source_type: input.sourceType ?? existing.source_type,
    source_ref: input.sourceRef !== undefined ? (input.sourceRef ?? null) : existing.source_ref,
    icon_url: input.iconUrl !== undefined ? (input.iconUrl ?? null) : existing.icon_url,
    tags_json: input.tags ? JSON.stringify(input.tags) : existing.tags_json,
    updated_at: now,
  };
  await upsertUserSkill(updated);
  try { syncSkillToDisk(updated); } catch (err) {
    logger.warn({ err, skillId: updated.id }, 'user-skill: disk sync failed after update');
  }
  return recordToView(updated, userId);
}

export async function removeUserSkill(userId: string, skillId: string): Promise<boolean> {
  const existing = await getUserSkill(skillId);
  if (!existing || existing.user_id !== userId) return false;
  await deleteUserSkill(skillId);
  await deleteMarketplaceInstallsByTarget(skillId);
  removeSkillFromDisk(userId, skillId);
  return true;
}

export async function adminRemoveSkill(skillId: string): Promise<boolean> {
  const existing = await getUserSkill(skillId);
  if (!existing || existing.visibility !== 'shared') return false;
  await deleteUserSkill(skillId);
  await deleteMarketplaceInstallsByTarget(skillId);
  removeSkillFromDisk(existing.user_id, skillId);
  return true;
}

export async function toggleSkillVisibility(
  userId: string,
  skillId: string,
): Promise<UserSkillView | null> {
  const existing = await getUserSkill(skillId);
  if (!existing || existing.user_id !== userId) return null;

  const nextVisibility = existing.visibility === 'shared' ? 'private' : 'shared';
  const now = new Date().toISOString();
  const updated: UserSkillRecord = {
    ...existing,
    visibility: nextVisibility,
    updated_at: now,
  };
  await upsertUserSkill(updated);
  try { syncSkillToDisk(updated); } catch (err) {
    logger.warn({ err, skillId: updated.id }, 'user-skill: disk sync failed after visibility toggle');
  }

  if (nextVisibility === 'private') {
    const sharedDir = path.join(getSharedSkillDir(), skillId);
    if (fs.existsSync(sharedDir)) fs.rmSync(sharedDir, { recursive: true, force: true });
  }

  return recordToView(updated, userId);
}

export async function listMySkills(userId: string): Promise<UserSkillView[]> {
  await ensureUserDiskHydrated(userId);
  const records = await listUserSkills({ userId });
  return records.map((r) => recordToView(r, userId));
}

export async function listAllVisibleSkills(userId: string): Promise<UserSkillView[]> {
  await ensureUserDiskHydrated(userId);
  const records = await listVisibleSkills(userId);
  return records.map((r) => recordToView(r, userId));
}

export async function installSharedSkillToUser(
  userId: string,
  sourceSkillId: string,
): Promise<UserSkillView | null> {
  await ensureUserDiskHydrated(userId);
  const source = await getUserSkill(sourceSkillId);
  if (!source || source.visibility !== 'shared') return null;
  if (source.user_id === userId) return recordToView(source, userId);

  return createUserSkill(userId, {
    name: source.name,
    description: source.description ?? undefined,
    summary: source.summary ?? undefined,
    skillContent: source.skill_content ?? undefined,
    enabled: true,
    visibility: 'private',
    sourceType: 'import',
    sourceRef: sourceSkillId,
    metadata: parseExtensionMetadata(source.metadata_json),
  });
}

export async function hydrateUserSkillsToDisk(
  options: { userId: string } | { sharedAndSystemOnly: true },
): Promise<number> {
  let records: UserSkillRecord[];
  if ('userId' in options) {
    records = await listAllSkillRecordsForHydration({ userId: options.userId });
  } else {
    const shared = await listAllSkillRecordsForHydration({ visibility: 'shared' });
    const system = await listAllSkillRecordsForHydration({ userId: SYSTEM_USER_ID });
    const byId = new Map<string, UserSkillRecord>();
    for (const r of shared) byId.set(r.id, r);
    for (const r of system) byId.set(r.id, r);
    records = [...byId.values()];
  }
  let count = 0;
  for (const record of records) {
    try {
      syncSkillToDisk(record);
      count++;
    } catch (err) {
      logger.warn({ err, skillId: record.id }, 'user-skill: hydration failed');
    }
  }
  return count;
}
