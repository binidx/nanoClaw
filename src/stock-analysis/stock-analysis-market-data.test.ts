import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetStockMarketDataStateForTests,
  fetchStockMarketSnapshot,
  getMarketIndexSymbols,
  normalizeStockSymbol,
  prefetchDomesticRealtimeQuotes,
} from './stock-analysis-market-data.js';

function createEastmoneyKlinePayload(
  code: string,
  name: string,
  rows: Array<[string, number, number, number, number, number]>,
) {
  return {
    data: {
      code,
      name,
      klines: rows.map(
        ([date, open, close, high, low, volume]) =>
          `${date},${open},${close},${high},${low},${volume},0,0,0,0,0`,
      ),
    },
  };
}

function createTencentKlinePayload(
  ticker: string,
  name: string,
  rows: Array<[string, number, number, number, number, number]>,
) {
  return {
    code: 0,
    data: {
      [ticker]: {
        qfqday: rows,
        qt: {
          [ticker]: ['0', name],
        },
      },
    },
  };
}

describe('stock-analysis-market-data', () => {
  beforeEach(() => {
    _resetStockMarketDataStateForTests();
    vi.useRealTimers();
  });

  it('normalizes A-share and Hong Kong stock codes', () => {
    expect(normalizeStockSymbol('600519')).toMatchObject({
      stockCode: '600519',
      market: 'cn',
      yahooSymbol: '600519.SS',
    });
    expect(normalizeStockSymbol('00700')).toMatchObject({
      stockCode: 'HK00700',
      market: 'hk',
      yahooSymbol: '00700.HK',
    });
    expect(normalizeStockSymbol('hk09988')).toMatchObject({
      stockCode: 'HK09988',
      market: 'hk',
      yahooSymbol: '09988.HK',
    });
    expect(normalizeStockSymbol('US.AAPL', 'us')).toMatchObject({
      stockCode: 'US.AAPL',
      market: 'us',
      yahooSymbol: 'AAPL',
    });
  });

  it('returns configured index symbols by market scope', () => {
    expect(getMarketIndexSymbols('cn', 2)).toHaveLength(2);
    expect(getMarketIndexSymbols('hk', 2)).toHaveLength(2);
    expect(getMarketIndexSymbols('both', 2)).toHaveLength(4);
  });

  it('skips domestic providers for hong kong index symbols with non-numeric codes', async () => {
    const hscei = getMarketIndexSymbols('hk', 3).find(
      (symbol) => symbol.stockCode === 'HSCEI',
    );
    expect(hscei).toBeDefined();
    const requestedUrls: string[] = [];
    const snapshot = await fetchStockMarketSnapshot(hscei!, {
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('query1.finance.yahoo.com')) {
          return new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: {
                      regularMarketPrice: 6100,
                      previousClose: 6000,
                      shortName: '国企指数',
                    },
                    timestamp: [1_705_000_000, 1_705_086_400],
                    indicators: {
                      quote: [
                        {
                          open: [6000, 6050],
                          high: [6120, 6150],
                          low: [5980, 6030],
                          close: [6050, 6100],
                          volume: [1000000, 1100000],
                        },
                      ],
                    },
                  },
                ],
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    expect(snapshot.source.providerId).toBe('yahoo');
    expect(snapshot.source.failoverTrace).toEqual(['Yahoo Finance: 成功']);
    expect(
      requestedUrls.some(
        (url) =>
          url.includes('push2his.eastmoney.com') || url.includes('ifzq.gtimg.cn'),
      ),
    ).toBe(false);
  });

  it('parses OHLC bars and skips incomplete rows', async () => {
    const snapshot = await fetchStockMarketSnapshot(
      normalizeStockSymbol('600519'),
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              chart: {
                result: [
                  {
                    meta: {
                      regularMarketPrice: 102,
                      previousClose: 99,
                      shortName: '贵州茅台',
                    },
                    timestamp: [1_705_000_000, 1_705_086_400, 1_705_172_800],
                    indicators: {
                      quote: [
                        {
                          open: [100, 101, null],
                          high: [103, 104, 105],
                          low: [99, 100, 101],
                          close: [101, 102, 103],
                          volume: [1000000, 1200000, 1500000],
                        },
                      ],
                    },
                  },
                ],
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    );

    expect(snapshot.symbol.displayName).toBe('贵州茅台');
    expect(snapshot.bars).toHaveLength(2);
    expect(snapshot.bars[0]).toMatchObject({
      open: 100,
      high: 103,
      low: 99,
      close: 101,
      volume: 1000000,
    });
    expect(snapshot.currentPrice).toBe(102);
    expect(snapshot.previousClose).toBe(99);
    expect(snapshot.source).toEqual({
      providerId: 'yahoo',
      providerLabel: 'Yahoo Finance',
      symbol: '600519.SS',
      interval: '1d',
      priceSource: 'historical_close',
      priceSourceLabel: '最近一根日线收盘',
      failoverTrace: [
        'AKShare (国内源): 东方财富行情返回为空',
        'efinance (国内源): 腾讯行情返回为空',
        'Yahoo Finance: 成功',
      ],
    });
  });

  it('surfaces aggregated provider errors after failover exhausts all candidates', async () => {
    await expect(
      fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
        fetchImpl: async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes('query1.finance.yahoo.com')) {
            return new Response('bad gateway', {
              status: 502,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          if (url.includes('ifzq.gtimg.cn')) {
            return new Response('upstream unavailable', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          return new Response('gateway timeout', {
            status: 504,
            headers: { 'Content-Type': 'text/plain' },
          });
        },
        providerPriority: 'yahoo,efinance,akshare',
      }),
    ).rejects.toThrow(
      '所有数据源均不可用：Yahoo Finance: 行情请求失败: 502；efinance (国内源): 腾讯行情请求失败: 503；AKShare (国内源): 东方财富行情请求失败: 504',
    );
  });

  it('falls back to eastmoney-backed akshare provider for Hong Kong stocks', async () => {
    const snapshot = await fetchStockMarketSnapshot(normalizeStockSymbol('00700'), {
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('query1.finance.yahoo.com')) {
          return new Response('forbidden', {
            status: 403,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return new Response(
          JSON.stringify(
            createEastmoneyKlinePayload('00700', '腾讯控股', [
              ['2026-03-10', 510, 515, 518, 505, 11000000],
              ['2026-03-11', 515, 522, 525, 512, 9800000],
              ['2026-03-12', 522, 530, 533, 520, 12500000],
            ]),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
      providerPriority: 'yahoo,akshare',
    });

    expect(snapshot.symbol).toMatchObject({
      stockCode: 'HK00700',
      market: 'hk',
      displayName: '腾讯控股',
    });
    expect(snapshot.currentPrice).toBe(530);
    expect(snapshot.previousClose).toBe(522);
    expect(snapshot.source).toEqual({
      providerId: 'akshare',
      providerLabel: 'AKShare (国内源)',
      symbol: '00700',
      interval: '1d',
      priceSource: 'historical_close',
      priceSourceLabel: '最近一根日线收盘',
      failoverTrace: [
        'Yahoo Finance: 行情请求失败: 403',
        'AKShare (国内源): 成功',
      ],
    });
  });

  it('parses tencent daily bars for the efinance provider', async () => {
    const snapshot = await fetchStockMarketSnapshot(
      normalizeStockSymbol('600519'),
      {
        fetchImpl: async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes('query1.finance.yahoo.com')) {
            return new Response('forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          return new Response(
            JSON.stringify(
              createTencentKlinePayload('sh600519', '贵州茅台', [
                ['2026-03-10', 1480, 1492, 1495, 1476, 820000],
                ['2026-03-11', 1492, 1501, 1504, 1488, 910000],
                ['2026-03-12', 1501, 1518, 1522, 1498, 1030000],
              ]),
            ),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
        providerPriority: 'yahoo,efinance',
      },
    );

    expect(snapshot.symbol.displayName).toBe('贵州茅台');
    expect(snapshot.bars).toHaveLength(3);
    expect(snapshot.currentPrice).toBe(1518);
    expect(snapshot.previousClose).toBe(1501);
    expect(snapshot.source).toEqual({
      providerId: 'efinance',
      providerLabel: 'efinance (国内源)',
      symbol: 'sh600519',
      interval: '1d',
      priceSource: 'historical_close',
      priceSourceLabel: '最近一根日线收盘',
      failoverTrace: [
        'Yahoo Finance: 行情请求失败: 403',
        'efinance (国内源): 成功',
      ],
    });
  });

  it('enhances domestic snapshots with realtime quote values when available', async () => {
    const snapshot = await fetchStockMarketSnapshot(
      normalizeStockSymbol('600519'),
      {
        fetchImpl: async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes('query1.finance.yahoo.com')) {
            return new Response('forbidden', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          if (url.includes('qt.gtimg.cn')) {
            return new Response(
              'v_sh600519="51~贵州茅台~600519~1523.88~1501.00~1502.00";',
              { headers: { 'Content-Type': 'text/plain; charset=gbk' } },
            );
          }
          return new Response(
            JSON.stringify(
              createTencentKlinePayload('sh600519', '贵州茅台', [
                ['2026-03-10', 1480, 1492, 1495, 1476, 820000],
                ['2026-03-11', 1492, 1501, 1504, 1488, 910000],
                ['2026-03-12', 1501, 1518, 1522, 1498, 1030000],
              ]),
            ),
            { headers: { 'Content-Type': 'application/json' } },
          );
        },
        providerPriority: 'yahoo,efinance',
      },
    );

    expect(snapshot.currentPrice).toBe(1523.88);
    expect(snapshot.previousClose).toBe(1501);
    expect(snapshot.changePct).toBeCloseTo(
      ((1523.88 - 1501) / 1501) * 100,
      2,
    );
    expect(snapshot.bars[snapshot.bars.length - 1]?.close).toBe(1518);
    expect(snapshot.source.priceSource).toBe('realtime_quote');
    expect(snapshot.source.priceSourceLabel).toBe('腾讯实时行情覆盖');
  });

  it('reuses cached domestic realtime quotes within the ttl window', async () => {
    let realtimeCalls = 0;
    let historyCalls = 0;

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.includes('qt.gtimg.cn')) {
        realtimeCalls += 1;
        return new Response(
          'v_sh600519="51~贵州茅台~600519~1523.88~1501.00~1502.00";',
          { headers: { 'Content-Type': 'text/plain; charset=gbk' } },
        );
      }
      historyCalls += 1;
      return new Response(
        JSON.stringify(
          createTencentKlinePayload('sh600519', '贵州茅台', [
            ['2026-03-10', 1480, 1492, 1495, 1476, 820000],
            ['2026-03-11', 1492, 1501, 1504, 1488, 910000],
            ['2026-03-12', 1501, 1518, 1522, 1498, 1030000],
          ]),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };

    const first = await fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
      fetchImpl,
      providerPriority: 'yahoo,efinance',
    });
    const second = await fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
      fetchImpl,
      providerPriority: 'yahoo,efinance',
    });

    expect(first.currentPrice).toBe(1523.88);
    expect(second.currentPrice).toBe(1523.88);
    expect(historyCalls).toBe(2);
    expect(realtimeCalls).toBe(1);
  });

  it('prefetches domestic realtime quotes in a single batch request', async () => {
    let realtimeCalls = 0;
    let historyCalls = 0;

    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.includes('qt.gtimg.cn')) {
        realtimeCalls += 1;
        return new Response(
          [
            'v_sh600519="51~贵州茅台~600519~1523.88~1501.00~1502.00";',
            'v_hk00700="100~腾讯控股~00700~530.50~522.00~523.00";',
          ].join('\n'),
          { headers: { 'Content-Type': 'text/plain; charset=gbk' } },
        );
      }
      historyCalls += 1;
      if (url.includes('push2his.eastmoney.com')) {
        return new Response(
          JSON.stringify(
            createEastmoneyKlinePayload('00700', '腾讯控股', [
              ['2026-03-10', 510, 515, 518, 505, 11000000],
              ['2026-03-11', 515, 522, 525, 512, 9800000],
              ['2026-03-12', 522, 530, 533, 520, 12500000],
            ]),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify(
          createTencentKlinePayload('sh600519', '贵州茅台', [
            ['2026-03-10', 1480, 1492, 1495, 1476, 820000],
            ['2026-03-11', 1492, 1501, 1504, 1488, 910000],
            ['2026-03-12', 1501, 1518, 1522, 1498, 1030000],
          ]),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };

    await prefetchDomesticRealtimeQuotes(
      [normalizeStockSymbol('600519'), normalizeStockSymbol('00700')],
      {
        fetchImpl,
      },
    );

    const cnSnapshot = await fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
      fetchImpl,
      providerPriority: 'yahoo,efinance',
    });
    const hkSnapshot = await fetchStockMarketSnapshot(normalizeStockSymbol('00700'), {
      fetchImpl,
      providerPriority: 'yahoo,akshare',
    });

    expect(realtimeCalls).toBe(1);
    expect(historyCalls).toBe(2);
    expect(cnSnapshot.currentPrice).toBe(1523.88);
    expect(hkSnapshot.currentPrice).toBe(530.5);
    expect(cnSnapshot.source.priceSource).toBe('realtime_quote');
    expect(hkSnapshot.source.priceSource).toBe('realtime_quote');
  });

  it('opens a cooldown after repeated domestic realtime failures and retries after recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-17T10:00:00.000Z'));

    let realtimeCalls = 0;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.includes('qt.gtimg.cn')) {
        realtimeCalls += 1;
        return new Response('unavailable', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response(
        JSON.stringify(
          createTencentKlinePayload('sh600519', '贵州茅台', [
            ['2026-03-10', 1480, 1492, 1495, 1476, 820000],
            ['2026-03-11', 1492, 1501, 1504, 1488, 910000],
            ['2026-03-12', 1501, 1518, 1522, 1498, 1030000],
          ]),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };

    for (let index = 0; index < 4; index += 1) {
      const snapshot = await fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
        fetchImpl,
        providerPriority: 'yahoo,efinance',
      });
      expect(snapshot.source.priceSource).toBe('historical_close');
    }

    expect(realtimeCalls).toBe(3);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await fetchStockMarketSnapshot(normalizeStockSymbol('600519'), {
      fetchImpl,
      providerPriority: 'yahoo,efinance',
    });

    expect(realtimeCalls).toBe(4);
  });
});
