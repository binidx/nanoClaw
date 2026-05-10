import fs from 'fs';
import path from 'path';

import {
  CLOSE_SENTINEL_FILE_NAME,
  DEFAULT_REQUEST_TIMEOUT_MS,
  IPC_DIR_NAME,
  IPC_INPUT_DIR_NAME,
  REQUEST_POLL_MS,
  type SubagentRuntimeBatchStopQuery,
  type SubagentRuntimeBatchStopResult,
  type SubagentRuntimeCommandResult,
  type SubagentRuntimeEntry,
  type SubagentRuntimeRequestKind,
  type SubagentRuntimeRequestOptions,
  type SubagentRuntimeStopResult,
  type IndexedSubagentRuntimeRecord,
  type SubagentRuntimeCapabilities,
  type SubagentRuntimeControlState,
  _getRegistryLookup,
  compareRunRecords,
  isActiveStatus,
} from './subagent-runtime-types.js';

interface ControllableLookupResult {
  ok: false;
  status: 'not_found' | 'not_controllable';
  entry?: SubagentRuntimeEntry;
}

function ensureControllableRecord(
  subagentId: string,
): IndexedSubagentRuntimeRecord | ControllableLookupResult {
  const targetId = subagentId.trim();
  if (!targetId) {
    return { ok: false, status: 'not_found' };
  }
  const record = _getRegistryLookup().findIndexedRuntimeById(targetId);
  if (!record) {
    return { ok: false, status: 'not_found' };
  }
  if (
    record.entry.controlState !== 'controllable' ||
    typeof record.runtimeDir !== 'string'
  ) {
    return {
      ok: false,
      status: 'not_controllable',
      entry: record.entry,
    };
  }
  return record;
}

function buildCapabilities(
  entry: SubagentRuntimeEntry,
  controlState: SubagentRuntimeControlState,
): SubagentRuntimeCapabilities {
  const active = isActiveStatus(entry.status);
  const topologyRole = entry.topologyRole || entry.role;
  const canStop = controlState === 'controllable' && active;
  const canSpawnChildren =
    entry.provider === 'codex' &&
    active &&
    entry.controlScope !== 'none' &&
    topologyRole !== 'leaf';
  const canMessage =
    canStop && entry.mode === 'team' && entry.provider === 'codex';
  const canSteer = canMessage && canSpawnChildren;
  return {
    canStop,
    canMessage,
    canSteer,
    canSpawnChildren,
    canResumeAfterRestart: false,
  };
}

function canAcceptRuntimePrompt(
  entry: SubagentRuntimeEntry,
  kind: SubagentRuntimeRequestKind,
): boolean {
  const capabilities =
    entry.capabilities ||
    buildCapabilities(entry, entry.controlState || 'read_only');
  return kind === 'message'
    ? capabilities.canMessage
    : capabilities.canSteer;
}

function createRuntimeRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function writeIpcRequest(
  runtimeDir: string,
  payload: {
    type: 'message';
    requestId: string;
    prompt: string;
    createdAt: string;
  },
): void {
  const ipcInputDir = path.join(runtimeDir, IPC_DIR_NAME, IPC_INPUT_DIR_NAME);
  fs.mkdirSync(ipcInputDir, { recursive: true });
  const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(ipcInputDir, `${baseName}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestResult(
  subagentId: string,
  requestId: string,
  timeoutMs: number,
): Promise<SubagentRuntimeCommandResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const entry = _getRegistryLookup().getSubagentRuntime(subagentId);
    if (!entry) {
      return {
        ok: false,
        status: 'not_found',
      };
    }
    if (entry.lastCompletedRequestId === requestId) {
      if (entry.lastCompletedRequestState === 'failed') {
        return {
          ok: false,
          status: 'failed',
          requestId,
          entry,
          error: entry.lastError,
        };
      }
      return {
        ok: true,
        status: 'completed',
        requestId,
        entry,
        result: entry.lastResultPreview || null,
      };
    }
    await delay(REQUEST_POLL_MS);
  }
  return {
    ok: true,
    status: 'timeout',
    requestId,
    entry: _getRegistryLookup().getSubagentRuntime(subagentId) || undefined,
  };
}

function buildSteerPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;
  return /^\s*\[STEER\]/i.test(trimmed) ? trimmed : `[STEER]\n${trimmed}`;
}

async function requestRuntimePrompt(
  subagentId: string,
  prompt: string,
  kind: SubagentRuntimeRequestKind,
  options: SubagentRuntimeRequestOptions = {},
): Promise<SubagentRuntimeCommandResult> {
  const controllable = ensureControllableRecord(subagentId);
  if ('ok' in controllable) {
    return {
      ok: false,
      status: controllable.status,
      entry: controllable.entry,
    };
  }
  if (controllable.entry.mode !== 'team') {
    return {
      ok: false,
      status: 'not_controllable',
      entry: controllable.entry,
    };
  }
  if (controllable.entry.activeRequestId) {
    return {
      ok: false,
      status: 'busy',
      entry: controllable.entry,
    };
  }
  if (!canAcceptRuntimePrompt(controllable.entry, kind)) {
    return {
      ok: false,
      status: 'not_controllable',
      entry: controllable.entry,
    };
  }
  const requestId = createRuntimeRequestId();
  const payloadPrompt = kind === 'steer' ? buildSteerPrompt(prompt) : prompt.trim();
  try {
    writeIpcRequest(controllable.runtimeDir!, {
      type: 'message',
      requestId,
      prompt: payloadPrompt,
      createdAt: new Date().toISOString(),
    });
  } catch {
    return {
      ok: false,
      status: 'not_controllable',
      entry: controllable.entry,
    };
  }
  if (options.waitForResponse === false) {
    return {
      ok: true,
      status: 'accepted',
      requestId,
      entry: _getRegistryLookup().getSubagentRuntime(subagentId) || controllable.entry,
    };
  }
  return waitForRequestResult(
    subagentId,
    requestId,
    Math.max(1_000, options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
  );
}

export async function requestMessageSubagentRuntime(
  subagentId: string,
  prompt: string,
  options?: SubagentRuntimeRequestOptions,
): Promise<SubagentRuntimeCommandResult> {
  return requestRuntimePrompt(subagentId, prompt, 'message', options);
}

export async function requestSteerSubagentRuntime(
  subagentId: string,
  prompt: string,
  options?: SubagentRuntimeRequestOptions,
): Promise<SubagentRuntimeCommandResult> {
  return requestRuntimePrompt(subagentId, prompt, 'steer', options);
}

export function requestStopSubagentRuntime(
  subagentId: string,
): SubagentRuntimeStopResult {
  const targetId = subagentId.trim();
  if (!targetId) {
    return { ok: false, status: 'not_found' };
  }

  const record = _getRegistryLookup().findIndexedRuntimeById(targetId);
  if (!record) {
    return { ok: false, status: 'not_found' };
  }

  if (!isActiveStatus(record.entry.status)) {
    return {
      ok: true,
      status: 'already_stopped',
      entry: record.entry,
    };
  }

  if (
    record.entry.controlState !== 'controllable' ||
    typeof record.runtimeDir !== 'string'
  ) {
    return {
      ok: false,
      status: 'not_controllable',
      entry: record.entry,
    };
  }

  try {
    const ipcInputDir = path.join(
      record.runtimeDir,
      IPC_DIR_NAME,
      IPC_INPUT_DIR_NAME,
    );
    fs.mkdirSync(ipcInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcInputDir, CLOSE_SENTINEL_FILE_NAME),
      '',
      'utf8',
    );
    return {
      ok: true,
      status: 'stop_requested',
      entry: record.entry,
    };
  } catch {
    return {
      ok: false,
      status: 'not_controllable',
      entry: record.entry,
    };
  }
}

export function requestStopSubagentRuntimes(
  query: SubagentRuntimeBatchStopQuery,
): SubagentRuntimeBatchStopResult {
  const modes = Array.isArray(query.modes)
    ? new Set(
        query.modes.filter(
          (mode): mode is 'agent' | 'team' => mode === 'agent' || mode === 'team',
        ),
      )
    : null;
  const snapshot = _getRegistryLookup().loadRunRegistrySnapshot();
  const matches = [...snapshot.runs]
    .filter((item) => {
      if (!isActiveStatus(item.status)) return false;
      if (query.provider && item.provider !== query.provider) return false;
      if (query.groupFolder && item.groupFolder !== query.groupFolder) {
        return false;
      }
      if (query.chatJid && item.chatJid !== query.chatJid) return false;
      if (query.originTurnId && item.originTurnId !== query.originTurnId) {
        return false;
      }
      if (query.parentRuntimeId && item.parentRuntimeId !== query.parentRuntimeId) {
        return false;
      }
      if (modes && !modes.has(item.mode)) return false;
      return true;
    })
    .sort((left, right) => {
      const depthOrder = right.depth - left.depth;
      if (depthOrder !== 0) return depthOrder;
      return compareRunRecords(left, right);
    });

  const result: SubagentRuntimeBatchStopResult = {
    matchedIds: matches.map((item) => item.runtimeId),
    stopRequestedIds: [],
    alreadyStoppedIds: [],
    notControllableIds: [],
  };

  for (const item of matches) {
    const stopResult = requestStopSubagentRuntime(item.runtimeId);
    if (stopResult.status === 'stop_requested') {
      result.stopRequestedIds.push(item.runtimeId);
      continue;
    }
    if (stopResult.status === 'already_stopped') {
      result.alreadyStoppedIds.push(item.runtimeId);
      continue;
    }
    result.notControllableIds.push(item.runtimeId);
  }

  return result;
}
