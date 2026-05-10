import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config.js';
import { AvailableGroup } from '../agent/agent-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from '../db.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  computeInitialNextRun,
  normalizeScheduleValue,
} from '../scheduler/task-schedule.js';
import { RegisteredGroup } from '../types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  onMessageSent?: (jid: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[] | Promise<AvailableGroup[]>;
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

interface DirectorySignature {
  mtimeMs: number;
  size: number;
}

type DirectoryPollCache = Map<string, DirectorySignature>;

interface SourceGroupContext {
  deps: IpcDeps;
  dirPollCache: DirectoryPollCache;
  ensureErrorDir: () => string;
  ipcBaseDir: string;
  registeredGroups: Record<string, RegisteredGroup>;
}

function readDirectorySignature(dirPath: string): DirectorySignature | null {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) return null;
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function listChangedJsonFiles(
  dirPath: string,
  cache: DirectoryPollCache,
): string[] {
  const signature = readDirectorySignature(dirPath);
  if (!signature) {
    cache.delete(dirPath);
    return [];
  }

  const cached = cache.get(dirPath);
  if (
    cached &&
    cached.mtimeMs === signature.mtimeMs &&
    cached.size === signature.size
  ) {
    return [];
  }

  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  cache.set(dirPath, signature);
  return files;
}

function listSourceGroups(ipcBaseDir: string): string[] {
  return fs
    .readdirSync(ipcBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'errors')
    .map((entry) => entry.name);
}

async function processSourceGroupIpc(
  sourceGroup: string,
  isMain: boolean,
  context: SourceGroupContext,
): Promise<void> {
  const { deps, dirPollCache, ensureErrorDir, ipcBaseDir, registeredGroups } =
    context;
  const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

  try {
    const messageFiles = listChangedJsonFiles(messagesDir, dirPollCache);
    for (const file of messageFiles) {
      const filePath = path.join(messagesDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.type === 'message' && data.chatJid && data.text) {
          const targetGroup = registeredGroups[data.chatJid];
          if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
            await deps.sendMessage(data.chatJid, data.text);
            deps.onMessageSent?.(data.chatJid);
            logger.info(
              { chatJid: data.chatJid, sourceGroup },
              'IPC message sent',
            );
          } else {
            logger.warn(
              { chatJid: data.chatJid, sourceGroup },
              'Unauthorized IPC message attempt blocked',
            );
          }
        }
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error(
          { file, sourceGroup, err },
          'Error processing IPC message',
        );
        fs.renameSync(
          filePath,
          path.join(ensureErrorDir(), `${sourceGroup}-${file}`),
        );
      }
    }
  } catch (err) {
    logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
  }

  try {
    const taskFiles = listChangedJsonFiles(tasksDir, dirPollCache);
    for (const file of taskFiles) {
      const filePath = path.join(tasksDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await processTaskIpc(data, sourceGroup, isMain, deps);
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
        fs.renameSync(
          filePath,
          path.join(ensureErrorDir(), `${sourceGroup}-${file}`),
        );
      }
    }
  } catch (err) {
    logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  const dirPollCache: DirectoryPollCache = new Map();
  let errorDirReady = false;

  const ensureErrorDir = (): string => {
    const errorDir = path.join(ipcBaseDir, 'errors');
    if (!errorDirReady) {
      fs.mkdirSync(errorDir, { recursive: true });
      errorDirReady = true;
    }
    return errorDir;
  };

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = listSourceGroups(ipcBaseDir);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    await Promise.all(
      groupFolders.map((sourceGroup) =>
        processSourceGroupIpc(
          sourceGroup,
          folderIsMain.get(sourceGroup) === true,
          {
            deps,
            dirPollCache,
            ensureErrorDir,
            ipcBaseDir,
            registeredGroups,
          },
        ),
      ),
    );

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.debug('IPC watcher started (per-group namespaces)');
}

/** @internal - for tests only. */
export function _listChangedJsonFilesForTests(
  dirPath: string,
  cache: DirectoryPollCache,
): string[] {
  return listChangedJsonFiles(dirPath, cache);
}

/** @internal - for tests only. */
export async function _processSourceGroupIpcForTests(
  sourceGroup: string,
  isMain: boolean,
  context: SourceGroupContext,
): Promise<void> {
  await processSourceGroupIpc(sourceGroup, isMain, context);
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    agentConfig?: RegisteredGroup['agentConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let normalizedScheduleValue: string;
        let nextRun: string | null = null;
        try {
          normalizedScheduleValue = normalizeScheduleValue(
            scheduleType,
            data.schedule_value as string,
          );
          nextRun = computeInitialNextRun(
            scheduleType,
            normalizedScheduleValue,
          );
        } catch (err) {
          logger.warn(
            { scheduleValue: data.schedule_value, err },
            'Invalid task schedule',
          );
          break;
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        await createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: normalizedScheduleValue,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = await getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          await deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = await Promise.resolve(deps.getAvailableGroups());
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          agentConfig: data.agentConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
