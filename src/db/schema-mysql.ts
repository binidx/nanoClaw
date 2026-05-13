import type { DbEngine } from '../database/engine.js';
import { logger } from '../logger.js';
import { isMySqlFullTextUnsupportedError } from '../database/mysql-fulltext.js';

/**
 * MySQL / TiDB error codes that mean "object already exists" and should be
 * silently ignored by idempotent ALTER / CREATE INDEX migrations.
 * Anything else is re-thrown so deployment issues (permissions, locks,
 * encoding, missing column references) fail fast instead of booting a
 * half-migrated schema.
 */
const MYSQL_DUPLICATE_ERRNOS = new Set<number>([
  1050, // ER_TABLE_EXISTS_ERROR
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  1068, // ER_MULTIPLE_PRI_KEY
  1091, // ER_CANT_DROP_FIELD_OR_KEY — DROP INDEX/COLUMN 目标已不存在（幂等 drop）
  1826, // ER_FK_DUP_NAME
]);
const MYSQL_DUPLICATE_CODES = new Set<string>([
  'ER_TABLE_EXISTS_ERROR',
  'ER_DUP_FIELDNAME',
  'ER_DUP_KEYNAME',
  'ER_MULTIPLE_PRI_KEY',
  'ER_CANT_DROP_FIELD_OR_KEY',
  'ER_FK_DUP_NAME',
]);

function isDuplicateObjectError(err: unknown): boolean {
  const e = err as { errno?: unknown; code?: unknown } | null | undefined;
  return (
    (typeof e?.errno === 'number' && MYSQL_DUPLICATE_ERRNOS.has(e.errno)) ||
    (typeof e?.code === 'string' && MYSQL_DUPLICATE_CODES.has(e.code))
  );
}

export function buildMySQLSchema(autoPk: string): string {
  return `
    CREATE TABLE IF NOT EXISTS chats (
      jid VARCHAR(128) PRIMARY KEY,
      name TEXT,
      custom_title TEXT,
      is_pinned INT DEFAULT 0,
      is_favorite INT DEFAULT 0,
      last_message_time VARCHAR(64),
      channel VARCHAR(64),
      is_group INT DEFAULT 0,
      mode VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64),
      updated_at VARCHAR(64),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(64) NOT NULL,
      chat_jid VARCHAR(128) NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content MEDIUMTEXT,
      uploaded_files_json TEXT,
      timestamp VARCHAR(64),
      client_id VARCHAR(64),
      run_id VARCHAR(64),
      im_seq BIGINT,
      is_from_me INT,
      is_bot_message INT DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      KEY idx_messages_chat_im_seq (chat_jid, im_seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS conversation_participants (
      chat_jid VARCHAR(128) NOT NULL,
      channel VARCHAR(64),
      member_id VARCHAR(64) NOT NULL,
      member_name TEXT,
      source VARCHAR(64) NOT NULL DEFAULT 'message',
      last_seen_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS assistant_turns (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(128) NOT NULL,
      message_id VARCHAR(64),
      timestamp VARCHAR(64) NOT NULL,
      payload MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS context_entries (
      id VARCHAR(255) PRIMARY KEY,
      group_folder VARCHAR(128) NOT NULL,
      chat_jid VARCHAR(128) NOT NULL,
      run_id VARCHAR(64),
      provider VARCHAR(128) NOT NULL,
      \`role\` VARCHAR(64) NOT NULL,
      source_type VARCHAR(128) NOT NULL,
      source_ref TEXT,
      content_text MEDIUMTEXT NOT NULL,
      content_json MEDIUMTEXT,
      token_estimate INT,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS person_profiles (
      id VARCHAR(64) PRIMARY KEY,
      display_name VARCHAR(128) NOT NULL,
      notes_json TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS conversation_identity_bindings (
      chat_jid VARCHAR(128) PRIMARY KEY,
      group_folder VARCHAR(128) NOT NULL,
      person_id VARCHAR(64) NOT NULL,
      bound_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS identity_aliases (
      id ${autoPk},
      person_id VARCHAR(64) NOT NULL,
      channel VARCHAR(64),
      external_user_id VARCHAR(64),
      display_name VARCHAR(128),
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_documents (
      doc_id VARCHAR(64) PRIMARY KEY,
      scope VARCHAR(128) NOT NULL,
      owner_type VARCHAR(128) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      path_ref TEXT,
      source_type VARCHAR(128) NOT NULL,
      title TEXT,
      body MEDIUMTEXT NOT NULL,
      metadata_json TEXT,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_document_sync_state (
      path_ref VARCHAR(255) PRIMARY KEY,
      scope VARCHAR(128) NOT NULL,
      owner_type VARCHAR(128) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      source_type VARCHAR(128) NOT NULL,
      file_mtime_ms BIGINT NOT NULL,
      file_size BIGINT NOT NULL,
      content_hash VARCHAR(128) NOT NULL,
      last_synced_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_prompt_stats (
      scope VARCHAR(128) PRIMARY KEY,
      last_assembled_token_estimate INT,
      last_recent_tokens INT,
      last_summary_tokens INT,
      last_recall_tokens INT,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_search_events (
      event_id ${autoPk},
      event_type VARCHAR(128) NOT NULL,
      path_ref TEXT,
      scope VARCHAR(128),
      owner_type VARCHAR(128),
      owner_id VARCHAR(64),
      metadata_json TEXT,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS context_compactions (
      id VARCHAR(255) PRIMARY KEY,
      group_folder VARCHAR(128) NOT NULL,
      chat_jid VARCHAR(128) NOT NULL,
      compacted_until VARCHAR(64) NOT NULL,
      summary_text MEDIUMTEXT NOT NULL,
      source_entry_ids_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS context_compaction_jobs (
      chat_jid VARCHAR(128) PRIMARY KEY,
      group_folder VARCHAR(128) NOT NULL,
      requested_at VARCHAR(64) NOT NULL,
      available_at VARCHAR(64) NOT NULL,
      pending INT NOT NULL DEFAULT 1,
      runtime_claimed_at VARCHAR(64),
      last_started_at VARCHAR(64),
      last_finished_at VARCHAR(64),
      last_success_at VARCHAR(64),
      last_error_at VARCHAR(64),
      last_duration_ms INT,
      last_error TEXT,
      run_count INT NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS context_compaction_run_logs (
      id ${autoPk},
      chat_jid VARCHAR(128) NOT NULL,
      group_folder VARCHAR(128) NOT NULL,
      started_at VARCHAR(64) NOT NULL,
      finished_at VARCHAR(64) NOT NULL,
      duration_ms INT NOT NULL,
      status VARCHAR(64) NOT NULL,
      result_summary_id VARCHAR(255),
      error TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL,
      group_folder VARCHAR(128) NOT NULL,
      chat_jid VARCHAR(128) NOT NULL,
      prompt MEDIUMTEXT NOT NULL,
      schedule_type VARCHAR(64) NOT NULL,
      schedule_value VARCHAR(128) NOT NULL,
      next_run VARCHAR(64),
      last_run VARCHAR(64),
      last_result TEXT,
      retry_limit INT NOT NULL DEFAULT 0,
      retry_backoff_ms INT NOT NULL DEFAULT 300000,
      failure_mode VARCHAR(64) NOT NULL DEFAULT 'continue',
      consecutive_failures INT NOT NULL DEFAULT 0,
      last_error TEXT,
      runtime_claimed_at VARCHAR(64),
      context_mode VARCHAR(64) DEFAULT 'isolated',
      status VARCHAR(64) DEFAULT 'active',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_scheduled_tasks_due (status, deleted_at, next_run),
      KEY idx_scheduled_tasks_group_created (group_folder, deleted_at, created_at DESC),
      KEY idx_scheduled_tasks_chat_created (chat_jid, deleted_at, created_at DESC),
      KEY idx_scheduled_tasks_created (deleted_at, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id ${autoPk},
      task_id VARCHAR(64) NOT NULL,
      run_at VARCHAR(64) NOT NULL,
      duration_ms INT NOT NULL,
      status VARCHAR(64) NOT NULL,
      result TEXT,
      error TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS router_state (
      \`key\` VARCHAR(128) PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS sessions (
      group_folder VARCHAR(128) PRIMARY KEY,
      session_id VARCHAR(128) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS registered_groups (
      jid VARCHAR(128) PRIMARY KEY,
      name TEXT NOT NULL,
      folder VARCHAR(128) NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at VARCHAR(64) NOT NULL,
      assistant_id VARCHAR(64),
      agent_config TEXT,
      requires_trigger INT DEFAULT 1,
      is_main INT DEFAULT 0,
      provider_id VARCHAR(64) DEFAULT NULL,
      model VARCHAR(128) DEFAULT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS assistants (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      enabled INT NOT NULL DEFAULT 1,
      config_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS assistant_mcp_bindings (
      id VARCHAR(64) PRIMARY KEY,
      assistant_id VARCHAR(64) NOT NULL,
      template_server_id VARCHAR(64) NOT NULL,
      alias VARCHAR(128),
      enabled INT NOT NULL DEFAULT 1,
      args_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY idx_amcpb_ast_tpl (assistant_id, template_server_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS assistant_mcp_binding_secrets (
      binding_id VARCHAR(64) PRIMARY KEY,
      env_json TEXT NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS assistant_repo_bindings (
      id VARCHAR(64) PRIMARY KEY,
      assistant_id VARCHAR(64) NOT NULL,
      repo_url VARCHAR(255) NOT NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      local_path VARCHAR(255),
      default_branch VARCHAR(128) NOT NULL DEFAULT 'main',
      branch_filter TEXT NOT NULL,
      active_branch VARCHAR(128),
      worktree_path VARCHAR(255),
      enabled INT NOT NULL DEFAULT 1,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      INDEX idx_arb_assistant (assistant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS config (
      \`key\` VARCHAR(128) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS prompt_configs (
      id VARCHAR(64) PRIMARY KEY,
      scope_kind VARCHAR(32) NOT NULL,
      owner_user_id VARCHAR(64) NOT NULL,
      prompt_key VARCHAR(128) NOT NULL,
      feature_scope VARCHAR(128) NOT NULL,
      template_text TEXT NOT NULL,
      notes TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uk_prompt_configs_scope_owner_key (scope_kind, owner_user_id, prompt_key),
      KEY idx_prompt_configs_feature_key (feature_scope, prompt_key),
      KEY idx_prompt_configs_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS prompt_traces (
      id VARCHAR(64) PRIMARY KEY,
      trace_kind VARCHAR(32) NOT NULL,
      prompt_key VARCHAR(128),
      feature_scope VARCHAR(128) NOT NULL,
      target_user_id VARCHAR(64) NOT NULL,
      chat_jid VARCHAR(255),
      provider VARCHAR(64),
      model VARCHAR(255),
      system_prompt_text TEXT,
      user_prompt_text TEXT NOT NULL,
      provider_input_text TEXT,
      segments_json TEXT NOT NULL,
      resolution_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_prompt_traces_feature_created (feature_scope, created_at),
      KEY idx_prompt_traces_key_created (prompt_key, created_at),
      KEY idx_prompt_traces_user_created (target_user_id, created_at),
      KEY idx_prompt_traces_chat_created (chat_jid, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS ai_providers (
      id VARCHAR(64) PRIMARY KEY,
      alias VARCHAR(128) NOT NULL,
      type VARCHAR(64) NOT NULL,
      capability VARCHAR(32) NOT NULL DEFAULT 'llm',
      api_key TEXT,
      base_url TEXT,
      model VARCHAR(255),
      dimensions INT NULL,
      extra_config TEXT,
      is_default INT DEFAULT 0,
      visibility VARCHAR(16) NOT NULL DEFAULT 'public',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS provider_user_access (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (provider_id, user_id),
      KEY idx_pua_user (user_id),
      KEY idx_pua_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS provider_role_access (
      provider_id VARCHAR(64) NOT NULL,
      role_id VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL,
      PRIMARY KEY (provider_id, role_id),
      KEY idx_pra_role (role_id),
      KEY idx_pra_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS provider_user_shares (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (provider_id, user_id),
      KEY idx_provider_user_shares_user (user_id),
      KEY idx_provider_user_shares_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS user_default_providers (
      user_id VARCHAR(64) PRIMARY KEY,
      provider_id VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_user_default_providers_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS review_repositories (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      language TEXT,
      local_repo_path TEXT,
      remote_provider TEXT,
      remote_repo_slug TEXT,
      remote_base_url TEXT,
      clone_url TEXT,
      default_target_branch TEXT,
      review_chat_jid VARCHAR(128),
      actor_mention_mappings_json TEXT NOT NULL,
      reviewer_usernames_json TEXT NOT NULL,
      local_hook_secret TEXT,
      webhook_secret TEXT,
      platform_token TEXT,
      auto_sync_enabled INT NOT NULL DEFAULT 0,
      auto_sync_interval_minutes INT NOT NULL DEFAULT 30,
      last_auto_sync_at VARCHAR(64),
      next_auto_sync_at VARCHAR(64),
      last_auto_sync_status VARCHAR(64),
      last_auto_sync_message TEXT,
      digest_daily_enabled INT NOT NULL DEFAULT 0,
      digest_weekly_enabled INT NOT NULL DEFAULT 0,
      digest_daily_hour INT NOT NULL DEFAULT 18,
      digest_weekly_day INT NOT NULL DEFAULT 5,
      digest_weekly_hour INT NOT NULL DEFAULT 18,
      last_digest_daily_at VARCHAR(64),
      next_digest_daily_at VARCHAR(64),
      last_digest_weekly_at VARCHAR(64),
      next_digest_weekly_at VARCHAR(64),
      enabled INT NOT NULL DEFAULT 1,
      allow_ai_fix INT NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_review_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at),
      KEY idx_review_repositories_list (deleted_at, enabled DESC, updated_at DESC, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS repositories (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      language TEXT,
      local_repo_path TEXT,
      remote_provider TEXT,
      remote_repo_slug TEXT,
      remote_base_url TEXT,
      clone_url TEXT,
      default_target_branch TEXT,
      ssh_key_id VARCHAR(64),
      auto_sync_enabled INT NOT NULL DEFAULT 0,
      auto_sync_interval_minutes INT NOT NULL DEFAULT 30,
      last_auto_sync_at VARCHAR(64),
      next_auto_sync_at VARCHAR(64),
      last_auto_sync_status TEXT,
      last_auto_sync_message TEXT,
      enabled INT NOT NULL DEFAULT 1,
      \`status\` VARCHAR(64) DEFAULT 'active',
      visibility TEXT,
      ai_description TEXT,
      tech_stack_json TEXT,
      user_id VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      INDEX idx_repositories_user (user_id(64)),
      INDEX idx_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at),
      INDEX idx_repositories_user_updated (user_id, deleted_at, updated_at DESC),
      INDEX idx_repositories_updated (deleted_at, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS repo_features (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      feature_type VARCHAR(64) NOT NULL,
      enabled INT NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE INDEX idx_repo_features_repo_type (repository_id, feature_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_digest_runs (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      type VARCHAR(16) NOT NULL,
      scheduled_for VARCHAR(64) NOT NULL DEFAULT '',
      period_start VARCHAR(64) NOT NULL,
      period_end VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      timezone VARCHAR(128) NOT NULL DEFAULT '',
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      duration_ms INT NOT NULL DEFAULT 0,
      branch_count INT NOT NULL DEFAULT 0,
      commit_count INT NOT NULL DEFAULT 0,
      contributor_count INT NOT NULL DEFAULT 0,
      summary MEDIUMTEXT NOT NULL,
      cloud_doc_url VARCHAR(255) NOT NULL DEFAULT '',
      cloud_doc_status VARCHAR(32) NOT NULL DEFAULT '',
      delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      delivery_error TEXT NOT NULL,
      error_message TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      INDEX idx_review_digest_runs_repo_type_created (repository_id, type, created_at DESC),
      INDEX idx_review_digest_runs_repo_scheduled (repository_id, scheduled_for DESC, created_at DESC),
      INDEX idx_review_digest_runs_repo_type_status_created (repository_id, type, status, created_at DESC),
      INDEX idx_review_digest_runs_schedule_status (repository_id, type, scheduled_for, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_profiles (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      stage VARCHAR(128) NOT NULL,
      source_mode VARCHAR(64) NOT NULL DEFAULT 'both',
      blocking_mode VARCHAR(64) NOT NULL DEFAULT 'soft_fail',
      pass_decision_mode VARCHAR(64) NOT NULL DEFAULT 'ai',
      review_scope VARCHAR(64) NOT NULL DEFAULT 'auto',
      target_branches TEXT NOT NULL,
      skill_ids TEXT NOT NULL,
      mcp_server_ids TEXT NOT NULL,
      prompt_template MEDIUMTEXT,
      include_globs TEXT NOT NULL,
      exclude_globs TEXT NOT NULL,
      include_full_file_context INT NOT NULL DEFAULT 0,
      max_files INT NOT NULL DEFAULT 80,
      max_diff_bytes INT NOT NULL DEFAULT 200000,
      write_to_chat INT NOT NULL DEFAULT 1,
      write_to_platform INT NOT NULL DEFAULT 1,
      review_output_mode VARCHAR(64) NOT NULL DEFAULT 'message',
      diff_subagent_threshold INT NOT NULL DEFAULT 15,
      enabled INT NOT NULL DEFAULT 1,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_review_profiles_repository_list (repository_id, deleted_at, enabled DESC, updated_at DESC, name),
      KEY idx_review_profiles_list (deleted_at, enabled DESC, updated_at DESC, name),
      KEY idx_review_profiles_match (repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_runs (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      profile_id VARCHAR(64),
      idempotency_key VARCHAR(255),
      source VARCHAR(128) NOT NULL,
      stage VARCHAR(128) NOT NULL,
      status VARCHAR(64) NOT NULL,
      overall TEXT,
      recommended_block INT NOT NULL DEFAULT 0,
      blocking_enforced INT NOT NULL DEFAULT 0,
      baseline_source VARCHAR(128),
      result_state VARCHAR(64),
      ref TEXT,
      branch VARCHAR(128),
      base_sha VARCHAR(128),
      head_sha VARCHAR(128),
      pr_mr_number VARCHAR(128),
      actor VARCHAR(128),
      summary MEDIUMTEXT,
      findings_json MEDIUMTEXT NOT NULL,
      file_reviews_json MEDIUMTEXT NOT NULL,
      commit_reviews_json MEDIUMTEXT NOT NULL,
      suggestions_json MEDIUMTEXT NOT NULL,
      changed_files_json MEDIUMTEXT NOT NULL,
      diff_bytes INT NOT NULL DEFAULT 0,
      callback_context_json MEDIUMTEXT,
      duration_ms INT NOT NULL DEFAULT 0,
      platform_status VARCHAR(64),
      chat_delivery_status VARCHAR(64),
      platform_status_delivery_status VARCHAR(64),
      platform_comment_delivery_status VARCHAR(64),
      platform_comment_id VARCHAR(128),
      platform_comment_url TEXT,
      cloud_doc_token VARCHAR(255),
      cloud_doc_url TEXT,
      cloud_doc_title TEXT,
      cloud_doc_status VARCHAR(128),
      cloud_doc_last_error TEXT,
      last_delivery_error TEXT,
      delivery_retry_count INT NOT NULL DEFAULT 0,
      effective_rules_json MEDIUMTEXT NOT NULL,
      manual_decision VARCHAR(64),
      manual_decision_by VARCHAR(64),
      manual_decision_at VARCHAR(64),
      markdown_body MEDIUMTEXT,
      raw_model_output MEDIUMTEXT,
      error TEXT,
      started_at VARCHAR(64),
      completed_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY idx_review_runs_idempotency_key (idempotency_key),
      KEY idx_review_runs_repository_created (repository_id, created_at DESC),
      KEY idx_review_runs_repo_updated (repository_id, updated_at DESC, created_at DESC),
      KEY idx_review_runs_updated (updated_at DESC, created_at DESC),
      KEY idx_review_runs_repo_status_completed (repository_id, status, completed_at DESC, created_at DESC),
      KEY idx_review_runs_status_created (status, created_at ASC),
      KEY idx_review_runs_repo_status_created (repository_id, status, created_at ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_branch_states (
      repository_id VARCHAR(64) NOT NULL,
      stage VARCHAR(128) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      last_run_id VARCHAR(64),
      head_sha VARCHAR(128),
      baseline_sha VARCHAR(128),
      baseline_source VARCHAR(128),
      result_state VARCHAR(64),
      status VARCHAR(64),
      actor VARCHAR(128),
      summary MEDIUMTEXT,
      reviewed_at VARCHAR(64),
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (repository_id, stage, branch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_remote_branch_cache (
      repository_id VARCHAR(64) PRIMARY KEY,
      branches_json MEDIUMTEXT NOT NULL,
      fetched_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_conversation_bindings (
      repository_id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(128) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_review_conversation_bindings_chat_jid (chat_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS review_repository_members (
      repository_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      access_level VARCHAR(64) NOT NULL DEFAULT 'viewer',
      granted_at VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64),
      PRIMARY KEY (repository_id, user_id),
      KEY idx_review_repo_members_user (user_id),
      KEY idx_review_repo_members_repo_granted (repository_id, granted_at ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_config (
      \`key\` VARCHAR(128) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_config_state (
      scope VARCHAR(128) PRIMARY KEY,
      version INT NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_config_history (
      id VARCHAR(64) PRIMARY KEY,
      version INT NOT NULL,
      config_entries_json TEXT NOT NULL,
      changed_keys_json TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_config_presets (
      id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_tasks (
      id VARCHAR(64) PRIMARY KEY,
      stock_code VARCHAR(64) NOT NULL,
      market VARCHAR(64) NOT NULL,
      stock_name VARCHAR(128),
      status VARCHAR(64) NOT NULL,
      report_type VARCHAR(64) NOT NULL,
      strategy_preset VARCHAR(128) NOT NULL DEFAULT 'bull_trend',
      force_refresh INT NOT NULL DEFAULT 0,
      result_mode VARCHAR(64) NOT NULL DEFAULT 'generated',
      error TEXT,
      report_id VARCHAR(64),
      data_as_of VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      started_at VARCHAR(64),
      completed_at VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_reports (
      id VARCHAR(64) PRIMARY KEY,
      stock_code VARCHAR(64) NOT NULL,
      market VARCHAR(64) NOT NULL,
      stock_name VARCHAR(128),
      report_type VARCHAR(64) NOT NULL,
      score INT NOT NULL DEFAULT 0,
      trend TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      current_price DOUBLE,
      change_pct DOUBLE,
      data_as_of VARCHAR(64),
      history_days INT NOT NULL DEFAULT 180,
      summary_json MEDIUMTEXT NOT NULL,
      detail_json MEDIUMTEXT NOT NULL,
      model_used TEXT,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_market_reviews (
      id VARCHAR(64) PRIMARY KEY,
      market_scope TEXT NOT NULL,
      trade_date VARCHAR(64),
      summary_json MEDIUMTEXT NOT NULL,
      detail_json MEDIUMTEXT NOT NULL,
      model_used TEXT,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS stock_analysis_watchlist (
      stock_code VARCHAR(64) PRIMARY KEY,
      market VARCHAR(64) NOT NULL,
      stock_name VARCHAR(128) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_search_indexes (
      cache_key VARCHAR(255) PRIMARY KEY,
      root_directory TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      build_options_json TEXT NOT NULL,
      generated_at VARCHAR(64) NOT NULL,
      file_count INT NOT NULL DEFAULT 0,
      symbol_count INT NOT NULL DEFAULT 0,
      term_count INT NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_search_index_files (
      cache_key VARCHAR(255) NOT NULL,
      relative_path VARCHAR(1024) NOT NULL,
      absolute_path TEXT NOT NULL,
      extension VARCHAR(64) NOT NULL,
      language VARCHAR(64) NOT NULL,
      byte_size INT NOT NULL,
      line_count INT NOT NULL,
      imports_json TEXT NOT NULL,
      previews_json TEXT NOT NULL,
      PRIMARY KEY (cache_key, relative_path(255))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_search_index_symbols (
      cache_key VARCHAR(255) NOT NULL,
      relative_path VARCHAR(1024) NOT NULL,
      ordinal INT NOT NULL,
      name VARCHAR(128) NOT NULL,
      kind VARCHAR(64) NOT NULL,
      line INT NOT NULL,
      column_number INT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (cache_key, relative_path(255), ordinal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_search_index_terms (
      cache_key VARCHAR(255) NOT NULL,
      relative_path VARCHAR(1024) NOT NULL,
      ordinal INT NOT NULL,
      term VARCHAR(128) NOT NULL,
      PRIMARY KEY (cache_key, relative_path(255), ordinal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_map_ai_analyses (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      target_path VARCHAR(255) NOT NULL,
      target_type VARCHAR(16) NOT NULL,
      manifest_hash VARCHAR(128) NOT NULL,
      analysis_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_code_map_ai_analyses (repository_id, branch, target_path(191), manifest_hash(64))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_index_snapshots (
      snapshot_id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      root_directory VARCHAR(255) NOT NULL,
      source_kind VARCHAR(32) NOT NULL DEFAULT 'unknown',
      source_branch VARCHAR(128) NOT NULL DEFAULT '',
      source_head_sha VARCHAR(64) NOT NULL DEFAULT '',
      manifest_hash VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      stage VARCHAR(32) NOT NULL,
      processed_files INT NOT NULL,
      total_files INT NOT NULL,
      message VARCHAR(255) NOT NULL,
      error_message TEXT,
      generated_at VARCHAR(64) DEFAULT NULL,
      stats_json MEDIUMTEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_code_index_snapshots_repo_branch (repository_id, branch)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_index_files (
      snapshot_id VARCHAR(64) NOT NULL,
      relative_path VARCHAR(255) NOT NULL,
      language VARCHAR(64) NOT NULL,
      byte_size INT NOT NULL,
      line_count INT NOT NULL,
      file_hash VARCHAR(64) NOT NULL,
      \`rank\` DOUBLE NOT NULL,
      import_count INT NOT NULL,
      export_count INT NOT NULL,
      summary_text TEXT NOT NULL,
      summary_source VARCHAR(16) NOT NULL DEFAULT 'fallback',
      PRIMARY KEY (snapshot_id, relative_path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_index_chunks (
      id VARCHAR(64) PRIMARY KEY,
      snapshot_id VARCHAR(64) NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      chunk_index INT NOT NULL,
      start_line INT NOT NULL,
      end_line INT NOT NULL,
      content MEDIUMTEXT NOT NULL,
      token_count INT NOT NULL,
      summary_text TEXT NOT NULL,
      content_hash VARCHAR(64) NOT NULL,
      summary_source VARCHAR(16) NOT NULL DEFAULT 'fallback'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_index_functions (
      id VARCHAR(64) PRIMARY KEY,
      snapshot_id VARCHAR(64) NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      name VARCHAR(128) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      signature TEXT NOT NULL,
      start_line INT NOT NULL,
      end_line INT NOT NULL,
      line INT NOT NULL,
      column_number INT NOT NULL,
      parent_function_id VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS code_index_function_edges (
      id VARCHAR(64) PRIMARY KEY,
      snapshot_id VARCHAR(64) NOT NULL,
      from_function_id VARCHAR(64) NOT NULL,
      to_function_id VARCHAR(64) NOT NULL,
      edge_type VARCHAR(32) NOT NULL,
      symbol_name VARCHAR(128) NOT NULL,
      line INT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(128) UNIQUE NOT NULL,
      display_name VARCHAR(128),
      password_hash TEXT NOT NULL,
      email VARCHAR(255),
      auth_source VARCHAR(64) NOT NULL DEFAULT 'local',
      status VARCHAR(64) NOT NULL DEFAULT 'active',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS roles (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) UNIQUE NOT NULL,
      description TEXT,
      is_system INT DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS permissions (
      id VARCHAR(64) PRIMARY KEY,
      code VARCHAR(128) UNIQUE NOT NULL,
      name VARCHAR(128) NOT NULL,
      category VARCHAR(128) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id VARCHAR(64) NOT NULL,
      permission_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (role_id, permission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id VARCHAR(64) NOT NULL,
      role_id VARCHAR(64) NOT NULL,
      granted_at VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64),
      created_at VARCHAR(64),
      updated_at VARCHAR(64),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      PRIMARY KEY (user_id, role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      expires_at VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      ip_address VARCHAR(128),
      user_agent TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_souls (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(128),
      emoji VARCHAR(64),
      emoji_enabled INT NOT NULL DEFAULT 0,
      creature VARCHAR(128),
      vibe TEXT,
      persona_prompt TEXT,
      tone VARCHAR(64),
      language_preference VARCHAR(64),
      extra_instructions TEXT,
      user_nickname VARCHAR(128),
      behavior_rules TEXT,
      auto_evolve INT NOT NULL DEFAULT 1,
      consolidation_config TEXT,
      enabled INT NOT NULL DEFAULT 1,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uk_user_souls_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_soul_memories (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      category VARCHAR(64) NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      importance INT NOT NULL DEFAULT 5,
      source VARCHAR(64),
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_user_soul_memories_user (user_id, importance, updated_at),
      KEY idx_user_soul_memories_category (user_id, category, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_memories (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      scope VARCHAR(32) NOT NULL DEFAULT 'global',
      conversation_id VARCHAR(64),
      category VARCHAR(64) NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      importance INT NOT NULL DEFAULT 5,
      confidence DOUBLE NOT NULL DEFAULT 0.5,
      source VARCHAR(64) NOT NULL DEFAULT 'manual',
      tier VARCHAR(32) NOT NULL DEFAULT 'durable',
      promoted_from VARCHAR(64),
      last_verified_at VARCHAR(64),
      source_event_id VARCHAR(64),
      valid_from VARCHAR(64),
      valid_to VARCHAR(64),
      access_count INT NOT NULL DEFAULT 0,
      last_accessed_at VARCHAR(64),
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_user_memories_user (user_id, importance, updated_at),
      KEY idx_user_memories_scope (user_id, scope, conversation_id),
      KEY idx_user_memories_category (user_id, category, updated_at),
      KEY idx_user_memories_tier (user_id, tier, importance)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_memory_observations (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      conversation_id VARCHAR(64),
      category VARCHAR(64) NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      observation_type VARCHAR(64) NOT NULL DEFAULT 'fact',
      frequency INT NOT NULL DEFAULT 1,
      last_seen_at VARCHAR(64) NOT NULL,
      confidence DOUBLE NOT NULL DEFAULT 0.3,
      source VARCHAR(64) NOT NULL DEFAULT 'llm_extract',
      promoted_to VARCHAR(64),
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_user_memory_obs_user (user_id, frequency, confidence),
      KEY idx_user_memory_obs_type (user_id, observation_type, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS persona_insights (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      insight_type VARCHAR(64) NOT NULL,
      content TEXT NOT NULL,
      evidence_count INT NOT NULL DEFAULT 1,
      confidence DOUBLE NOT NULL DEFAULT 0.3,
      status VARCHAR(32) NOT NULL DEFAULT 'candidate',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_persona_insights_user (user_id, status, confidence)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_consolidation_log (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      run_type VARCHAR(32) NOT NULL DEFAULT 'scheduled',
      observations_reviewed INT NOT NULL DEFAULT 0,
      promoted INT NOT NULL DEFAULT 0,
      merged INT NOT NULL DEFAULT 0,
      pruned INT NOT NULL DEFAULT 0,
      insights_generated INT NOT NULL DEFAULT 0,
      duration_ms INT,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_memory_consolidation_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_extraction_log (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      conversation_id VARCHAR(64),
      source_message_ids TEXT,
      extracted_memories TEXT,
      model_used VARCHAR(128),
      tokens_used INT,
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_events (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64),
      scope VARCHAR(128) NOT NULL DEFAULT 'global',
      action_type VARCHAR(32) NOT NULL,
      target_type VARCHAR(32) NOT NULL,
      target_id VARCHAR(64),
      conversation_id VARCHAR(64),
      source_message_id VARCHAR(64),
      before_snapshot TEXT,
      after_snapshot TEXT,
      decision_reason TEXT,
      metadata_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_memory_events_user (user_id, created_at DESC),
      KEY idx_memory_events_user_action_time (user_id, action_type, created_at DESC),
      KEY idx_memory_events_target (target_type, target_id, created_at DESC),
      KEY idx_memory_events_action (action_type, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS embedding_vectors (
      id VARCHAR(64) PRIMARY KEY,
      owner_type VARCHAR(32) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      embedding_provider_id VARCHAR(64) NULL,
      content_hash VARCHAR(64) NOT NULL,
      embedding MEDIUMBLOB NOT NULL,
      dimensions INT NOT NULL,
      model_name VARCHAR(128) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_embedding_vectors_owner (owner_type, owner_id),
      KEY idx_embedding_vectors_owner_provider (owner_type, embedding_provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS memory_skills (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64),
      scope VARCHAR(128) NOT NULL DEFAULT 'global',
      name VARCHAR(255) NOT NULL,
      trigger_pattern TEXT NOT NULL,
      body TEXT NOT NULL,
      termination_condition TEXT,
      success_count INT NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      last_used_at VARCHAR(64),
      last_verified_at VARCHAR(64),
      status VARCHAR(32) NOT NULL DEFAULT 'candidate',
      metadata_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_memory_skills_user (user_id, status, updated_at DESC),
      KEY idx_memory_skills_scope (scope, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      owner_type VARCHAR(32) NOT NULL DEFAULT 'system',
      owner_id VARCHAR(64),
      embedding_model VARCHAR(128),
      embedding_provider_id VARCHAR(64) NULL,
      chunk_size INT NOT NULL DEFAULT 300,
      chunk_overlap INT NOT NULL DEFAULT 60,
      cleanup_patterns TEXT,
      enabled INT NOT NULL DEFAULT 1,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id VARCHAR(64) PRIMARY KEY,
      kb_id VARCHAR(64) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      content_type VARCHAR(64) NOT NULL DEFAULT 'text/plain',
      content_hash VARCHAR(64) NOT NULL,
      char_count INT NOT NULL DEFAULT 0,
      chunk_count INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_knowledge_docs_kb (kb_id, status),
      KEY idx_knowledge_docs_kb_active_created (kb_id, deleted_at, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id VARCHAR(64) PRIMARY KEY,
      document_id VARCHAR(64) NOT NULL,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      token_count INT NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_knowledge_chunks_doc (document_id, chunk_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS file_store (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category VARCHAR(128) NOT NULL,
      path_ref VARCHAR(1024) NOT NULL,
      content LONGTEXT NOT NULL,
      content_hash VARCHAR(128),
      metadata_json TEXT,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_file_store_cat_path_user (category, path_ref(255), user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS live2d_models (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      visibility VARCHAR(64) NOT NULL DEFAULT 'private',
      format VARCHAR(64) NOT NULL DEFAULT 'cubism4',
      model_data LONGBLOB,
      thumbnail MEDIUMBLOB,
      file_size INT DEFAULT 0,
      entry_file VARCHAR(255),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_live2d_models_user (user_id, visibility, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS live2d_emotion_mappings (
      id VARCHAR(64) PRIMARY KEY,
      model_id VARCHAR(64) NOT NULL,
      emotion VARCHAR(64) NOT NULL,
      motion_group VARCHAR(128),
      expression_name VARCHAR(128),
      priority INT DEFAULT 0,
      KEY idx_live2d_emotion_mappings_model (model_id, emotion)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS live2d_user_preferences (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      enabled INT DEFAULT 0,
      selected_model_id VARCHAR(64),
      position VARCHAR(64) DEFAULT 'right',
      panel_width INT DEFAULT 280,
      opacity INT DEFAULT 100,
      emotion_provider_id VARCHAR(64),
      model_scale FLOAT DEFAULT 1.0,
      model_offset_y INT DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_live2d_prefs_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      name VARCHAR(128) NOT NULL,
      description TEXT,
      command VARCHAR(255) NOT NULL,
      args_json TEXT NOT NULL,
      env_json TEXT NOT NULL,
      metadata_json TEXT,
      enabled INT NOT NULL DEFAULT 1,
      visibility VARCHAR(64) NOT NULL DEFAULT 'private',
      source_type VARCHAR(64) NOT NULL DEFAULT 'manual',
      source_ref VARCHAR(255),
      icon_url TEXT,
      tags_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_user_mcp_servers_user (user_id, enabled),
      KEY idx_user_mcp_servers_visibility (visibility, updated_at DESC),
      KEY idx_user_mcp_servers_user_list (user_id, deleted_at, updated_at DESC),
      KEY idx_user_mcp_servers_visibility_list (visibility, deleted_at, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS user_skills (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      name VARCHAR(128) NOT NULL,
      description TEXT,
      summary TEXT,
      skill_content MEDIUMTEXT,
      metadata_json TEXT,
      enabled INT NOT NULL DEFAULT 1,
      visibility VARCHAR(64) NOT NULL DEFAULT 'private',
      source_type VARCHAR(64) NOT NULL DEFAULT 'manual',
      source_ref VARCHAR(255),
      icon_url TEXT,
      tags_json TEXT,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_user_skills_user (user_id, enabled),
      KEY idx_user_skills_visibility (visibility, updated_at DESC),
      KEY idx_user_skills_user_list (user_id, deleted_at, updated_at DESC),
      KEY idx_user_skills_visibility_list (visibility, deleted_at, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS marketplace_sources (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      source VARCHAR(255) NOT NULL,
      enabled INT NOT NULL DEFAULT 1,
      description TEXT,
      icon_url TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_marketplace_sources_list (deleted_at, sort_order ASC, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS marketplace_installs (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      source_id VARCHAR(64),
      entry_name VARCHAR(128) NOT NULL,
      entry_type VARCHAR(64) NOT NULL,
      installed_version VARCHAR(64),
      target_id VARCHAR(64),
      status VARCHAR(64) NOT NULL DEFAULT 'installed',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_marketplace_installs_user (user_id, entry_type),
      KEY idx_marketplace_installs_source (source_id),
      KEY idx_marketplace_installs_user_list (user_id, deleted_at, updated_at DESC),
      KEY idx_marketplace_installs_target_active (target_id, deleted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      username VARCHAR(128),
      action VARCHAR(128) NOT NULL,
      target_type VARCHAR(64),
      target_id VARCHAR(64),
      target_name VARCHAR(255),
      details_json TEXT,
      ip_address VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      INDEX idx_audit_log_user (user_id),
      INDEX idx_audit_log_action (action),
      INDEX idx_audit_log_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS resource_bindings (
      id VARCHAR(64) PRIMARY KEY,
      resource_type VARCHAR(64) NOT NULL,
      resource_id VARCHAR(64) NOT NULL,
      owner_type VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      binding_key VARCHAR(128) NOT NULL DEFAULT 'default',
      branch VARCHAR(128),
      work_directory TEXT,
      config_json TEXT,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_resource_binding (resource_type, resource_id, owner_type, owner_id, binding_key),
      KEY idx_rb_owner (owner_type, owner_id),
      KEY idx_rb_resource (resource_type, resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS repository_worktrees (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      work_directory TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at VARCHAR(64) NOT NULL,
      last_used_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_rwt_repo_branch (repository_id, branch),
      KEY idx_rwt_last_used (last_used_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
}

export async function runMySQLMigrations(engine: DbEngine): Promise<void> {
  const safeMigrate = async (sql: string) => {
    try {
      await engine.exec(sql);
    } catch (err) {
      if (isDuplicateObjectError(err)) return;
      // Non-duplicate failures (permissions, locks, syntax, missing refs) must
      // surface — silently continuing would boot a half-migrated schema and
      // produce opaque runtime errors later.
      logger.error(
        { err, sql: sql.slice(0, 200) },
        'MySQL migration failed; aborting startup',
      );
      throw err;
    }
  };

  const safeFullTextMigrate = async (sql: string) => {
    try {
      await engine.exec(sql);
    } catch (err) {
      if (isDuplicateObjectError(err)) return;
      if (isMySqlFullTextUnsupportedError(err)) {
        logger.warn(
          { sql: sql.slice(0, 200) },
          'MySQL FULLTEXT unsupported; skipping optional index',
        );
        return;
      }
      logger.error(
        { err, sql: sql.slice(0, 200) },
        'MySQL migration failed; aborting startup',
      );
      throw err;
    }
  };

  await safeMigrate(
    `INSERT IGNORE INTO stock_analysis_config_state (scope, version, updated_at) VALUES ('global', 0, '0')`,
  );

  // ── Multi-tenant migration: add user_id to core tables ────────────
  const tenantTables = [
    'chats',
    'messages',
    'assistants',
    'ai_providers',
    'registered_groups',
    'scheduled_tasks',
    'context_entries',
    'assistant_turns',
    'memory_documents',
  ];
  for (const table of tenantTables) {
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
  }

  await safeMigrate(
    `CREATE INDEX idx_chats_user_id ON chats(user_id, last_message_time DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_messages_user_id ON messages(user_id, chat_jid, \`timestamp\`)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_assistants_user_id ON assistants(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_ai_providers_user_id ON ai_providers(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_registered_groups_user_id ON registered_groups(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_user_id ON scheduled_tasks(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_entries_user_id ON context_entries(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_memory_documents_user_id ON memory_documents(user_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS channel_instances (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      type VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      enabled INT DEFAULT 1,
      config_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(
    `CREATE INDEX idx_channel_instances_user ON channel_instances(user_id, type)`,
  );
  await safeMigrate(
    `ALTER TABLE channel_instances ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'private'`,
  );

  // Phase 2b: review / code search cache / stock analysis tables
  const extTenantTables = [
    'review_repositories',
    'review_profiles',
    'review_runs',
    'review_branch_states',
    'review_remote_branch_cache',
    'review_conversation_bindings',
    'code_index_snapshots',
    'code_search_indexes',
    'code_search_index_files',
    'code_search_index_symbols',
    'code_search_index_terms',
    'stock_analysis_config',
    'stock_analysis_config_state',
    'stock_analysis_config_history',
    'stock_analysis_config_presets',
    'stock_analysis_tasks',
    'stock_analysis_reports',
    'stock_analysis_market_reviews',
    'stock_analysis_watchlist',
  ];
  for (const table of extTenantTables) {
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
  }
  await safeMigrate(
    `CREATE INDEX idx_review_repos_user ON review_repositories(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_user ON review_runs(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_tasks_user ON stock_analysis_tasks(user_id)`,
  );

  // ── Parity indexes: align with SQLite createSchema ────────────────
  // Messages
  await safeMigrate(`CREATE INDEX idx_timestamp ON messages(\`timestamp\`)`);
  await safeMigrate(
    `CREATE INDEX idx_messages_chat_timestamp ON messages(chat_jid, \`timestamp\`)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_messages_chat_timestamp_desc ON messages(chat_jid, \`timestamp\` DESC)`,
  );
  // Conversation participants
  await safeMigrate(
    `CREATE INDEX idx_conversation_participants_chat_last_seen ON conversation_participants(chat_jid, last_seen_at)`,
  );
  // Assistant turns
  await safeMigrate(
    `CREATE INDEX idx_assistant_turns_chat_timestamp ON assistant_turns(chat_jid, \`timestamp\`)`,
  );
  // Context entries
  await safeMigrate(
    `CREATE INDEX idx_context_entries_group_chat_created ON context_entries(group_folder, chat_jid, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_entries_chat_created ON context_entries(chat_jid, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_entries_source_ref ON context_entries(source_ref(255))`,
  );
  // Identity
  await safeMigrate(
    `CREATE INDEX idx_conversation_identity_bindings_person ON conversation_identity_bindings(person_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_identity_aliases_person ON identity_aliases(person_id)`,
  );
  // Memory documents
  await safeMigrate(
    `CREATE INDEX idx_memory_documents_owner ON memory_documents(owner_type, owner_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_memory_documents_source ON memory_documents(source_type)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_memory_document_sync_state_owner ON memory_document_sync_state(owner_type, owner_id)`,
  );
  // Compaction
  await safeMigrate(
    `CREATE INDEX idx_context_compactions_chat_created ON context_compactions(chat_jid, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_compactions_chat_compacted_until ON context_compactions(chat_jid, compacted_until)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_compaction_jobs_pending_available ON context_compaction_jobs(pending, available_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_compaction_jobs_runtime_claimed ON context_compaction_jobs(runtime_claimed_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_compaction_run_logs_finished ON context_compaction_run_logs(finished_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_context_compaction_run_logs_chat_finished ON context_compaction_run_logs(chat_jid, finished_at)`,
  );
  // Scheduled tasks
  await safeMigrate(`CREATE INDEX idx_next_run ON scheduled_tasks(next_run)`);
  await safeMigrate(`CREATE INDEX idx_status ON scheduled_tasks(status)`);
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_status_next_run ON scheduled_tasks(status, next_run)`,
  );
  // Task run logs
  await safeMigrate(
    `CREATE INDEX idx_task_run_logs ON task_run_logs(task_id, run_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_task_run_logs_task_run_desc ON task_run_logs(task_id, run_at DESC)`,
  );
  // Assistants
  await safeMigrate(
    `CREATE INDEX idx_assistants_enabled_updated ON assistants(enabled, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE UNIQUE INDEX idx_assistant_mcp_bindings_assistant_template ON assistant_mcp_bindings(assistant_id, template_server_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_assistant_mcp_bindings_assistant_updated ON assistant_mcp_bindings(assistant_id, updated_at DESC)`,
  );
  // Stock analysis
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_config_history_created ON stock_analysis_config_history(created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_config_presets_updated ON stock_analysis_config_presets(updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_tasks_created ON stock_analysis_tasks(created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_tasks_status_created ON stock_analysis_tasks(status, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_reports_created ON stock_analysis_reports(created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_reports_code_created ON stock_analysis_reports(stock_code, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_market_reviews_created ON stock_analysis_market_reviews(created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_stock_analysis_watchlist_updated ON stock_analysis_watchlist(updated_at DESC, stock_code ASC)`,
  );
  // Review
  await safeMigrate(
    `CREATE INDEX idx_review_profiles_repository_stage ON review_profiles(repository_id, stage, enabled)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_repository_created ON review_runs(repository_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_branch_states_repository_stage ON review_branch_states(repository_id, stage, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_remote_branch_cache_fetched ON review_remote_branch_cache(fetched_at DESC)`,
  );
  // Digest columns on review_repositories
  for (const col of [
    'digest_daily_enabled INT NOT NULL DEFAULT 0',
    'digest_weekly_enabled INT NOT NULL DEFAULT 0',
    'digest_daily_hour INT NOT NULL DEFAULT 18',
    'digest_weekly_day INT NOT NULL DEFAULT 5',
    'digest_weekly_hour INT NOT NULL DEFAULT 18',
    'last_digest_daily_at VARCHAR(64)',
    'next_digest_daily_at VARCHAR(64)',
    'last_digest_weekly_at VARCHAR(64)',
    'next_digest_weekly_at VARCHAR(64)',
  ]) {
    await safeMigrate(`ALTER TABLE review_repositories ADD COLUMN ${col}`);
  }
  await safeMigrate(
    `ALTER TABLE review_repositories ADD COLUMN allow_ai_fix INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS review_digest_runs (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      type VARCHAR(16) NOT NULL,
      scheduled_for VARCHAR(64) NOT NULL DEFAULT '',
      period_start VARCHAR(64) NOT NULL,
      period_end VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      timezone VARCHAR(128) NOT NULL DEFAULT '',
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      duration_ms INT NOT NULL DEFAULT 0,
      branch_count INT NOT NULL DEFAULT 0,
      commit_count INT NOT NULL DEFAULT 0,
      contributor_count INT NOT NULL DEFAULT 0,
      summary MEDIUMTEXT NOT NULL,
      cloud_doc_url VARCHAR(255) NOT NULL DEFAULT '',
      cloud_doc_status VARCHAR(32) NOT NULL DEFAULT '',
      delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      delivery_error TEXT NOT NULL,
      error_message TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      INDEX idx_review_digest_runs_repo_type_created (repository_id, type, created_at DESC),
      INDEX idx_review_digest_runs_repo_scheduled (repository_id, scheduled_for DESC, created_at DESC),
      INDEX idx_review_digest_runs_repo_type_status_created (repository_id, type, status, created_at DESC),
      INDEX idx_review_digest_runs_schedule_status (repository_id, type, scheduled_for, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN scheduled_for VARCHAR(64) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN timezone VARCHAR(128) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN started_at VARCHAR(64) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN duration_ms INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending'`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN delivery_error TEXT`,
  );
  // Code search index cache
  await safeMigrate(
    `CREATE INDEX idx_code_search_indexes_root_updated ON code_search_indexes(root_directory(255), updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_search_index_symbols_cache_file ON code_search_index_symbols(cache_key, relative_path(255))`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_search_index_terms_cache_file ON code_search_index_terms(cache_key, relative_path(255))`,
  );
  // Code map AI analyses
  await safeMigrate(
    `CREATE INDEX idx_code_map_ai_analyses_lookup ON code_map_ai_analyses(repository_id, branch, target_path(191))`,
  );
  // Code index
  await safeMigrate(
    `ALTER TABLE code_index_files ADD COLUMN summary_source VARCHAR(16) NOT NULL DEFAULT 'fallback'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_chunks ADD COLUMN summary_source VARCHAR(16) NOT NULL DEFAULT 'fallback'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN source_kind VARCHAR(32) NOT NULL DEFAULT 'unknown'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN source_branch VARCHAR(128) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN source_head_sha VARCHAR(64) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_snapshots_repo_branch ON code_index_snapshots(repository_id, branch)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_files_snapshot_rank ON code_index_files(snapshot_id, \`rank\`, relative_path)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_chunks_snapshot_file ON code_index_chunks(snapshot_id, file_path(191), chunk_index)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_functions_snapshot_file ON code_index_functions(snapshot_id, file_path(191), line)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_function_edges_from ON code_index_function_edges(snapshot_id, from_function_id, line)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_code_index_function_edges_to ON code_index_function_edges(snapshot_id, to_function_id, line)`,
  );
  // Auth
  await safeMigrate(
    `CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at)`,
  );
  // User soul / memories
  await safeMigrate(
    `CREATE INDEX idx_user_soul_memories_user ON user_soul_memories(user_id, importance DESC, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_soul_memories_category ON user_soul_memories(user_id, category, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_memories_user ON user_memories(user_id, importance DESC, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_memories_scope ON user_memories(user_id, scope, conversation_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_memories_category ON user_memories(user_id, category, updated_at DESC)`,
  );
  // MySQL FULLTEXT index for native fulltext search on user_memories
  await safeFullTextMigrate(
    `CREATE FULLTEXT INDEX ft_user_memories_content ON user_memories(content)`,
  );
  // Memory confidence field for lifecycle management
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN confidence DOUBLE NOT NULL DEFAULT 0.5`,
  );
  // Live2D preference fields added after initial rollout
  await safeMigrate(
    `ALTER TABLE live2d_user_preferences ADD COLUMN model_scale FLOAT DEFAULT 1.0`,
  );
  await safeMigrate(
    `ALTER TABLE live2d_user_preferences ADD COLUMN model_offset_y INT DEFAULT 0`,
  );
  // Soul module v2 fields
  await safeMigrate(
    `ALTER TABLE user_souls ADD COLUMN emoji_enabled INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(`ALTER TABLE user_souls ADD COLUMN behavior_rules TEXT`);
  await safeMigrate(
    `ALTER TABLE user_souls ADD COLUMN auto_evolve INT NOT NULL DEFAULT 1`,
  );
  await safeMigrate(
    `ALTER TABLE user_souls ADD COLUMN consolidation_config TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN tier VARCHAR(32) NOT NULL DEFAULT 'durable'`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN promoted_from VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN last_verified_at VARCHAR(64)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_memories_tier ON user_memories(user_id, tier, importance)`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN source_event_id VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN valid_from VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN valid_to VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE memory_events ADD INDEX idx_memory_events_user_action_time (user_id, action_type, created_at DESC)`,
  );

  // Runtime state persistence tables
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS pending_uploads (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(128) NOT NULL,
      message_id VARCHAR(64) NOT NULL,
      files_json TEXT NOT NULL,
      upload_timestamp VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_pending_uploads_chat (chat_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS runtime_state (
      state_key VARCHAR(128) PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS conversation_shares (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(128) NOT NULL,
      title VARCHAR(255),
      content MEDIUMTEXT NOT NULL,
      assistant_name VARCHAR(128),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      view_count INT DEFAULT 0,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      KEY idx_shares_user_id (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Startup cleanup: supersede duplicate active stock analysis tasks
  // (MySQL does not support partial unique indexes, but CTE cleanup provides
  // the same runtime invariant as SQLite's idx_stock_analysis_tasks_active_code)
  await safeMigrate(`
    WITH ranked AS (
      SELECT id,
        ROW_NUMBER() OVER (
          PARTITION BY stock_code
          ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
                   created_at DESC, id DESC
        ) AS rn
      FROM stock_analysis_tasks
      WHERE status IN ('pending', 'running')
    )
    UPDATE stock_analysis_tasks
    SET status = 'failed',
        error = COALESCE(error, 'Superseded by another active stock analysis task'),
        completed_at = COALESCE(completed_at, created_at)
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  `);

  await safeMigrate(
    `ALTER TABLE users ADD COLUMN auth_source VARCHAR(64) NOT NULL DEFAULT 'local'`,
  );

  // chats.mode column was in CREATE TABLE but missed for existing databases
  await safeMigrate(
    `ALTER TABLE chats ADD COLUMN mode VARCHAR(64) DEFAULT NULL`,
  );

  // Migration: allow multiple repositories per chat_jid (drop UNIQUE, add plain INDEX)
  await safeMigrate(
    `ALTER TABLE review_conversation_bindings DROP INDEX idx_review_conversation_bindings_chat_jid`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_conversation_bindings_chat_jid ON review_conversation_bindings(chat_jid)`,
  );

  // Migration: per-conversation provider/model override on registered_groups
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN provider_id VARCHAR(64) DEFAULT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN model VARCHAR(128) DEFAULT NULL`,
  );

  // ── IM Chat tables ────────────────────────────────────────────────
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_chat_meta (
      chat_jid VARCHAR(255) PRIMARY KEY,
      chat_type VARCHAR(64) NOT NULL,
      visibility VARCHAR(64) NOT NULL DEFAULT 'private',
      owner_id VARCHAR(64) NOT NULL,
      name VARCHAR(128),
      avatar_url VARCHAR(255),
      notice TEXT,
      e2ee_enabled INT NOT NULL DEFAULT 0,
      max_members INT DEFAULT 200,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_im_chat_meta_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_memberships (
      chat_jid VARCHAR(255) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      \`role\` VARCHAR(64) NOT NULL DEFAULT 'member',
      nickname VARCHAR(128),
      status VARCHAR(64) NOT NULL DEFAULT 'active',
      muted_until VARCHAR(64),
      joined_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, user_id),
      KEY idx_im_memberships_user (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_room_state (
      chat_jid VARCHAR(255) NOT NULL PRIMARY KEY,
      last_seq BIGINT NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_events (
      chat_jid VARCHAR(255) NOT NULL,
      seq BIGINT NOT NULL,
      event_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, seq),
      KEY idx_im_events_chat_seq (chat_jid, seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_conversation_prefs (
      chat_jid VARCHAR(255) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      is_pinned INT NOT NULL DEFAULT 0,
      is_muted INT NOT NULL DEFAULT 0,
      is_archived INT NOT NULL DEFAULT 0,
      draft_text TEXT,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_notifications (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      chat_jid VARCHAR(255),
      event_type VARCHAR(64) NOT NULL,
      actor_id VARCHAR(64),
      message_id VARCHAR(64),
      title VARCHAR(255),
      body TEXT,
      is_read INT NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_im_notifications_user_read_created (user_id, is_read, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_mentions (
      chat_jid VARCHAR(255) NOT NULL,
      message_id VARCHAR(64) NOT NULL,
      mentioned_user_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, message_id, mentioned_user_id),
      KEY idx_im_mentions_user_created (mentioned_user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_blocks (
      user_id VARCHAR(64) NOT NULL,
      blocked_user_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, blocked_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_reports (
      id VARCHAR(64) PRIMARY KEY,
      reporter_id VARCHAR(64) NOT NULL,
      chat_jid VARCHAR(255),
      message_id VARCHAR(64),
      target_user_id VARCHAR(64),
      reason VARCHAR(128) NOT NULL,
      details TEXT,
      status VARCHAR(64) NOT NULL DEFAULT 'open',
      created_at VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_pinned_messages (
      chat_jid VARCHAR(255) NOT NULL,
      message_id VARCHAR(64) NOT NULL,
      pinned_by VARCHAR(64) NOT NULL,
      pinned_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_device_keys (
      user_id VARCHAR(64) NOT NULL,
      device_id VARCHAR(128) NOT NULL,
      public_key TEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_room_keys (
      chat_jid VARCHAR(255) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      device_id VARCHAR(128) NOT NULL,
      wrapped_key TEXT NOT NULL,
      algorithm VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, user_id, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_crypto (
      chat_jid VARCHAR(255) NOT NULL,
      message_id VARCHAR(64) NOT NULL,
      version INT NOT NULL,
      algorithm VARCHAR(64) NOT NULL,
      iv VARCHAR(255) NOT NULL,
      aad TEXT,
      ciphertext MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_calls (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(255) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      call_type VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL,
      started_at VARCHAR(64),
      ended_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_call_participants (
      call_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL,
      joined_at VARCHAR(64),
      left_at VARCHAR(64),
      PRIMARY KEY (call_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_ai_members (
      chat_jid VARCHAR(255) NOT NULL,
      assistant_id VARCHAR(64) NOT NULL,
      display_name VARCHAR(128) NOT NULL,
      kind VARCHAR(64) NOT NULL DEFAULT 'assistant',
      status VARCHAR(64) NOT NULL DEFAULT 'active',
      created_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, assistant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_ai_invocations (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(255) NOT NULL,
      assistant_id VARCHAR(64) NOT NULL,
      trigger_message_id VARCHAR(64),
      requested_by VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL,
      prompt TEXT NOT NULL,
      error_message TEXT,
      created_at VARCHAR(64) NOT NULL,
      completed_at VARCHAR(64)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_friends (
      user_id VARCHAR(64) NOT NULL,
      friend_id VARCHAR(64) NOT NULL,
      remark VARCHAR(128),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, friend_id),
      KEY idx_user_friends_friend (friend_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id VARCHAR(64) PRIMARY KEY,
      from_user_id VARCHAR(64) NOT NULL,
      to_user_id VARCHAR(64) NOT NULL,
      message TEXT,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      KEY idx_friend_requests_to (to_user_id, status),
      KEY idx_friend_requests_from (from_user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_join_requests (
      id VARCHAR(64) PRIMARY KEY,
      chat_jid VARCHAR(255) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      message TEXT,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      handled_by VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      resolved_at VARCHAR(64),
      KEY idx_im_join_requests_chat (chat_jid, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_quotas (
      sender_id VARCHAR(64) NOT NULL,
      recipient_id VARCHAR(64) NOT NULL,
      period_start VARCHAR(64) NOT NULL,
      count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (sender_id, recipient_id, period_start)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // IM file attachments
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_attachments (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      chat_jid VARCHAR(255) NOT NULL,
      message_id VARCHAR(64),
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(128) NOT NULL,
      size INT NOT NULL,
      storage_key VARCHAR(255) NOT NULL,
      uploaded_by VARCHAR(64) NOT NULL,
      expires_at VARCHAR(64),
      created_at VARCHAR(64) NOT NULL,
      INDEX idx_im_attachments_message (message_id),
      INDEX idx_im_attachments_expires (expires_at),
      INDEX idx_im_attachments_chat (chat_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // IM link preview cache
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_link_previews (
      url_hash VARCHAR(64) NOT NULL PRIMARY KEY,
      url TEXT NOT NULL,
      title VARCHAR(255),
      description TEXT,
      image_url TEXT,
      site_name VARCHAR(128),
      fetched_at VARCHAR(64) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // IM message edits history
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_edits (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      message_id VARCHAR(64) NOT NULL,
      old_content MEDIUMTEXT NOT NULL,
      edited_by VARCHAR(64) NOT NULL,
      edited_at VARCHAR(64) NOT NULL,
      INDEX idx_im_message_edits_msg (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // IM reactions
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_reactions (
      message_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      emoji VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // IM read cursors
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_read_cursors (
      chat_jid VARCHAR(255) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      last_read_message_id VARCHAR(64),
      last_read_seq BIGINT,
      last_read_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (chat_jid, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // messages table: add reply_to_id, edited_at, deleted_at columns
  await safeMigrate(`ALTER TABLE messages ADD COLUMN reply_to_id VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE messages ADD COLUMN edited_at VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE messages ADD COLUMN deleted_at VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE messages ADD COLUMN im_seq BIGINT`);
  await safeMigrate(`ALTER TABLE messages ADD COLUMN uploaded_files_json TEXT`);
  await safeMigrate(
    `ALTER TABLE messages ADD INDEX idx_messages_chat_im_seq (chat_jid, im_seq)`,
  );
  await safeMigrate(
    `ALTER TABLE im_read_cursors ADD COLUMN last_read_seq BIGINT`,
  );
  await safeMigrate(
    `ALTER TABLE im_chat_meta ADD COLUMN e2ee_enabled INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE im_ai_invocations ADD COLUMN error_message TEXT`,
  );

  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'public'`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS provider_user_access (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (provider_id, user_id),
      KEY idx_pua_user (user_id),
      KEY idx_pua_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── Workteam multi-agent collaboration tables ────────────────────
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteams (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      process_type VARCHAR(64) NOT NULL DEFAULT 'sequential',
      workflow_config TEXT NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'draft',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_workteams_user (user_id),
      KEY idx_workteams_user_created (user_id, deleted_at, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_agents (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      \`role\` VARCHAR(128) NOT NULL,
      goal TEXT NOT NULL,
      backstory TEXT NOT NULL,
      assistant_id VARCHAR(64) NOT NULL DEFAULT '',
      chat_jid VARCHAR(128) NOT NULL DEFAULT '',
      tools_config TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at VARCHAR(64),
      updated_at VARCHAR(64),
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL,
      KEY idx_workteam_agents_team (team_id, sort_order),
      KEY idx_workteam_agents_team_active_sort (team_id, deleted_at, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_tasks (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL DEFAULT '',
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      dependencies TEXT NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      sort_order INT NOT NULL DEFAULT 0,
      timeout_ms INT NOT NULL DEFAULT 600000,
      retry_limit INT NOT NULL DEFAULT 1,
      eval_config TEXT NOT NULL,
      KEY idx_workteam_tasks_team (team_id, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_runs (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      checkpoint MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workteam_runs_team (team_id),
      KEY idx_workteam_runs_team_created (team_id, created_at DESC),
      KEY idx_workteam_runs_status (status),
      KEY idx_workteam_runs_status_created (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workteam_runs_team_created ON workteam_runs(team_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_workteam_runs_status_created ON workteam_runs(status, created_at)`,
  );

  await safeMigrate(
    `ALTER TABLE workteam_runs ADD COLUMN checkpoint MEDIUMTEXT`,
  );
  await safeMigrate(
    `UPDATE workteam_runs SET checkpoint = '' WHERE checkpoint IS NULL`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_runs MODIFY COLUMN checkpoint MEDIUMTEXT NOT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_tasks ADD COLUMN eval_config TEXT NOT NULL DEFAULT ''`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_run_tasks (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      task_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      output MEDIUMTEXT NOT NULL,
      error TEXT NOT NULL,
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      retry_count INT NOT NULL DEFAULT 0,
      KEY idx_workteam_run_tasks_run (run_id, task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workteam_events_agent_messages ON workteam_events(run_id, target_agent_id, event_type, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_events (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      source_agent_id VARCHAR(64) NOT NULL DEFAULT '',
      target_agent_id VARCHAR(64) NOT NULL DEFAULT '',
      event_type VARCHAR(64) NOT NULL,
      payload MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workteam_events_run (run_id, created_at(64)),
      KEY idx_workteam_events_agent_messages (run_id, target_agent_id, event_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflows (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'draft',
      workflow_config TEXT NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflows_user (user_id, updated_at),
      KEY idx_workflows_user_active_updated (user_id, deleted_at, updated_at DESC, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflows_user_active_updated ON workflows(user_id, deleted_at, updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      node_type VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      role_node_id VARCHAR(64) NOT NULL DEFAULT '',
      assistant_id VARCHAR(64) NOT NULL DEFAULT '',
      config_json TEXT NOT NULL,
      position_x DOUBLE NOT NULL DEFAULT 120,
      position_y DOUBLE NOT NULL DEFAULT 120,
      sort_order INT NOT NULL DEFAULT 0,
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_nodes_workflow (workflow_id, sort_order),
      KEY idx_workflow_nodes_workflow_active_sort (workflow_id, deleted_at, sort_order, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_nodes_workflow_active_sort ON workflow_nodes(workflow_id, deleted_at, sort_order, created_at)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_edges (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      source_node_id VARCHAR(64) NOT NULL,
      target_node_id VARCHAR(64) NOT NULL,
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      label VARCHAR(128) NOT NULL DEFAULT '',
      config_json TEXT NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_edges_workflow (workflow_id, created_at),
      KEY idx_workflow_edges_workflow_active_created (workflow_id, deleted_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_edges_workflow_active_created ON workflow_edges(workflow_id, deleted_at, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input MEDIUMTEXT NOT NULL,
      output MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      KEY idx_workflow_runs_workflow (workflow_id, created_at),
      KEY idx_workflow_runs_workflow_created_desc (workflow_id, created_at DESC),
      KEY idx_workflow_runs_status (status),
      KEY idx_workflow_runs_status_created (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_runs_workflow_created_desc ON workflow_runs(workflow_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_workflow_runs_status_created ON workflow_runs(status, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_nodes (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input_snapshot MEDIUMTEXT NOT NULL,
      manual_input_override MEDIUMTEXT NOT NULL,
      input_anchor_frame_id VARCHAR(64) NOT NULL DEFAULT '',
      input_priority_mode VARCHAR(64) NOT NULL DEFAULT 'feedback_first',
      output_snapshot MEDIUMTEXT NOT NULL,
      last_error TEXT NOT NULL,
      pause_reason TEXT NOT NULL,
      version INT NOT NULL DEFAULT 1,
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_run_nodes_run (run_id, node_id),
      KEY idx_workflow_run_nodes_run_updated (run_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_run_nodes_run_updated ON workflow_run_nodes(run_id, updated_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_messages (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      source_node_id VARCHAR(64) NOT NULL DEFAULT '',
      target_node_id VARCHAR(64) NOT NULL DEFAULT '',
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      message_type VARCHAR(64) NOT NULL DEFAULT 'node_output',
      payload_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_run_messages_run (run_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_interventions (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      intervention_type VARCHAR(64) NOT NULL,
      summary TEXT NOT NULL,
      before_json MEDIUMTEXT NOT NULL,
      after_json MEDIUMTEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_run_interventions_run (run_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_node_executions (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'running',
      runtime_namespace VARCHAR(64) NOT NULL,
      group_folder VARCHAR(64) NOT NULL,
      prompt_text MEDIUMTEXT NOT NULL,
      output_text MEDIUMTEXT NOT NULL,
      error_text TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at VARCHAR(64) NOT NULL DEFAULT '',
      completed_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_node_executions_run (run_id, node_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_node_execution_events (
      id VARCHAR(64) PRIMARY KEY,
      execution_id VARCHAR(64) NOT NULL,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      event_kind VARCHAR(128) NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_node_execution_events_run (run_id, node_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_dialogue_sessions (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      edge_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'active',
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      turn_count INT NOT NULL DEFAULT 0,
      last_source_node_id VARCHAR(64) NOT NULL DEFAULT '',
      last_target_node_id VARCHAR(64) NOT NULL DEFAULT '',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_dialogue_sessions_run (run_id, edge_id, updated_at),
      KEY idx_workflow_dialogue_sessions_lookup_created (run_id, edge_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_dialogue_sessions_lookup_created ON workflow_dialogue_sessions(run_id, edge_id, created_at DESC)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_message_frames (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      edge_id VARCHAR(64) NOT NULL,
      turn_index INT NOT NULL DEFAULT 0,
      frame_type VARCHAR(64) NOT NULL DEFAULT 'node_output',
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      source_node_id VARCHAR(64) NOT NULL DEFAULT '',
      target_node_id VARCHAR(64) NOT NULL DEFAULT '',
      content_text MEDIUMTEXT NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_message_frames_run (run_id, edge_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_pending_transfers (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      edge_id VARCHAR(64) NOT NULL,
      source_node_id VARCHAR(64) NOT NULL DEFAULT '',
      target_node_id VARCHAR(64) NOT NULL DEFAULT '',
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      message_type VARCHAR(64) NOT NULL DEFAULT 'node_output',
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      content_text MEDIUMTEXT NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      delay_ms INT NOT NULL DEFAULT 0,
      due_at VARCHAR(64) NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      released_at VARCHAR(64) NOT NULL DEFAULT '',
      sent_at VARCHAR(64) NOT NULL DEFAULT '',
      cancelled_at VARCHAR(64) NOT NULL DEFAULT '',
      KEY idx_workflow_pending_transfers_run (run_id, created_at),
      KEY idx_workflow_pending_transfers_status_due (run_id, status, due_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_workflow_pending_transfers_status_due ON workflow_pending_transfers(run_id, status, due_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      artifact_type VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      summary TEXT NOT NULL,
      content_text MEDIUMTEXT NOT NULL,
      payload_json MEDIUMTEXT NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'ready',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_workflow_artifacts_run (run_id, artifact_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── ABAC: resource_access, user_permission_overrides, permission_groups ──
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS resource_access (
      id VARCHAR(64) PRIMARY KEY,
      resource_type VARCHAR(64) NOT NULL,
      resource_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      access_level VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      granted_at VARCHAR(64) NOT NULL,
      expires_at VARCHAR(64),
      UNIQUE KEY uq_resource_access (resource_type, resource_id, user_id),
      KEY idx_resource_access_user (user_id, resource_type),
      KEY idx_resource_access_resource (resource_type, resource_id),
      KEY idx_resource_access_user_type_expires (user_id, resource_type, expires_at, resource_id),
      KEY idx_resource_access_resource_expires (resource_type, resource_id, expires_at, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_resource_access_user_type_expires ON resource_access(user_id, resource_type, expires_at, resource_id)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_resource_access_resource_expires ON resource_access(resource_type, resource_id, expires_at, user_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id VARCHAR(64) NOT NULL,
      permission_id VARCHAR(64) NOT NULL,
      effect VARCHAR(64) NOT NULL DEFAULT 'allow',
      granted_by VARCHAR(64) NOT NULL,
      granted_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, permission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS permission_groups (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN module VARCHAR(64) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN description VARCHAR(255) NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN sort_order INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN ui_hint VARCHAR(64) NOT NULL DEFAULT 'action'`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN group_id VARCHAR(64) NOT NULL DEFAULT ''`,
  );

  // ── Knowledge base multi-tenant + categorization ──
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN user_id VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT 'general'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN visibility VARCHAR(64) NOT NULL DEFAULT 'private'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD INDEX idx_knowledge_bases_user (user_id, enabled)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN cleanup_patterns TEXT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN source_url VARCHAR(512)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_source_url (kb_id, source_url(191))`,
  );

  // ── Knowledge base temporal / relational enhancement ──
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN enhancement_level VARCHAR(64) NOT NULL DEFAULT 'metadata'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN llm_provider_id VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN llm_model_override VARCHAR(128) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN embedding_provider_id VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN temporal_half_life_days INT NOT NULL DEFAULT 365`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN capability VARCHAR(32) NOT NULL DEFAULT 'llm'`,
  );
  await safeMigrate(`ALTER TABLE ai_providers ADD COLUMN dimensions INT NULL`);
  await safeMigrate(
    `ALTER TABLE embedding_vectors ADD COLUMN embedding_provider_id VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE embedding_vectors ADD INDEX idx_embedding_vectors_owner_provider (owner_type, embedding_provider_id)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN published_at VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN superseded_by VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN parent_doc_id VARCHAR(64) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN doc_path VARCHAR(255) NULL`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN depth INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN llm_status VARCHAR(64) NULL`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_doc_relations (
      id VARCHAR(64) PRIMARY KEY,
      source_doc_id VARCHAR(64) NOT NULL,
      target_doc_id VARCHAR(64) NOT NULL,
      relation_type VARCHAR(64) NOT NULL,
      confidence FLOAT NOT NULL DEFAULT 0,
      detail TEXT NULL,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_knowledge_doc_relations (source_doc_id, target_doc_id, relation_type),
      KEY idx_knowledge_doc_relations_source (source_doc_id, relation_type),
      KEY idx_knowledge_doc_relations_target (target_doc_id, relation_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_doc_summaries (
      id VARCHAR(64) PRIMARY KEY,
      document_id VARCHAR(64) NOT NULL,
      summary TEXT NOT NULL,
      entities TEXT NULL,
      topics TEXT NULL,
      llm_model VARCHAR(128) NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_knowledge_doc_summaries_doc (document_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_wiki_pages (
      id VARCHAR(64) PRIMARY KEY,
      kb_id VARCHAR(64) NOT NULL,
      page_type VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      source_doc_ids TEXT NULL,
      inbound_links TEXT NULL,
      outbound_links TEXT NULL,
      llm_model VARCHAR(128) NULL,
      version INT NOT NULL DEFAULT 1,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_knowledge_wiki_pages_kb_type (kb_id, page_type),
      KEY idx_knowledge_wiki_pages_kb_title (kb_id, title),
      KEY idx_knowledge_wiki_pages_kb_type_title (kb_id, page_type, title),
      KEY idx_knowledge_wiki_pages_kb_title_updated (kb_id, title, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await safeMigrate(
    `CREATE INDEX idx_knowledge_wiki_pages_kb_type_title ON knowledge_wiki_pages(kb_id, page_type, title)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_knowledge_wiki_pages_kb_title_updated ON knowledge_wiki_pages(kb_id, title, updated_at DESC)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_wiki_claims (
      id VARCHAR(64) PRIMARY KEY,
      page_id VARCHAR(64) NOT NULL,
      claim_text TEXT NOT NULL,
      source_doc_id VARCHAR(64) NULL,
      evidence_chunk_id VARCHAR(64) NULL,
      confidence FLOAT NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_knowledge_wiki_claims_page (page_id),
      KEY idx_knowledge_wiki_claims_evidence (evidence_chunk_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // PR Q-Edit: human-edit lock
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages ADD COLUMN edited_by_human TINYINT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages ADD COLUMN edited_at VARCHAR(32) NULL`,
  );
  // PR Q-Edit: TEXT (64KB) → MEDIUMTEXT (16MB) so 512KB human edits & long LLM-rebuilt
  // pages don't trigger ER_DATA_TOO_LONG. Repeating MODIFY COLUMN with the same target
  // type is a no-op in MySQL (no duplicate-object error), so safeMigrate is idempotent.
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages MODIFY COLUMN content MEDIUMTEXT NOT NULL`,
  );
  await safeFullTextMigrate(
    `CREATE FULLTEXT INDEX ft_kb_content ON knowledge_chunks(content)`,
  );
  await safeFullTextMigrate(
    `CREATE FULLTEXT INDEX ft_wiki_content ON knowledge_wiki_pages(title, content)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_event_log (
      id VARCHAR(64) PRIMARY KEY,
      kb_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      doc_id VARCHAR(64) NULL,
      page_id VARCHAR(64) NULL,
      title VARCHAR(255) NOT NULL,
      payload TEXT NULL,
      created_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      KEY idx_knowledge_event_log_kb_time (kb_id, created_at),
      KEY idx_knowledge_event_log_kb_type_time (kb_id, event_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_knowledge_bindings (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      kb_id VARCHAR(64) NOT NULL,
      enabled TINYINT NOT NULL DEFAULT 1,
      created_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_user_kb (user_id, kb_id),
      KEY idx_user_kb_bindings_user (user_id, enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS ssh_keys (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      fingerprint VARCHAR(255),
      key_type VARCHAR(64),
      private_key TEXT NOT NULL,
      public_key TEXT,
      is_default INT NOT NULL DEFAULT 0,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at VARCHAR(64) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(
    `ALTER TABLE review_repositories ADD COLUMN ssh_key_id VARCHAR(64)`,
  );

  await safeMigrate(
    `ALTER TABLE review_runs ADD COLUMN markdown_body MEDIUMTEXT`,
  );
  await safeMigrate(
    `ALTER TABLE review_runs ADD COLUMN raw_model_output MEDIUMTEXT`,
  );
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN review_output_mode VARCHAR(64) NOT NULL DEFAULT 'message'`,
  );

  // ── Multi-user isolation: assistants visibility ──
  await safeMigrate(
    `ALTER TABLE assistants ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'private'`,
  );
  await safeMigrate(
    `ALTER TABLE assistants ADD INDEX idx_assistants_visibility (visibility, user_id)`,
  );

  // ── Multi-user isolation: review_profiles provider binding ──
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN provider_id VARCHAR(64)`,
  );

  // ── Diff subagent threshold ──
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN diff_subagent_threshold INT NOT NULL DEFAULT 15`,
  );

  // ── Provider audit fields + role-based access ──────────────────
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN deleted_at VARCHAR(64) DEFAULT NULL`,
  );

  // Backfill created_by / updated_by for existing system providers to first admin user
  try {
    const adminRows = await engine.queryAll<{ user_id: string }>(
      `SELECT ur.user_id FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE r.name = 'admin' LIMIT 1`,
    );
    if (adminRows.length > 0) {
      await engine.run(
        `UPDATE ai_providers SET created_by = ?, updated_by = ?
         WHERE user_id = '__system__' AND created_by = '__system__'`,
        [adminRows[0].user_id, adminRows[0].user_id],
      );
    }
  } catch {
    /* tables may not exist yet */
  }

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS provider_role_access (
      provider_id VARCHAR(64) NOT NULL,
      role_id VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      deleted_at VARCHAR(64) DEFAULT NULL,
      PRIMARY KEY (provider_id, role_id),
      KEY idx_pra_role (role_id),
      KEY idx_pra_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS provider_user_shares (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      PRIMARY KEY (provider_id, user_id),
      KEY idx_provider_user_shares_user (user_id),
      KEY idx_provider_user_shares_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_default_providers (
      user_id VARCHAR(64) PRIMARY KEY,
      provider_id VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      updated_at VARCHAR(64) NOT NULL,
      KEY idx_user_default_providers_provider (provider_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS resource_bindings (
      id VARCHAR(64) PRIMARY KEY,
      resource_type VARCHAR(64) NOT NULL,
      resource_id VARCHAR(64) NOT NULL,
      owner_type VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      binding_key VARCHAR(128) NOT NULL DEFAULT 'default',
      branch VARCHAR(128),
      work_directory TEXT,
      config_json TEXT,
      user_id VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_resource_binding (resource_type, resource_id, owner_type, owner_id, binding_key),
      KEY idx_rb_owner (owner_type, owner_id),
      KEY idx_rb_resource (resource_type, resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS repository_worktrees (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      work_directory TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at VARCHAR(64) NOT NULL,
      last_used_at VARCHAR(64) NOT NULL,
      UNIQUE KEY uq_rwt_repo_branch (repository_id, branch),
      KEY idx_rwt_last_used (last_used_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ── System-wide audit field standardization ────────────────────
  const auditTables = [
    'users',
    'roles',
    'user_roles',
    'chats',
    'knowledge_bases',
    'knowledge_documents',
    'assistants',
    'user_skills',
    'user_mcp_servers',
    'registered_groups',
    'scheduled_tasks',
    'workteams',
    'workteam_agents',
    'ssh_keys',
    'channel_instances',
  ];
  for (const table of auditTables) {
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN deleted_at VARCHAR(64) DEFAULT NULL`,
    );
  }
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD INDEX idx_knowledge_bases_user_created (user_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD INDEX idx_knowledge_bases_visibility_created (visibility, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_created (kb_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_path (kb_id, deleted_at, doc_path, created_at ASC)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_status_created (kb_id, deleted_at, status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_mcp_servers_user_list ON user_mcp_servers(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_mcp_servers_visibility_list ON user_mcp_servers(visibility, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_skills_user_list ON user_skills(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_user_skills_visibility_list ON user_skills(visibility, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_marketplace_sources_list ON marketplace_sources(deleted_at, sort_order ASC, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_marketplace_installs_user_list ON marketplace_installs(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_marketplace_installs_target_active ON marketplace_installs(target_id, deleted_at)`,
  );
  await safeMigrate(
    `ALTER TABLE review_repositories ADD INDEX idx_review_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_repositories_list ON review_repositories(deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `ALTER TABLE repositories ADD INDEX idx_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_repositories_user_updated ON repositories(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_repositories_updated ON repositories(deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_profiles_repository_list ON review_profiles(repository_id, deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_profiles_list ON review_profiles(deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_profiles_match ON review_profiles(repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_repo_members_repo_granted ON review_repository_members(repository_id, granted_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_digest_runs_repo_scheduled ON review_digest_runs(repository_id, scheduled_for DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_digest_runs_repo_type_status_created ON review_digest_runs(repository_id, type, status, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_digest_runs_schedule_status ON review_digest_runs(repository_id, type, scheduled_for, status)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_repo_updated ON review_runs(repository_id, updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_updated ON review_runs(updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_repo_status_completed ON review_runs(repository_id, status, completed_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_status_created ON review_runs(status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_review_runs_repo_status_created ON review_runs(repository_id, status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_workteams_user_created ON workteams(user_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_workteam_agents_team_active_sort ON workteam_agents(team_id, deleted_at, sort_order)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(status, deleted_at, next_run)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_group_created ON scheduled_tasks(group_folder, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_chat_created ON scheduled_tasks(chat_jid, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX idx_scheduled_tasks_created ON scheduled_tasks(deleted_at, created_at DESC)`,
  );
  await safeMigrate(`ALTER TABLE chats ADD COLUMN created_at VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE chats ADD COLUMN updated_at VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE user_roles ADD COLUMN created_at VARCHAR(64)`);
  await safeMigrate(`ALTER TABLE user_roles ADD COLUMN updated_at VARCHAR(64)`);
  await safeMigrate(
    `ALTER TABLE workteam_agents ADD COLUMN created_at VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_agents ADD COLUMN updated_at VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN created_at VARCHAR(64)`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN updated_at VARCHAR(64)`,
  );
  await safeMigrate(`ALTER TABLE roles ADD COLUMN updated_at VARCHAR(64)`);
  await safeMigrate(
    `ALTER TABLE scheduled_tasks ADD COLUMN updated_at VARCHAR(64)`,
  );

  // ── Tier 3 user-facing tables: audit columns ────────────────────
  const tier3AuditTables = [
    'im_chat_meta',
    'user_friends',
    'friend_requests',
    'review_repositories',
    'review_profiles',
    'live2d_models',
    'marketplace_installs',
    'conversation_shares',
  ];
  for (const table of tier3AuditTables) {
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN deleted_at VARCHAR(64) DEFAULT NULL`,
    );
  }
  await safeMigrate(
    `UPDATE marketplace_sources SET created_by = '__system__' WHERE created_by IS NULL`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ADD COLUMN updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ADD COLUMN deleted_at VARCHAR(64) DEFAULT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources MODIFY COLUMN created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE user_mcp_servers ADD COLUMN metadata_json TEXT`,
  );
  await safeMigrate(`ALTER TABLE user_skills ADD COLUMN metadata_json TEXT`);
  await safeMigrate(
    `UPDATE conversation_shares SET created_by = '__system__' WHERE created_by IS NULL`,
  );
  await safeMigrate(
    `ALTER TABLE conversation_shares MODIFY COLUMN created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );

  // ── Phase 2: Migrate review_repositories → repositories + repo_features ──
  await safeMigrate(`
    INSERT IGNORE INTO repositories (
      id, name, language, local_repo_path, remote_provider, remote_repo_slug,
      remote_base_url, clone_url, default_target_branch, ssh_key_id,
      auto_sync_enabled, auto_sync_interval_minutes,
      last_auto_sync_at, next_auto_sync_at, last_auto_sync_status, last_auto_sync_message,
      enabled, \`status\`, visibility, ai_description, tech_stack_json,
      user_id, created_by, updated_by, deleted_at, created_at, updated_at
    )
    SELECT
      id, name, language, local_repo_path, remote_provider, remote_repo_slug,
      remote_base_url, clone_url, default_target_branch, ssh_key_id,
      auto_sync_enabled, auto_sync_interval_minutes,
      last_auto_sync_at, next_auto_sync_at, last_auto_sync_status, last_auto_sync_message,
      enabled, 'active', NULL, NULL, NULL,
      user_id, created_by, updated_by, deleted_at, created_at, updated_at
    FROM review_repositories
    WHERE deleted_at IS NULL
  `);
  await safeMigrate(`
    INSERT IGNORE INTO repo_features (id, repository_id, feature_type, enabled, config_json, created_at, updated_at)
    SELECT
      CONCAT('cr_', id), id, 'code_review', 1,
      JSON_OBJECT(
        'review_chat_jid', review_chat_jid,
        'actor_mention_mappings_json', actor_mention_mappings_json,
        'reviewer_usernames_json', reviewer_usernames_json,
        'local_hook_secret', local_hook_secret,
        'webhook_secret', webhook_secret,
        'platform_token', platform_token,
        'digest_daily_enabled', digest_daily_enabled,
        'digest_weekly_enabled', digest_weekly_enabled,
        'digest_daily_hour', digest_daily_hour,
        'digest_weekly_day', digest_weekly_day,
        'digest_weekly_hour', digest_weekly_hour,
        'last_digest_daily_at', last_digest_daily_at,
        'next_digest_daily_at', next_digest_daily_at,
        'last_digest_weekly_at', last_digest_weekly_at,
        'next_digest_weekly_at', next_digest_weekly_at,
        'allow_ai_fix', allow_ai_fix
      ),
      created_at, updated_at
    FROM review_repositories
    WHERE deleted_at IS NULL
  `);

  // ── Phase 3: Migrate assistant_repo_bindings → repositories + resource_bindings ──
  // Step 1: Create repository records for assistant_repo_bindings that don't match existing repos by clone_url
  await safeMigrate(`
    INSERT IGNORE INTO repositories (
      id, name, clone_url, default_target_branch,
      auto_sync_enabled, auto_sync_interval_minutes, enabled,
      \`status\`, user_id, created_by, updated_by, created_at, updated_at
    )
    SELECT
      CONCAT('arb_', arb.id), arb.name, arb.repo_url, arb.default_branch,
      0, 30, arb.enabled,
      'active', '__system__', '__system__', '__system__', arb.created_at, arb.updated_at
    FROM assistant_repo_bindings arb
    WHERE arb.repo_url IS NOT NULL
      AND arb.repo_url != ''
      AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.clone_url = arb.repo_url AND r.deleted_at IS NULL)
  `);
  // Step 2: Create resource_bindings from assistant_repo_bindings
  await safeMigrate(`
    INSERT IGNORE INTO resource_bindings (
      id, resource_type, resource_id, owner_type, owner_id,
      binding_key, branch, work_directory, config_json, user_id, created_at
    )
    SELECT
      arb.id,
      'repository',
      COALESCE(
        (SELECT r.id FROM repositories r WHERE r.clone_url = arb.repo_url AND r.deleted_at IS NULL LIMIT 1),
        CONCAT('arb_', arb.id)
      ),
      'assistant',
      arb.assistant_id,
      'default',
      arb.default_branch,
      arb.local_path,
      JSON_OBJECT(
        'legacy_arb_id', arb.id,
        'display_name', arb.name,
        'description', arb.description,
        'branch_filter', arb.branch_filter,
        'active_branch', arb.active_branch,
        'worktree_path', arb.worktree_path,
        'enabled', CASE WHEN arb.enabled = 1 THEN CAST('true' AS JSON) ELSE CAST('false' AS JSON) END
      ),
      '__system__',
      arb.created_at
    FROM assistant_repo_bindings arb
    WHERE arb.repo_url IS NOT NULL AND arb.repo_url != ''
  `);

  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN allow_query_backfill INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN overview_dirty_at VARCHAR(32) DEFAULT NULL`,
  );
}
