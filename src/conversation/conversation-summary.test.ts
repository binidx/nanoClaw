import { describe, expect, it } from 'vitest';

import {
  createConversationSummaryDecorator,
  extractChannelInstanceId,
} from './conversation-summary.js';

describe('conversation-summary', () => {
  it('extracts channel instance ids from routed jids', () => {
    expect(extractChannelInstanceId('telegram:bot-a:chat-1', 'telegram')).toBe(
      'bot-a',
    );
    expect(extractChannelInstanceId('telegram:chat-1', 'telegram')).toBe(
      'default',
    );
    expect(extractChannelInstanceId('web:web_1', 'web')).toBeNull();
  });

  it('decorates conversation summaries with resolved channel labels', async () => {
    const decorate = createConversationSummaryDecorator({
      getConfiguredChannelInstances: () => [
        { id: 'bot-a', type: 'telegram', name: '销售机器人' },
      ],
      getConversationLastEventSeq: () => 42,
    });

    await expect(
      decorate({
        jid: 'telegram:bot-a:chat-1',
        channel: 'telegram',
        name: '客户A',
      }),
    ).resolves.toEqual({
      jid: 'telegram:bot-a:chat-1',
      channel: 'telegram',
      name: '客户A',
      source_name: '客户A',
      channel_label: 'Telegram · 销售机器人',
      route: {
        channel: 'telegram',
        jid: 'telegram:bot-a:chat-1',
        instanceId: 'bot-a',
      },
      last_event_seq: 42,
    });
  });

  it('falls back to base or instance id labels when instance metadata is absent', async () => {
    const decorate = createConversationSummaryDecorator({
      getConfiguredChannelInstances: () => [],
      getConversationLastEventSeq: () => 3,
    });

    await expect(
      decorate({
        jid: 'feishu:tenant-1:chat-2',
        channel: 'feishu',
      }),
    ).resolves.toMatchObject({
      source_name: 'feishu:tenant-1:chat-2',
      channel_label: '飞书 · tenant-1',
      route: {
        channel: 'feishu',
        instanceId: 'tenant-1',
      },
      last_event_seq: 3,
    });
  });
});
