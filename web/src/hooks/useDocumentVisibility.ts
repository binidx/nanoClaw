import { useState, useEffect } from 'react';

/**
 * Returns `true` when the browser tab is visible, `false` when hidden.
 * Polling intervals should skip requests when `visible === false`.
 */
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(
    () => document.visibilityState === 'visible',
  );

  useEffect(() => {
    const handler = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  return visible;
}
