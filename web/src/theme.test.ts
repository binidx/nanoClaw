import { describe, expect, it } from 'vitest';

import {
  applyThemeToDocument,
  resolveThemeMode,
  THEME_STORAGE_KEY,
} from './theme';

describe('theme helpers', () => {
  it('prefers a stored theme over system preference', () => {
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
  });

  it('falls back to system preference when storage is empty', () => {
    expect(resolveThemeMode(null, true)).toBe('dark');
    expect(resolveThemeMode(undefined, false)).toBe('light');
  });

  it('applies the resolved theme to both html and body datasets', () => {
    const target = {
      documentElement: { dataset: {} as Record<string, string> },
      body: { dataset: {} as Record<string, string> },
    };

    applyThemeToDocument(target, 'dark');

    expect(target.documentElement.dataset.theme).toBe('dark');
    expect(target.body.dataset.theme).toBe('dark');
  });

  it('uses the stable localStorage key for theme persistence', () => {
    expect(THEME_STORAGE_KEY).toBe('nanoclaw-theme');
  });
});
