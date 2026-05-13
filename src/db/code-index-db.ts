import { dba, eng } from './engine-access.js';
import type {
  CodeIndexChunkRecord,
  CodeIndexFileRecord,
  CodeIndexFunctionEdgeRecord,
  CodeIndexFunctionRecord,
  CodeIndexProgress,
  CodeIndexSnapshot,
  CodeIndexSnapshotMeta,
} from '../code-intelligence/code-index-types.js';

interface CodeIndexSnapshotRow {
  snapshot_id: string;
  repository_id: string;
  branch: string;
  root_directory: string;
  source_kind: string;
  source_branch: string;
  source_head_sha: string;
  manifest_hash: string;
  status: string;
  stage: string;
  processed_files: number;
  total_files: number;
  message: string;
  error_message: string | null;
  generated_at: string | null;
  stats_json: string;
  capabilities_json: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

interface CodeIndexFileRow {
  snapshot_id: string;
  relative_path: string;
  language: string;
  byte_size: number;
  line_count: number;
  file_hash: string;
  rank: number;
  import_count: number;
  export_count: number;
  summary_text: string;
  summary_source: string;
}

interface CodeIndexChunkRow {
  id: string;
  snapshot_id: string;
  file_path: string;
  chunk_index: number;
  start_line: number;
  end_line: number;
  content: string;
  token_count: number;
  summary_text: string;
  content_hash: string;
  summary_source: string;
}

interface CodeIndexFunctionRow {
  id: string;
  snapshot_id: string;
  file_path: string;
  name: string;
  kind: string;
  signature: string;
  start_line: number;
  end_line: number;
  line: number;
  column_number: number;
  parent_function_id: string | null;
}

interface CodeIndexFunctionEdgeRow {
  id: string;
  snapshot_id: string;
  from_function_id: string;
  to_function_id: string;
  edge_type: string;
  symbol_name: string;
  line: number;
}

function codeIndexRankColumnSql(): string {
  return eng().dialect === 'mysql' ? '`rank`' : 'rank';
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMeta(row: CodeIndexSnapshotRow): CodeIndexSnapshotMeta {
  const stats = parseJson(row.stats_json, {
    fileCount: 0,
    chunkCount: 0,
    functionCount: 0,
    functionEdgeCount: 0,
    totalLines: 0,
    embeddedChunkCount: 0,
  });
  const capabilities = parseJson(row.capabilities_json, {
    chunkSearch: false,
    fileSummaries: false,
    functionGraph: false,
    embeddings: false,
  });
  return {
    repositoryId: row.repository_id,
    branch: row.branch,
    rootDirectory: row.root_directory,
    sourceKind: (row.source_kind ||
      'unknown') as CodeIndexSnapshotMeta['sourceKind'],
    sourceBranch: row.source_branch || row.branch,
    sourceHeadSha: row.source_head_sha || '',
    manifestHash: row.manifest_hash,
    status: row.status as CodeIndexSnapshotMeta['status'],
    stage: row.stage as CodeIndexSnapshotMeta['stage'],
    generatedAt: row.generated_at,
    stats,
    capabilities,
    progress: {
      status: row.status as CodeIndexSnapshotMeta['progress']['status'],
      stage: row.stage as CodeIndexSnapshotMeta['progress']['stage'],
      processedFiles: row.processed_files,
      totalFiles: row.total_files,
      message: row.message,
      error: row.error_message,
      startedAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function rowToFile(row: CodeIndexFileRow): CodeIndexFileRecord {
  return {
    relativePath: row.relative_path,
    language: row.language,
    byteSize: row.byte_size,
    lineCount: row.line_count,
    fileHash: row.file_hash,
    rank: Number(row.rank) || 0,
    importCount: row.import_count,
    exportCount: row.export_count,
    summary: row.summary_text,
    summarySource: row.summary_source as CodeIndexFileRecord['summarySource'],
  };
}

function rowToChunk(row: CodeIndexChunkRow): CodeIndexChunkRecord {
  return {
    id: row.id,
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    tokenCount: row.token_count,
    summary: row.summary_text,
    contentHash: row.content_hash,
    summarySource: row.summary_source as CodeIndexChunkRecord['summarySource'],
  };
}

function rowToFunction(row: CodeIndexFunctionRow): CodeIndexFunctionRecord {
  return {
    id: row.id,
    filePath: row.file_path,
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
    line: row.line,
    column: row.column_number,
    parentFunctionId: row.parent_function_id,
  };
}

function rowToFunctionEdge(
  row: CodeIndexFunctionEdgeRow,
): CodeIndexFunctionEdgeRecord {
  return {
    id: row.id,
    fromFunctionId: row.from_function_id,
    toFunctionId: row.to_function_id,
    edgeType: row.edge_type as CodeIndexFunctionEdgeRecord['edgeType'],
    symbol: row.symbol_name,
    line: row.line,
  };
}

export async function getCodeIndexSnapshotMeta(
  repositoryId: string,
  branch: string,
): Promise<CodeIndexSnapshotMeta | null> {
  const row = (await dba
    .prepare(
      `SELECT * FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(repositoryId, branch)) as CodeIndexSnapshotRow | undefined;
  return row ? rowToMeta(row) : null;
}

export async function listCodeIndexSnapshotMetasByStatus(input: {
  status: CodeIndexSnapshotMeta['status'];
  stages?: Array<CodeIndexSnapshotMeta['stage']>;
}): Promise<CodeIndexSnapshotMeta[]> {
  const stageList = (input.stages || []).filter(Boolean);
  const stageClause =
    stageList.length > 0
      ? ` AND stage IN (${stageList.map(() => '?').join(', ')})`
      : '';
  const rows = (await dba
    .prepare(
      `SELECT * FROM code_index_snapshots
       WHERE status = ?${stageClause}
       ORDER BY updated_at ASC`,
    )
    .all(input.status, ...stageList)) as CodeIndexSnapshotRow[];
  return rows.map(rowToMeta);
}

export async function loadCodeIndexSnapshot(
  repositoryId: string,
  branch: string,
): Promise<CodeIndexSnapshot | null> {
  const row = (await dba
    .prepare(
      `SELECT * FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(repositoryId, branch)) as CodeIndexSnapshotRow | undefined;
  if (!row) return null;

  const snapshotId = row.snapshot_id;
  const [files, chunks, functions, functionEdges] = await Promise.all([
    dba
      .prepare(
        `SELECT * FROM code_index_files
         WHERE snapshot_id = ?
         ORDER BY ${codeIndexRankColumnSql()} DESC, relative_path ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFileRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_chunks
         WHERE snapshot_id = ?
         ORDER BY file_path ASC, chunk_index ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexChunkRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_functions
         WHERE snapshot_id = ?
         ORDER BY file_path ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_function_edges
         WHERE snapshot_id = ?
         ORDER BY from_function_id ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionEdgeRow[]>,
  ]);

  return {
    meta: rowToMeta(row),
    files: files.map(rowToFile),
    chunks: chunks.map(rowToChunk),
    functions: functions.map(rowToFunction),
    functionEdges: functionEdges.map(rowToFunctionEdge),
  };
}

export async function loadCodeIndexReviewContextData(
  repositoryId: string,
  branch: string,
): Promise<Pick<
  CodeIndexSnapshot,
  'meta' | 'files' | 'functions' | 'functionEdges'
> | null> {
  const row = await getCodeIndexSnapshotRow(repositoryId, branch);
  if (!row) return null;
  const snapshotId = row.snapshot_id;
  const [files, functions, functionEdges] = await Promise.all([
    dba
      .prepare(
        `SELECT * FROM code_index_files
         WHERE snapshot_id = ?
         ORDER BY ${codeIndexRankColumnSql()} DESC, relative_path ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFileRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_functions
         WHERE snapshot_id = ?
         ORDER BY file_path ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_function_edges
         WHERE snapshot_id = ?
         ORDER BY from_function_id ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionEdgeRow[]>,
  ]);
  return {
    meta: rowToMeta(row),
    files: files.map(rowToFile),
    functions: functions.map(rowToFunction),
    functionEdges: functionEdges.map(rowToFunctionEdge),
  };
}

async function getCodeIndexSnapshotRow(
  repositoryId: string,
  branch: string,
): Promise<CodeIndexSnapshotRow | undefined> {
  return (await dba
    .prepare(
      `SELECT * FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(repositoryId, branch)) as CodeIndexSnapshotRow | undefined;
}

export async function loadCodeIndexSearchData(
  repositoryId: string,
  branch: string,
): Promise<Pick<CodeIndexSnapshot, 'meta' | 'files' | 'chunks'> | null> {
  const row = await getCodeIndexSnapshotRow(repositoryId, branch);
  if (!row) return null;
  const snapshotId = row.snapshot_id;
  const [files, chunks] = await Promise.all([
    dba
      .prepare(
        `SELECT * FROM code_index_files
         WHERE snapshot_id = ?
         ORDER BY ${codeIndexRankColumnSql()} DESC, relative_path ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFileRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_chunks
         WHERE snapshot_id = ?
         ORDER BY file_path ASC, chunk_index ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexChunkRow[]>,
  ]);
  return {
    meta: rowToMeta(row),
    files: files.map(rowToFile),
    chunks: chunks.map(rowToChunk),
  };
}

export async function loadCodeIndexFileData(
  repositoryId: string,
  branch: string,
  filePath: string,
): Promise<{
  meta: CodeIndexSnapshotMeta;
  file: CodeIndexFileRecord | null;
  chunks: CodeIndexChunkRecord[];
} | null> {
  const row = await getCodeIndexSnapshotRow(repositoryId, branch);
  if (!row) return null;
  const snapshotId = row.snapshot_id;
  const [fileRow, chunkRows] = await Promise.all([
    dba
      .prepare(
        `SELECT * FROM code_index_files
         WHERE snapshot_id = ? AND relative_path = ?
         LIMIT 1`,
      )
      .get(snapshotId, filePath) as Promise<CodeIndexFileRow | undefined>,
    dba
      .prepare(
        `SELECT * FROM code_index_chunks
         WHERE snapshot_id = ? AND file_path = ?
         ORDER BY chunk_index ASC`,
      )
      .all(snapshotId, filePath) as Promise<CodeIndexChunkRow[]>,
  ]);
  return {
    meta: rowToMeta(row),
    file: fileRow ? rowToFile(fileRow) : null,
    chunks: chunkRows.map(rowToChunk),
  };
}

export async function loadCodeIndexFunctionsData(
  repositoryId: string,
  branch: string,
): Promise<{
  meta: CodeIndexSnapshotMeta;
  functions: CodeIndexFunctionRecord[];
} | null> {
  const row = await getCodeIndexSnapshotRow(repositoryId, branch);
  if (!row) return null;
  const rows = (await dba
    .prepare(
      `SELECT * FROM code_index_functions
       WHERE snapshot_id = ?
       ORDER BY file_path ASC, line ASC`,
    )
    .all(row.snapshot_id)) as CodeIndexFunctionRow[];
  return {
    meta: rowToMeta(row),
    functions: rows.map(rowToFunction),
  };
}

export async function loadCodeIndexFunctionGraphData(
  repositoryId: string,
  branch: string,
): Promise<{
  meta: CodeIndexSnapshotMeta;
  functions: CodeIndexFunctionRecord[];
  functionEdges: CodeIndexFunctionEdgeRecord[];
} | null> {
  const row = await getCodeIndexSnapshotRow(repositoryId, branch);
  if (!row) return null;
  const snapshotId = row.snapshot_id;
  const [functions, functionEdges] = await Promise.all([
    dba
      .prepare(
        `SELECT * FROM code_index_functions
         WHERE snapshot_id = ?
         ORDER BY file_path ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionRow[]>,
    dba
      .prepare(
        `SELECT * FROM code_index_function_edges
         WHERE snapshot_id = ?
         ORDER BY from_function_id ASC, line ASC`,
      )
      .all(snapshotId) as Promise<CodeIndexFunctionEdgeRow[]>,
  ]);
  return {
    meta: rowToMeta(row),
    functions: functions.map(rowToFunction),
    functionEdges: functionEdges.map(rowToFunctionEdge),
  };
}

export async function saveCodeIndexSnapshotMeta(input: {
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  sourceKind?: CodeIndexSnapshotMeta['sourceKind'];
  sourceBranch?: string;
  sourceHeadSha?: string;
  manifestHash: string;
  progress: Omit<CodeIndexProgress, 'repositoryId' | 'branch'>;
  generatedAt?: string | null;
  stats?: CodeIndexSnapshotMeta['stats'];
  capabilities?: CodeIndexSnapshotMeta['capabilities'];
  userId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const snapshotId = `cis_${input.repositoryId}_${input.branch}`.replace(
    /[^a-zA-Z0-9_:-]/g,
    '_',
  );
  const existing = (await dba
    .prepare(
      `SELECT * FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(input.repositoryId, input.branch)) as CodeIndexSnapshotRow | undefined;
  const effectiveSnapshotId = existing?.snapshot_id || snapshotId;
  const stats =
    input.stats ||
    (existing
      ? parseJson(existing.stats_json, {
          fileCount: 0,
          chunkCount: 0,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 0,
          embeddedChunkCount: 0,
        })
      : {
          fileCount: 0,
          chunkCount: 0,
          functionCount: 0,
          functionEdgeCount: 0,
          totalLines: 0,
          embeddedChunkCount: 0,
        });
  const capabilities =
    input.capabilities ||
    (existing
      ? parseJson(existing.capabilities_json, {
          chunkSearch: false,
          fileSummaries: false,
          functionGraph: false,
          embeddings: false,
        })
      : {
          chunkSearch: false,
          fileSummaries: false,
          functionGraph: false,
          embeddings: false,
        });

  await dba
    .prepare(
      `INSERT OR REPLACE INTO code_index_snapshots (
        snapshot_id, repository_id, branch, root_directory, source_kind, source_branch, source_head_sha, manifest_hash,
        status, stage, processed_files, total_files, message, error_message,
        generated_at, stats_json, capabilities_json, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      effectiveSnapshotId,
      input.repositoryId,
      input.branch,
      input.rootDirectory || existing?.root_directory || '',
      input.sourceKind ||
        (existing?.source_kind as CodeIndexSnapshotMeta['sourceKind']) ||
        'unknown',
      input.sourceBranch || existing?.source_branch || input.branch,
      input.sourceHeadSha || existing?.source_head_sha || '',
      input.manifestHash ||
        existing?.manifest_hash ||
        `building:${input.branch}`,
      input.progress.status,
      input.progress.stage,
      input.progress.processedFiles,
      input.progress.totalFiles,
      input.progress.message,
      input.progress.error,
      input.generatedAt ?? existing?.generated_at ?? null,
      JSON.stringify(stats),
      JSON.stringify(capabilities),
      input.userId || existing?.user_id || '__system__',
      existing?.created_at || now,
      now,
    );
}

export async function saveCodeIndexSnapshot(
  snapshot: CodeIndexSnapshot,
  userId = '__system__',
): Promise<void> {
  const now = new Date().toISOString();
  const snapshotId =
    `cis_${snapshot.meta.repositoryId}_${snapshot.meta.branch}`.replace(
      /[^a-zA-Z0-9_:-]/g,
      '_',
    );
  const existing = (await dba
    .prepare(
      `SELECT snapshot_id, created_at FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(snapshot.meta.repositoryId, snapshot.meta.branch)) as
    | { snapshot_id: string; created_at: string }
    | undefined;
  const effectiveSnapshotId = existing?.snapshot_id || snapshotId;

  const transaction = dba.transaction(() => {
    dba
      .prepare(
        `INSERT OR REPLACE INTO code_index_snapshots (
          snapshot_id, repository_id, branch, root_directory, source_kind, source_branch, source_head_sha, manifest_hash,
          status, stage, processed_files, total_files, message, error_message,
          generated_at, stats_json, capabilities_json, user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        effectiveSnapshotId,
        snapshot.meta.repositoryId,
        snapshot.meta.branch,
        snapshot.meta.rootDirectory,
        snapshot.meta.sourceKind || 'unknown',
        snapshot.meta.sourceBranch || snapshot.meta.branch,
        snapshot.meta.sourceHeadSha || '',
        snapshot.meta.manifestHash,
        snapshot.meta.status,
        snapshot.meta.stage,
        snapshot.meta.progress.processedFiles,
        snapshot.meta.progress.totalFiles,
        snapshot.meta.progress.message,
        snapshot.meta.progress.error,
        snapshot.meta.generatedAt,
        JSON.stringify(snapshot.meta.stats),
        JSON.stringify(snapshot.meta.capabilities),
        userId,
        existing?.created_at || now,
        now,
      );

    dba
      .prepare(`DELETE FROM code_index_files WHERE snapshot_id = ?`)
      .run(effectiveSnapshotId);
    dba
      .prepare(`DELETE FROM code_index_chunks WHERE snapshot_id = ?`)
      .run(effectiveSnapshotId);
    dba
      .prepare(`DELETE FROM code_index_functions WHERE snapshot_id = ?`)
      .run(effectiveSnapshotId);
    dba
      .prepare(`DELETE FROM code_index_function_edges WHERE snapshot_id = ?`)
      .run(effectiveSnapshotId);

    const insertFile = dba.prepare(
      `INSERT INTO code_index_files (
        snapshot_id, relative_path, language, byte_size, line_count, file_hash,
        ${codeIndexRankColumnSql()}, import_count, export_count, summary_text, summary_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChunk = dba.prepare(
      `INSERT INTO code_index_chunks (
        id, snapshot_id, file_path, chunk_index, start_line, end_line,
        content, token_count, summary_text, content_hash, summary_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFunction = dba.prepare(
      `INSERT INTO code_index_functions (
        id, snapshot_id, file_path, name, kind, signature,
        start_line, end_line, line, column_number, parent_function_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFunctionEdge = dba.prepare(
      `INSERT INTO code_index_function_edges (
        id, snapshot_id, from_function_id, to_function_id, edge_type, symbol_name, line
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    snapshot.files.forEach((file) => {
      insertFile.run(
        effectiveSnapshotId,
        file.relativePath,
        file.language,
        file.byteSize,
        file.lineCount,
        file.fileHash,
        file.rank,
        file.importCount,
        file.exportCount,
        file.summary,
        file.summarySource,
      );
    });

    snapshot.chunks.forEach((chunk) => {
      insertChunk.run(
        chunk.id,
        effectiveSnapshotId,
        chunk.filePath,
        chunk.chunkIndex,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.tokenCount,
        chunk.summary,
        chunk.contentHash,
        chunk.summarySource,
      );
    });

    snapshot.functions.forEach((fn) => {
      insertFunction.run(
        fn.id,
        effectiveSnapshotId,
        fn.filePath,
        fn.name,
        fn.kind,
        fn.signature,
        fn.startLine,
        fn.endLine,
        fn.line,
        fn.column,
        fn.parentFunctionId,
      );
    });

    snapshot.functionEdges.forEach((edge) => {
      insertFunctionEdge.run(
        edge.id,
        effectiveSnapshotId,
        edge.fromFunctionId,
        edge.toFunctionId,
        edge.edgeType,
        edge.symbol,
        edge.line,
      );
    });
  });

  transaction();
}
