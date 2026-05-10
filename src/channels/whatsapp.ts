import crypto from 'crypto';

import {
  ChannelInstanceConfig,
  getAssistantName,
  getConfiguredChannelInstances,
} from '../config-store.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-whatsapp');
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { getWebChannel } from './web.js';

const GRAPH_API_BASE = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = 'v23.0';

type WhatsAppChannelHandle = WhatsAppChannel | MultiWhatsAppChannel;

let globalWhatsAppChannel: WhatsAppChannelHandle | null = null;

export interface WhatsAppWebhookContact {
  wa_id?: string;
  profile?: { name?: string };
}

export interface WhatsAppWebhookMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string; mime_type?: string };
  video?: { caption?: string; mime_type?: string };
  audio?: { mime_type?: string };
  document?: { filename?: string; mime_type?: string; caption?: string };
  sticker?: { mime_type?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    button_reply?: { title?: string; id?: string };
    list_reply?: { title?: string; id?: string; description?: string };
  };
}

export interface WhatsAppWebhookValue {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: WhatsAppWebhookContact[];
  messages?: WhatsAppWebhookMessage[];
  statuses?: Array<{ id?: string; status?: string; recipient_id?: string }>;
}

export interface WhatsAppWebhookChange {
  field?: string;
  value?: WhatsAppWebhookValue;
}

export interface WhatsAppWebhookEntry {
  id?: string;
  changes?: WhatsAppWebhookChange[];
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppWebhookEntry[];
}

export function getWhatsAppChannel(): WhatsAppChannelHandle | null {
  return globalWhatsAppChannel;
}

function slugifyInstanceId(instanceId: string): string {
  return (
    instanceId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16) || 'default'
  );
}

export function buildWhatsAppJid(instanceId: string, chatId: string): string {
  return instanceId === 'default'
    ? `whatsapp:${chatId}`
    : `whatsapp:${instanceId}:${chatId}`;
}

export function parseWhatsAppJid(
  jid: string,
): { instanceId: string; chatId: string; explicit: boolean } | null {
  if (!jid.startsWith('whatsapp:')) return null;
  const payload = jid.slice('whatsapp:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', chatId: payload, explicit: false };
  }
  const instanceId = payload.slice(0, separatorIndex).trim();
  const chatId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !chatId) return null;
  return { instanceId, chatId, explicit: true };
}

export function deriveWhatsAppGroupFolder(
  instanceId: string,
  chatId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${chatId}`)
    .digest('hex')
    .slice(0, 12);
  return `whatsapp_${instancePart}_${digest}`;
}

function parseTimestamp(value: string | undefined): string {
  const num = Number(value || '');
  if (Number.isFinite(num) && num > 0) {
    return new Date(num * 1000).toISOString();
  }
  return new Date().toISOString();
}

function summarizeNonTextMessage(message: WhatsAppWebhookMessage): string {
  switch (message.type) {
    case 'image':
      return message.image?.caption?.trim() || '[Image]';
    case 'video':
      return message.video?.caption?.trim() || '[Video]';
    case 'audio':
      return '[Audio]';
    case 'document':
      return message.document?.filename?.trim() || '[Document]';
    case 'sticker':
      return '[Sticker]';
    case 'button':
      return (
        message.button?.text?.trim() ||
        message.button?.payload?.trim() ||
        '[Button]'
      );
    case 'interactive':
      return (
        message.interactive?.button_reply?.title?.trim() ||
        message.interactive?.list_reply?.title?.trim() ||
        '[Interactive]'
      );
    default:
      return `[${message.type || 'Message'}]`;
  }
}

function resolveMessageText(message: WhatsAppWebhookMessage): string {
  if (message.type === 'text') {
    return message.text?.body?.trim() || '';
  }
  return summarizeNonTextMessage(message);
}

function findContactName(
  contacts: WhatsAppWebhookContact[] | undefined,
  waId: string,
): string {
  const contact = contacts?.find((entry) => entry.wa_id === waId);
  return contact?.profile?.name?.trim() || waId || 'Unknown';
}

function normalizeGraphVersion(version: string): string {
  const trimmed = String(version || '').trim();
  if (!trimmed) return DEFAULT_GRAPH_VERSION;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export class WhatsAppChannel implements Channel {
  name: string;

  private readonly opts: ChannelOpts;
  private readonly instance: ChannelInstanceConfig;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly graphVersion: string;
  private assistantName = 'NanoClaw';
  private connected = false;

  constructor(instance: ChannelInstanceConfig, opts: ChannelOpts) {
    this.instance = instance;
    this.opts = opts;
    this.name = `whatsapp:${instance.name}`;
    this.accessToken = String(instance.config.accessToken || '').trim();
    this.phoneNumberId = String(instance.config.phoneNumberId || '').trim();
    this.graphVersion = normalizeGraphVersion(
      String(instance.config.graphVersion || DEFAULT_GRAPH_VERSION),
    );
  }

  get instanceId(): string {
    return this.instance.id;
  }

  get statusName(): string {
    return `WhatsApp · ${this.instance.name}`;
  }

  get verifyToken(): string {
    return String(this.instance.config.verifyToken || '').trim();
  }

  get outboundPhoneNumberId(): string {
    return this.phoneNumberId;
  }

  async connect(): Promise<void> {
    if (!this.accessToken || !this.phoneNumberId) {
      this.connected = false;
      channelLog.warn(
        { instanceId: this.instance.id },
        'WhatsApp instance missing access token or phone number id',
      );
      return;
    }

    this.assistantName = await getAssistantName();
    this.connected = true;
    channelLog.info(
      {
        instanceId: this.instance.id,
        phoneNumberId: this.phoneNumberId,
        graphVersion: this.graphVersion,
      },
      'WhatsApp channel ready (outbound enabled; inbound requires webhook wiring)',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseWhatsAppJid(jid);
    if (!parsed || !this.ownsJid(jid)) {
      throw new Error(
        `WhatsApp instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }

    const endpoint = `${GRAPH_API_BASE}/${this.graphVersion}/${this.phoneNumberId}/messages`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: parsed.chatId,
        type: 'text',
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    if (!resp.ok) {
      throw new Error(
        `WhatsApp send failed: ${resp.status} ${await resp.text()}`,
      );
    }

    channelLog.info(
      { jid, instanceId: this.instance.id, length: text.length },
      'WhatsApp message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    const parsed = parseWhatsAppJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    channelLog.info(
      { instanceId: this.instance.id },
      'WhatsApp channel disconnected',
    );
  }

  handleWebhookPayload(payload: WhatsAppWebhookPayload): number {
    let handledMessages = 0;

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id || '';
        if (phoneNumberId && phoneNumberId !== this.phoneNumberId) {
          continue;
        }

        for (const message of value?.messages || []) {
          const waId = String(message.from || '').trim();
          const messageId = String(message.id || '').trim();
          if (!waId || !messageId) continue;

          const timestamp = parseTimestamp(message.timestamp);
          const chatJid = buildWhatsAppJid(this.instance.id, waId);
          const senderName = findContactName(value?.contacts, waId);
          const content = resolveMessageText(message);
          if (!content) continue;

          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            senderName,
            'whatsapp',
            false,
          );

          let group = this.opts.registeredGroups()[chatJid];
          if (!group && this.opts.registerGroup) {
            this.opts.registerGroup(chatJid, {
              name: `WhatsApp ${senderName}`,
              folder: deriveWhatsAppGroupFolder(this.instance.id, waId),
              trigger: `@${this.assistantName}`,
              added_at: new Date().toISOString(),
              requiresTrigger: false,
              isMain: false,
            });
            group = this.opts.registeredGroups()[chatJid];
            channelLog.info({ chatJid }, 'Auto-registered WhatsApp chat');
          }
          if (!group) continue;

          const inboundMessage: NewMessage = {
            id: messageId,
            chat_jid: chatJid,
            sender: waId,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
          };

          this.opts.onMessage(chatJid, inboundMessage);
          this.opts.onRealtimeMessage?.(chatJid, inboundMessage);

          const webCh = getWebChannel();
          if (webCh) {
            webCh.notifyMessage(chatJid, {
              id: messageId,
              content,
              sender: waId,
              sender_name: senderName,
              timestamp,
              is_bot: false,
            });
          }

          handledMessages += 1;
        }
      }
    }

    if (handledMessages > 0) {
      channelLog.info(
        { instanceId: this.instance.id, handledMessages },
        'Processed WhatsApp webhook payload',
      );
    }

    return handledMessages;
  }
}

class MultiWhatsAppChannel implements Channel {
  name = 'whatsapp';

  constructor(private readonly channels: WhatsAppChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) throw new Error(`No WhatsApp instance owns JID: ${jid}`);
    await channel.sendMessage(jid, text);
  }

  isConnected(): boolean {
    return this.channels.some((channel) => channel.isConnected());
  }

  getStatusEntries(): Array<{ name: string; connected: boolean }> {
    return this.channels.map((channel) => ({
      name: channel.statusName,
      connected: channel.isConnected(),
    }));
  }

  ownsJid(jid: string): boolean {
    return this.channels.some((channel) => channel.ownsJid(jid));
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.disconnect()));
  }

  handleWebhookPayload(payload: WhatsAppWebhookPayload): number {
    const phoneNumberId = String(
      payload.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || '',
    ).trim();
    if (phoneNumberId) {
      const channel = this.channels.find(
        (entry) => entry.outboundPhoneNumberId === phoneNumberId,
      );
      if (channel) return channel.handleWebhookPayload(payload);
    }

    return this.channels.reduce(
      (count, channel) => count + channel.handleWebhookPayload(payload),
      0,
    );
  }

  private findChannel(jid: string): WhatsAppChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}

export function dispatchWhatsAppWebhook(
  payload: WhatsAppWebhookPayload,
): number {
  const channel = globalWhatsAppChannel;
  if (!channel) {
    channelLog.warn('WhatsApp webhook received but channel is not initialized');
    return 0;
  }

  if (channel instanceof WhatsAppChannel) {
    return channel.handleWebhookPayload(payload);
  }
  return channel.handleWebhookPayload(payload);
}

registerChannel('whatsapp', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'whatsapp' && instance.enabled,
  );

  const channels = instances
    .filter(
      (instance) =>
        String(instance.config.accessToken || '').trim() &&
        String(instance.config.phoneNumberId || '').trim(),
    )
    .map((instance) => new WhatsAppChannel(instance, opts));

  if (channels.length === 0) {
    channelLog.warn(
      'WhatsApp: no enabled instances with access token + phone number id',
    );
    globalWhatsAppChannel = null;
    return null;
  }

  globalWhatsAppChannel =
    channels.length === 1 ? channels[0]! : new MultiWhatsAppChannel(channels);
  return globalWhatsAppChannel;
});
