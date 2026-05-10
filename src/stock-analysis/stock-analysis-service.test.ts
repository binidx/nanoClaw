import { beforeEach, describe, expect, it, vi } from 'vitest';

function createChartPayload(symbol: string, name: string, closes: number[]) {
  const timestamps = closes.map(
    (_value, index) => 1_705_000_000 + index * 86_400,
  );
  const opens = closes.map((close, index) =>
    index === 0 ? close - 0.3 : closes[index - 1]!,
  );
  const highs = closes.map((close, index) => Math.max(close, opens[index]!) + 0.8);
  const lows = closes.map((close, index) => Math.min(close, opens[index]!) - 0.8);
  const volumes = closes.map((_close, index) => 10_000_000 + index * 125_000);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            shortName: name,
            longName: name,
            regularMarketPrice: closes[closes.length - 1],
            previousClose: closes[closes.length - 2],
          },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: opens,
                high: highs,
                low: lows,
                close: closes,
                volume: volumes,
              },
            ],
          },
        },
      ],
    },
  };
}

function createEastmoneyKlinePayload(
  code: string,
  name: string,
  rows: ReadonlyArray<
    readonly [string, number, number, number, number, number]
  >,
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

function computeExpectedEma(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const multiplier = 2 / (period + 1);
  let ema = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    ema = values[index]! * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function countMarketDataRequests(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = String(input);
    return (
      url.includes('query1.finance.yahoo.com/v8/finance/chart') ||
      url.includes('push2his.eastmoney.com/api/qt/stock/kline/get') ||
      url.includes('web.ifzq.gtimg.cn/appstock/app')
    );
  }).length;
}

describe('stock-analysis-service', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await import('../db.js');
    db._initTestDatabase();
  });

  it('queues analysis tasks, persists history, and rejects duplicate running symbols', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 10 + index * 0.15,
    );
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('600519.SS')) {
        return new Response(
          JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateText: async () =>
        '{"headline":"AI 总结","analysisSummary":"AI 分析摘要","operationAdvice":"观察跟踪","riskSignals":["波动仍高"],"catalystSignals":["趋势修复中"]}',
      generateNewsIntel: async () =>
        '{"summary":"近一周行业景气与公司经营预期共振，消息面偏正向。","hotTopics":["高端白酒复苏","消费修复"],"bullishSignals":["渠道反馈改善，市场预期回暖。","行业景气修复带动资金回流。"],"riskSignals":["板块估值不低，短线不宜追高。"],"confidence":"medium","references":[{"title":"白酒板块预期回暖","source":"财联社","publishedAt":"2026-03-14","summary":"机构继续跟踪消费修复节奏。"},{"title":"渠道库存变化受关注","source":"证券时报","publishedAt":"2026-03-13","summary":"市场继续观察库存与动销改善。"}]}',
    });

    const first = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    const second = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });

    expect(first.accepted).toHaveLength(1);
    expect(second.rejected).toEqual([
      expect.objectContaining({
        stockCode: '600519',
        error: '该股票已有运行中的分析任务',
      }),
    ]);

    await service.waitForIdle();

    const tasks = (await service.listTasks()).tasks;
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.resultMode).toBe('generated');
    expect(tasks[0]?.dataAsOf).toMatch(/T/);
    expect(tasks[0]?.strategyPreset).toBe('bull_trend');

    const history = await service.listHistory();
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      stockCode: '600519',
      stockName: '贵州茅台',
      historyDays: 180,
    });

    const detail = await service.getHistoryDetail(history.items[0]!.id);
    expect(detail?.summary.headline).toBe('AI 总结');
    expect(detail?.dataAsOf).toMatch(/T/);
    expect(detail?.historyDays).toBe(180);
    expect(detail?.strategy).toMatchObject({
      id: 'bull_trend',
      label: '多头趋势',
    });
    expect(detail?.dataSource).toMatchObject({
      providerId: 'yahoo',
      providerLabel: 'Yahoo Finance',
      symbol: '600519.SS',
      interval: '1d',
      priceSource: 'historical_close',
      priceSourceLabel: '最近一根日线收盘',
    });
    expect(detail?.details.recentBars).toHaveLength(60);
    expect(detail?.details.recentBars[0]).toMatchObject({
      open: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      close: expect.any(Number),
      volume: expect.any(Number),
    });
    expect(detail?.details.recentBars.at(-1)?.ma20).not.toBeNull();
    expect(detail?.details.recentBars.at(-1)?.ma60).not.toBeNull();
    expect(detail?.details.factorScores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'trend',
          title: '趋势结构',
        }),
        expect.objectContaining({
          key: 'macd',
          title: 'MACD',
        }),
        expect.objectContaining({
          key: 'rsi',
          title: 'RSI',
        }),
        expect.objectContaining({
          key: 'catalyst',
          title: '题材催化',
        }),
      ]),
    );
    expect(detail?.metrics.biasToMa20).not.toBeNull();
    expect(detail?.metrics.macdDiff).not.toBeNull();
    expect(detail?.metrics.macdSignal).not.toBeNull();
    expect(detail?.metrics.macdHistogram).not.toBeNull();
    expect(detail?.metrics.rsi14).not.toBeNull();
    expect(detail?.details.tradePlan).toMatchObject({
      idealBuy: expect.any(Number),
      stopLoss: expect.any(Number),
      takeProfit: expect.any(Number),
    });
    expect(detail?.details.newsIntel).toMatchObject({
      status: 'ready',
      sourceType: 'provider_web_search',
      usedExternalSearch: true,
      confidence: 'medium',
    });
    expect(detail?.details.newsIntel.hotTopics).toEqual(
      expect.arrayContaining(['高端白酒复苏', '消费修复']),
    );
    expect(detail?.details.newsIntel.references[0]).toMatchObject({
      title: '白酒板块预期回暖',
      source: '财联社',
    });
    expect(detail?.details.pipelineLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'data_fetch', status: 'ok' }),
        expect.objectContaining({ stage: 'technical_analysis', status: 'ok' }),
        expect.objectContaining({ stage: 'news_intel', status: 'ok' }),
        expect.objectContaining({ stage: 'ai_summary', status: 'ok' }),
      ]),
    );
    expect(detail?.details.pipelineLog).toHaveLength(7);

    const dashboard = await service.getHistoryDashboard(history.items[0]!.id);
    expect(dashboard).toMatchObject({
      signal: expect.stringMatching(/green|yellow|red/),
      verdict: expect.stringContaining('贵州茅台'),
      keyMetrics: {
        price: detail?.metrics.currentPrice,
        maAligned: detail?.metrics.maAligned,
        trendState: detail?.metrics.trendState,
        macdState: detail?.metrics.macdState,
        rsiState: detail?.metrics.rsiState,
        volumeState: detail?.metrics.volumeState,
      },
      tradePlan: detail?.details.tradePlan,
    });
    expect(dashboard?.factorChart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'trend' }),
        expect.objectContaining({ key: 'macd' }),
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate symbols that already exist as pending tasks in persistence', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const created = await db.createStockAnalysisTask({
      id: 'stock-task-existing',
      stock_code: '600519',
      market: 'cn',
      stock_name: null,
      status: 'pending',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: null,
      data_as_of: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    });

    expect(created).toBe(true);

    const result = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        stockCode: '600519',
        error: '该股票已有运行中的分析任务',
      }),
    ]);
  });

  it('rejects duplicate running symbols across service instances', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 20 + index * 0.2,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('00700.HK', '腾讯控股', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const firstService = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const secondService = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await firstService.analyze({
      stockCodes: ['00700'],
      marketScope: 'hk',
    });
    const second = await secondService.analyze({
      stockCodes: ['00700'],
      marketScope: 'hk',
    });

    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toEqual([
      expect.objectContaining({
        stockCode: '00700',
        error: '该股票已有运行中的分析任务',
      }),
    ]);

    await firstService.waitForIdle();
  });

  it('updates config with version checks', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const initialConfig = await service.getConfig();
    const updated = await service.updateConfig({
      configVersion: initialConfig.configVersion,
      config: {
        defaultMarketScope: 'cn',
        maxConcurrentTasks: 3,
      },
    });
    const latestConfig = await service.getConfig();

    expect(updated.ok).toBe(true);
    expect(updated.configVersion).toBe(latestConfig.configVersion);
    expect(latestConfig.config.defaultMarketScope).toBe('cn');
    expect(latestConfig.config.maxConcurrentTasks).toBe(3);
    await expect(
      service.updateConfig({
        configVersion: initialConfig.configVersion,
        config: {
          maxConcurrentTasks: 4,
        },
      }),
    ).rejects.toThrow('配置已变化，请刷新后重试');
  });

  it('keeps config versions monotonic across reset-to-default updates', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const initialVersion = (await service.getConfig()).configVersion;

    const customized = await service.updateConfig({
      configVersion: initialVersion,
      config: {
        defaultMarketScope: 'hk',
      },
    });
    expect(customized.configVersion).not.toBe(initialVersion);

    const reset = await service.updateConfig({
      configVersion: customized.configVersion,
      config: {
        defaultMarketScope: 'both',
      },
    });
    expect(reset.configVersion).not.toBe(initialVersion);
    expect((await service.getConfig()).config.defaultMarketScope).toBe('both');

    await expect(
      service.updateConfig({
        configVersion: initialVersion,
        config: {
          maxConcurrentTasks: 4,
        },
      }),
    ).rejects.toThrow('配置已变化，请刷新后重试');
  });

  it('exposes config defaults and presets metadata', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const meta = service.getConfigMeta();
    const defaultMarketScopeField = meta.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'defaultMarketScope');
    const defaultStrategyPresetField = meta.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'defaultStrategyPreset');
    const marketReviewScopeField = meta.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'marketReviewScope');

    expect(meta.defaults).toMatchObject({
      defaultMarketScope: 'both',
      defaultReportType: 'standard',
      defaultStrategyPreset: 'bull_trend',
      maxConcurrentTasks: 2,
    });
    expect(defaultMarketScopeField?.options?.map((item) => item.value)).toEqual(
      expect.arrayContaining(['cn', 'hk', 'us', 'both', 'all']),
    );
    expect(defaultStrategyPresetField?.options?.map((item) => item.value)).toEqual(
      expect.arrayContaining([
        'bull_trend',
        'shrink_pullback',
        'volume_breakout',
        'ma_golden_cross',
        'box_oscillation',
      ]),
    );
    expect(marketReviewScopeField?.options?.map((item) => item.value)).toEqual(
      expect.arrayContaining(['cn', 'hk', 'us', 'both', 'all']),
    );
    expect(meta.presets.map((item) => item.id)).toEqual(
      expect.arrayContaining(['balanced', 'fast-scan', 'deep-dive']),
    );
    expect(
      meta.presets.find((item) => item.id === 'fast-scan')?.values,
    ).toMatchObject({
      defaultReportType: 'brief',
      defaultStrategyPreset: 'volume_breakout',
      maxConcurrentTasks: 4,
      aiSummaryEnabled: false,
    });
  });

  it('saves, lists, updates, and deletes custom config presets', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const created = await service.saveConfigPreset({
      title: '高频扫描',
      description: '用于快速扫观察池',
      config: {
        defaultReportType: 'brief',
        maxConcurrentTasks: 4,
        aiSummaryEnabled: false,
      },
    });

    expect(created.ok).toBe(true);
    expect(created.preset.id).toMatch(/^custom-/);
    expect(created.preset.values).toMatchObject({
      defaultReportType: 'brief',
      defaultStrategyPreset: 'bull_trend',
      maxConcurrentTasks: 4,
      aiSummaryEnabled: false,
      historyDays: 180,
    });

    const listed = (await service.listConfigPresets()).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.preset.id,
      title: '高频扫描',
      description: '用于快速扫观察池',
    });

    const updated = await service.saveConfigPreset({
      id: created.preset.id,
      title: '高频扫描 v2',
      config: {
        defaultReportType: 'standard',
        maxConcurrentTasks: 3,
      },
    });
    expect(updated.preset).toMatchObject({
      id: created.preset.id,
      title: '高频扫描 v2',
    });
    expect(updated.preset.values).toMatchObject({
      defaultReportType: 'standard',
      defaultStrategyPreset: 'bull_trend',
      maxConcurrentTasks: 3,
      aiSummaryEnabled: true,
    });

    expect((await service.listConfigPresets()).items).toHaveLength(1);

    expect(await service.deleteConfigPreset(created.preset.id)).toEqual({
      ok: true,
    });
    expect((await service.listConfigPresets()).items).toHaveLength(0);
  });

  it('rejects invalid custom config preset requests', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await expect(
      service.saveConfigPreset({
        title: '',
        config: {
          defaultMarketScope: 'cn',
        },
      }),
    ).rejects.toThrow('预设名称不能为空');

    await expect(
      service.saveConfigPreset({
        id: 'balanced',
        title: '冲突预设',
        config: {
          defaultMarketScope: 'cn',
        },
      }),
    ).rejects.toThrow('预设 ID 与内置预设冲突');

    await expect(
      service.saveConfigPreset({
        title: '非法预设',
        config: {
          maxConcurrentTasks: 99,
        },
      }),
    ).rejects.toThrow('并发任务数 不能大于 4');

    await expect(service.deleteConfigPreset('balanced')).rejects.toThrow(
      '内置预设不支持删除',
    );
  });

  it('accepts extended market and strategy defaults when analyzing without explicit overrides', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 150 + index * 0.9,
    );
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes('/AAPL?') && !url.includes('/AAPL&')) {
        throw new Error(`Unexpected URL ${url}`);
      }
      return new Response(
        JSON.stringify(createChartPayload('AAPL', 'Apple', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateText: async () =>
        '{"headline":"AI 总结","analysisSummary":"AI 分析摘要","operationAdvice":"观察跟踪","riskSignals":["波动仍高"],"catalystSignals":["趋势修复中"]}',
      generateNewsIntel: async () =>
        '{"summary":"美股龙头维持趋势结构，消息面中性偏正向。","hotTopics":["科技龙头"],"bullishSignals":["趋势保持完整。"],"riskSignals":["高位波动可能放大。"],"confidence":"medium","references":[]}',
    });

    const initialConfig = await service.getConfig();
    await service.updateConfig({
      configVersion: initialConfig.configVersion,
      config: {
        defaultMarketScope: 'all',
        marketReviewScope: 'all',
        defaultStrategyPreset: 'ma_golden_cross',
      },
    });

    const latestConfig = (await service.getConfig()).config;
    expect(latestConfig.defaultMarketScope).toBe('all');
    expect(latestConfig.marketReviewScope).toBe('all');
    expect(latestConfig.defaultStrategyPreset).toBe('ma_golden_cross');

    const result = await service.analyze({
      stockCodes: ['AAPL.US'],
      reportType: 'standard',
    });
    expect(result.accepted).toHaveLength(1);

    await service.waitForIdle();

    const tasks = (await service.listTasks()).tasks;
    expect(tasks[0]).toMatchObject({
      stockCode: 'US.AAPL',
      market: 'us',
      strategyPreset: 'ma_golden_cross',
      status: 'completed',
    });

    const history = await service.listHistory({ limit: 10 });
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({
      stockCode: 'US.AAPL',
      market: 'us',
    });

    const detail = await service.getHistoryDetail(history.items[0]!.id);
    expect(detail).toMatchObject({
      stockCode: 'US.AAPL',
      market: 'us',
      strategy: expect.objectContaining({
        id: 'ma_golden_cross',
        label: '均线金叉',
      }),
    });
  });

  it('keeps reusable reports isolated by strategy preset', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 30 + index * 0.12,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'bull_trend',
    });
    await service.waitForIdle();

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'volume_breakout',
    });
    await service.waitForIdle();

    const third = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'bull_trend',
    });

    expect(third.accepted[0]?.resultMode).toBe('reused');
    expect(countMarketDataRequests(fetchImpl)).toBe(2);
  });

  it('creates a new report when strategy tuning config changes', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 24 + index * 0.18,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'bull_trend',
    });
    await service.waitForIdle();

    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        bullTrendTrendBonus: 4,
      },
    });

    const second = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'bull_trend',
    });
    await service.waitForIdle();

    expect(second.accepted[0]?.resultMode).toBe('generated');
    expect(countMarketDataRequests(fetchImpl)).toBe(2);

    const latest = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(latest?.strategy.tuningNotes.join(' ')).toContain('趋势额外加分 4');
  });

  it('adds, lists, and removes watchlist entries', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const added = await service.addWatchlist({
      stockCodes: ['600519', '00700'],
      marketScope: 'both',
    });

    expect(added.rejected).toHaveLength(0);
    expect(added.items).toHaveLength(2);

    const list = (await service.listWatchlist()).items;
    expect(list.map((item) => item.stockCode)).toEqual(
      expect.arrayContaining(['600519', 'HK00700']),
    );

    await service.removeWatchlist('HK00700');

    const afterDelete = (await service.listWatchlist()).items;
    expect(afterDelete.map((item) => item.stockCode)).toEqual(['600519']);
  });

  it('removes watchlist entries using equivalent stock code formats', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await service.addWatchlist({
      stockCodes: ['00700', '600519'],
      marketScope: 'both',
    });

    await service.removeWatchlist('00700.HK');
    expect(
      (await service.listWatchlist()).items.map((item) => item.stockCode),
    ).toEqual(['600519']);

    await service.addWatchlist({
      stockCodes: ['00700'],
      marketScope: 'both',
    });
    await service.removeWatchlist('00700');
    expect(
      (await service.listWatchlist()).items.map((item) => item.stockCode),
    ).toEqual(['600519']);
  });

  it('reports invalid watchlist entries without failing the whole batch', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    const result = await service.addWatchlist({
      stockCodes: ['600519', 'bad-code'],
      marketScope: 'cn',
    });

    expect(result.items).toHaveLength(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        stockCode: 'bad-code',
      }),
    ]);
    expect((await service.listWatchlist()).items).toHaveLength(1);
  });

  it('keeps config unchanged when a batched update fails validation', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await expect(
      service.updateConfig({
        configVersion: (await service.getConfig()).configVersion,
        config: {
          defaultMarketScope: 'hk',
          maxConcurrentTasks: 99,
        },
      }),
    ).rejects.toThrow('并发任务数 不能大于 4');

    const latestConfig = await service.getConfig();
    expect(latestConfig.config.defaultMarketScope).toBe('both');
    expect(latestConfig.config.maxConcurrentTasks).toBe(2);
  });

  it('uses configured history window when requesting market data', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 30 + index * 0.1,
    );
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      expect(url).toContain('range=1y');
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        historyDays: 365,
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });

    await service.waitForIdle();
    expect(countMarketDataRequests(fetchImpl)).toBe(1);
  });

  it('supports ema moving averages when configured', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 20 + index * 0.45 + ((index % 6) - 2) * 0.7,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        maType: 'ema',
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const detail = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    const expectedMa20 = computeExpectedEma(closes, 20);
    const sma20 =
      closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;

    expect(detail?.strategy.tuningNotes).toContain('均线类型 EMA');
    expect(detail?.metrics.ma20).toBeCloseTo(expectedMa20 ?? 0, 2);
    expect(detail?.details.recentBars.at(-1)?.ma20).toBeCloseTo(expectedMa20 ?? 0, 2);
    expect(detail?.metrics.ma20).not.toBeCloseTo(sma20, 2);
    expect(detail?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'technical_analysis',
        note: 'maType: ema',
      }),
    );
  });

  it('scales bias safety threshold tighter in ema mode', async () => {
    const { resolveBiasSafetyThreshold } =
      await import('./stock-analysis-service.js');

    expect(
      resolveBiasSafetyThreshold({
        biasSafetyThresholdPct: 5,
        maType: 'sma',
      }),
    ).toBe(5);
    expect(
      resolveBiasSafetyThreshold({
        biasSafetyThresholdPct: 5,
        maType: 'ema',
      }),
    ).toBe(4.1);
    expect(
      resolveBiasSafetyThreshold({
        biasSafetyThresholdPct: 0,
        maType: 'ema',
      }),
    ).toBe(0);
  });

  it('backfills legacy strategy cache keys with an sma ma tag by default', async () => {
    const { normalizeStrategyInfo } =
      await import('./stock-analysis-normalize.js');

    expect(
      normalizeStrategyInfo({
        id: 'bull_trend',
        cacheKey: 'bull_trend|tb:2|mb:1',
        tuningNotes: [],
      }).cacheKey,
    ).toBe('bull_trend|tb:2|mb:1|ma:sma');
    expect(
      normalizeStrategyInfo({
        id: 'bull_trend',
        cacheKey: 'bull_trend|tb:2|mb:1',
        tuningNotes: ['均线类型 EMA'],
      }).cacheKey,
    ).toBe('bull_trend|tb:2|mb:1|ma:ema');
  });

  it('applies a tighter bias safety downgrade in ema mode', async () => {
    const { buildHeuristicAssessment } =
      await import('./stock-analysis-service.js');

    const heuristic = buildHeuristicAssessment(
      '600519',
      '贵州茅台',
      {
        currentPrice: 100,
        previousClose: 97.5,
        changePct: 2.56,
        ma5: 95.88,
        ma10: 94.6,
        biasToMa5: 4.3,
        biasToMa20: 6.38,
        ma20: 94,
        ma60: 89,
        high20: 102,
        low20: 88,
        maAligned: true,
        macdDiff: 1.1,
        macdSignal: 0.8,
        macdHistogram: 0.3,
        macdState: 'bullish_above_zero',
        rsi6: 68,
        rsi12: 63,
        rsi14: 61,
        rsi24: 57,
        rsiState: 'strong',
        momentum20: 12.5,
        annualizedVolatility: 22,
        volumeRatio5d20d: 1.25,
        volumeState: 'increased_volume',
        trendState: 'strong_bullish',
        return60d: 15,
        bollingerUpper: 101,
        bollingerLower: 87,
        bollingerWidth: 14.9,
        atr14: 2.1,
      },
      [
        {
          key: 'trend',
          title: '趋势结构',
          score: 28,
          maxScore: 30,
          signal: 'positive',
          summary: '趋势延续。',
        },
        {
          key: 'bias',
          title: '位置节奏',
          score: 12,
          maxScore: 20,
          signal: 'neutral',
          summary: '位置略偏高。',
        },
        {
          key: 'volume',
          title: '量能确认',
          score: 12,
          maxScore: 15,
          signal: 'positive',
          summary: '量能配合。',
        },
        {
          key: 'macd',
          title: 'MACD',
          score: 14,
          maxScore: 15,
          signal: 'positive',
          summary: '动能偏强。',
        },
        {
          key: 'rsi',
          title: 'RSI',
          score: 8,
          maxScore: 10,
          signal: 'positive',
          summary: '强势但未过热。',
        },
        {
          key: 'setup',
          title: '空间与支撑',
          score: 6,
          maxScore: 10,
          signal: 'neutral',
          summary: '支撑尚可。',
        },
        {
          key: 'catalyst',
          title: '题材催化',
          score: 8,
          maxScore: 10,
          signal: 'positive',
          summary: '催化偏正向。',
        },
      ],
      {
        id: 'bull_trend',
        label: '多头趋势',
        description: 'test',
        cacheKey: 'bull_trend|tb:2|mb:1|ma:ema',
        tuningNotes: ['均线类型 EMA'],
      },
      {
        status: 'disabled',
        sourceType: 'none',
        sourceLabel: 'disabled',
        usedExternalSearch: false,
        generatedAt: null,
        confidence: 'low',
        summary: '',
        hotTopics: [],
        bullishSignals: [],
        riskSignals: [],
        references: [],
        evidence: [],
        evidenceStats: {
          total: 0,
          included: 0,
          dropped: 0,
          stale: 0,
          undated: 0,
          lowQuality: 0,
        },
      },
      [90, 91, 92, 94, 95, 96, 97, 98, 99, 100],
      Array.from({ length: 10 }, () => 1_000_000),
      {
        maType: 'ema',
        biasSafetyThresholdPct: 5,
      },
    );

    expect(heuristic.score).toBeGreaterThanOrEqual(72);
    expect(heuristic.recommendation).toBe('继续观察');
    expect(heuristic.summary.riskSignals.join(' ')).toContain('EMA5 偏离');
    expect(heuristic.summary.riskSignals.join(' ')).toContain('安全阈值 4.1%');
    expect(heuristic.summary.riskSignals.join(' ')).toContain('自动降级为观察');
  });

  it('reuses legacy sma reports whose cache key predates ma tagging', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();
    const createdAt = new Date().toISOString();

    await db.createStockAnalysisReport({
      id: 'legacy-sma-reuse',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 77,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 123.45,
      change_pct: 1.2,
      data_as_of: createdAt,
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'legacy reuse',
        analysisSummary: 'legacy reuse',
        operationAdvice: 'legacy reuse',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'bull_trend',
          label: '多头趋势',
          description: 'legacy',
          cacheKey: 'bull_trend|tb:2|mb:1',
          tuningNotes: [],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: {
          currentPrice: 123.45,
        },
        details: {},
      }),
      model_used: null,
      created_at: createdAt,
    });

    const result = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
      strategyPreset: 'bull_trend',
    });

    expect(result.accepted[0]?.resultMode).toBe('reused');
    expect((await service.listHistory()).total).toBe(1);
  });

  it('reuses a recent report when force refresh is disabled', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 40 + index * 0.1,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
    });
    await service.waitForIdle();

    const second = await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
    });

    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(1);
    expect(second.rejected).toHaveLength(0);
    expect(countMarketDataRequests(fetchImpl)).toBe(1);

    const tasks = (await service.listTasks()).tasks;
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.resultMode).toBe('reused');
    expect(tasks[0]?.reportId).toBe(tasks[1]?.reportId);

    const history = await service.listHistory();
    expect(history.total).toBe(1);
  });

  it('warms multi-stock realtime quotes before queued analysis starts', async () => {
    let batchRealtimeCalls = 0;
    let singleRealtimeCalls = 0;
    const hkBars = Array.from({ length: 90 }, (_item, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index));
      const close = 530 + index * 1.2;
      return [
        date.toISOString().slice(0, 10),
        close - 3,
        close,
        close + 2,
        close - 4,
        12000000 + index * 80000,
      ] as const;
    });
    const cnBars = Array.from({ length: 90 }, (_item, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index));
      const close = 1400 + index * 2.5;
      return [
        date.toISOString().slice(0, 10),
        close - 5,
        close,
        close + 3,
        close - 6,
        900000 + index * 12000,
      ] as const;
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('qt.gtimg.cn')) {
        if (url.includes(',')) {
          batchRealtimeCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(
            [
              'v_sh600519="51~贵州茅台~600519~1523.88~1501.00~1502.00";',
              'v_hk00700="100~腾讯控股~00700~530.50~522.00~523.00";',
            ].join('\n'),
            { headers: { 'Content-Type': 'text/plain; charset=gbk' } },
          );
        }
        singleRealtimeCalls += 1;
        return new Response('unexpected single realtime request', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.includes('push2his.eastmoney.com')) {
        if (url.includes('116.00700')) {
          return new Response(
            JSON.stringify(
              createEastmoneyKlinePayload('00700', '腾讯控股', hkBars),
            ),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify(
            createEastmoneyKlinePayload('600519', '贵州茅台', cnBars),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response('unexpected url', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['600519', '00700'],
      marketScope: 'both',
      reportType: 'standard',
    });
    await service.waitForIdle();

    expect(batchRealtimeCalls).toBe(1);
    expect(singleRealtimeCalls).toBe(0);
    expect((await service.listHistory()).total).toBe(2);
  });

  it('filters task summaries by status and limit', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 80 + index * 0.2,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
    });
    await service.waitForIdle();

    expect(
      (await service.listTasks({ statuses: ['completed'], limit: 1 })).tasks,
    ).toHaveLength(1);
    expect(
      (await service.listTasks({ statuses: ['pending'] })).tasks,
    ).toHaveLength(0);
  });

  it('falls back to domestic provider for Hong Kong stocks under legacy yahoo-first config', async () => {
    const hkBars = Array.from({ length: 90 }, (_item, index) => {
      const date = new Date(Date.UTC(2025, 11, 1 + index));
      const isoDate = date.toISOString().slice(0, 10);
      const open = 500 + index * 1.8;
      const close = open + 4;
      return [
        isoDate,
        open,
        close,
        close + 2,
        open - 2,
        10_000_000 + index * 15_000,
      ] as const;
    });

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('query1.finance.yahoo.com')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (url.includes('push2his.eastmoney.com')) {
        return new Response(
          JSON.stringify(
            createEastmoneyKlinePayload('00700', '腾讯控股', hkBars),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('upstream unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const currentConfig = await service.getConfig();
    await service.updateConfig({
      configVersion: currentConfig.configVersion,
      config: {
        ...currentConfig.config,
        dataProvider: 'yahoo',
        dataProviderPriority: 'yahoo,efinance,akshare',
      },
    });

    await service.analyze({
      stockCodes: ['00700'],
      marketScope: 'hk',
      reportType: 'standard',
    });
    await service.waitForIdle();

    const history = await service.listHistory();
    expect(history.total).toBe(1);
    expect(
      (await service.listTasks({ statuses: ['failed'] })).tasks,
    ).toHaveLength(0);
    const detail = await service.getHistoryDetail(history.items[0]!.id);
    expect(detail?.dataSource).toMatchObject({
      providerId: 'akshare',
      providerLabel: 'AKShare (国内源)',
      symbol: '00700',
    });
    expect(detail?.dataSource.failoverTrace).toEqual([
      'AKShare (国内源): 成功',
    ]);
  });

  it('creates a new report when force refresh is enabled', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 50 + index * 0.1,
    );
    const hkBars = closes.map((close, index) => {
      const date = new Date(Date.UTC(2025, 10, 1 + index));
      const isoDate = date.toISOString().slice(0, 10);
      const open = index === 0 ? close - 0.2 : closes[index - 1]!;
      return [
        isoDate,
        Number(open.toFixed(2)),
        Number(close.toFixed(2)),
        Number((Math.max(close, open) + 0.8).toFixed(2)),
        Number((Math.min(close, open) - 0.8).toFixed(2)),
        10_000_000 + index * 125_000,
      ] as const;
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('push2his.eastmoney.com')) {
        return new Response(
          JSON.stringify(
            createEastmoneyKlinePayload('00700', '腾讯控股', hkBars),
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify(createChartPayload('00700.HK', '腾讯控股', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['00700'],
      marketScope: 'hk',
      reportType: 'standard',
    });
    await service.waitForIdle();

    await service.analyze({
      stockCodes: ['00700'],
      marketScope: 'hk',
      reportType: 'standard',
      forceRefresh: true,
    });
    await service.waitForIdle();

    expect(countMarketDataRequests(fetchImpl)).toBe(2);
    expect((await service.listHistory()).total).toBe(2);
  });

  it('retries failed tasks with their original strategy preset', async () => {
    const bars = Array.from({ length: 120 }, (_item, index) => {
      const date = new Date(Date.UTC(2026, 0, 1 + index));
      const isoDate = date.toISOString().slice(0, 10);
      const open = 45 + index * 0.2;
      const close = open + 0.6;
      return [
        isoDate,
        Number(open.toFixed(2)),
        Number(close.toFixed(2)),
        Number((close + 0.8).toFixed(2)),
        Number((open - 0.8).toFixed(2)),
        1_000_000 + index * 10_000,
      ] as const;
    });
    let shouldFail = true;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (shouldFail) {
        return new Response('upstream unavailable', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      const url = String(input);
      if (url.includes('qt.gtimg.cn')) {
        return new Response(
          'v_sh600519="51~贵州茅台~600519~69.80~68.20~68.20";',
          { headers: { 'Content-Type': 'text/plain; charset=gbk' } },
        );
      }
      return new Response(
        JSON.stringify(createEastmoneyKlinePayload('600519', '贵州茅台', bars)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      strategyPreset: 'volume_breakout',
    });
    await service.waitForIdle();

    const failedTask = (await service.listTasks({ statuses: ['failed'] }))
      .tasks[0];
    expect(failedTask).toMatchObject({
      stockCode: '600519',
      status: 'failed',
      strategyPreset: 'volume_breakout',
    });

    shouldFail = false;
    const retry = await service.retryTask(failedTask!.id);
    expect(retry.accepted[0]).toMatchObject({
      stockCode: '600519',
      strategyPreset: 'volume_breakout',
      status: 'pending',
    });

    await service.waitForIdle();

    const history = await service.listHistory();
    const detail = await service.getHistoryDetail(history.items[0]!.id);
    expect(detail?.strategy.id).toBe('volume_breakout');
    expect(detail?.dataSource).toMatchObject({
      providerId: 'akshare',
      priceSource: 'realtime_quote',
      priceSourceLabel: '腾讯实时行情覆盖',
    });
  });

  it('creates a new report when cache ttl is disabled', async () => {
    const closes = Array.from(
      { length: 120 },
      (_item, index) => 60 + index * 0.1,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        reportCacheTtlMinutes: 0,
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
    });
    await service.waitForIdle();

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
      reportType: 'standard',
    });
    await service.waitForIdle();

    expect(countMarketDataRequests(fetchImpl)).toBe(2);
    expect((await service.listHistory()).total).toBe(2);
  });

  it('builds strategy feedback snapshot from local history reports', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await db.createStockAnalysisReport({
      id: 'feedback-r1',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 82,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 100,
      change_pct: 2,
      data_as_of: '2026-03-01T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'r1',
        analysisSummary: 'r1',
        operationAdvice: 'r1',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'bull_trend',
          label: '多头趋势',
          description: '优先寻找均线多头、趋势延续和顺势跟踪机会。',
          cacheKey: 'bull_trend|tb:2|mb:1',
          tuningNotes: ['趋势额外加分 2'],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: {
          currentPrice: 100,
        },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-01T00:00:00.000Z',
    });
    await db.createStockAnalysisReport({
      id: 'feedback-r2',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 78,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 106,
      change_pct: 1,
      data_as_of: '2026-03-06T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'r2',
        analysisSummary: 'r2',
        operationAdvice: 'r2',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'bull_trend',
          label: '多头趋势',
          description: '优先寻找均线多头、趋势延续和顺势跟踪机会。',
          cacheKey: 'bull_trend|tb:2|mb:1',
          tuningNotes: ['趋势额外加分 2'],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: {
          currentPrice: 106,
        },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-06T00:00:00.000Z',
    });
    await db.createStockAnalysisReport({
      id: 'feedback-r3',
      stock_code: '00700',
      market: 'hk',
      stock_name: '腾讯控股',
      report_type: 'standard',
      score: 55,
      trend: 'neutral',
      recommendation: '继续观察',
      current_price: 200,
      change_pct: -1,
      data_as_of: '2026-03-02T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'r3',
        analysisSummary: 'r3',
        operationAdvice: 'r3',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'volume_breakout',
          label: '放量突破',
          description: '优先寻找放量突破关键压力位后的跟随机会。',
          cacheKey: 'volume_breakout|vr:1.2|rm:-2',
          tuningNotes: ['放量阈值 1.2 倍'],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '00700.HK',
          interval: '1d',
        },
        metrics: {
          currentPrice: 200,
        },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-02T00:00:00.000Z',
    });
    await db.createStockAnalysisReport({
      id: 'feedback-r4',
      stock_code: '00700',
      market: 'hk',
      stock_name: '腾讯控股',
      report_type: 'standard',
      score: 58,
      trend: 'neutral',
      recommendation: '继续观察',
      current_price: 192,
      change_pct: -2,
      data_as_of: '2026-03-08T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'r4',
        analysisSummary: 'r4',
        operationAdvice: 'r4',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'volume_breakout',
          label: '放量突破',
          description: '优先寻找放量突破关键压力位后的跟随机会。',
          cacheKey: 'volume_breakout|vr:1.2|rm:-2',
          tuningNotes: ['放量阈值 1.2 倍'],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '00700.HK',
          interval: '1d',
        },
        metrics: {
          currentPrice: 192,
        },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-08T00:00:00.000Z',
    });

    const snapshot = await service.getFeedbackSnapshot({ lookaheadDays: 10 });

    expect(snapshot.summary.sampleSize).toBe(4);
    expect(snapshot.summary.evaluatedCount).toBe(2);
    expect(snapshot.summary.bullishSampleSize).toBe(2);
    expect(snapshot.summary.bullishWinRate).toBe(100);
    expect(snapshot.strategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: expect.objectContaining({ id: 'bull_trend' }),
          evaluatedCount: 1,
          bullishWinRate: 100,
        }),
        expect.objectContaining({
          strategy: expect.objectContaining({ id: 'volume_breakout' }),
          evaluatedCount: 1,
          avgReturnPct: -4,
        }),
      ]),
    );
    expect(snapshot.recentEvaluations[0]).toMatchObject({
      stockCode: '00700',
      outcome: 'loss',
    });
  });

  it('normalizes legacy metrics when history records are incomplete', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await db.createStockAnalysisReport({
      id: 'legacy-metrics',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 50,
      trend: 'neutral',
      recommendation: '继续观察',
      current_price: 123.45,
      change_pct: 1.23,
      data_as_of: '2026-03-10T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'legacy',
        analysisSummary: 'legacy',
        operationAdvice: 'legacy',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'bull_trend',
          label: '多头趋势',
          description: '简化策略',
          cacheKey: 'bull_trend|tb:2|mb:1',
          tuningNotes: [],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: {
          macdState: 'unknown_state',
          rsiState: 'pumping',
          volumeState: 'explosive',
          trendState: 'super_bullish',
        },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-10T00:00:00.000Z',
    });

    const detail = await service.getHistoryDetail('legacy-metrics');
    expect(detail).not.toBeNull();
    const metrics = detail!.metrics;
    expect(metrics.currentPrice).toBe(123.45);
    expect(metrics.previousClose).toBeNull();
    expect(metrics.changePct).toBe(1.23);
    expect(metrics.ma5).toBeNull();
    expect(metrics.ma10).toBeNull();
    expect(metrics.biasToMa5).toBeNull();
    expect(metrics.biasToMa20).toBeNull();
    expect(metrics.ma20).toBeNull();
    expect(metrics.ma60).toBeNull();
    expect(metrics.high20).toBeNull();
    expect(metrics.low20).toBeNull();
    expect(metrics.macdDiff).toBeNull();
    expect(metrics.macdSignal).toBeNull();
    expect(metrics.macdHistogram).toBeNull();
    expect(metrics.maAligned).toBe(false);
    expect(metrics.macdState).toBe('neutral');
    expect(metrics.rsi6).toBeNull();
    expect(metrics.rsi12).toBeNull();
    expect(metrics.rsi14).toBeNull();
    expect(metrics.rsi24).toBeNull();
    expect(metrics.rsiState).toBe('neutral');
    expect(metrics.momentum20).toBeNull();
    expect(metrics.annualizedVolatility).toBeNull();
    expect(metrics.volumeRatio5d20d).toBeNull();
    expect(metrics.volumeState).toBe('normal');
    expect(metrics.trendState).toBe('neutral');
    expect(metrics.return60d).toBeNull();
    expect(metrics.bollingerUpper).toBeNull();
    expect(metrics.bollingerLower).toBeNull();
    expect(metrics.bollingerWidth).toBeNull();
    expect(metrics.atr14).toBeNull();
  });

  it('validates next-trading-day match for a historical report', async () => {
    const db = await import('../db.js');
    const closes = Array.from({ length: 90 }, (_item, index) =>
      index === 88 ? 100 : index === 89 ? 104 : 80 + index * 0.2,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await db.createStockAnalysisReport({
      id: 'validation-r1',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 82,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 100,
      change_pct: 1.2,
      data_as_of: new Date((1_705_000_000 + 88 * 86_400) * 1000).toISOString(),
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'validation',
        analysisSummary: 'validation',
        operationAdvice: 'validation',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: {
          id: 'bull_trend',
          label: '多头趋势',
          description: '优先寻找均线多头、趋势延续和顺势跟踪机会。',
          cacheKey: 'bull_trend|tb:2|mb:1',
          tuningNotes: ['趋势额外加分 2'],
        },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: {
          currentPrice: 100,
        },
        details: {
          factorScores: [
            {
              key: 'trend',
              title: '趋势结构',
              score: 28,
              maxScore: 30,
              signal: 'positive',
              summary: '均线结构较强。',
            },
            {
              key: 'macd',
              title: 'MACD',
              score: 13,
              maxScore: 15,
              signal: 'positive',
              summary: '动能保持偏强。',
            },
          ],
          newsIntel: {
            status: 'ready',
            sourceType: 'provider_web_search',
            sourceLabel: 'Default AI provider Web Search',
            usedExternalSearch: true,
            generatedAt: '2026-03-15T00:00:00.000Z',
            confidence: 'medium',
            summary: '消息面延续偏正向。',
            hotTopics: ['消费修复'],
            bullishSignals: ['资金继续回流。'],
            riskSignals: [],
            references: [],
            evidence: [],
            evidenceStats: {
              total: 0,
              included: 0,
              dropped: 0,
              stale: 0,
              undated: 0,
              lowQuality: 0,
            },
          },
        },
      }),
      model_used: null,
      created_at: new Date().toISOString(),
    });

    const validation = await service.getReportValidation('validation-r1');

    expect(validation).toMatchObject({
      status: 'validated',
      verdict: 'matched',
      nextDayReturnPct: 4,
      nextDayClose: 104,
    });
    expect(validation.matchScore).toBeGreaterThanOrEqual(75);
    expect(validation.reasons.join(' ')).toContain('次日价格延续上行');
  });

  it('falls back to neutral catalyst intel when external news search fails', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel: async () => {
        throw new Error('search unavailable');
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.details.newsIntel).toMatchObject({
      status: 'unavailable',
      usedExternalSearch: false,
      sourceType: 'none',
    });
    expect(report?.details.factorScores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'catalyst',
          signal: 'neutral',
        }),
      ]),
    );
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'news_intel',
        status: 'ok',
        note: expect.stringContaining('fallback: news_intel_unavailable'),
      }),
    );
  });

  it('merges stock-specific and sector catalyst search rounds when both return partial intel', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const generateNewsIntel = vi.fn(async (prompt: string) => {
      if (prompt.includes('Focus: stock_news.')) {
        return '{"summary":"公司层面消息偏正向。","hotTopics":["业绩预期改善"],"bullishSignals":["渠道反馈继续改善。"],"riskSignals":["短线估值不低。"],"peerSignals":["白酒龙头渠道反馈改善，同行预期同步修复。"],"confidence":"medium","references":[{"title":"渠道反馈改善","source":"财联社","publishedAt":"2026-03-18","summary":"机构继续跟踪动销修复。","url":"https://example.com/news-1"}]}';
      }
      return '{"summary":"板块资金回流，题材共振增强。","hotTopics":["消费修复","白酒板块走强"],"bullishSignals":["板块强度提升带来题材催化。"],"riskSignals":[],"relatedSectors":["白酒板块","消费复苏"],"sectorSignals":["白酒板块资金回流，题材共振增强。"],"policySignals":["促消费政策预期继续升温。"],"confidence":"high","references":[{"title":"白酒板块回暖","source":"证券时报","publishedAt":"2026-03-18","summary":"板块热度提升。","url":"https://example.com/news-2"}]}';
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel,
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(generateNewsIntel).toHaveBeenCalledTimes(2);
    expect(report?.details.newsIntel).toMatchObject({
      status: 'ready',
      usedExternalSearch: true,
      confidence: 'high',
    });
    expect(report?.details.newsIntel.summary).toContain('公司层面消息偏正向');
    expect(report?.details.newsIntel.summary).toContain('板块资金回流');
    expect(report?.details.newsIntel.hotTopics).toEqual(
      expect.arrayContaining(['业绩预期改善', '消费修复', '白酒板块走强']),
    );
    expect(report?.details.newsIntel.bullishSignals).toEqual(
      expect.arrayContaining([
        '渠道反馈继续改善。',
        '板块强度提升带来题材催化。',
      ]),
    );
    expect(report?.details.newsIntel.relatedSectors).toEqual(
      expect.arrayContaining(['白酒板块', '消费复苏']),
    );
    expect(report?.details.newsIntel.sectorSignals).toEqual(
      expect.arrayContaining(['白酒板块资金回流，题材共振增强。']),
    );
    expect(report?.details.newsIntel.peerSignals).toEqual(
      expect.arrayContaining(['白酒龙头渠道反馈改善，同行预期同步修复。']),
    );
    expect(report?.details.newsIntel.policySignals).toEqual(
      expect.arrayContaining(['促消费政策预期继续升温。']),
    );
    expect(report?.details.newsIntel.references).toHaveLength(2);
    expect(report?.details.newsIntel.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'provider_reference',
          includedInSummary: true,
        }),
      ]),
    );
    expect(report?.details.newsIntel.evidenceStats).toMatchObject({
      total: 2,
      included: 2,
      dropped: 0,
    });
  });

  it('returns a diagnostic fallback when the default provider does not support web search', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newsFetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel: async () => {
        throw new Error('Default AI provider does not support built-in web search');
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.details.newsIntel).toMatchObject({
      status: 'unavailable',
      sourceLabel: '默认 AI provider 不支持 Web Search',
      usedExternalSearch: false,
    });
    expect(report?.details.newsIntel.summary).toContain('建议切换到支持 Web Search 的 Codex provider');
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'news_intel',
        status: 'ok',
        note: expect.stringContaining('默认 AI provider 不支持 Web Search'),
      }),
    );
  });

  it('uses fallback news feeds when provider web search is unavailable', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const publishedAt = Math.floor(Date.now() / 1000);
    const stalePublishedAt = Math.floor(
      (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000,
    );
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/finance/search')) {
        return new Response(
          JSON.stringify({
            news: [
              {
                title: '白酒板块回暖',
                publisher: 'Yahoo Finance',
                providerPublishTime: publishedAt,
                summary: '板块热度回升，资金回流。',
                link: 'https://example.com/yahoo-news-1',
              },
              {
                title: '渠道反馈改善',
                publisher: 'Yahoo Finance',
                providerPublishTime: publishedAt - 3600,
                summary: '公司层面反馈继续改善。',
                link: 'https://example.com/yahoo-news-2',
              },
              {
                title: '过期旧闻',
                publisher: 'Yahoo Finance',
                providerPublishTime: stalePublishedAt,
                summary: '已经明显过期。',
                link: 'https://example.com/yahoo-news-3',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('600519.SS')) {
        return new Response(
          JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel: async () => {
        throw new Error('Default AI provider does not support built-in web search');
      },
      generateText: async () =>
        '{"summary":"独立新闻源显示公司与板块催化共振。","hotTopics":["白酒板块回暖","渠道反馈改善"],"bullishSignals":["板块热度回升，资金回流。","公司层面反馈继续改善。"],"riskSignals":["短线仍需关注估值波动。"],"relatedSectors":["白酒板块"],"sectorSignals":["白酒板块热度回升，资金回流。"],"peerSignals":["白酒龙头反馈改善后，板块跟随走强。"],"policySignals":["促消费政策预期继续升温。"],"confidence":"medium","references":[]}',
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.details.newsIntel).toMatchObject({
      status: 'ready',
      sourceType: 'fallback_news_feed',
      sourceLabel: 'Yahoo Finance News',
      usedExternalSearch: true,
      confidence: 'medium',
    });
    expect(report?.details.newsIntel.summary).toContain('独立新闻源显示公司与板块催化共振');
    expect(report?.details.newsIntel.hotTopics).toEqual(
      expect.arrayContaining(['白酒板块回暖', '渠道反馈改善']),
    );
    expect(report?.details.newsIntel.relatedSectors).toEqual(
      expect.arrayContaining(['白酒板块']),
    );
    expect(report?.details.newsIntel.sectorSignals).toEqual(
      expect.arrayContaining(['白酒板块热度回升，资金回流。']),
    );
    expect(report?.details.newsIntel.peerSignals).toEqual(
      expect.arrayContaining(['白酒龙头反馈改善后，板块跟随走强。']),
    );
    expect(report?.details.newsIntel.policySignals).toEqual(
      expect.arrayContaining(['促消费政策预期继续升温。']),
    );
    expect(report?.details.newsIntel.references).toHaveLength(2);
    expect(report?.details.newsIntel.evidenceStats).toMatchObject({
      total: 3,
      included: 2,
      dropped: 1,
      stale: 1,
    });
    expect(report?.details.newsIntel.evidence[0]).toMatchObject({
      sourceType: 'fallback_snippet',
      includedInSummary: true,
      fetchedAt: expect.any(String),
    });
    expect(report?.details.newsIntel.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '过期旧闻',
          includedInSummary: false,
          dropReason: 'stale',
        }),
      ]),
    );
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'news_intel',
        status: 'ok',
        note: 'source: fallback_news_feed',
      }),
    );
  });

  it('keeps raw fallback snippets when snippet summarization fails', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const publishedAt = Math.floor(Date.now() / 1000);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/finance/search')) {
        return new Response(
          JSON.stringify({
            news: [
              {
                title: '白酒板块回暖',
                publisher: 'Yahoo Finance',
                providerPublishTime: publishedAt,
                summary: '板块热度回升，资金回流，促消费政策预期升温。',
                link: 'https://example.com/yahoo-news-1',
              },
              {
                title: '白酒龙头渠道反馈改善',
                publisher: 'Yahoo Finance',
                providerPublishTime: publishedAt - 3600,
                summary: '公司层面反馈继续改善，同行预期同步修复。',
                link: 'https://example.com/yahoo-news-2',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('600519.SS')) {
        return new Response(
          JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel: async () => {
        throw new Error('Default AI provider does not support built-in web search');
      },
      generateText: async () => 'not-json',
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.details.newsIntel).toMatchObject({
      status: 'ready',
      sourceType: 'fallback_news_feed',
      sourceLabel: 'Yahoo Finance News',
      usedExternalSearch: true,
      confidence: 'low',
    });
    expect(report?.details.newsIntel.summary).toContain('当前先提供原始催化线索与引用');
    expect(report?.details.newsIntel.hotTopics).toEqual([
      '白酒板块回暖',
      '白酒龙头渠道反馈改善',
    ]);
    expect(report?.details.newsIntel.relatedSectors).toEqual(
      expect.arrayContaining(['白酒板块']),
    );
    expect(report?.details.newsIntel.sectorSignals).toEqual(
      expect.arrayContaining(['白酒板块回暖']),
    );
    expect(report?.details.newsIntel.peerSignals).toEqual(
      expect.arrayContaining(['白酒龙头渠道反馈改善']),
    );
    expect(report?.details.newsIntel.policySignals).toEqual(
      expect.arrayContaining(['板块热度回升，资金回流，促消费政策预期升温。']),
    );
    expect(report?.details.newsIntel.evidenceStats).toMatchObject({
      total: 2,
      included: 2,
      dropped: 0,
    });
    expect(report?.details.newsIntel.references).toEqual([
      expect.objectContaining({
        title: '白酒板块回暖',
        url: 'https://example.com/yahoo-news-1',
      }),
      expect.objectContaining({
        title: '白酒龙头渠道反馈改善',
        url: 'https://example.com/yahoo-news-2',
      }),
    ]);
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'news_intel',
        status: 'ok',
        note: 'source: fallback_news_feed',
      }),
    );
  });

  it('keeps dropped fallback evidence when raw news is stale or undated', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 18 + index * 0.08,
    );
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/finance/search')) {
        return new Response(
          JSON.stringify({
            news: [
              {
                title: '缺少日期的题材传闻',
                publisher: 'Yahoo Finance',
                summary: '只有模糊题材，没有明确发布时间。',
                link: 'https://example.com/yahoo-undated',
              },
              {
                title: '过旧的白酒消息',
                publisher: 'Yahoo Finance',
                providerPublishTime: Math.floor(
                  (Date.now() - 20 * 24 * 60 * 60 * 1000) / 1000,
                ),
                summary: '已经超出观察窗口。',
                link: 'https://example.com/yahoo-stale',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('600519.SS')) {
        return new Response(
          JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateNewsIntel: async () => {
        throw new Error('Default AI provider does not support built-in web search');
      },
      generateText: async () => {
        throw new Error('should not summarize insufficient evidence');
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.details.newsIntel).toMatchObject({
      status: 'unavailable',
      sourceLabel: '独立新闻后备源证据不足',
      usedExternalSearch: false,
    });
    expect(report?.details.newsIntel.evidenceStats).toMatchObject({
      total: 2,
      included: 0,
      dropped: 2,
      stale: 1,
      undated: 1,
    });
    expect(report?.details.newsIntel.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '缺少日期的题材传闻',
          dropReason: 'missing_publish_time',
          includedInSummary: false,
        }),
        expect.objectContaining({
          title: '过旧的白酒消息',
          dropReason: 'stale',
          includedInSummary: false,
        }),
      ]),
    );
  });

  it('degrades gracefully when the fallback news source throws unexpectedly', async () => {
    vi.doMock('./stock-analysis-news-source.js', async () => {
      const actual =
        await vi.importActual<typeof import('./stock-analysis-news-source.js')>(
          './stock-analysis-news-source.js',
        );
      return {
        ...actual,
        fetchFallbackNewsSnippets: vi.fn(async () => {
          throw new Error('fallback source crashed');
        }),
      };
    });

    try {
      const closes = Array.from(
        { length: 90 },
        (_item, index) => 18 + index * 0.08,
      );
      const fetchImpl = vi.fn(async () => {
        return new Response(
          JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      });

      const { StockAnalysisService } =
        await import('./stock-analysis-service.js');
      const service = new StockAnalysisService({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        generateNewsIntel: async () => {
          throw new Error('web search upstream unavailable');
        },
      });

      await service.analyze({
        stockCodes: ['600519'],
        marketScope: 'cn',
      });
      await service.waitForIdle();

      const report = await service.getHistoryDetail(
        (await service.listHistory()).items[0]!.id,
      );
      expect(report?.details.newsIntel).toMatchObject({
        status: 'unavailable',
        sourceType: 'none',
        sourceLabel: '独立新闻后备源调用失败',
        usedExternalSearch: false,
      });
      expect(report?.details.newsIntel.summary).toContain('独立新闻后备源调用失败');
      expect(report?.details.pipelineLog).toContainEqual(
        expect.objectContaining({
          stage: 'news_intel',
          status: 'ok',
          note: expect.stringContaining('独立新闻后备源调用失败'),
        }),
      );
      expect((await service.listTasks()).tasks[0]?.status).toBe('completed');
    } finally {
      vi.doUnmock('./stock-analysis-news-source.js');
    }
  });

  it('marks ai summary stage as skipped when ai summary is disabled', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 25 + index * 0.11,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const generateText = vi.fn(async () => {
      throw new Error('should not be called');
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateText,
    });

    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        aiSummaryEnabled: false,
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(generateText).toHaveBeenCalledTimes(0);
    expect(report?.modelUsed).toBeNull();
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'ai_summary',
        status: 'skipped',
        note: 'disabled by config',
      }),
    );
  });

  it('marks ai summary stage as ok with fallback note when provider generation fails', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 26 + index * 0.09,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('600519.SS', '贵州茅台', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      generateText: async () => {
        throw new Error('provider unavailable');
      },
    });

    await service.analyze({
      stockCodes: ['600519'],
      marketScope: 'cn',
    });
    await service.waitForIdle();

    const report = await service.getHistoryDetail(
      (await service.listHistory()).items[0]!.id,
    );
    expect(report?.modelUsed).toBeNull();
    expect(report?.summary.headline).toContain('贵州茅台');
    expect(report?.details.pipelineLog).toContainEqual(
      expect.objectContaining({
        stage: 'ai_summary',
        status: 'ok',
        note: 'fallback: heuristic summary',
      }),
    );
  });

  it('keeps market review available when part of indices fail to fetch', async () => {
    const closes = Array.from({ length: 90 }, (_item, index) => 100 + index * 0.4);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('000001.SS')) {
        return new Response(
          JSON.stringify(createChartPayload('000001.SS', '上证指数', closes)),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('%5EHSI') || url.includes('^HSI')) {
        return new Response('forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await service.updateConfig({
      configVersion: (await service.getConfig()).configVersion,
      config: {
        marketReviewIndicesPerMarket: 1,
      },
    });

    const review = await service.runMarketReview({
      marketScope: 'both',
    });

    expect(review.detail.indices).toHaveLength(1);
    expect(review.detail.indices[0]).toMatchObject({
      symbol: '000001',
      name: '上证指数',
    });
    expect(review.detail.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('有 1 个指数暂不可用：恒生指数'),
      ]),
    );
  });

  it('persists market review trade date metadata', async () => {
    const closes = Array.from(
      { length: 90 },
      (_item, index) => 100 + index * 0.5,
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify(createChartPayload('000001.SS', '上证指数', closes)),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const review = await service.runMarketReview({
      marketScope: 'cn',
    });
    const latest = await service.getLatestMarketReview('cn');

    expect(review.tradeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(review.detail.dataAsOfDates).toContain(review.tradeDate);
    expect(review.detail.indices[0]?.dataAsOf).toMatch(/T/);
    expect(review.detail.indices[0]).toMatchObject({
      providerLabel: 'Yahoo Finance',
      priceSource: 'historical_close',
      priceSourceLabel: '最近一根日线收盘',
    });
    expect(review.detail.notes).toContain('本次复盘价格统一使用最近一根日线收盘口径。');
    expect(latest?.tradeDate).toBe(review.tradeDate);
  });

  it('filters task list by status while keeping the default list unchanged', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();
    const now = new Date().toISOString();

    await db.createStockAnalysisTask({
      id: 'stock-task-pending',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      status: 'pending',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: null,
      data_as_of: null,
      created_at: now,
      started_at: null,
      completed_at: null,
    });
    await db.createStockAnalysisTask({
      id: 'stock-task-running',
      stock_code: '00700',
      market: 'hk',
      stock_name: '腾讯控股',
      status: 'running',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: null,
      data_as_of: null,
      created_at: now,
      started_at: now,
      completed_at: null,
    });
    await db.createStockAnalysisTask({
      id: 'stock-task-completed',
      stock_code: '09988',
      market: 'hk',
      stock_name: '阿里巴巴',
      status: 'completed',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: 'report-1',
      data_as_of: now,
      created_at: now,
      started_at: now,
      completed_at: now,
    });

    expect((await service.listTasks()).tasks).toHaveLength(3);

    const activeTasks = (
      await service.listTasks({
        statuses: ['pending', 'running'],
        limit: 10,
      })
    ).tasks;

    expect(activeTasks).toHaveLength(2);
    expect(activeTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'stock-task-pending', status: 'pending' }),
        expect.objectContaining({ id: 'stock-task-running', status: 'running' }),
      ]),
    );
  });

  it('deletes a single completed task without touching report history', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();
    const now = new Date().toISOString();

    await db.createStockAnalysisReport({
      id: 'history-keep-1',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 80,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 120,
      change_pct: 1.2,
      data_as_of: now,
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'history-keep-1',
        analysisSummary: 'history-keep-1',
        operationAdvice: 'history-keep-1',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: { id: 'bull_trend' },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: { currentPrice: 120 },
        details: {},
      }),
      model_used: null,
      created_at: now,
    });
    await db.createStockAnalysisTask({
      id: 'stock-task-completed-delete',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      status: 'completed',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: 'history-keep-1',
      data_as_of: now,
      created_at: now,
      started_at: now,
      completed_at: now,
    });

    expect((await service.listHistory()).total).toBe(1);
    expect(
      (await service.listTasks({ statuses: ['completed'] })).tasks,
    ).toHaveLength(1);

    expect(await service.deleteTask('stock-task-completed-delete')).toEqual({
      ok: true,
      deleted: 1,
    });
    expect(
      (await service.listTasks({ statuses: ['completed'] })).tasks,
    ).toHaveLength(0);
    expect((await service.listHistory()).total).toBe(1);
  });

  it('rejects deleting running or pending tasks', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();
    const now = new Date().toISOString();

    await db.createStockAnalysisTask({
      id: 'stock-task-pending-delete',
      stock_code: '00700',
      market: 'hk',
      stock_name: '腾讯控股',
      status: 'pending',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: null,
      data_as_of: null,
      created_at: now,
      started_at: null,
      completed_at: null,
    });

    await expect(service.deleteTask('stock-task-pending-delete')).rejects.toThrow(
      '运行中的任务不能删除',
    );
    await expect(service.deleteTask('missing-task')).rejects.toThrow('任务不存在');
  });

  it('clears failed tasks by default while keeping other statuses', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();
    const now = new Date().toISOString();

    await db.createStockAnalysisTask({
      id: 'stock-task-failed-clear',
      stock_code: '09988',
      market: 'hk',
      stock_name: '阿里巴巴',
      status: 'failed',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: 'mock failed',
      report_id: null,
      data_as_of: null,
      created_at: now,
      started_at: now,
      completed_at: now,
    });
    await db.createStockAnalysisTask({
      id: 'stock-task-completed-keep',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      status: 'completed',
      report_type: 'standard',
      strategy_preset: 'bull_trend',
      force_refresh: 0,
      result_mode: 'generated',
      error: null,
      report_id: 'history-keep-2',
      data_as_of: now,
      created_at: now,
      started_at: now,
      completed_at: now,
    });

    expect(await service.clearTasks()).toEqual({ ok: true, deleted: 1 });
    expect(
      (await service.listTasks({ statuses: ['failed'] })).tasks,
    ).toHaveLength(0);
    expect(
      (await service.listTasks({ statuses: ['completed'] })).tasks,
    ).toHaveLength(1);
  });

  it('rejects batch cleanup requests that include active statuses', async () => {
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await expect(
      service.clearTasks({
        statuses: ['failed', 'running'],
      }),
    ).rejects.toThrow('运行中的任务不能批量清理');
    await expect(
      service.clearTasks({
        statuses: ['pending'],
      }),
    ).rejects.toThrow('运行中的任务不能批量清理');
  });

  it('applies history limit, offset, and stock filters consistently', async () => {
    const db = await import('../db.js');
    const { StockAnalysisService } =
      await import('./stock-analysis-service.js');
    const service = new StockAnalysisService();

    await db.createStockAnalysisReport({
      id: 'history-r1',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 70,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 100,
      change_pct: 1,
      data_as_of: '2026-03-01T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'history-r1',
        analysisSummary: 'history-r1',
        operationAdvice: 'history-r1',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: { id: 'bull_trend' },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: { currentPrice: 100 },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-01T00:00:00.000Z',
    });
    await db.createStockAnalysisReport({
      id: 'history-r2',
      stock_code: '00700',
      market: 'hk',
      stock_name: '腾讯控股',
      report_type: 'standard',
      score: 75,
      trend: 'neutral',
      recommendation: '继续观察',
      current_price: 200,
      change_pct: -0.5,
      data_as_of: '2026-03-02T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'history-r2',
        analysisSummary: 'history-r2',
        operationAdvice: 'history-r2',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: { id: 'volume_breakout' },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '00700.HK',
          interval: '1d',
        },
        metrics: { currentPrice: 200 },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-02T00:00:00.000Z',
    });
    await db.createStockAnalysisReport({
      id: 'history-r3',
      stock_code: '600519',
      market: 'cn',
      stock_name: '贵州茅台',
      report_type: 'standard',
      score: 82,
      trend: 'bullish',
      recommendation: '偏强跟踪',
      current_price: 108,
      change_pct: 2.2,
      data_as_of: '2026-03-03T00:00:00.000Z',
      history_days: 180,
      summary_json: JSON.stringify({
        headline: 'history-r3',
        analysisSummary: 'history-r3',
        operationAdvice: 'history-r3',
        riskSignals: [],
        catalystSignals: [],
      }),
      detail_json: JSON.stringify({
        strategy: { id: 'ma_golden_cross' },
        dataSource: {
          providerId: 'yahoo',
          providerLabel: 'Yahoo Finance',
          symbol: '600519.SS',
          interval: '1d',
        },
        metrics: { currentPrice: 108 },
        details: {},
      }),
      model_used: null,
      created_at: '2026-03-03T00:00:00.000Z',
    });

    const firstPage = await service.listHistory({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((item) => item.id)).toEqual([
      'history-r3',
      'history-r2',
    ]);

    const secondPage = await service.listHistory({ limit: 1, offset: 1 });
    expect(secondPage.total).toBe(3);
    expect(secondPage.items.map((item) => item.id)).toEqual(['history-r2']);

    const filtered = await service.listHistory({
      limit: 10,
      offset: 0,
      stockCode: '600519',
    });
    expect(filtered.total).toBe(2);
    expect(filtered.items.map((item) => item.id)).toEqual([
      'history-r3',
      'history-r1',
    ]);
  });
});
