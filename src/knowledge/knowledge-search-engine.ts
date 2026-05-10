import type { DbEngine } from '../database/engine.js';
import type { KnowledgeChunkRecord } from '../types.js';
import { getPgFtsConfig } from '../database/pg-fts-config.js';
import { isMySqlFullTextUnsupportedError } from '../database/mysql-fulltext.js';
import { t } from '../i18n/index.js';

export interface KnowledgeFTSResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
}

export interface KnowledgeFTSSearchOpts {
  kbIds?: string[];
  limit?: number;
}

export interface KnowledgeSearchEngine {
  initialize(engine: DbEngine): Promise<void>;
  indexChunks(engine: DbEngine, chunks: KnowledgeChunkRecord[]): Promise<void>;
  deleteByDocumentId(engine: DbEngine, documentId: string): Promise<void>;
  search(
    engine: DbEngine,
    query: string,
    opts?: KnowledgeFTSSearchOpts,
  ): Promise<KnowledgeFTSResult[]>;
  reindexAll?(engine: DbEngine): Promise<number>;
}

const CHUNKS_TABLE = 'knowledge_chunks';
const FTS_TABLE = 'knowledge_chunks_fts';

function normalizeSearch(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const CJK_STOP_WORDS = new Set([
  t('errors.auto_01d7aa', {}, undefined), t('errors.auto_163773', {}, undefined), t('errors.auto_241d47', {}, undefined), t('errors.auto_0a60ac', {}, undefined), t('errors.auto_168152', {}, undefined), t('errors.auto_cc4ad2', {}, undefined), t('errors.auto_ab20cc', {}, undefined), t('errors.auto_1ff3ff', {}, undefined), t('errors.auto_9eba1a', {}, undefined), t('errors.auto_465afe', {}, undefined), t('errors.auto_de44f1', {}, undefined), t('errors.auto_7941da', {}, undefined),
  t('errors.auto_8b9a14', {}, undefined), t('errors.auto_af767b', {}, undefined), t('errors.auto_61faca', {}, undefined), t('errors.auto_5e360d', {}, undefined), t('errors.auto_d716f1', {}, undefined), t('errors.auto_ddc9d3', {}, undefined), t('errors.auto_5438c8', {}, undefined), t('errors.auto_dfb936', {}, undefined), t('errors.auto_df1fd9', {}, undefined), t('errors.auto_647477', {}, undefined), t('errors.auto_7d49b3', {}, undefined),
  t('errors.auto_b4ebe3', {}, undefined), t('errors.auto_930244', {}, undefined), t('errors.auto_ac2c8f', {}, undefined), t('errors.auto_0c105e', {}, undefined), t('errors.auto_8e9b7a', {}, undefined), t('errors.auto_5fe86c', {}, undefined), t('errors.auto_92f3ca', {}, undefined), t('errors.auto_3c1400', {}, undefined), t('errors.auto_ab4a85', {}, undefined), t('errors.auto_247edb', {}, undefined),
  t('errors.auto_d0a33a', {}, undefined), t('errors.auto_736ccb', {}, undefined), t('errors.auto_786df5', {}, undefined), t('errors.auto_b034f9', {}, undefined), t('errors.auto_cf9e99', {}, undefined), t('errors.auto_67a0d3', {}, undefined), t('errors.auto_62a2b2', {}, undefined), t('errors.auto_298808', {}, undefined), t('errors.auto_65ac5a', {}, undefined),
  t('errors.auto_9ff279', {}, undefined), t('errors.auto_04c16f', {}, undefined), t('errors.auto_e885cb', {}, undefined), t('errors.auto_f4312e', {}, undefined), t('errors.auto_4bdddb', {}, undefined), t('errors.auto_19cfa6', {}, undefined), t('errors.auto_f20eff', {}, undefined), t('errors.auto_995c3e', {}, undefined), t('errors.auto_76d328', {}, undefined), t('errors.auto_90e087', {}, undefined),
  t('errors.auto_eaa9c5', {}, undefined), t('errors.auto_9c0479', {}, undefined), t('errors.auto_647477', {}, undefined), t('errors.auto_a37a9b', {}, undefined), t('errors.auto_22ae80', {}, undefined), t('errors.auto_167bb5', {}, undefined), t('errors.auto_37186b', {}, undefined), t('errors.auto_0cc05f', {}, undefined), t('errors.auto_a510ac', {}, undefined), t('errors.auto_00447b', {}, undefined),
  t('errors.auto_a8b816', {}, undefined), t('errors.auto_fc8f10', {}, undefined), t('errors.auto_420fdd', {}, undefined), t('errors.auto_7681c2', {}, undefined), t('errors.auto_5f3cf4', {}, undefined), t('errors.auto_f12e4a', {}, undefined), t('errors.auto_3f08be', {}, undefined), t('errors.auto_072ca6', {}, undefined), t('errors.auto_271965', {}, undefined),
  t('errors.auto_d33a3d', {}, undefined), t('errors.auto_d26c2b', {}, undefined), t('errors.auto_e7c301', {}, undefined), t('errors.auto_0645cb', {}, undefined), t('errors.auto_5438c8', {}, undefined), t('errors.auto_d1a34a', {}, undefined), t('errors.auto_3bba2f', {}, undefined), t('errors.auto_81d9f5', {}, undefined),
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
  'have', 'has', 'had', 'of', 'in', 'to', 'for', 'with', 'on',
  'at', 'by', 'from', 'as', 'it', 'this', 'that', 'what', 'how',
  'which', 'who', 'where', 'when', 'why', 'and', 'or', 'but', 'not',
]);

function removeStopWords(segments: string[]): string[] {
  const filtered = segments.filter((s) => s.length > 1 && !CJK_STOP_WORDS.has(s));
  return filtered.length > 0 ? filtered : segments;
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
function containsCJK(s: string): boolean {
  return CJK_RANGE.test(s);
}

/**
 * LIKE-based search fallback for CJK queries when no proper CJK tokenizer is available.
 * Uses two-phase AND→OR strategy consistent with the FTS path.
 */
async function likeBasedCJKSearch(
  engine: DbEngine,
  query: string,
  opts: KnowledgeFTSSearchOpts | undefined,
  dialect: 'postgres' | 'sqlite',
): Promise<KnowledgeFTSResult[]> {
  const normalized = normalizeSearch(query);
  if (!normalized) return [];
  const limit = Math.max(1, Math.min(opts?.limit ?? 15, 50));
  const terms = removeStopWords(normalized.split(/\s+/).filter(Boolean));
  if (terms.length === 0) return [];

  const kbJoin = opts?.kbIds?.length
    ? `JOIN knowledge_documents d ON d.id = c.document_id`
    : '';
  const idAlias = dialect === 'postgres' ? '"chunkId"' : 'chunkId';
  const docIdAlias = dialect === 'postgres' ? '"documentId"' : 'documentId';

  const buildLikeQuery = (joinOp: 'AND' | 'OR') => {
    const params: unknown[] = [];
    const whereParts: string[] = [];
    const scoreParts: string[] = [];
    for (const term of terms) {
      whereParts.push('c.content LIKE ?');
      params.push(`%${term}%`);
      if (dialect === 'postgres') {
        scoreParts.push(
          `(length(c.content) - length(replace(c.content, ?, '')))::float / greatest(length(?), 1)`,
        );
      } else {
        scoreParts.push(
          `(length(c.content) - length(replace(c.content, ?, ''))) * 1.0 / max(length(?), 1)`,
        );
      }
      params.push(term, term);
    }
    const kbFilter = buildKbFilter(opts?.kbIds, params);
    params.push(limit);
    const scoreSum =
      scoreParts.length === 1 ? scoreParts[0] : `(${scoreParts.join(' + ')})`;
    const lenNorm =
      dialect === 'postgres'
        ? `ln(2.0 + length(c.content))`
        : `(2.0 + length(c.content) * 0.001)`;
    const whereExpr = whereParts.join(` ${joinOp} `);
    const sql = `SELECT c.id AS ${idAlias}, c.document_id AS ${docIdAlias},
            c.content,
            ${scoreSum} / ${lenNorm} AS score
     FROM ${CHUNKS_TABLE} c ${kbJoin}
     WHERE (${whereExpr})
     ${kbFilter}
     ORDER BY score DESC
     LIMIT ?`;
    return { sql, params };
  };

  // Phase 1: AND — all terms must match (high precision)
  const and = buildLikeQuery('AND');
  const andResults = await engine.queryAll<KnowledgeFTSResult>(and.sql, and.params);

  if (andResults.length >= Math.ceil(limit / 2) || terms.length <= 1) {
    return andResults;
  }

  // Phase 2: OR fallback — any term matches (broader recall)
  const or = buildLikeQuery('OR');
  const orResults = await engine.queryAll<KnowledgeFTSResult>(or.sql, or.params);

  const seen = new Set(andResults.map((r) => r.chunkId));
  const merged = [...andResults];
  for (const r of orResults) {
    if (!seen.has(r.chunkId)) { merged.push(r); seen.add(r.chunkId); }
  }
  return merged.slice(0, limit);
}

function buildFts5Match(q: string): string {
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function buildKbFilter(
  kbIds: string[] | undefined,
  params: unknown[],
  tableAlias = 'd',
): string {
  if (!kbIds || kbIds.length === 0) return '';
  const placeholders = kbIds.map(() => '?').join(', ');
  params.push(...kbIds);
  return ` AND ${tableAlias}.kb_id IN (${placeholders})`;
}

// ---------------------------------------------------------------------------
// SQLite FTS5 implementation
// ---------------------------------------------------------------------------
export class SQLiteKnowledgeSearchEngine implements KnowledgeSearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    await engine.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);
  }

  async indexChunks(
    engine: DbEngine,
    chunks: KnowledgeChunkRecord[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      await Promise.all(
        batch.map((c) =>
          engine.run(
            `INSERT INTO ${FTS_TABLE} (chunk_id, document_id, content) VALUES (?, ?, ?)`,
            [c.id, c.document_id, c.content],
          ),
        ),
      );
    }
  }

  async deleteByDocumentId(
    engine: DbEngine,
    documentId: string,
  ): Promise<void> {
    await engine.run(`DELETE FROM ${FTS_TABLE} WHERE document_id = ?`, [
      documentId,
    ]);
  }

  async search(
    engine: DbEngine,
    query: string,
    opts?: KnowledgeFTSSearchOpts,
  ): Promise<KnowledgeFTSResult[]> {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const limit = Math.max(1, Math.min(opts?.limit ?? 15, 50));
    const matchQuery = buildFts5Match(normalized);
    if (!matchQuery) return [];

    const isCJK = containsCJK(normalized);
    const kbJoin = opts?.kbIds?.length ? `JOIN knowledge_documents d ON d.id = f.document_id` : '';

    // Phase 1: AND (FTS5 implicit AND with space-separated quoted tokens)
    const params1: unknown[] = [matchQuery];
    const kbFilter1 = buildKbFilter(opts?.kbIds, params1);
    params1.push(limit);
    const andResults = await engine.queryAll<KnowledgeFTSResult>(
      `SELECT f.chunk_id AS chunkId, f.document_id AS documentId,
              c.content, bm25(${FTS_TABLE}, 8.0) AS score
       FROM ${FTS_TABLE} f
       JOIN ${CHUNKS_TABLE} c ON c.id = f.chunk_id ${kbJoin}
       WHERE ${FTS_TABLE} MATCH ?
       ${kbFilter1}
       ORDER BY score ASC
       LIMIT ?`,
      params1,
    );

    const tokens = removeStopWords(normalized.split(/\s+/).filter(Boolean));
    if (andResults.length >= Math.ceil(limit / 2) || tokens.length <= 1) {
      return andResults;
    }

    // Phase 2: OR fallback (stop words removed for relevance)
    const orMatch = tokens.map((t) => `"${t}"`).join(' OR ');
    const params2: unknown[] = [orMatch];
    const kbFilter2 = buildKbFilter(opts?.kbIds, params2);
    params2.push(limit);
    const orResults = await engine.queryAll<KnowledgeFTSResult>(
      `SELECT f.chunk_id AS chunkId, f.document_id AS documentId,
              c.content, bm25(${FTS_TABLE}, 8.0) AS score
       FROM ${FTS_TABLE} f
       JOIN ${CHUNKS_TABLE} c ON c.id = f.chunk_id ${kbJoin}
       WHERE ${FTS_TABLE} MATCH ?
       ${kbFilter2}
       ORDER BY score ASC
       LIMIT ?`,
      params2,
    );

    const seen = new Set(andResults.map((r) => r.chunkId));
    const merged = [...andResults];
    for (const r of orResults) {
      if (!seen.has(r.chunkId)) { merged.push(r); seen.add(r.chunkId); }
    }
    const ftsTotal = merged.length;

    // Phase 3: LIKE fallback for CJK when FTS5 unicode61 results are insufficient.
    // unicode61 doesn't segment CJK; LIKE does exact substring matching.
    if (isCJK && ftsTotal < Math.ceil(limit / 2)) {
      const likeResults = await likeBasedCJKSearch(engine, query, opts, 'sqlite');
      for (const r of likeResults) {
        if (!seen.has(r.chunkId)) { merged.push(r); seen.add(r.chunkId); }
      }
    }

    return merged.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// MySQL FULLTEXT implementation
// ---------------------------------------------------------------------------
export class MySQLKnowledgeSearchEngine implements KnowledgeSearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    try {
      await engine.exec(
        `ALTER TABLE ${CHUNKS_TABLE} ADD FULLTEXT INDEX ft_kb_content (content)`,
      );
    } catch (err) {
      if (!isMySqlFullTextUnsupportedError(err)) {
        const message = String((err as Error)?.message ?? '');
        if (!/duplicate|exists/i.test(message)) throw err;
      }
    }
  }

  async indexChunks(
    _engine: DbEngine,
    _chunks: KnowledgeChunkRecord[],
  ): Promise<void> {
    // MySQL FULLTEXT auto-indexes on INSERT — no extra action needed
  }

  async deleteByDocumentId(
    _engine: DbEngine,
    _documentId: string,
  ): Promise<void> {
    // MySQL FULLTEXT auto-cleans on DELETE — no extra action needed
  }

  async search(
    engine: DbEngine,
    query: string,
    opts?: KnowledgeFTSSearchOpts,
  ): Promise<KnowledgeFTSResult[]> {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const limit = Math.max(1, Math.min(opts?.limit ?? 15, 50));
    const params: unknown[] = [normalized, normalized];
    const kbFilter = buildKbFilter(opts?.kbIds, params);
    params.push(limit);

    try {
      return await engine.queryAll<KnowledgeFTSResult>(
        `SELECT c.id AS chunkId, c.document_id AS documentId,
                c.content,
                MATCH(c.content) AGAINST(? IN BOOLEAN MODE) AS score
         FROM ${CHUNKS_TABLE} c
         ${opts?.kbIds?.length ? `JOIN knowledge_documents d ON d.id = c.document_id` : ''}
         WHERE MATCH(c.content) AGAINST(? IN BOOLEAN MODE)
         ${kbFilter}
         ORDER BY score DESC
         LIMIT ?`,
        params,
      );
    } catch (err) {
      if (!isMySqlFullTextUnsupportedError(err)) throw err;
    }

    return likeBasedMySQLSearch(engine, normalized, opts, limit);
  }
}

async function likeBasedMySQLSearch(
  engine: DbEngine,
  normalized: string,
  opts: KnowledgeFTSSearchOpts | undefined,
  limit: number,
): Promise<KnowledgeFTSResult[]> {
  const terms = removeStopWords(normalized.split(/\s+/).filter(Boolean));
  if (terms.length === 0) return [];

  const params: unknown[] = [];
  const whereParts: string[] = [];
  const scoreParts: string[] = [];
  for (const term of terms) {
    whereParts.push('c.content LIKE ?');
    params.push(`%${term}%`);
    scoreParts.push(
      `(length(c.content) - length(replace(c.content, ?, ''))) * 1.0 / max(length(?), 1)`,
    );
    params.push(term, term);
  }
  const kbFilter = buildKbFilter(opts?.kbIds, params);
  params.push(limit);
  const scoreExpr = scoreParts.length === 1 ? scoreParts[0] : `(${scoreParts.join(' + ')})`;

  return engine.queryAll<KnowledgeFTSResult>(
    `SELECT c.id AS chunkId, c.document_id AS documentId,
            c.content,
            ${scoreExpr} / (2.0 + length(c.content) * 0.001) AS score
     FROM ${CHUNKS_TABLE} c
     ${opts?.kbIds?.length ? `JOIN knowledge_documents d ON d.id = c.document_id` : ''}
     WHERE (${whereParts.join(' AND ')})
     ${kbFilter}
     ORDER BY score DESC
     LIMIT ?`,
    params,
  );
}

// ---------------------------------------------------------------------------
// PostgreSQL tsvector + GIN implementation
// ---------------------------------------------------------------------------
export class PGKnowledgeSearchEngine implements KnowledgeSearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    try {
      await engine.exec(
        `ALTER TABLE ${CHUNKS_TABLE} ADD COLUMN IF NOT EXISTS search_vector tsvector`,
      );
    } catch {
      /* column already exists */
    }
    try {
      await engine.exec(
        `CREATE INDEX IF NOT EXISTS idx_kb_chunks_search ON ${CHUNKS_TABLE} USING GIN(search_vector)`,
      );
    } catch {
      /* index already exists */
    }
  }

  async indexChunks(
    engine: DbEngine,
    chunks: KnowledgeChunkRecord[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    const cfg = getPgFtsConfig();
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      await Promise.all(
        batch.map((c) =>
          engine.run(
            `UPDATE ${CHUNKS_TABLE} SET search_vector = to_tsvector('${cfg}', ?) WHERE id = ?`,
            [c.content, c.id],
          ),
        ),
      );
    }
  }

  async deleteByDocumentId(
    _engine: DbEngine,
    _documentId: string,
  ): Promise<void> {
    // PG rows are deleted with the chunk; tsvector column goes with it
  }

  async search(
    engine: DbEngine,
    query: string,
    opts?: KnowledgeFTSSearchOpts,
  ): Promise<KnowledgeFTSResult[]> {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const cfg = getPgFtsConfig();
    const limit = Math.max(1, Math.min(opts?.limit ?? 15, 50));
    const kbJoin = opts?.kbIds?.length ? `JOIN knowledge_documents d ON d.id = c.document_id` : '';
    const isCJK = containsCJK(normalized);

    // Phase 1: AND (plainto_tsquery — all terms must match)
    const params1: unknown[] = [normalized, normalized];
    const kbFilter1 = buildKbFilter(opts?.kbIds, params1);
    params1.push(limit);
    const andResults = await engine.queryAll<KnowledgeFTSResult>(
      `SELECT c.id AS "chunkId", c.document_id AS "documentId",
              c.content,
              ts_rank(c.search_vector, plainto_tsquery('${cfg}', ?)) AS score
       FROM ${CHUNKS_TABLE} c ${kbJoin}
       WHERE c.search_vector @@ plainto_tsquery('${cfg}', ?)
       ${kbFilter1}
       ORDER BY score DESC
       LIMIT ?`,
      params1,
    );

    const segments = removeStopWords(normalized.split(/\s+/).filter(Boolean));
    if (andResults.length >= Math.ceil(limit / 2) || segments.length <= 1) {
      return andResults;
    }

    // Phase 2: OR fallback (stop words removed for relevance)
    const orExpr = segments.map(() => `plainto_tsquery('${cfg}', ?)`).join(' || ');
    const params2: unknown[] = [...segments, ...segments];
    const kbFilter2 = buildKbFilter(opts?.kbIds, params2);
    params2.push(limit);
    const orResults = await engine.queryAll<KnowledgeFTSResult>(
      `SELECT c.id AS "chunkId", c.document_id AS "documentId",
              c.content,
              ts_rank(c.search_vector, ${orExpr}) AS score
       FROM ${CHUNKS_TABLE} c ${kbJoin}
       WHERE c.search_vector @@ (${orExpr})
       ${kbFilter2}
       ORDER BY score DESC
       LIMIT ?`,
      params2,
    );

    const seen = new Set(andResults.map((r) => r.chunkId));
    const merged = [...andResults];
    for (const r of orResults) {
      if (!seen.has(r.chunkId)) { merged.push(r); seen.add(r.chunkId); }
    }
    const ftsTotal = merged.length;

    // Phase 3: LIKE fallback for CJK + simple config when FTS results are insufficient.
    // simple config tokenizes CJK unreliably; LIKE does exact substring matching.
    if (cfg === 'simple' && isCJK && ftsTotal < Math.ceil(limit / 2)) {
      const likeResults = await likeBasedCJKSearch(engine, query, opts, 'postgres');
      for (const r of likeResults) {
        if (!seen.has(r.chunkId)) { merged.push(r); seen.add(r.chunkId); }
      }
    }

    return merged.slice(0, limit);
  }

  async reindexAll(engine: DbEngine): Promise<number> {
    const cfg = getPgFtsConfig();
    const result = await engine.run(
      `UPDATE ${CHUNKS_TABLE} SET search_vector = to_tsvector('${cfg}', content)`,
      [],
    );
    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
let cachedEngine: KnowledgeSearchEngine | null = null;
let cachedDialect: string | null = null;

export function createKnowledgeSearchEngine(
  dialect: 'sqlite' | 'mysql' | 'postgres',
): KnowledgeSearchEngine {
  if (cachedEngine && cachedDialect === dialect) return cachedEngine;
  if (dialect === 'mysql') cachedEngine = new MySQLKnowledgeSearchEngine();
  else if (dialect === 'postgres')
    cachedEngine = new PGKnowledgeSearchEngine();
  else cachedEngine = new SQLiteKnowledgeSearchEngine();
  cachedDialect = dialect;
  return cachedEngine;
}

export function getKnowledgeSearchEngine(): KnowledgeSearchEngine {
  if (!cachedEngine) {
    throw new Error(
      'Knowledge search engine not initialized. Call createKnowledgeSearchEngine() first.',
    );
  }
  return cachedEngine;
}
