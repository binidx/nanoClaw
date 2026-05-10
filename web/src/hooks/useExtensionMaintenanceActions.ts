import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import i18n from '../i18n/index.ts';

import type {
  ExtensionCatalogEntry,
  ExtensionInstallRecord,
  ExtensionMarketplaceSource,
  ManagedMcpServer,
  ManagedSkill,
  NativeDialogLike,
  WorkspaceCleanupSummary,
} from '../app-types';

type ExtensionActionStatus = {
  loadingCatalog: boolean;
  installingEntryId: string | null;
  importing: boolean;
  reconciling: boolean;
};

type UseExtensionMaintenanceActionsParams = {
  apiBase: string;
  workspaceCleanupSummary: WorkspaceCleanupSummary | null;
  showNativeConfirm: (dialog: NativeDialogLike) => Promise<boolean>;
  setSavingMcpConfig: Dispatch<SetStateAction<boolean>>;
  setSavingSkillsConfig: Dispatch<SetStateAction<boolean>>;
  setExtensionsMessage: Dispatch<SetStateAction<string>>;
  setManagedMcpServers: Dispatch<SetStateAction<ManagedMcpServer[]>>;
  setManagedSkills: Dispatch<SetStateAction<ManagedSkill[]>>;
  setExtensionMarketplaceSources: Dispatch<
    SetStateAction<ExtensionMarketplaceSource[]>
  >;
  setExtensionInstalls: Dispatch<SetStateAction<ExtensionInstallRecord[]>>;
  setWorkspaceCleanupSummary: Dispatch<
    SetStateAction<WorkspaceCleanupSummary | null>
  >;
  setWorkspaceCleanupMessage: Dispatch<SetStateAction<string>>;
  setCleaningWorkspaces: Dispatch<SetStateAction<boolean>>;
  loadWorkspaceCleanupSummary: () => Promise<void> | void;
  loadDoctorReport: () => Promise<void> | void;
};

export function useExtensionMaintenanceActions({
  apiBase,
  workspaceCleanupSummary,
  showNativeConfirm,
  setSavingMcpConfig,
  setSavingSkillsConfig,
  setExtensionsMessage,
  setManagedMcpServers,
  setManagedSkills,
  setExtensionMarketplaceSources,
  setExtensionInstalls,
  setWorkspaceCleanupSummary,
  setWorkspaceCleanupMessage,
  setCleaningWorkspaces,
  loadWorkspaceCleanupSummary,
  loadDoctorReport,
}: UseExtensionMaintenanceActionsParams) {
  const refreshManagedExtensionState = useCallback(async () => {
    const fetches = [
      fetch(`${apiBase}/api/mcp-servers`),
      fetch(`${apiBase}/api/skills`),
      fetch(`${apiBase}/api/extensions/installs`),
    ];
    const results = await Promise.allSettled(fetches);
    const failures: string[] = [];

    const [mcpResult, skillsResult, installsResult] = results;

    if (mcpResult.status === 'fulfilled' && mcpResult.value.ok) {
      const data = (await mcpResult.value.json()) as { servers?: ManagedMcpServer[] };
      setManagedMcpServers(Array.isArray(data.servers) ? data.servers : []);
    } else {
      failures.push('MCP');
    }

    if (skillsResult.status === 'fulfilled' && skillsResult.value.ok) {
      const data = (await skillsResult.value.json()) as { skills?: ManagedSkill[] };
      setManagedSkills(Array.isArray(data.skills) ? data.skills : []);
    } else {
      failures.push('Skills');
    }

    if (installsResult.status === 'fulfilled' && installsResult.value.ok) {
      const data = (await installsResult.value.json()) as {
        installs?: ExtensionInstallRecord[];
      };
      setExtensionInstalls(Array.isArray(data.installs) ? data.installs : []);
    } else {
      failures.push(i18n.t('hooks.extensionMaintenance.extensionInstallRecords'));
    }

    return {
      ok: failures.length === 0,
      failures,
    };
  }, [
    apiBase,
    setExtensionInstalls,
    setManagedMcpServers,
    setManagedSkills,
  ]);

  const formatExtensionRefreshResultMessage = useCallback(
    (successMessage: string, failures: string[]) =>
      failures.length > 0
        ? i18n.t('hooks.extensionMaintenance.refreshPartiallyFailed', { successMessage, failures: failures.join('、') })
        : successMessage,
    [],
  );

  const [extensionActionStatus, setExtensionActionStatus] =
    useState<ExtensionActionStatus>({
      loadingCatalog: false,
      installingEntryId: null,
      importing: false,
      reconciling: false,
    });

  const saveManagedMcpServers = useCallback(
    async (servers: ManagedMcpServer[]) => {
      setSavingMcpConfig(true);
      setExtensionsMessage('');
      try {
        const normalized = servers.map((server) => ({
          ...server,
          id: server.id.trim(),
          name: server.name.trim() || server.id.trim(),
          command: server.command.trim(),
          args: server.args.map((arg) => arg.trim()).filter(Boolean),
          env: Object.fromEntries(
            Object.entries(server.env || {})
              .map(
                ([key, value]) =>
                  [key.trim(), String(value || '').trim()] as const,
              )
              .filter(([key]) => key.length > 0),
          ),
        }));
        const res = await fetch(`${apiBase}/api/mcp-servers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ servers: normalized }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.mcpConfigSaveFailed'));
          return false;
        }
        const data = (await res.json()) as { servers?: ManagedMcpServer[] };
        setManagedMcpServers(Array.isArray(data.servers) ? data.servers : []);
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.mcpConfigSaved'));
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.mcpConfigSaveFailedRetry'));
        return false;
      } finally {
        setSavingMcpConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedMcpServers,
      setSavingMcpConfig,
    ],
  );

  const installManagedMcpFromPath = useCallback(
    async (input: {
      sourcePath: string;
      id: string;
      name: string;
      entryFile: string;
      overwrite: boolean;
    }) => {
      setSavingMcpConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/mcp-servers/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.mcpInstallFailed'));
          return false;
        }
        const data = (await res.json()) as {
          servers?: ManagedMcpServer[];
          installed?: { id?: string };
        };
        setManagedMcpServers(Array.isArray(data.servers) ? data.servers : []);
        setExtensionsMessage(
          data.installed?.id
            ? i18n.t('hooks.extensionMaintenance.mcpInstalled', { id: data.installed.id })
            : i18n.t('hooks.extensionMaintenance.mcpInstallSuccess'),
        );
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.mcpInstallFailedRetry'));
        return false;
      } finally {
        setSavingMcpConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedMcpServers,
      setSavingMcpConfig,
    ],
  );

  const saveEnabledSkills = useCallback(
    async (enabledSkillIds: string[]) => {
      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/skills/enabled`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabledSkillIds }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.skillsConfigSaveFailed'));
          return false;
        }
        const data = (await res.json()) as { skills?: ManagedSkill[] };
        setManagedSkills(Array.isArray(data.skills) ? data.skills : []);
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.skillsConfigSaved'));
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.skillsConfigSaveFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedSkills,
      setSavingSkillsConfig,
    ],
  );

  const installSkillFromPath = useCallback(
    async (input: {
      sourcePath: string;
      skillId: string;
      overwrite: boolean;
    }) => {
      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/skills/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.skillInstallFailed'));
          return false;
        }
        const data = (await res.json()) as {
          skills?: ManagedSkill[];
          installed?: { id?: string };
        };
        setManagedSkills(Array.isArray(data.skills) ? data.skills : []);
        setExtensionsMessage(
          data.installed?.id
            ? i18n.t('hooks.extensionMaintenance.skillInstalled', { id: data.installed.id })
            : i18n.t('hooks.extensionMaintenance.skillInstallSuccess'),
        );
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.skillInstallFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedSkills,
      setSavingSkillsConfig,
    ],
  );

  const createCustomSkill = useCallback(
    async (input: {
      id: string;
      name: string;
      description: string;
      content: string;
    }) => {
      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.customSkillCreateFailed'));
          return false;
        }
        const data = (await res.json()) as { skills?: ManagedSkill[] };
        setManagedSkills(Array.isArray(data.skills) ? data.skills : []);
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.customSkillCreated'));
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.customSkillCreateFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedSkills,
      setSavingSkillsConfig,
    ],
  );

  const deleteCustomSkillById = useCallback(
    async (skillId: string) => {
      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(
          `${apiBase}/api/skills/${encodeURIComponent(skillId)}`,
          {
            method: 'DELETE',
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.customSkillDeleteFailed'));
          return false;
        }
        const data = (await res.json()) as { skills?: ManagedSkill[] };
        setManagedSkills(Array.isArray(data.skills) ? data.skills : []);
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.customSkillDeleted'));
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.customSkillDeleteFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      loadDoctorReport,
      setExtensionsMessage,
      setManagedSkills,
      setSavingSkillsConfig,
    ],
  );

  const saveExtensionMarketplaceSources = useCallback(
    async (sources: ExtensionMarketplaceSource[]) => {
      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const normalized = sources.map((entry) => ({
          id: entry.id.trim(),
          name: entry.name.trim() || entry.id.trim(),
          source: entry.source.trim(),
          enabled: entry.enabled !== false,
        }));
        const res = await fetch(`${apiBase}/api/extensions/marketplaces`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: normalized }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.marketplaceSourceSaveFailed'));
          return false;
        }
        const data = (await res.json()) as {
          sources?: ExtensionMarketplaceSource[];
        };
        setExtensionMarketplaceSources(
          Array.isArray(data.sources) ? data.sources : [],
        );
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.marketplaceSourceSaved'));
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.marketplaceSourceSaveFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      setExtensionMarketplaceSources,
      setExtensionsMessage,
      setSavingSkillsConfig,
    ],
  );

  const loadExtensionMarketplaceCatalog = useCallback(
    async (input?: { sourceId?: string; source?: string }) => {
      setExtensionActionStatus((prev) => ({ ...prev, loadingCatalog: true }));
      try {
        const res = await fetch(`${apiBase}/api/extensions/marketplaces/catalog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input || {}),
        });
        const data = (await res.json().catch(() => ({}))) as {
          entries?: ExtensionCatalogEntry[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(data.error || i18n.t('hooks.extensionMaintenance.marketplaceCatalogLoadFailed'));
        }
        return Array.isArray(data.entries) ? data.entries : [];
      } finally {
        setExtensionActionStatus((prev) => ({
          ...prev,
          loadingCatalog: false,
        }));
      }
    },
    [apiBase],
  );

  const buildExtensionStatusMessage = useCallback(
    (installed: ExtensionInstallRecord | undefined, verb: 'install' | 'import') => {
      const verbLabel = verb === 'install' ? i18n.t('hooks.extensionMaintenance.verbInstall') : i18n.t('hooks.extensionMaintenance.verbImport');
      if (!installed) return i18n.t('hooks.extensionMaintenance.extActionDone', { verb: verbLabel });
      if (installed.status === 'needs_attention') {
        return i18n.t('hooks.extensionMaintenance.extActionDoneNeedsAttention', { verb: verbLabel, name: installed.name });
      }
      return i18n.t('hooks.extensionMaintenance.extActionDoneWithName', { verb: verbLabel, name: installed.name });
    },
    [],
  );

  const installMarketplaceExtension = useCallback(
    async (input: {
      sourceId?: string;
      source?: string;
      entryName: string;
      overwrite?: boolean;
    }) => {
      setSavingSkillsConfig(true);
      setExtensionActionStatus((prev) => ({
        ...prev,
        installingEntryId: input.entryName,
      }));
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/extensions/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = (await res.json().catch(() => ({}))) as {
          installs?: ExtensionInstallRecord[];
          installed?: ExtensionInstallRecord;
          error?: string;
        };
        if (!res.ok) {
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.extInstallFailed'));
          return false;
        }
        const refreshed = await refreshManagedExtensionState();
        setExtensionsMessage(
          formatExtensionRefreshResultMessage(
            buildExtensionStatusMessage(data.installed, 'install'),
            refreshed.failures,
          ),
        );
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.extInstallFailedRetry'));
        return false;
      } finally {
        setExtensionActionStatus((prev) => ({
          ...prev,
          installingEntryId: null,
        }));
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      buildExtensionStatusMessage,
      formatExtensionRefreshResultMessage,
      loadDoctorReport,
      refreshManagedExtensionState,
      setExtensionsMessage,
      setSavingSkillsConfig,
    ],
  );

  const importExtensionFromSource = useCallback(
    async (input: {
      source: string;
      installId?: string;
      name?: string;
      overwrite?: boolean;
    }) => {
      setSavingSkillsConfig(true);
      setExtensionActionStatus((prev) => ({ ...prev, importing: true }));
      setExtensionsMessage('');
      try {
        const res = await fetch(`${apiBase}/api/extensions/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = (await res.json().catch(() => ({}))) as {
          installs?: ExtensionInstallRecord[];
          installed?: ExtensionInstallRecord;
          error?: string;
        };
        if (!res.ok) {
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.extImportFailed'));
          return false;
        }
        const refreshed = await refreshManagedExtensionState();
        setExtensionsMessage(
          formatExtensionRefreshResultMessage(
            buildExtensionStatusMessage(data.installed, 'import'),
            refreshed.failures,
          ),
        );
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.extImportFailedRetry'));
        return false;
      } finally {
        setExtensionActionStatus((prev) => ({ ...prev, importing: false }));
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      buildExtensionStatusMessage,
      formatExtensionRefreshResultMessage,
      loadDoctorReport,
      refreshManagedExtensionState,
      setExtensionsMessage,
      setSavingSkillsConfig,
    ],
  );

  const uninstallExtensionInstall = useCallback(
    async (input: { installId: string; name?: string }) => {
      const installId = input.installId.trim();
      if (!installId) {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.missingInstallId'));
        return false;
      }

      const confirmed = await showNativeConfirm({
        title: i18n.t('hooks.extensionMaintenance.uninstallExtTitle'),
        message: i18n.t('hooks.extensionMaintenance.uninstallExtConfirm', { name: input.name?.trim() || installId }),
      });
      if (!confirmed) {
        return false;
      }

      setSavingSkillsConfig(true);
      setExtensionsMessage('');
      try {
        const res = await fetch(
          `${apiBase}/api/extensions/installs/${encodeURIComponent(installId)}`,
          { method: 'DELETE' },
        );
        const data = (await res.json().catch(() => ({}))) as {
          installs?: ExtensionInstallRecord[];
          removed?: ExtensionInstallRecord;
          error?: string;
        };
        if (!res.ok) {
          setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.extUninstallFailed'));
          return false;
        }
        const refreshed = await refreshManagedExtensionState();
        setExtensionsMessage(
          formatExtensionRefreshResultMessage(
            data.removed?.name
              ? i18n.t('hooks.extensionMaintenance.extUninstalled', { name: data.removed.name })
              : i18n.t('hooks.extensionMaintenance.extUninstalled', { name: installId }),
            refreshed.failures,
          ),
        );
        void loadDoctorReport();
        return true;
      } catch {
        setExtensionsMessage(i18n.t('hooks.extensionMaintenance.extUninstallFailedRetry'));
        return false;
      } finally {
        setSavingSkillsConfig(false);
      }
    },
    [
      apiBase,
      formatExtensionRefreshResultMessage,
      loadDoctorReport,
      refreshManagedExtensionState,
      setExtensionsMessage,
      setSavingSkillsConfig,
      showNativeConfirm,
    ],
  );

  const reconcileExtensionInstalls = useCallback(async () => {
    setExtensionActionStatus((prev) => ({ ...prev, reconciling: true }));
    setSavingSkillsConfig(true);
    setExtensionsMessage('');
    try {
      const res = await fetch(`${apiBase}/api/extensions/installs/reconcile`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        installs?: ExtensionInstallRecord[];
        error?: string;
      };
      if (!res.ok) {
        setExtensionsMessage(data.error || i18n.t('hooks.extensionMaintenance.reconcileFailed'));
        return false;
      }
      const refreshed = await refreshManagedExtensionState();
      const installs = Array.isArray(data.installs) ? data.installs : [];
      const attentionCount = installs.filter(
        (entry) => entry.status === 'needs_attention',
      ).length;
      setExtensionsMessage(
        formatExtensionRefreshResultMessage(
          attentionCount > 0
            ? i18n.t('hooks.extensionMaintenance.reconcileDoneWithAttention', { count: attentionCount })
            : i18n.t('hooks.extensionMaintenance.reconcileDone'),
          refreshed.failures,
        ),
      );
      void loadDoctorReport();
      return true;
    } catch {
      setExtensionsMessage(i18n.t('hooks.extensionMaintenance.reconcileFailedRetry'));
      return false;
    } finally {
      setExtensionActionStatus((prev) => ({ ...prev, reconciling: false }));
      setSavingSkillsConfig(false);
    }
  }, [
    apiBase,
    formatExtensionRefreshResultMessage,
    loadDoctorReport,
    refreshManagedExtensionState,
    setExtensionsMessage,
    setSavingSkillsConfig,
  ]);

  const cleanupOrphanWorkspaces = useCallback(async () => {
    const orphanCount = workspaceCleanupSummary?.orphanDirectories.length || 0;
    const staleGroupCount =
      workspaceCleanupSummary?.staleRegisteredGroups.length || 0;
    if (orphanCount === 0 && staleGroupCount === 0) {
      setWorkspaceCleanupMessage(i18n.t('hooks.extensionMaintenance.noOrphansToCleanup'));
      await Promise.resolve(loadWorkspaceCleanupSummary());
      return;
    }

    const confirmed = await showNativeConfirm({
      title: i18n.t('hooks.extensionMaintenance.cleanupTitle'),
      message: i18n.t('hooks.extensionMaintenance.cleanupConfirm', { orphanCount, staleGroupCount }),
    });
    if (!confirmed) return;

    setCleaningWorkspaces(true);
    setWorkspaceCleanupMessage('');
    try {
      const res = await fetch(`${apiBase}/api/maintenance/orphans/cleanup`, {
        method: 'POST',
      });
      if (!res.ok) {
        setWorkspaceCleanupMessage(i18n.t('hooks.extensionMaintenance.cleanupFailed'));
        return;
      }
      const data = (await res.json()) as WorkspaceCleanupSummary;
      setWorkspaceCleanupSummary({
        orphanDirectories: [],
        staleRegisteredGroups: [],
        deletedDirectories: data.deletedDirectories,
        deletedSessionRows: data.deletedSessionRows,
        deletedRegisteredGroups: data.deletedRegisteredGroups,
      });
      setWorkspaceCleanupMessage(
        i18n.t('hooks.extensionMaintenance.cleanupSuccess', {
          dirs: data.deletedDirectories.length,
          sessions: data.deletedSessionRows.length,
          groups: data.deletedRegisteredGroups.length,
        }),
      );
      await Promise.resolve(loadWorkspaceCleanupSummary());
      await Promise.resolve(loadDoctorReport());
    } catch {
      setWorkspaceCleanupMessage(i18n.t('hooks.extensionMaintenance.cleanupFailed'));
    } finally {
      setCleaningWorkspaces(false);
    }
  }, [
    apiBase,
    loadDoctorReport,
    loadWorkspaceCleanupSummary,
    setCleaningWorkspaces,
    setWorkspaceCleanupMessage,
    setWorkspaceCleanupSummary,
    showNativeConfirm,
    workspaceCleanupSummary,
  ]);

  return {
    cleanupOrphanWorkspaces,
    createCustomSkill,
    deleteCustomSkillById,
    importExtensionFromSource,
    installManagedMcpFromPath,
    installMarketplaceExtension,
    installSkillFromPath,
    loadExtensionMarketplaceCatalog,
    reconcileExtensionInstalls,
    saveEnabledSkills,
    saveExtensionMarketplaceSources,
    saveManagedMcpServers,
    uninstallExtensionInstall,
    extensionActionStatus,
  };
}
