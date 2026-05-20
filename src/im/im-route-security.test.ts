import crypto from 'crypto';
import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { _initTestDatabase, dba } from '../db.js';
import type { FileStorageAdapter } from './im-file-storage.js';
import { runImFileCleanupPass } from './im-file-cleanup.js';
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

function multipartBody(
  parts: Array<{
    name: string;
    value: string | Buffer;
    filename?: string;
    contentType?: string;
  }>,
): { payload: Buffer; contentType: string } {
  const boundary = `----nanoclaw-${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${
          part.filename ? `; filename="${part.filename}"` : ''
        }\r\n${
          part.contentType ? `Content-Type: ${part.contentType}\r\n` : ''
        }\r\n`,
      ),
    );
    chunks.push(
      Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
    );
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

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
    vi.restoreAllMocks();
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

  it('rejects plaintext attachment uploads in E2EE rooms', async () => {
    const app = express();
    addTenantUser(app);
    const storage = {
      ...memoryStorage,
      save: vi.fn(async () => undefined),
    };
    registerImFileRoutes(app, {
      storage,
      fileTtlMs: 0,
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_e2ee_upload', 'user-a', 1);
    const multipart = multipartBody([
      { name: 'chatJid', value: 'im_grp_e2ee_upload' },
      {
        name: 'file',
        filename: 'secret.txt',
        contentType: 'text/plain',
        value: 'secret',
      },
    ]);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/files/upload',
      headers: { 'content-type': multipart.contentType },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: 'Encrypted rooms require encrypted attachment metadata',
    });
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('accepts ciphertext attachment uploads with E2EE metadata', async () => {
    const app = express();
    addTenantUser(app);
    const storage = {
      ...memoryStorage,
      save: vi.fn(async () => undefined),
    };
    registerImFileRoutes(app, {
      storage,
      fileTtlMs: 0,
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_e2ee_ciphertext_upload', 'user-a', 1);
    const multipart = multipartBody([
      { name: 'chatJid', value: 'im_grp_e2ee_ciphertext_upload' },
      { name: 'encrypted', value: 'true' },
      {
        name: 'encryptedMetadata',
        value: JSON.stringify({
          version: 1,
          algorithm: 'AES-GCM-256',
          iv: Buffer.alloc(12, 1).toString('base64'),
        }),
      },
      {
        name: 'file',
        filename: 'encrypted.bin',
        contentType: 'application/octet-stream',
        value: Buffer.from('ciphertext'),
      },
    ]);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/files/upload',
      headers: { 'content-type': multipart.contentType },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(storage.save).toHaveBeenCalledOnce();
    const attachment = JSON.parse(response.body).attachment;
    expect(attachment).toMatchObject({
      fileName: 'encrypted.bin',
      mimeType: 'application/octet-stream',
    });
  });

  it('deletes saved storage when IM attachment DB insert fails', async () => {
    const app = express();
    addTenantUser(app);
    const deleted: string[] = [];
    const storage: FileStorageAdapter = {
      save: vi.fn(async () => undefined),
      async read() {
        return { data: Buffer.from(''), mime: 'application/octet-stream' };
      },
      async delete(key: string) {
        deleted.push(key);
      },
      async exists() {
        return true;
      },
    };
    registerImFileRoutes(app, {
      storage,
      fileTtlMs: 0,
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_upload_rollback', 'user-a', 0);
    const duplicateId =
      '11111111-1111-4111-8111-111111111111' as ReturnType<
        typeof crypto.randomUUID
      >;
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(duplicateId);
    await dba
      .prepare(
        `INSERT INTO im_attachments
         (id, chat_jid, message_id, file_name, mime_type, size, storage_key, uploaded_by, expires_at, created_at)
         VALUES (?, 'im_grp_upload_rollback', NULL, 'existing.txt', 'text/plain', 1, 'im/existing.txt', 'user-a', NULL, ?)`,
      )
      .run(duplicateId, TS);
    const multipart = multipartBody([
      { name: 'chatJid', value: 'im_grp_upload_rollback' },
      {
        name: 'file',
        filename: 'new.txt',
        contentType: 'text/plain',
        value: 'new',
      },
    ]);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/files/upload',
      headers: { 'content-type': multipart.contentType },
      payload: multipart.payload,
    });

    expect(response.statusCode).toBe(500);
    expect(storage.save).toHaveBeenCalledOnce();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain(duplicateId.slice(0, 8));
  });

  it('cleans stale IM attachment rows and storage-only orphan files', async () => {
    await addRoom('im_grp_cleanup', 'user-a', 0);
    await dba
      .prepare(
        `INSERT INTO im_attachments
         (id, chat_jid, message_id, file_name, mime_type, size, storage_key, uploaded_by, expires_at, created_at)
         VALUES
         ('att-expired', 'im_grp_cleanup', 'msg-1', 'expired.txt', 'text/plain', 1, 'im/expired.txt', 'user-a', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
         ('att-orphan', 'im_grp_cleanup', NULL, 'orphan.txt', 'text/plain', 1, 'im/orphan.txt', 'user-a', NULL, '2026-05-01T00:00:00.000Z'),
         ('att-live', 'im_grp_cleanup', 'msg-2', 'live.txt', 'text/plain', 1, 'im/live.txt', 'user-a', NULL, '2026-05-01T00:00:00.000Z')`,
      )
      .run();
    const deleted: string[] = [];
    const storageKeys = new Map([
      ['im/expired.txt', Date.parse('2026-05-01T00:00:00.000Z')],
      ['im/orphan.txt', Date.parse('2026-05-01T00:00:00.000Z')],
      ['im/live.txt', Date.parse('2026-05-01T00:00:00.000Z')],
      ['im/storage-only.txt', Date.parse('2026-05-01T00:00:00.000Z')],
      ['im/new-storage-only.txt', Date.parse('2026-05-06T11:59:00.000Z')],
    ]);
    const storage: FileStorageAdapter = {
      async save() {},
      async read() {
        return { data: Buffer.from(''), mime: 'application/octet-stream' };
      },
      async delete(key: string) {
        deleted.push(key);
        storageKeys.delete(key);
      },
      async exists() {
        return true;
      },
      async listKeys() {
        return Array.from(storageKeys, ([key, mtimeMs]) => ({
          key,
          mtimeMs,
        }));
      },
    };

    const summary = await runImFileCleanupPass(storage, {
      now: new Date('2026-05-06T12:00:00.000Z'),
      orphanAttachmentAgeMs: 60 * 60 * 1000,
    });

    expect(summary.deletedAttachmentRows).toBe(2);
    expect(summary.deletedOrphanStorageKeys).toEqual(['im/storage-only.txt']);
    expect(deleted).toEqual([
      'im/expired.txt',
      'im/orphan.txt',
      'im/storage-only.txt',
    ]);
    const rows = (await dba
      .prepare(`SELECT id FROM im_attachments ORDER BY id`)
      .all()) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['att-live']);
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

  it('rejects message reads for users without active room membership', async () => {
    const app = express();
    app.use(express.json());
    addTenantUser(app, 'user-b');
    registerImRoutes(app, {
      getAuthenticatedUsername: () => 'user-b',
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_private_read', 'user-a', 0);
    await dba
      .prepare(
        `INSERT INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
         VALUES ('msg-private', 'im_grp_private_read', 'user-a', 'Alice', 'secret', ?, 1, 0)`,
      )
      .run(TS);

    const response = await inject(app, {
      method: 'GET',
      url: '/api/im/conversations/im_grp_private_read/messages',
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: 'Forbidden',
    });
  });

  it('rejects message sends for inactive room members without creating messages', async () => {
    const app = express();
    app.use(express.json());
    addTenantUser(app, 'user-b');
    registerImRoutes(app, {
      getAuthenticatedUsername: () => 'user-b',
      requirePermission: allowAllRequirePermission,
    });
    await addRoom('im_grp_inactive_send', 'user-a', 0);
    await dba
      .prepare(
        `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
         VALUES ('im_grp_inactive_send', 'user-b', 'member', NULL, 'kicked', NULL, ?, ?)`,
      )
      .run(TS, TS);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/im/conversations/im_grp_inactive_send/messages',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'should not persist' }),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: 'Forbidden',
    });
    const messageCount = (await dba
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE chat_jid = ?`)
      .get('im_grp_inactive_send')) as { count: number };
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
