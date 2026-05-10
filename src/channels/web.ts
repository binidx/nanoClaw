/**
 * Web channel for NanoClaw.
 * Receives messages from the browser-based frontend via WebSocket.
 * Follows the same pattern as Telegram/Feishu channels.
 */
import crypto from 'crypto';
import { WebSocket } from 'ws';

import { getAssistantName } from '../config-store.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-web');
import {
  createRealtimeEnvelope,
  getConversationLastEventSeq,
  type RealtimeEventType,
} from '../runtime/realtime-events.js';
import { sanitizeAgentEventForWeb } from '../conversation/conversation-turn-visibility.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  AgentApprovalRequestPayload,
  AgentApprovalResolvedPayload,
  AgentAskRequestPayload,
  AgentAskResolvedPayload,
  AgentEventPayload,
  AgentTurnEventPayload,
} from '../agent/agent-runner.js';
import { AgentUploadedFile, Channel } from '../types.js';

let globalWebChannel: WebChannel | null = null;

export function deriveWebGroupFolder(jid: string): string {
  return `web_${crypto.createHash('sha1').update(jid).digest('hex').slice(0, 16)}`;
}

export function getWebChannel(): WebChannel | null {
  return globalWebChannel;
}

export interface WebInboundAcceptance {
  messageId: string;
  serverTimestamp: string;
  runId: string;
  clientId?: string;
  lastEventSeq: number;
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: ChannelOpts;
  private clients = new Map<string, Set<WebSocket>>();
  private clientSubscriptions = new WeakMap<WebSocket, Set<string>>();
  private clientCloseHandlers = new WeakMap<WebSocket, () => void>();
  private connected = false;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    channelLog.info({ channel: 'web' }, 'Channel ready');
  }

  /** Register a WebSocket client for a specific conversation */
  addClient(jid: string, ws: WebSocket): void {
    let subscriptions = this.clientSubscriptions.get(ws);
    if (!subscriptions) {
      subscriptions = new Set<string>();
      this.clientSubscriptions.set(ws, subscriptions);
    }
    if (subscriptions.has(jid)) {
      return;
    }
    subscriptions.add(jid);

    let set = this.clients.get(jid);
    if (!set) {
      set = new Set();
      this.clients.set(jid, set);
    }
    set.add(ws);

    let closeHandler = this.clientCloseHandlers.get(ws);
    if (!closeHandler) {
      closeHandler = () => {
        const subscribedJids = this.clientSubscriptions.get(ws);
        if (!subscribedJids) return;
        for (const subscribedJid of subscribedJids) {
          const clientSet = this.clients.get(subscribedJid);
          if (!clientSet) continue;
          clientSet.delete(ws);
          if (clientSet.size === 0) {
            this.clients.delete(subscribedJid);
          }
        }
        this.clientSubscriptions.delete(ws);
        this.clientCloseHandlers.delete(ws);
      };
      this.clientCloseHandlers.set(ws, closeHandler);
      ws.on('close', closeHandler);
    }
  }

  /** Broadcast to ALL connected clients (for global events) */
  broadcast(event: Record<string, unknown>): void {
    const msg = JSON.stringify(event);
    for (const set of this.clients.values()) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  }

  /** Send workteam event only to clients subscribed to the specific workteam JID */
  emitWorkteamEvent(jid: string, event: Record<string, unknown>): void {
    this.broadcastTo(jid, event);
  }

  /** Handle an inbound message from the web frontend */
  async handleInboundMessage(
    jid: string,
    content: string,
    senderName = 'Web User',
    extras?: {
      uploadedFiles?: AgentUploadedFile[];
      clientId?: string;
      channelName?: string;
    },
  ): Promise<WebInboundAcceptance> {
    const timestamp = new Date().toISOString();
    const msgId = `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const runId = extras?.clientId?.trim() || `run_${msgId}`;
    const isGroup = false;
    const channelName =
      extras?.channelName === 'repo-review' ? 'repo-review' : 'web';
    const assistantName = await getAssistantName();

    this.opts.onChatMetadata(jid, timestamp, senderName, channelName, isGroup);

    // Auto-register if needed
    let group = this.opts.registeredGroups()[jid];
    if (!group && this.opts.registerGroup) {
      const suffix = jid.replace(/^web:/, '').slice(0, 16);
      this.opts.registerGroup(jid, {
        name: `Web Chat ${suffix}`,
        folder: deriveWebGroupFolder(jid),
        trigger: `@${assistantName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: false,
      });
      group = this.opts.registeredGroups()[jid];
      channelLog.info({ jid }, 'Auto-registered Web chat');
    }
    if (!group) {
      throw new Error(`Web chat is not registered: ${jid}`);
    }

    const message = {
      id: msgId,
      chat_jid: jid,
      sender: 'web_user',
      sender_name: senderName,
      content: `@${assistantName} ${content}`,
      timestamp,
      run_id: runId,
      ...(extras?.clientId ? { client_id: extras.clientId } : {}),
      is_from_me: false,
      ...(extras?.uploadedFiles?.length
        ? { uploaded_files: extras.uploadedFiles }
        : {}),
    };

    this.opts.onMessage(jid, message);
    this.opts.onRealtimeMessage?.(jid, message);
    const realtimeMeta = this.notifyMessage(jid, {
      id: msgId,
      content: message.content,
      sender: message.sender,
      sender_name: message.sender_name,
      timestamp: message.timestamp,
      is_bot: false,
      client_id: extras?.clientId,
      run_id: runId,
      is_from_me: true,
    });

    channelLog.info({ jid }, 'Web message stored');
    return {
      messageId: msgId,
      serverTimestamp: timestamp,
      runId,
      clientId: extras?.clientId,
      lastEventSeq: realtimeMeta.seq,
    };
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const msgId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.notifyMessage(jid, {
      id: msgId,
      content: text,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      timestamp: new Date().toISOString(),
      is_bot: true,
      is_from_me: true,
    });

    channelLog.info({ jid, length: text.length }, 'Web message sent');
  }

  /**
   * Notify web clients about a message from any channel (cross-channel relay).
   * Used so the web frontend can display feishu/telegram messages in real-time.
   */
  notifyMessage(
    jid: string,
    msg: {
      id: string;
      content: string;
      sender: string;
      sender_name: string;
      timestamp: string;
      is_bot: boolean;
      client_id?: string;
      run_id?: string;
      is_from_me?: boolean;
      turn_id?: string;
      [key: string]: unknown;
    },
  ) {
    const { id, content, sender, sender_name, timestamp, is_bot,
      client_id, run_id, is_from_me, turn_id,
      ...rest } = msg;
    return this.emitToConversation(
      jid,
      'message',
      {
        type: 'message',
        id,
        jid,
        content,
        sender,
        sender_name,
        timestamp,
        is_bot,
        client_id,
        run_id,
        is_from_me,
        turn_id,
        ...rest,
      },
      {
        timestamp,
        runId: run_id || turn_id,
        clientId: client_id,
      },
    );
  }

  notifyAgentEvent(jid: string, event: AgentEventPayload): void {
    const visibleEvent = sanitizeAgentEventForWeb(event);
    if (!visibleEvent) return;
    this.emitToConversation(jid, 'agent_event', {
      type: 'agent_event',
      jid,
      event: visibleEvent,
    });
  }

  notifyTurnEvent(jid: string, event: AgentTurnEventPayload): void {
    this.emitToConversation(
      jid,
      'turn_event',
      {
        type: 'turn_event',
        jid,
        event,
      },
      {
        timestamp: event.timestamp,
        runId: event.turnId,
      },
    );
  }

  notifyApprovalRequest(
    jid: string,
    approval: AgentApprovalRequestPayload,
  ): void {
    this.emitToConversation(
      jid,
      'approval_request',
      {
        type: 'approval_request',
        jid,
        approval,
      },
      {
        timestamp: approval.createdAt,
      },
    );
  }

  notifyApprovalResolved(
    jid: string,
    resolution: AgentApprovalResolvedPayload,
  ): void {
    this.emitToConversation(
      jid,
      'approval_resolved',
      {
        type: 'approval_resolved',
        jid,
        resolution,
      },
      {
        timestamp: resolution.resolvedAt,
      },
    );
  }

  notifyAskRequest(
    jid: string,
    askRequest: AgentAskRequestPayload,
  ): void {
    this.emitToConversation(
      jid,
      'ask_request',
      {
        type: 'ask_request',
        jid,
        askRequest,
      },
      {
        timestamp: askRequest.createdAt,
      },
    );
  }

  notifyAskResolved(
    jid: string,
    askResolved: AgentAskResolvedPayload,
  ): void {
    this.emitToConversation(
      jid,
      'ask_resolved',
      {
        type: 'ask_resolved',
        jid,
        askResolved,
      },
      {
        timestamp: askResolved.resolvedAt,
      },
    );
  }

  notifyLive2DEmotion(
    jid: string,
    emotion: string,
    turnId: string,
  ): void {
    this.emitToConversation(jid, 'live2d_emotion', {
      type: 'live2d_emotion',
      jid,
      emotion,
      turnId,
    });
  }

  notifyInterrupted(
    jid: string,
    payload: { timestamp: string; reason?: string },
  ): void {
    this.emitToConversation(
      jid,
      'interrupted',
      {
        type: 'interrupted',
        jid,
        ...payload,
      },
      {
        timestamp: payload.timestamp,
      },
    );
  }

  resetConversation(jid: string): void {
    this.emitToConversation(jid, 'reset', { type: 'reset', jid });
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastEventSeq(jid: string): number {
    return getConversationLastEventSeq(jid);
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    for (const set of this.clients.values()) {
      for (const ws of set) ws.close();
    }
    this.clients.clear();
    this.connected = false;
    channelLog.info('Web channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    this.emitToConversation(jid, 'typing', { type: 'typing', jid, isTyping });
  }

  emitImEvent(jid: string, payload: Record<string, unknown>): void {
    const roomSeq = typeof payload.room_seq === 'number' ? payload.room_seq : undefined;
    this.emitToConversation(jid, 'im_event', { ...payload, jid }, { seq: roomSeq });
  }

  async sendStreamChunk(
    jid: string,
    text: string,
    done: boolean,
    runId?: string,
  ): Promise<void> {
    this.emitToConversation(
      jid,
      'stream',
      { type: 'stream', jid, text, done },
      { runId },
    );
  }

  private emitToConversation(
    jid: string,
    eventType: RealtimeEventType,
    payload: Record<string, unknown>,
    options?: {
      timestamp?: string;
      runId?: string;
      clientId?: string;
      seq?: number;
    },
  ) {
    const envelope = createRealtimeEnvelope({
      jid,
      eventType,
      payload,
      timestamp: options?.timestamp,
      runId: options?.runId,
      clientId: options?.clientId,
      seq: options?.seq,
    });
    this.broadcastTo(jid, envelope);
    return envelope;
  }

  private broadcastTo(jid: string, payload: unknown): void {
    const msg = JSON.stringify(payload);
    const sent = new Set<WebSocket>();
    const set = this.clients.get(jid);
    if (set) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
          sent.add(ws);
        }
      }
    }
    const allSet = this.clients.get('*');
    if (allSet) {
      for (const ws of allSet) {
        if (ws.readyState === WebSocket.OPEN && !sent.has(ws)) ws.send(msg);
      }
    }
  }
}

// Self-registration — web channel is always available (no credentials needed)
registerChannel('web', (opts: ChannelOpts) => {
  const channel = new WebChannel(opts);
  globalWebChannel = channel;
  return channel;
});
