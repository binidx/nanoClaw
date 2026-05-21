import * as db from '../db/workflows.js';
import { parseWorkflowConfig } from './config.js';
import { computeWorkflowRunMetrics } from './metrics.js';
import type { WorkflowRunEvaluationRecord, WorkflowRunGraph } from './types.js';
import type { TaskNodeConfig } from './types.js';

export interface WorkflowEvaluationFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  nodeId?: string;
}

export interface WorkflowEvaluation {
  runId: string;
  status: WorkflowRunEvaluationRecord['status'];
  score: number;
  findings: WorkflowEvaluationFinding[];
  createdAt: string;
}

function parseFindings(value: string): WorkflowEvaluationFinding[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as WorkflowEvaluationFinding[]) : [];
  } catch {
    return [];
  }
}

function parseTaskConfig(raw: string): TaskNodeConfig {
  try {
    return JSON.parse(raw || '{}') as TaskNodeConfig;
  } catch {
    return {};
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function serializeWorkflowEvaluation(
  record: WorkflowRunEvaluationRecord,
): WorkflowEvaluation {
  return {
    runId: record.run_id,
    status: record.status,
    score: record.score,
    findings: parseFindings(record.findings_json),
    createdAt: record.created_at,
  };
}

export function evaluateWorkflowRunGraph(graph: WorkflowRunGraph): Omit<WorkflowEvaluation, 'createdAt'> {
  const findings: WorkflowEvaluationFinding[] = [];
  const config = parseWorkflowConfig(graph.workflow);
  const metrics = computeWorkflowRunMetrics(graph);
  if (metrics.breakerReason) {
    findings.push({
      code: 'budget_exceeded',
      severity: 'error',
      message: metrics.breakerReason,
    });
  }
  for (const runNode of graph.runNodes) {
    if (runNode.status === 'failed') {
      findings.push({
        code: 'node_failed',
        severity: 'error',
        nodeId: runNode.node_id,
        message: runNode.last_error || 'Node failed',
      });
    }
    if (runNode.status === 'paused') {
      findings.push({
        code: 'node_paused',
        severity: 'warning',
        nodeId: runNode.node_id,
        message: runNode.pause_reason || 'Node is paused',
      });
    }
    if (runNode.status === 'completed' && runNode.pause_reason.includes('Output contract')) {
      findings.push({
        code: 'output_contract_warning',
        severity: 'warning',
        nodeId: runNode.node_id,
        message: runNode.pause_reason,
      });
    }
  }
  for (const node of graph.nodes.filter((item) => item.node_type === 'task')) {
    const cfg = parseTaskConfig(node.config_json);
    if (
      cfg.outputSchema?.trim() &&
      cfg.outputContract?.schemaValidation !== 'block' &&
      cfg.outputContract?.strictJson !== true
    ) {
      findings.push({
        code: 'output_schema_not_enforced',
        severity: 'info',
        nodeId: node.id,
        message: 'Node has an outputSchema but schema validation is not set to block',
      });
    }
  }
  const pendingTransfers = graph.pendingTransfers.filter(
    (transfer) => transfer.status === 'pending' || transfer.status === 'approved',
  );
  if (pendingTransfers.length > 0) {
    findings.push({
      code: 'pending_transfer_residue',
      severity: 'warning',
      message: `${pendingTransfers.length} pending transfer(s) remain unresolved`,
    });
  }
  for (const transfer of graph.pendingTransfers) {
    const payload = parseRecord(transfer.payload_json);
    const verdict =
      payload.verdict && typeof payload.verdict === 'object' && !Array.isArray(payload.verdict)
        ? (payload.verdict as Record<string, unknown>)
        : {};
    const validationErrors = Array.isArray(verdict.validationErrors)
      ? verdict.validationErrors.filter((item): item is string => typeof item === 'string')
      : [];
    if (validationErrors.length > 0) {
      findings.push({
        code: 'handoff_contract_validation_error',
        severity: transfer.status === 'sent' ? 'warning' : 'error',
        nodeId: transfer.source_node_id,
        message: validationErrors.join('; '),
      });
    }
  }
  if (
    graph.run.status === 'completed' &&
    config.artifactPolicy.exportable !== false &&
    graph.artifacts.length === 0
  ) {
    findings.push({
      code: 'missing_artifact',
      severity: 'warning',
      message: 'Completed run has no exported artifact record',
    });
  }
  const approvals = graph.executionEvents.filter((event) =>
    event.event_kind.toLowerCase().includes('approval_request'),
  );
  const resolvedApprovals = graph.executionEvents.filter((event) =>
    event.event_kind.toLowerCase().includes('approval_resolved'),
  );
  if (approvals.length > resolvedApprovals.length) {
    findings.push({
      code: 'approval_unresolved',
      severity: 'warning',
      message: `${approvals.length - resolvedApprovals.length} approval request(s) may be unresolved`,
    });
  }
  const byKind = new Map<string, number>();
  for (const event of graph.executionEvents) {
    byKind.set(event.event_kind, (byKind.get(event.event_kind) ?? 0) + 1);
  }
  for (const [kind, count] of byKind) {
    if (count > Math.max(25, config.guardrails.maxToolCalls / 2) && kind.toLowerCase().includes('tool')) {
      findings.push({
        code: 'repeated_tool_call',
        severity: 'warning',
        message: `${kind} occurred ${count} times`,
      });
    }
  }
  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const score = Math.max(0, 100 - errorCount * 35 - warningCount * 10);
  return {
    runId: graph.run.id,
    status: errorCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass',
    score,
    findings,
  };
}

export async function evaluateAndPersistWorkflowRun(
  runId: string,
): Promise<WorkflowEvaluation | undefined> {
  const graph = await db.getWorkflowRunGraph(runId);
  if (!graph) return undefined;
  const config = parseWorkflowConfig(graph.workflow);
  if (!config.evaluationPolicy.enabled) {
    return undefined;
  }
  const evaluation = evaluateWorkflowRunGraph(graph);
  const record = await db.upsertWorkflowRunEvaluation({
    run_id: runId,
    status: evaluation.status,
    score: evaluation.score,
    findings_json: JSON.stringify(evaluation.findings),
  });
  return serializeWorkflowEvaluation(record);
}
