import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptConfigMocks = vi.hoisted(() => ({
  getPromptConfig: vi.fn(),
}));

vi.mock('../db/prompt-configs.js', () => ({
  deletePromptConfig: vi.fn(),
  getPromptConfig: promptConfigMocks.getPromptConfig,
  recordPromptTrace: vi.fn(),
  upsertPromptConfig: vi.fn(),
}));

import {
  buildCompiledPromptEnvelope,
  buildPromptFingerprintMeta,
  isPromptConfigTemplateCompatible,
  resolvePromptText,
} from './prompt-service.js';

function promptConfig(input: {
  scopeKind: 'system' | 'user';
  ownerUserId?: string;
  promptKey: string;
  templateText: string;
}) {
  return {
    id: `${input.scopeKind}-${input.promptKey}`,
    scope_kind: input.scopeKind,
    owner_user_id: input.ownerUserId || '',
    prompt_key: input.promptKey,
    feature_scope: input.promptKey.split('.')[0] || '',
    template_text: input.templateText,
    notes: null,
    created_by: '',
    updated_by: '',
    created_at: '',
    updated_at: '',
  };
}

describe('prompt service config compatibility', () => {
  beforeEach(() => {
    promptConfigMocks.getPromptConfig.mockReset();
  });

  it('detects obsolete repo-review placeholders', () => {
    expect(
      isPromptConfigTemplateCompatible(
        'repo_review.primary',
        '旧模板 diff:\n{{diffText}}\n{{projectContextBlock}}',
      ),
    ).toBe(false);
    expect(
      isPromptConfigTemplateCompatible(
        'repo_review.primary',
        '新模板范围：{{diffRange}}\n文件：{{changedFiles}}',
      ),
    ).toBe(true);
    expect(
      isPromptConfigTemplateCompatible('workteam.task', '{{diffText}}'),
    ).toBe(true);
  });

  it('ignores stale repo-review user override and falls back to compatible system override', async () => {
    promptConfigMocks.getPromptConfig.mockImplementation(
      async (scopeKind: string, ownerUserId: string) => {
        if (scopeKind === 'user' && ownerUserId === 'u1') {
          return promptConfig({
            scopeKind: 'user',
            ownerUserId,
            promptKey: 'repo_review.primary',
            templateText: '旧用户模板：{{diffText}}',
          });
        }
        if (scopeKind === 'system') {
          return promptConfig({
            scopeKind: 'system',
            promptKey: 'repo_review.primary',
            templateText: '系统模板：{{diffRange}}',
          });
        }
        return null;
      },
    );

    const resolved = await resolvePromptText({
      promptKey: 'repo_review.primary',
      targetUserId: 'u1',
      variables: { diffRange: 'base..head', diffText: 'SHOULD_NOT_RENDER' },
      fallbackText: '内置模板：{{diffRange}}',
    });

    expect(resolved.text).toBe('系统模板：base..head');
    expect(resolved.resolution.source).toBe('system_default');
    expect(resolved.text).not.toContain('SHOULD_NOT_RENDER');
  });

  it('falls back to builtin when all repo-review overrides are stale', async () => {
    promptConfigMocks.getPromptConfig.mockResolvedValue(
      promptConfig({
        scopeKind: 'system',
        promptKey: 'repo_review.primary',
        templateText: '旧模板：{{projectContextBlock}}',
      }),
    );

    const resolved = await resolvePromptText({
      promptKey: 'repo_review.primary',
      variables: { diffRange: 'head^!' },
      fallbackText: '内置模板：{{diffRange}}',
    });

    expect(resolved.text).toBe('内置模板：head^!');
    expect(resolved.resolution.source).toBe('builtin');
    expect(resolved.resolution.configured).toBe(false);
  });

  it('builds stable and full prompt fingerprints deterministically', () => {
    const first = buildPromptFingerprintMeta({
      systemPromptText: 'system block',
      userPromptText: 'user block',
      providerInputText: 'provider block',
      segments: [
        {
          id: 'soul',
          label: 'Soul',
          layer: 'system_persona',
          source: 'soul',
          content: 'persona',
        },
        {
          id: 'context',
          label: 'Context',
          layer: 'context_runtime',
          source: 'conversation_context',
          content: 'recent context',
        },
      ],
    });
    const second = buildPromptFingerprintMeta({
      systemPromptText: 'system block',
      userPromptText: 'user block',
      providerInputText: 'provider block',
      segments: [
        {
          id: 'soul',
          label: 'Soul',
          layer: 'system_persona',
          source: 'soul',
          content: 'persona',
        },
        {
          id: 'context',
          label: 'Context',
          layer: 'context_runtime',
          source: 'conversation_context',
          content: 'recent context',
        },
      ],
    });

    expect(first.stablePrefixFingerprint).toHaveLength(64);
    expect(first.cacheFingerprint).toHaveLength(64);
    expect(second).toEqual(first);
  });

  it('changes only the full fingerprint when volatile prompt content changes', () => {
    const first = buildPromptFingerprintMeta({
      stableSystemPrompt: 'stable block',
      volatileSystemPrompt: 'volatile A',
      userPromptText: 'user block',
      providerInputText: 'provider block',
    });
    const second = buildPromptFingerprintMeta({
      stableSystemPrompt: 'stable block',
      volatileSystemPrompt: 'volatile B',
      userPromptText: 'user block',
      providerInputText: 'provider block',
    });

    expect(second.stablePrefixFingerprint).toBe(first.stablePrefixFingerprint);
    expect(second.cacheFingerprint).not.toBe(first.cacheFingerprint);
  });

  it('builds a compiled prompt envelope with stable and volatile sections', () => {
    const envelope = buildCompiledPromptEnvelope({
      stableSystemPrompt: 'stable block',
      volatileSystemPrompt: 'volatile block',
      contextBlocks: [
        {
          id: 'ctx',
          label: 'Context',
          layer: 'context_runtime',
          cacheSection: 'volatile',
          source: 'context_recent',
          content: '<entry>context</entry>',
        },
      ],
      userPrompt: '<messages>user</messages>',
      providerInputText: '<recent_context>...</recent_context>\n\n<messages>user</messages>',
    });

    expect(envelope.stableSystemPrompt).toBe('stable block');
    expect(envelope.volatileSystemPrompt).toBe('volatile block');
    expect(envelope.userPrompt).toContain('<messages>user</messages>');
    expect(envelope.contextBlocks).toHaveLength(1);
    expect(envelope.stablePrefixFingerprint).toHaveLength(64);
    expect(envelope.cacheFingerprint).toHaveLength(64);
  });
});
