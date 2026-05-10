import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import {
  getChannelTypeDefinitions as getBuiltInChannelTypeDefinitions,
  getChannelTypeDefinition,
  getConversationCreateTargetDefinitions as getBuiltInConversationCreateTargetDefinitions,
  getConversationCreateTargetDefinition,
  type ChannelTypeDefinition,
  type ConversationCreateTargetDefinition,
} from '../config-channel-definitions.js';

export type RegisterGroupFn = (jid: string, group: RegisteredGroup) => void;

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onRealtimeMessage?: OnInboundMessage;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: RegisterGroupFn;
}

export type ChannelFactory = (
  opts: ChannelOpts,
) => Channel | null | Promise<Channel | null>;

export interface ChannelRegistryEntry {
  name: string;
  factory: ChannelFactory;
  channelTypeDefinition?: ChannelTypeDefinition;
  conversationCreateTargetDefinition?: ConversationCreateTargetDefinition;
}

export interface ChannelRegistrationDescriptor {
  name: string;
  factory: ChannelFactory;
  channelTypeDefinition?: ChannelTypeDefinition;
  conversationCreateTargetDefinition?: ConversationCreateTargetDefinition;
}

const registry = new Map<string, ChannelRegistryEntry>();
let channelTypeDefinitions = createChannelTypeDefinitionMap();
let conversationCreateTargetDefinitions =
  createConversationCreateTargetDefinitionMap();

function createChannelTypeDefinitionMap(): Map<string, ChannelTypeDefinition> {
  return new Map(
    getBuiltInChannelTypeDefinitions().map((definition) => [
      definition.type,
      definition,
    ]),
  );
}

function createConversationCreateTargetDefinitionMap(): Map<
  string,
  ConversationCreateTargetDefinition
> {
  return new Map(
    getBuiltInConversationCreateTargetDefinitions().map((definition) => [
      definition.type,
      definition,
    ]),
  );
}

function syncMetadataCatalog(entry: ChannelRegistryEntry): void {
  if (entry.channelTypeDefinition) {
    channelTypeDefinitions.set(
      entry.channelTypeDefinition.type,
      entry.channelTypeDefinition,
    );
  }
  if (entry.conversationCreateTargetDefinition) {
    conversationCreateTargetDefinitions.set(
      entry.conversationCreateTargetDefinition.type,
      entry.conversationCreateTargetDefinition,
    );
  }
}

function resolveChannelRegistryEntry(
  input: string | ChannelRegistrationDescriptor,
  factory?: ChannelFactory,
): ChannelRegistryEntry {
  if (typeof input === 'string') {
    if (!factory) {
      throw new Error(`Channel factory is required for "${input}"`);
    }
    return {
      name: input,
      factory,
      channelTypeDefinition: getChannelTypeDefinition(input),
      conversationCreateTargetDefinition:
        getConversationCreateTargetDefinition(input),
    };
  }

  return {
    name: input.name,
    factory: input.factory,
    channelTypeDefinition:
      input.channelTypeDefinition || getChannelTypeDefinition(input.name),
    conversationCreateTargetDefinition:
      input.conversationCreateTargetDefinition ||
      getConversationCreateTargetDefinition(input.name),
  };
}

export function registerChannel(name: string, factory: ChannelFactory): void;
export function registerChannel(input: ChannelRegistrationDescriptor): void;
export function registerChannel(
  input: string | ChannelRegistrationDescriptor,
  factory?: ChannelFactory,
): void {
  const entry = resolveChannelRegistryEntry(input, factory);
  registry.set(entry.name, entry);
  syncMetadataCatalog(entry);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name)?.factory;
}

export function getChannelRegistryEntry(
  name: string,
): ChannelRegistryEntry | undefined {
  return registry.get(name);
}

export function getChannelTypeDescriptor(
  name: string,
): ChannelTypeDefinition | undefined {
  return channelTypeDefinitions.get(name);
}

export function getRegisteredChannelDefinition(
  name: string,
): ChannelTypeDefinition | undefined {
  return getChannelTypeDescriptor(name);
}

export function getChannelTypeDefinitions(): ChannelTypeDefinition[] {
  return [...channelTypeDefinitions.values()];
}

export function getConversationCreateTargetDescriptor(
  name: string,
): ConversationCreateTargetDefinition | undefined {
  return conversationCreateTargetDefinitions.get(name);
}

export function getRegisteredConversationCreateTarget(
  name: string,
): ConversationCreateTargetDefinition | undefined {
  return getConversationCreateTargetDescriptor(name);
}

export function getConversationCreateTargetDefinitions(): ConversationCreateTargetDefinition[] {
  return [...conversationCreateTargetDefinitions.values()];
}

export function getRegisteredChannelEntries(): ChannelRegistryEntry[] {
  return [...registry.values()];
}

export function getRegisteredChannelDefinitions(): ChannelTypeDefinition[] {
  return getChannelTypeDefinitions();
}

export function getRegisteredConversationCreateTargets(): ConversationCreateTargetDefinition[] {
  return getConversationCreateTargetDefinitions();
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** @internal - tests only. */
export function _resetChannelRegistryForTests(): void {
  registry.clear();
  channelTypeDefinitions = createChannelTypeDefinitionMap();
  conversationCreateTargetDefinitions =
    createConversationCreateTargetDefinitionMap();
}
