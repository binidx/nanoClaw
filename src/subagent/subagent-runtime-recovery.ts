import fs from 'fs';
import path from 'path';

import {
  HISTORY_FILE_NAME,
  RUNTIME_FILE_NAME,
  SUBAGENT_DIR_NAME,
  type SubagentRuntimeEntry,
  type SubagentRuntimeRecoverySummary,
  isActiveStatus,
} from './subagent-runtime-types.js';
import {
  readRuntimeEntry,
  readRuntimeHistory,
  writeJsonFile,
  getRuntimeRegistryGroupsDir,
} from './subagent-runtime-fs.js';

const orphanedActiveRuntimeIds = new Set<string>();

export function isOrphanMarkedActiveSubagentRuntime(runtimeId: string): boolean {
  return orphanedActiveRuntimeIds.has(runtimeId);
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isFinite(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    ) {
      return true;
    }
    return false;
  }
}

function buildRecoveredRuntimeEntry(
  entry: SubagentRuntimeEntry,
  recoveredAt: string,
): SubagentRuntimeEntry {
  return {
    ...entry,
    status: 'failed',
    activeRequestId: undefined,
    completedAt: recoveredAt,
    updatedAt: recoveredAt,
    exitCode:
      typeof entry.exitCode === 'number' || entry.exitCode === null
        ? entry.exitCode
        : null,
    lastError:
      entry.lastError ||
      'Recovered after controller restart; managed sub-agent was left active without a live controller.',
  };
}

function appendRuntimeHistory(
  historyPath: string,
  entry: SubagentRuntimeEntry,
): void {
  let items: SubagentRuntimeEntry[] = [];
  if (fs.existsSync(historyPath)) {
    items = readRuntimeHistory(historyPath);
  }
  const nextItems = [entry, ...items.filter((item) => item.id !== entry.id)].slice(
    0,
    100,
  );
  writeJsonFile(historyPath, nextItems);
}

export function recoverOrphanedSubagentRuntimes(): SubagentRuntimeRecoverySummary {
  orphanedActiveRuntimeIds.clear();
  const summary: SubagentRuntimeRecoverySummary = {
    recovered: 0,
    failed: 0,
    stopped: 0,
    removedRuntimeDirs: 0,
  };
  const groupsDir = getRuntimeRegistryGroupsDir();
  let groupEntries: fs.Dirent[] = [];
  try {
    groupEntries = fs.readdirSync(groupsDir, { withFileTypes: true });
  } catch {
    return summary;
  }

  for (const groupEntry of groupEntries) {
    if (!groupEntry.isDirectory()) continue;
    const runtimeRoot = path.join(groupsDir, groupEntry.name, SUBAGENT_DIR_NAME);
    if (!fs.existsSync(runtimeRoot)) continue;
    let runtimeEntries: fs.Dirent[] = [];
    try {
      runtimeEntries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const runtimeEntry of runtimeEntries) {
      if (!runtimeEntry.isDirectory()) continue;
      const runtimeDir = path.join(runtimeRoot, runtimeEntry.name);
      const runtimeFile = path.join(runtimeDir, RUNTIME_FILE_NAME);
      const parsed = readRuntimeEntry(runtimeFile);
      if (!parsed) continue;
      if (
        parsed.provider !== 'codex' ||
        !isActiveStatus(parsed.status) ||
        parsed.runtimeKind === 'ephemeral_snapshot'
      ) {
        continue;
      }

      if (isProcessAlive(parsed.pid)) {
        orphanedActiveRuntimeIds.add(parsed.id);
        continue;
      }

      const recoveredAt = new Date().toISOString();
      const recoveredEntry = buildRecoveredRuntimeEntry(parsed, recoveredAt);
      const historyPath = path.join(runtimeRoot, HISTORY_FILE_NAME);
      try {
        appendRuntimeHistory(historyPath, recoveredEntry);
        summary.recovered += 1;
      } catch {
        summary.failed += 1;
        continue;
      }

      try {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        summary.removedRuntimeDirs += 1;
      } catch {
        // ignore cleanup failures; history already reflects recovered state
      }
    }
  }

  return summary;
}
