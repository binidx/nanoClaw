import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfigMock, setConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(() => ''),
  setConfigMock: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getConfig: getConfigMock,
  setConfig: setConfigMock,
}));

vi.mock('./runtime-customization.js', () => ({
  CUSTOM_SKILLS_ROOT: '/tmp/skills',
  deleteCustomSkill: vi.fn(),
  listManagedSkills: () => [],
  normalizeManagedMcpServers: (value: unknown) => value,
  parseEnabledSkillsConfig: () => new Set<string>(),
  parseSubagentsConfig: (raw: unknown) => {
    const text = String(raw || '').trim();
    if (!text) return { enabled: true, maxDepth: 2, maxActive: 4 };
    try {
      const parsed = JSON.parse(text) as {
        enabled?: unknown;
        maxDepth?: unknown;
        maxActive?: unknown;
      };
      return {
        enabled: parsed.enabled !== false,
        maxDepth:
          typeof parsed.maxDepth === 'number' && Number.isFinite(parsed.maxDepth)
            ? Math.max(1, Math.min(5, Math.trunc(parsed.maxDepth)))
            : 2,
        maxActive:
          typeof parsed.maxActive === 'number' &&
          Number.isFinite(parsed.maxActive)
            ? Math.max(1, Math.min(16, Math.trunc(parsed.maxActive)))
            : 4,
      };
    } catch {
      return { enabled: true, maxDepth: 2, maxActive: 4 };
    }
  },
  serializeEnabledSkillsConfig: () => '[]',
  serializeSubagentsConfig: (value: unknown) => JSON.stringify(value),
  WEB_ENABLED_SKILLS_CONFIG_KEY: 'WEB_ENABLED_SKILLS',
  WEB_SUBAGENTS_CONFIG_KEY: 'WEB_SUBAGENTS',
  writeCustomSkill: vi.fn(),
}));

vi.mock('../workspace-cleanup.js', () => ({
  cleanupOrphanWorkspaces: vi.fn(async () => ({ removed: [] })),
  scanOrphanWorkspaces: vi.fn(() => ({ items: [] })),
}));

const {
  getSubagentRuntimeMock,
  requestStopSubagentRuntimeMock,
  requestMessageSubagentRuntimeMock,
  requestSteerSubagentRuntimeMock,
} = vi.hoisted(() => ({
  getSubagentRuntimeMock: vi.fn((id: string) =>
    id === 'subagent-2'
      ? {
          id: 'subagent-2',
          provider: 'claude',
          controlState: 'read_only',
          controllable: false,
        }
      : id === 'subagent-3'
        ? {
            id: 'subagent-3',
            provider: 'codex',
            controlState: 'controllable',
            controllable: true,
          }
        : null,
  ),
  requestStopSubagentRuntimeMock: vi.fn(),
  requestMessageSubagentRuntimeMock: vi.fn(),
  requestSteerSubagentRuntimeMock: vi.fn(),
}));
vi.mock('../subagent/subagent-runtime-registry.js', () => ({
  getSubagentRuntime: getSubagentRuntimeMock,
  requestStopSubagentRuntime: requestStopSubagentRuntimeMock,
  requestMessageSubagentRuntime: requestMessageSubagentRuntimeMock,
  requestSteerSubagentRuntime: requestSteerSubagentRuntimeMock,
}));

import { registerRuntimeCustomizationRoutes } from '../routes/runtime-customization-routes.js';

const noopRequirePermission: import('../auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

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

describe('runtime customization routes', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    getConfigMock.mockReturnValue('');
    setConfigMock.mockReset();
    getSubagentRuntimeMock.mockClear();
    requestStopSubagentRuntimeMock.mockReset();
    requestMessageSubagentRuntimeMock.mockReset();
    requestSteerSubagentRuntimeMock.mockReset();
  });

  it('sends a follow-up message to a controllable subagent runtime', async () => {
    requestMessageSubagentRuntimeMock.mockReturnValueOnce({
      ok: true,
      status: 'message_requested',
      requestId: 'msg-1',
      entry: { id: 'subagent-3' },
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-3/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '继续检查未覆盖测试' }),
        },
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'accepted',
        requestId: 'msg-1',
        entry: { id: 'subagent-3' },
      });
      expect(requestMessageSubagentRuntimeMock).toHaveBeenCalledWith(
        'subagent-3',
        '继续检查未覆盖测试',
        { waitForResponse: false },
      );
    });
  });

  it('returns not_controllable when message control targets a read-only runtime', async () => {
    requestMessageSubagentRuntimeMock.mockReturnValueOnce({
      ok: false,
      status: 'not_controllable',
      entry: { id: 'subagent-2' },
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-2/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '继续工作' }),
        },
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'not_controllable',
        entry: { id: 'subagent-2' },
      });
      expect(requestMessageSubagentRuntimeMock).toHaveBeenCalledWith(
        'subagent-2',
        '继续工作',
        { waitForResponse: false },
      );
    });
  });

  it('reads and saves subagent config with maxActive', async () => {
    getConfigMock.mockReturnValueOnce(
      '{"enabled":false,"maxDepth":3,"maxActive":6}',
    );

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const getResponse = await fetch(`${baseUrl}/api/subagents/config`);
      expect(getResponse.ok).toBe(true);
      expect(await getResponse.json()).toEqual({
        enabled: false,
        maxDepth: 3,
        maxActive: 6,
      });

      const putResponse = await fetch(`${baseUrl}/api/subagents/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          maxDepth: 4,
          maxActive: 7,
        }),
      });
      expect(putResponse.ok).toBe(true);
      expect(await putResponse.json()).toEqual({
        ok: true,
        config: {
          enabled: true,
          maxDepth: 4,
          maxActive: 7,
        },
      });
      expect(setConfigMock).toHaveBeenCalledWith(
        'WEB_SUBAGENTS',
        '{"enabled":true,"maxDepth":4,"maxActive":7}',
      );
    });
  });

  it('stops a managed subagent runtime via API', async () => {
    requestStopSubagentRuntimeMock.mockReturnValueOnce({
      ok: true,
      status: 'stop_requested',
      entry: { id: 'subagent-1' },
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-1/stop`,
        { method: 'POST' },
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          ok: true,
          status: 'accepted',
        }),
      );
    });
  });

  it('returns a not_controllable status for read-only runtimes', async () => {
    requestStopSubagentRuntimeMock.mockReturnValueOnce({
      ok: false,
      status: 'not_controllable',
      entry: { id: 'subagent-2' },
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-2/stop`,
        { method: 'POST' },
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'not_controllable',
        entry: { id: 'subagent-2' },
      });
    });
  });

  it('returns 404 when the managed subagent runtime cannot be found', async () => {
    requestStopSubagentRuntimeMock.mockReturnValueOnce({
      ok: false,
      status: 'not_found',
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/missing/stop`,
        { method: 'POST' },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Sub-agent runtime not found',
      });
    });
  });

  it('returns not_controllable when steer targets a read-only runtime', async () => {
    requestSteerSubagentRuntimeMock.mockReturnValueOnce({
      ok: false,
      status: 'not_controllable',
      entry: { id: 'subagent-2' },
    });

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-2/steer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '转向新的分析方向', reason: 'user-request' }),
        },
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'not_controllable',
        entry: { id: 'subagent-2' },
      });
      expect(requestSteerSubagentRuntimeMock).toHaveBeenCalledWith(
        'subagent-2',
        '转向新的分析方向\n\nReason: user-request',
        { waitForResponse: false },
      );
    });
  });

  it('validates prompt when sending message and steer requests', async () => {
    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const messageResponse = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-3/message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '   ' }),
        },
      );
      expect(messageResponse.status).toBe(400);
      expect(await messageResponse.json()).toEqual({
        error: 'prompt is required',
      });

      const steerResponse = await fetch(
        `${baseUrl}/api/subagents/runtime/subagent-3/steer`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: '' }),
        },
      );
      expect(steerResponse.status).toBe(400);
      expect(await steerResponse.json()).toEqual({
        error: 'prompt is required',
      });
    });
  });

  it('serves extension marketplace routes when handlers are configured', async () => {
    const auditMutation = vi.fn();
    const persistExtensionMarketplaceSources = vi.fn((sources: any[]) => sources);
    const getExtensionMarketplaceCatalog = vi.fn(async (input?: {
      sourceId?: string;
      source?: string;
    }) => ({
      sources: [
        {
          id: 'official',
          name: 'Official',
          source: 'owner/repo',
          enabled: true,
        },
      ],
      entries: [
        {
          id: 'official:repo-review',
          entryName: 'repo-review',
          title: 'repo-review',
          sourceId: input?.sourceId || 'official',
          sourceName: 'Official',
          sourceLabel: 'Official',
          skillCount: 2,
          mcpCount: 1,
          agentCount: 0,
          installable: true,
        },
      ],
    }));
    const installMarketplaceExtensionFromInput = vi.fn(async (input: any) => ({
      installs: [],
      installed: {
        id: 'repo-review',
        name: input.entryName,
        sourceType: 'marketplace',
        sourceRef: input.sourceId,
        installedSkillIds: ['repo-review'],
        installedMcpServerIds: ['docs'],
        agentCount: 0,
        installedAt: '2026-03-19T00:00:00.000Z',
        status: 'installed',
        warnings: [],
      },
    }));
    const importExtensionFromInput = vi.fn(async (input: any) => ({
      installs: [],
      installed: {
        id: 'imported-bundle',
        name: input.name || 'imported-bundle',
        sourceType: 'import',
        sourceRef: input.source,
        installedSkillIds: ['imported-skill'],
        installedMcpServerIds: [],
        agentCount: 0,
        installedAt: '2026-03-19T00:00:00.000Z',
        status: 'installed',
        warnings: [],
      },
    }));
    const uninstallExtensionFromInput = vi.fn((input: any) => ({
      installs: [],
      removed: {
        id: input.installId,
      },
    }));
    const reconcileExtensionInstalls = vi.fn(() => ({
      installs: [
        {
          id: 'repo-review',
          name: 'repo-review',
          sourceType: 'marketplace',
          sourceRef: 'owner/repo',
          installedSkillIds: ['repo-review'],
          installedMcpServerIds: ['docs'],
          agentCount: 0,
          installedAt: '2026-03-19T00:00:00.000Z',
          status: 'installed',
          warnings: [],
        },
      ],
    }));

    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation,
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
      getExtensionMarketplaceSourcesForResponse: () => [
        {
          id: 'official',
          name: 'Official',
          source: 'owner/repo',
          enabled: true,
        },
      ],
      persistExtensionMarketplaceSources,
      getExtensionMarketplaceCatalog,
      getExtensionInstallsForResponse: () => [
        {
          id: 'repo-review',
          name: 'repo-review',
          sourceType: 'marketplace',
          sourceRef: 'owner/repo',
          installedSkillIds: ['repo-review'],
          installedMcpServerIds: ['docs'],
          agentCount: 0,
          installedAt: '2026-03-19T00:00:00.000Z',
          status: 'installed',
          warnings: [],
        },
      ],
      installMarketplaceExtensionFromInput,
      importExtensionFromInput,
      uninstallExtensionFromInput,
      reconcileExtensionInstalls,
    });

    await withServer(app, async (baseUrl) => {
      const listResponse = await fetch(`${baseUrl}/api/extensions/marketplaces`);
      expect(listResponse.ok).toBe(true);
      expect(await listResponse.json()).toEqual({
        sources: [
          {
            id: 'official',
            name: 'Official',
            source: 'owner/repo',
            enabled: true,
          },
        ],
      });

      const saveResponse = await fetch(`${baseUrl}/api/extensions/marketplaces`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: [
            {
              id: 'official',
              name: 'Official',
              source: 'owner/repo',
              enabled: true,
            },
          ],
        }),
      });
      expect(saveResponse.ok).toBe(true);
      expect(await saveResponse.json()).toEqual({
        sources: [
          {
            id: 'official',
            name: 'Official',
            source: 'owner/repo',
            enabled: true,
          },
        ],
      });

      const catalogResponse = await fetch(
        `${baseUrl}/api/extensions/marketplaces/catalog`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: 'official' }),
        },
      );
      expect(catalogResponse.ok).toBe(true);
      expect(await catalogResponse.json()).toEqual({
        sources: [
          {
            id: 'official',
            name: 'Official',
            source: 'owner/repo',
            enabled: true,
          },
        ],
        entries: [
          expect.objectContaining({
            id: 'official:repo-review',
            entryName: 'repo-review',
            sourceId: 'official',
            skillCount: 2,
            mcpCount: 1,
            installable: true,
          }),
        ],
      });

      const installsResponse = await fetch(`${baseUrl}/api/extensions/installs`);
      expect(installsResponse.ok).toBe(true);
      expect(await installsResponse.json()).toEqual({
        installs: [
          expect.objectContaining({
            id: 'repo-review',
            name: 'repo-review',
            sourceType: 'marketplace',
          }),
        ],
      });

      const installResponse = await fetch(`${baseUrl}/api/extensions/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: 'official', entryName: 'repo-review' }),
      });
      expect(installResponse.ok).toBe(true);
      expect(await installResponse.json()).toEqual({
        installs: [],
        installed: expect.objectContaining({
          id: 'repo-review',
          name: 'repo-review',
          sourceType: 'marketplace',
        }),
      });

      const importResponse = await fetch(`${baseUrl}/api/extensions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'https://example.com/repo-review/SKILL.md',
          name: 'repo-review',
        }),
      });
      expect(importResponse.ok).toBe(true);
      expect(await importResponse.json()).toEqual({
        installs: [],
        installed: expect.objectContaining({
          id: 'imported-bundle',
          name: 'repo-review',
          sourceType: 'import',
        }),
      });

      const uninstallResponse = await fetch(
        `${baseUrl}/api/extensions/installs/repo-review`,
        {
          method: 'DELETE',
        },
      );
      expect(uninstallResponse.ok).toBe(true);
      expect(await uninstallResponse.json()).toEqual({
        installs: [],
        removed: {
          id: 'repo-review',
        },
      });

      const reconcileResponse = await fetch(
        `${baseUrl}/api/extensions/installs/reconcile`,
        {
          method: 'POST',
        },
      );
      expect(reconcileResponse.ok).toBe(true);
      expect(await reconcileResponse.json()).toEqual({
        installs: [
          expect.objectContaining({
            id: 'repo-review',
            status: 'installed',
          }),
        ],
      });
    });

    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'extensions.marketplaces.update',
      'high',
    );
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'extensions.install',
      'high',
    );
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'extensions.import',
      'high',
    );
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'extensions.uninstall',
      'high',
    );
    expect(auditMutation).toHaveBeenCalledWith(
      expect.anything(),
      'extensions.installs.reconcile',
      'high',
    );
    expect(persistExtensionMarketplaceSources).toHaveBeenCalledWith([
      {
        id: 'official',
        name: 'Official',
        source: 'owner/repo',
        enabled: true,
      },
    ]);
    expect(getExtensionMarketplaceCatalog).toHaveBeenCalledWith({
      sourceId: 'official',
    });
    expect(installMarketplaceExtensionFromInput).toHaveBeenCalledWith({
      sourceId: 'official',
      entryName: 'repo-review',
    });
    expect(importExtensionFromInput).toHaveBeenCalledWith({
      source: 'https://example.com/repo-review/SKILL.md',
      name: 'repo-review',
    });
    expect(uninstallExtensionFromInput).toHaveBeenCalledWith({
      installId: 'repo-review',
    });
    expect(reconcileExtensionInstalls).toHaveBeenCalledTimes(1);
  });

  it('awaits async extension list providers before serializing responses', async () => {
    const app = express();
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
      getExtensionMarketplaceSourcesForResponse: async () => [
        {
          id: 'official',
          name: 'Official',
          source: 'owner/repo',
          enabled: true,
        },
      ],
      getExtensionInstallsForResponse: async () => [
        {
          id: 'repo-review',
          name: 'repo-review',
          sourceType: 'marketplace',
          sourceRef: 'owner/repo',
          installedSkillIds: [],
          installedMcpServerIds: [],
          agentCount: 0,
          installedAt: '2026-03-19T00:00:00.000Z',
          status: 'installed',
          warnings: [],
        },
      ],
    });

    await withServer(app, async (baseUrl) => {
      const [marketplacesResponse, installsResponse] = await Promise.all([
        fetch(`${baseUrl}/api/extensions/marketplaces`),
        fetch(`${baseUrl}/api/extensions/installs`),
      ]);

      expect(await marketplacesResponse.json()).toEqual({
        sources: [
          {
            id: 'official',
            name: 'Official',
            source: 'owner/repo',
            enabled: true,
          },
        ],
      });
      expect(await installsResponse.json()).toEqual({
        installs: [
          expect.objectContaining({
            id: 'repo-review',
            name: 'repo-review',
            sourceType: 'marketplace',
          }),
        ],
      });
    });
  });

  it('returns 501 for extension marketplace mutations when handlers are unavailable', async () => {
    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
    });

    await withServer(app, async (baseUrl) => {
      const saveResponse = await fetch(`${baseUrl}/api/extensions/marketplaces`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [] }),
      });
      expect(saveResponse.status).toBe(501);
      expect(await saveResponse.json()).toEqual({
        error: 'Extension marketplace persistence unavailable',
      });

      const catalogResponse = await fetch(
        `${baseUrl}/api/extensions/marketplaces/catalog`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(catalogResponse.status).toBe(501);
      expect(await catalogResponse.json()).toEqual({
        error: 'Extension marketplace catalog unavailable',
      });

      const installResponse = await fetch(`${baseUrl}/api/extensions/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: 'official', entryName: 'repo-review' }),
      });
      expect(installResponse.status).toBe(501);
      expect(await installResponse.json()).toEqual({
        error: 'Extension install unavailable',
      });

      const importResponse = await fetch(`${baseUrl}/api/extensions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'owner/repo' }),
      });
      expect(importResponse.status).toBe(501);
      expect(await importResponse.json()).toEqual({
        error: 'Extension import unavailable',
      });

      const uninstallResponse = await fetch(
        `${baseUrl}/api/extensions/installs/repo-review`,
        {
          method: 'DELETE',
        },
      );
      expect(uninstallResponse.status).toBe(501);
      expect(await uninstallResponse.json()).toEqual({
        error: 'Extension uninstall unavailable',
      });

      const reconcileResponse = await fetch(
        `${baseUrl}/api/extensions/installs/reconcile`,
        {
          method: 'POST',
        },
      );
      expect(reconcileResponse.status).toBe(501);
      expect(await reconcileResponse.json()).toEqual({
        error: 'Extension reconcile unavailable',
      });
    });
  });

  it('returns 404 when uninstalling an unknown extension install', async () => {
    const app = express();
    app.use(express.json());
    registerRuntimeCustomizationRoutes(app, {
      requirePermission: noopRequirePermission,
      auditMutation: vi.fn(),
      getManagedMcpServersForResponse: () => [],
      persistManagedMcpServers: vi.fn(),
      installManagedMcpServerFromInput: vi.fn(),
      getManagedSkillsForResponse: () => [],
      getManagedSkillDetailForResponse: () => null,
      installCustomSkillFromPath: () => 'installed',
      createSkillWithAiFromInput: async () => ({}),
      uninstallExtensionFromInput: () => {
        throw new Error('extension install not found: missing-extension');
      },
    });

    await withServer(app, async (baseUrl) => {
      const uninstallResponse = await fetch(
        `${baseUrl}/api/extensions/installs/missing-extension`,
        {
          method: 'DELETE',
        },
      );
      expect(uninstallResponse.status).toBe(404);
      expect(await uninstallResponse.json()).toEqual({
        error: 'extension install not found: missing-extension',
      });
    });
  });
});
