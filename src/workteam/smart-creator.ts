import { createModuleLogger } from '../logger.js';
import { resolvePromptText } from '../prompt/prompt-service.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import * as manager from './workteam-manager.js';
import type {
  SmartCreatorRequest,
  SmartCreatorResult,
  ProcessType,
  WorkteamRecord,
  WorkteamAgentRecord,
  WorkteamTaskRecord,
} from './types.js';

const logger = createModuleLogger('workteam');

const SMART_CREATOR_MAX_RETRIES = 2;
const SMART_CREATOR_TEMPERATURE = 0.7;

function isProcessType(x: unknown): x is ProcessType {
  return x === 'sequential' || x === 'hierarchical' || x === 'dag';
}

/**
 * Pull JSON from raw LLM output, including ```json ... ``` fences.
 */
export function extractJsonFromLlmText(raw: string): string {
  const trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = trimmed.match(fence);
  if (m?.[1]) {
    return m[1].trim();
  }
  return trimmed;
}

export function buildSmartCreatorPrompt(requirement: string, preferredProcessType?: ProcessType): string {
  const processHint = preferredProcessType
    ? `The user prefers workflow mode: "${preferredProcessType}". Use this process_type in your output unless it is clearly wrong for the requirement.`
    : 'Choose the best process_type for the requirement (no user preference was given).';

  return `You are an expert multi-agent team architect for NanoClaw workteams.

Your job: read the user's requirement and design a small, practical team of specialized agents and a task graph they will execute.

## Workflow modes (process_type)

- **sequential**: Tasks run one after another in a fixed chain. Use when work is strictly linear with no parallelism (e.g. simple pipelines, handoffs where only one task is active at a time).
- **hierarchical**: A coordinator-style flow: often one lead agent delegates or reviews while others execute in layers. Use when a manager/reviewer pattern fits better than a flat DAG.
- **dag**: Directed acyclic graph of tasks with explicit dependencies; independent branches can run in parallel when the engine allows. Use for real projects where design, implementation, and testing have clear prerequisites but some steps can overlap or fan out.

${processHint}

## Roles

- For **software / coding** projects, typical roles include: product_manager (or PM), architect, developer, tester, code_reviewer. Adapt names to snake_case or short role labels and keep them consistent between agents and tasks.
- For **other domains** (research, content, operations, data), pick a minimal set of domain experts with clear, non-overlapping responsibilities.

## Output format

Reply with **only** valid JSON (no markdown outside the JSON) matching this shape:

{
  "process_type": "sequential" | "hierarchical" | "dag",
  "agents": [
    { "role": string, "goal": string, "backstory": string }
  ],
  "tasks": [
    {
      "name": string,
      "description": string,
      "expected_output": string,
      "agent_role": string,
      "dependencies": string[]
    }
  ]
}

Rules:
- **agents**: each agent needs role, goal, and backstory (1–2 sentences for backstory).
- **tasks**: each task needs name, description, expected_output, agent_role (must equal one agent's role), and dependencies (array of **task names** this task depends on — use exact name strings, empty array if none).
- **DAG**: dependencies must not form cycles. Every dependency name must match another task's name.
- Keep the team small (typically 3–7 agents, 3–12 tasks) unless the requirement clearly needs more.

## User requirement

${requirement.trim() || '(empty — infer a sensible default software project team)'}`;
}

function asNonEmptyString(x: unknown, field: string): string | null {
  if (typeof x !== 'string' || !x.trim()) return null;
  return x.trim();
}

function normalizeAgent(raw: unknown): { role: string; goal: string; backstory: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const role = asNonEmptyString(o.role, 'role');
  const goal = asNonEmptyString(o.goal, 'goal');
  if (!role || !goal) return null;
  const backstory =
    typeof o.backstory === 'string' && o.backstory.trim()
      ? o.backstory.trim()
      : typeof o.backstory === 'string'
        ? ''
        : '';
  return { role, goal, backstory };
}

function normalizeTask(raw: unknown): SmartCreatorResult['tasks'][0] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = asNonEmptyString(o.name, 'name');
  const description = asNonEmptyString(o.description, 'description');
  if (!name || !description) return null;
  const expected_output =
    typeof o.expected_output === 'string' ? o.expected_output.trim() : '';
  const agent_role = asNonEmptyString(o.agent_role, 'agent_role');
  if (!agent_role) return null;
  let dependencies: string[] = [];
  if (Array.isArray(o.dependencies)) {
    dependencies = o.dependencies.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
  }
  return { name, description, expected_output, agent_role, dependencies };
}

/**
 * Parse LLM JSON output into SmartCreatorResult, or null if invalid.
 */
export function parseSmartCreatorResponse(raw: string): SmartCreatorResult | null {
  let payload: string;
  try {
    payload = extractJsonFromLlmText(raw);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  if (!isProcessType(root.process_type)) return null;
  if (!Array.isArray(root.agents) || !Array.isArray(root.tasks)) return null;

  const agents: SmartCreatorResult['agents'] = [];
  for (const a of root.agents) {
    const na = normalizeAgent(a);
    if (!na) return null;
    agents.push(na);
  }

  const tasks: SmartCreatorResult['tasks'] = [];
  for (const t of root.tasks) {
    const nt = normalizeTask(t);
    if (!nt) return null;
    tasks.push(nt);
  }

  return { process_type: root.process_type, agents, tasks };
}

function placeholderSmartResult(): SmartCreatorResult {
  return {
    process_type: 'dag',
    agents: [
      {
        role: 'product_manager',
        goal: 'Clarify scope, priorities, and acceptance criteria for the delivery.',
        backstory: 'Experienced PM who breaks vague asks into testable outcomes.',
      },
      {
        role: 'architect',
        goal: 'Produce a concise technical design and integration plan.',
        backstory: 'Senior engineer focused on simple, maintainable architecture.',
      },
      {
        role: 'developer',
        goal: 'Implement the feature set according to the agreed design.',
        backstory: 'Hands-on developer who ships readable, well-structured code.',
      },
      {
        role: 'tester',
        goal: 'Validate behavior, edge cases, and regression risk before release.',
        backstory: 'QA-minded engineer who writes clear repro steps and coverage notes.',
      },
    ],
    tasks: [
      {
        name: 'Requirements analysis',
        description: 'Capture goals, constraints, and acceptance criteria.',
        expected_output: 'Written requirements summary and open questions list.',
        agent_role: 'product_manager',
        dependencies: [],
      },
      {
        name: 'Architecture design',
        description: 'Define components, interfaces, and data flow.',
        expected_output: 'Architecture outline and key technical decisions.',
        agent_role: 'architect',
        dependencies: ['Requirements analysis'],
      },
      {
        name: 'Implementation',
        description: 'Build and integrate the solution per the architecture.',
        expected_output: 'Working implementation and brief implementation notes.',
        agent_role: 'developer',
        dependencies: ['Architecture design'],
      },
      {
        name: 'Testing',
        description: 'Exercise critical paths and document test results.',
        expected_output: 'Test report with pass/fail and follow-up issues.',
        agent_role: 'tester',
        dependencies: ['Implementation'],
      },
    ],
  };
}

function isPlaceholderResult(r: SmartCreatorResult): boolean {
  return r.agents.length === 4
    && r.agents[0]?.role === 'product_manager'
    && r.tasks.length === 4
    && r.tasks[0]?.name === 'Requirements analysis';
}

/**
 * Call the default LLM provider to generate team config, with retries and placeholder fallback.
 */
export async function generateTeamConfig(request: SmartCreatorRequest): Promise<SmartCreatorResult> {
  const processHint = request.preferred_process_type
    ? `The user prefers workflow mode: "${request.preferred_process_type}". Use this process_type in your output unless it is clearly wrong for the requirement.`
    : 'Choose the best process_type for the requirement (no user preference was given).';
  const prompt = (
    await resolvePromptText({
      promptKey: 'workteam.smart_creator',
      variables: {
        processHint,
        requirement:
          request.requirement.trim() || '(empty — infer a sensible default software project team)',
      },
      fallbackText: buildSmartCreatorPrompt(
        request.requirement,
        request.preferred_process_type,
      ),
    })
  ).text;
  logger.info({ promptLength: prompt.length }, 'workteam smart-creator: generateTeamConfig');

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= SMART_CREATOR_MAX_RETRIES; attempt++) {
    let actualPrompt = prompt;
    if (attempt > 0) {
      const retrySuffix = await resolvePromptText({
        promptKey: 'workteam.smart_creator.retry_suffix',
        variables: {
          error:
            lastError ||
            'Response was not valid JSON or did not match the expected schema',
        },
        fallbackText: `[IMPORTANT: Your previous response could not be parsed. Error: ${lastError}. Please return ONLY valid JSON matching the schema above.]`,
      });
      actualPrompt = `${prompt}\n\n${retrySuffix.text}`;
    }

    try {
      const raw = await generateTextWithDefaultProvider(actualPrompt, {
        temperature: SMART_CREATOR_TEMPERATURE,
        promptTrace: {
          promptKey: 'workteam.smart_creator',
          featureScope: 'workteam',
          metadata: {
            attempt,
            preferredProcessType: request.preferred_process_type || null,
          },
        },
      });
      logger.debug({ attempt, rawLength: raw.length }, 'workteam smart-creator: LLM response received');
      const result = parseSmartCreatorResponse(raw);
      if (result) return result;
      lastError = 'Response was not valid JSON or did not match the expected schema';
      logger.warn({ attempt, rawSnippet: raw.slice(0, 200) }, 'workteam smart-creator: parse failed, retrying');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, err: lastError }, 'workteam smart-creator: LLM call failed');
      if (attempt < SMART_CREATOR_MAX_RETRIES) continue;
    }
  }

  logger.warn({ lastError }, 'workteam smart-creator: all retries exhausted, falling back to placeholder');
  return placeholderSmartResult();
}

/**
 * Topological order of tasks by name. Throws if unknown dependency, self-dependency, duplicate names, or cycle.
 */
export function topologicalOrderSmartTasks(
  tasks: SmartCreatorResult['tasks'],
): string[] {
  const nameSet = new Set<string>();
  for (const t of tasks) {
    if (nameSet.has(t.name)) {
      throw new Error(`Duplicate task name: "${t.name}"`);
    }
    nameSet.add(t.name);
  }

  for (const t of tasks) {
    for (const d of t.dependencies) {
      if (!nameSet.has(d)) {
        throw new Error(`Task "${t.name}" depends on unknown task "${d}"`);
      }
      if (d === t.name) {
        throw new Error(`Task "${t.name}" cannot depend on itself`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    inDegree.set(t.name, t.dependencies.length);
    if (!adj.has(t.name)) adj.set(t.name, []);
  }

  for (const t of tasks) {
    for (const d of t.dependencies) {
      if (!adj.has(d)) adj.set(d, []);
      adj.get(d)!.push(t.name);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      const next = (inDegree.get(v) ?? 0) - 1;
      inDegree.set(v, next);
      if (next === 0) queue.push(v);
    }
  }

  if (order.length !== tasks.length) {
    throw new Error('Task dependencies contain a cycle; cannot create tasks in a valid order');
  }

  return order;
}

/**
 * Persist a parsed smart result: team, agents, then tasks in dependency order.
 */
export async function createTeamFromSmartResult(
  result: SmartCreatorResult,
  teamName: string,
): Promise<{ team: WorkteamRecord; agents: WorkteamAgentRecord[]; tasks: WorkteamTaskRecord[] }> {
  if (!result.agents.length) {
    throw new Error('SmartCreatorResult must include at least one agent');
  }

  const team = await manager.createTeam({
    name: teamName.trim() || 'Untitled team',
    description: '',
    process_type: result.process_type,
    workflow_config: {},
  });

  const agents: WorkteamAgentRecord[] = [];
  const roleToAgentId = new Map<string, string>();

  for (let i = 0; i < result.agents.length; i++) {
    const spec = result.agents[i]!;
    if (roleToAgentId.has(spec.role)) {
      logger.warn({ teamId: team.id, role: spec.role }, 'workteam smart-creator: duplicate agent role; first agent wins for task mapping');
    }
    const row = await manager.addAgent(team.id, {
      role: spec.role,
      goal: spec.goal,
      backstory: spec.backstory,
      sort_order: i,
      tools_config: spec.model_preference ? { model_preference: spec.model_preference } : undefined,
    });
    agents.push(row);
    if (!roleToAgentId.has(spec.role)) {
      roleToAgentId.set(spec.role, row.id);
    }
  }

  const createdTasks: WorkteamTaskRecord[] = [];
  if (result.tasks.length === 0) {
    return { team, agents, tasks: createdTasks };
  }

  const order = topologicalOrderSmartTasks(result.tasks);
  const byName = new Map(result.tasks.map((t) => [t.name, t] as const));
  const nameToTaskId = new Map<string, string>();

  let sortOrder = 0;
  for (const name of order) {
    const spec = byName.get(name);
    if (!spec) continue;
    const agentId = roleToAgentId.get(spec.agent_role);
    if (!agentId) {
      throw new Error(
        `Task "${spec.name}" references unknown agent_role "${spec.agent_role}". Known roles: ${[...roleToAgentId.keys()].join(', ')}`,
      );
    }
    const depIds = spec.dependencies.map((depName) => {
      const id = nameToTaskId.get(depName);
      if (!id) {
        throw new Error(`Internal error: missing task id for dependency "${depName}"`);
      }
      return id;
    });

    const row = await manager.addTask(team.id, {
      agent_id: agentId,
      name: spec.name,
      description: spec.description,
      expected_output: spec.expected_output,
      dependencies: depIds,
      sort_order: sortOrder++,
    });
    createdTasks.push(row);
    nameToTaskId.set(spec.name, row.id);
  }

  return { team, agents, tasks: createdTasks };
}

function deriveDefaultTeamName(requirement: string): string {
  const t = requirement.trim().replace(/\s+/g, ' ');
  if (!t) return 'Smart team';
  return t.length <= 20 ? t : t.slice(0, 20);
}

/**
 * End-to-end smart creation via default LLM provider, with placeholder fallback when generation fails.
 */
export async function smartCreateTeam(
  request: SmartCreatorRequest,
  teamName?: string,
): Promise<{ team: WorkteamRecord; agents: WorkteamAgentRecord[]; tasks: WorkteamTaskRecord[]; _usedFallback?: boolean }> {
  const result = await generateTeamConfig(request);
  const isFallback = isPlaceholderResult(result);
  const name = (teamName?.trim() || deriveDefaultTeamName(request.requirement)) || 'Smart team';
  const created = await createTeamFromSmartResult(result, name);
  return { ...created, _usedFallback: isFallback || undefined };
}
