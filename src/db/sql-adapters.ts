import { getActiveEngine } from '../database/engine.js';

export function adaptSql(sql: string): string {
  const d = getActiveEngine().dialect;
  if (d === 'sqlite') return sql;

  if (d === 'postgres') {
    // PG: convert "col COLLATE NOCASE" to "LOWER(col)" for equivalent
    // case-insensitive ordering; fall through to adaptSqlForPostgres.
    const adapted = sql.replace(
      /(\w+(?:\.\w+)?)\s+COLLATE\s+NOCASE/gi,
      'LOWER($1)',
    );
    return adaptSqlForPostgres(adapted);
  }

  // MySQL: default utf8mb4 collation is case-insensitive, just strip.
  let adapted = sql.replace(/\s+COLLATE\s+NOCASE/gi, '');

  // MySQL
  adapted = adapted
    .replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'REPLACE INTO')
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT IGNORE INTO')
    .replace(
      /ON\s+CONFLICT\s*\([^)]+\)\s+DO\s+UPDATE\s+SET/gi,
      'ON DUPLICATE KEY UPDATE',
    )
    .replace(/excluded\.(\w+)/g, 'VALUES($1)');

  // MySQL: backtick-quote reserved words used as column names
  adapted = adapted.replace(/\bkey\b(?=\s*[=,)]|\s+IN\b)/g, '`key`');
  adapted = adapted.replace(/\brole\b(?=\s*[=,)]|\s+IN\b)/g, '`role`');

  return adapted;
}

// Composite (and multi-column) primary keys for INSERT OR REPLACE -> Postgres ON CONFLICT.
// Verified against createSchema / buildPostgresSchema / buildMySQLSchema. Single-column PK
// tables fall back to the first INSERT column when omitted.
export const PG_TABLE_PK_COLUMNS: Record<string, string[]> = {
  messages: ['id', 'chat_jid'],
  conversation_participants: ['chat_jid', 'member_id'],
  role_permissions: ['role_id', 'permission_id'],
  user_roles: ['user_id', 'role_id'],
  review_branch_states: ['repository_id', 'stage', 'branch'],
  review_repository_members: ['repository_id', 'user_id'],
  code_search_index_files: ['cache_key', 'relative_path'],
  code_search_index_symbols: ['cache_key', 'relative_path', 'ordinal'],
  code_search_index_terms: ['cache_key', 'relative_path', 'ordinal'],
  im_memberships: ['chat_jid', 'user_id'],
  im_room_state: ['chat_jid'],
  im_events: ['chat_jid', 'seq'],
  im_conversation_prefs: ['chat_jid', 'user_id'],
  im_mentions: ['chat_jid', 'message_id', 'mentioned_user_id'],
  im_blocks: ['user_id', 'blocked_user_id'],
  im_pinned_messages: ['chat_jid', 'message_id'],
  im_device_keys: ['user_id', 'device_id'],
  im_room_keys: ['chat_jid', 'user_id', 'device_id'],
  im_message_crypto: ['chat_jid', 'message_id'],
  im_call_participants: ['call_id', 'user_id'],
  im_ai_members: ['chat_jid', 'assistant_id'],
  user_friends: ['user_id', 'friend_id'],
  im_message_quotas: ['sender_id', 'recipient_id', 'period_start'],
  im_link_previews: ['url_hash'],
  im_reactions: ['message_id', 'user_id', 'emoji'],
  im_read_cursors: ['chat_jid', 'user_id'],
  user_permission_overrides: ['user_id', 'permission_id'],
  resource_access: ['resource_type', 'resource_id', 'user_id'],
  provider_user_shares: ['provider_id', 'user_id'],
  user_default_providers: ['user_id'],
  repositories: ['id'],
};

/**
 * For INSERT OR IGNORE -> ON CONFLICT ... DO NOTHING on Postgres, the conflict target must be
 * explicit when multiple unique constraints exist. Tables listed here use a single primary key
 * (or composite PK below); unlisted statements still use bare ON CONFLICT DO NOTHING — see
 * adaptSqlForPostgres.
 */
export const PG_TABLE_IGNORE_CONFLICT_COLUMNS: Record<string, string[]> = {
  stock_analysis_config_state: ['scope'],
  review_repository_members: ['repository_id', 'user_id'],
  // Primary key; a partial unique index on stock_code (active tasks) can still raise errors
  // for conflicting non-id constraints — callers should avoid overlapping active tasks.
  stock_analysis_tasks: ['id'],
  im_memberships: ['chat_jid', 'user_id'],
  im_room_state: ['chat_jid'],
  im_conversation_prefs: ['chat_jid', 'user_id'],
  im_mentions: ['chat_jid', 'message_id', 'mentioned_user_id'],
  im_blocks: ['user_id', 'blocked_user_id'],
  im_pinned_messages: ['chat_jid', 'message_id'],
  im_device_keys: ['user_id', 'device_id'],
  im_room_keys: ['chat_jid', 'user_id', 'device_id'],
  im_message_crypto: ['chat_jid', 'message_id'],
  im_call_participants: ['call_id', 'user_id'],
  im_ai_members: ['chat_jid', 'assistant_id'],
  im_reactions: ['message_id', 'user_id', 'emoji'],
  user_friends: ['user_id', 'friend_id'],
  provider_user_access: ['provider_id', 'user_id'],
  provider_role_access: ['provider_id', 'role_id'],
  provider_user_shares: ['provider_id', 'user_id'],
  knowledge_doc_relations: ['source_doc_id', 'target_doc_id', 'relation_type'],
  code_map_ai_analyses: ['repository_id', 'branch', 'target_path', 'manifest_hash'],
  repo_features: ['repository_id', 'feature_type'],
  resource_bindings: ['resource_type', 'resource_id', 'owner_type', 'owner_id', 'binding_key'],
};

/**
 * Adapts SQLite SQL to Postgres dialect.
 *
 * - INSERT OR IGNORE INTO -> INSERT INTO ... ON CONFLICT (...) DO NOTHING when the table is
 *   listed in PG_TABLE_IGNORE_CONFLICT_COLUMNS; otherwise ON CONFLICT DO NOTHING (no target).
 *   Postgres allows omitting the conflict target for DO NOTHING, but behavior can be surprising
 *   when several unique constraints apply; prefer registering tables that use INSERT OR IGNORE.
 * - INSERT OR REPLACE INTO table (cols) VALUES (...) ->
 *   INSERT INTO table (cols) VALUES (...) ON CONFLICT (pk) DO UPDATE SET non_pk=EXCLUDED.non_pk
 * - ON CONFLICT / excluded syntax is already PG-compatible
 */
export const PG_RESERVED_COLUMNS = new Set(['key', 'timestamp', 'role', 'order', 'group', 'type', 'value']);

export function pgQuoteCol(col: string): string {
  return PG_RESERVED_COLUMNS.has(col) ? `"${col}"` : col;
}

export function adaptSqlForPostgres(sql: string): string {
  // PG: double-quote reserved words used as column names in general DML
  sql = sql.replace(/\brole\b(?=\s*[=,)]|\s+IN\b)/g, '"role"');
  sql = sql.replace(/\bkey\b(?=\s*[=,)]|\s+IN\b)/g, '"key"');
  sql = sql.replace(/\btimestamp\b(?=\s*[=,)]|\s+IN\b)/g, '"timestamp"');

  // INSERT OR IGNORE -> ON CONFLICT ... DO NOTHING
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) {
    const tableMatch = sql.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i);
    const table = tableMatch?.[1];
    const insertSql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
    const conflictCols = table ? PG_TABLE_IGNORE_CONFLICT_COLUMNS[table] : undefined;
    if (conflictCols?.length) {
      const quoted = conflictCols.map(pgQuoteCol).join(', ');
      return `${insertSql} ON CONFLICT(${quoted}) DO NOTHING`;
    }
    return `${insertSql} ON CONFLICT DO NOTHING`;
  }

  // INSERT OR REPLACE -> parse and build ON CONFLICT DO UPDATE
  const replaceMatch = sql.match(
    /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i,
  );
  if (replaceMatch) {
    const table = replaceMatch[1]!;
    const cols = replaceMatch[2]!
      .split(',')
      .map((c) => c.trim());

    const pkCols = PG_TABLE_PK_COLUMNS[table] || [cols[0]!];
    const pkSet = new Set(pkCols);
    const updateCols = cols.filter((c) => !pkSet.has(c));

    let result = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO');

    const quotedPks = pkCols.map(pgQuoteCol).join(', ');
    if (updateCols.length > 0) {
      const setClauses = updateCols
        .map((c) => `${pgQuoteCol(c)}=EXCLUDED.${pgQuoteCol(c)}`)
        .join(', ');
      result += ` ON CONFLICT(${quotedPks}) DO UPDATE SET ${setClauses}`;
    } else {
      result += ` ON CONFLICT(${quotedPks}) DO NOTHING`;
    }
    return result;
  }

  return sql;
}

/**
 * Detect unique-constraint / duplicate-key errors across SQLite, PG, and MySQL/TiDB.
 * - SQLite: "UNIQUE constraint failed" or SQLITE_CONSTRAINT
 * - PostgreSQL: code '23505' or "duplicate key value"
 * - MySQL/TiDB: "ER_DUP_ENTRY" or "Duplicate entry"
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  const code = String((err as unknown as { code?: unknown }).code || '');
  if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/.test(msg)) return true;
  if (code === '23505' || /duplicate key value/.test(msg)) return true;
  if (code === 'ER_DUP_ENTRY' || /Duplicate entry/.test(msg)) return true;
  return false;
}
