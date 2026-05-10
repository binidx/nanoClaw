import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  _initTestDatabase,
  listMemoryDocumentSyncStates,
  listMemoryDocuments,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  refreshIndexedMemoryPathRefsForSearch,
  syncIndexedMemoryFile,
  syncIndexedMemoryFilesForSearch,
} from './memory/document-indexing.js';

describe('memory document indexing', () => {
  const groupFolder = 'memory-index-group';
  const groupDir = resolveGroupFolderPath(groupFolder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const otherGroupDir = resolveGroupFolderPath('memory-index-other');

  beforeEach(() => {
    _initTestDatabase();
    vi.unstubAllEnvs();
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(otherGroupDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(otherGroupDir, { recursive: true, force: true });
  });

  it('indexes a group memory file using the real group folder path', async () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'memory', '2026-03-19.md'),
      ['# Daily Memory 2026-03-19', '', '- 08:30 Remember Friday deployment'].join('\n'),
      'utf8',
    );

    const file = await syncIndexedMemoryFile({
      pathRef: 'group:memory/2026-03-19.md',
      groupFolder,
    });

    expect(file?.absolutePath).toBe(
      path.join(groupDir, 'memory', '2026-03-19.md'),
    );
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'group:memory/2026-03-19.md',
        source_type: 'memory_file',
      }),
    ]);
  });

  it('syncs global memory files from the groups/global workspace', async () => {
    fs.mkdirSync(path.join(globalDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'memory', '2026-03-19.md'),
      ['# Daily', 'Global deployment defaults live here.'].join('\n'),
      'utf8',
    );

    const files = await syncIndexedMemoryFilesForSearch({
      scope: 'global',
      groupFolder,
    });

    expect(files.get('global:memory/2026-03-19.md')?.absolutePath).toBe(
      path.join(globalDir, 'memory', '2026-03-19.md'),
    );
    expect(
      await listMemoryDocuments({
        ownerType: 'global',
        ownerId: 'global',
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'global:memory/2026-03-19.md',
        source_type: 'memory_file',
      }),
    ]);
  });

  it('skips unchanged files without rewriting indexed document timestamps', async () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    const absolutePath = path.join(groupDir, 'memory', '2026-03-19.md');
    fs.writeFileSync(
      absolutePath,
      ['# Daily Memory 2026-03-19', '', '- 08:30 Remember Friday deployment'].join('\n'),
      'utf8',
    );

    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T10:00:00.000Z',
    });
    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T11:00:00.000Z',
    });

    const documents = await listMemoryDocuments({
      ownerType: 'group',
      ownerId: groupFolder,
    });
    const syncStates = await listMemoryDocumentSyncStates({
      ownerType: 'group',
      ownerId: groupFolder,
      sourceType: 'memory_file',
    });

    expect(documents).toHaveLength(1);
    expect(documents[0]?.updated_at).toBe('2026-03-19T10:00:00.000Z');
    expect(syncStates).toHaveLength(1);
    expect(syncStates[0]?.path_ref).toBe('group:memory/2026-03-19.md');
    expect(fs.existsSync(absolutePath)).toBe(true);
  });

  it('deletes stale indexed documents when a memory file is removed', async () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    const absolutePath = path.join(groupDir, 'memory', '2026-03-19.md');
    fs.writeFileSync(
      absolutePath,
      ['# Daily Memory 2026-03-19', '', '- 08:30 Remember Friday deployment'].join('\n'),
      'utf8',
    );

    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T10:00:00.000Z',
    });
    fs.rmSync(absolutePath, { force: true });
    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T11:00:00.000Z',
    });

    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([]);
    expect(
      await listMemoryDocumentSyncStates({
        ownerType: 'group',
        ownerId: groupFolder,
        sourceType: 'memory_file',
      }),
    ).toEqual([]);
  });

  it('refreshes only targeted stale path refs for search', async () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    const absolutePath = path.join(groupDir, 'memory', '2026-03-19.md');
    fs.writeFileSync(
      absolutePath,
      ['# Daily Memory 2026-03-19', '', '- Deployment window is Friday night'].join('\n'),
      'utf8',
    );

    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T10:00:00.000Z',
    });

    fs.writeFileSync(
      absolutePath,
      ['# Daily Memory 2026-03-19', '', '- Deployment window is Saturday morning'].join('\n'),
      'utf8',
    );
    fs.utimesSync(
      absolutePath,
      new Date('2026-03-19T11:00:00.000Z'),
      new Date('2026-03-19T11:00:00.000Z'),
    );

    const result = await refreshIndexedMemoryPathRefsForSearch({
      pathRefs: ['group:memory/2026-03-19.md'],
      groupFolder,
      updatedAt: '2026-03-19T11:00:00.000Z',
    });

    expect(result).toMatchObject({
      checkedCount: 1,
      refreshedCount: 1,
      deletedCount: 0,
    });
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'group:memory/2026-03-19.md',
        body: expect.stringContaining('Saturday morning'),
        updated_at: '2026-03-19T11:00:00.000Z',
      }),
    ]);
  });

  it('drops deleted targeted path refs during freshness refresh', async () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    const absolutePath = path.join(groupDir, 'memory', '2026-03-19.md');
    fs.writeFileSync(
      absolutePath,
      ['# Daily Memory 2026-03-19', '', '- Deployment window is Friday night'].join('\n'),
      'utf8',
    );

    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T10:00:00.000Z',
    });
    fs.rmSync(absolutePath, { force: true });

    const result = await refreshIndexedMemoryPathRefsForSearch({
      pathRefs: ['group:memory/2026-03-19.md'],
      groupFolder,
      updatedAt: '2026-03-19T11:00:00.000Z',
    });

    expect(result).toMatchObject({
      checkedCount: 1,
      refreshedCount: 0,
      deletedCount: 1,
    });
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([]);
    expect(
      await listMemoryDocumentSyncStates({
        ownerType: 'group',
        ownerId: groupFolder,
        sourceType: 'memory_file',
      }),
    ).toEqual([]);
  });

  it('limits deletion cleanup to the current owner boundary', async () => {
    const otherGroupFolder = 'memory-index-other';
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(otherGroupDir, 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'memory', '2026-03-19.md'),
      ['# Daily Memory 2026-03-19', '', '- 08:30 Remember Friday deployment'].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(otherGroupDir, 'memory', '2026-03-19.md'),
      ['# Daily Memory 2026-03-19', '', '- 09:00 Other group note'].join('\n'),
      'utf8',
    );

    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T10:00:00.000Z',
    });
    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder: otherGroupFolder,
      updatedAt: '2026-03-19T10:05:00.000Z',
    });

    fs.rmSync(path.join(groupDir, 'memory', '2026-03-19.md'), { force: true });
    await syncIndexedMemoryFilesForSearch({
      scope: 'group',
      groupFolder,
      updatedAt: '2026-03-19T11:00:00.000Z',
    });

    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: groupFolder,
      }),
    ).toEqual([]);
    expect(
      await listMemoryDocuments({
        ownerType: 'group',
        ownerId: otherGroupFolder,
      }),
    ).toEqual([
      expect.objectContaining({
        path_ref: 'group:memory/2026-03-19.md',
      }),
    ]);
  });
});
