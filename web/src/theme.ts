export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'nanoclaw-theme';

export function resolveThemeMode(
  storedTheme: string | null | undefined,
  prefersDark: boolean,
): ThemeMode {
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }
  return prefersDark ? 'dark' : 'light';
}

export function resolveInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }

  return resolveThemeMode(
    window.localStorage.getItem(THEME_STORAGE_KEY),
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
}

export function applyThemeToDocument(
  target:
    | {
        documentElement: { dataset: Record<string, string | undefined> };
        body?: { dataset: Record<string, string | undefined> } | null;
      }
    | Document,
  theme: ThemeMode,
): void {
  target.documentElement.dataset.theme = theme;
  if (target.body) {
    target.body.dataset.theme = theme;
  }
}
