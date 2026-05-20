/**
 * Compatibility facade for per-user channel instances.
 *
 * User-owned instances are now merged by config-store-channel-instances into
 * the same runtime instance list as global CHANNEL_INSTANCES. Startup and reload
 * are owned by runtime-channels; this module no longer maintains a second
 * connection pool.
 */
import type { ChannelOpts } from '../channels/registry.js';
import { getConfiguredUserChannelInstances } from '../config-store-channel-instances.js';
import { createModuleLogger } from '../logger.js';
import { channels, storedChannelOpts } from '../runtime/runtime-state.js';
import {
  connectRegisteredChannels,
  reloadChannels,
} from '../runtime/runtime-channels.js';

const channelLog = createModuleLogger('channel-manager');

export async function loadUserChannelInstances(
  channelOpts: ChannelOpts,
): Promise<void> {
  if (storedChannelOpts) {
    await reloadChannels();
    return;
  }
  if (channels.length > 0) {
    channelLog.warn(
      'Skipping user channel compatibility load because runtime channels are already connected without stored opts',
    );
    return;
  }
  await connectRegisteredChannels(channelOpts);
}

export async function disconnectUserChannelInstance(
  instanceId: string,
): Promise<void> {
  try {
    await reloadChannels();
    channelLog.info({ instanceId }, 'User channel instance reload requested');
  } catch (err) {
    channelLog.error(
      { err, instanceId },
      'Error reloading user channel instance',
    );
  }
}

export async function disconnectAllUserChannels(): Promise<void> {
  await reloadChannels();
}

export async function getUserChannelInstances(): Promise<
  Array<{
    id: string;
    userId: string;
    type: string;
    connected: boolean;
  }>
> {
  const statusNames = new Set(
    channels.flatMap(
      (channel) =>
        channel.getStatusEntries?.().map((entry) => entry.name) ?? [
          channel.name,
        ],
    ),
  );
  const instances = await getConfiguredUserChannelInstances();
  return instances.map((inst) => ({
    id: inst.id,
    userId: inst.owner_id,
    type: inst.type,
    connected:
      statusNames.has(`${inst.type}:${inst.name}`) ||
      [...statusNames].some((name) => name.startsWith(`${inst.type}:`)),
  }));
}
