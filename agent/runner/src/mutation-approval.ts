import fs from 'fs';
import path from 'path';

import { createBashApprovalCache } from './bash-approval-cache.js';
import {
  canWhitelistBashCommand,
  commandMatchesBashApprovalAllowlist,
  normalizeBashApprovalAllowlist,
} from './bash-approval-allowlist.js';

export interface AgentApprovalRequestPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AgentApprovalResolvedPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  decision: 'allow-once' | 'deny' | 'expired';
  resolvedAt: string;
}

interface ApprovalResponsePayload {
  decision?: 'allow-once' | 'deny';
  resolvedAt?: string;
  runtimeApprovalPatch?: {
    command?: string;
    expiresAt?: string;
    cwd?: string;
    scope?: 'current_tool_call' | 'current_runtime';
  };
}

type ApprovalEmitter = {
  emitApprovalRequest?: (payload: AgentApprovalRequestPayload) => void;
  emitApprovalResolved?: (payload: AgentApprovalResolvedPayload) => void;
};

const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const IPC_APPROVALS_DIR = path.join(IPC_BASE_DIR, 'approvals');
const IPC_APPROVAL_REQUESTS_DIR = path.join(IPC_APPROVALS_DIR, 'requests');
const IPC_APPROVAL_RESPONSES_DIR = path.join(IPC_APPROVALS_DIR, 'responses');
const APPROVAL_TIMEOUT_MS = 120000;
const APPROVAL_POLL_MS = 100;
const APPROVAL_ALLOWLIST = (() => {
  try {
    return normalizeBashApprovalAllowlist(
      process.env.NANOCLAW_BASH_APPROVAL_ALLOWLIST || '[]',
    );
  } catch {
    return [];
  }
})();

const mutationApprovalCache = createBashApprovalCache();
let approvalEmitter: ApprovalEmitter = {};

function ensureApprovalDirs(): void {
  fs.mkdirSync(IPC_APPROVAL_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(IPC_APPROVAL_RESPONSES_DIR, { recursive: true });
}

function getApprovalRequestPath(id: string): string {
  return path.join(IPC_APPROVAL_REQUESTS_DIR, `${id}.json`);
}

function getApprovalResponsePath(id: string): string {
  return path.join(IPC_APPROVAL_RESPONSES_DIR, `${id}.json`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function setApprovalEventEmitter(
  emitter: ApprovalEmitter | null | undefined,
): void {
  approvalEmitter = emitter || {};
}

export function matchesMutationAllowlist(command: string): boolean {
  return commandMatchesBashApprovalAllowlist(command, APPROVAL_ALLOWLIST);
}

export function canReuseApprovedMutation(input: {
  command: string;
  cwd?: string;
}): boolean {
  return mutationApprovalCache.has(input);
}

export function canWhitelistMutationCommand(command: string): boolean {
  return canWhitelistBashCommand(command);
}

export async function requestDirectoryAccessApproval(input: {
  toolCallId: string;
  toolName: string;
  targetPath: string;
}): Promise<'allow-once' | 'deny' | 'expired'> {
  const decision = await requestMutationApproval({
    toolCallId: input.toolCallId,
    toolName: 'DirectoryAccess',
    command: `access ${input.targetPath}`,
    cwd: input.targetPath,
    canWhitelist: false,
  });
  if (decision === 'allow-once') {
    const raw = process.env.NANOCLAW_ALLOWED_DIRS;
    let dirs: string[] = [];
    try {
      dirs = raw ? JSON.parse(raw) : [];
    } catch { /* empty */ }
    if (!dirs.includes(input.targetPath)) {
      dirs.push(input.targetPath);
      process.env.NANOCLAW_ALLOWED_DIRS = JSON.stringify(dirs);
    }
  }
  return decision;
}

export async function requestMutationApproval(input: {
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  canWhitelist?: boolean;
}): Promise<'allow-once' | 'deny' | 'expired'> {
  ensureApprovalDirs();

  const now = Date.now();
  const request: AgentApprovalRequestPayload = {
    id: `approval_${now}_${Math.random().toString(36).slice(2, 8)}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    command: input.command,
    cwd: input.cwd,
    canWhitelist: input.canWhitelist === true,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TIMEOUT_MS).toISOString(),
  };

  fs.writeFileSync(getApprovalRequestPath(request.id), JSON.stringify(request));
  approvalEmitter.emitApprovalRequest?.(request);

  const expiresAtMs = Date.parse(request.expiresAt);
  while (Date.now() < expiresAtMs) {
    const responsePath = getApprovalResponsePath(request.id);
    if (fs.existsSync(responsePath)) {
      try {
        const response = JSON.parse(
          fs.readFileSync(responsePath, 'utf-8'),
        ) as ApprovalResponsePayload;
        const decision =
          response.decision === 'allow-once' ? 'allow-once' : 'deny';
        if (
          decision === 'allow-once' &&
          response.runtimeApprovalPatch?.scope === 'current_runtime' &&
          response.runtimeApprovalPatch.command &&
          response.runtimeApprovalPatch.expiresAt
        ) {
          mutationApprovalCache.apply({
            command: response.runtimeApprovalPatch.command,
            cwd: response.runtimeApprovalPatch.cwd,
            expiresAt: response.runtimeApprovalPatch.expiresAt,
          });
        }
        approvalEmitter.emitApprovalResolved?.({
          id: request.id,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          decision,
          resolvedAt: response.resolvedAt || new Date().toISOString(),
        });
        return decision;
      } catch {
        approvalEmitter.emitApprovalResolved?.({
          id: request.id,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          decision: 'deny',
          resolvedAt: new Date().toISOString(),
        });
        return 'deny';
      }
    }

    await sleep(APPROVAL_POLL_MS);
  }

  approvalEmitter.emitApprovalResolved?.({
    id: request.id,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    decision: 'expired',
    resolvedAt: new Date().toISOString(),
  });
  return 'expired';
}
