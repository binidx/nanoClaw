import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import { readFile } from 'node:fs/promises';

import type { DbEngine, Dialect, RunResult } from './engine.js';
import { logger } from '../logger.js';
import {
  withDbQueryLogging,
  withDbTransactionLogging,
} from './database-logger.js';

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize?: number;
  ssl?: boolean;
  /**
   * When `ssl` is true: if omitted, uses legacy `rejectUnauthorized: false` and logs a deprecation warning.
   * Set explicitly to `true` for verified TLS (recommended with `sslCaPath` / server certs).
   */
  sslRejectUnauthorized?: boolean;
  /** PEM CA bundle file path; applied when `ssl` is true. */
  sslCaPath?: string;
}

/**
 * Convert `?` placeholders to PG-style `$1, $2, ...`.
 * Skips `?` inside single-quoted string literals.
 */
function convertPlaceholders(sql: string): string {
  let index = 0;
  let inQuote = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (ch === "'") {
      if (inQuote && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      inQuote = !inQuote;
      result += ch;
      continue;
    }

    if (ch === '?' && !inQuote) {
      result += `$${++index}`;
      continue;
    }

    result += ch;
  }

  return result;
}

function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (!inSingleQuote && ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      if (inSingleQuote && next === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
    }

    if (ch === ';' && !inSingleQuote) {
      const trimmed = current.trim();
      if (trimmed) stmts.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

export class PostgresEngine implements DbEngine {
  readonly dialect: Dialect = 'postgres';
  private pool: PgPool;

  private constructor(pool: PgPool) {
    this.pool = pool;
  }

  static async create(config: PostgresConfig): Promise<PostgresEngine> {
    let pg: typeof import('pg');
    try {
      pg = await import('pg');
    } catch {
      throw new Error(
        'pg is required when DB_ENGINE=postgres. Install it with: npm install pg',
      );
    }

    let ssl: PoolConfig['ssl'];
    if (config.ssl) {
      let rejectUnauthorized: boolean;
      if (config.sslRejectUnauthorized === undefined) {
        rejectUnauthorized = true;
        logger.info(
          'PostgreSQL SSL: using rejectUnauthorized=true (default). Set DB_PG_SSL_REJECT_UNAUTHORIZED=false to skip certificate verification (not recommended for production).',
        );
      } else {
        rejectUnauthorized = config.sslRejectUnauthorized;
        if (!rejectUnauthorized) {
          logger.warn(
            'PostgreSQL SSL: rejectUnauthorized=false — server certificate will NOT be verified. This is insecure for production use.',
          );
        }
      }
      ssl = { rejectUnauthorized };
      if (config.sslCaPath) {
        ssl.ca = await readFile(config.sslCaPath, 'utf8');
      }
    }

    const poolOpts: PoolConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: config.poolSize || 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl,
    };

    const pool = new pg.Pool(poolOpts);

    pool.on('error', (err: Error) => {
      logger.warn({ err }, 'PostgreSQL pool idle client error (connection will be recycled)');
    });

    return new PostgresEngine(pool);
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'queryAll',
        sql,
        params,
        summarizeResult: (rows: T[]) => ({ rowCount: rows.length }),
      },
      async () => {
        const result = await this.pool.query(convertPlaceholders(sql), params);
        return result.rows as T[];
      },
    );
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'queryOne',
        sql,
        params,
        summarizeResult: (row: T | undefined) => ({ found: row !== undefined }),
      },
      async () => {
        const result = await this.pool.query(convertPlaceholders(sql), params);
        return (result.rows as T[])[0] ?? undefined;
      },
    );
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'run',
        sql,
        params,
        summarizeResult: (result: RunResult) => ({
          changes: result.changes,
          lastInsertRowid: String(result.lastInsertRowid),
        }),
      },
      async () => {
        const converted = convertPlaceholders(sql);
        const returning = needsReturningId(converted);
        const finalSql = returning ? `${converted} RETURNING *` : converted;
        const result = await this.pool.query(finalSql, params);
        return {
          changes: result.rowCount ?? 0,
          lastInsertRowid: extractLastInsertId(result.rows?.[0]),
        };
      },
    );
  }

  async exec(sql: string): Promise<void> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'exec',
        sql,
      },
      async () => {
        const statements = splitStatements(sql);
        for (const stmt of statements) {
          await this.pool.query(stmt);
        }
      },
    );
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    return withDbTransactionLogging(this.dialect, async () => {
      const client = await this.pool.connect();
      await client.query('BEGIN');
      const txEngine = new PostgresTxEngine(client);
      try {
        const result = await fn(txEngine);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresTxEngine implements DbEngine {
  readonly dialect: Dialect = 'postgres';
  private client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'queryAll',
        sql,
        params,
        summarizeResult: (rows: T[]) => ({ rowCount: rows.length }),
      },
      async () => {
        const result = await this.client.query(convertPlaceholders(sql), params);
        return result.rows as T[];
      },
    );
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'queryOne',
        sql,
        params,
        summarizeResult: (row: T | undefined) => ({ found: row !== undefined }),
      },
      async () => {
        const result = await this.client.query(convertPlaceholders(sql), params);
        return (result.rows as T[])[0] ?? undefined;
      },
    );
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'run',
        sql,
        params,
        summarizeResult: (result: RunResult) => ({
          changes: result.changes,
          lastInsertRowid: String(result.lastInsertRowid),
        }),
      },
      async () => {
        const converted = convertPlaceholders(sql);
        const returning = needsReturningId(converted);
        const finalSql = returning ? `${converted} RETURNING *` : converted;
        const result = await this.client.query(finalSql, params);
        return {
          changes: result.rowCount ?? 0,
          lastInsertRowid: extractLastInsertId(result.rows?.[0]),
        };
      },
    );
  }

  async exec(sql: string): Promise<void> {
    return withDbQueryLogging(
      {
        dialect: this.dialect,
        operation: 'exec',
        sql,
      },
      async () => {
        const statements = splitStatements(sql);
        for (const stmt of statements) {
          await this.client.query(stmt);
        }
      },
    );
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    return withDbTransactionLogging(this.dialect, async () => {
      const sp = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await this.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn(this);
        await this.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    /* tx engine does not own the client */
  }
}

/**
 * Heuristic: append RETURNING for INSERT statements so
 * `lastInsertRowid` can be populated from the first PK column.
 * Only applies when there is no existing RETURNING clause.
 */
function needsReturningId(sql: string): boolean {
  const upper = sql.trimStart().toUpperCase();
  if (!upper.startsWith('INSERT')) return false;
  if (upper.includes('RETURNING')) return false;
  return true;
}

function extractLastInsertId(row: Record<string, unknown> | undefined): number | bigint {
  if (!row) return 0;
  if (row.id !== undefined) return row.id as number;
  if (row.event_id !== undefined) return row.event_id as number;
  const firstKey = Object.keys(row)[0];
  if (firstKey) {
    const val = row[firstKey];
    if (typeof val === 'number' || typeof val === 'bigint') return val;
  }
  return 0;
}
