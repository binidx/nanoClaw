import crypto from 'crypto';
import type {
  WorkteamRecord,
  WorkteamAgentRecord,
  WorkteamTaskRecord,
  WorkteamRunRecord,
  WorkteamRunTaskRecord,
  WorkteamEventRecord,
  CreateWorkteamInput,
  CreateWorkteamAgentInput,
  CreateWorkteamTaskInput,
  TeamStatus,
  RunStatus,
  TaskStatus,
  WorkteamEventType,
} from '../workteam/types.js';
import { dba } from './engine-access.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';

function genId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ── Workteam CRUD ────────────────────────────────────────────────────

export async function createWorkteam(
  input: CreateWorkteamInput,
): Promise<WorkteamRecord> {
  const id = genId();
  const ts = now();
  const userId = getCurrentUserId();
  const record: WorkteamRecord = {
    id,
    name: input.name,
    description: input.description ?? '',
    user_id: userId,
    process_type: input.process_type,
    workflow_config: JSON.stringify(input.workflow_config ?? {}),
    status: 'draft',
    created_at: ts,
    updated_at: ts,
  };
  const auditUser = getCurrentUserId();
  await dba.prepare(`
    INSERT INTO workteams (id, name, description, user_id, process_type, workflow_config, status, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.name, record.description, record.user_id,
    record.process_type, record.workflow_config, record.status,
    record.created_at, record.updated_at,
    auditUser, auditUser,
  );
  return record;
}

export async function getWorkteam(id: string): Promise<WorkteamRecord | undefined> {
  const row = await dba.prepare(`SELECT * FROM workteams WHERE id = ? AND deleted_at IS NULL`).get(id);
  return row as WorkteamRecord | undefined;
}

export async function listWorkteams(): Promise<WorkteamRecord[]> {
  const userId = getCurrentUserId();
  const rows = await dba.prepare(
    `SELECT * FROM workteams WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
  ).all(userId);
  return rows as WorkteamRecord[];
}

export async function updateWorkteam(
  id: string,
  updates: Partial<Pick<WorkteamRecord, 'name' | 'description' | 'process_type' | 'workflow_config' | 'status'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.process_type !== undefined) { sets.push('process_type = ?'); params.push(updates.process_type); }
  if (updates.workflow_config !== undefined) { sets.push('workflow_config = ?'); params.push(updates.workflow_config); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status as string); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now());
  sets.push('updated_by = ?');
  params.push(getCurrentUserId());
  params.push(id);
  await dba.prepare(`UPDATE workteams SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
}

export async function deleteWorkteam(id: string): Promise<void> {
  const ts = now();
  await dba.prepare(`DELETE FROM workteam_events WHERE run_id IN (SELECT id FROM workteam_runs WHERE team_id = ?)`).run(id);
  await dba.prepare(`DELETE FROM workteam_run_tasks WHERE run_id IN (SELECT id FROM workteam_runs WHERE team_id = ?)`).run(id);
  await dba.prepare(`DELETE FROM workteam_runs WHERE team_id = ?`).run(id);
  await dba.prepare(`DELETE FROM workteam_tasks WHERE team_id = ?`).run(id);
  await dba
    .prepare(
      `UPDATE workteam_agents SET deleted_at = ?, updated_at = ? WHERE team_id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
  await dba
    .prepare(
      `UPDATE workteams SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
}

// ── Workteam Agent CRUD ──────────────────────────────────────────────

export async function addWorkteamAgent(
  teamId: string,
  input: CreateWorkteamAgentInput,
): Promise<WorkteamAgentRecord> {
  const id = genId();
  const record: WorkteamAgentRecord = {
    id,
    team_id: teamId,
    role: input.role,
    goal: input.goal,
    backstory: input.backstory ?? '',
    assistant_id: input.assistant_id ?? '',
    chat_jid: '',
    tools_config: JSON.stringify(input.tools_config ?? {}),
    sort_order: input.sort_order ?? 0,
  };
  const auditUser = getCurrentUserId();
  await dba.prepare(`
    INSERT INTO workteam_agents (id, team_id, role, goal, backstory, assistant_id, chat_jid, tools_config, sort_order, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.team_id, record.role, record.goal, record.backstory,
    record.assistant_id, record.chat_jid, record.tools_config, record.sort_order,
    auditUser, auditUser,
  );
  return record;
}

export async function getWorkteamAgents(teamId: string): Promise<WorkteamAgentRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_agents WHERE team_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
  ).all(teamId);
  return rows as WorkteamAgentRecord[];
}

export async function updateWorkteamAgent(
  id: string,
  updates: Partial<Pick<WorkteamAgentRecord, 'role' | 'goal' | 'backstory' | 'assistant_id' | 'chat_jid' | 'tools_config' | 'sort_order'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.role !== undefined) { sets.push('role = ?'); params.push(updates.role); }
  if (updates.goal !== undefined) { sets.push('goal = ?'); params.push(updates.goal); }
  if (updates.backstory !== undefined) { sets.push('backstory = ?'); params.push(updates.backstory); }
  if (updates.assistant_id !== undefined) { sets.push('assistant_id = ?'); params.push(updates.assistant_id); }
  if (updates.chat_jid !== undefined) { sets.push('chat_jid = ?'); params.push(updates.chat_jid); }
  if (updates.tools_config !== undefined) { sets.push('tools_config = ?'); params.push(updates.tools_config); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }
  if (sets.length === 0) return;
  sets.push('updated_by = ?');
  params.push(getCurrentUserId());
  params.push(id);
  await dba.prepare(`UPDATE workteam_agents SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
}

export async function deleteWorkteamAgent(id: string): Promise<void> {
  const ts = now();
  await dba
    .prepare(
      `UPDATE workteam_agents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
}

// ── Workteam Task CRUD ───────────────────────────────────────────────

export async function addWorkteamTask(
  teamId: string,
  input: CreateWorkteamTaskInput,
): Promise<WorkteamTaskRecord> {
  const id = genId();
  const record: WorkteamTaskRecord = {
    id,
    team_id: teamId,
    agent_id: input.agent_id,
    name: input.name,
    description: input.description,
    expected_output: input.expected_output ?? '',
    dependencies: JSON.stringify(input.dependencies ?? []),
    status: 'pending',
    sort_order: input.sort_order ?? 0,
    timeout_ms: input.timeout_ms ?? 600000,
    retry_limit: input.retry_limit ?? 1,
    eval_config: input.eval_config ?? '',
  };
  await dba.prepare(`
    INSERT INTO workteam_tasks (id, team_id, agent_id, name, description, expected_output, dependencies, status, sort_order, timeout_ms, retry_limit, eval_config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.team_id, record.agent_id, record.name,
    record.description, record.expected_output, record.dependencies,
    record.status, record.sort_order, record.timeout_ms, record.retry_limit, record.eval_config,
  );
  return record;
}

export async function getWorkteamTasks(teamId: string): Promise<WorkteamTaskRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_tasks WHERE team_id = ? ORDER BY sort_order`,
  ).all(teamId);
  return rows as WorkteamTaskRecord[];
}

export async function updateWorkteamTask(
  id: string,
  updates: Partial<Pick<WorkteamTaskRecord, 'agent_id' | 'name' | 'description' | 'expected_output' | 'dependencies' | 'status' | 'sort_order' | 'timeout_ms' | 'retry_limit' | 'eval_config'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.agent_id !== undefined) { sets.push('agent_id = ?'); params.push(updates.agent_id); }
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.expected_output !== undefined) { sets.push('expected_output = ?'); params.push(updates.expected_output); }
  if (updates.dependencies !== undefined) { sets.push('dependencies = ?'); params.push(updates.dependencies); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status as string); }
  if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }
  if (updates.timeout_ms !== undefined) { sets.push('timeout_ms = ?'); params.push(updates.timeout_ms); }
  if (updates.retry_limit !== undefined) { sets.push('retry_limit = ?'); params.push(updates.retry_limit); }
  if (updates.eval_config !== undefined) { sets.push('eval_config = ?'); params.push(updates.eval_config); }
  if (sets.length === 0) return;
  params.push(id);
  await dba.prepare(`UPDATE workteam_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export async function deleteWorkteamTask(id: string): Promise<void> {
  await dba.prepare(`DELETE FROM workteam_tasks WHERE id = ?`).run(id);
}

// ── Run CRUD ─────────────────────────────────────────────────────────

export async function createWorkteamRun(
  teamId: string,
  input: string,
): Promise<WorkteamRunRecord> {
  const id = genId();
  const ts = now();
  const record: WorkteamRunRecord = {
    id,
    team_id: teamId,
    status: 'pending',
    input,
    output: '',
    checkpoint: '',
    started_at: '',
    completed_at: '',
    created_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workteam_runs (id, team_id, status, input, output, checkpoint, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.team_id, record.status, record.input,
    record.output, record.checkpoint, record.started_at, record.completed_at, record.created_at,
  );
  return record;
}

export async function getWorkteamRun(id: string): Promise<WorkteamRunRecord | undefined> {
  const row = await dba.prepare(`SELECT * FROM workteam_runs WHERE id = ?`).get(id);
  return row as WorkteamRunRecord | undefined;
}

export async function listWorkteamRuns(teamId: string): Promise<WorkteamRunRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_runs WHERE team_id = ? ORDER BY created_at DESC`,
  ).all(teamId);
  return rows as WorkteamRunRecord[];
}

export async function updateWorkteamRun(
  id: string,
  updates: Partial<Pick<WorkteamRunRecord, 'status' | 'output' | 'checkpoint' | 'started_at' | 'completed_at'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status as string); }
  if (updates.output !== undefined) { sets.push('output = ?'); params.push(updates.output); }
  if (updates.checkpoint !== undefined) { sets.push('checkpoint = ?'); params.push(updates.checkpoint); }
  if (updates.started_at !== undefined) { sets.push('started_at = ?'); params.push(updates.started_at); }
  if (updates.completed_at !== undefined) { sets.push('completed_at = ?'); params.push(updates.completed_at); }
  if (sets.length === 0) return;
  params.push(id);
  await dba.prepare(`UPDATE workteam_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export async function listActiveRuns(): Promise<WorkteamRunRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_runs WHERE status IN ('running', 'paused') ORDER BY created_at`,
  ).all();
  return rows as WorkteamRunRecord[];
}

// ── Run Task CRUD ────────────────────────────────────────────────────

export async function createWorkteamRunTask(
  runId: string,
  taskId: string,
  agentId: string,
): Promise<WorkteamRunTaskRecord> {
  const id = genId();
  const record: WorkteamRunTaskRecord = {
    id,
    run_id: runId,
    task_id: taskId,
    agent_id: agentId,
    status: 'pending',
    output: '',
    error: '',
    started_at: '',
    completed_at: '',
    retry_count: 0,
  };
  await dba.prepare(`
    INSERT INTO workteam_run_tasks (id, run_id, task_id, agent_id, status, output, error, started_at, completed_at, retry_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.run_id, record.task_id, record.agent_id,
    record.status, record.output, record.error,
    record.started_at, record.completed_at, record.retry_count,
  );
  return record;
}

export async function getWorkteamRunTasks(runId: string): Promise<WorkteamRunTaskRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_run_tasks WHERE run_id = ?`,
  ).all(runId);
  return rows as WorkteamRunTaskRecord[];
}

export async function updateWorkteamRunTask(
  id: string,
  updates: Partial<Pick<WorkteamRunTaskRecord, 'status' | 'output' | 'error' | 'started_at' | 'completed_at' | 'retry_count' | 'agent_id'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status as string); }
  if (updates.output !== undefined) { sets.push('output = ?'); params.push(updates.output); }
  if (updates.error !== undefined) { sets.push('error = ?'); params.push(updates.error); }
  if (updates.started_at !== undefined) { sets.push('started_at = ?'); params.push(updates.started_at); }
  if (updates.completed_at !== undefined) { sets.push('completed_at = ?'); params.push(updates.completed_at); }
  if (updates.retry_count !== undefined) { sets.push('retry_count = ?'); params.push(updates.retry_count); }
  if (updates.agent_id !== undefined) { sets.push('agent_id = ?'); params.push(updates.agent_id); }
  if (sets.length === 0) return;
  params.push(id);
  await dba.prepare(`UPDATE workteam_run_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Event log ────────────────────────────────────────────────────────

export async function insertWorkteamEvent(
  runId: string,
  eventType: WorkteamEventType,
  payload: Record<string, unknown>,
  sourceAgentId = '',
  targetAgentId = '',
): Promise<WorkteamEventRecord> {
  const id = genId();
  const ts = now();
  const record: WorkteamEventRecord = {
    id,
    run_id: runId,
    source_agent_id: sourceAgentId,
    target_agent_id: targetAgentId,
    event_type: eventType,
    payload: JSON.stringify(payload),
    created_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workteam_events (id, run_id, source_agent_id, target_agent_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.run_id, record.source_agent_id,
    record.target_agent_id, record.event_type, record.payload, record.created_at,
  );
  return record;
}

export async function getAgentMessages(
  runId: string,
  targetAgentId: string,
): Promise<WorkteamEventRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workteam_events WHERE run_id = ? AND target_agent_id = ? AND event_type = 'agent_message' ORDER BY created_at`,
  ).all(runId, targetAgentId);
  return rows as WorkteamEventRecord[];
}

export async function getWorkteamEvents(
  runId: string,
  since?: string,
): Promise<WorkteamEventRecord[]> {
  if (since) {
    const rows = await dba.prepare(
      `SELECT * FROM workteam_events WHERE run_id = ? AND created_at > ? ORDER BY created_at`,
    ).all(runId, since);
    return rows as WorkteamEventRecord[];
  }
  const rows = await dba.prepare(
    `SELECT * FROM workteam_events WHERE run_id = ? ORDER BY created_at`,
  ).all(runId);
  return rows as WorkteamEventRecord[];
}

// ── Full team snapshot (for detail view) ─────────────────────────────

export interface WorkteamSnapshot {
  team: WorkteamRecord;
  agents: WorkteamAgentRecord[];
  tasks: WorkteamTaskRecord[];
}

export async function getWorkteamSnapshot(teamId: string): Promise<WorkteamSnapshot | undefined> {
  const team = await getWorkteam(teamId);
  if (!team) return undefined;
  const [agents, tasks] = await Promise.all([
    getWorkteamAgents(teamId),
    getWorkteamTasks(teamId),
  ]);
  return { team, agents, tasks };
}
