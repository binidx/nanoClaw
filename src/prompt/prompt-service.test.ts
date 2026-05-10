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
});
