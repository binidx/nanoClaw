import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentMessages: Array<{
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}> = [];
let delayedSelectorAttempts = 0;
let failAttachAttempts = 0;

class FakeWebSocket {
  static readonly CLOSED = 3;

  readyState = 1;

  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();

  constructor(_url: string, _options?: unknown) {
    queueMicrotask(() => this.emit('open'));
  }

  once(event: string, listener: (arg?: unknown) => void): void {
    const wrapped = (arg?: unknown) => {
      this.off(event, wrapped);
      listener(arg);
    };
    this.on(event, wrapped);
  }

  on(event: string, listener: (arg?: unknown) => void): void {
    const existing = this.listeners.get(event) || new Set();
    existing.add(listener);
    this.listeners.set(event, existing);
  }

  private off(event: string, listener: (arg?: unknown) => void): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }
    existing.delete(listener);
    if (existing.size === 0) {
      this.listeners.delete(event);
    }
  }

  send(raw: string): void {
    const parsed = JSON.parse(raw) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    sentMessages.push({
      id: parsed.id,
      method: parsed.method,
      params: parsed.params || {},
      sessionId: parsed.sessionId,
    });

    if (parsed.method === 'Target.attachToTarget' && failAttachAttempts > 0) {
      failAttachAttempts -= 1;
      queueMicrotask(() => this.emit('close'));
      return;
    }

    queueMicrotask(() => {
      this.emit(
        'message',
        JSON.stringify({
          id: parsed.id,
          sessionId: parsed.sessionId,
          result: respondToCdpCommand(parsed.method, parsed.params || {}),
        }),
      );
    });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }

  private emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) || []) {
      listener(arg);
    }
  }
}

function respondToCdpCommand(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (method) {
    case 'Target.getTargets':
      return {
        targetInfos: [
          {
            targetId: 'tab-1',
            type: 'page',
            title: 'Example',
            url: 'https://example.com',
          },
          {
            targetId: 'iframe-target-1',
            type: 'iframe',
            title: 'Embedded app',
            url: 'https://iframe.example.com',
            parentFrameId: 'frame-top',
          },
        ],
      };
    case 'Target.attachToTarget':
      return {
        sessionId:
          params.targetId === 'iframe-target-1'
            ? 'session-frame-child'
            : 'session-1',
      };
    case 'Page.createIsolatedWorld':
      return { executionContextId: 701 };
    case 'Page.getFrameTree':
      return {
        frameTree: {
          frame: {
            id: 'frame-top',
            url: 'https://example.com',
            name: '',
          },
          childFrames: [
            {
              frame: {
                id: 'frame-child',
                parentId: 'frame-top',
                url: 'https://iframe.example.com',
                name: 'embedded-app',
              },
            },
          ],
        },
      };
    case 'Accessibility.getFullAXTree':
      return {
        nodes: [
          {
            nodeId: 'root',
            role: { value: 'RootWebArea' },
            name: { value: 'Example' },
            childIds: ['field'],
            frameId: 'frame-top',
          },
          {
            nodeId: 'field',
            role: { value: 'textbox' },
            name: { value: 'Search' },
            backendDOMNodeId: 42,
            frameId: 'frame-child',
          },
        ],
      };
    case 'DOM.resolveNode':
      return { object: { objectId: 'object-1' } };
    case 'DOM.getDocument':
      return {
        root: {
          nodeId: 1,
        },
      };
    case 'DOM.querySelector':
      if (params.selector === '.toast-success') {
        delayedSelectorAttempts += 1;
        return {
          nodeId: delayedSelectorAttempts >= 3 ? 9 : 0,
        };
      }
      return {
        nodeId: params.selector === '#search' ? 2 : 0,
      };
    case 'DOM.describeNode':
      return {
        node: {
          backendNodeId: 84,
          nodeName: 'INPUT',
        },
      };
    case 'Runtime.evaluate':
      if (typeof params.expression === 'string') {
        if (params.expression.includes('JSON.stringify(window.__nanoclawConsoleBuffer')) {
          return {
            result: {
              value: JSON.stringify([
                {
                  level: 'log',
                  text: 'ready',
                  timestamp: '2026-03-18T00:00:00.000Z',
                },
              ]),
            },
          };
        }
        if (params.expression.includes('JSON.stringify(window.__nanoclawPageErrors')) {
          return {
            result: {
              value: JSON.stringify([
                {
                  message: 'Unhandled boom',
                  description: 'Unhandled Promise rejection',
                  timestamp: '2026-03-18T00:00:01.000Z',
                },
              ]),
            },
          };
        }
        if (params.expression.includes('__nanoclawConsoleBuffer')) {
          return {
            result: {
              value: true,
            },
          };
        }
      }
      return {
        result: {
          value: {
            title: 'Example',
            url: 'https://example.com',
          },
        },
      };
    case 'Page.captureScreenshot':
      return {
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      };
    default:
      return {};
  }
}

vi.mock('ws', () => ({
  WebSocket: FakeWebSocket,
}));

describe('browser cdp', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    delayedSelectorAttempts = 0;
    failAttachAttempts = 0;
    vi.restoreAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith('/json/version')) {
          return {
            ok: true,
            json: async () => ({
              webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
            }),
          };
        }
        if (url.endsWith('/json/list')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 'tab-1',
                type: 'page',
                title: 'Example',
                url: 'https://example.com',
                attached: false,
                active: true,
              },
            ],
          };
        }
        throw new Error(`Unexpected fetch url: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('types using Input.insertText after focusing and selecting the node', async () => {
    const cdp = await import('./browser/cdp.js');

    await cdp.runBrowserAction({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      action: { kind: 'type', ref: 'ax-1', text: 'hello world' },
      resolvedRefs: {
        'ax-1': {
          backendNodeId: 42,
          node: {
            ref: 'ax-1',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-child',
            parentFrameId: 'frame-top',
            frameUrl: 'https://iframe.example.com',
            frameName: 'embedded-app',
            topFrame: false,
          },
        },
      },
      defaultTimeoutMs: 5000,
    });

    expect(sentMessages.map((entry) => entry.method)).toEqual(
      expect.arrayContaining([
        'DOM.enable',
        'DOM.scrollIntoViewIfNeeded',
        'DOM.focus',
        'DOM.resolveNode',
        'Runtime.callFunctionOn',
        'Input.insertText',
        'Target.attachToTarget',
      ]),
    );
    expect(
      sentMessages.filter((entry) => entry.method === 'Target.attachToTarget'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ params: { targetId: 'tab-1', flatten: true } }),
        expect.objectContaining({
          params: { targetId: 'iframe-target-1', flatten: true },
        }),
      ]),
    );
    expect(
      sentMessages.find((entry) => entry.method === 'Target.getTargets')?.sessionId,
    ).toBeUndefined();
    expect(
      sentMessages.find((entry) => entry.method === 'DOM.resolveNode'),
    ).toMatchObject({
      sessionId: 'session-frame-child',
      params: {
        backendNodeId: 42,
      },
    });
    expect(
      sentMessages.some((entry) => entry.method === 'Page.createIsolatedWorld'),
    ).toBe(false);
    expect(
      sentMessages.find((entry) => entry.method === 'Input.insertText'),
    ).toMatchObject({
      sessionId: 'session-frame-child',
      params: { text: 'hello world' },
    });
  });

  it('returns frame metadata for snapshot nodes when AX nodes include frame ids', async () => {
    const cdp = await import('./browser/cdp.js');

    const snapshot = await cdp.createBrowserSnapshot({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      maxNodes: 10,
    });

    expect(snapshot.frames).toEqual([
      {
        frameId: 'frame-top',
        url: 'https://example.com',
        name: undefined,
        parentFrameId: undefined,
        topFrame: true,
      },
      {
        frameId: 'frame-child',
        url: 'https://iframe.example.com',
        name: 'embedded-app',
        parentFrameId: 'frame-top',
        topFrame: false,
      },
    ]);
    expect(snapshot.nodes).toEqual([
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
        ref: 'ax-field',
        role: 'textbox',
        name: 'Search',
        depth: 1,
        actionable: true,
        frameId: 'frame-child',
        parentFrameId: 'frame-top',
        frameUrl: 'https://iframe.example.com',
        frameName: 'embedded-app',
        topFrame: false,
      },
    ]);
    expect(snapshot.resolvedRefs['ax-field']).toMatchObject({
      backendNodeId: 42,
      node: {
        frameId: 'frame-child',
        parentFrameId: 'frame-top',
        frameUrl: 'https://iframe.example.com',
        frameName: 'embedded-app',
        topFrame: false,
      },
    });
  });

  it('captures screenshots and returns page metadata', async () => {
    const cdp = await import('./browser/cdp.js');

    const screenshot = await cdp.captureBrowserScreenshot({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
    });

    expect(screenshot).toEqual({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });
    expect(
      sentMessages.some((entry) => entry.method === 'Page.captureScreenshot'),
    ).toBe(true);
  });

  it('installs console capture when building a browser snapshot', async () => {
    const cdp = await import('./browser/cdp.js');

    await cdp.createBrowserSnapshot({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      maxNodes: 10,
    });

    expect(
      sentMessages.some(
        (entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument',
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (entry) =>
          entry.method === 'Runtime.evaluate' &&
          typeof entry.params.expression === 'string' &&
          entry.params.expression.includes('__nanoclawConsoleBuffer'),
      ),
    ).toBe(true);
  });

  it('reads structured browser logs from the page buffer', async () => {
    const cdp = await import('./browser/cdp.js');

    const logs = await cdp.readBrowserLogs(
      'http://127.0.0.1:9222',
      'tab-1',
    );

    expect(logs).toEqual({
      console: [
        {
          level: 'log',
          text: 'ready',
          timestamp: '2026-03-18T00:00:00.000Z',
        },
      ],
      errors: [
        {
          message: 'Unhandled boom',
          description: 'Unhandled Promise rejection',
          timestamp: '2026-03-18T00:00:01.000Z',
        },
      ],
    });
  });

  it('retries snapshot capture once after a transient websocket close', async () => {
    failAttachAttempts = 1;
    const cdp = await import('./browser/cdp.js');

    const snapshot = await cdp.createBrowserSnapshot({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
    });

    expect(snapshot.targetId).toBe('tab-1');
    expect(
      sentMessages.filter((entry) => entry.method === 'Target.attachToTarget').length,
    ).toBe(3);
    expect(
      sentMessages.filter((entry) => entry.method === 'Accessibility.getFullAXTree').length,
    ).toBe(1);
  });

  it('retries screenshot capture once after a transient websocket close', async () => {
    failAttachAttempts = 1;
    const cdp = await import('./browser/cdp.js');

    const screenshot = await cdp.captureBrowserScreenshot({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
    });

    expect(screenshot.targetId).toBe('tab-1');
    expect(
      sentMessages.filter((entry) => entry.method === 'Target.attachToTarget').length,
    ).toBe(2);
    expect(
      sentMessages.filter((entry) => entry.method === 'Page.captureScreenshot').length,
    ).toBe(1);
  });

  it('uses Digit code definitions for numeric key presses', async () => {
    const cdp = await import('./browser/cdp.js');

    await cdp.runBrowserAction({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      action: { kind: 'press', key: '1' },
      defaultTimeoutMs: 5000,
    });

    const keyDown = sentMessages.find(
      (entry) =>
        entry.method === 'Input.dispatchKeyEvent' &&
        entry.params.type === 'keyDown',
    );
    const charEvent = sentMessages.find(
      (entry) =>
        entry.method === 'Input.dispatchKeyEvent' &&
        entry.params.type === 'char',
    );

    expect(keyDown).toMatchObject({
      params: {
        key: '1',
        code: 'Digit1',
        text: '1',
      },
    });
    expect(charEvent).toMatchObject({
      params: {
        text: '1',
      },
    });
  });

  it('supports selector-based typing without a prior snapshot ref', async () => {
    const cdp = await import('./browser/cdp.js');

    await cdp.runBrowserAction({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      action: { kind: 'type', selector: '#search', text: 'via selector' },
      defaultTimeoutMs: 5000,
    });

    expect(
      sentMessages.some((entry) => entry.method === 'DOM.getDocument'),
    ).toBe(true);
    expect(
      sentMessages.find((entry) => entry.method === 'DOM.querySelector'),
    ).toMatchObject({
      sessionId: 'session-1',
      params: {
        nodeId: 1,
        selector: '#search',
      },
    });
    expect(
      sentMessages.find((entry) => entry.method === 'DOM.resolveNode'),
    ).toMatchObject({
      sessionId: 'session-1',
      params: {
        backendNodeId: 84,
      },
    });
    expect(
      sentMessages.find((entry) => entry.method === 'Input.insertText'),
    ).toMatchObject({
      sessionId: 'session-1',
      params: { text: 'via selector' },
    });
  });

  it('waits for selectors to appear before continuing', async () => {
    const cdp = await import('./browser/cdp.js');

    const result = await cdp.runBrowserAction({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      action: {
        kind: 'waitFor',
        selector: '.toast-success',
        timeoutMs: 100,
        pollIntervalMs: 0,
      },
      defaultTimeoutMs: 5000,
    });

    expect(result).toMatchObject({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
    });
    expect(delayedSelectorAttempts).toBe(3);
    expect(
      sentMessages.filter((entry) => entry.method === 'DOM.querySelector').length,
    ).toBe(3);
  });

  it('uses JS fallback click behavior for child-frame refs', async () => {
    const cdp = await import('./browser/cdp.js');

    await cdp.runBrowserAction({
      cdpUrl: 'http://127.0.0.1:9222',
      targetId: 'tab-1',
      action: { kind: 'click', ref: 'ax-child' },
      resolvedRefs: {
        'ax-child': {
          backendNodeId: 42,
          node: {
            ref: 'ax-child',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-child',
            parentFrameId: 'frame-top',
            frameUrl: 'https://iframe.example.com',
            frameName: 'embedded-app',
            topFrame: false,
          },
        },
      },
      defaultTimeoutMs: 5000,
    });

    expect(
      sentMessages.some(
        (entry) =>
          entry.method === 'Target.getTargets' &&
          entry.sessionId === undefined,
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (entry) =>
          entry.method === 'Target.attachToTarget' &&
          entry.params.targetId === 'iframe-target-1',
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (entry) =>
          entry.method === 'Input.dispatchMouseEvent' &&
          entry.params.type === 'mousePressed',
      ),
    ).toBe(false);
    expect(
      sentMessages.filter((entry) => entry.method === 'Runtime.callFunctionOn').length,
    ).toBeGreaterThan(0);
    expect(
      sentMessages.some((entry) => entry.method === 'Page.createIsolatedWorld'),
    ).toBe(false);
  });
});
