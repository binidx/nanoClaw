import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { RepoFeatureInfo, RepoReviewProfile, RepoReviewRun } from '../../app-types';
import { setRepoFeature } from './api';
import {
  fetchRepoReviewProfiles,
  fetchRepoReviewRunSummaries,
  fetchRepoReviewRemoteBranches,
} from '../repo-review/api';
import {
  buildReviewProgressEntries,
  ReviewProgressTimeline,
} from '../repo-review/ReviewProgressTimeline';

interface RepositoryReviewTabProps {
  repositoryId: string;
  features: RepoFeatureInfo[];
  apiBase: string;
  onFeatureChange?: () => void;
}

type SubTab = 'profile' | 'runs' | 'branches';

export function RepositoryReviewTab({
  repositoryId,
  features,
  apiBase,
  onFeatureChange,
}: RepositoryReviewTabProps) {
  const codeReview = features.find((f) => f.featureType === 'code_review');
  const isEnabled = codeReview?.enabled === true;

  if (!isEnabled) {
    return (
      <ReviewSetupGuide
        repositoryId={repositoryId}
        onEnable={onFeatureChange}
      />
    );
  }

  return (
    <ReviewConfigured
      repositoryId={repositoryId}
      apiBase={apiBase}
    />
  );
}

function ReviewSetupGuide({
  repositoryId,
  onEnable,
}: {
  repositoryId: string;
  onEnable?: () => void;
}) {
  const { t } = useTranslation('repoReview');
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnable = async () => {
    setEnabling(true);
    setError(null);
    try {
      await setRepoFeature(repositoryId, 'code_review', true, {});
      onEnable?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('reviewSetup.enableFailed'));
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div style={{ textAlign: 'center', padding: '48px 24px' }}>
      <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.4 }}>🔍</div>
      <h3 style={{ marginBottom: '8px', fontWeight: 500, color: 'var(--text-primary, #fff)' }}>
        {t('reviewSetup.notEnabled')}
      </h3>
      <p style={{ color: 'var(--text-secondary, #888)', fontSize: '14px', marginBottom: '24px', maxWidth: '400px', margin: '0 auto 24px' }}>
        {t('reviewSetup.description')}
      </p>
      {error && (
        <p style={{ color: 'var(--error-color, #f44336)', fontSize: '13px', marginBottom: '12px' }}>{error}</p>
      )}
      <button
        type="button"
        onClick={handleEnable}
        disabled={enabling}
        style={{
          padding: '10px 24px',
          borderRadius: '8px',
          border: 'none',
          background: 'var(--accent-color, #4a9eff)',
          color: '#fff',
          fontSize: '14px',
          fontWeight: 500,
          cursor: enabling ? 'wait' : 'pointer',
          opacity: enabling ? 0.7 : 1,
          transition: 'opacity 0.15s',
        }}
      >
        {enabling ? t('reviewSetup.enabling') : t('reviewSetup.enable')}
      </button>
    </div>
  );
}

function ReviewConfigured({
  repositoryId,
  apiBase,
}: {
  repositoryId: string;
  apiBase: string;
}) {
  const { t } = useTranslation('repoReview');
  const [subTab, setSubTab] = useState<SubTab>('profile');

  const subTabs: { key: SubTab; label: string }[] = [
    { key: 'profile', label: t('reviewTabs.profile') },
    { key: 'runs', label: t('reviewTabs.runs') },
    { key: 'branches', label: t('reviewTabs.branches') },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '0',
          borderBottom: '1px solid var(--border-color, #333)',
          marginBottom: '16px',
          alignItems: 'center',
        }}
      >
        {subTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSubTab(tab.key)}
            style={{
              padding: '6px 14px',
              border: 'none',
              borderBottom: subTab === tab.key ? '2px solid var(--accent-color, #4a9eff)' : '2px solid transparent',
              background: 'transparent',
              color: subTab === tab.key ? 'var(--text-primary, #fff)' : 'var(--text-secondary, #888)',
              cursor: 'pointer',
              fontWeight: subTab === tab.key ? 600 : 400,
              fontSize: '13px',
              transition: 'all 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
        <Link
          to="/reviews"
          title={t('reviewTabs.advancedManage')}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            fontSize: '12px',
            color: 'var(--accent-color, #4a9eff)',
            textDecoration: 'none',
            borderRadius: '4px',
            border: '1px solid var(--border-color, #333)',
          }}
        >
          {t('reviewTabs.advancedLink')}
        </Link>
      </div>

      {subTab === 'profile' && <ProfileSubTab repositoryId={repositoryId} apiBase={apiBase} />}
      {subTab === 'runs' && <RunsSubTab repositoryId={repositoryId} apiBase={apiBase} />}
      {subTab === 'branches' && <BranchesSubTab repositoryId={repositoryId} apiBase={apiBase} />}
    </div>
  );
}

function ProfileSubTab({ repositoryId, apiBase }: { repositoryId: string; apiBase: string }) {
  const { t } = useTranslation('repoReview');
  const [profiles, setProfiles] = useState<RepoReviewProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepoReviewProfiles(apiBase, repositoryId)
      .then((data) => { if (!cancelled) setProfiles(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('common.loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiBase, repositoryId, t]);

  if (loading) {
    return <div style={{ color: 'var(--text-secondary, #888)', padding: '24px', textAlign: 'center' }}>{t('common.loading')}</div>;
  }
  if (error) {
    return <div style={{ color: 'var(--error-color, #f44336)', padding: '16px', fontSize: '13px' }}>{error}</div>;
  }

  if (profiles.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-secondary, #888)' }}>
        <p>{t('profileTab.empty')}</p>
        <p style={{ fontSize: '13px' }}>{t('profileTab.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {profiles.map((p) => (
        <div
          key={p.id}
          style={{
            padding: '12px 16px',
            borderRadius: '8px',
            border: '1px solid var(--border-color, #333)',
            background: 'var(--card-bg, #1e1e1e)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <span style={{ color: p.enabled ? 'var(--success-color, #4caf50)' : 'var(--text-secondary, #888)' }}>
              {p.enabled ? '●' : '○'}
            </span>
            <span style={{ fontWeight: 500 }}>{p.name}</span>
            <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '3px', background: 'var(--tag-bg, #2a2a2a)', color: 'var(--text-secondary, #aaa)' }}>
              {p.stage === 'commit' ? t('profileTab.stageCommit') : t('profileTab.stagePush')}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <span>{t('profileTab.scope')}: {p.reviewScope}</span>
            <span>{t('profileTab.blocking')}: {p.blockingMode === 'hard_fail' ? t('profileTab.strict') : t('profileTab.lenient')}</span>
            {p.targetBranches.length > 0 && (
              <span>{t('profileTab.branches')}: {p.targetBranches.slice(0, 3).join(', ')}{p.targetBranches.length > 3 ? ` +${p.targetBranches.length - 3}` : ''}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RunsSubTab({
  repositoryId,
  apiBase,
}: {
  repositoryId: string;
  apiBase: string;
}) {
  const { t } = useTranslation('repoReview');
  const [runs, setRuns] = useState<RepoReviewRun[]>([]);
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepoReviewRunSummaries(apiBase, { repositoryId, limit: 20 })
      .then((data) => { if (!cancelled) setRuns(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('common.loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiBase, repositoryId, t]);

  if (loading) {
    return <div style={{ color: 'var(--text-secondary, #888)', padding: '24px', textAlign: 'center' }}>{t('common.loading')}</div>;
  }
  if (error) {
    return <div style={{ color: 'var(--error-color, #f44336)', padding: '16px', fontSize: '13px' }}>{error}</div>;
  }

  if (runs.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-secondary, #888)' }}>
        <p>{t('runsTab.empty')}</p>
        <p style={{ fontSize: '13px' }}>{t('runsTab.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {runs.map((run) => {
        const entries = buildReviewProgressEntries(run);
        return (
          <div
            key={run.id}
            style={{
              padding: '12px 16px',
              borderRadius: '8px',
              border: '1px solid var(--border-color, #333)',
              background: 'var(--card-bg, #1e1e1e)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '3px',
                background: run.overall === 'pass' ? 'rgba(76, 175, 80, 0.2)' :
                  run.overall === 'fail' ? 'rgba(244, 67, 54, 0.2)' :
                  run.overall === 'warn' ? 'rgba(255, 152, 0, 0.2)' : 'var(--tag-bg, #2a2a2a)',
                color: run.overall === 'pass' ? '#4caf50' :
                  run.overall === 'fail' ? '#f44336' :
                  run.overall === 'warn' ? '#ff9800' : 'var(--text-secondary, #888)',
              }}>
                {run.overall ?? run.status}
              </span>
              <span style={{ fontSize: '13px', fontWeight: 500 }}>{run.branch || '—'}</span>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginLeft: 'auto' }}>
                {run.createdAt ? new Date(run.createdAt).toLocaleString() : ''}
              </span>
            </div>
            {run.summary && (
              <p style={{ fontSize: '12px', color: 'var(--text-secondary, #aaa)', margin: '0 0 8px', lineHeight: 1.5 }}>
                {run.summary.length > 120 ? run.summary.slice(0, 120) + '...' : run.summary}
              </p>
            )}
            <ReviewProgressTimeline entries={entries} />
          </div>
        );
      })}
    </div>
  );
}

function BranchesSubTab({ repositoryId, apiBase }: { repositoryId: string; apiBase: string }) {
  const { t } = useTranslation('repoReview');
  const [branches, setBranches] = useState<{ name: string; defaultBranch: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepoReviewRemoteBranches(apiBase, repositoryId)
      .then((data) => {
        if (!cancelled) {
          setBranches(data.map((b) => ({ name: b.name, defaultBranch: b.defaultBranch })));
        }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('common.loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiBase, repositoryId, t]);

  if (loading) {
    return <div style={{ color: 'var(--text-secondary, #888)', padding: '24px', textAlign: 'center' }}>{t('common.loading')}</div>;
  }
  if (error) {
    return <div style={{ color: 'var(--error-color, #f44336)', padding: '16px', fontSize: '13px' }}>{error}</div>;
  }

  if (branches.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-secondary, #888)' }}>
        <p>{t('branchesTab.empty')}</p>
        <p style={{ fontSize: '13px' }}>{t('branchesTab.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {branches.map((b) => (
        <div
          key={b.name}
          style={{
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #333)',
            background: 'var(--card-bg, #1e1e1e)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontWeight: b.defaultBranch ? 600 : 400, fontSize: '13px' }}>{b.name}</span>
          {b.defaultBranch && (
            <span style={{
              fontSize: '10px',
              padding: '1px 5px',
              borderRadius: '3px',
              background: 'rgba(76, 175, 80, 0.15)',
              color: '#4caf50',
            }}>
              {t('branchesTab.default')}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
