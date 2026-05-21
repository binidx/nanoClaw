import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { registerCapabilityRoutes } from './routes/capability-routes.js';

const testRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

const {
  listAssistants,
  listAssistantMcpBindings,
  listUserMcpServers,
  listUserSkills,
  listAssistantRepoBindings,
  getRepositoryList,
  listWorkflows,
} = vi.hoisted(() => ({
  listAssistants: vi.fn(() => []),
  listAssistantMcpBindings: vi.fn(() => []),
  listUserMcpServers: vi.fn(() => []),
  listUserSkills: vi.fn(() => []),
  listAssistantRepoBindings: vi.fn(() => []),
  getRepositoryList: vi.fn(() => []),
  listWorkflows: vi.fn(() => []),
}));

vi.mock('./db.js', () => ({
  listAssistants,
  listAssistantMcpBindings,
  listUserMcpServers,
  listUserSkills,
}));

vi.mock('./assistant/assistant-repo.js', () => ({
  listAssistantRepoBindings,
}));

vi.mock('./repo-review/repository-service.js', () => ({
  getRepositoryList,
}));

vi.mock('./db/workflows.js', () => ({
  listWorkflows,
}));

vi.mock('./logger.js', () => ({
  createModuleLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
  logger: {
    error: vi.fn(),
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

describe('capability routes', () => {
  it('returns a composable capability catalog across assistants, repositories, skills, mcp, and workflows', async () => {
    listAssistants.mockReset();
    listAssistantMcpBindings.mockReset();
    listUserMcpServers.mockReset();
    listUserSkills.mockReset();
    listAssistantRepoBindings.mockReset();
    getRepositoryList.mockReset();
    listWorkflows.mockReset();

    listAssistants.mockReturnValue([
      {
        id: 'assistant-1',
        name: 'Dev Assistant',
        description: 'compose code resources',
        enabled: true,
        visibility: 'private',
        config: {
          skillIds: ['java-scanner'],
          mcpServerIds: [],
          userSkillIds: ['skill-user'],
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
      },
    ]);
    listAssistantRepoBindings.mockReturnValue([
      {
        id: 'repo-binding-1',
        assistant_id: 'assistant-1',
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
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
      },
    ]);
    listAssistantMcpBindings.mockReturnValue([
      {
        id: 'mcp-binding-1',
        assistant_id: 'assistant-1',
        template_server_id: 'nacos',
        alias: null,
        enabled: 1,
        args_json: null,
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
      },
    ]);
    getRepositoryList.mockReturnValue([
      {
        id: 'repo-1',
        name: 'Demo Repo',
        language: 'Java',
        localRepoPath: '/repos/demo',
        remoteProvider: 'gitlab',
        remoteRepoSlug: 'demo/repo',
        remoteBaseUrl: 'https://gitlab.example.com',
        cloneUrl: 'https://example.com/demo.git',
        defaultTargetBranch: 'main',
        sshKeyId: null,
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 30,
        lastAutoSyncAt: null,
        lastAutoSyncStatus: null,
        enabled: true,
        status: 'active',
        visibility: 'private',
        aiDescription: 'Demo service',
        techStack: ['Spring Boot'],
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
        features: [
          {
            featureType: 'project_graph',
            enabled: true,
            config: {
              skillIds: ['java-scanner'],
              mcpServerIds: ['nacos'],
              owners: ['team-platform'],
              serviceNames: { production: 'demo-prod' },
            },
          },
        ],
      },
    ]);
    listUserSkills.mockReturnValue([
      {
        id: 'skill-user',
        user_id: '__system__',
        name: 'User Skill',
        description: 'custom rule',
        summary: null,
        skill_content: null,
        metadata_json: null,
        enabled: 1,
        visibility: 'private',
        source_type: 'manual',
        source_ref: null,
        icon_url: null,
        tags_json: null,
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
      },
    ]);
    listUserMcpServers.mockReturnValue([]);
    listWorkflows.mockReturnValue([
      {
        id: 'workflow-1',
        name: 'Generic Workflow',
        description: 'compose steps',
        user_id: '__system__',
        status: 'draft',
        workflow_config: JSON.stringify({ editorMode: 'fixed_pipeline_v1' }),
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
      },
    ]);

    const app = express();
    app.use(express.json());
    registerCapabilityRoutes(app, {
      requirePermission: testRequirePermission,
      listAvailableManagedSkills: vi.fn(() => [
        {
          id: 'java-scanner',
          name: 'Java Scanner',
          description: 'scan Java services',
          source: 'builtin',
          enabled: true,
        },
      ]),
      listAvailableManagedMcpServers: vi.fn(() => [
        {
          id: 'nacos',
          name: 'Nacos',
          command: 'node',
          args: ['nacos.js'],
          env: {},
          enabled: true,
        },
      ]),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/capabilities/catalog`);
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        nodes: Array<{ id: string; type: string; capabilities: string[] }>;
        edges: Array<{ source: string; target: string; relation: string }>;
      };

      expect(data.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'assistant:assistant-1',
            type: 'assistant',
          }),
          expect.objectContaining({
            id: 'repository:repo-1',
            capabilities: expect.arrayContaining([
              'repository.provide_project_graph',
            ]),
          }),
          expect.objectContaining({
            id: 'project_graph:repo-1',
            type: 'project_graph',
          }),
          expect.objectContaining({ id: 'workflow:workflow-1' }),
        ]),
      );
      expect(data.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'assistant:assistant-1',
            target: 'repository:repo-1',
            relation: 'binds',
          }),
          expect.objectContaining({
            source: 'project_graph:repo-1',
            target: 'skill:java-scanner',
            relation: 'recommends',
          }),
          expect.objectContaining({
            source: 'assistant:assistant-1',
            target: 'mcp_template:nacos',
            relation: 'binds',
          }),
        ]),
      );
    });
  });
});
