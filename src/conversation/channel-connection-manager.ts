/**
 * Manages per-user channel instances.
 * Each user can have their own Discord/Telegram/Feishu bot connections.
 * Connections are stored in DB and loaded at startup.
 */
import type { Channel, RegisteredGroup, OnInboundMessage, OnChatMetadata } from '../types.js';
import { getChannelFactory, type ChannelOpts } from '../channels/registry.js';
import { getAllEnabledChannelInstances } from '../tenant/tenant-db.js';
import { decryptValue } from '../crypto.js';
import { createModuleLogger } from '../logger.js';

const channelLog = createModuleLogger('channel-manager');

interface ManagedChannelInstance {
  id: string;
  userId: string;
  type: string;
  channel: Channel | null;
}

const activeInstances = new Map<string, ManagedChannelInstance>();

export async function loadUserChannelInstances(
  channelOpts: ChannelOpts,
): Promise<void> {
  const instances = await getAllEnabledChannelInstances();

  for (const inst of instances) {
    if (activeInstances.has(inst.id)) continue;

    try {
      const factory = getChannelFactory(inst.type);
      if (!factory) {
        channelLog.warn({ type: inst.type, instanceId: inst.id }, 'Unknown channel type for user instance');
        continue;
      }

      let config: Record<string, string>;
      try {
        const raw = JSON.parse(inst.config_json);
        config = {};
        for (const [k, v] of Object.entries(raw)) {
          config[k] = typeof v === 'string' ? decryptValue(v) : String(v);
        }
      } catch {
        channelLog.warn({ instanceId: inst.id }, 'Invalid config_json for channel instance');
        continue;
      }

      // Inject instance-specific config into process.env temporarily for factory
      const savedEnv: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(config)) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
      }

      const channel = await factory(channelOpts);

      // Restore env
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }

      if (channel) {
        await channel.connect();
        activeInstances.set(inst.id, {
          id: inst.id,
          userId: inst.user_id,
          type: inst.type,
          channel,
        });
        channelLog.info(
          { instanceId: inst.id, type: inst.type, userId: inst.user_id },
          'User channel instance connected',
        );
      }
    } catch (err) {
      channelLog.error(
        { err, instanceId: inst.id, type: inst.type },
        'Failed to connect user channel instance',
      );
    }
  }
}

export async function disconnectUserChannelInstance(instanceId: string): Promise<void> {
  const inst = activeInstances.get(instanceId);
  if (!inst?.channel) return;

  try {
    inst.channel.disconnect();
    activeInstances.delete(instanceId);
    channelLog.info({ instanceId }, 'User channel instance disconnected');
  } catch (err) {
    channelLog.error({ err, instanceId }, 'Error disconnecting user channel instance');
  }
}

export async function disconnectAllUserChannels(): Promise<void> {
  for (const [id] of activeInstances) {
    await disconnectUserChannelInstance(id);
  }
}

export function getUserChannelInstances(): Array<{
  id: string;
  userId: string;
  type: string;
  connected: boolean;
}> {
  return [...activeInstances.values()].map((inst) => ({
    id: inst.id,
    userId: inst.userId,
    type: inst.type,
    connected: inst.channel !== null,
  }));
}
