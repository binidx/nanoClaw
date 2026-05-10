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
import {
  type DbEngine,
} from '../database/engine.js';
import { isValidGroupFolder } from '../group-folder.js';
import { createModuleLogger } from '../logger.js';
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
import { adaptSql } from './sql-adapters.js';
import { dba, eng, getSqliteRawDatabase, isSqlite } from './engine-access.js';
import { createPlaceholders, estimateTokenCount, normalizeMemoryText } from './sql-utils.js';
import {
  deleteMemoryDocumentSyncStates,
  deleteMemoryDocumentsByPathRefs,
  recordMemorySearchEvent,
  upsertMemoryDocuments,
} from './memory.js';
import { getRegisteredGroup, setRegisteredGroup } from './sessions.js';
import * as dialect from '../database/dialect.js';

const logger = createModuleLogger('database');

interface ContextCompactionJobRecord {
  chat_jid: string;
  group_folder: string;
  requested_at: string;
  available_at: string;
  pending: number;
  runtime_claimed_at: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_duration_ms: number | null;
  last_error: string | null;
  run_count: number;
  failure_count: number;
  updated_at: string;
}

function serializeUploadedFilesJson(
  uploadedFiles: NewMessage['uploaded_files'],
): string | null {
  if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return null;
  return JSON.stringify(uploadedFiles);
}

function parseUploadedFilesJson(
  value: unknown,
): NewMessage['uploaded_files'] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const files = parsed.filter((file): file is NonNullable<NewMessage['uploaded_files']>[number] =>
      Boolean(
        file &&
        typeof file === 'object' &&
        typeof (file as Record<string, unknown>).name === 'string' &&
        typeof (file as Record<string, unknown>).mimeType === 'string' &&
        typeof (file as Record<string, unknown>).relativePath === 'string' &&
        Number.isFinite((file as Record<string, unknown>).size),
      ),
    );
    return files.length > 0 ? files : undefined;
  } catch {
    return undefined;
  }
}

function mapConversationMessageRow(
  row: Record<string, unknown>,
): NewMessage {
  const uploadedFiles = parseUploadedFilesJson(row.uploaded_files_json);
  return {
    id: String(row.id || ''),
    chat_jid: String(row.chat_jid || ''),
    sender: String(row.sender || ''),
    sender_name: String(row.sender_name || ''),
    content: String(row.content || ''),
    timestamp: String(row.timestamp || ''),
    ...(typeof row.client_id === 'string' && row.client_id
      ? { client_id: row.client_id }
      : {}),
    ...(typeof row.run_id === 'string' && row.run_id ? { run_id: row.run_id } : {}),
    ...(row.is_from_me !== undefined ? { is_from_me: Boolean(row.is_from_me) } : {}),
    ...(row.is_bot_message !== undefined
      ? { is_bot_message: Boolean(row.is_bot_message) }
      : {}),
    ...(uploadedFiles ? { uploaded_files: uploadedFiles } : {}),
  };
}

const CONTEXT_COMPACTION_JOB_LEASE_MS = 60_000;
const HIDDEN_CONVERSATION_CHANNELS = ['workflow', 'workteam'] as const;

function buildHiddenConversationChannelPredicate(tablePrefix = 'c.'): string {
  const p = tablePrefix;
  const placeholders = createPlaceholders(HIDDEN_CONVERSATION_CHANNELS.length);
  return `COALESCE(${p}channel, '') NOT IN (${placeholders})`;
}

export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
  explicitUserId?: string,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;
  const activeDialect = eng().dialect;
  const userId = explicitUserId || getCurrentUserId();

  if (name) {
    const sql = activeDialect === 'sqlite' ?
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, channel),
         is_group = COALESCE(excluded.is_group, is_group),
         updated_at = ?,
         updated_by = ?` :
      activeDialect === 'postgres' ?
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = GREATEST(chats.last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, chats.channel),
         is_group = COALESCE(excluded.is_group, chats.is_group),
         updated_at = ?,
         updated_by = ?` :
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         last_message_time = GREATEST(last_message_time, VALUES(last_message_time)),
         channel = COALESCE(VALUES(channel), channel),
         is_group = COALESCE(VALUES(is_group), is_group),
         updated_at = ?,
         updated_by = ?`;
    await dba.prepare(sql).run(
      chatJid,
      name,
      timestamp,
      ch,
      group,
      userId,
      getCurrentUserId(),
      getCurrentUserId(),
      timestamp,
      timestamp,
      timestamp,
      userId,
    );
  } else {
    const sql = activeDialect === 'sqlite' ?
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, channel),
         is_group = COALESCE(excluded.is_group, is_group),
         updated_at = ?,
         updated_by = ?` :
      activeDialect === 'postgres' ?
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = GREATEST(chats.last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, chats.channel),
         is_group = COALESCE(excluded.is_group, chats.is_group),
         updated_at = ?,
         updated_by = ?` :
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_message_time = GREATEST(last_message_time, VALUES(last_message_time)),
         channel = COALESCE(VALUES(channel), channel),
         is_group = COALESCE(VALUES(is_group), is_group),
         updated_at = ?,
         updated_by = ?`;
    await dba.prepare(sql).run(
      chatJid,
      chatJid,
      timestamp,
      ch,
      group,
      userId,
      getCurrentUserId(),
      getCurrentUserId(),
      timestamp,
      timestamp,
      timestamp,
      userId,
    );
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export async function updateChatName(chatJid: string, name: string): Promise<void> {
  const activeDialect = eng().dialect;
  const userId = getCurrentUserId();
  const ts = new Date().toISOString();
  const sql =
    activeDialect === 'sqlite'
      ? `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = ?, updated_by = ?`
      : activeDialect === 'postgres'
        ? `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = ?, updated_by = ?`
        : `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = ?, updated_by = ?`;
  await dba.prepare(sql).run(
    chatJid,
    name,
    ts,
    userId,
    getCurrentUserId(),
    getCurrentUserId(),
    ts,
    ts,
    ts,
    userId,
  );
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
  mode: string | null;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export async function getAllChats(): Promise<ChatInfo[]> {
  return await dba
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group, mode
    FROM chats
    WHERE deleted_at IS NULL
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export async function getLastGroupSync(): Promise<string | null> {
  // Store sync time in a special chat entry
  const row = await dba
    .prepare(
      `SELECT last_message_time FROM chats WHERE jid = '__group_sync__' AND deleted_at IS NULL`,
    )
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export async function setLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  const activeDialect = eng().dialect;
  const sql =
    activeDialect === 'sqlite'
      ? `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES ('__group_sync__', '__group_sync__', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = excluded.last_message_time, updated_at = ?, updated_by = ?`
      : activeDialect === 'postgres'
        ? `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES ('__group_sync__', '__group_sync__', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = excluded.last_message_time, updated_at = ?, updated_by = ?`
        : `INSERT INTO chats (jid, name, last_message_time, user_id, created_by, updated_by, created_at, updated_at) VALUES ('__group_sync__', '__group_sync__', ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_message_time = VALUES(last_message_time), updated_at = ?, updated_by = ?`;
  await dba.prepare(sql).run(
    now,
    userId,
    getCurrentUserId(),
    getCurrentUserId(),
    now,
    now,
    now,
    getCurrentUserId(),
  );
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export async function storeMessage(msg: NewMessage): Promise<void> {
  await dba.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, uploaded_files_json, timestamp, client_id, run_id, is_from_me, is_bot_message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    serializeUploadedFilesJson(msg.uploaded_files),
    msg.timestamp,
    msg.client_id || null,
    msg.run_id || null,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    getCurrentUserId(),
  );
  invalidateMessageCache(msg.chat_jid);
}

export async function hasStoredMessage(chatJid: string, messageId: string): Promise<boolean> {
  const row = await dba
    .prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1')
    .get(chatJid, messageId) as { 1?: number } | undefined;
  return !!row;
}

/**
 * Store a message directly.
 */
export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  client_id?: string;
  run_id?: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  uploaded_files?: NewMessage['uploaded_files'];
}): Promise<void> {
  await dba.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, uploaded_files_json, timestamp, client_id, run_id, is_from_me, is_bot_message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    serializeUploadedFilesJson(msg.uploaded_files),
    msg.timestamp,
    msg.client_id || null,
    msg.run_id || null,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    getCurrentUserId(),
  );
  invalidateMessageCache(msg.chat_jid);
}

export interface ConversationParticipant {
  chat_jid: string;
  channel: string;
  member_id: string;
  member_name: string;
  source: string;
  last_seen_at: string;
}

function shouldPreferParticipantName(name: string, memberId: string): boolean {
  const normalizedName = String(name || '').trim();
  const normalizedId = String(memberId || '').trim();
  return Boolean(normalizedName) && normalizedName !== normalizedId;
}

export async function upsertConversationParticipant(input: {
  chatJid: string;
  channel?: string;
  memberId: string;
  memberName?: string;
  source?: string;
  lastSeenAt?: string;
}): Promise<void> {
  const chatJid = input.chatJid.trim();
  const memberId = input.memberId.trim();
  if (!chatJid || !memberId) return;

  const existing = await dba
    .prepare(
      `SELECT member_name, source, last_seen_at, channel
       FROM conversation_participants
       WHERE chat_jid = ? AND member_id = ?`,
    )
    .get(chatJid, memberId) as
    | {
        member_name: string | null;
        source: string | null;
        last_seen_at: string | null;
        channel: string | null;
      }
    | undefined;

  const incomingName = String(input.memberName || '').trim();
  const existingName = String(existing?.member_name || '').trim();
  const memberName = shouldPreferParticipantName(incomingName, memberId)
    ? incomingName
    : shouldPreferParticipantName(existingName, memberId)
      ? existingName
      : incomingName || existingName || memberId;
  const source =
    String(input.source || '').trim() ||
    String(existing?.source || '').trim() ||
    'message';
  const channel =
    String(input.channel || '').trim() ||
    String(existing?.channel || '').trim() ||
    '';
  const lastSeenAt =
    [
      String(input.lastSeenAt || '').trim(),
      String(existing?.last_seen_at || '').trim(),
    ]
      .filter(Boolean)
      .sort()
      .pop() || new Date().toISOString();

  await dba.prepare(
    `INSERT OR REPLACE INTO conversation_participants
      (chat_jid, channel, member_id, member_name, source, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatJid, channel || null, memberId, memberName, source, lastSeenAt);
}

export async function backfillConversationParticipantsFromMessages(
  chatJid: string,
  channel?: string,
): Promise<void> {
  const rows = await dba
    .prepare(
      `SELECT sender as member_id,
              MAX(timestamp) as last_seen_at,
              (
                SELECT m2.sender_name
                FROM messages m2
                WHERE m2.chat_jid = ?
                  AND m2.sender = m1.sender
                ORDER BY m2.timestamp DESC
                LIMIT 1
              ) as member_name
       FROM messages m1
       WHERE m1.chat_jid = ?
         AND COALESCE(m1.is_from_me, 0) = 0
         AND trim(COALESCE(m1.sender, '')) <> ''
       GROUP BY m1.sender`,
    )
    .all(chatJid, chatJid) as Array<{
    member_id: string;
    member_name: string | null;
    last_seen_at: string;
  }>;

  for (const row of rows) {
    await upsertConversationParticipant({
      chatJid,
      channel,
      memberId: row.member_id,
      memberName: row.member_name || row.member_id,
      source: 'message',
      lastSeenAt: row.last_seen_at,
    });
  }
}

export async function listConversationParticipants(
  chatJid: string,
): Promise<ConversationParticipant[]> {
  return await dba
    .prepare(
      `SELECT chat_jid, COALESCE(channel, '') as channel, member_id, COALESCE(member_name, member_id) as member_name,
              COALESCE(source, 'message') as source, last_seen_at
       FROM conversation_participants
       WHERE chat_jid = ?
       ORDER BY last_seen_at DESC, member_name COLLATE NOCASE ASC`,
    )
    .all(chatJid) as ConversationParticipant[];
}

export type PersistedTurnItemStatus = 'in_progress' | 'completed' | 'failed';

export interface PersistedReasoningTurnItem {
  id: string;
  type: 'reasoning';
  status: PersistedTurnItemStatus;
  title: string;
  text?: string;
  timestamp: string;
}

export interface PersistedToolCallTurnItem {
  id: string;
  type: 'tool_call';
  status: PersistedTurnItemStatus;
  title: string;
  argumentsText?: string;
  resultText?: string;
  errorText?: string;
  startedAt?: string;
  completedAt?: string;
  subagentInfo?: {
    agentName: string;
    runtimeId?: string;
    provider?: string;
    mode?: 'agent' | 'team';
    runtimeKind?: 'managed_run' | 'managed_session' | 'ephemeral_snapshot';
    providerSessionId?: string;
    parentRuntimeId?: string;
    controllerSessionKey?: string;
    requesterSessionKey?: string;
    originTurnId?: string;
    originToolCallId?: string;
    topologyRole?: 'main' | 'orchestrator' | 'leaf';
    workProfile?: 'explorer' | 'worker';
    role?: 'main' | 'orchestrator' | 'leaf';
    controlScope?: 'children' | 'none';
    depth?: number;
    chatJid?: string;
    requestCount?: number;
    controllable?: boolean;
    task?: string;
    status:
      | 'spawning'
      | 'idle'
      | 'running'
      | 'stopping'
      | 'completed'
      | 'failed'
      | 'stopped';
  };
  timestamp: string;
}

export interface PersistedAssistantMessageTurnItem {
  id: string;
  type: 'assistant_message';
  status: Extract<PersistedTurnItemStatus, 'in_progress' | 'completed'>;
  text: string;
  timestamp: string;
}

export type PersistedTurnItem =
  | PersistedReasoningTurnItem
  | PersistedToolCallTurnItem
  | PersistedAssistantMessageTurnItem;

export interface PersistedAssistantTurn {
  id: string;
  clientKey?: string;
  timestamp: string;
  items: PersistedTurnItem[];
  isLive: boolean;
  isCompleted: boolean;
  persistedMessageId?: string;
  error?: string;
}

export async function storeMessageDirectWithTurn(
  msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    client_id?: string;
    run_id?: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  },
  turn: PersistedAssistantTurn,
): Promise<void> {
  const tx = dba.transaction(async () => {
    await storeMessageDirect(msg);
    await storeAssistantTurnSnapshot(msg.chat_jid, turn, msg.timestamp);
  });
  await tx();
}

const turnCache = new Map<string, { data: PersistedAssistantTurn[]; expiresAt: number }>();
const TURN_CACHE_TTL_MS = 2_000;
const TURN_CACHE_MAX_ENTRIES = 64;

export function invalidateTurnCache(chatJid?: string): void {
  if (chatJid) {
    for (const key of turnCache.keys()) {
      if (key.startsWith(`${chatJid}:`)) turnCache.delete(key);
    }
  } else {
    turnCache.clear();
  }
}

export async function storeAssistantTurnSnapshot(
  chatJid: string,
  turn: PersistedAssistantTurn,
  createdAt = new Date().toISOString(),
): Promise<void> {
  await dba.prepare(
    `INSERT OR REPLACE INTO assistant_turns (id, chat_jid, message_id, timestamp, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    chatJid,
    turn.persistedMessageId || null,
    turn.timestamp,
    JSON.stringify(turn),
    createdAt,
  );
  invalidateTurnCache(chatJid);
}

export async function deleteAssistantTurnSnapshot(
  chatJid: string,
  turnId: string,
): Promise<void> {
  await dba
    .prepare('DELETE FROM assistant_turns WHERE chat_jid = ? AND id = ?')
    .run(chatJid, turnId);
  invalidateTurnCache(chatJid);
}

export async function deleteConversationMessageById(
  chatJid: string,
  messageId: string,
): Promise<void> {
  await dba
    .prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?')
    .run(chatJid, messageId);
  invalidateMessageCache(chatJid);
}

function fixStaleTurnPayload(row: { id: string; chat_jid: string; payload: string }): PersistedAssistantTurn | null {
  try {
    const turn = JSON.parse(row.payload) as PersistedAssistantTurn;
    let dirty = false;
    if (turn.isLive) {
      turn.isLive = false;
      dirty = true;
    }
    if (!turn.isCompleted) {
      turn.isCompleted = true;
      dirty = true;
    }
    turn.items = turn.items.map((item) => {
      if (item.status === 'in_progress') {
        dirty = true;
        return { ...item, status: 'completed' as const };
      }
      return item;
    });
    return dirty ? turn : null;
  } catch { return null; }
}

const STALE_TURN_QUERY = `SELECT id, chat_jid, payload FROM assistant_turns WHERE payload LIKE '%"isLive":true%' OR payload LIKE '%"in_progress"%'`;

/**
 * On startup, fix all assistant_turns stuck in isLive/in_progress state
 * from a previous unclean shutdown.
 */
export async function sanitizeStaleTurns(): Promise<number> {
  const rows = await dba.prepare(STALE_TURN_QUERY)
    .all() as Array<{ id: string; chat_jid: string; payload: string }>;

  let fixed = 0;
  for (const row of rows) {
    const turn = fixStaleTurnPayload(row);
    if (!turn) continue;
    await dba.prepare(
      `UPDATE assistant_turns SET payload = ? WHERE id = ? AND chat_jid = ?`,
    ).run(JSON.stringify(turn), row.id, row.chat_jid);
    fixed++;
  }
  if (fixed > 0) invalidateTurnCache();
  return fixed;
}

/**
 * Fix stuck turns for a single conversation. Called when the user
 * clicks interrupt but no active agent process exists.
 */
export async function sanitizeStaleTurnsForChat(chatJid: string): Promise<number> {
  const rows = await dba.prepare(
    `SELECT id, chat_jid, payload FROM assistant_turns WHERE chat_jid = ? AND (payload LIKE '%"isLive":true%' OR payload LIKE '%"in_progress"%')`,
  ).all(chatJid) as Array<{ id: string; chat_jid: string; payload: string }>;

  let fixed = 0;
  for (const row of rows) {
    const turn = fixStaleTurnPayload(row);
    if (!turn) continue;
    await dba.prepare(
      `UPDATE assistant_turns SET payload = ? WHERE id = ? AND chat_jid = ?`,
    ).run(JSON.stringify(turn), row.id, row.chat_jid);
    fixed++;
  }
  if (fixed > 0) invalidateTurnCache(chatJid);
  return fixed;
}

export async function storeContextEntry(entry: ContextEntryRecord): Promise<void> {
  await dba.prepare(
    `
      INSERT OR REPLACE INTO context_entries (
        id,
        group_folder,
        chat_jid,
        run_id,
        provider,
        role,
        source_type,
        source_ref,
        content_text,
        content_json,
        token_estimate,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    entry.id,
    entry.group_folder,
    entry.chat_jid,
    entry.run_id || null,
    entry.provider,
    entry.role,
    entry.source_type,
    entry.source_ref || null,
    entry.content_text,
    entry.content_json || null,
    entry.token_estimate ?? null,
    entry.created_at,
  );
}

export async function storeContextEntries(entries: ContextEntryRecord[]): Promise<void> {
  if (entries.length === 0) return;
  const tx = dba.transaction(async (items: ContextEntryRecord[]) => {
    for (const entry of items) {
      await storeContextEntry(entry);
    }
  });
  await tx(entries);
}

export async function storeMemoryRecallEntry(input: {
  groupFolder: string;
  chatJid: string;
  pathRef: string;
  scope: 'group' | 'global';
  lineStart: number;
  lineEnd: number;
  text: string;
  score?: number | null;
  searchQuery?: string | null;
  searchRank?: number | null;
  searchMatchedAt?: string | null;
  searchResultCount?: number | null;
  sourceType?: string | null;
  memoryClass?: string | null;
  ownerType?: MemoryDocumentRecord['owner_type'] | null;
  ownerId?: string | null;
  createdAt?: string;
}): Promise<ContextEntryRecord> {
  const createdAt = input.createdAt || new Date().toISOString();
  const text = String(input.text || '').trim();
  const normalizedSearchQuery = String(input.searchQuery || '').trim();
  const normalizedSearchRank =
    typeof input.searchRank === 'number' && Number.isFinite(input.searchRank)
      ? Math.max(1, Math.trunc(input.searchRank))
      : null;
  const normalizedSearchMatchedAt =
    typeof input.searchMatchedAt === 'string' &&
    !Number.isNaN(Date.parse(input.searchMatchedAt))
      ? input.searchMatchedAt
      : null;
  const normalizedSearchResultCount =
    typeof input.searchResultCount === 'number' &&
    Number.isFinite(input.searchResultCount)
      ? Math.max(0, Math.trunc(input.searchResultCount))
      : null;
  const searchFollowup =
    normalizedSearchQuery ||
    normalizedSearchRank !== null ||
    normalizedSearchMatchedAt ||
    normalizedSearchResultCount !== null
      ? {
          query: normalizedSearchQuery || null,
          rank: normalizedSearchRank,
          matchedAt: normalizedSearchMatchedAt,
          resultCount: normalizedSearchResultCount,
        }
      : null;
  const entry: ContextEntryRecord = {
    id: `memory_recall:${input.chatJid}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: null,
    provider: 'system',
    role: 'memory',
    source_type: 'memory_recall',
    source_ref: input.pathRef,
    content_text: text,
    content_json: JSON.stringify({
      path: input.pathRef,
      scope: input.scope,
      lineStart: input.lineStart,
      lineEnd: input.lineEnd,
      score:
        typeof input.score === 'number' && Number.isFinite(input.score)
          ? input.score
          : null,
      sourceType: normalizeMemoryText(input.sourceType || '') || null,
      memoryClass: normalizeMemoryText(input.memoryClass || '') || null,
      search: searchFollowup,
    }),
    token_estimate: estimateTokenCount(text),
    created_at: createdAt,
  };
  await storeContextEntries([entry]);
  if (searchFollowup) {
    await recordMemorySearchEvent({
      eventType: 'search_followup_read',
      pathRef: input.pathRef,
      scope: input.scope,
      ownerType:
        input.ownerType ||
        (input.scope === 'global' ? 'global' : 'group'),
      ownerId:
        input.ownerId ||
        (input.scope === 'global' ? 'global' : input.groupFolder),
      metadataJson: JSON.stringify({
        ...searchFollowup,
        sourceType: normalizeMemoryText(input.sourceType || '') || null,
        memoryClass: normalizeMemoryText(input.memoryClass || '') || null,
      }),
      createdAt,
    });
  }
  return entry;
}

export async function storeMemoryPromotionEntry(input: {
  groupFolder: string;
  chatJid: string;
  compactionId?: string | null;
  candidate: MemoryPromotionCandidate;
  status: 'candidate' | 'written' | 'deduped';
  pathRef?: string | null;
  action?: 'auto' | 'remember' | 'session_only';
  memoryClass?:
    | 'identity'
    | 'global_durable'
    | 'group_durable'
    | 'session'
    | null;
  origin?: MemoryPromotionCandidate['origin'];
  createdAt?: string;
}): Promise<ContextEntryRecord> {
  const createdAt = input.createdAt || new Date().toISOString();
  const contentText = input.candidate.text;
  const entry: ContextEntryRecord = {
    id: `memory_promotion:${input.chatJid}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: null,
    provider: 'system',
    role: 'memory',
    source_type: 'memory_promotion',
    source_ref: input.compactionId || null,
    content_text: contentText,
    content_json: JSON.stringify({
      status: input.status,
      kind: input.candidate.kind,
      confidence: input.candidate.confidence,
      origin: input.origin || input.candidate.origin,
      action: input.action || 'auto',
      memoryClass: input.memoryClass || null,
      path: input.pathRef || null,
      sourceEntryIds: input.candidate.sourceEntryIds,
    }),
    token_estimate: estimateTokenCount(contentText),
    created_at: createdAt,
  };
  await storeContextEntries([entry]);
  return entry;
}

export async function storeSessionMemoryEntry(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  sourceRef?: string | null;
  createdAt?: string;
}): Promise<ContextEntryRecord> {
  const createdAt = input.createdAt || new Date().toISOString();
  const contentText = String(input.text || '').trim();
  const entry: ContextEntryRecord = {
    id: `session_memory:${input.chatJid}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    run_id: null,
    provider: 'system',
    role: 'memory',
    source_type: 'post_compaction_context',
    source_ref: input.sourceRef || null,
    content_text: `仅当前会话有效：${contentText}`,
    content_json: JSON.stringify({
      visibility: 'session_only',
      originalText: contentText,
    }),
    token_estimate: estimateTokenCount(contentText),
    created_at: createdAt,
  };
  await storeContextEntries([entry]);
  return entry;
}

export async function getContextEntries(
  chatJid: string,
  limit = 200,
): Promise<ContextEntryRecord[]> {
  return await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          run_id,
          provider,
          role,
          source_type,
          source_ref,
          content_text,
          content_json,
          token_estimate,
          created_at
        FROM context_entries
        WHERE chat_jid = ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
    )
    .all(chatJid, limit) as ContextEntryRecord[];
}

export async function getContextEntriesByIds(ids: string[]): Promise<ContextEntryRecord[]> {
  if (ids.length === 0) return [];
  const placeholders = createPlaceholders(ids.length);
  return await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          run_id,
          provider,
          role,
          source_type,
          source_ref,
          content_text,
          content_json,
          token_estimate,
          created_at
        FROM context_entries
        WHERE id IN (${placeholders})
      `,
    )
    .all(...ids) as ContextEntryRecord[];
}

async function getCompactionEligibleContextEntries(
  chatJid: string,
): Promise<ContextEntryRecord[]> {
  return getCompactionEligibleContextEntriesPublic(chatJid);
}

export async function getCompactionEligibleContextEntriesPublic(
  chatJid: string,
): Promise<ContextEntryRecord[]> {
  return await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          run_id,
          provider,
          role,
          source_type,
          source_ref,
          content_text,
          content_json,
          token_estimate,
          created_at
        FROM context_entries
        WHERE chat_jid = ?
          AND source_type IN ('chat_message', 'assistant_message')
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(chatJid) as ContextEntryRecord[];
}

async function buildDeterministicContextCompactionSummary(
  entries: ContextEntryRecord[],
): Promise<string> {
  if (entries.length === 0) return '';

  const compactedUntil = entries[entries.length - 1]?.created_at || '';
  const durableCandidateLines = await buildDurableCandidateSummaryLines(entries);
  const lines = entries.map((entry, index) => {
    const speaker = entry.role === 'assistant' ? 'assistant' : 'user';
    const normalizedText = String(entry.content_text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const clippedText =
      normalizedText.length <= 180
        ? normalizedText
        : `${normalizedText.slice(0, 180)}...[truncated]`;
    return `${index + 1}. [${speaker}] ${entry.created_at} ${clippedText}`;
  });

  return [
    `Earlier conversation summary (${entries.length} messages through ${compactedUntil}):`,
    '',
    'Key durable candidates:',
    ...durableCandidateLines,
    '',
    'Compressed transcript:',
    ...lines,
  ].join('\n');
}

export async function storeContextCompaction(record: ContextCompactionRecord): Promise<void> {
  await dba.prepare(
    `
      INSERT OR REPLACE INTO context_compactions (
        id,
        group_folder,
        chat_jid,
        compacted_until,
        summary_text,
        source_entry_ids_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.compacted_until,
    record.summary_text,
    record.source_entry_ids_json,
    record.created_at,
  );
}

export async function getLatestContextCompaction(
  chatJid: string,
): Promise<ContextCompactionRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          compacted_until,
          summary_text,
          source_entry_ids_json,
          created_at
        FROM context_compactions
        WHERE chat_jid = ?
        ORDER BY created_at DESC, compacted_until DESC
        LIMIT 1
      `,
    )
    .get(chatJid) as ContextCompactionRecord | undefined;
}

export async function listContextCompactions(
  chatJid: string,
  limit = 20,
): Promise<ContextCompactionRecord[]> {
  return await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          compacted_until,
          summary_text,
          source_entry_ids_json,
          created_at
        FROM context_compactions
        WHERE chat_jid = ?
        ORDER BY created_at DESC, compacted_until DESC
        LIMIT ?
      `,
    )
    .all(chatJid, limit) as ContextCompactionRecord[];
}

export async function compactContextEntries(input: {
  chatJid: string;
  triggerEntries: number;
  keepRecentEntries: number;
}): Promise<ContextCompactionRecord | null> {
  const triggerEntries = Math.max(1, Math.floor(input.triggerEntries || 0));
  const keepRecentEntries = Math.max(
    1,
    Math.floor(input.keepRecentEntries || 0),
  );
  const eligibleEntries = await getCompactionEligibleContextEntries(input.chatJid);

  if (eligibleEntries.length <= triggerEntries) {
    return null;
  }

  const compactedEntries = eligibleEntries.slice(0, -keepRecentEntries);
  if (compactedEntries.length === 0) {
    return null;
  }

  const sourceEntryIdsJson = JSON.stringify(
    compactedEntries.map((entry) => entry.id),
  );
  const latest = await getLatestContextCompaction(input.chatJid);
  if (latest?.source_entry_ids_json === sourceEntryIdsJson) {
    return latest;
  }

  const compactedUntil =
    compactedEntries[compactedEntries.length - 1]?.created_at || '';
  const groupFolder = compactedEntries[0]?.group_folder || '';
  const createdAt = new Date().toISOString();
  const record: ContextCompactionRecord = {
    id: `context_compaction:${input.chatJid}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    group_folder: groupFolder,
    chat_jid: input.chatJid,
    compacted_until: compactedUntil,
    summary_text: await buildDeterministicContextCompactionSummary(compactedEntries),
    source_entry_ids_json: sourceEntryIdsJson,
    created_at: createdAt,
  };

  await storeContextCompaction(record);
  return record;
}

export async function enqueueContextCompactionJob(input: {
  chatJid: string;
  groupFolder: string;
  now?: string;
}): Promise<void> {
  const now = input.now || new Date().toISOString();
  await dba.prepare(
    `
      INSERT INTO context_compaction_jobs (
        chat_jid,
        group_folder,
        requested_at,
        available_at,
        pending,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        group_folder = excluded.group_folder,
        requested_at = excluded.requested_at,
        pending = 1,
        updated_at = excluded.updated_at
    `,
  ).run(input.chatJid, input.groupFolder, now, now, now);
}

export async function getDueContextCompactionJobs(options?: {
  limit?: number;
  now?: string;
}): Promise<ContextCompactionJobRecord[]> {
  const now = options?.now || new Date().toISOString();
  const limit = Math.max(1, Math.floor(options?.limit || 20));
  const leaseCutoff = new Date(
    new Date(now).getTime() - CONTEXT_COMPACTION_JOB_LEASE_MS,
  ).toISOString();
  return await dba
    .prepare(
      `
        SELECT
          chat_jid,
          group_folder,
          requested_at,
          available_at,
          pending,
          runtime_claimed_at,
          last_started_at,
          last_finished_at,
          last_success_at,
          last_error_at,
          last_duration_ms,
          last_error,
          run_count,
          failure_count,
          updated_at
        FROM context_compaction_jobs
        WHERE pending = 1
          AND available_at <= ?
          AND (runtime_claimed_at IS NULL OR runtime_claimed_at <= ?)
        ORDER BY requested_at ASC
        LIMIT ?
      `,
    )
    .all(now, leaseCutoff, limit) as ContextCompactionJobRecord[];
}

export async function claimContextCompactionJob(
  chatJid: string,
  options?: { now?: string },
): Promise<boolean> {
  const now = options?.now || new Date().toISOString();
  const leaseCutoff = new Date(
    new Date(now).getTime() - CONTEXT_COMPACTION_JOB_LEASE_MS,
  ).toISOString();
  const result = await dba
    .prepare(
      `
        UPDATE context_compaction_jobs
        SET pending = 0,
            runtime_claimed_at = ?,
            last_started_at = ?,
            updated_at = ?
        WHERE chat_jid = ?
          AND pending = 1
          AND available_at <= ?
          AND (runtime_claimed_at IS NULL OR runtime_claimed_at <= ?)
      `,
    )
    .run(now, now, now, chatJid, now, leaseCutoff);
  return result.changes > 0;
}

async function logContextCompactionRun(input: {
  chatJid: string;
  groupFolder: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'success' | 'error';
  resultSummaryId?: string | null;
  error?: string | null;
}): Promise<void> {
  await dba.prepare(
    `
      INSERT INTO context_compaction_run_logs (
        chat_jid,
        group_folder,
        started_at,
        finished_at,
        duration_ms,
        status,
        result_summary_id,
        error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.chatJid,
    input.groupFolder,
    input.startedAt,
    input.finishedAt,
    input.durationMs,
    input.status,
    input.resultSummaryId || null,
    input.error || null,
  );
}

export async function completeContextCompactionJobSuccess(input: {
  chatJid: string;
  groupFolder: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  resultSummaryId?: string | null;
}): Promise<void> {
  await dba.prepare(
    `
      UPDATE context_compaction_jobs
      SET group_folder = ?,
          runtime_claimed_at = NULL,
          last_finished_at = ?,
          last_success_at = ?,
          last_duration_ms = ?,
          last_error = NULL,
          run_count = run_count + 1,
          updated_at = ?
      WHERE chat_jid = ?
    `,
  ).run(
    input.groupFolder,
    input.finishedAt,
    input.finishedAt,
    input.durationMs,
    input.finishedAt,
    input.chatJid,
  );
  logContextCompactionRun({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    status: 'success',
    resultSummaryId: input.resultSummaryId || null,
  }).catch((err) => {
    logger.debug({ err, chatJid: input.chatJid }, 'Failed to log context compaction success');
  });
}

export async function completeContextCompactionJobFailure(input: {
  chatJid: string;
  groupFolder: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error: string;
  retryAt: string;
}): Promise<void> {
  await dba.prepare(
    `
      UPDATE context_compaction_jobs
      SET group_folder = ?,
          pending = 1,
          available_at = ?,
          runtime_claimed_at = NULL,
          last_finished_at = ?,
          last_error_at = ?,
          last_duration_ms = ?,
          last_error = ?,
          run_count = run_count + 1,
          failure_count = failure_count + 1,
          updated_at = ?
      WHERE chat_jid = ?
    `,
  ).run(
    input.groupFolder,
    input.retryAt,
    input.finishedAt,
    input.finishedAt,
    input.durationMs,
    input.error,
    input.finishedAt,
    input.chatJid,
  );
  logContextCompactionRun({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    status: 'error',
    error: input.error,
  }).catch((err) => {
    logger.debug({ err, chatJid: input.chatJid }, 'Failed to log context compaction failure');
  });
}

export async function getContextCompactionJob(
  chatJid: string,
): Promise<ContextCompactionJobRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT
          chat_jid,
          group_folder,
          requested_at,
          available_at,
          pending,
          runtime_claimed_at,
          last_started_at,
          last_finished_at,
          last_success_at,
          last_error_at,
          last_duration_ms,
          last_error,
          run_count,
          failure_count,
          updated_at
        FROM context_compaction_jobs
        WHERE chat_jid = ?
      `,
    )
    .get(chatJid) as ContextCompactionJobRecord | undefined;
}

export async function getMemoryLedgerStats(options?: {
  now?: Date;
}): Promise<MemoryLedgerStatsSnapshot> {
  const cutoff = new Date(
    (options?.now || new Date()).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const summary = await dba
    .prepare(
      `
        SELECT
          COUNT(*) AS total_entries,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent_entries_24h,
          MAX(created_at) AS last_entry_at
        FROM context_entries
      `,
    )
    .get(cutoff) as
    | {
        total_entries: number | null;
        recent_entries_24h: number | null;
        last_entry_at: string | null;
      }
    | undefined;
  const rows = await dba
    .prepare(
      `
        SELECT source_type, COUNT(*) AS entry_count
        FROM context_entries
        GROUP BY source_type
      `,
    )
    .all() as Array<{ source_type: string; entry_count: number }>;

  return {
    totalEntries: summary?.total_entries || 0,
    recentEntries24h: summary?.recent_entries_24h || 0,
    lastEntryAt: summary?.last_entry_at || null,
    bySourceType: Object.fromEntries(
      rows.map((row) => [row.source_type, row.entry_count]),
    ),
  };
}

function buildMemoryCompactionLatestSnapshot(
  record: ContextCompactionRecord | undefined,
): MemoryCompactionLatestSnapshot | null {
  if (!record) return null;
  let sourceEntryCount = 0;
  try {
    const parsed = JSON.parse(record.source_entry_ids_json) as unknown;
    if (Array.isArray(parsed)) {
      sourceEntryCount = parsed.filter(
        (value) => typeof value === 'string',
      ).length;
    }
  } catch {
    sourceEntryCount = 0;
  }
  return {
    id: record.id,
    chatJid: record.chat_jid,
    groupFolder: record.group_folder,
    compactedUntil: record.compacted_until,
    createdAt: record.created_at,
    sourceEntryCount,
    summaryPreview: record.summary_text.split('\n')[0] || '',
  };
}

async function getMemoryCompactionWorkerStats(options?: {
  now?: Date;
}): Promise<MemoryCompactionWorkerSnapshot> {
  const now = (options?.now || new Date()).toISOString();
  const cutoff = new Date(
    new Date(now).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const leaseCutoff = new Date(
    new Date(now).getTime() - CONTEXT_COMPACTION_JOB_LEASE_MS,
  ).toISOString();
  const jobs = await dba
    .prepare(
      `
        SELECT
          SUM(CASE WHEN pending = 1 THEN 1 ELSE 0 END) AS pending_jobs,
          SUM(
            CASE
              WHEN runtime_claimed_at IS NOT NULL AND runtime_claimed_at > ?
              THEN 1
              ELSE 0
            END
          ) AS running_jobs,
          MAX(last_success_at) AS last_success_at,
          MAX(last_error_at) AS last_failure_at
        FROM context_compaction_jobs
      `,
    )
    .get(leaseCutoff) as
    | {
        pending_jobs: number | null;
        running_jobs: number | null;
        last_success_at: string | null;
        last_failure_at: string | null;
      }
    | undefined;
  const runs = await dba
    .prepare(
      `
        SELECT
          COUNT(*) AS recent_runs_24h,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS recent_failures_24h,
          AVG(duration_ms) AS average_duration_ms_24h
        FROM context_compaction_run_logs
        WHERE finished_at >= ?
      `,
    )
    .get(cutoff) as
    | {
        recent_runs_24h: number | null;
        recent_failures_24h: number | null;
        average_duration_ms_24h: number | null;
      }
    | undefined;
  const latestRun = await dba
    .prepare(
      `
        SELECT finished_at, duration_ms, status, error
        FROM context_compaction_run_logs
        ORDER BY finished_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get() as
    | {
        finished_at: string;
        duration_ms: number;
        status: 'success' | 'error';
        error: string | null;
      }
    | undefined;

  return {
    pendingJobs: jobs?.pending_jobs || 0,
    runningJobs: jobs?.running_jobs || 0,
    recentRuns24h: runs?.recent_runs_24h || 0,
    recentFailures24h: runs?.recent_failures_24h || 0,
    averageDurationMs24h:
      runs?.average_duration_ms_24h === null ||
      runs?.average_duration_ms_24h === undefined
        ? null
        : Math.round(runs.average_duration_ms_24h),
    lastRunAt: latestRun?.finished_at || null,
    lastSuccessAt: jobs?.last_success_at || null,
    lastFailureAt: jobs?.last_failure_at || null,
    lastDurationMs:
      typeof latestRun?.duration_ms === 'number' ? latestRun.duration_ms : null,
    lastError: latestRun?.status === 'error' ? latestRun.error || '' : null,
  };
}

export async function getMemoryCompactionStats(options?: {
  now?: Date;
}): Promise<MemoryCompactionStatsSnapshot> {
  const cutoff = new Date(
    (options?.now || new Date()).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const summary = await dba
    .prepare(
      `
        SELECT
          COUNT(*) AS total_compactions,
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent_compactions_24h
        FROM context_compactions
      `,
    )
    .get(cutoff) as
    | {
        total_compactions: number | null;
        recent_compactions_24h: number | null;
      }
    | undefined;
  const latest = await dba
    .prepare(
      `
        SELECT
          id,
          group_folder,
          chat_jid,
          compacted_until,
          summary_text,
          source_entry_ids_json,
          created_at
        FROM context_compactions
        ORDER BY created_at DESC, compacted_until DESC
        LIMIT 1
      `,
    )
    .get() as ContextCompactionRecord | undefined;

  return {
    totalCompactions: summary?.total_compactions || 0,
    recentCompactions24h: summary?.recent_compactions_24h || 0,
    latest: buildMemoryCompactionLatestSnapshot(latest),
    worker: await getMemoryCompactionWorkerStats(options),
  };
}

export async function getMemoryPromotionStats(options?: {
  now?: Date;
}): Promise<MemoryPromotionStatsSnapshot> {
  const cutoff = new Date(
    (options?.now || new Date()).getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const rows = await dba
    .prepare(
      `
        SELECT content_json, created_at
        FROM context_entries
        WHERE source_type = 'memory_promotion'
          AND created_at >= ?
      `,
    )
    .all(cutoff) as Array<{
    content_json: string | null;
    created_at: string;
  }>;
  let candidates24h = 0;
  let writes24h = 0;
  let deduped24h = 0;
  let latestPromotionAt: string | null = null;
  const byOrigin24h: Record<string, number> = {};
  const byAction24h: MemoryPromotionStatsSnapshot['byAction24h'] = {
    auto: 0,
    remember: 0,
    session_only: 0,
  };
  const byMemoryClass24h: MemoryPromotionStatsSnapshot['byMemoryClass24h'] = {
    identity: 0,
    global_durable: 0,
    group_durable: 0,
    session: 0,
    unknown: 0,
  };

  for (const row of rows) {
    let status = 'candidate';
    let origin = 'unknown';
    let action: 'auto' | 'remember' | 'session_only' = 'auto';
    let memoryClass: keyof typeof byMemoryClass24h = 'unknown';
    try {
      const parsed = row.content_json
        ? (JSON.parse(row.content_json) as {
            status?: string;
            origin?: string;
            action?: string;
            memoryClass?: string;
          })
        : null;
      if (parsed?.status) {
        status = parsed.status;
      }
      if (parsed?.origin) {
        origin = parsed.origin;
      }
      if (
        parsed?.action === 'auto' ||
        parsed?.action === 'remember' ||
        parsed?.action === 'session_only'
      ) {
        action = parsed.action;
      }
      if (
        parsed?.memoryClass === 'identity' ||
        parsed?.memoryClass === 'global_durable' ||
        parsed?.memoryClass === 'group_durable' ||
        parsed?.memoryClass === 'session'
      ) {
        memoryClass = parsed.memoryClass;
      }
    } catch {
      status = 'candidate';
    }
    if (status === 'candidate') candidates24h += 1;
    if (status === 'written') writes24h += 1;
    if (status === 'deduped') deduped24h += 1;
    byOrigin24h[origin] = (byOrigin24h[origin] || 0) + 1;
    byAction24h[action] += 1;
    byMemoryClass24h[memoryClass] += 1;
    if (!latestPromotionAt || row.created_at > latestPromotionAt) {
      latestPromotionAt = row.created_at;
    }
  }

  return {
    candidates24h,
    writes24h,
    deduped24h,
    latestPromotionAt,
    byOrigin24h,
    byAction24h,
    byMemoryClass24h,
  };
}

function normalizeMemoryNotes(notes: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const note of notes) {
    const value = normalizeMemoryText(note);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeIdentityAliases(
  aliases: Array<{
    channel?: string | null;
    externalUserId?: string | null;
    displayName?: string | null;
  }>,
): Array<{
  channel: string | null;
  externalUserId: string | null;
  displayName: string | null;
}> {
  const seen = new Set<string>();
  const normalized: Array<{
    channel: string | null;
    externalUserId: string | null;
    displayName: string | null;
  }> = [];
  for (const alias of aliases) {
    const entry = {
      channel: normalizeMemoryText(alias.channel || '').toLowerCase() || null,
      externalUserId: normalizeMemoryText(alias.externalUserId || '') || null,
      displayName: normalizeMemoryText(alias.displayName || '') || null,
    };
    if (!entry.channel && !entry.externalUserId && !entry.displayName) {
      continue;
    }
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return normalized;
}

export async function createPersonProfile(input: {
  id: string;
  displayName: string;
  notes: string[];
  aliases?: Array<{
    channel?: string | null;
    externalUserId?: string | null;
    displayName?: string | null;
  }>;
  createdAt?: string;
  updatedAt?: string;
}): Promise<PersonProfileRecord> {
  const id = normalizeMemoryText(input.id);
  const displayName = normalizeMemoryText(input.displayName);
  if (!id) {
    throw new Error('person profile id is required');
  }
  if (!displayName) {
    throw new Error('person profile displayName is required');
  }

  const existing = await getPersonProfile(id);
  const now = input.updatedAt || new Date().toISOString();
  const createdAt = existing?.created_at || input.createdAt || now;
  const notesJson = JSON.stringify(normalizeMemoryNotes(input.notes || []));
  const aliases = await normalizeIdentityAliases(input.aliases || []);

  const tx = dba.transaction(async () => {
    await dba.prepare(
      `
        INSERT INTO person_profiles (
          id,
          display_name,
          notes_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          notes_json = excluded.notes_json,
          updated_at = excluded.updated_at
      `,
    ).run(id, displayName, notesJson, createdAt, now);

    await dba.prepare(`DELETE FROM identity_aliases WHERE person_id = ?`).run(id);
    for (const alias of aliases) {
      await dba.prepare(
        `INSERT INTO identity_aliases (person_id, channel, external_user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, alias.channel, alias.externalUserId, alias.displayName, now);
    }
    await upsertMemoryDocuments([
      buildIdentityMemoryDocumentRecord({
        personId: id,
        displayName,
        notes: normalizeMemoryNotes(input.notes || []),
        aliases,
        updatedAt: now,
      }),
    ]);
  });
  await tx();

  const created = await getPersonProfile(id);
  if (!created) {
    throw new Error(`Failed to persist person profile: ${id}`);
  }
  const pathRef = `global:memory/identity/${id}.md`;
  await deleteMemoryDocumentsByPathRefs([pathRef]);
  await deleteMemoryDocumentSyncStates([pathRef]);
  await upsertMemoryDocuments([
    buildIdentityMemoryDocumentRecord({
      personId: created.id,
      displayName: created.display_name,
      notes: JSON.parse(created.notes_json || '[]') as string[],
      aliases: (await listIdentityAliases(created.id)).map((alias) => ({
        channel: alias.channel,
        externalUserId: alias.external_user_id,
        displayName: alias.display_name,
      })),
      updatedAt: created.updated_at,
    }),
  ]);
  return created;
}

export async function updatePersonProfile(input: {
  id: string;
  displayName?: string;
  notes?: string[];
  aliases?: Array<{
    channel?: string | null;
    externalUserId?: string | null;
    displayName?: string | null;
  }>;
  updatedAt?: string;
}): Promise<PersonProfileRecord> {
  const existing = await getPersonProfile(input.id);
  if (!existing) {
    throw new Error(`Person profile not found: ${input.id}`);
  }
  return createPersonProfile({
    id: existing.id,
    displayName: input.displayName || existing.display_name,
    notes:
      input.notes ||
      (JSON.parse(existing.notes_json || '[]') as string[]).filter(
        (value): value is string => typeof value === 'string',
      ),
    aliases:
      input.aliases ||
      (await listIdentityAliases(existing.id)).map((alias) => ({
        channel: alias.channel,
        externalUserId: alias.external_user_id,
        displayName: alias.display_name,
      })),
    createdAt: existing.created_at,
    updatedAt: input.updatedAt,
  });
}

export async function listPersonProfiles(): Promise<PersonProfileRecord[]> {
  return await dba
    .prepare(
      `
        SELECT id, display_name, notes_json, created_at, updated_at
        FROM person_profiles
        ORDER BY updated_at DESC, display_name COLLATE NOCASE ASC, id ASC
      `,
    )
    .all() as PersonProfileRecord[];
}

export async function getPersonProfile(id: string): Promise<PersonProfileRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT id, display_name, notes_json, created_at, updated_at
        FROM person_profiles
        WHERE id = ?
      `,
    )
    .get(id) as PersonProfileRecord | undefined;
}

export async function listIdentityAliases(personId: string): Promise<IdentityAliasRecord[]> {
  return await dba
    .prepare(
      `
        SELECT id, person_id, channel, external_user_id, display_name, created_at
        FROM identity_aliases
        WHERE person_id = ?
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(personId) as IdentityAliasRecord[];
}

export async function bindConversationIdentity(input: {
  chatJid: string;
  groupFolder: string;
  personId: string;
  boundAt?: string;
}): Promise<ConversationIdentityBindingRecord> {
  const boundAt = input.boundAt || new Date().toISOString();
  await dba.prepare(
    `
      INSERT INTO conversation_identity_bindings (
        chat_jid,
        group_folder,
        person_id,
        bound_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        group_folder = excluded.group_folder,
        person_id = excluded.person_id,
        bound_at = excluded.bound_at
    `,
  ).run(input.chatJid, input.groupFolder, input.personId, boundAt);
  return (await getConversationIdentityBinding(input.chatJid))!;
}

export async function getConversationIdentityBinding(
  chatJid: string,
): Promise<ConversationIdentityBindingRecord | undefined> {
  return await dba
    .prepare(
      `
        SELECT chat_jid, group_folder, person_id, bound_at
        FROM conversation_identity_bindings
        WHERE chat_jid = ?
      `,
    )
    .get(chatJid) as ConversationIdentityBindingRecord | undefined;
}

export async function listConversationIdentityBindingsForPerson(
  personId: string,
): Promise<ConversationIdentityBindingRecord[]> {
  return await dba
    .prepare(
      `
        SELECT chat_jid, group_folder, person_id, bound_at
        FROM conversation_identity_bindings
        WHERE person_id = ?
        ORDER BY bound_at DESC, chat_jid ASC
      `,
    )
    .all(personId) as ConversationIdentityBindingRecord[];
}

export async function getConversationTurns(
  jid: string,
  limit = 200,
  offset = 0,
  cursor?: { before?: string },
): Promise<PersistedAssistantTurn[]> {
  // Cursor mode: newest-first DESC, bypasses turnCache (same rationale as messages).
  if (cursor !== undefined) {
    const conditions = ['chat_jid = ?'];
    const params: unknown[] = [jid];
    if (cursor.before) {
      conditions.push('timestamp < ?');
      params.push(cursor.before);
    }
    params.push(limit);
    const sql = `SELECT payload FROM assistant_turns WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`;
    const rows = await dba.prepare(sql).all(...params) as Array<{ payload: string }>;
    const turns: PersistedAssistantTurn[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as PersistedAssistantTurn;
        if (parsed && typeof parsed.id === 'string') turns.push(parsed);
      } catch { /* ignore corrupted turn payload */ }
    }
    return turns;
  }

  const cacheKey = `${jid}:${limit}:${offset}`;
  const now = Date.now();
  const cached = turnCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  const rows = await dba
    .prepare(
      `
    SELECT payload
    FROM assistant_turns
    WHERE chat_jid = ?
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `,
    )
    .all(jid, limit, offset) as Array<{ payload: string }>;

  const turns: PersistedAssistantTurn[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as PersistedAssistantTurn;
      if (parsed && typeof parsed.id === 'string') {
        turns.push(parsed);
      }
    } catch {
      /* ignore corrupted turn payload */
    }
  }

  if (turnCache.size >= TURN_CACHE_MAX_ENTRIES) {
    const oldest = turnCache.keys().next().value;
    if (oldest !== undefined) turnCache.delete(oldest);
  }
  turnCache.set(cacheKey, { data: turns, expiresAt: now + TURN_CACHE_TTL_MS });
  return turns;
}

/**
 * System-level message poller — intentionally unscoped by user_id.
 * Tenant isolation is enforced by the registered JID set (only groups owned
 * by the current tenant are registered). Callers must not expose results
 * across tenant boundaries.
 */
export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, client_id, run_id, is_from_me
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND sender != 'web_command'
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = await dba
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

/**
 * System-level recovery query — intentionally unscoped by user_id.
 * Called from startup recovery and message loop; JID ownership is validated
 * by the registered group set.
 */
export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): Promise<NewMessage[]> {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, client_id, run_id, is_from_me
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND sender != 'web_command'
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return await dba
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

/**
 * System-level check — intentionally unscoped by user_id.
 * Used for dispatch suppression; JID is already validated by the caller.
 */
export async function hasBotReplyAfter(
  chatJid: string,
  sinceTimestamp: string,
): Promise<boolean> {
  const row = await dba
    .prepare(
      `
      SELECT 1
      FROM messages
      WHERE chat_jid = ?
        AND timestamp > ?
        AND is_bot_message = 1
      LIMIT 1
    `,
    )
    .get(chatJid, sinceTimestamp);
  return !!row;
}


export async function deleteConversationMessages(jid: string): Promise<void> {
  await dba.transaction(async () => {
    await dba.prepare('DELETE FROM assistant_turns WHERE chat_jid = ?').run(jid);
    await dba.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
  })();
}

async function deleteConversationForeignKeyDependents(jid: string): Promise<void> {
  await dba.prepare('DELETE FROM context_compaction_run_logs WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM context_compaction_jobs WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM context_compactions WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM conversation_identity_bindings WHERE chat_jid = ?').run(
    jid,
  );
  await dba.prepare('DELETE FROM context_entries WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM conversation_participants WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM assistant_turns WHERE chat_jid = ?').run(jid);
  await dba.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
}

export async function deleteConversation(jid: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const updatedBy = getCurrentUserId();
  await dba.transaction(async () => {
    await deleteConversationForeignKeyDependents(jid);
    await dba.prepare(
      'DELETE FROM sessions WHERE group_folder IN (SELECT folder FROM registered_groups WHERE jid = ? AND deleted_at IS NULL)',
    ).run(jid);
    await dba
      .prepare(
        'UPDATE chats SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE jid = ? AND deleted_at IS NULL',
      )
      .run(nowIso, nowIso, updatedBy, jid);
  })();
}

export async function deleteRegisteredGroup(jid: string): Promise<void> {
  const ts = new Date().toISOString();
  await dba
    .prepare(
      'UPDATE registered_groups SET deleted_at = ?, updated_at = ? WHERE jid = ? AND deleted_at IS NULL',
    )
    .run(ts, ts, jid);
}

export async function updateRegisteredGroupAgentConfig(
  jid: string,
  agentConfig: RegisteredGroup['agentConfig'],
): Promise<void> {
  const current = await getRegisteredGroup(jid);
  if (!current) {
    throw new Error(`Registered group not found: ${jid}`);
  }
  await setRegisteredGroup(jid, {
    ...current,
    agentConfig,
  });
}

export interface StaleRegisteredGroup {
  jid: string;
  name: string;
  folder: string;
}

export async function getActiveRegisteredGroupFolders(): Promise<string[]> {
  const rows = await dba
    .prepare(
      `SELECT rg.folder
       FROM registered_groups rg
       LEFT JOIN chats c ON c.jid = rg.jid AND c.deleted_at IS NULL
       WHERE rg.deleted_at IS NULL AND (rg.is_main = 1 OR c.jid IS NOT NULL)`,
    )
    .all() as Array<{ folder: string }>;
  return rows.map((row) => row.folder);
}

export async function getStaleRegisteredGroups(): Promise<StaleRegisteredGroup[]> {
  return await dba
    .prepare(
      `SELECT rg.jid, rg.name, rg.folder
       FROM registered_groups rg
       LEFT JOIN chats c ON c.jid = rg.jid AND c.deleted_at IS NULL
       WHERE rg.deleted_at IS NULL AND COALESCE(rg.is_main, 0) = 0 AND c.jid IS NULL
       ORDER BY rg.added_at ASC`,
    )
    .all() as StaleRegisteredGroup[];
}

export async function deleteSessionByJid(jid: string): Promise<void> {
  await dba.prepare(
    'DELETE FROM sessions WHERE group_folder IN (SELECT folder FROM registered_groups WHERE jid = ? AND deleted_at IS NULL)',
  ).run(jid);
}

// ── Enhanced conversation queries ──

export interface ConversationSummary {
  jid: string;
  name: string;
  custom_title: string | null;
  display_name: string;
  channel: string;
  is_group: number;
  is_pinned: number;
  is_favorite: number;
  last_message_time: string;
  last_message: string;
  unread_count: number;
  assistant_id: string | null;
  assistant_name: string | null;
  assistant_provider_id: string | null;
  assistant_provider_alias: string | null;
  assistant_model: string | null;
  mode: string | null;
  conversation_provider_id: string | null;
  conversation_provider_alias: string | null;
  conversation_model: string | null;
}

function buildConversationSummarySql(whereClause: string, limitClause = ''): string {
  const activeDialect = eng().dialect;
  const providerIdExpr = dialect.jsonExtract(
    activeDialect,
    'a.config_json',
    '$.providerId',
  );
  const modelExpr = dialect.jsonExtract(
    activeDialect,
    'a.config_json',
    '$.model',
  );
  const latestMessageTieBreak = dialect.rowIdOrder(activeDialect, 'm', 'id');

  return `
    SELECT
      c.jid,
      COALESCE(c.name, c.jid) as name,
      c.custom_title,
      COALESCE(NULLIF(c.custom_title, ''), c.name, c.jid) as display_name,
      COALESCE(c.channel, '') as channel,
      c.is_group,
      COALESCE(c.is_pinned, 0) as is_pinned,
      COALESCE(c.is_favorite, 0) as is_favorite,
      c.mode,
      c.last_message_time,
      COALESCE(
        (
          SELECT m.content
          FROM messages m
          WHERE m.chat_jid = c.jid
          ORDER BY m.timestamp DESC, ${latestMessageTieBreak}
          LIMIT 1
        ),
        ''
      ) as last_message,
      0 as unread_count,
      rg.assistant_id,
      a.name as assistant_name,
      ${providerIdExpr} as assistant_provider_id,
      p.alias as assistant_provider_alias,
      ${modelExpr} as assistant_model,
      rg.provider_id as conversation_provider_id,
      cp.alias as conversation_provider_alias,
      rg.model as conversation_model
    FROM chats c
    LEFT JOIN registered_groups rg ON rg.jid = c.jid AND rg.deleted_at IS NULL
    LEFT JOIN assistants a ON a.id = rg.assistant_id
    LEFT JOIN ai_providers p
      ON p.id = ${providerIdExpr}
    LEFT JOIN ai_providers cp
      ON cp.id = rg.provider_id
    ${whereClause}
    AND c.deleted_at IS NULL
    ORDER BY COALESCE(c.is_pinned, 0) DESC, c.last_message_time DESC
    ${limitClause}
  `;
}

/**
 * Tenant visibility predicate: user's own chats, non-review-bound system
 * chats, and review-bound chats where the user is a repo member.
 * Requires 7 positional params: (userId, systemUserId, userId, userId, nowIso, userId, nowIso).
 */
function buildTenantVisibilityPredicate(tablePrefix = 'c.'): string {
  const p = tablePrefix;
  return `(
    ${p}user_id = ?
    OR (${p}user_id = ? AND NOT EXISTS (
      SELECT 1 FROM review_conversation_bindings rcb WHERE rcb.chat_jid = ${p}jid
    ))
    OR EXISTS (
      SELECT 1 FROM review_conversation_bindings rcb
      JOIN review_repository_members rrm ON rcb.repository_id = rrm.repository_id
      WHERE rcb.chat_jid = ${p}jid AND rrm.user_id = ?
    )
    OR EXISTS (
      SELECT 1 FROM resource_access ra
      WHERE ra.resource_type = 'conversation' AND ra.resource_id = ${p}jid AND ra.user_id = ?
      AND (ra.expires_at IS NULL OR ra.expires_at > ?)
    )
    OR EXISTS (
      SELECT 1 FROM review_conversation_bindings rcb2
      JOIN resource_access ra2 ON ra2.resource_type = 'review_repository' AND ra2.resource_id = rcb2.repository_id
      WHERE rcb2.chat_jid = ${p}jid AND ra2.user_id = ?
      AND (ra2.expires_at IS NULL OR ra2.expires_at > ?)
    )
  )`;
}

export async function getConversationList(userId?: string): Promise<ConversationSummary[]> {
  if (userId && userId !== SYSTEM_USER_ID) {
    const nowIso = new Date().toISOString();
    const where = `WHERE c.jid != '__group_sync__' AND ${buildHiddenConversationChannelPredicate()} AND ${buildTenantVisibilityPredicate()}`;
    const rows = await dba
      .prepare(buildConversationSummarySql(where))
      .all(...HIDDEN_CONVERSATION_CHANNELS, userId, SYSTEM_USER_ID, userId, userId, nowIso, userId, nowIso) as ConversationSummary[];
    return rows;
  }
  return await dba
    .prepare(buildConversationSummarySql(`WHERE c.jid != '__group_sync__' AND ${buildHiddenConversationChannelPredicate()}`))
    .all(...HIDDEN_CONVERSATION_CHANNELS) as ConversationSummary[];
}

export async function getConversationSummaryByJid(
  jid: string,
): Promise<ConversationSummary | undefined> {
  return await dba
    .prepare(buildConversationSummarySql('WHERE c.jid = ?', 'LIMIT 1'))
    .get(jid) as ConversationSummary | undefined;
}

export async function getConversationListByAssistantId(
  assistantId: string,
  userId?: string,
): Promise<ConversationSummary[]> {
  const assistantClause = `WHERE c.jid != '__group_sync__' AND rg.assistant_id = ?`;
  if (userId && userId !== SYSTEM_USER_ID) {
    const nowIso = new Date().toISOString();
    return (await dba
      .prepare(
        buildConversationSummarySql(
          `${assistantClause} AND ${buildTenantVisibilityPredicate()}`,
        ),
      )
      .all(assistantId, userId, SYSTEM_USER_ID, userId, userId, nowIso, userId, nowIso)) as ConversationSummary[];
  }
  return (await dba
    .prepare(buildConversationSummarySql(assistantClause))
    .all(assistantId)) as ConversationSummary[];
}

export async function getConversationDisplayNames(
  chatJids: string[],
  userId?: string,
): Promise<Record<string, string>> {
  if (chatJids.length === 0) return {};
  const placeholders = createPlaceholders(chatJids.length);
  const tenantFilter = userId && userId !== SYSTEM_USER_ID;
  const nowIso = new Date().toISOString();
  const rows = await dba
    .prepare(
      tenantFilter
        ? `
    SELECT
      jid,
      COALESCE(NULLIF(custom_title, ''), name, jid) as display_name
    FROM chats
    WHERE jid IN (${placeholders})
      AND deleted_at IS NULL
      AND ${buildTenantVisibilityPredicate('')}
  `
        : `
    SELECT
      jid,
      COALESCE(NULLIF(custom_title, ''), name, jid) as display_name
    FROM chats
    WHERE jid IN (${placeholders})
      AND deleted_at IS NULL
  `,
    )
    .all(
      ...(tenantFilter
        ? [...chatJids, userId, SYSTEM_USER_ID, userId, userId, nowIso, userId, nowIso]
        : chatJids),
    ) as Array<{ jid: string; display_name: string }>;

  const displayNames: Record<string, string> = {};
  for (const row of rows) {
    displayNames[row.jid] = row.display_name;
  }
  return displayNames;
}

const messageCache = new Map<string, { data: NewMessage[]; expiresAt: number }>();
const messageCntCache = new Map<string, { count: number; expiresAt: number }>();
const MSG_CACHE_TTL_MS = 2_000;
const MSG_CACHE_MAX_ENTRIES = 32;

export function invalidateMessageCache(chatJid?: string): void {
  if (chatJid) {
    for (const key of messageCache.keys()) {
      if (key.startsWith(`${chatJid}:`)) messageCache.delete(key);
    }
    messageCntCache.delete(chatJid);
  } else {
    messageCache.clear();
    messageCntCache.clear();
  }
}

export async function getConversationMessages(
  jid: string,
  limit = 50,
  offset = 0,
  userId?: string,
  cursor?: { before?: string },
): Promise<NewMessage[]> {
  const tenantFilter = userId && userId !== SYSTEM_USER_ID;

  // Cursor mode: newest-first DESC query, intentionally bypasses messageCache
  // because the web client needs real-time freshness on conversation switch.
  if (cursor !== undefined) {
    const cols = `id, chat_jid, sender, sender_name, content, uploaded_files_json, timestamp, client_id, run_id,
           is_from_me, is_bot_message`;
    const conditions = ['chat_jid = ?'];
    const params: unknown[] = [jid];
    if (tenantFilter) {
      conditions.push('(user_id = ? OR user_id = ?)');
      params.push(userId, SYSTEM_USER_ID);
    }
    if (cursor.before) {
      conditions.push('timestamp < ?');
      params.push(cursor.before);
    }
    params.push(limit);
    const sql = `SELECT ${cols} FROM messages WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`;
    const rows = await dba.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(mapConversationMessageRow);
  }

  const cacheKey = `${jid}:${limit}:${offset}:${userId ?? ''}`;
  const now = Date.now();
  const cached = messageCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  const sql = tenantFilter
    ? `
    SELECT id, chat_jid, sender, sender_name, content, uploaded_files_json, timestamp, client_id, run_id,
           is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND (user_id = ? OR user_id = ?)
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `
    : `
    SELECT id, chat_jid, sender, sender_name, content, uploaded_files_json, timestamp, client_id, run_id,
           is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp ASC
    LIMIT ? OFFSET ?
  `;
  const params = tenantFilter
    ? [jid, userId, SYSTEM_USER_ID, limit, offset]
    : [jid, limit, offset];
  const rows = await dba.prepare(sql).all(...params) as Record<string, unknown>[];
  const data = rows.map(mapConversationMessageRow);

  if (messageCache.size >= MSG_CACHE_MAX_ENTRIES) {
    const oldest = messageCache.keys().next().value;
    if (oldest !== undefined) messageCache.delete(oldest);
  }
  messageCache.set(cacheKey, { data, expiresAt: now + MSG_CACHE_TTL_MS });
  return data;
}

export async function getMessageCount(jid: string): Promise<number> {
  const now = Date.now();
  const cached = messageCntCache.get(jid);
  if (cached && cached.expiresAt > now) return cached.count;

  const row = await dba
    .prepare('SELECT COUNT(*) as count FROM messages WHERE chat_jid = ?')
    .get(jid) as { count: number };

  messageCntCache.set(jid, { count: row.count, expiresAt: now + MSG_CACHE_TTL_MS });
  return row.count;
}

export async function updateConversationMeta(
  jid: string,
  updates: {
    customTitle?: string | null;
    isPinned?: boolean;
    isFavorite?: boolean;
    mode?: string | null;
  },
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.customTitle !== undefined) {
    fields.push('custom_title = ?');
    values.push(
      updates.customTitle && updates.customTitle.trim()
        ? updates.customTitle.trim()
        : null,
    );
  }

  if (updates.isPinned !== undefined) {
    fields.push('is_pinned = ?');
    values.push(updates.isPinned ? 1 : 0);
  }

  if (updates.isFavorite !== undefined) {
    fields.push('is_favorite = ?');
    values.push(updates.isFavorite ? 1 : 0);
  }

  if (updates.mode !== undefined) {
    fields.push('mode = ?');
    values.push(updates.mode);
  }

  if (fields.length === 0) return;

  const ts = new Date().toISOString();
  const uid = getCurrentUserId();
  fields.push('updated_at = ?');
  values.push(ts);
  fields.push('updated_by = ?');
  values.push(uid);
  values.push(jid);
  await dba.prepare(
    `UPDATE chats SET ${fields.join(', ')} WHERE jid = ? AND deleted_at IS NULL`,
  ).run(...values);
}

export async function updateConversationLastMessageTime(
  jid: string,
  timestamp: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const uid = getCurrentUserId();
  await dba
    .prepare(
      `UPDATE chats
       SET last_message_time = ?, updated_at = ?, updated_by = ?
       WHERE jid = ? AND deleted_at IS NULL`,
    )
    .run(timestamp, ts, uid, jid);
}

export async function getConversationMode(jid: string): Promise<string | null> {
  const row = await dba
    .prepare('SELECT mode FROM chats WHERE jid = ? AND deleted_at IS NULL')
    .get(jid) as { mode: string | null } | undefined;
  return row?.mode ?? null;
}

export async function getConversationOwnerUserId(
  jid: string,
): Promise<string | null> {
  const row = await eng().queryOne<{ user_id?: string | null }>(
    'SELECT user_id FROM chats WHERE jid = ? AND deleted_at IS NULL',
    [jid],
  );
  const userId = typeof row?.user_id === 'string' ? row.user_id.trim() : '';
  return userId || null;
}

export async function deleteSession(groupFolder: string): Promise<void> {
  await dba.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}
