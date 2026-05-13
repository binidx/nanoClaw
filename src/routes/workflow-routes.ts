import type { Express, Request, Response } from 'express';
import { Router } from 'express';

import * as db from '../db/workflows.js';
import { listAssistants } from '../db.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import {
  WorkflowOrchestrator,
  getWorkflowOrchestrator,
  validateWorkflowGraph,
} from '../workflow/orchestrator.js';
import { normalizeWorkflowConfig, parseWorkflowConfig } from '../workflow/config.js';
import {
  buildWorkflowExportBundle,
  commitAndPushWorkflowRun,
  ensureWorkflowArtifacts,
  publishWorkflowRun,
} from '../workflow/artifacts.js';
import {
  evaluateAndPersistWorkflowRun,
  serializeWorkflowEvaluation,
} from '../workflow/evaluation.js';
import { computeWorkflowRunMetrics } from '../workflow/metrics.js';
import { logger } from '../logger.js';
import type {
  WorkflowEdgeDirection,
  WorkflowConfig,
  WorkflowNodeType,
  WorkflowRecord,
} from '../workflow/types.js';

export interface WorkflowRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation?: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

function paramId(raw: string | string[] | undefined): string {
  if (raw === undefined) return '';
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';
}

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function isNodeType(value: unknown): value is WorkflowNodeType {
  return value === 'role' || value === 'task';
}

function isEdgeDirection(value: unknown): value is WorkflowEdgeDirection {
  return value === 'one_way' || value === 'two_way';
}

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function getVisibleAssistantIds(): Promise<Set<string>> {
  const assistants = await listAssistants({ userId: getCurrentUserId() });
  return new Set(assistants.map((assistant) => assistant.id));
}

function findWorkflowNode(
  snapshot: Awaited<ReturnType<typeof db.getWorkflowSnapshot>>,
  nodeId: string,
) {
  return snapshot?.nodes.find((node) => node.id === nodeId);
}

function requiresSystemWorkflowAdmin(config: WorkflowConfig): boolean {
  return (
    config.kind === 'system_capability' ||
    config.visibility === 'system' ||
    config.publishTarget === 'system' ||
    config.artifactPolicy.publishTarget === 'system'
  );
}

async function runPermissionGuard(
  guard: ReturnType<WorkflowRouteOptions['requirePermission']>,
  req: Request,
  res: Response,
): Promise<boolean> {
  let nextCalled = false;
  let nextError: unknown;
  await guard(req, res, (err?: unknown) => {
    nextCalled = true;
    nextError = err;
  });
  if (nextError) throw nextError;
  return nextCalled && !res.headersSent;
}

async function requireWorkflowForUser(workflowId: string) {
  const workflow = await db.getWorkflow(workflowId);
  if (!workflow) {
    return { ok: false as const, status: 404, message: 'Workflow not found' };
  }
  if (workflow.user_id !== getCurrentUserId()) {
    return { ok: false as const, status: 403, message: 'Forbidden' };
  }
  return { ok: true as const, workflow };
}

async function requireRunForUser(runId: string) {
  const run = await db.getWorkflowRun(runId);
  if (!run) return { ok: false as const, status: 404, message: 'Run not found' };
  const access = await requireWorkflowForUser(run.workflow_id);
  if (!access.ok) return access;
  return { ok: true as const, run, workflow: access.workflow };
}

export function registerWorkflowRoutes(
  app: Express,
  opts: WorkflowRouteOptions,
): void {
  const viewGuard = opts.requirePermission('project.view', 'workteam.view');
  const manageGuard = opts.requirePermission('project.manage', 'workteam.manage');
  const systemWorkflowGuard = opts.requirePermission(
    'admin.settings.write',
    'marketplace.manage_sources',
  );
  const router = Router();

  router.get('/workflows', viewGuard, async (_req, res) => {
    try {
      res.json(await db.listWorkflows());
    } catch (err) {
      logger.error({ err }, 'workflow routes: GET /workflows failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows', manageGuard, async (req, res) => {
    try {
      if (typeof req.body?.name !== 'string' || !req.body.name.trim()) {
        sendError(res, 400, 'name is required');
        return;
      }
      const workflowConfig =
        req.body?.workflow_config && typeof req.body.workflow_config === 'object'
          ? normalizeWorkflowConfig(req.body.workflow_config)
          : normalizeWorkflowConfig({});
      if (
        requiresSystemWorkflowAdmin(workflowConfig) &&
        !(await runPermissionGuard(systemWorkflowGuard, req, res))
      ) {
        return;
      }
      const workflow = await db.createWorkflow({
        name: req.body.name.trim(),
        description:
          typeof req.body?.description === 'string' ? req.body.description : undefined,
        workflow_config: workflowConfig,
      });
      res.json(workflow);
    } catch (err) {
      logger.error({ err }, 'workflow routes: POST /workflows failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/:id', viewGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(await db.getWorkflowSnapshot(workflowId));
    } catch (err) {
      logger.error({ err }, 'workflow routes: GET /workflows/:id failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put('/workflows/:id', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const patch: Partial<
        Pick<WorkflowRecord, 'name' | 'description' | 'status' | 'workflow_config'>
      > = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name;
      if (typeof req.body?.description === 'string') patch.description = req.body.description;
      if (typeof req.body?.status === 'string') {
        patch.status = req.body.status as WorkflowRecord['status'];
      }
      let nextConfig = parseWorkflowConfig(access.workflow);
      if (req.body?.workflow_config && typeof req.body.workflow_config === 'object') {
        nextConfig = normalizeWorkflowConfig(req.body.workflow_config);
        patch.workflow_config = JSON.stringify(nextConfig);
      }
      if (
        (requiresSystemWorkflowAdmin(parseWorkflowConfig(access.workflow)) ||
          requiresSystemWorkflowAdmin(nextConfig)) &&
        !(await runPermissionGuard(systemWorkflowGuard, req, res))
      ) {
        return;
      }
      await db.updateWorkflow(workflowId, patch);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: PUT /workflows/:id failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.delete('/workflows/:id', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      await db.deleteWorkflow(workflowId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: DELETE /workflows/:id failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/:id/nodes', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const snapshot = await db.getWorkflowSnapshot(workflowId);
      if (!snapshot) {
        sendError(res, 404, 'Workflow not found');
        return;
      }
      if (!isNodeType(req.body?.node_type)) {
        sendError(res, 400, 'node_type must be role or task');
        return;
      }
      if (typeof req.body?.name !== 'string' || !req.body.name.trim()) {
        sendError(res, 400, 'name is required');
        return;
      }
      if (req.body?.assistant_id !== undefined && typeof req.body.assistant_id !== 'string') {
        sendError(res, 400, 'assistant_id must be a string');
        return;
      }
      if (req.body?.role_node_id !== undefined && typeof req.body.role_node_id !== 'string') {
        sendError(res, 400, 'role_node_id must be a string');
        return;
      }
      const assistantId = normalizedString(req.body?.assistant_id);
      const roleNodeId = normalizedString(req.body?.role_node_id);
      if (req.body.node_type === 'task') {
        if (!roleNodeId) {
          sendError(res, 400, 'role_node_id is required for task nodes');
          return;
        }
        const roleNode = findWorkflowNode(snapshot, roleNodeId);
        if (!roleNode || roleNode.node_type !== 'role') {
          sendError(res, 400, 'role_node_id must reference a role node in this workflow');
          return;
        }
      }
      if (assistantId) {
        const assistantIds = await getVisibleAssistantIds();
        if (!assistantIds.has(assistantId)) {
          sendError(res, 400, 'assistant_id must reference an assistant you can access');
          return;
        }
      }
      const node = await db.createWorkflowNode(workflowId, {
        node_type: req.body.node_type,
        name: req.body.name.trim(),
        description:
          typeof req.body?.description === 'string' ? req.body.description : undefined,
        role_node_id: roleNodeId || undefined,
        assistant_id: assistantId || undefined,
        config_json:
          req.body?.config_json && typeof req.body.config_json === 'object'
            ? (req.body.config_json as Record<string, unknown>)
            : undefined,
        position_x:
          typeof req.body?.position_x === 'number' ? req.body.position_x : undefined,
        position_y:
          typeof req.body?.position_y === 'number' ? req.body.position_y : undefined,
      });
      res.json(node);
    } catch (err) {
      logger.error({ err }, 'workflow routes: POST node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put('/workflows/:id/nodes/:nodeId', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const snapshot = await db.getWorkflowSnapshot(workflowId);
      if (!snapshot) {
        sendError(res, 404, 'Workflow not found');
        return;
      }
      const existingNode = findWorkflowNode(snapshot, nodeId);
      if (!existingNode) {
        sendError(res, 404, 'Node not found');
        return;
      }
      const patch: Record<string, unknown> = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name;
      if (typeof req.body?.description === 'string') patch.description = req.body.description;
      if (req.body?.role_node_id !== undefined) {
        if (typeof req.body.role_node_id !== 'string') {
          sendError(res, 400, 'role_node_id must be a string');
          return;
        }
        if (existingNode.node_type !== 'task') {
          sendError(res, 400, 'role_node_id can only be set on task nodes');
          return;
        }
        const roleNodeId = normalizedString(req.body?.role_node_id);
        if (!roleNodeId) {
          sendError(res, 400, 'role_node_id is required for task nodes');
          return;
        }
        const roleNode = findWorkflowNode(snapshot, roleNodeId);
        if (!roleNode || roleNode.node_type !== 'role') {
          sendError(res, 400, 'role_node_id must reference a role node in this workflow');
          return;
        }
        patch.role_node_id = roleNodeId;
      }
      if (req.body?.assistant_id !== undefined) {
        if (typeof req.body.assistant_id !== 'string') {
          sendError(res, 400, 'assistant_id must be a string');
          return;
        }
        const assistantId = normalizedString(req.body?.assistant_id);
        if (assistantId) {
          const assistantIds = await getVisibleAssistantIds();
          if (!assistantIds.has(assistantId)) {
            sendError(res, 400, 'assistant_id must reference an assistant you can access');
            return;
          }
        }
        patch.assistant_id = assistantId;
      }
      if (req.body?.config_json && typeof req.body.config_json === 'object') {
        patch.config_json = JSON.stringify(req.body.config_json);
      }
      if (typeof req.body?.position_x === 'number') patch.position_x = req.body.position_x;
      if (typeof req.body?.position_y === 'number') patch.position_y = req.body.position_y;
      await db.updateWorkflowNode(nodeId, patch);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: PUT node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.delete('/workflows/:id/nodes/:nodeId', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      await db.deleteWorkflowNode(nodeId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: DELETE node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/:id/edges', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      if (!isEdgeDirection(req.body?.direction)) {
        sendError(res, 400, 'direction must be one_way or two_way');
        return;
      }
      if (
        typeof req.body?.source_node_id !== 'string' ||
        typeof req.body?.target_node_id !== 'string'
      ) {
        sendError(res, 400, 'source_node_id and target_node_id are required');
        return;
      }
      const edge = await db.createWorkflowEdge(workflowId, {
        source_node_id: req.body.source_node_id,
        target_node_id: req.body.target_node_id,
        direction: req.body.direction,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
        config_json:
          req.body?.config_json && typeof req.body.config_json === 'object'
            ? (req.body.config_json as Record<string, unknown>)
            : undefined,
      });
      res.json(edge);
    } catch (err) {
      logger.error({ err }, 'workflow routes: POST edge failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put('/workflows/:id/edges/:edgeId', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const edgeId = paramId(req.params.edgeId);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const patch: Record<string, unknown> = {};
      if (typeof req.body?.source_node_id === 'string') patch.source_node_id = req.body.source_node_id;
      if (typeof req.body?.target_node_id === 'string') patch.target_node_id = req.body.target_node_id;
      if (isEdgeDirection(req.body?.direction)) patch.direction = req.body.direction;
      if (typeof req.body?.label === 'string') patch.label = req.body.label;
      if (req.body?.config_json && typeof req.body.config_json === 'object') {
        patch.config_json = JSON.stringify(req.body.config_json);
      }
      await db.updateWorkflowEdge(edgeId, patch);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: PUT edge failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.delete('/workflows/:id/edges/:edgeId', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const edgeId = paramId(req.params.edgeId);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      await db.deleteWorkflowEdge(edgeId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: DELETE edge failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/:id/validate', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const snapshot = await db.getWorkflowSnapshot(workflowId);
      if (!snapshot) {
        sendError(res, 404, 'Workflow not found');
        return;
      }
      try {
        validateWorkflowGraph(snapshot.nodes, snapshot.edges);
        res.json({ valid: true, errors: [] });
      } catch (err) {
        res.json({
          valid: false,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    } catch (err) {
      logger.error({ err }, 'workflow routes: validate failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/:id/runs', viewGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(await db.listWorkflowRuns(workflowId));
    } catch (err) {
      logger.error({ err }, 'workflow routes: list runs failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/:id/run', manageGuard, async (req, res) => {
    try {
      const workflowId = paramId(req.params.id);
      const access = await requireWorkflowForUser(workflowId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const input =
        typeof req.body?.input === 'string'
          ? req.body.input
          : req.body?.input == null
            ? ''
            : JSON.stringify(req.body.input);
      const orchestrator = new WorkflowOrchestrator(workflowId);
      res.json(await orchestrator.startRun(input));
    } catch (err) {
      logger.error({ err }, 'workflow routes: start run failed');
      sendError(res, 400, err instanceof Error ? err.message : 'Internal error');
    }
  });

  router.get('/workflows/run/:runId', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(access.run);
    } catch (err) {
      logger.error({ err }, 'workflow routes: get run failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/run/:runId/graph', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(await db.getWorkflowRunGraph(runId));
    } catch (err) {
      logger.error({ err }, 'workflow routes: get run graph failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/run/:runId/metrics', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const graph = await db.getWorkflowRunGraph(runId);
      if (!graph) {
        sendError(res, 404, 'Run not found');
        return;
      }
      res.json(computeWorkflowRunMetrics(graph));
    } catch (err) {
      logger.error({ err }, 'workflow routes: get run metrics failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/run/:runId/evaluation', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const evaluation = await db.getWorkflowRunEvaluation(runId);
      res.json(evaluation ? serializeWorkflowEvaluation(evaluation) : null);
    } catch (err) {
      logger.error({ err }, 'workflow routes: get run evaluation failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/evaluate', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const evaluation = await evaluateAndPersistWorkflowRun(runId);
      if (!evaluation) {
        sendError(res, 404, 'Run not found');
        return;
      }
      res.json(evaluation);
    } catch (err) {
      logger.error({ err }, 'workflow routes: evaluate run failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/run/:runId/transfers', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(await db.listWorkflowPendingTransfers(runId));
    } catch (err) {
      logger.error({ err }, 'workflow routes: list transfers failed');
      sendError(res, 500, 'Internal error');
    }
  });

  const mutateTransfer = (
    action: 'approve' | 'edit' | 'cancel' | 'release-now',
    handler: (
      orchestrator: WorkflowOrchestrator,
      transferId: string,
      req: Request,
    ) => Promise<void>,
  ) => {
    router.post(
      `/workflows/run/:runId/transfers/:transferId/${action}`,
      manageGuard,
      async (req: Request, res: Response) => {
        try {
          const runId = paramId(req.params.runId);
          const transferId = paramId(req.params.transferId);
          const access = await requireRunForUser(runId);
          if (!access.ok) {
            sendError(res, access.status, access.message);
            return;
          }
          const transfer = await db.getWorkflowPendingTransfer(transferId);
          if (!transfer || transfer.run_id !== runId) {
            sendError(res, 404, 'Transfer not found');
            return;
          }
          const orchestrator =
            getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
          if (!orchestrator) {
            sendError(res, 500, 'Failed to restore orchestrator');
            return;
          }
          await handler(orchestrator, transferId, req);
          res.json({ ok: true });
        } catch (err) {
          logger.error({ err }, `workflow routes: transfer ${action} failed`);
          sendError(res, 400, err instanceof Error ? err.message : 'Internal error');
        }
      },
    );
  };

  mutateTransfer('approve', async (orchestrator, transferId) => {
    await orchestrator.approveTransfer(transferId);
  });
  mutateTransfer('edit', async (orchestrator, transferId, req) => {
    if (typeof req.body?.content !== 'string' || !req.body.content.trim()) {
      throw new Error('content is required');
    }
    await orchestrator.editTransfer(transferId, req.body.content.trim());
  });
  mutateTransfer('cancel', async (orchestrator, transferId) => {
    await orchestrator.cancelTransfer(transferId);
  });
  mutateTransfer('release-now', async (orchestrator, transferId) => {
    await orchestrator.releaseTransferNow(transferId);
  });

  router.get('/workflows/run/:runId/artifacts', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      res.json(await ensureWorkflowArtifacts(runId));
    } catch (err) {
      logger.error({ err }, 'workflow routes: artifacts failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.get('/workflows/run/:runId/export', viewGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const bundle = await buildWorkflowExportBundle(runId);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="workflow-${runId}.json"`,
      );
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      logger.error({ err }, 'workflow routes: export failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/commit-and-push', manageGuard, async (req, res) => {
    try {
      opts.auditMutation?.(req, 'workflows.commit-and-push', 'high');
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const artifact = await commitAndPushWorkflowRun(runId);
      res.json({ ok: artifact.status === 'pushed', artifact });
    } catch (err) {
      logger.error({ err }, 'workflow routes: commit-and-push failed');
      sendError(res, 400, err instanceof Error ? err.message : 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/publish', manageGuard, async (req, res) => {
    try {
      opts.auditMutation?.(req, 'workflows.publish', 'high');
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const target =
        req.body?.target === 'skill' ||
        req.body?.target === 'mcp' ||
        req.body?.target === 'system'
          ? req.body.target
          : undefined;
      const config = parseWorkflowConfig(access.workflow);
      const effectiveTarget =
        target ||
        config.artifactPolicy.publishTarget ||
        config.publishTarget ||
        (config.kind === 'mcp'
          ? 'mcp'
          : config.kind === 'system_capability'
            ? 'system'
            : 'skill');
      if (
        (effectiveTarget === 'system' || requiresSystemWorkflowAdmin(config)) &&
        !(await runPermissionGuard(systemWorkflowGuard, req, res))
      ) {
        return;
      }
      const artifact = await publishWorkflowRun({ runId, target });
      res.json({ ok: true, artifact });
    } catch (err) {
      logger.error({ err }, 'workflow routes: publish failed');
      sendError(res, 400, err instanceof Error ? err.message : 'Internal error');
    }
  });

  router.post(
    '/workflows/run/:runId/edges/:edgeId/feedback',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const edgeId = paramId(req.params.edgeId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        if (typeof req.body?.content !== 'string' || !req.body.content.trim()) {
          sendError(res, 400, 'content is required');
          return;
        }
        const graph = await db.getWorkflowRunGraph(runId);
        const edge = graph?.edges.find((item) => item.id === edgeId);
        if (!graph || !edge) {
          sendError(res, 404, 'Edge not found on this run');
          return;
        }
        const feedbackDirection =
          req.body?.direction === 'reverse' ? 'reverse' : 'forward';
        const orchestrator =
          getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
        if (!orchestrator) {
          sendError(res, 500, 'Failed to restore orchestrator');
          return;
        }
        await orchestrator.insertFeedbackFrame(
          edge.id,
          req.body.content.trim(),
          feedbackDirection,
        );
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'workflow routes: create feedback frame failed');
        sendError(res, 500, 'Internal error');
      }
    },
  );

  router.post('/workflows/run/:runId/pause', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.pauseRun();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: pause run failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/resume', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.resumeRun();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: resume run failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/cancel', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.cancelRun();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: cancel run failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/nodes/:nodeId/pause', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.pauseNode(nodeId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: pause node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.post('/workflows/run/:runId/nodes/:nodeId/resume', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.resumeNode(nodeId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: resume node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put('/workflows/run/:runId/nodes/:nodeId/input', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      if (typeof req.body?.input !== 'string') {
        sendError(res, 400, 'input is required');
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.updateNodeInput(nodeId, req.body.input);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: update node input failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put('/workflows/run/:runId/nodes/:nodeId/output', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      if (typeof req.body?.output !== 'string') {
        sendError(res, 400, 'output is required');
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.updateNodeOutput(nodeId, req.body.output);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: update node output failed');
      sendError(res, 500, 'Internal error');
    }
  });

  router.put(
    '/workflows/run/:runId/nodes/:nodeId/input-config',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const nodeId = paramId(req.params.nodeId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const graph = await db.getWorkflowRunGraph(runId);
        const runNode = graph?.runNodes.find((item) => item.node_id === nodeId);
        if (!graph || !runNode) {
          sendError(res, 404, 'Run node not found');
          return;
        }
        const anchorFrameId =
          typeof req.body?.input_anchor_frame_id === 'string'
            ? req.body.input_anchor_frame_id.trim()
            : '';
        if (anchorFrameId) {
          const frame = graph.messageFrames.find((item) => item.id === anchorFrameId);
          if (!frame || frame.target_node_id !== nodeId) {
            sendError(res, 400, 'input_anchor_frame_id must target this node');
            return;
          }
        }
        const priorityMode =
          req.body?.input_priority_mode === 'chronological'
            ? 'chronological'
            : 'feedback_first';
        const orchestrator =
          getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
        if (!orchestrator) {
          sendError(res, 500, 'Failed to restore orchestrator');
          return;
        }
        await orchestrator.updateNodeInputConfig({
          nodeId,
          inputAnchorFrameId: anchorFrameId,
          inputPriorityMode: priorityMode,
        });
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'workflow routes: update input config failed');
        sendError(res, 500, 'Internal error');
      }
    },
  );

  router.post('/workflows/run/:runId/nodes/:nodeId/retry', manageGuard, async (req, res) => {
    try {
      const runId = paramId(req.params.runId);
      const nodeId = paramId(req.params.nodeId);
      const access = await requireRunForUser(runId);
      if (!access.ok) {
        sendError(res, access.status, access.message);
        return;
      }
      const orchestrator =
        getWorkflowOrchestrator(runId) ?? (await WorkflowOrchestrator.restore(runId));
      if (!orchestrator) {
        sendError(res, 500, 'Failed to restore orchestrator');
        return;
      }
      await orchestrator.retryNode(nodeId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'workflow routes: retry node failed');
      sendError(res, 500, 'Internal error');
    }
  });

  app.use('/api', router);
}
