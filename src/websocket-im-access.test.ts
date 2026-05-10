import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, dba } from './db.js';
import { checkRealtimeConversationAccess } from './web/websocket-handlers.js';

describe('IM websocket access', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('allows active IM members to subscribe without conversation ownership', async () => {
    await dba
      .prepare(
        `INSERT INTO im_memberships (chat_jid, user_id, role, nickname, status, muted_until, joined_at, updated_at)
         VALUES (?, ?, 'member', NULL, 'active', NULL, ?, ?)`,
      )
      .run('im_grp_room-1', 'user-a', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z');

    await expect(checkRealtimeConversationAccess('im_grp_room-1', 'user-a')).resolves.toBe(true);
    await expect(checkRealtimeConversationAccess('im_grp_room-1', 'user-b')).resolves.toBe(false);
  });
});
