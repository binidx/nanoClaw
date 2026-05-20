import type { Express, Request } from 'express';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import { parseAllowedDirectoriesValue } from '../security/allowed-directories.js';
import { normalizeAccessMode } from '../auth/access-policy.js';
import { normalizeBashApprovalAllowlist } from '../security/bash-approval-allowlist.js';
import {
  getConfigValue,
  getSanitizedChannelInstances,
  saveConfiguredChannelInstances,
} from '../config-store.js';
import {
  createProvider,
  deleteConfig,
  deleteProvider,
  getAllSystemProviders,
  getProvider,
  getKnowledgeBaseProviderUsage,
  getProviderRoleAccessList,
  getProviderUserAccessList,
  grantProviderRoleAccess,
  grantProviderUserAccess,
  revokeProviderRoleAccess,
  revokeProviderUserAccess,
  syncProviderRoleAccess,
  syncProviderUserAccess,
  setConfig,
  updateProvider,
} from '../db.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import { encryptValue, maskApiKey } from '../crypto.js';
import { logger } from '../logger.js';
import {
  buildProviderExtraConfigValue,
  serializeProviderForClient,
} from '../provider/provider-http-config.js';
import { getAllProviderTypeDefs, isValidProviderType } from '../provider/provider-registry.js';
import { testAiProviderConnection } from '../provider/provider-api.js';
import {
  assertSenderAllowlistConfigShape,
  saveSenderAllowlist,
} from '../security/sender-allowlist.js';
import { normalizeBrowserConfigEntry } from '../browser/config.js';
import { normalizeWebSearchConfigEntry } from '../config/web-search-config.js';
import type { ProviderCapability } from '../provider/provider-registry.js';
import { t } from '../i18n/index.js';

type AuthSessionStore = {
  revokeAll: () => void;
  create: (username: string) => { token: string };
};

export interface AdminSettingsRouteOptions {
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  allowedConfigKeys: Set<string>;
  sensitiveConfigKeys: ReadonlySet<string>;
  applyProcessConfigSideEffects: (
    entries: Record<string, string | null | undefined>,
  ) => void;
  summarizeConfigEffects: (keys: string[]) => Record<string, string[]>;
  isAuthenticatedRequest: (req: Request) => boolean;
  clearBootstrapCredentials: () => void;
  authSessions: AuthSessionStore;
  getLoginCredentials: () => { username: string };
  serializeAuthCookie: (token: string, secure: boolean) => string;
  normalizeCodexApiBase: (baseUrl: string) => string;
  readFirstCodexChatCompletionText: (
    resp: Response,
  ) => Promise<{ text: string; model?: string }>;
  reloadChannels: () => Promise<{
    disconnected: string[];
    connected: string[];
    errors: string[];
  }>;
  requirePermission: RequirePermissionFn;
}

async function buildMaskedProviders() {
  return (await getAllSystemProviders()).map((provider) => ({
    ...serializeProviderForClient(provider),
    api_key: provider.api_key ? maskApiKey(provider.api_key) : null,
  }));
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
    api_key?: string | null;
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

const MEMORY_BOOLEAN_CONFIG_KEYS = new Set([
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_GLOBAL_WRITE_ENABLED',
  'MEMORY_AUTO_SAVE_ENABLED',
  'MEMORY_PROMPT_INJECTION_ENABLED',
  'MEMORY_COMPACTION_ENABLED',
]);

const MEMORY_WRITE_MODES = new Set(['disabled', 'daily-only']);
const MEMORY_SEARCH_SCOPES = new Set(['group', 'global', 'all']);
const CHAT_CONTEXT_INTEGER_KEYS = new Map<string, { min: number; max: number }>([
  ['CHAT_CONTEXT_TOKEN_BUDGET', { min: 0, max: 12000 }],
  ['CHAT_CONTEXT_RECENT_CHAT_RATIO', { min: 0, max: 100 }],
  ['CHAT_CONTEXT_RECENT_TOOL_RATIO', { min: 0, max: 100 }],
  ['CHAT_CONTEXT_MEMORY_RECALL_RATIO', { min: 0, max: 100 }],
  ['CHAT_CONTEXT_SUMMARY_RATIO', { min: 0, max: 100 }],
  ['CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES', { min: 1, max: 100 }],
  ['CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS', { min: 1, max: 50 }],
  ['CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES', { min: 10, max: 500 }],
  ['CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES', { min: 1, max: 100 }],
]);

function normalizeBooleanConfigValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === 'false') {
    return normalized;
  }
  throw new Error(`Invalid config value for ${key}: expected true or false`);
}

function normalizeBoundedIntegerConfigValue(
  key: string,
  value: unknown,
  min: number,
  max: number,
): string {
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid config value for ${key}: expected integer between ${min} and ${max}`,
    );
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid config value for ${key}: expected integer between ${min} and ${max}`,
    );
  }
  return String(parsed);
}

export function normalizeMemoryConfigEntry(
  key: string,
  value: unknown,
): string {
  const rawValue = String(value).trim();
  if (!rawValue) return '';

  if (MEMORY_BOOLEAN_CONFIG_KEYS.has(key)) {
    return normalizeBooleanConfigValue(key, value);
  }

  if (key === 'MEMORY_WRITE_MODE') {
    const normalized = rawValue.toLowerCase();
    if (!MEMORY_WRITE_MODES.has(normalized)) {
      throw new Error(
        `Invalid config value for ${key}: expected one of ${[...MEMORY_WRITE_MODES].join(', ')}`,
      );
    }
    return normalized;
  }

  if (key === 'MEMORY_SEARCH_SCOPE_DEFAULT') {
    const normalized = rawValue.toLowerCase();
    if (!MEMORY_SEARCH_SCOPES.has(normalized)) {
      throw new Error(
        `Invalid config value for ${key}: expected one of ${[...MEMORY_SEARCH_SCOPES].join(', ')}`,
      );
    }
    return normalized;
  }

  if (key === 'MEMORY_SEARCH_MAX_RESULTS') {
    return normalizeBoundedIntegerConfigValue(key, value, 1, 8);
  }

  if (key === 'MEMORY_PROMPT_MAX_SNIPPETS') {
    return normalizeBoundedIntegerConfigValue(key, value, 0, 10);
  }

  if (key === 'MEMORY_PROMPT_TOKEN_BUDGET') {
    return normalizeBoundedIntegerConfigValue(key, value, 0, 12000);
  }

  if (
    key === 'MEMORY_PROMPT_RECENT_RATIO' ||
    key === 'MEMORY_PROMPT_SUMMARY_RATIO' ||
    key === 'MEMORY_PROMPT_RECALL_RATIO'
  ) {
    return normalizeBoundedIntegerConfigValue(key, value, 0, 100);
  }

  if (key === 'MEMORY_COMPACTION_TRIGGER_ENTRIES') {
    return normalizeBoundedIntegerConfigValue(key, value, 10, 500);
  }

  if (key === 'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES') {
    return normalizeBoundedIntegerConfigValue(key, value, 1, 100);
  }

  const chatContextBounds = CHAT_CONTEXT_INTEGER_KEYS.get(key);
  if (chatContextBounds) {
    return normalizeBoundedIntegerConfigValue(
      key,
      value,
      chatContextBounds.min,
      chatContextBounds.max,
    );
  }

  return rawValue;
}

export function normalizeBashApprovalAllowlistConfigEntry(
  value: unknown,
): string {
  if (value === null || value === undefined || value === '') return '[]';
  return JSON.stringify(normalizeBashApprovalAllowlist(value));
}

export function registerAdminSettingsRoutes(
  app: Express,
  opts: AdminSettingsRouteOptions,
): void {
  const guard = opts.requirePermission('system.settings', 'system.settings.view');
  const editGuard = opts.requirePermission('system.settings', 'system.settings.edit');
  const channelManageGuard = opts.requirePermission('channel.manage', 'channel.system.manage');

  app.put('/api/sender-trust', editGuard, (req, res) => {
    try {
      opts.auditMutation(req, 'sender-trust.update', 'high');
      const body = req.body as {
        config?: unknown;
      };
      assertSenderAllowlistConfigShape(body?.config);
      const config = saveSenderAllowlist((body?.config || {}) as any);
      res.json({ ok: true, config });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Invalid sender trust config',
      });
    }
  });

  app.put('/api/channel-config', channelManageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'channel-config.update', 'high');
      const entries = req.body as { instances?: unknown };
      if (!Array.isArray(entries.instances)) {
        res.status(400).json({ error: 'instances must be an array' });
        return;
      }

      const before = JSON.stringify(await getSanitizedChannelInstances());
      await saveConfiguredChannelInstances(entries.instances as any[]);
      const after = JSON.stringify(await getSanitizedChannelInstances());
      const changed = before !== after;

      let reload: { disconnected: string[]; connected: string[]; errors: string[] } | undefined;
      if (changed) {
        reload = await opts.reloadChannels();
      }

      res.json({
        ok: true,
        changed,
        reload,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid channel config',
      });
    }
  });

  app.put('/api/config', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'config.update', 'high');
      const entries = req.body as Record<string, unknown>;
      const appliedEntries: Record<string, string | null | undefined> = {};
      let refreshAuthCookie = false;
      const changedKeys: string[] = [];

      for (const [key, value] of Object.entries(entries)) {
        if (!opts.allowedConfigKeys.has(key)) {
          res.status(400).json({ error: `Unsupported config key: ${key}` });
          return;
        }

        if (
          opts.sensitiveConfigKeys.has(key) &&
          (value === null || value === undefined || value === '')
        ) {
          continue;
        }

        let nextValue =
          value === null || value === undefined ? '' : String(value);
        if (key === 'DEFAULT_ACCESS_MODE' && nextValue) {
          nextValue = normalizeAccessMode(nextValue);
        }
        if (key === 'allowed_directories' && nextValue) {
          nextValue = JSON.stringify(parseAllowedDirectoriesValue(nextValue));
        }
        if (key === 'BASH_APPROVAL_ALLOWLIST') {
          try {
            nextValue = normalizeBashApprovalAllowlistConfigEntry(nextValue);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error
                  ? err.message
                  : `Invalid config value for ${key}`,
            });
            return;
          }
        }
        if (key.startsWith('WEB_BROWSER_')) {
          try {
            nextValue = normalizeBrowserConfigEntry(key, nextValue);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error
                  ? err.message
                  : `Invalid config value for ${key}`,
            });
            return;
          }
        }

        if (key.startsWith('WEB_SEARCH_') || key.startsWith('WEB_FETCH_')) {
          try {
            nextValue = normalizeWebSearchConfigEntry(key, nextValue);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error
                  ? err.message
                  : `Invalid config value for ${key}`,
            });
            return;
          }
        }
        if (key.startsWith('MEMORY_')) {
          try {
            nextValue = normalizeMemoryConfigEntry(key, nextValue);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error
                  ? err.message
                  : `Invalid config value for ${key}`,
            });
            return;
          }
        }
        if (key === 'KB_LLM_CONCURRENCY') {
          try {
            nextValue = normalizeBoundedIntegerConfigValue(key, nextValue, 1, 16);
          } catch (err) {
            res.status(400).json({
              error:
                err instanceof Error
                  ? err.message
                  : `Invalid config value for ${key}`,
            });
            return;
          }
        }
        if (nextValue !== (await getConfigValue(key))) {
          changedKeys.push(key);
        }

        if (key === 'WEB_LOGIN_USERNAME' || key === 'WEB_LOGIN_PASSWORD') {
          refreshAuthCookie = true;
        }

        appliedEntries[key] = nextValue;
        if (nextValue === '') {
          await deleteConfig(key);
        } else {
          await setConfig(key, nextValue);
        }
      }

      opts.applyProcessConfigSideEffects(appliedEntries);

      const embeddingKeys = ['EMBEDDING_PROVIDER', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_BASE_URL', 'EMBEDDING_DIMENSIONS'];
      if (changedKeys.some((k) => embeddingKeys.includes(k))) {
        const { resetEmbeddingProviderCache } = await import('../embedding/resolve.js');
        resetEmbeddingProviderCache();
      }

      if (refreshAuthCookie && opts.isAuthenticatedRequest(req)) {
        opts.clearBootstrapCredentials();
        opts.authSessions.revokeAll();
        const isSecure = process.env.NODE_ENV === 'production';
        const session = opts.authSessions.create(
          opts.getLoginCredentials().username,
        );
        res.setHeader(
          'Set-Cookie',
          opts.serializeAuthCookie(session.token, isSecure),
        );
      } else if (refreshAuthCookie) {
        opts.clearBootstrapCredentials();
        opts.authSessions.revokeAll();
      }

      res.json({
        ok: true,
        changedKeys,
        effects: opts.summarizeConfigEffects(changedKeys),
      });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/provider', guard, async (_req, res) => {
    try {
      res.json({
        provider: (await getConfigValue('AI_PROVIDER')) || 'claude',
        codex_model: '',
        codex_base_url: '',
      });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/provider', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'provider.switch', 'high');
      const { provider } = req.body as { provider: string };
      if (provider !== 'codex' && provider !== 'claude') {
        res
          .status(400)
          .json({ error: 'Invalid provider: must be "codex" or "claude"' });
        return;
      }
      await setConfig('AI_PROVIDER', provider);
      res.json({ ok: true, provider });
      logger.info(
        { provider },
        'AI Provider switched (effective on next agent spawn)',
      );
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/ai-providers', guard, async (_req, res) => {
    try {
      res.json(await buildMaskedProviders());
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/ai-providers/types', guard, (_req, res) => {
    const rawCapability = typeof _req.query.capability === 'string' ? _req.query.capability.trim() : '';
    const capability = rawCapability === 'embedding' ? 'embedding' : 'llm';
    res.json(
      getAllProviderTypeDefs(capability).map((def) => ({
        type: def.type,
        label: def.label,
        capability: def.capability,
        apiStyle: def.apiStyle,
        defaultBaseUrl: def.defaultBaseUrl,
        defaultModel: def.defaultModel,
        requiresBaseUrl: def.requiresBaseUrl,
      })),
    );
  });

  app.post('/api/ai-providers', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'providers.create', 'high');
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
        visibility: visibilityRaw,
        role_ids,
        user_ids,
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
        visibility?: string;
        role_ids?: string[];
        user_ids?: string[];
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
      const visibility =
        visibilityRaw !== undefined && visibilityRaw !== null
          ? String(visibilityRaw)
          : 'public';
      if (is_default && visibility !== 'public') {
        res.status(400).json({
          error: t('errors.auto_73fd5b', {}, req.locale),
        });
        return;
      }
      if (capability === 'embedding' && is_default) {
        res.status(400).json({ error: 'Embedding provider cannot be the global default chat provider' });
        return;
      }
      const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const operatorId = getTenantUserId(req);
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
        api_key: api_key ? encryptValue(api_key) : null,
        base_url: base_url || null,
        model: model || null,
        dimensions: numericDimensions,
        extra_config: buildProviderExtraConfigValue({
          extra_config,
          user_agent,
          custom_headers,
        }),
        is_default: is_default ? 1 : 0,
        user_id: SYSTEM_USER_ID,
        visibility,
        created_by: operatorId,
        updated_by: operatorId,
      });

      if (Array.isArray(role_ids) && visibility === 'restricted') {
        await syncProviderRoleAccess(id, role_ids, operatorId);
      }
      if (Array.isArray(user_ids) && visibility === 'restricted') {
        await syncProviderUserAccess(id, user_ids, operatorId);
      }

      logger.info({ id, alias, type, createdBy: operatorId }, 'AI provider created');
      await auditAdminAction(req, AUDIT_ACTIONS.PROVIDER_CREATE, { targetType: 'ai_providers', targetId: id, targetName: alias });
      res.json({ ok: true, id });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/ai-providers/:id', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'providers.update', 'high');
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (provider.user_id !== SYSTEM_USER_ID) {
        res.status(403).json({ error: t('errors.auto_7e2fdc', {}, req.locale) });
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
        visibility: visibilityRaw,
        role_ids,
        user_ids,
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
        visibility?: string;
        role_ids?: string[];
        user_ids?: string[];
      };
      const operatorId = getTenantUserId(req);
      const updates: Record<string, unknown> = { updated_by: operatorId };
      if (alias !== undefined) updates.alias = alias;
      const nextCapability = capabilityRaw !== undefined
        ? normalizeProviderCapability(capabilityRaw)
        : (provider.capability || 'llm');
      if (type !== undefined && !isValidProviderType(type, nextCapability)) {
        res.status(400).json({ error: `Invalid provider type: ${type}` });
        return;
      }
      if (type !== undefined) updates.type = type;
      if (capabilityRaw !== undefined) updates.capability = nextCapability;
      if (typeof api_key === 'string' && !/\*{4,}/.test(api_key)) {
        updates.api_key = api_key ? encryptValue(api_key) : null;
      }
      if (base_url !== undefined) updates.base_url = base_url;
      if (model !== undefined) updates.model = model;
      if (dimensions !== undefined) {
        const numericDimensions =
          dimensions === null || String(dimensions).trim() === ''
            ? null
            : Number(dimensions);
        if (numericDimensions !== null && (!Number.isInteger(numericDimensions) || numericDimensions <= 0)) {
          res.status(400).json({ error: 'dimensions must be a positive integer' });
          return;
        }
        updates.dimensions = numericDimensions;
      }
      if (
        extra_config !== undefined ||
        user_agent !== undefined ||
        custom_headers !== undefined
      ) {
        updates.extra_config = buildProviderExtraConfigValue(
          {
            extra_config,
            user_agent,
            custom_headers,
          },
          provider.extra_config,
        );
      }
      if (is_default !== undefined) updates.is_default = is_default ? 1 : 0;
      if (visibilityRaw !== undefined) {
        updates.visibility = String(visibilityRaw);
      }

      const nextIsDefault =
        is_default !== undefined ? (is_default ? 1 : 0) : provider.is_default;
      const nextVisibility =
        visibilityRaw !== undefined
          ? String(visibilityRaw)
          : provider.visibility;
      const usage = await getKnowledgeBaseProviderUsage(id);
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
          api_key: updates.api_key as string | undefined,
          base_url: base_url !== undefined ? (base_url || null) : undefined,
          model: model !== undefined ? (model || null) : undefined,
          dimensions: dimensions !== undefined ? (updates.dimensions as number | null) : undefined,
        });
      if (nextCapability === 'embedding' && nextIsDefault === 1) {
        res.status(400).json({ error: 'Embedding provider cannot be the global default chat provider' });
        return;
      }
      if (nextIsDefault === 1 && nextVisibility !== 'public') {
        res.status(400).json({
          error: t('errors.auto_73fd5b', {}, req.locale),
        });
        return;
      }

      await updateProvider(id, updates);

      if (nextVisibility === 'restricted' && Array.isArray(role_ids)) {
        await syncProviderRoleAccess(id, role_ids, operatorId);
      } else if (nextVisibility !== 'restricted' && provider.visibility === 'restricted') {
        await syncProviderRoleAccess(id, [], operatorId);
      }
      if (nextVisibility === 'restricted' && Array.isArray(user_ids)) {
        await syncProviderUserAccess(id, user_ids, operatorId);
      } else if (nextVisibility !== 'restricted' && provider.visibility === 'restricted') {
        await syncProviderUserAccess(id, [], operatorId);
      }

      await auditAdminAction(req, AUDIT_ACTIONS.PROVIDER_UPDATE, { targetType: 'ai_providers', targetId: id, targetName: provider.alias });
      res.json({
        ok: true,
        requiresKnowledgeReembed,
        knowledgeBaseRefs: usage.embeddingRefs,
      });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/ai-providers/:id', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'providers.delete', 'high');
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (provider.user_id !== SYSTEM_USER_ID) {
        res.status(403).json({ error: t('errors.auto_c33022', {}, req.locale) });
        return;
      }
      const usage = await getKnowledgeBaseProviderUsage(id);
      if (usage.embeddingRefs > 0 || usage.llmRefs > 0) {
        res.status(409).json({ error: t('errors.auto_b2e6cc', {}, req.locale) });
        return;
      }
      await deleteProvider(id, getTenantUserId(req));
      await auditAdminAction(req, AUDIT_ACTIONS.PROVIDER_DELETE, { targetType: 'ai_providers', targetId: id, targetName: provider.alias });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/ai-providers/:id/test', guard, async (req, res) => {
    try {
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const testResult = await testAiProviderConnection(provider);

      res.json(testResult);
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  app.get('/api/ai-providers/:id/knowledge-usage', guard, async (req, res) => {
    try {
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(await getKnowledgeBaseProviderUsage(id));
    } catch (err) {
      logger.error({ err }, 'Failed to get provider knowledge usage');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── Role-based access endpoints (replaces user-based access) ──

  app.get('/api/ai-providers/:id/roles', guard, async (req, res) => {
    try {
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const list = await getProviderRoleAccessList(id);
      res.json(list);
    } catch (err) {
      logger.error({ err }, 'Failed to get provider role access list');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/ai-providers/:id/roles', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'provider.role.grant', 'normal');
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const { role_id } = req.body as { role_id?: string };
      if (!role_id) {
        res.status(400).json({ error: 'role_id is required' });
        return;
      }
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      if (provider.user_id !== SYSTEM_USER_ID || provider.visibility !== 'restricted') {
        res.status(400).json({ error: t('errors.auto_04d03b', {}, req.locale) });
        return;
      }
      const operatorId = getTenantUserId(req);
      await grantProviderRoleAccess(id, role_id, operatorId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to grant provider role access');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete(
    '/api/ai-providers/:id/roles/:roleId',
    editGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'provider.role.revoke', 'normal');
        const rawId = req.params.id;
        const id =
          typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
        const rawRoleId = req.params.roleId;
        const roleId =
          typeof rawRoleId === 'string' ? rawRoleId : Array.isArray(rawRoleId) ? rawRoleId[0] ?? '' : '';
        const operatorId = getTenantUserId(req);
        await revokeProviderRoleAccess(id, roleId, operatorId);
        res.json({ ok: true });
      } catch (err) {
        logger.error({ err }, 'Failed to revoke provider role access');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.get('/api/ai-providers/:id/users', guard, async (req, res) => {
    try {
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const list = await getProviderUserAccessList(id);
      res.json(list);
    } catch (err) {
      logger.error({ err }, 'Failed to get provider user access list');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/ai-providers/:id/users', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'provider.user.grant', 'normal');
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const { user_id } = req.body as { user_id?: string };
      if (!user_id) {
        res.status(400).json({ error: 'user_id is required' });
        return;
      }
      const provider = await getProvider(id);
      if (!provider) {
        res.status(404).json({ error: 'Provider not found' });
        return;
      }
      if (provider.user_id !== SYSTEM_USER_ID || provider.visibility !== 'restricted') {
        res.status(400).json({ error: t('errors.auto_56695c', {}, req.locale) });
        return;
      }
      const operatorId = getTenantUserId(req);
      await grantProviderUserAccess(id, user_id, operatorId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to grant provider user access');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/ai-providers/:id/users/:userId', editGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'provider.user.revoke', 'normal');
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? rawId[0] ?? '' : '';
      const rawUserId = req.params.userId;
      const userId =
        typeof rawUserId === 'string' ? rawUserId : Array.isArray(rawUserId) ? rawUserId[0] ?? '' : '';
      await revokeProviderUserAccess(id, userId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to revoke provider user access');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
