import { describe, expect, it } from 'vitest';

import {
  buildDiscordJid,
  deriveDiscordGroupFolder,
  DiscordChannel,
} from './discord.js';
import type { ChannelOpts } from './registry.js';
import type { ChannelInstanceConfig } from '../config-store.js';

function createOpts(): ChannelOpts {
  return {
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  };
}

describe('discord channel helpers', () => {
  it('builds instance-aware JIDs', () => {
    expect(buildDiscordJid('default', '123')).toBe('discord:123');
    expect(buildDiscordJid('team-a', '123')).toBe('discord:team-a:123');
  });

  it('derives stable group folders', () => {
    expect(deriveDiscordGroupFolder('default', '123')).toMatch(
      /^discord_default_/,
    );
    expect(deriveDiscordGroupFolder('team-a', '123')).toMatch(
      /^discord_team_a_/,
    );
    expect(deriveDiscordGroupFolder('team-a', '123')).toBe(
      deriveDiscordGroupFolder('team-a', '123'),
    );
  });

  it('owns only its instance JIDs', () => {
    const instance = {
      id: 'team-a',
      type: 'discord',
      name: 'Team A',
      enabled: true,
      config: {
        botToken: 'token',
      },
    } satisfies ChannelInstanceConfig;

    const channel = new DiscordChannel(instance, createOpts());

    expect(channel.ownsJid('discord:team-a:123')).toBe(true);
    expect(channel.ownsJid('discord:team-b:123')).toBe(false);
    expect(channel.ownsJid('discord:123')).toBe(false);
  });

  it('default instance owns legacy JIDs', () => {
    const instance = {
      id: 'default',
      type: 'discord',
      name: 'Default',
      enabled: true,
      config: {
        botToken: 'token',
      },
    } satisfies ChannelInstanceConfig;

    const channel = new DiscordChannel(instance, createOpts());

    expect(channel.ownsJid('discord:123')).toBe(true);
    expect(channel.ownsJid('discord:default:123')).toBe(true);
  });
});
