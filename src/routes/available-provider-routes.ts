import type { Express } from 'express';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import {
  getUserDefaultProviderPreference,
  getVisibleProvidersForUser,
  isProviderSharedWithUser,
} from '../db.js';
import { serializeProviderForClient } from '../provider/provider-http-config.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { maskApiKey } from '../crypto.js';
import { logger } from '../logger.js';
import { deriveProviderCapability, type ProviderCapability } from '../provider/provider-registry.js';

export interface AvailableProviderRouteOptions {
  requirePermission: RequirePermissionFn;
}

export function registerAvailableProviderRoutes(
  app: Express,
  opts: AvailableProviderRouteOptions,
): void {
  const guard = opts.requirePermission('system.providers', 'provider.system.view');

  app.get('/api/providers/available', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawCapability = typeof req.query.capability === 'string' ? req.query.capability.trim() : '';
      const capability: ProviderCapability | 'all' =
        rawCapability === 'embedding'
          ? 'embedding'
          : rawCapability === 'all'
            ? 'all'
            : 'llm';
      const providers = await getVisibleProvidersForUser(userId, capability);
      const userDefault = await getUserDefaultProviderPreference(userId);
      const result = await Promise.all(providers.map(async (p) => {
        const serialized = serializeProviderForClient(p);
        const isSystem = p.user_id === SYSTEM_USER_ID;
        const isOwn = p.user_id === userId;
        const isShared = !isSystem && !isOwn && await isProviderSharedWithUser(p.id, userId);
        return {
          id: serialized.id,
          alias: serialized.alias,
          type: serialized.type,
          capability: deriveProviderCapability(serialized),
          model: serialized.model,
          dimensions: serialized.dimensions ?? null,
          base_url: serialized.base_url,
          is_default: serialized.is_default,
          is_user_default:
            deriveProviderCapability(serialized) === 'llm' && userDefault?.provider_id === p.id,
          visibility: serialized.visibility,
          source: (isSystem ? 'system' : isOwn ? 'own' : isShared ? 'shared' : 'system') as
            | 'system'
            | 'own'
            | 'shared',
          is_global_default: p.user_id === SYSTEM_USER_ID && p.is_default === 1,
          owner_user_id: p.user_id,
          api_key: p.api_key ? maskApiKey(p.api_key) : null,
          user_agent: serialized.user_agent,
          custom_headers: serialized.custom_headers,
        };
      }));
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to list available providers');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
