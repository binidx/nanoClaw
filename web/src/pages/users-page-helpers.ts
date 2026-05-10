export interface UserSummary {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  roles: string[];
  createdAt: string;
}

export interface FilterUsersInput {
  users: readonly UserSummary[];
  searchQuery?: string;
  statusFilter?: string;
  roleFilter?: string;
}

export interface PaginatedUsersResult {
  items: UserSummary[];
  page: number;
  total: number;
  totalPages: number;
}

export interface RoleSummary {
  visibleRoles: string[];
  overflowCount: number;
  label: string;
}

function normalizeText(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeRoleNames(roles: string[] | null | undefined): string[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((role) => normalizeText(role))
    .filter(Boolean);
}

export function filterUsers({
  users,
  searchQuery = '',
  statusFilter = 'all',
  roleFilter = 'all',
}: FilterUsersInput): UserSummary[] {
  const search = normalizeText(searchQuery);
  const normalizedStatus = normalizeText(statusFilter);
  const normalizedRole = normalizeText(roleFilter);

  return users.filter((user) => {
    if (
      normalizedStatus &&
      normalizedStatus !== 'all' &&
      normalizeText(user.status) !== normalizedStatus
    ) {
      return false;
    }

    if (
      normalizedRole &&
      normalizedRole !== 'all' &&
      !normalizeRoleNames(user.roles).includes(normalizedRole)
    ) {
      return false;
    }

    if (!search) return true;

    const haystack = [
      user.username,
      user.displayName || '',
      user.email || '',
    ]
      .map((value) => normalizeText(value))
      .join(' ');

    return haystack.includes(search);
  });
}

export function paginateUsers(
  users: readonly UserSummary[],
  page: number,
  pageSize: number,
): PaginatedUsersResult {
  const total = users.length;
  const safePageSize = Math.max(1, Math.floor(pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (safePage - 1) * safePageSize;

  return {
    items: users.slice(start, start + safePageSize),
    page: safePage,
    total,
    totalPages,
  };
}

export function buildRoleSummary(
  roles: string[] | null | undefined,
  visibleCount = 2,
): RoleSummary {
  const normalizedRoles = Array.isArray(roles)
    ? roles.map((role) => String(role || '').trim()).filter(Boolean)
    : [];
  const safeVisibleCount = Math.max(1, Math.floor(visibleCount) || 1);
  const visibleRoles = normalizedRoles.slice(0, safeVisibleCount);
  const overflowCount = Math.max(0, normalizedRoles.length - visibleRoles.length);
  const label =
    overflowCount > 0
      ? `${visibleRoles.join(' · ')} +${overflowCount}`
      : visibleRoles.join(' · ');

  return {
    visibleRoles,
    overflowCount,
    label: label || '-',
  };
}

export function resolveSelectedUserId(
  users: readonly UserSummary[],
  selectedUserId: string | null | undefined,
): string | null {
  if (users.length === 0) return null;
  if (selectedUserId && users.some((user) => user.id === selectedUserId)) {
    return selectedUserId;
  }
  return users[0]?.id || null;
}
