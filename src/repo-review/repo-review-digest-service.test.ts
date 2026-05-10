import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIMEZONE } from '../config.js';

const mockRunAgentProcess = vi.fn();

vi.mock('../agent-runner.js', () => ({
  runAgentProcess: (...args: unknown[]) => mockRunAgentProcess(...args),
}));

vi.mock('../config-store.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config-store.js')>(
      '../config-store.js',
    );
  return {
    ...actual,
    getAssistantName: () => 'NanoClaw',
  };
});

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

describe('repo-review-digest-service', () => {
  let tempRepo = '';

  beforeEach(async () => {
    vi.useFakeTimers();
    mockRunAgentProcess.mockReset();
    const db = await import('../db.js');
    db._initTestDatabase();

    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-digest-repo-'));
    runGit(tempRepo, ['init']);
    runGit(tempRepo, ['branch', '-m', 'main']);
    runGit(tempRepo, ['config', 'user.name', 'alice']);
    runGit(tempRepo, ['config', 'user.email', 'alice@example.com']);
    fs.writeFileSync(path.join(tempRepo, 'demo.ts'), 'export const demo = 1;\n');
    runGit(tempRepo, ['add', 'demo.ts']);
    runGit(tempRepo, ['commit', '-m', 'feat: add digest source']);
  });

  afterEach(async () => {
    vi.useRealTimers();
    fs.rmSync(tempRepo, { recursive: true, force: true });
    const { setDigestMessageSender } = await import('./repo-review-digest-service.js');
    setDigestMessageSender(null);
  });

  it('computes next digest slots in the configured timezone instead of host local time', async () => {
    const { computeNextDigestAt } = await import('./repo-review-digest-service.js');

    expect(
      computeNextDigestAt(
        'daily',
        18,
        undefined,
        new Date('2026-04-24T11:00:00.000Z'),
        'Asia/Shanghai',
      ),
    ).toBe('2026-04-25T10:00:00.000Z');

    expect(
      computeNextDigestAt(
        'weekly',
        18,
        5,
        new Date('2026-04-24T11:00:00.000Z'),
        'Asia/Shanghai',
      ),
    ).toBe('2026-05-01T10:00:00.000Z');
  });

  it('persists scheduled slot, period window, timezone and delivery failures for digest runs', async () => {
    vi.setSystemTime(new Date('2026-04-24T10:04:00.000Z'));
    const { saveReviewRepository, getDigestRunById } = await import('../db.js');
    const {
      executeDigest,
      setDigestMessageSender,
    } = await import('./repo-review-digest-service.js');

    mockRunAgentProcess.mockResolvedValue({
      status: 'success',
      result: 'digest body',
    });
    setDigestMessageSender(async () => {
      throw new Error('chat delivery failed');
    });

    const repository = await saveReviewRepository({
      id: 'repo-digest',
      name: 'Digest Repo',
      language: 'TypeScript',
      local_repo_path: tempRepo,
      default_target_branch: 'main',
      review_chat_jid: 'web:digest-room',
      digest_daily_enabled: true,
      digest_daily_hour: 18,
      enabled: true,
    });

    const run = await executeDigest(
      repository,
      'daily',
      '2026-04-24T10:00:00.000Z',
    );
    expect(run).toBeTruthy();

    const persisted = await getDigestRunById(run!.id);
    expect(persisted).toMatchObject({
      scheduled_for: '2026-04-24T10:00:00.000Z',
      period_start: '2026-04-23T10:00:00.000Z',
      period_end: '2026-04-24T10:00:00.000Z',
      timezone: TIMEZONE,
      status: 'completed',
      delivery_status: 'failed',
      delivery_error: 'chat delivery failed',
    });
    expect(Number(persisted?.duration_ms || 0)).toBeGreaterThanOrEqual(0);
  });

  it('builds a digest prompt with explicit repo and time-window metadata', async () => {
    const { buildDigestPrompt } = await import('./repo-review-digest-service.js');

    const prompt = await buildDigestPrompt({
      repositoryName: 'Digest Repo',
      periodStart: '2026-04-23T10:00:00.000Z',
      periodEnd: '2026-04-24T10:00:00.000Z',
      type: 'daily',
      branches: [
        {
          name: 'main',
          commitCount: 2,
          contributors: ['alice'],
          commitsByCategory: {
            feature: 1,
            fix: 1,
            refactor: 0,
            perf: 0,
            docs: 0,
            test: 0,
            chore: 0,
            other: 0,
          },
          commitMessages: ['feat: add digest source', 'fix: tidy digest prompt'],
        },
      ],
      totalCommits: 2,
      totalContributors: ['alice'],
      sampledCommits: [],
      categorySummary: {
        feature: 1,
        fix: 1,
        refactor: 0,
        perf: 0,
        docs: 0,
        test: 0,
        chore: 0,
        other: 0,
      },
      defaultBranch: 'main',
    } as any);

    expect(prompt).toContain('Digest Repo');
    expect(prompt).toContain('2026-04-23');
    expect(prompt).toContain('2026-04-24');
    expect(prompt).toContain('main');
    expect(prompt).toContain('2');
    expect(prompt).not.toMatch(/auto_[0-9a-f]{6}/);
  });
});
