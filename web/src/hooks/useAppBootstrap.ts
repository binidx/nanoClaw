import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import i18n from '../i18n/index.ts';

import {
  BASIC_CONFIG_DEFAULTS,
  type AiProvider,
  type Assistant,
  type AuthStatus,
  type BasicConfigState,
  type ChannelTypeDefinition,
  type ChannelInstanceConfig,
  type ConfigKeyMetadata,
  type Conversation,
  type ConversationCreateTargetDefinition,
  type DoctorReport,
  type ExtensionInstallRecord,
  type ExtensionMarketplaceSource,
  type ManagedMcpServer,
  type ManagedSkill,
  type StatusInfo,
  type StatusLocalCapability,
  type WorkspaceCleanupSummary,
} from '../app-types';

function normalizeConfigValue(
  rawValue: unknown,
  fallbackValue: string | boolean | undefined,
): string | boolean {
  if (typeof fallbackValue === 'boolean') {
    return rawValue === 'true' || rawValue === true;
  }

  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (typeof rawValue === 'string') return rawValue;
  if (typeof fallbackValue === 'string') return fallbackValue;
  return '';
}

function mergeByType<T extends { type: string }>(
  builtin: T[],
  incoming: T[],
): T[] {
  const incomingMap = new Map(incoming.map((entry) => [entry.type, entry]));
  const merged = builtin.map((entry) => {
    const override = incomingMap.get(entry.type);
    if (!override) return entry;
    const overrideFields = (override as { fields?: unknown }).fields;
    return {
      ...entry,
      ...override,
      ...(Array.isArray(overrideFields) && overrideFields.length > 0
        ? { fields: overrideFields }
        : 'fields' in entry
          ? { fields: (entry as { fields?: unknown }).fields }
          : {}),
    } as T;
  });
  for (const entry of incoming) {
    if (!builtin.some((item) => item.type === entry.type)) {
      merged.push(entry);
    }
  }
  return merged;
}

export function normalizeArrayPayload<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringPayload(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNumberPayload(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBooleanPayload(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeLocalCapabilityStatus(
  value: unknown,
): StatusLocalCapability | undefined {
  if (!isRecord(value)) return undefined;
  const id = normalizeStringPayload(value.id);
  const configKey = normalizeStringPayload(value.configKey);
  const permission = normalizeStringPayload(value.permission);
  const reason = normalizeStringPayload(value.reason);
  if (!id || !permission || !reason) return undefined;
  return {
    id,
    configKey,
    permission,
    enabled: value.enabled === true,
    available: value.available === true,
    multiUserMode: value.multiUserMode === true,
    reason,
  };
}

export function normalizeStatusInfo(value: unknown): StatusInfo {
  const payload = isRecord(value) ? value : {};
  const agents = isRecord(payload.agents) ? payload.agents : {};
  const subagents = isRecord(payload.subagents) ? payload.subagents : null;
  const capabilities = isRecord(payload.capabilities)
      ? {
          terminal: normalizeLocalCapabilityStatus(payload.capabilities.terminal),
          browserControl: normalizeLocalCapabilityStatus(
            payload.capabilities.browserControl,
          ),
          localInstall: normalizeLocalCapabilityStatus(
            payload.capabilities.localInstall,
          ),
        }
      : undefined;

  return {
    assistant: normalizeStringPayload(payload.assistant),
    provider: normalizeStringPayload(payload.provider),
    providerAlias: normalizeStringPayload(payload.providerAlias),
    channels: normalizeArrayPayload<{ name?: unknown; connected?: unknown }>(
      payload.channels,
    )
      .map((channel) => {
        const record = isRecord(channel) ? channel : {};
        return {
          name: normalizeStringPayload(record.name),
          connected: record.connected === true,
        };
      })
      .filter((channel) => channel.name),
    agents: {
      activeAgents: normalizeNumberPayload(agents.activeAgents),
      queuedTasks: normalizeNumberPayload(agents.queuedTasks),
    },
    uptime: normalizeNumberPayload(payload.uptime),
    stockAnalysisEnabled: normalizeBooleanPayload(payload.stockAnalysisEnabled),
    webTerminalEnabled: normalizeBooleanPayload(payload.webTerminalEnabled),
    capabilities,
    allowInsecureTls: normalizeBooleanPayload(payload.allowInsecureTls),
    subagentsEnabled: normalizeBooleanPayload(payload.subagentsEnabled),
    subagents: subagents
      ? {
          controlPlaneVersion:
            typeof subagents.controlPlaneVersion === 'string'
              ? subagents.controlPlaneVersion
              : undefined,
          enabled: subagents.enabled === true,
          maxDepth: normalizeNumberPayload(subagents.maxDepth),
          maxActive: normalizeNumberPayload(subagents.maxActive),
          activeCount: normalizeNumberPayload(subagents.activeCount),
          providers: isRecord(subagents.providers)
            ? (subagents.providers as NonNullable<
                StatusInfo['subagents']
              >['providers'])
            : {},
        }
      : undefined,
    memory: isRecord(payload.memory)
      ? (payload.memory as StatusInfo['memory'])
      : undefined,
  };
}

type UseAppBootstrapParams = {
  apiBase: string;
  builtinChannelTypes: ChannelTypeDefinition[];
  builtinConversationTargets: ConversationCreateTargetDefinition[];
  configMetaRef: MutableRefObject<Record<string, ConfigKeyMetadata>>;
  isSensitiveConfigKey: (key: string, metadata?: ConfigKeyMetadata) => boolean;
  setAuthStatus: Dispatch<SetStateAction<AuthStatus | null>>;
  setLoginForm: Dispatch<
    SetStateAction<{ username: string; password: string }>
  >;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  setProviders: Dispatch<SetStateAction<AiProvider[]>>;
  setStatus: Dispatch<SetStateAction<StatusInfo | null>>;
  setConfigMeta: Dispatch<SetStateAction<Record<string, ConfigKeyMetadata>>>;
  setBasicConfig: Dispatch<SetStateAction<BasicConfigState>>;
  setChannelTypes: Dispatch<SetStateAction<ChannelTypeDefinition[]>>;
  setConversationTargets: Dispatch<
    SetStateAction<ConversationCreateTargetDefinition[]>
  >;
  setChannelInstances: Dispatch<SetStateAction<ChannelInstanceConfig[]>>;
  setManagedMcpServers: Dispatch<SetStateAction<ManagedMcpServer[]>>;
  setManagedSkills: Dispatch<SetStateAction<ManagedSkill[]>>;
  setExtensionMarketplaceSources: Dispatch<
    SetStateAction<ExtensionMarketplaceSource[]>
  >;
  setExtensionInstalls: Dispatch<SetStateAction<ExtensionInstallRecord[]>>;
  setAssistants: Dispatch<SetStateAction<Assistant[]>>;
  setWorkspaceCleanupSummary: Dispatch<
    SetStateAction<WorkspaceCleanupSummary | null>
  >;
  setScanningWorkspaces: Dispatch<SetStateAction<boolean>>;
  setExtensionsLoading: Dispatch<SetStateAction<boolean>>;
  setDoctorReport: Dispatch<SetStateAction<DoctorReport | null>>;
  setDoctorLoading: Dispatch<SetStateAction<boolean>>;
};

export function useAppBootstrap({
  apiBase,
  builtinChannelTypes,
  builtinConversationTargets,
  configMetaRef,
  isSensitiveConfigKey,
  setAuthStatus,
  setLoginForm,
  setConversations,
  setProviders,
  setStatus,
  setConfigMeta,
  setBasicConfig,
  setChannelTypes,
  setConversationTargets,
  setChannelInstances,
  setManagedMcpServers,
  setManagedSkills,
  setExtensionMarketplaceSources,
  setExtensionInstalls,
  setAssistants,
  setWorkspaceCleanupSummary,
  setScanningWorkspaces,
  setExtensionsLoading,
  setDoctorReport,
  setDoctorLoading,
}: UseAppBootstrapParams) {
  const markUnauthenticated = useCallback(() => {
    setAuthStatus({ authenticated: false, username: null });
  }, [setAuthStatus]);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/conversations`);
      if (res.ok) {
        const data = (await res.json()) as Array<
          Conversation & {
            assistant_id?: string | null;
            assistant_name?: string | null;
            assistant_provider_alias?: string | null;
            conversation_provider_id?: string | null;
            conversation_provider_alias?: string | null;
            conversation_model?: string | null;
          }
        >;
        setConversations(
          normalizeArrayPayload<
            Conversation & {
              assistant_id?: string | null;
              assistant_name?: string | null;
              assistant_provider_alias?: string | null;
              conversation_provider_id?: string | null;
              conversation_provider_alias?: string | null;
              conversation_model?: string | null;
            }
          >(data).map((conversation) => ({
            ...conversation,
            assistantId:
              conversation.assistantId ?? conversation.assistant_id ?? null,
            assistantName:
              conversation.assistantName ?? conversation.assistant_name ?? null,
            assistantProviderAlias:
              conversation.assistantProviderAlias ??
              conversation.assistant_provider_alias ??
              null,
            conversationProviderId:
              conversation.conversationProviderId ??
              conversation.conversation_provider_id ??
              null,
            conversationProviderAlias:
              conversation.conversationProviderAlias ??
              conversation.conversation_provider_alias ??
              null,
            conversationModel:
              conversation.conversationModel ??
              conversation.conversation_model ??
              null,
          })),
        );
      }
    } catch {
      /* offline */
    }
  }, [apiBase, setConversations]);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/providers/available?capability=all`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (res.ok) {
        setProviders(normalizeArrayPayload<AiProvider>(await res.json()));
      } else {
        console.warn(`[loadProviders] HTTP ${res.status}: failed to load providers list`);
      }
    } catch {
      /* offline */
    }
  }, [apiBase, markUnauthenticated, setProviders]);

  const loadAuthStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/auth/status`);
      if (!res.ok) return;
      const data: AuthStatus = await res.json();
      setAuthStatus(data);
      const ldapOrMultiUser = data.ldapEnabled || data.multiUserMode === true;
      const resolvedUsername = ldapOrMultiUser
        ? data.username || ''
        : data.username ||
          data.loginUsername ||
          String(BASIC_CONFIG_DEFAULTS.WEB_LOGIN_USERNAME || 'admin');
      setLoginForm((prev) => ({
        ...prev,
        username: resolvedUsername || prev.username,
        password: ldapOrMultiUser ? prev.password : prev.password || 'admin123',
      }));
    } catch {
      /* offline */
    }
  }, [apiBase, setAuthStatus, setLoginForm]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/status`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (res.ok) {
        setStatus(normalizeStatusInfo(await res.json()));
      }
    } catch {
      /* offline */
    }
  }, [apiBase, markUnauthenticated, setStatus]);

  const loadDoctorReport = useCallback(async () => {
    setDoctorLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/doctor`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (res.ok) {
        setDoctorReport((await res.json()) as DoctorReport);
      }
    } catch {
      /* offline */
    } finally {
      setDoctorLoading(false);
    }
  }, [apiBase, markUnauthenticated, setDoctorLoading, setDoctorReport]);

  const loadConfigMeta = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config/meta`);
      if (!res.ok) return;
      const data = await res.json();
      const nextMeta = Object.fromEntries(
        ((data.keys || []) as ConfigKeyMetadata[]).map((entry) => [
          entry.key,
          entry,
        ]),
      );
      setConfigMeta(nextMeta);
    } catch {
      /* offline */
    }
  }, [apiBase, setConfigMeta]);

  const loadChannelConfigMeta = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/channel-config/meta`);
      if (!res.ok) return;
      const data = await res.json();
      setChannelTypes(
        mergeByType(
          builtinChannelTypes,
          normalizeArrayPayload<ChannelTypeDefinition>(data.types),
        ),
      );
      setConversationTargets(
        mergeByType(
          builtinConversationTargets,
          normalizeArrayPayload<ConversationCreateTargetDefinition>(
            data.conversationTargets,
          ),
        ),
      );
    } catch {
      setChannelTypes(builtinChannelTypes);
      setConversationTargets(builtinConversationTargets);
    }
  }, [
    apiBase,
    builtinChannelTypes,
    builtinConversationTargets,
    setChannelTypes,
    setConversationTargets,
  ]);

  const loadWorkspaceCleanupSummary = useCallback(async () => {
    setScanningWorkspaces(true);
    try {
      const res = await fetch(`${apiBase}/api/maintenance/orphans`);
      if (!res.ok) return;
      setWorkspaceCleanupSummary((await res.json()) as WorkspaceCleanupSummary);
    } catch {
      /* offline */
    } finally {
      setScanningWorkspaces(false);
    }
  }, [apiBase, setScanningWorkspaces, setWorkspaceCleanupSummary]);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (!res.ok) return;

      const cfg = await res.json();
      const currentConfigMeta = configMetaRef.current;
      const allKeys = Array.from(
        new Set([
          ...Object.keys(BASIC_CONFIG_DEFAULTS),
          ...Object.keys(currentConfigMeta),
          ...Object.keys(cfg || {}),
        ]),
      );

      const nextConfig: BasicConfigState = { ...BASIC_CONFIG_DEFAULTS };
      for (const key of allKeys) {
        const fallbackValue = BASIC_CONFIG_DEFAULTS[key];
        nextConfig[key] = normalizeConfigValue(cfg[key], fallbackValue);
        if (isSensitiveConfigKey(key, currentConfigMeta[key])) {
          nextConfig[key] = '';
        }
      }

      setBasicConfig(nextConfig);
    } catch {
      /* offline */
    }
  }, [
    apiBase,
    configMetaRef,
    isSensitiveConfigKey,
    markUnauthenticated,
    setBasicConfig,
  ]);

  const loadChannelConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/channel-config`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setChannelInstances(
        normalizeArrayPayload<ChannelInstanceConfig>(data.instances),
      );
    } catch {
      setChannelTypes(builtinChannelTypes);
      setConversationTargets(builtinConversationTargets);
    }
  }, [
    apiBase,
    builtinChannelTypes,
    builtinConversationTargets,
    markUnauthenticated,
    setChannelInstances,
    setChannelTypes,
    setConversationTargets,
  ]);

  const loadExtensions = useCallback(async () => {
    setExtensionsLoading(true);
    try {
      const [mcpRes, skillsRes, marketplacesRes, installsRes] = await Promise.all([
        fetch(`${apiBase}/api/mcp-servers`),
        fetch(`${apiBase}/api/skills`),
        fetch(`${apiBase}/api/extensions/marketplaces`),
        fetch(`${apiBase}/api/extensions/installs`),
      ]);

      if (
        mcpRes.status === 401 ||
        skillsRes.status === 401 ||
        marketplacesRes.status === 401 ||
        installsRes.status === 401
      ) {
        markUnauthenticated();
        return;
      }

      if (mcpRes.ok) {
        const mcpData = (await mcpRes.json()) as {
          servers?: ManagedMcpServer[];
        };
        setManagedMcpServers(
          normalizeArrayPayload<ManagedMcpServer>(mcpData.servers),
        );
      }

      if (skillsRes.ok) {
        const skillsData = (await skillsRes.json()) as {
          skills?: ManagedSkill[];
        };
        setManagedSkills(normalizeArrayPayload<ManagedSkill>(skillsData.skills));
      }

      if (marketplacesRes.ok) {
        const marketplaceData = (await marketplacesRes.json()) as {
          sources?: ExtensionMarketplaceSource[];
        };
        setExtensionMarketplaceSources(
          normalizeArrayPayload<ExtensionMarketplaceSource>(
            marketplaceData.sources,
          ),
        );
      }

      if (installsRes.ok) {
        const installsData = (await installsRes.json()) as {
          installs?: ExtensionInstallRecord[];
        };
        setExtensionInstalls(
          normalizeArrayPayload<ExtensionInstallRecord>(installsData.installs),
        );
      }
    } catch {
      /* offline */
    } finally {
      setExtensionsLoading(false);
    }
  }, [
    apiBase,
    markUnauthenticated,
    setExtensionsLoading,
    setManagedMcpServers,
    setManagedSkills,
    setExtensionMarketplaceSources,
    setExtensionInstalls,
  ]);

  const loadAssistants = useCallback(async () => {
    const res = await fetch(`${apiBase}/api/assistants`);
    if (res.status === 401) {
      markUnauthenticated();
      return;
    }
    if (res.ok) {
      const data = (await res.json()) as { assistants?: Assistant[] };
      setAssistants(normalizeArrayPayload<Assistant>(data.assistants));
    } else {
      throw new Error(i18n.t('hooks.appBootstrap.loadAssistantsFailed'));
    }
  }, [apiBase, markUnauthenticated, setAssistants]);

  return {
    markUnauthenticated,
    loadAuthStatus,
    loadChannelConfig,
    loadChannelConfigMeta,
    loadConfig,
    loadConfigMeta,
    loadConversations,
    loadDoctorReport,
    loadExtensions,
    loadAssistants,
    loadProviders,
    loadStatus,
    loadWorkspaceCleanupSummary,
  };
}
