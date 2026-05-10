import type { DbEngine } from './engine.js';
import { hydrateProcessEnvFromEnvFile } from '../env.js';

hydrateProcessEnvFromEnvFile([
  'DB_ENGINE',
  'DB_MYSQL_HOST',
  'DB_MYSQL_PORT',
  'DB_MYSQL_USER',
  'DB_MYSQL_PASSWORD',
  'DB_MYSQL_DATABASE',
  'DB_MYSQL_POOL_SIZE',
  'DB_PG_HOST',
  'DB_PG_PORT',
  'DB_PG_USER',
  'DB_PG_PASSWORD',
  'DB_PG_DATABASE',
  'DB_PG_POOL_SIZE',
  'DB_PG_SSL',
  'DB_PG_SSL_REJECT_UNAUTHORIZED',
  'DB_PG_SSL_CA',
]);

function parseOptionalEnvBool(
  envVar: string,
  raw: string | undefined,
): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(
    `${envVar} must be true or false if set, got: ${JSON.stringify(raw)}`,
  );
}

export function buildPostgresConfigFromEnv(): NonNullable<DbConfig['postgres']> {
  return {
    host: process.env.DB_PG_HOST || 'localhost',
    port: parseInt(process.env.DB_PG_PORT || '5432', 10),
    user: process.env.DB_PG_USER || 'nanoclaw',
    password: process.env.DB_PG_PASSWORD || '',
    database: process.env.DB_PG_DATABASE || 'nanoclaw',
    poolSize: parseInt(process.env.DB_PG_POOL_SIZE || '10', 10),
    ssl: process.env.DB_PG_SSL === 'true',
    sslRejectUnauthorized: parseOptionalEnvBool(
      'DB_PG_SSL_REJECT_UNAUTHORIZED',
      process.env.DB_PG_SSL_REJECT_UNAUTHORIZED,
    ),
    sslCaPath: process.env.DB_PG_SSL_CA?.trim() || undefined,
  };
}

export interface DbConfig {
  engine: 'sqlite' | 'mysql' | 'postgres';
  sqlite?: { path: string };
  mysql?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize?: number;
  };
  postgres?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize?: number;
    ssl?: boolean;
    sslRejectUnauthorized?: boolean;
    sslCaPath?: string;
  };
}

export function getDbConfigFromEnv(): DbConfig {
  const engine = (process.env.DB_ENGINE || 'sqlite') as
    | 'sqlite'
    | 'mysql'
    | 'postgres';

  if (engine === 'mysql') {
    return {
      engine: 'mysql',
      mysql: {
        host: process.env.DB_MYSQL_HOST || 'localhost',
        port: parseInt(process.env.DB_MYSQL_PORT || '3306', 10),
        user: process.env.DB_MYSQL_USER || 'nanoclaw',
        password: process.env.DB_MYSQL_PASSWORD || '',
        database: process.env.DB_MYSQL_DATABASE || 'nanoclaw',
        poolSize: parseInt(process.env.DB_MYSQL_POOL_SIZE || '10', 10),
      },
    };
  }

  if (engine === 'postgres') {
    return {
      engine: 'postgres',
      postgres: buildPostgresConfigFromEnv(),
    };
  }

  return { engine: 'sqlite' };
}

export async function createDbEngine(config: DbConfig): Promise<DbEngine> {
  if (config.engine === 'mysql') {
    if (!config.mysql) {
      throw new Error('MySQL config required when DB_ENGINE=mysql');
    }
    const { MySQLEngine } = await import('./mysql-engine.js');
    return MySQLEngine.create(config.mysql);
  }

  if (config.engine === 'postgres') {
    if (!config.postgres) {
      throw new Error('PostgreSQL config required when DB_ENGINE=postgres');
    }
    const { PostgresEngine } = await import('./postgres-engine.js');
    return PostgresEngine.create(config.postgres);
  }

  const Database = (await import('better-sqlite3')).default;
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { STORE_DIR } = await import('../config.js');

  const dbPath = config.sqlite?.path || path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  const { SQLiteEngine } = await import('./sqlite-engine.js');
  return new SQLiteEngine(db);
}

export async function createTestEngine(): Promise<DbEngine> {
  const Database = (await import('better-sqlite3')).default;
  const { SQLiteEngine } = await import('./sqlite-engine.js');
  return new SQLiteEngine(new Database(':memory:'));
}
