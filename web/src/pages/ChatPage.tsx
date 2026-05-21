import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type TouchEvent,
  type WheelEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type {
  AccessMode,
  AccessPolicy,
  ApprovalScope,
  AiProvider,
  ApprovalRequest,
  ChatTimelineEntry,
  ConversationAccessNextAction,
  Conversation,
  ConversationAccess,
  UploadedChatFile,
} from '../app-types';
import {
  getConversationBaseTitle,
  getConversationChannelLabel,
  getConversationMentionCandidates,
} from '../app-helpers';
import {
  extractGeneratedImageWorkspacePaths,
  getLatestRegeneratableAssistantTurnId,
  shouldShowInlineAssistantLoading,
} from './chat-page-helpers';
import { renderMarkdownContent } from '../markdown';
import { AppSelect } from '../components/AppSelect';
import { ApprovalOverlay } from '../components/ApprovalOverlay';
import { Drawer } from '../components/common/Drawer';
import { SubagentActivity } from '../components/SubagentActivity';
import { ToolResultCard } from '../components/ToolResultCard';
import {
  IconChat,
  IconCheck,
  IconCheckSquare,
  IconCopy,
  IconDownload,
  IconFolder,
  IconPin,
  IconSend,
  IconShare,
  IconRefresh,
  IconSidebarToggle,
  IconStop,
  IconChevronDown,
} from '../components/AppIcons';
import { ShareHistoryPanel } from '../components/ShareHistoryPanel';
import { useTranslation } from 'react-i18next';

interface CommandSuggestionItem {
  command: string;
  template: string;
  description: string;
}

const CHAT_COMMAND_SUGGESTIONS: CommandSuggestionItem[] = [
  { command: '/help', template: '/help', description: 'slash.help' },
  { command: '/skills', template: '/skills', description: 'slash.skills' },
  {
    command: '/skills install',
    template: '/skills install "tmp/skill-creator" --overwrite',
    description: 'slash.skillsInstall',
  },
  {
    command: '/skill-create',
    template: '/skill-create --id my_skill create a composite skill for XXX',
    description: 'slash.skillCreate',
  },
  { command: '/mcp', template: '/mcp', description: 'slash.mcp' },
  {
    command: '/mcp-install',
    template: '/mcp-install "tmp/mysql" --id mysql --entry dist/index.js',
    description: 'slash.mcpInstall',
  },
  { command: '/tasks', template: '/tasks', description: 'slash.tasks' },
  {
    command: '/task-create',
    template:
      '/task-create summarize yesterday progress every morning at 9am and remind me',
    description: 'slash.taskCreate',
  },
  {
    command: '/task-draft',
    template: '/task-draft summarize yesterday tasks every morning at 9am',
    description: 'slash.taskDraft',
  },
  { command: '/reset', template: '/reset', description: 'slash.reset' },
];

function GeneratedToolImages({
  activeJid,
  resultText,
}: {
  activeJid: string | null;
  resultText?: string;
}) {
  const imagePaths = useMemo(
    () => extractGeneratedImageWorkspacePaths(resultText),
    [resultText],
  );
  const buildGeneratedImageUrl = useCallback(
    (workspacePath: string) =>
      `/api/conversations/${encodeURIComponent(activeJid || '')}/generated-file?path=${encodeURIComponent(workspacePath)}`,
    [activeJid],
  );

  if (!activeJid || imagePaths.length === 0) return null;

  return (
    <div className="tool-generated-image-grid">
      {imagePaths.map((workspacePath) => {
        const previewUrl = buildGeneratedImageUrl(workspacePath);
        return (
          <a
            key={workspacePath}
            className="tool-generated-image-link"
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
          >
            <img
              className="tool-generated-image-preview"
              src={previewUrl}
              alt={workspacePath.split('/').pop() || 'generated image'}
              loading="lazy"
            />
          </a>
        );
      })}
    </div>
  );
}

function formatUploadedFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function stripUploadedFileLabel(content: string): string {
  return content
    .replace(/(?:\n\s*\n)?\[(?:上传文件|Uploaded files?)\][^\n\r]*/gi, '')
    .trim();
}

function ConversationUploadedFiles({
  chatJid,
  files,
}: {
  chatJid: string;
  files: UploadedChatFile[];
}) {
  if (!chatJid || files.length === 0) return null;

  return (
    <div className="im-msg-attachments">
      {files.map((file) => {
        const fileUrl = `/api/conversations/${encodeURIComponent(chatJid)}/uploaded-file?path=${encodeURIComponent(file.relativePath)}`;
        if (file.mimeType.startsWith('image/')) {
          return (
            <a
              key={file.relativePath}
              href={fileUrl}
              target="_blank"
              rel="noreferrer"
            >
              <img
                className="im-msg-image"
                src={fileUrl}
                alt={file.name}
                loading="lazy"
              />
            </a>
          );
        }

        return (
          <a
            key={file.relativePath}
            className="im-msg-file"
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            download={file.name}
          >
            <div className="im-msg-file-info">
              <div className="im-msg-file-name">{file.name}</div>
              <div className="im-msg-file-size">
                {formatUploadedFileSize(file.size)}
                {file.mimeType ? ` · ${file.mimeType}` : ''}
              </div>
            </div>
            <span className="im-msg-file-download">
              <IconDownload />
            </span>
          </a>
        );
      })}
    </div>
  );
}

const ACCESS_MODE_OPTIONS: Array<{
  value: AccessMode;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: 'allowall',
    labelKey: 'access.mode.allowall',
    descriptionKey: 'access.mode.allowallDesc',
  },
  {
    value: 'allowlist',
    labelKey: 'access.mode.allowlist',
    descriptionKey: 'access.mode.allowlistDesc',
  },
  {
    value: 'readonly',
    labelKey: 'access.mode.readonly',
    descriptionKey: 'access.mode.readonlyDesc',
  },
];

function getAccessModeOption(mode: AccessMode) {
  const entry =
    ACCESS_MODE_OPTIONS.find((e) => e.value === mode) || ACCESS_MODE_OPTIONS[0];
  return entry;
}

function getAccessSourceLabel(source?: AccessPolicy['source']): string {
  if (source === 'assistant') return 'access.source.assistant';
  if (source === 'conversation') return 'access.source.conversation';
  return 'access.source.global';
}

function getApprovalScopeLabel(scope: ApprovalScope): string {
  return scope === 'current_tool_call'
    ? 'access.scope.currentToolCall'
    : 'access.scope.currentRuntime';
}

// formatAccessLayerDescription moved inside ChatPage to access t()

function hasAccessDirectory(directories: string[], value?: string): boolean {
  const normalized = value?.trim();
  if (!normalized) return false;
  return directories.includes(normalized);
}

function formatReasoningText(title: string, text?: string) {
  const trimmed = text?.trim();
  if (!trimmed) return title;
  return trimmed === title ? trimmed : `${title}：${trimmed}`;
}

function getToolCallDurationMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
  timestamp: string,
  status: 'in_progress' | 'completed' | 'failed',
  now: number,
): number | null {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(startedMs)) return null;
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const endMs = Number.isFinite(completedMs)
    ? completedMs
    : status === 'in_progress'
      ? now
      : Date.parse(timestamp);
  if (!Number.isFinite(endMs) || endMs < startedMs) return null;
  return Math.max(0, endMs - startedMs);
}

// formatToolCallDuration moved inside ToolCallDurationLabel to access t()

const ToolCallDurationLabel = memo(function ToolCallDurationLabel({
  startedAt,
  completedAt,
  timestamp,
  status,
}: {
  startedAt?: string;
  completedAt?: string;
  timestamp: string;
  status: 'in_progress' | 'completed' | 'failed';
}) {
  const { t } = useTranslation('chat');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'in_progress' || !startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [status, startedAt]);

  const durationMs = getToolCallDurationMs(
    startedAt,
    completedAt,
    timestamp,
    status,
    now,
  );
  const label =
    durationMs === null
      ? null
      : `${(durationMs / 1000).toFixed(1)}${t('assistant.durationSuffix')}`;
  if (!label) return null;
  return <span className="turn-item-duration">{label}</span>;
});

function isOptimisticThinkingId(itemId: string) {
  return itemId.includes(':optimistic-thinking');
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

// getStatusLabel moved inside ChatPage to access t()

function ThinkingLoader() {
  return (
    <span className="thinking-loader" aria-label="处理中">
      <span />
      <span />
      <span />
    </span>
  );
}

interface InlineAssistantLoadingProps {
  onInterrupt?: () => void | Promise<void>;
  interruptTitle?: string;
  interrupting?: boolean;
}

function InlineAssistantLoading({}: InlineAssistantLoadingProps) {
  return (
    <div className="assistant-inline-loading" aria-label="处理中">
      <span className="assistant-inline-loading-label">处理中</span>
      <ThinkingLoader />
    </div>
  );
}

const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className: string;
}) {
  const renderedContent = useMemo(
    () => renderMarkdownContent(content),
    [content],
  );
  return <div className={className}>{renderedContent}</div>;
});

const SelectionKeysCtx = createContext<Set<string>>(new Set());

const MessageCheckbox = memo(function MessageCheckbox({
  entryKey,
  onToggle,
}: {
  entryKey: string;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation('chat');
  const selectedKeys = useContext(SelectionKeysCtx);
  const selected = selectedKeys.has(entryKey);
  return (
    <label
      className="message-select-toggle"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(entryKey)}
        aria-label={t('chat.选择消息')}
      />
    </label>
  );
});

const VIRTUAL_START = 100_000;

interface ChatPageProps {
  activeJid: string | null;
  activeConv: Conversation | null;
  activeProviderAlias: string;
  activeAssistantLabel: string | null;
  activeProviderId: string | null;
  providers: AiProvider[];
  setConversationProvider: (
    jid: string,
    providerId: string | null,
    model?: string | null,
  ) => void | Promise<void>;
  conversationSidebarCollapsed: boolean;
  toggleConversationSidebar: () => void;
  updateConversationMeta: (
    jid: string,
    updates: {
      customTitle?: string | null;
      isPinned?: boolean;
      isFavorite?: boolean;
    },
  ) => void;
  exportSelectedConversationItemsAsMarkdown: () => void | Promise<void>;
  shareSelectedConversationItems: () => void | Promise<void>;
  exportConversationItemsAsMarkdown: (
    entryKeys: string[],
    options?: { clearSelection?: boolean },
  ) => void | Promise<void>;
  shareConversationItems: (
    entryKeys: string[],
    options?: { clearSelection?: boolean },
  ) => void | Promise<void>;
  messageSelectionMode: boolean;
  selectedConversationItemKeys: Set<string>;
  selectedConversationItemCount: number;
  toggleMessageSelectionMode: () => void;
  toggleConversationItemSelection: (key: string) => void;
  selectAllConversationItems: () => void;
  getConversationTitle: (
    conversation: Conversation | null | undefined,
  ) => string;
  activeApprovals: ApprovalRequest[];
  timelineEntries: ChatTimelineEntry[];
  getDisplayContent: (
    content: string,
    isBot: boolean,
    channel?: string,
    name?: string | string[],
  ) => string;
  formatTime: (ts: string) => string;
  truncatePreview: (text: string, limit?: number) => string;
  typing: boolean;
  streaming: boolean;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  handleMessagesScroll: () => void;
  handleMessagesWheel: (event: WheelEvent<HTMLDivElement>) => void;
  handleMessagesTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  handleMessagesTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
  handleMessagesTouchEnd: () => void;
  inputHintText: string;
  input: string;
  setInput: (value: string) => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  handleInputCompositionStart: (
    event: CompositionEvent<HTMLTextAreaElement>,
  ) => void;
  handleInputCompositionEnd: (
    event: CompositionEvent<HTMLTextAreaElement>,
  ) => void;
  assistantName: string;
  assistantBusy: boolean;
  interruptingReply: boolean;
  regeneratingReply?: boolean;
  conversationAccess: ConversationAccess | null;
  conversationAccessLoading: boolean;
  conversationAccessSaving: boolean;
  saveConversationAccess: (
    policy: AccessPolicy,
  ) => Promise<true | { error: string }>;
  openAssistantsPage: (assistantId?: string | null) => void;
  openSettingsPage: (section?: 'default-access-policy') => void;
  pickConversationAccessDirectory: () => Promise<string | null>;
  resolveApproval: (
    approvalId: string,
    decision: 'allow-once' | 'deny',
    scope?: ApprovalScope,
  ) => Promise<boolean | void>;
  onMessageMemoryAction: (input: {
    action: 'remember' | 'session_only';
    messageId: string;
    sender: string;
    senderName: string;
    text: string;
  }) => void | Promise<void>;
  messageMemoryActionStateByMessageId: Record<
    string,
    {
      pendingAction?: 'remember' | 'session_only';
      tone?: 'success' | 'error';
      message?: string;
    }
  >;
  interruptReply: () => void | Promise<void>;
  regenerateReply: (turnId: string) => void | Promise<void>;
  sendMessage: () => void;
  sendError?: string | null;
  createConversation: (assistantId?: string | null) => void;
  pendingUploads: Array<{
    id: string;
    name: string;
    size: number;
    mimeType: string;
  }>;
  uploadingFiles: boolean;
  selectUploadFiles: (files: FileList | null) => void;
  removePendingUpload: (id: string) => void;
  hasLive2dPerm?: boolean;
  onOpenLive2dConfig?: () => void;
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

interface ApprovalFollowupHint {
  id: string;
  toolName: string;
  command: string;
  cwd?: string;
  resolvedAt: string;
}

// formatAccessPolicySummary and describeDeniedApprovalFollowup moved inside ChatPage to access t()

export function ChatPage({
  activeJid,
  activeConv,
  activeProviderAlias,
  activeAssistantLabel,
  activeProviderId,
  providers,
  setConversationProvider,
  conversationSidebarCollapsed,
  toggleConversationSidebar,
  updateConversationMeta,
  exportSelectedConversationItemsAsMarkdown,
  shareSelectedConversationItems,
  exportConversationItemsAsMarkdown,
  shareConversationItems,
  messageSelectionMode,
  selectedConversationItemKeys,
  selectedConversationItemCount,
  toggleMessageSelectionMode,
  toggleConversationItemSelection,
  selectAllConversationItems,
  getConversationTitle,
  activeApprovals,
  timelineEntries,
  getDisplayContent,
  formatTime,
  truncatePreview,
  typing,
  streaming,
  messagesContainerRef,
  messagesEndRef,
  handleMessagesScroll,
  handleMessagesWheel,
  handleMessagesTouchStart,
  handleMessagesTouchMove,
  handleMessagesTouchEnd,
  inputHintText,
  input,
  setInput,
  handleKeyDown,
  handleInputCompositionStart,
  handleInputCompositionEnd,
  assistantName,
  assistantBusy,
  interruptingReply,
  regeneratingReply = false,
  conversationAccess,
  conversationAccessLoading,
  conversationAccessSaving,
  saveConversationAccess,
  openAssistantsPage,
  openSettingsPage,
  pickConversationAccessDirectory,
  resolveApproval,
  onMessageMemoryAction,
  messageMemoryActionStateByMessageId,
  interruptReply,
  regenerateReply,
  sendMessage,
  sendError,
  createConversation,
  pendingUploads,
  uploadingFiles,
  selectUploadFiles,
  removePendingUpload,
  hasLive2dPerm,
  onOpenLive2dConfig,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
}: ChatPageProps) {
  const { t } = useTranslation('chat');

  const getStatusLabel = useCallback(
    (status: 'in_progress' | 'completed' | 'failed') =>
      status === 'completed'
        ? t('assistant.status.completed')
        : status === 'failed'
          ? t('assistant.status.failed')
          : t('assistant.status.inProgress'),
    [t],
  );

  const formatAccessLayerDescription = useCallback(
    (policy?: AccessPolicy | null): string => {
      if (!policy) return t('access.layer.unconfigured');
      const mode = t(getAccessModeOption(policy.mode).labelKey);
      const count = policy.directories.length;
      return count > 0
        ? t('access.layer.dirCount', { mode, count })
        : t('access.layer.noExtraDirs', { mode });
    },
    [t],
  );

  const formatAccessPolicySummary = useCallback(
    (policy?: AccessPolicy | null): string => {
      if (!policy) return t('access.dir.policySummaryDefault');
      return `${t(getAccessSourceLabel(policy.source))} · ${t(getAccessModeOption(policy.mode).labelKey)}`;
    },
    [t],
  );

  const describeDeniedApprovalFollowup = useCallback(
    (input: {
      approval: ApprovalFollowupHint;
      policy?: AccessPolicy | null;
      accessManagedByAssistant: boolean;
      activeAssistantLabel?: string | null;
    }): string => {
      const {
        approval,
        policy,
        accessManagedByAssistant,
        activeAssistantLabel,
      } = input;
      if (accessManagedByAssistant) {
        return t('access.denied.assistantManaged', {
          assistant:
            activeAssistantLabel || t('access.inheritance.assistantDefault'),
        });
      }
      if (policy?.mode === 'readonly') {
        return t('access.denied.readonly');
      }
      if (policy?.mode === 'allowlist') {
        return approval.cwd
          ? t('access.denied.allowlistCwd', { cwd: approval.cwd })
          : t('access.denied.allowlist');
      }
      return t('access.denied.default');
    },
    [t],
  );

  const conversationTitle = getConversationTitle(activeConv) || activeJid || '';
  const conversationBaseTitle = getConversationBaseTitle(activeConv);
  const conversationChannelLabel = getConversationChannelLabel(activeConv);
  const mentionCandidates = useMemo(
    () => getConversationMentionCandidates(activeConv),
    [activeConv],
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [messagesScrollParent, setMessagesScrollParent] =
    useState<HTMLDivElement | null>(null);
  const bindMessagesContainerEl = useCallback(
    (el: HTMLDivElement | null) => {
      messagesContainerRef.current = el;
      setMessagesScrollParent((prev) => (prev === el ? prev : el));
    },
    [messagesContainerRef],
  );

  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);
  const prevFirstKeyRef = useRef<string | null>(null);
  const wasLoadingOlderRef = useRef(false);
  const atBottomRef = useRef(true);
  const [copiedAssistantEntryKey, setCopiedAssistantEntryKey] = useState<
    string | null
  >(null);
  const copiedAssistantEntryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setFirstItemIndex(VIRTUAL_START);
    prevFirstKeyRef.current = null;
  }, [activeJid]);

  useEffect(() => {
    return () => {
      if (copiedAssistantEntryTimerRef.current !== null) {
        window.clearTimeout(copiedAssistantEntryTimerRef.current);
      }
    };
  }, []);

  const visibleTimelineItems = useMemo(
    () =>
      timelineEntries.reduce<{ entry: ChatTimelineEntry; fullIndex: number }[]>(
        (acc, entry, fullIndex) => {
          if (
            entry.kind === 'reasoning' &&
            isOptimisticThinkingId(entry.item.id)
          ) {
            return acc;
          }
          acc.push({ entry, fullIndex });
          return acc;
        },
        [],
      ),
    [timelineEntries],
  );

  useEffect(() => {
    if (loadingOlder) {
      wasLoadingOlderRef.current = true;
      return;
    }
    if (!wasLoadingOlderRef.current) return;
    wasLoadingOlderRef.current = false;

    if (visibleTimelineItems.length === 0) return;
    const currentFirstKey = visibleTimelineItems[0].entry.key;
    const prevKey = prevFirstKeyRef.current;
    if (prevKey && currentFirstKey !== prevKey) {
      const oldIdx = visibleTimelineItems.findIndex(
        (item) => item.entry.key === prevKey,
      );
      if (oldIdx > 0) {
        setFirstItemIndex((prev) => prev - oldIdx);
      }
    }
    prevFirstKeyRef.current = currentFirstKey;
  }, [loadingOlder, visibleTimelineItems]);

  useEffect(() => {
    if (visibleTimelineItems.length > 0 && prevFirstKeyRef.current === null) {
      prevFirstKeyRef.current = visibleTimelineItems[0].entry.key;
    }
  }, [visibleTimelineItems]);

  const handleStartReached = useCallback(() => {
    if (!hasMoreOlder || loadingOlder || !onLoadOlder) return;
    prevFirstKeyRef.current =
      visibleTimelineItems.length > 0
        ? visibleTimelineItems[0].entry.key
        : null;
    onLoadOlder();
  }, [hasMoreOlder, loadingOlder, onLoadOlder, visibleTimelineItems]);

  const exportTooltip = messageSelectionMode
    ? selectedConversationItemCount === 0
      ? t('selection.export.empty')
      : t('selection.export.selected', { count: selectedConversationItemCount })
    : t('selection.export.hint');
  const sendButtonTitle = assistantBusy
    ? t('send.waiting', { name: assistantName })
    : uploadingFiles
      ? t('send.uploading')
      : input.trim() || pendingUploads.length > 0
        ? t('send.hasContent')
        : t('send.empty');
  const interruptButtonTitle = interruptingReply
    ? t('realtime.stopped')
    : t('input.stopCurrentReply');
  const regenerateButtonTitle = regeneratingReply
    ? t('regenerate.stopping')
    : t('regenerate.stop', { name: assistantName });
  const latestRegeneratableTurnId = useMemo(
    () => getLatestRegeneratableAssistantTurnId(timelineEntries),
    [timelineEntries],
  );
  const latestRetryableAssistantEntryKey = useMemo(() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (
        entry.kind === 'assistant_message' &&
        entry.status === 'completed' &&
        entry.turnId &&
        entry.turnId === latestRegeneratableTurnId &&
        entry.text.trim()
      ) {
        return entry.key;
      }
    }
    return null;
  }, [latestRegeneratableTurnId, timelineEntries]);
  const handleCopyAssistantMessage = useCallback(
    async (entryKey: string, markdown: string) => {
      const rawMarkdown = markdown.trim();
      if (!rawMarkdown) return;
      try {
        await copyTextToClipboard(markdown);
        setCopiedAssistantEntryKey(entryKey);
        if (copiedAssistantEntryTimerRef.current !== null) {
          window.clearTimeout(copiedAssistantEntryTimerRef.current);
        }
        copiedAssistantEntryTimerRef.current = window.setTimeout(() => {
          setCopiedAssistantEntryKey(null);
          copiedAssistantEntryTimerRef.current = null;
        }, 1500);
      } catch {
        /* ignore clipboard failures */
      }
    },
    [],
  );
  const currentAccessPolicy = conversationAccess?.policy;
  const accessPolicyLayers = conversationAccess?.policyLayers;
  const runtimeApprovalPatches =
    conversationAccess?.runtimeApprovalPatches || [];
  const runtimeAccess = conversationAccess?.runtimeAccess;
  const effectiveAccess = conversationAccess?.effectiveAccess;
  const nextAccessActions = conversationAccess?.nextActions || [];
  const accessManagedByAssistant =
    currentAccessPolicy?.locked === true || !!activeConv?.assistantId;
  const effectiveAccessSummary =
    effectiveAccess?.summary || t('access.dir.effectiveDefault');
  const accessInheritanceSummary = currentAccessPolicy
    ? t('access.dir.defaultEffect', {
        source: t(getAccessSourceLabel(currentAccessPolicy.source)),
        mode: t(getAccessModeOption(currentAccessPolicy.mode).labelKey),
      })
    : t('access.dir.inheritanceHint');
  const accessButtonTitle = accessManagedByAssistant
    ? t('access.titleManaged')
    : t('access.title');
  const showConversationBaseTitle =
    !!activeConv?.custom_title?.trim() &&
    conversationBaseTitle &&
    conversationBaseTitle !== conversationTitle;
  const trimmedInput = input.trimStart();
  const [commandSuggestionDismissed, setCommandSuggestionDismissed] =
    useState(false);
  const showCommandSuggestionPanel =
    !assistantBusy &&
    trimmedInput.startsWith('/') &&
    !commandSuggestionDismissed;
  const commandPrefix = trimmedInput.split(/\s+/, 1)[0]?.toLowerCase() || '';
  const filteredCommandSuggestions = useMemo(() => {
    if (!showCommandSuggestionPanel) return [];
    if (!commandPrefix || commandPrefix === '/') {
      return CHAT_COMMAND_SUGGESTIONS.slice(0, 8);
    }
    const list = CHAT_COMMAND_SUGGESTIONS.filter((item) =>
      item.command.toLowerCase().startsWith(commandPrefix),
    );
    return list.length > 0
      ? list.slice(0, 8)
      : CHAT_COMMAND_SUGGESTIONS.slice(0, 6);
  }, [commandPrefix, showCommandSuggestionPanel]);

  const [shareHistoryOpen, setShareHistoryOpen] = useState(false);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const conversationMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setConversationMenuOpen(false);
  }, [activeJid, messageSelectionMode]);

  useEffect(() => {
    if (!conversationMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        conversationMenuRef.current &&
        !conversationMenuRef.current.contains(event.target as Node)
      ) {
        setConversationMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [conversationMenuOpen]);

  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [accessModeDraft, setAccessModeDraft] =
    useState<AccessMode>('allowall');
  const [accessDraft, setAccessDraft] = useState<string[]>([]);
  const [newAccessDir, setNewAccessDir] = useState('');
  const [pickingAccessDir, setPickingAccessDir] = useState(false);
  const [accessPickerError, setAccessPickerError] = useState('');
  const [accessSaveError, setAccessSaveError] = useState('');
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(
    null,
  );
  const [approvalFollowupHint, setApprovalFollowupHint] =
    useState<ApprovalFollowupHint | null>(null);
  const [accessInheritanceExpanded, setAccessInheritanceExpanded] =
    useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const accessDialogWasOpenRef = useRef(false);
  const providerOptions = useMemo(() => {
    const llmProviders = providers.filter(
      (p) => (p.capability || 'llm') === 'llm',
    );
    const systemProviders = llmProviders.filter((p) => p.source === 'system');
    const ownProviders = llmProviders.filter((p) => p.source === 'own');
    const sharedProviders = llmProviders.filter((p) => p.source === 'shared');
    const hasOverride = !!activeConv?.conversationProviderId;

    const options: Array<{
      value: string;
      label: string;
      disabled?: boolean;
    }> = [];

    if (hasOverride) {
      options.push({
        value: '__default__',
        label: t('provider.followDefault'),
      });
    }

    if (ownProviders.length > 0) {
      options.push({
        value: '__own_header__',
        label: t('provider.headerOwn'),
        disabled: true,
      });
      for (const p of ownProviders) {
        options.push({
          value: p.id,
          label: `${p.alias}${p.is_user_default ? t('chat.ee1f37') : ''}`,
        });
      }
    }

    if (sharedProviders.length > 0) {
      if (options.length > 0) {
        options.push({
          value: '__shared_header__',
          label: t('provider.headerShared'),
          disabled: true,
        });
      }
      for (const p of sharedProviders) {
        options.push({
          value: p.id,
          label: `${p.alias}${p.is_user_default ? t('chat.ee1f37') : ''}`,
        });
      }
    }

    if (systemProviders.length > 0) {
      if (options.length > 0) {
        options.push({
          value: '__sys_header__',
          label: t('provider.headerSystem'),
          disabled: true,
        });
      }
      for (const p of systemProviders) {
        options.push({
          value: p.id,
          label: `${p.alias}${p.is_user_default || p.is_global_default ? t('chat.ee1f37') : ''}`,
        });
      }
    }

    return options;
  }, [providers, activeConv]);
  const selectedProviderId =
    activeConv?.conversationProviderId || activeProviderId || null;
  const selectedProvider = useMemo(
    () =>
      selectedProviderId
        ? providers.find((provider) => provider.id === selectedProviderId)
        : undefined,
    [providers, selectedProviderId],
  );
  const [modelOverrideDraft, setModelOverrideDraft] = useState(
    activeConv?.conversationModel || '',
  );
  useEffect(() => {
    setModelOverrideDraft(activeConv?.conversationModel || '');
  }, [activeConv?.jid, activeConv?.conversationModel]);
  const saveModelOverride = useCallback(() => {
    if (!activeConv) return;
    const nextModel = modelOverrideDraft.trim() || null;
    if ((activeConv.conversationModel || null) === nextModel) return;
    void setConversationProvider(
      activeConv.jid,
      activeConv.conversationProviderId || null,
      nextModel,
    );
  }, [activeConv, modelOverrideDraft, setConversationProvider]);

  const location = useLocation();
  const scrolledHashRef = useRef<string>('');
  useEffect(() => {
    const hash = location.hash;
    if (!hash || !hash.startsWith('#msg-')) return;
    if (hash === scrolledHashRef.current) return;
    const messageKey = hash.slice('#msg-'.length);
    const idx = visibleTimelineItems.findIndex(
      (item) => item.entry.key === messageKey,
    );
    if (idx === -1) return;
    scrolledHashRef.current = hash;
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: idx,
        align: 'center',
        behavior: 'smooth',
      });
    });
  }, [location.hash, visibleTimelineItems]);

  const allConversationItemsSelected = useMemo(
    () =>
      timelineEntries.length > 0 &&
      timelineEntries.every((entry) =>
        selectedConversationItemKeys.has(entry.key),
      ),
    [selectedConversationItemKeys, timelineEntries],
  );

  useEffect(() => {
    if (trimmedInput.startsWith('/')) return;
    setCommandSuggestionDismissed(false);
  }, [trimmedInput]);

  useEffect(() => {
    setApprovalFollowupHint(null);
  }, [activeJid]);

  useEffect(() => {
    if (!accessDialogOpen) {
      accessDialogWasOpenRef.current = false;
      return;
    }
    if (accessDialogWasOpenRef.current) return;
    accessDialogWasOpenRef.current = true;
    setAccessModeDraft(currentAccessPolicy?.mode || 'allowall');
    setAccessDraft(currentAccessPolicy?.directories || []);
    setAccessPickerError('');
    setAccessSaveError('');
    setAccessInheritanceExpanded(false);
  }, [accessDialogOpen, currentAccessPolicy]);

  const addAccessDir = () => {
    if (accessManagedByAssistant) return;
    const dir = newAccessDir.trim();
    if (!dir || accessDraft.includes(dir)) return;
    setAccessDraft((prev) => [...prev, dir]);
    setNewAccessDir('');
  };

  const applySuggestedAccessDir = useCallback(
    (directory?: string) => {
      if (accessManagedByAssistant) return;
      const next = directory?.trim();
      if (!next) return;
      setAccessDraft((prev) => (prev.includes(next) ? prev : [...prev, next]));
      setNewAccessDir(next);
      setAccessModeDraft((prev) => (prev === 'allowall' ? 'allowlist' : prev));
    },
    [accessManagedByAssistant],
  );

  const saveSuggestedAccessDir = useCallback(
    async (directory?: string) => {
      if (accessManagedByAssistant) return;
      const next = directory?.trim();
      if (!next) return;
      const nextDirectories = accessDraft.includes(next)
        ? accessDraft
        : [...accessDraft, next];
      const result = await saveConversationAccess({
        mode: 'allowlist',
        directories: nextDirectories,
      });
      if (result !== true) {
        setAccessSaveError(
          typeof result === 'object' && result.error
            ? result.error
            : t('access.saveError'),
        );
        return;
      }
      setAccessModeDraft('allowlist');
      setAccessDraft(nextDirectories);
      setNewAccessDir(next);
    },
    [accessDraft, accessManagedByAssistant, saveConversationAccess],
  );

  const removeAccessDir = (index: number) => {
    if (accessManagedByAssistant) return;
    setAccessDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAccessNextAction = useCallback(
    (action: ConversationAccessNextAction) => {
      if (!action.target) return;
      if (action.target.type === 'assistant') {
        openAssistantsPage(
          action.target.assistantId ?? activeConv?.assistantId,
        );
        return;
      }
      openSettingsPage('default-access-policy');
    },
    [activeConv?.assistantId, openAssistantsPage, openSettingsPage],
  );

  const chooseAccessDir = async () => {
    if (accessManagedByAssistant) return;
    if (pickingAccessDir) return;
    setPickingAccessDir(true);
    setAccessPickerError('');
    try {
      const selectedPath = await pickConversationAccessDirectory();
      if (!selectedPath) return;
      setNewAccessDir(selectedPath);
      setAccessDraft((prev) =>
        prev.includes(selectedPath) ? prev : [...prev, selectedPath],
      );
    } catch (err) {
      setAccessPickerError(
        err instanceof Error ? err.message : t('access.error.saveNetwork'),
      );
    } finally {
      setPickingAccessDir(false);
    }
  };

  const handleResolveApproval = useCallback(
    async (
      approval: ApprovalRequest,
      decision: 'allow-once' | 'deny',
      scope?: ApprovalScope,
    ) => {
      if (resolvingApprovalId) return;
      setResolvingApprovalId(approval.id);
      try {
        const ok = await resolveApproval(approval.id, decision, scope);
        if (ok !== false) {
          if (decision === 'deny') {
            setApprovalFollowupHint({
              id: approval.id,
              toolName: approval.toolName,
              command: approval.command,
              cwd: approval.cwd,
              resolvedAt: new Date().toISOString(),
            });
          } else {
            setApprovalFollowupHint(null);
          }
        }
      } finally {
        setResolvingApprovalId(null);
      }
    },
    [resolveApproval, resolvingApprovalId],
  );

  const handleInterruptReply = useCallback(() => {
    void interruptReply();
  }, [interruptReply]);

  const openAccessDialog = useCallback(() => {
    setAccessDialogOpen(true);
  }, []);

  const applyCommandSuggestion = useCallback(
    (template: string) => {
      setCommandSuggestionDismissed(true);
      setInput(`${template} `);
    },
    [setInput],
  );

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      showCommandSuggestionPanel &&
      event.key === 'Tab' &&
      filteredCommandSuggestions.length > 0
    ) {
      event.preventDefault();
      applyCommandSuggestion(filteredCommandSuggestions[0]!.template);
      return;
    }
    handleKeyDown(event);
  };

  const renderVirtuosoItem = useCallback(
    (
      _listIndex: number,
      item: { entry: ChatTimelineEntry; fullIndex: number },
    ) => {
      const { entry, fullIndex } = item;
      const previous = fullIndex > 0 ? timelineEntries[fullIndex - 1]! : null;
      const stackedAssistant =
        entry.kind !== 'user_message' && previous?.kind !== 'user_message';
      const showAssistantAvatar =
        entry.kind !== 'user_message' && !stackedAssistant;

      if (entry.kind === 'user_message') {
        const displayContent = getDisplayContent(
          entry.message.content,
          false,
          activeConv?.channel,
          mentionCandidates,
        );
        const uploadedFiles = entry.message.uploaded_files || [];
        const visibleContent =
          uploadedFiles.length > 0
            ? stripUploadedFileLabel(displayContent)
            : displayContent;
        const memoryActionState =
          messageMemoryActionStateByMessageId[entry.message.id];
        const memoryActionPending = Boolean(memoryActionState?.pendingAction);
        return (
          <div key={entry.key} id={`msg-${entry.key}`} className="msg-row user">
            <MessageCheckbox
              entryKey={entry.key}
              onToggle={toggleConversationItemSelection}
            />
            <div className="msg-bubble-wrap">
              <div
                className={`msg-bubble user ${entry.pending ? 'pending-user-bubble' : ''}`}
              >
                {visibleContent.trim() ? (
                  <MarkdownContent
                    className="msg-text markdown"
                    content={visibleContent}
                  />
                ) : null}
                {uploadedFiles.length > 0 ? (
                  <ConversationUploadedFiles
                    chatJid={
                      activeJid ||
                      entry.message.chat_jid ||
                      activeConv?.jid ||
                      ''
                    }
                    files={uploadedFiles}
                  />
                ) : null}
              </div>
              <div className="msg-meta">
                {formatTime(entry.timestamp)}
                {entry.pending ? ` ${t('chat.·_待发送')}` : ''}
              </div>
              {!entry.pending && visibleContent.trim() ? (
                <div className="msg-memory-actions">
                  <button
                    type="button"
                    className="msg-memory-action-btn subtle"
                    onClick={() =>
                      void shareConversationItems([entry.key], {
                        clearSelection: false,
                      })
                    }
                  >
                    {t('chat.12500f')}
                  </button>
                  <button
                    type="button"
                    className="msg-memory-action-btn subtle"
                    onClick={() =>
                      void exportConversationItemsAsMarkdown([entry.key], {
                        clearSelection: false,
                      })
                    }
                  >
                    {t('chat.c75dd2')}
                  </button>
                  <button
                    type="button"
                    className="msg-memory-action-btn"
                    onClick={() =>
                      void onMessageMemoryAction({
                        action: 'remember',
                        messageId: entry.message.id,
                        sender: entry.message.sender,
                        senderName: entry.message.sender_name,
                        text: visibleContent,
                      })
                    }
                    disabled={memoryActionPending}
                  >
                    {memoryActionState?.pendingAction === 'remember'
                      ? t('chat.记忆中')
                      : t('chat.记住这个')}
                  </button>
                  <button
                    type="button"
                    className="msg-memory-action-btn subtle"
                    onClick={() =>
                      void onMessageMemoryAction({
                        action: 'session_only',
                        messageId: entry.message.id,
                        sender: entry.message.sender,
                        senderName: entry.message.sender_name,
                        text: visibleContent,
                      })
                    }
                    disabled={memoryActionPending}
                  >
                    {memoryActionState?.pendingAction === 'session_only'
                      ? t('chat.设置中')
                      : t('chat.仅本次')}
                  </button>
                </div>
              ) : null}
              {memoryActionState?.message ? (
                <div
                  className={`msg-memory-feedback ${memoryActionState.tone || 'success'}`}
                >
                  {memoryActionState.message}
                </div>
              ) : null}
            </div>
            <div className="msg-avatar user-avatar">U</div>
          </div>
        );
      }

      return (
        <div
          key={entry.key}
          id={`msg-${entry.key}`}
          className={`msg-row bot timeline-entry-row ${stackedAssistant ? 'stacked' : ''}`}
        >
          <div
            className={`msg-avatar bot-avatar ${showAssistantAvatar ? '' : 'ghost'}`}
          >
            {showAssistantAvatar ? 'N' : ''}
          </div>
          <MessageCheckbox
            entryKey={entry.key}
            onToggle={toggleConversationItemSelection}
          />
          <div className="msg-bubble-wrap">
            {entry.kind === 'assistant_message' && (
              <div className="assistant-turn-node assistant-turn-node-assistant_message single-entry-node">
                <div className="assistant-turn-node-rail" aria-hidden="true">
                  <span className="assistant-turn-node-dot response" />
                  <span className="assistant-turn-node-line" />
                </div>
                <div className="assistant-turn-node-main">
                  <div
                    className={`assistant-turn-card assistant-response-card assistant-entry-card turn-item turn-item-response status-${entry.status}`}
                  >
                    <div className="turn-item-header assistant-response-card-header">
                      <span
                        className="turn-item-summary-icon response"
                        aria-hidden="true"
                      />
                      <div className="turn-item-summary-main">
                        <div className="turn-item-summary-top">
                          <span className="turn-item-kind response">
                            {t('assistant.reply')}
                          </span>
                          <span className="turn-item-title">
                            {entry.status === 'in_progress'
                              ? t('chat.生成回复中')
                              : t('assistant.aiReply')}
                          </span>
                          <span className={`turn-item-status ${entry.status}`}>
                            {getStatusLabel(entry.status)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="turn-item-body turn-item-body-response">
                      {entry.status === 'in_progress' && !entry.text.trim() ? (
                        <InlineAssistantLoading />
                      ) : entry.status === 'in_progress' ? (
                        <div className="msg-text assistant-turn-text assistant-turn-streaming-text">
                          {getDisplayContent(
                            entry.text,
                            true,
                            activeConv?.channel,
                            mentionCandidates,
                          )}
                        </div>
                      ) : (
                        <MarkdownContent
                          className="msg-text markdown assistant-turn-text"
                          content={getDisplayContent(
                            entry.text,
                            true,
                            activeConv?.channel,
                            mentionCandidates,
                          )}
                        />
                      )}
                      {entry.status === 'completed' && entry.text.trim() ? (
                        <div className="msg-memory-actions assistant-response-actions">
                          {latestRetryableAssistantEntryKey === entry.key ? (
                            <button
                              type="button"
                              className="msg-memory-action-btn subtle icon-only assistant-response-retry-inline"
                              onClick={() =>
                                void regenerateReply(entry.turnId!)
                              }
                              title={regenerateButtonTitle}
                              aria-label={regenerateButtonTitle}
                              disabled={assistantBusy || regeneratingReply}
                            >
                              <IconRefresh />
                            </button>
                          ) : null}
                          <div className="assistant-response-actions-trailing">
                            <button
                              type="button"
                              className={`msg-memory-action-btn subtle icon-only${copiedAssistantEntryKey === entry.key ? ' copied' : ''}`}
                              onClick={() =>
                                void handleCopyAssistantMessage(
                                  entry.key,
                                  entry.text,
                                )
                              }
                              title={t('actions.copy')}
                              aria-label={t('actions.copy')}
                            >
                              {copiedAssistantEntryKey === entry.key ? (
                                <IconCheck />
                              ) : (
                                <IconCopy />
                              )}
                            </button>
                            <button
                              type="button"
                              className="msg-memory-action-btn subtle icon-only"
                              onClick={() =>
                                void shareConversationItems([entry.key], {
                                  clearSelection: false,
                                })
                              }
                              title={t('chat.12500f')}
                              aria-label={t('chat.12500f')}
                            >
                              <IconShare />
                            </button>
                            <button
                              type="button"
                              className="msg-memory-action-btn subtle icon-only"
                              onClick={() =>
                                void exportConversationItemsAsMarkdown(
                                  [entry.key],
                                  {
                                    clearSelection: false,
                                  },
                                )
                              }
                              title={t('chat.c75dd2')}
                              aria-label={t('chat.c75dd2')}
                            >
                              <IconDownload />
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {entry.kind === 'reasoning' && (
              <div className="assistant-turn-node assistant-turn-node-reasoning_group single-entry-node">
                <div className="assistant-turn-node-rail" aria-hidden="true">
                  <span
                    className={`assistant-turn-node-dot reasoning ${entry.item.status}`}
                  />
                  <span className="assistant-turn-node-line" />
                </div>
                <div className="assistant-turn-node-main">
                  <details
                    className={`assistant-turn-card assistant-reasoning-card assistant-reasoning-details turn-item turn-item-reasoning status-${entry.item.status}`}
                    open={entry.item.status !== 'completed' ? true : undefined}
                  >
                    <summary className="turn-item-header turn-item-summary">
                      <span
                        className="turn-item-summary-icon reasoning"
                        aria-hidden="true"
                      />
                      <div className="turn-item-summary-main">
                        <div className="turn-item-summary-top">
                          <span className="turn-item-kind reasoning">
                            {entry.item.status === 'in_progress'
                              ? t('assistant.thinking')
                              : t('assistant.thought')}
                          </span>
                          <span className="turn-item-title">
                            {entry.item.title || t('assistant.processing')}
                          </span>
                          <span
                            className={`turn-item-status ${entry.item.status}`}
                          >
                            {getStatusLabel(entry.item.status)}
                          </span>
                        </div>
                        {entry.item.status === 'completed' ? (
                          <span className="turn-item-preview assistant-reasoning-summary-text">
                            {truncatePreview(
                              formatReasoningText(
                                entry.item.title,
                                entry.item.text,
                              ),
                              120,
                            )}
                          </span>
                        ) : null}
                      </div>
                    </summary>
                    <div className="turn-item-body turn-item-body-reasoning">
                      <div className="turn-item-section">
                        <div className="turn-item-label">
                          {t('assistant.content')}
                        </div>
                        <div className="assistant-activity-text assistant-activity-text-block">
                          <span className="assistant-activity-body">
                            {formatReasoningText(
                              entry.item.title,
                              entry.item.text,
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            )}

            {entry.kind === 'tool_call' && (
              <div className="assistant-turn-node assistant-turn-node-tool_call single-entry-node">
                <div className="assistant-turn-node-rail" aria-hidden="true">
                  <span
                    className={`assistant-turn-node-dot tool ${entry.item.status}`}
                  />
                  <span className="assistant-turn-node-line" />
                </div>
                <div className="assistant-turn-node-main">
                  <details
                    className="assistant-turn-card assistant-tool-card turn-item turn-item-tool"
                    open={entry.item.status === 'failed'}
                  >
                    <summary className="turn-item-header turn-item-summary">
                      <span
                        className="turn-item-summary-icon"
                        aria-hidden="true"
                      />
                      <div className="turn-item-summary-main">
                        <div className="turn-item-summary-top">
                          <span className="turn-item-kind tool_call">
                            {t('assistant.tool')}
                          </span>
                          <span className="turn-item-title">
                            {entry.item.title}
                          </span>
                          <ToolCallDurationLabel
                            startedAt={entry.item.startedAt}
                            completedAt={entry.item.completedAt}
                            timestamp={entry.item.timestamp}
                            status={entry.item.status}
                          />
                          <span
                            className={`turn-item-status ${entry.item.status}`}
                          >
                            {getStatusLabel(entry.item.status)}
                          </span>
                        </div>
                        <span className="turn-item-preview">
                          {truncatePreview(
                            entry.item.status === 'failed'
                              ? entry.item.errorText ||
                                  entry.item.argumentsText ||
                                  ''
                              : entry.item.resultText ||
                                  entry.item.argumentsText ||
                                  '',
                          )}
                        </span>
                      </div>
                    </summary>
                    <div className="turn-item-body">
                      {entry.approval ? (
                        <div className="assistant-approval-slot">
                          <div className="assistant-approval-slot-text">
                            {t('assistant.approvalPending')}
                          </div>
                        </div>
                      ) : null}
                      {entry.item.subagentInfo ? (
                        <SubagentActivity
                          info={entry.item.subagentInfo}
                          argumentsText={entry.item.argumentsText}
                          resultText={entry.item.resultText}
                          errorText={entry.item.errorText}
                        />
                      ) : (
                        <>
                          {entry.item.argumentsText && (
                            <div className="turn-item-section">
                              <div className="turn-item-label">
                                {t('assistant.input')}
                              </div>
                              <ToolResultCard
                                key={`${entry.item.id}-args`}
                                toolName={entry.item.title}
                                output={entry.item.argumentsText}
                                variant="arguments"
                              />
                            </div>
                          )}
                          {entry.item.resultText && (
                            <div className="turn-item-section">
                              <div className="turn-item-label">
                                {t('assistant.result')}
                              </div>
                              <ToolResultCard
                                key={`${entry.item.id}-result`}
                                toolName={entry.item.title}
                                output={entry.item.resultText}
                              />
                              <GeneratedToolImages
                                activeJid={activeJid}
                                resultText={entry.item.resultText}
                              />
                            </div>
                          )}
                          {entry.item.errorText && (
                            <div className="turn-item-section">
                              <div className="turn-item-label">
                                {t('assistant.error')}
                              </div>
                              <ToolResultCard
                                key={`${entry.item.id}-err`}
                                toolName={entry.item.title}
                                output={entry.item.errorText}
                                isError
                              />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            )}

            {entry.kind === 'approval' && (
              <div className="assistant-turn-node assistant-turn-node-approval_slot single-entry-node">
                <div className="assistant-turn-node-rail" aria-hidden="true">
                  <span className="assistant-turn-node-dot approval" />
                  <span className="assistant-turn-node-line" />
                </div>
                <div className="assistant-turn-node-main">
                  <div className="assistant-turn-card assistant-approval-slot assistant-entry-card">
                    <div className="assistant-approval-slot-text">
                      {t('assistant.approvalMoved')}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {entry.kind === 'turn_error' && (
              <div className="assistant-turn-node assistant-turn-node-error single-entry-node">
                <div className="assistant-turn-node-rail" aria-hidden="true">
                  <span className="assistant-turn-node-dot error" />
                  <span className="assistant-turn-node-line" />
                </div>
                <div className="assistant-turn-node-main">
                  <div className="turn-error">{entry.error}</div>
                </div>
              </div>
            )}

            <div className="msg-meta">{formatTime(entry.timestamp)}</div>
          </div>
        </div>
      );
    },
    [
      activeConv?.channel,
      assistantBusy,
      formatTime,
      getDisplayContent,
      copiedAssistantEntryKey,
      exportConversationItemsAsMarkdown,
      handleInterruptReply,
      handleCopyAssistantMessage,
      interruptButtonTitle,
      interruptingReply,
      mentionCandidates,
      messageMemoryActionStateByMessageId,
      onMessageMemoryAction,
      latestRegeneratableTurnId,
      latestRetryableAssistantEntryKey,
      regenerateButtonTitle,
      regenerateReply,
      regeneratingReply,
      shareConversationItems,
      timelineEntries,
      toggleConversationItemSelection,
      truncatePreview,
    ],
  );
  const showInlineLoading = useMemo(
    () =>
      shouldShowInlineAssistantLoading({
        timelineEntries,
        typing,
        streaming,
      }),
    [timelineEntries, typing, streaming],
  );

  useEffect(() => {
    if ((showInlineLoading || streaming) && atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [showInlineLoading, streaming, messagesEndRef]);

  const virtuosoComponents = useMemo(
    () => ({
      Header: function ChatMessagesVirtuosoHeader() {
        if (!loadingOlder) return null;
        return (
          <div className="messages-load-older-hint">
            <span className="messages-load-older-spinner" />
            {t('messages.loadOlder')}
          </div>
        );
      },
      Footer: function ChatMessagesVirtuosoFooter() {
        return (
          <>
            {showInlineLoading && (
              <div className="msg-row bot timeline-entry-row">
                <div className="msg-avatar bot-avatar">N</div>
                <div className="msg-bubble-wrap">
                  <div className="assistant-turn-node assistant-turn-node-live single-entry-node">
                    <div
                      className="assistant-turn-node-rail"
                      aria-hidden="true"
                    >
                      <span className="assistant-turn-node-dot live" />
                      <span className="assistant-turn-node-line" />
                    </div>
                    <div className="assistant-turn-node-main">
                      <div className="assistant-turn-card assistant-response-card assistant-entry-card turn-item turn-item-response status-in_progress">
                        <div className="turn-item-header assistant-response-card-header">
                          <span
                            className="turn-item-summary-icon response"
                            aria-hidden="true"
                          />
                          <div className="turn-item-summary-main">
                            <div className="turn-item-summary-top">
                              <span className="turn-item-kind response">
                                {t('assistant.reply')}
                              </span>
                              <span className="turn-item-title">
                                {t('chat.生成回复中')}
                              </span>
                              <span className="turn-item-status in_progress">
                                {getStatusLabel('in_progress')}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="turn-item-body turn-item-body-response">
                          <InlineAssistantLoading />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} style={{ height: 40 }} />
          </>
        );
      },
    }),
    [
      showInlineLoading,
      loadingOlder,
      messagesEndRef,
      handleInterruptReply,
      interruptButtonTitle,
      interruptingReply,
    ],
  );

  if (!activeJid) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconChat />
        </div>
        <h2>{t('chat.welcomeTitle', { name: assistantName })}</h2>
        <p>{t('chat.welcomeDesc', { name: assistantName })}</p>
        <button className="empty-btn" onClick={() => createConversation()}>
          {t('welcome.newChat')}
        </button>
        <div
          className="empty-state-hints"
          aria-label={t('welcome.hintAriaLabel')}
        >
          <span className="empty-state-hint">{t('welcome.hintSwitch')}</span>
          <span className="empty-state-hint">
            <span
              dangerouslySetInnerHTML={{ __html: t('welcome.hintReset') }}
            />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        <div className="chat-header-main">
          <h2 title={conversationTitle}>{conversationTitle}</h2>
          <div className="chat-header-info">
            {showConversationBaseTitle ? (
              <span className="chat-title">{conversationBaseTitle}</span>
            ) : null}
            {activeConv?.is_pinned ? (
              <span className="channel-tag">{t('status.pinned')}</span>
            ) : null}
            {activeAssistantLabel ? (
              <span className="channel-tag">
                {t('chat.assistantTag', { label: activeAssistantLabel })}
              </span>
            ) : null}
            {activeConv?.tavernPersonaName ? (
              <span className="channel-tag tavern-tag">
                酒馆 · {activeConv.tavernPersonaName}
              </span>
            ) : null}
            {conversationChannelLabel ? (
              <span className="channel-tag">{conversationChannelLabel}</span>
            ) : null}
            {providerOptions.length > 0 ? (
              <AppSelect
                value={
                  activeConv?.conversationProviderId || activeProviderId || ''
                }
                onChange={(nextValue) => {
                  if (!nextValue || !activeConv) return;
                  void setConversationProvider(
                    activeConv.jid,
                    nextValue === '__default__' ? null : nextValue,
                    activeConv.conversationModel || null,
                  );
                }}
                ariaLabel={t('header.provider.switch')}
                compact
                className="chat-provider-select"
                options={providerOptions}
              />
            ) : (
              <span className="provider-badge">{activeProviderAlias}</span>
            )}
            {activeConv?.conversationModel ? (
              <input
                className="chat-model-override-input"
                value={modelOverrideDraft}
                onChange={(event) => setModelOverrideDraft(event.target.value)}
                onBlur={saveModelOverride}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                  if (event.key === 'Escape') {
                    setModelOverrideDraft(activeConv.conversationModel || '');
                    event.currentTarget.blur();
                  }
                }}
                placeholder={selectedProvider?.model || 'model override'}
                aria-label="Conversation model override"
                title={
                  modelOverrideDraft.trim()
                    ? '会话级模型覆盖，留空则使用 Provider 默认模型'
                    : `使用默认模型 ${selectedProvider?.model || '未配置'}`
                }
              />
            ) : null}
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            className={`header-btn ${conversationSidebarCollapsed ? 'active' : ''}`}
            onClick={toggleConversationSidebar}
            title={
              conversationSidebarCollapsed ? t('header.show') : t('header.hide')
            }
            data-tooltip={
              conversationSidebarCollapsed ? t('header.show') : t('header.hide')
            }
          >
            <IconSidebarToggle collapsed={conversationSidebarCollapsed} />
          </button>
          <button
            className="header-btn"
            onClick={() => setAccessDialogOpen(true)}
            title={accessButtonTitle}
            data-tooltip={accessButtonTitle}
          >
            <IconFolder />
          </button>
          <button
            className={`header-btn ${activeConv?.is_pinned ? 'active' : ''}`}
            onClick={() =>
              activeConv &&
              updateConversationMeta(activeConv.jid, {
                isPinned: !activeConv.is_pinned,
              })
            }
            title={activeConv?.is_pinned ? t('header.unpin') : t('header.pin')}
            data-tooltip={
              activeConv?.is_pinned ? t('header.unpin') : t('header.pin')
            }
          >
            <IconPin filled={!!activeConv?.is_pinned} />
          </button>
          {messageSelectionMode ? (
            <>
              <button
                className="header-btn"
                onClick={selectAllConversationItems}
                title={
                  allConversationItemsSelected
                    ? t('header.clearSelection')
                    : t('header.selectAll')
                }
                data-tooltip={
                  allConversationItemsSelected
                    ? t('header.clearSelection')
                    : t('header.selectAll')
                }
                aria-disabled={timelineEntries.length === 0}
                disabled={timelineEntries.length === 0}
              >
                <IconCheckSquare />
              </button>
              <button
                className={`header-btn ${selectedConversationItemCount === 0 ? 'disabled' : ''}`}
                onClick={() => {
                  if (selectedConversationItemCount === 0) return;
                  void exportSelectedConversationItemsAsMarkdown();
                }}
                title={exportTooltip}
                data-tooltip={exportTooltip}
                aria-disabled={selectedConversationItemCount === 0}
                disabled={selectedConversationItemCount === 0}
              >
                <IconDownload />
              </button>
              <button
                className={`header-btn ${selectedConversationItemCount === 0 ? 'disabled' : ''}`}
                onClick={() => {
                  if (selectedConversationItemCount === 0) return;
                  void shareSelectedConversationItems();
                }}
                title={
                  selectedConversationItemCount === 0
                    ? t('selection.share.empty')
                    : t('selection.share.selected', {
                        count: selectedConversationItemCount,
                      })
                }
                data-tooltip={
                  selectedConversationItemCount === 0
                    ? t('selection.share.empty')
                    : t('selection.share.selected', {
                        count: selectedConversationItemCount,
                      })
                }
                aria-disabled={selectedConversationItemCount === 0}
                disabled={selectedConversationItemCount === 0}
              >
                <IconShare />
              </button>
              <button
                className="header-btn"
                onClick={toggleMessageSelectionMode}
                title={t('header.done')}
                data-tooltip={t('header.done')}
              >
                <IconCheck />
              </button>
            </>
          ) : (
            <>
              <button
                className="header-btn"
                onClick={toggleMessageSelectionMode}
                title={t('header.batch')}
                data-tooltip={t('header.batch')}
              >
                <IconShare />
              </button>
              <div className="chat-header-menu-wrap" ref={conversationMenuRef}>
                <button
                  className={`header-btn ${conversationMenuOpen ? 'active' : ''}`}
                  onClick={() => setConversationMenuOpen((prev) => !prev)}
                  title={t('header.more')}
                  data-tooltip={t('header.more')}
                  aria-haspopup="menu"
                  aria-expanded={conversationMenuOpen}
                >
                  <IconChevronDown />
                </button>
                {conversationMenuOpen ? (
                  <div className="chat-header-menu" role="menu">
                    <button
                      type="button"
                      className="chat-header-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setConversationMenuOpen(false);
                        setShareHistoryOpen(true);
                      }}
                    >
                      {t('header.shareManage')}
                    </button>
                    {hasLive2dPerm && onOpenLive2dConfig ? (
                      <button
                        type="button"
                        className="chat-header-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setConversationMenuOpen(false);
                          onOpenLive2dConfig();
                        }}
                      >
                        {t('header.live2dConfig')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <ShareHistoryPanel
        open={shareHistoryOpen}
        onClose={() => setShareHistoryOpen(false)}
        activeJid={activeJid}
      />

      <Drawer
        open={accessDialogOpen}
        onClose={() => setAccessDialogOpen(false)}
        title={
          accessManagedByAssistant
            ? t('access.titleManaged')
            : t('access.title')
        }
        width={640}
      >
        <div className="settings-hint">
          {accessManagedByAssistant
            ? t('access.hintManaged', {
                assistant: activeAssistantLabel || t('chat.auto_f0cc12'),
              })
            : t('access.hint')}
        </div>
        {approvalFollowupHint ? (
          <div className="access-policy-recommendation">
            <div className="access-policy-recommendation-header">
              <strong>{t('access.recommendation.title')}</strong>
              <span>
                {new Date(approvalFollowupHint.resolvedAt).toLocaleTimeString()}
              </span>
            </div>
            <code>{approvalFollowupHint.command}</code>
            {approvalFollowupHint.cwd ? (
              <span>
                {t('access.recommendation.cwdLabel', {
                  cwd: approvalFollowupHint.cwd,
                })}
              </span>
            ) : null}
            <p>
              {describeDeniedApprovalFollowup({
                approval: approvalFollowupHint,
                policy: currentAccessPolicy,
                accessManagedByAssistant,
                activeAssistantLabel,
              })}
            </p>
            {!accessManagedByAssistant ? (
              <div className="access-policy-recommendation-actions">
                {approvalFollowupHint.cwd ? (
                  <>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() =>
                        applySuggestedAccessDir(approvalFollowupHint.cwd)
                      }
                      disabled={hasAccessDirectory(
                        accessDraft,
                        approvalFollowupHint.cwd,
                      )}
                    >
                      {hasAccessDirectory(accessDraft, approvalFollowupHint.cwd)
                        ? t('access.recommendation.inAllowlist')
                        : t('access.recommendation.addCwd')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() =>
                        void saveSuggestedAccessDir(approvalFollowupHint.cwd)
                      }
                      disabled={conversationAccessSaving}
                    >
                      {conversationAccessSaving
                        ? 'Saving...'
                        : t('access.recommendation.saveAndAdd')}
                    </button>
                  </>
                ) : null}
                {currentAccessPolicy?.mode !== 'readonly' ? (
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => setAccessModeDraft('readonly')}
                  >
                    {t('access.recommendation.switchReadonly')}
                  </button>
                ) : null}
                {currentAccessPolicy?.mode !== 'allowlist' ? (
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => setAccessModeDraft('allowlist')}
                  >
                    {t('access.recommendation.switchAllowlist')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setApprovalFollowupHint(null)}
                >
                  {t('access.recommendation.hide')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="access-policy-summary">
          <div className="access-policy-summary-item">
            <span>{t('access.summary.source')}</span>
            <strong>
              {t(getAccessSourceLabel(currentAccessPolicy?.source))}
            </strong>
          </div>
          <div className="access-policy-summary-item">
            <span>{t('access.summary.mode')}</span>
            <strong>{t(getAccessModeOption(accessModeDraft).labelKey)}</strong>
          </div>
          <div className="access-policy-summary-item">
            <span>{t('access.summary.directories')}</span>
            <strong>{accessDraft.length}</strong>
          </div>
          <div className="access-policy-summary-item">
            <span>{t('access.summary.runtime')}</span>
            <strong>
              {runtimeAccess?.hasActivePatches
                ? t('access.summary.runtimeCount', {
                    count: runtimeAccess.activePatchCount,
                  })
                : t('access.summary.runtimeNone')}
            </strong>
          </div>
        </div>
        <div className="assistant-choice-block">
          <div className="assistant-section-label">
            {t('access.mode.title')}
          </div>
          <div className="assistant-choice-grid access-policy-mode-grid">
            {ACCESS_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`assistant-choice-card ${
                  accessModeDraft === option.value ? 'active' : ''
                }`}
                onClick={() => setAccessModeDraft(option.value)}
                disabled={accessManagedByAssistant}
              >
                <strong>{t(option.labelKey)}</strong>
                <span>{t(option.descriptionKey)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="assistant-choice-help">
          {t(getAccessModeOption(accessModeDraft).descriptionKey)}
        </div>
        <div className="settings-hint">
          {accessManagedByAssistant
            ? t('access.hintManagedPolicy')
            : t('access.hintSave')}
        </div>
        {runtimeApprovalPatches.length > 0 ? (
          <div className="access-runtime-patch-panel">
            <div className="assistant-section-label">
              {t('access.runtime.title')}
            </div>
            <div className="access-runtime-patch-list">
              {runtimeApprovalPatches.map((patch) => (
                <div key={patch.id} className="access-runtime-patch-item">
                  <strong>{patch.toolName}</strong>
                  <code>{patch.command}</code>
                  <span>
                    {t('access.runtime.scope', {
                      scope: t(getApprovalScopeLabel(patch.scope)),
                      expiresAt: new Date(patch.expiresAt).toLocaleString(),
                    })}
                  </span>
                  {patch.cwd ? (
                    <span>
                      {t('access.runtime.cwdLabel', { cwd: patch.cwd })}
                    </span>
                  ) : null}
                  {!accessManagedByAssistant && patch.cwd ? (
                    <div className="access-runtime-patch-actions">
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        onClick={() => applySuggestedAccessDir(patch.cwd)}
                        disabled={hasAccessDirectory(accessDraft, patch.cwd)}
                      >
                        {hasAccessDirectory(accessDraft, patch.cwd)
                          ? t('access.runtime.inAllowlist')
                          : t('access.runtime.addAllowlist')}
                      </button>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        onClick={() => void saveSuggestedAccessDir(patch.cwd)}
                        disabled={conversationAccessSaving}
                      >
                        {conversationAccessSaving
                          ? 'Saving...'
                          : t('access.runtime.saveAndAdd')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="assistant-choice-help">
              {t('access.runtime.hint')}
            </div>
          </div>
        ) : null}
        <div className="access-policy-layer-panel">
          <div className="assistant-section-label">
            {t('access.nextSteps.title')}
          </div>
          <div className="access-policy-layer-list">
            <div className="access-policy-layer-item active">
              <strong>{t('access.nextSteps.currentEffect')}</strong>
              <span>{effectiveAccessSummary}</span>
            </div>
            {nextAccessActions.map((action) => (
              <div key={action.id} className="access-policy-layer-item">
                <strong>{action.title}</strong>
                <span>{action.description}</span>
              </div>
            ))}
          </div>
          {nextAccessActions.some((action) => action.target) ? (
            <div className="modal-actions">
              {nextAccessActions
                .filter((action) => action.target)
                .map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="btn-outline"
                    onClick={() => handleAccessNextAction(action)}
                  >
                    {action.target?.label}
                  </button>
                ))}
            </div>
          ) : null}
        </div>
        {accessPolicyLayers ? (
          <div className="access-policy-layer-panel">
            <div className="access-panel-header">
              <div className="access-panel-header-copy">
                <div className="assistant-section-label">
                  {t('access.inheritance.title')}
                </div>
                <div className="assistant-choice-help">
                  {accessInheritanceSummary}
                </div>
              </div>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => setAccessInheritanceExpanded((prev) => !prev)}
              >
                {accessInheritanceExpanded
                  ? t('access.inheritance.collapse')
                  : t('access.inheritance.expand')}
              </button>
            </div>
            {accessInheritanceExpanded ? (
              <>
                <div className="access-policy-layer-list">
                  <div
                    className={`access-policy-layer-item ${
                      currentAccessPolicy?.source === 'global' ? 'active' : ''
                    }`}
                  >
                    <strong>{t('access.inheritance.global')}</strong>
                    <span>
                      {formatAccessLayerDescription(accessPolicyLayers.global)}
                    </span>
                  </div>
                  <div
                    className={`access-policy-layer-item ${
                      currentAccessPolicy?.source === 'assistant'
                        ? 'active'
                        : ''
                    }`}
                  >
                    <strong>
                      {activeAssistantLabel ||
                        t('access.inheritance.assistantDefault')}
                    </strong>
                    <span>
                      {formatAccessLayerDescription(
                        accessPolicyLayers.assistant,
                      )}
                    </span>
                  </div>
                  <div
                    className={`access-policy-layer-item ${
                      currentAccessPolicy?.source === 'conversation'
                        ? 'active'
                        : ''
                    }`}
                  >
                    <strong>{t('access.inheritance.conversation')}</strong>
                    <span>
                      {formatAccessLayerDescription(
                        accessPolicyLayers.conversation,
                      )}
                    </span>
                  </div>
                </div>
                <div className="assistant-choice-help">
                  {t('access.inheritance.hint')}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {accessPickerError && (
          <div className="login-error">{accessPickerError}</div>
        )}
        <div className="assistant-section-label">{t('access.dir.title')}</div>
        <div className="dir-list">
          {conversationAccessLoading ? (
            <div className="dir-empty">{t('access.dir.loading')}</div>
          ) : (
            accessDraft.map((dir, index) => (
              <div key={`${dir}-${index}`} className="dir-item">
                <span className="dir-path">{dir}</span>
                {!accessManagedByAssistant ? (
                  <button
                    className="btn-danger btn-sm"
                    onClick={() => removeAccessDir(index)}
                  >
                    {t('access.dir.remove')}
                  </button>
                ) : null}
              </div>
            ))
          )}
          {!conversationAccessLoading && accessDraft.length === 0 && (
            <div className="dir-empty">
              {accessManagedByAssistant
                ? t('access.dir.emptyManaged')
                : t('access.dir.empty')}
            </div>
          )}
        </div>
        <div className="assistant-field-hint">{t('access.dir.hint')}</div>
        {!accessManagedByAssistant ? (
          <div className="dir-add-row">
            <input
              value={newAccessDir}
              onChange={(event) => setNewAccessDir(event.target.value)}
              placeholder={t('access.dir.placeholder')}
              onKeyDown={(event) => event.key === 'Enter' && addAccessDir()}
            />
            <button
              className="btn-outline btn-sm"
              onClick={() => void chooseAccessDir()}
              disabled={pickingAccessDir}
            >
              {pickingAccessDir
                ? t('access.dir.picking')
                : t('access.dir.choose')}
            </button>
            <button
              className="btn-primary btn-sm"
              onClick={addAccessDir}
              disabled={!newAccessDir.trim()}
            >
              {t('access.dir.add')}
            </button>
          </div>
        ) : null}
        <div className="modal-actions">
          <button
            className="btn-outline"
            onClick={() => setAccessDialogOpen(false)}
          >
            {accessManagedByAssistant ? t('access.close') : t('access.cancel')}
          </button>
          {!accessManagedByAssistant ? (
            <button
              className="btn-primary"
              onClick={() => {
                setAccessSaveError('');
                void Promise.resolve(
                  saveConversationAccess({
                    mode: accessModeDraft,
                    directories: accessDraft,
                  }),
                ).then((result) => {
                  if (result !== true) {
                    setAccessSaveError(
                      typeof result === 'object' && result.error
                        ? result.error
                        : t('access.saveError'),
                    );
                  } else {
                    setAccessDialogOpen(false);
                  }
                });
              }}
              disabled={conversationAccessSaving}
            >
              {conversationAccessSaving ? 'Saving...' : t('access.save')}
            </button>
          ) : null}
        </div>
        {accessSaveError && (
          <div className="login-error">{accessSaveError}</div>
        )}
      </Drawer>

      <ApprovalOverlay
        approvals={activeApprovals}
        resolvingApprovalId={resolvingApprovalId}
        accessPolicySummary={formatAccessPolicySummary(currentAccessPolicy)}
        onOpenAccessDialog={openAccessDialog}
        onResolve={handleResolveApproval}
      />

      <div className="messages-area">
        {approvalFollowupHint ? (
          <div className="chat-approval-followup-banner">
            <div className="chat-approval-followup-copy">
              <strong>
                {t('approvalFollowup.title', {
                  toolName: approvalFollowupHint.toolName,
                })}
              </strong>
              <span>{approvalFollowupHint.command}</span>
              <p>
                {describeDeniedApprovalFollowup({
                  approval: approvalFollowupHint,
                  policy: currentAccessPolicy,
                  accessManagedByAssistant,
                  activeAssistantLabel,
                })}
              </p>
            </div>
            <div className="chat-approval-followup-actions">
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={openAccessDialog}
              >
                {t('approvalFollowup.viewPolicy')}
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => setApprovalFollowupHint(null)}
              >
                {t('approvalFollowup.close')}
              </button>
            </div>
          </div>
        ) : null}
        <SelectionKeysCtx.Provider value={selectedConversationItemKeys}>
          <div
            className={`messages${messageSelectionMode ? ' selection-mode' : ''}`}
            ref={bindMessagesContainerEl}
            onScroll={handleMessagesScroll}
            onWheelCapture={handleMessagesWheel}
            onTouchStart={handleMessagesTouchStart}
            onTouchMove={handleMessagesTouchMove}
            onTouchEnd={handleMessagesTouchEnd}
          >
            {messagesScrollParent && visibleTimelineItems.length > 0 ? (
              <Virtuoso
                key={activeJid || 'none'}
                ref={virtuosoRef}
                customScrollParent={messagesScrollParent}
                style={{ flex: 1, minHeight: 0 }}
                data={visibleTimelineItems}
                firstItemIndex={firstItemIndex}
                followOutput="smooth"
                alignToBottom
                atBottomThreshold={80}
                atBottomStateChange={(bottom) => {
                  atBottomRef.current = bottom;
                }}
                initialTopMostItemIndex={
                  firstItemIndex + visibleTimelineItems.length - 1
                }
                startReached={handleStartReached}
                itemContent={(index, item) => renderVirtuosoItem(index, item)}
                components={virtuosoComponents}
              />
            ) : null}
          </div>
        </SelectionKeysCtx.Provider>
      </div>

      <div className="input-bar">
        {pendingUploads.length > 0 && (
          <div className="pending-upload-list">
            {pendingUploads.map((file) => (
              <div key={file.id} className="pending-upload-item">
                <div className="pending-upload-meta">
                  <span className="pending-upload-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="pending-upload-size">
                    {Math.max(1, Math.round(file.size / 1024))}KB
                  </span>
                </div>
                <button
                  className="pending-upload-remove"
                  onClick={() => removePendingUpload(file.id)}
                  disabled={
                    assistantBusy || interruptingReply || uploadingFiles
                  }
                  title={t('upload.remove')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {sendError && <div className="chat-send-error">{sendError}</div>}
        <div className="input-wrap">
          {showCommandSuggestionPanel &&
            filteredCommandSuggestions.length > 0 && (
              <div
                className="command-suggestion-panel"
                role="listbox"
                aria-label={t('command.hint')}
              >
                {filteredCommandSuggestions.map((item) => (
                  <button
                    key={item.command}
                    type="button"
                    className="command-suggestion-item"
                    onClick={() => applyCommandSuggestion(item.template)}
                  >
                    <span className="command-suggestion-command">
                      {item.command}
                    </span>
                    <span className="command-suggestion-description">
                      {t(item.description)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              selectUploadFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            className="upload-btn"
            onClick={() => uploadInputRef.current?.click()}
            disabled={assistantBusy || interruptingReply || uploadingFiles}
            title={t('upload.file')}
            aria-label={t('upload.file')}
          >
            <IconFolder />
          </button>
          <textarea
            value={input}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setInput(event.target.value)
            }
            onKeyDown={handleComposerKeyDown}
            onCompositionStart={handleInputCompositionStart}
            onCompositionEnd={handleInputCompositionEnd}
            placeholder={
              assistantBusy
                ? t('input.placeholderBusy', { name: assistantName })
                : inputHintText || t('input.placeholder')
            }
            rows={1}
            disabled={assistantBusy || interruptingReply || uploadingFiles}
          />
          {assistantBusy ? (
            <button
              className="interrupt-btn"
              onClick={handleInterruptReply}
              disabled={interruptingReply}
              title={interruptButtonTitle}
              aria-label={interruptButtonTitle}
            >
              <IconStop />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={
                (!input.trim() && pendingUploads.length === 0) ||
                assistantBusy ||
                uploadingFiles
              }
              title={sendButtonTitle}
              aria-label={sendButtonTitle}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
