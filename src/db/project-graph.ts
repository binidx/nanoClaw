import { nanoid } from 'nanoid';

import { dba } from './engine-access.js';

export type ProjectGraphRunStatus = 'running' | 'completed' | 'failed';
export type ProjectGraphFactSource =
  | 'manual'
  | 'code_index'
  | 'skill_scan'
  | 'llm_inferred'
  | 'mcp_discovered';
export type ProjectGraphConfidence = 'high' | 'medium' | 'low';

export interface ProjectGraphRunRecord {
  id: string;
  repository_id: string;
  branch: string;
  status: ProjectGraphRunStatus;
  scanner_version: string;
  source_head_sha: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  error_message: string | null;
  created_by: string;
  created_at: string;
}

export interface ProjectGraphFactRecord {
  id: string;
  repository_id: string;
  run_id: string;
  kind: string;
  name: string;
  value_json: string;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
  locked: number;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectGraphEdgeRecord {
  id: string;
  repository_id: string;
  run_id: string;
  from_kind: string;
  from_name: string;
  relation: string;
  to_kind: string;
  to_name: string;
  confidence: ProjectGraphConfidence;
  evidence_json: string;
  created_at: string;
}

export interface ProjectGraphDocumentRecord {
  id: string;
  repository_id: string;
  run_id: string;
  doc_type: string;
  title: string;
  status: string;
  content: string;
  source: ProjectGraphFactSource;
  confidence: ProjectGraphConfidence;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export async function createProjectGraphRun(input: {
  repositoryId: string;
  branch: string;
  scannerVersion: string;
  sourceHeadSha?: string;
  createdBy: string;
}): Promise<ProjectGraphRunRecord> {
  const ts = now();
  const record: ProjectGraphRunRecord = {
    id: nanoid(),
    repository_id: input.repositoryId,
    branch: input.branch,
    status: 'running',
    scanner_version: input.scannerVersion,
    source_head_sha: input.sourceHeadSha || '',
    started_at: ts,
    completed_at: null,
    duration_ms: 0,
    error_message: null,
    created_by: input.createdBy,
    created_at: ts,
  };
  await dba
    .prepare(
      `INSERT INTO project_graph_runs (
        id, repository_id, branch, status, scanner_version, source_head_sha,
        started_at, completed_at, duration_ms, error_message, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.repository_id,
      record.branch,
      record.status,
      record.scanner_version,
      record.source_head_sha,
      record.started_at,
      record.completed_at,
      record.duration_ms,
      record.error_message,
      record.created_by,
      record.created_at,
    );
  return record;
}

export async function finishProjectGraphRun(
  runId: string,
  status: ProjectGraphRunStatus,
  startedAt: string,
  errorMessage: string | null = null,
): Promise<ProjectGraphRunRecord | undefined> {
  const completedAt = now();
  const durationMs = Math.max(
    0,
    Date.parse(completedAt) - Date.parse(startedAt),
  );
  await dba
    .prepare(
      `UPDATE project_graph_runs
       SET status = ?, completed_at = ?, duration_ms = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(status, completedAt, durationMs, errorMessage, runId);
  return getProjectGraphRun(runId);
}

export async function getProjectGraphRun(
  runId: string,
): Promise<ProjectGraphRunRecord | undefined> {
  return (await dba
    .prepare(`SELECT * FROM project_graph_runs WHERE id = ?`)
    .get(runId)) as ProjectGraphRunRecord | undefined;
}

export async function getLatestProjectGraphRun(
  repositoryId: string,
): Promise<ProjectGraphRunRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM project_graph_runs
       WHERE repository_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(repositoryId)) as ProjectGraphRunRecord | undefined;
}

export async function listProjectGraphRuns(
  repositoryId: string,
  limit = 20,
): Promise<ProjectGraphRunRecord[]> {
  return (await dba
    .prepare(
      `SELECT * FROM project_graph_runs
       WHERE repository_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(repositoryId, Math.max(1, Math.min(100, limit)))) as
    ProjectGraphRunRecord[];
}

export async function replaceProjectGraphRunArtifacts(input: {
  repositoryId: string;
  runId: string;
  facts: Array<
    Omit<
      ProjectGraphFactRecord,
      'id' | 'repository_id' | 'run_id' | 'created_at' | 'updated_at'
    >
  >;
  edges: Array<
    Omit<
      ProjectGraphEdgeRecord,
      'id' | 'repository_id' | 'run_id' | 'created_at'
    >
  >;
  documents: Array<
    Omit<
      ProjectGraphDocumentRecord,
      'id' | 'repository_id' | 'run_id' | 'created_at' | 'updated_at'
    >
  >;
}): Promise<void> {
  const ts = now();
  await dba
    .prepare(`DELETE FROM project_graph_facts WHERE run_id = ?`)
    .run(input.runId);
  await dba
    .prepare(`DELETE FROM project_graph_edges WHERE run_id = ?`)
    .run(input.runId);
  await dba
    .prepare(`DELETE FROM project_graph_documents WHERE run_id = ?`)
    .run(input.runId);

  const factStmt = dba.prepare(
    `INSERT INTO project_graph_facts (
      id, repository_id, run_id, kind, name, value_json, source, confidence,
      locked, evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const fact of input.facts) {
    await factStmt.run(
      nanoid(),
      input.repositoryId,
      input.runId,
      fact.kind,
      fact.name,
      fact.value_json,
      fact.source,
      fact.confidence,
      fact.locked,
      fact.evidence_json,
      ts,
      ts,
    );
  }

  const edgeStmt = dba.prepare(
    `INSERT INTO project_graph_edges (
      id, repository_id, run_id, from_kind, from_name, relation, to_kind,
      to_name, confidence, evidence_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const edge of input.edges) {
    await edgeStmt.run(
      nanoid(),
      input.repositoryId,
      input.runId,
      edge.from_kind,
      edge.from_name,
      edge.relation,
      edge.to_kind,
      edge.to_name,
      edge.confidence,
      edge.evidence_json,
      ts,
    );
  }

  const docStmt = dba.prepare(
    `INSERT INTO project_graph_documents (
      id, repository_id, run_id, doc_type, title, status, content, source,
      confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const document of input.documents) {
    await docStmt.run(
      nanoid(),
      input.repositoryId,
      input.runId,
      document.doc_type,
      document.title,
      document.status,
      document.content,
      document.source,
      document.confidence,
      ts,
      ts,
    );
  }
}

export async function listProjectGraphFacts(
  repositoryId: string,
  runId?: string,
): Promise<ProjectGraphFactRecord[]> {
  const whereRun = runId ? ' AND run_id = ?' : '';
  const params = runId ? [repositoryId, runId] : [repositoryId];
  return (await dba
    .prepare(
      `SELECT * FROM project_graph_facts
       WHERE repository_id = ?${whereRun}
       ORDER BY kind ASC, confidence ASC, name ASC`,
    )
    .all(...params)) as ProjectGraphFactRecord[];
}

export async function listProjectGraphEdges(
  repositoryId: string,
  runId?: string,
): Promise<ProjectGraphEdgeRecord[]> {
  const whereRun = runId ? ' AND run_id = ?' : '';
  const params = runId ? [repositoryId, runId] : [repositoryId];
  return (await dba
    .prepare(
      `SELECT * FROM project_graph_edges
       WHERE repository_id = ?${whereRun}
       ORDER BY relation ASC, from_name ASC, to_name ASC`,
    )
    .all(...params)) as ProjectGraphEdgeRecord[];
}

export async function listProjectGraphDocuments(
  repositoryId: string,
  runId?: string,
): Promise<ProjectGraphDocumentRecord[]> {
  const whereRun = runId ? ' AND run_id = ?' : '';
  const params = runId ? [repositoryId, runId] : [repositoryId];
  return (await dba
    .prepare(
      `SELECT * FROM project_graph_documents
       WHERE repository_id = ?${whereRun}
       ORDER BY updated_at DESC, title ASC`,
    )
    .all(...params)) as ProjectGraphDocumentRecord[];
}
