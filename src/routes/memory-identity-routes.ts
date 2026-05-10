import type { Express, Request } from 'express';

import type {
  BindConversationIdentityInput,
  CreateMemoryIdentityInput,
  MemoryIdentityService,
} from '../memory/identity-service.js';
import { logger } from '../logger.js';

export interface MemoryIdentityRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  service: MemoryIdentityService;
  auditMutation?: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

function readObjectBody(req: Request): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return {};
}

export function registerMemoryIdentityRoutes(
  app: Express,
  options: MemoryIdentityRouteOptions,
): void {
  const guard = options.requirePermission('assistant.manage', 'assistant.edit');
  app.get('/api/memory/identities', guard, async (_req, res) => {
    try {
      res.json({ identities: await options.service.listProfiles() });
    } catch (err) {
      logger.error({ err }, 'Failed to list memory identities');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/memory/identities/:id', guard, async (req, res) => {
    try {
      const id = decodeURIComponent(String(req.params.id || '')).trim();
      const identity = id ? await options.service.getIdentityDetail(id) : null;
      if (!identity) {
        res.status(404).json({ error: 'Identity not found' });
        return;
      }
      res.json({ identity });
    } catch (err) {
      logger.error({ err }, 'Failed to get memory identity');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/memory/identities', guard, async (req, res) => {
    try {
      options.auditMutation?.(req, 'memory.identities.create', 'high');
      const body = readObjectBody(req);
      const identity = await options.service.createProfile({
        id: typeof body.id === 'string' ? body.id : undefined,
        displayName: typeof body.displayName === 'string' ? body.displayName : '',
        notes: Array.isArray(body.notes)
          ? body.notes.filter((value): value is string => typeof value === 'string')
          : undefined,
        aliases: Array.isArray(body.aliases)
          ? body.aliases.filter(
              (value): value is Record<string, unknown> =>
                Boolean(value) && typeof value === 'object' && !Array.isArray(value),
            )
          : undefined,
      } satisfies CreateMemoryIdentityInput);
      res.json({ identity });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to create identity',
      });
    }
  });

  app.post('/api/memory/identities/bind', guard, async (req, res) => {
    try {
      options.auditMutation?.(req, 'memory.identities.bind', 'high');
      const body = readObjectBody(req);
      const binding = await options.service.bindConversation({
        chatJid: typeof body.chatJid === 'string' ? body.chatJid : '',
        groupFolder:
          typeof body.groupFolder === 'string' ? body.groupFolder : '',
        personId: typeof body.personId === 'string' ? body.personId : '',
      } satisfies BindConversationIdentityInput);
      res.json({ binding });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to bind identity',
      });
    }
  });
}
