import { useCallback, useEffect, useRef, useState } from 'react';

export interface RegistryCatalogItem {
  slug: string;
  name: string;
  description: string;
  type: 'skill' | 'mcp' | 'bundle';
  source: { kind: string; repo: string; ref?: string };
  tags: string[];
  author?: string;
  version?: string;
  stars?: number;
  iconUrl?: string;
}

export interface RegistryCatalog {
  name: string;
  description: string;
  items: RegistryCatalogItem[];
  updatedAt: string;
}

export interface UseRegistryReturn {
  catalog: RegistryCatalog | null;
  items: RegistryCatalogItem[];
  loading: boolean;
  error: string;
  search: string;
  setSearch: (value: string) => void;
  typeFilter: 'skill' | 'mcp' | 'bundle' | undefined;
  setTypeFilter: (value: 'skill' | 'mcp' | 'bundle' | undefined) => void;
  refresh: () => Promise<void>;
  install: (slug: string) => Promise<boolean>;
  installingSlug: string | null;
}

export function useRegistry(apiBase: string): UseRegistryReturn {
  const [catalog, setCatalog] = useState<RegistryCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'skill' | 'mcp' | 'bundle' | undefined>(undefined);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSetSearch = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  }, []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const fetchCatalog = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      if (forceRefresh) params.set('refresh', '1');
      const res = await fetch(`${apiBase}/api/registry/catalog?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load registry catalog');
      const data: RegistryCatalog = await res.json();
      setCatalog(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiBase, typeFilter, debouncedSearch]);

  const refresh = useCallback(async () => {
    await fetchCatalog(true);
  }, [fetchCatalog]);

  useEffect(() => { void fetchCatalog(false); }, [fetchCatalog]);

  const install = useCallback(async (slug: string) => {
    setInstallingSlug(slug);
    try {
      const res = await fetch(`${apiBase}/api/registry/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Install failed' }));
        throw new Error(data.error || 'Install failed');
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed');
      return false;
    } finally {
      setInstallingSlug(null);
    }
  }, [apiBase]);

  const items = catalog?.items ?? [];

  return {
    catalog,
    items,
    loading,
    error,
    search,
    setSearch: handleSetSearch,
    typeFilter,
    setTypeFilter,
    refresh,
    install,
    installingSlug,
  };
}
