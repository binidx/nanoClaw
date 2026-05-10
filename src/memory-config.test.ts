import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('memory config integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await import('./db.js');
    db._initTestDatabase();
  });

  it('exposes conservative memory defaults through web config metadata and values', async () => {
    const configStore = await import('./config-store.js');
    const effectiveConfig = await configStore.getEffectiveWebConfig();
    const metadata = configStore.getWebConfigMetadata();

    expect(effectiveConfig.MEMORY_ENABLED).toBe('true');
    expect(effectiveConfig.MEMORY_READ_ENABLED).toBe('true');
    expect(effectiveConfig.MEMORY_WRITE_MODE).toBe('daily-only');
    expect(effectiveConfig.MEMORY_GLOBAL_WRITE_ENABLED).toBe('false');
    expect(effectiveConfig.MEMORY_AUTO_SAVE_ENABLED).toBe('false');
    expect(effectiveConfig.MEMORY_SEARCH_SCOPE_DEFAULT).toBe('group');
    expect(effectiveConfig.MEMORY_SEARCH_MAX_RESULTS).toBe('5');
    expect(effectiveConfig.MEMORY_PROMPT_INJECTION_ENABLED).toBe('true');
    expect(effectiveConfig.MEMORY_PROMPT_MAX_SNIPPETS).toBe('3');
    expect(effectiveConfig.MEMORY_PROMPT_TOKEN_BUDGET).toBe('0');
    expect(effectiveConfig.MEMORY_PROMPT_RECENT_RATIO).toBe('35');
    expect(effectiveConfig.MEMORY_PROMPT_SUMMARY_RATIO).toBe('25');
    expect(effectiveConfig.MEMORY_PROMPT_RECALL_RATIO).toBe('25');
    expect(effectiveConfig.MEMORY_COMPACTION_ENABLED).toBe('true');
    expect(effectiveConfig.MEMORY_COMPACTION_TRIGGER_ENTRIES).toBe('40');
    expect(effectiveConfig.MEMORY_COMPACTION_KEEP_RECENT_ENTRIES).toBe('12');

    expect(
      metadata.some(
        (entry) =>
          entry.key === 'MEMORY_WRITE_MODE' && entry.effect === 'new_agent',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'MEMORY_SEARCH_SCOPE_DEFAULT' &&
          entry.summary.includes('group、global、all'),
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'MEMORY_COMPACTION_TRIGGER_ENTRIES' &&
          entry.label === '压缩触发条数',
      ),
    ).toBe(true);
    expect(
      metadata.some(
        (entry) =>
          entry.key === 'MEMORY_PROMPT_TOKEN_BUDGET' &&
          entry.summary.includes('token 预算'),
      ),
    ).toBe(true);
  });

  it('normalizes memory config entries with strict bounds', async () => {
    const routes = await import('./routes/admin-settings-routes.js');

    expect(routes.normalizeMemoryConfigEntry('MEMORY_ENABLED', 'TRUE')).toBe(
      'true',
    );
    expect(
      routes.normalizeMemoryConfigEntry('MEMORY_WRITE_MODE', 'DAILY-ONLY'),
    ).toBe('daily-only');
    expect(
      routes.normalizeMemoryConfigEntry(
        'MEMORY_SEARCH_SCOPE_DEFAULT',
        'GLOBAL',
      ),
    ).toBe('global');
    expect(
      routes.normalizeMemoryConfigEntry('MEMORY_SEARCH_MAX_RESULTS', '8'),
    ).toBe('8');
    expect(
      routes.normalizeMemoryConfigEntry('MEMORY_PROMPT_MAX_SNIPPETS', '0'),
    ).toBe('0');
    expect(
      routes.normalizeMemoryConfigEntry('MEMORY_PROMPT_TOKEN_BUDGET', '2048'),
    ).toBe('2048');
    expect(
      routes.normalizeMemoryConfigEntry('MEMORY_PROMPT_RECENT_RATIO', '40'),
    ).toBe('40');
    expect(
      routes.normalizeMemoryConfigEntry(
        'MEMORY_COMPACTION_TRIGGER_ENTRIES',
        '120',
      ),
    ).toBe('120');
    expect(
      routes.normalizeMemoryConfigEntry(
        'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
        '20',
      ),
    ).toBe('20');

    expect(() =>
      routes.normalizeMemoryConfigEntry('MEMORY_ENABLED', 'maybe'),
    ).toThrow(/expected true or false/i);
    expect(() =>
      routes.normalizeMemoryConfigEntry('MEMORY_WRITE_MODE', 'global'),
    ).toThrow(/expected one of/i);
    expect(() =>
      routes.normalizeMemoryConfigEntry('MEMORY_SEARCH_MAX_RESULTS', '99'),
    ).toThrow(/between 1 and 8/i);
    expect(() =>
      routes.normalizeMemoryConfigEntry('MEMORY_PROMPT_TOKEN_BUDGET', '12001'),
    ).toThrow(/between 0 and 12000/i);
    expect(() =>
      routes.normalizeMemoryConfigEntry(
        'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
        '-1',
      ),
    ).toThrow(/between 1 and 100/i);
  });
});
