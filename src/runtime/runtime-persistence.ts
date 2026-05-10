import {
  accessPoliciesEqual,
  createDefaultAccessPolicy,
  normalizeAccessMode,
  resolveConversationAccessPolicy as resolveEffectiveConversationAccessPolicy,
  resolveLegacyAccessPolicy,
  serializeAccessPolicy,
  type AccessPolicy,
} from '../auth/access-policy.js';
import { parseAllowedDirectoriesValue } from '../security/allowed-directories.js';
import { getWebChannel } from '../channels/web.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import { getAssistantName, getConfigValue } from '../config-store.js';
import {
  deletePendingUploadsByChat,
  deleteSessionByJid,
  setRegisteredGroup,
  storeAssistantTurnSnapshot,
  storeContextEntries,
  storeMessageDirect,
  storeMessageDirectWithTurn,
} from '../db.js';
import { createModuleLogger } from '../logger.js';

const persistenceLog = createModuleLogger('persistence');
import { autoPromoteMemoryFromEntries } from '../memory/ingest-promotion.js';
import { scheduleContextCompaction } from '../memory/compaction-scheduler.js';
import { getRepoReviewConversationBinding } from '../repo-review/repo-review-service.js';
import type {
  AgentTurnEventPayload,
  AgentTurnItemPayload,
} from '../agent/agent-runner-types.js';
import {
  clearEphemeralSubagentRuntimes,
  removeEphemeralSubagentRuntime,
  upsertEphemeralSubagentRuntime,
} from '../subagent/subagent-runtime-registry.js';
import {
  activeConversationTurnIds,
  pendingUploadedFiles,
  queue,
  registeredGroups,
} from './runtime-state.js';
import type {
  AgentUploadedFile,
  ContextEntryRecord,
  NewMessage,
  RegisteredGroup,
} from '../types.js';
import type {
  PersistedAssistantTurn,
  PersistedTurnItem,
} from '../db/conversations.js';
import { t } from '../i18n/index.js';

export function sanitizeWebReply(chatJid: string, text: string): string {
  if (!chatJid.startsWith('web:')) return text;
  const withoutMention = text.replace(/^@Web(?:\s+User)?/i, '');
  return withoutMention
    .replace(/^[\s,，:：!！—]+/, '')
    .replace(/^-+/, '')
    .trimStart();
}

export function formatUserVisibleAgentError(error: string): string {
  const normalized = (error || '')
    .replace(/^Agent exited with code \d+:\s*/i, '')
    .replace(/^Codex API \d+:\s*/i, '')
    .trim();
  if (
    /string_above_max_length/i.test(normalized) ||
    (/string too long/i.test(normalized) &&
      /input\[\d+\]\.output/i.test(normalized))
  ) {
    return t('errors.auto_9ca2a1', {}, undefined);
  }
  const toolIterationMatch = normalized.match(
    /exceeded\s+(\d+)\s+tool iterations/i,
  );
  if (toolIterationMatch) {
    return t(
      'errors.codexToolIterationLimit',
      {
        count: toolIterationMatch[1],
        setting: t('config.auto_f935f7', {}, undefined),
      },
      undefined,
    );
  }
  if (!normalized) return t('errors.auto_20f82b', {}, undefined);
  return normalized.length > 400 ? `${normalized.slice(0, 400)}…` : normalized;
}

export function buildWebTurnFailureEvents(input: {
  error: string;
  turnId?: string;
  timestamp?: string;
}): AgentTurnEventPayload[] {
  const timestamp = input.timestamp || new Date().toISOString();
  const message = formatUserVisibleAgentError(input.error);
  const liveTurnId = input.turnId?.trim();
  if (liveTurnId) {
    return [
      {
        type: 'turn.failed',
        turnId: liveTurnId,
        timestamp,
        error: message,
      },
    ];
  }

  const turnId = `turn_failure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return [
    { type: 'turn.started', turnId, timestamp },
    {
      type: 'turn.failed',
      turnId,
      timestamp,
      error: message,
    },
  ];
}

export function notifyWebTurnFailure(
  chatJid: string,
  error: string,
  drafts: Map<string, PersistedAssistantTurn>,
  turnId?: string,
): void {
  if (!chatJid.startsWith('web:')) return;
  const webCh = getWebChannel();
  if (!webCh) return;
  for (const event of buildWebTurnFailureEvents({ error, turnId })) {
    if (event.type === 'turn.failed') {
      void persistTurnEventSnapshot(chatJid, drafts, event);
    } else {
      applyTurnEventToPersistenceDrafts(drafts, event);
    }
    webCh.notifyTurnEvent(chatJid, event);
  }
}

function cloneTurnItemForPersistence(
  item: AgentTurnItemPayload,
): PersistedTurnItem {
  if (item.type === 'assistant_message') {
    return {
      id: item.id,
      type: 'assistant_message',
      status: item.status,
      text: item.text,
      timestamp: item.timestamp,
    };
  }
  if (item.type === 'tool_call') {
    return {
      id: item.id,
      type: 'tool_call',
      status: item.status,
      title: item.title,
      argumentsText: item.argumentsText,
      resultText: item.resultText,
      errorText: item.errorText,
      startedAt:
        'startedAt' in item && typeof item.startedAt === 'string'
          ? item.startedAt
          : undefined,
      completedAt:
        'completedAt' in item && typeof item.completedAt === 'string'
          ? item.completedAt
          : undefined,
      subagentInfo: item.subagentInfo,
      timestamp: item.timestamp,
    };
  }
  return {
    id: item.id,
    type: 'reasoning',
    status: item.status,
    title: item.title,
    text: item.text,
    timestamp: item.timestamp,
  };
}

export function applyTurnEventToPersistenceDrafts(
  drafts: Map<string, PersistedAssistantTurn>,
  event: AgentTurnEventPayload,
): void {
  const timestamp = event.timestamp || new Date().toISOString();
  const ensureDraft = () => {
    const existing = drafts.get(event.turnId);
    if (existing) return existing;
    const created: PersistedAssistantTurn = {
      id: event.turnId,
      clientKey: event.turnId,
      timestamp,
      items: [],
      isLive: true,
      isCompleted: false,
    };
    drafts.set(event.turnId, created);
    return created;
  };

  if (event.type === 'turn.started') {
    const draft = ensureDraft();
    draft.timestamp = timestamp;
    draft.isLive = true;
    return;
  }

  if (
    event.type === 'item.started' ||
    event.type === 'item.updated' ||
    event.type === 'item.completed'
  ) {
    const draft = ensureDraft();
    let nextItem = cloneTurnItemForPersistence(event.item);
    const existingIndex = draft.items.findIndex(
      (item) => item.id === nextItem.id,
    );
    const existingItem =
      existingIndex >= 0 ? draft.items[existingIndex] : undefined;
    if (nextItem.type === 'tool_call') {
      nextItem = {
        ...nextItem,
        startedAt:
          nextItem.startedAt ||
          (existingItem?.type === 'tool_call'
            ? existingItem.startedAt
            : undefined) ||
          (event.type === 'item.started' ? nextItem.timestamp : undefined),
        completedAt:
          nextItem.completedAt ||
          (event.type === 'item.completed' || nextItem.status !== 'in_progress'
            ? nextItem.timestamp
            : existingItem?.type === 'tool_call'
              ? existingItem.completedAt
              : undefined),
      };
    }
    if (existingIndex >= 0) {
      draft.items[existingIndex] = nextItem;
    } else {
      draft.items.push(nextItem);
    }
    draft.timestamp = event.item.timestamp || timestamp;
    draft.isLive = true;
    return;
  }

  if (event.type === 'turn.completed') {
    const draft = ensureDraft();
    draft.timestamp = timestamp;
    draft.isLive = false;
    draft.isCompleted = true;
    return;
  }

  if (event.type === 'turn.failed') {
    const draft = ensureDraft();
    draft.timestamp = timestamp;
    draft.isLive = false;
    draft.isCompleted = true;
    draft.error = event.error;
  }
}

export async function persistTurnEventSnapshot(
  chatJid: string,
  drafts: Map<string, PersistedAssistantTurn>,
  event: AgentTurnEventPayload,
): Promise<PersistedAssistantTurn | undefined> {
  applyTurnEventToPersistenceDrafts(drafts, event);
  const draft = drafts.get(event.turnId);
  if (draft) {
    await storeAssistantTurnSnapshot(chatJid, draft, draft.timestamp);
  }
  return draft;
}

export function syncEphemeralSubagentRuntimesFromTurnEvent(
  groupFolder: string,
  chatJid: string,
  event: AgentTurnEventPayload,
): void {
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    clearEphemeralSubagentRuntimes({
      provider: 'claude',
      groupFolder,
      chatJid,
    });
    return;
  }

  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return;
  }

  const item = event.item;
  if (item.type !== 'tool_call' || item.subagentInfo?.provider !== 'claude') {
    return;
  }

  const runtimeId =
    item.subagentInfo.runtimeId?.trim() || `${event.turnId}:${item.id}`;
  const status = item.subagentInfo.status;
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'stopped'
  ) {
    removeEphemeralSubagentRuntime(runtimeId);
    return;
  }

  upsertEphemeralSubagentRuntime({
    id: runtimeId,
    provider: 'claude',
    mode: item.subagentInfo.mode || 'team',
    runtimeKind: item.subagentInfo.runtimeKind || 'ephemeral_snapshot',
    providerSessionId: item.subagentInfo.providerSessionId,
    parentRuntimeId: item.subagentInfo.parentRuntimeId,
    controllerSessionKey: item.subagentInfo.controllerSessionKey,
    requesterSessionKey: item.subagentInfo.requesterSessionKey,
    originTurnId: item.subagentInfo.originTurnId || event.turnId,
    originToolCallId: item.subagentInfo.originToolCallId || item.id,
    topologyRole: item.subagentInfo.topologyRole || item.subagentInfo.role,
    workProfile: item.subagentInfo.workProfile,
    role: item.subagentInfo.role,
    controlScope: item.subagentInfo.controlScope,
    groupFolder,
    chatJid,
    name: item.subagentInfo.agentName || t('errors.auto_6cb1ed', {}, undefined),
    task: item.subagentInfo.task || item.title,
    status,
    depth: item.subagentInfo.depth || 1,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    requestCount: item.subagentInfo.requestCount,
    lastError: item.errorText,
    lastResultPreview: item.resultText,
  });
}

export function finalizePersistedTurnForMessage(
  turn: PersistedAssistantTurn | undefined,
  messageId: string,
  timestamp: string,
  text: string,
): PersistedAssistantTurn | undefined {
  if (!turn) return undefined;

  const items = [...turn.items];
  const lastAssistantIndex = [...items]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => item.type === 'assistant_message')?.index;

  const nextAssistantItem: PersistedTurnItem = {
    id:
      lastAssistantIndex !== undefined
        ? items[lastAssistantIndex]!.id
        : `${turn.id}:attached-message:${messageId}`,
    type: 'assistant_message',
    status: 'completed',
    text,
    timestamp,
  };

  if (lastAssistantIndex !== undefined) {
    items[lastAssistantIndex] = nextAssistantItem;
  } else {
    items.push(nextAssistantItem);
  }

  return {
    ...turn,
    timestamp,
    items,
    isLive: false,
    isCompleted: true,
    persistedMessageId: messageId,
  };
}

export async function storeAndBroadcastBotReply(
  chatJid: string,
  text: string,
  turn?: PersistedAssistantTurn,
): Promise<{
  text: string;
  messageId: string;
  timestamp: string;
  runId?: string | undefined;
}> {
  const cleanText = sanitizeWebReply(chatJid, text);
  const msgId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = new Date().toISOString();
  const finalizedTurn = finalizePersistedTurnForMessage(
    turn,
    msgId,
    ts,
    cleanText,
  );
  const assistantName = await getAssistantName();
  const messagePayload = {
    id: msgId,
    chat_jid: chatJid,
    sender: assistantName,
    sender_name: assistantName,
    content: cleanText,
    timestamp: ts,
    run_id: finalizedTurn?.id,
    is_from_me: true,
    is_bot_message: true,
  };
  if (finalizedTurn) {
    await storeMessageDirectWithTurn(messagePayload, finalizedTurn);
  } else {
    await storeMessageDirect(messagePayload);
  }
  await persistBotReplyContextEntries(chatJid, messagePayload, finalizedTurn);
  const webCh = getWebChannel();
  if (webCh) {
    webCh.notifyMessage(chatJid, {
      id: msgId,
      content: cleanText,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      timestamp: ts,
      is_bot: true,
      is_from_me: true,
      run_id: finalizedTurn?.id,
      turn_id: finalizedTurn?.id,
    });
  }
  return {
    text: cleanText,
    messageId: msgId,
    timestamp: ts,
    runId: finalizedTurn?.id,
  };
}

function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

async function resolveActiveProvider(): Promise<'claude' | 'codex' | 'unknown'> {
  const provider = (
    (await getConfigValue('AI_PROVIDER')) || 'claude'
  )
    .trim()
    .toLowerCase();
  if (provider === 'claude' || provider === 'codex') return provider;
  return 'unknown';
}

async function buildUserContextEntry(
  group: RegisteredGroup,
  message: NewMessage,
): Promise<ContextEntryRecord> {
  return {
    id: `msg:${message.chat_jid}:${message.id}`,
    group_folder: group.folder,
    chat_jid: message.chat_jid,
    run_id: message.run_id || null,
    provider: await resolveActiveProvider(),
    role: 'user',
    source_type: 'chat_message',
    source_ref: message.id,
    content_text: message.content,
    content_json: JSON.stringify({
      sender: message.sender,
      sender_name: message.sender_name,
      client_id: message.client_id || null,
      uploaded_files: message.uploaded_files || [],
      is_from_me: !!message.is_from_me,
    }),
    token_estimate: estimateTokenCount(message.content),
    created_at: message.timestamp,
  };
}

export async function persistUserContextEntries(
  group: RegisteredGroup,
  messages: NewMessage[],
): Promise<void> {
  const entries = await Promise.all(
    messages.map((message) => buildUserContextEntry(group, message)),
  );
  await storeContextEntries(entries);
  autoPromoteMemoryFromEntries({
    groupFolder: group.folder,
    chatJid: messages[0]?.chat_jid || '',
    entries,
  });
  const chatJid = messages[0]?.chat_jid;
  if (chatJid) {
    scheduleContextCompaction({ chatJid, groupFolder: group.folder });
  }
}

async function persistBotReplyContextEntries(
  chatJid: string,
  message: {
    id: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    run_id?: string;
  },
  turn?: PersistedAssistantTurn,
): Promise<void> {
  const group =
    registeredGroups[chatJid] || (await syncRepoReviewConversationBinding(chatJid));
  if (!group) return;

  const entries: ContextEntryRecord[] = [
    {
      id: `msg:${chatJid}:${message.id}`,
      group_folder: group.folder,
      chat_jid: chatJid,
      run_id: message.run_id || null,
      provider: await resolveActiveProvider(),
      role: 'assistant',
      source_type: 'assistant_message',
      source_ref: message.id,
      content_text: message.content,
      content_json: JSON.stringify({
        sender: message.sender,
        sender_name: message.sender_name,
      }),
      token_estimate: estimateTokenCount(message.content),
      created_at: message.timestamp,
    },
  ];

  if (turn) {
    entries.push({
      id: `turn:${turn.id}`,
      group_folder: group.folder,
      chat_jid: chatJid,
      run_id: turn.id,
      provider: await resolveActiveProvider(),
      role: 'assistant',
      source_type: 'assistant_turn',
      source_ref: turn.id,
      content_text: message.content,
      content_json: JSON.stringify(turn),
      token_estimate: estimateTokenCount(message.content),
      created_at: turn.timestamp,
    });
  }

  await storeContextEntries(entries);
  scheduleContextCompaction({ chatJid, groupFolder: group.folder });
}

export async function syncRepoReviewConversationBinding(
  chatJid: string,
): Promise<RegisteredGroup | null> {
  const binding = await getRepoReviewConversationBinding(chatJid);
  if (!binding) {
    return registeredGroups[chatJid] || null;
  }
  const current = registeredGroups[chatJid];
  const defaultMode = normalizeAccessMode(
    await getConfigValue('DEFAULT_ACCESS_MODE'),
  );
  const currentAccessPolicy = resolveLegacyAccessPolicy(current?.agentConfig, {
    defaultMode,
  });
  const nextAccessPolicy = resolveLegacyAccessPolicy(binding.group.agentConfig, {
    defaultMode,
  });
  const bindingChanged =
    !current ||
    current.requiresTrigger !== false ||
    current.isMain === true ||
    !accessPoliciesEqual(currentAccessPolicy, nextAccessPolicy) ||
    current.agentConfig?.projectRoot !==
      binding.group.agentConfig?.projectRoot ||
    current.agentConfig?.workingDirectory !==
      binding.group.agentConfig?.workingDirectory ||
    current.agentConfig?.customInstructions !==
      binding.group.agentConfig?.customInstructions;
  const nextGroup: RegisteredGroup = current
    ? {
        ...current,
        requiresTrigger: false,
        isMain: false,
        agentConfig: {
          ...current.agentConfig,
          ...binding.group.agentConfig,
        },
      }
    : binding.group;
  registeredGroups[chatJid] = nextGroup;
  await setRegisteredGroup(chatJid, nextGroup);
  if (bindingChanged) {
    await resetConversationRuntime(chatJid, nextGroup.folder);
  }
  return nextGroup;
}

async function getDefaultAccessPolicyTemplate(): Promise<AccessPolicy> {
  let directories: string[] = [];
  try {
    directories = parseAllowedDirectoriesValue(
      await getConfigValue('allowed_directories'),
    );
  } catch {
    directories = [];
  }
  return {
    ...createDefaultAccessPolicy(
      normalizeAccessMode(await getConfigValue('DEFAULT_ACCESS_MODE')),
    ),
    directories,
  };
}

export async function getConversationAccessPolicy(
  jid: string,
): Promise<AccessPolicy> {
  const group = registeredGroups[jid];
  const defaultPolicy = await getDefaultAccessPolicyTemplate();
  if (!group) {
    return resolveEffectiveConversationAccessPolicy({
      defaultPolicy,
    });
  }
  return resolveEffectiveConversationAccessPolicy({
    defaultPolicy,
    conversationPolicy: resolveLegacyAccessPolicy(group.agentConfig, {
      defaultMode: defaultPolicy.mode,
    }),
  });
}

export async function resetConversationRuntime(
  jid: string,
  groupFolder?: string,
): Promise<void> {
  await deleteSessionByJid(jid);
  pendingUploadedFiles.delete(jid);
  deletePendingUploadsByChat(jid).catch((err) => {
    persistenceLog.debug({ err, jid }, 'Failed to delete pending uploads (non-critical)');
  });
  activeConversationTurnIds.delete(jid);
  if (groupFolder) {
    clearCodexConversationState(groupFolder);
  }
  queue.closeStdin(jid);
}
