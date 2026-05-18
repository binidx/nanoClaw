import crypto from 'node:crypto';

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
  files_hash: string;
  chunks_hash: string;
  functions_hash: string;
  function_edges_hash: string;
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

const SQLITE_BULK_INSERT_PARAM_LIMIT = 900;
const DEFAULT_BULK_INSERT_PARAM_LIMIT = 10_000;

interface CodeIndexEntityHashes {
  filesHash: string;
  chunksHash: string;
  functionsHash: string;
  functionEdgesHash: string;
}

interface CodeIndexSnapshotPersistenceRow {
  snapshot_id: string;
  created_at: string;
  manifest_hash: string;
  files_hash: string;
  chunks_hash: string;
  functions_hash: string;
  function_edges_hash: string;
}

function flattenInsertRows(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): unknown[] {
  const params: unknown[] = [];
  for (const row of rows) {
    params.push(...row);
  }
  return params;
}

async function runBatchedInsert(
  table: string,
  columns: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): Promise<void> {
  if (rows.length === 0) return;

  const columnCount = columns.length;
  const maxParams =
    eng().dialect === 'sqlite'
      ? SQLITE_BULK_INSERT_PARAM_LIMIT
      : DEFAULT_BULK_INSERT_PARAM_LIMIT;
  const batchSize = Math.max(1, Math.floor(maxParams / columnCount));
  const columnSql = columns.join(', ');

  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const valuesSql = batch
      .map(() => `(${columns.map(() => '?').join(', ')})`)
      .join(', ');
    await dba
      .prepare(`INSERT INTO ${table} ( ${columnSql} ) VALUES ${valuesSql}`)
      .run(...flattenInsertRows(batch));
  }
}

function hashPayload(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function buildEntityHashes(snapshot: Pick<
  CodeIndexSnapshot,
  'files' | 'chunks' | 'functions' | 'functionEdges'
>): CodeIndexEntityHashes {
  return {
    filesHash: hashPayload(
      snapshot.files.map((file) => [
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
      ]),
    ),
    chunksHash: hashPayload(
      snapshot.chunks.map((chunk) => [
        chunk.id,
        chunk.filePath,
        chunk.chunkIndex,
        chunk.startLine,
        chunk.endLine,
        chunk.contentHash,
        chunk.tokenCount,
        chunk.summary,
        chunk.summarySource,
      ]),
    ),
    functionsHash: hashPayload(
      snapshot.functions.map((fn) => [
        fn.id,
        fn.filePath,
        fn.name,
        fn.kind,
        fn.signature,
        fn.startLine,
        fn.endLine,
        fn.line,
        fn.column,
        fn.parentFunctionId,
      ]),
    ),
    functionEdgesHash: hashPayload(
      snapshot.functionEdges.map((edge) => [
        edge.id,
        edge.fromFunctionId,
        edge.toFunctionId,
        edge.edgeType,
        edge.symbol,
        edge.line,
      ]),
    ),
  };
}

function entityHashesFromRow(
  row?: Partial<CodeIndexSnapshotRow> | Partial<CodeIndexSnapshotPersistenceRow>,
): CodeIndexEntityHashes {
  return {
    filesHash: row?.files_hash || '',
    chunksHash: row?.chunks_hash || '',
    functionsHash: row?.functions_hash || '',
    functionEdgesHash: row?.function_edges_hash || '',
  };
}

async function upsertSnapshotRow(input: {
  snapshotId: string;
  repositoryId: string;
  branch: string;
  rootDirectory: string;
  sourceKind: CodeIndexSnapshotMeta['sourceKind'];
  sourceBranch: string;
  sourceHeadSha: string;
  manifestHash: string;
  status: CodeIndexSnapshotMeta['status'];
  stage: CodeIndexSnapshotMeta['stage'];
  processedFiles: number;
  totalFiles: number;
  message: string;
  errorMessage: string | null;
  generatedAt: string | null;
  stats: CodeIndexSnapshotMeta['stats'];
  capabilities: CodeIndexSnapshotMeta['capabilities'];
  entityHashes: CodeIndexEntityHashes;
  userId: string;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  await dba
    .prepare(
      `INSERT OR REPLACE INTO code_index_snapshots (
        snapshot_id, repository_id, branch, root_directory, source_kind, source_branch, source_head_sha, manifest_hash,
        status, stage, processed_files, total_files, message, error_message,
        generated_at, stats_json, capabilities_json, files_hash, chunks_hash, functions_hash, function_edges_hash,
        user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.snapshotId,
      input.repositoryId,
      input.branch,
      input.rootDirectory,
      input.sourceKind || 'unknown',
      input.sourceBranch || input.branch,
      input.sourceHeadSha || '',
      input.manifestHash,
      input.status,
      input.stage,
      input.processedFiles,
      input.totalFiles,
      input.message,
      input.errorMessage,
      input.generatedAt,
      JSON.stringify(input.stats),
      JSON.stringify(input.capabilities),
      input.entityHashes.filesHash,
      input.entityHashes.chunksHash,
      input.entityHashes.functionsHash,
      input.entityHashes.functionEdgesHash,
      input.userId,
      input.createdAt,
      input.updatedAt,
    );
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

async function getCodeIndexSnapshotPersistenceRow(
  repositoryId: string,
  branch: string,
): Promise<CodeIndexSnapshotPersistenceRow | undefined> {
  return (await dba
    .prepare(
      `SELECT snapshot_id, created_at, manifest_hash, files_hash, chunks_hash, functions_hash, function_edges_hash
       FROM code_index_snapshots
       WHERE repository_id = ? AND branch = ?
       LIMIT 1`,
    )
    .get(repositoryId, branch)) as CodeIndexSnapshotPersistenceRow | undefined;
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
  await upsertSnapshotRow({
    snapshotId: effectiveSnapshotId,
    repositoryId: input.repositoryId,
    branch: input.branch,
    rootDirectory: input.rootDirectory || existing?.root_directory || '',
    sourceKind:
      input.sourceKind ||
      (existing?.source_kind as CodeIndexSnapshotMeta['sourceKind']) ||
      'unknown',
    sourceBranch: input.sourceBranch || existing?.source_branch || input.branch,
    sourceHeadSha: input.sourceHeadSha || existing?.source_head_sha || '',
    manifestHash:
      input.manifestHash || existing?.manifest_hash || `building:${input.branch}`,
    status: input.progress.status,
    stage: input.progress.stage,
    processedFiles: input.progress.processedFiles,
    totalFiles: input.progress.totalFiles,
    message: input.progress.message,
    errorMessage: input.progress.error,
    generatedAt: input.generatedAt ?? existing?.generated_at ?? null,
    stats,
    capabilities,
    entityHashes: entityHashesFromRow(existing),
    userId: input.userId || existing?.user_id || '__system__',
    createdAt: existing?.created_at || now,
    updatedAt: now,
  });
}

async function replaceSnapshotFiles(
  snapshotId: string,
  files: readonly CodeIndexFileRecord[],
): Promise<void> {
  await dba.prepare(`DELETE FROM code_index_files WHERE snapshot_id = ?`).run(snapshotId);
  await runBatchedInsert(
    'code_index_files',
    [
      'snapshot_id',
      'relative_path',
      'language',
      'byte_size',
      'line_count',
      'file_hash',
      codeIndexRankColumnSql(),
      'import_count',
      'export_count',
      'summary_text',
      'summary_source',
    ],
    files.map((file) => [
      snapshotId,
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
    ]),
  );
}

async function replaceSnapshotChunks(
  snapshotId: string,
  chunks: readonly CodeIndexChunkRecord[],
): Promise<void> {
  await dba.prepare(`DELETE FROM code_index_chunks WHERE snapshot_id = ?`).run(snapshotId);
  await runBatchedInsert(
    'code_index_chunks',
    [
      'id',
      'snapshot_id',
      'file_path',
      'chunk_index',
      'start_line',
      'end_line',
      'content',
      'token_count',
      'summary_text',
      'content_hash',
      'summary_source',
    ],
    chunks.map((chunk) => [
      chunk.id,
      snapshotId,
      chunk.filePath,
      chunk.chunkIndex,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.tokenCount,
      chunk.summary,
      chunk.contentHash,
      chunk.summarySource,
    ]),
  );
}

async function replaceSnapshotFunctions(
  snapshotId: string,
  functions: readonly CodeIndexFunctionRecord[],
): Promise<void> {
  await dba
    .prepare(`DELETE FROM code_index_functions WHERE snapshot_id = ?`)
    .run(snapshotId);
  await runBatchedInsert(
    'code_index_functions',
    [
      'id',
      'snapshot_id',
      'file_path',
      'name',
      'kind',
      'signature',
      'start_line',
      'end_line',
      'line',
      'column_number',
      'parent_function_id',
    ],
    functions.map((fn) => [
      fn.id,
      snapshotId,
      fn.filePath,
      fn.name,
      fn.kind,
      fn.signature,
      fn.startLine,
      fn.endLine,
      fn.line,
      fn.column,
      fn.parentFunctionId,
    ]),
  );
}

async function replaceSnapshotFunctionEdges(
  snapshotId: string,
  functionEdges: readonly CodeIndexFunctionEdgeRecord[],
): Promise<void> {
  await dba
    .prepare(`DELETE FROM code_index_function_edges WHERE snapshot_id = ?`)
    .run(snapshotId);
  await runBatchedInsert(
    'code_index_function_edges',
    [
      'id',
      'snapshot_id',
      'from_function_id',
      'to_function_id',
      'edge_type',
      'symbol_name',
      'line',
    ],
    functionEdges.map((edge) => [
      edge.id,
      snapshotId,
      edge.fromFunctionId,
      edge.toFunctionId,
      edge.edgeType,
      edge.symbol,
      edge.line,
    ]),
  );
}

export async function saveCodeIndexSnapshot(
  snapshot: CodeIndexSnapshot,
  userId = '__system__',
): Promise<void> {
  const now = new Date().toISOString();
  const entityHashes = buildEntityHashes(snapshot);
  const snapshotId =
    `cis_${snapshot.meta.repositoryId}_${snapshot.meta.branch}`.replace(
      /[^a-zA-Z0-9_:-]/g,
      '_',
    );
  const existing = await getCodeIndexSnapshotPersistenceRow(
    snapshot.meta.repositoryId,
    snapshot.meta.branch,
  );
  const effectiveSnapshotId = existing?.snapshot_id || snapshotId;
  const sameManifest =
    existing?.manifest_hash === snapshot.meta.manifestHash;
  const hasStoredEntityHashes =
    !!existing?.files_hash &&
    !!existing?.chunks_hash &&
    !!existing?.functions_hash &&
    !!existing?.function_edges_hash;
  const replaceFiles =
    !sameManifest || !hasStoredEntityHashes || existing.files_hash !== entityHashes.filesHash;
  const replaceChunks =
    !sameManifest || !hasStoredEntityHashes || existing.chunks_hash !== entityHashes.chunksHash;
  const replaceFunctions =
    !sameManifest ||
    !hasStoredEntityHashes ||
    existing.functions_hash !== entityHashes.functionsHash;
  const replaceFunctionEdges =
    !sameManifest ||
    !hasStoredEntityHashes ||
    existing.function_edges_hash !== entityHashes.functionEdgesHash;

  const transaction = dba.transaction(async () => {
    await upsertSnapshotRow({
      snapshotId: effectiveSnapshotId,
      repositoryId: snapshot.meta.repositoryId,
      branch: snapshot.meta.branch,
      rootDirectory: snapshot.meta.rootDirectory,
      sourceKind: snapshot.meta.sourceKind || 'unknown',
      sourceBranch: snapshot.meta.sourceBranch || snapshot.meta.branch,
      sourceHeadSha: snapshot.meta.sourceHeadSha || '',
      manifestHash: snapshot.meta.manifestHash,
      status: snapshot.meta.status,
      stage: snapshot.meta.stage,
      processedFiles: snapshot.meta.progress.processedFiles,
      totalFiles: snapshot.meta.progress.totalFiles,
      message: snapshot.meta.progress.message,
      errorMessage: snapshot.meta.progress.error,
      generatedAt: snapshot.meta.generatedAt,
      stats: snapshot.meta.stats,
      capabilities: snapshot.meta.capabilities,
      entityHashes,
      userId,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    });

    if (replaceFiles) {
      await replaceSnapshotFiles(effectiveSnapshotId, snapshot.files);
    }

    if (replaceChunks) {
      await replaceSnapshotChunks(effectiveSnapshotId, snapshot.chunks);
    }

    if (replaceFunctions) {
      await replaceSnapshotFunctions(effectiveSnapshotId, snapshot.functions);
    }

    if (replaceFunctionEdges) {
      await replaceSnapshotFunctionEdges(
        effectiveSnapshotId,
        snapshot.functionEdges,
      );
    }
  });

  await transaction();
}

export async function saveCodeIndexSummaryDelta(
  snapshot: CodeIndexSnapshot,
  userId = '__system__',
): Promise<void> {
  const now = new Date().toISOString();
  const entityHashes = buildEntityHashes(snapshot);
  const existing = await getCodeIndexSnapshotPersistenceRow(
    snapshot.meta.repositoryId,
    snapshot.meta.branch,
  );
  if (!existing || existing.manifest_hash !== snapshot.meta.manifestHash) {
    await saveCodeIndexSnapshot(snapshot, userId);
    return;
  }

  const effectiveSnapshotId = existing.snapshot_id;
  const filesChanged = existing.files_hash !== entityHashes.filesHash;
  const chunksChanged = existing.chunks_hash !== entityHashes.chunksHash;
  const functionsChanged = existing.functions_hash !== entityHashes.functionsHash;
  const functionEdgesChanged =
    existing.function_edges_hash !== entityHashes.functionEdgesHash;

  if (functionsChanged || functionEdgesChanged) {
    await saveCodeIndexSnapshot(snapshot, userId);
    return;
  }

  const transaction = dba.transaction(async () => {
    await upsertSnapshotRow({
      snapshotId: effectiveSnapshotId,
      repositoryId: snapshot.meta.repositoryId,
      branch: snapshot.meta.branch,
      rootDirectory: snapshot.meta.rootDirectory,
      sourceKind: snapshot.meta.sourceKind || 'unknown',
      sourceBranch: snapshot.meta.sourceBranch || snapshot.meta.branch,
      sourceHeadSha: snapshot.meta.sourceHeadSha || '',
      manifestHash: snapshot.meta.manifestHash,
      status: snapshot.meta.status,
      stage: snapshot.meta.stage,
      processedFiles: snapshot.meta.progress.processedFiles,
      totalFiles: snapshot.meta.progress.totalFiles,
      message: snapshot.meta.progress.message,
      errorMessage: snapshot.meta.progress.error,
      generatedAt: snapshot.meta.generatedAt,
      stats: snapshot.meta.stats,
      capabilities: snapshot.meta.capabilities,
      entityHashes,
      userId,
      createdAt: existing.created_at,
      updatedAt: now,
    });

    if (filesChanged) {
      await replaceSnapshotFiles(effectiveSnapshotId, snapshot.files);
    }
    if (chunksChanged) {
      await replaceSnapshotChunks(effectiveSnapshotId, snapshot.chunks);
    }
  });

  await transaction();
}

export async function saveCodeIndexStateDelta(
  snapshot: CodeIndexSnapshot,
  userId = '__system__',
): Promise<void> {
  const now = new Date().toISOString();
  const entityHashes = buildEntityHashes(snapshot);
  const existing = await getCodeIndexSnapshotPersistenceRow(
    snapshot.meta.repositoryId,
    snapshot.meta.branch,
  );
  if (!existing || existing.manifest_hash !== snapshot.meta.manifestHash) {
    await saveCodeIndexSnapshot(snapshot, userId);
    return;
  }

  const sameEntityHashes =
    existing.files_hash === entityHashes.filesHash &&
    existing.chunks_hash === entityHashes.chunksHash &&
    existing.functions_hash === entityHashes.functionsHash &&
    existing.function_edges_hash === entityHashes.functionEdgesHash;
  if (!sameEntityHashes) {
    await saveCodeIndexSnapshot(snapshot, userId);
    return;
  }

  await upsertSnapshotRow({
    snapshotId: existing.snapshot_id,
    repositoryId: snapshot.meta.repositoryId,
    branch: snapshot.meta.branch,
    rootDirectory: snapshot.meta.rootDirectory,
    sourceKind: snapshot.meta.sourceKind || 'unknown',
    sourceBranch: snapshot.meta.sourceBranch || snapshot.meta.branch,
    sourceHeadSha: snapshot.meta.sourceHeadSha || '',
    manifestHash: snapshot.meta.manifestHash,
    status: snapshot.meta.status,
    stage: snapshot.meta.stage,
    processedFiles: snapshot.meta.progress.processedFiles,
    totalFiles: snapshot.meta.progress.totalFiles,
    message: snapshot.meta.progress.message,
    errorMessage: snapshot.meta.progress.error,
    generatedAt: snapshot.meta.generatedAt,
    stats: snapshot.meta.stats,
    capabilities: snapshot.meta.capabilities,
    entityHashes,
    userId,
    createdAt: existing.created_at,
    updatedAt: now,
  });
}
