import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, getStartupConfigValue } from '../config.js';
import { DEFAULTS } from '../config-store.js';
import { normalizeBrowserUrl } from './policy.js';
import {
  BROWSER_CONFIG_KEYS,
  type BrowserConnectionMode,
  type BrowserConfigKey,
  type BrowserRuntimeConfig,
} from './types.js';

const MACOS_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const LINUX_BROWSER_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/brave-browser',
  '/usr/bin/brave-browser-stable',
];

const WINDOWS_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
];

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return fallback;
}

function normalizeTimeout(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeStartUrl(value: unknown): string {
  try {
    return normalizeBrowserUrl(value, 'WEB_BROWSER_START_URL');
  } catch {
    throw new Error(
      'WEB_BROWSER_START_URL must be about:blank or a safe http(s) URL',
    );
  }
}

function normalizeConnectionMode(value: unknown): BrowserConnectionMode {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized || normalized === 'managed') {
    return 'managed';
  }
  if (normalized === 'connect') {
    return 'connect';
  }
  throw new Error(
    'WEB_BROWSER_CONNECTION_MODE must be managed or connect',
  );
}

function normalizeRemoteDebugUrl(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('WEB_BROWSER_REMOTE_DEBUG_URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEB_BROWSER_REMOTE_DEBUG_URL must use http or https');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    hostname !== '[::1]' &&
    hostname !== '::1'
  ) {
    throw new Error(
      'WEB_BROWSER_REMOTE_DEBUG_URL must point to localhost or 127.0.0.1',
    );
  }
  if (!url.port) {
    throw new Error('WEB_BROWSER_REMOTE_DEBUG_URL must include a debug port');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
}

export function normalizeBrowserConfigEntry(
  key: string,
  value: unknown,
): string {
  switch (key) {
    case 'WEB_BROWSER_ENABLED':
    case 'WEB_BROWSER_HEADLESS':
      return normalizeBoolean(value).toString();
    case 'WEB_BROWSER_CONNECTION_MODE':
      return normalizeConnectionMode(value);
    case 'WEB_BROWSER_REMOTE_DEBUG_URL':
      return normalizeRemoteDebugUrl(value);
    case 'WEB_BROWSER_EXECUTABLE_PATH':
      return String(value || '').trim();
    case 'WEB_BROWSER_EXTRA_ARGS': {
      const text = String(value || '').trim();
      if (!text) {
        return '';
      }
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error('WEB_BROWSER_EXTRA_ARGS must be a JSON string array');
      }
      return JSON.stringify(
        parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
    }
    case 'WEB_BROWSER_START_URL':
      return normalizeStartUrl(value);
    case 'WEB_BROWSER_STARTUP_TIMEOUT_MS':
      return String(normalizeTimeout(value, 15000, 3000, 60000));
    case 'WEB_BROWSER_ACTION_TIMEOUT_MS':
      return String(normalizeTimeout(value, 10000, 1000, 60000));
    default:
      return String(value || '').trim();
  }
}

export function getBrowserDefaultConfigValues(): Record<BrowserConfigKey, string> {
  const result = {} as Record<BrowserConfigKey, string>;
  for (const key of BROWSER_CONFIG_KEYS) {
    const raw = getStartupConfigValue(key);
    result[key] = raw !== '' ? raw : DEFAULTS[key] || '';
  }
  return result;
}

export function resolveManagedBrowserUserDataDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'browser-control', 'user-data');
}

export function resolveBrowserExecutablePath(
  inputPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    existsSync?: (filePath: string) => boolean;
  },
): string | null {
  const existsSync = opts?.existsSync || fs.existsSync;
  const configured = inputPath.trim();
  if (configured) {
    return existsSync(configured) ? configured : null;
  }

  const platform = opts?.platform || process.platform;
  const homeDir = opts?.homeDir || process.env.HOME || os.homedir();
  const candidates =
    platform === 'darwin'
      ? [
          ...MACOS_BROWSER_PATHS,
          path.join(
            homeDir,
            'Applications',
            'Google Chrome.app',
            'Contents',
            'MacOS',
            'Google Chrome',
          ),
        ]
      : platform === 'win32'
        ? WINDOWS_BROWSER_PATHS
        : LINUX_BROWSER_PATHS;

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function parseExtraArgs(value: string): string[] {
  const text = value.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('WEB_BROWSER_EXTRA_ARGS must be a JSON string array');
  }
  return parsed
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveBrowserRuntimeConfig(opts?: {
  values?: Record<string, string>;
  dataDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  existsSync?: (filePath: string) => boolean;
}): BrowserRuntimeConfig {
  const values =
    opts?.values || (getBrowserDefaultConfigValues() as Record<string, string>);
  const executablePath = String(values.WEB_BROWSER_EXECUTABLE_PATH || '').trim();
  const userDataDir = resolveManagedBrowserUserDataDir(opts?.dataDir);
  fs.mkdirSync(userDataDir, { recursive: true });

  return {
    enabled: normalizeBoolean(values.WEB_BROWSER_ENABLED, false),
    connectionMode: normalizeConnectionMode(
      values.WEB_BROWSER_CONNECTION_MODE,
    ),
    remoteDebugUrl: normalizeRemoteDebugUrl(
      values.WEB_BROWSER_REMOTE_DEBUG_URL,
    ),
    executablePath,
    resolvedExecutablePath: resolveBrowserExecutablePath(executablePath, {
      platform: opts?.platform,
      homeDir: opts?.homeDir,
      existsSync: opts?.existsSync,
    }),
    headless: normalizeBoolean(values.WEB_BROWSER_HEADLESS, false),
    extraArgs: parseExtraArgs(String(values.WEB_BROWSER_EXTRA_ARGS || '')),
    startupUrl: normalizeStartUrl(values.WEB_BROWSER_START_URL),
    startupTimeoutMs: normalizeTimeout(
      values.WEB_BROWSER_STARTUP_TIMEOUT_MS,
      15000,
      3000,
      60000,
    ),
    actionTimeoutMs: normalizeTimeout(
      values.WEB_BROWSER_ACTION_TIMEOUT_MS,
      10000,
      1000,
      60000,
    ),
    userDataDir,
  };
}
