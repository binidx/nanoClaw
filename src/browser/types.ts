export const BROWSER_CONFIG_KEYS = [
  'WEB_BROWSER_ENABLED',
  'WEB_BROWSER_CONNECTION_MODE',
  'WEB_BROWSER_REMOTE_DEBUG_URL',
  'WEB_BROWSER_HEADLESS',
  'WEB_BROWSER_EXECUTABLE_PATH',
  'WEB_BROWSER_EXTRA_ARGS',
  'WEB_BROWSER_START_URL',
  'WEB_BROWSER_STARTUP_TIMEOUT_MS',
  'WEB_BROWSER_ACTION_TIMEOUT_MS',
] as const;

export type BrowserConfigKey = (typeof BROWSER_CONFIG_KEYS)[number];

export type BrowserConnectionMode = 'managed' | 'connect';

export interface BrowserRuntimeConfig {
  enabled: boolean;
  connectionMode: BrowserConnectionMode;
  remoteDebugUrl: string;
  executablePath: string;
  resolvedExecutablePath: string | null;
  headless: boolean;
  extraArgs: string[];
  startupUrl: string;
  startupTimeoutMs: number;
  actionTimeoutMs: number;
  userDataDir: string;
}

export interface BrowserTab {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  active: boolean;
}

export interface BrowserSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  depth: number;
  actionable: boolean;
  frameId?: string;
  parentFrameId?: string;
  frameUrl?: string;
  frameName?: string;
  topFrame?: boolean;
}

export interface BrowserSnapshotFrame {
  frameId: string;
  url?: string;
  name?: string;
  parentFrameId?: string;
  topFrame: boolean;
}

export interface BrowserSnapshot {
  targetId: string;
  title: string;
  url: string;
  frames: BrowserSnapshotFrame[];
  nodes: BrowserSnapshotNode[];
  cacheHit?: boolean;
  pageVersion?: string;
  capturedAt?: string;
  stale?: boolean;
}

export interface BrowserRoleSnapshotRef {
  role: string;
  name?: string;
  frameId?: string;
  frameName?: string;
  topFrame?: boolean;
}

export interface BrowserRoleSnapshotStats {
  lines: number;
  chars: number;
  refs: number;
  interactive: number;
}

export interface BrowserRoleSnapshot {
  targetId: string;
  title: string;
  url: string;
  snapshot: string;
  refs: Record<string, BrowserRoleSnapshotRef>;
  stats: BrowserRoleSnapshotStats;
  truncated?: boolean;
  cacheHit?: boolean;
  pageVersion?: string;
  capturedAt?: string;
  stale?: boolean;
}

export interface BrowserScreenshot {
  targetId: string;
  title: string;
  url: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export interface BrowserPageError {
  message: string;
  description?: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export interface BrowserLogs {
  console: BrowserConsoleEntry[];
  errors: BrowserPageError[];
}

export type BrowserAction =
  | {
      kind: 'navigate';
      url: string;
      timeoutMs?: number;
    }
  | {
      kind: 'click';
      ref?: string;
      selector?: string;
      clickCount?: number;
    }
  | {
      kind: 'type';
      ref?: string;
      selector?: string;
      text: string;
    }
  | {
      kind: 'press';
      key: string;
    }
  | {
      kind: 'hover';
      ref?: string;
      selector?: string;
    }
  | {
      kind: 'scrollIntoView';
      ref?: string;
      selector?: string;
    }
  | {
      kind: 'wait';
      timeMs?: number;
    }
  | {
      kind: 'waitFor';
      selector?: string;
      urlIncludes?: string;
      titleIncludes?: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  | {
      kind: 'close';
    }
  | { kind: 'back'; timeoutMs?: number }
  | { kind: 'forward'; timeoutMs?: number }
  | { kind: 'reload'; timeoutMs?: number }
  | {
      kind: 'select';
      ref?: string;
      selector?: string;
      value: string;
    }
  | {
      kind: 'scroll';
      x?: number;
      y?: number;
      ref?: string;
      selector?: string;
    }
  | {
      kind: 'evaluate';
      expression: string;
    };

export interface BrowserActionResult {
  ok: true;
  targetId: string;
  title?: string;
  url?: string;
  waitedMs?: number;
  ref?: string;
  selector?: string;
  key?: string;
  evaluateResult?: string;
}

export interface BrowserErrorContext {
  action?: string;
  ref?: string;
  selector?: string;
  suggestion?: string;
}

export interface BrowserErrorResponse {
  error: string;
  errorContext?: Omit<BrowserErrorContext, 'suggestion'>;
  suggestion?: string;
}

export interface BrowserStatus {
  enabled: boolean;
  running: boolean;
  connectionMode: BrowserConnectionMode;
  remoteDebugUrl: string;
  headless: boolean;
  userDataDir: string;
  executablePath: string;
  resolvedExecutablePath: string | null;
  debugPort: number | null;
  startedAt: string | null;
  lastTargetId: string | null;
  lastError: string;
}

export class BrowserError extends Error {
  status: number;

  details?: BrowserErrorContext;

  constructor(status: number, message: string, details?: BrowserErrorContext) {
    super(message);
    this.name = 'BrowserError';
    this.status = status;
    this.details = details;
  }
}

export interface BrowserServiceLike {
  getStatus(): Promise<BrowserStatus>;
  start(): Promise<BrowserStatus>;
  stop(): Promise<BrowserStatus>;
  listTabs(): Promise<{ running: boolean; tabs: BrowserTab[] }>;
  openTab(url: string): Promise<BrowserTab>;
  focusTab(targetId: string): Promise<void>;
  closeTab(targetId: string): Promise<void>;
  getSnapshot(input: {
    targetId?: string;
    maxNodes?: number;
    force?: boolean;
  }): Promise<BrowserSnapshot>;
  getRoleSnapshot(input: {
    targetId?: string;
    interactive?: boolean;
    compact?: boolean;
    maxDepth?: number;
    maxChars?: number;
    maxNodes?: number;
    force?: boolean;
  }): Promise<BrowserRoleSnapshot>;
  getScreenshot(input: {
    targetId?: string;
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
  }): Promise<BrowserScreenshot>;
  getLogs(input: {
    targetId?: string;
  }): Promise<BrowserLogs>;
  act(input: {
    targetId?: string;
    action: BrowserAction;
  }): Promise<BrowserActionResult>;
}
