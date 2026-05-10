import { WebSocket } from 'ws';

import { BrowserError, type BrowserTab } from './types.js';

interface RawTabResponse {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
  active?: boolean;
}

interface CdpResponse {
  id?: number;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
  method?: string;
}

function appendCdpPath(cdpUrl: string, pathname: string): string {
  const base = cdpUrl.replace(/\/+$/, '');
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

function normalizeWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  if (
    (ws.hostname === '0.0.0.0' || ws.hostname === '::' || ws.hostname === '[::]') &&
    cdp.hostname
  ) {
    ws.hostname = cdp.hostname;
    ws.port = cdp.port;
  }
  return ws.toString();
}

function asBrowserError(err: unknown, fallbackStatus = 502): BrowserError {
  if (err instanceof BrowserError) {
    return err;
  }
  if (err instanceof Error) {
    return new BrowserError(fallbackStatus, err.message);
  }
  return new BrowserError(fallbackStatus, String(err));
}

export async function fetchJson<T>(url: string, timeoutMs = 3000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new BrowserError(
        502,
        `Browser endpoint returned HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  } catch (err) {
    throw asBrowserError(err);
  } finally {
    clearTimeout(timer);
  }
}

export async function getBrowserWebSocketDebuggerUrl(
  cdpUrl: string,
): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    appendCdpPath(cdpUrl, '/json/version'),
  );
  const wsUrl = String(version.webSocketDebuggerUrl || '').trim();
  if (!wsUrl) {
    throw new BrowserError(502, 'Browser did not expose a websocket debugger URL');
  }
  return normalizeWsUrl(wsUrl, cdpUrl);
}

export async function waitForCdpReady(
  cdpUrl: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getBrowserWebSocketDebuggerUrl(cdpUrl);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new BrowserError(504, 'Timed out waiting for the managed browser to start');
}

export async function listBrowserTabs(
  cdpUrl: string,
  timeoutMs = 3000,
): Promise<BrowserTab[]> {
  const tabs = await fetchJson<RawTabResponse[]>(
    appendCdpPath(cdpUrl, '/json/list'),
    timeoutMs,
  );
  return tabs
    .filter((tab) => tab.type === 'page' && typeof tab.id === 'string')
    .map((tab) => ({
      targetId: String(tab.id || ''),
      type: String(tab.type || 'page'),
      title: String(tab.title || ''),
      url: String(tab.url || ''),
      attached: Boolean(tab.attached),
      active: Boolean(tab.active),
    }));
}

export class CdpClient {
  private nextId = 1;

  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason: BrowserError) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly waiters = new Map<
    string,
    Array<{
      resolve: () => void;
      sessionId?: string;
      timer: NodeJS.Timeout;
    }>
  >();

  private constructor(private readonly ws: WebSocket) {
    this.ws.on('message', (raw) => {
      this.handleMessage(String(raw));
    });
    this.ws.on('close', () => {
      this.rejectAll(new BrowserError(502, 'Browser websocket closed'));
    });
    this.ws.on('error', (err) => {
      this.rejectAll(asBrowserError(err));
    });
  }

  static async connect(wsUrl: string, timeoutMs = 5000): Promise<CdpClient> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
      socket.once('open', () => resolve(socket));
      socket.once('error', (err) => reject(asBrowserError(err)));
    });
    return new CdpClient(ws);
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(504, `Timed out waiting for browser command ${method}`));
      }, options?.timeoutMs ?? 10000);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(
          JSON.stringify({
            id,
            method,
            params: params || {},
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asBrowserError(err));
      }
    });
  }

  async waitForEvent(
    method: string,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(method, resolve);
        reject(new BrowserError(504, `Timed out waiting for event ${method}`));
      }, timeoutMs);
      const existing = this.waiters.get(method) || [];
      existing.push({ resolve, sessionId, timer });
      this.waiters.set(method, existing);
    });
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
      }
    }
    this.waiters.clear();

    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  private handleMessage(raw: string): void {
    let parsed: CdpResponse;
    try {
      parsed = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (parsed.error?.message) {
        pending.reject(new BrowserError(502, parsed.error.message));
        return;
      }
      pending.resolve(parsed.result || {});
      return;
    }

    const method = String(parsed.method || '').trim();
    if (!method) {
      return;
    }
    const waiters = this.waiters.get(method);
    if (!waiters || waiters.length === 0) {
      return;
    }
    const next = waiters.filter((entry) => {
      if (entry.sessionId && entry.sessionId !== parsed.sessionId) {
        return true;
      }
      clearTimeout(entry.timer);
      entry.resolve();
      return false;
    });
    if (next.length > 0) {
      this.waiters.set(method, next);
    } else {
      this.waiters.delete(method);
    }
  }

  private removeWaiter(method: string, resolve: () => void): void {
    const waiters = this.waiters.get(method) || [];
    const next = waiters.filter((entry) => entry.resolve !== resolve);
    if (next.length > 0) {
      this.waiters.set(method, next);
    } else {
      this.waiters.delete(method);
    }
  }

  private rejectAll(error: BrowserError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
      }
    }
    this.waiters.clear();
  }
}
