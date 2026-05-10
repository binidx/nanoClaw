import type { DbEngine } from './engine.js';
import { getPgFtsConfig } from './pg-fts-config.js';
import { isMySqlFullTextUnsupportedError } from './mysql-fulltext.js';

export interface SearchDoc {
  docId: string;
  scope: string;
  ownerType: string;
  ownerId: string;
  pathRef?: string | null;
  sourceType: string;
  title?: string | null;
  body: string;
  metadataJson?: string | null;
  updatedAt?: string;
}

export interface SearchOpts {
  limit?: number;
  scopes?: string[];
  ownerType?: string;
  ownerId?: string;
  sourceTypeFilter?: string[];
}

export interface SearchResult {
  docId: string;
  scope: string;
  ownerType: string;
  ownerId: string;
  pathRef: string | null;
  sourceType: string;
  title: string;
  body: string;
  metadataJson: string | null;
  updatedAt: string;
  bm25Score: number;
}

export interface SearchEngine {
  initialize(engine: DbEngine): Promise<void>;
  upsertDocuments(engine: DbEngine, docs: SearchDoc[]): Promise<void>;
  deleteDocuments(engine: DbEngine, docIds: string[]): Promise<void>;
  search(engine: DbEngine, query: string, opts: SearchOpts): Promise<SearchResult[]>;
  clear(engine: DbEngine): Promise<void>;
}

const DOCS_TABLE = 'memory_search_documents';
const FTS_TABLE = 'memory_search_documents_fts';

export class SQLiteSearchEngine implements SearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    await engine.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        doc_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        path_ref TEXT,
        source_type TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        doc_id UNINDEXED,
        scope UNINDEXED,
        owner_type UNINDEXED,
        owner_id UNINDEXED,
        path_ref UNINDEXED,
        source_type UNINDEXED,
        title,
        body,
        metadata_json UNINDEXED,
        updated_at UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  async upsertDocuments(engine: DbEngine, docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.initialize(engine);

    await engine.transaction(async (tx) => {
      for (const doc of docs) {
        const title = normalize(doc.title || '');
        const body = normalize(doc.body);
        const updatedAt = normalize(doc.updatedAt || '') || new Date().toISOString();

        await tx.run(
          `INSERT INTO ${DOCS_TABLE} (doc_id,scope,owner_type,owner_id,path_ref,source_type,title,body,metadata_json,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(doc_id) DO UPDATE SET
             scope=excluded.scope, owner_type=excluded.owner_type, owner_id=excluded.owner_id,
             path_ref=excluded.path_ref, source_type=excluded.source_type, title=excluded.title,
             body=excluded.body, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`,
          [doc.docId, doc.scope, doc.ownerType, doc.ownerId, doc.pathRef || null,
           doc.sourceType, title || null, body, doc.metadataJson || null, updatedAt],
        );

        await tx.run(`DELETE FROM ${FTS_TABLE} WHERE doc_id = ?`, [doc.docId]);
        await tx.run(
          `INSERT INTO ${FTS_TABLE} (doc_id,scope,owner_type,owner_id,path_ref,source_type,title,body,metadata_json,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [doc.docId, doc.scope, doc.ownerType, doc.ownerId, doc.pathRef || null,
           doc.sourceType, title, body, doc.metadataJson || null, updatedAt],
        );
      }
    });
  }

  async deleteDocuments(engine: DbEngine, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;
    await this.initialize(engine);

    await engine.transaction(async (tx) => {
      for (const id of docIds) {
        await tx.run(`DELETE FROM ${DOCS_TABLE} WHERE doc_id = ?`, [id]);
        await tx.run(`DELETE FROM ${FTS_TABLE} WHERE doc_id = ?`, [id]);
      }
    });
  }

  async search(engine: DbEngine, query: string, opts: SearchOpts): Promise<SearchResult[]> {
    await this.initialize(engine);
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
    const matchQuery = buildMatch(normalized);
    const params: unknown[] = [matchQuery];
    const filterSql = buildFilter(opts, params);
    params.push(limit * 5);

    return engine.queryAll<SearchResult>(
      `SELECT d.doc_id as docId, d.scope, d.owner_type as ownerType, d.owner_id as ownerId,
              d.path_ref as pathRef, d.source_type as sourceType, d.title, d.body,
              d.metadata_json as metadataJson, d.updated_at as updatedAt,
              bm25(${FTS_TABLE}, 8.0, 1.2) AS bm25Score
       FROM ${FTS_TABLE} f
       JOIN ${DOCS_TABLE} d ON d.doc_id = f.doc_id
       WHERE ${FTS_TABLE} MATCH ?
       ${filterSql}
       ORDER BY bm25Score ASC, d.updated_at DESC, d.doc_id ASC
       LIMIT ?`,
      params,
    );
  }

  async clear(engine: DbEngine): Promise<void> {
    await engine.run(`DELETE FROM ${DOCS_TABLE}`);
    await engine.run(`DELETE FROM ${FTS_TABLE}`);
  }
}

export class MySQLSearchEngine implements SearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    await engine.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        doc_id VARCHAR(255) PRIMARY KEY,
        scope VARCHAR(255) NOT NULL,
        owner_type VARCHAR(128) NOT NULL,
        owner_id VARCHAR(255) NOT NULL,
        path_ref VARCHAR(1024),
        source_type VARCHAR(128) NOT NULL,
        title TEXT,
        body MEDIUMTEXT NOT NULL,
        metadata_json TEXT,
        updated_at VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await engine.exec(`ALTER TABLE ${DOCS_TABLE} ADD FULLTEXT INDEX ft_search (title, body)`);
    } catch (err) {
      if (!isMySqlFullTextUnsupportedError(err)) {
        const message = String((err as Error)?.message ?? '');
        if (!/duplicate|exists/i.test(message)) throw err;
      }
    }
  }

  async upsertDocuments(engine: DbEngine, docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.initialize(engine);

    await engine.transaction(async (tx) => {
      for (const doc of docs) {
        const title = normalize(doc.title || '');
        const body = normalize(doc.body);
        const updatedAt = normalize(doc.updatedAt || '') || new Date().toISOString();

        await tx.run(
          `INSERT INTO ${DOCS_TABLE} (doc_id,scope,owner_type,owner_id,path_ref,source_type,title,body,metadata_json,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             scope=VALUES(scope), owner_type=VALUES(owner_type), owner_id=VALUES(owner_id),
             path_ref=VALUES(path_ref), source_type=VALUES(source_type), title=VALUES(title),
             body=VALUES(body), metadata_json=VALUES(metadata_json), updated_at=VALUES(updated_at)`,
          [doc.docId, doc.scope, doc.ownerType, doc.ownerId, doc.pathRef || null,
           doc.sourceType, title || null, body, doc.metadataJson || null, updatedAt],
        );
      }
    });
  }

  async deleteDocuments(engine: DbEngine, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;

    await engine.transaction(async (tx) => {
      for (const id of docIds) {
        await tx.run(`DELETE FROM ${DOCS_TABLE} WHERE doc_id = ?`, [id]);
      }
    });
  }

  async search(engine: DbEngine, query: string, opts: SearchOpts): Promise<SearchResult[]> {
    await this.initialize(engine);
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
    const params: unknown[] = [normalized, normalized];
    const filterSql = buildFilter(opts, params);
    params.push(limit * 5);

    try {
      return await engine.queryAll<SearchResult>(
        `SELECT d.doc_id as docId, d.scope, d.owner_type as ownerType, d.owner_id as ownerId,
                d.path_ref as pathRef, d.source_type as sourceType, d.title, d.body,
                d.metadata_json as metadataJson, d.updated_at as updatedAt,
                MATCH(d.title, d.body) AGAINST(? IN BOOLEAN MODE) AS bm25Score
         FROM ${DOCS_TABLE} d
         WHERE MATCH(d.title, d.body) AGAINST(? IN BOOLEAN MODE)
         ${filterSql}
         ORDER BY bm25Score DESC, d.updated_at DESC, d.doc_id ASC
         LIMIT ?`,
        params,
      );
    } catch (err) {
      if (!isMySqlFullTextUnsupportedError(err)) throw err;
    }

    return searchMySqlByLike(engine, normalized, opts, limit);
  }

  async clear(engine: DbEngine): Promise<void> {
    await engine.run(`DELETE FROM ${DOCS_TABLE}`);
  }
}

export class PGSearchEngine implements SearchEngine {
  async initialize(engine: DbEngine): Promise<void> {
    await engine.exec(`
      CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        doc_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        path_ref TEXT,
        source_type TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL,
        metadata_json TEXT,
        updated_at TEXT NOT NULL,
        search_vector tsvector
      )
    `);
    try {
      await engine.exec(
        `CREATE INDEX IF NOT EXISTS idx_msd_search ON ${DOCS_TABLE} USING GIN(search_vector)`,
      );
    } catch {
      /* index already exists */
    }
  }

  async upsertDocuments(engine: DbEngine, docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.initialize(engine);

    await engine.transaction(async (tx) => {
      for (const doc of docs) {
        const title = normalize(doc.title || '');
        const body = normalize(doc.body);
        const updatedAt =
          normalize(doc.updatedAt || '') || new Date().toISOString();
        const searchVector = [title, body].filter(Boolean).join(' ');

        const cfg = getPgFtsConfig();
        await tx.run(
          `INSERT INTO ${DOCS_TABLE} (doc_id,scope,owner_type,owner_id,path_ref,source_type,title,body,metadata_json,updated_at,search_vector)
           VALUES (?,?,?,?,?,?,?,?,?,?,to_tsvector('${cfg}',?))
           ON CONFLICT(doc_id) DO UPDATE SET
             scope=EXCLUDED.scope, owner_type=EXCLUDED.owner_type, owner_id=EXCLUDED.owner_id,
             path_ref=EXCLUDED.path_ref, source_type=EXCLUDED.source_type, title=EXCLUDED.title,
             body=EXCLUDED.body, metadata_json=EXCLUDED.metadata_json, updated_at=EXCLUDED.updated_at,
             search_vector=to_tsvector('${cfg}',EXCLUDED.title || ' ' || EXCLUDED.body)`,
          [
            doc.docId,
            doc.scope,
            doc.ownerType,
            doc.ownerId,
            doc.pathRef || null,
            doc.sourceType,
            title || null,
            body,
            doc.metadataJson || null,
            updatedAt,
            searchVector,
          ],
        );
      }
    });
  }

  async deleteDocuments(engine: DbEngine, docIds: string[]): Promise<void> {
    if (docIds.length === 0) return;

    await engine.transaction(async (tx) => {
      for (const id of docIds) {
        await tx.run(`DELETE FROM ${DOCS_TABLE} WHERE doc_id = ?`, [id]);
      }
    });
  }

  async search(
    engine: DbEngine,
    query: string,
    opts: SearchOpts,
  ): Promise<SearchResult[]> {
    await this.initialize(engine);
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 8, 50));
    const cfg = getPgFtsConfig();
    const params: unknown[] = [normalized, normalized];
    const filterSql = buildFilter(opts, params);
    params.push(limit * 5);

    return engine.queryAll<SearchResult>(
      `SELECT doc_id as "docId", scope, owner_type as "ownerType", owner_id as "ownerId",
              path_ref as "pathRef", source_type as "sourceType", title, body,
              metadata_json as "metadataJson", updated_at as "updatedAt",
              ts_rank(search_vector, plainto_tsquery('${cfg}', ?)) AS "bm25Score"
       FROM ${DOCS_TABLE} d
       WHERE search_vector @@ plainto_tsquery('${cfg}', ?)
       ${filterSql}
       ORDER BY "bm25Score" DESC, updated_at DESC, doc_id ASC
       LIMIT ?`,
      params,
    );
  }

  async clear(engine: DbEngine): Promise<void> {
    await engine.run(`DELETE FROM ${DOCS_TABLE}`);
  }
}

export function createSearchEngine(
  dialect: 'sqlite' | 'mysql' | 'postgres',
): SearchEngine {
  if (dialect === 'mysql') return new MySQLSearchEngine();
  if (dialect === 'postgres') return new PGSearchEngine();
  return new SQLiteSearchEngine();
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeSearch(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function buildMatch(q: string): string {
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}

function buildFilter(opts: SearchOpts, params: unknown[]): string {
  const clauses: string[] = [];
  if (opts.scopes && opts.scopes.length > 0) {
    clauses.push(`d.scope IN (${opts.scopes.map(() => '?').join(', ')})`);
    params.push(...opts.scopes);
  }
  if (opts.ownerType) {
    clauses.push('d.owner_type = ?');
    params.push(opts.ownerType);
  }
  if (opts.ownerId) {
    clauses.push('d.owner_id = ?');
    params.push(opts.ownerId);
  }
  if (opts.sourceTypeFilter && opts.sourceTypeFilter.length > 0) {
    clauses.push(
      `d.source_type IN (${opts.sourceTypeFilter.map(() => '?').join(', ')})`,
    );
    params.push(...opts.sourceTypeFilter);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

async function searchMySqlByLike(
  engine: DbEngine,
  normalized: string,
  opts: SearchOpts,
  limit: number,
): Promise<SearchResult[]> {
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const params: unknown[] = [];
  const matchClauses = terms.map(() => '(d.title LIKE ? OR d.body LIKE ?)');
  for (const term of terms) {
    const like = `%${term}%`;
    params.push(like, like);
  }

  const filterSql = buildFilter(opts, params);
  params.push(limit * 5);

  return engine.queryAll<SearchResult>(
    `SELECT d.doc_id as docId, d.scope, d.owner_type as ownerType, d.owner_id as ownerId,
            d.path_ref as pathRef, d.source_type as sourceType, d.title, d.body,
            d.metadata_json as metadataJson, d.updated_at as updatedAt,
            0 AS bm25Score
     FROM ${DOCS_TABLE} d
     WHERE ${matchClauses.join(' AND ')}
     ${filterSql}
     ORDER BY d.updated_at DESC, d.doc_id ASC
     LIMIT ?`,
    params,
  );
}
