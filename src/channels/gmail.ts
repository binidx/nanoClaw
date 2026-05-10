import crypto from 'crypto';

import {
  deleteConversationMessages,
  deleteSessionByJid,
  getRegisteredGroup,
  hasStoredMessage,
  storeMessageDirect,
} from '../db.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-gmail');
import {
  ChannelInstanceConfig,
  getAssistantName,
  getConfiguredChannelInstances,
} from '../config-store.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';
import { getWebChannel } from './web.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import { t } from '../i18n/index.js';

const DEDUP_MAX = 1000;
const DEFAULT_POLL_INTERVAL_MS = 30000;
const INITIAL_LOOKBACK_SECONDS = 86400;
const POLL_SLACK_SECONDS = 90;
const MAX_THREADS_PER_POLL = 20;

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailBody {
  data?: string;
  size?: number;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

interface GmailListThreadsResponse {
  threads?: Array<{ id: string; historyId?: string }>;
}

interface GmailProfile {
  emailAddress?: string;
}

interface GmailTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface ParsedAddress {
  email: string;
  name: string;
}

interface GmailEnvelope {
  jid: string;
  threadId: string;
  messageId: string;
  timestamp: string;
  sender: ParsedAddress;
  replyTo: ParsedAddress;
  subject: string;
  content: string;
  isFromSelf: boolean;
  references: string;
  messageIdHeader: string;
  displayName: string;
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

export function buildGmailJid(instanceId: string, threadId: string): string {
  return instanceId === 'default'
    ? `gmail:${threadId}`
    : `gmail:${instanceId}:${threadId}`;
}

export function parseGmailJid(
  jid: string,
): { instanceId: string; threadId: string; explicit: boolean } | null {
  if (!jid.startsWith('gmail:')) return null;
  const payload = jid.slice('gmail:'.length);
  const separatorIndex = payload.indexOf(':');
  if (separatorIndex === -1) {
    return { instanceId: 'default', threadId: payload, explicit: false };
  }
  const instanceId = payload.slice(0, separatorIndex).trim();
  const threadId = payload.slice(separatorIndex + 1).trim();
  if (!instanceId || !threadId) return null;
  return { instanceId, threadId, explicit: true };
}

export function deriveGmailGroupFolder(
  instanceId: string,
  threadId: string,
): string {
  const instancePart = slugifyInstanceId(instanceId);
  const digest = crypto
    .createHash('sha1')
    .update(`${instanceId}:${threadId}`)
    .digest('hex')
    .slice(0, 12);
  return `gmail_${instancePart}_${digest}`;
}

export function normalizeSubject(subject: string): string {
  const trimmed = subject.trim() || 'NanoClaw Gmail Thread';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function parseAddress(rawValue: string): ParsedAddress {
  const raw = rawValue.trim();
  const match = raw.match(/^(.*?)(?:<([^>]+)>)?$/);
  const namePart = (match?.[1] || '').replace(/^"|"$/g, '').trim();
  const emailPart = (match?.[2] || match?.[1] || '')
    .trim()
    .replace(/^<|>$/g, '');
  const email = emailPart.includes('@') ? emailPart : raw;
  const name = namePart && namePart !== email ? namePart : email;
  return {
    email,
    name,
  };
}

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padding =
    normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function extractTextFromPart(part: GmailMessagePart | undefined): string {
  if (!part) return '';

  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data).trim();
  }

  if (part.parts?.length) {
    for (const child of part.parts) {
      const directText = extractTextFromPart(child);
      if (directText) return directText;
    }
  }

  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }

  if (part.body?.data) {
    return decodeBase64Url(part.body.data).trim();
  }

  return '';
}

function getHeaderValue(
  headers: GmailHeader[] | undefined,
  headerName: string,
): string {
  const lower = headerName.toLowerCase();
  return (
    headers?.find((header) => header.name?.toLowerCase() === lower)?.value || ''
  );
}

export function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export class GmailChannel implements Channel {
  name: string;

  private readonly opts: ChannelOpts;
  private readonly instance: ChannelInstanceConfig;
  private connected = false;
  private accountEmail = '';
  private seenIds = new Set<string>();
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollRunning = false;
  private pollAfterUnix =
    Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_SECONDS;
  private threadCache = new Map<string, GmailEnvelope>();

  constructor(instance: ChannelInstanceConfig, opts: ChannelOpts) {
    this.instance = instance;
    this.opts = opts;
    this.name = `gmail:${instance.name}`;
  }

  get statusName(): string {
    return `Gmail · ${this.instance.name}`;
  }

  get instanceId(): string {
    return this.instance.id;
  }

  private get clientId(): string {
    return String(this.instance.config.clientId || '').trim();
  }

  private get clientSecret(): string {
    return String(this.instance.config.clientSecret || '').trim();
  }

  private get refreshToken(): string {
    return String(this.instance.config.refreshToken || '').trim();
  }

  private get pollIntervalMs(): number {
    const configured = Number(this.instance.config.pollIntervalSeconds || 0);
    if (Number.isFinite(configured) && configured >= 10) {
      return configured * 1000;
    }
    return DEFAULT_POLL_INTERVAL_MS;
  }

  async connect(): Promise<void> {
    this.connected = false;
    try {
      await this.refreshAccessToken(true);
      const profile = await this.apiFetch<GmailProfile>(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      );
      this.accountEmail = String(profile.emailAddress || '').trim();
      if (!this.accountEmail) {
        throw new Error('Gmail profile email address missing');
      }
      this.connected = true;
      channelLog.info(
        { channel: 'gmail', instanceId: this.instance.id, instanceName: this.instance.name, accountEmail: this.accountEmail },
        'Channel ready',
      );
      await this.pollOnce();
      this.schedulePoll();
    } catch (err) {
      this.connected = false;
      this.clearPollTimer();
      channelLog.error(
        { err, instance: this.instance.id },
        'Failed to connect Gmail channel',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const parsed = parseGmailJid(jid);
    if (!parsed || !this.ownsJid(jid)) {
      throw new Error(
        `Gmail instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }

    const envelope =
      (await this.getThreadEnvelope(jid, parsed.threadId)) ||
      this.threadCache.get(jid);
    if (!envelope) {
      throw new Error(`Gmail thread metadata unavailable for ${jid}`);
    }

    const headers = [
      `To: ${envelope.replyTo.email}`,
      `Subject: ${normalizeSubject(envelope.subject)}`,
      'Content-Type: text/plain; charset=UTF-8',
      'MIME-Version: 1.0',
    ];
    if (envelope.messageIdHeader) {
      headers.push(`In-Reply-To: ${envelope.messageIdHeader}`);
    }
    if (envelope.references) {
      headers.push(`References: ${envelope.references}`);
    } else if (envelope.messageIdHeader) {
      headers.push(`References: ${envelope.messageIdHeader}`);
    }

    const raw = `${headers.join('\r\n')}\r\n\r\n${text.trim()}\r\n`;
    await this.apiFetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw: encodeBase64Url(raw),
          threadId: parsed.threadId,
        }),
      },
    );

    channelLog.info({ jid, instance: this.instance.id }, 'Gmail message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatusEntries(): Array<{ name: string; connected: boolean }> {
    return [{ name: this.statusName, connected: this.connected }];
  }

  ownsJid(jid: string): boolean {
    const parsed = parseGmailJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.clearPollTimer();
    this.threadCache.clear();
    channelLog.info({ instance: this.instance.id }, 'Gmail channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const webChannel = getWebChannel();
    if (webChannel) webChannel.setTyping(jid, isTyping);
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

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    if (!this.connected) return;
    this.pollTimer = setTimeout(() => {
      void this.pollLoop();
    }, this.pollIntervalMs);
  }

  private async pollLoop(): Promise<void> {
    if (!this.connected) return;
    if (this.pollRunning) {
      this.schedulePoll();
      return;
    }
    this.pollRunning = true;
    try {
      await this.pollOnce();
    } catch (err) {
      channelLog.warn({ err, instance: this.instance.id }, 'Gmail polling failed');
    } finally {
      this.pollRunning = false;
      this.schedulePoll();
    }
  }

  private async pollOnce(): Promise<void> {
    const nowUnix = Math.floor(Date.now() / 1000);
    const list = await this.apiFetch<GmailListThreadsResponse>(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?${new URLSearchParams(
        {
          maxResults: String(MAX_THREADS_PER_POLL),
          q: `after:${Math.max(0, this.pollAfterUnix - POLL_SLACK_SECONDS)}`,
        },
      ).toString()}`,
    );

    for (const thread of list.threads || []) {
      try {
        const fullThread = await this.apiFetch<GmailThread>(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(thread.id)}?format=full`,
        );
        await this.ingestThread(fullThread);
      } catch (err) {
        channelLog.warn(
          { err, threadId: thread.id, instance: this.instance.id },
          'Failed to ingest Gmail thread',
        );
      }
    }

    this.pollAfterUnix = Math.max(this.pollAfterUnix, nowUnix);
  }

  private async ingestThread(thread: GmailThread): Promise<void> {
    const messages = [...(thread.messages || [])].sort(
      (left, right) =>
        Number(left.internalDate || 0) - Number(right.internalDate || 0),
    );

    for (const message of messages) {
      const envelope = this.parseEnvelope(thread.id, message);
      if (!envelope) continue;
      this.threadCache.set(envelope.jid, envelope);

      if (envelope.isFromSelf) {
        this.recordSeen(message.id);
        continue;
      }

      if (
        this.seenIds.has(message.id) ||
        await hasStoredMessage(envelope.jid, message.id)
      ) {
        this.recordSeen(message.id);
        continue;
      }

      const content = envelope.content.trim();
      this.opts.onChatMetadata(
        envelope.jid,
        envelope.timestamp,
        envelope.displayName,
        'gmail',
        false,
      );

      if (content === '/reset') {
        await this.handleReset(envelope.jid);
        this.recordSeen(message.id);
        continue;
      }

      let group = this.opts.registeredGroups()[envelope.jid];
      if (!group && this.opts.registerGroup) {
        const assistantName = await getAssistantName();
        this.opts.registerGroup(envelope.jid, {
          name: envelope.displayName,
          folder: deriveGmailGroupFolder(this.instance.id, thread.id),
          trigger: `@${assistantName}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        });
        group = this.opts.registeredGroups()[envelope.jid];
        channelLog.info({ jid: envelope.jid }, 'Auto-registered Gmail thread');
      }
      if (!group) continue;

      const inboundMessage: NewMessage = {
        id: message.id,
        chat_jid: envelope.jid,
        sender: envelope.sender.email,
        sender_name: envelope.sender.name,
        content: envelope.content,
        timestamp: envelope.timestamp,
        is_from_me: false,
      };

      this.opts.onMessage(envelope.jid, inboundMessage);
      this.opts.onRealtimeMessage?.(envelope.jid, inboundMessage);

      const webChannel = getWebChannel();
      if (webChannel) {
        webChannel.notifyMessage(envelope.jid, {
          id: message.id,
          content: envelope.content,
          sender: envelope.sender.email,
          sender_name: envelope.sender.name,
          timestamp: envelope.timestamp,
          is_bot: false,
        });
      }

      this.recordSeen(message.id);
      channelLog.info(
        { jid: envelope.jid, sender: envelope.sender.email },
        'Gmail message stored',
      );
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
      channelLog.info(
        { jid, groupFolder: registeredGroup?.folder },
        'Gmail conversation reset via /reset',
      );
      await this.sendSystemReply(jid, t('channels.sessionReset', {}, undefined));
    } catch (err) {
      channelLog.error({ err, jid }, 'Failed to reset Gmail conversation');
      await this.sendSystemReply(jid, t('channels.resetFailed', {}, undefined));
    }
  }

  private async sendSystemReply(jid: string, text: string): Promise<void> {
    await this.sendMessage(jid, text);

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

    getWebChannel()?.notifyMessage(jid, {
      id: msgId,
      content: text,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      timestamp,
      is_bot: true,
    });
  }

  private parseEnvelope(
    threadId: string,
    message: GmailMessage,
  ): GmailEnvelope | null {
    const headers = message.payload?.headers;
    const from = parseAddress(getHeaderValue(headers, 'From'));
    const replyTo = parseAddress(
      getHeaderValue(headers, 'Reply-To') || from.email,
    );
    const subject =
      getHeaderValue(headers, 'Subject') || message.snippet || 'Gmail Thread';
    const references = getHeaderValue(headers, 'References');
    const messageIdHeader = getHeaderValue(headers, 'Message-ID');
    const timestamp = new Date(
      Number(message.internalDate || Date.now()),
    ).toISOString();
    const content =
      extractTextFromPart(message.payload) ||
      message.snippet?.trim() ||
      '[Empty email]';
    const jid = buildGmailJid(this.instance.id, threadId);
    const isFromSelf =
      (!!this.accountEmail &&
        from.email.toLowerCase() === this.accountEmail.toLowerCase()) ||
      (message.labelIds || []).includes('SENT');
    const displayName = subject.trim() || from.name || threadId;

    return {
      jid,
      threadId,
      messageId: message.id,
      timestamp,
      sender: from,
      replyTo,
      subject,
      content,
      isFromSelf,
      references,
      messageIdHeader,
      displayName,
    };
  }

  private async getThreadEnvelope(
    jid: string,
    threadId: string,
  ): Promise<GmailEnvelope | null> {
    const cached = this.threadCache.get(jid);
    if (cached) return cached;
    const thread = await this.apiFetch<GmailThread>(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    );
    const messages = [...(thread.messages || [])].sort(
      (left, right) =>
        Number(right.internalDate || 0) - Number(left.internalDate || 0),
    );
    for (const message of messages) {
      const envelope = this.parseEnvelope(threadId, message);
      if (envelope && !envelope.isFromSelf) {
        this.threadCache.set(jid, envelope);
        return envelope;
      }
    }
    const fallback = messages[0]
      ? this.parseEnvelope(threadId, messages[0])
      : null;
    if (fallback) this.threadCache.set(jid, fallback);
    return fallback;
  }

  private recordSeen(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > DEDUP_MAX) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first);
    }
  }

  private async refreshAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.accessToken && now < this.accessTokenExpiresAt - 60000) {
      return this.accessToken;
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Gmail token refresh failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as GmailTokenResponse;
    if (!payload.access_token) {
      throw new Error('Gmail token refresh response missing access_token');
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt =
      now + Math.max(60, Number(payload.expires_in || 3600)) * 1000;
    return this.accessToken;
  }

  private async apiFetch<T = unknown>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await this.refreshAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      const retriedToken = await this.refreshAccessToken(true);
      headers.set('Authorization', `Bearer ${retriedToken}`);
      const retriedResponse = await fetch(url, {
        ...init,
        headers,
      });
      if (!retriedResponse.ok) {
        throw new Error(
          `Gmail API request failed: ${retriedResponse.status} ${await retriedResponse.text()}`,
        );
      }
      return (await retriedResponse.json()) as T;
    }

    if (!response.ok) {
      throw new Error(
        `Gmail API request failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as T;
  }
}

class MultiGmailChannel implements Channel {
  name = 'gmail';

  constructor(private readonly channels: GmailChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Gmail instance owns JID: ${jid}`);
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

  private findChannel(jid: string): GmailChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}

registerChannel('gmail', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'gmail' && instance.enabled,
  );

  if (instances.length === 0) {
    channelLog.warn('Gmail: no enabled instances configured');
    return null;
  }

  const channels = instances
    .filter(
      (instance) =>
        String(instance.config.clientId || '').trim() &&
        String(instance.config.clientSecret || '').trim() &&
        String(instance.config.refreshToken || '').trim(),
    )
    .map((instance) => new GmailChannel(instance, opts));

  if (channels.length === 0) {
    channelLog.warn(
      'Gmail: enabled instances missing clientId/clientSecret/refreshToken',
    );
    return null;
  }

  return channels.length === 1 ? channels[0] : new MultiGmailChannel(channels);
});
