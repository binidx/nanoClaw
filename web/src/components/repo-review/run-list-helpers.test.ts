import { describe, expect, it } from 'vitest';

import type { RepoReviewRun } from '../../app-types';
import {
  applyRepoReviewRealtimeEventToRun,
  getRepoReviewRunChatJid,
  mergeFetchedRepoReviewRunSnapshot,
  mergeRepoReviewRunListSnapshots,
  mergeRepoReviewRunSnapshot,
  sortRepoReviewRunsByLatestActivity,
} from './run-list-helpers';

function makeRun(
  overrides: Partial<RepoReviewRun> & { id: string },
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
    headSha: overrides.headSha || 'head',
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
    reviewProgress: overrides.reviewProgress,
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
    createdAt: overrides.createdAt || '2026-03-22T10:00:00.000Z',
    updatedAt:
      overrides.updatedAt ||
      overrides.createdAt ||
      '2026-03-22T10:00:00.000Z',
  };
}

describe('repo review run list helpers', () => {
  it('sorts recent runs by latest activity time descending', () => {
    const runs = sortRepoReviewRunsByLatestActivity([
      makeRun({
        id: 'older',
        createdAt: '2026-03-22T09:00:00.000Z',
        updatedAt: '2026-03-22T09:10:00.000Z',
      }),
      makeRun({
        id: 'newer',
        createdAt: '2026-03-23T09:00:00.000Z',
        updatedAt: '2026-03-23T09:10:00.000Z',
      }),
      makeRun({
        id: 'updated-latest',
        createdAt: '2026-03-21T09:00:00.000Z',
        updatedAt: '2026-03-23T10:00:00.000Z',
      }),
    ]);

    expect(runs.map((run) => run.id)).toEqual([
      'updated-latest',
      'newer',
      'older',
    ]);
  });

  it('keeps fresher summary status while preserving richer detail payloads', () => {
    const merged = mergeRepoReviewRunSnapshot(
      makeRun({
        id: 'run-1',
        status: 'completed',
        summary: 'fresh summary',
        updatedAt: '2026-03-23T10:05:00.000Z',
        completedAt: '2026-03-23T10:05:00.000Z',
      }),
      makeRun({
        id: 'run-1',
        status: 'running',
        summary: 'stale detail',
        updatedAt: '2026-03-23T10:00:00.000Z',
        reviewTurns: [
          {
            id: 'turn-1',
            timestamp: '2026-03-23T10:00:00.000Z',
            items: [
              {
                id: 'msg-1',
                type: 'assistant_message',
                status: 'completed',
                text: 'detail body',
                timestamp: '2026-03-23T10:00:00.000Z',
              },
            ],
            isLive: false,
            isCompleted: true,
          },
        ],
        changedFiles: ['src/index.ts'],
      }),
    );

    expect(merged?.status).toBe('completed');
    expect(merged?.summary).toBe('fresh summary');
    expect(merged?.reviewTurns).toHaveLength(1);
    expect(merged?.changedFiles).toEqual(['src/index.ts']);
  });

  it('preserves richer progress steps when merging fetched run snapshots', () => {
    const merged = mergeFetchedRepoReviewRunSnapshot(
      makeRun({
        id: 'run-progress',
        status: 'running',
        updatedAt: '2026-03-23T10:05:00.000Z',
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: '',
          latestErrorText: null,
          hasTerminalOutput: false,
        },
      }),
      makeRun({
        id: 'run-progress',
        status: 'running',
        updatedAt: '2026-03-23T10:04:00.000Z',
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: '',
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'prepare_context',
              label: '解析 Diff 与提交上下文',
              status: 'running',
              startedAt: '2026-03-23T10:04:00.000Z',
            },
          ],
        },
      }),
    );

    expect(merged?.reviewProgress?.steps).toHaveLength(1);
    expect(merged?.reviewProgress?.steps?.[0]?.id).toBe('prepare_context');
  });

  it('reuses the configured review chat jid and falls back to repo-review namespace', () => {
    expect(
      getRepoReviewRunChatJid(makeRun({ id: 'run-configured' }), {
        id: 'repo-1',
        reviewChatJid: 'feishu:chat-1',
      }),
    ).toBe('feishu:chat-1');
    expect(getRepoReviewRunChatJid(makeRun({ id: 'run-fallback' }))).toBe(
      'repo-review:repo-1',
    );
  });

  it('applies repo review realtime stream updates with the same turn reducer as chat', () => {
    let run = makeRun({
      id: 'run-stream',
      status: 'running',
      overall: '',
      reviewTurns: [],
      updatedAt: '2026-03-24T10:00:00.000Z',
    });

    run = applyRepoReviewRealtimeEventToRun(run, {
      kind: 'turn_event',
      jid: 'repo-review:repo-1',
      timestamp: '2026-03-24T10:00:01.000Z',
      event: {
        type: 'turn.started',
        turnId: 'turn-stream',
        timestamp: '2026-03-24T10:00:01.000Z',
      },
    });
    run = applyRepoReviewRealtimeEventToRun(run, {
      kind: 'turn_event',
      jid: 'repo-review:repo-1',
      timestamp: '2026-03-24T10:00:02.000Z',
      event: {
        type: 'item.updated',
        turnId: 'turn-stream',
        timestamp: '2026-03-24T10:00:02.000Z',
        item: {
          id: 'turn-stream:assistant:1',
          type: 'assistant_message',
          status: 'in_progress',
          text: 'slow-path text',
          timestamp: '2026-03-24T10:00:02.000Z',
        },
      },
    });
    run = applyRepoReviewRealtimeEventToRun(run, {
      kind: 'stream',
      jid: 'repo-review:repo-1',
      chunk: 'final answer',
      done: false,
      timestamp: '2026-03-24T10:00:03.000Z',
      runId: 'turn-stream',
    });

    expect(run.reviewTurns).toHaveLength(1);
    expect(run.reviewTurns[0]?.items).toHaveLength(1);
    expect(run.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      status: 'in_progress',
      text: 'final answer',
    });
  });

  it('merges fetched run snapshots without dropping richer local turn progress', () => {
    const mergedRuns = mergeRepoReviewRunListSnapshots(
      [
        makeRun({
          id: 'run-merge',
          status: 'running',
          updatedAt: '2026-03-24T10:00:00.000Z',
          summary: 'server summary',
        }),
      ],
      [
        makeRun({
          id: 'run-merge',
          status: 'running',
          updatedAt: '2026-03-24T10:00:05.000Z',
          reviewTurns: [
            {
              id: 'turn-live',
              timestamp: '2026-03-24T10:00:05.000Z',
              items: [
                {
                  id: 'msg-live',
                  type: 'assistant_message',
                  status: 'in_progress',
                  text: 'live body',
                  timestamp: '2026-03-24T10:00:05.000Z',
                },
              ],
              isLive: true,
              isCompleted: false,
            },
          ],
        }),
      ],
    );

    expect(mergedRuns).toHaveLength(1);
    expect(mergedRuns[0]?.summary).toBe('server summary');
    expect(mergedRuns[0]?.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'live body',
    });
  });

  it('keeps newer local run activity when an older fetch arrives, but still fills blank fields', () => {
    const merged = mergeFetchedRepoReviewRunSnapshot(
      makeRun({
        id: 'run-stale-fetch',
        status: 'running',
        summary: 'server summary',
        updatedAt: '2026-03-24T10:00:00.000Z',
        reviewTurns: [
          {
            id: 'turn-server',
            timestamp: '2026-03-24T10:00:00.000Z',
            items: [
              {
                id: 'msg-server',
                type: 'assistant_message',
                status: 'in_progress',
                text: 'server body',
                timestamp: '2026-03-24T10:00:00.000Z',
              },
            ],
            isLive: true,
            isCompleted: false,
          },
        ],
      }),
      makeRun({
        id: 'run-stale-fetch',
        status: 'running',
        summary: '',
        updatedAt: '2026-03-24T10:00:05.000Z',
        reviewTurns: [
          {
            id: 'turn-local',
            timestamp: '2026-03-24T10:00:05.000Z',
            items: [
              {
                id: 'msg-local',
                type: 'assistant_message',
                status: 'in_progress',
                text: 'live body',
                timestamp: '2026-03-24T10:00:05.000Z',
              },
            ],
            isLive: true,
            isCompleted: false,
          },
        ],
      }),
    );

    expect(merged?.updatedAt).toBe('2026-03-24T10:00:05.000Z');
    expect(merged?.summary).toBe('server summary');
    expect(merged?.reviewTurns[0]?.items[0]).toMatchObject({
      type: 'assistant_message',
      text: 'live body',
    });
  });
});
