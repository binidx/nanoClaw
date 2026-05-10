import { load } from 'cheerio';

import { fetchWithRetry, BROWSER_HEADERS } from '../http.js';
import { normalizeWhitespace, type SearchResult } from '../shared.js';

export async function searchBaidu(
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];
  let pn = 0;
  const maxPages = Math.min(3, Math.ceil(maxResults / 10));

  for (let page = 0; page < maxPages && allResults.length < maxResults; page++) {
    const searchUrl =
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}` +
      `&pn=${pn}&ie=utf-8`;

    const response = await fetchWithRetry(searchUrl, {
      timeoutMs,
      headers: {
        ...BROWSER_HEADERS,
        'Referer': 'https://www.baidu.com/',
      },
      maxRetries: 1,
    });

    const results = parseBaiduResults(response.body, maxResults - allResults.length);
    if (results.length === 0) break;
    allResults.push(...results);
    pn += 10;
  }

  return allResults.slice(0, maxResults);
}

function parseBaiduResults(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  $('#content_left').children().each((_i, element) => {
    if (results.length >= limit) return false;

    const el = $(element);
    const titleEl = el.find('h3').first();
    const linkEl = titleEl.find('a').first();

    if (!titleEl.length || !linkEl.length) return;

    const url = linkEl.attr('href');
    if (!url || !url.startsWith('http')) return;
    if (seen.has(url)) return;

    const title = normalizeWhitespace(titleEl.text());
    if (!title) return;

    const snippetEl =
      el.find('.c-font-normal.c-color-text').first();
    const snippetAria = snippetEl.attr('aria-label') || '';
    const snippetText = snippetAria || el.find('.cos-row').first().text().trim();
    const snippet = normalizeWhitespace(snippetText);

    seen.add(url);
    results.push({
      title: title.slice(0, 200),
      url,
      snippet: snippet.slice(0, 400),
    });
  });

  return results;
}
