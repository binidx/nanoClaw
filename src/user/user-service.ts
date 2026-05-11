import crypto from 'crypto';

import { getActiveEngine, type DbEngine } from '../database/engine.js';
import { insertIgnoreSql, type Dialect } from '../database/index.js';
import { logger } from '../logger.js';
import { invalidatePermissionCache, getUserEffectivePermissions, permissionMatches } from '../auth/permission-engine.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { t } from '../i18n/index.js';

export interface UserRecord {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  email: string | null;
  auth_source: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  roles: string[];
  createdAt: string;
}

export interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  is_system: number;
  created_at: string;
}

export interface PermissionRecord {
  id: string;
  code: string;
  name: string;
  category: string;
}

export interface AuthValidationResult {
  userId: string;
  username: string;
  displayName: string | null;
  roles: string[];
  permissions: string[];
}

export interface CreateUserInput {
  username: string;
  password?: string;
  displayName?: string;
  email?: string;
  roleNames?: string[];
  authSource?: string;
  /** Audit: `created_by` / `updated_by`; defaults to `getCurrentUserId()` when absent */
  actorId?: string;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  password?: string;
  status?: string;
}

const SCRYPT_KEYLEN = 64;
const ADMIN_ROLE_ID = 'role-admin';
const ADMIN_ROLE_NAME = 'admin';
const DEFAULT_USER_PASSWORD = crypto.randomBytes(16).toString('base64url');

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const parts = hash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, key] = parts;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      try {
        resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey));
      } catch {
        resolve(false);
      }
    });
  });
}

function eng(): DbEngine {
  return getActiveEngine();
}

function d(): Dialect {
  return eng().dialect;
}

function ts(): string {
  return new Date().toISOString();
}

function auditActor(callerId?: string | null): string {
  const trimmed = callerId?.trim();
  return trimmed || getCurrentUserId();
}

interface PresetPermission {
  id: string;
  code: string;
  name: string;
  category: string;
  module: string;
  description: string;
  sort_order: number;
  ui_hint: string;
}

const PRESET_PERMISSIONS: ReadonlyArray<PresetPermission> = [
  // ── Legacy codes (kept for backward compat) ──
  { id: 'perm-system-settings', code: 'system.settings', name: t('permissions.auto_140976', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_09f869', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-system-users', code: 'system.users', name: t('permissions.auto_7d94de', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_db9ee2', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-system-providers', code: 'system.providers', name: t('permissions.auto_cb1e31', {}, undefined), category: 'system', module: 'provider', description: t('permissions.auto_634800', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-project-manage', code: 'project.manage', name: t('permissions.auto_a775f9', {}, undefined), category: 'project', module: 'project', description: t('permissions.auto_cd9c80', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-project-view', code: 'project.view', name: t('permissions.auto_2aa3d6', {}, undefined), category: 'project', module: 'project', description: t('permissions.auto_544118', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-review-create', code: 'review.create', name: t('permissions.auto_284f8b', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_f80a4f', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-review-view', code: 'review.view', name: t('permissions.auto_d852da', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_015867', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-review-manual', code: 'review.manual', name: t('permissions.auto_622670', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_64b4d0', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-review-annotate', code: 'review.annotate', name: t('permissions.auto_1f404c', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_000334', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-conversation-manage', code: 'conversation.manage', name: t('permissions.auto_a676bd', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_d9ce38', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-conversation-own', code: 'conversation.own', name: t('permissions.auto_ff0790', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_e1015f', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-conversation-send', code: 'conversation.send', name: t('permissions.auto_b5f159', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_9eef2f', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-conversation-view', code: 'conversation.view', name: t('permissions.auto_5b4e3b', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_95380a', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-assistant-manage', code: 'assistant.manage', name: t('permissions.auto_eca302', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_45a87d', {}, undefined), sort_order: 0, ui_hint: 'legacy' },
  { id: 'perm-live2d-view', code: 'live2d.view', name: t('permissions.auto_eaed6c', {}, undefined), category: 'live2d', module: 'live2d', description: t('permissions.auto_eaed6c', {}, undefined), sort_order: 0, ui_hint: 'page' },
  { id: 'perm-live2d-manage', code: 'live2d.manage', name: t('permissions.auto_8beecc', {}, undefined), category: 'live2d', module: 'live2d', description: t('permissions.auto_584840', {}, undefined), sort_order: 1, ui_hint: 'action' },
  { id: 'perm-soul-view', code: 'soul.view', name: t('permissions.auto_3e99c6', {}, undefined), category: 'soul', module: 'soul', description: t('permissions.auto_3e99c6', {}, undefined), sort_order: 0, ui_hint: 'page' },
  { id: 'perm-soul-manage', code: 'soul.manage', name: t('permissions.auto_d211fb', {}, undefined), category: 'soul', module: 'soul', description: t('permissions.auto_d211fb', {}, undefined), sort_order: 1, ui_hint: 'action' },
  { id: 'perm-channel-view', code: 'channel.view', name: t('permissions.auto_180605', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_ab61d8', {}, undefined), sort_order: 0, ui_hint: 'page' },
  { id: 'perm-channel-own', code: 'channel.own', name: t('permissions.auto_620a41', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_592b5b', {}, undefined), sort_order: 1, ui_hint: 'action' },
  { id: 'perm-channel-manage', code: 'channel.manage', name: t('permissions.auto_8c0d70', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_207247', {}, undefined), sort_order: 2, ui_hint: 'action' },

  // ── System settings (fine-grained) ──
  { id: 'perm-system-settings-view', code: 'system.settings.view', name: t('permissions.auto_b6abb8', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_4ef83a', {}, undefined), sort_order: 10, ui_hint: 'page' },
  { id: 'perm-system-settings-edit', code: 'system.settings.edit', name: t('permissions.auto_70abe6', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_a31157', {}, undefined), sort_order: 11, ui_hint: 'action' },

  // ── User management (fine-grained) ──
  { id: 'perm-system-users-view', code: 'system.users.view', name: t('permissions.auto_a89f4b', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_533135', {}, undefined), sort_order: 20, ui_hint: 'page' },
  { id: 'perm-system-users-create', code: 'system.users.create', name: t('permissions.auto_ac5b58', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_0322db', {}, undefined), sort_order: 21, ui_hint: 'action' },
  { id: 'perm-system-users-edit', code: 'system.users.edit', name: t('permissions.auto_5a0346', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_b4f21e', {}, undefined), sort_order: 22, ui_hint: 'action' },
  { id: 'perm-system-users-delete', code: 'system.users.delete', name: t('permissions.auto_708fc1', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_2b3abd', {}, undefined), sort_order: 23, ui_hint: 'action' },
  { id: 'perm-system-users-assign-role', code: 'system.users.assign_role', name: t('permissions.auto_1318cc', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_fb8824', {}, undefined), sort_order: 24, ui_hint: 'action' },

  // ── Provider (fine-grained) ──
  { id: 'perm-provider-system-view', code: 'provider.system.view', name: t('permissions.auto_eb3c2f', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_4ca83c', {}, undefined), sort_order: 30, ui_hint: 'page' },
  { id: 'perm-provider-system-create', code: 'provider.system.create', name: t('permissions.auto_a10ed0', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_2b3e37', {}, undefined), sort_order: 31, ui_hint: 'action' },
  { id: 'perm-provider-system-edit', code: 'provider.system.edit', name: t('permissions.auto_a41c66', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_43236a', {}, undefined), sort_order: 32, ui_hint: 'action' },
  { id: 'perm-provider-system-delete', code: 'provider.system.delete', name: t('permissions.auto_79006b', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_e61e8a', {}, undefined), sort_order: 33, ui_hint: 'action' },
  { id: 'perm-provider-personal-create', code: 'provider.personal.create', name: t('permissions.auto_34d250', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_f75124', {}, undefined), sort_order: 34, ui_hint: 'action' },
  { id: 'perm-provider-personal-edit', code: 'provider.personal.edit', name: t('permissions.auto_5d2b51', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_5aac55', {}, undefined), sort_order: 35, ui_hint: 'action' },
  { id: 'perm-provider-personal-delete', code: 'provider.personal.delete', name: t('permissions.auto_79b5a2', {}, undefined), category: 'provider', module: 'provider', description: t('permissions.auto_c97205', {}, undefined), sort_order: 36, ui_hint: 'action' },

  // ── Conversation (fine-grained) ──
  { id: 'perm-conversation-view-all', code: 'conversation.view_all', name: t('permissions.auto_cf1afb', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_70359c', {}, undefined), sort_order: 40, ui_hint: 'action' },
  { id: 'perm-conversation-create', code: 'conversation.create', name: t('permissions.auto_ca4ce0', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_85a92a', {}, undefined), sort_order: 41, ui_hint: 'action' },
  { id: 'perm-conversation-delete', code: 'conversation.delete', name: t('permissions.auto_3f62de', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_9a1878', {}, undefined), sort_order: 42, ui_hint: 'action' },
  { id: 'perm-conversation-delete-all', code: 'conversation.delete_all', name: t('permissions.auto_e63588', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_0dfc07', {}, undefined), sort_order: 43, ui_hint: 'action' },
  { id: 'perm-conversation-export', code: 'conversation.export', name: t('permissions.auto_0c9051', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_b4bf5e', {}, undefined), sort_order: 44, ui_hint: 'action' },
  { id: 'perm-conversation-share', code: 'conversation.share', name: t('permissions.auto_06c21c', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_5631e3', {}, undefined), sort_order: 45, ui_hint: 'action' },
  { id: 'perm-conversation-access-config', code: 'conversation.access_config', name: t('permissions.auto_c122c6', {}, undefined), category: 'conversation', module: 'conversation', description: t('permissions.auto_ec7619', {}, undefined), sort_order: 46, ui_hint: 'action' },

  // ── Review (fine-grained) ──
  { id: 'perm-review-repo-view', code: 'review.repo.view', name: t('permissions.auto_617f0d', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_ab1bcc', {}, undefined), sort_order: 50, ui_hint: 'page' },
  { id: 'perm-review-repo-view-all', code: 'review.repo.view_all', name: t('permissions.auto_285af8', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_b58f7e', {}, undefined), sort_order: 51, ui_hint: 'action' },
  { id: 'perm-review-repo-create', code: 'review.repo.create', name: t('permissions.auto_57ad00', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_935e0c', {}, undefined), sort_order: 52, ui_hint: 'action' },
  { id: 'perm-review-repo-edit', code: 'review.repo.edit', name: t('permissions.auto_faa376', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_fe3296', {}, undefined), sort_order: 53, ui_hint: 'action' },
  { id: 'perm-review-repo-delete', code: 'review.repo.delete', name: t('permissions.auto_67a4e3', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_73abd3', {}, undefined), sort_order: 54, ui_hint: 'action' },
  { id: 'perm-review-repo-share', code: 'review.repo.share', name: t('permissions.auto_218f60', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_5aa09c', {}, undefined), sort_order: 55, ui_hint: 'action' },
  { id: 'perm-review-run-view', code: 'review.run.view', name: t('permissions.auto_9b6d62', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_5427bc', {}, undefined), sort_order: 56, ui_hint: 'action' },
  { id: 'perm-review-run-trigger', code: 'review.run.trigger', name: t('permissions.auto_989b01', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_78cbe3', {}, undefined), sort_order: 57, ui_hint: 'action' },
  { id: 'perm-review-run-manual', code: 'review.run.manual', name: t('permissions.auto_3f47c2', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_d71683', {}, undefined), sort_order: 58, ui_hint: 'action' },
  { id: 'perm-review-run-annotate', code: 'review.run.annotate', name: t('permissions.auto_1f404c', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_612ac9', {}, undefined), sort_order: 59, ui_hint: 'action' },
  { id: 'perm-review-profile-edit', code: 'review.profile.edit', name: t('permissions.auto_3dccfa', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_4ee6cc', {}, undefined), sort_order: 60, ui_hint: 'action' },
  { id: 'perm-review-digest-manage', code: 'review.digest.manage', name: t('permissions.auto_433080', {}, undefined), category: 'review', module: 'review', description: t('permissions.auto_b5aee0', {}, undefined), sort_order: 61, ui_hint: 'action' },

  // ── Repository ──
  { id: 'perm-repository-view', code: 'repository.view', name: t('permissions.auto_693730', {}, undefined), category: 'repository', module: 'repository', description: t('permissions.auto_948b7a', {}, undefined), sort_order: 300, ui_hint: 'page' },
  { id: 'perm-repository-create', code: 'repository.create', name: t('permissions.auto_28d3d0', {}, undefined), category: 'repository', module: 'repository', description: t('permissions.auto_4e5bdc', {}, undefined), sort_order: 301, ui_hint: 'action' },
  { id: 'perm-repository-update', code: 'repository.update', name: t('permissions.auto_8806ab', {}, undefined), category: 'repository', module: 'repository', description: t('permissions.auto_380faf', {}, undefined), sort_order: 302, ui_hint: 'action' },
  { id: 'perm-repository-delete', code: 'repository.delete', name: t('permissions.auto_fc1ba0', {}, undefined), category: 'repository', module: 'repository', description: t('permissions.auto_8eae82', {}, undefined), sort_order: 303, ui_hint: 'action' },
  { id: 'perm-repository-worktree', code: 'repository.worktree', name: t('permissions.auto_91f37d', {}, undefined), category: 'repository', module: 'repository', description: t('permissions.auto_442b86', {}, undefined), sort_order: 304, ui_hint: 'action' },

  // ── Assistant (fine-grained) ──
  { id: 'perm-assistant-view', code: 'assistant.view', name: t('permissions.auto_6c2ebc', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_d5e53d', {}, undefined), sort_order: 70, ui_hint: 'page' },
  { id: 'perm-assistant-create', code: 'assistant.create', name: t('permissions.auto_6dc920', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_b9a3ed', {}, undefined), sort_order: 71, ui_hint: 'action' },
  { id: 'perm-assistant-edit', code: 'assistant.edit', name: t('permissions.auto_e5ed2a', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_a8e5f8', {}, undefined), sort_order: 72, ui_hint: 'action' },
  { id: 'perm-assistant-delete', code: 'assistant.delete', name: t('permissions.auto_c786ce', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_c786ce', {}, undefined), sort_order: 73, ui_hint: 'action' },
  { id: 'perm-assistant-start-chat', code: 'assistant.start_chat', name: t('permissions.auto_9385f4', {}, undefined), category: 'assistant', module: 'assistant', description: t('permissions.auto_a53291', {}, undefined), sort_order: 74, ui_hint: 'action' },

  // ── Channel (fine-grained) ──
  { id: 'perm-channel-personal-create', code: 'channel.personal.create', name: t('permissions.auto_c91845', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_91bdbf', {}, undefined), sort_order: 80, ui_hint: 'action' },
  { id: 'perm-channel-personal-edit', code: 'channel.personal.edit', name: t('permissions.auto_eb5c79', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_647470', {}, undefined), sort_order: 81, ui_hint: 'action' },
  { id: 'perm-channel-system-manage', code: 'channel.system.manage', name: t('permissions.auto_d4665d', {}, undefined), category: 'channel', module: 'channel', description: t('permissions.auto_94a911', {}, undefined), sort_order: 82, ui_hint: 'action' },

  // ── Task (fine-grained) ──
  { id: 'perm-task-view', code: 'task.view', name: t('permissions.auto_13f931', {}, undefined), category: 'task', module: 'task', description: t('permissions.auto_08d8cc', {}, undefined), sort_order: 90, ui_hint: 'page' },
  { id: 'perm-task-view-all', code: 'task.view_all', name: t('permissions.auto_ba660a', {}, undefined), category: 'task', module: 'task', description: t('permissions.auto_9a98bc', {}, undefined), sort_order: 91, ui_hint: 'action' },
  { id: 'perm-task-create', code: 'task.create', name: t('permissions.auto_6ef95f', {}, undefined), category: 'task', module: 'task', description: t('permissions.auto_230a57', {}, undefined), sort_order: 92, ui_hint: 'action' },
  { id: 'perm-task-edit', code: 'task.edit', name: t('permissions.auto_8e1a91', {}, undefined), category: 'task', module: 'task', description: t('permissions.auto_01f333', {}, undefined), sort_order: 93, ui_hint: 'action' },
  { id: 'perm-task-delete', code: 'task.delete', name: t('permissions.auto_033e88', {}, undefined), category: 'task', module: 'task', description: t('permissions.auto_0b198e', {}, undefined), sort_order: 94, ui_hint: 'action' },

  // ── MCP ──
  { id: 'perm-mcp-view', code: 'mcp.view', name: t('permissions.auto_4ac139', {}, undefined), category: 'mcp', module: 'mcp', description: t('permissions.auto_ff7220', {}, undefined), sort_order: 100, ui_hint: 'page' },
  { id: 'perm-mcp-create', code: 'mcp.create', name: t('permissions.auto_dfb35d', {}, undefined), category: 'mcp', module: 'mcp', description: t('permissions.auto_23a1eb', {}, undefined), sort_order: 101, ui_hint: 'action' },
  { id: 'perm-mcp-edit', code: 'mcp.edit', name: t('permissions.auto_74b2fb', {}, undefined), category: 'mcp', module: 'mcp', description: t('permissions.auto_01af74', {}, undefined), sort_order: 102, ui_hint: 'action' },
  { id: 'perm-mcp-delete', code: 'mcp.delete', name: t('permissions.auto_bb332f', {}, undefined), category: 'mcp', module: 'mcp', description: t('permissions.auto_269830', {}, undefined), sort_order: 103, ui_hint: 'action' },
  { id: 'perm-mcp-publish', code: 'mcp.publish', name: t('permissions.auto_71b258', {}, undefined), category: 'mcp', module: 'mcp', description: t('permissions.auto_8e7451', {}, undefined), sort_order: 104, ui_hint: 'action' },

  // ── Skill ──
  { id: 'perm-skill-view', code: 'skill.view', name: t('permissions.auto_97c094', {}, undefined), category: 'skill', module: 'skill', description: t('permissions.auto_a3bf8c', {}, undefined), sort_order: 110, ui_hint: 'page' },
  { id: 'perm-skill-create', code: 'skill.create', name: t('permissions.auto_0f0408', {}, undefined), category: 'skill', module: 'skill', description: t('permissions.auto_79fc9b', {}, undefined), sort_order: 111, ui_hint: 'action' },
  { id: 'perm-skill-edit', code: 'skill.edit', name: t('permissions.auto_50b11c', {}, undefined), category: 'skill', module: 'skill', description: t('permissions.auto_00971b', {}, undefined), sort_order: 112, ui_hint: 'action' },
  { id: 'perm-skill-delete', code: 'skill.delete', name: t('permissions.auto_fd5a12', {}, undefined), category: 'skill', module: 'skill', description: t('permissions.auto_fd5a12', {}, undefined), sort_order: 113, ui_hint: 'action' },
  { id: 'perm-skill-publish', code: 'skill.publish', name: t('permissions.auto_d0b36b', {}, undefined), category: 'skill', module: 'skill', description: t('permissions.auto_f1a0b1', {}, undefined), sort_order: 114, ui_hint: 'action' },

  // ── Knowledge ──
  { id: 'perm-knowledge-view', code: 'knowledge.view', name: t('permissions.auto_55edfa', {}, undefined), category: 'knowledge', module: 'knowledge', description: t('permissions.auto_55edfa', {}, undefined), sort_order: 120, ui_hint: 'page' },
  { id: 'perm-knowledge-create', code: 'knowledge.create', name: t('permissions.auto_fe31ba', {}, undefined), category: 'knowledge', module: 'knowledge', description: t('permissions.auto_3ab899', {}, undefined), sort_order: 121, ui_hint: 'action' },
  { id: 'perm-knowledge-edit', code: 'knowledge.edit', name: t('permissions.auto_0fabdb', {}, undefined), category: 'knowledge', module: 'knowledge', description: t('permissions.auto_9c8ea5', {}, undefined), sort_order: 122, ui_hint: 'action' },
  { id: 'perm-knowledge-delete', code: 'knowledge.delete', name: t('permissions.auto_2b0f12', {}, undefined), category: 'knowledge', module: 'knowledge', description: t('permissions.auto_1a6e61', {}, undefined), sort_order: 123, ui_hint: 'action' },

  // ── Live2D (additional) ──
  { id: 'perm-live2d-edit-personal', code: 'live2d.edit_personal', name: t('permissions.auto_19411b', {}, undefined), category: 'live2d', module: 'live2d', description: t('permissions.auto_f440c5', {}, undefined), sort_order: 2, ui_hint: 'action' },

  // ── Soul (additional) ──
  { id: 'perm-soul-edit', code: 'soul.edit', name: t('permissions.auto_be2d82', {}, undefined), category: 'soul', module: 'soul', description: t('permissions.auto_294691', {}, undefined), sort_order: 2, ui_hint: 'action' },

  // ── IM ──
  { id: 'perm-im-view', code: 'im.view', name: t('permissions.auto_8a0a05', {}, undefined), category: 'im', module: 'im', description: t('permissions.auto_20de63', {}, undefined), sort_order: 130, ui_hint: 'page' },
  { id: 'perm-im-send', code: 'im.send', name: t('permissions.auto_c0cc59', {}, undefined), category: 'im', module: 'im', description: t('permissions.auto_05ab62', {}, undefined), sort_order: 131, ui_hint: 'action' },
  { id: 'perm-im-manage-groups', code: 'im.manage_groups', name: t('permissions.auto_a497a9', {}, undefined), category: 'im', module: 'im', description: t('permissions.auto_d84b7f', {}, undefined), sort_order: 132, ui_hint: 'action' },

  // ── Terminal ──
  { id: 'perm-terminal-access', code: 'terminal.access', name: t('permissions.auto_546b48', {}, undefined), category: 'terminal', module: 'terminal', description: t('permissions.auto_fa2d6c', {}, undefined), sort_order: 140, ui_hint: 'page' },
  { id: 'perm-browser-control', code: 'browser.control', name: t('permissions.browser_control', {}, undefined), category: 'browser', module: 'browser', description: t('permissions.browser_control_desc', {}, undefined), sort_order: 141, ui_hint: 'page' },
  { id: 'perm-local-install', code: 'local.install', name: t('permissions.local_install', {}, undefined), category: 'system', module: 'system', description: t('permissions.local_install_desc', {}, undefined), sort_order: 142, ui_hint: 'action' },

  // ── Marketplace ──
  { id: 'perm-marketplace-view', code: 'marketplace.view', name: t('permissions.auto_2032ff', {}, undefined), category: 'marketplace', module: 'marketplace', description: t('permissions.auto_b03375', {}, undefined), sort_order: 150, ui_hint: 'page' },
  { id: 'perm-marketplace-install', code: 'marketplace.install', name: t('permissions.auto_cfcef3', {}, undefined), category: 'marketplace', module: 'marketplace', description: t('permissions.auto_321cff', {}, undefined), sort_order: 151, ui_hint: 'action' },
  { id: 'perm-marketplace-manage-sources', code: 'marketplace.manage_sources', name: t('permissions.auto_52b61e', {}, undefined), category: 'marketplace', module: 'marketplace', description: t('permissions.auto_40f2e2', {}, undefined), sort_order: 152, ui_hint: 'action' },

  // ── Stock analysis ──
  { id: 'perm-stock-view', code: 'stock.view', name: t('permissions.auto_11f3fe', {}, undefined), category: 'stock', module: 'stock', description: t('permissions.auto_02ebbe', {}, undefined), sort_order: 160, ui_hint: 'page' },
  { id: 'perm-stock-create', code: 'stock.create', name: t('permissions.auto_9eb0b5', {}, undefined), category: 'stock', module: 'stock', description: t('permissions.auto_208fc5', {}, undefined), sort_order: 161, ui_hint: 'action' },
  { id: 'perm-stock-manage', code: 'stock.manage', name: t('permissions.auto_d26807', {}, undefined), category: 'stock', module: 'stock', description: t('permissions.auto_5a853d', {}, undefined), sort_order: 162, ui_hint: 'action' },

  // ── Workteam ──
  { id: 'perm-workteam-view', code: 'workteam.view', name: t('permissions.auto_2869c1', {}, undefined), category: 'workteam', module: 'workteam', description: t('permissions.auto_28a622', {}, undefined), sort_order: 170, ui_hint: 'page' },
  { id: 'perm-workteam-create', code: 'workteam.create', name: t('permissions.auto_e81eaf', {}, undefined), category: 'workteam', module: 'workteam', description: t('permissions.auto_e81eaf', {}, undefined), sort_order: 171, ui_hint: 'action' },
  { id: 'perm-workteam-manage', code: 'workteam.manage', name: t('permissions.auto_006aed', {}, undefined), category: 'workteam', module: 'workteam', description: t('permissions.auto_1b2258', {}, undefined), sort_order: 172, ui_hint: 'action' },

  // ── CodeMap ──
  { id: 'perm-codemap-view', code: 'codemap.view', name: t('permissions.auto_f7003f', {}, undefined), category: 'codemap', module: 'codemap', description: t('permissions.auto_c756ee', {}, undefined), sort_order: 180, ui_hint: 'page' },
  { id: 'perm-codemap-manage', code: 'codemap.manage', name: t('permissions.auto_f2ff0c', {}, undefined), category: 'codemap', module: 'codemap', description: t('permissions.auto_8eada9', {}, undefined), sort_order: 181, ui_hint: 'action' },

  // ── Admin ──
  { id: 'perm-admin-settings-write', code: 'admin.settings.write', name: t('permissions.auto_81047c', {}, undefined), category: 'system', module: 'system', description: t('permissions.auto_8ee5a3', {}, undefined), sort_order: 190, ui_hint: 'action' },
];

const PRESET_ROLES: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  permissionCodes: readonly string[];
}> = [
  {
    id: ADMIN_ROLE_ID,
    name: ADMIN_ROLE_NAME,
    description: t('permissions.auto_efd5bf', {}, undefined),
    permissionCodes: PRESET_PERMISSIONS.map((p) => p.code),
  },
  {
    id: 'role-manager',
    name: 'manager',
    description: t('permissions.auto_03c30e', {}, undefined),
    permissionCodes: [
      'project.manage', 'project.view',
      'review.create', 'review.view', 'review.manual', 'review.annotate',
      'review.repo.view', 'review.repo.view_all', 'review.repo.create', 'review.repo.edit', 'review.repo.delete', 'review.repo.share',
      'review.run.view', 'review.run.trigger', 'review.run.manual', 'review.run.annotate',
      'review.profile.edit', 'review.digest.manage',
      'repository.view', 'repository.create', 'repository.update', 'repository.delete', 'repository.worktree',
      'conversation.manage', 'conversation.own', 'conversation.send', 'conversation.view',
      'conversation.view_all', 'conversation.create', 'conversation.delete', 'conversation.export', 'conversation.share', 'conversation.access_config',
      'assistant.manage', 'assistant.view', 'assistant.create', 'assistant.edit', 'assistant.delete', 'assistant.start_chat',
      'provider.system.view', 'provider.personal.create', 'provider.personal.edit', 'provider.personal.delete',
      'live2d.view', 'live2d.manage', 'live2d.edit_personal',
      'soul.view', 'soul.manage', 'soul.edit',
      'channel.view', 'channel.own', 'channel.manage',
      'channel.personal.create', 'channel.personal.edit', 'channel.system.manage',
      'task.view', 'task.view_all', 'task.create', 'task.edit', 'task.delete',
      'mcp.view', 'mcp.create', 'mcp.edit', 'mcp.delete',
      'skill.view', 'skill.create', 'skill.edit', 'skill.delete',
      'knowledge.view', 'knowledge.create', 'knowledge.edit', 'knowledge.delete',
      'im.view', 'im.send', 'im.manage_groups',
      'marketplace.view', 'marketplace.install',
      'workteam.view', 'workteam.create', 'workteam.manage',
      'codemap.view', 'codemap.manage',
    ],
  },
  {
    id: 'role-reviewer',
    name: 'reviewer',
    description: t('permissions.auto_45a7f3', {}, undefined),
    permissionCodes: [
      'review.view', 'review.manual', 'review.annotate',
      'repository.view',
      'review.repo.view', 'review.run.view', 'review.run.manual', 'review.run.annotate',
      'conversation.own', 'conversation.send', 'conversation.view',
      'conversation.create', 'conversation.delete', 'conversation.export',
      'assistant.view', 'assistant.start_chat',
      'provider.personal.create', 'provider.personal.edit', 'provider.personal.delete',
      'live2d.view', 'live2d.edit_personal',
      'soul.view',
      'channel.view', 'channel.own', 'channel.personal.create', 'channel.personal.edit',
      'task.view', 'task.create', 'task.edit',
      'mcp.view', 'skill.view',
      'knowledge.view',
      'im.view', 'im.send',
      'marketplace.view', 'marketplace.install',
      'codemap.view',
    ],
  },
  {
    id: 'role-developer',
    name: 'developer',
    description: t('permissions.auto_1e5722', {}, undefined),
    permissionCodes: [
      'review.view',
      'repository.view', 'repository.create', 'repository.update',
      'review.repo.view', 'review.run.view',
      'conversation.own', 'conversation.send', 'conversation.view',
      'conversation.create', 'conversation.delete',
      'assistant.view', 'assistant.start_chat',
      'provider.personal.create', 'provider.personal.edit', 'provider.personal.delete',
      'live2d.view', 'live2d.edit_personal',
      'soul.view',
      'channel.view', 'channel.own', 'channel.personal.create',
      'task.view', 'task.create',
      'mcp.view', 'skill.view',
      'knowledge.view',
      'im.view', 'im.send',
      'marketplace.view', 'marketplace.install',
      'codemap.view',
    ],
  },
];

export async function seedRbacData(): Promise<void> {
  const dialect = d();
  const now = ts();

  for (const perm of PRESET_PERMISSIONS) {
    await eng().run(
      insertIgnoreSql(dialect, 'permissions', [
        'id', 'code', 'name', 'category', 'module', 'description', 'sort_order', 'ui_hint',
      ]),
      [perm.id, perm.code, perm.name, perm.category, perm.module, perm.description, perm.sort_order, perm.ui_hint],
    );
  }

  for (const role of PRESET_ROLES) {
    await eng().run(
      insertIgnoreSql(dialect, 'roles', [
        'id', 'name', 'description', 'is_system',
        'created_by', 'updated_by', 'created_at', 'updated_at',
      ]),
      [role.id, role.name, role.description, 1, getCurrentUserId(), getCurrentUserId(), now, now],
    );
    for (const code of role.permissionCodes) {
      const perm = PRESET_PERMISSIONS.find((p) => p.code === code);
      if (!perm) continue;
      await eng().run(
        insertIgnoreSql(dialect, 'role_permissions', ['role_id', 'permission_id']),
        [role.id, perm.id],
      );
    }
  }

  await ensureBootstrapAdminUser();
  logger.info('RBAC preset data seeded');
}

export function getAllPresetPermissions(): ReadonlyArray<PresetPermission> {
  return PRESET_PERMISSIONS;
}

async function getRoleIdByName(name: string): Promise<string | null> {
  const role = await eng().queryOne<Pick<RoleRecord, 'id'>>(
    'SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL',
    [name],
  );
  return role?.id || null;
}

export async function ensureBootstrapAdminUser(): Promise<void> {
  const adminRoleId = await getRoleIdByName(ADMIN_ROLE_NAME);
  if (!adminRoleId) return;

  const existingAdmin = await eng().queryOne<{ present: number }>(
    'SELECT 1 as present FROM user_roles WHERE role_id = ? AND deleted_at IS NULL LIMIT 1',
    [adminRoleId],
  );
  if (existingAdmin?.present) return;

  const firstUser = await eng().queryOne<Pick<UserRecord, 'id'>>(
    'SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC, username ASC LIMIT 1',
  );
  if (!firstUser) return;

  const now = ts();
  await eng().run(
    insertIgnoreSql(d(), 'user_roles', [
      'user_id',
      'role_id',
      'granted_at',
      'granted_by',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
    ]),
    [firstUser.id, adminRoleId, now, 'system-bootstrap', getCurrentUserId(), getCurrentUserId(), now, now],
  );
}

export async function getUserCount(): Promise<number> {
  const row = await eng().queryOne<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM users WHERE deleted_at IS NULL',
  );
  return row?.cnt ?? 0;
}

export async function isMultiUserMode(): Promise<boolean> {
  return (await getUserCount()) > 0;
}

export async function getUserByUsername(
  username: string,
): Promise<UserRecord | undefined> {
  return eng().queryOne<UserRecord>(
    'SELECT * FROM users WHERE username = ? AND deleted_at IS NULL',
    [username],
  );
}

export async function ensureUserByUsername(
  username: string,
): Promise<UserRecord> {
  const existing = await getUserByUsername(username);
  if (existing) return existing;
  const summary = await createUser({ username });
  const created = await getUserByUsername(summary.username);
  if (!created) throw new Error(`Failed to provision user record for ${username}`);
  return created;
}

export async function ensureUserFromLdap(ldap: {
  username: string;
  displayName: string;
  email: string | null;
  defaultRole?: string;
}): Promise<AuthValidationResult> {
  const existing = await getUserByUsername(ldap.username);
  if (existing) {
    if (existing.auth_source !== 'ldap') {
      throw new LdapLocalConflictError(ldap.username);
    }
    const needsUpdate =
      existing.display_name !== ldap.displayName ||
      existing.email !== (ldap.email ?? null);
    if (needsUpdate) {
      const now = ts();
      const sets: string[] = [
        'display_name = ?',
        'updated_by = ?',
        'updated_at = ?',
      ];
      const params: unknown[] = [ldap.displayName, auditActor(), now];
      sets.push('email = ?');
      params.push(ldap.email ?? null);
      params.push(existing.id);
      await eng().run(
        `UPDATE users SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        params,
      );
    }
    const roles = await getUserRoleNames(existing.id);
    const permissions = await getUserEffectivePermissions(existing.id);
    return {
      userId: existing.id,
      username: existing.username,
      displayName: ldap.displayName,
      roles,
      permissions,
    };
  }

  try {
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const roleNames = ldap.defaultRole ? [ldap.defaultRole] : undefined;
    const summary = await createUser({
      username: ldap.username,
      password: randomPassword,
      displayName: ldap.displayName,
      email: ldap.email || undefined,
      authSource: 'ldap',
      roleNames,
    });
    return {
      userId: summary.id,
      username: summary.username,
      displayName: summary.displayName,
      roles: summary.roles,
      permissions: await getUserEffectivePermissions(summary.id),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(msg)) {
      const retryUser = await getUserByUsername(ldap.username);
      if (retryUser && retryUser.auth_source === 'ldap') {
        const roles = await getUserRoleNames(retryUser.id);
        const permissions = await getUserEffectivePermissions(retryUser.id);
        return {
          userId: retryUser.id,
          username: retryUser.username,
          displayName: retryUser.display_name,
          roles,
          permissions,
        };
      }
    }
    throw err;
  }
}

export class LdapLocalConflictError extends Error {
  constructor(username: string) {
    super(`Username "${username}" already exists as a local account and cannot be linked to LDAP`);
    this.name = 'LdapLocalConflictError';
  }
}

export async function getUserById(
  id: string,
): Promise<UserRecord | undefined> {
  return eng().queryOne<UserRecord>(
    'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
}

export async function listUsers(): Promise<UserSummary[]> {
  const users = await eng().queryAll<UserRecord>(
    'SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC',
  );
  const result: UserSummary[] = [];
  for (const u of users) {
    const roles = await getUserRoleNames(u.id);
    result.push({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      status: u.status,
      roles,
      createdAt: u.created_at,
    });
  }
  return result;
}

export async function createUser(input: CreateUserInput): Promise<UserSummary> {
  const normalizedUsername = String(input.username || '').trim();
  const normalizedDisplayName = input.displayName?.trim() || null;
  const normalizedEmail = String(input.email || '').trim() || null;
  const normalizedPassword =
    String(input.password || '').trim() || DEFAULT_USER_PASSWORD;
  const id = crypto.randomUUID();
  const now = ts();
  const actor = auditActor(input.actorId);
  const passwordHash = await hashPassword(normalizedPassword);
  const userCountBeforeCreate = await getUserCount();
  const requestedRoleNames = new Set(
    (input.roleNames || []).map((entry) => entry.trim()).filter(Boolean),
  );
  if (userCountBeforeCreate === 0) {
    requestedRoleNames.add(ADMIN_ROLE_NAME);
  }

  const authSource = input.authSource || 'local';
  await eng().run(
    `INSERT INTO users (id, username, display_name, password_hash, email, auth_source, status,
      created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      normalizedUsername,
      normalizedDisplayName,
      passwordHash,
      normalizedEmail,
      authSource,
      'active',
      actor,
      actor,
      now,
      now,
    ],
  );

  for (const roleName of requestedRoleNames) {
    const role = await eng().queryOne<RoleRecord>(
      'SELECT id FROM roles WHERE name = ? AND deleted_at IS NULL',
      [roleName],
    );
    if (role) {
      await eng().run(
        insertIgnoreSql(d(), 'user_roles', [
          'user_id',
          'role_id',
          'granted_at',
          'granted_by',
          'created_by',
          'updated_by',
          'created_at',
          'updated_at',
        ]),
        [id, role.id, now, null, actor, actor, now, now],
      );
    }
  }

  const roles = await getUserRoleNames(id);
  return {
    id,
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    email: normalizedEmail,
    status: 'active',
    roles,
    createdAt: now,
  };
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actorId?: string,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const actor = auditActor(actorId);

  if (input.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(input.displayName);
  }
  if (input.email !== undefined) {
    sets.push('email = ?');
    params.push(input.email);
  }
  if (input.password) {
    sets.push('password_hash = ?');
    params.push(await hashPassword(input.password));
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (sets.length === 0) return;

  const now = ts();
  sets.push('updated_by = ?');
  params.push(actor);
  sets.push('updated_at = ?');
  params.push(now);
  params.push(id);

  await eng().run(
    `UPDATE users SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    params,
  );
}

export async function deleteUser(id: string, actorId?: string): Promise<void> {
  const now = ts();
  const actor = auditActor(actorId);
  await eng().run(
    `UPDATE user_roles SET deleted_at = ?, updated_by = ?, updated_at = ?
     WHERE user_id = ? AND deleted_at IS NULL`,
    [now, actor, now, id],
  );
  await eng().run('DELETE FROM auth_sessions WHERE user_id = ?', [id]);
  await eng().run(
    `UPDATE users SET deleted_at = ?, updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [now, actor, now, id],
  );
  invalidatePermissionCache(id);
}

export async function listRoles(): Promise<RoleRecord[]> {
  return eng().queryAll<RoleRecord>(
    'SELECT * FROM roles WHERE deleted_at IS NULL ORDER BY name ASC',
  );
}

export async function listPermissions(): Promise<PermissionRecord[]> {
  return eng().queryAll<PermissionRecord>(
    'SELECT * FROM permissions ORDER BY category, code',
  );
}

export async function listRolePermissionCodes(roleId: string): Promise<string[]> {
  const rows = await eng().queryAll<{ code: string }>(
    `SELECT p.code FROM permissions p
     INNER JOIN role_permissions rp ON p.id = rp.permission_id
     INNER JOIN roles r ON r.id = rp.role_id AND r.deleted_at IS NULL
     WHERE rp.role_id = ?
     ORDER BY p.category, p.code`,
    [roleId],
  );
  return rows.map((r) => r.code);
}

export async function listRolesWithPermissions(): Promise<
  Array<RoleRecord & { permissionCodes: string[] }>
> {
  const allRoles = await listRoles();
  return Promise.all(
    allRoles.map(async (role) => ({
      ...role,
      permissionCodes: await listRolePermissionCodes(role.id),
    })),
  );
}

export async function getUserRoleNames(userId: string): Promise<string[]> {
  const rows = await eng().queryAll<{ name: string }>(
    `SELECT r.name FROM user_roles ur
     JOIN roles r ON ur.role_id = r.id
     WHERE ur.user_id = ? AND ur.deleted_at IS NULL AND r.deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.name);
}

export async function getUserPermissionCodes(
  userId: string,
): Promise<string[]> {
  const rows = await eng().queryAll<{ code: string }>(
    `SELECT DISTINCT p.code FROM user_roles ur
     JOIN roles r ON ur.role_id = r.id AND r.deleted_at IS NULL
     JOIN role_permissions rp ON ur.role_id = rp.role_id
     JOIN permissions p ON rp.permission_id = p.id
     WHERE ur.user_id = ? AND ur.deleted_at IS NULL`,
    [userId],
  );
  return rows.map((r) => r.code);
}

export async function userHasPermission(
  userId: string,
  code: string,
): Promise<boolean> {
  const perms = await getUserEffectivePermissions(userId);
  return permissionMatches(perms, code);
}

export async function assignUserRole(
  userId: string,
  roleId: string,
  grantedBy?: string,
): Promise<void> {
  const now = ts();
  const actor = auditActor(grantedBy);
  const grantLabel = grantedBy?.trim() || null;
  const revived = await eng().run(
    `UPDATE user_roles SET deleted_at = NULL, updated_by = ?, updated_at = ?, granted_at = ?, granted_by = ?
     WHERE user_id = ? AND role_id = ? AND deleted_at IS NOT NULL`,
    [actor, now, now, grantLabel, userId, roleId],
  );
  if (revived.changes > 0) {
    invalidatePermissionCache(userId);
    return;
  }
  await eng().run(
    insertIgnoreSql(d(), 'user_roles', [
      'user_id',
      'role_id',
      'granted_at',
      'granted_by',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
    ]),
    [userId, roleId, now, grantLabel, actor, actor, now, now],
  );
  invalidatePermissionCache(userId);
}

export async function revokeUserRole(
  userId: string,
  roleId: string,
  actorId?: string,
): Promise<void> {
  const now = ts();
  const actor = auditActor(actorId);
  await eng().run(
    `UPDATE user_roles SET deleted_at = ?, updated_by = ?, updated_at = ?
     WHERE user_id = ? AND role_id = ? AND deleted_at IS NULL`,
    [now, actor, now, userId, roleId],
  );
  invalidatePermissionCache(userId);
}

export async function createRole(
  name: string,
  description: string,
  actorId?: string,
): Promise<{ id: string; name: string; description: string }> {
  const existing = await eng().queryOne<{ id: string }>(
    'SELECT id FROM roles WHERE name = ?',
    [name],
  );
  if (existing) {
    throw new Error(t('errors.roleNameExists', { name }, undefined));
  }

  const id = `role-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = ts();
  const actor = auditActor(actorId);
  await eng().run(
    insertIgnoreSql(d(), 'roles', [
      'id', 'name', 'description', 'is_system',
      'created_by', 'updated_by', 'created_at', 'updated_at',
    ]),
    [id, name, description || '', 0, actor, actor, now, now],
  );
  return { id, name, description };
}

export async function replaceRolePermissions(
  roleId: string,
  permissionCodes: string[],
): Promise<void> {
  const dialect = d();
  await eng().run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  for (const code of permissionCodes) {
    const perm = await eng().queryOne<Pick<PermissionRecord, 'id'>>(
      'SELECT id FROM permissions WHERE code = ?',
      [code],
    );
    if (!perm) continue;
    await eng().run(
      insertIgnoreSql(dialect, 'role_permissions', ['role_id', 'permission_id']),
      [roleId, perm.id],
    );
  }
  invalidatePermissionCache();
}

export async function validateCredentials(
  username: string,
  password: string,
): Promise<AuthValidationResult | null> {
  const user = await getUserByUsername(username);
  if (!user || user.status !== 'active') return null;

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return null;

  const roles = await getUserRoleNames(user.id);
  const permissions = await getUserEffectivePermissions(user.id);

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    roles,
    permissions,
  };
}

// ── Auth Session persistence (for database-backed session store) ────

import type { DbSessionPersistence } from '../auth/web-auth.js';

export function createDbSessionPersistence(): DbSessionPersistence {
  return {
    async insertSession(token, username, expiresAtIso) {
      await eng().run(
        `INSERT INTO auth_sessions (token, user_id, expires_at, created_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [token, username, expiresAtIso, new Date().toISOString(), null, null],
      );
    },
    async deleteSession(token) {
      await eng().run('DELETE FROM auth_sessions WHERE token = ?', [token]);
    },
    async deleteAllSessions() {
      await eng().run('DELETE FROM auth_sessions', []);
    },
    async deleteExpiredSessions(nowIso) {
      await eng().run('DELETE FROM auth_sessions WHERE expires_at <= ?', [nowIso]);
    },
    async loadAllSessions() {
      return eng().queryAll<{ token: string; username: string; expires_at: string }>(
        `SELECT s.token, COALESCE(u.username, s.user_id) AS username, s.expires_at
         FROM auth_sessions s
         LEFT JOIN users u ON (u.id = s.user_id OR u.username = s.user_id) AND u.deleted_at IS NULL`,
      );
    },
  };
}
