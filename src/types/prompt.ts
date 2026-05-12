export type PromptScopeKind = 'system' | 'user';
export type PromptCacheSection = 'stable' | 'volatile';
export type PromptLayer =
  | 'system_base'
  | 'system_persona'
  | 'system_policy'
  | 'system_tools'
  | 'context_runtime'
  | 'context_memory'
  | 'user_input'
  | 'task_payload'
  | 'derived';

export type PromptMutability =
  | 'configurable'
  | 'parameterized'
  | 'runtime_fixed'
  | 'derived';

export interface PromptDefinition {
  key: string;
  featureScope: string;
  title: string;
  description: string;
  promptKind: 'system' | 'instruction' | 'user' | 'mixed';
  layer?: PromptLayer;
  mutability?: PromptMutability;
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
  layer?: PromptLayer;
  mutability?: PromptMutability;
  cacheSection?: PromptCacheSection;
  source:
    | 'builtin'
    | 'system_default'
    | 'user_override'
    | 'assistant_config'
    | 'conversation_context'
    | 'context_summary'
    | 'context_recent'
    | 'memory_recall_tool'
    | 'memory_recall_session'
    | 'upload_context'
    | 'soul'
    | 'memory'
    | 'custom';
  content: string;
}

export interface CompiledPromptEnvelope {
  stableSystemPrompt: string;
  volatileSystemPrompt: string;
  contextBlocks: PromptSegment[];
  userPrompt: string;
  systemPromptText?: string | null;
  providerInputText?: string | null;
  stablePrefixFingerprint?: string | null;
  cacheFingerprint?: string | null;
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
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  contextBlocks?: PromptSegment[];
  segments?: PromptSegment[];
  resolution?: PromptSourceResolution[];
  cacheFingerprint?: string | null;
  stablePrefixFingerprint?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PromptPreviewEnvelope {
  traceKind: PromptTraceRecord['trace_kind'];
  featureScope: string;
  promptKey?: string | null;
  targetUserId?: string | null;
  chatJid?: string | null;
  stableSystemPrompt?: string | null;
  volatileSystemPrompt?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  contextBlocks?: PromptSegment[];
  segments: PromptSegment[];
  resolution: PromptSourceResolution[];
  cacheFingerprint?: string | null;
  stablePrefixFingerprint?: string | null;
  metadata?: Record<string, unknown>;
}
