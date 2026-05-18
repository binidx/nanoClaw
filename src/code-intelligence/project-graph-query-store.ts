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

function toSummary(
  artifact: ProjectGraphQueryArtifact,
): ProjectGraphQueryArtifactSummary {
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
    metadata: input.metadata,
    payload: input.payload,
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
    return JSON.parse(raw) as ProjectGraphQueryArtifact;
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
