import { parseWorkflowConfig } from './config.js';
import type { WorkflowRunGraph } from './types.js';

export interface WorkflowRunMetrics {
  runId: string;
  status: string;
  durationMs: number;
  nodeRuns: number;
  transfers: number;
  toolCalls: number;
  approvals: number;
  executionEvents: number;
  estimatedContextCharsByNode: Record<string, number>;
  maxEstimatedContextCharsPerNode: number;
  guardrails: ReturnType<typeof parseWorkflowConfig>['guardrails'];
  remaining: {
    durationMs: number;
    nodeRuns: number;
    transfers: number;
    toolCalls: number;
    executionEvents: number;
  };
  breakerReason?: string;
}

function timeMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function countWorkflowToolCalls(graph: WorkflowRunGraph): number {
  return graph.executionEvents.filter((event) => {
    const kind = event.event_kind.toLowerCase();
    if (kind.includes('approval')) return false;
    return kind.includes('tool') || kind.includes('mcp') || kind.includes('function');
  }).length;
}

export function countWorkflowApprovals(graph: WorkflowRunGraph): number {
  return graph.executionEvents.filter((event) =>
    event.event_kind.toLowerCase().includes('approval'),
  ).length;
}

export function estimateContextCharsByNode(
  graph: WorkflowRunGraph,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const execution of graph.executions) {
    const current = result[execution.node_id] ?? 0;
    result[execution.node_id] = Math.max(current, execution.prompt_text.length);
  }
  for (const runNode of graph.runNodes) {
    const current = result[runNode.node_id] ?? 0;
    result[runNode.node_id] = Math.max(
      current,
      runNode.input_snapshot.length + runNode.output_snapshot.length,
    );
  }
  return result;
}

export function computeWorkflowRunMetrics(graph: WorkflowRunGraph): WorkflowRunMetrics {
  const config = parseWorkflowConfig(graph.workflow);
  const guardrails = config.guardrails;
  const startMs = timeMs(graph.run.started_at) ?? timeMs(graph.run.created_at) ?? Date.now();
  const endMs = timeMs(graph.run.completed_at) ?? Date.now();
  const durationMs = Math.max(0, endMs - startMs);
  const nodeRuns = graph.executions.length;
  const transfers = graph.pendingTransfers.filter(
    (transfer) => transfer.status !== 'cancelled',
  ).length;
  const toolCalls = countWorkflowToolCalls(graph);
  const approvals = countWorkflowApprovals(graph);
  const executionEvents = graph.executionEvents.length;
  const estimatedContextCharsByNode = estimateContextCharsByNode(graph);
  const maxEstimatedContextCharsPerNode = Math.max(
    0,
    ...Object.values(estimatedContextCharsByNode),
  );
  const remaining = {
    durationMs: guardrails.maxDurationMs - durationMs,
    nodeRuns: guardrails.maxNodeRuns - nodeRuns,
    transfers: guardrails.maxTransfers - transfers,
    toolCalls: guardrails.maxToolCalls - toolCalls,
    executionEvents: guardrails.maxExecutionEvents - executionEvents,
  };
  const breakerReason =
    durationMs > guardrails.maxDurationMs
      ? `Workflow exceeded maxDurationMs (${guardrails.maxDurationMs})`
      : nodeRuns > guardrails.maxNodeRuns
        ? `Workflow exceeded maxNodeRuns (${guardrails.maxNodeRuns})`
        : transfers > guardrails.maxTransfers
          ? `Workflow exceeded maxTransfers (${guardrails.maxTransfers})`
          : toolCalls > guardrails.maxToolCalls
            ? `Workflow exceeded maxToolCalls (${guardrails.maxToolCalls})`
            : executionEvents > guardrails.maxExecutionEvents
              ? `Workflow exceeded maxExecutionEvents (${guardrails.maxExecutionEvents})`
              : maxEstimatedContextCharsPerNode >
                    guardrails.maxEstimatedContextCharsPerNode
                ? `Workflow exceeded maxEstimatedContextCharsPerNode (${guardrails.maxEstimatedContextCharsPerNode})`
                : undefined;
  return {
    runId: graph.run.id,
    status: graph.run.status,
    durationMs,
    nodeRuns,
    transfers,
    toolCalls,
    approvals,
    executionEvents,
    estimatedContextCharsByNode,
    maxEstimatedContextCharsPerNode,
    guardrails,
    remaining,
    ...(breakerReason ? { breakerReason } : {}),
  };
}
