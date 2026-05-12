import { useTranslation } from 'react-i18next';

import type { RepoReviewDigestRun } from '../../app-types';
import { RepoReviewDetailCard } from './ReviewProgressTimeline';
import { RepoReviewModalShell } from './RepoReviewModalShell';

export function RepoReviewDigestRunDetailModal({
  run,
  loading,
  repositoryName,
  onClose,
  formatDigestRunTypeLabel,
  formatDigestRunStatusLabel,
  formatDigestDeliveryStatusLabel,
  getDeliveryTone,
  formatDurationMs,
}: {
  run: RepoReviewDigestRun;
  loading: boolean;
  repositoryName: string;
  onClose: () => void;
  formatDigestRunTypeLabel: (type: RepoReviewDigestRun['type']) => string;
  formatDigestRunStatusLabel: (status: string) => string;
  formatDigestDeliveryStatusLabel: (status: string) => string;
  getDeliveryTone: (status: string) => string;
  formatDurationMs: (value?: number) => string;
}) {
  const { t } = useTranslation('repoReview');
  const errorText = run.deliveryError || run.errorMessage;

  return (
    <RepoReviewModalShell
      className="repo-review-run-detail-modal"
      title={t('digest.detailTitle', { type: formatDigestRunTypeLabel(run.type) })}
      subtitle={
        <>
          {repositoryName}
          {' · '}
          {new Date(run.scheduledFor || run.createdAt).toLocaleString()}
        </>
      }
      closeAriaLabel={t('digest.closeLabel')}
      onClose={onClose}
    >
        <div className="repo-review-run-detail-body">
          {loading ? (
            <div className="settings-hint">{t('digest.refreshing')}</div>
          ) : null}
          <div className="repo-review-run-badges">
            <span
              className={`repo-review-status-badge status-${run.status || 'completed'}`}
            >
              {formatDigestRunStatusLabel(run.status)}
            </span>
            <span
              className={`repo-review-source-pill tone-${getDeliveryTone(run.deliveryStatus)}`}
            >
              {t('digest.delivery', { status: formatDigestDeliveryStatusLabel(run.deliveryStatus) })}
            </span>
            {run.timezone ? (
              <span className="repo-review-source-pill tone-neutral">
                {t('digest.timezone', { tz: run.timezone })}
              </span>
            ) : null}
          </div>
          <div className="status-detail-grid repo-review-run-detail-grid">
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.runId')}</span>
              <strong className="status-detail-value">{run.id}</strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.type')}</span>
              <strong className="status-detail-value">
                {formatDigestRunTypeLabel(run.type)}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.scheduledTime')}</span>
              <strong className="status-detail-value">
                {run.scheduledFor
                  ? new Date(run.scheduledFor).toLocaleString()
                  : '-'}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.statWindow')}</span>
              <strong className="status-detail-value">
                {run.periodStart
                  ? new Date(run.periodStart).toLocaleString()
                  : '-'}
                {' -> '}
                {run.periodEnd ? new Date(run.periodEnd).toLocaleString() : '-'}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.startComplete')}</span>
              <strong className="status-detail-value">
                {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'}
                {' · '}
                {run.completedAt
                  ? new Date(run.completedAt).toLocaleString()
                  : run.status === 'running'
                    ? t('runDetail.running')
                    : '-'}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.duration')}</span>
              <strong className="status-detail-value">
                {formatDurationMs(run.durationMs)}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.branchesCommitsContributors')}</span>
              <strong className="status-detail-value">
                {run.branchCount} / {run.commitCount} / {run.contributorCount}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.cloudDoc')}</span>
              <strong className="status-detail-value">
                {run.cloudDocStatus || t('digest.notGenerated')}
                {run.cloudDocUrl ? t('digest.linkGenerated') : ''}
              </strong>
            </div>
            <div className="status-detail-item">
              <span className="status-detail-label">{t('digest.createdAt')}</span>
              <strong className="status-detail-value">
                {run.createdAt ? new Date(run.createdAt).toLocaleString() : '-'}
              </strong>
            </div>
          </div>
          {errorText ? (
            <div className="repo-review-progress-error">{errorText}</div>
          ) : null}
          <div className="repo-review-run-detail-stack">
            {run.summary ? (
              <RepoReviewDetailCard title={t('digest.summary')} summary={run.summary}>
                <div className="repo-review-detail-section">
                  <div>{run.summary}</div>
                </div>
              </RepoReviewDetailCard>
            ) : null}
            {run.cloudDocUrl ? (
              <RepoReviewDetailCard title={t('digest.cloudDocTitle')} summary={run.cloudDocStatus}>
                <div className="repo-review-detail-section">
                  <a href={run.cloudDocUrl} target="_blank" rel="noreferrer">
                    {t('digest.openCloudDoc')}
                  </a>
                </div>
              </RepoReviewDetailCard>
            ) : null}
          </div>
        </div>
    </RepoReviewModalShell>
  );
}
