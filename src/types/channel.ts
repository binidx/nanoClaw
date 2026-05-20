import type { NewMessage } from './messaging.js';

export interface OutboundMention {
  channel: 'feishu';
  id: string;
  name?: string;
}

export interface StructuredOutboundMessage {
  text: string;
  mentions?: OutboundMention[];
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendStructuredMessage?(
    jid: string,
    message: StructuredOutboundMessage,
  ): Promise<void>;
  isConnected(): boolean;
  getStatusEntries?(): Array<{ name: string; connected: boolean }>;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: streaming output. Web channel sends chunks in real-time.
  sendStreamChunk?(jid: string, text: string, done: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  chatJid: string,
  message: NewMessage,
) => void | Promise<void>;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void | Promise<void>;
