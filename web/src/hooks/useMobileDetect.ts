import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

function getMobileSnapshot(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (typeof window.matchMedia !== 'function') {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }
  return window.matchMedia(MOBILE_QUERY).matches;
}

function subscribeMobileChanges(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  if (typeof window.matchMedia !== 'function') {
    window.addEventListener('resize', onStoreChange);
    return () => window.removeEventListener('resize', onStoreChange);
  }
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

export function useMobileDetect(): boolean {
  return useSyncExternalStore(
    subscribeMobileChanges,
    getMobileSnapshot,
    () => false,
  );
}
