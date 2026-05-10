import crypto from 'crypto';
import { dba } from '../db/engine-access.js';
import type { UserKnowledgeBindingRecord } from '../types.js';

export async function listUserKnowledgeBindings(
  userId: string,
): Promise<UserKnowledgeBindingRecord[]> {
  return (await dba
    .prepare('SELECT * FROM user_knowledge_bindings WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)) as UserKnowledgeBindingRecord[];
}

export async function upsertUserKnowledgeBinding(
  userId: string,
  kbId: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  // Delete existing binding then insert to avoid PK vs UNIQUE conflict
  await dba.prepare('DELETE FROM user_knowledge_bindings WHERE user_id = ? AND kb_id = ?').run(userId, kbId);
  await dba
    .prepare(
      `INSERT INTO user_knowledge_bindings (id, user_id, kb_id, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), userId, kbId, enabled ? 1 : 0, now);
}

export async function listEnabledKbIdsForUser(
  userId: string,
): Promise<string[]> {
  const rows = (await dba
    .prepare('SELECT kb_id FROM user_knowledge_bindings WHERE user_id = ? AND enabled = 1')
    .all(userId)) as Array<{ kb_id: string }>;
  return rows.map((r) => r.kb_id);
}
