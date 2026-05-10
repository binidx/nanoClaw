import { normalizeStockSymbol } from './stock-analysis-market-data.js';
import type {
  StockAnalysisMarket,
  StockAnalysisNewsReference,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

const DEFAULT_NEWS_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

interface FetchFallbackNewsSnippetsInput {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  lookbackDays: number;
  maxResults: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface FallbackNewsSourceResult {
  sourceLabel: string;
  snippets: StockAnalysisNewsReference[];
  rawSnippets: StockAnalysisNewsReference[];
}

const FALLBACK_SOURCE_QUERY_CONCURRENCY = 2;

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripHtml(value: string): string {
  return decodeXmlText(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractXmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1] ? decodeXmlText(match[1]) : null;
}

function toIsoDate(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isWithinLookback(value: string | null, lookbackDays: number): boolean {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const diffMs = Date.now() - date.getTime();
  return diffMs >= -24 * 60 * 60 * 1000 && diffMs <= lookbackDays * 24 * 60 * 60 * 1000;
}

function dedupeSnippets(
  snippets: StockAnalysisNewsReference[],
): StockAnalysisNewsReference[] {
  return Array.from(
    new Map(
      snippets.map((item) => [
        item.url || `${item.title}:${item.source}:${item.publishedAt || ''}`,
        item,
      ]),
    ).values(),
  );
}

function getSnippetKey(item: StockAnalysisNewsReference): string {
  return item.url || `${item.title}:${item.source}:${item.publishedAt || ''}`;
}

function appendUniqueSnippets(
  target: StockAnalysisNewsReference[],
  seen: Set<string>,
  items: StockAnalysisNewsReference[],
): number {
  let added = 0;
  for (const item of items) {
    const key = getSnippetKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    target.push(item);
    added += 1;
  }
  return added;
}

function normalizeSnippet(
  item: Partial<StockAnalysisNewsReference> | null | undefined,
): StockAnalysisNewsReference | null {
  if (!item?.title || !item?.source) {
    return null;
  }
  return {
    title: item.title.trim().slice(0, 120),
    source: item.source.trim().slice(0, 48),
    publishedAt: item.publishedAt || null,
    summary: (item.summary || '').trim().slice(0, 220),
    url: item.url || null,
  };
}

function buildBingNewsUrl(query: string, market: StockAnalysisMarket): string {
  const url = new URL('https://www.bing.com/news/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'RSS');
  if (market === 'us') {
    url.searchParams.set('setlang', 'en-US');
    url.searchParams.set('cc', 'US');
  } else {
    url.searchParams.set('setlang', 'zh-cn');
    url.searchParams.set('cc', 'CN');
  }
  return url.toString();
}

function buildYahooNewsUrl(query: string): string {
  const url = new URL('https://query1.finance.yahoo.com/v1/finance/search');
  url.searchParams.set('q', query);
  url.searchParams.set('quotesCount', '0');
  url.searchParams.set('newsCount', '8');
  url.searchParams.set('enableFuzzyQuery', 'false');
  url.searchParams.set('enableCb', 'true');
  url.searchParams.set('enableNavLinks', 'false');
  url.searchParams.set('recommendedCount', '0');
  return url.toString();
}

function buildFallbackQueries(
  stockCode: string,
  stockName: string,
  market: StockAnalysisMarket,
): string[] {
  if (market === 'us') {
    return [
      `${stockName} ${stockCode} stock latest news earnings`,
      `${stockName} ${stockCode} sector theme catalyst`,
    ];
  }
  return [
    `${stockName} ${stockCode} 最新消息 公告 业绩`,
    `${stockName} ${stockCode} 板块 题材 概念 异动`,
  ];
}

export function parseBingNewsRss(xml: string): StockAnalysisNewsReference[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  return items
    .map((block) => {
      const titleRaw = extractXmlTag(block, 'title') || '';
      const [title, maybeSource] = titleRaw.split(/\s+-\s+(?=[^-]+$)/);
      return normalizeSnippet({
        title: title || titleRaw,
        source: maybeSource || 'Bing News',
        publishedAt: toIsoDate(extractXmlTag(block, 'pubDate')),
        summary: stripHtml(extractXmlTag(block, 'description') || ''),
        url: extractXmlTag(block, 'link'),
      });
    })
    .filter((item): item is StockAnalysisNewsReference => Boolean(item));
}

type YahooSearchPayload = {
  news?: Array<{
    title?: string;
    publisher?: string;
    providerPublishTime?: number;
    link?: string;
    summary?: string;
  }>;
};

export function parseYahooFinanceNews(
  payload: YahooSearchPayload,
): StockAnalysisNewsReference[] {
  return (payload.news || [])
    .map((item) =>
      normalizeSnippet({
        title: item.title,
        source: item.publisher || 'Yahoo Finance',
        publishedAt: toIsoDate(item.providerPublishTime ? item.providerPublishTime * 1000 : null),
        summary: item.summary || '',
        url: item.link || null,
      }),
    )
    .filter((item): item is StockAnalysisNewsReference => Boolean(item));
}

async function fetchBingNewsSnippets(
  query: string,
  market: StockAnalysisMarket,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<StockAnalysisNewsReference[]> {
  const response = await fetchImpl(buildBingNewsUrl(query, market), {
    headers: {
      ...DEFAULT_NEWS_HEADERS,
      Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      Referer: 'https://www.bing.com/news',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Bing News RSS request failed: ${response.status}`);
  }
  return parseBingNewsRss(await response.text());
}

async function fetchYahooNewsSnippets(
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<StockAnalysisNewsReference[]> {
  const response = await fetchImpl(buildYahooNewsUrl(query), {
    headers: {
      ...DEFAULT_NEWS_HEADERS,
      Referer: 'https://finance.yahoo.com',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Yahoo Finance news request failed: ${response.status}`);
  }
  return parseYahooFinanceNews((await response.json()) as YahooSearchPayload);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchSourceSnippetsWithBudget(input: {
  sourceLabel: string;
  queries: string[];
  market: StockAnalysisMarket;
  fetchImpl: typeof fetch;
  lookbackDays: number;
  timeoutMs: number;
  maxResults: number;
}): Promise<{
  filteredSnippets: StockAnalysisNewsReference[];
  rawSnippets: StockAnalysisNewsReference[];
}> {
  const filteredSnippets: StockAnalysisNewsReference[] = [];
  const rawSnippets: StockAnalysisNewsReference[] = [];
  const seenFiltered = new Set<string>();
  const seenRaw = new Set<string>();
  const queryBatches = chunkArray(
    input.queries,
    FALLBACK_SOURCE_QUERY_CONCURRENCY,
  );
  const sourceStartedAt = Date.now();
  const sourceBudgetMs = Math.max(1000, input.timeoutMs) * queryBatches.length;

  for (let batchIndex = 0; batchIndex < queryBatches.length; batchIndex += 1) {
    const batch = queryBatches[batchIndex]!;
    const elapsedMs = Date.now() - sourceStartedAt;
    const remainingBudgetMs = sourceBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      break;
    }
    const remainingBatches = queryBatches.length - batchIndex;
    const requestTimeoutMs = Math.max(
      1000,
      Math.min(
        input.timeoutMs,
        Math.ceil(remainingBudgetMs / Math.max(1, remainingBatches)),
      ),
    );

    const results = await Promise.allSettled(
      batch.map(async (query) => {
        const items =
          input.sourceLabel === 'Bing News RSS'
            ? await fetchBingNewsSnippets(
                query,
                input.market,
                input.fetchImpl,
                requestTimeoutMs,
              )
            : await fetchYahooNewsSnippets(
                query,
                input.fetchImpl,
                requestTimeoutMs,
              );
        return { query, items };
      }),
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        continue;
      }
      appendUniqueSnippets(rawSnippets, seenRaw, result.value.items);
      appendUniqueSnippets(
        filteredSnippets,
        seenFiltered,
        result.value.items.filter((item) =>
          isWithinLookback(item.publishedAt, input.lookbackDays),
        ),
      );
    }

    if (filteredSnippets.length >= input.maxResults) {
      break;
    }
  }

  return { filteredSnippets, rawSnippets };
}

export async function fetchFallbackNewsSnippets({
  stockCode,
  stockName,
  market,
  lookbackDays,
  maxResults,
  fetchImpl,
  timeoutMs = 8000,
}: FetchFallbackNewsSnippetsInput): Promise<FallbackNewsSourceResult> {
  const runFetch = fetchImpl || fetch;
  const symbol = normalizeStockSymbol(stockCode, market);
  const queries = Array.from(
    new Set(
      [
        symbol.yahooSymbol,
        `${stockName} ${stockCode}`,
        ...buildFallbackQueries(stockCode, stockName, market),
      ].filter(Boolean),
    ),
  );
  const sources =
    market === 'cn'
      ? [
          { label: 'Bing News RSS', fn: fetchBingNewsSnippets },
          { label: 'Yahoo Finance News', fn: fetchYahooNewsSnippets },
        ]
      : market === 'hk'
        ? [
            { label: 'Yahoo Finance News', fn: fetchYahooNewsSnippets },
            { label: 'Bing News RSS', fn: fetchBingNewsSnippets },
          ]
        : [
            { label: 'Yahoo Finance News', fn: fetchYahooNewsSnippets },
          { label: 'Bing News RSS', fn: fetchBingNewsSnippets },
        ];

  const collected: StockAnalysisNewsReference[] = [];
  const rawCollected: StockAnalysisNewsReference[] = [];
  const seenCollected = new Set<string>();
  const seenRawCollected = new Set<string>();
  const usedSources = new Set<string>();

  for (const source of sources) {
    const { filteredSnippets, rawSnippets } = await fetchSourceSnippetsWithBudget({
      sourceLabel: source.label,
      queries,
      market,
      fetchImpl: runFetch,
      lookbackDays,
      timeoutMs,
      maxResults,
    });
    appendUniqueSnippets(rawCollected, seenRawCollected, rawSnippets);
    const freshSnippets = filteredSnippets.filter((item) =>
      isWithinLookback(item.publishedAt, lookbackDays),
    );
    if (appendUniqueSnippets(collected, seenCollected, freshSnippets) > 0) {
      usedSources.add(source.label);
    }

    if (collected.length >= maxResults) {
      break;
    }
  }

  const snippets = collected
    .sort((left, right) => {
      const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
      const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, maxResults);
  const rawSnippets = rawCollected
    .sort((left, right) => {
      const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
      const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
      return rightTime - leftTime;
    })
    .slice(0, Math.max(maxResults * 3, maxResults));

  return {
    sourceLabel:
      usedSources.size > 0
        ? Array.from(usedSources).join(' / ')
        : t('stock.auto_feccd6', {}, undefined),
    snippets,
    rawSnippets,
  };
}
