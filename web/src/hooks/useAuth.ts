import { useCallback, useMemo } from 'react';
import type { AuthStatus, NavPage } from '../app-types';

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Page → required permission codes (OR semantics: any one suffices).
 * `null` means no permission required.
 */
export const PAGE_PERMISSION_MAP: Record<NavPage, string | string[] | null> = {
  chat: ['conversation.view'],
  companion: ['conversation.view'],
  im: ['conversation.view', 'im.view'],
  tasks: ['project.view', 'task.view'],
  repos: ['repository.view', 'review.view', 'review.repo.view'],
  reviews: ['review.view', 'review.repo.view'],
  channels: ['channel.view'],
  terminal: ['system.settings', 'terminal.access'],
  assistants: ['assistant.manage', 'assistant.view'],
  settings: ['system.settings', 'system.settings.view', 'provider.system.view', 'provider.personal.create', 'live2d.view'],
  users: ['system.users', 'system.users.view'],
  apps: ['project.view', 'mcp.view', 'skill.view', 'marketplace.view'],
  soul: ['soul.view'],
  tavern: ['soul.view'],
  knowledge: ['assistant.manage', 'knowledge.view'],
  'stock-analysis': ['project.view', 'stock.view'],
  workteam: ['project.view', 'workteam.view'],
};

/**
 * Settings tab → required permission codes (OR semantics).
 */
export const SETTINGS_TAB_PERMISSION_MAP: Record<string, string[]> = {
  providers: ['system.settings', 'provider.system.view', 'provider.personal.create'],
  channels: ['system.settings', 'channel.view'],
  prompt: ['system.settings', 'system.settings.view'],
  general: ['system.settings', 'system.settings.view'],
  knowledge: ['system.settings', 'system.settings.view'],
  browser: ['system.settings', 'system.settings.edit', 'browser.control'],
  live2d: ['live2d.view'],
  security: ['system.settings', 'system.settings.view'],
  diagnostics: ['system.settings', 'system.settings.view'],
  extensions: ['system.settings', 'mcp.view', 'skill.view'],
  subagent: ['system.settings', 'system.settings.view'],
  mcp: ['system.settings', 'mcp.view'],
  skills: ['system.settings', 'skill.view'],
  'my-providers': ['provider.personal.create', 'provider.system.view'],
  'my-channels': ['channel.own', 'channel.personal.create'],
  'web-search': ['system.settings', 'system.settings.view'],
  'ssh-keys': ['review.view', 'review.repo.view'],
};

function permissionMatchesCode(owned: string[], code: string): boolean {
  if (owned.includes(code)) return true;
  for (const p of owned) {
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1);
      if (code.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function useAuth(authStatus: AuthStatus | null) {
  const roles = useMemo(() => normalizeStringList(authStatus?.roles), [authStatus?.roles]);
  const permissions = useMemo(() => normalizeStringList(authStatus?.permissions), [authStatus?.permissions]);
  const authenticated = authStatus?.authenticated ?? false;
  const multiUserMode = authStatus?.multiUserMode ?? false;

  const hasPermission = useCallback(
    (code: string): boolean => {
      if (!authenticated) return false;
      if (!multiUserMode) return true;
      return permissionMatchesCode(permissions, code);
    },
    [authenticated, multiUserMode, permissions],
  );

  const hasAnyPermission = useCallback(
    (...codes: string[]): boolean => {
      if (!authenticated) return false;
      if (!multiUserMode) return true;
      return codes.some((c) => permissionMatchesCode(permissions, c));
    },
    [authenticated, multiUserMode, permissions],
  );

  const canAccessPage = useCallback(
    (page: NavPage): boolean => {
      const required = PAGE_PERMISSION_MAP[page];
      if (!required) return true;
      const codes = Array.isArray(required) ? required : [required];
      return codes.some((c) => hasPermission(c));
    },
    [hasPermission],
  );

  const canAccessSettingsTab = useCallback(
    (tab: string): boolean => {
      const required = SETTINGS_TAB_PERMISSION_MAP[tab];
      if (!required) return false;
      return required.some((c) => hasPermission(c));
    },
    [hasPermission],
  );

  return {
    authenticated,
    username: authStatus?.username ?? null,
    userId: authStatus?.userId ?? null,
    displayName: authStatus?.displayName ?? null,
    roles,
    permissions,
    multiUserMode,
    hasPermission,
    hasAnyPermission,
    canAccessPage,
    canAccessSettingsTab,
  };
}
