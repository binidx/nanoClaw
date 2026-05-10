import { useCallback, useEffect, useState } from 'react';

import i18n from '../i18n/index.ts';
import type { ExtensionMetadata, UserSkillView } from '../app-types';

export interface UseUserSkillsReturn {
  skills: UserSkillView[];
  mySkills: UserSkillView[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  create: (input: {
    name: string;
    description?: string;
    summary?: string;
    skillContent?: string;
    visibility?: 'private' | 'shared';
    tags?: string[];
    metadata?: ExtensionMetadata;
  }) => Promise<UserSkillView | null>;
  importFromPath: (input: {
    sourcePath: string;
    name?: string;
    visibility?: 'private' | 'shared';
  }) => Promise<UserSkillView | null>;
  update: (id: string, input: Partial<{
    name: string;
    description: string;
    summary: string;
    skillContent: string;
    enabled: boolean;
    visibility: 'private' | 'shared';
    tags: string[];
    metadata: ExtensionMetadata;
  }>) => Promise<UserSkillView | null>;
  remove: (id: string) => Promise<boolean>;
  toggleVisibility: (id: string) => Promise<UserSkillView | null>;
  installShared: (sourceSkillId: string) => Promise<UserSkillView | null>;
}

export function useUserSkills(apiBase: string): UseUserSkillsReturn {
  const [skills, setSkills] = useState<UserSkillView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/api/user/skills`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setSkills(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mySkills = skills.filter((s) => s.isOwner);

  const create = useCallback(async (input: Parameters<UseUserSkillsReturn['create']>[0]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.skillCreateFailed'));
        return null;
      }
      const skill = await res.json();
      await refresh();
      return skill as UserSkillView;
    } catch {
      setError(i18n.t('apps.hook.skillCreateFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const update = useCallback(async (id: string, input: Parameters<UseUserSkillsReturn['update']>[1]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.skillUpdateFailed'));
        return null;
      }
      const skill = await res.json();
      await refresh();
      return skill as UserSkillView;
    } catch {
      setError(i18n.t('apps.hook.skillUpdateFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const importFromPath = useCallback(async (input: Parameters<UseUserSkillsReturn['importFromPath']>[0]) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills/import-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setError(
          (payload as { error?: string }).error || i18n.t('apps.hook.skillImportFailed'),
        );
        return null;
      }
      const payload = (await res.json()) as {
        skill?: UserSkillView;
      };
      await refresh();
      return payload.skill || null;
    } catch {
      setError(i18n.t('apps.hook.skillImportFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.skillDeleteFailed'));
        return false;
      }
      await refresh();
      return true;
    } catch {
      setError(i18n.t('apps.hook.skillDeleteFailed'));
      return false;
    }
  }, [apiBase, refresh]);

  const toggleVisibility = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills/${encodeURIComponent(id)}/toggle-visibility`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.toggleVisibilityFailed'));
        return null;
      }
      const skill = await res.json();
      await refresh();
      return skill as UserSkillView;
    } catch {
      setError(i18n.t('apps.hook.toggleVisibilityFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  const installShared = useCallback(async (sourceSkillId: string) => {
    try {
      const res = await fetch(`${apiBase}/api/user/skills/install-shared`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSkillId }),
      });
      if (!res.ok) {
        setError(i18n.t('apps.hook.skillInstallFailed'));
        return null;
      }
      const skill = await res.json();
      await refresh();
      return skill as UserSkillView;
    } catch {
      setError(i18n.t('apps.hook.skillInstallFailed'));
      return null;
    }
  }, [apiBase, refresh]);

  return { skills, mySkills, loading, error, refresh, create, importFromPath, update, remove, toggleVisibility, installShared };
}
