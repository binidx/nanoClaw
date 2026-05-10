import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PublicLibraryItemType } from '../../app-types';
import type { UsePublicLibraryReturn } from '../../hooks/usePublicLibrary';
import type { UseRegistryReturn, RegistryCatalogItem } from '../../hooks/useRegistry';
import { AppCard, type AppCardSource } from './AppCard';
import { AppCardGrid } from './AppCardGrid';
import { MarketSourceAdmin } from './MarketSourceAdmin';

type StoreSection = 'shared' | 'registry';
type CombinedTypeFilter = 'mcp' | 'skill' | 'bundle' | undefined;

export interface StorePanelProps {
  apiBase: string;
  isAdmin?: boolean;
  library: UsePublicLibraryReturn;
  registry: UseRegistryReturn;
  installedIds: Set<string>;
  installedRegistrySlugs: Set<string>;
  onRegistryInstall: (slug: string) => Promise<boolean>;
  onLibraryInstall: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
  onLibraryDelete?: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
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

function getLibrarySource(source: string | undefined): AppCardSource {
  return source === 'marketplace' ? 'marketplace' : 'shared';
}

export function StorePanel({
  apiBase,
  isAdmin,
  library,
  registry,
  installedIds,
  installedRegistrySlugs,
  onRegistryInstall,
  onLibraryInstall,
  onLibraryDelete,
}: StorePanelProps) {
  const { t } = useTranslation('apps');
  const [section, setSection] = useState<StoreSection>('registry');
  const [typeFilter, setTypeFilter] = useState<CombinedTypeFilter>(undefined);
  const [search, setSearch] = useState('');
  const [installingLibId, setInstallingLibId] = useState<string | null>(null);
  const [justInstalledSlugs, setJustInstalledSlugs] = useState<Set<string>>(new Set());
  const [showSourceAdmin, setShowSourceAdmin] = useState(false);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (section === 'shared') {
      library.setSearch(value);
    } else {
      registry.setSearch(value);
    }
  };

  const handleSectionChange = (s: StoreSection) => {
    setSection(s);
    setSearch('');
    library.setSearch('');
    registry.setSearch('');
  };

  const handleTypeFilterChange = (f: CombinedTypeFilter) => {
    setTypeFilter(f);
    if (section === 'shared') {
      library.setTypeFilter(f === 'bundle' ? undefined : (f as PublicLibraryItemType | undefined));
    } else {
      registry.setTypeFilter(f as 'skill' | 'mcp' | 'bundle' | undefined);
    }
  };

  const handleRefresh = () => {
    if (section === 'shared') {
      library.refresh();
    } else {
      registry.refresh();
    }
  };

  const handleLibInstall = async (itemId: string, itemType: PublicLibraryItemType) => {
    setInstallingLibId(itemId);
    try {
      await onLibraryInstall(itemId, itemType);
    } finally {
      setInstallingLibId(null);
    }
  };

  const handleLibDelete = async (itemId: string, itemType: PublicLibraryItemType) => {
    if (!onLibraryDelete) return;
    if (!window.confirm(t('confirm.removeFromPublicLibrary'))) return;
    await onLibraryDelete(itemId, itemType);
  };

  const handleRegistryInstall = async (slug: string) => {
    const ok = await onRegistryInstall(slug);
    if (ok) {
      setJustInstalledSlugs((prev) => new Set(prev).add(slug));
    }
  };

  const loading = section === 'shared' ? library.loading : registry.loading;
  const error = section === 'registry' ? registry.error : '';

  const typeFilterOptions = section === 'registry'
    ? (['skill', 'mcp', 'bundle'] as const)
    : (['mcp', 'skill'] as const);

  return (
    <div className="store-panel">
      <div className="store-panel__nav">
        <div className="store-panel__sections" role="group" aria-label={t('store.appSource')}>
          <button
            type="button"
            className={`filter-btn ${section === 'registry' ? 'active' : ''}`}
            onClick={() => handleSectionChange('registry')}
          >
            {t('store.marketSource')}
          </button>
          <button
            type="button"
            className={`filter-btn ${section === 'shared' ? 'active' : ''}`}
            onClick={() => handleSectionChange('shared')}
          >
            {t('store.userShared')}
          </button>
        </div>

        {isAdmin && (
          <button
            type="button"
            className="btn-outline btn-xs store-panel__source-mgmt"
            onClick={() => setShowSourceAdmin(!showSourceAdmin)}
            title={t('store.manageSource')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{t('store.sourceManage')}</span>
          </button>
        )}
      </div>

      {showSourceAdmin && isAdmin && (
        <div className="store-panel__source-admin-wrapper">
          <MarketSourceAdmin apiBase={apiBase} />
        </div>
      )}

      <div className="public-library-panel__toolbar">
        <input
          type="search"
          className="public-library-panel__search"
          placeholder={section === 'shared' ? t('store.searchShared') : t('store.searchMarket')}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        <div className="filter-group" role="group" aria-label={t('filter.type')}>
          <button
            type="button"
            className={`filter-btn ${!typeFilter ? 'active' : ''}`}
            onClick={() => handleTypeFilterChange(undefined)}
          >
            {t('filter.all')}
          </button>
          {typeFilterOptions.map((t) => (
            <button
              key={t}
              type="button"
              className={`filter-btn ${typeFilter === t ? 'active' : ''}`}
              onClick={() => handleTypeFilterChange(t)}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <button type="button" className="btn-outline btn-sm" onClick={handleRefresh} disabled={loading}>
          {loading ? t('library.refreshing') : t('library.refresh')}
        </button>
      </div>

      {error && (
        <div className="apps-v2-error" role="alert">{error}</div>
      )}

      {section === 'shared' && (
        <>
          {library.total > 0 && (
            <div className="public-library-panel__count">{t('library.total', { count: library.total })}</div>
          )}
          <AppCardGrid loading={library.loading} empty={t('store.noShared')}>
            {library.items.map((item) => (
              <AppCard
                key={item.id}
                id={item.id}
                name={item.name}
                description={item.description}
                variant={item.type}
                source={getLibrarySource(item.source)}
                tags={item.tags}
                onInstall={() => handleLibInstall(item.id, item.type)}
                installing={installingLibId === item.id}
                installed={installedIds.has(item.id)}
                onDelete={isAdmin ? () => handleLibDelete(item.id, item.type) : undefined}
                isOwner={isAdmin}
              />
            ))}
          </AppCardGrid>
        </>
      )}

      {section === 'registry' && (
        <>
          {registry.catalog && (
            <div className="registry-panel__header">
              <h3 className="registry-panel__title">{registry.catalog.name}</h3>
              {registry.catalog.description && (
                <p className="registry-panel__desc">{registry.catalog.description}</p>
              )}
            </div>
          )}
          <RegistryGrid
            items={registry.items}
            loading={registry.loading}
            installingSlug={registry.installingSlug}
            installedSlugs={installedRegistrySlugs}
            justInstalledSlugs={justInstalledSlugs}
            onInstall={handleRegistryInstall}
          />
        </>
      )}
    </div>
  );
}

function RegistryGrid({
  items,
  loading,
  installingSlug,
  installedSlugs,
  justInstalledSlugs,
  onInstall,
}: {
  items: RegistryCatalogItem[];
  loading: boolean;
  installingSlug: string | null;
  installedSlugs: Set<string>;
  justInstalledSlugs: Set<string>;
  onInstall: (slug: string) => void;
}) {
  const { t } = useTranslation('apps');
  return (
    <div className="app-card-grid">
      {loading && items.length === 0 && (
        <div className="app-card-grid__empty">{t('store.loading')}</div>
      )}
      {!loading && items.length === 0 && (
        <div className="app-card-grid__empty">{t('store.noContent')}</div>
      )}
      {items.map((item) => {
        const isInstalled = installedSlugs.has(item.slug) || justInstalledSlugs.has(item.slug);
        const isInstalling = installingSlug === item.slug;
        return (
          <div key={item.slug} className="app-card">
            <div className="app-card__header">
              <div className="app-card__icon">
                {item.type === 'mcp' ? (
                  <span aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
                    </svg>
                  </span>
                ) : item.type === 'bundle' ? (
                  <span aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
                    </svg>
                  </span>
                ) : (
                  <span aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                  </span>
                )}
              </div>
              <div className="app-card__title-group">
                <div className="app-card__title">{item.name}</div>
                <div className="app-card__badges">
                  <span className={`app-badge app-badge--${item.type}`}>{TYPE_LABELS[item.type] || item.type}</span>
                  <span className="app-badge app-badge--marketplace">{t('store.marketplace')}</span>
                  {item.stars != null && item.stars > 0 && (
                    <span className="app-badge app-badge--stars" title={`${item.stars} stars`}>★ {formatStars(item.stars)}</span>
                  )}
                </div>
              </div>
            </div>
            {item.description && <div className="app-card__description">{item.description}</div>}
            {item.author && <div className="app-card__author">by {item.author}</div>}
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
                <button type="button" className="btn-primary btn-sm" onClick={() => onInstall(item.slug)} disabled={isInstalling}>
                  {isInstalling ? t('action.installing') : t('action.install')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
