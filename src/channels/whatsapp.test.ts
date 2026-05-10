import { describe, expect, it } from 'vitest';

import {
  buildWhatsAppJid,
  deriveWhatsAppGroupFolder,
  parseWhatsAppJid,
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
});
