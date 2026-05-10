import { load } from 'cheerio';

import { fetchWithRetry, BROWSER_HEADERS } from '../http.js';
import type { SearchResult } from '../shared.js';

const BRAVE_BASE_URL = 'https://search.brave.com/search';

function parseBraveResults(html: string, limit: number): SearchResult[] {
  const $ = load(html);
  const results: SearchResult[] = [];

  $('#results .snippet').each((_i, element) => {
    if (results.length >= limit) return false;

    const el = $(element);
    const content = el.find('.result-content').first();
    if (content.length === 0) return;

    const mainLink = content.find('> a').first();
    const url = mainLink.attr('href');
    const title = mainLink.find('.search-snippet-title').text().trim();
    const snippet = content.find('.generic-snippet').text().trim();

    if (title && url && url.startsWith('http')) {
      results.push({
        title: title.slice(0, 200),
        url,
        snippet: snippet.slice(0, 400),
      });
    }
  });

  return results.slice(0, limit);
}

export async function searchBrave(
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const searchUrl = `${BRAVE_BASE_URL}?q=${encodeURIComponent(query)}&source=web`;
  const response = await fetchWithRetry(searchUrl, {
    timeoutMs,
    headers: {
      ...BROWSER_HEADERS,
      'Referer': 'https://search.brave.com/',
    },
    maxRetries: 1,
  });
  return parseBraveResults(response.body, maxResults);
}
