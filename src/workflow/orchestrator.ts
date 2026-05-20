import { createModuleLogger } from '../logger.js';
import * as db from '../db/workflows.js';
import { executeWorkflowTask } from './agent-adapter.js';
import type {
  WorkflowEdgeRecord,
  WorkflowEdgeConfig,
  WorkflowNodeRecord,
  WorkflowRecord,
  WorkflowRunGraph,
  WorkflowRunRecord,
  WorkflowPendingTransferRecord,
} from './types.js';
import { WorkflowEventBus } from './event-bus.js';
import { parseWorkflowConfig } from './config.js';
import { ensureWorkflowArtifacts } from './artifacts.js';
import { evaluateAndPersistWorkflowRun } from './evaluation.js';
import { computeWorkflowRunMetrics } from './metrics.js';

const logger = createModuleLogger('workflow');

const activeOrchestrators = new Map<string, WorkflowOrchestrator>();

function nowIso(): string {
  return new Date().toISOString();
}

function parseTaskConfig(node: WorkflowNodeRecord): {
  assistantId?: string;
  pipelineNodeKind?: 'input' | 'retrieval' | 'analysis' | 'summary';
  prompt?: string;
  expectedOutput?: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
  handoffPolicy?: {
    maxTurns: number;
    cooldownMs: number;
    exposeToolCalls: false;
  };
} {
  try {
    return JSON.parse(node.config_json || '{}') as {
      assistantId?: string;
      pipelineNodeKind?: 'input' | 'retrieval' | 'analysis' | 'summary';
      prompt?: string;
      expectedOutput?: string;
      timeoutMs?: number;
      approvalRequired?: boolean;
      handoffPolicy?: {
        maxTurns: number;
        cooldownMs: number;
        exposeToolCalls: false;
      };
    };
  } catch {
    return {};
  }
}

function resolveExecutionAssistantId(
  node: WorkflowNodeRecord,
  roleNode: WorkflowNodeRecord | undefined,
): string {
  const taskConfig = parseTaskConfig(node);
  return (
    node.assistant_id?.trim() ||
    taskConfig.assistantId?.trim() ||
    roleNode?.assistant_id?.trim() ||
    ''
  );
}

function directedEdges(edges: WorkflowEdgeRecord[]): WorkflowEdgeRecord[] {
  return edges.filter((edge) => edge.direction === 'one_way');
}

function parseEdgeConfig(edge: WorkflowEdgeRecord): WorkflowEdgeConfig {
  try {
    return JSON.parse(edge.config_json || '{}') as WorkflowEdgeConfig;
  } catch {
    return {};
  }
}

function getDiscussionTurnBudget(edge: WorkflowEdgeRecord): number {
  const config = parseEdgeConfig(edge);
  const value = config.discussionTurns;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 4;
  return Math.max(0, Math.floor(value));
}

function getEffectiveDiscussionTurnBudget(
  edge: WorkflowEdgeRecord,
  nodesById: Map<string, WorkflowNodeRecord>,
): number {
  const edgeBudget = getDiscussionTurnBudget(edge);
  const sourceBudget = parseTaskConfig(nodesById.get(edge.source_node_id) ?? {
    config_json: '{}',
  } as WorkflowNodeRecord).handoffPolicy?.maxTurns;
  const targetBudget = parseTaskConfig(nodesById.get(edge.target_node_id) ?? {
    config_json: '{}',
  } as WorkflowNodeRecord).handoffPolicy?.maxTurns;
  const nodeBudgets = [sourceBudget, targetBudget].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (nodeBudgets.length === 0) return edgeBudget;
  return Math.max(0, Math.min(edgeBudget, ...nodeBudgets.map((value) => Math.floor(value))));
}

function countMessagesForEdge(
  messages: Array<{ payload_json: string }>,
  edgeId: string,
): number {
  let total = 0;
  for (const message of messages) {
    try {
      const payload = JSON.parse(message.payload_json) as Record<string, unknown>;
      if (payload.edgeId === edgeId) total += 1;
    } catch {
      // ignore malformed payloads
    }
  }
  return total;
}

function countTransfersForEdge(
  transfers: Array<{ edge_id: string; status: string }>,
  edgeId: string,
): number {
  return transfers.filter(
    (transfer) => transfer.edge_id === edgeId && transfer.status !== 'cancelled',
  ).length;
}

function getLatestMessageForEdge(
  messages: Array<{
    source_node_id: string;
    target_node_id: string;
    payload_json: string;
    created_at: string;
  }>,
  edgeId: string,
): { sourceNodeId: string; targetNodeId: string } | null {
  const matching = messages
    .map((message) => {
      try {
        const payload = JSON.parse(message.payload_json) as Record<string, unknown>;
        return payload.edgeId === edgeId
          ? {
              sourceNodeId: message.source_node_id,
              targetNodeId: message.target_node_id,
              createdAt: message.created_at,
            }
          : null;
      } catch {
        return null;
      }
    })
    .filter(
      (
        item,
      ): item is {
        sourceNodeId: string;
        targetNodeId: string;
        createdAt: string;
      } => item !== null,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = matching.at(-1);
  return latest
    ? { sourceNodeId: latest.sourceNodeId, targetNodeId: latest.targetNodeId }
    : null;
}

function inboundMap(edges: WorkflowEdgeRecord[]): Map<string, WorkflowEdgeRecord[]> {
  const map = new Map<string, WorkflowEdgeRecord[]>();
  for (const edge of edges) {
    const list = map.get(edge.target_node_id) ?? [];
    list.push(edge);
    map.set(edge.target_node_id, list);
  }
  return map;
}

function isTransferUnresolved(transfer: WorkflowPendingTransferRecord): boolean {
  return transfer.status === 'pending' || transfer.status === 'approved';
}

function hasUnresolvedInboundTransfer(
  graph: WorkflowRunGraph,
  edge: WorkflowEdgeRecord,
  sourceNodeId: string,
  targetNodeId: string,
): boolean {
  return graph.pendingTransfers.some(
    (transfer) =>
      transfer.edge_id === edge.id &&
      transfer.source_node_id === sourceNodeId &&
      transfer.target_node_id === targetNodeId &&
      isTransferUnresolved(transfer),
  );
}

function resolveRuntimeTransfer(
  edge: WorkflowEdgeRecord,
  sourceNodeId: string,
): { sourceNodeId: string; targetNodeId: string } | null {
  if (edge.source_node_id === sourceNodeId) {
    return {
      sourceNodeId,
      targetNodeId: edge.target_node_id,
    };
  }
  if (edge.direction === 'two_way' && edge.target_node_id === sourceNodeId) {
    return {
      sourceNodeId,
      targetNodeId: edge.source_node_id,
    };
  }
  return null;
}

function resolveRuntimeInbound(
  edge: WorkflowEdgeRecord,
  targetNodeId: string,
): { sourceNodeId: string; targetNodeId: string } | null {
  if (edge.target_node_id === targetNodeId) {
    return {
      sourceNodeId: edge.source_node_id,
      targetNodeId,
    };
  }
  if (edge.direction === 'two_way' && edge.source_node_id === targetNodeId) {
    return {
      sourceNodeId: edge.target_node_id,
      targetNodeId,
    };
  }
  return null;
}

export function getWorkflowOrchestrator(
  runId: string,
): WorkflowOrchestrator | undefined {
  return activeOrchestrators.get(runId);
}

export class WorkflowOrchestrator {
  private readonly workflowId: string;
  private readonly eventBus = WorkflowEventBus.getInstance();
  private runId: string | undefined;
  private workflow: WorkflowRecord | undefined;
  private nodesById = new Map<string, WorkflowNodeRecord>();
  private edges: WorkflowEdgeRecord[] = [];
  private runStatus: WorkflowRunRecord['status'] | null = null;
  private runningNodeIds = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  private edgeMessageCounts = new Map<string, number>();
  private edgeLastTransfers = new Map<
    string,
    { sourceNodeId: string; targetNodeId: string }
  >();
  private pendingTransferTimers = new Map<string, NodeJS.Timeout>();
  private edgeLastQueuedAt = new Map<string, number>();
  private scheduleTail: Promise<void> = Promise.resolve();

  constructor(workflowId: string) {
    this.workflowId = workflowId;
  }

  static async restore(
    runId: string,
    options: { scheduleTimers?: boolean } = {},
  ): Promise<WorkflowOrchestrator | undefined> {
    const graph = await db.getWorkflowRunGraph(runId);
    if (!graph) return undefined;
    const orchestrator = new WorkflowOrchestrator(graph.workflow.id);
    orchestrator.runId = runId;
    orchestrator.workflow = graph.workflow;
    orchestrator.nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    orchestrator.edges = graph.edges;
    orchestrator.runStatus = graph.run.status;
    orchestrator.edgeMessageCounts = new Map(
      graph.edges.map((edge) => [
        edge.id,
        Math.max(
          countMessagesForEdge(graph.messages, edge.id),
          countTransfersForEdge(graph.pendingTransfers, edge.id),
        ),
      ]),
    );
    orchestrator.edgeLastTransfers = new Map(
      graph.edges
        .map((edge) => [edge.id, getLatestMessageForEdge(graph.messages, edge.id)] as const)
        .filter(
          (
            entry,
          ): entry is [
            string,
            { sourceNodeId: string; targetNodeId: string },
          ] => entry[1] !== null,
        ),
    );
    orchestrator.edgeLastQueuedAt = new Map(
      graph.edges.map((edge) => {
        const latestTransfer = graph.pendingTransfers
          .filter((transfer) => transfer.edge_id === edge.id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .at(-1);
        return [
          edge.id,
          latestTransfer ? Date.parse(latestTransfer.created_at) || 0 : 0,
        ] as const;
      }),
    );
    activeOrchestrators.set(runId, orchestrator);
    if (options.scheduleTimers !== false && graph.run.status === 'running') {
      orchestrator.schedulePendingTransferTimers(graph.pendingTransfers);
    }
    return orchestrator;
  }

  async startRun(input: string): Promise<WorkflowRunRecord> {
    const snapshot = await db.getWorkflowSnapshot(this.workflowId);
    if (!snapshot) {
      throw new Error('Workflow not found');
    }
    validateWorkflowGraph(snapshot.nodes, snapshot.edges);
    const run = await db.createWorkflowRun(this.workflowId, input);
    this.workflow = snapshot.workflow;
    this.runId = run.id;
    this.nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.edges = snapshot.edges;
    this.runStatus = 'running';
    this.edgeMessageCounts.clear();
    this.edgeLastTransfers.clear();
    activeOrchestrators.set(run.id, this);

    for (const node of snapshot.nodes.filter((item) => item.node_type === 'task')) {
      await db.createWorkflowRunNode(run.id, node.id);
    }
    await db.updateWorkflowRun(run.id, {
      status: 'running',
      started_at: nowIso(),
    });
    this.eventBus.emit(run.id, 'run_started', { workflowId: this.workflowId });
    this.enqueueSchedule();
    return (await db.getWorkflowRun(run.id)) ?? {
      ...run,
      status: 'running',
      started_at: nowIso(),
    };
  }

  private enqueueSchedule(): void {
    this.scheduleTail = this.scheduleTail
      .then(() => this.runSchedule())
      .catch((err) => {
        logger.error({ err, runId: this.runId }, 'workflow schedule error');
      });
  }

  private schedulePendingTransferTimer(transfer: WorkflowPendingTransferRecord): void {
    if (!isTransferUnresolved(transfer)) return;
    const existing = this.pendingTransferTimers.get(transfer.id);
    if (existing) clearTimeout(existing);
    this.pendingTransferTimers.delete(transfer.id);
    const dueMs = Date.parse(transfer.due_at);
    const delayMs = Number.isFinite(dueMs)
      ? Math.max(0, dueMs - Date.now())
      : 0;
    const timer = setTimeout(() => {
      this.pendingTransferTimers.delete(transfer.id);
      this.enqueueSchedule();
    }, delayMs);
    timer.unref?.();
    this.pendingTransferTimers.set(transfer.id, timer);
  }

  private schedulePendingTransferTimers(
    transfers: WorkflowPendingTransferRecord[],
  ): void {
    for (const transfer of transfers) {
      this.schedulePendingTransferTimer(transfer);
    }
  }

  private clearPendingTransferTimers(): void {
    for (const timer of this.pendingTransferTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTransferTimers.clear();
  }

  private recordEdgeMessage(edgeId: string): number {
    const next = (this.edgeMessageCounts.get(edgeId) ?? 0) + 1;
    this.edgeMessageCounts.set(edgeId, next);
    return next;
  }

  private recordEdgeTransfer(
    edgeId: string,
    transfer: { sourceNodeId: string; targetNodeId: string },
  ): void {
    this.edgeLastTransfers.set(edgeId, transfer);
  }

  private workflowMessageDelayMs(): number {
    return parseWorkflowConfig(this.workflow).messageDelayMs;
  }

  private workflowGuardrails() {
    return parseWorkflowConfig(this.workflow).guardrails;
  }

  private edgeCooldownMs(edge: WorkflowEdgeRecord): number {
    const source = this.nodesById.get(edge.source_node_id);
    const target = this.nodesById.get(edge.target_node_id);
    const values = [source, target]
      .map((node) => (node ? parseTaskConfig(node).handoffPolicy?.cooldownMs : undefined))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (values.length === 0) return 10_000;
    return Math.max(0, Math.max(...values.map((value) => Math.floor(value))));
  }

  private async failRunForGuardrail(reason: string): Promise<void> {
    if (!this.runId) return;
    await db.updateWorkflowRun(this.runId, {
      status: 'failed',
      output: reason,
      completed_at: nowIso(),
    });
    for (const runNode of await db.listWorkflowRunNodes(this.runId)) {
      if (runNode.status === 'pending' || runNode.status === 'running') {
        await db.updateWorkflowRunNode(runNode.id, {
          status: 'failed',
          last_error: reason,
          completed_at: nowIso(),
        });
      }
    }
    this.runStatus = 'failed';
    this.eventBus.emit(this.runId, 'run_cancelled', {
      workflowId: this.workflowId,
      reason,
      guardrail: true,
    });
    await evaluateAndPersistWorkflowRun(this.runId).catch((err) =>
      logger.warn({ err, runId: this.runId }, 'workflow evaluation failed'),
    );
    activeOrchestrators.delete(this.runId);
    this.clearPendingTransferTimers();
    this.eventBus.removeAllForRun(this.runId);
  }

  private async enforceGuardrails(graph: WorkflowRunGraph): Promise<boolean> {
    const metrics = computeWorkflowRunMetrics(graph);
    if (!metrics.breakerReason) return true;
    await this.failRunForGuardrail(metrics.breakerReason);
    return false;
  }

  private async queueTransfer(input: {
    edge: WorkflowEdgeRecord;
    transfer: { sourceNodeId: string; targetNodeId: string };
    content: string;
    messageType: string;
  }): Promise<WorkflowPendingTransferRecord | null> {
    if (!this.runId) return null;
    const emittedCount = this.recordEdgeMessage(input.edge.id);
    const previousQueuedAt = this.edgeLastQueuedAt.get(input.edge.id) ?? 0;
    const cooldownRemainingMs = Math.max(
      0,
      this.edgeCooldownMs(input.edge) - (Date.now() - previousQueuedAt),
    );
    const delayMs = Math.max(this.workflowMessageDelayMs(), cooldownRemainingMs);
    const dueAt = new Date(Date.now() + delayMs).toISOString();
    const payload = {
      edgeId: input.edge.id,
      sourceNodeId: input.transfer.sourceNodeId,
      targetNodeId: input.transfer.targetNodeId,
      direction: input.edge.direction,
      messageType: input.messageType,
      discussionCount: emittedCount,
      content: input.content,
    };
    const pending = await db.createWorkflowPendingTransfer({
      run_id: this.runId,
      edge_id: input.edge.id,
      source_node_id: input.transfer.sourceNodeId,
      target_node_id: input.transfer.targetNodeId,
      direction: input.edge.direction,
      message_type: input.messageType,
      content_text: input.content,
      payload_json: JSON.stringify(payload),
      delay_ms: delayMs,
      due_at: dueAt,
    });
    this.edgeLastQueuedAt.set(input.edge.id, Date.now());
    this.eventBus.emit(this.runId, 'message_scheduled', {
      transferId: pending.id,
      edgeId: input.edge.id,
      sourceNodeId: input.transfer.sourceNodeId,
      targetNodeId: input.transfer.targetNodeId,
      direction: input.edge.direction,
      messageType: input.messageType,
      discussionCount: emittedCount,
      dueAt,
      delayMs,
    });
    if (delayMs <= 0) {
      await this.sendPendingTransfer(pending);
    } else {
      this.schedulePendingTransferTimer(pending);
    }
    return pending;
  }

  private async sendPendingTransfer(
    transfer: WorkflowPendingTransferRecord,
  ): Promise<boolean> {
    if (!this.runId || transfer.run_id !== this.runId) return false;
    const latest = await db.getWorkflowPendingTransfer(transfer.id);
    if (!latest || !isTransferUnresolved(latest)) return false;
    const payload = (() => {
      try {
        return JSON.parse(latest.payload_json || '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const content =
      typeof payload.content === 'string' ? payload.content : latest.content_text;
    const persisted = await db.recordWorkflowRuntimeFrame({
      run_id: latest.run_id,
      edge_id: latest.edge_id,
      source_node_id: latest.source_node_id,
      target_node_id: latest.target_node_id,
      direction: latest.direction,
      frame_type: latest.message_type,
      content_text: content,
      payload_json: JSON.stringify({
        ...payload,
        content,
        transferId: latest.id,
      }),
      message_type: latest.message_type,
    });
    const sentAt = nowIso();
    await db.updateWorkflowPendingTransfer(latest.id, {
      status: 'sent',
      sent_at: sentAt,
    });
    const discussionCount =
      typeof payload.discussionCount === 'number'
        ? payload.discussionCount
        : (this.edgeMessageCounts.get(latest.edge_id) ?? 0);
    this.recordEdgeTransfer(latest.edge_id, {
      sourceNodeId: latest.source_node_id,
      targetNodeId: latest.target_node_id,
    });
    this.eventBus.emit(this.runId, 'message_sent', {
      ...payload,
      transferId: latest.id,
      messageId: persisted.message.id,
      frameId: persisted.frame.id,
      edgeId: latest.edge_id,
      sourceNodeId: latest.source_node_id,
      targetNodeId: latest.target_node_id,
      direction: latest.direction,
      messageType: latest.message_type,
      discussionCount,
      content,
      persisted: true,
    });
    return true;
  }

  private async releaseDueTransfers(graph: WorkflowRunGraph): Promise<boolean> {
    const now = Date.now();
    let sent = false;
    for (const transfer of graph.pendingTransfers) {
      if (!isTransferUnresolved(transfer)) continue;
      const dueMs = Date.parse(transfer.due_at);
      if (!Number.isFinite(dueMs) || dueMs > now) {
        this.schedulePendingTransferTimer(transfer);
        continue;
      }
      sent = (await this.sendPendingTransfer(transfer)) || sent;
    }
    return sent;
  }

  private async runSchedule(): Promise<void> {
    if (!this.runId || this.runStatus !== 'running') return;
    const graph = await db.getWorkflowRunGraph(this.runId);
    if (!graph) return;
    if (!(await this.enforceGuardrails(graph))) return;
    if (await this.releaseDueTransfers(graph)) {
      this.enqueueSchedule();
      return;
    }
    const tasks = graph.nodes.filter((node) => node.node_type === 'task');
    const inbound = inboundMap(directedEdges(graph.edges));
    const completed = new Set(
      graph.runNodes
        .filter((node) => node.status === 'completed' || node.status === 'skipped')
        .map((node) => node.node_id),
    );
    const failed = graph.runNodes.some((node) => node.status === 'failed');
    const pending = graph.runNodes.filter((node) => node.status === 'pending');
    if (failed && this.runningNodeIds.size === 0) {
      await this.finalizeRun('failed');
      return;
    }
    if (pending.length === 0 && this.runningNodeIds.size === 0) {
      if (graph.pendingTransfers.some(isTransferUnresolved)) {
        this.schedulePendingTransferTimers(graph.pendingTransfers);
        return;
      }
      if (await this.queueDeferredTwoWayFollowUp(graph)) {
        return;
      }
      await this.finalizeRun('completed');
      return;
    }

    let availableSlots = Math.max(0, this.workflowGuardrails().concurrentNodes - this.runningNodeIds.size);
    if (availableSlots <= 0) return;
    for (const node of tasks) {
      if (availableSlots <= 0) break;
      if (this.runningNodeIds.has(node.id)) continue;
      const runNode = graph.runNodes.find((item) => item.node_id === node.id);
      if (!runNode || runNode.status !== 'pending') continue;
      const deps = inbound.get(node.id) ?? [];
      const depsReady = deps.every((edge) => {
        if (!completed.has(edge.source_node_id)) return false;
        return !hasUnresolvedInboundTransfer(
          graph,
          edge,
          edge.source_node_id,
          node.id,
        );
      });
      if (!depsReady) continue;
      availableSlots -= 1;
      void this.executeNode(graph, node).catch((err) => {
        logger.error({ err, runId: this.runId, nodeId: node.id }, 'workflow executeNode failed');
      });
    }
  }

  private async executeNode(graph: WorkflowRunGraph, node: WorkflowNodeRecord): Promise<void> {
    if (!this.runId || this.runStatus !== 'running') return;
    const runNode = graph.runNodes.find((item) => item.node_id === node.id);
    if (!runNode) return;
    const taskConfig = parseTaskConfig(node);
    if (taskConfig.pipelineNodeKind === 'input') {
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'completed',
        input_snapshot: JSON.stringify({
          runInput: graph.run.input,
          pipelineNodeKind: 'input',
        }),
        output_snapshot: graph.run.input || '',
        last_error: '',
        started_at: nowIso(),
        completed_at: nowIso(),
        pause_reason: '',
      });
      this.eventBus.emit(this.runId, 'node_completed', {
        nodeId: node.id,
        output: graph.run.input || '',
        executionMs: 0,
      });
      const outEdges = graph.edges
        .map((edge) => ({ edge, transfer: resolveRuntimeTransfer(edge, node.id) }))
        .filter(
          (
            entry,
          ): entry is {
            edge: WorkflowEdgeRecord;
            transfer: { sourceNodeId: string; targetNodeId: string };
          } => entry.transfer !== null,
        );
      for (const { edge, transfer } of outEdges) {
        await this.queueTransfer({
          edge,
          transfer,
          content: graph.run.input || '',
          messageType: 'node_output',
        });
      }
      this.enqueueSchedule();
      return;
    }
    if (taskConfig.approvalRequired && runNode.version <= 1) {
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'paused',
        pause_reason: 'Approval required before node execution',
        version: runNode.version + 1,
      });
      this.runStatus = 'paused';
      await db.updateWorkflowRun(this.runId, { status: 'paused' });
      this.eventBus.emit(this.runId, 'node_paused', {
        nodeId: node.id,
        reason: 'approval_required',
      });
      this.eventBus.emit(this.runId, 'run_paused', {
        workflowId: this.workflowId,
        reason: 'approval_required',
      });
      return;
    }
    const roleNode = this.nodesById.get(node.role_node_id);
    const resolvedRoleNode =
      roleNode && roleNode.node_type === 'role' ? roleNode : undefined;
    if (!resolveExecutionAssistantId(node, resolvedRoleNode)) {
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'failed',
        last_error: '该节点缺少执行主体',
        completed_at: nowIso(),
      });
      this.eventBus.emit(this.runId, 'node_failed', {
        nodeId: node.id,
        error: 'missing_executor',
      });
      this.enqueueSchedule();
      return;
    }

    this.runningNodeIds.add(node.id);
    const abortController = new AbortController();
    this.abortControllers.set(node.id, abortController);
    let timeout: NodeJS.Timeout | undefined;
    let timeoutExceeded = false;
    if (typeof taskConfig.timeoutMs === 'number' && Number.isFinite(taskConfig.timeoutMs)) {
      const timeoutMs = Math.max(1000, Math.floor(taskConfig.timeoutMs));
      timeout = setTimeout(() => {
        timeoutExceeded = true;
        abortController.abort();
      }, timeoutMs);
      timeout.unref?.();
    }
    const upstreamMessages = await this.buildNodeInput(graph, node);
    const inputSnapshot = JSON.stringify({
      runInput: graph.run.input,
      manualOverride: runNode.manual_input_override || '',
      inputAnchorFrameId: runNode.input_anchor_frame_id || '',
      inputPriorityMode: runNode.input_priority_mode || 'feedback_first',
      upstreamMessages,
    });
    await db.updateWorkflowRunNode(runNode.id, {
      status: 'running',
      input_snapshot: inputSnapshot,
      output_snapshot: '',
      last_error: '',
      started_at: nowIso(),
    });
    this.eventBus.emit(this.runId, 'node_started', {
      nodeId: node.id,
      roleNodeId: resolvedRoleNode?.id || '',
    });

    const workflowConfig = parseWorkflowConfig(this.workflow);
    const result = await executeWorkflowTask({
      workflowId: this.workflowId,
      workflowName: this.workflow?.name || '',
      runId: graph.run.id,
      roleNode: resolvedRoleNode,
      taskNode: node,
      runInput: graph.run.input,
      upstreamMessages,
      toolPolicy: workflowConfig.toolPolicy,
      repositoryBindingKey: workflowConfig.repositoryPolicy?.bindingKey,
      signal: abortController.signal,
    });
    if (timeout) clearTimeout(timeout);
    this.runningNodeIds.delete(node.id);
    this.abortControllers.delete(node.id);

    if (abortController.signal.aborted) {
      const latestRunNode = await db.getWorkflowRunNode(this.runId, node.id);
      if (latestRunNode?.status === 'paused') {
        this.eventBus.emit(this.runId, 'node_paused', { nodeId: node.id });
        this.enqueueSchedule();
        return;
      }
    }

    if (abortController.signal.aborted && this.runStatus !== 'running') {
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'paused',
        pause_reason: 'Run paused by user',
      });
      this.eventBus.emit(this.runId, 'node_paused', { nodeId: node.id });
      return;
    }

    if (this.runStatus !== 'running') {
      return;
    }

    if (!result.success) {
      const error = timeoutExceeded
        ? `Node timed out after ${taskConfig.timeoutMs}ms`
        : result.error || 'Task failed';
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'failed',
        last_error: error,
        completed_at: nowIso(),
      });
      this.eventBus.emit(this.runId, 'node_failed', {
        nodeId: node.id,
        error,
      });
      this.enqueueSchedule();
      return;
    }

    await db.updateWorkflowRunNode(runNode.id, {
      status: 'completed',
      output_snapshot: result.output,
      completed_at: nowIso(),
      pause_reason: '',
    });
    this.eventBus.emit(this.runId, 'node_completed', {
      nodeId: node.id,
      output: result.output,
      executionMs: result.execution_ms,
    });

    const outEdges = graph.edges
      .map((edge) => ({ edge, transfer: resolveRuntimeTransfer(edge, node.id) }))
      .filter(
        (
          entry,
        ): entry is {
          edge: WorkflowEdgeRecord;
          transfer: { sourceNodeId: string; targetNodeId: string };
        } => entry.transfer !== null,
      );
    for (const { edge, transfer } of outEdges) {
      await this.queueTransfer({
        edge,
        transfer,
        content: result.output,
        messageType: 'node_output',
      });
    }
    this.enqueueSchedule();
  }

  private async queueDeferredTwoWayFollowUp(
    graph: WorkflowRunGraph,
  ): Promise<boolean> {
    if (!this.runId) return false;
    for (const edge of graph.edges.filter((item) => item.direction === 'two_way')) {
      const budget = getEffectiveDiscussionTurnBudget(edge, this.nodesById);
      const count =
        this.edgeMessageCounts.get(edge.id) ??
        Math.max(
          countMessagesForEdge(graph.messages, edge.id),
          countTransfersForEdge(graph.pendingTransfers, edge.id),
        );
      if (count === 0 || count >= budget) continue;
      const latestMessage =
        this.edgeLastTransfers.get(edge.id) ??
        getLatestMessageForEdge(graph.messages, edge.id);
      if (!latestMessage) continue;
      const nextNodeId = latestMessage.targetNodeId;
      const targetRunNode = await db.getWorkflowRunNode(this.runId, nextNodeId);
      if (!targetRunNode) continue;
      if (
        targetRunNode.status !== 'completed' &&
        targetRunNode.status !== 'skipped'
      ) {
        continue;
      }
      await db.updateWorkflowRunNode(targetRunNode.id, {
        status: 'pending',
        last_error: '',
        output_snapshot: '',
        completed_at: '',
        pause_reason: `Deferred two-way follow-up for edge ${edge.id}`,
        version: targetRunNode.version + 1,
      });
      this.eventBus.emit(this.runId, 'intervention', {
        nodeId: nextNodeId,
        reason: 'two_way_discussion_deferred_follow_up',
        edgeId: edge.id,
        remainingTurns: budget - count,
      });
      this.enqueueSchedule();
      return true;
    }
    return false;
  }

  private async buildNodeInput(
    graph: WorkflowRunGraph,
    node: WorkflowNodeRecord,
  ): Promise<Array<{ from: string; to: string; direction: string; content: string }>> {
    const runNodesByNodeId = new Map(
      graph.runNodes.map((runNode) => [runNode.node_id, runNode]),
    );
    const currentRunNode = graph.runNodes.find((runNode) => runNode.node_id === node.id);
    const frames = graph.messageFrames;
    const messages = await db.listWorkflowRunMessages(graph.run.id);
    const taskName = (id: string) => this.nodesById.get(id)?.name ?? id;
    const collected: Array<{
      from: string;
      to: string;
      direction: string;
      content: string;
    }> = [];
    for (const edge of graph.edges) {
      const inbound = resolveRuntimeInbound(edge, node.id);
      if (!inbound) continue;
      let existingEdgeFrames = frames.filter(
        (frame) => frame.edge_id === edge.id && frame.target_node_id === node.id,
      );
      if (currentRunNode?.input_anchor_frame_id) {
        const anchorIndex = existingEdgeFrames.findIndex(
          (frame) => frame.id === currentRunNode.input_anchor_frame_id,
        );
        if (anchorIndex >= 0) {
          existingEdgeFrames = existingEdgeFrames.slice(anchorIndex);
        }
      }
      if (
        currentRunNode?.input_priority_mode === 'feedback_first' &&
        existingEdgeFrames.length > 0
      ) {
        existingEdgeFrames = [
          ...existingEdgeFrames.filter((frame) => frame.frame_type === 'feedback'),
          ...existingEdgeFrames.filter((frame) => frame.frame_type !== 'feedback'),
        ];
      }
      if (existingEdgeFrames.length > 0) {
        for (const frame of existingEdgeFrames) {
          const prefix =
            frame.frame_type === 'feedback'
              ? '[feedback] '
              : frame.frame_type === 'intervention'
                ? '[intervention] '
                : '';
          collected.push({
            from: taskName(frame.source_node_id),
            to: taskName(frame.target_node_id),
            direction: frame.direction,
            content: `${prefix}${frame.content_text}`,
          });
        }
        continue;
      }
      const existingEdgeMessages = messages.filter((message) => {
        if (message.target_node_id !== node.id) return false;
        try {
          const payload = JSON.parse(message.payload_json) as Record<string, unknown>;
          return payload.edgeId === edge.id;
        } catch {
          return false;
        }
      });
      if (existingEdgeMessages.length > 0) {
        for (const message of existingEdgeMessages) {
          try {
            const payload = JSON.parse(message.payload_json) as Record<string, unknown>;
            if (typeof payload.content === 'string') {
              collected.push({
                from: taskName(message.source_node_id),
                to: taskName(message.target_node_id),
                direction: message.direction,
                content: payload.content,
              });
            }
          } catch {
            // ignore malformed payloads
          }
        }
        continue;
      }
      const transferRecords = graph.pendingTransfers.filter(
        (transfer) =>
          transfer.edge_id === edge.id &&
          transfer.source_node_id === inbound.sourceNodeId &&
          transfer.target_node_id === node.id,
      );
      if (transferRecords.length > 0) {
        continue;
      }
      const sourceRunNode = runNodesByNodeId.get(inbound.sourceNodeId);
      if (sourceRunNode?.output_snapshot) {
        collected.push({
          from: taskName(inbound.sourceNodeId),
          to: taskName(node.id),
          direction: edge.direction,
          content: sourceRunNode.output_snapshot,
        });
      }
    }
    if (currentRunNode?.manual_input_override?.trim()) {
      collected.unshift({
        from: 'manual_override',
        to: taskName(node.id),
        direction: 'one_way',
        content: `[manual_override] ${currentRunNode.manual_input_override.trim()}`,
      });
    }
    return collected;
  }

  private async finalizeRun(status: 'completed' | 'failed'): Promise<void> {
    if (!this.runId) return;
    const graph = await db.getWorkflowRunGraph(this.runId);
    if (!graph) return;
    if (
      status === 'completed' &&
      graph.runNodes.some(
        (node) => node.status === 'pending' || node.status === 'running' || node.status === 'paused',
      )
    ) {
      return;
    }
    const outputs = graph.runNodes
      .filter((node) => node.output_snapshot)
      .map((node) => {
        const task = this.nodesById.get(node.node_id);
        return `=== ${task?.name || node.node_id} ===\n${node.output_snapshot}`;
      })
      .join('\n\n');
    await db.updateWorkflowRun(this.runId, {
      status,
      output: outputs,
      completed_at: nowIso(),
    });
    try {
      await ensureWorkflowArtifacts(this.runId);
      this.eventBus.emit(this.runId, 'artifact_created', {
        workflowId: this.workflowId,
        runId: this.runId,
      });
    } catch (err) {
      logger.warn({ err, runId: this.runId }, 'workflow artifact generation failed');
    }
    this.runStatus = status;
    await evaluateAndPersistWorkflowRun(this.runId).catch((err) =>
      logger.warn({ err, runId: this.runId }, 'workflow evaluation failed'),
    );
    activeOrchestrators.delete(this.runId);
    this.clearPendingTransferTimers();
    this.eventBus.removeAllForRun(this.runId);
  }

  async pauseRun(): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    this.runStatus = 'paused';
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    await db.updateWorkflowRun(this.runId, { status: 'paused' });
    this.eventBus.emit(this.runId, 'run_paused', { workflowId: this.workflowId });
  }

  async resumeRun(): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    this.runStatus = 'running';
    await db.updateWorkflowRun(this.runId, { status: 'running' });
    const runNodes = await db.listWorkflowRunNodes(this.runId);
    for (const runNode of runNodes.filter((node) => node.status === 'paused')) {
      await db.updateWorkflowRunNode(runNode.id, {
        status: 'pending',
        pause_reason: '',
      });
    }
    this.eventBus.emit(this.runId, 'run_resumed', { workflowId: this.workflowId });
    this.enqueueSchedule();
  }

  async cancelRun(): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    this.runStatus = 'cancelled';
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    await db.updateWorkflowRun(this.runId, {
      status: 'cancelled',
      completed_at: nowIso(),
    });
    this.eventBus.emit(this.runId, 'run_cancelled', {
      workflowId: this.workflowId,
    });
    activeOrchestrators.delete(this.runId);
    this.clearPendingTransferTimers();
    this.eventBus.removeAllForRun(this.runId);
  }

  async pauseNode(nodeId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, nodeId);
    if (!runNode) throw new Error('Run node not found');
    const controller = this.abortControllers.get(nodeId);
    if (controller) controller.abort();
    await db.updateWorkflowRunNode(runNode.id, {
      status: 'paused',
      pause_reason: 'Node paused by user',
    });
    this.eventBus.emit(this.runId, 'node_paused', { nodeId });
  }

  async resumeNode(nodeId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, nodeId);
    if (!runNode) throw new Error('Run node not found');
    await db.updateWorkflowRunNode(runNode.id, {
      status: 'pending',
      pause_reason: '',
    });
    this.eventBus.emit(this.runId, 'node_resumed', { nodeId });
    this.enqueueSchedule();
  }

  async updateNodeInput(nodeId: string, nextInput: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, nodeId);
    if (!runNode) throw new Error('Run node not found');
    await db.insertWorkflowIntervention({
      run_id: this.runId,
      node_id: nodeId,
      intervention_type: 'input_update',
      summary: 'User edited node input snapshot',
      before_json: runNode.input_snapshot || '',
      after_json: nextInput,
    });
    await db.updateWorkflowRunNode(runNode.id, {
      input_snapshot: nextInput,
      manual_input_override: nextInput,
      version: runNode.version + 1,
      status: 'paused',
      pause_reason: 'Input edited by user',
    });
    this.eventBus.emit(this.runId, 'input_updated', { nodeId, input: nextInput });
  }

  async updateNodeInputConfig(input: {
    nodeId: string;
    inputAnchorFrameId?: string;
    inputPriorityMode?: 'feedback_first' | 'chronological';
  }): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, input.nodeId);
    if (!runNode) throw new Error('Run node not found');
    await db.updateWorkflowRunNode(runNode.id, {
      input_anchor_frame_id: input.inputAnchorFrameId ?? '',
      input_priority_mode: input.inputPriorityMode ?? runNode.input_priority_mode,
      version: runNode.version + 1,
    });
    this.eventBus.emit(this.runId, 'intervention', {
      nodeId: input.nodeId,
      reason: 'input_config_updated',
      inputAnchorFrameId: input.inputAnchorFrameId ?? '',
      inputPriorityMode: input.inputPriorityMode ?? runNode.input_priority_mode,
    });
  }

  async updateNodeOutput(nodeId: string, nextOutput: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, nodeId);
    if (!runNode) throw new Error('Run node not found');
    await db.insertWorkflowIntervention({
      run_id: this.runId,
      node_id: nodeId,
      intervention_type: 'output_update',
      summary: 'User edited node output snapshot',
      before_json: runNode.output_snapshot || '',
      after_json: nextOutput,
    });
    await db.updateWorkflowRunNode(runNode.id, {
      output_snapshot: nextOutput,
      version: runNode.version + 1,
      status: 'completed',
      completed_at: nowIso(),
    });
    const graph = await db.getWorkflowRunGraph(this.runId);
    if (graph) {
      const outEdges = graph.edges
        .map((edge) => ({ edge, transfer: resolveRuntimeTransfer(edge, nodeId) }))
        .filter(
          (
            entry,
          ): entry is {
            edge: WorkflowEdgeRecord;
            transfer: { sourceNodeId: string; targetNodeId: string };
          } => entry.transfer !== null,
        );
      for (const { edge, transfer } of outEdges) {
        await this.queueTransfer({
          edge,
          transfer,
          content: nextOutput,
          messageType: 'manual_output_override',
        });
      }
    }
    this.eventBus.emit(this.runId, 'output_updated', { nodeId, output: nextOutput });
    this.enqueueSchedule();
  }

  async retryNode(nodeId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const runNode = await db.getWorkflowRunNode(this.runId, nodeId);
    if (!runNode) throw new Error('Run node not found');
    await db.updateWorkflowRunNode(runNode.id, {
      status: 'pending',
      last_error: '',
      output_snapshot: '',
      completed_at: '',
      pause_reason: '',
    });
    this.enqueueSchedule();
  }

  async approveTransfer(transferId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const transfer = await db.getWorkflowPendingTransfer(transferId);
    if (!transfer || transfer.run_id !== this.runId) {
      throw new Error('Transfer not found');
    }
    if (!isTransferUnresolved(transfer)) return;
    await db.updateWorkflowPendingTransfer(transfer.id, {
      status: 'approved',
    });
    this.schedulePendingTransferTimer({ ...transfer, status: 'approved' });
    this.eventBus.emit(this.runId, 'intervention', {
      transferId,
      reason: 'transfer_approved',
    });
  }

  async editTransfer(transferId: string, content: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const transfer = await db.getWorkflowPendingTransfer(transferId);
    if (!transfer || transfer.run_id !== this.runId) {
      throw new Error('Transfer not found');
    }
    if (!isTransferUnresolved(transfer)) {
      throw new Error('Transfer is no longer editable');
    }
    const payload = (() => {
      try {
        return JSON.parse(transfer.payload_json || '{}') as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    await db.updateWorkflowPendingTransfer(transfer.id, {
      content_text: content,
      payload_json: JSON.stringify({
        ...payload,
        content,
        edited: true,
      }),
    });
    this.schedulePendingTransferTimer({ ...transfer, content_text: content });
    this.eventBus.emit(this.runId, 'intervention', {
      transferId,
      reason: 'transfer_edited',
    });
  }

  async cancelTransfer(transferId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const transfer = await db.getWorkflowPendingTransfer(transferId);
    if (!transfer || transfer.run_id !== this.runId) {
      throw new Error('Transfer not found');
    }
    if (!isTransferUnresolved(transfer)) return;
    const timer = this.pendingTransferTimers.get(transfer.id);
    if (timer) clearTimeout(timer);
    this.pendingTransferTimers.delete(transfer.id);
    await db.updateWorkflowPendingTransfer(transfer.id, {
      status: 'cancelled',
      cancelled_at: nowIso(),
    });
    this.eventBus.emit(this.runId, 'message_cancelled', {
      transferId,
      edgeId: transfer.edge_id,
      sourceNodeId: transfer.source_node_id,
      targetNodeId: transfer.target_node_id,
    });
    this.enqueueSchedule();
  }

  async releaseTransferNow(transferId: string): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const transfer = await db.getWorkflowPendingTransfer(transferId);
    if (!transfer || transfer.run_id !== this.runId) {
      throw new Error('Transfer not found');
    }
    if (!isTransferUnresolved(transfer)) return;
    const releasedAt = nowIso();
    await db.updateWorkflowPendingTransfer(transfer.id, {
      status: 'approved',
      due_at: releasedAt,
      released_at: releasedAt,
    });
    const next = {
      ...transfer,
      status: 'approved' as const,
      due_at: releasedAt,
      released_at: releasedAt,
    };
    await this.sendPendingTransfer(next);
    this.enqueueSchedule();
  }

  async insertFeedbackFrame(
    edgeId: string,
    content: string,
    direction: 'forward' | 'reverse',
  ): Promise<void> {
    if (!this.runId) throw new Error('No active run');
    const graph = await db.getWorkflowRunGraph(this.runId);
    const edge = graph?.edges.find((item) => item.id === edgeId);
    if (!graph || !edge) throw new Error('Edge not found on this run');

    const sourceNodeId =
      direction === 'reverse' ? edge.target_node_id : edge.source_node_id;
    const targetNodeId =
      direction === 'reverse' ? edge.source_node_id : edge.target_node_id;

    await db.createWorkflowFeedbackFrame({
      run_id: this.runId,
      edge_id: edge.id,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      direction: edge.direction,
      content_text: content,
      payload_json: JSON.stringify({
        edgeId: edge.id,
        content,
        frameType: 'feedback',
        feedbackDirection: direction,
      }),
    });

    const targetRunNode = await db.getWorkflowRunNode(this.runId, targetNodeId);
    if (!targetRunNode) return;
    await db.updateWorkflowRunNode(targetRunNode.id, {
      status: 'pending',
      last_error: '',
      completed_at: '',
      pause_reason: 'Awaiting feedback follow-up',
      version: targetRunNode.version + 1,
    });
    if (this.runStatus === 'completed' || this.runStatus === 'failed') {
      this.runStatus = 'running';
      await db.updateWorkflowRun(this.runId, {
        status: 'running',
        completed_at: '',
      });
    }
    this.eventBus.emit(this.runId, 'intervention', {
      edgeId,
      targetNodeId,
      reason: 'feedback_frame_created',
      direction,
    });
    this.enqueueSchedule();
  }
}

export function validateWorkflowGraph(
  nodes: WorkflowNodeRecord[],
  edges: WorkflowEdgeRecord[],
): void {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const taskIds = new Set(
    nodes.filter((node) => node.node_type === 'task').map((node) => node.id),
  );
  for (const edge of edges) {
    if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id)) {
      throw new Error('Edge references a missing node');
    }
    if (edge.source_node_id === edge.target_node_id) {
      throw new Error('Self-loop edges are not allowed');
    }
  }

  const directed = directedEdges(
    edges.filter(
      (edge) => taskIds.has(edge.source_node_id) && taskIds.has(edge.target_node_id),
    ),
  );
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const taskId of taskIds) {
    indegree.set(taskId, 0);
    adjacency.set(taskId, []);
  }
  for (const edge of directed) {
    indegree.set(edge.target_node_id, (indegree.get(edge.target_node_id) ?? 0) + 1);
    adjacency.get(edge.source_node_id)?.push(edge.target_node_id);
  }
  const queue = Array.from(taskIds).filter((taskId) => (indegree.get(taskId) ?? 0) === 0);
  let seen = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    seen += 1;
    for (const next of adjacency.get(current) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, value);
      if (value === 0) queue.push(next);
    }
  }
  if (seen !== taskIds.size) {
    throw new Error('Directed task graph contains a cycle');
  }
}

export async function recoverActiveWorkflowRuns(): Promise<number> {
  const runs = await db.listActiveWorkflowRuns();
  for (const run of runs) {
    if (run.status === 'running') {
      await db.updateWorkflowRun(run.id, {
        status: 'paused',
      });
      for (const runNode of await db.listWorkflowRunNodes(run.id)) {
        if (runNode.status === 'running') {
          await db.updateWorkflowRunNode(runNode.id, {
            status: 'paused',
            pause_reason: 'Paused during startup recovery',
          });
        }
      }
    }
    await WorkflowOrchestrator.restore(run.id, { scheduleTimers: false });
  }
  return runs.length;
}
