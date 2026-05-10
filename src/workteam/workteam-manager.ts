import { createModuleLogger } from '../logger.js';
import * as db from '../db/workteam.js';
import { buildTaskGraph, validateDAG, topologicalSort } from './workflow-engine.js';
import type {
  CreateWorkteamInput,
  CreateWorkteamAgentInput,
  CreateWorkteamTaskInput,
  WorkteamRecord,
  WorkteamAgentRecord,
  WorkteamTaskRecord,
} from './types.js';
import type { WorkteamSnapshot } from '../db/workteam.js';

const logger = createModuleLogger('workteam');

function parseDependencyIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export async function createTeam(input: CreateWorkteamInput): Promise<WorkteamRecord> {
  return db.createWorkteam(input);
}

export async function getTeamSnapshot(teamId: string): Promise<WorkteamSnapshot | undefined> {
  return db.getWorkteamSnapshot(teamId);
}

export async function addAgent(
  teamId: string,
  input: CreateWorkteamAgentInput,
): Promise<WorkteamAgentRecord> {
  const team = await db.getWorkteam(teamId);
  if (!team) {
    throw new Error(`Workteam not found: ${teamId}`);
  }
  return db.addWorkteamAgent(teamId, input);
}

export async function addTask(
  teamId: string,
  input: CreateWorkteamTaskInput,
): Promise<WorkteamTaskRecord> {
  const team = await db.getWorkteam(teamId);
  if (!team) {
    throw new Error(`Workteam not found: ${teamId}`);
  }
  const existing = await db.getWorkteamTasks(teamId);
  const taskIds = new Set(existing.map((t) => t.id));
  const deps = input.dependencies ?? [];
  for (const depId of deps) {
    if (!taskIds.has(depId)) {
      throw new Error(`Dependency task not found on team: ${depId}`);
    }
  }
  return db.addWorkteamTask(teamId, input);
}

export async function validateTeamConfig(teamId: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const snapshot = await db.getWorkteamSnapshot(teamId);
  if (!snapshot) {
    errors.push(`Team not found: ${teamId}`);
    return { valid: false, errors };
  }
  const { tasks, agents } = snapshot;
  if (tasks.length === 0) {
    errors.push('At least one task is required');
  }
  const agentIds = new Set(agents.map((a) => a.id));
  for (const t of tasks) {
    if (!agentIds.has(t.agent_id)) {
      errors.push(`Task "${t.name}" (${t.id}) has no matching agent: ${t.agent_id}`);
    }
  }
  const graph = buildTaskGraph(tasks);
  const dag = validateDAG(graph);
  if (!dag.valid) {
    const hint = dag.cycle?.length ? ` Cycle: ${dag.cycle.join(' → ')}` : '';
    errors.push(`Task graph is not a valid DAG.${hint}`);
  }
  return { valid: errors.length === 0, errors };
}

export async function markTeamReady(teamId: string): Promise<void> {
  const { valid, errors } = await validateTeamConfig(teamId);
  if (!valid) {
    throw new Error(errors.join('; ') || 'Invalid team configuration');
  }
  await db.updateWorkteam(teamId, { status: 'ready' });
}

export async function deleteTeam(teamId: string): Promise<void> {
  await db.deleteWorkteam(teamId);
}

export async function cloneTeam(teamId: string, newName: string): Promise<WorkteamRecord | undefined> {
  const snapshot = await db.getWorkteamSnapshot(teamId);
  if (!snapshot) {
    return undefined;
  }
  const { team, agents, tasks } = snapshot;
  let workflowConfig: Record<string, unknown> = {};
  try {
    workflowConfig = JSON.parse(team.workflow_config || '{}') as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, teamId }, 'workteam cloneTeam: invalid workflow_config JSON, using {}');
  }
  const created = await db.createWorkteam({
    name: newName,
    description: team.description,
    process_type: team.process_type,
    workflow_config: workflowConfig,
  });
  const newTeamId = created.id;

  const agentIdMap = new Map<string, string>();
  for (const a of agents) {
    let tools: Record<string, unknown> = {};
    try {
      tools = JSON.parse(a.tools_config || '{}') as Record<string, unknown>;
    } catch {
      tools = {};
    }
    const na = await db.addWorkteamAgent(newTeamId, {
      role: a.role,
      goal: a.goal,
      backstory: a.backstory,
      assistant_id: a.assistant_id || undefined,
      tools_config: tools,
      sort_order: a.sort_order,
    });
    agentIdMap.set(a.id, na.id);
  }

  const taskIdMap = new Map<string, string>();
  if (tasks.length > 0) {
    let order: string[];
    try {
      order = topologicalSort(buildTaskGraph(tasks));
    } catch (err) {
      logger.error({ err, teamId }, 'workteam cloneTeam: topological sort failed');
      await db.deleteWorkteam(newTeamId);
      return undefined;
    }
    for (const tid of order) {
      const t = tasks.find((x) => x.id === tid);
      if (!t) continue;
      const oldDeps = parseDependencyIds(t.dependencies);
      const newDeps = oldDeps.map((d) => taskIdMap.get(d)).filter((d): d is string => Boolean(d));
      const mappedAgentId = agentIdMap.get(t.agent_id) ?? t.agent_id;
      const nt = await db.addWorkteamTask(newTeamId, {
        agent_id: mappedAgentId,
        name: t.name,
        description: t.description,
        expected_output: t.expected_output,
        dependencies: newDeps,
        sort_order: t.sort_order,
        timeout_ms: t.timeout_ms,
        retry_limit: t.retry_limit,
        eval_config: t.eval_config || undefined,
      });
      taskIdMap.set(t.id, nt.id);
    }
  }

  return db.getWorkteam(newTeamId) ?? created;
}
