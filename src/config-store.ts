// Priority: DB (via getConfig) > default value.
// For WEB_EXTERNAL_URL: DB config > env var > detected URL from request > localhost fallback.
// Runtime configuration is expected to come from the database/UI after startup.

import { getConfig, getConfigBatch } from './db.js';
import { getDetectedBaseUrl } from './detected-base-url.js';
import {
  getResolvedChannelTypeDefinitions,
  getResolvedConversationCreateTargetDefinitions,
  resolveAvailableConversationCreateTargets,
} from './conversation/channel-metadata.js';
import type {
  ChannelTypeDefinition,
  ConversationCreateTargetDefinition,
} from './config-channel-definitions.js';
import { DEFAULTS } from './config-store-defaults.js';
import {
  WEB_CONFIG_KEYS,
  WEB_CONFIG_METADATA,
  type ConfigKeyMetadata,
  type WebConfigKey,
} from './config-store-metadata.js';
import { getConfiguredChannelInstances } from './config-store-channel-instances.js';

export type {
  ChannelFieldOption,
  ChannelFieldDefinition,
  ChannelFieldType,
  ChannelTypeDefinition,
  ConfigEffect,
  ConfigRisk,
  ConversationCreateFieldDefinition,
  ConversationCreateFieldType,
  ConversationCreateTargetDefinition,
} from './config-channel-definitions.js';

export { DEFAULTS } from './config-store-defaults.js';
export {
  WEB_CONFIG_KEYS,
  WEB_CONFIG_METADATA,
  type WebConfigKey,
  type ConfigKeyMetadata,
} from './config-store-metadata.js';
export {
  CHANNEL_INSTANCES_CONFIG_KEY,
  type ChannelInstanceConfig,
  type ChannelVisibility,
  getConfiguredChannelInstances,
  getSanitizedChannelInstances,
  getSanitizedChannelInstancesForUser,
  normalizeChannelInstances,
  validateChannelInstances,
  saveChannelInstances,
  saveConfiguredChannelInstances,
} from './config-store-channel-instances.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getConfigValue(key: string): Promise<string> {
  const dbVal = await getConfig(key);
  if (dbVal !== undefined) return dbVal;
  return DEFAULTS[key] || '';
}

export async function getExternalBaseUrl(): Promise<string> {
  const configUrl = (await getConfigValue('WEB_EXTERNAL_URL')).trim().replace(/\/+$/, '');
  const envUrl = (process.env.WEB_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  const detected = getDetectedBaseUrl();
  return configUrl || envUrl || detected || `http://localhost:${(await getConfigValue('WEB_PORT')) || '3377'}`;
}

export async function getShareBaseUrl(): Promise<string> {
  const shareUrl = (await getConfigValue('WEB_SHARE_URL')).trim().replace(/\/+$/, '');
  const envShareUrl = (process.env.WEB_SHARE_URL || '').trim().replace(/\/+$/, '');
  return shareUrl || envShareUrl || (await getExternalBaseUrl());
}

export async function getAssistantName(): Promise<string> {
  return (await getConfigValue('ASSISTANT_NAME')) || DEFAULTS.ASSISTANT_NAME;
}

export function getTriggerPattern(assistantName: string): RegExp {
  return new RegExp(`^@${escapeRegex(assistantName)}\\b`, 'i');
}

export async function getConfigValues(
  keys: string[],
): Promise<Record<string, string>> {
  const batch = await getConfigBatch(keys);
  const result: Record<string, string> = {};
  for (const key of keys) {
    result[key] = batch[key] ?? DEFAULTS[key] ?? '';
  }
  return result;
}

export function getConfigKeyMetadata(key: WebConfigKey): ConfigKeyMetadata {
  return WEB_CONFIG_METADATA[key];
}

export function getWebConfigMetadata(): ConfigKeyMetadata[] {
  return WEB_CONFIG_KEYS.map((key) => WEB_CONFIG_METADATA[key]);
}

export async function getEffectiveWebConfig(): Promise<Record<string, string>> {
  return await getConfigValues([...WEB_CONFIG_KEYS]);
}

export function getChannelTypeDefinitions(): ChannelTypeDefinition[] {
  return getResolvedChannelTypeDefinitions();
}

export function getConversationCreateTargetDefinitions(): ConversationCreateTargetDefinition[] {
  return getResolvedConversationCreateTargetDefinitions();
}

export async function getAvailableConversationCreateTargets(): Promise<
  ConversationCreateTargetDefinition[]
> {
  return resolveAvailableConversationCreateTargets(
    await getConfiguredChannelInstances(),
  );
}

export async function getConversationCreationMetadata(): Promise<{
  targets: ConversationCreateTargetDefinition[];
}> {
  return {
    targets: await getAvailableConversationCreateTargets(),
  };
}

export async function getChannelConfigMetadata(): Promise<{
  types: ChannelTypeDefinition[];
  conversationTargets: ConversationCreateTargetDefinition[];
}> {
  return {
    types: getChannelTypeDefinitions(),
    conversationTargets: await getAvailableConversationCreateTargets(),
  };
}
