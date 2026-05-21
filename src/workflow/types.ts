export type WorkflowNodeType = 'role' | 'task';
export type WorkflowEdgeDirection = 'one_way' | 'two_way';
export type WorkflowEdgeCondition =
  | 'always'
  | 'on_pass'
  | 'on_fail'
  | 'on_blocked'
  | 'manual_only';
export type WorkflowNodeVerdict = 'pass' | 'fail' | 'blocked';
export type WorkflowKind =
  | 'repository'
  | 'skill'
  | 'mcp'
  | 'system_capability'
  | 'general';
export type WorkflowVisibility = 'private' | 'shared' | 'system';
export type WorkflowEditorMode = 'legacy' | 'fixed_pipeline_v1';
export type WorkflowPipelineNodeKind =
  | 'input'
  | 'retrieval'
  | 'analysis'
  | 'summary';
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowRunNodeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'skipped';
export type WorkflowNodeExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type WorkflowDialogueSessionStatus = 'active' | 'completed' | 'cancelled';
export type WorkflowMessageFrameType =
  | 'node_output'
  | 'manual_output_override'
  | 'feedback'
  | 'intervention';
export type WorkflowPendingTransferStatus =
  | 'pending'
  | 'approved'
  | 'cancelled'
  | 'sent';
export type WorkflowEventType =
  | 'run_started'
  | 'run_paused'
  | 'run_resumed'
  | 'run_cancelled'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_paused'
  | 'node_resumed'
  | 'input_updated'
  | 'output_updated'
  | 'message_scheduled'
  | 'message_cancelled'
  | 'message_sent'
  | 'artifact_created'
  | 'intervention';

export interface WorkflowArtifactPolicy {
  exportable: boolean;
  commitToBranch?: boolean;
  publishTarget?: 'skill' | 'mcp' | 'system';
}

export interface WorkflowRepositoryPolicy {
  required?: boolean;
  bindingKey?: string;
}

export interface WorkflowGuardrailsConfig {
  maxDurationMs: number;
  concurrentNodes: number;
  maxNodeRuns: number;
  maxTransfers: number;
  maxToolCalls: number;
  maxExecutionEvents: number;
  maxEstimatedContextCharsPerNode: number;
}

export interface WorkflowToolPolicy {
  mode: 'assistant_default' | 'restricted';
  managedSkillIds?: string[];
  userSkillIds?: string[];
  managedMcpServerIds?: string[];
  userMcpServerIds?: string[];
  managedKbIds?: string[];
  providerOverrideId?: string;
  modelOverride?: string;
}

export interface WorkflowEvaluationPolicy {
  enabled: boolean;
}

export interface WorkflowConfig {
  kind: WorkflowKind;
  visibility: WorkflowVisibility;
  editorMode: WorkflowEditorMode;
  repositoryPolicy?: WorkflowRepositoryPolicy;
  artifactPolicy: WorkflowArtifactPolicy;
  messageDelayMs: number;
  publishTarget?: 'skill' | 'mcp' | 'system';
  guardrails: WorkflowGuardrailsConfig;
  toolPolicy: WorkflowToolPolicy;
  evaluationPolicy: WorkflowEvaluationPolicy;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  user_id: string;
  status: 'draft' | 'active' | 'archived';
  workflow_config: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowNodeRecord {
  id: string;
  workflow_id: string;
  node_type: WorkflowNodeType;
  name: string;
  description: string;
  role_node_id: string;
  assistant_id: string;
  config_json: string;
  position_x: number;
  position_y: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowEdgeRecord {
  id: string;
  workflow_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  label: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflow_id: string;
  status: WorkflowRunStatus;
  input: string;
  output: string;
  created_at: string;
  started_at: string;
  completed_at: string;
}

export interface WorkflowRunNodeRecord {
  id: string;
  run_id: string;
  node_id: string;
  status: WorkflowRunNodeStatus;
  input_snapshot: string;
  manual_input_override: string;
  input_anchor_frame_id: string;
  input_priority_mode: 'feedback_first' | 'chronological';
  output_snapshot: string;
  last_error: string;
  pause_reason: string;
  version: number;
  started_at: string;
  completed_at: string;
  updated_at: string;
}

export interface WorkflowRunMessageRecord {
  id: string;
  run_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  message_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowRunInterventionRecord {
  id: string;
  run_id: string;
  node_id: string;
  intervention_type: string;
  summary: string;
  before_json: string;
  after_json: string;
  created_by: string;
  created_at: string;
}

export interface WorkflowNodeExecutionRecord {
  id: string;
  run_id: string;
  node_id: string;
  status: WorkflowNodeExecutionStatus;
  runtime_namespace: string;
  group_folder: string;
  prompt_text: string;
  output_text: string;
  error_text: string;
  session_id: string;
  started_at: string;
  completed_at: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowNodeExecutionEventRecord {
  id: string;
  execution_id: string;
  run_id: string;
  node_id: string;
  event_kind: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowDialogueSessionRecord {
  id: string;
  run_id: string;
  edge_id: string;
  status: WorkflowDialogueSessionStatus;
  direction: WorkflowEdgeDirection;
  turn_count: number;
  last_source_node_id: string;
  last_target_node_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowMessageFrameRecord {
  id: string;
  run_id: string;
  session_id: string;
  edge_id: string;
  turn_index: number;
  frame_type: WorkflowMessageFrameType;
  direction: WorkflowEdgeDirection;
  source_node_id: string;
  target_node_id: string;
  content_text: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowPendingTransferRecord {
  id: string;
  run_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  message_type: string;
  status: WorkflowPendingTransferStatus;
  content_text: string;
  payload_json: string;
  delay_ms: number;
  due_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  released_at: string;
  sent_at: string;
  cancelled_at: string;
}

export interface WorkflowArtifactRecord {
  id: string;
  run_id: string;
  artifact_type: string;
  name: string;
  summary: string;
  content_text: string;
  payload_json: string;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunEvaluationRecord {
  id: string;
  run_id: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  findings_json: string;
  created_at: string;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  workflow_config?: Record<string, unknown> | WorkflowConfig;
}

export interface CreateWorkflowNodeInput {
  node_type: WorkflowNodeType;
  name: string;
  description?: string;
  role_node_id?: string;
  assistant_id?: string;
  config_json?: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
  sort_order?: number;
}

export interface CreateWorkflowEdgeInput {
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  label?: string;
  config_json?: Record<string, unknown>;
}

export interface WorkflowSnapshot {
  workflow: WorkflowRecord;
  nodes: WorkflowNodeRecord[];
  edges: WorkflowEdgeRecord[];
}

export interface WorkflowRunGraph {
  run: WorkflowRunRecord;
  workflow: WorkflowRecord;
  nodes: WorkflowNodeRecord[];
  edges: WorkflowEdgeRecord[];
  runNodes: WorkflowRunNodeRecord[];
  messages: WorkflowRunMessageRecord[];
  interventions: WorkflowRunInterventionRecord[];
  executions: WorkflowNodeExecutionRecord[];
  executionEvents: WorkflowNodeExecutionEventRecord[];
  dialogueSessions: WorkflowDialogueSessionRecord[];
  messageFrames: WorkflowMessageFrameRecord[];
  pendingTransfers: WorkflowPendingTransferRecord[];
  artifacts: WorkflowArtifactRecord[];
  evaluation?: WorkflowRunEvaluationRecord;
}

export interface RoleNodeConfig {
  goal?: string;
  backstory?: string;
  tools?: Record<string, unknown>;
}

export interface TaskNodeConfig {
  pipelineNodeKind?: WorkflowPipelineNodeKind;
  assistantId?: string;
  objective?: string;
  acceptanceCriteria?: string;
  outputSchema?: string;
  outputContract?: WorkflowOutputContract;
  goal?: string;
  prompt?: string;
  expectedOutput?: string;
  projectGraph?: {
    enabled?: boolean;
    profile?:
      | 'default'
      | 'implementation'
      | 'impact'
      | 'tests'
      | 'config'
      | 'workflow'
      | 'minimal';
    focusPaths?: string[];
    relationFilter?: Array<'contains' | 'imports' | 'calls' | 'references'>;
    depth?: number;
    tokenBudget?: number;
    maxNodes?: number;
    maxSeeds?: number;
  };
  timeoutMs?: number;
  approvalRequired?: boolean;
  providerOverrideId?: string;
  modelOverride?: string;
  instructionsAppend?: string;
  allowedDirectories?: string[];
  contextPolicy?: WorkflowContextPolicy;
  toolPolicy?: WorkflowToolPolicy;
  retryPolicy?: {
    maxAttempts: number;
  };
  failurePolicy?: {
    maxAttempts?: number;
    defaultRollbackNodeId?: string;
    pauseOnFailure?: boolean;
  };
  handoffContract?: string;
  handoffPolicy?: {
    maxTurns: number;
    cooldownMs: number;
    exposeToolCalls: false;
  };
}

export interface WorkflowEdgeConfig {
  condition?: WorkflowEdgeCondition;
  discussionTurns?: number;
  requireVerdict?: boolean;
  contextPolicy?: WorkflowContextPolicy;
}

export interface WorkflowOutputContract {
  verdictRequired?: boolean;
  strictJson?: boolean;
  schemaValidation?: 'off' | 'warn' | 'block';
}

export interface WorkflowContextPolicy {
  mode?: 'full' | 'latest' | 'feedback_first';
  maxMessages?: number;
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
  includeFrameTypes?: WorkflowMessageFrameType[];
}

export interface WorkflowRealtimeEnvelope {
  type: 'workflow_event';
  runId: string;
  event: WorkflowEventType;
  payload: Record<string, unknown>;
  timestamp: string;
}
