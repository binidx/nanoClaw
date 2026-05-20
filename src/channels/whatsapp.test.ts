import { describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  hasStoredMessage: vi.fn(async () => false),
}));

import {
  buildWhatsAppJid,
  deriveWhatsAppGroupFolder,
  parseWhatsAppJid,
  WhatsAppChannel,
} from './whatsapp.js';

describe('whatsapp jid helpers', () => {
  it('builds and parses explicit instance jids', () => {
    const jid = buildWhatsAppJid('instance-a', '8613800138000');
    expect(jid).toBe('whatsapp:instance-a:8613800138000');
    expect(parseWhatsAppJid(jid)).toEqual({
      instanceId: 'instance-a',
      chatId: '8613800138000',
      explicit: true,
    });
  });

  it('supports default-instance shorthand jids', () => {
    expect(parseWhatsAppJid('whatsapp:8613800138000')).toEqual({
      instanceId: 'default',
      chatId: '8613800138000',
      explicit: false,
    });
  });

  it('derives stable group folders', () => {
    expect(deriveWhatsAppGroupFolder('default', '8613800138000')).toMatch(
      /^whatsapp_default_[a-f0-9]{12}$/,
    );
  });

  it('deduplicates webhook messages within the process', async () => {
    const groups: Record<string, any> = {};
    const onMessage = vi.fn();
    const channel = new WhatsAppChannel(
      {
        id: 'default',
        type: 'whatsapp',
        name: 'Default WhatsApp',
        enabled: true,
        visibility: 'public',
        owner_id: '__system__',
        config: {
          accessToken: 'token',
          phoneNumberId: 'phone-1',
        },
      },
      {
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => groups,
        registerGroup: (jid, group) => {
          groups[jid] = group;
        },
      },
    );

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-1' },
                contacts: [{ wa_id: 'user-1', profile: { name: 'Alice' } }],
                messages: [
                  {
                    id: 'wamid.1',
                    from: 'user-1',
                    timestamp: '1710000000',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(channel.handleWebhookPayload(payload)).resolves.toBe(1);
    await expect(channel.handleWebhookPayload(payload)).resolves.toBe(0);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge or deduplicate messages when persistence fails', async () => {
    const groups: Record<string, any> = {};
    const onMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('persist failed'))
      .mockResolvedValueOnce(undefined);
    const onRealtimeMessage = vi.fn();
    const channel = new WhatsAppChannel(
      {
        id: 'default',
        type: 'whatsapp',
        name: 'Default WhatsApp',
        enabled: true,
        visibility: 'public',
        owner_id: '__system__',
        config: {
          accessToken: 'token',
          phoneNumberId: 'phone-1',
        },
      },
      {
        onMessage,
        onChatMetadata: vi.fn(),
        onRealtimeMessage,
        registeredGroups: () => groups,
        registerGroup: (jid, group) => {
          groups[jid] = group;
        },
      },
    );

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'phone-1' },
                contacts: [{ wa_id: 'user-1', profile: { name: 'Alice' } }],
                messages: [
                  {
                    id: 'wamid.persist-fail',
                    from: 'user-1',
                    timestamp: '1710000000',
                    text: { body: 'persist me' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await expect(channel.handleWebhookPayload(payload)).rejects.toThrow(
      'persist failed',
    );
    expect(onRealtimeMessage).not.toHaveBeenCalled();

    await expect(channel.handleWebhookPayload(payload)).resolves.toBe(1);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onRealtimeMessage).toHaveBeenCalledTimes(1);
  });
});
