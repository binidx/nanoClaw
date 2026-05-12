import type { PromptAuditSample, PromptTraceRecord, PromptSegment } from '../types/prompt.js';

const FORBIDDEN_BLOCK_RULES: Array<{ id: string; match: (input: {
  stableSystemPrompt: string;
  volatileSystemPrompt: string;
  providerInputText: string;
}) => boolean }> = [
  {
    id: 'coding_assistant_base',
    match: ({ stableSystemPrompt, volatileSystemPrompt }) =>
      /You are a helpful coding assistant with access to tools\./.test(
        `${stableSystemPrompt}\n${volatileSystemPrompt}`,
      ),
  },
  {
    id: 'subagent_policy',
    match: ({ stableSystemPrompt, volatileSystemPrompt }) =>
      /## Sub-Agent Policy/.test(`${stableSystemPrompt}\n${volatileSystemPrompt}`),
  },
  {
    id: 'soul_enabled_banner',
    match: ({ stableSystemPrompt, volatileSystemPrompt }) =>
      /灵魂配置已启用/.test(`${stableSystemPrompt}\n${volatileSystemPrompt}`),
  },
  {
    id: 'soul_field_labels',
    match: ({ stableSystemPrompt, volatileSystemPrompt }) =>
      /(yourName|userNickname|personaImage|overallVibe|toneGuide|languagePreference)/.test(
        `${stableSystemPrompt}\n${volatileSystemPrompt}`,
      ),
  },
  {
    id: 'confidence_labels',
    match: ({ stableSystemPrompt, volatileSystemPrompt }) =>
      /置信度\s*\d+%/.test(`${stableSystemPrompt}\n${volatileSystemPrompt}`),
  },
  {
    id: 'history_bridge_placeholder',
    match: ({ volatileSystemPrompt }) =>
      /runner restores the latest visible turns when provider session state is unavailable/.test(
        volatileSystemPrompt,
      ),
  },
];

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseSegments(value: string): PromptSegment[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as PromptSegment[]) : [];
  } catch {
    return [];
  }
}

function getSegmentChars(
  segments: PromptSegment[],
  predicate: (segment: PromptSegment) => boolean,
): number {
  return segments
    .filter(predicate)
    .reduce((sum, segment) => sum + String(segment.content || '').length, 0);
}

export function buildPromptAuditSample(trace: PromptTraceRecord): PromptAuditSample {
  const metadata = parseJsonObject(trace.metadata_json);
  const segments = parseSegments(trace.segments_json);
  const stableSystemPrompt =
    typeof metadata.stableSystemPrompt === 'string'
      ? metadata.stableSystemPrompt
      : trace.system_prompt_text || '';
  const volatileSystemPrompt =
    typeof metadata.volatileSystemPrompt === 'string'
      ? metadata.volatileSystemPrompt
      : '';
  const providerInputText = trace.provider_input_text || '';
  const forbiddenMatches = FORBIDDEN_BLOCK_RULES
    .filter((rule) =>
      rule.match({
        stableSystemPrompt,
        volatileSystemPrompt,
        providerInputText,
      }))
    .map((rule) => rule.id);

  return {
    traceId: trace.id,
    featureScope: trace.feature_scope,
    promptKey: trace.prompt_key,
    chatJid: trace.chat_jid,
    provider: trace.provider,
    model: trace.model,
    createdAt: trace.created_at,
    stableSystemPromptChars: stableSystemPrompt.length,
    volatileSystemPromptChars: volatileSystemPrompt.length,
    contextChars: getSegmentChars(
      segments,
      (segment) =>
        segment.layer === 'context_runtime' || segment.layer === 'context_memory',
    ),
    userPromptChars: trace.user_prompt_text.length,
    providerInputChars: providerInputText.length,
    forbiddenMatches,
  };
}
