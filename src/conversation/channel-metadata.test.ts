import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('registry-first merged channel metadata', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('../channels/registry.js');
    const db = await import('../db.js');
    db._initTestDatabase();
    const registry = await import('../channels/registry.js');
    registry._resetChannelRegistryForTests();
  });

  it('keeps built-in definitions when the registry adds a partial custom entry', async () => {
    const registry = await import('../channels/registry.js');
    registry.registerChannel({
      name: 'custom-test',
      factory: () => null,
      channelTypeDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'Registry custom channel',
        allowMultiple: true,
        runtimeInstalled: true,
        webConfigurable: true,
        fields: [],
      },
      conversationCreateTargetDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'Registry custom channel',
        creatable: true,
        requiresConfiguredInstance: false,
        runtimeInstalled: true,
        fields: [],
      },
    });

    const channelMetadata = await import('./channel-metadata.js');
    const channelTypes = channelMetadata.getResolvedChannelTypeDefinitions();
    const conversationTargets =
      channelMetadata.getResolvedConversationCreateTargetDefinitions();

    expect(channelTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'feishu' }),
        expect.objectContaining({ type: 'custom-test', label: 'Custom Test' }),
      ]),
    );
    expect(conversationTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'feishu' }),
        expect.objectContaining({ type: 'custom-test', label: 'Custom Test' }),
      ]),
    );
  });

  it('prefers registry metadata over built-in definitions for the same type', async () => {
    const registry = await import('../channels/registry.js');
    registry.registerChannel({
      name: 'feishu',
      factory: () => null,
      channelTypeDefinition: {
        type: 'feishu',
        label: 'Registry Feishu',
        description: 'Overridden by registry',
        allowMultiple: false,
        runtimeInstalled: true,
        webConfigurable: true,
        fields: [],
      },
      conversationCreateTargetDefinition: {
        type: 'feishu',
        label: 'Registry Feishu',
        description: 'Overridden by registry',
        creatable: true,
        requiresConfiguredInstance: false,
        runtimeInstalled: true,
        fields: [],
      },
    });

    const channelMetadata = await import('./channel-metadata.js');
    const feishuChannel = channelMetadata
      .getResolvedChannelTypeDefinitions()
      .find((entry) => entry.type === 'feishu');
    const feishuTarget = channelMetadata
      .getResolvedConversationCreateTargetDefinitions()
      .find((entry) => entry.type === 'feishu');

    expect(feishuChannel).toMatchObject({
      type: 'feishu',
      label: 'Registry Feishu',
      allowMultiple: false,
      fields: [],
    });
    expect(feishuTarget).toMatchObject({
      type: 'feishu',
      label: 'Registry Feishu',
      requiresConfiguredInstance: false,
      fields: [],
    });
    expect(channelMetadata.getResolvedChannelTypeDefinitions()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'telegram' })]),
    );
  });

  it('marks registry-backed conversation targets unavailable until an enabled instance exists', async () => {
    const registry = await import('../channels/registry.js');
    registry.registerChannel({
      name: 'custom-test',
      factory: () => null,
      channelTypeDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'Registry custom channel',
        allowMultiple: true,
        runtimeInstalled: true,
        webConfigurable: true,
        fields: [],
      },
      conversationCreateTargetDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'Registry custom channel',
        creatable: true,
        requiresConfiguredInstance: true,
        runtimeInstalled: true,
        fields: [],
      },
    });

    const channelMetadata = await import('./channel-metadata.js');
    const unavailable = channelMetadata
      .resolveAvailableConversationCreateTargets([])
      .find((entry) => entry.type === 'custom-test');

    expect(unavailable).toMatchObject({
      type: 'custom-test',
      creatable: false,
    });
    expect(unavailable?.unavailableReason).toContain('Custom Test');

    const available = channelMetadata
      .resolveAvailableConversationCreateTargets([
        {
          type: 'custom-test',
          enabled: true,
        },
      ])
      .find((entry) => entry.type === 'custom-test');

    expect(available).toMatchObject({
      type: 'custom-test',
      creatable: true,
    });
    expect(available?.unavailableReason).toBeUndefined();
  });
});
