import { dba } from './engine-access.js';

export interface CodeMapAiAnalysisRecord {
  id: string;
  repository_id: string;
  branch: string;
  target_path: string;
  target_type: string;
  manifest_hash: string;
  analysis_json: string;
  created_at: string;
}

export async function getCodeMapAiAnalysis(
  repositoryId: string,
  branch: string,
  targetPath: string,
  manifestHash: string,
): Promise<CodeMapAiAnalysisRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM code_map_ai_analyses
       WHERE repository_id = ? AND branch = ? AND target_path = ? AND manifest_hash = ?
       LIMIT 1`,
    )
    .get(repositoryId, branch, targetPath, manifestHash)) as
    | CodeMapAiAnalysisRecord
    | undefined;
}

export async function saveCodeMapAiAnalysis(
  record: CodeMapAiAnalysisRecord,
): Promise<void> {
  await dba
    .prepare(
      `INSERT OR IGNORE INTO code_map_ai_analyses
       (id, repository_id, branch, target_path, target_type, manifest_hash, analysis_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.repository_id,
      record.branch,
      record.target_path,
      record.target_type,
      record.manifest_hash,
      record.analysis_json,
      record.created_at,
    );
}

export async function upsertCodeMapAiAnalysis(
  record: CodeMapAiAnalysisRecord,
): Promise<void> {
  await dba
    .prepare(
      `DELETE FROM code_map_ai_analyses
       WHERE repository_id = ? AND branch = ? AND target_path = ? AND manifest_hash = ?`,
    )
    .run(record.repository_id, record.branch, record.target_path, record.manifest_hash);
  await saveCodeMapAiAnalysis(record);
}

export async function pruneCodeMapAiAnalyses(
  repositoryId: string,
  keepCount: number = 200,
): Promise<void> {
  const rows = (await dba
    .prepare(
      `SELECT id FROM code_map_ai_analyses
       WHERE repository_id = ? AND target_type != 'repo-description'
       ORDER BY created_at DESC`,
    )
    .all(repositoryId)) as Array<{ id: string }>;

  if (rows.length <= keepCount) return;

  const idsToDelete = rows.slice(keepCount).map((r) => r.id);
  const placeholders = idsToDelete.map(() => '?').join(',');
  await dba
    .prepare(`DELETE FROM code_map_ai_analyses WHERE id IN (${placeholders})`)
    .run(...idsToDelete);
}

export async function deleteCodeMapAiAnalysesByRepo(
  repositoryId: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM code_map_ai_analyses WHERE repository_id = ?`)
    .run(repositoryId);
}
