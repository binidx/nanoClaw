import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import inject from 'light-my-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  addUserMemory,
  bindConversationIdentity,
  createPersonProfile,
  getContextEntries,
  getMemorySearchStats,
  getUserMemories,
  listMemoryDocuments,
  listMemoryEvents,
  storeChatMetadata,
  upsertMemoryDocuments,
} from './db.js';
import { registerInternalMemoryRoutes } from './routes/internal-memory-routes.js';
import type { UserMemoryRecord } from './types.js';

const createdPaths: string[] = [];

describe('internal memory routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('persists a memory recall entry via the internal route', async () => {
    await storeChatMetadata('memory-route@g.us', '2026-03-17T10:00:00.000Z');

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/recall',
      payload: {
        chatJid: 'memory-route@g.us',
        groupFolder: 'memory-route-group',
        path: 'group:memory/2026-03-17.md',
        scope: 'group',
        lineStart: 3,
        lineEnd: 4,
        text: '000003|以后默认用简洁回复',
        score: 8,
        searchQuery: '简洁 回复',
        searchRank: 1,
        searchMatchedAt: '2026-03-17T10:01:00.000Z',
        searchResultCount: 3,
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as { ok: boolean; id: string };
    expect(payload.ok).toBe(true);
    expect(payload.id).toContain('memory_recall:');

    const entries = await getContextEntries('memory-route@g.us', 20);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      group_folder: 'memory-route-group',
      chat_jid: 'memory-route@g.us',
      role: 'memory',
      source_type: 'memory_recall',
      source_ref: 'group:memory/2026-03-17.md',
    });
    expect(entries[0]?.content_text).toContain('以后默认用简洁回复');
    expect(JSON.parse(entries[0]?.content_json || '{}')).toMatchObject({
      lineStart: 3,
      lineEnd: 4,
      scope: 'group',
      score: 8,
      search: {
        query: '简洁 回复',
        rank: 1,
        matchedAt: '2026-03-17T10:01:00.000Z',
        resultCount: 3,
      },
    });
  });

  it('searches indexed memory through the internal route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-internal-memory-'));
    createdPaths.push(root);
    const groupDir = path.join(root, 'group');
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'MEMORY.md'),
      ['# Durable Notes', 'Deployment window is Friday night.', 'Owner: Alice'].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(globalDir, 'memory', '2026-03-17.md'),
      ['# Daily', 'Alice asked for a Friday deployment reminder.'].join('\n'),
      'utf8',
    );
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/search',
      payload: {
        chatJid: 'memory-route@g.us',
        groupFolder: 'memory-route-group',
        query: 'Friday deployment',
        scope: 'all',
        maxResults: 4,
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      results: Array<{ path: string; snippet: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results).toHaveLength(2);
    expect(payload.results.map((entry) => entry.path)).toContain(
      'group:MEMORY.md',
    );
    expect(payload.results.map((entry) => entry.path)).toContain(
      'global:memory/2026-03-17.md',
    );
  });

  it('saves user memory through the unified projection path', async () => {
    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/user/save',
      payload: {
        userId: 'memory-user',
        content: 'User prefers concise Chinese answers.',
        category: 'preference',
        scope: 'group',
        conversationId: 'web:memory-user',
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as { ok: boolean; id: string };
    expect(payload.ok).toBe(true);
    const memories = await getUserMemories('memory-user', { timeScope: 'all' });
    expect(memories).toEqual([
      expect.objectContaining({
        id: payload.id,
        scope: 'global',
        content: 'User prefers concise Chinese answers.',
      }),
    ]);
    expect(
      await listMemoryDocuments({
        ownerType: 'global',
        ownerId: 'memory-user',
        sourceType: 'user_memory',
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: `user_memory:${payload.id}`,
        source_type: 'user_memory',
      }),
    ]);
    expect(await listMemoryEvents({ targetType: 'user_memory', targetId: payload.id })).toEqual([
      expect.objectContaining({
        action_type: 'ADD',
        decision_reason: 'source=agent_tool',
      }),
    ]);
  });

  it('searches bound identity memory before returning regular file hits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-internal-identity-'));
    createdPaths.push(root);
    const groupDir = path.join(root, 'group');
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'MEMORY.md'),
      ['# Durable Notes', '项目里保持简洁回复。'].join('\n'),
      'utf8',
    );
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    await storeChatMetadata('memory-route@g.us', '2026-03-17T10:00:00.000Z');
    await createPersonProfile({
      id: 'ady',
      displayName: 'ady',
      notes: ['我叫 ady，以后都这么称呼我', '用户偏好简洁回复'],
      aliases: [{ displayName: 'Alice' }],
    });
    await bindConversationIdentity({
      chatJid: 'memory-route@g.us',
      groupFolder: 'memory-route-group',
      personId: 'ady',
    });

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/search',
      payload: {
        chatJid: 'memory-route@g.us',
        groupFolder: 'memory-route-group',
        query: 'ady 简洁回复',
        scope: 'group',
        maxResults: 4,
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      results: Array<{
        path: string;
        sourceType: string;
        memoryClass: string;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results[0]?.path).toBe('global:memory/identity/ady.md');
    expect(payload.results[0]?.sourceType).toBe('identity_memory');
    expect(payload.results[0]?.memoryClass).toBe('identity');
  });

  it('refreshes stale indexed hits before returning snippets', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-internal-memory-stale-'));
    createdPaths.push(root);
    const groupDir = path.join(root, 'group');
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    const memoryFile = path.join(groupDir, 'MEMORY.md');
    fs.writeFileSync(
      memoryFile,
      ['# Durable Notes', 'Deployment window is Friday night.', 'Owner: Alice'].join('\n'),
      'utf8',
    );
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const first = await inject(app, {
      method: 'POST',
      url: '/internal/memory/search',
      payload: {
        chatJid: 'memory-route@g.us',
        groupFolder: 'memory-route-group',
        query: 'deployment',
        scope: 'group',
        maxResults: 4,
      },
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(first.statusCode).toBe(200);

    fs.writeFileSync(
      memoryFile,
      ['# Durable Notes', 'Deployment window is Saturday morning.', 'Owner: Alice'].join(
        '\n',
      ),
      'utf8',
    );
    fs.utimesSync(
      memoryFile,
      new Date('2026-03-19T11:00:00.000Z'),
      new Date('2026-03-19T11:00:00.000Z'),
    );

    const second = await inject(app, {
      method: 'POST',
      url: '/internal/memory/search',
      payload: {
        chatJid: 'memory-route@g.us',
        groupFolder: 'memory-route-group',
        query: 'deployment',
        scope: 'group',
        maxResults: 4,
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(second.statusCode).toBe(200);
    const payload = second.json() as {
      ok: boolean;
      results: Array<{ path: string; snippet: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.path).toBe('group:MEMORY.md');
    expect(payload.results[0]?.snippet).toContain('Saturday morning');
    expect(payload.results[0]?.snippet).not.toContain('Friday night');
  });

  it('indexes a single memory file through the internal route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-index-memory-'));
    createdPaths.push(root);
    const groupDir = path.join(root, 'group');
    const globalDir = path.join(root, 'global');
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'memory', '2026-03-19.md'),
      ['# Daily Memory 2026-03-19', '', '- 08:30 Remember Friday deployment'].join('\n'),
      'utf8',
    );
    vi.stubEnv('NANOCLAW_GROUP_DIR', groupDir);
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/index-file',
      payload: {
        groupFolder: 'memory-route-group',
        path: 'group:memory/2026-03-19.md',
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      indexed: boolean;
      path: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.indexed).toBe(true);
    expect(payload.path).toBe('group:memory/2026-03-19.md');

    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: 'memory-route-group',
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'group:memory/2026-03-19.md',
        source_type: 'memory_file',
      }),
    ]);
  });

  it('repairs missing and orphaned user memory projections', async () => {
    const memory: UserMemoryRecord = {
      id: 'projection-memory',
      user_id: 'projection-user',
      scope: 'global',
      conversation_id: null,
      category: 'preference',
      content: 'User wants architectural memory recalls to prefer ledger evidence.',
      importance: 7,
      confidence: 0.9,
      source: 'manual',
      tier: 'durable',
      promoted_from: null,
      last_verified_at: null,
      source_event_id: null,
      valid_from: '2026-05-20T00:00:00.000Z',
      valid_to: null,
      access_count: 0,
      last_accessed_at: null,
      expires_at: null,
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-05-20T00:00:00.000Z',
    };
    await addUserMemory(memory);
    await addUserMemory({
      ...memory,
      id: 'projection-expired-memory',
      content: 'This older preference should no longer be searchable.',
      valid_from: '2026-05-01T00:00:00.000Z',
      valid_to: '2026-05-20T00:00:00.000Z',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    });
    await upsertMemoryDocuments([
      {
        doc_id: 'user-memory:orphan-projection',
        scope: 'global',
        owner_type: 'global',
        owner_id: 'projection-user',
        path_ref: 'user_memory:orphan-projection',
        source_type: 'user_memory',
        title: 'orphaned user memory',
        body: 'This projection no longer has a source user memory.',
        metadata_json: JSON.stringify({ memoryId: 'orphan-projection' }),
        updated_at: '2026-05-20T00:01:00.000Z',
      },
      {
        doc_id: 'user-memory:projection-expired-memory',
        scope: 'global',
        owner_type: 'global',
        owner_id: 'projection-user',
        path_ref: 'user_memory:projection-expired-memory',
        source_type: 'user_memory',
        title: 'expired user memory',
        body: 'This projection has a backing user memory, but it is no longer current.',
        metadata_json: JSON.stringify({ memoryId: 'projection-expired-memory' }),
        updated_at: '2026-05-20T00:02:00.000Z',
      },
    ]);

    const beforeStats = await getMemorySearchStats();
    expect(beforeStats.userMemoryProjection).toMatchObject({
      sourceMemories: 1,
      projectedDocuments: 2,
      missingDocuments: 1,
      orphanDocuments: 2,
    });

    const app = express();
    app.use(express.json());
    registerInternalMemoryRoutes(app, {
      requireInternalApi: (_req, _res, next) => next(),
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/internal/memory/user/repair-projections',
      payload: {
        userId: 'projection-user',
      },
      headers: {
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      ok: boolean;
      checkedMemories: number;
      projectedDocuments: number;
      deletedOrphans: number;
      after: {
        missingDocuments: number;
        orphanDocuments: number;
      };
    };
    expect(payload).toMatchObject({
      ok: true,
      checkedMemories: 1,
      projectedDocuments: 1,
      deletedOrphans: 2,
      after: {
        missingDocuments: 0,
        orphanDocuments: 0,
      },
    });
    expect(
      (
        await listMemoryDocuments({
          ownerType: 'global',
          ownerId: 'projection-user',
          sourceType: 'user_memory',
          limit: 10,
        })
      ).map((document) => document.path_ref),
    ).toEqual(['user_memory:projection-memory']);
    expect(
      (await listMemoryEvents({ targetType: 'memory_document', limit: 10 }))
        .map((event) => ({
          action: event.action_type,
          targetId: event.target_id,
          reason: event.decision_reason,
        })),
    ).toEqual(
      expect.arrayContaining([
        {
          action: 'ADD',
          targetId: 'user-memory:projection-memory',
          reason: 'repair_user_memory_projection',
        },
        {
          action: 'DELETE',
          targetId: 'user-memory:orphan-projection',
          reason: 'repair_user_memory_projection_orphan',
        },
        {
          action: 'DELETE',
          targetId: 'user-memory:projection-expired-memory',
          reason: 'repair_user_memory_projection_orphan',
        },
      ]),
    );
  });
});
