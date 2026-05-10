import { storeChatMetadata, storeMessage } from '../db.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
  type ChannelOpts,
} from '../channels/registry.js';
import { getConfiguredChannelInstances } from '../config-store-channel-instances.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from '../security/sender-allowlist.js';
import { channels, RELOAD_SAFE_CHANNELS, storedChannelOpts } from './runtime-state.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel');

function channelTypeFromChatJid(chatJid: string): string {
  const i = chatJid.indexOf(':');
  return i === -1 ? chatJid : chatJid.slice(0, i);
}

async function resolveChannelOwnerUserId(chatJid: string): Promise<string | undefined> {
  const colonIdx = chatJid.indexOf(':');
  if (colonIdx === -1) return undefined;
  const channelType = chatJid.slice(0, colonIdx);
  const rest = chatJid.slice(colonIdx + 1);
  const sepIdx = rest.indexOf(':');
  const instanceId = sepIdx === -1 ? 'default' : rest.slice(0, sepIdx).trim();
  if (!instanceId) return undefined;

  try {
    const instance = (await getConfiguredChannelInstances()).find(
      (entry) => entry.type === channelType && entry.id === instanceId,
    );
    if (!instance) return undefined;
    return instance.visibility === 'private' ? instance.owner_id : SYSTEM_USER_ID;
  } catch {
    return undefined;
  }
}

export type ChannelOptsCallbacks = {
  handleBuiltinInboundMessage: (
    chatJid: string,
    msg: NewMessage,
  ) => Promise<boolean>;
  advanceLastTimestamp: (timestamp: string, persist?: boolean) => void;
  queueUploadedFiles: (chatJid: string, message: NewMessage) => void;
  shouldDispatchRealtimeInboundMessage: (
    chatJid: string,
    msg: NewMessage,
  ) => Promise<boolean>;
  dispatchPendingMessages: (
    chatJid: string,
    groupMessages: NewMessage[],
  ) => Promise<void>;
  registerGroup: (
    jid: string,
    group: RegisteredGroup,
  ) => void | Promise<void>;
};

export function buildChannelOpts(
  callbacks: ChannelOptsCallbacks,
): ChannelOpts {
  return {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      if (await callbacks.handleBuiltinInboundMessage(chatJid, msg)) {
        return;
      }

      if (!msg.is_from_me && !msg.is_bot_message && registeredGroupsRef()[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            channelLog.debug(
              {
                chatJid,
                channelType: channelTypeFromChatJid(chatJid),
                sender: msg.sender,
              },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      await storeMessage(msg);
    },
    onRealtimeMessage: (chatJid: string, msg: NewMessage) => {
      callbacks.advanceLastTimestamp(msg.timestamp);
      callbacks.queueUploadedFiles(chatJid, msg);
      void callbacks
        .shouldDispatchRealtimeInboundMessage(chatJid, msg)
        .then((shouldDispatch) => {
          if (!shouldDispatch) return;
          callbacks.dispatchPendingMessages(chatJid, [msg]).catch((err) => {
            channelLog.error(
              { chatJid, channelType: channelTypeFromChatJid(chatJid), err },
              'Realtime dispatch failed',
            );
          });
        })
        .catch((err) => {
          channelLog.error(
            { chatJid, channelType: channelTypeFromChatJid(chatJid), err },
            'Realtime inbound message dispatch check failed',
          );
        });
    },
    onChatMetadata: async (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      const ownerUserId = await resolveChannelOwnerUserId(chatJid);
      await storeChatMetadata(chatJid, timestamp, name, channel, isGroup, ownerUserId);
    },
    registeredGroups: registeredGroupsRef,
    registerGroup: callbacks.registerGroup as ChannelOpts['registerGroup'],
  };
}

let registeredGroupsRef: () => Record<string, RegisteredGroup> = () => ({});

export function setChannelOptsRegisteredGroupsGetter(
  getter: () => Record<string, RegisteredGroup>,
): void {
  registeredGroupsRef = getter;
}

export async function reloadChannels(): Promise<{
  disconnected: string[];
  connected: string[];
  errors: string[];
}> {
  if (!storedChannelOpts) {
    throw new Error('Channel opts not initialized — server not fully started');
  }

  const disconnected: string[] = [];
  const connected: string[] = [];
  const errors: string[] = [];

  const kept: Channel[] = [];
  for (const ch of channels) {
    if (RELOAD_SAFE_CHANNELS.has(ch.name)) {
      kept.push(ch);
      continue;
    }
    try {
      await ch.disconnect();
      disconnected.push(ch.name);
    } catch (err) {
      channelLog.warn(
        { channel: ch.name, err },
        'Error disconnecting channel during reload',
      );
      disconnected.push(ch.name);
    }
  }

  channels.length = 0;
  channels.push(...kept);

  for (const channelName of getRegisteredChannelNames()) {
    if (RELOAD_SAFE_CHANNELS.has(channelName)) continue;
    try {
      const factory = getChannelFactory(channelName)!;
      const channel = await Promise.resolve(factory(storedChannelOpts));
      if (!channel) continue;
      channels.push(channel);
      await channel.connect();
      connected.push(channelName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${channelName}: ${msg}`);
      channelLog.error(
        { channel: channelName, err },
        'Failed to reconnect channel during reload',
      );
    }
  }

  channelLog.info({ disconnected, connected, errors }, 'Channel reload completed');
  return { disconnected, connected, errors };
}

export async function connectRegisteredChannels(
  channelOpts: ChannelOpts,
): Promise<void> {
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = await Promise.resolve(factory(channelOpts));
    if (!channel) {
      channelLog.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
}
