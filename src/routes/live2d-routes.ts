import type { Express, Request, Response } from 'express';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  listModels,
  getModelInfo,
  uploadModel,
  removeModel,
  patchModel,
  getEmotionMappings,
  saveEmotionMappings,
  getUserPreferences,
  saveUserPreferences,
  getThumbnail,
  ensureModelCache,
  getModelFilePath,
} from '../extension/live2d-service.js';
import {
  getAvailableEmotionProviders,
} from '../soul/emotion-service.js';
import { getConfigValue } from '../config-store.js';
import { t } from '../i18n/index.js';

export interface Live2DRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function paramId(raw: string | string[]): string {
  return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] ?? '' : '';
}

async function assertModelAccess(
  modelId: string,
  userId: string,
  requireOwner: boolean,
): Promise<{ ok: true; model: NonNullable<Awaited<ReturnType<typeof getModelInfo>>> } | { ok: false; status: number; error: string }> {
  const model = await getModelInfo(modelId);
  if (!model) return { ok: false, status: 404, error: t('live2d.notFound', {}, undefined) };
  if (requireOwner && model.userId !== userId) {
    return { ok: false, status: 403, error: t('live2d.noPermission', {}, undefined) };
  }
  if (!requireOwner && model.visibility !== 'public' && model.userId !== userId) {
    return { ok: false, status: 404, error: t('live2d.notFound', {}, undefined) };
  }
  return { ok: true, model };
}

export function registerLive2DRoutes(
  app: Express,
  opts: Live2DRouteOptions,
): void {
  const renderGuard = opts.requirePermission('conversation.view');
  const viewGuard = opts.requirePermission('live2d.view');
  const manageGuard = opts.requirePermission('live2d.manage');

  // ── Read endpoints ──────────────────────────────────────────────

  app.get('/api/live2d/config', renderGuard, async (req: Request, res: Response) => {
    try {
      const globalEnabled = (await getConfigValue('LIVE2D_ENABLED')) === 'true';
      const emotionEnabled = (await getConfigValue('LIVE2D_EMOTION_ENABLED')) !== 'false';
      const userId = getTenantUserId(req);
      const prefs = await getUserPreferences(userId);
      res.json({ globalEnabled, emotionEnabled, preferences: prefs });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/models', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const models = await listModels(userId);
      res.json(models);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/models/:id/files/{*filePath}', renderGuard, async (req: Request, res: Response) => {
    try {
      const modelId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const access = await assertModelAccess(modelId, userId, false);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const rawPath = (req.params as Record<string, unknown>).filePath;
      const relativePath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
      if (!relativePath) return res.status(400).json({ error: t('live2d.fileRequired', {}, req.locale) });

      if (!(await ensureModelCache(modelId))) {
        return res.status(404).json({ error: t('live2d.dataRequired', {}, req.locale) });
      }

      const filePath = getModelFilePath(modelId, relativePath);
      if (!filePath) return res.status(404).json({ error: t('live2d.fileNotFound', {}, req.locale) });

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        json: 'application/json',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        m4a: 'audio/mp4',
        moc3: 'application/octet-stream',
        moc: 'application/octet-stream',
        mtn: 'application/octet-stream',
        exp3: 'application/json',
        physics3: 'application/json',
      };
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/models/:id/thumbnail', viewGuard, async (req: Request, res: Response) => {
    try {
      const modelId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const access = await assertModelAccess(modelId, userId, false);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const data = await getThumbnail(modelId);
      if (!data) return res.status(404).json({ error: t('errors.auto_09641e', {}, req.locale) });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/models/:id/emotions', viewGuard, async (req: Request, res: Response) => {
    try {
      const modelId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const access = await assertModelAccess(modelId, userId, false);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const mappings = await getEmotionMappings(modelId);
      res.json(mappings);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/preferences', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const prefs = await getUserPreferences(userId);
      res.json(prefs);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/live2d/emotion-providers', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const providers = await getAvailableEmotionProviders(userId);
      res.json(providers);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── Write endpoints ─────────────────────────────────────────────

  app.post('/api/live2d/models', manageGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const { name, description, visibility, format } = req.body;
      const zipBase64: string | undefined = req.body.zipData;

      if (!name || !zipBase64) {
        return res.status(400).json({ error: t('errors.auto_874975', {}, req.locale) });
      }

      const zipBuffer = Buffer.from(zipBase64, 'base64');
      const maxSize = 100 * 1024 * 1024;
      if (zipBuffer.length > maxSize) {
        return res.status(400).json({ error: t('live2d.fileTooLarge', {}, req.locale) });
      }

      let thumbnailBuffer: Buffer | undefined;
      if (req.body.thumbnail) {
        thumbnailBuffer = Buffer.from(req.body.thumbnail, 'base64');
      }

      const model = await uploadModel({
        name,
        description,
        userId,
        visibility: visibility || 'private',
        format: format || 'cubism4',
        zipBuffer,
        thumbnail: thumbnailBuffer,
      });

      res.json(model);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.delete('/api/live2d/models/:id', manageGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const isAdmin = !!(req as Request & { isAdmin?: boolean }).isAdmin;
      const ok = await removeModel(paramId(req.params.id), userId, isAdmin);
      if (!ok) return res.status(404).json({ error: t('errors.auto_6afe02', {}, req.locale) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.patch('/api/live2d/models/:id', manageGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const isAdmin = !!(req as Request & { isAdmin?: boolean }).isAdmin;
      let thumbnailBuffer: Buffer | undefined;
      if (typeof req.body.thumbnail === 'string' && req.body.thumbnail) {
        thumbnailBuffer = Buffer.from(req.body.thumbnail, 'base64');
      }
      const ok = await patchModel(paramId(req.params.id), userId, isAdmin, {
        name: req.body.name,
        description: req.body.description,
        visibility: req.body.visibility,
        thumbnail: thumbnailBuffer,
      });
      if (!ok) return res.status(404).json({ error: t('errors.auto_73f9db', {}, req.locale) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/live2d/models/:id/emotions', manageGuard, async (req: Request, res: Response) => {
    try {
      const modelId = paramId(req.params.id);
      const userId = getTenantUserId(req);
      const access = await assertModelAccess(modelId, userId, true);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { mappings } = req.body;
      if (!Array.isArray(mappings)) return res.status(400).json({ error: t('errors.auto_c27e51', {}, req.locale) });
      await saveEmotionMappings(modelId, mappings);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.put('/api/live2d/preferences', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      await saveUserPreferences(userId, req.body);
      const updated = await getUserPreferences(userId);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
