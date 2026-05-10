import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, dba } from '../db.js';
import {
  listImEventsAfter,
  recordImEventWithSeq,
  sendImMessageWithReply,
  updateImReadCursor,
} from './im-service.js';
import {
  getEncryptedEnvelopesForMessages,
  listRoomKeysForDevice,
  saveEncryptedMessageEnvelope,
  upsertRoomKeys,
} from './im-social-service.js';

const TS = '2026-05-03T00:00:00.000Z';

async function addMember(chatJid: string, userId: string): Promise<void> {
  await dba
    .prepare(
      `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
       VALUES (?, ?, 'member', NULL, 'active', NULL, ?, ?)`,
    )
    .run(chatJid, userId, TS, TS);
}

describe('IM event sequencing', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('persists message room seq and catch-up events', async () => {
    const jid = 'im_grp_room-1';
    await addMember(jid, 'user-a');

    const message = await sendImMessageWithReply(
      jid,
      'user-a',
      'Alice',
      'hello',
    );
    expect(message.im_seq).toBe(1);

    await recordImEventWithSeq(
      jid,
      message.im_seq!,
      'im_message_created',
      { message: { id: message.id, content: message.content } },
      message.timestamp,
    );

    const events = await listImEventsAfter(jid, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      event_type: 'im_message_created',
    });
    expect(events[0]?.payload).toMatchObject({
      type: 'im_message_created',
      room_seq: 1,
      message: { id: message.id, content: 'hello' },
    });
  });

  it('stores read cursors as up-to message sequence', async () => {
    const jid = 'im_grp_room-2';
    await addMember(jid, 'user-a');

    const message = await sendImMessageWithReply(
      jid,
      'user-a',
      'Alice',
      'read me',
    );
    const cursor = await updateImReadCursor(jid, 'user-a', message.id);

    expect(cursor).toMatchObject({
      last_read_seq: message.im_seq,
    });
  });

  it('stores encrypted message envelopes separately from message content', async () => {
    const jid = 'im_grp_room-3';
    await addMember(jid, 'user-a');

    const message = await sendImMessageWithReply(
      jid,
      'user-a',
      'Alice',
      '[encrypted]',
    );
    await saveEncryptedMessageEnvelope({
      chatJid: jid,
      messageId: message.id,
      version: 1,
      algorithm: 'AES-GCM-256',
      iv: 'iv',
      aad: 'im:room',
      ciphertext: 'ciphertext',
    });

    const stored = (await dba
      .prepare(`SELECT content FROM messages WHERE id = ? LIMIT 1`)
      .get(message.id)) as { content: string };
    expect(stored.content).toBe('[encrypted]');

    const envelopes = await getEncryptedEnvelopesForMessages([message.id]);
    expect(envelopes.get(message.id)).toMatchObject({
      version: 1,
      algorithm: 'AES-GCM-256',
      ciphertext: 'ciphertext',
    });
  });

  it('scopes wrapped room keys to the target user device', async () => {
    const jid = 'im_grp_room-4';
    await upsertRoomKeys(jid, [
      {
        userId: 'user-a',
        deviceId: 'device-a',
        wrappedKey: '{"ciphertext":"a"}',
        algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM',
      },
      {
        userId: 'user-b',
        deviceId: 'device-b',
        wrappedKey: '{"ciphertext":"b"}',
        algorithm: 'ECDH-P256+HKDF-SHA256+A256GCM',
      },
    ]);

    const keys = await listRoomKeysForDevice(jid, 'user-a', 'device-a');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      user_id: 'user-a',
      device_id: 'device-a',
      wrapped_key: '{"ciphertext":"a"}',
    });
  });
});
