export type ContextEntryProvider = 'claude' | 'codex' | 'system' | 'unknown';

export type ContextEntryRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'summary'
  | 'memory';

export type ContextEntrySourceType =
  | 'chat_message'
  | 'assistant_message'
  | 'assistant_turn'
  | 'tool_result'
  | 'tool_call_recent'
  | 'tool_call_summary'
  | 'compaction_summary'
  | 'memory_recall'
  | 'memory_promotion'
  | 'post_compaction_context';

export interface ContextEntryRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  run_id?: string | null;
  provider: ContextEntryProvider;
  role: ContextEntryRole;
  source_type: ContextEntrySourceType;
  source_ref?: string | null;
  content_text: string;
  content_json?: string | null;
  token_estimate?: number | null;
  created_at: string;
}

export interface ContextCompactionRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  compacted_until: string;
  summary_text: string;
  source_entry_ids_json: string;
  created_at: string;
}

export interface MemoryEffectiveConfigSnapshot {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  writeMode: string;
  globalWriteEnabled: boolean;
  autoSaveEnabled: boolean;
  searchScopeDefault: string;
  searchMaxResults: number;
  promptInjectionEnabled: boolean;
  promptMaxSnippets: number;
  promptTokenBudget: number;
  promptRecentRatio: number;
  promptSummaryRatio: number;
  promptRecallRatio: number;
  compactionEnabled: boolean;
  compactionTriggerEntries: number;
  compactionKeepRecentEntries: number;
  chatContextTokenBudget?: number;
  chatContextRecentChatRatio?: number;
  chatContextRecentToolRatio?: number;
  chatContextMemoryRecallRatio?: number;
  chatContextSummaryRatio?: number;
  chatContextRawChatKeepEntries?: number;
  chatContextRawToolKeepCalls?: number;
  chatContextChatCompactionTriggerEntries?: number;
  chatContextChatCompactionKeepRecentEntries?: number;
}

export interface MemoryLedgerStatsSnapshot {
  totalEntries: number;
  recentEntries24h: number;
  lastEntryAt: string | null;
  bySourceType: Record<string, number>;
}

export interface MemoryCompactionLatestSnapshot {
  id: string;
  chatJid: string;
  groupFolder: string;
  compactedUntil: string;
  createdAt: string;
  sourceEntryCount: number;
  summaryPreview: string;
}

export interface MemoryCompactionWorkerSnapshot {
  pendingJobs: number;
  runningJobs: number;
  recentRuns24h: number;
  recentFailures24h: number;
  averageDurationMs24h: number | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export interface MemoryCompactionStatsSnapshot {
  totalCompactions: number;
  recentCompactions24h: number;
  latest: MemoryCompactionLatestSnapshot | null;
  worker: MemoryCompactionWorkerSnapshot;
}

export type MemoryPromotionCandidateKind =
  | 'preference'
  | 'identity'
  | 'constraint'
  | 'commitment';

export type MemoryPromotionCandidateOrigin =
  | 'explicit_user'
  | 'compaction_candidate'
  | 'explicit_action';

export interface MemoryPromotionCandidate {
  kind: MemoryPromotionCandidateKind;
  text: string;
  confidence: 'high' | 'medium';
  sourceEntryIds: string[];
  origin: MemoryPromotionCandidateOrigin;
}

export interface MemoryPromotionStatsSnapshot {
  candidates24h: number;
  writes24h: number;
  deduped24h: number;
  latestPromotionAt: string | null;
  byOrigin24h: Record<string, number>;
  byAction24h: {
    auto: number;
    remember: number;
    session_only: number;
  };
  byMemoryClass24h: {
    identity: number;
    global_durable: number;
    group_durable: number;
    session: number;
    unknown: number;
  };
}

export interface PersonProfileRecord {
  id: string;
  display_name: string;
  notes_json: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationIdentityBindingRecord {
  chat_jid: string;
  group_folder: string;
  person_id: string;
  bound_at: string;
}

export interface IdentityAliasRecord {
  id: number;
  person_id: string;
  channel: string | null;
  external_user_id: string | null;
  display_name: string | null;
  created_at: string;
}

export type MemoryDocumentOwnerType = 'person' | 'group' | 'global';
export type MemoryDocumentSourceType =
  | 'memory_file'
  | 'identity_memory'
  | 'user_memory'
  | 'compaction_summary'
  | 'knowledge_recall';

export interface MemoryDocumentRecord {
  doc_id: string;
  scope: 'group' | 'global' | 'workspace';
  owner_type: MemoryDocumentOwnerType;
  owner_id: string;
  path_ref: string | null;
  source_type: MemoryDocumentSourceType;
  title: string | null;
  body: string;
  metadata_json: string | null;
  updated_at: string;
}

export interface MemoryDocumentSyncStateRecord {
  path_ref: string;
  scope: 'group' | 'global' | 'workspace';
  owner_type: Extract<MemoryDocumentOwnerType, 'group' | 'global'>;
  owner_id: string;
  source_type: Extract<MemoryDocumentSourceType, 'memory_file'>;
  file_mtime_ms: number;
  file_size: number;
  content_hash: string;
  last_synced_at: string;
}

export interface MemoryIdentityStatsSnapshot {
  totalProfiles: number;
  boundConversations: number;
  aliases: number;
}

export interface MemorySearchScopeQualitySnapshot {
  indexedResults24h: number;
  followupReads24h: number;
  recalls24h: number;
  followupReadRate24h: number | null;
}

export interface MemorySearchGroupQualitySnapshot {
  groupFolder: string;
  indexedResults24h: number;
  followupReads24h: number;
  recalls24h: number;
  followupReadRate24h: number | null;
}

export interface MemorySearchSourceQualitySnapshot {
  indexedResults24h: number;
  followupReads24h: number;
  recalls24h: number;
  followupReadRate24h: number | null;
}

export interface MemorySearchStatsSnapshot {
  indexedDocuments: number;
  syncStateDocuments: number;
  userMemoryProjection: {
    sourceMemories: number;
    projectedDocuments: number;
    missingDocuments: number;
    orphanDocuments: number;
  };
  lastIndexedAt: string | null;
  lastSyncPassAt: string | null;
  recallCount24h: number;
  recallBySource: Record<string, number>;
  indexedHitCount24h: number;
  indexedResultCount24h: number;
  searchFollowupReadCount24h: number;
  followupReadRate24h: number | null;
  fallbackSyncCount24h: number;
  freshnessRecheckCount24h: number;
  staleRefreshCount24h: number;
  filesSynced24h: number;
  filesSkipped24h: number;
  filesDeleted24h: number;
  byScope: {
    group: MemorySearchScopeQualitySnapshot;
    global: MemorySearchScopeQualitySnapshot;
  };
  bySource: Record<string, MemorySearchSourceQualitySnapshot>;
  topGroups: MemorySearchGroupQualitySnapshot[];
  sync: {
    indexedHitCount24h: number;
    indexedResultCount24h: number;
    searchFollowupReadCount24h: number;
    followupReadRate24h: number | null;
    fallbackSyncCount24h: number;
    freshnessRecheckCount24h: number;
    staleRefreshCount24h: number;
    filesSynced24h: number;
    filesSkipped24h: number;
    filesDeleted24h: number;
    lastSyncPassAt: string | null;
  };
}

export interface MemoryPromptStatsSnapshot {
  lastAssembledTokenEstimate: number | null;
  lastRecentTokens: number | null;
  lastSummaryTokens: number | null;
  lastRecallTokens: number | null;
  lastRecentChatTokens?: number | null;
  lastRecentToolTokens?: number | null;
  lastMemoryRecallTokens?: number | null;
  lastCompactedSummaryTokens?: number | null;
  lastRecentChatCount?: number | null;
  lastRecentToolCount?: number | null;
  lastMemoryRecallCount?: number | null;
  lastCompactedSummaryCount?: number | null;
  activeChatCompactionId?: string | null;
  activeToolSummaryId?: string | null;
  toolContextMode?: 'recent' | 'summary' | 'mixed' | 'none' | null;
}

export interface MemoryObservabilitySnapshot {
  config: MemoryEffectiveConfigSnapshot;
  ledger: MemoryLedgerStatsSnapshot;
  compaction: MemoryCompactionStatsSnapshot;
  promotion: MemoryPromotionStatsSnapshot;
  identity: MemoryIdentityStatsSnapshot;
  search: MemorySearchStatsSnapshot;
  prompt: MemoryPromptStatsSnapshot;
}

export type SoulTone = 'default' | 'casual' | 'formal' | 'playful' | 'professional'
  | 'warm' | 'witty' | 'gentle' | 'energetic' | 'cool' | 'academic';

export type UserMemoryCategory =
  | 'identity'
  | 'preference'
  | 'habit'
  | 'fact'
  | 'skill'
  | 'relationship'
  | 'general';

export type UserMemorySource =
  | 'manual'
  | 'chat_auto'
  | 'llm_extract'
  | 'agent_tool'
  | 'consolidation';

export type UserMemoryScope = 'global' | 'conversation';
export type UserMemoryTier = 'durable' | 'core';

export type ObservationType =
  | 'fact'
  | 'interaction_pattern'
  | 'preference_signal'
  | 'context_note';

export type InsightType =
  | 'communication_style'
  | 'response_preference'
  | 'topic_depth'
  | 'humor_tolerance'
  | 'formality_level'
  | 'emoji_preference';

export type InsightStatus = 'candidate' | 'active' | 'retired';

export interface BehaviorRule {
  id: string;
  text: string;
  enabled: boolean;
}

export interface UserSoulRecord {
  id: string;
  user_id: string;
  name: string | null;
  emoji: string | null;
  emoji_enabled: number;
  creature: string | null;
  vibe: string | null;
  persona_prompt: string | null;
  tone: string | null;
  language_preference: string | null;
  extra_instructions: string | null;
  user_nickname: string | null;
  behavior_rules: string | null;
  auto_evolve: number;
  consolidation_config: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TavernPersonaRecord {
  id: string;
  user_id: string;
  name: string;
  avatar_path: string | null;
  summary: string | null;
  personality_prompt: string | null;
  scenario: string | null;
  first_message: string | null;
  alternate_greetings_json: string | null;
  example_dialogues: string | null;
  system_prompt: string | null;
  creator_notes: string | null;
  tags_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TavernConfigRecord {
  user_id: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationTavernBindingRecord {
  chat_jid: string;
  tavern_persona_id: string;
  snapshot_json: string;
  opener_message_id: string | null;
  bound_at: string;
}


export interface UserMemoryRecord {
  id: string;
  user_id: string;
  scope: UserMemoryScope;
  conversation_id: string | null;
  category: UserMemoryCategory;
  content: string;
  importance: number;
  confidence: number;
  source: UserMemorySource;
  tier: UserMemoryTier;
  promoted_from: string | null;
  last_verified_at: string | null;
  source_event_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserMemoryObservationRecord {
  id: string;
  user_id: string;
  conversation_id: string | null;
  category: UserMemoryCategory;
  content: string;
  observation_type: ObservationType;
  frequency: number;
  last_seen_at: string;
  confidence: number;
  source: string;
  promoted_to: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonaInsightRecord {
  id: string;
  user_id: string;
  insight_type: InsightType;
  content: string;
  evidence_count: number;
  confidence: number;
  status: InsightStatus;
  created_at: string;
  updated_at: string;
}

export interface MemoryConsolidationLogRecord {
  id: string;
  user_id: string;
  run_type: 'scheduled' | 'manual';
  observations_reviewed: number;
  promoted: number;
  merged: number;
  pruned: number;
  insights_generated: number;
  duration_ms: number | null;
  created_at: string;
}

export interface MemoryExtractionLogRecord {
  id: string;
  user_id: string;
  conversation_id: string | null;
  source_message_ids: string;
  extracted_memories: string;
  model_used: string | null;
  tokens_used: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Memory Events (Raw Ledger)
// ---------------------------------------------------------------------------

export type MemoryEventActionType =
  | 'ADD'
  | 'UPDATE'
  | 'DELETE'
  | 'MERGE'
  | 'EVICT'
  | 'PROMOTE'
  | 'SKIP'
  | 'RECALL';

export type MemoryEventTargetType =
  | 'user_memory'
  | 'memory_document'
  | 'observation'
  | 'insight'
  | 'skill';

export interface MemoryEventRecord {
  id: string;
  user_id: string | null;
  scope: string;
  action_type: MemoryEventActionType;
  target_type: MemoryEventTargetType;
  target_id: string | null;
  conversation_id: string | null;
  source_message_id: string | null;
  before_snapshot: string | null;
  after_snapshot: string | null;
  decision_reason: string | null;
  metadata_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Memory Skills (Procedural Memory)
// ---------------------------------------------------------------------------

export interface MemorySkillRecord {
  id: string;
  user_id: string | null;
  scope: string;
  name: string;
  trigger_pattern: string;
  body: string;
  termination_condition: string | null;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  last_verified_at: string | null;
  status: 'active' | 'candidate' | 'retired';
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Embedding & Knowledge Base
// ---------------------------------------------------------------------------

export type EmbeddingOwnerType = 'memory' | 'knowledge' | 'observation';

export interface EmbeddingVectorRecord {
  id: string;
  owner_type: EmbeddingOwnerType;
  owner_id: string;
  content_hash: string;
  embedding: Buffer;
  dimensions: number;
  model_name: string;
  created_at: string;
}

export type KnowledgeEnhancementLevel = 'metadata' | 'wiki_lite' | 'wiki_full';

export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description: string | null;
  owner_type: 'system' | 'user';
  owner_id: string | null;
  embedding_model: string | null;
  embedding_provider_id: string | null;
  chunk_size: number;
  chunk_overlap: number;
  cleanup_patterns: string | null;
  enabled: number;
  user_id: string;
  category: string;
  visibility: 'private' | 'shared';
  enhancement_level: KnowledgeEnhancementLevel;
  llm_provider_id: string | null;
  llm_model_override: string | null;
  temporal_half_life_days: number;
  /** 1 = allow saving knowledge_search answers as wiki `comparison` pages */
  allow_query_backfill: number;
  created_at: string;
  updated_at: string;
}

export interface UserKnowledgeBindingRecord {
  id: string;
  user_id: string;
  kb_id: string;
  enabled: number;
  created_at: string;
}

export type KnowledgeDocumentStatus = 'pending' | 'indexing' | 'indexed' | 'failed';
export type KnowledgeLlmStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface KnowledgeDocumentRecord {
  id: string;
  kb_id: string;
  filename: string;
  content_type: string;
  content_hash: string;
  char_count: number;
  chunk_count: number;
  status: KnowledgeDocumentStatus;
  error_message: string | null;
  source_url: string | null;
  published_at: string | null;
  superseded_by: string | null;
  parent_doc_id: string | null;
  doc_path: string | null;
  depth: number;
  llm_status: KnowledgeLlmStatus | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunkRecord {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  heading_path?: string | null;
  context_label?: string | null;
  prev_chunk_id?: string | null;
  next_chunk_id?: string | null;
  parent_chunk_id?: string | null;
  chunk_type?: string | null;
  created_at: string;
}

export type KnowledgeRelationType = 'supersedes' | 'supplements' | 'contradicts' | 'references';

export interface KnowledgeDocRelationRecord {
  id: string;
  source_doc_id: string;
  target_doc_id: string;
  relation_type: KnowledgeRelationType;
  confidence: number;
  detail: string | null;
  created_at: string;
}

export interface KnowledgeDocSummaryRecord {
  id: string;
  document_id: string;
  summary: string;
  entities: string | null;
  topics: string | null;
  llm_model: string | null;
  created_at: string;
  updated_at: string;
}

export type KnowledgeWikiPageType = 'entity' | 'concept' | 'overview' | 'synthesis' | 'comparison';

export interface KnowledgeWikiPageRecord {
  id: string;
  kb_id: string;
  page_type: KnowledgeWikiPageType;
  title: string;
  content: string;
  source_doc_ids: string | null;
  inbound_links: string | null;
  outbound_links: string | null;
  llm_model: string | null;
  version: number;
  /** 1 when the page was last written by a human; LLM rebuild paths must skip such pages. */
  edited_by_human: number;
  /** ISO timestamp of the last human edit; null when never edited or after revert. */
  edited_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeWikiClaimRecord {
  id: string;
  page_id: string;
  claim_text: string;
  source_doc_id: string | null;
  evidence_chunk_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}
