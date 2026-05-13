import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUrlSubPath, navPageToPath } from '../router/paths';
import { useWebSocket } from '../hooks/useWebSocket';
import { WorkflowRepositoryPanel } from '../components/repository/WorkflowRepositoryPanel';
import './WorkteamPage.css';

export interface WorkteamPageProps {
  apiBase: string;
  canManage?: boolean;
  canCreateWorkflow?: boolean;
}

type WorkflowStatus = 'draft' | 'active' | 'archived';
type WorkflowNodeType = 'role' | 'task';
type WorkflowEdgeDirection = 'one_way' | 'two_way';
type WorkflowKind = 'repository' | 'skill' | 'mcp' | 'system_capability' | 'general';
type WorkflowVisibility = 'private' | 'shared' | 'system';
type WorkflowEditorMode = 'legacy' | 'fixed_pipeline_v1';
type WorkflowPipelineNodeKind = 'input' | 'retrieval' | 'analysis' | 'summary';
type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
type WorkflowRunNodeStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'skipped';

interface WorkflowRecord {
  id: string;
  name: string;
  description: string;
  user_id: string;
  status: WorkflowStatus;
  workflow_config: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowConfig {
  kind?: WorkflowKind;
  visibility?: WorkflowVisibility;
  editorMode?: WorkflowEditorMode;
  messageDelayMs?: number;
  artifactPolicy?: {
    exportable?: boolean;
    commitToBranch?: boolean;
    publishTarget?: 'skill' | 'mcp' | 'system';
  };
  repositoryPolicy?: {
    required?: boolean;
    bindingKey?: string;
  };
  publishTarget?: 'skill' | 'mcp' | 'system';
  guardrails?: WorkflowGuardrailsConfig;
  toolPolicy?: WorkflowToolPolicy;
  evaluationPolicy?: {
    enabled?: boolean;
  };
}

interface WorkflowGuardrailsConfig {
  maxDurationMs: number;
  concurrentNodes: number;
  maxNodeRuns: number;
  maxTransfers: number;
  maxToolCalls: number;
  maxExecutionEvents: number;
  maxEstimatedContextCharsPerNode: number;
}

interface WorkflowToolPolicy {
  mode: 'assistant_default' | 'restricted';
  managedSkillIds?: string[];
  userSkillIds?: string[];
  managedMcpServerIds?: string[];
  userMcpServerIds?: string[];
  managedKbIds?: string[];
  providerOverrideId?: string;
  modelOverride?: string;
}

interface WorkflowNodeRecord {
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

interface WorkflowEdgeRecord {
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

interface WorkflowSnapshot {
  workflow: WorkflowRecord;
  nodes: WorkflowNodeRecord[];
  edges: WorkflowEdgeRecord[];
}

interface WorkflowRunRecord {
  id: string;
  workflow_id: string;
  status: WorkflowRunStatus;
  input: string;
  output: string;
  created_at: string;
  started_at: string;
  completed_at: string;
}

interface WorkflowRunNodeRecord {
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

interface WorkflowRunMessageRecord {
  id: string;
  run_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  message_type: string;
  payload_json: string;
  created_at: string;
}

interface WorkflowRunInterventionRecord {
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

interface WorkflowDialogueSessionRecord {
  id: string;
  run_id: string;
  edge_id: string;
  status: 'active' | 'completed' | 'cancelled';
  direction: WorkflowEdgeDirection;
  turn_count: number;
  last_source_node_id: string;
  last_target_node_id: string;
  created_at: string;
  updated_at: string;
}

interface WorkflowMessageFrameRecord {
  id: string;
  run_id: string;
  session_id: string;
  edge_id: string;
  turn_index: number;
  frame_type:
    | 'node_output'
    | 'manual_output_override'
    | 'feedback'
    | 'intervention';
  direction: WorkflowEdgeDirection;
  source_node_id: string;
  target_node_id: string;
  content_text: string;
  payload_json: string;
  created_at: string;
}

interface WorkflowNodeExecutionRecord {
  id: string;
  run_id: string;
  node_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
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

interface WorkflowNodeExecutionEventRecord {
  id: string;
  execution_id: string;
  run_id: string;
  node_id: string;
  event_kind: string;
  payload_json: string;
  created_at: string;
}

interface WorkflowPendingTransferRecord {
  id: string;
  run_id: string;
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  direction: WorkflowEdgeDirection;
  message_type: string;
  status: 'pending' | 'approved' | 'cancelled' | 'sent';
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

interface WorkflowArtifactRecord {
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

interface WorkflowRunMetrics {
  runId: string;
  status: string;
  durationMs: number;
  nodeRuns: number;
  transfers: number;
  toolCalls: number;
  approvals: number;
  executionEvents: number;
  maxEstimatedContextCharsPerNode: number;
  guardrails: WorkflowGuardrailsConfig;
  remaining: {
    durationMs: number;
    nodeRuns: number;
    transfers: number;
    toolCalls: number;
    executionEvents: number;
  };
  breakerReason?: string;
}

interface WorkflowEvaluation {
  runId: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  findings: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    nodeId?: string;
  }>;
  createdAt: string;
}

interface WorkflowExecutionEventView {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  tone:
    | 'neutral'
    | 'progress'
    | 'success'
    | 'warning'
    | 'error'
    | 'reasoning';
}

interface WorkflowRunGraph {
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
}

interface AssistantRecord {
  id: string;
  name: string;
}

interface TaskConfig {
  pipelineNodeKind?: WorkflowPipelineNodeKind;
  assistantId?: string;
  goal?: string;
  prompt?: string;
  expectedOutput?: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
  providerOverrideId?: string;
  modelOverride?: string;
  instructionsAppend?: string;
  allowedDirectories?: string[];
  toolPolicy?: WorkflowToolPolicy;
  handoffPolicy?: {
    maxTurns: number;
    cooldownMs: number;
    exposeToolCalls: false;
  };
}

interface EdgeConfig {
  discussionTurns?: number;
}

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
  activeNodeIds: string[];
  originPositions: Array<{ nodeId: string; x: number; y: number }>;
}

interface SelectionBoxState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface ReconnectState {
  edgeId: string;
  end: 'source' | 'target';
}

interface WorkflowCardSummary {
  workerCount: number;
  edgeCount: number;
  latestRunStatus?: WorkflowRunStatus;
  latestRunAt?: string;
}

interface PipelineNodePresentation {
  kind: WorkflowPipelineNodeKind;
  title: string;
  subtitle: string;
  icon: string;
  accent: string;
  iconAccent: string;
}

const NODE_WIDTH = 236;
const NODE_HEIGHT = 100;
const CANVAS_BASE_WIDTH = 1600;
const CANVAS_BASE_HEIGHT = 1100;
const MIN_CANVAS_ZOOM = 0.45;
const MAX_CANVAS_ZOOM = 1.8;

function parseJsonObject<T>(
  raw: string,
): T {
  try {
    const value = JSON.parse(raw || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {} as T;
    }
    return value as T;
  } catch {
    return {} as T;
  }
}

function parseAssistantListPayload(value: unknown): AssistantRecord[] {
  if (Array.isArray(value)) {
    return value as AssistantRecord[];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const payload = value as { assistants?: unknown; data?: unknown };
  if (Array.isArray(payload.assistants)) {
    return payload.assistants as AssistantRecord[];
  }
  if (Array.isArray(payload.data)) {
    return payload.data as AssistantRecord[];
  }
  return [];
}

function parseWorkflowConfig(raw: string): WorkflowConfig {
  const value = parseJsonObject<WorkflowConfig>(raw);
  const guardrails = (value.guardrails || {}) as Partial<WorkflowGuardrailsConfig>;
  return {
    kind: value.kind || 'general',
    visibility: value.visibility || 'private',
    editorMode:
      value.editorMode === 'fixed_pipeline_v1' ? 'fixed_pipeline_v1' : 'legacy',
    messageDelayMs:
      typeof value.messageDelayMs === 'number' ? value.messageDelayMs : 15000,
    artifactPolicy: {
      exportable: value.artifactPolicy?.exportable !== false,
      commitToBranch: Boolean(value.artifactPolicy?.commitToBranch),
      publishTarget: value.artifactPolicy?.publishTarget,
    },
    repositoryPolicy: value.repositoryPolicy || {},
    publishTarget: value.publishTarget,
    guardrails: {
      maxDurationMs:
        typeof guardrails.maxDurationMs === 'number' ? guardrails.maxDurationMs : 1800000,
      concurrentNodes:
        typeof guardrails.concurrentNodes === 'number' ? guardrails.concurrentNodes : 2,
      maxNodeRuns:
        typeof guardrails.maxNodeRuns === 'number' ? guardrails.maxNodeRuns : 50,
      maxTransfers:
        typeof guardrails.maxTransfers === 'number' ? guardrails.maxTransfers : 100,
      maxToolCalls:
        typeof guardrails.maxToolCalls === 'number' ? guardrails.maxToolCalls : 200,
      maxExecutionEvents:
        typeof guardrails.maxExecutionEvents === 'number'
          ? guardrails.maxExecutionEvents
          : 2000,
      maxEstimatedContextCharsPerNode:
        typeof guardrails.maxEstimatedContextCharsPerNode === 'number'
          ? guardrails.maxEstimatedContextCharsPerNode
          : 60000,
    },
    toolPolicy: {
      mode: value.toolPolicy?.mode === 'restricted' ? 'restricted' : 'assistant_default',
      managedSkillIds: value.toolPolicy?.managedSkillIds || [],
      userSkillIds: value.toolPolicy?.userSkillIds || [],
      managedMcpServerIds: value.toolPolicy?.managedMcpServerIds || [],
      userMcpServerIds: value.toolPolicy?.userMcpServerIds || [],
      managedKbIds: value.toolPolicy?.managedKbIds || [],
      providerOverrideId: value.toolPolicy?.providerOverrideId || '',
      modelOverride: value.toolPolicy?.modelOverride || '',
    },
    evaluationPolicy: {
      enabled: value.evaluationPolicy?.enabled !== false,
    },
  };
}

function parseTaskConfig(node: WorkflowNodeRecord): TaskConfig {
  return parseJsonObject<TaskConfig>(node.config_json);
}

function isFixedPipelineWorkflow(config: WorkflowConfig | null): boolean {
  return config?.editorMode === 'fixed_pipeline_v1';
}

function getPipelineNodeKind(node: WorkflowNodeRecord): WorkflowPipelineNodeKind | null {
  if (node.node_type !== 'task') return null;
  const value = parseTaskConfig(node).pipelineNodeKind;
  return value === 'input' ||
    value === 'retrieval' ||
    value === 'analysis' ||
    value === 'summary'
    ? value
    : null;
}

function getPipelineNodePresentation(
  node: WorkflowNodeRecord,
): PipelineNodePresentation {
  const kind = getPipelineNodeKind(node) || 'analysis';
  switch (kind) {
    case 'input':
      return {
        kind,
        title: '输入',
        subtitle: '接收需求与数据',
        icon: '↓',
        accent: '#22c38e',
        iconAccent: '#16a34a',
      };
    case 'retrieval':
      return {
        kind,
        title: '资料检索',
        subtitle: '检索相关资料与知识库',
        icon: '⌕',
        accent: '#5a93ff',
        iconAccent: '#2563eb',
      };
    case 'summary':
      return {
        kind,
        title: '总结',
        subtitle: '生成结论与建议',
        icon: '▤',
        accent: '#9a72ff',
        iconAccent: '#7c3aed',
      };
    case 'analysis':
    default:
      return {
        kind: 'analysis',
        title: '分析',
        subtitle: '处理并生成分析结果',
        icon: '▥',
        accent: '#ff9f4f',
        iconAccent: '#ea580c',
      };
  }
}

function nextGenericNodeName(nodes: WorkflowNodeRecord[]): string {
  const visibleNodes = nodes.filter((node) => node.node_type === 'task');
  return `节点 ${visibleNodes.length + 1}`;
}

function nextNodePosition(nodes: WorkflowNodeRecord[]): { x: number; y: number } {
  const visibleNodes = nodes.filter((node) => node.node_type === 'task');
  const lastNode = visibleNodes.at(-1);
  if (!lastNode) return { x: 180, y: 180 };
  return {
    x: Math.min(lastNode.position_x + 220, CANVAS_BASE_WIDTH - NODE_WIDTH - 40),
    y: Math.min(lastNode.position_y + 120, CANVAS_BASE_HEIGHT - NODE_HEIGHT - 40),
  };
}

function readErrorTextDefault(status: number): string {
  return `Request failed (${status})`;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // ignore
  }
  return readErrorTextDefault(res.status);
}

function fmt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0s';
  const abs = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function nodeAccent(node: WorkflowNodeRecord): string {
  if (node.node_type === 'role') return '#1d4ed8';
  return '#0f766e';
}

function edgePath(source: WorkflowNodeRecord, target: WorkflowNodeRecord): string {
  const x1 = source.position_x + NODE_WIDTH;
  const y1 = source.position_y + NODE_HEIGHT / 2;
  const x2 = target.position_x;
  const y2 = target.position_y + NODE_HEIGHT / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

function buildTaskLevels(
  nodes: WorkflowNodeRecord[],
  edges: WorkflowEdgeRecord[],
): Map<string, number> {
  const taskNodes = nodes.filter((node) => node.node_type === 'task');
  const taskIds = new Set(taskNodes.map((node) => node.id));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of taskNodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!taskIds.has(edge.source_node_id) || !taskIds.has(edge.target_node_id)) {
      continue;
    }
    indegree.set(
      edge.target_node_id,
      (indegree.get(edge.target_node_id) ?? 0) + 1,
    );
    adjacency.get(edge.source_node_id)?.push(edge.target_node_id);
  }
  const queue = taskNodes
    .map((node) => node.id)
    .filter((nodeId) => (indegree.get(nodeId) ?? 0) === 0);
  const levels = new Map<string, number>();
  taskNodes.forEach((node) => levels.set(node.id, 0));
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const baseLevel = levels.get(nodeId) ?? 0;
    for (const next of adjacency.get(nodeId) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, baseLevel + 1));
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  return levels;
}

function buildAutoLayoutPositions(
  nodes: WorkflowNodeRecord[],
  edges: WorkflowEdgeRecord[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const roleNodes = nodes.filter((node) => node.node_type === 'role');
  const taskNodes = nodes.filter((node) => node.node_type === 'task');
  roleNodes.forEach((node, index) => {
    positions.set(node.id, { x: 60, y: 80 + index * 140 });
  });
  const levels = buildTaskLevels(nodes, edges);
  const levelBuckets = new Map<number, WorkflowNodeRecord[]>();
  for (const node of taskNodes) {
    const level = levels.get(node.id) ?? 0;
    const bucket = levelBuckets.get(level) ?? [];
    bucket.push(node);
    levelBuckets.set(level, bucket);
  }
  for (const [level, bucket] of Array.from(levelBuckets.entries()).sort(
    (a, b) => a[0] - b[0],
  )) {
    bucket
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((node, index) => {
        positions.set(node.id, {
          x: 340 + level * 260,
          y: 80 + index * 140,
        });
      });
  }
  return positions;
}

function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseExecutionEventPayload(
  record: WorkflowNodeExecutionEventRecord,
): WorkflowExecutionEventView {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(record.payload_json) as Record<string, unknown>;
  } catch {
    return {
      id: record.id,
      title: record.event_kind,
      subtitle: fmt(record.created_at),
      body: record.payload_json,
      tone: 'neutral',
    };
  }

  const turnEvent = payload.turnEvent as Record<string, unknown> | undefined;
  const event = payload.event as Record<string, unknown> | undefined;
  const approvalRequest = payload.approvalRequest as Record<string, unknown> | undefined;
  const approvalResolved = payload.approvalResolved as Record<string, unknown> | undefined;
  const askRequest = payload.askRequest as Record<string, unknown> | undefined;
  const askResolved = payload.askResolved as Record<string, unknown> | undefined;
  const streamChunk = typeof payload.streamChunk === 'string' ? payload.streamChunk : '';
  const result = typeof payload.result === 'string' ? payload.result : '';
  const error = typeof payload.error === 'string' ? payload.error : '';

  if (turnEvent?.type === 'turn.started') {
    return {
      id: record.id,
      title: 'Turn Started',
      subtitle: fmt(record.created_at),
      body: typeof turnEvent.turnId === 'string' ? `turnId: ${turnEvent.turnId}` : '',
      tone: 'progress',
    };
  }
  if (turnEvent?.type === 'turn.completed') {
    return {
      id: record.id,
      title: 'Turn Completed',
      subtitle: fmt(record.created_at),
      body: typeof turnEvent.turnId === 'string' ? `turnId: ${turnEvent.turnId}` : '',
      tone: 'success',
    };
  }
  if (turnEvent?.type === 'turn.failed') {
    return {
      id: record.id,
      title: 'Turn Failed',
      subtitle: fmt(record.created_at),
      body: typeof turnEvent.error === 'string' ? turnEvent.error : toPrettyJson(turnEvent),
      tone: 'error',
    };
  }
  if (
    turnEvent?.type === 'item.started' ||
    turnEvent?.type === 'item.updated' ||
    turnEvent?.type === 'item.completed'
  ) {
    const item = turnEvent.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === 'string' ? item.type : 'item';
    if (itemType === 'assistant_message') {
      return {
        id: record.id,
        title: `${turnEvent.type} · assistant_message`,
        subtitle: fmt(record.created_at),
        body: typeof item?.text === 'string' ? item.text : toPrettyJson(item),
        tone: turnEvent.type === 'item.completed' ? 'success' : 'progress',
      };
    }
    if (itemType === 'tool_call') {
      const title =
        typeof item?.title === 'string' ? item.title : 'tool_call';
      const body = [
        typeof item?.argumentsText === 'string' ? `args:\n${item.argumentsText}` : '',
        typeof item?.resultText === 'string' ? `result:\n${item.resultText}` : '',
        typeof item?.errorText === 'string' ? `error:\n${item.errorText}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return {
        id: record.id,
        title: `${turnEvent.type} · ${title}`,
        subtitle: fmt(record.created_at),
        body: body || toPrettyJson(item),
        tone:
          typeof item?.errorText === 'string'
            ? 'error'
            : turnEvent.type === 'item.completed'
              ? 'success'
              : 'progress',
      };
    }
    if (itemType === 'reasoning') {
      return {
        id: record.id,
        title: `${turnEvent.type} · reasoning`,
        subtitle: fmt(record.created_at),
        body:
          typeof item?.text === 'string'
            ? item.text
            : typeof item?.title === 'string'
              ? item.title
              : toPrettyJson(item),
        tone: 'reasoning',
      };
    }
    return {
      id: record.id,
      title: `${turnEvent.type} · ${itemType}`,
      subtitle: fmt(record.created_at),
      body: toPrettyJson(item),
      tone: 'neutral',
    };
  }
  if (approvalRequest) {
    return {
      id: record.id,
      title: `Approval Request · ${String(approvalRequest.toolName || '')}`,
      subtitle: fmt(record.created_at),
      body: typeof approvalRequest.command === 'string'
        ? approvalRequest.command
        : toPrettyJson(approvalRequest),
      tone: 'warning',
    };
  }
  if (approvalResolved) {
    return {
      id: record.id,
      title: `Approval Resolved · ${String(approvalResolved.decision || '')}`,
      subtitle: fmt(record.created_at),
      body: toPrettyJson(approvalResolved),
      tone: 'success',
    };
  }
  if (askRequest) {
    return {
      id: record.id,
      title: 'User Ask Request',
      subtitle: fmt(record.created_at),
      body:
        typeof askRequest.question === 'string'
          ? askRequest.question
          : toPrettyJson(askRequest),
      tone: 'warning',
    };
  }
  if (askResolved) {
    return {
      id: record.id,
      title: 'User Ask Resolved',
      subtitle: fmt(record.created_at),
      body: toPrettyJson(askResolved),
      tone: 'success',
    };
  }
  if (streamChunk) {
    return {
      id: record.id,
      title: 'Stream Chunk',
      subtitle: fmt(record.created_at),
      body: streamChunk,
      tone: 'progress',
    };
  }
  if (result) {
    return {
      id: record.id,
      title: 'Execution Result',
      subtitle: fmt(record.created_at),
      body: result,
      tone: 'success',
    };
  }
  if (error) {
    return {
      id: record.id,
      title: 'Execution Error',
      subtitle: fmt(record.created_at),
      body: error,
      tone: 'error',
    };
  }
  if (event) {
    return {
      id: record.id,
      title: String(event.title || record.event_kind),
      subtitle: fmt(record.created_at),
      body:
        typeof event.body === 'string' ? event.body : toPrettyJson(event),
      tone:
        event.status === 'failed'
          ? 'error'
          : event.status === 'completed'
            ? 'success'
            : 'progress',
    };
  }
  return {
    id: record.id,
    title: record.event_kind,
    subtitle: fmt(record.created_at),
    body: toPrettyJson(payload),
    tone: 'neutral',
  };
}

function displayNodeName(
  nodes: WorkflowNodeRecord[] | undefined,
  nodeId: string,
): string {
  return nodes?.find((node) => node.id === nodeId)?.name || nodeId;
}

function workerNodesFromSnapshot(
  snapshot: WorkflowSnapshot | null,
): WorkflowNodeRecord[] {
  return snapshot?.nodes.filter((node) => node.node_type === 'task') ?? [];
}

function visibleEdgesFromSnapshot(
  snapshot: WorkflowSnapshot | null,
  _config: WorkflowConfig | null = null,
): WorkflowEdgeRecord[] {
  if (!snapshot) return [];
  const visibleNodes = snapshot.nodes.filter((node) => node.node_type === 'task');
  const workerNodeIds = new Set(visibleNodes.map((node) => node.id));
  return snapshot.edges.filter(
    (edge) =>
      workerNodeIds.has(edge.source_node_id) &&
      workerNodeIds.has(edge.target_node_id),
  );
}

function resolveNodeAssistantId(node: WorkflowNodeRecord): string {
  const taskConfig = parseTaskConfig(node);
  return node.assistant_id || taskConfig.assistantId || '';
}

function displayAssistantName(
  assistants: AssistantRecord[],
  assistantId: string,
): string {
  if (!assistantId) return '';
  return assistants.find((assistant) => assistant.id === assistantId)?.name || assistantId;
}

export function WorkteamPage({
  apiBase,
  canManage = true,
  canCreateWorkflow = canManage,
}: WorkteamPageProps) {
  const { t } = useTranslation('workteam');
  const location = useLocation();
  const navigate = useNavigate();
  const routeWorkflowId = getUrlSubPath(location.pathname);
  const [activeWorkflowId, setActiveWorkflowId] = useState(routeWorkflowId);
  const workflowId = activeWorkflowId;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasPanelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectionBoxRef = useRef<SelectionBoxState | null>(null);

  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [workflowSummaries, setWorkflowSummaries] = useState<
    Record<string, WorkflowCardSummary>
  >({});
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [runGraph, setRunGraph] = useState<WorkflowRunGraph | null>(null);
  const [pendingTransfers, setPendingTransfers] = useState<WorkflowPendingTransferRecord[]>([]);
  const [artifacts, setArtifacts] = useState<WorkflowArtifactRecord[]>([]);
  const [runMetrics, setRunMetrics] = useState<WorkflowRunMetrics | null>(null);
  const [runEvaluation, setRunEvaluation] = useState<WorkflowEvaluation | null>(null);
  const [assistants, setAssistants] = useState<AssistantRecord[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>('');
  const [connectFromNodeId, setConnectFromNodeId] = useState<string>('');
  const [selectionBox, setSelectionBox] = useState<SelectionBoxState | null>(null);
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(
    null,
  );
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [newWorkflowDesc, setNewWorkflowDesc] = useState('');
  const [activeModal, setActiveModal] = useState<
    'create' | 'settings' | 'repository' | null
  >(null);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [runInput, setRunInput] = useState('');
  const [runPanelExpanded, setRunPanelExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadWorkflows = useCallback(async () => {
    const res = await fetch(`${apiBase}/api/workflows`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    setWorkflows((await res.json()) as WorkflowRecord[]);
  }, [apiBase]);

  const loadSnapshot = useCallback(async () => {
    if (!workflowId) {
      setSnapshot(null);
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/${workflowId}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    setSnapshot((await res.json()) as WorkflowSnapshot);
  }, [apiBase, workflowId]);

  const loadRuns = useCallback(async () => {
    if (!workflowId) {
      setRuns([]);
      setSelectedRunId('');
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/${workflowId}/runs`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    const list = (await res.json()) as WorkflowRunRecord[];
    setRuns(list);
    if (list.length === 0) {
      setSelectedRunId('');
    } else if (!selectedRunId || !list.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(list[0].id);
    }
  }, [apiBase, workflowId, selectedRunId]);

  const loadRunGraph = useCallback(async () => {
    if (!selectedRunId) {
      setRunGraph(null);
      setPendingTransfers([]);
      setArtifacts([]);
      setRunMetrics(null);
      setRunEvaluation(null);
      return;
    }
    const [graphRes, metricsRes, evaluationRes] = await Promise.all([
      fetch(`${apiBase}/api/workflows/run/${selectedRunId}/graph`, {
        credentials: 'include',
      }),
      fetch(`${apiBase}/api/workflows/run/${selectedRunId}/metrics`, {
        credentials: 'include',
      }),
      fetch(`${apiBase}/api/workflows/run/${selectedRunId}/evaluation`, {
        credentials: 'include',
      }),
    ]);
    if (!graphRes.ok) throw new Error(await readError(graphRes));
    const graph = (await graphRes.json()) as WorkflowRunGraph;
    setRunGraph(graph);
    setPendingTransfers(graph.pendingTransfers || []);
    setArtifacts(graph.artifacts || []);
    setRunMetrics(metricsRes.ok ? ((await metricsRes.json()) as WorkflowRunMetrics) : null);
    setRunEvaluation(
      evaluationRes.ok ? ((await evaluationRes.json()) as WorkflowEvaluation | null) : null,
    );
  }, [apiBase, selectedRunId]);

  const loadTransfers = useCallback(async () => {
    if (!selectedRunId) {
      setPendingTransfers([]);
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/transfers`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    setPendingTransfers((await res.json()) as WorkflowPendingTransferRecord[]);
  }, [apiBase, selectedRunId]);

  const loadArtifacts = useCallback(async () => {
    if (!selectedRunId) {
      setArtifacts([]);
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/artifacts`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    setArtifacts((await res.json()) as WorkflowArtifactRecord[]);
  }, [apiBase, selectedRunId]);

  const loadAssistants = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/assistants`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const payload = await res.json();
      setAssistants(parseAssistantListPayload(payload));
    } catch {
      setAssistants([]);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadWorkflows().catch((err) => setError(String(err)));
    void loadAssistants();
  }, [loadWorkflows, loadAssistants]);

  useEffect(() => {
    if (workflows.length === 0) {
      setWorkflowSummaries({});
      return;
    }
    let cancelled = false;
    const loadSummaries = async () => {
      const entries = await Promise.all(
        workflows.map(async (workflow) => {
          try {
            const [snapshotRes, runsRes] = await Promise.all([
              fetch(`${apiBase}/api/workflows/${workflow.id}`, {
                credentials: 'include',
              }),
              fetch(`${apiBase}/api/workflows/${workflow.id}/runs`, {
                credentials: 'include',
              }),
            ]);
            let workerCount = 0;
            let edgeCount = 0;
            let latestRunStatus: WorkflowRunStatus | undefined;
            let latestRunAt: string | undefined;
            if (snapshotRes.ok) {
              const workflowSnapshot =
                (await snapshotRes.json()) as WorkflowSnapshot;
              workerCount = workerNodesFromSnapshot(workflowSnapshot).length;
              edgeCount = visibleEdgesFromSnapshot(workflowSnapshot).length;
            }
            if (runsRes.ok) {
              const workflowRuns = (await runsRes.json()) as WorkflowRunRecord[];
              const latestRun = workflowRuns[0];
              latestRunStatus = latestRun?.status;
              latestRunAt = latestRun?.created_at;
            }
            return [
              workflow.id,
              { workerCount, edgeCount, latestRunStatus, latestRunAt },
            ] as const;
          } catch {
            return [
              workflow.id,
              { workerCount: 0, edgeCount: 0 },
            ] as const;
          }
        }),
      );
      if (!cancelled) {
        setWorkflowSummaries(Object.fromEntries(entries));
      }
    };
    void loadSummaries();
    return () => {
      cancelled = true;
    };
  }, [apiBase, workflows]);

  useEffect(() => {
    if (routeWorkflowId) setActiveWorkflowId(routeWorkflowId);
  }, [routeWorkflowId]);

  useEffect(() => {
    setSelectedRunId('');
    setSelectedNodeId('');
    setSelectedNodeIds([]);
    setSelectedEdgeId('');
    setConnectFromNodeId('');
    setReconnectState(null);
    setRunGraph(null);
    setPendingTransfers([]);
    setArtifacts([]);
    void loadSnapshot().catch((err) => setError(String(err)));
    void loadRuns().catch((err) => setError(String(err)));
  }, [loadSnapshot, loadRuns, workflowId]);

  useEffect(() => {
    void loadRunGraph().catch((err) => setError(String(err)));
  }, [loadRunGraph]);

  const selectedNode = useMemo(
    () => snapshot?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [snapshot, selectedNodeId],
  );
  const selectedEdge = useMemo(
    () => snapshot?.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [snapshot, selectedEdgeId],
  );
  const selectedRunNode = useMemo(() => {
    if (!runGraph || !selectedNodeId) return null;
    return runGraph.runNodes.find((item) => item.node_id === selectedNodeId) ?? null;
  }, [runGraph, selectedNodeId]);

  const selectedNodeExecutions = useMemo(() => {
    if (!runGraph || !selectedNodeId) return [];
    return runGraph.executions.filter((item) => item.node_id === selectedNodeId);
  }, [runGraph, selectedNodeId]);

  const selectedNodeExecutionEvents = useMemo(() => {
    if (!runGraph || !selectedNodeId) return [];
    const executionIds = new Set(
      runGraph.executions
        .filter((item) => item.node_id === selectedNodeId)
        .map((item) => item.id),
    );
    return runGraph.executionEvents.filter((event) =>
      executionIds.has(event.execution_id),
    );
  }, [runGraph, selectedNodeId]);

  const executionEventViews = useMemo(
    () => selectedNodeExecutionEvents.map((event) => parseExecutionEventPayload(event)),
    [selectedNodeExecutionEvents],
  );

  const runNodeStatusMap = useMemo(() => {
    const map = new Map<string, WorkflowRunNodeRecord>();
    runGraph?.runNodes.forEach((item) => map.set(item.node_id, item));
    return map;
  }, [runGraph]);

  const onRealtimeMessage = useCallback(
    (data: Record<string, unknown>) => {
      if (
        (data.kind !== 'workflow_event' && data.type !== 'workflow_event') ||
        typeof data.runId !== 'string'
      ) {
        return;
      }
      if (selectedRunId && data.runId === selectedRunId) {
        void loadRunGraph().catch(() => {});
        void loadRuns().catch(() => {});
      }
    },
    [loadRunGraph, loadRuns, selectedRunId],
  );
  const { subscribeAll } = useWebSocket(onRealtimeMessage);

  useEffect(() => {
    if (!selectedRunId) return;
    subscribeAll([`workflow:${selectedRunId}`]);
  }, [selectedRunId, subscribeAll]);

  const currentWorkflowConfig = useMemo(
    () => (snapshot ? parseWorkflowConfig(snapshot.workflow.workflow_config) : null),
    [snapshot],
  );

  const visibleWorkerNodes = useMemo(
    () => workerNodesFromSnapshot(snapshot),
    [snapshot],
  );

  const visibleWorkflowEdges = useMemo(
    () => visibleEdgesFromSnapshot(snapshot, currentWorkflowConfig),
    [currentWorkflowConfig, snapshot],
  );

  const isFixedPipeline = isFixedPipelineWorkflow(currentWorkflowConfig);
  const isLegacyReadOnly = Boolean(snapshot) && !isFixedPipeline;

  const filteredWorkflows = workflows;

  useEffect(() => {
    if (!snapshot || visibleWorkerNodes.length === 0) return;
    if (
      selectedNodeId &&
      visibleWorkerNodes.some((node) => node.id === selectedNodeId)
    ) {
      return;
    }
    setSelectedNodeId(visibleWorkerNodes[0]?.id || '');
    setSelectedNodeIds(visibleWorkerNodes[0] ? [visibleWorkerNodes[0].id] : []);
    setSelectedEdgeId('');
  }, [snapshot, selectedNodeId, visibleWorkerNodes]);

  const setSnapshotNode = useCallback(
    (nodeId: string, patch: Partial<WorkflowNodeRecord>) => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          nodes: prev.nodes.map((node) =>
            node.id === nodeId ? { ...node, ...patch } : node,
          ),
        };
      });
    },
    [],
  );

  const toCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / canvasZoom,
        y: (clientY - rect.top) / canvasZoom,
      };
    },
    [canvasZoom],
  );

  const setClampedCanvasZoom = useCallback((nextZoom: number) => {
    setCanvasZoom(
      Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, nextZoom)),
    );
  }, []);

  const fitCanvasToView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || visibleWorkerNodes.length === 0) {
      setClampedCanvasZoom(1);
      return;
    }
    const maxX = Math.max(
      ...visibleWorkerNodes.map((node) => node.position_x + NODE_WIDTH + 120),
    );
    const maxY = Math.max(
      ...visibleWorkerNodes.map((node) => node.position_y + NODE_HEIGHT + 120),
    );
    const nextZoom = Math.min(
      (canvas.clientWidth - 48) / Math.max(maxX, 640),
      (canvas.clientHeight - 48) / Math.max(maxY, 420),
      1.2,
    );
    setClampedCanvasZoom(nextZoom);
    canvas.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  }, [setClampedCanvasZoom, visibleWorkerNodes]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      const canvas = canvasRef.current;
      if (drag && canvas) {
        const point = toCanvasPoint(event.clientX, event.clientY);
        const nextX = Math.max(16, point.x - drag.offsetX);
        const nextY = Math.max(16, point.y - drag.offsetY);
        const anchor = drag.originPositions.find(
          (item) => item.nodeId === drag.nodeId,
        );
        if (!anchor) return;
        const deltaX = nextX - anchor.x;
        const deltaY = nextY - anchor.y;
        for (const origin of drag.originPositions) {
          setSnapshotNode(origin.nodeId, {
            position_x: Math.max(16, origin.x + deltaX),
            position_y: Math.max(16, origin.y + deltaY),
          });
        }
        return;
      }
      const box = selectionBoxRef.current;
      if (!box || !canvas) return;
      const point = toCanvasPoint(event.clientX, event.clientY);
      const nextBox = {
        ...box,
        currentX: point.x,
        currentY: point.y,
      };
      selectionBoxRef.current = nextBox;
      setSelectionBox(nextBox);
    };
    const onUp = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag && snapshot) {
        const movedNodes = snapshot.nodes.filter((item) =>
          drag.activeNodeIds.includes(item.id),
        );
        void Promise.all(
          movedNodes.map((node) =>
            fetch(`${apiBase}/api/workflows/${workflowId}/nodes/${node.id}`, {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                position_x: node.position_x,
                position_y: node.position_y,
              }),
            }),
          ),
        ).catch(() => {});
      }
      const box = selectionBoxRef.current;
      selectionBoxRef.current = null;
      if (!box || !snapshot) {
        setSelectionBox(null);
        return;
      }
      setSelectionBox(null);
      const minX = Math.min(box.startX, box.currentX);
      const minY = Math.min(box.startY, box.currentY);
      const maxX = Math.max(box.startX, box.currentX);
      const maxY = Math.max(box.startY, box.currentY);
      const picked = visibleWorkerNodes
        .filter((node) => {
          const left = node.position_x;
          const right = node.position_x + NODE_WIDTH;
          const top = node.position_y;
          const bottom = node.position_y + NODE_HEIGHT;
          return right >= minX && left <= maxX && bottom >= minY && top <= maxY;
        })
        .map((node) => node.id);
      if (picked.length > 0) {
        setSelectedNodeIds(picked);
        setSelectedNodeId(picked[0] ?? '');
        setSelectedEdgeId('');
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [
    apiBase,
    workflowId,
    snapshot,
    setSnapshotNode,
    toCanvasPoint,
    visibleWorkerNodes,
  ]);

  const applyAutoLayout = async () => {
    if (!workflowId || !snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const positions = buildAutoLayoutPositions(snapshot.nodes, snapshot.edges);
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              nodes: prev.nodes.map((node) => {
                const next = positions.get(node.id);
                return next
                  ? {
                      ...node,
                      position_x: next.x,
                      position_y: next.y,
                    }
                  : node;
              }),
            }
          : prev,
      );
      await Promise.all(
        snapshot.nodes.map((node) => {
          const next = positions.get(node.id);
          return fetch(`${apiBase}/api/workflows/${workflowId}/nodes/${node.id}`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              position_x: next?.x ?? node.position_x,
              position_y: next?.y ?? node.position_y,
            }),
          });
        }),
      );
      await loadSnapshot();
      setInfo(t('workteam.已自动排版'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createWorkflow = async () => {
    if (!newWorkflowName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newWorkflowName.trim(),
          description: newWorkflowDesc.trim(),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const created = (await res.json()) as WorkflowRecord;
      setNewWorkflowName('');
      setNewWorkflowDesc('');
      setActiveModal(null);
      await loadWorkflows();
      setActiveWorkflowId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateNode = async (nodeId: string, body: Record<string, unknown>) => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes/${nodeId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadSnapshot();
      if (selectedRunId) await loadRunGraph();
      setInfo(t('workteam.节点已保存'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteNode = async (nodeId: string) => {
    if (!workflowId) return;
    if (!window.confirm(t('workteam.删除该节点及相关连线'))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes/${nodeId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      setSelectedNodeId('');
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createEdge = async (
    sourceNodeId: string,
    targetNodeId: string,
    direction: WorkflowEdgeDirection = 'one_way',
  ) => {
    if (!workflowId || sourceNodeId === targetNodeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/edges`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          direction,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setConnectFromNodeId('');
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateEdge = async (edgeId: string, body: Record<string, unknown>) => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/edges/${edgeId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteEdge = async (edgeId: string) => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/edges/${edgeId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      setSelectedEdgeId('');
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const validateWorkflow = async () => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/validate`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { valid: boolean; errors: string[] };
      if (data.valid) setInfo(t('workteam.工作流校验通过'));
      else setError(data.errors.join('；') || t('workteam.工作流校验失败'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/run`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: runInput }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const run = (await res.json()) as WorkflowRunRecord;
      setSelectedRunId(run.id);
      await loadRuns();
      await loadRunGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runControl = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/${action}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadRuns();
      await loadRunGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const nodeRunAction = async (
    nodeId: string,
    action: 'pause' | 'resume' | 'retry',
  ) => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/nodes/${nodeId}/${action}`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadRunGraph();
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveRunNodeField = async (
    nodeId: string,
    field: 'input' | 'output',
    value: string,
  ) => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/nodes/${nodeId}/${field}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadRunGraph();
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const workflowStats = useMemo(() => {
    if (!snapshot) return null;
    return {
      workers: visibleWorkerNodes.length,
      edges: visibleWorkflowEdges.length,
    };
  }, [snapshot, visibleWorkerNodes.length, visibleWorkflowEdges.length]);

  const saveCurrentWorkflow = useCallback(
    async (nextStatus?: WorkflowStatus) => {
      if (!workflowId || !snapshot) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/api/workflows/${workflowId}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: snapshot.workflow.name,
            description: snapshot.workflow.description,
            workflow_config: parseWorkflowConfig(snapshot.workflow.workflow_config),
            ...(nextStatus ? { status: nextStatus } : {}),
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
        await loadWorkflows();
        await loadSnapshot();
      setInfo(
        nextStatus === 'active'
          ? t('workteam.工作流已发布')
          : t('workteam.工作流已保存'),
      );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [apiBase, loadSnapshot, loadWorkflows, snapshot, workflowId],
  );


  const mutateTransfer = async (
    transferId: string,
    action: 'approve' | 'cancel' | 'release-now',
  ) => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/transfers/${transferId}/${action}`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadTransfers();
      await loadRunGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const editTransfer = async (transfer: WorkflowPendingTransferRecord) => {
    if (!selectedRunId) return;
    const next = window.prompt(t('workteam.编辑待发送消息'), transfer.content_text);
    if (next == null || !next.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/transfers/${transfer.id}/edit`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: next.trim() }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadTransfers();
      await loadRunGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportRun = async () => {
    if (!selectedRunId) return;
    window.open(`${apiBase}/api/workflows/run/${selectedRunId}/export`, '_blank');
  };

  const commitAndPushRun = async () => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/commit-and-push`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      const payload = (await res.json()) as { ok?: boolean; artifact?: WorkflowArtifactRecord };
      await loadArtifacts();
      setInfo(payload.ok ? t('workteam.工作流产物已提交推送') : t('workteam.工作流产物已生成但推送失败'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const publishRunArtifact = async () => {
    if (!selectedRunId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/publish`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadArtifacts();
      setInfo(t('workteam.工作流产物已发布'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startReconnect = useCallback(
    (edgeId: string, end: 'source' | 'target') => {
      setReconnectState({ edgeId, end });
      setConnectFromNodeId('');
      setSelectedNodeIds([]);
      setInfo(end === 'source' ? t('workteam.请选择新的起点节点') : t('workteam.请选择新的终点节点'));
    },
    [],
  );

  const updateWorkflowConfig = (patch: Partial<WorkflowConfig>) => {
    if (!snapshot) return;
    const current = parseWorkflowConfig(snapshot.workflow.workflow_config);
    const next = {
      ...current,
      ...patch,
      artifactPolicy: {
        ...current.artifactPolicy,
        ...patch.artifactPolicy,
      },
      repositoryPolicy: {
        ...current.repositoryPolicy,
        ...patch.repositoryPolicy,
      },
    };
    setSnapshot({
      ...snapshot,
      workflow: {
        ...snapshot.workflow,
        workflow_config: JSON.stringify(next),
      },
    });
  };

  const returnToWorkflowList = useCallback(() => {
    setActiveWorkflowId('');
    navigate(navPageToPath('workteam'));
  }, [navigate]);

  const deleteWorkflow = useCallback(async () => {
    if (!workflowId || !snapshot) return;
    if (!window.confirm(t('workteam.删除该工作流'))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadWorkflows();
      setSnapshot(null);
      setRuns([]);
      setSelectedRunId('');
      setRunGraph(null);
      setSelectedNodeId('');
      setSelectedNodeIds([]);
      setSelectedEdgeId('');
      returnToWorkflowList();
      setInfo(t('workteam.工作流已删除'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadWorkflows, returnToWorkflowList, snapshot, t, workflowId]);

  const createNode = useCallback(async () => {
    if (!workflowId || !snapshot) return;
    const position = nextNodePosition(snapshot.nodes);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'task',
          name: nextGenericNodeName(snapshot.nodes),
          description: '',
          position_x: position.x,
          position_y: position.y,
          config_json: {},
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const node = (await res.json()) as WorkflowNodeRecord;
      await loadSnapshot();
      setSelectedNodeId(node.id);
      setSelectedNodeIds([node.id]);
      setSelectedEdgeId('');
      setInfo(t('workteam.节点已创建'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [apiBase, loadSnapshot, snapshot, t, workflowId]);

  return (
    <div
      className={`page-view workflow-page ${
        snapshot ? 'is-workspace' : 'is-library'
      }`}
    >
      <div className="workflow-topbar">
        <div className="workflow-topbar-title">
          <div className="workflow-title-stack">
            <h2>{t('pageTitle')}</h2>
            <span>{t('workteam.连接节点构建自动化流程')}</span>
          </div>
        </div>
        <div className="workflow-topbar-controls">
          {!snapshot ? (
            <button
              type="button"
              className="btn-primary"
              disabled={!canCreateWorkflow || busy}
              onClick={() => setActiveModal('create')}
            >
              {t('workteam.新建')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-outline"
                onClick={returnToWorkflowList}
                disabled={busy}
              >
                {t('workteam.返回工作流')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setRunPanelExpanded(true);
                  void startRun();
                }}
                disabled={!workflowId || busy || !canManage}
              >
                {t('workteam.运行')}
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => void saveCurrentWorkflow()}
                disabled={!workflowId || !snapshot || busy || !canManage}
              >
                {t('workteam.保存')}
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => setActiveModal('settings')}
                disabled={!workflowId || !snapshot}
              >
                {t('workteam.配置')}
              </button>
              <button
                type="button"
                className="btn-outline danger"
                onClick={() => void deleteWorkflow()}
                disabled={!workflowId || !snapshot || busy || !canManage}
              >
                {t('workteam.删除')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="page-body workflow-body">
        {error ? <div className="workflow-banner error">{error}</div> : null}
        {info ? <div className="workflow-banner info">{info}</div> : null}

        {!snapshot ? (
          <section className="workflow-library">
            <div className="workflow-library-header">
              <span>{filteredWorkflows.length} {t('workteam.个工作流')}</span>
            </div>
            <div className="workflow-card-grid">
              {filteredWorkflows.map((workflow) => {
                const config = parseWorkflowConfig(workflow.workflow_config);
                const summary = workflowSummaries[workflow.id];
                return (
                  <article key={workflow.id} className="workflow-library-card">
                    <button
                      type="button"
                      className="workflow-card-open"
                      onClick={() => setActiveWorkflowId(workflow.id)}
                    >
                      <span className={`workflow-card-status is-${workflow.status}`}>
                        {workflow.status}
                      </span>
                      <strong>{workflow.name}</strong>
                      <span>{workflow.description || t('workteam.无描述')}</span>
                      <div className="workflow-card-meta">
                        <span>
                          {summary?.workerCount ?? 0} {t('workteam.节点')}
                        </span>
                        <span>
                          {summary?.edgeCount ?? 0} {t('workteam.连线')}
                        </span>
                        <span>{config.visibility}</span>
                        <span>
                          {summary?.latestRunStatus
                            ? `${summary.latestRunStatus}${
                                summary.latestRunAt
                                  ? ` · ${fmt(summary.latestRunAt)}`
                                  : ''
                              }`
                            : t('workteam.未运行')}
                        </span>
                      </div>
                    </button>
                    {canManage ? (
                      <button
                        type="button"
                        className="workflow-card-delete"
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (!window.confirm(t('workteam.删除该工作流'))) return;
                          setBusy(true);
                          setError(null);
                          try {
                            const res = await fetch(`${apiBase}/api/workflows/${workflow.id}`, {
                              method: 'DELETE',
                              credentials: 'include',
                            });
                            if (!res.ok) throw new Error(await readError(res));
                            await loadWorkflows();
                            setInfo(t('workteam.工作流已删除'));
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setBusy(false);
                          }
                        }}
                        disabled={busy}
                        aria-label={t('workteam.删除')}
                      >
                        {t('workteam.删除')}
                      </button>
                    ) : null}
                  </article>
                );
              })}
              {filteredWorkflows.length === 0 ? (
                <div className="workflow-empty">
                  <div className="workflow-empty-copy">
                    <h3>{t('workteam.先选择或创建一个工作流')}</h3>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="workflow-workbench">
            {isLegacyReadOnly ? (
              <div className="workflow-banner info">
                {t('workteam.旧版工作流只读提示')}
              </div>
            ) : null}
            <div className="workflow-workbench-grid">
              <section className="workflow-canvas-panel" ref={canvasPanelRef}>
                <div className="workflow-canvas-toolbar">
                  <div className="workflow-canvas-status">
                    <span className="workflow-metric-chip">
                      {workflowStats?.workers ?? 0} {t('workteam.节点')} /{' '}
                      {workflowStats?.edges ?? 0} {t('workteam.连线')}
                    </span>
                    {connectFromNodeId ? (
                      <span>{t('workteam.请选择要连接的目标节点')}</span>
                    ) : reconnectState ? (
                      <span>
                        {reconnectState.end === 'source'
                          ? t('workteam.请选择新的起点节点')
                          : t('workteam.请选择新的终点节点')}
                      </span>
                    ) : (
                      <span>{snapshot.workflow.name}</span>
                    )}
                  </div>
                  <div className="workflow-canvas-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => void createNode()}
                      disabled={!canManage || busy}
                    >
                      {t('workteam.新增节点')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => void applyAutoLayout()}
                      disabled={!canManage || busy}
                    >
                      {t('workteam.自动排版')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => void validateWorkflow()}
                      disabled={!canManage || busy}
                    >
                      {t('workteam.校验图')}
                    </button>
                  </div>
                </div>
                <div
                  ref={canvasRef}
                  className="workflow-canvas"
                  onMouseDown={(event) => {
                    const target = event.target as HTMLElement;
                    if (
                      event.target !== event.currentTarget &&
                      !target.classList.contains('workflow-canvas-stage')
                    ) {
                      return;
                    }
                    const point = toCanvasPoint(event.clientX, event.clientY);
                    const nextBox = {
                      startX: point.x,
                      startY: point.y,
                      currentX: point.x,
                      currentY: point.y,
                    };
                    selectionBoxRef.current = nextBox;
                    setSelectionBox(nextBox);
                  }}
                >
                  <div
                    className="workflow-canvas-stage"
                    style={{
                      width: CANVAS_BASE_WIDTH,
                      height: CANVAS_BASE_HEIGHT,
                      transform: `scale(${canvasZoom})`,
                    }}
                  >
                  <svg className="workflow-edge-layer">
                    <defs>
                      <marker
                        id="workflow-arrow"
                        markerWidth="8"
                        markerHeight="8"
                        refX="6"
                        refY="4"
                        orient="auto"
                      >
                        <path d="M0,0 L8,4 L0,8 z" fill="#64748b" />
                      </marker>
                    </defs>
                    {visibleWorkflowEdges.map((edge) => {
                      const source = visibleWorkerNodes.find(
                        (node) => node.id === edge.source_node_id,
                      );
                      const target = visibleWorkerNodes.find(
                        (node) => node.id === edge.target_node_id,
                      );
                      if (!source || !target) return null;
                      const active = edge.id === selectedEdgeId;
                      return (
                        <g
                          key={edge.id}
                          className="workflow-edge-hitbox"
                          onClick={() => {
                            setSelectedEdgeId(edge.id);
                            setSelectedNodeId('');
                            setSelectedNodeIds([]);
                          }}
                        >
                          <path
                            d={edgePath(source, target)}
                            className={`workflow-edge ${active ? 'selected' : ''}`}
                            markerEnd="url(#workflow-arrow)"
                          />
                          {edge.direction === 'two_way' ? (
                            <path
                              d={edgePath(target, source)}
                              className={`workflow-edge back ${
                                active ? 'selected' : ''
                              }`}
                              markerEnd="url(#workflow-arrow)"
                            />
                          ) : null}
                        </g>
                      );
                    })}
                  </svg>

                  {visibleWorkerNodes.map((node) => {
                    const runState = runNodeStatusMap.get(node.id);
                    const assistantName = displayAssistantName(
                      assistants,
                      resolveNodeAssistantId(node),
                    );
                    const pipelineView = getPipelineNodePresentation(node);
                    return (
                      <button
                        key={node.id}
                        type="button"
                        className={`workflow-node node-worker${
                          selectedNodeIds.includes(node.id)
                            ? ' is-multi-selected'
                            : ''
                        }${selectedNodeId === node.id ? ' selected' : ''}`}
                        style={{
                          left: node.position_x,
                          top: node.position_y,
                          borderColor: pipelineView.accent || nodeAccent(node),
                        }}
                        onMouseDown={(event) => {
                          if (reconnectState || connectFromNodeId) return;
                          const nextSelectedIds = selectedNodeIds.includes(node.id)
                            ? selectedNodeIds
                            : [node.id];
                          setSelectedNodeIds(nextSelectedIds);
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId('');
                          const point = toCanvasPoint(event.clientX, event.clientY);
                          dragRef.current = {
                            nodeId: node.id,
                            offsetX: point.x - node.position_x,
                            offsetY: point.y - node.position_y,
                            activeNodeIds: nextSelectedIds,
                            originPositions: snapshot.nodes
                              .filter((item) => nextSelectedIds.includes(item.id))
                              .map((item) => ({
                                nodeId: item.id,
                                x: item.position_x,
                                y: item.position_y,
                              })),
                          };
                        }}
                        onClick={(event) => {
                          if (reconnectState) {
                            void updateEdge(reconnectState.edgeId, {
                              [reconnectState.end === 'source'
                                ? 'source_node_id'
                                : 'target_node_id']: node.id,
                            }).then(() => {
                              setReconnectState(null);
                              setInfo(t('workteam.连线端点已更新'));
                            });
                            return;
                          }
                          if (connectFromNodeId && connectFromNodeId !== node.id) {
                            void createEdge(connectFromNodeId, node.id);
                            return;
                          }
                          if (event.shiftKey) {
                            setSelectedNodeIds((prev) =>
                              prev.includes(node.id)
                                ? prev.filter((item) => item !== node.id)
                                : [...prev, node.id],
                            );
                          } else {
                            setSelectedNodeIds([node.id]);
                          }
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId('');
                        }}
                      >
                        <>
                          <span
                            className="workflow-node-icon"
                            style={{
                              color: pipelineView.iconAccent,
                              background: `${pipelineView.accent}1f`,
                            }}
                          >
                            {pipelineView.icon}
                          </span>
                          <strong>{node.name}</strong>
                          <span className="workflow-node-meta">
                            {node.description || pipelineView.subtitle}
                          </span>
                          <span className="workflow-node-provider-name">
                            {assistantName || t('workteam.未绑定专家助手')}
                          </span>
                        </>
                        {runState ? (
                          <span className={`workflow-run-state is-${runState.status}`}>
                            {runState.status}
                          </span>
                        ) : null}
                        <span className="workflow-node-actions-inline">
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              setConnectFromNodeId(node.id);
                            }}
                            onKeyDown={() => {}}
                          >
                            {t('workteam.连接')}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {selectionBox ? (
                    <div
                      className="workflow-selection-box"
                      style={{
                        left: Math.min(selectionBox.startX, selectionBox.currentX),
                        top: Math.min(selectionBox.startY, selectionBox.currentY),
                        width: Math.abs(selectionBox.currentX - selectionBox.startX),
                        height: Math.abs(selectionBox.currentY - selectionBox.startY),
                      }}
                    />
                  ) : null}
                  </div>
                  <div className="workflow-canvas-floating-controls">
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => setClampedCanvasZoom(canvasZoom - 0.1)}
                    >
                      -
                    </button>
                    <span className="workflow-zoom-label">
                      {Math.round(canvasZoom * 100)}%
                    </span>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => setClampedCanvasZoom(canvasZoom + 0.1)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={fitCanvasToView}
                    >
                      {t('workteam.适配视图')}
                    </button>
                  </div>
                </div>
              </section>

              <aside className="workflow-detail-grid">
                <div className="workflow-inspector">
                  <h3>{t('workteam.节点属性')}</h3>
                  {selectedNode ? (
                    <NodeInspector
                      key={selectedNode.id}
                      node={selectedNode}
                      assistants={assistants}
                      runNode={selectedRunNode}
                      canManage={canManage}
                      busy={busy}
                      onSave={(body) => void updateNode(selectedNode.id, body)}
                      onDelete={() => void deleteNode(selectedNode.id)}
                      onPauseNode={
                        selectedRunNode
                          ? () => void nodeRunAction(selectedNode.id, 'pause')
                          : undefined
                      }
                      onResumeNode={
                        selectedRunNode
                          ? () => void nodeRunAction(selectedNode.id, 'resume')
                          : undefined
                      }
                      onRetryNode={
                        selectedRunNode
                          ? () => void nodeRunAction(selectedNode.id, 'retry')
                          : undefined
                      }
                      onSaveRunInput={(value) =>
                        void saveRunNodeField(selectedNode.id, 'input', value)
                      }
                      onSaveRunOutput={(value) =>
                        void saveRunNodeField(selectedNode.id, 'output', value)
                      }
                    />
                  ) : selectedEdge ? (
                    <EdgeInspector
                      edge={selectedEdge}
                      nodes={visibleWorkerNodes}
                      canManage={canManage}
                      busy={busy}
                      onSave={(body) => void updateEdge(selectedEdge.id, body)}
                      onDelete={() => void deleteEdge(selectedEdge.id)}
                      onReconnectStart={() =>
                        startReconnect(selectedEdge.id, 'source')
                      }
                      onReconnectEnd={() =>
                        startReconnect(selectedEdge.id, 'target')
                      }
                    />
                  ) : (
                    <div className="workflow-inspector-empty">
                      {t('workteam.选择一个节点或连线开始编辑')}
                    </div>
                  )}
                </div>
              </aside>
            </div>

            <section
              className={`workflow-run-dock${
                runPanelExpanded ? ' is-expanded' : ''
              }`}
            >
              <button
                type="button"
                className="workflow-run-dock-header"
                onClick={() => setRunPanelExpanded((prev) => !prev)}
                aria-expanded={runPanelExpanded}
              >
                <span>{t('workteam.运行记录')}</span>
                <strong>{runs.length}</strong>
                <span>{runPanelExpanded ? '⌄' : '›'}</span>
              </button>
              {runPanelExpanded ? (
                <div className="workflow-run-dock-body">
                  <section className="workflow-settings-card">
                    <h3>{t('workteam.启动运行')}</h3>
                    <textarea
                      value={runInput}
                      onChange={(event) => setRunInput(event.target.value)}
                      placeholder={t('workteam.输入整张图的全局上下文')}
                    />
                    <div className="workflow-run-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!workflowId || !canManage || busy}
                        onClick={() => void startRun()}
                      >
                        {t('workteam.启动运行')}
                      </button>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={!selectedRunId || busy || !canManage}
                        onClick={() => void runControl('pause')}
                      >
                        {t('workteam.暂停整图')}
                      </button>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={!selectedRunId || busy || !canManage}
                        onClick={() => void runControl('resume')}
                      >
                        {t('workteam.继续整图')}
                      </button>
                      <button
                        type="button"
                        className="btn-outline btn-sm"
                        disabled={!selectedRunId || busy || !canManage}
                        onClick={() => void runControl('cancel')}
                      >
                        {t('workteam.取消整图')}
                      </button>
                    </div>
                  </section>

                  <section className="workflow-settings-card">
                    <h3>{t('workteam.运行列表')}</h3>
                    <div className="workflow-run-list">
                      {runs.map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={`workflow-run-card${
                            run.id === selectedRunId ? ' selected' : ''
                          }`}
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          <strong>{run.status}</strong>
                          <span>{fmt(run.created_at)}</span>
                          <span>{run.id.slice(0, 8)}…</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  {runGraph ? (
                    <section className="workflow-settings-card workflow-run-detail-card">
                      <h3>{t('workteam.运行详情')}</h3>
                      <div className="workflow-run-summary">
                        <div>{t('workteam.状态')}：{runGraph.run.status}</div>
                        <div>
                          {t('workteam.开始')}：
                          {runGraph.run.started_at
                            ? fmt(runGraph.run.started_at)
                            : t('workteam.未开始')}
                        </div>
                        <div>
                          {t('workteam.结束')}：
                          {runGraph.run.completed_at
                            ? fmt(runGraph.run.completed_at)
                            : t('workteam.进行中')}
                        </div>
                      </div>
                      <WorkflowRunHealth
                        metrics={runMetrics}
                        evaluation={runEvaluation}
                      />
                      <div className="workflow-run-output">
                        <h4>{t('workteam.整图输出')}</h4>
                        <pre>
                          {runGraph.run.output || t('workteam.暂无汇总输出')}
                        </pre>
                      </div>
                      <div className="workflow-run-messages">
                        <h4>{t('workteam.延迟消息队列')}</h4>
                        <WorkflowTransferList
                          transfers={pendingTransfers}
                          nodes={snapshot.nodes}
                          canManage={canManage}
                          busy={busy}
                          onApprove={(transferId) =>
                            void mutateTransfer(transferId, 'approve')
                          }
                          onEdit={(transfer) => void editTransfer(transfer)}
                          onCancel={(transferId) =>
                            void mutateTransfer(transferId, 'cancel')
                          }
                          onReleaseNow={(transferId) =>
                            void mutateTransfer(transferId, 'release-now')
                          }
                        />
                      </div>
                      <div className="workflow-run-messages">
                        <h4>{t('workteam.交付产物')}</h4>
                        <WorkflowArtifactList
                          artifacts={artifacts}
                          canManage={canManage}
                          busy={busy}
                          onRefresh={() => void loadArtifacts()}
                          onExport={() => void exportRun()}
                          onCommitAndPush={() => void commitAndPushRun()}
                          onPublish={() => void publishRunArtifact()}
                        />
                      </div>
                      <div className="workflow-run-messages">
                        <h4>{t('workteam.节点执行时间线')}</h4>
                        {selectedNode ? (
                          selectedNodeExecutions.length === 0 ? (
                            <div className="workflow-hint">
                              {t('workteam.该节点当前还没有独立execution记录')}
                            </div>
                          ) : (
                            <>
                              <div className="workflow-execution-list">
                                {selectedNodeExecutions.map((execution) => (
                                  <div
                                    key={execution.id}
                                    className={`workflow-execution-card is-${execution.status}`}
                                  >
                                    <strong>{execution.status}</strong>
                                    <span>{fmt(execution.created_at)}</span>
                                    {execution.error_text ? <pre>{execution.error_text}</pre> : null}
                                  </div>
                                ))}
                              </div>
                              <div className="workflow-execution-events">
                                {executionEventViews.map((event) => (
                                  <div
                                    key={event.id}
                                    className={`workflow-execution-event-card is-${event.tone}`}
                                  >
                                    <strong>{event.title}</strong>
                                    <span>{event.subtitle}</span>
                                    <pre>{event.body}</pre>
                                  </div>
                                ))}
                              </div>
                            </>
                          )
                        ) : (
                          <div className="workflow-hint">
                            {t('workteam.选中节点后显示execution和turnevent日志')}
                          </div>
                        )}
                      </div>
                    </section>
                  ) : (
                    <div className="workflow-hint">
                      {t('workteam.选择一次运行查看节点输入输出消息流和人工干预记录')}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          </section>
        )}
      </div>
      {activeModal === 'create' ? (
        <div className="modal-overlay workflow-modal-overlay" role="presentation">
          <div className="modal workflow-modal">
            <div className="modal-header">
              <h3>{t('workteam.新建工作流')}</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActiveModal(null)}
                aria-label={t('workteam.关闭')}
              >
                ×
              </button>
            </div>
            <div className="workflow-modal-body">
              <label>
                {t('workteam.新工作流名称')}
                <input
                  value={newWorkflowName}
                  onChange={(event) => setNewWorkflowName(event.target.value)}
                  placeholder={t('workteam.新工作流名称')}
                />
              </label>
              <label>
                {t('workteam.工作流说明')}
                <textarea
                  value={newWorkflowDesc}
                  onChange={(event) => setNewWorkflowDesc(event.target.value)}
                  placeholder={t('workteam.工作流说明')}
                />
              </label>
            </div>
            <div className="workflow-modal-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setActiveModal(null)}
              >
                {t('workteam.取消')}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canCreateWorkflow || busy || !newWorkflowName.trim()}
                onClick={() => void createWorkflow()}
              >
                {t('workteam.新建工作流')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {activeModal === 'settings' && snapshot && currentWorkflowConfig ? (
        <div className="modal-overlay workflow-modal-overlay" role="presentation">
          <div className="modal workflow-modal workflow-modal-wide">
            <div className="modal-header">
              <h3>{t('workteam.配置')}</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActiveModal(null)}
                aria-label={t('workteam.关闭')}
              >
                ×
              </button>
            </div>
            <WorkflowSettingsPanel
              snapshot={snapshot}
              config={currentWorkflowConfig}
              canManage={canManage}
              busy={busy}
              onWorkflowChange={(patch) =>
                setSnapshot({
                  ...snapshot,
                  workflow: {
                    ...snapshot.workflow,
                    ...patch,
                  },
                })
              }
              onConfigChange={updateWorkflowConfig}
              onSave={() => void saveCurrentWorkflow()}
            />
          </div>
        </div>
      ) : null}
      {activeModal === 'repository' && snapshot ? (
        <div className="modal-overlay workflow-modal-overlay" role="presentation">
          <div className="modal workflow-modal workflow-modal-wide">
            <div className="modal-header">
              <h3>{t('workteam.仓库配置')}</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActiveModal(null)}
                aria-label={t('workteam.关闭')}
              >
                ×
              </button>
            </div>
            <WorkflowRepositoryPanel
              apiBase={apiBase}
              workflowId={snapshot.workflow.id}
              canManage={canManage}
              boundAssistantNames={visibleWorkerNodes
                .map((node) =>
                  displayAssistantName(assistants, resolveNodeAssistantId(node)),
                )
                .filter(Boolean)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowTransferList({
  transfers,
  nodes,
  canManage,
  busy,
  onApprove,
  onEdit,
  onCancel,
  onReleaseNow,
}: {
  transfers: WorkflowPendingTransferRecord[];
  nodes: WorkflowNodeRecord[];
  canManage: boolean;
  busy: boolean;
  onApprove: (transferId: string) => void;
  onEdit: (transfer: WorkflowPendingTransferRecord) => void;
  onCancel: (transferId: string) => void;
  onReleaseNow: (transferId: string) => void;
}) {
  const { t } = useTranslation('workteam');
  const editable = (transfer: WorkflowPendingTransferRecord) =>
    transfer.status === 'pending' || transfer.status === 'approved';
  if (transfers.length === 0) {
    return <div className="workflow-hint">{t('workteam.暂无待发送handoff消息')}</div>;
  }
  return (
    <div className="workflow-transfer-list">
      {transfers.map((transfer) => (
        <div key={transfer.id} className={`workflow-transfer-card is-${transfer.status}`}>
          <div className="workflow-transfer-card-head">
            <strong>
              {displayNodeName(nodes, transfer.source_node_id)} → {displayNodeName(nodes, transfer.target_node_id)}
            </strong>
            <span>{transfer.status}</span>
          </div>
          <p>{transfer.content_text || t('workteam.无内容')}</p>
          <small>
            {t('workteam.计划发送')} {transfer.due_at ? fmt(transfer.due_at) : '-'}
          </small>
          {editable(transfer) ? (
            <div className="workflow-transfer-actions">
              <button type="button" className="btn-outline btn-sm" disabled={!canManage || busy} onClick={() => onApprove(transfer.id)}>
                {t('workteam.批准')}
              </button>
              <button type="button" className="btn-outline btn-sm" disabled={!canManage || busy} onClick={() => onEdit(transfer)}>
                {t('workteam.编辑')}
              </button>
              <button type="button" className="btn-outline btn-sm" disabled={!canManage || busy} onClick={() => onCancel(transfer.id)}>
                {t('workteam.取消')}
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={!canManage || busy} onClick={() => onReleaseNow(transfer.id)}>
                {t('workteam.立即放行')}
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function WorkflowRunHealth({
  metrics,
  evaluation,
}: {
  metrics: WorkflowRunMetrics | null;
  evaluation: WorkflowEvaluation | null;
}) {
  if (!metrics && !evaluation) return null;
  return (
    <div className="workflow-run-health">
      {metrics ? (
        <div className="workflow-metric-grid">
          <span>Duration {fmtDuration(metrics.durationMs)}</span>
          <span>Nodes {metrics.nodeRuns}/{metrics.guardrails.maxNodeRuns}</span>
          <span>Transfers {metrics.transfers}/{metrics.guardrails.maxTransfers}</span>
          <span>Tool calls {metrics.toolCalls}/{metrics.guardrails.maxToolCalls}</span>
          <span>Approvals {metrics.approvals}</span>
          <span>Events {metrics.executionEvents}/{metrics.guardrails.maxExecutionEvents}</span>
          <span>
            Context {metrics.maxEstimatedContextCharsPerNode}/
            {metrics.guardrails.maxEstimatedContextCharsPerNode}
          </span>
        </div>
      ) : null}
      {metrics?.breakerReason ? (
        <div className="workflow-health-warning">{metrics.breakerReason}</div>
      ) : null}
      {evaluation ? (
        <div className={`workflow-evaluation is-${evaluation.status}`}>
          <strong>Evaluation {evaluation.status} · {evaluation.score}</strong>
          {evaluation.findings.length > 0 ? (
            <ul>
              {evaluation.findings.slice(0, 5).map((finding) => (
                <li key={`${finding.code}:${finding.nodeId || ''}:${finding.message}`}>
                  {finding.severity}: {finding.message}
                </li>
              ))}
            </ul>
          ) : (
            <span>No deterministic findings</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowArtifactList({
  artifacts,
  canManage,
  busy,
  onRefresh,
  onExport,
  onCommitAndPush,
  onPublish,
}: {
  artifacts: WorkflowArtifactRecord[];
  canManage: boolean;
  busy: boolean;
  onRefresh: () => void;
  onExport: () => void;
  onCommitAndPush: () => void;
  onPublish: () => void;
}) {
  const { t } = useTranslation('workteam');
  return (
    <div className="workflow-artifact-panel">
      <div className="workflow-settings-actions">
        <button type="button" className="btn-outline btn-sm" disabled={busy} onClick={onRefresh}>
          {t('workteam.刷新产物')}
        </button>
        <button type="button" className="btn-outline btn-sm" disabled={busy} onClick={onExport}>
          {t('workteam.导出')}
        </button>
        <button type="button" className="btn-outline btn-sm" disabled={!canManage || busy} onClick={onCommitAndPush}>
          {t('workteam.提交推送')}
        </button>
        <button type="button" className="btn-primary btn-sm" disabled={!canManage || busy} onClick={onPublish}>
          {t('workteam.发布能力')}
        </button>
      </div>
      {artifacts.length === 0 ? (
        <div className="workflow-hint">{t('workteam.暂无产物')}</div>
      ) : (
        <div className="workflow-artifact-list">
          {artifacts.map((artifact) => (
            <div key={artifact.id} className={`workflow-artifact-card is-${artifact.status}`}>
              <strong>{artifact.name}</strong>
              <span>{artifact.artifact_type} · {artifact.status}</span>
              <p>{artifact.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowSettingsPanel({
  snapshot,
  config,
  canManage,
  busy,
  onWorkflowChange,
  onConfigChange,
  onSave,
}: {
  snapshot: WorkflowSnapshot;
  config: WorkflowConfig;
  canManage: boolean;
  busy: boolean;
  onWorkflowChange: (
    patch: Partial<Pick<WorkflowRecord, 'name' | 'description'>>,
  ) => void;
  onConfigChange: (patch: Partial<WorkflowConfig>) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation('workteam');

  return (
    <div className="workflow-inspector-body workflow-settings-panel">
      <label>
        {t('workteam.名称')}
        <input
          value={snapshot.workflow.name}
          onChange={(event) => onWorkflowChange({ name: event.target.value })}
        />
      </label>
      <label>
        {t('workteam.描述')}
        <textarea
          value={snapshot.workflow.description}
          onChange={(event) =>
            onWorkflowChange({ description: event.target.value })
          }
        />
      </label>
      <div className="workflow-form-row">
        <label>
          {t('workteam.工作流类型')}
          <input value={config.kind || 'general'} readOnly />
        </label>
        <label>
          {t('workteam.可见性')}
          <input value={config.visibility || 'private'} readOnly />
        </label>
      </div>
      <div className="workflow-form-row">
        <label>
          {t('workteam.消息延迟毫秒')}
          <input
            type="number"
            min="0"
            step="1000"
            value={config.messageDelayMs}
            onChange={(event) =>
              onConfigChange({
                messageDelayMs: Number(event.target.value) || 0,
              })
            }
          />
        </label>
        <label className="workflow-inline-toggle">
          <input
            type="checkbox"
            checked={config.artifactPolicy?.exportable !== false}
            onChange={(event) =>
              onConfigChange({
                artifactPolicy: { exportable: event.target.checked },
              })
            }
          />
          {t('workteam.允许导出')}
        </label>
      </div>
      <div className="workflow-settings-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!canManage || busy}
          onClick={onSave}
        >
          {t('workteam.保存')}
        </button>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  assistants,
  runNode,
  canManage,
  busy,
  onSave,
  onDelete,
  onPauseNode,
  onResumeNode,
  onRetryNode,
  onSaveRunInput,
  onSaveRunOutput,
}: {
  node: WorkflowNodeRecord;
  assistants: AssistantRecord[];
  runNode: WorkflowRunNodeRecord | null;
  canManage: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
  onPauseNode?: () => void;
  onResumeNode?: () => void;
  onRetryNode?: () => void;
  onSaveRunInput: (value: string) => void;
  onSaveRunOutput: (value: string) => void;
}) {
  const { t } = useTranslation('workteam');
  const taskConfig = parseTaskConfig(node);
  const pipelineView = getPipelineNodePresentation(node);
  const pipelineKind = getPipelineNodeKind(node);
  const [name, setName] = useState(node.name);
  const [description, setDescription] = useState(node.description);
  const [assistantId, setAssistantId] = useState(node.assistant_id);
  const [prompt, setPrompt] = useState(taskConfig.prompt || '');
  const [expectedOutput, setExpectedOutput] = useState(taskConfig.expectedOutput || '');
  const [runInput, setRunInput] = useState(runNode?.input_snapshot || '');
  const [runOutput, setRunOutput] = useState(runNode?.output_snapshot || '');

  useEffect(() => {
    setRunInput(runNode?.input_snapshot || '');
    setRunOutput(runNode?.output_snapshot || '');
  }, [runNode?.input_snapshot, runNode?.output_snapshot]);

  return (
    <div className="workflow-inspector-body">
      <div className="workflow-inspector-header">
        <span
          className={`workflow-node-badge type-${node.node_type} is-pipeline`}
        >
          {pipelineView.title}
        </span>
        <button
          type="button"
          className="workflow-delete-node-btn"
          onClick={onDelete}
          disabled={!canManage || busy}
        >
          {t('workteam.删除')}
        </button>
      </div>
      <div className="workflow-inspector-node-hero">
        <span
          className="workflow-node-icon inspector"
          style={{
            color: pipelineView.iconAccent,
            background: `${pipelineView.accent}1f`,
          }}
        >
          {pipelineView.icon}
        </span>
        <div>
          <strong>{node.name}</strong>
          <p>{node.description || pipelineView.subtitle}</p>
        </div>
      </div>
      <label>
        {t('workteam.名称')}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t('workteam.描述')}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>

      {pipelineKind === 'input' ? (
        <div className="workflow-hint">{t('workteam.输入节点说明')}</div>
      ) : (
        <label>
          {t('workteam.选择专家助手可选')}
          <select value={assistantId} onChange={(event) => setAssistantId(event.target.value)}>
            <option value="">{t('workteam.未绑定专家助手')}</option>
            {assistants.map((assistant) => (
              <option key={assistant.id} value={assistant.id}>
                {assistant.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('workteam.节点任务提示')}
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <label>
        {t('workteam.预期输出')}
        <textarea value={expectedOutput} onChange={(event) => setExpectedOutput(event.target.value)} />
      </label>
      <div className="workflow-inspector-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!canManage || busy}
          onClick={() =>
            onSave({
              name,
              description,
              assistant_id: assistantId,
              config_json: {
                ...taskConfig,
                assistantId: assistantId || undefined,
                prompt,
                expectedOutput,
              },
            })
          }
        >
          {t('workteam.保存')}
        </button>
        <button
          type="button"
          className="btn-outline danger"
          disabled={!canManage || busy}
          onClick={onDelete}
        >
          {t('workteam.删除')}
        </button>
      </div>

      {runNode ? (
        <details className="workflow-advanced-details">
          <summary>{t('workteam.运行态干预')}</summary>
          <div className={`workflow-run-state is-${runNode.status}`}>{runNode.status}</div>
          {runNode.last_error ? <div className="workflow-run-error">{runNode.last_error}</div> : null}
          {runNode.pause_reason ? <div className="workflow-run-hint">{runNode.pause_reason}</div> : null}
          <div className="workflow-run-node-actions">
            {onPauseNode ? <button type="button" className="btn-outline btn-sm" onClick={onPauseNode}>{t('workteam.暂停节点')}</button> : null}
            {onResumeNode ? <button type="button" className="btn-outline btn-sm" onClick={onResumeNode}>{t('workteam.继续节点')}</button> : null}
            {onRetryNode ? <button type="button" className="btn-outline btn-sm" onClick={onRetryNode}>{t('workteam.重试节点')}</button> : null}
          </div>
          <label>
            {t('workteam.输入快照')}
            <textarea value={runInput} onChange={(event) => setRunInput(event.target.value)} />
          </label>
          <button type="button" className="btn-primary" onClick={() => onSaveRunInput(runInput)}>
            {t('workteam.保存输入并暂停')}
          </button>
          <label>
            {t('workteam.输出快照')}
            <textarea value={runOutput} onChange={(event) => setRunOutput(event.target.value)} />
          </label>
          <button type="button" className="btn-primary" onClick={() => onSaveRunOutput(runOutput)}>
            {t('workteam.保存输出并继续传播')}
          </button>
        </details>
      ) : null}
    </div>
  );
}

function EdgeInspector({
  edge,
  nodes,
  canManage,
  busy,
  onSave,
  onDelete,
  onReconnectStart,
  onReconnectEnd,
}: {
  edge: WorkflowEdgeRecord;
  nodes: WorkflowNodeRecord[];
  canManage: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
  onReconnectStart: () => void;
  onReconnectEnd: () => void;
}) {
  const { t } = useTranslation('workteam');
  const edgeConfig = parseJsonObject<EdgeConfig>(edge.config_json);
  const [label, setLabel] = useState(edge.label);
  const [direction, setDirection] = useState<WorkflowEdgeDirection>(edge.direction);
  const [discussionTurns] = useState(
    String(edgeConfig.discussionTurns ?? 4),
  );

  return (
    <div className="workflow-inspector-body">
      <div className="workflow-inspector-header">
        <span className="workflow-node-badge type-edge">{t('workteam.消息流边')}</span>
        <button type="button" className="btn-outline btn-sm" onClick={onDelete} disabled={!canManage || busy}>
          {t('workteam.删除')}
        </button>
      </div>
      <div className="workflow-hint">
        {nodes.find((node) => node.id === edge.source_node_id)?.name || edge.source_node_id}
        {' -> '}
        {nodes.find((node) => node.id === edge.target_node_id)?.name || edge.target_node_id}
      </div>
      <div className="workflow-edge-reconnect-actions">
        <button type="button" className="btn-outline btn-sm" onClick={onReconnectStart} disabled={!canManage || busy}>
          {t('workteam.重连起点')}
        </button>
        <button type="button" className="btn-outline btn-sm" onClick={onReconnectEnd} disabled={!canManage || busy}>
          {t('workteam.重连终点')}
        </button>
      </div>
      <label>
        {t('workteam.标签')}
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      <label>
        {t('workteam.方向')}
        <select
          value={direction}
          onChange={(event) => setDirection(event.target.value as WorkflowEdgeDirection)}
        >
          <option value="one_way">{t('workteam.单向')}</option>
          <option value="two_way">{t('workteam.双向')}</option>
        </select>
      </label>
      <button
        type="button"
        className="btn-primary"
        disabled={!canManage || busy}
        onClick={() =>
          onSave({
            label,
            direction,
            config_json:
              direction === 'two_way'
                ? { discussionTurns: Number(discussionTurns) || 4 }
                : {},
          })
        }
      >
        {t('workteam.保存连线')}
      </button>
    </div>
  );
}
