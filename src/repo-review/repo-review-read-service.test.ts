import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('repo-review-read-service', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const db = await import('../db.js');
    db._initTestDatabase();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists lightweight run summaries with server-side filters', async () => {
    vi.setSystemTime(new Date('2026-03-22T10:00:00.000Z'));
    const {
      createReviewRun,
      saveReviewProfile,
      saveReviewRepository,
      updateReviewRun,
    } = await import('../db.js');
    const { listRepoReviewRunSummaries } =
      await import('./repo-review-read-service.js');

    saveReviewRepository({
      id: 'repo-alpha',
      name: 'Alpha Repo',
      language: 'TypeScript',
      local_repo_path: null,
      remote_provider: null,
      remote_repo_slug: null,
      remote_base_url: null,
      clone_url: null,
      default_target_branch: 'main',
      review_chat_jid: null,
      local_hook_secret: null,
      webhook_secret: null,
      platform_token: null,
      enabled: true,
    });
    saveReviewProfile({
      id: 'profile-alpha',
      repository_id: 'repo-alpha',
      name: 'Push Review',
      stage: 'push',
      source_mode: 'remote',
      blocking_mode: 'soft_fail',
      pass_decision_mode: 'human',
      review_scope: 'commit_range',
      target_branches: ['main'],
      skill_ids: [],
      mcp_server_ids: [],
      prompt_template: null,
      include_globs: [],
      exclude_globs: [],
      max_files: 80,
      max_diff_bytes: 200000,
      write_to_chat: true,
      write_to_platform: true,
      enabled: true,
    });
    createReviewRun({
      id: 'run-pass',
      repository_id: 'repo-alpha',
      profile_id: 'profile-alpha',
      source: 'github',
      stage: 'push',
      status: 'completed',
      branch: 'main',
      head_sha: 'abcdef123456',
      actor: 'alice',
    });
    updateReviewRun('run-pass', {
      overall: 'pass',
      summary: 'login flow looks good',
    });

    vi.setSystemTime(new Date('2026-03-22T10:05:00.000Z'));
    createReviewRun({
      id: 'run-running',
      repository_id: 'repo-alpha',
      profile_id: 'profile-alpha',
      source: 'github',
      stage: 'push',
      status: 'running',
      branch: 'feature/search',
      head_sha: 'fedcba654321',
      actor: 'bob',
    });
    updateReviewRun('run-running', {
      summary: 'search indexing still running',
      callback_context: {
        reviewProgress: {
          turnCount: 2,
          latestAssistantText: '正在收敛跨文件结论。',
          latestErrorText: null,
          hasTerminalOutput: true,
        },
      },
    });

    vi.setSystemTime(new Date('2026-03-22T10:10:00.000Z'));
    updateReviewRun('run-pass', {
      summary: 'login flow looks good after latest rerun',
    });

    const allRuns = await listRepoReviewRunSummaries();
    expect(allRuns).toHaveLength(2);
    expect(allRuns.map((run) => run.id)).toEqual(['run-pass', 'run-running']);
    expect(allRuns[0]?.reviewTurns).toEqual([]);
    expect(allRuns[1]?.reviewProgress).toMatchObject({
      turnCount: 2,
      latestAssistantText: '正在收敛跨文件结论。',
      latestErrorText: null,
      hasTerminalOutput: true,
    });
    expect(allRuns[0]?.commitDetails).toEqual([]);
    expect(allRuns[0]?.passDecisionMode).toBe('human');

    const statusFiltered = await listRepoReviewRunSummaries({
      status: 'running',
    });
    expect(statusFiltered.map((run) => run.id)).toEqual(['run-running']);

    const keywordFiltered = await listRepoReviewRunSummaries({
      keyword: 'Alpha Repo',
    });
    expect(keywordFiltered).toHaveLength(2);

    const summaryFiltered = await listRepoReviewRunSummaries({
      keyword: 'latest rerun',
    });
    expect(summaryFiltered.map((run) => run.id)).toEqual(['run-pass']);
  });

  it('lists digest runs and returns digest run detail payloads', async () => {
    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    const { saveDigestRun, saveReviewRepository, updateDigestRun } =
      await import('../db.js');
    const { getRepoReviewDigestRunDetailRead, listRepoReviewDigestRunsRead } =
      await import('./repo-review-read-service.js');

    await saveReviewRepository({
      id: 'repo-digest',
      name: 'Digest Repo',
      language: 'TypeScript',
      default_target_branch: 'main',
      enabled: true,
      digest_daily_enabled: true,
    });

    await saveDigestRun({
      id: 'digest-run-1',
      repository_id: 'repo-digest',
      type: 'daily',
      scheduled_for: '2026-04-24T10:00:00.000Z',
      period_start: '2026-04-23T10:00:00.000Z',
      period_end: '2026-04-24T10:00:00.000Z',
      status: 'running',
      timezone: 'Asia/Shanghai',
      started_at: '2026-04-24T10:00:02.000Z',
    });
    await updateDigestRun('digest-run-1', {
      status: 'completed',
      branch_count: 3,
      commit_count: 9,
      contributor_count: 2,
      summary: 'digest summary',
      delivery_status: 'failed',
      delivery_error: 'chat delivery failed',
      completed_at: '2026-04-24T10:05:02.000Z',
      duration_ms: 300000,
    });

    const runs = await listRepoReviewDigestRunsRead('repo-digest');
    expect(runs).toEqual([
      expect.objectContaining({
        id: 'digest-run-1',
        repositoryId: 'repo-digest',
        timezone: 'Asia/Shanghai',
        deliveryStatus: 'failed',
        deliveryError: 'chat delivery failed',
        durationMs: 300000,
      }),
    ]);

    const detail = await getRepoReviewDigestRunDetailRead('digest-run-1');
    expect(detail).toMatchObject({
      run: {
        id: 'digest-run-1',
        branchCount: 3,
        commitCount: 9,
      },
      repository: {
        id: 'repo-digest',
        name: 'Digest Repo',
      },
    });
  });

  it('keeps user-scoped overview runs from being displaced by hidden repositories', async () => {
    vi.setSystemTime(new Date('2026-04-25T10:00:00.000Z'));
    const {
      createReviewRun,
      saveReviewRepository,
      upsertReviewRepositoryMember,
    } = await import('../db.js');
    const { getRepoReviewOverviewRead } =
      await import('./repo-review-read-service.js');

    await saveReviewRepository({
      id: 'repo-visible',
      name: 'Visible Repo',
      language: 'TypeScript',
      default_target_branch: 'main',
      enabled: true,
    });
    await saveReviewRepository({
      id: 'repo-hidden',
      name: 'Hidden Repo',
      language: 'TypeScript',
      default_target_branch: 'main',
      enabled: true,
    });
    await upsertReviewRepositoryMember(
      'repo-visible',
      'user-visible',
      'viewer',
      null,
    );

    createReviewRun({
      id: 'run-visible-old',
      repository_id: 'repo-visible',
      source: 'github',
      stage: 'push',
      status: 'completed',
      branch: 'main',
      actor: 'alice',
    });

    for (let index = 0; index < 101; index++) {
      vi.setSystemTime(new Date(2026, 3, 25, 10, 1, index));
      createReviewRun({
        id: `run-hidden-${index}`,
        repository_id: 'repo-hidden',
        source: 'github',
        stage: 'push',
        status: 'completed',
        branch: 'main',
        actor: 'hidden',
      });
    }

    const overview = await getRepoReviewOverviewRead(undefined, 'user-visible');
    expect(overview.repositories.map((repo) => repo.id)).toEqual([
      'repo-visible',
    ]);
    expect(overview.runs.map((run) => run.id)).toEqual(['run-visible-old']);
  });
});
