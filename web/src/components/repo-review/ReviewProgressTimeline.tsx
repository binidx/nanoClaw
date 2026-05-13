import { memo, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import i18n from '../../i18n/index.ts';
import { SubagentActivity } from '../SubagentActivity';
import type {
  AssistantMessageTurnItem,
  ReasoningTurnItem,
  RepoReviewProgressStep,
  RepoReviewRun,
  ToolCallTurnItem,
} from '../../app-types';

function getTurnItemStatusLabel(
  status: 'in_progress' | 'completed' | 'failed',
) {
  return status === 'completed'
    ? i18n.t('timeline.completed', { ns: 'repoReview' })
    : status === 'failed'
      ? i18n.t('timeline.failed', { ns: 'repoReview' })
      : i18n.t('timeline.inProgress', { ns: 'repoReview' });
}

function getProgressStepStatusLabel(status: RepoReviewProgressStep['status']) {
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '已跳过';
  if (status === 'queued') return '排队中';
  return '进行中';
}

function getProgressStepTurnStatus(
  status: RepoReviewProgressStep['status'],
): 'in_progress' | 'completed' | 'failed' {
  if (status === 'completed' || status === 'skipped') return 'completed';
  if (status === 'failed') return 'failed';
  return 'in_progress';
}

export function filterReviewProgressEntriesForList(
  entries: ReviewProgressEntry[],
) {
  return entries.filter(
    (entry) =>
      !(
        entry.kind === 'progress_step' &&
        (entry.item.id === 'agentic_main_summary' ||
          entry.item.id === 'main_agent_review' ||
          entry.item.id === 'main_agent_fallback_review')
      ),
  );
}

const ToolCallDurationLabel = memo(function ToolCallDurationLabel({
  startedAt,
  completedAt,
  timestamp,
  status,
}: {
  startedAt?: string;
  completedAt?: string;
  timestamp: string;
  status: 'in_progress' | 'completed' | 'failed';
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== 'in_progress' || !startedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [status, startedAt]);

  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  const fallbackMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  const endMs =
    status === 'completed' || status === 'failed'
      ? Number.isFinite(completedMs)
        ? completedMs
        : Number.isFinite(fallbackMs)
          ? fallbackMs
          : Number.NaN
      : now;
  if (
    !Number.isFinite(startedMs) ||
    !Number.isFinite(endMs) ||
    endMs < startedMs
  ) {
    return null;
  }
  const durationMs = Math.max(0, endMs - startedMs);
  const label = `${(durationMs / 1000).toFixed(1)}${i18n.t('assistant.durationSuffix', { ns: 'chat' })}`;
  const title = [
    startedAt ? `开始：${startedAt}` : '',
    completedAt ? `结束：${completedAt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="turn-item-duration" title={title || undefined}>
      {label}
    </span>
  );
});

function getProgressStepKindLabel(step: RepoReviewProgressStep) {
  if (step.kind === 'worker') return 'Worker';
  if (step.kind === 'reducer') return '收敛';
  if (step.kind === 'subagent') return '子代理';
  if (step.kind === 'extractor' || step.kind === 'formatter') return '格式化';
  if (step.kind === 'main') return '主代理';
  if (step.kind === 'stage') return '阶段';
  if (
    step.id.startsWith('worker_chunk_') ||
    step.id.startsWith('split_diff_worker_') ||
    step.id.startsWith('agentic_subagent_') ||
    step.id.startsWith('full_file_subagent_')
  ) {
    return 'Worker';
  }
  if (step.id === 'reduce_results') return '收敛';
  if (step.id === 'split_diff_main' || step.id === 'agentic_main_summary') {
    return '汇总';
  }
  if (step.id === 'agentic_main_plan') return '计划';
  if (step.id === 'agentic_structured_extract') return '格式化';
  return '阶段';
}

function getReviewTurnPhaseLabel(phase?: string) {
  if (phase === 'timeout_followup') return '超时追问';
  if (phase === 'main_agent_review') return '主代理';
  if (phase === 'main_agent_fallback_review') return '主代理补审';
  if (phase === 'reducer') return '收敛';
  if (phase === 'formatter') return '格式化';
  return '';
}

function shouldCollapseTurnGroup(groupKey: string): boolean {
  return (
    groupKey.startsWith('worker_chunk_') ||
    groupKey.startsWith('split_diff_worker_') ||
    groupKey.startsWith('agentic_subagent_') ||
    groupKey.startsWith('full_file_subagent_')
  );
}

function buildProgressStepToolCallItem(
  step: RepoReviewProgressStep,
): ToolCallTurnItem {
  const outputSections = [
    `状态: ${getProgressStepStatusLabel(step.status)}`,
    step.outputText?.trim() || step.detail?.trim() || '',
    step.metadataText?.trim() || '',
  ]
    .map((part) => part.trim())
    .filter(Boolean);
  const resultText =
    outputSections.length > 0 ? outputSections.join('\n\n') : undefined;
  const inputText = step.inputText?.trim() || step.detail?.trim() || undefined;
  const effectiveStartedAt =
    step.activeStartedAt ||
    (step.status === 'queued' ? undefined : step.startedAt);
  return {
    id: `progress-step:${step.id}`,
    type: 'tool_call',
    status: getProgressStepTurnStatus(step.status),
    title: step.label,
    argumentsText: inputText,
    resultText,
    errorText: step.error?.trim() || undefined,
    startedAt: effectiveStartedAt,
    completedAt: step.completedAt,
    timestamp: step.completedAt || effectiveStartedAt || step.startedAt,
  };
}

function formatReviewReasoningText(title: string, text?: string) {
  const trimmed = text?.trim();
  if (!trimmed) return title;
  return trimmed === title ? trimmed : `${title}：${trimmed}`;
}

function truncateReviewPreview(text: string, max = 300) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function hasRepoReviewVisibleProgress(run: RepoReviewRun) {
  if (run.reviewTurns.some((turn) => turn.items.length > 0 || !!turn.error)) {
    return true;
  }
  return Boolean(
    run.reviewProgress &&
    ((run.reviewProgress.steps?.length || 0) > 0 ||
      run.reviewProgress.turnCount > 0 ||
      run.reviewProgress.latestAssistantText ||
      run.reviewProgress.latestErrorText),
  );
}

export function buildReviewProgressEntries(run: RepoReviewRun) {
  const entries: Array<
    | {
        key: string;
        kind: 'progress_step';
        timestamp: string;
        item: RepoReviewProgressStep;
        groupKey: string;
        groupLabel: string;
      }
    | {
        key: string;
        kind: 'reasoning';
        timestamp: string;
        item: ReasoningTurnItem;
        turnId: string;
        groupKey: string;
        groupLabel: string;
        phase?: string;
      }
    | {
        key: string;
        kind: 'tool_call';
        timestamp: string;
        item: ToolCallTurnItem;
        turnId: string;
        groupKey: string;
        groupLabel: string;
        phase?: string;
      }
    | {
        key: string;
        kind: 'assistant_message';
        timestamp: string;
        item: AssistantMessageTurnItem;
        turnId: string;
        groupKey: string;
        groupLabel: string;
        phase?: string;
      }
    | {
        key: string;
        kind: 'turn_error';
        timestamp: string;
        error: string;
        turnId: string;
        groupKey: string;
        groupLabel: string;
        phase?: string;
      }
  > = [];

  for (const step of run.reviewProgress?.steps || []) {
    entries.push({
      key: `${run.id}:progress-step:${step.id}`,
      kind: 'progress_step',
      timestamp: step.activeStartedAt || step.startedAt || run.createdAt,
      item: step,
      groupKey: step.id,
      groupLabel: step.label,
    });
  }

  for (const turn of run.reviewTurns) {
    const groupKey = turn.groupKey || turn.id;
    const groupLabel = turn.groupLabel || turn.groupKey || turn.id;
    for (const item of turn.items) {
      if (item.type === 'assistant_message') {
        if (!item.text.trim()) continue;
        entries.push({
          key: `${turn.id}:${item.id}`,
          kind: item.type,
          timestamp: item.timestamp || turn.timestamp,
          item,
          turnId: turn.id,
          groupKey,
          groupLabel,
          phase: turn.phase,
        });
        continue;
      }
      if (item.type === 'reasoning') {
        entries.push({
          key: `${turn.id}:${item.id}`,
          kind: item.type,
          timestamp: item.timestamp || turn.timestamp,
          item,
          turnId: turn.id,
          groupKey,
          groupLabel,
          phase: turn.phase,
        });
        continue;
      }
      if (item.type === 'tool_call') {
        entries.push({
          key: `${turn.id}:${item.id}`,
          kind: item.type,
          timestamp: item.timestamp || turn.timestamp,
          item,
          turnId: turn.id,
          groupKey,
          groupLabel,
          phase: turn.phase,
        });
      }
    }
    if (turn.error) {
      entries.push({
        key: `${turn.id}:error`,
        kind: 'turn_error',
        timestamp: turn.timestamp,
        error: turn.error,
        turnId: turn.id,
        groupKey,
        groupLabel,
        phase: turn.phase,
      });
    }
  }

  if (
    run.reviewProgress &&
    (run.reviewProgress.latestAssistantText ||
      run.reviewProgress.latestErrorText)
  ) {
    const timestamp = run.updatedAt || run.startedAt || run.createdAt;
    const latestAssistantEntry = [...entries]
      .reverse()
      .find((entry) => entry.kind === 'assistant_message');
    const latestErrorEntry = [...entries]
      .reverse()
      .find((entry) => entry.kind === 'turn_error');
    const shouldAppendAssistantSnapshot = Boolean(
      run.reviewProgress.latestAssistantText &&
      (!latestAssistantEntry ||
        timestamp > latestAssistantEntry.timestamp ||
        latestAssistantEntry.item.text !==
          run.reviewProgress.latestAssistantText),
    );
    const shouldAppendErrorSnapshot = Boolean(
      run.reviewProgress.latestErrorText &&
      (!latestErrorEntry ||
        timestamp > latestErrorEntry.timestamp ||
        latestErrorEntry.error !== run.reviewProgress.latestErrorText),
    );
    if (
      shouldAppendAssistantSnapshot &&
      run.reviewProgress.latestAssistantText
    ) {
      entries.push({
        key: `${run.id}:progress-snapshot:assistant:${timestamp}`,
        kind: 'assistant_message',
        timestamp,
        item: {
          id: `${run.id}:progress-snapshot:assistant:${timestamp}`,
          type: 'assistant_message',
          status: run.status === 'running' ? 'in_progress' : 'completed',
          text: run.reviewProgress.latestAssistantText,
          timestamp,
        },
        turnId: `${run.id}:progress-snapshot:assistant:${timestamp}`,
        groupKey: 'progress_snapshot',
        groupLabel: '进度快照',
      });
    }
    if (shouldAppendErrorSnapshot && run.reviewProgress.latestErrorText) {
      entries.push({
        key: `${run.id}:progress-snapshot:error:${timestamp}`,
        kind: 'turn_error',
        timestamp,
        error: run.reviewProgress.latestErrorText,
        turnId: `${run.id}:progress-snapshot:error:${timestamp}`,
        groupKey: 'progress_snapshot',
        groupLabel: '进度快照',
      });
    }
  }

  return entries.sort((left, right) =>
    left.timestamp === right.timestamp
      ? left.key.localeCompare(right.key)
      : left.timestamp.localeCompare(right.timestamp),
  );
}

export type ReviewProgressEntry = ReturnType<
  typeof buildReviewProgressEntries
>[number];

export function ReviewProgressTimeline({
  entries,
  fullAssistantBody = false,
}: {
  entries: ReviewProgressEntry[];
  fullAssistantBody?: boolean;
}) {
  const { t } = useTranslation('repoReview');

  const renderToolCallNode = ({
    key,
    item,
    kindLabel,
    open,
    phaseLabel,
  }: {
    key: string;
    item: ToolCallTurnItem;
    kindLabel: string;
    open: boolean;
    phaseLabel?: string;
  }) => (
    <div
      key={key}
      className="assistant-turn-node assistant-turn-node-tool_call single-entry-node"
    >
      <div className="assistant-turn-node-rail" aria-hidden="true">
        <span className={`assistant-turn-node-dot tool ${item.status}`} />
        <span className="assistant-turn-node-line" />
      </div>
      <div className="assistant-turn-node-main">
        <details
          className="assistant-turn-card assistant-tool-card turn-item turn-item-tool"
          open={open}
        >
          <summary className="turn-item-header turn-item-summary">
            <span className="turn-item-summary-icon" aria-hidden="true" />
            <div className="turn-item-summary-main">
              <div className="turn-item-summary-top">
                <span className="turn-item-kind tool_call">{kindLabel}</span>
                {phaseLabel ? (
                  <span className="repo-review-progress-turn-tag">
                    {phaseLabel}
                  </span>
                ) : null}
                <span className="turn-item-title">{item.title}</span>
                <ToolCallDurationLabel
                  startedAt={item.startedAt}
                  completedAt={item.completedAt}
                  timestamp={item.timestamp}
                  status={item.status}
                />
                <span className={`turn-item-status ${item.status}`}>
                  {getTurnItemStatusLabel(item.status)}
                </span>
              </div>
              <span className="turn-item-preview">
                {truncateReviewPreview(
                  item.status === 'failed'
                    ? item.errorText || item.argumentsText || ''
                    : item.resultText || item.argumentsText || '',
                )}
              </span>
            </div>
          </summary>
          <div className="turn-item-body">
            {item.subagentInfo ? (
              <SubagentActivity
                info={item.subagentInfo}
                argumentsText={item.argumentsText}
                resultText={item.resultText}
                errorText={item.errorText}
              />
            ) : (
              <>
                {item.argumentsText ? (
                  <div className="turn-item-section">
                    <div className="turn-item-label">{t('timeline.input')}</div>
                    <pre className="turn-item-code">{item.argumentsText}</pre>
                  </div>
                ) : null}
                {item.resultText ? (
                  <div className="turn-item-section">
                    <div className="turn-item-label">
                      {t('timeline.result')}
                    </div>
                    <pre className="turn-item-code">{item.resultText}</pre>
                  </div>
                ) : null}
                {item.errorText ? (
                  <div className="turn-item-section">
                    <div className="turn-item-label">{t('timeline.error')}</div>
                    <pre className="turn-item-code turn-item-code-error">
                      {item.errorText}
                    </pre>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </details>
      </div>
    </div>
  );

  const stepEntries = entries.filter(
    (entry): entry is Extract<ReviewProgressEntry, { kind: 'progress_step' }> =>
      entry.kind === 'progress_step',
  );
  const turnEntries = entries.filter(
    (entry): entry is Exclude<ReviewProgressEntry, { kind: 'progress_step' }> =>
      entry.kind !== 'progress_step',
  );
  const turnGroups = new Map<
    string,
    {
      groupKey: string;
      groupLabel: string;
      timestamp: string;
      phases: Set<string>;
      entries: typeof turnEntries;
    }
  >();
  for (const entry of turnEntries) {
    const groupKey = entry.groupKey || entry.turnId || entry.key;
    const existing = turnGroups.get(groupKey);
    if (existing) {
      existing.entries.push(entry);
      existing.phases.add(entry.phase || '');
      if (entry.timestamp < existing.timestamp) {
        existing.timestamp = entry.timestamp;
      }
      continue;
    }
    turnGroups.set(groupKey, {
      groupKey,
      groupLabel: entry.groupLabel || groupKey,
      timestamp: entry.timestamp,
      phases: new Set(entry.phase ? [entry.phase] : []),
      entries: [entry],
    });
  }

  const renderTimelineEntry = (
    entry: Exclude<ReviewProgressEntry, { kind: 'progress_step' }>,
  ) => {
    const phaseLabel = getReviewTurnPhaseLabel(entry.phase);
    if (entry.kind === 'assistant_message') {
      return (
        <div key={entry.key} className="assistant-turn-node single-entry-node">
          <div className="assistant-turn-node-rail" aria-hidden="true">
            <span className="assistant-turn-node-dot response" />
            <span className="assistant-turn-node-line" />
          </div>
          <div className="assistant-turn-node-main">
            {fullAssistantBody ? (
              <details
                className="assistant-turn-card turn-item"
                open={entry.item.status !== 'in_progress'}
              >
                <summary className="turn-item-header turn-item-summary">
                  <span
                    className="turn-item-summary-icon response"
                    aria-hidden="true"
                  />
                  <div className="turn-item-summary-main">
                    <div className="turn-item-summary-top">
                      <span className="turn-item-kind response">
                        {t('timeline.response')}
                      </span>
                      {phaseLabel ? (
                        <span className="repo-review-progress-turn-tag">
                          {phaseLabel}
                        </span>
                      ) : null}
                      <span className="turn-item-title">
                        {t('timeline.aiConclusion')}
                      </span>
                      <span className={`turn-item-status ${entry.item.status}`}>
                        {getTurnItemStatusLabel(entry.item.status)}
                      </span>
                    </div>
                    <span className="turn-item-preview">
                      {truncateReviewPreview(entry.item.text)}
                    </span>
                  </div>
                </summary>
                <div className="turn-item-body turn-item-body-response">
                  <div className="turn-item-section">
                    <div className="turn-item-label">
                      {t('timeline.content')}
                    </div>
                    <div className="assistant-activity-text assistant-activity-text-block">
                      <span className="assistant-activity-body">
                        {entry.item.text}
                      </span>
                    </div>
                  </div>
                </div>
              </details>
            ) : (
              <div className="assistant-turn-card turn-item">
                <div className="turn-item-header">
                  <div className="turn-item-summary-main">
                    <div className="turn-item-summary-top">
                      <span className="turn-item-kind response">
                        {t('timeline.response')}
                      </span>
                      {phaseLabel ? (
                        <span className="repo-review-progress-turn-tag">
                          {phaseLabel}
                        </span>
                      ) : null}
                      <span className="turn-item-title">
                        {t('timeline.aiConclusion')}
                      </span>
                      <span className={`turn-item-status ${entry.item.status}`}>
                        {getTurnItemStatusLabel(entry.item.status)}
                      </span>
                    </div>
                    <span className="turn-item-preview">
                      {truncateReviewPreview(entry.item.text)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }
    if (entry.kind === 'reasoning') {
      return (
        <div key={entry.key} className="assistant-turn-node single-entry-node">
          <div className="assistant-turn-node-rail" aria-hidden="true">
            <span
              className={`assistant-turn-node-dot reasoning ${entry.item.status}`}
            />
            <span className="assistant-turn-node-line" />
          </div>
          <div className="assistant-turn-node-main">
            <details className="assistant-turn-card turn-item assistant-reasoning-card">
              <summary className="turn-item-header turn-item-summary">
                <span
                  className="turn-item-summary-icon reasoning"
                  aria-hidden="true"
                />
                <div className="turn-item-summary-main">
                  <div className="turn-item-summary-top">
                    <span className="turn-item-kind reasoning">
                      {t('timeline.thinking')}
                    </span>
                    {phaseLabel ? (
                      <span className="repo-review-progress-turn-tag">
                        {phaseLabel}
                      </span>
                    ) : null}
                    <span className="turn-item-title">
                      {entry.item.title || t('timeline.processing')}
                    </span>
                    <span className={`turn-item-status ${entry.item.status}`}>
                      {getTurnItemStatusLabel(entry.item.status)}
                    </span>
                  </div>
                  <span className="turn-item-preview assistant-reasoning-summary-text">
                    {truncateReviewPreview(
                      formatReviewReasoningText(
                        entry.item.title,
                        entry.item.text,
                      ),
                    )}
                  </span>
                </div>
              </summary>
              <div className="turn-item-body turn-item-body-reasoning">
                <div className="turn-item-section">
                  <div className="turn-item-label">{t('timeline.content')}</div>
                  <div className="assistant-activity-text assistant-activity-text-block">
                    <span className="assistant-activity-body">
                      {formatReviewReasoningText(
                        entry.item.title,
                        entry.item.text,
                      )}
                    </span>
                  </div>
                </div>
              </div>
            </details>
          </div>
        </div>
      );
    }
    if (entry.kind === 'tool_call') {
      return renderToolCallNode({
        key: entry.key,
        item: entry.item,
        kindLabel: t('timeline.tool'),
        open: entry.item.status === 'failed',
        phaseLabel,
      });
    }
    return (
      <div key={entry.key} className="repo-review-progress-error">
        {phaseLabel ? `${phaseLabel} · ` : ''}
        {entry.error}
      </div>
    );
  };

  const renderTurnGroup = (group: {
    groupKey: string;
    groupLabel: string;
    phases: Set<string>;
    entries: typeof turnEntries;
  }) => {
    const phaseLabels = Array.from(group.phases)
      .map((phase) => getReviewTurnPhaseLabel(phase))
      .filter(Boolean);
    const defaultOpen = !shouldCollapseTurnGroup(group.groupKey);
    return (
      <details
        key={`group:${group.groupKey}`}
        className="repo-review-progress-turn-group"
        open={defaultOpen}
      >
        <summary className="repo-review-progress-turn-group-header">
          <div className="repo-review-progress-turn-group-title-row">
            <span className="repo-review-progress-turn-group-title">
              {group.groupLabel}
            </span>
            {phaseLabels.map((label) => (
              <span
                key={`${group.groupKey}:${label}`}
                className="repo-review-progress-turn-tag"
              >
                {label}
              </span>
            ))}
          </div>
          <span className="repo-review-progress-turn-group-meta">
            {group.entries.length}
          </span>
        </summary>
        <div className="repo-review-progress-turn-group-body">
          {group.entries.map((entry) => renderTimelineEntry(entry))}
        </div>
      </details>
    );
  };

  const usedGroupKeys = new Set<string>();
  const remainingGroups = Array.from(turnGroups.values()).sort((left, right) =>
    left.timestamp === right.timestamp
      ? left.groupKey.localeCompare(right.groupKey)
      : left.timestamp.localeCompare(right.timestamp),
  );

  return (
    <div className="repo-review-progress-timeline">
      {stepEntries.map((entry) => {
        const matchingGroup = turnGroups.get(entry.groupKey);
        if (matchingGroup) {
          usedGroupKeys.add(entry.groupKey);
        }
        return (
          <div
            key={`step-group:${entry.key}`}
            className="repo-review-progress-step-group"
          >
            {renderToolCallNode({
              key: entry.key,
              item: buildProgressStepToolCallItem(entry.item),
              kindLabel: getProgressStepKindLabel(entry.item),
              open: entry.item.status === 'failed',
            })}
            {matchingGroup ? renderTurnGroup(matchingGroup) : null}
          </div>
        );
      })}
      {remainingGroups
        .filter((group) => !usedGroupKeys.has(group.groupKey))
        .map((group) => renderTurnGroup(group))}
    </div>
  );
}

export function RepoReviewDetailCard({
  title,
  summary,
  children,
  defaultOpen = true,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="repo-review-detail-card" open={defaultOpen}>
      <summary className="repo-review-detail-card-summary">
        <div className="repo-review-detail-card-title-row">
          <span className="repo-review-detail-card-title">{title}</span>
          {summary ? (
            <span className="repo-review-detail-card-meta">
              {truncateReviewPreview(summary, 180)}
            </span>
          ) : null}
        </div>
      </summary>
      <div className="repo-review-detail-card-body">{children}</div>
    </details>
  );
}
