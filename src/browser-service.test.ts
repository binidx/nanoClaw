import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchManagedBrowser = vi.fn();
const stopManagedBrowser = vi.fn();
const listBrowserTabs = vi.fn();
const createBrowserTab = vi.fn();
const focusBrowserTab = vi.fn();
const closeBrowserTab = vi.fn();
const createBrowserSnapshot = vi.fn();
const captureBrowserScreenshot = vi.fn();
const readBrowserLogs = vi.fn();
const runBrowserAction = vi.fn();
const resolveBrowserRuntimeConfig = vi.fn();

vi.mock('./browser/chrome.js', () => ({
  launchManagedBrowser,
  stopManagedBrowser,
}));

vi.mock('./browser/cdp.js', () => ({
  listBrowserTabs,
  createBrowserTab,
  focusBrowserTab,
  closeBrowserTab,
  createBrowserSnapshot,
  captureBrowserScreenshot,
  readBrowserLogs,
  runBrowserAction,
}));

vi.mock('./browser/config.js', () => ({
  resolveBrowserRuntimeConfig,
}));

function createSnapshotPayload(input?: {
  title?: string;
  url?: string;
  ref?: string;
  role?: string;
  name?: string;
  backendNodeId?: number;
}) {
  const title = input?.title || 'Example';
  const url = input?.url || 'https://example.com';
  const ref = input?.ref || 'ax1';
  const role = input?.role || 'button';
  const name = input?.name || 'Submit';
  const backendNodeId = input?.backendNodeId || 42;

  return {
    targetId: 'tab-1',
    title,
    url,
    frames: [
      {
        frameId: 'frame-top',
        url,
        topFrame: true,
      },
    ],
    nodes: [
      {
        ref,
        role,
        name,
        depth: 1,
        actionable: true,
        frameId: 'frame-top',
        frameUrl: url,
        topFrame: true,
      },
    ],
    resolvedRefs: {
      [ref]: {
        backendNodeId,
        node: {
          ref,
          role,
          name,
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: url,
          topFrame: true,
        },
      },
    },
  };
}

describe('browser service', () => {
  beforeEach(() => {
    vi.resetModules();
    launchManagedBrowser.mockReset();
    stopManagedBrowser.mockReset();
    listBrowserTabs.mockReset();
    createBrowserTab.mockReset();
    focusBrowserTab.mockReset();
    closeBrowserTab.mockReset();
    createBrowserSnapshot.mockReset();
    captureBrowserScreenshot.mockReset();
    readBrowserLogs.mockReset();
    runBrowserAction.mockReset();
    resolveBrowserRuntimeConfig.mockReset();

    resolveBrowserRuntimeConfig.mockReturnValue({
      enabled: true,
      connectionMode: 'managed',
      remoteDebugUrl: 'http://127.0.0.1:9222',
      executablePath: '',
      resolvedExecutablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: false,
      extraArgs: [],
      startupUrl: 'about:blank',
      startupTimeoutMs: 15000,
      actionTimeoutMs: 9000,
      userDataDir: '/tmp/browser-control/user-data',
    });
    launchManagedBrowser.mockResolvedValue({
      pid: 101,
      proc: { exitCode: null } as any,
      startedAt: '2026-03-14T00:00:00.000Z',
      userDataDir: '/tmp/browser-control/user-data',
      debugPort: 45678,
      executablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    listBrowserTabs.mockResolvedValue([
      {
        targetId: 'tab-1',
        type: 'page',
        title: 'Example',
        url: 'https://example.com',
        attached: false,
        active: true,
      },
    ]);
    createBrowserTab.mockResolvedValue({
      targetId: 'tab-2',
      type: 'page',
      title: 'Example',
      url: 'https://example.com/new',
      attached: false,
      active: true,
    });
    captureBrowserScreenshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });
    readBrowserLogs.mockResolvedValue({
      console: [],
      errors: [],
    });
  });

  it('connects to an existing browser when configured in connect mode', async () => {
    resolveBrowserRuntimeConfig.mockReturnValue({
      enabled: true,
      connectionMode: 'connect',
      remoteDebugUrl: 'http://127.0.0.1:9222',
      executablePath: '',
      resolvedExecutablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: false,
      extraArgs: [],
      startupUrl: 'about:blank',
      startupTimeoutMs: 15000,
      actionTimeoutMs: 9000,
      userDataDir: '/tmp/browser-control/user-data',
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    const status = await service.start();
    expect(status).toMatchObject({
      running: true,
      connectionMode: 'connect',
      remoteDebugUrl: 'http://127.0.0.1:9222',
      debugPort: 9222,
    });
    expect(launchManagedBrowser).not.toHaveBeenCalled();

    await service.openTab('https://example.com/new');
    expect(createBrowserTab).toHaveBeenLastCalledWith(
      'http://127.0.0.1:9222',
      'https://example.com/new',
    );
  });

  it('passes snapshot refs into subsequent actions', async () => {
    createBrowserSnapshot.mockResolvedValue(createSnapshotPayload());
    runBrowserAction.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'click', ref: 'ax1' },
    });

    expect(runBrowserAction).toHaveBeenCalledWith({
      cdpUrl: 'http://127.0.0.1:45678',
      targetId: 'tab-1',
      action: { kind: 'click', ref: 'ax1' },
      resolvedRefs: {
        ax1: {
          backendNodeId: 42,
          node: {
            ref: 'ax1',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
      defaultTimeoutMs: 9000,
    });
  });

  it('refreshes the snapshot and retries once when a ref expires', async () => {
    const { BrowserError } = await import('./browser/types.js');

    createBrowserSnapshot
      .mockResolvedValueOnce(
        createSnapshotPayload({
          ref: 'ax1',
          role: 'textbox',
          name: 'Search',
          backendNodeId: 42,
        }),
      )
      .mockResolvedValueOnce(
        createSnapshotPayload({
          title: 'Search',
          url: 'https://example.com/search',
          ref: 'ax1',
          role: 'textbox',
          name: 'Search',
          backendNodeId: 99,
        }),
      );
    runBrowserAction
      .mockRejectedValueOnce(
        new BrowserError(
          409,
          'Ref "ax1" is not recognized. Refs expire when the page changes. Take a fresh browser_role_snapshot to get valid refs.',
          {
            action: 'type',
            ref: 'ax1',
            suggestion: 'Take a fresh browser_role_snapshot to get valid refs.',
          },
        ),
      )
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Search',
        url: 'https://example.com/search',
      });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    const result = await service.act({
      targetId: 'tab-1',
      action: { kind: 'type', ref: 'ax1', text: 'nanoclaw' },
    });

    expect(result).toMatchObject({
      ok: true,
      targetId: 'tab-1',
      ref: 'ax1',
      url: 'https://example.com/search',
    });
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(2);
    expect(runBrowserAction).toHaveBeenCalledTimes(2);
    expect(runBrowserAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: { kind: 'type', ref: 'ax1', text: 'nanoclaw' },
        resolvedRefs: {
          ax1: expect.objectContaining({
            backendNodeId: 99,
          }),
        },
      }),
    );
  });

  it('does not retry stale ref actions more than once', async () => {
    const { BrowserError } = await import('./browser/types.js');

    createBrowserSnapshot
      .mockResolvedValueOnce(createSnapshotPayload({ ref: 'ax1' }))
      .mockResolvedValueOnce(
        createSnapshotPayload({
          title: 'Search',
          url: 'https://example.com/search',
          ref: 'ax1',
          backendNodeId: 99,
        }),
      );
    runBrowserAction
      .mockRejectedValueOnce(
        new BrowserError(
          409,
          'Ref "ax1" is not recognized. Refs expire when the page changes. Take a fresh browser_role_snapshot to get valid refs.',
          {
            action: 'click',
            ref: 'ax1',
            suggestion: 'Take a fresh browser_role_snapshot to get valid refs.',
          },
        ),
      )
      .mockRejectedValueOnce(
        new BrowserError(
          409,
          'Ref "ax1" is not recognized. Refs expire when the page changes. Take a fresh browser_role_snapshot to get valid refs.',
          {
            action: 'click',
            ref: 'ax1',
            suggestion: 'Take a fresh browser_role_snapshot to get valid refs.',
          },
        ),
      );

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });

    await expect(
      service.act({
        targetId: 'tab-1',
        action: { kind: 'click', ref: 'ax1' },
      }),
    ).rejects.toMatchObject({
      name: 'BrowserError',
      status: 409,
    });
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(2);
    expect(runBrowserAction).toHaveBeenCalledTimes(2);
  });

  it('reuses cached snapshots when the page has not changed', async () => {
    createBrowserSnapshot.mockResolvedValue(createSnapshotPayload());

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const first = await service.getSnapshot({ targetId: 'tab-1' });
    const second = await service.getSnapshot({ targetId: 'tab-1' });

    expect(first).toMatchObject({
      cacheHit: false,
      pageVersion: 'https://example.com\nExample',
      stale: false,
    });
    expect(second).toMatchObject({
      cacheHit: true,
      pageVersion: 'https://example.com\nExample',
      stale: false,
    });
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(1);
  });

  it('supports force-refresh even when the page has not changed', async () => {
    createBrowserSnapshot
      .mockResolvedValueOnce(createSnapshotPayload())
      .mockResolvedValueOnce(
        createSnapshotPayload({
          name: 'Submit again',
        }),
      );

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const first = await service.getSnapshot({ targetId: 'tab-1' });
    const second = await service.getSnapshot({
      targetId: 'tab-1',
      force: true,
    });

    expect(first).toMatchObject({ cacheHit: false });
    expect(second).toMatchObject({
      cacheHit: false,
      nodes: [
        expect.objectContaining({
          name: 'Submit again',
        }),
      ],
    });
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(2);
  });

  it('handles wait actions without delegating to the CDP runner', async () => {
    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const result = await service.act({
      targetId: 'tab-1',
      action: { kind: 'wait', timeMs: 5 },
    });

    expect(result).toEqual({
      ok: true,
      targetId: 'tab-1',
      waitedMs: 5,
    });
    expect(runBrowserAction).not.toHaveBeenCalled();
  });

  it('propagates waitedMs from waitFor actions handled by the CDP runner', async () => {
    runBrowserAction.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Done',
      url: 'https://example.com/done',
      waitedMs: 420,
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const result = await service.act({
      targetId: 'tab-1',
      action: {
        kind: 'waitFor',
        selector: '.toast-success',
        timeoutMs: 5000,
      },
    });

    expect(result).toEqual({
      ok: true,
      targetId: 'tab-1',
      title: 'Done',
      url: 'https://example.com/done',
      waitedMs: 420,
    });
    expect(runBrowserAction).toHaveBeenCalledWith({
      cdpUrl: 'http://127.0.0.1:45678',
      targetId: 'tab-1',
      action: {
        kind: 'waitFor',
        selector: '.toast-success',
        timeoutMs: 5000,
      },
      resolvedRefs: undefined,
      defaultTimeoutMs: 9000,
    });
  });

  it('captures screenshots for the resolved target tab', async () => {
    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const screenshot = await service.getScreenshot({});

    expect(screenshot).toEqual({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });
    expect(captureBrowserScreenshot).toHaveBeenCalledWith({
      cdpUrl: 'http://127.0.0.1:45678',
      targetId: 'tab-1',
    });
  });

  it('builds role snapshots from the latest browser snapshot and stores refs', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [
        {
          frameId: 'frame-top',
          url: 'https://example.com',
          topFrame: true,
        },
      ],
      nodes: [
        {
          ref: 'ax-root',
          role: 'RootWebArea',
          name: 'Example',
          depth: 0,
          actionable: false,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
        {
          ref: 'ax-search',
          role: 'textbox',
          name: 'Search',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const roleSnapshot = await service.getRoleSnapshot({
      targetId: 'tab-1',
      interactive: true,
    });

    expect(roleSnapshot).toEqual({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      snapshot: '  - textbox "Search" [ref=ax-search]',
      refs: {
        'ax-search': {
          role: 'textbox',
          name: 'Search',
          frameId: 'frame-top',
          topFrame: true,
        },
      },
      stats: {
        lines: 1,
        chars: 36,
        refs: 1,
        interactive: 1,
      },
      cacheHit: false,
      pageVersion: 'https://example.com\nExample',
      capturedAt: expect.any(String),
      stale: false,
    });
    expect(createBrowserSnapshot).toHaveBeenCalledWith({
      cdpUrl: 'http://127.0.0.1:45678',
      targetId: 'tab-1',
      maxNodes: 200,
    });
  });

  it('reads browser logs for the resolved target tab', async () => {
    readBrowserLogs.mockResolvedValue({
      console: [
        {
          level: 'log',
          text: 'ready',
          timestamp: '2026-03-18T00:00:00.000Z',
        },
      ],
      errors: [],
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const logs = await service.getLogs({});

    expect(logs).toEqual({
      console: [
        {
          level: 'log',
          text: 'ready',
          timestamp: '2026-03-18T00:00:00.000Z',
        },
      ],
      errors: [],
    });
    expect(readBrowserLogs).toHaveBeenCalledWith(
      'http://127.0.0.1:45678',
      'tab-1',
    );
  });

  it('clears cached refs after navigation', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [
        {
          frameId: 'frame-top',
          url: 'https://example.com',
          topFrame: true,
        },
      ],
      nodes: [
        {
          ref: 'ax1',
          role: 'link',
          name: 'Docs',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        ax1: {
          backendNodeId: 42,
          node: {
            ref: 'ax1',
            role: 'link',
            name: 'Docs',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });
    runBrowserAction
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Docs',
        url: 'https://example.com/docs',
      })
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Docs',
        url: 'https://example.com/docs',
      });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'navigate', url: 'https://example.com/docs' },
    });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'press', key: 'Enter' },
    });

    expect(runBrowserAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resolvedRefs: {
          ax1: expect.objectContaining({
            backendNodeId: 42,
          }),
        },
      }),
    );
    expect(runBrowserAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resolvedRefs: {},
      }),
    );
  });

  it('clears cached refs after click actions that may mutate the page', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [
        {
          frameId: 'frame-top',
          url: 'https://example.com',
          topFrame: true,
        },
      ],
      nodes: [
        {
          ref: 'ax1',
          role: 'button',
          name: 'Submit',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        ax1: {
          backendNodeId: 42,
          node: {
            ref: 'ax1',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });
    runBrowserAction
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Submitted',
        url: 'https://example.com',
      })
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Submitted',
        url: 'https://example.com',
      });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'click', ref: 'ax1' },
    });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'waitFor', selector: '.toast-success' },
    });

    expect(runBrowserAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resolvedRefs: {
          ax1: expect.objectContaining({
            backendNodeId: 42,
          }),
        },
      }),
    );
    expect(runBrowserAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resolvedRefs: {},
      }),
    );
  });

  it('keeps reporting running during a transient status probe failure', async () => {
    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    listBrowserTabs.mockRejectedValueOnce(new Error('CDP busy'));

    const status = await service.getStatus();

    expect(status.running).toBe(true);
    expect(status.lastError).toBe('CDP busy');
  });

  it('marks the browser stopped after repeated status probe failures', async () => {
    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    listBrowserTabs.mockRejectedValue(new Error('CDP unreachable'));

    await expect(service.getStatus()).resolves.toMatchObject({ running: true });
    await expect(service.getStatus()).resolves.toMatchObject({ running: true });
    await expect(service.getStatus()).resolves.toMatchObject({
      running: false,
      lastError: 'CDP unreachable',
    });
  });

  it('reuses snapshot cache when the page has not changed', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [],
      nodes: [
        {
          ref: 'ax1',
          role: 'button',
          name: 'Submit',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        ax1: {
          backendNodeId: 42,
          node: {
            ref: 'ax1',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const first = await service.getSnapshot({ targetId: 'tab-1' });
    const second = await service.getSnapshot({ targetId: 'tab-1' });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.pageVersion).toBe('https://example.com\nExample');
    expect(second.stale).toBe(false);
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(1);
  });

  it('marks snapshot cache dirty after mutating actions and refreshes on next snapshot', async () => {
    createBrowserSnapshot
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [],
        resolvedRefs: {},
      })
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Submitted',
        url: 'https://example.com/submitted',
        frames: [],
        nodes: [],
        resolvedRefs: {},
      });
    runBrowserAction.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Submitted',
      url: 'https://example.com/submitted',
    });

    listBrowserTabs.mockResolvedValue([
      {
        targetId: 'tab-1',
        type: 'page',
        title: 'Submitted',
        url: 'https://example.com/submitted',
        attached: false,
        active: true,
      },
    ]);

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    await service.act({
      targetId: 'tab-1',
      action: { kind: 'click', selector: '#submit' },
    });
    const refreshed = await service.getSnapshot({ targetId: 'tab-1' });

    expect(refreshed.cacheHit).toBe(false);
    expect(refreshed.pageVersion).toBe(
      'https://example.com/submitted\nSubmitted',
    );
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(2);
  });

  it('supports force refresh even when a cache entry exists', async () => {
    createBrowserSnapshot
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [],
        resolvedRefs: {},
      })
      .mockResolvedValueOnce({
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [],
        resolvedRefs: {},
      });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    await service.getSnapshot({ targetId: 'tab-1' });
    const forced = await service.getSnapshot({ targetId: 'tab-1', force: true });

    expect(forced.cacheHit).toBe(false);
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(2);
  });

  it('reuses cached role snapshot until page state changes', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [],
      nodes: [
        {
          ref: 'ax-search',
          role: 'textbox',
          name: 'Search',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const first = await service.getRoleSnapshot({
      targetId: 'tab-1',
      interactive: true,
      compact: true,
      maxDepth: 12,
    });
    const second = await service.getRoleSnapshot({
      targetId: 'tab-1',
      interactive: true,
      compact: true,
      maxDepth: 12,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(1);
  });

  it('separates cached role snapshots by maxChars', async () => {
    createBrowserSnapshot.mockResolvedValue({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      frames: [],
      nodes: [
        {
          ref: 'ax-search',
          role: 'textbox',
          name: 'Search',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
        {
          ref: 'ax-submit',
          role: 'button',
          name: 'Submit',
          depth: 1,
          actionable: true,
          frameId: 'frame-top',
          frameUrl: 'https://example.com',
          topFrame: true,
        },
      ],
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
        'ax-submit': {
          backendNodeId: 43,
          node: {
            ref: 'ax-submit',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            frameUrl: 'https://example.com',
            topFrame: true,
          },
        },
      },
    });

    const serviceModule = await import('./browser/service.js');
    serviceModule._setBrowserServiceForTests(null);
    const service = serviceModule.getBrowserService();

    await service.start();
    const first = await service.getRoleSnapshot({
      targetId: 'tab-1',
      maxChars: 60,
    });
    const second = await service.getRoleSnapshot({
      targetId: 'tab-1',
      maxChars: 80,
    });
    const third = await service.getRoleSnapshot({
      targetId: 'tab-1',
      maxChars: 80,
    });

    expect(first.cacheHit).toBe(false);
    expect(first.truncated).toBe(true);
    expect(second.cacheHit).toBe(false);
    expect(third.cacheHit).toBe(true);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(createBrowserSnapshot).toHaveBeenCalledTimes(1);
  });
});
