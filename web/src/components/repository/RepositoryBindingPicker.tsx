import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResourceBindingInfo, RepositoryInfo } from '../../app-types';
import {
  fetchRepositories,
  fetchResourceBindings,
  createResourceBinding,
  deleteResourceBinding,
} from './api';

export interface RepositoryBindingPickerProps {
  ownerType: 'assistant' | 'workflow';
  ownerId: string;
  onBindingChange?: () => void;
  /** Extra action buttons per binding (e.g. provision, switch-branch) */
  renderActions?: (binding: ResourceBindingInfo) => React.ReactNode;
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 14px',
  borderRadius: '8px',
  border: '1px solid var(--border-color, #333)',
  background: 'var(--card-bg, #1e1e1e)',
  marginBottom: '8px',
};

const labelStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary, #888)',
  marginBottom: '4px',
  display: 'block',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  borderRadius: '6px',
  border: '1px solid var(--border-color, #333)',
  background: 'var(--input-bg, #2a2a2a)',
  color: 'var(--text-primary, #fff)',
  fontSize: '13px',
};

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: '6px',
  border: '1px solid var(--border-color, #444)',
  background: 'var(--btn-bg, #333)',
  color: 'var(--text-primary, #fff)',
  cursor: 'pointer',
  fontSize: '12px',
};

const dangerBtnStyle: React.CSSProperties = {
  ...btnStyle,
  color: '#f87171',
  borderColor: '#7f1d1d',
};

export function RepositoryBindingPicker({
  ownerType,
  ownerId,
  onBindingChange,
  renderActions,
}: RepositoryBindingPickerProps) {
  const { t } = useTranslation('repoReview');
  const [bindings, setBindings] = useState<ResourceBindingInfo[]>([]);
  const [allRepos, setAllRepos] = useState<RepositoryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [branchInput, setBranchInput] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [b, r] = await Promise.all([
        fetchResourceBindings(ownerType, ownerId),
        fetchRepositories(),
      ]);
      setBindings(b);
      setAllRepos(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('repo.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [ownerType, ownerId]);

  useEffect(() => {
    let cancelled = false;
    refresh().then(() => {
      if (cancelled) return;
    });
    return () => { cancelled = true; };
  }, [refresh]);

  const boundRepoIds = new Set(bindings.map((b) => b.resourceId));
  const availableRepos = allRepos.filter((r) => !boundRepoIds.has(r.id));

  const handleAdd = async () => {
    if (!selectedRepoId) return;
    setSaving(true);
    try {
      await createResourceBinding({
        ownerType,
        ownerId,
        repositoryId: selectedRepoId,
        branch: branchInput || undefined,
      });
      setSelectedRepoId('');
      setBranchInput('');
      setAddOpen(false);
      await refresh();
      onBindingChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('repo.bindFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm(t('repo.confirmUnbind'))) return;
    try {
      await deleteResourceBinding(id);
      await refresh();
      onBindingChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('repo.unbindFailed'));
    }
  };

  if (loading && bindings.length === 0) {
    return <div style={{ fontSize: '13px', color: 'var(--text-secondary, #888)', padding: '8px 0' }}>{t('common.loading')}</div>;
  }

  return (
    <div>
      {error && (
        <div style={{ color: '#f87171', fontSize: '12px', marginBottom: '8px' }}>{error}</div>
      )}

      {bindings.length === 0 && !addOpen && (
        <div style={{ fontSize: '13px', color: 'var(--text-secondary, #888)', marginBottom: '8px' }}>
          {t('repo.noBindings')}
        </div>
      )}

      {bindings.map((b) => (
        <div key={b.id} style={cardStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary, #fff)' }}>
              {b.repositoryName || b.resourceId}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginTop: '2px' }}>
              {b.repositoryCloneUrl && (
                <span style={{ marginRight: '10px' }}>{b.repositoryCloneUrl}</span>
              )}
              {b.branch && (
                <span style={{
                  padding: '1px 6px',
                  borderRadius: '4px',
                  background: 'var(--tag-bg, #333)',
                  fontSize: '11px',
                }}>
                  {b.branch}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            {renderActions?.(b)}
            <button
              style={dangerBtnStyle}
              onClick={() => handleRemove(b.id)}
            >
              {t('repo.unbind')}
            </button>
          </div>
        </div>
      ))}

      {bindings.length > 1 && (
        <div style={{
          fontSize: '11px',
          color: 'var(--text-warning, #fbbf24)',
          padding: '6px 10px',
          marginBottom: '8px',
          borderRadius: '6px',
          background: 'var(--warning-bg, rgba(251,191,36,0.08))',
          border: '1px solid var(--warning-border, rgba(251,191,36,0.2))',
        }}>
          {t('repo.multipleBindings')}
        </div>
      )}

      {!addOpen ? (
        <button
          style={{ ...btnStyle, marginTop: '4px' }}
          onClick={() => setAddOpen(true)}
          disabled={availableRepos.length === 0 && !loading}
        >
          + {t('repo.bindRepo')}
        </button>
      ) : (
        <div style={{
          padding: '12px',
          borderRadius: '8px',
          border: '1px solid var(--border-color, #333)',
          background: 'var(--card-bg, #1e1e1e)',
          marginTop: '8px',
        }}>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>{t('repo.selectRepo')}</label>
            <select
              value={selectedRepoId}
              onChange={(e) => setSelectedRepoId(e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="">{t('repo.selectRepoPlaceholder')}</option>
              {availableRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{r.cloneUrl ? ` (${r.cloneUrl})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>{t('repo.branchOptional')}</label>
            <input
              type="text"
              placeholder={t('repo.branchPlaceholder')}
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              style={{ ...btnStyle, opacity: saving || !selectedRepoId ? 0.5 : 1 }}
              disabled={saving || !selectedRepoId}
              onClick={handleAdd}
            >
              {saving ? t('repo.binding') : t('repo.confirmBind')}
            </button>
            <button
              style={btnStyle}
              onClick={() => { setAddOpen(false); setSelectedRepoId(''); setBranchInput(''); }}
            >
              {t('repo.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
