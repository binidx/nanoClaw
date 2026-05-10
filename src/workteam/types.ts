// ── Workteam Multi-Agent Collaboration Types ─────────────────────────

// ── Process / workflow mode ──────────────────────────────────────────

export type ProcessType = 'sequential' | 'hierarchical' | 'dag';

// ── Status enums ─────────────────────────────────────────────────────

export type TeamStatus = 'draft' | 'ready' | 'archived';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

export type WorkteamEventType =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_skipped'
  | 'agent_message'
  | 'team_message'
  | 'user_intervention'
  | 'heartbeat'
  | 'run_paused'
  | 'run_resumed'
  | 'run_cancelled'
  | 'changelog';

// ── Record types (DB rows) ───────────────────────────────────────────

export interface WorkteamRecord {
  id: string;
  name: string;
  description: string;
  user_id: string;
  process_type: ProcessType;
  workflow_config: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkteamAgentRecord {
  id: string;
  team_id: string;
  role: string;
  goal: string;
  backstory: string;
  assistant_id: string;
  chat_jid: string;
  tools_config: string;
  sort_order: number;
}

export interface WorkteamTaskRecord {
  id: string;
  team_id: string;
  agent_id: string;
  name: string;
  description: string;
  expected_output: string;
  dependencies: string;
  status: TaskStatus;
  sort_order: number;
  timeout_ms: number;
  retry_limit: number;
  eval_config: string;
}

export interface WorkteamRunRecord {
  id: string;
  team_id: string;
  status: RunStatus;
  input: string;
  output: string;
  checkpoint: string;
  started_at: string;
  completed_at: string;
  created_at: string;
}

export interface WorkteamRunTaskRecord {
  id: string;
  run_id: string;
  task_id: string;
  agent_id: string;
  status: TaskStatus;
  output: string;
  error: string;
  started_at: string;
  completed_at: string;
  retry_count: number;
}

export interface WorkteamEventRecord {
  id: string;
  run_id: string;
  source_agent_id: string;
  target_agent_id: string;
  event_type: WorkteamEventType;
  payload: string;
  created_at: string;
}

// ── Input DTOs (for create/update) ───────────────────────────────────

export interface CreateWorkteamInput {
  name: string;
  description?: string;
  process_type: ProcessType;
  workflow_config?: Record<string, unknown>;
}

export interface CreateWorkteamAgentInput {
  role: string;
  goal: string;
  backstory?: string;
  assistant_id?: string;
  tools_config?: Record<string, unknown>;
  sort_order?: number;
}

export interface CreateWorkteamTaskInput {
  agent_id: string;
  name: string;
  description: string;
  expected_output?: string;
  dependencies?: string[];
  sort_order?: number;
  timeout_ms?: number;
  retry_limit?: number;
  eval_config?: string;
}

// ── Smart creator types ──────────────────────────────────────────────

export interface SmartCreatorRequest {
  requirement: string;
  preferred_process_type?: ProcessType;
}

export interface SmartCreatorResult {
  process_type: ProcessType;
  agents: Array<{
    role: string;
    goal: string;
    backstory: string;
    model_preference?: string;
  }>;
  tasks: Array<{
    name: string;
    description: string;
    expected_output: string;
    agent_role: string;
    dependencies: string[];
  }>;
}

// ── Task graph types ─────────────────────────────────────────────────

export interface TaskNode {
  id: string;
  agentId: string;
  dependencies: string[];
}

export interface TaskGraph {
  nodes: Map<string, TaskNode>;
  adjacency: Map<string, string[]>;
  reverseAdjacency: Map<string, string[]>;
}

// ── Realtime event envelope ──────────────────────────────────────────

export interface WorkteamRealtimeEnvelope {
  type: 'workteam_event';
  runId: string;
  event: WorkteamEventType;
  payload: Record<string, unknown>;
  timestamp: string;
}
