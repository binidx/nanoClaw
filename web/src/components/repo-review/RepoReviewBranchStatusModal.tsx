import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RepoReviewCommitInfo, RepoReviewRun } from '../../app-types';
import { NcSelect } from '../common';
import { IconSearch } from '../AppIcons';
import { fetchRepoReviewBranchCommits } from './api';
import { RepoReviewModalShell } from './RepoReviewModalShell';
import type {
  RepoReviewBranchStateItem,
  RepoReviewManualReviewRequest,
} from './types';

const COMMIT_LIMIT_OPTIONS = [10, 20, 30, 50] as const;

export function RepoReviewBranchStatusModal({
  apiBase,
  repositoryId,
  repositoryName,
  initialBranch,
  branchLocked,
  items,
  runsByBranch,
  syncingBranchNames,
  onClose,
  onOpenRunDetail,
  onTriggerReview,
  formatShortSha,
  formatOptionalDateTime,
  formatRunOutcomeLabel,
  formatRunStageLabel,
}: {
  apiBase: string;
  repositoryId: string;
  repositoryName: string;
  initialBranch?: string;
  branchLocked?: boolean;
  items: RepoReviewBranchStateItem[];
  runsByBranch: Record<string, RepoReviewRun[]>;
  syncingBranchNames: string[];
  onClose: () => void;
  onOpenRunDetail: (run: RepoReviewRun) => void;
  onTriggerReview: (input: RepoReviewManualReviewRequest) => void;
  formatShortSha: (sha?: string) => string;
  formatOptionalDateTime: (value?: string) => string;
  formatRunOutcomeLabel: (status: string) => string;
  formatRunStageLabel: (stage: RepoReviewRun['stage']) => string;
}) {
  const { t } = useTranslation('repoReview');
  const [branchQuery, setBranchQuery] = useState('');
  const initialSelectedBranch =
    initialBranch || items[0]?.name || '';
  const [selectedBranchDraft, setSelectedBranchDraft] = useState(
    initialSelectedBranch,
  );
  const [commitLimit, setCommitLimit] =
    useState<(typeof COMMIT_LIMIT_OPTIONS)[number]>(20);
  const [branchCommits, setBranchCommits] = useState<RepoReviewCommitInfo[]>([]);
  const [loadingBranchCommits, setLoadingBranchCommits] = useState(false);
  const [branchCommitsError, setBranchCommitsError] = useState('');

  const filteredItems = useMemo(() => {
    if (branchLocked && initialBranch) {
      return items.filter((item) => item.name === initialBranch);
    }
    const keyword = branchQuery.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.name, item.actor, item.title, item.lastRun?.summary || '']
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [branchLocked, branchQuery, initialBranch, items]);

  const selectedBranch = filteredItems.some(
    (item) => item.name === selectedBranchDraft,
  )
    ? selectedBranchDraft
    : filteredItems[0]?.name || initialSelectedBranch;
  const selectedItem = useMemo(
    () =>
      filteredItems.find((item) => item.name === selectedBranch) ||
      filteredItems[0] ||
      null,
    [filteredItems, selectedBranch],
  );
  const selectedRuns = selectedItem ? runsByBranch[selectedItem.name] || [] : [];
  const latestRun = selectedRuns[0] || selectedItem?.lastRun || null;
  const isSyncing = selectedItem
    ? syncingBranchNames.includes(selectedItem.name) || selectedItem.isReviewing
    : false;
  const selectedFullFileProfileCount = selectedItem
    ? selectedItem.targetProfiles.filter(
        (profile) => profile.includeFullFileContext,
      ).length
    : 0;
  const selectedFullFileReviewLabel = selectedItem
    ? selectedItem.targetProfiles.length === 0
      ? t('branchStatus.noProfile')
      : selectedFullFileProfileCount === 0
        ? t('branchStatus.diffOnly')
        : selectedFullFileProfileCount === selectedItem.targetProfiles.length
          ? t('branchStatus.allFullFile')
          : t('branchStatus.partialFullFile', { enabled: selectedFullFileProfileCount, total: selectedItem.targetProfiles.length })
    : '';

  useEffect(() => {
    if (!selectedItem?.name) {
      setBranchCommits([]);
      setBranchCommitsError('');
      setLoadingBranchCommits(false);
      return;
    }
    let cancelled = false;
    setLoadingBranchCommits(true);
    setBranchCommitsError('');
    void fetchRepoReviewBranchCommits(
      apiBase,
      repositoryId,
      selectedItem.name,
      commitLimit,
    )
      .then((commits) => {
        if (cancelled) return;
        setBranchCommits(commits);
      })
      .catch((err) => {
        if (cancelled) return;
        setBranchCommits([]);
        setBranchCommitsError(
          err instanceof Error ? err.message : '加载分支提交记录失败',
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingBranchCommits(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, commitLimit, repositoryId, selectedItem?.name]);

  return (
    <RepoReviewModalShell
      className="repo-review-branch-status-modal"
      title={branchLocked ? t('branchStatus.selectBaseline') : t('branchStatus.viewAll')}
      subtitle={
        branchLocked
          ? `${repositoryName} · ${selectedItem?.name || initialBranch || ''}`
          : `${repositoryName} · ${t('branchStatus.branchCount', { count: items.length })}`
      }
      closeAriaLabel={t('branchStatusModal.closeLabel')}
      onClose={onClose}
    >
        {items.length === 0 ? (
          <div className="settings-hint">{t('branchStatus.noBranches')}</div>
        ) : (
          <div
            className={`repo-review-branch-status-layout ${
              branchLocked ? 'single-branch' : ''
            }`}
          >
            {branchLocked ? null : (
            <div className="repo-review-branch-status-sidebar">
              <div className="repo-review-branch-status-toolbar">
                <div className="repo-review-search-shell">
                  <span className="repo-review-search-icon" aria-hidden="true">
                    <IconSearch />
                  </span>
                  <input
                    className="repo-review-search-input"
                    value={branchQuery}
                    onChange={(event) => setBranchQuery(event.target.value)}
                    placeholder={t('branchStatus.searchPlaceholder')}
                  />
                </div>
                <div className="settings-hint">
                  {branchQuery.trim()
                    ? t('branchStatus.matched', { count: filteredItems.length })
                    : t('branchStatus.allBranches', { count: items.length })}
                </div>
              </div>
              <div className="repo-review-branch-status-list">
                {filteredItems.map((item) => {
                  const active = item.name === selectedItem?.name;
                  return (
                    <div
                      key={`${repositoryId}-${item.name}`}
                      className={`repo-review-branch-status-card ${active ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="repo-review-branch-status-card-select"
                        onClick={() => setSelectedBranchDraft(item.name)}
                      >
                        <div className="repo-review-run-header">
                          <div className="repo-review-run-title-block">
                            <strong>{item.name}</strong>
                            <div className="repo-review-run-meta">
                              {item.defaultBranch ? <span>{t('branchStatus.defaultBaseline')}</span> : null}
                              {item.headSha ? (
                                <span>{formatShortSha(item.headSha)}</span>
                              ) : null}
                            </div>
                          </div>
                          <div className="repo-review-run-badges">
                            <span
                              className={`repo-review-status-badge ${
                                item.lastRun
                                  ? `status-${item.lastRun.overall || item.lastRun.status}`
                                  : 'neutral'
                              }`}
                            >
                              {item.lastRun
                                ? formatRunOutcomeLabel(
                                    item.lastRun.overall || item.lastRun.status,
                                  )
                                : t('branchStatus.notReviewed')}
                            </span>
                          </div>
                        </div>
                        <div className="repo-review-spotlight-meta">
                          {item.actor ? <span>{item.actor}</span> : null}
                          {item.latestCommitAt ? (
                            <span>
                              {t('branchStatus.recentCommit', { time: formatOptionalDateTime(item.latestCommitAt) })}
                            </span>
                          ) : null}
                        </div>
                        <div
                          className="settings-hint repo-review-summary-preview"
                          title={item.lastRun?.summary || item.title || t('branchStatus.noSummary')}
                        >
                          {item.lastRun?.summary || item.title || t('branchStatus.noSummary')}
                        </div>
                      </button>
                      <div className="repo-review-inline-actions repo-review-history-actions">
                        <button
                          type="button"
                          className="btn-outline btn-sm repo-review-btn-compact"
                          onClick={(event) => {
                            event.stopPropagation();
                            onTriggerReview({
                              branch: item.name,
                              mode: 'auto',
                            });
                          }}
                          disabled={
                            item.isReviewing ||
                            syncingBranchNames.includes(item.name)
                          }
                        >
                          {item.isReviewing || syncingBranchNames.includes(item.name)
                            ? t('branchStatus.reviewing')
                            : t('branchStatus.reviewNow')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

            <div className="repo-review-branch-status-main">
              {selectedItem ? (
                <>
                  <div className="repo-review-card">
                    <div className="repo-review-card-header">
                      <div>
                        <h4>{selectedItem.name}</h4>
                        <div className="settings-hint repo-review-summary-preview">
                          {selectedItem.title || latestRun?.summary || t('branchStatus.noSummary')}
                        </div>
                      </div>
                      <div className="repo-review-inline-actions">
                        <button
                          type="button"
                          className="btn-primary btn-sm repo-review-btn-compact"
                          onClick={() =>
                            onTriggerReview({
                              branch: selectedItem.name,
                              mode: 'auto',
                            })
                          }
                          disabled={isSyncing}
                        >
                          {isSyncing ? t('branchStatus.reviewing') : t('branchStatus.reviewNow')}
                        </button>
                        {latestRun ? (
                          <button
                            type="button"
                            className="btn-outline btn-sm repo-review-btn-compact"
                            onClick={() =>
                              onTriggerReview({
                                branch: selectedItem.name,
                                mode: 'last_reviewed',
                                allowRepeat: true,
                              })
                            }
                            disabled={isSyncing}
                          >
                            {t('branchStatus.reReviewBaseline')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn-outline btn-sm repo-review-btn-compact"
                          onClick={() =>
                            onTriggerReview({
                              branch: selectedItem.name,
                              mode: 'full',
                              allowRepeat: true,
                            })
                          }
                          disabled={isSyncing}
                        >
                          {t('branchStatus.fullReview')}
                        </button>
                      </div>
                    </div>
                    <div className="repo-review-run-meta">
                      {selectedItem.defaultBranch ? <span>{t('branchStatus.defaultBaseline')}</span> : null}
                      {selectedItem.headSha ? (
                        <span>Head {formatShortSha(selectedItem.headSha)}</span>
                      ) : null}
                      {selectedItem.actor ? <span>{selectedItem.actor}</span> : null}
                      {latestRun?.baselineLabel ? (
                        <span>{latestRun.baselineLabel}</span>
                      ) : null}
                      {selectedItem.targetProfiles.length > 0 ? (
                        <span>{t('branchStatus.profileCount', { count: selectedItem.targetProfiles.length })}</span>
                      ) : (
                        <span>{t('branchStatus.noMatchingProfileShort')}</span>
                      )}
                    </div>
                    <div className="settings-hint">
                      {t('branchStatus.defaultBehavior')}
                      {t('branchStatus.defaultBehaviorHint')}
                    </div>
                    <div className="settings-hint">
                      {selectedFullFileReviewLabel}
                    </div>
                  </div>

                  <div className="repo-review-card">
                    <div className="repo-review-card-header">
                      <div>
                        <h4>{t('branchStatus.recentCommitBaseline')}</h4>
                        <div className="settings-hint">
                          {t('branchStatus.recentCommitHint')}
                        </div>
                      </div>
                      <label className="repo-review-branch-status-limit">
                        <span>{t('branchStatus.recentCommitCount')}</span>
                        <NcSelect
                          value={commitLimit}
                          onChange={(event) =>
                            setCommitLimit(Number(event.target.value) as 10 | 20 | 30 | 50)
                          }
                        >
                          {COMMIT_LIMIT_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </NcSelect>
                      </label>
                    </div>
                    {loadingBranchCommits ? (
                      <div className="repo-review-empty-hint">
                        {t('branchStatus.loadingCommits')}
                      </div>
                    ) : branchCommitsError ? (
                      <div className="repo-review-empty-hint">
                        {branchCommitsError}
                      </div>
                    ) : branchCommits.length === 0 ? (
                      <div className="repo-review-empty-hint">
                        {t('branchStatus.noCommits')}
                      </div>
                    ) : (
                      <div className="repo-review-run-list">
                        {branchCommits.map((commit) => {
                          const commitSha = commit.sha || '';
                          const isCurrentHead =
                            Boolean(commitSha) &&
                            commitSha === selectedItem.headSha;
                          return (
                            <div
                              key={`${selectedItem.name}-${commitSha || commit.commit}`}
                              className="repo-review-run-card"
                            >
                              <div className="repo-review-run-header">
                                <div className="repo-review-run-title-block">
                                  <strong>{commit.title || commit.commit}</strong>
                                  <div className="repo-review-run-meta">
                                    <span>{formatShortSha(commitSha || commit.commit)}</span>
                                    {commit.author ? <span>{commit.author}</span> : null}
                                    {commit.timestamp ? (
                                      <span>{formatOptionalDateTime(commit.timestamp)}</span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="repo-review-inline-actions repo-review-history-actions">
                                  <button
                                    type="button"
                                    className="btn-outline btn-sm repo-review-btn-compact"
                                    onClick={() =>
                                      onTriggerReview({
                                        branch: selectedItem.name,
                                        mode: 'commit_sha',
                                        baselineSha: commitSha,
                                        allowRepeat: true,
                                      })
                                    }
                                    disabled={isSyncing || !commitSha || isCurrentHead}
                                  >
                                    {isCurrentHead ? t('branchStatus.currentHead') : t('branchStatus.reviewFromCommit')}
                                  </button>
                                </div>
                              </div>
                              <div
                                className="repo-review-run-summary"
                                title={commit.message || commit.title || t('branchStatus.noCommitMessage')}
                              >
                                {commit.message || commit.title || t('branchStatus.noCommitMessage')}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {selectedRuns.length > 0 && (
                    <details className="repo-review-card">
                      <summary className="repo-review-card-header repo-review-card-header--summary">
                        <h4 className="repo-review-card-header-title">{t('branchStatus.history')}</h4>
                        <span className="settings-hint repo-review-card-header-meta">
                          {t('branchStatus.historyCount', { count: selectedRuns.length })}
                        </span>
                      </summary>
                      <div className="repo-review-run-list">
                        {selectedRuns.slice(0, 8).map((run) => (
                          <div
                            key={run.id}
                            className={`repo-review-run-card status-${run.overall || run.status}`}
                          >
                            <div className="repo-review-run-header">
                              <div className="repo-review-run-title-block">
                                <strong>
                                  {formatRunOutcomeLabel(run.overall || run.status)}
                                </strong>
                                <div className="repo-review-run-meta">
                                  <span>{formatOptionalDateTime(run.createdAt)}</span>
                                  <span>{formatRunStageLabel(run.stage)}</span>
                                  {run.baselineLabel ? (
                                    <span>{run.baselineLabel}</span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="repo-review-inline-actions repo-review-history-actions">
                                <button
                                  type="button"
                                  className="btn-outline btn-sm repo-review-btn-compact"
                                  onClick={() => onOpenRunDetail(run)}
                                >
                                  {t('branchStatus.viewDetails')}
                                </button>
                                <button
                                  type="button"
                                  className="btn-outline btn-sm repo-review-btn-compact"
                                  onClick={() =>
                                    onTriggerReview({
                                      branch: selectedItem.name,
                                      mode: 'history_run',
                                      baselineRunId: run.id,
                                      allowRepeat: true,
                                    })
                                  }
                                  disabled={isSyncing}
                                >
                                  {t('branchStatus.reviewFromRun')}
                                </button>
                              </div>
                            </div>
                            <div
                              className="repo-review-run-summary"
                              title={run.summary || run.error || t('branchStatus.noSummaryRun')}
                            >
                              {run.summary || run.error || t('branchStatus.noSummaryRun')}
                            </div>
                            <div className="repo-review-run-meta">
                              <span>
                                {formatShortSha(run.baseSha)} {'->'}{' '}
                                {formatShortSha(run.headSha)}
                              </span>
                              {run.actor ? <span>{run.actor}</span> : null}
                              {run.baselineLabel ? (
                                <span>{run.baselineLabel}</span>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : null}
            </div>
          </div>
        )}
    </RepoReviewModalShell>
  );
}
