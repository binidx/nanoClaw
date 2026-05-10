import type Database from 'better-sqlite3';
import {
  type DbEngine,
  getActiveEngine,
  getGlobalEngine,
  runInTransactionScope,
} from '../database/engine.js';
import { SQLiteEngine } from '../database/sqlite-engine.js';
import { adaptSql } from './sql-adapters.js';

export function eng(): DbEngine {
  return getActiveEngine();
}

export function isSqlite(): boolean {
  return eng().dialect === 'sqlite';
}

/**
 * Compatibility wrapper that mimics the better-sqlite3 prepare() API
 * but routes through the DbEngine. Handles SQL dialect adaptation
 * automatically. Returns Promises instead of sync values.
 */
export const dba = {
  prepare(sql: string) {
    const adapted = adaptSql(sql);
    return {
      all: (...params: unknown[]): Promise<unknown[]> => eng().queryAll(adapted, params),
      get: (...params: unknown[]): Promise<unknown> => eng().queryOne(adapted, params),
      run: (...params: unknown[]) => eng().run(adapted, params),
    };
  },
  exec(sql: string) {
    return eng().exec(adaptSql(sql));
  },
  transaction<A extends unknown[], R>(
    fn: (...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      return eng().transaction(async (txEngine) => {
        return runInTransactionScope(txEngine, async () =>
          fn(...args),
        ) as Promise<R>;
      });
    };
  },
};

export function getSqliteRawDatabase(): Database.Database | undefined {
  const e = getGlobalEngine();
  if (e.dialect !== 'sqlite') return undefined;
  if (e instanceof SQLiteEngine) return e.getRawDatabase();
  return undefined;
}
