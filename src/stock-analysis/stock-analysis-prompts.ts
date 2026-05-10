/**
 * Stock Analysis Prompt Templates
 *
 * Centralized prompt builders for all AI-assisted analysis steps.
 * Each function takes a typed params object and returns the prompt string.
 * Benefits:
 * - Testable in isolation
 * - Single file to edit for prompt iterations
 * - Versionable and A/B testable
 */

import type {
  StockAnalysisFactorScore,
  StockAnalysisMarket,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsIntel,
  StockAnalysisNewsReference,
  StockAnalysisStrategyInfo,
  StockAnalysisTradePlan,
} from './stock-analysis-types.js';
import { formatStructuredPromptValue } from '../provider/model-serialization.js';
import { resolvePromptText } from '../prompt/prompt-service.js';

/* ──────────── News Intel Prompt ──────────── */

export interface NewsIntelPromptParams {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  metrics: StockAnalysisMetricSnapshot;
  strategy: StockAnalysisStrategyInfo;
  newsLookbackDays: number;
  newsMaxReferences: number;
}

export interface NewsIntelSnippetPromptParams extends NewsIntelPromptParams {
  sourceLabel: string;
  snippets: StockAnalysisNewsReference[];
}

export type NewsIntelPromptFocus = 'stock_news' | 'sector_catalyst';

function formatStockPromptData(value: unknown): string {
  return formatStructuredPromptValue(value, {
    surface: 'stock_analysis_prompt',
  });
}

export async function buildNewsIntelPrompt(
  params: NewsIntelPromptParams,
  focus: NewsIntelPromptFocus = 'stock_news',
): Promise<string> {
  const metricsSubset = {
    currentPrice: params.metrics.currentPrice,
    changePct: params.metrics.changePct,
    ma5: params.metrics.ma5,
    ma10: params.metrics.ma10,
    ma20: params.metrics.ma20,
    ma60: params.metrics.ma60,
    maAligned: params.metrics.maAligned,
    macdDiff: params.metrics.macdDiff,
    macdSignal: params.metrics.macdSignal,
    macdState: params.metrics.macdState,
    rsi14: params.metrics.rsi14,
    rsiState: params.metrics.rsiState,
    volumeState: params.metrics.volumeState,
    trendState: params.metrics.trendState,
  };
  const focusInstruction =
    focus === 'sector_catalyst'
      ? [
          'Focus: sector_catalyst.',
          'Prioritize sector rotation, board/theme moves, policy catalysts, upstream commodity or industry-chain changes, and peer momentum that can affect this stock.',
          'If the stock belongs to multiple concepts, keep only the most relevant 1-2 sector/theme lines.',
        ]
      : [
          'Focus: stock_news.',
          'Prioritize stock-specific news, announcements, earnings, shareholder changes, contracts, lawsuits, regulation, and management signals.',
          'If sector news exists but the stock-specific evidence is weak, say so explicitly instead of fabricating direct catalysts.',
        ];

  const fallbackPrompt = [
    'You are a stock catalyst intelligence assistant.',
    ...focusInstruction,
    'Search the web for recent evidence only. Ignore stale, undated, or unverifiable claims.',
    'Return only JSON with keys: summary, hotTopics, bullishSignals, riskSignals, confidence, references, relatedSectors, sectorSignals, peerSignals, policySignals.',
    'confidence must be one of high, medium, low.',
    'references must be an array of objects with keys: title, source, publishedAt, summary, url.',
    'relatedSectors should list the most relevant boards/themes/industry-chain tags affecting this stock.',
    'sectorSignals should describe board rotation, theme resonance, industry-chain price changes, or capital-flow moves.',
    'peerSignals should capture leader/follower or peer-stock momentum links.',
    'policySignals should capture policy, regulation, subsidy, tariff, meeting, or approval catalysts.',
    `Focus on the most relevant items from the last ${params.newsLookbackDays} days.`,
    `Keep hotTopics and relatedSectors within 4 items, bullishSignals / riskSignals / sectorSignals / peerSignals / policySignals within 3 items, references within ${params.newsMaxReferences} items.`,
    'Every reference must include a concrete publishedAt date in YYYY-MM-DD when possible.',
    `Ignore any item older than ${params.newsLookbackDays} days, and ignore items with unknown publish date if fresher evidence exists.`,
    'If evidence is weak, say so directly and lower confidence.',
    `Stock: ${params.stockName} (${params.stockCode}).`,
    `Market: ${params.market}.`,
    `Strategy: ${params.strategy.label} - ${params.strategy.description}.`,
    `Current metrics:\n${formatStockPromptData(metricsSubset)}`,
    'Use concise Chinese in every field. Avoid price targets and guarantees.',
  ].join('\n');
  const resolved = await resolvePromptText({
    promptKey: 'stock_analysis.news_intel',
    variables: {
      focusInstruction: focusInstruction.join('\n'),
      newsLookbackDays: params.newsLookbackDays,
      newsMaxReferences: params.newsMaxReferences,
      stockName: params.stockName,
      stockCode: params.stockCode,
      market: params.market,
      strategyLabel: params.strategy.label,
      strategyDescription: params.strategy.description,
      metrics: formatStockPromptData(metricsSubset),
    },
    fallbackText: fallbackPrompt,
  });
  return resolved.text;
}

export async function buildNewsIntelSnippetPrompt(
  params: NewsIntelSnippetPromptParams,
): Promise<string> {
  const metrics = formatStockPromptData({
    currentPrice: params.metrics.currentPrice,
    changePct: params.metrics.changePct,
    maAligned: params.metrics.maAligned,
    macdState: params.metrics.macdState,
    rsiState: params.metrics.rsiState,
    volumeState: params.metrics.volumeState,
    trendState: params.metrics.trendState,
  });
  const fallbackPrompt = [
    'You are a stock catalyst intelligence assistant.',
    'Use only the provided news snippets. Do not search the web and do not invent evidence.',
    'Return only JSON with keys: summary, hotTopics, bullishSignals, riskSignals, confidence, references, relatedSectors, sectorSignals, peerSignals, policySignals.',
    'confidence must be one of high, medium, low.',
    'references must be an array of objects with keys: title, source, publishedAt, summary, url.',
    'relatedSectors should list the most relevant boards/themes/industry-chain tags affecting this stock.',
    'sectorSignals should describe board rotation, theme resonance, industry-chain price changes, or capital-flow moves.',
    'peerSignals should capture leader/follower or peer-stock momentum links.',
    'policySignals should capture policy, regulation, subsidy, tariff, meeting, or approval catalysts.',
    `Stock: ${params.stockName} (${params.stockCode}).`,
    `Market: ${params.market}.`,
    `Strategy: ${params.strategy.label} - ${params.strategy.description}.`,
    `Current metrics:\n${metrics}`,
    `News source: ${params.sourceLabel}.`,
    `Only use snippets within the last ${params.newsLookbackDays} days and prefer the most recent evidence.`,
    `Keep hotTopics and relatedSectors within 4 items, bullishSignals / riskSignals / sectorSignals / peerSignals / policySignals within 3 items, references within ${params.newsMaxReferences} items.`,
    'Use concise Chinese in every field. If evidence is mixed, say so directly and lower confidence.',
    `News snippets:\n${formatStockPromptData(params.snippets)}`,
  ].join('\n');
  const resolved = await resolvePromptText({
    promptKey: 'stock_analysis.news_intel_snippet',
    variables: {
      stockName: params.stockName,
      stockCode: params.stockCode,
      market: params.market,
      strategyLabel: params.strategy.label,
      strategyDescription: params.strategy.description,
      metrics,
      sourceLabel: params.sourceLabel,
      newsLookbackDays: params.newsLookbackDays,
      newsMaxReferences: params.newsMaxReferences,
      snippets: formatStockPromptData(params.snippets),
    },
    fallbackText: fallbackPrompt,
  });
  return resolved.text;
}

/* ──────────── AI Summary Prompt ──────────── */

export interface AiSummaryPromptParams {
  stockCode: string;
  stockName: string;
  market: StockAnalysisMarket;
  metrics: StockAnalysisMetricSnapshot;
  strategy: StockAnalysisStrategyInfo;
  aiSummaryStyle: string;
  heuristic: {
    score: number;
    trend: string;
    recommendation: string;
    riskSignals: string[];
    catalystSignals: string[];
  };
  factorScores: StockAnalysisFactorScore[];
  tradePlan: StockAnalysisTradePlan;
  newsIntel: StockAnalysisNewsIntel;
}

export async function buildAiSummaryPrompt(
  params: AiSummaryPromptParams,
): Promise<string> {
  const fallbackPrompt = [
    'You are a professional stock analysis summarizer with deep knowledge of Chinese A-share, Hong Kong, and US markets.',
    'Return only JSON with keys: headline, analysisSummary, operationAdvice, riskSignals, catalystSignals.',
    'IMPORTANT: Your output must be valid JSON. Do not include any text outside the JSON object.',
    `Tone: ${params.aiSummaryStyle}.`,
    `Market: ${params.market}.`,
    `Stock: ${params.stockName} (${params.stockCode}).`,
    `Strategy: ${params.strategy.label} - ${params.strategy.description}.`,
    `Metrics:\n${formatStockPromptData(params.metrics)}`,
    `Heuristic:\n${formatStockPromptData({
      score: params.heuristic.score,
      trend: params.heuristic.trend,
      trendState: params.metrics.trendState,
      maAligned: params.metrics.maAligned,
      volumeState: params.metrics.volumeState,
      macdState: params.metrics.macdState,
      rsiState: params.metrics.rsiState,
      recommendation: params.heuristic.recommendation,
      riskSignals: params.heuristic.riskSignals,
      catalystSignals: params.heuristic.catalystSignals,
    })}`,
    `News catalyst intel:\n${formatStockPromptData(params.newsIntel)}`,
    `Factor scores:\n${formatStockPromptData(params.factorScores)}`,
    `Trade plan:\n${formatStockPromptData(params.tradePlan)}`,
    'Risk checklist: consider major shareholder reduction, earnings surprises, regulatory actions, policy changes, lock-up expiry.',
    'Keep each list within 3 items and avoid investment guarantee language.',
    'Use concise Chinese.',
  ].join('\n');
  const resolved = await resolvePromptText({
    promptKey: 'stock_analysis.ai_summary',
    variables: {
      aiSummaryStyle: params.aiSummaryStyle,
      market: params.market,
      stockName: params.stockName,
      stockCode: params.stockCode,
      strategyLabel: params.strategy.label,
      strategyDescription: params.strategy.description,
      metrics: formatStockPromptData(params.metrics),
      heuristic: formatStockPromptData({
        score: params.heuristic.score,
        trend: params.heuristic.trend,
        trendState: params.metrics.trendState,
        maAligned: params.metrics.maAligned,
        volumeState: params.metrics.volumeState,
        macdState: params.metrics.macdState,
        rsiState: params.metrics.rsiState,
        recommendation: params.heuristic.recommendation,
        riskSignals: params.heuristic.riskSignals,
        catalystSignals: params.heuristic.catalystSignals,
      }),
      newsIntel: formatStockPromptData(params.newsIntel),
      factorScores: formatStockPromptData(params.factorScores),
      tradePlan: formatStockPromptData(params.tradePlan),
    },
    fallbackText: fallbackPrompt,
  });
  return resolved.text;
}

/* ──────────── Market Review Prompt ──────────── */

export interface MarketReviewPromptParams {
  reviewData: unknown;
}

export async function buildMarketReviewPrompt(
  params: MarketReviewPromptParams,
): Promise<string> {
  const fallbackPrompt = [
    'You are a market review summarizer.',
    'Return only JSON with keys: headline, overview, stance, keySignals.',
    `Input:\n${formatStockPromptData(params.reviewData)}`,
  ].join('\n');
  const resolved = await resolvePromptText({
    promptKey: 'stock_analysis.market_review',
    variables: {
      reviewData: formatStockPromptData(params.reviewData),
    },
    fallbackText: fallbackPrompt,
  });
  return resolved.text;
}
