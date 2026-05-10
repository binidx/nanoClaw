import type { Express, Request, Response } from 'express';
import { Router } from 'express';

import * as db from '../db/workteam.js';
import { dba } from '../db/engine-access.js';
import { logger } from '../logger.js';
import { getCurrentUserId } from '../tenant/tenant-context.js';
import type {
  ProcessType,
  TeamStatus,
  WorkteamRunRecord,
} from '../workteam/types.js';
import {
  WorkteamOrchestrator,
  getOrchestrator,
} from '../workteam/orchestrator.js';
import {
  addAgent,
  addTask,
  createTeam,
  deleteTeam,
  getTeamSnapshot,
  markTeamReady,
  validateTeamConfig,
} from '../workteam/workteam-manager.js';
import { bridgeWorkteamToWorkflow } from '../workteam/bridge-to-workflow.js';
import { smartCreateTeam } from '../workteam/smart-creator.js';
import { createSdlcTeam } from '../workteam/sdlc-template.js';
import { buildSdlcInput } from '../workteam/sdlc-trigger.js';
import { getRepositoryById } from '../db/repositories.js';
import { createBinding, listBindingsByOwner } from '../db/resource-bindings.js';
import {
  parseRequirements,
  formatRequirementsForConfirmation,
} from '../prompt/requirement-parser.js';
import {
  AUTO_PROFILE_ID,
  clearRepositoryRunnerProfile,
  getRepositoryRunnerProfileId,
  resolveRunnerProfile,
  setRepositoryRunnerProfile,
} from '../workteam/runner-profile-resolver.js';
import {
  BUILTIN_PROFILES,
  findProfileById,
} from '../workteam/runner-profiles.js';
import { resolveUserUploadsDir } from '../tenant/tenant-paths.js';
import type { AgentUploadedFile } from '../types/agent.js';

export interface WorkteamRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

function paramId(raw: string | string[] | undefined): string {
  if (raw === undefined) return '';
  return typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? (raw[0] ?? '')
      : '';
}

function isProcessType(x: unknown): x is ProcessType {
  return x === 'sequential' || x === 'hierarchical' || x === 'dag';
}

function isTeamStatus(x: unknown): x is TeamStatus {
  return x === 'draft' || x === 'ready' || x === 'archived';
}

async function requireTeamForUser(teamId: string) {
  const team = await db.getWorkteam(teamId);
  if (!team) {
    return { ok: false as const, status: 404, message: 'Team not found' };
  }
  if (team.user_id !== getCurrentUserId()) {
    return { ok: false as const, status: 403, message: 'Forbidden' };
  }
  return { ok: true as const, team };
}

async function requireRunForUser(runId: string) {
  const run = await db.getWorkteamRun(runId);
  if (!run) {
    return { ok: false as const, status: 404, message: 'Run not found' };
  }
  const access = await requireTeamForUser(run.team_id);
  if (!access.ok) return access;
  return { ok: true as const, run, team: access.team };
}

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function stringifyConfigField(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return undefined;
}

async function getOrRestoreOrchestrator(
  runId: string,
  teamId: string,
  existingRun?: WorkteamRunRecord,
): Promise<WorkteamOrchestrator | undefined> {
  const existing = getOrchestrator(runId);
  if (existing) return existing;
  const run = existingRun ?? (await db.getWorkteamRun(runId));
  if (!run) return undefined;
  const snapshot = await getTeamSnapshot(teamId);
  if (!snapshot) return undefined;
  return (
    (await WorkteamOrchestrator.restoreFromRun(run, snapshot)) ?? undefined
  );
}

const CANCELABLE_STATUSES = ['pending', 'ready', 'waiting_approval', 'running'];

async function cancelRunDbOnly(runId: string): Promise<void> {
  const runTasks = await db.getWorkteamRunTasks(runId);
  for (const rt of runTasks) {
    if (CANCELABLE_STATUSES.includes(rt.status)) {
      await db.updateWorkteamRunTask(rt.id, {
        status: 'skipped',
        completed_at: new Date().toISOString(),
      });
    }
  }
  await db.updateWorkteamRun(runId, {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
  });
}

export function registerWorkteamRoutes(
  app: Express,
  opts: WorkteamRouteOptions,
): void {
  const viewGuard = opts.requirePermission('project.view', 'workteam.view');
  const manageGuard = opts.requirePermission(
    'project.manage',
    'workteam.manage',
  );
  const router = Router();

  router.post('/workteam', manageGuard, async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (typeof body.name !== 'string' || !body.name.trim()) {
        sendError(res, 400, 'name is required');
        return;
      }
      if (!isProcessType(body.process_type)) {
        sendError(
          res,
          400,
          'process_type must be sequential, hierarchical, or dag',
        );
        return;
      }
      const team = await createTeam({
        name: body.name.trim(),
        description:
          typeof body.description === 'string' ? body.description : undefined,
        process_type: body.process_type,
        workflow_config:
          body.workflow_config !== undefined && body.workflow_config !== null
            ? (body.workflow_config as Record<string, unknown>)
            : undefined,
      });
      res.json(team);
    } catch (err) {
      const message = 'Internal error';
      logger.error({ err }, 'workteam routes: POST /workteam failed');
      res.status(500).json({ error: message });
    }
  });

  router.get('/workteam', viewGuard, async (_req: Request, res: Response) => {
    try {
      const teams = await db.listWorkteams();
      res.json(teams);
    } catch (err) {
      const message = 'Internal error';
      logger.error({ err }, 'workteam routes: GET /workteam failed');
      res.status(500).json({ error: message });
    }
  });

  router.post(
    '/workteam/smart-create',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const body = req.body ?? {};
        if (typeof body.requirement !== 'string' || !body.requirement.trim()) {
          sendError(res, 400, 'requirement is required and cannot be empty');
          return;
        }
        const preferred =
          body.preferred_process_type !== undefined &&
          body.preferred_process_type !== null
            ? body.preferred_process_type
            : undefined;
        if (preferred !== undefined && !isProcessType(preferred)) {
          sendError(
            res,
            400,
            'preferred_process_type must be sequential, hierarchical, or dag',
          );
          return;
        }
        const teamName =
          typeof body.team_name === 'string' && body.team_name.trim()
            ? body.team_name.trim()
            : undefined;
        const { team } = await smartCreateTeam(
          { requirement: body.requirement, preferred_process_type: preferred },
          teamName,
        );
        const snapshot = await getTeamSnapshot(team.id);
        if (!snapshot) {
          res.status(500).json({ error: 'Team snapshot missing' });
          return;
        }
        res.json(snapshot);
      } catch (err) {
        const message = 'Internal error';
        logger.error(
          { err },
          'workteam routes: POST /workteam/smart-create failed',
        );
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/migrate-to-workflow',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const snapshot = await getTeamSnapshot(teamId);
        if (!snapshot) {
          sendError(res, 404, 'Team snapshot missing');
          return;
        }
        const workflow = await bridgeWorkteamToWorkflow({
          snapshot,
          userId: getCurrentUserId(),
          workflowName:
            typeof req.body?.workflow_name === 'string'
              ? req.body.workflow_name
              : undefined,
        });
        if (!workflow) {
          sendError(res, 500, 'Workflow migration failed');
          return;
        }
        res.json(workflow);
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: migrate-to-workflow failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.post(
    '/workteam/sdlc-create',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const body = req.body ?? {};
        const repositoryId =
          typeof body.repository_id === 'string'
            ? body.repository_id.trim()
            : '';
        if (!repositoryId) {
          sendError(res, 400, 'repository_id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        const teamName =
          typeof body.team_name === 'string' && body.team_name.trim()
            ? body.team_name.trim()
            : `SDLC — ${repo.name}`;
        const reviewRetries =
          typeof body.review_retries === 'number'
            ? body.review_retries
            : undefined;
        // Fix B5: expose parallel_modules so callers can split "开发实现" into
        // per-module subtasks that share the same "架构设计" dependency.
        const parallelModules = Array.isArray(body.parallel_modules)
          ? body.parallel_modules
              .map((m: unknown) => (typeof m === 'string' ? m.trim() : ''))
              .filter((m: string) => m.length > 0)
          : undefined;

        const runnerProfile = await resolveRunnerProfile(repositoryId, {
          worktreePath: repo.local_repo_path ?? undefined,
        });

        const { team } = await dba.transaction(async () => {
          const result = await createSdlcTeam(teamName, {
            repositoryId,
            reviewRetries,
            parallelModules,
            runnerProfile,
          });
          await createBinding(
            {
              resourceType: 'repository',
              resourceId: repositoryId,
              ownerType: 'workteam',
              ownerId: result.team.id,
              bindingKey: 'sdlc',
              branch: repo.default_target_branch,
            },
            userId,
          );
          return result;
        })();

        const snapshot = await getTeamSnapshot(team.id);
        res.json({
          ...snapshot,
          _binding: { repository_id: repositoryId, repository_name: repo.name },
          _runner_profile: runnerProfile
            ? { id: runnerProfile.id, name: runnerProfile.name }
            : null,
        });
      } catch (err) {
        const message = 'Internal error';
        logger.error(
          { err },
          'workteam routes: POST /workteam/sdlc-create failed',
        );
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    '/workteam/:id',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req.params.id);
        const access = await requireTeamForUser(id);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const snapshot = await getTeamSnapshot(id);
        if (!snapshot) {
          sendError(res, 404, 'Team not found');
          return;
        }
        res.json(snapshot);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: GET /workteam/:id failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.put(
    '/workteam/:id',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req.params.id);
        const access = await requireTeamForUser(id);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const body = req.body ?? {};
        const patch: Parameters<typeof db.updateWorkteam>[1] = {};
        if (typeof body.name === 'string') {
          if (!body.name.trim()) {
            sendError(res, 400, 'name cannot be empty');
            return;
          }
          patch.name = body.name;
        }
        if (typeof body.description === 'string')
          patch.description = body.description;
        if (body.process_type !== undefined) {
          if (!isProcessType(body.process_type)) {
            sendError(res, 400, 'Invalid process_type');
            return;
          }
          patch.process_type = body.process_type;
        }
        const wf = stringifyConfigField(body.workflow_config);
        if (wf !== undefined) patch.workflow_config = wf;
        if (body.status !== undefined) {
          if (!isTeamStatus(body.status)) {
            sendError(res, 400, 'Invalid status');
            return;
          }
          patch.status = body.status;
        }
        await db.updateWorkteam(id, patch);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: PUT /workteam/:id failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.delete(
    '/workteam/:id',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req.params.id);
        const access = await requireTeamForUser(id);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        await deleteTeam(id);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: DELETE /workteam/:id failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/agents',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const body = req.body ?? {};
        if (typeof body.role !== 'string' || !body.role.trim()) {
          sendError(res, 400, 'role is required');
          return;
        }
        if (typeof body.goal !== 'string' || !body.goal.trim()) {
          sendError(res, 400, 'goal is required');
          return;
        }
        const agent = await addAgent(teamId, {
          role: body.role.trim(),
          goal: body.goal.trim(),
          backstory:
            typeof body.backstory === 'string' ? body.backstory : undefined,
          assistant_id:
            typeof body.assistant_id === 'string'
              ? body.assistant_id
              : undefined,
          tools_config:
            body.tools_config !== undefined && body.tools_config !== null
              ? (body.tools_config as Record<string, unknown>)
              : undefined,
        });
        res.json(agent);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: POST agents failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.put(
    '/workteam/:id/agents/:agentId',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const agentId = paramId(req.params.agentId);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const agents = await db.getWorkteamAgents(teamId);
        if (!agents.some((a) => a.id === agentId)) {
          sendError(res, 404, 'Agent not found on team');
          return;
        }
        const body = req.body ?? {};
        const patch: Parameters<typeof db.updateWorkteamAgent>[1] = {};
        if (typeof body.role === 'string') patch.role = body.role;
        if (typeof body.goal === 'string') patch.goal = body.goal;
        if (typeof body.backstory === 'string')
          patch.backstory = body.backstory;
        if (typeof body.assistant_id === 'string')
          patch.assistant_id = body.assistant_id;
        if (typeof body.chat_jid === 'string') patch.chat_jid = body.chat_jid;
        if (typeof body.sort_order === 'number')
          patch.sort_order = body.sort_order;
        const tools = stringifyConfigField(body.tools_config);
        if (tools !== undefined) patch.tools_config = tools;
        await db.updateWorkteamAgent(agentId, patch);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: PUT agent failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.delete(
    '/workteam/:id/agents/:agentId',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const agentId = paramId(req.params.agentId);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const agents = await db.getWorkteamAgents(teamId);
        if (!agents.some((a) => a.id === agentId)) {
          sendError(res, 404, 'Agent not found on team');
          return;
        }
        await db.deleteWorkteamAgent(agentId);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: DELETE agent failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/tasks',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const body = req.body ?? {};
        if (typeof body.agent_id !== 'string' || !body.agent_id.trim()) {
          sendError(res, 400, 'agent_id is required');
          return;
        }
        if (typeof body.name !== 'string' || !body.name.trim()) {
          sendError(res, 400, 'name is required');
          return;
        }
        if (typeof body.description !== 'string') {
          sendError(res, 400, 'description is required');
          return;
        }
        const task = await addTask(teamId, {
          agent_id: body.agent_id.trim(),
          name: body.name.trim(),
          description: body.description,
          expected_output:
            typeof body.expected_output === 'string'
              ? body.expected_output
              : undefined,
          dependencies: Array.isArray(body.dependencies)
            ? body.dependencies
            : undefined,
          sort_order:
            typeof body.sort_order === 'number' ? body.sort_order : undefined,
          timeout_ms:
            typeof body.timeout_ms === 'number' ? body.timeout_ms : undefined,
          retry_limit:
            typeof body.retry_limit === 'number' ? body.retry_limit : undefined,
        });
        res.json(task);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: POST tasks failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.put(
    '/workteam/:id/tasks/:taskId',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const taskId = paramId(req.params.taskId);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const tasks = await db.getWorkteamTasks(teamId);
        if (!tasks.some((t) => t.id === taskId)) {
          sendError(res, 404, 'Task not found on team');
          return;
        }
        const body = req.body ?? {};
        const patch: Parameters<typeof db.updateWorkteamTask>[1] = {};
        if (typeof body.agent_id === 'string') patch.agent_id = body.agent_id;
        if (typeof body.name === 'string') patch.name = body.name;
        if (typeof body.description === 'string')
          patch.description = body.description;
        if (typeof body.expected_output === 'string')
          patch.expected_output = body.expected_output;
        if (Array.isArray(body.dependencies)) {
          patch.dependencies = JSON.stringify(body.dependencies);
        } else {
          const depStr = stringifyConfigField(body.dependencies);
          if (depStr !== undefined) patch.dependencies = depStr;
        }
        if (body.status !== undefined) patch.status = body.status;
        if (typeof body.sort_order === 'number')
          patch.sort_order = body.sort_order;
        if (typeof body.timeout_ms === 'number')
          patch.timeout_ms = body.timeout_ms;
        if (typeof body.retry_limit === 'number')
          patch.retry_limit = body.retry_limit;
        await db.updateWorkteamTask(taskId, patch);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: PUT task failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.delete(
    '/workteam/:id/tasks/:taskId',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const taskId = paramId(req.params.taskId);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const tasks = await db.getWorkteamTasks(teamId);
        if (!tasks.some((t) => t.id === taskId)) {
          sendError(res, 404, 'Task not found on team');
          return;
        }
        await db.deleteWorkteamTask(taskId);
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: DELETE task failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/validate',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req.params.id);
        const access = await requireTeamForUser(id);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const result = await validateTeamConfig(id);
        res.json(result);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: validate failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/ready',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const id = paramId(req.params.id);
        const access = await requireTeamForUser(id);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        try {
          await markTeamReady(id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendError(res, 400, msg);
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: ready failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/:id/run',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const body = req.body ?? {};
        const raw = body.input;
        let inputStr =
          raw === undefined || raw === null
            ? ''
            : typeof raw === 'string'
              ? raw
              : JSON.stringify(raw);

        const userId = getCurrentUserId();

        // Fix B1: wire buildSdlcInput so uploaded attachments extend the run
        // input with extracted text and image paths. The caller uploads via the
        // existing web-upload API first and then passes the metadata here.
        const uploadedFiles = Array.isArray(body.uploaded_files)
          ? (body.uploaded_files as unknown[]).filter(
              (f): f is AgentUploadedFile => {
                if (!f || typeof f !== 'object') return false;
                const rec = f as Record<string, unknown>;
                return (
                  typeof rec.name === 'string' &&
                  typeof rec.mimeType === 'string' &&
                  typeof rec.size === 'number' &&
                  typeof rec.relativePath === 'string'
                );
              },
            )
          : undefined;
        if (uploadedFiles && uploadedFiles.length > 0) {
          const uploadsRoot = resolveUserUploadsDir(userId);
          const sdlcInput = await buildSdlcInput(
            inputStr,
            uploadedFiles,
            uploadsRoot,
          );
          inputStr = sdlcInput.textContent;
          if (sdlcInput.imageFiles.length > 0) {
            logger.info(
              { runTeamId: teamId, images: sdlcInput.imageFiles.length },
              'workteam run: SDLC input includes images (not yet forwarded to agent)',
            );
          }
        }

        if (body.parse_requirements === true && inputStr) {
          const parsed = await parseRequirements(inputStr);
          inputStr = formatRequirementsForConfirmation(parsed);
        }

        const orch = new WorkteamOrchestrator(teamId);

        const bindings = await listBindingsByOwner('workteam', teamId);
        const repoBind = bindings.find(
          (b) => b.resource_type === 'repository' && b.binding_key === 'sdlc',
        );
        if (repoBind) {
          const repo = await getRepositoryById(repoBind.resource_id, userId);
          if (repo) {
            const ctx = [
              `Repository: ${repo.name}`,
              repo.clone_url ? `Clone URL: ${repo.clone_url}` : '',
              `Branch: ${repoBind.branch || repo.default_target_branch || 'main'}`,
              `ID: ${repo.id}`,
            ]
              .filter(Boolean)
              .join('\n');
            orch.setRepositoryContext(ctx);

            const profile = await resolveRunnerProfile(repo.id, {
              worktreePath: repo.local_repo_path ?? undefined,
            });
            if (profile) orch.setRunnerProfile(profile);
          }
        }

        const run = await orch.startRun(inputStr);
        res.json(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        logger.error({ err }, 'workteam routes: start run failed');
        // Tool-missing errors surface as 400 so the UI shows them verbatim.
        const status = message.startsWith('Runner profile') ? 400 : 500;
        res.status(status).json({ error: message });
      }
    },
  );

  router.get(
    '/workteam/:id/runs',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const runs = await db.listWorkteamRuns(teamId);
        res.json(runs);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: list runs failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.get(
    '/workteam/run/:runId',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        res.json(access.run);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: get run failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/pause',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const orch = getOrchestrator(runId);
        if (orch) {
          await orch.pauseRun();
        } else if (access.run.status === 'running') {
          await db.updateWorkteamRun(runId, { status: 'paused' });
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: pause run failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/resume',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        let orch = getOrchestrator(runId);
        if (orch) {
          await orch.resumeRun();
        } else if (
          access.run.status === 'paused' ||
          access.run.status === 'running'
        ) {
          orch = await getOrRestoreOrchestrator(
            runId,
            access.run.team_id,
            access.run,
          );
          if (orch) {
            await orch.resumeRun();
          } else {
            sendError(res, 500, 'Failed to restore orchestrator');
            return;
          }
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: resume run failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/cancel',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const orch = getOrchestrator(runId);
        if (orch) {
          await orch.cancelRun();
        } else {
          await cancelRunDbOnly(runId);
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: cancel run failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/task/:taskId/reassign',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const taskDefId = paramId(req.params.taskId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const body = req.body ?? {};
        if (typeof body.agent_id !== 'string' || !body.agent_id.trim()) {
          sendError(res, 400, 'agent_id is required');
          return;
        }
        const newAgentId = body.agent_id.trim();
        const agents = await db.getWorkteamAgents(access.run.team_id);
        if (!agents.some((a) => a.id === newAgentId)) {
          sendError(res, 400, 'agent_id is not on this team');
          return;
        }
        const runTasks = await db.getWorkteamRunTasks(runId);
        const rt = runTasks.find((r) => r.task_id === taskDefId);
        if (!rt) {
          sendError(res, 404, 'Run task not found for this task id');
          return;
        }
        const orch = getOrchestrator(runId);
        if (orch) {
          await orch.reassignTask(rt.id, newAgentId);
        } else {
          await db.updateWorkteamRunTask(rt.id, { agent_id: newAgentId });
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: reassign failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/task/:taskId/skip',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const taskDefId = paramId(req.params.taskId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const runTasks = await db.getWorkteamRunTasks(runId);
        const rt = runTasks.find((r) => r.task_id === taskDefId);
        if (!rt) {
          sendError(res, 404, 'Run task not found for this task id');
          return;
        }
        const orch = getOrchestrator(runId);
        if (orch) {
          await orch.skipTask(rt.id);
        } else {
          await db.updateWorkteamRunTask(rt.id, {
            status: 'skipped',
            completed_at: new Date().toISOString(),
          });
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: skip task failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/task/:taskId/retry',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const taskDefId = paramId(req.params.taskId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const runTasks = await db.getWorkteamRunTasks(runId);
        const rt = runTasks.find((r) => r.task_id === taskDefId);
        if (!rt) {
          sendError(res, 404, 'Run task not found for this task id');
          return;
        }
        const orch = getOrchestrator(runId);
        if (orch) {
          await orch.retryTask(rt.id);
        } else {
          if (rt.status !== 'failed') {
            sendError(res, 400, 'Only failed tasks can be retried');
            return;
          }
          await db.updateWorkteamRunTask(rt.id, {
            status: 'pending',
            error: '',
            started_at: '',
            completed_at: '',
          });
        }
        res.json({ ok: true });
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: retry task failed');
        res.status(500).json({ error: message });
      }
    },
  );

  router.post(
    '/workteam/run/:runId/task/:taskId/approve',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const taskDefId = paramId(req.params.taskId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const runTasks = await db.getWorkteamRunTasks(runId);
        const rt = runTasks.find((r) => r.task_id === taskDefId);
        if (!rt) {
          sendError(res, 404, 'Run task not found for this task id');
          return;
        }
        const decision = req.body?.decision;
        if (decision !== 'approve' && decision !== 'reject') {
          sendError(res, 400, 'decision must be "approve" or "reject"');
          return;
        }
        const orch = await getOrRestoreOrchestrator(
          runId,
          access.run.team_id,
          access.run,
        );
        if (!orch) {
          sendError(res, 500, 'Failed to restore orchestrator for this run');
          return;
        }
        if (decision === 'reject') {
          const reason =
            typeof req.body?.reason === 'string' ? req.body.reason : undefined;
          await orch.rejectTask(rt.id, reason);
        } else {
          await orch.approveTask(rt.id);
        }
        res.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        logger.error({ err }, 'workteam routes: approve/reject task failed');
        res.status(400).json({ error: message });
      }
    },
  );

  router.get(
    '/workteam/runner-profiles',
    viewGuard,
    async (_req: Request, res: Response) => {
      res.json(
        BUILTIN_PROFILES.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          detect_files: p.detect.files,
          required_tools: p.requiredTools,
          test_command: p.testCommand,
        })),
      );
    },
  );

  router.get(
    '/workteam/repositories/:id/runner-profile',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        const profileId = await getRepositoryRunnerProfileId(repositoryId);
        res.json({ profile_id: profileId ?? null });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: get repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.post(
    '/workteam/repositories/:id/runner-profile',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        const body = req.body ?? {};
        const profileId =
          typeof body.profile_id === 'string' ? body.profile_id.trim() : '';
        if (!profileId) {
          sendError(res, 400, 'profile_id is required');
          return;
        }
        if (profileId !== AUTO_PROFILE_ID && !findProfileById(profileId)) {
          sendError(
            res,
            400,
            `Unknown profile_id "${profileId}". Use one of: ${[AUTO_PROFILE_ID, ...BUILTIN_PROFILES.map((p) => p.id)].join(', ')}`,
          );
          return;
        }
        await setRepositoryRunnerProfile(repositoryId, profileId, userId);
        res.json({ ok: true, profile_id: profileId });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: set repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.delete(
    '/workteam/repositories/:id/runner-profile',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        await clearRepositoryRunnerProfile(repositoryId);
        res.json({ ok: true });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: clear repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.get(
    '/workteam/run/:runId/events',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const runId = paramId(req.params.runId);
        const access = await requireRunForUser(runId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const since =
          typeof req.query.since === 'string' && req.query.since.trim()
            ? req.query.since
            : undefined;
        const events = await db.getWorkteamEvents(runId, since);
        res.json(events);
      } catch (err) {
        const message = 'Internal error';
        logger.error({ err }, 'workteam routes: events failed');
        res.status(500).json({ error: message });
      }
    },
  );

  app.use('/api', router);
}

export function registerWorkteamSupportRoutes(
  app: Express,
  opts: WorkteamRouteOptions,
): void {
  const viewGuard = opts.requirePermission('project.view', 'workteam.view');
  const manageGuard = opts.requirePermission(
    'project.manage',
    'workteam.manage',
  );
  const router = Router();

  router.post(
    '/workteam/:id/migrate-to-workflow',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const teamId = paramId(req.params.id);
        const access = await requireTeamForUser(teamId);
        if (!access.ok) {
          sendError(res, access.status, access.message);
          return;
        }
        const snapshot = await getTeamSnapshot(teamId);
        if (!snapshot) {
          sendError(res, 404, 'Team snapshot missing');
          return;
        }
        const workflow = await bridgeWorkteamToWorkflow({
          snapshot,
          userId: getCurrentUserId(),
          workflowName:
            typeof req.body?.workflow_name === 'string'
              ? req.body.workflow_name
              : undefined,
        });
        if (!workflow) {
          sendError(res, 500, 'Workflow migration failed');
          return;
        }
        res.json(workflow);
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: migrate-to-workflow failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.get(
    '/workteam/runner-profiles',
    viewGuard,
    async (_req: Request, res: Response) => {
      try {
        res.json(
          BUILTIN_PROFILES.map((profile) => ({
            id: profile.id,
            name: profile.name,
            description: profile.description,
            test_command: profile.testCommand,
          })),
        );
      } catch (err) {
        logger.error({ err }, 'workteam routes: runner-profiles failed');
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.get(
    '/workteam/repositories/:id/runner-profile',
    viewGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        const profileId = await getRepositoryRunnerProfileId(repositoryId);
        res.json({ profile_id: profileId ?? null });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: get repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.post(
    '/workteam/repositories/:id/runner-profile',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        const body = req.body ?? {};
        const profileId =
          typeof body.profile_id === 'string' ? body.profile_id.trim() : '';
        if (!profileId) {
          sendError(res, 400, 'profile_id is required');
          return;
        }
        if (profileId !== AUTO_PROFILE_ID && !findProfileById(profileId)) {
          sendError(
            res,
            400,
            `Unknown profile_id "${profileId}". Use one of: ${[AUTO_PROFILE_ID, ...BUILTIN_PROFILES.map((p) => p.id)].join(', ')}`,
          );
          return;
        }
        await setRepositoryRunnerProfile(repositoryId, profileId, userId);
        res.json({ ok: true, profile_id: profileId });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: set repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  router.delete(
    '/workteam/repositories/:id/runner-profile',
    manageGuard,
    async (req: Request, res: Response) => {
      try {
        const repositoryId = paramId(req.params.id);
        if (!repositoryId) {
          sendError(res, 400, 'repository id is required');
          return;
        }
        const userId = getCurrentUserId();
        const repo = await getRepositoryById(repositoryId, userId);
        if (!repo) {
          sendError(res, 404, 'Repository not found');
          return;
        }
        await clearRepositoryRunnerProfile(repositoryId);
        res.json({ ok: true });
      } catch (err) {
        logger.error(
          { err },
          'workteam routes: clear repo runner-profile failed',
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  app.use('/api', router);
}
