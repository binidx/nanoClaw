import type {
  ProjectGraphEdgeConfidence,
  ProjectGraphEdgeRelation,
  ProjectGraphNodeType,
  ProjectGraphQueryOptions,
} from './project-graph.js';
import { loadProjectGraph, queryProjectGraph } from './project-graph.js';
import {
  saveProjectGraphQueryArtifact,
  type ProjectGraphQueryArtifactSummary,
} from './project-graph-query-store.js';

export type ProjectGraphContextIntent =
  | 'repo_review'
  | 'workflow'
  | 'question_answering';

export type ProjectGraphContextStatus = 'ready' | 'missing' | 'error';

export interface PreparedProjectGraphContextNode {
  id: string;
  type: ProjectGraphNodeType;
  label: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  score: number;
  reasons: string[];
  community?: string;
  communityLabel?: string;
}

export interface PreparedProjectGraphContextEdge {
  fromId: string;
  fromType: ProjectGraphNodeType;
  fromLabel: string;
  toId: string;
  toType: ProjectGraphNodeType;
  toLabel: string;
  relation: ProjectGraphEdgeRelation;
  confidence: ProjectGraphEdgeConfidence;
  symbol?: string;
}

export interface PreparedProjectGraphContext {
  status: ProjectGraphContextStatus;
  repositoryId: string;
  branch: string;
  intent: ProjectGraphContextIntent;
  question: string;
  focusPaths: string[];
  relationFilter: ProjectGraphEdgeRelation[];
  communities: string[];
  nodeCount: number;
  edgeCount: number;
  tokenBudget: number;
  startNodes: PreparedProjectGraphContextNode[];
  topFiles: PreparedProjectGraphContextNode[];
  topFunctions: PreparedProjectGraphContextNode[];
  topChunks: PreparedProjectGraphContextNode[];
  edges: PreparedProjectGraphContextEdge[];
  planner: {
    strategy: string;
    forcedSeedCount: number;
    communityHintCount: number;
  };
  confidence: {
    seedScore: number;
    graphScore: number;
    contextScore: number;
    overall: number;
  };
  contextFilterStats: {
    candidateNodeCount: number;
    selectedNodeCount: number;
    droppedNodeCount: number;
    selectedEdgeCount: number;
    estimatedTokens: number;
  };
  contextText: string;
  message?: string;
  artifact?: ProjectGraphQueryArtifactSummary;
}

export interface PrepareProjectGraphContextInput {
  repositoryId: string;
  branch: string;
  intent: ProjectGraphContextIntent;
  question: string;
  focusPaths?: string[];
  queryOptions?: ProjectGraphQueryOptions;
  persist?: {
    enabled?: boolean;
    source?: string;
    kind?: string;
    metadata?: Record<string, unknown>;
  };
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeFocusPaths(paths: string[] | undefined): string[] {
  return uniqueStrings(
    Array.isArray(paths)
      ? paths.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
  );
}

function toPreparedNode(
  node: {
    id: string;
    type: ProjectGraphNodeType;
    label: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    score: number;
    reasons: string[];
    community?: string;
  } | null | undefined,
  communityLabelsById?: ReadonlyMap<string, string>,
): PreparedProjectGraphContextNode | null {
  if (!node) return null;
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    score: node.score,
    reasons: [...node.reasons],
    community: node.community,
    communityLabel: node.community
      ? communityLabelsById?.get(node.community) || node.community
      : undefined,
  };
}

function buildNodeLine(node: PreparedProjectGraphContextNode): string {
  const location =
    node.filePath && node.startLine
      ? `${node.filePath}:${node.startLine}${node.endLine ? `-${node.endLine}` : ''}`
      : node.filePath || '';
  const communityText = node.communityLabel
    ? ` | community=${node.communityLabel}`
    : '';
  return `- ${node.type} ${node.label}${location ? ` [${location}]` : ''}${communityText} | score=${node.score.toFixed(2)} | reasons=${node.reasons.join(', ') || '-'}`;
}

function renderPreparedNodeSection(
  lines: string[],
  title: string,
  nodes: PreparedProjectGraphContextNode[],
): void {
  lines.push('', title);
  if (nodes.length === 0) {
    lines.push('- (none)');
    return;
  }
  for (const node of nodes) {
    lines.push(buildNodeLine(node));
  }
}

export function renderPreparedProjectGraphContext(
  context: PreparedProjectGraphContext,
): string {
  const lines = [
    'Project Graph Retrieval:',
    `status: ${context.status}`,
    `intent: ${context.intent}`,
    `question: ${context.question || '(none)'}`,
    `branch: ${context.branch}`,
  ];
  if (context.message) {
    lines.push(`message: ${context.message}`);
  }
  if (context.status !== 'ready') {
    return lines.join('\n');
  }
  lines.push(
    `graph_selection: nodes=${context.nodeCount} edges=${context.edgeCount} communities=${context.communities.length}`,
  );
  lines.push(
    `relation_filter: ${context.relationFilter.join(', ') || '(all)'}`,
  );
  if (context.focusPaths.length > 0) {
    lines.push(`focus_paths: ${context.focusPaths.join(', ')}`);
  }
  if (context.communities.length > 0) {
    lines.push(`communities: ${context.communities.join(', ')}`);
  }
  renderPreparedNodeSection(lines, 'Seed nodes:', context.startNodes);
  renderPreparedNodeSection(lines, 'Top file matches:', context.topFiles);
  renderPreparedNodeSection(lines, 'Top function matches:', context.topFunctions);
  renderPreparedNodeSection(lines, 'Top chunk evidence:', context.topChunks);
  lines.push('', 'Relevant edges:');
  if (context.edges.length === 0) {
    lines.push('- (none)');
  } else {
    for (const edge of context.edges) {
      lines.push(
        `- ${edge.fromType}:${edge.fromLabel} -> ${edge.toType}:${edge.toLabel} | relation=${edge.relation} | confidence=${edge.confidence}${edge.symbol ? ` | symbol=${edge.symbol}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function filterPreparedNodesForFiles(
  nodes: PreparedProjectGraphContextNode[],
  fileSet: Set<string>,
): PreparedProjectGraphContextNode[] {
  return nodes.filter((node) => {
    if (!node.filePath) return false;
    return fileSet.has(node.filePath);
  });
}

export function filterPreparedProjectGraphContextForFiles(input: {
  context: PreparedProjectGraphContext;
  files: string[];
}): PreparedProjectGraphContext {
  if (input.context.status !== 'ready') return input.context;
  const fileSet = new Set(
    input.files
      .map((entry) => String(entry || '').trim())
      .filter(Boolean),
  );
  if (fileSet.size === 0) return input.context;
  const allNodes = [
    ...input.context.startNodes,
    ...input.context.topFiles,
    ...input.context.topFunctions,
    ...input.context.topChunks,
  ];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const filtered: PreparedProjectGraphContext = {
    ...input.context,
    focusPaths: input.context.focusPaths.filter((path) => fileSet.has(path)),
    startNodes: filterPreparedNodesForFiles(input.context.startNodes, fileSet),
    topFiles: filterPreparedNodesForFiles(input.context.topFiles, fileSet),
    topFunctions: filterPreparedNodesForFiles(
      input.context.topFunctions,
      fileSet,
    ),
    topChunks: filterPreparedNodesForFiles(input.context.topChunks, fileSet),
    edges: input.context.edges.filter((edge) => {
      const fromFile = nodeById.get(edge.fromId)?.filePath;
      const toFile = nodeById.get(edge.toId)?.filePath;
      return (
        (fromFile && fileSet.has(fromFile)) || (toFile && fileSet.has(toFile))
      );
    }),
  };
  filtered.nodeCount =
    filtered.startNodes.length +
    filtered.topFiles.length +
    filtered.topFunctions.length +
    filtered.topChunks.length;
  filtered.edgeCount = filtered.edges.length;
  filtered.communities = uniqueStrings(
    [
      ...filtered.startNodes.map(
        (node) => node.communityLabel || node.community,
      ),
      ...filtered.topFiles.map((node) => node.communityLabel || node.community),
      ...filtered.topFunctions.map(
        (node) => node.communityLabel || node.community,
      ),
      ...filtered.topChunks.map((node) => node.communityLabel || node.community),
    ].filter(Boolean),
  );
  filtered.contextFilterStats = {
    ...filtered.contextFilterStats,
    selectedNodeCount: filtered.nodeCount,
    selectedEdgeCount: filtered.edgeCount,
    droppedNodeCount: Math.max(
      0,
      filtered.contextFilterStats.candidateNodeCount - filtered.nodeCount,
    ),
  };
  filtered.contextText = renderPreparedProjectGraphContext(filtered);
  return filtered;
}

function defaultQueryOptions(
  intent: ProjectGraphContextIntent,
): ProjectGraphQueryOptions {
  if (intent === 'repo_review') {
    return {
      mode: 'bfs',
      depth: 2,
      maxSeeds: 8,
      maxNodes: 42,
      tokenBudget: 2200,
      relationFilter: ['calls', 'imports', 'references', 'contains'],
    };
  }
  if (intent === 'workflow') {
    return {
      mode: 'bfs',
      depth: 2,
      maxSeeds: 6,
      maxNodes: 32,
      tokenBudget: 1800,
    };
  }
  return {
    mode: 'bfs',
    depth: 2,
    maxSeeds: 5,
    maxNodes: 36,
    tokenBudget: 2200,
  };
}

export function buildRepoReviewProjectGraphQuestion(input: {
  repositoryName?: string;
  branch: string;
  changedFiles: string[];
  commitSummaryLines: string[];
  actor?: string;
}): string {
  const changedFiles = normalizeFocusPaths(input.changedFiles);
  const summary = input.commitSummaryLines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' | ');
  return [
    `Review the implementation impact of this ${input.repositoryName || 'repository'} change on branch ${input.branch}.`,
    input.actor ? `Actor: ${input.actor}.` : '',
    changedFiles.length > 0
      ? `Changed files: ${changedFiles.join(', ')}.`
      : '',
    summary ? `Commit summary: ${summary}.` : '',
    'Focus on affected implementations, callers, imports, references, adjacent tests, configuration, and persistence or workflow entrypoints touched by these files.',
  ]
    .filter(Boolean)
    .join(' ');
}

export function buildWorkflowProjectGraphQuestion(input: {
  workflowName?: string;
  roleName?: string;
  taskName: string;
  taskDescription?: string;
  taskPrompt?: string;
  runInput?: string;
  upstreamMessages: Array<{
    from: string;
    to: string;
    direction: string;
    content: string;
  }>;
}): string {
  const upstream = input.upstreamMessages
    .slice(-3)
    .map((message) => {
      const content = String(message.content || '')
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      return `${message.from}->${message.to} ${content}`;
    })
    .join(' | ');
  return [
    input.workflowName
      ? `Workflow ${input.workflowName} is executing a repository task.`
      : 'A repository-bound workflow task is executing.',
    input.roleName ? `Role: ${input.roleName}.` : '',
    `Task: ${input.taskName}.`,
    input.taskDescription ? `Task description: ${input.taskDescription}.` : '',
    input.taskPrompt ? `Task prompt: ${input.taskPrompt}.` : '',
    input.runInput
      ? `Run input: ${String(input.runInput).replace(/\s+/g, ' ').slice(0, 260)}.`
      : '',
    upstream ? `Recent upstream context: ${upstream}.` : '',
    'Find the most relevant implementation files, functions, supporting tests, configs, and surrounding call paths needed to execute this task with minimal repository exploration.',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function prepareProjectGraphContext(
  input: PrepareProjectGraphContextInput,
): Promise<PreparedProjectGraphContext> {
  const question = String(input.question || '').trim();
  if (!question) {
    const missing: PreparedProjectGraphContext = {
      status: 'missing',
      repositoryId: input.repositoryId,
      branch: input.branch,
      intent: input.intent,
      question,
      focusPaths: normalizeFocusPaths(input.focusPaths),
      relationFilter: [],
      communities: [],
      nodeCount: 0,
      edgeCount: 0,
      tokenBudget: 0,
      startNodes: [],
      topFiles: [],
      topFunctions: [],
      topChunks: [],
      edges: [],
      planner: {
        strategy: 'unavailable',
        forcedSeedCount: 0,
        communityHintCount: 0,
      },
      confidence: {
        seedScore: 0,
        graphScore: 0,
        contextScore: 0,
        overall: 0,
      },
      contextFilterStats: {
        candidateNodeCount: 0,
        selectedNodeCount: 0,
        droppedNodeCount: 0,
        selectedEdgeCount: 0,
        estimatedTokens: 0,
      },
      contextText: '',
      message: 'empty_question',
      artifact: undefined,
    };
    missing.contextText = renderPreparedProjectGraphContext(missing);
    return missing;
  }

  try {
    const graph = await loadProjectGraph(input.repositoryId, input.branch);
    if (!graph) {
      const missing: PreparedProjectGraphContext = {
        status: 'missing',
        repositoryId: input.repositoryId,
        branch: input.branch,
        intent: input.intent,
        question,
        focusPaths: normalizeFocusPaths(input.focusPaths),
        relationFilter: [],
        communities: [],
        nodeCount: 0,
        edgeCount: 0,
        tokenBudget: 0,
        startNodes: [],
        topFiles: [],
        topFunctions: [],
        topChunks: [],
        edges: [],
        planner: {
          strategy: 'unavailable',
          forcedSeedCount: 0,
          communityHintCount: 0,
        },
        confidence: {
          seedScore: 0,
          graphScore: 0,
          contextScore: 0,
          overall: 0,
        },
        contextFilterStats: {
          candidateNodeCount: 0,
          selectedNodeCount: 0,
          droppedNodeCount: 0,
          selectedEdgeCount: 0,
          estimatedTokens: 0,
        },
        contextText: '',
        message: 'graph_unavailable',
        artifact: undefined,
      };
      missing.contextText = renderPreparedProjectGraphContext(missing);
      return missing;
    }

    const focusPaths = normalizeFocusPaths(input.focusPaths);
    const seedNodeIds = graph.nodes
      .filter(
        (node) =>
          node.type === 'file' &&
          node.filePath &&
          focusPaths.includes(node.filePath),
      )
      .map((node) => node.id);
    const options = {
      ...defaultQueryOptions(input.intent),
      ...(input.queryOptions || {}),
      seedNodeIds,
    } satisfies ProjectGraphQueryOptions;
    const result = queryProjectGraph(graph, question, options);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const communityLabelsById = new Map(
      result.communities.map((community) => [community.id, community.label]),
    );
    const prepared: PreparedProjectGraphContext = {
      status: 'ready',
      repositoryId: input.repositoryId,
      branch: input.branch,
      intent: input.intent,
      question,
      focusPaths,
      relationFilter: [...result.relationFilter],
      communities: result.communities.map((community) => community.label).slice(0, 8),
      nodeCount: result.nodes.length,
      edgeCount: result.edges.length,
      tokenBudget: result.tokenBudget,
      startNodes: result.startNodes
        .map((node) => toPreparedNode(node, communityLabelsById))
        .filter((node): node is PreparedProjectGraphContextNode => Boolean(node))
        .slice(0, 8),
      topFiles: result.matches.files
        .map((node) => toPreparedNode(node, communityLabelsById))
        .filter((node): node is PreparedProjectGraphContextNode => Boolean(node))
        .slice(0, 8),
      topFunctions: result.matches.functions
        .map((node) => toPreparedNode(node, communityLabelsById))
        .filter((node): node is PreparedProjectGraphContextNode => Boolean(node))
        .slice(0, 10),
      topChunks: result.matches.chunks
        .map((node) => toPreparedNode(node, communityLabelsById))
        .filter((node): node is PreparedProjectGraphContextNode => Boolean(node))
        .slice(0, 8),
      edges: result.edges.slice(0, 32).map((edge) => ({
        fromId: edge.fromId,
        fromType: nodeById.get(edge.fromId)?.type || 'file',
        fromLabel: nodeById.get(edge.fromId)?.label || edge.fromId,
        toId: edge.toId,
        toType: nodeById.get(edge.toId)?.type || 'file',
        toLabel: nodeById.get(edge.toId)?.label || edge.toId,
        relation: edge.relation,
        confidence: edge.confidence,
          symbol: edge.symbol,
        })),
      planner: result.planner,
      confidence: result.confidence,
      contextFilterStats: result.contextFilterStats,
      contextText: '',
      artifact: undefined,
    };
    prepared.contextText = renderPreparedProjectGraphContext(prepared);
    if (input.persist?.enabled !== false) {
      prepared.artifact = saveProjectGraphQueryArtifact({
        repositoryId: input.repositoryId,
        branch: input.branch,
        manifestHash: graph.manifestHash,
        source: input.persist?.source || input.intent,
        kind: input.persist?.kind || 'prepared_context',
        status: prepared.status,
        question,
        focusPaths,
        metadata: {
          ...(input.persist?.metadata || {}),
          confidence: prepared.confidence,
          planner: prepared.planner,
          contextFilterStats: prepared.contextFilterStats,
          communities: prepared.communities,
        },
        payload: prepared,
      });
    }
    return prepared;
  } catch (error) {
    const failed: PreparedProjectGraphContext = {
      status: 'error',
      repositoryId: input.repositoryId,
      branch: input.branch,
      intent: input.intent,
      question,
      focusPaths: normalizeFocusPaths(input.focusPaths),
      relationFilter: [],
      communities: [],
      nodeCount: 0,
      edgeCount: 0,
      tokenBudget: 0,
      startNodes: [],
      topFiles: [],
      topFunctions: [],
      topChunks: [],
      edges: [],
      planner: {
        strategy: 'failed',
        forcedSeedCount: 0,
        communityHintCount: 0,
      },
      confidence: {
        seedScore: 0,
        graphScore: 0,
        contextScore: 0,
        overall: 0,
      },
      contextFilterStats: {
        candidateNodeCount: 0,
        selectedNodeCount: 0,
        droppedNodeCount: 0,
        selectedEdgeCount: 0,
        estimatedTokens: 0,
      },
      contextText: '',
      message: error instanceof Error ? error.message : 'graph_query_failed',
      artifact: undefined,
    };
    failed.contextText = renderPreparedProjectGraphContext(failed);
    return failed;
  }
}
