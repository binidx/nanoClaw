import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultAssistantConfig } from '../assistant/assistant-config.js';
import {
  _initTestDatabase,
  createAssistant,
  createProvider,
  dba,
} from '../db.js';
import {
  addAiMember,
  createAiInvocation,
  setRoomEncryption,
} from './im-social-service.js';
import { processImAiInvocation } from './im-ai-service.js';

const TS = '2026-05-03T00:00:00.000Z';

async function addRoom(chatJid: string, userId = 'user-a'): Promise<void> {
  await dba
    .prepare(
      `INSERT INTO chats (jid, name, is_group, channel, user_id, last_message_time)
       VALUES (?, 'Room', 1, 'web', '__im__', ?)`,
    )
    .run(chatJid, TS);
  await dba
    .prepare(
      `INSERT INTO im_chat_meta
       (chat_jid, chat_type, visibility, owner_id, name, avatar_url, notice, e2ee_enabled, max_members, created_at, updated_at)
       VALUES (?, 'group', 'private', ?, 'Room', NULL, NULL, 0, 200, ?, ?)`,
    )
    .run(chatJid, userId, TS, TS);
  await dba
    .prepare(
      `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
       VALUES (?, ?, 'owner', NULL, 'active', NULL, ?, ?)`,
    )
    .run(chatJid, userId, TS, TS);
}

async function addAssistantWithProvider(
  assistantId = 'assistant-1',
): Promise<void> {
  await createProvider({
    id: 'provider-1',
    alias: 'Provider',
    type: 'openai',
    api_key: 'test-key',
    base_url: 'https://example.invalid/v1',
    model: 'test-model',
    extra_config: null,
    is_default: 1,
    user_id: '__system__',
    visibility: 'public',
  });
  const config = createDefaultAssistantConfig();
  config.providerId = 'provider-1';
  config.model = 'assistant-model';
  await createAssistant({
    id: assistantId,
    name: 'Assistant',
    enabled: true,
    config,
    userId: '__system__',
    visibility: 'shared',
  });
}

describe('IM AI invocation execution', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('runs a queued AI invocation and writes the reply as an AI member message', async () => {
    const jid = 'im_grp_ai-1';
    await addRoom(jid);
    await addAssistantWithProvider();
    await addAiMember({
      chatJid: jid,
      assistantId: 'assistant-1',
      displayName: 'Assistant',
      kind: 'assistant',
      createdBy: 'user-a',
    });
    const invocation = await createAiInvocation({
      chatJid: jid,
      assistantId: 'assistant-1',
      requestedBy: 'user-a',
      prompt: 'Say hello',
    });

    const result = await processImAiInvocation(invocation.id, {
      generateReply: async (context) => {
        expect(context.invocation.prompt).toBe('Say hello');
        expect(context.member.display_name).toBe('Assistant');
        expect(context.provider?.model).toBe('assistant-model');
        expect(context.systemPrompt).not.toContain('Conversation soul instructions are the primary voice');
        return 'Hello from IM AI';
      },
      notifyEvent: () => {},
    });

    expect(result.status).toBe('completed');
    const row = (await dba
      .prepare(
        `SELECT status, completed_at FROM im_ai_invocations WHERE id = ?`,
      )
      .get(invocation.id)) as { status: string; completed_at: string | null };
    expect(row.status).toBe('completed');
    expect(row.completed_at).toBeTruthy();
    const message = (await dba
      .prepare(
        `SELECT sender, sender_name, content, is_bot_message, run_id, im_seq
         FROM messages
         WHERE chat_jid = ?
         LIMIT 1`,
      )
      .get(jid)) as {
      sender: string;
      sender_name: string;
      content: string;
      is_bot_message: number;
      run_id: string | null;
      im_seq: number | null;
    };
    expect(message).toMatchObject({
      sender: 'assistant-1',
      sender_name: 'Assistant',
      content: 'Hello from IM AI',
      is_bot_message: 1,
      run_id: invocation.id,
    });
    expect(message.im_seq).toBe(2);
  });

  it('keeps assistant-style IM invocations on the lightweight IM base prompt', async () => {
    const jid = 'im_grp_ai-3';
    await addRoom(jid);
    await addAssistantWithProvider('assistant-2');
    await addAiMember({
      chatJid: jid,
      assistantId: 'assistant-2',
      displayName: 'Assistant',
      kind: 'assistant',
      createdBy: 'user-a',
    });
    const invocation = await createAiInvocation({
      chatJid: jid,
      assistantId: 'assistant-2',
      requestedBy: 'user-a',
      prompt: 'Summarize the room',
    });

    const result = await processImAiInvocation(invocation.id, {
      generateReply: async (context) => {
        expect(context.systemPrompt).toContain('You are replying inside an instant-message room as "Assistant".');
        expect(context.systemPrompt).not.toContain('Conversation soul instructions are the primary voice');
        expect(context.systemPrompt).not.toContain('You are a helpful coding assistant with access to tools.');
        return 'done';
      },
      notifyEvent: () => {},
    });

    expect(result.status).toBe('completed');
  });

  it('does not let IM invocations use an assistant provider invisible to the requester', async () => {
    const jid = 'im_grp_ai-private-provider';
    await addRoom(jid);
    await createProvider({
      id: 'provider-private',
      alias: 'Private Provider',
      type: 'openai',
      api_key: 'test-key',
      base_url: 'https://example.invalid/v1',
      model: 'test-model',
      extra_config: null,
      is_default: 0,
      user_id: '__system__',
      visibility: 'restricted',
      created_by: 'user-b',
      updated_by: 'user-b',
    });
    const config = createDefaultAssistantConfig();
    config.providerId = 'provider-private';
    await createAssistant({
      id: 'assistant-private-provider',
      name: 'Assistant',
      enabled: true,
      config,
      userId: '__system__',
      visibility: 'shared',
    });
    await addAiMember({
      chatJid: jid,
      assistantId: 'assistant-private-provider',
      displayName: 'Assistant',
      kind: 'assistant',
      createdBy: 'user-a',
    });
    const invocation = await createAiInvocation({
      chatJid: jid,
      assistantId: 'assistant-private-provider',
      requestedBy: 'user-a',
      prompt: 'Use hidden provider',
    });

    const result = await processImAiInvocation(invocation.id, {
      generateReply: async () => {
        throw new Error('generateReply should not run for invisible provider');
      },
      notifyEvent: () => {},
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'Assistant provider is not visible to IM requester',
    });
  });

  it('fails a queued invocation without reading or replying after E2EE is enabled', async () => {
    const jid = 'im_grp_ai-2';
    await addRoom(jid);
    await addAssistantWithProvider();
    await addAiMember({
      chatJid: jid,
      assistantId: 'assistant-1',
      displayName: 'Assistant',
      kind: 'assistant',
      createdBy: 'user-a',
    });
    const invocation = await createAiInvocation({
      chatJid: jid,
      assistantId: 'assistant-1',
      requestedBy: 'user-a',
      prompt: 'Read this',
    });
    await setRoomEncryption(jid, true);

    const rowAfterEnable = (await dba
      .prepare(`SELECT status FROM im_ai_invocations WHERE id = ?`)
      .get(invocation.id)) as { status: string };
    expect(rowAfterEnable.status).toBe('failed');

    const result = await processImAiInvocation(invocation.id, {
      generateReply: async () => {
        throw new Error('generateReply should not run for encrypted rooms');
      },
      notifyEvent: () => {},
    });

    expect(result).toMatchObject({ status: 'skipped' });
    const row = (await dba
      .prepare(`SELECT status FROM im_ai_invocations WHERE id = ?`)
      .get(invocation.id)) as { status: string };
    expect(row.status).toBe('failed');
    const messageCount = (await dba
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ?`)
      .get(jid)) as { count: number };
    expect(messageCount.count).toBe(0);
  });
});
