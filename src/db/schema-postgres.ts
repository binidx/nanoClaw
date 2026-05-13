import type { DbEngine } from '../database/engine.js';
import * as dialect from '../database/dialect.js';

export function buildPostgresSchema(autoPk: string): string {
  return `
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      custom_title TEXT,
      is_pinned INT DEFAULT 0,
      is_favorite INT DEFAULT 0,
      last_message_time TEXT,
      channel TEXT,
      is_group INT DEFAULT 0,
      mode TEXT DEFAULT NULL,
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT,
      updated_at TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      uploaded_files_json TEXT,
      "timestamp" TEXT,
      client_id TEXT,
      run_id TEXT,
      im_seq BIGINT,
      is_from_me INT,
      is_bot_message INT DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT '__system__',
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_chats_user_id
      ON chats(user_id, last_message_time DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id
      ON messages(user_id, chat_jid, "timestamp");
    CREATE INDEX IF NOT EXISTS idx_messages_chat_im_seq
      ON messages(chat_jid, im_seq);

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
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_turns_chat_timestamp
      ON assistant_turns(chat_jid, "timestamp");

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
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_entries_user_id
      ON context_entries(user_id);

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
      user_id TEXT NOT NULL DEFAULT '__system__',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_documents_user_id
      ON memory_documents(user_id);

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
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(status, deleted_at, next_run);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_group_created
      ON scheduled_tasks(group_folder, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat_created
      ON scheduled_tasks(chat_jid, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created
      ON scheduled_tasks(deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id
      ON scheduled_tasks(user_id);

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
      is_main INT DEFAULT 0,
      provider_id TEXT DEFAULT NULL,
      model TEXT DEFAULT NULL,
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT,
      updated_at TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registered_groups_user_id
      ON registered_groups(user_id);

    CREATE TABLE IF NOT EXISTS assistants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INT NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      user_id TEXT NOT NULL DEFAULT '__system__',
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistants_user_id
      ON assistants(user_id);
    CREATE INDEX IF NOT EXISTS idx_assistants_visibility
      ON assistants(visibility, user_id);

    CREATE TABLE IF NOT EXISTS assistant_mcp_bindings (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      template_server_id TEXT NOT NULL,
      alias TEXT,
      enabled INT NOT NULL DEFAULT 1,
      args_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(assistant_id, template_server_id)
    );

    CREATE TABLE IF NOT EXISTS assistant_mcp_binding_secrets (
      binding_id TEXT PRIMARY KEY,
      env_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assistant_repo_bindings (
      id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      local_path TEXT,
      default_branch TEXT NOT NULL DEFAULT 'main',
      branch_filter TEXT NOT NULL DEFAULT '[]',
      active_branch TEXT,
      worktree_path TEXT,
      enabled INT NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arb_assistant ON assistant_repo_bindings(assistant_id);

    CREATE TABLE IF NOT EXISTS config (
      "key" TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prompt_configs (
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      prompt_key TEXT NOT NULL,
      feature_scope TEXT NOT NULL,
      template_text TEXT NOT NULL,
      notes TEXT,
      created_by TEXT NOT NULL DEFAULT '__system__',
      updated_by TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uk_prompt_configs_scope_owner_key
      ON prompt_configs(scope_kind, owner_user_id, prompt_key);
    CREATE INDEX IF NOT EXISTS idx_prompt_configs_feature_key
      ON prompt_configs(feature_scope, prompt_key);
    CREATE INDEX IF NOT EXISTS idx_prompt_configs_updated
      ON prompt_configs(updated_at DESC);
    CREATE TABLE IF NOT EXISTS prompt_traces (
      id TEXT PRIMARY KEY,
      trace_kind TEXT NOT NULL,
      prompt_key TEXT,
      feature_scope TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      chat_jid TEXT,
      provider TEXT,
      model TEXT,
      system_prompt_text TEXT,
      user_prompt_text TEXT NOT NULL,
      provider_input_text TEXT,
      segments_json TEXT NOT NULL,
      resolution_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_traces_feature_created
      ON prompt_traces(feature_scope, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_traces_key_created
      ON prompt_traces(prompt_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_traces_user_created
      ON prompt_traces(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_traces_chat_created
      ON prompt_traces(chat_jid, created_at DESC);

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
      capability TEXT NOT NULL DEFAULT 'llm',
      api_key TEXT,
      base_url TEXT,
      model TEXT,
      dimensions INT,
      extra_config TEXT,
      is_default INT DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT '__system__',
      visibility VARCHAR(16) NOT NULL DEFAULT 'public',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_providers_user_id
      ON ai_providers(user_id);

    CREATE TABLE IF NOT EXISTS provider_user_access (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pua_user ON provider_user_access(user_id);
    CREATE INDEX IF NOT EXISTS idx_pua_provider ON provider_user_access(provider_id);

    CREATE TABLE IF NOT EXISTS provider_role_access (
      provider_id VARCHAR(64) NOT NULL,
      role_id VARCHAR(64) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT DEFAULT NULL,
      PRIMARY KEY (provider_id, role_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pra_role ON provider_role_access(role_id);
    CREATE INDEX IF NOT EXISTS idx_pra_provider ON provider_role_access(provider_id);

    CREATE TABLE IF NOT EXISTS provider_user_shares (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_user_shares_user
      ON provider_user_shares(user_id);
    CREATE INDEX IF NOT EXISTS idx_provider_user_shares_provider
      ON provider_user_shares(provider_id);

    CREATE TABLE IF NOT EXISTS user_default_providers (
      user_id VARCHAR(64) PRIMARY KEY,
      provider_id VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_default_providers_provider
      ON user_default_providers(provider_id);

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
      digest_daily_enabled INT NOT NULL DEFAULT 0,
      digest_weekly_enabled INT NOT NULL DEFAULT 0,
      digest_daily_hour INT NOT NULL DEFAULT 18,
      digest_weekly_day INT NOT NULL DEFAULT 5,
      digest_weekly_hour INT NOT NULL DEFAULT 18,
      last_digest_daily_at TEXT,
      next_digest_daily_at TEXT,
      last_digest_weekly_at TEXT,
      next_digest_weekly_at TEXT,
      enabled INT NOT NULL DEFAULT 1,
      allow_ai_fix INT NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_repositories_auto_sync_due
      ON review_repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at);
    CREATE INDEX IF NOT EXISTS idx_review_repositories_list
      ON review_repositories(deleted_at, enabled DESC, updated_at DESC, name);

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
      auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
      auto_sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
      last_auto_sync_at TEXT,
      next_auto_sync_at TEXT,
      last_auto_sync_status TEXT,
      last_auto_sync_message TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT 'active',
      visibility TEXT,
      ai_description TEXT,
      tech_stack_json TEXT,
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_by TEXT NOT NULL DEFAULT '__system__',
      updated_by TEXT NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repositories_user ON repositories(user_id);
    CREATE INDEX IF NOT EXISTS idx_repositories_auto_sync_due
      ON repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at);
    CREATE INDEX IF NOT EXISTS idx_repositories_user_updated
      ON repositories(user_id, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repositories_updated
      ON repositories(deleted_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS repo_features (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      feature_type VARCHAR(64) NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_features_repo_type ON repo_features(repository_id, feature_type);

    CREATE TABLE IF NOT EXISTS review_digest_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      type TEXT NOT NULL,
      scheduled_for TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      timezone TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      duration_ms INT NOT NULL DEFAULT 0,
      branch_count INT NOT NULL DEFAULT 0,
      commit_count INT NOT NULL DEFAULT 0,
      contributor_count INT NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      cloud_doc_url TEXT NOT NULL DEFAULT '',
      cloud_doc_status TEXT NOT NULL DEFAULT '',
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_error TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_type_created
      ON review_digest_runs(repository_id, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_scheduled
      ON review_digest_runs(repository_id, scheduled_for DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_type_status_created
      ON review_digest_runs(repository_id, type, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_digest_runs_schedule_status
      ON review_digest_runs(repository_id, type, scheduled_for, status);

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
      review_output_mode TEXT NOT NULL DEFAULT 'message',
      diff_subagent_threshold INT NOT NULL DEFAULT 15,
      enabled INT NOT NULL DEFAULT 1,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_profiles_repository_list
      ON review_profiles(repository_id, deleted_at, enabled DESC, updated_at DESC, name);
    CREATE INDEX IF NOT EXISTS idx_review_profiles_list
      ON review_profiles(deleted_at, enabled DESC, updated_at DESC, name);
    CREATE INDEX IF NOT EXISTS idx_review_profiles_match
      ON review_profiles(repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC);

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
      markdown_body TEXT,
      raw_model_output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_review_runs_repository_created
      ON review_runs(repository_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_runs_repo_updated
      ON review_runs(repository_id, updated_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_runs_updated
      ON review_runs(updated_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_completed
      ON review_runs(repository_id, status, completed_at DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_runs_status_created
      ON review_runs(status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_created
      ON review_runs(repository_id, status, created_at ASC);

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

    CREATE TABLE IF NOT EXISTS review_repository_members (
      repository_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'viewer',
      granted_at TEXT NOT NULL,
      granted_by TEXT,
      PRIMARY KEY (repository_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_review_repo_members_user
      ON review_repository_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_review_repo_members_repo_granted
      ON review_repository_members(repository_id, granted_at ASC);

    CREATE TABLE IF NOT EXISTS code_search_indexes (
      cache_key TEXT PRIMARY KEY,
      root_directory TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      build_options_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      file_count INT NOT NULL DEFAULT 0,
      symbol_count INT NOT NULL DEFAULT 0,
      term_count INT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS code_search_index_files (
      cache_key TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      extension TEXT NOT NULL,
      language TEXT NOT NULL,
      byte_size INT NOT NULL,
      line_count INT NOT NULL,
      imports_json TEXT NOT NULL DEFAULT '[]',
      previews_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (cache_key, relative_path)
    );

    CREATE TABLE IF NOT EXISTS code_search_index_symbols (
      cache_key TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      ordinal INT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INT NOT NULL,
      column_number INT NOT NULL,
      signature TEXT NOT NULL,
      PRIMARY KEY (cache_key, relative_path, ordinal)
    );

    CREATE TABLE IF NOT EXISTS code_search_index_terms (
      cache_key TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      ordinal INT NOT NULL,
      term TEXT NOT NULL,
      PRIMARY KEY (cache_key, relative_path, ordinal)
    );

    CREATE TABLE IF NOT EXISTS code_map_ai_analyses (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      target_path TEXT NOT NULL,
      target_type TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(repository_id, branch, target_path, manifest_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_code_map_ai_analyses_lookup
      ON code_map_ai_analyses(repository_id, branch, target_path);

    CREATE TABLE IF NOT EXISTS code_index_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      root_directory TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'unknown',
      source_branch TEXT NOT NULL DEFAULT '',
      source_head_sha TEXT NOT NULL DEFAULT '',
      manifest_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      processed_files INT NOT NULL,
      total_files INT NOT NULL,
      message TEXT NOT NULL,
      error_message TEXT,
      generated_at TEXT,
      stats_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repository_id, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_snapshots_repo_branch
      ON code_index_snapshots(repository_id, branch);

    CREATE TABLE IF NOT EXISTS code_index_files (
      snapshot_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      language TEXT NOT NULL,
      byte_size INT NOT NULL,
      line_count INT NOT NULL,
      file_hash TEXT NOT NULL,
      rank DOUBLE PRECISION NOT NULL,
      import_count INT NOT NULL,
      export_count INT NOT NULL,
      summary_text TEXT NOT NULL,
      summary_source TEXT NOT NULL DEFAULT 'fallback',
      PRIMARY KEY (snapshot_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_files_snapshot_rank
      ON code_index_files(snapshot_id, rank DESC, relative_path);

    CREATE TABLE IF NOT EXISTS code_index_chunks (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_index INT NOT NULL,
      start_line INT NOT NULL,
      end_line INT NOT NULL,
      content TEXT NOT NULL,
      token_count INT NOT NULL,
      summary_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      summary_source TEXT NOT NULL DEFAULT 'fallback'
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_chunks_snapshot_file
      ON code_index_chunks(snapshot_id, file_path, chunk_index);

    CREATE TABLE IF NOT EXISTS code_index_functions (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL,
      start_line INT NOT NULL,
      end_line INT NOT NULL,
      line INT NOT NULL,
      column_number INT NOT NULL,
      parent_function_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_functions_snapshot_file
      ON code_index_functions(snapshot_id, file_path, line);

    CREATE TABLE IF NOT EXISTS code_index_function_edges (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      from_function_id TEXT NOT NULL,
      to_function_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      symbol_name TEXT NOT NULL,
      line INT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_index_function_edges_from
      ON code_index_function_edges(snapshot_id, from_function_id, line);
    CREATE INDEX IF NOT EXISTS idx_code_index_function_edges_to
      ON code_index_function_edges(snapshot_id, to_function_id, line);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      email TEXT,
      auth_source TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_system INT DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
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
      created_at TEXT,
      updated_at TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
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

    CREATE TABLE IF NOT EXISTS user_souls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      name TEXT,
      emoji TEXT,
      emoji_enabled INT NOT NULL DEFAULT 0,
      creature TEXT,
      vibe TEXT,
      persona_prompt TEXT,
      tone TEXT,
      language_preference TEXT,
      extra_instructions TEXT,
      user_nickname TEXT,
      behavior_rules TEXT,
      auto_evolve INT NOT NULL DEFAULT 1,
      consolidation_config TEXT,
      enabled INT NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_soul_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      importance INT NOT NULL DEFAULT 5,
      source TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_soul_memories_user
      ON user_soul_memories(user_id, importance DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_soul_memories_category
      ON user_soul_memories(user_id, category, updated_at DESC);

    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      conversation_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      importance INT NOT NULL DEFAULT 5,
      confidence REAL NOT NULL DEFAULT 0.5,
      source TEXT NOT NULL DEFAULT 'manual',
      tier TEXT NOT NULL DEFAULT 'durable',
      promoted_from TEXT,
      last_verified_at TEXT,
      source_event_id TEXT,
      valid_from TEXT,
      valid_to TEXT,
      access_count INT NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_memories_user
      ON user_memories(user_id, importance DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_memories_scope
      ON user_memories(user_id, scope, conversation_id);
    CREATE INDEX IF NOT EXISTS idx_user_memories_category
      ON user_memories(user_id, category, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_memories_tier
      ON user_memories(user_id, tier, importance DESC);

    CREATE TABLE IF NOT EXISTS user_memory_observations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      observation_type TEXT NOT NULL DEFAULT 'fact',
      frequency INT NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.3,
      source TEXT NOT NULL DEFAULT 'llm_extract',
      promoted_to TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_memory_obs_user
      ON user_memory_observations(user_id, frequency DESC, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_user_memory_obs_type
      ON user_memory_observations(user_id, observation_type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS persona_insights (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_count INT NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0.3,
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_persona_insights_user
      ON persona_insights(user_id, status, confidence DESC);

    CREATE TABLE IF NOT EXISTS memory_consolidation_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_type TEXT NOT NULL DEFAULT 'scheduled',
      observations_reviewed INT NOT NULL DEFAULT 0,
      promoted INT NOT NULL DEFAULT 0,
      merged INT NOT NULL DEFAULT 0,
      pruned INT NOT NULL DEFAULT 0,
      insights_generated INT NOT NULL DEFAULT 0,
      duration_ms INT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_consolidation_user
      ON memory_consolidation_log(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_extraction_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      source_message_ids TEXT,
      extracted_memories TEXT,
      model_used TEXT,
      tokens_used INT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      conversation_id TEXT,
      source_message_id TEXT,
      before_snapshot TEXT,
      after_snapshot TEXT,
      decision_reason TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_user
      ON memory_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_user_action_time
      ON memory_events(user_id, action_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_target
      ON memory_events(target_type, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_events_action
      ON memory_events(action_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS embedding_vectors (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      embedding_provider_id TEXT,
      content_hash TEXT NOT NULL,
      embedding BYTEA NOT NULL,
      dimensions INT NOT NULL,
      model_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_vectors_owner
      ON embedding_vectors(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_embedding_vectors_owner_provider
      ON embedding_vectors(owner_type, embedding_provider_id);

    CREATE TABLE IF NOT EXISTS memory_skills (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      name TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      body TEXT NOT NULL,
      termination_condition TEXT,
      success_count INT NOT NULL DEFAULT 0,
      failure_count INT NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_verified_at TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_skills_user
      ON memory_skills(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_skills_scope
      ON memory_skills(scope, status);

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      owner_type TEXT NOT NULL DEFAULT 'system',
      owner_id TEXT,
      embedding_model TEXT,
      embedding_provider_id TEXT,
      chunk_size INT NOT NULL DEFAULT 300,
      chunk_overlap INT NOT NULL DEFAULT 60,
      cleanup_patterns TEXT,
      enabled INT NOT NULL DEFAULT 1,
      user_id TEXT NOT NULL DEFAULT '__system__',
      category TEXT NOT NULL DEFAULT 'general',
      visibility TEXT NOT NULL DEFAULT 'private',
      enhancement_level TEXT NOT NULL DEFAULT 'metadata',
      llm_provider_id TEXT,
      llm_model_override TEXT,
      temporal_half_life_days INT NOT NULL DEFAULT 365,
      allow_query_backfill INT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user
      ON knowledge_bases(user_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user_created
      ON knowledge_bases(user_id, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_visibility_created
      ON knowledge_bases(visibility, deleted_at, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'text/plain',
      content_hash TEXT NOT NULL,
      char_count INT NOT NULL DEFAULT 0,
      chunk_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      source_url TEXT,
      published_at TEXT,
      superseded_by TEXT,
      parent_doc_id TEXT,
      doc_path TEXT,
      depth INT NOT NULL DEFAULT 0,
      llm_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb
      ON knowledge_documents(kb_id, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_created
      ON knowledge_documents(kb_id, deleted_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_source_url
      ON knowledge_documents(kb_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_path
      ON knowledge_documents(kb_id, deleted_at, doc_path, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_status_created
      ON knowledge_documents(kb_id, deleted_at, status, created_at ASC);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      token_count INT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc
      ON knowledge_chunks(document_id, chunk_index);

    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector;
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_search
      ON knowledge_chunks USING GIN(search_vector);

    CREATE TABLE IF NOT EXISTS file_store (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      path_ref TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      metadata_json TEXT,
      user_id TEXT NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(category, path_ref, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_file_store_category
      ON file_store(category, user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS live2d_models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      user_id TEXT NOT NULL DEFAULT '__system__',
      visibility TEXT NOT NULL DEFAULT 'private',
      format TEXT NOT NULL DEFAULT 'cubism4',
      model_data BYTEA,
      thumbnail BYTEA,
      file_size INT DEFAULT 0,
      entry_file TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live2d_models_user
      ON live2d_models(user_id, visibility, updated_at DESC);

    CREATE TABLE IF NOT EXISTS live2d_emotion_mappings (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      emotion TEXT NOT NULL,
      motion_group TEXT,
      expression_name TEXT,
      priority INT DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_live2d_emotion_mappings_model
      ON live2d_emotion_mappings(model_id, emotion);

    CREATE TABLE IF NOT EXISTS live2d_user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      enabled INT DEFAULT 0,
      selected_model_id TEXT,
      position TEXT DEFAULT 'right',
      panel_width INT DEFAULT 280,
      opacity INT DEFAULT 100,
      emotion_provider_id TEXT,
      model_scale REAL DEFAULT 1.0,
      model_offset_y INT DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live2d_user_prefs_user
      ON live2d_user_preferences(user_id);

    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '__system__',
      name TEXT NOT NULL,
      description TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT,
      enabled INT NOT NULL DEFAULT 1,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      icon_url TEXT,
      tags_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user
      ON user_mcp_servers(user_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_visibility
      ON user_mcp_servers(visibility, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user_list
      ON user_mcp_servers(user_id, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_visibility_list
      ON user_mcp_servers(visibility, deleted_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS user_skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '__system__',
      name TEXT NOT NULL,
      description TEXT,
      summary TEXT,
      skill_content TEXT,
      metadata_json TEXT,
      enabled INT NOT NULL DEFAULT 1,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      icon_url TEXT,
      tags_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_user
      ON user_skills(user_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_user_skills_visibility
      ON user_skills(visibility, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_skills_user_list
      ON user_skills(user_id, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_skills_visibility_list
      ON user_skills(visibility, deleted_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS marketplace_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      enabled INT NOT NULL DEFAULT 1,
      description TEXT,
      icon_url TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_sources_list
      ON marketplace_sources(deleted_at, sort_order ASC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS marketplace_installs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_id TEXT,
      entry_name TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      installed_version TEXT,
      target_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user
      ON marketplace_installs(user_id, entry_type);
    CREATE INDEX IF NOT EXISTS idx_marketplace_installs_source
      ON marketplace_installs(source_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user_list
      ON marketplace_installs(user_id, deleted_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_marketplace_installs_target_active
      ON marketplace_installs(target_id, deleted_at);

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
      created_at VARCHAR(64) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON admin_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON admin_audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON admin_audit_log(created_at);

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
      created_at TEXT NOT NULL,
      UNIQUE(resource_type, resource_id, owner_type, owner_id, binding_key)
    );
    CREATE INDEX IF NOT EXISTS idx_rb_owner ON resource_bindings(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_rb_resource ON resource_bindings(resource_type, resource_id);

    CREATE TABLE IF NOT EXISTS repository_worktrees (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      work_directory TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE(repository_id, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_rwt_last_used ON repository_worktrees(last_used_at);
  `;
}

export function _buildPostgresSchemaForTest(): string {
  return buildPostgresSchema(dialect.autoIncrementPk('postgres'));
}

/** @internal - for tests only. Applies PostgreSQL startup migrations to an engine. */
export async function _runPostgresMigrationsForTest(
  engine: DbEngine,
): Promise<void> {
  await runPostgresMigrations(engine);
}

export async function runPostgresMigrations(engine: DbEngine): Promise<void> {
  const safeMigrate = async (sql: string) => {
    try {
      await engine.exec(sql);
    } catch {
      /* column/index already exists */
    }
  };

  await safeMigrate(
    `INSERT INTO stock_analysis_config_state (scope, version, updated_at) VALUES ('global', 0, '0') ON CONFLICT DO NOTHING`,
  );

  await safeMigrate(`ALTER TABLE user_souls ADD COLUMN user_nickname TEXT`);

  await safeMigrate(
    `ALTER TABLE memory_document_sync_state ALTER COLUMN file_mtime_ms TYPE BIGINT USING file_mtime_ms::bigint`,
  );

  await safeMigrate(
    `ALTER TABLE memory_document_sync_state ALTER COLUMN file_size TYPE BIGINT USING file_size::bigint`,
  );

  for (const col of [
    'custom_title TEXT',
    'is_pinned INT DEFAULT 0',
    'is_favorite INT DEFAULT 0',
    'channel TEXT',
    'is_group INT DEFAULT 0',
    'mode TEXT DEFAULT NULL',
  ]) {
    await safeMigrate(`ALTER TABLE chats ADD COLUMN ${col}`);
  }

  // Synchronize SERIAL sequences to avoid duplicate key violations after
  // data migration or manual inserts with explicit IDs.
  const serialTables: Array<{ table: string; column: string }> = [
    { table: 'identity_aliases', column: 'id' },
    { table: 'memory_search_events', column: 'event_id' },
    { table: 'context_compaction_run_logs', column: 'id' },
    { table: 'task_run_logs', column: 'id' },
  ];
  for (const { table, column } of serialTables) {
    await safeMigrate(`
      SELECT setval(
        pg_get_serial_sequence('${table}', '${column}'),
        COALESCE((SELECT MAX("${column}") FROM "${table}"), 0) + 1,
        false
      )
    `);
  }

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
      `ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
  }

  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_chats_user_id ON chats(user_id, last_message_time DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id, chat_jid, "timestamp")`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_assistants_user_id ON assistants(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_ai_providers_user_id ON ai_providers(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_registered_groups_user_id ON registered_groups(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON scheduled_tasks(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_context_entries_user_id ON context_entries(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_memory_documents_user_id ON memory_documents(user_id)`,
  );

  // Per-user channel instances table
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS channel_instances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INT DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_channel_instances_user ON channel_instances(user_id, type)`,
  );
  await safeMigrate(
    `ALTER TABLE channel_instances ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
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
      `ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
  }
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_repos_user ON review_repositories(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_user ON review_runs(user_id)`,
  );
  // Digest columns on review_repositories
  for (const col of [
    'digest_daily_enabled INT NOT NULL DEFAULT 0',
    'digest_weekly_enabled INT NOT NULL DEFAULT 0',
    'digest_daily_hour INT NOT NULL DEFAULT 18',
    'digest_weekly_day INT NOT NULL DEFAULT 5',
    'digest_weekly_hour INT NOT NULL DEFAULT 18',
    'last_digest_daily_at TEXT',
    'next_digest_daily_at TEXT',
    'last_digest_weekly_at TEXT',
    'next_digest_weekly_at TEXT',
  ]) {
    await safeMigrate(`ALTER TABLE review_repositories ADD COLUMN ${col}`);
  }
  await safeMigrate(
    `ALTER TABLE review_repositories ADD COLUMN allow_ai_fix INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS review_digest_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      type TEXT NOT NULL,
      scheduled_for TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      timezone TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      duration_ms INT NOT NULL DEFAULT 0,
      branch_count INT NOT NULL DEFAULT 0,
      commit_count INT NOT NULL DEFAULT 0,
      contributor_count INT NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      cloud_doc_url TEXT NOT NULL DEFAULT '',
      cloud_doc_status TEXT NOT NULL DEFAULT '',
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_error TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_type_created ON review_digest_runs(repository_id, type, created_at DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS scheduled_for TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS started_at TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS duration_ms INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'`,
  );
  await safeMigrate(
    `ALTER TABLE review_digest_runs ADD COLUMN IF NOT EXISTS delivery_error TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_scheduled ON review_digest_runs(repository_id, scheduled_for DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_type_status_created ON review_digest_runs(repository_id, type, status, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_digest_runs_schedule_status ON review_digest_runs(repository_id, type, scheduled_for, status)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_stock_tasks_user ON stock_analysis_tasks(user_id)`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_files ADD COLUMN IF NOT EXISTS summary_source TEXT NOT NULL DEFAULT 'fallback'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_chunks ADD COLUMN IF NOT EXISTS summary_source TEXT NOT NULL DEFAULT 'fallback'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'unknown'`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN IF NOT EXISTS source_branch TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE code_index_snapshots ADD COLUMN IF NOT EXISTS source_head_sha TEXT NOT NULL DEFAULT ''`,
  );

  // Partial unique index: prevent duplicate active stock analysis tasks per code
  await safeMigrate(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_analysis_tasks_active_code
      ON stock_analysis_tasks(stock_code)
      WHERE status IN ('pending', 'running')
  `);

  // PostgreSQL GIN index for native fulltext search on user_memories
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_memories_fts ON user_memories USING GIN (to_tsvector('simple', content))`,
  );
  // Memory confidence field for lifecycle management
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5`,
  );
  // Live2D preference fields added after initial rollout
  await safeMigrate(
    `ALTER TABLE live2d_user_preferences ADD COLUMN model_scale REAL DEFAULT 1.0`,
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
    `ALTER TABLE user_memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'durable'`,
  );
  await safeMigrate(`ALTER TABLE user_memories ADD COLUMN promoted_from TEXT`);
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN last_verified_at TEXT`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_memories_tier ON user_memories(user_id, tier, importance DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE user_memories ADD COLUMN source_event_id TEXT`,
  );
  await safeMigrate(`ALTER TABLE user_memories ADD COLUMN valid_from TEXT`);
  await safeMigrate(`ALTER TABLE user_memories ADD COLUMN valid_to TEXT`);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_memory_events_user_action_time ON memory_events(user_id, action_type, created_at DESC)`,
  );

  // Runtime state persistence tables
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS pending_uploads (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      files_json TEXT NOT NULL,
      upload_timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_pending_uploads_chat ON pending_uploads(chat_jid)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS runtime_state (
      state_key TEXT PRIMARY KEY,
      state_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS conversation_shares (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      assistant_name TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      view_count INTEGER DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT '__system__'
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_shares_user_id ON conversation_shares(user_id, created_at DESC)`,
  );

  // Startup cleanup: supersede duplicate active tasks (same as SQLite createSchema)
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
    `ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'`,
  );

  // chats.mode column was in CREATE TABLE but missed for existing databases
  await safeMigrate(`ALTER TABLE chats ADD COLUMN mode TEXT DEFAULT NULL`);

  // Migration: allow multiple repositories per chat_jid (drop UNIQUE, add plain INDEX)
  await safeMigrate(
    `ALTER TABLE review_conversation_bindings DROP CONSTRAINT IF EXISTS review_conversation_bindings_chat_jid_key`,
  );
  await safeMigrate(
    `DROP INDEX IF EXISTS idx_review_conversation_bindings_chat_jid`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_conversation_bindings_chat_jid ON review_conversation_bindings(chat_jid)`,
  );

  // Migration: per-conversation provider/model override on registered_groups
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN provider_id TEXT DEFAULT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN model TEXT DEFAULT NULL`,
  );

  // ── IM Chat tables ────────────────────────────────────────────────
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_chat_meta (
      chat_jid TEXT PRIMARY KEY,
      chat_type TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      owner_id TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      notice TEXT,
      e2ee_enabled INT NOT NULL DEFAULT 0,
      max_members INTEGER DEFAULT 200,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_chat_meta_owner ON im_chat_meta(owner_id)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_memberships (
      chat_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'member',
      nickname TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      muted_until TEXT,
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, user_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_memberships_user ON im_memberships(user_id, status)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_room_state (
      chat_jid TEXT PRIMARY KEY,
      last_seq BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_events (
      chat_jid TEXT NOT NULL,
      seq BIGINT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, seq)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_events_chat_seq ON im_events(chat_jid, seq)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_conversation_prefs (
      chat_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_pinned INT NOT NULL DEFAULT 0,
      is_muted INT NOT NULL DEFAULT 0,
      is_archived INT NOT NULL DEFAULT 0,
      draft_text TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, user_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_jid TEXT,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      message_id TEXT,
      title TEXT,
      body TEXT,
      is_read INT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_notifications_user_read_created ON im_notifications(user_id, is_read, created_at DESC)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_mentions (
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      mentioned_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, message_id, mentioned_user_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_mentions_user_created ON im_mentions(mentioned_user_id, created_at DESC)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_blocks (
      user_id TEXT NOT NULL,
      blocked_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, blocked_user_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      chat_jid TEXT,
      message_id TEXT,
      target_user_id TEXT,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_pinned_messages (
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, message_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_device_keys (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, device_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_room_keys (
      chat_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, user_id, device_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_crypto (
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      version INT NOT NULL,
      algorithm TEXT NOT NULL,
      iv TEXT NOT NULL,
      aad TEXT,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, message_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_calls (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_by TEXT NOT NULL,
      call_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_call_participants (
      call_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      joined_at TEXT,
      left_at TEXT,
      PRIMARY KEY (call_id, user_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_ai_members (
      chat_jid TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'assistant',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, assistant_id)
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_ai_invocations (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      trigger_message_id TEXT,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      remark TEXT,
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_friends_friend ON user_friends(friend_id)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      updated_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id, status)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_join_requests (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      handled_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_join_requests_chat ON im_join_requests(chat_jid, status)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_quotas (
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sender_id, recipient_id, period_start)
    )
  `);

  // IM file attachments
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_attachments (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      message_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_attachments_message ON im_attachments (message_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_attachments_expires ON im_attachments (expires_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_attachments_chat ON im_attachments (chat_jid)`,
  );

  // IM link preview cache
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_link_previews (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      fetched_at TEXT NOT NULL
    )
  `);

  // IM message edits history
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_message_edits (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      old_content TEXT NOT NULL,
      edited_by TEXT NOT NULL,
      edited_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_im_message_edits_msg ON im_message_edits(message_id)`,
  );

  // IM reactions
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    )
  `);

  // IM read cursors
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS im_read_cursors (
      chat_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_seq BIGINT,
      last_read_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, user_id)
    )
  `);

  // messages table: add reply_to_id, edited_at, deleted_at columns
  await safeMigrate(
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS im_seq BIGINT`,
  );
  await safeMigrate(
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS uploaded_files_json TEXT`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_im_seq ON messages(chat_jid, im_seq)`,
  );
  await safeMigrate(
    `ALTER TABLE im_read_cursors ADD COLUMN IF NOT EXISTS last_read_seq BIGINT`,
  );
  await safeMigrate(
    `ALTER TABLE im_chat_meta ADD COLUMN IF NOT EXISTS e2ee_enabled INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE im_ai_invocations ADD COLUMN IF NOT EXISTS error_message TEXT`,
  );

  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'public'`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS provider_user_access (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, user_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_pua_user ON provider_user_access(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_pua_provider ON provider_user_access(provider_id)`,
  );

  // ── Workteam multi-agent collaboration tables ────────────────────
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteams (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      user_id VARCHAR(64) NOT NULL,
      process_type VARCHAR(64) NOT NULL DEFAULT 'sequential',
      workflow_config TEXT NOT NULL DEFAULT '{}',
      status VARCHAR(64) NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteams_user ON workteams(user_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_agents (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      "role" VARCHAR(128) NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      backstory TEXT NOT NULL DEFAULT '',
      assistant_id VARCHAR(64) NOT NULL DEFAULT '',
      chat_jid VARCHAR(128) NOT NULL DEFAULT '',
      tools_config TEXT NOT NULL DEFAULT '{}',
      sort_order INT NOT NULL DEFAULT 0
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_agents_team ON workteam_agents(team_id, sort_order)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_tasks (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL DEFAULT '',
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      expected_output TEXT NOT NULL DEFAULT '',
      dependencies TEXT NOT NULL DEFAULT '[]',
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      sort_order INT NOT NULL DEFAULT 0,
      timeout_ms INT NOT NULL DEFAULT 600000,
      retry_limit INT NOT NULL DEFAULT 1,
      eval_config TEXT NOT NULL DEFAULT ''
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_tasks_team ON workteam_tasks(team_id, sort_order)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_runs (
      id VARCHAR(64) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      checkpoint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_runs_team ON workteam_runs(team_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_runs_team_created ON workteam_runs(team_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_runs_status ON workteam_runs(status)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_runs_status_created ON workteam_runs(status, created_at)`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_runs ADD COLUMN IF NOT EXISTS checkpoint TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_tasks ADD COLUMN IF NOT EXISTS eval_config TEXT NOT NULL DEFAULT ''`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_run_tasks (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      task_id VARCHAR(64) NOT NULL,
      agent_id VARCHAR(64) NOT NULL DEFAULT '',
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      output TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      retry_count INT NOT NULL DEFAULT 0
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_run_tasks_run ON workteam_run_tasks(run_id, task_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workteam_events (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      source_agent_id VARCHAR(64) NOT NULL DEFAULT '',
      target_agent_id VARCHAR(64) NOT NULL DEFAULT '',
      event_type VARCHAR(64) NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_events_run ON workteam_events(run_id, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_events_agent_messages ON workteam_events(run_id, target_agent_id, event_type, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflows (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      user_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'draft',
      workflow_config TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id, updated_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflows_user_active_updated ON workflows(user_id, deleted_at, updated_at DESC, created_at DESC)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      node_type VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      role_node_id VARCHAR(64) NOT NULL DEFAULT '',
      assistant_id VARCHAR(64) NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      position_x DOUBLE PRECISION NOT NULL DEFAULT 120,
      position_y DOUBLE PRECISION NOT NULL DEFAULT 120,
      sort_order INT NOT NULL DEFAULT 0,
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow ON workflow_nodes(workflow_id, sort_order)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow_active_sort ON workflow_nodes(workflow_id, deleted_at, sort_order, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_edges (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      source_node_id VARCHAR(64) NOT NULL,
      target_node_id VARCHAR(64) NOT NULL,
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      label VARCHAR(128) NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow ON workflow_edges(workflow_id, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow_active_created ON workflow_edges(workflow_id, deleted_at, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT ''
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_created_desc ON workflow_runs(workflow_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_nodes (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'pending',
      input_snapshot TEXT NOT NULL DEFAULT '',
      manual_input_override TEXT NOT NULL DEFAULT '',
      input_anchor_frame_id VARCHAR(64) NOT NULL DEFAULT '',
      input_priority_mode VARCHAR(64) NOT NULL DEFAULT 'feedback_first',
      output_snapshot TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      pause_reason TEXT NOT NULL DEFAULT '',
      version INT NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run ON workflow_run_nodes(run_id, node_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run_updated ON workflow_run_nodes(run_id, updated_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_messages (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      source_node_id VARCHAR(64) NOT NULL DEFAULT '',
      target_node_id VARCHAR(64) NOT NULL DEFAULT '',
      direction VARCHAR(64) NOT NULL DEFAULT 'one_way',
      message_type VARCHAR(64) NOT NULL DEFAULT 'node_output',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_messages_run ON workflow_run_messages(run_id, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_interventions (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      intervention_type VARCHAR(64) NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL DEFAULT '',
      after_json TEXT NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_interventions_run ON workflow_run_interventions(run_id, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_node_executions (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'running',
      runtime_namespace VARCHAR(64) NOT NULL,
      group_folder VARCHAR(64) NOT NULL,
      prompt_text TEXT NOT NULL DEFAULT '',
      output_text TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_node_executions_run ON workflow_node_executions(run_id, node_id, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_node_execution_events (
      id VARCHAR(64) PRIMARY KEY,
      execution_id VARCHAR(64) NOT NULL,
      run_id VARCHAR(64) NOT NULL,
      node_id VARCHAR(64) NOT NULL,
      event_kind VARCHAR(128) NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_node_execution_events_run ON workflow_node_execution_events(run_id, node_id, created_at)`,
  );

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_dialogue_sessions_run ON workflow_dialogue_sessions(run_id, edge_id, updated_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_dialogue_sessions_lookup_created ON workflow_dialogue_sessions(run_id, edge_id, created_at DESC)`,
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
      content_text TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_message_frames_run ON workflow_message_frames(run_id, edge_id, created_at)`,
  );

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
      content_text TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      delay_ms INT NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL DEFAULT '',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL DEFAULT '',
      cancelled_at TEXT NOT NULL DEFAULT ''
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_pending_transfers_run ON workflow_pending_transfers(run_id, created_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_pending_transfers_status_due ON workflow_pending_transfers(run_id, status, due_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_artifacts (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      artifact_type VARCHAR(64) NOT NULL,
      name VARCHAR(128) NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status VARCHAR(64) NOT NULL DEFAULT 'ready',
      created_by VARCHAR(64) NOT NULL DEFAULT '__system__',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run ON workflow_artifacts(run_id, artifact_type, created_at)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS workflow_run_evaluations (
      id VARCHAR(64) PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'warn',
      score INT NOT NULL DEFAULT 0,
      findings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_evaluations_run ON workflow_run_evaluations(run_id, created_at)`,
  );

  // ── ABAC: resource_access, user_permission_overrides, permission_groups ──
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS resource_access (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_level TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(resource_type, resource_id, user_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_resource_access_user ON resource_access(user_id, resource_type)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_resource_access_resource ON resource_access(resource_type, resource_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_resource_access_user_type_expires ON resource_access(user_id, resource_type, expires_at, resource_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_resource_access_resource_expires ON resource_access(resource_type, resource_id, expires_at, user_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      effect TEXT NOT NULL DEFAULT 'allow',
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, permission_id)
    )
  `);

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS permission_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS ui_hint TEXT NOT NULL DEFAULT 'action'`,
  );
  await safeMigrate(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS group_id TEXT NOT NULL DEFAULT ''`,
  );
  await safeMigrate(
    `ALTER TABLE user_mcp_servers ADD COLUMN IF NOT EXISTS metadata_json TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS metadata_json TEXT`,
  );

  // ── Knowledge base multi-tenant + categorization ──
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user ON knowledge_bases(user_id, enabled)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS cleanup_patterns TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS source_url TEXT`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_source_url ON knowledge_documents(kb_id, source_url)`,
  );

  // ── Knowledge base temporal / relational enhancement ──
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS enhancement_level TEXT NOT NULL DEFAULT 'metadata'`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS llm_provider_id TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS llm_model_override TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS embedding_provider_id TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS temporal_half_life_days INT NOT NULL DEFAULT 365`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS capability TEXT NOT NULL DEFAULT 'llm'`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS dimensions INT`,
  );
  await safeMigrate(
    `ALTER TABLE embedding_vectors ADD COLUMN IF NOT EXISTS embedding_provider_id TEXT`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_embedding_vectors_owner_provider ON embedding_vectors(owner_type, embedding_provider_id)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS published_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS superseded_by TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS parent_doc_id TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS doc_path TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS llm_status TEXT`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_doc_relations (
      id TEXT PRIMARY KEY,
      source_doc_id TEXT NOT NULL,
      target_doc_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      detail TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(source_doc_id, target_doc_id, relation_type)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_doc_relations_source ON knowledge_doc_relations(source_doc_id, relation_type)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_doc_relations_target ON knowledge_doc_relations(target_doc_id, relation_type)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_doc_summaries (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      entities TEXT,
      topics TEXT,
      llm_model TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_wiki_pages (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      page_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_doc_ids TEXT,
      inbound_links TEXT,
      outbound_links TEXT,
      llm_model TEXT,
      version INT NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_type ON knowledge_wiki_pages(kb_id, page_type)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_title ON knowledge_wiki_pages(kb_id, title)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_type_title ON knowledge_wiki_pages(kb_id, page_type, title)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_title_updated ON knowledge_wiki_pages(kb_id, title, updated_at DESC)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_wiki_claims (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      source_doc_id TEXT,
      evidence_chunk_id TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_claims_page ON knowledge_wiki_claims(page_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_claims_evidence ON knowledge_wiki_claims(evidence_chunk_id)`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages ADD COLUMN IF NOT EXISTS search_vector tsvector`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_wiki_pages_search ON knowledge_wiki_pages USING GIN(search_vector)`,
  );
  // PR Q-Edit: human-edit lock
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages ADD COLUMN IF NOT EXISTS edited_by_human INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_wiki_pages ADD COLUMN IF NOT EXISTS edited_at VARCHAR(32)`,
  );
  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS knowledge_event_log (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      doc_id TEXT,
      page_id TEXT,
      title TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_event_log_kb_time ON knowledge_event_log(kb_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_event_log_kb_type_time ON knowledge_event_log(kb_id, event_type, created_at DESC)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_knowledge_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kb_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, kb_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_kb_bindings_user ON user_knowledge_bindings(user_id, enabled)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS ssh_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fingerprint TEXT,
      key_type TEXT,
      private_key TEXT NOT NULL,
      public_key TEXT,
      is_default INT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await safeMigrate(
    `ALTER TABLE review_repositories ADD COLUMN ssh_key_id TEXT`,
  );

  await safeMigrate(`ALTER TABLE review_runs ADD COLUMN markdown_body TEXT`);
  await safeMigrate(`ALTER TABLE review_runs ADD COLUMN raw_model_output TEXT`);
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN review_output_mode TEXT NOT NULL DEFAULT 'message'`,
  );

  // ── Multi-user isolation: assistants visibility ──
  await safeMigrate(
    `ALTER TABLE assistants ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_assistants_visibility ON assistants(visibility, user_id)`,
  );

  // ── Multi-user isolation: review_profiles provider binding ──
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN IF NOT EXISTS provider_id TEXT`,
  );

  // ── Diff subagent threshold ──
  await safeMigrate(
    `ALTER TABLE review_profiles ADD COLUMN IF NOT EXISTS diff_subagent_threshold INT NOT NULL DEFAULT 15`,
  );

  // ── Provider audit fields + role-based access ──────────────────
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS deleted_at TEXT DEFAULT NULL`,
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
        `UPDATE ai_providers SET created_by = $1, updated_by = $2
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT DEFAULT NULL,
      PRIMARY KEY (provider_id, role_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_pra_role ON provider_role_access(role_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_pra_provider ON provider_role_access(provider_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS provider_user_shares (
      provider_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      granted_by VARCHAR(64) NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, user_id)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_provider_user_shares_user ON provider_user_shares(user_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_provider_user_shares_provider ON provider_user_shares(provider_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS user_default_providers (
      user_id VARCHAR(64) PRIMARY KEY,
      provider_id VARCHAR(64) NOT NULL,
      updated_by VARCHAR(64) NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_default_providers_provider ON user_default_providers(provider_id)`,
  );

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
      created_at TEXT NOT NULL,
      UNIQUE(resource_type, resource_id, owner_type, owner_id, binding_key)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_rb_owner ON resource_bindings(owner_type, owner_id)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_rb_resource ON resource_bindings(resource_type, resource_id)`,
  );

  await safeMigrate(`
    CREATE TABLE IF NOT EXISTS repository_worktrees (
      id VARCHAR(64) PRIMARY KEY,
      repository_id VARCHAR(64) NOT NULL,
      branch VARCHAR(128) NOT NULL,
      work_directory TEXT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      UNIQUE(repository_id, branch)
    )
  `);
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_rwt_last_used ON repository_worktrees(last_used_at)`,
  );

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
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TEXT DEFAULT NULL`,
    );
  }
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user_created ON knowledge_bases(user_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_bases_visibility_created ON knowledge_bases(visibility, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_created ON knowledge_documents(kb_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_path ON knowledge_documents(kb_id, deleted_at, doc_path, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_status_created ON knowledge_documents(kb_id, deleted_at, status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user_list ON user_mcp_servers(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_visibility_list ON user_mcp_servers(visibility, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_skills_user_list ON user_skills(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_user_skills_visibility_list ON user_skills(visibility, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_marketplace_sources_list ON marketplace_sources(deleted_at, sort_order ASC, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user_list ON marketplace_installs(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_marketplace_installs_target_active ON marketplace_installs(target_id, deleted_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_repositories_auto_sync_due ON review_repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_repositories_list ON review_repositories(deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_repositories_auto_sync_due ON repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_repositories_user_updated ON repositories(user_id, deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_repositories_updated ON repositories(deleted_at, updated_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_profiles_repository_list ON review_profiles(repository_id, deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_profiles_list ON review_profiles(deleted_at, enabled DESC, updated_at DESC, name)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_profiles_match ON review_profiles(repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_repo_members_repo_granted ON review_repository_members(repository_id, granted_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_repository_created ON review_runs(repository_id, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_repo_updated ON review_runs(repository_id, updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_updated ON review_runs(updated_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_completed ON review_runs(repository_id, status, completed_at DESC, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_status_created ON review_runs(status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_created ON review_runs(repository_id, status, created_at ASC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteams_user_created ON workteams(user_id, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_workteam_agents_team_active_sort ON workteam_agents(team_id, deleted_at, sort_order)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(status, deleted_at, next_run)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_group_created ON scheduled_tasks(group_folder, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat_created ON scheduled_tasks(chat_jid, deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created ON scheduled_tasks(deleted_at, created_at DESC)`,
  );
  await safeMigrate(
    `ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE chats ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS created_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_agents ADD COLUMN IF NOT EXISTS created_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE workteam_agents ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS created_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS updated_at TEXT`,
  );
  await safeMigrate(
    `ALTER TABLE roles ADD COLUMN IF NOT EXISTS updated_at TEXT`,
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
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
    );
    await safeMigrate(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at TEXT DEFAULT NULL`,
    );
  }
  await safeMigrate(
    `UPDATE marketplace_sources SET created_by = '__system__' WHERE created_by IS NULL`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64) NOT NULL DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ADD COLUMN IF NOT EXISTS deleted_at TEXT DEFAULT NULL`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ALTER COLUMN created_by SET DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE marketplace_sources ALTER COLUMN created_by SET NOT NULL`,
  );
  await safeMigrate(
    `UPDATE conversation_shares SET created_by = '__system__' WHERE created_by IS NULL`,
  );
  await safeMigrate(
    `ALTER TABLE conversation_shares ALTER COLUMN created_by SET DEFAULT '__system__'`,
  );
  await safeMigrate(
    `ALTER TABLE conversation_shares ALTER COLUMN created_by SET NOT NULL`,
  );

  // ── Phase 2: Migrate review_repositories → repositories + repo_features ──
  await safeMigrate(`
    INSERT INTO repositories (
      id, name, language, local_repo_path, remote_provider, remote_repo_slug,
      remote_base_url, clone_url, default_target_branch, ssh_key_id,
      auto_sync_enabled, auto_sync_interval_minutes,
      last_auto_sync_at, next_auto_sync_at, last_auto_sync_status, last_auto_sync_message,
      enabled, status, visibility, ai_description, tech_stack_json,
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
    ON CONFLICT (id) DO NOTHING
  `);
  await safeMigrate(`
    INSERT INTO repo_features (id, repository_id, feature_type, enabled, config_json, created_at, updated_at)
    SELECT
      'cr_' || id, id, 'code_review', 1,
      json_build_object(
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
      )::text,
      created_at, updated_at
    FROM review_repositories
    WHERE deleted_at IS NULL
    ON CONFLICT (repository_id, feature_type) DO NOTHING
  `);

  // ── Phase 3: Migrate assistant_repo_bindings → repositories + resource_bindings ──
  // Step 1: Create repository records for unmatched clone_urls
  await safeMigrate(`
    INSERT INTO repositories (
      id, name, clone_url, default_target_branch,
      auto_sync_enabled, auto_sync_interval_minutes, enabled,
      status, user_id, created_by, updated_by, created_at, updated_at
    )
    SELECT
      'arb_' || arb.id, arb.name, arb.repo_url, arb.default_branch,
      0, 30, arb.enabled,
      'active', '__system__', '__system__', '__system__', arb.created_at, arb.updated_at
    FROM assistant_repo_bindings arb
    WHERE arb.repo_url IS NOT NULL
      AND arb.repo_url != ''
      AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.clone_url = arb.repo_url AND r.deleted_at IS NULL)
    ON CONFLICT (id) DO NOTHING
  `);
  // Step 2: Create resource_bindings from assistant_repo_bindings
  await safeMigrate(`
    INSERT INTO resource_bindings (
      id, resource_type, resource_id, owner_type, owner_id,
      binding_key, branch, work_directory, config_json, user_id, created_at
    )
    SELECT
      arb.id,
      'repository',
      COALESCE(
        (SELECT r.id FROM repositories r WHERE r.clone_url = arb.repo_url AND r.deleted_at IS NULL LIMIT 1),
        'arb_' || arb.id
      ),
      'assistant',
      arb.assistant_id,
      'default',
      arb.default_branch,
      arb.local_path,
      json_build_object(
        'legacy_arb_id', arb.id,
        'display_name', arb.name,
        'description', arb.description,
        'branch_filter', arb.branch_filter,
        'active_branch', arb.active_branch,
        'worktree_path', arb.worktree_path,
        'enabled', CASE WHEN arb.enabled = 1 THEN true ELSE false END
      )::text,
      '__system__',
      arb.created_at
    FROM assistant_repo_bindings arb
    WHERE arb.repo_url IS NOT NULL AND arb.repo_url != ''
    ON CONFLICT (resource_type, resource_id, owner_type, owner_id, binding_key) DO NOTHING
  `);

  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS allow_query_backfill INT NOT NULL DEFAULT 0`,
  );
  await safeMigrate(
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS overview_dirty_at TEXT`,
  );
}
