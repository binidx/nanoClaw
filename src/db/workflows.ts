import crypto from 'crypto';
import { dba } from './engine-access.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import type {
  CreateWorkflowEdgeInput,
  CreateWorkflowInput,
  CreateWorkflowNodeInput,
  WorkflowEdgeRecord,
  WorkflowNodeRecord,
  WorkflowRecord,
  WorkflowRunGraph,
  WorkflowRunInterventionRecord,
  WorkflowRunMessageRecord,
  WorkflowRunNodeRecord,
  WorkflowRunRecord,
  WorkflowNodeExecutionRecord,
  WorkflowNodeExecutionEventRecord,
  WorkflowDialogueSessionRecord,
  WorkflowMessageFrameRecord,
  WorkflowSnapshot,
} from '../workflow/types.js';

function genId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

export async function createWorkflow(
  input: CreateWorkflowInput,
): Promise<WorkflowRecord> {
  const id = genId();
  const ts = now();
  const record: WorkflowRecord = {
    id,
    name: input.name,
    description: input.description ?? '',
    user_id: getCurrentUserId(),
    status: 'draft',
    workflow_config: JSON.stringify(input.workflow_config ?? {}),
    created_at: ts,
    updated_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workflows (id, name, description, user_id, status, workflow_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    record.description,
    record.user_id,
    record.status,
    record.workflow_config,
    record.created_at,
    record.updated_at,
  );
  return record;
}

export async function listWorkflows(): Promise<WorkflowRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflows WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC`,
  ).all(getCurrentUserId());
  return rows as WorkflowRecord[];
}

export async function getWorkflow(
  id: string,
): Promise<WorkflowRecord | undefined> {
  const row = await dba
    .prepare(`SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row as WorkflowRecord | undefined;
}

export async function updateWorkflow(
  id: string,
  updates: Partial<
    Pick<WorkflowRecord, 'name' | 'description' | 'status' | 'workflow_config'>
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push('description = ?');
    params.push(updates.description);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.workflow_config !== undefined) {
    sets.push('workflow_config = ?');
    params.push(updates.workflow_config);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);
  await dba
    .prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

export async function deleteWorkflow(id: string): Promise<void> {
  const ts = now();
  await dba
    .prepare(`UPDATE workflows SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .run(ts, ts, id);
}

export async function createWorkflowNode(
  workflowId: string,
  input: CreateWorkflowNodeInput,
): Promise<WorkflowNodeRecord> {
  const id = genId();
  const ts = now();
  const record: WorkflowNodeRecord = {
    id,
    workflow_id: workflowId,
    node_type: input.node_type,
    name: input.name,
    description: input.description ?? '',
    role_node_id: input.role_node_id ?? '',
    assistant_id: input.assistant_id ?? '',
    config_json: JSON.stringify(input.config_json ?? {}),
    position_x: input.position_x ?? 120,
    position_y: input.position_y ?? 120,
    sort_order: input.sort_order ?? 0,
    created_at: ts,
    updated_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workflow_nodes (
      id, workflow_id, node_type, name, description, role_node_id, assistant_id,
      config_json, position_x, position_y, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.workflow_id,
    record.node_type,
    record.name,
    record.description,
    record.role_node_id,
    record.assistant_id,
    record.config_json,
    record.position_x,
    record.position_y,
    record.sort_order,
    record.created_at,
    record.updated_at,
  );
  return record;
}

export async function listWorkflowNodes(
  workflowId: string,
): Promise<WorkflowNodeRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_nodes WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
  ).all(workflowId);
  return rows as WorkflowNodeRecord[];
}

export async function updateWorkflowNode(
  id: string,
  updates: Partial<
    Pick<
      WorkflowNodeRecord,
      | 'name'
      | 'description'
      | 'role_node_id'
      | 'assistant_id'
      | 'config_json'
      | 'position_x'
      | 'position_y'
      | 'sort_order'
    >
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push('description = ?');
    params.push(updates.description);
  }
  if (updates.role_node_id !== undefined) {
    sets.push('role_node_id = ?');
    params.push(updates.role_node_id);
  }
  if (updates.assistant_id !== undefined) {
    sets.push('assistant_id = ?');
    params.push(updates.assistant_id);
  }
  if (updates.config_json !== undefined) {
    sets.push('config_json = ?');
    params.push(updates.config_json);
  }
  if (updates.position_x !== undefined) {
    sets.push('position_x = ?');
    params.push(updates.position_x);
  }
  if (updates.position_y !== undefined) {
    sets.push('position_y = ?');
    params.push(updates.position_y);
  }
  if (updates.sort_order !== undefined) {
    sets.push('sort_order = ?');
    params.push(updates.sort_order);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);
  await dba
    .prepare(
      `UPDATE workflow_nodes SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(...params);
}

export async function deleteWorkflowNode(id: string): Promise<void> {
  const ts = now();
  await dba
    .prepare(
      `UPDATE workflow_nodes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
  await dba
    .prepare(
      `UPDATE workflow_edges SET deleted_at = ?, updated_at = ? WHERE source_node_id = ? OR target_node_id = ?`,
    )
    .run(ts, ts, id, id);
}

export async function createWorkflowEdge(
  workflowId: string,
  input: CreateWorkflowEdgeInput,
): Promise<WorkflowEdgeRecord> {
  const id = genId();
  const ts = now();
  const record: WorkflowEdgeRecord = {
    id,
    workflow_id: workflowId,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    direction: input.direction,
    label: input.label ?? '',
    config_json: JSON.stringify(input.config_json ?? {}),
    created_at: ts,
    updated_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workflow_edges (
      id, workflow_id, source_node_id, target_node_id, direction, label, config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.workflow_id,
    record.source_node_id,
    record.target_node_id,
    record.direction,
    record.label,
    record.config_json,
    record.created_at,
    record.updated_at,
  );
  return record;
}

export async function listWorkflowEdges(
  workflowId: string,
): Promise<WorkflowEdgeRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_edges WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY created_at`,
  ).all(workflowId);
  return rows as WorkflowEdgeRecord[];
}

export async function updateWorkflowEdge(
  id: string,
  updates: Partial<
    Pick<
      WorkflowEdgeRecord,
      'source_node_id' | 'target_node_id' | 'direction' | 'label' | 'config_json'
    >
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.source_node_id !== undefined) {
    sets.push('source_node_id = ?');
    params.push(updates.source_node_id);
  }
  if (updates.target_node_id !== undefined) {
    sets.push('target_node_id = ?');
    params.push(updates.target_node_id);
  }
  if (updates.direction !== undefined) {
    sets.push('direction = ?');
    params.push(updates.direction);
  }
  if (updates.label !== undefined) {
    sets.push('label = ?');
    params.push(updates.label);
  }
  if (updates.config_json !== undefined) {
    sets.push('config_json = ?');
    params.push(updates.config_json);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now());
  params.push(id);
  await dba
    .prepare(
      `UPDATE workflow_edges SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(...params);
}

export async function deleteWorkflowEdge(id: string): Promise<void> {
  const ts = now();
  await dba
    .prepare(
      `UPDATE workflow_edges SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(ts, ts, id);
}

export async function getWorkflowSnapshot(
  workflowId: string,
): Promise<WorkflowSnapshot | undefined> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) return undefined;
  const [nodes, edges] = await Promise.all([
    listWorkflowNodes(workflowId),
    listWorkflowEdges(workflowId),
  ]);
  return { workflow, nodes, edges };
}

export async function createWorkflowRun(
  workflowId: string,
  input: string,
): Promise<WorkflowRunRecord> {
  const id = genId();
  const ts = now();
  const record: WorkflowRunRecord = {
    id,
    workflow_id: workflowId,
    status: 'pending',
    input,
    output: '',
    created_at: ts,
    started_at: '',
    completed_at: '',
  };
  await dba.prepare(`
    INSERT INTO workflow_runs (id, workflow_id, status, input, output, created_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.workflow_id,
    record.status,
    record.input,
    record.output,
    record.created_at,
    record.started_at,
    record.completed_at,
  );
  return record;
}

export async function updateWorkflowRun(
  id: string,
  updates: Partial<
    Pick<WorkflowRunRecord, 'status' | 'input' | 'output' | 'started_at' | 'completed_at'>
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.input !== undefined) {
    sets.push('input = ?');
    params.push(updates.input);
  }
  if (updates.output !== undefined) {
    sets.push('output = ?');
    params.push(updates.output);
  }
  if (updates.started_at !== undefined) {
    sets.push('started_at = ?');
    params.push(updates.started_at);
  }
  if (updates.completed_at !== undefined) {
    sets.push('completed_at = ?');
    params.push(updates.completed_at);
  }
  if (sets.length === 0) return;
  params.push(id);
  await dba
    .prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

export async function getWorkflowRun(
  id: string,
): Promise<WorkflowRunRecord | undefined> {
  const row = await dba.prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(id);
  return row as WorkflowRunRecord | undefined;
}

export async function listWorkflowRuns(
  workflowId: string,
): Promise<WorkflowRunRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC`,
  ).all(workflowId);
  return rows as WorkflowRunRecord[];
}

export async function listActiveWorkflowRuns(): Promise<WorkflowRunRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_runs WHERE status IN ('running', 'paused') ORDER BY created_at`,
  ).all();
  return rows as WorkflowRunRecord[];
}

export async function createWorkflowRunNode(
  runId: string,
  nodeId: string,
): Promise<WorkflowRunNodeRecord> {
  const id = genId();
  const ts = now();
  const record: WorkflowRunNodeRecord = {
    id,
    run_id: runId,
    node_id: nodeId,
    status: 'pending',
    input_snapshot: '',
    manual_input_override: '',
    input_anchor_frame_id: '',
    input_priority_mode: 'feedback_first',
    output_snapshot: '',
    last_error: '',
    pause_reason: '',
    version: 1,
    started_at: '',
    completed_at: '',
    updated_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workflow_run_nodes (
      id, run_id, node_id, status, input_snapshot, manual_input_override, input_anchor_frame_id,
      input_priority_mode, output_snapshot, last_error, pause_reason, version, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.node_id,
    record.status,
    record.input_snapshot,
    record.manual_input_override,
    record.input_anchor_frame_id,
    record.input_priority_mode,
    record.output_snapshot,
    record.last_error,
    record.pause_reason,
    record.version,
    record.started_at,
    record.completed_at,
    record.updated_at,
  );
  return record;
}

export async function listWorkflowRunNodes(
  runId: string,
): Promise<WorkflowRunNodeRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY updated_at`,
  ).all(runId);
  return rows as WorkflowRunNodeRecord[];
}

export async function getWorkflowRunNode(
  runId: string,
  nodeId: string,
): Promise<WorkflowRunNodeRecord | undefined> {
  const row = await dba
    .prepare(`SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ?`)
    .get(runId, nodeId);
  return row as WorkflowRunNodeRecord | undefined;
}

export async function updateWorkflowRunNode(
  id: string,
  updates: Partial<
    Pick<
      WorkflowRunNodeRecord,
      | 'status'
      | 'input_snapshot'
      | 'manual_input_override'
      | 'input_anchor_frame_id'
      | 'input_priority_mode'
      | 'output_snapshot'
      | 'last_error'
      | 'pause_reason'
      | 'version'
      | 'started_at'
      | 'completed_at'
      | 'updated_at'
    >
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.input_snapshot !== undefined) {
    sets.push('input_snapshot = ?');
    params.push(updates.input_snapshot);
  }
  if (updates.manual_input_override !== undefined) {
    sets.push('manual_input_override = ?');
    params.push(updates.manual_input_override);
  }
  if (updates.input_anchor_frame_id !== undefined) {
    sets.push('input_anchor_frame_id = ?');
    params.push(updates.input_anchor_frame_id);
  }
  if (updates.input_priority_mode !== undefined) {
    sets.push('input_priority_mode = ?');
    params.push(updates.input_priority_mode);
  }
  if (updates.output_snapshot !== undefined) {
    sets.push('output_snapshot = ?');
    params.push(updates.output_snapshot);
  }
  if (updates.last_error !== undefined) {
    sets.push('last_error = ?');
    params.push(updates.last_error);
  }
  if (updates.pause_reason !== undefined) {
    sets.push('pause_reason = ?');
    params.push(updates.pause_reason);
  }
  if (updates.version !== undefined) {
    sets.push('version = ?');
    params.push(updates.version);
  }
  if (updates.started_at !== undefined) {
    sets.push('started_at = ?');
    params.push(updates.started_at);
  }
  if (updates.completed_at !== undefined) {
    sets.push('completed_at = ?');
    params.push(updates.completed_at);
  }
  sets.push('updated_at = ?');
  params.push(updates.updated_at ?? now());
  params.push(id);
  await dba
    .prepare(`UPDATE workflow_run_nodes SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

export async function insertWorkflowRunMessage(input: {
  run_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: 'one_way' | 'two_way';
  message_type: string;
  payload_json: string;
}): Promise<WorkflowRunMessageRecord> {
  const record: WorkflowRunMessageRecord = {
    id: genId(),
    run_id: input.run_id,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    direction: input.direction,
    message_type: input.message_type,
    payload_json: input.payload_json,
    created_at: now(),
  };
  await dba.prepare(`
    INSERT INTO workflow_run_messages (
      id, run_id, source_node_id, target_node_id, direction, message_type, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.source_node_id,
    record.target_node_id,
    record.direction,
    record.message_type,
    record.payload_json,
    record.created_at,
  );
  return record;
}

export async function getWorkflowDialogueSession(
  runId: string,
  edgeId: string,
): Promise<WorkflowDialogueSessionRecord | undefined> {
  const row = await dba
    .prepare(
      `SELECT * FROM workflow_dialogue_sessions
       WHERE run_id = ? AND edge_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(runId, edgeId);
  return row as WorkflowDialogueSessionRecord | undefined;
}

export async function upsertWorkflowDialogueSession(input: {
  run_id: string;
  edge_id: string;
  direction: 'one_way' | 'two_way';
  last_source_node_id: string;
  last_target_node_id: string;
}): Promise<WorkflowDialogueSessionRecord> {
  const existing = await getWorkflowDialogueSession(input.run_id, input.edge_id);
  if (!existing) {
    const ts = now();
    const record: WorkflowDialogueSessionRecord = {
      id: genId(),
      run_id: input.run_id,
      edge_id: input.edge_id,
      status: 'active',
      direction: input.direction,
      turn_count: 1,
      last_source_node_id: input.last_source_node_id,
      last_target_node_id: input.last_target_node_id,
      created_at: ts,
      updated_at: ts,
    };
    await dba.prepare(`
      INSERT INTO workflow_dialogue_sessions (
        id, run_id, edge_id, status, direction, turn_count, last_source_node_id, last_target_node_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.run_id,
      record.edge_id,
      record.status,
      record.direction,
      record.turn_count,
      record.last_source_node_id,
      record.last_target_node_id,
      record.created_at,
      record.updated_at,
    );
    return record;
  }
  const turnCount = existing.turn_count + 1;
  const updatedAt = now();
  await dba.prepare(`
    UPDATE workflow_dialogue_sessions
    SET status = ?, turn_count = ?, last_source_node_id = ?, last_target_node_id = ?, updated_at = ?
    WHERE id = ?
  `).run(
    'active',
    turnCount,
    input.last_source_node_id,
    input.last_target_node_id,
    updatedAt,
    existing.id,
  );
  return {
    ...existing,
    status: 'active',
    turn_count: turnCount,
    last_source_node_id: input.last_source_node_id,
    last_target_node_id: input.last_target_node_id,
    updated_at: updatedAt,
  };
}

export async function insertWorkflowMessageFrame(input: {
  run_id: string;
  session_id: string;
  edge_id: string;
  turn_index: number;
  frame_type: string;
  direction: 'one_way' | 'two_way';
  source_node_id: string;
  target_node_id: string;
  content_text: string;
  payload_json: string;
}): Promise<WorkflowMessageFrameRecord> {
  const record: WorkflowMessageFrameRecord = {
    id: genId(),
    run_id: input.run_id,
    session_id: input.session_id,
    edge_id: input.edge_id,
    turn_index: input.turn_index,
    frame_type: input.frame_type as WorkflowMessageFrameRecord['frame_type'],
    direction: input.direction,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    content_text: input.content_text,
    payload_json: input.payload_json,
    created_at: now(),
  };
  await dba.prepare(`
    INSERT INTO workflow_message_frames (
      id, run_id, session_id, edge_id, turn_index, frame_type, direction, source_node_id, target_node_id, content_text, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.session_id,
    record.edge_id,
    record.turn_index,
    record.frame_type,
    record.direction,
    record.source_node_id,
    record.target_node_id,
    record.content_text,
    record.payload_json,
    record.created_at,
  );
  return record;
}

export async function recordWorkflowRuntimeFrame(input: {
  run_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: 'one_way' | 'two_way';
  frame_type: string;
  content_text: string;
  payload_json: string;
  message_type: string;
}): Promise<{
  message: WorkflowRunMessageRecord;
  session: WorkflowDialogueSessionRecord;
  frame: WorkflowMessageFrameRecord;
}> {
  const message = await insertWorkflowRunMessage({
    run_id: input.run_id,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    direction: input.direction,
    message_type: input.message_type,
    payload_json: input.payload_json,
  });
  const session = await upsertWorkflowDialogueSession({
    run_id: input.run_id,
    edge_id: input.edge_id,
    direction: input.direction,
    last_source_node_id: input.source_node_id,
    last_target_node_id: input.target_node_id,
  });
  const frame = await insertWorkflowMessageFrame({
    run_id: input.run_id,
    session_id: session.id,
    edge_id: input.edge_id,
    turn_index: session.turn_count,
    frame_type: input.frame_type,
    direction: input.direction,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    content_text: input.content_text,
    payload_json: input.payload_json,
  });
  return { message, session, frame };
}

export async function listWorkflowRunMessages(
  runId: string,
): Promise<WorkflowRunMessageRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_run_messages WHERE run_id = ? ORDER BY created_at`,
  ).all(runId);
  return rows as WorkflowRunMessageRecord[];
}

export async function insertWorkflowIntervention(input: {
  run_id: string;
  node_id: string;
  intervention_type: string;
  summary: string;
  before_json: string;
  after_json: string;
}): Promise<WorkflowRunInterventionRecord> {
  const record: WorkflowRunInterventionRecord = {
    id: genId(),
    run_id: input.run_id,
    node_id: input.node_id,
    intervention_type: input.intervention_type,
    summary: input.summary,
    before_json: input.before_json,
    after_json: input.after_json,
    created_by: getCurrentUserId(),
    created_at: now(),
  };
  await dba.prepare(`
    INSERT INTO workflow_run_interventions (
      id, run_id, node_id, intervention_type, summary, before_json, after_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.node_id,
    record.intervention_type,
    record.summary,
    record.before_json,
    record.after_json,
    record.created_by,
    record.created_at,
  );
  return record;
}

export async function listWorkflowRunInterventions(
  runId: string,
): Promise<WorkflowRunInterventionRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_run_interventions WHERE run_id = ? ORDER BY created_at`,
  ).all(runId);
  return rows as WorkflowRunInterventionRecord[];
}

export async function createWorkflowNodeExecution(input: {
  run_id: string;
  node_id: string;
  runtime_namespace: string;
  group_folder: string;
  prompt_text: string;
  session_id?: string;
}): Promise<WorkflowNodeExecutionRecord> {
  const ts = now();
  const record: WorkflowNodeExecutionRecord = {
    id: genId(),
    run_id: input.run_id,
    node_id: input.node_id,
    status: 'running',
    runtime_namespace: input.runtime_namespace,
    group_folder: input.group_folder,
    prompt_text: input.prompt_text,
    output_text: '',
    error_text: '',
    session_id: input.session_id ?? '',
    started_at: ts,
    completed_at: '',
    created_at: ts,
    updated_at: ts,
  };
  await dba.prepare(`
    INSERT INTO workflow_node_executions (
      id, run_id, node_id, status, runtime_namespace, group_folder, prompt_text,
      output_text, error_text, session_id, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.node_id,
    record.status,
    record.runtime_namespace,
    record.group_folder,
    record.prompt_text,
    record.output_text,
    record.error_text,
    record.session_id,
    record.started_at,
    record.completed_at,
    record.created_at,
    record.updated_at,
  );
  return record;
}

export async function updateWorkflowNodeExecution(
  id: string,
  updates: Partial<
    Pick<
      WorkflowNodeExecutionRecord,
      | 'status'
      | 'output_text'
      | 'error_text'
      | 'session_id'
      | 'started_at'
      | 'completed_at'
      | 'updated_at'
    >
  >,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.output_text !== undefined) {
    sets.push('output_text = ?');
    params.push(updates.output_text);
  }
  if (updates.error_text !== undefined) {
    sets.push('error_text = ?');
    params.push(updates.error_text);
  }
  if (updates.session_id !== undefined) {
    sets.push('session_id = ?');
    params.push(updates.session_id);
  }
  if (updates.started_at !== undefined) {
    sets.push('started_at = ?');
    params.push(updates.started_at);
  }
  if (updates.completed_at !== undefined) {
    sets.push('completed_at = ?');
    params.push(updates.completed_at);
  }
  sets.push('updated_at = ?');
  params.push(updates.updated_at ?? now());
  params.push(id);
  await dba
    .prepare(`UPDATE workflow_node_executions SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

export async function getLatestWorkflowNodeExecution(
  runId: string,
  nodeId: string,
): Promise<WorkflowNodeExecutionRecord | undefined> {
  const row = await dba
    .prepare(
      `SELECT * FROM workflow_node_executions
       WHERE run_id = ? AND node_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(runId, nodeId);
  return row as WorkflowNodeExecutionRecord | undefined;
}

export async function listWorkflowNodeExecutions(
  runId: string,
): Promise<WorkflowNodeExecutionRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_node_executions WHERE run_id = ? ORDER BY created_at, started_at`,
  ).all(runId);
  return rows as WorkflowNodeExecutionRecord[];
}

export async function insertWorkflowNodeExecutionEvent(input: {
  execution_id: string;
  run_id: string;
  node_id: string;
  event_kind: string;
  payload_json: string;
}): Promise<WorkflowNodeExecutionEventRecord> {
  const record: WorkflowNodeExecutionEventRecord = {
    id: genId(),
    execution_id: input.execution_id,
    run_id: input.run_id,
    node_id: input.node_id,
    event_kind: input.event_kind,
    payload_json: input.payload_json,
    created_at: now(),
  };
  await dba.prepare(`
    INSERT INTO workflow_node_execution_events (
      id, execution_id, run_id, node_id, event_kind, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.execution_id,
    record.run_id,
    record.node_id,
    record.event_kind,
    record.payload_json,
    record.created_at,
  );
  return record;
}

export async function listWorkflowNodeExecutionEvents(
  runId: string,
): Promise<WorkflowNodeExecutionEventRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_node_execution_events WHERE run_id = ? ORDER BY created_at`,
  ).all(runId);
  return rows as WorkflowNodeExecutionEventRecord[];
}

export async function listWorkflowDialogueSessions(
  runId: string,
): Promise<WorkflowDialogueSessionRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_dialogue_sessions WHERE run_id = ? ORDER BY created_at, updated_at`,
  ).all(runId);
  return rows as WorkflowDialogueSessionRecord[];
}

export async function listWorkflowMessageFrames(
  runId: string,
): Promise<WorkflowMessageFrameRecord[]> {
  const rows = await dba.prepare(
    `SELECT * FROM workflow_message_frames WHERE run_id = ? ORDER BY created_at`,
  ).all(runId);
  return rows as WorkflowMessageFrameRecord[];
}

export async function createWorkflowFeedbackFrame(input: {
  run_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: 'one_way' | 'two_way';
  content_text: string;
  payload_json?: string;
}): Promise<{
  session: WorkflowDialogueSessionRecord;
  frame: WorkflowMessageFrameRecord;
}> {
  const session = await upsertWorkflowDialogueSession({
    run_id: input.run_id,
    edge_id: input.edge_id,
    direction: input.direction,
    last_source_node_id: input.source_node_id,
    last_target_node_id: input.target_node_id,
  });
  const frame = await insertWorkflowMessageFrame({
    run_id: input.run_id,
    session_id: session.id,
    edge_id: input.edge_id,
    turn_index: session.turn_count,
    frame_type: 'feedback',
    direction: input.direction,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
    content_text: input.content_text,
    payload_json:
      input.payload_json ??
      JSON.stringify({
        edgeId: input.edge_id,
        content: input.content_text,
        frameType: 'feedback',
      }),
  });
  return { session, frame };
}

export async function getWorkflowRunGraph(
  runId: string,
): Promise<WorkflowRunGraph | undefined> {
  const run = await getWorkflowRun(runId);
  if (!run) return undefined;
  const workflow = await getWorkflow(run.workflow_id);
  if (!workflow) return undefined;
  const [
    nodes,
    edges,
    runNodes,
    messages,
    interventions,
    executions,
    executionEvents,
    dialogueSessions,
    messageFrames,
  ] = await Promise.all([
    listWorkflowNodes(workflow.id),
    listWorkflowEdges(workflow.id),
    listWorkflowRunNodes(run.id),
    listWorkflowRunMessages(run.id),
    listWorkflowRunInterventions(run.id),
    listWorkflowNodeExecutions(run.id),
    listWorkflowNodeExecutionEvents(run.id),
    listWorkflowDialogueSessions(run.id),
    listWorkflowMessageFrames(run.id),
  ]);
  return {
    run,
    workflow,
    nodes,
    edges,
    runNodes,
    messages,
    interventions,
    executions,
    executionEvents,
    dialogueSessions,
    messageFrames,
  };
}
