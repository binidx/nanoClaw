import type { Dialect } from './engine.js';

/**
 * Generates an UPSERT statement compatible with the active dialect.
 *
 * SQLite:    INSERT INTO ... ON CONFLICT(key) DO UPDATE SET col = excluded.col
 * MySQL:     INSERT INTO ... ON DUPLICATE KEY UPDATE col = VALUES(col)
 * Postgres:  INSERT INTO ... ON CONFLICT(key) DO UPDATE SET col = EXCLUDED.col
 */
export function upsertSql(
  dialect: Dialect,
  table: string,
  columns: string[],
  conflictKey: string | string[],
  updateColumns: string[],
): string {
  const colList = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  if (dialect === 'mysql') {
    const updates = updateColumns
      .map((c) => `${c} = VALUES(${c})`)
      .join(', ');
    return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  }

  // SQLite and Postgres share ON CONFLICT ... EXCLUDED syntax
  const keys = Array.isArray(conflictKey) ? conflictKey.join(', ') : conflictKey;
  const updates = updateColumns
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT(${keys}) DO UPDATE SET ${updates}`;
}

/**
 * Generates an INSERT-or-REPLACE statement.
 *
 * SQLite:    INSERT OR REPLACE INTO ...
 * MySQL:     REPLACE INTO ...
 * Postgres:  No native REPLACE; uses full UPSERT on all columns.
 *            Caller must supply conflictKey for PG path.
 */
export function replaceSql(
  dialect: Dialect,
  table: string,
  columns: string[],
  conflictKey?: string | string[],
): string {
  const colList = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  if (dialect === 'mysql') {
    return `REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`;
  }

  if (dialect === 'postgres') {
    const keys = conflictKey
      ? Array.isArray(conflictKey) ? conflictKey.join(', ') : conflictKey
      : columns[0]!;
    const updateCols = columns.filter(
      (c) => !(Array.isArray(conflictKey) ? conflictKey : [conflictKey || columns[0]]).includes(c),
    );
    if (updateCols.length === 0) {
      return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT(${keys}) DO NOTHING`;
    }
    const updates = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT(${keys}) DO UPDATE SET ${updates}`;
  }

  return `INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`;
}

/**
 * Generates an INSERT-IGNORE statement.
 *
 * SQLite:    INSERT OR IGNORE INTO ...
 * MySQL:     INSERT IGNORE INTO ...
 * Postgres:  INSERT INTO ... ON CONFLICT DO NOTHING
 */
export function insertIgnoreSql(
  dialect: Dialect,
  table: string,
  columns: string[],
): string {
  const colList = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  if (dialect === 'mysql') {
    return `INSERT IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`;
  }
  if (dialect === 'postgres') {
    return `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  }
  return `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`;
}

/**
 * SQL fragment for extracting a value from a JSON column.
 *
 * SQLite:    json_extract(col, '$.path')
 * MySQL:     JSON_UNQUOTE(JSON_EXTRACT(col, '$.path'))
 * Postgres:  col::jsonb->>'key'  (for simple top-level keys)
 */
export function jsonExtract(
  dialect: Dialect,
  column: string,
  path: string,
): string {
  if (dialect === 'mysql') {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, '${path}'))`;
  }
  if (dialect === 'postgres') {
    const stripped = path.replace(/^\$\./, '');
    const segments = stripped.split('.');
    if (segments.length === 1) {
      return `${column}::jsonb->>'${segments[0]}'`;
    }
    const pgPath = segments.join(',');
    return `${column}::jsonb #>> '{${pgPath}}'`;
  }
  return `json_extract(${column}, '${path}')`;
}

/**
 * SQL fragment for concatenating strings.
 *
 * SQLite:    a || ' ' || b
 * MySQL:     CONCAT(a, ' ', b)
 * Postgres:  a || ' ' || b  (same as SQLite)
 */
export function concatSql(dialect: Dialect, ...parts: string[]): string {
  if (dialect === 'mysql') {
    return `CONCAT(${parts.join(', ')})`;
  }
  // SQLite and Postgres both use ||
  return parts.join(' || ');
}

/**
 * Returns a dialect-safe LIKE ... ESCAPE fragment.
 *
 * MySQL/TiDB treats `\'` inside SQL string literals as an escaped quote, so
 * the backslash escape character must be emitted as `'\\\\'` in SQL text.
 * SQLite/Postgres accept the simpler `'\\'`.
 */
export function likeEscapeSql(dialect: Dialect): string {
  return dialect === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'";
}

/**
 * Builds a dialect-safe `column LIKE pattern ESCAPE ...` fragment.
 */
export function buildLikeContainsSql(
  dialect: Dialect,
  columnExpr: string,
  patternExpr = '?',
): string {
  return `${columnExpr} LIKE ${patternExpr} ${likeEscapeSql(dialect)}`;
}

/**
 * Returns a deterministic tiebreaker expression for ORDER BY.
 * SQLite supports implicit rowid; MySQL and Postgres need an explicit column.
 *
 * @param fallbackColumn - explicit column to use when rowid is unavailable
 */
export function rowIdOrder(
  dialect: Dialect,
  tableAlias: string,
  fallbackColumn: string,
  direction: 'ASC' | 'DESC' = 'DESC',
): string {
  if (dialect === 'mysql' || dialect === 'postgres') {
    return `${tableAlias}.${fallbackColumn} ${direction}`;
  }
  return `${tableAlias}.rowid ${direction}`;
}

/**
 * Returns the AUTO_INCREMENT / AUTOINCREMENT / SERIAL column type for a primary key.
 */
export function autoIncrementPk(dialect: Dialect): string {
  if (dialect === 'mysql') {
    return 'INT AUTO_INCREMENT PRIMARY KEY';
  }
  if (dialect === 'postgres') {
    return 'SERIAL PRIMARY KEY';
  }
  return 'INTEGER PRIMARY KEY AUTOINCREMENT';
}

/**
 * Returns a TEXT type definition. MySQL uses TEXT (max 65535 chars)
 * which is equivalent to SQLite TEXT for most practical purposes.
 * Postgres also uses TEXT with no size limit.
 */
export function textType(_dialect: Dialect): string {
  return 'TEXT';
}

/**
 * Generates placeholder list for IN clause: (?, ?, ?)
 */
export function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
