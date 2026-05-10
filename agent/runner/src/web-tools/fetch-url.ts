import { spawn } from 'child_process';
import { URL } from 'url';

import {
  BUILTIN_BROWSER_SITE_PROFILES,
  type BrowserFetchSiteProfile,
} from '../web-fetch-site-profiles.js';
import { BROWSER_USER_AGENT, BROWSER_HEADERS, fetchWithRetry } from './http.js';
import {
  DEFAULT_PAGE_HEADROOM,
  DEFAULT_TIMEOUT_MS,
  MIN_BROWSER_FALLBACK_TEXT_CHARS,
  assertUrlAllowed,
  getRuntimeConfig,
  ensureWebFetchEnabled,
  normalizeWhitespace,
  type ExtractedContent,
  type FetchUrlOptions,
  type FetchedResponse,
  type WebSearchRuntimeConfig,
} from './shared.js';
import { extractReadableContent, paginateText } from './text.js';

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findMatchingBrowserSiteProfile(
  profiles: BrowserFetchSiteProfile[],
  targetUrl: string,
): BrowserFetchSiteProfile | null {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  const pathname = parsed.pathname || '/';
  for (const profile of profiles) {
    const domainMatched = profile.domains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
    if (!domainMatched) continue;
    if (
      profile.pathPrefixes.length > 0 &&
      !profile.pathPrefixes.some((prefix) => pathname.startsWith(prefix))
    ) {
      continue;
    }
    return profile;
  }
  return null;
}

function getEffectiveBrowserSiteProfiles(
  config: WebSearchRuntimeConfig,
): BrowserFetchSiteProfile[] {
  return config.fetchUseBuiltinSiteProfiles
    ? [...config.fetchBrowserSiteProfiles, ...BUILTIN_BROWSER_SITE_PROFILES]
    : config.fetchBrowserSiteProfiles;
}

function substituteTemplateValue(
  template: string,
  values: { url: string; timeoutMs: number },
): string {
  return template
    .replace(/\{url\}/g, values.url)
    .replace(/\{timeout_ms\}/g, String(values.timeoutMs));
}

function substituteShellTemplate(
  template: string,
  values: { url: string; timeoutMs: number },
): string {
  if (process.platform === 'win32') {
    return template
      .replace(/\{url\}/g, `"${values.url.replace(/"/g, '""')}"`)
      .replace(/\{timeout_ms\}/g, String(values.timeoutMs));
  }

  return template
    .replace(/\{url\}/g, shellEscape(values.url))
    .replace(/\{timeout_ms\}/g, String(values.timeoutMs));
}

function parseFetchCommandOutput(
  stdout: string,
  requestUrl: string,
): FetchedResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('Browser CLI fetch returned empty output');
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      body?: unknown;
      contentType?: unknown;
      finalUrl?: unknown;
    };
    if (parsed && typeof parsed.body === 'string') {
      return {
        body: parsed.body,
        contentType: String(parsed.contentType || 'text/html; charset=utf-8'),
        finalUrl: String(parsed.finalUrl || requestUrl),
      };
    }
  } catch {
    // Fall through to raw body mode.
  }

  return {
    body: stdout,
    contentType: 'text/html; charset=utf-8',
    finalUrl: requestUrl,
  };
}

async function fetchViaBrowserCommand(
  commandTemplate: string,
  requestUrl: string,
  timeoutMs: number,
  profile: BrowserFetchSiteProfile | null,
): Promise<FetchedResponse> {
  const trimmed = commandTemplate.trim();
  if (!trimmed) {
    throw new Error('WEB_FETCH_BROWSER_COMMAND is not configured');
  }

  const values = { url: requestUrl, timeoutMs };
  let command = '';
  let args: string[] = [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        'WEB_FETCH_BROWSER_COMMAND JSON array template is not valid JSON',
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === 'string')
    ) {
      throw new Error(
        'WEB_FETCH_BROWSER_COMMAND JSON array template must be a non-empty string array',
      );
    }
    command = substituteTemplateValue(parsed[0], values);
    args = parsed.slice(1).map((entry) => substituteTemplateValue(entry, values));
  } else if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', substituteShellTemplate(trimmed, values)];
  } else {
    command = '/bin/sh';
    args = ['-lc', substituteShellTemplate(trimmed, values)];
  }

  return new Promise<FetchedResponse>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NANOCLAW_FETCH_URL: requestUrl,
        NANOCLAW_FETCH_TIMEOUT_MS: String(timeoutMs),
        ...(profile?.waitSelector
          ? { RENDER_FETCH_WAIT_SELECTOR: profile.waitSelector }
          : {}),
        ...(profile?.selectorTimeoutMs !== undefined
          ? {
              RENDER_FETCH_SELECTOR_TIMEOUT_MS: String(
                profile.selectorTimeoutMs,
              ),
            }
          : {}),
        ...(profile?.postWaitMs !== undefined
          ? { RENDER_FETCH_POST_WAIT_MS: String(profile.postWaitMs) }
          : {}),
        ...(profile?.waitUntil
          ? { RENDER_FETCH_WAIT_UNTIL: profile.waitUntil }
          : {}),
        ...(profile?.viewport
          ? { RENDER_FETCH_VIEWPORT: profile.viewport }
          : {}),
        ...(profile?.userAgent
          ? { RENDER_FETCH_USER_AGENT: profile.userAgent }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(new Error(`Browser CLI fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        const errorText = normalizeWhitespace(stderr).slice(0, 500);
        reject(
          new Error(
            `Browser CLI fetch failed (${signal || code || 'unknown'}): ${
              errorText || 'no stderr output'
            }`,
          ),
        );
        return;
      }
      try {
        resolve(parseFetchCommandOutput(stdout, requestUrl));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function extractFetchedContent(response: FetchedResponse): ExtractedContent {
  const contentType = response.contentType.toLowerCase();
  if (!contentType.includes('html')) {
    return { title: '', text: normalizeWhitespace(response.body) };
  }
  const extracted = extractReadableContent(response.body);
  const markdown = extracted.markdown?.trim();
  const text = markdown || extracted.text;
  return {
    title: extracted.title,
    text,
    ...(extracted.markdown ? { markdown: extracted.markdown } : {}),
  };
}

function looksLikeClientRenderedHtml(html: string): boolean {
  return (
    /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']/i.test(html) ||
    /__NEXT_DATA__|data-reactroot|id="gatsby-focus-wrapper"|ng-version=/i.test(
      html,
    ) ||
    /<script\b[^>]*type=["']module["']/i.test(html)
  );
}

function shouldTryBrowserFallback(
  config: WebSearchRuntimeConfig,
  response: FetchedResponse,
  extracted: ExtractedContent,
): boolean {
  if (!config.fetchBrowserCommand) return false;
  if (!response.contentType.toLowerCase().includes('html')) return false;

  const textLength = extracted.text.trim().length;
  return (
    textLength === 0 ||
    (textLength < MIN_BROWSER_FALLBACK_TEXT_CHARS &&
      looksLikeClientRenderedHtml(response.body))
  );
}

const MAX_FETCH_BODY_BYTES = 5_000_000;

function describeBlockedFetchContentType(contentType: string): string | null {
  const ct = contentType.trim().toLowerCase();
  if (ct.startsWith('image/')) return 'an image';
  if (ct.startsWith('video/')) return 'a video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('application/octet-stream')) return 'a binary blob';
  if (ct.startsWith('application/pdf')) return 'a PDF document';
  return null;
}

async function fetchTextWithBodyGuards(
  url: string,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const headResp = await fetch(url, {
    method: 'HEAD',
    headers: { 'User-Agent': BROWSER_USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
  }).catch(() => null);

  if (headResp) {
    const ct = headResp.headers.get('content-type') || '';
    const blocked = describeBlockedFetchContentType(ct);
    if (blocked) {
      throw new Error(
        `Refused to fetch URL: response is ${blocked} (${ct.trim() || 'unknown MIME type'}). Use an HTML or plain-text page instead.`,
      );
    }
    const cl = headResp.headers.get('content-length');
    if (cl) {
      const bytes = Number.parseInt(cl, 10);
      if (Number.isFinite(bytes) && bytes > MAX_FETCH_BODY_BYTES) {
        throw new Error(
          `Refused to fetch URL: Content-Length ${bytes} bytes exceeds 5MB limit`,
        );
      }
    }
  }

  const response = await fetchWithRetry(url, {
    timeoutMs,
    headers: {
      ...BROWSER_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    maxRetries: 2,
  });

  const contentTypeFull = response.contentType;
  const blocked = describeBlockedFetchContentType(contentTypeFull);
  if (blocked) {
    throw new Error(
      `Refused to fetch URL: response is ${blocked} (${contentTypeFull.trim() || 'unknown MIME type'}). Use an HTML or plain-text page instead.`,
    );
  }

  return response;
}

async function resolveFetchResponse(
  config: WebSearchRuntimeConfig,
  requestUrl: string,
  timeoutMs: number,
): Promise<{
  providerName: WebSearchRuntimeConfig['fetchProvider'];
  response: FetchedResponse;
  extracted: ExtractedContent;
  matchedProfile: BrowserFetchSiteProfile | null;
}> {
  const matchedProfile = findMatchingBrowserSiteProfile(
    getEffectiveBrowserSiteProfiles(config),
    requestUrl,
  );
  const effectiveFetchProvider =
    matchedProfile?.forceProvider || config.fetchProvider;

  if (effectiveFetchProvider === 'browser_cli') {
    const response = await fetchViaBrowserCommand(
      config.fetchBrowserCommand,
      requestUrl,
      timeoutMs,
      matchedProfile,
    );
    if (response.body.length > MAX_FETCH_BODY_BYTES) {
      throw new Error(
        `Refused to process browser_cli output: ${response.body.length} bytes exceeds 5MB limit`,
      );
    }
    return {
      providerName: 'browser_cli',
      extracted: extractFetchedContent(response),
      response,
      matchedProfile,
    };
  }

  const basicResponse = await fetchTextWithBodyGuards(requestUrl, timeoutMs);
  const basicExtracted = extractFetchedContent(basicResponse);
  if (
    effectiveFetchProvider !== 'auto' ||
    !shouldTryBrowserFallback(config, basicResponse, basicExtracted)
  ) {
    return {
      providerName: 'basic',
      extracted: basicExtracted,
      response: basicResponse,
      matchedProfile,
    };
  }

  try {
    const browserResponse = await fetchViaBrowserCommand(
      config.fetchBrowserCommand,
      requestUrl,
      timeoutMs,
      matchedProfile,
    );
    const browserExtracted = extractFetchedContent(browserResponse);
    if (
      browserExtracted.text.trim().length > basicExtracted.text.trim().length
    ) {
      return {
        providerName: 'browser_cli',
        extracted: browserExtracted,
        response: browserResponse,
        matchedProfile,
      };
    }
  } catch {
    // Keep the basic fetch result when browser_cli is unavailable or fails.
  }

  return {
    providerName: 'basic',
    extracted: basicExtracted,
    response: basicResponse,
    matchedProfile,
  };
}

export async function fetchUrl(options: FetchUrlOptions): Promise<string> {
  const config = getRuntimeConfig();
  ensureWebFetchEnabled(config);

  const timeoutMs = Math.max(
    1000,
    Math.min(30000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS),
  );
  const pageSize = Math.max(
    1000,
    Math.min(20000, Number(options.pageSize) || config.pageSize),
  );
  const requestedPage = Math.max(
    1,
    Number.parseInt(String(options.page || 1), 10) || 1,
  );
  const baseMaxChars = Math.max(
    500,
    Math.min(50000, Number(options.maxChars) || config.maxChars),
  );
  const inferredMaxChars =
    options.maxChars === undefined || options.maxChars === null
      ? requestedPage * pageSize + DEFAULT_PAGE_HEADROOM * pageSize
      : 0;
  const maxChars = Math.max(
    500,
    Math.min(50000, Math.max(baseMaxChars, inferredMaxChars)),
  );

  const parsedUrl = assertUrlAllowed(options.url, config.allowedDomains, 'fetch');
  const fetched = await resolveFetchResponse(
    config,
    parsedUrl.toString(),
    timeoutMs,
  );
  const response = fetched.response;
  assertUrlAllowed(response.finalUrl, config.allowedDomains, 'fetch');

  const extracted = fetched.extracted;
  const fullText = extracted.text.trim();
  const boundedText = fullText.slice(0, maxChars).trim();
  const wasTruncated = boundedText.length < fullText.length;
  const pages = paginateText(boundedText, pageSize);
  const currentPage = Math.min(requestedPage, pages.length);
  const pageText = pages[currentPage - 1] || '';
  const continuationHint =
    currentPage < pages.length
      ? `Next page: call fetch_url with page=${currentPage + 1}`
      : wasTruncated
        ? `Next page: increase max_chars above ${maxChars} and retry with page=${currentPage + 1}`
        : 'Next page: none';

  return [
    `URL: ${response.finalUrl}`,
    extracted.title ? `Title: ${extracted.title}` : '',
    `Fetch provider: ${fetched.providerName}`,
    fetched.matchedProfile
      ? `Fetch site profile: ${fetched.matchedProfile.domains.join(', ')}`
      : '',
    `Content-Type: ${response.contentType || 'unknown'}`,
    `Page: ${currentPage}/${pages.length}`,
    requestedPage > currentPage
      ? `Requested page: ${requestedPage} (out of range, returned last available page)`
      : '',
    `Extracted chars: ${fullText.length}`,
    `Returned chars: ${boundedText.length}`,
    wasTruncated
      ? `Truncated: yes (full extracted text exceeds ${maxChars} chars)`
      : 'Truncated: no',
    continuationHint,
    '',
    pageText || '(empty response body)',
  ]
    .filter(Boolean)
    .join('\n');
}
