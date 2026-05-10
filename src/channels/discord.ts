import crypto from 'crypto';

import { WebSocket } from 'ws';

import { hasStoredMessage } from '../db.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-discord');
import {
  ChannelInstanceConfig,
  getAssistantName,
  getConfiguredChannelInstances,
} from '../config-store.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { getWebChannel } from './web.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GATEWAY_VERSION = '10';
const HEARTBEAT_GRACE_MS = 15_000;
const MAX_DISCORD_MESSAGE = 2_000;
const DEDUP_MAX = 500;
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DISCORD_INTENTS =
  INTENT_GUILDS |
  INTENT_GUILD_MESSAGES |
  INTENT_DIRECT_MESSAGES |
  INTENT_MESSAGE_CONTENT;

interface DiscordGatewayPayload<T = unknown> {
  op: number;
  d: T;
  s?: number | null;
  t?: string | null;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordChannelInfo {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  recipients?: DiscordUser[];
}

interface DiscordMessageAttachment {
  id: string;
  filename: string;
  url?: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  author: DiscordUser;
  member?: {
    nick?: string | null;
  };
  attachments?: DiscordMessageAttachment[];
  webhook_id?: string;
}

interface DiscordReadyEvent {
  session_id: string;
  resume_gateway_url?: string;
  user: DiscordUser;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function buildDiscordJid(instanceId: string, channelId: string): string {
  return instanceId === 'default'
    ? `discord:${channelId}`
    : `discord:${instanceId}:${channelId}`;
}

function parseDiscordJid(
  jid: string,
): { instanceId: string; channelId: string; explicit: boolean } | null {
  if (!jid.startsWith('discord:')) return null;
  const payload = jid.slice('discord:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', channelId: payload, explicit: false };
  }
  const instanceId = payload.slice(0, separatorIndex).trim();
  const channelId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !channelId) return null;
  return { instanceId, channelId, explicit: true };
}

export function deriveDiscordGroupFolder(
  instanceId: string,
  channelId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${channelId}`)
    .digest('hex')
    .slice(0, 12);
  return `discord_${instancePart}_${digest}`;
}

function resolveDiscordDisplayName(message: DiscordMessage): string {
  return (
    message.member?.nick?.trim() ||
    message.author.global_name?.trim() ||
    message.author.username ||
    message.author.id
  );
}

function renderDiscordContent(message: DiscordMessage): string {
  const content = (message.content || '').trim();
  if (content) return content;
  const attachments = message.attachments || [];
  if (attachments.length === 0) return '[Unsupported Discord message]';
  return attachments
    .map(
      (attachment) => attachment.url || `[Attachment] ${attachment.filename}`,
    )
    .join('\n');
}

function isDiscordGuildChannel(channelType: number): boolean {
  return [0, 2, 4, 5, 10, 11, 12, 13, 14, 15].includes(channelType);
}

export class DiscordChannel implements Channel {
  name: string;

  private connected = false;
  private botUserId = '';
  private sessionId = '';
  private resumeGatewayUrl = '';
  private seq: number | null = null;
  private heartbeatIntervalMs = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAckAt = 0;
  private shuttingDown = false;
  private ws: WebSocket | null = null;
  private readonly opts: ChannelOpts;
  private readonly instance: ChannelInstanceConfig;
  private readonly botToken: string;
  private readonly applicationId: string;
  private readonly seenIds = new Set<string>();
  private readonly channelInfoCache = new Map<string, DiscordChannelInfo>();

  constructor(instance: ChannelInstanceConfig, opts: ChannelOpts) {
    this.instance = instance;
    this.opts = opts;
    this.name = `discord:${instance.name}`;
    this.botToken = String(instance.config.botToken || '').trim();
    this.applicationId = String(instance.config.applicationId || '').trim();
  }

  get instanceId(): string {
    return this.instance.id;
  }

  get statusName(): string {
    return `Discord · ${this.instance.name}`;
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.connected = false;

    try {
      const me = await this.request<DiscordUser>('GET', '/users/@me');
      this.botUserId = me.id;
      const gateway = await this.request<{ url: string }>(
        'GET',
        '/gateway/bot',
      );
      const gatewayUrl = `${gateway.url}?v=${GATEWAY_VERSION}&encoding=json`;
      await this.openGateway(gatewayUrl, false);
    } catch (err) {
      channelLog.error(
        { err, instanceId: this.instance.id },
        'Failed to connect Discord channel',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseDiscordJid(jid);
    if (!parsed || !this.ownsJid(jid)) {
      throw new Error(
        `Discord instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }
    const content = text.trim();
    if (!content) return;

    const chunks = Array.from(
      { length: Math.ceil(content.length / MAX_DISCORD_MESSAGE) },
      (_, index) =>
        content.slice(
          index * MAX_DISCORD_MESSAGE,
          (index + 1) * MAX_DISCORD_MESSAGE,
        ),
    ).filter(Boolean);
    for (const chunk of chunks) {
      await this.request('POST', `/channels/${parsed.channelId}/messages`, {
        content: chunk,
      });
    }

    channelLog.info({ jid, length: text.length }, 'Discord message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    const parsed = parseDiscordJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  getStatusEntries(): Array<{ name: string; connected: boolean }> {
    return [{ name: this.statusName, connected: this.connected }];
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    this.connected = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.close();
    }
    channelLog.info(
      { instanceId: this.instance.id },
      'Discord channel disconnected',
    );
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

  private async openGateway(url: string, isResume: boolean): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      ws.on('open', onOpen);
      ws.on('error', onError);
    });

    ws.on('message', (raw) => {
      void this.handleGatewayMessage(raw.toString(), isResume);
    });
    ws.on('close', () => {
      this.connected = false;
      this.clearHeartbeat();
      if (!this.shuttingDown) this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      channelLog.warn(
        { err, instanceId: this.instance.id },
        'Discord gateway socket error',
      );
    });
  }

  private async handleGatewayMessage(
    raw: string,
    isResume: boolean,
  ): Promise<void> {
    const payload = JSON.parse(raw) as DiscordGatewayPayload;
    if (typeof payload.s === 'number') {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case 10:
        this.heartbeatIntervalMs = Number(
          (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ||
            0,
        );
        this.lastHeartbeatAckAt = Date.now();
        this.startHeartbeat();
        if (isResume && this.sessionId) {
          this.sendGateway({
            op: 6,
            d: {
              token: this.botToken,
              session_id: this.sessionId,
              seq: this.seq,
            },
          });
        } else {
          this.identify();
        }
        return;
      case 11:
        this.lastHeartbeatAckAt = Date.now();
        return;
      case 7:
        this.scheduleReconnect(true);
        return;
      case 9:
        this.sessionId = '';
        this.resumeGatewayUrl = '';
        this.scheduleReconnect(false, 2_000);
        return;
      case 1:
        this.sendHeartbeat();
        return;
      default:
        break;
    }

    if (payload.op !== 0 || !payload.t) {
      return;
    }

    if (payload.t === 'READY') {
      const ready = payload.d as DiscordReadyEvent;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url || '';
      this.botUserId = ready.user?.id || this.botUserId;
      this.connected = true;
      channelLog.info(
        {
          instanceId: this.instance.id,
          applicationId: this.applicationId || undefined,
        },
        'Discord gateway ready',
      );
      return;
    }

    if (payload.t === 'RESUMED') {
      this.connected = true;
      channelLog.info({ instanceId: this.instance.id }, 'Discord gateway resumed');
      return;
    }

    if (payload.t === 'MESSAGE_CREATE') {
      await this.handleMessageCreate(payload.d as DiscordMessage);
    }
  }

  private identify(): void {
    this.sendGateway({
      op: 2,
      d: {
        token: this.botToken,
        intents: DISCORD_INTENTS,
        properties: {
          os: process.platform,
          browser: 'nanoclaw',
          device: 'nanoclaw',
        },
      },
    });
  }

  private sendGateway(payload: DiscordGatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.heartbeatIntervalMs) return;
    this.heartbeatTimer = setInterval(() => {
      if (
        Date.now() - this.lastHeartbeatAckAt >
        this.heartbeatIntervalMs + HEARTBEAT_GRACE_MS
      ) {
        channelLog.warn(
          { instanceId: this.instance.id },
          'Discord heartbeat stalled; reconnecting',
        );
        this.scheduleReconnect(true, 0);
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    this.sendGateway({ op: 1, d: this.seq });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(preferResume = true, delayMs = 1_500): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.close();
    }
    this.connected = false;
    this.clearHeartbeat();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(preferResume);
    }, delayMs);
  }

  private async reconnect(preferResume: boolean): Promise<void> {
    const resumeUrl = this.resumeGatewayUrl
      ? `${this.resumeGatewayUrl}?v=${GATEWAY_VERSION}&encoding=json`
      : '';
    try {
      if (preferResume && resumeUrl && this.sessionId) {
        await this.openGateway(resumeUrl, true);
        return;
      }
      const gateway = await this.request<{ url: string }>(
        'GET',
        '/gateway/bot',
      );
      await this.openGateway(
        `${gateway.url}?v=${GATEWAY_VERSION}&encoding=json`,
        false,
      );
    } catch (err) {
      channelLog.warn(
        { err, instanceId: this.instance.id },
        'Discord reconnect failed; retrying',
      );
      await sleep(2_000);
      if (!this.shuttingDown) this.scheduleReconnect(preferResume, 0);
    }
  }

  private async handleMessageCreate(message: DiscordMessage): Promise<void> {
    if (!message?.id || !message.channel_id || !message.author?.id) return;
    if (message.author.bot || message.webhook_id) return;

    const jid = buildDiscordJid(this.instance.id, message.channel_id);
    if (this.seenIds.has(message.id) || await hasStoredMessage(jid, message.id)) {
      this.recordSeen(message.id);
      return;
    }
    this.recordSeen(message.id);

    const channelInfo = await this.getChannelInfo(message.channel_id);
    const channelName = this.resolveConversationName(message, channelInfo);
    const isGroup = channelInfo
      ? isDiscordGuildChannel(channelInfo.type)
      : !!message.guild_id;
    const timestamp = message.timestamp || new Date().toISOString();
    const senderName = resolveDiscordDisplayName(message);
    const content = renderDiscordContent(message);

    this.opts.onChatMetadata(jid, timestamp, channelName, 'discord', isGroup);

    let group = this.opts.registeredGroups()[jid];
    if (!group && this.opts.registerGroup) {
      const assistantName = await getAssistantName();
      this.opts.registerGroup(jid, {
        name: channelName,
        folder: deriveDiscordGroupFolder(this.instance.id, message.channel_id),
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup,
        isMain: false,
      });
      group = this.opts.registeredGroups()[jid];
      channelLog.info(
        { jid, instanceId: this.instance.id },
        'Auto-registered Discord chat',
      );
    }
    if (!group) return;

    const inboundMessage = {
      id: message.id,
      chat_jid: jid,
      sender: message.author.id,
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
        id: message.id,
        content,
        sender: message.author.id,
        sender_name: senderName,
        timestamp,
        is_bot: false,
      });
    }
  }

  private async getChannelInfo(
    channelId: string,
  ): Promise<DiscordChannelInfo | null> {
    const cached = this.channelInfoCache.get(channelId);
    if (cached) return cached;
    try {
      const info = await this.request<DiscordChannelInfo>(
        'GET',
        `/channels/${channelId}`,
      );
      this.channelInfoCache.set(channelId, info);
      return info;
    } catch (err) {
      channelLog.debug(
        { err, channelId },
        'Failed to fetch Discord channel metadata',
      );
      return null;
    }
  }

  private resolveConversationName(
    message: DiscordMessage,
    channelInfo: DiscordChannelInfo | null,
  ): string {
    if (channelInfo?.name?.trim()) {
      return `Discord #${channelInfo.name.trim()}`;
    }
    const recipientName = channelInfo?.recipients
      ?.filter((user) => user.id !== this.botUserId)
      .map((user) => user.global_name || user.username)
      .filter(Boolean)
      .join(', ');
    if (recipientName) {
      return `Discord DM ${recipientName}`;
    }
    if (message.guild_id) {
      return `Discord #${message.channel_id.slice(0, 8)}`;
    }
    return `Discord DM ${resolveDiscordDisplayName(message)}`;
  }

  private recordSeen(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > DEDUP_MAX) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first);
    }
  }

  private async request<T = unknown>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const resp = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Discord API ${resp.status}: ${await resp.text()}`);
    }
    if (resp.status === 204) {
      return undefined as T;
    }
    return (await resp.json()) as T;
  }
}

class MultiDiscordChannel implements Channel {
  name = 'discord';

  constructor(private readonly channels: DiscordChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Discord instance owns JID: ${jid}`);
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

  async sendStreamChunk(
    jid: string,
    text: string,
    done: boolean,
  ): Promise<void> {
    await this.findChannel(jid)?.sendStreamChunk?.(jid, text, done);
  }

  private findChannel(jid: string): DiscordChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}

registerChannel('discord', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'discord' && instance.enabled,
  );

  if (instances.length === 0) {
    channelLog.warn('Discord: no enabled instances configured');
    return null;
  }

  const channels = instances
    .filter((instance) => String(instance.config.botToken || '').trim())
    .map((instance) => new DiscordChannel(instance, opts));

  if (channels.length === 0) {
    channelLog.warn('Discord: enabled instances missing Bot Token');
    return null;
  }

  return channels.length === 1
    ? channels[0]
    : new MultiDiscordChannel(channels);
});
