import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RegistryCatalogItem } from '../../hooks/useRegistry';

export interface RegistryPanelProps {
  items: RegistryCatalogItem[];
  catalogName?: string;
  catalogDescription?: string;
  loading: boolean;
  error: string;
  search: string;
  onSearchChange: (value: string) => void;
  typeFilter: 'skill' | 'mcp' | 'bundle' | undefined;
  onTypeFilterChange: (value: 'skill' | 'mcp' | 'bundle' | undefined) => void;
  onInstall: (slug: string) => Promise<boolean>;
  onRefresh: () => void;
  installingSlug: string | null;
  installedSlugs: Set<string>;
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'Skill',
  mcp: 'MCP',
  bundle: 'Bundle',
};

function formatStars(stars: number | undefined): string {
  if (!stars) return '';
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return String(stars);
}

export function RegistryPanel({
  items,
  catalogName,
  catalogDescription,
  loading,
  error,
  search,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  onInstall,
  onRefresh,
  installingSlug,
  installedSlugs,
}: RegistryPanelProps) {
  const { t } = useTranslation('apps');
  const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set());

  const handleInstall = async (slug: string) => {
    const ok = await onInstall(slug);
    if (ok) {
      setJustInstalled((prev) => new Set(prev).add(slug));
    }
  };

  return (
    <div className="registry-panel">
      {catalogName && (
        <div className="registry-panel__header">
          <h3 className="registry-panel__title">{catalogName}</h3>
          {catalogDescription && (
            <p className="registry-panel__desc">{catalogDescription}</p>
          )}
        </div>
      )}

      <div className="public-library-panel__toolbar">
        <input
          type="search"
          className="public-library-panel__search"
          placeholder={t('registry.searchPlaceholder')}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <div className="filter-group" role="group" aria-label={t('filter.type')}>
          <button
            type="button"
            className={`filter-btn ${!typeFilter ? 'active' : ''}`}
            onClick={() => onTypeFilterChange(undefined)}
          >
            {t('filter.all')}
          </button>
          {(['skill', 'mcp', 'bundle'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`filter-btn ${typeFilter === t ? 'active' : ''}`}
              onClick={() => onTypeFilterChange(t)}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? t('library.refreshing') : t('library.refresh')}
        </button>
      </div>

      {error && (
        <div className="apps-v2-error" role="alert">{error}</div>
      )}

      <div className="app-card-grid">
        {loading && items.length === 0 && (
          <div className="app-card-grid__empty">{t('store.loading')}</div>
        )}
        {!loading && items.length === 0 && (
          <div className="app-card-grid__empty">{t('store.noContent')}</div>
        )}
        {items.map((item) => {
          const isInstalled = installedSlugs.has(item.slug) || justInstalled.has(item.slug);
          const isInstalling = installingSlug === item.slug;
          return (
            <div key={item.slug} className="app-card">
              <div className="app-card__header">
                <div className="app-card__icon">
                  {item.type === 'mcp' ? (
                    <span aria-hidden="true">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 22v-5" />
                        <path d="M9 8V2" />
                        <path d="M15 8V2" />
                        <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
                      </svg>
                    </span>
                  ) : item.type === 'bundle' ? (
                    <span aria-hidden="true">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                        <polyline points="3.29 7 12 12 20.71 7" />
                        <line x1="12" y1="22" x2="12" y2="12" />
                      </svg>
                    </span>
                  ) : (
                    <span aria-hidden="true">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                      </svg>
                    </span>
                  )}
                </div>
                <div className="app-card__title-group">
                  <div className="app-card__title">{item.name}</div>
                  <div className="app-card__badges">
                    <span className={`app-badge app-badge--${item.type}`}>
                      {TYPE_LABELS[item.type] || item.type}
                    </span>
                    <span className="app-badge app-badge--marketplace">{t('store.marketplace')}</span>
                    {item.stars != null && item.stars > 0 && (
                      <span className="app-badge app-badge--stars" title={`${item.stars} stars`}>
                        ★ {formatStars(item.stars)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {item.description && (
                <div className="app-card__description">{item.description}</div>
              )}

              {item.author && (
                <div className="app-card__author">by {item.author}</div>
              )}

              {item.tags.length > 0 && (
                <div className="app-card__tags">
                  {item.tags.map((tag, i) => (
                    <span key={`${tag}-${i}`} className="app-card__tag">{tag}</span>
                  ))}
                </div>
              )}

              <div className="app-card__actions">
                {isInstalled ? (
                  <span className="app-badge app-badge--installed">{t('store.installed')}</span>
                ) : (
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    onClick={() => handleInstall(item.slug)}
                    disabled={isInstalling}
                  >
                    {isInstalling ? t('action.installing') : t('action.install')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
