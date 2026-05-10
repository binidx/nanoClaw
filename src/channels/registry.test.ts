import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetChannelRegistryForTests,
  getChannelRegistryEntry,
  getChannelFactory,
  getChannelTypeDefinitions,
  getChannelTypeDescriptor,
  getConversationCreateTargetDefinitions,
  getConversationCreateTargetDescriptor,
  getRegisteredChannelDefinition,
  getRegisteredChannelDefinitions,
  getRegisteredChannelEntries,
  getRegisteredChannelNames,
  getRegisteredConversationCreateTarget,
  getRegisteredConversationCreateTargets,
  registerChannel,
} from './registry.js';

describe('channel registry', () => {
  beforeEach(() => {
    _resetChannelRegistryForTests();
  });

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel('test-channel', factory);
    expect(getChannelFactory('test-channel')).toBe(factory);
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('test-channel', () => null);
    registerChannel('another-channel', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('later registration overwrites earlier one', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('overwrite-test', factory1);
    registerChannel('overwrite-test', factory2);
    expect(getChannelFactory('overwrite-test')).toBe(factory2);
  });

  it('exposes built-in metadata before channel factories are registered', () => {
    expect(getChannelTypeDescriptor('feishu')?.label).toBe('飞书');
    expect(getRegisteredChannelDefinition('feishu')?.label).toBe('飞书');
    expect(
      getChannelTypeDefinitions().some((entry) => entry.type === 'feishu'),
    ).toBe(true);
    expect(
      getConversationCreateTargetDescriptor('feishu')
        ?.requiresConfiguredInstance,
    ).toBe(true);
    expect(
      getRegisteredConversationCreateTarget('feishu')
        ?.requiresConfiguredInstance,
    ).toBe(true);
    expect(
      getConversationCreateTargetDefinitions().some(
        (entry) => entry.type === 'web' && entry.creatable,
      ),
    ).toBe(true);
  });

  it('auto-attaches built-in descriptors for known channel names', () => {
    registerChannel('feishu', () => null);

    expect(getChannelRegistryEntry('feishu')?.factory).toBeTypeOf('function');
    expect(
      getRegisteredChannelDefinitions().some(
        (entry) => entry.type === 'feishu',
      ),
    ).toBe(true);
    expect(
      getRegisteredConversationCreateTargets().some(
        (entry) => entry.type === 'feishu',
      ),
    ).toBe(true);
  });

  it('supports descriptor-aware registration objects', () => {
    const factory = () => null;
    registerChannel({
      name: 'custom-test',
      factory,
      channelTypeDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'custom',
        allowMultiple: false,
        fields: [],
      },
      conversationCreateTargetDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'custom target',
        creatable: true,
        requiresConfiguredInstance: false,
        runtimeInstalled: true,
        fields: [],
      },
    });

    const entry = getChannelRegistryEntry('custom-test');
    expect(entry?.factory).toBe(factory);
    expect(entry?.channelTypeDefinition?.label).toBe('Custom Test');
    expect(entry?.conversationCreateTargetDefinition?.creatable).toBe(true);
    expect(getRegisteredChannelEntries()).toHaveLength(1);
    expect(
      getChannelTypeDefinitions().some(
        (descriptor) => descriptor.type === 'custom-test',
      ),
    ).toBe(true);
    expect(
      getConversationCreateTargetDefinitions().some(
        (descriptor) => descriptor.type === 'custom-test',
      ),
    ).toBe(true);
  });
});
