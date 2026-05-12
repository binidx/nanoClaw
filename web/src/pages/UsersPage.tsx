import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import { useNavigatedTab } from '../hooks/useNavigatedTab';
import { SectionNav } from '../components/common/SectionNav';
import {
  buildRoleSummary,
  filterUsers,
  paginateUsers,
  resolveSelectedUserId,
  type UserSummary,
} from './users-page-helpers';

export interface UsersPageProps {
  apiBase: string;
}

type UsersTab = 'users' | 'roles' | 'repo-access' | 'permission-overrides';
const VALID_USERS_TABS: ReadonlySet<string> = new Set<UsersTab>([
  'users',
  'roles',
  'repo-access',
  'permission-overrides',
]);
type UsersPaneMode = 'empty' | 'detail' | 'edit' | 'create';
type NoticeTone = 'success' | 'error';

interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  permissionCodes?: string[];
}

interface RepoRecord {
  id: string;
  name: string;
  enabled: boolean;
}

interface RepoMember {
  repository_id: string;
  user_id: string;
  access_level: string;
  granted_at: string;
  granted_by: string | null;
}

function getRoleDisplayName(
  t: (key: string) => string,
  roleName: string,
): string {
  const map: Record<string, string> = {
    admin: t('users.role.admin'),
    manager: t('users.role.manager'),
    reviewer: t('users.role.reviewer'),
    developer: t('users.role.developer'),
  };
  return map[roleName] || roleName;
}

function getRoleDescription(
  t: (key: string) => string,
  role: RoleRecord,
): string {
  const fallbackByName: Record<string, string> = {
    admin: t('users.roleDesc.admin'),
    manager: t('users.roleDesc.manager'),
    reviewer: t('users.roleDesc.reviewer'),
    developer: t('users.roleDesc.developer'),
  };
  const description = String(role.description || '').trim();
  const normalized = description.replace(/\s+/g, '');
  const knownChineseDescriptions: Record<string, string> = {
    '系统管理员（全部权限）': t('users.roleDesc.admin'),
    '系统管理员(全部权限)': t('users.roleDesc.admin'),
    全部权限: t('users.roleDesc.admin'),
    项目管理员: t('users.roleDesc.manager'),
    '管理项目、审查、助手和常用配置': t('users.roleDesc.manager'),
    代码审查员: t('users.roleDesc.reviewer'),
    参与代码审查和查看审查结果: t('users.roleDesc.reviewer'),
    开发者: t('users.roleDesc.developer'),
    日常开发和基础协作权限: t('users.roleDesc.developer'),
  };

  return (
    knownChineseDescriptions[normalized] ||
    description ||
    fallbackByName[role.name] ||
    t('users.当前角色没有补充说明')
  );
}

function getAccessLevelOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'viewer', label: t('users.查看者') },
    { value: 'reviewer', label: t('users.审查员') },
    { value: 'manager', label: t('users.管理者') },
  ];
}

function getAccessLevelLabels(
  t: (key: string) => string,
): Record<string, string> {
  return {
    viewer: t('users.查看者'),
    reviewer: t('users.审查员'),
    manager: t('users.管理者'),
  };
}

function normalizeRepo(value: unknown): RepoRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const name = typeof r.name === 'string' ? r.name : '';
  if (!id) return null;
  return { id, name: name || id, enabled: r.enabled !== false };
}

function normalizeMember(value: unknown): RepoMember | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  return {
    repository_id: String(r.repository_id || ''),
    user_id: String(r.user_id || ''),
    access_level: String(r.access_level || 'viewer'),
    granted_at: String(r.granted_at || ''),
    granted_by: typeof r.granted_by === 'string' ? r.granted_by : null,
  };
}

function getPermissionLabel(t: (key: string) => string, code: string): string {
  const map: Record<string, string> = {
    'system.settings': t('users.系统设置'),
    'system.settings.view': t('users.查看系统设置'),
    'system.settings.edit': t('users.修改系统设置'),
    'system.users': t('users.用户管理'),
    'system.users.view': t('users.查看用户列表'),
    'system.users.create': t('users.新增用户'),
    'system.users.edit': t('users.编辑用户'),
    'system.users.delete': t('users.删除/停用用户'),
    'system.users.assign_role': t('users.分配角色'),
    'system.providers': t('users.Provider 管理'),
    'provider.system.view': t('users.查看系统 Provider'),
    'provider.system.create': t('users.新增系统 Provider'),
    'provider.system.edit': t('users.编辑系统 Provider'),
    'provider.system.delete': t('users.删除系统 Provider'),
    'provider.personal.create': t('users.新增个人 Provider'),
    'provider.personal.edit': t('users.编辑个人 Provider'),
    'provider.personal.delete': t('users.删除个人 Provider'),
    'project.manage': t('users.项目配置'),
    'project.view': t('users.项目查看'),
    'conversation.view': t('users.对话查看'),
    'conversation.view_all': t('users.查看所有对话'),
    'conversation.create': t('users.新建对话'),
    'conversation.delete': t('users.删除自己的对话'),
    'conversation.delete_all': t('users.删除任意对话'),
    'conversation.send': t('users.发送消息'),
    'conversation.export': t('users.导出对话'),
    'conversation.share': t('users.分享对话'),
    'conversation.access_config': t('users.配置对话访问'),
    'conversation.manage': t('users.全局对话管理'),
    'conversation.own': t('users.自有对话管理'),
    'review.create': t('users.发起审查'),
    'review.view': t('users.查看审查'),
    'review.manual': t('users.手动审查'),
    'review.annotate': t('users.批注反馈'),
    'review.repo.view': t('users.查看审查仓库'),
    'review.repo.view_all': t('users.查看所有仓库'),
    'review.repo.create': t('users.新增审查仓库'),
    'review.repo.edit': t('users.编辑仓库配置'),
    'review.repo.delete': t('users.删除仓库配置'),
    'review.repo.share': t('users.分享仓库访问'),
    'review.run.view': t('users.查看审查结果'),
    'review.run.trigger': t('users.触发审查'),
    'review.run.manual': t('users.手动审查决策'),
    'review.run.annotate': t('users.批注反馈'),
    'review.profile.edit': t('users.编辑审查 Profile'),
    'review.digest.manage': t('users.管理审查摘要'),
    'assistant.manage': t('users.助手配置'),
    'assistant.view': t('users.查看助手'),
    'assistant.create': t('users.新建助手'),
    'assistant.edit': t('users.编辑助手'),
    'assistant.delete': t('users.删除助手'),
    'assistant.start_chat': t('users.用助手发起对话'),
    'channel.view': t('users.频道查看'),
    'channel.own': t('users.个人频道绑定'),
    'channel.manage': t('users.全局频道管理'),
    'channel.personal.create': t('users.新增个人频道'),
    'channel.personal.edit': t('users.编辑个人频道'),
    'channel.system.manage': t('users.管理系统频道'),
    'task.view': t('users.查看任务'),
    'task.view_all': t('users.查看所有任务'),
    'task.create': t('users.新建任务'),
    'task.edit': t('users.编辑任务'),
    'task.delete': t('users.删除任务'),
    'mcp.view': t('users.查看 MCP'),
    'mcp.create': t('users.新增 MCP'),
    'mcp.edit': t('users.编辑 MCP'),
    'mcp.delete': t('users.删除 MCP'),
    'mcp.publish': t('users.发布 MCP'),
    'skill.view': t('users.查看技能'),
    'skill.create': t('users.新增技能'),
    'skill.edit': t('users.编辑技能'),
    'skill.delete': t('users.删除技能'),
    'skill.publish': t('users.发布技能'),
    'knowledge.view': t('users.查看知识库'),
    'knowledge.create': t('users.新增知识库'),
    'knowledge.edit': t('users.编辑知识库'),
    'knowledge.delete': t('users.删除知识库'),
    'live2d.view': t('users.Live2D 查看'),
    'live2d.manage': t('users.Live2D 管理'),
    'live2d.edit_personal': t('users.Live2D 个人设置'),
    'soul.view': t('users.AI 灵魂查看'),
    'soul.manage': t('users.AI 灵魂管理'),
    'soul.edit': t('users.AI 灵魂编辑'),
    'im.view': t('users.IM 查看'),
    'im.send': t('users.IM 发送'),
    'im.manage_groups': t('users.IM 群组管理'),
    'terminal.access': t('users.终端访问'),
    'marketplace.view': t('users.市场查看'),
    'marketplace.install': t('users.市场安装'),
    'marketplace.manage_sources': t('users.市场源管理'),
    'stock.view': t('users.股票分析查看'),
    'stock.create': t('users.新增分析任务'),
    'stock.manage': t('users.股票分析管理'),
    'workteam.view': t('users.Workflow 查看'),
    'workteam.create': t('users.新建 Workflow'),
    'workteam.manage': t('users.Workflow 管理'),
    'codemap.view': t('users.CodeMap 查看'),
    'codemap.manage': t('users.CodeMap 管理'),
    'admin.settings.write': t('users.管理员配置写入'),
  };
  return map[code] || code;
}

interface PermissionSubGroup {
  label: string;
  codes: string[];
}

interface PermissionNavGroup {
  section: string;
  subGroups: PermissionSubGroup[];
}

function getPermissionGroups(t: (key: string) => string): PermissionNavGroup[] {
  return [
    {
      section: t('users.聊天'),
      subGroups: [
        {
          label: t('users.对话'),
          codes: [
            'conversation.view',
            'conversation.view_all',
            'conversation.create',
            'conversation.delete',
            'conversation.delete_all',
            'conversation.send',
            'conversation.export',
            'conversation.share',
            'conversation.access_config',
            'conversation.manage',
            'conversation.own',
          ],
        },
        {
          label: t('users.即时通讯'),
          codes: ['im.view', 'im.send', 'im.manage_groups'],
        },
        {
          label: t('users.股票分析'),
          codes: ['stock.view', 'stock.create', 'stock.manage'],
        },
      ],
    },
    {
      section: t('users.任务'),
      subGroups: [
        {
          label: t('users.任务管理'),
          codes: [
            'task.view',
            'task.view_all',
            'task.create',
            'task.edit',
            'task.delete',
          ],
        },
      ],
    },
    {
      section: t('users.审查'),
      subGroups: [
        {
          label: t('users.代码审查'),
          codes: [
            'review.create',
            'review.view',
            'review.manual',
            'review.annotate',
            'review.repo.view',
            'review.repo.view_all',
            'review.repo.create',
            'review.repo.edit',
            'review.repo.delete',
            'review.repo.share',
            'review.run.view',
            'review.run.trigger',
            'review.run.manual',
            'review.run.annotate',
            'review.profile.edit',
            'review.digest.manage',
          ],
        },
        { label: 'CodeMap', codes: ['codemap.view', 'codemap.manage'] },
      ],
    },
    {
      section: 'Workflow',
      subGroups: [
        {
          label: 'Workflow',
          codes: ['workteam.view', 'workteam.create', 'workteam.manage'],
        },
      ],
    },
    {
      section: t('users.助手'),
      subGroups: [
        {
          label: t('users.助手管理'),
          codes: [
            'assistant.manage',
            'assistant.view',
            'assistant.create',
            'assistant.edit',
            'assistant.delete',
            'assistant.start_chat',
          ],
        },
        {
          label: t('users.AI 灵魂'),
          codes: ['soul.view', 'soul.manage', 'soul.edit'],
        },
        {
          label: t('users.知识库'),
          codes: [
            'knowledge.view',
            'knowledge.create',
            'knowledge.edit',
            'knowledge.delete',
          ],
        },
      ],
    },
    {
      section: t('users.控制'),
      subGroups: [
        {
          label: t('users.频道'),
          codes: [
            'channel.view',
            'channel.own',
            'channel.manage',
            'channel.personal.create',
            'channel.personal.edit',
            'channel.system.manage',
          ],
        },
        { label: t('users.终端'), codes: ['terminal.access'] },
      ],
    },
    {
      section: t('users.设置'),
      subGroups: [
        {
          label: t('users.应用与市场'),
          codes: [
            'mcp.view',
            'mcp.create',
            'mcp.edit',
            'mcp.delete',
            'mcp.publish',
            'skill.view',
            'skill.create',
            'skill.edit',
            'skill.delete',
            'skill.publish',
            'marketplace.view',
            'marketplace.install',
            'marketplace.manage_sources',
          ],
        },
        {
          label: t('users.系统配置'),
          codes: [
            'system.settings',
            'system.settings.view',
            'system.settings.edit',
            'admin.settings.write',
          ],
        },
        {
          label: 'Live2D',
          codes: ['live2d.view', 'live2d.manage', 'live2d.edit_personal'],
        },
        {
          label: 'Provider',
          codes: [
            'system.providers',
            'provider.system.view',
            'provider.system.create',
            'provider.system.edit',
            'provider.system.delete',
            'provider.personal.create',
            'provider.personal.edit',
            'provider.personal.delete',
          ],
        },
      ],
    },
    {
      section: t('users.用户管理'),
      subGroups: [
        {
          label: t('users.用户与角色'),
          codes: [
            'system.users',
            'system.users.view',
            'system.users.create',
            'system.users.edit',
            'system.users.delete',
            'system.users.assign_role',
          ],
        },
        {
          label: t('users.项目通用'),
          codes: ['project.manage', 'project.view'],
        },
      ],
    },
  ];
}

function getAllGroupedCodes(permissionGroups: PermissionNavGroup[]): string[] {
  return permissionGroups.flatMap((g) => g.subGroups.flatMap((sg) => sg.codes));
}

function getPageAccessLabels(
  t: (key: string) => string,
): Record<string, string> {
  return {
    'conversation.view': t('users.聊天 / 对话'),
    'project.view': t('users.任务 / 应用 / 股票'),
    'review.view': t('users.审查'),
    'system.settings': t('users.系统配置 / 终端'),
    'channel.view': t('users.频道配置'),
    'system.users': t('users.用户管理'),
    'live2d.view': t('users.Live2D 设置'),
    'assistant.manage': t('users.助手配置'),
    'soul.view': t('users.AI 灵魂'),
    'system.providers': 'Provider',
  };
}

function getAccessiblePages(
  codes: string[],
  t: (key: string) => string,
): string[] {
  const pages: string[] = [];
  const codeSet = new Set(codes);
  const labels = getPageAccessLabels(t);
  for (const [code, label] of Object.entries(labels)) {
    if (codeSet.has(code)) pages.push(label);
  }
  return pages;
}

interface UserFormState {
  username: string;
  password: string;
  displayName: string;
  email: string;
  status: 'active' | 'disabled';
  roleIds: string[];
}

interface NoticeState {
  tone: NoticeTone;
  text: string;
}

const PAGE_SIZE = 10;

function getStatusFilterOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'all', label: t('users.全部状态') },
    { value: 'active', label: t('users.启用中') },
    { value: 'disabled', label: t('users.已停用') },
  ];
}

function createEmptyForm(): UserFormState {
  return {
    username: '',
    password: '',
    displayName: '',
    email: '',
    status: 'active',
    roleIds: [],
  };
}

function buildEditForm(user: UserSummary, roles: RoleRecord[]): UserFormState {
  const roleIds = user.roles
    .map((roleName) => roles.find((role) => role.name === roleName)?.id || '')
    .filter(Boolean);

  return {
    username: user.username,
    password: '',
    displayName: user.displayName || '',
    email: user.email || '',
    status: user.status === 'disabled' ? 'disabled' : 'active',
    roleIds,
  };
}

function normalizeUser(value: unknown): UserSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const username = typeof record.username === 'string' ? record.username : '';
  if (!id || !username) return null;
  return {
    id,
    username,
    displayName:
      typeof record.displayName === 'string'
        ? record.displayName
        : typeof record.display_name === 'string'
          ? record.display_name
          : null,
    email:
      typeof record.email === 'string' && record.email.trim()
        ? record.email
        : null,
    status: record.status === 'disabled' ? 'disabled' : 'active',
    roles: Array.isArray(record.roles)
      ? record.roles.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    createdAt:
      typeof record.createdAt === 'string'
        ? record.createdAt
        : typeof record.created_at === 'string'
          ? record.created_at
          : '',
  };
}

function normalizeRole(value: unknown): RoleRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (!id || !name) return null;
  return {
    id,
    name,
    description:
      typeof record.description === 'string' ? record.description : null,
    permissionCodes: Array.isArray(record.permissionCodes)
      ? record.permissionCodes.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

function formatCreatedAt(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getUserSecondaryText(user: UserSummary, fallback: string): string {
  return user.displayName || user.email || fallback;
}

async function requestJson<T>(
  apiBase: string,
  path: string,
  init?: RequestInit,
  fallbackError?: string,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: init?.credentials ?? 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload && payload.ok === false)) {
    const message =
      payload && typeof payload.error === 'string'
        ? payload.error
        : fallbackError || `请求失败: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function getAvailableRoles(
  form: UserFormState,
  roles: RoleRecord[],
): RoleRecord[] {
  const selectedIds = new Set(form.roleIds);
  return roles.filter((role) => !selectedIds.has(role.id));
}

function getFormRoleNames(
  form: UserFormState,
  roleById: Map<string, RoleRecord>,
): string[] {
  return form.roleIds
    .map((roleId) => roleById.get(roleId)?.name || '')
    .filter(Boolean);
}

export function UsersPage({ apiBase }: UsersPageProps) {
  const { t } = useTranslation('users');
  const [activeTab, setActiveTab] = useNavigatedTab<UsersTab>(
    'users',
    VALID_USERS_TABS,
    'users',
  );
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [paneMode, setPaneMode] = useState<UsersPaneMode>('empty');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [createForm, setCreateForm] = useState<UserFormState>(createEmptyForm);
  const [editForm, setEditForm] = useState<UserFormState>(createEmptyForm);
  const [createRoleDraft, setCreateRoleDraft] = useState('');
  const [editRoleDraft, setEditRoleDraft] = useState('');

  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRolePerms, setEditingRolePerms] = useState<string[]>([]);
  const [savingRolePerms, setSavingRolePerms] = useState(false);
  const [creatingRole, setCreatingRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [savingNewRole, setSavingNewRole] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleExpandedSections, setRoleExpandedSections] = useState<Set<string>>(
    () => new Set(),
  );

  const [repositories, setRepositories] = useState<RepoRecord[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [repoMembers, setRepoMembers] = useState<RepoMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addMemberUserId, setAddMemberUserId] = useState('');
  const [addMemberLevel, setAddMemberLevel] = useState('viewer');

  const statusFilterOptions = useMemo(() => getStatusFilterOptions(t), [t]);
  const accessLevelOptions = useMemo(() => getAccessLevelOptions(t), [t]);
  const accessLevelLabels = useMemo(() => getAccessLevelLabels(t), [t]);
  const permissionGroups = useMemo(() => getPermissionGroups(t), [t]);
  const allGroupedCodes = useMemo(
    () => getAllGroupedCodes(permissionGroups),
    [permissionGroups],
  );

  const requestJsonT = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      return requestJson<T>(apiBase, path, init, t('users.请求失败'));
    },
    [apiBase, t],
  );

  const loadUsers = useCallback(async () => {
    const payload = await requestJsonT<{ users?: unknown[] }>('/api/users');
    return Array.isArray(payload.users)
      ? payload.users
          .map(normalizeUser)
          .filter((entry): entry is UserSummary => Boolean(entry))
      : [];
  }, [requestJsonT]);

  const loadRoles = useCallback(async () => {
    const payload = await requestJsonT<{ roles?: unknown[] }>('/api/roles');
    return Array.isArray(payload.roles)
      ? payload.roles
          .map(normalizeRole)
          .filter((entry): entry is RoleRecord => Boolean(entry))
      : [];
  }, [requestJsonT]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const [nextUsers, nextRoles] = await Promise.all([
          loadUsers(),
          loadRoles(),
        ]);
        if (cancelled) return;
        setUsers(nextUsers);
        setRoles(nextRoles);
        setPaneMode(nextUsers.length > 0 ? 'detail' : 'empty');
        if (nextRoles.length > 0 && !selectedRoleId) {
          setSelectedRoleId(nextRoles[0].id);
        }
        setNotice(null);
      } catch (error) {
        if (cancelled) return;
        setNotice({
          tone: 'error',
          text:
            error instanceof Error
              ? error.message
              : t('users.加载用户数据失败'),
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [loadRoles, loadUsers, t, selectedRoleId]);

  const roleById = useMemo(
    () => new Map(roles.map((role) => [role.id, role])),
    [roles],
  );

  const roleByName = useMemo(
    () => new Map(roles.map((role) => [role.name, role])),
    [roles],
  );

  const roleFilterOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: 'all', label: t('users.全部角色') },
      ...roles.map((role) => ({ value: role.name, label: role.name })),
    ],
    [roles, t],
  );

  const filteredUsers = useMemo(
    () =>
      filterUsers({
        users,
        searchQuery,
        statusFilter,
        roleFilter,
      }),
    [users, searchQuery, statusFilter, roleFilter],
  );

  const pagination = useMemo(
    () => paginateUsers(filteredUsers, currentPage, PAGE_SIZE),
    [filteredUsers, currentPage],
  );

  useEffect(() => {
    if (pagination.page !== currentPage) {
      setCurrentPage(pagination.page);
    }
  }, [currentPage, pagination.page]);

  useEffect(() => {
    if (paneMode === 'create') return;
    const nextSelectedId = resolveSelectedUserId(filteredUsers, selectedUserId);
    if (nextSelectedId !== selectedUserId) {
      setSelectedUserId(nextSelectedId);
    }
    if (!nextSelectedId && paneMode !== 'empty') {
      setPaneMode('empty');
    }
    if (nextSelectedId && paneMode === 'empty') {
      setPaneMode('detail');
    }
  }, [filteredUsers, paneMode, selectedUserId]);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || null,
    [selectedUserId, users],
  );

  useEffect(() => {
    if (!selectedUser || paneMode === 'create') return;
    setEditForm(buildEditForm(selectedUser, roles));
  }, [paneMode, roles, selectedUser]);

  const createAvailableRoles = useMemo(
    () => getAvailableRoles(createForm, roles),
    [createForm, roles],
  );

  const editAvailableRoles = useMemo(
    () => getAvailableRoles(editForm, roles),
    [editForm, roles],
  );

  const selectedUserRoles = useMemo(
    () =>
      selectedUser
        ? selectedUser.roles.map(
            (name) =>
              roleByName.get(name) || { id: name, name, description: null },
          )
        : [],
    [roleByName, selectedUser],
  );

  const handleSelectUser = (userId: string) => {
    setSelectedUserId(userId);
    setPaneMode('detail');
    setNotice(null);
  };

  const usersTabItems = useMemo(
    () => [
      { key: 'users' as const, label: t('users.用户管理') },
      { key: 'roles' as const, label: t('users.角色权限') },
      { key: 'repo-access' as const, label: t('users.仓库访问') },
      {
        key: 'permission-overrides' as const,
        label: t('users.权限覆盖'),
      },
    ],
    [t],
  );

  const openCreatePane = () => {
    setCreateForm(createEmptyForm());
    setCreateRoleDraft('');
    setPaneMode('create');
    setNotice(null);
  };

  const openEditPane = () => {
    if (!selectedUser) return;
    setEditForm(buildEditForm(selectedUser, roles));
    setEditRoleDraft('');
    setPaneMode('edit');
    setNotice(null);
  };

  const reloadUsers = useCallback(
    async (preferredUserId?: string | null) => {
      const nextUsers = await loadUsers();
      setUsers(nextUsers);
      const nextSelectedId =
        preferredUserId ?? resolveSelectedUserId(nextUsers, selectedUserId);
      setSelectedUserId(nextSelectedId);
      return nextUsers;
    },
    [loadUsers, selectedUserId],
  );

  const handleCreate = async () => {
    const username = createForm.username.trim();
    if (!username) {
      setNotice({ tone: 'error', text: t('users.用户名不能为空') });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = await requestJsonT<{ user?: unknown }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          password: createForm.password,
          displayName: createForm.displayName.trim() || null,
          email: createForm.email.trim() || null,
          roleNames: getFormRoleNames(createForm, roleById),
        }),
      });
      const createdUser = normalizeUser(payload.user);
      const createdUserId = createdUser?.id || null;
      if (createdUserId && createForm.status === 'disabled') {
        await requestJsonT(`/api/users/${createdUserId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'disabled' }),
        });
      }
      setSearchQuery('');
      setStatusFilter('all');
      setRoleFilter('all');
      setCurrentPage(1);
      await reloadUsers(createdUserId);
      setPaneMode('detail');
      setCreateForm(createEmptyForm());
      setNotice({ tone: 'success', text: t('users.用户已创建') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('users.创建用户失败'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = async () => {
    if (!selectedUser) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await requestJsonT(`/api/users/${selectedUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          displayName: editForm.displayName.trim() || null,
          email: editForm.email.trim() || null,
          password: editForm.password.trim() || undefined,
          status: editForm.status,
        }),
      });

      const currentRoleIds = new Set(
        selectedUser.roles
          .map((roleName) => roleByName.get(roleName)?.id || '')
          .filter(Boolean),
      );
      const nextRoleIds = new Set(editForm.roleIds);
      const addRoleIds = [...nextRoleIds].filter(
        (roleId) => !currentRoleIds.has(roleId),
      );
      const removeRoleIds = [...currentRoleIds].filter(
        (roleId) => !nextRoleIds.has(roleId),
      );

      await Promise.all([
        ...addRoleIds.map((roleId) =>
          requestJsonT(`/api/users/${selectedUser.id}/roles`, {
            method: 'POST',
            body: JSON.stringify({ roleId }),
          }),
        ),
        ...removeRoleIds.map((roleId) =>
          requestJsonT(`/api/users/${selectedUser.id}/roles/${roleId}`, {
            method: 'DELETE',
          }),
        ),
      ]);

      await reloadUsers(selectedUser.id);
      setPaneMode('detail');
      setNotice({ tone: 'success', text: t('users.用户信息已保存') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('users.保存用户失败'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (
      !selectedUser ||
      !window.confirm(
        t('users.确定删除用户', { username: selectedUser.username }),
      )
    ) {
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await requestJsonT(`/api/users/${selectedUser.id}`, { method: 'DELETE' });
      const nextUsers = await reloadUsers(null);
      setPaneMode(nextUsers.length > 0 ? 'detail' : 'empty');
      setNotice({ tone: 'success', text: t('users.用户已删除') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('users.删除用户失败'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const startEditingRole = (role: RoleRecord) => {
    setEditingRoleId(role.id);
    setEditingRolePerms([...(role.permissionCodes || [])]);
    setNotice(null);
  };

  const cancelEditingRole = () => {
    setEditingRoleId(null);
    setEditingRolePerms([]);
  };

  const togglePermission = (code: string) => {
    setEditingRolePerms((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const saveRolePermissions = async () => {
    if (!editingRoleId) return;
    setSavingRolePerms(true);
    setNotice(null);
    try {
      await requestJsonT(`/api/roles/${editingRoleId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionCodes: editingRolePerms }),
      });
      const nextRoles = await loadRoles();
      setRoles(nextRoles);
      setEditingRoleId(null);
      setEditingRolePerms([]);
      setNotice({ tone: 'success', text: t('users.角色权限已更新') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof Error ? error.message : t('users.更新角色权限失败'),
      });
    } finally {
      setSavingRolePerms(false);
    }
  };

  const loadRepositories = useCallback(async () => {
    try {
      const payload = await requestJsonT<{ repositories?: unknown[] }>(
        '/api/repo-reviews/repositories',
      );
      const repos = Array.isArray(payload.repositories)
        ? payload.repositories
            .map(normalizeRepo)
            .filter((r): r is RepoRecord => r !== null)
        : [];
      setRepositories(repos);
      if (repos.length > 0 && !selectedRepoId) {
        setSelectedRepoId(repos[0].id);
      }
    } catch {
      setRepositories([]);
    }
  }, [requestJsonT, selectedRepoId]);

  const loadRepoMembers = useCallback(
    async (repoId: string) => {
      setMembersLoading(true);
      try {
        const payload = await requestJsonT<{ members?: unknown[] }>(
          `/api/repo-reviews/repositories/${encodeURIComponent(repoId)}/members`,
        );
        const members = Array.isArray(payload.members)
          ? payload.members
              .map(normalizeMember)
              .filter((m): m is RepoMember => m !== null)
          : [];
        setRepoMembers(members);
      } catch {
        setRepoMembers([]);
      } finally {
        setMembersLoading(false);
      }
    },
    [requestJsonT],
  );

  useEffect(() => {
    if (activeTab === 'repo-access') {
      void loadRepositories();
    }
  }, [activeTab, loadRepositories]);

  useEffect(() => {
    if (selectedRepoId && activeTab === 'repo-access') {
      void loadRepoMembers(selectedRepoId);
    }
  }, [selectedRepoId, activeTab, loadRepoMembers]);

  const handleAddMember = async () => {
    if (!selectedRepoId || !addMemberUserId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await requestJsonT(
        `/api/repo-reviews/repositories/${encodeURIComponent(selectedRepoId)}/members`,
        {
          method: 'POST',
          body: JSON.stringify({
            userId: addMemberUserId,
            accessLevel: addMemberLevel,
          }),
        },
      );
      setAddMemberUserId('');
      setAddMemberLevel('viewer');
      await loadRepoMembers(selectedRepoId);
      setNotice({ tone: 'success', text: t('users.成员已添加') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('users.添加成员失败'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedRepoId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await requestJsonT(
        `/api/repo-reviews/repositories/${encodeURIComponent(selectedRepoId)}/members/${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      );
      await loadRepoMembers(selectedRepoId);
      setNotice({ tone: 'success', text: t('users.成员已移除') });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : t('users.移除成员失败'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const repoSelectOptions = useMemo<AppSelectOption[]>(
    () => repositories.map((r) => ({ value: r.id, label: r.name })),
    [repositories],
  );

  const availableMemberUsers = useMemo(() => {
    const memberIds = new Set(repoMembers.map((m) => m.user_id));
    return users.filter((u) => !memberIds.has(u.id));
  }, [users, repoMembers]);

  const memberUserOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: '', label: t('users.选择用户') },
      ...availableMemberUsers.map((u) => ({
        value: u.id,
        label: u.displayName ? `${u.username} (${u.displayName})` : u.username,
      })),
    ],
    [availableMemberUsers, t],
  );

  const findUserName = useCallback(
    (userId: string) => {
      const u = users.find((user) => user.id === userId);
      return u
        ? u.displayName
          ? `${u.username} (${u.displayName})`
          : u.username
        : userId;
    },
    [users],
  );

  return (
    <div className="page-view users-page">
      <div className="page-header users-hero">
        <div className="page-header-copy">
          <h2>{t('users.用户')}</h2>
          <p>{t('users.管理用户账号、角色权限配置和审查仓库访问控制')}</p>
        </div>
        <div className="page-header-actions users-hero-actions">
          <div className="users-hero-chip">
            <span>{t('users.用户')}</span>
            <strong>{users.length}</strong>
          </div>
          <div className="users-hero-chip">
            <span>{t('users.角色')}</span>
            <strong>{roles.length}</strong>
          </div>
          <div className="users-hero-chip">
            <span>{t('users.仓库')}</span>
            <strong>{repositories.length}</strong>
          </div>
          {activeTab === 'users' && (
            <button
              type="button"
              className="btn-primary"
              onClick={openCreatePane}
            >
              {t('users.新增用户')}
            </button>
          )}
        </div>
      </div>

      <div
        className="users-tab-bar"
        role="tablist"
        aria-label={t('users.用户')}
      >
        <SectionNav
          className="users-section-nav"
          ariaLabel={t('users.用户')}
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as UsersTab)}
          orientation="horizontal"
          items={usersTabItems.map((item) => ({
            key: item.key,
            label: item.label,
          }))}
        />
      </div>

      {activeTab === 'users' && (
        <div className="page-body users-page-body">
          <div className="users-workbench">
            <aside className="users-sidebar assistant-selector-panel assistant-selector-panel--summary">
              <div className="assistant-form-section">
                <div className="assistant-form-section-header">
                  <h4>{t('users.用户列表')}</h4>
                  <p>{t('users.直接分页浏览即可，查询时再用筛选收窄范围')}</p>
                </div>
                <div className="assistant-selector-grid users-filter-grid">
                  <label className="assistant-selector-field assistant-selector-field--wide">
                    <span>{t('users.搜索')}</span>
                    <input
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setCurrentPage(1);
                      }}
                      placeholder={t('users.按用户名、展示名或邮箱搜索')}
                    />
                  </label>
                  <label className="assistant-selector-field">
                    <span>{t('users.状态')}</span>
                    <AppSelect
                      value={statusFilter}
                      onChange={setStatusFilter}
                      options={statusFilterOptions}
                    />
                  </label>
                  <label className="assistant-selector-field">
                    <span>{t('users.角色')}</span>
                    <AppSelect
                      value={roleFilter}
                      onChange={setRoleFilter}
                      options={roleFilterOptions}
                    />
                  </label>
                </div>
              </div>

              <div className="users-list">
                {loading ? (
                  <div className="assistant-card-note">
                    {t('users.加载用户中')}
                  </div>
                ) : null}
                {!loading && users.length === 0 ? (
                  <div className="assistant-empty-state users-empty-state">
                    <h3>{t('users.还没有用户')}</h3>
                    <p>
                      {t(
                        'users.创建第一个账号后，右侧会显示详情和角色维护入口',
                      )}
                    </p>
                  </div>
                ) : null}
                {!loading && users.length > 0 && filteredUsers.length === 0 ? (
                  <div className="assistant-empty-state users-empty-state">
                    <h3>{t('users.没有匹配结果')}</h3>
                    <p>
                      {t(
                        'users.当前筛选条件下没有找到用户，调整搜索词或筛选项即可',
                      )}
                    </p>
                  </div>
                ) : null}
                {pagination.items.map((user) => {
                  const roleSummary = buildRoleSummary(user.roles);
                  const isActive =
                    paneMode !== 'create' && user.id === selectedUserId;
                  return (
                    <button
                      key={user.id}
                      type="button"
                      className={`repo-review-repository-item users-list-item ${isActive ? 'active' : ''}`}
                      onClick={() => handleSelectUser(user.id)}
                    >
                      <div className="users-list-item-topline assistant-card-topline">
                        <strong>{user.username}</strong>
                        <span
                          className={`users-status-badge ${user.status === 'disabled' ? 'is-disabled' : 'is-active'}`}
                        >
                          {user.status === 'disabled'
                            ? t('users.已停用')
                            : t('users.启用中')}
                        </span>
                      </div>
                      <span className="users-list-item-meta">
                        {getUserSecondaryText(
                          user,
                          t('users.未填写展示名和邮箱'),
                        )}
                      </span>
                      <span className="users-role-summary">
                        <span>{roleSummary.label}</span>
                        <span>
                          {t('users.创建于')} {formatCreatedAt(user.createdAt)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {filteredUsers.length > 0 ? (
                <div className="users-pagination">
                  <span className="users-inline-note">
                    {t('users.分页信息', {
                      page: pagination.page,
                      totalPages: pagination.totalPages,
                      total: pagination.total,
                    })}
                  </span>
                  <div className="assistant-button-row">
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() =>
                        setCurrentPage((page) => Math.max(1, page - 1))
                      }
                      disabled={pagination.page <= 1}
                    >
                      {t('users.上一页')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() =>
                        setCurrentPage((page) =>
                          Math.min(pagination.totalPages, page + 1),
                        )
                      }
                      disabled={pagination.page >= pagination.totalPages}
                    >
                      {t('users.下一页')}
                    </button>
                  </div>
                </div>
              ) : null}
            </aside>

            <section className="users-detail-pane assistant-selector-panel">
              {notice ? (
                <div
                  className={`users-message ${notice.tone === 'error' ? 'is-error' : 'is-success'}`}
                >
                  {notice.text}
                </div>
              ) : null}

              {paneMode === 'create' ? (
                <div className="users-detail-stack">
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.新增用户')}</h4>
                      <p>
                        {t(
                          'users.创建后仍停留在当前工作台，不再打断左侧浏览流',
                        )}
                      </p>
                    </div>
                    <div className="users-form-grid">
                      <label className="users-form-field">
                        <span>{t('users.用户名')}</span>
                        <input
                          value={createForm.username}
                          onChange={(event) =>
                            setCreateForm((prev) => ({
                              ...prev,
                              username: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.初始密码')}</span>
                        <input
                          type="password"
                          value={createForm.password}
                          onChange={(event) =>
                            setCreateForm((prev) => ({
                              ...prev,
                              password: event.target.value,
                            }))
                          }
                          placeholder={t('users.留空则使用默认密码')}
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.展示名')}</span>
                        <input
                          value={createForm.displayName}
                          onChange={(event) =>
                            setCreateForm((prev) => ({
                              ...prev,
                              displayName: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.邮箱')}</span>
                        <input
                          value={createForm.email}
                          onChange={(event) =>
                            setCreateForm((prev) => ({
                              ...prev,
                              email: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.状态')}</span>
                        <AppSelect
                          value={createForm.status}
                          onChange={(value) =>
                            setCreateForm((prev) => ({
                              ...prev,
                              status:
                                value === 'disabled' ? 'disabled' : 'active',
                            }))
                          }
                          options={statusFilterOptions.slice(1)}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.初始角色')}</h4>
                      <p>
                        {t('users.先加必需角色，更多权限仍可在详情页继续补齐')}
                      </p>
                    </div>
                    <div className="assistant-chip-row users-role-list">
                      {createForm.roleIds.length === 0 ? (
                        <span className="assistant-mini-chip users-role-chip-overflow">
                          {t('users.暂未分配角色')}
                        </span>
                      ) : null}
                      {createForm.roleIds.map((roleId) => (
                        <span
                          key={roleId}
                          className="assistant-mini-chip users-role-chip"
                        >
                          {roleById.get(roleId)?.name || roleId}
                          <button
                            type="button"
                            className="users-role-chip-remove"
                            onClick={() =>
                              setCreateForm((prev) => ({
                                ...prev,
                                roleIds: prev.roleIds.filter(
                                  (entry) => entry !== roleId,
                                ),
                              }))
                            }
                          >
                            {t('users.移除')}
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="assistant-button-row users-role-adder">
                      <AppSelect
                        value={createRoleDraft}
                        onChange={setCreateRoleDraft}
                        options={[
                          { value: '', label: t('users.选择要新增的角色') },
                          ...createAvailableRoles.map((role) => ({
                            value: role.id,
                            label: role.name,
                          })),
                        ]}
                      />
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={!createRoleDraft}
                        onClick={() => {
                          setCreateForm((prev) => ({
                            ...prev,
                            roleIds: [...prev.roleIds, createRoleDraft],
                          }));
                          setCreateRoleDraft('');
                        }}
                      >
                        {t('users.新增角色')}
                      </button>
                    </div>
                    {createForm.roleIds.length > 0
                      ? (() => {
                          const allCodes = [
                            ...new Set(
                              createForm.roleIds.flatMap(
                                (rid) =>
                                  roleById.get(rid)?.permissionCodes || [],
                              ),
                            ),
                          ];
                          const pages = getAccessiblePages(allCodes, t);
                          return pages.length > 0 ? (
                            <div className="users-page-access-preview">
                              <strong>{t('users.页面访问预览')}:</strong>{' '}
                              {pages.join(' · ')}
                            </div>
                          ) : null;
                        })()
                      : null}
                  </div>
                  <div className="assistant-button-row users-pane-actions">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() =>
                        setPaneMode(selectedUser ? 'detail' : 'empty')
                      }
                      disabled={submitting}
                    >
                      {t('users.取消')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void handleCreate()}
                      disabled={submitting}
                    >
                      {submitting ? t('users.新增中') : t('users.新增')}
                    </button>
                  </div>
                </div>
              ) : null}

              {paneMode !== 'create' && !selectedUser ? (
                <div className="assistant-empty-state users-empty-state">
                  <h3>{t('users.选择一个用户')}</h3>
                  <p>
                    {t('users.左侧选中账号后，这里会展示详情、角色和编辑入口')}
                  </p>
                </div>
              ) : null}

              {paneMode === 'detail' && selectedUser ? (
                <div className="users-detail-stack">
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{selectedUser.username}</h4>
                      <p>
                        {t('users.以详情为默认态，编辑只在需要修改时显式进入')}
                      </p>
                    </div>
                    <div className="users-detail-grid assistant-card-summary-grid">
                      <div>
                        <dt>{t('users.展示名')}</dt>
                        <dd>{selectedUser.displayName || '-'}</dd>
                      </div>
                      <div>
                        <dt>{t('users.邮箱')}</dt>
                        <dd>{selectedUser.email || '-'}</dd>
                      </div>
                      <div>
                        <dt>{t('users.创建时间')}</dt>
                        <dd>{formatCreatedAt(selectedUser.createdAt)}</dd>
                      </div>
                      <div>
                        <dt>{t('users.当前状态')}</dt>
                        <dd>
                          {selectedUser.status === 'disabled'
                            ? t('users.已停用')
                            : t('users.启用中')}
                        </dd>
                      </div>
                    </div>
                  </div>
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.角色')}</h4>
                      <p>
                        {t(
                          'users.角色维护放在当前用户上下文里，不再混到左侧列表',
                        )}
                      </p>
                    </div>
                    <div className="assistant-chip-row users-role-list">
                      {selectedUserRoles.length === 0 ? (
                        <span className="assistant-mini-chip users-role-chip-overflow">
                          {t('users.暂无角色')}
                        </span>
                      ) : null}
                      {selectedUserRoles.map((role) => (
                        <span
                          key={role.id}
                          className="assistant-mini-chip users-role-chip"
                        >
                          {getRoleDisplayName(t, role.name)}
                        </span>
                      ))}
                    </div>
                    <div className="users-role-description-list">
                      {selectedUserRoles.map((role) => {
                        const codes = role.permissionCodes || [];
                        const pages = getAccessiblePages(codes, t);
                        return (
                          <div
                            key={`${role.id}-description`}
                            className="users-role-description-item"
                          >
                            <strong>{getRoleDisplayName(t, role.name)}</strong>
                            <span>{getRoleDescription(t, role)}</span>
                            {codes.length > 0 ? (
                              <div className="users-role-detail-meta">
                                <div className="users-role-perm-line">
                                  {t('users.权限码')}:{' '}
                                  {codes
                                    .map((c) => getPermissionLabel(t, c))
                                    .join(' · ')}
                                </div>
                                {pages.length > 0 ? (
                                  <div className="users-role-pages-line">
                                    {t('users.可访问页面')}: {pages.join(' · ')}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="assistant-form-section users-danger-zone">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.操作')}</h4>
                      <p>
                        {t(
                          'users.编辑和删除都收敛在右侧，避免误操作影响列表浏览',
                        )}
                      </p>
                    </div>
                    <div className="assistant-button-row users-pane-actions">
                      <button
                        type="button"
                        className="btn-outline"
                        onClick={openEditPane}
                      >
                        {t('users.编辑用户')}
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => void handleDelete()}
                        disabled={submitting}
                      >
                        {submitting ? t('users.删除中') : t('users.删除用户')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {paneMode === 'edit' && selectedUser ? (
                <div className="users-detail-stack">
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.编辑用户')}</h4>
                      <p>{t('users.保留对象上下文，只修改必要字段')}</p>
                    </div>
                    <div className="users-form-grid">
                      <label className="users-form-field">
                        <span>{t('users.用户名')}</span>
                        <input value={editForm.username} disabled />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.新密码')}</span>
                        <input
                          type="password"
                          value={editForm.password}
                          onChange={(event) =>
                            setEditForm((prev) => ({
                              ...prev,
                              password: event.target.value,
                            }))
                          }
                          placeholder={t('users.留空则保持不变')}
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.展示名')}</span>
                        <input
                          value={editForm.displayName}
                          onChange={(event) =>
                            setEditForm((prev) => ({
                              ...prev,
                              displayName: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.邮箱')}</span>
                        <input
                          value={editForm.email}
                          onChange={(event) =>
                            setEditForm((prev) => ({
                              ...prev,
                              email: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="users-form-field">
                        <span>{t('users.状态')}</span>
                        <AppSelect
                          value={editForm.status}
                          onChange={(value) =>
                            setEditForm((prev) => ({
                              ...prev,
                              status:
                                value === 'disabled' ? 'disabled' : 'active',
                            }))
                          }
                          options={statusFilterOptions.slice(1)}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.角色管理')}</h4>
                      <p>{t('users.仅展示可新增角色，已选角色可直接移除')}</p>
                    </div>
                    <div className="assistant-chip-row users-role-list">
                      {editForm.roleIds.length === 0 ? (
                        <span className="assistant-mini-chip users-role-chip-overflow">
                          {t('users.暂无角色')}
                        </span>
                      ) : null}
                      {editForm.roleIds.map((roleId) => (
                        <span
                          key={roleId}
                          className="assistant-mini-chip users-role-chip"
                        >
                          {getRoleDisplayName(
                            t,
                            roleById.get(roleId)?.name || roleId,
                          )}
                          <button
                            type="button"
                            className="users-role-chip-remove"
                            onClick={() =>
                              setEditForm((prev) => ({
                                ...prev,
                                roleIds: prev.roleIds.filter(
                                  (entry) => entry !== roleId,
                                ),
                              }))
                            }
                          >
                            {t('users.移除')}
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="assistant-button-row users-role-adder">
                      <AppSelect
                        value={editRoleDraft}
                        onChange={setEditRoleDraft}
                        options={[
                          { value: '', label: t('users.选择要新增的角色') },
                          ...editAvailableRoles.map((role) => ({
                            value: role.id,
                            label: getRoleDisplayName(t, role.name),
                          })),
                        ]}
                      />
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={!editRoleDraft}
                        onClick={() => {
                          setEditForm((prev) => ({
                            ...prev,
                            roleIds: [...prev.roleIds, editRoleDraft],
                          }));
                          setEditRoleDraft('');
                        }}
                      >
                        {t('users.新增角色')}
                      </button>
                    </div>
                    {editForm.roleIds.length > 0
                      ? (() => {
                          const allCodes = [
                            ...new Set(
                              editForm.roleIds.flatMap(
                                (rid) =>
                                  roleById.get(rid)?.permissionCodes || [],
                              ),
                            ),
                          ];
                          const pages = getAccessiblePages(allCodes, t);
                          return pages.length > 0 ? (
                            <div className="users-page-access-preview">
                              <strong>{t('users.页面访问预览')}:</strong>{' '}
                              {pages.join(' · ')}
                            </div>
                          ) : null;
                        })()
                      : null}
                  </div>
                  <div className="assistant-button-row users-pane-actions">
                    <button
                      type="button"
                      className="btn-outline"
                      onClick={() => setPaneMode('detail')}
                      disabled={submitting}
                    >
                      {t('users.取消')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void handleSave()}
                      disabled={submitting}
                    >
                      {submitting ? t('users.保存中') : t('users.保存修改')}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      )}

      {activeTab === 'roles' &&
        (() => {
          const activeRole = roles.find((r) => r.id === selectedRoleId) || null;
          const isEditing =
            editingRoleId !== null && editingRoleId === selectedRoleId;
          const activeCodes = isEditing
            ? editingRolePerms
            : activeRole?.permissionCodes || [];
          const totalPermCount = allGroupedCodes.length;

          const toggleSection = (key: string) => {
            setRoleExpandedSections((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          };

          const toggleGroupAllCodes = (codes: string[]) => {
            const allChecked = codes.every((c) => editingRolePerms.includes(c));
            if (allChecked) {
              setEditingRolePerms((prev) =>
                prev.filter((c) => !codes.includes(c)),
              );
            } else {
              setEditingRolePerms((prev) => [...new Set([...prev, ...codes])]);
            }
          };

          return (
            <div className="page-body users-page-body">
              <div className="users-workbench">
                <aside className="users-sidebar assistant-selector-panel assistant-selector-panel--summary">
                  <div className="assistant-form-section">
                    <div className="assistant-form-section-header">
                      <h4>{t('users.角色列表')}</h4>
                      <p>{t('users.选择一个角色查看和编辑其权限配置')}</p>
                    </div>
                    <div className="users-role-create-toolbar">
                      {!creatingRole ? (
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          onClick={() => setCreatingRole(true)}
                        >
                          + {t('users.新建角色')}
                        </button>
                      ) : (
                        <div className="users-role-create-panel">
                          <div className="form-group">
                            <label>{t('users.角色名称')}</label>
                            <input
                              type="text"
                              placeholder={t('users.例如: editor')}
                              value={newRoleName}
                              onChange={(e) => setNewRoleName(e.target.value)}
                              autoFocus
                            />
                          </div>
                          <div className="form-group">
                            <label>{t('users.描述')}</label>
                            <input
                              type="text"
                              placeholder={t('users.例如: 内容编辑员')}
                              value={newRoleDesc}
                              onChange={(e) => setNewRoleDesc(e.target.value)}
                            />
                          </div>
                          <div className="assistant-button-row">
                            <button
                              type="button"
                              className="btn-outline btn-sm"
                              onClick={() => {
                                setCreatingRole(false);
                                setNewRoleName('');
                                setNewRoleDesc('');
                              }}
                              disabled={savingNewRole}
                            >
                              {t('users.取消')}
                            </button>
                            <button
                              type="button"
                              className="btn-primary btn-sm"
                              disabled={savingNewRole || !newRoleName.trim()}
                              onClick={async () => {
                                setSavingNewRole(true);
                                try {
                                  const res = await fetch('/api/roles', {
                                    method: 'POST',
                                    headers: {
                                      'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                      name: newRoleName.trim(),
                                      description: newRoleDesc,
                                    }),
                                  });
                                  const data = await res.json();
                                  if (!res.ok) {
                                    setNotice({
                                      text: data.error || t('users.创建失败'),
                                      tone: 'error',
                                    });
                                    return;
                                  }
                                  setNotice({
                                    text: t('users.角色已创建', {
                                      name: newRoleName.trim(),
                                    }),
                                    tone: 'success',
                                  });
                                  setCreatingRole(false);
                                  setNewRoleName('');
                                  setNewRoleDesc('');
                                  const nextRoles = await loadRoles();
                                  setRoles(nextRoles);
                                } catch {
                                  setNotice({
                                    text: t('users.网络错误'),
                                    tone: 'error',
                                  });
                                } finally {
                                  setSavingNewRole(false);
                                }
                              }}
                            >
                              {savingNewRole
                                ? t('users.新增中')
                                : t('users.新增')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="users-list">
                    {roles.map((role) => {
                      const permCount = (role.permissionCodes || []).length;
                      const isActive = role.id === selectedRoleId;
                      return (
                        <button
                          key={role.id}
                          type="button"
                          className={`repo-review-repository-item users-list-item ${isActive ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedRoleId(role.id);
                            if (editingRoleId && editingRoleId !== role.id)
                              cancelEditingRole();
                            setRoleExpandedSections(new Set());
                          }}
                        >
                          <div className="users-list-item-topline assistant-card-topline">
                            <strong>{getRoleDisplayName(t, role.name)}</strong>
                            <span className="users-perm-code users-role-perm-ratio">
                              {permCount}/{totalPermCount}
                            </span>
                          </div>
                          <span className="users-list-item-meta">
                            {getRoleDescription(t, role)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <section className="users-detail-pane assistant-selector-panel">
                  {notice ? (
                    <div
                      className={`users-message ${notice.tone === 'error' ? 'is-error' : 'is-success'}`}
                    >
                      {notice.text}
                    </div>
                  ) : null}

                  {!activeRole ? (
                    <div className="assistant-empty-state users-empty-state">
                      <h3>{t('users.选择一个角色')}</h3>
                      <p>
                        {t('users.左侧选中角色后，这里会展示该角色的权限详情')}
                      </p>
                    </div>
                  ) : (
                    <div className="users-detail-stack">
                      <div className="assistant-form-section">
                        <div className="assistant-form-section-header">
                          <h4>{getRoleDisplayName(t, activeRole.name)}</h4>
                          <p>{getRoleDescription(t, activeRole)}</p>
                        </div>
                        <div className="assistant-button-row users-role-edit-actions">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                className="btn-outline btn-sm"
                                onClick={cancelEditingRole}
                                disabled={savingRolePerms}
                              >
                                {t('users.取消')}
                              </button>
                              <button
                                type="button"
                                className="btn-primary btn-sm"
                                onClick={() => void saveRolePermissions()}
                                disabled={savingRolePerms}
                              >
                                {savingRolePerms
                                  ? t('users.保存中')
                                  : t('users.保存修改')}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-outline btn-sm"
                              onClick={() => startEditingRole(activeRole)}
                            >
                              {t('users.编辑权限')}
                            </button>
                          )}
                        </div>
                        <div className="users-perm-summary-line">
                          {t('users.已授权项权限', {
                            count: activeCodes.length,
                            total: totalPermCount,
                          })}
                        </div>
                      </div>

                      {permissionGroups.map((group) => {
                        const sectionKey = group.section;
                        const expanded = roleExpandedSections.has(sectionKey);
                        const sectionCodes = group.subGroups.flatMap(
                          (sg) => sg.codes,
                        );
                        const checkedCount = sectionCodes.filter((c) =>
                          activeCodes.includes(c),
                        ).length;

                        return (
                          <div
                            key={sectionKey}
                            className="assistant-form-section users-perm-nav-section"
                          >
                            <button
                              type="button"
                              className="users-perm-section-toggle"
                              onClick={() => toggleSection(sectionKey)}
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                style={{
                                  transform: expanded
                                    ? 'rotate(90deg)'
                                    : 'rotate(0)',
                                  transition: 'transform 0.15s',
                                }}
                              >
                                <polyline points="9 18 15 12 9 6" />
                              </svg>
                              <span className="users-perm-section-heading">
                                {sectionKey}
                              </span>
                              <span className="users-perm-section-meta">
                                {checkedCount}/{sectionCodes.length}
                              </span>
                            </button>

                            {expanded && (
                              <div className="users-perm-nav-body">
                                {group.subGroups.map((sub) => {
                                  const subChecked = sub.codes.filter((c) =>
                                    activeCodes.includes(c),
                                  ).length;
                                  return (
                                    <div
                                      key={sub.label}
                                      className="users-perm-sub-block"
                                    >
                                      <div className="users-perm-sub-header">
                                        {isEditing && (
                                          <input
                                            type="checkbox"
                                            checked={sub.codes.every((c) =>
                                              editingRolePerms.includes(c),
                                            )}
                                            ref={(el) => {
                                              if (el)
                                                el.indeterminate =
                                                  subChecked > 0 &&
                                                  subChecked < sub.codes.length;
                                            }}
                                            onChange={() =>
                                              toggleGroupAllCodes(sub.codes)
                                            }
                                          />
                                        )}
                                        <span className="users-perm-sub-label">
                                          {sub.label}
                                        </span>
                                        <span className="users-perm-sub-meta">
                                          ({subChecked}/{sub.codes.length})
                                        </span>
                                      </div>
                                      <div className="users-role-perm-grid users-role-perm-grid--inset">
                                        {sub.codes.map((code) => {
                                          const checked =
                                            activeCodes.includes(code);
                                          return (
                                            <label
                                              key={code}
                                              className={`users-perm-item ${checked ? 'is-checked' : ''}`}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={checked}
                                                disabled={!isEditing}
                                                onChange={() =>
                                                  togglePermission(code)
                                                }
                                              />
                                              <span>
                                                {getPermissionLabel(t, code)}
                                              </span>
                                              <span className="users-perm-code">
                                                {code}
                                              </span>
                                            </label>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          );
        })()}

      {activeTab === 'repo-access' && (
        <div className="page-body">
          {notice ? (
            <div
              className={`users-message ${notice.tone === 'error' ? 'is-error' : 'is-success'}`}
            >
              {notice.text}
            </div>
          ) : null}

          <div className="users-repo-access-layout">
            <div className="assistant-form-section">
              <div className="assistant-form-section-header">
                <h4>{t('users.选择仓库')}</h4>
                <p>
                  {t(
                    'users.选中一个审查仓库后，可以管理哪些用户能查看和参与该仓库的审查',
                  )}
                </p>
              </div>
              {repositories.length === 0 ? (
                <div className="settings-hint">{t('users.暂无审查仓库')}</div>
              ) : (
                <AppSelect
                  value={selectedRepoId || ''}
                  onChange={(v) => setSelectedRepoId(v || null)}
                  options={repoSelectOptions}
                />
              )}
            </div>

            {selectedRepoId ? (
              <>
                <div className="assistant-form-section">
                  <div className="assistant-form-section-header">
                    <h4>{t('users.新增成员')}</h4>
                  </div>
                  <div className="users-repo-add-member-row">
                    <AppSelect
                      value={addMemberUserId}
                      onChange={setAddMemberUserId}
                      options={memberUserOptions}
                    />
                    <AppSelect
                      value={addMemberLevel}
                      onChange={setAddMemberLevel}
                      options={accessLevelOptions}
                    />
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      disabled={!addMemberUserId || submitting}
                      onClick={() => void handleAddMember()}
                    >
                      {t('users.新增')}
                    </button>
                  </div>
                </div>

                <div className="assistant-form-section">
                  <div className="assistant-form-section-header">
                    <h4>{t('users.当前成员')}</h4>
                    <p>
                      {membersLoading
                        ? t('users.加载中')
                        : t('users.成员数量', { count: repoMembers.length })}
                    </p>
                  </div>
                  {repoMembers.length === 0 && !membersLoading ? (
                    <div className="settings-hint">{t('users.暂无成员')}</div>
                  ) : (
                    <table className="users-perm-matrix">
                      <thead>
                        <tr>
                          <th>{t('users.用户')}</th>
                          <th>{t('users.权限级别')}</th>
                          <th>{t('users.新增时间')}</th>
                          <th>{t('users.操作')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {repoMembers.map((m) => (
                          <tr key={m.user_id}>
                            <td>{findUserName(m.user_id)}</td>
                            <td>
                              {accessLevelLabels[m.access_level] ||
                                m.access_level}
                            </td>
                            <td>{formatCreatedAt(m.granted_at)}</td>
                            <td>
                              <button
                                type="button"
                                className="btn-danger btn-sm"
                                disabled={submitting}
                                onClick={() =>
                                  void handleRemoveMember(m.user_id)
                                }
                              >
                                {t('users.移除')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {activeTab === 'permission-overrides' && (
        <PermissionOverridesPanel apiBase={apiBase} users={users} />
      )}
    </div>
  );
}

// ── Permission overrides sub-component ──

interface OverrideEntry {
  code: string;
  name: string;
  effect: string;
}

function PermissionOverridesPanel({
  apiBase,
  users,
}: {
  apiBase: string;
  users: UserSummary[];
}) {
  const { t } = useTranslation('users');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [overrides, setOverrides] = useState<OverrideEntry[]>([]);
  const [allPermissions, setAllPermissions] = useState<
    Array<{ id: string; code: string; name: string; category: string }>
  >([]);
  const [newCode, setNewCode] = useState('');
  const [newEffect, setNewEffect] = useState<'allow' | 'deny'>('allow');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/api/permissions`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.permissions)) {
          setAllPermissions(data.permissions);
        }
      })
      .catch(() => {});
  }, [apiBase]);

  const loadOverrides = useCallback(
    async (uid: string) => {
      if (!uid) {
        setOverrides([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/permission-overrides/${uid}`, {
          credentials: 'include',
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.overrides)) {
          setOverrides(data.overrides);
        } else {
          setOverrides([]);
        }
      } catch {
        setOverrides([]);
      } finally {
        setLoading(false);
      }
    },
    [apiBase],
  );

  useEffect(() => {
    setNewCode('');
    setNewEffect('allow');
    loadOverrides(selectedUserId);
  }, [selectedUserId, loadOverrides]);

  const handleGrant = useCallback(async () => {
    if (!selectedUserId || !newCode) return;
    try {
      await fetch(`${apiBase}/api/permission-overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: selectedUserId,
          permissionCode: newCode,
          effect: newEffect,
        }),
      });
      await loadOverrides(selectedUserId);
      setNewCode('');
    } catch {
      /* ignore */
    }
  }, [apiBase, selectedUserId, newCode, newEffect, loadOverrides]);

  const handleRevoke = useCallback(
    async (code: string) => {
      if (!selectedUserId) return;
      try {
        await fetch(
          `${apiBase}/api/permission-overrides/${selectedUserId}/${code}`,
          {
            method: 'DELETE',
            credentials: 'include',
          },
        );
        await loadOverrides(selectedUserId);
      } catch {
        /* ignore */
      }
    },
    [apiBase, selectedUserId, loadOverrides],
  );

  const userOptions: AppSelectOption[] = users.map((u) => ({
    value: u.id,
    label: `${u.displayName || u.username} (${u.username})`,
  }));

  const permOptions: AppSelectOption[] = allPermissions.map((p) => ({
    value: p.code,
    label: `${p.code} — ${getPermissionLabel(t, p.code)}`,
  }));

  return (
    <div className="page-body">
      <div className="users-repo-access-layout">
        <div className="assistant-form-section">
          <div className="assistant-form-section-header">
            <h4>{t('users.权限覆盖管理')}</h4>
            <p>{t('users.为指定用户直接授予或拒绝权限，优先级高于角色权限')}</p>
          </div>
          <AppSelect
            value={selectedUserId}
            onChange={(v) => setSelectedUserId(v || '')}
            options={[
              { value: '', label: t('users.选择用户占位') },
              ...userOptions,
            ]}
          />
        </div>

        {selectedUserId && (
          <>
            <div className="assistant-form-section">
              <div className="assistant-form-section-header">
                <h4>{t('users.新增权限覆盖')}</h4>
              </div>
              <div className="users-form-grid">
                <label className="users-form-field">
                  <span>{t('users.权限码')}</span>
                  <AppSelect
                    value={newCode}
                    onChange={(v) => setNewCode(v)}
                    options={[
                      { value: '', label: t('users.选择权限占位') },
                      ...permOptions,
                    ]}
                  />
                </label>
                <label className="users-form-field">
                  <span>{t('users.效果')}</span>
                  <AppSelect
                    value={newEffect}
                    onChange={(v) => setNewEffect(v as 'allow' | 'deny')}
                    options={[
                      { value: 'allow', label: t('users.允许 (allow)') },
                      { value: 'deny', label: t('users.拒绝 (deny)') },
                    ]}
                  />
                </label>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary users-overrides-grant-btn"
                onClick={handleGrant}
                disabled={!newCode}
              >
                {t('users.新增')}
              </button>
            </div>

            <div className="assistant-form-section">
              <div className="assistant-form-section-header">
                <h4>{t('users.当前覆盖')}</h4>
              </div>
              {loading ? (
                <div className="settings-hint">{t('users.加载中')}</div>
              ) : overrides.length === 0 ? (
                <div className="settings-hint">
                  {t('users.该用户暂无权限覆盖')}
                </div>
              ) : (
                <table className="users-table users-overrides-table">
                  <thead>
                    <tr>
                      <th>{t('users.权限码')}</th>
                      <th>{t('users.名称')}</th>
                      <th>{t('users.效果')}</th>
                      <th>{t('users.操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overrides.map((o) => (
                      <tr key={o.code}>
                        <td>
                          <code>{o.code}</code>
                        </td>
                        <td>{getPermissionLabel(t, o.code)}</td>
                        <td>
                          <span
                            className={
                              o.effect === 'deny'
                                ? 'users-override-effect--deny'
                                : 'users-override-effect--allow'
                            }
                          >
                            {o.effect === 'deny'
                              ? t('users.拒绝')
                              : t('users.允许')}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => handleRevoke(o.code)}
                          >
                            {t('users.移除')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
