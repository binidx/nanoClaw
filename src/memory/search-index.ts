import Database from 'better-sqlite3';

const DOCUMENTS_TABLE = 'memory_search_documents';
const FTS_TABLE = 'memory_search_documents_fts';

export interface MemorySearchIndexDocument {
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

export interface MemorySearchIndexSearchOptions {
  limit?: number;
  scopes?: string[];
  ownerType?: string;
  ownerId?: string;
  sourceBoosts?: Record<string, number>;
  sourceTypeFilter?: string[];
  now?: Date;
  recencyHalfLifeDays?: number;
}

export interface MemorySearchIndexResult {
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
  score: number;
  textScore: number;
  sourceBoost: number;
  recencyBoost: number;
  exactMatchBoost: number;
}

interface MemorySearchIndexCandidateRow {
  doc_id: string;
  scope: string;
  owner_type: string;
  owner_id: string;
  path_ref: string | null;
  source_type: string;
  title: string | null;
  body: string;
  metadata_json: string | null;
  updated_at: string;
  bm25_score: number;
}

interface MemorySearchIndexFallbackRow {
  doc_id: string;
  scope: string;
  owner_type: string;
  owner_id: string;
  path_ref: string | null;
  source_type: string;
  title: string | null;
  body: string;
  metadata_json: string | null;
  updated_at: string;
}

const DEFAULT_SOURCE_BOOSTS: Record<string, number> = {
  identity_memory: 1.25,
  user_memory: 1.18,
  memory_file: 1,
  compaction_summary: 0.8,
};

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function containsCjk(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    value,
  );
}

function extractQueryTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const matches = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  const unique = new Set<string>();
  for (const token of matches) {
    if (token.length === 0) continue;
    unique.add(token);
  }
  if (unique.size === 0 && normalized) {
    unique.add(normalized);
  }
  return [...unique];
}

function escapeFtsTerm(value: string): string {
  return value.replace(/"/g, '""');
}

function buildMatchQuery(query: string): string {
  const normalized = normalizeSearchText(query);
  const tokens = extractQueryTokens(query);
  const terms = new Set<string>();

  if (normalized) {
    terms.add(`"${escapeFtsTerm(normalized)}"`);
  }
  for (const token of tokens) {
    terms.add(`"${escapeFtsTerm(token)}"*`);
  }
  if (terms.size === 0) {
    return '""';
  }
  return [...terms].join(' OR ');
}

function textScoreFromBm25(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return 1 / (1 + Math.abs(value));
}

function calculateTokenCoverageScore(
  combinedText: string,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) return 0;
  const matchedCount = queryTokens.filter((token) =>
    combinedText.includes(token),
  ).length;
  return matchedCount / queryTokens.length;
}

function calculateExactMatchBoost(
  title: string,
  body: string,
  normalizedQuery: string,
): number {
  if (!normalizedQuery) return 0;
  if (normalizeSearchText(title).includes(normalizedQuery)) return 0.25;
  if (normalizeSearchText(body).includes(normalizedQuery)) return 0.1;
  return 0;
}

function calculateRecencyBoost(
  updatedAt: string,
  now: Date,
  halfLifeDays: number,
): number {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageMs = Math.max(0, now.getTime() - parsed);
  const halfLifeMs = Math.max(1, halfLifeDays) * 24 * 60 * 60 * 1000;
  const normalized = Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
  return normalized * 0.15;
}

function shouldUseSubstringFallback(
  normalizedQuery: string,
  queryTokens: string[],
): boolean {
  if (!normalizedQuery) return false;
  if (containsCjk(normalizedQuery)) return true;
  return queryTokens.length <= 1;
}

function buildCandidateFilterSql(
  options: MemorySearchIndexSearchOptions,
  params: Array<string | number>,
): string {
  const clauses: string[] = [];

  if (options.scopes && options.scopes.length > 0) {
    clauses.push(
      `d.scope IN (${options.scopes.map(() => '?').join(', ')})`,
    );
    params.push(...options.scopes);
  }
  if (options.ownerType) {
    clauses.push('d.owner_type = ?');
    params.push(options.ownerType);
  }
  if (options.ownerId) {
    clauses.push('d.owner_id = ?');
    params.push(options.ownerId);
  }
  if (options.sourceTypeFilter && options.sourceTypeFilter.length > 0) {
    clauses.push(
      `d.source_type IN (${options.sourceTypeFilter.map(() => '?').join(', ')})`,
    );
    params.push(...options.sourceTypeFilter);
  }

  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

export function initializeMemorySearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DOCUMENTS_TABLE} (
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

export function clearMemorySearchIndex(db: Database.Database): void {
  db.prepare(`DELETE FROM ${DOCUMENTS_TABLE}`).run();
  db.prepare(`DELETE FROM ${FTS_TABLE}`).run();
}

export function upsertMemorySearchIndexDocuments(
  db: Database.Database,
  documents: MemorySearchIndexDocument[],
): void {
  if (documents.length === 0) return;
  initializeMemorySearchIndex(db);

  const upsertDocument = db.prepare(`
    INSERT INTO ${DOCUMENTS_TABLE} (
      doc_id, scope, owner_type, owner_id, path_ref, source_type, title, body, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      scope = excluded.scope,
      owner_type = excluded.owner_type,
      owner_id = excluded.owner_id,
      path_ref = excluded.path_ref,
      source_type = excluded.source_type,
      title = excluded.title,
      body = excluded.body,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `);
  const deleteFts = db.prepare(`DELETE FROM ${FTS_TABLE} WHERE doc_id = ?`);
  const insertFts = db.prepare(`
    INSERT INTO ${FTS_TABLE} (
      doc_id, scope, owner_type, owner_id, path_ref, source_type, title, body, metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((items: MemorySearchIndexDocument[]) => {
    for (const item of items) {
      const title = normalizeWhitespace(item.title || '');
      const body = normalizeWhitespace(item.body);
      const updatedAt =
        normalizeWhitespace(item.updatedAt || '') || new Date().toISOString();
      upsertDocument.run(
        item.docId,
        item.scope,
        item.ownerType,
        item.ownerId,
        item.pathRef || null,
        item.sourceType,
        title || null,
        body,
        item.metadataJson || null,
        updatedAt,
      );
      deleteFts.run(item.docId);
      insertFts.run(
        item.docId,
        item.scope,
        item.ownerType,
        item.ownerId,
        item.pathRef || null,
        item.sourceType,
        title,
        body,
        item.metadataJson || null,
        updatedAt,
      );
    }
  });

  tx(documents);
}

export function deleteMemorySearchIndexDocuments(
  db: Database.Database,
  docIds: string[],
): void {
  if (docIds.length === 0) return;
  initializeMemorySearchIndex(db);
  const deleteDocument = db.prepare(
    `DELETE FROM ${DOCUMENTS_TABLE} WHERE doc_id = ?`,
  );
  const deleteFts = db.prepare(`DELETE FROM ${FTS_TABLE} WHERE doc_id = ?`);
  const tx = db.transaction((items: string[]) => {
    for (const docId of items) {
      deleteDocument.run(docId);
      deleteFts.run(docId);
    }
  });
  tx(docIds);
}

export function searchMemorySearchIndex(
  db: Database.Database,
  query: string,
  options: MemorySearchIndexSearchOptions = {},
): MemorySearchIndexResult[] {
  initializeMemorySearchIndex(db);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const limit = Math.max(1, Math.min(options.limit ?? 8, 50));
  const queryTokens = extractQueryTokens(normalizedQuery);
  const matchQuery = buildMatchQuery(normalizedQuery);
  const params: Array<string | number> = [matchQuery];
  const filterSql = buildCandidateFilterSql(options, params);
  params.push(limit * 5);

  const rows = db
    .prepare(
      `
        SELECT
          d.doc_id,
          d.scope,
          d.owner_type,
          d.owner_id,
          d.path_ref,
          d.source_type,
          d.title,
          d.body,
          d.metadata_json,
          d.updated_at,
          bm25(${FTS_TABLE}, 8.0, 1.2) AS bm25_score
        FROM ${FTS_TABLE} f
        JOIN ${DOCUMENTS_TABLE} d ON d.doc_id = f.doc_id
        WHERE ${FTS_TABLE} MATCH ?
        ${filterSql}
        ORDER BY bm25_score ASC, d.updated_at DESC, d.doc_id ASC
        LIMIT ?
      `,
    )
    .all(...params) as MemorySearchIndexCandidateRow[];

  const now = options.now || new Date();
  const halfLifeDays = options.recencyHalfLifeDays ?? 30;
  const sourceBoosts = {
    ...DEFAULT_SOURCE_BOOSTS,
    ...(options.sourceBoosts || {}),
  };

  const scoreRow = (
    row: MemorySearchIndexCandidateRow | MemorySearchIndexFallbackRow,
    mode: 'fts' | 'substring',
  ): MemorySearchIndexResult => {
    const title = normalizeWhitespace(row.title || '');
    const body = normalizeWhitespace(row.body);
    const combinedText = `${normalizeSearchText(title)} ${normalizeSearchText(body)}`;
    const sourceBoost = sourceBoosts[row.source_type] ?? 1;
    const exactMatchBoost = calculateExactMatchBoost(
      title,
      body,
      normalizedQuery,
    );
    const recencyBoost = calculateRecencyBoost(
      row.updated_at,
      now,
      halfLifeDays,
    );
    const baseTextScore =
      mode === 'fts'
        ? textScoreFromBm25((row as MemorySearchIndexCandidateRow).bm25_score)
        : 0.42;
    const textScore =
      baseTextScore + calculateTokenCoverageScore(combinedText, queryTokens) * 0.3;
    const score = textScore * sourceBoost + exactMatchBoost + recencyBoost;

    return {
      docId: row.doc_id,
      scope: row.scope,
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      pathRef: row.path_ref,
      sourceType: row.source_type,
      title,
      body,
      metadataJson: row.metadata_json,
      updatedAt: row.updated_at,
      score,
      textScore,
      sourceBoost,
      recencyBoost,
      exactMatchBoost,
    };
  };

  const ranked = rows.map((row) => scoreRow(row, 'fts'));
  if (
    ranked.length < limit &&
    shouldUseSubstringFallback(normalizedQuery, queryTokens)
  ) {
    const fallbackFilterParams: Array<string | number> = [];
    const fallbackFilterSql = buildCandidateFilterSql(
      options,
      fallbackFilterParams,
    );
    const fallbackParams: Array<string | number> = [
      normalizedQuery,
      normalizedQuery,
      ...fallbackFilterParams,
      limit * 5,
    ];
    const fallbackRows = db
      .prepare(
        `
          SELECT
            d.doc_id,
            d.scope,
            d.owner_type,
            d.owner_id,
            d.path_ref,
            d.source_type,
            d.title,
            d.body,
            d.metadata_json,
            d.updated_at
          FROM ${DOCUMENTS_TABLE} d
          WHERE (
            instr(lower(coalesce(d.title, '')), ?) > 0 OR
            instr(lower(d.body), ?) > 0
          )
          ${fallbackFilterSql}
          ORDER BY d.updated_at DESC, d.doc_id ASC
          LIMIT ?
        `,
      )
      .all(...fallbackParams) as MemorySearchIndexFallbackRow[];

    const seen = new Set(ranked.map((row) => row.docId));
    for (const row of fallbackRows) {
      if (seen.has(row.doc_id)) continue;
      seen.add(row.doc_id);
      ranked.push(scoreRow(row, 'substring'));
    }
  }

  return ranked
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.exactMatchBoost !== a.exactMatchBoost) {
        return b.exactMatchBoost - a.exactMatchBoost;
      }
      if (a.updatedAt !== b.updatedAt) {
        return b.updatedAt.localeCompare(a.updatedAt);
      }
      return a.docId.localeCompare(b.docId);
    })
    .slice(0, limit);
}
