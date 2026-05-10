import { type RunningBrowserProcess, launchManagedBrowser, stopManagedBrowser } from './chrome.js';
import {
  captureBrowserScreenshot,
  closeBrowserTab,
  createBrowserSnapshot,
  createBrowserTab,
  focusBrowserTab,
  listBrowserTabs,
  readBrowserLogs,
  runBrowserAction,
  type ResolvedSnapshotRef,
} from './cdp.js';
import { resolveBrowserRuntimeConfig } from './config.js';
import { normalizeBrowserUrl } from './policy.js';
import { buildBrowserRoleSnapshot } from './role-snapshot.js';
import {
  BrowserError,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserConnectionMode,
  type BrowserLogs,
  type BrowserRoleSnapshot,
  type BrowserServiceLike,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserStatus,
  type BrowserTab,
} from './types.js';

interface CachedSnapshotEntry {
  snapshot: BrowserSnapshot;
  resolvedRefs: Record<string, ResolvedSnapshotRef>;
  maxNodes: number;
  pageVersion: string;
  capturedAt: string;
  dirty: boolean;
  roleSnapshotsByKey: Map<string, BrowserRoleSnapshot>;
}

interface ResolvedTarget {
  targetId: string;
  tab: BrowserTab | null;
}

function normalizeSnapshotMaxNodes(maxNodes?: number): number {
  if (typeof maxNodes === 'number' && maxNodes > 0) {
    return Math.min(1000, maxNodes);
  }
  return 200;
}

function buildPageVersion(title: string, url: string): string {
  return `${url}\n${title}`;
}

function buildRoleSnapshotCacheKey(input: {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  maxChars?: number;
  maxNodes: number;
}): string {
  return [
    `interactive:${String(input.interactive)}`,
    `compact:${String(input.compact)}`,
    `maxDepth:${String(input.maxDepth)}`,
    `maxChars:${String(input.maxChars)}`,
    `maxNodes:${input.maxNodes}`,
  ].join('|');
}

function getActionRef(action: BrowserAction): string | null {
  switch (action.kind) {
    case 'click':
    case 'type':
    case 'hover':
    case 'scrollIntoView':
    case 'select':
    case 'scroll': {
      const ref = String(action.ref || '').trim();
      return ref || null;
    }
    default:
      return null;
  }
}

class BrowserService implements BrowserServiceLike {
  private static readonly STATUS_CHECK_TIMEOUT_MS = 5000;

  private static readonly MAX_STATUS_FAILURES = 3;

  private running: RunningBrowserProcess | null = null;

  private remoteSession:
    | {
        cdpUrl: string;
        startedAt: string;
        debugPort: number | null;
      }
    | null = null;

  private lastTargetId: string | null = null;

  private lastError = '';

  private readonly snapshotCacheByTarget = new Map<string, CachedSnapshotEntry>();

  private statusFailures = 0;

  private operationQueue = Promise.resolve();

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(run, run);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private syncRunningProcess(): void {
    if (this.running && this.running.proc.exitCode !== null) {
      this.running = null;
      this.lastTargetId = null;
      this.statusFailures = 0;
      this.snapshotCacheByTarget.clear();
    }
  }

  private parseDebugPort(url: string): number | null {
    try {
      const parsed = new URL(url);
      const port = Number.parseInt(parsed.port, 10);
      return Number.isFinite(port) ? port : null;
    } catch {
      return null;
    }
  }

  private getActiveConnection(config = resolveBrowserRuntimeConfig()): {
    mode: BrowserConnectionMode;
    cdpUrl: string | null;
    debugPort: number | null;
    startedAt: string | null;
  } {
    if (this.running) {
      return {
        mode: 'managed',
        cdpUrl: `http://127.0.0.1:${this.running.debugPort}`,
        debugPort: this.running.debugPort,
        startedAt: this.running.startedAt,
      };
    }
    if (this.remoteSession) {
      return {
        mode: 'connect',
        cdpUrl: this.remoteSession.cdpUrl,
        debugPort: this.remoteSession.debugPort,
        startedAt: this.remoteSession.startedAt,
      };
    }
    return {
      mode: config.connectionMode,
      cdpUrl: null,
      debugPort: config.connectionMode === 'connect'
        ? this.parseDebugPort(config.remoteDebugUrl)
        : null,
      startedAt: null,
    };
  }

  async getStatus(): Promise<BrowserStatus> {
    this.syncRunningProcess();
    const config = resolveBrowserRuntimeConfig();
    const connection = this.getActiveConnection(config);
    let running = Boolean(connection.cdpUrl);

    if (running && connection.cdpUrl) {
      try {
        await listBrowserTabs(
          connection.cdpUrl,
          BrowserService.STATUS_CHECK_TIMEOUT_MS,
        );
        this.statusFailures = 0;
        this.lastError = '';
      } catch (err) {
        this.statusFailures += 1;
        this.lastError =
          err instanceof Error ? err.message : 'Browser connection is unreachable';
        if (this.statusFailures >= BrowserService.MAX_STATUS_FAILURES) {
          running = false;
          if (connection.mode === 'managed') {
            this.running = null;
          } else {
            this.remoteSession = null;
          }
          this.lastTargetId = null;
          this.snapshotCacheByTarget.clear();
        }
      }
    }

    return {
      enabled: config.enabled,
      running,
      connectionMode: config.connectionMode,
      remoteDebugUrl: config.remoteDebugUrl,
      headless: config.headless,
      userDataDir: this.running?.userDataDir || config.userDataDir,
      executablePath: config.executablePath,
      resolvedExecutablePath:
        this.running?.executablePath || config.resolvedExecutablePath,
      debugPort: connection.debugPort,
      startedAt: connection.startedAt,
      lastTargetId: this.lastTargetId,
      lastError: this.lastError,
    };
  }

  async start(): Promise<BrowserStatus> {
    return await this.enqueue(() => this.doStart());
  }

  async stop(): Promise<BrowserStatus> {
    return await this.enqueue(() => this.doStop());
  }

  async listTabs(): Promise<{ running: boolean; tabs: BrowserTab[] }> {
    return await this.enqueue(() => this.doListTabs());
  }

  async openTab(url: string): Promise<BrowserTab> {
    return await this.enqueue(async () => {
      const config = resolveBrowserRuntimeConfig();
      const normalizedUrl = normalizeBrowserUrl(url);
      if (!config.enabled) {
        throw new BrowserError(
          409,
          'Browser control is disabled. Set WEB_BROWSER_ENABLED=true first.',
        );
      }
      const status = await this.getStatus();
      if (!status.running) {
        await this.doStart();
      }
      const tab = await createBrowserTab(this.getRunningCdpUrl(), normalizedUrl);
      this.lastTargetId = tab.targetId;
      return tab;
    });
  }

  async focusTab(targetId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.requireRunning();
      await focusBrowserTab(this.getRunningCdpUrl(), targetId);
      this.lastTargetId = targetId;
    });
  }

  async closeTab(targetId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.requireRunning();
      await closeBrowserTab(this.getRunningCdpUrl(), targetId);
      this.snapshotCacheByTarget.delete(targetId);
      const tabs = await listBrowserTabs(this.getRunningCdpUrl()).catch(() => []);
      this.lastTargetId = tabs[0]?.targetId || null;
    });
  }

  async getSnapshot(input: {
    targetId?: string;
    maxNodes?: number;
    force?: boolean;
  }): Promise<BrowserSnapshot> {
    return await this.enqueue(async () => {
      await this.requireRunning();
      const maxNodes = normalizeSnapshotMaxNodes(input.maxNodes);
      const { entry, cacheHit } = await this.getSnapshotCacheEntry({
        targetId: input.targetId,
        maxNodes,
        force: input.force,
      });
      return {
        targetId: entry.snapshot.targetId,
        title: entry.snapshot.title,
        url: entry.snapshot.url,
        frames: entry.snapshot.frames,
        nodes: entry.snapshot.nodes.slice(0, maxNodes),
        cacheHit,
        pageVersion: entry.pageVersion,
        capturedAt: entry.capturedAt,
        stale: entry.dirty,
      };
    });
  }

  async getRoleSnapshot(input: {
    targetId?: string;
    interactive?: boolean;
    compact?: boolean;
    maxDepth?: number;
    maxChars?: number;
    maxNodes?: number;
    force?: boolean;
  }): Promise<BrowserRoleSnapshot> {
    return await this.enqueue(async () => {
      await this.requireRunning();
      const maxNodes = normalizeSnapshotMaxNodes(input.maxNodes);
      const { entry } = await this.getSnapshotCacheEntry({
        targetId: input.targetId,
        maxNodes,
        force: input.force,
      });
      const roleCacheKey = buildRoleSnapshotCacheKey({
        interactive: input.interactive,
        compact: input.compact,
        maxDepth: input.maxDepth,
        maxChars: input.maxChars,
        maxNodes,
      });
      const cachedRoleSnapshot =
        input.force === true
          ? undefined
          : entry.roleSnapshotsByKey.get(roleCacheKey);
      if (cachedRoleSnapshot) {
        return {
          ...cachedRoleSnapshot,
          cacheHit: true,
          pageVersion: entry.pageVersion,
          capturedAt: entry.capturedAt,
          stale: entry.dirty,
        };
      }

      const builtRoleSnapshot = buildBrowserRoleSnapshot({
        snapshot: entry.snapshot,
        resolvedRefs: entry.resolvedRefs,
        options: {
          interactive: input.interactive,
          compact: input.compact,
          maxDepth: input.maxDepth,
        },
        maxChars: input.maxChars,
      });
      entry.roleSnapshotsByKey.set(roleCacheKey, builtRoleSnapshot);
      return {
        ...builtRoleSnapshot,
        cacheHit: false,
        pageVersion: entry.pageVersion,
        capturedAt: entry.capturedAt,
        stale: entry.dirty,
      };
    });
  }

  async getScreenshot(input: {
    targetId?: string;
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
  }): Promise<BrowserScreenshot> {
    return await this.enqueue(async () => {
      await this.requireRunning();
      const { targetId } = await this.resolveTarget(input.targetId);
      const screenshot = await captureBrowserScreenshot({
        cdpUrl: this.getRunningCdpUrl(),
        targetId,
        format: input.format,
        quality: input.quality,
      });
      this.lastTargetId = screenshot.targetId;
      return screenshot;
    });
  }

  async getLogs(input: {
    targetId?: string;
  }): Promise<BrowserLogs> {
    return await this.enqueue(async () => {
      await this.requireRunning();
      const { targetId } = await this.resolveTarget(input.targetId);
      const logs = await readBrowserLogs(this.getRunningCdpUrl(), targetId);
      this.lastTargetId = targetId;
      return logs;
    });
  }

  async act(input: {
    targetId?: string;
    action: BrowserAction;
  }): Promise<BrowserActionResult> {
    return await this.enqueue(async () => {
      await this.requireRunning();
      const { targetId } = await this.resolveTarget(input.targetId);

      if (input.action.kind === 'wait') {
        const waitedMs = Math.max(0, Math.min(30000, input.action.timeMs || 0));
        if (waitedMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitedMs));
        }
        return { ok: true, targetId, waitedMs };
      }

      const action =
        input.action.kind === 'navigate'
          ? {
              ...input.action,
              url: normalizeBrowserUrl(input.action.url),
            }
          : input.action;
      const executeAction = async (
        resolvedRefs: Record<string, ResolvedSnapshotRef> | undefined,
      ) =>
        await runBrowserAction({
          cdpUrl: this.getRunningCdpUrl(),
          targetId,
          action,
          resolvedRefs,
          defaultTimeoutMs: resolveBrowserRuntimeConfig().actionTimeoutMs,
        });

      let result: Awaited<ReturnType<typeof runBrowserAction>>;
      try {
        result = await executeAction(
          this.snapshotCacheByTarget.get(targetId)?.resolvedRefs,
        );
      } catch (error) {
        if (!this.shouldRetryWithFreshSnapshot(action, error)) {
          throw error;
        }
        const { entry } = await this.getSnapshotCacheEntry({
          targetId,
          maxNodes:
            this.snapshotCacheByTarget.get(targetId)?.maxNodes ||
            normalizeSnapshotMaxNodes(),
          force: true,
        });
        result = await executeAction(entry.resolvedRefs);
      }

      if (
        action.kind === 'navigate' ||
        action.kind === 'click' ||
        action.kind === 'type' ||
        action.kind === 'press' ||
        action.kind === 'back' ||
        action.kind === 'forward' ||
        action.kind === 'reload' ||
        action.kind === 'select'
      ) {
        this.markSnapshotDirty(targetId);
      }

      if (action.kind === 'close') {
        this.snapshotCacheByTarget.delete(targetId);
        const tabs = await listBrowserTabs(this.getRunningCdpUrl()).catch(() => []);
        this.lastTargetId = tabs[0]?.targetId || null;
      } else {
        this.lastTargetId = result.targetId;
      }

      return {
        ok: true,
        targetId: result.targetId,
        title: result.title,
        url: result.url,
        ...(typeof result.waitedMs === 'number'
          ? { waitedMs: result.waitedMs }
          : {}),
        ...(typeof result.evaluateResult === 'string'
          ? { evaluateResult: result.evaluateResult }
          : {}),
        ...(action.kind === 'click' ||
        action.kind === 'hover' ||
        action.kind === 'scrollIntoView' ||
        action.kind === 'type' ||
        action.kind === 'select' ||
        action.kind === 'scroll'
          ? {
              ...(action.ref ? { ref: action.ref } : {}),
              ...(action.selector ? { selector: action.selector } : {}),
            }
          : {}),
        ...(action.kind === 'press' ? { key: action.key } : {}),
      };
    });
  }

  private shouldRetryWithFreshSnapshot(
    action: BrowserAction,
    error: unknown,
  ): boolean {
    if (!(error instanceof BrowserError) || error.status !== 409) {
      return false;
    }

    const actionRef = getActionRef(action);
    if (!actionRef) {
      return false;
    }

    const errorRef = String(error.details?.ref || '').trim();
    if (errorRef && errorRef !== actionRef) {
      return false;
    }

    const guidance = error.message.toLowerCase();
    return (
      guidance.includes('unknown ref') ||
      guidance.includes('refs expire') ||
      guidance.includes('not recognized')
    );
  }

  private async requireRunning(): Promise<void> {
    const status = await this.getStatus();
    if (!status.running || !this.getActiveConnection().cdpUrl) {
      throw new BrowserError(409, 'Browser control is not connected');
    }
  }

  private async resolveTarget(targetId?: string): Promise<ResolvedTarget> {
    const normalized = String(targetId || '').trim();
    const tabs = await this.doListTabs();
    if (normalized) {
      return {
        targetId: normalized,
        tab: tabs.tabs.find((tab) => tab.targetId === normalized) || null,
      };
    }

    const preferred =
      tabs.tabs.find((tab) => tab.targetId === this.lastTargetId) || tabs.tabs[0];
    if (!preferred) {
      throw new BrowserError(409, 'No browser tabs are available');
    }
    return {
      targetId: preferred.targetId,
      tab: preferred,
    };
  }

  private markSnapshotDirty(targetId: string): void {
    const entry = this.snapshotCacheByTarget.get(targetId);
    if (!entry) {
      return;
    }
    entry.dirty = true;
    entry.resolvedRefs = {};
    entry.roleSnapshotsByKey.clear();
  }

  private async getSnapshotCacheEntry(input: {
    targetId?: string;
    maxNodes: number;
    force?: boolean;
  }): Promise<{ entry: CachedSnapshotEntry; cacheHit: boolean }> {
    const resolvedTarget = await this.resolveTarget(input.targetId);
    const cached = this.snapshotCacheByTarget.get(resolvedTarget.targetId);
    const currentPageVersion = resolvedTarget.tab
      ? buildPageVersion(resolvedTarget.tab.title, resolvedTarget.tab.url)
      : '';
    const canReuse =
      input.force !== true &&
      cached !== undefined &&
      cached.dirty !== true &&
      cached.maxNodes >= input.maxNodes &&
      cached.pageVersion === currentPageVersion;

    if (canReuse && cached) {
      this.lastTargetId = cached.snapshot.targetId;
      return { entry: cached, cacheHit: true };
    }

    const snapshot = await createBrowserSnapshot({
      cdpUrl: this.getRunningCdpUrl(),
      targetId: resolvedTarget.targetId,
      maxNodes: input.maxNodes,
    });
    const capturedAt = new Date().toISOString();
    const nextEntry: CachedSnapshotEntry = {
      snapshot: {
        targetId: snapshot.targetId,
        title: snapshot.title,
        url: snapshot.url,
        frames: snapshot.frames,
        nodes: snapshot.nodes,
      },
      resolvedRefs: snapshot.resolvedRefs,
      maxNodes: input.maxNodes,
      pageVersion: buildPageVersion(snapshot.title, snapshot.url),
      capturedAt,
      dirty: false,
      roleSnapshotsByKey: new Map<string, BrowserRoleSnapshot>(),
    };

    if (snapshot.targetId !== resolvedTarget.targetId) {
      this.snapshotCacheByTarget.delete(resolvedTarget.targetId);
    }
    this.snapshotCacheByTarget.set(snapshot.targetId, nextEntry);
    this.lastTargetId = snapshot.targetId;
    return { entry: nextEntry, cacheHit: false };
  }

  private async doStart(): Promise<BrowserStatus> {
    const status = await this.getStatus();
    if (status.running) {
      return status;
    }

    const config = resolveBrowserRuntimeConfig();
    if (!config.enabled) {
      throw new BrowserError(
        409,
        'Browser control is disabled. Set WEB_BROWSER_ENABLED=true first.',
      );
    }
    if (config.connectionMode === 'connect') {
      return await this.doConnectRemote(config);
    }
    return await this.doStartManaged(config);
  }

  private async doConnectRemote(
    config: ReturnType<typeof resolveBrowserRuntimeConfig>,
  ): Promise<BrowserStatus> {
    if (!config.remoteDebugUrl) {
      throw new BrowserError(
        400,
        'WEB_BROWSER_REMOTE_DEBUG_URL is required when connection mode is connect',
      );
    }
    try {
      const tabs = await listBrowserTabs(
        config.remoteDebugUrl,
        config.startupTimeoutMs,
      );
      this.remoteSession = {
        cdpUrl: config.remoteDebugUrl,
        startedAt: new Date().toISOString(),
        debugPort: this.parseDebugPort(config.remoteDebugUrl),
      };
      this.running = null;
      this.lastError = '';
      this.statusFailures = 0;
      if (tabs.length === 0) {
        const tab = await createBrowserTab(
          config.remoteDebugUrl,
          config.startupUrl,
        );
        this.lastTargetId = tab.targetId;
      } else {
        this.lastTargetId = tabs[0]?.targetId || null;
      }
      return await this.getStatus();
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : 'Failed to connect to existing browser';
      this.remoteSession = null;
      this.lastTargetId = null;
      this.snapshotCacheByTarget.clear();
      this.statusFailures = 0;
      throw err;
    }
  }

  private async doStartManaged(
    config: ReturnType<typeof resolveBrowserRuntimeConfig>,
  ): Promise<BrowserStatus> {
    try {
      this.running = await launchManagedBrowser(config);
      this.remoteSession = null;
      this.lastError = '';
      this.statusFailures = 0;

      const tabs = await listBrowserTabs(this.getRunningCdpUrl());
      if (tabs.length === 0) {
        const tab = await createBrowserTab(
          this.getRunningCdpUrl(),
          config.startupUrl,
        );
        this.lastTargetId = tab.targetId;
      } else {
        this.lastTargetId = tabs[0]?.targetId || null;
      }
      return await this.getStatus();
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : 'Failed to start managed browser';
      if (this.running) {
        await stopManagedBrowser(this.running).catch(() => undefined);
      }
      this.running = null;
      this.remoteSession = null;
      this.lastTargetId = null;
      this.snapshotCacheByTarget.clear();
      this.statusFailures = 0;
      throw err;
    }
  }

  private async doStop(): Promise<BrowserStatus> {
    if (this.running) {
      await stopManagedBrowser(this.running);
    }
    this.running = null;
    this.remoteSession = null;
    this.lastTargetId = null;
    this.snapshotCacheByTarget.clear();
    this.statusFailures = 0;
    this.lastError = '';
    return await this.getStatus();
  }

  private async doListTabs(): Promise<{ running: boolean; tabs: BrowserTab[] }> {
    const status = await this.getStatus();
    if (!status.running) {
      this.snapshotCacheByTarget.clear();
      return { running: false, tabs: [] };
    }
    const tabs = await listBrowserTabs(this.getRunningCdpUrl());
    const activeTabIds = new Set(tabs.map((tab) => tab.targetId));
    for (const targetId of this.snapshotCacheByTarget.keys()) {
      if (!activeTabIds.has(targetId)) {
        this.snapshotCacheByTarget.delete(targetId);
      }
    }
    if (!tabs.some((tab) => tab.targetId === this.lastTargetId)) {
      this.lastTargetId = tabs[0]?.targetId || null;
    }
    return { running: true, tabs };
  }

  private getRunningCdpUrl(): string {
    const connection = this.getActiveConnection();
    if (!connection.cdpUrl) {
      throw new BrowserError(409, 'Browser control is not connected');
    }
    return connection.cdpUrl;
  }
}

let browserService: BrowserServiceLike | null = null;

export function getBrowserService(): BrowserServiceLike {
  if (!browserService) {
    browserService = new BrowserService();
  }
  return browserService;
}

export function _setBrowserServiceForTests(
  service: BrowserServiceLike | null,
): void {
  browserService = service;
}
