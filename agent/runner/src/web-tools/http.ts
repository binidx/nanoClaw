import { type FetchedResponse } from './shared.js';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="133", "Google Chrome";v="133", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

export const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

/** @deprecated Use BROWSER_USER_AGENT instead */
export const USER_AGENT = BROWSER_USER_AGENT;

export async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<FetchedResponse> {
  const resp = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while requesting ${url}`);
  }
  return {
    body: await resp.text(),
    contentType: resp.headers.get('content-type') || '',
    finalUrl: resp.url || url,
  };
}

export interface FetchHtmlOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  referer?: string;
}

export async function fetchHtml(
  url: string,
  options: FetchHtmlOptions,
): Promise<FetchedResponse> {
  const headers: Record<string, string> = {
    ...BROWSER_HEADERS,
    ...options.headers,
  };
  if (options.referer) {
    headers['Referer'] = options.referer;
    headers['sec-fetch-site'] = 'same-origin';
  }

  const init: RequestInit = {
    method: options.method || 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs),
  };
  if (options.body) {
    init.body = options.body;
  }

  const resp = await fetch(url, init);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while requesting ${url}`);
  }
  return {
    body: await resp.text(),
    contentType: resp.headers.get('content-type') || '',
    finalUrl: resp.url || url,
  };
}

function extractHttpStatus(err: Error): number | null {
  const m = err.message.match(/HTTP (\d+)/);
  return m ? Number(m[1]) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  url: string,
  options: FetchHtmlOptions & { maxRetries?: number },
): Promise<FetchedResponse> {
  const maxRetries = options.maxRetries ?? 2;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchHtml(url, options);
    } catch (err) {
      lastError = err as Error;
      const status = extractHttpStatus(lastError);
      if (status && status < 500 && status !== 429) throw lastError;
      if (attempt < maxRetries) {
        await sleep(500 * Math.pow(2, attempt));
      }
    }
  }
  throw lastError!;
}
