import { createModuleLogger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import { dba } from './engine-access.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('trash');

/**
 * Display metadata for soft-deleted rows. `nameCol` must exist on the table.
 * (Spec used file_name / name on ai_providers / channel_type; schema uses
 * filename / alias / name — see issues in the task notes.)
 */
export const TRASHABLE_TABLES = {
  assistants: { label: t('trash.entityAssistant', {}, undefined), nameCol: 'name' },
  knowledge_bases: { label: t('trash.entityKnowledgeBase', {}, undefined), nameCol: 'name' },
  knowledge_documents: { label: t('trash.entityKnowledgeDoc', {}, undefined), nameCol: 'filename' },
  ai_providers: { label: t('trash.entityProvider', {}, undefined), nameCol: 'alias' },
  users: { label: t('errors.auto_1fd02a', {}, undefined), nameCol: 'username' },
  ssh_keys: { label: t('trash.entitySshKey', {}, undefined), nameCol: 'name' },
  review_repositories: { label: t('trash.entityRepository', {}, undefined), nameCol: 'name' },
  live2d_models: { label: t('trash.entityLive2d', {}, undefined), nameCol: 'name' },
  marketplace_sources: { label: t('trash.entityExtension', {}, undefined), nameCol: 'name' },
  user_skills: { label: t('trash.entitySkill', {}, undefined), nameCol: 'name' },
  user_mcp_servers: { label: t('trash.entityMcpServer', {}, undefined), nameCol: 'name' },
  scheduled_tasks: { label: t('trash.entityScheduledTask', {}, undefined), nameCol: 'prompt' },
  channel_instances: { label: t('trash.entityChannelInstance', {}, undefined), nameCol: 'name' },
} as const;

export type TrashableTable = keyof typeof TRASHABLE_TABLES;

export interface TrashItem {
  id: string;
  name: string | null;
  deleted_at: string;
  deleted_by?: string;
}

const TRASHABLE_KEYS = new Set<string>(Object.keys(TRASHABLE_TABLES));

export function isTrashableTable(value: string): value is TrashableTable {
  return TRASHABLE_KEYS.has(value);
}

function resolveTable(table: TrashableTable): string {
  if (!TRASHABLE_KEYS.has(table)) {
    throw new Error(`Invalid trash table: ${String(table)}`);
  }
  return table;
}

function normalizeNameCol(table: TrashableTable): string {
  return TRASHABLE_TABLES[table].nameCol;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export async function listDeletedRecords(
  table: TrashableTable,
  opts?: { page?: number; pageSize?: number },
): Promise<{ items: TrashItem[]; total: number }> {
  const t = resolveTable(table);
  const nameCol = normalizeNameCol(table);
  const page = parsePositiveInt(opts?.page, 1);
  const pageSize = Math.min(200, parsePositiveInt(opts?.pageSize, 20));
  const offset = (page - 1) * pageSize;

  const countRow = (await dba
    .prepare(
      `SELECT COUNT(*) AS cnt FROM ${t} WHERE deleted_at IS NOT NULL`,
    )
    .get()) as { cnt: number | string | bigint } | undefined;
  const total = Number(countRow?.cnt ?? 0);

  const rows = (await dba
    .prepare(
      `
      SELECT id, ${nameCol} AS name, deleted_at, updated_by AS deleted_by
      FROM ${t}
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(pageSize, offset)) as Array<{
    id: string;
    name: string | null;
    deleted_at: string;
    deleted_by: string | null;
  }>;

  const items: TrashItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    deleted_at: r.deleted_at,
    ...(r.deleted_by != null && r.deleted_by !== ''
      ? { deleted_by: r.deleted_by }
      : {}),
  }));

  return { items, total };
}

export async function restoreRecord(
  table: TrashableTable,
  id: string,
): Promise<boolean> {
  const t = resolveTable(table);
  const now = new Date().toISOString();
  const userId = getCurrentUserId();
  const result = await dba
    .prepare(
      `UPDATE ${t} SET deleted_at = NULL, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .run(now, userId, id);
  return result.changes > 0;
}

export async function purgeRecord(
  table: TrashableTable,
  id: string,
): Promise<boolean> {
  const t = resolveTable(table);
  const result = await dba
    .prepare(
      `DELETE FROM ${t} WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .run(id);
  return result.changes > 0;
}

export async function purgeOldRecords(olderThanDays: number): Promise<number> {
  const cutoff = new Date(
    Date.now() - Math.max(1, olderThanDays) * 24 * 60 * 60 * 1000,
  ).toISOString();
  let purged = 0;
  const tables = Object.keys(TRASHABLE_TABLES) as TrashableTable[];

  for (const t of tables) {
    try {
      const result = await dba
        .prepare(
          `DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
        )
        .run(cutoff);
      purged += result.changes;
    } catch (err) {
      logger.error({ err, table: t }, 'trash: purgeOldRecords failed for table');
    }
  }

  return purged;
}
