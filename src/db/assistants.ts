import crypto from 'crypto';
import {
  type AssistantConfig,
  createDefaultAssistantConfig,
  normalizeAssistantConfig,
  serializeAssistantConfig,
} from '../assistant/assistant-config.js';
import {
  type AssistantMcpBindingRecord,
  type AssistantMcpBindingSecretRecord,
  createAssistantMcpBindingId,
} from '../assistant/assistant-mcp.js';
import { ASSISTANT_NAME, DATA_DIR, STORE_DIR, invalidateStartupConfigCache } from '../config.js';
import { invalidateVectorRowCache } from '../embedding/vector-store.js';
import {
  type DbEngine,
} from '../database/engine.js';
import { isValidGroupFolder } from '../group-folder.js';
import { createModuleLogger } from '../logger.js';
import { supportsProviderCapability } from '../provider/provider-registry.js';
import { getCurrentUserId, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { buildIdentityMemoryDocumentRecord } from '../memory/identity-documents.js';
import { buildDurableCandidateSummaryLines } from '../memory/promotion.js';
import {
  deleteMemorySearchIndexDocuments,
  initializeMemorySearchIndex,
  searchMemorySearchIndex,
  upsertMemorySearchIndexDocuments,
} from '../memory/search-index.js';
import {
  type ConversationIdentityBindingRecord,
  type ContextCompactionRecord,
  type ContextEntryRecord,
  type IdentityAliasRecord,
  type MemoryCompactionLatestSnapshot,
  type MemoryCompactionStatsSnapshot,
  type MemoryCompactionWorkerSnapshot,
  type MemoryDocumentRecord,
  type MemoryDocumentSyncStateRecord,
  type MemoryIdentityStatsSnapshot,
  type MemoryLedgerStatsSnapshot,
  type MemoryPromotionCandidate,
  type MemoryPromotionStatsSnapshot,
  type MemoryPromptStatsSnapshot,
  type MemorySearchGroupQualitySnapshot,
  type MemorySearchSourceQualitySnapshot,
  type MemorySearchScopeQualitySnapshot,
  type MemorySearchStatsSnapshot,
  type NewMessage,
  type PersonProfileRecord,
  type RegisteredGroup,
  type ScheduledTask,
  type TaskRunLog,
  type UserSoulRecord,
  type UserMemoryRecord,
  type UserMemoryObservationRecord,
  type PersonaInsightRecord,
  type MemoryConsolidationLogRecord,
  type MemoryExtractionLogRecord,
  type MemoryEventRecord,
  type MemorySkillRecord,
} from '../types.js';
// evaluateAny removed: provider visibility no longer relies on RBAC permission bypass
import { adaptSql } from './sql-adapters.js';
import { dba, eng, getSqliteRawDatabase, isSqlite } from './engine-access.js';
import { createPlaceholders, estimateTokenCount, normalizeMemoryText } from './sql-utils.js';

const logger = createModuleLogger('database');

export interface AssistantRecord {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  config_json: string;
  user_id: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  config: AssistantConfig;
  user_id: string;
  visibility: 'private' | 'shared';
  created_at: string;
  updated_at: string;
}

export interface AssistantMcpBindingSecretSummary {
  bindingId: string;
  keyCount: number;
  updatedAt: string | null;
}

function normalizeAssistantSummary(record: AssistantRecord): AssistantSummary {
  let config = createDefaultAssistantConfig();
  try {
    config = normalizeAssistantConfig(
      record.config_json ? JSON.parse(record.config_json) : {},
    );
  } catch (err) {
    logger.warn(
      { err, assistantId: record.id },
      'Failed to parse assistant config',
    );
  }
  const vis = record.visibility === 'shared' ? 'shared' : 'private';
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    enabled: record.enabled === 1,
    config,
    user_id: record.user_id || SYSTEM_USER_ID,
    visibility: vis,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

export async function listAssistants(opts?: { userId?: string }): Promise<AssistantSummary[]> {
  const userId = opts?.userId;
  if (userId && userId !== SYSTEM_USER_ID) {
    const rows = await dba
      .prepare(
        `
          SELECT id, name, description, enabled, config_json, user_id, visibility, created_at, updated_at
          FROM assistants
          WHERE deleted_at IS NULL
            AND (user_id = ? OR visibility = 'shared')
          ORDER BY enabled DESC, updated_at DESC, name ASC
        `,
      )
      .all(userId) as AssistantRecord[];
    return rows.map(normalizeAssistantSummary);
  }
  const rows = await dba
    .prepare(
      `
        SELECT id, name, description, enabled, config_json, user_id, visibility, created_at, updated_at
        FROM assistants
        WHERE deleted_at IS NULL
        ORDER BY enabled DESC, updated_at DESC, name ASC
      `,
    )
    .all() as AssistantRecord[];
  return rows.map(normalizeAssistantSummary);
}

export async function getAssistant(id: string): Promise<AssistantSummary | undefined> {
  const row = await dba
    .prepare(
      `
        SELECT id, name, description, enabled, config_json, user_id, visibility, created_at, updated_at
        FROM assistants
        WHERE id = ? AND deleted_at IS NULL
        LIMIT 1
      `,
    )
    .get(id) as AssistantRecord | undefined;
  return row ? normalizeAssistantSummary(row) : undefined;
}

export async function createAssistant(input: {
  id: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  config?: AssistantConfig;
  userId?: string;
  visibility?: 'private' | 'shared';
  created_by?: string;
  updated_by?: string;
}): Promise<AssistantSummary> {
  const now = new Date().toISOString();
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) {
    throw new Error('assistant id is required');
  }
  if (!name) {
    throw new Error('assistant name is required');
  }

  const userId = input.userId || getCurrentUserId();
  const visibility = input.visibility || 'private';
  const createdBy = input.created_by ?? getCurrentUserId();
  const updatedBy = input.updated_by ?? getCurrentUserId();

  await dba.prepare(
    `
      INSERT INTO assistants (
        id,
        name,
        description,
        enabled,
        config_json,
        user_id,
        visibility,
        created_by,
        updated_by,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    name,
    input.description?.trim() || null,
    input.enabled === false ? 0 : 1,
    serializeAssistantConfig(input.config || createDefaultAssistantConfig()),
    userId,
    visibility,
    createdBy,
    updatedBy,
    now,
    now,
  );

  return (await getAssistant(id))!;
}

export async function updateAssistant(
  id: string,
  updates: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    config?: AssistantConfig;
    visibility?: 'private' | 'shared';
    updated_by?: string;
  },
): Promise<AssistantSummary | undefined> {
  const existing = await getAssistant(id);
  if (!existing) return undefined;

  const nextName =
    updates.name !== undefined ? updates.name.trim() : existing.name;
  if (!nextName) {
    throw new Error('assistant name is required');
  }

  const nextDescription =
    updates.description !== undefined
      ? updates.description?.trim() || null
      : existing.description;
  const nextEnabled =
    updates.enabled !== undefined ? updates.enabled : existing.enabled;
  const nextConfig =
    updates.config !== undefined ? updates.config : existing.config;
  const nextVisibility =
    updates.visibility !== undefined ? updates.visibility : existing.visibility;
  const updatedBy = updates.updated_by ?? getCurrentUserId();

  await dba.prepare(
    `
      UPDATE assistants
      SET name = ?,
          description = ?,
          enabled = ?,
          config_json = ?,
          visibility = ?,
          updated_by = ?,
          updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `,
  ).run(
    nextName,
    nextDescription,
    nextEnabled ? 1 : 0,
    serializeAssistantConfig(nextConfig),
    nextVisibility,
    updatedBy,
    new Date().toISOString(),
    id,
  );

  return await getAssistant(id);
}

export async function deleteAssistant(id: string): Promise<boolean> {
  const assistantId = id.trim();
  if (!assistantId) return false;
  if (!await getAssistant(assistantId)) return false;

  const conversationUsage =
    (
      await dba
        .prepare(
          `
            SELECT COUNT(*) as total
            FROM registered_groups
            WHERE assistant_id = ?
          `,
        )
        .get(assistantId) as { total?: number } | undefined
    )?.total || 0;
  if (conversationUsage > 0) {
    throw new Error(
      `该助手仍被${conversationUsage} 个会话引用，请先解除绑定后再删除`,
    );
  }

  const now = new Date().toISOString();
  const result = await dba
    .prepare(
      `UPDATE assistants SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, assistantId);
  return result.changes > 0;
}

function normalizeAssistantMcpBindingRecord(
  record: AssistantMcpBindingRecord,
): AssistantMcpBindingRecord {
  return {
    ...record,
    alias: record.alias?.trim() || null,
    args_json: record.args_json?.trim() || null,
  };
}

function normalizeAssistantMcpSecretRecord(
  record: AssistantMcpBindingSecretRecord,
): AssistantMcpBindingSecretRecord {
  return {
    binding_id: record.binding_id,
    env_json: record.env_json?.trim() || '{}',
    updated_at: record.updated_at,
  };
}

export async function listAssistantMcpBindings(
  assistantId: string,
): Promise<AssistantMcpBindingRecord[]> {
  return (
    await dba
      .prepare(
        `
          SELECT
            id,
            assistant_id,
            template_server_id,
            alias,
            enabled,
            args_json,
            created_at,
            updated_at
          FROM assistant_mcp_bindings
          WHERE assistant_id = ?
          ORDER BY updated_at DESC, template_server_id ASC
        `,
      )
      .all(assistantId) as AssistantMcpBindingRecord[]
  ).map(normalizeAssistantMcpBindingRecord);
}

export async function getAssistantMcpBinding(
  assistantId: string,
  bindingId: string,
): Promise<AssistantMcpBindingRecord | undefined> {
  const row = await dba
    .prepare(
      `
        SELECT
          id,
          assistant_id,
          template_server_id,
          alias,
          enabled,
          args_json,
          created_at,
          updated_at
        FROM assistant_mcp_bindings
        WHERE assistant_id = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(assistantId, bindingId) as AssistantMcpBindingRecord | undefined;
  return row ? normalizeAssistantMcpBindingRecord(row) : undefined;
}

export async function createAssistantMcpBinding(input: {
  assistantId: string;
  templateServerId: string;
  alias?: string | null;
  enabled?: boolean;
  args?: string[];
}): Promise<AssistantMcpBindingRecord> {
  const now = new Date().toISOString();
  const assistantId = input.assistantId.trim();
  const templateServerId = input.templateServerId.trim();
  if (!assistantId) {
    throw new Error('assistant id is required');
  }
  if (!templateServerId) {
    throw new Error('template server id is required');
  }
  const id = createAssistantMcpBindingId(assistantId, templateServerId);
  await dba.prepare(
    `
      INSERT INTO assistant_mcp_bindings (
        id,
        assistant_id,
        template_server_id,
        alias,
        enabled,
        args_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    assistantId,
    templateServerId,
    input.alias?.trim() || null,
    input.enabled === false ? 0 : 1,
    Array.isArray(input.args) ? JSON.stringify(input.args) : null,
    now,
    now,
  );
  return (await getAssistantMcpBinding(assistantId, id))!;
}

export async function updateAssistantMcpBinding(
  assistantId: string,
  bindingId: string,
  updates: {
    alias?: string | null;
    enabled?: boolean;
    args?: string[];
  },
): Promise<AssistantMcpBindingRecord | undefined> {
  const existing = await getAssistantMcpBinding(assistantId, bindingId);
  if (!existing) return undefined;
  await dba.prepare(
    `
      UPDATE assistant_mcp_bindings
      SET alias = ?,
          enabled = ?,
          args_json = ?,
          updated_at = ?
      WHERE assistant_id = ? AND id = ?
    `,
  ).run(
    updates.alias !== undefined ? updates.alias?.trim() || null : existing.alias,
    updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled,
    updates.args !== undefined
      ? updates.args.length > 0
        ? JSON.stringify(updates.args)
        : null
      : existing.args_json,
    new Date().toISOString(),
    assistantId,
    bindingId,
  );
  return await getAssistantMcpBinding(assistantId, bindingId);
}

export async function deleteAssistantMcpBinding(
  assistantId: string,
  bindingId: string,
): Promise<boolean> {
  const result = await dba
    .prepare(
      `DELETE FROM assistant_mcp_bindings WHERE assistant_id = ? AND id = ?`,
    )
    .run(assistantId, bindingId);
  return result.changes > 0;
}

export async function listAssistantMcpBindingSecrets(
  assistantId: string,
): Promise<AssistantMcpBindingSecretRecord[]> {
  return (
    await dba
      .prepare(
        `
          SELECT
            s.binding_id,
            s.env_json,
            s.updated_at
          FROM assistant_mcp_binding_secrets s
          INNER JOIN assistant_mcp_bindings b ON b.id = s.binding_id
          WHERE b.assistant_id = ?
        `,
      )
      .all(assistantId) as AssistantMcpBindingSecretRecord[]
  ).map(normalizeAssistantMcpSecretRecord);
}

export async function getAssistantMcpBindingSecret(
  assistantId: string,
  bindingId: string,
): Promise<AssistantMcpBindingSecretRecord | undefined> {
  const row = await dba
    .prepare(
      `
        SELECT
          s.binding_id,
          s.env_json,
          s.updated_at
        FROM assistant_mcp_binding_secrets s
        INNER JOIN assistant_mcp_bindings b ON b.id = s.binding_id
        WHERE b.assistant_id = ? AND b.id = ?
        LIMIT 1
      `,
    )
    .get(assistantId, bindingId) as AssistantMcpBindingSecretRecord | undefined;
  return row ? normalizeAssistantMcpSecretRecord(row) : undefined;
}

export async function upsertAssistantMcpBindingSecret(
  assistantId: string,
  bindingId: string,
  env: Record<string, string>,
): Promise<AssistantMcpBindingSecretRecord> {
  const binding = await getAssistantMcpBinding(assistantId, bindingId);
  if (!binding) {
    throw new Error(`助手 MCP 绑定不存在: ${bindingId}`);
  }
  const nextEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string'),
  );
  const now = new Date().toISOString();
  await dba.prepare(
    `
      INSERT INTO assistant_mcp_binding_secrets (
        binding_id,
        env_json,
        updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        env_json = excluded.env_json,
        updated_at = excluded.updated_at
    `,
  ).run(bindingId, JSON.stringify(nextEnv), now);
  return (await getAssistantMcpBindingSecret(assistantId, bindingId))!;
}

export async function deleteAssistantMcpBindingSecret(
  assistantId: string,
  bindingId: string,
): Promise<boolean> {
  const binding = await getAssistantMcpBinding(assistantId, bindingId);
  if (!binding) {
    return false;
  }
  const result = await dba
    .prepare(`DELETE FROM assistant_mcp_binding_secrets WHERE binding_id = ?`)
    .run(bindingId);
  return result.changes > 0;
}


export interface AiProvider {
  id: string;
  alias: string;
  type: string;
  capability: 'llm' | 'embedding';
  api_key: string | null;
  base_url: string | null;
  model: string | null;
  dimensions: number | null;
  extra_config: string | null;
  is_default: number;
  user_id: string;
  /** 'public' | 'private' | 'restricted' */
  visibility: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function filterProvidersByCapability(
  providers: AiProvider[],
  capability?: 'llm' | 'embedding' | 'all',
): AiProvider[] {
  if (!capability || capability === 'all') return providers;
  return providers.filter((provider) => supportsProviderCapability(provider, capability));
}

export async function getAllProviders(
  capability?: 'llm' | 'embedding' | 'all',
): Promise<AiProvider[]> {
  const rows = await dba
    .prepare(
      `SELECT * FROM ai_providers WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at ASC`,
    )
    .all() as AiProvider[];
  return filterProvidersByCapability(rows, capability);
}

export async function getAllSystemProviders(
  capability?: 'llm' | 'embedding' | 'all',
): Promise<AiProvider[]> {
  const rows = await dba
    .prepare(
      `SELECT * FROM ai_providers WHERE user_id = '__system__' AND deleted_at IS NULL ORDER BY is_default DESC, created_at ASC`,
    )
    .all() as AiProvider[];
  return filterProvidersByCapability(rows, capability);
}

export async function getProvider(id: string): Promise<AiProvider | undefined> {
  return await dba.prepare('SELECT * FROM ai_providers WHERE id = ? AND deleted_at IS NULL').get(id) as
    | AiProvider
    | undefined;
}

export async function getDefaultProvider(): Promise<AiProvider | undefined> {
  return getDefaultProviderForUser(SYSTEM_USER_ID);
}

export async function getUserDefaultProviderPreference(
  userId: string,
): Promise<{ user_id: string; provider_id: string; updated_by: string; updated_at: string } | undefined> {
  return await dba
    .prepare('SELECT user_id, provider_id, updated_by, updated_at FROM user_default_providers WHERE user_id = ? LIMIT 1')
    .get(userId) as { user_id: string; provider_id: string; updated_by: string; updated_at: string } | undefined;
}

export async function setUserDefaultProviderPreference(
  userId: string,
  providerId: string | null,
  updatedBy?: string,
): Promise<void> {
  if (!providerId?.trim()) {
    await dba.prepare('DELETE FROM user_default_providers WHERE user_id = ?').run(userId);
    return;
  }
  if (!await isProviderVisibleToUser(providerId, userId, 'llm')) {
    throw new Error('Provider is not visible to user');
  }
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO user_default_providers (user_id, provider_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?)`,
      ),
    )
    .run(userId, providerId, updatedBy || userId, now);
}

export async function getUserPreferredDefaultProvider(userId: string): Promise<AiProvider | undefined> {
  const preference = await getUserDefaultProviderPreference(userId);
  if (!preference) return undefined;
  const provider = await getProvider(preference.provider_id);
  if (provider && await isProviderVisibleToUser(provider.id, userId, 'llm')) {
    return provider;
  }
  await dba.prepare('DELETE FROM user_default_providers WHERE user_id = ?').run(userId);
  return undefined;
}

export async function getLegacyDefaultProvider(): Promise<AiProvider | undefined> {
  const provider = await dba
    .prepare("SELECT * FROM ai_providers WHERE is_default = 1 AND deleted_at IS NULL AND COALESCE(capability, 'llm') = 'llm' LIMIT 1")
    .get() as AiProvider | undefined;
  return provider && supportsProviderCapability(provider, 'llm') ? provider : undefined;
}

export async function getDefaultProviderForUser(userId: string): Promise<AiProvider | undefined> {
  const preferred = await getUserPreferredDefaultProvider(userId);
  if (preferred) return preferred;

  const userProvider = await dba
    .prepare("SELECT * FROM ai_providers WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL AND COALESCE(capability, 'llm') = 'llm' LIMIT 1")
    .get(userId) as AiProvider | undefined;
  if (userProvider && supportsProviderCapability(userProvider, 'llm')) return userProvider;

  const firstOwnProvider = await dba
    .prepare("SELECT * FROM ai_providers WHERE user_id = ? AND deleted_at IS NULL AND COALESCE(capability, 'llm') = 'llm' ORDER BY updated_at DESC LIMIT 1")
    .get(userId) as AiProvider | undefined;
  if (firstOwnProvider && supportsProviderCapability(firstOwnProvider, 'llm')) return firstOwnProvider;

  const systemDefault = await dba
    .prepare("SELECT * FROM ai_providers WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL AND COALESCE(capability, 'llm') = 'llm' LIMIT 1")
    .get(SYSTEM_USER_ID) as AiProvider | undefined;
  if (systemDefault && supportsProviderCapability(systemDefault, 'llm') && await isProviderVisibleToUser(systemDefault.id, userId, 'llm')) {
    return systemDefault;
  }

  const globalDefault = await getLegacyDefaultProvider();
  if (globalDefault && await isProviderVisibleToUser(globalDefault.id, userId, 'llm')) {
    return globalDefault;
  }

  const anyVisible = await getVisibleProvidersForUser(userId, 'llm');
  if (anyVisible.length > 0) return anyVisible[0];

  return undefined;
}

export async function getProvidersForUser(
  userId: string,
  capability?: 'llm' | 'embedding' | 'all',
): Promise<AiProvider[]> {
  const rows = await dba
    .prepare(`SELECT * FROM ai_providers WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC`)
    .all(userId) as AiProvider[];
  return filterProvidersByCapability(rows, capability);
}

export async function getVisibleProvidersForUser(
  userId: string,
  capability?: 'llm' | 'embedding' | 'all',
): Promise<AiProvider[]> {
  const rows = await dba
    .prepare(
      `SELECT * FROM ai_providers WHERE deleted_at IS NULL AND (
        user_id = ?
        OR (user_id != ? AND user_id != '__system__'
            AND EXISTS (
              SELECT 1 FROM provider_user_shares pus
              WHERE pus.provider_id = ai_providers.id AND pus.user_id = ?
            ))
        OR (user_id = '__system__' AND visibility = 'public')
        OR (user_id = '__system__' AND visibility = 'restricted' AND created_by = ?)
        OR (user_id = '__system__' AND visibility = 'restricted'
            AND EXISTS (
              SELECT 1 FROM provider_user_access pua
              WHERE pua.provider_id = ai_providers.id AND pua.user_id = ?
            ))
        OR (user_id = '__system__' AND visibility = 'restricted'
            AND EXISTS (
              SELECT 1 FROM provider_role_access pra
              JOIN user_roles ur ON pra.role_id = ur.role_id
              WHERE pra.provider_id = ai_providers.id AND ur.user_id = ?
              AND pra.deleted_at IS NULL AND ur.deleted_at IS NULL
            ))
      )
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1 FROM user_default_providers udp
            WHERE udp.user_id = ? AND udp.provider_id = ai_providers.id
          ) THEN 0
          WHEN user_id = ? AND is_default = 1 THEN 1
          WHEN user_id = ? THEN 2
          WHEN user_id = '__system__' AND is_default = 1 THEN 3
          WHEN user_id != ? AND user_id != '__system__' THEN 4
          ELSE 5
        END,
        updated_at DESC`,
    )
    .all(userId, userId, userId, userId, userId, userId, userId, userId, userId, userId) as AiProvider[];
  return filterProvidersByCapability(rows, capability);
}

export async function isProviderVisibleToUser(
  providerId: string,
  userId: string,
  capability?: 'llm' | 'embedding' | 'all',
): Promise<boolean> {
  const row = await dba
    .prepare(
      `SELECT 1 AS ok FROM ai_providers WHERE id = ? AND deleted_at IS NULL AND (
        user_id = ?
        OR (user_id != ? AND user_id != '__system__'
            AND EXISTS (
              SELECT 1 FROM provider_user_shares pus
              WHERE pus.provider_id = ai_providers.id AND pus.user_id = ?
            ))
        OR (user_id = '__system__' AND visibility = 'public')
        OR (user_id = '__system__' AND visibility = 'restricted' AND created_by = ?)
        OR (user_id = '__system__' AND visibility = 'restricted'
            AND EXISTS (
              SELECT 1 FROM provider_user_access pua
              WHERE pua.provider_id = ai_providers.id AND pua.user_id = ?
            ))
        OR (user_id = '__system__' AND visibility = 'restricted'
            AND EXISTS (
              SELECT 1 FROM provider_role_access pra
              JOIN user_roles ur ON pra.role_id = ur.role_id
              WHERE pra.provider_id = ai_providers.id AND ur.user_id = ?
              AND pra.deleted_at IS NULL AND ur.deleted_at IS NULL
            ))
      ) LIMIT 1`,
    )
    .get(providerId, userId, userId, userId, userId, userId, userId) as { ok: number } | undefined;
  if (!row) return false;
  if (!capability || capability === 'all') return true;
  const provider = await getProvider(providerId);
  return !!provider && supportsProviderCapability(provider, capability);
}

export async function createProvider(
  p: Omit<AiProvider, 'capability' | 'dimensions' | 'created_at' | 'updated_at' | 'visibility' | 'user_id' | 'created_by' | 'updated_by' | 'deleted_at'> & {
    capability?: AiProvider['capability'];
    dimensions?: number | null;
    visibility?: string;
    user_id?: string;
    created_by?: string;
    updated_by?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const userId = p.user_id || getCurrentUserId();
  const visibility = p.visibility ?? (userId === SYSTEM_USER_ID ? 'public' : 'private');
  const createdBy = p.created_by || userId;
  const updatedBy = p.updated_by || createdBy;
  await dba.transaction(async () => {
    if (p.is_default) {
      await dba.prepare(
        "UPDATE ai_providers SET is_default = 0 WHERE is_default = 1 AND user_id = ? AND deleted_at IS NULL AND COALESCE(capability, 'llm') = 'llm'",
      ).run(userId);
    }
    await dba.prepare(
      `INSERT INTO ai_providers (id, alias, type, capability, api_key, base_url, model, dimensions, extra_config, is_default, user_id, visibility, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.id,
      p.alias,
      p.type,
      p.capability ?? 'llm',
      p.api_key,
      p.base_url,
      p.model,
      p.dimensions ?? null,
      p.extra_config,
      p.is_default,
      userId,
      visibility,
      createdBy,
      updatedBy,
      now,
      now,
    );
  })();
}

export async function updateProvider(
  id: string,
  updates: Partial<
    Pick<
      AiProvider,
      | 'alias'
      | 'type'
      | 'capability'
      | 'api_key'
      | 'base_url'
      | 'model'
      | 'dimensions'
      | 'extra_config'
      | 'is_default'
      | 'visibility'
    >
  > & { updated_by?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const fields: string[] = ['updated_at = ?', 'updated_by = ?'];
  const values: unknown[] = [now, updates.updated_by || getCurrentUserId()];
  const shouldBecomeDefault = updates.is_default === 1;
  for (const [key, val] of Object.entries(updates)) {
    if (key === 'updated_by' || val === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(val);
  }
  values.push(id);
  await dba.transaction(async () => {
    const existing = await dba
      .prepare('SELECT 1 as exists_row FROM ai_providers WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { exists_row: number } | undefined;
    if (!existing) {
      return;
    }
    if (shouldBecomeDefault) {
      const current = await dba
        .prepare("SELECT user_id, COALESCE(capability, 'llm') AS capability FROM ai_providers WHERE id = ?")
        .get(id) as { user_id: string; capability: 'llm' | 'embedding' } | undefined;
      const scope = current?.user_id || SYSTEM_USER_ID;
      if ((current?.capability || 'llm') === 'llm') {
        await dba.prepare(
          "UPDATE ai_providers SET is_default = 0 WHERE is_default = 1 AND id != ? AND user_id = ? AND COALESCE(capability, 'llm') = 'llm'",
        ).run(id, scope);
      }
    }
    await dba.prepare(`UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`).run(
      ...values,
    );
  })();
}

export async function deleteProvider(id: string, updatedBy?: string): Promise<void> {
  const now = new Date().toISOString();
  const who = updatedBy || getCurrentUserId();
  await dba.transaction(async () => {
    await dba.prepare(
      'UPDATE provider_role_access SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE provider_id = ? AND deleted_at IS NULL',
    ).run(now, who, now, id);
    await dba.prepare('DELETE FROM provider_user_access WHERE provider_id = ?').run(id);
    await dba.prepare('DELETE FROM provider_user_shares WHERE provider_id = ?').run(id);
    await dba.prepare('DELETE FROM user_default_providers WHERE provider_id = ?').run(id);
    await dba.prepare(
      'UPDATE ai_providers SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    ).run(now, who, now, id);
  })();
}


// ── Provider role-based access CRUD ────────────────────────────

export async function grantProviderUserAccess(
  providerId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO provider_user_access (provider_id, user_id, granted_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ),
    )
    .run(providerId, userId, grantedBy, now);
}

export async function revokeProviderUserAccess(
  providerId: string,
  userId: string,
): Promise<void> {
  await dba.transaction(async () => {
    await dba
      .prepare('DELETE FROM provider_user_access WHERE provider_id = ? AND user_id = ?')
      .run(providerId, userId);
    await dba
      .prepare('DELETE FROM user_default_providers WHERE provider_id = ? AND user_id = ?')
      .run(providerId, userId);
  })();
}

export async function getProviderUserAccessList(
  providerId: string,
): Promise<Array<{ user_id: string; username: string | null; display_name: string | null; granted_by: string; created_at: string }>> {
  return await dba
    .prepare(
      `SELECT pua.user_id, u.username, u.display_name, pua.granted_by, pua.created_at
       FROM provider_user_access pua
       LEFT JOIN users u ON u.id = pua.user_id
       WHERE pua.provider_id = ?
       ORDER BY pua.created_at DESC`,
    )
    .all(providerId) as Array<{ user_id: string; username: string | null; display_name: string | null; granted_by: string; created_at: string }>;
}

export async function syncProviderUserAccess(
  providerId: string,
  userIds: string[],
  updatedBy: string,
): Promise<void> {
  const current = await getProviderUserAccessList(providerId);
  const currentUserIds = new Set(current.map((r) => r.user_id));
  const targetUserIds = new Set(userIds.map((id) => id.trim()).filter(Boolean));

  for (const userId of targetUserIds) {
    if (!currentUserIds.has(userId)) {
      await grantProviderUserAccess(providerId, userId, updatedBy);
    }
  }
  for (const userId of currentUserIds) {
    if (!targetUserIds.has(userId)) {
      await revokeProviderUserAccess(providerId, userId);
    }
  }
}

export async function shareProviderWithUser(
  providerId: string,
  userId: string,
  grantedBy: string,
): Promise<void> {
  const provider = await getProvider(providerId);
  if (!provider || provider.user_id !== grantedBy || provider.user_id === SYSTEM_USER_ID) {
    throw new Error('Only the owner can share a personal provider');
  }
  const targetId = userId.trim();
  if (!targetId || targetId === provider.user_id) {
    throw new Error('Invalid share target');
  }
  const target = await dba
    .prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .get(targetId) as { id: string } | undefined;
  if (!target) {
    throw new Error('Target user not found');
  }
  const now = new Date().toISOString();
  await dba
    .prepare(
      adaptSql(
        `INSERT OR REPLACE INTO provider_user_shares (provider_id, user_id, granted_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ),
    )
    .run(providerId, targetId, grantedBy, now);
}

export async function revokeProviderShare(
  providerId: string,
  userId: string,
  ownerId: string,
): Promise<void> {
  const provider = await getProvider(providerId);
  if (!provider || provider.user_id !== ownerId || provider.user_id === SYSTEM_USER_ID) {
    throw new Error('Only the owner can revoke a personal provider share');
  }
  await dba.transaction(async () => {
    await dba
      .prepare('DELETE FROM provider_user_shares WHERE provider_id = ? AND user_id = ?')
      .run(providerId, userId);
    await dba
      .prepare('DELETE FROM user_default_providers WHERE provider_id = ? AND user_id = ?')
      .run(providerId, userId);
  })();
}

export async function getProviderShareList(
  providerId: string,
  ownerId: string,
): Promise<Array<{ user_id: string; username: string | null; display_name: string | null; granted_by: string; created_at: string }>> {
  const provider = await getProvider(providerId);
  if (!provider || provider.user_id !== ownerId || provider.user_id === SYSTEM_USER_ID) {
    throw new Error('Only the owner can view personal provider shares');
  }
  return await dba
    .prepare(
      `SELECT pus.user_id, u.username, u.display_name, pus.granted_by, pus.created_at
       FROM provider_user_shares pus
       LEFT JOIN users u ON u.id = pus.user_id
       WHERE pus.provider_id = ?
       ORDER BY pus.created_at DESC`,
    )
    .all(providerId) as Array<{ user_id: string; username: string | null; display_name: string | null; granted_by: string; created_at: string }>;
}

export async function isProviderSharedWithUser(
  providerId: string,
  userId: string,
): Promise<boolean> {
  const row = await dba
    .prepare(
      `SELECT 1 AS ok FROM provider_user_shares
       WHERE provider_id = ? AND user_id = ?
       LIMIT 1`,
    )
    .get(providerId, userId) as { ok: number } | undefined;
  return !!row;
}

export async function grantProviderRoleAccess(
  providerId: string,
  roleId: string,
  grantedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Upsert: if previously soft-deleted, revive it
  const existing = await dba
    .prepare('SELECT deleted_at FROM provider_role_access WHERE provider_id = ? AND role_id = ?')
    .get(providerId, roleId) as { deleted_at: string | null } | undefined;
  if (existing) {
    await dba
      .prepare(
        `UPDATE provider_role_access SET deleted_at = NULL, updated_by = ?, updated_at = ?
         WHERE provider_id = ? AND role_id = ?`,
      )
      .run(grantedBy, now, providerId, roleId);
  } else {
    await dba
      .prepare(
        adaptSql(
          `INSERT OR IGNORE INTO provider_role_access (provider_id, role_id, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ),
      )
      .run(providerId, roleId, grantedBy, grantedBy, now, now);
  }
}

export async function revokeProviderRoleAccess(
  providerId: string,
  roleId: string,
  updatedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE provider_role_access SET deleted_at = ?, updated_by = ?, updated_at = ?
       WHERE provider_id = ? AND role_id = ? AND deleted_at IS NULL`,
    )
    .run(now, updatedBy, now, providerId, roleId);
}

export async function getProviderRoleAccessList(
  providerId: string,
): Promise<Array<{ role_id: string; role_name: string; created_by: string; created_at: string }>> {
  return await dba
    .prepare(
      `SELECT pra.role_id, r.name AS role_name, pra.created_by, pra.created_at
       FROM provider_role_access pra
       JOIN roles r ON pra.role_id = r.id
       WHERE pra.provider_id = ? AND pra.deleted_at IS NULL
       ORDER BY pra.created_at DESC`,
    )
    .all(providerId) as Array<{ role_id: string; role_name: string; created_by: string; created_at: string }>;
}

export async function syncProviderRoleAccess(
  providerId: string,
  roleIds: string[],
  updatedBy: string,
): Promise<void> {
  const current = await getProviderRoleAccessList(providerId);
  const currentRoleIds = new Set(current.map((r) => r.role_id));
  const targetRoleIds = new Set(roleIds);

  for (const roleId of roleIds) {
    if (!currentRoleIds.has(roleId)) {
      await grantProviderRoleAccess(providerId, roleId, updatedBy);
    }
  }
  for (const roleId of currentRoleIds) {
    if (!targetRoleIds.has(roleId)) {
      await revokeProviderRoleAccess(providerId, roleId, updatedBy);
    }
  }
}

export async function listKnowledgeBases(
  opts?: { ownerType?: string; ownerId?: string },
): Promise<import('../types.js').KnowledgeBaseRecord[]> {
  if (opts?.ownerType) {
    return (await dba
      .prepare(
        `SELECT * FROM knowledge_bases WHERE owner_type = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
      )
      .all(opts.ownerType)) as import('../types.js').KnowledgeBaseRecord[];
  }
  return (await dba
    .prepare(`SELECT * FROM knowledge_bases WHERE deleted_at IS NULL ORDER BY created_at DESC`)
    .all()) as import('../types.js').KnowledgeBaseRecord[];
}

export async function listVisibleKnowledgeBasesPage(
  userId: string,
  systemUserId: string,
  opts?: { search?: string; limit?: number; offset?: number },
): Promise<import('../types.js').KnowledgeBaseRecord[]> {
  const params: unknown[] = [userId, systemUserId];
  const clauses = [
    'deleted_at IS NULL',
    "(user_id = ? OR user_id = ? OR visibility = 'shared')",
  ];
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    clauses.push('LOWER(name) LIKE ?');
    params.push(`%${search}%`);
  }
  params.push(Math.max(1, Math.min(200, Number(opts?.limit) || 50)));
  params.push(Math.max(0, Number(opts?.offset) || 0));
  return (await dba
    .prepare(
      `SELECT * FROM knowledge_bases
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params)) as import('../types.js').KnowledgeBaseRecord[];
}

export async function countVisibleKnowledgeBases(
  userId: string,
  systemUserId: string,
  opts?: { search?: string },
): Promise<number> {
  const params: unknown[] = [userId, systemUserId];
  const clauses = [
    'deleted_at IS NULL',
    "(user_id = ? OR user_id = ? OR visibility = 'shared')",
  ];
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    clauses.push('LOWER(name) LIKE ?');
    params.push(`%${search}%`);
  }
  const row = (await dba
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM knowledge_bases
       WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params)) as { cnt?: number } | undefined;
  return Number(row?.cnt || 0);
}

export async function getKnowledgeBase(
  id: string,
): Promise<import('../types.js').KnowledgeBaseRecord | null> {
  const rows = (await dba
    .prepare(`SELECT * FROM knowledge_bases WHERE id = ? AND deleted_at IS NULL`)
    .all(id)) as import('../types.js').KnowledgeBaseRecord[];
  return rows[0] ?? null;
}

export async function createKnowledgeBase(
  record: import('../types.js').KnowledgeBaseRecord,
  audit?: { created_by?: string; updated_by?: string },
): Promise<void> {
  const createdBy = audit?.created_by ?? getCurrentUserId();
  const updatedBy = audit?.updated_by ?? getCurrentUserId();
  await dba
    .prepare(
      adaptSql(`INSERT INTO knowledge_bases
        (id, name, description, owner_type, owner_id, embedding_model, embedding_provider_id,
         chunk_size, chunk_overlap, cleanup_patterns, enabled, user_id, category, visibility,
         enhancement_level, llm_provider_id, llm_model_override, temporal_half_life_days,
         allow_query_backfill, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    )
    .run(
      record.id, record.name, record.description,
      record.owner_type, record.owner_id, record.embedding_model,
      record.embedding_provider_id ?? null,
      record.chunk_size, record.chunk_overlap, record.cleanup_patterns ?? null,
      record.enabled,
      record.user_id || getCurrentUserId(), record.category || 'general',
      record.visibility || 'private',
      record.enhancement_level || 'metadata',
      record.llm_provider_id ?? null,
      record.llm_model_override ?? null,
      record.temporal_half_life_days ?? 365,
      record.allow_query_backfill ?? 0,
      createdBy,
      updatedBy,
      record.created_at, record.updated_at,
    );
}

export async function updateKnowledgeBase(
  id: string,
  updates: Partial<Pick<import('../types.js').KnowledgeBaseRecord, 'name' | 'description' | 'enabled' | 'chunk_size' | 'chunk_overlap' | 'cleanup_patterns' | 'embedding_model' | 'embedding_provider_id' | 'enhancement_level' | 'llm_provider_id' | 'llm_model_override' | 'temporal_half_life_days' | 'allow_query_backfill'>> & {
    updated_by?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); params.push(updates.enabled); }
  if (updates.chunk_size !== undefined) { sets.push('chunk_size = ?'); params.push(updates.chunk_size); }
  if (updates.chunk_overlap !== undefined) { sets.push('chunk_overlap = ?'); params.push(updates.chunk_overlap); }
  if (updates.cleanup_patterns !== undefined) { sets.push('cleanup_patterns = ?'); params.push(updates.cleanup_patterns); }
  if (updates.embedding_model !== undefined) { sets.push('embedding_model = ?'); params.push(updates.embedding_model); }
  if (updates.embedding_provider_id !== undefined) { sets.push('embedding_provider_id = ?'); params.push(updates.embedding_provider_id); }
  if (updates.enhancement_level !== undefined) { sets.push('enhancement_level = ?'); params.push(updates.enhancement_level); }
  if (updates.llm_provider_id !== undefined) { sets.push('llm_provider_id = ?'); params.push(updates.llm_provider_id); }
  if (updates.llm_model_override !== undefined) { sets.push('llm_model_override = ?'); params.push(updates.llm_model_override); }
  if (updates.temporal_half_life_days !== undefined) { sets.push('temporal_half_life_days = ?'); params.push(updates.temporal_half_life_days); }
  if (updates.allow_query_backfill !== undefined) { sets.push('allow_query_backfill = ?'); params.push(updates.allow_query_backfill); }
  if (sets.length === 0) return;
  const updatedBy = updates.updated_by ?? getCurrentUserId();
  sets.push('updated_by = ?');
  params.push(updatedBy);
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  await dba
    .prepare(`UPDATE knowledge_bases SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`)
    .run(...params);
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  const now = new Date().toISOString();
  // FTS cleanup (best-effort, per-document)
  try {
    const { getKnowledgeSearchEngine } = await import('../knowledge/knowledge-search-engine.js');
    const ftsEngine = getKnowledgeSearchEngine();
    const docs = (await dba
      .prepare(`SELECT id FROM knowledge_documents WHERE kb_id = ? AND deleted_at IS NULL`)
      .all(id)) as Array<{ id: string }>;
    for (const doc of docs) {
      await ftsEngine.deleteByDocumentId(eng(), doc.id);
    }
  } catch { /* FTS cleanup failure is non-fatal */ }

  // Batch delete embedding vectors for all chunks under this KB
  await dba
    .prepare(
      `DELETE FROM embedding_vectors WHERE owner_type = 'knowledge' AND owner_id IN (SELECT kc.id FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id WHERE kd.kb_id = ? AND kd.deleted_at IS NULL)`,
    )
    .run(id);
  await dba
    .prepare(
      `DELETE FROM knowledge_chunks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE kb_id = ? AND deleted_at IS NULL)`,
    )
    .run(id);
  await dba
    .prepare(
      `UPDATE knowledge_documents SET deleted_at = ?, updated_at = ? WHERE kb_id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, id);
  await dba
    .prepare(`UPDATE knowledge_bases SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(now, now, id);
  invalidateVectorRowCache('knowledge');
}

export async function getKnowledgeBaseProviderUsage(
  providerId: string,
): Promise<{ llmRefs: number; embeddingRefs: number }> {
  const llmRow = await dba
    .prepare(
      `SELECT COUNT(*) AS count FROM knowledge_bases
       WHERE llm_provider_id = ? AND deleted_at IS NULL`,
    )
    .get(providerId) as { count: number } | undefined;
  const embeddingRow = await dba
    .prepare(
      `SELECT COUNT(*) AS count FROM knowledge_bases
       WHERE embedding_provider_id = ? AND deleted_at IS NULL`,
    )
    .get(providerId) as { count: number } | undefined;
  return {
    llmRefs: Number(llmRow?.count || 0),
    embeddingRefs: Number(embeddingRow?.count || 0),
  };
}

// ---------------------------------------------------------------------------
// Knowledge Documents
// ---------------------------------------------------------------------------

export async function listKnowledgeDocuments(
  kbId: string,
): Promise<import('../types.js').KnowledgeDocumentRecord[]> {
  return (await dba
    .prepare(`SELECT * FROM knowledge_documents WHERE kb_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .all(kbId)) as import('../types.js').KnowledgeDocumentRecord[];
}

export async function listKnowledgeDocumentsPage(
  kbId: string,
  opts?: { search?: string; limit?: number; offset?: number },
): Promise<import('../types.js').KnowledgeDocumentRecord[]> {
  const params: unknown[] = [kbId];
  const clauses = ['kb_id = ?', 'deleted_at IS NULL'];
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    clauses.push('LOWER(filename) LIKE ?');
    params.push(`%${search}%`);
  }
  params.push(Math.max(1, Math.min(200, Number(opts?.limit) || 50)));
  params.push(Math.max(0, Number(opts?.offset) || 0));
  return (await dba
    .prepare(
      `SELECT * FROM knowledge_documents
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params)) as import('../types.js').KnowledgeDocumentRecord[];
}

export async function countKnowledgeDocumentsForList(
  kbId: string,
  opts?: { search?: string },
): Promise<number> {
  const params: unknown[] = [kbId];
  const clauses = ['kb_id = ?', 'deleted_at IS NULL'];
  const search = opts?.search?.trim().toLowerCase();
  if (search) {
    clauses.push('LOWER(filename) LIKE ?');
    params.push(`%${search}%`);
  }
  const row = (await dba
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM knowledge_documents
       WHERE ${clauses.join(' AND ')}`,
    )
    .get(...params)) as { cnt?: number } | undefined;
  return Number(row?.cnt || 0);
}

export async function countKnowledgeDocuments(kbId: string): Promise<number> {
  const row = (await dba
    .prepare(`SELECT COUNT(*) as cnt FROM knowledge_documents WHERE kb_id = ? AND status = 'indexed' AND deleted_at IS NULL`)
    .all(kbId)) as Array<{ cnt: number }>;
  return row[0]?.cnt ?? 0;
}

export async function getKnowledgeDocument(
  id: string,
): Promise<import('../types.js').KnowledgeDocumentRecord | null> {
  const rows = (await dba
    .prepare(`SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL`)
    .all(id)) as import('../types.js').KnowledgeDocumentRecord[];
  return rows[0] ?? null;
}

export async function findDocumentBySourceUrl(
  kbId: string,
  sourceUrl: string,
): Promise<import('../types.js').KnowledgeDocumentRecord | null> {
  const rows = (await dba
    .prepare(`SELECT * FROM knowledge_documents WHERE kb_id = ? AND source_url = ? AND deleted_at IS NULL`)
    .all(kbId, sourceUrl)) as import('../types.js').KnowledgeDocumentRecord[];
  return rows[0] ?? null;
}

export async function createKnowledgeDocument(
  record: import('../types.js').KnowledgeDocumentRecord,
  audit?: { created_by?: string; updated_by?: string },
): Promise<void> {
  const createdBy = audit?.created_by ?? getCurrentUserId();
  const updatedBy = audit?.updated_by ?? getCurrentUserId();
  await dba
    .prepare(
      adaptSql(`INSERT INTO knowledge_documents
        (id, kb_id, filename, content_type, content_hash, char_count,
         chunk_count, status, error_message, source_url, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    )
    .run(
      record.id, record.kb_id, record.filename, record.content_type,
      record.content_hash, record.char_count, record.chunk_count,
      record.status, record.error_message, record.source_url,
      createdBy,
      updatedBy,
      record.created_at, record.updated_at,
    );
}

export async function updateKnowledgeDocument(
  id: string,
  updates: Partial<Pick<import('../types.js').KnowledgeDocumentRecord,
    | 'status' | 'chunk_count' | 'error_message' | 'content_hash' | 'char_count'
    | 'published_at' | 'doc_path' | 'depth' | 'parent_doc_id' | 'llm_status'>> & {
    updated_by?: string;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.chunk_count !== undefined) { sets.push('chunk_count = ?'); params.push(updates.chunk_count); }
  if (updates.error_message !== undefined) { sets.push('error_message = ?'); params.push(updates.error_message); }
  if (updates.content_hash !== undefined) { sets.push('content_hash = ?'); params.push(updates.content_hash); }
  if (updates.char_count !== undefined) { sets.push('char_count = ?'); params.push(updates.char_count); }
  if (updates.published_at !== undefined) { sets.push('published_at = ?'); params.push(updates.published_at); }
  if (updates.doc_path !== undefined) { sets.push('doc_path = ?'); params.push(updates.doc_path); }
  if (updates.depth !== undefined) { sets.push('depth = ?'); params.push(updates.depth); }
  if (updates.parent_doc_id !== undefined) { sets.push('parent_doc_id = ?'); params.push(updates.parent_doc_id); }
  if (updates.llm_status !== undefined) { sets.push('llm_status = ?'); params.push(updates.llm_status); }
  if (sets.length === 0) return;
  const updatedBy = updates.updated_by ?? getCurrentUserId();
  sets.push('updated_by = ?');
  params.push(updatedBy);
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  await dba
    .prepare(`UPDATE knowledge_documents SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`)
    .run(...params);
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  const now = new Date().toISOString();
  // Clean up FTS index first (best-effort)
  try {
    const { getKnowledgeSearchEngine } = await import('../knowledge/knowledge-search-engine.js');
    const ftsEngine = getKnowledgeSearchEngine();
    await ftsEngine.deleteByDocumentId(eng(), id);
  } catch { /* FTS cleanup failure is non-fatal */ }

  await dba
    .prepare(
      `DELETE FROM embedding_vectors WHERE owner_type = 'knowledge' AND owner_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)`,
    )
    .run(id);
  await dba.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ?`).run(id);
  await dba
    .prepare(
      `UPDATE knowledge_documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, id);
  invalidateVectorRowCache('knowledge');
}

// ---------------------------------------------------------------------------
// Knowledge Chunks
// ---------------------------------------------------------------------------

export async function getKnowledgeChunks(
  documentId: string,
): Promise<import('../types.js').KnowledgeChunkRecord[]> {
  return (await dba
    .prepare(`SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC`)
    .all(documentId)) as import('../types.js').KnowledgeChunkRecord[];
}

export async function insertKnowledgeChunks(
  chunks: import('../types.js').KnowledgeChunkRecord[],
): Promise<void> {
  if (chunks.length === 0) return;
  const BATCH = 50;
  const sql = adaptSql(`INSERT INTO knowledge_chunks
    (id, document_id, chunk_index, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    await Promise.all(
      batch.map((c) =>
        dba.prepare(sql).run(c.id, c.document_id, c.chunk_index, c.content, c.token_count, c.created_at),
      ),
    );
  }
}

export async function getKnowledgeChunksByIds(
  ids: string[],
): Promise<Array<import('../types.js').KnowledgeChunkRecord & { kb_id?: string; filename?: string; kb_name?: string }>> {
  if (ids.length === 0) return [];
  const results: Array<import('../types.js').KnowledgeChunkRecord & { kb_id?: string; filename?: string; kb_name?: string }> = [];
  const batchSize = 100;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = (await dba
      .prepare(
        `SELECT c.*, d.kb_id, d.filename, kb.name AS kb_name
         FROM knowledge_chunks c
         INNER JOIN knowledge_documents d ON d.id = c.document_id AND d.deleted_at IS NULL
         INNER JOIN knowledge_bases kb ON kb.id = d.kb_id AND kb.deleted_at IS NULL
         WHERE c.id IN (${placeholders})`,
      )
      .all(...batch)) as Array<import('../types.js').KnowledgeChunkRecord & { kb_id?: string; filename?: string; kb_name?: string }>;
    results.push(...rows);
  }
  return results;
}

export async function deleteKnowledgeChunksByDocument(
  documentId: string,
): Promise<void> {
  const chunks = (await dba
    .prepare(`SELECT id FROM knowledge_chunks WHERE document_id = ?`)
    .all(documentId)) as Array<{ id: string }>;
  if (chunks.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const ph = batch.map(() => '?').join(', ');
      await dba.prepare(`DELETE FROM embedding_vectors WHERE owner_type = 'knowledge' AND owner_id IN (${ph})`).run(...batch.map((c) => c.id));
    }
  }
  await dba.prepare(`DELETE FROM knowledge_chunks WHERE document_id = ?`).run(documentId);
}

export async function getChunkKbIdMap(
  chunkIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (chunkIds.length === 0) return result;
  const batchSize = 200;
  for (let i = 0; i < chunkIds.length; i += batchSize) {
    const batch = chunkIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = (await dba
      .prepare(
        `SELECT c.id, d.kb_id FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id AND d.deleted_at IS NULL
         JOIN knowledge_bases kb ON kb.id = d.kb_id AND kb.deleted_at IS NULL
         WHERE c.id IN (${placeholders})`,
      )
      .all(...batch)) as Array<{ id: string; kb_id: string }>;
    for (const r of rows) result.set(r.id, r.kb_id);
  }
  return result;
}
