import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getConversationIdentityBinding,
  enqueueContextCompactionJob,
  getLatestContextCompaction,
  getMemoryPromotionStats,
  getPersonProfile,
  searchMemoryDocuments,
  setConfig,
  storeChatMetadata,
  storeContextEntries,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { runScheduledContextCompactionPass } from './memory/compaction-scheduler.js';
import { autoPromoteMemoryFromEntries } from './memory/ingest-promotion.js';

describe('memory promotion pipeline', () => {
  const chatJid = 'memory-promotion@g.us';
  const groupFolder = 'memory-promotion-test';

  function getDailyMemoryPath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return path.join(
      resolveGroupFolderPath(groupFolder),
      'memory',
      `${year}-${month}-${day}.md`,
    );
  }

  beforeEach(async () => {
    _initTestDatabase();
    fs.rmSync(resolveGroupFolderPath(groupFolder), {
      recursive: true,
      force: true,
    });
    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_WRITE_MODE', 'daily-only');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '10');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '1');
    await storeChatMetadata(chatJid, '2026-03-18T15:00:00.000Z');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(resolveGroupFolderPath(groupFolder), {
      recursive: true,
      force: true,
    });
  });

  it('extracts durable candidates from compaction and writes them to group daily memory', async () => {
    await storeContextEntries([
      {
        id: 'msg:promotion:user-1',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: '以后默认用简洁回复。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:01.000Z',
      },
      {
        id: 'msg:promotion:assistant-1',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: '收到，我后续默认简洁回复。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:02.000Z',
      },
      {
        id: 'msg:promotion:user-2',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-2',
        content_text: '记住，称呼我为老板。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:03.000Z',
      },
      {
        id: 'msg:promotion:assistant-2',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-2',
        content_text: '好的，我记住了。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:04.000Z',
      },
      {
        id: 'msg:promotion:user-3',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-3',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-3',
        content_text: '现在继续当前任务。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:05.000Z',
      },
      {
        id: 'msg:promotion:assistant-3',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-3',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-3',
        content_text: '好的，继续处理。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:06.000Z',
      },
      {
        id: 'msg:promotion:user-4',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-4',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-4',
        content_text: '补充一条偏好：回复用中文。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:07.000Z',
      },
      {
        id: 'msg:promotion:assistant-4',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-4',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-4',
        content_text: '明白，后续默认中文回复。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:08.000Z',
      },
      {
        id: 'msg:promotion:user-5',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-5',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-5',
        content_text: '再记一条：会议记录在 docs 目录。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:09.000Z',
      },
      {
        id: 'msg:promotion:assistant-5',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-5',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-5',
        content_text: '收到，我会把会议记录放到 docs。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:10.000Z',
      },
      {
        id: 'msg:promotion:user-6',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-6',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-6',
        content_text: '继续推进实现。',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T15:00:11.000Z',
      },
    ]);

    await enqueueContextCompactionJob({
      chatJid,
      groupFolder,
      now: '2026-03-18T15:00:12.000Z',
    });
    const processed = await runScheduledContextCompactionPass({
      now: new Date('2026-03-18T15:00:15.000Z'),
      onlyChatJid: chatJid,
    });

    expect(processed).toBe(1);
    expect((await getLatestContextCompaction(chatJid))?.summary_text).toContain(
      'Key durable candidates:',
    );
    expect((await getLatestContextCompaction(chatJid))?.summary_text).toContain(
      '[preference] 以后默认用简洁回复',
    );

    const memoryFile = getDailyMemoryPath();
    const saved = fs.readFileSync(memoryFile, 'utf8');
    expect(saved).toContain('[preference] 以后默认用简洁回复');
    expect(saved).toContain('[preference] 记住，称呼我为老板');

    const stats = await getMemoryPromotionStats();
    expect(stats.candidates24h).toBe(3);
    expect(stats.writes24h).toBe(3);
    expect(stats.deduped24h).toBe(0);
    expect(stats.latestPromotionAt).toBeTruthy();
    expect(stats.byAction24h).toMatchObject({
      auto: 6,
      remember: 0,
      session_only: 0,
    });
    expect(stats.byOrigin24h).toMatchObject({
      compaction_candidate: 6,
    });
  });

  it('auto-promotes identity and global durable facts during message ingestion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-auto-'));
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');

    const entries = [
      {
        id: 'msg:auto:user-1',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-auto-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-auto-1',
        content_text: '我叫 ady，以后都这么称呼我。',
        content_json: JSON.stringify({
          sender: 'alice',
          sender_name: 'Alice',
        }),
        token_estimate: 6,
        created_at: '2026-03-18T15:10:01.000Z',
      },
      {
        id: 'msg:auto:user-2',
        group_folder: groupFolder,
        chat_jid: chatJid,
        run_id: 'run-auto-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-auto-2',
        content_text: '以后默认用中文回复。',
        content_json: JSON.stringify({
          sender: 'alice',
          sender_name: 'Alice',
        }),
        token_estimate: 4,
        created_at: '2026-03-18T15:10:02.000Z',
      },
    ] as const;

    await autoPromoteMemoryFromEntries({
      groupFolder,
      chatJid,
      entries: [...entries],
    });

    const identityBinding = await getConversationIdentityBinding(chatJid);
    expect(identityBinding?.person_id).toBe('ady');
    expect((await getPersonProfile('ady'))?.display_name).toBe('ady');
    expect(
      JSON.parse((await getPersonProfile('ady'))?.notes_json || '[]') as string[],
    ).toContain('我叫 ady，以后都这么称呼我');

    const identityDocs = await searchMemoryDocuments('ady', {
      ownerType: 'person',
      ownerId: 'ady',
      sourceTypes: ['identity_memory'],
    });
    expect(identityDocs[0]?.pathRef).toBe('global:memory/identity/ady.md');
    expect(identityDocs[0]?.sourceType).toBe('identity_memory');

    const now = new Date();
    const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(now.getDate()).padStart(2, '0')}`;
    const globalDailyPath = path.join(globalDir, 'memory', `${dateStamp}.md`);
    expect(fs.readFileSync(globalDailyPath, 'utf8')).toContain(
      '以后默认用中文回复',
    );
    expect(
      fs.readFileSync(path.join(globalDir, 'memory', 'identity', 'ady.md'), 'utf8'),
    ).toContain('我叫 ady，以后都这么称呼我');
  });
});
