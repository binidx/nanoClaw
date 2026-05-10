import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getMemoryPromotionStats,
  listMemoryDocuments,
  searchMemoryDocuments,
  setConfig,
  storeChatMetadata,
  storeContextEntries,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { _buildAgentPromptInputForTest } from './index.js';
import { autoPromoteMemoryFromEntries } from './memory/ingest-promotion.js';
import type { ContextEntryRecord, NewMessage } from './types.js';

function createUserEntry(input: {
  id: string;
  chatJid: string;
  groupFolder: string;
  text: string;
  timestamp: string;
  sender?: string;
  senderName?: string;
}): ContextEntryRecord {
  return {
    id: input.id,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: `run:${input.id}`,
    provider: 'claude',
    role: 'user',
    source_type: 'chat_message',
    source_ref: input.id,
    content_text: input.text,
    content_json: JSON.stringify({
      sender: input.sender || 'alice',
      sender_name: input.senderName || 'Alice',
    }),
    token_estimate: Math.max(1, Math.ceil(input.text.length / 4)),
    created_at: input.timestamp,
  };
}

function createCurrentMessage(input: {
  chatJid: string;
  id: string;
  text: string;
  timestamp: string;
}): NewMessage {
  return {
    id: input.id,
    chat_jid: input.chatJid,
    sender: 'alice',
    sender_name: 'Alice',
    content: input.text,
    timestamp: input.timestamp,
    is_from_me: false,
  };
}

describe('memory offline eval fixtures', () => {
  const createdPaths: string[] = [];

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.rmSync(resolveGroupFolderPath('memory-eval-project-rule'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(resolveGroupFolderPath('memory-eval-false-positive'), {
      recursive: true,
      force: true,
    });
  });

  it('covers identity recall across later turns', () => {
    const groupFolder = 'memory-eval-identity';
    const chatJid = 'memory-eval-identity@g.us';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-eval-'));
    const globalDir = path.join(root, 'global');
    createdPaths.push(root);
    fs.mkdirSync(globalDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');
    await storeChatMetadata(chatJid, '2026-03-19T10:00:00.000Z');

    autoPromoteMemoryFromEntries({
      groupFolder,
      chatJid,
      entries: [
        createUserEntry({
          id: 'identity-1',
          chatJid,
          groupFolder,
          text: '我叫 ady，以后都这么称呼我。',
          timestamp: '2026-03-19T10:00:01.000Z',
        }),
      ],
    });
    await storeContextEntries([
      createUserEntry({
        id: 'identity-history',
        chatJid,
        groupFolder,
        text: '上一轮我在确认称呼。',
        timestamp: '2026-03-19T10:01:00.000Z',
      }),
    ]);

    const prompt = _buildAgentPromptInputForTest(chatJid, [
      createCurrentMessage({
        chatJid,
        id: 'identity-ask',
        text: '你记得我叫什么吗？后面直接这样称呼我。',
        timestamp: '2026-03-19T10:02:00.000Z',
      }),
    ]);

    expect(prompt.text).toContain('source="memory_recall"');
    expect(prompt.text).toContain('我叫 ady，以后都这么称呼我');
    expect(
      await searchMemoryDocuments('ady', {
        ownerType: 'person',
        ownerId: 'ady',
        sourceTypes: ['identity_memory'],
      })[0]?.pathRef,
    ).toBe('global:memory/identity/ady.md');
  });

  it('covers preference recall through global durable memory', () => {
    const groupFolder = 'memory-eval-preference';
    const chatJid = 'memory-eval-preference@g.us';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-eval-'));
    const globalDir = path.join(root, 'global');
    createdPaths.push(root);
    fs.mkdirSync(globalDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');
    await storeChatMetadata(chatJid, '2026-03-19T11:00:00.000Z');

    autoPromoteMemoryFromEntries({
      groupFolder,
      chatJid,
      entries: [
        createUserEntry({
          id: 'preference-1',
          chatJid,
          groupFolder,
          text: '以后默认用中文回复。',
          timestamp: '2026-03-19T11:00:01.000Z',
        }),
      ],
    });
    const results = await searchMemoryDocuments('中文回复', {
      scopes: ['global'],
      ownerType: 'global',
      ownerId: 'global',
      sourceTypes: ['memory_file'],
    });

    expect(results[0]?.pathRef?.startsWith('global:memory/')).toBe(true);
    expect(results[0]?.body).toContain('以后默认用中文回复');
    expect(
      await listMemoryDocuments({
        ownerType: 'global',
        ownerId: 'global',
      }).some((doc) => doc.path_ref?.startsWith('global:memory/')),
    ).toBe(true);
  });

  it('covers project-rule recall through group durable memory', () => {
    const groupFolder = 'memory-eval-project-rule';
    const chatJid = 'memory-eval-project-rule@g.us';

    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'false');
    await storeChatMetadata(chatJid, '2026-03-19T12:00:00.000Z');

    autoPromoteMemoryFromEntries({
      groupFolder,
      chatJid,
      entries: [
        createUserEntry({
          id: 'project-rule-1',
          chatJid,
          groupFolder,
          text: '这个项目里默认不要用表格，优先给命令行步骤。',
          timestamp: '2026-03-19T12:00:01.000Z',
        }),
      ],
    });
    const results = await searchMemoryDocuments('命令行步骤', {
      scopes: ['group'],
      ownerType: 'group',
      ownerId: groupFolder,
      sourceTypes: ['memory_file'],
    });

    expect(results[0]?.pathRef?.startsWith('group:memory/')).toBe(true);
    expect(results[0]?.body).toContain('这个项目里默认不要用表格');
    expect(results[0]?.body).toContain('优先给命令行步骤');
  });

  it('guards against false positive durable writes for temporary instructions', () => {
    const groupFolder = 'memory-eval-false-positive';
    const chatJid = 'memory-eval-false-positive@g.us';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-eval-'));
    const globalDir = path.join(root, 'global');
    createdPaths.push(root);
    fs.mkdirSync(globalDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_MAX_SNIPPETS', '3');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'false');
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');
    await storeChatMetadata(chatJid, '2026-03-19T13:00:00.000Z');

    autoPromoteMemoryFromEntries({
      groupFolder,
      chatJid,
      entries: [
        createUserEntry({
          id: 'false-positive-1',
          chatJid,
          groupFolder,
          text: '这次先别用表格。',
          timestamp: '2026-03-19T13:00:01.000Z',
        }),
        createUserEntry({
          id: 'false-positive-2',
          chatJid,
          groupFolder,
          text: '今天先试一下这个方案，不用长期记住。',
          timestamp: '2026-03-19T13:00:02.000Z',
        }),
      ],
    });

    expect(await getMemoryPromotionStats()).toMatchObject({
      candidates24h: 0,
      writes24h: 0,
      deduped24h: 0,
    });
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toHaveLength(0);
    expect(
      await listMemoryDocuments({
        ownerType: 'global',
        ownerId: 'global',
      }),
    ).toHaveLength(0);
  });
});
