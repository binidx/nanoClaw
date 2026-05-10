import type { Express } from 'express';

import {
  getAssistantName,
  getChannelConfigMetadata,
  getConfigValue,
  getSanitizedChannelInstancesForUser,
  getWebConfigMetadata,
} from '../config-store.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { getConfig, getDefaultProvider } from '../db.js';
import { generateDoctorReport } from '../web/doctor.js';
import { logger } from '../logger.js';
import { getMemoryObservability } from '../memory/observability.js';
import { generateOnboardingReport } from '../web/onboard.js';
import {
  parseSubagentsConfig,
  WEB_SUBAGENTS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import * as subagentRuntimeRegistry from '../subagent/subagent-runtime-registry.js';
import type {
  SubagentRunListQuery,
  SubagentRuntimeListQuery,
} from '../subagent/subagent-runtime-registry.js';
import { loadSenderAllowlist } from '../security/sender-allowlist.js';
import { loadBuiltinWebFetchSiteProfilePresets } from '../web/web-fetch-site-profiles.js';
import { isFeatureEnabled } from '../auth/web-security.js';
import type { LocalCapabilityStatusMap } from '../auth/local-capability-policy.js';

export interface SystemReadRouteOptions {
  getSanitizedWebConfig: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;
  getChannelStatus: () => { name: string; connected: boolean }[];
  getAgentStatus: () => { activeAgents: number; queuedTasks: number };
  isStockAnalysisEnabled?: () => boolean | Promise<boolean>;
  isWebTerminalEnabled: () => boolean | Promise<boolean>;
  getLocalCapabilities?: (
    cookieHeader?: string,
  ) => LocalCapabilityStatusMap | Promise<LocalCapabilityStatusMap>;
  requirePermission?: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

function getRegistryHook<T extends Function>(name: string): T | null {
  try {
    const candidate = (subagentRuntimeRegistry as Record<string, unknown>)[name];
    return typeof candidate === 'function' ? (candidate as T) : null;
  } catch {
    return null;
  }
}

function buildProviderCapabilities(subagentsEnabled: boolean) {
  return {
    claude: {
      canSpawn: subagentsEnabled,
      canPersistentSession: subagentsEnabled,
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
      canSpawn: subagentsEnabled,
      canPersistentSession: subagentsEnabled,
      canListRuntime: true,
      canStopRuntime: true,
      canMessageRuntime:
        getRegistryHook<(...args: any[]) => unknown>(
          'requestMessageSubagentRuntime',
        ) !== null,
      canSteerRuntime:
        getRegistryHook<(...args: any[]) => unknown>(
          'requestSteerSubagentRuntime',
        ) !== null,
      canQueryTree:
        getRegistryHook<(...args: any[]) => unknown>(
          'listSubagentRuntimeTree',
        ) !== null,
      canResumeAfterRestart: false,
      runtimeModel: 'managed_runtime',
      controlModel: 'runtime_ipc',
    },
  };
}

function buildSubagentRuntimeDetail(entry: unknown) {
  const getRuntimeDetail = getRegistryHook<(id: string) => unknown>(
    'getSubagentRuntimeDetail',
  );
  if (!entry || typeof entry !== 'object') {
    return entry;
  }
  if (getRuntimeDetail) {
    const id = String((entry as { id?: unknown }).id || '').trim();
    if (id) {
      const detail = getRuntimeDetail(id);
      if (detail && typeof detail === 'object') {
        return {
          ...(entry as Record<string, unknown>),
          ...(detail as Record<string, unknown>),
        };
      }
    }
  }
  return {
    ...(entry as Record<string, unknown>),
    relations:
      (entry as { relations?: unknown }).relations ??
      {
        parentId: null,
        childIds: [],
        descendantIds: [],
      },
    controls:
      (entry as { controls?: unknown }).controls ??
      {
        canStop: Boolean(
          (entry as { controllable?: unknown }).controllable === true,
        ),
        canMessage: false,
        canSteer: false,
      },
  };
}

export function registerSystemReadRoutes(
  app: Express,
  opts: SystemReadRouteOptions,
): void {
  const noop: import('express').RequestHandler = (_r, _s, n) => n();
  const sysViewGuard = opts.requirePermission
    ? opts.requirePermission('system.settings', 'system.settings.view')
    : noop;

  app.get('/api/config', async (_req, res) => {
    try {
      res.json(await opts.getSanitizedWebConfig());
    } catch (err) {
      logger.error({ err }, 'Failed to read web config');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/config/meta', (_req, res) => {
    try {
      res.json({ keys: getWebConfigMetadata() });
    } catch (err) {
      logger.error({ err }, 'Failed to read web config metadata');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/channel-config/meta', async (_req, res) => {
    try {
      res.json(await getChannelConfigMetadata());
    } catch (err) {
      logger.error({ err }, 'Failed to read channel config metadata');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/channel-config', async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      res.json({ instances: await getSanitizedChannelInstancesForUser(userId) });
    } catch (err) {
      logger.error({ err }, 'Failed to read channel config');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/status', async (req, res) => {
    try {
      const defaultProvider = await getDefaultProvider();
      const subagentsConfig = parseSubagentsConfig(
        await getConfig(WEB_SUBAGENTS_CONFIG_KEY),
      );
      const runtimeSnapshot = subagentRuntimeRegistry.listSubagentRuntimes({
        activeOnly: true,
        limit: 1,
      });
      const providerCapabilities = buildProviderCapabilities(
        subagentsConfig.enabled,
      );
      const capabilities = await opts.getLocalCapabilities?.(req.headers.cookie);
      res.json({
        assistant: await getAssistantName(),
        provider:
          defaultProvider?.type ||
          (await getConfigValue('AI_PROVIDER')) ||
          'claude',
        providerAlias: defaultProvider?.alias || '',
        channels: opts.getChannelStatus(),
        agents: opts.getAgentStatus(),
        uptime: process.uptime(),
        stockAnalysisEnabled: (await opts.isStockAnalysisEnabled?.()) ?? false,
        webTerminalEnabled:
          capabilities?.terminal.available ?? (await opts.isWebTerminalEnabled()),
        ...(capabilities ? { capabilities } : {}),
        allowInsecureTls: isFeatureEnabled(
          await getConfigValue('ALLOW_INSECURE_TLS'),
        ),
        subagentsEnabled: subagentsConfig.enabled,
        subagents: {
          controlPlaneVersion: 'runtime-v2',
          enabled: subagentsConfig.enabled,
          maxDepth: subagentsConfig.maxDepth,
          maxActive: subagentsConfig.maxActive,
          activeCount: runtimeSnapshot.activeCount,
          providers: providerCapabilities,
        },
        memory: await getMemoryObservability(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to build runtime status');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/subagents/runtime', sysViewGuard, (req, res) => {
    try {
      const limitRaw = Number.parseInt(String(req.query.limit || '20'), 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(limitRaw, 100))
        : 20;
      const query: SubagentRuntimeListQuery = {
        limit,
        cursor:
          typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        provider:
          typeof req.query.provider === 'string'
            ? req.query.provider
            : undefined,
        groupFolder:
          typeof req.query.groupFolder === 'string'
            ? req.query.groupFolder
            : undefined,
        chatJid:
          typeof req.query.chatJid === 'string'
            ? req.query.chatJid
            : undefined,
        status:
          typeof req.query.status === 'string'
            ? (req.query.status as SubagentRuntimeListQuery['status'])
            : undefined,
        activeOnly: parseBooleanQuery(req.query.activeOnly),
      };
      const view =
        req.query.view === 'tree' || req.query.view === 'flat'
          ? req.query.view
          : 'flat';
      const listRuntimeTree = getRegistryHook<
        (query: SubagentRuntimeListQuery) => unknown
      >('listSubagentRuntimeTree');
      if (view === 'tree' && listRuntimeTree) {
        res.json({
          ...(listRuntimeTree(query) as Record<string, unknown>),
          view,
          treeSupported: true,
        });
        return;
      }
      res.json({
        ...subagentRuntimeRegistry.listSubagentRuntimes(query),
        view,
        treeSupported: listRuntimeTree !== null,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to read subagent runtimes');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/subagents/runs', sysViewGuard, (req, res) => {
    try {
      const limitRaw = Number.parseInt(String(req.query.limit || '20'), 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(limitRaw, 100))
        : 20;
      const query: SubagentRunListQuery = {
        limit,
        cursor:
          typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        provider:
          typeof req.query.provider === 'string'
            ? req.query.provider
            : undefined,
        groupFolder:
          typeof req.query.groupFolder === 'string'
            ? req.query.groupFolder
            : undefined,
        chatJid:
          typeof req.query.chatJid === 'string'
            ? req.query.chatJid
            : undefined,
        status:
          typeof req.query.status === 'string'
            ? (req.query.status as SubagentRunListQuery['status'])
            : undefined,
        activeOnly: parseBooleanQuery(req.query.activeOnly),
        runtimeId:
          typeof req.query.runtimeId === 'string'
            ? req.query.runtimeId
            : undefined,
        controllerSessionKey:
          typeof req.query.controllerSessionKey === 'string'
            ? req.query.controllerSessionKey
            : undefined,
        requesterSessionKey:
          typeof req.query.requesterSessionKey === 'string'
            ? req.query.requesterSessionKey
            : undefined,
        parentRuntimeId:
          typeof req.query.parentRuntimeId === 'string'
            ? req.query.parentRuntimeId
            : undefined,
        originTurnId:
          typeof req.query.originTurnId === 'string'
            ? req.query.originTurnId
            : undefined,
        originToolCallId:
          typeof req.query.originToolCallId === 'string'
            ? req.query.originToolCallId
            : undefined,
        descendantOf:
          typeof req.query.descendantOf === 'string'
            ? req.query.descendantOf
            : typeof req.query.descendantOfRuntimeId === 'string'
              ? req.query.descendantOfRuntimeId
            : undefined,
      };
      const view =
        req.query.view === 'tree' || req.query.view === 'flat'
          ? req.query.view
          : 'flat';
      const listRunTree = getRegistryHook<
        (query: SubagentRunListQuery) => unknown
      >('listSubagentRunTree');
      if (view === 'tree' && listRunTree) {
        res.json({
          ...(listRunTree(query) as Record<string, unknown>),
          view,
          treeSupported: true,
        });
        return;
      }
      const snapshot = subagentRuntimeRegistry.listSubagentRuns(query);
      res.json({
        ...snapshot,
        view,
        treeSupported: listRunTree !== null,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to read subagent runs');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/subagents/runtime/:subagentId', sysViewGuard, (req, res) => {
    try {
      const raw = req.params.subagentId;
      const subagentId = decodeURIComponent(Array.isArray(raw) ? raw[0] ?? '' : raw || '').trim();
      if (!subagentId) {
        res.status(400).json({ error: 'subagentId is required' });
        return;
      }

      const entry = subagentRuntimeRegistry.getSubagentRuntime(subagentId);
      if (!entry) {
        res.status(404).json({ error: 'Sub-agent runtime not found' });
        return;
      }

      res.json(buildSubagentRuntimeDetail(entry));
    } catch (err) {
      logger.error({ err }, 'Failed to read subagent runtime detail');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/memory/status', sysViewGuard, async (_req, res) => {
    try {
      res.json(await getMemoryObservability());
    } catch (err) {
      logger.error({ err }, 'Failed to build memory observability status');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/doctor', async (req, res) => {
    try {
      res.json(
        await generateDoctorReport({
          probeProviders: req.query.probe === '1',
          checkPortAvailability: false,
        }),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to generate doctor report');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/onboarding', async (_req, res) => {
    try {
      res.json(await generateOnboardingReport());
    } catch (err) {
      logger.error({ err }, 'Failed to generate onboarding report');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/sender-trust', sysViewGuard, (_req, res) => {
    try {
      res.json({ config: loadSenderAllowlist() });
    } catch (err) {
      logger.error({ err }, 'Failed to read sender trust config');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/web-fetch-site-profiles', sysViewGuard, (_req, res) => {
    try {
      res.json({ presets: loadBuiltinWebFetchSiteProfilePresets() });
    } catch (err) {
      logger.error({ err }, 'Failed to read builtin web fetch site profiles');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
