export { listBrowserTabs } from './cdp-client.js';

import { listBrowserTabs } from './cdp-client.js';
import { injectConsoleCapture, withBrowserClient } from './cdp-session.js';
import { BrowserError, type BrowserTab } from './types.js';

export async function createBrowserTab(
  cdpUrl: string,
  url: string,
): Promise<BrowserTab> {
  const tab = await withBrowserClient(cdpUrl, async (client) => {
    const created = await client.send('Target.createTarget', { url });
    const targetId = String(created.targetId || '').trim();
    if (!targetId) {
      throw new BrowserError(502, 'Browser did not return a target id');
    }
    const tabs = await listBrowserTabs(cdpUrl);
    return (
      tabs.find((entry) => entry.targetId === targetId) || {
        targetId,
        type: 'page',
        title: '',
        url,
        attached: false,
        active: false,
      }
    );
  });
  await injectConsoleCapture(cdpUrl, tab.targetId).catch(() => undefined);
  return tab;
}

export async function focusBrowserTab(
  cdpUrl: string,
  targetId: string,
): Promise<void> {
  await withBrowserClient(cdpUrl, async (client) => {
    await client.send('Target.activateTarget', { targetId });
  });
}

export async function closeBrowserTab(
  cdpUrl: string,
  targetId: string,
): Promise<void> {
  await withBrowserClient(cdpUrl, async (client) => {
    const result = await client.send('Target.closeTarget', { targetId });
    if (result.success === false) {
      throw new BrowserError(404, 'Browser tab was not found');
    }
  });
}
