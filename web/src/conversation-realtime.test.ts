import { describe, expect, it } from 'vitest';

import { normalizeConversationRealtimeEvent } from './conversation-realtime';

describe('normalizeConversationRealtimeEvent IM events', () => {
  it('normalizes IM message-created envelopes with message payload metadata', () => {
    const normalized = normalizeConversationRealtimeEvent({
      kind: 'realtime',
      version: 1,
      event_type: 'im_event',
      jid: 'im_grp_room-1',
      seq: 7,
      state_version: 7,
      event_id: 'evt-1',
      timestamp: '2026-05-03T00:00:00.000Z',
      payload: {
        type: 'im_message_created',
        jid: 'im_grp_room-1',
        room_seq: 7,
        message: {
          id: 'msg-1',
          chat_jid: 'im_grp_room-1',
          sender: 'user-a',
          sender_name: 'Alice',
          content: 'hello',
          timestamp: '2026-05-03T00:00:00.000Z',
          im_seq: 7,
          attachments: [
            {
              id: 'file-1',
              fileName: 'spec.txt',
              mimeType: 'text/plain',
              size: 12,
              url: '/api/im/files/file-1',
            },
          ],
        },
      },
    });

    expect(normalized).toMatchObject({
      kind: 'im_event',
      jid: 'im_grp_room-1',
      eventType: 'im_message_created',
      seq: 7,
      message: {
        id: 'msg-1',
        chat_jid: 'im_grp_room-1',
        im_seq: 7,
        attachments: [{ id: 'file-1' }],
      },
    });
  });
});
