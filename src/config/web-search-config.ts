import { getConfigValues } from '../config-store.js';

export const WEB_SEARCH_CONFIG_KEYS = [
  'WEB_SEARCH_ENABLED',
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_MAX_RESULTS',
  'WEB_FETCH_PROVIDER',
  'WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
  'WEB_FETCH_MAX_CHARS',
  'WEB_FETCH_PAGE_SIZE',
  'WEB_FETCH_BROWSER_COMMAND',
  'WEB_FETCH_BROWSER_SITE_PROFILES',
  'WEB_SEARCH_ALLOWED_DOMAINS',
  'WEB_SEARCH_SEARXNG_BASE_URL',
  'WEB_SEARCH_TAVILY_API_KEY',
] as const;

export type WebSearchConfigKey = (typeof WEB_SEARCH_CONFIG_KEYS)[number];
export type WebSearchProviderId =
  | 'auto'
  | 'duckduckgo_html'
  | 'searxng'
  | 'tavily'
  | 'bing'
  | 'brave';
export type WebFetchProviderId = 'auto' | 'basic' | 'browser_cli';
export type WebFetchWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

export interface WebFetchBrowserSiteProfile {
  domains: string[];
  pathPrefixes: string[];
  forceProvider?: Extract<WebFetchProviderId, 'basic' | 'browser_cli'>;
  waitSelector: string;
  selectorTimeoutMs?: number;
  postWaitMs?: number;
  waitUntil?: WebFetchWaitUntil;
  viewport: string;
  userAgent: string;
}

export interface WebSearchRuntimeConfig {
  enabled: boolean;
  provider: WebSearchProviderId;
  maxResults: number;
  fetchProvider: WebFetchProviderId;
  fetchUseBuiltinSiteProfiles: boolean;
  maxChars: number;
  pageSize: number;
  fetchBrowserCommand: string;
  fetchBrowserSiteProfiles: WebFetchBrowserSiteProfile[];
  allowedDomains: string[];
  searxngBaseUrl: string;
  tavilyApiKey: string;
}

export interface WebSearchRunnerEnvOptions {
  allowBrowserCli?: boolean;
}

const DEFAULT_RUNTIME_CONFIG: WebSearchRuntimeConfig = {
  enabled: true,
  provider: 'auto',
  maxResults: 5,
  fetchProvider: 'auto',
  fetchUseBuiltinSiteProfiles: false,
  maxChars: 12000,
  pageSize: 6000,
  fetchBrowserCommand: '',
  fetchBrowserSiteProfiles: [],
  allowedDomains: [],
  searxngBaseUrl: '',
  tavilyApiKey: '',
};

function normalizeBooleanString(value: unknown, fallback: boolean): string {
  if (value === true || String(value).trim().toLowerCase() === 'true') {
    return 'true';
  }
  if (value === false || String(value).trim().toLowerCase() === 'false') {
    return 'false';
  }
  return fallback ? 'true' : 'false';
}

function normalizeProvider(value: unknown): WebSearchProviderId {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === 'auto' ||
    normalized === 'duckduckgo_html' ||
    normalized === 'searxng' ||
    normalized === 'tavily' ||
    normalized === 'bing' ||
    normalized === 'brave'
  ) {
    return (normalized || 'auto') as WebSearchProviderId;
  }
  throw new Error(`Unsupported WEB_SEARCH_PROVIDER: ${value}`);
}

function normalizeFetchProvider(value: unknown): WebFetchProviderId {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (
    !normalized ||
    normalized === 'auto' ||
    normalized === 'basic' ||
    normalized === 'browser_cli'
  ) {
    return (normalized || 'auto') as WebFetchProviderId;
  }
  throw new Error(`Unsupported WEB_FETCH_PROVIDER: ${value}`);
}

function normalizeUrlString(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new URL(text);
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeWaitUntil(value: unknown): WebFetchWaitUntil | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === 'load' ||
    normalized === 'domcontentloaded' ||
    normalized === 'networkidle'
  ) {
    return normalized as WebFetchWaitUntil;
  }
  throw new Error(
    `Unsupported waitUntil in WEB_FETCH_BROWSER_SITE_PROFILES: ${value}`,
  );
}

function normalizeOptionalBoundedInt(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer but got: ${value}`);
  }
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeDomains(domains: string[]): string[] {
  return Array.from(
    new Set(domains.map((entry) => entry.trim().toLowerCase()).filter(Boolean)),
  ).slice(0, 20);
}

export function parseWebSearchAllowedDomains(raw: unknown): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  return normalizeDomains(text.split(/[\n,\s]+/));
}

export function serializeWebSearchAllowedDomains(domains: string[]): string {
  return domains.join('\n');
}

export function parseWebFetchBrowserSiteProfiles(
  raw: unknown,
): WebFetchBrowserSiteProfile[] {
  const text = String(raw || '').trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('WEB_FETCH_BROWSER_SITE_PROFILES must be valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('WEB_FETCH_BROWSER_SITE_PROFILES must be a JSON array');
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `WEB_FETCH_BROWSER_SITE_PROFILES[${index}] must be a JSON object`,
      );
    }
    const record = entry as Record<string, unknown>;
    const domains = normalizeDomains(
      Array.isArray(record.domains)
        ? record.domains.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    if (domains.length === 0) {
      throw new Error(
        `WEB_FETCH_BROWSER_SITE_PROFILES[${index}].domains must be a non-empty string array`,
      );
    }

    const pathPrefixes = Array.isArray(record.pathPrefixes)
      ? Array.from(
          new Set(
            record.pathPrefixes
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ).slice(0, 20)
      : [];
    const forceProvider = String(record.forceProvider || '')
      .trim()
      .toLowerCase();
    if (
      forceProvider &&
      forceProvider !== 'basic' &&
      forceProvider !== 'browser_cli'
    ) {
      throw new Error(
        `WEB_FETCH_BROWSER_SITE_PROFILES[${index}].forceProvider must be "basic" or "browser_cli"`,
      );
    }

    return {
      domains,
      pathPrefixes,
      forceProvider: forceProvider
        ? (forceProvider as WebFetchBrowserSiteProfile['forceProvider'])
        : undefined,
      waitSelector: String(record.waitSelector || '').trim(),
      selectorTimeoutMs: normalizeOptionalBoundedInt(
        record.selectorTimeoutMs,
        100,
        120000,
      ),
      postWaitMs: normalizeOptionalBoundedInt(record.postWaitMs, 0, 30000),
      waitUntil: normalizeWaitUntil(record.waitUntil),
      viewport: String(record.viewport || '').trim(),
      userAgent: String(record.userAgent || '').trim(),
    };
  });
}

export function serializeWebFetchBrowserSiteProfiles(
  profiles: WebFetchBrowserSiteProfile[],
): string {
  if (profiles.length === 0) return '';
  return JSON.stringify(profiles, null, 2);
}

export function normalizeWebSearchConfigEntry(
  key: string,
  value: unknown,
): string {
  switch (key) {
    case 'WEB_SEARCH_ENABLED':
      return normalizeBooleanString(value, DEFAULT_RUNTIME_CONFIG.enabled);
    case 'WEB_SEARCH_PROVIDER':
      return normalizeProvider(value);
    case 'WEB_SEARCH_MAX_RESULTS':
      return String(
        normalizeBoundedInt(value, DEFAULT_RUNTIME_CONFIG.maxResults, 1, 10),
      );
    case 'WEB_FETCH_PROVIDER':
      return normalizeFetchProvider(value);
    case 'WEB_FETCH_USE_BUILTIN_SITE_PROFILES':
      return normalizeBooleanString(
        value,
        DEFAULT_RUNTIME_CONFIG.fetchUseBuiltinSiteProfiles,
      );
    case 'WEB_FETCH_MAX_CHARS':
      return String(
        normalizeBoundedInt(value, DEFAULT_RUNTIME_CONFIG.maxChars, 500, 50000),
      );
    case 'WEB_FETCH_PAGE_SIZE':
      return String(
        normalizeBoundedInt(
          value,
          DEFAULT_RUNTIME_CONFIG.pageSize,
          1000,
          20000,
        ),
      );
    case 'WEB_FETCH_BROWSER_COMMAND':
      return String(value ?? '').trim();
    case 'WEB_FETCH_BROWSER_SITE_PROFILES':
      return serializeWebFetchBrowserSiteProfiles(
        parseWebFetchBrowserSiteProfiles(value),
      );
    case 'WEB_SEARCH_ALLOWED_DOMAINS':
      return serializeWebSearchAllowedDomains(
        parseWebSearchAllowedDomains(value),
      );
    case 'WEB_SEARCH_SEARXNG_BASE_URL':
      return normalizeUrlString(value);
    case 'WEB_SEARCH_TAVILY_API_KEY':
      return String(value ?? '').trim();
    default:
      return String(value ?? '');
  }
}

export async function getEffectiveWebSearchConfig(): Promise<WebSearchRuntimeConfig> {
  const values = await getConfigValues([...WEB_SEARCH_CONFIG_KEYS]);
  return {
    enabled:
      normalizeBooleanString(
        values.WEB_SEARCH_ENABLED,
        DEFAULT_RUNTIME_CONFIG.enabled,
      ) === 'true',
    provider: normalizeProvider(values.WEB_SEARCH_PROVIDER),
    maxResults: normalizeBoundedInt(
      values.WEB_SEARCH_MAX_RESULTS,
      DEFAULT_RUNTIME_CONFIG.maxResults,
      1,
      10,
    ),
    fetchProvider: normalizeFetchProvider(values.WEB_FETCH_PROVIDER),
    fetchUseBuiltinSiteProfiles:
      normalizeBooleanString(
        values.WEB_FETCH_USE_BUILTIN_SITE_PROFILES,
        DEFAULT_RUNTIME_CONFIG.fetchUseBuiltinSiteProfiles,
      ) === 'true',
    maxChars: normalizeBoundedInt(
      values.WEB_FETCH_MAX_CHARS,
      DEFAULT_RUNTIME_CONFIG.maxChars,
      500,
      50000,
    ),
    pageSize: normalizeBoundedInt(
      values.WEB_FETCH_PAGE_SIZE,
      DEFAULT_RUNTIME_CONFIG.pageSize,
      1000,
      20000,
    ),
    fetchBrowserCommand: String(values.WEB_FETCH_BROWSER_COMMAND || '').trim(),
    fetchBrowserSiteProfiles: parseWebFetchBrowserSiteProfiles(
      values.WEB_FETCH_BROWSER_SITE_PROFILES,
    ),
    allowedDomains: parseWebSearchAllowedDomains(
      values.WEB_SEARCH_ALLOWED_DOMAINS,
    ),
    searxngBaseUrl: normalizeUrlString(values.WEB_SEARCH_SEARXNG_BASE_URL),
    tavilyApiKey: String(values.WEB_SEARCH_TAVILY_API_KEY || '').trim(),
  };
}

export function applyWebSearchCapabilityPolicy(
  config: WebSearchRuntimeConfig,
  options: WebSearchRunnerEnvOptions = {},
): WebSearchRuntimeConfig {
  if (options.allowBrowserCli !== false) {
    return config;
  }

  return {
    ...config,
    fetchProvider:
      config.fetchProvider === 'browser_cli' ? 'basic' : config.fetchProvider,
    fetchBrowserCommand: '',
    fetchBrowserSiteProfiles: config.fetchBrowserSiteProfiles.map((profile) => ({
      ...profile,
      forceProvider:
        profile.forceProvider === 'browser_cli' ? 'basic' : profile.forceProvider,
    })),
  };
}

export async function buildWebSearchRunnerEnv(
  options: WebSearchRunnerEnvOptions = {},
): Promise<Record<string, string>> {
  const config = applyWebSearchCapabilityPolicy(
    await getEffectiveWebSearchConfig(),
    options,
  );
  return {
    NANOCLAW_WEB_SEARCH_ENABLED: config.enabled ? 'true' : 'false',
    NANOCLAW_WEB_SEARCH_PROVIDER: config.provider,
    NANOCLAW_WEB_SEARCH_MAX_RESULTS: String(config.maxResults),
    NANOCLAW_WEB_FETCH_PROVIDER: config.fetchProvider,
    NANOCLAW_WEB_FETCH_USE_BUILTIN_SITE_PROFILES:
      config.fetchUseBuiltinSiteProfiles ? 'true' : 'false',
    NANOCLAW_WEB_FETCH_MAX_CHARS: String(config.maxChars),
    NANOCLAW_WEB_FETCH_PAGE_SIZE: String(config.pageSize),
    NANOCLAW_WEB_FETCH_BROWSER_COMMAND: config.fetchBrowserCommand,
    NANOCLAW_WEB_FETCH_BROWSER_SITE_PROFILES: JSON.stringify(
      config.fetchBrowserSiteProfiles,
    ),
    NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS: JSON.stringify(config.allowedDomains),
    NANOCLAW_WEB_SEARCH_SEARXNG_BASE_URL: config.searxngBaseUrl,
    NANOCLAW_WEB_SEARCH_TAVILY_API_KEY: config.tavilyApiKey,
  };
}
