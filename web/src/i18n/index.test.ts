// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

import i18n, { initI18n } from './index';

describe('i18n alias precedence', () => {
  beforeAll(async () => {
    await initI18n();
    await i18n.changeLanguage('zh');
  });

  it('preserves explicit prefixed pagination keys over generated aliases', () => {
    expect(i18n.t('common.pagination.total', { total: 12 })).toBe('共 12 条');
    expect(i18n.t('pagination.total', { count: 12 })).toBe('共 12 条');
  });
});
