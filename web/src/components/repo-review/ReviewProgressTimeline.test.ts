// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReviewProgressEntries,
  filterReviewProgressEntriesForList,
  hasRepoReviewVisibleProgress,
  ReviewProgressTimeline,
} from './ReviewProgressTimeline';
import { RepoReviewRunDetailModal } from './RepoReviewRunDetailModal';
import type { RepoReviewRun } from '../../app-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      switch (key) {
        case 'timeline.input':
          return '输入';
        case 'timeline.result':
          return '输出';
        case 'timeline.error':
          return '错误';
        case 'timeline.tool':
          return '工具';
        case 'timeline.completed':
          return '已完成';
        case 'timeline.failed':
          return '失败';
        case 'timeline.inProgress':
          return '进行中';
        case 'timeline.response':
          return '回复';
        case 'timeline.thinking':
          return '思考';
        case 'timeline.formatting':
          return '格式化';
        case 'timeline.content':
          return '内容';
        case 'timeline.aiConclusion':
          return 'AI 阶段结论';
        case 'timeline.processing':
          return '处理中';
        default:
          return key;
      }
    },
  }),
}));

vi.mock('../../i18n/index.ts', () => ({
  default: {
    t: (key: string) => {
      switch (key) {
        case 'timeline.completed':
          return '已完成';
        case 'timeline.failed':
          return '失败';
        case 'timeline.inProgress':
          return '进行中';
        case 'timeline.formatting':
          return '格式化';
        default:
          return key;
      }
    },
  },
}));

function makeRun(overrides: Partial<RepoReviewRun> = {}): RepoReviewRun {
  return {
    id: 'run-1',
    repositoryId: 'repo-1',
    profileId: 'profile-1',
    source: 'local-hook',
    stage: 'push',
    status: 'running',
    overall: 'warn',
    passDecisionMode: 'ai',
    recommendedBlock: false,
    blockingEnforced: false,
    ref: 'refs/heads/main',
    branch: 'main',
    baseSha: 'base',
    headSha: 'head',
    prMrNumber: '',
    actor: 'alice',
    summary: 'running',
    findings: [],
    reviewTurns: [],
    commitDetails: [],
    commitReviews: [],
    suggestions: [],
    changedFiles: [],
    diffBytes: 0,
    platformStatus: '',
    platformCommentUrl: '',
    startedAt: '2026-04-23T00:00:00.000Z',
    completedAt: '',
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:01:00.000Z',
    ...overrides,
  };
}

function renderTimeline(
  entries: ReturnType<typeof buildReviewProgressEntries>,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(ReviewProgressTimeline, {
        entries,
        fullAssistantBody: true,
      }),
    );
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildReviewProgressEntries', () => {
  it('falls back to reviewProgress when there are no turn entries', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 1,
          latestAssistantText: '正在收敛阶段结论',
          latestErrorText: null,
          hasTerminalOutput: true,
        },
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'assistant_message',
      item: {
        text: '正在收敛阶段结论',
      },
    });
  });

  it('appends a newer progress snapshot even when old review turns already exist', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewTurns: [
          {
            id: 'turn-old',
            timestamp: '2026-04-23T00:00:10.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'msg-old',
                type: 'assistant_message',
                status: 'completed',
                text: '旧的阶段结论',
                timestamp: '2026-04-23T00:00:10.000Z',
              },
            ],
          },
        ],
        reviewProgress: {
          turnCount: 1,
          latestAssistantText: '更新后的阶段结论',
          latestErrorText: null,
          hasTerminalOutput: true,
        },
      }),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'assistant_message',
      item: { text: '旧的阶段结论' },
    });
    expect(entries[1]).toMatchObject({
      kind: 'assistant_message',
      item: { text: '更新后的阶段结论' },
    });
  });

  it('shows executor progress steps alongside system turn cards', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewTurns: [
          {
            id: 'turn-agent',
            timestamp: '2026-04-23T00:00:05.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'tool-agent',
                type: 'tool_call',
                status: 'completed',
                title: 'Agent',
                argumentsText: '{"file":"src/demo.ts"}',
                resultText: '{"summary":"ok"}',
                timestamp: '2026-04-23T00:00:06.000Z',
              },
            ],
          },
        ],
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'full_file_subagent_1',
              label: '全文补充子代理 1/1',
              status: 'completed',
              startedAt: '2026-04-23T00:00:05.000Z',
              completedAt: '2026-04-23T00:00:06.000Z',
              durationMs: 1000,
              detail: 'src/demo.ts',
            },
          ],
        },
      }),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'progress_step',
        item: expect.objectContaining({
          id: 'full_file_subagent_1',
          status: 'completed',
          durationMs: 1000,
        }),
      }),
      expect.objectContaining({
        kind: 'tool_call',
        item: expect.objectContaining({
          id: 'tool-agent',
          status: 'completed',
        }),
      }),
    ]);
  });

  it('treats executor progress steps as visible progress before AI turn events arrive', () => {
    const run = makeRun({
      reviewProgress: {
        turnCount: 0,
        latestAssistantText: null,
        latestErrorText: null,
        hasTerminalOutput: false,
        steps: [
          {
            id: 'acquire_worktree',
            label: '创建 Review Worktree',
            status: 'running',
            startedAt: '2026-04-23T00:00:05.000Z',
            detail: '分支 feature/demo',
          },
        ],
      },
    });

    expect(hasRepoReviewVisibleProgress(run)).toBe(true);
    expect(buildReviewProgressEntries(run)[0]).toMatchObject({
      kind: 'progress_step',
      item: {
        id: 'acquire_worktree',
        label: '创建 Review Worktree',
        status: 'running',
      },
    });
  });

  it('renders progress steps through the existing tool bubble structure', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'build_diff_index',
              label: '构建 Diff Index',
              kind: 'stage',
              status: 'completed',
              startedAt: '2026-04-23T00:00:05.000Z',
              completedAt: '2026-04-23T00:00:05.041Z',
              durationMs: 41,
              inputText: 'changed_files:\n- src/demo.ts',
              outputText: 'files_indexed: 1',
              metadataText: 'indexed_files: src/demo.ts',
            },
          ],
        },
      }),
    );

    const rendered = renderTimeline(entries);
    expect(
      rendered.container.querySelector('.assistant-turn-node-tool_call'),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector('.turn-item-duration'),
    ).not.toBeNull();
    expect(rendered.container.textContent).toContain('输入');
    expect(rendered.container.textContent).toContain('输出');
    expect(rendered.container.textContent).toContain('files_indexed: 1');
    rendered.unmount();
  });

  it('formats sub-second progress durations in seconds instead of mislabeled milliseconds', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'mark_running',
              label: '运行状态落库',
              kind: 'stage',
              status: 'completed',
              startedAt: '2026-04-23T00:00:05.000Z',
              completedAt: '2026-04-23T00:00:05.115Z',
              durationMs: 115,
              outputText: 'status: running',
            },
          ],
        },
      }),
    );

    const rendered = renderTimeline(entries);
    expect(rendered.container.textContent).toContain('0.1');
    expect(rendered.container.textContent).not.toContain('115s');
    rendered.unmount();
  });

  it('renders synthetic review subagent tool calls as standard tool cards with duration', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewTurns: [
          {
            id: 'turn-subagent',
            timestamp: '2026-04-23T00:00:05.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'tool-subagent',
                type: 'tool_call',
                status: 'completed',
                title: 'Agent',
                argumentsText: '任务：审查 demo.ts',
                resultText: '完成局部审查。',
                startedAt: '2026-04-23T00:00:05.000Z',
                completedAt: '2026-04-23T00:00:07.000Z',
                timestamp: '2026-04-23T00:00:07.000Z',
              },
            ],
          },
        ],
      }),
    );

    const rendered = renderTimeline(entries);
    expect(
      rendered.container.querySelector('.subagent-activity-card'),
    ).toBeNull();
    expect(
      rendered.container.querySelector('.turn-item-duration'),
    ).not.toBeNull();
    rendered.unmount();
  });

  it('nests child turns inside their parent Agent tool card', () => {
    const parentToolCallId =
      'run-1:agentic-subagent-tool:task-1:src-demo-ts:agent';
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'agentic_subagent_1',
              label: '子代理 1/1',
              kind: 'subagent',
              status: 'completed',
              startedAt: '2026-04-23T00:00:01.000Z',
              completedAt: '2026-04-23T00:00:05.000Z',
            },
          ],
        },
        reviewTurns: [
          {
            id: 'turn-subagent-tool',
            groupKey: 'agentic_subagent_1',
            groupLabel: '子代理 1/1',
            phase: 'worker',
            timestamp: '2026-04-23T00:00:02.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: parentToolCallId,
                type: 'tool_call',
                status: 'completed',
                title: 'Agent',
                argumentsText: '任务：审查 src/demo.ts',
                resultText: '完成局部审查。',
                timestamp: '2026-04-23T00:00:03.000Z',
              },
            ],
          },
          {
            id: 'turn-subagent-child',
            groupKey: 'agentic_subagent_1',
            groupLabel: '子代理 1/1',
            parentToolCallId,
            phase: 'worker',
            timestamp: '2026-04-23T00:00:04.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'msg-subagent-child',
                type: 'assistant_message',
                status: 'completed',
                text: '子代理内部结论。',
                timestamp: '2026-04-23T00:00:04.000Z',
              },
            ],
          },
        ],
      }),
    );

    const rendered = renderTimeline(entries);
    const nested = rendered.container.querySelector(
      '.repo-review-progress-nested-turns',
    );
    expect(nested).not.toBeNull();
    expect(nested?.textContent).toContain('子代理内部结论');
    rendered.unmount();
  });

  it('groups worker turns under their worker step and labels timeout follow-ups', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'worker_chunk_1',
              label: 'Worker 1/1',
              kind: 'worker',
              status: 'completed',
              startedAt: '2026-04-23T00:00:01.000Z',
              completedAt: '2026-04-23T00:00:03.000Z',
            },
          ],
        },
        reviewTurns: [
          {
            id: 'turn-worker-1',
            groupKey: 'worker_chunk_1',
            groupLabel: 'Worker 1/1',
            phase: 'timeout_followup',
            timestamp: '2026-04-23T00:00:02.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'tool-worker-1',
                type: 'tool_call',
                status: 'completed',
                title: 'read_file',
                argumentsText: '{"path":"src/demo.ts"}',
                resultText: '{"summary":"ok"}',
                timestamp: '2026-04-23T00:00:02.000Z',
              },
            ],
          },
        ],
      }),
    );

    const rendered = renderTimeline(entries);
    expect(rendered.container.textContent).toContain('Worker 1/1');
    expect(rendered.container.textContent).toContain('超时追问');
    const group = rendered.container.querySelector(
      '.repo-review-progress-turn-group',
    );
    expect(group).not.toBeNull();
    expect(group?.hasAttribute('open')).toBe(false);
    rendered.unmount();
  });

  it('keeps main-agent turn groups expanded by default', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewTurns: [
          {
            id: 'turn-main-1',
            groupKey: 'agentic_main_summary',
            groupLabel: '主代理直接审查',
            phase: 'main_agent_review',
            timestamp: '2026-04-23T00:00:02.000Z',
            isLive: false,
            isCompleted: true,
            items: [
              {
                id: 'msg-main-1',
                type: 'assistant_message',
                status: 'completed',
                text: '主代理已生成结论。',
                timestamp: '2026-04-23T00:00:02.000Z',
              },
            ],
          },
        ],
      }),
    );

    const rendered = renderTimeline(entries);
    const group = rendered.container.querySelector(
      '.repo-review-progress-turn-group',
    );
    expect(group).not.toBeNull();
    expect(group?.hasAttribute('open')).toBe(true);
    rendered.unmount();
  });

  it('filters main-agent summary steps from list timelines', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'agentic_main_summary',
              label: '主代理直接审查',
              kind: 'main',
              status: 'completed',
              startedAt: '2026-04-23T00:00:01.000Z',
              activeStartedAt: '2026-04-23T00:00:05.000Z',
              completedAt: '2026-04-23T00:00:06.000Z',
              durationMs: 1000,
            },
            {
              id: 'main_agent_review',
              label: '主代理直接审查',
              kind: 'main',
              status: 'completed',
              startedAt: '2026-04-23T00:00:07.000Z',
              activeStartedAt: '2026-04-23T00:00:08.000Z',
              completedAt: '2026-04-23T00:00:09.000Z',
              durationMs: 1000,
            },
            {
              id: 'main_agent_fallback_review',
              label: '主代理补审',
              kind: 'main',
              status: 'completed',
              startedAt: '2026-04-23T00:00:10.000Z',
              activeStartedAt: '2026-04-23T00:00:11.000Z',
              completedAt: '2026-04-23T00:00:12.000Z',
              durationMs: 1000,
            },
            {
              id: 'build_diff_index',
              label: '构建 Diff Index',
              kind: 'stage',
              status: 'completed',
              startedAt: '2026-04-23T00:00:02.000Z',
              activeStartedAt: '2026-04-23T00:00:03.000Z',
              completedAt: '2026-04-23T00:00:04.000Z',
              durationMs: 1000,
            },
          ],
        },
      }),
    );

    expect(filterReviewProgressEntriesForList(entries)).toEqual([
      expect.objectContaining({
        kind: 'progress_step',
        item: expect.objectContaining({
          id: 'build_diff_index',
        }),
      }),
    ]);
  });

  it('labels v3 worker and reducer steps in the timeline', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'worker_chunk_1',
              label: 'Worker 1/2',
              kind: 'worker',
              status: 'completed',
              startedAt: '2026-04-23T00:00:01.000Z',
              completedAt: '2026-04-23T00:00:02.000Z',
            },
            {
              id: 'reduce_results',
              label: 'Reducer 收敛审查结论',
              kind: 'reducer',
              status: 'completed',
              startedAt: '2026-04-23T00:00:03.000Z',
              completedAt: '2026-04-23T00:00:04.000Z',
            },
          ],
        },
      }),
    );

    const rendered = renderTimeline(entries);
    expect(rendered.container.textContent).toContain('Worker');
    expect(rendered.container.textContent).toContain('收敛');
    rendered.unmount();
  });

  it('uses the active start time for progress step duration labels', () => {
    const entries = buildReviewProgressEntries(
      makeRun({
        reviewProgress: {
          turnCount: 0,
          latestAssistantText: null,
          latestErrorText: null,
          hasTerminalOutput: false,
          steps: [
            {
              id: 'build_diff_index',
              label: '构建 Diff Index',
              kind: 'stage',
              status: 'completed',
              startedAt: '2026-04-23T00:00:01.000Z',
              activeStartedAt: '2026-04-23T00:00:05.000Z',
              completedAt: '2026-04-23T00:00:06.000Z',
              durationMs: 1000,
              inputText: 'changed_files:\n- src/demo.ts',
              outputText: 'files_indexed: 1',
            },
          ],
        },
      }),
    );

    const rendered = renderTimeline(entries);
    expect(rendered.container.textContent).toContain('1.0');
    rendered.unmount();
  });
});

describe('RepoReviewRunDetailModal evidence stats', () => {
  it('shows evidence bundle and tool-call status metrics', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(RepoReviewRunDetailModal, {
          run: makeRun({
            status: 'completed',
            executionStats: {
              diffFiles: 1,
              diffBytes: 120,
              splitGroups: 0,
              peakReservedBytes: 0,
              fullFileBytesLoaded: 0,
              promptBytesBuilt: 0,
              progressSnapshotBytes: 0,
              extraRepoReadCount: 0,
              fullFileBatchReservedBytes: [],
              evidenceBundleBytes: 4096,
              codeMapContextStatus: 'ready',
              codeIndexContextStatus: 'stale',
              changedFunctionCount: 2,
              subagentToolCallCount: 0,
              mainReadonlyToolCallCount: 1,
            },
          }),
          loading: false,
          repositoryName: 'demo',
          profileName: 'default',
          progressEntries: [],
          onClose: () => undefined,
          formatRunTitle: () => 'Run title',
          formatResultStateLabel: () => 'warn',
          getDeliveryTone: () => 'neutral',
          resolveChatDeliveryStatus: () => 'not_configured',
          resolvePlatformDeliveryStatus: () => 'not_configured',
          formatDeliveryStatusLabel: (status: string) => status,
          formatRunStageLabel: (stage: RepoReviewRun['stage']) => stage,
          formatRunSourceLabel: (source: string) => source,
          formatBaselineSourceLabel: (source?: string) => source || '-',
          formatShortSha: (sha?: string) => sha || '-',
          formatDurationMs: () => '-',
          getRunDurationMs: () => undefined,
        }),
      );
    });

    expect(container.textContent).toContain('CodeMap');
    expect(container.textContent).toContain('ready');
    expect(container.textContent).toContain('Code Index');
    expect(container.textContent).toContain('stale');
    expect(container.textContent).toContain('4.0 KB');
    expect(container.textContent).toContain('Changed functions');
    expect(container.textContent).toContain('Subagent tools');
    root.unmount();
    container.remove();
  });
});
