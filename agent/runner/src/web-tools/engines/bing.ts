import { load } from 'cheerio';

import { fetchWithRetry, BROWSER_HEADERS } from '../http.js';
import type { SearchResult } from '../shared.js';

const RESULT_SELECTORS = [
  '#b_results > li.b_algo',
  '#b_results > li.b_ans',
  '#b_results > li:not(.b_ad):not(.b_pag):not(.b_msg)',
  '.b_algo',
];

function sanitizeBingUrl(rawUrl: string | undefined, bingOrigin: string): string {
  if (!rawUrl) return '';
  let resolved = rawUrl.trim();
  if (!resolved) return '';

  if (resolved.startsWith('//')) {
    resolved = `https:${resolved}`;
  } else if (resolved.startsWith('/')) {
    if (
      resolved.startsWith('/search') ||
      resolved.startsWith('/ck/a') ||
      resolved.startsWith('/newtabredir')
    ) {
      return '';
    }
    resolved = `${bingOrigin}${resolved}`;
  }

  if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
    return '';
  }

  try {
    const url = new URL(resolved);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (
      hostname.endsWith('bing.com') &&
      (pathname.startsWith('/search') ||
        pathname.startsWith('/ck/a') ||
        pathname.startsWith('/newtabredir'))
    ) {
      return '';
    }
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'ref']) {
      url.searchParams.delete(param);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function ws(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseBingResults(
  html: string,
  limit: number,
  bingOrigin: string,
): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const selector of RESULT_SELECTORS) {
    $(selector).each((_i, node) => {
      if (results.length >= limit) return false;

      const el = $(node);
      if (el.hasClass('b_ad') || el.closest('.b_ad').length > 0) return;

      const titleLink = el
        .find('h2 a, .b_title a, a.tilk, a[target="_blank"]')
        .first();
      const url = sanitizeBingUrl(titleLink.attr('href'), bingOrigin);
      if (!url || seen.has(url)) return;

      const title = ws(
        el.find('h2 a').first().text() ||
          el.find('.b_title a').first().text() ||
          el.find('a').first().text(),
      );
      const snippet = ws(
        el.find('.b_caption p').first().text() ||
          el.find('.b_caption').first().text() ||
          el.find('.b_snippet, .b_lineclamp2, .b_lineclamp3').first().text(),
      );

      if (!title) return;

      seen.add(url);
      results.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) });
    });

    if (results.length >= limit) break;
  }

  return results.slice(0, limit);
}

export async function searchBing(
  bingDomain: string,
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const host = bingDomain.trim().replace(/^https?:\/\//i, '').split('/')[0]?.trim();
  const safeHost = host || 'cn.bing.com';
  const bingOrigin = `https://${safeHost}`;
  const searchUrl = `${bingOrigin}/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults + 5, 30)}`;
  const response = await fetchWithRetry(searchUrl, {
    timeoutMs,
    headers: {
      ...BROWSER_HEADERS,
      'Referer': `${bingOrigin}/`,
    },
    maxRetries: 1,
  });
  return parseBingResults(response.body, maxResults, bingOrigin);
}
