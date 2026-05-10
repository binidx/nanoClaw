export type WorkflowNodeType = 'role' | 'task';
export type WorkflowEdgeDirection = 'one_way' | 'two_way';
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
  | 'message_sent'
  | 'intervention';

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

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  workflow_config?: Record<string, unknown>;
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
}

export interface RoleNodeConfig {
  goal?: string;
  backstory?: string;
  tools?: Record<string, unknown>;
}

export interface TaskNodeConfig {
  prompt?: string;
  expectedOutput?: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
  providerOverrideId?: string;
  modelOverride?: string;
  instructionsAppend?: string;
  allowedDirectories?: string[];
}

export interface WorkflowEdgeConfig {
  discussionTurns?: number;
}

export interface WorkflowRealtimeEnvelope {
  type: 'workflow_event';
  runId: string;
  event: WorkflowEventType;
  payload: Record<string, unknown>;
  timestamp: string;
}
