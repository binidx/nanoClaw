import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { dba } from '../db/engine-access.js';
import {
  evaluate,
  grantPermissionOverride,
  grantResourceAccess,
  invalidatePermissionCache,
} from './permission-engine.js';

const TS = '2026-05-20T00:00:00.000Z';

async function seedUser(id: string, username: string): Promise<void> {
  await dba
    .prepare(
      `INSERT INTO users
       (id, username, display_name, password_hash, email, auth_source, status, created_at, updated_at)
       VALUES (?, ?, ?, 'hash', NULL, 'local', 'active', ?, ?)`,
    )
    .run(id, username, username, TS, TS);
}

function seedRoleWithPermissions(
  userId: string,
  roleId: string,
  permissions: string[],
): Promise<void> {
  return (async () => {
    await dba
      .prepare(
        `INSERT INTO roles (id, name, description, is_system, created_at, updated_at)
       VALUES (?, ?, NULL, 0, ?, ?)`,
      )
      .run(roleId, roleId, TS, TS);
    await dba
      .prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_at, granted_by, created_at, updated_at)
       VALUES (?, ?, ?, '__system__', ?, ?)`,
      )
      .run(userId, roleId, TS, TS, TS);

    for (const code of permissions) {
      const permissionId = `perm-${code.replace(/[^a-z0-9]+/gi, '-')}`;
      await dba
        .prepare(
          `INSERT OR IGNORE INTO permissions (id, code, name, category)
         VALUES (?, ?, ?, 'test')`,
        )
        .run(permissionId, code, code);
      await dba
        .prepare(
          `INSERT INTO role_permissions (role_id, permission_id)
         VALUES (?, ?)`,
        )
        .run(roleId, permissionId);
    }
  })();
}

describe('permission engine security matrix', () => {
  beforeEach(() => {
    _initTestDatabase();
    invalidatePermissionCache();
  });

  it('requires both RBAC permission and resource access for non-owner edits', async () => {
    await seedUser('user-editor', 'editor');
    await seedRoleWithPermissions('user-editor', 'role-review-editor', [
      'review.repo.edit',
    ]);
    await grantResourceAccess(
      'review_repository',
      'repo-1',
      'user-editor',
      'viewer',
      'admin',
    );

    await expect(
      evaluate('user-editor', 'review.repo.edit', {
        type: 'review_repository',
        id: 'repo-1',
        ownerId: 'owner-other',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'no_resource_access:review_repository:repo-1',
    });

    await grantResourceAccess(
      'review_repository',
      'repo-1',
      'user-editor',
      'editor',
      'admin',
    );
    await expect(
      evaluate('user-editor', 'review.repo.edit', {
        type: 'review_repository',
        id: 'repo-1',
        ownerId: 'owner-other',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'resource_acl' });
  });

  it('does not let public visibility bypass missing RBAC permission', async () => {
    await seedUser('user-viewer', 'viewer');
    await seedRoleWithPermissions('user-viewer', 'role-empty', []);

    await expect(
      evaluate('user-viewer', 'review.repo.view', {
        type: 'review_repository',
        id: 'public-repo',
        visibility: 'public',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'no_permission:review.repo.view',
    });
  });

  it('lets public visibility satisfy view-only resource access after RBAC passes', async () => {
    await seedUser('user-viewer', 'viewer');
    await seedRoleWithPermissions('user-viewer', 'role-review-viewer', [
      'review.repo.view',
      'review.repo.edit',
    ]);

    await expect(
      evaluate('user-viewer', 'review.repo.view', {
        type: 'review_repository',
        id: 'public-repo',
        ownerId: 'owner-other',
        visibility: 'public',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'public_resource' });

    await expect(
      evaluate('user-viewer', 'review.repo.edit', {
        type: 'review_repository',
        id: 'public-repo',
        ownerId: 'owner-other',
        visibility: 'public',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'no_resource_access:review_repository:public-repo',
    });
  });

  it('applies deny overrides before role wildcards and resource ownership', async () => {
    await seedUser('user-owner', 'owner');
    await seedRoleWithPermissions('user-owner', 'role-review-admin', [
      'review.*',
    ]);
    await dba
      .prepare(
        `INSERT OR IGNORE INTO permissions (id, code, name, category)
         VALUES ('perm-review-repo-delete', 'review.repo.delete', 'review.repo.delete', 'test')`,
      )
      .run();
    await grantPermissionOverride(
      'user-owner',
      'review.repo.delete',
      'deny',
      'admin',
    );

    await expect(
      evaluate('user-owner', 'review.repo.delete', {
        type: 'review_repository',
        id: 'owned-repo',
        ownerId: 'user-owner',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'deny_override:review.repo.delete',
    });
  });
});
