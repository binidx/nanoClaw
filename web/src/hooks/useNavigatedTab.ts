import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NavPage } from '../app-types';
import { getUrlSubPath, navPageToPath } from '../router/paths';

/**
 * Shared hook for URL-driven tab routing.
 * Validates the URL sub-path against a set of valid tabs and
 * provides a setter that navigates via `replace`.
 */
export function useNavigatedTab<T extends string>(
  page: NavPage,
  validTabs: ReadonlySet<string>,
  defaultTab: T,
): [T, (tab: T) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const rawTab = getUrlSubPath(location.pathname);
  const activeTab = (validTabs.has(rawTab) ? rawTab : defaultTab) as T;
  const setActiveTab = useCallback(
    (tab: T) => navigate(navPageToPath(page, tab), { replace: true }),
    [navigate, page],
  );
  return [activeTab, setActiveTab];
}
