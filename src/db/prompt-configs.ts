import crypto from 'crypto';

import { getCurrentUserId } from '../tenant/tenant-context.js';
import type {
  PromptConfigRecord,
  PromptScopeKind,
  PromptTraceInput,
  PromptTraceRecord,
} from '../types/prompt.js';
import { dba } from './engine-access.js';

function mapPromptConfigRow(row: unknown): PromptConfigRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id || ''),
    scope_kind: String(record.scope_kind || 'system') as PromptScopeKind,
    owner_user_id: String(record.owner_user_id || ''),
    prompt_key: String(record.prompt_key || ''),
    feature_scope: String(record.feature_scope || ''),
    template_text: String(record.template_text || ''),
    notes: record.notes == null ? null : String(record.notes),
    created_by: String(record.created_by || ''),
    updated_by: String(record.updated_by || ''),
    created_at: String(record.created_at || ''),
    updated_at: String(record.updated_at || ''),
  };
}

function mapPromptTraceRow(row: unknown): PromptTraceRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id || ''),
    trace_kind: String(record.trace_kind || 'direct_provider') as PromptTraceRecord['trace_kind'],
    prompt_key: record.prompt_key == null ? null : String(record.prompt_key),
    feature_scope: String(record.feature_scope || ''),
    target_user_id: String(record.target_user_id || ''),
    chat_jid: record.chat_jid == null ? null : String(record.chat_jid),
    provider: record.provider == null ? null : String(record.provider),
    model: record.model == null ? null : String(record.model),
    system_prompt_text:
      record.system_prompt_text == null ? null : String(record.system_prompt_text),
    user_prompt_text: String(record.user_prompt_text || ''),
    provider_input_text:
      record.provider_input_text == null ? null : String(record.provider_input_text),
    segments_json: String(record.segments_json || '[]'),
    resolution_json: String(record.resolution_json || '[]'),
    metadata_json: record.metadata_json == null ? null : String(record.metadata_json),
    created_at: String(record.created_at || ''),
  };
}

export async function listPromptConfigs(options?: {
  scopeKind?: PromptScopeKind;
  ownerUserId?: string;
}): Promise<PromptConfigRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options?.scopeKind) {
    where.push('scope_kind = ?');
    params.push(options.scopeKind);
  }
  if (options?.ownerUserId !== undefined) {
    where.push('owner_user_id = ?');
    params.push(options.ownerUserId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = (await dba
    .prepare(
      `SELECT id, scope_kind, owner_user_id, prompt_key, feature_scope, template_text, notes, created_by, updated_by, created_at, updated_at
       FROM prompt_configs
       ${whereSql}
       ORDER BY feature_scope ASC, prompt_key ASC, scope_kind ASC, owner_user_id ASC`,
    )
    .all(...params)) as unknown[];
  return rows.map(mapPromptConfigRow);
}

export async function getPromptConfig(
  scopeKind: PromptScopeKind,
  ownerUserId: string,
  promptKey: string,
): Promise<PromptConfigRecord | null> {
  const row = await dba
    .prepare(
      `SELECT id, scope_kind, owner_user_id, prompt_key, feature_scope, template_text, notes, created_by, updated_by, created_at, updated_at
       FROM prompt_configs
       WHERE scope_kind = ? AND owner_user_id = ? AND prompt_key = ?
       LIMIT 1`,
    )
    .get(scopeKind, ownerUserId, promptKey);
  return row ? mapPromptConfigRow(row) : null;
}

export async function upsertPromptConfig(input: {
  scopeKind: PromptScopeKind;
  ownerUserId: string;
  promptKey: string;
  featureScope: string;
  templateText: string;
  notes?: string | null;
  actorUserId?: string | null;
}): Promise<PromptConfigRecord> {
  const existing = await getPromptConfig(
    input.scopeKind,
    input.ownerUserId,
    input.promptKey,
  );
  const now = new Date().toISOString();
  const actorUserId = input.actorUserId ?? getCurrentUserId();
  const record: PromptConfigRecord = {
    id: existing?.id || crypto.randomUUID(),
    scope_kind: input.scopeKind,
    owner_user_id: input.ownerUserId,
    prompt_key: input.promptKey,
    feature_scope: input.featureScope,
    template_text: input.templateText,
    notes: input.notes ?? null,
    created_by: existing?.created_by || actorUserId,
    updated_by: actorUserId,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await dba
    .prepare(
      `INSERT OR REPLACE INTO prompt_configs (
        id, scope_kind, owner_user_id, prompt_key, feature_scope, template_text, notes, created_by, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.scope_kind,
      record.owner_user_id,
      record.prompt_key,
      record.feature_scope,
      record.template_text,
      record.notes,
      record.created_by,
      record.updated_by,
      record.created_at,
      record.updated_at,
    );
  return record;
}

export async function deletePromptConfig(
  scopeKind: PromptScopeKind,
  ownerUserId: string,
  promptKey: string,
): Promise<void> {
  await dba
    .prepare(
      'DELETE FROM prompt_configs WHERE scope_kind = ? AND owner_user_id = ? AND prompt_key = ?',
    )
    .run(scopeKind, ownerUserId, promptKey);
}

export async function recordPromptTrace(input: PromptTraceInput): Promise<void> {
  const now = new Date().toISOString();
  await dba
    .prepare(
      `INSERT INTO prompt_traces (
        id, trace_kind, prompt_key, feature_scope, target_user_id, chat_jid, provider, model,
        system_prompt_text, user_prompt_text, provider_input_text, segments_json, resolution_json,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      input.traceKind,
      input.promptKey ?? null,
      input.featureScope,
      input.targetUserId ?? '',
      input.chatJid ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.systemPromptText ?? null,
      input.userPromptText,
      input.providerInputText ?? null,
      JSON.stringify(input.segments || []),
      JSON.stringify(input.resolution || []),
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    );
}

export async function listPromptTraces(options?: {
  featureScope?: string;
  promptKey?: string;
  chatJid?: string;
  targetUserId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: PromptTraceRecord[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options?.featureScope) {
    where.push('feature_scope = ?');
    params.push(options.featureScope);
  }
  if (options?.promptKey) {
    where.push('prompt_key = ?');
    params.push(options.promptKey);
  }
  if (options?.chatJid) {
    where.push('chat_jid = ?');
    params.push(options.chatJid);
  }
  if (options?.targetUserId !== undefined) {
    where.push('target_user_id = ?');
    params.push(options.targetUserId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
  const offset = Math.max(0, options?.offset ?? 0);
  const countRow = (await dba
    .prepare(`SELECT COUNT(*) AS c FROM prompt_traces ${whereSql}`)
    .get(...params)) as { c?: number | string } | undefined;
  const total = Number(countRow?.c ?? 0);
  const rows = (await dba
    .prepare(
      `SELECT id, trace_kind, prompt_key, feature_scope, target_user_id, chat_jid, provider, model,
              system_prompt_text, user_prompt_text, provider_input_text, segments_json, resolution_json,
              metadata_json, created_at
       FROM prompt_traces
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)) as unknown[];
  return { items: rows.map(mapPromptTraceRow), total };
}

export async function getPromptTraceById(id: string): Promise<PromptTraceRecord | null> {
  const row = await dba
    .prepare(
      `SELECT id, trace_kind, prompt_key, feature_scope, target_user_id, chat_jid, provider, model,
              system_prompt_text, user_prompt_text, provider_input_text, segments_json, resolution_json,
              metadata_json, created_at
       FROM prompt_traces
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id);
  return row ? mapPromptTraceRow(row) : null;
}
