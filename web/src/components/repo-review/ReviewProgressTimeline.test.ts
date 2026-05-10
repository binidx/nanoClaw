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

function renderTimeline(entries: ReturnType<typeof buildReviewProgressEntries>) {
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
    expect(rendered.container.querySelector('.assistant-turn-node-tool_call')).not.toBeNull();
    expect(rendered.container.querySelector('.turn-item-duration')).not.toBeNull();
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
    expect(rendered.container.querySelector('.subagent-activity-card')).toBeNull();
    expect(rendered.container.querySelector('.turn-item-duration')).not.toBeNull();
    rendered.unmount();
  });

  it('filters the direct main-agent summary step from list timelines', () => {
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
