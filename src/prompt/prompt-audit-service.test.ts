import { describe, expect, it } from 'vitest';

import { buildPromptAuditSample } from './prompt-audit-service.js';

describe('prompt audit sample builder', () => {
  it('derives prompt lengths and forbidden markers from trace metadata and segments', () => {
    const sample = buildPromptAuditSample({
      id: 'trace-1',
      trace_kind: 'agent_envelope',
      prompt_key: 'conversation.runtime',
      feature_scope: 'conversation',
      target_user_id: 'u1',
      chat_jid: 'web:demo',
      provider: 'codex',
      model: 'gpt-5.4',
      system_prompt_text: 'legacy system',
      user_prompt_text: '<messages>hi</messages>',
      provider_input_text: '<recent_context>ctx</recent_context>\n\n<messages>hi</messages>',
      segments_json: JSON.stringify([
        {
          id: 'ctx1',
          label: 'Recent Context',
          layer: 'context_runtime',
          source: 'context_recent',
          content: '<entry>ctx</entry>',
        },
      ]),
      resolution_json: '[]',
      metadata_json: JSON.stringify({
        stableSystemPrompt:
          'You are a helpful coding assistant with access to tools.\n\nyourName',
        volatileSystemPrompt: '## Sub-Agent Policy\n\n灵魂配置已启用。\n\n置信度 30%',
      }),
      created_at: '2026-05-12T00:00:00.000Z',
    });

    expect(sample.stableSystemPromptChars).toBeGreaterThan(0);
    expect(sample.volatileSystemPromptChars).toBeGreaterThan(0);
    expect(sample.contextChars).toBeGreaterThan(0);
    expect(sample.userPromptChars).toBe('<messages>hi</messages>'.length);
    expect(sample.providerInputChars).toBe(
      '<recent_context>ctx</recent_context>\n\n<messages>hi</messages>'.length,
    );
    expect(sample.forbiddenMatches).toEqual(
      expect.arrayContaining([
        'coding_assistant_base',
        'subagent_policy',
        'soul_enabled_banner',
        'soul_field_labels',
        'confidence_labels',
      ]),
    );
  });
});
