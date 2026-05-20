import {
  Suspense,
  lazy,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ConversationSidebar } from './components/ConversationSidebar';
import { NavSidebar } from './components/NavSidebar';
import { Drawer } from './components/common/Drawer';
import { AppSelect } from './components/AppSelect';
import { IconEye, IconEyeOff } from './components/AppIcons';
import {
  BASIC_CONFIG_DEFAULTS,
  type ApprovalRequest,
  type AiProvider,
  type Assistant,
  type AssistantConfig,
  type AuthStatus,
  type BasicConfigState,
  type BuiltinWebFetchSiteProfilePreset,
  type ChannelFieldOption,
  type ChannelInstanceConfig,
  type ChannelFilter,
  type ChannelFieldDefinition,
  type ConversationSort,
  type ConversationCreateFieldDefinition,
  type ConversationCreateTargetDefinition,
  type ChannelTypeDefinition,
  type ConfigKeyMetadata,
  type ConversationChatState,
  type NativeDialogLike,
  type ChatTimelineEntry,
  type Conversation,
  type ConversationAccess,
  type ConversationAccessNextAction,
  type ConversationAccessPolicyLayers,
  type EffectiveConversationAccessState,
  type AccessPolicy,
  type ApprovalScope,
  type RuntimeApprovalPatch,
  type RuntimeAccessState,
  type DoctorReport,
  type ExtensionInstallRecord,
  type ExtensionMarketplaceSource,
  type NavPage,
  type SettingsTab,
  type StatusInfo,
  type TestResult,
  type ManagedMcpServer,
  type ManagedSkill,
  type SenderTrustConfig,
  type UploadedChatFile,
  type WorkspaceCleanupSummary,
  type Live2DConfig,
  type Live2DEmotion,
} from './app-types';
import { ChatStateStore, EMPTY_CHAT_STATE } from './stores/ChatStateStore';
import {
  buildChatTimelineEntries,
  buildConfigSaveMessage,
  clearConversationTransientReplyState,
  deriveConversationReplyState,
  expireLiveConversationTurns,
  formatConfigEffectLabel,
  formatTime,
  formatTimelineMarkdown,
  formatUptime,
  getConversationTitle,
  getDisplayContent,
  interruptConversationState,
  isPendingMessageResolved,
  shouldRenderTurn,
  stripLeadingMention,
  truncatePreview,
  ensureOptimisticWaitingTurn,
  clearOptimisticTurns,
} from './app-helpers';
import {
  applyConversationRealtimeWatermark,
  normalizeConversationSendAck,
} from './conversation-realtime';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { UIProvider, useUI } from './contexts/UIContext';
import { useAuth } from './hooks/useAuth';
import { useConversationRealtime, MESSAGE_PAGE_SIZE } from './hooks/useConversationRealtime';
import { useExtensionMaintenanceActions } from './hooks/useExtensionMaintenanceActions';
import { useProviderActions } from './hooks/useProviderActions';
import { useSettingsActions } from './hooks/useSettingsActions';
import { useTerminalSession } from './hooks/useTerminalSession';
import { useWebSocket } from './hooks/useWebSocket';
import { pathToNavPage, navPageToPath } from './router/paths';
import { MobileLayout } from './components/MobileLayout';
import { AppsPageV2 } from './pages/AppsPageV2';
import './components/mobile-layout.css';
import './App.css';

const FALLBACK_ACCESS_POLICY: AccessPolicy = {
  mode: 'allowall',
  directories: [],
  source: 'global',
  locked: false,
  editable: true,
};

function normalizeAccessPolicy(
  policy?: AccessPolicy,
  fallbackSource: AccessPolicy['source'] = 'global',
): AccessPolicy {
  if (!policy) return { ...FALLBACK_ACCESS_POLICY };
  const record = policy as AccessPolicy & { inheritedFrom?: unknown };
  const source =
    policy.source === 'assistant' ||
    policy.source === 'conversation' ||
    policy.source === 'global'
      ? policy.source
      : record.inheritedFrom === 'assistant' ||
          record.inheritedFrom === 'conversation' ||
          record.inheritedFrom === 'global'
        ? record.inheritedFrom
        : fallbackSource;
  return {
    mode: policy.mode || 'allowall',
    directories: Array.isArray(policy.directories) ? [...policy.directories] : [],
    source,
    locked: Boolean(policy.locked),
    editable: policy.editable ?? true,
  };
}

function buildConversationAccess(policy?: AccessPolicy): ConversationAccess {
  return {
    policy: normalizeAccessPolicy(policy),
  };
}

function normalizeRuntimeApprovalPatch(
  value: unknown,
): RuntimeApprovalPatch | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const approvalId =
    typeof record.approvalId === 'string' ? record.approvalId : '';
  const toolCallId =
    typeof record.toolCallId === 'string' ? record.toolCallId : '';
  const toolName = typeof record.toolName === 'string' ? record.toolName : '';
  const command = typeof record.command === 'string' ? record.command : '';
  const createdAt =
    typeof record.createdAt === 'string' ? record.createdAt : '';
  const resolvedAt =
    typeof record.resolvedAt === 'string' ? record.resolvedAt : '';
  const expiresAt =
    typeof record.expiresAt === 'string' ? record.expiresAt : '';
  if (
    !id ||
    !approvalId ||
    !toolCallId ||
    !toolName ||
    !command ||
    !createdAt ||
    !resolvedAt ||
    !expiresAt
  ) {
    return null;
  }
  return {
    id,
    approvalId,
    toolCallId,
    toolName,
    command,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    source: 'approval',
    scope:
      record.scope === 'current_tool_call'
        ? 'current_tool_call'
        : 'current_runtime',
    createdAt,
    resolvedAt,
    expiresAt,
  };
}

function normalizeConversationAccessPolicyLayers(
  payload: unknown,
): ConversationAccessPolicyLayers | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (!record.policyLayers || typeof record.policyLayers !== 'object') {
    return undefined;
  }
  const policyLayers = record.policyLayers as Record<string, unknown>;
  if (!policyLayers.global || typeof policyLayers.global !== 'object') {
    return undefined;
  }
  return {
    global: normalizeAccessPolicy(policyLayers.global as AccessPolicy, 'global'),
    assistant:
      policyLayers.assistant && typeof policyLayers.assistant === 'object'
        ? normalizeAccessPolicy(
            policyLayers.assistant as AccessPolicy,
            'assistant',
          )
        : null,
    conversation:
      policyLayers.conversation && typeof policyLayers.conversation === 'object'
        ? normalizeAccessPolicy(
            policyLayers.conversation as AccessPolicy,
            'conversation',
          )
        : null,
  };
}

function extractRuntimeApprovalPatches(
  payload: unknown,
): RuntimeApprovalPatch[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  return Array.isArray(record.runtimeApprovalPatches)
    ? record.runtimeApprovalPatches
        .map((entry) => normalizeRuntimeApprovalPatch(entry))
        .filter((entry): entry is RuntimeApprovalPatch => entry !== null)
    : [];
}

function normalizeRuntimeAccess(payload: unknown): RuntimeAccessState | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (!record.runtimeAccess || typeof record.runtimeAccess !== 'object') {
    return undefined;
  }
  const value = record.runtimeAccess as Record<string, unknown>;
  if (
    typeof value.hasActivePatches !== 'boolean' ||
    typeof value.reusableCommandCount !== 'number' ||
    typeof value.activePatchCount !== 'number' ||
    typeof value.affectsPersistentPolicy !== 'boolean' ||
    typeof value.summary !== 'string'
  ) {
    return undefined;
  }
  return {
    hasActivePatches: value.hasActivePatches,
    reusableCommandCount: value.reusableCommandCount,
    activePatchCount: value.activePatchCount,
    latestExpiresAt:
      typeof value.latestExpiresAt === 'string' || value.latestExpiresAt === null
        ? value.latestExpiresAt
        : undefined,
    affectsPersistentPolicy: value.affectsPersistentPolicy,
    summary: value.summary,
  };
}

function normalizeEffectiveAccess(
  payload: unknown,
): EffectiveConversationAccessState | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (!record.effectiveAccess || typeof record.effectiveAccess !== 'object') {
    return undefined;
  }
  const value = record.effectiveAccess as Record<string, unknown>;
  if (
    !value.persistentPolicy ||
    typeof value.persistentPolicy !== 'object' ||
    typeof value.temporaryCommandReuseCount !== 'number' ||
    !Array.isArray(value.temporaryApprovedDirectories) ||
    typeof value.hasTemporaryElevation !== 'boolean' ||
    typeof value.summary !== 'string'
  ) {
    return undefined;
  }
  return {
    persistentPolicy: normalizeAccessPolicy(
      value.persistentPolicy as AccessPolicy,
    ),
    temporaryCommandReuseCount: value.temporaryCommandReuseCount,
    temporaryApprovedDirectories: value.temporaryApprovedDirectories.filter(
      (entry): entry is string => typeof entry === 'string',
    ),
    hasTemporaryElevation: value.hasTemporaryElevation,
    summary: value.summary,
  };
}

function normalizeConversationAccessNextActions(
  payload: unknown,
): ConversationAccessNextAction[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.nextActions)) return [];
  return record.nextActions.reduce<ConversationAccessNextAction[]>(
    (actions, entry) => {
      if (!entry || typeof entry !== 'object') return actions;
      const value = entry as Record<string, unknown>;
      if (
        typeof value.id !== 'string' ||
        typeof value.title !== 'string' ||
        typeof value.description !== 'string'
      ) {
        return actions;
      }
      const action: ConversationAccessNextAction = {
        id: value.id,
        title: value.title,
        description: value.description,
      };
      const target =
        value.target && typeof value.target === 'object'
          ? (value.target as Record<string, unknown>)
          : null;
      if (
        target &&
        (target.type === 'assistant' ||
          target.type === 'settings_default_access') &&
        typeof target.label === 'string'
      ) {
        action.target = {
          type: target.type,
          label: target.label,
          assistantId:
            typeof target.assistantId === 'string' || target.assistantId === null
              ? target.assistantId
              : undefined,
        };
      }
      actions.push(action);
      return actions;
    },
    [],
  );
}

function buildConversationAccessFromPayload(
  payload: unknown,
  fallbackPolicy?: AccessPolicy,
): ConversationAccess {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  return {
    policy: normalizeAccessPolicy(
      extractPolicyFromPayload(payload) ?? fallbackPolicy,
    ),
    allowedDirectories: Array.isArray(record?.allowedDirectories)
      ? record.allowedDirectories.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : undefined,
    policyLayers: normalizeConversationAccessPolicyLayers(payload),
    runtimeApprovalPatches: extractRuntimeApprovalPatches(payload),
    runtimeAccess: normalizeRuntimeAccess(payload),
    effectiveAccess: normalizeEffectiveAccess(payload),
    nextActions: normalizeConversationAccessNextActions(payload),
  };
}

function extractPolicyFromPayload(payload: unknown): AccessPolicy | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (record.accessPolicy && typeof record.accessPolicy === 'object') {
    return record.accessPolicy as AccessPolicy;
  }
  if (record.policy && typeof record.policy === 'object') {
    return record.policy as AccessPolicy;
  }
  if (Array.isArray(record.allowedDirectories)) {
    return {
      ...FALLBACK_ACCESS_POLICY,
      directories: record.allowedDirectories.filter((entry): entry is string =>
        typeof entry === 'string',
      ),
    };
  }
  return undefined;
}

const API = '';
const MAX_UPLOAD_FILES = 5;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

type MessageMemoryAction = 'remember' | 'session_only';

type MessageMemoryActionState = {
  pendingAction?: MessageMemoryAction;
  tone?: 'success' | 'error';
  message?: string;
};

const ChatPage = lazy(async () => {
  const module = await import('./pages/ChatPage');
  return { default: module.ChatPage };
});

const StockAnalysisPage = lazy(async () => {
  const module = await import('./pages/StockAnalysisPage');
  return { default: module.StockAnalysisPage };
});

const ChannelsWorkspacePage = lazy(async () => {
  const module = await import('./pages/ChannelsWorkspacePage');
  return { default: module.ChannelsWorkspacePage };
});

const AssistantsPage = lazy(async () => {
  const module = await import('./pages/AssistantsPage');
  return { default: module.AssistantsPage };
});

const SettingsPage = lazy(async () => {
  const module = await import('./pages/settings');
  return { default: module.SettingsPage };
});

const UsersPage = lazy(async () => {
  const module = await import('./pages/UsersPage');
  return { default: module.UsersPage };
});

const SoulPage = lazy(async () => {
  const module = await import('./pages/SoulPage');
  return { default: module.SoulPage };
});

const TavernPage = lazy(async () => {
  const module = await import('./pages/TavernPage');
  return { default: module.TavernPage };
});

const KnowledgePage = lazy(async () => {
  const module = await import('./pages/KnowledgePage');
  return { default: module.KnowledgePage };
});

const WorkteamPage = lazy(async () => {
  const module = await import('./pages/WorkteamPage');
  return { default: module.WorkteamPage };
});

const TasksPageContainer = lazy(async () => {
  const module = await import('./pages/TasksPageContainer');
  return { default: module.TasksPageContainer };
});

const TerminalPage = lazy(async () => {
  const module = await import('./pages/TerminalPage');
  return { default: module.TerminalPage };
});

const RepoReviewSettingsPanel = lazy(async () => {
  const module = await import('./components/RepoReviewSettingsPanel');
  return { default: module.RepoReviewSettingsPanel };
});

const RepositoryPage = lazy(() => import('./pages/RepositoryPage'));

const CompanionPage = lazy(async () => {
  const module = await import('./pages/CompanionPage');
  return { default: module.CompanionPage };
});

const ImPage = lazy(async () => {
  const module = await import('./pages/im/ImPage');
  return { default: module.ImPage };
});

const Live2DPanel = lazy(async () => {
  const [, module] = await Promise.all([
    import('./components/live2d/live2d.css'),
    import('./components/live2d/Live2DPanel'),
  ]);
  return { default: module.Live2DPanel };
});

const Live2DChatConfig = lazy(async () => {
  const [, module] = await Promise.all([
    import('./components/live2d/live2d.css'),
    import('./components/live2d/Live2DChatConfig'),
  ]);
  return { default: module.Live2DChatConfig };
});


// EMPTY_CHAT_STATE is now imported from stores/ChatStateStore

function isSensitiveConfigKey(
  key: string,
  metadata?: ConfigKeyMetadata,
): boolean {
  return (
    metadata?.risk === 'sensitive' ||
    /(SECRET|PASSWORD|TOKEN|API_KEY)$/i.test(key)
  );
}

function serializeConfigValue(value: string | boolean): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
}

function createChannelInstanceId(type: string): string {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatMessageMemoryActionSuccess(
  input: {
    action: MessageMemoryAction;
    result?: {
      status?: string;
      memoryClass?: string;
    };
  },
  t: (key: string) => string,
): string {
  if (input.action === 'session_only') {
    return t('app.b76f08');
  }
  if (input.result?.status === 'deduped') {
    return t('app.383fc9');
  }
  if (input.result?.memoryClass === 'identity') {
    return t('app.830644');
  }
  if (input.result?.memoryClass === 'global_durable') {
    return t('app.5f5fbe');
  }
  return t('app.71b23a');
}

const CHANNEL_FILTER_ORDER = [
  'web',
  'feishu',
  'telegram',
  'discord',
  'slack',
  'gmail',
  'whatsapp',
];

const CHANNEL_FILTER_LABEL_ALIASES: Record<string, string[]> = {
  web: ['web'],
  feishu: ['feishu', 'lark', '飞书'],
  telegram: ['telegram'],
  discord: ['discord'],
  slack: ['slack'],
  gmail: ['gmail'],
  whatsapp: ['whatsapp'],
};

function matchesChannelAlias(value: string, alias: string): boolean {
  return (
    value === alias ||
    value.startsWith(`${alias}:`) ||
    value.startsWith(`${alias}.`) ||
    value.startsWith(`${alias}·`) ||
    value.startsWith(`${alias} ·`) ||
    value.startsWith(`${alias}-`)
  );
}

function normalizeChannelFilterKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';

  for (const type of CHANNEL_FILTER_ORDER) {
    const aliases = CHANNEL_FILTER_LABEL_ALIASES[type] || [type];
    if (aliases.some((alias) => matchesChannelAlias(normalized, alias))) {
      return type;
    }
  }

  const separatorMatch = normalized.match(/^[^:.\s·-]+/u);
  return separatorMatch?.[0] || normalized;
}

function parseScopedChatJid(
  jid: string,
  prefix: string,
): { instanceId: string; chatId: string } | null {
  const normalizedPrefix = `${prefix}:`;
  if (!jid.startsWith(normalizedPrefix)) return null;

  const payload = jid.slice(normalizedPrefix.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return payload ? { instanceId: 'default', chatId: payload } : null;
  }

  const instanceId = payload.slice(0, separatorIndex).trim();
  const chatId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !chatId) return null;
  return { instanceId, chatId };
}

function buildKnownFeishuChatOptions(
  conversations: Conversation[],
  instanceId?: string,
): ChannelFieldOption[] {
  const dedup = new Map<string, ChannelFieldOption>();
  for (const conversation of conversations) {
    if (conversation.channel !== 'feishu') continue;
    const parsed = parseScopedChatJid(conversation.jid, 'feishu');
    if (!parsed) continue;
    if ((instanceId || 'default') !== parsed.instanceId) continue;
    if (dedup.has(parsed.chatId)) continue;
    dedup.set(parsed.chatId, {
      value: parsed.chatId,
      label: getConversationTitle(conversation) || parsed.chatId,
    });
  }
  return Array.from(dedup.values());
}

function decorateCreateConversationFields(
  optionType: string,
  instanceId: string | undefined,
  fields: ConversationCreateFieldDefinition[],
  conversations: Conversation[],
  t: (key: string) => string,
): ConversationCreateFieldDefinition[] {
  if (optionType !== 'feishu') {
    return fields;
  }

  const knownChats = buildKnownFeishuChatOptions(conversations, instanceId);
  if (knownChats.length === 0) {
    return fields.map((field) =>
      field.key === 'chatId'
        ? {
            ...field,
            required: false,
            summary: t('app.de877d'),
          }
        : field,
    );
  }

  return fields.map((field) =>
    field.key === 'chatId'
      ? {
          ...field,
          type: 'select',
          required: false,
          options: knownChats,
          summary: t('app.8764fb'),
        }
      : field,
  );
}

interface CreateConversationOption {
  key: string;
  type: string;
  label: string;
  instanceId?: string;
  supported: boolean;
  description: string;
  reason?: string;
  fields: ConversationCreateFieldDefinition[];
}

function getBuiltinChannelTypes(t: (key: string) => string): ChannelTypeDefinition[] {
  return [
    {
      type: 'feishu',
      label: t('channel.feishu'),
      description: t('app.50b4fa'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'appId',
          label: 'App ID',
          type: 'text',
          required: true,
          effect: 'restart',
          summary: t('app.d0ce7d'),
          risk: 'sensitive',
        },
        {
          key: 'appSecret',
          label: 'App Secret',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.8bfa86'),
          risk: 'sensitive',
        },
        {
          key: 'domain',
          label: t('app.190980'),
          type: 'select',
          effect: 'restart',
          summary: t('app.ae7cbb'),
          options: [
            { value: 'feishu', label: 'feishu' },
            { value: 'lark', label: 'lark' },
          ],
        },
        {
          key: 'renderMode',
          label: t('app.31044f'),
          type: 'select',
          effect: 'instant',
          summary: t('app.5e0c54'),
          options: [
            { value: 'auto', label: 'auto' },
            { value: 'text', label: 'text' },
            { value: 'card', label: 'card' },
          ],
        },
        {
          key: 'replyInThread',
          label: t('app.f0e9de'),
          type: 'boolean',
          effect: 'instant',
          summary: t('app.d57f95'),
        },
      ] as ChannelFieldDefinition[],
    },
    {
      type: 'telegram',
      label: 'Telegram',
      description: t('app.82e397'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'botToken',
          label: 'Bot Token',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.channel.telegramBotToken'),
          risk: 'sensitive',
        },
        {
          key: 'apiBase',
          label: 'API Base URL',
          type: 'text',
          effect: 'restart',
          summary: t('app.c3ad24'),
        },
      ] as ChannelFieldDefinition[],
    },
    {
      type: 'discord',
      label: 'Discord',
      description: t('app.857b67'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'botToken',
          label: 'Bot Token',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.channel.discordBotToken'),
          risk: 'sensitive',
        },
        {
          key: 'applicationId',
          label: 'Application ID',
          type: 'text',
          effect: 'restart',
          summary: t('app.28cb8c'),
        },
      ] as ChannelFieldDefinition[],
    },
    {
      type: 'slack',
      label: 'Slack',
      description: t('app.5ffe1f'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'botToken',
          label: 'Bot Token',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.channel.slackBotToken'),
          risk: 'sensitive',
        },
        {
          key: 'appToken',
          label: 'App Token',
          type: 'password',
          effect: 'restart',
          summary: t('app.1b85d9'),
          risk: 'sensitive',
        },
      ] as ChannelFieldDefinition[],
    },
    {
      type: 'gmail',
      label: 'Gmail',
      description: t('app.779aa9'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'clientId',
          label: 'Client ID',
          type: 'text',
          required: true,
          effect: 'restart',
          summary: t('app.channel.gmailClientId'),
          risk: 'sensitive',
        },
        {
          key: 'clientSecret',
          label: 'Client Secret',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.channel.gmailClientSecret'),
          risk: 'sensitive',
        },
        {
          key: 'refreshToken',
          label: 'Refresh Token',
          type: 'password',
          effect: 'restart',
          summary: t('app.channel.gmailRefreshToken'),
          risk: 'sensitive',
        },
        {
          key: 'pollIntervalSeconds',
          label: t('app.496ab3'),
          type: 'text',
          effect: 'restart',
          summary: t('app.d37718'),
        },
      ] as ChannelFieldDefinition[],
    },
    {
      type: 'whatsapp',
      label: 'WhatsApp',
      description: t('app.08d688'),
      allowMultiple: true,
      runtimeInstalled: true,
      webConfigurable: true,
      fields: [
        {
          key: 'accessToken',
          label: 'Access Token',
          type: 'password',
          required: true,
          effect: 'restart',
          summary: t('app.channel.whatsappAccessToken'),
          risk: 'sensitive',
        },
        {
          key: 'phoneNumberId',
          label: 'Phone Number ID',
          type: 'text',
          required: true,
          effect: 'restart',
          summary: t('app.030913'),
        },
        {
          key: 'verifyToken',
          label: 'Verify Token',
          type: 'password',
          effect: 'restart',
          summary: t('app.0805cf'),
          risk: 'sensitive',
        },
        {
          key: 'graphVersion',
          label: t('app.ad0e7c'),
          type: 'text',
          effect: 'restart',
          summary: t('app.5cd07c'),
        },
      ] as ChannelFieldDefinition[],
    },
  ];
}

function getBuiltinConversationTargets(t: (key: string, opts?: Record<string, unknown>) => string): ConversationCreateTargetDefinition[] {
  return [
  {
    type: 'web',
    label: 'Web',
    description: t('app.59ef90'),
    creatable: true,
    requiresConfiguredInstance: false,
    runtimeInstalled: true,
    fields: [
      {
        key: 'name',
        label: t('app.87e2fc'),
        type: 'text',
        placeholder: 'New Chat',
        summary: t('app.1102d4'),
      },
    ],
  },
  {
    type: 'feishu',
    label: t('channel.feishu'),
    description: t('app.70f038'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('app.a37954'),
        summary: t('app.fc9969'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'Feishu Chat',
        summary: t('app.014647'),
      },
    ],
  },
  {
    type: 'telegram',
    label: 'Telegram',
    description: t('app.f19c18'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('app.aa530c'),
        summary: t('app.823daa'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'Telegram Chat',
        summary: t('app.79cde0'),
      },
    ],
  },
  {
    type: 'discord',
    label: 'Discord',
    description: t('app.30e59e'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'channelId',
        label: 'Channel ID',
        type: 'text',
        required: true,
        placeholder: 'Discord channel_id',
        summary: t('app.823daa'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'Discord Channel',
        summary: t('app.79cde0'),
      },
    ],
  },
  {
    type: 'slack',
    label: 'Slack',
    description: t('app.6c92ad'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'channelId',
        label: 'Channel ID',
        type: 'text',
        required: true,
        placeholder: 'Cxxx / Gxxx / Dxxx',
        summary: t('app.823daa'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'Slack Channel',
        summary: t('app.79cde0'),
      },
    ],
  },
  {
    type: 'gmail',
    label: 'Gmail',
    description: t('app.5a2ecc'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'threadId',
        label: 'Thread ID',
        type: 'text',
        required: true,
        placeholder: 'Gmail threadId',
        summary: t('app.823daa'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'Gmail Thread',
        summary: t('app.79cde0'),
      },
    ],
  },
  {
    type: 'whatsapp',
    label: 'WhatsApp',
    description: t('app.a45b1d'),
    creatable: true,
    requiresConfiguredInstance: true,
    runtimeInstalled: true,
    fields: [
      {
        key: 'chatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        placeholder: t('app.7f7d91'),
        summary: t('app.823daa'),
      },
      {
        key: 'name',
        label: t('app.fdf6f7'),
        type: 'text',
        placeholder: 'WhatsApp Chat',
        summary: t('app.79cde0'),
      },
    ],
  },
  ];
}

function getFallbackConversationSupport(type: string, t?: (key: string) => string): {
  supported: boolean;
  requiresInstance?: boolean;
  description: string;
  reason?: string;
  fields: ConversationCreateFieldDefinition[];
} {
  const targets = t ? getBuiltinConversationTargets(t) : [];
  const target = targets.find(
    (entry) => entry.type === type,
  );
  if (!target) {
    return {
      supported: false,
      requiresInstance: true,
      description: t ? t('app.418cc0') : 'This channel does not support proactive conversation creation yet.',
      reason: t ? t('app.1f2a20') : 'No frontend fallback configuration is available for this channel right now.',
      fields: [],
    };
  }
  return {
    supported: target.creatable,
    requiresInstance: target.requiresConfiguredInstance,
    description: target.description,
    reason: target.unavailableReason,
    fields: target.fields,
  };
}

interface PendingUploadFile {
  id: string;
  file: File;
}

function fileToBase64(file: File, t?: (key: string, opts?: Record<string, unknown>) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t ? t('app.readFileFailed', { name: file.name }) : `Failed to read file: ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(t ? t('app.readFileFailed', { name: file.name }) : `Failed to read file: ${file.name}`));
        return;
      }
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64 || '');
    };
    reader.readAsDataURL(file);
  });
}

function mergePendingUploadFiles(
  previous: PendingUploadFile[],
  picked: File[],
): PendingUploadFile[] {
  const merged = [...previous];
  for (const file of picked) {
    if (merged.length >= MAX_UPLOAD_FILES) break;
    const exists = merged.some(
      (item) =>
        item.file.name === file.name &&
        item.file.size === file.size &&
        item.file.lastModified === file.lastModified,
    );
    if (exists) continue;
    merged.push({
      id: `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file,
    });
  }
  return merged.slice(0, MAX_UPLOAD_FILES);
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function ShareDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void copyToClipboard(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="share-dialog-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t('app.750320')}</h3>
        <div className="share-dialog-url-row">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button onClick={handleCopy} className={copied ? 'copied' : ''}>
            {copied ? t('app.e9868c') : t('btn.copy')}
          </button>
        </div>
        <button className="share-dialog-close" onClick={onClose}>
          {t('close')}
        </button>
      </div>
    </div>
  );
}

function AppShell() {
  const {
    theme,
    toggleTheme,
    conversationSidebarCollapsed,
    toggleConversationSidebar,
    isMobile,
    mobileConvDrawerOpen,
    setMobileConvDrawerOpen,
    toggleMobileConvDrawer,
    confirmDialog,
    setConfirmDialog,
    renameDialog,
    setRenameDialog,
    shareDialogUrl,
    setShareDialogUrl,
    assistantPageTargetId,
    setAssistantPageTargetId,
    settingsPageTarget,
    setSettingsPageTarget,
  } = useUI();

  const { t } = useTranslation('common');

  const confirmResolveRef = useRef<((confirmed: boolean) => void) | null>(
    null,
  );

  const location = useLocation();
  const navigate = useNavigate();
  const page = pathToNavPage(location.pathname);
  const setPage = useCallback(
    (nextPage: NavPage) => navigate(navPageToPath(nextPage)),
    [navigate],
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const chatStoreRef = useRef(new ChatStateStore());
  const chatStore = chatStoreRef.current;
  const [input, setInput] = useState('');
  const [unreadRepliesByJid, setUnreadRepliesByJid] = useState<
    Record<string, number>
  >({});
  const [conversationAccessByJid, setConversationAccessByJid] = useState<
    Record<string, ConversationAccess>
  >({});
  const [conversationAccessLoading, setConversationAccessLoading] =
    useState(false);
  const [conversationAccessSaving, setConversationAccessSaving] =
    useState(false);
  const [interruptingConversationJid, setInterruptingConversationJid] =
    useState<string | null>(null);
  const [regeneratingConversationJid, setRegeneratingConversationJid] =
    useState<string | null>(null);
  const [hasMoreOlderByJid, setHasMoreOlderByJid] = useState<Record<string, boolean>>({});
  const [loadingOlderByJid, setLoadingOlderByJid] = useState<Record<string, boolean>>({});
  const loadingOlderRef = useRef(loadingOlderByJid);
  loadingOlderRef.current = loadingOlderByJid;
  const [messageSelectionMode, setMessageSelectionMode] = useState(false);
  const [selectedConversationItemKeys, setSelectedConversationItemKeys] =
    useState<Set<string>>(new Set());
  const [messageMemoryActionStateByMessageId, setMessageMemoryActionStateByMessageId] =
    useState<Record<string, MessageMemoryActionState>>({});
  const [status, setStatus] = useState<StatusInfo | null>(null);

  // Live2D state
  const [live2dConfig, setLive2dConfig] = useState<Live2DConfig | null>(null);
  const [live2dEmotion, setLive2dEmotion] = useState<Live2DEmotion | null>(null);
  const [live2dChatConfigOpen, setLive2dChatConfigOpen] = useState(false);
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [conversationSort, setConversationSort] =
    useState<ConversationSort>('recent');
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loginForm, setLoginForm] = useState({
    username: 'admin',
    password: 'admin123',
  });
  const [registerForm, setRegisterForm] = useState({
    username: '',
    password: '',
    displayName: '',
  });
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginPasswordVisible, setLoginPasswordVisible] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const activeJidRef = useRef<string | null>(null);
  const activeConvRef = useRef<Conversation | null>(null);
  const conversationRefreshTimerRef = useRef<number | null>(null);
  activeJidRef.current = activeJid;
  const activeConv = useMemo(
    () =>
      conversations.find((conversation) => conversation.jid === activeJid) ||
      null,
    [activeJid, conversations],
  );
  activeConvRef.current = activeConv;

  // chatStateRef provides a stable ref for WebSocket handlers / async closures
  const chatStateRef = useMemo(
    () => ({
      get current() {
        return chatStore.getSnapshot();
      },
    }),
    [chatStore],
  );

  const updateConversationChatState = useCallback(
    (
      jid: string | null | undefined,
      updater: (state: ConversationChatState) => ConversationChatState,
    ) => {
      chatStore.update(jid, updater);
    },
    [chatStore],
  );

  // switchEpoch: prevents stale data from overwriting current conversation
  const epochRef = useRef(0);
  const seenIds = useRef<Set<string>>(new Set());
  const lastTouchYRef = useRef<number | null>(null);

  // ── Provider state ──
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [editingProvider, setEditingProvider] =
    useState<Partial<AiProvider> | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {},
  );
  const [testingId, setTestingId] = useState<string | null>(null);

  // ── Basic config state ──
  const [basicConfig, setBasicConfig] = useState<BasicConfigState>(
    BASIC_CONFIG_DEFAULTS,
  );
  const [
    builtinWebFetchSiteProfilePresets,
    setBuiltinWebFetchSiteProfilePresets,
  ] = useState<BuiltinWebFetchSiteProfilePreset[]>([]);
  const [configMeta, setConfigMeta] = useState<
    Record<string, ConfigKeyMetadata>
  >({});
  const configMetaRef = useRef<Record<string, ConfigKeyMetadata>>({});
  configMetaRef.current = configMeta;
  const [channelTypes, setChannelTypes] = useState<ChannelTypeDefinition[]>([]);
  const [channelInstances, setChannelInstances] = useState<
    ChannelInstanceConfig[]
  >([]);
  const [conversationTargets, setConversationTargets] = useState<
    ConversationCreateTargetDefinition[]
  >([]);
  const [savingBasicConfig, setSavingBasicConfig] = useState(false);
  const [basicConfigMessage, setBasicConfigMessage] = useState('');
  const [savingChannelConfig, setSavingChannelConfig] = useState(false);
  const [channelConfigMessage, setChannelConfigMessage] = useState('');
  const [workspaceCleanupSummary, setWorkspaceCleanupSummary] =
    useState<WorkspaceCleanupSummary | null>(null);
  const [workspaceCleanupMessage, setWorkspaceCleanupMessage] = useState('');
  const [scanningWorkspaces, setScanningWorkspaces] = useState(false);
  const [cleaningWorkspaces, setCleaningWorkspaces] = useState(false);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [senderTrustConfig, setSenderTrustConfig] =
    useState<SenderTrustConfig | null>(null);
  const [savingSenderTrust, setSavingSenderTrust] = useState(false);
  const [senderTrustMessage, setSenderTrustMessage] = useState('');
  const [managedMcpServers, setManagedMcpServers] = useState<
    ManagedMcpServer[]
  >([]);
  const [managedSkills, setManagedSkills] = useState<ManagedSkill[]>([]);
  const [extensionMarketplaceSources, setExtensionMarketplaceSources] =
    useState<ExtensionMarketplaceSource[]>([]);
  const [extensionInstalls, setExtensionInstalls] = useState<
    ExtensionInstallRecord[]
  >([]);
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [assistantsLoading, setAssistantsLoading] = useState(false);
  const [assistantsError, setAssistantsError] = useState('');
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [savingMcpConfig, setSavingMcpConfig] = useState(false);
  const [savingSkillsConfig, setSavingSkillsConfig] = useState(false);
  const [extensionsMessage, setExtensionsMessage] = useState('');
  const [createConversationOpen, setCreateConversationOpen] = useState(false);
  const [createConversationAssistantId, setCreateConversationAssistantId] =
    useState<string | null>(null);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [createConversationError, setCreateConversationError] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [createConversationOptionKey, setCreateConversationOptionKey] =
    useState('web');
  const [createConversationName, setCreateConversationName] = useState('');
  const [createConversationFieldValues, setCreateConversationFieldValues] =
    useState<Record<string, string>>({});
  const [pendingUploadFiles, setPendingUploadFiles] = useState<
    PendingUploadFile[]
  >([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  // ── Terminal state ──

  // ── Selection state ──
  const [selectedConversationJids, setSelectedConversationJids] = useState<
    Set<string>
  >(new Set());
  const [batchDeleteEnabled, setBatchDeleteEnabled] = useState(false);

  // ── Data loading ──
  const {
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
  } = useAppBootstrap({
    apiBase: API,
    builtinChannelTypes: getBuiltinChannelTypes(t),
    builtinConversationTargets: getBuiltinConversationTargets(t),
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
  });

  const auth = useAuth(authStatus);

  const scheduleConversationsRefresh = useCallback(
    (delay = 180) => {
      if (conversationRefreshTimerRef.current !== null) {
        window.clearTimeout(conversationRefreshTimerRef.current);
      }
      conversationRefreshTimerRef.current = window.setTimeout(() => {
        conversationRefreshTimerRef.current = null;
        void loadConversations();
      }, delay);
    },
    [loadConversations],
  );

  const refreshAssistants = useCallback(async () => {
    setAssistantsLoading(true);
    setAssistantsError('');
    try {
      await loadAssistants();
    } catch (err) {
      setAssistantsError(
        err instanceof Error ? err.message : t('app.ce51b0'),
      );
    } finally {
      setAssistantsLoading(false);
    }
  }, [loadAssistants]);

  const handleAssistantSubmit = useCallback(
    async (
      assistantId: string | null,
      payload: {
        name: string;
        description?: string | null;
        enabled?: boolean;
        config: AssistantConfig;
        visibility?: 'private' | 'shared';
        initialRepositoryBindings?: Array<{
          repositoryId: string;
          branch?: string;
        }>;
      },
    ) => {
      try {
        setAssistantsError('');
        const targetId = assistantId?.trim();
        const res = await fetch(
          `${API}/api/assistants${targetId ? `/${encodeURIComponent(targetId)}` : ''}`,
          {
            method: targetId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            typeof data.error === 'string' ? data.error : t('app.566304'),
          );
        }
        const data = (await res.json()) as { assistant?: Assistant };
        if (!data.assistant) {
          throw new Error(t('app.6e0c82'));
        }
        await refreshAssistants();
        return data.assistant;
      } catch (err) {
        setAssistantsError(
          err instanceof Error ? err.message : t('app.566304'),
        );
        throw err;
      }
    },
    [refreshAssistants],
  );

  const handleAssistantDelete = useCallback(
    async (assistantId: string) => {
      try {
        setAssistantsError('');
        const targetId = assistantId.trim();
        if (!targetId) {
          throw new Error(t('app.cf01f6'));
        }
        const res = await fetch(
          `${API}/api/assistants/${encodeURIComponent(targetId)}`,
          {
            method: 'DELETE',
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            typeof data.error === 'string' ? data.error : t('app.d887dd'),
          );
        }
        await refreshAssistants();
      } catch (err) {
        setAssistantsError(
          err instanceof Error ? err.message : t('app.d887dd'),
        );
        throw err;
      }
    },
    [refreshAssistants],
  );

  const startAssistantConversation = useCallback(
    (assistantId: string) => {
      setCreateConversationAssistantId(assistantId);
      setCreateConversationOpen(true);
      setCreateConversationError('');
      setCreateConversationName('');
      setCreateConversationFieldValues({});
    },
    [],
  );

  useEffect(
    () => () => {
      if (conversationRefreshTimerRef.current !== null) {
        window.clearTimeout(conversationRefreshTimerRef.current);
      }
    },
    [],
  );
  const { loadMessages, loadOlderMessages, handleWsMessage } = useConversationRealtime({
    apiBase: API,
    activeConversation: activeConv,
    activeJidRef,
    chatStateRef,
    epochRef,
    seenIdsRef: seenIds,
    updateConversationChatState,
    scheduleConversationsRefresh,
    setUnreadRepliesByJid,
    setInterruptingConversationJid,
  });

  const updateConversationMeta = useCallback(
    async (
      jid: string,
      updates: {
        customTitle?: string | null;
        isPinned?: boolean;
        isFavorite?: boolean;
      },
    ) => {
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
          },
        );
        if (!res.ok) return;
        await loadConversations();
      } catch {
        /* offline */
      }
    },
    [loadConversations],
  );

  const setConversationProvider = useCallback(
    async (jid: string, providerId: string | null, model?: string | null) => {
      try {
        const payload: { providerId: string | null; model?: string | null } = {
          providerId,
        };
        if (model !== undefined) {
          payload.model = model;
        }
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) return;
        await loadConversations();
      } catch {
        /* offline */
      }
    },
    [loadConversations],
  );

  const loadConversationAccess = useCallback(async (jid: string) => {
    setConversationAccessLoading(true);
    try {
      const res = await fetch(
        `${API}/api/conversations/${encodeURIComponent(jid)}/access`,
      );
      if (!res.ok) return;
      const payload = await res.json().catch(() => null);
      setConversationAccessByJid((prev) => ({
        ...prev,
        [jid]: buildConversationAccessFromPayload(payload),
      }));
    } catch {
      /* offline */
    } finally {
      setConversationAccessLoading(false);
    }
  }, []);

  const loadConversationApprovals = useCallback(
    async (jid: string) => {
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}/approvals`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { approvals?: ApprovalRequest[] };
        updateConversationChatState(jid, (state) => ({
          ...state,
          approvals: Array.isArray(data.approvals) ? data.approvals : [],
        }));
      } catch {
        /* offline */
      }
    },
    [updateConversationChatState],
  );

  const resolveConversationApproval = useCallback(
    async (
      jid: string,
      approvalId: string,
      decision: 'allow-once' | 'deny',
      scope: ApprovalScope = 'current_runtime',
    ) => {
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}/approvals/${encodeURIComponent(approvalId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, scope }),
          },
        );
        if (!res.ok) return false;
        updateConversationChatState(jid, (state) => ({
          ...state,
          approvals: state.approvals.filter(
            (approval) => approval.id !== approvalId,
          ),
        }));
        void loadConversationAccess(jid);
        return true;
      } catch {
        return false;
      }
    },
    [loadConversationAccess, updateConversationChatState],
  );

  const interruptConversationReply = useCallback(
    async (jid: string) => {
      setInterruptingConversationJid(jid);
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}/interrupt`,
          {
            method: 'POST',
          },
        );
        const timestamp = new Date().toISOString();
        updateConversationChatState(jid, (state) =>
          interruptConversationState(state, {
            timestamp,
            reason: t('stoppedReply'),
          }),
        );
        void loadMessages(jid, epochRef.current);
        void loadConversations();
        return res.ok;
      } catch {
        updateConversationChatState(jid, expireLiveConversationTurns);
        return false;
      } finally {
        setInterruptingConversationJid((current) =>
          current === jid ? null : current,
        );
      }
    },
    [loadConversations, loadMessages, updateConversationChatState],
  );

  const regenerateConversationReply = useCallback(
    async (jid: string, turnId: string) => {
      setRegeneratingConversationJid(jid);
      setSendError(null);
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}/regenerate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turnId }),
          },
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          const message = data.error || t('app.0b7ce8');
          setSendError(message);
          window.setTimeout(() => setSendError(null), 6000);
          return false;
        }
        void loadMessages(jid, epochRef.current);
        void loadConversations();
        return true;
      } catch {
        setSendError(t('app.0b7ce8'));
        window.setTimeout(() => setSendError(null), 6000);
        return false;
      } finally {
        setRegeneratingConversationJid((current) =>
          current === jid ? null : current,
        );
      }
    },
    [loadConversations, loadMessages],
  );

  const saveConversationAccess = useCallback(
    async (
      jid: string,
      policy: AccessPolicy,
    ): Promise<true | { error: string }> => {
      setConversationAccessSaving(true);
      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(jid)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessPolicy: {
                mode: policy.mode,
                directories: policy.directories,
              },
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null) as {
            error?: string;
          } | null;
          if (res.status === 404) {
            void loadConversationAccess(jid);
            return {
              error:
                body?.error ||
                t('app.ec4516'),
            };
          }
          if (res.status === 403) {
            return {
              error:
                body?.error ||
                t('app.dcb774'),
            };
          }
          void loadConversationAccess(jid);
          return {
            error:
              body?.error || t('app.fcc3da'),
          };
        }
        const payload = await res.json().catch(() => null);
        setConversationAccessByJid((prev) => ({
          ...prev,
          [jid]: buildConversationAccessFromPayload(payload, policy),
        }));
        return true;
      } catch {
        return { error: t('app.75616e') };
      } finally {
        setConversationAccessSaving(false);
      }
    },
    [loadConversationAccess],
  );

  const loadSenderTrustConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/sender-trust`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { config?: SenderTrustConfig };
      setSenderTrustConfig(data.config || null);
    } catch {
      /* offline */
    }
  }, [markUnauthenticated]);

  const loadBuiltinWebFetchSiteProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/web-fetch-site-profiles`);
      if (res.status === 401) {
        markUnauthenticated();
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as {
        presets?: BuiltinWebFetchSiteProfilePreset[];
      };
      setBuiltinWebFetchSiteProfilePresets(
        Array.isArray(data.presets) ? data.presets : [],
      );
    } catch {
      /* offline */
    }
  }, [markUnauthenticated]);

  const saveSenderTrustConfig = useCallback(
    async (config: SenderTrustConfig) => {
      setSavingSenderTrust(true);
      setSenderTrustMessage('');
      try {
        const res = await fetch(`${API}/api/sender-trust`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config }),
        });
        const data = (await res.json().catch(() => null)) as {
          config?: SenderTrustConfig;
          error?: string;
        } | null;
        if (!res.ok) {
          setSenderTrustMessage(data?.error || t('app.9d5cad'));
          return false;
        }
        setSenderTrustConfig(data?.config || config);
        setSenderTrustMessage(t('app.0a02c2'));
        void loadDoctorReport();
        return true;
      } catch {
        setSenderTrustMessage(t('app.9d5cad'));
        return false;
      } finally {
        setSavingSenderTrust(false);
      }
    },
    [loadDoctorReport],
  );

  const pickConversationAccessDirectory = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/native/select-directory`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as {
        path?: string | null;
        cancelled?: boolean;
        error?: string;
        notAvailable?: boolean;
      } | null;
      if (!res.ok) {
        if (res.status === 501 && data?.notAvailable) {
          console.warn(
            'Native directory picker not available in server environment. Please provide directory path directly.',
          );
          return null;
        }
        throw new Error(data?.error || t('app.08e084'));
      }
      if (!data || data.cancelled || !data.path) return null;
      return data.path;
    } catch (err) {
      throw err instanceof Error ? err : new Error(t('app.08e084'));
    }
  }, []);

  const renameConversation = async (conversation: Conversation) => {
    setRenameDialog({
      open: true,
      conversation,
      value: getConversationTitle(conversation),
      saving: false,
    });
  };

  const closeRenameDialog = useCallback(() => {
    setRenameDialog((prev) =>
      prev.saving
        ? prev
        : {
            open: false,
            conversation: null,
            value: '',
            saving: false,
          },
    );
  }, []);

  const submitRenameDialog = useCallback(async () => {
    if (!renameDialog.conversation || renameDialog.saving) return;
    setRenameDialog((prev) => ({ ...prev, saving: true }));
    await updateConversationMeta(renameDialog.conversation.jid, {
      customTitle: renameDialog.value.trim() || null,
    });
    setRenameDialog({
      open: false,
      conversation: null,
      value: '',
      saving: false,
    });
  }, [renameDialog, updateConversationMeta]);

  useEffect(() => {
    loadAuthStatus();
  }, [loadAuthStatus]);

  // ── Effect 1: One-time bootstrap (core APIs only) ──
  const settingsLoadedRef = useRef(false);

  useEffect(() => {
    if (!authStatus?.authenticated) return;
    loadConversations();
    loadProviders();
    void refreshAssistants();
    void loadStatus();

    fetch('/api/live2d/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cfg) setLive2dConfig(cfg);
      })
      .catch(() => {});
  }, [authStatus?.authenticated, loadConversations, loadProviders, refreshAssistants, loadStatus]);

  // ── Effect 2: Polling fallback (60s, with visibility guard) ──

  useEffect(() => {
    if (!authStatus?.authenticated) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadConversations();
      void loadStatus();
    }, 60_000);
    return () => clearInterval(interval);
  }, [authStatus?.authenticated, loadConversations, loadStatus]);

  // ── Effect 3: Page-level lazy loading (Settings / Channels) ──
  useEffect(() => {
    if (!authStatus?.authenticated) return;
    if (page !== 'settings' && page !== 'channels') return;
    if (settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;

    loadConfig();
    loadConfigMeta();
    loadChannelConfigMeta();
    loadChannelConfig();
    loadWorkspaceCleanupSummary();
    loadExtensions();
    void loadDoctorReport();
    void loadSenderTrustConfig();
    void loadBuiltinWebFetchSiteProfiles();
  }, [
    authStatus?.authenticated,
    page,
    loadConfig,
    loadConfigMeta,
    loadChannelConfigMeta,
    loadChannelConfig,
    loadWorkspaceCleanupSummary,
    loadExtensions,
    loadDoctorReport,
    loadSenderTrustConfig,
    loadBuiltinWebFetchSiteProfiles,
  ]);

  const isMultiUser = auth.multiUserMode;

  const settingsVisibleTabs = useMemo<SettingsTab[]>(() => {
    const allSettingsTabs: SettingsTab[] = [
      'providers', 'prompt', 'web-search', 'general', 'knowledge', 'subagent', 'browser', 'live2d',
      'security', 'diagnostics', 'extensions', 'mcp', 'skills',
      'my-providers', 'my-channels', 'ssh-keys',
    ];
    if (!isMultiUser) return allSettingsTabs;
    return allSettingsTabs.filter((tab) => auth.canAccessSettingsTab(tab));
  }, [isMultiUser, auth.canAccessSettingsTab]);

  useEffect(() => {
    if (page !== 'chat' && page !== 'companion') return;
    fetch('/api/live2d/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => { if (cfg) setLive2dConfig(cfg); })
      .catch(() => {});
  }, [page]);

  // Load messages & subscribe when active conversation changes
  useEffect(() => {
    if (activeJid) {
      loadMessages(activeJid, epochRef.current);
      setHasMoreOlderByJid((prev) => ({ ...prev, [activeJid]: true }));
      subscribe(activeJid);
    }
  }, [activeJid, loadMessages]); // eslint-disable-line react-hooks/exhaustive-deps

  const getActiveChatSnapshot = useCallback(
    () => (activeJid ? chatStore.getJidState(activeJid) : EMPTY_CHAT_STATE),
    [activeJid, chatStore],
  );
  const activeChatState = useSyncExternalStore(
    chatStore.subscribe,
    getActiveChatSnapshot,
  );
  const activeMessages = activeChatState.messages;
  const activeAssistantTurns = activeChatState.turns;
  const activeApprovals = activeChatState.approvals;
  const pendingMessages = activeChatState.pendingMessages;
  const activeReplyState = useMemo(
    () => deriveConversationReplyState(activeChatState),
    [activeChatState],
  );
  const {
    typing,
    streaming,
    waitingReply,
    busy: assistantBusy,
  } = activeReplyState;
  const assistantInterrupting =
    !!activeJid && interruptingConversationJid === activeJid;
  const assistantRegenerating =
    !!activeJid && regeneratingConversationJid === activeJid;
  const busyByJid = useSyncExternalStore(
    chatStore.subscribeBusy,
    chatStore.getBusySnapshot.bind(chatStore),
  );
  const unresolvedPendingMessages = useMemo(() => {
    if (pendingMessages.length === 0) return pendingMessages;
    const conversationName = getConversationTitle(activeConv);
    const conversationChannel = activeConv?.channel;
    return pendingMessages.filter(
      (pendingMessage) =>
        !activeMessages.some((persistedMessage) =>
          isPendingMessageResolved(
            pendingMessage,
            persistedMessage,
            conversationChannel,
            conversationName,
          ),
        ),
    );
  }, [activeConv, activeMessages, pendingMessages]);
  const renderableAssistantTurns = useMemo(
    () => activeAssistantTurns.filter((turn) => shouldRenderTurn(turn)),
    [activeAssistantTurns],
  );
  const persistedTurnMessageIds = useMemo(
    () =>
      new Set(
        activeAssistantTurns
          .map((turn) => turn.persistedMessageId)
          .filter((messageId): messageId is string => Boolean(messageId)),
      ),
    [activeAssistantTurns],
  );
  const visibleMessages = useMemo(
    () =>
      [...activeMessages, ...unresolvedPendingMessages].filter(
        (message) => !persistedTurnMessageIds.has(message.id),
      ),
    [activeMessages, unresolvedPendingMessages, persistedTurnMessageIds],
  );
  const currentAssistantName = status?.assistant || 'NanoClaw';
  const currentAssistantNameRef = useRef(currentAssistantName);
  currentAssistantNameRef.current = currentAssistantName;

  const timelineEntries: ChatTimelineEntry[] = useMemo(
    () =>
      buildChatTimelineEntries({
        messages: visibleMessages,
        turns: renderableAssistantTurns,
        approvals: activeApprovals,
      }),
    [activeApprovals, renderableAssistantTurns, visibleMessages],
  );

  const selectedConversationItems = useMemo(
    () =>
      timelineEntries.filter((item) =>
        selectedConversationItemKeys.has(item.key),
      ),
    [timelineEntries, selectedConversationItemKeys],
  );

  const selectedItemsRef = useRef(selectedConversationItems);
  selectedItemsRef.current = selectedConversationItems;

  const timelineEntriesRef = useRef(timelineEntries);
  timelineEntriesRef.current = timelineEntries;

  const toggleMessageSelectionMode = useCallback(() => {
    setMessageSelectionMode((prev) => {
      const next = !prev;
      if (!next) setSelectedConversationItemKeys(new Set());
      return next;
    });
  }, []);

  const toggleConversationItemSelection = useCallback((key: string) => {
    setSelectedConversationItemKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllConversationItems = useCallback(() => {
    setSelectedConversationItemKeys((prev) => {
      const allKeys = timelineEntriesRef.current.map((item) => item.key);
      const isAllSelected =
        allKeys.length > 0 && allKeys.every((key) => prev.has(key));
      return isAllSelected ? new Set() : new Set(allKeys);
    });
  }, []);

  const exportConversationItemsAsMarkdown = useCallback(async (
    entryKeys: string[],
    options?: { clearSelection?: boolean },
  ) => {
    const conversation = activeConvRef.current;
    const itemKeySet = new Set(entryKeys);
    const items = timelineEntriesRef.current.filter((item) =>
      itemKeySet.has(item.key),
    );
    if (!conversation || items.length === 0) return;
    const content = formatTimelineMarkdown(
      conversation,
      items,
      currentAssistantNameRef.current,
    );
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = (getConversationTitle(conversation) || 'conversation')
      .replace(/[/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80);
    link.href = url;
    link.download = `${safeName}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (options?.clearSelection !== false) {
      setSelectedConversationItemKeys(new Set());
      setMessageSelectionMode(false);
    }
  }, [getConversationTitle]);

  const shareConversationItems = useCallback(async (
    entryKeys: string[],
    options?: { clearSelection?: boolean },
  ) => {
    const conversation = activeConvRef.current;
    const itemKeySet = new Set(entryKeys);
    const items = timelineEntriesRef.current.filter((item) =>
      itemKeySet.has(item.key),
    );
    if (!conversation || items.length === 0) return;
    try {
      const res = await fetch(`${API}/api/conversations/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: conversation.jid,
          title: getConversationTitle(conversation),
          entries: items,
          assistantName: currentAssistantNameRef.current,
        }),
      });
      if (!res.ok) throw new Error('share failed');
      const data = (await res.json()) as { shareId: string; url: string };
      setShareDialogUrl(data.url);
      if (options?.clearSelection !== false) {
        setSelectedConversationItemKeys(new Set());
        setMessageSelectionMode(false);
      }
    } catch {
      /* silently fail */
    }
  }, [getConversationTitle]);

  const exportSelectedConversationItemsAsMarkdown = useCallback(async () => {
    const keys = selectedItemsRef.current.map((item) => item.key);
    if (keys.length === 0) return;
    await exportConversationItemsAsMarkdown(keys);
  }, [exportConversationItemsAsMarkdown]);

  const shareSelectedConversationItems = useCallback(async () => {
    const keys = selectedItemsRef.current.map((item) => item.key);
    if (keys.length === 0) return;
    await shareConversationItems(keys);
  }, [shareConversationItems]);

  // Auto-scroll is handled by Virtuoso's followOutput prop.
  // No manual scrollTo — avoids the visible "scroll down" animation on conversation switch.

  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    autoScrollRef.current = distanceToBottom <= 80;
  }, []);

  const handleMessagesWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const container = messagesContainerRef.current;
      if (!container) return;

      if (event.deltaY < 0) {
        autoScrollRef.current = false;
        return;
      }

      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceToBottom <= 80) {
        autoScrollRef.current = true;
      }
    },
    [],
  );

  const handleMessagesTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
    },
    [],
  );

  const handleMessagesTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const container = messagesContainerRef.current;
      const currentY = event.touches[0]?.clientY ?? null;
      if (!container || currentY === null) return;

      if (lastTouchYRef.current !== null && currentY > lastTouchYRef.current) {
        autoScrollRef.current = false;
      } else {
        const distanceToBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceToBottom <= 80) {
          autoScrollRef.current = true;
        }
      }

      lastTouchYRef.current = currentY;
    },
    [],
  );

  const handleMessagesTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  // ── Conversation switching with epoch isolation ──

  const switchConversation = useCallback(
    (jid: string) => {
      epochRef.current++;
      seenIds.current = new Set();
      updateConversationChatState(activeJidRef.current, (state) => ({
        ...state,
        messages: [],
      }));
      setMessageSelectionMode(false);
      setSelectedConversationItemKeys(new Set());
      setUnreadRepliesByJid((prev) => {
        if (!prev[jid]) return prev;
        const next = { ...prev };
        delete next[jid];
        return next;
      });
      updateConversationChatState(jid, clearConversationTransientReplyState);
      setActiveJid(jid);
      navigate(`/chat/${encodeURIComponent(jid)}`, { replace: true });
    },
    [updateConversationChatState, navigate],
  );

  const switchConversationMobile = useCallback(
    (jid: string) => {
      switchConversation(jid);
      if (isMobile) setMobileConvDrawerOpen(false);
    },
    [switchConversation, isMobile],
  );

  const startTavernConversation = useCallback(
    async (tavernPersonaId: string) => {
      const res = await fetch(`${API}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Chat',
          type: 'web',
          channelType: 'web',
          tavernPersonaId,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data.error === 'string' ? data.error : t('app.984b1d'),
        );
      }
      const data = await res.json();
      const createdPolicy = extractPolicyFromPayload(data);
      if (createdPolicy || Array.isArray(data.allowedDirectories)) {
        setConversationAccessByJid((prev) => ({
          ...prev,
          [data.jid]: buildConversationAccessFromPayload(
            data,
            createdPolicy ??
              extractPolicyFromPayload({
                allowedDirectories: data.allowedDirectories,
              }),
          ),
        }));
      }
      autoScrollRef.current = true;
      switchConversation(data.jid);
      await loadConversations();
    },
    [API, loadConversations, switchConversation, t],
  );

  const loadOlderForActiveConversation = useCallback(async () => {
    const jid = activeJidRef.current;
    if (!jid) return;
    if (loadingOlderRef.current[jid]) return;
    const msgs = chatStore.getJidState(jid).messages;
    if (msgs.length === 0) return;
    const oldestTs = msgs[0].timestamp;
    if (!oldestTs) return;

    setLoadingOlderByJid((prev) => ({ ...prev, [jid]: true }));
    try {
      const loaded = await loadOlderMessages(jid, oldestTs, epochRef.current);
      if (loaded < MESSAGE_PAGE_SIZE) {
        setHasMoreOlderByJid((prev) => ({ ...prev, [jid]: false }));
      }
    } finally {
      setLoadingOlderByJid((prev) => ({ ...prev, [jid]: false }));
    }
  }, [loadOlderMessages, chatStore]);

  const activeHasMoreOlder = activeJid ? (hasMoreOlderByJid[activeJid] ?? true) : false;
  const activeLoadingOlder = activeJid ? (loadingOlderByJid[activeJid] ?? false) : false;

  useEffect(() => {
    if (isMobile && page !== 'chat') setMobileConvDrawerOpen(false);
  }, [isMobile, page]);

  const handleWsMessageWithLive2D = useCallback(
    (data: Record<string, unknown>) => {
      if (data.type === 'live2d_emotion') {
        setLive2dEmotion(data.emotion as Live2DEmotion);
        setTimeout(() => setLive2dEmotion(null), 5000);
        return;
      }
      handleWsMessage(data);
    },
    [handleWsMessage],
  );

  const { subscribe, subscribeAll, onReconnectRef } =
    useWebSocket(handleWsMessageWithLive2D);

  // Subscribe to all conversations for sidebar realtime updates
  useEffect(() => {
    if (conversations.length > 0) {
      subscribeAll(conversations.map((c) => c.jid));
    }
  }, [conversations, subscribeAll]);

  // Re-subscribe to all conversations on WebSocket reconnect
  useEffect(() => {
    onReconnectRef.current = () => {
      if (conversations.length > 0) {
        subscribeAll(conversations.map((c) => c.jid));
      }
    };
  }, [conversations, subscribeAll, onReconnectRef]);

  // Reconcile messages once when AI reply finishes (waitingReply true→false).
  // Also enforce a 120s timeout as safety net.
  const prevWaitingReplyRef = useRef(false);

  useEffect(() => {
    const wasWaiting = prevWaitingReplyRef.current;
    prevWaitingReplyRef.current = waitingReply;

    if (wasWaiting && !waitingReply && activeJid) {
      loadMessages(activeJid, epochRef.current);
    }
  }, [waitingReply, activeJid, loadMessages]);

  useEffect(() => {
    if (!waitingReply || !activeJid) return;
    const jid = activeJid;
    const timeout = setTimeout(() => {
      updateConversationChatState(jid, expireLiveConversationTurns);
    }, 120_000);
    return () => clearTimeout(timeout);
  }, [waitingReply, activeJid, updateConversationChatState]);

  // ── Send / Reset ──

  const selectUploadFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    const invalidSize = picked.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (invalidSize) {
      return;
    }
    setPendingUploadFiles((prev) => mergePendingUploadFiles(prev, picked));
  }, []);

  const removePendingUpload = useCallback((id: string) => {
    setPendingUploadFiles((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const applyMessageMemoryAction = useCallback(
    async (input: {
      jid: string;
      action: MessageMemoryAction;
      messageId: string;
      sender: string;
      senderName: string;
      text: string;
    }) => {
      const trimmedText = input.text.trim();
      if (!input.jid || !input.messageId || !trimmedText) return false;

      setMessageMemoryActionStateByMessageId((prev) => ({
        ...prev,
        [input.messageId]: {
          pendingAction: input.action,
        },
      }));

      try {
        const res = await fetch(
          `${API}/api/conversations/${encodeURIComponent(input.jid)}/memory-actions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: input.action,
              messageId: input.messageId,
              sender: input.sender,
              senderName: input.senderName,
              text: trimmedText,
            }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          result?: {
            status?: string;
            memoryClass?: string;
          };
        };

        if (!res.ok) {
          setMessageMemoryActionStateByMessageId((prev) => ({
            ...prev,
            [input.messageId]: {
              tone: 'error',
              message: data.error || t('app.37b444'),
            },
          }));
          return false;
        }

        setMessageMemoryActionStateByMessageId((prev) => ({
          ...prev,
          [input.messageId]: {
            tone: 'success',
            message: formatMessageMemoryActionSuccess({
              action: input.action,
              result: data.result,
            }, t),
          },
        }));
        return true;
      } catch {
        setMessageMemoryActionStateByMessageId((prev) => ({
          ...prev,
          [input.messageId]: {
            tone: 'error',
            message: t('app.37b444'),
          },
        }));
        return false;
      }
    },
    [],
  );

  const handleMessageMemoryAction = useCallback(
    (payload: {
      action: 'remember' | 'session_only';
      messageId: string;
      sender: string;
      senderName: string;
      text: string;
    }) => {
      void applyMessageMemoryAction({
        jid: activeJidRef.current || '',
        ...payload,
      });
    },
    [applyMessageMemoryAction],
  );

  const handleOpenLive2dConfig = useCallback(() => {
    setLive2dChatConfigOpen(true);
  }, []);

  const handleLive2dClose = useCallback(() => {
    setLive2dConfig((prev) =>
      prev
        ? { ...prev, preferences: { ...prev.preferences, enabled: false } }
        : prev,
    );
  }, []);

  const handleLive2dOpenSettings = useCallback(() => {
    navigate(navPageToPath('settings', 'live2d'));
  }, [navigate]);

  const live2dScaleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleLive2dScaleChange = useCallback((scale: number) => {
    setLive2dConfig((prev) => {
      if (!prev?.preferences) return prev;
      return { ...prev, preferences: { ...prev.preferences, modelScale: scale } };
    });
    if (live2dScaleSaveTimer.current) clearTimeout(live2dScaleSaveTimer.current);
    live2dScaleSaveTimer.current = setTimeout(() => {
      setLive2dConfig((prev) => {
        if (!prev?.preferences) return prev;
        void fetch('/api/live2d/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(prev.preferences),
        });
        return prev;
      });
    }, 600);
  }, []);

  const EMPTY_CONVERSATION_ACCESS = useMemo(() => buildConversationAccess(), []);

  const activeConversationAccess = useMemo(
    () =>
      activeJid
        ? conversationAccessByJid[activeJid] || EMPTY_CONVERSATION_ACCESS
        : null,
    [activeJid, conversationAccessByJid, EMPTY_CONVERSATION_ACCESS],
  );

  const pendingUploadProps = useMemo(
    () =>
      pendingUploadFiles.map((item) => ({
        id: item.id,
        name: item.file.name,
        size: item.file.size,
        mimeType: item.file.type || 'application/octet-stream',
      })),
    [pendingUploadFiles],
  );

  const sendMessage = async () => {
    const text = input.trim();
    if (
      (!text && pendingUploadFiles.length === 0) ||
      !activeJid ||
      assistantBusy ||
      uploadingFiles
    )
      return;
    const isSlashCommand = text.startsWith('/');
    const uploadSnapshot = [...pendingUploadFiles];
    setInput('');
    setPendingUploadFiles([]);

    // Handle /reset command
    if (text === '/reset' && uploadSnapshot.length === 0) {
      try {
        await fetch(
          `${API}/api/conversations/${encodeURIComponent(activeJid)}/reset`,
          { method: 'POST' },
        );
        epochRef.current++;
        seenIds.current = new Set();
        updateConversationChatState(activeJid, () => ({
          ...EMPTY_CHAT_STATE,
        }));
        setMessageSelectionMode(false);
        setSelectedConversationItemKeys(new Set());
        loadConversations();
      } catch {
        /* offline */
      }
      return;
    }

    const localId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const latestTimelineTime =
      timelineEntries.length > 0
        ? Date.parse(timelineEntries[timelineEntries.length - 1].timestamp)
        : Number.NaN;
    const timestampMs = Number.isFinite(latestTimelineTime)
      ? Math.max(Date.now(), latestTimelineTime + 1)
      : Date.now();
    const timestamp = new Date(timestampMs).toISOString();
    autoScrollRef.current = true;
    const optimisticContent =
      uploadSnapshot.length > 0
        ? `${text}${text ? '\n\n' : ''}${t('app.uploadedFiles', { names: uploadSnapshot.map((item) => item.file.name).join(', ') })}`
        : text;
    updateConversationChatState(activeJid, (state) => ({
      ...state,
      turns: isSlashCommand
        ? clearOptimisticTurns(state.turns)
        : ensureOptimisticWaitingTurn(state.turns, timestamp),
      pendingMessages: [
        ...state.pendingMessages,
        {
          clientId: localId,
          id: localId,
          sender: 'web_user',
          sender_name: 'You',
          content: optimisticContent || t('app.53206e'),
          timestamp,
          is_from_me: true,
          is_bot_message: 0,
        },
      ],
    }));
    setSendError(null);
    try {
      let uploadedFiles: UploadedChatFile[] = [];
      if (uploadSnapshot.length > 0) {
        setUploadingFiles(true);
        const uploadPayload = await Promise.all(
          uploadSnapshot.map(async (item) => ({
            name: item.file.name,
            mimeType: item.file.type || 'application/octet-stream',
            contentBase64: await fileToBase64(item.file, t),
          })),
        );
        const uploadRes = await fetch(`${API}/api/files/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatJid: activeJid,
            files: uploadPayload,
          }),
        });
        if (!uploadRes.ok) {
          const uploadError = (await uploadRes.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(uploadError.error || 'upload_failed');
        }
        const uploadData = (await uploadRes.json()) as {
          files?: UploadedChatFile[];
        };
        uploadedFiles = Array.isArray(uploadData.files) ? uploadData.files : [];
      }
      const res = await fetch(
        `${API}/api/conversations/${encodeURIComponent(activeJid)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: text,
            clientId: localId,
            uploadedFiles,
          }),
        },
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error || t('app.9ca6a3'));
      }
      const ack = normalizeConversationSendAck(
        await res.json().catch(() => ({})),
      );
      updateConversationChatState(activeJid, (state) => ({
        ...applyConversationRealtimeWatermark(
          state,
          ack.last_event_seq,
          'send_ack',
        ),
        pendingMessages: state.pendingMessages.map((message) =>
          message.clientId === localId
            ? {
                ...message,
                client_id: ack.clientId ?? message.client_id,
                run_id: ack.runId ?? message.run_id,
                runId: ack.runId ?? message.runId,
              }
            : message,
        ),
      }));
      if (activeConvRef.current?.channel !== 'web') {
        void loadMessages(activeJid, epochRef.current);
      }
    } catch (err) {
      updateConversationChatState(activeJid, (state) => ({
        ...state,
        pendingMessages: state.pendingMessages.filter(
          (message) => message.clientId !== localId,
        ),
        turns: clearOptimisticTurns(state.turns),
      }));
      setInput(text);
      setPendingUploadFiles(uploadSnapshot);
      const msg = err instanceof Error ? err.message : t('app.9ca6a3');
      setSendError(msg);
      setTimeout(() => setSendError(null), 6000);
    } finally {
      setUploadingFiles(false);
    }
  };

  const inputHintText =
    pendingUploadFiles.length > 0
      ? t('app.inputWithFiles', { count: pendingUploadFiles.length })
      : t('app.ab8e39');

  const createConversation = useCallback((assistantId?: string | null) => {
    setCreateConversationAssistantId(assistantId || null);
    setCreateConversationOpen(true);
    setCreateConversationError('');
    setCreateConversationName('');
    setCreateConversationFieldValues({});
  }, []);

  const showNativeConfirm = useCallback(
    async ({ title, message, confirmLabel }: NativeDialogLike) => {
      return await new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmDialog({
          open: true,
          title,
          message,
          confirmLabel,
        });
      });
    },
    [],
  );

  const closeConfirmDialog = useCallback((confirmed: boolean) => {
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    resolve?.(confirmed);
  }, []);

  const clearConversationStateIfNeeded = (jidsToDelete: string[]) => {
    setSelectedConversationJids((prev) => {
      const next = new Set(prev);
      jidsToDelete.forEach((jid) => next.delete(jid));
      return next;
    });

    if (activeJid && jidsToDelete.includes(activeJid)) {
      const remaining = conversations.filter(
        (c) => !jidsToDelete.includes(c.jid),
      );
      epochRef.current++;
      seenIds.current = new Set();
      updateConversationChatState(activeJid, (state) => ({
        ...state,
        messages: [],
        pendingMessages: [],
        turns: [],
      }));
      const nextJid = remaining[0]?.jid || null;
      setActiveJid(nextJid);
      navigate(nextJid ? `/chat/${encodeURIComponent(nextJid)}` : '/chat', { replace: true });
    }
  };

  const deleteConversations = async (jids: string[]) => {
    if (jids.length === 0) return;
    try {
      const results = await Promise.all(
        jids.map(async (jid) => {
          const res = await fetch(
            `${API}/api/conversations/${encodeURIComponent(jid)}`,
            {
              method: 'DELETE',
            },
          );
          return res.ok;
        }),
      );
      const deletedJids = jids.filter((_, idx) => results[idx]);
      if (deletedJids.length === 0) return;
      clearConversationStateIfNeeded(deletedJids);
      await loadConversations();
    } catch {
      /* offline */
    }
  };

  const deleteConversationByJid = async (jid: string, name: string) => {
    const confirmed = await showNativeConfirm({
      title: t('app.1021bd'),
      message: t('app.confirmDeleteConversation', { name: name || jid }),
      confirmLabel: t('app.4a368d'),
    });
    if (!confirmed) return;
    await deleteConversations([jid]);
  };

  const deleteSelectedConversations = async () => {
    if (!batchDeleteEnabled) return;

    const selected = conversations.filter((c) =>
      selectedConversationJids.has(c.jid),
    );
    if (selected.length === 0) return;

    const confirmed = await showNativeConfirm({
      title: t('app.465839'),
      message: t('app.confirmDeleteSelected', { count: selected.length }),
      confirmLabel: t('app.4a368d'),
    });
    if (!confirmed) return;

    await deleteConversations(selected.map((c) => c.jid));
    setSelectedConversationJids(new Set());
    setBatchDeleteEnabled(false);
  };

  const toggleBatchDeleteEnabled = () => {
    setBatchDeleteEnabled((prev) => {
      const next = !prev;
      if (!next) {
        setSelectedConversationJids(new Set());
      }
      return next;
    });
  };

  const toggleConversationSelection = (jid: string) => {
    if (!batchDeleteEnabled) return;

    setSelectedConversationJids((prev) => {
      const next = new Set(prev);
      if (next.has(jid)) next.delete(jid);
      else next.add(jid);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (!batchDeleteEnabled) return;

    const visibleJids = sidebarConversations.map((c) => c.jid);
    const allSelected =
      visibleJids.length > 0 &&
      visibleJids.every((jid) => selectedConversationJids.has(jid));

    setSelectedConversationJids((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        visibleJids.forEach((jid) => next.delete(jid));
      } else {
        visibleJids.forEach((jid) => next.add(jid));
      }
      return next;
    });
  };

  const handleLogin = async () => {
    if (!loginForm.username.trim() || !loginForm.password) {
      setLoginError(t('app.dab2bc'));
      return;
    }

    setLoggingIn(true);
    setLoginError('');
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginError(data.error || t('app.b6076a'));
        return;
      }
      setAuthStatus({
        authenticated: true,
        username: data.username || loginForm.username,
        loginEnabled: data.loginEnabled !== false,
        multiUserMode: data.multiUserMode === true,
        userId: typeof data.userId === 'string' ? data.userId : null,
        displayName:
          typeof data.displayName === 'string' ? data.displayName : null,
        roles: Array.isArray(data.roles) ? data.roles : [],
        permissions: Array.isArray(data.permissions) ? data.permissions : [],
        bootstrapMode: data.bootstrapMode === true,
        weakCredentials: data.weakCredentials === true,
      });
      setLoginForm((prev) => ({
        ...prev,
        password: data.multiUserMode === true ? '' : 'admin123',
      }));
      setLoginPasswordVisible(false);
    } catch {
      setLoginError(t('app.5b8c6c'));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleRegister = async () => {
    if (!registerForm.username.trim() || !registerForm.password) {
      setLoginError(t('app.dab2bc'));
      return;
    }
    if (registerForm.password.length < 6) {
      setLoginError(t('app.bb6a22'));
      return;
    }

    setLoggingIn(true);
    setLoginError('');
    try {
      const res = await fetch(`${API}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginError(data.error || t('app.1c56d8'));
        return;
      }
      setAuthStatus({
        authenticated: true,
        username: data.username,
        loginEnabled: true,
        multiUserMode: true,
        userId: data.userId,
        displayName: data.displayName,
        roles: [],
        permissions: [],
      });
    } catch {
      setLoginError(t('app.bd5372'));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API}/api/auth/logout`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    markUnauthenticated();
    setConversations([]);
    chatStore.reset();
    setActiveJid(null);
    setStatus(null);
    setProviders([]);
    setUnreadRepliesByJid({});
    setMessageSelectionMode(false);
    setSelectedConversationItemKeys(new Set());
  };

  const {
    saveProvider,
    deleteProviderById,
    activateProvider,
    activateGlobalProvider,
    clearDefaultProvider,
    testProvider,
  } =
    useProviderActions({
      apiBase: API,
      providers,
      editingProvider,
      setEditingProvider,
      setTestingId,
      setTestResults,
      showNativeConfirm,
      loadProviders,
      loadStatus,
      loadDoctorReport,
    });

  const { addChannelInstance, saveBasicSettings, saveChannelSettings } =
    useSettingsActions({
      apiBase: API,
      basicConfig,
      configMeta,
      channelTypes,
      channelInstances,
      isSensitiveConfigKey,
      serializeConfigValue,
      createChannelInstanceId,
      buildConfigSaveMessage,
      setBasicConfig,
      setSavingBasicConfig,
      setBasicConfigMessage,
      setChannelInstances,
      setSavingChannelConfig,
      setChannelConfigMessage,
      loadAuthStatus,
      loadConfigMeta,
      loadChannelConfig,
      loadChannelConfigMeta,
      loadStatus,
      loadDoctorReport,
    });

  const {
    saveManagedMcpServers,
    installManagedMcpFromPath,
    saveEnabledSkills,
    installSkillFromPath,
    deleteCustomSkillById,
    saveExtensionMarketplaceSources,
    loadExtensionMarketplaceCatalog,
    installMarketplaceExtension,
    importExtensionFromSource,
    uninstallExtensionInstall,
    reconcileExtensionInstalls,
    extensionActionStatus,
    cleanupOrphanWorkspaces,
  } = useExtensionMaintenanceActions({
    apiBase: API,
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
  });

  const terminalEnabled =
    status?.capabilities?.terminal?.available ??
    status?.webTerminalEnabled ??
    basicConfig.WEB_TERMINAL_ENABLED === true;
  const stockAnalysisEnabled =
    status?.stockAnalysisEnabled ??
    basicConfig.WEB_STOCK_ANALYSIS_ENABLED === true;
  const inputComposingRef = useRef(false);
  const { terminalRef } = useTerminalSession({
    page,
    setPage,
    terminalEnabled,
    activeJid,
  });

  const availableChannels = useMemo(() => {
    const uniqueChannels = new Set(
      [
        ...conversations.map((conversation) =>
          normalizeChannelFilterKey(conversation.channel || ''),
        ),
        ...(status?.channels || []).map((channel) =>
          normalizeChannelFilterKey(channel.name || ''),
        ),
      ].filter(Boolean),
    );

    return [...uniqueChannels].sort((left, right) => {
      const leftIndex = CHANNEL_FILTER_ORDER.indexOf(left);
      const rightIndex = CHANNEL_FILTER_ORDER.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
      }
      return left.localeCompare(right);
    });
  }, [conversations, status?.channels]);
  const createConversationOptions = useMemo<CreateConversationOption[]>(() => {
    const options: CreateConversationOption[] = [
      {
        key: 'web',
        type: 'web',
        label: 'Web',
        supported: true,
        description: t('app.01d767'),
        fields: [],
      },
    ];

    const targetsByType = new Map(
      conversationTargets.map((target) => [target.type, target]),
    );

    for (const typeDefinition of channelTypes) {
      const targetDefinition = targetsByType.get(typeDefinition.type);
      const support = targetDefinition
        ? {
            supported: targetDefinition.creatable,
            requiresInstance: targetDefinition.requiresConfiguredInstance,
            description: targetDefinition.description,
            reason: targetDefinition.unavailableReason,
            fields: targetDefinition.fields,
          }
        : typeDefinition.webConversation
          ? {
              supported: typeDefinition.webConversation.supported,
              requiresInstance: typeDefinition.webConversation.requiresInstance,
              description:
                typeDefinition.webConversation.description ||
                typeDefinition.description,
              reason: typeDefinition.webConversation.unsupportedReason,
              fields: typeDefinition.webConversation.fields || [],
            }
          : getFallbackConversationSupport(typeDefinition.type, t);
      const enabledInstances = channelInstances.filter(
        (instance) => instance.enabled && instance.type === typeDefinition.type,
      );

      if (!support.requiresInstance) {
        if (typeDefinition.type === 'web') continue;
        options.push({
          key: typeDefinition.type,
          type: typeDefinition.type,
          label: typeDefinition.label,
          supported: support.supported,
          description: support.description || typeDefinition.description,
          reason: support.reason,
          fields: decorateCreateConversationFields(
            typeDefinition.type,
            undefined,
            support.fields || [],
            conversations,
            t,
          ),
        });
        continue;
      }

      if (enabledInstances.length === 0) {
        options.push({
          key: `${typeDefinition.type}:missing`,
          type: typeDefinition.type,
          label: typeDefinition.label,
          supported: false,
          description: support.description || typeDefinition.description,
          reason: t('app.needConfigChannel', { label: typeDefinition.label }),
          fields: decorateCreateConversationFields(
            typeDefinition.type,
            undefined,
            support.fields || [],
            conversations,
            t,
          ),
        });
        continue;
      }

      for (const instance of enabledInstances) {
        options.push({
          key: `${typeDefinition.type}:${instance.id}`,
          type: typeDefinition.type,
          instanceId: instance.id,
          label: `${typeDefinition.label} · ${instance.name}`,
          supported: support.supported,
          description: support.description || typeDefinition.description,
          reason: support.reason,
          fields: decorateCreateConversationFields(
            typeDefinition.type,
            instance.id,
            support.fields || [],
            conversations,
            t,
          ),
        });
      }
    }

    if (!createConversationAssistantId) {
      return options;
    }

    return options.map((option) =>
      option.type === 'web'
        ? option
        : {
            ...option,
            supported: false,
            reason: t('app.8a9dec'),
          },
    );
  }, [
    channelInstances,
    channelTypes,
    conversationTargets,
    conversations,
    createConversationAssistantId,
  ]);

  const selectedCreateConversationOption = useMemo(
    () =>
      createConversationOptions.find(
        (option) => option.key === createConversationOptionKey,
      ) ||
      createConversationOptions[0] ||
      null,
    [createConversationOptionKey, createConversationOptions],
  );
  const createConversationAssistant = useMemo(
    () =>
      createConversationAssistantId
        ? assistants.find((assistant) => assistant.id === createConversationAssistantId) ||
          null
        : null,
    [assistants, createConversationAssistantId],
  );

  useEffect(() => {
    if (createConversationOptions.length === 0) {
      setCreateConversationOptionKey('');
      return;
    }
    if (
      createConversationOptions.some(
        (option) => option.key === createConversationOptionKey,
      )
    ) {
      return;
    }
    const firstSupported = createConversationOptions.find(
      (option) => option.supported,
    );
    setCreateConversationOptionKey(
      firstSupported?.key || createConversationOptions[0]!.key,
    );
  }, [createConversationOptionKey, createConversationOptions]);

  useEffect(() => {
    const option = selectedCreateConversationOption;
    if (!option) return;

    const nextValues = { ...createConversationFieldValues };
    let changed = false;

    for (const field of option.fields) {
      if (field.type !== 'select' || !field.options?.length) {
        continue;
      }
      const currentValue = String(nextValues[field.key] || '').trim();
      const stillValid = field.options.some(
        (entry) => entry.value === currentValue,
      );
      if (stillValid) {
        continue;
      }
      nextValues[field.key] = field.options[0]!.value;
      changed = true;
    }

    if (changed) {
      setCreateConversationFieldValues(nextValues);
    }
  }, [createConversationFieldValues, selectedCreateConversationOption]);

  const closeCreateConversation = useCallback(() => {
    if (creatingConversation) return;
    setCreateConversationOpen(false);
    setCreateConversationError('');
    setCreateConversationAssistantId(null);
  }, [creatingConversation]);

  const submitCreateConversation = useCallback(async () => {
    const option = selectedCreateConversationOption;
    if (!option || !option.supported) return;

    const missingField = option.fields.find(
      (field) =>
        field.required &&
        !String(createConversationFieldValues[field.key] || '').trim(),
    );
    if (missingField) {
      setCreateConversationError(t('app.fillRequired', { field: missingField.label }));
      return;
    }

    setCreatingConversation(true);
    setCreateConversationError('');
    try {
      const target = Object.fromEntries(
        option.fields.map((field) => [
          field.key,
          String(createConversationFieldValues[field.key] || '').trim(),
        ]),
      );
      const payload: Record<string, unknown> = {
        name: createConversationName.trim() || 'New Chat',
        type: option.type,
        channelType: option.type,
        instanceId: option.instanceId,
        channelInstanceId: option.instanceId,
        target,
      };
      if (createConversationAssistantId) {
        payload.assistantId = createConversationAssistantId;
      }
      for (const [key, value] of Object.entries(target)) {
        payload[key] = value;
      }

      const res = await fetch(`${API}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          typeof data.error === 'string' ? data.error : t('app.984b1d'),
        );
      }

      const data = await res.json();
      const createdPolicy = extractPolicyFromPayload(data);
      if (createdPolicy || Array.isArray(data.allowedDirectories)) {
        setConversationAccessByJid((prev) => ({
          ...prev,
          [data.jid]: buildConversationAccessFromPayload(
            data,
            createdPolicy ??
              extractPolicyFromPayload({
                allowedDirectories: data.allowedDirectories,
              }),
          ),
        }));
      }
      autoScrollRef.current = true;
      switchConversation(data.jid);
      await loadConversations();
      setCreateConversationOpen(false);
      setCreateConversationName('');
      setCreateConversationFieldValues({});
    } catch (error) {
      setCreateConversationError(
        error instanceof Error ? error.message : t('app.984b1d'),
      );
    } finally {
      setCreatingConversation(false);
    }
  }, [
    createConversationAssistantId,
    createConversationFieldValues,
    createConversationName,
    loadConversations,
    selectedCreateConversationOption,
    switchConversation,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & {
      isComposing?: boolean;
      keyCode?: number;
    };
    const isComposing =
      inputComposingRef.current ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229;

    if (isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputCompositionStart = () => {
    inputComposingRef.current = true;
  };

  const handleInputCompositionEnd = () => {
    inputComposingRef.current = false;
  };

  const sortConversationsByRecent = useCallback(
    (left: Conversation, right: Conversation) => {
      const leftPinned = left.is_pinned ? 1 : 0;
      const rightPinned = right.is_pinned ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      return (
        Date.parse(right.last_message_time || '') -
        Date.parse(left.last_message_time || '')
      );
    },
    [],
  );

  const conversationsByRecent = useMemo(
    () => [...conversations].sort(sortConversationsByRecent),
    [conversations, sortConversationsByRecent],
  );

  const channelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: conversations.length };
    for (const conversation of conversations) {
      const key = normalizeChannelFilterKey(conversation.channel || '');
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [conversations]);

  const filteredConversations = useMemo(
    () =>
      conversationsByRecent.filter(
        (conversation) =>
          channelFilter === 'all' ||
          normalizeChannelFilterKey(conversation.channel || '') ===
            channelFilter,
      ),
    [channelFilter, conversationsByRecent],
  );

  useEffect(() => {
    if (channelFilter === 'all') return;
    if (availableChannels.includes(channelFilter)) return;
    setChannelFilter('all');
  }, [availableChannels, channelFilter]);

  const sidebarConversations = useMemo(() => {
    const searched = filteredConversations;

    if (conversationSort === 'unread') {
      return [...searched].sort((left, right) => {
        const leftUnread = unreadRepliesByJid[left.jid] || 0;
        const rightUnread = unreadRepliesByJid[right.jid] || 0;
        if (leftUnread !== rightUnread) return rightUnread - leftUnread;

        const leftPinned = left.is_pinned ? 1 : 0;
        const rightPinned = right.is_pinned ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        return (
          Date.parse(right.last_message_time || '') -
          Date.parse(left.last_message_time || '')
        );
      });
    }

    if (conversationSort === 'name') {
      return [...searched].sort((left, right) => {
        const leftPinned = left.is_pinned ? 1 : 0;
        const rightPinned = right.is_pinned ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        const leftTitle = getConversationTitle(left) || left.jid;
        const rightTitle = getConversationTitle(right) || right.jid;
        return leftTitle.localeCompare(rightTitle, 'zh-Hans-CN');
      });
    }

    return searched;
  }, [conversationSort, filteredConversations, unreadRepliesByJid]);

  const visibleConversationJids = useMemo(
    () => sidebarConversations.map((conversation) => conversation.jid),
    [sidebarConversations],
  );
  const selectedVisibleCount = useMemo(
    () =>
      visibleConversationJids.filter((jid) => selectedConversationJids.has(jid))
        .length,
    [selectedConversationJids, visibleConversationJids],
  );
  const allVisibleSelected =
    visibleConversationJids.length > 0 &&
    selectedVisibleCount === visibleConversationJids.length;

  useEffect(() => {
    if (location.pathname === '/') {
      navigate(navPageToPath('chat'), { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    if (!terminalEnabled && page === 'terminal') {
      navigate(navPageToPath('chat'), { replace: true });
    }
  }, [terminalEnabled, page, navigate]);

  useEffect(() => {
    if (!stockAnalysisEnabled && page === 'stock-analysis') {
      navigate(navPageToPath('chat'), { replace: true });
    }
  }, [stockAnalysisEnabled, page, navigate]);

  useEffect(() => {
    if (authStatus === null) return;
    if (!auth.canAccessPage(page)) {
      const candidates: NavPage[] = ['chat', 'repos', 'settings'];
      const fallback = candidates.find((p) => auth.canAccessPage(p)) ?? 'chat';
      navigate(navPageToPath(fallback), { replace: true });
    }
  }, [authStatus, page, auth.canAccessPage, navigate]);

  useEffect(() => {
    if (page !== 'chat') return;
    const urlJid = decodeURIComponent(location.pathname.split('/')[2] || '');
    if (!urlJid || urlJid === activeJidRef.current) return;
    if (conversations.some((c) => c.jid === urlJid)) {
      switchConversation(urlJid);
    }
  }, [page, location.pathname, conversations, switchConversation]);

  useEffect(() => {
    if (page !== 'assistants') return;
    const urlId = decodeURIComponent(location.pathname.split('/')[2] || '');
    if (urlId !== (assistantPageTargetId ?? '')) {
      setAssistantPageTargetId(urlId || null);
    }
  }, [page, location.pathname, assistantPageTargetId]);

  useEffect(() => {
    if (!activeJid || !authStatus?.authenticated) return;
    void loadConversationAccess(activeJid);
    void loadConversationApprovals(activeJid);
  }, [
    activeJid,
    authStatus?.authenticated,
    loadConversationAccess,
    loadConversationApprovals,
  ]);

  const assistantName = currentAssistantName;
  const llmProviders = useMemo(
    () => providers.filter((provider) => (provider.capability || 'llm') === 'llm'),
    [providers],
  );
  const activeProviderId = useMemo(() => {
    const userPreference = llmProviders.find((p) => p.is_user_default);
    if (userPreference) return userPreference.id;
    const userDefault = llmProviders.find(
      (p) => p.source === 'own' && p.is_default === 1,
    );
    if (userDefault) return userDefault.id;
    const firstOwn = llmProviders.find((p) => p.source === 'own');
    if (firstOwn) return firstOwn.id;
    const globalDefault = llmProviders.find((p) => p.is_global_default);
    if (globalDefault) return globalDefault.id;
    return (
      llmProviders.find((p) => p.is_default === 1)?.id || llmProviders[0]?.id || null
    );
  }, [llmProviders]);
  const activeProviderAlias = useMemo(() => {
    if (activeConv?.conversationProviderAlias) {
      return activeConv.conversationProviderAlias;
    }
    if (activeConv?.assistantProviderAlias) {
      return activeConv.assistantProviderAlias;
    }
    const fromList = activeProviderId
      ? llmProviders.find((p) => p.id === activeProviderId)?.alias
      : undefined;
    if (fromList) return fromList;
    return status?.providerAlias || status?.provider || 'claude';
  }, [
    activeConv?.assistantProviderAlias,
    activeConv?.conversationProviderAlias,
    activeProviderId,
    llmProviders,
    status?.provider,
    status?.providerAlias,
  ]);
  const activeAssistantLabel = activeConv?.assistantName || null;
  const loginEnabled = authStatus?.loginEnabled !== false;
  const loginDisplayName = loginEnabled
    ? authStatus?.username ||
      (typeof basicConfig.WEB_LOGIN_USERNAME === 'string'
        ? basicConfig.WEB_LOGIN_USERNAME
        : '') ||
      'admin'
    : t('app.25f2c4');
  const saveActiveConversationAccess = useCallback(
    (policy: AccessPolicy): Promise<true | { error: string }> =>
      activeJid
        ? saveConversationAccess(activeJid, policy)
        : Promise.resolve({ error: t('app.3a6963') }),
    [activeJid, saveConversationAccess],
  );
  const resolveActiveConversationApproval = useCallback(
    (
      approvalId: string,
      decision: 'allow-once' | 'deny',
      scope: ApprovalScope = 'current_runtime',
    ) =>
      activeJid
        ? resolveConversationApproval(activeJid, approvalId, decision, scope)
        : Promise.resolve(false),
    [activeJid, resolveConversationApproval],
  );
  const interruptActiveConversationReply = useCallback(
    () =>
      activeJid
        ? interruptConversationReply(activeJid).then(() => undefined)
        : Promise.resolve(),
    [activeJid, interruptConversationReply],
  );
  const regenerateActiveConversationReply = useCallback(
    (turnId: string) =>
      activeJid
        ? regenerateConversationReply(activeJid, turnId).then(() => undefined)
        : Promise.resolve(),
    [activeJid, regenerateConversationReply],
  );
  const openAssistantsPage = useCallback((assistantId?: string | null) => {
    const id = assistantId?.trim() || null;
    setAssistantPageTargetId(id);
    navigate(id ? `/assistants/${encodeURIComponent(id)}` : navPageToPath('assistants'));
  }, [navigate]);
  const openSettingsPage = useCallback(
    (section?: 'default-access-policy') => {
      setSettingsPageTarget(section || null);
      navigate(navPageToPath('settings', 'general'));
    },
    [navigate],
  );
  const clearAssistantPageTarget = useCallback(() => {
    setAssistantPageTargetId(null);
    if (location.pathname.startsWith('/assistants/')) {
      navigate(navPageToPath('assistants'), { replace: true });
    }
  }, [location.pathname, navigate]);
  const clearSettingsPageTarget = useCallback(() => {
    setSettingsPageTarget(null);
  }, []);
  if (authStatus?.authenticated === false) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-logo">N</div>
          <h1>{isRegisterMode ? t('app.ec925e') : t('app.36bb34')}</h1>
          <p className="login-subtitle">
            {isRegisterMode
              ? t('app.50ecaf')
              : t('app.3253c9')}
          </p>
          {!isRegisterMode && (
            <div className="login-hint">
              {authStatus?.ldapEnabled
                ? t('app.796a49')
                : authStatus?.bootstrapMode
                  ? t('app.d81cb6')
                  : authStatus?.weakCredentials
                    ? t('app.4eac28')
                    : t('app.673e21')}
            </div>
          )}

          {isRegisterMode ? (
            <>
              <div className="form-group">
                <label>{t('app.819767')}</label>
                <input
                  value={registerForm.username}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({ ...prev, username: e.target.value }))
                  }
                  placeholder={t('app.464421')}
                  onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                />
              </div>
              <div className="form-group">
                <label>{t('app.d1e957')}</label>
                <input
                  value={registerForm.displayName}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({ ...prev, displayName: e.target.value }))
                  }
                  placeholder={t('app.7cac1c')}
                />
              </div>
              <div className="form-group">
                <label>{t('app.a81052')}</label>
                <div className="password-field">
                  <input
                    className="password-field-input"
                    type={loginPasswordVisible ? 'text' : 'password'}
                    value={registerForm.password}
                    onChange={(e) =>
                      setRegisterForm((prev) => ({ ...prev, password: e.target.value }))
                    }
                    placeholder={t('app.d24b1a')}
                    onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                  />
                  <button
                    type="button"
                    className={`password-visibility-indicator${loginPasswordVisible ? ' is-visible' : ''}`}
                    onClick={() => setLoginPasswordVisible((prev) => !prev)}
                    aria-label={loginPasswordVisible ? t('app.dd909a') : t('app.5f26be')}
                    title={loginPasswordVisible ? t('app.dd909a') : t('app.5f26be')}
                  >
                    {loginPasswordVisible ? <IconEyeOff /> : <IconEye />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label>{authStatus?.ldapEnabled ? t('app.1a4a2b') : t('app.819767')}</label>
                <input
                  value={loginForm.username}
                  onChange={(e) =>
                    setLoginForm((prev) => ({ ...prev, username: e.target.value }))
                  }
                  placeholder={authStatus?.ldapEnabled ? t('app.5fc63d') : t('app.08b1fa')}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                />
              </div>
              <div className="form-group">
                <label>{t('app.a81052')}</label>
                <div className="password-field">
                  <input
                    className="password-field-input"
                    type={loginPasswordVisible ? 'text' : 'password'}
                    value={loginForm.password}
                    onChange={(e) =>
                      setLoginForm((prev) => ({
                        ...prev,
                        password: e.target.value,
                      }))
                    }
                    placeholder={authStatus?.ldapEnabled ? t('app.808424') : t('app.e39ffe')}
                    onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  />
                  <button
                    type="button"
                    className={`password-visibility-indicator${loginPasswordVisible ? ' is-visible' : ''}`}
                    onClick={() => setLoginPasswordVisible((prev) => !prev)}
                    aria-label={loginPasswordVisible ? t('app.dd909a') : t('app.5f26be')}
                    title={loginPasswordVisible ? t('app.dd909a') : t('app.5f26be')}
                  >
                    {loginPasswordVisible ? <IconEyeOff /> : <IconEye />}
                  </button>
                </div>
              </div>
            </>
          )}

          {loginError && <div className="login-error">{loginError}</div>}

          <button
            className="btn-primary login-btn"
            onClick={isRegisterMode ? handleRegister : handleLogin}
            disabled={loggingIn}
          >
            {loggingIn
              ? (isRegisterMode ? t('app.2f4891') : t('app.04c8f7'))
              : (isRegisterMode ? t('app.fe0e8b') : t('app.402d19'))}
          </button>

          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button
              className="btn-text"
              onClick={() => {
                setIsRegisterMode((prev) => !prev);
                setLoginError('');
              }}
              style={{ color: 'var(--text-muted)', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {isRegisterMode ? t('app.1fa363') : t('app.2deb63')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (authStatus === null) {
    return <div className="login-loading">{t('app.1b31bd')}</div>;
  }

  const renderConversationSidebar = (onSwitch: (jid: string) => void) => (
    <ConversationSidebar
      channelFilter={channelFilter}
      availableChannels={availableChannels}
      channelCounts={channelCounts}
      busyByJid={busyByJid}
      unreadRepliesByJid={unreadRepliesByJid}
      setChannelFilter={setChannelFilter}
      conversationSort={conversationSort}
      setConversationSort={setConversationSort}
      batchDeleteEnabled={batchDeleteEnabled}
      allVisibleSelected={allVisibleSelected}
      visibleConversationJids={visibleConversationJids}
      selectedConversationJids={selectedConversationJids}
      filteredConversations={sidebarConversations}
      activeJid={activeJid}
      createConversation={createConversation}
      toggleSelectAllVisible={toggleSelectAllVisible}
      deleteSelectedConversations={deleteSelectedConversations}
      toggleBatchDeleteEnabled={toggleBatchDeleteEnabled}
      toggleConversationSelection={toggleConversationSelection}
      switchConversation={onSwitch}
      updateConversationMeta={updateConversationMeta}
      renameConversation={renameConversation}
      deleteConversationByJid={deleteConversationByJid}
      getConversationTitle={getConversationTitle}
      stripLeadingMention={stripLeadingMention}
      getDisplayContent={getDisplayContent}
      formatTime={formatTime}
    />
  );

  const settingsPageSharedProps = {
    apiBase: API,
    hasSystemSettings:
      auth.hasAnyPermission('system.settings', 'system.settings.edit') ||
      !auth.multiUserMode,
    hasLive2dManage:
      auth.hasPermission('live2d.manage') || !auth.multiUserMode,
    pickNativeDirectory: pickConversationAccessDirectory,
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
    refreshDoctorReport: loadDoctorReport,
    refreshWorkspaceCleanupSummary: loadWorkspaceCleanupSummary,
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
    deleteCustomSkill: deleteCustomSkillById,
    openCommandGuideChat: () => navigate(navPageToPath('chat')),
    extensionActionStatus,
    extensionsLoading,
    savingMcpConfig,
    savingSkillsConfig,
    extensionsMessage,
    assistants,
  };

  const mainContent = (
    <main
      className={`main-content page-${page}${
        page === 'chat' || page === 'im' || page === 'companion'
          ? ''
          : ' canvas-page'
      }`}
    >
        {page === 'chat' && (
          <Suspense fallback={<div className="settings-hint">{t('app.1604ea')}</div>}>
          <ChatPage
            activeJid={activeJid}
            activeConv={activeConv}
            activeProviderAlias={activeProviderAlias}
            activeAssistantLabel={activeAssistantLabel}
            activeProviderId={activeProviderId}
            providers={providers}
            setConversationProvider={setConversationProvider}
            conversationSidebarCollapsed={conversationSidebarCollapsed}
            toggleConversationSidebar={toggleConversationSidebar}
            updateConversationMeta={updateConversationMeta}
            exportSelectedConversationItemsAsMarkdown={
              exportSelectedConversationItemsAsMarkdown
            }
            shareSelectedConversationItems={shareSelectedConversationItems}
            exportConversationItemsAsMarkdown={
              exportConversationItemsAsMarkdown
            }
            shareConversationItems={shareConversationItems}
            messageSelectionMode={messageSelectionMode}
            selectedConversationItemKeys={selectedConversationItemKeys}
            selectedConversationItemCount={selectedConversationItems.length}
            toggleMessageSelectionMode={toggleMessageSelectionMode}
            toggleConversationItemSelection={toggleConversationItemSelection}
            selectAllConversationItems={selectAllConversationItems}
            getConversationTitle={getConversationTitle}
            activeApprovals={activeApprovals}
            timelineEntries={timelineEntries}
            getDisplayContent={getDisplayContent}
            formatTime={formatTime}
            truncatePreview={truncatePreview}
            typing={typing}
            streaming={streaming}
            messagesContainerRef={messagesContainerRef}
            messagesEndRef={messagesEndRef}
            handleMessagesScroll={handleMessagesScroll}
            handleMessagesWheel={handleMessagesWheel}
            handleMessagesTouchStart={handleMessagesTouchStart}
            handleMessagesTouchMove={handleMessagesTouchMove}
            handleMessagesTouchEnd={handleMessagesTouchEnd}
            inputHintText={inputHintText}
            input={input}
            setInput={setInput}
            handleKeyDown={handleKeyDown}
            handleInputCompositionStart={handleInputCompositionStart}
            handleInputCompositionEnd={handleInputCompositionEnd}
            assistantName={assistantName}
            assistantBusy={assistantBusy}
            interruptingReply={assistantInterrupting}
            regeneratingReply={assistantRegenerating}
            conversationAccess={activeConversationAccess}
            conversationAccessLoading={conversationAccessLoading}
            conversationAccessSaving={conversationAccessSaving}
            saveConversationAccess={saveActiveConversationAccess}
            openAssistantsPage={openAssistantsPage}
            openSettingsPage={openSettingsPage}
            pickConversationAccessDirectory={pickConversationAccessDirectory}
            resolveApproval={resolveActiveConversationApproval}
            onMessageMemoryAction={handleMessageMemoryAction}
            messageMemoryActionStateByMessageId={
              messageMemoryActionStateByMessageId
            }
            interruptReply={interruptActiveConversationReply}
            regenerateReply={regenerateActiveConversationReply}
            sendMessage={sendMessage}
            sendError={sendError}
            createConversation={createConversation}
            pendingUploads={pendingUploadProps}
            uploadingFiles={uploadingFiles}
            selectUploadFiles={selectUploadFiles}
            removePendingUpload={removePendingUpload}
            hasLive2dPerm={auth.hasPermission('live2d.view') || !isMultiUser}
            onOpenLive2dConfig={handleOpenLive2dConfig}
            hasMoreOlder={activeHasMoreOlder}
            loadingOlder={activeLoadingOlder}
            onLoadOlder={loadOlderForActiveConversation}
          />
          </Suspense>
        )}

        {page === 'companion' && (
          <Suspense fallback={<div className="settings-hint">{t('app.1604ea')}</div>}>
            <CompanionPage
              apiBase={API}
              live2dConfig={live2dConfig}
              live2dEmotion={live2dEmotion}
            />
          </Suspense>
        )}

        {page === 'im' && auth.canAccessPage('im') && (
          <Suspense fallback={<div className="settings-hint">{t('app.109740')}</div>}>
            <ImPage />
          </Suspense>
        )}

        {page === 'tasks' && (
          <Suspense fallback={<div className="settings-hint">{t('app.9d7cd1')}</div>}>
            <TasksPageContainer
              apiBase={API}
              conversations={conversationsByRecent}
              activeJid={activeJid}
              authenticated={Boolean(authStatus?.authenticated)}
            />
          </Suspense>
        )}

        {stockAnalysisEnabled && page === 'stock-analysis' && (
          <Suspense
            fallback={
              <div className="empty-state">
                <h2>{t('app.12ef12')}</h2>
                <p>{t('app.4984ef')}</p>
              </div>
            }
          >
            <StockAnalysisPage apiBase={API} />
          </Suspense>
        )}

        {page === 'terminal' && (
          <Suspense fallback={<div className="settings-hint">{t('app.b156dc')}</div>}>
            <TerminalPage
              terminalEnabled={terminalEnabled}
              activeJid={activeJid}
              activeConversationTitle={
                activeConv ? getConversationTitle(activeConv) : null
              }
              terminalRef={terminalRef}
              openSettings={() => navigate(navPageToPath('settings'))}
              goBackToChat={() => navigate(navPageToPath('chat'))}
            />
          </Suspense>
        )}

        {page === 'channels' && (
          <Suspense fallback={<div className="settings-hint">{t('app.9ba6e0')}</div>}>
            <ChannelsWorkspacePage
              status={status}
              doctorReport={doctorReport}
              formatUptime={formatUptime}
              refreshDoctorReport={loadDoctorReport}
              openGlobalSettings={() => navigate(navPageToPath('settings'))}
              channelSettingsProps={{
                ...settingsPageSharedProps,
                visibleTabs: ['channels'],
              }}
            />
          </Suspense>
        )}

        {page === 'repos' && (
          <Suspense fallback={<div className="page-loading">{t('app.47418e')}</div>}>
            <RepositoryPage
              apiBase={API}
              pickNativeDirectory={pickConversationAccessDirectory}
              conversations={conversationsByRecent}
            />
          </Suspense>
        )}

        {page === 'reviews' && (
          <div className="page-view settings-view">
            <div className="page-header">
              <div className="page-header-copy">
                <h2>{t('app.a9126e')}</h2>
                <p>{t('app.0b282e')}</p>
              </div>
            </div>
            <div className="page-body">
              <Suspense fallback={<div className="settings-hint">{t('app.778aa5')}</div>}>
                <RepoReviewSettingsPanel
                  apiBase={API}
                  pickNativeDirectory={pickConversationAccessDirectory}
                  conversations={conversationsByRecent}
                />
              </Suspense>
            </div>
          </div>
        )}

        {page === 'assistants' && (
          <Suspense fallback={<div className="settings-hint">{t('app.b3d59a')}</div>}>
            <AssistantsPage
              apiBase={API}
              assistants={assistants}
              loading={assistantsLoading}
              error={assistantsError}
              focusAssistantId={assistantPageTargetId}
              onFocusHandled={clearAssistantPageTarget}
              providers={providers}
              managedMcpServers={managedMcpServers}
              managedSkills={managedSkills}
              conversations={conversationsByRecent}
              onRefresh={refreshAssistants}
              onStartChat={startAssistantConversation}
              onSubmit={handleAssistantSubmit}
              onDelete={handleAssistantDelete}
            />
          </Suspense>
        )}

        {page === 'settings' && (
          <Suspense fallback={<div className="settings-hint">{t('app.372156')}</div>}>
            <SettingsPage
              {...settingsPageSharedProps}
              focusSection={settingsPageTarget}
              onFocusHandled={clearSettingsPageTarget}
              hideSettingsTabs={false}
              pageTitle={t('app.224e2c')}
              visibleTabs={settingsVisibleTabs}
            />
          </Suspense>
        )}

        {page === 'apps' && (
          <Suspense fallback={<div className="settings-hint">{t('app.966af5')}</div>}>
            <AppsPageV2
              apiBase={API}
              isAdmin={auth.hasAnyPermission('admin.settings.write', 'marketplace.manage_sources') || !auth.multiUserMode}
            />
          </Suspense>
        )}

        {page === 'users' && auth.canAccessPage('users') && (
          <Suspense fallback={<div className="settings-hint">{t('app.d2fb48')}</div>}>
            <UsersPage apiBase={API} />
          </Suspense>
        )}

        {page === 'soul' && (
          <Suspense fallback={<div className="settings-hint">{t('app.cde111')}</div>}>
            <SoulPage apiBase={API} />
          </Suspense>
        )}

        {page === 'tavern' && (
          <Suspense fallback={<div className="settings-hint">{t('app.cde111')}</div>}>
            <TavernPage
              apiBase={API}
              providers={providers}
              conversations={conversationsByRecent}
              onStartChat={startTavernConversation}
              onOpenConversation={switchConversation}
            />
          </Suspense>
        )}

        {page === 'knowledge' && (
          <Suspense fallback={<div className="settings-hint">{t('app.a95bae')}</div>}>
            <KnowledgePage apiBase={API} />
          </Suspense>
        )}

        {page === 'workteam' && (
          <Suspense fallback={<div className="settings-hint">{t('app.db071a')}</div>}>
            <WorkteamPage
              apiBase={API}
              canManage={
                auth.hasAnyPermission('project.manage', 'workteam.manage') ||
                !auth.multiUserMode
              }
              canCreateWorkflow={
                auth.hasAnyPermission(
                  'project.manage',
                  'workteam.manage',
                  'workteam.create',
                ) || !auth.multiUserMode
              }
            />
          </Suspense>
        )}

        {createConversationOpen && (
          <div className="modal-overlay" onClick={closeCreateConversation}>
            <div
              className="modal create-conversation-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <h3>{t('app.f2b14f')}</h3>
              <div className="settings-hint">
                {t('app.6cf757')}
              </div>
              {createConversationAssistant ? (
                <div className="create-conversation-assistant-banner">
                  {t('app.currentAssistant')}<strong>{createConversationAssistant.name}</strong>
                </div>
              ) : null}

              <div className="form-group">
                <label>{t('app.8ba6a8')}</label>
                <AppSelect
                  value={createConversationOptionKey}
                  onChange={(nextValue) => {
                    setCreateConversationOptionKey(nextValue);
                    setCreateConversationError('');
                    setCreateConversationFieldValues({});
                  }}
                  ariaLabel={t('app.8ba6a8')}
                  options={createConversationOptions.map((option) => ({
                    value: option.key,
                    label: option.supported
                      ? option.label
                      : `${option.label}（${t('app.notSupported')}）`,
                  }))}
                />
              </div>

              {selectedCreateConversationOption ? (
                <>
                  <div className="create-conversation-meta">
                    <strong>{selectedCreateConversationOption.label}</strong>
                    <span>{selectedCreateConversationOption.description}</span>
                  </div>

                  <div className="form-group">
                    <label>{t('app.fdf6f7')}</label>
                    <input
                      value={createConversationName}
                      onChange={(event) =>
                        setCreateConversationName(event.target.value)
                      }
                      placeholder={t('app.95349a')}
                    />
                  </div>

                  {selectedCreateConversationOption.fields.map((field) => (
                    <div key={field.key} className="form-group">
                      <label>
                        {field.label}
                        {field.required ? ' *' : ''}
                      </label>
                      {field.summary ? (
                        <div className="settings-hint">{field.summary}</div>
                      ) : null}
                      {field.type === 'select' ? (
                        <AppSelect
                          value={createConversationFieldValues[field.key] || ''}
                          onChange={(nextValue) =>
                            setCreateConversationFieldValues((prev) => ({
                              ...prev,
                              [field.key]: nextValue,
                            }))
                          }
                          ariaLabel={field.label}
                          options={[
                            { value: '', label: t('select.placeholder') },
                            ...(field.options || []).map((option) => ({
                              value: option.value,
                              label: option.label,
                            })),
                          ]}
                        />
                      ) : (
                        <input
                          value={createConversationFieldValues[field.key] || ''}
                          onChange={(event) =>
                            setCreateConversationFieldValues((prev) => ({
                              ...prev,
                              [field.key]: event.target.value,
                            }))
                          }
                          placeholder={field.placeholder}
                        />
                      )}
                    </div>
                  ))}

                  {!selectedCreateConversationOption.supported &&
                  selectedCreateConversationOption.reason ? (
                    <div className="test-result error">
                      {selectedCreateConversationOption.reason}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="provider-empty">{t('app.1f974a')}</div>
              )}

              {createConversationError ? (
                <div className="test-result error">
                  {createConversationError}
                </div>
              ) : null}

              <div className="modal-actions">
                <button
                  className="btn-outline"
                  onClick={closeCreateConversation}
                >
                  {t('action.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={() => void submitCreateConversation()}
                  disabled={
                    !selectedCreateConversationOption?.supported ||
                    creatingConversation
                  }
                >
                  {creatingConversation ? t('app.a74bac') : t('app.26bb84')}
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmDialog.open && (
          <div
            className="modal-overlay"
            onClick={() => closeConfirmDialog(false)}
          >
            <div
              className="modal modal-confirm"
              onClick={(e) => e.stopPropagation()}
            >
              <h3>{confirmDialog.title}</h3>
              <p className="confirm-message">{confirmDialog.message}</p>
              <div className="modal-actions">
                <button
                  className="btn-outline"
                  onClick={() => closeConfirmDialog(false)}
                >
                  {t('action.cancel')}
                </button>
                <button
                  className="btn-danger"
                  onClick={() => closeConfirmDialog(true)}
                >
                  {confirmDialog.confirmLabel || t('btn.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {renameDialog.open && (
          <div className="modal-overlay" onClick={closeRenameDialog}>
            <div
              className="modal modal-rename"
              onClick={(event) => event.stopPropagation()}
            >
              <h3>{t('app.ea7a73')}</h3>
              <div className="form-group">
                <label>{t('app.87e2fc')}</label>
                <input
                  value={renameDialog.value}
                  onChange={(event) =>
                    setRenameDialog((prev) => ({
                      ...prev,
                      value: event.target.value,
                    }))
                  }
                  placeholder={t('app.b76fe6')}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitRenameDialog();
                    }
                  }}
                />
              </div>
              <div className="modal-actions">
                <button className="btn-outline" onClick={closeRenameDialog}>
                  {t('action.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={() => void submitRenameDialog()}
                  disabled={renameDialog.saving}
                >
                  {renameDialog.saving ? t('action.saving') : t('app.160f16')}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
  );

  return (
    <div className={`app app-shell${isMobile ? ' mobile' : ''}`}>
      {!isMobile && (
        <NavSidebar
          stockAnalysisEnabled={stockAnalysisEnabled}
          terminalEnabled={terminalEnabled}
          online={Boolean(status)}
          loginEnabled={loginEnabled}
          loginDisplayName={loginDisplayName}
          theme={theme}
          toggleTheme={toggleTheme}
          onLogout={handleLogout}
          canAccessPage={auth.canAccessPage}
        />
      )}

      {!isMobile &&
        page === 'chat' &&
        !conversationSidebarCollapsed &&
        renderConversationSidebar(switchConversation)}

      {isMobile ? (
        <MobileLayout
          page={page}
          setPage={setPage}
          conversationDrawerOpen={mobileConvDrawerOpen}
          onToggleConversationDrawer={toggleMobileConvDrawer}
          canAccessPage={auth.canAccessPage}
          online={Boolean(status)}
          loginEnabled={loginEnabled}
          loginDisplayName={loginDisplayName}
          theme={theme}
          toggleTheme={toggleTheme}
          onLogout={handleLogout}
          stockAnalysisEnabled={stockAnalysisEnabled}
          terminalEnabled={terminalEnabled}
          chatTitle={
            page === 'chat' && activeConv ? getConversationTitle(activeConv) : undefined
          }
          conversationSidebar={
            page === 'chat'
              ? renderConversationSidebar(switchConversationMobile)
              : null
          }
        >
          {mainContent}
        </MobileLayout>
      ) : (
        mainContent
      )}

      {page === 'chat' &&
        live2dConfig?.globalEnabled &&
        live2dConfig?.preferences?.enabled &&
        live2dConfig?.preferences?.selectedModelId && (
          <Suspense fallback={null}>
            <Live2DPanel
              modelId={live2dConfig.preferences.selectedModelId}
              preferences={live2dConfig.preferences}
              currentEmotion={live2dEmotion}
              onClose={handleLive2dClose}
              onOpenSettings={handleLive2dOpenSettings}
              onScaleChange={handleLive2dScaleChange}
            />
          </Suspense>
        )}
      {page === 'chat' && (
        <Drawer open={live2dChatConfigOpen} onClose={() => setLive2dChatConfigOpen(false)} title={t('app.da8671')} width={400}>
          <Suspense fallback={<div className="settings-hint">{t('app.1604ea')}</div>}>
            <Live2DChatConfig
              globalEnabled={live2dConfig?.globalEnabled ?? false}
              preferences={live2dConfig?.preferences ?? null}
              onPreferencesChange={(patch) => {
                setLive2dConfig((prev) => {
                  if (!prev?.preferences) return prev;
                  return { ...prev, preferences: { ...prev.preferences, ...patch } };
                });
              }}
              onPreferencesSave={(patch) => {
                setLive2dConfig((prev) => {
                  if (!prev?.preferences) return prev;
                  const next = { ...prev.preferences, ...patch };
                  void fetch('/api/live2d/preferences', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(next),
                  });
                  return { ...prev, preferences: next };
                });
              }}
              onOpenFullSettings={() => {
                setLive2dChatConfigOpen(false);
                navigate(navPageToPath('settings', 'live2d'));
              }}
            />
          </Suspense>
        </Drawer>
      )}
      {shareDialogUrl && (
        <ShareDialog
          url={shareDialogUrl}
          onClose={() => setShareDialogUrl(null)}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <UIProvider>
      <AppShell />
    </UIProvider>
  );
}

export default App;
