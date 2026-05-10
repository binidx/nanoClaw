import {
  getChannelTypeDefinition as getStaticChannelTypeDefinition,
  getChannelTypeDefinitions as getStaticChannelTypeDefinitions,
  getConversationCreateTargetDefinition as getStaticConversationCreateTargetDefinition,
  getConversationCreateTargetDefinitions as getStaticConversationCreateTargetDefinitions,
  type ChannelTypeDefinition,
  type ConversationCreateTargetDefinition,
} from '../config-channel-definitions.js';
import * as channelRegistry from '../channels/registry.js';
import { t } from '../i18n/index.js';

type TypedEntry = { type: string };

type RegistryMetadataApi = typeof channelRegistry & {
  getChannelTypeDefinitions?: () => ChannelTypeDefinition[];
  getChannelTypeDefinition?: (
    type: string,
  ) => ChannelTypeDefinition | undefined;
  getConversationCreateTargetDefinitions?: () => ConversationCreateTargetDefinition[];
  getConversationCreateTargetDefinition?: (
    type: string,
  ) => ConversationCreateTargetDefinition | undefined;
  getRegisteredChannelDefinitions?: () => ChannelTypeDefinition[];
  getRegisteredChannelDefinition?: (
    type: string,
  ) => ChannelTypeDefinition | undefined;
  getRegisteredConversationCreateTargets?: () => ConversationCreateTargetDefinition[];
  getRegisteredConversationCreateTarget?: (
    type: string,
  ) => ConversationCreateTargetDefinition | undefined;
};

export interface ChannelMetadataInstanceLike {
  type: string;
  enabled: boolean;
}

function getRegistryMetadataApi(): RegistryMetadataApi {
  return channelRegistry as RegistryMetadataApi;
}

function mergeDefinitionsByType<T extends TypedEntry>(
  builtIns: T[],
  registryDefinitions: T[] | undefined,
): T[] {
  const merged = new Map<string, T>();

  for (const definition of builtIns) {
    merged.set(definition.type, definition);
  }

  for (const definition of registryDefinitions || []) {
    if (!definition?.type) continue;
    merged.set(definition.type, definition);
  }

  return Array.from(merged.values());
}

function getRegisteredChannelTypeDefinitions():
  | ChannelTypeDefinition[]
  | undefined {
  const api = getRegistryMetadataApi();
  const definitions =
    api.getChannelTypeDefinitions?.() ||
    api.getRegisteredChannelDefinitions?.();
  return Array.isArray(definitions) && definitions.length > 0
    ? definitions
    : undefined;
}

function getRegisteredConversationCreateTargetDefinitions():
  | ConversationCreateTargetDefinition[]
  | undefined {
  const api = getRegistryMetadataApi();
  const definitions =
    api.getConversationCreateTargetDefinitions?.() ||
    api.getRegisteredConversationCreateTargets?.();
  return Array.isArray(definitions) && definitions.length > 0
    ? definitions
    : undefined;
}

export function getResolvedChannelTypeDefinition(
  type: string,
): ChannelTypeDefinition | undefined {
  const api = getRegistryMetadataApi();
  const registryDefinition =
    api.getChannelTypeDefinition?.(type) ||
    api.getRegisteredChannelDefinition?.(type);
  return registryDefinition || getStaticChannelTypeDefinition(type);
}

export function getResolvedChannelTypeDefinitions(): ChannelTypeDefinition[] {
  return mergeDefinitionsByType(
    getStaticChannelTypeDefinitions(),
    getRegisteredChannelTypeDefinitions(),
  );
}

export function getResolvedConversationCreateTargetDefinition(
  type: string,
): ConversationCreateTargetDefinition | undefined {
  const api = getRegistryMetadataApi();
  const registryDefinition =
    api.getConversationCreateTargetDefinition?.(type) ||
    api.getRegisteredConversationCreateTarget?.(type);
  return (
    registryDefinition || getStaticConversationCreateTargetDefinition(type)
  );
}

export function getResolvedConversationCreateTargetDefinitions(): ConversationCreateTargetDefinition[] {
  return mergeDefinitionsByType(
    getStaticConversationCreateTargetDefinitions(),
    getRegisteredConversationCreateTargetDefinitions(),
  );
}

export function resolveAvailableConversationCreateTargets(
  instances: ChannelMetadataInstanceLike[],
): ConversationCreateTargetDefinition[] {
  const configuredTypes = new Set(
    instances
      .filter((instance) => instance.enabled)
      .map((instance) => instance.type),
  );

  return getResolvedConversationCreateTargetDefinitions().map((target) => {
    if (!target.requiresConfiguredInstance) {
      return target;
    }

    if (configuredTypes.has(target.type)) {
      return target;
    }

    return {
      ...target,
      creatable: false,
      unavailableReason:
        target.unavailableReason ||
        t(
          'channels.enableConversationCreateInstance',
          { label: target.label },
          undefined,
        ),
    };
  });
}
