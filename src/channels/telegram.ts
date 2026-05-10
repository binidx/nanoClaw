import crypto from 'crypto';

import {
  ChannelInstanceConfig,
  getAssistantName,
  getConfiguredChannelInstances,
} from '../config-store.js';
import {
  deleteConversationMessages,
  deleteSessionByJid,
  getRegisteredGroup,
  hasStoredMessage,
  storeMessageDirect,
} from '../db.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-telegram');
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { getWebChannel } from './web.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import { t } from '../i18n/index.js';

const DEFAULT_API_BASE = 'https://api.telegram.org';
const MAX_TEXT_LENGTH = 4096;
const LONG_POLL_TIMEOUT_SEC = 30;
const RETRY_DELAY_MS = 3000;
const DEDUP_MAX = 1000;

type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramGetMeResult {
  id: number;
  is_bot: true;
  first_name: string;
  username?: string;
}

function normalizeApiBase(value: string | boolean | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (raw || DEFAULT_API_BASE).replace(/\/+$/, '');
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

export function buildTelegramJid(instanceId: string, chatId: string): string {
  return instanceId === 'default'
    ? `tg:${chatId}`
    : `tg:${instanceId}:${chatId}`;
}

function parseTelegramJid(
  jid: string,
): { instanceId: string; chatId: string; explicit: boolean } | null {
  if (!jid.startsWith('tg:')) return null;
  const payload = jid.slice('tg:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', chatId: payload, explicit: false };
  }
  const instanceId = payload.slice(0, separatorIndex).trim();
  const chatId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !chatId) return null;
  return { instanceId, chatId, explicit: true };
}

export function deriveTelegramGroupFolder(
  instanceId: string,
  chatId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${chatId}`)
    .digest('hex')
    .slice(0, 12);
  return `telegram_${instancePart}_${digest}`;
}

function chunkTelegramText(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TEXT_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n', MAX_TEXT_LENGTH);
    if (splitAt <= 0) splitAt = MAX_TEXT_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function messageKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function getTelegramChatName(chat: TelegramChat): string {
  if (chat.type === 'private') {
    const fullName = `${chat.first_name || ''} ${chat.last_name || ''}`.trim();
    return fullName || chat.username || `Telegram ${chat.id}`;
  }
  return chat.title || chat.username || `Telegram ${chat.id}`;
}

function getTelegramSenderName(from?: TelegramUser): string {
  if (!from) return 'Unknown';
  const fullName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
  return fullName || from.username || String(from.id);
}

function isGroupChat(type: TelegramChatType): boolean {
  return type === 'group' || type === 'supergroup' || type === 'channel';
}

function placeholderMessage(msg: TelegramMessage): string {
  if (msg.caption?.trim()) return `[Media] ${msg.caption.trim()}`;
  return '[Unsupported Telegram message]';
}

export class TelegramChannel implements Channel {
  name: string;

  private connected = false;
  private readonly opts: ChannelOpts;
  private readonly instance: ChannelInstanceConfig;
  private readonly token: string;
  private readonly apiBase: string;
  private offset = 0;
  private pollController: AbortController | null = null;
  private stopped = false;
  private me: TelegramGetMeResult | null = null;
  private seenIds = new Set<string>();

  constructor(instance: ChannelInstanceConfig, opts: ChannelOpts) {
    this.instance = instance;
    this.name = `telegram:${instance.name}`;
    this.token = String(instance.config.botToken || '').trim();
    this.apiBase = normalizeApiBase(instance.config.apiBase);
    this.opts = opts;
  }

  get instanceId(): string {
    return this.instance.id;
  }

  get statusName(): string {
    return `Telegram · ${this.instance.name}`;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.connected = false;

    try {
      this.me = await this.apiRequest<TelegramGetMeResult>('getMe');
      this.connected = true;
      channelLog.info(
        { channel: 'telegram', username: this.me.username, instanceId: this.instance.id, instanceName: this.instance.name },
        'Channel ready',
      );
      void this.pollLoop();
    } catch (err) {
      this.connected = false;
      channelLog.error(
        { err, instanceId: this.instance.id },
        'Failed to connect Telegram bot',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseTelegramJid(jid);
    if (!parsed || !this.ownsJid(jid)) {
      throw new Error(
        `Telegram instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }

    for (const chunk of chunkTelegramText(text)) {
      await this.apiRequest('sendMessage', {
        chat_id: parsed.chatId,
        text: chunk,
      });
    }

    channelLog.info(
      { jid, length: text.length, instanceId: this.instance.id },
      'Telegram message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatusEntries(): Array<{ name: string; connected: boolean }> {
    return [{ name: this.statusName, connected: this.connected }];
  }

  ownsJid(jid: string): boolean {
    const parsed = parseTelegramJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.pollController?.abort();
    this.pollController = null;
    channelLog.info({ instanceId: this.instance.id }, 'Telegram bot disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    return;
  }

  async sendStreamChunk(
    jid: string,
    text: string,
    done: boolean,
  ): Promise<void> {
    if (!done) return;
    const finalText = text.trim();
    if (!finalText) return;
    await this.sendMessage(jid, finalText);
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      this.pollController = new AbortController();
      try {
        const updates = await this.apiRequest<TelegramUpdate[]>(
          'getUpdates',
          {
            timeout: LONG_POLL_TIMEOUT_SEC,
            offset: this.offset,
            allowed_updates: [
              'message',
              'edited_message',
              'channel_post',
              'edited_channel_post',
            ],
          },
          this.pollController.signal,
        );

        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.handleUpdate(update);
        }
      } catch (err) {
        if (this.stopped) break;
        this.connected = false;
        channelLog.warn(
          { err, instanceId: this.instance.id },
          'Telegram long polling failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } finally {
        this.pollController = null;
      }

      if (!this.connected) {
        this.connected = true;
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg =
      update.message ||
      update.edited_message ||
      update.channel_post ||
      update.edited_channel_post;
    if (!msg) return;

    const chatId = String(msg.chat.id);
    const jid = buildTelegramJid(this.instance.id, chatId);
    const dedupId = messageKey(chatId, msg.message_id);
    const storedId = `tg_${chatId}_${msg.message_id}`;

    if (this.seenIds.has(dedupId)) return;
    if (await hasStoredMessage(jid, storedId)) {
      this.recordSeen(dedupId);
      return;
    }

    const sender = msg.from;
    if (sender?.is_bot) {
      this.recordSeen(dedupId);
      return;
    }

    this.recordSeen(dedupId);

    const timestamp = new Date(msg.date * 1000).toISOString();
    const isGroup = isGroupChat(msg.chat.type);
    const chatName = getTelegramChatName(msg.chat);
    const senderName = getTelegramSenderName(sender);
    const content =
      msg.text?.trim() || msg.caption?.trim() || placeholderMessage(msg);

    this.opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    if (
      content === '/reset' ||
      content.replace(/^@\S+\s*/, '').trim() === '/reset'
    ) {
      this.handleReset(jid);
      return;
    }

    let group = this.opts.registeredGroups()[jid];
    if (!group && this.opts.registerGroup) {
      const assistantName = await getAssistantName();
      this.opts.registerGroup(jid, {
        name: chatName,
        folder: deriveTelegramGroupFolder(this.instance.id, chatId),
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup,
        isMain: false,
      });
      group = this.opts.registeredGroups()[jid];
      channelLog.info({ jid }, 'Auto-registered Telegram chat');
    }
    if (!group) return;

    const inboundMessage = {
      id: storedId,
      chat_jid: jid,
      sender: sender ? String(sender.id) : 'unknown',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(jid, inboundMessage);
    this.opts.onRealtimeMessage?.(jid, inboundMessage);

    const webCh = getWebChannel();
    if (webCh) {
      webCh.notifyMessage(jid, {
        id: storedId,
        content,
        sender: sender ? String(sender.id) : 'unknown',
        sender_name: senderName,
        timestamp,
        is_bot: false,
      });
    }

    channelLog.info(
      { jid, sender: sender ? String(sender.id) : 'unknown' },
      'Telegram message stored',
    );
  }

  private async apiRequest<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const resp = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal,
    });
    if (!resp.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${resp.status} ${await resp.text()}`,
      );
    }

    const payload = (await resp.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      throw new Error(
        payload.description || `Telegram API ${method} returned ok=false`,
      );
    }
    return payload.result;
  }

  private recordSeen(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > DEDUP_MAX) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first);
    }
  }

  private async handleReset(jid: string): Promise<void> {
    try {
      const registeredGroup = await getRegisteredGroup(jid);
      await deleteConversationMessages(jid);
      await deleteSessionByJid(jid);
      if (registeredGroup) {
        clearCodexConversationState(registeredGroup.folder);
      }
      getWebChannel()?.resetConversation(jid);
      this.sendSystemReply(jid, t('channels.sessionReset', {}, undefined));
    } catch (err) {
      channelLog.error({ err, jid }, 'Failed to reset Telegram conversation');
      this.sendSystemReply(jid, t('channels.resetFailed', {}, undefined));
    }
  }

  private async sendSystemReply(jid: string, text: string): Promise<void> {
    void this.sendMessage(jid, text);

    const timestamp = new Date().toISOString();
    const msgId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await storeMessageDirect({
      id: msgId,
      chat_jid: jid,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });

    const webCh = getWebChannel();
    if (webCh) {
      webCh.notifyMessage(jid, {
        id: msgId,
        content: text,
        sender: await getAssistantName(),
        sender_name: await getAssistantName(),
        timestamp,
        is_bot: true,
      });
    }
  }
}

class MultiTelegramChannel implements Channel {
  name = 'telegram';

  constructor(private readonly channels: TelegramChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Telegram instance owns JID: ${jid}`);
    }
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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    await this.findChannel(jid)?.setTyping?.(jid, isTyping);
  }

  async sendStreamChunk(
    jid: string,
    text: string,
    done: boolean,
  ): Promise<void> {
    await this.findChannel(jid)?.sendStreamChunk?.(jid, text, done);
  }

  private findChannel(jid: string): TelegramChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}

registerChannel('telegram', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'telegram' && instance.enabled,
  );

  if (instances.length === 0) {
    channelLog.warn('Telegram: no enabled instances configured');
    return null;
  }

  const channels = instances
    .filter((instance) => String(instance.config.botToken || '').trim())
    .map((instance) => new TelegramChannel(instance, opts));

  if (channels.length === 0) {
    channelLog.warn('Telegram: enabled instances missing bot token');
    return null;
  }

  return channels.length === 1
    ? channels[0]
    : new MultiTelegramChannel(channels);
});
