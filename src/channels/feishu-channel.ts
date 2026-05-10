/**
 * Feishu (飞书/Lark) channel for NanoClaw.
 *
 * Follows the same pattern as the Telegram channel:
 *   connect → listen for events → onChatMetadata + onMessage → done.
 *
 * Typing indicator uses the "Typing" emoji reaction for in-thread activity cues.
 * Auto-registers new private chats so users don't need manual setup.
 */
import * as lark from '@larksuiteoapi/node-sdk';

import {
  deleteConversationMessages,
  deleteSessionByJid,
  hasStoredMessage,
  storeMessageDirect,
  getRegisteredGroup,
  upsertConversationParticipant,
} from '../db.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-feishu');
import { ASSISTANT_NAME } from '../config.js';
import {
  ChannelInstanceConfig,
  getAssistantName,
  getConfiguredChannelInstances,
  getTriggerPattern,
} from '../config-store.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { getWebChannel } from './web.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import {
  buildFeishuMarkdownCard,
  buildFeishuMentionPostMessagePayload,
  buildFeishuPostMessagePayload,
  chunkFeishuText,
  resolveFeishuRenderMode,
  resolveFeishuReplyInThread,
  shouldUseFeishuCard,
} from './feishu-render.js';
import type { StructuredOutboundMessage } from '../types.js';
import type {
  FeishuChatMember,
  FeishuMention,
  FeishuMessageEvent,
  FeishuStreamCardState,
} from './feishu-types.js';
import {
  buildFeishuJid,
  deriveFeishuGroupFolder,
  getFeishuApiCode,
  parseFeishuJid,
} from './feishu-jid.js';
import { t } from '../i18n/index.js';

const MAX_TEXT_LENGTH = 4000;
const TYPING_EMOJI = 'Typing';
const DEDUP_MAX = 500;
const STREAM_UPDATE_THROTTLE_MS = 100;
const FEISHU_REACTION_DUPLICATE_REQUEST_CODE = 231015;

export const feishuChannelRegistry = new Map<string, FeishuChannel>();

export class FeishuChannel implements Channel {
  name: string;

  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private connected = false;
  private botOpenId = '';
  private opts: ChannelOpts;
  private instance: ChannelInstanceConfig;
  private appId: string;
  private appSecret: string;
  private domain: lark.Domain;

  private lastMessageId = new Map<string, string>();
  private activeReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();
  private pendingReactionAdds = new Set<string>();
  private seenIds = new Set<string>();
  private activeStreamCards = new Map<string, FeishuStreamCardState>();
  private assistantName = ASSISTANT_NAME;

  constructor(
    instance: ChannelInstanceConfig,
    opts: ChannelOpts,
    domain: lark.Domain = lark.Domain.Feishu,
  ) {
    this.instance = instance;
    this.name = `feishu:${instance.name}`;
    this.appId = String(instance.config.appId || '');
    this.appSecret = String(instance.config.appSecret || '');
    this.opts = opts;
    this.domain = domain;
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
    });
    feishuChannelRegistry.set(this.instance.id, this);
  }

  get instanceId(): string {
    return this.instance.id;
  }

  get statusName(): string {
    return `${t('errors.auto_7714e5', {}, undefined)} · ${this.instance.name}`;
  }

  private getRenderMode(): string {
    return String(this.instance.config.renderMode || 'auto');
  }

  private getReplyInThread(): string {
    return this.instance.config.replyInThread === true ? 'true' : 'false';
  }

  async connect(): Promise<void> {
    this.connected = false;
    this.assistantName = await getAssistantName();

    try {
      const res = await this.client.request<{
        code?: number;
        bot?: { open_id?: string; app_name?: string };
      }>({ method: 'GET', url: '/open-apis/bot/v3/info/' });
      this.botOpenId = res?.bot?.open_id || '';
      if (this.botOpenId) {
        channelLog.info(
          { openId: this.botOpenId, name: res.bot!.app_name },
          'Feishu bot info retrieved',
        );
      }
    } catch (err) {
      this.wsClient = null;
      channelLog.error({ err }, 'Failed to get Feishu bot info');
      return;
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const payload = data as Partial<FeishuMessageEvent>;
          channelLog.info(
            {
              hasSender: !!payload?.sender,
              hasMessage: !!payload?.message,
              messageId: payload?.message?.message_id,
              chatId: payload?.message?.chat_id,
              chatType: payload?.message?.chat_type,
              messageType: payload?.message?.message_type,
            },
            'Feishu raw event received',
          );
          this.handleMessage(data as FeishuMessageEvent);
        } catch (err) {
          channelLog.error({ err, data }, 'Failed to handle Feishu raw event');
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    try {
      await this.wsClient.start({ eventDispatcher });
    } catch (err) {
      this.wsClient = null;
      channelLog.error({ err }, 'Failed to start Feishu WebSocket client');
      return;
    }

    this.connected = true;
    channelLog.info({ channel: 'feishu' }, 'Channel ready');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const renderMode = resolveFeishuRenderMode(this.getRenderMode());
      const replyInThread = resolveFeishuReplyInThread(this.getReplyInThread());
      const useCard =
        renderMode === 'card' ||
        (renderMode === 'auto' && shouldUseFeishuCard(text));
      const chunks = useCard ? [text] : chunkFeishuText(text, MAX_TEXT_LENGTH);

      for (const chunk of chunks) {
        if (useCard) {
          await this.sendFeishuPayload(jid, {
            msgType: 'interactive',
            content: JSON.stringify(buildFeishuMarkdownCard(chunk)),
            replyInThread,
          });
        } else {
          const payload = buildFeishuPostMessagePayload(chunk);
          await this.sendFeishuPayload(jid, {
            msgType: payload.msgType,
            content: payload.content,
            replyInThread,
          });
        }
      }

      channelLog.info(
        { jid, length: text.length, renderMode, useCard, replyInThread },
        'Feishu message sent',
      );
    } catch (err) {
      channelLog.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  async sendStructuredMessage(
    jid: string,
    message: StructuredOutboundMessage,
  ): Promise<void> {
    const mentions =
      message.mentions?.filter((mention) => mention.channel === 'feishu') || [];
    if (mentions.length === 0) {
      await this.sendMessage(jid, message.text);
      return;
    }
    try {
      const renderMode = resolveFeishuRenderMode(this.getRenderMode());
      const replyInThread = resolveFeishuReplyInThread(this.getReplyInThread());
      const useCard =
        renderMode === 'card' ||
        (renderMode === 'auto' && shouldUseFeishuCard(message.text));
      if (useCard) {
        const mentionPayload = buildFeishuMentionPostMessagePayload(
          '',
          mentions,
        );
        await this.sendFeishuPayload(jid, {
          msgType: mentionPayload.msgType,
          content: mentionPayload.content,
          replyInThread,
        });
        const cardText = stripStructuredMentionLead(message.text);
        await this.sendFeishuPayload(jid, {
          msgType: 'interactive',
          content: JSON.stringify(
            buildFeishuMarkdownCard(cardText || message.text),
          ),
          replyInThread,
        });
      } else {
        const payload = buildFeishuMentionPostMessagePayload(
          message.text,
          mentions,
        );
        await this.sendFeishuPayload(jid, {
          msgType: payload.msgType,
          content: payload.content,
          replyInThread,
        });
      }
      channelLog.info(
        { jid, mentionCount: mentions.length, length: message.text.length },
        'Feishu structured message sent',
      );
    } catch (err) {
      channelLog.error({ jid, err }, 'Failed to send structured Feishu message');
      await this.sendMessage(jid, message.text);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getDocHelperClient(): lark.Client {
    return this.client;
  }

  getBotOpenId(): string {
    return this.botOpenId;
  }

  ownsJid(jid: string): boolean {
    const parsed = parseFeishuJid(jid);
    if (!parsed) return false;
    if (!parsed.explicit) return this.instance.id === 'default';
    return parsed.instanceId === this.instance.id;
  }

  async listChatMembers(chatJid: string): Promise<FeishuChatMember[]> {
    const parsed = parseFeishuJid(chatJid);
    if (!parsed || !this.ownsJid(chatJid)) {
      return [];
    }

    const members: FeishuChatMember[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;

    do {
      const response = await this.client.im.chatMembers.get({
        path: { chat_id: parsed.chatId },
        params: {
          member_id_type: 'open_id',
          page_size: 100,
          page_token: pageToken,
        },
      });
      const items = response.data?.items || [];
      for (const item of items) {
        const id = String(item.member_id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        members.push({
          id,
          name: String(item.name || '').trim() || id,
          chatJid,
          source: 'feishu_api',
        });
      }
      pageToken = response.data?.has_more
        ? String(response.data?.page_token || '').trim() || undefined
        : undefined;
    } while (pageToken);

    return members;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    this.activeStreamCards.clear();
    feishuChannelRegistry.delete(this.instance.id);
    channelLog.info('Feishu bot disconnected');
  }

  private async sendSystemReply(chatJid: string, text: string): Promise<void> {
    void this.sendMessage(chatJid, text);

    const timestamp = new Date().toISOString();
    const msgId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await storeMessageDirect({
      id: msgId,
      chat_jid: chatJid,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      content: text,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });

    const webCh = getWebChannel();
    if (webCh) {
      webCh.notifyMessage(chatJid, {
        id: msgId,
        content: text,
        sender: await getAssistantName(),
        sender_name: await getAssistantName(),
        timestamp,
        is_bot: true,
      });
    }
  }

  private notifyWebReset(chatJid: string): void {
    const webCh = getWebChannel();
    if (webCh) webCh.resetConversation(chatJid);
  }

  async sendStreamChunk(
    jid: string,
    text: string,
    done: boolean,
  ): Promise<void> {
    if (!done) {
      return;
    }

    const finalText = text.trim();
    this.activeStreamCards.delete(jid);
    if (!finalText) {
      return;
    }

    await this.sendMessage(jid, finalText);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const webCh = getWebChannel();
    if (webCh) webCh.setTyping(jid, isTyping);

    try {
      if (isTyping) {
        const msgId = this.lastMessageId.get(jid);
        if (!msgId) return;
        const activeReaction = this.activeReactions.get(jid);
        if (activeReaction?.messageId === msgId) return;
        if (this.pendingReactionAdds.has(jid)) return;

        this.pendingReactionAdds.add(jid);
        try {
          const res = await this.client.im.messageReaction.create({
            path: { message_id: msgId },
            data: { reaction_type: { emoji_type: TYPING_EMOJI } },
          });
          const reactionId = (res as any)?.data?.reaction_id ?? null;
          if (reactionId) {
            this.activeReactions.set(jid, { messageId: msgId, reactionId });
            channelLog.info({ jid, msgId }, 'Typing reaction added');
          } else {
            channelLog.warn(
              { jid, res: JSON.stringify(res) },
              'Typing reaction: no reaction_id returned',
            );
          }
        } finally {
          this.pendingReactionAdds.delete(jid);
        }
      } else {
        const active = this.activeReactions.get(jid);
        if (!active) return;
        this.activeReactions.delete(jid);
        await this.client.im.messageReaction.delete({
          path: {
            message_id: active.messageId,
            reaction_id: active.reactionId,
          },
        });
        channelLog.info({ jid }, 'Typing reaction removed');
      }
    } catch (err) {
      if (
        isTyping &&
        getFeishuApiCode(err) === FEISHU_REACTION_DUPLICATE_REQUEST_CODE
      ) {
        channelLog.debug({ jid }, 'Feishu typing reaction already being processed');
        return;
      }
      channelLog.warn({ jid, isTyping, err }, 'Feishu typing reaction failed');
    }
  }

  private async sendFeishuPayload(
    jid: string,
    payload: {
      msgType: 'interactive' | 'post';
      content: string;
      replyInThread: boolean;
    },
  ): Promise<any> {
    const parsedJid = parseFeishuJid(jid);
    if (!parsedJid || !this.ownsJid(jid)) {
      throw new Error(
        `Feishu instance ${this.instance.id} cannot handle JID ${jid}`,
      );
    }
    const chatId = parsedJid.chatId;
    const replyToMessageId = this.lastMessageId.get(jid);
    const shouldReplyToMessage = payload.replyInThread && !!replyToMessageId;

    if (shouldReplyToMessage && replyToMessageId) {
      try {
        return await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: payload.msgType,
            content: payload.content,
            reply_in_thread: true,
          },
        });
      } catch (err) {
        channelLog.warn(
          { jid, replyToMessageId, err },
          'Feishu reply failed, falling back to direct send',
        );
      }
    }

    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: payload.msgType,
        content: payload.content,
      },
    });
  }

  private ensureStreamState(jid: string): FeishuStreamCardState {
    let state = this.activeStreamCards.get(jid);
    if (state) {
      return state;
    }
    state = {
      messageId: '',
      text: '',
      pendingText: null,
      lastUpdateAt: 0,
      queue: Promise.resolve(),
    };
    this.activeStreamCards.set(jid, state);
    return state;
  }

  private queueStreamFlush(jid: string, done: boolean): Promise<void> {
    const state = this.ensureStreamState(jid);
    state.queue = state.queue
      .then(async () => {
        await this.flushStreamState(jid, done);
      })
      .catch((err) => {
        channelLog.warn({ jid, err }, 'Feishu stream card update failed');
        this.activeStreamCards.delete(jid);
      });
    return done ? state.queue : Promise.resolve();
  }

  private async flushStreamState(jid: string, done: boolean): Promise<void> {
    const state = this.activeStreamCards.get(jid);
    if (!state) {
      return;
    }

    const nextText = state.pendingText ?? state.text;
    if (!nextText) {
      if (done) {
        this.activeStreamCards.delete(jid);
      }
      return;
    }

    if (state.messageId && nextText === state.text) {
      if (done) {
        this.activeStreamCards.delete(jid);
      }
      return;
    }

    const replyInThread = resolveFeishuReplyInThread(this.getReplyInThread());
    const content = JSON.stringify(buildFeishuMarkdownCard(nextText));

    if (state.messageId) {
      await this.client.im.message.patch({
        path: { message_id: state.messageId },
        data: { content },
      } as any);
      state.text = nextText;
      state.pendingText = null;
      if (done) {
        this.activeStreamCards.delete(jid);
      }
      return;
    }

    const response = await this.sendFeishuPayload(jid, {
      msgType: 'interactive',
      content,
      replyInThread,
    });
    state.messageId = response?.data?.message_id || '';
    state.text = nextText;
    state.pendingText = null;
    if (done) {
      this.activeStreamCards.delete(jid);
    }
  }

  private async handleMessage(data: FeishuMessageEvent): Promise<void> {
    const { sender, message } = data;

    if (!sender || !message) {
      channelLog.warn({ data }, 'Feishu event missing sender or message');
      return;
    }

    if (sender.sender_type !== 'user') {
      channelLog.info(
        { senderType: sender.sender_type, messageId: message.message_id },
        'Ignoring non-user Feishu event',
      );
      return;
    }

    const chatJid = buildFeishuJid(this.instance.id, message.chat_id);

    if (this.seenIds.has(message.message_id)) return;
    if (await hasStoredMessage(chatJid, message.message_id)) {
      this.recordSeen(message.message_id);
      this.lastMessageId.set(chatJid, message.message_id);
      channelLog.info(
        { chatJid, messageId: message.message_id },
        'Ignoring replayed Feishu event already stored in DB',
      );
      return;
    }
    this.recordSeen(message.message_id);
    const timestamp = new Date(Number(message.create_time)).toISOString();
    const senderOpenId = sender.sender_id?.open_id || '';
    const isGroup = message.chat_type === 'group';

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    const content = this.parseContent(message);
    if (
      content.trim() === '/reset' ||
      content.replace(/^@\w+\s*/, '').trim() === '/reset'
    ) {
      try {
        const registeredGroup = await getRegisteredGroup(chatJid);
        await deleteConversationMessages(chatJid);
        await deleteSessionByJid(chatJid);
        if (registeredGroup) {
          clearCodexConversationState(registeredGroup.folder);
        }
        this.notifyWebReset(chatJid);
        channelLog.info(
          { chatJid, groupFolder: registeredGroup?.folder },
          'Feishu conversation reset via /reset',
        );
        this.sendSystemReply(chatJid, t('channels.sessionReset', {}, undefined));
      } catch (err) {
        channelLog.error({ chatJid, err }, 'Failed to reset conversation');
        this.sendSystemReply(chatJid, t('channels.resetFailed', {}, undefined));
      }
      return;
    }

    let group = this.opts.registeredGroups()[chatJid];
    if (!group && this.opts.registerGroup) {
      const suffix = message.chat_id.replace(/^oc_/, '').slice(0, 16);
      const assistantName = await getAssistantName();
      this.opts.registerGroup(chatJid, {
        name: isGroup
          ? `${this.instance.name} · Feishu Group ${suffix}`
          : `${this.instance.name} · Feishu DM ${suffix}`,
        folder: deriveFeishuGroupFolder(this.instance.id, message.chat_id),
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: isGroup,
        isMain: false,
      });
      group = this.opts.registeredGroups()[chatJid];
      channelLog.info({ chatJid }, 'Auto-registered Feishu chat');
    }
    if (!group) return;

    this.lastMessageId.set(chatJid, message.message_id);

    const senderName = this.resolveSenderName(message.mentions, senderOpenId);
    await upsertConversationParticipant({
      chatJid,
      channel: 'feishu',
      memberId: senderOpenId,
      memberName: senderName,
      source: 'feishu_message',
      lastSeenAt: timestamp,
    });
    for (const mention of message.mentions || []) {
      const mentionOpenId = String(mention.id.open_id || '').trim();
      if (!mentionOpenId) continue;
      await upsertConversationParticipant({
        chatJid,
        channel: 'feishu',
        memberId: mentionOpenId,
        memberName: mention.name,
        source: 'feishu_message',
        lastSeenAt: timestamp,
      });
    }
    const inboundMessage = {
      id: message.message_id,
      chat_jid: chatJid,
      sender: senderOpenId,
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
        id: message.message_id,
        content,
        sender: senderOpenId,
        sender_name: senderName,
        timestamp,
        is_bot: false,
      });
    }

    channelLog.info({ chatJid, sender: senderOpenId }, 'Feishu message stored');
  }

  private recordSeen(id: string): void {
    this.seenIds.add(id);
    if (this.seenIds.size > DEDUP_MAX) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first);
    }
  }

  private parseContent(msg: FeishuMessageEvent['message']): string {
    if (msg.message_type !== 'text') {
      return this.placeholder(msg.message_type, msg.content);
    }

    let text: string;
    try {
      text = JSON.parse(msg.content).text ?? msg.content;
    } catch {
      text = msg.content;
    }

    if (msg.mentions?.length) {
      for (const m of msg.mentions) {
        text = text.replace(m.key, `@${m.name}`);
      }
    }

    const botMentioned =
      this.botOpenId &&
      msg.mentions?.some((m) => m.id.open_id === this.botOpenId);
    if (botMentioned && !getTriggerPattern(this.assistantName).test(text)) {
      text = `@${this.assistantName} ${text}`;
    }

    return text;
  }

  private placeholder(type: string, raw: string): string {
    let caption = '';
    try {
      const p = JSON.parse(raw);
      if (p.caption) caption = ` ${p.caption}`;
      else if (p.file_name) caption = ` ${p.file_name}`;
    } catch {
      // ignore
    }

    const labels: Record<string, string> = {
      image: '[Photo]',
      video: '[Video]',
      audio: '[Audio]',
      file: '[File]',
      sticker: '[Sticker]',
      post: '[Rich Text]',
      merge_forward: '[Forwarded Messages]',
      share_chat: '[Shared Chat]',
    };
    return `${labels[type] || `[${type}]`}${caption}`;
  }

  private resolveSenderName(
    mentions: FeishuMention[] | undefined,
    senderOpenId: string,
  ): string {
    if (mentions) {
      for (const m of mentions) {
        if (m.id.open_id === senderOpenId) return m.name;
      }
    }
    return senderOpenId || 'Unknown';
  }
}

function stripStructuredMentionLead(text: string): string {
  const lines = text.split(/\r?\n/);
  const firstLine = lines[0]?.trim() || '';
  if (firstLine.startsWith('@') && firstLine.includes(t('channels.auto_cf72d6', {}, undefined))) {
    return lines.slice(1).join('\n').trim();
  }
  return text.trim();
}

class MultiFeishuChannel implements Channel {
  name = 'feishu';

  constructor(private readonly channels: FeishuChannel[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.connect()));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Feishu instance owns JID: ${jid}`);
    }
    await channel.sendMessage(jid, text);
  }

  async sendStructuredMessage(
    jid: string,
    message: StructuredOutboundMessage,
  ): Promise<void> {
    const channel = this.findChannel(jid);
    if (!channel) {
      throw new Error(`No Feishu instance owns JID: ${jid}`);
    }
    await channel.sendStructuredMessage(jid, message);
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

  private findChannel(jid: string): FeishuChannel | undefined {
    return this.channels.find((channel) => channel.ownsJid(jid));
  }
}


registerChannel('feishu', async (opts: ChannelOpts) => {
  const instances = (await getConfiguredChannelInstances()).filter(
    (instance) => instance.type === 'feishu' && instance.enabled,
  );

  if (instances.length === 0) {
    channelLog.warn('Feishu: no enabled instances configured');
    return null;
  }

  const channels = instances
    .filter(
      (instance) =>
        String(instance.config.appId || '').trim() &&
        String(instance.config.appSecret || '').trim(),
    )
    .map((instance) => {
      const domainStr = String(
        instance.config.domain || 'feishu',
      ).toLowerCase();
      const domain =
        domainStr === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
      return new FeishuChannel(instance, opts, domain);
    });

  if (channels.length === 0) {
    channelLog.warn('Feishu: enabled instances missing App ID or App Secret');
    return null;
  }

  return channels.length === 1 ? channels[0] : new MultiFeishuChannel(channels);
});
