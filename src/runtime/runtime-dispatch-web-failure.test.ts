import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunAgentProcess, mockGetWebChannel } = vi.hoisted(() => ({
  mockRunAgentProcess: vi.fn(),
  mockGetWebChannel: vi.fn(),
}));

vi.mock('../agent/agent-runner.js', () => ({
  runAgentProcess: mockRunAgentProcess,
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('../assistant/assistant-runtime.js', () => ({
  resolveAssistantRuntimeConfig: vi.fn(async (_group, _deps, options) => ({
    instructionsAppend: '',
    managedSkillIds: [],
    managedMcpServerIds: [],
    userSkillIds: [],
    userMcpServerIds: [],
    managedKbIds: [],
    resolvedMcpServers: [],
    projectRootOverride: undefined,
    repoBindingDirectories: undefined,
    providerOverrideId: undefined,
    modelOverride: undefined,
    instructionsMode: 'append',
    soulSystemPrompt:
      options?.disableSoul || !options?.soulPrompt
        ? undefined
        : `Conversation soul instructions are the primary voice and persona policy for this chat.\n\n${options.soulPrompt}`,
  })),
}));

vi.mock('../channels/web.js', () => ({
  deriveWebGroupFolder: (jid: string) =>
    `web_${jid.replace(/[^a-z0-9]/gi, '_')}`,
  getWebChannel: () => mockGetWebChannel(),
}));

vi.mock('../config-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config-store.js')>();
  return {
    ...actual,
    getAssistantName: vi.fn(async () => 'Andy'),
    getConfiguredChannelInstances: vi.fn(async () => []),
    getConfigValue: vi.fn(async () => ''),
    getTriggerPattern: vi.fn(
      (assistantName: string) => new RegExp(`^@${assistantName}\\b`),
    ),
  };
});

vi.mock('../soul/emotion-service.js', () => ({
  analyzeEmotion: vi.fn(async () => 'neutral'),
  isEmotionEnabled: vi.fn(async () => false),
}));

vi.mock('../soul/soul-service.js', () => ({
  buildSoulPrompt: vi.fn(async () => undefined),
}));

vi.mock('../user/user-service.js', () => ({
  getUserByUsername: vi.fn(async () => null),
}));

vi.mock('../memory/memory-extractor.js', () => ({
  runMemoryExtraction: vi.fn(async () => undefined),
}));

import {
  _initTestDatabase,
  createAssistant,
  createTavernPersona,
  getContextEntries,
  getConversationSummaryByJid,
  getConversationTavernBinding,
  getConversationMessages,
  getConversationTurns,
  storeContextCompaction,
  storeContextEntries,
  storeAssistantTurnSnapshot,
  storeChatMetadata,
  storeMessage,
  storeMessageDirectWithTurn,
  upsertTavernGlobalConfig,
} from '../db.js';
import {
  _buildAgentPromptInputForTest,
  _getAgentCursorState,
  createWebConversation,
  interruptConversationReply,
  processGroupMessages,
  regenerateConversationReply,
} from './runtime-dispatch.js';
import { buildSoulPrompt } from '../soul/soul-service.js';
import { runMemoryExtraction } from '../memory/memory-extractor.js';
import { getUserByUsername } from '../user/user-service.js';
import {
  activeConversationTurnIds,
  assignLastAgentTimestamp,
  assignPendingAgentTimestamp,
  assignRegisteredGroups,
  assignSessions,
  channels,
  interruptedAgentRuns,
  queue,
  ipcAcknowledgedChats,
  pendingUploadedFiles,
  registeredGroups,
} from './runtime-state.js';
import type { Channel, RegisteredGroup } from '../types.js';

function createMockWebChannel(): Channel & {
  notifyTurnEvent: ReturnType<typeof vi.fn>;
  notifyMessage: ReturnType<typeof vi.fn>;
  notifyInterrupted: ReturnType<typeof vi.fn>;
  sendStreamChunk: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'web',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('web:')),
    sendMessage: vi.fn(async () => {}),
    sendStreamChunk: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    notifyTurnEvent: vi.fn(),
    notifyMessage: vi.fn(),
    notifyAgentEvent: vi.fn(),
    notifyApprovalRequest: vi.fn(),
    notifyApprovalResolved: vi.fn(),
    notifyAskRequest: vi.fn(),
    notifyAskResolved: vi.fn(),
    notifyInterrupted: vi.fn(),
    notifyLive2DEmotion: vi.fn(),
  } as unknown as Channel & {
    notifyTurnEvent: ReturnType<typeof vi.fn>;
    notifyMessage: ReturnType<typeof vi.fn>;
    notifyInterrupted: ReturnType<typeof vi.fn>;
    sendStreamChunk: ReturnType<typeof vi.fn>;
  };
}

function createMockOwnedChannel(prefix: string, name: string): Channel {
  return {
    name,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith(prefix)),
    sendMessage: vi.fn(async () => {}),
    sendStreamChunk: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
  } as unknown as Channel;
}

describe('runtime dispatch web failure handling', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();

    channels.splice(0, channels.length);
    assignRegisteredGroups({});
    assignSessions({});
    assignLastAgentTimestamp({});
    assignPendingAgentTimestamp({});
    activeConversationTurnIds.clear();
    interruptedAgentRuns.clear();
    ipcAcknowledgedChats.clear();
    pendingUploadedFiles.clear();
    const queueAny = queue as unknown as {
      groups: Map<string, unknown>;
      waitingGroups: string[];
      _activeCount: number;
      shuttingDown: boolean;
    };
    queueAny.groups.clear();
    queueAny.waitingGroups.length = 0;
    queueAny._activeCount = 0;
    queueAny.shuttingDown = false;
  });

  it('resolves soul context from the conversation owner before sender name fallback', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    const chatJid = 'web:soul-owner';
    const group: RegisteredGroup = {
      name: 'Web Chat soul-owner',
      folder: 'web_soul_owner',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-owner-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Display Name Only',
      content: '@Andy hi',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    vi.mocked(buildSoulPrompt).mockResolvedValue('soul prompt');
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-owner-soul',
    });

    expect(await processGroupMessages(chatJid)).toBe(true);

    expect(vi.mocked(buildSoulPrompt)).toHaveBeenCalledWith(
      'owner-user-id',
      chatJid,
      '@Andy hi',
    );
    expect(vi.mocked(runMemoryExtraction)).toHaveBeenCalledWith(
      'owner-user-id',
      [{ id: 'user-owner-1', content: '@Andy hi' }],
      chatJid,
    );
    expect(vi.mocked(getUserByUsername)).not.toHaveBeenCalled();
  });

  it('skips soul prompt injection when the bound assistant disables soul inheritance', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    await createAssistant({
      id: 'no-soul-assistant',
      name: 'No Soul Assistant',
      config: {
        skillIds: [],
        mcpServerIds: [],
        userSkillIds: [],
        userMcpServerIds: [],
        kbIds: [],
        rules: { mode: 'append' },
        persona: { role: '', style: '', guidelines: '', constraints: '' },
        providerId: null,
        model: null,
      },
    });

    const chatJid = 'web:no-soul';
    const group: RegisteredGroup = {
      name: 'Web Chat no-soul',
      folder: 'web_no_soul',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
      assistantId: 'no-soul-assistant',
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-no-soul-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy hi',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-no-soul',
    });

    expect(await processGroupMessages(chatJid)).toBe(true);

    expect(vi.mocked(buildSoulPrompt)).not.toHaveBeenCalled();
    expect(vi.mocked(runMemoryExtraction)).toHaveBeenCalledWith(
      'owner-user-id',
      [{ id: 'user-no-soul-1', content: '@Andy hi' }],
      chatJid,
    );
  });

  it('creates tavern web conversations with snapshot binding and opener message', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    const persona = await createTavernPersona('owner-user-id', {
      name: 'Moon Archivist',
      summary: 'Quiet, exacting, and a little dramatic.',
      personalityPrompt: 'Speaks in elegant, restrained prose.',
      firstMessage: '夜色已经落下。你带着什么故事来找我？',
      enabled: true,
    });
    await upsertTavernGlobalConfig('owner-user-id', {
      skillIds: ['imagegen'],
      mcpServerIds: ['jira'],
      providerId: 'provider-tavern',
      model: 'gpt-image-1',
    });

    const chatJid = 'web:tavern-1';
    await createWebConversation(chatJid, 'Moon Session', {
      tavernPersonaId: persona.id,
      ownerUserId: 'owner-user-id',
    });

    const binding = await getConversationTavernBinding(chatJid);
    expect(binding?.tavern_persona_id).toBe(persona.id);
    expect(binding?.snapshot_json).toContain('Moon Archivist');

    const summary = await getConversationSummaryByJid(chatJid);
    expect(summary?.mode).toBe('tavern');
    expect(summary?.tavern_persona_id).toBe(persona.id);
    expect(summary?.tavern_persona_name).toBe('Moon Archivist');
    expect(registeredGroups[chatJid]?.agentConfig?.managedSkillIds).toEqual([
      'imagegen',
    ]);
    expect(registeredGroups[chatJid]?.agentConfig?.managedMcpServerIds).toEqual(
      ['jira'],
    );
    expect(registeredGroups[chatJid]?.providerId).toBe('provider-tavern');
    expect(registeredGroups[chatJid]?.model).toBe('gpt-image-1');

    const messages = await getConversationMessages(chatJid, 10, 0);
    expect(messages.some((message) => message.is_bot_message)).toBe(true);
    expect(messages.at(-1)?.content).toBe(
      '夜色已经落下。你带着什么故事来找我？',
    );
    expect(webChannel.notifyMessage).toHaveBeenCalled();
  });

  it('uses the lightweight conversation base for ordinary web chats', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    const chatJid = 'web:light-chat';
    const group: RegisteredGroup = {
      name: 'Web Chat light-chat',
      folder: 'web_light_chat',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-light-chat-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy hi',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    vi.mocked(buildSoulPrompt).mockResolvedValue('SOUL_PROMPT');
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-light-chat',
    });

    expect(await processGroupMessages(chatJid)).toBe(true);

    const input = mockRunAgentProcess.mock.calls[0]?.[1] as
      | {
          prompt?: {
            stableSystemPrompt?: string;
            volatileSystemPrompt?: string;
          };
        }
      | undefined;
    expect(input?.prompt?.stableSystemPrompt).toContain(
      'You are a helpful assistant in a user conversation.',
    );
    expect(input?.prompt?.stableSystemPrompt).toContain(
      'If long-term preferences, identity facts, or prior commitments matter, query memory tools only when needed.',
    );
    expect(input?.prompt?.stableSystemPrompt).toContain(
      'primary voice and persona policy',
    );
    expect(input?.prompt?.stableSystemPrompt).not.toContain(
      'You are a helpful coding assistant with access to tools.',
    );
    expect(input?.prompt?.stableSystemPrompt).not.toContain(
      '## Sub-Agent Policy',
    );
    expect(input?.prompt?.volatileSystemPrompt || '').toContain(
      'Untrusted conversation history',
    );
  });

  it('injects tavern persona prompt after soul prompt for tavern conversations', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    const persona = await createTavernPersona('owner-user-id', {
      name: 'Moon Archivist',
      summary: 'Quiet, exacting, and a little dramatic.',
      personalityPrompt: 'Speaks in elegant, restrained prose.',
      scenario: 'A lamplit archive where each conversation feels confidential.',
      enabled: true,
    });

    const chatJid = 'web:tavern-prompt';
    await createWebConversation(chatJid, 'Moon Session', {
      tavernPersonaId: persona.id,
      ownerUserId: 'owner-user-id',
    });
    await storeMessage({
      id: 'user-tavern-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy tell me what you found',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    vi.mocked(buildSoulPrompt).mockResolvedValue('SOUL_PROMPT');
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-tavern-prompt',
    });

    expect(await processGroupMessages(chatJid)).toBe(true);

    const input = mockRunAgentProcess.mock.calls[0]?.[1] as
      | { prompt?: { stableSystemPrompt?: string } }
      | undefined;
    const stablePrompt = input?.prompt?.stableSystemPrompt || '';
    expect(stablePrompt).toContain('SOUL_PROMPT');
    expect(stablePrompt).toContain('You are roleplaying as "Moon Archivist".');
    expect(stablePrompt).toContain('## Personality');
    expect(stablePrompt.indexOf('SOUL_PROMPT')).toBeGreaterThanOrEqual(0);
    expect(stablePrompt.indexOf('SOUL_PROMPT')).toBeLessThan(
      stablePrompt.indexOf('You are roleplaying as "Moon Archivist".'),
    );
  });

  it('falls back to sender identity for non-web channels instead of using the conversation owner', async () => {
    const telegramChannel = createMockOwnedChannel('telegram:', 'telegram');
    channels.push(telegramChannel);

    const chatJid = 'telegram:test';
    const group: RegisteredGroup = {
      name: 'Telegram test',
      folder: 'telegram_test',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'telegram',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'telegram-user-1',
      chat_jid: chatJid,
      sender: 'telegram_user',
      sender_name: 'Alice',
      content: '@Andy hi',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    vi.mocked(getUserByUsername).mockResolvedValue({
      id: 'sender-user-id',
      username: 'alice',
    } as any);
    vi.mocked(buildSoulPrompt).mockResolvedValue('soul prompt');
    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'Done',
      newSessionId: 'session-telegram-soul',
    });

    expect(await processGroupMessages(chatJid)).toBe(true);

    expect(vi.mocked(getUserByUsername)).toHaveBeenCalledWith('Alice');
    expect(vi.mocked(buildSoulPrompt)).toHaveBeenCalledWith(
      'sender-user-id',
      chatJid,
      '@Andy hi',
    );
    expect(vi.mocked(runMemoryExtraction)).toHaveBeenCalledWith(
      'sender-user-id',
      [{ id: 'telegram-user-1', content: '@Andy hi' }],
      chatJid,
    );
  });

  it('regenerates the latest assistant reply by deleting the old turn and rewinding the cursor', async () => {
    const enqueueMessageCheck = vi
      .spyOn(queue, 'enqueueMessageCheck')
      .mockImplementation(() => {});

    const chatJid = 'web:regenerate';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate',
      folder: 'web_regenerate',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy first',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessage({
      id: 'user-2',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy second',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-1',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'assistant reply',
        timestamp: '2026-04-16T03:24:13.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-1',
        timestamp: '2026-04-16T03:24:13.000Z',
        items: [
          {
            id: 'turn-1:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'assistant reply',
            timestamp: '2026-04-16T03:24:13.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-1',
      },
    );

    await regenerateConversationReply(chatJid, 'turn-1');

    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      { id: 'user-1', content: '@Andy first' },
      { id: 'user-2', content: '@Andy second' },
    ]);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([]);
    expect(_getAgentCursorState()).toMatchObject({
      committed: {
        [chatJid]: '',
      },
    });
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('regenerates by deleting duplicate assistant alternatives for the same user turn', async () => {
    const enqueueMessageCheck = vi
      .spyOn(queue, 'enqueueMessageCheck')
      .mockImplementation(() => {});

    const chatJid = 'web:regenerate-duplicate-alternates';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate duplicate alternates',
      folder: 'web_regenerate_duplicate_alternates',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-dup',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy answer again',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-dup-1',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'first duplicate reply',
        timestamp: '2026-04-16T03:24:12.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-dup-1',
        timestamp: '2026-04-16T03:24:12.000Z',
        items: [
          {
            id: 'turn-dup-1:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'first duplicate reply',
            timestamp: '2026-04-16T03:24:12.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-dup-1',
      },
    );
    await storeMessageDirectWithTurn(
      {
        id: 'bot-dup-2',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'second duplicate reply',
        timestamp: '2026-04-16T03:24:13.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-dup-2',
        timestamp: '2026-04-16T03:24:13.000Z',
        items: [
          {
            id: 'turn-dup-2:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'second duplicate reply',
            timestamp: '2026-04-16T03:24:13.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-dup-2',
      },
    );
    await storeContextEntries([
      {
        id: 'msg:web:regenerate-duplicate-alternates:user-dup',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: null,
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-dup',
        content_text: '@Andy answer again',
        content_json: null,
        token_estimate: 5,
        created_at: '2026-04-16T03:24:11.000Z',
      },
      {
        id: 'msg:web:regenerate-duplicate-alternates:bot-dup-1',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-dup-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'bot-dup-1',
        content_text: 'first duplicate reply',
        content_json: null,
        token_estimate: 5,
        created_at: '2026-04-16T03:24:12.000Z',
      },
      {
        id: 'msg:web:regenerate-duplicate-alternates:bot-dup-2',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-dup-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'bot-dup-2',
        content_text: 'second duplicate reply',
        content_json: null,
        token_estimate: 5,
        created_at: '2026-04-16T03:24:13.000Z',
      },
      {
        id: 'turn:turn-dup-2',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-dup-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_turn',
        source_ref: 'turn-dup-2',
        content_text: 'second duplicate reply',
        content_json: '{}',
        token_estimate: 5,
        created_at: '2026-04-16T03:24:13.000Z',
      },
      {
        id: 'tool_context:web:regenerate-duplicate-alternates:turn-dup-2:tool-1',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-dup-2',
        provider: 'system',
        role: 'tool',
        source_type: 'tool_call_recent',
        source_ref: 'tool-1',
        content_text: 'stale tool result from old duplicate reply',
        content_json: JSON.stringify({ sourceTurnId: 'turn-dup-2' }),
        token_estimate: 8,
        created_at: '2026-04-16T03:24:13.100Z',
      },
      {
        id: 'tool_summary:web:regenerate-duplicate-alternates:old',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: null,
        provider: 'system',
        role: 'summary',
        source_type: 'tool_call_summary',
        source_ref: 'tool_context:web:regenerate-duplicate-alternates:turn-dup-2:tool-1',
        content_text: 'summary of stale tool result from old duplicate reply',
        content_json: JSON.stringify({
          sourceEntryIds: [
            'tool_context:web:regenerate-duplicate-alternates:turn-dup-2:tool-1',
          ],
        }),
        token_estimate: 8,
        created_at: '2026-04-16T03:24:13.200Z',
      },
    ]);
    await storeContextCompaction({
      id: 'context-compaction-regenerate-duplicate-alternates',
      group_folder: group.folder,
      chat_jid: chatJid,
      compacted_until: '2026-04-16T03:24:13.000Z',
      summary_text: 'compacted stale duplicate reply',
      source_entry_ids_json: JSON.stringify([
        'msg:web:regenerate-duplicate-alternates:bot-dup-2',
      ]),
      created_at: '2026-04-16T03:24:14.000Z',
    });

    await regenerateConversationReply(chatJid, 'turn-dup-2');

    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      { id: 'user-dup', content: '@Andy answer again' },
    ]);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([]);
    const contextEntryIds = (await getContextEntries(chatJid, 50)).map(
      (entry) => entry.id,
    );
    expect(contextEntryIds).toEqual([
      'msg:web:regenerate-duplicate-alternates:user-dup',
    ]);
    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-after-regenerate',
        chat_jid: chatJid,
        sender: 'web_user',
        sender_name: 'Owner User',
        content: '@Andy continue',
        timestamp: '2026-04-16T03:24:15.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ]);
    expect(prompt.text).not.toContain('first duplicate reply');
    expect(prompt.text).not.toContain('second duplicate reply');
    expect(prompt.text).not.toContain('stale tool result');
    expect(prompt.text).not.toContain('compacted stale duplicate reply');
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('cleans interrupted turn context so partial assistant state is not reused', async () => {
    const stopActiveProcess = vi
      .spyOn(queue, 'stopActiveProcess')
      .mockReturnValue(true);

    const chatJid = 'web:interrupt-context-cleanup';
    const group: RegisteredGroup = {
      name: 'Web Chat interrupt context cleanup',
      folder: 'web_interrupt_context_cleanup',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });
    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-interrupt',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy slow request',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    activeConversationTurnIds.set(chatJid, 'turn-interrupted');
    await storeAssistantTurnSnapshot(chatJid, {
      id: 'turn-interrupted',
      timestamp: '2026-04-16T03:24:12.000Z',
      items: [
        {
          id: 'turn-interrupted:assistant',
          type: 'assistant_message',
          status: 'in_progress',
          text: 'partial assistant text that should disappear',
          timestamp: '2026-04-16T03:24:12.000Z',
        },
      ],
      isLive: true,
      isCompleted: false,
    });
    await storeContextEntries([
      {
        id: 'turn:turn-interrupted',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-interrupted',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_turn',
        source_ref: 'turn-interrupted',
        content_text: 'partial assistant text that should disappear',
        content_json: '{}',
        token_estimate: 8,
        created_at: '2026-04-16T03:24:12.000Z',
      },
      {
        id: 'tool_context:web:interrupt-context-cleanup:turn-interrupted:tool-1',
        group_folder: group.folder,
        chat_jid: chatJid,
        run_id: 'turn-interrupted',
        provider: 'system',
        role: 'tool',
        source_type: 'tool_call_recent',
        source_ref: 'tool-1',
        content_text: 'partial tool output from interrupted turn',
        content_json: JSON.stringify({ sourceTurnId: 'turn-interrupted' }),
        token_estimate: 8,
        created_at: '2026-04-16T03:24:12.100Z',
      },
    ]);

    await expect(interruptConversationReply(chatJid)).resolves.toBe(true);

    expect(stopActiveProcess).toHaveBeenCalledWith(chatJid);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([]);
    expect(await getContextEntries(chatJid, 50)).toEqual([]);
    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-after-interrupt',
        chat_jid: chatJid,
        sender: 'web_user',
        sender_name: 'Owner User',
        content: '@Andy new question',
        timestamp: '2026-04-16T03:24:13.000Z',
        is_from_me: false,
        is_bot_message: false,
      },
    ]);
    expect(prompt.text).not.toContain('partial assistant text');
    expect(prompt.text).not.toContain('partial tool output');
  });

  it('ignores stale active turn markers when regenerating a completed reply', async () => {
    const enqueueMessageCheck = vi
      .spyOn(queue, 'enqueueMessageCheck')
      .mockImplementation(() => {});

    const chatJid = 'web:regenerate-stale-active';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate stale active',
      folder: 'web_regenerate_stale_active',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-stale-active',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy retry this',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-stale-active',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'assistant reply',
        timestamp: '2026-04-16T03:24:12.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-stale-active',
        timestamp: '2026-04-16T03:24:12.000Z',
        items: [
          {
            id: 'turn-stale-active:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'assistant reply',
            timestamp: '2026-04-16T03:24:12.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-stale-active',
      },
    );
    activeConversationTurnIds.set(chatJid, 'turn-stale-active');

    await regenerateConversationReply(chatJid, 'turn-stale-active');

    expect(activeConversationTurnIds.has(chatJid)).toBe(false);
    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      { id: 'user-stale-active', content: '@Andy retry this' },
    ]);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([]);
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('allows regeneration when the agent is only idle-keeping a completed reply alive', async () => {
    const enqueueMessageCheck = vi
      .spyOn(queue, 'enqueueMessageCheck')
      .mockImplementation(() => {});

    const chatJid = 'web:regenerate-idle-keepalive';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate idle keepalive',
      folder: 'web_regenerate_idle_keepalive',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-idle-keepalive',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy retry this',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-idle-keepalive',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'assistant reply',
        timestamp: '2026-04-16T03:24:12.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-idle-keepalive',
        timestamp: '2026-04-16T03:24:12.000Z',
        items: [
          {
            id: 'turn-idle-keepalive:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'assistant reply',
            timestamp: '2026-04-16T03:24:12.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-idle-keepalive',
      },
    );

    const queueAny = queue as unknown as {
      getGroup: (jid: string) => {
        active: boolean;
        idleWaiting: boolean;
        isTaskAgent: boolean;
        process: unknown;
        groupFolder: string | null;
      };
    };
    const state = queueAny.getGroup(chatJid);
    state.active = true;
    state.isTaskAgent = false;
    state.idleWaiting = true;
    state.process = {} as any;
    state.groupFolder = group.folder;

    await regenerateConversationReply(chatJid, 'turn-idle-keepalive');

    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      { id: 'user-idle-keepalive', content: '@Andy retry this' },
    ]);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([]);
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('rejects regeneration while the agent is still actively replying', async () => {
    const chatJid = 'web:regenerate-live-turn';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate live turn',
      folder: 'web_regenerate_live_turn',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-live-turn',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy still working?',
      timestamp: '2026-04-16T03:24:11.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const queueAny = queue as unknown as {
      getGroup: (jid: string) => {
        active: boolean;
        idleWaiting: boolean;
        isTaskAgent: boolean;
        process: unknown;
        groupFolder: string | null;
      };
    };
    const state = queueAny.getGroup(chatJid);
    state.active = true;
    state.isTaskAgent = false;
    state.idleWaiting = false;
    state.process = {} as any;
    state.groupFolder = group.folder;

    await expect(
      regenerateConversationReply(chatJid, 'turn-live'),
    ).rejects.toThrow('A reply is currently in progress');
  });

  it('validates regenerate targets against the latest visible assistant message', async () => {
    const enqueueMessageCheck = vi
      .spyOn(queue, 'enqueueMessageCheck')
      .mockImplementation(() => {});

    const chatJid = 'web:regenerate-visible-latest';
    const group: RegisteredGroup = {
      name: 'Web Chat regenerate visible latest',
      folder: 'web_regenerate_visible_latest',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:08.000Z',
      'Owner User',
      'web',
      false,
      'owner-user-id',
    );
    await storeMessage({
      id: 'user-old',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy old',
      timestamp: '2026-04-16T03:24:09.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-old',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'old assistant reply',
        timestamp: '2026-04-16T03:24:10.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-old',
        timestamp: '2026-04-16T03:24:14.000Z',
        items: [
          {
            id: 'turn-old:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'old assistant reply',
            timestamp: '2026-04-16T03:24:10.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-old',
      },
    );
    await storeMessage({
      id: 'user-new',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Owner User',
      content: '@Andy new',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    await storeMessageDirectWithTurn(
      {
        id: 'bot-new',
        chat_jid: chatJid,
        sender: 'Andy',
        sender_name: 'Andy',
        content: 'new assistant reply',
        timestamp: '2026-04-16T03:24:13.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-new',
        timestamp: '2026-04-16T03:24:13.000Z',
        items: [
          {
            id: 'turn-new:assistant',
            type: 'assistant_message',
            status: 'completed',
            text: 'new assistant reply',
            timestamp: '2026-04-16T03:24:13.000Z',
          },
        ],
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-new',
      },
    );

    await regenerateConversationReply(chatJid, 'turn-new');

    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      { id: 'user-old', content: '@Andy old' },
      { id: 'bot-old', content: 'old assistant reply' },
      { id: 'user-new', content: '@Andy new' },
    ]);
    expect(
      (await getConversationTurns(chatJid, 50, 0)).map((turn) => turn.id),
    ).toEqual(['turn-old']);
    expect(_getAgentCursorState()).toMatchObject({
      committed: {
        [chatJid]: '2026-04-16T03:24:10.000Z',
      },
    });
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('persists only the failed turn for web non-retryable errors', async () => {
    const webChannel = createMockWebChannel();
    mockGetWebChannel.mockReturnValue(webChannel);
    channels.push(webChannel);

    const chatJid = 'web:test';
    const group: RegisteredGroup = {
      name: 'Web Chat test',
      folder: 'web_test',
      trigger: '@Andy',
      added_at: '2026-04-16T03:24:10.000Z',
      requiresTrigger: false,
      isMain: false,
    };
    assignRegisteredGroups({ [chatJid]: group });

    await storeChatMetadata(
      chatJid,
      '2026-04-16T03:24:10.000Z',
      'Web User',
      'web',
      false,
    );
    await storeMessage({
      id: 'user-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Web User',
      content: '@Andy hi',
      timestamp: '2026-04-16T03:24:12.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    mockRunAgentProcess.mockImplementation(
      async (
        _group: unknown,
        _input: unknown,
        _registerProcess: unknown,
        onOutput?: (output: {
          status: 'success' | 'error';
          result: string | null;
          retryable?: boolean;
          error?: string;
          turnEvent?: {
            type: 'turn.started' | 'turn.failed';
            turnId: string;
            timestamp: string;
            error?: string;
          };
        }) => Promise<void>,
      ) => {
        await onOutput?.({
          status: 'success',
          result: null,
          turnEvent: {
            type: 'turn.started',
            turnId: 'turn-1',
            timestamp: '2026-04-16T03:24:13.000Z',
          },
        });
        await onOutput?.({
          status: 'error',
          result: null,
          retryable: false,
          error:
            'Codex API 401: {"error":{"code":"","message":"Invalid token (request id: 202604160324132006325278268d9d6SvsXGiGk)","type":"new_api_error"}}',
          turnEvent: {
            type: 'turn.failed',
            turnId: 'turn-1',
            timestamp: '2026-04-16T03:24:13.000Z',
            error:
              'Invalid token (request id: 202604160324132006325278268d9d6SvsXGiGk)',
          },
        });

        return {
          status: 'error',
          error:
            'Codex API 401: {"error":{"code":"","message":"Invalid token (request id: 202604160324132006325278268d9d6SvsXGiGk)","type":"new_api_error"}}',
        };
      },
    );

    expect(await processGroupMessages(chatJid)).toBe(true);

    expect(await getConversationMessages(chatJid, 50, 0)).toMatchObject([
      {
        id: 'user-1',
        content: '@Andy hi',
        is_bot_message: false,
      },
    ]);
    expect(await getConversationTurns(chatJid, 50, 0)).toEqual([
      {
        id: 'turn-1',
        clientKey: 'turn-1',
        timestamp: '2026-04-16T03:24:13.000Z',
        items: [],
        isLive: false,
        isCompleted: true,
        error:
          'Invalid token (request id: 202604160324132006325278268d9d6SvsXGiGk)',
      },
    ]);

    expect(webChannel.notifyTurnEvent).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({
        type: 'turn.failed',
        turnId: 'turn-1',
        error:
          'Invalid token (request id: 202604160324132006325278268d9d6SvsXGiGk)',
      }),
    );
    expect(webChannel.notifyMessage).not.toHaveBeenCalled();
    expect(webChannel.sendMessage).not.toHaveBeenCalled();
  });
});
