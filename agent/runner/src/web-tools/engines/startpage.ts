import { load } from 'cheerio';

import { fetchWithRetry } from '../http.js';
import { normalizeWhitespace, type SearchResult } from '../shared.js';

const SP_BASE = 'https://www.startpage.com';
const SP_SEARCH = `${SP_BASE}/sp/search`;
const SC_TTL_MS = 25 * 60 * 1000;

const SP_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

let cachedSc: string | undefined;
let cachedScAt = 0;

async function ensureScToken(timeoutMs: number): Promise<string> {
  if (cachedSc && Date.now() - cachedScAt < SC_TTL_MS) return cachedSc;

  const resp = await fetchWithRetry(SP_BASE, {
    timeoutMs,
    headers: SP_HEADERS,
    maxRetries: 1,
  });

  const $ = load(resp.body);
  const sc = $('form[action="/sp/search"] input[name="sc"]')
    .first()
    .attr('value')
    ?.trim();

  if (!sc) throw new Error('Startpage: failed to extract sc token');

  cachedSc = sc;
  cachedScAt = Date.now();
  return sc;
}

function isCaptchaPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('/sp/captcha') ||
    lower.includes('verify you are human') ||
    lower.includes('human verification') ||
    lower.includes('security check')
  );
}

export async function searchStartpage(
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const sc = await ensureScToken(timeoutMs);

  const formBody = new URLSearchParams({
    query,
    cat: 'web',
    sc,
    language: 'english',
  }).toString();

  const resp = await fetchWithRetry(SP_SEARCH, {
    method: 'POST',
    body: formBody,
    timeoutMs,
    headers: {
      ...SP_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${SP_BASE}/`,
    },
    maxRetries: 1,
  });

  if (isCaptchaPage(resp.body)) {
    cachedSc = undefined;
    throw new Error('Startpage: captcha challenge detected');
  }

  const interstitialPayload = extractInterstitialPayload(resp.body);
  let html = resp.body;

  if (interstitialPayload) {
    const interResp = await fetchWithRetry(SP_SEARCH, {
      method: 'POST',
      body: new URLSearchParams(interstitialPayload).toString(),
      timeoutMs,
      headers: {
        ...SP_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': SP_SEARCH,
      },
      maxRetries: 0,
    });
    html = interResp.body;
  }

  return parseStartpageResults(html, maxResults);
}

function extractInterstitialPayload(
  html: string,
): Record<string, string> | undefined {
  const match = html.match(/var data = (\{[\s\S]*?\});/);
  if (!match?.[1]) return undefined;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      result[k] = String(v);
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function parseStartpageResults(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $('a.result-title.result-link').each((_i, el) => {
    if (results.length >= limit) return false;

    const anchor = $(el);
    const url = anchor.attr('href')?.trim();
    if (!url || !url.startsWith('http') || seen.has(url)) return;

    const title = normalizeWhitespace(anchor.text());
    if (!title) return;

    const snippet = normalizeWhitespace(
      anchor.closest('.w-gl__result, .result').find('p.description, .w-gl__description').text(),
    );

    seen.add(url);
    results.push({
      title: title.slice(0, 200),
      url,
      snippet: snippet.slice(0, 400),
    });
  });

  return results;
}
