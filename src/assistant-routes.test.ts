import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { registerAssistantRoutes } from './routes/assistant-routes.js';
import { SYSTEM_USER_ID } from './tenant/tenant-context.js';

const testRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const {
  listAssistantRepoBindings,
  createRepositoryBinding,
  createAssistantMcpBinding,
  createAssistant,
  deleteAssistant,
  deleteAssistantMcpBinding,
  deleteAssistantMcpBindingSecret,
  getAssistant,
  getAssistantMcpBinding,
  getAssistantMcpBindingSecret,
  getConversationListByAssistantId,
  getProvider,
  getVisibleProvidersForUser,
  listAssistantMcpBindingSecrets,
  listAssistantMcpBindings,
  listAssistants,
  listKnowledgeBases,
  listUserMcpServers,
  listUserSkills,
  updateAssistantMcpBinding,
  updateAssistant,
  upsertAssistantMcpBindingSecret,
  listRepositories,
  dbaTransaction,
  getRepositoryInfo,
  getProjectGraphOverview,
} = vi.hoisted(() => ({
  listAssistantRepoBindings: vi.fn(() => []),
  createRepositoryBinding: vi.fn(),
  createAssistantMcpBinding: vi.fn(),
  createAssistant: vi.fn(),
  deleteAssistant: vi.fn(),
  deleteAssistantMcpBinding: vi.fn(),
  deleteAssistantMcpBindingSecret: vi.fn(),
  getAssistant: vi.fn(),
  getAssistantMcpBinding: vi.fn(),
  getAssistantMcpBindingSecret: vi.fn(),
  getConversationListByAssistantId: vi.fn(() => []),
  getProvider: vi.fn(() => undefined),
  getVisibleProvidersForUser: vi.fn(() => []),
  listAssistantMcpBindingSecrets: vi.fn(() => []),
  listAssistantMcpBindings: vi.fn(() => []),
  listAssistants: vi.fn(() => []),
  listKnowledgeBases: vi.fn(() => []),
  listUserMcpServers: vi.fn(() => []),
  listUserSkills: vi.fn(() => []),
  updateAssistantMcpBinding: vi.fn(),
  updateAssistant: vi.fn(),
  upsertAssistantMcpBindingSecret: vi.fn(),
  listRepositories: vi.fn(() => []),
  dbaTransaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
  getRepositoryInfo: vi.fn(() => undefined),
  getProjectGraphOverview: vi.fn(),
}));

vi.mock('./db.js', () => ({
  createAssistantMcpBinding,
  createAssistant,
  deleteAssistant,
  deleteAssistantMcpBinding,
  deleteAssistantMcpBindingSecret,
  getAssistant,
  getAssistantMcpBinding,
  getAssistantMcpBindingSecret,
  getConversationListByAssistantId,
  getProvider,
  getVisibleProvidersForUser,
  listAssistantMcpBindingSecrets,
  listAssistantMcpBindings,
  listAssistants,
  listKnowledgeBases,
  listUserMcpServers,
  listUserSkills,
  updateAssistantMcpBinding,
  updateAssistant,
  upsertAssistantMcpBindingSecret,
}));

vi.mock('./db/repositories.js', () => ({
  listRepositories,
}));

vi.mock('./assistant-repo.js', () => ({
  listAssistantRepoBindings,
}));

vi.mock('./resource-binding-service.js', () => ({
  createRepositoryBinding,
}));

vi.mock('./repo-review/repository-service.js', () => ({
  getRepository: getRepositoryInfo,
}));

vi.mock('./project-graph/project-graph-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('./project-graph/project-graph-service.js')
    >();
  return {
    ...actual,
    getProjectGraphOverview,
  };
});

vi.mock('./db/engine-access.js', () => ({
  dba: {
    transaction: dbaTransaction,
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./auth/audit-middleware.js', () => ({
  auditAdminAction: vi.fn(async () => undefined),
  AUDIT_ACTIONS: {
    ASSISTANT_CREATE: 'assistant.create',
    ASSISTANT_DELETE: 'assistant.delete',
  },
}));

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve, reject) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
      next.on('error', reject);
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

describe('assistant routes', () => {
  it('rejects locked or replace mode when no rule text is configured', async () => {
    createAssistant.mockReset();
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '演示助手',
          config: {
            rules: {
              mode: 'locked',
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error:
          'rule mode "replace" or "locked" requires systemPrompt or extraInstructions',
      });
    });

    expect(createAssistant).not.toHaveBeenCalled();
  });

  it('allows append mode without custom rule text', async () => {
    createAssistant.mockReset();
    createAssistant.mockReturnValue({
      id: 'demo-assistant',
      name: '演示助手',
      description: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      config: {
        skillIds: [],
        mcpServerIds: [],
        rules: {
          mode: 'append',
          systemPrompt: null,
          extraInstructions: null,
        },
        providerId: null,
        model: null,
        accessPolicy: {
          mode: 'allowlist',
          directories: [],
        },
      },
    });
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '演示助手',
          config: {
            rules: {
              mode: 'append',
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        assistant: createAssistant.mock.results[0]?.value,
      });
    });

    expect(createAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '演示助手',
        config: expect.objectContaining({
          rules: expect.objectContaining({
            mode: 'append',
          }),
        }),
      }),
    );
  });

  it('returns assistant creation resources including skills, mcp templates, and repositories', async () => {
    listKnowledgeBases.mockReset();
    getVisibleProvidersForUser.mockReset();
    listRepositories.mockReset();
    listKnowledgeBases.mockReturnValue([
      {
        id: 'kb-private',
        name: 'Private KB',
        description: 'private',
        user_id: SYSTEM_USER_ID,
        visibility: 'private',
      },
    ]);
    getVisibleProvidersForUser.mockReturnValue([
      {
        id: 'provider-1',
        alias: 'Default Provider',
        type: 'openai',
        model: 'gpt-5.4',
        visibility: 'private',
      },
    ]);
    listRepositories.mockReturnValue([
      {
        id: 'repo-1',
        name: 'Demo Repo',
        clone_url: 'https://example.com/demo.git',
        local_repo_path: '/repos/demo',
        default_target_branch: 'develop',
        ai_description: 'demo repository',
        visibility: 'shared',
        enabled: 1,
        user_id: SYSTEM_USER_ID,
      },
    ]);
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => [
        {
          id: 'demo-skill',
          name: 'Demo Skill',
          description: 'demo',
          source: 'builtin',
          enabled: true,
        },
      ]),
      listAvailableManagedMcpServers: vi.fn(() => [
        {
          id: 'jira',
          name: 'Jira',
          command: 'node',
          args: ['jira.js'],
          env: { API_TOKEN: 'template-secret' },
          enabled: true,
        },
        {
          id: 'archery',
          name: 'Archery SQL',
          command: 'node',
          args: [
            'C:/project/kibana_archery_doris_mcp/mcp-node/archery/index.mjs',
          ],
          env: { TOKEN: 'old-template-secret' },
          enabled: true,
        },
      ]),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/assistants/available-resources`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          knowledgeBases: [
            expect.objectContaining({
              id: 'kb-private',
              name: 'Private KB',
            }),
          ],
          skills: [
            expect.objectContaining({
              id: 'demo-skill',
              name: 'Demo Skill',
              enabled: true,
            }),
          ],
          mcpTemplates: [
            expect.objectContaining({
              id: 'jira',
              name: 'Jira',
              envKeyCount: 1,
            }),
          ],
          repositories: [
            expect.objectContaining({
              id: 'repo-1',
              name: 'Demo Repo',
              defaultBranch: 'develop',
            }),
          ],
          providers: [
            expect.objectContaining({
              id: 'provider-1',
              alias: 'Default Provider',
            }),
          ],
        }),
      );
    });
  });

  it('returns assistants as a stable object payload', async () => {
    listAssistants.mockReset();
    listAssistants.mockReturnValue([
      {
        id: 'assistant-1',
        name: 'Assistant One',
        description: 'demo',
        enabled: true,
        config: {
          skillIds: [],
          mcpServerIds: [],
          rules: {
            mode: 'append',
            systemPrompt: null,
            extraInstructions: null,
          },
          providerId: null,
          model: null,
          accessPolicy: {
            mode: 'allowlist',
            directories: [],
          },
          persona: {
            role: '',
            style: '',
            guidelines: '',
            constraints: '',
          },
        },
        user_id: SYSTEM_USER_ID,
        visibility: 'shared',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        assistants: [
          expect.objectContaining({
            id: 'assistant-1',
            name: 'Assistant One',
          }),
        ],
      });
    });
  });

  it('returns assistant resource payload without secret values', async () => {
    getAssistant.mockReset();
    listAssistantMcpBindings.mockReset();
    listAssistantMcpBindingSecrets.mockReset();
    listAssistantRepoBindings.mockReset();
    getAssistant.mockReturnValue({
      id: 'demo-assistant',
      name: '演示助手',
      description: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      config: {
        skillIds: ['demo-skill'],
        mcpServerIds: ['jira'],
        rules: { mode: 'append' },
        providerId: null,
        model: null,
        accessPolicy: {
          mode: 'allowlist',
          directories: [],
        },
      },
    });
    listAssistantMcpBindings.mockReturnValue([
      {
        id: 'amb-demo-jira',
        assistant_id: 'demo-assistant',
        template_server_id: 'jira',
        alias: 'Jira MCP',
        enabled: 1,
        args_json: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    listAssistantMcpBindingSecrets.mockReturnValue([
      {
        binding_id: 'amb-demo-jira',
        env_json: JSON.stringify({ API_TOKEN: 'secret-value' }),
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    listAssistantRepoBindings.mockReturnValue([
      {
        id: 'arb-demo-main',
        assistant_id: 'demo-assistant',
        repository_id: 'repo-1',
        repo_url: 'https://example.com/demo.git',
        name: 'Demo Repo',
        description: 'Main development repository',
        local_path: 'D:/repos/demo',
        default_branch: 'main',
        branch_filter: ['main', 'release'],
        active_branch: 'main',
        worktree_path: 'D:/worktrees/demo-main',
        enabled: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => [
        {
          id: 'demo-skill',
          name: 'Demo Skill',
          description: 'demo',
          source: 'builtin',
          enabled: true,
        },
      ]),
      listAvailableManagedMcpServers: vi.fn(() => [
        {
          id: 'jira',
          name: 'Jira',
          command: 'node',
          args: ['jira.js'],
          env: { API_TOKEN: 'template-secret' },
          enabled: true,
        },
      ]),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/assistants/demo-assistant/resources`,
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, any>;
      expect(data.selectedSkillIds).toEqual(['demo-skill']);
      expect(data.availableMcpTemplates).toBeUndefined();
      expect(data.mcpBindings).toEqual([
        expect.objectContaining({
          id: 'amb-demo-jira',
          templateServerId: 'jira',
          templateName: 'Jira',
          secretStatus: {
            configured: true,
            keyCount: 1,
            updatedAt: '2024-01-02T00:00:00.000Z',
          },
        }),
      ]);
      expect(data.repoBindings).toEqual([
        expect.objectContaining({
          id: 'arb-demo-main',
          repositoryName: 'Demo Repo',
          defaultBranch: 'main',
          activeBranch: 'main',
          branchFilter: ['main', 'release'],
          enabled: true,
          worktreePath: 'D:/worktrees/demo-main',
        }),
      ]);
      expect(JSON.stringify(data)).not.toContain('secret-value');
      expect(JSON.stringify(data)).not.toContain('template-secret');
    });
  });

  it('syncs project graph recommended resources into assistant building blocks', async () => {
    getAssistant.mockReset();
    listAssistantMcpBindings.mockReset();
    listAssistantMcpBindingSecrets.mockReset();
    listAssistantRepoBindings.mockReset();
    getRepositoryInfo.mockReset();
    getProjectGraphOverview.mockReset();
    updateAssistant.mockReset();
    createAssistantMcpBinding.mockReset();
    dbaTransaction.mockClear();
    const onAssistantMutated = vi.fn();
    const assistantRecord = {
      id: 'demo-assistant',
      name: '演示助手',
      description: null,
      enabled: true,
      user_id: SYSTEM_USER_ID,
      visibility: 'private',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      config: {
        skillIds: [],
        mcpServerIds: [],
        userSkillIds: [],
        userMcpServerIds: [],
        kbIds: [],
        rules: { mode: 'append' },
        persona: {
          role: '',
          style: '',
          guidelines: '',
          constraints: '',
        },
        providerId: null,
        model: null,
      },
    };
    getAssistant.mockReturnValue(assistantRecord);
    updateAssistant.mockReturnValue({
      ...assistantRecord,
      config: {
        ...assistantRecord.config,
        skillIds: ['demo-skill'],
      },
    });
    createAssistantMcpBinding.mockReturnValue({
      id: 'amb-demo-assistant-jira',
      assistant_id: 'demo-assistant',
      template_server_id: 'jira',
      alias: null,
      enabled: 1,
      args_json: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    });
    listAssistantMcpBindings.mockReturnValue([]);
    listAssistantMcpBindingSecrets.mockReturnValue([]);
    listAssistantRepoBindings.mockReturnValue([
      {
        id: 'arb-demo-main',
        assistant_id: 'demo-assistant',
        repository_id: 'repo-1',
        repo_url: 'https://example.com/demo.git',
        name: 'Demo Repo',
        description: null,
        local_path: '/repos/demo',
        default_branch: 'main',
        branch_filter: [],
        active_branch: null,
        worktree_path: null,
        enabled: 1,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      },
    ]);
    getRepositoryInfo.mockReturnValue({
      id: 'repo-1',
      name: 'Demo Repo',
    });
    getProjectGraphOverview.mockReturnValue({
      repositoryId: 'repo-1',
      config: {
        enabled: true,
        scanners: [],
        skillIds: ['demo-skill', 'disabled-skill'],
        mcpServerIds: ['jira', 'missing-mcp'],
        includePaths: [],
        excludePaths: [],
        serviceNames: {
          production: '',
          testing: '',
          nacosKeys: [],
          logServiceNames: [],
        },
        owners: [],
        businessDomain: '',
        systemAliases: [],
        databaseBindings: [],
        logBindings: [],
      },
      latestRun: null,
      facts: [],
      edges: [],
      documents: [],
      runs: [],
    });
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => [
        {
          id: 'demo-skill',
          name: 'Demo Skill',
          description: 'demo',
          source: 'builtin',
          enabled: true,
        },
        {
          id: 'disabled-skill',
          name: 'Disabled Skill',
          description: 'disabled',
          source: 'builtin',
          enabled: false,
        },
      ]),
      listAvailableManagedMcpServers: vi.fn(() => [
        {
          id: 'jira',
          name: 'Jira',
          command: 'node',
          args: ['jira.js'],
          env: {},
          enabled: true,
        },
      ]),
      onAssistantMutated,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/assistants/demo-assistant/project-graph-resources/sync`,
        { method: 'POST' },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          added: {
            skillIds: ['demo-skill'],
            mcpServerIds: ['jira'],
          },
          skipped: expect.arrayContaining([
            {
              type: 'skill',
              id: 'disabled-skill',
              reason: 'disabled',
            },
            {
              type: 'mcp_template',
              id: 'missing-mcp',
              reason: 'unknown',
            },
          ]),
        }),
      );
    });

    expect(dbaTransaction).toHaveBeenCalled();
    expect(updateAssistant).toHaveBeenCalledWith(
      'demo-assistant',
      expect.objectContaining({
        config: expect.objectContaining({
          skillIds: ['demo-skill'],
        }),
      }),
    );
    expect(createAssistantMcpBinding).toHaveBeenCalledWith({
      assistantId: 'demo-assistant',
      templateServerId: 'jira',
      enabled: true,
    });
    expect(onAssistantMutated).toHaveBeenCalledWith('demo-assistant');
  });

  it('creates assistants with initial repository bindings in one request', async () => {
    createAssistant.mockReset();
    createRepositoryBinding.mockReset();
    dbaTransaction.mockClear();
    createAssistant.mockReturnValue({
      id: 'demo-assistant',
      name: '演示助手',
      description: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
      config: {
        skillIds: [],
        mcpServerIds: [],
        kbIds: [],
        rules: {
          mode: 'append',
          systemPrompt: null,
          extraInstructions: null,
        },
        persona: {
          role: '',
          style: '',
          guidelines: '',
          constraints: '',
        },
        providerId: null,
        model: null,
      },
      visibility: 'private',
      user_id: SYSTEM_USER_ID,
    });
    createRepositoryBinding.mockResolvedValue({
      id: 'binding-1',
      resourceType: 'repository',
      resourceId: 'repo-1',
      ownerType: 'assistant',
      ownerId: 'demo-assistant',
      bindingKey: 'default',
      branch: 'develop',
      workDirectory: null,
      config: {},
      createdAt: '2024-01-01T00:00:00.000Z',
      repositoryName: 'Demo Repo',
    });
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '演示助手',
          config: {
            rules: {
              mode: 'append',
            },
          },
          initialRepositoryBindings: [
            {
              repositoryId: 'repo-1',
              branch: 'develop',
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        assistant: createAssistant.mock.results[0]?.value,
      });
    });

    expect(dbaTransaction).toHaveBeenCalled();
    expect(createRepositoryBinding).toHaveBeenCalledWith(
      'assistant',
      'demo-assistant',
      'repo-1',
      {
        branch: 'develop',
      },
      SYSTEM_USER_ID,
    );
  });

  it('deletes an assistant when it is no longer referenced', async () => {
    getAssistant.mockReset();
    getAssistant.mockReturnValue({
      id: 'demo-assistant',
      user_id: SYSTEM_USER_ID,
    });
    deleteAssistant.mockReset();
    deleteAssistant.mockReturnValue(true);
    const auditMutation = vi.fn();
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation,
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants/demo-assistant`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    expect(deleteAssistant).toHaveBeenCalledWith('demo-assistant');
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'assistants.delete',
      'high',
    );
  });

  it('returns 409 when deleting an assistant that is still referenced', async () => {
    getAssistant.mockReset();
    getAssistant.mockReturnValue({
      id: 'demo-assistant',
      user_id: SYSTEM_USER_ID,
    });
    deleteAssistant.mockReset();
    deleteAssistant.mockImplementation(() => {
      throw new Error('该助手仍被2 个会话引用，请先解除绑定后再删除');
    });
    const app = express();
    app.use(express.json());
    registerAssistantRoutes(app, {
      requirePermission: testRequirePermission,
      auditMutation: vi.fn(),
      listAvailableManagedSkills: vi.fn(() => []),
      listAvailableManagedMcpServers: vi.fn(() => []),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/assistants/demo-assistant`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: '该助手仍被2 个会话引用，请先解除绑定后再删除',
      });
    });
  });
});
