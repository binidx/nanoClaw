import type { Express } from 'express';
import crypto from 'crypto';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import {
  createProvider,
  deleteProvider,
  getProvidersForUser,
  getProvider,
  getDefaultProviderForUser,
  getKnowledgeBaseProviderUsage,
  getProviderShareList,
  isProviderVisibleToUser,
  revokeProviderShare,
  setUserDefaultProviderPreference,
  shareProviderWithUser,
  updateProvider,
} from '../db.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { encryptValue, maskApiKey } from '../crypto.js';
import { logger } from '../logger.js';
import {
  buildProviderExtraConfigValue,
  serializeProviderForClient,
} from '../provider/provider-http-config.js';
import type { ProviderCapability } from '../provider/provider-registry.js';
import { isValidProviderType } from '../provider/provider-registry.js';
import { testAiProviderConnection } from '../provider/provider-api.js';
import { t } from '../i18n/index.js';

export interface UserProviderRouteOptions {
  requirePermission: RequirePermissionFn;
}

function routeParam(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
}

function normalizeProviderCapability(raw: unknown): ProviderCapability {
  return String(raw || '').trim().toLowerCase() === 'embedding'
    ? 'embedding'
    : 'llm';
}

function embeddingMaterialChanged(
  provider: Awaited<ReturnType<typeof getProvider>>,
  next: {
    capability: ProviderCapability;
    type?: string;
    api_key?: string;
    base_url?: string | null;
    model?: string | null;
    dimensions?: number | null;
  },
): boolean {
  if (!provider) return false;
  return (
    (provider.capability || 'llm') !== next.capability ||
    (next.type !== undefined && next.type !== provider.type) ||
    (next.api_key !== undefined && next.api_key !== provider.api_key) ||
    (next.base_url !== undefined && next.base_url !== provider.base_url) ||
    (next.model !== undefined && next.model !== provider.model) ||
    (next.dimensions !== undefined && next.dimensions !== provider.dimensions)
  );
}

export function registerUserProviderRoutes(
  app: Express,
  opts: UserProviderRouteOptions,
): void {
  const guard = opts.requirePermission('system.providers', 'provider.system.view', 'provider.personal.create');
  app.get('/api/user/providers', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const rawCapability = typeof req.query.capability === 'string' ? req.query.capability.trim() : '';
      const capability = rawCapability === 'embedding' || rawCapability === 'all'
        ? rawCapability as ProviderCapability | 'all'
        : 'llm';
      const providers = await getProvidersForUser(userId, capability);
      const masked = providers.map((p) => ({
        ...serializeProviderForClient(p),
        api_key: p.api_key ? maskApiKey(p.api_key) : null,
        source: 'own' as const,
      }));
      res.json(masked);
    } catch (err) {
      logger.error({ err }, 'Failed to list user providers');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/providers', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const {
        alias,
        type,
        capability: capabilityRaw,
        api_key,
        base_url,
        model,
        dimensions,
        extra_config,
        user_agent,
        custom_headers,
        is_default,
      } = req.body as {
        alias?: string;
        type?: string;
        capability?: string;
        api_key?: string;
        base_url?: string;
        model?: string;
        dimensions?: number | string | null;
        extra_config?: unknown;
        user_agent?: unknown;
        custom_headers?: unknown;
        is_default?: boolean;
      };

      if (!alias || !type) {
        res.status(400).json({ error: 'alias and type are required' });
        return;
      }
      const capability = normalizeProviderCapability(capabilityRaw);
      if (!isValidProviderType(type, capability)) {
        res.status(400).json({ error: `Invalid provider type: ${type}` });
        return;
      }
      if (capability === 'embedding' && is_default) {
        res.status(400).json({ error: 'Embedding provider cannot be a default chat provider' });
        return;
      }

      const id = crypto.randomUUID();
      const encryptedKey = api_key ? encryptValue(api_key) : null;
      const numericDimensions =
        dimensions === null || dimensions === undefined || String(dimensions).trim() === ''
          ? null
          : Number(dimensions);
      if (numericDimensions !== null && (!Number.isInteger(numericDimensions) || numericDimensions <= 0)) {
        res.status(400).json({ error: 'dimensions must be a positive integer' });
        return;
      }

      await createProvider({
        id,
        alias,
        type,
        capability,
        api_key: encryptedKey,
        base_url: base_url || null,
        model: model || null,
        dimensions: numericDimensions,
        extra_config: buildProviderExtraConfigValue({
          extra_config,
          user_agent,
          custom_headers,
        }),
        is_default: is_default ? 1 : 0,
        user_id: userId,
        visibility: 'private',
        created_by: userId,
        updated_by: userId,
      });
      if (is_default) {
        await setUserDefaultProviderPreference(userId, id, userId);
      }

      res.json({ id, alias, type });
    } catch (err) {
      logger.error({ err }, 'Failed to create user provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/user/providers/default', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { providerId?: string | null };
      const providerId = body.providerId?.trim() || null;
      await setUserDefaultProviderPreference(userId, providerId, userId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('visible')) {
        res.status(403).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to set default provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/user/providers/:id', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const providerId = routeParam(req.params.id);
      const provider = await getProvider(providerId);
      if (!provider || provider.user_id !== userId) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }

      const {
        alias,
        type,
        capability: capabilityRaw,
        api_key,
        base_url,
        model,
        dimensions,
        extra_config,
        user_agent,
        custom_headers,
        is_default,
      } = req.body as {
        alias?: string;
        type?: string;
        capability?: string;
        api_key?: string;
        base_url?: string;
        model?: string;
        dimensions?: number | string | null;
        extra_config?: unknown;
        user_agent?: unknown;
        custom_headers?: unknown;
        is_default?: boolean;
      };
      const nextCapability = capabilityRaw !== undefined
        ? normalizeProviderCapability(capabilityRaw)
        : (provider.capability || 'llm');
      if (type !== undefined && !isValidProviderType(type, nextCapability)) {
        res.status(400).json({ error: `Invalid provider type: ${type}` });
        return;
      }
      if (nextCapability === 'embedding' && is_default) {
        res.status(400).json({ error: 'Embedding provider cannot be a default chat provider' });
        return;
      }

      const encryptedKey =
        typeof api_key === 'string' && /\*{4,}/.test(api_key)
          ? provider.api_key
          : api_key
            ? encryptValue(api_key)
            : provider.api_key;
      const numericDimensions =
        dimensions === null || dimensions === undefined || String(dimensions).trim() === ''
          ? null
          : Number(dimensions);
      if (numericDimensions !== null && (!Number.isInteger(numericDimensions) || numericDimensions <= 0)) {
        res.status(400).json({ error: 'dimensions must be a positive integer' });
        return;
      }
      const usage = await getKnowledgeBaseProviderUsage(providerId);
      if (usage.embeddingRefs > 0 && nextCapability !== 'embedding') {
        res.status(409).json({ error: t('errors.auto_2575b3', {}, req.locale) });
        return;
      }
      if (usage.llmRefs > 0 && nextCapability !== 'llm') {
        res.status(409).json({ error: t('errors.auto_346c7b', {}, req.locale) });
        return;
      }
      const requiresKnowledgeReembed =
        usage.embeddingRefs > 0 &&
        embeddingMaterialChanged(provider, {
          capability: nextCapability,
          type,
          api_key: encryptedKey || undefined,
          base_url: base_url !== undefined ? (base_url || undefined) : undefined,
          model: model !== undefined ? (model || undefined) : undefined,
          dimensions: dimensions !== undefined ? numericDimensions : undefined,
        });

      await updateProvider(providerId, {
        alias: alias || provider.alias,
        type: type || provider.type,
        capability: nextCapability,
        api_key: encryptedKey,
        base_url: base_url !== undefined ? base_url : provider.base_url,
        model: model !== undefined ? model : provider.model,
        dimensions: dimensions !== undefined ? numericDimensions : provider.dimensions,
        extra_config: buildProviderExtraConfigValue(
          {
            extra_config,
            user_agent,
            custom_headers,
          },
          provider.extra_config,
        ),
        is_default: is_default ? 1 : 0,
        visibility: 'private',
        updated_by: userId,
      });
      if (is_default) {
        await setUserDefaultProviderPreference(userId, providerId, userId);
      }

      res.json({
        ok: true,
        requiresKnowledgeReembed,
        knowledgeBaseRefs: usage.embeddingRefs,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update user provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/user/providers/:id', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const providerId = routeParam(req.params.id);
      const provider = await getProvider(providerId);
      if (!provider || provider.user_id !== userId) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      const usage = await getKnowledgeBaseProviderUsage(providerId);
      if (usage.embeddingRefs > 0 || usage.llmRefs > 0) {
        res.status(409).json({ error: t('errors.auto_b2e6cc', {}, req.locale) });
        return;
      }
      await deleteProvider(providerId, userId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete user provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/user/providers/default', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const provider = await getDefaultProviderForUser(userId);
      if (!provider) {
        res.json(null);
        return;
      }
      res.json({
        ...serializeProviderForClient(provider),
        api_key: provider.api_key ? maskApiKey(provider.api_key) : null,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get default provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/user/providers/:id/knowledge-usage', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const providerId = routeParam(req.params.id);
      const provider = await getProvider(providerId);
      if (!provider || provider.user_id !== userId) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      res.json(await getKnowledgeBaseProviderUsage(providerId));
    } catch (err) {
      logger.error({ err }, 'Failed to get knowledge provider usage');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/user/providers/:id/shares', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      res.json(await getProviderShareList(routeParam(req.params.id), userId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('owner')) {
        res.status(403).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to list provider shares');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/providers/:id/shares', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const body = req.body as { user_id?: string; userId?: string };
      const targetUserId = (body.user_id || body.userId || '').trim();
      if (!targetUserId) {
        res.status(400).json({ error: 'user_id is required' });
        return;
      }
      await shareProviderWithUser(routeParam(req.params.id), targetUserId, userId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('owner') || message.includes('Invalid') || message.includes('not found')) {
        res.status(400).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to share provider');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/user/providers/:id/shares/:userId', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      await revokeProviderShare(routeParam(req.params.id), routeParam(req.params.userId), userId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('owner')) {
        res.status(403).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to revoke provider share');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/user/providers/:id/test', guard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const providerId = routeParam(req.params.id);
      const provider = await getProvider(providerId);
      if (!provider || !await isProviderVisibleToUser(providerId, userId)) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      res.json(await testAiProviderConnection(provider));
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });
}
