import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  PublicLibraryItem,
  PublicLibraryItemType,
  PublicLibraryResult,
  MarketplaceSourceView,
} from '../app-types';

export interface UsePublicLibraryReturn {
  items: PublicLibraryItem[];
  total: number;
  marketplaceSources: MarketplaceSourceView[];
  loading: boolean;
  error: string;
  search: string;
  setSearch: (value: string) => void;
  typeFilter: PublicLibraryItemType | undefined;
  setTypeFilter: (value: PublicLibraryItemType | undefined) => void;
  refresh: () => Promise<void>;
  install: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
  deleteItem: (itemId: string, itemType: PublicLibraryItemType) => Promise<boolean>;
}

export function usePublicLibrary(apiBase: string): UsePublicLibraryReturn {
  const [items, setItems] = useState<PublicLibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [marketplaceSources, setMarketplaceSources] = useState<MarketplaceSourceView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<PublicLibraryItemType | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSetSearch = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      params.set('limit', '100');
      const res = await fetch(`${apiBase}/api/public-library?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load');
      const data: PublicLibraryResult = await res.json();
      setItems(data.items);
      setTotal(data.total);
      setMarketplaceSources(data.marketplaceSources);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load public library');
    } finally {
      setLoading(false);
    }
  }, [apiBase, typeFilter, debouncedSearch]);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = useCallback(async (itemId: string, itemType: PublicLibraryItemType) => {
    try {
      const res = await fetch(`${apiBase}/api/public-library/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, itemType }),
      });
      if (!res.ok) return false;
      await refresh();
      return true;
    } catch {
      return false;
    }
  }, [apiBase, refresh]);

  const deleteItem = useCallback(async (itemId: string, itemType: PublicLibraryItemType) => {
    try {
      const res = await fetch(`${apiBase}/api/public-library/${itemType}/${itemId}`, {
        method: 'DELETE',
      });
      if (!res.ok) return false;
      await refresh();
      return true;
    } catch {
      return false;
    }
  }, [apiBase, refresh]);

  return {
    items,
    total,
    marketplaceSources,
    loading,
    error,
    search,
    setSearch: handleSetSearch,
    typeFilter,
    setTypeFilter,
    refresh,
    install,
    deleteItem,
  };
}
