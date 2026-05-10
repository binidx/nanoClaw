import { dba } from './engine-access.js';

export interface ConversationShare {
  id: string;
  chat_jid: string;
  title: string | null;
  content: string;
  assistant_name: string | null;
  created_by: string | null;
  created_at: string;
  view_count: number;
  user_id: string;
}

export async function createShare(
  id: string,
  chatJid: string,
  title: string | null,
  content: string,
  assistantName: string | null,
  createdBy: string | null,
  userId: string,
): Promise<void> {
  await dba
    .prepare(
      `INSERT INTO conversation_shares (id, chat_jid, title, content, assistant_name, created_by, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, chatJid, title, content, assistantName, createdBy, new Date().toISOString(), userId);
}

export async function getShareById(id: string): Promise<ConversationShare | null> {
  const row = await dba
    .prepare(`SELECT * FROM conversation_shares WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return (row as ConversationShare) ?? null;
}

export async function incrementShareViewCount(id: string): Promise<void> {
  await dba
    .prepare(`UPDATE conversation_shares SET view_count = view_count + 1 WHERE id = ? AND deleted_at IS NULL`)
    .run(id);
}

export async function listUserShares(
  userId: string,
  limit: number,
  offset: number,
  chatJid?: string,
): Promise<{ shares: ConversationShare[]; total: number }> {
  const where = chatJid
    ? 'WHERE user_id = ? AND chat_jid = ? AND deleted_at IS NULL'
    : 'WHERE user_id = ? AND deleted_at IS NULL';
  const params = chatJid ? [userId, chatJid] : [userId];

  const rows = (await dba
    .prepare(
      `SELECT id, chat_jid, title, assistant_name, created_by, created_at, view_count, user_id
       FROM conversation_shares ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)) as ConversationShare[];

  const countRow = (await dba
    .prepare(`SELECT COUNT(*) AS cnt FROM conversation_shares ${where}`)
    .get(...params)) as { cnt: number } | undefined;

  return { shares: rows, total: countRow?.cnt ?? 0 };
}

export async function deleteShare(id: string, userId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await dba
    .prepare(
      `UPDATE conversation_shares SET deleted_at = ?, updated_by = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(now, userId, id, userId);
  return (result as { changes?: number })?.changes !== 0;
}
