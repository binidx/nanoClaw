import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { _initTestDatabase, dba } from '../db.js';
import type { FileStorageAdapter } from './im-file-storage.js';
import { registerImFileRoutes } from '../routes/im-file-routes.js';
import { registerImRoutes } from '../routes/im-routes.js';

const TS = '2026-05-03T00:00:00.000Z';

const allowAllRequirePermission: RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const memoryStorage: FileStorageAdapter = {
  async save() {},
  async read() {
    return { data: Buffer.from(''), mime: 'application/octet-stream' };
  },
  async delete() {},
  async exists() {
    return true;
  },
};

function addTenantUser(app: express.Express, userId = 'user-a'): void {
  app.use((req, _res, next) => {
    (
      req as express.Request & { tenantUserId?: string; locale?: string }
    ).tenantUserId = userId;
    (
      req as express.Request & { tenantUserId?: string; locale?: string }
    ).locale = 'en';
    next();
  });
}

async function addRoom(
  chatJid: string,
  userId: string,
  e2eeEnabled = 0,
): Promise<void> {
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
       VALUES (?, 'group', 'private', ?, 'Room', NULL, NULL, ?, 200, ?, ?)`,
    )
    .run(chatJid, userId, e2eeEnabled, TS, TS);
  await dba
    .prepare(
      `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
       VALUES (?, ?, 'member', NULL, 'active', NULL, ?, ?)`,
    )
    .run(chatJid, userId, TS, TS);
}

describe('IM route security', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.unstubAllGlobals();
  });

  it('does not fetch server-side link previews for E2EE rooms', async () => {
    const app = express();
    addTenantUser(app);
    registerImFileRoutes(app, {
      storage: memoryStorage,
      fileTtlMs: 0,
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_e2ee_preview', 'user-a', 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await inject(app, {
      method: 'GET',
      url: '/api/im/link-preview?chatJid=im_grp_e2ee_preview&url=https%3A%2F%2Fexample.com%2Fsecret',
    });

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects attachment binding when the upload belongs to another chat', async () => {
    const app = express();
    app.use(express.json());
    addTenantUser(app);
    registerImRoutes(app, {
      getAuthenticatedUsername: () => 'user-a',
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_target', 'user-a', 0);
    await addRoom('im_grp_other', 'user-a', 0);
    await dba
      .prepare(
        `INSERT INTO im_attachments
         (id, chat_jid, message_id, file_name, mime_type, size, storage_key, uploaded_by, expires_at, created_at)
         VALUES ('att-other', 'im_grp_other', NULL, 'secret.txt', 'text/plain', 6, 'im/other/secret.txt', 'user-a', NULL, ?)`,
      )
      .run(TS);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/conversations/im_grp_target/messages',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: '', attachmentIds: ['att-other'] }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: 'Invalid attachment for this conversation',
    });
    const attachment = (await dba
      .prepare(`SELECT message_id FROM im_attachments WHERE id = ? LIMIT 1`)
      .get('att-other')) as { message_id: string | null };
    expect(attachment.message_id).toBeNull();
    const messageCount = (await dba
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ?`)
      .get('im_grp_target')) as { count: number };
    expect(messageCount.count).toBe(0);
  });

  it('rejects E2EE room keys for a device not owned by the target user', async () => {
    const app = express();
    app.use(express.json());
    addTenantUser(app, 'user-a');
    registerImRoutes(app, {
      getAuthenticatedUsername: () => 'user-a',
      requirePermission: allowAllRequirePermission,
    });
    await dba
      .prepare(
        `INSERT OR IGNORE INTO users
         (id, username, display_name, password_hash, email, auth_source, status, created_at, updated_at)
         VALUES (?, ?, ?, 'x', NULL, 'local', 'active', ?, ?)`,
      )
      .run('user-a', 'alice', 'Alice', TS, TS);
    await dba
      .prepare(
        `INSERT OR IGNORE INTO users
         (id, username, display_name, password_hash, email, auth_source, status, created_at, updated_at)
         VALUES (?, ?, ?, 'x', NULL, 'local', 'active', ?, ?)`,
      )
      .run('user-b', 'bob', 'Bob', TS, TS);
    await addRoom('im_grp_keys', 'user-a', 1);
    await dba
      .prepare(
        `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
         VALUES ('im_grp_keys', 'user-b', 'member', NULL, 'active', NULL, ?, ?)`,
      )
      .run(TS, TS);
    await dba
      .prepare(
        `INSERT INTO im_device_keys (user_id, device_id, public_key, created_at, updated_at)
         VALUES ('user-a', 'device-a', '{"public":"a"}', ?, ?)`,
      )
      .run(TS, TS);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/conversations/im_grp_keys/e2ee/room-keys',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        keys: [
          {
            userId: 'user-b',
            deviceId: 'device-a',
            wrappedKey: '{"ciphertext":"wrong-user"}',
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: 'Room key target device does not belong to target user',
    });
    const keyCount = (await dba
      .prepare(`SELECT COUNT(*) AS count FROM im_room_keys`)
      .get()) as { count: number };
    expect(keyCount.count).toBe(0);
  });
});
