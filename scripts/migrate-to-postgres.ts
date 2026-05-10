/**
 * Data migration script: SQLite/MySQL -> PostgreSQL
 *
 * Usage:
 *   # From SQLite (default)
 *   DB_PG_HOST=localhost DB_PG_DATABASE=nanoclaw \
 *     npx tsx scripts/migrate-to-postgres.ts
 *
 *   # From MySQL
 *   DB_ENGINE=mysql DB_MYSQL_HOST=... \
 *     DB_PG_HOST=localhost DB_PG_DATABASE=nanoclaw \
 *     npx tsx scripts/migrate-to-postgres.ts --source=mysql
 *
 *   # Dry run (only verify connection and schema, no data copy)
 *   npx tsx scripts/migrate-to-postgres.ts --dry-run
 */

import {
  buildPostgresConfigFromEnv,
  createDbEngine,
  getDbConfigFromEnv,
} from '../src/database/factory.js';
import { PostgresEngine } from '../src/database/postgres-engine.js';
import type { DbEngine } from '../src/database/engine.js';

const BATCH_SIZE = 1000;

const TABLES_IN_ORDER = [
  'chats',
  'users',
  'roles',
  'permissions',
  'ai_providers',
  'config',
  'router_state',
  'sessions',
  'stock_analysis_config',
  'stock_analysis_config_state',
  'stock_analysis_config_presets',
  'stock_analysis_config_history',
  'stock_analysis_watchlist',

  'messages',
  'conversation_participants',
  'assistant_turns',
  'context_entries',
  'person_profiles',
  'conversation_identity_bindings',
  'identity_aliases',
  'memory_documents',
  'memory_document_sync_state',
  'memory_prompt_stats',
  'memory_search_events',
  'context_compactions',
  'context_compaction_jobs',
  'context_compaction_run_logs',

  'registered_groups',
  'assistants',
  'assistant_mcp_bindings',
  'assistant_mcp_binding_secrets',

  'scheduled_tasks',
  'task_run_logs',

  'review_repositories',
  'review_profiles',
  'review_runs',
  'review_branch_states',
  'review_remote_branch_cache',
  'review_conversation_bindings',

  'stock_analysis_tasks',
  'stock_analysis_reports',
  'stock_analysis_market_reviews',

  'role_permissions',
  'user_roles',
  'auth_sessions',
];

function parseArgs(): { source: 'sqlite' | 'mysql'; dryRun: boolean } {
  const args = process.argv.slice(2);
  let source: 'sqlite' | 'mysql' = 'sqlite';
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--source=')) {
      const val = arg.split('=')[1];
      if (val === 'mysql' || val === 'sqlite') {
        source = val;
      } else {
        console.error(`Invalid source: ${val}. Use "sqlite" or "mysql".`);
        process.exit(1);
      }
    }
    if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (process.env.DB_ENGINE === 'mysql' && !args.some((a) => a.startsWith('--source='))) {
    source = 'mysql';
  }

  return { source, dryRun };
}

function getPgConfig() {
  return buildPostgresConfigFromEnv();
}

async function getTableColumns(
  engine: DbEngine,
  table: string,
  dialect: string,
): Promise<string[]> {
  if (dialect === 'sqlite') {
    const rows = await engine.queryAll<{ name: string }>(
      `PRAGMA table_info("${table}")`,
    );
    return rows.map((r) => r.name);
  }

  if (dialect === 'mysql') {
    const rows = await engine.queryAll<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [table],
    );
    return rows.map((r) => r.COLUMN_NAME);
  }

  // postgres
  const rows = await engine.queryAll<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

async function tableExists(
  engine: DbEngine,
  table: string,
  dialect: string,
): Promise<boolean> {
  if (dialect === 'sqlite') {
    const row = await engine.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?`,
      [table],
    );
    return (row?.cnt ?? 0) > 0;
  }

  if (dialect === 'mysql') {
    const row = await engine.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return (row?.cnt ?? 0) > 0;
  }

  // postgres
  const row = await engine.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
    [table],
  );
  return Number(row?.cnt ?? 0) > 0;
}

async function getRowCount(engine: DbEngine, table: string): Promise<number> {
  const row = await engine.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM "${table}"`,
  );
  return Number(row?.cnt ?? 0);
}

function pgPlaceholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1 + offset}`).join(', ');
}

function quoteIdent(col: string): string {
  const reserved = ['key', 'value', 'timestamp', 'order', 'group', 'user', 'column'];
  if (reserved.includes(col.toLowerCase())) {
    return `"${col}"`;
  }
  return col;
}

async function migrateTable(
  srcEngine: DbEngine,
  pgEngine: PostgresEngine,
  table: string,
  srcDialect: string,
): Promise<{ table: string; srcRows: number; dstRows: number }> {
  const exists = await tableExists(srcEngine, table, srcDialect);
  if (!exists) {
    console.log(`  [SKIP] ${table} — not found in source`);
    return { table, srcRows: 0, dstRows: 0 };
  }

  const srcCount = await getRowCount(srcEngine, table);
  if (srcCount === 0) {
    console.log(`  [SKIP] ${table} — empty in source`);
    return { table, srcRows: 0, dstRows: 0 };
  }

  const columns = await getTableColumns(srcEngine, table, srcDialect);
  if (columns.length === 0) {
    console.log(`  [SKIP] ${table} — no columns found`);
    return { table, srcRows: 0, dstRows: 0 };
  }

  const quotedCols = columns.map(quoteIdent).join(', ');
  const placeholders = pgPlaceholders(columns.length);

  const allRows = await srcEngine.queryAll(
    `SELECT * FROM "${table}"`,
  );

  let inserted = 0;
  for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
    const batch = allRows.slice(i, i + BATCH_SIZE);

    await pgEngine.transaction(async (tx) => {
      for (const row of batch) {
        const values = columns.map((col) => {
          const val = (row as Record<string, unknown>)[col];
          return val === undefined ? null : val;
        });

        await tx.run(
          `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values,
        );
        inserted++;
      }
    });
  }

  const dstCount = await getRowCount(pgEngine, table);
  console.log(`  [OK]   ${table}: ${srcCount} source -> ${dstCount} target (${inserted} attempted)`);
  return { table, srcRows: srcCount, dstRows: dstCount };
}

async function main() {
  const { source, dryRun } = parseArgs();

  console.log('=== NanoClaw Data Migration to PostgreSQL ===');
  console.log(`Source: ${source}`);
  console.log(`Dry run: ${dryRun}`);
  console.log();

  // Create source engine
  const srcConfig = getDbConfigFromEnv();
  if (source === 'mysql') {
    srcConfig.engine = 'mysql';
  } else {
    srcConfig.engine = 'sqlite';
  }
  console.log(`Connecting to source (${source})...`);
  const srcEngine = await createDbEngine(srcConfig);
  console.log('Source connected.');

  // Create target PG engine
  const pgConfig = getPgConfig();
  console.log(`Connecting to PostgreSQL at ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}...`);
  const pgEngine = await PostgresEngine.create(pgConfig);
  console.log('PostgreSQL connected.');

  // Check if target has existing data
  let hasExistingData = false;
  try {
    const existsChats = await tableExists(pgEngine, 'chats', 'postgres');
    if (existsChats) {
      const count = await getRowCount(pgEngine, 'chats');
      if (count > 0) {
        hasExistingData = true;
      }
    }
  } catch {
    // tables don't exist yet
  }

  if (hasExistingData) {
    console.warn(
      '\nWARNING: Target PostgreSQL database already contains data.',
    );
    console.warn(
      'Migration uses ON CONFLICT DO NOTHING to avoid duplicates.',
    );
    console.warn('Existing rows will NOT be overwritten.\n');
  }

  // Build PG schema (import the builder)
  console.log('Creating schema in PostgreSQL...');
  const { initDatabase: _skip, ...dbMod } = await import('../src/db.js');
  // We need to build schema directly via the PG engine
  // Import dialect to get autoPk
  const { autoIncrementPk } = await import('../src/database/dialect.js');
  const autoPk = autoIncrementPk('postgres');

  // We cannot easily call buildPostgresSchema from outside db.ts since it's
  // not exported, so we call createSchemaOnEngine indirectly by initializing
  // the engine as global and calling the schema builder.
  const { setGlobalEngine } = await import('../src/database/engine.js');
  setGlobalEngine(pgEngine);
  // Re-import and call createSchemaOnEngine via initDatabase logic
  // Actually, let's just call exec with the schema DDL directly
  // We'll construct it inline since buildPostgresSchema is not exported
  await buildPgSchemaForMigration(pgEngine, autoPk);
  console.log('Schema created.');

  if (dryRun) {
    console.log('\nDry run complete. No data was migrated.');
    await srcEngine.close();
    await pgEngine.close();
    return;
  }

  // Migrate tables
  console.log('\nMigrating data...\n');
  const results: Array<{ table: string; srcRows: number; dstRows: number }> = [];

  for (const table of TABLES_IN_ORDER) {
    try {
      const result = await migrateTable(srcEngine, pgEngine, table, source);
      results.push(result);
    } catch (err) {
      console.error(`  [FAIL] ${table}: ${(err as Error).message}`);
      results.push({ table, srcRows: -1, dstRows: -1 });
    }
  }

  // Summary
  console.log('\n=== Migration Summary ===\n');
  console.log(
    'Table'.padEnd(40) +
      'Source'.padStart(10) +
      'Target'.padStart(10) +
      '  Status',
  );
  console.log('-'.repeat(70));

  let totalSrc = 0;
  let totalDst = 0;
  let failures = 0;

  for (const r of results) {
    if (r.srcRows < 0) {
      console.log(
        r.table.padEnd(40) + 'ERR'.padStart(10) + 'ERR'.padStart(10) + '  FAILED',
      );
      failures++;
      continue;
    }
    if (r.srcRows === 0) continue;
    totalSrc += r.srcRows;
    totalDst += r.dstRows;
    const status = r.srcRows === r.dstRows ? 'OK' : 'PARTIAL';
    console.log(
      r.table.padEnd(40) +
        String(r.srcRows).padStart(10) +
        String(r.dstRows).padStart(10) +
        `  ${status}`,
    );
  }

  console.log('-'.repeat(70));
  console.log(
    'TOTAL'.padEnd(40) +
      String(totalSrc).padStart(10) +
      String(totalDst).padStart(10),
  );

  if (failures > 0) {
    console.log(`\n${failures} table(s) failed to migrate.`);
  }

  // Synchronize PostgreSQL sequences for all SERIAL primary key columns.
  // Without this, sequences stay at their initial value after migrating
  // data with explicit IDs, causing duplicate key violations on new inserts.
  console.log('\nSynchronizing PostgreSQL sequences...');
  await syncPostgresSequences(pgEngine);

  console.log('\nDone. Source database was NOT modified.');

  await srcEngine.close();
  await pgEngine.close();
}

async function buildPgSchemaForMigration(
  engine: PostgresEngine,
  autoPk: string,
): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      custom_title TEXT,
      is_pinned INT DEFAULT 0,
      is_favorite INT DEFAULT 0,
      last_message_time TEXT,
      channel TEXT,
      is_group INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      "timestamp" TEXT,
      client_id TEXT,
      run_id TEXT,
      is_from_me INT,
      is_bot_message INT DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      chat_jid TEXT NOT NULL,
      channel TEXT,
      member_id TEXT NOT NULL,
      member_name TEXT,
      source TEXT NOT NULL DEFAULT 'message',
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, member_id)
    );

    CREATE TABLE IF NOT EXISTS assistant_turns (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      message_id TEXT,
      "timestamp" TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_entries (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      run_id TEXT,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      content_text TEXT NOT NULL,
      content_json TEXT,
      token_estimate INT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS person_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_identity_bindings (
      chat_jid TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      person_id TEXT NOT NULL,
      bound_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity_aliases (
      id ${autoPk},
      person_id TEXT NOT NULL,
      channel TEXT,
      external_user_id TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_documents (
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

    CREATE TABLE IF NOT EXISTS memory_document_sync_state (
      path_ref TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      file_mtime_ms BIGINT NOT NULL,
      file_size BIGINT NOT NULL,
      content_hash TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_prompt_stats (
      scope TEXT PRIMARY KEY,
      last_assembled_token_estimate INT,
      last_recent_tokens INT,
      last_summary_tokens INT,
      last_recall_tokens INT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_search_events (
      event_id ${autoPk},
      event_type TEXT NOT NULL,
      path_ref TEXT,
      scope TEXT,
      owner_type TEXT,
      owner_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compactions (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      compacted_until TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      source_entry_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compaction_jobs (
      chat_jid TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      pending INT NOT NULL DEFAULT 1,
      runtime_claimed_at TEXT,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_success_at TEXT,
      last_error_at TEXT,
      last_duration_ms INT,
      last_error TEXT,
      run_count INT NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compaction_run_logs (
      id ${autoPk},
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INT NOT NULL,
      status TEXT NOT NULL,
      result_summary_id TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      retry_limit INT NOT NULL DEFAULT 0,
      retry_backoff_ms INT NOT NULL DEFAULT 300000,
      failure_mode TEXT NOT NULL DEFAULT 'continue',
      consecutive_failures INT NOT NULL DEFAULT 0,
      last_error TEXT,
      runtime_claimed_at TEXT,
      context_mode TEXT DEFAULT 'isolated',
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id ${autoPk},
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS router_state (
      "key" TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      assistant_id TEXT,
      agent_config TEXT,
      requires_trigger INT DEFAULT 1,
      is_main INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS assistants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INT NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_mcp_bindings (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      template_server_id TEXT NOT NULL,
      alias TEXT,
      enabled INT NOT NULL DEFAULT 1,
      args_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_mcp_binding_secrets (
      binding_id TEXT PRIMARY KEY,
      env_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      "key" TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_config (
      "key" TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_config_state (
      scope TEXT PRIMARY KEY,
      version INT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_config_history (
      id TEXT PRIMARY KEY,
      version INT NOT NULL,
      config_entries_json TEXT NOT NULL,
      changed_keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_config_presets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_tasks (
      id TEXT PRIMARY KEY,
      stock_code TEXT NOT NULL,
      market TEXT NOT NULL,
      stock_name TEXT,
      status TEXT NOT NULL,
      report_type TEXT NOT NULL,
      strategy_preset TEXT NOT NULL DEFAULT 'bull_trend',
      force_refresh INT NOT NULL DEFAULT 0,
      result_mode TEXT NOT NULL DEFAULT 'generated',
      error TEXT,
      report_id TEXT,
      data_as_of TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_reports (
      id TEXT PRIMARY KEY,
      stock_code TEXT NOT NULL,
      market TEXT NOT NULL,
      stock_name TEXT,
      report_type TEXT NOT NULL,
      score INT NOT NULL DEFAULT 0,
      trend TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      current_price DOUBLE PRECISION,
      change_pct DOUBLE PRECISION,
      data_as_of TEXT,
      history_days INT NOT NULL DEFAULT 180,
      summary_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      model_used TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_market_reviews (
      id TEXT PRIMARY KEY,
      market_scope TEXT NOT NULL,
      trade_date TEXT,
      summary_json TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      model_used TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_watchlist (
      stock_code TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      model TEXT,
      extra_config TEXT,
      is_default INT DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      language TEXT,
      local_repo_path TEXT,
      remote_provider TEXT,
      remote_repo_slug TEXT,
      remote_base_url TEXT,
      clone_url TEXT,
      default_target_branch TEXT,
      review_chat_jid TEXT,
      actor_mention_mappings_json TEXT NOT NULL DEFAULT '[]',
      reviewer_usernames_json TEXT NOT NULL DEFAULT '[]',
      local_hook_secret TEXT,
      webhook_secret TEXT,
      platform_token TEXT,
      auto_sync_enabled INT NOT NULL DEFAULT 0,
      auto_sync_interval_minutes INT NOT NULL DEFAULT 30,
      last_auto_sync_at TEXT,
      next_auto_sync_at TEXT,
      last_auto_sync_status TEXT,
      last_auto_sync_message TEXT,
      enabled INT NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_profiles (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      stage TEXT NOT NULL,
      source_mode TEXT NOT NULL DEFAULT 'both',
      blocking_mode TEXT NOT NULL DEFAULT 'soft_fail',
      pass_decision_mode TEXT NOT NULL DEFAULT 'ai',
      review_scope TEXT NOT NULL DEFAULT 'auto',
      target_branches TEXT NOT NULL DEFAULT '[]',
      skill_ids TEXT NOT NULL DEFAULT '[]',
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      prompt_template TEXT,
      include_globs TEXT NOT NULL DEFAULT '[]',
      exclude_globs TEXT NOT NULL DEFAULT '[]',
      include_full_file_context INT NOT NULL DEFAULT 0,
      max_files INT NOT NULL DEFAULT 80,
      max_diff_bytes INT NOT NULL DEFAULT 200000,
      write_to_chat INT NOT NULL DEFAULT 1,
      write_to_platform INT NOT NULL DEFAULT 1,
      enabled INT NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      profile_id TEXT,
      idempotency_key TEXT,
      source TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      overall TEXT,
      recommended_block INT NOT NULL DEFAULT 0,
      blocking_enforced INT NOT NULL DEFAULT 0,
      baseline_source TEXT,
      result_state TEXT,
      ref TEXT,
      branch TEXT,
      base_sha TEXT,
      head_sha TEXT,
      pr_mr_number TEXT,
      actor TEXT,
      summary TEXT,
      findings_json TEXT NOT NULL DEFAULT '[]',
      file_reviews_json TEXT NOT NULL DEFAULT '[]',
      commit_reviews_json TEXT NOT NULL DEFAULT '[]',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      diff_bytes INT NOT NULL DEFAULT 0,
      callback_context_json TEXT,
      duration_ms INT NOT NULL DEFAULT 0,
      platform_status TEXT,
      chat_delivery_status TEXT,
      platform_status_delivery_status TEXT,
      platform_comment_delivery_status TEXT,
      platform_comment_id TEXT,
      platform_comment_url TEXT,
      cloud_doc_token TEXT,
      cloud_doc_url TEXT,
      cloud_doc_title TEXT,
      cloud_doc_status TEXT,
      cloud_doc_last_error TEXT,
      last_delivery_error TEXT,
      delivery_retry_count INT NOT NULL DEFAULT 0,
      effective_rules_json TEXT NOT NULL DEFAULT '{}',
      manual_decision TEXT,
      manual_decision_by TEXT,
      manual_decision_at TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_branch_states (
      repository_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      branch TEXT NOT NULL,
      last_run_id TEXT,
      head_sha TEXT,
      baseline_sha TEXT,
      baseline_source TEXT,
      result_state TEXT,
      status TEXT,
      actor TEXT,
      summary TEXT,
      reviewed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, stage, branch)
    );

    CREATE TABLE IF NOT EXISTS review_remote_branch_cache (
      repository_id TEXT PRIMARY KEY,
      branches_json TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_conversation_bindings (
      repository_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_system INT DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      granted_by TEXT,
      PRIMARY KEY (user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
  `;
  await engine.exec(ddl);
}

const SERIAL_PK_TABLES: Array<{ table: string; column: string }> = [
  { table: 'identity_aliases', column: 'id' },
  { table: 'memory_search_events', column: 'event_id' },
  { table: 'context_compaction_run_logs', column: 'id' },
  { table: 'task_run_logs', column: 'id' },
];

async function syncPostgresSequences(pgEngine: PostgresEngine): Promise<void> {
  for (const { table, column } of SERIAL_PK_TABLES) {
    try {
      await pgEngine.exec(`
        SELECT setval(
          pg_get_serial_sequence('${table}', '${column}'),
          COALESCE((SELECT MAX("${column}") FROM "${table}"), 0) + 1,
          false
        )
      `);
      console.log(`  [OK] ${table}.${column} sequence synchronized`);
    } catch (err) {
      console.warn(`  [WARN] ${table}.${column}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
