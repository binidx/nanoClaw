import type { Express, Request, Response } from 'express';

import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  createUserSkill,
  importUserSkillFromPath,
  updateUserSkill,
  removeUserSkill,
  toggleSkillVisibility,
  listMySkills,
  listAllVisibleSkills,
  installSharedSkillToUser,
} from '../user/user-skill-service.js';
import { logger } from '../logger.js';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';

function paramStr(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? '' : '';
}

export interface UserSkillRouteOptions {
  requirePermission: RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => import('express').RequestHandler;
}

export function registerUserSkillRoutes(
  app: Express,
  opts: UserSkillRouteOptions,
): void {
  const viewGuard = opts.requirePermission('assistant.manage', 'assistant.view');
  const createGuard = opts.requirePermission('assistant.manage', 'assistant.edit');
  const installGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');

  app.get('/api/user/skills', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const skills = await listAllVisibleSkills(userId);
      res.json(skills);
    } catch (err) {
      logger.error({ err }, 'user-skill: list failed');
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  app.get('/api/user/skills/mine', viewGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const skills = await listMySkills(userId);
      res.json(skills);
    } catch (err) {
      logger.error({ err }, 'user-skill: list mine failed');
      res.status(500).json({ error: 'Failed to list my skills' });
    }
  });

  app.post('/api/user/skills', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const {
        name,
        description,
        summary,
        skillContent,
        enabled,
        visibility,
        tags,
        metadata,
      } = req.body;
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const skill = await createUserSkill(userId, {
        name,
        description,
        summary,
        skillContent,
        enabled,
        visibility,
        tags,
        metadata,
      });
      res.json(skill);
    } catch (err) {
      logger.error({ err }, 'user-skill: create failed');
      res.status(500).json({ error: 'Failed to create skill' });
    }
  });

  app.post('/api/user/skills/import-path', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      res.json(await importUserSkillFromPath(userId, req.body || {}));
    } catch (err) {
      logger.error({ err }, 'user-skill: import-path failed');
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to import Skill from path',
      });
    }
  });

  app.put('/api/user/skills/:id', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const skillId = paramStr(req.params.id);
      const result = await updateUserSkill(userId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: 'Skill not found or not owned' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-skill: update failed');
      res.status(500).json({ error: 'Failed to update skill' });
    }
  });

  app.delete('/api/user/skills/:id', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const ok = await removeUserSkill(userId, paramStr(req.params.id));
      if (!ok) {
        res.status(404).json({ error: 'Skill not found or not owned' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'user-skill: delete failed');
      res.status(500).json({ error: 'Failed to delete skill' });
    }
  });

  app.post('/api/user/skills/:id/toggle-visibility', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const result = await toggleSkillVisibility(userId, paramStr(req.params.id));
      if (!result) {
        res.status(404).json({ error: 'Skill not found or not owned' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-skill: toggle-visibility failed');
      res.status(500).json({ error: 'Failed to toggle visibility' });
    }
  });

  app.post('/api/user/skills/install-shared', createGuard, installGuard, async (req: Request, res: Response) => {
    try {
      const userId = getTenantUserId(req);
      const { sourceSkillId } = req.body;
      if (!sourceSkillId) {
        res.status(400).json({ error: 'sourceSkillId is required' });
        return;
      }
      const result = await installSharedSkillToUser(userId, sourceSkillId);
      if (!result) {
        res.status(404).json({ error: 'Shared skill not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'user-skill: install-shared failed');
      res.status(500).json({ error: 'Failed to install shared skill' });
    }
  });
}
