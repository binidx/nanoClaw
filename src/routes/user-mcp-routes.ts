import type { Express, Request, Response } from 'express';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  createUserMcpServer,
  createUserMcpServerWithAi,
  importUserMcpServersFromJson,
  importUserMcpServerFromPath,
  updateUserMcpServer,
  removeUserMcpServer,
  toggleMcpVisibility,
  listMyMcpServers,
  listAllVisibleMcpServers,
  installSharedMcpToUser,
} from '../user/user-mcp-service.js';
import { logger } from '../logger.js';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';

function paramStr(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : '';
}

export interface UserMcpRouteOptions {
  requirePermission: RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
}

export function registerUserMcpRoutes(
  app: Express,
  opts: UserMcpRouteOptions,
): void {
  const viewGuard = opts.requirePermission('assistant.manage', 'assistant.view');
  const createGuard = opts.requirePermission('assistant.manage', 'assistant.edit');
  const installGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');

  app.get('/api/user/mcp-servers', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const servers = await listAllVisibleMcpServers(userId);
      res.json(servers);
    } catch (err) {
      logger.error({ err }, 'user-mcp: list failed');
      res.status(500).json({ error: 'Failed to list MCP servers' });
    }
  });

  app.get('/api/user/mcp-servers/mine', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const servers = await listMyMcpServers(userId);
      res.json(servers);
    } catch (err) {
      logger.error({ err }, 'user-mcp: list mine failed');
      res.status(500).json({ error: 'Failed to list my MCP servers' });
    }
  });

  app.post('/api/user/mcp-servers', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const {
        name,
        description,
        transport,
        command,
        args,
        env,
        url,
        cwd,
        enabled,
        visibility,
        tags,
        metadata,
      } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const server = await createUserMcpServer(userId, {
        name,
        description,
        transport,
        command,
        args,
        env,
        url,
        cwd,
        enabled,
        visibility,
        tags,
        metadata,
      });
      res.json(server);
    } catch (err) {
      logger.error({ err }, 'user-mcp: create failed');
      res.status(500).json({ error: 'Failed to create MCP server' });
    }
  });

  app.post('/api/user/mcp-servers/ai-generate', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      res.json(await createUserMcpServerWithAi(userId, req.body || {}));
    } catch (err) {
      logger.error({ err }, 'user-mcp: ai-generate failed');
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to generate MCP with AI',
      });
    }
  });

  app.post('/api/user/mcp-servers/import-json', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      res.json(await importUserMcpServersFromJson(userId, req.body || {}));
    } catch (err) {
      logger.error({ err }, 'user-mcp: import-json failed');
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to import MCP from JSON',
      });
    }
  });

  app.post('/api/user/mcp-servers/import-path', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      res.json(await importUserMcpServerFromPath(userId, req.body || {}));
    } catch (err) {
      logger.error({ err }, 'user-mcp: import-path failed');
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to import MCP from path',
      });
    }
  });

  app.put('/api/user/mcp-servers/:id', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const mcpId = paramStr(req.params.id);
      const result = await updateUserMcpServer(userId, mcpId, req.body);
      if (!result) {
        res.status(404).json({ error: 'MCP server not found or not owned' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-mcp: update failed');
      res.status(500).json({ error: 'Failed to update MCP server' });
    }
  });

  app.delete('/api/user/mcp-servers/:id', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const ok = await removeUserMcpServer(userId, paramStr(req.params.id));
      if (!ok) {
        res.status(404).json({ error: 'MCP server not found or not owned' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'user-mcp: delete failed');
      res.status(500).json({ error: 'Failed to delete MCP server' });
    }
  });

  app.post('/api/user/mcp-servers/:id/toggle-visibility', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const result = await toggleMcpVisibility(userId, paramStr(req.params.id));
      if (!result) {
        res.status(404).json({ error: 'MCP server not found or not owned' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-mcp: toggle-visibility failed');
      res.status(500).json({ error: 'Failed to toggle visibility' });
    }
  });

  app.post('/api/user/mcp-servers/install-shared', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const { sourceMcpId } = req.body;
      if (!sourceMcpId) {
        res.status(400).json({ error: 'sourceMcpId is required' });
        return;
      }
      const result = await installSharedMcpToUser(userId, sourceMcpId);
      if (!result) {
        res.status(404).json({ error: 'Shared MCP server not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-mcp: install-shared failed');
      res.status(500).json({ error: 'Failed to install shared MCP server' });
    }
  });
}
