import type { Express, Request, Response } from 'express';

import { getAssistant } from '../db.js';
import {
  createAssistantRepoBinding,
  deleteAssistantRepoBinding,
  getAssistantRepoBinding,
  listAssistantRepoBindings,
  provisionAssistantRepoWorktree,
  switchAssistantRepoBranch,
  updateAssistantRepoBinding,
} from '../assistant/assistant-repo.js';
import { logger } from '../logger.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { getTenantUserId } from '../tenant/tenant-request.js';

function decodeRouteParam(raw: string | string[] | undefined): string {
  const s = Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
  return decodeURIComponent(s).trim();
}

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
  if (assistant.user_id === SYSTEM_USER_ID) return true;
  return assistant.visibility === 'shared';
}

export interface AssistantRepoRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
}

export function registerAssistantRepoRoutes(
  app: Express,
  opts: AssistantRepoRouteOptions,
): void {
  const viewGuard = opts.requirePermission('assistant.manage', 'assistant.view');
  const manageGuard = opts.requirePermission('assistant.manage', 'assistant.edit');

  app.get('/api/assistants/:id/repo-bindings', viewGuard, async (req, res) => {
    try {
      const assistantId = decodeRouteParam(req.params.id);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canViewAssistant(assistant, userId)) {
        res.status(404).json({ error: 'Assistant not found' });
        return;
      }
      const canManage = canManageAssistant(assistant, userId);
      const bindings = await listAssistantRepoBindings(assistantId);
      res.json({
        bindings: bindings.map((b) => ({
          id: b.id,
          assistant_id: b.assistant_id,
          repo_url: b.repo_url,
          name: b.name,
          description: b.description,
          default_branch: b.default_branch,
          branch_filter: b.branch_filter,
          active_branch: b.active_branch,
          enabled: b.enabled,
          created_at: b.created_at,
          updated_at: b.updated_at,
          ...(canManage
            ? { local_path: b.local_path, worktree_path: b.worktree_path }
            : {}),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list assistant repo bindings');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/assistants/:id/repo-bindings', manageGuard, async (req: Request, res: Response) => {
    try {
      opts.auditMutation(req, 'assistants.repo_bindings.create', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(assistant ? 403 : 404).json({ error: assistant ? 'Forbidden' : 'Assistant not found' });
        return;
      }
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const repoUrl = String(body.repoUrl || body.repo_url || '').trim();
      const name = String(body.name || '').trim();
      if (!repoUrl || !name) {
        res.status(400).json({ error: 'repoUrl and name are required' });
        return;
      }
      const binding = await createAssistantRepoBinding({
        assistantId,
        repoUrl,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : 'main',
        branchFilter: Array.isArray(body.branchFilter) ? body.branchFilter.map(String) : [],
      });
      res.json({ binding });
    } catch (err) {
      logger.error({ err }, 'Failed to create repo binding');
      res.status(500).json({ error: 'Failed to create repo binding' });
    }
  });

  app.patch('/api/assistants/:id/repo-bindings/:bindingId', manageGuard, async (req: Request, res: Response) => {
    try {
      opts.auditMutation(req, 'assistants.repo_bindings.update', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(assistant ? 403 : 404).json({ error: assistant ? 'Forbidden' : 'Assistant not found' });
        return;
      }
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const binding = await updateAssistantRepoBinding(assistantId, bindingId, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: body.description === null ? null : typeof body.description === 'string' ? body.description : undefined,
        defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : undefined,
        branchFilter: Array.isArray(body.branchFilter) ? body.branchFilter.map(String) : undefined,
        activeBranch: body.activeBranch === null ? null : typeof body.activeBranch === 'string' ? body.activeBranch : undefined,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      if (!binding) {
        res.status(404).json({ error: 'Repo binding not found' });
        return;
      }
      res.json({ binding });
    } catch (err) {
      logger.error({ err }, 'Failed to update repo binding');
      res.status(500).json({ error: 'Failed to update repo binding' });
    }
  });

  app.delete('/api/assistants/:id/repo-bindings/:bindingId', manageGuard, async (req: Request, res: Response) => {
    try {
      opts.auditMutation(req, 'assistants.repo_bindings.delete', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(assistant ? 403 : 404).json({ error: assistant ? 'Forbidden' : 'Assistant not found' });
        return;
      }
      if (!await deleteAssistantRepoBinding(assistantId, bindingId)) {
        res.status(404).json({ error: 'Repo binding not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete repo binding');
      res.status(500).json({ error: 'Failed to delete repo binding' });
    }
  });

  app.post('/api/assistants/:id/repo-bindings/:bindingId/provision', manageGuard, async (req: Request, res: Response) => {
    try {
      opts.auditMutation(req, 'assistants.repo_bindings.provision', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(assistant ? 403 : 404).json({ error: assistant ? 'Forbidden' : 'Assistant not found' });
        return;
      }
      const worktreePath = await provisionAssistantRepoWorktree(assistantId, bindingId);
      if (!worktreePath) {
        res.status(500).json({ error: 'Failed to clone repository or create worktree' });
        return;
      }
      const binding = await getAssistantRepoBinding(assistantId, bindingId);
      res.json({ binding, worktree_path: worktreePath });
    } catch (err) {
      logger.error({ err }, 'Failed to provision assistant repo worktree');
      res.status(500).json({ error: 'Failed to provision repo' });
    }
  });

  app.post('/api/assistants/:id/repo-bindings/:bindingId/switch-branch', manageGuard, async (req: Request, res: Response) => {
    try {
      opts.auditMutation(req, 'assistants.repo_bindings.switch_branch', 'high');
      const assistantId = decodeRouteParam(req.params.id);
      const bindingId = decodeRouteParam(req.params.bindingId);
      const assistant = assistantId ? await getAssistant(assistantId) : undefined;
      const userId = getTenantUserId(req);
      if (!assistant || !canManageAssistant(assistant, userId)) {
        res.status(assistant ? 403 : 404).json({ error: assistant ? 'Forbidden' : 'Assistant not found' });
        return;
      }
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
      if (!branch) {
        res.status(400).json({ error: 'branch is required' });
        return;
      }
      const binding = await getAssistantRepoBinding(assistantId, bindingId);
      if (!binding) {
        res.status(404).json({ error: 'Repo binding not found' });
        return;
      }
      if (binding.branch_filter.length > 0 && !binding.branch_filter.includes(branch)) {
        res.status(400).json({ error: `Branch "${branch}" is not allowed by branch_filter` });
        return;
      }
      const worktreePath = await switchAssistantRepoBranch(assistantId, bindingId, branch);
      if (!worktreePath) {
        res.status(500).json({ error: 'Failed to switch branch' });
        return;
      }
      const updatedBinding = await getAssistantRepoBinding(assistantId, bindingId);
      res.json({ binding: updatedBinding, worktree_path: worktreePath });
    } catch (err) {
      logger.error({ err }, 'Failed to switch assistant repo branch');
      res.status(500).json({ error: 'Failed to switch branch' });
    }
  });
}
