import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeWorkflowTaskMock } = vi.hoisted(() => ({
  executeWorkflowTaskMock: vi.fn(),
}));

vi.mock('./tenant-context.js', () => ({
  getCurrentUserId: vi.fn(() => 'test-user'),
  SYSTEM_USER_ID: '__system__',
}));

vi.mock('./workflow/agent-adapter.js', () => ({
  AGENT_POLL_INTERVAL_MS: 1,
  DEFAULT_TASK_TIMEOUT_MS: 1000,
  buildTaskPrompt: vi.fn(() => 'prompt'),
  executeWorkflowTask: executeWorkflowTaskMock,
}));

import { _initTestDatabase } from './db/init.js';
import { createAssistant } from './db.js';
import * as workflowDb from './db/workflows.js';
import { registerWorkflowRoutes } from './routes/workflow-routes.js';

type RequirePermissionFn = import('./auth/auth-middleware.js').RequirePermissionFn;

const allowAllRequirePermission: RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp(requirePermission: RequirePermissionFn = allowAllRequirePermission) {
  const app = express();
  app.use(express.json());
  registerWorkflowRoutes(app, { requirePermission });
  return app;
}

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const baseUrl = 'http://local.test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url;
    const url = new URL(rawUrl);
    if (url.origin !== baseUrl) return originalFetch(input, init);
    const response = await inject(app, {
      method: init?.method || 'GET',
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string> | undefined,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  }) as typeof fetch;
  try {
    await run(baseUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function createWorkflowFixture() {
  const assistant = await createAssistant({
    id: 'assistant-fixture',
    name: 'Fixture Assistant',
  });
  const workflow = await workflowDb.createWorkflow({
    name: 'Workflow Alpha',
    description: 'fixture',
    workflow_config: { messageDelayMs: 0 },
  });
  const role = await workflowDb.createWorkflowNode(workflow.id, {
    node_type: 'role',
    name: 'Architect',
    assistant_id: '',
    config_json: { goal: 'Plan', backstory: 'Senior architect' },
    position_x: 40,
    position_y: 80,
  });
  const taskA = await workflowDb.createWorkflowNode(workflow.id, {
    node_type: 'task',
    name: 'Plan',
    role_node_id: role.id,
    assistant_id: assistant.id,
    config_json: { prompt: 'Make plan', expectedOutput: 'Plan text' },
    position_x: 340,
    position_y: 80,
  });
  const taskB = await workflowDb.createWorkflowNode(workflow.id, {
    node_type: 'task',
    name: 'Build',
    role_node_id: role.id,
    assistant_id: assistant.id,
    config_json: { prompt: 'Build code', expectedOutput: 'Code diff' },
    position_x: 640,
    position_y: 80,
  });
  await workflowDb.createWorkflowEdge(workflow.id, {
    source_node_id: taskA.id,
    target_node_id: taskB.id,
    direction: 'one_way',
  });
  return { workflow, role, taskA, taskB, assistant };
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

describe('workflow routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
    const runsByNode = new Map<string, number>();
    executeWorkflowTaskMock.mockImplementation(async (input: {
      taskNode: { id: string; name: string };
      upstreamMessages?: Array<{ content: string }>;
    }) => {
      const current = (runsByNode.get(input.taskNode.id) ?? 0) + 1;
      runsByNode.set(input.taskNode.id, current);
      const hasFeedback = Boolean(
        input.upstreamMessages?.some((message) =>
          message.content.includes('[feedback]'),
        ),
      );
      return {
        success: true,
        output: hasFeedback
          ? `${input.taskNode.name} run ${current} with feedback`
          : `${input.taskNode.name} run ${current}`,
        execution_ms: 3,
        poll_count: 1,
      };
    });
  });

  it('creates and retrieves workflow snapshots', async () => {
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Launch Flow',
          description: 'new workflow',
        }),
      });
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { id: string };

      const nodeResponse = await fetch(`${baseUrl}/api/workflows/${created.id}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'role',
          name: 'Coordinator',
          config_json: { goal: 'Coordinate' },
        }),
      });
      expect(nodeResponse.status).toBe(200);

      const snapshotResponse = await fetch(`${baseUrl}/api/workflows/${created.id}`);
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();
      expect(snapshot).toMatchObject({
        workflow: expect.objectContaining({ name: 'Launch Flow' }),
      });
      expect(snapshot.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Coordinator', node_type: 'role' }),
          expect.objectContaining({ name: '输入', node_type: 'task' }),
          expect.objectContaining({ name: '资料检索', node_type: 'task' }),
          expect.objectContaining({ name: '分析', node_type: 'task' }),
          expect.objectContaining({ name: '总结', node_type: 'task' }),
        ]),
      );
      expect(JSON.parse(snapshot.workflow.workflow_config || '{}')).toMatchObject({
        editorMode: 'fixed_pipeline_v1',
      });
    });
  });

  it('allows the legacy workteam.create permission to create workflows without granting other workflow mutations', async () => {
    const createOnlyRequirePermission: RequirePermissionFn =
      (...codes) =>
      async (_req, res, next) => {
        if (codes.includes('workteam.create')) {
          next();
          return;
        }
        res.status(403).json({ error: 'Forbidden', required: codes });
      };
    const app = createApp(createOnlyRequirePermission);

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Create Only Flow' }),
      });
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as { id: string };

      const updateResponse = await fetch(`${baseUrl}/api/workflows/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'should not update' }),
      });
      expect(updateResponse.status).toBe(403);

      const nodeResponse = await fetch(`${baseUrl}/api/workflows/${created.id}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'role',
          name: 'Blocked Role',
          config_json: { goal: 'Coordinate' },
        }),
      });
      expect(nodeResponse.status).toBe(403);
    });
  });

  it('requires admin permission for system workflow creation and publication', async () => {
    const denySystemRequirePermission: RequirePermissionFn =
      (...codes) =>
      async (_req, res, next) => {
        if (
          codes.includes('admin.settings.write') ||
          codes.includes('marketplace.manage_sources')
        ) {
          res.status(403).json({ error: 'Forbidden', required: codes });
          return;
        }
        next();
      };
    const app = createApp(denySystemRequirePermission);
    const workflow = await workflowDb.createWorkflow({
      name: 'Private Flow',
      description: 'normal workflow',
      workflow_config: { kind: 'general', visibility: 'private' },
    });
    const systemWorkflow = await workflowDb.createWorkflow({
      name: 'System Flow',
      description: 'system workflow',
      workflow_config: { kind: 'system_capability', messageDelayMs: 0 },
    });
    const systemRun = await workflowDb.createWorkflowRun(systemWorkflow.id, 'publish');

    await withServer(app, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'System Capability',
          workflow_config: {
            kind: 'system_capability',
            visibility: 'system',
          },
        }),
      });
      expect(createResponse.status).toBe(403);

      const updateResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_config: {
            kind: 'general',
            visibility: 'system',
          },
        }),
      });
      expect(updateResponse.status).toBe(403);

      const publishResponse = await fetch(
        `${baseUrl}/api/workflows/run/${systemRun.id}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'system' }),
        },
      );
      expect(publishResponse.status).toBe(403);
    });

    const unchanged = await workflowDb.getWorkflow(workflow.id);
    expect(JSON.parse(unchanged?.workflow_config || '{}')).toMatchObject({
      visibility: 'private',
    });
  });

  it('rejects invalid assistant bindings and allows task nodes without assistant bindings', async () => {
    const app = createApp();
    const assistant = await createAssistant({
      id: 'assistant-bindable',
      name: 'Bindable Assistant',
    });
    const { workflow, role } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const missingRoleResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'task',
          name: 'Broken Task',
          config_json: { prompt: 'do work' },
        }),
      });
      expect(missingRoleResponse.status).toBe(200);
      await expect(missingRoleResponse.json()).resolves.toMatchObject({
        node_type: 'task',
        assistant_id: '',
      });

      const invalidAssistantResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'role',
          name: 'Role With Unknown Assistant',
          assistant_id: 'missing-assistant',
          config_json: { goal: 'Plan' },
        }),
      });
      expect(invalidAssistantResponse.status).toBe(400);
      await expect(invalidAssistantResponse.json()).resolves.toEqual({
        error: 'assistant_id must reference an assistant you can access',
      });

      const taskResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_type: 'task',
          name: 'Role Bound Task',
          role_node_id: role.id,
          assistant_id: assistant.id,
          config_json: { prompt: 'do work' },
        }),
      });
      expect(taskResponse.status).toBe(200);
      await expect(taskResponse.json()).resolves.toMatchObject({
        node_type: 'task',
        assistant_id: assistant.id,
      });

      const validRoleResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/nodes/${role.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant_id: assistant.id,
        }),
      });
      expect(validRoleResponse.status).toBe(200);
    });
  });

  it('rejects node and edge mutations that reference another workflow', async () => {
    const app = createApp();
    const first = await createWorkflowFixture();
    const secondWorkflow = await workflowDb.createWorkflow({
      name: 'Workflow Beta',
      description: 'foreign fixture',
      workflow_config: { messageDelayMs: 0 },
    });
    const secondRole = await workflowDb.createWorkflowNode(secondWorkflow.id, {
      node_type: 'role',
      name: 'Foreign Architect',
      config_json: { goal: 'Plan elsewhere' },
    });
    const secondTaskA = await workflowDb.createWorkflowNode(secondWorkflow.id, {
      node_type: 'task',
      name: 'Foreign Plan',
      role_node_id: secondRole.id,
      config_json: { prompt: 'Plan elsewhere' },
    });
    const secondTaskB = await workflowDb.createWorkflowNode(secondWorkflow.id, {
      node_type: 'task',
      name: 'Foreign Build',
      role_node_id: secondRole.id,
      config_json: { prompt: 'Build elsewhere' },
    });
    await workflowDb.createWorkflowEdge(secondWorkflow.id, {
      source_node_id: secondTaskA.id,
      target_node_id: secondTaskB.id,
      direction: 'one_way',
    });
    const secondEdge = (await workflowDb.listWorkflowEdges(secondWorkflow.id))[0];

    await withServer(app, async (baseUrl) => {
      const foreignEdgeCreateResponse = await fetch(
        `${baseUrl}/api/workflows/${first.workflow.id}/edges`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_node_id: first.taskA.id,
            target_node_id: secondTaskA.id,
            direction: 'one_way',
          }),
        },
      );
      expect(foreignEdgeCreateResponse.status).toBe(400);
      await expect(foreignEdgeCreateResponse.json()).resolves.toEqual({
        error: 'target_node_id must reference a node in this workflow',
      });

      const foreignEdgeUpdateResponse = await fetch(
        `${baseUrl}/api/workflows/${first.workflow.id}/edges/${secondEdge.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'should not update' }),
        },
      );
      expect(foreignEdgeUpdateResponse.status).toBe(404);
      await expect(foreignEdgeUpdateResponse.json()).resolves.toEqual({
        error: 'Edge not found',
      });

      const firstEdge = (await workflowDb.listWorkflowEdges(first.workflow.id))[0];
      const foreignEndpointUpdateResponse = await fetch(
        `${baseUrl}/api/workflows/${first.workflow.id}/edges/${firstEdge.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_node_id: secondTaskB.id }),
        },
      );
      expect(foreignEndpointUpdateResponse.status).toBe(400);
      await expect(foreignEndpointUpdateResponse.json()).resolves.toEqual({
        error: 'source_node_id must reference a node in this workflow',
      });

      const foreignEdgeDeleteResponse = await fetch(
        `${baseUrl}/api/workflows/${first.workflow.id}/edges/${secondEdge.id}`,
        { method: 'DELETE' },
      );
      expect(foreignEdgeDeleteResponse.status).toBe(404);

      const foreignNodeDeleteResponse = await fetch(
        `${baseUrl}/api/workflows/${first.workflow.id}/nodes/${secondTaskA.id}`,
        { method: 'DELETE' },
      );
      expect(foreignNodeDeleteResponse.status).toBe(404);
    });

    expect((await workflowDb.listWorkflowEdges(secondWorkflow.id)).map((edge) => edge.id)).toContain(
      secondEdge.id,
    );
    expect((await workflowDb.listWorkflowNodes(secondWorkflow.id)).map((node) => node.id)).toContain(
      secondTaskA.id,
    );
  });

  it('validates a workflow and reports structural errors', async () => {
    const app = createApp();
    const { workflow, taskA } = await createWorkflowFixture();

    await workflowDb.updateWorkflowNode(taskA.id, { role_node_id: '' });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/workflows/${workflow.id}/validate`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ valid: true, errors: [] });
    });
  });

  it('fails at runtime when a task node has no execution assistant', async () => {
    const app = createApp();
    const { workflow, taskA } = await createWorkflowFixture();
    await workflowDb.updateWorkflowNode(taskA.id, { assistant_id: '' });

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Run without executor' }),
      });
      expect(startResponse.status).toBe(200);
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return graph?.runNodes.some((node) => node.status === 'failed') ?? false;
      });

      const graph = await workflowDb.getWorkflowRunGraph(run.id);
      expect(graph?.runNodes.find((node) => node.node_id === taskA.id)?.last_error).toBe(
        '该节点缺少执行主体',
      );
    });
  });

  it('starts a run and exposes graph state, messages, and interventions', async () => {
    const app = createApp();
    const { workflow, taskA } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Build a release plan' }),
      });
      expect(startResponse.status).toBe(200);
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return Boolean(graph?.runNodes.some((node) => node.output_snapshot));
      });

      const graphResponse = await fetch(`${baseUrl}/api/workflows/run/${run.id}/graph`);
      expect(graphResponse.status).toBe(200);
      const graph = (await graphResponse.json()) as {
        runNodes: Array<{ node_id: string; output_snapshot: string }>;
        messages: Array<{ source_node_id: string; target_node_id: string }>;
        dialogueSessions: Array<{ edge_id: string; turn_count: number }>;
        messageFrames: Array<{ edge_id: string; content_text: string }>;
      };
      expect(graph.runNodes.some((node) => /run 1$/.test(node.output_snapshot))).toBe(true);
      expect(graph.messages.some((message) => message.source_node_id === taskA.id)).toBe(true);
      expect(graph.dialogueSessions.some((session) => session.turn_count >= 1)).toBe(true);
      expect(graph.messageFrames.some((frame) => /run 1$/.test(frame.content_text))).toBe(true);
    });
  });

  it('queues transfer messages for review before release', async () => {
    const app = createApp();
    const workflow = await workflowDb.createWorkflow({
      name: 'Delayed Flow',
      description: 'delayed transfer',
      workflow_config: { messageDelayMs: 60_000 },
    });
    const role = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'role',
      name: 'Worker',
      assistant_id: 'assistant-delayed',
      config_json: { goal: 'Work' },
    });
    const taskA = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: 'Draft',
      role_node_id: role.id,
      config_json: { prompt: 'Draft' },
    });
    const taskB = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: 'Review',
      role_node_id: role.id,
      config_json: { prompt: 'Review' },
    });
    await workflowDb.createWorkflowEdge(workflow.id, {
      source_node_id: taskA.id,
      target_node_id: taskB.id,
      direction: 'one_way',
    });

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Delay this handoff' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const transfers = await workflowDb.listWorkflowPendingTransfers(run.id);
        return transfers.length === 1 && transfers[0].status === 'pending';
      });

      let graph = await workflowDb.getWorkflowRunGraph(run.id);
      expect(graph?.messages).toHaveLength(0);
      expect(graph?.runNodes.find((node) => node.node_id === taskB.id)?.status).toBe(
        'pending',
      );
      const transfer = (await workflowDb.listWorkflowPendingTransfers(run.id))[0];

      const editResponse = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/transfers/${transfer.id}/edit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: 'Edited handoff content' }),
        },
      );
      expect(editResponse.status).toBe(200);

      const releaseResponse = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/transfers/${transfer.id}/release-now`,
        { method: 'POST' },
      );
      expect(releaseResponse.status).toBe(200);

      await waitFor(async () => {
        const updated = await workflowDb.getWorkflowRunGraph(run.id);
        return Boolean(
          updated?.messageFrames.some((frame) =>
            frame.content_text.includes('Edited handoff content'),
          ),
        );
      });

      graph = await workflowDb.getWorkflowRunGraph(run.id);
      expect(graph?.pendingTransfers[0]).toMatchObject({ status: 'sent' });
      expect(graph?.messageFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content_text: 'Edited handoff content' }),
        ]),
      );
    });
  });

  it('generates artifacts and exports a run bundle', async () => {
    const app = createApp();
    const { workflow } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Build artifacts' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return graph?.run.status === 'completed';
      });

      const artifactsResponse = await fetch(`${baseUrl}/api/workflows/run/${run.id}/artifacts`);
      expect(artifactsResponse.status).toBe(200);
      const artifacts = (await artifactsResponse.json()) as Array<{ artifact_type: string }>;
      expect(artifacts.map((artifact) => artifact.artifact_type)).toEqual(
        expect.arrayContaining(['summary', 'bundle']),
      );

      const exportResponse = await fetch(`${baseUrl}/api/workflows/run/${run.id}/export`);
      expect(exportResponse.status).toBe(200);
      const exported = (await exportResponse.json()) as { graph?: { run?: { id?: string } } };
      expect(exported.graph?.run?.id).toBe(run.id);
    });
  });

  it('allows runtime input/output intervention and persists it on the run graph', async () => {
    const app = createApp();
    const { workflow, taskA } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Implement feature X' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return Boolean(graph?.runNodes.find((node) => node.node_id === taskA.id));
      });

      const inputResponse = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/nodes/${taskA.id}/input`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '{"manual":"input"}' }),
        },
      );
      expect(inputResponse.status).toBe(200);

      const outputResponse = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/nodes/${taskA.id}/output`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ output: 'manual output override' }),
        },
      );
      expect(outputResponse.status).toBe(200);

      const graph = await workflowDb.getWorkflowRunGraph(run.id);
      const runNode = graph?.runNodes.find((node) => node.node_id === taskA.id);
      expect(runNode?.input_snapshot).toBe('{"manual":"input"}');
      expect(runNode?.output_snapshot).toBe('manual output override');
      expect(graph?.interventions).toEqual([
        expect.objectContaining({ intervention_type: 'input_update' }),
        expect.objectContaining({ intervention_type: 'output_update' }),
      ]);
    });
  });

  it('keeps an aborted running node paused when pause-node is requested', async () => {
    const app = createApp();
    const { workflow, taskA } = await createWorkflowFixture();
    let runningSignal: AbortSignal | undefined;

    executeWorkflowTaskMock.mockImplementationOnce(async (input: { signal?: AbortSignal }) => {
      runningSignal = input.signal;
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          resolve();
          return;
        }
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        success: false,
        error: 'aborted by pause',
        execution_ms: 3,
        poll_count: 1,
      };
    });

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Pause the running node' }),
      });
      expect(startResponse.status).toBe(200);
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => Boolean(runningSignal));

      const pauseResponse = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/nodes/${taskA.id}/pause`,
        { method: 'POST' },
      );
      expect(pauseResponse.status).toBe(200);

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return graph?.runNodes.find((node) => node.node_id === taskA.id)?.status === 'paused';
      });

      const graph = await workflowDb.getWorkflowRunGraph(run.id);
      expect(graph?.run.status).toBe('running');
      expect(graph?.runNodes.find((node) => node.node_id === taskA.id)).toMatchObject({
        status: 'paused',
        pause_reason: 'Node paused by user',
        last_error: '',
      });
    });
  });

  it('creates feedback frames on an edge during a run', async () => {
    const app = createApp();
    const { workflow, taskB } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Ship the feature' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return Boolean(graph?.edges[0]);
      });

      const graph = await workflowDb.getWorkflowRunGraph(run.id);
      const edgeId = graph?.edges[0]?.id;
      expect(edgeId).toBeTruthy();

      const response = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/edges/${edgeId}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'Please tighten the acceptance criteria.',
            direction: 'forward',
          }),
        },
      );
      expect(response.status).toBe(200);

      await waitFor(async () => {
        const rerun = await workflowDb.getWorkflowRunGraph(run.id);
        const target = rerun?.runNodes.find((node) => node.node_id === taskB.id);
        return target?.output_snapshot === 'Build run 2 with feedback';
      });

      const updated = await workflowDb.getWorkflowRunGraph(run.id);
      expect(updated?.messageFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            edge_id: edgeId,
            frame_type: 'feedback',
            content_text: 'Please tighten the acceptance criteria.',
          }),
        ]),
      );
      expect(
        updated?.runNodes.find((node) => node.node_id === taskB.id)?.output_snapshot,
      ).toBe('Build run 2 with feedback');
    });
  });

  it('updates run-node input baseline and priority mode', async () => {
    const app = createApp();
    const { workflow, taskB } = await createWorkflowFixture();

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Refine the plan' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return (graph?.messageFrames.length || 0) > 0;
      });

      const initial = await workflowDb.getWorkflowRunGraph(run.id);
      const targetFrame = initial?.messageFrames.find((frame) => frame.target_node_id === taskB.id);
      expect(targetFrame?.id).toBeTruthy();

      const response = await fetch(
        `${baseUrl}/api/workflows/run/${run.id}/nodes/${taskB.id}/input-config`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input_anchor_frame_id: targetFrame?.id,
            input_priority_mode: 'chronological',
          }),
        },
      );
      expect(response.status).toBe(200);

      const updated = await workflowDb.getWorkflowRunGraph(run.id);
      const runNode = updated?.runNodes.find((node) => node.node_id === taskB.id);
      expect(runNode?.input_anchor_frame_id).toBe(targetFrame?.id);
      expect(runNode?.input_priority_mode).toBe('chronological');
    });
  });

  it('passes node-level provider/model overrides through execution config', async () => {
    const app = createApp();
    const workflow = await workflowDb.createWorkflow({
      name: 'Override Flow',
      description: 'node execution overrides',
      workflow_config: { messageDelayMs: 0 },
    });
    const role = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'role',
      name: 'Builder',
      assistant_id: 'assistant-role',
      config_json: { goal: 'Build it' },
    });
    await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: 'Implement',
      role_node_id: role.id,
      config_json: {
        prompt: 'Implement the feature',
        providerOverrideId: 'provider-node',
        modelOverride: 'gpt-node',
        instructionsAppend: 'Node-specific override',
        allowedDirectories: ['/repo/main', '/repo/tests'],
      },
    });

    const observedInputs: Array<Record<string, unknown>> = [];
    executeWorkflowTaskMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
      observedInputs.push(input);
      return {
        success: true,
        output: 'override result',
        execution_ms: 3,
        poll_count: 1,
      };
    });

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Apply overrides' }),
      });
      expect(startResponse.status).toBe(200);

      await waitFor(async () => observedInputs.length > 0);
    });

    expect(observedInputs[0]).toMatchObject({
      taskNode: expect.objectContaining({ name: 'Implement' }),
    });
  });

  it('requeues discussion partners on two-way edges until the configured budget is exhausted', async () => {
    const app = createApp();
    const workflow = await workflowDb.createWorkflow({
      name: 'Discussion Flow',
      description: 'two-way loop',
      workflow_config: { messageDelayMs: 0 },
    });
    const role = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'role',
      name: 'Reviewer',
      assistant_id: 'assistant-discuss',
      config_json: { goal: 'Review peer output' },
    });
    const taskA = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: 'A',
      role_node_id: role.id,
      config_json: { prompt: 'A prompt', handoffPolicy: { cooldownMs: 0 } },
    });
    const taskB = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: 'B',
      role_node_id: role.id,
      config_json: { prompt: 'B prompt', handoffPolicy: { cooldownMs: 0 } },
    });
    await workflowDb.createWorkflowEdge(workflow.id, {
      source_node_id: taskA.id,
      target_node_id: taskB.id,
      direction: 'two_way',
      config_json: { discussionTurns: 4 },
    });

    await withServer(app, async (baseUrl) => {
      const startResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Discuss the design' }),
      });
      const run = (await startResponse.json()) as { id: string };

      await waitFor(async () => {
        const graph = await workflowDb.getWorkflowRunGraph(run.id);
        return graph?.run.status === 'completed';
      });

      const graph = await workflowDb.getWorkflowRunGraph(run.id);
      expect(graph?.messages).toHaveLength(4);
      expect(graph?.pendingTransfers.filter((transfer) => transfer.status !== 'sent')).toHaveLength(0);
      const nodeA = graph?.runNodes.find((node) => node.node_id === taskA.id);
      const nodeB = graph?.runNodes.find((node) => node.node_id === taskB.id);
      expect(nodeA?.output_snapshot).toMatch(/^A run [23]$/);
      expect(nodeB?.output_snapshot).toMatch(/^B run [12]$/);
    });
  });
});
