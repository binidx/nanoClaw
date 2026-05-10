import crypto from 'crypto';

import { WebSocket } from 'ws';

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

const channelLog = createModuleLogger('channel-slack');
import { Channel } from '../types.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import { getWebChannel } from './web.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { t } from '../i18n/index.js';

const SLACK_API_BASE = 'https://slack.com/api';
const SOCKET_OPEN_PATH = '/apps.connections.open';
const AUTH_TEST_PATH = '/auth.test';
const POST_MESSAGE_PATH = '/chat.postMessage';
const USERS_INFO_PATH = '/users.info';
const CONVERSATIONS_INFO_PATH = '/conversations.info';
const MAX_RECENT_IDS = 500;

interface SlackAuthTestResponse {
  ok: boolean;
  error?: string;
  user_id?: string;
  user?: string;
  team?: string;
  team_id?: string;
  bot_id?: string;
}

interface SlackSocketOpenResponse {
  ok: boolean;
  error?: string;
  url?: string;
}

interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id?: string;
    name?: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

interface SlackConversationInfoResponse {
  ok: boolean;
  error?: string;
  channel?: {
    id?: string;
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    is_channel?: boolean;
    user?: string;
  };
}

interface SlackPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

interface SlackSocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: SlackMessageEvent;
  };
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  client_msg_id?: string;
  thread_ts?: string;
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

export function buildSlackJid(instanceId: string, channelId: string): string {
  return instanceId === 'default'
    ? `slack:${channelId}`
    : `slack:${instanceId}:${channelId}`;
}

function parseSlackJid(
  jid: string,
): { instanceId: string; channelId: string; explicit: boolean } | null {
  if (!jid.startsWith('slack:')) return null;
  const payload = jid.slice('slack:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', channelId: payload, explicit: false };
  }

  const instanceId = payload.slice(0, separatorIndex).trim();
  const channelId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !channelId) return null;
  return { instanceId, channelId, explicit: true };
}

export function deriveSlackGroupFolder(
  instanceId: string,
  channelId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${channelId}`)
    .digest('hex')
    .slice(0, 12);
  return `slack_${instancePart}_${digest}`;
}

function slackTsToIso(ts: string | undefined): string {
  const millis = Math.round(Number.parseFloat(ts || '0') * 1000);
  if (!Number.isFinite(millis) || millis <= 0) {
    return new Date().toISOString();
  }
  return new Date(millis).toISOString();
}

function isGroupChannel(
  channelType: SlackMessageEvent['channel_type'],
): boolean {
  return (
    channelType === 'channel' ||
    channelType === 'group' ||
    channelType === 'mpim'
  );
}

async function slackApi<T>(
  token: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`${SLACK_API_BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    throw new Error(
      `Slack API ${path} failed: ${resp.status} ${await resp.text()}`,
    );
  }

  const data = (await resp.json()) as { ok?: boolean; error?: string } & T;
  if (data.ok === false) {
    throw new Error(
      `Slack API ${path} error: ${data.error || 'unknown_error'}`,
    );
  }
  return data as T;
}

class SlackChannel implements Channel {
  name: string;

  private readonly opts: ChannelOpts;
  private readonly instance: ChannelInstanceConfig;
  private readonly botToken: string;
  private readonly appToken: string;
  private connected = false;
  private socketModeConnected = false;
  private ws: WebSocket | null = null;
  private botUserId = '';
  private teamName = '';
  private recentMessageIds = new Set<string>();
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();
  private dmUserCache = new Map<string, string>();

  constructor(instance: ChannelInstanceConfig, opts: ChannelOpts) {
    this.instance = instance;
    this.opts = opts;
    this.botToken = String(instance.config.botToken || '').trim();
    this.appToken = String(instance.config.appToken || '').trim();
    this.name = `slack:${instance.name}`;
  }

  get statusName(): string {
    return `Slack · ${this.instance.name}`;
  }

  async connect(): Promise<void> {
    this.connected = false;
    this.socketModeConnected = false;

    const auth = await this.authenticateBot().catch((error) => {
      channelLog.error(
        { err: error, instanceId: this.instance.id },
        'Slack auth failed',
      );
      return null;
    });
    if (!auth) return;

    this.botUserId = auth.user_id || '';
    this.teamName = auth.team || '';
    this.connected = true;

    if (!this.appToken) {
      channelLog.warn(
        { instanceId: this.instance.id },
        'Slack appToken missing; running in outbound-only mode',
      );
      channelLog.info(
        { channel: 'slack', instanceName: this.instance.name, mode: 'outbound-only' },
        'Channel ready (outbound-only)',
      );
      return;
    }

    const socketUrl = await this.openSocketModeUrl().catch((error) => {
      channelLog.error(
        { err: error, instanceId: this.instance.id },
        'Slack Socket Mode open failed',
      );
      return '';
    });
    if (!socketUrl) return;

    await this.connectSocketMode(socketUrl).catch((error) => {
      channelLog.error(
        { err: error, instanceId: this.instance.id },
        'Slack Socket Mode connection failed',
      );
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseSlackJid(jid);
    if (!parsed || !this.ownsJid(jid)) {
      throw new Error(
        `Slack instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }

    const payload = {
      channel: parsed.channelId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    };
    await slackApi<SlackPostMessageResponse>(
      this.botToken,
      POST_MESSAGE_PATH,
      payload,
    );
    channelLog.info(
      { jid, instanceId: this.instance.id, length: text.length },
      'Slack message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatusEntries(): Array<{ name: string; connected: boolean }> {
    return [
      {
        name: this.statusName,
        connected: this.connected,
      },
    ];
  }

  ownsJid(jid: string): boolean {
    const parsed = parseSlackJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.socketModeConnected = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    channelLog.info({ instanceId: this.instance.id }, 'Slack channel disconnected');
  }

  private async authenticateBot(): Promise<SlackAuthTestResponse> {
    const auth = await slackApi<SlackAuthTestResponse>(
      this.botToken,
      AUTH_TEST_PATH,
    );
    channelLog.info(
      { instanceId: this.instance.id, team: auth.team, userId: auth.user_id },
      'Slack bot authenticated',
    );
    return auth;
  }

  private async openSocketModeUrl(): Promise<string> {
    const data = await slackApi<SlackSocketOpenResponse>(
      this.appToken,
      SOCKET_OPEN_PATH,
      {},
    );
    return String(data.url || '').trim();
  }

  private async connectSocketMode(socketUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(socketUrl);
      let settled = false;
      this.ws = ws;

      ws.on('open', () => {
        this.socketModeConnected = true;
        this.connected = true;
        channelLog.info(
          { channel: 'slack', instanceId: this.instance.id, instanceName: this.instance.name, mode: 'socket-mode' },
          'Channel ready',
        );
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (raw) => {
        void this.handleSocketEnvelope(raw.toString());
      });

      ws.on('close', () => {
        this.socketModeConnected = false;
        if (this.appToken) {
          this.connected = false;
        }
        this.ws = null;
        channelLog.warn(
          { instanceId: this.instance.id },
          'Slack Socket Mode closed',
        );
      });

      ws.on('error', (error) => {
        channelLog.error(
          { err: error, instanceId: this.instance.id },
          'Slack Socket Mode error',
        );
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  private async handleSocketEnvelope(raw: string): Promise<void> {
    let envelope: SlackSocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackSocketEnvelope;
    } catch (error) {
      channelLog.warn(
        { err: error, raw },
        'Failed to parse Slack Socket Mode envelope',
      );
      return;
    }

    if (envelope.envelope_id) {
      this.ackEnvelope(envelope.envelope_id);
    }

    if (envelope.type !== 'events_api') {
      return;
    }

    const event = envelope.payload?.event;
    if (!event || event.type !== 'message') {
      return;
    }

    await this.handleMessageEvent(event);
  }

  private ackEnvelope(envelopeId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event.channel || !event.ts) {
      return;
    }

    if (event.subtype && event.subtype !== 'file_share') {
      return;
    }
    if (!event.user || event.user === this.botUserId || event.bot_id) {
      return;
    }

    const jid = buildSlackJid(this.instance.id, event.channel);
    const messageId = event.client_msg_id || `${event.channel}:${event.ts}`;

    if (
      this.recentMessageIds.has(messageId) ||
      await hasStoredMessage(jid, messageId)
    ) {
      this.recordMessageId(messageId);
      return;
    }
    this.recordMessageId(messageId);

    const timestamp = slackTsToIso(event.ts);
    const isGroup = isGroupChannel(event.channel_type);
    const chatName = await this.resolveConversationName(
      event.channel,
      event.channel_type,
    );
    const senderName = await this.resolveUserName(event.user);
    const content = (event.text || '').trim();

    this.opts.onChatMetadata(jid, timestamp, chatName, 'slack', isGroup);

    let group = this.opts.registeredGroups()[jid];
    if (!group && this.opts.registerGroup) {
      const assistantName = await getAssistantName();
      this.opts.registerGroup(jid, {
        name: chatName,
        folder: deriveSlackGroupFolder(this.instance.id, event.channel),
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup,
        isMain: false,
      });
      group = this.opts.registeredGroups()[jid];
      channelLog.info(
        { jid, instanceId: this.instance.id },
        'Auto-registered Slack chat',
      );
    }
    if (!group) return;

    if (content === '/reset') {
      await this.resetConversation(jid);
      return;
    }

    const inboundMessage = {
      id: messageId,
      chat_jid: jid,
      sender: event.user,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    };

    this.opts.onMessage(jid, inboundMessage);
    this.opts.onRealtimeMessage?.(jid, inboundMessage);

    const webChannel = getWebChannel();
    if (webChannel) {
      webChannel.notifyMessage(jid, {
        id: messageId,
        content,
        sender: event.user,
        sender_name: senderName,
        timestamp,
        is_bot: false,
      });
    }

    channelLog.info(
      { jid, sender: event.user, instanceId: this.instance.id },
      'Slack message stored',
    );
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const data = await slackApi<SlackUserInfoResponse>(
        this.botToken,
        USERS_INFO_PATH,
        { user: userId },
      );
      const name =
        data.user?.profile?.display_name ||
        data.user?.real_name ||
        data.user?.profile?.real_name ||
        data.user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (error) {
      channelLog.warn({ err: error, userId }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private async resolveConversationName(
    channelId: string,
    channelType: SlackMessageEvent['channel_type'],
  ): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;

    try {
      const data = await slackApi<SlackConversationInfoResponse>(
        this.botToken,
        CONVERSATIONS_INFO_PATH,
        { channel: channelId },
      );
      const conversation = data.channel;
      if (!conversation) {
        throw new Error('missing conversation');
      }

      if (conversation.is_im && conversation.user) {
        const userName = await this.resolveUserName(conversation.user);
        const label = `Slack DM ${userName}`;
        this.channelNameCache.set(channelId, label);
        this.dmUserCache.set(channelId, conversation.user);
        return label;
      }

      const name = conversation.name || channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch (error) {
      channelLog.warn(
        { err: error, channelId },
        'Failed to resolve Slack conversation name',
      );
      const fallback =
        channelType === 'im' ? `Slack DM ${channelId}` : `Slack ${channelId}`;
      this.channelNameCache.set(channelId, fallback);
      return fallback;
    }
  }

  private async resetConversation(jid: string): Promise<void> {
    try {
      const registeredGroup = await getRegisteredGroup(jid);
      await deleteConversationMessages(jid);
      await deleteSessionByJid(jid);
      if (registeredGroup) {
        clearCodexConversationState(registeredGroup.folder);
      }

      const webChannel = getWebChannel();
      if (webChannel) {
        webChannel.resetConversation(jid);
      }

      await this.sendMessage(jid, t('channels.sessionReset', {}, undefined));
    } catch (error) {
      channelLog.error({ err: error, jid }, 'Failed to reset Slack conversation');
      await this.sendMessage(jid, t('channels.resetFailed', {}, undefined));
    }
  }

  private recordMessageId(messageId: string): void {
    this.recentMessageIds.add(messageId);
    if (this.recentMessageIds.size <= MAX_RECENT_IDS) return;
    const first = this.recentMessageIds.values().next().value;
    if (first) {
      this.recentMessageIds.delete(first);
    }
  }
}

class MultiSlackChannel implements Channel {
  name = 'slack';

  constructor(private readonly channels: SlackChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Slack instance owns JID: ${jid}`);
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

  private findChannel(jid: string): SlackChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}

registerChannel('slack', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'slack' && instance.enabled,
  );
  if (instances.length === 0) {
    channelLog.warn('Slack: no enabled instances configured');
    return null;
  }

  const channels = instances
    .filter((instance) => String(instance.config.botToken || '').trim())
    .map((instance) => new SlackChannel(instance, opts));

  if (channels.length === 0) {
    channelLog.warn('Slack: enabled instances missing botToken');
    return null;
  }

  return channels.length === 1 ? channels[0] : new MultiSlackChannel(channels);
});
