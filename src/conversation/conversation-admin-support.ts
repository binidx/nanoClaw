import fs from 'fs';
import path from 'path';

import {
  createDefaultAccessPolicy,
  normalizeAccessMode,
  normalizeAccessPolicy,
} from '../auth/access-policy.js';
import { parseAllowedDirectoriesValue } from '../security/allowed-directories.js';
import { getConfig } from '../db.js';
import { getRegisteredGroup } from '../db.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { t } from '../i18n/index.js';

type ApprovalDecision = 'allow-once' | 'deny';
export type RuntimeApprovalPatchScope = 'current_tool_call' | 'current_runtime';
const RUNTIME_APPROVAL_PATCH_TTL_MS = 2 * 60_000;

export interface PendingApprovalRecord {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface RuntimeApprovalPatchRecord {
  id: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  source: 'approval';
  scope: RuntimeApprovalPatchScope;
  createdAt: string;
  resolvedAt: string;
  expiresAt: string;
}

export interface RuntimeApprovalPatchState {
  hasActivePatches: boolean;
  reusableCommandCount: number;
  activePatchCount: number;
  latestExpiresAt: string | null;
  affectsPersistentPolicy: false;
  summary: string;
}

function compareRuntimeApprovalPatches(
  left: RuntimeApprovalPatchRecord,
  right: RuntimeApprovalPatchRecord,
): number {
  return (
    left.resolvedAt.localeCompare(right.resolvedAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function summarizeRuntimeApprovalPatches(
  patches: RuntimeApprovalPatchRecord[],
): RuntimeApprovalPatchState {
  const activePatches = [...patches].sort(compareRuntimeApprovalPatches);
  const reusableCommandCount = activePatches.filter(
    (patch) => patch.scope === 'current_runtime',
  ).length;
  const latestExpiresAt =
    activePatches.length > 0
      ? activePatches
          .map((patch) => patch.expiresAt)
          .sort((left, right) => left.localeCompare(right))
          .at(-1) || null
      : null;

  return {
    hasActivePatches: activePatches.length > 0,
    reusableCommandCount,
    activePatchCount: activePatches.length,
    latestExpiresAt,
    affectsPersistentPolicy: false,
    summary:
      reusableCommandCount > 0
        ? `当前 runtime 内有 ${reusableCommandCount} 条可复用的临时命令授权；它们不会改写长期访问策略。`
        : t('errors.auto_1cab67', {}, undefined),
  };
}

export function createConversationAdminSupport(
  deps: {
    getRegisteredGroupByJid?: typeof getRegisteredGroup;
    getConfigEntry?: typeof getConfig;
    resolveGroupIpcPathEntry?: typeof resolveGroupIpcPath;
    logger?: { warn: (obj: object, msg: string) => void };
  } = {},
) {
  const readRegisteredGroup =
    deps.getRegisteredGroupByJid || getRegisteredGroup;
  const readConfig = deps.getConfigEntry || getConfig;
  const resolveIpcPath = deps.resolveGroupIpcPathEntry || resolveGroupIpcPath;
  const runtimeLogger = deps.logger || logger;
  const runtimeApprovalPatchesByJid = new Map<string, RuntimeApprovalPatchRecord[]>();

  function getApprovalPaths(groupFolder: string) {
    const ipcDir = resolveIpcPath(groupFolder);
    const approvalsDir = path.join(ipcDir, 'approvals');
    return {
      approvalsDir,
      requestsDir: path.join(approvalsDir, 'requests'),
      responsesDir: path.join(approvalsDir, 'responses'),
    };
  }

  function ensureApprovalDirs(groupFolder: string) {
    const paths = getApprovalPaths(groupFolder);
    fs.mkdirSync(paths.requestsDir, { recursive: true });
    fs.mkdirSync(paths.responsesDir, { recursive: true });
    return paths;
  }

  async function getConversationGroupFolder(jid: string): Promise<string | null> {
    const group = await readRegisteredGroup(jid);
    return group?.folder || null;
  }

  async function readPendingApprovalsForConversation(
    jid: string,
  ): Promise<PendingApprovalRecord[]> {
    const groupFolder = await getConversationGroupFolder(jid);
    if (!groupFolder) return [];
    const { requestsDir, responsesDir } = ensureApprovalDirs(groupFolder);
    const now = Date.now();
    const approvals: PendingApprovalRecord[] = [];

    for (const entry of fs.readdirSync(requestsDir)) {
      if (!entry.endsWith('.json')) continue;
      const requestPath = path.join(requestsDir, entry);
      try {
        const request = JSON.parse(
          fs.readFileSync(requestPath, 'utf-8'),
        ) as PendingApprovalRecord;
        if (!request?.id) continue;
        if (fs.existsSync(path.join(responsesDir, `${request.id}.json`))) {
          continue;
        }
        if (Date.parse(request.expiresAt) <= now) continue;
        approvals.push(request);
      } catch (err) {
        runtimeLogger.warn(
          { err, requestPath },
          'Failed to read approval request',
        );
      }
    }

    approvals.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    return approvals;
  }

  function pruneRuntimeApprovalPatchesForConversation(
    jid: string,
  ): RuntimeApprovalPatchRecord[] {
    const now = Date.now();
    const next = (runtimeApprovalPatchesByJid.get(jid) || [])
      .filter((patch) => Date.parse(patch.expiresAt) > now)
      .sort(compareRuntimeApprovalPatches);
    if (next.length > 0) {
      runtimeApprovalPatchesByJid.set(jid, next);
    } else {
      runtimeApprovalPatchesByJid.delete(jid);
    }
    return next;
  }

  function readActiveRuntimeApprovalPatchesForConversation(
    jid: string,
  ): RuntimeApprovalPatchRecord[] {
    return pruneRuntimeApprovalPatchesForConversation(jid);
  }

  function clearRuntimeApprovalPatchesForConversation(jid: string): void {
    runtimeApprovalPatchesByJid.delete(jid);
  }

  async function writeApprovalDecisionForConversation(
    jid: string,
    approvalId: string,
    decision: ApprovalDecision,
    scope: RuntimeApprovalPatchScope = 'current_runtime',
  ): Promise<PendingApprovalRecord> {
    const groupFolder = await getConversationGroupFolder(jid);
    if (!groupFolder) {
      throw new Error('Conversation not found');
    }
    const { requestsDir, responsesDir } = ensureApprovalDirs(groupFolder);
    const requestPath = path.join(requestsDir, `${approvalId}.json`);
    const responsePath = path.join(responsesDir, `${approvalId}.json`);
    if (!fs.existsSync(requestPath)) {
      throw new Error('Approval request not found');
    }
    if (fs.existsSync(responsePath)) {
      throw new Error('Approval request already resolved');
    }

    const request = JSON.parse(
      fs.readFileSync(requestPath, 'utf-8'),
    ) as PendingApprovalRecord;
    if (Date.parse(request.expiresAt) <= Date.now()) {
      throw new Error('Approval request expired');
    }
    const resolvedAt = new Date().toISOString();
    const runtimeApprovalPatch =
      decision === 'allow-once'
        ? {
            id: `patch:${approvalId}`,
            approvalId,
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            command: request.command,
            cwd: request.cwd,
            source: 'approval' as const,
            scope,
            createdAt: request.createdAt,
            resolvedAt,
            expiresAt: new Date(
              Date.now() + RUNTIME_APPROVAL_PATCH_TTL_MS,
            ).toISOString(),
          }
        : null;

    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        id: approvalId,
        decision,
        resolvedAt,
        ...(runtimeApprovalPatch ? { runtimeApprovalPatch } : {}),
      }),
    );

    if (runtimeApprovalPatch && scope === 'current_runtime') {
      const active = pruneRuntimeApprovalPatchesForConversation(jid).filter(
        (patch) => patch.id !== runtimeApprovalPatch.id,
      );
      active.push(runtimeApprovalPatch);
      runtimeApprovalPatchesByJid.set(jid, active);
    }

    return request;
  }

  async function getDefaultConversationAccessPolicy() {
    let directories: string[] = [];
    try {
      directories = parseAllowedDirectoriesValue(
        await readConfig('allowed_directories'),
      );
    } catch (err) {
      runtimeLogger.warn(
        { err },
        'Invalid default allowed_directories config; ignoring defaults',
      );
    }
    return normalizeAccessPolicy(
      {
        mode: normalizeAccessMode(
          await readConfig('DEFAULT_ACCESS_MODE'),
          'allowall',
        ),
        directories,
      },
      {
        fallback: createDefaultAccessPolicy('allowall'),
      },
    );
  }

  async function getDefaultConversationAllowedDirectories(): Promise<string[]> {
    return (await getDefaultConversationAccessPolicy()).directories;
  }

  function normalizeAccessPolicyInput(value: unknown) {
    return normalizeAccessPolicy(value, {
      fallback: createDefaultAccessPolicy('allowall'),
    });
  }

  function normalizeAllowedDirectoriesInput(value: unknown): string[] {
    if (value === undefined) return [];
    return normalizeAccessPolicy(
      { mode: 'allowlist', directories: value },
      {
        fallback: createDefaultAccessPolicy('allowlist'),
      },
    ).directories;
  }

  return {
    readPendingApprovalsForConversation,
    readActiveRuntimeApprovalPatchesForConversation,
    clearRuntimeApprovalPatchesForConversation,
    writeApprovalDecisionForConversation,
    getDefaultConversationAccessPolicy,
    getDefaultConversationAllowedDirectories,
    normalizeAccessPolicyInput,
    normalizeAllowedDirectoriesInput,
  };
}
