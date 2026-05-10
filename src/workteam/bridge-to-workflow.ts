import * as workflowDb from '../db/workflows.js';
import type { WorkteamSnapshot } from '../db/workteam.js';
import { createBinding, listBindingsByOwner } from '../db/resource-bindings.js';

function parseDependencies(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const value = JSON.parse(trimmed) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseAgentToolsConfig(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildRolePositions(agentCount: number): Array<{ x: number; y: number }> {
  return Array.from({ length: agentCount }, (_, index) => ({
    x: 60,
    y: 80 + index * 140,
  }));
}

function buildTaskLevels(tasks: WorkteamSnapshot['tasks']): Map<string, number> {
  const idSet = new Set(tasks.map((task) => task.id));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const levels = new Map<string, number>();
  for (const task of tasks) {
    indegree.set(task.id, 0);
    adjacency.set(task.id, []);
    levels.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dep of parseDependencies(task.dependencies).filter((dep) => idSet.has(dep))) {
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      adjacency.get(dep)?.push(task.id);
    }
  }
  const queue = tasks
    .map((task) => task.id)
    .filter((taskId) => (indegree.get(taskId) ?? 0) === 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const baseLevel = levels.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, baseLevel + 1));
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  return levels;
}

export async function bridgeWorkteamToWorkflow(input: {
  snapshot: WorkteamSnapshot;
  userId: string;
  workflowName?: string;
}): Promise<Awaited<ReturnType<typeof workflowDb.getWorkflowSnapshot>>> {
  const { snapshot, userId } = input;
  const workflow = await workflowDb.createWorkflow({
    name: input.workflowName?.trim() || `${snapshot.team.name} Workflow`,
    description: snapshot.team.description,
    workflow_config: {
      source_workteam_id: snapshot.team.id,
      source_process_type: snapshot.team.process_type,
      migrated_from: 'workteam',
    },
  });

  const rolePositions = buildRolePositions(snapshot.agents.length);
  const roleNodeIdByAgentId = new Map<string, string>();
  for (const [index, agent] of snapshot.agents.entries()) {
    const node = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'role',
      name: agent.role,
      description: agent.goal,
      assistant_id: agent.assistant_id || undefined,
      config_json: {
        goal: agent.goal,
        backstory: agent.backstory,
        legacyToolsConfig: parseAgentToolsConfig(agent.tools_config),
        sourceWorkteamAgentId: agent.id,
      },
      position_x: rolePositions[index]?.x ?? 60,
      position_y: rolePositions[index]?.y ?? 80 + index * 140,
      sort_order: agent.sort_order,
    });
    roleNodeIdByAgentId.set(agent.id, node.id);
  }

  const levels = buildTaskLevels(snapshot.tasks);
  const taskNodeIdByTaskId = new Map<string, string>();
  const taskBuckets = new Map<number, number>();
  for (const task of snapshot.tasks) {
    const level = levels.get(task.id) ?? 0;
    const rowIndex = taskBuckets.get(level) ?? 0;
    taskBuckets.set(level, rowIndex + 1);
    const node = await workflowDb.createWorkflowNode(workflow.id, {
      node_type: 'task',
      name: task.name,
      description: task.description,
      role_node_id: roleNodeIdByAgentId.get(task.agent_id) || '',
      config_json: {
        expectedOutput: task.expected_output,
        timeoutMs: task.timeout_ms,
        retryLimit: task.retry_limit,
        legacyEvalConfig: task.eval_config,
        sourceWorkteamTaskId: task.id,
      },
      position_x: 340 + level * 260,
      position_y: 80 + rowIndex * 140,
      sort_order: task.sort_order,
    });
    taskNodeIdByTaskId.set(task.id, node.id);
  }

  for (const task of snapshot.tasks) {
    const targetNodeId = taskNodeIdByTaskId.get(task.id);
    if (!targetNodeId) continue;
    for (const dep of parseDependencies(task.dependencies)) {
      const sourceNodeId = taskNodeIdByTaskId.get(dep);
      if (!sourceNodeId) continue;
      await workflowDb.createWorkflowEdge(workflow.id, {
        source_node_id: sourceNodeId,
        target_node_id: targetNodeId,
        direction: 'one_way',
        config_json: {
          sourceWorkteamDependency: true,
        },
      });
    }
  }

  const bindings = await listBindingsByOwner('workteam', snapshot.team.id);
  for (const binding of bindings) {
    await createBinding(
      {
        resourceType: binding.resource_type,
        resourceId: binding.resource_id,
        ownerType: 'workflow',
        ownerId: workflow.id,
        bindingKey: binding.binding_key,
        branch: binding.branch,
        workDirectory: binding.work_directory,
        configJson: binding.config_json,
      },
      userId,
    );
  }

  return workflowDb.getWorkflowSnapshot(workflow.id);
}
