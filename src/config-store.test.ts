import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('config-store runtime helpers', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('./channels/registry.js');
    const db = await import('./db.js');
    db._initTestDatabase();
    const registry = await import('./channels/registry.js');
    registry._resetChannelRegistryForTests();
  });

  it('returns the configured assistant name with default fallback', async () => {
    const configStore = await import('./config-store.js');
    expect(await configStore.getAssistantName()).toBe('Andy');

    const db = await import('./db.js');
    await db.setConfig('ASSISTANT_NAME', 'Helper Bot');

    expect(await configStore.getAssistantName()).toBe('Helper Bot');
  });

  it('builds trigger pattern from runtime assistant name', async () => {
    const db = await import('./db.js');
    await db.setConfig('ASSISTANT_NAME', 'Helper Bot');

    const configStore = await import('./config-store.js');
    const pattern = configStore.getTriggerPattern('Helper Bot');

    expect(pattern.test('@Helper Bot hello')).toBe(true);
    expect(pattern.test('@helper bot hello')).toBe(true);
    expect(pattern.test('hello @Helper Bot')).toBe(false);
  });

  it('returns metadata for web config keys', async () => {
    const configStore = await import('./config-store.js');
    const metadata = configStore.getWebConfigMetadata();

    expect(
      metadata.some(
        (entry) =>
          entry.key === 'ASSISTANT_NAME' && entry.effect === 'new_agent',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) => entry.key === 'WEB_PORT' && entry.effect === 'restart',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'CODEX_MAX_TOOL_ITERATIONS' &&
          entry.effect === 'new_agent',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'BASH_APPROVAL_ALLOWLIST' &&
          entry.effect === 'new_agent',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'WEB_BROWSER_ENABLED' && entry.effect === 'instant',
      ),
    ).toBe(true);
    expect(
      metadata.some((entry) => entry.key === 'WEB_BROWSER_START_URL'),
    ).toBe(true);
    expect(metadata.map((entry) => entry.key)).not.toContain('FEISHU_APP_ID');
  });

  it('derives a legacy feishu instance when old flat config exists', async () => {
    const db = await import('./db.js');
    await db.setConfig('FEISHU_APP_ID', 'legacy-app');
    await db.setConfig('FEISHU_APP_SECRET', 'legacy-secret');

    const configStore = await import('./config-store.js');
    const instances = await configStore.getConfiguredChannelInstances();

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      id: 'default',
      type: 'feishu',
      enabled: true,
    });
    expect(instances[0]?.config.appId).toBe('legacy-app');
    expect(instances[0]?.config.appSecret).toBe('legacy-secret');
  });

  it('sanitizes sensitive channel fields for web responses', async () => {
    const configStore = await import('./config-store.js');
    await configStore.saveConfiguredChannelInstances([
      {
        id: 'ops',
        type: 'feishu',
        name: '运维飞书',
        enabled: true,
        config: {
          appId: 'app-1',
          appSecret: 'secret-1',
          domain: 'feishu',
          renderMode: 'auto',
          replyInThread: true,
        },
      },
    ]);

    const sanitized = await configStore.getSanitizedChannelInstances();
    expect(sanitized[0]?.config.appId).toBe('');
    expect(sanitized[0]?.config.appSecret).toBe('');
    expect(sanitized[0]?.config.domain).toBe('feishu');
    expect(sanitized[0]?.config.replyInThread).toBe(true);
  });

  it('merges enabled user channel instances into runtime channel config', async () => {
    const tenantDb = await import('./tenant/tenant-db.js');
    await tenantDb.upsertChannelInstance('user-a', {
      id: 'telegram-user-a',
      type: 'telegram',
      name: 'User A Telegram',
      enabled: true,
      configJson: JSON.stringify({
        botToken: 'tg-token-a',
        apiBase: 'https://telegram.example.test',
      }),
    });

    const configStore = await import('./config-store.js');
    const instances = await configStore.getConfiguredChannelInstances();

    expect(instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'telegram-user-a',
          type: 'telegram',
          name: 'User A Telegram',
          owner_id: 'user-a',
          visibility: 'private',
          enabled: true,
          config: expect.objectContaining({
            botToken: 'tg-token-a',
            apiBase: 'https://telegram.example.test',
          }),
        }),
      ]),
    );
  });

  it('rejects duplicate feishu credentials across instances', async () => {
    const configStore = await import('./config-store.js');
    await expect(
      configStore.saveConfiguredChannelInstances([
        {
          id: 'a',
          type: 'feishu',
          name: '实例 A',
          enabled: true,
          config: {
            appId: 'same-app',
            appSecret: 'same-secret',
            domain: 'feishu',
            renderMode: 'auto',
            replyInThread: false,
          },
        },
        {
          id: 'b',
          type: 'feishu',
          name: '实例 B',
          enabled: true,
          config: {
            appId: 'same-app',
            appSecret: 'same-secret',
            domain: 'lark',
            renderMode: 'card',
            replyInThread: true,
          },
        },
      ]),
    ).rejects.toThrow(
      /相同的 App ID \/ App Secret 组合|feishuDuplicateCredentials/,
    );
  });

  it('uses merged registry metadata instead of replacing built-ins wholesale', async () => {
    const registry = await import('./channels/registry.js');
    registry._resetChannelRegistryForTests();
    registry.registerChannel({
      name: 'custom-test',
      factory: () => null,
      channelTypeDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'From registry',
        allowMultiple: true,
        runtimeInstalled: true,
        webConfigurable: true,
        fields: [],
      },
      conversationCreateTargetDefinition: {
        type: 'custom-test',
        label: 'Custom Test',
        description: 'From registry',
        creatable: true,
        requiresConfiguredInstance: false,
        runtimeInstalled: true,
        fields: [],
      },
    });

    const configStore = await import('./config-store.js');
    expect(configStore.getChannelTypeDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'feishu' }),
        expect.objectContaining({ type: 'custom-test', label: 'Custom Test' }),
      ]),
    );
    expect(configStore.getConversationCreateTargetDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'feishu' }),
        expect.objectContaining({ type: 'custom-test', label: 'Custom Test' }),
      ]),
    );
  });

  it('builds shared metadata payloads for channel config and conversation creation', async () => {
    const configStore = await import('./config-store.js');
    const conversationMetadata =
      await configStore.getConversationCreationMetadata();
    const channelConfigMetadata = await configStore.getChannelConfigMetadata();

    expect(conversationMetadata.targets).toEqual(
      channelConfigMetadata.conversationTargets,
    );
    expect(
      channelConfigMetadata.types.some((entry) => entry.type === 'feishu'),
    ).toBe(true);
    expect(
      conversationMetadata.targets.some((entry) => entry.type === 'web'),
    ).toBe(true);
  });
});
