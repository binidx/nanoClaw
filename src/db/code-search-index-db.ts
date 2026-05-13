import { gunzipSync, gzipSync } from 'node:zlib';

import { createModuleLogger } from '../logger.js';
import { dba } from './engine-access.js';
import type {
  CodeSearchIndexRecord,
  CodeSearchIndexFileRecord,
  CodeSearchIndexSymbolRecord,
  CodeSearchIndexTermRecord,
  CodeSearchSnapshotRecord,
  CodeSearchSnapshotUpsertInput,
} from './review.js';

const codeSearchDbLog = createModuleLogger('code-search-db');
const PAYLOAD_CHUNK_BYTES = 256 * 1024;
const INSERT_CHUNK_BATCH_SIZE = 32;
const PAYLOAD_COMPRESSION = 'gzip';
const PAYLOAD_VERSION = 1;

interface CodeSearchPayloadChunkRecord {
  cache_key: string;
  ordinal: number;
  compression: string;
  chunk_bytes: number;
  payload_blob: Buffer | Uint8Array;
}

interface CodeSearchSnapshotPayload {
  version: number;
  files: CodeSearchSnapshotUpsertInput['files'];
}

function buildSnapshotPayload(
  input: CodeSearchSnapshotUpsertInput,
): Buffer {
  return gzipSync(
    Buffer.from(
      JSON.stringify({
        version: PAYLOAD_VERSION,
        files: input.files,
      } satisfies CodeSearchSnapshotPayload),
      'utf8',
    ),
  );
}

function splitPayloadIntoChunks(payload: Buffer): Buffer[] {
  if (payload.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += PAYLOAD_CHUNK_BYTES) {
    chunks.push(payload.subarray(offset, offset + PAYLOAD_CHUNK_BYTES));
  }
  return chunks;
}

function normalizePayloadBuffer(
  value: Buffer | Uint8Array,
): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function decodeSnapshotPayload(
  cacheKey: string,
  chunks: CodeSearchPayloadChunkRecord[],
): CodeSearchSnapshotPayload | null {
  if (chunks.length === 0) return null;
  if (chunks.some((chunk) => chunk.compression !== PAYLOAD_COMPRESSION)) {
    codeSearchDbLog.warn(
      {
        cacheKey,
        compressions: Array.from(
          new Set(chunks.map((chunk) => chunk.compression)),
        ),
      },
      'Unsupported code search payload compression',
    );
    return null;
  }

  try {
    const payload = gunzipSync(
      Buffer.concat(chunks.map((chunk) => normalizePayloadBuffer(chunk.payload_blob))),
    );
    const parsed = JSON.parse(payload.toString('utf8')) as
      | CodeSearchSnapshotPayload
      | null;
    if (!parsed || parsed.version !== PAYLOAD_VERSION || !Array.isArray(parsed.files)) {
      codeSearchDbLog.warn(
        { cacheKey, version: parsed?.version ?? null },
        'Invalid code search payload metadata',
      );
      return null;
    }
    return parsed;
  } catch (err) {
    codeSearchDbLog.warn({ cacheKey, err }, 'Failed to decode code search payload');
    return null;
  }
}

function buildSnapshotFromPayload(
  index: CodeSearchIndexRecord,
  payload: CodeSearchSnapshotPayload,
): CodeSearchSnapshotRecord {
  const files: CodeSearchIndexFileRecord[] = [];
  const symbols: CodeSearchIndexSymbolRecord[] = [];
  const terms: CodeSearchIndexTermRecord[] = [];

  payload.files.forEach((file) => {
    files.push({
      cache_key: index.cache_key,
      relative_path: file.relative_path,
      absolute_path: file.absolute_path,
      extension: file.extension,
      language: file.language,
      byte_size: file.byte_size,
      line_count: file.line_count,
      imports_json: file.imports_json || '[]',
      previews_json: file.previews_json || '[]',
    });

    file.symbols.forEach((symbol, ordinal) => {
      symbols.push({
        cache_key: index.cache_key,
        relative_path: file.relative_path,
        ordinal,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        column_number: symbol.column_number,
        signature: symbol.signature,
      });
    });

    file.terms.forEach((term, ordinal) => {
      terms.push({
        cache_key: index.cache_key,
        relative_path: file.relative_path,
        ordinal,
        term,
      });
    });
  });

  return { index, files, symbols, terms };
}

async function getPayloadChunks(
  cacheKey: string,
): Promise<CodeSearchPayloadChunkRecord[]> {
  return await dba
    .prepare(
      `SELECT * FROM code_search_index_payload_chunks
       WHERE cache_key = ?
       ORDER BY ordinal ASC`,
    )
    .all(cacheKey) as CodeSearchPayloadChunkRecord[];
}

async function insertPayloadChunks(
  cacheKey: string,
  chunks: Buffer[],
): Promise<void> {
  for (let start = 0; start < chunks.length; start += INSERT_CHUNK_BATCH_SIZE) {
    const batch = chunks.slice(start, start + INSERT_CHUNK_BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params: unknown[] = [];
    batch.forEach((chunk, batchIndex) => {
      params.push(
        cacheKey,
        start + batchIndex,
        PAYLOAD_COMPRESSION,
        chunk.length,
        chunk,
      );
    });
    await dba
      .prepare(
        `INSERT INTO code_search_index_payload_chunks (
          cache_key, ordinal, compression, chunk_bytes, payload_blob
        ) VALUES ${placeholders}`,
      )
      .run(...params);
  }
}

export async function getCodeSearchIndexRecord(
  cacheKey: string,
): Promise<CodeSearchIndexRecord | undefined> {
  return await dba
    .prepare(`SELECT * FROM code_search_indexes WHERE cache_key = ? LIMIT 1`)
    .get(cacheKey) as CodeSearchIndexRecord | undefined;
}

export async function getCodeSearchSnapshot(
  cacheKey: string,
): Promise<CodeSearchSnapshotRecord | undefined> {
  const index = await getCodeSearchIndexRecord(cacheKey);
  if (!index) return undefined;
  const payload = decodeSnapshotPayload(cacheKey, await getPayloadChunks(cacheKey));
  if (!payload) return undefined;
  return buildSnapshotFromPayload(index, payload);
}

export async function saveCodeSearchSnapshot(
  input: CodeSearchSnapshotUpsertInput,
): Promise<CodeSearchIndexRecord> {
  const now = new Date().toISOString();
  const existing = await getCodeSearchIndexRecord(input.cache_key);
  const payloadChunks = splitPayloadIntoChunks(buildSnapshotPayload(input));

  const save = dba.transaction(async () => {
    await dba
      .prepare(
        `INSERT OR REPLACE INTO code_search_indexes (
        cache_key, root_directory, manifest_hash, build_options_json,
        generated_at, file_count, symbol_count, term_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.cache_key,
        input.root_directory,
        input.manifest_hash,
        input.build_options_json,
        input.generated_at,
        input.file_count,
        input.symbol_count,
        input.term_count,
        existing?.created_at || now,
        now,
      );

    await dba
      .prepare(`DELETE FROM code_search_index_terms WHERE cache_key = ?`)
      .run(input.cache_key);
    await dba
      .prepare(`DELETE FROM code_search_index_symbols WHERE cache_key = ?`)
      .run(input.cache_key);
    await dba
      .prepare(`DELETE FROM code_search_index_files WHERE cache_key = ?`)
      .run(input.cache_key);
    await dba
      .prepare(`DELETE FROM code_search_index_payload_chunks WHERE cache_key = ?`)
      .run(input.cache_key);
    await insertPayloadChunks(input.cache_key, payloadChunks);
  });

  await save();
  return (await getCodeSearchIndexRecord(input.cache_key))!;
}

export async function deleteCodeSearchSnapshot(cacheKey: string): Promise<void> {
  await dba.transaction(async () => {
    await dba
      .prepare(`DELETE FROM code_search_index_terms WHERE cache_key = ?`)
      .run(cacheKey);
    await dba
      .prepare(`DELETE FROM code_search_index_symbols WHERE cache_key = ?`)
      .run(cacheKey);
    await dba
      .prepare(`DELETE FROM code_search_index_files WHERE cache_key = ?`)
      .run(cacheKey);
    await dba
      .prepare(`DELETE FROM code_search_index_payload_chunks WHERE cache_key = ?`)
      .run(cacheKey);
    await dba
      .prepare(`DELETE FROM code_search_indexes WHERE cache_key = ?`)
      .run(cacheKey);
  })();
}
