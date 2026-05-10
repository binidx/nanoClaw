import { beforeAll, describe, expect, it } from 'vitest';

import type {
  RepoReviewBranchSummary,
  RepoReviewProfile,
  RepoReviewRepository,
  RepoReviewRun,
} from '../../app-types';

type BranchWorkspaceHelpersModule = typeof import('./branch-workspace-helpers');

let helpers: BranchWorkspaceHelpersModule | null = null;
let helpersImportError: unknown = null;

function makeRepository(
  overrides: Partial<RepoReviewRepository> & { id?: string } = {},
): RepoReviewRepository {
  return {
    id: overrides.id || 'repo-1',
    name: overrides.name || 'Repo',
    language: overrides.language || 'TypeScript',
    localRepoPath: overrides.localRepoPath || '/tmp/repo',
    remoteProvider: overrides.remoteProvider || 'github',
    remoteRepoSlug: overrides.remoteRepoSlug || 'org/repo',
    remoteBaseUrl: overrides.remoteBaseUrl || 'https://github.com',
    cloneUrl: overrides.cloneUrl || 'git@github.com:org/repo.git',
    defaultTargetBranch: overrides.defaultTargetBranch || 'main',
    targetBranches: overrides.targetBranches,
    reviewChatJid: overrides.reviewChatJid || '',
    actorMentionMappings: overrides.actorMentionMappings || [],
    reviewerUsernames: overrides.reviewerUsernames,
    autoSyncEnabled: overrides.autoSyncEnabled || false,
    autoSyncIntervalMinutes: overrides.autoSyncIntervalMinutes || 30,
    lastAutoSyncAt: overrides.lastAutoSyncAt || '',
    nextAutoSyncAt: overrides.nextAutoSyncAt || '',
    lastAutoSyncStatus: overrides.lastAutoSyncStatus || '',
    lastAutoSyncMessage: overrides.lastAutoSyncMessage || '',
    enabled: overrides.enabled ?? true,
    hasWebhookSecret: overrides.hasWebhookSecret || false,
    hasPlatformToken: overrides.hasPlatformToken || false,
    webhookSecretPreview: overrides.webhookSecretPreview,
    platformTokenPreview: overrides.platformTokenPreview,
  };
}

function makeProfile(
  overrides: Partial<RepoReviewProfile> & { id: string } ,
): RepoReviewProfile {
  return {
    id: overrides.id,
    repositoryId: overrides.repositoryId || 'repo-1',
    name: overrides.name || overrides.id,
    stage: overrides.stage || 'push',
    sourceMode: overrides.sourceMode || 'remote',
    blockingMode: overrides.blockingMode || 'soft_fail',
    passDecisionMode: overrides.passDecisionMode || 'ai',
    reviewScope: overrides.reviewScope || 'compare',
    targetBranches: overrides.targetBranches || [],
    skillIds: overrides.skillIds || [],
    mcpServerIds: overrides.mcpServerIds || [],
    promptTemplate: overrides.promptTemplate || '',
    includeGlobs: overrides.includeGlobs || [],
    excludeGlobs: overrides.excludeGlobs || [],
    includeFullFileContext: overrides.includeFullFileContext || false,
    maxFiles: overrides.maxFiles || 50,
    maxDiffBytes: overrides.maxDiffBytes || 200_000,
    writeToChat: overrides.writeToChat || false,
    writeToPlatform: overrides.writeToPlatform || false,
    reviewOutputMode: overrides.reviewOutputMode || 'message',
    enabled: overrides.enabled ?? true,
  };
}

function makeBranch(
  overrides: Partial<RepoReviewBranchSummary> & { name: string },
): RepoReviewBranchSummary {
  return {
    name: overrides.name,
    headSha: overrides.headSha || `${overrides.name}-sha`,
    parentSha: overrides.parentSha || 'parent-sha',
    actor: overrides.actor || 'alice',
    title: overrides.title || `${overrides.name} title`,
    latestCommitAt: overrides.latestCommitAt || '2026-03-23T10:00:00.000Z',
    defaultBranch: overrides.defaultBranch || false,
  };
}

function makeRun(
  overrides: Partial<RepoReviewRun> & { id: string; branch?: string },
): RepoReviewRun {
  return {
    id: overrides.id,
    repositoryId: overrides.repositoryId || 'repo-1',
    profileId: overrides.profileId || 'profile-1',
    source: overrides.source || 'github',
    stage: overrides.stage || 'push',
    status: overrides.status || 'completed',
    overall: overrides.overall || 'pass',
    passDecisionMode: overrides.passDecisionMode || 'ai',
    recommendedBlock: overrides.recommendedBlock || false,
    blockingEnforced: overrides.blockingEnforced || false,
    ref: overrides.ref || '',
    branch: overrides.branch || 'main',
    baseSha: overrides.baseSha || 'base',
    headSha: overrides.headSha || `${overrides.branch || 'main'}-head`,
    prMrNumber: overrides.prMrNumber || '',
    actor: overrides.actor || 'alice',
    summary: overrides.summary || '',
    resultState: overrides.resultState,
    baselineSource: overrides.baselineSource,
    baselineRef: overrides.baselineRef,
    baselineLabel: overrides.baselineLabel,
    idempotencyKey: overrides.idempotencyKey,
    findings: overrides.findings || [],
    reviewTurns: overrides.reviewTurns || [],
    commitDetails: overrides.commitDetails || [],
    commitReviews: overrides.commitReviews || [],
    suggestions: overrides.suggestions || [],
    changedFiles: overrides.changedFiles || [],
    diffBytes: overrides.diffBytes || 0,
    durationMs: overrides.durationMs,
    platformStatus: overrides.platformStatus || '',
    platformCommentUrl: overrides.platformCommentUrl || '',
    platformCommentId: overrides.platformCommentId,
    chatDeliveryStatus: overrides.chatDeliveryStatus,
    platformStatusDeliveryStatus: overrides.platformStatusDeliveryStatus,
    platformCommentDeliveryStatus: overrides.platformCommentDeliveryStatus,
    lastDeliveryError: overrides.lastDeliveryError,
    deliveryRetryCount: overrides.deliveryRetryCount,
    effectiveRules: overrides.effectiveRules,
    manualDecision: overrides.manualDecision || '',
    manualDecisionBy: overrides.manualDecisionBy || '',
    manualDecisionAt: overrides.manualDecisionAt || '',
    error: overrides.error || '',
    startedAt: overrides.startedAt || '',
    completedAt: overrides.completedAt || '',
    createdAt: overrides.createdAt || '2026-03-23T10:00:00.000Z',
    updatedAt:
      overrides.updatedAt ||
      overrides.completedAt ||
      overrides.createdAt ||
      '2026-03-23T10:00:00.000Z',
  };
}

beforeAll(async () => {
  try {
    helpers = await import('./branch-workspace-helpers');
  } catch (error) {
    helpers = null;
    helpersImportError = error;
  }
});

function requireHelpers(): BranchWorkspaceHelpersModule {
  if (helpers) return helpers;
  const detail =
    helpersImportError instanceof Error
      ? `${helpersImportError.name}: ${helpersImportError.message}`
      : String(helpersImportError);
  throw new Error(`Failed to import branch-workspace-helpers: ${detail}`);
}

describe('branch workspace helpers', () => {
  it('filters normalized rows by branch search across branch metadata', () => {
    const { filterBranchWorkspaceRows, normalizeBranchWorkspaceRows } =
      requireHelpers();
    const rows = normalizeBranchWorkspaceRows({
      repository: makeRepository(),
      remoteBranches: [
        makeBranch({ name: 'main', defaultBranch: true }),
        makeBranch({
          name: 'feature/login-flow',
          actor: 'zoe',
          title: 'Login fixes',
        }),
      ],
      runs: [
        makeRun({
          id: 'run-login',
          branch: 'feature/login-flow',
          summary: 'Fix login edge cases',
        }),
      ],
      pushProfiles: [makeProfile({ id: 'profile-1', targetBranches: [] })],
    });

    expect(
      filterBranchWorkspaceRows(rows, {
        search: 'login edge',
        status: 'all',
      }).map((row) => row.name),
    ).toEqual(['feature/login-flow']);
  });

  it('filters normalized rows by review outcome status', () => {
    const { filterBranchWorkspaceRows, normalizeBranchWorkspaceRows } =
      requireHelpers();
    const rows = normalizeBranchWorkspaceRows({
      repository: makeRepository(),
      remoteBranches: [
        makeBranch({ name: 'main', defaultBranch: true }),
        makeBranch({ name: 'release/failing' }),
      ],
      runs: [
        makeRun({
          id: 'run-main',
          branch: 'main',
          overall: 'pass',
        }),
        makeRun({
          id: 'run-failing',
          branch: 'release/failing',
          overall: 'fail',
          summary: 'Release blockers',
        }),
      ],
      pushProfiles: [],
    });

    expect(
      filterBranchWorkspaceRows(rows, { search: '', status: 'fail' }).map(
        (row) => row.name,
      ),
    ).toEqual(['release/failing']);
  });

  it('marks and filters pending manual review branches from completed human-review runs', () => {
    const { filterBranchWorkspaceRows, normalizeBranchWorkspaceRows } =
      requireHelpers();
    const rows = normalizeBranchWorkspaceRows({
      repository: makeRepository(),
      remoteBranches: [
        makeBranch({ name: 'main', defaultBranch: true }),
        makeBranch({ name: 'feature/manual' }),
        makeBranch({ name: 'feature/manual-decided' }),
      ],
      runs: [
        makeRun({
          id: 'run-manual-pending',
          branch: 'feature/manual',
          passDecisionMode: 'human',
          manualDecision: '',
          status: 'completed',
          overall: 'warn',
        }),
        makeRun({
          id: 'run-manual-complete',
          branch: 'feature/manual-decided',
          passDecisionMode: 'human',
          manualDecision: 'pass',
          status: 'completed',
          overall: 'warn',
        }),
      ],
      pushProfiles: [],
    });

    expect(rows.find((row) => row.name === 'feature/manual')?.pendingManual).toBe(
      true,
    );
    expect(
      filterBranchWorkspaceRows(rows, {
        search: '',
        status: 'pending_manual',
      }).map((row) => row.name),
    ).toEqual(['feature/manual']);
  });

  it('selects the latest run summary per branch even when the input order is stale-first', () => {
    const { normalizeBranchWorkspaceRows } = requireHelpers();
    const rows = normalizeBranchWorkspaceRows({
      repository: makeRepository(),
      remoteBranches: [makeBranch({ name: 'feature/summary' })],
      runs: [
        makeRun({
          id: 'run-older',
          branch: 'feature/summary',
          summary: 'Older summary',
          createdAt: '2026-03-22T09:00:00.000Z',
          completedAt: '2026-03-22T09:10:00.000Z',
          updatedAt: '2026-03-22T09:10:00.000Z',
        }),
        makeRun({
          id: 'run-latest',
          branch: 'feature/summary',
          summary: 'Latest summary',
          createdAt: '2026-03-24T11:00:00.000Z',
          completedAt: '2026-03-24T11:05:00.000Z',
          updatedAt: '2026-03-24T11:05:00.000Z',
          overall: 'warn',
        }),
      ],
      pushProfiles: [],
    });

    const row = rows.find((entry) => entry.name === 'feature/summary');

    expect(row).toMatchObject({
      name: 'feature/summary',
      latestSummary: 'Latest summary',
      status: 'warn',
    });
    expect(row?.lastRun?.id).toBe('run-latest');
    expect(row?.latestActivityAt).toBe('2026-03-24T11:05:00.000Z');
  });

  it('paginates filtered rows without reordering them and clamps oversized pages', () => {
    const { paginateBranchWorkspaceRows } = requireHelpers();
    const rows = [
      { name: 'branch-1' },
      { name: 'branch-2' },
      { name: 'branch-3' },
      { name: 'branch-4' },
      { name: 'branch-5' },
    ];

    const secondPage = paginateBranchWorkspaceRows(rows, {
      page: 2,
      pageSize: 2,
    });
    const clampedPage = paginateBranchWorkspaceRows(rows, {
      page: 99,
      pageSize: 2,
    });

    expect(secondPage.items.map((row) => row.name)).toEqual([
      'branch-3',
      'branch-4',
    ]);
    expect(secondPage.page).toBe(2);
    expect(clampedPage.items.map((row) => row.name)).toEqual(['branch-5']);
    expect(clampedPage.page).toBe(3);
  });

  it('uses startedAt as latest activity for active runs when it is newer than remote activity', () => {
    const { normalizeBranchWorkspaceRows } = requireHelpers();
    const rows = normalizeBranchWorkspaceRows({
      repository: makeRepository({
        defaultTargetBranch: 'feature/live-run',
      }),
      remoteBranches: [
        makeBranch({
          name: 'feature/live-run',
          latestCommitAt: '2026-03-24T10:00:00.000Z',
        }),
        makeBranch({
          name: 'feature/older',
          latestCommitAt: '2026-03-24T10:30:00.000Z',
        }),
      ],
      runs: [
        makeRun({
          id: 'run-live',
          branch: 'feature/live-run',
          status: 'running',
          overall: '',
          createdAt: '2026-03-24T09:00:00.000Z',
          startedAt: '2026-03-24T11:00:00.000Z',
          completedAt: '',
          updatedAt: '2026-03-24T09:00:00.000Z',
          summary: 'Still reviewing',
        }),
      ],
      pushProfiles: [],
    });

    expect(rows.map((row) => row.name).slice(0, 2)).toEqual([
      'feature/live-run',
      'feature/older',
    ]);

    const row = rows.find((entry) => entry.name === 'feature/live-run');
    expect(row?.latestActivityAt).toBe('2026-03-24T11:00:00.000Z');
    expect(row?.lastRun?.id).toBe('run-live');
  });
});
