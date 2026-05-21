export interface Conversation {
  jid: string;
  name: string;
  custom_title?: string | null;
  display_name?: string;
  channel: string;
  is_group?: number;
  channel_label?: string;
  source_name?: string;
  route?: Record<string, unknown>;
  last_message: string;
  last_message_time: string;
  is_pinned?: number;
  is_favorite?: number;
  last_event_seq?: number;
  assistantId?: string | null;
  assistantName?: string | null;
  assistantProviderAlias?: string | null;
  conversationProviderId?: string | null;
  conversationProviderAlias?: string | null;
  conversationModel?: string | null;
  mode?: string | null;
  tavernPersonaId?: string | null;
  tavernPersonaName?: string | null;
  tavernAvatarPath?: string | null;
}

export interface TavernPersona {
  id: string;
  user_id: string;
  name: string;
  avatar_path: string | null;
  summary: string | null;
  personality_prompt: string | null;
  scenario: string | null;
  first_message: string | null;
  alternate_greetings: string[];
  example_dialogues: string | null;
  system_prompt: string | null;
  creator_notes: string | null;
  tags: string[];
  enabled: number;
  created_at: string;
  updated_at: string;
  prompt_preview: string;
  opener_preview: string;
  conversation_count?: number;
  last_conversation_at?: string | null;
}

export interface TavernGlobalConfig {
  skillIds: string[];
  mcpServerIds: string[];
  providerId?: string | null;
  model?: string | null;
}

export interface Message {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  client_id?: string;
  turn_id?: string;
  run_id?: string;
  seq?: number;
  im_seq?: number | null;
  chat_jid?: string;
  reply_to_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  attachments?: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    url: string;
  }>;
  reactions?: Array<{
    emoji: string;
    count: number;
    users: string[];
  }>;
  read_receipts?: Array<{
    user_id: string;
    last_read_message_id: string | null;
    last_read_seq?: number | null;
    last_read_at: string;
  }>;
  is_from_me?: boolean | number;
  is_bot_message: boolean | number;
  uploaded_files?: UploadedChatFile[];
}

export interface PendingMessage extends Message {
  clientId: string;
  runId?: string;
}

export type TurnItemStatus = 'in_progress' | 'completed' | 'failed';

export interface SubagentInfo {
  agentName: string;
  runtimeId?: string;
  provider?: string;
  mode?: 'agent' | 'team';
  runtimeKind?: 'managed_run' | 'managed_session' | 'ephemeral_snapshot';
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: 'main' | 'orchestrator' | 'leaf';
  workProfile?: 'explorer' | 'worker';
  role?: 'main' | 'orchestrator' | 'leaf';
  controlScope?: 'children' | 'none';
  depth?: number;
  chatJid?: string;
  requestCount?: number;
  controllable?: boolean;
  task?: string;
  status:
    | 'spawning'
    | 'idle'
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'stopped';
}

export interface SubagentRuntimeEntry {
  id: string;
  provider: string;
  mode: 'agent' | 'team';
  runtimeKind?: string;
  groupFolder: string;
  chatJid: string;
  name: string;
  task: string;
  status:
    | 'spawning'
    | 'idle'
    | 'running'
    | 'stopping'
    | 'completed'
    | 'failed'
    | 'stopped';
  depth: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  pid?: number;
  providerSessionId?: string;
  parentRuntimeId?: string;
  childRuntimeIds?: string[];
  topologyRole?: 'main' | 'orchestrator' | 'leaf' | string;
  workProfile?: 'explorer' | 'worker' | string;
  role?: 'main' | 'orchestrator' | 'leaf' | string;
  controlScope?: 'children' | 'none' | string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  source?: 'runtime' | 'history' | string;
  lastError?: string;
  lastResultPreview?: string;
  controllable?: boolean;
  controlState?: 'controllable' | 'read_only' | 'unknown';
  controlReason?:
    | 'active_runtime'
    | 'inactive_runtime'
    | 'history_only'
    | 'legacy_active_runtime'
    | 'provider_read_only_runtime';
  stopRequestedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  activeRequestId?: string;
  requestCount?: number;
  childCount?: number;
  descendantCount?: number;
  activeDescendantCount?: number;
  pendingDescendantCount?: number;
  controlActions?: Array<'stop' | 'message' | 'steer'>;
  capabilities?: {
    canStop?: boolean;
    canMessage?: boolean;
    canSteer?: boolean;
    canSpawnChildren?: boolean;
    canRecover?: boolean;
    role?: string;
    controlScope?: string;
  };
}

export interface SubagentRuntimeSnapshot {
  activeCount: number;
  recentCount: number;
  items: SubagentRuntimeEntry[];
  nextCursor?: string | null;
}

export interface SubagentProviderCapabilities {
  canSpawn: boolean;
  canPersistentSession: boolean;
  canListRuntime: boolean;
  canStopRuntime: boolean;
  canMessageRuntime?: boolean;
  canSteerRuntime?: boolean;
  canQueryTree?: boolean;
  canResumeAfterRestart: boolean;
  runtimeModel?: string;
  controlModel?: string;
}

export interface ReasoningTurnItem {
  id: string;
  type: 'reasoning';
  status: TurnItemStatus;
  title: string;
  text?: string;
  timestamp: string;
}

export interface ToolCallTurnItem {
  id: string;
  type: 'tool_call';
  status: TurnItemStatus;
  title: string;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
  subagentInfo?: SubagentInfo;
  startedAt?: string;
  completedAt?: string;
  timestamp: string;
}

export interface AssistantMessageTurnItem {
  id: string;
  type: 'assistant_message';
  status: Extract<TurnItemStatus, 'in_progress' | 'completed'>;
  text: string;
  timestamp: string;
}

export type TurnItem =
  | ReasoningTurnItem
  | ToolCallTurnItem
  | AssistantMessageTurnItem;

export type TurnEvent =
  | {
      type: 'turn.started';
      turnId: string;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    }
  | {
      type: 'item.started';
      turnId: string;
      item: TurnItem;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    }
  | {
      type: 'item.updated';
      turnId: string;
      item: TurnItem;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    }
  | {
      type: 'item.completed';
      turnId: string;
      item: TurnItem;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    }
  | {
      type: 'turn.completed';
      turnId: string;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    }
  | {
      type: 'turn.failed';
      turnId: string;
      error: string;
      timestamp: string;
      seq?: number;
      eventId?: string;
      runId?: string;
      clientId?: string;
    };

export interface AssistantTurn {
  id: string;
  clientKey?: string;
  groupKey?: string;
  groupLabel?: string;
  parentToolCallId?: string;
  ownerKind?: 'main' | 'subagent' | 'worker' | 'reducer' | 'formatter';
  ownerLabel?: string;
  phase?:
    | 'worker'
    | 'timeout_followup'
    | 'main_agent_review'
    | 'main_agent_fallback_review'
    | 'reducer'
    | 'formatter';
  runId?: string;
  timestamp: string;
  items: TurnItem[];
  isLive: boolean;
  isCompleted: boolean;
  persistedMessageId?: string;
  error?: string;
}

export interface ConversationChatState {
  messages: Message[];
  pendingMessages: PendingMessage[];
  turns: AssistantTurn[];
  approvals: ApprovalRequest[];
  lastEventSeq?: number;
}

export interface ConversationMessagesResponse {
  messages: Message[];
  turns: AssistantTurn[];
  approvals?: ApprovalRequest[];
  total: number;
  last_event_seq?: number;
}

export interface ConversationSendAck {
  ok?: boolean;
  command?: boolean;
  success?: boolean;
  accepted?: boolean;
  clientId?: string;
  runId?: string;
  serverTimestamp?: string;
  last_event_seq?: number;
}

export type ConversationItem =
  | {
      kind: 'message';
      key: string;
      timestamp: string;
      order: number;
      message: Message;
    }
  | {
      kind: 'turn';
      key: string;
      timestamp: string;
      order: number;
      turn: AssistantTurn;
    };

export type ApprovalDecision = 'allow-once' | 'deny' | 'expired';

export type ApprovalScope = 'current_tool_call' | 'current_runtime';

export interface BashApprovalAllowRule {
  id: string;
  prefix: string[];
  label: string;
  enabled: boolean;
  createdAt: string;
  createdFrom: 'manual' | 'approval';
}

export interface ApprovalRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface ChatTimelineEntryBase {
  key: string;
  timestamp: string;
  order: number;
}

export interface UserMessageTimelineEntry extends ChatTimelineEntryBase {
  kind: 'user_message';
  message: Message | PendingMessage;
  pending: boolean;
}

export interface AssistantMessageTimelineEntry extends ChatTimelineEntryBase {
  kind: 'assistant_message';
  text: string;
  status: AssistantMessageTurnItem['status'];
  turnId?: string;
  messageId?: string;
}

export interface ReasoningTimelineEntry extends ChatTimelineEntryBase {
  kind: 'reasoning';
  item: ReasoningTurnItem;
  turnId: string;
}

export interface ToolCallTimelineEntry extends ChatTimelineEntryBase {
  kind: 'tool_call';
  item: ToolCallTurnItem;
  turnId: string;
  approval?: ApprovalRequest;
}

export interface ApprovalTimelineEntry extends ChatTimelineEntryBase {
  kind: 'approval';
  approval: ApprovalRequest;
  turnId?: string;
}

export interface TurnErrorTimelineEntry extends ChatTimelineEntryBase {
  kind: 'turn_error';
  error: string;
  turnId: string;
}

export type ChatTimelineEntry =
  | UserMessageTimelineEntry
  | AssistantMessageTimelineEntry
  | ReasoningTimelineEntry
  | ToolCallTimelineEntry
  | ApprovalTimelineEntry
  | TurnErrorTimelineEntry;

export interface TaskRunSummary {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

export interface ScheduledTaskSummary {
  id: string;
  title: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  conversation_name?: string;
  group_folder_active?: boolean;
  latest_run?: TaskRunSummary | null;
  runtime_status?: 'queued' | 'running' | null;
  retry_limit?: number;
  retry_backoff_ms?: number;
  failure_mode?: 'continue' | 'pause';
  consecutive_failures?: number;
  last_error?: string | null;
  assistantId?: string | null;
}

export type AccessMode = 'allowall' | 'allowlist' | 'readonly';

export interface AccessPolicy {
  mode: AccessMode;
  directories: string[];
  source?: 'global' | 'assistant' | 'conversation';
  locked?: boolean;
  editable?: boolean;
}

export interface ConversationAccessPolicyLayers {
  global: AccessPolicy;
  assistant?: AccessPolicy | null;
  conversation?: AccessPolicy | null;
}

export interface RuntimeAccessState {
  hasActivePatches: boolean;
  reusableCommandCount: number;
  activePatchCount: number;
  latestExpiresAt?: string | null;
  affectsPersistentPolicy: boolean;
  summary: string;
}

export interface EffectiveConversationAccessState {
  persistentPolicy: AccessPolicy;
  temporaryCommandReuseCount: number;
  temporaryApprovedDirectories: string[];
  hasTemporaryElevation: boolean;
  summary: string;
}

export interface ConversationAccessNextActionTarget {
  type: 'assistant' | 'settings_default_access';
  label: string;
  assistantId?: string | null;
}

export interface ConversationAccessNextAction {
  id: string;
  title: string;
  description: string;
  target?: ConversationAccessNextActionTarget;
}

export interface ConversationAccess {
  policy: AccessPolicy;
  allowedDirectories?: string[];
  policyLayers?: ConversationAccessPolicyLayers;
  runtimeApprovalPatches?: RuntimeApprovalPatch[];
  runtimeAccess?: RuntimeAccessState;
  effectiveAccess?: EffectiveConversationAccessState;
  nextActions?: ConversationAccessNextAction[];
}

export interface RuntimeApprovalPatch {
  id: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  source: 'approval';
  scope: ApprovalScope;
  createdAt: string;
  resolvedAt: string;
  expiresAt: string;
}

export interface UploadedChatFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  textExcerpt?: string;
  textTruncated?: boolean;
}

export interface ManagedMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  envKeyCount?: number;
  metadata?: ExtensionMetadata;
}

export interface ManagedSkill {
  id: string;
  name: string;
  description?: string;
  source: 'builtin' | 'custom';
  enabled: boolean;
  metadata?: ExtensionMetadata;
}

export interface ManagedSkillDetail extends ManagedSkill {
  dirPath: string;
  summary?: string;
}

export interface ExtensionMarketplaceSource {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
}

export interface ExtensionCatalogEntry {
  id: string;
  entryName: string;
  title: string;
  description?: string;
  version?: string;
  sourceId: string;
  sourceName: string;
  sourceLabel: string;
  marketplaceName?: string;
  marketplaceVersion?: string;
  skillCount: number;
  mcpCount: number;
  agentCount: number;
  installable: boolean;
}

export interface ExtensionInstallRecord {
  id: string;
  canonicalId: string;
  name: string;
  version?: string;
  sourceType: 'marketplace' | 'import';
  sourceKind: 'local_path' | 'github' | 'git' | 'git_subdir' | 'remote_file';
  sourceRef: string;
  resolvedSource: string;
  contentHash: string;
  trustState: 'trusted' | 'local' | 'needs_review';
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplaceEntry?: string;
  installedSkillIds: string[];
  installedMcpServerIds: string[];
  agentCount: number;
  installedAt: string;
  status: 'installed' | 'needs_attention';
  warnings: string[];
}

export interface AssistantRules {
  mode?: 'append' | 'replace' | 'locked';
  systemPrompt?: string | null;
  extraInstructions?: string | null;
}

export interface AssistantPersona {
  role: string;
  style: string;
  guidelines: string;
  constraints: string;
}

export interface AssistantConfig {
  skillIds: string[];
  mcpServerIds: string[];
  userSkillIds?: string[];
  userMcpServerIds?: string[];
  kbIds: string[];
  rules: AssistantRules;
  persona: AssistantPersona;
  providerId?: string | null;
  model?: string | null;
  inheritSoulConfig?: boolean;
}

export interface Assistant {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  config: AssistantConfig;
  user_id?: string;
  visibility?: 'private' | 'shared';
  created_at: string;
  updated_at: string;
}

export interface AssistantResourceSkillSummary {
  id: string;
  name: string;
  description?: string;
  source?: 'builtin' | 'custom' | string;
  enabled?: boolean;
  selected?: boolean;
}

export interface AssistantSecretStatus {
  configured: boolean;
  envKeyCount: number;
  envKeys: string[];
  keyCount?: number;
  updatedAt?: string | null;
  usesTemplateEnvFallback?: boolean;
  missingSecretKeys?: string[];
  source?: 'private' | 'template' | 'mixed' | 'none' | string;
}

export interface AssistantMcpTemplateSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  envKeyCount?: number;
}

export interface AssistantMcpBinding {
  id: string;
  assistantId?: string;
  templateServerId: string;
  templateServerName?: string;
  alias?: string | null;
  enabled: boolean;
  command?: string;
  args?: string[];
  isVirtual?: boolean;
  compatibilityMode?: string | null;
  templateEnvKeys?: string[];
  usesTemplateEnvFallback?: boolean;
  source?: 'assistant_binding' | 'legacy_config' | string;
  secretStatus?: AssistantSecretStatus;
}

export interface AssistantResourceData {
  assistantId: string;
  skills: AssistantResourceSkillSummary[];
  mcpTemplates: AssistantMcpTemplateSummary[];
  mcpBindings: AssistantMcpBinding[];
}

export interface AssistantUserSkillSummary {
  id: string;
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
  sourceType?: string;
  sourceRef?: string | null;
  isOwner?: boolean;
}

export interface AssistantUserMcpServerSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  envKeyCount?: number;
  sourceType?: string;
  sourceRef?: string | null;
  isOwner?: boolean;
}

export interface AssistantMcpBindingSecretStatus {
  configured: boolean;
  keyCount: number;
  updatedAt?: string | null;
}

export interface AssistantMcpBindingSummary {
  id: string;
  assistantId: string;
  templateServerId: string;
  templateName: string;
  alias: string | null;
  enabled: boolean;
  args: string[];
  templateEnvKeys: string[];
  secretStatus: AssistantMcpBindingSecretStatus;
  usesTemplateEnvFallback: boolean;
  source: 'assistant_binding' | 'legacy_config';
}

export interface AssistantRepoBindingSummary {
  id: string;
  repositoryId: string;
  repositoryName: string;
  repositoryUrl: string;
  description?: string | null;
  defaultBranch: string;
  branchFilter: string[];
  activeBranch: string | null;
  localPath: string | null;
  worktreePath: string | null;
  enabled: boolean;
  projectGraph?: ProjectGraphResourceContext | null;
}

export interface AssistantProjectGraphRecommendedResource {
  type: 'skill' | 'mcp_template';
  id: string;
  name: string;
  repositoryIds: string[];
  available: boolean;
  enabled: boolean;
  bound: boolean;
  status: 'available' | 'already_bound' | 'disabled' | 'unknown';
}

export interface AssistantResources {
  assistantId: string;
  knowledgeBases: AssistantKnowledgeBaseSummary[];
  selectedKnowledgeBaseIds: string[];
  availableSkills: AssistantResourceSkillSummary[];
  selectedSkillIds: string[];
  repositories: AssistantRepositoryResource[];
  mcpBindings: AssistantMcpBindingSummary[];
  repoBindings: AssistantRepoBindingSummary[];
  projectGraphResourceHints?: {
    skillIds: string[];
    mcpServerIds: string[];
    repositoryIds: string[];
  };
  projectGraphRecommendedResources?: AssistantProjectGraphRecommendedResource[];
}

export interface AssistantKnowledgeBaseSummary {
  id: string;
  name: string;
  description?: string | null;
}

export interface AssistantRepositoryResource {
  id: string;
  name: string;
  description?: string | null;
  defaultBranch?: string | null;
  visibility?: string;
  enabled?: boolean;
}

export interface AssistantBindingSecretsResponse {
  bindingId: string;
  secretStatus: AssistantMcpBindingSecretStatus;
  configuredKeys: string[];
}

export interface RepoReviewRepository {
  id: string;
  name: string;
  language: string;
  localRepoPath: string;
  remoteProvider: '' | 'github' | 'gitlab' | 'gitea';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  targetBranches?: string[];
  reviewChatJid: string;
  actorMentionMappings: RepoReviewActorMentionMapping[];
  reviewerUsernames?: string[];
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  lastAutoSyncAt: string;
  nextAutoSyncAt: string;
  lastAutoSyncStatus: string;
  lastAutoSyncMessage: string;
  digestDailyEnabled: boolean;
  digestWeeklyEnabled: boolean;
  digestDailyHour: number;
  digestWeeklyDay: number;
  digestWeeklyHour: number;
  lastDigestDailyAt: string;
  nextDigestDailyAt: string;
  lastDigestWeeklyAt: string;
  nextDigestWeeklyAt: string;
  enabled: boolean;
  allowAiFix: boolean;
  hasWebhookSecret: boolean;
  hasPlatformToken: boolean;
  webhookSecretPreview?: string;
  platformTokenPreview?: string;
  webhookUrl?: string;
  sshKeyId?: string;
  profileCount?: number;
}

export interface SshKeyInfo {
  id: string;
  name: string;
  fingerprint: string | null;
  keyType: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface RepoReviewRepositoryDetection {
  provider: '' | 'github' | 'gitlab' | 'gitea';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  repositoryName: string;
  source: 'local_repo' | 'remote_url';
  detectedRemoteName: string;
  availableRemotes: RepoReviewRepositoryRemoteOption[];
  warnings: string[];
}

export interface RepoReviewRepositoryRemoteOption {
  remoteName: string;
  provider: '' | 'github' | 'gitlab' | 'gitea';
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  repositoryName: string;
}

export interface RepoReviewActorMentionMapping {
  actor: string;
  channel: 'feishu';
  id: string;
  name: string;
}

export interface RepoReviewChatMember {
  id: string;
  name: string;
  chatJid: string;
  source: string;
}

export interface RepoReviewProfile {
  id: string;
  repositoryId: string;
  name: string;
  stage: 'commit' | 'push';
  sourceMode: 'local' | 'remote' | 'both';
  blockingMode: 'hard_fail' | 'soft_fail';
  passDecisionMode: 'ai' | 'human';
  reviewScope:
    | 'auto'
    | 'staged_diff'
    | 'commit_range'
    | 'pr_compare'
    | 'compare';
  targetBranches: string[];
  skillIds: string[];
  mcpServerIds: string[];
  promptTemplate: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  includeFullFileContext: boolean;
  maxFiles: number;
  maxDiffBytes: number;
  writeToChat: boolean;
  writeToPlatform: boolean;
  reviewOutputMode?: 'message' | 'share_link';
  diffSubagentThreshold: number;
  subagentTimeoutSeconds?: number;
  enabled: boolean;
}

export interface RepoReviewFinding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: string;
  codeSnippet?: string;
  fixCode?: string;
  evidence?: string;
  evidenceKey?: string;
  codeSnippetSource?: 'model' | 'diff' | 'workspace' | 'unavailable';
  needsSnippetHydration?: boolean;
  title: string;
  detail: string;
  suggestion?: string;
}

export interface RepoReviewCommitReview {
  commit: string;
  title: string;
  author: string;
  positives: string[];
  issues: string[];
}

export interface RepoReviewCommitInfo {
  commit: string;
  sha?: string;
  title: string;
  author: string;
  message: string;
  url?: string;
  timestamp?: string;
}

export interface RepoReviewBranchSummary {
  name: string;
  headSha: string;
  parentSha: string;
  actor: string;
  title: string;
  latestCommitAt: string;
  defaultBranch: boolean;
}

export interface RepoReviewBranchTriggerResult {
  branch: string;
  headSha: string;
  status: 'triggered' | 'skipped' | 'error';
  reason: string;
  runId?: string;
}

export interface RepoReviewBranchTriggerReasonCount {
  reason: string;
  count: number;
}

export interface RepoReviewBranchTriggerSummary {
  branches: RepoReviewBranchTriggerResult[];
  triggered: number;
  skipped: number;
  failed: number;
  skippedReasons: RepoReviewBranchTriggerReasonCount[];
  errorReasons: RepoReviewBranchTriggerReasonCount[];
  activeWindowDays: number;
}

export interface RepoReviewRun {
  id: string;
  repositoryId: string;
  profileId: string;
  source: string;
  stage: 'commit' | 'push';
  status: string;
  overall: '' | 'pass' | 'warn' | 'fail' | 'error' | 'skipped';
  passDecisionMode: 'ai' | 'human';
  recommendedBlock: boolean;
  blockingEnforced: boolean;
  ref: string;
  branch: string;
  baseSha: string;
  headSha: string;
  prMrNumber: string;
  actor: string;
  summary: string;
  markdownBody?: string;
  rawModelOutput?: string;
  resultState?: string;
  baselineSource?: string;
  baselineRef?: string;
  baselineLabel?: string;
  idempotencyKey?: string;
  findings: RepoReviewFinding[];
  reviewTurns: AssistantTurn[];
  reviewProgress?: {
    snapshotVersion?: number;
    heartbeatAt?: string;
    runTerminal?: boolean;
    turnCount: number;
    latestAssistantText: string;
    latestErrorText: string | null;
    hasTerminalOutput: boolean;
    steps?: RepoReviewProgressStep[];
  };
  commitDetails: RepoReviewCommitInfo[];
  commitReviews: RepoReviewCommitReview[];
  suggestions: string[];
  changedFiles: string[];
  diffBytes: number;
  executionStats?: {
    diffFiles: number;
    diffBytes: number;
    splitGroups: number;
    peakReservedBytes: number;
    fullFileBytesLoaded: number;
    promptBytesBuilt: number;
    progressSnapshotBytes: number;
    extraRepoReadCount: number;
    fullFileBatchReservedBytes: number[];
    modelCallCount?: number;
    delegatedSubagentCount?: number;
    plannedSubagentCount?: number;
    totalReadBudgetBytes?: number;
    maxFullFileBytesPerFile?: number;
    extractorAttempts?: number;
    workerCount?: number;
    completedWorkerCount?: number;
    failedWorkerCount?: number;
    timedOutWorkerCount?: number;
    reducerCallCount?: number;
    evidenceBundleBytes?: number;
    codeMapContextStatus?: 'ready' | 'stale' | 'missing' | 'error';
    codeIndexContextStatus?: 'ready' | 'stale' | 'missing' | 'error';
    changedFunctionCount?: number;
    subagentToolCallCount?: number;
    mainReadonlyToolCallCount?: number;
    timeoutFollowupCount?: number;
    partialWorkerResultCount?: number;
    fallbackMainReviewCount?: number;
    fallbackReviewedFileCount?: number;
  };
  durationMs?: number;
  platformStatus: string;
  platformCommentUrl: string;
  platformCommentId?: string;
  chatDeliveryStatus?: string;
  platformStatusDeliveryStatus?: string;
  platformCommentDeliveryStatus?: string;
  lastDeliveryError?: string;
  deliveryRetryCount?: number;
  effectiveRules?: Record<string, unknown>;
  manualDecision: '' | 'pass' | 'fail';
  manualDecisionBy: string;
  manualDecisionAt: string;
  error: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoReviewProgressStep {
  id: string;
  label: string;
  kind?:
    | 'stage'
    | 'main'
    | 'subagent'
    | 'extractor'
    | 'formatter'
    | 'worker'
    | 'reducer';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt: string;
  activeStartedAt?: string;
  completedAt?: string;
  durationMs?: number;
  detail?: string;
  inputText?: string;
  outputText?: string;
  metadataText?: string;
  error?: string;
}

export interface RepoReviewDigestRun {
  id: string;
  repositoryId: string;
  type: 'daily' | 'weekly';
  status: string;
  timezone: string;
  scheduledFor: string;
  periodStart: string;
  periodEnd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  branchCount: number;
  commitCount: number;
  contributorCount: number;
  summary: string;
  cloudDocUrl: string;
  cloudDocStatus: string;
  deliveryStatus: string;
  deliveryError: string;
  errorMessage: string;
  createdAt: string;
}

export interface RepoFeatureInfo {
  featureType: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface RepositoryInfo {
  id: string;
  name: string;
  language: string | null;
  localRepoPath: string | null;
  remoteProvider: string | null;
  remoteRepoSlug: string | null;
  remoteBaseUrl: string | null;
  cloneUrl: string | null;
  defaultTargetBranch: string | null;
  sshKeyId: string | null;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  lastAutoSyncAt: string | null;
  lastAutoSyncStatus: string | null;
  enabled: boolean;
  status: string | null;
  visibility: string | null;
  aiDescription: string | null;
  techStack: string[] | null;
  createdAt: string;
  updatedAt: string;
  features: RepoFeatureInfo[];
}

export interface ResourceBindingInfo {
  id: string;
  resourceType: string;
  resourceId: string;
  ownerType: string;
  ownerId: string;
  bindingKey: string;
  branch: string | null;
  workDirectory: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  repositoryName?: string;
  repositoryCloneUrl?: string;
}

export interface RepositoryAssistantRelationship {
  bindingId: string;
  assistantId: string;
  assistantName: string | null;
  branch: string | null;
  worktreePath: string | null;
}

export interface RepositoryWorkflowRelationship {
  ownerType?: 'workflow';
  bindingId: string;
  workflowId: string;
  workflowName: string | null;
  bindingKey: string;
  branch: string | null;
}

export interface RepositoryRunnerProfileRelationship {
  profileId: string;
  profileName: string;
}

export interface RepositoryRelationships {
  repositoryId: string;
  assistantBindings: RepositoryAssistantRelationship[];
  workflowBindings: RepositoryWorkflowRelationship[];
  runnerProfile: RepositoryRunnerProfileRelationship | null;
}

export interface ProjectGraphConfig {
  enabled: boolean;
  scanners: string[];
  skillIds: string[];
  mcpServerIds: string[];
  includePaths: string[];
  excludePaths: string[];
  serviceNames: {
    production: string;
    testing: string;
    nacosKeys: string[];
    logServiceNames: string[];
  };
  owners: string[];
  businessDomain: string;
  systemAliases: string[];
  databaseBindings: string[];
  logBindings: string[];
}

export interface ProjectGraphRun {
  id: string;
  repository_id: string;
  branch: string;
  status: 'running' | 'completed' | 'failed';
  scanner_version: string;
  source_head_sha: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  error_message: string | null;
  created_by: string;
  created_at: string;
}

export interface ProjectGraphEvidence {
  label: string;
  filePath?: string;
  line?: number;
  summary?: string;
}

export interface ProjectGraphFact {
  id: string;
  kind: string;
  name: string;
  value: Record<string, unknown>;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  locked: boolean;
  evidence: ProjectGraphEvidence[];
  updatedAt: string;
}

export interface ProjectGraphEdge {
  id: string;
  fromKind: string;
  fromName: string;
  relation: string;
  toKind: string;
  toName: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: ProjectGraphEvidence[];
}

export interface ProjectGraphDocument {
  id: string;
  docType: string;
  title: string;
  status: string;
  content: string;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  updatedAt: string;
}

export interface ProjectGraphOverview {
  repositoryId: string;
  config: ProjectGraphConfig;
  latestRun: ProjectGraphRun | null;
  facts: ProjectGraphFact[];
  edges: ProjectGraphEdge[];
  documents: ProjectGraphDocument[];
  runs: ProjectGraphRun[];
}

export interface ProjectGraphResourceContext {
  repositoryId: string;
  enabled: boolean;
  latestRunStatus: string;
  latestRunAt: string | null;
  serviceNames: string[];
  logServiceNames: string[];
  nacosKeys: string[];
  owners: string[];
  businessDomain: string;
  skillIds: string[];
  mcpServerIds: string[];
  downstreamServices: string[];
  tables: Array<{
    name: string;
    relation: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  documents: Array<{
    docType: string;
    title: string;
    status: string;
  }>;
}

export interface StatusLocalCapability {
  id: 'terminal' | 'browserControl' | 'localInstall' | string;
  configKey: string;
  permission: string;
  enabled: boolean;
  available: boolean;
  multiUserMode: boolean;
  reason: string;
}

export interface StatusInfo {
  assistant: string;
  provider: string;
  providerAlias: string;
  channels: { name: string; connected: boolean }[];
  agents: { activeAgents: number; queuedTasks: number };
  uptime: number;
  stockAnalysisEnabled?: boolean;
  webTerminalEnabled?: boolean;
  capabilities?: {
    terminal?: StatusLocalCapability;
    browserControl?: StatusLocalCapability;
    localInstall?: StatusLocalCapability;
  };
  allowInsecureTls?: boolean;
  subagentsEnabled?: boolean;
  subagents?: {
    controlPlaneVersion?: string;
    enabled: boolean;
    maxDepth: number;
    maxActive: number;
    activeCount: number;
    providers: Record<string, SubagentProviderCapabilities>;
  };
  memory?: {
    promotion?: {
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
    };
    search?: {
      indexedDocuments: number;
      syncStateDocuments: number;
      userMemoryProjection?: {
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
        group: {
          indexedResults24h: number;
          followupReads24h: number;
          recalls24h: number;
          followupReadRate24h: number | null;
        };
        global: {
          indexedResults24h: number;
          followupReads24h: number;
          recalls24h: number;
          followupReadRate24h: number | null;
        };
      };
      bySource: Record<
        string,
        {
          indexedResults24h: number;
          followupReads24h: number;
          recalls24h: number;
          followupReadRate24h: number | null;
        }
      >;
      topGroups: Array<{
        groupFolder: string;
        indexedResults24h: number;
        followupReads24h: number;
        recalls24h: number;
        followupReadRate24h: number | null;
      }>;
      sync?: {
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
    };
  };
}

export type DoctorSeverity = 'info' | 'warn' | 'error';

export interface DoctorCheck {
  id: string;
  area:
    | 'auth'
    | 'terminal'
    | 'network'
    | 'providers'
    | 'channels'
    | 'workspace';
  severity: DoctorSeverity;
  summary: string;
  detail?: string;
  suggestedFix?: string;
}

export interface DoctorReport {
  generatedAt: string;
  healthy: boolean;
  counts: Record<DoctorSeverity, number>;
  checks: DoctorCheck[];
}

export type OnboardingStepStatus = 'ready' | 'needs_action' | 'recommended';

export interface OnboardingStep {
  id: string;
  title: string;
  status: OnboardingStepStatus;
  summary: string;
  detail?: string;
  action?: string;
}

export interface OnboardingReport {
  generatedAt: string;
  ready: boolean;
  progress: Record<OnboardingStepStatus, number> & { total: number };
  steps: OnboardingStep[];
  suggestedCommands: string[];
}

export interface SenderTrustEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderTrustConfig {
  default: SenderTrustEntry;
  chats: Record<string, SenderTrustEntry>;
  logDenied: boolean;
}

export interface AiProvider {
  id: string;
  alias: string;
  type: string;
  capability: 'llm' | 'embedding';
  api_key: string | null;
  base_url: string | null;
  model: string | null;
  dimensions: number | null;
  is_default: number;
  is_user_default?: boolean;
  visibility?: string;
  source?: 'system' | 'own' | 'shared';
  is_global_default?: boolean;
  owner_user_id?: string;
  role_ids?: string[];
  user_ids?: string[];
  user_agent?: string | null;
  custom_headers?: Record<string, string> | null;
  custom_headers_text?: string | null;
  api_key_action?: 'keep' | 'rotate' | 'clear' | 'touch';
}

export interface ProviderTypeDef {
  type: string;
  label: string;
  capability: 'llm' | 'embedding';
  apiStyle: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresBaseUrl: boolean;
}

export interface TestResult {
  ok: boolean;
  status?:
    | 'success'
    | 'http_error'
    | 'timeout'
    | 'network_error'
    | 'configuration_error'
    | 'unknown_error';
  message: string;
  model?: string;
  latencyMs?: number;
  endpoint?: string;
  httpStatus?: number;
  providerType?: string;
  capability?: 'llm' | 'embedding';
}

export interface OrphanDirectoryEntry {
  root: 'groups' | 'sessions' | 'ipc';
  folder: string;
  path: string;
}

export interface StaleRegisteredGroupEntry {
  jid: string;
  name: string;
  folder: string;
}

export interface WorkspaceCleanupSummary {
  orphanDirectories: OrphanDirectoryEntry[];
  staleRegisteredGroups: StaleRegisteredGroupEntry[];
  deletedDirectories: OrphanDirectoryEntry[];
  deletedSessionRows: string[];
  deletedRegisteredGroups: string[];
}

export interface NativeDialogLike {
  title: string;
  message: string;
  confirmLabel?: string;
}

export interface ConfirmDialogState extends NativeDialogLike {
  open: boolean;
}

export type ConfigEffect = 'instant' | 'new_agent' | 'restart';

export interface ConfigKeyMetadata {
  key: string;
  label: string;
  effect: ConfigEffect;
  summary: string;
  risk?: 'normal' | 'sensitive' | 'dangerous';
}

export type ChannelFieldType = 'text' | 'password' | 'select' | 'boolean';

export interface ChannelFieldOption {
  value: string;
  label: string;
}

export interface ChannelFieldDefinition {
  key: string;
  label: string;
  type: ChannelFieldType;
  required?: boolean;
  effect: ConfigEffect;
  summary: string;
  risk?: 'normal' | 'sensitive' | 'dangerous';
  options?: ChannelFieldOption[];
}

export interface ChannelConversationCreateField {
  key: string;
  label: string;
  type: Exclude<ChannelFieldType, 'password' | 'boolean'>;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: ChannelFieldOption[];
}

export interface ChannelConversationSupport {
  supported: boolean;
  requiresInstance?: boolean;
  description?: string;
  unsupportedReason?: string;
  fields?: ChannelConversationCreateField[];
}

export interface ChannelTypeDefinition {
  type: string;
  label: string;
  description: string;
  allowMultiple: boolean;
  runtimeInstalled?: boolean;
  webConfigurable?: boolean;
  fields: ChannelFieldDefinition[];
  webConversation?: ChannelConversationSupport;
}

export type ConversationCreateFieldType = 'text' | 'select';

export interface ConversationCreateFieldDefinition {
  key: string;
  label: string;
  type: ConversationCreateFieldType;
  required?: boolean;
  placeholder?: string;
  summary?: string;
  options?: ChannelFieldOption[];
}

export interface ConversationCreateTargetDefinition {
  type: string;
  label: string;
  description: string;
  creatable: boolean;
  requiresConfiguredInstance: boolean;
  runtimeInstalled: boolean;
  fields: ConversationCreateFieldDefinition[];
  unavailableReason?: string;
}

export interface ChannelInstanceConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  visibility: 'public' | 'private';
  owner_id: string;
  config: Record<string, string | boolean>;
}

export type BasicConfigValue = string | boolean;

export type BasicConfigState = Record<string, BasicConfigValue>;

export interface BuiltinWebFetchSiteProfile {
  domains: string[];
  pathPrefixes: string[];
  forceProvider?: 'basic' | 'browser_cli';
  waitSelector: string;
  selectorTimeoutMs?: number;
  postWaitMs?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  viewport: string;
  userAgent: string;
}

export interface BuiltinWebFetchSiteProfilePreset {
  id: string;
  label: string;
  profile: BuiltinWebFetchSiteProfile;
}

export interface BrowserRuntimeStatus {
  enabled: boolean;
  running: boolean;
  connectionMode: 'managed' | 'connect';
  remoteDebugUrl: string;
  headless: boolean;
  userDataDir: string;
  executablePath: string;
  resolvedExecutablePath: string | null;
  debugPort: number | null;
  startedAt: string | null;
  lastTargetId: string | null;
  lastError: string;
}

export interface BrowserTab {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  active: boolean;
}

export interface BrowserSnapshotFrame {
  frameId: string;
  url?: string;
  name?: string;
  parentFrameId?: string;
  topFrame: boolean;
}

export interface BrowserSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  depth: number;
  actionable: boolean;
  frameId?: string;
  parentFrameId?: string;
  frameUrl?: string;
  frameName?: string;
  topFrame?: boolean;
}

export interface BrowserSnapshot {
  targetId: string;
  title: string;
  url: string;
  frames: BrowserSnapshotFrame[];
  nodes: BrowserSnapshotNode[];
  cacheHit?: boolean;
  capturedAt?: string;
  pageVersion?: string;
}

export interface BrowserRoleSnapshotRef {
  role: string;
  name?: string;
  frameId?: string;
  frameName?: string;
  topFrame?: boolean;
}

export interface BrowserRoleSnapshotStats {
  lines: number;
  chars: number;
  refs: number;
  interactive: number;
}

export interface BrowserRoleSnapshot {
  targetId: string;
  title: string;
  url: string;
  snapshot: string;
  refs: Record<string, BrowserRoleSnapshotRef>;
  stats: BrowserRoleSnapshotStats;
  truncated?: boolean;
  cacheHit?: boolean;
  capturedAt?: string;
  pageVersion?: string;
}

export interface BrowserScreenshot {
  targetId: string;
  title: string;
  url: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export interface BrowserActionResult {
  ok: true;
  targetId: string;
  title?: string;
  url?: string;
  waitedMs?: number;
  ref?: string;
  selector?: string;
  key?: string;
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export interface BrowserPageError {
  message: string;
  description?: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export interface BrowserLogs {
  console: BrowserConsoleEntry[];
  errors: BrowserPageError[];
}

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  loginEnabled?: boolean;
  ldapEnabled?: boolean;
  loginUsername?: string;
  bootstrapMode?: boolean;
  weakCredentials?: boolean;
  multiUserMode?: boolean;
  userId?: string | null;
  displayName?: string | null;
  roles?: string[];
  permissions?: string[];
}

export const BASIC_CONFIG_DEFAULTS: BasicConfigState = {
  ASSISTANT_NAME: 'NanoClaw',
  WEB_PORT: '3377',
  WEB_LOGIN_ENABLED: true,
  WEB_STOCK_ANALYSIS_ENABLED: false,
  WEB_TERMINAL_ENABLED: false,
  WEB_SEARCH_ENABLED: true,
  WEB_SEARCH_PROVIDER: 'auto',
  WEB_SEARCH_MAX_RESULTS: '5',
  WEB_FETCH_PROVIDER: 'auto',
  WEB_FETCH_USE_BUILTIN_SITE_PROFILES: false,
  WEB_FETCH_MAX_CHARS: '12000',
  WEB_FETCH_PAGE_SIZE: '6000',
  WEB_FETCH_BROWSER_COMMAND: '',
  WEB_FETCH_BROWSER_SITE_PROFILES: '',
  WEB_SEARCH_ALLOWED_DOMAINS: '',
  WEB_SEARCH_SEARXNG_BASE_URL: '',
  WEB_SEARCH_TAVILY_API_KEY: '',
  CODEX_MAX_TOOL_ITERATIONS: '100',
  BASH_APPROVAL_ALLOWLIST: '[]',
  DEFAULT_ACCESS_MODE: 'allowall',
  allowed_directories: '[]',
  ALLOW_INSECURE_TLS: false,
  WEB_LOGIN_USERNAME: 'admin',
  WEB_LOGIN_PASSWORD: 'admin123',
  WEB_BROWSER_ENABLED: false,
  WEB_BROWSER_HEADLESS: false,
  WEB_BROWSER_EXECUTABLE_PATH: '',
  WEB_BROWSER_EXTRA_ARGS: '',
  WEB_BROWSER_START_URL: 'about:blank',
  WEB_BROWSER_STARTUP_TIMEOUT_MS: '15000',
  WEB_BROWSER_ACTION_TIMEOUT_MS: '10000',
  LDAP_ENABLED: false,
  LDAP_URL: '',
  LDAP_BIND_DN: '',
  LDAP_BIND_PASSWORD: '',
  LDAP_SEARCH_BASE: '',
  LDAP_SEARCH_FILTER: '(sAMAccountName=%(user)s)',
  LDAP_ATTRIBUTE_MAP:
    '{"username":"sAMAccountName","name":"cn","email":"mail"}',
  LDAP_FALLBACK_LOCAL: true,
  LDAP_DEFAULT_ROLE: '',
  KB_LLM_CONCURRENCY: '4',
};

export type NavPage =
  | 'chat'
  | 'companion'
  | 'im'
  | 'tasks'
  | 'stock-analysis'
  | 'repos'
  | 'reviews'
  | 'channels'
  | 'terminal'
  | 'assistants'
  | 'settings'
  | 'users'
  | 'apps'
  | 'soul'
  | 'tavern'
  | 'knowledge'
  | 'workteam';
export type ChannelFilter = string;
export type ConversationSort = 'recent' | 'unread' | 'name';
export type SettingsTab =
  | 'providers'
  | 'channels'
  | 'prompt'
  | 'web-search'
  | 'general'
  | 'knowledge'
  | 'subagent'
  | 'security'
  | 'diagnostics'
  | 'browser'
  | 'extensions'
  | 'mcp'
  | 'skills'
  | 'my-providers'
  | 'my-channels'
  | 'live2d'
  | 'ssh-keys'
  | 'trash'
  | 'audit-log';

// ---------------------------------------------------------------------------
// Live2D Types
// ---------------------------------------------------------------------------

export type Live2DEmotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking'
  | 'neutral';

export interface Live2DModelInfo {
  id: string;
  name: string;
  description: string | null;
  userId: string;
  visibility: string;
  format: string;
  fileSize: number;
  entryFile: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Live2DEmotionMapping {
  emotion: string;
  motionGroup: string;
  expressionName: string;
  priority: number;
}

export interface Live2DPreferences {
  enabled: boolean;
  selectedModelId: string | null;
  position: string;
  panelWidth: number;
  opacity: number;
  emotionProviderId: string | null;
  modelScale: number;
  modelOffsetY: number;
}

export interface Live2DConfig {
  globalEnabled: boolean;
  emotionEnabled: boolean;
  preferences: Live2DPreferences;
}

export interface Live2DEmotionProvider {
  id: string;
  alias: string;
  type: string;
  model: string | null;
}

export interface Live2DEmotionEvent {
  type: 'live2d_emotion';
  jid: string;
  emotion: Live2DEmotion;
  turnId: string;
}

// ---------------------------------------------------------------------------
// User MCP / Skill / Public Library Types (v2)
// ---------------------------------------------------------------------------

export interface ExtensionCommandRequirement {
  command: string;
  optional?: boolean;
  installHint?: string;
}

export interface ExtensionEnvRequirement {
  key: string;
  optional?: boolean;
  secret?: boolean;
  description?: string;
}

export interface ExtensionFileRequirement {
  path: string;
  kind?: 'file' | 'directory';
  optional?: boolean;
}

export interface ExtensionNetworkRequirement {
  baseUrl?: string;
  envKey?: string;
  optional?: boolean;
  description?: string;
}

export interface ExtensionRequirements {
  commands?: ExtensionCommandRequirement[];
  env?: ExtensionEnvRequirement[];
  files?: ExtensionFileRequirement[];
  network?: ExtensionNetworkRequirement[];
}

export interface ExtensionArtifactMetadata {
  kinds?: string[];
  producesImages?: boolean;
  producesFiles?: boolean;
}

export interface ExtensionGeneratorMetadata {
  kind?: 'manual' | 'imported' | 'ai-generated';
  templateId?: string;
  sourceDocs?: string[];
}

export interface ExtensionUiMetadata {
  displayName?: string;
  category?: string;
}

export interface ExtensionMetadata {
  capabilities: string[];
  runtime?: {
    transport?: 'stdio' | 'streamable-http' | 'sse';
    kind?: string;
    entryFile?: string;
    url?: string;
    cwd?: string;
  };
  requirements?: ExtensionRequirements;
  artifacts?: ExtensionArtifactMetadata;
  generator?: ExtensionGeneratorMetadata;
  ui?: ExtensionUiMetadata;
  notes?: string;
}

export interface ExtensionHealthIssue {
  severity: 'warning' | 'blocked';
  code: string;
  message: string;
}

export interface ExtensionHealthStatus {
  state: 'ready' | 'warning' | 'blocked';
  summary: string;
  checkedAt: string;
  issues: ExtensionHealthIssue[];
}

export interface UserMcpServerView {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  cwd: string | null;
  enabled: boolean;
  visibility: 'private' | 'shared';
  sourceType: string;
  sourceRef: string | null;
  iconUrl: string | null;
  tags: string[];
  metadata: ExtensionMetadata;
  healthStatus: ExtensionHealthStatus;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
}

export interface UserSkillView {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  summary: string | null;
  skillContent: string | null;
  enabled: boolean;
  visibility: 'private' | 'shared';
  sourceType: string;
  sourceRef: string | null;
  iconUrl: string | null;
  tags: string[];
  metadata: ExtensionMetadata;
  healthStatus: ExtensionHealthStatus;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
}

export interface MarketplaceSourceView {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicLibraryItemType = 'mcp' | 'skill';
export type PublicLibraryItemSource = 'user-shared' | 'marketplace';

export interface PublicLibraryItem {
  id: string;
  type: PublicLibraryItemType;
  name: string;
  description: string | null;
  source: PublicLibraryItemSource;
  sourceLabel: string;
  ownerUserId: string | null;
  iconUrl: string | null;
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLibraryResult {
  items: PublicLibraryItem[];
  total: number;
  marketplaceSources: MarketplaceSourceView[];
}

// ---------------------------------------------------------------------------
// Knowledge base (web UI)
// ---------------------------------------------------------------------------

export type KnowledgeEnhancementLevel = 'metadata' | 'wiki_lite' | 'wiki_full';

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  owner_type: string;
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
  user_enabled?: number;
  created_at: string;
  updated_at: string;
  enhancement_level: KnowledgeEnhancementLevel;
  llm_provider_id: string | null;
  llm_model_override: string | null;
  temporal_half_life_days: number;
  /** 1 = UI/API may save knowledge search synthesis as wiki comparison pages */
  allow_query_backfill?: number;
}
