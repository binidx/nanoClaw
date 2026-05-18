import crypto from 'crypto';

import type {
  ConversationTavernBindingRecord,
  TavernPersonaRecord,
} from '../types.js';
import { dba } from './engine-access.js';

function generateId(): string {
  return crypto.randomUUID();
}

export interface UpsertTavernPersonaInput {
  name: string;
  avatarPath?: string | null;
  summary?: string | null;
  personalityPrompt?: string | null;
  scenario?: string | null;
  firstMessage?: string | null;
  alternateGreetingsJson?: string | null;
  exampleDialogues?: string | null;
  systemPrompt?: string | null;
  creatorNotes?: string | null;
  tagsJson?: string | null;
  enabled?: boolean;
}

function nullableTrimmed(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

export async function listTavernPersonas(
  userId: string,
): Promise<TavernPersonaRecord[]> {
  return (await dba
    .prepare(
      `SELECT *
       FROM tavern_personas
       WHERE user_id = ?
       ORDER BY updated_at DESC, created_at DESC, id ASC`,
    )
    .all(userId)) as TavernPersonaRecord[];
}

export async function getTavernPersonaById(
  id: string,
  userId?: string,
): Promise<TavernPersonaRecord | undefined> {
  if (userId) {
    return (await dba
      .prepare(`SELECT * FROM tavern_personas WHERE id = ? AND user_id = ? LIMIT 1`)
      .get(id, userId)) as TavernPersonaRecord | undefined;
  }
  return (await dba
    .prepare(`SELECT * FROM tavern_personas WHERE id = ? LIMIT 1`)
    .get(id)) as TavernPersonaRecord | undefined;
}

export async function createTavernPersona(
  userId: string,
  input: UpsertTavernPersonaInput,
): Promise<TavernPersonaRecord> {
  const now = new Date().toISOString();
  const record: TavernPersonaRecord = {
    id: generateId(),
    user_id: userId,
    name: input.name.trim(),
    avatar_path: nullableTrimmed(input.avatarPath),
    summary: nullableTrimmed(input.summary),
    personality_prompt: nullableTrimmed(input.personalityPrompt),
    scenario: nullableTrimmed(input.scenario),
    first_message: nullableTrimmed(input.firstMessage),
    alternate_greetings_json: nullableTrimmed(input.alternateGreetingsJson),
    example_dialogues: nullableTrimmed(input.exampleDialogues),
    system_prompt: nullableTrimmed(input.systemPrompt),
    creator_notes: nullableTrimmed(input.creatorNotes),
    tags_json: nullableTrimmed(input.tagsJson),
    enabled: input.enabled === false ? 0 : 1,
    created_at: now,
    updated_at: now,
  };
  await dba
    .prepare(
      `INSERT INTO tavern_personas (
        id, user_id, name, avatar_path, summary, personality_prompt, scenario,
        first_message, alternate_greetings_json, example_dialogues,
        system_prompt, creator_notes, tags_json, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.user_id,
      record.name,
      record.avatar_path,
      record.summary,
      record.personality_prompt,
      record.scenario,
      record.first_message,
      record.alternate_greetings_json,
      record.example_dialogues,
      record.system_prompt,
      record.creator_notes,
      record.tags_json,
      record.enabled,
      record.created_at,
      record.updated_at,
    );
  return record;
}

export async function updateTavernPersona(
  id: string,
  userId: string,
  input: UpsertTavernPersonaInput,
): Promise<TavernPersonaRecord | undefined> {
  const existing = await getTavernPersonaById(id, userId);
  if (!existing) return undefined;
  const updated: TavernPersonaRecord = {
    ...existing,
    name: input.name.trim(),
    avatar_path:
      input.avatarPath !== undefined
        ? nullableTrimmed(input.avatarPath)
        : existing.avatar_path,
    summary:
      input.summary !== undefined
        ? nullableTrimmed(input.summary)
        : existing.summary,
    personality_prompt:
      input.personalityPrompt !== undefined
        ? nullableTrimmed(input.personalityPrompt)
        : existing.personality_prompt,
    scenario:
      input.scenario !== undefined
        ? nullableTrimmed(input.scenario)
        : existing.scenario,
    first_message:
      input.firstMessage !== undefined
        ? nullableTrimmed(input.firstMessage)
        : existing.first_message,
    alternate_greetings_json:
      input.alternateGreetingsJson !== undefined
        ? nullableTrimmed(input.alternateGreetingsJson)
        : existing.alternate_greetings_json,
    example_dialogues:
      input.exampleDialogues !== undefined
        ? nullableTrimmed(input.exampleDialogues)
        : existing.example_dialogues,
    system_prompt:
      input.systemPrompt !== undefined
        ? nullableTrimmed(input.systemPrompt)
        : existing.system_prompt,
    creator_notes:
      input.creatorNotes !== undefined
        ? nullableTrimmed(input.creatorNotes)
        : existing.creator_notes,
    tags_json:
      input.tagsJson !== undefined
        ? nullableTrimmed(input.tagsJson)
        : existing.tags_json,
    enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
    updated_at: new Date().toISOString(),
  };
  await dba
    .prepare(
      `UPDATE tavern_personas
       SET name = ?, avatar_path = ?, summary = ?, personality_prompt = ?,
           scenario = ?, first_message = ?, alternate_greetings_json = ?,
           example_dialogues = ?, system_prompt = ?, creator_notes = ?,
           tags_json = ?, enabled = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(
      updated.name,
      updated.avatar_path,
      updated.summary,
      updated.personality_prompt,
      updated.scenario,
      updated.first_message,
      updated.alternate_greetings_json,
      updated.example_dialogues,
      updated.system_prompt,
      updated.creator_notes,
      updated.tags_json,
      updated.enabled,
      updated.updated_at,
      id,
      userId,
    );
  return updated;
}

export async function setTavernPersonaAvatarPath(
  id: string,
  userId: string,
  avatarPath: string | null,
): Promise<TavernPersonaRecord | undefined> {
  const existing = await getTavernPersonaById(id, userId);
  if (!existing) return undefined;
  const updatedAt = new Date().toISOString();
  await dba
    .prepare(
      `UPDATE tavern_personas
       SET avatar_path = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(nullableTrimmed(avatarPath), updatedAt, id, userId);
  return getTavernPersonaById(id, userId);
}

export async function deleteTavernPersona(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await dba
    .prepare(`DELETE FROM tavern_personas WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return Number(result.changes || 0) > 0;
}

export async function getConversationTavernBinding(
  chatJid: string,
): Promise<ConversationTavernBindingRecord | undefined> {
  return (await dba
    .prepare(
      `SELECT chat_jid, tavern_persona_id, snapshot_json, opener_message_id, bound_at
       FROM conversation_tavern_bindings
       WHERE chat_jid = ?
       LIMIT 1`,
    )
    .get(chatJid)) as ConversationTavernBindingRecord | undefined;
}

export async function upsertConversationTavernBinding(input: {
  chatJid: string;
  tavernPersonaId: string;
  snapshotJson: string;
  openerMessageId?: string | null;
  boundAt?: string;
}): Promise<ConversationTavernBindingRecord> {
  const existing = await getConversationTavernBinding(input.chatJid);
  const boundAt = input.boundAt || existing?.bound_at || new Date().toISOString();
  if (existing) {
    await dba
      .prepare(
        `UPDATE conversation_tavern_bindings
         SET tavern_persona_id = ?, snapshot_json = ?, opener_message_id = ?, bound_at = ?
         WHERE chat_jid = ?`,
      )
      .run(
        input.tavernPersonaId,
        input.snapshotJson,
        input.openerMessageId ?? null,
        boundAt,
        input.chatJid,
      );
  } else {
    await dba
      .prepare(
        `INSERT INTO conversation_tavern_bindings (
          chat_jid, tavern_persona_id, snapshot_json, opener_message_id, bound_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.chatJid,
        input.tavernPersonaId,
        input.snapshotJson,
        input.openerMessageId ?? null,
        boundAt,
      );
  }
  return (await getConversationTavernBinding(
    input.chatJid,
  )) as ConversationTavernBindingRecord;
}

export async function deleteConversationTavernBinding(
  chatJid: string,
): Promise<void> {
  await dba
    .prepare(`DELETE FROM conversation_tavern_bindings WHERE chat_jid = ?`)
    .run(chatJid);
}

