/**
 * Stock Analysis Market Data
 *
 * Multi-provider data source architecture with automatic failover.
 * Providers: Yahoo Finance (default), efinance, akshare.
 */

import type {
  StockAnalysisDataProviderId,
  StockAnalysisDataProviderReport,
  StockAnalysisDataProviderStatus,
  StockAnalysisMarket,
  StockAnalysisMarketScope,
  StockAnalysisPriceSource,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

export interface NormalizedStockSymbol {
  stockCode: string;
  market: StockAnalysisMarket;
  yahooSymbol: string;
  displayName: string;
}

export interface StockDailyBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface StockMarketSnapshot {
  symbol: NormalizedStockSymbol;
  currentPrice: number;
  previousClose: number | null;
  changePct: number | null;
  bars: StockDailyBar[];
  source: {
    providerId: StockAnalysisDataProviderId;
    providerLabel: string;
    symbol: string;
    interval: '1d';
    priceSource: StockAnalysisPriceSource;
    priceSourceLabel: string;
    failoverTrace?: string[];
  };
}

/* ──────────── Data Provider Interface ──────────── */

export interface StockDataProvider {
  readonly id: StockAnalysisDataProviderId;
  readonly label: string;
  fetchSnapshot(
    symbol: NormalizedStockSymbol,
    opts: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      historyDays?: number;
    },
  ): Promise<StockMarketSnapshot>;
  supportsMarket(market: StockAnalysisMarket): boolean;
  supportsSymbol(symbol: NormalizedStockSymbol): boolean;
}

const DEFAULT_BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

const EASTMONEY_HISTORY_BASE =
  'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TENCENT_KLINE_BASE = 'https://web.ifzq.gtimg.cn/appstock/app';
const TENCENT_REALTIME_BASE = 'https://qt.gtimg.cn/q=';
const DOMESTIC_REALTIME_CACHE_TTL_MS = 15 * 1000;
const DOMESTIC_REALTIME_FAILURE_THRESHOLD = 3;
const DOMESTIC_REALTIME_COOLDOWN_MS = 5 * 60 * 1000;

function createProviderHeaders(referer: string): Record<string, string> {
  return {
    ...DEFAULT_BROWSER_HEADERS,
    Referer: referer,
  };
}

function formatDateCompact(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function resolveHistoryWindow(
  historyDays: number,
): { beg: string; end: string; count: number } {
  const count = Math.max(90, historyDays + 10);
  const end = new Date();
  const beg = new Date(end);
  beg.setUTCDate(beg.getUTCDate() - count);
  return {
    beg: formatDateCompact(beg),
    end: formatDateCompact(end),
    count,
  };
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized || normalized === '--') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBarTimestamp(value: string): string {
  const normalized = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00.000Z`
    : value;
}

function buildSnapshotFromBars(
  symbol: NormalizedStockSymbol,
  source: Omit<StockMarketSnapshot['source'], 'priceSource' | 'priceSourceLabel'> &
    Partial<
      Pick<StockMarketSnapshot['source'], 'priceSource' | 'priceSourceLabel'>
    >,
  bars: StockDailyBar[],
  displayName?: string | null,
): StockMarketSnapshot {
  if (bars.length === 0) {
    throw new Error(t('stock.auto_01e993', {}, undefined));
  }
  const latestBar = bars[bars.length - 1]!;
  const previousBar = bars.length > 1 ? bars[bars.length - 2]! : null;
  const currentPrice = latestBar.close;
  const previousClose = previousBar?.close ?? null;
  return {
    symbol: {
      ...symbol,
      displayName: displayName?.trim() || symbol.displayName,
    },
    currentPrice,
    previousClose,
    changePct:
      previousClose && previousClose > 0
        ? ((currentPrice - previousClose) / previousClose) * 100
        : null,
    bars,
    source: {
      ...source,
      priceSource: source.priceSource || 'historical_close',
      priceSourceLabel: source.priceSourceLabel || t('stock.auto_53d6b2', {}, undefined),
    },
  };
}

interface DomesticRealtimeQuote {
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
}

interface DomesticRealtimeCacheEntry {
  quote: DomesticRealtimeQuote;
  expiresAt: number;
}

interface DomesticRealtimeHealthState {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

const domesticRealtimeCache = new Map<string, DomesticRealtimeCacheEntry>();
const domesticRealtimeInflight = new Map<
  string,
  Promise<DomesticRealtimeQuote | null>
>();
const domesticRealtimeHealth: DomesticRealtimeHealthState = {
  consecutiveFailures: 0,
  cooldownUntil: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
};

function buildEastmoneySecid(symbol: NormalizedStockSymbol): string {
  if (symbol.market === 'hk') {
    const code = symbol.stockCode.replace(/^HK/i, '');
    if (!/^\d{5}$/.test(code)) {
      throw new Error(`东方财富暂不支持 ${symbol.stockCode} 的港股代码格式`);
    }
    return `116.${code}`;
  }
  if (symbol.market === 'cn') {
    if (!/^\d{6}$/.test(symbol.stockCode)) {
      throw new Error(`东方财富暂不支持 ${symbol.stockCode} 的 A 股代码格式`);
    }
    return /^(5|6|9)/.test(symbol.stockCode)
      ? `1.${symbol.stockCode}`
      : `0.${symbol.stockCode}`;
  }
  throw new Error(`东方财富暂不支持 ${symbol.market} 市场`);
}

function buildEastmoneyHistoryUrl(
  symbol: NormalizedStockSymbol,
  historyDays: number,
): string {
  const { beg, end } = resolveHistoryWindow(historyDays);
  const url = new URL(EASTMONEY_HISTORY_BASE);
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6');
  url.searchParams.set(
    'fields2',
    'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
  );
  url.searchParams.set('beg', beg);
  url.searchParams.set('end', end);
  url.searchParams.set('klt', '101');
  url.searchParams.set('fqt', '1');
  url.searchParams.set('ut', 'fa5fd1943c7b386f172d6893dbfba10b');
  url.searchParams.set('secid', buildEastmoneySecid(symbol));
  return url.toString();
}

function parseEastmoneySnapshot(
  payload: unknown,
  symbol: NormalizedStockSymbol,
): StockMarketSnapshot {
  const data = (payload as { data?: { code?: string; name?: string; klines?: string[] } })
    ?.data;
  const klines = Array.isArray(data?.klines) ? data.klines : [];
  const bars = klines
    .map((line) => String(line).split(','))
    .map((parts) => {
      const timestamp = parts[0]?.trim();
      const open = toNumber(parts[1]);
      const close = toNumber(parts[2]);
      const high = toNumber(parts[3]);
      const low = toNumber(parts[4]);
      const volume = toNumber(parts[5]);
      if (
        !timestamp ||
        open === null ||
        close === null ||
        high === null ||
        low === null
      ) {
        return null;
      }
      return {
        timestamp: toBarTimestamp(timestamp),
        open,
        high,
        low,
        close,
        volume,
      } satisfies StockDailyBar;
    })
    .filter((item): item is StockDailyBar => Boolean(item));

  if (bars.length === 0) {
    throw new Error(t('stock.auto_baa12e', {}, undefined));
  }

  return buildSnapshotFromBars(
    symbol,
    {
      providerId: 'akshare',
      providerLabel: t('stock.auto_0daa78', {}, undefined),
      symbol: data?.code || buildEastmoneySecid(symbol),
      interval: '1d',
    },
    bars,
    data?.name,
  );
}

function buildTencentTicker(symbol: NormalizedStockSymbol): string {
  if (symbol.market === 'hk') {
    const code = symbol.stockCode.replace(/^HK/i, '');
    if (!/^\d{5}$/.test(code)) {
      throw new Error(`腾讯行情暂不支持 ${symbol.stockCode} 的港股代码格式`);
    }
    return `hk${code}`;
  }
  if (symbol.market === 'cn') {
    if (!/^\d{6}$/.test(symbol.stockCode)) {
      throw new Error(`腾讯行情暂不支持 ${symbol.stockCode} 的 A 股代码格式`);
    }
    const prefix = /^(5|6|9)/.test(symbol.stockCode) ? 'sh' : 'sz';
    return `${prefix}${symbol.stockCode}`;
  }
  throw new Error(`腾讯行情暂不支持 ${symbol.market} 市场`);
}

function buildTencentHistoryUrl(
  symbol: NormalizedStockSymbol,
  historyDays: number,
): string {
  const ticker = buildTencentTicker(symbol);
  const { count } = resolveHistoryWindow(historyDays);
  const path = symbol.market === 'hk' ? 'hkfqkline' : 'fqkline';
  const url = new URL(`${TENCENT_KLINE_BASE}/${path}/get`);
  url.searchParams.set('param', `${ticker},day,,,${count},qfq`);
  return url.toString();
}

function buildTencentRealtimeUrl(symbol: NormalizedStockSymbol): string {
  return `${TENCENT_REALTIME_BASE}${buildTencentTicker(symbol)}`;
}

function buildTencentRealtimeBatchUrl(tickers: string[]): string {
  return `${TENCENT_REALTIME_BASE}${tickers.join(',')}`;
}

function getCachedDomesticRealtimeQuote(
  cacheKey: string,
): DomesticRealtimeQuote | null {
  const cached = domesticRealtimeCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    domesticRealtimeCache.delete(cacheKey);
    return null;
  }
  return cached.quote;
}

function setCachedDomesticRealtimeQuote(
  cacheKey: string,
  quote: DomesticRealtimeQuote,
): void {
  domesticRealtimeCache.set(cacheKey, {
    quote,
    expiresAt: Date.now() + DOMESTIC_REALTIME_CACHE_TTL_MS,
  });
}

function canUseDomesticRealtime(): boolean {
  return domesticRealtimeHealth.cooldownUntil <= Date.now();
}

function recordDomesticRealtimeSuccess(): void {
  domesticRealtimeHealth.consecutiveFailures = 0;
  domesticRealtimeHealth.cooldownUntil = 0;
  domesticRealtimeHealth.lastSuccessAt = new Date().toISOString();
}

function recordDomesticRealtimeFailure(): void {
  domesticRealtimeHealth.consecutiveFailures += 1;
  domesticRealtimeHealth.lastFailureAt = new Date().toISOString();
  if (
    domesticRealtimeHealth.consecutiveFailures >=
    DOMESTIC_REALTIME_FAILURE_THRESHOLD
  ) {
    domesticRealtimeHealth.cooldownUntil =
      Date.now() + DOMESTIC_REALTIME_COOLDOWN_MS;
  }
}

function parseTencentRealtimeQuote(payload: string): DomesticRealtimeQuote | null {
  const content = String(payload || '').trim();
  const dataStart = content.indexOf('"');
  const dataEnd = content.lastIndexOf('"');
  if (dataStart < 0 || dataEnd <= dataStart) {
    return null;
  }
  const fields = content.slice(dataStart + 1, dataEnd).split('~');
  if (fields.length < 6) {
    return null;
  }
  const price = toNumber(fields[3]);
  const previousClose = toNumber(fields[4]);
  const changePct =
    toNumber(fields[32]) ??
    (price !== null &&
    previousClose !== null &&
    previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : null);
  if (price === null) {
    return null;
  }
  return {
    price,
    previousClose,
    changePct,
  };
}

function extractTencentRealtimeTicker(payloadLine: string): string | null {
  const match = String(payloadLine || '')
    .trim()
    .match(/^v_([^=]+)=/);
  return match?.[1]?.trim() || null;
}

export async function prefetchDomesticRealtimeQuotes(
  symbols: NormalizedStockSymbol[],
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (!canUseDomesticRealtime()) {
    return;
  }

  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 12000;
  const existingRequests = symbols
    .filter((symbol) => symbol.market === 'cn' || symbol.market === 'hk')
    .map((symbol) => domesticRealtimeInflight.get(buildTencentTicker(symbol)))
    .filter(
      (
        request,
      ): request is Promise<DomesticRealtimeQuote | null> => Boolean(request),
    );
  const pendingEntries = Array.from(
    new Map(
      symbols
        .filter((symbol) => symbol.market === 'cn' || symbol.market === 'hk')
        .map((symbol) => [buildTencentTicker(symbol), symbol] as const),
    ).entries(),
  )
    .filter(([ticker]) => !getCachedDomesticRealtimeQuote(ticker))
    .filter(([ticker]) => !domesticRealtimeInflight.has(ticker));

  if (pendingEntries.length === 0) {
    await Promise.allSettled(existingRequests);
    return;
  }

  const tickers = pendingEntries.map(([ticker]) => ticker);
  const batchRequest = (async () => {
    try {
      const response = await fetchImpl(buildTencentRealtimeBatchUrl(tickers), {
        headers: createProviderHeaders('https://gu.qq.com'),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        recordDomesticRealtimeFailure();
        return new Map<string, DomesticRealtimeQuote>();
      }
      const text = await response.text();
      const parsedQuotes = new Map<string, DomesticRealtimeQuote>();
      for (const line of text.split(/\r?\n/)) {
        const ticker = extractTencentRealtimeTicker(line);
        if (!ticker) {
          continue;
        }
        const quote = parseTencentRealtimeQuote(line);
        if (quote && quote.price !== null) {
          parsedQuotes.set(ticker, quote);
          setCachedDomesticRealtimeQuote(ticker, quote);
        }
      }
      if (parsedQuotes.size > 0) {
        recordDomesticRealtimeSuccess();
      } else {
        recordDomesticRealtimeFailure();
      }
      return parsedQuotes;
    } catch {
      recordDomesticRealtimeFailure();
      return new Map<string, DomesticRealtimeQuote>();
    }
  })();

  const requests = pendingEntries.map(([ticker]) => {
    const request = batchRequest
      .then((quotes) => quotes.get(ticker) || null)
      .finally(() => {
        domesticRealtimeInflight.delete(ticker);
      });
    domesticRealtimeInflight.set(ticker, request);
    return request;
  });

  await Promise.allSettled([...existingRequests, ...requests]);
}

async function maybeEnhanceSnapshotWithTencentRealtime(
  snapshot: StockMarketSnapshot,
  symbol: NormalizedStockSymbol,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<StockMarketSnapshot> {
  if (symbol.market !== 'cn' && symbol.market !== 'hk') {
    return snapshot;
  }
  const cacheKey = buildTencentTicker(symbol);
  const cached = getCachedDomesticRealtimeQuote(cacheKey);
  if (cached && cached.price !== null) {
    return {
      ...snapshot,
      currentPrice: cached.price,
      previousClose: cached.previousClose ?? snapshot.previousClose,
      changePct:
        cached.changePct ??
        (cached.previousClose !== null &&
        cached.previousClose > 0
          ? ((cached.price - cached.previousClose) / cached.previousClose) * 100
          : snapshot.changePct),
      source: {
        ...snapshot.source,
        priceSource: 'realtime_quote',
        priceSourceLabel: t('stock.auto_fdd84a', {}, undefined),
      },
    };
  }
  if (!canUseDomesticRealtime()) {
    return snapshot;
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || 12000;
  try {
    let request = domesticRealtimeInflight.get(cacheKey);
    if (!request) {
      request = (async () => {
        try {
          const response = await fetchImpl(buildTencentRealtimeUrl(symbol), {
            headers: createProviderHeaders('https://gu.qq.com'),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            recordDomesticRealtimeFailure();
            return null;
          }
          const realtime = parseTencentRealtimeQuote(await response.text());
          if (!realtime || realtime.price === null) {
            recordDomesticRealtimeFailure();
            return null;
          }
          setCachedDomesticRealtimeQuote(cacheKey, realtime);
          recordDomesticRealtimeSuccess();
          return realtime;
        } catch {
          recordDomesticRealtimeFailure();
          return null;
        } finally {
          domesticRealtimeInflight.delete(cacheKey);
        }
      })();
      domesticRealtimeInflight.set(cacheKey, request);
    }
    const realtime = await request;
    if (!realtime || realtime.price === null) {
      return snapshot;
    }
    return {
      ...snapshot,
      currentPrice: realtime.price,
      previousClose: realtime.previousClose ?? snapshot.previousClose,
      changePct:
        realtime.changePct ??
        (realtime.previousClose !== null &&
        realtime.previousClose > 0
          ? ((realtime.price - realtime.previousClose) / realtime.previousClose) *
            100
          : snapshot.changePct),
      source: {
        ...snapshot.source,
        priceSource: 'realtime_quote',
        priceSourceLabel: t('stock.auto_fdd84a', {}, undefined),
      },
    };
  } catch {
    return snapshot;
  }
}

function parseTencentName(node: unknown, ticker: string): string | null {
  const qt = (node as { qt?: Record<string, unknown> })?.qt;
  const quote = qt?.[ticker];
  if (Array.isArray(quote) && typeof quote[1] === 'string' && quote[1].trim()) {
    return quote[1].trim();
  }
  const name = (node as { name?: unknown })?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function parseTencentSnapshot(
  payload: unknown,
  symbol: NormalizedStockSymbol,
): StockMarketSnapshot {
  const ticker = buildTencentTicker(symbol);
  const data = (payload as { data?: Record<string, unknown> })?.data;
  const node = data?.[ticker] as
    | {
        qfqday?: unknown[];
        day?: unknown[];
        hkday?: unknown[];
        qfqweek?: unknown[];
        qt?: Record<string, unknown>;
        name?: string;
      }
    | undefined;

  const rawBars = Array.isArray(node?.qfqday)
    ? node.qfqday
    : Array.isArray(node?.day)
      ? node.day
      : Array.isArray(node?.hkday)
        ? node.hkday
        : [];

  const bars = rawBars
    .map((item) => (Array.isArray(item) ? item : null))
    .map((parts) => {
      if (!parts) return null;
      const timestamp = typeof parts[0] === 'string' ? parts[0] : '';
      const open = toNumber(parts[1]);
      const close = toNumber(parts[2]);
      const high = toNumber(parts[3]);
      const low = toNumber(parts[4]);
      const volume = toNumber(parts[5]);
      if (
        !timestamp ||
        open === null ||
        close === null ||
        high === null ||
        low === null
      ) {
        return null;
      }
      return {
        timestamp: toBarTimestamp(timestamp),
        open,
        high,
        low,
        close,
        volume,
      } satisfies StockDailyBar;
    })
    .filter((item): item is StockDailyBar => Boolean(item));

  if (bars.length === 0) {
    throw new Error(t('stock.auto_a572c8', {}, undefined));
  }

  return buildSnapshotFromBars(
    symbol,
    {
      providerId: 'efinance',
      providerLabel: t('stock.auto_7fa0ca', {}, undefined),
      symbol: ticker,
      interval: '1d',
    },
    bars,
    parseTencentName(node, ticker),
  );
}

/* ──────────── Yahoo Finance Provider ──────────── */

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

function toYahooRange(historyDays: number): string {
  if (historyDays <= 90) return '3mo';
  if (historyDays <= 180) return '6mo';
  if (historyDays <= 365) return '1y';
  if (historyDays <= 730) return '2y';
  return '5y';
}

function buildChartUrl(
  symbol: string,
  timeoutMs: number,
  historyDays: number,
): string {
  const url = new URL(`${YAHOO_CHART_BASE}/${symbol}`);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('range', toYahooRange(historyDays));
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div|split');
  url.searchParams.set('_ts', String(timeoutMs));
  return url.toString();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

class YahooFinanceProvider implements StockDataProvider {
  readonly id: StockAnalysisDataProviderId = 'yahoo';
  readonly label = 'Yahoo Finance';

  supportsMarket(_market: StockAnalysisMarket): boolean {
    return true; // Yahoo supports all markets
  }

  supportsSymbol(_symbol: NormalizedStockSymbol): boolean {
    return true;
  }

  async fetchSnapshot(
    symbol: NormalizedStockSymbol,
    opts: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      historyDays?: number;
    } = {},
  ): Promise<StockMarketSnapshot> {
    const fetchImpl = opts.fetchImpl || fetch;
    const timeoutMs = opts.timeoutMs || 12000;
    const historyDays = Math.max(60, Number(opts.historyDays) || 180);
    const response = await fetchImpl(
      buildChartUrl(symbol.yahooSymbol, timeoutMs, historyDays),
      {
        headers: {
          ...createProviderHeaders('https://finance.yahoo.com'),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`行情请求失败: ${response.status}`);
    }

    const payload = (await response.json()) as {
      chart?: {
        error?: { description?: string } | null;
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            symbol?: string;
            shortName?: string;
            longName?: string;
          };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
      };
    };

    if (payload.chart?.error) {
      throw new Error(payload.chart.error.description || t('stock.auto_cc73f4', {}, undefined));
    }

    const result = payload.chart?.result?.[0];
    if (!result) {
      throw new Error(t('stock.auto_01e993', {}, undefined));
    }

    const quote = result.indicators?.quote?.[0];
    const openValues = quote?.open || [];
    const highValues = quote?.high || [];
    const lowValues = quote?.low || [];
    const closeValues = quote?.close || [];
    const volumeValues = quote?.volume || [];
    const timestamps = result.timestamp || [];
    const bars: StockDailyBar[] = [];

    for (let index = 0; index < timestamps.length; index += 1) {
      const ts = timestamps[index];
      const open = toFiniteNumber(openValues[index]);
      const high = toFiniteNumber(highValues[index]);
      const low = toFiniteNumber(lowValues[index]);
      const close = toFiniteNumber(closeValues[index]);
      const volume = toFiniteNumber(volumeValues[index]);
      if (
        typeof ts !== 'number' ||
        open === null ||
        high === null ||
        low === null ||
        close === null
      ) {
        continue;
      }
      bars.push({
        timestamp: new Date(ts * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume,
      });
    }

    const meta = result.meta || {};
    const stockName =
      meta.longName?.trim() || meta.shortName?.trim() || symbol.displayName;
    return {
      symbol: {
        ...symbol,
        displayName: stockName,
      },
      currentPrice:
        toFiniteNumber(meta.regularMarketPrice) ??
        bars[bars.length - 1]?.close ??
        0,
      previousClose: toFiniteNumber(meta.previousClose),
      changePct:
        meta.regularMarketPrice && meta.previousClose
          ? ((meta.regularMarketPrice - meta.previousClose) /
              meta.previousClose) *
            100
          : null,
      bars,
      source: {
        providerId: 'yahoo',
        providerLabel: 'Yahoo Finance',
        symbol: symbol.yahooSymbol,
        interval: '1d',
        priceSource: 'historical_close',
        priceSourceLabel: t('stock.auto_53d6b2', {}, undefined),
      },
    };
  }
}

/* ──────────── efinance Provider ──────────── */

class EfinanceProvider implements StockDataProvider {
  readonly id: StockAnalysisDataProviderId = 'efinance';
  readonly label = t('stock.auto_7fa0ca', {}, undefined);

  supportsMarket(market: StockAnalysisMarket): boolean {
    return market === 'cn' || market === 'hk';
  }

  supportsSymbol(symbol: NormalizedStockSymbol): boolean {
    if (symbol.market === 'cn') {
      return /^\d{6}$/.test(symbol.stockCode);
    }
    if (symbol.market === 'hk') {
      return /^HK\d{5}$/.test(symbol.stockCode);
    }
    return false;
  }

  async fetchSnapshot(
    symbol: NormalizedStockSymbol,
    opts: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      historyDays?: number;
    } = {},
  ): Promise<StockMarketSnapshot> {
    const fetchImpl = opts.fetchImpl || fetch;
    const timeoutMs = opts.timeoutMs || 12000;
    const historyDays = Math.max(60, Number(opts.historyDays) || 180);
    const response = await fetchImpl(
      buildTencentHistoryUrl(symbol, historyDays),
      {
        headers: createProviderHeaders('https://gu.qq.com'),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`腾讯行情请求失败: ${response.status}`);
    }
    return maybeEnhanceSnapshotWithTencentRealtime(
      parseTencentSnapshot(await response.json(), symbol),
      symbol,
      {
        fetchImpl,
        timeoutMs,
      },
    );
  }
}

/* ──────────── AKShare Provider ──────────── */

class AkshareProvider implements StockDataProvider {
  readonly id: StockAnalysisDataProviderId = 'akshare';
  readonly label = t('stock.auto_0daa78', {}, undefined);

  supportsMarket(market: StockAnalysisMarket): boolean {
    return market === 'cn' || market === 'hk';
  }

  supportsSymbol(symbol: NormalizedStockSymbol): boolean {
    if (symbol.market === 'cn') {
      return /^\d{6}$/.test(symbol.stockCode);
    }
    if (symbol.market === 'hk') {
      return /^HK\d{5}$/.test(symbol.stockCode);
    }
    return false;
  }

  async fetchSnapshot(
    symbol: NormalizedStockSymbol,
    opts: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      historyDays?: number;
    } = {},
  ): Promise<StockMarketSnapshot> {
    const fetchImpl = opts.fetchImpl || fetch;
    const timeoutMs = opts.timeoutMs || 12000;
    const historyDays = Math.max(60, Number(opts.historyDays) || 180);
    const response = await fetchImpl(
      buildEastmoneyHistoryUrl(symbol, historyDays),
      {
        headers: createProviderHeaders('https://quote.eastmoney.com'),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`东方财富行情请求失败: ${response.status}`);
    }
    return maybeEnhanceSnapshotWithTencentRealtime(
      parseEastmoneySnapshot(await response.json(), symbol),
      symbol,
      {
        fetchImpl,
        timeoutMs,
      },
    );
  }
}

/* ──────────── Provider Registry ──────────── */

const PROVIDERS: Record<StockAnalysisDataProviderId, StockDataProvider> = {
  yahoo: new YahooFinanceProvider(),
  efinance: new EfinanceProvider(),
  akshare: new AkshareProvider(),
};

/* ──────────── Data Fetcher Manager (failover orchestrator) ──────────── */

interface ProviderStats {
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastChecked: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  available: boolean;
}

interface ProviderAttemptError {
  providerId: StockAnalysisDataProviderId;
  providerLabel: string;
  error: string;
}

const providerStats = new Map<StockAnalysisDataProviderId, ProviderStats>();

function getProviderStats(id: StockAnalysisDataProviderId): ProviderStats {
  if (!providerStats.has(id)) {
    providerStats.set(id, {
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastChecked: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      available: true,
    });
  }
  return providerStats.get(id)!;
}

function recordSuccess(id: StockAnalysisDataProviderId): void {
  const stats = getProviderStats(id);
  const checkedAt = new Date().toISOString();
  stats.successCount += 1;
  stats.consecutiveFailures = 0;
  stats.available = true;
  stats.lastChecked = checkedAt;
  stats.lastSuccessAt = checkedAt;
  stats.lastError = null;
}

function recordFailure(id: StockAnalysisDataProviderId, error: string): void {
  const stats = getProviderStats(id);
  const checkedAt = new Date().toISOString();
  stats.failureCount += 1;
  stats.consecutiveFailures += 1;
  stats.lastChecked = checkedAt;
  stats.lastFailureAt = checkedAt;
  stats.lastError = error;
  // Mark as unavailable after 3 consecutive failures.
  if (stats.consecutiveFailures >= 3) {
    stats.available = false;
  }
}

function normalizeProviderErrorMessage(
  providerId: StockAnalysisDataProviderId,
  error: string,
): string {
  return error;
}

function buildAggregatedProviderError(
  attempts: ProviderAttemptError[],
): Error | null {
  if (attempts.length === 0) return null;
  if (attempts.length === 1) {
    return new Error(attempts[0].error);
  }
  return new Error(
    `所有数据源均不可用：${attempts
      .map(
        (attempt) =>
          `${attempt.providerLabel}: ${normalizeProviderErrorMessage(
            attempt.providerId,
            attempt.error,
          )}`,
      )
      .join('；')}`,
  );
}

function buildProviderTraceEntry(
  providerLabel: string,
  message: string,
): string {
  return `${providerLabel}: ${message}`;
}

/** Auto-recover providers after a cooldown period (5 minutes). */
const PROVIDER_RECOVERY_MS = 5 * 60 * 1000;

function maybeRecoverProviders(): void {
  const now = Date.now();
  for (const [, stats] of providerStats) {
    if (
      !stats.available &&
      stats.lastChecked &&
      now - new Date(stats.lastChecked).getTime() > PROVIDER_RECOVERY_MS
    ) {
      stats.available = true;
    }
  }
}

export function getDataProviderReport(): StockAnalysisDataProviderReport {
  const providers: StockAnalysisDataProviderStatus[] = Object.values(PROVIDERS).map(
    (provider) => {
      const stats = getProviderStats(provider.id);
      return {
        providerId: provider.id,
        providerLabel: provider.label,
        available: stats.available,
        lastChecked: stats.lastChecked,
        lastSuccessAt: stats.lastSuccessAt,
        lastFailureAt: stats.lastFailureAt,
        lastError: stats.lastError,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        consecutiveFailures: stats.consecutiveFailures,
      };
    },
  );
  const activeProvider =
    [...providers]
      .filter((provider) => provider.successCount > 0)
      .sort((left, right) => {
        const leftTime = left.lastSuccessAt
          ? new Date(left.lastSuccessAt).getTime()
          : 0;
        const rightTime = right.lastSuccessAt
          ? new Date(right.lastSuccessAt).getTime()
          : 0;
        return rightTime - leftTime;
      })[0]?.providerId ?? 'yahoo';

  return {
    activeProvider,
    providers,
    failoverEnabled: true,
  };
}

/**
 * Parse the priority string into an ordered list of provider IDs.
 */
function parsePriority(priorityStr: string): StockAnalysisDataProviderId[] {
  return priorityStr
    .split(',')
    .map((s) => s.trim() as StockAnalysisDataProviderId)
    .filter((id) => id in PROVIDERS);
}

export function _resetStockMarketDataStateForTests(): void {
  domesticRealtimeCache.clear();
  domesticRealtimeInflight.clear();
  domesticRealtimeHealth.consecutiveFailures = 0;
  domesticRealtimeHealth.cooldownUntil = 0;
  domesticRealtimeHealth.lastFailureAt = null;
  domesticRealtimeHealth.lastSuccessAt = null;
  providerStats.clear();
}

function resolveDefaultProviderPriority(
  market: StockAnalysisMarket,
  providerPriority?: string,
): string {
  const normalized = String(providerPriority || '').trim();
  if (normalized) {
    return normalized;
  }
  return market === 'us' ? 'yahoo' : 'akshare,efinance,yahoo';
}

export async function fetchStockMarketSnapshot(
  symbol: NormalizedStockSymbol,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    historyDays?: number;
    preferredProvider?: StockAnalysisDataProviderId;
    failoverEnabled?: boolean;
    providerPriority?: string;
  } = {},
): Promise<StockMarketSnapshot> {
  // Auto-recover providers that have been unavailable for a while
  maybeRecoverProviders();

  const failoverEnabled = opts.failoverEnabled !== false;
  const priorityStr = resolveDefaultProviderPriority(
    symbol.market,
    opts.providerPriority,
  );
  const priority = parsePriority(priorityStr);

  // If preferred provider is set, put it first
  if (opts.preferredProvider && opts.preferredProvider in PROVIDERS) {
    const idx = priority.indexOf(opts.preferredProvider);
    if (idx > 0) {
      priority.splice(idx, 1);
      priority.unshift(opts.preferredProvider);
    } else if (idx === -1) {
      priority.unshift(opts.preferredProvider);
    }
  }

  // Filter to providers that support both the market and the specific symbol format.
  const candidates = priority.filter((id) =>
    PROVIDERS[id].supportsMarket(symbol.market) &&
    PROVIDERS[id].supportsSymbol(symbol),
  );

  if (candidates.length === 0) {
    throw new Error(`没有可用的数据源支持 ${symbol.market} 市场`);
  }

  let lastError: Error | null = null;
  const attempts: ProviderAttemptError[] = [];

  for (const providerId of candidates) {
    const provider = PROVIDERS[providerId];
    const stats = getProviderStats(providerId);

    // Skip providers marked as unavailable (unless it's the last option)
    if (!stats.available && candidates.indexOf(providerId) < candidates.length - 1) {
      continue;
    }

    try {
      const snapshot = await provider.fetchSnapshot(symbol, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        historyDays: opts.historyDays,
      });
      recordSuccess(providerId);
      const failoverTrace = [
        ...attempts.map((attempt) =>
          buildProviderTraceEntry(attempt.providerLabel, attempt.error),
        ),
        buildProviderTraceEntry(provider.label, t('stock.auto_330363', {}, undefined)),
      ];
      return {
        ...snapshot,
        source: {
          ...snapshot.source,
          failoverTrace,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : t('stock.auto_974e74', {}, undefined);
      recordFailure(providerId, errorMsg);
      lastError = err instanceof Error ? err : new Error(errorMsg);
      attempts.push({
        providerId,
        providerLabel: provider.label,
        error: errorMsg,
      });

      if (!failoverEnabled) {
        throw lastError;
      }
      // Continue to next provider
    }
  }

  throw buildAggregatedProviderError(attempts) || lastError || new Error(t('stock.auto_8bb485', {}, undefined));
}

/* ──────────── Index symbols ──────────── */

const CN_INDEX_SYMBOLS: NormalizedStockSymbol[] = [
  {
    stockCode: '000001',
    market: 'cn',
    yahooSymbol: '000001.SS',
    displayName: t('stock.auto_0d54b1', {}, undefined),
  },
  {
    stockCode: '399001',
    market: 'cn',
    yahooSymbol: '399001.SZ',
    displayName: t('stock.auto_8b2bbc', {}, undefined),
  },
  {
    stockCode: '399006',
    market: 'cn',
    yahooSymbol: '399006.SZ',
    displayName: t('stock.auto_301bd7', {}, undefined),
  },
];

const HK_INDEX_SYMBOLS: NormalizedStockSymbol[] = [
  {
    stockCode: 'HSI',
    market: 'hk',
    yahooSymbol: '^HSI',
    displayName: t('stock.auto_d0ac84', {}, undefined),
  },
  {
    stockCode: 'HSCEI',
    market: 'hk',
    yahooSymbol: '^HSCE',
    displayName: t('stock.auto_729554', {}, undefined),
  },
  {
    stockCode: 'HSTECH',
    market: 'hk',
    yahooSymbol: '^HSTECH',
    displayName: t('stock.auto_cc7037', {}, undefined),
  },
];

const US_INDEX_SYMBOLS: NormalizedStockSymbol[] = [
  {
    stockCode: 'SPX',
    market: 'us',
    yahooSymbol: '^GSPC',
    displayName: 'S&P 500',
  },
  {
    stockCode: 'DJI',
    market: 'us',
    yahooSymbol: '^DJI',
    displayName: t('stock.auto_413920', {}, undefined),
  },
  {
    stockCode: 'IXIC',
    market: 'us',
    yahooSymbol: '^IXIC',
    displayName: t('stock.auto_9ad424', {}, undefined),
  },
];

function padHongKongCode(value: string): string {
  return value.padStart(5, '0');
}

export function normalizeStockSymbol(
  input: string,
  defaultMarket: StockAnalysisMarketScope = 'both',
): NormalizedStockSymbol {
  const trimmed = String(input || '')
    .trim()
    .toUpperCase();
  if (!trimmed) {
    throw new Error(t('stock.auto_c49d8e', {}, undefined));
  }

  // ── US stock: letters only or with .US suffix ──
  const usExplicitMatch = trimmed.match(/^([A-Z]{1,5})\.US$/);
  if (usExplicitMatch) {
    const ticker = usExplicitMatch[1];
    return {
      stockCode: `US.${ticker}`,
      market: 'us',
      yahooSymbol: ticker,
      displayName: `美股 ${ticker}`,
    };
  }

  const usInternalMatch = trimmed.match(/^US\.([A-Z]{1,5})$/);
  if (usInternalMatch) {
    const ticker = usInternalMatch[1];
    return {
      stockCode: `US.${ticker}`,
      market: 'us',
      yahooSymbol: ticker,
      displayName: `美股 ${ticker}`,
    };
  }

  // Pure letter ticker when default market is US
  if (/^[A-Z]{1,5}$/.test(trimmed) && defaultMarket === 'us') {
    return {
      stockCode: `US.${trimmed}`,
      market: 'us',
      yahooSymbol: trimmed,
      displayName: `美股 ${trimmed}`,
    };
  }

  // ── HK stock ──
  const hkSuffixMatch = trimmed.match(/^(\d{1,5})\.HK$/);
  if (hkSuffixMatch) {
    const code = padHongKongCode(hkSuffixMatch[1] || '');
    return {
      stockCode: `HK${code}`,
      market: 'hk',
      yahooSymbol: `${code}.HK`,
      displayName: `港股 ${code}`,
    };
  }

  const hkPrefixMatch = trimmed.match(/^HK(\d{1,5})$/);
  if (hkPrefixMatch) {
    const code = padHongKongCode(hkPrefixMatch[1] || '');
    return {
      stockCode: `HK${code}`,
      market: 'hk',
      yahooSymbol: `${code}.HK`,
      displayName: `港股 ${code}`,
    };
  }

  if (/^\d{1,5}$/.test(trimmed) && defaultMarket !== 'cn') {
    const code = padHongKongCode(trimmed);
    return {
      stockCode: `HK${code}`,
      market: 'hk',
      yahooSymbol: `${code}.HK`,
      displayName: `港股 ${code}`,
    };
  }

  // ── CN stock (A-share) ──
  const cnSuffixMatch = trimmed.match(/^(\d{6})\.(SH|SS|SZ)$/);
  if (cnSuffixMatch) {
    const code = cnSuffixMatch[1] || '';
    const suffix = cnSuffixMatch[2] === 'SZ' ? 'SZ' : 'SS';
    return {
      stockCode: code,
      market: 'cn',
      yahooSymbol: `${code}.${suffix}`,
      displayName: `A股 ${code}`,
    };
  }

  const cnPrefixMatch = trimmed.match(/^(SH|SZ)(\d{6})$/);
  if (cnPrefixMatch) {
    const suffix = cnPrefixMatch[1] === 'SZ' ? 'SZ' : 'SS';
    const code = cnPrefixMatch[2] || '';
    return {
      stockCode: code,
      market: 'cn',
      yahooSymbol: `${code}.${suffix}`,
      displayName: `A股 ${code}`,
    };
  }

  // ── BJ stock (Beijing exchange / 北交所) ──
  const bjMatch = trimmed.match(/^(8\d{5})\.BJ$/);
  if (bjMatch || (/^\d{6}$/.test(trimmed) && trimmed.startsWith('8'))) {
    const code = bjMatch ? bjMatch[1] : trimmed;
    return {
      stockCode: code,
      market: 'cn',
      yahooSymbol: `${code}.BJ`,
      displayName: `北交所 ${code}`,
    };
  }

  if (/^\d{6}$/.test(trimmed)) {
    const suffix = trimmed.startsWith('6') ? 'SS' : 'SZ';
    return {
      stockCode: trimmed,
      market: 'cn',
      yahooSymbol: `${trimmed}.${suffix}`,
      displayName: `A股 ${trimmed}`,
    };
  }

  throw new Error(`无法识别股票代码: ${input}`);
}

export function getMarketIndexSymbols(
  scope: StockAnalysisMarketScope,
  perMarket: number,
): Array<NormalizedStockSymbol> {
  const normalizedPerMarket = Math.max(1, perMarket);
  const items: Array<NormalizedStockSymbol> = [];
  if (scope === 'cn' || scope === 'both' || scope === 'all') {
    items.push(...CN_INDEX_SYMBOLS.slice(0, normalizedPerMarket));
  }
  if (scope === 'hk' || scope === 'both' || scope === 'all') {
    items.push(...HK_INDEX_SYMBOLS.slice(0, normalizedPerMarket));
  }
  if (scope === 'us' || scope === 'all') {
    items.push(...US_INDEX_SYMBOLS.slice(0, normalizedPerMarket));
  }
  return items;
}
