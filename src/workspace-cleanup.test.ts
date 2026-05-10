import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupOrphanWorkspaces,
  scanOrphanWorkspaces,
} from './agent/workspace-cleanup.js';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cleanup-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace cleanup', () => {
  it('finds orphan directories across groups, sessions and ipc', async () => {
    const root = makeTempDir();
    const groupsDir = path.join(root, 'groups');
    const sessionsDir = path.join(root, 'sessions');
    const ipcDir = path.join(root, 'ipc');
    fs.mkdirSync(path.join(groupsDir, 'keep-me'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'orphan-a'), { recursive: true });
    fs.mkdirSync(path.join(sessionsDir, 'orphan-a'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'orphan-b'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, '.hidden'), { recursive: true });

    const summary = await scanOrphanWorkspaces({
      referencedFolders: ['keep-me'],
      staleRegisteredGroups: [],
      paths: { groupsDir, sessionsDir, ipcDir },
    });

    expect(
      summary.orphanDirectories.map((entry) => `${entry.root}:${entry.folder}`),
    ).toEqual(['groups:orphan-a', 'sessions:orphan-a', 'ipc:orphan-b']);
    expect(summary.staleRegisteredGroups).toEqual([]);
    expect(summary.deletedRegisteredGroups).toEqual([]);
  });

  it('removes orphan directories and orphan session rows', async () => {
    const root = makeTempDir();
    const groupsDir = path.join(root, 'groups');
    const sessionsDir = path.join(root, 'sessions');
    const ipcDir = path.join(root, 'ipc');
    fs.mkdirSync(path.join(groupsDir, 'orphan-a'), { recursive: true });
    fs.mkdirSync(path.join(sessionsDir, 'orphan-a'), { recursive: true });
    fs.mkdirSync(path.join(ipcDir, 'orphan-a'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'keep-me'), { recursive: true });

    const deletedSessionFolders: string[] = [];
    const deletedRegisteredGroups: string[] = [];
    const summary = await cleanupOrphanWorkspaces({
      referencedFolders: ['keep-me'],
      staleRegisteredGroups: [
        { jid: 'web:deleted-1', name: 'Deleted Chat', folder: 'orphan-a' },
      ],
      persistedSessionFolders: ['keep-me', 'orphan-a'],
      deletePersistedSession: (folder) => {
        deletedSessionFolders.push(folder);
      },
      deleteRegisteredGroupByJid: (jid) => {
        deletedRegisteredGroups.push(jid);
      },
      paths: { groupsDir, sessionsDir, ipcDir },
    });

    expect(
      summary.deletedDirectories.map(
        (entry) => `${entry.root}:${entry.folder}`,
      ),
    ).toEqual(['groups:orphan-a', 'sessions:orphan-a', 'ipc:orphan-a']);
    expect(summary.deletedSessionRows).toEqual(['orphan-a']);
    expect(summary.deletedRegisteredGroups).toEqual(['web:deleted-1']);
    expect(deletedSessionFolders).toEqual(['orphan-a']);
    expect(deletedRegisteredGroups).toEqual(['web:deleted-1']);
    expect(fs.existsSync(path.join(groupsDir, 'orphan-a'))).toBe(false);
    expect(fs.existsSync(path.join(groupsDir, 'keep-me'))).toBe(true);
  });
});
