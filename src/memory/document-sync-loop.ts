import { MEMORY_INDEX_SYNC_POLL_INTERVAL } from '../config.js';
import { getAllRegisteredGroups } from '../db.js';
import { logger } from '../logger.js';

import { syncIndexedMemoryFilesForSearch } from './document-indexing.js';

let memoryDocumentSyncLoopRunning = false;
let memoryDocumentSyncLoopTimer: ReturnType<typeof setTimeout> | null = null;

export async function runMemoryDocumentSyncPass(): Promise<number> {
  let syncedScopes = 0;
  const groups = Object.values(await getAllRegisteredGroups());

  for (const group of groups) {
    try {
      await syncIndexedMemoryFilesForSearch({
        scope: 'group',
        groupFolder: group.folder,
      });
      syncedScopes += 1;
    } catch (err) {
      logger.warn(
        { err, groupFolder: group.folder },
        'Failed to sync indexed group memory files',
      );
    }
  }

  try {
    await syncIndexedMemoryFilesForSearch({
      scope: 'global',
      groupFolder: 'global',
    });
    syncedScopes += 1;
  } catch (err) {
    logger.warn({ err }, 'Failed to sync indexed global memory files');
  }

  return syncedScopes;
}

export function startMemoryDocumentSyncLoop(): void {
  if (memoryDocumentSyncLoopRunning) {
    logger.debug(
      'Memory document sync loop already running, skipping duplicate start',
    );
    return;
  }
  memoryDocumentSyncLoopRunning = true;
  logger.debug('Memory document sync loop started');

  const loop = async () => {
    try {
      await runMemoryDocumentSyncPass();
    } catch (err) {
      logger.error({ err }, 'Error in memory document sync loop');
    }
    memoryDocumentSyncLoopTimer = setTimeout(() => {
      void loop();
    }, MEMORY_INDEX_SYNC_POLL_INTERVAL);
  };

  void loop();
}

export function clearMemoryDocumentSyncLoopForTest(): void {
  if (memoryDocumentSyncLoopTimer) {
    clearTimeout(memoryDocumentSyncLoopTimer);
    memoryDocumentSyncLoopTimer = null;
  }
  memoryDocumentSyncLoopRunning = false;
}
