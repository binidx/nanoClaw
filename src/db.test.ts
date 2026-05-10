import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { setGlobalEngine, type DbEngine } from './database/engine.js';
import * as dbModule from './db.js';

vi.mock('./auth/permission-engine.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./auth/permission-engine.js')>();
  return { ...original, evaluateAny: vi.fn(original.evaluateAny) };
});

import {
  _applySchemaToDatabaseForTest,
  _buildPostgresSchemaForTest,
  _runMySQLMigrationsForTest,
  _runPostgresMigrationsForTest,
  _initTestDatabase,
  createAssistantMcpBinding,
  createAssistant,
  claimContextCompactionJob,
  compactContextEntries,
  completeContextCompactionJobFailure,
  completeContextCompactionJobSuccess,
  createProvider,
  grantProviderUserAccess,
  getProviderUserAccessList,
  createReviewRun,
  createTask,
  claimTaskExecution,
  deleteConversation,
  deleteTask,
  deleteCodeSearchSnapshot,
  enqueueContextCompactionJob,
  getContextEntries,
  getContextCompactionJob,
  getDueContextCompactionJobs,
  getLatestContextCompaction,
  getMemoryCompactionStats,
  getReviewBranchState,
  getReviewConversationBindingByChatJid,
  getReviewRunById,
  getReviewRunByIdempotencyKey,
  getAllChats,
  getAllProviders,
  getAllRegisteredGroups,
  getAssistant,
  getAssistantMcpBindingSecret,
  getConversationDisplayNames,
  getConversationList,
  getConversationListByAssistantId,
  getConversationSummaryByJid,
  getCodeSearchIndexRecord,
  getCodeSearchSnapshot,
  listContextCompactions,
  getLatestTaskRunLogsForTaskIds,
  getTaskSnapshots,
  hasBotReplyAfter,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTasksForChat,
  hasStoredMessage,
  logTaskRun,
  listAssistantMcpBindings,
  listDueReviewRepositoriesForAutoSync,
  saveReviewConversationBinding,
  saveReviewRepository,
  saveCodeSearchSnapshot,
  setRegisteredGroup,
  storeContextEntries,
  storeContextCompaction,
  storeChatMetadata,
  storeMessage,
  updateConversationMeta,
  updateProvider,
  getDefaultProviderForUser,
  getProviderShareList,
  getVisibleProvidersForUser,
  isProviderVisibleToUser,
  revokeProviderShare,
  setUserDefaultProviderPreference,
  shareProviderWithUser,
  updateReviewRun,
  updateTask,
  updateTaskAfterRun,
  upsertAssistantMcpBindingSecret,
  upsertReviewBranchState,
} from './db.js';
import { storeChatForUser } from './tenant/tenant-db.js';

beforeEach(async () => {
  _initTestDatabase();
});

function createRecordingEngine(dialect: DbEngine['dialect']): {
  engine: DbEngine;
  executedSql: string[];
} {
  const executedSql: string[] = [];
  const engine: DbEngine = {
    dialect,
    async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
      return [];
    },
    async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
      return undefined;
    },
    async run() {
      return { changes: 0, lastInsertRowid: 0 };
    },
    async exec(sql: string): Promise<void> {
      executedSql.push(sql.trim());
    },
    async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
      return fn(engine);
    },
    async close(): Promise<void> {},
  };
  return { engine, executedSql };
}

describe('schema migrations', () => {
  it('adds assistant_id to legacy registered_groups tables before creating its index', async () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          requires_trigger INTEGER DEFAULT 1
        );
      `);

      expect(() => _applySchemaToDatabaseForTest(database)).not.toThrow();

      const columns = database
        .prepare(`PRAGMA table_info(registered_groups)`)
        .all() as Array<{ name: string }>;
      const indexes = database
        .prepare(`PRAGMA index_list(registered_groups)`)
        .all() as Array<{ name: string }>;

      expect(columns.some((column) => column.name === 'assistant_id')).toBe(
        true,
      );
      expect(
        indexes.some(
          (index) => index.name === 'idx_registered_groups_assistant_id',
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it('creates assistant MCP binding tables for new schemas', async () => {
    const database = new Database(':memory:');
    try {
      expect(() => _applySchemaToDatabaseForTest(database)).not.toThrow();

      const bindingColumns = database
        .prepare(`PRAGMA table_info(assistant_mcp_bindings)`)
        .all() as Array<{ name: string }>;
      const secretColumns = database
        .prepare(`PRAGMA table_info(assistant_mcp_binding_secrets)`)
        .all() as Array<{ name: string }>;

      expect(bindingColumns.some((column) => column.name === 'template_server_id')).toBe(true);
      expect(secretColumns.some((column) => column.name === 'env_json')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('creates indexes that back paginated backend reads', async () => {
    const database = new Database(':memory:');
    try {
      expect(() => _applySchemaToDatabaseForTest(database)).not.toThrow();

      const indexNames = (table: string) =>
        (
          database
            .prepare(`PRAGMA index_list(${table})`)
            .all() as Array<{ name: string }>
        ).map((index) => index.name);

      expect(indexNames('memory_events')).toContain(
        'idx_memory_events_user_action_time',
      );
      expect(indexNames('knowledge_bases')).toEqual(
        expect.arrayContaining([
          'idx_knowledge_bases_user_created',
          'idx_knowledge_bases_visibility_created',
        ]),
      );
      expect(indexNames('knowledge_documents')).toContain(
        'idx_knowledge_docs_kb_active_created',
      );
      expect(indexNames('knowledge_documents')).toEqual(
        expect.arrayContaining([
          'idx_knowledge_docs_kb_active_path',
          'idx_knowledge_docs_kb_active_status_created',
        ]),
      );
      expect(indexNames('knowledge_wiki_pages')).toEqual(
        expect.arrayContaining([
          'idx_knowledge_wiki_pages_kb_type_title',
          'idx_knowledge_wiki_pages_kb_title_updated',
        ]),
      );
      expect(indexNames('review_repositories')).toContain(
        'idx_review_repositories_auto_sync_due',
      );
      expect(indexNames('review_repositories')).toContain(
        'idx_review_repositories_list',
      );
      expect(indexNames('repositories')).toContain(
        'idx_repositories_auto_sync_due',
      );
      expect(indexNames('repositories')).toEqual(
        expect.arrayContaining([
          'idx_repositories_user_updated',
          'idx_repositories_updated',
        ]),
      );
      expect(indexNames('review_profiles')).toEqual(
        expect.arrayContaining([
          'idx_review_profiles_repository_list',
          'idx_review_profiles_list',
          'idx_review_profiles_match',
        ]),
      );
      expect(indexNames('review_digest_runs')).toEqual(
        expect.arrayContaining([
          'idx_review_digest_runs_repo_scheduled',
          'idx_review_digest_runs_repo_type_status_created',
          'idx_review_digest_runs_schedule_status',
        ]),
      );
      expect(indexNames('review_runs')).toEqual(
        expect.arrayContaining([
          'idx_review_runs_repository_created',
          'idx_review_runs_repo_updated',
          'idx_review_runs_updated',
          'idx_review_runs_repo_status_completed',
          'idx_review_runs_status_created',
          'idx_review_runs_repo_status_created',
        ]),
      );
      expect(indexNames('review_repository_members')).toEqual(
        expect.arrayContaining([
          'idx_review_repo_members_user',
          'idx_review_repo_members_repo_granted',
        ]),
      );
      expect(indexNames('resource_access')).toEqual(
        expect.arrayContaining([
          'idx_resource_access_user',
          'idx_resource_access_resource',
          'idx_resource_access_user_type_expires',
          'idx_resource_access_resource_expires',
        ]),
      );
      expect(indexNames('scheduled_tasks')).toEqual(
        expect.arrayContaining([
          'idx_scheduled_tasks_due',
          'idx_scheduled_tasks_group_created',
          'idx_scheduled_tasks_chat_created',
          'idx_scheduled_tasks_created',
        ]),
      );
      expect(indexNames('workteams')).toContain(
        'idx_workteams_user_created',
      );
      expect(indexNames('workteam_agents')).toContain(
        'idx_workteam_agents_team_active_sort',
      );
      expect(indexNames('workteam_runs')).toEqual(
        expect.arrayContaining([
          'idx_workteam_runs_team_created',
          'idx_workteam_runs_status_created',
        ]),
      );
      expect(indexNames('workteam_events')).toContain(
        'idx_workteam_events_agent_messages',
      );
      expect(indexNames('workflows')).toContain(
        'idx_workflows_user_active_updated',
      );
      expect(indexNames('workflow_nodes')).toContain(
        'idx_workflow_nodes_workflow_active_sort',
      );
      expect(indexNames('workflow_edges')).toContain(
        'idx_workflow_edges_workflow_active_created',
      );
      expect(indexNames('workflow_runs')).toEqual(
        expect.arrayContaining([
          'idx_workflow_runs_workflow_created_desc',
          'idx_workflow_runs_status_created',
        ]),
      );
      expect(indexNames('workflow_run_nodes')).toContain(
        'idx_workflow_run_nodes_run_updated',
      );
      expect(indexNames('workflow_dialogue_sessions')).toContain(
        'idx_workflow_dialogue_sessions_lookup_created',
      );
      expect(indexNames('user_mcp_servers')).toEqual(
        expect.arrayContaining([
          'idx_user_mcp_servers_user_list',
          'idx_user_mcp_servers_visibility_list',
        ]),
      );
      expect(indexNames('user_skills')).toEqual(
        expect.arrayContaining([
          'idx_user_skills_user_list',
          'idx_user_skills_visibility_list',
        ]),
      );
      expect(indexNames('marketplace_sources')).toContain(
        'idx_marketplace_sources_list',
      );
      expect(indexNames('marketplace_installs')).toEqual(
        expect.arrayContaining([
          'idx_marketplace_installs_user_list',
          'idx_marketplace_installs_target_active',
        ]),
      );
    } finally {
      database.close();
    }

    const mysql = createRecordingEngine('mysql');
    await _runMySQLMigrationsForTest(mysql.engine);
    expect(mysql.executedSql).toEqual(
      expect.arrayContaining([
        'ALTER TABLE memory_events ADD INDEX idx_memory_events_user_action_time (user_id, action_type, created_at DESC)',
        'ALTER TABLE knowledge_bases ADD INDEX idx_knowledge_bases_user_created (user_id, deleted_at, created_at DESC)',
        'ALTER TABLE knowledge_bases ADD INDEX idx_knowledge_bases_visibility_created (visibility, deleted_at, created_at DESC)',
        'ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_created (kb_id, deleted_at, created_at DESC)',
        'ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_path (kb_id, deleted_at, doc_path, created_at ASC)',
        'ALTER TABLE knowledge_documents ADD INDEX idx_knowledge_docs_kb_active_status_created (kb_id, deleted_at, status, created_at ASC)',
        'CREATE INDEX idx_knowledge_wiki_pages_kb_type_title ON knowledge_wiki_pages(kb_id, page_type, title)',
        'CREATE INDEX idx_knowledge_wiki_pages_kb_title_updated ON knowledge_wiki_pages(kb_id, title, updated_at DESC)',
        'CREATE INDEX idx_user_mcp_servers_user_list ON user_mcp_servers(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_user_mcp_servers_visibility_list ON user_mcp_servers(visibility, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_user_skills_user_list ON user_skills(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_user_skills_visibility_list ON user_skills(visibility, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_marketplace_sources_list ON marketplace_sources(deleted_at, sort_order ASC, updated_at DESC)',
        'CREATE INDEX idx_marketplace_installs_user_list ON marketplace_installs(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_marketplace_installs_target_active ON marketplace_installs(target_id, deleted_at)',
        'ALTER TABLE review_repositories ADD INDEX idx_review_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)',
        'CREATE INDEX idx_review_repositories_list ON review_repositories(deleted_at, enabled DESC, updated_at DESC, name)',
        'ALTER TABLE repositories ADD INDEX idx_repositories_auto_sync_due (auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)',
        'CREATE INDEX idx_repositories_user_updated ON repositories(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX idx_repositories_updated ON repositories(deleted_at, updated_at DESC)',
        'CREATE INDEX idx_review_profiles_repository_list ON review_profiles(repository_id, deleted_at, enabled DESC, updated_at DESC, name)',
        'CREATE INDEX idx_review_profiles_list ON review_profiles(deleted_at, enabled DESC, updated_at DESC, name)',
        'CREATE INDEX idx_review_profiles_match ON review_profiles(repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC)',
        'CREATE INDEX idx_review_repo_members_repo_granted ON review_repository_members(repository_id, granted_at ASC)',
        'CREATE INDEX idx_review_digest_runs_repo_scheduled ON review_digest_runs(repository_id, scheduled_for DESC, created_at DESC)',
        'CREATE INDEX idx_review_digest_runs_repo_type_status_created ON review_digest_runs(repository_id, type, status, created_at DESC)',
        'CREATE INDEX idx_review_digest_runs_schedule_status ON review_digest_runs(repository_id, type, scheduled_for, status)',
        'CREATE INDEX idx_review_runs_repo_updated ON review_runs(repository_id, updated_at DESC, created_at DESC)',
        'CREATE INDEX idx_review_runs_updated ON review_runs(updated_at DESC, created_at DESC)',
        'CREATE INDEX idx_review_runs_repo_status_completed ON review_runs(repository_id, status, completed_at DESC, created_at DESC)',
        'CREATE INDEX idx_review_runs_status_created ON review_runs(status, created_at ASC)',
        'CREATE INDEX idx_review_runs_repo_status_created ON review_runs(repository_id, status, created_at ASC)',
        'CREATE INDEX idx_workteams_user_created ON workteams(user_id, deleted_at, created_at DESC)',
        'CREATE INDEX idx_workteam_agents_team_active_sort ON workteam_agents(team_id, deleted_at, sort_order)',
        'CREATE INDEX idx_workteam_runs_team_created ON workteam_runs(team_id, created_at DESC)',
        'CREATE INDEX idx_workteam_runs_status_created ON workteam_runs(status, created_at)',
        'CREATE INDEX idx_workteam_events_agent_messages ON workteam_events(run_id, target_agent_id, event_type, created_at)',
        'CREATE INDEX idx_workflows_user_active_updated ON workflows(user_id, deleted_at, updated_at DESC, created_at DESC)',
        'CREATE INDEX idx_workflow_nodes_workflow_active_sort ON workflow_nodes(workflow_id, deleted_at, sort_order, created_at)',
        'CREATE INDEX idx_workflow_edges_workflow_active_created ON workflow_edges(workflow_id, deleted_at, created_at)',
        'CREATE INDEX idx_workflow_runs_workflow_created_desc ON workflow_runs(workflow_id, created_at DESC)',
        'CREATE INDEX idx_workflow_runs_status_created ON workflow_runs(status, created_at)',
        'CREATE INDEX idx_workflow_run_nodes_run_updated ON workflow_run_nodes(run_id, updated_at)',
        'CREATE INDEX idx_workflow_dialogue_sessions_lookup_created ON workflow_dialogue_sessions(run_id, edge_id, created_at DESC)',
        'CREATE INDEX idx_resource_access_user_type_expires ON resource_access(user_id, resource_type, expires_at, resource_id)',
        'CREATE INDEX idx_resource_access_resource_expires ON resource_access(resource_type, resource_id, expires_at, user_id)',
        'CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(status, deleted_at, next_run)',
        'CREATE INDEX idx_scheduled_tasks_group_created ON scheduled_tasks(group_folder, deleted_at, created_at DESC)',
        'CREATE INDEX idx_scheduled_tasks_chat_created ON scheduled_tasks(chat_jid, deleted_at, created_at DESC)',
        'CREATE INDEX idx_scheduled_tasks_created ON scheduled_tasks(deleted_at, created_at DESC)',
      ]),
    );

    const postgres = createRecordingEngine('postgres');
    await _runPostgresMigrationsForTest(postgres.engine);
    expect(postgres.executedSql).toEqual(
      expect.arrayContaining([
        'CREATE INDEX IF NOT EXISTS idx_memory_events_user_action_time ON memory_events(user_id, action_type, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user_created ON knowledge_bases(user_id, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_bases_visibility_created ON knowledge_bases(visibility, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_created ON knowledge_documents(kb_id, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_path ON knowledge_documents(kb_id, deleted_at, doc_path, created_at ASC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_status_created ON knowledge_documents(kb_id, deleted_at, status, created_at ASC)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_type_title ON knowledge_wiki_pages(kb_id, page_type, title)',
        'CREATE INDEX IF NOT EXISTS idx_knowledge_wiki_pages_kb_title_updated ON knowledge_wiki_pages(kb_id, title, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user_list ON user_mcp_servers(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_visibility_list ON user_mcp_servers(visibility, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_user_skills_user_list ON user_skills(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_user_skills_visibility_list ON user_skills(visibility, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_marketplace_sources_list ON marketplace_sources(deleted_at, sort_order ASC, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user_list ON marketplace_installs(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_marketplace_installs_target_active ON marketplace_installs(target_id, deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_review_repositories_auto_sync_due ON review_repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)',
        'CREATE INDEX IF NOT EXISTS idx_review_repositories_list ON review_repositories(deleted_at, enabled DESC, updated_at DESC, name)',
        'CREATE INDEX IF NOT EXISTS idx_repositories_auto_sync_due ON repositories(auto_sync_enabled, enabled, deleted_at, next_auto_sync_at)',
        'CREATE INDEX IF NOT EXISTS idx_repositories_user_updated ON repositories(user_id, deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_repositories_updated ON repositories(deleted_at, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_profiles_repository_list ON review_profiles(repository_id, deleted_at, enabled DESC, updated_at DESC, name)',
        'CREATE INDEX IF NOT EXISTS idx_review_profiles_list ON review_profiles(deleted_at, enabled DESC, updated_at DESC, name)',
        'CREATE INDEX IF NOT EXISTS idx_review_profiles_match ON review_profiles(repository_id, deleted_at, stage, enabled, source_mode, updated_at DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_repo_members_repo_granted ON review_repository_members(repository_id, granted_at ASC)',
        'CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_scheduled ON review_digest_runs(repository_id, scheduled_for DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_digest_runs_repo_type_status_created ON review_digest_runs(repository_id, type, status, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_digest_runs_schedule_status ON review_digest_runs(repository_id, type, scheduled_for, status)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_repository_created ON review_runs(repository_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_repo_updated ON review_runs(repository_id, updated_at DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_updated ON review_runs(updated_at DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_completed ON review_runs(repository_id, status, completed_at DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_status_created ON review_runs(status, created_at ASC)',
        'CREATE INDEX IF NOT EXISTS idx_review_runs_repo_status_created ON review_runs(repository_id, status, created_at ASC)',
        'CREATE INDEX IF NOT EXISTS idx_workteams_user_created ON workteams(user_id, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_workteam_agents_team_active_sort ON workteam_agents(team_id, deleted_at, sort_order)',
        'CREATE INDEX IF NOT EXISTS idx_workteam_runs_team_created ON workteam_runs(team_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_workteam_runs_status_created ON workteam_runs(status, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_workteam_events_agent_messages ON workteam_events(run_id, target_agent_id, event_type, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_workflows_user_active_updated ON workflows(user_id, deleted_at, updated_at DESC, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow_active_sort ON workflow_nodes(workflow_id, deleted_at, sort_order, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow_active_created ON workflow_edges(workflow_id, deleted_at, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_created_desc ON workflow_runs(workflow_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_run_nodes_run_updated ON workflow_run_nodes(run_id, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_workflow_dialogue_sessions_lookup_created ON workflow_dialogue_sessions(run_id, edge_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_resource_access_user_type_expires ON resource_access(user_id, resource_type, expires_at, resource_id)',
        'CREATE INDEX IF NOT EXISTS idx_resource_access_resource_expires ON resource_access(resource_type, resource_id, expires_at, user_id)',
        'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(status, deleted_at, next_run)',
        'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_group_created ON scheduled_tasks(group_folder, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat_created ON scheduled_tasks(chat_jid, deleted_at, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_created ON scheduled_tasks(deleted_at, created_at DESC)',
      ]),
    );
  });

  it('adds missing live2d preference columns to legacy sqlite tables', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE live2d_user_preferences (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          enabled INTEGER DEFAULT 0,
          selected_model_id TEXT,
          position TEXT DEFAULT 'right',
          panel_width INTEGER DEFAULT 280,
          opacity INTEGER DEFAULT 100,
          emotion_provider_id TEXT,
          updated_at TEXT NOT NULL
        );
      `);

      expect(() => _applySchemaToDatabaseForTest(database)).not.toThrow();

      const columns = database
        .prepare(`PRAGMA table_info(live2d_user_preferences)`)
        .all() as Array<{ name: string }>;

      expect(columns.some((column) => column.name === 'model_scale')).toBe(true);
      expect(columns.some((column) => column.name === 'model_offset_y')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('uses BIGINT for large filesystem metadata in postgres sync state schema', () => {
    const schema = _buildPostgresSchemaForTest();

    expect(schema).toContain('file_mtime_ms BIGINT NOT NULL');
    expect(schema).toContain('file_size BIGINT NOT NULL');
    expect(schema).not.toContain('file_mtime_ms INT NOT NULL');
    expect(schema).not.toContain('file_size INT NOT NULL');
  });

  it('keeps fresh postgres schema aligned with startup-migrated business columns', () => {
    const schema = _buildPostgresSchemaForTest();
    const tableSql = (table: string) => {
      const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = schema.match(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS ${escapedTable} \\([\\s\\S]*?\\n\\s*\\);`,
        ),
      );
      if (!match) throw new Error(`Missing ${table} table in postgres schema`);
      return match[0];
    };

    expect(tableSql('chats')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('messages')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('assistant_turns')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('context_entries')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('registered_groups')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('scheduled_tasks')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('assistants')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );
    expect(tableSql('ai_providers')).toContain(
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
    );

    const knowledgeBases = tableSql('knowledge_bases');
    for (const column of [
      `user_id TEXT NOT NULL DEFAULT '__system__'`,
      `category TEXT NOT NULL DEFAULT 'general'`,
      `visibility TEXT NOT NULL DEFAULT 'private'`,
      `enhancement_level TEXT NOT NULL DEFAULT 'metadata'`,
      `llm_provider_id TEXT`,
      `llm_model_override TEXT`,
      `temporal_half_life_days INT NOT NULL DEFAULT 365`,
      `allow_query_backfill INT NOT NULL DEFAULT 0`,
    ]) {
      expect(knowledgeBases).toContain(column);
    }

    const knowledgeDocuments = tableSql('knowledge_documents');
    for (const column of [
      `source_url TEXT`,
      `published_at TEXT`,
      `superseded_by TEXT`,
      `parent_doc_id TEXT`,
      `doc_path TEXT`,
      `depth INT NOT NULL DEFAULT 0`,
      `llm_status TEXT`,
    ]) {
      expect(knowledgeDocuments).toContain(column);
    }

    expect(schema).toContain(
      'CREATE INDEX IF NOT EXISTS idx_chats_user_id',
    );
    expect(schema).toContain(
      'CREATE INDEX IF NOT EXISTS idx_messages_user_id',
    );
    expect(schema).toContain(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_docs_kb_active_path',
    );
  });

  it('repairs legacy chats columns during postgres startup migrations', async () => {
    const executedSql: string[] = [];
    const fakePgEngine: DbEngine = {
      dialect: 'postgres',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        executedSql.push(sql.trim());
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakePgEngine);
      },
      async close(): Promise<void> {},
    };

    await _runPostgresMigrationsForTest(fakePgEngine);

    expect(executedSql).toContain(`ALTER TABLE chats ADD COLUMN custom_title TEXT`);
    expect(executedSql).toContain(`ALTER TABLE chats ADD COLUMN is_pinned INT DEFAULT 0`);
    expect(executedSql).toContain(`ALTER TABLE chats ADD COLUMN is_favorite INT DEFAULT 0`);
    expect(executedSql).toContain(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    expect(executedSql).toContain(`ALTER TABLE chats ADD COLUMN is_group INT DEFAULT 0`);
  });

  it('repairs legacy live2d preference columns during postgres startup migrations', async () => {
    const executedSql: string[] = [];
    const fakePgEngine: DbEngine = {
      dialect: 'postgres',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        executedSql.push(sql.trim());
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakePgEngine);
      },
      async close(): Promise<void> {},
    };

    await _runPostgresMigrationsForTest(fakePgEngine);

    expect(executedSql).toContain(`ALTER TABLE live2d_user_preferences ADD COLUMN model_scale REAL DEFAULT 1.0`);
    expect(executedSql).toContain(`ALTER TABLE live2d_user_preferences ADD COLUMN model_offset_y INT DEFAULT 0`);
  });

  it('repairs legacy live2d preference columns during mysql startup migrations', async () => {
    const executedSql: string[] = [];
    const fakeMySqlEngine: DbEngine = {
      dialect: 'mysql',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        executedSql.push(sql.trim());
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakeMySqlEngine);
      },
      async close(): Promise<void> {},
    };

    await _runMySQLMigrationsForTest(fakeMySqlEngine);

    expect(executedSql).toContain(`ALTER TABLE live2d_user_preferences ADD COLUMN model_scale FLOAT DEFAULT 1.0`);
    expect(executedSql).toContain(`ALTER TABLE live2d_user_preferences ADD COLUMN model_offset_y INT DEFAULT 0`);
  });

  it('repairs legacy registered_groups timestamp columns during mysql startup migrations', async () => {
    const executedSql: string[] = [];
    const fakeMySqlEngine: DbEngine = {
      dialect: 'mysql',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        executedSql.push(sql.trim());
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakeMySqlEngine);
      },
      async close(): Promise<void> {},
    };

    await _runMySQLMigrationsForTest(fakeMySqlEngine);

    expect(executedSql).toContain(`ALTER TABLE registered_groups ADD COLUMN created_at VARCHAR(64)`);
    expect(executedSql).toContain(`ALTER TABLE registered_groups ADD COLUMN updated_at VARCHAR(64)`);
  });

  it('does not fail mysql startup schema flow when FULLTEXT is unsupported', async () => {
    const executedSql: string[] = [];
    const fakeMySqlEngine: DbEngine = {
      dialect: 'mysql',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        const trimmed = sql.trim();
        executedSql.push(trimmed);
        if (trimmed.includes('FULLTEXT INDEX') || trimmed.includes('CREATE FULLTEXT INDEX')) {
          const err = new Error('FULLTEXT and SPATIAL index is not supported') as Error & {
            errno?: number;
            sqlState?: string;
          };
          err.errno = 8200;
          err.sqlState = 'HY000';
          throw err;
        }
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakeMySqlEngine);
      },
      async close(): Promise<void> {},
    };

    await expect(
      (dbModule as typeof dbModule & {
        _createSchemaOnEngineForTest?: (engine: DbEngine) => Promise<void>;
      })._createSchemaOnEngineForTest?.(fakeMySqlEngine),
    ).resolves.toBeUndefined();

    expect(executedSql.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS user_memories'))).toBe(true);
  });

  it('skips mysql FULLTEXT startup migrations when the engine does not support them', async () => {
    const executedSql: string[] = [];
    const fakeMySqlEngine: DbEngine = {
      dialect: 'mysql',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        const trimmed = sql.trim();
        executedSql.push(trimmed);
        if (trimmed.includes('CREATE FULLTEXT INDEX')) {
          const err = new Error('FULLTEXT and SPATIAL index is not supported') as Error & {
            errno?: number;
            sqlState?: string;
          };
          err.errno = 8200;
          err.sqlState = 'HY000';
          throw err;
        }
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakeMySqlEngine);
      },
      async close(): Promise<void> {},
    };

    await expect(_runMySQLMigrationsForTest(fakeMySqlEngine)).resolves.toBeUndefined();

    expect(executedSql).toContain(`ALTER TABLE user_memories ADD COLUMN confidence DOUBLE NOT NULL DEFAULT 0.5`);
  });

  it('runs postgres startup migrations before parity indexes for legacy user_memories tables', async () => {
    const executedSql: string[] = [];
    let legacyUserMemoriesHasTier = false;

    const fakePgEngine: DbEngine = {
      dialect: 'postgres',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(sql: string): Promise<void> {
        const trimmed = sql.trim();
        executedSql.push(trimmed);

        if (trimmed === `ALTER TABLE user_memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'durable'`) {
          legacyUserMemoriesHasTier = true;
          return;
        }

        if (
          trimmed.includes('CREATE TABLE IF NOT EXISTS user_memories') &&
          trimmed.includes('CREATE INDEX IF NOT EXISTS idx_user_memories_tier') &&
          !legacyUserMemoriesHasTier
        ) {
          throw new Error('column "tier" does not exist');
        }
      },
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakePgEngine);
      },
      async close(): Promise<void> {},
    };

    await expect(
      (dbModule as typeof dbModule & {
        _createSchemaOnEngineForTest?: (engine: DbEngine) => Promise<void>;
      })._createSchemaOnEngineForTest?.(fakePgEngine),
    ).resolves.toBeUndefined();

    const tierMigrationIndex = executedSql.indexOf(
      `ALTER TABLE user_memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'durable'`,
    );
    const schemaBatchIndex = executedSql.findIndex((sql) =>
      sql.includes('CREATE INDEX IF NOT EXISTS idx_user_memories_tier'),
    );

    expect(tierMigrationIndex).toBeGreaterThanOrEqual(0);
    expect(schemaBatchIndex).toBeGreaterThan(tierMigrationIndex);
  });
});

// Helper to store a message using the normalized NewMessage interface
async function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  client_id?: string;
  run_id?: string;
  is_from_me?: boolean;
}) {
  await storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    client_id: overrides.client_id,
    run_id: overrides.run_id,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('detects existing messages by chat and id', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-known',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello again',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    expect(await hasStoredMessage('group@g.us', 'msg-known')).toBe(true);
    expect(await hasStoredMessage('group@g.us', 'msg-missing')).toBe(false);
    expect(await hasStoredMessage('other@g.us', 'msg-known')).toBe(false);
  });

  it('upserts on duplicate id+chat_jid', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    await store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });

  it('persists client and run metadata for reconciliation', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'msg-meta',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello metadata',
      timestamp: '2024-01-01T00:00:06.000Z',
      client_id: 'client-1',
      run_id: 'run-1',
    });

    const messages = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].client_id).toBe('client-1');
    expect(messages[0].run_id).toBe('run-1');
  });
});

describe('context_entries ledger', () => {
  it('stores context entries in created order', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await storeContextEntries([
      {
        id: 'msg:group@g.us:user-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: '@ADY hello',
        content_json: JSON.stringify({ sender: 'alice' }),
        token_estimate: 3,
        created_at: '2024-01-01T00:00:01.000Z',
      },
      {
        id: 'msg:group@g.us:bot-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'bot-1',
        content_text: 'hello back',
        content_json: JSON.stringify({ sender: 'ADY' }),
        token_estimate: 3,
        created_at: '2024-01-01T00:00:02.000Z',
      },
    ]);

    const entries = await getContextEntries('group@g.us');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([
      'msg:group@g.us:user-1',
      'msg:group@g.us:bot-1',
    ]);
    expect(entries[0]?.role).toBe('user');
    expect(entries[1]?.source_type).toBe('assistant_message');
  });

  it('upserts duplicate context entry ids', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await storeContextEntries([
      {
        id: 'msg:group@g.us:user-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'original',
        content_json: null,
        token_estimate: 2,
        created_at: '2024-01-01T00:00:01.000Z',
      },
    ]);

    await storeContextEntries([
      {
        id: 'msg:group@g.us:user-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'updated',
        content_json: null,
        token_estimate: 2,
        created_at: '2024-01-01T00:00:01.000Z',
      },
    ]);

    const entries = await getContextEntries('group@g.us');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content_text).toBe('updated');
  });
});

describe('context compactions', () => {
  it('stores and reuses deterministic compaction summaries for older entries', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await storeContextEntries([
      {
        id: 'msg:group@g.us:user-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-1',
        content_text: 'first user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2024-01-01T00:00:01.000Z',
      },
      {
        id: 'msg:group@g.us:assistant-1',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-1',
        content_text: 'first assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2024-01-01T00:00:02.000Z',
      },
      {
        id: 'msg:group@g.us:user-2',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-2',
        content_text: 'second user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2024-01-01T00:00:03.000Z',
      },
      {
        id: 'msg:group@g.us:assistant-2',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'assistant',
        source_type: 'assistant_message',
        source_ref: 'assistant-2',
        content_text: 'second assistant reply',
        content_json: null,
        token_estimate: 4,
        created_at: '2024-01-01T00:00:04.000Z',
      },
      {
        id: 'msg:group@g.us:user-3',
        group_folder: 'group-folder',
        chat_jid: 'group@g.us',
        run_id: 'run-1',
        provider: 'claude',
        role: 'user',
        source_type: 'chat_message',
        source_ref: 'user-3',
        content_text: 'third user message',
        content_json: null,
        token_estimate: 4,
        created_at: '2024-01-01T00:00:05.000Z',
      },
    ]);

    const firstCompaction = await compactContextEntries({
      chatJid: 'group@g.us',
      triggerEntries: 4,
      keepRecentEntries: 2,
    });

    expect(firstCompaction).toBeTruthy();
    expect(firstCompaction?.compacted_until).toBe('2024-01-01T00:00:03.000Z');
    expect(firstCompaction?.summary_text).toContain(
      'Earlier conversation summary (3 messages through 2024-01-01T00:00:03.000Z):',
    );
    expect(firstCompaction?.summary_text).toContain(
      '[assistant] 2024-01-01T00:00:02.000Z first assistant reply',
    );
    expect(firstCompaction?.source_entry_ids_json).toBe(
      JSON.stringify([
        'msg:group@g.us:user-1',
        'msg:group@g.us:assistant-1',
        'msg:group@g.us:user-2',
      ]),
    );
    expect((await getLatestContextCompaction('group@g.us'))?.id).toBe(
      firstCompaction?.id,
    );
    expect(await listContextCompactions('group@g.us')).toHaveLength(1);

    const repeatedCompaction = await compactContextEntries({
      chatJid: 'group@g.us',
      triggerEntries: 4,
      keepRecentEntries: 2,
    });

    expect(repeatedCompaction?.id).toBe(firstCompaction?.id);
    expect(await listContextCompactions('group@g.us')).toHaveLength(1);
  });
});

describe('context compaction jobs', () => {
  it('queues, claims, and records successful background compaction runs', async () => {
    const now = '2026-03-18T00:00:00.000Z';
    await storeChatMetadata('group@g.us', now);
    await enqueueContextCompactionJob({
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      now,
    });

    expect(
      (await getDueContextCompactionJobs({ now, limit: 10 })).map(
        (job) => job.chat_jid,
      ),
    ).toEqual(['group@g.us']);
    expect(await claimContextCompactionJob('group@g.us', { now })).toBe(true);

    await completeContextCompactionJobSuccess({
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      startedAt: now,
      finishedAt: '2026-03-18T00:00:03.000Z',
      durationMs: 3000,
      resultSummaryId: 'summary-1',
    });

    const job = await getContextCompactionJob('group@g.us');
    expect(job?.pending).toBe(0);
    expect(job?.runtime_claimed_at).toBeNull();
    expect(job?.run_count).toBe(1);
    expect(job?.failure_count).toBe(0);
    expect(job?.last_success_at).toBe('2026-03-18T00:00:03.000Z');

    const stats = await getMemoryCompactionStats({
      now: new Date('2026-03-18T00:10:00.000Z'),
    });
    expect(stats.worker.recentRuns24h).toBe(1);
    expect(stats.worker.recentFailures24h).toBe(0);
    expect(stats.worker.lastDurationMs).toBe(3000);
  });

  it('requeues failed background compaction runs with retry metadata', async () => {
    const now = '2026-03-18T01:00:00.000Z';
    await storeChatMetadata('group@g.us', now);
    await enqueueContextCompactionJob({
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      now,
    });
    expect(await claimContextCompactionJob('group@g.us', { now })).toBe(true);

    await completeContextCompactionJobFailure({
      chatJid: 'group@g.us',
      groupFolder: 'group-folder',
      startedAt: now,
      finishedAt: '2026-03-18T01:00:05.000Z',
      durationMs: 5000,
      error: 'compaction failed',
      retryAt: '2026-03-18T01:00:35.000Z',
    });

    const job = await getContextCompactionJob('group@g.us');
    expect(job?.pending).toBe(1);
    expect(job?.available_at).toBe('2026-03-18T01:00:35.000Z');
    expect(job?.failure_count).toBe(1);
    expect(job?.last_error).toBe('compaction failed');

    const stats = await getMemoryCompactionStats({
      now: new Date('2026-03-18T01:10:00.000Z'),
    });
    expect(stats.worker.recentRuns24h).toBe(1);
    expect(stats.worker.recentFailures24h).toBe(1);
    expect(stats.worker.lastError).toBe('compaction failed');
  });
});

describe('conversation deletion', () => {
  it('removes context compaction records before deleting a chat', async () => {
    const jid = 'web:test';
    const groupFolder = 'group-folder';
    const now = '2026-03-18T00:00:00.000Z';

    await storeChatMetadata(jid, now, 'Web User', 'web', false);
    await storeContextEntries([
      {
        id: 'ctx-1',
        group_folder: groupFolder,
        chat_jid: jid,
        run_id: null,
        provider: 'openai',
        role: 'user',
        source_type: 'message',
        source_ref: 'msg-1',
        content_text: 'first message',
        content_json: null,
        token_estimate: 12,
        created_at: now,
      },
      {
        id: 'ctx-2',
        group_folder: groupFolder,
        chat_jid: jid,
        run_id: null,
        provider: 'openai',
        role: 'assistant',
        source_type: 'message',
        source_ref: 'msg-2',
        content_text: 'assistant reply',
        content_json: null,
        token_estimate: 18,
        created_at: '2026-03-18T00:00:02.000Z',
      },
    ]);
    await storeContextCompaction({
      id: 'compaction-1',
      group_folder: groupFolder,
      chat_jid: jid,
      compacted_until: '2026-03-18T00:00:02.000Z',
      summary_text: 'summary',
      source_entry_ids_json: JSON.stringify(['ctx-1', 'ctx-2']),
      created_at: '2026-03-18T00:00:03.000Z',
    });
    await enqueueContextCompactionJob({
      chatJid: jid,
      groupFolder,
      now,
    });
    expect(await claimContextCompactionJob(jid, { now })).toBe(true);
    await completeContextCompactionJobSuccess({
      chatJid: jid,
      groupFolder,
      startedAt: now,
      finishedAt: '2026-03-18T00:00:05.000Z',
      durationMs: 5000,
      resultSummaryId: 'compaction-1',
    });

    await deleteConversation(jid);
    expect(await getConversationSummaryByJid(jid)).toBeUndefined();
    expect(await getContextEntries(jid)).toEqual([]);
    expect(await getLatestContextCompaction(jid)).toBeUndefined();
    expect(await getContextCompactionJob(jid)).toBeUndefined();
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    await storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    await store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', async () => {
    const msgs = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', async () => {
    const msgs = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', async () => {
    const msgs = await getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', async () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    await store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = await getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

describe('hasBotReplyAfter', () => {
  it('returns true when a bot reply exists after the timestamp', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    await store({
      id: 'user-1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await storeMessage({
      id: 'bot-1',
      chat_jid: 'group@g.us',
      sender: 'Andy',
      sender_name: 'Andy',
      content: 'reply',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    expect(await hasBotReplyAfter('group@g.us', '2024-01-01T00:00:01.000Z')).toBe(
      true,
    );
  });

  it('returns false when only user messages exist after the timestamp', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    await store({
      id: 'user-1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    expect(await hasBotReplyAfter('group@g.us', '2024-01-01T00:00:01.000Z')).toBe(
      false,
    );
  });
});

describe('getTaskSnapshots', () => {
  it('returns the task snapshot shape in reverse creation order', async () => {
    await createTask({
      id: 'task-older',
      group_folder: 'group-a',
      chat_jid: 'a@g.us',
      prompt: 'older task',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await createTask({
      id: 'task-newer',
      group_folder: 'group-b',
      chat_jid: 'b@g.us',
      prompt: 'newer task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: '2026-01-02T00:00:00.000Z',
      status: 'paused',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    expect(await getTaskSnapshots()).toEqual([
      {
        id: 'task-newer',
        groupFolder: 'group-b',
        prompt: 'newer task',
        schedule_type: 'interval',
        schedule_value: '60000',
        retry_limit: 0,
        retry_backoff_ms: 300000,
        failure_mode: 'continue',
        status: 'paused',
        next_run: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'task-older',
        groupFolder: 'group-a',
        prompt: 'older task',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
        retry_limit: 0,
        retry_backoff_ms: 300000,
        failure_mode: 'continue',
        status: 'active',
        next_run: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(async () => {
    await storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    await storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    await store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    await storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    await store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', async () => {
    const { messages, newTimestamp } = await getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', async () => {
    const { messages } = await getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', async () => {
    const { messages, newTimestamp } = await getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = await getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = await getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = await getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', async () => {
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = await getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

describe('getConversationList', () => {
  it('returns the latest message for each conversation', async () => {
    await storeChatMetadata('group-1@g.us', '2024-01-01T00:00:03.000Z', 'Group 1');
    await storeChatMetadata('group-2@g.us', '2024-01-01T00:00:02.000Z', 'Group 2');

    await store({
      id: 'group-1-first',
      chat_jid: 'group-1@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await store({
      id: 'group-1-latest',
      chat_jid: 'group-1@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'latest group one',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
    await store({
      id: 'group-2-latest',
      chat_jid: 'group-2@g.us',
      sender: 'bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'latest group two',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const conversations = await getConversationList();
    expect(conversations).toHaveLength(2);
    expect(
      conversations.find((item) => item.jid === 'group-1@g.us')?.last_message,
    ).toBe('latest group one');
    expect(
      conversations.find((item) => item.jid === 'group-2@g.us')?.last_message,
    ).toBe('latest group two');
  });

  it('filters hidden workflow/workteam channels from the default list', async () => {
    await storeChatMetadata(
      'web:workflow-a',
      '2024-01-01T00:00:00.000Z',
      'Workflow A',
      'workflow',
      false,
    );
    await storeChatMetadata(
      'web:workteam-a',
      '2024-01-01T00:00:01.000Z',
      'Workteam A',
      'workteam',
      false,
    );
    await storeChatMetadata(
      'web:normal-chat',
      '2024-01-01T00:00:02.000Z',
      'Normal Chat',
      'web',
      false,
    );

    const conversations = await getConversationList();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.jid).toBe('web:normal-chat');
  });

});

describe('conversation summary helpers', () => {
  it('returns direct conversation summary and display names without scanning the full list in callers', async () => {
    await storeChatMetadata(
      'group-1@g.us',
      '2024-01-01T00:00:00.000Z',
      'Group One',
      'whatsapp',
      true,
    );
    await store({
      id: 'msg-1',
      chat_jid: 'group-1@g.us',
      sender: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'latest group one',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    await updateConversationMeta('group-1@g.us', { customTitle: 'Pinned Group One' });

    expect(await getConversationSummaryByJid('group-1@g.us')).toMatchObject({
      jid: 'group-1@g.us',
      display_name: 'Pinned Group One',
      last_message: 'latest group one',
      channel: 'whatsapp',
    });
    expect(
      await getConversationDisplayNames(['group-1@g.us', 'missing@g.us']),
    ).toEqual({
      'group-1@g.us': 'Pinned Group One',
    });
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', async () => {
    await createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = await getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', async () => {
    await createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await updateTask('task-2', { status: 'paused' });
    expect((await getTaskById('task-2'))!.status).toBe('paused');
  });

  it('persists retry policy fields on task create and read', async () => {
    await createTask({
      id: 'task-retry',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'retry me',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      retry_limit: 3,
      retry_backoff_ms: 120000,
      failure_mode: 'pause',
      consecutive_failures: 2,
      last_error: 'network error',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(await getTaskById('task-retry')).toMatchObject({
      retry_limit: 3,
      retry_backoff_ms: 120000,
      failure_mode: 'pause',
      consecutive_failures: 2,
      last_error: 'network error',
    });
  });

  it('updates task failure bookkeeping after a run', async () => {
    await createTask({
      id: 'task-after-run',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'after run',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await updateTaskAfterRun('task-after-run', {
      nextRun: null,
      lastResult: 'Error: network error',
      consecutiveFailures: 1,
      lastError: 'network error',
    });

    expect(await getTaskById('task-after-run')).toMatchObject({
      next_run: null,
      last_result: 'Error: network error',
      status: 'completed',
      consecutive_failures: 1,
      last_error: 'network error',
    });
    expect((await getTaskById('task-after-run'))?.last_run).toBeTruthy();
  });

  it('claims a due task only once until the claim is cleared', async () => {
    await createTask({
      id: 'task-claim',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'claim me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(
      await claimTaskExecution('task-claim', {
        requireDue: true,
        now: '2024-06-01T00:00:01.000Z',
      }),
    ).toBe(true);
    expect(
      await claimTaskExecution('task-claim', {
        requireDue: true,
        now: '2024-06-01T00:00:02.000Z',
      }),
    ).toBe(false);
    expect((await getTaskById('task-claim'))?.runtime_claimed_at).toBe(
      '2024-06-01T00:00:01.000Z',
    );

    await updateTaskAfterRun('task-claim', {
      nextRun: null,
      lastResult: 'Completed',
      lastError: null,
    });

    expect((await getTaskById('task-claim'))?.runtime_claimed_at).toBeNull();
  });

  it('deletes a task and its run logs', async () => {
    await createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await deleteTask('task-3');
    expect(await getTaskById('task-3')).toBeUndefined();
  });

  it('returns filtered task snapshots and chat task lists without full scans', async () => {
    await createTask({
      id: 'task-main',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    await createTask({
      id: 'task-other',
      group_folder: 'other',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:01:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:01.000Z',
    });

    expect(await getTaskSnapshots('main')).toEqual([
      {
        id: 'task-main',
        groupFolder: 'main',
        prompt: 'main task',
        schedule_type: 'once',
        schedule_value: '2024-06-01T00:00:00.000Z',
        retry_limit: 0,
        retry_backoff_ms: 300000,
        failure_mode: 'continue',
        status: 'active',
        next_run: '2024-06-01T00:00:00.000Z',
      },
    ]);
    expect((await getTasksForChat('other@g.us')).map((task) => task.id)).toEqual([
      'task-other',
    ]);
  });

  it('returns the latest run log only for the requested task ids', async () => {
    await createTask({
      id: 'task-with-runs',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    await createTask({
      id: 'task-other-runs',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'run me too',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await logTaskRun({
      task_id: 'task-with-runs',
      run_at: '2024-01-01T00:00:01.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'older',
      error: null,
    });
    await logTaskRun({
      task_id: 'task-with-runs',
      run_at: '2024-01-01T00:00:02.000Z',
      duration_ms: 120,
      status: 'error',
      result: null,
      error: 'latest',
    });
    await logTaskRun({
      task_id: 'task-other-runs',
      run_at: '2024-01-01T00:00:03.000Z',
      duration_ms: 80,
      status: 'success',
      result: 'other',
      error: null,
    });

    expect(await getLatestTaskRunLogsForTaskIds(['task-with-runs'])).toEqual([
      {
        task_id: 'task-with-runs',
        run_at: '2024-01-01T00:00:02.000Z',
        duration_ms: 120,
        status: 'error',
        result: null,
        error: 'latest',
      },
    ]);
  });
});

describe('code search index persistence helpers', () => {
  it('stores and reloads normalized file, symbol, and term metadata by cache key', async () => {
    await saveCodeSearchSnapshot({
      cache_key: 'code-search-index:workspace-a',
      root_directory: '/repo/workspace-a',
      manifest_hash: 'manifest-1',
      build_options_json: JSON.stringify({
        maxFiles: 500,
        maxFileBytes: 131072,
        maxTermsPerFile: 40,
        maxPreviewLines: 2,
      }),
      generated_at: '2026-03-18T00:00:00.000Z',
      file_count: 1,
      symbol_count: 1,
      term_count: 2,
      files: [
        {
          relative_path: 'src/service.ts',
          absolute_path: '/repo/workspace-a/src/service.ts',
          extension: '.ts',
          language: 'typescript',
          byte_size: 128,
          line_count: 12,
          imports_json: JSON.stringify([
            {
              modulePath: './deps',
              symbolName: 'ServiceDeps',
              line: 1,
              signature: "import { ServiceDeps } from './deps';",
            },
          ]),
          previews_json: JSON.stringify(['export class OrderService {}']),
          terms: ['order', 'service'],
          symbols: [
            {
              name: 'OrderService',
              kind: 'class',
              line: 1,
              column_number: 8,
              signature: 'export class OrderService {}',
            },
          ],
        },
      ],
    });

    expect(
      await getCodeSearchIndexRecord('code-search-index:workspace-a'),
    ).toMatchObject({
      root_directory: '/repo/workspace-a',
      manifest_hash: 'manifest-1',
      file_count: 1,
      symbol_count: 1,
      term_count: 2,
    });
    expect(
      await getCodeSearchSnapshot('code-search-index:workspace-a'),
    ).toMatchObject({
      index: expect.objectContaining({
        generated_at: '2026-03-18T00:00:00.000Z',
      }),
      files: [
        expect.objectContaining({
          relative_path: 'src/service.ts',
          language: 'typescript',
          imports_json: expect.stringContaining('ServiceDeps'),
        }),
      ],
      symbols: [
        expect.objectContaining({
          relative_path: 'src/service.ts',
          name: 'OrderService',
          column_number: 8,
        }),
      ],
      terms: [
        expect.objectContaining({
          relative_path: 'src/service.ts',
          ordinal: 0,
          term: 'order',
        }),
        expect.objectContaining({
          relative_path: 'src/service.ts',
          ordinal: 1,
          term: 'service',
        }),
      ],
    });

    await deleteCodeSearchSnapshot('code-search-index:workspace-a');
    expect(
      await getCodeSearchSnapshot('code-search-index:workspace-a'),
    ).toBeUndefined();
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', async () => {
    await setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = await getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', async () => {
    await setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = await getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('assistants', () => {
  it('creates assistants and exposes normalized config', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-assistant-'),
    );
    try {
      const assistant = await createAssistant({
        id: 'demo-assistant',
        name: '演示助手',
        description: '演示助手描述',
        config: {
          skillIds: ['demo-skill', 'demo-skill'],
          mcpServerIds: ['jira'],
          rules: {
            systemPrompt: '只处理指定任务。',
            extraInstructions: '输出结构化状态。',
          },
          providerId: 'provider-1',
          model: 'gpt-5.4-mini',
          persona: {
            role: '运维助手',
            style: '简洁专业',
            guidelines: '',
            constraints: '',
          },
        },
      });

      expect(assistant.enabled).toBe(true);
      expect(assistant.config.skillIds).toEqual(['demo-skill']);
      expect(assistant.config.rules.mode).toBe('append');
      expect(assistant.config.persona).toEqual({
        role: '运维助手',
        style: '简洁专业',
        guidelines: '',
        constraints: '',
      });
      expect((await getAssistant('demo-assistant'))?.name).toBe('演示助手');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces assistant metadata on conversation summaries', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-assistant-'),
    );
    try {
      await createProvider({
        id: 'provider-ops',
        alias: 'Ops GPT',
        type: 'codex',
        api_key: 'key-ops',
        base_url: 'https://example.com',
        model: 'gpt-5.4',
        extra_config: null,
        is_default: 1,
      });
      await createAssistant({
        id: 'demo-assistant',
        name: '演示助手',
        config: {
          skillIds: ['demo-skill'],
          mcpServerIds: ['jira'],
          rules: {},
          providerId: 'provider-ops',
          model: 'gpt-5.4-mini',
          persona: { role: '', style: '', guidelines: '', constraints: '' },
        },
      });
      await setRegisteredGroup('web:demo-1', {
        name: 'Demo Chat',
        folder: 'demo_chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        assistantId: 'demo-assistant',
      });
      await storeChatMetadata(
        'web:demo-1',
        '2024-01-01T00:00:00.000Z',
        'Web User',
        'web',
        false,
      );

      const summary = await getConversationSummaryByJid('web:demo-1');
      expect(summary?.assistant_id).toBe('demo-assistant');
      expect(summary?.assistant_name).toBe('演示助手');
      expect(summary?.assistant_provider_alias).toBe('Ops GPT');
      expect(summary?.assistant_model).toBe('gpt-5.4-mini');
      expect((await getConversationList())[0]?.assistant_id).toBe('demo-assistant');
      expect(
        (await getConversationListByAssistantId('demo-assistant')).map(
          (conversation) => conversation.jid,
        ),
      ).toEqual(['web:demo-1']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses postgres-safe JSON extraction and ordering in conversation list queries', async () => {
    let capturedSql = '';
    const fakePgEngine: DbEngine = {
      dialect: 'postgres',
      async queryAll<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        capturedSql = sql;
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run() {
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(): Promise<void> {},
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakePgEngine);
      },
      async close(): Promise<void> {},
    };

    setGlobalEngine(fakePgEngine);
    await getConversationList();

    expect(capturedSql).toContain(`a.config_json::jsonb->>'providerId'`);
    expect(capturedSql).toContain(`a.config_json::jsonb->>'model'`);
    expect(capturedSql).not.toContain('json_extract(');
    expect(capturedSql).not.toContain('m.rowid');
    expect(capturedSql).toContain('ORDER BY m.timestamp DESC, m.id DESC');
  });

  it('uses postgres-safe chat metadata upserts', async () => {
    const capturedSql: string[] = [];
    const fakePgEngine: DbEngine = {
      dialect: 'postgres',
      async queryAll<T = Record<string, unknown>>(): Promise<T[]> {
        return [];
      },
      async queryOne<T = Record<string, unknown>>(): Promise<T | undefined> {
        return undefined;
      },
      async run(sql: string) {
        capturedSql.push(sql);
        return { changes: 0, lastInsertRowid: 0 };
      },
      async exec(): Promise<void> {},
      async transaction<T>(fn: (engine: DbEngine) => Promise<T>): Promise<T> {
        return fn(fakePgEngine);
      },
      async close(): Promise<void> {},
    };

    setGlobalEngine(fakePgEngine);
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'Group', 'web', true);
    await storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', undefined, 'web', true);
    await storeChatForUser('user-1', 'group@g.us', '2024-01-01T00:00:02.000Z', 'Group', 'web');

    expect(capturedSql[0]).toContain(
      'last_message_time = GREATEST(chats.last_message_time, excluded.last_message_time)',
    );
    expect(capturedSql[0]).toContain(
      'channel = COALESCE(excluded.channel, chats.channel)',
    );
    expect(capturedSql[0]).toContain(
      'is_group = COALESCE(excluded.is_group, chats.is_group)',
    );
    expect(capturedSql[2]).toContain(
      'name = COALESCE(excluded.name, chats.name)',
    );
    expect(capturedSql[2]).toContain(
      'last_message_time = GREATEST(chats.last_message_time, excluded.last_message_time)',
    );
    expect(capturedSql[2]).toContain(
      'channel = COALESCE(excluded.channel, chats.channel)',
    );
  });

  it('stores assistant MCP bindings and secrets separately from assistant config', async () => {
    await createAssistant({
      id: 'demo-assistant',
      name: '演示助手',
      config: {
        skillIds: [],
        mcpServerIds: ['jira'],
        rules: {},
        providerId: null,
        model: null,
        persona: { role: '', style: '', guidelines: '', constraints: '' },
      },
    });

    const binding = await createAssistantMcpBinding({
      assistantId: 'demo-assistant',
      templateServerId: 'jira',
      alias: 'Jira Private',
      args: ['jira-private.js'],
    });
    await upsertAssistantMcpBindingSecret('demo-assistant', binding.id, {
      API_TOKEN: 'private-token',
    });

    expect(await listAssistantMcpBindings('demo-assistant')).toEqual([
      expect.objectContaining({
        id: binding.id,
        template_server_id: 'jira',
        alias: 'Jira Private',
      }),
    ]);
    expect(await getAssistantMcpBindingSecret('demo-assistant', binding.id)).toEqual(
      expect.objectContaining({
        binding_id: binding.id,
      }),
    );
    expect((await getAssistant('demo-assistant'))?.config.mcpServerIds).toEqual(['jira']);
  });
});

describe('provider defaults', () => {
  it('keeps only the newest default when creating providers', async () => {
    await createProvider({
      id: 'provider-1',
      alias: 'Provider 1',
      type: 'openai',
      api_key: 'key-1',
      base_url: 'https://example.com/1',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 1,
    });
    await createProvider({
      id: 'provider-2',
      alias: 'Provider 2',
      type: 'openai',
      api_key: 'key-2',
      base_url: 'https://example.com/2',
      model: 'gpt-4.1-mini',
      extra_config: null,
      is_default: 1,
    });

    const defaults = (await getAllProviders()).filter(
      (provider) => provider.is_default,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe('provider-2');
  });

  it('switches the default provider atomically on update', async () => {
    await createProvider({
      id: 'provider-a',
      alias: 'Provider A',
      type: 'openai',
      api_key: 'key-a',
      base_url: 'https://example.com/a',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 1,
    });
    await createProvider({
      id: 'provider-b',
      alias: 'Provider B',
      type: 'openai',
      api_key: 'key-b',
      base_url: 'https://example.com/b',
      model: 'gpt-4.1-mini',
      extra_config: null,
      is_default: 0,
    });

    await updateProvider('provider-b', { is_default: 1 });

    const providers = await getAllProviders();
    expect(
      providers.find((provider) => provider.id === 'provider-a')?.is_default,
    ).toBe(0);
    expect(
      providers.find((provider) => provider.id === 'provider-b')?.is_default,
    ).toBe(1);
    expect(providers.filter((provider) => provider.is_default)).toHaveLength(1);
  });
});

describe('provider visibility for private system providers', () => {
  it('system user can see private system providers', async () => {
    await createProvider({
      id: 'priv-sys',
      alias: 'Private System',
      type: 'openai',
      api_key: 'key-priv',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      visibility: 'private',
      user_id: '__system__',
    });

    const visible = await isProviderVisibleToUser('priv-sys', '__system__');
    expect(visible).toBe(true);

    const list = await getVisibleProvidersForUser('__system__');
    expect(list.some((p) => p.id === 'priv-sys')).toBe(true);
  });

  it('creator cannot see private system providers without an explicit restricted grant', async () => {
    await createProvider({
      id: 'priv-admin',
      alias: 'Private For Creator',
      type: 'openai',
      api_key: 'key-admin',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      visibility: 'private',
      user_id: '__system__',
      created_by: 'user-creator',
    });

    const visible = await isProviderVisibleToUser('priv-admin', 'user-creator');
    expect(visible).toBe(false);

    const list = await getVisibleProvidersForUser('user-creator');
    expect(list.some((p) => p.id === 'priv-admin')).toBe(false);
  });

  it('allows restricted system providers to be granted to specific users', async () => {
    await createProvider({
      id: 'restricted-user-provider',
      alias: 'Restricted User Provider',
      type: 'openai',
      api_key: 'key-user-grant',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      visibility: 'restricted',
      user_id: '__system__',
      created_by: 'admin-user',
    });

    expect(await isProviderVisibleToUser('restricted-user-provider', 'user-granted')).toBe(false);

    await grantProviderUserAccess('restricted-user-provider', 'user-granted', 'admin-user');

    expect(await isProviderVisibleToUser('restricted-user-provider', 'user-granted')).toBe(true);
    const list = await getVisibleProvidersForUser('user-granted');
    expect(list.some((p) => p.id === 'restricted-user-provider')).toBe(true);
    await expect(getProviderUserAccessList('restricted-user-provider')).resolves.toEqual([
      expect.objectContaining({ user_id: 'user-granted', granted_by: 'admin-user' }),
    ]);
  });

  it('allows personal providers to be shared and used as the recipient default', async () => {
    const now = new Date().toISOString();
    await dbModule.dba.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run('user-recipient', 'recipient', 'Recipient', 'hash', now, now);

    await createProvider({
      id: 'owner-default',
      alias: 'Owner Default',
      type: 'openai',
      api_key: 'key-owner-default',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 1,
      user_id: 'user-owner',
      visibility: 'private',
    });
    await createProvider({
      id: 'owner-shared',
      alias: 'Owner Shared',
      type: 'openai',
      api_key: 'key-owner-shared',
      base_url: 'https://example.com',
      model: 'gpt-4.1-mini',
      extra_config: null,
      is_default: 0,
      user_id: 'user-owner',
      visibility: 'private',
    });

    expect(await isProviderVisibleToUser('owner-shared', 'user-recipient')).toBe(false);

    await shareProviderWithUser('owner-shared', 'user-recipient', 'user-owner');
    expect(await isProviderVisibleToUser('owner-shared', 'user-recipient')).toBe(true);
    await expect(getProviderShareList('owner-shared', 'user-owner')).resolves.toEqual([
      expect.objectContaining({ user_id: 'user-recipient', granted_by: 'user-owner' }),
    ]);

    await setUserDefaultProviderPreference('user-recipient', 'owner-shared', 'user-recipient');
    expect((await getDefaultProviderForUser('user-recipient'))?.id).toBe('owner-shared');
  });

  it('revoking a personal provider share also clears recipient default preference', async () => {
    const now = new Date().toISOString();
    await dbModule.dba.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run('user-revoked', 'revoked', 'Revoked', 'hash', now, now);
    await createProvider({
      id: 'shared-revoked',
      alias: 'Shared Revoked',
      type: 'openai',
      api_key: 'key-shared-revoked',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      user_id: 'user-owner',
      visibility: 'private',
    });

    await shareProviderWithUser('shared-revoked', 'user-revoked', 'user-owner');
    await setUserDefaultProviderPreference('user-revoked', 'shared-revoked', 'user-revoked');

    await revokeProviderShare('shared-revoked', 'user-revoked', 'user-owner');

    expect(await isProviderVisibleToUser('shared-revoked', 'user-revoked')).toBe(false);
    expect(await getDefaultProviderForUser('user-revoked')).toBeUndefined();
  });

  it('non-creator cannot see private system providers', async () => {
    await createProvider({
      id: 'priv-noaccess',
      alias: 'Private No Access',
      type: 'openai',
      api_key: 'key-noaccess',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 0,
      visibility: 'private',
      user_id: '__system__',
      created_by: 'user-someone-else',
    });

    const visible = await isProviderVisibleToUser('priv-noaccess', 'user-regular');
    expect(visible).toBe(false);

    const list = await getVisibleProvidersForUser('user-regular');
    expect(list.some((p) => p.id === 'priv-noaccess')).toBe(false);
  });

  it('getDefaultProviderForUser skips invisible private system default', async () => {
    const { getDefaultProviderForUser } = await import('./db.js');

    await createProvider({
      id: 'priv-default',
      alias: 'Private Default',
      type: 'openai',
      api_key: 'key-default',
      base_url: 'https://example.com',
      model: 'gpt-4.1',
      extra_config: null,
      is_default: 1,
      visibility: 'private',
      user_id: '__system__',
      created_by: 'user-original-creator',
    });

    const result = await getDefaultProviderForUser('user-no-perm');
    expect(result).toBeUndefined();
  });
});

describe('repo review persistence helpers', () => {
  it('lists due auto-sync repositories with SQL filters', async () => {
    const base = {
      name: 'Auto Sync Repo',
      remote_provider: 'github' as const,
      remote_repo_slug: 'org/repo',
      default_target_branch: 'main',
      review_chat_jid: 'web:auto-sync',
      enabled: true,
    };

    await saveReviewRepository({
      ...base,
      id: 'repo-auto-due-late',
      next_auto_sync_at: '2026-05-03T00:00:02.000Z',
      auto_sync_enabled: true,
    });
    await saveReviewRepository({
      ...base,
      id: 'repo-auto-due-early',
      next_auto_sync_at: '2026-05-03T00:00:01.000Z',
      auto_sync_enabled: true,
    });
    await saveReviewRepository({
      ...base,
      id: 'repo-auto-future',
      next_auto_sync_at: '2026-05-03T00:00:04.000Z',
      auto_sync_enabled: true,
    });
    await saveReviewRepository({
      ...base,
      id: 'repo-auto-disabled-sync',
      next_auto_sync_at: '2026-05-03T00:00:01.000Z',
      auto_sync_enabled: false,
    });
    await saveReviewRepository({
      ...base,
      id: 'repo-auto-disabled-repo',
      next_auto_sync_at: '2026-05-03T00:00:01.000Z',
      auto_sync_enabled: true,
      enabled: false,
    });
    await saveReviewRepository({
      ...base,
      id: 'repo-auto-local-only',
      remote_provider: null,
      next_auto_sync_at: '2026-05-03T00:00:01.000Z',
      auto_sync_enabled: true,
    });

    const due = await listDueReviewRepositoriesForAutoSync(
      '2026-05-03T00:00:03.000Z',
    );
    expect(due.map((repo) => repo.id)).toEqual([
      'repo-auto-due-early',
      'repo-auto-due-late',
    ]);
  });

  it('stores explicit review conversation bindings by repository and chat', async () => {
    await saveReviewRepository({
      id: 'repo-binding',
      name: 'Repo Binding',
      review_chat_jid: 'web:repo-binding',
      enabled: true,
    });

    const binding = await saveReviewConversationBinding({
      repository_id: 'repo-binding',
      chat_jid: 'web:repo-binding',
    });

    expect(binding.repository_id).toBe('repo-binding');
    expect(
      (await getReviewConversationBindingByChatJid('web:repo-binding'))?.repository_id,
    ).toBe('repo-binding');
  });

  it('tracks review run idempotency keys and branch states', async () => {
    await saveReviewRepository({
      id: 'repo-review',
      name: 'Repo Review',
      enabled: true,
    });

    await createReviewRun({
      id: 'run-review-1',
      repository_id: 'repo-review',
      source: 'github',
      stage: 'push',
      status: 'queued',
      idempotency_key: 'repo-review:push:main:head-1',
      branch: 'main',
      head_sha: 'head-1',
      base_sha: 'base-1',
      baseline_source: 'event-base-sha',
      result_state: 'queued',
    });
    await updateReviewRun('run-review-1', {
      status: 'completed',
      result_state: 'passed',
      overall: 'pass',
    });
    await upsertReviewBranchState({
      repository_id: 'repo-review',
      stage: 'push',
      branch: 'main',
      last_run_id: 'run-review-1',
      head_sha: 'head-1',
      baseline_sha: 'base-1',
      baseline_source: 'event-base-sha',
      result_state: 'passed',
      status: 'completed',
      actor: 'alice',
      summary: 'looks good',
    });

    expect(
      (await getReviewRunByIdempotencyKey({
        repositoryId: 'repo-review',
        idempotencyKey: 'repo-review:push:main:head-1',
      }))?.id,
    ).toBe('run-review-1');
    expect(
      await getReviewBranchState({
        repositoryId: 'repo-review',
        stage: 'push',
        branch: 'main',
      }),
    ).toMatchObject({
      last_run_id: 'run-review-1',
      head_sha: 'head-1',
      baseline_sha: 'base-1',
      result_state: 'passed',
      status: 'completed',
    });
  });

  it('persists repo review cloud-doc identity and delivery state', async () => {
    await saveReviewRepository({
      id: 'repo-review-doc',
      name: 'Repo Review Doc',
      enabled: true,
    });

    await createReviewRun({
      id: 'run-review-doc-1',
      repository_id: 'repo-review-doc',
      source: 'github',
      stage: 'push',
      status: 'queued',
      idempotency_key: 'repo-review:push:main:head-doc-1',
      branch: 'main',
      head_sha: 'head-doc-1',
      base_sha: 'base-doc-1',
      baseline_source: 'event-base-sha',
      result_state: 'queued',
    });

    await updateReviewRun('run-review-doc-1', {
      cloud_doc_token: 'doccn123',
      cloud_doc_url: 'https://tenant.feishu.cn/docx/doccn123',
      cloud_doc_title: 'feature/login 2026-03-27 10:00',
      cloud_doc_status: 'success',
      cloud_doc_last_error: 'authorization partially failed',
    });

    expect(await getReviewRunById('run-review-doc-1')).toMatchObject({
      cloud_doc_token: 'doccn123',
      cloud_doc_url: 'https://tenant.feishu.cn/docx/doccn123',
      cloud_doc_title: 'feature/login 2026-03-27 10:00',
      cloud_doc_status: 'success',
      cloud_doc_last_error: 'authorization partially failed',
    });
    expect(
      await getReviewRunByIdempotencyKey({
        repositoryId: 'repo-review-doc',
        idempotencyKey: 'repo-review:push:main:head-doc-1',
      }),
    ).toMatchObject({
      cloud_doc_token: 'doccn123',
      cloud_doc_url: 'https://tenant.feishu.cn/docx/doccn123',
      cloud_doc_status: 'success',
    });
  });
});
