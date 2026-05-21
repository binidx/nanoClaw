import type { Express, Request, Response } from 'express';

import { auditAdminAction, AUDIT_ACTIONS } from '../auth/audit-middleware.js';
import { parsePaginationQuery, paginateArray } from '../pagination.js';
import {
  createAssistantMcpBinding,
  createAssistant,
  deleteAssistant,
  deleteAssistantMcpBinding,
  deleteAssistantMcpBindingSecret,
  getAssistant,
  getAssistantMcpBinding,
  getAssistantMcpBindingSecret,
  getConversationListByAssistantId,
  getVisibleProvidersForUser,
  getUserMcpServer,
  getUserSkill,
  isProviderVisibleToUser,
  listAssistantMcpBindingSecrets,
  listAssistantMcpBindings,
  listAssistants,
  listKnowledgeBases,
  listUserMcpServers,
  listUserSkills,
  updateAssistantMcpBinding,
  updateAssistant,
  upsertAssistantMcpBindingSecret,
} from '../db.js';
import { listAssistantRepoBindings } from '../assistant-repo.js';
import { createRepositoryBinding } from '../resource-binding-service.js';
import { getRepository as getRepositoryInfo } from '../repo-review/repository-service.js';
import {
  type AssistantConfig,
  normalizeAssistantConfig,
  normalizeAssistantId,
} from '../assistant/assistant-config.js';
import {
  buildAssistantMcpBindingViews,
  createAssistantMcpBindingId,
  parseAssistantMcpSecretEnv,
  type ManagedMcpTemplate,
} from '../assistant/assistant-mcp.js';
import { logger } from '../logger.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { listRepositories } from '../db/repositories.js';
import { dba } from '../db/engine-access.js';
import { t } from '../i18n/index.js';
import {
  buildProjectGraphResourceContext,
  getProjectGraphOverview,
} from '../project-graph/project-graph-service.js';

function containsLocalizedFragment(
  message: string,
  fragments: Array<RegExp>,
): boolean {
  return fragments.some((pattern) => pattern.test(message));
}

function decodeRouteParam(raw: string | string[] | undefined): string {
  const s = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
  return decodeURIComponent(s).trim();
}

/** Owner may mutate; system-defined assistants are mutable only in the system tenant. */
function canManageAssistant(
  assistant: { user_id: string },
  requestUserId: string,
): boolean {
  if (assistant.user_id === requestUserId) return true;
  return (
    assistant.user_id === SYSTEM_USER_ID && requestUserId === SYSTEM_USER_ID
  );
}

function canViewAssistant(
  assistant: { user_id: string; visibility: string },
  userId: string,
): boolean {
  if (userId === SYSTEM_USER_ID) return true;
  if (assistant.user_id === userId) return true;
  return assistant.visibility === 'shared';
}

async function requireAssistantAccess(
  req: Request,
  res: Response,
  assistantId: string,
  mode: 'view' | 'manage',
): Promise<Awaited<ReturnType<typeof getAssistant>> | null> {
  const assistant = await getAssistant(assistantId);
  if (!assistant) {
    res.status(404).json({ error: 'Assistant not found' });
    return null;
  }
  const userId = getTenantUserId(req);
  const allowed =
    mode === 'view'
      ? canViewAssistant(assistant, userId)
      : canManageAssistant(assistant, userId);
  if (!allowed) {
    res.status(mode === 'view' ? 404 : 403).json({ error: 'Forbidden' });
    return null;
  }
  return assistant;
}

interface ManagedSkillCatalogEntry {
  id: string;
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
}

export interface AssistantRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  listAvailableManagedSkills: () =>
    | ManagedSkillCatalogEntry[]
    | Promise<ManagedSkillCatalogEntry[]>;
  listAvailableManagedMcpServers: () =>
    | ManagedMcpTemplate[]
    | Promise<ManagedMcpTemplate[]>;
  onAssistantMutated?: (assistantId: string) => void;
}

async function validateAssistantConfig(
  config: AssistantConfig,
  opts: Pick<AssistantRouteOptions, 'listAvailableManagedSkills' | 'listAvailableManagedMcpServers'>,
  userId: string,
): Promise<void> {
  const availableSkillIds = new Set(
    (await Promise.resolve(opts.listAvailableManagedSkills())).map(
      (skill) => skill.id,
    ),
  );
  for (const skillId of config.skillIds) {
    if (!availableSkillIds.has(skillId)) {
      throw new Error(`Unknown skill id: ${skillId}`);
    }
  }

  const availableMcpServerIds = new Set(
    (await Promise.resolve(opts.listAvailableManagedMcpServers())).map(
      (server) => server.id,
    ),
  );
  for (const serverId of config.mcpServerIds) {
    if (!availableMcpServerIds.has(serverId)) {
      throw new Error(`Unknown MCP server id: ${serverId}`);
    }
  }

  for (const skillId of config.userSkillIds) {
    const skill = await getUserSkill(skillId);
    if (!skill || skill.user_id !== userId) {
      throw new Error(`Unknown user skill id: ${skillId}`);
    }
  }

  for (const serverId of config.userMcpServerIds) {
    const server = await getUserMcpServer(serverId);
    if (!server || server.user_id !== userId) {
      throw new Error(`Unknown user MCP server id: ${serverId}`);
    }
  }

  if (config.providerId && !await isProviderVisibleToUser(config.providerId, userId, 'llm')) {
    throw new Error(`Unknown provider id: ${config.providerId}`);
  }

  for (const kbId of config.kbIds) {
    const kb = (await listKnowledgeBases()).find((entry) => entry.id === kbId);
    if (
      !kb ||
      !(
        kb.user_id === userId ||
        (userId === SYSTEM_USER_ID && kb.user_id === SYSTEM_USER_ID) ||
        kb.visibility === 'shared'
      )
    ) {
      throw new Error(`Unknown knowledge base id: ${kbId}`);
    }
  }

  if (
    config.rules.mode !== 'append' &&
    !config.rules.systemPrompt &&
    !config.rules.extraInstructions
  ) {
    throw new Error(
      'rule mode "replace" or "locked" requires systemPrompt or extraInstructions',
    );
  }
}

function normalizeBindingArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('args must be an array of strings');
  }
  const args = value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  return args;
}

function normalizeSecretEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('env must be an object');
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') {
      throw new Error(`env.${key} must be a string`);
    }
    output[key] = rawValue;
  }
  return output;
}

interface InitialAssistantRepositoryBindingInput {
  repositoryId: string;
  branch?: string;
}

function normalizeInitialRepositoryBindings(
  value: unknown,
): InitialAssistantRepositoryBindingInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('initialRepositoryBindings must be an array');
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`initialRepositoryBindings[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const repositoryId = String(record.repositoryId || '').trim();
    if (!repositoryId) {
      throw new Error(
        `initialRepositoryBindings[${index}].repositoryId is required`,
      );
    }
    if (seen.has(repositoryId)) {
      throw new Error(
        `Duplicate repositoryId in initialRepositoryBindings: ${repositoryId}`,
      );
    }
    seen.add(repositoryId);
    const branch = String(record.branch || '').trim();
    return {
      repositoryId,
      ...(branch ? { branch } : {}),
    };
  });
}

async function buildAssistantResourcePayload(
  assistantId: string,
  opts: Pick<AssistantRouteOptions, 'listAvailableManagedSkills' | 'listAvailableManagedMcpServers'>,
) {
  const assistant = await getAssistant(assistantId);
  if (!assistant) return null;
  const templates = await Promise.resolve(opts.listAvailableManagedMcpServers());
  const secretRecords = await listAssistantMcpBindingSecrets(assistant.id);
  const mcpBindings = buildAssistantMcpBindingViews({
    assistantId: assistant.id,
    legacyTemplateIds: assistant.config.mcpServerIds,
    templates,
    bindings: await listAssistantMcpBindings(assistant.id),
    secretRecordsByBindingId: new Map(
      secretRecords.map((record) => [record.binding_id, record]),
    ),
  });
  const repoBindings = await listAssistantRepoBindings(assistant.id);
  const repoBindingViews = await Promise.all(
    repoBindings.map(async (binding) => {
      const repository = await getRepositoryInfo(binding.repository_id);
      let projectGraph: ReturnType<typeof buildProjectGraphResourceContext> | null =
        null;
      if (repository) {
        projectGraph = buildProjectGraphResourceContext(
          await getProjectGraphOverview(repository),
        );
      }
      return {
        id: binding.id,
        repositoryId: binding.repository_id,
        repositoryName: binding.name,
        repositoryUrl: binding.repo_url,
        description: binding.description,
        defaultBranch: binding.default_branch,
        branchFilter: binding.branch_filter,
        activeBranch: binding.active_branch,
        localPath: binding.local_path,
        worktreePath: binding.worktree_path,
        enabled: binding.enabled === 1,
        projectGraph,
      };
    }),
  );
  return {
    assistantId: assistant.id,
    availableSkills: (await Promise.resolve(opts.listAvailableManagedSkills())).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || '',
      source: skill.source || 'unknown',
      enabled: skill.enabled !== false,
    })),
    selectedSkillIds: [...assistant.config.skillIds],
    availableMcpTemplates: templates.map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      args: [...server.args],
      enabled: server.enabled,
      envKeyCount: Object.keys(server.env || {}).length,
    })),
    mcpBindings,
    repoBindings: repoBindingViews,
    projectGraphResourceHints: {
      skillIds: Array.from(
        new Set(repoBindingViews.flatMap((binding) => binding.projectGraph?.skillIds || [])),
      ),
      mcpServerIds: Array.from(
        new Set(
          repoBindingViews.flatMap(
            (binding) => binding.projectGraph?.mcpServerIds || [],
          ),
        ),
      ),
      repositoryIds: repoBindingViews
        .filter((binding) => binding.projectGraph?.enabled)
        .map((binding) => binding.repositoryId),
    },
  };
}

async function materializeLegacyAssistantBindings(
  assistantId: string,
): Promise<void> {
  const assistant = await getAssistant(assistantId);
  if (!assistant) return;
  const existingBindings = await listAssistantMcpBindings(assistantId);
  if (existingBindings.length > 0) return;
  for (const templateServerId of assistant.config.mcpServerIds) {
    const bindingId = createAssistantMcpBindingId(assistantId, templateServerId);
    if (await getAssistantMcpBinding(assistantId, bindingId)) continue;
    await createAssistantMcpBinding({
      assistantId,
      templateServerId,
      enabled: true,
    });
  }
}

export function registerAssistantRoutes(
  app: Express,
  opts: AssistantRouteOptions,
): void {
  const viewGuard = opts.requirePermission('assistant.manage', 'assistant.view');
  const manageGuard = opts.requirePermission('assistant.manage', 'assistant.edit');
  app.get('/api/assistants/available-resources', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const [allKbs, providers, skills, mcpTemplates, repos] = await Promise.all([
        listKnowledgeBases(),
        getVisibleProvidersForUser(userId, 'llm'),
        Promise.resolve(opts.listAvailableManagedSkills()),
        Promise.resolve(opts.listAvailableManagedMcpServers()),
        listRepositories(userId),
      ]);
      const [userSkills, userMcpServers] = await Promise.all([
        listUserSkills({ userId, enabled: true }),
        listUserMcpServers({ userId, enabled: true }),
      ]);
      const kbs = allKbs.filter(
        (kb) =>
          (kb as { user_id?: string }).user_id === userId ||
          (userId === SYSTEM_USER_ID && (kb as { user_id?: string }).user_id === SYSTEM_USER_ID) ||
          (kb as { visibility?: string }).visibility === 'shared',
      );
      res.json({
        knowledgeBases: kbs.map((kb) => ({
          id: kb.id,
          name: kb.name,
          description: kb.description || null,
        })),
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description || '',
          source: skill.source || 'unknown',
          enabled: skill.enabled !== false,
        })),
        userSkills: userSkills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description || '',
          source: skill.source_type || 'user',
          enabled: skill.enabled !== 0,
          sourceType: skill.source_type,
          sourceRef: skill.source_ref || null,
          isOwner: true,
        })),
        mcpTemplates: mcpTemplates.map((server) => ({
          id: server.id,
          name: server.name,
          command: server.command,
          args: [...server.args],
          enabled: server.enabled !== false,
          envKeyCount: Object.keys(server.env || {}).length,
        })),
        userMcpServers: userMcpServers.map((server) => ({
          id: server.id,
          name: server.name,
          command: server.command,
          args: JSON.parse(server.args_json || '[]') as string[],
          enabled: server.enabled !== 0,
          envKeyCount: Object.keys(JSON.parse(server.env_json || '{}') as Record<string, string>).length,
          sourceType: server.source_type,
          sourceRef: server.source_ref || null,
          isOwner: true,
        })),
        repositories: repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          description: repo.ai_description || null,
          defaultBranch: repo.default_target_branch || null,
          visibility: repo.visibility || 'private',
          enabled: repo.enabled === 1,
        })),
        providers: providers.map((p) => ({
          id: p.id,
          alias: p.alias,
          type: p.type,
          model: p.model,
          visibility: p.visibility || 'private',
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list available resources for assistant');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/assistants', viewGuard, async (req, res) => {
    try {
      const all = await listAssistants({ userId: getTenantUserId(req) });
      if (typeof req.query.page === 'string') {
        const pq = parsePaginationQuery(req);
        const filtered = pq.search
          ? all.filter(a => a.name.toLowerCase().includes(pq.search!.toLowerCase()))
          : all;
        res.json(paginateArray(filtered, pq));
      } else {
        res.json({ assistants: all });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to list assistants');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/assistants/:id', viewGuard, async (req, res) => {
    try {
      const id = decodeRouteParam(req.params.id);
      const assistant = id ? await getAssistant(id) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canViewAssistant(assistant, userId)) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      res.json({ assistant });
    } catch (err) {
      logger.error({ err }, 'Failed to get assistant');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/assistants/:id/resources', viewGuard, async (req, res) => {
    try {
      const id = decodeRouteParam(req.params.id);
      const userId = getTenantUserId(req);
      const existing = id ? await getAssistant(id) : undefined;
      if (!existing || !canViewAssistant(existing, userId)) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      const payload = await buildAssistantResourcePayload(id!, opts);
      if (!payload) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      res.json(payload);
    } catch (err) {
      logger.error({ err }, 'Failed to load assistant resources');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/assistants/:id/export', manageGuard, async (req, res) => {
    try {
      const id = decodeRouteParam(req.params.id);
      const assistant = id ? await getAssistant(id) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const mcpBindings = await listAssistantMcpBindings(id!);
      const repoBindings = await listAssistantRepoBindings(id!);
      const exportData = {
        version: 1,
        assistant: {
          name: assistant.name,
          description: assistant.description,
          enabled: assistant.enabled,
          visibility: assistant.visibility,
          config: assistant.config,
        },
        mcpBindings: mcpBindings.map((b) => ({
          template_server_id: b.template_server_id,
          alias: b.alias,
          enabled: b.enabled,
        })),
        repoBindings: repoBindings.map((b) => ({
          repo_url: b.repo_url,
          name: b.name,
          description: b.description,
          default_branch: b.default_branch,
          branch_filter: b.branch_filter,
          enabled: b.enabled,
        })),
      };
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(assistant.name)}.json"`);
      res.json(exportData);
    } catch (err) {
      logger.error({ err }, 'Failed to export assistant');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/assistants', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.create', 'high');
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const name = String(body.name || '').trim();
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const config = normalizeAssistantConfig(body.config || {});
      const requestUserId = getTenantUserId(req);
      await validateAssistantConfig(config, opts, requestUserId);
      const initialRepositoryBindings = normalizeInitialRepositoryBindings(
        body.initialRepositoryBindings,
      );
      const visibility =
        body.visibility === 'shared' ? 'shared'
          : body.visibility === 'private' ? 'private'
          : undefined;
      const assistant = await dba.transaction(async () => {
        const createdAssistant = await createAssistant({
          id: normalizeAssistantId(body.id, name),
          name,
          description:
            typeof body.description === 'string' ? body.description : null,
          enabled: body.enabled !== false,
          config,
          userId: requestUserId,
          visibility,
        });
        for (const binding of initialRepositoryBindings) {
          await createRepositoryBinding(
            'assistant',
            createdAssistant.id,
            binding.repositoryId,
            {
              branch: binding.branch,
            },
            requestUserId,
          );
        }
        return createdAssistant;
      })();
      await auditAdminAction(req, AUDIT_ACTIONS.ASSISTANT_CREATE, { targetType: 'assistants', targetId: assistant.id, targetName: name });
      res.json({ assistant });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to create assistant',
      });
    }
  });

  app.get('/api/assistants/:id/mcp-bindings', viewGuard, async (req, res) => {
    try {
      const id = decodeRouteParam(req.params.id);
      const userId = getTenantUserId(req);
      const existing = id ? await getAssistant(id) : undefined;
      if (!existing || !canViewAssistant(existing, userId)) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      const payload = await buildAssistantResourcePayload(id!, opts);
      if (!payload) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      res.json({ bindings: payload.mcpBindings });
    } catch (err) {
      logger.error({ err }, 'Failed to list assistant MCP bindings');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/assistants/:id/mcp-bindings', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.mcp_bindings.create', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const assistant = await requireAssistantAccess(req, res, assistantId, 'manage');
      if (!assistant) return;
      materializeLegacyAssistantBindings(assistantId);
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const templateServerId = String(
        body.templateServerId || body.template_server_id || '',
      ).trim();
      if (!templateServerId) {
        res.status(400).json({ error: 'templateServerId is required' });
        return;
      }
      const template = (await Promise.resolve(
        opts.listAvailableManagedMcpServers(),
      )).find((entry) => entry.id === templateServerId);
      if (!template) {
        res.status(400).json({ error: `Unknown MCP server id: ${templateServerId}` });
        return;
      }
      if (
        await getAssistantMcpBinding(
          assistantId,
          createAssistantMcpBindingId(assistantId, templateServerId),
        )
      ) {
        res.status(400).json({
          error: t(
            'errors.assistantMcpAlreadyBound',
            { templateServerId },
            req.locale,
          ),
        });
        return;
      }
      const binding = await createAssistantMcpBinding({
        assistantId,
        templateServerId,
        alias: typeof body.alias === 'string' ? body.alias : null,
        enabled: body.enabled !== false,
        args: normalizeBindingArgs(body.args),
      });
      opts.onAssistantMutated?.(assistantId);
      res.json({ binding });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to create assistant MCP binding',
      });
    }
  });

  app.patch('/api/assistants/:id/mcp-bindings/:bindingId', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.mcp_bindings.update', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      if (!await requireAssistantAccess(req, res, assistantId, 'manage')) return;
      materializeLegacyAssistantBindings(assistantId);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const binding = await updateAssistantMcpBinding(assistantId, bindingId, {
        alias:
          body.alias === undefined
            ? undefined
            : typeof body.alias === 'string'
              ? body.alias
              : null,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
        args: normalizeBindingArgs(body.args),
      });
      if (!binding) {
        res.status(404).json({ error: 'Assistant MCP binding not found' });
        return;
      }
      opts.onAssistantMutated?.(assistantId);
      res.json({ binding });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to update assistant MCP binding',
      });
    }
  });

  app.delete('/api/assistants/:id/mcp-bindings/:bindingId', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.mcp_bindings.delete', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      if (!await requireAssistantAccess(req, res, assistantId, 'manage')) return;
      materializeLegacyAssistantBindings(assistantId);
      const bindingId = decodeRouteParam(req.params.bindingId);
      if (!await deleteAssistantMcpBinding(assistantId, bindingId)) {
        res.status(404).json({ error: 'Assistant MCP binding not found' });
        return;
      }
      opts.onAssistantMutated?.(assistantId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to delete assistant MCP binding',
      });
    }
  });

  app.get('/api/assistants/:id/mcp-bindings/:bindingId/secrets', viewGuard, async (req, res) => {
    try {
      const assistantId = decodeRouteParam(req.params.id);
      const assistant = await requireAssistantAccess(req, res, assistantId, 'view');
      if (!assistant) return;
      const isManager = canManageAssistant(assistant, getTenantUserId(req));
      const bindingId = decodeRouteParam(req.params.bindingId);
      const secretRecord = await getAssistantMcpBindingSecret(assistantId, bindingId);
      const env = parseAssistantMcpSecretEnv(secretRecord);
      res.json({
        bindingId,
        configuredKeys: isManager ? Object.keys(env) : [],
        secretStatus: {
          configured: Object.keys(env).length > 0,
          updatedAt: secretRecord?.updated_at || null,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get assistant MCP secret status');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/assistants/:id/mcp-bindings/:bindingId/secrets', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.mcp_bindings.secrets.put', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      if (!await requireAssistantAccess(req, res, assistantId, 'manage')) return;
      materializeLegacyAssistantBindings(assistantId);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const secret = await upsertAssistantMcpBindingSecret(
        assistantId,
        bindingId,
        normalizeSecretEnv(body.env || {}),
      );
      opts.onAssistantMutated?.(assistantId);
      const env = parseAssistantMcpSecretEnv(secret);
      res.json({
        bindingId,
        configuredKeys: Object.keys(env),
        secretStatus: {
          configured: Object.keys(env).length > 0,
          keyCount: Object.keys(env).length,
          updatedAt: secret.updated_at,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to save assistant MCP secret';
      res.status(
        containsLocalizedFragment(message, [/不存在/u, /not found/i]) ? 404 : 400,
      ).json({ error: message });
    }
  });

  app.delete('/api/assistants/:id/mcp-bindings/:bindingId/secrets', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.mcp_bindings.secrets.delete', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      if (!await requireAssistantAccess(req, res, assistantId, 'manage')) return;
      materializeLegacyAssistantBindings(assistantId);
      const bindingId = decodeRouteParam(req.params.bindingId);
      if (!await deleteAssistantMcpBindingSecret(assistantId, bindingId)) {
        res.status(404).json({ error: 'Assistant MCP binding secret not found' });
        return;
      }
      opts.onAssistantMutated?.(assistantId);
      res.json({
        bindingId,
        configuredKeys: [],
        secretStatus: {
          configured: false,
          keyCount: 0,
          updatedAt: null,
        },
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to delete assistant MCP secret',
      });
    }
  });

  app.put('/api/assistants/:id/visibility', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.visibility', 'high');
      const id = decodeRouteParam(req.params.id);
      const existing = id ? await getAssistant(id) : undefined;
      if (!existing) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      const requestUserId = getTenantUserId(req);
      if (!canManageAssistant(existing, requestUserId)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const rawVis = String(body.visibility ?? '').trim().toLowerCase();
      const visibility =
        rawVis === 'shared' ? 'shared' : rawVis === 'private' ? 'private' : null;
      if (!visibility) {
        res.status(400).json({ error: 'visibility must be "private" or "shared"' });
        return;
      }
      const assistant = await updateAssistant(id, { visibility });
      if (!assistant) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      opts.onAssistantMutated?.(id);
      res.json({ assistant });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update visibility',
      });
    }
  });

  app.patch('/api/assistants/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.update', 'high');
      const id = decodeRouteParam(req.params.id);
      const existing = id ? await getAssistant(id) : undefined;
      if (!existing) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      const requestUserId = getTenantUserId(req);
      if (!canManageAssistant(existing, requestUserId)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const config =
        body.config !== undefined
          ? normalizeAssistantConfig(body.config)
          : existing.config;
      await validateAssistantConfig(config, opts, requestUserId);
      const nextVisibility =
        body.visibility === undefined
          ? undefined
          : String(body.visibility).trim().toLowerCase() === 'shared'
            ? 'shared'
            : String(body.visibility).trim().toLowerCase() === 'private'
              ? 'private'
              : undefined;
      if (body.visibility !== undefined && nextVisibility === undefined) {
        res.status(400).json({ error: 'visibility must be "private" or "shared"' });
        return;
      }
      const assistant = await updateAssistant(id, {
        name: typeof body.name === 'string' ? body.name : existing.name,
        description:
          body.description === undefined
            ? existing.description
            : typeof body.description === 'string'
              ? body.description
              : null,
        enabled:
          body.enabled === undefined ? existing.enabled : Boolean(body.enabled),
        config,
        ...(nextVisibility !== undefined ? { visibility: nextVisibility } : {}),
      });
      if (!assistant) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      opts.onAssistantMutated?.(id);
      res.json({ assistant });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update assistant',
      });
    }
  });

  app.delete('/api/assistants/:id', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.delete', 'high');
      const id = decodeRouteParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'assistant id is required' });
        return;
      }
      const existing = await getAssistant(id);
      if (!existing) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      if (!canManageAssistant(existing, getTenantUserId(req))) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      if (!await deleteAssistant(id)) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      opts.onAssistantMutated?.(id);
      await auditAdminAction(req, AUDIT_ACTIONS.ASSISTANT_DELETE, { targetType: 'assistants', targetId: id, targetName: existing.name });
      res.json({ ok: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete assistant';
      res.status(
        containsLocalizedFragment(message, [/引用/u, /referenc/i, /in use/i])
          ? 409
          : 400,
      ).json({ error: message });
    }
  });

  app.post('/api/assistants/:id/enable', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.enable', 'high');
      const id = decodeRouteParam(req.params.id);
      const assistant = await updateAssistant(id, { enabled: true });
      if (!assistant) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      opts.onAssistantMutated?.(id);
      res.json({ assistant });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to enable assistant',
      });
    }
  });

  app.post('/api/assistants/:id/disable', manageGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'assistants.disable', 'high');
      const id = decodeRouteParam(req.params.id);
      const assistant = await updateAssistant(id, { enabled: false });
      if (!assistant) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      opts.onAssistantMutated?.(id);
      res.json({ assistant });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to disable assistant',
      });
    }
  });

  app.get('/api/assistants/:id/conversations', async (req, res) => {
    try {
      const id = decodeRouteParam(req.params.id);
      if (!id) {
        res.status(400).json({ error: 'assistant id is required' });
        return;
      }
      res.json({
        conversations: await getConversationListByAssistantId(
          id,
          getTenantUserId(req),
        ),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list assistant conversations');
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
