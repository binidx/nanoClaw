import { getProvider, isProviderVisibleToUser } from '../db/assistants.js';
import { getActiveEngine } from '../database/engine.js';
import { getCurrentUserId, SYSTEM_USER_ID } from './tenant-context.js';

function eng() {
  return getActiveEngine();
}

async function providerResolvedFromConfigUsableForUser(
  provider: { id: string; user_id: string },
  userId?: string,
): Promise<boolean> {
  if (!userId) return true;
  if (provider.user_id === userId) return true;
  return isProviderVisibleToUser(provider.id, userId);
}

// ── Chat operations ─────────────────────────────────────────────────

export async function getChatsForUser(userId: string) {
  return eng().queryAll<{
    jid: string;
    name: string | null;
    custom_title: string | null;
    is_pinned: number;
    is_favorite: number;
    last_message_time: string | null;
    channel: string | null;
    is_group: number;
  }>(
    `SELECT jid, name, custom_title, is_pinned, is_favorite, last_message_time, channel, is_group
     FROM chats WHERE user_id = ? AND deleted_at IS NULL ORDER BY last_message_time DESC`,
    [userId],
  );
}

export async function storeChatForUser(
  userId: string,
  jid: string,
  timestamp: string,
  name?: string,
  channel?: string,
) {
  const activeDialect = eng().dialect;
  const now = new Date().toISOString();
  const auditUser = getCurrentUserId();
  const insertValues = [
    jid,
    name ?? null,
    timestamp,
    channel ?? null,
    userId,
    auditUser,
    auditUser,
    now,
    now,
  ] as const;
  const sql = activeDialect === 'sqlite'
    ? `INSERT INTO chats (jid, name, last_message_time, channel, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(excluded.name, name),
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, channel),
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    : activeDialect === 'postgres'
      ? `INSERT INTO chats (jid, name, last_message_time, channel, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           last_message_time = GREATEST(chats.last_message_time, excluded.last_message_time),
           channel = COALESCE(excluded.channel, chats.channel),
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`
      : `INSERT INTO chats (jid, name, last_message_time, channel, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = COALESCE(VALUES(name), name),
           last_message_time = GREATEST(last_message_time, VALUES(last_message_time)),
           channel = COALESCE(VALUES(channel), channel),
           updated_at = VALUES(updated_at),
           updated_by = VALUES(updated_by)`;
  await eng().run(sql, [...insertValues]);
}

// ── Message operations ──────────────────────────────────────────────

export async function getMessagesForUser(
  userId: string,
  chatJid: string,
  limit = 50,
  beforeTimestamp?: string,
) {
  const params: unknown[] = [userId, chatJid];
  let whereExtra = '';
  if (beforeTimestamp) {
    whereExtra = ' AND timestamp < ?';
    params.push(beforeTimestamp);
  }
  params.push(limit);

  return eng().queryAll<{
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string | null;
    content: string;
    timestamp: string;
    is_bot_message: number;
    run_id: string | null;
    client_id: string | null;
  }>(
    `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_bot_message, run_id, client_id
     FROM messages WHERE user_id = ? AND chat_jid = ?${whereExtra}
     ORDER BY timestamp DESC LIMIT ?`,
    params,
  );
}

export async function storeMessageForUser(
  userId: string,
  msg: {
    id: string;
    chatJid: string;
    sender: string;
    senderName?: string;
    content: string;
    timestamp: string;
    isBotMessage?: boolean;
    runId?: string;
    clientId?: string;
  },
) {
  await eng().run(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_bot_message, run_id, client_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id,
      msg.chatJid,
      msg.sender,
      msg.senderName ?? null,
      msg.content,
      msg.timestamp,
      msg.isBotMessage ? 1 : 0,
      msg.runId ?? null,
      msg.clientId ?? null,
      userId,
    ],
  );
}

// ── Config operations (per-user with system fallback) ───────────────

export async function getTenantConfig(
  userId: string,
  key: string,
): Promise<string | undefined> {
  const d = eng().dialect;
  const keyCol = d === 'mysql' ? '`key`' : d === 'postgres' ? '"key"' : 'key';
  const row = await eng().queryOne<{ value: string }>(
    `SELECT value FROM config WHERE ${keyCol} = ?`,
    [`${userId}::${key}`],
  );
  if (row) return row.value;

  if (userId !== SYSTEM_USER_ID) {
    const sysRow = await eng().queryOne<{ value: string }>(
      `SELECT value FROM config WHERE ${keyCol} = ?`,
      [key],
    );
    return sysRow?.value;
  }
  return undefined;
}

async function getGlobalConfigValue(key: string): Promise<string | undefined> {
  const d = eng().dialect;
  const keyCol = d === 'mysql' ? '`key`' : d === 'postgres' ? '"key"' : 'key';
  const row = await eng().queryOne<{ value: string }>(
    `SELECT value FROM config WHERE ${keyCol} = ?`,
    [key],
  );
  return row?.value;
}

export async function setTenantConfig(
  userId: string,
  key: string,
  value: string,
): Promise<void> {
  const compositeKey = userId === SYSTEM_USER_ID ? key : `${userId}::${key}`;
  const now = new Date().toISOString();
  const isSqlite = eng().dialect === 'sqlite';

  if (isSqlite) {
    await eng().run(
      `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)`,
      [compositeKey, value, now],
    );
  } else if (eng().dialect === 'mysql') {
    await eng().run(
      `INSERT INTO config (\`key\`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
      [compositeKey, value, now],
    );
  } else {
    await eng().run(
      `INSERT INTO config ("key", value, updated_at) VALUES (?, ?, ?) ON CONFLICT("key") DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [compositeKey, value, now],
    );
  }
}

// ── AI Provider operations (per-user BYOK) ──────────────────────────

export async function getProvidersForUser(userId: string) {
  return eng().queryAll<{
    id: string;
    alias: string;
    type: string;
    api_key: string | null;
    base_url: string | null;
    model: string | null;
    extra_config: string | null;
    is_default: number;
  }>(
    `SELECT id, alias, type, api_key, base_url, model, extra_config, is_default
     FROM ai_providers WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC`,
    [userId],
  );
}

export async function getDefaultProviderForUser(userId: string) {
  type ProviderRow = {
    id: string;
    type: string;
    api_key: string | null;
    base_url: string | null;
    model: string | null;
    extra_config: string | null;
  };

  const preferred = await eng().queryOne<ProviderRow>(
    `SELECT p.id, p.type, p.api_key, p.base_url, p.model, p.extra_config
     FROM user_default_providers udp
     JOIN ai_providers p ON p.id = udp.provider_id AND p.deleted_at IS NULL
     WHERE udp.user_id = ? LIMIT 1`,
    [userId],
  );
  if (preferred && await isProviderVisibleToUser(preferred.id, userId)) {
    return preferred;
  }

  const userProvider = await eng().queryOne<ProviderRow>(
    `SELECT id, type, api_key, base_url, model, extra_config
     FROM ai_providers WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
    [userId],
  );
  if (userProvider) return userProvider;

  const firstOwnProvider = await eng().queryOne<ProviderRow>(
    `SELECT id, type, api_key, base_url, model, extra_config
     FROM ai_providers WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  if (firstOwnProvider) return firstOwnProvider;

  const systemProvider = await eng().queryOne<ProviderRow>(
    `SELECT id, type, api_key, base_url, model, extra_config
     FROM ai_providers WHERE user_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
    [SYSTEM_USER_ID],
  );
  if (systemProvider && await isProviderVisibleToUser(systemProvider.id, userId)) {
    return systemProvider;
  }

  const globalDefault = await eng().queryOne<ProviderRow>(
    `SELECT id, type, api_key, base_url, model, extra_config
     FROM ai_providers WHERE is_default = 1 AND deleted_at IS NULL LIMIT 1`,
  );
  if (globalDefault && await isProviderVisibleToUser(globalDefault.id, userId)) {
    return globalDefault;
  }
  return undefined;
}

export async function getProviderForModule(
  module: string,
  userId?: string,
): Promise<{
  id: string;
  type: string;
  api_key: string | null;
  base_url: string | null;
  model: string | null;
  extra_config: string | null;
} | undefined> {
  const configKey = `DEFAULT_PROVIDER_${module}`;

  if (userId) {
    const userModuleProviderId = await getTenantConfig(userId, configKey);
    const trimmedUserModuleId = userModuleProviderId?.trim();
    if (trimmedUserModuleId) {
      const byUserModule = await getProvider(trimmedUserModuleId);
      if (
        byUserModule
        && await providerResolvedFromConfigUsableForUser(byUserModule, userId)
      ) {
        return {
          id: byUserModule.id,
          type: byUserModule.type,
          api_key: byUserModule.api_key,
          base_url: byUserModule.base_url,
          model: byUserModule.model,
          extra_config: byUserModule.extra_config,
        };
      }
    }

    const userDefault = await getDefaultProviderForUser(userId);
    if (userDefault) return userDefault;
  }

  const sysModuleProviderId = await getGlobalConfigValue(configKey);
  const trimmedSysModuleId = sysModuleProviderId?.trim();
  if (trimmedSysModuleId) {
    const bySysModule = await getProvider(trimmedSysModuleId);
    if (
      bySysModule
      && await providerResolvedFromConfigUsableForUser(bySysModule, userId)
    ) {
      return {
        id: bySysModule.id,
        type: bySysModule.type,
        api_key: bySysModule.api_key,
        base_url: bySysModule.base_url,
        model: bySysModule.model,
        extra_config: bySysModule.extra_config,
      };
    }
  }

  return userId
    ? getDefaultProviderForUser(userId)
    : getDefaultProviderForUser(SYSTEM_USER_ID);
}

// ── Assistant operations (per-user) ─────────────────────────────────

export async function getAssistantsForUser(userId: string) {
  return eng().queryAll<{
    id: string;
    name: string;
    description: string | null;
    enabled: number;
    config_json: string;
  }>(
    `SELECT id, name, description, enabled, config_json
     FROM assistants WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC`,
    [userId],
  );
}

// ── Scheduled tasks (per-user) ──────────────────────────────────────

export async function getScheduledTasksForUser(userId: string) {
  return eng().queryAll<{
    id: string;
    title: string;
    chat_jid: string;
    schedule_value: string;
    prompt: string;
    status: string;
  }>(
    `SELECT id, title, chat_jid, schedule_value, prompt, status
     FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
}

// ── Channel instances (per-user) ────────────────────────────────────

export async function getChannelInstancesForUser(userId: string) {
  return eng().queryAll<{
    id: string;
    type: string;
    name: string;
    enabled: number;
    config_json: string;
  }>(
    `SELECT id, type, name, enabled, config_json
     FROM channel_instances WHERE user_id = ? AND deleted_at IS NULL ORDER BY type, name`,
    [userId],
  );
}

export async function upsertChannelInstance(
  userId: string,
  instance: {
    id: string;
    type: string;
    name: string;
    enabled?: boolean;
    configJson: string;
  },
) {
  const now = new Date().toISOString();
  const isSqlite = eng().dialect === 'sqlite';
  const enabled = instance.enabled === false ? 0 : 1;

  const auditUser = getCurrentUserId();
  if (isSqlite) {
    await eng().run(
      `INSERT OR REPLACE INTO channel_instances (id, user_id, type, name, enabled, config_json, created_by, updated_by, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        instance.id,
        userId,
        instance.type,
        instance.name,
        enabled,
        instance.configJson,
        auditUser,
        auditUser,
        null,
        now,
        now,
      ],
    );
  } else if (eng().dialect === 'postgres') {
    await eng().run(
      `INSERT INTO channel_instances (id, user_id, type, name, enabled, config_json, created_by, updated_by, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled, config_json = EXCLUDED.config_json, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, deleted_at = EXCLUDED.deleted_at`,
      [
        instance.id,
        userId,
        instance.type,
        instance.name,
        enabled,
        instance.configJson,
        auditUser,
        auditUser,
        null,
        now,
        now,
      ],
    );
  } else {
    await eng().run(
      `INSERT INTO channel_instances (id, user_id, type, name, enabled, config_json, created_by, updated_by, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), enabled = VALUES(enabled), config_json = VALUES(config_json), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by), deleted_at = VALUES(deleted_at)`,
      [
        instance.id,
        userId,
        instance.type,
        instance.name,
        enabled,
        instance.configJson,
        auditUser,
        auditUser,
        null,
        now,
        now,
      ],
    );
  }
}

export async function deleteChannelInstance(
  userId: string,
  instanceId: string,
) {
  const now = new Date().toISOString();
  await eng().run(
    `UPDATE channel_instances SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    [now, now, instanceId, userId],
  );
}

export async function getAllEnabledChannelInstances() {
  return eng().queryAll<{
    id: string;
    user_id: string;
    type: string;
    name: string;
    config_json: string;
  }>(
    `SELECT id, user_id, type, name, config_json
     FROM channel_instances WHERE enabled = 1 AND deleted_at IS NULL`,
  );
}
