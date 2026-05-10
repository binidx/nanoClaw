import type Database from 'better-sqlite3';

import type { DbEngine, Dialect, RunResult } from './engine.js';

const STMT_CACHE_MAX = 1000;

export class SQLiteEngine implements DbEngine {
  readonly dialect: Dialect = 'sqlite';
  private db: Database.Database;
  private stmtCache = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  private getStmt(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
      return stmt;
    }
    if (this.stmtCache.size >= STMT_CACHE_MAX) {
      const oldest = this.stmtCache.keys().next().value!;
      this.stmtCache.delete(oldest);
    }
    stmt = this.db.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.getStmt(sql).all(...params) as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (this.getStmt(sql).get(...params) as T) ?? undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.getStmt(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    const txEngine = new SQLiteTxEngine(this.db);
    try {
      const result = await fn(txEngine);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* swallow rollback errors; original error is more useful */
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.stmtCache.clear();
    this.db.close();
  }

  getRawDatabase(): Database.Database {
    return this.db;
  }
}

class SQLiteTxEngine implements DbEngine {
  readonly dialect: Dialect = 'sqlite';
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return (this.db.prepare(sql).get(...params) as T) ?? undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
    const savepoint = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } finally {
        try {
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          /* swallow release errors after rollback */
        }
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    /* tx engine does not own the database handle */
  }
}
