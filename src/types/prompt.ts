export type PromptScopeKind = 'system' | 'user';

export interface PromptDefinition {
  key: string;
  featureScope: string;
  title: string;
  description: string;
  promptKind: 'system' | 'instruction' | 'user' | 'mixed';
  defaultTemplate: string;
  variables: string[];
  supportsStructuredPreview?: boolean;
}

export interface PromptConfigRecord {
  id: string;
  scope_kind: PromptScopeKind;
  owner_user_id: string;
  prompt_key: string;
  feature_scope: string;
  template_text: string;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface PromptSegment {
  id: string;
  label: string;
  promptKey?: string;
  source:
    | 'builtin'
    | 'system_default'
    | 'user_override'
    | 'assistant_config'
    | 'conversation_context'
    | 'soul'
    | 'memory'
    | 'custom';
  content: string;
}

export interface PromptSourceResolution {
  promptKey: string;
  featureScope: string;
  source: 'builtin' | 'system_default' | 'user_override';
  ownerUserId: string;
  configured: boolean;
}

export interface PromptTraceRecord {
  id: string;
  trace_kind: 'agent_envelope' | 'direct_provider';
  prompt_key: string | null;
  feature_scope: string;
  target_user_id: string;
  chat_jid: string | null;
  provider: string | null;
  model: string | null;
  system_prompt_text: string | null;
  user_prompt_text: string;
  provider_input_text: string | null;
  segments_json: string;
  resolution_json: string;
  metadata_json: string | null;
  created_at: string;
}

export interface PromptTraceInput {
  traceKind: PromptTraceRecord['trace_kind'];
  featureScope: string;
  promptKey?: string | null;
  targetUserId?: string | null;
  chatJid?: string | null;
  provider?: string | null;
  model?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  segments?: PromptSegment[];
  resolution?: PromptSourceResolution[];
  metadata?: Record<string, unknown>;
}

export interface PromptPreviewEnvelope {
  traceKind: PromptTraceRecord['trace_kind'];
  featureScope: string;
  promptKey?: string | null;
  targetUserId?: string | null;
  chatJid?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  segments: PromptSegment[];
  resolution: PromptSourceResolution[];
  metadata?: Record<string, unknown>;
}
