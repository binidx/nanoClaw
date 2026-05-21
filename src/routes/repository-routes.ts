import type { Express, Request, Response } from 'express';

import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import type { RepositoryUpsertInput } from '../db/repositories.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  createOrUpdateRepository,
  getFeatures,
  getRepository,
  getRepositoryList,
  getRepositoryRelationships,
  patchRepository,
  removeRepository,
  setFeature,
} from '../repo-review/repository-service.js';
import {
  getProjectGraphOverview,
  normalizeProjectGraphConfig,
  runProjectGraphScan,
} from '../project-graph/project-graph-service.js';
import { t } from '../i18n/index.js';

export interface RepositoryRouteOptions {
  requirePermission: RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

function paramId(id: string | string[] | undefined): string {
  if (typeof id === 'string') return id;
  if (Array.isArray(id)) return id[0] ?? '';
  return '';
}

const CAMEL_TO_SNAKE: Record<string, keyof RepositoryUpsertInput> = {
  localRepoPath: 'local_repo_path',
  remoteProvider: 'remote_provider',
  remoteRepoSlug: 'remote_repo_slug',
  remoteBaseUrl: 'remote_base_url',
  cloneUrl: 'clone_url',
  defaultTargetBranch: 'default_target_branch',
  sshKeyId: 'ssh_key_id',
  autoSyncEnabled: 'auto_sync_enabled',
  autoSyncIntervalMinutes: 'auto_sync_interval_minutes',
  aiDescription: 'ai_description',
  techStack: 'tech_stack_json',
};

function normalizeUpdateInput(
  body: Record<string, unknown>,
): Partial<RepositoryUpsertInput> {
  const result: Partial<RepositoryUpsertInput> = {};
  const val = (key: string) => body[key] ?? body[CAMEL_TO_SNAKE[key] as string];
  const has = (key: string) => key in body || (CAMEL_TO_SNAKE[key] as string) in body;

  if (body.id !== undefined) result.id = String(body.id);
  if (body.name !== undefined) result.name = String(body.name);
  if (has('language')) result.language = (val('language') ?? null) as string | null;

  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    const v = body[camel] ?? body[snake];
    if (v === undefined && !(camel in body) && !(snake in body)) continue;
    switch (snake) {
      case 'auto_sync_enabled':
        result.auto_sync_enabled = Boolean(v);
        break;
      case 'auto_sync_interval_minutes':
        result.auto_sync_interval_minutes = Number(v);
        break;
      case 'tech_stack_json':
        result.tech_stack_json = v ? JSON.stringify(v) : null;
        break;
      default:
        (result as Record<string, unknown>)[snake] = (v ?? null) as string | null;
    }
  }

  if ('enabled' in body) result.enabled = Boolean(body.enabled);
  if ('status' in body) result.status = String(body.status);
  if ('visibility' in body) result.visibility = body.visibility === null ? undefined : String(body.visibility);
  return result;
}

export function registerRepositoryRoutes(
  app: Express,
  opts: RepositoryRouteOptions,
): void {
  const viewGuard = opts.requirePermission('repository.view');
  const createGuard = opts.requirePermission('repository.create');
  const updateGuard = opts.requirePermission('repository.update');
  const deleteGuard = opts.requirePermission('repository.delete');

  app.get('/api/repositories', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const list = await getRepositoryList(userId);
      res.json({ repositories: list });
    } catch {
      res.status(500).json({ error: t('server.internalError', {}, req.locale) });
    }
  });

  app.get(
    '/api/repositories/:id',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const repo = await getRepository(paramId(req.params.id), userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(repo);
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.get(
    '/api/repositories/:id/relationships',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const relationships = await getRepositoryRelationships(
          paramId(req.params.id),
          userId,
        );
        if (!relationships) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(relationships);
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.post(
    '/api/repositories',
    createGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.create', 'high');
        const userId = getTenantUserId(req);
        const body = req.body as { name?: unknown };
        if (typeof body?.name !== 'string' || !body.name.trim()) {
          res.status(400).json({ error: 'name is required' });
          return;
        }
        const raw = req.body as Record<string, unknown>;
        const normalized = normalizeUpdateInput(raw);
        const repo = await createOrUpdateRepository(
          { ...normalized, name: body.name.trim() },
          userId,
        );
        res.status(201).json(repo);
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.patch(
    '/api/repositories/:id',
    updateGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.update');
        const userId = getTenantUserId(req);
        const updates = normalizeUpdateInput(req.body as Record<string, unknown>);
        const repo = await patchRepository(paramId(req.params.id), updates, userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(repo);
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.delete(
    '/api/repositories/:id',
    deleteGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.delete', 'high');
        const userId = getTenantUserId(req);
        const id = paramId(req.params.id);
        const existing = await getRepository(id, userId);
        if (!existing) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        await removeRepository(id, userId);
        res.json({ success: true });
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.get(
    '/api/repositories/:id/features',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const id = paramId(req.params.id);
        const repo = await getRepository(id, userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const features = await getFeatures(id, userId);
        res.json({ features });
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.get(
    '/api/repositories/:id/project-graph',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const repo = await getRepository(paramId(req.params.id), userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json(await getProjectGraphOverview(repo));
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.get(
    '/api/repositories/:id/project-graph/runs',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const userId = getTenantUserId(req);
        const repo = await getRepository(paramId(req.params.id), userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const overview = await getProjectGraphOverview(repo);
        res.json({ runs: overview.runs });
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.patch(
    '/api/repositories/:id/project-graph/config',
    updateGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.projectGraph.config.update');
        const userId = getTenantUserId(req);
        const id = paramId(req.params.id);
        const repo = await getRepository(id, userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const config = normalizeProjectGraphConfig(req.body?.config ?? req.body);
        await setFeature(
          id,
          'project_graph',
          config.enabled,
          config as unknown as Record<string, unknown>,
        );
        const updatedRepo = await getRepository(id, userId);
        res.json(await getProjectGraphOverview(updatedRepo ?? repo));
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.post(
    '/api/repositories/:id/project-graph/scan',
    updateGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.projectGraph.scan', 'normal');
        const userId = getTenantUserId(req);
        const id = paramId(req.params.id);
        const repo = await getRepository(id, userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const requestedConfig = req.body?.config
          ? normalizeProjectGraphConfig(req.body.config)
          : null;
        const featureConfig =
          requestedConfig ||
          normalizeProjectGraphConfig(
            repo.features.find((item) => item.featureType === 'project_graph')
              ?.config,
          );
        if (requestedConfig) {
          await setFeature(
            id,
            'project_graph',
            featureConfig.enabled,
            featureConfig as unknown as Record<string, unknown>,
          );
        }
        const updatedRepo = requestedConfig
          ? await getRepository(id, userId)
          : repo;
        res.json(
          await runProjectGraphScan({
            repository: updatedRepo ?? repo,
            config: featureConfig,
            userId,
          }),
        );
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );

  app.post(
    '/api/repositories/:id/features',
    updateGuard,
    async (req: Request, res: Response) => {
      try {
        opts.auditMutation(req, 'repository.features.update');
        const userId = getTenantUserId(req);
        const id = paramId(req.params.id);
        const repo = await getRepository(id, userId);
        if (!repo) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        const body = req.body as {
          featureType?: unknown;
          enabled?: unknown;
          config?: unknown;
        };
        if (typeof body.featureType !== 'string' || !body.featureType.trim()) {
          res.status(400).json({ error: 'featureType is required' });
          return;
        }
        const enabled = Boolean(body.enabled);
        const config =
          body.config && typeof body.config === 'object' && !Array.isArray(body.config)
            ? (body.config as Record<string, unknown>)
            : {};
        const feature = await setFeature(
          id,
          body.featureType.trim(),
          enabled,
          config,
        );
        res.json(feature);
      } catch {
        res.status(500).json({ error: t('server.internalError', {}, req.locale) });
      }
    },
  );
}
