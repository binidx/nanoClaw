import { URL } from 'url';

import { load } from 'cheerio';

import { buildCodexRequestHeaders } from '../codex-request-headers.js';
import { SEARCH_ENDPOINT, USER_AGENT, fetchHtml, BROWSER_HEADERS } from './http.js';
import {
  DEFAULT_TIMEOUT_MS,
  assertUrlAllowed,
  buildSearchQuery,
  containsCJK,
  ensureWebSearchEnabled,
  getRuntimeConfig,
  mergeRequestedDomains,
  normalizeWhitespace,
  urlMatchesDomains,
  type SearchEngine,
  type SearchEngineName,
  type SearchResult,
  type SearchWebOptions,
  type WebSearchRuntimeConfig,
} from './shared.js';
import { decodeDuckDuckGoUrl } from './text.js';
import { searchBing } from './engines/bing.js';
import { searchBrave } from './engines/brave.js';
import { searchBaidu } from './engines/baidu.js';
import { searchStartpage } from './engines/startpage.js';

/* ------------------------------------------------------------------ */
/*  DDG parsing helpers (kept from original)                          */
/* ------------------------------------------------------------------ */

async function ddgPreloadSearch(query: string, maxResults: number, timeoutMs: number): Promise<SearchResult[]> {
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=h_&ia=web`;
  const page = await fetchHtml(searchUrl, {
    timeoutMs,
    headers: {
      ...BROWSER_HEADERS,
      'Referer': 'https://duckduckgo.com/',
    },
  });

  const $ = load(page.body);
  let preloadUrl = '';

  $('link[rel="preload"]').each((_i, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('links.duckduckgo.com/d.js')) {
      preloadUrl = href;
      return false;
    }
  });
  if (!preloadUrl) {
    $('#deep_preload_script').each((_i, el) => {
      const src = $(el).attr('src');
      if (src && src.includes('links.duckduckgo.com/d.js')) {
        preloadUrl = src;
        return false;
      }
    });
  }
  if (!preloadUrl) {
    const m = page.body.match(/https:\/\/links\.duckduckgo\.com\/d\.js\?[^"']+/i);
    if (m) preloadUrl = m[0];
  }

  if (!preloadUrl) return [];

  const dataResp = await fetchHtml(preloadUrl, {
    timeoutMs,
    headers: {
      ...BROWSER_HEADERS,
      'Accept': '*/*',
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'script',
      'Referer': 'https://duckduckgo.com/',
    },
  });

  const jsonpMatch = dataResp.body.match(/DDG\.pageLayout\.load\('d',\s*(\[.*?\])\s*\);/s);
  if (!jsonpMatch?.[1]) return [];

  const items = JSON.parse(jsonpMatch[1]) as Array<{
    n?: unknown; t?: string; u?: string; a?: string;
  }>;

  const results: SearchResult[] = [];
  for (const item of items) {
    if (item.n || results.length >= maxResults) continue;
    const url = String(item.u || '').trim();
    const title = String(item.t || '').trim();
    if (!url || !title) continue;
    results.push({ title, url, snippet: String(item.a || '').trim() });
  }
  return results;
}

function parseDuckDuckGoHtmlWithCheerio(html: string, maxResults: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $('div.result').each((_i, el) => {
    if (results.length >= maxResults) return false;
    const node = $(el);
    if (node.hasClass('result--ad')) return;

    const titleEl = node.find('a.result__a');
    const rawUrl = titleEl.attr('href') || '';
    const url = decodeDuckDuckGoUrl(rawUrl);
    const title = titleEl.text().trim();
    const snippet = node.find('.result__snippet').text().trim();

    if (title && url && !seen.has(url)) {
      seen.add(url);
      results.push({ title, url, snippet });
    }
  });
  return results;
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const cheerioResults = parseDuckDuckGoHtmlWithCheerio(html, maxResults);
  if (cheerioResults.length > 0) return cheerioResults;

  const results: SearchResult[] = [];
  const anchorPattern =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const url = decodeDuckDuckGoUrl(match[1] || '');
    const title = normalizeWhitespace((match[2] || '').replace(/<[^>]+>/g, ' '));
    if (!url || !title) continue;

    const nearbyHtml = html.slice(match.index, match.index + 1600);
    const snippetMatch =
      nearbyHtml.match(
        /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
      ) ||
      nearbyHtml.match(
        /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      );
    const snippet = normalizeWhitespace(
      (snippetMatch?.[1] || '').replace(/<[^>]+>/g, ' '),
    );

    if (!results.some((entry) => entry.url === url)) {
      results.push({ title, url, snippet });
    }
    if (results.length >= maxResults) break;
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                */
/* ------------------------------------------------------------------ */

function displayHostnameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function humanizeEngineNames(names: string[]): string {
  if (names.length === 0) return 'web search';
  const labels: Record<string, string> = {
    baidu: 'Baidu', bing: 'Bing', brave: 'Brave',
    duckduckgo: 'DuckDuckGo', startpage: 'Startpage',
    searxng: 'SearXNG', tavily: 'Tavily',
    codex_web_search: 'Codex web search',
  };
  return names.map((n) => labels[n] || n).join(' + ');
}

function formatSearchResults(
  providerLabel: string,
  searchQuery: string,
  results: SearchResult[],
  note?: string,
): string {
  if (results.length === 0) {
    return `No results found for "${searchQuery}".`;
  }

  const blocks = results.map((result, index) => {
    const domain = displayHostnameFromUrl(result.url);
    const titleLink = `[${result.title}](${result.url})`;
    const snippetLine = result.snippet ? `\n   > ${result.snippet}` : '';
    const domainLine = domain ? `\n   _${domain}_` : '';
    return `${index + 1}. **${titleLink}**${snippetLine}${domainLine}`;
  });

  const footer = [
    `${results.length} result${results.length === 1 ? '' : 's'} via ${providerLabel} | Use fetch_url to read full articles`,
  ];
  if (note) footer.push(`_Note: ${note}_`);

  return [
    `## Web Search: "${searchQuery}"`,
    '',
    ...blocks,
    '',
    '---',
    ...footer,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/*  Engine registry — wraps each source into SearchEngine interface   */
/* ------------------------------------------------------------------ */

const baiduEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, _config) {
    return searchBaidu(query, maxResults, timeoutMs);
  },
};

const bingEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, config) {
    return searchBing(config.bingDomain, query, maxResults, timeoutMs);
  },
};

const braveEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, _config) {
    return searchBrave(query, maxResults, timeoutMs);
  },
};

const duckduckgoEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, _config) {
    try {
      const preload = await ddgPreloadSearch(query, maxResults, timeoutMs);
      if (preload.length > 0) return preload;
    } catch { /* fall through */ }

    const resp = await fetchHtml(SEARCH_ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://html.duckduckgo.com/',
      },
      timeoutMs,
    });
    return parseDuckDuckGoResults(resp.body, maxResults);
  },
};

const startpageEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, _config) {
    return searchStartpage(query, maxResults, timeoutMs);
  },
};

const searxngEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, config) {
    if (!config.searxngBaseUrl) throw new Error('SearXNG base URL is not configured');

    const url = new URL(`${config.searxngBaseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const resp = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}`);

    const payload = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (payload.results || [])
      .map((item) => ({
        title: normalizeWhitespace(String(item.title || '')),
        url: String(item.url || ''),
        snippet: normalizeWhitespace(String(item.content || '')),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, maxResults);
  },
};

const tavilyEngine: SearchEngine = {
  async search(query, maxResults, timeoutMs, config) {
    if (!config.tavilyApiKey) throw new Error('Tavily API key is not configured');

    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        max_results: maxResults,
        search_depth: 'advanced',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);

    const payload = (await resp.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (payload.results || [])
      .map((item) => ({
        title: normalizeWhitespace(String(item.title || '')),
        url: String(item.url || ''),
        snippet: normalizeWhitespace(String(item.content || '')),
      }))
      .filter((item) => item.title && item.url)
      .slice(0, maxResults);
  },
};

const ENGINE_REGISTRY: Record<SearchEngineName, SearchEngine> = {
  baidu: baiduEngine,
  bing: bingEngine,
  brave: braveEngine,
  duckduckgo: duckduckgoEngine,
  startpage: startpageEngine,
  searxng: searxngEngine,
  tavily: tavilyEngine,
};

/* ------------------------------------------------------------------ */
/*  Parallel search orchestrator                                      */
/* ------------------------------------------------------------------ */

function selectDefaultEngines(
  query: string,
  config: WebSearchRuntimeConfig,
): SearchEngineName[] {
  if (config.engines.length > 0) return config.engines;
  if (containsCJK(query)) return ['baidu', 'bing'];
  return ['bing', 'brave'];
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeResults(
  results: SearchResult[],
  allowedDomains: string[],
): SearchResult[] {
  return results.filter((r) => {
    try {
      assertUrlAllowed(r.url, allowedDomains, 'search');
      return true;
    } catch {
      return false;
    }
  });
}

interface ParallelSearchOutcome {
  results: SearchResult[];
  engineNames: string[];
  errors: string[];
}

async function parallelSearch(
  engineNames: SearchEngineName[],
  query: string,
  maxResults: number,
  timeoutMs: number,
  config: WebSearchRuntimeConfig,
): Promise<ParallelSearchOutcome> {
  const tasks = engineNames.map((name) => {
    const engine = ENGINE_REGISTRY[name];
    return engine
      .search(query, maxResults, timeoutMs, config)
      .then((results) => ({ name, results, error: undefined as string | undefined }))
      .catch((err) => ({
        name,
        results: [] as SearchResult[],
        error: err instanceof Error ? err.message : String(err),
      }));
  });

  const settled = await Promise.all(tasks);

  let merged: SearchResult[] = [];
  const succeededEngines: string[] = [];
  const errors: string[] = [];

  for (const outcome of settled) {
    if (outcome.error) {
      errors.push(`${outcome.name}: ${outcome.error}`);
    } else if (outcome.results.length > 0) {
      succeededEngines.push(outcome.name);
      merged.push(...outcome.results);
    }
  }

  merged = dedupeResults(merged);
  return { results: merged, engineNames: succeededEngines, errors };
}

/* ------------------------------------------------------------------ */
/*  Codex web search fallback (kept from original)                    */
/* ------------------------------------------------------------------ */

function normalizeCodexApiBase(baseUrl: string): string {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('CODEX_BASE_URL is required for Codex web search fallback');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

async function readFirstCodexResponseText(
  resp: Response,
): Promise<{ text: string; model?: string }> {
  if (!resp.body) {
    throw new Error('Codex Responses API returned no stream body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputText = '';
  let resolvedModel: string | undefined;

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') return false;

    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      item?: {
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      response?: { error?: { message?: string } };
    };

    if (event.type === 'response.failed') {
      throw new Error(
        event.response?.error?.message || 'Codex response.failed',
      );
    }

    if (event.type === 'response.output_text.delta' && event.delta) {
      outputText += event.delta;
      return false;
    }

    if (
      event.type === 'response.output_item.done' &&
      event.item?.type === 'message'
    ) {
      const text = (event.item.content || [])
        .filter(
          (entry) =>
            entry.type === 'output_text' && typeof entry.text === 'string',
        )
        .map((entry) => entry.text || '')
        .join('');
      if (text && !outputText) outputText = text;
    }

    return event.type === 'response.completed';
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      buffer = buffer.slice(boundary + separatorLength);
      if (processBlock(rawEvent)) {
        resolvedModel = resp.headers.get('openai-model') || undefined;
        return { text: outputText.trim(), model: resolvedModel };
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  resolvedModel = resp.headers.get('openai-model') || undefined;
  return { text: outputText.trim(), model: resolvedModel };
}

function extractJsonObject<T>(text: string): T | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const parseCandidate = (candidate: string): T | null => {
    try { return JSON.parse(candidate) as T; }
    catch { return null; }
  };

  const direct = parseCandidate(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = parseCandidate(fenced[1].trim());
    if (parsed) return parsed;
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return parseCandidate(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function canUseCodexWebSearchFallback(): boolean {
  return Boolean(
    String(process.env.CODEX_BASE_URL || '').trim() &&
      String(process.env.CODEX_API_KEY || '').trim(),
  );
}

async function searchWithCodexWebSearch(
  query: string,
  domains: string[],
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const apiBase = normalizeCodexApiBase(process.env.CODEX_BASE_URL || '');
  const apiKey = String(process.env.CODEX_API_KEY || '').trim();
  const model = String(process.env.CODEX_MODEL || '').trim() || 'gpt-5.4';

  const searchQuery = buildSearchQuery(query, domains);
  const tool =
    domains.length > 0
      ? { type: 'web_search' as const, external_web_access: true, filters: { allowed_domains: domains } }
      : { type: 'web_search' as const, external_web_access: true };

  const prompt = [
    'Use web search to find the most relevant recent results for the query below.',
    `Search query: ${searchQuery}`,
    `Max results: ${maxResults}`,
    domains.length > 0 ? `Allowed domains: ${domains.join(', ')}` : '',
    'Return strict JSON only in this format:',
    '{"results":[{"title":"...","url":"https://...","snippet":"..."}]}',
    'Return concise snippets.',
    'Prefer exact matches for the requested date/topic.',
    'If exact matches are unavailable, return the closest authoritative recent matches instead of an empty list.',
  ].filter(Boolean).join('\n');

  let resp = await fetch(`${apiBase}/responses`, {
    method: 'POST',
    headers: buildCodexRequestHeaders(apiKey),
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      tools: [tool],
      store: false, stream: true, max_output_tokens: 900,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (resp.status === 400) {
    resp = await fetch(`${apiBase}/responses`, {
      method: 'POST',
      headers: buildCodexRequestHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        store: false, stream: true, max_output_tokens: 900,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  if (!resp.ok) {
    throw new Error(`Codex web search HTTP ${resp.status}: ${await resp.text()}`);
  }

  const resolved = await readFirstCodexResponseText(resp);
  const payload = extractJsonObject<{
    results?: Array<{ title?: string; url?: string; snippet?: string }>;
  }>(resolved.text);

  if (!payload) throw new Error('Codex web search returned non-JSON output');

  return (payload.results || [])
    .map((entry) => ({
      title: normalizeWhitespace(String(entry.title || '')),
      url: String(entry.url || '').trim(),
      snippet: normalizeWhitespace(String(entry.snippet || '')),
    }))
    .filter((entry) => entry.title && entry.url)
    .slice(0, maxResults);
}

/* ------------------------------------------------------------------ */
/*  Legacy provider bridge (for explicit provider= override)          */
/* ------------------------------------------------------------------ */

type ConcreteSearchProvider =
  Exclude<WebSearchRuntimeConfig['provider'], 'auto'> | 'codex_web_search';

function formatSearchError(
  providerName: ConcreteSearchProvider,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && 'cause' in error && error.cause
      ? error.cause instanceof Error
        ? error.cause.message
        : String(error.cause)
      : '';
  return new Error(
    `${providerName} search failed: ${
      cause && !message.includes(cause) ? `${message}: ${cause}` : message
    }`,
  );
}

const LEGACY_ENGINE_MAP: Record<Exclude<WebSearchRuntimeConfig['provider'], 'auto'>, SearchEngineName> = {
  duckduckgo_html: 'duckduckgo',
  searxng: 'searxng',
  tavily: 'tavily',
  bing: 'bing',
  brave: 'brave',
};

async function runLegacySingleProvider(
  providerName: Exclude<WebSearchRuntimeConfig['provider'], 'auto'>,
  config: WebSearchRuntimeConfig,
  options: SearchWebOptions,
): Promise<string> {
  const engineName = LEGACY_ENGINE_MAP[providerName];
  const engine = ENGINE_REGISTRY[engineName];
  const domains = mergeRequestedDomains(config.allowedDomains, options.domains);
  const maxResults = Math.max(1, Math.min(10, Number(options.maxResults) || config.maxResults));
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const searchQuery = buildSearchQuery(String(options.query || '').trim(), domains);

  const results = (await engine.search(searchQuery, maxResults, timeoutMs, config))
    .filter((r) => {
      try { assertUrlAllowed(r.url, domains, 'search'); return true; }
      catch { return false; }
    });

  return formatSearchResults(humanizeEngineNames([engineName]), searchQuery, results);
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                  */
/* ------------------------------------------------------------------ */

export async function searchWeb(options: SearchWebOptions): Promise<string> {
  const config = getRuntimeConfig();
  ensureWebSearchEnabled(config);

  const query = String(options.query || '').trim();
  if (!query) throw new Error('query is required');

  if (config.provider !== 'auto') {
    try {
      return await runLegacySingleProvider(config.provider, config, options);
    } catch (error) {
      throw formatSearchError(config.provider, error);
    }
  }

  const domains = mergeRequestedDomains(config.allowedDomains, options.domains);
  const maxResults = Math.max(1, Math.min(10, Number(options.maxResults) || config.maxResults));
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));

  const primaryEngines = selectDefaultEngines(query, config);

  if (domains.length > 0) {
    return await searchWithDomainFallback(
      primaryEngines, query, domains, maxResults, timeoutMs, config,
    );
  }

  const outcome = await parallelSearch(primaryEngines, query, maxResults, timeoutMs, config);
  const sanitized = sanitizeResults(outcome.results, config.allowedDomains).slice(0, maxResults);
  if (sanitized.length > 0) {
    return formatSearchResults(
      humanizeEngineNames(outcome.engineNames), query, sanitized,
    );
  }

  const fallbackResult = await tryFallbackEngines(
    primaryEngines, query, domains, maxResults, timeoutMs, config,
  );
  if (fallbackResult) return fallbackResult;

  const errorDetail = outcome.errors.length > 0
    ? outcome.errors.join('; ')
    : 'all engines returned empty results';
  throw new Error(`Search failed: ${errorDetail}`);
}

/* ------------------------------------------------------------------ */
/*  Domain fallback: site: → post-filter → unfiltered                 */
/* ------------------------------------------------------------------ */

async function searchWithDomainFallback(
  engineNames: SearchEngineName[],
  query: string,
  domains: string[],
  maxResults: number,
  timeoutMs: number,
  config: WebSearchRuntimeConfig,
): Promise<string> {
  const siteQuery = buildSearchQuery(query, domains);

  const phase1 = await parallelSearch(engineNames, siteQuery, maxResults, timeoutMs, config);
  const phase1Safe = sanitizeResults(phase1.results, config.allowedDomains);
  const phase1Filtered = phase1Safe.filter((r) => urlMatchesDomains(r.url, domains));
  if (phase1Filtered.length > 0) {
    return formatSearchResults(
      humanizeEngineNames(phase1.engineNames),
      siteQuery,
      phase1Filtered.slice(0, maxResults),
    );
  }

  const phase2 = await parallelSearch(engineNames, query, maxResults * 3, timeoutMs, config);
  const phase2Safe = sanitizeResults(phase2.results, config.allowedDomains);
  const phase2Filtered = phase2Safe.filter((r) => urlMatchesDomains(r.url, domains));
  if (phase2Filtered.length > 0) {
    return formatSearchResults(
      humanizeEngineNames(phase2.engineNames),
      query,
      phase2Filtered.slice(0, maxResults),
      `results filtered to ${domains.join(', ')}`,
    );
  }

  if (phase2Safe.length > 0) {
    return formatSearchResults(
      humanizeEngineNames(phase2.engineNames),
      query,
      phase2Safe.slice(0, maxResults),
      `no results found on ${domains.join(', ')} — showing general results`,
    );
  }

  const fallback = await tryFallbackEngines(
    engineNames, query, domains, maxResults, timeoutMs, config,
  );
  if (fallback) return fallback;

  return formatSearchResults('web search', siteQuery, []);
}

/* ------------------------------------------------------------------ */
/*  Fallback: try remaining engines + codex                           */
/* ------------------------------------------------------------------ */

const FALLBACK_ENGINES: SearchEngineName[] = ['duckduckgo', 'startpage'];

async function tryFallbackEngines(
  alreadyTried: SearchEngineName[],
  query: string,
  domains: string[],
  maxResults: number,
  timeoutMs: number,
  config: WebSearchRuntimeConfig,
): Promise<string | null> {
  const remaining = FALLBACK_ENGINES.filter((e) => !alreadyTried.includes(e));

  if (remaining.length > 0) {
    const fallback = await parallelSearch(remaining, query, maxResults, timeoutMs, config);
    const safe = sanitizeResults(fallback.results, config.allowedDomains);
    const filtered = domains.length > 0
      ? safe.filter((r) => urlMatchesDomains(r.url, domains))
      : safe;
    if (filtered.length > 0) {
      return formatSearchResults(
        humanizeEngineNames(fallback.engineNames), query, filtered.slice(0, maxResults),
      );
    }
    if (domains.length > 0 && safe.length > 0) {
      return formatSearchResults(
        humanizeEngineNames(fallback.engineNames), query, safe.slice(0, maxResults),
        `no results found on ${domains.join(', ')} — showing general results`,
      );
    }
  }

  if (canUseCodexWebSearchFallback()) {
    try {
      const codexRaw = await searchWithCodexWebSearch(query, domains, maxResults, timeoutMs);
      const codexSafe = sanitizeResults(codexRaw, config.allowedDomains);
      const codexFiltered = domains.length > 0
        ? codexSafe.filter((r) => urlMatchesDomains(r.url, domains))
        : codexSafe;
      if (codexFiltered.length > 0) {
        return formatSearchResults('Codex web search', query, codexFiltered);
      }
      if (domains.length > 0 && codexSafe.length > 0) {
        return formatSearchResults(
          'Codex web search', query, codexSafe.slice(0, maxResults),
          `no results found on ${domains.join(', ')} — showing general results`,
        );
      }
    } catch { /* codex failed too */ }
  }

  return null;
}
