import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetChannelRegistryForTests,
  registerChannel,
} from '../channels/registry.js';
import { _initTestDatabase } from '../db.js';
import { upsertChannelInstance } from '../tenant/tenant-db.js';
import type { Channel } from '../types.js';
import { assignStoredChannelOpts, channels } from './runtime-state.js';
import {
  connectRegisteredChannels,
  reloadChannels,
} from './runtime-channels.js';

class FakeChannel implements Channel {
  connected = false;
  disconnected = false;

  constructor(public name: string) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendMessage(): Promise<void> {
    /* not needed for runtime lifecycle tests */
  }
}

function createChannelOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

describe('runtime channel lifecycle with user channel instances', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetChannelRegistryForTests();
    channels.length = 0;
    assignStoredChannelOpts(null);
  });

  it('connects user channel instances during startup through the main registry factory', async () => {
    await upsertChannelInstance('user-a', {
      id: 'telegram-user-a',
      type: 'telegram',
      name: 'User A Telegram',
      enabled: true,
      configJson: JSON.stringify({ botToken: 'tg-token-a' }),
    });

    registerChannel('telegram', async () => {
      const configStore = await import('../config-store.js');
      const ids = (await configStore.getConfiguredChannelInstances())
        .filter((instance) => instance.type === 'telegram' && instance.enabled)
        .map((instance) => instance.id);
      return new FakeChannel(`telegram:${ids.join(',')}`);
    });

    await connectRegisteredChannels(createChannelOpts());

    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('telegram:telegram-user-a');
    expect(channels[0]?.isConnected()).toBe(true);
  });

  it('reloads user channel instances through the main runtime reload path', async () => {
    await upsertChannelInstance('user-a', {
      id: 'telegram-user-a',
      type: 'telegram',
      name: 'User A Telegram',
      enabled: true,
      configJson: JSON.stringify({ botToken: 'tg-token-a' }),
    });

    registerChannel('telegram', async () => {
      const configStore = await import('../config-store.js');
      const ids = (await configStore.getConfiguredChannelInstances())
        .filter((instance) => instance.type === 'telegram' && instance.enabled)
        .map((instance) => instance.id)
        .sort();
      return new FakeChannel(`telegram:${ids.join(',')}`);
    });

    const opts = createChannelOpts();
    assignStoredChannelOpts(opts);
    await connectRegisteredChannels(opts);

    await upsertChannelInstance('user-b', {
      id: 'telegram-user-b',
      type: 'telegram',
      name: 'User B Telegram',
      enabled: true,
      configJson: JSON.stringify({ botToken: 'tg-token-b' }),
    });

    const result = await reloadChannels();

    expect(result).toEqual({
      disconnected: ['telegram:telegram-user-a'],
      connected: ['telegram'],
      errors: [],
    });
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('telegram:telegram-user-a,telegram-user-b');
    expect(channels[0]?.isConnected()).toBe(true);
  });
});
