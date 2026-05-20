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
import { decryptValue, encryptValue } from '../crypto.js';
import {
  normalizeChannelInstances,
  type ChannelInstanceConfig,
} from '../config-store-channel-instances.js';
import { reloadChannels } from '../runtime/runtime-channels.js';
import { logger } from '../logger.js';

export interface ChannelInstanceRouteOptions {
  requirePermission: RequirePermissionFn;
  reloadChannels?: () => Promise<{
    disconnected: string[];
    connected: string[];
    errors: string[];
  }>;
}

type UserChannelConfigValue = string | boolean;
type UserChannelConfig = Record<string, UserChannelConfigValue>;

function isSensitiveConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('key')
  );
}

function decryptConfig(configJson: string): UserChannelConfig {
  const parsed = JSON.parse(configJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? decryptValue(value)
        : typeof value === 'boolean'
          ? value
          : String(value ?? ''),
    ]),
  );
}

function encryptConfig(
  config: UserChannelConfig,
): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      isSensitiveConfigKey(key) && typeof value === 'string'
        ? encryptValue(value)
        : value,
    ]),
  );
}

function sanitizeConfig(config: UserChannelConfig): UserChannelConfig {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (!isSensitiveConfigKey(key) || typeof value !== 'string') {
        return [key, value];
      }
      return [key, value.length > 4 ? `${value.slice(0, 4)}****` : '****'];
    }),
  );
}

async function getExistingUserInstances(
  userId: string,
): Promise<ChannelInstanceConfig[]> {
  const rows = await getChannelInstancesForUser(userId);
  const instances: ChannelInstanceConfig[] = [];
  for (const row of rows) {
    instances.push({
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled !== 0,
      visibility: 'private',
      owner_id: userId,
      config: decryptConfig(row.config_json),
    });
  }
  return instances;
}

async function normalizeUserChannelPayload(
  userId: string,
  input: {
    id: string;
    type?: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  },
): Promise<ChannelInstanceConfig> {
  const existing = await getExistingUserInstances(userId);
  const existingInstance = existing.find((entry) => entry.id === input.id);
  const [normalized] = await normalizeChannelInstances(
    [
      {
        id: input.id,
        type: input.type ?? existingInstance?.type,
        name: input.name ?? existingInstance?.name,
        enabled: input.enabled ?? existingInstance?.enabled ?? true,
        visibility: 'private',
        owner_id: userId,
        config: input.config ?? {},
      },
    ],
    existing,
  );
  if (!normalized) {
    throw new Error('Invalid channel instance');
  }
  return normalized;
}

async function reloadUserChannels(
  opts: ChannelInstanceRouteOptions,
): Promise<{ disconnected: string[]; connected: string[]; errors: string[] }> {
  const reload = opts.reloadChannels ?? reloadChannels;
  try {
    return await reload();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err },
      'User channel instance saved but runtime reload failed',
    );
    return { disconnected: [], connected: [], errors: [message] };
  }
}

export function registerChannelInstanceRoutes(
  app: Express,
  opts: ChannelInstanceRouteOptions,
): void {
  const listGuard = opts.requirePermission('channel.own');
  const createGuard = opts.requirePermission('channel.personal.create');
  const editGuard = opts.requirePermission('channel.personal.edit');

  app.get('/api/user/channels', listGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const instances = await getChannelInstancesForUser(userId);
      const safe = instances.map((inst) => ({
        id: inst.id,
        type: inst.type,
        name: inst.name,
        enabled: inst.enabled !== 0,
        visibility: 'private',
        owner_id: userId,
        config: sanitizeConfig(decryptConfig(inst.config_json)),
      }));
      res.json(safe);
    } catch (err) {
      logger.error({ err }, 'Failed to list channel instances');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/channels', createGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const { type, name, enabled, config } = req.body as {
        type?: string;
        name?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      };

      if (!type || !name) {
        res.status(400).json({ error: 'type and name are required' });
        return;
      }

      const id = crypto.randomUUID();
      const normalized = await normalizeUserChannelPayload(userId, {
        id,
        type,
        name,
        enabled,
        config,
      });
      await upsertChannelInstance(userId, {
        id,
        type: normalized.type,
        name: normalized.name,
        enabled: normalized.enabled,
        configJson: JSON.stringify(encryptConfig(normalized.config)),
      });

      await auditAdminAction(req, AUDIT_ACTIONS.CHANNEL_CREATE, {
        targetType: 'channel_instances',
        targetId: id,
        targetName: name,
      });
      const reload = await reloadUserChannels(opts);
      res.json({ ok: true, id, reload });
    } catch (err) {
      logger.error({ err }, 'Failed to create channel instance');
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid channel instance',
      });
    }
  });

  app.put('/api/user/channels/:id', editGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawId = req.params.id;
      const channelId =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      const { type, name, enabled, config } = req.body as {
        type?: string;
        name?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
      };

      const normalized = await normalizeUserChannelPayload(userId, {
        id: channelId,
        type,
        name,
        enabled,
        config,
      });

      await upsertChannelInstance(userId, {
        id: channelId,
        type: normalized.type,
        name: normalized.name,
        enabled: normalized.enabled,
        configJson: JSON.stringify(encryptConfig(normalized.config)),
      });

      const reload = await reloadUserChannels(opts);
      res.json({ ok: true, reload });
    } catch (err) {
      logger.error({ err }, 'Failed to update channel instance');
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid channel instance',
      });
    }
  });

  app.delete('/api/user/channels/:id', editGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawId = req.params.id;
      const channelId =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? (rawId[0] ?? '')
            : '';
      await deleteChannelInstance(userId, channelId);
      await auditAdminAction(req, AUDIT_ACTIONS.CHANNEL_DELETE, {
        targetType: 'channel_instances',
        targetId: channelId,
      });
      const reload = await reloadUserChannels(opts);
      res.json({ ok: true, reload });
    } catch (err) {
      logger.error({ err }, 'Failed to delete channel instance');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
