import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  listMemoryDocuments,
  setRegisteredGroup,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { runMemoryDocumentSyncPass } from './memory/document-sync-loop.js';

describe('memory document sync loop', () => {
  const groupFolder = 'memory-sync-loop-group';
  const groupDir = resolveGroupFolderPath(groupFolder);
  const globalDir = path.join(GROUPS_DIR, 'global-memory-sync-loop');

  beforeEach(() => {
    _initTestDatabase();
    vi.unstubAllEnvs();
    vi.stubEnv('NANOCLAW_GLOBAL_DIR', globalDir);
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });

  it('waits for group and global indexing to finish before returning', async () => {
    await setRegisteredGroup('group-jid', {
      name: 'Memory Sync Group',
      folder: groupFolder,
      trigger: '@bot',
      added_at: '2026-03-26T00:00:00.000Z',
      requiresTrigger: true,
    });

    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'memory', '2026-03-26.md'),
      '# Group Memory\n\n- Sync this group file.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(globalDir, 'memory', '2026-03-26.md'),
      '# Global Memory\n\n- Sync this global file.\n',
      'utf8',
    );

    const syncedScopes = await runMemoryDocumentSyncPass();

    expect(syncedScopes).toBe(2);
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'group:memory/2026-03-26.md',
      }),
    ]);
    expect(
      await listMemoryDocuments({
        ownerType: 'global',
        ownerId: 'global',
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'global:memory/2026-03-26.md',
      }),
    ]);
  });
});
