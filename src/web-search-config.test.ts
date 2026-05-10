import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('web-search-config', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await import('./db.js');
    db._initTestDatabase();
  });

  it('normalizes bounded web search config entries', async () => {
    const config = await import('./config/web-search-config.js');

    expect(
      config.normalizeWebSearchConfigEntry('WEB_SEARCH_PROVIDER', 'TAVILY'),
    ).toBe('tavily');
    expect(
      config.normalizeWebSearchConfigEntry('WEB_FETCH_PROVIDER', 'BROWSER_CLI'),
    ).toBe('browser_cli');
    expect(
      config.normalizeWebSearchConfigEntry(
        'WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
        true,
      ),
    ).toBe('true');
    expect(
      config.normalizeWebSearchConfigEntry(
        'WEB_FETCH_BROWSER_SITE_PROFILES',
        '[{"domains":["cloud.tencent.com"],"forceProvider":"browser_cli","waitSelector":".article","postWaitMs":999999}]',
      ),
    ).toContain('"postWaitMs": 30000');
    expect(
      config.normalizeWebSearchConfigEntry('WEB_FETCH_PAGE_SIZE', '999999'),
    ).toBe('20000');
    expect(
      config.normalizeWebSearchConfigEntry('WEB_FETCH_MAX_CHARS', '10'),
    ).toBe('500');
  });

  it('builds runner env from effective config values', async () => {
    const db = await import('./db.js');
    await db.setConfig('WEB_SEARCH_PROVIDER', 'searxng');
    await db.setConfig('WEB_FETCH_PROVIDER', 'browser_cli');
    await db.setConfig('WEB_FETCH_USE_BUILTIN_SITE_PROFILES', 'true');
    await db.setConfig('WEB_FETCH_PAGE_SIZE', '4096');
    await db.setConfig(
      'WEB_FETCH_BROWSER_COMMAND',
      '["node","scripts/render-fetch.mjs","{url}"]',
    );
    await db.setConfig(
      'WEB_FETCH_BROWSER_SITE_PROFILES',
      '[{"domains":["cloud.tencent.com"],"pathPrefixes":["/developer/article/"],"forceProvider":"browser_cli","waitSelector":".article","postWaitMs":1500,"viewport":"1440x1200"}]',
    );
    await db.setConfig(
      'WEB_SEARCH_ALLOWED_DOMAINS',
      'docs.example.com\napi.example.com',
    );
    await db.setConfig('WEB_SEARCH_SEARXNG_BASE_URL', 'https://searx.example.com/');

    const config = await import('./config/web-search-config.js');
    expect(await config.getEffectiveWebSearchConfig()).toMatchObject({
      provider: 'searxng',
      fetchProvider: 'browser_cli',
      fetchUseBuiltinSiteProfiles: true,
      pageSize: 4096,
      fetchBrowserCommand: '["node","scripts/render-fetch.mjs","{url}"]',
      fetchBrowserSiteProfiles: [
        expect.objectContaining({
          domains: ['cloud.tencent.com'],
          pathPrefixes: ['/developer/article/'],
          forceProvider: 'browser_cli',
          waitSelector: '.article',
          postWaitMs: 1500,
          viewport: '1440x1200',
        }),
      ],
      allowedDomains: ['docs.example.com', 'api.example.com'],
      searxngBaseUrl: 'https://searx.example.com',
    });
    expect(await config.buildWebSearchRunnerEnv()).toMatchObject({
      NANOCLAW_WEB_SEARCH_PROVIDER: 'searxng',
      NANOCLAW_WEB_FETCH_PROVIDER: 'browser_cli',
      NANOCLAW_WEB_FETCH_USE_BUILTIN_SITE_PROFILES: 'true',
      NANOCLAW_WEB_FETCH_PAGE_SIZE: '4096',
      NANOCLAW_WEB_FETCH_BROWSER_COMMAND:
        '["node","scripts/render-fetch.mjs","{url}"]',
      NANOCLAW_WEB_FETCH_BROWSER_SITE_PROFILES:
        '[{"domains":["cloud.tencent.com"],"pathPrefixes":["/developer/article/"],"forceProvider":"browser_cli","waitSelector":".article","postWaitMs":1500,"viewport":"1440x1200","userAgent":""}]',
      NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS:
        '["docs.example.com","api.example.com"]',
      NANOCLAW_WEB_SEARCH_SEARXNG_BASE_URL: 'https://searx.example.com',
    });
    expect(
      await config.buildWebSearchRunnerEnv({ allowBrowserCli: false }),
    ).toMatchObject({
      NANOCLAW_WEB_FETCH_PROVIDER: 'basic',
      NANOCLAW_WEB_FETCH_BROWSER_COMMAND: '',
      NANOCLAW_WEB_FETCH_BROWSER_SITE_PROFILES:
        '[{"domains":["cloud.tencent.com"],"pathPrefixes":["/developer/article/"],"forceProvider":"basic","waitSelector":".article","postWaitMs":1500,"viewport":"1440x1200","userAgent":""}]',
    });
  });

  it('normalizes browser site profiles with deduped lowercase domains', async () => {
    const config = await import('./config/web-search-config.js');

    expect(
      config.parseWebFetchBrowserSiteProfiles(
        JSON.stringify([
          {
            domains: [
              'Docs.Example.com',
              'docs.example.com',
              'API.example.com',
            ],
            pathPrefixes: ['/guide', '/guide', '/api'],
            forceProvider: 'browser_cli',
            waitSelector: '.content',
          },
        ]),
      ),
    ).toEqual([
      {
        domains: ['docs.example.com', 'api.example.com'],
        pathPrefixes: ['/guide', '/api'],
        forceProvider: 'browser_cli',
        waitSelector: '.content',
        selectorTimeoutMs: undefined,
        postWaitMs: undefined,
        waitUntil: undefined,
        viewport: '',
        userAgent: '',
      },
    ]);
  });
});
