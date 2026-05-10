import type { TaskNode, TaskGraph, WorkteamTaskRecord } from './types.js';

function parseDependencyIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === 'string');
}

function emptyGraph(): TaskGraph {
  return {
    nodes: new Map(),
    adjacency: new Map(),
    reverseAdjacency: new Map(),
  };
}

function cloneInDegrees(graph: TaskGraph): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const id of graph.nodes.keys()) {
    inDegree.set(id, graph.reverseAdjacency.get(id)?.length ?? 0);
  }
  return inDegree;
}

/** Kahn topological order; may be shorter than |V| if a cycle exists. */
function kahnOrder(graph: TaskGraph): string[] {
  const inDegree = cloneInDegrees(graph);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of graph.adjacency.get(u) ?? []) {
      const next = (inDegree.get(v) ?? 0) - 1;
      inDegree.set(v, next);
      if (next === 0) queue.push(v);
    }
  }
  return order;
}

/**
 * Finds one directed cycle (path of node ids) using DFS three-color on
 * dependency → dependent edges.
 */
function findDirectedCyclePath(graph: TaskGraph): string[] | null {
  const color = new Map<string, 'white' | 'gray' | 'black'>();
  const path: string[] = [];

  const dfs = (u: string): string[] | null => {
    color.set(u, 'gray');
    path.push(u);
    for (const v of graph.adjacency.get(u) ?? []) {
      const cv = color.get(v) ?? 'white';
      if (cv === 'gray') {
        const i = path.indexOf(v);
        if (i === -1) return [v, u];
        return path.slice(i).concat(v);
      }
      if (cv === 'white') {
        const c = dfs(v);
        if (c) return c;
      }
    }
    path.pop();
    color.set(u, 'black');
    return null;
  };

  for (const id of graph.nodes.keys()) {
    if ((color.get(id) ?? 'white') === 'white') {
      const c = dfs(id);
      if (c) return c;
    }
  }
  return null;
}

export function buildTaskGraph(tasks: WorkteamTaskRecord[]): TaskGraph {
  const graph = emptyGraph();
  const taskIds = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    const deps = parseDependencyIds(t.dependencies).filter((d) => taskIds.has(d));
    const node: TaskNode = { id: t.id, agentId: t.agent_id, dependencies: deps };
    graph.nodes.set(t.id, node);
    graph.reverseAdjacency.set(t.id, deps);
    if (!graph.adjacency.has(t.id)) graph.adjacency.set(t.id, []);
  }

  for (const t of tasks) {
    const deps = graph.reverseAdjacency.get(t.id) ?? [];
    for (const d of deps) {
      if (!graph.adjacency.has(d)) graph.adjacency.set(d, []);
      graph.adjacency.get(d)!.push(t.id);
    }
  }

  return graph;
}

export function validateDAG(graph: TaskGraph): { valid: boolean; cycle?: string[] } {
  const order = kahnOrder(graph);
  if (order.length === graph.nodes.size) {
    return { valid: true };
  }
  const cycle = findDirectedCyclePath(graph);
  return { valid: false, cycle: cycle ?? undefined };
}

export function topologicalSort(graph: TaskGraph): string[] {
  const order = kahnOrder(graph);
  if (order.length !== graph.nodes.size) {
    const cycle = findDirectedCyclePath(graph);
    const hint = cycle?.length ? ` Cycle: ${cycle.join(' → ')}.` : '';
    throw new Error(`Task graph contains a cycle; topological sort is undefined.${hint}`);
  }
  return order;
}

export function getReadyTasks(
  graph: TaskGraph,
  completedTaskIds: Set<string>,
): string[] {
  const ready: string[] = [];
  for (const id of graph.nodes.keys()) {
    if (completedTaskIds.has(id)) continue;
    const deps = graph.reverseAdjacency.get(id) ?? [];
    const allDone = deps.every((d) => completedTaskIds.has(d));
    if (allDone) ready.push(id);
  }
  return ready;
}

function schedulingLayers(graph: TaskGraph): string[][] {
  const inDegree = cloneInDegrees(graph);
  const layers: string[][] = [];
  let frontier: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) frontier.push(id);
  }

  while (frontier.length > 0) {
    layers.push([...frontier].sort());
    const next: string[] = [];
    for (const u of frontier) {
      for (const v of graph.adjacency.get(u) ?? []) {
        const nv = (inDegree.get(v) ?? 0) - 1;
        inDegree.set(v, nv);
        if (nv === 0) next.push(v);
      }
    }
    frontier = next;
  }

  return layers;
}

export function getSchedulingOrder(
  tasks: WorkteamTaskRecord[],
  processType: 'sequential' | 'hierarchical' | 'dag',
): string[][] {
  const graph = buildTaskGraph(tasks);

  if (processType === 'hierarchical') {
    const sorted = [...tasks].sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.id.localeCompare(b.id);
    });
    return [sorted.map((t) => t.id)];
  }

  const order = topologicalSort(graph);

  if (processType === 'sequential') {
    return order.map((id) => [id]);
  }

  return schedulingLayers(graph);
}
