import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { createShare, getShareById } from './db/shares.js';
import {
  registerPublicShareRoutes,
  registerShareRoutes,
} from './routes/share-routes.js';
import { runWithTenantAsync } from './tenant/tenant-context.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp(getUserId: () => string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { tenantUserId?: string }).tenantUserId =
      getUserId();
    next();
  });
  registerShareRoutes(app, { requirePermission: allowAllRequirePermission });
  return app;
}

function createPublicApp() {
  const app = express();
  registerPublicShareRoutes(app);
  return app;
}

async function seedConversation(ownerId: string) {
  const jid = 'web:share-owned';
  await storeChatMetadata(
    jid,
    '2026-05-20T00:00:00.000Z',
    'Share Owned',
    'web',
    false,
    ownerId,
  );
  await runWithTenantAsync({ userId: ownerId }, async () => {
    await storeMessageDirect({
      id: 'msg-user-1',
      chat_jid: jid,
      sender: ownerId,
      sender_name: 'Owner',
      content: 'Server-side user content',
      timestamp: '2026-05-20T00:01:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    });
    await storeMessageDirect({
      id: 'msg-bot-1',
      chat_jid: jid,
      sender: 'assistant',
      sender_name: 'Assistant',
      content: 'Server-side assistant content',
      timestamp: '2026-05-20T00:02:00.000Z',
      is_from_me: false,
      is_bot_message: true,
    });
  });
  return jid;
}

describe('share routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('rebuilds shared entries from server-side conversation data', async () => {
    let currentUserId = 'user-share-owner';
    const app = createApp(() => currentUserId);
    const jid = await seedConversation(currentUserId);

    const response = await inject(app, {
      method: 'POST',
      url: '/api/conversations/share',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        jid,
        title: 'Share title',
        assistantName: 'Assistant',
        entries: [
          {
            kind: 'user_message',
            key: 'message:msg-user-1',
            timestamp: '2026-05-20T00:01:00.000Z',
            order: 0,
            pending: false,
            message: {
              id: 'msg-user-1',
              content: 'Client-forged user content',
            },
          },
          {
            kind: 'assistant_message',
            key: 'message:msg-bot-1',
            timestamp: '2026-05-20T00:02:00.000Z',
            order: 1,
            text: 'Client-forged assistant content',
            status: 'completed',
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    const { shareId } = JSON.parse(response.body) as { shareId: string };
    const share = await getShareById(shareId);
    expect(share).toBeTruthy();
    const entries = JSON.parse(share!.content) as Array<Record<string, any>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'user_message',
      key: 'message:msg-user-1',
      message: { content: 'Server-side user content' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'assistant_message',
      key: 'message:msg-bot-1',
      text: 'Server-side assistant content',
    });
  });

  it('rejects share creation for conversations owned by another user', async () => {
    let currentUserId = 'user-share-owner';
    const app = createApp(() => currentUserId);
    const jid = await seedConversation(currentUserId);
    currentUserId = 'user-share-other';

    const response = await inject(app, {
      method: 'POST',
      url: '/api/conversations/share',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        jid,
        entries: [{ key: 'message:msg-user-1' }],
      }),
    });

    expect(response.statusCode).toBe(403);
  });

  it('serves public share tokens without requiring an authenticated route guard', async () => {
    await createShare(
      'share-token-public',
      'web:public-share',
      'Public Share',
      JSON.stringify([{ kind: 'assistant_message', text: 'public answer' }]),
      'Assistant',
      'user-share-owner',
      'user-share-owner',
    );
    const app = createPublicApp();

    const response = await inject(app, {
      method: 'GET',
      url: '/api/share/share-token-public',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      id: 'share-token-public',
      title: 'Public Share',
      assistantName: 'Assistant',
      createdBy: 'user-share-owner',
      entries: [{ kind: 'assistant_message', text: 'public answer' }],
    });
    await vi.waitFor(async () => {
      const share = await getShareById('share-token-public');
      expect(share?.view_count).toBe(1);
    });
  });

  it('does not let a user delete another user share token', async () => {
    await createShare(
      'share-token-owned',
      'web:owned-share',
      'Owned Share',
      JSON.stringify([{ kind: 'assistant_message', text: 'owned answer' }]),
      'Assistant',
      'user-share-owner',
      'user-share-owner',
    );
    let currentUserId = 'user-share-other';
    const app = createApp(() => currentUserId);

    const response = await inject(app, {
      method: 'DELETE',
      url: '/api/share/share-token-owned',
    });

    expect(response.statusCode).toBe(404);
    expect(await getShareById('share-token-owned')).toBeTruthy();
    currentUserId = 'user-share-owner';
    const ownerResponse = await inject(app, {
      method: 'DELETE',
      url: '/api/share/share-token-owned',
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(await getShareById('share-token-owned')).toBeNull();
  });
});
