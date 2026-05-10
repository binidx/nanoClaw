import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { registerConversationAdminRoutes } from './routes/conversation-admin-routes.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const { updateConversationMeta } = vi.hoisted(() => ({
  updateConversationMeta: vi.fn(),
}));

const {
  getConversationMessages,
  getConversationSummaryByJid,
  getMessageCount,
} = vi.hoisted(() => ({
  getConversationMessages: vi.fn(() => []),
  getConversationSummaryByJid: vi.fn(() => null),
  getMessageCount: vi.fn(() => 0),
}));

vi.mock('./config-store.js', () => ({
  getAssistantName: vi.fn(() => 'Andy'),
  getConversationCreationMetadata: vi.fn(() => null),
}));

vi.mock('./assistant-runtime.js', () => ({
  resolveAssistantRuntimeConfig: vi.fn(() => ({
    accessPolicyOverride: {
      mode: 'allowlist',
      directories: ['/srv/projects'],
    },
    allowedDirectoriesOverride: ['/srv/projects'],
  })),
}));

vi.mock('./db.js', () => ({
  deleteConversation: vi.fn(),
  deleteConversationMessages: vi.fn(),
  deleteRegisteredGroup: vi.fn(),
  deleteSessionByJid: vi.fn(),
  getConversationMessages,
  getConversationSummaryByJid,
  getMessageCount,
  getRegisteredGroup: vi.fn(() => null),
  updateConversationMeta,
}));

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./channels/web.js', () => ({
  getWebChannel: vi.fn(() => null),
}));

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('conversation admin routes', () => {
  it('returns runtime approval patches with conversation access payload', async () => {
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      readActiveRuntimeApprovalPatchesForConversation: vi.fn(() => [
        {
          id: 'patch:a1',
          approvalId: 'a1',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          command: 'git status',
          source: 'approval',
          scope: 'current_runtime',
          createdAt: '2024-01-01T00:00:00.000Z',
          resolvedAt: '2024-01-01T00:00:05.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      ]),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearRuntimeApprovalPatchesForConversation: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/access`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        accessPolicy: {
          mode: 'allowall',
          directories: [],
          inheritedFrom: 'global',
          source: 'global',
          locked: false,
          editable: true,
        },
        allowedDirectories: [],
        policyLayers: {
          global: {
            mode: 'allowall',
            directories: [],
          },
          assistant: null,
          conversation: null,
        },
        runtimeApprovalPatches: [
          {
            id: 'patch:a1',
            approvalId: 'a1',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            command: 'git status',
            source: 'approval',
            scope: 'current_runtime',
            createdAt: '2024-01-01T00:00:00.000Z',
            resolvedAt: '2024-01-01T00:00:05.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        ],
        runtimeAccess: {
          hasActivePatches: true,
          reusableCommandCount: 1,
          activePatchCount: 1,
          latestExpiresAt: '2099-01-01T00:00:00.000Z',
          affectsPersistentPolicy: false,
          summary:
            '当前 runtime 内有 1 条可复用的临时命令授权；它们不会改写长期访问策略。',
        },
        effectiveAccess: {
          persistentPolicy: {
            mode: 'allowall',
            directories: [],
            inheritedFrom: 'global',
            locked: false,
            editable: true,
          },
          temporaryCommandReuseCount: 1,
          temporaryApprovedDirectories: [],
          hasTemporaryElevation: true,
          summary:
            '当前长期策略来自全局默认，模式为允许全部；另有 1 条当前 runtime 的临时命令放行。',
        },
        nextActions: [
          {
            id: 'manage_default_policy',
            title: '升级为默认配置',
            description:
              '如果多数新会话都需要同样权限，优先去设置页修改“默认访问策略”，不要逐个会话重复配置。',
            target: {
              type: 'settings_default_access',
              label: '去默认配置',
            },
          },
          {
            id: 'review_runtime_approval',
            title: '保留临时放行',
            description:
              '当前 runtime 内有 1 条可复用的临时命令授权；它们不会改写长期访问策略。',
          },
        ],
      });
    });
  });

  it('reports assistant-managed policy layers and no runtime patch state separately', async () => {
    const { getRegisteredGroup } = await import('./db.js');
    vi.mocked(getRegisteredGroup).mockReturnValueOnce({
      jid: 'web:test',
      folder: 'group-1',
      assistantId: 'assistant-1',
      agentConfig: {
        accessPolicy: {
          mode: 'readonly',
          directories: ['/tmp/legacy'],
        },
      },
    } as any);

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      readActiveRuntimeApprovalPatchesForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearRuntimeApprovalPatchesForConversation: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: ['/srv/global'],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/access`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        accessPolicy: {
          mode: 'readonly',
          directories: ['/tmp/legacy'],
          inheritedFrom: 'conversation',
          source: 'conversation',
          locked: false,
          editable: true,
        },
        policyLayers: {
          global: {
            mode: 'allowall',
            directories: ['/srv/global'],
          },
          assistant: null,
        },
        runtimeAccess: {
          hasActivePatches: false,
          reusableCommandCount: 0,
          activePatchCount: 0,
          latestExpiresAt: null,
          affectsPersistentPolicy: false,
          summary:
            '当前没有可复用的 runtime 临时授权；系统仅按长期访问策略执行。',
        },
        effectiveAccess: {
          persistentPolicy: {
            mode: 'readonly',
            directories: ['/tmp/legacy'],
            inheritedFrom: 'conversation',
            locked: false,
            editable: true,
          },
          temporaryCommandReuseCount: 0,
          temporaryApprovedDirectories: [],
          hasTemporaryElevation: false,
          summary:
            '当前按当前对话的只读长期策略执行，没有额外的 runtime 临时放行。',
        },
        nextActions: [
          {
            id: 'promote_conversation_policy',
            title: '调整会话独立策略',
            description:
              '当前改动只影响这个会话；如果多数会话都需要类似配置，建议去默认配置统一设置。',
            target: {
              type: 'settings_default_access',
              label: '去默认配置',
            },
          },
          {
            id: 'prefer_runtime_approval',
            title: '临时问题先用审批',
            description:
              '如果只想放行一次命令，直接在审批卡里选择“仅当前命令”或“当前 runtime”即可，无需改长期策略。',
          },
        ],
      });
    });
  });

  it('clears runtime approval patches when resetting or deleting a conversation', async () => {
    const clearRuntimeApprovalPatchesForConversation = vi.fn();
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      readActiveRuntimeApprovalPatchesForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearRuntimeApprovalPatchesForConversation,
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const resetResponse = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/reset`,
        { method: 'POST' },
      );
      expect(resetResponse.status).toBe(200);

      const deleteResponse = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}`,
        { method: 'DELETE' },
      );
      expect(deleteResponse.status).toBe(200);
    });

    expect(clearRuntimeApprovalPatchesForConversation).toHaveBeenCalledTimes(2);
    expect(clearRuntimeApprovalPatchesForConversation).toHaveBeenNthCalledWith(
      1,
      'web:test',
    );
    expect(clearRuntimeApprovalPatchesForConversation).toHaveBeenNthCalledWith(
      2,
      'web:test',
    );
  });

  it('passes approval scope through resolve endpoint', async () => {
    const writeApprovalDecisionForConversation = vi.fn(() => ({
      id: 'a1',
      toolCallId: 'tool-1',
      toolName: 'Bash',
    }));
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      readActiveRuntimeApprovalPatchesForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation,
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearRuntimeApprovalPatchesForConversation: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/approvals/a1`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'allow-once',
            scope: 'current_tool_call',
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(writeApprovalDecisionForConversation).toHaveBeenCalledWith(
        'web:test',
        'a1',
        'allow-once',
        'current_tool_call',
      );
    });
  });

  it('rejects per-conversation directory overrides for assistant-managed chats', async () => {
    updateConversationMeta.mockReset();
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(() => {
        throw new Error(
          'Assistant-managed conversations do not support conversation-level directory overrides',
        );
      }),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn((value) =>
        value && typeof value === 'object'
          ? {
              mode: 'allowlist' as const,
              directories: Array.isArray((value as { directories?: unknown }).directories)
                ? ((value as { directories: unknown[] }).directories.filter((entry) =>
                    typeof entry === 'string',
                  ) as string[])
                : [],
            }
          : { mode: 'allowall' as const, directories: [] },
      ),
      normalizeAllowedDirectoriesInput: vi.fn((value) =>
        Array.isArray(value) ? value.map((entry) => String(entry)) : [],
      ),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowedDirectories: ['/tmp/project'] }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error:
          'Assistant-managed conversations do not support conversation-level directory overrides',
      });
    });

    expect(updateConversationMeta).not.toHaveBeenCalled();
  });

  it('rejects attempts to persist approvals into the global allowlist', async () => {
    updateConversationMeta.mockReset();
    const writeApprovalDecisionForConversation = vi.fn(() => ({
      id: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      command: 'git push origin main',
    }));

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => [
        {
          id: 'approval-1',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          command: 'git push origin main',
          createdAt: '2026-03-18T00:00:00.000Z',
          expiresAt: '2026-03-18T00:02:00.000Z',
        },
      ]),
      writeApprovalDecisionForConversation,
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/approvals/${encodeURIComponent('approval-1')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'allow-and-whitelist' }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'decision must be "allow-once" or "deny"',
      });
    });

    expect(writeApprovalDecisionForConversation).not.toHaveBeenCalled();
  });

  it('interrupts the active reply before resetting runtime when conversation access changes', async () => {
    updateConversationMeta.mockReset();
    const callOrder: string[] = [];
    const updateConversationAccessPolicy = vi.fn(async () => {
      callOrder.push('update-access');
      return {
        folder: 'web_test',
        accessPolicy: {
          mode: 'readonly' as const,
          directories: ['/tmp/project'],
        },
      };
    });
    const interruptConversationReply = vi.fn(() => {
      callOrder.push('interrupt');
      return true;
    });
    const clearRuntimeApprovalPatchesForConversation = vi.fn(() => {
      callOrder.push('clear-patches');
    });
    const resetConversationRuntime = vi.fn(() => {
      callOrder.push('reset-runtime');
    });

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy,
      interruptConversationReply,
      resetConversationRuntime,
      clearRuntimeApprovalPatchesForConversation,
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'readonly' as const,
        directories: ['/tmp/project'],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessPolicy: {
              mode: 'readonly',
              directories: ['/tmp/project'],
            },
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    });

    expect(interruptConversationReply).toHaveBeenCalledWith('web:test');
    expect(resetConversationRuntime).toHaveBeenCalledWith('web:test', 'web_test');
    expect(callOrder).toEqual([
      'update-access',
      'interrupt',
      'clear-patches',
      'reset-runtime',
    ]);
  });

  it('regenerates the latest assistant reply and clears runtime approval patches first', async () => {
    const callOrder: string[] = [];
    const regenerateConversationReply = vi.fn(async () => {
      callOrder.push('regenerate');
    });
    const clearRuntimeApprovalPatchesForConversation = vi.fn(() => {
      callOrder.push('clear-patches');
    });

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      regenerateConversationReply,
      clearRuntimeApprovalPatchesForConversation,
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: 'turn-1' }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    expect(regenerateConversationReply).toHaveBeenCalledWith('web:test', 'turn-1');
    expect(callOrder).toEqual(['clear-patches', 'regenerate']);
  });

  it('returns 409 when only a non-latest reply is eligible for regeneration', async () => {
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      regenerateConversationReply: vi.fn(async () => {
        throw new Error('Only the latest assistant reply can be regenerated');
      }),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: 'turn-old' }),
        },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'Only the latest assistant reply can be regenerated',
      });
    });
  });

  it('creates a Feishu cloud doc from structured sections for a Feishu conversation', async () => {
    getConversationSummaryByJid.mockReturnValueOnce({
      jid: 'feishu:oc_review_chat',
      name: 'Review Chat',
      display_name: 'Review Chat',
      channel: 'feishu',
      is_group: 1,
    } as any);
    const createConversationFeishuDoc = vi.fn(async () => ({
      documentId: 'doccn123',
      url: 'https://tenant.feishu.cn/docx/doccn123',
      resultStatus: 'success',
    }));

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
      createConversationFeishuDoc,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('feishu:oc_review_chat')}/feishu-docs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: '排查记录',
            contentMode: 'recent_transcript',
            text: '请整理成云文档',
            sections: [
              { kind: 'heading', level: 1, text: '排查记录' },
              { kind: 'paragraph', text: '结论...' },
            ],
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        documentId: 'doccn123',
        url: 'https://tenant.feishu.cn/docx/doccn123',
        resultStatus: 'success',
      });
    });

    expect(createConversationFeishuDoc).toHaveBeenCalledWith({
      chatJid: 'feishu:oc_review_chat',
      title: '排查记录',
      conversationType: 'group',
      sections: [
        { kind: 'heading', level: 1, text: '排查记录' },
        { kind: 'paragraph', text: '结论...' },
      ],
    });
  });

  it('creates a Feishu cloud doc from plain text content', async () => {
    getConversationSummaryByJid.mockReturnValueOnce({
      jid: 'feishu:oc_dm_chat',
      name: 'Alice',
      display_name: 'Alice',
      channel: 'feishu',
      is_group: 0,
    } as any);
    const createConversationFeishuDoc = vi.fn(async () => ({
      documentId: 'doccn456',
      url: 'https://tenant.feishu.cn/docx/doccn456',
      resultStatus: 'success',
    }));

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
      createConversationFeishuDoc,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('feishu:oc_dm_chat')}/feishu-docs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: '整理记录',
            text: '第一段\n\n第二段',
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        documentId: 'doccn456',
        url: 'https://tenant.feishu.cn/docx/doccn456',
        resultStatus: 'success',
      });
    });

    expect(createConversationFeishuDoc).toHaveBeenCalledWith({
      chatJid: 'feishu:oc_dm_chat',
      title: '整理记录',
      conversationType: 'dm',
      sections: [
        { kind: 'paragraph', text: '第一段' },
        { kind: 'paragraph', text: '第二段' },
      ],
    });
  });

  it('rejects Feishu cloud docs for non-Feishu conversations', async () => {
    const createConversationFeishuDoc = vi.fn();
    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
      createConversationFeishuDoc,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('web:test')}/feishu-docs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: '排查记录',
            text: '请整理成云文档',
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Feishu cloud docs are only supported for feishu conversations',
      });
    });

    expect(createConversationFeishuDoc).not.toHaveBeenCalled();
  });

  it('returns ok=false and a failure message when Feishu cloud doc creation does not complete successfully', async () => {
    getConversationSummaryByJid.mockReturnValueOnce({
      jid: 'feishu:oc_dm_chat',
      name: 'Alice',
      display_name: 'Alice',
      channel: 'feishu',
      is_group: 0,
    } as any);
    const createConversationFeishuDoc = vi.fn(async () => ({
      documentId: 'doccn456',
      url: '',
      resultStatus: 'content_population_failed',
      authorizationWarnings: [],
    }));

    const app = express();
    app.use(express.json());
    registerConversationAdminRoutes(app, {
      requirePermission: allowAllRequirePermission,
      auditMutation: vi.fn(),
      readPendingApprovalsForConversation: vi.fn(() => []),
      writeApprovalDecisionForConversation: vi.fn(),
      updateConversationAccessPolicy: vi.fn(),
      resetConversationRuntime: vi.fn(),
      clearCodexConversationState: vi.fn(),
      getDefaultConversationAccessPolicy: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAccessPolicyInput: vi.fn(() => ({
        mode: 'allowall' as const,
        directories: [],
      })),
      normalizeAllowedDirectoriesInput: vi.fn(() => []),
      createConversationFeishuDoc,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${encodeURIComponent('feishu:oc_dm_chat')}/feishu-docs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: '整理记录',
            text: '第一段',
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        documentId: 'doccn456',
        url: '',
        resultStatus: 'content_population_failed',
        authorizationWarnings: [],
        message: 'Feishu cloud doc content population failed.',
      });
    });
  });
});
