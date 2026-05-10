import type { Express, Request } from 'express';
import path from 'path';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { getConfig, setConfig } from '../db.js';
import { logger } from '../logger.js';
import {
  CUSTOM_SKILLS_ROOT,
  deleteCustomSkill,
  listManagedSkills,
  normalizeManagedMcpServers,
  parseEnabledSkillsConfig,
  parseSubagentsConfig,
  serializeEnabledSkillsConfig,
  serializeSubagentsConfig,
  WEB_ENABLED_SKILLS_CONFIG_KEY,
  WEB_SUBAGENTS_CONFIG_KEY,
  writeCustomSkill,
} from '../runtime/runtime-customization.js';
import {
  cleanupOrphanWorkspaces,
  scanOrphanWorkspaces,
} from '../agent/workspace-cleanup.js';
import * as subagentRuntimeRegistry from '../subagent/subagent-runtime-registry.js';

function routePathParam(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

type ManagedMcpServerList = ReturnType<typeof normalizeManagedMcpServers>;

export interface RuntimeCustomizationRouteOptions {
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  getManagedMcpServersForResponse: () =>
    | ManagedMcpServerList
    | Promise<ManagedMcpServerList>;
  persistManagedMcpServers: (
    servers: ManagedMcpServerList,
  ) => void | Promise<void>;
  installManagedMcpServerFromInput: (input: any) => unknown;
  getManagedSkillsForResponse: () => unknown | Promise<unknown>;
  getManagedSkillDetailForResponse: (skillId: string) => unknown | null;
  installCustomSkillFromPath: (input: {
    sourcePath: string;
    skillId?: string;
    overwrite?: boolean;
  }) => string;
  createSkillWithAiFromInput: (input: any) => Promise<unknown>;
  getExtensionMarketplaceSourcesForResponse?: () => unknown;
  persistExtensionMarketplaceSources?: (sources: any[]) => unknown;
  getExtensionMarketplaceCatalog?: (input?: {
    sourceId?: string;
    source?: string;
  }) => Promise<unknown>;
  getExtensionInstallsForResponse?: () => unknown;
  installMarketplaceExtensionFromInput?: (input: any) => Promise<unknown>;
  importExtensionFromInput?: (input: any) => Promise<unknown>;
  uninstallExtensionFromInput?: (input: any) => unknown;
  reconcileExtensionInstalls?: () => unknown;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
}

async function updateEnabledSkills(
  mutator: (currentEnabled: Set<string>) => void,
  warningMessage: string,
): Promise<void> {
  try {
    const currentEnabled = parseEnabledSkillsConfig(
      await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
    );
    if (!currentEnabled) {
      return;
    }
    mutator(currentEnabled);
    await setConfig(
      WEB_ENABLED_SKILLS_CONFIG_KEY,
      serializeEnabledSkillsConfig(currentEnabled),
    );
  } catch (err) {
    logger.warn({ err }, warningMessage);
  }
}

function getRegistryHook<T extends Function>(name: string): T | null {
  try {
    const candidate = (subagentRuntimeRegistry as Record<string, unknown>)[name];
    return typeof candidate === 'function' ? (candidate as T) : null;
  } catch {
    return null;
  }
}

function normalizeControlResult(result: unknown, acceptedStatus: string) {
  const normalized = result && typeof result === 'object'
    ? (result as Record<string, unknown>)
    : {};
  const status = String(normalized.status || '').trim();
  return {
    ...normalized,
    status: status === acceptedStatus ? 'accepted' : status,
  };
}

function resolveReadOnlyRuntimeResponse(subagentId: string) {
  const entry = subagentRuntimeRegistry.getSubagentRuntime(subagentId);
  if (!entry) {
    return { kind: 'not_found' as const };
  }
  return {
    kind: 'not_controllable' as const,
    payload: {
      ok: true,
      status: 'not_controllable',
      entry,
    },
  };
}

export function registerRuntimeCustomizationRoutes(
  app: Express,
  opts: RuntimeCustomizationRouteOptions,
): void {
  const guard = opts.requirePermission('system.settings', 'system.settings.edit');
  const installGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');

  app.get('/api/mcp-servers', guard, async (_req, res) => {
    res.json({ servers: await Promise.resolve(opts.getManagedMcpServersForResponse()) });
  });

  app.put('/api/mcp-servers', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'mcp-servers.update', 'high');
      const body = (req.body || {}) as { servers?: unknown };
      const servers = normalizeManagedMcpServers(body.servers ?? []).map(
        (server) => ({
          ...server,
          name: server.name.trim() || server.id,
        }),
      );
      await Promise.resolve(opts.persistManagedMcpServers(servers));
      res.json({ servers });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Invalid MCP config payload',
      });
    }
  });

  app.post('/api/mcp-servers/install', guard, installGuard, (req, res) => {
    try {
      opts.auditMutation(req, 'mcp-servers.install', 'high');
      res.json(opts.installManagedMcpServerFromInput(req.body || {}));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to install MCP',
      });
    }
  });

  app.get('/api/extensions/marketplaces', guard, async (_req, res) => {
    try {
      res.json({
        sources: opts.getExtensionMarketplaceSourcesForResponse
          ? await Promise.resolve(
              opts.getExtensionMarketplaceSourcesForResponse(),
            )
          : [],
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list extension marketplace sources');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/extensions/marketplaces', guard, (req, res) => {
    try {
      opts.auditMutation(req, 'extensions.marketplaces.update', 'high');
      const body = (req.body || {}) as { sources?: unknown };
      if (!Array.isArray(body.sources)) {
        res.status(400).json({ error: 'sources must be an array' });
        return;
      }
      if (!opts.persistExtensionMarketplaceSources) {
        res.status(501).json({ error: 'Extension marketplace persistence unavailable' });
        return;
      }
      res.json({
        sources: opts.persistExtensionMarketplaceSources(body.sources as any[]),
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to save extension marketplaces',
      });
    }
  });

  app.post('/api/extensions/marketplaces/catalog', guard, async (req, res) => {
    try {
      if (!opts.getExtensionMarketplaceCatalog) {
        res.status(501).json({ error: 'Extension marketplace catalog unavailable' });
        return;
      }
      const body = (req.body || {}) as { sourceId?: unknown; source?: unknown };
      const sourceId =
        typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
      const source = typeof body.source === 'string' ? body.source.trim() : '';
      res.json(
        await opts.getExtensionMarketplaceCatalog({
          ...(sourceId ? { sourceId } : {}),
          ...(source ? { source } : {}),
        }),
      );
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to load extension marketplace catalog',
      });
    }
  });

  app.get('/api/extensions/installs', guard, async (_req, res) => {
    try {
      res.json({
        installs: opts.getExtensionInstallsForResponse
          ? await Promise.resolve(opts.getExtensionInstallsForResponse())
          : [],
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list installed extensions');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/extensions/install', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'extensions.install', 'high');
      if (!opts.installMarketplaceExtensionFromInput) {
        res.status(501).json({ error: 'Extension install unavailable' });
        return;
      }
      res.json(
        await opts.installMarketplaceExtensionFromInput(req.body || {}),
      );
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to install extension',
      });
    }
  });

  app.post('/api/extensions/import', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'extensions.import', 'high');
      if (!opts.importExtensionFromInput) {
        res.status(501).json({ error: 'Extension import unavailable' });
        return;
      }
      res.json(await opts.importExtensionFromInput(req.body || {}));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to import extension',
      });
    }
  });

  app.delete('/api/extensions/installs/:installId', guard, installGuard, (req, res) => {
    try {
      opts.auditMutation(req, 'extensions.uninstall', 'high');
      if (!opts.uninstallExtensionFromInput) {
        res.status(501).json({ error: 'Extension uninstall unavailable' });
        return;
      }
      const installId = decodeURIComponent(routePathParam(req.params.installId)).trim();
      if (!installId) {
        res.status(400).json({ error: 'installId is required' });
        return;
      }
      res.json(opts.uninstallExtensionFromInput({ installId }));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to uninstall extension';
      res.status(/^extension install not found:/i.test(message) ? 404 : 400).json({
        error:
          message,
      });
    }
  });

  app.post('/api/extensions/installs/reconcile', guard, installGuard, (req, res) => {
    try {
      opts.auditMutation(req, 'extensions.installs.reconcile', 'high');
      if (!opts.reconcileExtensionInstalls) {
        res.status(501).json({ error: 'Extension reconcile unavailable' });
        return;
      }
      res.json(opts.reconcileExtensionInstalls());
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to reconcile extensions',
      });
    }
  });

  app.get('/api/skills', guard, async (_req, res) => {
    try {
      res.json({
        skills: await Promise.resolve(opts.getManagedSkillsForResponse()),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list managed skills');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/skills/:skillId', guard, (req, res) => {
    try {
      const skillId = decodeURIComponent(routePathParam(req.params.skillId)).trim();
      if (!skillId) {
        res.status(400).json({ error: 'skillId is required' });
        return;
      }

      const detail = opts.getManagedSkillDetailForResponse(skillId);
      if (!detail) {
        res.status(404).json({ error: `Unknown skill id: ${skillId}` });
        return;
      }

      res.json(detail);
    } catch (err) {
      logger.error({ err }, 'Failed to load managed skill detail');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/skills/enabled', guard, async (req, res) => {
    try {
      opts.auditMutation(req, 'skills.enabled.update', 'high');
      const body = (req.body || {}) as { enabledSkillIds?: unknown };
      if (!Array.isArray(body.enabledSkillIds)) {
        res.status(400).json({ error: 'enabledSkillIds must be an array' });
        return;
      }

      const allSkills = listManagedSkills(process.cwd());
      const available = new Set(allSkills.map((skill) => skill.id));
      const enabled = new Set<string>();
      for (const entry of body.enabledSkillIds) {
        if (typeof entry !== 'string' || !entry.trim()) {
          res
            .status(400)
            .json({ error: 'enabledSkillIds must contain non-empty strings' });
          return;
        }
        const id = entry.trim();
        if (!available.has(id)) {
          res.status(400).json({ error: `Unknown skill id: ${id}` });
          return;
        }
        enabled.add(id);
      }

      await setConfig(
        WEB_ENABLED_SKILLS_CONFIG_KEY,
        serializeEnabledSkillsConfig(enabled),
      );
      res.json({
        skills: await Promise.resolve(opts.getManagedSkillsForResponse()),
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to save enabled skills',
      });
    }
  });

  app.post('/api/skills', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'skills.custom.create', 'high');
      const body = (req.body || {}) as {
        id?: unknown;
        name?: unknown;
        description?: unknown;
        content?: unknown;
      };
      const createdSkill = writeCustomSkill(
        typeof body.id === 'string' ? body.id : '',
        typeof body.name === 'string' ? body.name : '',
        typeof body.description === 'string' ? body.description : '',
        typeof body.content === 'string' ? body.content : '',
      );

      updateEnabledSkills((currentEnabled) => {
        currentEnabled.add(createdSkill.id);
      }, 'Failed to update enabled skills after custom skill creation');

      res.json({
        skills: await Promise.resolve(opts.getManagedSkillsForResponse()),
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to create custom skill',
      });
    }
  });

  app.post('/api/skills/install', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'skills.install', 'high');
      const body = (req.body || {}) as {
        sourcePath?: unknown;
        skillId?: unknown;
        overwrite?: unknown;
      };
      const sourcePath =
        typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
      if (!sourcePath) {
        res.status(400).json({ error: 'sourcePath is required' });
        return;
      }

      const installedSkillId = opts.installCustomSkillFromPath({
        sourcePath,
        skillId: typeof body.skillId === 'string' ? body.skillId : '',
        overwrite: Boolean(body.overwrite),
      });

      updateEnabledSkills((currentEnabled) => {
        currentEnabled.add(installedSkillId);
      }, 'Failed to update enabled skills after skill install');

      res.json({
        skills: await Promise.resolve(opts.getManagedSkillsForResponse()),
        installed: {
          id: installedSkillId,
          path: path.join(CUSTOM_SKILLS_ROOT, installedSkillId),
        },
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to install skill',
      });
    }
  });

  app.post('/api/skills/ai-create', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'skills.ai-create', 'high');
      res.json(await opts.createSkillWithAiFromInput(req.body || {}));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to create skill with AI',
      });
    }
  });

  app.delete('/api/skills/:skillId', guard, installGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'skills.custom.delete', 'high');
      const skillId = decodeURIComponent(routePathParam(req.params.skillId));
      deleteCustomSkill(skillId);

      updateEnabledSkills((currentEnabled) => {
        currentEnabled.delete(skillId.trim());
      }, 'Failed to update enabled skills after skill deletion');

      res.json({
        skills: await Promise.resolve(opts.getManagedSkillsForResponse()),
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to delete custom skill',
      });
    }
  });

  app.get('/api/subagents/config', guard, async (_req, res) => {
    try {
      const config = parseSubagentsConfig(await getConfig(WEB_SUBAGENTS_CONFIG_KEY));
      res.json(config);
    } catch (err) {
      logger.error({ err }, 'Failed to read subagents config');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/subagents/config', guard, async (req, res) => {
    try {
      opts.auditMutation(req, 'subagents.config.update', 'normal');
      const body = (req.body || {}) as {
        enabled?: unknown;
        maxDepth?: unknown;
        maxActive?: unknown;
      };
      const current = parseSubagentsConfig(
        await getConfig(WEB_SUBAGENTS_CONFIG_KEY),
      );
      const next = {
        enabled:
          typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        maxDepth:
          typeof body.maxDepth === 'number' &&
          Number.isFinite(body.maxDepth) &&
          body.maxDepth >= 1 &&
          body.maxDepth <= 5
            ? Math.floor(body.maxDepth)
            : current.maxDepth,
        maxActive:
          typeof body.maxActive === 'number' &&
          Number.isFinite(body.maxActive) &&
          body.maxActive >= 1 &&
          body.maxActive <= 16
            ? Math.floor(body.maxActive)
            : current.maxActive,
      };
      await setConfig(WEB_SUBAGENTS_CONFIG_KEY, serializeSubagentsConfig(next));
      logger.info(
        {
          enabled: next.enabled,
          maxDepth: next.maxDepth,
          maxActive: next.maxActive,
        },
        'Subagents config updated',
      );
      res.json({ ok: true, config: next });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to save subagents config',
      });
    }
  });

  app.post('/api/subagents/runtime/:subagentId/stop', guard, (req, res) => {
    try {
      opts.auditMutation(req, 'subagents.runtime.stop', 'high');
      const subagentId = decodeURIComponent(routePathParam(req.params.subagentId)).trim();
      if (!subagentId) {
        res.status(400).json({ error: 'subagentId is required' });
        return;
      }

      const result = subagentRuntimeRegistry.requestStopSubagentRuntime(
        subagentId,
      );
      const status = String(
        (result as { status?: string }).status || '',
      ).trim();
      if (!result.ok && status === 'not_found') {
        res.status(404).json({ error: 'Sub-agent runtime not found' });
        return;
      }

      if (status === 'not_controllable') {
        res.json({
          ok: true,
          status: 'not_controllable',
          entry: (result as { entry?: unknown }).entry,
        });
        return;
      }

      res.json({
        ...result,
        status: status === 'stop_requested' ? 'accepted' : status,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to request subagent stop');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/subagents/runtime/:subagentId/message', guard, async (req, res) => {
    try {
      opts.auditMutation(req, 'subagents.runtime.message', 'high');
      const subagentId = decodeURIComponent(routePathParam(req.params.subagentId)).trim();
      const prompt =
        typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!subagentId) {
        res.status(400).json({ error: 'subagentId is required' });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      const requestMessageSubagentRuntime = getRegistryHook<
        (
          subagentId: string,
          prompt: string,
          options?: { waitForResponse?: boolean },
        ) => Promise<unknown> | unknown
      >('requestMessageSubagentRuntime');
      if (!requestMessageSubagentRuntime) {
        const fallback = resolveReadOnlyRuntimeResponse(subagentId);
        if (fallback.kind === 'not_found') {
          res.status(404).json({ error: 'Sub-agent runtime not found' });
          return;
        }
        res.json(fallback.payload);
        return;
      }

      const result = await requestMessageSubagentRuntime(subagentId, prompt, {
        waitForResponse: false,
      });
      const status = String(
        ((result as { status?: unknown })?.status as string) || '',
      ).trim();
      if (
        !(result as { ok?: boolean }).ok &&
        status === 'not_found'
      ) {
        res.status(404).json({ error: 'Sub-agent runtime not found' });
        return;
      }
      if (status === 'not_controllable') {
        res.json({
          ok: true,
          status: 'not_controllable',
          entry: (result as { entry?: unknown }).entry,
        });
        return;
      }

      res.json(normalizeControlResult(result, 'message_requested'));
    } catch (err) {
      logger.error({ err }, 'Failed to request subagent message');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/subagents/runtime/:subagentId/steer', guard, async (req, res) => {
    try {
      opts.auditMutation(req, 'subagents.runtime.steer', 'high');
      const subagentId = decodeURIComponent(routePathParam(req.params.subagentId)).trim();
      const prompt =
        typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      const reason =
        typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (!subagentId) {
        res.status(400).json({ error: 'subagentId is required' });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      const requestSteerSubagentRuntime = getRegistryHook<
        (
          subagentId: string,
          prompt: string,
          options?: { waitForResponse?: boolean },
        ) => Promise<unknown> | unknown
      >('requestSteerSubagentRuntime');
      if (!requestSteerSubagentRuntime) {
        const fallback = resolveReadOnlyRuntimeResponse(subagentId);
        if (fallback.kind === 'not_found') {
          res.status(404).json({ error: 'Sub-agent runtime not found' });
          return;
        }
        res.json(fallback.payload);
        return;
      }

      const steerPrompt = reason ? `${prompt}\n\nReason: ${reason}` : prompt;
      const result = await requestSteerSubagentRuntime(
        subagentId,
        steerPrompt,
        { waitForResponse: false },
      );
      const status = String(
        ((result as { status?: unknown })?.status as string) || '',
      ).trim();
      if (
        !(result as { ok?: boolean }).ok &&
        status === 'not_found'
      ) {
        res.status(404).json({ error: 'Sub-agent runtime not found' });
        return;
      }
      if (status === 'not_controllable') {
        res.json({
          ok: true,
          status: 'not_controllable',
          entry: (result as { entry?: unknown }).entry,
        });
        return;
      }

      res.json(normalizeControlResult(result, 'steer_requested'));
    } catch (err) {
      logger.error({ err }, 'Failed to request subagent steer');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/maintenance/orphans', guard, async (_req, res) => {
    try {
      res.json(await scanOrphanWorkspaces());
    } catch (err) {
      logger.error({ err }, 'Failed to scan orphan workspaces');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/maintenance/orphans/cleanup', guard, async (req, res) => {
    try {
      opts.auditMutation(req, 'maintenance.orphans.cleanup', 'high');
      res.json(await cleanupOrphanWorkspaces());
    } catch (err) {
      logger.error({ err }, 'Failed to cleanup orphan workspaces');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
