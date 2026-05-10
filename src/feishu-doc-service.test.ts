import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  storeChatMetadata,
  upsertConversationParticipant,
} from './db.js';
import {
  __testing as feishuTesting,
  createFeishuDocByJid,
  getFeishuChatContextByJid,
  grantFeishuDocToChatByJid,
  grantFeishuDocToUsersByJid,
  populateFeishuDocByJid,
  resolveFeishuDmCounterpartOpenIdByJid,
  resolveFeishuDocUrlByJid,
} from './channels/feishu.js';
import {
  continueFeishuCloudDocProvision,
  createFeishuCloudDoc,
  prepareFeishuCloudDoc,
} from './channels/feishu-doc-service.js';

const GROUP_CHAT_JID = 'feishu:oc_review_chat';
const DM_CHAT_JID = 'feishu:oc_dm_chat';

type TestFeishuClient = ReturnType<typeof createTestFeishuClient>;

function createTestFeishuClient() {
  return {
    docx: {
      document: {
        create: vi.fn().mockResolvedValue({
          data: {
            document: {
              document_id: 'doccn123',
              title: 'feature/login 2026-03-27 10:00',
            },
          },
        }),
      },
      documentBlockChildren: {
        create: vi.fn().mockResolvedValue({
          data: {
            children: [],
          },
        }),
      },
    },
    drive: {
      meta: {
        batchQuery: vi.fn().mockResolvedValue({
          data: {
            metas: [
              {
                doc_token: 'doccn123',
                url: 'https://tenant.feishu.cn/docx/doccn123',
              },
            ],
          },
        }),
      },
      permissionMember: {
        create: vi.fn().mockResolvedValue({
          data: {
            member: {
              member_id: 'oc_review_chat',
            },
          },
        }),
        batchCreate: vi.fn().mockResolvedValue({
          data: {
            members: [],
          },
        }),
      },
    },
    im: {
      chat: {
        get: vi.fn().mockResolvedValue({
          data: {
            chat_mode: 'group',
            chat_type: 'group',
          },
        }),
      },
      chatMembers: {
        get: vi.fn().mockResolvedValue({
          data: {
            items: [
              { member_id: 'ou_1', name: 'Alice' },
              { member_id: 'ou_2', name: 'Bob' },
            ],
            has_more: false,
          },
        }),
      },
    },
  };
}

function registerTestInstance(
  client: TestFeishuClient,
  options?: { instanceId?: string; botOpenId?: string },
): void {
  feishuTesting.registerTestInstance({
    instanceId: options?.instanceId || 'default',
    client,
    botOpenId: options?.botOpenId || 'ou_bot',
  });
}

describe('feishu-doc-service helpers and orchestration', () => {
  beforeEach(async () => {
    _initTestDatabase();
    feishuTesting.reset();
    feishuTesting.setSleepImplementation(async () => {});
    await storeChatMetadata(
      GROUP_CHAT_JID,
      '2026-03-27T10:00:00.000Z',
      'Review Chat',
      'feishu',
      true,
    );
    await storeChatMetadata(
      DM_CHAT_JID,
      '2026-03-27T10:00:00.000Z',
      'DM Chat',
      'feishu',
      false,
    );
  });

  describe('helper primitives', () => {
    it('creates a feishu docx document for a chat jid', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const created = await createFeishuDocByJid(GROUP_CHAT_JID, {
        title: 'feature/login 2026-03-27 10:00',
      });

      expect(created).toEqual({
        documentId: 'doccn123',
        title: 'feature/login 2026-03-27 10:00',
      });
      expect(client.docx.document.create).toHaveBeenCalledWith({
        data: {
          title: 'feature/login 2026-03-27 10:00',
        },
      });
    });

    it('populates a feishu docx document with deterministic blocks', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      await populateFeishuDocByJid(GROUP_CHAT_JID, {
        documentId: 'doccn123',
        sections: [
          { kind: 'heading', level: 1, text: 'Overview' },
          { kind: 'paragraph', text: 'Summary' },
          { kind: 'code', text: 'const a = 1;', language: 'typescript' },
        ],
      });

      expect(client.docx.documentBlockChildren.create).toHaveBeenCalledWith({
        path: {
          document_id: 'doccn123',
          block_id: 'doccn123',
        },
        data: {
          children: [
            expect.objectContaining({
              block_type: 3,
              heading1: {
                elements: [{ text_run: { content: 'Overview' } }],
              },
            }),
            expect.objectContaining({
              block_type: 2,
              text: {
                elements: [{ text_run: { content: 'Summary' } }],
              },
            }),
            expect.objectContaining({
              block_type: 14,
              code: {
                elements: [{ text_run: { content: 'const a = 1;' } }],
              },
            }),
          ],
        },
      });
    });

    it('renders inline markdown code spans inside paragraphs without altering code blocks', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      await populateFeishuDocByJid(GROUP_CHAT_JID, {
        documentId: 'doccn123',
        sections: [
          {
            kind: 'paragraph',
            text: '内 `PLATFORM_NAMES` 列表不一致；同时只记录 `logsBefore/logsAfter`，没有断言。',
          },
          {
            kind: 'code',
            text: 'const literal = "`PLATFORM_NAMES`";',
          },
        ],
      });

      expect(client.docx.documentBlockChildren.create).toHaveBeenCalledWith({
        path: {
          document_id: 'doccn123',
          block_id: 'doccn123',
        },
        data: {
          children: [
            expect.objectContaining({
              block_type: 2,
              text: {
                elements: [
                  { text_run: { content: '内 ' } },
                  {
                    text_run: {
                      content: 'PLATFORM_NAMES',
                      text_element_style: {
                        inline_code: true,
                      },
                    },
                  },
                  { text_run: { content: ' 列表不一致；同时只记录 ' } },
                  {
                    text_run: {
                      content: 'logsBefore/logsAfter',
                      text_element_style: {
                        inline_code: true,
                      },
                    },
                  },
                  { text_run: { content: '，没有断言。' } },
                ],
              },
            }),
            expect.objectContaining({
              block_type: 14,
              code: {
                elements: [
                  {
                    text_run: {
                      content: 'const literal = "`PLATFORM_NAMES`";',
                    },
                  },
                ],
              },
            }),
          ],
        },
      });
    });

    it('resolves the final doc url through drive meta lookup', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const url = await resolveFeishuDocUrlByJid(GROUP_CHAT_JID, {
        documentId: 'doccn123',
      });

      expect(url).toBe('https://tenant.feishu.cn/docx/doccn123');
      expect(client.drive.meta.batchQuery).toHaveBeenCalledWith({
        data: {
          request_docs: [
            {
              doc_token: 'doccn123',
              doc_type: 'docx',
            },
          ],
          with_url: true,
        },
      });
    });

    it('grants a group doc to the chat using openchat first', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const grant = await grantFeishuDocToChatByJid(GROUP_CHAT_JID, {
        documentId: 'doccn123',
        chatId: 'oc_review_chat',
        perm: 'edit',
      });

      expect(grant).toEqual({
        authorizationStrategy: 'chat',
        authorizationStatus: 'complete',
        warnings: [],
        targets: [
          {
            targetType: 'chat',
            targetId: 'oc_review_chat',
            status: 'success',
          },
        ],
      });
      expect(client.drive.permissionMember.create).toHaveBeenCalledWith({
        path: { token: 'doccn123' },
        params: { type: 'docx', need_notification: false },
        data: {
          member_type: 'openchat',
          member_id: 'oc_review_chat',
          perm: 'edit',
          type: 'chat',
        },
      });
    });

    it('grants users in bounded batches with retry backoff and partial failure reporting', async () => {
      const client = createTestFeishuClient();
      const sleeps: number[] = [];
      feishuTesting.setSleepImplementation(async (ms: number) => {
        sleeps.push(ms);
      });
      registerTestInstance(client);

      let attempt = 0;
      client.drive.permissionMember.batchCreate.mockImplementation(
        async (payload?: { data?: { members?: Array<{ member_id: string }> } }) => {
          const ids =
            payload?.data?.members?.map((entry) => entry.member_id) || [];
          if (attempt === 0) {
            attempt += 1;
            throw new Error('rate limited');
          }
          if (attempt === 1) {
            attempt += 1;
            return { data: { members: ids.map((member_id) => ({ member_id })) } };
          }
          throw new Error('permission denied');
        },
      );

      const grant = await grantFeishuDocToUsersByJid(GROUP_CHAT_JID, {
        documentId: 'doccn123',
        batches: [
          Array.from({ length: 20 }, (_value, index) => `ou_retry_${index}`),
          ['ou_failed'],
        ],
      });

      expect(client.drive.permissionMember.batchCreate).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([500]);
      expect(grant.authorizationStrategy).toBe('users');
      expect(grant.authorizationStatus).toBe('partial');
      expect(grant.batches).toEqual([
        {
          batchIndex: 0,
          status: 'success',
          memberIds: Array.from(
            { length: 20 },
            (_value, index) => `ou_retry_${index}`,
          ),
        },
        {
          batchIndex: 1,
          status: 'failed',
          memberIds: ['ou_failed'],
          error: 'permission denied',
        },
      ]);
    });

    it('uses authoritative feishu metadata for group context', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const context = await getFeishuChatContextByJid(GROUP_CHAT_JID);

      expect(context).toEqual({
        chatId: 'oc_review_chat',
        isGroup: true,
        participantOpenIds: ['ou_1', 'ou_2'],
      });
      expect(client.im.chat.get).toHaveBeenCalledWith({
        path: { chat_id: 'oc_review_chat' },
        params: { user_id_type: 'open_id' },
      });
    });
  });

  describe('service orchestration', () => {
    it('creates, populates, resolves, and authorizes a group doc via chat grant', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const result = await createFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'feature/login 2026-03-27 10:00',
        conversationType: 'group',
        sections: [
          { kind: 'heading', level: 1, text: 'Overview' },
          { kind: 'paragraph', text: 'Summary' },
        ],
      });

      expect(result.resultStatus).toBe('success');
      expect(result.url).toBe('https://tenant.feishu.cn/docx/doccn123');
      expect(result.conversationType).toBe('group');
      expect(result.creationStatus).toBe('created');
      expect(result.populationStatus).toBe('completed');
      expect(result.authorizationStrategy).toBe('chat');
      expect(result.authorizationStatus).toBe('complete');
      expect(result.targetResults).toEqual([
        {
          targetType: 'chat',
          targetId: 'oc_review_chat',
          status: 'success',
        },
      ]);
    });

    it('supports split-phase prepare and continue provisioning for repo review callers', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const prepared = await prepareFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'feature/login 2026-03-27 10:00',
        conversationType: 'group',
      });
      const continued = await continueFeishuCloudDocProvision({
        chatJid: GROUP_CHAT_JID,
        documentId: prepared.documentId,
        title: prepared.title,
        conversationType: 'group',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(prepared).toEqual({
        documentId: 'doccn123',
        title: 'feature/login 2026-03-27 10:00',
        creationStatus: 'created',
      });
      expect(continued.resultStatus).toBe('success');
      expect(continued.documentId).toBe('doccn123');
      expect(continued.url).toBe('https://tenant.feishu.cn/docx/doccn123');
    });

    it('falls back from group chat grant to bounded user batches with warnings', async () => {
      const client = createTestFeishuClient();
      client.drive.permissionMember.create.mockRejectedValue(
        new Error('chat grant disabled'),
      );
      client.im.chatMembers.get.mockResolvedValue({
        data: {
          items: Array.from({ length: 21 }, (_value, index) => ({
            member_id: `ou_member_${index}`,
            name: `User ${index}`,
          })),
          has_more: false,
        },
      });
      let batchAttempt = 0;
      client.drive.permissionMember.batchCreate.mockImplementation(
        async (payload?: { data?: { members?: Array<{ member_id: string }> } }) => {
          batchAttempt += 1;
          const ids =
            payload?.data?.members?.map((entry) => entry.member_id) || [];
          if (batchAttempt === 1) {
            throw new Error('permission denied');
          }
          return { data: { members: ids.map((member_id) => ({ member_id })) } };
        },
      );
      registerTestInstance(client);

      const partial = await createFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'feature/login 2026-03-27 10:00',
        conversationType: 'group',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(partial.resultStatus).toBe('success_with_authorization_warnings');
      expect(partial.authorizationWarnings).toContain(
        'chat grant failed; user fallback partially failed',
      );
      expect(partial.authorizationStatus).toBe('partial');
      expect(partial.targetResults[0]?.status).toBe('failed');
      expect(partial.targetResults.some((entry) => entry.status === 'success')).toBe(
        true,
      );
    });

    it('returns content_population_failed when content write fails', async () => {
      const client = createTestFeishuClient();
      client.docx.documentBlockChildren.create.mockRejectedValue(
        new Error('doc write failed'),
      );
      registerTestInstance(client);

      const failed = await createFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'feature/login 2026-03-27 10:00',
        conversationType: 'group',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(failed.resultStatus).toBe('content_population_failed');
      expect(failed.creationStatus).toBe('created');
      expect(failed.populationStatus).toBe('failed');
      expect(failed.authorizationStatus).toBe('skipped');
      expect(failed.lastError).toBe('doc write failed');
    });

    it('returns content_population_failed when all provided sections are empty', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const failed = await createFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'empty doc',
        conversationType: 'group',
        sections: [{ kind: 'paragraph', text: '   ' }],
      });

      expect(failed.resultStatus).toBe('content_population_failed');
      expect(client.docx.documentBlockChildren.create).not.toHaveBeenCalled();
    });

    it('fails closed when conversationType is missing', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      await expect(
        createFeishuCloudDoc({
          chatJid: GROUP_CHAT_JID,
          title: 'feature/login 2026-03-27 10:00',
          conversationType: undefined as never,
          sections: [{ kind: 'paragraph', text: 'Summary' }],
        }),
      ).rejects.toThrow('Feishu conversation type is required');
    });

    it('returns creation_failed when caller-provided conversationType mismatches live feishu metadata', async () => {
      const client = createTestFeishuClient();
      registerTestInstance(client);

      const result = await createFeishuCloudDoc({
        chatJid: GROUP_CHAT_JID,
        title: 'feature/login 2026-03-27 10:00',
        conversationType: 'dm',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(result.resultStatus).toBe('creation_failed');
    });

    it('prefers authoritative dm metadata over recent sender metadata and persisted participants', async () => {
      const client = createTestFeishuClient();
      client.im.chat.get.mockResolvedValue({
        data: {
          chat_mode: 'p2p',
          chat_type: 'p2p',
        },
      });
      client.im.chatMembers.get.mockResolvedValue({
        data: {
          items: [
            { member_id: 'ou_bot', name: 'NanoClaw' },
            { member_id: 'ou_authoritative', name: 'Authoritative User' },
          ],
          has_more: false,
        },
      });
      registerTestInstance(client, { botOpenId: 'ou_bot' });
      await upsertConversationParticipant({
        chatJid: DM_CHAT_JID,
        channel: 'feishu',
        memberId: 'ou_recent',
        memberName: 'Recent Sender',
        source: 'feishu_message',
        lastSeenAt: '2026-03-27T10:10:00.000Z',
      });
      await upsertConversationParticipant({
        chatJid: DM_CHAT_JID,
        channel: 'feishu',
        memberId: 'ou_persisted',
        memberName: 'Persisted User',
        source: 'message',
        lastSeenAt: '2026-03-27T10:00:00.000Z',
      });

      const counterpart = await resolveFeishuDmCounterpartOpenIdByJid(DM_CHAT_JID);
      const result = await createFeishuCloudDoc({
        chatJid: DM_CHAT_JID,
        title: 'DM note',
        conversationType: 'dm',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(counterpart).toBe('ou_authoritative');
      expect(result.authorizationStrategy).toBe('users');
      expect(result.authorizationStatus).toBe('complete');
      expect(result.targetResults).toEqual([
        {
          targetType: 'user',
          targetId: 'ou_authoritative',
          status: 'success',
        },
      ]);
    });

    it('falls back to recent sender metadata before persisted participants for dm auth', async () => {
      const client = createTestFeishuClient();
      client.im.chat.get.mockResolvedValue({
        data: {
          chat_mode: 'p2p',
          chat_type: 'p2p',
        },
      });
      client.im.chatMembers.get.mockResolvedValue({
        data: {
          items: [{ member_id: 'ou_bot', name: 'NanoClaw' }],
          has_more: false,
        },
      });
      registerTestInstance(client, { botOpenId: 'ou_bot' });
      await upsertConversationParticipant({
        chatJid: DM_CHAT_JID,
        channel: 'feishu',
        memberId: 'ou_recent',
        memberName: 'Recent Sender',
        source: 'feishu_message',
        lastSeenAt: '2026-03-27T10:10:00.000Z',
      });
      await upsertConversationParticipant({
        chatJid: DM_CHAT_JID,
        channel: 'feishu',
        memberId: 'ou_persisted',
        memberName: 'Persisted User',
        source: 'message',
        lastSeenAt: '2026-03-27T10:00:00.000Z',
      });

      const counterpart = await resolveFeishuDmCounterpartOpenIdByJid(DM_CHAT_JID);

      expect(counterpart).toBe('ou_recent');
    });

    it('returns authorization warnings instead of throwing when dm counterpart resolution fails', async () => {
      const client = createTestFeishuClient();
      client.im.chat.get.mockResolvedValue({
        data: {
          chat_mode: 'p2p',
          chat_type: 'p2p',
        },
      });
      client.im.chatMembers.get.mockResolvedValue({
        data: {
          items: [{ member_id: 'ou_bot', name: 'NanoClaw' }],
          has_more: false,
        },
      });
      registerTestInstance(client, { botOpenId: 'ou_bot' });

      const result = await createFeishuCloudDoc({
        chatJid: DM_CHAT_JID,
        title: 'DM note',
        conversationType: 'dm',
        sections: [{ kind: 'paragraph', text: 'Summary' }],
      });

      expect(result.resultStatus).toBe('success_with_authorization_warnings');
      expect(result.authorizationStatus).toBe('failed');
      expect(result.authorizationWarnings[0]).toContain(
        'Unable to resolve Feishu DM counterpart',
      );
    });
  });
});
