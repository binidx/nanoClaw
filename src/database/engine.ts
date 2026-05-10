import { AsyncLocalStorage } from 'node:async_hooks';

export type Dialect = 'sqlite' | 'mysql' | 'postgres';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbEngine {
  readonly dialect: Dialect;

  queryAll<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;

  queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;

  run(sql: string, params?: unknown[]): Promise<RunResult>;

  exec(sql: string): Promise<void>;

  transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

const txStore = new AsyncLocalStorage<DbEngine>();

let globalEngine: DbEngine | undefined;

export function setGlobalEngine(engine: DbEngine): void {
  globalEngine = engine;
}

export function getGlobalEngine(): DbEngine {
  if (!globalEngine) {
    throw new Error(
      'Database engine not initialized. Call setGlobalEngine() first.',
    );
  }
  return globalEngine;
}

/**
 * Returns the transaction-scoped engine when inside a transaction,
 * otherwise the global engine. For MySQL this ensures all operations
 * within a transaction share the same dedicated connection.
 */
export function getActiveEngine(): DbEngine {
  return txStore.getStore() || getGlobalEngine();
}

export function runInTransactionScope<T>(
  engine: DbEngine,
  fn: () => Promise<T>,
): Promise<T> {
  return txStore.run(engine, fn);
}
