import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  enqueueContextCompactionJob,
  getLatestContextCompaction,
  getMemoryCompactionStats,
  setConfig,
  storeChatMetadata,
  storeContextEntries,
} from './db.js';
import { runScheduledContextCompactionPass } from './memory/compaction-scheduler.js';

describe('memory compaction worker', () => {
  const chatJid = 'memory-worker@g.us';

  beforeEach(async () => {
    _initTestDatabase();
    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_ENABLED', 'true');
    await setConfig('MEMORY_COMPACTION_TRIGGER_ENTRIES', '10');
    await setConfig('MEMORY_COMPACTION_KEEP_RECENT_ENTRIES', '2');
    await storeChatMetadata(chatJid, '2026-03-18T09:00:00.000Z');
  });

  it('processes queued compaction jobs through the background pass', async () => {
    await storeContextEntries([
      {
        id: 'msg:memory-worker:user-1',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'first user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:01.000Z',
      },
      {
        id: 'msg:memory-worker:assistant-1',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: 'first assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:02.000Z',
      },
      {
        id: 'msg:memory-worker:user-2',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-2',
        content_text: 'second user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:03.000Z',
      },
      {
        id: 'msg:memory-worker:assistant-2',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-2',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-2',
        content_text: 'second assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:04.000Z',
      },
      {
        id: 'msg:memory-worker:user-3',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-3',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-3',
        content_text: 'third user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:05.000Z',
      },
      {
        id: 'msg:memory-worker:assistant-3',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-3',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-3',
        content_text: 'third assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:06.000Z',
      },
      {
        id: 'msg:memory-worker:user-4',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-4',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-4',
        content_text: 'fourth user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:07.000Z',
      },
      {
        id: 'msg:memory-worker:assistant-4',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-4',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-4',
        content_text: 'fourth assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:08.000Z',
      },
      {
        id: 'msg:memory-worker:user-5',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-5',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-5',
        content_text: 'fifth user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:09.000Z',
      },
      {
        id: 'msg:memory-worker:assistant-5',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-5',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-5',
        content_text: 'fifth assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:10.000Z',
      },
      {
        id: 'msg:memory-worker:user-6',
        group_folder: 'memory-worker',
        chat_jid: chatJid,
        run_id: 'run-6',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-6',
        content_text: 'sixth user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2026-03-18T09:00:11.000Z',
      },
    ]);
    await enqueueContextCompactionJob({
      chatJid,
      groupFolder: 'memory-worker',
      now: '2026-03-18T09:00:12.000Z',
    });

    const processed = await runScheduledContextCompactionPass({
      now: new Date('2026-03-18T09:00:15.000Z'),
      onlyChatJid: chatJid,
    });

    expect(processed).toBe(1);
    expect((await getLatestContextCompaction(chatJid))?.source_entry_ids_json).toBe(
      JSON.stringify([
        'msg:memory-worker:user-1',
        'msg:memory-worker:assistant-1',
        'msg:memory-worker:user-2',
        'msg:memory-worker:assistant-2',
        'msg:memory-worker:user-3',
        'msg:memory-worker:assistant-3',
        'msg:memory-worker:user-4',
        'msg:memory-worker:assistant-4',
        'msg:memory-worker:user-5',
      ]),
    );

    const stats = await getMemoryCompactionStats({
      now: new Date('2026-03-18T09:10:00.000Z'),
    });
    expect(stats.worker.pendingJobs).toBe(0);
    expect(stats.worker.recentRuns24h).toBe(1);
    expect(stats.worker.lastSuccessAt).toBeTruthy();
  });
});
