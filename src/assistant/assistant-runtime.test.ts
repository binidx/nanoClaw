import { describe, expect, it } from 'vitest';

import {
  buildConversationSoulSystemPrompt,
  resolveAssistantRuntimeConfig,
} from './assistant-runtime.js';
import type { RegisteredGroup } from './types.js';

describe('assistant runtime resolution', () => {
  it('falls back to no assistant when no assistantId is set', async () => {
    const group: RegisteredGroup = {
      name: 'Web Chat',
      folder: 'web-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {},
    };

    const resolved = await resolveAssistantRuntimeConfig(group);
    expect(resolved.assistantId).toBeNull();
    expect(resolved.assistantName).toBeNull();
  });

  it('keeps soul prompts separate from custom instructions for plain conversations', async () => {
    const group: RegisteredGroup = {
      name: 'Web Chat',
      folder: 'web-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {
        customInstructions: 'Always keep replies short.',
      },
    };

    const resolved = await resolveAssistantRuntimeConfig(
      group,
      {},
      { soulPrompt: '你是小猫娘。' },
    );

    expect(resolved.soulSystemPrompt).toContain('primary voice and persona policy');
    expect(resolved.soulSystemPrompt).toContain('你是小猫娘');
    expect(resolved.instructionsAppend).toBe('Always keep replies short.');
    expect(resolved.instructionsMode).toBe('append');
  });

  it('can disable soul injection for expert-style assistant runtimes', async () => {
    const group: RegisteredGroup = {
      name: 'Expert Chat',
      folder: 'expert-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {
        customInstructions: 'Stay task focused.',
      },
    };

    const resolved = await resolveAssistantRuntimeConfig(
      group,
      {},
      { soulPrompt: '你是小猫娘。', disableSoul: true },
    );

    expect(resolved.soulSystemPrompt).toBeUndefined();
    expect(resolved.instructionsAppend).toBe('Stay task focused.');
  });

  it('builds a high-priority conversation soul prompt block', async () => {
    const block = await buildConversationSoulSystemPrompt('保持温柔、活泼的说话风格。');

    expect(block).toContain('primary voice and persona policy');
    expect(block).toContain('generic AI assistant tone');
    expect(block).toContain('保持温柔、活泼的说话风格');
  });

  it('resolves assistant-scoped skills, mcp, provider and instructions', async () => {
    const group: RegisteredGroup = {
      name: 'Demo Chat',
      folder: 'demo-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      assistantId: 'demo-assistant',
    };

    const resolved = await resolveAssistantRuntimeConfig(group, {
      getAssistantById: async () => ({
        id: 'demo-assistant',
        name: '演示助手',
        description: null,
        enabled: true,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        config: {
          skillIds: ['demo-triage'],
          mcpServerIds: ['jira'],
          userSkillIds: [],
          userMcpServerIds: [],
          providerId: 'provider-ops',
          model: 'gpt-5.4-mini',
          persona: {
            role: '运维助手',
            style: '简洁专业',
            guidelines: '优先给出结构化状态。',
            constraints: '',
          },
          rules: {
            mode: 'locked' as const,
            systemPrompt: '只处理指定范围内的事项。',
            extraInstructions: '优先给出结构化状态。',
          },
        },
      }),
      getProviderById: async () =>
        ({
          id: 'provider-ops',
          alias: 'Ops GPT',
          type: 'codex',
          api_key: null,
          base_url: null,
          model: 'gpt-5.4',
          extra_config: null,
          is_default: 0,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        }) as any,
      listManagedMcpTemplates: async () => [
        {
          id: 'jira',
          name: 'Jira',
          command: 'node',
          args: ['jira.js'],
          env: {
            API_TOKEN: 'template-token',
          },
          enabled: true,
        },
      ],
    });

    expect(resolved.assistantId).toBe('demo-assistant');
    expect(resolved.assistantName).toBe('演示助手');
    expect(resolved.managedSkillIds).toEqual(['demo-triage']);
    expect(resolved.managedMcpServerIds).toEqual(['jira']);
    expect(resolved.resolvedMcpServers).toEqual([
      {
        id: 'amb-demo-assistant-jira',
        name: 'Jira',
        command: 'node',
        args: ['jira.js'],
        env: {
          API_TOKEN: 'template-token',
        },
        bindingId: 'amb-demo-assistant-jira',
        templateServerId: 'jira',
        source: 'legacy_config',
      },
    ]);
    expect(resolved.persona).toEqual({
      role: '运维助手',
      style: '简洁专业',
      guidelines: '优先给出结构化状态。',
      constraints: '',
    });
    expect(resolved.providerOverrideId).toBe('provider-ops');
    expect(resolved.providerType).toBe('codex');
    expect(resolved.modelOverride).toBe('gpt-5.4-mini');
    expect(resolved.instructionsMode).toBe('locked');
    expect(resolved.providerAlias).toBe('Ops GPT');
    expect(resolved.instructionsAppend).toContain('演示助手');
    expect(resolved.instructionsAppend).toContain('只处理指定范围内的事项');
    expect(resolved.instructionsAppend).toContain('优先给出结构化状态');
    expect(resolved.instructionsAppend).toContain('运维助手');
  });

  it('throws when the bound assistant is disabled', async () => {
    const group: RegisteredGroup = {
      name: 'Demo Chat',
      folder: 'demo-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      assistantId: 'demo-assistant',
    };

    await expect(
      resolveAssistantRuntimeConfig(group, {
        getAssistantById: async () => ({
          id: 'demo-assistant',
          name: '演示助手',
          description: null,
          enabled: false,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          config: {
            skillIds: [],
            mcpServerIds: [],
            userSkillIds: [],
            userMcpServerIds: [],
            providerId: null,
            model: null,
            persona: { role: '', style: '', guidelines: '', constraints: '' },
            rules: {
              mode: 'append' as const,
            },
          },
        }),
      }, {
        requireEnabled: true,
      }),
    ).rejects.toThrow(/助手.*已停用，当前对话无法继续执行/);
  });

  it('keeps assistant-bound chats readable when the assistant record is missing', async () => {
    const group: RegisteredGroup = {
      name: 'Demo Chat',
      folder: 'demo-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      assistantId: 'demo-assistant',
      agentConfig: {},
    };

    const resolved = await resolveAssistantRuntimeConfig(group, {
      getAssistantById: async () => undefined,
    });

    expect(resolved.assistantId).toBe('demo-assistant');
    expect(resolved.assistantName).toBeNull();
    expect(resolved.instructionsMode).toBe('append');
    expect(resolved.providerAlias).toBeNull();
  });

  it('prefers assistant private secrets over template env during MCP resolution', async () => {
    const group: RegisteredGroup = {
      name: 'Demo Chat',
      folder: 'demo-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      assistantId: 'demo-assistant',
    };

    const resolved = await resolveAssistantRuntimeConfig(group, {
      getAssistantById: async () => ({
        id: 'demo-assistant',
        name: '演示助手',
        description: null,
        enabled: true,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        config: {
          skillIds: [],
          mcpServerIds: ['jira'],
          userSkillIds: [],
          userMcpServerIds: [],
          providerId: null,
          model: null,
          persona: { role: '', style: '', guidelines: '', constraints: '' },
          rules: {
            mode: 'append' as const,
          },
        },
      }),
      listAssistantMcpBindingsByAssistantId: async () => [
        {
          id: 'amb-demo-jira',
          assistant_id: 'demo-assistant',
          template_server_id: 'jira',
          alias: 'Jira Private',
          enabled: 1,
          args_json: JSON.stringify(['jira-private.js']),
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        },
      ],
      getAssistantMcpBindingSecretById: async () => ({
        binding_id: 'amb-demo-jira',
        env_json: JSON.stringify({
          API_TOKEN: 'private-token',
        }),
        updated_at: '2024-01-02T00:00:00.000Z',
      }),
      listManagedMcpTemplates: async () => [
        {
          id: 'jira',
          name: 'Jira',
          command: 'node',
          args: ['jira.js'],
          env: {
            API_TOKEN: 'template-token',
            STATIC_FLAG: '1',
          },
          enabled: true,
        },
      ],
    });

    expect(resolved.resolvedMcpServers).toEqual([
      {
        id: 'amb-demo-jira',
        name: 'Jira Private',
        command: 'node',
        args: ['jira-private.js'],
        env: {
          API_TOKEN: 'private-token',
          STATIC_FLAG: '1',
        },
        bindingId: 'amb-demo-jira',
        templateServerId: 'jira',
        source: 'assistant_binding',
      },
    ]);
  });
});
