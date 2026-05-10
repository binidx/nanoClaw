import type {
  Pool,
  PoolConnection,
  PoolOptions,
} from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';

import type { DbEngine, Dialect, RunResult } from './engine.js';

type SqlParams = (string | number | boolean | null | Buffer | bigint)[];

export interface MySQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize?: number;
}

export class MySQLEngine implements DbEngine {
  readonly dialect: Dialect = 'mysql';
  private pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: MySQLConfig): Promise<MySQLEngine> {
    let mysql: typeof import('mysql2/promise');
    try {
      mysql = await import('mysql2/promise');
    } catch {
      throw new Error(
        'mysql2 is required when DB_ENGINE=mysql. Install it with: npm install mysql2',
      );
    }

    const poolOpts: PoolOptions = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: config.poolSize || 20,
      charset: 'utf8mb4',
    };

    const pool = mysql.createPool(poolOpts);
    return new MySQLEngine(pool);
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const fixed = inlineLimitOffset(sql, params);
    const [rows] = await this.pool.execute(fixed.sql, fixed.params as SqlParams);
    return rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const fixed = inlineLimitOffset(sql, params);
    const [rows] = await this.pool.execute(fixed.sql, fixed.params as SqlParams);
    return (rows as T[])[0] ?? undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const fixed = inlineLimitOffset(sql, params);
    const [result] = await this.pool.execute(fixed.sql, fixed.params as SqlParams);
    const r = result as ResultSetHeader;
    return { changes: r.affectedRows, lastInsertRowid: r.insertId };
  }

  async exec(sql: string): Promise<void> {
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    await conn.beginTransaction();
    const txEngine = new MySQLTxEngine(conn);
    try {
      const result = await fn(txEngine);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MySQLTxEngine implements DbEngine {
  readonly dialect: Dialect = 'mysql';
  private conn: PoolConnection;

  constructor(conn: PoolConnection) {
    this.conn = conn;
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const fixed = inlineLimitOffset(sql, params);
    const [rows] = await this.conn.execute(fixed.sql, fixed.params as SqlParams);
    return rows as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const fixed = inlineLimitOffset(sql, params);
    const [rows] = await this.conn.execute(fixed.sql, fixed.params as SqlParams);
    return (rows as T[])[0] ?? undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const fixed = inlineLimitOffset(sql, params);
    const [result] = await this.conn.execute(fixed.sql, fixed.params as SqlParams);
    const r = result as ResultSetHeader;
    return { changes: r.affectedRows, lastInsertRowid: r.insertId };
  }

  async exec(sql: string): Promise<void> {
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await this.conn.query(stmt);
    }
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    const sp = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.conn.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(this);
      await this.conn.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await this.conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    /* tx engine does not own the connection */
  }
}

/**
 * TiDB does not support `?` placeholders inside LIMIT / OFFSET clauses of
 * prepared statements (ER_WRONG_ARGUMENTS 1210).  This helper detects trailing
 * `LIMIT ?` and `LIMIT ? OFFSET ?` patterns, pops the matching numeric params
 * from the array, and inlines them as integer literals so every query works
 * transparently on both MySQL and TiDB.
 */
function assertNonNegativeSqlInt(label: string, value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `LIMIT/OFFSET values must be non-negative integers, got for ${label}: ${String(value)}`,
      );
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `LIMIT/OFFSET values must be non-negative integers, got for ${label}: ${String(value)}`,
      );
    }
    return Number(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^\d+$/.test(trimmed)) {
      throw new Error(
        `LIMIT/OFFSET values must be integers, got for ${label}: ${JSON.stringify(value)}`,
      );
    }
    return parseInt(trimmed, 10);
  }
  throw new Error(
    `LIMIT/OFFSET values must be integers, got for ${label}: ${value === null ? 'null' : typeof value}`,
  );
}

function inlineLimitOffset(
  sql: string,
  params: unknown[],
): { sql: string; params: unknown[] } {
  const re = /\bLIMIT\s+\?\s*(?:OFFSET\s+\?)?\s*$/i;
  const m = sql.match(re);
  if (!m) return { sql, params };

  const hasOffset = /OFFSET\s+\?/i.test(m[0]);
  const out = [...params];

  if (hasOffset) {
    const offRaw = out.pop();
    const limRaw = out.pop();
    const off = assertNonNegativeSqlInt('OFFSET', offRaw);
    const lim = assertNonNegativeSqlInt('LIMIT', limRaw);
    return {
      sql: sql.replace(re, `LIMIT ${lim} OFFSET ${off}`),
      params: out,
    };
  }

  const limRaw = out.pop();
  const lim = assertNonNegativeSqlInt('LIMIT', limRaw);
  return {
    sql: sql.replace(re, `LIMIT ${lim}`),
    params: out,
  };
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
