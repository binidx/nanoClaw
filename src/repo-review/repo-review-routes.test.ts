import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getRepoReviewDigestRunDetailReadMock,
  getRepoReviewOverviewReadMock,
  listRepoReviewDigestRunsReadMock,
  listRepoReviewRunSummariesResultMock,
} = vi.hoisted(() => ({
  getRepoReviewDigestRunDetailReadMock: vi.fn(async () => null),
  getRepoReviewOverviewReadMock: vi.fn(async () => ({
    repositories: [
      {
        id: 'repo-main',
        name: 'main',
      },
    ],
    profiles: [
      {
        id: 'profile-main',
        name: '默认审查',
      },
    ],
    runs: [],
  })),
  listRepoReviewRunSummariesResultMock: vi.fn(async () => ({
    runs: [],
    total: 0,
  })),
  listRepoReviewDigestRunsReadMock: vi.fn(async () => []),
}));

vi.mock('./repo-review-read-service.js', () => ({
  getRepoReviewDigestRunDetailRead: getRepoReviewDigestRunDetailReadMock,
  getRepoReviewOverviewRead: getRepoReviewOverviewReadMock,
  listRepoReviewDigestRunsRead: listRepoReviewDigestRunsReadMock,
  listRepoReviewRunSummariesResult: listRepoReviewRunSummariesResultMock,
}));

vi.mock('../auth/permission-engine.js', () => ({
  grantResourceAccess: vi.fn(),
  revokeResourceAccess: vi.fn(),
  listResourceAccessUsers: vi.fn(async () => []),
  getUserEffectivePermissions: vi.fn(async () => [
    'review.create',
    'review.view',
    'review.manual',
    'review.annotate',
  ]),
}));

vi.mock('../tenant/tenant-request.js', () => ({
  getTenantUserId: vi.fn(() => 'test-user'),
}));

vi.mock('../user/user-service.js', () => ({
  ensureUserByUsername: vi.fn(async (username: string) => ({
    id: username === 'admin' ? 'admin-user' : 'test-user',
    username,
    status: 'active',
  })),
  getUserById: vi.fn(async (id: string) => ({
    id,
    username: id,
    status: 'active',
  })),
  getUserByUsername: vi.fn(async (username: string) => ({
    id: username === 'admin' ? 'admin-user' : 'test-user',
    username,
    status: 'active',
  })),
}));

vi.mock('./repo-review-service.js', () => ({
  cancelRepoReviewRun: vi.fn(),
  decideRepoReviewRunByHuman: vi.fn(),
  enqueueRemoteRepoReview: vi.fn(),
  getRepoReviewRunDetail: vi.fn(),
  inspectRepoReviewRepositoryCandidate: vi.fn(() => ({})),
  listRepoReviewChatMembers: vi.fn(async () => []),
  listRepoReviewBranchStatesForRepository: vi.fn(async () => []),
  listRepoReviewRemoteBranchCommits: vi.fn(async () => []),
  getRepoReviewRepositoryRecord: vi.fn(),
  getRepoReviewRun: vi.fn(),
  installRepoReviewHooks: vi.fn(),
  listRepoReviewRemoteBranches: vi.fn(async () => []),
  listRepoReviewProfiles: vi.fn(async () => []),
  listRepoReviewRepositories: vi.fn(async () => []),
  listRepoReviewRuns: vi.fn(async () => []),
  parseRepoReviewWebhookEvent: vi.fn(),
  REPO_REVIEW_PERMISSION_DENIED_MESSAGE: 'permission denied',
  removeRepoReviewProfile: vi.fn(),
  removeRepoReviewRepository: vi.fn(),
  saveRepoReviewProfileConfig: vi.fn(),
  queueRemoteBranchReview: vi.fn(),
  queueRemoteRepoReview: vi.fn(),
  triggerLocalRepoReview: vi.fn(),
  uninstallRepoReviewHooks: vi.fn(),
  saveRepoReviewRepositoryConfig: vi.fn(),
  verifyRepoReviewWebhook: vi.fn(),
}));

import { registerRepoReviewAdminRoutes } from '../routes/repo-review-routes.js';
import * as repoReviewService from './repo-review-service.js';

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

describe('repo review routes', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('accepts repository.view as a read-only compatibility permission for repo review pages', () => {
    const app = express();
    const requirePermission = vi.fn(() => async (_req, _res, next) => {
      next();
    });

    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => 'admin'),
      requirePermission,
    });

    expect(requirePermission).toHaveBeenNthCalledWith(
      1,
      'review.view',
      'review.repo.view',
      'repository.view',
    );
  });

  it('awaits async overview and summary readers before serializing responses', async () => {
    const app = express();
    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => null),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const [overviewResponse, summaryResponse] = await Promise.all([
        fetch(`${baseUrl}/api/repo-reviews`),
        fetch(`${baseUrl}/api/repo-reviews/runs-summary`),
      ]);

      expect(await overviewResponse.json()).toEqual({
        repositories: [
          {
            id: 'repo-main',
            name: 'main',
          },
        ],
        profiles: [
          {
            id: 'profile-main',
            name: '默认审查',
          },
        ],
        runs: [],
      });
      expect(await summaryResponse.json()).toEqual({
        runs: [],
        total: 0,
      });
    });
  });

  it('serves digest run lists and details from read-service readers', async () => {
    listRepoReviewDigestRunsReadMock.mockResolvedValueOnce([
      {
        id: 'digest-1',
        repositoryId: 'repo-main',
        type: 'daily',
        status: 'completed',
        timezone: 'Asia/Shanghai',
        scheduledFor: '2026-04-24T10:00:00.000Z',
        periodStart: '2026-04-23T10:00:00.000Z',
        periodEnd: '2026-04-24T10:00:00.000Z',
        startedAt: '2026-04-24T10:00:02.000Z',
        completedAt: '2026-04-24T10:04:02.000Z',
        durationMs: 240000,
        branchCount: 2,
        commitCount: 12,
        contributorCount: 3,
        summary: 'digest summary',
        cloudDocUrl: '',
        cloudDocStatus: '',
        deliveryStatus: 'delivered',
        deliveryError: '',
        errorMessage: '',
        createdAt: '2026-04-24T10:00:02.000Z',
      },
    ]);
    getRepoReviewDigestRunDetailReadMock.mockResolvedValueOnce({
      run: {
        id: 'digest-1',
        repositoryId: 'repo-main',
        type: 'daily',
        status: 'completed',
        timezone: 'Asia/Shanghai',
        scheduledFor: '2026-04-24T10:00:00.000Z',
        periodStart: '2026-04-23T10:00:00.000Z',
        periodEnd: '2026-04-24T10:00:00.000Z',
        startedAt: '2026-04-24T10:00:02.000Z',
        completedAt: '2026-04-24T10:04:02.000Z',
        durationMs: 240000,
        branchCount: 2,
        commitCount: 12,
        contributorCount: 3,
        summary: 'digest summary',
        cloudDocUrl: '',
        cloudDocStatus: '',
        deliveryStatus: 'delivered',
        deliveryError: '',
        errorMessage: '',
        createdAt: '2026-04-24T10:00:02.000Z',
      },
      repository: {
        id: 'repo-main',
        name: 'main',
      },
    });

    const app = express();
    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => 'admin'),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const [listResponse, detailResponse] = await Promise.all([
        fetch(`${baseUrl}/api/repo-reviews/repositories/repo-main/digest-runs`),
        fetch(`${baseUrl}/api/repo-reviews/digest-runs/digest-1`),
      ]);

      expect(await listResponse.json()).toEqual({
        runs: [
          expect.objectContaining({
            id: 'digest-1',
            repositoryId: 'repo-main',
            timezone: 'Asia/Shanghai',
          }),
        ],
      });
      expect(await detailResponse.json()).toEqual({
        run: expect.objectContaining({
          id: 'digest-1',
          status: 'completed',
        }),
        repository: expect.objectContaining({
          id: 'repo-main',
        }),
      });
    });

    expect(listRepoReviewDigestRunsReadMock).toHaveBeenCalledWith(
      'repo-main',
      undefined,
    );
    expect(getRepoReviewDigestRunDetailReadMock).toHaveBeenCalledWith(
      'digest-1',
    );
  });

  it('passes current tenant userId into local review triggers', async () => {
    vi.mocked(repoReviewService.triggerLocalRepoReview).mockResolvedValue({
      blocked: false,
      message: 'ok',
      runs: [],
    });

    const app = express();
    app.use(express.json());
    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => null),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/trigger`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'commit' }),
        },
      );
      expect(response.status).toBe(200);
    });

    expect(repoReviewService.triggerLocalRepoReview).toHaveBeenCalledWith({
      repositoryId: 'repo-main',
      stage: 'commit',
      userId: 'test-user',
    });
  });

  it('passes current tenant userId into remote sync requests', async () => {
    vi.mocked(repoReviewService.queueRemoteRepoReview).mockResolvedValue({
      repository: {
        id: 'repo-main',
        name: 'main',
      } as never,
      provider: 'github',
      branches: [],
      summary: {
        branches: [],
        triggered: 0,
        skipped: 0,
        failed: 0,
        skippedReasons: [],
        errorReasons: [],
        activeWindowDays: 0,
      },
    });
    vi.mocked(repoReviewService.queueRemoteBranchReview).mockResolvedValue({
      queued: true,
      branch: 'feature/x',
      headSha: 'head',
      reused: false,
      usedCachedBranchSummary: false,
    });

    const app = express();
    app.use(express.json());
    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => null),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
    });

    await withServer(app, async (baseUrl) => {
      const syncRemote = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/sync-remote`,
        { method: 'POST' },
      );
      expect(syncRemote.status).toBe(200);

      const syncBranch = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/sync-branch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: 'feature/x' }),
        },
      );
      expect(syncBranch.status).toBe(200);
    });

    expect(repoReviewService.queueRemoteRepoReview).toHaveBeenCalledWith({
      repositoryId: 'repo-main',
      userId: 'test-user',
    });
    expect(repoReviewService.queueRemoteBranchReview).toHaveBeenCalledWith({
      repositoryId: 'repo-main',
      userId: 'test-user',
      branch: 'feature/x',
      baselineMode: undefined,
      baselineRunId: undefined,
      baselineSha: undefined,
      reviewMode: undefined,
      allowRepeat: false,
    });
  });

  it('blocks local install actions but allows manual branch review when local install capability is denied', async () => {
    const app = express();
    app.use(express.json());
    registerRepoReviewAdminRoutes(app, {
      auditMutation: vi.fn(),
      getAuthenticatedUsername: vi.fn(() => null),
      requirePermission: vi.fn(() => async (_req, _res, next) => {
        next();
      }),
      requireLocalCapability: () => (_req, res) => {
        res.status(403).json({
          error: 'Local capability unavailable',
          capability: 'localInstall',
          reason: 'permission_denied',
        });
      },
    });

    await withServer(app, async (baseUrl) => {
      const hookResponse = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/hooks/install`,
        { method: 'POST' },
      );
      expect(hookResponse.status).toBe(403);

      const syncResponse = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/sync-remote`,
        { method: 'POST' },
      );
      expect(syncResponse.status).toBe(403);

      const syncBranchResponse = await fetch(
        `${baseUrl}/api/repo-reviews/repositories/repo-main/sync-branch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: 'feature/manual-review' }),
        },
      );
      expect(syncBranchResponse.status).toBe(200);

      const sshKeyResponse = await fetch(`${baseUrl}/api/settings/ssh-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'deploy-key',
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
        }),
      });
      expect(sshKeyResponse.status).toBe(403);
    });

    expect(repoReviewService.queueRemoteBranchReview).toHaveBeenCalledWith({
      repositoryId: 'repo-main',
      userId: 'test-user',
      branch: 'feature/manual-review',
      baselineMode: undefined,
      baselineRunId: undefined,
      baselineSha: undefined,
      reviewMode: undefined,
      allowRepeat: false,
    });
  });
});
