import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  bindConversationIdentity,
  compactContextEntries,
  createPersonProfile,
  getContextEntries,
  setConfig,
  storeChatMetadata,
  storeContextEntries,
} from './db.js';
import {
  _buildAgentPromptInputForTest,
  _clearScheduledContextCompactionsForTest,
} from './index.js';
import { persistToolContextFromTurn } from './memory/tool-context.js';
import type { NewMessage } from './types.js';

describe('agent context assembly', () => {
  const chatJid = 'chat-context-1';
  const createdPaths: string[] = [];

  beforeEach(async () => {
    _initTestDatabase();
    _clearScheduledContextCompactionsForTest();
    await storeChatMetadata(chatJid, '2026-03-17T10:00:00.000Z');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('injects recent context entries before current messages', async () => {
    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-1',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: '@Andy 上次说周五发版',
        content_json: null,
        token_estimate: 5,
        created_at: '2026-03-17T10:00:01.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-1',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: '好的，我记住周五晚间发版。',
        content_json: null,
        token_estimate: 6,
        created_at: '2026-03-17T10:00:02.000Z',
      },
    ]);
    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-2',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 再提醒下发版安排',
        timestamp: '2026-03-17T10:01:00.000Z',
        is_from_me: false,
      },
    ]);

    expect(prompt.text).toContain('<recent_context>');
    expect(prompt.text).toContain('上次说周五发版');
    expect(prompt.text).toContain('好的，我记住周五晚间发版');
    expect(prompt.text).toContain('<messages>');
    expect(prompt.text).toContain('再提醒下发版安排');
  });

  it('does not duplicate the current message when it already exists in context_entries', async () => {
    const currentMessage: NewMessage = {
      id: 'user-3',
      chat_jid: chatJid,
      sender: 'alice',
      sender_name: 'Alice',
      content: '@Andy 帮我总结今天的讨论',
      timestamp: '2026-03-17T10:02:00.000Z',
      is_from_me: false,
    };

    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-3',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-3',
        content_text: currentMessage.content,
        content_json: null,
        token_estimate: 6,
        created_at: currentMessage.timestamp,
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [currentMessage]);

    expect(prompt.text).not.toContain('<recent_context>');
    expect(prompt.text.match(/帮我总结今天的讨论/g)?.length).toBe(1);
  });

  it('keeps recent raw chat ahead of compacted summaries', async () => {
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '4');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '2');

    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-a',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-a',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-a',
        content_text: '第一轮用户问题',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:00:01.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-a',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-a',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-a',
        content_text: '第一轮助手回复',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:00:02.000Z',
      },
      {
        id: 'msg:chat-context-1:user-b',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-b',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-b',
        content_text: '第二轮用户问题',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:00:03.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-b',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-b',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-b',
        content_text: '第二轮助手回复',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:00:04.000Z',
      },
      {
        id: 'msg:chat-context-1:user-c',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-c',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-c',
        content_text: '第三轮用户问题',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:00:05.000Z',
      },
    ]);
    await compactContextEntries({
      chatJid,
      triggerEntries: 4,
      keepRecentEntries: 2,
    });

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 继续处理最新问题',
        timestamp: '2026-03-17T10:01:00.000Z',
        is_from_me: false,
      },
    ]);

    const summaryIndex = prompt.text.indexOf('Earlier conversation summary (3 messages through 2026-03-17T10:00:03.000Z):');
    const assistantIndex = prompt.text.indexOf('第二轮助手回复');
    const userIndex = prompt.text.indexOf('第三轮用户问题');
    expect(prompt.text).toContain('<entry role="summary" source="compaction_summary"');
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeLessThan(summaryIndex);
    expect(userIndex).toBeLessThan(summaryIndex);
    expect(prompt.text.match(/<entry /g)?.length).toBe(3);
  });

  it('keeps recent raw chat ahead of memory recall entries', async () => {
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '2');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');

    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-raw',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-raw',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-raw',
        content_text: '上一条普通历史消息',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:07:01.000Z',
      },
      {
        id: 'memory-recall-1',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: null,
        provider: 'system',
        role: 'memory',
        source_type: 'memory_recall',
        source_ref: 'group:memory/2026-03-17.md',
        content_text: '000001|以后默认用简洁回复',
        content_json: JSON.stringify({
          path: 'group:memory/2026-03-17.md',
          scope: 'group',
          lineStart: 1,
          lineEnd: 1,
        }),
        token_estimate: 4,
        created_at: '2026-03-17T10:07:02.000Z',
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-memory-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 继续当前问题',
        timestamp: '2026-03-17T10:08:00.000Z',
        is_from_me: false,
      },
    ]);

    const recentContextIndex = prompt.text.indexOf('<recent_context>');
    const recallIndex = prompt.text.indexOf('以后默认用简洁回复');
    const rawIndex = prompt.text.indexOf('上一条普通历史消息');
    expect(recentContextIndex).toBeGreaterThanOrEqual(0);
    expect(rawIndex).toBeGreaterThan(recentContextIndex);
    expect(recallIndex).toBeGreaterThan(rawIndex);
    expect(prompt.contextBlocks?.some((entry) => entry.source === 'memory_recall_tool')).toBe(
      true,
    );
    expect(prompt.contextBlocks?.some((entry) => entry.source === 'context_chat_recent')).toBe(
      true,
    );
  });

  it('injects recent tool context after chat and before summaries', async () => {
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-tool-history',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-tool-history',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-tool-history',
        content_text: '先看一下最近做过什么',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:11:00.000Z',
      },
      {
        id: 'tool-summary-1',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: null,
        provider: 'system',
        role: 'summary',
        source_type: 'tool_call_summary',
        source_ref: 'tool-recent-0',
        content_text: 'Earlier tool activity summary (1 calls through 2026-03-17T10:10:00.000Z):\n\nCapabilities demonstrated:\n- Image generation capability available via mcp__mflux__generate',
        content_json: JSON.stringify({
          sourceEntryIds: ['tool-recent-0'],
          callCount: 1,
        }),
        token_estimate: 12,
        created_at: '2026-03-17T10:11:30.000Z',
      },
      {
        id: 'tool-recent-0',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'turn-old',
        provider: 'system',
        role: 'tool',
        source_type: 'tool_call_recent',
        source_ref: 'tool-old',
        content_text: 'Tool: mcp__mflux__generate\nStatus: completed\nIntent: old image generation',
        content_json: JSON.stringify({
          toolName: 'mcp__mflux__generate',
          status: 'completed',
          intent: 'old image generation',
          sourceEntryIds: ['tool-old'],
        }),
        token_estimate: 10,
        created_at: '2026-03-17T10:10:00.000Z',
      },
      {
        id: 'tool-recent-1',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'turn-new',
        provider: 'system',
        role: 'tool',
        source_type: 'tool_call_recent',
        source_ref: 'tool-new',
        content_text: 'Tool: read_file\nStatus: completed\nIntent: inspect chat page\nResult: ok',
        content_json: JSON.stringify({
          toolName: 'read_file',
          status: 'completed',
          intent: 'inspect chat page',
          resultSummary: 'ok',
          sourceEntryIds: ['tool-new'],
        }),
        token_estimate: 10,
        created_at: '2026-03-17T10:12:00.000Z',
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-tool-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 继续看最近的工具活动',
        timestamp: '2026-03-17T10:13:00.000Z',
        is_from_me: false,
      },
    ]);

    const chatIndex = prompt.text.indexOf('先看一下最近做过什么');
    const toolIndex = prompt.text.indexOf('Tool: read_file');
    const summaryIndex = prompt.text.indexOf('Earlier tool activity summary');
    expect(chatIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(chatIndex);
    expect(summaryIndex).toBeGreaterThan(toolIndex);
    expect(prompt.text).not.toContain('Intent: old image generation');
    expect(prompt.contextBlocks?.some((entry) => entry.source === 'context_tool_recent')).toBe(
      true,
    );
    expect(prompt.contextBlocks?.some((entry) => entry.source === 'context_tool_summary')).toBe(
      true,
    );
  });

  it('does not auto-inject bound identity memory without an explicit memory recall entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-context-memory-'));
    createdPaths.push(root);
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');

    await createPersonProfile({
      id: 'ady',
      displayName: 'ady',
      notes: ['我叫 ady，以后都这么称呼我', '用户偏好简洁回复'],
      aliases: [{ displayName: 'Alice' }],
    });
    await bindConversationIdentity({
      chatJid,
      groupFolder: 'ctx-group',
      personId: 'ady',
    });
    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-history',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-history',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-history',
        content_text: '上一条普通历史消息',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:09:01.000Z',
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-identity-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 请记住 ady 的简洁回复偏好',
        timestamp: '2026-03-17T10:10:00.000Z',
        is_from_me: false,
      },
    ]);

    expect(prompt.text).not.toContain('用户偏好简洁回复');
    expect(prompt.text).toContain('上一条普通历史消息');
  });

  it('does not create a compaction summary as a side effect of prompt assembly', async () => {
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '4');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '2');

    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-sideeffect-a',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-sideeffect-a',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-sideeffect-a',
        content_text: '第一条历史消息',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:05:01.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-sideeffect-a',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-sideeffect-a',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-sideeffect-a',
        content_text: '第一条历史回复',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:05:02.000Z',
      },
      {
        id: 'msg:chat-context-1:user-sideeffect-b',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-sideeffect-b',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-sideeffect-b',
        content_text: '第二条历史消息',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:05:03.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-sideeffect-b',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-sideeffect-b',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-sideeffect-b',
        content_text: '第二条历史回复',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:05:04.000Z',
      },
      {
        id: 'msg:chat-context-1:user-sideeffect-c',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-sideeffect-c',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-sideeffect-c',
        content_text: '第三条历史消息',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:05:05.000Z',
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-sideeffect-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 现在只读上下文',
        timestamp: '2026-03-17T10:06:00.000Z',
        is_from_me: false,
      },
    ]);

    expect(prompt.text).toContain('第二条历史消息');
    expect(prompt.text).toContain('第二条历史回复');
    expect(prompt.text).toContain('第三条历史消息');
    expect(prompt.text).not.toContain('compaction_summary');
    expect(prompt.text).not.toContain('Earlier conversation summary');
  });

  it('creates rolling tool summaries that preserve image-generation capability hints', async () => {
    await persistToolContextFromTurn({
      groupFolder: 'ctx-group',
      chatJid,
      turn: {
        id: 'turn-image-tools',
        clientKey: 'turn-image-tools',
        timestamp: '2026-03-17T10:20:00.000Z',
        isLive: false,
        isCompleted: true,
        items: [
          {
            id: 'tool-1',
            type: 'tool_call',
            status: 'completed',
            title: 'mcp__mflux__generate',
            argumentsText: '{"prompt":"sunset poster"}',
            resultText: 'image saved to assets/poster-1.png',
            timestamp: '2026-03-17T10:14:00.000Z',
          },
          {
            id: 'tool-2',
            type: 'tool_call',
            status: 'completed',
            title: 'mcp__mflux__generate',
            argumentsText: '{"prompt":"cover art"}',
            resultText: 'image saved to assets/poster-2.png',
            timestamp: '2026-03-17T10:15:00.000Z',
          },
          {
            id: 'tool-3',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"src/index.ts"}',
            resultText: 'ok',
            timestamp: '2026-03-17T10:16:00.000Z',
          },
          {
            id: 'tool-4',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"src/db.ts"}',
            resultText: 'ok',
            timestamp: '2026-03-17T10:17:00.000Z',
          },
          {
            id: 'tool-5',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"src/router.ts"}',
            resultText: 'ok',
            timestamp: '2026-03-17T10:18:00.000Z',
          },
          {
            id: 'tool-6',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"src/types.ts"}',
            resultText: 'ok',
            timestamp: '2026-03-17T10:19:00.000Z',
          },
          {
            id: 'tool-7',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"src/runtime.ts"}',
            resultText: 'ok',
            timestamp: '2026-03-17T10:20:00.000Z',
          },
        ],
      },
    });

    const entries = await getContextEntries(chatJid, 200);
    expect(entries.filter((entry) => entry.source_type === 'tool_call_recent')).toHaveLength(7);
    expect(entries.filter((entry) => entry.source_type === 'tool_call_summary')).toHaveLength(1);
    const toolSummary = entries.find((entry) => entry.source_type === 'tool_call_summary');
    expect(toolSummary?.content_text).toContain(
      'Image generation capability available via mcp__mflux__generate',
    );
  });

  it('skips recent_context injection when memory prompt injection is disabled', async () => {
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'false');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '2');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '1');

    await storeContextEntries([
      {
        id: 'msg:chat-context-1:user-disabled',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-disabled',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-disabled',
        content_text: '这条上下文不应该被注入',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:03:00.000Z',
      },
      {
        id: 'msg:chat-context-1:assistant-disabled',
        group_folder: 'ctx-group',
        chat_jid: chatJid,
        run_id: 'run-disabled',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-disabled',
        content_text: '这条回复也不应该被注入',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-17T10:03:01.000Z',
      },
    ]);

    const prompt = await _buildAgentPromptInputForTest(chatJid, [
      {
        id: 'user-disabled-current',
        chat_jid: chatJid,
        sender: 'alice',
        sender_name: 'Alice',
        content: '@Andy 只看当前消息',
        timestamp: '2026-03-17T10:04:00.000Z',
        is_from_me: false,
      },
    ]);

    expect(prompt.text).not.toContain('<recent_context>');
    expect(prompt.text).toContain('只看当前消息');
  });
});
