import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RepoDescription } from './code-map-api';
import { fetchRepoDescription, generateRepoDescription } from './code-map-api';

export interface CodeMapRepoOverviewProps {
  apiBase: string;
  repositoryId: string;
  branch: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function CodeMapRepoOverview({
  apiBase,
  repositoryId,
  branch,
  collapsed = false,
  onToggleCollapse,
}: CodeMapRepoOverviewProps) {
  const { t } = useTranslation('codeMap');
  const [desc, setDesc] = useState<RepoDescription | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [noAi, setNoAi] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    setNoAi(false);
    setLoading(true);
    fetchRepoDescription(apiBase, repositoryId, branch)
      .then((r) => { if (!cancelled) setDesc(r.description); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('overview.loadFailed')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [apiBase, repositoryId, branch]);

  const handleGenerate = useCallback(async (force = false) => {
    setGenerating(true);
    setError('');
    setNoAi(false);
    try {
      const r = await generateRepoDescription(apiBase, repositoryId, branch, force);
      setDesc(r.description);
      if (r.noAi) setNoAi(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('overview.generateFailed'));
    } finally {
      setGenerating(false);
    }
  }, [apiBase, repositoryId, branch]);

  const handleHeaderKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleCollapse?.();
    }
  }, [onToggleCollapse]);

  const langEntries = useMemo(() => {
    if (!desc?.stats.languages) return [];
    return Object.entries(desc.stats.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [desc]);

  const totalLangFiles = useMemo(() => {
    return langEntries.reduce((s, [, c]) => s + c, 0);
  }, [langEntries]);

  if (loading) {
    return (
      <div className="codemap-repo-overview codemap-repo-overview-loading">
        <div className="codemap-ro-loading-dot" />
        <span>{t('overview.loading')}</span>
      </div>
    );
  }

  if (!desc) {
    return (
      <div className="codemap-repo-overview codemap-repo-overview-empty">
        <div className="codemap-ro-empty-inner">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
            <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M6 7h8M6 10h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span>{t('overview.noDescription')}</span>
          <button
            className="codemap-ro-gen-btn"
            onClick={() => handleGenerate(false)}
            disabled={generating}
          >
            {generating ? t('overview.generating') : t('overview.generate')}
          </button>
        </div>
        {error && <div className="codemap-ro-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className={`codemap-repo-overview${collapsed ? ' codemap-ro-collapsed' : ''}`}>
      <div className="codemap-ro-header" onClick={onToggleCollapse} onKeyDown={handleHeaderKeyDown} role="button" tabIndex={0} aria-expanded={!collapsed}>
        <div className="codemap-ro-header-left">
          <svg className="codemap-ro-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.25"/>
            <path d="M4.5 5.5h7M4.5 8h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
          </svg>
          <span className="codemap-ro-title">{t('overview.title')}</span>
        </div>
        <div className="codemap-ro-header-right">
          <button
            className="codemap-ro-refresh-btn"
            title={t('overview.regenerate')}
            onClick={(e) => { e.stopPropagation(); handleGenerate(true); }}
            disabled={generating}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={generating ? 'codemap-ro-spin' : ''}>
              <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M8 1v3l2.5-1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <svg
            className={`codemap-ro-chevron${collapsed ? '' : ' codemap-ro-chevron-open'}`}
            width="12" height="12" viewBox="0 0 16 16" fill="none"
          >
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {error && <div className="codemap-ro-error">{error}</div>}

      {!collapsed && (
        <div className="codemap-ro-body">
          {noAi && (
            <div className="codemap-ro-noai-hint">{t('overview.noProvider')}</div>
          )}

          {desc.overview && (
            <p className="codemap-ro-overview">{desc.overview}</p>
          )}

          {desc.architecture && (
            <p className="codemap-ro-arch">
              <strong>{t('overview.architecture')}</strong> {desc.architecture}
            </p>
          )}

          {desc.techStack.length > 0 && (
            <div className="codemap-ro-section">
              <span className="codemap-ro-label">{t('overview.techStack')}</span>
              <div className="codemap-ro-tags">
                {desc.techStack.map((t) => (
                  <span key={t} className="codemap-ro-tag">{t}</span>
                ))}
              </div>
            </div>
          )}

          {langEntries.length > 0 && (
            <div className="codemap-ro-section">
              <span className="codemap-ro-label">{t('overview.langDistribution')}</span>
              <div className="codemap-ro-lang-bars">
                {langEntries.map(([lang, count]) => (
                  <div key={lang} className="codemap-ro-lang-row">
                    <span className="codemap-ro-lang-name">{lang}</span>
                    <div className="codemap-ro-lang-bar-track">
                      <div
                        className="codemap-ro-lang-bar-fill"
                        style={{ width: `${Math.max(4, (count / totalLangFiles) * 100)}%` }}
                      />
                    </div>
                    <span className="codemap-ro-lang-count">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {desc.modules.length > 0 && (
            <div className="codemap-ro-section">
              <span className="codemap-ro-label">{t('overview.modules')}</span>
              <div className="codemap-ro-modules">
                {desc.modules.slice(0, 10).map((m) => (
                  <div key={m.directory} className="codemap-ro-module">
                    <div className="codemap-ro-module-header">
                      <span className="codemap-ro-module-name">{m.name}</span>
                      <span className="codemap-ro-module-stats">
                        {t('overview.moduleStats', { fileCount: m.fileCount, lineCount: m.lineCount })}
                      </span>
                    </div>
                    {m.description && (
                      <p className="codemap-ro-module-desc">{m.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {desc.entryPoints.length > 0 && (
            <div className="codemap-ro-section">
              <span className="codemap-ro-label">{t('overview.entryFiles')}</span>
              <div className="codemap-ro-entries">
                {desc.entryPoints.slice(0, 5).map((ep) => (
                  <div key={ep.file} className="codemap-ro-entry">
                    <code className="codemap-ro-entry-file">{ep.file}</code>
                    <span className="codemap-ro-entry-desc">{ep.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="codemap-ro-footer">
            <span className="codemap-ro-gen-time">
              {t('overview.generatedAt', { time: (() => { const d = new Date(desc.generatedAt); return Number.isFinite(d.getTime()) ? d.toLocaleString() : desc.generatedAt; })() })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
