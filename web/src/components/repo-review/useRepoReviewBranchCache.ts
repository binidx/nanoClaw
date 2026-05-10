import { useCallback, useRef } from 'react';

import type { RepoReviewBranchSummary } from '../../app-types';

type RepoReviewBranchCacheEntry = {
  branches: RepoReviewBranchSummary[];
  cachedAt: number;
};

export function useRepoReviewBranchCache(staleMs = 90_000) {
  const cacheRef = useRef(new Map<string, RepoReviewBranchCacheEntry>());

  const getCachedBranches = useCallback(
    (repositoryId: string): RepoReviewBranchSummary[] | null => {
      const entry = cacheRef.current.get(repositoryId);
      if (!entry) return null;
      if (Date.now() - entry.cachedAt > staleMs) {
        cacheRef.current.delete(repositoryId);
        return null;
      }
      return entry.branches;
    },
    [staleMs],
  );

  const setCachedBranches = useCallback(
    (repositoryId: string, branches: RepoReviewBranchSummary[]) => {
      cacheRef.current.set(repositoryId, {
        branches,
        cachedAt: Date.now(),
      });
    },
    [],
  );

  const invalidateBranchCache = useCallback((repositoryId?: string) => {
    if (repositoryId) {
      cacheRef.current.delete(repositoryId);
      return;
    }
    cacheRef.current.clear();
  }, []);

  return {
    getCachedBranches,
    setCachedBranches,
    invalidateBranchCache,
  };
}
