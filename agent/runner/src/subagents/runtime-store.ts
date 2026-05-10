import fs from 'fs';
import path from 'path';

import type { PersistedSubagentRuntimeRecord } from './protocol.js';

const HISTORY_LOCK_WAIT_MS = 2_000;

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function withFileLock(lockPath: string, fn: () => void): void {
  const deadline = Date.now() + HISTORY_LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      sleepSync(25);
    }
  }

  try {
    fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function writeManagedSubagentMetadataFile(
  metadataPath: string,
  metadata: PersistedSubagentRuntimeRecord,
): void {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  const tempPath = `${metadataPath}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify(metadata, null, 2),
    'utf8',
  );
  fs.renameSync(tempPath, metadataPath);
}

export function appendManagedSubagentHistory(
  historyPath: string,
  metadata: PersistedSubagentRuntimeRecord,
): void {
  const lockPath = `${historyPath}.lock`;
  withFileLock(lockPath, () => {
    let items: PersistedSubagentRuntimeRecord[] = [];
    if (fs.existsSync(historyPath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(historyPath, 'utf8'),
        ) as PersistedSubagentRuntimeRecord[];
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [];
      }
    }
    items = [
      metadata,
      ...items.filter((item) => item?.id !== metadata.id),
    ].slice(0, 100);
    const tempPath = `${historyPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(tempPath, historyPath);
  });
}
