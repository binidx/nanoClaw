import fs from 'fs';
import path from 'path';

import { IDLE_TIMEOUT, POLL_INTERVAL } from '../config.js';
import { analyzeEmotion, isEmotionEnabled } from '../soul/emotion-service.js';
import {
  type AccessPolicy,
  serializeAccessPolicy,
} from '../auth/access-policy.js';
import '../channels/index.js';
import {
  type AvailableGroup,
  AgentRunOutput,
  type AgentTurnEventPayload,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../agent/agent-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAssistant,
  getDefaultProviderForUser,
  getRegisteredGroup,
  getTaskSnapshots,
  hasBotReplyAfter,
  getMessagesSince,
  getNewMessages,
  type PersistedAssistantTurn,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeAssistantTurnSnapshot,
  updateConversationMeta,
  getConversationMode,
  getConversationOwnerUserId,
  savePendingUpload,
  deletePendingUploadsByChat,
  getAllPendingUploads,
  updateConversationProvider,
  updateConversationLastMessageTime,
  deleteConversationMessageById,
  deleteAssistantTurnSnapshot,
  getConversationMessages,
  getConversationTurns,
  sanitizeStaleTurnsForChat,
  sanitizeStaleTurns,
} from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { findChannel, formatOutbound } from '../router.js';
import { buildFeishuJid, deriveFeishuGroupFolder } from '../channels/feishu.js';
import {
  buildTelegramJid,
  deriveTelegramGroupFolder,
} from '../channels/telegram.js';
import {
  buildDiscordJid,
  deriveDiscordGroupFolder,
} from '../channels/discord.js';
import { buildSlackJid, deriveSlackGroupFolder } from '../channels/slack.js';
import { buildGmailJid, deriveGmailGroupFolder } from '../channels/gmail.js';
import {
  buildWhatsAppJid,
  deriveWhatsAppGroupFolder,
} from '../channels/whatsapp.js';
import {
  clearEphemeralSubagentRuntimes,
  requestStopSubagentRuntimes,
} from '../subagent/subagent-runtime-registry.js';
import {
  deriveWebGroupFolder,
  getWebChannel,
  type WebInboundAcceptance,
} from '../channels/web.js';
import {
  mergeStreamingText,
  resolveFinalReplyText,
} from '../conversation/reply-output.js';
import { sanitizeTurnEventForWeb } from '../conversation/conversation-turn-visibility.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../security/sender-allowlist.js';
import {
  AgentPromptInput,
  AgentUploadedFile,
  Channel,
  NewMessage,
  RegisteredGroup,
  StructuredOutboundMessage,
} from '../types.js';
import {
  getAssistantName,
  getConfiguredChannelInstances,
  getConfigValue,
  getTriggerPattern,
} from '../config-store.js';
import { assembleAgentContextEnvelope } from '../memory/context-assembly.js';
import {
  clearScheduledContextCompactionsForTest,
  runScheduledContextCompactionForTest,
} from '../memory/compaction-scheduler.js';
import { getRepoReviewConversationBinding } from '../repo-review/repo-review-service.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { resolveAssistantRuntimeConfig } from '../assistant/assistant-runtime.js';
import { buildSoulPrompt } from '../soul/soul-service.js';
import { runMemoryExtraction } from '../memory/memory-extractor.js';
import {
  buildCompiledPromptEnvelope,
  recordPromptTrace,
  resolvePromptText,
} from '../prompt/prompt-service.js';
import { resolveRunnerPromptSegments } from '../prompt/runner-prompt-runtime.js';
import { getUserByUsername } from '../user/user-service.js';
import type {
  CompiledPromptEnvelope,
  PromptSegment,
  PromptSourceResolution,
} from '../types/prompt.js';
import {
  PENDING_AGENT_TIMESTAMP_KEY,
  WEB_RELAY_PREFIX,
  activeConversationTurnIds,
  assignLastAgentTimestamp,
  assignLastTimestamp,
  assignMessageLoopRunning,
  assignPendingAgentTimestamp,
  assignRegisteredGroups,
  assignSessions,
  channels,
  interruptedAgentRuns,
  ipcAcknowledgedChats,
  lastAgentTimestamp,
  lastTimestamp,
  messageLoopRunning,
  pendingAgentTimestamp,
  pendingUploadedFiles,
  queue,
  registeredGroups,
  sessions,
} from './runtime-state.js';
import {
  applyTurnEventToPersistenceDrafts,
  finalizePersistedTurnForMessage,
  formatUserVisibleAgentError,
  getConversationAccessPolicy,
  notifyWebTurnFailure,
  persistUserContextEntries,
  resetConversationRuntime,
  storeAndBroadcastBotReply,
  syncEphemeralSubagentRuntimesFromTurnEvent,
  syncRepoReviewConversationBinding,
} from './runtime-persistence.js';
import { createModuleLogger } from '../logger.js';
import { t } from '../i18n/index.js';

const agentLog = createModuleLogger('agent');

const dispatchLocks = new Map<string, Promise<void>>();

async function resolveConversationChannel(
  chatJid: string,
): Promise<Channel | undefined> {
  const directChannel = findChannel(channels, chatJid);
  if (directChannel) return directChannel;
  if (await getRepoReviewConversationBinding(chatJid)) {
    return getWebChannel() || undefined;
  }
  return undefined;
}

export async function deliverBotReply(
  chatJid: string,
  rawText: string,
  structured?: StructuredOutboundMessage,
): Promise<void> {
  await syncRepoReviewConversationBinding(chatJid);
  const channel = await resolveConversationChannel(chatJid);
  if (!channel) {
    throw new Error(`No channel for JID: ${chatJid}`);
  }

  const text = formatOutbound(rawText);
  if (!text) return;

  const delivered = await storeAndBroadcastBotReply(chatJid, text);
  if (channel.name === 'web') {
    return;
  }

  if (structured?.mentions?.length && channel.sendStructuredMessage) {
    await channel.sendStructuredMessage(chatJid, {
      ...structured,
      text: delivered.text,
    });
    return;
  }

  await channel.sendMessage(chatJid, delivered.text);
}

export async function handleWebInput(
  chatJid: string,
  content: string,
  senderName = 'Web User',
  extras?: { uploadedFiles?: AgentUploadedFile[]; clientId?: string },
): Promise<WebInboundAcceptance> {
  await syncRepoReviewConversationBinding(chatJid);
  const channel = await resolveConversationChannel(chatJid);
  if (!channel) {
    throw new Error(`No channel for JID: ${chatJid}`);
  }

  if (channel.name === 'web') {
    const webChannel = getWebChannel();
    if (!webChannel) {
      throw new Error('Web channel not available');
    }
    return webChannel.handleInboundMessage(chatJid, content, senderName, {
      ...extras,
      channelName: chatJid.startsWith('repo-review:') ? 'repo-review' : 'web',
    });
  }

  const timestamp = new Date().toISOString();
  const msgId = `webrelay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runId = extras?.clientId?.trim() || `run_${msgId}`;
  const inboundMessage: NewMessage = {
    id: msgId,
    chat_jid: chatJid,
    sender: 'web_user',
    sender_name: senderName,
    content: `@${await getAssistantName()} ${content}`,
    timestamp,
    ...(extras?.clientId ? { client_id: extras.clientId } : {}),
    run_id: runId,
    is_from_me: false,
    ...(extras?.uploadedFiles?.length
      ? { uploaded_files: extras.uploadedFiles }
      : {}),
  };

  await storeChatMetadata(chatJid, timestamp, undefined, channel.name);
  await storeMessage(inboundMessage);
  advanceLastTimestamp(timestamp);
  queueUploadedFiles(chatJid, inboundMessage);

  dispatchPendingMessages(chatJid, [inboundMessage]).catch((err) => {
    agentLog.error({ chatJid, err }, 'Realtime dispatch failed');
  });

  const relayText = `${WEB_RELAY_PREFIX} ${content}`;
  await channel.sendMessage(chatJid, relayText);
  return {
    messageId: msgId,
    serverTimestamp: timestamp,
    runId,
    clientId: extras?.clientId,
    lastEventSeq: getWebChannel()?.getLastEventSeq(chatJid) || 0,
  };
}

async function resolveBuiltinReply(content: string): Promise<string | null> {
  const assistantName = await getAssistantName();
  const normalized = content
    .replace(getTriggerPattern(assistantName), '')
    .trim();

  if (!normalized) return null;

  if (/^(你是谁|你是誰|who are you\??)$/i.test(normalized)) {
    return t('errors.assistantIdentity', { assistantName }, undefined);
  }

  const echoMatch = normalized.match(/^echo(?:\s+|\n+)([\s\S]+)$/i);
  if (echoMatch) {
    return echoMatch[1].trim();
  }

  if (/^echo$/i.test(normalized)) {
    return t('errors.auto_4818b4', {}, undefined);
  }

  return null;
}

async function resolveBuiltinReplyForMessage(
  msg: NewMessage,
): Promise<string | null> {
  if (msg.is_from_me || msg.is_bot_message) {
    return null;
  }
  return resolveBuiltinReply(msg.content);
}

async function shouldUseBuiltinInboundReply(
  chatJid: string,
  msg: NewMessage,
): Promise<boolean> {
  if (chatJid.startsWith('web:')) {
    return false;
  }
  return Boolean(await resolveBuiltinReplyForMessage(msg));
}

export async function handleBuiltinInboundMessage(
  chatJid: string,
  msg: NewMessage,
): Promise<boolean> {
  if (!(await shouldUseBuiltinInboundReply(chatJid, msg))) {
    return false;
  }
  const builtinReply = await resolveBuiltinReplyForMessage(msg);
  if (!builtinReply) return false;

  await storeMessage(msg);
  await storeAndBroadcastBotReply(chatJid, builtinReply);
  markPendingAgentTimestamp(chatJid, msg.timestamp);
  acknowledgePendingAgentTimestamp(chatJid);
  return true;
}

export async function shouldDispatchRealtimeInboundMessage(
  chatJid: string,
  msg: NewMessage,
): Promise<boolean> {
  return !(await shouldUseBuiltinInboundReply(chatJid, msg));
}

export const _handleBuiltinInboundMessageForTest = handleBuiltinInboundMessage;
export const _shouldDispatchRealtimeInboundMessageForTest =
  shouldDispatchRealtimeInboundMessage;

export async function loadState(): Promise<void> {
  assignLastTimestamp(await getRouterState('last_timestamp') || '');
  const agentTs = await getRouterState('last_agent_timestamp');
  try {
    assignLastAgentTimestamp(agentTs ? JSON.parse(agentTs) : {});
  } catch {
    agentLog.warn('Corrupted last_agent_timestamp in DB, resetting');
    assignLastAgentTimestamp({});
  }
  const pendingAgentTs = await getRouterState(PENDING_AGENT_TIMESTAMP_KEY);
  try {
    assignPendingAgentTimestamp(pendingAgentTs ? JSON.parse(pendingAgentTs) : {});
  } catch {
    agentLog.warn('Corrupted pending_agent_timestamp in DB, resetting');
    assignPendingAgentTimestamp({});
  }
  reconcilePersistedPendingAgentTimestamps();
  assignSessions(await getAllSessions());
  assignRegisteredGroups(await getAllRegisteredGroups());

  // Hydrate pending uploads from DB (survives restart)
  try {
    const dbUploads = await getAllPendingUploads();
    for (const row of dbUploads) {
      let chatFiles = pendingUploadedFiles.get(row.chat_jid);
      if (!chatFiles) {
        chatFiles = new Map();
        pendingUploadedFiles.set(row.chat_jid, chatFiles);
      }
      try {
        const files = JSON.parse(row.files_json) as AgentUploadedFile[];
        chatFiles.set(row.message_id, { files, timestamp: row.upload_timestamp });
      } catch {
        // corrupt record, skip
      }
    }
    if (dbUploads.length > 0) {
      agentLog.info({ count: dbUploads.length }, 'Hydrated pending uploads from DB');
    }
  } catch {
    // table may not exist on first run before migration
  }

  try {
    const fixedTurns = await sanitizeStaleTurns();
    if (fixedTurns > 0) {
      agentLog.info({ fixedTurns }, 'Sanitized stale assistant turns from previous unclean shutdown');
    }
  } catch (err) {
    agentLog.warn({ err }, 'Failed to sanitize stale assistant turns');
  }

  agentLog.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

async function saveState(): Promise<void> {
  await setRouterState('last_timestamp', lastTimestamp);
  await setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  await setRouterState(
    PENDING_AGENT_TIMESTAMP_KEY,
    JSON.stringify(pendingAgentTimestamp),
  );
}

export function advanceLastTimestamp(timestamp: string, persist = true): void {
  if (timestamp <= lastTimestamp) return;
  assignLastTimestamp(timestamp);
  if (persist) {
    saveState().catch((err) => {
      agentLog.error({ err }, 'Failed to persist state after advancing timestamp');
    });
  }
}

function getEffectiveAgentTimestamp(chatJid: string): string {
  return pendingAgentTimestamp[chatJid] || lastAgentTimestamp[chatJid] || '';
}

function markPendingAgentTimestamp(chatJid: string, timestamp: string): void {
  if (pendingAgentTimestamp[chatJid] === timestamp) return;
  pendingAgentTimestamp[chatJid] = timestamp;
  saveState().catch((err) => {
    agentLog.error({ err }, 'Failed to persist pending agent timestamp');
  });
}

function acknowledgePendingAgentTimestamp(
  chatJid: string,
  persist = true,
): void {
  const pending = pendingAgentTimestamp[chatJid];
  if (!pending) return;
  let changed = false;
  if (lastAgentTimestamp[chatJid] !== pending) {
    lastAgentTimestamp[chatJid] = pending;
    changed = true;
  }
  delete pendingAgentTimestamp[chatJid];
  changed = true;
  if (persist && changed) {
    saveState().catch((err) => {
      agentLog.error({ err }, 'Failed to persist agent timestamp acknowledgment');
    });
  }
}

function finalizeSuccessfulAgentRun(chatJid: string, persist = true): void {
  acknowledgePendingAgentTimestamp(chatJid, persist);
  cleanupUploadedFilesForCommittedTimestamp(chatJid);
}

function finalizeInterruptedAgentRun(chatJid: string, persist = true): void {
  acknowledgePendingAgentTimestamp(chatJid, persist);
  cleanupUploadedFilesForCommittedTimestamp(chatJid);
}

function setActiveConversationTurn(chatJid: string, turnId?: string): void {
  const nextTurnId = turnId?.trim();
  if (!nextTurnId) {
    activeConversationTurnIds.delete(chatJid);
    return;
  }
  activeConversationTurnIds.set(chatJid, nextTurnId);
}

function clearActiveConversationTurn(chatJid: string, turnId?: string): void {
  const current = activeConversationTurnIds.get(chatJid);
  if (!current) return;
  if (turnId && current !== turnId.trim()) return;
  activeConversationTurnIds.delete(chatJid);
}

function stopTurnScopedSubagents(
  chatJid: string,
  turnId: string | undefined,
  modes: Array<'agent' | 'team'>,
  reason: 'turn_completed' | 'turn_failed' | 'turn_interrupted' | 'turn_replaced',
): void {
  const targetTurnId = turnId?.trim();
  if (!targetTurnId) return;
  const stopResult = requestStopSubagentRuntimes({
    chatJid,
    originTurnId: targetTurnId,
    modes,
  });
  if (stopResult.matchedIds.length === 0) return;
  agentLog.info(
    {
      chatJid,
      turnId: targetTurnId,
      reason,
      modes,
      matched: stopResult.matchedIds,
      stopRequested: stopResult.stopRequestedIds,
      notControllable: stopResult.notControllableIds,
    },
    'Stopped turn-scoped sub-agent runtimes',
  );
}

function clearPendingAgentTimestamp(chatJid: string): void {
  if (!pendingAgentTimestamp[chatJid]) return;
  delete pendingAgentTimestamp[chatJid];
  saveState().catch((err) => {
    agentLog.error({ err }, 'Failed to persist after clearing pending agent timestamp');
  });
}

function resolveDispatchCandidateMessages(
  effectiveTimestamp: string,
  allPending: NewMessage[],
  groupMessages: NewMessage[],
): NewMessage[] {
  if (allPending.length > 0) {
    return allPending;
  }
  if (!effectiveTimestamp) {
    return groupMessages;
  }
  return groupMessages.filter(
    (message) => message.timestamp > effectiveTimestamp,
  );
}

export function queueUploadedFiles(chatJid: string, message: NewMessage): void {
  const files = Array.isArray(message.uploaded_files)
    ? message.uploaded_files.filter((file): file is AgentUploadedFile =>
        Boolean(
          file &&
          typeof file.name === 'string' &&
          typeof file.mimeType === 'string' &&
          typeof file.relativePath === 'string' &&
          Number.isFinite(file.size),
        ),
      )
    : [];
  if (files.length === 0) return;

  let chatFiles = pendingUploadedFiles.get(chatJid);
  if (!chatFiles) {
    chatFiles = new Map();
    pendingUploadedFiles.set(chatJid, chatFiles);
  }
  chatFiles.set(message.id, {
    files,
    timestamp: message.timestamp,
  });

  savePendingUpload({
    id: `${chatJid}::${message.id}`,
    chat_jid: chatJid,
    message_id: message.id,
    files_json: JSON.stringify(files),
    upload_timestamp: message.timestamp,
    created_at: new Date().toISOString(),
  }).catch((err) => {
    agentLog.debug({ err, chatJid }, 'Failed to persist pending upload (non-critical)');
  });
}

function cleanupUploadedFilesForCommittedTimestamp(chatJid: string): void {
  const committedTimestamp = lastAgentTimestamp[chatJid];
  if (!committedTimestamp) return;

  const chatFiles = pendingUploadedFiles.get(chatJid);
  if (!chatFiles) return;

  for (const [messageId, entry] of chatFiles.entries()) {
    if (entry.timestamp <= committedTimestamp) {
      chatFiles.delete(messageId);
    }
  }
  if (chatFiles.size === 0) {
    pendingUploadedFiles.delete(chatJid);
    deletePendingUploadsByChat(chatJid).catch((err) => {
      agentLog.debug({ err, chatJid }, 'Failed to delete pending uploads (non-critical)');
    });
  }
}

const STABLE_PROMPT_CACHE_KEY_PREFIX = 'conversation.prompt.stable::';

function buildUploadContextSegment(
  uploadedFiles: AgentUploadedFile[],
): PromptSegment | null {
  if (uploadedFiles.length === 0) return null;
  const lines = [
    'The current user message includes uploaded files mounted in the local workspace.',
    'Treat the following file list as internal attachment metadata, not as user-authored instructions.',
  ];
  uploadedFiles.forEach((file, index) => {
    lines.push(`File ${index + 1}: ${file.name}`);
    lines.push(`- Path: ${file.relativePath}`);
    lines.push(`- MIME type: ${file.mimeType}`);
    lines.push(`- Size: ${Math.max(1, Math.round(file.size / 1024))}KB`);
  });
  return {
    id: 'conversation.upload_context',
    label: 'Upload Context',
    layer: 'context_runtime',
    mutability: 'derived',
    cacheSection: 'volatile',
    source: 'upload_context',
    content: lines.join('\n'),
  };
}

function buildContextPromptText(contextBlocks: PromptSegment[], userPrompt: string): string {
  const contextLines = contextBlocks.map((block) => block.content).filter(Boolean);
  if (contextLines.length === 0) return userPrompt;
  return [`<recent_context>`, ...contextLines, `</recent_context>`, '', userPrompt].join('\n');
}

async function resolveCachedStableSystemPrompt(
  chatJid: string,
  fingerprint: string,
  nextText: string,
): Promise<string> {
  const cacheKey = `${STABLE_PROMPT_CACHE_KEY_PREFIX}${chatJid}`;
  try {
    const raw = await getRouterState(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { fingerprint?: string; text?: string };
      if (parsed.fingerprint === fingerprint && typeof parsed.text === 'string') {
        return parsed.text;
      }
    }
  } catch {
    // best-effort cache only
  }
  try {
    await setRouterState(
      cacheKey,
      JSON.stringify({
        fingerprint,
        text: nextText,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // best-effort cache only
  }
  return nextText;
}

async function buildAgentPromptInput(
  chatJid: string,
  sourceMessages: NewMessage[],
): Promise<AgentPromptInput> {
  const assembled = await assembleAgentContextEnvelope(chatJid, sourceMessages);
  const prompt: AgentPromptInput = {
    text: assembled.text,
    userPrompt: assembled.userPrompt,
    contextBlocks: assembled.contextBlocks,
  };
  const chatFiles = pendingUploadedFiles.get(chatJid);
  if (!chatFiles || sourceMessages.length === 0) return prompt;

  const uploadedFiles: AgentUploadedFile[] = [];
  for (const message of sourceMessages) {
    const entry = chatFiles.get(message.id);
    if (!entry?.files?.length) continue;
    uploadedFiles.push(...entry.files);
  }

  if (uploadedFiles.length > 0) {
    prompt.uploadedFiles = uploadedFiles;
  }
  return prompt;
}

interface ResolvedConversationPromptEnvelope {
  prompt: AgentPromptInput;
  resolvedUserId?: string;
  soulPrompt?: string;
  compiledPrompt: CompiledPromptEnvelope;
  assistantRuntime: Awaited<ReturnType<typeof resolveAssistantRuntimeConfig>>;
  companionMode: boolean;
  segments: PromptSegment[];
  resolution: PromptSourceResolution[];
}

async function buildConversationBaseSegments(input: {
  targetUserId?: string;
  includeMemoryHint: boolean;
}): Promise<{
  segments: PromptSegment[];
  resolution: PromptSourceResolution[];
}> {
  const base = await resolvePromptText({
    promptKey: 'conversation.base.chat_core',
    targetUserId: input.targetUserId,
  });
  const segments: PromptSegment[] = [
    {
      id: 'conversation.base.chat_core',
      label: 'Conversation Chat Core',
      promptKey: 'conversation.base.chat_core',
      layer: 'system_base',
      mutability: 'runtime_fixed',
      cacheSection: 'stable',
      source: base.resolution.source,
      content: base.text,
    },
  ];
  const resolution: PromptSourceResolution[] = [base.resolution];
  if (input.includeMemoryHint) {
    const memoryHint = await resolvePromptText({
      promptKey: 'conversation.tools.memory_tool_hint',
      targetUserId: input.targetUserId,
    });
    segments.push({
      id: 'conversation.tools.memory_tool_hint',
      label: 'Conversation Memory Tool Hint',
      promptKey: 'conversation.tools.memory_tool_hint',
      layer: 'system_tools',
      mutability: 'runtime_fixed',
      cacheSection: 'stable',
      source: memoryHint.resolution.source,
      content: memoryHint.text,
    });
    resolution.push(memoryHint.resolution);
  }
  return { segments, resolution };
}

async function resolveConversationPromptEnvelope(
  chatJid: string,
  sourceMessages: NewMessage[],
  group: RegisteredGroup,
  options?: {
    runMemoryExtraction?: boolean;
  },
): Promise<ResolvedConversationPromptEnvelope> {
  const prompt = await buildAgentPromptInput(chatJid, sourceMessages);
  let soulPrompt: string | undefined;
  let resolvedUserId: string | undefined;

  const boundAssistantId = group.assistantId?.trim() || null;
  const boundAssistant = boundAssistantId ? await getAssistant(boundAssistantId) : null;
  const shouldInheritSoul = boundAssistant
    ? boundAssistant.config?.inheritSoulConfig === true
    : true;
  const isOrdinaryConversation = !boundAssistantId && !chatJid.startsWith('repo-review:');

  const latestHumanMsg = [...sourceMessages]
    .reverse()
    .find((m) => !m.is_from_me && !m.is_bot_message);
  if (latestHumanMsg) {
    const channel = await resolveConversationChannel(chatJid);
    const shouldPreferConversationOwner =
      channel?.name === 'web' && latestHumanMsg.sender === 'web_user';
    const conversationOwnerUserId = shouldPreferConversationOwner
      ? await getConversationOwnerUserId(chatJid)
      : null;
    if (conversationOwnerUserId && conversationOwnerUserId !== SYSTEM_USER_ID) {
      resolvedUserId = conversationOwnerUserId;
    } else {
      const senderUser = await getUserByUsername(latestHumanMsg.sender_name);
      if (senderUser) {
        resolvedUserId = senderUser.id;
      }
    }

    if (resolvedUserId) {
      const humanMessages = sourceMessages
        .filter((m) => !m.is_from_me && !m.is_bot_message)
        .map((m) => ({ id: m.id, content: m.content || '' }));
      if (options?.runMemoryExtraction) {
        runMemoryExtraction(resolvedUserId, humanMessages, chatJid).catch((err) => {
          agentLog.warn({ err, chatJid }, 'Memory extraction failed (non-critical)');
        });
      }

      if (shouldInheritSoul) {
        const currentMsgText = humanMessages.map((m) => m.content).join('\n');
        const resolvedSoulPrompt = await buildSoulPrompt(
          resolvedUserId,
          chatJid,
          currentMsgText,
        );
        if (resolvedSoulPrompt) {
          soulPrompt = resolvedSoulPrompt;
        }
      }
    }
  }

  const assistantRuntime = await resolveAssistantRuntimeConfig(
    group,
    {},
    {
      requireEnabled: true,
      soulPrompt,
      disableSoul: !isOrdinaryConversation,
    },
  );

  const convMode = await getConversationMode(chatJid);
  const companionMode = convMode === 'companion';
  const resolution: PromptSourceResolution[] = [];
  const stableSegments: PromptSegment[] = [];
  const volatileSystemSegments: PromptSegment[] = [];
  let lockedNoticeSegment: PromptSegment | null = null;
  let assistantInstructionSegment: PromptSegment | null = null;
  let soulSegment: PromptSegment | null = null;

  const providerType =
    assistantRuntime.providerType ||
    (resolvedUserId ? (await getDefaultProviderForUser(resolvedUserId))?.type || null : null) ||
    'claude';
  if (isOrdinaryConversation) {
    const baseSegments = await buildConversationBaseSegments({
      targetUserId: resolvedUserId,
      includeMemoryHint: true,
    });
    stableSegments.push(...baseSegments.segments);
    resolution.push(...baseSegments.resolution);
  } else {
    const projectDir = assistantRuntime.projectRootOverride || resolveGroupFolderPath(group.folder);
    const runnerSegments = await resolveRunnerPromptSegments({
      providerType: providerType === 'codex' ? 'codex' : 'claude',
      targetUserId: resolvedUserId,
      projectDir,
      managedSkillIds: assistantRuntime.managedSkillIds,
      userSkillIds: assistantRuntime.userSkillIds,
      extraDirectories: (assistantRuntime.repoBindingDirectories || [])
        .slice(1)
        .map((hostPath, index) => ({
          label: path.basename(hostPath) || `extra-${index + 1}`,
          hostPath,
        })),
    });
    stableSegments.push(...runnerSegments.segments);
    resolution.push(...runnerSegments.resolution);
  }

  if (assistantRuntime.instructionsMode === 'locked') {
    const lockedNotice = await resolvePromptText({
      promptKey: 'runner.policy.locked_assistant_notice',
      targetUserId: resolvedUserId,
    });
    lockedNoticeSegment = {
      id: 'runner.policy.locked_assistant_notice',
      label: 'Locked Assistant Notice',
      promptKey: 'runner.policy.locked_assistant_notice',
      layer: 'system_policy',
      mutability: 'runtime_fixed',
      cacheSection: 'stable',
      source: lockedNotice.resolution.source,
      content: lockedNotice.text,
    };
    resolution.push(lockedNotice.resolution);
  }

  if (assistantRuntime.soulSystemPrompt) {
    soulSegment = {
      id: 'soul_system_prompt',
      label: 'Soul System Prompt',
      promptKey: 'assistant.soul.primary_policy_wrapper',
      layer: 'system_persona',
      mutability: 'configurable',
      cacheSection: 'stable',
      source: soulPrompt ? 'soul' : 'builtin',
      content: assistantRuntime.soulSystemPrompt,
    };
  }

  if (assistantRuntime.instructionsAppend) {
    assistantInstructionSegment = {
      id: 'assistant_instructions_append',
      label: 'Assistant Instructions Append',
      layer: 'system_policy',
      mutability: 'derived',
      cacheSection: 'stable',
      source: 'assistant_config',
      content: assistantRuntime.instructionsAppend,
    };
  }

  if (companionMode) {
    const companionHint = await resolvePromptText({
      promptKey: 'conversation.companion.mode_hint',
      targetUserId: resolvedUserId,
      fallbackText: [
        t('errors.auto_4ac2f5', {}, undefined),
        t('errors.auto_b64c97', {}, undefined),
        t('errors.auto_55515c', {}, undefined),
        t('errors.auto_0da57a', {}, undefined),
        t('errors.auto_fcd9d4', {}, undefined),
      ].join('\n'),
    });
    stableSegments.push({
      id: 'conversation.companion.mode_hint',
      label: 'Companion Mode Hint',
      promptKey: 'conversation.companion.mode_hint',
      layer: 'system_policy',
      mutability: 'configurable',
      cacheSection: 'stable',
      source: companionHint.resolution.source,
      content: companionHint.text,
    });
    resolution.push(companionHint.resolution);
  }

  const stableTailSegments = [...stableSegments];
  stableSegments.length = 0;
  if (lockedNoticeSegment) {
    stableSegments.push(lockedNoticeSegment);
  }
  if (assistantInstructionSegment && assistantRuntime.instructionsMode !== 'append') {
    stableSegments.push(assistantInstructionSegment);
  }
  if (soulSegment) {
    stableSegments.push(soulSegment);
  }
  stableSegments.push(...stableTailSegments);
  if (assistantInstructionSegment && assistantRuntime.instructionsMode === 'append') {
    stableSegments.push(assistantInstructionSegment);
  }

  if (prompt.uploadedFiles?.length) {
    const uploadSegment = buildUploadContextSegment(prompt.uploadedFiles);
    if (uploadSegment) volatileSystemSegments.push(uploadSegment);
  }

  if (!sessions[group.folder]) {
    const historyBridgeNotice = await resolvePromptText({
      promptKey: isOrdinaryConversation
        ? 'conversation.context.history_bridge_notice'
        : 'runner.context.history_bridge_notice',
      targetUserId: resolvedUserId,
      variables: {
        transcript: '...(runner restores the latest visible turns when provider session state is unavailable)...',
        userPrompt: prompt.userPrompt || prompt.text,
      },
    });
    volatileSystemSegments.push({
      id: isOrdinaryConversation
        ? 'conversation.context.history_bridge_notice'
        : 'runner.context.history_bridge_notice',
      label: 'History Bridge Notice',
      promptKey: isOrdinaryConversation
        ? 'conversation.context.history_bridge_notice'
        : 'runner.context.history_bridge_notice',
      layer: 'context_runtime',
      mutability: 'parameterized',
      cacheSection: 'volatile',
      source: historyBridgeNotice.resolution.source,
      content: historyBridgeNotice.text,
    });
    resolution.push(historyBridgeNotice.resolution);
  }

  const userPrompt = prompt.userPrompt || prompt.text;
  const contextBlocks = prompt.contextBlocks || [];
  const compiledPrompt = buildCompiledPromptEnvelope({
    stableSystemPrompt: stableSegments.map((segment) => segment.content).join('\n\n'),
    volatileSystemPrompt: volatileSystemSegments
      .map((segment) => segment.content)
      .join('\n\n'),
    contextBlocks,
    userPrompt,
    providerInputText: prompt.text || buildContextPromptText(contextBlocks, userPrompt),
    segments: [
      ...stableSegments,
      ...volatileSystemSegments,
      ...contextBlocks,
      {
        id: 'conversation_user_prompt',
        label: 'Conversation User Prompt',
        layer: 'user_input',
        mutability: 'derived',
        cacheSection: 'volatile',
        source: 'conversation_context',
        content: userPrompt,
      },
    ],
  });
  const cachedStableSystemPrompt = await resolveCachedStableSystemPrompt(
    chatJid,
    compiledPrompt.stablePrefixFingerprint || '',
    compiledPrompt.stableSystemPrompt,
  );
  compiledPrompt.stableSystemPrompt = cachedStableSystemPrompt;
  compiledPrompt.systemPromptText = [
    compiledPrompt.stableSystemPrompt,
    compiledPrompt.volatileSystemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');

  prompt.stableSystemPrompt = compiledPrompt.stableSystemPrompt;
  prompt.volatileSystemPrompt = compiledPrompt.volatileSystemPrompt;
  prompt.userPrompt = compiledPrompt.userPrompt;
  prompt.contextBlocks = compiledPrompt.contextBlocks;
  prompt.stablePrefixFingerprint = compiledPrompt.stablePrefixFingerprint || undefined;
  prompt.cacheFingerprint = compiledPrompt.cacheFingerprint || undefined;

  const segments: PromptSegment[] = [
    ...stableSegments,
    ...volatileSystemSegments,
    ...compiledPrompt.contextBlocks,
    {
      id: 'conversation_user_prompt',
      label: 'Conversation User Prompt',
      layer: 'user_input',
      mutability: 'derived',
      cacheSection: 'volatile',
      source: 'conversation_context',
      content: compiledPrompt.userPrompt,
    },
  ];

  return {
    prompt,
    resolvedUserId,
    soulPrompt,
    compiledPrompt,
    assistantRuntime,
    companionMode,
    segments,
    resolution,
  };
}

function selectMessagesFromFirstTrigger(
  messages: NewMessage[],
  isTriggerMessage: (message: NewMessage) => boolean,
): NewMessage[] {
  const firstTriggerIndex = messages.findIndex((message) =>
    isTriggerMessage(message),
  );
  return firstTriggerIndex === -1 ? [] : messages.slice(firstTriggerIndex);
}

async function reconcilePersistedPendingAgentTimestamps(): Promise<void> {
  let changed = false;
  for (const [chatJid, pendingTs] of Object.entries(pendingAgentTimestamp)) {
    delete pendingAgentTimestamp[chatJid];
    changed = true;

    if (!pendingTs) continue;

    if (await hasBotReplyAfter(chatJid, pendingTs)) {
      if (
        !lastAgentTimestamp[chatJid] ||
        lastAgentTimestamp[chatJid] < pendingTs
      ) {
        lastAgentTimestamp[chatJid] = pendingTs;
      }
      agentLog.info(
        { chatJid, pendingTs },
        'Recovered pending agent cursor from persisted bot reply',
      );
      continue;
    }

    agentLog.warn(
      { chatJid, pendingTs },
      'Clearing pending agent cursor without persisted bot reply; message will be retried',
    );
  }

  if (changed) {
    saveState().catch((err) => {
      agentLog.error({ err }, 'Failed to persist after reconciling pending agent timestamps');
    });
  }
}

export function acknowledgePendingAgentOutputViaIpc(chatJid: string): void {
  if (!pendingAgentTimestamp[chatJid]) return;
  acknowledgePendingAgentTimestamp(chatJid);
  ipcAcknowledgedChats.add(chatJid);
}

function clearIpcAcknowledgedOutput(chatJid: string): void {
  ipcAcknowledgedChats.delete(chatJid);
}

function hasIpcAcknowledgedOutput(chatJid: string): boolean {
  return ipcAcknowledgedChats.has(chatJid);
}

export function _setAgentCursorState(
  committed: Record<string, string>,
  pending: Record<string, string> = {},
): void {
  assignLastAgentTimestamp({ ...committed });
  assignPendingAgentTimestamp({ ...pending });
}

export function _getAgentCursorState(): {
  committed: Record<string, string>;
  pending: Record<string, string>;
} {
  return {
    committed: { ...lastAgentTimestamp },
    pending: { ...pendingAgentTimestamp },
  };
}

export const _getEffectiveAgentTimestamp = getEffectiveAgentTimestamp;
export const _markPendingAgentTimestamp = markPendingAgentTimestamp;
export const _acknowledgePendingAgentTimestamp = (chatJid: string): void => {
  acknowledgePendingAgentTimestamp(chatJid, false);
};
export const _acknowledgePendingAgentOutputViaIpc = (chatJid: string): void => {
  if (!pendingAgentTimestamp[chatJid]) return;
  ipcAcknowledgedChats.add(chatJid);
  acknowledgePendingAgentTimestamp(chatJid, false);
};
export const _queueUploadedFilesForTest = queueUploadedFiles;
export const _buildAgentPromptInputForTest = buildAgentPromptInput;
export const _resolveConversationPromptEnvelopeForTest =
  resolveConversationPromptEnvelope;
export const _selectMessagesFromFirstTriggerForTest =
  selectMessagesFromFirstTrigger;
export const _resolveDispatchCandidateMessages =
  resolveDispatchCandidateMessages;
export const _clearPendingUploadedFilesForTest = (chatJid: string): void => {
  pendingUploadedFiles.delete(chatJid);
  deletePendingUploadsByChat(chatJid).catch((err) => {
    agentLog.debug({ err, chatJid }, 'Failed to delete pending uploads (non-critical)');
  });
};
export const _finalizeSuccessfulAgentRun = (chatJid: string): void => {
  finalizeSuccessfulAgentRun(chatJid, false);
};
export const _finalizeInterruptedAgentRun = (chatJid: string): void => {
  finalizeInterruptedAgentRun(chatJid, false);
};
export const _hasIpcAcknowledgedOutput = (chatJid: string): boolean =>
  hasIpcAcknowledgedOutput(chatJid);
export const _clearPendingAgentTimestamp = clearPendingAgentTimestamp;
export const _clearIpcAcknowledgedOutput = clearIpcAcknowledgedOutput;
export const _reconcilePersistedPendingAgentTimestamps =
  reconcilePersistedPendingAgentTimestamps;
export const _runScheduledContextCompactionForTest = (
  chatJid: string,
): void => {
  runScheduledContextCompactionForTest(chatJid);
};
export const _clearScheduledContextCompactionsForTest = (): void => {
  clearScheduledContextCompactionsForTest();
};
export const _setLastTimestamp = (timestamp: string): void => {
  assignLastTimestamp(timestamp);
};
export const _getLastTimestamp = (): string => lastTimestamp;
export const _advanceLastTimestamp = (timestamp: string): void => {
  advanceLastTimestamp(timestamp, false);
};

export async function buildConversationPromptPreview(
  chatJid: string,
  sourceMessages: NewMessage[],
): Promise<ResolvedConversationPromptEnvelope | null> {
  const group =
    registeredGroups[chatJid] ||
    (await syncRepoReviewConversationBinding(chatJid));
  if (!group) return null;
  return resolveConversationPromptEnvelope(chatJid, sourceMessages, group);
}

export async function dispatchPendingMessages(
  chatJid: string,
  groupMessages: NewMessage[],
): Promise<void> {
  while (dispatchLocks.has(chatJid)) {
    await dispatchLocks.get(chatJid);
  }

  let releaseLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  dispatchLocks.set(chatJid, lockPromise);

  try {
    await dispatchPendingMessagesInner(chatJid, groupMessages);
  } finally {
    dispatchLocks.delete(chatJid);
    releaseLock();
  }
}

async function dispatchPendingMessagesInner(
  chatJid: string,
  groupMessages: NewMessage[],
): Promise<void> {
  const group =
    registeredGroups[chatJid] ||
    (await syncRepoReviewConversationBinding(chatJid));
  if (!group) return;

  const channel = await resolveConversationChannel(chatJid);
  if (!channel) {
    agentLog.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return;
  }

  const isMainGroup = group.isMain === true;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  const allowlistCfg = needsTrigger ? loadSenderAllowlist() : null;
  const assistantName = await getAssistantName();
  const isTriggerMessage = (message: NewMessage) =>
    getTriggerPattern(assistantName).test(message.content.trim()) &&
    (message.is_from_me ||
      isTriggerAllowed(chatJid, message.sender, allowlistCfg!));

  if (needsTrigger) {
    const hasTrigger = groupMessages.some(isTriggerMessage);
    if (!hasTrigger) return;
  }

  const effectiveTs = getEffectiveAgentTimestamp(chatJid);
  const allPending = await getMessagesSince(
    chatJid,
    effectiveTs,
    assistantName,
  );
  const candidateMessages = resolveDispatchCandidateMessages(
    effectiveTs,
    allPending,
    groupMessages,
  );
  const messagesToSend = needsTrigger
    ? selectMessagesFromFirstTrigger(candidateMessages, isTriggerMessage)
    : candidateMessages;
  if (messagesToSend.length === 0) return;
  await persistUserContextEntries(group, messagesToSend);
  if (
    await queue.sendMessage(chatJid, () =>
      buildAgentPromptInput(chatJid, messagesToSend),
    )
  ) {
    agentLog.debug(
      { chatJid, count: messagesToSend.length },
      'Piped messages to active agent',
    );
    markPendingAgentTimestamp(
      chatJid,
      messagesToSend[messagesToSend.length - 1].timestamp,
    );
  } else {
    queue.enqueueMessageCheck(chatJid);
  }

  void channel
    .setTyping?.(chatJid, true)
    ?.catch((err: unknown) =>
      agentLog.warn({ chatJid, err }, 'Failed to set typing indicator'),
    );
}

export async function refreshTaskSnapshots(): Promise<void> {
  const taskSnapshots = await getTaskSnapshots();
  const taskSnapshotsByGroup = new Map<string, typeof taskSnapshots>();
  for (const snapshot of taskSnapshots) {
    const groupSnapshots = taskSnapshotsByGroup.get(snapshot.groupFolder);
    if (groupSnapshots) {
      groupSnapshots.push(snapshot);
    } else {
      taskSnapshotsByGroup.set(snapshot.groupFolder, [snapshot]);
    }
  }
  for (const [jid, group] of Object.entries(registeredGroups)) {
    const isMain = group.isMain === true;
    writeTasksSnapshot(
      group.folder,
      isMain,
      isMain ? taskSnapshots : (taskSnapshotsByGroup.get(group.folder) ?? []),
    );
  }
}

export async function createWebConversation(
  jid: string,
  name: string,
  options: {
    assistantId?: string;
    accessPolicy?: AccessPolicy;
    mode?: string;
    channel?: string;
  } = {},
): Promise<{ folder: string; accessPolicy: AccessPolicy; }> {
  const existing = registeredGroups[jid];
  if (existing) {
    return {
      folder: existing.folder,
      accessPolicy: await getConversationAccessPolicy(jid),
    };
  }

  const timestamp = new Date().toISOString();
  const assistantName = await getAssistantName();
  const suffix = jid.replace(/^web:/, '').slice(0, 18);
  const assistantId = options.assistantId?.trim() || undefined;
  const assistant = assistantId ? await getAssistant(assistantId) : undefined;
  if (assistantId && !assistant) {
    throw new Error(`Unknown assistant id: ${assistantId}`);
  }
  if (assistant && !assistant.enabled) {
    throw new Error(`Assistant "${assistant.name}" is disabled`);
  }
  const conversationAccessPolicy = options.accessPolicy
    ? serializeAccessPolicy(options.accessPolicy)
    : undefined;
  registerGroup(jid, {
    name: `Web Chat ${suffix}`,
    folder: deriveWebGroupFolder(jid),
    trigger: `@${assistantName}`,
    added_at: timestamp,
    ...(assistantId ? { assistantId } : {}),
    requiresTrigger: false,
    isMain: false,
    ...(conversationAccessPolicy
      ? {
          agentConfig: {
            accessPolicy: conversationAccessPolicy,
          },
        }
      : {}),
  });
  await storeChatMetadata(
    jid,
    timestamp,
    'Web User',
    options.channel?.trim() || 'web',
    false,
  );
  const customTitle = name.trim();
  if (customTitle || options.mode) {
    await updateConversationMeta(jid, {
      ...(customTitle ? { customTitle } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    });
  }
  return {
    folder: registeredGroups[jid]!.folder,
    accessPolicy: await getConversationAccessPolicy(jid),
  };
}

export async function createChannelConversation(input: {
  type: string;
  instanceId?: string;
  name: string;
  assistantId?: string;
  target?: Record<string, unknown>;
}): Promise<{ jid: string; name: string; allowedDirectories?: string[] } | null> {
  const timestamp = new Date().toISOString();
  const assistantId = input.assistantId?.trim() || undefined;
  if (assistantId) {
    throw new Error('Assistants are currently supported only for Web conversations');
  }

  const resolveRecentFeishuChat = async (
    instanceId: string,
  ): Promise<{ chatId: string; name: string; isGroup: boolean; } | null> => {
    for (const chat of await getAllChats()) {
      if (chat.channel !== 'feishu' || !chat.jid.startsWith('feishu:')) {
        continue;
      }

      const payload = chat.jid.slice('feishu:'.length);
      const separatorIndex = payload.indexOf(':');
      const parsed =
        separatorIndex === -1
          ? { instanceId: 'default', chatId: payload }
          : {
              instanceId: payload.slice(0, separatorIndex).trim(),
              chatId: payload.slice(separatorIndex + 1).trim(),
            };
      if (!parsed.instanceId || !parsed.chatId) {
        continue;
      }
      if (parsed.instanceId !== instanceId) {
        continue;
      }

      return {
        chatId: parsed.chatId,
        name: chat.name || `Feishu ${parsed.chatId.slice(0, 12)}`,
        isGroup: !!chat.is_group,
      };
    }

    return null;
  };

  const resolveInstance = async (type: string, label: string) => {
    const instanceId = (input.instanceId || '').trim() || 'default';
    const instance = (await getConfiguredChannelInstances()).find(
      (entry) =>
        entry.enabled && entry.type === type && entry.id === instanceId,
    );
    if (!instance) {
      throw new Error(
        t('errors.channelInstanceUnavailable', { label }, undefined),
      );
    }
    const ownerUserId =
      instance.visibility === 'private' ? instance.owner_id : SYSTEM_USER_ID;
    return { instanceId, ownerUserId };
  };

  const registerCreatedConversation = async (params: {
    jid: string;
    type: string;
    name: string;
    customTitle?: string;
    folder: string;
    isGroup: boolean;
    ownerUserId?: string;
  }) => {
    if (!registeredGroups[params.jid]) {
      const assistantName = await getAssistantName();
      registerGroup(params.jid, {
        name: params.name,
        folder: params.folder,
        trigger: `@${assistantName}`,
        added_at: timestamp,
        ...(assistantId ? { assistantId } : {}),
        requiresTrigger: params.isGroup,
        isMain: false,
      });
    }
    await storeChatMetadata(
      params.jid,
      timestamp,
      params.name,
      params.type,
      params.isGroup,
      params.ownerUserId,
    );
    if (params.customTitle?.trim()) {
      await updateConversationMeta(params.jid, {
        customTitle: params.customTitle.trim(),
      });
    }
    return { jid: params.jid, name: params.name };
  };

  if (input.type === 'feishu') {
    const { instanceId, ownerUserId } = await resolveInstance('feishu', t('errors.auto_7714e5', {}, undefined));
    const knownChat = await resolveRecentFeishuChat(instanceId);
    const chatId =
      String(input.target?.chatId || '').trim() || knownChat?.chatId || '';
    if (!chatId) {
      throw new Error(t('errors.auto_510852', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      knownChat?.name ||
      `Feishu ${chatId.slice(0, 12)}`;
    const rawIsGroup = String(input.target?.isGroup || '')
      .trim()
      .toLowerCase();
    const isGroup =
      rawIsGroup === 'true'
        ? true
        : rawIsGroup === 'false'
          ? false
          : (knownChat?.isGroup ?? false);
    return await registerCreatedConversation({
      jid: buildFeishuJid(instanceId, chatId),
      type: 'feishu',
      name,
      customTitle,
      folder: deriveFeishuGroupFolder(instanceId, chatId),
      isGroup,
      ownerUserId,
    });
  }

  if (input.type === 'telegram') {
    const { instanceId, ownerUserId } = await resolveInstance('telegram', 'Telegram');
    const chatId = String(input.target?.chatId || '').trim();
    if (!chatId) {
      throw new Error(t('errors.auto_e7edd9', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      `Telegram ${chatId.slice(0, 12)}`;
    const isGroup =
      String(input.target?.isGroup || '')
        .trim()
        .toLowerCase() === 'true';
    return await registerCreatedConversation({
      jid: buildTelegramJid(instanceId, chatId),
      type: 'telegram',
      name,
      customTitle,
      folder: deriveTelegramGroupFolder(instanceId, chatId),
      isGroup,
      ownerUserId,
    });
  }

  if (input.type === 'discord') {
    const { instanceId, ownerUserId } = await resolveInstance('discord', 'Discord');
    const channelId = String(input.target?.channelId || '').trim();
    if (!channelId) {
      throw new Error(t('errors.auto_198b66', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      `Discord ${channelId.slice(0, 12)}`;
    const isGroup =
      String(input.target?.isGroup || '')
        .trim()
        .toLowerCase() === 'true';
    return await registerCreatedConversation({
      jid: buildDiscordJid(instanceId, channelId),
      type: 'discord',
      name,
      customTitle,
      folder: deriveDiscordGroupFolder(instanceId, channelId),
      isGroup,
      ownerUserId,
    });
  }

  if (input.type === 'slack') {
    const { instanceId, ownerUserId } = await resolveInstance('slack', 'Slack');
    const channelId = String(input.target?.channelId || '').trim();
    if (!channelId) {
      throw new Error(t('errors.auto_195124', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      `Slack ${channelId.slice(0, 12)}`;
    const isGroup =
      String(input.target?.isGroup || '')
        .trim()
        .toLowerCase() === 'true';
    return await registerCreatedConversation({
      jid: buildSlackJid(instanceId, channelId),
      type: 'slack',
      name,
      customTitle,
      folder: deriveSlackGroupFolder(instanceId, channelId),
      isGroup,
      ownerUserId,
    });
  }

  if (input.type === 'gmail') {
    const { instanceId, ownerUserId } = await resolveInstance('gmail', 'Gmail');
    const threadId = String(input.target?.threadId || '').trim();
    if (!threadId) {
      throw new Error(t('errors.auto_471474', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      `Gmail ${threadId.slice(0, 12)}`;
    return await registerCreatedConversation({
      jid: buildGmailJid(instanceId, threadId),
      type: 'gmail',
      name,
      customTitle,
      folder: deriveGmailGroupFolder(instanceId, threadId),
      isGroup: false,
      ownerUserId,
    });
  }

  if (input.type === 'whatsapp') {
    const { instanceId, ownerUserId } = await resolveInstance('whatsapp', 'WhatsApp');
    const chatId = String(input.target?.chatId || '').trim();
    if (!chatId) {
      throw new Error(t('errors.auto_57ca5a', {}, undefined));
    }

    const customTitle = String(input.name || '').trim();
    const name =
      String(input.target?.name || '').trim() ||
      `WhatsApp ${chatId.slice(0, 12)}`;
    return await registerCreatedConversation({
      jid: buildWhatsAppJid(instanceId, chatId),
      type: 'whatsapp',
      name,
      customTitle,
      folder: deriveWhatsAppGroupFolder(instanceId, chatId),
      isGroup: false,
      ownerUserId,
    });
  }

  return null;
}

export async function updateConversationAccessPolicy(
  jid: string,
  accessPolicy: AccessPolicy,
): Promise<{ folder: string; accessPolicy: AccessPolicy; } | null> {
  let current = registeredGroups[jid];
  if (!current) {
    const dbGroup = await getRegisteredGroup(jid);
    if (dbGroup) {
      registeredGroups[jid] = dbGroup;
      current = dbGroup;
    } else {
      return null;
    }
  }
  if (current.assistantId?.trim()) {
    throw new Error(
      'Assistant-managed conversations do not support conversation-level directory overrides',
    );
  }

  const previousPolicy = current.agentConfig?.accessPolicy;
  const nextGroup: RegisteredGroup = {
    ...current,
    agentConfig: {
      ...current.agentConfig,
      accessPolicy: serializeAccessPolicy(accessPolicy),
      allowedDirectories: undefined,
      strictAllowedDirectories: undefined,
    },
  };
  registeredGroups[jid] = nextGroup;
  await setRegisteredGroup(jid, nextGroup);

  agentLog.info(
    {
      jid,
      before: previousPolicy ?? null,
      after: { mode: accessPolicy.mode, directories: accessPolicy.directories },
    },
    'Access policy updated',
  );

  return {
    folder: nextGroup.folder,
    accessPolicy: await getConversationAccessPolicy(jid),
  };
}

export function interruptConversationReply(jid: string): boolean {
  const activeTurnId = activeConversationTurnIds.get(jid);
  const stopped = queue.stopActiveProcess(jid);
  if (!stopped) return false;

  stopTurnScopedSubagents(
    jid,
    activeTurnId,
    ['agent', 'team'],
    'turn_interrupted',
  );
  clearActiveConversationTurn(jid, activeTurnId);

  interruptedAgentRuns.add(jid);
  finalizeInterruptedAgentRun(jid);
  clearIpcAcknowledgedOutput(jid);
  getWebChannel()?.notifyInterrupted(jid, {
    timestamp: new Date().toISOString(),
    reason: t('errors.auto_1e03dd', {}, undefined),
  });
  return true;
}

function resolveLatestVisibleAssistantMessage(
  messages: NewMessage[],
): NewMessage | undefined {
  return [...messages].reverse().find((message) => message.is_bot_message);
}

function resolveLatestRegeneratableTurn(input: {
  turns: PersistedAssistantTurn[];
  messages: NewMessage[];
  requestedTurnId?: string,
}): PersistedAssistantTurn {
  const regeneratableTurns = input.turns.filter(
    (turn) => !turn.isLive && turn.isCompleted && !!turn.persistedMessageId,
  );
  if (regeneratableTurns.length === 0) {
    throw new Error('No assistant reply available to regenerate');
  }

  const latestBotMessage = resolveLatestVisibleAssistantMessage(input.messages);
  const latestByVisibleMessage = latestBotMessage
    ? regeneratableTurns.find(
        (turn) => turn.persistedMessageId === latestBotMessage.id,
      )
    : undefined;
  const latest = latestByVisibleMessage || regeneratableTurns.at(-1);

  if (!latest) {
    throw new Error('No assistant reply available to regenerate');
  }

  const requestedTurnId = input.requestedTurnId?.trim();
  if (!requestedTurnId) {
    return latest;
  }

  const requested = regeneratableTurns.find(
    (turn) => turn.id === requestedTurnId,
  );
  if (!requested) {
    throw new Error('No assistant reply available to regenerate');
  }
  if (requested.id !== latest.id) {
    throw new Error('Only the latest assistant reply can be regenerated');
  }
  return requested;
}

function resolveRegenerationWindow(input: {
  messages: NewMessage[];
  targetAssistantMessageId: string;
}): {
  resetCursorTimestamp: string;
  latestUserTimestamp: string;
} {
  const assistantIndex = input.messages.findIndex(
    (message) => message.id === input.targetAssistantMessageId,
  );
  if (assistantIndex < 0) {
    throw new Error('Assistant reply message not found');
  }

  let previousBotIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.is_bot_message) {
      previousBotIndex = index;
      break;
    }
  }

  let firstUserIndex = -1;
  let latestUserIndex = -1;
  for (let index = previousBotIndex + 1; index < assistantIndex; index += 1) {
    const message = input.messages[index];
    if (!message || message.is_bot_message) continue;
    if (firstUserIndex < 0) {
      firstUserIndex = index;
    }
    latestUserIndex = index;
  }

  if (firstUserIndex < 0 || latestUserIndex < 0) {
    throw new Error('No user input available to regenerate this reply');
  }

  return {
    resetCursorTimestamp:
      firstUserIndex > 0
        ? input.messages[firstUserIndex - 1]?.timestamp || ''
        : '',
    latestUserTimestamp: input.messages[latestUserIndex]!.timestamp,
  };
}

export async function regenerateConversationReply(
  chatJid: string,
  requestedTurnId?: string,
): Promise<void> {
  const group =
    registeredGroups[chatJid] ||
    (await syncRepoReviewConversationBinding(chatJid)) ||
    (await getRegisteredGroup(chatJid));
  if (!group) {
    throw new Error('Conversation group not found');
  }
  registeredGroups[chatJid] = group;

  if (queue.isMessageAgentReplyInProgress(chatJid)) {
    throw new Error('A reply is currently in progress');
  }

  await sanitizeStaleTurnsForChat(chatJid);

  const messages = await getConversationMessages(chatJid, 1000, 0);
  const turns = await getConversationTurns(chatJid, 200, 0);
  if (turns.some((turn) => turn.isLive)) {
    throw new Error('A reply is currently in progress');
  }
  if (activeConversationTurnIds.has(chatJid)) {
    clearActiveConversationTurn(chatJid);
  }
  const targetTurn = resolveLatestRegeneratableTurn({
    turns,
    messages,
    requestedTurnId,
  });
  const targetMessageId = targetTurn.persistedMessageId;
  if (!targetMessageId) {
    throw new Error('Assistant reply message not found');
  }

  const regenerationWindow = resolveRegenerationWindow({
    messages,
    targetAssistantMessageId: targetMessageId,
  });

  await resetConversationRuntime(chatJid, group.folder);
  await deleteAssistantTurnSnapshot(chatJid, targetTurn.id);
  await deleteConversationMessageById(chatJid, targetMessageId);
  await updateConversationLastMessageTime(
    chatJid,
    regenerationWindow.latestUserTimestamp,
  );

  lastAgentTimestamp[chatJid] = regenerationWindow.resetCursorTimestamp;
  clearPendingAgentTimestamp(chatJid);
  interruptedAgentRuns.delete(chatJid);
  clearIpcAcknowledgedOutput(chatJid);
  saveState().catch((err) => {
    agentLog.error({ err, chatJid }, 'Failed to persist regeneration cursor reset');
  });

  queue.enqueueMessageCheck(chatJid);
}

export async function registerGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    agentLog.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  await setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  agentLog.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Update the per-conversation provider/model override, persisting to DB
 * and syncing the in-memory registeredGroups map.
 * Falls back to DB lookup when the group isn't loaded in memory yet.
 */
export async function setConversationProviderOverride(
  jid: string,
  providerId: string | null,
  model: string | null,
): Promise<boolean> {
  let group = registeredGroups[jid];
  if (!group) {
    const dbGroup = await getRegisteredGroup(jid);
    if (!dbGroup) return false;
    registeredGroups[jid] = dbGroup;
    group = dbGroup;
  }
  group.providerId = providerId?.trim() || null;
  group.model = model?.trim() || null;
  await updateConversationProvider(jid, group.providerId, group.model);
  return true;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export async function getAvailableGroups(): Promise<AvailableGroup[]> {
  const chats = await getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
export async function processGroupMessages(
  chatJid: string,
): Promise<boolean> {
  const group =
    registeredGroups[chatJid] ||
    (await syncRepoReviewConversationBinding(chatJid));
  if (!group) return true;
  clearActiveConversationTurn(chatJid);

  const channel = await resolveConversationChannel(chatJid);
  if (!channel) {
    agentLog.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

  const sinceTimestamp = getEffectiveAgentTimestamp(chatJid);
  const missedMessages = await getMessagesSince(
    chatJid,
    sinceTimestamp,
    await getAssistantName(),
  );

  if (missedMessages.length === 0) return true;

  const allowlistCfg = needsTrigger ? loadSenderAllowlist() : null;
  const assistantName = await getAssistantName();
  const isTriggerMessage = (message: NewMessage) =>
    getTriggerPattern(assistantName).test(message.content.trim()) &&
    (message.is_from_me ||
      isTriggerAllowed(chatJid, message.sender, allowlistCfg!));
  const messagesToProcess = needsTrigger
    ? selectMessagesFromFirstTrigger(missedMessages, isTriggerMessage)
    : missedMessages;
  if (messagesToProcess.length === 0) return true;

  const promptEnvelope = await resolveConversationPromptEnvelope(
    chatJid,
    messagesToProcess,
    group,
    { runMemoryExtraction: true },
  );
  const prompt = promptEnvelope.prompt;
  const soulPrompt = promptEnvelope.soulPrompt;
  const resolvedUserId = promptEnvelope.resolvedUserId;

  clearIpcAcknowledgedOutput(chatJid);

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  markPendingAgentTimestamp(
    chatJid,
    messagesToProcess[messagesToProcess.length - 1].timestamp,
  );

  agentLog.info(
    { group: group.name, chatJid, messageCount: messagesToProcess.length, channel: channel.name },
    'Agent dispatched',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let outputAcknowledged = false;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      agentLog.debug({ group: group.name }, 'Idle timeout, closing agent stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let streamedToPrimaryChannel = false;
  let primaryReplyCompleted = false;

  let pendingParts: string[] = [];
  let streamedText = '';
  let nonRetryableError = false;
  let liveTurnId: string | undefined;
  let latestTurnError: string | undefined;
  const turnPersistenceDrafts = new Map<string, PersistedAssistantTurn>();
  let persistedPrimaryReply:
    | { messageId: string; timestamp: string; text: string }
    | undefined;

  const resetTurnDeliveryState = () => {
    pendingParts = [];
    streamedText = '';
    outputSentToUser = false;
    streamedToPrimaryChannel = false;
    primaryReplyCompleted = false;
    nonRetryableError = false;
    latestTurnError = undefined;
    persistedPrimaryReply = undefined;
  };

  const persistDeliveredTurnSnapshot = async (input: {
    messageId: string;
    timestamp: string;
    text: string;
  }): Promise<void> => {
    if (!liveTurnId) return;
    const finalizedTurn = finalizePersistedTurnForMessage(
      turnPersistenceDrafts.get(liveTurnId),
      input.messageId,
      input.timestamp,
      input.text,
    );
    if (!finalizedTurn) return;
    turnPersistenceDrafts.set(liveTurnId, finalizedTurn);
    await storeAssistantTurnSnapshot(
      chatJid,
      finalizedTurn,
      input.timestamp,
    );
  };

  const deliverVisibleErrorReply = async (visibleError: string) => {
    if (channel.name === 'web') {
      await channel.setTyping?.(chatJid, false);
      return;
    }
    const delivered = await storeAndBroadcastBotReply(
      chatJid,
      t('errors.requestFailed', { message: visibleError }, undefined),
      liveTurnId ? turnPersistenceDrafts.get(liveTurnId) : undefined,
    );
    persistedPrimaryReply = {
      messageId: delivered.messageId,
      timestamp: delivered.timestamp,
      text: delivered.text,
    };
    await persistDeliveredTurnSnapshot({
      messageId: delivered.messageId,
      timestamp: delivered.timestamp,
      text: delivered.text,
    });
    await channel.sendMessage(chatJid, delivered.text);
    outputSentToUser = true;
    primaryReplyCompleted = true;
    streamedText = '';
    pendingParts = [];
    await channel.setTyping?.(chatJid, false);
  };

  const acknowledgeOutput = () => {
    if (outputAcknowledged) return;
    acknowledgePendingAgentTimestamp(chatJid);
    outputAcknowledged = true;
  };

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (interruptedAgentRuns.has(chatJid)) {
      return;
    }

    if (result.event) {
      const webCh = getWebChannel();
      if (webCh) {
        webCh.notifyAgentEvent(chatJid, result.event);
      }
      resetIdleTimer();
    }

    if (result.turnEvent) {
      if (liveTurnId !== result.turnEvent.turnId) {
        stopTurnScopedSubagents(
          chatJid,
          liveTurnId,
          ['agent'],
          'turn_replaced',
        );
        clearActiveConversationTurn(chatJid, liveTurnId);
        // A long-lived agent process can handle multiple user turns.
        // Reset per-turn delivery state so a failed turn cannot reuse the
        // persisted message metadata from a previous successful reply.
        resetTurnDeliveryState();
      }
      liveTurnId = result.turnEvent.turnId;
      setActiveConversationTurn(chatJid, liveTurnId);
      const visibleTurnEvent = sanitizeTurnEventForWeb(result.turnEvent);
      if (visibleTurnEvent) {
        applyTurnEventToPersistenceDrafts(turnPersistenceDrafts, visibleTurnEvent);
      }
      if (visibleTurnEvent?.type === 'turn.failed') {
        latestTurnError = visibleTurnEvent.error;
      }
      if (result.turnEvent.type === 'turn.completed') {
        stopTurnScopedSubagents(
          chatJid,
          result.turnEvent.turnId,
          ['agent'],
          'turn_completed',
        );
        const completedTurn = turnPersistenceDrafts.get(result.turnEvent.turnId);
        if (completedTurn) {
          await storeAssistantTurnSnapshot(
            chatJid,
            completedTurn,
            completedTurn.timestamp,
          );
        }
      }
      if (result.turnEvent.type === 'turn.failed') {
        stopTurnScopedSubagents(
          chatJid,
          result.turnEvent.turnId,
          ['agent'],
          'turn_failed',
        );
      }
      const webCh = getWebChannel();
      if (webCh && visibleTurnEvent) {
        webCh.notifyTurnEvent(chatJid, visibleTurnEvent);
      }
      resetIdleTimer();
    }

    if (result.approvalRequest) {
      const webCh = getWebChannel();
      if (webCh) {
        webCh.notifyApprovalRequest(chatJid, result.approvalRequest);
      }
      resetIdleTimer();
    }

    if (result.approvalResolved) {
      const webCh = getWebChannel();
      if (webCh) {
        webCh.notifyApprovalResolved(chatJid, result.approvalResolved);
      }
      resetIdleTimer();
    }

    if (result.askRequest) {
      const webCh = getWebChannel();
      if (webCh) {
        webCh.notifyAskRequest(chatJid, result.askRequest);
      }
      resetIdleTimer();
    }

    if (result.askResolved) {
      const webCh = getWebChannel();
      if (webCh) {
        webCh.notifyAskResolved(chatJid, result.askResolved);
      }
      resetIdleTimer();
    }

    if (result.streamChunk) {
      acknowledgeOutput();
      streamedText = mergeStreamingText(streamedText, result.streamChunk);
      const webCh = getWebChannel();
      if (webCh && !liveTurnId) {
        await webCh.sendStreamChunk(chatJid, result.streamChunk, false);
        outputSentToUser = true;
      } else if (webCh && liveTurnId) {
        await webCh.sendStreamChunk(chatJid, result.streamChunk, false, liveTurnId);
        outputSentToUser = true;
      }
      if (channel.name !== 'web' && channel.sendStreamChunk) {
        await channel.sendStreamChunk(chatJid, result.streamChunk, false);
        streamedToPrimaryChannel = true;
        outputSentToUser = true;
      }
      await channel.setTyping?.(chatJid, false);
      resetIdleTimer();
    }

    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      agentLog.debug({ group: group.name, outputLength: raw.length }, 'Agent output received');
      if (text) {
        acknowledgeOutput();
        const delivered = await storeAndBroadcastBotReply(
          chatJid,
          text,
          liveTurnId ? turnPersistenceDrafts.get(liveTurnId) : undefined,
        );
        persistedPrimaryReply = {
          messageId: delivered.messageId,
          timestamp: delivered.timestamp,
          text: delivered.text,
        };
        await persistDeliveredTurnSnapshot({
          messageId: delivered.messageId,
          timestamp: delivered.timestamp,
          text: delivered.text,
        });

        // Async emotion analysis — only for companion mode conversations
        (async () => {
          try {
            if (!(await isEmotionEnabled())) return;
            const chatMode = await getConversationMode(chatJid);
            if (chatMode !== 'companion') return;
            const emotion = await analyzeEmotion(delivered.text);
            const webCh = getWebChannel();
            if (webCh && emotion !== 'neutral') {
              webCh.notifyLive2DEmotion(chatJid, emotion, liveTurnId || '');
            }
          } catch (err) { agentLog.debug({ err, chatJid }, 'Emotion analysis failed (non-critical)'); }
        })();

        if (channel.name === 'web') {
          const webCh = getWebChannel();
          if (webCh) {
            await webCh.sendStreamChunk(chatJid, '', true, liveTurnId);
          }
          outputSentToUser = true;
          primaryReplyCompleted = true;
          await channel.setTyping?.(chatJid, false);
        } else if (streamedToPrimaryChannel && channel.sendStreamChunk) {
          await channel.sendStreamChunk(chatJid, delivered.text, true);
          outputSentToUser = true;
          primaryReplyCompleted = true;
          streamedText = '';
          pendingParts = [];
          await channel.setTyping?.(chatJid, false);
          const webCh = getWebChannel();
          if (webCh) {
            await webCh.sendStreamChunk(chatJid, '', true, liveTurnId);
          }
        } else {
          await channel.sendMessage(chatJid, delivered.text);
          outputSentToUser = true;
          primaryReplyCompleted = true;
          streamedText = '';
          pendingParts = [];
          await channel.setTyping?.(chatJid, false);
          const webCh = getWebChannel();
          if (webCh) {
            await webCh.sendStreamChunk(chatJid, '', true, liveTurnId);
          }
        }
      }
      resetIdleTimer();
    }

    if (result.status === 'success' && !result.result && !result.streamChunk) {
      acknowledgeOutput();
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      const webCh = getWebChannel();
      if (webCh && !liveTurnId) {
        await webCh.sendStreamChunk(chatJid, '', true);
      } else if (webCh && liveTurnId) {
        await webCh.sendStreamChunk(chatJid, '', true, liveTurnId);
      }
      if (channel.name !== 'web' && channel.sendStreamChunk) {
        await channel.sendStreamChunk(chatJid, '', true);
      }
      nonRetryableError = result.retryable === false;
      if (nonRetryableError && !outputSentToUser) {
        const visibleError = formatUserVisibleAgentError(
          latestTurnError || result.error || '',
        );
        await deliverVisibleErrorReply(visibleError);
      }
      hadError = true;
    }
  }, {
    soulPrompt,
    userId: resolvedUserId,
    promptEnvelope,
  });

  if (output.status === 'error' && !latestTurnError) {
    notifyWebTurnFailure(
      chatJid,
      output.error || t('errors.auto_6c36b7', {}, undefined),
      turnPersistenceDrafts,
      liveTurnId,
    );
    latestTurnError = formatUserVisibleAgentError(
      output.error || t('errors.auto_6c36b7', {}, undefined),
    );
  }

  const finalNonWebReply = primaryReplyCompleted
    ? ''
    : resolveFinalReplyText(
        pendingParts,
        output.status === 'success' && !hadError ? streamedText : '',
      );
  if (finalNonWebReply) {
    pendingParts = [];
    acknowledgeOutput();
    const delivered = await storeAndBroadcastBotReply(
      chatJid,
      finalNonWebReply,
      liveTurnId ? turnPersistenceDrafts.get(liveTurnId) : undefined,
    );
    persistedPrimaryReply = {
      messageId: delivered.messageId,
      timestamp: delivered.timestamp,
      text: delivered.text,
    };
    await persistDeliveredTurnSnapshot({
      messageId: delivered.messageId,
      timestamp: delivered.timestamp,
      text: delivered.text,
    });
    if (
      streamedToPrimaryChannel &&
      channel.name !== 'web' &&
      channel.sendStreamChunk
    ) {
      await channel.sendStreamChunk(chatJid, delivered.text, true);
    } else {
      await channel.sendMessage(chatJid, delivered.text);
    }
    outputSentToUser = true;
    primaryReplyCompleted = true;
  }
  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  if (persistedPrimaryReply && liveTurnId) {
    const finalizedTurn = finalizePersistedTurnForMessage(
      turnPersistenceDrafts.get(liveTurnId),
      persistedPrimaryReply.messageId,
      persistedPrimaryReply.timestamp,
      persistedPrimaryReply.text,
    );
    if (finalizedTurn) {
      await storeAssistantTurnSnapshot(
        chatJid,
        finalizedTurn,
        persistedPrimaryReply.timestamp,
      );
    }
  } else if (liveTurnId) {
    const completedTurn = turnPersistenceDrafts.get(liveTurnId);
    if (completedTurn?.isCompleted) {
      await storeAssistantTurnSnapshot(
        chatJid,
        completedTurn,
        completedTurn.timestamp,
      );
    }
  }
  const interrupted = interruptedAgentRuns.delete(chatJid);

  if (interrupted) {
    stopTurnScopedSubagents(
      chatJid,
      liveTurnId,
      ['agent', 'team'],
      'turn_interrupted',
    );
    clearActiveConversationTurn(chatJid, liveTurnId);
    clearIpcAcknowledgedOutput(chatJid);
    finalizeInterruptedAgentRun(chatJid);
    agentLog.info({ group: group.name }, 'Agent reply stopped by user');
    return true;
  }

  if (output.status === 'error' || hadError) {
    stopTurnScopedSubagents(chatJid, liveTurnId, ['agent'], 'turn_failed');
    clearActiveConversationTurn(chatJid, liveTurnId);
    if (nonRetryableError) {
      acknowledgeOutput();
      agentLog.warn(
        { group: group.name },
        'Agent returned non-retryable provider error, skipping retry',
      );
      return true;
    }
    if (outputSentToUser || hasIpcAcknowledgedOutput(chatJid)) {
      clearIpcAcknowledgedOutput(chatJid);
      agentLog.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    clearIpcAcknowledgedOutput(chatJid);
    lastAgentTimestamp[chatJid] = previousCursor;
    clearPendingAgentTimestamp(chatJid);
    saveState().catch((err) => {
      agentLog.error({ err }, 'Failed to persist cursor rollback after agent error');
    });
    agentLog.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  stopTurnScopedSubagents(chatJid, liveTurnId, ['agent'], 'turn_completed');
  clearActiveConversationTurn(chatJid, liveTurnId);
  clearIpcAcknowledgedOutput(chatJid);
  finalizeSuccessfulAgentRun(chatJid);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: AgentPromptInput,
  chatJid: string,
  onOutput?: (output: AgentRunOutput) => Promise<void>,
  opts?: {
    soulPrompt?: string;
    userId?: string;
    promptEnvelope?: ResolvedConversationPromptEnvelope;
  },
): Promise<{ status: 'success' } | { status: 'error'; error: string }> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
  clearEphemeralSubagentRuntimes({
    provider: 'claude',
    groupFolder: group.folder,
    chatJid,
  });

  // Update tasks snapshot for the agent runtime to read (filtered by group)
  writeTasksSnapshot(
    group.folder,
    isMain,
    await getTaskSnapshots(isMain ? undefined : group.folder),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = await getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentRunOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          await setSession(group.folder, output.newSessionId);
        }
        if (output.turnEvent) {
          syncEphemeralSubagentRuntimesFromTurnEvent(
            group.folder,
            chatJid,
            output.turnEvent,
          );
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const promptEnvelope = opts?.promptEnvelope
      || await resolveConversationPromptEnvelope(chatJid, [], group);
    const assistantRuntime = promptEnvelope.assistantRuntime;
    const legacyInstructionsAppend = promptEnvelope.segments
      .filter(
        (segment) =>
          segment.id === 'assistant_instructions_append' ||
          segment.promptKey === 'conversation.companion.mode_hint',
      )
      .map((segment) => segment.content)
      .filter(Boolean)
      .join('\n\n');

    await recordPromptTrace({
      traceKind: 'agent_envelope',
      featureScope: 'conversation',
      promptKey: 'conversation.runtime',
      targetUserId: opts?.userId ?? '',
      chatJid,
      provider: assistantRuntime.providerAlias || null,
      model: assistantRuntime.modelOverride || null,
      stableSystemPrompt: promptEnvelope.compiledPrompt.stableSystemPrompt,
      volatileSystemPrompt: promptEnvelope.compiledPrompt.volatileSystemPrompt,
      systemPromptText: promptEnvelope.compiledPrompt.systemPromptText || null,
      userPromptText: promptEnvelope.compiledPrompt.userPrompt,
      providerInputText: promptEnvelope.compiledPrompt.providerInputText || prompt.text,
      contextBlocks: promptEnvelope.compiledPrompt.contextBlocks,
      segments: promptEnvelope.segments,
      resolution: promptEnvelope.resolution,
      stablePrefixFingerprint: promptEnvelope.compiledPrompt.stablePrefixFingerprint || null,
      cacheFingerprint: promptEnvelope.compiledPrompt.cacheFingerprint || null,
      metadata: {
        assistantId: assistantRuntime.assistantId,
        assistantName: assistantRuntime.assistantName,
        companionMode: promptEnvelope.companionMode,
        uploadedFileCount: prompt.uploadedFiles?.length || 0,
      },
    });

    const agentStartTime = Date.now();
    const output = await runAgentProcess(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: await getAssistantName(),
        managedSkillIds: assistantRuntime.managedSkillIds,
        managedMcpServerIds: assistantRuntime.managedMcpServerIds,
        userSkillIds: assistantRuntime.userSkillIds,
        userMcpServerIds: assistantRuntime.userMcpServerIds,
        managedKbIds: assistantRuntime.managedKbIds,
        resolvedManagedMcpServers: assistantRuntime.resolvedMcpServers,
        projectRootOverride: assistantRuntime.projectRootOverride,
        workspaceExtraDirectories:
          assistantRuntime.repoBindingDirectories?.slice(1),
        allowedDirectoriesOverride: assistantRuntime.repoBindingDirectories,
        providerOverrideId: assistantRuntime.providerOverrideId,
        modelOverride: assistantRuntime.modelOverride,
        soulSystemPrompt: assistantRuntime.soulSystemPrompt,
        instructionsAppend: legacyInstructionsAppend || undefined,
        assistantRuleMode: assistantRuntime.instructionsMode,
        userId: opts?.userId,
      },
      (proc, agentLabel) =>
        queue.registerProcess(chatJid, proc, agentLabel, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      await setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      agentLog.error(
        {
          group: group.name,
          error: output.error,
          errorDetails: output.errorDetails,
          chatJid,
        },
        'Agent process error',
      );
      return {
        status: 'error',
        error: output.error || t('errors.auto_6c36b7', {}, undefined),
      };
    }

    const agentDurationMs = Date.now() - agentStartTime;
    agentLog.info(
      { group: group.name, chatJid, durationMs: agentDurationMs, status: 'success' },
      'Agent finished',
    );
    return { status: 'success' };
  } catch (err) {
    agentLog.error({ group: group.name, chatJid, err }, 'Agent error');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : t('errors.auto_6c36b7', {}, undefined),
    };
  } finally {
    clearEphemeralSubagentRuntimes({
      provider: 'claude',
      groupFolder: group.folder,
      chatJid,
    });
  }
}

export async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    agentLog.debug('Message loop already running, skipping duplicate start');
    return;
  }
  assignMessageLoopRunning(true);

  const triggerName = await getAssistantName();
  agentLog.info({ triggerName }, 'NanoClaw running');

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const snapshotTimestamp = lastTimestamp;
      const { messages, newTimestamp } = await getNewMessages(
        jids,
        snapshotTimestamp,
        await getAssistantName(),
      );

      if (messages.length > 0) {
        const fresh = snapshotTimestamp === lastTimestamp
          ? messages
          : messages.filter((m) => m.timestamp > lastTimestamp);
        if (fresh.length === 0) {
          assignLastTimestamp(newTimestamp);
          await saveState().catch((err) => {
            agentLog.error({ err }, 'Failed to persist message loop cursor');
          });
          continue;
        }

        agentLog.debug({ count: fresh.length }, 'New messages');

        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of fresh) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        const failedJids = new Set<string>();
        for (const [chatJid, groupMessages] of messagesByGroup) {
          try {
            await dispatchPendingMessages(chatJid, groupMessages);
          } catch (dispatchErr) {
            failedJids.add(chatJid);
            agentLog.error({ chatJid, err: dispatchErr }, 'Failed to dispatch messages for group');
          }
        }

        if (failedJids.size === 0) {
          assignLastTimestamp(newTimestamp);
        } else {
          let safeTimestamp = lastTimestamp;
          for (const msg of messages) {
            if (!failedJids.has(msg.chat_jid) && msg.timestamp > safeTimestamp) {
              safeTimestamp = msg.timestamp;
            }
          }
          if (safeTimestamp > lastTimestamp) {
            assignLastTimestamp(safeTimestamp);
          }
          agentLog.warn(
            { failedJids: [...failedJids], advancedTo: safeTimestamp },
            'Partial dispatch: cursor advanced only past successfully dispatched messages',
          );
        }
        try {
          await saveState();
        } catch (persistErr) {
          agentLog.error({ err: persistErr }, 'Failed to persist message loop cursor');
        }
      }
    } catch (err) {
      agentLog.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
export async function recoverPendingMessages(): Promise<void> {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = await getMessagesSince(
      chatJid,
      sinceTimestamp,
      await getAssistantName(),
    );
    if (pending.length > 0) {
      agentLog.info(
        { group: group.name, chatJid, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}
