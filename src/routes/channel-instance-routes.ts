import type { Express } from 'express';
import crypto from 'crypto';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  getChannelInstancesForUser,
  upsertChannelInstance,
  deleteChannelInstance,
} from '../tenant/tenant-db.js';
import { encryptValue } from '../crypto.js';
import { logger } from '../logger.js';

export interface ChannelInstanceRouteOptions {
  requirePermission: RequirePermissionFn;
}

export function registerChannelInstanceRoutes(
  app: Express,
  opts: ChannelInstanceRouteOptions,
): void {
  const guard = opts.requirePermission('channel.own', 'channel.personal.create');
  app.get('/api/user/channels', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const instances = await getChannelInstancesForUser(userId);
      const safe = instances.map((inst) => {
        let parsedConfig: Record<string, unknown> = {};
        try { parsedConfig = JSON.parse(inst.config_json); } catch { /* */ }
        // Mask sensitive fields
        for (const key of Object.keys(parsedConfig)) {
          const lower = key.toLowerCase();
          if (lower.includes('token') || lower.includes('secret') || lower.includes('password')) {
            const val = String(parsedConfig[key] || '');
            parsedConfig[key] = val.length > 4 ? `${val.slice(0, 4)}****` : '****';
          }
        }
        return { ...inst, config_json: undefined, config: parsedConfig };
      });
      res.json(safe);
    } catch (err) {
      logger.error({ err }, 'Failed to list channel instances');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/channels', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const { type, name, enabled, config } = req.body as {
        type?: string;
        name?: string;
        enabled?: boolean;
        config?: Record<string, string>;
      };

      if (!type || !name) {
        res.status(400).json({ error: 'type and name are required' });
        return;
      }

      // Encrypt sensitive fields in config
      const encryptedConfig: Record<string, string> = {};
      if (config) {
        for (const [k, v] of Object.entries(config)) {
          const lower = k.toLowerCase();
          if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('key')) {
            encryptedConfig[k] = encryptValue(v);
          } else {
            encryptedConfig[k] = v;
          }
        }
      }

      const id = crypto.randomUUID();
      await upsertChannelInstance(userId, {
        id,
        type,
        name,
        enabled,
        configJson: JSON.stringify(encryptedConfig),
      });

      await auditAdminAction(req, AUDIT_ACTIONS.CHANNEL_CREATE, { targetType: 'channel_instances', targetId: id, targetName: name });
      res.json({ ok: true, id });
    } catch (err) {
      logger.error({ err }, 'Failed to create channel instance');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/user/channels/:id', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawId = req.params.id;
      const channelId =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const { type, name, enabled, config } = req.body as {
        type?: string;
        name?: string;
        enabled?: boolean;
        config?: Record<string, string>;
      };

      const encryptedConfig: Record<string, string> = {};
      if (config) {
        for (const [k, v] of Object.entries(config)) {
          const lower = k.toLowerCase();
          if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('key')) {
            encryptedConfig[k] = encryptValue(v);
          } else {
            encryptedConfig[k] = v;
          }
        }
      }

      await upsertChannelInstance(userId, {
        id: channelId,
        type: type || 'unknown',
        name: name || 'unnamed',
        enabled,
        configJson: JSON.stringify(encryptedConfig),
      });

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to update channel instance');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/user/channels/:id', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawId = req.params.id;
      const channelId =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      await deleteChannelInstance(userId, channelId);
      await auditAdminAction(req, AUDIT_ACTIONS.CHANNEL_DELETE, { targetType: 'channel_instances', targetId: channelId });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete channel instance');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
