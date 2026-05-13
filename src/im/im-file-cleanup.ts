import { dba } from '../db/engine-access.js';
import { createModuleLogger } from '../logger.js';
import type { FileStorageAdapter } from './im-file-storage.js';

const BATCH_SIZE = 100;
const imFileCleanupLog = createModuleLogger('im-file-cleanup');

async function runCleanup(storage: FileStorageAdapter): Promise<number> {
  const now = new Date().toISOString();
  const expired = (await dba
    .prepare(
      `SELECT id, storage_key FROM im_attachments WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?`,
    )
    .all(now, BATCH_SIZE)) as Array<{ id: string; storage_key: string }>;

  if (expired.length === 0) return 0;

  for (const row of expired) {
    try {
      await storage.delete(row.storage_key);
    } catch {
      // file may already be gone
    }
  }

  const ids = expired.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  await dba
    .prepare(`DELETE FROM im_attachments WHERE id IN (${placeholders})`)
    .run(...ids);

  return expired.length;
}

export function startImFileCleanup(
  storage: FileStorageAdapter,
  intervalMs = 3600_000,
): NodeJS.Timeout {
  const tick = async () => {
    try {
      let total = 0;
      let batch: number;
      do {
        batch = await runCleanup(storage);
        total += batch;
      } while (batch >= BATCH_SIZE);
      if (total > 0) {
        imFileCleanupLog.info(
          { deletedCount: total },
          'im-file-cleanup: deleted expired attachments',
        );
      }
    } catch (err) {
      imFileCleanupLog.error({ err }, 'im-file-cleanup: cleanup failed');
    }
  };

  void tick();
  return setInterval(() => void tick(), intervalMs);
}
