import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBrowserRoutes } from './routes/browser-routes.js';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserErrorResponse,
  BrowserLogs,
  BrowserRoleSnapshot,
  BrowserScreenshot,
  BrowserServiceLike,
  BrowserSnapshot,
  BrowserStatus,
  BrowserTab,
} from './browser/types.js';
import { BrowserError } from './browser/types.js';

const allowAllRequirePermission: import('./auth/auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

async function withServer(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<ReturnType<express.Express['listen']>>(
    (resolve) => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

function createStatus(): BrowserStatus {
  return {
    enabled: true,
    running: true,
    connectionMode: 'managed',
    remoteDebugUrl: 'http://127.0.0.1:9222',
    headless: false,
    userDataDir: '/tmp/browser',
    executablePath: '',
    resolvedExecutablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    debugPort: 39222,
    startedAt: '2026-03-14T00:00:00.000Z',
    lastTargetId: 'tab-1',
    lastError: '',
  };
}

function createServiceStub(): BrowserServiceLike & {
  act: ReturnType<typeof vi.fn>;
  getRoleSnapshot: ReturnType<typeof vi.fn>;
  getScreenshot: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  openTab: ReturnType<typeof vi.fn>;
} {
  const tab: BrowserTab = {
    targetId: 'tab-1',
    type: 'page',
    title: 'Example',
    url: 'https://example.com',
    attached: false,
    active: true,
  };
  const snapshot: BrowserSnapshot = {
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
        role: 'heading',
        name: 'Example',
        depth: 1,
        actionable: false,
        frameId: 'frame-top',
        frameUrl: 'https://example.com',
        topFrame: true,
      },
    ],
    cacheHit: true,
    pageVersion: 'https://example.com\nExample',
    capturedAt: '2026-03-17T01:00:00.000Z',
    stale: false,
  };
  const actionResult: BrowserActionResult = {
    ok: true,
    targetId: 'tab-1',
    title: 'Example',
    url: 'https://example.com',
  };
  const screenshot: BrowserScreenshot = {
    targetId: 'tab-1',
    title: 'Example',
    url: 'https://example.com',
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
  };
  const roleSnapshot: BrowserRoleSnapshot = {
    targetId: 'tab-1',
    title: 'Example',
    url: 'https://example.com',
    snapshot: '- RootWebArea "Example"\n  - textbox "Search" [ref=ax-search]',
    refs: {
      'ax-search': {
        role: 'textbox',
        name: 'Search',
        frameId: 'frame-top',
        topFrame: true,
      },
    },
    stats: {
      lines: 2,
      chars: 61,
      refs: 1,
      interactive: 1,
    },
    cacheHit: true,
    pageVersion: 'https://example.com\nExample',
    capturedAt: '2026-03-17T01:00:00.000Z',
    stale: false,
  };
  const logs: BrowserLogs = {
    console: [
      {
        level: 'log',
        text: 'ready',
        timestamp: '2026-03-18T00:00:00.000Z',
      },
    ],
    errors: [],
  };

  return {
    getStatus: vi.fn(async () => createStatus()),
    start: vi.fn(async () => createStatus()),
    stop: vi.fn(async () => ({ ...createStatus(), running: false })),
    listTabs: vi.fn(async () => ({ running: true, tabs: [tab] })),
    openTab: vi.fn(async () => tab),
    focusTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    getSnapshot: vi.fn(async () => snapshot),
    getRoleSnapshot: vi.fn(async () => roleSnapshot),
    getScreenshot: vi.fn(async () => screenshot),
    getLogs: vi.fn(async () => logs),
    act: vi.fn(async () => actionResult),
  };
}

describe('browser routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces the browser control local capability guard', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, {
      requirePermission: allowAllRequirePermission,
      requireLocalCapability: (capabilityId) => (_req, res) => {
        res.status(403).json({ error: 'blocked', capabilityId });
      },
      service,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/status`);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'blocked',
        capabilityId: 'browserControl',
      });
      expect(service.getStatus).not.toHaveBeenCalled();
    });
  });

  it('validates required tab open url', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/tabs/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'url is required' });
      expect(service.openTab).not.toHaveBeenCalled();
    });
  });

  it('rejects unsafe browser URLs before delegating', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/tabs/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'file:///tmp/demo.html' }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'url must use http:, https:, or about:blank',
      });
      expect(service.openTab).not.toHaveBeenCalled();
    });
  });

  it('parses browser act requests and delegates to the service', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'navigate',
            url: 'https://example.com',
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
      });
      expect(service.act).toHaveBeenCalledWith({
        targetId: 'tab-1',
        action: {
          kind: 'navigate',
          url: 'https://example.com/',
          timeoutMs: undefined,
        } satisfies BrowserAction,
      });
    });
  });

  it('rejects unsupported browser action kinds', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'explode',
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Unsupported browser action: explode',
      });
      expect(service.act).not.toHaveBeenCalled();
    });
  });

  it('returns structured browser action error details when available', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    service.act.mockRejectedValueOnce(
      new BrowserError(409, 'Ref "ax1" is not recognized.', {
        action: 'click',
        ref: 'ax1',
        suggestion: 'Take a fresh browser_role_snapshot to get valid refs.',
      }),
    );
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'click',
            ref: 'ax1',
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'Ref "ax1" is not recognized.',
        errorContext: {
          action: 'click',
          ref: 'ax1',
        },
        suggestion: 'Take a fresh browser_role_snapshot to get valid refs.',
      } satisfies BrowserErrorResponse);
    });
  });

  it('parses ref-based browser actions', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'click',
            ref: 'ax1',
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(service.act).toHaveBeenCalledWith({
        targetId: 'tab-1',
        action: {
          kind: 'click',
          ref: 'ax1',
        } satisfies BrowserAction,
      });
    });
  });

  it('parses selector-based browser actions', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'type',
            selector: '#search',
            text: 'hello',
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(service.act).toHaveBeenCalledWith({
        targetId: 'tab-1',
        action: {
          kind: 'type',
          selector: '#search',
          text: 'hello',
        } satisfies BrowserAction,
      });
    });
  });

  it('parses waitFor browser actions with selector and URL conditions', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'waitFor',
            selector: '.toast-success',
            urlIncludes: '/done',
            timeoutMs: 8000,
            pollIntervalMs: 200,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(service.act).toHaveBeenCalledWith({
        targetId: 'tab-1',
        action: {
          kind: 'waitFor',
          selector: '.toast-success',
          urlIncludes: '/done',
          timeoutMs: 8000,
          pollIntervalMs: 200,
        } satisfies BrowserAction,
      });
    });
  });

  it('rejects empty waitFor browser actions', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/browser/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: 'tab-1',
          action: {
            kind: 'waitFor',
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'waitFor requires selector, urlIncludes, or titleIncludes',
      });
      expect(service.act).not.toHaveBeenCalled();
    });
  });

  it('returns browser screenshots for the requested tab', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/browser/screenshot?targetId=tab-1`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      });
      expect(service.getScreenshot).toHaveBeenCalledWith({ targetId: 'tab-1' });
    });
  });

  it('returns browser logs for the requested tab', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/browser/logs?targetId=tab-1`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        console: [
          {
            level: 'log',
            text: 'ready',
            timestamp: '2026-03-18T00:00:00.000Z',
          },
        ],
        errors: [],
      });
      expect(service.getLogs).toHaveBeenCalledWith({ targetId: 'tab-1' });
    });
  });

  it('returns browser role snapshots and parses query options', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/browser/role-snapshot?targetId=tab-1&interactive=true&compact=1&maxDepth=2&maxChars=1200`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        snapshot: '- RootWebArea "Example"\n  - textbox "Search" [ref=ax-search]',
        refs: {
          'ax-search': {
            role: 'textbox',
            name: 'Search',
            frameId: 'frame-top',
            topFrame: true,
          },
        },
        stats: {
          lines: 2,
          chars: 61,
          refs: 1,
          interactive: 1,
        },
        cacheHit: true,
        pageVersion: 'https://example.com\nExample',
        capturedAt: '2026-03-17T01:00:00.000Z',
        stale: false,
      });
      expect(service.getRoleSnapshot).toHaveBeenCalledWith({
        targetId: 'tab-1',
        interactive: true,
        compact: true,
        maxDepth: 2,
        maxChars: 1200,
        maxNodes: undefined,
        force: undefined,
      });
    });
  });

  it('parses force refresh on snapshot and role snapshot endpoints', async () => {
    const app = express();
    app.use(express.json());
    const service = createServiceStub();
    registerBrowserRoutes(app, { requirePermission: allowAllRequirePermission, service });

    await withServer(app, async (baseUrl) => {
      const snapshotResponse = await fetch(
        `${baseUrl}/api/browser/snapshot?targetId=tab-1&force=true&maxNodes=80`,
      );
      expect(snapshotResponse.status).toBe(200);
      expect(service.getSnapshot).toHaveBeenCalledWith({
        targetId: 'tab-1',
        maxNodes: 80,
        force: true,
      });

      const roleSnapshotResponse = await fetch(
        `${baseUrl}/api/browser/role-snapshot?targetId=tab-1&force=1&interactive=false`,
      );
      expect(roleSnapshotResponse.status).toBe(200);
      expect(service.getRoleSnapshot).toHaveBeenCalledWith({
        targetId: 'tab-1',
        interactive: false,
        compact: undefined,
        maxDepth: undefined,
        maxNodes: undefined,
        force: true,
      });
    });
  });
});
