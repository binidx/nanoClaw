import { dba } from '../db/engine-access.js';
import { createModuleLogger } from '../logger.js';
import type { FileStorageAdapter } from './im-file-storage.js';

const BATCH_SIZE = 100;
const DEFAULT_ORPHAN_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1000;
const imFileCleanupLog = createModuleLogger('im-file-cleanup');

export interface ImFileCleanupSummary {
  deletedAttachmentRows: number;
  deletedOrphanStorageKeys: string[];
}

export interface ImFileCleanupOptions {
  now?: Date;
  orphanAttachmentAgeMs?: number;
}

async function deleteAttachmentRows(
  storage: FileStorageAdapter,
  now: Date,
  orphanAttachmentAgeMs: number,
): Promise<number> {
  const nowIso = now.toISOString();
  const orphanBefore = new Date(now.getTime() - orphanAttachmentAgeMs).toISOString();
  const stale = (await dba
    .prepare(
      `SELECT id, storage_key FROM im_attachments
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (message_id IS NULL AND created_at < ?)
       LIMIT ?`,
    )
    .all(nowIso, orphanBefore, BATCH_SIZE)) as Array<{
    id: string;
    storage_key: string;
  }>;

  if (stale.length === 0) return 0;

  for (const row of stale) {
    try {
      await storage.delete(row.storage_key);
    } catch {
      // file may already be gone
    }
  }

  const ids = stale.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await dba
    .prepare(`DELETE FROM im_attachments WHERE id IN (${placeholders})`)
    .run(...ids);

  return stale.length;
}

async function deleteStorageKeysWithoutRows(
  storage: FileStorageAdapter,
  now: Date,
  orphanAttachmentAgeMs: number,
): Promise<string[]> {
  if (!storage.listKeys) return [];
  const rows = (await dba
    .prepare(`SELECT storage_key FROM im_attachments`)
    .all()) as Array<{ storage_key: string }>;
  const knownKeys = new Set(rows.map((row) => row.storage_key));
  const cutoffMs = now.getTime() - orphanAttachmentAgeMs;
  const deleted: string[] = [];
  for (const entry of await storage.listKeys()) {
    if (knownKeys.has(entry.key)) continue;
    if (entry.mtimeMs > cutoffMs) continue;
    try {
      await storage.delete(entry.key);
      deleted.push(entry.key);
    } catch {
      // file may already be gone
    }
  }
  return deleted;
}

export async function runImFileCleanupPass(
  storage: FileStorageAdapter,
  options: ImFileCleanupOptions = {},
): Promise<ImFileCleanupSummary> {
  const now = options.now || new Date();
  const orphanAttachmentAgeMs =
    options.orphanAttachmentAgeMs ?? DEFAULT_ORPHAN_ATTACHMENT_AGE_MS;
  let deletedAttachmentRows = 0;
  let batch: number;
  do {
    batch = await deleteAttachmentRows(storage, now, orphanAttachmentAgeMs);
    deletedAttachmentRows += batch;
  } while (batch >= BATCH_SIZE);

  const deletedOrphanStorageKeys = await deleteStorageKeysWithoutRows(
    storage,
    now,
    orphanAttachmentAgeMs,
  );
  return { deletedAttachmentRows, deletedOrphanStorageKeys };
}

export function startImFileCleanup(
  storage: FileStorageAdapter,
  intervalMs = 3600_000,
  options: ImFileCleanupOptions = {},
): NodeJS.Timeout {
  const tick = async () => {
    try {
      const summary = await runImFileCleanupPass(storage, options);
      if (
        summary.deletedAttachmentRows > 0 ||
        summary.deletedOrphanStorageKeys.length > 0
      ) {
        imFileCleanupLog.info(
          {
            deletedRows: summary.deletedAttachmentRows,
            deletedOrphanStorageKeys: summary.deletedOrphanStorageKeys.length,
          },
          'im-file-cleanup: deleted stale attachments',
        );
      }
    } catch (err) {
      imFileCleanupLog.error({ err }, 'im-file-cleanup: cleanup failed');
    }
  };

  void tick();
  return setInterval(() => void tick(), intervalMs);
}
