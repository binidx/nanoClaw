import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';

export interface ProjectGraphQueryArtifact {
  id: string;
  repositoryId: string;
  branch: string;
  manifestHash: string;
  createdAt: string;
  source: string;
  kind: string;
  status: string;
  question: string;
  focusPaths?: string[];
  metadata?: Record<string, unknown>;
  observability?: ProjectGraphQueryObservabilitySummary;
  payload: unknown;
}

export interface ProjectGraphQueryArtifactSummary {
  id: string;
  repositoryId: string;
  branch: string;
  manifestHash: string;
  createdAt: string;
  source: string;
  kind: string;
  status: string;
  question: string;
  focusPaths: string[];
  metadata?: Record<string, unknown>;
  observability: ProjectGraphQueryObservabilitySummary;
}

export interface ProjectGraphQueryConfidenceSummary {
  overall: number;
  seedScore?: number;
  graphScore?: number;
  contextScore?: number;
}

export interface ProjectGraphQueryPlannerSummary {
  strategy: string;
  forcedSeedCount?: number;
  communityHintCount?: number;
}

export interface ProjectGraphQueryObservabilitySummary {
  source: string;
  kind: string;
  status: string;
  durationMs: number;
  nodeCount: number;
  edgeCount: number;
  selectedFileCount: number;
  selectedFiles: string[];
  confidence?: ProjectGraphQueryConfidenceSummary;
  planner?: ProjectGraphQueryPlannerSummary;
}

function safeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'default';
}

function artifactDirectory(repositoryId: string, branch: string): string {
  return path.join(
    DATA_DIR,
    'project-graph-queries',
    safeSegment(repositoryId),
    safeSegment(branch),
  );
}

function artifactPath(repositoryId: string, branch: string, id: string): string {
  return path.join(artifactDirectory(repositoryId, branch), `${safeSegment(id)}.json`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function collectFilePaths(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectFilePaths(entry));
  }
  const record = asRecord(value);
  if (String(record.type || '').trim() === 'directory') return [];
  const direct = String(record.filePath || record.relativePath || '').trim();
  return direct ? [direct] : [];
}

function normalizeConfidence(
  value: unknown,
): ProjectGraphQueryConfidenceSummary | undefined {
  const direct = numberValue(value);
  if (direct !== undefined) return { overall: direct };
  const record = asRecord(value);
  const overall = numberValue(record.overall);
  if (overall === undefined) return undefined;
  const seedScore = numberValue(record.seedScore);
  const graphScore = numberValue(record.graphScore);
  const contextScore = numberValue(record.contextScore);
  return {
    overall,
    ...(seedScore !== undefined ? { seedScore } : {}),
    ...(graphScore !== undefined ? { graphScore } : {}),
    ...(contextScore !== undefined ? { contextScore } : {}),
  };
}

function normalizePlanner(
  value: unknown,
): ProjectGraphQueryPlannerSummary | undefined {
  const record = asRecord(value);
  const strategy = String(record.strategy || '').trim();
  if (!strategy) return undefined;
  const forcedSeedCount = numberValue(record.forcedSeedCount);
  const communityHintCount = numberValue(record.communityHintCount);
  return {
    strategy,
    ...(forcedSeedCount !== undefined ? { forcedSeedCount } : {}),
    ...(communityHintCount !== undefined ? { communityHintCount } : {}),
  };
}

export function deriveProjectGraphQueryObservability(
  artifact: ProjectGraphQueryArtifact,
): ProjectGraphQueryObservabilitySummary {
  const metadata = asRecord(artifact.metadata);
  const existing = asRecord(artifact.observability || metadata.observability);
  const payload = asRecord(artifact.payload);
  const result = asRecord(payload.result || payload);
  const matches = asRecord(result.matches);
  const exploration = asRecord(
    asRecord(metadata.exploration).selectedFiles
      ? metadata.exploration
      : asRecord(asRecord(payload.qa).exploration),
  );
  const selectedFiles = uniqueStrings([
    ...stringArray(existing.selectedFiles),
    ...stringArray(metadata.selectedFiles),
    ...stringArray(exploration.selectedFiles),
    ...collectFilePaths(result.nodes),
    ...collectFilePaths(asRecord(matches).files),
    ...collectFilePaths(result.startNodes),
    ...stringArray(artifact.focusPaths),
  ]).slice(0, 50);
  const contextFilterStats = asRecord(metadata.contextFilterStats);
  const confidence = normalizeConfidence(
    existing.confidence || metadata.confidence || result.confidence,
  );
  const planner = normalizePlanner(
    existing.planner || metadata.planner || result.planner,
  );
  return {
    source: String(existing.source || artifact.source || '').trim(),
    kind: String(existing.kind || artifact.kind || '').trim(),
    status: String(existing.status || artifact.status || '').trim(),
    durationMs: Math.max(
      0,
      numberValue(existing.durationMs) ?? numberValue(metadata.durationMs) ?? 0,
    ),
    nodeCount: Math.max(
      0,
      numberValue(existing.nodeCount) ??
        numberValue(result.nodeCount) ??
        numberValue(contextFilterStats.selectedNodeCount) ??
        (Array.isArray(result.nodes) ? result.nodes.length : 0),
    ),
    edgeCount: Math.max(
      0,
      numberValue(existing.edgeCount) ??
        numberValue(result.edgeCount) ??
        numberValue(contextFilterStats.selectedEdgeCount) ??
        (Array.isArray(result.edges) ? result.edges.length : 0),
    ),
    selectedFileCount: selectedFiles.length,
    selectedFiles,
    ...(confidence ? { confidence } : {}),
    ...(planner ? { planner } : {}),
  };
}

function toSummary(
  artifact: ProjectGraphQueryArtifact,
): ProjectGraphQueryArtifactSummary {
  const observability = deriveProjectGraphQueryObservability(artifact);
  return {
    id: artifact.id,
    repositoryId: artifact.repositoryId,
    branch: artifact.branch,
    manifestHash: artifact.manifestHash,
    createdAt: artifact.createdAt,
    source: artifact.source,
    kind: artifact.kind,
    status: artifact.status,
    question: artifact.question,
    focusPaths: Array.isArray(artifact.focusPaths) ? artifact.focusPaths : [],
    metadata: artifact.metadata,
    observability,
  };
}

export function saveProjectGraphQueryArtifact(input: {
  repositoryId: string;
  branch: string;
  manifestHash: string;
  source: string;
  kind: string;
  status: string;
  question: string;
  focusPaths?: string[];
  metadata?: Record<string, unknown>;
  durationMs?: number;
  payload: unknown;
}): ProjectGraphQueryArtifactSummary {
  const createdAt = new Date().toISOString();
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const artifact: ProjectGraphQueryArtifact = {
    id,
    repositoryId: input.repositoryId,
    branch: input.branch,
    manifestHash: input.manifestHash,
    createdAt,
    source: input.source,
    kind: input.kind,
    status: input.status,
    question: input.question,
    focusPaths: input.focusPaths || [],
    metadata:
      input.durationMs !== undefined
        ? { ...(input.metadata || {}), durationMs: Math.max(0, input.durationMs) }
        : input.metadata,
    payload: input.payload,
  };
  artifact.observability = deriveProjectGraphQueryObservability(artifact);
  artifact.metadata = {
    ...(artifact.metadata || {}),
    observability: artifact.observability,
  };
  const directory = artifactDirectory(input.repositoryId, input.branch);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    artifactPath(input.repositoryId, input.branch, id),
    JSON.stringify(artifact, null, 2),
    'utf8',
  );
  return toSummary(artifact);
}

export function loadProjectGraphQueryArtifact(input: {
  repositoryId: string;
  branch: string;
  id: string;
}): ProjectGraphQueryArtifact | null {
  const filePath = artifactPath(input.repositoryId, input.branch, input.id);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const artifact = JSON.parse(raw) as ProjectGraphQueryArtifact;
    return {
      ...artifact,
      observability: deriveProjectGraphQueryObservability(artifact),
    };
  } catch {
    return null;
  }
}

export function listProjectGraphQueryArtifacts(input: {
  repositoryId: string;
  branch: string;
  limit?: number;
}): ProjectGraphQueryArtifactSummary[] {
  const directory = artifactDirectory(input.repositoryId, input.branch);
  if (!fs.existsSync(directory)) return [];
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const files = fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left, 'en'))
    .slice(0, limit);
  const results: ProjectGraphQueryArtifactSummary[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(directory, file), 'utf8');
      results.push(toSummary(JSON.parse(raw) as ProjectGraphQueryArtifact));
    } catch {
      // Ignore malformed artifacts and continue listing the rest.
    }
  }
  return results;
}
