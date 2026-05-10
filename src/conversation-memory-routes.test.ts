import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getContextEntries,
  getConversationIdentityBinding,
  getPersonProfile,
  getUserMemories,
  listMemoryEvents,
  searchMemoryDocuments,
  setConfig,
  setRegisteredGroup,
  storeChatMetadata,
  storeContextEntry,
} from './db.js';
import { assembleAgentContext } from './memory/context-assembly.js';
import { registerConversationMemoryRoutes } from './routes/conversation-memory-routes.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const createdPaths: string[] = [];

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

function createApp() {
  const app = express();
  app.use(express.json());
  registerConversationMemoryRoutes(app, {
    requirePermission: allowAllRequirePermission,
  });
  return app;
}

describe('conversation memory routes', () => {
  const chatJid = 'web:memory-actions';
  const groupFolder = 'memory-actions-group';

  beforeEach(async () => {
    _initTestDatabase();
    await setConfig('MEMORY_ENABLED', 'true');
    await setConfig('MEMORY_READ_ENABLED', 'true');
    await setConfig('MEMORY_WRITE_MODE', 'daily-only');
    await setConfig('MEMORY_AUTO_SAVE_ENABLED', 'true');
    await setConfig('MEMORY_PROMPT_INJECTION_ENABLED', 'true');
    await storeChatMetadata(chatJid, '2026-03-20T10:00:00.000Z', 'Web User', 'web', false);
    await setRegisteredGroup(chatJid, {
      name: 'Web User',
      folder: groupFolder,
      trigger: '',
      added_at: '2026-03-20T10:00:00.000Z',
      requiresTrigger: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('remembers identity text through the web route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-action-'));
    createdPaths.push(root);
    const groupDir = path.join(root, 'groups');
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(path.join(groupDir, groupFolder, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');

    await withServer(createApp(), async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent(chatJid)}/memory-actions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'remember',
            messageId: 'msg-user-1',
            sender: 'alice',
            senderName: 'Alice',
            text: '我叫 ady，以后都这么称呼我。',
          }),
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.result.memoryClass).toBe('identity');
      expect(payload.result.sourceType).toBe('identity_memory');
      expect(payload.result.pathRef).toBe('global:memory/identity/ady.md');
    });

    expect((await getConversationIdentityBinding(chatJid))?.person_id).toBe('ady');
    expect((await getPersonProfile('ady'))?.display_name).toBe('ady');
    expect(
      (await searchMemoryDocuments('ady', {
        ownerType: 'person',
        ownerId: 'ady',
        sourceTypes: ['identity_memory'],
      }))[0]?.pathRef,
    ).toBe('global:memory/identity/ady.md');
  });

  it('stores session-only memory without writing durable memory', async () => {
    await withServer(createApp(), async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent(chatJid)}/memory-actions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'session_only',
            messageId: 'msg-user-2',
            text: '这次会话里先别用表格。',
          }),
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.result.memoryClass).toBe('session');
      expect(payload.result.sourceType).toBe('post_compaction_context');
    });

    const entries = await getContextEntries(chatJid, 10);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'memory',
          source_type: 'post_compaction_context',
          source_ref: 'msg-user-2',
          content_text: '仅当前会话有效：这次会话里先别用表格。',
        }),
      ]),
    );
  });

  it('writes explicit non-identity remember actions to user memory projection and recalls it', async () => {
    await setConfig('MEMORY_GLOBAL_WRITE_ENABLED', 'true');

    let memoryId = '';
    await withServer(createApp(), async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent(chatJid)}/memory-actions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'remember',
            messageId: 'msg-user-3',
            text: '以后默认用中文简洁回复。',
          }),
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.result.sourceType).toBe('user_memory');
      expect(payload.result.pathRef).toMatch(/^user_memory:/);
      memoryId = payload.result.memoryId;
      expect(memoryId).toBeTruthy();
    });

    const memories = await getUserMemories('__system__', { timeScope: 'all' });
    expect(memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: memoryId,
          content: '以后默认用中文简洁回复。',
          source: 'manual',
        }),
      ]),
    );
    expect(
      (await searchMemoryDocuments('中文简洁', {
        ownerType: 'global',
        ownerId: '__system__',
        sourceTypes: ['user_memory'],
      }))[0],
    ).toEqual(
      expect.objectContaining({
        pathRef: `user_memory:${memoryId}`,
        sourceType: 'user_memory',
      }),
    );

    await storeContextEntry({
      id: 'ctx-user-3',
      group_folder: groupFolder,
      chat_jid: chatJid,
      run_id: null,
      provider: 'web',
      role: 'user',
      source_type: 'chat_message',
      source_ref: 'msg-user-previous',
      content_text: '上一条消息',
      content_json: null,
      token_estimate: null,
      created_at: '2026-03-20T10:01:00.000Z',
    });

    const prompt = await assembleAgentContext(chatJid, [
      {
        id: 'msg-current',
        chat_jid: chatJid,
        sender: 'user',
        sender_name: 'Web User',
        content: '中文简洁',
        timestamp: '2026-03-20T10:02:00.000Z',
      },
    ]);

    expect(prompt).toContain('memory_source="user_memory"');
    expect(prompt).toContain('以后默认用中文简洁回复。');
    expect(await listMemoryEvents({ actionType: 'RECALL', targetId: memoryId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_type: 'user_memory',
          target_id: memoryId,
          conversation_id: chatJid,
        }),
      ]),
    );
  });
});
