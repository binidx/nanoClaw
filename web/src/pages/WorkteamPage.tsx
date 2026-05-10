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
}

type WorkflowStatus = 'draft' | 'active' | 'archived';
type WorkflowNodeType = 'role' | 'task';
type WorkflowEdgeDirection = 'one_way' | 'two_way';
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
}

interface AssistantRecord {
  id: string;
  name: string;
}

interface RoleConfig {
  goal?: string;
  backstory?: string;
}

interface TaskConfig {
  prompt?: string;
  expectedOutput?: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
  providerOverrideId?: string;
  modelOverride?: string;
  instructionsAppend?: string;
  allowedDirectories?: string[];
}

interface EdgeConfig {
  discussionTurns?: number;
}

interface WorkflowMessagePayload {
  edgeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  direction?: WorkflowEdgeDirection;
  messageType?: string;
  discussionCount?: number;
  content?: string;
}

interface WorkflowFramePayload {
  edgeId?: string;
  discussionCount?: number;
  messageType?: string;
  content?: string;
}

type EdgeDirectionFilter = 'all' | 'forward' | 'reverse';

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

interface RoleNodeTemplate {
  id: string;
  name: string;
  goal: string;
  backstory: string;
}

interface TaskNodeTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  expectedOutput: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
}

interface WorkflowGraphTemplate {
  id: string;
  name: string;
  description: string;
  roles: Array<
    RoleNodeTemplate & {
      key: string;
      position: { x: number; y: number };
    }
  >;
  tasks: Array<
    TaskNodeTemplate & {
      key: string;
      roleKey: string;
      position: { x: number; y: number };
    }
  >;
  edges: Array<{
    sourceTaskKey: string;
    targetTaskKey: string;
    direction?: WorkflowEdgeDirection;
    discussionTurns?: number;
    label?: string;
  }>;
}

const NODE_WIDTH = 120;
const NODE_HEIGHT = 88;

function buildRoleNodeTemplates(t: (key: string, options?: Record<string, unknown>) => string): RoleNodeTemplate[] {
  return [
    {
      id: 'planner',
      name: 'Planner',
      goal: t('拆解目标、识别约束并产出清晰执行计划。'),
      backstory: t('擅长需求分析、任务分解和阶段规划。'),
    },
    {
      id: 'architect',
      name: 'Architect',
      goal: t('设计系统方案、接口边界与关键技术取舍。'),
      backstory: t('擅长架构设计、边界划分和复杂系统建模。'),
    },
    {
      id: 'builder',
      name: 'Builder',
      goal: t('把设计落成可运行实现，快速迭代交付。'),
      backstory: t('擅长编码、调试和把方案变成可工作的系统。'),
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      goal: t('识别风险、缺陷和回归点，推动质量收敛。'),
      backstory: t('擅长代码审查、边界检查和异常场景验证。'),
    },
    {
      id: 'verifier',
      name: 'Verifier',
      goal: t('执行验证、确认结果并给出最终通过结论。'),
      backstory: t('擅长测试设计、验收和交付前确认。'),
    },
  ];
}

function buildTaskNodeTemplates(t: (key: string, options?: Record<string, unknown>) => string): TaskNodeTemplate[] {
  return [
    {
      id: 'analyze',
      name: 'Analyze',
      description: t('分析输入、背景和约束，形成结构化认知。'),
      prompt: t('先分析问题背景、目标、约束和潜在风险，再给出结构化结论。'),
      expectedOutput: t('结构化分析结果'),
    },
    {
      id: 'design',
      name: 'Design',
      description: t('产出设计方案与关键决策。'),
      prompt: t('给出设计方案、关键边界、组件关系和实现策略。'),
      expectedOutput: t('设计方案'),
    },
    {
      id: 'implement',
      name: 'Implement',
      description: t('基于既有方案执行实现。'),
      prompt: t('根据上游设计和反馈完成实现，并明确产出结果。'),
      expectedOutput: t('实现结果'),
    },
    {
      id: 'review',
      name: 'Review',
      description: t('检查实现质量并提出修改建议。'),
      prompt: t('从正确性、风险、回归和可维护性角度审查当前结果。'),
      expectedOutput: t('审查意见'),
    },
    {
      id: 'verify',
      name: 'Verify',
      description: t('执行最终验收与通过判断。'),
      prompt: t('验证目标是否达成，列出通过结论、残余风险和阻塞项。'),
      expectedOutput: t('验收结论'),
    },
  ];
}

function buildWorkflowGraphTemplates(
  roleNodeTemplates: RoleNodeTemplate[],
  taskNodeTemplates: TaskNodeTemplate[],
  t: (key: string, options?: Record<string, unknown>) => string,
): WorkflowGraphTemplate[] {
  return [
    {
      id: 'sdlc-lite',
      name: 'SDLC Lite',
      description: t('需求 -> 方案 -> 开发 -> 评审 -> 验证'),
    roles: [
      {
        key: 'planner',
        ...roleNodeTemplates[0],
        position: { x: 60, y: 80 },
      },
      {
        key: 'architect',
        ...roleNodeTemplates[1],
        position: { x: 60, y: 220 },
      },
      {
        key: 'builder',
        ...roleNodeTemplates[2],
        position: { x: 60, y: 360 },
      },
      {
        key: 'reviewer',
        ...roleNodeTemplates[3],
        position: { x: 60, y: 500 },
      },
      {
        key: 'verifier',
        ...roleNodeTemplates[4],
        position: { x: 60, y: 640 },
      },
    ],
    tasks: [
      {
        key: 'analyze',
        ...taskNodeTemplates[0],
        roleKey: 'planner',
        position: { x: 340, y: 80 },
      },
      {
        key: 'design',
        ...taskNodeTemplates[1],
        roleKey: 'architect',
        position: { x: 620, y: 180 },
      },
      {
        key: 'implement',
        ...taskNodeTemplates[2],
        roleKey: 'builder',
        position: { x: 900, y: 280 },
      },
      {
        key: 'review',
        ...taskNodeTemplates[3],
        roleKey: 'reviewer',
        position: { x: 1180, y: 380 },
      },
      {
        key: 'verify',
        ...taskNodeTemplates[4],
        roleKey: 'verifier',
        position: { x: 1460, y: 480 },
      },
    ],
    edges: [
      { sourceTaskKey: 'analyze', targetTaskKey: 'design' },
      { sourceTaskKey: 'design', targetTaskKey: 'implement' },
      { sourceTaskKey: 'implement', targetTaskKey: 'review' },
      { sourceTaskKey: 'review', targetTaskKey: 'verify' },
    ],
  },
  {
    id: 'analysis-exec-summary',
    name: 'Analysis -> Execute -> Summarize',
    description: t('快速分析、执行、汇总的轻量闭环'),
    roles: [
      {
        key: 'analyst',
        ...roleNodeTemplates[0],
        position: { x: 60, y: 120 },
      },
      {
        key: 'builder',
        ...roleNodeTemplates[2],
        position: { x: 60, y: 300 },
      },
      {
        key: 'verifier',
        ...roleNodeTemplates[4],
        position: { x: 60, y: 480 },
      },
    ],
    tasks: [
      {
        key: 'analyze',
        ...taskNodeTemplates[0],
        roleKey: 'analyst',
        position: { x: 340, y: 120 },
      },
      {
        key: 'implement',
        ...taskNodeTemplates[2],
        roleKey: 'builder',
        position: { x: 720, y: 260 },
      },
      {
        key: 'verify',
        ...taskNodeTemplates[4],
        roleKey: 'verifier',
        position: { x: 1100, y: 400 },
      },
    ],
    edges: [
      { sourceTaskKey: 'analyze', targetTaskKey: 'implement' },
      { sourceTaskKey: 'implement', targetTaskKey: 'verify' },
    ],
  },
  {
    id: 'debate-arbiter',
    name: 'Debate + Arbiter',
    description: t('双人讨论后交由仲裁节点收敛结论'),
    roles: [
      {
        key: 'side-a',
        id: 'debater-a',
        name: 'Debater A',
        goal: t('auto.6eda290c'),
        backstory: t('auto.ab56ed0b'),
        position: { x: 60, y: 120 },
      },
      {
        key: 'side-b',
        id: 'debater-b',
        name: 'Debater B',
        goal: t('auto.7220a1d4'),
        backstory: t('auto.274ad680'),
        position: { x: 60, y: 320 },
      },
      {
        key: 'arbiter',
        id: 'arbiter',
        name: 'Arbiter',
        goal: t('auto.0203969d'),
        backstory: t('auto.99fac797'),
        position: { x: 60, y: 540 },
      },
    ],
    tasks: [
      {
        key: 'arg-a',
        id: 'arg-a',
        name: 'Argument A',
        description: t('auto.5e22a80b'),
        prompt: t('auto.d59b6c57'),
        expectedOutput: t('auto.ff44c391'),
        roleKey: 'side-a',
        position: { x: 340, y: 120 },
      },
      {
        key: 'arg-b',
        id: 'arg-b',
        name: 'Argument B',
        description: t('auto.5e96b31f'),
        prompt: t('auto.d292fac9'),
        expectedOutput: t('auto.2d356b0d'),
        roleKey: 'side-b',
        position: { x: 760, y: 260 },
      },
      {
        key: 'arbiter',
        id: 'arbiter-task',
        name: 'Arbitrate',
        description: t('auto.1530f31c'),
        prompt: t('auto.6d823aa0'),
        expectedOutput: t('auto.a66dc0b7'),
        roleKey: 'arbiter',
        position: { x: 1180, y: 420 },
      },
    ],
    edges: [
      {
        sourceTaskKey: 'arg-a',
        targetTaskKey: 'arg-b',
        direction: 'two_way',
        discussionTurns: 4,
        label: 'debate',
      },
      { sourceTaskKey: 'arg-a', targetTaskKey: 'arbiter' },
      { sourceTaskKey: 'arg-b', targetTaskKey: 'arbiter' },
    ],
  },
  ];
}

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

function nodeAccent(node: WorkflowNodeRecord): string {
  if (node.node_type === 'role') return '#1d4ed8';
  return '#0f766e';
}

function edgePath(source: WorkflowNodeRecord, target: WorkflowNodeRecord): string {
  const x1 = source.position_x + 120;
  const y1 = source.position_y + 44;
  const x2 = target.position_x;
  const y2 = target.position_y + 44;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

function positionLabel(node: WorkflowNodeRecord): string {
  return `${Math.round(node.position_x)}, ${Math.round(node.position_y)}`;
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

function parseWorkflowMessagePayload(raw: string): WorkflowMessagePayload {
  try {
    const payload = JSON.parse(raw) as WorkflowMessagePayload;
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
}

function parseWorkflowFramePayload(raw: string): WorkflowFramePayload {
  try {
    const payload = JSON.parse(raw) as WorkflowFramePayload;
    return payload && typeof payload === 'object' ? payload : {};
  } catch {
    return {};
  }
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

export function WorkteamPage({ apiBase, canManage = true }: WorkteamPageProps) {
  const { t } = useTranslation('workteam');
  const location = useLocation();
  const navigate = useNavigate();
  const roleNodeTemplates = useMemo(() => buildRoleNodeTemplates(t), [t]);
  const taskNodeTemplates = useMemo(() => buildTaskNodeTemplates(t), [t]);
  const workflowGraphTemplates = useMemo(
    () => buildWorkflowGraphTemplates(roleNodeTemplates, taskNodeTemplates, t),
    [roleNodeTemplates, taskNodeTemplates, t],
  );
  const workflowId = getUrlSubPath(location.pathname);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectionBoxRef = useRef<SelectionBoxState | null>(null);

  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [runGraph, setRunGraph] = useState<WorkflowRunGraph | null>(null);
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
  const [runInput, setRunInput] = useState('');
  const [edgeFeedbackText, setEdgeFeedbackText] = useState('');
  const [edgeFeedbackDirection, setEdgeFeedbackDirection] = useState<
    'forward' | 'reverse'
  >('forward');
  const [edgeMessageQuery, setEdgeMessageQuery] = useState('');
  const [edgeDirectionFilter, setEdgeDirectionFilter] =
    useState<EdgeDirectionFilter>('all');
  const [collapsedRounds, setCollapsedRounds] = useState<string[]>([]);
  const [nodeHistoryQuery, setNodeHistoryQuery] = useState('');
  const [nodeInputPriorityMode, setNodeInputPriorityMode] = useState<
    'feedback_first' | 'chronological'
  >('feedback_first');
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
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/${workflowId}/runs`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    const list = (await res.json()) as WorkflowRunRecord[];
    setRuns(list);
    if (!selectedRunId && list.length > 0) {
      setSelectedRunId(list[0].id);
    }
  }, [apiBase, workflowId, selectedRunId]);

  const loadRunGraph = useCallback(async () => {
    if (!selectedRunId) {
      setRunGraph(null);
      return;
    }
    const res = await fetch(`${apiBase}/api/workflows/run/${selectedRunId}/graph`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await readError(res));
    setRunGraph((await res.json()) as WorkflowRunGraph);
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
    setSelectedRunId('');
    setSelectedNodeId('');
    setSelectedNodeIds([]);
    setSelectedEdgeId('');
    setConnectFromNodeId('');
    setReconnectState(null);
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

  const nodeFrames = useMemo(() => {
    if (!runGraph || !selectedNodeId) return [];
    return runGraph.messageFrames.filter(
      (frame) =>
        frame.source_node_id === selectedNodeId ||
        frame.target_node_id === selectedNodeId,
    );
  }, [runGraph, selectedNodeId]);

  const nodeMessages = useMemo(() => {
    if (!runGraph || !selectedNodeId || runGraph.messageFrames.length > 0) return [];
    return runGraph.messages.filter(
      (message) =>
        message.source_node_id === selectedNodeId ||
        message.target_node_id === selectedNodeId,
    );
  }, [runGraph, selectedNodeId]);

  const selectedEdgeFrames = useMemo(() => {
    if (!runGraph || !selectedEdgeId) return [];
    return runGraph.messageFrames.filter((frame) => frame.edge_id === selectedEdgeId);
  }, [runGraph, selectedEdgeId]);

  const selectedEdgeSessions = useMemo(() => {
    if (!runGraph || !selectedEdgeId) return [];
    return runGraph.dialogueSessions.filter((session) => session.edge_id === selectedEdgeId);
  }, [runGraph, selectedEdgeId]);

  const filteredSelectedEdgeMessages = useMemo(() => {
    if (!selectedEdge) return selectedEdgeFrames;
    return selectedEdgeFrames.filter((frame) => {
      const payload = parseWorkflowFramePayload(frame.payload_json);
      const content = frame.content_text || payload.content || extractMessageContent(frame.payload_json);
      const matchesQuery =
        !edgeMessageQuery.trim() ||
        content.toLowerCase().includes(edgeMessageQuery.trim().toLowerCase()) ||
        displayNodeName(snapshot?.nodes, frame.source_node_id)
          .toLowerCase()
          .includes(edgeMessageQuery.trim().toLowerCase()) ||
        displayNodeName(snapshot?.nodes, frame.target_node_id)
          .toLowerCase()
          .includes(edgeMessageQuery.trim().toLowerCase());
      const isForward =
        frame.source_node_id === selectedEdge.source_node_id &&
        frame.target_node_id === selectedEdge.target_node_id;
      const matchesDirection =
        edgeDirectionFilter === 'all' ||
        (edgeDirectionFilter === 'forward' && isForward) ||
        (edgeDirectionFilter === 'reverse' && !isForward);
      return matchesQuery && matchesDirection;
    });
  }, [
    edgeDirectionFilter,
    edgeMessageQuery,
    selectedEdge,
    selectedEdgeFrames,
    snapshot?.nodes,
  ]);

  const edgeMessageGroups = useMemo(() => {
    const grouped = new Map<
      string,
      Array<WorkflowMessageFrameRecord & { payload: WorkflowFramePayload }>
    >();
    for (const frame of filteredSelectedEdgeMessages) {
      const payload = parseWorkflowFramePayload(frame.payload_json);
      const roundKey =
        typeof frame.turn_index === 'number' && frame.turn_index > 0
          ? `round-${frame.turn_index}`
          : typeof payload.discussionCount === 'number'
            ? `round-${payload.discussionCount}`
            : 'round-untracked';
      const list = grouped.get(roundKey) ?? [];
      list.push({ ...frame, payload });
      grouped.set(roundKey, list);
    }
    return Array.from(grouped.entries()).map(([roundKey, messages]) => ({
      roundKey,
      label:
        roundKey === 'round-untracked'
          ? t('workteam.未编号消息')
          : t('workteam.第{n}轮', { n: roundKey.replace('round-', '') }),
      messages,
    }));
  }, [filteredSelectedEdgeMessages]);

  const discussionEdgeSummaries = useMemo(() => {
    if (!runGraph || !snapshot) return [];
    return snapshot.edges
      .filter((edge) => edge.direction === 'two_way')
      .map((edge) => {
        const session = runGraph.dialogueSessions.find((item) => item.edge_id === edge.id);
        const frames = runGraph.messageFrames.filter((frame) => frame.edge_id === edge.id);
        return {
          edge,
          count: frames.length,
          latestAt: frames.at(-1)?.created_at || session?.updated_at || '',
          latestPreview:
            frames.length > 0
              ? (frames.at(-1)?.content_text || extractMessageContent(frames.at(-1)?.payload_json || '')).slice(0, 96)
              : '',
          turnCount: session?.turn_count || 0,
          sessionStatus: session?.status || 'active',
        };
      })
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }, [runGraph, snapshot]);

  const nodeHistoryEntries = useMemo(() => {
    if (!snapshot || !selectedNode || !selectedRunNode) return [];
    const entries: Array<{
      id: string;
      kind: 'input' | 'output' | 'message' | 'intervention';
      title: string;
      subtitle: string;
      content: string;
      anchorFrameId?: string;
    }> = [];

    if (selectedRunNode.input_snapshot) {
      entries.push({
        id: `${selectedNode.id}-input`,
        kind: 'input',
        title: t('workteam.当前输入快照'),
        subtitle: selectedRunNode.updated_at ? fmt(selectedRunNode.updated_at) : '',
        content: selectedRunNode.input_snapshot,
      });
    }
    for (const frame of nodeFrames) {
      const payload = parseWorkflowFramePayload(frame.payload_json);
      entries.push({
        id: frame.id,
        kind: 'message',
        title:
          `${displayNodeName(snapshot.nodes, frame.source_node_id)} -> ${displayNodeName(snapshot.nodes, frame.target_node_id)}`,
        subtitle: `${frame.turn_index ? t('workteam.第{n}轮', { n: frame.turn_index }) : t('workteam.消息')} · ${frame.frame_type} · ${fmt(frame.created_at)}`,
        content: frame.content_text || payload.content || extractMessageContent(frame.payload_json),
        anchorFrameId: frame.id,
      });
    }
    if (nodeFrames.length === 0) {
      for (const message of nodeMessages) {
        const payload = parseWorkflowMessagePayload(message.payload_json);
        entries.push({
          id: message.id,
          kind: 'message',
          title:
            `${displayNodeName(snapshot.nodes, message.source_node_id)} -> ${displayNodeName(snapshot.nodes, message.target_node_id)}`,
          subtitle: `${payload.discussionCount ? t('workteam.第{n}轮', { n: payload.discussionCount }) : t('workteam.消息')} · ${fmt(message.created_at)}`,
          content: payload.content || extractMessageContent(message.payload_json),
        });
      }
    }
    for (const intervention of runGraph?.interventions.filter((item) => item.node_id === selectedNode.id) ?? []) {
      entries.push({
        id: intervention.id,
        kind: 'intervention',
        title: intervention.summary || intervention.intervention_type,
        subtitle: fmt(intervention.created_at),
        content: intervention.after_json || intervention.before_json,
      });
    }
    if (selectedRunNode.output_snapshot) {
      entries.push({
        id: `${selectedNode.id}-output`,
        kind: 'output',
        title: t('workteam.当前输出快照'),
        subtitle: selectedRunNode.completed_at ? fmt(selectedRunNode.completed_at) : '',
        content: selectedRunNode.output_snapshot,
      });
    }
    return entries;
  }, [snapshot, selectedNode, selectedRunNode, nodeFrames, nodeMessages, runGraph?.interventions]);

  const filteredNodeHistoryEntries = useMemo(() => {
    if (!nodeHistoryQuery.trim()) return nodeHistoryEntries;
    const query = nodeHistoryQuery.trim().toLowerCase();
    return nodeHistoryEntries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        entry.subtitle.toLowerCase().includes(query) ||
        entry.content.toLowerCase().includes(query),
    );
  }, [nodeHistoryEntries, nodeHistoryQuery]);

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

  const selectedRoleNodes = useMemo(
    () => snapshot?.nodes.filter((node) => node.node_type === 'role') ?? [],
    [snapshot],
  );

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

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      const canvas = canvasRef.current;
      if (drag && canvas) {
        const rect = canvas.getBoundingClientRect();
        const nextX = Math.max(16, event.clientX - rect.left - drag.offsetX);
        const nextY = Math.max(16, event.clientY - rect.top - drag.offsetY);
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
      const rect = canvas.getBoundingClientRect();
      const nextBox = {
        ...box,
        currentX: event.clientX - rect.left,
        currentY: event.clientY - rect.top,
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
      const picked = snapshot.nodes
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
  }, [apiBase, workflowId, snapshot, setSnapshotNode]);

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
      await loadWorkflows();
      navigate(navPageToPath('workteam', created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createNode = async (nodeType: WorkflowNodeType) => {
    if (!workflowId || !snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const count = snapshot.nodes.filter((node) => node.node_type === nodeType).length;
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: nodeType,
          name: nodeType === 'role' ? t('workteam.角色N', { n: count + 1 }) : t('workteam.任务N', { n: count + 1 }),
          description: '',
          role_node_id:
            nodeType === 'task' ? snapshot.nodes.find((node) => node.node_type === 'role')?.id || '' : '',
          config_json:
            nodeType === 'role'
              ? { goal: '', backstory: '' }
              : { prompt: '', expectedOutput: '', timeoutMs: 600000, approvalRequired: false },
          position_x: nodeType === 'role' ? 60 : 380,
          position_y: 80 + count * 120,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createNodeFromTemplate = async (
    template: RoleNodeTemplate | TaskNodeTemplate,
    nodeType: WorkflowNodeType,
  ) => {
    if (!workflowId || !snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const roleFallback =
        nodeType === 'task'
          ? snapshot.nodes.find((node) => node.node_type === 'role')?.id || ''
          : '';
      const baseCount = snapshot.nodes.filter((node) => node.node_type === nodeType).length;
      const body =
        nodeType === 'role'
          ? {
              node_type: 'role' as const,
              name: template.name,
              description:
                'goal' in template ? template.goal : template.description,
              config_json:
                'goal' in template
                  ? {
                      goal: template.goal,
                      backstory: template.backstory,
                    }
                  : {},
              position_x: 60,
              position_y: 80 + baseCount * 140,
            }
          : {
              node_type: 'task' as const,
              name: template.name,
              description:
                'description' in template ? template.description : template.name,
              role_node_id: roleFallback,
              config_json:
                'prompt' in template
                  ? {
                      prompt: template.prompt,
                      expectedOutput: template.expectedOutput,
                      timeoutMs: template.timeoutMs || 600000,
                      approvalRequired: template.approvalRequired || false,
                    }
                  : {},
              position_x: 340,
              position_y: 80 + baseCount * 140,
            };
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadSnapshot();
      setInfo(nodeType === 'role' ? t('workteam.已插入角色模板', { name: template.name }) : t('workteam.已插入任务模板', { name: template.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createWorkflowGraphTemplate = async (template: WorkflowGraphTemplate) => {
    if (!workflowId) return;
    setBusy(true);
    setError(null);
    try {
      const roleNodeIdByKey = new Map<string, string>();
      const taskNodeIdByKey = new Map<string, string>();

      for (const role of template.roles) {
        const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_type: 'role',
            name: role.name,
            description: role.goal,
            assistant_id: '',
            config_json: {
              goal: role.goal,
              backstory: role.backstory,
              templateId: template.id,
              roleTemplateId: role.id,
            },
            position_x: role.position.x,
            position_y: role.position.y,
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const node = (await res.json()) as WorkflowNodeRecord;
        roleNodeIdByKey.set(role.key, node.id);
      }

      for (const task of template.tasks) {
        const roleNodeId = roleNodeIdByKey.get(task.roleKey) || '';
        const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            node_type: 'task',
            name: task.name,
            description: task.description,
            role_node_id: roleNodeId,
            config_json: {
              prompt: task.prompt,
              expectedOutput: task.expectedOutput,
              timeoutMs: task.timeoutMs || 600000,
              approvalRequired: task.approvalRequired || false,
              templateId: template.id,
              taskTemplateId: task.id,
            },
            position_x: task.position.x,
            position_y: task.position.y,
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
        const node = (await res.json()) as WorkflowNodeRecord;
        taskNodeIdByKey.set(task.key, node.id);
      }

      for (const edge of template.edges) {
        const sourceNodeId = taskNodeIdByKey.get(edge.sourceTaskKey);
        const targetNodeId = taskNodeIdByKey.get(edge.targetTaskKey);
        if (!sourceNodeId || !targetNodeId) continue;
        const res = await fetch(`${apiBase}/api/workflows/${workflowId}/edges`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_node_id: sourceNodeId,
            target_node_id: targetNodeId,
            direction: edge.direction || 'one_way',
            label: edge.label || '',
            config_json:
              edge.direction === 'two_way'
                ? { discussionTurns: edge.discussionTurns || 4 }
                : {},
          }),
        });
        if (!res.ok) throw new Error(await readError(res));
      }

      await loadSnapshot();
      setInfo(t('workteam.已插入模板图', { name: template.name }));
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
      roles: snapshot.nodes.filter((node) => node.node_type === 'role').length,
      tasks: snapshot.nodes.filter((node) => node.node_type === 'task').length,
      edges: snapshot.edges.length,
    };
  }, [snapshot]);

  const toggleCollapsedRound = useCallback((roundKey: string) => {
    setCollapsedRounds((prev) =>
      prev.includes(roundKey)
        ? prev.filter((item) => item !== roundKey)
        : [...prev, roundKey],
    );
  }, []);

  const applyHistoryEntryToNodeInput = useCallback(
    async (value: string) => {
      if (!selectedNode || selectedNode.node_type !== 'task' || !selectedRunId) return;
      await saveRunNodeField(selectedNode.id, 'input', value);
      setInfo(t('workteam.已将内容回填到节点输入快照', { name: selectedNode.name }));
    },
    [saveRunNodeField, selectedNode, selectedRunId],
  );

  useEffect(() => {
    setNodeInputPriorityMode(
      selectedRunNode?.input_priority_mode || 'feedback_first',
    );
  }, [selectedRunNode?.input_priority_mode]);

  const saveNodeInputConfig = async (inputAnchorFrameId: string) => {
    if (!selectedRunId || !selectedNode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/nodes/${selectedNode.id}/input-config`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_anchor_frame_id: inputAnchorFrameId,
            input_priority_mode: nodeInputPriorityMode,
          }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadRunGraph();
      setInfo(inputAnchorFrameId ? t('workteam.已设置输入基线frame') : t('workteam.已清除输入基线frame'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveNodeInputPriorityMode = async (
    nextMode: 'feedback_first' | 'chronological',
  ) => {
    if (!selectedRunId || !selectedNode) return;
    setNodeInputPriorityMode(nextMode);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/nodes/${selectedNode.id}/input-config`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_anchor_frame_id: selectedRunNode?.input_anchor_frame_id || '',
            input_priority_mode: nextMode,
          }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      await loadRunGraph();
      setInfo(t('workteam.已更新节点输入优先级'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createEdgeFeedback = async () => {
    if (!selectedRunId || !selectedEdge || !edgeFeedbackText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/workflows/run/${selectedRunId}/edges/${selectedEdge.id}/feedback`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: edgeFeedbackText.trim(),
            direction: edgeFeedbackDirection,
          }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      setEdgeFeedbackText('');
      await loadRunGraph();
      setInfo(t('workteam.反馈frame已插入当前边'));
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

  return (
    <div className="page-view workflow-page">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>{t('pageTitle')}</h2>
          <p>{t('workteam.图形化多智能体工作台')}</p>
        </div>
      </div>
      <div className="page-body workflow-body">
        {error ? <div className="workflow-banner error">{error}</div> : null}
        {info ? <div className="workflow-banner info">{info}</div> : null}

        <section className="workflow-shell">
          <aside className="workflow-sidebar">
            <div className="workflow-sidebar-section">
              <h3>{t('workteam.工作流')}</h3>
              <div className="workflow-create-form">
                <input
                  value={newWorkflowName}
                  onChange={(event) => setNewWorkflowName(event.target.value)}
                  placeholder={t('workteam.新工作流名称')}
                />
                <textarea
                  value={newWorkflowDesc}
                  onChange={(event) => setNewWorkflowDesc(event.target.value)}
                  placeholder={t('workteam.工作流说明')}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!canManage || busy}
                  onClick={() => void createWorkflow()}
                >
                  {t('workteam.新建工作流')}
                </button>
              </div>
              <div className="workflow-list">
                {workflows.map((workflow) => (
                  <button
                    key={workflow.id}
                    type="button"
                    className={`workflow-list-item${workflow.id === workflowId ? ' selected' : ''}`}
                    onClick={() => navigate(navPageToPath('workteam', workflow.id))}
                  >
                    <strong>{workflow.name}</strong>
                    <span>{workflow.description || t('workteam.无描述')}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="workflow-sidebar-section">
              <h3>{t('workteam.节点模板')}</h3>
              <div className="workflow-template-list">
                {roleNodeTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="workflow-template-card"
                    disabled={!workflowId || !canManage || busy}
                    onClick={() => void createNodeFromTemplate(template, 'role')}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.goal}</span>
                  </button>
                ))}
              </div>
              <div className="workflow-template-list">
                {taskNodeTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="workflow-template-card task"
                    disabled={!workflowId || !canManage || busy}
                    onClick={() => void createNodeFromTemplate(template, 'task')}
                  >
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="workflow-sidebar-section">
              <h3>{t('workteam.标准图模板')}</h3>
              <div className="workflow-template-list">
                {workflowGraphTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="workflow-template-card graph"
                    disabled={!workflowId || !canManage || busy}
                    onClick={() => void createWorkflowGraphTemplate(template)}
                  >
                    <strong>{template.name}</strong>
                    <span>{t(`workteam.${template.description}`)}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <main className="workflow-main">
            {!snapshot ? (
              <div className="workflow-empty">
                {t('workteam.先在左侧创建或选择一个工作流')}
              </div>
            ) : (
              <>
                <section className="workflow-toolbar">
                  <div className="workflow-toolbar-left">
                    <input
                      className="workflow-title-input"
                      value={snapshot.workflow.name}
                      onChange={(event) =>
                        setSnapshot({
                          ...snapshot,
                          workflow: { ...snapshot.workflow, name: event.target.value },
                        })
                      }
                      onBlur={() =>
                        void fetch(`${apiBase}/api/workflows/${workflowId}`, {
                          method: 'PUT',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            name: snapshot.workflow.name,
                            description: snapshot.workflow.description,
                          }),
                        }).then(() => loadWorkflows())
                      }
                    />
                    <textarea
                      className="workflow-desc-input"
                      value={snapshot.workflow.description}
                      onChange={(event) =>
                        setSnapshot({
                          ...snapshot,
                          workflow: {
                            ...snapshot.workflow,
                            description: event.target.value,
                          },
                        })
                      }
                      onBlur={() =>
                        void fetch(`${apiBase}/api/workflows/${workflowId}`, {
                          method: 'PUT',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            name: snapshot.workflow.name,
                            description: snapshot.workflow.description,
                          }),
                        }).then(() => loadWorkflows())
                      }
                    />
                  </div>
                  <div className="workflow-toolbar-right">
                    <div className="workflow-metric-chip">
                      {workflowStats?.roles ?? 0} {t('workteam.角色')} / {workflowStats?.tasks ?? 0} {t('workteam.任务')} / {workflowStats?.edges ?? 0} {t('workteam.连线')}
                    </div>
                    <button type="button" className="btn-primary" onClick={() => void createNode('role')} disabled={!canManage || busy}>
                      {t('workteam.新增角色节点')}
                    </button>
                    <button type="button" className="btn-primary" onClick={() => void createNode('task')} disabled={!canManage || busy}>
                      {t('workteam.新增任务节点')}
                    </button>
                    <button type="button" className="btn-outline btn-sm" onClick={() => void applyAutoLayout()} disabled={!canManage || busy}>
                      {t('workteam.自动排版')}
                    </button>
                    <button type="button" className="btn-outline btn-sm" onClick={() => void validateWorkflow()} disabled={!canManage || busy}>
                      {t('workteam.校验图')}
                    </button>
                  </div>
                </section>

                <section className="workflow-canvas-panel">
                  <div className="workflow-canvas-toolbar">
                    <span>
                      {reconnectState
                        ? t('workteam.重连模式', { end: reconnectState.end === 'source' ? t('workteam.起点') : t('workteam.终点') })
                        : connectFromNodeId
                        ? t('workteam.连接模式')
                        : selectedNodeIds.length > 1
                          ? t('workteam.已选中N个节点可批量拖动', { n: selectedNodeIds.length })
                          : t('workteam.点击节点进入编辑')}
                    </span>
                  </div>
                  <div
                    ref={canvasRef}
                    className="workflow-canvas"
                    onMouseDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      const nextBox = {
                        startX: event.clientX - rect.left,
                        startY: event.clientY - rect.top,
                        currentX: event.clientX - rect.left,
                        currentY: event.clientY - rect.top,
                      };
                      selectionBoxRef.current = nextBox;
                      setSelectionBox(nextBox);
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
                      {snapshot.edges.map((edge) => {
                        const source = snapshot.nodes.find((node) => node.id === edge.source_node_id);
                        const target = snapshot.nodes.find((node) => node.id === edge.target_node_id);
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
                                className={`workflow-edge back ${active ? 'selected' : ''}`}
                                markerEnd="url(#workflow-arrow)"
                              />
                            ) : null}
                          </g>
                        );
                      })}
                    </svg>

                    {snapshot.nodes.map((node) => {
                      const runState = runNodeStatusMap.get(node.id);
                      return (
                        <button
                          key={node.id}
                          type="button"
                          className={`workflow-node node-${node.node_type}${selectedNodeIds.includes(node.id) ? ' is-multi-selected' : ''}${selectedNodeId === node.id ? ' selected' : ''}`}
                          style={{
                            left: node.position_x,
                            top: node.position_y,
                            borderColor: nodeAccent(node),
                          }}
                          onMouseDown={(event) => {
                            if (reconnectState || connectFromNodeId) return;
                            const nextSelectedIds =
                              selectedNodeIds.includes(node.id)
                                ? selectedNodeIds
                                : [node.id];
                            setSelectedNodeIds(nextSelectedIds);
                            setSelectedNodeId(node.id);
                            setSelectedEdgeId('');
                            const rect = event.currentTarget.getBoundingClientRect();
                            dragRef.current = {
                              nodeId: node.id,
                              offsetX: event.clientX - rect.left,
                              offsetY: event.clientY - rect.top,
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
                          <span className="workflow-node-type">{node.node_type === 'role' ? t('workteam.角色') : t('workteam.任务')}</span>
                          <strong>{node.name}</strong>
                          <span className="workflow-node-meta">{positionLabel(node)}</span>
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
                </section>

                <section className="workflow-detail-grid">
                  <div className="workflow-inspector">
                    <h3>{t('workteam.属性面板')}</h3>
                    {selectedNode ? (
                      <NodeInspector
                        key={selectedNode.id}
                        node={selectedNode}
                        roleNodes={selectedRoleNodes}
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
                        nodes={snapshot.nodes}
                        canManage={canManage}
                        busy={busy}
                        onSave={(body) => void updateEdge(selectedEdge.id, body)}
                        onDelete={() => void deleteEdge(selectedEdge.id)}
                        onReconnectStart={() => startReconnect(selectedEdge.id, 'source')}
                        onReconnectEnd={() => startReconnect(selectedEdge.id, 'target')}
                      />
                    ) : (
                      <div className="workflow-hint">
                        {t('workteam.选择一个节点或连线开始编辑')}
                      </div>
                    )}
                  </div>

                  <div className="workflow-run-panel">
                    <h3>{t('workteam.运行台')}</h3>
                    <div className="workflow-run-create">
                      <textarea
                        value={runInput}
                        onChange={(event) => setRunInput(event.target.value)}
                        placeholder={t('workteam.输入整张图的全局上下文')}
                      />
                      <div className="workflow-run-actions">
                        <button type="button" className="btn-primary" disabled={!canManage || busy} onClick={() => void startRun()}>
                          {t('workteam.启动运行')}
                        </button>
                        <button type="button" className="btn-outline btn-sm" disabled={!selectedRunId || busy} onClick={() => void runControl('pause')}>
                          {t('workteam.暂停整图')}
                        </button>
                        <button type="button" className="btn-outline btn-sm" disabled={!selectedRunId || busy} onClick={() => void runControl('resume')}>
                          {t('workteam.继续整图')}
                        </button>
                        <button type="button" className="btn-outline btn-sm" disabled={!selectedRunId || busy} onClick={() => void runControl('cancel')}>
                          {t('workteam.取消整图')}
                        </button>
                      </div>
                    </div>

                    <div className="workflow-run-list">
                      {runs.map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          className={`workflow-run-card${run.id === selectedRunId ? ' selected' : ''}`}
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          <strong>{run.status}</strong>
                          <span>{fmt(run.created_at)}</span>
                          <span>{run.id.slice(0, 8)}…</span>
                        </button>
                      ))}
                    </div>

                    {runGraph ? (
                      <div className="workflow-run-graph">
                        <div className="workflow-run-summary">
                          <div>{t('workteam.状态')}：{runGraph.run.status}</div>
                          <div>{t('workteam.开始')}：{runGraph.run.started_at ? fmt(runGraph.run.started_at) : t('workteam.未开始')}</div>
                          <div>{t('workteam.结束')}：{runGraph.run.completed_at ? fmt(runGraph.run.completed_at) : t('workteam.进行中')}</div>
                        </div>
                        <div className="workflow-run-output">
                          <h4>{t('workteam.整图输出')}</h4>
                          <pre>{runGraph.run.output || t('workteam.暂无汇总输出')}</pre>
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.讨论边')}</h4>
                          {discussionEdgeSummaries.length === 0 ? (
                            <div className="workflow-hint">{t('workteam.当前运行里还没有双向讨论边消息')}</div>
                          ) : (
                            <div className="workflow-edge-summary-list">
                              {discussionEdgeSummaries.map(({ edge, count, latestAt, latestPreview, turnCount, sessionStatus }) => (
                                <button
                                  key={edge.id}
                                  type="button"
                                  className={`workflow-edge-summary-card${selectedEdgeId === edge.id ? ' selected' : ''}`}
                                  onClick={() => {
                                    setSelectedEdgeId(edge.id);
                                    setSelectedNodeId('');
                                  }}
                                >
                                  <strong>
                                    {displayNodeName(snapshot.nodes, edge.source_node_id)}
                                    {' <-> '}
                                    {displayNodeName(snapshot.nodes, edge.target_node_id)}
                                  </strong>
                                  <span>
                                    {t('workteam.个frameN轮', { count, turnCount })}
                                    {latestAt ? ` · ${fmt(latestAt)}` : ''}
                                    {sessionStatus ? ` · ${sessionStatus}` : ''}
                                  </span>
                                  <p>{latestPreview || t('workteam.暂无内容')}</p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.边级消息面板')}</h4>
                          {selectedEdge ? (
                            <>
                              <div className="workflow-hint">
                                {selectedEdgeSessions.length > 0
                                  ? t('workteam.当前边共有N个dialogueSession', { count: selectedEdgeSessions.length, status: selectedEdgeSessions.at(-1)?.status || 'active', turnCount: selectedEdgeSessions.at(-1)?.turn_count || 0 })
                                  : t('workteam.当前边还没有独立dialogueSession')}
                              </div>
                              <div className="workflow-message-toolbar">
                                <input
                                  value={edgeFeedbackText}
                                  onChange={(event) =>
                                    setEdgeFeedbackText(event.target.value)
                                  }
                                  placeholder={t('workteam.插入一条feedbackFrame')}
                                />
                                <select
                                  value={edgeFeedbackDirection}
                                  onChange={(event) =>
                                    setEdgeFeedbackDirection(
                                      event.target.value as 'forward' | 'reverse',
                                    )
                                  }
                                >
                                  <option value="forward">{t('workteam.正向反馈')}</option>
                                  <option value="reverse">{t('workteam.反向反馈')}</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => void createEdgeFeedback()}
                                  disabled={busy || !edgeFeedbackText.trim()}
                                >
                                  {t('workteam.插入反馈')}
                                </button>
                              </div>
                              <div className="workflow-message-toolbar">
                                <input
                                  value={edgeMessageQuery}
                                  onChange={(event) => setEdgeMessageQuery(event.target.value)}
                                  placeholder={t('workteam.搜索消息内容来源或目标节点')}
                                />
                                <select
                                  value={edgeDirectionFilter}
                                  onChange={(event) =>
                                    setEdgeDirectionFilter(
                                      event.target.value as EdgeDirectionFilter,
                                    )
                                  }
                                >
                                  <option value="all">{t('workteam.全部方向')}</option>
                                  <option value="forward">{t('workteam.正向')}</option>
                                  <option value="reverse">{t('workteam.反向')}</option>
                                </select>
                              </div>
                              {edgeMessageGroups.length === 0 ? (
                                <div className="workflow-hint">{t('workteam.这条边当前没有符合筛选条件的消息')}</div>
                              ) : (
                                edgeMessageGroups.map((group) => {
                                  const collapsed = collapsedRounds.includes(group.roundKey);
                                  return (
                                    <div key={group.roundKey} className="workflow-round-group">
                                      <button
                                        type="button"
                                        className="workflow-round-toggle"
                                        onClick={() => toggleCollapsedRound(group.roundKey)}
                                      >
                                        <strong>{group.label}</strong>
                                        <span>
                                          {group.messages.length} {t('workteam.条消息')}
                                          {collapsed ? t('workteam.已折叠') : t('workteam.展开中')}
                                        </span>
                                      </button>
                                      {!collapsed
                                        ? group.messages.map((message) => (
                                            <div key={message.id} className="workflow-message-card">
                                              <strong>
                                                {displayNodeName(snapshot.nodes, message.source_node_id)}
                                                {' -> '}
                                                {displayNodeName(snapshot.nodes, message.target_node_id)}
                                              </strong>
                                              <span>
                                                {message.direction === 'two_way' ? t('workteam.双向链路') : t('workteam.单向链路')}
                                                {message.turn_index
                                                  ? ` · ${t('workteam.第N轮', { n: message.turn_index })}`
                                                  : message.payload.discussionCount
                                                    ? ` · ${t('workteam.第N轮', { n: message.payload.discussionCount })}`
                                                    : ''}
                                                {' · '}
                                                {message.frame_type}
                                                {' · '}
                                                {fmt(message.created_at)}
                                              </span>
                                              <pre>
                                                {message.content_text ||
                                                  message.payload.content ||
                                                  extractMessageContent(message.payload_json)}
                                              </pre>
                                            </div>
                                          ))
                                        : null}
                                    </div>
                                  );
                                })
                              )}
                            </>
                          ) : (
                            <div className="workflow-hint">{t('workteam.选中一条连线后显示完整往返消息')}</div>
                          )}
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.节点讨论历史')}</h4>
                          {selectedNode ? (
                            <>
                              <div className="workflow-message-toolbar">
                                <input
                                  value={nodeHistoryQuery}
                                  onChange={(event) => setNodeHistoryQuery(event.target.value)}
                                  placeholder={t('workteam.搜索输入消息干预或输出')}
                                />
                                <select
                                  value={nodeInputPriorityMode}
                                  onChange={(event) =>
                                    void saveNodeInputPriorityMode(
                                      event.target.value as
                                        | 'feedback_first'
                                        | 'chronological',
                                    )
                                  }
                                >
                                  <option value="feedback_first">{t('workteam.反馈优先')}</option>
                                  <option value="chronological">{t('workteam.纯时间顺序')}</option>
                                </select>
                                {selectedRunNode?.input_anchor_frame_id ? (
                                  <button
                                    type="button"
                                    className="btn-outline btn-sm"
                                    onClick={() => void saveNodeInputConfig('')}
                                    disabled={busy}
                                  >
                                    {t('workteam.清除输入基线')}
                                  </button>
                                ) : null}
                              </div>
                              {filteredNodeHistoryEntries.length === 0 ? (
                                <div className="workflow-hint">{t('workteam.该节点当前还没有符合筛选条件的历史')}</div>
                              ) : (
                                filteredNodeHistoryEntries.map((entry) => (
                                  <div key={entry.id} className={`workflow-message-card is-${entry.kind}`}>
                                    <strong>{entry.title}</strong>
                                    <span>{entry.subtitle}</span>
                                    <pre>{entry.content}</pre>
                                    {(entry.kind === 'message' ||
                                      entry.kind === 'output' ||
                                      entry.kind === 'intervention') &&
                                    selectedNode.node_type === 'task' ? (
                                      <div className="workflow-message-actions">
                                        <button
                                          type="button"
                                          className="btn-outline btn-sm"
                                          onClick={() => void applyHistoryEntryToNodeInput(entry.content)}
                                        >
                                          {t('workteam.回填为节点输入')}
                                        </button>
                                        {entry.anchorFrameId ? (
                                          <button
                                            type="button"
                                            className="btn-outline btn-sm"
                                            onClick={() =>
                                              void saveNodeInputConfig(entry.anchorFrameId || '')
                                            }
                                          >
                                            {selectedRunNode?.input_anchor_frame_id === entry.anchorFrameId
                                              ? t('workteam.当前输入基线')
                                              : t('workteam.设为输入基线')}
                                          </button>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                ))
                              )}
                            </>
                          ) : (
                            <div className="workflow-hint">{t('workteam.选中节点后显示输入快照讨论消息人工干预和输出快照')}</div>
                          )}
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.节点执行时间线')}</h4>
                          {selectedNode ? (
                            selectedNodeExecutions.length === 0 ? (
                              <div className="workflow-hint">{t('workteam.该节点当前还没有独立execution记录')}</div>
                            ) : (
                              <>
                                <div className="workflow-execution-list">
                                  {selectedNodeExecutions.map((execution) => (
                                    <div key={execution.id} className={`workflow-execution-card is-${execution.status}`}>
                                      <strong>{execution.status}</strong>
                                      <span>{fmt(execution.created_at)}</span>
                                      <span>runtime: {execution.runtime_namespace.slice(0, 8)}…</span>
                                      <span>group: {execution.group_folder}</span>
                                      {execution.session_id ? (
                                        <span>session: {execution.session_id.slice(0, 12)}…</span>
                                      ) : null}
                                      {execution.error_text ? (
                                        <pre>{execution.error_text}</pre>
                                      ) : null}
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
                            <div className="workflow-hint">{t('workteam.选中节点后显示execution和turnevent日志')}</div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="workflow-hint">{t('workteam.选择一次运行查看节点输入输出消息流和人工干预记录')}</div>
                    )}
                  </div>
                </section>

                <WorkflowRepositoryPanel
                  apiBase={apiBase}
                  workflowId={snapshot.workflow.id}
                  canManage={canManage}
                  boundAssistantNames={snapshot.nodes
                    .filter((node) => node.node_type === 'role' && node.assistant_id)
                    .map((node) => {
                      const assistant = assistants.find(
                        (item) => item.id === node.assistant_id,
                      );
                      return assistant?.name || node.assistant_id;
                    })}
                />
              </>
            )}
          </main>
        </section>
      </div>
    </div>
  );
}

function extractMessageContent(raw: string): string {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (typeof payload.content === 'string') return payload.content;
    return JSON.stringify(payload, null, 2);
  } catch {
    return raw;
  }
}

function NodeInspector({
  node,
  roleNodes,
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
  roleNodes: WorkflowNodeRecord[];
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
  const roleConfig = parseJsonObject<RoleConfig>(node.config_json);
  const taskConfig = parseJsonObject<TaskConfig>(node.config_json);
  const [name, setName] = useState(node.name);
  const [description, setDescription] = useState(node.description);
  const [assistantId, setAssistantId] = useState(node.assistant_id);
  const [roleNodeId, setRoleNodeId] = useState(node.role_node_id);
  const [goal, setGoal] = useState(roleConfig.goal || '');
  const [backstory, setBackstory] = useState(roleConfig.backstory || '');
  const [prompt, setPrompt] = useState(taskConfig.prompt || '');
  const [expectedOutput, setExpectedOutput] = useState(taskConfig.expectedOutput || '');
  const [timeoutMs, setTimeoutMs] = useState(String(taskConfig.timeoutMs || 600000));
  const [approvalRequired, setApprovalRequired] = useState(Boolean(taskConfig.approvalRequired));
  const [providerOverrideId, setProviderOverrideId] = useState(taskConfig.providerOverrideId || '');
  const [modelOverride, setModelOverride] = useState(taskConfig.modelOverride || '');
  const [instructionsAppend, setInstructionsAppend] = useState(taskConfig.instructionsAppend || '');
  const [allowedDirectories, setAllowedDirectories] = useState(
    Array.isArray(taskConfig.allowedDirectories)
      ? taskConfig.allowedDirectories.join('\n')
      : '',
  );
  const [runInput, setRunInput] = useState(runNode?.input_snapshot || '');
  const [runOutput, setRunOutput] = useState(runNode?.output_snapshot || '');

  useEffect(() => {
    setRunInput(runNode?.input_snapshot || '');
    setRunOutput(runNode?.output_snapshot || '');
  }, [runNode?.input_snapshot, runNode?.output_snapshot]);

  return (
    <div className="workflow-inspector-body">
      <div className="workflow-inspector-header">
        <span className={`workflow-node-badge type-${node.node_type}`}>
          {node.node_type === 'role' ? t('workteam.角色节点') : t('workteam.任务节点')}
        </span>
        <button type="button" onClick={onDelete} disabled={!canManage || busy}>
          {t('workteam.删除节点')}
        </button>
      </div>
      <label>
        {t('workteam.名称')}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {t('workteam.描述')}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>

      {node.node_type === 'role' ? (
        <>
          <label>
            {t('workteam.绑定助手')}
            <select value={assistantId} onChange={(event) => setAssistantId(event.target.value)}>
              <option value="">{t('workteam.不绑定')}</option>
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('workteam.目标')}
            <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label>
            {t('workteam.背景')}
            <textarea value={backstory} onChange={(event) => setBackstory(event.target.value)} />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!canManage || busy}
            onClick={() =>
              onSave({
                name,
                description,
                assistant_id: assistantId,
                config_json: { goal, backstory },
              })
            }
          >
            {t('workteam.保存角色节点')}
          </button>
        </>
      ) : (
        <>
          <label>
            {t('workteam.角色绑定')}
            <select value={roleNodeId} onChange={(event) => setRoleNodeId(event.target.value)}>
              <option value="">{t('workteam.请选择角色节点')}</option>
              {roleNodes.map((roleNode) => (
                <option key={roleNode.id} value={roleNode.id}>
                  {roleNode.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <label>
            {t('workteam.预期输出')}
            <textarea value={expectedOutput} onChange={(event) => setExpectedOutput(event.target.value)} />
          </label>
          <label>
            {t('workteam.超时毫秒')}
            <input value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
          </label>
          <label>
            Provider Override
            <input
              value={providerOverrideId}
              onChange={(event) => setProviderOverrideId(event.target.value)}
              placeholder={t('workteam.providerId可选')}
            />
          </label>
          <label>
            Model Override
            <input
              value={modelOverride}
              onChange={(event) => setModelOverride(event.target.value)}
              placeholder={t('workteam.model可选')}
            />
          </label>
          <label>
            {t('workteam.追加指令')}
            <textarea
              value={instructionsAppend}
              onChange={(event) => setInstructionsAppend(event.target.value)}
              placeholder={t('workteam.附加到assistant指令之后')}
            />
          </label>
          <label>
            {t('workteam.允许目录覆盖')}
            <textarea
              value={allowedDirectories}
              onChange={(event) => setAllowedDirectories(event.target.value)}
              placeholder="/repo/path&#10;/repo/path/subdir"
            />
          </label>
          <label className="workflow-inline-toggle">
            <input
              type="checkbox"
              checked={approvalRequired}
              onChange={(event) => setApprovalRequired(event.target.checked)}
            />
            {t('workteam.需要人工批准')}
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!canManage || busy || !roleNodeId.trim()}
            onClick={() =>
              onSave({
                name,
                description,
                role_node_id: roleNodeId,
                config_json: {
                  prompt,
                  expectedOutput,
                  timeoutMs: Number(timeoutMs) || 600000,
                  approvalRequired,
                  providerOverrideId: providerOverrideId || undefined,
                  modelOverride: modelOverride || undefined,
                  instructionsAppend: instructionsAppend || undefined,
                  allowedDirectories: allowedDirectories
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
              })
            }
          >
            {t('workteam.保存任务节点')}
          </button>

          {runNode ? (
            <div className="workflow-run-edit-panel">
              <h4>{t('workteam.运行态干预')}</h4>
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
            </div>
          ) : null}
        </>
      )}
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
  const [discussionTurns, setDiscussionTurns] = useState(
    String(edgeConfig.discussionTurns ?? 4),
  );

  return (
    <div className="workflow-inspector-body">
      <div className="workflow-inspector-header">
        <span className="workflow-node-badge type-edge">{t('workteam.消息流边')}</span>
        <button type="button" className="btn-outline btn-sm" onClick={onDelete} disabled={!canManage || busy}>
          {t('workteam.删除连线')}
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
      {direction === 'two_way' ? (
        <label>
          {t('workteam.讨论轮次预算')}
          <input
            value={discussionTurns}
            onChange={(event) => setDiscussionTurns(event.target.value)}
          />
        </label>
      ) : null}
      {direction === 'two_way' ? (
        <div className="workflow-hint">
          {t('workteam.双向边会在初始执行后按预算自动把对端节点重新置为pending形成可见的多轮讨论')}
        </div>
      ) : null}
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
