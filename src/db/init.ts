import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR, STORE_DIR } from '../config.js';
import { createModuleLogger } from '../logger.js';
import { SQLiteEngine } from '../database/sqlite-engine.js';
import {
  type DbEngine,
  setGlobalEngine,
} from '../database/engine.js';
import { createDbEngine, getDbConfigFromEnv } from '../database/factory.js';
import { adaptSql } from './sql-adapters.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { createSchema } from './schema-sqlite.js';
import { buildMySQLSchema, runMySQLMigrations } from './schema-mysql.js';
import * as dialect from '../database/dialect.js';
import { buildPostgresSchema, runPostgresMigrations } from './schema-postgres.js';
import {
  setRouterState,
  setSession,
  setRegisteredGroup,
} from './sessions.js';
import type { RegisteredGroup } from '../types.js';

const logger = createModuleLogger('database');

async function seedReviewRepositoryMembers(engine: DbEngine): Promise<void> {
  try {
    const repos = await engine.queryAll<{ id: string }>(
      'SELECT id FROM review_repositories WHERE deleted_at IS NULL',
    );
    if (repos.length === 0) return;

    const members = await engine.queryAll<{ repository_id: string }>(
      'SELECT repository_id FROM review_repository_members LIMIT 1',
    );
    if (members.length > 0) return;

    const users = await engine.queryAll<{ id: string }>(
      'SELECT id FROM users WHERE deleted_at IS NULL',
    );
    if (users.length === 0) return;

    const now = new Date().toISOString();
    for (const repo of repos) {
      for (const user of users) {
        await engine.run(
          adaptSql(
            `INSERT OR IGNORE INTO review_repository_members
             (repository_id, user_id, access_level, granted_at, granted_by)
             VALUES (?, ?, 'manager', ?, ?)`,
          ),
          [repo.id, user.id, now, SYSTEM_USER_ID],
        );
      }
    }
    logger.info(
      { repos: repos.length, users: users.length },
      'Seeded review repository members for existing data',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to seed review repository members (non-fatal)');
  }
}
export async function initDatabase(): Promise<void> {
  const config = getDbConfigFromEnv();
  logger.info({ engine: config.engine }, 'Initializing database engine');
  const engine = await createDbEngine(config);
  setGlobalEngine(engine);


  await createSchemaOnEngine(engine);
  void migrateJsonState();

  const { seedRbacData } = await import('../user/user-service.js');
  await seedRbacData();

  await seedReviewRepositoryMembers(engine);

  // Detect PG FTS config (jieba > zhparser > simple) — queries depend on this
  if (engine.dialect === 'postgres') {
    try {
      const { detectPgFtsConfig } = await import('../database/pg-fts-config.js');
      await detectPgFtsConfig(engine);
    } catch (err) {
      logger.warn({ err }, 'PG FTS config detection failed (non-fatal)');
    }
  }

  // Initialize knowledge FTS engine (table/index DDL only, no data rebuild)
  try {
    const { createKnowledgeSearchEngine } = await import(
      '../knowledge/knowledge-search-engine.js'
    );
    const kbSearchEngine = createKnowledgeSearchEngine(engine.dialect);
    await kbSearchEngine.initialize(engine);
  } catch (err) {
    logger.warn({ err }, 'Knowledge FTS engine initialization failed (non-fatal)');
  }

  logger.info({ dialect: engine.dialect }, 'Database initialized');
}

export function initDatabaseSync(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const rawDb = new Database(dbPath);
  const engine = new SQLiteEngine(rawDb);
  setGlobalEngine(engine);
  createSchema(rawDb);
  void migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  const rawDb = new Database(':memory:');
  const engine = new SQLiteEngine(rawDb);
  setGlobalEngine(engine);
  createSchema(rawDb);
}
/** @internal - for tests only. Applies schema creation and migrations to a database. */
export function _applySchemaToDatabaseForTest(
  database: Database.Database,
): void {
  createSchema(database);
}

async function createSchemaOnEngine(engine: DbEngine): Promise<void> {
  const d = engine.dialect;
  const autoPk = dialect.autoIncrementPk(d);

  if (d === 'sqlite' && engine instanceof SQLiteEngine) {
    createSchema(engine.getRawDatabase());
    return;
  }

  if (d === 'postgres') {
    await runPostgresMigrations(engine);
    const pgDdl = buildPostgresSchema(autoPk);
    await engine.exec(pgDdl);
    return;
  }

  const mysqlDdl = buildMySQLSchema(autoPk);
  await engine.exec(mysqlDdl);
  await runMySQLMigrations(engine);
}

/** @internal - for tests only. Applies dialect startup schema flow to an engine. */
export async function _createSchemaOnEngineForTest(engine: DbEngine): Promise<void> {
  await createSchemaOnEngine(engine);
}

/** @internal - for tests only. Applies MySQL startup migrations to an engine. */
export async function _runMySQLMigrationsForTest(engine: DbEngine): Promise<void> {
  await runMySQLMigrations(engine);
}

async function migrateJsonState(): Promise<void> {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      await setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      await setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      await setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        await setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
