import { getActiveEngine, type DbEngine } from '../database/engine.js';
import { isMultiUserMode } from '../user/user-service.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { logger } from '../logger.js';

export interface ResourceContext {
  type: string;
  id: string;
  ownerId?: string;
  visibility?: string;
}

export interface EvalResult {
  allowed: boolean;
  reason: string;
}

interface CachedPermissions {
  rolePermissions: string[];
  overrides: Map<string, 'allow' | 'deny'>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const permissionCache = new Map<string, CachedPermissions>();

function eng(): DbEngine {
  return getActiveEngine();
}

/**
 * Wildcard permission match.
 * `review.*` matches `review.run.view`, `review.repo.create`, etc.
 * Exact match always checked first.
 */
function permissionMatchesSingle(code: string, action: string): boolean {
  if (code === action) return true;
  if (code.endsWith('.*') && action.startsWith(code.slice(0, -1))) return true;
  return false;
}

export function permissionMatches(
  owned: string[],
  required: string,
): boolean {
  for (const p of owned) {
    if (permissionMatchesSingle(p, required)) return true;
  }
  return false;
}

async function fetchUserPermissions(userId: string): Promise<CachedPermissions> {
  const rolePerms = await eng().queryAll<{ code: string }>(
    `SELECT DISTINCT p.code FROM user_roles ur
     JOIN role_permissions rp ON ur.role_id = rp.role_id
     JOIN permissions p ON rp.permission_id = p.id
     WHERE ur.user_id = ? AND ur.deleted_at IS NULL`,
    [userId],
  );

  const overrideRows = await eng().queryAll<{ code: string; effect: string }>(
    `SELECT p.code, upo.effect FROM user_permission_overrides upo
     JOIN permissions p ON upo.permission_id = p.id
     WHERE upo.user_id = ?`,
    [userId],
  );

  const overrides = new Map<string, 'allow' | 'deny'>();
  for (const row of overrideRows) {
    overrides.set(row.code, row.effect as 'allow' | 'deny');
  }

  return {
    rolePermissions: rolePerms.map((r) => r.code),
    overrides,
    fetchedAt: Date.now(),
  };
}

async function getCachedPermissions(userId: string): Promise<CachedPermissions> {
  const cached = permissionCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await fetchUserPermissions(userId);
  permissionCache.set(userId, fresh);
  return fresh;
}

export function invalidatePermissionCache(userId?: string): void {
  if (userId) {
    permissionCache.delete(userId);
  } else {
    permissionCache.clear();
  }
}

export function getEffectivePermissions(cached: CachedPermissions): string[] {
  const result = new Set(cached.rolePermissions);
  for (const [code, effect] of cached.overrides) {
    if (effect === 'allow') result.add(code);
    else if (effect === 'deny') result.delete(code);
  }
  return Array.from(result);
}

export async function getUserEffectivePermissions(userId: string): Promise<string[]> {
  const cached = await getCachedPermissions(userId);
  return getEffectivePermissions(cached);
}

async function checkResourceAccess(
  userId: string,
  resource: ResourceContext,
  requiredLevel: string,
): Promise<boolean> {
  const levelHierarchy: Record<string, number> = {
    viewer: 1,
    editor: 2,
    manager: 3,
  };
  const requiredNum = levelHierarchy[requiredLevel] ?? 1;

  const row = await eng().queryOne<{ access_level: string }>(
    `SELECT access_level FROM resource_access
     WHERE resource_type = ? AND resource_id = ? AND user_id = ?
     AND (expires_at IS NULL OR expires_at > ?)`,
    [resource.type, resource.id, userId, new Date().toISOString()],
  );

  if (!row) return false;
  return (levelHierarchy[row.access_level] ?? 0) >= requiredNum;
}

function actionHasSegment(action: string, segment: string): boolean {
  return action.split('.').includes(segment);
}

function actionToAccessLevel(action: string): string {
  if (actionHasSegment(action, 'delete') || actionHasSegment(action, 'manage')) return 'manager';
  if (actionHasSegment(action, 'edit') || actionHasSegment(action, 'create') || actionHasSegment(action, 'send')) return 'editor';
  return 'viewer';
}

/**
 * Core ABAC evaluation.
 *
 * 1. System user → ALLOW
 * 2. Single-user mode → ALLOW (bypass)
 * 3. Check deny overrides → DENY
 * 4. Check allow overrides or role permissions (with wildcard) → if none match, DENY
 * 5. If resource context provided:
 *    a. Owner match → ALLOW
 *    b. resource_access ACL → ALLOW if level sufficient
 *    c. Public visibility → ALLOW for view actions
 *    d. DENY
 * 6. No resource context → ALLOW (permission already matched)
 */
export async function evaluate(
  userId: string,
  action: string,
  resource?: ResourceContext,
): Promise<EvalResult> {
  if (userId === SYSTEM_USER_ID) {
    return { allowed: true, reason: 'system_user' };
  }

  const multiUser = await isMultiUserMode();
  if (!multiUser) {
    return { allowed: true, reason: 'single_user_bypass' };
  }

  const cached = await getCachedPermissions(userId);

  for (const [code, effect] of cached.overrides) {
    if (effect === 'deny' && permissionMatchesSingle(code, action)) {
      return { allowed: false, reason: `deny_override:${code}` };
    }
  }

  const effectivePerms = getEffectivePermissions(cached);
  if (!permissionMatches(effectivePerms, action)) {
    return { allowed: false, reason: `no_permission:${action}` };
  }

  if (!resource) {
    return { allowed: true, reason: 'permission_granted' };
  }

  if (resource.ownerId && resource.ownerId === userId) {
    return { allowed: true, reason: 'resource_owner' };
  }

  const requiredLevel = actionToAccessLevel(action);
  try {
    const hasAccess = await checkResourceAccess(userId, resource, requiredLevel);
    if (hasAccess) {
      return { allowed: true, reason: 'resource_acl' };
    }
  } catch (err) {
    logger.warn({ err, userId, action, resource }, 'Resource access check failed');
  }

  if (resource.visibility === 'public' && actionHasSegment(action, 'view')) {
    return { allowed: true, reason: 'public_resource' };
  }

  return { allowed: false, reason: `no_resource_access:${resource.type}:${resource.id}` };
}

/**
 * Batch-check multiple permission codes (OR semantics: any one is sufficient).
 */
export async function evaluateAny(
  userId: string,
  actions: string[],
  resource?: ResourceContext,
): Promise<EvalResult> {
  for (const action of actions) {
    const result = await evaluate(userId, action, resource);
    if (result.allowed) return result;
  }
  return { allowed: false, reason: `no_permission_any:[${actions.join(',')}]` };
}

/**
 * Check if user has resource-level access (via resource_access table).
 */
export async function hasResourceAccess(
  userId: string,
  resourceType: string,
  resourceId: string,
  requiredLevel = 'viewer',
): Promise<boolean> {
  return checkResourceAccess(
    userId,
    { type: resourceType, id: resourceId },
    requiredLevel,
  );
}

export async function grantResourceAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
  accessLevel: string,
  grantedBy: string,
  expiresAt?: string,
): Promise<void> {
  const id = `ra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const dialect = eng().dialect;

  if (dialect === 'postgres') {
    await eng().run(
      `INSERT INTO resource_access (id, resource_type, resource_id, user_id, access_level, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (resource_type, resource_id, user_id) DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at`,
      [id, resourceType, resourceId, userId, accessLevel, grantedBy, now, expiresAt ?? null],
    );
  } else if (dialect === 'mysql') {
    await eng().run(
      `REPLACE INTO resource_access (id, resource_type, resource_id, user_id, access_level, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, resourceType, resourceId, userId, accessLevel, grantedBy, now, expiresAt ?? null],
    );
  } else {
    await eng().run(
      `INSERT OR REPLACE INTO resource_access (id, resource_type, resource_id, user_id, access_level, granted_by, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, resourceType, resourceId, userId, accessLevel, grantedBy, now, expiresAt ?? null],
    );
  }
}

export async function revokeResourceAccess(
  resourceType: string,
  resourceId: string,
  userId: string,
): Promise<void> {
  await eng().run(
    'DELETE FROM resource_access WHERE resource_type = ? AND resource_id = ? AND user_id = ?',
    [resourceType, resourceId, userId],
  );
}

export async function listResourceAccessUsers(
  resourceType: string,
  resourceId: string,
): Promise<Array<{ userId: string; accessLevel: string; grantedBy: string; grantedAt: string }>> {
  const rows = await eng().queryAll<{
    user_id: string;
    access_level: string;
    granted_by: string;
    granted_at: string;
  }>(
    `SELECT user_id, access_level, granted_by, granted_at
     FROM resource_access
     WHERE resource_type = ? AND resource_id = ?
     AND (expires_at IS NULL OR expires_at > ?)`,
    [resourceType, resourceId, new Date().toISOString()],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    accessLevel: r.access_level,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));
}

export async function listUserAccessibleResources(
  userId: string,
  resourceType: string,
): Promise<Array<{ resourceId: string; accessLevel: string }>> {
  const rows = await eng().queryAll<{
    resource_id: string;
    access_level: string;
  }>(
    `SELECT resource_id, access_level
     FROM resource_access
     WHERE user_id = ? AND resource_type = ?
     AND (expires_at IS NULL OR expires_at > ?)`,
    [userId, resourceType, new Date().toISOString()],
  );
  return rows.map((r) => ({
    resourceId: r.resource_id,
    accessLevel: r.access_level,
  }));
}

export async function grantPermissionOverride(
  userId: string,
  permissionCode: string,
  effect: 'allow' | 'deny',
  grantedBy: string,
): Promise<void> {
  const perm = await eng().queryOne<{ id: string }>(
    'SELECT id FROM permissions WHERE code = ?',
    [permissionCode],
  );
  if (!perm) throw new Error(`Permission code not found: ${permissionCode}`);

  const now = new Date().toISOString();
  const dialect = eng().dialect;

  if (dialect === 'postgres') {
    await eng().run(
      `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
      [userId, perm.id, effect, grantedBy, now],
    );
  } else if (dialect === 'mysql') {
    await eng().run(
      `REPLACE INTO user_permission_overrides (user_id, permission_id, effect, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, perm.id, effect, grantedBy, now],
    );
  } else {
    await eng().run(
      `INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, perm.id, effect, grantedBy, now],
    );
  }

  invalidatePermissionCache(userId);
}

export async function revokePermissionOverride(
  userId: string,
  permissionCode: string,
): Promise<void> {
  const perm = await eng().queryOne<{ id: string }>(
    'SELECT id FROM permissions WHERE code = ?',
    [permissionCode],
  );
  if (!perm) return;

  await eng().run(
    'DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?',
    [userId, perm.id],
  );

  invalidatePermissionCache(userId);
}

export async function listPermissionOverrides(
  userId: string,
): Promise<Array<{ code: string; name: string; effect: string }>> {
  const rows = await eng().queryAll<{ code: string; name: string; effect: string }>(
    `SELECT p.code, p.name, upo.effect
     FROM user_permission_overrides upo
     JOIN permissions p ON upo.permission_id = p.id
     WHERE upo.user_id = ?`,
    [userId],
  );
  return rows;
}
