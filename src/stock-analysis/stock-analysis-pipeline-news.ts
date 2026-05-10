/**
 * Stock analysis news intelligence pipeline: evidence scoring, structured intel,
 * web-search / fallback feed orchestration.
 */

import type { StockAnalysisConfigMap } from './stock-analysis-config.js';
import {
  generateTextWithDefaultProvider,
  generateWebSearchTextWithDefaultProvider,
} from '../provider/provider-api.js';
import {
  buildNewsIntelPrompt,
  buildNewsIntelSnippetPrompt,
} from './stock-analysis-prompts.js';
import {
  extractJsonObject,
  normalizeNewsIntelPayload,
} from './stock-analysis-normalize.js';
import { fetchFallbackNewsSnippets } from './stock-analysis-news-source.js';
import type {
  PipelineStageLog,
  StockAnalysisMarket,
  StockAnalysisMetricSnapshot,
  StockAnalysisNewsEvidence,
  StockAnalysisNewsIntel,
  StockAnalysisNewsReference,
  StockAnalysisStrategyInfo,
} from './stock-analysis-types.js';
import { t } from '../i18n/index.js';

export function resolveNewsStageLog(
  config: StockAnalysisConfigMap,
  newsIntel: StockAnalysisNewsIntel,
): { status: PipelineStageLog['status']; note: string } {
  if (!config.newsIntelEnabled) {
    return {
      status: 'skipped',
      note: 'disabled by config',
    };
  }
  if (newsIntel.status === 'ready') {
    return {
      status: 'ok',
      note: `source: ${newsIntel.sourceType}`,
    };
  }
  return {
    status: 'ok',
    note: `fallback: news_intel_${newsIntel.status}; ${newsIntel.sourceLabel}`,
  };
}

function uniqueStrings(items: readonly string[], limit: number): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(
    0,
    limit,
  );
}

const sectorNamePattern =
  /([A-Za-z0-9\u4e00-\u9fa5]{2,16}(?:板块|概念|题材|行业|产业链|赛道))/g;
const sectorSignalPattern =
  /(板块|概念|题材|行业|产业链|赛道|轮动|异动|共振|景气|资金回流|放量|涨价|回暖|复苏|催化)/i;
const peerSignalPattern =
  /(龙头|同行|同业|可比公司|可比|同赛道|头部|peer|竞品|龙一|龙二)/i;
const policySignalPattern =
  /(政策|监管|补贴|会议|规划|方案|征求意见|指引|审批|批准|关税|财政|货币|国常会|证监会|工信部|商务部|国务院|tariff|subsid|regulat|approval)/i;

function extractSectorNamesFromText(text: string): string[] {
  return Array.from(text.matchAll(sectorNamePattern), (match) => match[1] || '').filter(
    Boolean,
  );
}

function buildStructuredNewsIntel(input: {
  hotTopics: string[];
  bullishSignals: string[];
  riskSignals: string[];
  references: StockAnalysisNewsReference[];
  relatedSectors?: string[];
  sectorSignals?: string[];
  peerSignals?: string[];
  policySignals?: string[];
}): Pick<
  StockAnalysisNewsIntel,
  'relatedSectors' | 'sectorSignals' | 'peerSignals' | 'policySignals'
> {
  const referenceTexts = input.references.flatMap((item) => [
    item.title,
    item.summary,
  ]);
  const textPool = [
    ...input.hotTopics,
    ...input.bullishSignals,
    ...input.riskSignals,
    ...referenceTexts,
  ];

  return {
    relatedSectors: uniqueStrings(
      [
        ...(input.relatedSectors || []),
        ...textPool.flatMap((item) => extractSectorNamesFromText(item)),
      ],
      4,
    ),
    sectorSignals: uniqueStrings(
      [
        ...(input.sectorSignals || []),
        ...textPool.filter((item) => sectorSignalPattern.test(item)),
      ],
      3,
    ),
    peerSignals: uniqueStrings(
      [
        ...(input.peerSignals || []),
        ...textPool.filter((item) => peerSignalPattern.test(item)),
      ],
      3,
    ),
    policySignals: uniqueStrings(
      [
        ...(input.policySignals || []),
        ...textPool.filter((item) => policySignalPattern.test(item)),
      ],
      3,
    ),
  };
}

function computeFreshnessScore(
  publishedAt: string | null,
  lookbackDays: number,
): number | null {
  if (!publishedAt) {
    return null;
  }
  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) {
    return null;
  }
  const diffMs = Date.now() - publishedMs;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs < -dayMs || diffMs > lookbackDays * dayMs) {
    return 0;
  }
  const ageDays = Math.max(0, diffMs / dayMs);
  return Math.max(
    0,
    Math.min(100, Math.round(100 - (ageDays / Math.max(lookbackDays, 1)) * 100)),
  );
}

function computeQualityScore(reference: StockAnalysisNewsReference): number {
  let score = 25;
  if (reference.url) score += 25;
  if (reference.summary.trim().length >= 24) score += 20;
  if (reference.source.trim() && reference.source !== t('stock.auto_36cead', {}, undefined)) score += 15;
  if (reference.title.trim().length >= 8) score += 15;
  return Math.max(0, Math.min(100, score));
}

function getReferenceKey(reference: StockAnalysisNewsReference): string {
  return reference.url || `${reference.title}:${reference.source}:${reference.publishedAt || ''}`;
}

function resolveEvidenceDropReason(input: {
  includedInSummary: boolean;
  freshnessScore: number | null;
  qualityScore: number | null;
}): string | null {
  if (input.includedInSummary) {
    return null;
  }
  if (input.freshnessScore === null) {
    return 'missing_publish_time';
  }
  if (input.freshnessScore <= 0) {
    return 'stale';
  }
  if ((input.qualityScore ?? 0) < 45) {
    return 'low_quality';
  }
  return 'filtered_out';
}

function buildNewsEvidence(
  references: StockAnalysisNewsReference[],
  input: {
    sourceType: StockAnalysisNewsEvidence['sourceType'];
    fetchedAt: string | null;
    lookbackDays: number;
    forceInclude?: boolean;
    includedReferenceKeys?: Set<string>;
  },
): StockAnalysisNewsEvidence[] {
  return references.map((reference) => {
    const freshnessScore = computeFreshnessScore(reference.publishedAt, input.lookbackDays);
    const qualityScore = computeQualityScore(reference);
    const includedInSummary =
      input.forceInclude === true ||
      Boolean(input.includedReferenceKeys?.has(getReferenceKey(reference)));
    const dropReason = resolveEvidenceDropReason({
      includedInSummary,
      freshnessScore,
      qualityScore,
    });

    return {
      ...reference,
      sourceType: input.sourceType,
      fetchedAt: input.fetchedAt,
      freshnessScore,
      qualityScore,
      includedInSummary,
      dropReason,
    };
  });
}

function summarizeNewsEvidenceStats(
  evidence: StockAnalysisNewsEvidence[],
): StockAnalysisNewsIntel['evidenceStats'] {
  return {
    total: evidence.length,
    included: evidence.filter((item) => item.includedInSummary).length,
    dropped: evidence.filter((item) => !item.includedInSummary).length,
    stale: evidence.filter((item) => item.dropReason === 'stale').length,
    undated: evidence.filter((item) => item.dropReason === 'missing_publish_time').length,
    lowQuality: evidence.filter((item) => item.dropReason === 'low_quality').length,
  };
}

function toEvidenceReferences(
  evidence: StockAnalysisNewsEvidence[],
): StockAnalysisNewsReference[] {
  return evidence
    .filter((item) => item.includedInSummary)
    .map((item) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      summary: item.summary,
      url: item.url,
    }));
}

export async function maybeGenerateNewsIntel(
  config: StockAnalysisConfigMap,
  base: {
    stockCode: string;
    stockName: string;
    market: StockAnalysisMarket;
    metrics: StockAnalysisMetricSnapshot;
    strategy: StockAnalysisStrategyInfo;
  },
  deps: {
    newsFetchImpl?: typeof fetch;
    generateText?: (prompt: string) => Promise<string>;
    generateNewsIntel?: (
      prompt: string,
    ) => Promise<{ text: string; model?: string } | string>;
  },
): Promise<StockAnalysisNewsIntel> {
  if (!config.newsIntelEnabled) {
    return normalizeNewsIntelPayload({
      status: 'disabled',
      sourceType: 'none',
      sourceLabel: t('stock.auto_a0a702', {}, undefined),
      usedExternalSearch: false,
      generatedAt: null,
      confidence: 'low',
      summary: t('stock.auto_2ed270', {}, undefined),
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
    });
  }

  const searchFocuses = ['stock_news', 'sector_catalyst'] as const;
  const fetchedAt = new Date().toISOString();
  const merged = {
    summaryParts: [] as string[],
    hotTopics: [] as string[],
    bullishSignals: [] as string[],
    riskSignals: [] as string[],
    relatedSectors: [] as string[],
    sectorSignals: [] as string[],
    peerSignals: [] as string[],
    policySignals: [] as string[],
    references: [] as Array<{
      title: string;
      source: string;
      publishedAt: string | null;
      summary: string;
      url: string | null;
    }>,
    confidence: 'low' as 'high' | 'medium' | 'low',
    model: undefined as string | undefined,
    successfulSearches: 0,
  };
  let fallbackReason:
    | 'provider_unsupported'
    | 'search_failed'
    | 'parse_failed'
    | 'fallback_source_empty'
    | 'fallback_source_error'
    | 'fallback_summary_failed' = 'search_failed';

  try {
    for (const focus of searchFocuses) {
      const prompt = await buildNewsIntelPrompt(
        {
          stockCode: base.stockCode,
          stockName: base.stockName,
          market: base.market,
          metrics: base.metrics,
          strategy: base.strategy,
          newsLookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
          newsMaxReferences: Math.max(1, Number(config.newsMaxReferences) || 3),
        },
        focus,
      );

      try {
        const raw = await (deps.generateNewsIntel
          ? deps.generateNewsIntel(prompt)
          : generateWebSearchTextWithDefaultProvider(prompt, {
              maxTokens: 520,
              timeoutMs: Math.max(
                15000,
                Number(config.requestTimeoutMs) || 12000,
              ),
              promptTrace: {
                promptKey: 'stock_analysis.news_intel',
                featureScope: 'stock_analysis',
                metadata: {
                  stockCode: base.stockCode,
                  focus,
                },
              },
            }));
        const resolved =
          typeof raw === 'string'
            ? { text: raw, model: undefined }
            : raw;
        const parsed = extractJsonObject<{
          summary?: string;
          hotTopics?: string[];
          bullishSignals?: string[];
          riskSignals?: string[];
          relatedSectors?: string[];
          sectorSignals?: string[];
          peerSignals?: string[];
          policySignals?: string[];
          confidence?: 'high' | 'medium' | 'low';
          references?: Array<{
            title?: string;
            source?: string;
            publishedAt?: string | null;
            summary?: string;
            url?: string | null;
          }>;
        }>(resolved.text);
        if (!parsed) {
          fallbackReason = 'parse_failed';
          continue;
        }

        merged.model = merged.model || resolved.model;
        merged.successfulSearches += 1;
        if (parsed.summary) {
          merged.summaryParts.push(parsed.summary);
        }
        merged.hotTopics.push(...(parsed.hotTopics || []));
        merged.bullishSignals.push(...(parsed.bullishSignals || []));
        merged.riskSignals.push(...(parsed.riskSignals || []));
        merged.relatedSectors.push(...(parsed.relatedSectors || []));
        merged.sectorSignals.push(...(parsed.sectorSignals || []));
        merged.peerSignals.push(...(parsed.peerSignals || []));
        merged.policySignals.push(...(parsed.policySignals || []));
        merged.references.push(
          ...((parsed.references || []).map((item) => ({
            title: item.title || '',
            source: item.source || '',
            publishedAt: item.publishedAt || null,
            summary: item.summary || '',
            url: item.url || null,
          })) as typeof merged.references),
        );
        if (parsed.confidence === 'high') {
          merged.confidence = 'high';
        } else if (
          parsed.confidence === 'medium' &&
          merged.confidence !== 'high'
        ) {
          merged.confidence = 'medium';
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('does not support built-in web search')
        ) {
          fallbackReason = 'provider_unsupported';
          break;
        }
        fallbackReason = 'search_failed';
      }
    }

    if (
      merged.successfulSearches > 0 &&
      (merged.summaryParts.length > 0 ||
        merged.references.length > 0 ||
        merged.hotTopics.length > 0 ||
        merged.bullishSignals.length > 0 ||
        merged.riskSignals.length > 0 ||
        merged.relatedSectors.length > 0 ||
        merged.sectorSignals.length > 0 ||
        merged.peerSignals.length > 0 ||
        merged.policySignals.length > 0)
    ) {
      const uniqueReferences = Array.from(
        new Map(
          merged.references.map((item) => [
            item.url || `${item.title}:${item.source}:${item.publishedAt || ''}`,
            item,
          ]),
        ).values(),
      ).slice(0, Math.max(1, Number(config.newsMaxReferences) || 3));
      const structured = buildStructuredNewsIntel({
        hotTopics: merged.hotTopics,
        bullishSignals: merged.bullishSignals,
        riskSignals: merged.riskSignals,
        references: uniqueReferences,
        relatedSectors: merged.relatedSectors,
        sectorSignals: merged.sectorSignals,
        peerSignals: merged.peerSignals,
        policySignals: merged.policySignals,
      });
      const evidence = buildNewsEvidence(uniqueReferences, {
        sourceType: 'provider_reference',
        fetchedAt,
        lookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
        forceInclude: true,
      });

      return normalizeNewsIntelPayload({
        status: 'ready',
        sourceType: 'provider_web_search',
        sourceLabel: merged.model
          ? `${merged.model} Web Search (${merged.successfulSearches} rounds)`
          : `Default AI provider Web Search (${merged.successfulSearches} rounds)`,
        usedExternalSearch: true,
        generatedAt: new Date().toISOString(),
        confidence: merged.confidence,
        summary: merged.summaryParts.join(' ').trim(),
        hotTopics: uniqueStrings(merged.hotTopics, 4),
        bullishSignals: uniqueStrings(merged.bullishSignals, 3),
        riskSignals: uniqueStrings(merged.riskSignals, 3),
        references: uniqueReferences,
        ...structured,
        evidence,
        evidenceStats: summarizeNewsEvidenceStats(evidence),
      });
    }
  } catch {
    // Fall through to unavailable payload.
  }

  let fallbackSource: Awaited<ReturnType<typeof fetchFallbackNewsSnippets>> = {
    sourceLabel: t('stock.auto_feccd6', {}, undefined),
    snippets: [],
    rawSnippets: [],
  };
  try {
    fallbackSource = await fetchFallbackNewsSnippets({
      stockCode: base.stockCode,
      stockName: base.stockName,
      market: base.market,
      lookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
      maxResults: Math.max(2, Number(config.newsMaxReferences) || 3),
      fetchImpl: deps.newsFetchImpl,
      timeoutMs: Math.max(8000, Number(config.requestTimeoutMs) || 12000),
    });
  } catch {
    fallbackReason = 'fallback_source_error';
  }

  const rawFallbackSnippets =
    fallbackSource.rawSnippets.length > 0
      ? fallbackSource.rawSnippets
      : fallbackSource.snippets;
  if (rawFallbackSnippets.length > 0) {
    const fallbackIncludedReferenceKeys = new Set(
      fallbackSource.snippets.map((item) => getReferenceKey(item)),
    );
    const rawEvidence = buildNewsEvidence(rawFallbackSnippets, {
      sourceType: 'fallback_snippet',
      fetchedAt,
      lookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
      includedReferenceKeys: fallbackIncludedReferenceKeys,
    });
    const includedEvidence = rawEvidence.filter((item) => item.includedInSummary);
    const includedReferences = toEvidenceReferences(includedEvidence);
    if (includedReferences.length === 0) {
      return normalizeNewsIntelPayload({
        status: 'unavailable',
        sourceType: 'none',
        sourceLabel: t('stock.auto_c3ac15', {}, undefined),
        usedExternalSearch: false,
        generatedAt: null,
        confidence: 'low',
        summary: t('stock.auto_3b04e5', {}, undefined),
        hotTopics: [],
        bullishSignals: [],
        riskSignals: [],
        references: [],
        evidence: rawEvidence,
        evidenceStats: summarizeNewsEvidenceStats(rawEvidence),
      });
    }
    const fallbackPrompt = await buildNewsIntelSnippetPrompt({
      stockCode: base.stockCode,
      stockName: base.stockName,
      market: base.market,
      metrics: base.metrics,
      strategy: base.strategy,
      newsLookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
      newsMaxReferences: Math.max(1, Number(config.newsMaxReferences) || 3),
      sourceLabel: fallbackSource.sourceLabel,
      snippets: includedReferences,
    });

    try {
      const raw = await (deps.generateText
        ? deps.generateText(fallbackPrompt)
        : generateTextWithDefaultProvider(fallbackPrompt, {
            promptTrace: {
              promptKey: 'stock_analysis.news_intel_snippet',
              featureScope: 'stock_analysis',
              metadata: {
                stockCode: base.stockCode,
                sourceLabel: fallbackSource.sourceLabel,
              },
            },
          }));
      const parsed = extractJsonObject<{
        summary?: string;
        hotTopics?: string[];
        bullishSignals?: string[];
        riskSignals?: string[];
        relatedSectors?: string[];
        sectorSignals?: string[];
        peerSignals?: string[];
        policySignals?: string[];
        confidence?: 'high' | 'medium' | 'low';
        references?: Array<{
          title?: string;
          source?: string;
          publishedAt?: string | null;
          summary?: string;
          url?: string | null;
        }>;
      }>(raw);

      if (parsed) {
        const references =
          Array.isArray(parsed.references) && parsed.references.length > 0
            ? parsed.references.map((item) => ({
                title: item.title || '',
                source: item.source || '',
                publishedAt: item.publishedAt || null,
                summary: item.summary || '',
                url: item.url || null,
              }))
            : includedReferences;
        const finalReferenceKeys = new Set(
          references.map((item) => getReferenceKey(item)),
        );
        const finalEvidence = buildNewsEvidence(rawFallbackSnippets, {
          sourceType: 'fallback_snippet',
          fetchedAt,
          lookbackDays: Math.max(1, Number(config.newsLookbackDays) || 7),
          includedReferenceKeys: finalReferenceKeys,
        });
        const structured = buildStructuredNewsIntel({
          hotTopics: parsed.hotTopics || [],
          bullishSignals: parsed.bullishSignals || [],
          riskSignals: parsed.riskSignals || [],
          references,
          relatedSectors: parsed.relatedSectors,
          sectorSignals: parsed.sectorSignals,
          peerSignals: parsed.peerSignals,
          policySignals: parsed.policySignals,
        });
        return normalizeNewsIntelPayload({
          status: 'ready',
          sourceType: 'fallback_news_feed',
          sourceLabel: fallbackSource.sourceLabel,
          usedExternalSearch: true,
          generatedAt: new Date().toISOString(),
          confidence: parsed.confidence,
          summary: parsed.summary,
          hotTopics: parsed.hotTopics,
          bullishSignals: parsed.bullishSignals,
          riskSignals: parsed.riskSignals,
          references,
          ...structured,
          evidence: finalEvidence,
          evidenceStats: summarizeNewsEvidenceStats(finalEvidence),
        });
      }
    } catch {
      // Fall through to deterministic fallback.
    }

    fallbackReason = 'fallback_summary_failed';
    const fallbackHotTopics = fallbackSource.snippets
      .map((item) => item.title)
      .filter(Boolean)
      .slice(0, 3);
    const structured = buildStructuredNewsIntel({
      hotTopics: fallbackHotTopics,
      bullishSignals: [],
      riskSignals: [],
      references: includedReferences,
    });
    return normalizeNewsIntelPayload({
      status: 'ready',
      sourceType: 'fallback_news_feed',
      sourceLabel: fallbackSource.sourceLabel,
      usedExternalSearch: true,
      generatedAt: new Date().toISOString(),
      confidence: 'low',
      summary: `已从 ${fallbackSource.sourceLabel} 抓取 ${fallbackSource.snippets.length} 条近期消息，当前先提供原始催化线索与引用，建议结合行情继续确认。`,
      hotTopics: fallbackHotTopics,
      bullishSignals: [],
      riskSignals: [],
      references: includedReferences,
      ...structured,
      evidence: rawEvidence,
      evidenceStats: summarizeNewsEvidenceStats(rawEvidence),
    });
  }

  fallbackReason =
    fallbackReason === 'provider_unsupported'
      ? 'provider_unsupported'
      : fallbackReason === 'fallback_source_error'
        ? 'fallback_source_error'
      : fallbackReason === 'parse_failed'
        ? 'parse_failed'
        : 'fallback_source_empty';

  const fallback =
    fallbackReason === 'provider_unsupported'
      ? {
          sourceLabel: t('stock.auto_42a9b2', {}, undefined),
          summary:
            t('stock.auto_8d694f', {}, undefined),
        }
      : fallbackReason === 'fallback_source_error'
        ? {
            sourceLabel: t('stock.auto_ad541a', {}, undefined),
            summary:
              t('stock.auto_2b5d90', {}, undefined),
          }
      : fallbackReason === 'parse_failed'
        ? {
            sourceLabel: t('stock.auto_f32e06', {}, undefined),
            summary:
              t('stock.auto_a6a344', {}, undefined),
          }
        : fallbackReason === 'fallback_source_empty'
          ? {
              sourceLabel: t('stock.auto_dffb80', {}, undefined),
              summary:
                t('stock.auto_b7a4b3', {}, undefined),
            }
        : {
            sourceLabel: t('stock.auto_6b46f3', {}, undefined),
            summary: t('stock.auto_349f4b', {}, undefined),
          };

  return normalizeNewsIntelPayload({
    status: 'unavailable',
    sourceType: 'none',
    sourceLabel: fallback.sourceLabel,
    usedExternalSearch: false,
    generatedAt: null,
    confidence: 'low',
    summary: fallback.summary,
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
  });
}
