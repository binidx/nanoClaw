import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  deleteRegisteredGroup,
  deleteSession,
  getActiveRegisteredGroupFolders,
  getAllSessions,
  getStaleRegisteredGroups,
  type StaleRegisteredGroup,
} from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';

const RESERVED_GROUP_FOLDERS = new Set(['global']);

export interface OrphanDirectoryEntry {
  root: 'groups' | 'sessions' | 'ipc';
  folder: string;
  path: string;
}

export interface WorkspaceCleanupSummary {
  orphanDirectories: OrphanDirectoryEntry[];
  staleRegisteredGroups: StaleRegisteredGroup[];
  deletedDirectories: OrphanDirectoryEntry[];
  deletedSessionRows: string[];
  deletedRegisteredGroups: string[];
}

interface CleanupPaths {
  groupsDir: string;
  sessionsDir: string;
  ipcDir: string;
}

function getCleanupPaths(overrides?: Partial<CleanupPaths>): CleanupPaths {
  return {
    groupsDir: overrides?.groupsDir || GROUPS_DIR,
    sessionsDir: overrides?.sessionsDir || path.join(DATA_DIR, 'sessions'),
    ipcDir: overrides?.ipcDir || path.join(DATA_DIR, 'ipc'),
  };
}

async function getReferencedFolders(explicitFolders?: string[]): Promise<Set<string>> {
  if (explicitFolders) return new Set(explicitFolders);
  return new Set(await getActiveRegisteredGroupFolders());
}

async function getStaleRegisteredGroupEntries(
  explicitEntries?: StaleRegisteredGroup[],
): Promise<StaleRegisteredGroup[]> {
  if (explicitEntries) return [...explicitEntries];
  return await getStaleRegisteredGroups();
}

function listOrphanDirectoriesInRoot(
  root: OrphanDirectoryEntry['root'],
  baseDir: string,
  referencedFolders: Set<string>,
): OrphanDirectoryEntry[] {
  if (!fs.existsSync(baseDir)) return [];

  const entries: OrphanDirectoryEntry[] = [];
  for (const dirent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const folder = dirent.name;
    if (RESERVED_GROUP_FOLDERS.has(folder)) continue;
    if (!isValidGroupFolder(folder)) continue;
    if (referencedFolders.has(folder)) continue;
    entries.push({ root, folder, path: path.join(baseDir, folder) });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function scanOrphanWorkspaces(options?: {
  referencedFolders?: string[];
  staleRegisteredGroups?: StaleRegisteredGroup[];
  paths?: Partial<CleanupPaths>;
}): Promise<WorkspaceCleanupSummary> {
  const referencedFolders = await getReferencedFolders(options?.referencedFolders);
  const staleRegisteredGroups = await getStaleRegisteredGroupEntries(
    options?.staleRegisteredGroups,
  );
  const paths = getCleanupPaths(options?.paths);

  const orphanDirectories = [
    ...listOrphanDirectoriesInRoot(
      'groups',
      paths.groupsDir,
      referencedFolders,
    ),
    ...listOrphanDirectoriesInRoot(
      'sessions',
      paths.sessionsDir,
      referencedFolders,
    ),
    ...listOrphanDirectoriesInRoot('ipc', paths.ipcDir, referencedFolders),
  ];

  return {
    orphanDirectories,
    staleRegisteredGroups,
    deletedDirectories: [],
    deletedSessionRows: [],
    deletedRegisteredGroups: [],
  };
}

export async function cleanupOrphanWorkspaces(options?: {
  referencedFolders?: string[];
  staleRegisteredGroups?: StaleRegisteredGroup[];
  paths?: Partial<CleanupPaths>;
  persistedSessionFolders?: string[];
  deletePersistedSession?: (folder: string) => void;
  deleteRegisteredGroupByJid?: (jid: string) => void;
}): Promise<WorkspaceCleanupSummary> {
  const summary = await scanOrphanWorkspaces(options);
  const deletedDirectories: OrphanDirectoryEntry[] = [];
  let signaledIpc = false;
  for (const entry of summary.orphanDirectories) {
    if (entry.root === 'ipc') {
      try {
        const inputDir = path.join(entry.path, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
        signaledIpc = true;
      } catch {
        // ignore best-effort close signal
      }
    }
  }

  if (signaledIpc) {
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  for (const entry of summary.orphanDirectories) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    deletedDirectories.push(entry);
  }

  const referencedFolders = await getReferencedFolders(options?.referencedFolders);
  const persistedSessionFolders =
    options?.persistedSessionFolders || Object.keys(await getAllSessions());
  const deletePersistedSession =
    options?.deletePersistedSession || deleteSession;
  const deleteRegisteredGroupByJid =
    options?.deleteRegisteredGroupByJid || deleteRegisteredGroup;
  const deletedSessionRows: string[] = [];
  const deletedRegisteredGroups: string[] = [];
  for (const folder of persistedSessionFolders) {
    if (RESERVED_GROUP_FOLDERS.has(folder)) continue;
    if (!isValidGroupFolder(folder)) continue;
    if (referencedFolders.has(folder)) continue;
    deletePersistedSession(folder);
    deletedSessionRows.push(folder);
  }

  for (const group of summary.staleRegisteredGroups) {
    deleteRegisteredGroupByJid(group.jid);
    deletedRegisteredGroups.push(group.jid);
  }

  return {
    orphanDirectories: summary.orphanDirectories,
    staleRegisteredGroups: summary.staleRegisteredGroups,
    deletedDirectories,
    deletedSessionRows: deletedSessionRows.sort(),
    deletedRegisteredGroups: deletedRegisteredGroups.sort(),
  };
}
