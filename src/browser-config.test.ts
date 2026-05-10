import { describe, expect, it } from 'vitest';

import {
  normalizeBrowserConfigEntry,
  resolveBrowserExecutablePath,
  resolveBrowserRuntimeConfig,
} from './browser/config.js';
import { normalizeBrowserUrl } from './browser/policy.js';

describe('browser config', () => {
  it('normalizes browser config entries', () => {
    expect(normalizeBrowserConfigEntry('WEB_BROWSER_ENABLED', true)).toBe(
      'true',
    );
    expect(
      normalizeBrowserConfigEntry('WEB_BROWSER_CONNECTION_MODE', 'connect'),
    ).toBe('connect');
    expect(
      normalizeBrowserConfigEntry(
        'WEB_BROWSER_REMOTE_DEBUG_URL',
        'http://localhost:9222/json/version',
      ),
    ).toBe('http://localhost:9222');
    expect(normalizeBrowserConfigEntry('WEB_BROWSER_HEADLESS', 'FALSE')).toBe(
      'false',
    );
    expect(
      normalizeBrowserConfigEntry(
        'WEB_BROWSER_EXTRA_ARGS',
        '["--lang=zh-CN", " --disable-gpu "]',
      ),
    ).toBe('["--lang=zh-CN","--disable-gpu"]');
    expect(
      normalizeBrowserConfigEntry('WEB_BROWSER_ACTION_TIMEOUT_MS', '999999'),
    ).toBe('60000');
    expect(
      normalizeBrowserConfigEntry('WEB_BROWSER_STARTUP_TIMEOUT_MS', '1'),
    ).toBe('3000');
    expect(
      normalizeBrowserConfigEntry(
        'WEB_BROWSER_START_URL',
        'https://example.com/docs',
      ),
    ).toBe('https://example.com/docs');
    expect(() =>
      normalizeBrowserConfigEntry('WEB_BROWSER_EXTRA_ARGS', '{}'),
    ).toThrow(/JSON string array/);
    expect(() =>
      normalizeBrowserConfigEntry('WEB_BROWSER_START_URL', 'file:///tmp/a'),
    ).toThrow(/safe http/);
    expect(() =>
      normalizeBrowserConfigEntry(
        'WEB_BROWSER_REMOTE_DEBUG_URL',
        'https://example.com:9222',
      ),
    ).toThrow(/localhost/);
  });

  it('rejects localhost and private network browser URLs', () => {
    expect(() => normalizeBrowserUrl('http://localhost:3000')).toThrow(
      /private network address/,
    );
    expect(() => normalizeBrowserUrl('http://127.0.0.1:3000')).toThrow(
      /private network address/,
    );
    expect(() => normalizeBrowserUrl('http://192.168.1.2')).toThrow(
      /private network address/,
    );
    expect(normalizeBrowserUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    );
  });

  it('resolves explicit executables and runtime config', () => {
    const fakeExecutable = '/tmp/fake-chrome';
    expect(
      resolveBrowserExecutablePath(fakeExecutable, {
        existsSync: (filePath) => filePath === fakeExecutable,
      }),
    ).toBe(fakeExecutable);

    const config = resolveBrowserRuntimeConfig({
      values: {
        WEB_BROWSER_ENABLED: 'true',
        WEB_BROWSER_CONNECTION_MODE: 'managed',
        WEB_BROWSER_REMOTE_DEBUG_URL: 'http://127.0.0.1:9222',
        WEB_BROWSER_EXECUTABLE_PATH: fakeExecutable,
        WEB_BROWSER_HEADLESS: 'true',
        WEB_BROWSER_EXTRA_ARGS: '["--lang=zh-CN"]',
        WEB_BROWSER_START_URL: 'about:blank',
        WEB_BROWSER_STARTUP_TIMEOUT_MS: '20000',
        WEB_BROWSER_ACTION_TIMEOUT_MS: '9000',
      },
      dataDir: '/tmp/nanoclaw-data',
      existsSync: (filePath) => filePath === fakeExecutable,
    });

    expect(config).toEqual({
      enabled: true,
      connectionMode: 'managed',
      remoteDebugUrl: 'http://127.0.0.1:9222',
      executablePath: fakeExecutable,
      resolvedExecutablePath: fakeExecutable,
      headless: true,
      extraArgs: ['--lang=zh-CN'],
      startupUrl: 'about:blank',
      startupTimeoutMs: 20000,
      actionTimeoutMs: 9000,
      userDataDir: '/tmp/nanoclaw-data/browser-control/user-data',
    });
  });

  it('discovers common browser executables when explicit path is absent', () => {
    expect(
      resolveBrowserExecutablePath('', {
        platform: 'darwin',
        homeDir: '/Users/tester',
        existsSync: (filePath) =>
          filePath ===
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
    ).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

    expect(
      resolveBrowserExecutablePath('', {
        platform: 'linux',
        existsSync: (filePath) => filePath === '/usr/bin/chromium',
      }),
    ).toBe('/usr/bin/chromium');

    expect(
      resolveBrowserExecutablePath('', {
        platform: 'win32',
        existsSync: () => false,
      }),
    ).toBeNull();
  });
});
