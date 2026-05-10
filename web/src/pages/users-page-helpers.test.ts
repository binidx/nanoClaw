import { describe, expect, it } from 'vitest';

import {
  buildRoleSummary,
  filterUsers,
  paginateUsers,
  resolveSelectedUserId,
  type UserSummary,
} from './users-page-helpers';

const USERS: UserSummary[] = [
  {
    id: 'u-1',
    username: 'admin',
    displayName: '系统管理员',
    email: 'admin@example.com',
    status: 'active',
    roles: ['admin', 'reviewer'],
    createdAt: '2026-03-26T10:00:00.000Z',
  },
  {
    id: 'u-2',
    username: 'alice',
    displayName: 'Alice Chen',
    email: 'alice@example.com',
    status: 'disabled',
    roles: ['developer'],
    createdAt: '2026-03-26T10:05:00.000Z',
  },
  {
    id: 'u-3',
    username: 'bob',
    displayName: null,
    email: 'bob@example.com',
    status: 'active',
    roles: ['reviewer', 'developer'],
    createdAt: '2026-03-26T10:10:00.000Z',
  },
];

describe('users-page helpers', () => {
  it('filters users by search text across username, displayName, and email', () => {
    expect(filterUsers({ users: USERS, searchQuery: 'alice' }).map((user) => user.id)).toEqual(['u-2']);
    expect(filterUsers({ users: USERS, searchQuery: '管理员' }).map((user) => user.id)).toEqual(['u-1']);
    expect(filterUsers({ users: USERS, searchQuery: 'bob@example.com' }).map((user) => user.id)).toEqual(['u-3']);
  });

  it('filters users by status and role', () => {
    expect(
      filterUsers({
        users: USERS,
        statusFilter: 'active',
        roleFilter: 'reviewer',
      }).map((user) => user.id),
    ).toEqual(['u-1', 'u-3']);
  });

  it('treats blank and all filters as pass-through and matches case-insensitively', () => {
    expect(
      filterUsers({
        users: USERS,
        searchQuery: '  ADMIN  ',
        statusFilter: 'ALL',
        roleFilter: 'all',
      }).map((user) => user.id),
    ).toEqual(['u-1']);
  });

  it('does not crash when a user has malformed roles data at runtime', () => {
    const unsafeUsers = [
      ...USERS,
      {
        ...USERS[0],
        id: 'u-4',
        username: 'broken',
        roles: {} as unknown as string[],
      },
    ];

    expect(
      filterUsers({
        users: unsafeUsers,
        roleFilter: 'reviewer',
      }).map((user) => user.id),
    ).toEqual(['u-1', 'u-3']);
  });

  it('returns the requested page window and clamps invalid pages', () => {
    expect(paginateUsers(USERS, 2, 2)).toMatchObject({
      page: 2,
      total: 3,
      totalPages: 2,
      items: [USERS[2]],
    });

    expect(paginateUsers(USERS, 99, 2)).toMatchObject({
      page: 2,
      totalPages: 2,
      items: [USERS[2]],
    });

    expect(paginateUsers([], 0, 0)).toMatchObject({
      page: 1,
      total: 0,
      totalPages: 1,
      items: [],
    });
  });

  it('builds a compact role summary with overflow count', () => {
    expect(buildRoleSummary(['admin', 'reviewer', 'developer'])).toEqual({
      visibleRoles: ['admin', 'reviewer'],
      overflowCount: 1,
      label: 'admin · reviewer +1',
    });
  });

  it('returns a stable empty role summary for missing or blank roles', () => {
    expect(buildRoleSummary(undefined)).toEqual({
      visibleRoles: [],
      overflowCount: 0,
      label: '-',
    });

    expect(buildRoleSummary(['admin', '', '  reviewer  '], 1)).toEqual({
      visibleRoles: ['admin'],
      overflowCount: 1,
      label: 'admin +1',
    });
  });

  it('resolves a safe selected user after filtering or deletion', () => {
    expect(resolveSelectedUserId(USERS, 'u-2')).toBe('u-2');
    expect(resolveSelectedUserId(USERS, 'missing')).toBe('u-1');
    expect(resolveSelectedUserId([], 'u-2')).toBeNull();
  });
});
