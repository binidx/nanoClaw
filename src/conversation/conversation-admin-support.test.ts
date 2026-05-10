import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConversationAdminSupport,
  type PendingApprovalRecord,
  summarizeRuntimeApprovalPatches,
} from './conversation-admin-support.js';

describe('conversation-admin-support', () => {
  let tempDir = '';
  let requestsDir = '';
  let responsesDir = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-approvals-'));
    requestsDir = path.join(tempDir, 'ipc', 'approvals', 'requests');
    responsesDir = path.join(tempDir, 'ipc', 'approvals', 'responses');
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.mkdirSync(responsesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads only unresolved and unexpired approvals for a conversation', async () => {
    const now = Date.now();
    const valid: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date(now - 2000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    const expired: PendingApprovalRecord = {
      ...valid,
      id: 'a2',
      createdAt: new Date(now - 4000).toISOString(),
      expiresAt: new Date(now - 1000).toISOString(),
    };
    const resolved: PendingApprovalRecord = {
      ...valid,
      id: 'a3',
      createdAt: new Date(now - 1000).toISOString(),
    };
    fs.writeFileSync(path.join(requestsDir, 'a1.json'), JSON.stringify(valid));
    fs.writeFileSync(
      path.join(requestsDir, 'a2.json'),
      JSON.stringify(expired),
    );
    fs.writeFileSync(
      path.join(requestsDir, 'a3.json'),
      JSON.stringify(resolved),
    );
    fs.writeFileSync(
      path.join(responsesDir, 'a3.json'),
      JSON.stringify({ id: 'a3', decision: 'deny' }),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    expect(await support.readPendingApprovalsForConversation('jid')).toEqual([
      valid,
    ]);
  });

  it('writes approval decisions to response files', async () => {
    const request: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(requestsDir, 'a1.json'),
      JSON.stringify(request),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    expect(
      await support.writeApprovalDecisionForConversation('jid', 'a1', 'allow-once'),
    ).toEqual(request);
    expect(fs.existsSync(path.join(responsesDir, 'a1.json'))).toBe(true);
    expect(
      support.readActiveRuntimeApprovalPatchesForConversation('jid'),
    ).toEqual([
      expect.objectContaining({
        id: 'patch:a1',
        approvalId: 'a1',
        toolCallId: 'tool-1',
        toolName: 'shell',
        command: 'echo hi',
        source: 'approval',
        scope: 'current_runtime',
      }),
    ]);
  });

  it('clears runtime approval patches when the runtime is reset', async () => {
    const request: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(requestsDir, 'a1.json'),
      JSON.stringify(request),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    await support.writeApprovalDecisionForConversation('jid', 'a1', 'allow-once');
    expect(support.readActiveRuntimeApprovalPatchesForConversation('jid')).toHaveLength(1);
    support.clearRuntimeApprovalPatchesForConversation('jid');
    expect(support.readActiveRuntimeApprovalPatchesForConversation('jid')).toEqual([]);
  });

  it('does not persist runtime patches for current_tool_call scope', async () => {
    const request: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(requestsDir, 'a1.json'),
      JSON.stringify(request),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    await support.writeApprovalDecisionForConversation(
      'jid',
      'a1',
      'allow-once',
      'current_tool_call',
    );
    expect(support.readActiveRuntimeApprovalPatchesForConversation('jid')).toEqual([]);
  });

  it('summarizes runtime approval patches without treating them as persistent policy', () => {
    const summary = summarizeRuntimeApprovalPatches([
      {
        id: 'patch:a1',
        approvalId: 'a1',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        command: 'git status',
        source: 'approval',
        scope: 'current_runtime',
        createdAt: '2026-03-18T12:00:00.000Z',
        resolvedAt: '2026-03-18T12:00:05.000Z',
        expiresAt: '2026-03-18T12:02:05.000Z',
      },
    ]);

    expect(summary).toEqual({
      hasActivePatches: true,
      reusableCommandCount: 1,
      activePatchCount: 1,
      latestExpiresAt: '2026-03-18T12:02:05.000Z',
      affectsPersistentPolicy: false,
      summary:
        '当前 runtime 内有 1 条可复用的临时命令授权；它们不会改写长期访问策略。',
    });
  });

  it('rejects expired approval requests', async () => {
    const request: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(requestsDir, 'a1.json'),
      JSON.stringify(request),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    await expect(
      support.writeApprovalDecisionForConversation('jid', 'a1', 'allow-once'),
    ).rejects.toThrow('Approval request expired');
    expect(fs.existsSync(path.join(responsesDir, 'a1.json'))).toBe(false);
  });

  it('rejects approvals that were already resolved', async () => {
    const request: PendingApprovalRecord = {
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'shell',
      command: 'echo hi',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    fs.writeFileSync(
      path.join(requestsDir, 'a1.json'),
      JSON.stringify(request),
    );
    fs.writeFileSync(
      path.join(responsesDir, 'a1.json'),
      JSON.stringify({
        id: 'a1',
        decision: 'deny',
        resolvedAt: new Date().toISOString(),
      }),
    );

    const support = createConversationAdminSupport({
      getRegisteredGroupByJid: () => ({ folder: 'group-1' }) as any,
      resolveGroupIpcPathEntry: () => path.join(tempDir, 'ipc'),
      logger: { warn: vi.fn() },
    });

    await expect(
      support.writeApprovalDecisionForConversation('jid', 'a1', 'allow-once'),
    ).rejects.toThrow('Approval request already resolved');
  });

  it('normalizes default and explicit allowed directories', async () => {
    const tempA = fs.mkdtempSync(path.join(tempDir, 'allowed-a-'));
    const tempB = fs.mkdtempSync(path.join(tempDir, 'allowed-b-'));
    const support = createConversationAdminSupport({
      getConfigEntry: (key: string) =>
        key === 'allowed_directories'
          ? JSON.stringify([tempA, tempA, tempB])
          : '',
      logger: { warn: vi.fn() },
    });

    expect(await support.getDefaultConversationAllowedDirectories()).toEqual([
      fs.realpathSync(tempA),
      fs.realpathSync(tempB),
    ]);
    expect(
      support.normalizeAllowedDirectoriesInput([tempA, tempA, 1, '']),
    ).toEqual([fs.realpathSync(tempA)]);
  });
});
