import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMemoryIdentityService,
  type MemoryIdentityRepository,
  type MemoryIdentityProfile,
} from './memory/identity-service.js';
import { registerMemoryIdentityRoutes } from './routes/memory-identity-routes.js';

const allowAllRequirePermission: import('./auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createRepository(): MemoryIdentityRepository {
  const profiles = new Map<string, MemoryIdentityProfile>();
  const bindings = new Map<
    string,
    { chatJid: string; groupFolder: string; personId: string; boundAt: string }
  >();
  return {
    listProfiles: () => [...profiles.values()],
    getProfile: (id) => profiles.get(id) || null,
    createProfile: ({ id, displayName, notes, aliases }) => {
      const now = '2026-03-19T00:00:00.000Z';
      const profile: MemoryIdentityProfile = {
        id,
        displayName,
        notes,
        aliases,
        createdAt: now,
        updatedAt: now,
      };
      profiles.set(id, profile);
      return profile;
    },
    bindConversation: ({ chatJid, groupFolder, personId }) => {
      const binding = {
        chatJid,
        groupFolder,
        personId,
        boundAt: '2026-03-19T00:01:00.000Z',
      };
      bindings.set(chatJid, binding);
      return binding;
    },
    listBindingsForPerson: (personId) =>
      [...bindings.values()].filter((binding) => binding.personId === personId),
  };
}

describe('memory identity service', () => {
  let repository: MemoryIdentityRepository;

  beforeEach(() => {
    repository = createRepository();
  });

  it('normalizes ids, notes, and aliases when creating a profile', async () => {
    const service = createMemoryIdentityService(repository);

    const profile = await service.createProfile({
      displayName: ' Alice Boss ',
      notes: [' prefers concise replies ', 'prefers concise replies', ''],
      aliases: [
        {
          channel: ' Telegram ',
          externalUserId: ' 123 ',
          displayName: ' Boss Alice ',
        },
        {
          channel: 'telegram',
          externalUserId: '123',
          displayName: 'Boss Alice',
        },
      ],
    });

    expect(profile).toMatchObject({
      id: 'alice-boss',
      displayName: 'Alice Boss',
      notes: ['prefers concise replies'],
      aliases: [
        {
          channel: 'telegram',
          externalUserId: '123',
          displayName: 'Boss Alice',
        },
      ],
    });
  });

  it('rejects binding to a missing profile', async () => {
    const service = createMemoryIdentityService(repository);

    await expect(
      service.bindConversation({
        chatJid: 'chat-1',
        groupFolder: 'group-1',
        personId: 'missing-user',
      }),
    ).rejects.toThrow(/Identity not found/i);
  });
});

describe('memory identity routes', () => {
  it('creates and fetches identities through the route layer', async () => {
    const service = createMemoryIdentityService(createRepository());
    const auditMutation = vi.fn();
    const app = express();
    app.use(express.json());
    registerMemoryIdentityRoutes(app, {
      requirePermission: allowAllRequirePermission,
      service,
      auditMutation,
    });

    const createResponse = await inject(app, {
      method: 'POST',
      url: '/api/memory/identities',
      payload: {
        displayName: 'Alice Boss',
        notes: ['prefers concise replies'],
      },
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdPayload = createResponse.json() as {
      identity: MemoryIdentityProfile;
    };
    expect(createdPayload.identity.id).toBe('alice-boss');
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'memory.identities.create',
      'high',
    );

    const listResponse = await inject(app, {
      method: 'GET',
      url: '/api/memory/identities',
    });
    expect(listResponse.statusCode).toBe(200);
    const listPayload = listResponse.json() as {
      identities: MemoryIdentityProfile[];
    };
    expect(listPayload.identities).toHaveLength(1);

    const detailResponse = await inject(app, {
      method: 'GET',
      url: '/api/memory/identities/alice-boss',
    });
    expect(detailResponse.statusCode).toBe(200);
    const detailPayload = detailResponse.json() as {
      identity: { profile: MemoryIdentityProfile; bindings: unknown[] };
    };
    expect(detailPayload.identity.profile.displayName).toBe('Alice Boss');
    expect(detailPayload.identity.bindings).toHaveLength(0);
  });

  it('binds a conversation to an existing identity', async () => {
    const service = createMemoryIdentityService(createRepository());
    service.createProfile({ displayName: 'Boss Alice' });
    const auditMutation = vi.fn();
    const app = express();
    app.use(express.json());
    registerMemoryIdentityRoutes(app, {
      requirePermission: allowAllRequirePermission,
      service,
      auditMutation,
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/memory/identities/bind',
      payload: {
        chatJid: 'telegram:chat-1',
        groupFolder: 'tg-chat-1',
        personId: 'boss-alice',
      },
      headers: {
        'content-type': 'application/json',
      },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      binding: { personId: string; groupFolder: string };
    };
    expect(payload.binding).toMatchObject({
      personId: 'boss-alice',
      groupFolder: 'tg-chat-1',
    });
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'memory.identities.bind',
      'high',
    );
  });
});
