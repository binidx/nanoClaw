import type { BrowserFetchSiteProfile } from '../web-fetch-site-profiles.js';

export interface SearchWebOptions {
  query: string;
  domains?: string[];
  maxResults?: number;
  timeoutMs?: number;
}

export interface FetchUrlOptions {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProviderName = 'auto' | 'duckduckgo_html' | 'searxng' | 'tavily' | 'bing' | 'brave';
export type SearchEngineName = 'baidu' | 'bing' | 'brave' | 'duckduckgo' | 'startpage' | 'searxng' | 'tavily';

export interface WebSearchRuntimeConfig {
  enabled: boolean;
  fetchEnabled: boolean;
  bingDomain: string;
  provider: SearchProviderName;
  engines: SearchEngineName[];
  maxResults: number;
  fetchProvider: 'auto' | 'basic' | 'browser_cli';
  fetchUseBuiltinSiteProfiles: boolean;
  maxChars: number;
  pageSize: number;
  fetchBrowserCommand: string;
  fetchBrowserSiteProfiles: BrowserFetchSiteProfile[];
  allowedDomains: string[];
  searxngBaseUrl: string;
  tavilyApiKey: string;
}

export interface SearchProvider {
  search: (
    config: WebSearchRuntimeConfig,
    options: SearchWebOptions,
  ) => Promise<string>;
}

export interface SearchEngine {
  search(
    query: string,
    maxResults: number,
    timeoutMs: number,
    config: WebSearchRuntimeConfig,
  ): Promise<SearchResult[]>;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

export function containsCJK(text: string): boolean {
  return CJK_RE.test(text);
}

export function urlMatchesDomains(url: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return domains.some((d) => domainMatches(hostname, d));
  } catch {
    return false;
  }
}

export interface FetchedResponse {
  body: string;
  contentType: string;
  finalUrl: string;
}

export interface ExtractedContent {
  title: string;
  text: string;
  markdown?: string;
}

export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_RESULTS = 5;
export const DEFAULT_MAX_FETCH_CHARS = 12000;
export const DEFAULT_PAGE_SIZE = 6000;
export const DEFAULT_PAGE_HEADROOM = 1;
export const MIN_BROWSER_FALLBACK_TEXT_CHARS = 1200;

export function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'");
}

export function normalizeWhitespace(text: string): string {
  return decodeHtml(text)
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function normalizeDomains(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) return [];
  return Array.from(
    new Set(
      domains
        .map((domain) => String(domain || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ).slice(0, 20);
}

function readEnvBoolean(key: string, fallback: boolean): boolean {
  const value = String(process.env[key] || '').trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readEnvBoundedInt(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(process.env[key] || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBingDomain(raw: string): string {
  let host = raw.trim().replace(/^https?:\/\//i, '');
  host = host.split('/')[0]?.trim() || '';
  return host || 'cn.bing.com';
}

function readEnvJsonStringArray(key: string): string[] {
  const raw = String(process.env[key] || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeDomains(
      parsed.filter((entry): entry is string => typeof entry === 'string'),
    );
  } catch {
    return [];
  }
}

function readEnvBrowserSiteProfiles(key: string): BrowserFetchSiteProfile[] {
  const raw = String(process.env[key] || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
      .map((entry) => ({
        domains: normalizeDomains(
          Array.isArray(entry.domains)
            ? entry.domains.filter(
                (item): item is string => typeof item === 'string',
              )
            : [],
        ),
        pathPrefixes: Array.isArray(entry.pathPrefixes)
          ? Array.from(
              new Set(
                entry.pathPrefixes
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => item.trim())
                  .filter(Boolean),
              ),
            ).slice(0, 20)
          : [],
        forceProvider:
          entry.forceProvider === 'basic'
            ? ('basic' as const)
            : entry.forceProvider === 'browser_cli'
              ? ('browser_cli' as const)
              : undefined,
        waitSelector: String(entry.waitSelector || '').trim(),
        selectorTimeoutMs: Number.isFinite(Number(entry.selectorTimeoutMs))
          ? Math.max(
              100,
              Math.min(120000, Number.parseInt(String(entry.selectorTimeoutMs), 10)),
            )
          : undefined,
        postWaitMs: Number.isFinite(Number(entry.postWaitMs))
          ? Math.max(
              0,
              Math.min(30000, Number.parseInt(String(entry.postWaitMs), 10)),
            )
          : undefined,
        waitUntil:
          entry.waitUntil === 'load'
            ? ('load' as const)
            : entry.waitUntil === 'domcontentloaded'
              ? ('domcontentloaded' as const)
              : entry.waitUntil === 'networkidle'
                ? ('networkidle' as const)
                : undefined,
        viewport: String(entry.viewport || '').trim(),
        userAgent: String(entry.userAgent || '').trim(),
      }))
      .filter((entry) => entry.domains.length > 0);
  } catch {
    return [];
  }
}

export function getRuntimeConfig(): WebSearchRuntimeConfig {
  const provider = String(process.env.NANOCLAW_WEB_SEARCH_PROVIDER || '')
    .trim()
    .toLowerCase();
  const fetchProvider = String(process.env.NANOCLAW_WEB_FETCH_PROVIDER || '')
    .trim()
    .toLowerCase();

  return {
    enabled: readEnvBoolean('NANOCLAW_WEB_SEARCH_ENABLED', true),
    fetchEnabled: readEnvBoolean('NANOCLAW_WEB_FETCH_ENABLED', true),
    bingDomain: normalizeBingDomain(
      String(process.env.NANOCLAW_WEB_SEARCH_BING_DOMAIN ?? '').trim(),
    ),
    provider:
      provider === 'duckduckgo_html' ||
      provider === 'searxng' ||
      provider === 'tavily' ||
      provider === 'bing' ||
      provider === 'brave' ||
      provider === 'auto'
        ? (provider as WebSearchRuntimeConfig['provider'])
        : 'auto',
    maxResults: readEnvBoundedInt(
      'NANOCLAW_WEB_SEARCH_MAX_RESULTS',
      DEFAULT_MAX_RESULTS,
      1,
      10,
    ),
    fetchProvider:
      fetchProvider === 'basic' ||
      fetchProvider === 'browser_cli' ||
      fetchProvider === 'auto'
        ? (fetchProvider as WebSearchRuntimeConfig['fetchProvider'])
        : 'auto',
    fetchUseBuiltinSiteProfiles: readEnvBoolean(
      'NANOCLAW_WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
      false,
    ),
    maxChars: readEnvBoundedInt(
      'NANOCLAW_WEB_FETCH_MAX_CHARS',
      DEFAULT_MAX_FETCH_CHARS,
      500,
      50000,
    ),
    pageSize: readEnvBoundedInt(
      'NANOCLAW_WEB_FETCH_PAGE_SIZE',
      DEFAULT_PAGE_SIZE,
      1000,
      20000,
    ),
    fetchBrowserCommand: String(
      process.env.NANOCLAW_WEB_FETCH_BROWSER_COMMAND || '',
    ).trim(),
    fetchBrowserSiteProfiles: readEnvBrowserSiteProfiles(
      'NANOCLAW_WEB_FETCH_BROWSER_SITE_PROFILES',
    ),
    allowedDomains: readEnvJsonStringArray('NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS'),
    searxngBaseUrl: String(
      process.env.NANOCLAW_WEB_SEARCH_SEARXNG_BASE_URL || '',
    )
      .trim()
      .replace(/\/+$/, ''),
    tavilyApiKey: String(
      process.env.NANOCLAW_WEB_SEARCH_TAVILY_API_KEY || '',
    ).trim(),
    engines: parseEnginesList(
      String(process.env.NANOCLAW_WEB_SEARCH_ENGINES || '').trim(),
    ),
  };
}

const VALID_ENGINE_NAMES = new Set<SearchEngineName>([
  'baidu', 'bing', 'brave', 'duckduckgo', 'startpage', 'searxng', 'tavily',
]);

function parseEnginesList(raw: string): SearchEngineName[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SearchEngineName => VALID_ENGINE_NAMES.has(s as SearchEngineName));
}

export function ensureWebSearchEnabled(config: WebSearchRuntimeConfig): void {
  if (!config.enabled) {
    throw new Error('Default web search is disabled by configuration');
  }
}

export function ensureWebFetchEnabled(config: WebSearchRuntimeConfig): void {
  if (!config.fetchEnabled) {
    throw new Error('URL fetch is disabled by configuration');
  }
}

function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '0.0.0.0' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '169.254.169.254'
  ) {
    return true;
  }
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
  if (/^169\.254\./.test(normalized)) return true;
  return false;
}

export function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function assertUrlAllowed(
  inputUrl: string,
  allowedDomains: string[],
  mode: 'fetch' | 'search',
): URL {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid URL: ${inputUrl}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (isLoopbackOrPrivateHostname(hostname)) {
    throw new Error(`Blocked ${mode} target: private or loopback host ${hostname}`);
  }

  if (
    allowedDomains.length > 0 &&
    !allowedDomains.some((domain) => domainMatches(hostname, domain))
  ) {
    throw new Error(`URL host ${hostname} is not in the allowed domain list`);
  }

  return parsed;
}

export function mergeRequestedDomains(
  configDomains: string[],
  requestedDomains: string[] | undefined,
): string[] {
  const requested = normalizeDomains(requestedDomains);
  if (configDomains.length === 0) return requested;
  if (requested.length === 0) return configDomains;
  return requested.filter((domain) =>
    configDomains.some((allowed) => domainMatches(domain, allowed)),
  );
}

export function buildSearchQuery(query: string, domains: string[]): string {
  let output = query.trim();

  const inlineSiteRe = /\bsite:(\S+)/gi;
  output = output.replace(inlineSiteRe, '').replace(/\s{2,}/g, ' ').trim();

  const normalized = [...new Set(domains.map((d) => d.toLowerCase()))];
  for (const domain of normalized) {
    output += ` site:${domain}`;
  }
  return output.trim();
}
