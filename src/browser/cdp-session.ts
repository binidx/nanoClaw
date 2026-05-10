import {
  CdpClient,
  getBrowserWebSocketDebuggerUrl,
  listBrowserTabs,
} from './cdp-client.js';
import { CONSOLE_CAPTURE_SCRIPT } from './cdp-scripts.js';
import { BrowserError, type BrowserTab } from './types.js';

export async function withBrowserClient<T>(
  cdpUrl: string,
  run: (client: CdpClient) => Promise<T>,
): Promise<T> {
  const wsUrl = await getBrowserWebSocketDebuggerUrl(cdpUrl);
  const client = await CdpClient.connect(wsUrl);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function getTabByTargetId(
  cdpUrl: string,
  targetId: string,
): Promise<BrowserTab> {
  const tabs = await listBrowserTabs(cdpUrl);
  const tab = tabs.find((entry) => entry.targetId === targetId);
  if (!tab) {
    throw new BrowserError(404, `Browser tab ${targetId} was not found`);
  }
  return tab;
}

export async function withTargetSession<T>(
  cdpUrl: string,
  targetId: string,
  run: (client: CdpClient, sessionId: string, tab: BrowserTab) => Promise<T>,
): Promise<T> {
  const tab = await getTabByTargetId(cdpUrl, targetId);
  return await withBrowserClient(cdpUrl, async (client) => {
    const attached = await client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = String(attached.sessionId || '').trim();
    if (!sessionId) {
      throw new BrowserError(502, 'Browser did not return a target session id');
    }
    try {
      return await run(client, sessionId, tab);
    } finally {
      await client
        .send('Target.detachFromTarget', { sessionId }, { timeoutMs: 2000 })
        .catch(() => undefined);
    }
  });
}

function isRetryableReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Browser websocket closed') ||
    message.includes('WebSocket') ||
    message.includes('websocket') ||
    message.includes('socket hang up') ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('Timed out waiting for browser command')
  );
}

export async function withReadRetry<T>(
  run: () => Promise<T>,
  maxAttempts = 2,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableReadError(error) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  throw lastError;
}

export async function installConsoleCapture(
  client: CdpClient,
  sessionId: string,
): Promise<void> {
  await client.send('Page.enable', undefined, { sessionId }).catch(() => undefined);
  await client.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: CONSOLE_CAPTURE_SCRIPT },
    { sessionId },
  ).catch(() => undefined);
  await client.send(
    'Runtime.evaluate',
    {
      expression: CONSOLE_CAPTURE_SCRIPT,
      returnByValue: true,
    },
    { sessionId, timeoutMs: 5000 },
  ).catch(() => undefined);
}

export async function injectConsoleCapture(
  cdpUrl: string,
  targetId: string,
): Promise<void> {
  await withTargetSession(cdpUrl, targetId, async (client, sessionId) => {
    await installConsoleCapture(client, sessionId);
  });
}
