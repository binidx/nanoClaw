import path from 'path';
import fs from 'fs';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { SYSTEM_USER_ID } from './tenant-context.js';

/**
 * Resolve the uploads directory for a given user.
 * System user uses the root `data/uploads/`, per-user gets `data/uploads/{userId}/`.
 */
export function resolveUserUploadsDir(userId: string): string {
  if (!userId || userId === SYSTEM_USER_ID) {
    return path.join(DATA_DIR, 'uploads');
  }
  return path.join(DATA_DIR, 'uploads', userId);
}

/**
 * Resolve the groups directory for a given user.
 * System user uses the root `groups/`, per-user gets `groups/{userId}/`.
 */
export function resolveUserGroupsDir(userId: string): string {
  if (!userId || userId === SYSTEM_USER_ID) {
    return GROUPS_DIR;
  }
  return path.join(GROUPS_DIR, userId);
}

/**
 * Resolve the global memory directory for a given user.
 */
export function resolveUserGlobalDir(userId: string): string {
  return path.join(resolveUserGroupsDir(userId), 'global');
}

/**
 * Ensure the per-user upload and groups directories exist.
 */
export function ensureUserDirectories(userId: string): void {
  if (!userId || userId === SYSTEM_USER_ID) return;
  const uploadsDir = resolveUserUploadsDir(userId);
  const groupsDir = resolveUserGroupsDir(userId);
  const globalDir = resolveUserGlobalDir(userId);
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
}
