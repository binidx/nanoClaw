import { useCallback, useEffect, useState } from 'react';

import i18n from '../i18n/index.ts';
import type { ExtensionMetadata, UserMcpServerView } from '../app-types';

export interface UseUserMcpReturn {
  servers: UserMcpServerView[];
  myServers: UserMcpServerView[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  create: (input: {
    name: string;
    description?: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    visibility?: 'private' | 'shared';
    tags?: string[];
    metadata?: ExtensionMetadata;
  }) => Promise<UserMcpServerView | null>;
  generateWithAi: (input: {
    request: string;
    docsText?: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<UserMcpServerView | null>;
  importFromPath: (input: {
    sourcePath: string;
    name?: string;
    entryFile?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<UserMcpServerView | null>;
  update: (id: string, input: Partial<{
    name: string;
    description: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: boolean;
    visibility: 'private' | 'shared';
    tags: string[];
    metadata: ExtensionMetadata;
  }>) => Promise<UserMcpServerView | null>;
  remove: (id: string) => Promise<boolean>;
  toggleVisibility: (id: string) => Promise<UserMcpServerView | null>;
  installShared: (sourceMcpId: string) => Promise<UserMcpServerView | null>;
}

export function useUserMcp(apiBase: string): UseUserMcpReturn {
  const [servers, setServers] = useState<UserMcpServerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setServers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { void refresh(); }, [refresh]);

  const myServers = servers.filter((s) => s.isOwner);

  const create = useCallback(async (input: Parameters<UseUserMcpReturn['create']>[0]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.mcpCreateFailed'));
        return null;
      }
      const server = await res.json();
      await refresh();
      return server as UserMcpServerView;
    } catch {
      setError(i18n.t('apps.hook.mcpCreateFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const generateWithAi = useCallback(async (input: Parameters<UseUserMcpReturn['generateWithAi']>[0]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/ai-generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(
          (payload as { error?: string }).error || i18n.t('apps.hook.mcpAiGenerateFailed'),
        );
        return null;
      }
      const payload = (await res.json()) as {
        server?: UserMcpServerView;
      };
      await refresh();
      return payload.server || null;
    } catch {
      setError(i18n.t('apps.hook.mcpAiGenerateFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const update = useCallback(async (id: string, input: Parameters<UseUserMcpReturn['update']>[1]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.mcpUpdateFailed'));
        return null;
      }
      const server = await res.json();
      await refresh();
      return server as UserMcpServerView;
    } catch {
      setError(i18n.t('apps.hook.mcpUpdateFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const importFromPath = useCallback(async (input: Parameters<UseUserMcpReturn['importFromPath']>[0]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/import-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(
          (payload as { error?: string }).error || i18n.t('apps.hook.mcpImportFailed'),
        );
        return null;
      }
      const payload = (await res.json()) as {
        server?: UserMcpServerView;
      };
      await refresh();
      return payload.server || null;
    } catch {
      setError(i18n.t('apps.hook.mcpImportFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.mcpDeleteFailed'));
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError(i18n.t('apps.hook.mcpDeleteFailed'));
      return false;
    }
  }, [apiBase, refresh]);

  const toggleVisibility = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/${encodeURIComponent(id)}/toggle-visibility`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.toggleVisibilityFailed'));
        return null;
      }
      const server = await res.json();
      await refresh();
      return server as UserMcpServerView;
    } catch {
      setError(i18n.t('apps.hook.toggleVisibilityFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const installShared = useCallback(async (sourceMcpId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/mcp-servers/install-shared`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceMcpId }),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.mcpInstallFailed'));
        return null;
      }
      const server = await res.json();
      await refresh();
      return server as UserMcpServerView;
    } catch {
      setError(i18n.t('apps.hook.mcpInstallFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  return {
    servers,
    myServers,
    loading,
    error,
    refresh,
    create,
    generateWithAi,
    importFromPath,
    update,
    remove,
    toggleVisibility,
    installShared,
  };
}
