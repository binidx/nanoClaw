import { purgeOldRecords } from '../db/trash.js';
import { createModuleLogger } from '../logger.js';
import { startNonOverlappingBackgroundLoop } from '../runtime/background-loop.js';

const logger = createModuleLogger('trash-cleanup');

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PURGE_AFTER_DAYS = 30;

async function runTrashCleanupPass(): Promise<void> {
  try {
    const purged = await purgeOldRecords(PURGE_AFTER_DAYS);
    logger.info(
      { purged, olderThanDays: PURGE_AFTER_DAYS },
      'trash cleanup pass completed',
    );
  } catch (err) {
    logger.error({ err }, 'trash cleanup pass failed');
  }
}

export function startTrashCleanupLoop(): void {
  startNonOverlappingBackgroundLoop({
    name: 'trash-cleanup',
    intervalMs: CLEANUP_INTERVAL_MS,
    runImmediately: true,
    task: runTrashCleanupPass,
  });
}
