import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PublicLibraryItem,
  PublicLibraryItemType,
} from '../../app-types';
import { AppCard, type AppCardSource } from './AppCard';
import { AppCardGrid } from './AppCardGrid';

export interface PublicLibraryPanelProps {
  items: PublicLibraryItem[];
  total: number;
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  typeFilter: PublicLibraryItemType | undefined;
  onTypeFilterChange: (value: PublicLibraryItemType | undefined) => void;
  onInstall: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
  onDelete?: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
  onRefresh: () => void;
  installedIds?: Set<string>;
  isAdmin?: boolean;
}

function getSource(item: PublicLibraryItem): AppCardSource {
  if (item.source === 'marketplace') return 'marketplace';
  return 'shared';
}

export function PublicLibraryPanel({
  items,
  total,
  loading,
  search,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  onInstall,
  onDelete,
  onRefresh,
  installedIds,
  isAdmin,
}: PublicLibraryPanelProps) {
  const { t } = useTranslation('apps');
  const [installingId, setInstallingId] = useState<string | null>(null);

  const handleInstall = async (item: PublicLibraryItem) => {
    setInstallingId(item.id);
    try {
      await onInstall(item.id, item.type);
    } finally {
      setInstallingId(null);
    }
  };

  const handleDelete = async (item: PublicLibraryItem) => {
    if (!onDelete) return;
    if (!window.confirm(t('confirm.deleteFromLibrary', { name: item.name }))) return;
    await onDelete(item.id, item.type);
  };

  return (
    <div className="public-library-panel">
      <div className="public-library-panel__toolbar">
        <input
          type="search"
          className="public-library-panel__search"
          placeholder={t('store.searchLibrary')}
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
          <button
            type="button"
            className={`filter-btn ${typeFilter === 'mcp' ? 'active' : ''}`}
            onClick={() => onTypeFilterChange('mcp')}
          >
            MCP
          </button>
          <button
            type="button"
            className={`filter-btn ${typeFilter === 'skill' ? 'active' : ''}`}
            onClick={() => onTypeFilterChange('skill')}
          >
            Skill
          </button>
        </div>
        <button type="button" className="btn-outline btn-sm" onClick={onRefresh} disabled={loading}>
          {loading ? t('library.refreshing') : t('library.refresh')}
        </button>
      </div>

      {total > 0 && (
        <div className="public-library-panel__count">
          {t('library.total', { count: total })}
        </div>
      )}

      <AppCardGrid loading={loading} empty={t('library.empty')}>
        {items.map((item) => (
          <AppCard
            key={item.id}
            id={item.id}
            name={item.name}
            description={item.description}
            variant={item.type}
            source={getSource(item)}
            tags={item.tags}
            onInstall={() => handleInstall(item)}
            installing={installingId === item.id}
            installed={installedIds?.has(item.id)}
            onDelete={isAdmin ? () => handleDelete(item) : undefined}
            isOwner={isAdmin}
          />
        ))}
      </AppCardGrid>
    </div>
  );
}
