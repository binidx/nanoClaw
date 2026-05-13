import { useTranslation } from 'react-i18next';

import type { RepoReviewRun } from '../../app-types';
import {
  RepoReviewDetailCard,
  ReviewProgressTimeline,
  type ReviewProgressEntry,
} from './ReviewProgressTimeline';
import { RepoReviewModalShell } from './RepoReviewModalShell';

function formatEvidenceBytes(value?: number) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatEvidenceStatus(value?: string) {
  if (value === 'ready') return 'ready';
  if (value === 'stale') return 'stale';
  if (value === 'error') return 'error';
  if (value === 'missing') return 'missing';
  return 'unknown';
}

export function RepoReviewRunDetailModal({
  run,
  loading,
  repositoryName,
  profileName,
  progressEntries,
  onClose,
  formatRunTitle,
  formatResultStateLabel,
  getDeliveryTone,
  resolveChatDeliveryStatus,
  resolvePlatformDeliveryStatus,
  formatDeliveryStatusLabel,
  formatRunStageLabel,
  formatRunSourceLabel,
  formatBaselineSourceLabel,
  formatShortSha,
  formatDurationMs,
  getRunDurationMs,
}: {
  run: RepoReviewRun;
  loading: boolean;
  repositoryName: string;
  profileName: string;
  progressEntries: ReviewProgressEntry[];
  onClose: () => void;
  formatRunTitle: (run: RepoReviewRun) => string;
  formatResultStateLabel: (run: RepoReviewRun) => string;
  getDeliveryTone: (status: string) => string;
  resolveChatDeliveryStatus: (run: RepoReviewRun) => string;
  resolvePlatformDeliveryStatus: (run: RepoReviewRun) => string;
  formatDeliveryStatusLabel: (status: string) => string;
  formatRunStageLabel: (stage: RepoReviewRun['stage']) => string;
  formatRunSourceLabel: (source: string) => string;
  formatBaselineSourceLabel: (source?: string) => string;
  formatShortSha: (sha?: string) => string;
  formatDurationMs: (value?: number) => string;
  getRunDurationMs: (run: RepoReviewRun) => number | undefined;
}) {
  const { t } = useTranslation('repoReview');
  const chatDeliveryStatus = resolveChatDeliveryStatus(run);
  const platformDeliveryStatus = resolvePlatformDeliveryStatus(run);

  return (
    <RepoReviewModalShell
      className="repo-review-run-detail-modal"
      title={formatRunTitle(run)}
      subtitle={
        <>
          {repositoryName}
          {' · '}
          {profileName}
          {' · '}
          {run.branch || run.ref || t('runDetail.noBranch')}
        </>
      }
      closeAriaLabel={t('runDetail.closeLabel')}
      onClose={onClose}
    >
      <div className="repo-review-run-detail-body">
        {loading ? (
          <div className="settings-hint">{t('runDetail.refreshing')}</div>
        ) : null}
        <div className="repo-review-run-badges">
          <span
            className={`repo-review-status-badge status-${
              run.overall || run.status
            }`}
          >
            {formatResultStateLabel(run)}
          </span>
          <span
            className={`repo-review-source-pill tone-${getDeliveryTone(
              chatDeliveryStatus,
            )}`}
          >
            {t('runDetail.notification')}{' '}
            {formatDeliveryStatusLabel(chatDeliveryStatus)}
          </span>
          <span
            className={`repo-review-source-pill tone-${getDeliveryTone(
              platformDeliveryStatus,
            )}`}
          >
            {t('runDetail.platform')}{' '}
            {formatDeliveryStatusLabel(platformDeliveryStatus)}
          </span>
          {run.manualDecision ? (
            <span className="repo-review-source-pill tone-warning">
              {t('runDetail.manual')}{' '}
              {run.manualDecision === 'pass'
                ? t('runDetail.pass')
                : t('runDetail.fail')}
            </span>
          ) : null}
        </div>
        <div className="status-detail-grid repo-review-run-detail-grid">
          <div className="status-detail-item">
            <span className="status-detail-label">{t('runDetail.runId')}</span>
            <strong className="status-detail-value">{run.id}</strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.stageSource')}
            </span>
            <strong className="status-detail-value">
              {formatRunStageLabel(run.stage)} ·{' '}
              {formatRunSourceLabel(run.source)}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.branchRef')}
            </span>
            <strong className="status-detail-value">
              {run.branch || '-'}
              {run.ref ? ` · ${run.ref}` : ''}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.baselineSource')}
            </span>
            <strong className="status-detail-value">
              {formatBaselineSourceLabel(run.baselineSource)}
              {run.baselineRef
                ? ` · ${run.baselineRef}`
                : run.baseSha
                  ? ` · ${formatShortSha(run.baseSha)}`
                  : ''}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.commitRange')}
            </span>
            <strong className="status-detail-value">
              {formatShortSha(run.baseSha)} {'->'} {formatShortSha(run.headSha)}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.duration')}
            </span>
            <strong className="status-detail-value">
              {formatDurationMs(getRunDurationMs(run))}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.manualDecision')}
            </span>
            <strong className="status-detail-value">
              {run.manualDecision
                ? `${run.manualDecision === 'pass' ? t('runDetail.pass') : t('runDetail.fail')}${run.manualDecisionBy ? ` · ${run.manualDecisionBy}` : ''}`
                : run.passDecisionMode === 'human' &&
                    run.stage === 'push' &&
                    run.status === 'completed'
                  ? t('runDetail.pendingHuman')
                  : t('runDetail.aiAuto')}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.chatDelivery')}
            </span>
            <strong className="status-detail-value">
              {formatDeliveryStatusLabel(chatDeliveryStatus)}
              {run.deliveryRetryCount
                ? t('runDetail.deliveryRetry', {
                    count: run.deliveryRetryCount,
                  })
                : ''}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.platformWrite')}
            </span>
            <strong className="status-detail-value">
              {formatDeliveryStatusLabel(platformDeliveryStatus)}
              {run.platformCommentUrl
                ? t('runDetail.commentLinkGenerated')
                : ''}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.createdAt')}
            </span>
            <strong className="status-detail-value">
              {new Date(run.createdAt).toLocaleString()}
            </strong>
          </div>
          <div className="status-detail-item">
            <span className="status-detail-label">
              {t('runDetail.completedAt')}
            </span>
            <strong className="status-detail-value">
              {run.completedAt
                ? new Date(run.completedAt).toLocaleString()
                : run.status === 'running'
                  ? t('runDetail.running')
                  : '-'}
            </strong>
          </div>
          {run.idempotencyKey ? (
            <div className="status-detail-item">
              <span className="status-detail-label">
                {t('runDetail.idempotencyKey')}
              </span>
              <strong className="status-detail-value">
                {run.idempotencyKey}
              </strong>
            </div>
          ) : null}
          {run.platformCommentUrl ? (
            <div className="status-detail-item">
              <span className="status-detail-label">
                {t('runDetail.platformComment')}
              </span>
              <strong className="status-detail-value">
                <a
                  href={run.platformCommentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('runDetail.openCommentLink')}
                </a>
              </strong>
            </div>
          ) : null}
        </div>
        {run.lastDeliveryError || run.error ? (
          <div className="repo-review-progress-error">
            {run.lastDeliveryError || run.error}
          </div>
        ) : null}
        {run.executionStats ? (
          <div className="status-detail-grid repo-review-evidence-status-grid">
            <div className="status-detail-item">
              <span className="status-detail-label">CodeMap</span>
              <strong className="status-detail-value">
                {formatEvidenceStatus(run.executionStats.codeMapContextStatus)}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">Code Index</span>
              <strong className="status-detail-value">
                {formatEvidenceStatus(
                  run.executionStats.codeIndexContextStatus,
                )}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">Evidence</span>
              <strong className="status-detail-value">
                {formatEvidenceBytes(run.executionStats.evidenceBundleBytes)}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">Changed functions</span>
              <strong className="status-detail-value">
                {run.executionStats.changedFunctionCount ?? 0}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">Subagent tools</span>
              <strong className="status-detail-value">
                {run.executionStats.subagentToolCallCount ?? 0}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">Main tools</span>
              <strong className="status-detail-value">
                {run.executionStats.mainReadonlyToolCallCount ?? 0}
              </strong>
            </div>
          </div>
        ) : null}
        <div className="repo-review-run-detail-stack">
          {run.summary ? (
            <RepoReviewDetailCard
              title={t('runDetail.runSummary')}
              summary={run.summary}
            >
              <div className="repo-review-detail-section">
                <div>{run.summary}</div>
              </div>
            </RepoReviewDetailCard>
          ) : null}
          {progressEntries.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.aiAnalysis', {
                count: progressEntries.length,
              })}
              summary={
                run.status === 'running'
                  ? t('runDetail.aiAnalysisRunning')
                  : t('runDetail.aiAnalysisComplete')
              }
              defaultOpen
            >
              <ReviewProgressTimeline
                entries={progressEntries}
                fullAssistantBody
              />
            </RepoReviewDetailCard>
          ) : run.status === 'running' ? (
            <RepoReviewDetailCard
              title={t('runDetail.aiAnalysisTitle')}
              summary={t('runDetail.aiAnalysisWaiting')}
              defaultOpen
            >
              <div className="settings-hint">
                {t('runDetail.aiAnalysisNoSteps')}
              </div>
            </RepoReviewDetailCard>
          ) : null}
          {run.findings.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.findings', { count: run.findings.length })}
              summary={run.findings[0]?.title}
              defaultOpen
            >
              <div className="repo-review-run-findings">
                {run.findings.map((finding, index) => (
                  <div key={`${run.id}-finding-${index}`}>
                    [{finding.severity}]{' '}
                    {finding.file ? `${finding.file}: ` : ''}
                    {finding.title}
                    {finding.detail ? ` · ${finding.detail}` : ''}
                    {finding.suggestion && (
                      <div className="repo-review-finding-suggestion">
                        {t('runDetail.suggestion')}
                        {finding.suggestion}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </RepoReviewDetailCard>
          ) : null}
          {run.commitReviews.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.commitReviews', {
                count: run.commitReviews.length,
              })}
              summary={run.commitReviews[0]?.title}
            >
              <div className="repo-review-run-findings">
                {run.commitReviews.map((review) => (
                  <div key={`${run.id}-${review.commit}-${review.title}`}>
                    {review.commit || '(unknown)'} {review.title}
                    {review.author ? ` · ${review.author}` : ''}
                    {review.issues[0]
                      ? ` · ${t('runDetail.issues')}${review.issues[0]}`
                      : review.positives[0]
                        ? ` · ${t('runDetail.positives')}${review.positives[0]}`
                        : ''}
                  </div>
                ))}
              </div>
            </RepoReviewDetailCard>
          ) : run.commitDetails.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.commitList', {
                count: run.commitDetails.length,
              })}
              summary={run.commitDetails[0]?.title}
            >
              <div className="repo-review-run-findings">
                {run.commitDetails.map((commit) => (
                  <div key={`${run.id}-${commit.commit}-${commit.title}`}>
                    {commit.commit || '(unknown)'} {commit.title}
                    {commit.author ? ` · ${commit.author}` : ''}
                  </div>
                ))}
              </div>
            </RepoReviewDetailCard>
          ) : null}
          {run.changedFiles.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.changedFiles', {
                count: run.changedFiles.length,
              })}
              summary={run.changedFiles[0]}
            >
              <div className="repo-review-run-files">
                {run.changedFiles.map((file) => (
                  <span key={`${run.id}-${file}`}>{file}</span>
                ))}
              </div>
            </RepoReviewDetailCard>
          ) : null}
          {run.suggestions.length > 0 ? (
            <RepoReviewDetailCard
              title={t('runDetail.suggestions', {
                count: run.suggestions.length,
              })}
              summary={run.suggestions[0]}
            >
              <div className="repo-review-run-findings">
                {run.suggestions.map((suggestion, index) => (
                  <div key={`${run.id}-suggestion-${index}`}>{suggestion}</div>
                ))}
              </div>
            </RepoReviewDetailCard>
          ) : null}
        </div>
      </div>
    </RepoReviewModalShell>
  );
}
