import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigatedTab } from '../../hooks/useNavigatedTab';
import i18n from '../../i18n/index';
import type { AppSelectOption } from '../../components/AppSelect';
import type {
  BashApprovalAllowRule,
  ChannelFieldDefinition,
  ChannelInstanceConfig,
  ChannelTypeDefinition,
  ManagedMcpServer,
  ManagedSkillDetail,
  SettingsTab,
  SubagentRuntimeEntry,
  SubagentRuntimeSnapshot,
} from '../../app-types';
import {
  ADVANCED_WEB_CONFIG_KEY_SET,
  ALL_SETTINGS_TABS,
  AUTH_CONFIG_KEYS,
  BROWSER_CONTROL_CONFIG_KEYS,
  CORE_CONFIG_ORDER,
  getDefaultAccessPolicyOptions,
  KNOWLEDGE_CONFIG_KEYS,
  MEMORY_CONFIG_KEYS,
  getSubagentMaxActiveOptions,
  WEB_SEARCH_CONFIG_KEYS,
} from './settings-constants';
import {
  createManagedMcpDraft,
  createMarketplaceSourceDraft,
  describeProviderCapabilities,
  envToText,
  formatBashApprovalPrefix,
  formatIsoTimestamp,
  formatRatePercent,
  formatSubagentProviderLabel,
  getBooleanValue,
  getStringValue,
  mapSubagentRunToRuntimeEntry,
  normalizeManagedMcpServer,
  parseAllowedDirectoriesDraft,
  parseBashApprovalAllowlistDraft,
  parseBashApprovalPrefixInput,
  parseBrowserSiteProfilesDraft,
  parseManagedMcpJson,
  parseSenderTrustOverrides,
  slugifyMarketplaceSourceId,
  toMarketplaceSourceDraft,
  validateManagedMcpDraft,
} from './settings-helpers';
import {
  createRenderBasicConfigField,
  createRenderChannelField,
  renderBooleanField,
  renderSensitiveInput,
} from './settings-field-renderers';
import type {
  ExtensionCatalogPreviewEntry,
  ExtensionMarketplaceSourceDraft,
  MarketplaceCatalogGroup,
  SettingsPageProps,
  SubagentRunItem,
  SubagentRunSnapshotResponse,
} from './settings-types';

export function useSettingsPageModel(props: SettingsPageProps) {
  const {
  apiBase,
  focusSection,
  onFocusHandled,
  hideSettingsTabs = false,
  pageTitle = i18n.t('settings.model.配置'),
  visibleTabs,
  hasSystemSettings = true,
  hasLive2dManage = true,
  pickNativeDirectory,
  setEditingProvider,
  providers,
  testResults,
  testProvider,
  testingId,
  activateProvider,
  activateGlobalProvider,
  clearDefaultProvider,
  deleteProviderById,
  editingProvider,
  saveProvider,
  channelTypes,
  channelInstances,
  setChannelInstances,
  addChannelInstance,
  saveChannelSettings,
  savingChannelConfig,
  channelConfigMessage,
  basicConfig,
  builtinWebFetchSiteProfilePresets,
  setBasicConfig,
  configMeta,
  formatConfigEffectLabel,
  saveBasicSettings,
  savingBasicConfig,
  basicConfigMessage,
  workspaceCleanupSummary,
  workspaceCleanupMessage,
  scanningWorkspaces,
  cleaningWorkspaces,
  doctorReport,
  doctorLoading,
  refreshDoctorReport,
  refreshWorkspaceCleanupSummary,
  cleanupOrphanWorkspaces,
  assistantName,
  status,
  formatUptime,
  senderTrustConfig,
  saveSenderTrustConfig,
  savingSenderTrust,
  senderTrustMessage,
  managedMcpServers,
  saveManagedMcpServers,
  installManagedMcpFromPath,
  managedSkills,
  assistants,
  extensionMarketplaceSources,
  extensionInstalls,
  saveEnabledSkills,
  installSkillFromPath,
  saveExtensionMarketplaceSources,
  loadExtensionMarketplaceCatalog,
  installMarketplaceExtension,
  importExtensionFromSource,
  uninstallExtensionInstall,
  reconcileExtensionInstalls,
  deleteCustomSkill,
  openCommandGuideChat,
  extensionActionStatus,
  extensionsLoading,
  savingMcpConfig,
  savingSkillsConfig,
  extensionsMessage,
  } = props;

  const defaultTab = (visibleTabs?.[0] || 'providers') as SettingsTab;
  const [settingsTab, setSettingsTab] = useNavigatedTab<SettingsTab>('settings', ALL_SETTINGS_TABS, defaultTab);

  useEffect(() => {
    if (visibleTabs && !visibleTabs.includes(settingsTab)) {
      setSettingsTab((visibleTabs[0] || 'providers') as SettingsTab);
    }
  }, [settingsTab, visibleTabs, setSettingsTab]);

  const defaultAccessPolicyRef = useRef<HTMLDivElement | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<
    Record<string, boolean>
  >({});
  const coreConfigKeys = useMemo(
    () =>
      CORE_CONFIG_ORDER.filter(
        (key) => key in basicConfig || key in configMeta,
      ),
    [basicConfig, configMeta],
  );
  const advancedWebConfigKeys = useMemo(
    () => coreConfigKeys.filter((key) => ADVANCED_WEB_CONFIG_KEY_SET.has(key)),
    [coreConfigKeys],
  );
  const primaryConfigKeys = useMemo(
    () =>
      coreConfigKeys.filter(
        (key) =>
          !ADVANCED_WEB_CONFIG_KEY_SET.has(key) && key !== 'DEFAULT_ACCESS_MODE',
      ),
    [coreConfigKeys],
  );
  const browserControlConfigKeys = useMemo(
    () =>
      BROWSER_CONTROL_CONFIG_KEYS.filter(
        (key) => key in basicConfig || key in configMeta,
      ),
    [basicConfig, configMeta],
  );
  const memoryConfigKeys = useMemo(
    () =>
      MEMORY_CONFIG_KEYS.filter((key) => key in basicConfig || key in configMeta),
    [basicConfig, configMeta],
  );
  const knowledgeConfigKeys = useMemo(
    () =>
      KNOWLEDGE_CONFIG_KEYS.filter((key) => key in basicConfig || key in configMeta),
    [basicConfig, configMeta],
  );
  const webSearchConfigKeys = useMemo(
    () =>
      WEB_SEARCH_CONFIG_KEYS.filter((key) => key in basicConfig || key in configMeta),
    [basicConfig, configMeta],
  );
  const authConfigKeys = useMemo(
    () =>
      AUTH_CONFIG_KEYS.filter((key) => key in basicConfig || key in configMeta),
    [basicConfig, configMeta],
  );
  const webLoginEnabled = getBooleanValue(basicConfig, 'WEB_LOGIN_ENABLED');
  const webSearchEnabled = getBooleanValue(basicConfig, 'WEB_SEARCH_ENABLED');
  const webSearchProvider = getStringValue(basicConfig, 'WEB_SEARCH_PROVIDER');
  const webFetchProvider = getStringValue(basicConfig, 'WEB_FETCH_PROVIDER');
  const browserConnectionMode = getStringValue(
    basicConfig,
    'WEB_BROWSER_CONNECTION_MODE',
  );
  const defaultAccessModeRawValue = getStringValue(
    basicConfig,
    'DEFAULT_ACCESS_MODE',
  );
  const defaultAccessModeValue = getDefaultAccessPolicyOptions().some(
    (option) => option.value === defaultAccessModeRawValue,
  )
    ? defaultAccessModeRawValue
    : 'allowall';
  const selectedDefaultAccessPolicy =
    getDefaultAccessPolicyOptions().find(
      (option) => option.value === defaultAccessModeValue,
    ) || getDefaultAccessPolicyOptions()[0];
  const defaultAccessModeLabel = selectedDefaultAccessPolicy.label;
  const enabledAssistantCount = assistants.filter(
    (assistant) => assistant.enabled !== false,
  ).length;
  const defaultProviderAlias = status?.providerAlias || status?.provider || '-';
  const defaultAllowedDirectoriesValue = getStringValue(
    basicConfig,
    'allowed_directories',
  );
  const defaultAllowedDirectoriesState = useMemo(
    () => parseAllowedDirectoriesDraft(defaultAllowedDirectoriesValue),
    [defaultAllowedDirectoriesValue],
  );
  const defaultAllowedDirectories =
    defaultAllowedDirectoriesState.directories;
  const defaultDirectoryTemplateCount = defaultAllowedDirectories.length;
  const [siteProfilePreset, setSiteProfilePreset] = useState('__all__');
  const [siteProfileToolMessage, setSiteProfileToolMessage] = useState('');
  const [defaultDirectoryDraft, setDefaultDirectoryDraft] = useState('');
  const [defaultDirectoryError, setDefaultDirectoryError] = useState('');
  const [pickingDefaultDirectory, setPickingDefaultDirectory] = useState(false);
  const [subagentEnabled, setSubagentEnabled] = useState(true);
  const [subagentMaxDepth, setSubagentMaxDepth] = useState(2);
  const [subagentMaxActive, setSubagentMaxActive] = useState(4);
  const [subagentSaving, setSubagentSaving] = useState(false);
  const [subagentMessage, setSubagentMessage] = useState('');
  const [subagentMessageTone, setSubagentMessageTone] = useState<
    'success' | 'error'
  >('success');
  const [subagentRuntime, setSubagentRuntime] =
    useState<SubagentRuntimeSnapshot | null>(null);
  const [, setSubagentRuntimeLoading] = useState(false);
  const [_subagentRuntimeMessage, setSubagentRuntimeMessage] = useState('');
  const [_subagentRuntimeMessageTone, setSubagentRuntimeMessageTone] = useState<
    'success' | 'error'
  >('success');
  const [subagentRuntimeActionKey, setSubagentRuntimeActionKey] = useState('');
  void _subagentRuntimeMessage;
  void _subagentRuntimeMessageTone;

  useEffect(() => {
    if (settingsTab !== 'general') return;
    if (focusSection !== 'default-access-policy') return;
    window.requestAnimationFrame(() => {
      defaultAccessPolicyRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    onFocusHandled?.();
  }, [focusSection, onFocusHandled, settingsTab]);

  useEffect(() => {
    setDefaultDirectoryError(defaultAllowedDirectoriesState.error || '');
  }, [defaultAllowedDirectoriesState.error]);

  const [subagentRuntimeActiveOnly, _setSubagentRuntimeActiveOnly] = useState(true);
  const [subagentRuntimeProviderFilter, _setSubagentRuntimeProviderFilter] = useState<'all' | string>('all');
  const [subagentRuntimeStatusFilter, _setSubagentRuntimeStatusFilter] = useState<'all' | 'spawning' | 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped'>('all');
  const [subagentRuntimeControllerFilter, _setSubagentRuntimeControllerFilter] = useState('');
  const [subagentRuntimeRequesterFilter, _setSubagentRuntimeRequesterFilter] = useState('');
  const [subagentRuntimeIdFilter, _setSubagentRuntimeIdFilter] = useState('');
  const [subagentRuntimeDescendantFilter, _setSubagentRuntimeDescendantFilter] = useState('');
  void _setSubagentRuntimeActiveOnly; void _setSubagentRuntimeProviderFilter; void _setSubagentRuntimeStatusFilter;
  void _setSubagentRuntimeControllerFilter; void _setSubagentRuntimeRequesterFilter; void _setSubagentRuntimeIdFilter; void _setSubagentRuntimeDescendantFilter;
  const assistantNameValue = getStringValue(basicConfig, 'ASSISTANT_NAME');
  const webPortValue = getStringValue(basicConfig, 'WEB_PORT');
  const bashApprovalAllowlistValue = getStringValue(
    basicConfig,
    'BASH_APPROVAL_ALLOWLIST',
  );
  const bashApprovalAllowlistState = useMemo(
    () => parseBashApprovalAllowlistDraft(bashApprovalAllowlistValue),
    [bashApprovalAllowlistValue],
  );
  const [bashApprovalCommandDraft, setBashApprovalCommandDraft] = useState('');
  const [bashApprovalAllowlistMessage, setBashApprovalAllowlistMessage] =
    useState('');
  const [mcpDraft, setMcpDraft] = useState<ManagedMcpServer[]>(() =>
    managedMcpServers.map((server) => normalizeManagedMcpServer(server)),
  );
  const [skillInstallDraft, setSkillInstallDraft] = useState({
    sourcePath: '',
    skillId: '',
    overwrite: false,
  });
  const [mcpInstallDraft, setMcpInstallDraft] = useState({
    sourcePath: '',
    id: '',
    name: '',
    entryFile: '',
    overwrite: false,
  });
  const [mcpJsonDraft, setMcpJsonDraft] = useState('');
  const [mcpLocalMessage, setMcpLocalMessage] = useState('');
  const [skillDetailsById, setSkillDetailsById] = useState<
    Record<string, ManagedSkillDetail | undefined>
  >({});
  const [skillDetailLoadingById, setSkillDetailLoadingById] = useState<
    Record<string, boolean>
  >({});
  const [skillDetailErrorById, setSkillDetailErrorById] = useState<
    Record<string, string>
  >({});
  const [marketplaceDraft, setMarketplaceDraft] = useState<
    ExtensionMarketplaceSourceDraft[]
  >(() => extensionMarketplaceSources.map((entry) => toMarketplaceSourceDraft(entry)));
  const [marketplaceCatalog, setMarketplaceCatalog] = useState<
    ExtensionCatalogPreviewEntry[]
  >([]);
  const [marketplaceCatalogLoading, setMarketplaceCatalogLoading] =
    useState(false);
  const [marketplaceCatalogMessage, setMarketplaceCatalogMessage] =
    useState('');
  const marketplaceDraftRef = useRef<ExtensionMarketplaceSourceDraft[]>(
    marketplaceDraft,
  );
  const marketplaceCatalogRequestIdRef = useRef(0);
  const groupedMarketplaceCatalog = useMemo<MarketplaceCatalogGroup[]>(() => {
    const groups = new Map<string, MarketplaceCatalogGroup>();
    for (const entry of marketplaceCatalog) {
      const key = `${entry.sourceName ?? ''}::${entry.sourceLabel}`;
      const previewMode = entry.installSourceId ? 'saved' : 'preview';
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(entry);
        existing.previewMode =
          existing.previewMode === 'saved' || previewMode === 'saved'
            ? 'saved'
            : 'preview';
        continue;
      }
      groups.set(key, {
        key,
        title: entry.sourceName || entry.sourceLabel || i18n.t('settings.model.未知来源'),
        label: entry.sourceLabel,
        previewMode,
        entries: [entry],
      });
    }
    return Array.from(groups.values());
  }, [marketplaceCatalog]);
  const [extensionImportDraft, setExtensionImportDraft] = useState({
    source: '',
    installId: '',
    name: '',
    overwrite: false,
  });
  useEffect(() => {
    setMcpDraft(
      managedMcpServers.map((server) => normalizeManagedMcpServer(server)),
    );
  }, [managedMcpServers]);

  useEffect(() => {
    setMarketplaceDraft(extensionMarketplaceSources.map((entry) => toMarketplaceSourceDraft(entry)));
  }, [extensionMarketplaceSources]);

  useEffect(() => {
    marketplaceDraftRef.current = marketplaceDraft;
  }, [marketplaceDraft]);


  useEffect(() => {
    fetch(`${apiBase}/api/subagents/config`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{
          enabled?: unknown;
          maxDepth?: unknown;
          maxActive?: unknown;
        }>;
      })
      .then((data) => {
        if (typeof data.enabled === 'boolean') setSubagentEnabled(data.enabled);
        if (typeof data.maxDepth === 'number' && Number.isFinite(data.maxDepth)) {
          const nextDepth = Math.max(1, Math.min(5, Math.trunc(data.maxDepth)));
          setSubagentMaxDepth(nextDepth);
        }
        if (
          typeof data.maxActive === 'number' &&
          Number.isFinite(data.maxActive)
        ) {
          const nextMaxActive = Math.max(
            1,
            Math.min(16, Math.trunc(data.maxActive)),
          );
          setSubagentMaxActive(nextMaxActive);
        }
      })
      .catch(() => {
        // Keep defaults when config endpoint is unavailable.
      });
  }, [apiBase]);

  const loadSubagentRuntime = useCallback(async () => {
    setSubagentRuntimeLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '20',
        view: 'flat',
        activeOnly: subagentRuntimeActiveOnly ? 'true' : 'false',
      });
      if (subagentRuntimeProviderFilter !== 'all') {
        params.set('provider', subagentRuntimeProviderFilter);
      }
      if (subagentRuntimeStatusFilter !== 'all') {
        params.set('status', subagentRuntimeStatusFilter);
      }
      if (subagentRuntimeControllerFilter.trim()) {
        params.set(
          'controllerSessionKey',
          subagentRuntimeControllerFilter.trim(),
        );
      }
      if (subagentRuntimeRequesterFilter.trim()) {
        params.set(
          'requesterSessionKey',
          subagentRuntimeRequesterFilter.trim(),
        );
      }
      if (subagentRuntimeIdFilter.trim()) {
        params.set('runtimeId', subagentRuntimeIdFilter.trim());
      }
      if (subagentRuntimeDescendantFilter.trim()) {
        params.set('descendantOf', subagentRuntimeDescendantFilter.trim());
      }
      const res = await fetch(`${apiBase}/api/subagents/runs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SubagentRunSnapshotResponse;
      setSubagentRuntime({
        activeCount: data.activeCount,
        recentCount: data.recentCount,
        items: Array.isArray(data.items)
          ? data.items.map((item: SubagentRunItem) =>
              mapSubagentRunToRuntimeEntry(item),
            )
          : [],
        nextCursor: data.nextCursor || undefined,
      });
      setSubagentRuntimeMessage('');
    } catch {
      setSubagentRuntime(null);
      setSubagentRuntimeMessageTone('error');
      setSubagentRuntimeMessage(i18n.t('settings.model.读取子代理运行记录失败'));
    } finally {
      setSubagentRuntimeLoading(false);
    }
  }, [
    apiBase,
    subagentRuntimeActiveOnly,
    subagentRuntimeControllerFilter,
    subagentRuntimeDescendantFilter,
    subagentRuntimeIdFilter,
    subagentRuntimeProviderFilter,
    subagentRuntimeRequesterFilter,
    subagentRuntimeStatusFilter,
  ]);

  useEffect(() => {
    void loadSubagentRuntime();
  }, [loadSubagentRuntime]);

  const refreshSubagentRuntimeAfterMutation = useCallback(() => {
    window.setTimeout(() => {
      void loadSubagentRuntime();
    }, 1200);
  }, [loadSubagentRuntime]);

  const sendSubagentRuntimeAction = useCallback(
    async (
      subagentId: string,
      action: 'stop' | 'message' | 'steer',
      body?: Record<string, unknown>,
    ): Promise<boolean> => {
      setSubagentRuntimeActionKey(`${action}:${subagentId}`);
      setSubagentRuntimeMessage('');
      try {
        const res = await fetch(
          `${apiBase}/api/subagents/runtime/${encodeURIComponent(subagentId)}/${action}`,
          {
            method: 'POST',
            headers:
              body && Object.keys(body).length > 0
                ? { 'Content-Type': 'application/json' }
                : undefined,
            body:
              body && Object.keys(body).length > 0
                ? JSON.stringify(body)
                : undefined,
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          status?: string;
          error?: string;
        };
        if (!res.ok) {
          setSubagentRuntimeMessageTone('error');
          if (res.status === 404 && (action === 'message' || action === 'steer')) {
            setSubagentRuntimeMessage(
              i18n.t('settings.model.当前后端尚未提供控制接口', { action }),
            );
          } else {
            setSubagentRuntimeMessage(
              data.error ||
                (action === 'stop'
                  ? i18n.t('settings.model.发送停止请求失败')
                  : action === 'message'
                    ? i18n.t('settings.model.发送后续消息失败')
                    : i18n.t('settings.model.发送steer请求失败')),
            );
          }
          return false;
        }

        const status = String(data.status || '').trim();
        if (status === 'not_controllable') {
          setSubagentRuntimeMessageTone('error');
          setSubagentRuntimeMessage(
            action === 'stop'
              ? i18n.t('settings.model.子代理不支持停止控制', { subagentId })
              : action === 'message'
                ? i18n.t('settings.model.子代理不支持followup', { subagentId })
                : i18n.t('settings.model.子代理不支持steer', { subagentId }),
          );
          return false;
        }

        setSubagentRuntimeMessageTone('success');
        if (action === 'stop') {
          setSubagentRuntimeMessage(
            status === 'already_stopped'
              ? i18n.t('settings.model.子代理已经停止', { subagentId })
              : i18n.t('settings.model.已发送停止请求', { subagentId }),
          );
        } else if (action === 'message') {
          setSubagentRuntimeMessage(i18n.t('settings.model.已发送followup', { subagentId }));
        } else {
          setSubagentRuntimeMessage(i18n.t('settings.model.已发送steer', { subagentId }));
        }
        await loadSubagentRuntime();
        refreshSubagentRuntimeAfterMutation();
        return true;
      } catch {
        setSubagentRuntimeMessageTone('error');
        setSubagentRuntimeMessage(
          action === 'stop'
            ? i18n.t('settings.model.发送停止请求失败_重试')
            : action === 'message'
              ? i18n.t('settings.model.发送后续消息失败_重试')
              : i18n.t('settings.model.发送steer请求失败_重试'),
        );
        return false;
      } finally {
        setSubagentRuntimeActionKey('');
      }
    },
    [apiBase, loadSubagentRuntime, refreshSubagentRuntimeAfterMutation],
  );

  const stopSubagentRuntime = useCallback(async (subagentId: string) => {
    return sendSubagentRuntimeAction(subagentId, 'stop');
  }, [sendSubagentRuntimeAction]);

  const sendSubagentRuntimeMessage = useCallback(
    async (subagentId: string, prompt: string) => {
      return sendSubagentRuntimeAction(subagentId, 'message', { prompt });
    },
    [sendSubagentRuntimeAction],
  );

  const steerSubagentRuntime = useCallback(
    async (subagentId: string, prompt: string) => {
      return sendSubagentRuntimeAction(subagentId, 'steer', { prompt });
    },
    [sendSubagentRuntimeAction],
  );

  useEffect(() => {
    const validSkillIds = new Set(managedSkills.map((skill) => skill.id));
    setSkillDetailsById((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([skillId]) => validSkillIds.has(skillId)),
      ),
    );
    setSkillDetailLoadingById((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([skillId]) => validSkillIds.has(skillId)),
      ),
    );
    setSkillDetailErrorById((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([skillId]) => validSkillIds.has(skillId)),
      ),
    );
  }, [managedSkills]);

  const normalizedMcpDraft = useMemo(
    () => mcpDraft.map((server) => normalizeManagedMcpServer(server)),
    [mcpDraft],
  );
  const mcpEnvTextById = useMemo(
    () =>
      new Map(
        normalizedMcpDraft.map((server) => [server.id, envToText(server.env)]),
      ),
    [normalizedMcpDraft],
  );
  const statusChannelSummary = useMemo(
    () => status?.channels.map((channel) => channel.name).join(' / ') || '-',
    [status],
  );
  const webRuntimeSummary = useMemo(() => {
    if (!webSearchEnabled) return i18n.t('settings.model.默认Web能力已关闭');

    const searchProviderValue =
      getStringValue(basicConfig, 'WEB_SEARCH_PROVIDER') || 'auto';
    const fetchProviderValue =
      getStringValue(basicConfig, 'WEB_FETCH_PROVIDER') || 'auto';
    const searchResultsValue =
      getStringValue(basicConfig, 'WEB_SEARCH_MAX_RESULTS') || '5';
    const pageSizeValue =
      getStringValue(basicConfig, 'WEB_FETCH_PAGE_SIZE') || '6000';
    const builtinSiteProfilesEnabled = getBooleanValue(
      basicConfig,
      'WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
    );

    return [
      i18n.t('settings.model.搜索', { value: searchProviderValue }),
      i18n.t('settings.model.结果N条', { value: searchResultsValue }),
      i18n.t('settings.model.抓取', { value: fetchProviderValue }),
      i18n.t('settings.model.分页', { value: pageSizeValue }),
      builtinSiteProfilesEnabled ? i18n.t('settings.model.内置站点规则开启') : i18n.t('settings.model.内置站点规则关闭'),
    ].join(' / ');
  }, [basicConfig, webSearchEnabled]);
  const webRuntimeDetailNote = useMemo(() => {
    if (!webSearchEnabled)
      return i18n.t('settings.model.如需重新启用');

    const browserFetchEnabled = ['auto', 'browser_cli'].includes(
      webFetchProvider,
    );
    return browserFetchEnabled
      ? i18n.t('settings.model.搜索provider_browser_cli')
      : i18n.t('settings.model.搜索provider_长文分页');
  }, [webFetchProvider, webSearchEnabled]);
  const subagentsRuntimeLabel =
    status?.subagentsEnabled === true
      ? i18n.t('settings.model.已启用')
      : status?.subagentsEnabled === false
        ? i18n.t('settings.model.已关闭')
        : i18n.t('settings.model.未知');
  const claudeSubagentRuntimeLabel = status?.subagents?.providers?.claude
    ? describeProviderCapabilities(status.subagents.providers.claude)
    : i18n.t('settings.model.未提供');
  const codexSubagentRuntimeLabel = status?.subagents?.providers?.codex
    ? describeProviderCapabilities(status.subagents.providers.codex)
    : i18n.t('settings.model.未提供');
  const subagentRuntimeItems = useMemo<SubagentRuntimeEntry[]>(
    () => subagentRuntime?.items ?? [],
    [subagentRuntime?.items],
  );
  const providerCapabilityEntries = useMemo(
    () =>
      Object.entries(status?.subagents?.providers || {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    [status],
  );
  void useMemo<AppSelectOption[]>(
    () => {
      const providerIds = new Set<string>([
        ...providerCapabilityEntries.map(([providerId]) => providerId),
        ...subagentRuntimeItems.map((item) => item.provider).filter(Boolean),
      ]);
      return [
        { value: 'all', label: i18n.t('settings.model.全部Provider') },
        ...Array.from(providerIds)
          .sort((left, right) => left.localeCompare(right))
          .map((providerId) => ({
            value: providerId,
            label: formatSubagentProviderLabel(providerId),
          })),
      ];
    },
    [providerCapabilityEntries, subagentRuntimeItems],
  );
  const subagentActiveCapacityLabel =
    typeof status?.subagents?.maxActive === 'number'
      ? `${status.subagents.activeCount}/${status.subagents.maxActive}`
      : '-';
  const subagentDepthSummary = i18n.t('settings.model.N层', { value: subagentMaxDepth });
  const subagentMaxActiveSummary =
    getSubagentMaxActiveOptions(i18n.t).find(
      (option) => option.value === subagentMaxActive,
    )?.description || i18n.t('settings.model.N个', { value: subagentMaxActive });
  const currentProviderLabel = status?.provider
    ? status?.providerAlias
      ? `${status.provider} (${status.providerAlias})`
      : status.provider
    : '-';
  const memorySearchStatus = status?.memory?.search;
  const memoryPromotionStatus = status?.memory?.promotion;
  const memorySearchOverviewValue = memorySearchStatus
    ? i18n.t('settings.model.N条', { value: memorySearchStatus.indexedDocuments })
    : '-';
  const memorySearchOverviewMeta = memorySearchStatus
    ? [
        `fallback ${memorySearchStatus.fallbackSyncCount24h}`,
        `stale ${memorySearchStatus.staleRefreshCount24h}`,
        i18n.t('settings.model.质量', { value: formatRatePercent(memorySearchStatus.followupReadRate24h) }),
      ].join(' / ')
    : i18n.t('settings.model.状态接口已返回memory');
  const memorySearchOverviewTone: 'default' | 'attention' | 'calm' =
    memorySearchStatus &&
    (memorySearchStatus.fallbackSyncCount24h > 0 ||
      memorySearchStatus.staleRefreshCount24h > 0)
      ? 'attention'
      : memorySearchStatus?.indexedDocuments
        ? 'calm'
        : 'default';
  const memorySearchSummaryItems = useMemo(
    () => [
      {
        label: i18n.t('settings.model.已索引记忆'),
        value: memorySearchStatus
          ? `${memorySearchStatus.indexedDocuments} / ${memorySearchStatus.syncStateDocuments}`
          : '-',
      },
      {
        label: i18n.t('settings.model.搜索命中24h'),
        value: String(memorySearchStatus?.indexedHitCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.返回片段24h'),
        value: String(memorySearchStatus?.indexedResultCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.跟进读取24h'),
        value: String(memorySearchStatus?.searchFollowupReadCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.总体转读率'),
        value: formatRatePercent(memorySearchStatus?.followupReadRate24h),
      },
      {
        label: i18n.t('settings.model.回退同步24h'),
        value: String(memorySearchStatus?.fallbackSyncCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.新鲜度复查24h'),
        value: String(memorySearchStatus?.freshnessRecheckCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.陈旧刷新24h'),
        value: String(memorySearchStatus?.staleRefreshCount24h ?? 0),
      },
      {
        label: i18n.t('settings.model.同步结果'),
        value: memorySearchStatus
          ? `${memorySearchStatus.filesSynced24h}/${memorySearchStatus.filesSkipped24h}/${memorySearchStatus.filesDeleted24h}`
          : '-',
      },
      {
        label: i18n.t('settings.model.最近同步'),
        value: memorySearchStatus?.lastSyncPassAt
          ? formatIsoTimestamp(memorySearchStatus.lastSyncPassAt)
          : '-',
      },
    ],
    [memorySearchStatus],
  );
  const memorySearchScopeItems = useMemo(
    () =>
      (['group', 'global'] as const).map((scope) => {
        const bucket = memorySearchStatus?.byScope?.[scope];
        return {
          label: scope === 'group' ? i18n.t('settings.model.Group质量') : i18n.t('settings.model.Global质量'),
          value: bucket
            ? `${bucket.followupReads24h}/${bucket.indexedResults24h} · ${formatRatePercent(
                bucket.followupReadRate24h,
              )}`
            : '-',
          meta: bucket
            ? `recall ${bucket.recalls24h} · follow-up ${bucket.followupReads24h}`
            : i18n.t('settings.model.尚无采样'),
        };
      }),
    [memorySearchStatus],
  );
  const memorySearchTopGroupItems = useMemo(
    () =>
      (memorySearchStatus?.topGroups || []).slice(0, 5).map((bucket) => ({
        label: bucket.groupFolder,
        value: `${bucket.followupReads24h}/${bucket.indexedResults24h} · ${formatRatePercent(
          bucket.followupReadRate24h,
        )}`,
        meta: `recall ${bucket.recalls24h} · follow-up ${bucket.followupReads24h}`,
      })),
    [memorySearchStatus],
  );
  const memorySearchSourceItems = useMemo(() => {
    const sourceLabelMap: Record<string, string> = {
      identity: 'Identity',
      global_durable: 'Global Durable',
      group_durable: 'Group Durable',
      identity_memory: 'Identity File',
      memory_file: 'Memory File',
      unknown: 'Unknown',
    };
    return Object.entries(memorySearchStatus?.bySource || {})
      .sort((left, right) => {
        const leftBucket = left[1];
        const rightBucket = right[1];
        if (rightBucket.indexedResults24h !== leftBucket.indexedResults24h) {
          return rightBucket.indexedResults24h - leftBucket.indexedResults24h;
        }
        if (rightBucket.followupReads24h !== leftBucket.followupReads24h) {
          return rightBucket.followupReads24h - leftBucket.followupReads24h;
        }
        if (rightBucket.recalls24h !== leftBucket.recalls24h) {
          return rightBucket.recalls24h - leftBucket.recalls24h;
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, 4)
      .map(([source, bucket]) => ({
        label: sourceLabelMap[source] || source,
        value: `${bucket.followupReads24h}/${bucket.indexedResults24h} · ${formatRatePercent(
          bucket.followupReadRate24h,
        )}`,
        meta: `recall ${bucket.recalls24h} · follow-up ${bucket.followupReads24h}`,
      }));
  }, [memorySearchStatus]);
  const memoryPromotionSummaryItems = useMemo(
    () => [
      {
        label: i18n.t('settings.model.候选24h'),
        value: String(memoryPromotionStatus?.candidates24h ?? 0),
      },
      {
        label: i18n.t('settings.model.写入24h'),
        value: String(memoryPromotionStatus?.writes24h ?? 0),
      },
      {
        label: i18n.t('settings.model.去重24h'),
        value: String(memoryPromotionStatus?.deduped24h ?? 0),
      },
      {
        label: i18n.t('settings.model.最近沉淀'),
        value: memoryPromotionStatus?.latestPromotionAt
          ? formatIsoTimestamp(memoryPromotionStatus.latestPromotionAt)
          : '-',
      },
    ],
    [memoryPromotionStatus],
  );
  const memoryPromotionActionItems = useMemo(
    () => [
      {
        label: i18n.t('settings.model.自动沉淀'),
        value: String(memoryPromotionStatus?.byAction24h.auto ?? 0),
      },
      {
        label: i18n.t('settings.model.显式记住'),
        value: String(memoryPromotionStatus?.byAction24h.remember ?? 0),
      },
      {
        label: i18n.t('settings.model.仅本次'),
        value: String(memoryPromotionStatus?.byAction24h.session_only ?? 0),
      },
      {
        label: i18n.t('settings.model.显式动作'),
        value: String(memoryPromotionStatus?.byOrigin24h.explicit_action ?? 0),
      },
    ],
    [memoryPromotionStatus],
  );
  const memoryPromotionClassItems = useMemo(
    () => [
      {
        label: 'Identity',
        value: String(memoryPromotionStatus?.byMemoryClass24h.identity ?? 0),
      },
      {
        label: 'Global',
        value: String(memoryPromotionStatus?.byMemoryClass24h.global_durable ?? 0),
      },
      {
        label: 'Group',
        value: String(memoryPromotionStatus?.byMemoryClass24h.group_durable ?? 0),
      },
      {
        label: 'Session',
        value: String(memoryPromotionStatus?.byMemoryClass24h.session ?? 0),
      },
    ],
    [memoryPromotionStatus],
  );
  const workspaceIssueCount =
    (workspaceCleanupSummary?.orphanDirectories.length ?? 0) +
    (workspaceCleanupSummary?.staleRegisteredGroups.length ?? 0);
  const generalOverviewCards = useMemo(
    (): Array<{
      title: string;
      value: string;
      meta: string;
      tone: 'default' | 'attention' | 'calm';
    }> => [
      {
        title: i18n.t('settings.model.默认Provider'),
        value: currentProviderLabel,
        meta: assistantName ? i18n.t('settings.model.助手_${assistantName}', { param0: assistantName }) : i18n.t('settings.model.当前尚未识别默认Provider'),
        tone: 'default',
      },
      {
        title: i18n.t('settings.model.接入渠道'),
        value: String(status?.channels.length ?? 0),
        meta:
          statusChannelSummary !== '-'
            ? statusChannelSummary
            : i18n.t('settings.model.尚未检测到已接入频道'),
        tone: 'default',
      },
      {
        title: i18n.t('settings.model.Web能力'),
        value: webSearchEnabled ? i18n.t('settings.model.已开启') : i18n.t('settings.model.已关闭'),
        meta: webRuntimeSummary,
        tone: webSearchEnabled ? 'calm' : 'default',
      },
      {
        title: i18n.t('settings.model.子代理编排'),
        value: subagentEnabled ? i18n.t('settings.model.已启用') : i18n.t('settings.model.已关闭'),
        meta: i18n.t('settings.model.深度_活跃上限', { depth: subagentDepthSummary, max: subagentMaxActive }),
        tone: subagentEnabled ? 'calm' : 'default',
      },
      {
        title: i18n.t('settings.model.记忆检索'),
        value: memorySearchOverviewValue,
        meta: memorySearchOverviewMeta,
        tone: memorySearchOverviewTone,
      },
      {
        title: i18n.t('settings.model.运行风险'),
        value: doctorReport
          ? doctorReport.healthy
            ? i18n.t('settings.model.稳定')
            : i18n.t('settings.model.需关注')
          : i18n.t('settings.model.待诊断'),
        meta:
          workspaceIssueCount > 0
            ? i18n.t('settings.model.待清理N项工作区异常', { count: workspaceIssueCount })
            : i18n.t('settings.model.当前未发现待清理工作区问题'),
        tone:
          doctorReport?.healthy === false || workspaceIssueCount > 0
            ? 'attention'
            : 'calm',
      },
    ],
    [
      assistantName,
      currentProviderLabel,
      doctorReport,
      status,
      statusChannelSummary,
      memorySearchOverviewMeta,
      memorySearchOverviewTone,
      memorySearchOverviewValue,
      subagentDepthSummary,
      subagentEnabled,
      subagentMaxActive,
      webRuntimeSummary,
      webSearchEnabled,
      workspaceIssueCount,
    ],
  );
  const runtimeInfoItems = useMemo(
    () => [
      { label: i18n.t('settings.model.助手名称'), value: assistantName || '-' },
      { label: i18n.t('settings.model.当前Provider'), value: currentProviderLabel },
      {
        label: i18n.t('settings.model.接入渠道'),
        value: `${status?.channels.length ?? 0} · ${statusChannelSummary}`,
      },
      {
        label: i18n.t('settings.model.运行时间'),
        value: status ? formatUptime(status.uptime) : '-',
      },
      { label: i18n.t('settings.model.子代理编排'), value: subagentsRuntimeLabel },
      {
        label: i18n.t('settings.model.递归深度'),
        value: String(status?.subagents?.maxDepth ?? subagentMaxDepth),
      },
      {
        label: i18n.t('settings.model.活跃容量'),
        value: subagentActiveCapacityLabel,
      },
      {
        label: i18n.t('settings.model.Claude子代理'),
        value: claudeSubagentRuntimeLabel,
      },
      {
        label: i18n.t('settings.model.Codex子代理'),
        value: codexSubagentRuntimeLabel,
      },
      {
        label: i18n.t('settings.model.股票分析'),
        value: getBooleanValue(basicConfig, 'WEB_STOCK_ANALYSIS_ENABLED')
          ? i18n.t('settings.model.已开启')
          : i18n.t('settings.model.已关闭'),
      },
      {
        label: i18n.t('settings.model.Web终端'),
        value: getBooleanValue(basicConfig, 'WEB_TERMINAL_ENABLED')
          ? i18n.t('settings.model.已开启')
          : i18n.t('settings.model.已关闭'),
      },
      {
        label: i18n.t('settings.model.Codex工具调用上限'),
        value:
          getStringValue(basicConfig, 'CODEX_MAX_TOOL_ITERATIONS') || '100',
      },
      {
        label: i18n.t('settings.model.默认Web搜索'),
        value: webSearchEnabled ? i18n.t('settings.model.已开启') : i18n.t('settings.model.已关闭'),
      },
      {
        label: i18n.t('settings.model.Web运行摘要'),
        value: webRuntimeSummary,
      },
      {
        label: i18n.t('settings.model.Web配置说明'),
        value: webRuntimeDetailNote,
      },
      {
        label: i18n.t('settings.model.不安全TLS'),
        value: getBooleanValue(basicConfig, 'ALLOW_INSECURE_TLS')
          ? i18n.t('settings.model.已开启')
          : i18n.t('settings.model.已关闭'),
      },
    ],
    [
      assistantName,
      basicConfig,
      claudeSubagentRuntimeLabel,
      codexSubagentRuntimeLabel,
      currentProviderLabel,
      formatUptime,
      status,
      statusChannelSummary,
      subagentActiveCapacityLabel,
      subagentMaxDepth,
      subagentsRuntimeLabel,
      webRuntimeDetailNote,
      webRuntimeSummary,
      webSearchEnabled,
    ],
  );
  const doctorSummaryItems = useMemo(
    () => [
      {
        label: i18n.t('settings.model.健康状态'),
        value: doctorReport
          ? doctorReport.healthy
            ? i18n.t('settings.model.通过')
            : i18n.t('settings.model.存在风险')
          : '-',
      },
      {
        label: i18n.t('settings.model.错误数'),
        value: String(doctorReport?.counts.error ?? 0),
      },
      {
        label: i18n.t('settings.model.警告数'),
        value: String(doctorReport?.counts.warn ?? 0),
      },
      {
        label: i18n.t('settings.model.信息数'),
        value: String(doctorReport?.counts.info ?? 0),
      },
    ],
    [doctorReport],
  );
  const workspaceCleanupItems = useMemo(
    () => [
      {
        label: i18n.t('settings.model.孤儿目录'),
        value: String(workspaceCleanupSummary?.orphanDirectories.length ?? 0),
      },
      {
        label: i18n.t('settings.model.僵尸group映射'),
        value: String(
          workspaceCleanupSummary?.staleRegisteredGroups.length ?? 0,
        ),
      },
      {
        label: i18n.t('settings.model.最近清理目录数'),
        value: String(
          workspaceCleanupSummary?.deletedDirectories.length ?? 0,
        ),
      },
      {
        label: i18n.t('settings.model.最近清理session数'),
        value: String(
          workspaceCleanupSummary?.deletedSessionRows.length ?? 0,
        ),
      },
      {
        label: i18n.t('settings.model.最近清理group映射数'),
        value: String(
          workspaceCleanupSummary?.deletedRegisteredGroups.length ?? 0,
        ),
      },
    ],
    [workspaceCleanupSummary],
  );
  const [senderTrustMode, setSenderTrustMode] = useState<'trigger' | 'drop'>(
    'trigger',
  );
  const [senderTrustAllowAll, setSenderTrustAllowAll] = useState(true);
  const [senderTrustAllowText, setSenderTrustAllowText] = useState('');
  const [senderTrustLogDenied, setSenderTrustLogDenied] = useState(true);
  const [senderTrustOverridesText, setSenderTrustOverridesText] =
    useState('{}');
  const [senderTrustOverridesError, setSenderTrustOverridesError] =
    useState('');
  const browserSiteProfilesDraft = getStringValue(
    basicConfig,
    'WEB_FETCH_BROWSER_SITE_PROFILES',
  );
  const browserSiteProfilesDraftState = useMemo(
    () => parseBrowserSiteProfilesDraft(browserSiteProfilesDraft),
    [browserSiteProfilesDraft],
  );
  const hasBuiltinWebFetchSiteProfilePresets =
    builtinWebFetchSiteProfilePresets.length > 0;
  const webFetchSiteProfilePresetOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: '__all__', label: i18n.t('settings.model.全部内置规则') },
      ...builtinWebFetchSiteProfilePresets.map((preset) => ({
        value: preset.id,
        label: preset.label,
      })),
    ],
    [builtinWebFetchSiteProfilePresets],
  );
  const selectedSiteProfilePresetLabel = useMemo(
    () =>
      webFetchSiteProfilePresetOptions.find(
        (option) => option.value === siteProfilePreset,
      )?.label || i18n.t('settings.model.全部内置规则'),
    [siteProfilePreset, webFetchSiteProfilePresetOptions],
  );
  useEffect(() => {
    setSiteProfileToolMessage('');
  }, [browserSiteProfilesDraft]);

  useEffect(() => {
    if (!senderTrustConfig) return;
    setSenderTrustMode(senderTrustConfig.default.mode);
    setSenderTrustAllowAll(senderTrustConfig.default.allow === '*');
    setSenderTrustAllowText(
      senderTrustConfig.default.allow === '*'
        ? ''
        : senderTrustConfig.default.allow.join(', '),
    );
    setSenderTrustLogDenied(senderTrustConfig.logDenied !== false);
    setSenderTrustOverridesText(
      JSON.stringify(senderTrustConfig.chats || {}, null, 2),
    );
    setSenderTrustOverridesError('');
  }, [senderTrustConfig]);

  const addMcpServer = () => {
    setMcpLocalMessage('');
    setMcpDraft((prev) => [...prev, createManagedMcpDraft()]);
  };

  const removeMcpServer = (id: string) => {
    setMcpLocalMessage('');
    setMcpDraft((prev) => prev.filter((server) => server.id !== id));
  };

  const updateMcpServer = (
    id: string,
    updater: (server: ManagedMcpServer) => ManagedMcpServer,
  ) => {
    setMcpLocalMessage('');
    setMcpDraft((prev) =>
      prev.map((server) =>
        server.id === id
          ? normalizeManagedMcpServer(
              updater(normalizeManagedMcpServer(server)),
            )
          : server,
      ),
    );
  };

  const importMcpFromJson = () => {
    const parsed = parseManagedMcpJson(mcpJsonDraft);
    if (parsed.error) {
      setMcpLocalMessage(parsed.error);
      return;
    }
    if (parsed.servers.length === 0) {
      setMcpLocalMessage(i18n.t('settings.model.JSON中没有可导入的MCP'));
      return;
    }

    setMcpDraft((prev) => {
      const next = new Map(
        prev.map((server) => [normalizeManagedMcpServer(server).id, server]),
      );
      for (const server of parsed.servers) {
        next.set(server.id, server);
      }
      return Array.from(next.values());
    });
    setMcpJsonDraft('');
    setMcpLocalMessage(
      i18n.t('settings.model.已从JSON导入MCP', { count: parsed.servers.length }),
    );
  };

  const handleSaveMcp = async () => {
    const validationError = validateManagedMcpDraft(normalizedMcpDraft);
    if (validationError) {
      setMcpLocalMessage(validationError);
      return;
    }
    const ok = await saveManagedMcpServers(normalizedMcpDraft);
    if (!ok) return;
    setMcpLocalMessage('');
    setMcpDraft((prev) => prev.map((item) => ({ ...item })));
  };

  const toggleSkillEnabled = (skillId: string) => {
    const enabled = new Set(
      managedSkills.filter((skill) => skill.enabled).map((skill) => skill.id),
    );
    if (enabled.has(skillId)) enabled.delete(skillId);
    else enabled.add(skillId);
    void saveEnabledSkills(Array.from(enabled));
  };

  const handleInstallSkillFromPath = async () => {
    if (!skillInstallDraft.sourcePath.trim()) return;
    const ok = await installSkillFromPath({
      sourcePath: skillInstallDraft.sourcePath.trim(),
      skillId: skillInstallDraft.skillId.trim(),
      overwrite: skillInstallDraft.overwrite,
    });
    if (!ok) return;
    setSkillInstallDraft((prev) => ({ ...prev, sourcePath: '', skillId: '' }));
  };

  const handleInstallMcpFromPath = async () => {
    if (!mcpInstallDraft.sourcePath.trim()) return;
    const ok = await installManagedMcpFromPath({
      sourcePath: mcpInstallDraft.sourcePath.trim(),
      id: mcpInstallDraft.id.trim(),
      name: mcpInstallDraft.name.trim(),
      entryFile: mcpInstallDraft.entryFile.trim(),
      overwrite: mcpInstallDraft.overwrite,
    });
    if (!ok) return;
    setMcpInstallDraft((prev) => ({
      ...prev,
      sourcePath: '',
      id: '',
      name: '',
      entryFile: '',
    }));
  };

  const pickSkillInstallDirectory = async () => {
    try {
      const selected = await pickNativeDirectory();
      if (!selected) return;
      setSkillInstallDraft((prev) => ({ ...prev, sourcePath: selected }));
    } catch {
      // ignore picker error
    }
  };

  const pickMcpInstallDirectory = async () => {
    try {
      const selected = await pickNativeDirectory();
      if (!selected) return;
      setMcpInstallDraft((prev) => ({ ...prev, sourcePath: selected }));
    } catch {
      // ignore picker error
    }
  };

  const addMarketplaceSource = () => {
    setMarketplaceCatalogMessage('');
    setMarketplaceDraft((prev) => [...prev, createMarketplaceSourceDraft()]);
  };

  const removeMarketplaceSource = (draftKey: string) => {
    setMarketplaceCatalogMessage('');
    setMarketplaceDraft((prev) =>
      prev.filter((entry) => entry.draftKey !== draftKey),
    );
  };

  const updateMarketplaceSource = (
    draftKey: string,
    updater: (
      source: ExtensionMarketplaceSourceDraft,
    ) => ExtensionMarketplaceSourceDraft,
  ) => {
    setMarketplaceCatalogMessage('');
    setMarketplaceDraft((prev) =>
      prev.map((entry) =>
        entry.draftKey === draftKey
          ? (() => {
              const next = updater({ ...entry });
              return {
                ...next,
                id: slugifyMarketplaceSourceId(
                  next.id || next.name || entry.id,
                ),
              };
            })()
          : entry,
      ),
    );
  };

  const handleSaveMarketplaceSources = async () => {
    const normalized = marketplaceDraft
      .map((entry) => ({
        id: slugifyMarketplaceSourceId(entry.id || entry.name),
        name:
          entry.name.trim() ||
          slugifyMarketplaceSourceId(entry.id || entry.name),
        source: entry.source.trim(),
        enabled: entry.enabled !== false,
      }))
      .filter((entry) => entry.source);
    if (normalized.length === 0 && marketplaceDraft.length > 0) {
      setMarketplaceCatalogMessage(i18n.t('settings.model.市场源至少需要填写source'));
      return;
    }
    const ok = await saveExtensionMarketplaceSources(normalized);
    if (!ok) return;
    setMarketplaceCatalogMessage(i18n.t('settings.model.市场源已保存'));
  };

  const refreshMarketplaceCatalog = useCallback(
    async (input?: { sourceDraftKey?: string }) => {
      const requestId = marketplaceCatalogRequestIdRef.current + 1;
      marketplaceCatalogRequestIdRef.current = requestId;
      setMarketplaceCatalogLoading(true);
      setMarketplaceCatalogMessage('');

      const currentDrafts = marketplaceDraftRef.current;
      const targets = (input?.sourceDraftKey
        ? currentDrafts.filter((entry) => entry.draftKey === input.sourceDraftKey)
        : currentDrafts.filter((entry) => entry.enabled !== false)
      )
        .map((entry) => ({
          ...entry,
          source: entry.source.trim(),
          name: entry.name.trim() || entry.id.trim(),
        }))
        .filter((entry) => entry.source);

      if (targets.length === 0) {
        if (marketplaceCatalogRequestIdRef.current === requestId) {
          setMarketplaceCatalog([]);
          setMarketplaceCatalogMessage(
            input?.sourceDraftKey
              ? i18n.t('settings.model.该市场源至少需要填写source')
              : i18n.t('settings.model.当前市场源未返回可安装条目'),
          );
          setMarketplaceCatalogLoading(false);
        }
        return;
      }

      try {
        const entryGroups = await Promise.all(
          targets.map(async (target) => {
            const entries = await loadExtensionMarketplaceCatalog({
              source: target.source,
            });
            return entries.map((entry) => {
              const canInstallBySourceId =
                target.persistedId === target.id &&
                (target.persistedSource || '').trim() === target.source;
              return {
                ...entry,
                sourceId: target.id,
                sourceName: target.name,
                sourceLabel: target.source,
                installSourceId: canInstallBySourceId
                  ? target.id
                  : undefined,
                installSource: canInstallBySourceId ? undefined : target.source,
              } satisfies ExtensionCatalogPreviewEntry;
            });
          }),
        );
        if (marketplaceCatalogRequestIdRef.current !== requestId) {
          return;
        }
        const nextEntries = entryGroups.flat();
        setMarketplaceCatalog(nextEntries);
        if (nextEntries.length === 0) {
          setMarketplaceCatalogMessage(i18n.t('settings.model.当前市场源未返回可安装条目'));
        }
      } catch (err) {
        if (marketplaceCatalogRequestIdRef.current !== requestId) {
          return;
        }
        setMarketplaceCatalogMessage(
          err instanceof Error ? err.message : i18n.t('settings.model.市场目录加载失败'),
        );
      } finally {
        if (marketplaceCatalogRequestIdRef.current === requestId) {
          setMarketplaceCatalogLoading(false);
        }
      }
    },
    [loadExtensionMarketplaceCatalog],
  );

  const handleImportExtension = async () => {
    if (!extensionImportDraft.source.trim()) return;
    const ok = await importExtensionFromSource({
      source: extensionImportDraft.source.trim(),
      installId: extensionImportDraft.installId.trim() || undefined,
      name: extensionImportDraft.name.trim() || undefined,
      overwrite: extensionImportDraft.overwrite,
    });
    if (!ok) return;
    setExtensionImportDraft((prev) => ({
      ...prev,
      source: '',
      installId: '',
      name: '',
    }));
  };

  const pickExtensionImportDirectory = async () => {
    try {
      const selected = await pickNativeDirectory();
      if (!selected) return;
      setExtensionImportDraft((prev) => ({ ...prev, source: selected }));
    } catch {
      // ignore picker error
    }
  };

  useEffect(() => {
    if (settingsTab !== 'extensions') return;
    if (extensionMarketplaceSources.length === 0) {
      setMarketplaceCatalog([]);
      return;
    }
    void refreshMarketplaceCatalog();
  }, [extensionMarketplaceSources, refreshMarketplaceCatalog, settingsTab]);

  const loadSkillDetail = useCallback(
    async (skillId: string) => {
      if (!skillId.trim()) return;
      if (skillDetailsById[skillId] || skillDetailLoadingById[skillId]) return;

      setSkillDetailLoadingById((prev) => ({ ...prev, [skillId]: true }));
      setSkillDetailErrorById((prev) => {
        const next = { ...prev };
        delete next[skillId];
        return next;
      });

      try {
        const res = await fetch(
          `${apiBase}/api/skills/${encodeURIComponent(skillId)}`,
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setSkillDetailErrorById((prev) => ({
            ...prev,
            [skillId]: data.error || i18n.t('settings.model.Skill详情加载失败'),
          }));
          return;
        }
        const data = (await res.json()) as ManagedSkillDetail;
        setSkillDetailsById((prev) => ({
          ...prev,
          [skillId]: data,
        }));
      } catch {
        setSkillDetailErrorById((prev) => ({
          ...prev,
          [skillId]: i18n.t('settings.model.Skill详情加载失败_重试'),
        }));
      } finally {
        setSkillDetailLoadingById((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [apiBase, skillDetailsById, skillDetailLoadingById],
  );

  const updateConfigValue = useCallback(
    (key: string, value: string | boolean) => {
      setBasicConfig((prev) => ({ ...prev, [key]: value }));
    },
    [setBasicConfig],
  );

  const updateDefaultAllowedDirectories = useCallback(
    (directories: string[]) => {
      const normalized = Array.from(
        new Set(directories.map((directory) => directory.trim()).filter(Boolean)),
      );
      updateConfigValue(
        'allowed_directories',
        normalized.length > 0 ? JSON.stringify(normalized, null, 2) : '',
      );
    },
    [updateConfigValue],
  );

  const addDefaultDirectory = useCallback(
    (candidate = defaultDirectoryDraft) => {
      const trimmed = candidate.trim();
      if (!trimmed) {
        setDefaultDirectoryError(i18n.t('settings.model.请先输入目录路径'));
        return;
      }
      if (defaultAllowedDirectories.includes(trimmed)) {
        setDefaultDirectoryError(i18n.t('settings.model.该目录已在默认模板中'));
        return;
      }
      updateDefaultAllowedDirectories([...defaultAllowedDirectories, trimmed]);
      setDefaultDirectoryDraft('');
      setDefaultDirectoryError('');
    },
    [
      defaultAllowedDirectories,
      defaultDirectoryDraft,
      updateDefaultAllowedDirectories,
    ],
  );

  const removeDefaultDirectory = useCallback(
    (index: number) => {
      updateDefaultAllowedDirectories(
        defaultAllowedDirectories.filter((_, itemIndex) => itemIndex !== index),
      );
      setDefaultDirectoryError('');
    },
    [defaultAllowedDirectories, updateDefaultAllowedDirectories],
  );

  const chooseDefaultDirectory = useCallback(async () => {
    if (pickingDefaultDirectory) return;
    setPickingDefaultDirectory(true);
    setDefaultDirectoryError('');
    try {
      const selected = await pickNativeDirectory();
      if (!selected) return;
      addDefaultDirectory(selected);
    } catch (err) {
      setDefaultDirectoryError(
        err instanceof Error ? err.message : i18n.t('settings.model.打开目录选择器失败'),
      );
    } finally {
      setPickingDefaultDirectory(false);
    }
  }, [addDefaultDirectory, pickNativeDirectory, pickingDefaultDirectory]);

  const updateBashApprovalAllowlist = (rules: BashApprovalAllowRule[]) => {
    updateConfigValue(
      'BASH_APPROVAL_ALLOWLIST',
      JSON.stringify(rules, null, 2),
    );
  };

  const addBashApprovalAllowRule = () => {
    const parsed = parseBashApprovalPrefixInput(bashApprovalCommandDraft);
    if (parsed.error) {
      setBashApprovalAllowlistMessage(parsed.error);
      return;
    }
    updateBashApprovalAllowlist([
      ...bashApprovalAllowlistState.rules,
      {
        id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prefix: parsed.prefix,
        label: formatBashApprovalPrefix(parsed.prefix),
        enabled: true,
        createdAt: new Date().toISOString(),
        createdFrom: 'manual',
      },
    ]);
    setBashApprovalCommandDraft('');
    setBashApprovalAllowlistMessage(i18n.t('settings.model.已添加Bash白名单规则草稿'));
  };

  const toggleBashApprovalAllowRule = (ruleId: string) => {
    updateBashApprovalAllowlist(
      bashApprovalAllowlistState.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule,
      ),
    );
    setBashApprovalAllowlistMessage('');
  };

  const deleteBashApprovalAllowRule = (ruleId: string) => {
    updateBashApprovalAllowlist(
      bashApprovalAllowlistState.rules.filter((rule) => rule.id !== ruleId),
    );
    setBashApprovalAllowlistMessage('');
  };

  const importFetchSiteProfilePreset = useCallback((replace = false) => {
    if (!hasBuiltinWebFetchSiteProfilePresets) {
      setSiteProfileToolMessage(i18n.t('settings.model.当前没有可用的内置站点规则'));
      return;
    }
    const selectedProfiles =
      siteProfilePreset === '__all__'
        ? builtinWebFetchSiteProfilePresets.map((preset) => preset.profile)
        : builtinWebFetchSiteProfilePresets
            .filter((preset) => preset.id === siteProfilePreset)
            .map((preset) => preset.profile);
    if (selectedProfiles.length === 0) return;

    if (replace) {
      updateConfigValue(
        'WEB_FETCH_BROWSER_SITE_PROFILES',
        JSON.stringify(selectedProfiles, null, 2),
      );
      setSiteProfileToolMessage(
        i18n.t('settings.model.已用预置规则替换', { count: selectedProfiles.length }),
      );
      return;
    }

    if (browserSiteProfilesDraftState.error) {
      setSiteProfileToolMessage(browserSiteProfilesDraftState.error);
      return;
    }

    const existingProfiles = browserSiteProfilesDraftState.profiles;
    const toKey = (profile: Record<string, unknown>) =>
      JSON.stringify({
        domains: Array.isArray(profile.domains) ? profile.domains : [],
        pathPrefixes: Array.isArray(profile.pathPrefixes)
          ? profile.pathPrefixes
          : [],
      });
    const mergedProfiles = [...existingProfiles];
    const seen = new Set(existingProfiles.map((profile) => toKey(profile)));
    for (const profile of selectedProfiles) {
      const key = toKey(profile as unknown as Record<string, unknown>);
      if (seen.has(key)) continue;
      seen.add(key);
      mergedProfiles.push(profile as unknown as Record<string, unknown>);
    }
    updateConfigValue(
      'WEB_FETCH_BROWSER_SITE_PROFILES',
      JSON.stringify(mergedProfiles, null, 2),
    );
    setSiteProfileToolMessage(
      i18n.t('settings.model.已插入N条预置规则', { count: Math.max(0, mergedProfiles.length - existingProfiles.length) }),
    );
  }, [
    browserSiteProfilesDraftState,
    builtinWebFetchSiteProfilePresets,
    hasBuiltinWebFetchSiteProfilePresets,
    siteProfilePreset,
    updateConfigValue,
  ]);

  const validateFetchSiteProfilesDraft = useCallback(() => {
    if (browserSiteProfilesDraftState.error) {
      setSiteProfileToolMessage(browserSiteProfilesDraftState.error);
      return;
    }
    setSiteProfileToolMessage(
      i18n.t('settings.model.校验通过N条规则', { count: browserSiteProfilesDraftState.profiles.length }),
    );
  }, [browserSiteProfilesDraftState]);

  const formatFetchSiteProfilesDraft = useCallback(() => {
    if (browserSiteProfilesDraftState.error) {
      setSiteProfileToolMessage(browserSiteProfilesDraftState.error);
      return;
    }
    updateConfigValue(
      'WEB_FETCH_BROWSER_SITE_PROFILES',
      JSON.stringify(browserSiteProfilesDraftState.profiles, null, 2),
    );
    setSiteProfileToolMessage(i18n.t('settings.model.已格式化当前自定义规则JSON'));
  }, [browserSiteProfilesDraftState, updateConfigValue]);

  const clearFetchSiteProfilesDraft = useCallback(() => {
    updateConfigValue('WEB_FETCH_BROWSER_SITE_PROFILES', '');
    setSiteProfileToolMessage(i18n.t('settings.model.已清空当前自定义规则'));
  }, [updateConfigValue]);

  const restoreBuiltinFetchSiteProfiles = useCallback(() => {
    if (!hasBuiltinWebFetchSiteProfilePresets) {
      setSiteProfileToolMessage(i18n.t('settings.model.当前没有可用的内置站点规则'));
      return;
    }
    setSiteProfilePreset('__all__');
    updateConfigValue(
      'WEB_FETCH_BROWSER_SITE_PROFILES',
      JSON.stringify(
        builtinWebFetchSiteProfilePresets.map((preset) => preset.profile),
        null,
        2,
      ),
    );
    setSiteProfileToolMessage(i18n.t('settings.model.已恢复为全部内置站点规则'));
  }, [
    builtinWebFetchSiteProfilePresets,
    hasBuiltinWebFetchSiteProfilePresets,
    updateConfigValue,
  ]);

  const updateChannelInstance = useCallback((
    id: string,
    updater: (instance: ChannelInstanceConfig) => ChannelInstanceConfig,
  ) => {
    setChannelInstances((prev) =>
      prev.map((instance) =>
        instance.id === id ? updater(instance) : instance,
      ),
    );
  }, [setChannelInstances]);

  const removeChannelInstance = (id: string) => {
    setChannelInstances((prev) =>
      prev.filter((instance) => instance.id !== id),
    );
  };

  const renderBasicConfigField = useMemo(
    () =>
      createRenderBasicConfigField({
        basicConfig,
        configMeta,
        formatConfigEffectLabel,
        updateConfigValue,
        webLoginEnabled,
        webSearchEnabled,
        webSearchProvider,
        webFetchProvider,
        browserConnectionMode,
        visiblePasswords,
        setVisiblePasswords,
        siteProfilePreset,
        setSiteProfilePreset,
        webFetchSiteProfilePresetOptions,
        hasBuiltinWebFetchSiteProfilePresets,
        browserSiteProfilesDraftState,
        siteProfileToolMessage,
        selectedSiteProfilePresetLabel,
        importFetchSiteProfilePreset,
        validateFetchSiteProfilesDraft,
        formatFetchSiteProfilesDraft,
        clearFetchSiteProfilesDraft,
        restoreBuiltinFetchSiteProfiles,
      }),
    [
      basicConfig,
      configMeta,
      formatConfigEffectLabel,
      updateConfigValue,
      webLoginEnabled,
      webSearchEnabled,
      webSearchProvider,
      webFetchProvider,
      browserConnectionMode,
      visiblePasswords,
      siteProfilePreset,
      webFetchSiteProfilePresetOptions,
      hasBuiltinWebFetchSiteProfilePresets,
      browserSiteProfilesDraftState,
      siteProfileToolMessage,
      selectedSiteProfilePresetLabel,
      importFetchSiteProfilePreset,
      validateFetchSiteProfilesDraft,
      formatFetchSiteProfilesDraft,
      clearFetchSiteProfilesDraft,
      restoreBuiltinFetchSiteProfiles,
    ],
  );

  const renderChannelField = useMemo(
    () =>
      createRenderChannelField({
        formatConfigEffectLabel,
        updateChannelInstance,
        visiblePasswords,
        setVisiblePasswords,
      }),
    [formatConfigEffectLabel, updateChannelInstance, visiblePasswords, setVisiblePasswords],
  );

  const boundRenderSensitiveInput = useCallback(
    (
      inputId: string,
      value: string,
      onChange: (next: string) => void,
      placeholder?: string,
      disabled = false,
    ) =>
      renderSensitiveInput(
        visiblePasswords,
        setVisiblePasswords,
        inputId,
        value,
        onChange,
        placeholder,
        disabled,
      ),
    [visiblePasswords, setVisiblePasswords],
  );


  const canAddChannelInstance = (type: ChannelTypeDefinition) =>
    type.allowMultiple ||
    !channelInstances.some((instance) => instance.type === type.type);

  const getOrderedChannelFields = (type: ChannelTypeDefinition) => {
    if (type.type !== 'feishu') return type.fields;
    const replyField = type.fields.find(
      (field: ChannelFieldDefinition) => field.key === 'replyInThread',
    );
    if (!replyField) return type.fields;
    return [
      replyField,
      ...type.fields.filter(
        (field: ChannelFieldDefinition) => field.key !== 'replyInThread',
      ),
    ];
  };

  const isChannelMessageError = /失败|错误|error/i.test(channelConfigMessage);
  const isSenderTrustMessageError = /失败|错误|error/i.test(senderTrustMessage);

  const saveSenderTrust = async () => {
    const parsed = parseSenderTrustOverrides(senderTrustOverridesText);
    if (parsed.error) {
      setSenderTrustOverridesError(parsed.error);
      return;
    }
    setSenderTrustOverridesError('');
    const allow = senderTrustAllowAll
      ? '*'
      : senderTrustAllowText
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
    await saveSenderTrustConfig({
      default: {
        allow: allow === '*' ? '*' : allow,
        mode: senderTrustMode,
      },
      chats: parsed.overrides,
      logDenied: senderTrustLogDenied,
    });
  };

  const saveSubagentConfig = async () => {
    setSubagentSaving(true);
    setSubagentMessage('');
    try {
      const res = await fetch(`${apiBase}/api/subagents/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: subagentEnabled,
          maxDepth: subagentMaxDepth,
          maxActive: subagentMaxActive,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setSubagentMessageTone('error');
        setSubagentMessage(data.error || i18n.t('settings.model.保存失败_重试'));
        return;
      }
      setSubagentMessageTone('success');
      setSubagentMessage(i18n.t('settings.model.子代理配置已保存'));
    } catch {
      setSubagentMessageTone('error');
      setSubagentMessage(i18n.t('settings.model.保存失败_检查网络'));
    } finally {
      setSubagentSaving(false);
    }
  };

  useEffect(() => {
    if (!editingProvider) return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditingProvider(null);
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [editingProvider, setEditingProvider]);

  const isStandaloneMaintenancePage =
    hideSettingsTabs &&
    ['extensions', 'mcp', 'skills'].includes(settingsTab as string);


  return {
    settingsTab,
    setSettingsTab,
    hideSettingsTabs,
    pageTitle,
    visibleTabs,
    isStandaloneMaintenancePage,
    defaultAccessPolicyRef,
    renderBooleanField,
    renderSensitiveInput: boundRenderSensitiveInput,
    renderBasicConfigField,
    renderChannelField,
    saveSenderTrust,
    isSenderTrustMessageError,
    isChannelMessageError,
    saveSubagentConfig,
    apiBase,
    setEditingProvider,
    providers,
    testResults,
    testProvider,
    testingId,
    activateProvider,
    activateGlobalProvider,
    clearDefaultProvider,
    deleteProviderById,
    editingProvider,
    saveProvider,
    hasSystemSettings,
    channelTypes,
    channelInstances,
    setChannelInstances,
    addChannelInstance,
    saveChannelSettings,
    savingChannelConfig,
    channelConfigMessage,
    removeChannelInstance,
    updateChannelInstance,
    generalOverviewCards,
    defaultAccessModeLabel,
    enabledAssistantCount,
    assistants,
    defaultProviderAlias,
    defaultDirectoryTemplateCount,
    configMeta,
    formatConfigEffectLabel,
    selectedDefaultAccessPolicy,
    defaultAccessModeValue,
    defaultAllowedDirectories,
    defaultDirectoryDraft,
    setDefaultDirectoryDraft,
    defaultDirectoryError,
    addDefaultDirectory,
    removeDefaultDirectory,
    chooseDefaultDirectory,
    pickingDefaultDirectory,
    updateConfigValue,
    primaryConfigKeys,
    advancedWebConfigKeys,
    browserControlConfigKeys,
    memoryConfigKeys,
    knowledgeConfigKeys,
    webSearchConfigKeys,
    authConfigKeys,
    bashApprovalCommandDraft,
    setBashApprovalCommandDraft,
    bashApprovalAllowlistState,
    bashApprovalAllowlistMessage,
    setBashApprovalAllowlistMessage,
    addBashApprovalAllowRule,
    updateBashApprovalAllowlist,
    toggleBashApprovalAllowRule,
    deleteBashApprovalAllowRule,
    saveBasicSettings,
    savingBasicConfig,
    basicConfigMessage,
    assistantNameValue,
    webPortValue,
    webLoginEnabled,
    getStringValue,
    basicConfig,
    setBasicConfig,
    DEFAULT_ACCESS_POLICY_OPTIONS: getDefaultAccessPolicyOptions(),
    canAddChannelInstance,
    getOrderedChannelFields,
    senderTrustMode,
    setSenderTrustMode,
    senderTrustAllowAll,
    setSenderTrustAllowAll,
    senderTrustAllowText,
    setSenderTrustAllowText,
    senderTrustLogDenied,
    setSenderTrustLogDenied,
    senderTrustOverridesText,
    setSenderTrustOverridesText,
    senderTrustOverridesError,
    setSenderTrustOverridesError,
    savingSenderTrust,
    senderTrustMessage,
    runtimeInfoItems,
    memoryPromotionSummaryItems,
    memoryPromotionActionItems,
    memoryPromotionClassItems,
    memorySearchSummaryItems,
    memorySearchScopeItems,
    memorySearchSourceItems,
    memorySearchTopGroupItems,
    doctorSummaryItems,
    doctorReport,
    doctorLoading,
    refreshDoctorReport,
    workspaceCleanupItems,
    workspaceCleanupSummary,
    workspaceCleanupMessage,
    scanningWorkspaces,
    cleaningWorkspaces,
    refreshWorkspaceCleanupSummary,
    cleanupOrphanWorkspaces,
    subagentEnabled,
    setSubagentEnabled,
    subagentMaxDepth,
    setSubagentMaxDepth,
    subagentMaxActive,
    setSubagentMaxActive,
    subagentSaving,
    subagentMessage,
    subagentMessageTone,
    subagentDepthSummary,
    subagentMaxActiveSummary,
    subagentActiveCapacityLabel,
    subagentRuntime,
    subagentRuntimeItems,
    subagentRuntimeActionKey,
    stopSubagentRuntime,
    sendSubagentRuntimeMessage,
    steerSubagentRuntime,
    hasLive2dManage,
    extensionMarketplaceSources,
    extensionInstalls,
    extensionActionStatus,
    extensionsLoading,
    savingMcpConfig,
    savingSkillsConfig,
    extensionsMessage,
    managedSkills,
    openCommandGuideChat,
    deleteCustomSkill,
    saveEnabledSkills,
    installSkillFromPath,
    saveExtensionMarketplaceSources,
    loadExtensionMarketplaceCatalog,
    installMarketplaceExtension,
    importExtensionFromSource,
    uninstallExtensionInstall,
    reconcileExtensionInstalls,
    saveManagedMcpServers,
    installManagedMcpFromPath,
    pickNativeDirectory,
    marketplaceDraft,
    setMarketplaceDraft,
    marketplaceCatalog,
    marketplaceCatalogLoading,
    marketplaceCatalogMessage,
    groupedMarketplaceCatalog,
    extensionImportDraft,
    setExtensionImportDraft,
    refreshMarketplaceCatalog,
    addMarketplaceSource,
    removeMarketplaceSource,
    updateMarketplaceSource,
    handleSaveMarketplaceSources,
    handleImportExtension,
    pickExtensionImportDirectory,
    mcpDraft,
    setMcpDraft,
    normalizedMcpDraft,
    mcpEnvTextById,
    mcpInstallDraft,
    setMcpInstallDraft,
    mcpJsonDraft,
    setMcpJsonDraft,
    mcpLocalMessage,
    setMcpLocalMessage,
    addMcpServer,
    removeMcpServer,
    updateMcpServer,
    importMcpFromJson,
    handleSaveMcp,
    handleInstallMcpFromPath,
    pickMcpInstallDirectory,
    skillInstallDraft,
    setSkillInstallDraft,
    handleInstallSkillFromPath,
    pickSkillInstallDirectory,
    toggleSkillEnabled,
    skillDetailsById,
    skillDetailLoadingById,
    skillDetailErrorById,
    loadSkillDetail,
  };

}
