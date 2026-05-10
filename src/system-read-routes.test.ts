import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config-store.js')>();
  return {
    ...actual,
    getAssistantName: () => 'NanoClaw',
    getChannelConfigMetadata: () => [],
    getConfigValue: (key: string) => {
      if (key === 'AI_PROVIDER') return 'codex';
      if (key === 'ALLOW_INSECURE_TLS') return '';
      return '';
    },
    getConfigValues: async () => ({}),
    getSanitizedChannelInstances: () => [],
    getSanitizedChannelInstancesForUser: () => [],
    getWebConfigMetadata: () => [],
  };
});

vi.mock('./db.js', () => ({
  getConfig: (key: string) =>
    key === 'WEB_SUBAGENTS'
      ? '{"enabled":true,"maxDepth":3,"maxActive":6}'
      : '',
  getMemoryCompactionStats: () => ({
    totalRuns: 0,
    lastRunAt: null,
    lastRunStatus: 'idle',
    lastRunEntriesCompacted: 0,
  }),
  getMemoryLedgerStats: () => ({
    totalEntries: 0,
    groupEntries: 0,
    globalEntries: 0,
    lastEntryAt: null,
  }),
  getMemoryPromotionStats: () => ({
    candidates24h: 0,
    writes24h: 0,
    deduped24h: 0,
    latestPromotionAt: null,
    byOrigin24h: {},
    byAction24h: {
      auto: 0,
      remember: 0,
      session_only: 0,
    },
    byMemoryClass24h: {
      identity: 0,
      global_durable: 0,
      group_durable: 0,
      session: 0,
      unknown: 0,
    },
  }),
  getMemoryIdentityStats: () => ({
    profileCount: 0,
    aliasCount: 0,
    bindingCount: 0,
    lastUpdatedAt: null,
  }),
  getMemorySearchStats: () => ({
    indexedDocuments: 0,
    syncStateDocuments: 0,
    lastIndexedAt: null,
    lastSyncPassAt: null,
    recallCount24h: 0,
    recallBySource: {},
    indexedHitCount24h: 0,
    indexedResultCount24h: 0,
    searchFollowupReadCount24h: 0,
    followupReadRate24h: null,
    fallbackSyncCount24h: 0,
    freshnessRecheckCount24h: 0,
    staleRefreshCount24h: 0,
    filesSynced24h: 0,
    filesSkipped24h: 0,
    filesDeleted24h: 0,
    byScope: {
      group: {
        indexedResults24h: 0,
        followupReads24h: 0,
        recalls24h: 0,
        followupReadRate24h: null,
      },
      global: {
        indexedResults24h: 0,
        followupReads24h: 0,
        recalls24h: 0,
        followupReadRate24h: null,
      },
    },
    bySource: {},
    topGroups: [],
  }),
  getMemoryPromptStats: () => ({
    injections24h: 0,
    snippets24h: 0,
    tokens24h: 0,
    lastInjectedAt: null,
    byBucket24h: {
      recent: 0,
      summary: 0,
      recall: 0,
    },
  }),
  getDefaultProvider: () => ({
    type: 'codex',
    alias: 'Primary Codex',
  }),
}));

vi.mock('./doctor.js', () => ({
  generateDoctorReport: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./onboard.js', () => ({
  generateOnboardingReport: () => ({ ok: true }),
}));

vi.mock('./runtime-customization.js', () => ({
  WEB_SUBAGENTS_CONFIG_KEY: 'WEB_SUBAGENTS',
  parseSubagentsConfig: (raw: unknown) => {
    const text = String(raw || '').trim();
    if (!text) return { enabled: true, maxDepth: 2 };
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
            ? Math.max(1, Math.trunc(parsed.maxDepth))
            : 2,
        maxActive:
          typeof parsed.maxActive === 'number' &&
          Number.isFinite(parsed.maxActive)
            ? Math.max(1, Math.trunc(parsed.maxActive))
            : 4,
      };
    } catch {
      return { enabled: true, maxDepth: 2, maxActive: 4 };
    }
  },
}));

vi.mock('./sender-allowlist.js', () => ({
  loadSenderAllowlist: () => ({ mode: 'trigger' }),
}));

const {
  getSubagentRuntimeMock,
  listSubagentRunsMock,
  listSubagentRunTreeMock,
  listSubagentRuntimesMock,
  listSubagentRuntimeTreeMock,
} = vi.hoisted(() => ({
  getSubagentRuntimeMock: vi.fn((id: string) =>
    id === 'subagent-1'
      ? {
          id: 'subagent-1',
          provider: 'codex',
          mode: 'team',
          groupFolder: 'alpha-room',
          chatJid: 'alpha@g.us',
          name: 'Scout',
          task: 'Inspect the repository',
          status: 'running',
          depth: 1,
          createdAt: '2026-03-18T00:00:00.000Z',
          updatedAt: '2026-03-18T00:01:00.000Z',
        }
      : null,
  ),
  listSubagentRunsMock: vi.fn(() => ({
    generatedAt: '2026-03-18T00:02:00.000Z',
    activeCount: 1,
    recentCount: 2,
    items: [
      {
        runId: 'subagent-1',
        runtimeId: 'subagent-1',
        provider: 'codex',
        mode: 'team',
        groupFolder: 'alpha-room',
        chatJid: 'alpha@g.us',
        name: 'Scout',
        task: 'Inspect the repository',
        status: 'running',
        depth: 1,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:01:00.000Z',
        controllerSessionKey: 'controller-1',
        requesterSessionKey: 'requester-1',
      },
    ],
  })),
  listSubagentRunTreeMock: vi.fn(() => ({
    generatedAt: '2026-03-18T00:02:00.000Z',
    activeCount: 1,
    recentCount: 2,
    items: [],
    roots: [{ entry: { runtimeId: 'subagent-1' }, children: [] }],
  })),
  listSubagentRuntimesMock: vi.fn(() => ({
    activeCount: 1,
    recentCount: 2,
    items: [
      {
        id: 'subagent-1',
        provider: 'codex',
        mode: 'team',
        groupFolder: 'alpha-room',
        chatJid: 'alpha@g.us',
        name: 'Scout',
        task: 'Inspect the repository',
        status: 'running',
        depth: 1,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:01:00.000Z',
        },
    ],
  })),
  listSubagentRuntimeTreeMock: vi.fn(() => ({
    activeCount: 1,
    recentCount: 2,
    items: [],
    roots: [{ id: 'subagent-1', children: [] }],
  })),
}));
vi.mock('./subagent-runtime-registry.js', () => ({
  getSubagentRuntime: getSubagentRuntimeMock,
  listSubagentRuns: listSubagentRunsMock,
  listSubagentRunTree: listSubagentRunTreeMock,
  listSubagentRuntimes: listSubagentRuntimesMock,
  listSubagentRuntimeTree: listSubagentRuntimeTreeMock,
}));

vi.mock('./web-fetch-site-profiles.js', () => ({
  loadBuiltinWebFetchSiteProfilePresets: () => [],
}));

vi.mock('./auth/web-security.js', () => ({
  isFeatureEnabled: () => false,
}));

import { registerSystemReadRoutes } from './routes/system-read-routes.js';

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

describe('system read routes', () => {
  beforeEach(() => {
    getSubagentRuntimeMock.mockClear();
    listSubagentRunsMock.mockClear();
    listSubagentRunTreeMock.mockClear();
    listSubagentRuntimesMock.mockClear();
    listSubagentRuntimeTreeMock.mockClear();
  });

  it('returns provider-specific subagent capability details in /api/status', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [{ name: 'web', connected: true }],
      getAgentStatus: () => ({ activeAgents: 1, queuedTasks: 2 }),
      isStockAnalysisEnabled: () => true,
      isWebTerminalEnabled: () => true,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/status`);
      expect(response.ok).toBe(true);

      const payload = (await response.json()) as {
        stockAnalysisEnabled?: boolean;
        subagentsEnabled?: boolean;
        subagents?: {
          controlPlaneVersion: string;
          enabled: boolean;
          maxDepth: number;
          maxActive: number;
          activeCount: number;
          providers: {
            claude: {
              canSpawn: boolean;
              canPersistentSession: boolean;
              canListRuntime: boolean;
              canStopRuntime: boolean;
              canMessageRuntime: boolean;
              canSteerRuntime: boolean;
              canQueryTree: boolean;
              canResumeAfterRestart: boolean;
              runtimeModel: string;
              controlModel: string;
            };
            codex: {
              canSpawn: boolean;
              canPersistentSession: boolean;
              canListRuntime: boolean;
              canStopRuntime: boolean;
              canMessageRuntime: boolean;
              canSteerRuntime: boolean;
              canQueryTree: boolean;
              canResumeAfterRestart: boolean;
              runtimeModel: string;
              controlModel: string;
            };
          };
        };
      };

      expect(payload.stockAnalysisEnabled).toBe(true);
      expect(payload.subagentsEnabled).toBe(true);
      expect(payload.subagents).toEqual({
        controlPlaneVersion: 'runtime-v2',
        enabled: true,
        maxDepth: 3,
        maxActive: 6,
        activeCount: 1,
        providers: {
          claude: {
            canSpawn: true,
            canPersistentSession: true,
            canListRuntime: true,
            canStopRuntime: false,
            canMessageRuntime: false,
            canSteerRuntime: false,
            canQueryTree: false,
            canResumeAfterRestart: false,
            runtimeModel: 'ephemeral_snapshot',
            controlModel: 'read_only',
          },
          codex: {
            canSpawn: true,
            canPersistentSession: true,
            canListRuntime: true,
            canStopRuntime: true,
            canMessageRuntime: false,
            canSteerRuntime: false,
            canQueryTree: true,
            canResumeAfterRestart: false,
            runtimeModel: 'managed_runtime',
            controlModel: 'runtime_ipc',
          },
        },
      });
      expect(listSubagentRuntimesMock).toHaveBeenCalledWith({
        activeOnly: true,
        limit: 1,
      });
    });
  });

  it('awaits async config readers before serializing status and channel config', async () => {
    const configStore = await import('./config-store.js');
    const getAssistantNameMock = vi
      .spyOn(configStore, 'getAssistantName')
      .mockResolvedValue('Async NanoClaw');
    const getChannelConfigMetadataMock = vi
      .spyOn(configStore, 'getChannelConfigMetadata')
      .mockResolvedValue({
        types: [{ type: 'web', label: 'Web', fields: [] }],
        conversationTargets: [{ type: 'web', label: 'Web', fields: [] }],
      });
    const getSanitizedChannelInstancesForUserMock = vi
      .spyOn(configStore, 'getSanitizedChannelInstancesForUser')
      .mockResolvedValue([
        {
          id: 'web-default',
          type: 'web',
          name: 'Web 默认',
          enabled: true,
          visibility: 'public',
          owner_id: '__system__',
          config: {},
        },
      ] as any);

    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [{ name: 'web', connected: true }],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => true,
    });

    await withServer(app, async (baseUrl) => {
      const [statusResponse, channelConfigResponse, channelMetaResponse] =
        await Promise.all([
          fetch(`${baseUrl}/api/status`),
          fetch(`${baseUrl}/api/channel-config`),
          fetch(`${baseUrl}/api/channel-config/meta`),
        ]);

      expect((await statusResponse.json()).assistant).toBe('Async NanoClaw');
      expect(await channelConfigResponse.json()).toEqual({
        instances: [
          {
            id: 'web-default',
            type: 'web',
            name: 'Web 默认',
            enabled: true,
            visibility: 'public',
            owner_id: '__system__',
            config: {},
          },
        ],
      });
      expect(await channelMetaResponse.json()).toEqual({
        types: [{ type: 'web', label: 'Web', fields: [] }],
        conversationTargets: [{ type: 'web', label: 'Web', fields: [] }],
      });
    });

    getAssistantNameMock.mockRestore();
    getChannelConfigMetadataMock.mockRestore();
    getSanitizedChannelInstancesForUserMock.mockRestore();
  });

  it('returns recent codex-managed subagent runtimes', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runtime?limit=5&activeOnly=true&provider=codex&status=running`,
      );
      expect(response.ok).toBe(true);

      const payload = (await response.json()) as {
        activeCount: number;
        recentCount: number;
        view: string;
        treeSupported: boolean;
        items: Array<{ id: string; mode: string; status: string; name: string }>;
      };

      expect(payload.activeCount).toBe(1);
      expect(payload.recentCount).toBe(2);
      expect(payload.view).toBe('flat');
      expect(payload.treeSupported).toBe(true);
      expect(payload.items).toEqual([
        expect.objectContaining({
          id: 'subagent-1',
          mode: 'team',
          status: 'running',
          name: 'Scout',
        }),
      ]);
      expect(listSubagentRuntimesMock).toHaveBeenCalledWith({
        limit: 5,
        cursor: undefined,
        provider: 'codex',
        groupFolder: undefined,
        chatJid: undefined,
        status: 'running',
        activeOnly: true,
      });
    });
  });

  it('returns tree view when the registry exposes descendant queries', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/subagents/runtime?view=tree`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          view: 'tree',
          treeSupported: true,
          roots: [{ id: 'subagent-1', children: [] }],
        }),
      );
      expect(listSubagentRuntimeTreeMock).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        provider: undefined,
        groupFolder: undefined,
        chatJid: undefined,
        status: undefined,
        activeOnly: undefined,
      });
      expect(listSubagentRuntimesMock).not.toHaveBeenCalled();
    });
  });

  it('returns persisted run records filtered by controller ownership', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runs?limit=5&controllerSessionKey=controller-1&activeOnly=true`,
      );
      expect(response.ok).toBe(true);

      const payload = (await response.json()) as {
        generatedAt: string;
        activeCount: number;
        recentCount: number;
        view: string;
        treeSupported: boolean;
        items: Array<{ runtimeId: string; controllerSessionKey?: string }>;
      };

      expect(payload.generatedAt).toBe('2026-03-18T00:02:00.000Z');
      expect(payload.activeCount).toBe(1);
      expect(payload.recentCount).toBe(2);
      expect(payload.view).toBe('flat');
      expect(payload.treeSupported).toBe(true);
      expect(payload.items).toEqual([
        expect.objectContaining({
          runtimeId: 'subagent-1',
          controllerSessionKey: 'controller-1',
        }),
      ]);
      expect(listSubagentRunsMock).toHaveBeenCalledWith({
        limit: 5,
        cursor: undefined,
        provider: undefined,
        groupFolder: undefined,
        chatJid: undefined,
        status: undefined,
        activeOnly: true,
        runtimeId: undefined,
        controllerSessionKey: 'controller-1',
        requesterSessionKey: undefined,
        parentRuntimeId: undefined,
        originTurnId: undefined,
        originToolCallId: undefined,
        descendantOf: undefined,
      });
    });
  });

  it('returns run tree view for descendant queries', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/subagents/runs?view=tree&descendantOf=subagent-root`,
      );
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          view: 'tree',
          treeSupported: true,
          roots: [{ entry: { runtimeId: 'subagent-1' }, children: [] }],
        }),
      );
      expect(listSubagentRunTreeMock).toHaveBeenCalledWith({
        limit: 20,
        cursor: undefined,
        provider: undefined,
        groupFolder: undefined,
        chatJid: undefined,
        status: undefined,
        activeOnly: undefined,
        runtimeId: undefined,
        controllerSessionKey: undefined,
        requesterSessionKey: undefined,
        parentRuntimeId: undefined,
        originTurnId: undefined,
        originToolCallId: undefined,
        descendantOf: 'subagent-root',
      });
      expect(listSubagentRunsMock).not.toHaveBeenCalled();
    });
  });

  it('returns subagent runtime detail by id', async () => {
    const app = express();
    registerSystemReadRoutes(app, {
      getSanitizedWebConfig: () => ({}),
      getChannelStatus: () => [],
      getAgentStatus: () => ({ activeAgents: 0, queuedTasks: 0 }),
      isWebTerminalEnabled: () => false,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/subagents/runtime/subagent-1`);
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          id: 'subagent-1',
          provider: 'codex',
          status: 'running',
          relations: {
            parentId: null,
            childIds: [],
            descendantIds: [],
          },
          controls: {
            canStop: false,
            canMessage: false,
            canSteer: false,
          },
        }),
      );
      expect(getSubagentRuntimeMock).toHaveBeenCalledWith('subagent-1');
    });
  });
});
