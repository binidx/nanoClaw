import path from 'node:path';

import { loadCodeIndexSnapshot } from '../db/code-index-db.js';
import { estimateTokens } from '../knowledge/chunker.js';
import { loadCodeMapFromDb } from './code-map-persist.js';
import { tokenize } from './code-search-index.js';
import type {
  CodeIndexChunkRecord,
  CodeIndexFileRecord,
  CodeIndexFunctionRecord,
  CodeIndexSnapshot,
} from './code-index-types.js';
import type { CodeMapSnapshot } from './code-map-types.js';

export type ProjectGraphEdgeConfidence =
  | 'EXTRACTED'
  | 'INFERRED'
  | 'AMBIGUOUS';

export type ProjectGraphNodeType = 'directory' | 'file' | 'chunk' | 'function';

export type ProjectGraphEdgeRelation =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'references';

export interface ProjectGraphNode {
  id: string;
  label: string;
  type: ProjectGraphNodeType;
  filePath?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  line?: number;
  rank: number;
  summary?: string;
  snippet?: string;
  signature?: string;
  community: string;
  degree: number;
  searchText: string;
}

export interface ProjectGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: ProjectGraphEdgeRelation;
  confidence: ProjectGraphEdgeConfidence;
  symbol?: string;
  line?: number;
}

export interface ProjectGraphCommunity {
  id: string;
  label: string;
  nodeIds: string[];
  topNodeIds: string[];
  bridgeNodeIds: string[];
  filePaths: string[];
  score: number;
}

export interface ProjectGraphStats {
  directoryCount: number;
  fileCount: number;
  chunkCount: number;
  functionCount: number;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  extractedEdgeCount: number;
  inferredEdgeCount: number;
  ambiguousEdgeCount: number;
}

export interface ProjectGraph {
  repositoryId: string;
  branch: string;
  manifestHash: string;
  generatedAt: string | null;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  communities: ProjectGraphCommunity[];
  stats: ProjectGraphStats;
}

export interface ProjectGraphMatch {
  nodeId: string;
  score: number;
  reasons: string[];
}

export interface ProjectGraphQueryOptions {
  mode?: 'bfs' | 'dfs';
  depth?: number;
  tokenBudget?: number;
  maxSeeds?: number;
  maxNodes?: number;
  relationFilter?: ProjectGraphEdgeRelation[];
  seedNodeIds?: string[];
}

export interface ProjectGraphQueryResult {
  question: string;
  mode: 'bfs' | 'dfs';
  depth: number;
  tokenBudget: number;
  relationFilter: ProjectGraphEdgeRelation[];
  startNodes: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  communities: ProjectGraphCommunity[];
  matches: {
    files: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
    functions: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
    chunks: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
    directories: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
  };
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
}

export interface ProjectGraphExplainResult {
  node: ProjectGraphNode;
  incoming: ProjectGraphEdge[];
  outgoing: ProjectGraphEdge[];
}

export interface ProjectGraphPathResult {
  source: ProjectGraphNode;
  target: ProjectGraphNode;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  hops: number;
  score: number;
  confidence: number;
  relationCounts: Partial<Record<ProjectGraphEdgeRelation, number>>;
}

const GRAPH_CACHE_LIMIT = 32;
const graphCache = new Map<string, ProjectGraph>();

function cacheGet<T>(cache: Map<string, T>, key: string): T | null {
  const value = cache.get(key) || null;
  if (!value) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.set(key, value);
  while (cache.size > limit) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function directoryId(relativeDir: string): string {
  return `dir:${relativeDir || '.'}`;
}

function fileId(relativePath: string): string {
  return `file:${relativePath}`;
}

function chunkId(chunk: CodeIndexChunkRecord): string {
  return `chunk:${chunk.id}`;
}

function functionId(fn: CodeIndexFunctionRecord): string {
  return `function:${fn.id}`;
}

function normalizeDirPath(filePath: string): string {
  const dir = path.posix.dirname(filePath || '.');
  return dir === '.' ? '.' : dir;
}

function communityForPath(filePath: string | undefined): string {
  const normalized = String(filePath || '.').trim();
  if (!normalized || normalized === '.') return 'root';
  const first = normalized.split('/')[0] || 'root';
  return first || 'root';
}

function edgeConfidenceScore(confidence: ProjectGraphEdgeConfidence): number {
  switch (confidence) {
    case 'EXTRACTED':
      return 1;
    case 'INFERRED':
      return 0.72;
    case 'AMBIGUOUS':
      return 0.45;
    default:
      return 0.5;
  }
}

function relationSignalWeight(relation: ProjectGraphEdgeRelation): number {
  switch (relation) {
    case 'calls':
      return 2.2;
    case 'imports':
      return 1.5;
    case 'references':
      return 1.3;
    case 'contains':
      return 0.55;
    default:
      return 1;
  }
}

function relationTraversalCost(relation: ProjectGraphEdgeRelation): number {
  switch (relation) {
    case 'calls':
      return 0.65;
    case 'imports':
      return 0.95;
    case 'references':
      return 1.15;
    case 'contains':
      return 1.6;
    default:
      return 1.2;
  }
}

function nodeConfidenceScore(node: ProjectGraphNode): number {
  let score = 0.42;
  if (node.type === 'function') score += 0.16;
  else if (node.type === 'chunk') score += 0.12;
  else if (node.type === 'file') score += 0.08;
  if (node.summary) score += 0.12;
  if (node.signature) score += 0.12;
  if (node.snippet) score += 0.1;
  if (node.filePath) score += 0.05;
  return Math.min(1, score);
}

function commonDirectoryLabel(filePaths: string[]): string {
  if (filePaths.length === 0) return 'misc';
  const segments = filePaths
    .map((filePath) => filePath.split('/').slice(0, -1).filter(Boolean));
  const shared: string[] = [];
  const minLength = Math.min(...segments.map((entry) => entry.length));
  for (let index = 0; index < minLength; index += 1) {
    const value = segments[0]?.[index];
    if (!value) break;
    if (segments.every((entry) => entry[index] === value)) {
      shared.push(value);
      continue;
    }
    break;
  }
  if (shared.length > 0) return shared.join('/');
  return segments[0]?.[0] || path.posix.dirname(filePaths[0] || '.') || 'misc';
}

function detectProjectGraphCommunities(input: {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}): {
  nodeCommunityById: Map<string, string>;
  communities: ProjectGraphCommunity[];
} {
  const eligible = input.nodes.filter((node) => node.type !== 'directory');
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const adjacency = new Map<string, Array<{ nextId: string; weight: number }>>();
  for (const edge of input.edges) {
    if (!eligibleIds.has(edge.fromId) || !eligibleIds.has(edge.toId)) continue;
    const weight =
      relationSignalWeight(edge.relation) * edgeConfidenceScore(edge.confidence);
    const forward = adjacency.get(edge.fromId) || [];
    forward.push({ nextId: edge.toId, weight });
    adjacency.set(edge.fromId, forward);
    const backward = adjacency.get(edge.toId) || [];
    backward.push({ nextId: edge.fromId, weight });
    adjacency.set(edge.toId, backward);
  }

  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const labels = new Map<string, string>();
  for (const node of eligible) {
    labels.set(node.id, node.id);
  }
  const ordered = [...eligible].sort((left, right) => {
    if (right.degree !== left.degree) return right.degree - left.degree;
    if (right.rank !== left.rank) return right.rank - left.rank;
    return left.id.localeCompare(right.id, 'en');
  });
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false;
    for (const node of ordered) {
      const weightByLabel = new Map<string, number>();
      const selfLabel = labels.get(node.id) || node.id;
      weightByLabel.set(selfLabel, 0.2 + node.rank * 0.02);
      for (const neighbor of adjacency.get(node.id) || []) {
        const label = labels.get(neighbor.nextId) || neighbor.nextId;
        weightByLabel.set(
          label,
          (weightByLabel.get(label) || 0) + neighbor.weight,
        );
      }
      const best = [...weightByLabel.entries()].sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        return left[0].localeCompare(right[0], 'en');
      })[0];
      if (best && best[0] !== selfLabel) {
        labels.set(node.id, best[0]);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const grouped = new Map<string, string[]>();
  for (const node of eligible) {
    const label = labels.get(node.id) || node.id;
    const entries = grouped.get(label) || [];
    entries.push(node.id);
    grouped.set(label, entries);
  }
  const eligibleCommunityById = new Map<string, string>();
  const communityEntries = [...grouped.values()].map((nodeIds, index) => {
    const communityId = `community:${String(index + 1).padStart(3, '0')}`;
    for (const nodeId of nodeIds) eligibleCommunityById.set(nodeId, communityId);
    return { communityId, nodeIds };
  });

  const fileNodes = eligible.filter((node) => node.type === 'file');
  const communityByDirectory = new Map<string, string>();
  for (const node of input.nodes.filter((entry) => entry.type === 'directory')) {
    const prefix = node.filePath && node.filePath !== '.'
      ? `${node.filePath}/`
      : '';
    const tally = new Map<string, number>();
    for (const fileNode of fileNodes) {
      if (!fileNode.filePath) continue;
      if (
        node.filePath === undefined ||
        node.filePath === '.' ||
        fileNode.filePath.startsWith(prefix)
      ) {
        const communityId = eligibleCommunityById.get(fileNode.id);
        if (!communityId) continue;
        tally.set(communityId, (tally.get(communityId) || 0) + 1);
      }
    }
    const winner = [...tally.entries()].sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0], 'en');
    })[0]?.[0];
    communityByDirectory.set(node.id, winner || 'community:root');
  }

  const nodeCommunityById = new Map<string, string>();
  for (const node of input.nodes) {
    if (node.type === 'directory') {
      nodeCommunityById.set(
        node.id,
        communityByDirectory.get(node.id) || 'community:root',
      );
    } else {
      nodeCommunityById.set(
        node.id,
        eligibleCommunityById.get(node.id) || 'community:root',
      );
    }
  }

  const communities = communityEntries
    .map(({ communityId, nodeIds }) => {
      const groupNodeIds = input.nodes
        .filter((node) => nodeCommunityById.get(node.id) === communityId)
        .map((node) => node.id);
      const groupNodes = groupNodeIds
        .map((id) => nodesById.get(id) || null)
        .filter((node): node is ProjectGraphNode => Boolean(node));
      const filePaths = groupNodes
        .filter((node) => node.type !== 'directory')
        .map((node) => node.filePath)
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.length > 0 && !entry.endsWith('/'),
        );
      const topNodeIds = [...groupNodes]
        .sort((left, right) => {
          const rightScore =
            right.degree * 1.6 + right.rank * 1.2 + nodeConfidenceScore(right);
          const leftScore =
            left.degree * 1.6 + left.rank * 1.2 + nodeConfidenceScore(left);
          if (rightScore !== leftScore) return rightScore - leftScore;
          return left.id.localeCompare(right.id, 'en');
        })
        .slice(0, 8)
        .map((node) => node.id);
      const bridgeNodeIds = groupNodes
        .filter((node) => {
          const neighborCommunities = new Set<string>();
          for (const edge of input.edges) {
            if (edge.fromId !== node.id && edge.toId !== node.id) continue;
            const nextId = edge.fromId === node.id ? edge.toId : edge.fromId;
            const nextCommunity = nodeCommunityById.get(nextId);
            if (nextCommunity && nextCommunity !== communityId) {
              neighborCommunities.add(nextCommunity);
            }
          }
          return neighborCommunities.size > 0;
        })
        .sort((left, right) => right.degree - left.degree)
        .slice(0, 6)
        .map((node) => node.id);
      const score = groupNodes.reduce(
        (total, node) => total + node.rank + node.degree * 0.4,
        0,
      );
      return {
        id: communityId,
        label: commonDirectoryLabel(filePaths),
        nodeIds: groupNodeIds,
        topNodeIds,
        bridgeNodeIds,
        filePaths: Array.from(new Set(filePaths)).slice(0, 16),
        score,
      };
    })
    .sort((left, right) => {
      const leftRootPenalty = left.label === '.' || left.label === 'root' ? 1 : 0;
      const rightRootPenalty = right.label === '.' || right.label === 'root' ? 1 : 0;
      if (leftRootPenalty !== rightRootPenalty) {
        return leftRootPenalty - rightRootPenalty;
      }
      if (right.score !== left.score) return right.score - left.score;
      return right.nodeIds.length - left.nodeIds.length;
    });

  return {
    nodeCommunityById,
    communities,
  };
}

function buildDirectoryChain(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean);
  const result = ['.'];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const dir = parts.slice(0, index + 1).join('/');
    result.push(dir);
  }
  return result;
}

function buildNodeSearchText(input: {
  label: string;
  filePath?: string;
  summary?: string;
  snippet?: string;
  signature?: string;
}): string {
  return [
    input.label,
    input.filePath || '',
    input.summary || '',
    input.snippet || '',
    input.signature || '',
  ]
    .join('\n')
    .toLowerCase();
}

function ensureProjectGraphNode(
  nodeMap: Map<string, ProjectGraphNode>,
  node: ProjectGraphNode,
): void {
  const existing = nodeMap.get(node.id);
  if (!existing) {
    nodeMap.set(node.id, node);
    return;
  }
  nodeMap.set(node.id, {
    ...existing,
    ...node,
    rank: Math.max(existing.rank, node.rank),
    summary: existing.summary || node.summary,
    snippet: existing.snippet || node.snippet,
    signature: existing.signature || node.signature,
    searchText: buildNodeSearchText({
      label: existing.label || node.label,
      filePath: existing.filePath || node.filePath,
      summary: existing.summary || node.summary,
      snippet: existing.snippet || node.snippet,
      signature: existing.signature || node.signature,
    }),
  });
}

function ensureProjectGraphEdge(
  edgeMap: Map<string, ProjectGraphEdge>,
  edge: ProjectGraphEdge,
): void {
  const key = `${edge.fromId}\0${edge.toId}\0${edge.relation}\0${edge.symbol || ''}`;
  if (edgeMap.has(key)) return;
  edgeMap.set(key, edge);
}

function rankForChunk(chunk: CodeIndexChunkRecord, fileRank: number): number {
  return Math.max(0.01, fileRank * 0.7 - chunk.chunkIndex * 0.01);
}

function rankForFunction(fn: CodeIndexFunctionRecord, fileRank: number): number {
  return Math.max(0.01, fileRank * 0.9 - fn.startLine * 0.0001);
}

export function buildProjectGraph(input: {
  codeIndexSnapshot: CodeIndexSnapshot;
  codeMapSnapshot?: CodeMapSnapshot | null;
}): ProjectGraph {
  const snapshot = input.codeIndexSnapshot;
  const codeMapSnapshot = input.codeMapSnapshot || null;
  const nodeMap = new Map<string, ProjectGraphNode>();
  const edgeMap = new Map<string, ProjectGraphEdge>();
  const fileByPath = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const chunksByFile = new Map<string, CodeIndexChunkRecord[]>();
  const functionsByFile = new Map<string, CodeIndexFunctionRecord[]>();
  const functionById = new Map(snapshot.functions.map((fn) => [fn.id, fn]));

  for (const chunk of snapshot.chunks) {
    const entries = chunksByFile.get(chunk.filePath) || [];
    entries.push(chunk);
    chunksByFile.set(chunk.filePath, entries);
  }
  for (const fn of snapshot.functions) {
    const entries = functionsByFile.get(fn.filePath) || [];
    entries.push(fn);
    functionsByFile.set(fn.filePath, entries);
  }

  const allFilePaths = new Set<string>([
    ...snapshot.files.map((file) => file.relativePath),
    ...(codeMapSnapshot?.files || []).map((file) => file.relativePath),
  ]);

  for (const filePath of allFilePaths) {
    const file = fileByPath.get(filePath);
    const codeMapFile = codeMapSnapshot?.files.find(
      (entry) => entry.relativePath === filePath,
    );
    const directories = buildDirectoryChain(filePath);
    for (let index = 0; index < directories.length; index += 1) {
      const dir = directories[index]!;
      ensureProjectGraphNode(nodeMap, {
        id: directoryId(dir),
        label: dir,
        type: 'directory',
        filePath: dir === '.' ? undefined : dir,
        rank: 0.05,
        community: '',
        degree: 0,
        searchText: buildNodeSearchText({
          label: dir,
          filePath: dir === '.' ? undefined : dir,
        }),
      });
      if (index > 0) {
        const parentDir = directories[index - 1]!;
        ensureProjectGraphEdge(edgeMap, {
          id: `edge:${directoryId(parentDir)}:${directoryId(dir)}:contains`,
          fromId: directoryId(parentDir),
          toId: directoryId(dir),
          relation: 'contains',
          confidence: 'EXTRACTED',
        });
      }
    }

    const effectiveRank = file?.rank || codeMapFile?.rank || 0.1;
    ensureProjectGraphNode(nodeMap, {
      id: fileId(filePath),
      label: filePath,
      type: 'file',
      filePath,
      language: file?.language || codeMapFile?.language || 'text',
      rank: effectiveRank,
      summary: file?.summary || undefined,
      community: '',
      degree: 0,
      searchText: buildNodeSearchText({
        label: filePath,
        filePath,
        summary: file?.summary || undefined,
      }),
    });
    ensureProjectGraphEdge(edgeMap, {
      id: `edge:${directoryId(normalizeDirPath(filePath))}:${fileId(filePath)}:contains`,
      fromId: directoryId(normalizeDirPath(filePath)),
      toId: fileId(filePath),
      relation: 'contains',
      confidence: 'EXTRACTED',
    });

    for (const chunk of chunksByFile.get(filePath) || []) {
      ensureProjectGraphNode(nodeMap, {
        id: chunkId(chunk),
        label: `${filePath}:${chunk.startLine}-${chunk.endLine}`,
        type: 'chunk',
        filePath,
        language: file?.language || 'text',
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        rank: rankForChunk(chunk, effectiveRank),
        summary: chunk.summary || undefined,
        snippet: chunk.content,
        community: '',
        degree: 0,
        searchText: buildNodeSearchText({
          label: `${filePath}:${chunk.startLine}-${chunk.endLine}`,
          filePath,
          summary: chunk.summary || undefined,
          snippet: chunk.content,
        }),
      });
      ensureProjectGraphEdge(edgeMap, {
        id: `edge:${fileId(filePath)}:${chunkId(chunk)}:contains`,
        fromId: fileId(filePath),
        toId: chunkId(chunk),
        relation: 'contains',
        confidence: 'EXTRACTED',
      });
    }

    for (const fn of functionsByFile.get(filePath) || []) {
      ensureProjectGraphNode(nodeMap, {
        id: functionId(fn),
        label: fn.name,
        type: 'function',
        filePath,
        language: file?.language || 'text',
        startLine: fn.startLine,
        endLine: fn.endLine,
        line: fn.line,
        rank: rankForFunction(fn, effectiveRank),
        signature: fn.signature,
        community: '',
        degree: 0,
        searchText: buildNodeSearchText({
          label: fn.name,
          filePath,
          signature: fn.signature,
        }),
      });
      ensureProjectGraphEdge(edgeMap, {
        id: `edge:${fileId(filePath)}:${functionId(fn)}:contains`,
        fromId: fileId(filePath),
        toId: functionId(fn),
        relation: 'contains',
        confidence: 'EXTRACTED',
      });
    }
  }

  for (const edge of codeMapSnapshot?.edges || []) {
    ensureProjectGraphEdge(edgeMap, {
      id: `edge:${fileId(edge.fromFile)}:${fileId(edge.toFile)}:imports:${edge.symbols.join(',')}`,
      fromId: fileId(edge.fromFile),
      toId: fileId(edge.toFile),
      relation: 'imports',
      confidence: 'EXTRACTED',
      symbol: edge.symbols[0],
    });
  }

  for (const edge of snapshot.functionEdges) {
    const from = functionById.get(edge.fromFunctionId);
    const to = functionById.get(edge.toFunctionId);
    if (!from || !to) continue;
    ensureProjectGraphEdge(edgeMap, {
      id: `edge:${functionId(from)}:${functionId(to)}:calls:${edge.line}:${edge.symbol}`,
      fromId: functionId(from),
      toId: functionId(to),
      relation: 'calls',
      confidence: 'EXTRACTED',
      symbol: edge.symbol,
      line: edge.line,
    });
    if (from.filePath !== to.filePath) {
      ensureProjectGraphEdge(edgeMap, {
        id: `edge:${fileId(from.filePath)}:${fileId(to.filePath)}:references:${edge.symbol}`,
        fromId: fileId(from.filePath),
        toId: fileId(to.filePath),
        relation: 'references',
        confidence: 'INFERRED',
        symbol: edge.symbol,
        line: edge.line,
      });
    }
  }

  const degreeByNodeId = new Map<string, number>();
  for (const edge of edgeMap.values()) {
    degreeByNodeId.set(edge.fromId, (degreeByNodeId.get(edge.fromId) || 0) + 1);
    degreeByNodeId.set(edge.toId, (degreeByNodeId.get(edge.toId) || 0) + 1);
  }
  const initialNodes = Array.from(nodeMap.values())
    .map((node) => ({
      ...node,
      degree: degreeByNodeId.get(node.id) || 0,
    }));
  const detectedCommunities = detectProjectGraphCommunities({
    nodes: initialNodes,
    edges: Array.from(edgeMap.values()),
  });
  const nodes = initialNodes
    .map((node) => ({
      ...node,
      community:
        detectedCommunities.nodeCommunityById.get(node.id) ||
        communityForPath(node.filePath),
    }))
    .sort((left, right) => {
      if (right.rank !== left.rank) return right.rank - left.rank;
      return left.id.localeCompare(right.id, 'en');
    });
  const edges = Array.from(edgeMap.values()).sort((left, right) => {
    if (left.fromId !== right.fromId) {
      return left.fromId.localeCompare(right.fromId, 'en');
    }
    if (left.toId !== right.toId) {
      return left.toId.localeCompare(right.toId, 'en');
    }
    return left.relation.localeCompare(right.relation, 'en');
  });

  const communities = detectedCommunities.communities;

  const stats: ProjectGraphStats = {
    directoryCount: nodes.filter((node) => node.type === 'directory').length,
    fileCount: nodes.filter((node) => node.type === 'file').length,
    chunkCount: nodes.filter((node) => node.type === 'chunk').length,
    functionCount: nodes.filter((node) => node.type === 'function').length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    communityCount: communities.length,
    extractedEdgeCount: edges.filter((edge) => edge.confidence === 'EXTRACTED')
      .length,
    inferredEdgeCount: edges.filter((edge) => edge.confidence === 'INFERRED')
      .length,
    ambiguousEdgeCount: edges.filter((edge) => edge.confidence === 'AMBIGUOUS')
      .length,
  };

  return {
    repositoryId: snapshot.meta.repositoryId,
    branch: snapshot.meta.branch,
    manifestHash: snapshot.meta.manifestHash,
    generatedAt: snapshot.meta.generatedAt,
    nodes,
    edges,
    communities,
    stats,
  };
}

export async function loadProjectGraph(
  repositoryId: string,
  branch: string,
): Promise<ProjectGraph | null> {
  const [codeIndexSnapshot, codeMapSnapshot] = await Promise.all([
    loadCodeIndexSnapshot(repositoryId, branch),
    loadCodeMapFromDb(repositoryId, branch),
  ]);
  if (!codeIndexSnapshot) return null;
  const key = [
    repositoryId,
    branch,
    codeIndexSnapshot.meta.manifestHash,
    codeMapSnapshot?.manifestHash || '',
  ].join('\0');
  const cached = cacheGet(graphCache, key);
  if (cached) return cached;
  const graph = buildProjectGraph({
    codeIndexSnapshot,
    codeMapSnapshot,
  });
  cacheSet(graphCache, key, graph, GRAPH_CACHE_LIMIT);
  return graph;
}

function inferRelationFilter(question: string): ProjectGraphEdgeRelation[] {
  const normalized = question.toLowerCase();
  if (/(path|flow|调用|链路|how .*work|调用链)/i.test(normalized)) {
    return ['calls', 'imports', 'references', 'contains'];
  }
  if (/(where|implement|实现|入口|在哪|location)/i.test(normalized)) {
    return ['contains', 'imports', 'references', 'calls'];
  }
  if (/(impact|dependency|依赖|影响)/i.test(normalized)) {
    return ['imports', 'references', 'calls'];
  }
  return [];
}

function scoreProjectGraphNode(
  node: ProjectGraphNode,
  question: string,
): ProjectGraphMatch | null {
  const normalizedQuestion = question.trim().toLowerCase();
  const terms = tokenize(question).slice(0, 16);
  const reasons: string[] = [];
  let score = 0;

  if (
    normalizedQuestion &&
    node.filePath &&
    node.filePath.toLowerCase().includes(normalizedQuestion)
  ) {
    score += 18;
    reasons.push('full-query:file-path');
  }
  if (
    normalizedQuestion &&
    node.label &&
    node.label.toLowerCase().includes(normalizedQuestion)
  ) {
    score += 16;
    reasons.push('full-query:label');
  }

  for (const term of terms) {
    if (node.filePath?.toLowerCase().includes(term)) {
      score += node.type === 'file' ? 8 : 6;
      reasons.push(`term:file:${term}`);
    } else if (node.label.toLowerCase().includes(term)) {
      score += node.type === 'function' ? 7 : 5;
      reasons.push(`term:label:${term}`);
    } else if (node.summary?.toLowerCase().includes(term)) {
      score += 4;
      reasons.push(`term:summary:${term}`);
    } else if (node.signature?.toLowerCase().includes(term)) {
      score += 4;
      reasons.push(`term:signature:${term}`);
    } else if (node.snippet?.toLowerCase().includes(term)) {
      score += node.type === 'chunk' ? 3 : 1.5;
      reasons.push(`term:snippet:${term}`);
    }
  }

  if (score <= 0) return null;

  if (node.type === 'function') score += 1.6;
  else if (node.type === 'file') score += 1.2;
  else if (node.type === 'chunk') score += 1.4;
  score += Math.min(node.rank, 20) * 0.08;
  score += Math.min(node.degree, 20) * 0.05;

  return {
    nodeId: node.id,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 6),
  };
}

function enrichMatches(
  graph: ProjectGraph,
  matches: ProjectGraphMatch[],
): Array<ProjectGraphNode & { score: number; reasons: string[] }> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return matches
    .map((match) => {
      const node = nodeById.get(match.nodeId);
      return node
        ? {
            ...node,
            score: match.score,
            reasons: match.reasons,
          }
        : null;
    })
    .filter(
      (
        entry,
      ): entry is ProjectGraphNode & { score: number; reasons: string[] } =>
        Boolean(entry),
    )
    .sort((left, right) => right.score - left.score);
}

function pickSeedMatches(
  matches: Array<ProjectGraphNode & { score: number; reasons: string[] }>,
  maxSeeds: number,
  forcedSeeds: Array<ProjectGraphNode & { score: number; reasons: string[] }> = [],
): Array<ProjectGraphNode & { score: number; reasons: string[] }> {
  const selected: Array<ProjectGraphNode & { score: number; reasons: string[] }> =
    [];
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  for (const match of forcedSeeds) {
    if (seenIds.has(match.id)) continue;
    selected.push(match);
    seenIds.add(match.id);
    seenFiles.add(match.filePath || match.id);
    if (selected.length >= maxSeeds) return selected;
  }
  for (const match of matches) {
    if (seenIds.has(match.id)) continue;
    const fileKey = match.filePath || match.id;
    if (seenFiles.has(fileKey) && match.type !== 'function') continue;
    selected.push(match);
    seenIds.add(match.id);
    seenFiles.add(fileKey);
    if (selected.length >= maxSeeds) break;
  }
  return selected;
}

function buildAdjacency(
  graph: ProjectGraph,
  relationFilter: ProjectGraphEdgeRelation[],
): Map<string, ProjectGraphEdge[]> {
  const allowAll = relationFilter.length === 0;
  const adjacency = new Map<string, ProjectGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!allowAll && !relationFilter.includes(edge.relation)) continue;
    const forward = adjacency.get(edge.fromId) || [];
    forward.push(edge);
    adjacency.set(edge.fromId, forward);
    const backward = adjacency.get(edge.toId) || [];
    backward.push(edge);
    adjacency.set(edge.toId, backward);
  }
  return adjacency;
}

function collectSubgraph(
  graph: ProjectGraph,
  seedIds: string[],
  options: Required<Pick<ProjectGraphQueryOptions, 'mode' | 'depth' | 'maxNodes'>> & {
    relationFilter: ProjectGraphEdgeRelation[];
  },
): {
  nodeIds: string[];
  edges: ProjectGraphEdge[];
  depthByNodeId: Map<string, number>;
} {
  const adjacency = buildAdjacency(graph, options.relationFilter);
  const queue = seedIds.map((id) => ({ id, depth: 0 }));
  const seen = new Set(seedIds);
  const edgeIds = new Set<string>();
  const orderedNodeIds: string[] = [...seedIds];
  const depthByNodeId = new Map(seedIds.map((id) => [id, 0]));

  while (queue.length > 0 && orderedNodeIds.length < options.maxNodes) {
    const current =
      options.mode === 'dfs' ? queue.pop() || null : queue.shift() || null;
    if (!current) break;
    if (current.depth >= options.depth) continue;
    for (const edge of adjacency.get(current.id) || []) {
      edgeIds.add(edge.id);
      const nextId = edge.fromId === current.id ? edge.toId : edge.fromId;
      if (seen.has(nextId)) continue;
      seen.add(nextId);
      orderedNodeIds.push(nextId);
      depthByNodeId.set(nextId, current.depth + 1);
      queue.push({ id: nextId, depth: current.depth + 1 });
      if (orderedNodeIds.length >= options.maxNodes) break;
    }
  }

  const edges = graph.edges.filter((edge) => edgeIds.has(edge.id));
  return { nodeIds: orderedNodeIds, edges, depthByNodeId };
}

function estimateProjectGraphNodeTokens(node: ProjectGraphNode): number {
  return estimateTokens(
    [
      node.label,
      node.filePath || '',
      node.summary || '',
      node.signature || '',
      (node.snippet || '').slice(0, 320),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function contextualNodeScore(input: {
  node: ProjectGraphNode;
  depth: number;
  matchScore: number;
  seedCommunityIds: Set<string>;
}): number {
  const { node, depth, matchScore, seedCommunityIds } = input;
  let score = matchScore;
  score += Math.max(0, 9 - depth * 2.2);
  score += node.degree * 0.18;
  score += node.rank * 0.25;
  score += nodeConfidenceScore(node) * 8;
  if (seedCommunityIds.has(node.community)) score += 2.8;
  if (node.type === 'function') score += 2.1;
  else if (node.type === 'chunk') score += 1.6;
  else if (node.type === 'file') score += 1.2;
  return score;
}

function selectContextSubgraph(input: {
  graph: ProjectGraph;
  candidateNodes: ProjectGraphNode[];
  candidateEdges: ProjectGraphEdge[];
  seeds: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
  enrichedMatches: Array<ProjectGraphNode & { score: number; reasons: string[] }>;
  tokenBudget: number;
  maxNodes: number;
  depthByNodeId: Map<string, number>;
}): {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  communities: ProjectGraphCommunity[];
  confidence: ProjectGraphQueryResult['confidence'];
  stats: ProjectGraphQueryResult['contextFilterStats'];
} {
  const matchScoreById = new Map(
    input.enrichedMatches.map((node) => [node.id, node.score]),
  );
  const seedIds = new Set(input.seeds.map((node) => node.id));
  const seedCommunityIds = new Set(
    input.seeds.map((node) => node.community).filter(Boolean),
  );
  const ranked = [...input.candidateNodes].sort((left, right) => {
    const leftScore = contextualNodeScore({
      node: left,
      depth: input.depthByNodeId.get(left.id) ?? 99,
      matchScore: matchScoreById.get(left.id) || 0,
      seedCommunityIds,
    });
    const rightScore = contextualNodeScore({
      node: right,
      depth: input.depthByNodeId.get(right.id) ?? 99,
      matchScore: matchScoreById.get(right.id) || 0,
      seedCommunityIds,
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return left.id.localeCompare(right.id, 'en');
  });
  const selectedIds = new Set<string>();
  const selectedNodes: ProjectGraphNode[] = [];
  let usedTokens = 0;
  const typeCounts = new Map<ProjectGraphNodeType, number>();
  const typeQuota = new Map<ProjectGraphNodeType, number>([
    ['directory', Math.max(4, Math.floor(input.maxNodes * 0.12))],
    ['file', Math.max(8, Math.floor(input.maxNodes * 0.45))],
    ['chunk', Math.max(6, Math.floor(input.maxNodes * 0.35))],
    ['function', Math.max(8, Math.floor(input.maxNodes * 0.45))],
  ]);

  const trySelect = (node: ProjectGraphNode, force = false): void => {
    if (selectedIds.has(node.id)) return;
    const typeCount = typeCounts.get(node.type) || 0;
    const quota = typeQuota.get(node.type) || input.maxNodes;
    if (!force && typeCount >= quota) return;
    const tokenCost = Math.max(8, estimateProjectGraphNodeTokens(node));
    if (!force && usedTokens + tokenCost > input.tokenBudget) return;
    selectedIds.add(node.id);
    selectedNodes.push(node);
    typeCounts.set(node.type, typeCount + 1);
    usedTokens += tokenCost;
  };

  for (const seed of input.seeds) {
    const node = input.candidateNodes.find((entry) => entry.id === seed.id);
    if (node) trySelect(node, true);
  }
  for (const node of ranked) {
    if (selectedNodes.length >= input.maxNodes) break;
    trySelect(node);
  }

  const selectedEdges = input.candidateEdges
    .filter(
      (edge) => selectedIds.has(edge.fromId) && selectedIds.has(edge.toId),
    )
    .sort((left, right) => {
      const rightScore =
        relationSignalWeight(right.relation) * edgeConfidenceScore(right.confidence);
      const leftScore =
        relationSignalWeight(left.relation) * edgeConfidenceScore(left.confidence);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.id.localeCompare(right.id, 'en');
    })
    .slice(0, 48);

  const communityIds = new Set(selectedNodes.map((node) => node.community));
  const communities = input.graph.communities.filter((community) =>
    communityIds.has(community.id),
  );
  const averageSeedScore =
    input.seeds.length > 0
      ? input.seeds.reduce((total, node) => total + node.score, 0) /
        input.seeds.length
      : 0;
  const averageEdgeConfidence =
    selectedEdges.length > 0
      ? selectedEdges.reduce(
          (total, edge) => total + edgeConfidenceScore(edge.confidence),
          0,
        ) / selectedEdges.length
      : 0.45;
  const averageNodeConfidence =
    selectedNodes.length > 0
      ? selectedNodes.reduce(
          (total, node) => total + nodeConfidenceScore(node),
          0,
        ) / selectedNodes.length
      : 0.4;
  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    communities,
    confidence: {
      seedScore: Math.min(1, averageSeedScore / 28),
      graphScore: Math.min(1, averageEdgeConfidence),
      contextScore: Math.min(1, averageNodeConfidence),
      overall: Math.min(
        1,
        averageSeedScore / 40 + averageEdgeConfidence * 0.35 + averageNodeConfidence * 0.35,
      ),
    },
    stats: {
      candidateNodeCount: input.candidateNodes.length,
      selectedNodeCount: selectedNodes.length,
      droppedNodeCount: Math.max(0, input.candidateNodes.length - selectedNodes.length),
      selectedEdgeCount: selectedEdges.length,
      estimatedTokens: usedTokens,
    },
  };
}

export function renderProjectGraphContext(
  graph: ProjectGraph,
  result: ProjectGraphQueryResult,
): string {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const lines: string[] = [
    'Project Graph Retrieval:',
    `question: ${result.question}`,
    `mode: ${result.mode} depth=${result.depth}`,
    `graph_stats: nodes=${graph.stats.nodeCount}, edges=${graph.stats.edgeCount}, communities=${graph.stats.communityCount}`,
    `relation_filter: ${result.relationFilter.join(', ') || '(all)'}`,
    `planner: ${result.planner.strategy} | forced_seeds=${result.planner.forcedSeedCount} | community_hints=${result.planner.communityHintCount}`,
    `confidence: overall=${result.confidence.overall.toFixed(2)} | seed=${result.confidence.seedScore.toFixed(2)} | graph=${result.confidence.graphScore.toFixed(2)} | context=${result.confidence.contextScore.toFixed(2)}`,
    `context_filter: selected_nodes=${result.contextFilterStats.selectedNodeCount}/${result.contextFilterStats.candidateNodeCount} | selected_edges=${result.contextFilterStats.selectedEdgeCount} | estimated_tokens=${result.contextFilterStats.estimatedTokens}`,
    '',
    'Seed nodes:',
  ];
  for (const node of result.startNodes) {
    lines.push(
      `- ${node.type} ${node.label}${node.filePath ? ` [${node.filePath}]` : ''} | score=${node.score.toFixed(2)} | reasons=${node.reasons.join(', ') || '-'}`,
    );
  }
  if (result.startNodes.length === 0) lines.push('- (none)');

  lines.push('', 'Top file matches:');
  for (const node of result.matches.files.slice(0, 8)) {
    lines.push(
      `- ${node.filePath} | score=${node.score.toFixed(2)} | summary=${(node.summary || '').slice(0, 220)}`,
    );
  }
  if (result.matches.files.length === 0) lines.push('- (none)');

  lines.push('', 'Top function matches:');
  for (const node of result.matches.functions.slice(0, 10)) {
    lines.push(
      `- ${node.filePath}:${node.startLine}-${node.endLine} ${node.label} | score=${node.score.toFixed(2)} | signature=${(node.signature || '').slice(0, 220)}`,
    );
  }
  if (result.matches.functions.length === 0) lines.push('- (none)');

  lines.push('', 'Top chunk evidence:');
  for (const node of result.matches.chunks.slice(0, 8)) {
    lines.push(
      `- ${node.filePath}:${node.startLine}-${node.endLine} | score=${node.score.toFixed(2)} | summary=${(node.summary || '').slice(0, 180)}`,
    );
    if (node.snippet) {
      lines.push(`  snippet: ${node.snippet.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  if (result.matches.chunks.length === 0) lines.push('- (none)');

  lines.push('', 'Relevant communities:');
  for (const community of result.communities.slice(0, 6)) {
    lines.push(
      `- ${community.label} | nodes=${community.nodeIds.length} | bridges=${community.bridgeNodeIds.length} | top=${community.topNodeIds.slice(0, 3).join(', ') || '-'}`,
    );
  }
  if (result.communities.length === 0) lines.push('- (none)');

  lines.push('', 'Relevant edges:');
  for (const edge of result.edges.slice(0, 40)) {
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    lines.push(
      `- ${from?.type || '?'}:${from?.label || edge.fromId} -> ${to?.type || '?'}:${to?.label || edge.toId} | relation=${edge.relation} | confidence=${edge.confidence}${edge.symbol ? ` | symbol=${edge.symbol}` : ''}`,
    );
  }
  if (result.edges.length === 0) lines.push('- (none)');

  const limitedLines: string[] = [];
  for (const line of lines) {
    const next = [...limitedLines, line].join('\n');
    if (estimateTokens(next) > result.tokenBudget) break;
    limitedLines.push(line);
  }
  return limitedLines.join('\n');
}

export function queryProjectGraph(
  graph: ProjectGraph,
  question: string,
  options?: ProjectGraphQueryOptions,
): ProjectGraphQueryResult {
  const mode = options?.mode === 'dfs' ? 'dfs' : 'bfs';
  const depth = Math.min(Math.max(options?.depth || 2, 1), 5);
  const tokenBudget = Math.min(Math.max(options?.tokenBudget || 2200, 400), 8000);
  const maxSeeds = Math.min(Math.max(options?.maxSeeds || 5, 1), 12);
  const maxNodes = Math.min(Math.max(options?.maxNodes || 36, 8), 80);
  const relationFilter = options?.relationFilter?.length
    ? options.relationFilter
    : inferRelationFilter(question);
  const forcedSeedIds = Array.isArray(options?.seedNodeIds)
    ? Array.from(new Set(options?.seedNodeIds.filter(Boolean)))
    : [];

  const rawMatches = graph.nodes
    .map((node) => scoreProjectGraphNode(node, question))
    .filter((match): match is ProjectGraphMatch => Boolean(match));
  const enriched = enrichMatches(graph, rawMatches);
  const forcedSeeds = graph.nodes
    .filter((node) => forcedSeedIds.includes(node.id))
    .map((node) => {
      const matched = enriched.find((entry) => entry.id === node.id);
      return matched || {
        ...node,
        score: 99,
        reasons: ['forced-seed'],
      };
    });
  const seeds = pickSeedMatches(enriched, maxSeeds, forcedSeeds);
  const subgraph = collectSubgraph(
    graph,
    seeds.map((node) => node.id),
    {
      mode,
      depth,
      maxNodes,
      relationFilter,
    },
  );
  const nodeIdSet = new Set(subgraph.nodeIds);
  const candidateNodes = graph.nodes.filter((node) => nodeIdSet.has(node.id));
  const selected = selectContextSubgraph({
    graph,
    candidateNodes,
    candidateEdges: subgraph.edges,
    seeds,
    enrichedMatches: enriched,
    tokenBudget,
    maxNodes,
    depthByNodeId: subgraph.depthByNodeId,
  });
  const matches = {
    files: enriched.filter((node) => node.type === 'file'),
    functions: enriched.filter((node) => node.type === 'function'),
    chunks: enriched.filter((node) => node.type === 'chunk'),
    directories: enriched.filter((node) => node.type === 'directory'),
  };
  const result: ProjectGraphQueryResult = {
    question,
    mode,
    depth,
    tokenBudget,
    relationFilter,
    startNodes: seeds,
    nodes: selected.nodes,
    edges: selected.edges,
    communities: selected.communities,
    matches,
    planner: {
      strategy: `ranked_${mode}`,
      forcedSeedCount: forcedSeedIds.length,
      communityHintCount: selected.communities.length,
    },
    confidence: selected.confidence,
    contextFilterStats: selected.stats,
    contextText: '',
  };
  result.contextText = renderProjectGraphContext(graph, result);
  return result;
}

export function findProjectGraphNode(
  graph: ProjectGraph,
  labelOrId: string,
): ProjectGraphNode | null {
  const raw = String(labelOrId || '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  const exact = graph.nodes.find(
    (node) =>
      node.id.toLowerCase() === normalized ||
      node.label.toLowerCase() === normalized ||
      node.filePath?.toLowerCase() === normalized,
  );
  if (exact) return exact;
  const prefix = graph.nodes.find(
    (node) =>
      node.label.toLowerCase().startsWith(normalized) ||
      node.filePath?.toLowerCase().startsWith(normalized),
  );
  if (prefix) return prefix;
  return (
    graph.nodes.find(
      (node) =>
        node.label.toLowerCase().includes(normalized) ||
        node.filePath?.toLowerCase().includes(normalized),
    ) || null
  );
}

export function explainProjectGraphNode(
  graph: ProjectGraph,
  labelOrId: string,
): ProjectGraphExplainResult | null {
  const node = findProjectGraphNode(graph, labelOrId);
  if (!node) return null;
  return {
    node,
    incoming: graph.edges.filter((edge) => edge.toId === node.id),
    outgoing: graph.edges.filter((edge) => edge.fromId === node.id),
  };
}

export function shortestProjectGraphPath(
  graph: ProjectGraph,
  sourceLabelOrId: string,
  targetLabelOrId: string,
  maxHops = 8,
): ProjectGraphPathResult | null {
  const source = findProjectGraphNode(graph, sourceLabelOrId);
  const target = findProjectGraphNode(graph, targetLabelOrId);
  if (!source || !target) return null;
  if (source.id === target.id) {
    return {
      source,
      target,
      nodes: [source],
      edges: [],
      hops: 0,
      score: 1,
      confidence: 1,
      relationCounts: {},
    };
  }

  const adjacency = new Map<string, Array<{ edge: ProjectGraphEdge; nextId: string }>>();
  for (const edge of graph.edges) {
    const forward = adjacency.get(edge.fromId) || [];
    forward.push({ edge, nextId: edge.toId });
    adjacency.set(edge.fromId, forward);
    const backward = adjacency.get(edge.toId) || [];
    backward.push({ edge, nextId: edge.fromId });
    adjacency.set(edge.toId, backward);
  }

  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const distances = new Map<string, number>([[source.id, 0]]);
  const hopsByNodeId = new Map<string, number>([[source.id, 0]]);
  const previous = new Map<string, { fromId: string; edge: ProjectGraphEdge }>();
  const frontier: Array<{ nodeId: string; cost: number }> = [
    { nodeId: source.id, cost: 0 },
  ];
  while (frontier.length > 0) {
    frontier.sort((left, right) => left.cost - right.cost);
    const current = frontier.shift()!;
    if (current.nodeId === target.id) break;
    const currentCost = distances.get(current.nodeId) ?? Number.POSITIVE_INFINITY;
    if (current.cost > currentCost) continue;
    const currentHops = hopsByNodeId.get(current.nodeId) ?? 0;
    if (currentHops >= maxHops) continue;
    for (const next of adjacency.get(current.nodeId) || []) {
      const nextNode = nodeMap.get(next.nextId);
      if (!nextNode) continue;
      const traversalCost =
        relationTraversalCost(next.edge.relation) +
        (1 - edgeConfidenceScore(next.edge.confidence)) * 1.25 +
        (nextNode.type === 'directory' ? 0.45 : 0) -
        nodeConfidenceScore(nextNode) * 0.18;
      const nextCost = currentCost + Math.max(0.1, traversalCost);
      const recorded = distances.get(next.nextId) ?? Number.POSITIVE_INFINITY;
      if (nextCost >= recorded) continue;
      distances.set(next.nextId, nextCost);
      hopsByNodeId.set(next.nextId, currentHops + 1);
      previous.set(next.nextId, {
        fromId: current.nodeId,
        edge: next.edge,
      });
      frontier.push({ nodeId: next.nextId, cost: nextCost });
    }
  }

  if (!distances.has(target.id)) {
    return null;
  }

  const pathIds = [target.id];
  const pathEdges: ProjectGraphEdge[] = [];
  let cursor = target.id;
  while (cursor !== source.id) {
    const step = previous.get(cursor);
    if (!step) return null;
    pathIds.unshift(step.fromId);
    pathEdges.unshift(step.edge);
    cursor = step.fromId;
  }
  const confidence =
    pathEdges.length > 0
      ? pathEdges.reduce(
          (total, edge) => total + edgeConfidenceScore(edge.confidence),
          0,
        ) / pathEdges.length
      : 1;
  const relationCounts = pathEdges.reduce<Partial<Record<ProjectGraphEdgeRelation, number>>>(
    (acc, edge) => {
      acc[edge.relation] = (acc[edge.relation] || 0) + 1;
      return acc;
    },
    {},
  );
  return {
    source,
    target,
    nodes: pathIds
      .map((id) => nodeMap.get(id) || null)
      .filter((node): node is ProjectGraphNode => Boolean(node)),
    edges: pathEdges,
    hops: pathIds.length - 1,
    score: 1 / (1 + (distances.get(target.id) || 0)),
    confidence,
    relationCounts,
  };
}

export function buildProjectGraphFallbackAnswer(
  question: string,
  result: ProjectGraphQueryResult,
): string {
  const topFunctions = result.matches.functions.slice(0, 3);
  const topFiles = result.matches.files.slice(0, 4);
  const topChunks = result.matches.chunks.slice(0, 3);
  const relatedFiles = result.nodes
    .filter(
      (node) =>
        node.type === 'file' &&
        !topFiles.some((file) => file.id === node.id),
    )
    .slice(0, 3);
  const lines: string[] = [];
  if (topFunctions.length > 0) {
    lines.push('Most likely implementation points:');
    for (const fn of topFunctions) {
      lines.push(
        `- ${fn.filePath}:${fn.startLine}-${fn.endLine} ${fn.label}${fn.signature ? ` — ${fn.signature}` : ''}`,
      );
    }
  }
  if (topFiles.length > 0) {
    lines.push(
      lines.length > 0 ? '' : 'Most relevant files:',
    );
    for (const file of topFiles) {
      lines.push(
        `- ${file.filePath}${file.summary ? ` — ${file.summary}` : ''}`,
      );
    }
  }
  if (relatedFiles.length > 0) {
    lines.push('', 'Related files:');
    for (const file of relatedFiles) {
      lines.push(
        `- ${file.filePath}${file.summary ? ` — ${file.summary}` : ''}`,
      );
    }
  }
  if (topChunks.length > 0) {
    lines.push('', 'Evidence:');
    for (const chunk of topChunks) {
      lines.push(
        `- ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} — ${(chunk.summary || chunk.snippet || '').replace(/\s+/g, ' ').slice(0, 220)}`,
      );
    }
  }
  if (lines.length === 0) {
    return `No strong project-graph match was found for: ${question}`;
  }
  return lines.join('\n');
}
