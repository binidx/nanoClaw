import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import {
  CatalogPageShell,
  LibraryCard,
  SearchPill,
} from '../components/common';
import { getUrlSubPath } from '../router/paths';
import { useWebSocket } from '../hooks/useWebSocket';
import type { AiProvider } from '../app-types';
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

interface RoleConfig {
  goal?: string;
  backstory?: string;
}

interface TaskConfig {
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

interface WorkflowCardSummary {
  workerCount: number;
  edgeCount: number;
  latestRunStatus?: WorkflowRunStatus;
  latestRunAt?: string;
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

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function nodeAccent(node: WorkflowNodeRecord): string {
  if (node.node_type === 'role') return '#1d4ed8';
  return '#0f766e';
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 3.2v9.6l8-4.8-8-4.8Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10.5 10.5 13.5 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6 11.3 4.7M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PublishIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.5 2.5 7 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="m13.5 2.5-4.4 11-2.1-4.9-4.9-2.1 11.4-3.9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
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

function workerNodesFromSnapshot(
  snapshot: WorkflowSnapshot | null,
): WorkflowNodeRecord[] {
  return snapshot?.nodes.filter((node) => node.node_type === 'task') ?? [];
}

function visibleEdgesFromSnapshot(
  snapshot: WorkflowSnapshot | null,
): WorkflowEdgeRecord[] {
  if (!snapshot) return [];
  const workerNodeIds = new Set(
    snapshot.nodes
      .filter((node) => node.node_type === 'task')
      .map((node) => node.id),
  );
  return snapshot.edges.filter(
    (edge) =>
      workerNodeIds.has(edge.source_node_id) &&
      workerNodeIds.has(edge.target_node_id),
  );
}

function resolveNodeAssistantId(node: WorkflowNodeRecord): string {
  const taskConfig = parseJsonObject<TaskConfig>(node.config_json);
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
  const [providers, setProviders] = useState<AiProvider[]>([]);
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
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [activeModal, setActiveModal] = useState<'create' | 'settings' | null>(
    null,
  );
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [runInput, setRunInput] = useState('');
  const [runPanelExpanded, setRunPanelExpanded] = useState(false);
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

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/user/providers?capability=llm`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      setProviders((await res.json()) as AiProvider[]);
    } catch {
      setProviders([]);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadWorkflows().catch((err) => setError(String(err)));
    void loadAssistants();
    void loadProviders();
  }, [loadWorkflows, loadAssistants, loadProviders]);

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

  const visibleWorkerNodes = useMemo(
    () => workerNodesFromSnapshot(snapshot),
    [snapshot],
  );

  const visibleWorkflowEdges = useMemo(
    () => visibleEdgesFromSnapshot(snapshot),
    [snapshot],
  );

  const currentWorkflowConfig = useMemo(
    () => (snapshot ? parseWorkflowConfig(snapshot.workflow.workflow_config) : null),
    [snapshot],
  );

  const providerOptions = useMemo(
    () => [
      { value: '', label: t('workteam.跟随assistant默认Provider') },
      ...providers
        .filter((provider) => (provider.capability || 'llm') === 'llm')
        .map((provider) => ({
          value: provider.id,
          label:
            provider.model && provider.is_default !== 1
              ? `${provider.alias} · ${provider.model}`
              : provider.alias,
        })),
    ],
    [providers, t],
  );

  const filteredWorkflows = useMemo(() => {
    const query = workflowQuery.trim().toLowerCase();
    return workflows.filter(
      (workflow) =>
        !query ||
        workflow.name.toLowerCase().includes(query) ||
        workflow.description.toLowerCase().includes(query),
    );
  }, [workflowQuery, workflows]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
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

  const toggleCanvasFullscreen = useCallback(() => {
    const panel = canvasPanelRef.current;
    if (!panel) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void panel.requestFullscreen();
  }, []);

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

  const ensureWorkerRoleNode = async (): Promise<WorkflowNodeRecord | null> => {
    if (!workflowId || !snapshot) return null;
    const existingInternalRole = snapshot.nodes.find((node) => {
      if (node.node_type !== 'role') return false;
      const config = parseJsonObject<Record<string, unknown>>(node.config_json);
      return config.uiHidden === true || node.name === 'Internal worker role';
    });
    if (existingInternalRole) return existingInternalRole;
    const existingRole = snapshot.nodes.find((node) => node.node_type === 'role');
    if (existingRole) return existingRole;
    const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_type: 'role',
        name: 'Internal worker role',
        description: 'Internal role used by assistant worker nodes.',
        config_json: {
          goal: 'Route assistant worker execution.',
          backstory: 'Generated by the workflow UI to satisfy the current run graph model.',
          uiHidden: true,
        },
        position_x: 40,
        position_y: 40,
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    return (await res.json()) as WorkflowNodeRecord;
  };

  const createWorkerNode = async () => {
    if (!workflowId || !snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const roleNode = await ensureWorkerRoleNode();
      if (!roleNode) return;
      const count = snapshot.nodes.filter((node) => node.node_type === 'task').length;
      const res = await fetch(`${apiBase}/api/workflows/${workflowId}/nodes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'task',
          name: t('workteam.workerN', { n: count + 1 }),
          description: '',
          role_node_id: roleNode.id,
          config_json: {
            prompt: '',
            expectedOutput: '',
            timeoutMs: 600000,
            approvalRequired: false,
          },
          position_x: 120 + (count % 3) * 300,
          position_y: 100 + Math.floor(count / 3) * 170,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const node = (await res.json()) as WorkflowNodeRecord;
      setSelectedNodeId(node.id);
      setSelectedNodeIds([node.id]);
      setSelectedEdgeId('');
      await loadSnapshot();
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

  const publishWorkflow = useCallback(async () => {
    await saveCurrentWorkflow('active');
  }, [saveCurrentWorkflow]);

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

  if (!snapshot) {
    return (
      <CatalogPageShell
        title={t('pageTitle')}
        subtitle={t('workteam.连接节点构建自动化流程')}
        className="workflow-catalog-page"
        controls={
          <>
            <SearchPill
              value={workflowQuery}
              onChange={setWorkflowQuery}
              placeholder={t('workteam.搜索工作流')}
              aria-label={t('workteam.搜索工作流')}
              leadingIcon={<SearchIcon />}
              clearLabel={t('清空搜索')}
            />
            <button
              type="button"
              className="btn-primary workflow-create-action"
              disabled={!canCreateWorkflow || busy}
              onClick={() => setActiveModal('create')}
            >
              <span className="workflow-topbar-btn-icon">
                <PlusIcon />
              </span>
              {t('workteam.新建工作流')}
            </button>
          </>
        }
      >
        {error ? <div className="workflow-banner error">{error}</div> : null}
        {info ? <div className="workflow-banner info">{info}</div> : null}
        {filteredWorkflows.length === 0 ? (
          <div className="nc-catalog-empty">
            <h3>{t('workteam.先选择或创建一个工作流')}</h3>
          </div>
        ) : (
          <div className="nc-catalog-grid">
            {filteredWorkflows.map((workflow) => {
              const summary = workflowSummaries[workflow.id];
              const config = parseWorkflowConfig(workflow.workflow_config);
              const kindLabel =
                config.kind === 'repository'
                  ? t('workteam.仓库')
                  : config.kind === 'skill'
                    ? t('workteam.技能')
                    : config.kind === 'mcp'
                      ? t('workteam.MCP')
                      : config.kind === 'system_capability'
                        ? t('workteam.系统能力')
                        : t('workteam.通用');
              const visibilityLabel =
                config.visibility === 'shared'
                  ? t('workteam.共享')
                  : config.visibility === 'system'
                    ? t('workteam.系统')
                    : t('workteam.私有');
              return (
                <LibraryCard
                  key={workflow.id}
                  className={`workflow-catalog-card ${
                    activeWorkflowId === workflow.id ? 'active' : ''
                  }`}
                  onClick={() => setActiveWorkflowId(workflow.id)}
                  heading={workflow.name}
                  badge={
                    <span
                      className={`repo-review-badge workflow-card-badge is-${workflow.status}`}
                    >
                      {workflow.status}
                    </span>
                  }
                  bodyClassName="workflow-card-body"
                  rows={[
                    {
                      label: t('workteam.说明'),
                      value: workflow.description || t('workteam.无描述'),
                    },
                    {
                      label: t('workteam.类型'),
                      value: `${kindLabel} · ${visibilityLabel}`,
                    },
                    {
                      label: t('workteam.结构'),
                      value: `${summary?.workerCount ?? 0} ${t('workteam.节点')} · ${
                        summary?.edgeCount ?? 0
                      } ${t('workteam.连线')}`,
                    },
                    {
                      label: t('workteam.运行'),
                      value: summary?.latestRunStatus
                        ? `${summary.latestRunStatus}${
                            summary.latestRunAt
                              ? ` · ${fmt(summary.latestRunAt)}`
                              : ''
                          }`
                        : t('workteam.未运行'),
                    },
                  ]}
                />
              );
            })}
          </div>
        )}
      </CatalogPageShell>
    );
  }

  return (
    <div className="page-view workflow-page is-workspace">
      <div className="workflow-topbar">
        <div className="workflow-topbar-title">
          <div
            className="workflow-title-stack is-clickable"
            onClick={() => setActiveWorkflowId('')}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setActiveWorkflowId('');
              }
            }}
          >
            <h2>{t('pageTitle')}</h2>
          </div>
        </div>
        <div className="workflow-topbar-controls">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setRunPanelExpanded(true);
              void startRun();
            }}
            disabled={!workflowId || busy}
          >
            <span className="workflow-topbar-btn-icon">
              <PlayIcon />
            </span>
            {t('workteam.运行')}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => setActiveModal('settings')}
            disabled={!workflowId || !snapshot}
          >
            <span className="workflow-topbar-btn-icon">
              <SettingsIcon />
            </span>
            {t('workteam.配置')}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => void publishWorkflow()}
            disabled={!workflowId || !snapshot || busy}
          >
            <span className="workflow-topbar-btn-icon">
              <PublishIcon />
            </span>
            {t('workteam.发布')}
          </button>
        </div>
      </div>

      <div className="page-body workflow-body">
        {error ? <div className="workflow-banner error">{error}</div> : null}
        {info ? <div className="workflow-banner info">{info}</div> : null}
        <section className="workflow-workbench">
            <div className="workflow-workbench-grid">
              <section className="workflow-canvas-panel" ref={canvasPanelRef}>
                <div className="workflow-canvas-toolbar">
                  <div className="workflow-canvas-status">
                    <span className="workflow-metric-chip">
                      {workflowStats?.workers ?? 0} {t('workteam.节点')} /{' '}
                      {workflowStats?.edges ?? 0} {t('workteam.连线')}
                    </span>
                    <span>
                      {reconnectState
                        ? t('workteam.重连模式', {
                            end:
                              reconnectState.end === 'source'
                                ? t('workteam.起点')
                                : t('workteam.终点'),
                          })
                        : connectFromNodeId
                          ? t('workteam.连接模式')
                          : selectedNodeIds.length > 1
                            ? t('workteam.已选中N个节点可批量拖动', {
                                n: selectedNodeIds.length,
                              })
                            : t('workteam.点击节点进入编辑')}
                    </span>
                  </div>
                  <div className="workflow-canvas-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void createWorkerNode()}
                      disabled={!canManage || busy}
                    >
                      {t('workteam.添加worker')}
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
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={toggleCanvasFullscreen}
                    >
                      {t('workteam.全屏')}
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
                          borderColor: nodeAccent(node),
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
                        <span className="workflow-node-type">
                          {t('workteam.助手worker')}
                        </span>
                        <strong>{node.name}</strong>
                        <span className="workflow-node-meta">
                          {assistantName || t('workteam.未选择assistant')}
                        </span>
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
                </div>
              </section>

              <aside className="workflow-detail-grid">
                <div className="workflow-inspector">
                  <h3>{t('workteam.属性面板')}</h3>
                  {selectedNode ? (
                    <NodeInspector
                      key={selectedNode.id}
                      node={selectedNode}
                      assistants={assistants}
                      providerOptions={providerOptions}
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
                        className="workflow-run-icon-btn is-primary"
                        disabled={!workflowId || !canManage || busy}
                        onClick={() => void startRun()}
                        aria-label={t('workteam.启动运行')}
                        title={t('workteam.启动运行')}
                      >
                        <PlayIcon />
                      </button>
                      <button
                        type="button"
                        className="workflow-run-icon-btn"
                        disabled={!selectedRunId || busy}
                        onClick={() =>
                          void runControl(
                            selectedRun?.status === 'paused' ? 'resume' : 'pause',
                          )
                        }
                        aria-label={
                          selectedRun?.status === 'paused'
                            ? t('workteam.继续整图')
                            : t('workteam.暂停整图')
                        }
                        title={
                          selectedRun?.status === 'paused'
                            ? t('workteam.继续整图')
                            : t('workteam.暂停整图')
                        }
                      >
                        {selectedRun?.status === 'paused' ? (
                          <PlayIcon />
                        ) : (
                          <PauseIcon />
                        )}
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
                      <details className="workflow-advanced-details">
                        <summary>{t('workteam.高级调试信息')}</summary>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.讨论边')}</h4>
                          {discussionEdgeSummaries.length === 0 ? (
                            <div className="workflow-hint">
                              {t('workteam.当前运行里还没有双向讨论边消息')}
                            </div>
                          ) : (
                            <div className="workflow-edge-summary-list">
                              {discussionEdgeSummaries.map(
                                ({
                                  edge,
                                  count,
                                  latestAt,
                                  latestPreview,
                                  turnCount,
                                  sessionStatus,
                                }) => (
                                  <button
                                    key={edge.id}
                                    type="button"
                                    className={`workflow-edge-summary-card${
                                      selectedEdgeId === edge.id ? ' selected' : ''
                                    }`}
                                    onClick={() => {
                                      setSelectedEdgeId(edge.id);
                                      setSelectedNodeId('');
                                    }}
                                  >
                                    <strong>
                                      {displayNodeName(
                                        snapshot.nodes,
                                        edge.source_node_id,
                                      )}
                                      {' <-> '}
                                      {displayNodeName(
                                        snapshot.nodes,
                                        edge.target_node_id,
                                      )}
                                    </strong>
                                    <span>
                                      {t('workteam.个frameN轮', {
                                        count,
                                        turnCount,
                                      })}
                                      {latestAt ? ` · ${fmt(latestAt)}` : ''}
                                      {sessionStatus ? ` · ${sessionStatus}` : ''}
                                    </span>
                                    <p>
                                      {latestPreview || t('workteam.暂无内容')}
                                    </p>
                                  </button>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.边级消息面板')}</h4>
                          {selectedEdge ? (
                            <>
                              <div className="workflow-hint">
                                {selectedEdgeSessions.length > 0
                                  ? t(
                                      'workteam.当前边共有N个dialogueSession',
                                      {
                                        count: selectedEdgeSessions.length,
                                        status:
                                          selectedEdgeSessions.at(-1)?.status ||
                                          'active',
                                        turnCount:
                                          selectedEdgeSessions.at(-1)
                                            ?.turn_count || 0,
                                      },
                                    )
                                  : t('workteam.当前边还没有独立dialogueSession')}
                              </div>
                              <div className="workflow-message-toolbar">
                                <input
                                  value={edgeFeedbackText}
                                  onChange={(event) =>
                                    setEdgeFeedbackText(event.target.value)
                                  }
                                  placeholder={t(
                                    'workteam.插入一条feedbackFrame',
                                  )}
                                />
                                <select
                                  value={edgeFeedbackDirection}
                                  onChange={(event) =>
                                    setEdgeFeedbackDirection(
                                      event.target.value as
                                        | 'forward'
                                        | 'reverse',
                                    )
                                  }
                                >
                                  <option value="forward">
                                    {t('workteam.正向反馈')}
                                  </option>
                                  <option value="reverse">
                                    {t('workteam.反向反馈')}
                                  </option>
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
                                  onChange={(event) =>
                                    setEdgeMessageQuery(event.target.value)
                                  }
                                  placeholder={t(
                                    'workteam.搜索消息内容来源或目标节点',
                                  )}
                                />
                                <select
                                  value={edgeDirectionFilter}
                                  onChange={(event) =>
                                    setEdgeDirectionFilter(
                                      event.target.value as EdgeDirectionFilter,
                                    )
                                  }
                                >
                                  <option value="all">
                                    {t('workteam.全部方向')}
                                  </option>
                                  <option value="forward">
                                    {t('workteam.正向')}
                                  </option>
                                  <option value="reverse">
                                    {t('workteam.反向')}
                                  </option>
                                </select>
                              </div>
                              {edgeMessageGroups.length === 0 ? (
                                <div className="workflow-hint">
                                  {t('workteam.这条边当前没有符合筛选条件的消息')}
                                </div>
                              ) : (
                                edgeMessageGroups.map((group) => {
                                  const collapsed = collapsedRounds.includes(
                                    group.roundKey,
                                  );
                                  return (
                                    <div
                                      key={group.roundKey}
                                      className="workflow-round-group"
                                    >
                                      <button
                                        type="button"
                                        className="workflow-round-toggle"
                                        onClick={() =>
                                          toggleCollapsedRound(group.roundKey)
                                        }
                                      >
                                        <strong>{group.label}</strong>
                                        <span>
                                          {group.messages.length}{' '}
                                          {t('workteam.条消息')}
                                          {collapsed
                                            ? t('workteam.已折叠')
                                            : t('workteam.展开中')}
                                        </span>
                                      </button>
                                      {!collapsed
                                        ? group.messages.map((message) => (
                                            <div
                                              key={message.id}
                                              className="workflow-message-card"
                                            >
                                              <strong>
                                                {displayNodeName(
                                                  snapshot.nodes,
                                                  message.source_node_id,
                                                )}
                                                {' -> '}
                                                {displayNodeName(
                                                  snapshot.nodes,
                                                  message.target_node_id,
                                                )}
                                              </strong>
                                              <span>
                                                {message.direction === 'two_way'
                                                  ? t('workteam.双向链路')
                                                  : t('workteam.单向链路')}
                                                {message.turn_index
                                                  ? ` · ${t(
                                                      'workteam.第N轮',
                                                      { n: message.turn_index },
                                                    )}`
                                                  : message.payload
                                                        .discussionCount
                                                    ? ` · ${t(
                                                        'workteam.第N轮',
                                                        {
                                                          n: message.payload
                                                            .discussionCount,
                                                        },
                                                      )}`
                                                    : ''}
                                                {' · '}
                                                {message.frame_type}
                                                {' · '}
                                                {fmt(message.created_at)}
                                              </span>
                                              <pre>
                                                {message.content_text ||
                                                  message.payload.content ||
                                                  extractMessageContent(
                                                    message.payload_json,
                                                  )}
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
                            <div className="workflow-hint">
                              {t('workteam.选中一条连线后显示完整往返消息')}
                            </div>
                          )}
                        </div>
                        <div className="workflow-run-messages">
                          <h4>{t('workteam.节点讨论历史')}</h4>
                          {selectedNode ? (
                            <>
                              <div className="workflow-message-toolbar">
                                <input
                                  value={nodeHistoryQuery}
                                  onChange={(event) =>
                                    setNodeHistoryQuery(event.target.value)
                                  }
                                  placeholder={t(
                                    'workteam.搜索输入消息干预或输出',
                                  )}
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
                                  <option value="feedback_first">
                                    {t('workteam.反馈优先')}
                                  </option>
                                  <option value="chronological">
                                    {t('workteam.纯时间顺序')}
                                  </option>
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
                                <div className="workflow-hint">
                                  {t(
                                    'workteam.该节点当前还没有符合筛选条件的历史',
                                  )}
                                </div>
                              ) : (
                                filteredNodeHistoryEntries.map((entry) => (
                                  <div
                                    key={entry.id}
                                    className={`workflow-message-card is-${entry.kind}`}
                                  >
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
                                          onClick={() =>
                                            void applyHistoryEntryToNodeInput(
                                              entry.content,
                                            )
                                          }
                                        >
                                          {t('workteam.回填为节点输入')}
                                        </button>
                                        {entry.anchorFrameId ? (
                                          <button
                                            type="button"
                                            className="btn-outline btn-sm"
                                            onClick={() =>
                                              void saveNodeInputConfig(
                                                entry.anchorFrameId || '',
                                              )
                                            }
                                          >
                                            {selectedRunNode?.input_anchor_frame_id ===
                                            entry.anchorFrameId
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
                            <div className="workflow-hint">
                              {t(
                                'workteam.选中节点后显示输入快照讨论消息人工干预和输出快照',
                              )}
                            </div>
                          )}
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
                                      <span>
                                        runtime:{' '}
                                        {execution.runtime_namespace.slice(0, 8)}…
                                      </span>
                                      <span>group: {execution.group_folder}</span>
                                      {execution.session_id ? (
                                        <span>
                                          session:{' '}
                                          {execution.session_id.slice(0, 12)}…
                                        </span>
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
                            <div className="workflow-hint">
                              {t('workteam.选中节点后显示execution和turnevent日志')}
                            </div>
                          )}
                        </div>
                      </details>
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
      </div>
      {activeModal === 'create' ? (
        <div
          className="modal-overlay workflow-modal-overlay"
          role="presentation"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="modal workflow-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>{t('workteam.新建工作流')}</h3>
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
        <div
          className="modal-overlay workflow-modal-overlay"
          role="presentation"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="modal workflow-modal workflow-modal-wide"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>{t('workteam.配置')}</h3>
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
  const guardrails: WorkflowGuardrailsConfig = config.guardrails || {
    maxDurationMs: 1800000,
    concurrentNodes: 2,
    maxNodeRuns: 50,
    maxTransfers: 100,
    maxToolCalls: 200,
    maxExecutionEvents: 2000,
    maxEstimatedContextCharsPerNode: 60000,
  };
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
          <select
            value={config.kind}
            onChange={(event) =>
              onConfigChange({ kind: event.target.value as WorkflowKind })
            }
          >
            <option value="general">{t('workteam.通用')}</option>
            <option value="repository">{t('workteam.仓库')}</option>
            <option value="skill">{t('workteam.技能')}</option>
            <option value="mcp">{t('workteam.MCP')}</option>
            <option value="system_capability">
              {t('workteam.系统能力')}
            </option>
          </select>
        </label>
        <label>
          {t('workteam.可见性')}
          <select
            value={config.visibility}
            onChange={(event) =>
              onConfigChange({
                visibility: event.target.value as WorkflowVisibility,
              })
            }
          >
            <option value="private">{t('workteam.私有')}</option>
            <option value="shared">{t('workteam.共享')}</option>
            <option value="system">{t('workteam.系统')}</option>
          </select>
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
      <details className="workflow-advanced-details" open>
        <summary>{t('workteam.生产护栏')}</summary>
        <div className="workflow-guardrails-panel">
          <label>
            {t('workteam.最大运行毫秒')}
            <input
              type="number"
              min="1000"
              value={guardrails.maxDurationMs}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    maxDurationMs: Number(event.target.value) || 1800000,
                  },
                })
              }
            />
          </label>
          <label>
            {t('workteam.并发节点数')}
            <input
              type="number"
              min="1"
              value={guardrails.concurrentNodes}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    concurrentNodes: Number(event.target.value) || 1,
                  },
                })
              }
            />
          </label>
          <label>
            {t('workteam.最大节点运行')}
            <input
              type="number"
              min="1"
              value={guardrails.maxNodeRuns}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    maxNodeRuns: Number(event.target.value) || 50,
                  },
                })
              }
            />
          </label>
          <label>
            {t('workteam.最大handoff')}
            <input
              type="number"
              min="0"
              value={guardrails.maxTransfers}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    maxTransfers: Number(event.target.value) || 0,
                  },
                })
              }
            />
          </label>
          <label>
            {t('workteam.最大工具调用')}
            <input
              type="number"
              min="0"
              value={guardrails.maxToolCalls}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    maxToolCalls: Number(event.target.value) || 0,
                  },
                })
              }
            />
          </label>
          <label>
            {t('workteam.最大事件数')}
            <input
              type="number"
              min="1"
              value={guardrails.maxExecutionEvents}
              onChange={(event) =>
                onConfigChange({
                  guardrails: {
                    ...guardrails,
                    maxExecutionEvents: Number(event.target.value) || 2000,
                  },
                })
              }
            />
          </label>
        </div>
      </details>
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
  providerOptions,
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
  providerOptions: Array<{ value: string; label: string }>;
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
  const [goal, setGoal] = useState(roleConfig.goal || '');
  const [backstory, setBackstory] = useState(roleConfig.backstory || '');
  const [prompt, setPrompt] = useState(taskConfig.prompt || '');
  const [expectedOutput, setExpectedOutput] = useState(taskConfig.expectedOutput || '');
  const [timeoutMs] = useState(String(taskConfig.timeoutMs || 600000));
  const [approvalRequired] = useState(Boolean(taskConfig.approvalRequired));
  const [providerOverrideId, setProviderOverrideId] = useState(taskConfig.providerOverrideId || '');
  const [modelOverride, setModelOverride] = useState(taskConfig.modelOverride || '');
  const [instructionsAppend] = useState(taskConfig.instructionsAppend || '');
  const [allowedDirectories] = useState(
    Array.isArray(taskConfig.allowedDirectories)
      ? taskConfig.allowedDirectories.join('\n')
      : '',
  );
  const initialToolPolicy = taskConfig.toolPolicy || {
    mode: 'assistant_default' as const,
    managedSkillIds: [],
    userSkillIds: [],
    managedMcpServerIds: [],
    userMcpServerIds: [],
    managedKbIds: [],
  };
  const [toolPolicyMode] = useState<WorkflowToolPolicy['mode']>(
    initialToolPolicy.mode === 'restricted'
      ? 'restricted'
      : 'assistant_default',
  );
  const [managedSkillIds] = useState(
    (initialToolPolicy.managedSkillIds || []).join(', '),
  );
  const [userSkillIds] = useState(
    (initialToolPolicy.userSkillIds || []).join(', '),
  );
  const [managedMcpServerIds] = useState(
    (initialToolPolicy.managedMcpServerIds || []).join(', '),
  );
  const [userMcpServerIds] = useState(
    (initialToolPolicy.userMcpServerIds || []).join(', '),
  );
  const [managedKbIds] = useState(
    (initialToolPolicy.managedKbIds || []).join(', '),
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
          {node.node_type === 'role'
            ? t('workteam.内部角色')
            : t('workteam.助手worker')}
        </span>
        <button
          type="button"
          className="workflow-delete-btn"
          onClick={onDelete}
          disabled={!canManage || busy}
        >
          {t('workteam.删除')}
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
          <details className="workflow-advanced-details">
            <summary>{t('workteam.更多配置')}</summary>
            <label>
              {t('workteam.目标')}
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
            </label>
            <label>
              {t('workteam.背景')}
              <textarea value={backstory} onChange={(event) => setBackstory(event.target.value)} />
            </label>
          </details>
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
            {t('workteam.选择assistant')}
            <select
              className="workflow-native-select"
              value={assistantId}
              onChange={(event) => setAssistantId(event.target.value)}
            >
              <option value="">{t('workteam.未选择assistant')}</option>
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('workteam.AI Provider')}
            <select
              className="workflow-native-select"
              value={providerOverrideId}
              onChange={(event) => setProviderOverrideId(event.target.value)}
              aria-label={t('workteam.AI Provider')}
            >
              {providerOptions.map((option) => (
                <option key={option.value || 'default'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('workteam.model可选')}
            <input
              value={modelOverride}
              onChange={(event) => setModelOverride(event.target.value)}
              placeholder={t('workteam.留空则跟随Provider默认模型')}
            />
          </label>
          <label>
            {t('workteam.提示词')}
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <label>
            {t('workteam.预期输出')}
            <textarea value={expectedOutput} onChange={(event) => setExpectedOutput(event.target.value)} />
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
                config_json: {
                  assistantId: assistantId || undefined,
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
                  toolPolicy: {
                    mode: toolPolicyMode,
                    managedSkillIds: splitCsv(managedSkillIds),
                    userSkillIds: splitCsv(userSkillIds),
                    managedMcpServerIds: splitCsv(managedMcpServerIds),
                    userMcpServerIds: splitCsv(userMcpServerIds),
                    managedKbIds: splitCsv(managedKbIds),
                  },
                },
              })
            }
          >
            {t('workteam.保存worker')}
          </button>

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
        <button
          type="button"
          className="workflow-delete-btn"
          onClick={onDelete}
          disabled={!canManage || busy}
        >
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
      {direction === 'two_way' ? (
        <details className="workflow-advanced-details">
          <summary>{t('workteam.更多配置')}</summary>
          <label>
            {t('workteam.讨论轮次预算')}
            <input
              value={discussionTurns}
              onChange={(event) => setDiscussionTurns(event.target.value)}
            />
          </label>
        </details>
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
