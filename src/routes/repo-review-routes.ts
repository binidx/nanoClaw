import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';

import { parsePaginationQuery, paginateArray } from '../pagination.js';
import type { RequirePermissionFn } from '../auth/auth-middleware.js';
import type { LocalCapabilityId } from '../auth/local-capability-policy.js';
import {
  grantResourceAccess,
  hasResourceAccess,
  revokeResourceAccess,
  listResourceAccessUsers,
} from '../auth/permission-engine.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { logger } from '../logger.js';
import { scheduleCodeMapRebuild } from './code-map-routes.js';
import {
  cancelRepoReviewRun,
  decideRepoReviewRunByHuman,
  enqueueRemoteRepoReview,
  getRepoReviewRunDetail,
  inspectRepoReviewRepositoryCandidate,
  listRepoReviewChatMembers,
  listRepoReviewBranchStatesForRepository,
  listRepoReviewRemoteBranchCommits,
  getRepoReviewRepositoryRecord,
  getRepoReviewRun,
  installRepoReviewHooks,
  listRepoReviewRemoteBranches,
  listRepoReviewProfiles,
  listRepoReviewRepositories,
  listRepoReviewRuns,
  normalizeRepoReviewRepositoryRecord,
  normalizeRepoReviewRunRecord,
  parseRepoReviewWebhookEvent,
  REPO_REVIEW_PERMISSION_DENIED_MESSAGE,
  removeRepoReviewProfile,
  removeRepoReviewRepository,
  saveRepoReviewProfileConfig,
  queueRemoteBranchReview,
  queueRemoteRepoReview,
  rerunRepoReviewRun,
  triggerLocalRepoReview,
  uninstallRepoReviewHooks,
  saveRepoReviewRepositoryConfig,
  verifyRepoReviewWebhook,
} from '../repo-review/repo-review-service.js';
import {
  deleteReviewRepositoryMember,
  deleteSshKey,
  getReviewProfileById,
  getReviewRepositoryById,
  getSshKeyById,
  isUserReviewRepositoryMember,
  listReviewRepositoriesForUser,
  listReviewRepositoryMembers,
  listReviewRunsForUser,
  listSshKeys,
  saveSshKey,
  setDefaultSshKey,
  upsertReviewRepositoryMember,
  type ReviewRemoteProvider,
} from '../db.js';
import {
  ensureUserByUsername,
  getUserById,
  getUserByUsername,
} from '../user/user-service.js';
import { getUserEffectivePermissions } from '../auth/permission-engine.js';
import {
  getRepoReviewDigestRunDetailRead,
  getRepoReviewOverviewRead,
  listRepoReviewDigestRunsRead,
  listRepoReviewRepositorySummariesRead,
  listRepoReviewRunSummariesResult,
} from '../repo-review/repo-review-read-service.js';
import { t } from '../i18n/index.js';

type RawBodyRequest = Request & { rawBody?: string };

const webhookJsonBodyParser = express.raw({
  type: ['application/json', 'application/*+json', 'text/json'],
  limit: '2mb',
});

const parseRawWebhookJsonBody: express.RequestHandler = (req, res, next) => {
  if (!Buffer.isBuffer(req.body)) {
    next();
    return;
  }

  const rawBody = req.body.toString('utf8');
  (req as RawBodyRequest).rawBody = rawBody;
  try {
    req.body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }
  next();
};

/** Full review capability: same four codes granted to the preset manager role. */
const ALL_REVIEW_PERMISSION_CODES = [
  'review.create',
  'review.view',
  'review.manual',
  'review.annotate',
] as const;

async function userHasAllReviewPermissions(
  username: string | null,
): Promise<boolean> {
  if (!username) return false;
  const user = await getUserByUsername(username);
  if (!user) return false;
  const codes = await getUserEffectivePermissions(user.id);
  return ALL_REVIEW_PERMISSION_CODES.every((code) => codes.includes(code));
}

async function userCanAccessReviewRunRepository(
  userId: string,
  runId: string,
  repositoryId: string,
): Promise<boolean> {
  if (await isUserReviewRepositoryMember(repositoryId, userId)) return true;
  if (await hasResourceAccess(userId, 'review_repository', repositoryId)) {
    return true;
  }
  return hasResourceAccess(userId, 'review_run', runId);
}

async function userCanAccessReviewRepository(
  userId: string,
  repositoryId: string,
): Promise<boolean> {
  if (await isUserReviewRepositoryMember(repositoryId, userId)) return true;
  if (await hasResourceAccess(userId, 'review_repository', repositoryId)) {
    return true;
  }
  return hasResourceAccess(userId, 'repository', repositoryId);
}

async function requireReviewRepositoryAccess(
  req: Request,
  res: Response,
  opts: Pick<RepoReviewRouteOptions, 'getAuthenticatedUsername'>,
  repositoryId: string,
): Promise<boolean> {
  const username = opts.getAuthenticatedUsername(req.headers.cookie);
  if (!username || (await userHasAllReviewPermissions(username))) {
    return true;
  }
  const user = await getUserByUsername(username);
  if (
    !user ||
    !(await userCanAccessReviewRepository(user.id, repositoryId))
  ) {
    res.status(404).json({ error: 'Repository not found' });
    return false;
  }
  return true;
}

async function requireReviewRunAccess(
  req: Request,
  res: Response,
  opts: Pick<RepoReviewRouteOptions, 'getAuthenticatedUsername'>,
  runId: string,
): Promise<boolean> {
  const username = opts.getAuthenticatedUsername(req.headers.cookie);
  if (!username || (await userHasAllReviewPermissions(username))) {
    return true;
  }
  const run = await getRepoReviewRun(runId);
  const user = await getUserByUsername(username);
  if (
    !run ||
    !user ||
    !(await userCanAccessReviewRunRepository(user.id, runId, run.repositoryId))
  ) {
    res.status(404).json({ error: 'Run not found' });
    return false;
  }
  return true;
}

const REVIEW_MEMBER_ACCESS_LEVELS = new Set(['viewer', 'reviewer', 'manager']);

export interface RepoReviewRouteOptions {
  auditMutation: (
    req: Request,
    operation: string,
    risk?: 'normal' | 'high',
  ) => void;
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
  requirePermission: RequirePermissionFn;
  requireLocalCapability?: (
    capabilityId: LocalCapabilityId,
  ) => express.RequestHandler;
}

export function registerRepoReviewAdminRoutes(
  app: Express,
  opts: RepoReviewRouteOptions,
): void {
  const viewGuard = opts.requirePermission(
    'review.view',
    'review.repo.view',
    'repository.view',
  );
  const createGuard = opts.requirePermission(
    'review.create',
    'review.repo.create',
  );
  const localInstallGuard =
    opts.requireLocalCapability?.('localInstall') ||
    opts.requirePermission('local.install');
  const manualGuard = opts.requirePermission(
    'review.manual',
    'review.run.manual',
  );

  app.get('/api/repo-reviews', viewGuard, async (req, res) => {
    const repositoryId =
      typeof req.query.repositoryId === 'string'
        ? req.query.repositoryId.trim()
        : '';
    const username = opts.getAuthenticatedUsername(req.headers.cookie);
    let userId: string | undefined;
    if (username && !(await userHasAllReviewPermissions(username))) {
      const user = await getUserByUsername(username);
      userId = user?.id;
    }
    res.json(
      await getRepoReviewOverviewRead(repositoryId || undefined, userId),
    );
  });

  app.get('/api/repo-reviews/repositories', viewGuard, async (req, res) => {
    const summaryOnly =
      typeof req.query.summary === 'string' &&
      (req.query.summary === '1' || req.query.summary === 'true');
    const username = opts.getAuthenticatedUsername(req.headers.cookie);
    if (await userHasAllReviewPermissions(username)) {
      res.json({
        repositories: summaryOnly
          ? await listRepoReviewRepositorySummariesRead()
          : await listRepoReviewRepositories(),
      });
      return;
    }
    if (!username) {
      res.json({ repositories: [] });
      return;
    }
    const user = await getUserByUsername(username);
    if (!user) {
      res.json({ repositories: [] });
      return;
    }
    res.json({
      repositories: summaryOnly
        ? await listRepoReviewRepositorySummariesRead(user.id)
        : await Promise.all(
            (await listReviewRepositoriesForUser(user.id)).map((record) =>
              normalizeRepoReviewRepositoryRecord(record),
            ),
          ),
    });
  });

  app.get(
    '/api/repo-reviews/repositories/:repositoryId',
    viewGuard,
    async (req, res) => {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const username = opts.getAuthenticatedUsername(req.headers.cookie);
      if (!(await userHasAllReviewPermissions(username))) {
        const user = username ? await getUserByUsername(username) : null;
        if (
          !user ||
          !(await userCanAccessReviewRepository(user.id, repositoryId))
        ) {
          res.status(404).json({ error: 'Repository not found' });
          return;
        }
      }
      const record = await getRepoReviewRepositoryRecord(repositoryId);
      if (!record) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      res.json({
        repository: await normalizeRepoReviewRepositoryRecord(record),
        profiles: await listRepoReviewProfiles(repositoryId),
      });
    },
  );

  app.post(
    '/api/repo-reviews/repositories/discover',
    createGuard,
    (req, res) => {
      try {
        res.json({
          detection: inspectRepoReviewRepositoryCandidate(req.body || {}),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.autoDetectFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/discover-contributors',
    createGuard,
    async (req, res) => {
      try {
        const cloneUrl =
          typeof req.body?.cloneUrl === 'string'
            ? req.body.cloneUrl.trim()
            : '';
        if (!cloneUrl) {
          res
            .status(400)
            .json({ error: t('repo.cloneUrlRequired', {}, req.locale) });
          return;
        }
        const { fetchContributorsFromRemoteUrl } =
          await import('../repo-review/repo-review-git.js');
        res.json({
          contributors: await fetchContributorsFromRemoteUrl(cloneUrl),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.readContributorsFailed', {}, req.locale),
        });
      }
    },
  );

  app.get(
    '/api/repo-reviews/review-chat-members',
    viewGuard,
    async (req, res) => {
      try {
        const chatJid =
          typeof req.query.chatJid === 'string' ? req.query.chatJid.trim() : '';
        res.json({
          members: await listRepoReviewChatMembers(chatJid),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.loadChatMembersFailed', {}, req.locale),
        });
      }
    },
  );

  app.post('/api/repo-reviews/repositories', createGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'repo-reviews.repositories.upsert', 'high');
      const payload = (req.body || {}) as Record<string, unknown>;
      const payloadId = typeof payload.id === 'string' ? payload.id.trim() : '';
      const preExisting = payloadId
        ? await getReviewRepositoryById(payloadId)
        : undefined;
      if (
        preExisting &&
        !(await requireReviewRepositoryAccess(req, res, opts, payloadId))
      ) {
        return;
      }
      const result = await saveRepoReviewRepositoryConfig(payload);
      if (!preExisting) {
        const creatorName = opts.getAuthenticatedUsername(req.headers.cookie);
        if (creatorName) {
          const creator = await ensureUserByUsername(creatorName);
          await upsertReviewRepositoryMember(
            result.repository.id,
            creator.id,
            'manager',
            null,
          );
        }
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : t('repoReview.saveRepoConfigFailed', {}, req.locale),
      });
    }
  });

  app.patch(
    '/api/repo-reviews/repositories/:repositoryId',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.repositories.upsert', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        res.json(
          await saveRepoReviewRepositoryConfig({
            ...(req.body || {}),
            id: repositoryId,
          }),
        );
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.saveRepoConfigFailed', {}, req.locale),
        });
      }
    },
  );

  app.delete(
    '/api/repo-reviews/repositories/:repositoryId',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.repositories.delete', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        await removeRepoReviewRepository(repositoryId);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.deleteRepoConfigFailed', {}, req.locale),
        });
      }
    },
  );

  app.get(
    '/api/repo-reviews/repositories/:repositoryId/members',
    viewGuard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const members = await listReviewRepositoryMembers(repositoryId);
        res.json({ members });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.loadRepoMembersFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/members',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(
          req,
          'repo-reviews.repositories.members.add',
          'high',
        );
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const body = (req.body || {}) as Record<string, unknown>;
        const userId =
          typeof body.userId === 'string' ? body.userId.trim() : '';
        const accessLevel =
          typeof body.accessLevel === 'string' ? body.accessLevel.trim() : '';
        if (!userId) {
          res
            .status(400)
            .json({ error: t('repoReview.userIdRequired', {}, req.locale) });
          return;
        }
        if (!REVIEW_MEMBER_ACCESS_LEVELS.has(accessLevel)) {
          res.status(400).json({
            error: t('errors.auto_51b899', {}, req.locale),
          });
          return;
        }
        const target = await getUserById(userId);
        if (!target) {
          res.status(400).json({ error: t('user.notFound', {}, req.locale) });
          return;
        }
        const granterName = opts.getAuthenticatedUsername(req.headers.cookie);
        const grantedBy = granterName
          ? (await ensureUserByUsername(granterName)).id
          : null;
        await upsertReviewRepositoryMember(
          repositoryId,
          userId,
          accessLevel,
          grantedBy,
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.addMemberFailed', {}, req.locale),
        });
      }
    },
  );

  app.delete(
    '/api/repo-reviews/repositories/:repositoryId/members/:userId',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(
          req,
          'repo-reviews.repositories.members.remove',
          'high',
        );
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const userId = decodeURIComponent(String(req.params.userId || ''));
        await deleteReviewRepositoryMember(repositoryId, userId);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.removeMemberFailed', {}, req.locale),
        });
      }
    },
  );

  app.get(
    '/api/repo-reviews/repositories/:repositoryId/branches',
    viewGuard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const force =
          req.query.force === '1' ||
          req.query.force === 'true' ||
          req.query.force === 'yes';
        res.json({
          branches: await listRepoReviewRemoteBranches(repositoryId, { force }),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.loadBranchesFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/hooks/install',
    createGuard,
    localInstallGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.hooks.install', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        res.json(
          await installRepoReviewHooks({
            repositoryId,
            nanoclawRoot: process.cwd(),
          }),
        );
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.installHooksFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/hooks/uninstall',
    createGuard,
    localInstallGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.hooks.uninstall', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        res.json(await uninstallRepoReviewHooks({ repositoryId }));
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.uninstallHooksFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/trigger',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.trigger', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const stage = req.body?.stage === 'commit' ? 'commit' : 'push';
        const result = await triggerLocalRepoReview({
          repositoryId,
          stage,
          userId: getTenantUserId(req),
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.triggerReviewFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/sync-remote',
    createGuard,
    localInstallGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.sync-remote', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const result = await queueRemoteRepoReview({
          repositoryId,
          userId: getTenantUserId(req),
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.syncRemoteFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/repositories/:repositoryId/sync-branch',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.sync-branch', 'high');
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const branch =
          typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
        const result = await queueRemoteBranchReview({
          repositoryId,
          userId: getTenantUserId(req),
          branch,
          baselineMode:
            typeof req.body?.baselineMode === 'string'
              ? req.body.baselineMode.trim()
              : undefined,
          baselineRunId:
            typeof req.body?.baselineRunId === 'string'
              ? req.body.baselineRunId.trim()
              : undefined,
          baselineSha:
            typeof req.body?.baselineSha === 'string'
              ? req.body.baselineSha.trim()
              : undefined,
          reviewMode:
            typeof req.body?.reviewMode === 'string'
              ? req.body.reviewMode.trim()
              : undefined,
          allowRepeat: req.body?.allowRepeat === true,
        });
        res.json(result);
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.triggerBranchReviewFailed', {}, req.locale),
        });
      }
    },
  );

  app.get('/api/repo-reviews/profiles', viewGuard, async (req, res) => {
    const repositoryId =
      typeof req.query.repositoryId === 'string'
        ? req.query.repositoryId.trim()
        : '';
    if (
      repositoryId &&
      !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
    ) {
      return;
    }
    res.json({
      profiles: await listRepoReviewProfiles(repositoryId || undefined),
    });
  });

  app.post('/api/repo-reviews/profiles', createGuard, async (req, res) => {
    try {
      opts.auditMutation(req, 'repo-reviews.profiles.upsert', 'high');
      const repositoryId =
        typeof req.body?.repository_id === 'string'
          ? req.body.repository_id.trim()
          : typeof req.body?.repositoryId === 'string'
            ? req.body.repositoryId.trim()
            : '';
      if (
        repositoryId &&
        !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
      ) {
        return;
      }
      res.json(await saveRepoReviewProfileConfig(req.body || {}));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : t('repoReview.saveProfileFailed', {}, req.locale),
      });
    }
  });

  app.patch(
    '/api/repo-reviews/profiles/:profileId',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.profiles.upsert', 'high');
        const profileId = decodeURIComponent(String(req.params.profileId || ''));
        const existingProfile = await getReviewProfileById(profileId);
        if (
          existingProfile &&
          !(await requireReviewRepositoryAccess(
            req,
            res,
            opts,
            existingProfile.repository_id,
          ))
        ) {
          return;
        }
        res.json(
          await saveRepoReviewProfileConfig({
            ...(req.body || {}),
            id: profileId,
          }),
        );
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.saveProfileFailed', {}, req.locale),
        });
      }
    },
  );

  app.delete(
    '/api/repo-reviews/profiles/:profileId',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.profiles.delete', 'high');
        const profileId = decodeURIComponent(String(req.params.profileId || ''));
        const existingProfile = await getReviewProfileById(profileId);
        if (
          existingProfile &&
          !(await requireReviewRepositoryAccess(
            req,
            res,
            opts,
            existingProfile.repository_id,
          ))
        ) {
          return;
        }
        await removeRepoReviewProfile(profileId);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.deleteProfileFailed', {}, req.locale),
        });
      }
    },
  );

  app.get('/api/repo-reviews/runs', viewGuard, async (req, res) => {
    const repositoryId =
      typeof req.query.repositoryId === 'string'
        ? req.query.repositoryId.trim()
        : '';
    const username = opts.getAuthenticatedUsername(req.headers.cookie);

    let runs: Awaited<ReturnType<typeof listRepoReviewRuns>>;
    if (await userHasAllReviewPermissions(username)) {
      runs = await listRepoReviewRuns(repositoryId || undefined);
    } else if (!username) {
      runs = [];
    } else {
      const user = await getUserByUsername(username);
      if (!user) {
        runs = [];
      } else {
        runs = (await Promise.all(
          (await listReviewRunsForUser(user.id, repositoryId || undefined)).map(
            (run) => normalizeRepoReviewRunRecord(run),
          ),
        )) as Awaited<ReturnType<typeof listRepoReviewRuns>>;
      }
    }

    if (typeof req.query.page === 'string') {
      const pq = parsePaginationQuery(req);
      res.json(paginateArray(runs, pq));
    } else {
      res.json({ runs });
    }
  });

  app.get('/api/repo-reviews/runs-summary', viewGuard, async (req, res) => {
    const repositoryId =
      typeof req.query.repositoryId === 'string'
        ? req.query.repositoryId.trim()
        : '';
    const status =
      typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const keyword =
      typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const branch =
      typeof req.query.branch === 'string' ? req.query.branch.trim() : '';
    const limit =
      typeof req.query.limit === 'string'
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
    const username = opts.getAuthenticatedUsername(req.headers.cookie);
    if (await userHasAllReviewPermissions(username)) {
      res.json(
        await listRepoReviewRunSummariesResult({
          repositoryId: repositoryId || undefined,
          status: status || undefined,
          keyword: keyword || undefined,
          branch: branch || undefined,
          limit,
        }),
      );
      return;
    }
    if (!username) {
      res.json({ runs: [], total: 0 });
      return;
    }
    const user = await getUserByUsername(username);
    if (!user) {
      res.json({ runs: [], total: 0 });
      return;
    }
    const result = await listRepoReviewRunSummariesResult({
      repositoryId: repositoryId || undefined,
      status: status || undefined,
      keyword: keyword || undefined,
      branch: branch || undefined,
      limit,
      userId: user.id,
    });
    res.json(result);
  });

  app.get(
    '/api/repo-reviews/repositories/:repositoryId/digest-runs',
    viewGuard,
    async (req, res) => {
      const repositoryId = decodeURIComponent(
        String(req.params.repositoryId || ''),
      );
      const limit =
        typeof req.query.limit === 'string'
          ? Number.parseInt(req.query.limit, 10)
          : undefined;
      const username = opts.getAuthenticatedUsername(req.headers.cookie);
      if (!(await userHasAllReviewPermissions(username))) {
        const user = username ? await getUserByUsername(username) : null;
        if (
          !user ||
          !(await userCanAccessReviewRepository(user.id, repositoryId))
        ) {
          res.status(404).json({ error: 'Repository not found' });
          return;
        }
      }
      res.json({
        runs: await listRepoReviewDigestRunsRead(repositoryId, limit),
      });
    },
  );

  app.get(
    '/api/repo-reviews/digest-runs/:runId',
    viewGuard,
    async (req, res) => {
      const runId = decodeURIComponent(String(req.params.runId || ''));
      const detail = await getRepoReviewDigestRunDetailRead(runId);
      if (!detail) {
        res.status(404).json({ error: 'Digest run not found' });
        return;
      }
      const username = opts.getAuthenticatedUsername(req.headers.cookie);
      if (!(await userHasAllReviewPermissions(username))) {
        const user = username ? await getUserByUsername(username) : null;
        if (
          !user ||
          !(await userCanAccessReviewRepository(user.id, detail.repository.id))
        ) {
          res.status(404).json({ error: 'Digest run not found' });
          return;
        }
      }
      res.json(detail);
    },
  );

  app.get('/api/repo-reviews/runs/:runId', viewGuard, async (req, res) => {
    const runId = decodeURIComponent(String(req.params.runId || ''));
    const run = await getRepoReviewRun(runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const username = opts.getAuthenticatedUsername(req.headers.cookie);
    if (!(await userHasAllReviewPermissions(username))) {
      const user = username ? await getUserByUsername(username) : null;
      if (
        !user ||
        !(await userCanAccessReviewRunRepository(
          user.id,
          runId,
          run.repositoryId,
        ))
      ) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
    }
    res.json({ run });
  });

  app.get(
    '/api/repo-reviews/runs/:runId/detail',
    viewGuard,
    async (req, res) => {
      const runId = decodeURIComponent(String(req.params.runId || ''));
      const detail = await getRepoReviewRunDetail(runId);
      if (!detail) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      const username = opts.getAuthenticatedUsername(req.headers.cookie);
      if (!(await userHasAllReviewPermissions(username))) {
        const user = username ? await getUserByUsername(username) : null;
        const repositoryId =
          (typeof detail.run?.repositoryId === 'string'
            ? detail.run.repositoryId
            : '') ||
          (typeof detail.repository?.id === 'string'
            ? detail.repository.id
            : '');
        if (
          !user ||
          !repositoryId ||
          !(await userCanAccessReviewRunRepository(
            user.id,
            runId,
            repositoryId,
          ))
        ) {
          res.status(404).json({ error: 'Run not found' });
          return;
        }
      }
      res.json(detail);
    },
  );

  app.get(
    '/api/repo-reviews/repositories/:repositoryId/branches/status',
    viewGuard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const stage = req.query.stage === 'commit' ? 'commit' : 'push';
        res.json({
          branches: await listRepoReviewBranchStatesForRepository(
            repositoryId,
            stage,
          ),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.loadBranchStatusFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/runs/:runId/rerun',
    createGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.runs.rerun', 'high');
        const runId = decodeURIComponent(String(req.params.runId || ''));
        if (!(await requireReviewRunAccess(req, res, opts, runId))) {
          return;
        }
        const result = await rerunRepoReviewRun({
          runId,
          userId: getTenantUserId(req),
        });
        res.json({
          run: result.run,
          blocked: result.blocking,
          reused: result.reused || false,
          message:
            result.run.summary ||
            t('repoReview.rerunTriggered', {}, req.locale),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.rerunFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/runs/:runId/cancel',
    manualGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.runs.cancel', 'high');
        const runId = decodeURIComponent(String(req.params.runId || ''));
        if (!(await requireReviewRunAccess(req, res, opts, runId))) {
          return;
        }
        const cancelledBy =
          opts.getAuthenticatedUsername(req.headers.cookie) || 'web-user';
        const run = await cancelRepoReviewRun({
          runId,
          cancelledBy,
        });
        res.json({
          cancelled: true,
          run,
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.cancelFailed', {}, req.locale),
        });
      }
    },
  );

  app.get(
    '/api/repo-reviews/repositories/:repositoryId/branch-commits',
    viewGuard,
    async (req, res) => {
      try {
        const repositoryId = decodeURIComponent(
          String(req.params.repositoryId || ''),
        );
        if (
          !(await requireReviewRepositoryAccess(req, res, opts, repositoryId))
        ) {
          return;
        }
        const branch =
          typeof req.query.branch === 'string' ? req.query.branch.trim() : '';
        const limit =
          typeof req.query.limit === 'string'
            ? Number.parseInt(req.query.limit, 10)
            : undefined;
        res.json({
          commits: await listRepoReviewRemoteBranchCommits(
            repositoryId,
            branch,
            {
              limit,
            },
          ),
        });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error
              ? err.message
              : t('repoReview.loadBranchCommitsFailed', {}, req.locale),
        });
      }
    },
  );

  app.post(
    '/api/repo-reviews/runs/:runId/manual-decision',
    manualGuard,
    async (req, res) => {
      try {
        opts.auditMutation(req, 'repo-reviews.runs.manual-decision', 'high');
        const runId = decodeURIComponent(String(req.params.runId || ''));
        if (!(await requireReviewRunAccess(req, res, opts, runId))) {
          return;
        }
        const decision =
          req.body?.decision === 'pass' || req.body?.decision === 'fail'
            ? req.body.decision
            : '';
        if (!decision) {
          throw new Error(t('errors.auto_459228', {}, req.locale));
        }
        const decidedBy =
          opts.getAuthenticatedUsername(req.headers.cookie) || 'web-user';
        const run = await decideRepoReviewRunByHuman({
          runId,
          decision,
          decidedBy,
        });
        res.json({ run });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t('repoReview.manualDecisionFailed', {}, req.locale);
        res
          .status(message === REPO_REVIEW_PERMISSION_DENIED_MESSAGE ? 403 : 400)
          .json({
            error: message,
          });
      }
    },
  );

  // ── Review resource sharing ──
  const shareGuard = opts.requirePermission(
    'review.create',
    'review.repo.share',
  );

  app.get(
    '/api/repo-review/:repositoryId/shares',
    shareGuard,
    async (req, res) => {
      try {
        const repoId = String(req.params.repositoryId);
        const callerId = getTenantUserId(req);
        if (callerId) {
          const isMember = await isUserReviewRepositoryMember(repoId, callerId);
          if (!isMember) {
            res.status(403).json({
              error: t('repoReview.viewShareListNoPermission', {}, req.locale),
            });
            return;
          }
        }
        const users = await listResourceAccessUsers(
          'review_repository',
          repoId,
        );
        res.json({ ok: true, users });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    },
  );

  const VALID_SHARE_LEVELS = new Set(['viewer', 'editor', 'manager']);

  app.post(
    '/api/repo-review/:repositoryId/shares',
    shareGuard,
    async (req, res) => {
      try {
        const repoId = String(req.params.repositoryId);
        const { userId, accessLevel } = req.body;
        if (!userId || !accessLevel) {
          res
            .status(400)
            .json({ error: 'userId and accessLevel are required' });
          return;
        }
        if (!VALID_SHARE_LEVELS.has(accessLevel)) {
          res.status(400).json({
            error: `accessLevel must be one of: ${[...VALID_SHARE_LEVELS].join(', ')}`,
          });
          return;
        }
        const grantedBy = getTenantUserId(req);
        await grantResourceAccess(
          'review_repository',
          repoId,
          userId,
          accessLevel,
          grantedBy,
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    },
  );

  app.delete(
    '/api/repo-review/:repositoryId/shares/:userId',
    shareGuard,
    async (req, res) => {
      try {
        const repoId = String(req.params.repositoryId);
        const userId = String(req.params.userId);
        await revokeResourceAccess('review_repository', repoId, userId);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    },
  );

  app.post(
    '/api/repo-review/runs/:runId/share',
    shareGuard,
    async (req, res) => {
      try {
        const runId = String(req.params.runId);
        const { userId, accessLevel } = req.body;
        if (!userId) {
          res.status(400).json({ error: 'userId is required' });
          return;
        }
        const level = accessLevel || 'viewer';
        if (!VALID_SHARE_LEVELS.has(level)) {
          res.status(400).json({
            error: `accessLevel must be one of: ${[...VALID_SHARE_LEVELS].join(', ')}`,
          });
          return;
        }
        const grantedBy = getTenantUserId(req);
        await grantResourceAccess(
          'review_run',
          runId,
          userId,
          level,
          grantedBy,
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    },
  );

  // -- SSH Keys --

  app.get('/api/settings/ssh-keys', viewGuard, async (_req, res) => {
    try {
      const keys = await listSshKeys();
      res.json(
        keys.map((k) => ({
          id: k.id,
          name: k.name,
          fingerprint: k.fingerprint,
          keyType: k.key_type,
          isDefault: k.is_default === 1,
          createdAt: k.created_at,
        })),
      );
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post(
    '/api/settings/ssh-keys',
    createGuard,
    localInstallGuard,
    async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const privateKey = String(req.body?.privateKey || '').trim();
      if (!name || !privateKey) {
        res.status(400).json({ error: 'name and privateKey are required' });
        return;
      }
      const id = `sshkey-${crypto.randomUUID().slice(0, 8)}`;
      let keyType: string | null = null;
      if (privateKey.includes('RSA')) keyType = 'rsa';
      else if (privateKey.includes('EC')) keyType = 'ecdsa';
      else if (privateKey.includes('OPENSSH')) keyType = 'ed25519';
      let fingerprint: string | null = null;
      {
        const { execFileSync } = await import('child_process');
        const fsSync = await import('fs');
        const os = await import('os');
        const tmpPath = `${os.tmpdir()}/nanoclaw-fp-${id}`;
        try {
          fsSync.writeFileSync(tmpPath, privateKey, { mode: 0o600 });
          const out = execFileSync('ssh-keygen', ['-l', '-f', tmpPath], {
            encoding: 'utf8',
          }).trim();
          fingerprint = out.split(/\s+/).slice(0, 2).join(' ');
        } catch {
          /* fingerprint extraction is best-effort */
        } finally {
          try {
            fsSync.unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
        }
      }
      const saved = await saveSshKey({
        id,
        name,
        fingerprint,
        key_type: keyType,
        private_key: privateKey,
        public_key: null,
        is_default: 0,
      });
      res.json({
        id: saved.id,
        name: saved.name,
        fingerprint: saved.fingerprint,
        keyType: saved.key_type,
        isDefault: saved.is_default === 1,
        createdAt: saved.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    },
  );

  app.patch(
    '/api/settings/ssh-keys/:id',
    createGuard,
    localInstallGuard,
    async (req, res) => {
    try {
      const keyId = String(req.params.id);
      const existing = await getSshKeyById(keyId);
      if (!existing) {
        res.status(404).json({ error: 'SSH key not found' });
        return;
      }
      if (req.body?.isDefault) {
        await setDefaultSshKey(existing.id);
      }
      if (req.body?.name) {
        await saveSshKey({
          ...existing,
          name: String(req.body.name).trim(),
        });
      }
      const updated = await getSshKeyById(keyId);
      res.json({
        id: updated!.id,
        name: updated!.name,
        fingerprint: updated!.fingerprint,
        keyType: updated!.key_type,
        isDefault: updated!.is_default === 1,
        createdAt: updated!.created_at,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    },
  );

  app.delete(
    '/api/settings/ssh-keys/:id',
    createGuard,
    localInstallGuard,
    async (req, res) => {
    try {
      const keyId = String(req.params.id);
      const existing = await getSshKeyById(keyId);
      if (!existing) {
        res.status(404).json({ error: 'SSH key not found' });
        return;
      }
      await deleteSshKey(keyId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    },
  );
}

export function registerRepoReviewIngressRoutes(app: Express): void {
  const handler =
    (provider: ReviewRemoteProvider) =>
    async (req: RawBodyRequest, res: any) => {
      try {
        const repositoryId = decodeURIComponent(
          typeof req.params.repositoryId === 'string'
            ? req.params.repositoryId
            : '',
        );
        const repository = await getRepoReviewRepositoryRecord(repositoryId);
        if (!repository || repository.enabled !== 1) {
          res.status(404).json({ error: 'Repository not found' });
          return;
        }
        if (repository.remote_provider !== provider) {
          res.status(400).json({ error: 'Repository provider mismatch' });
          return;
        }
        const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
        // If the webhook secret is configured, we MUST have the raw body to
        // verify the HMAC signature. Re-serializing req.body with
        // JSON.stringify produces different bytes than the original payload,
        // which would silently break signature verification.
        if (!rawBody && repository.webhook_secret) {
          res.status(400).json({
            error:
              'Raw request body not available; cannot verify webhook signature. ' +
              'Ensure the server is configured to capture raw bodies.',
          });
          return;
        }
        if (
          !verifyRepoReviewWebhook({
            provider,
            repository,
            headers: req.headers,
            rawBody,
          })
        ) {
          res
            .status(403)
            .json({ error: 'Webhook signature verification failed' });
          return;
        }
        const event = parseRepoReviewWebhookEvent({
          provider,
          repositoryId,
          headers: req.headers,
          payload: req.body || {},
        });
        if (!event) {
          const ignoredReason = 'Unsupported or unrecognized webhook event';
          logger.warn(
            {
              provider,
              repositoryId,
              gitlabEvent: req.headers['x-gitlab-event'],
              githubEvent: req.headers['x-github-event'],
              giteaEvent: req.headers['x-gitea-event'],
              objectKind:
                req.body && typeof req.body === 'object'
                  ? (req.body as Record<string, unknown>).object_kind
                  : undefined,
            },
            'Repo review webhook ignored',
          );
          res.json({ ok: true, ignored: true, ignoredReason });
          return;
        }
        const enqueueResult = await enqueueRemoteRepoReview(event);
        logger.info(
          {
            provider,
            repositoryId,
            source: event.source,
            branch: event.branch,
            headSha: event.headSha,
            baseSha: event.baseSha,
            prMrNumber: event.prMrNumber,
            queued: enqueueResult.queued,
            reused: enqueueResult.reused,
            runId: enqueueResult.runId,
            reason: enqueueResult.reason,
          },
          enqueueResult.queued
            ? 'Repo review webhook queued'
            : enqueueResult.reused
              ? 'Repo review webhook reused existing review run'
              : 'Repo review webhook accepted without queueing',
        );
        if (event.branch) {
          void scheduleCodeMapRebuild(repositoryId, event.branch).catch(
            () => {},
          );
        }

        res.json({
          ok: true,
          queued: enqueueResult.queued,
          reused: enqueueResult.reused,
          runId: enqueueResult.runId,
          reason: enqueueResult.reason,
        });
      } catch (err) {
        logger.error({ err }, 'Failed to accept repo review webhook');
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Internal error',
        });
      }
    };

  app.post(
    '/webhooks/repo-reviews/github/:repositoryId',
    webhookJsonBodyParser,
    parseRawWebhookJsonBody,
    handler('github'),
  );
  app.post(
    '/webhooks/repo-reviews/gitlab/:repositoryId',
    webhookJsonBodyParser,
    parseRawWebhookJsonBody,
    handler('gitlab'),
  );
  app.post(
    '/webhooks/repo-reviews/gitea/:repositoryId',
    webhookJsonBodyParser,
    parseRawWebhookJsonBody,
    handler('gitea'),
  );
}
