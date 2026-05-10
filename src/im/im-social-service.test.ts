import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, dba } from '../db.js';
import {
  addAiMember,
  blockImUser,
  createAiInvocation,
  getConversationPrefs,
  isImBlockedEither,
  isRoomEncrypted,
  listAiMembers,
  setRoomEncryption,
  unblockImUser,
  upsertConversationPrefs,
} from './im-social-service.js';

const TS = '2026-05-03T00:00:00.000Z';

async function addRoom(chatJid: string, e2ee = 0): Promise<void> {
  await dba
    .prepare(
      `INSERT INTO im_chat_meta
       (chat_jid, chat_type, visibility, owner_id, name, avatar_url, notice, e2ee_enabled, max_members, created_at, updated_at)
       VALUES (?, 'group', 'private', 'user-a', 'Room', NULL, NULL, ?, 200, ?, ?)`,
    )
    .run(chatJid, e2ee, TS, TS);
}

describe('IM social service', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores per-user conversation preferences', async () => {
    const initial = await getConversationPrefs('im_grp_social-1', 'user-a');
    expect(initial).toMatchObject({
      is_pinned: 0,
      is_muted: 0,
      is_archived: 0,
      draft_text: null,
    });

    const updated = await upsertConversationPrefs('im_grp_social-1', 'user-a', {
      is_pinned: 1,
      is_muted: 1,
      draft_text: 'draft',
    });

    expect(updated).toMatchObject({
      is_pinned: 1,
      is_muted: 1,
      is_archived: 0,
      draft_text: 'draft',
    });
  });

  it('tracks bidirectional block state for DM policy checks', async () => {
    await expect(isImBlockedEither('user-a', 'user-b')).resolves.toBe(false);

    await blockImUser('user-a', 'user-b');
    await expect(isImBlockedEither('user-a', 'user-b')).resolves.toBe(true);
    await expect(isImBlockedEither('user-b', 'user-a')).resolves.toBe(true);

    await unblockImUser('user-a', 'user-b');
    await expect(isImBlockedEither('user-a', 'user-b')).resolves.toBe(false);
  });

  it('removes and rejects AI members when E2EE is enabled', async () => {
    const jid = 'im_grp_social-2';
    await addRoom(jid, 0);
    await addAiMember({
      chatJid: jid,
      assistantId: 'assistant',
      displayName: 'Assistant',
      kind: 'assistant',
      createdBy: 'user-a',
    });
    await expect(listAiMembers(jid)).resolves.toHaveLength(1);

    await setRoomEncryption(jid, true);
    await expect(isRoomEncrypted(jid)).resolves.toBe(true);
    await expect(listAiMembers(jid)).resolves.toHaveLength(0);
    await expect(addAiMember({
      chatJid: jid,
      assistantId: 'assistant-2',
      displayName: 'Assistant 2',
      kind: 'assistant',
      createdBy: 'user-a',
    })).rejects.toThrow('Encrypted rooms cannot include AI members');
    await expect(createAiInvocation({
      chatJid: jid,
      assistantId: 'assistant',
      requestedBy: 'user-a',
      prompt: 'summarize',
    })).rejects.toThrow('Encrypted rooms cannot invoke AI');
  });
});
