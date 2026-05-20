import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  GROUPS_DIR_OVERRIDE_ENV,
  HISTORY_FILE_NAME,
  RUN_REGISTRY_PATH_OVERRIDE_ENV,
  SUBAGENT_DIR_NAME,
  type SubagentRuntimeEntry,
  isSupportedControlScope,
  isSupportedProvider,
  isSupportedRequestKind,
  isSupportedRequestState,
  isSupportedRole,
  isSupportedRuntimeKind,
  isSupportedWorkProfile,
} from './subagent-runtime-types.js';

const MAX_NESTED_RUNTIME_ROOT_SCAN_DEPTH = 64;

export function getRunRegistryPath(): string {
  const override = process.env[RUN_REGISTRY_PATH_OVERRIDE_ENV]?.trim();
  return override
    ? path.resolve(override)
    : path.join(DATA_DIR, 'subagent-run-registry.json');
}

export function getRuntimeRegistryGroupsDir(): string {
  const override = process.env[GROUPS_DIR_OVERRIDE_ENV]?.trim();
  return override ? path.resolve(override) : GROUPS_DIR;
}

function addRuntimeRoot(
  roots: string[],
  seen: Set<string>,
  runtimeRoot: string,
): void {
  let resolved = path.resolve(runtimeRoot);
  try {
    resolved = fs.realpathSync(runtimeRoot);
  } catch {
    // Keep the resolved path when the root was found by name but disappeared.
  }
  if (seen.has(resolved)) return;
  seen.add(resolved);
  roots.push(runtimeRoot);
}

function collectNestedRuntimeRoots(
  currentDir: string,
  roots: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > MAX_NESTED_RUNTIME_ROOT_SCAN_DEPTH) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(currentDir, entry.name);
    if (entry.name === SUBAGENT_DIR_NAME) {
      addRuntimeRoot(roots, seen, childPath);
    }
    collectNestedRuntimeRoots(childPath, roots, seen, depth + 1);
  }
}

export function listRuntimeRegistryRoots(): string[] {
  const groupsDir = getRuntimeRegistryGroupsDir();
  const roots: string[] = [];
  const seen = new Set<string>();
  let groupEntries: fs.Dirent[] = [];
  try {
    groupEntries = fs.readdirSync(groupsDir, { withFileTypes: true });
  } catch {
    return roots;
  }

  for (const groupEntry of groupEntries) {
    if (!groupEntry.isDirectory()) continue;
    const groupDir = path.join(groupsDir, groupEntry.name);
    const runtimeRoot = path.join(groupDir, SUBAGENT_DIR_NAME);
    if (fs.existsSync(runtimeRoot)) {
      addRuntimeRoot(roots, seen, runtimeRoot);
      collectNestedRuntimeRoots(runtimeRoot, roots, seen, 0);
      continue;
    }
    collectNestedRuntimeRoots(groupDir, roots, seen, 0);
  }

  return roots;
}

export function parseRuntimeEntry(
  payload: Partial<SubagentRuntimeEntry> | null | undefined,
): SubagentRuntimeEntry | null {
  try {
    if (
      !payload ||
      !isSupportedProvider(payload.provider) ||
      typeof payload.id !== 'string'
    ) {
      return null;
    }
    if (payload.mode !== 'agent' && payload.mode !== 'team') {
      return null;
    }
    if (
      payload.status !== 'spawning' &&
      payload.status !== 'idle' &&
      payload.status !== 'running' &&
      payload.status !== 'stopping' &&
      payload.status !== 'completed' &&
      payload.status !== 'failed' &&
      payload.status !== 'stopped'
    ) {
      return null;
    }
    if (
      typeof payload.groupFolder !== 'string' ||
      typeof payload.chatJid !== 'string' ||
      typeof payload.name !== 'string' ||
      typeof payload.task !== 'string' ||
      typeof payload.createdAt !== 'string' ||
      typeof payload.updatedAt !== 'string' ||
      typeof payload.depth !== 'number'
    ) {
      return null;
    }
    return {
      ...payload,
      runtimeKind: isSupportedRuntimeKind(payload.runtimeKind)
        ? payload.runtimeKind
        : undefined,
      topologyRole: isSupportedRole(payload.topologyRole)
        ? payload.topologyRole
        : isSupportedRole(payload.role)
          ? payload.role
          : undefined,
      workProfile: isSupportedWorkProfile(payload.workProfile)
        ? payload.workProfile
        : undefined,
      role: isSupportedRole(payload.role) ? payload.role : undefined,
      controlScope: isSupportedControlScope(payload.controlScope)
        ? payload.controlScope
        : undefined,
      lastAcceptedRequestKind: isSupportedRequestKind(
        payload.lastAcceptedRequestKind,
      )
        ? payload.lastAcceptedRequestKind
        : undefined,
      lastCompletedRequestKind: isSupportedRequestKind(
        payload.lastCompletedRequestKind,
      )
        ? payload.lastCompletedRequestKind
        : undefined,
      lastCompletedRequestState: isSupportedRequestState(
        payload.lastCompletedRequestState,
      )
        ? payload.lastCompletedRequestState
        : undefined,
    } as SubagentRuntimeEntry;
  } catch {
    return null;
  }
}

export function readRuntimeEntry(
  filePath: string,
): SubagentRuntimeEntry | null {
  try {
    const payload = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<SubagentRuntimeEntry>;
    return parseRuntimeEntry(payload);
  } catch {
    return null;
  }
}

export function readRuntimeHistory(filePath: string): SubagentRuntimeEntry[] {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!Array.isArray(payload)) return [];
    return payload
      .map((item) => parseRuntimeEntry(item as Partial<SubagentRuntimeEntry>))
      .filter((item): item is SubagentRuntimeEntry => item !== null);
  } catch {
    return [];
  }
}

export function getRuntimeRootHistoryPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, HISTORY_FILE_NAME);
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}
