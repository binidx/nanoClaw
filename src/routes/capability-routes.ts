import type { Express, Request } from 'express';

import {
  buildCapabilityCatalog,
  type ManagedSkillCatalogEntry,
} from '../capabilities/capability-catalog.js';
import {
  listAssistantMcpBindings,
  listAssistants,
  listUserMcpServers,
  listUserSkills,
} from '../db.js';
import { listAssistantRepoBindings } from '../assistant/assistant-repo.js';
import { getRepositoryList } from '../repo-review/repository-service.js';
import { listWorkflows } from '../db/workflows.js';
import type { ManagedMcpTemplate } from '../assistant/assistant-mcp.js';
import { logger } from '../logger.js';
import { getTenantUserId } from '../tenant/tenant-request.js';

export interface CapabilityRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  listAvailableManagedSkills: () =>
    | ManagedSkillCatalogEntry[]
    | Promise<ManagedSkillCatalogEntry[]>;
  listAvailableManagedMcpServers: () =>
    | ManagedMcpTemplate[]
    | Promise<ManagedMcpTemplate[]>;
}

export function registerCapabilityRoutes(
  app: Express,
  opts: CapabilityRouteOptions,
): void {
  const viewGuard = opts.requirePermission(
    'assistant.view',
    'project.view',
    'workteam.view',
  );

  app.get('/api/capabilities/catalog', viewGuard, async (req: Request, res) => {
    try {
      const userId = getTenantUserId(req);
      const [
        assistants,
        repositories,
        workflows,
        managedSkills,
        managedMcpTemplates,
        userSkills,
        userMcpServers,
      ] = await Promise.all([
        listAssistants({ userId }),
        getRepositoryList(userId),
        listWorkflows(),
        Promise.resolve(opts.listAvailableManagedSkills()),
        Promise.resolve(opts.listAvailableManagedMcpServers()),
        listUserSkills({ userId, enabled: true }),
        listUserMcpServers({ userId, enabled: true }),
      ]);

      const assistantRepoBindingsByAssistantId = new Map(
        await Promise.all(
          assistants.map(async (assistant) => [
            assistant.id,
            await listAssistantRepoBindings(assistant.id),
          ] as const),
        ),
      );
      const assistantMcpBindingsByAssistantId = new Map(
        await Promise.all(
          assistants.map(async (assistant) => [
            assistant.id,
            await listAssistantMcpBindings(assistant.id),
          ] as const),
        ),
      );

      res.json(
        buildCapabilityCatalog({
          assistants,
          repositories,
          workflows,
          managedSkills,
          managedMcpTemplates,
          userSkills,
          userMcpServers,
          assistantRepoBindingsByAssistantId,
          assistantMcpBindingsByAssistantId,
        }),
      );
    } catch (err) {
      logger.error({ err }, 'Failed to build capability catalog');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
