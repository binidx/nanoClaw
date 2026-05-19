import { DEFAULTS } from '../config-store.js';
import { getConfigValues } from '../config-store.js';
import {
  getMemoryCompactionStats,
  getMemoryIdentityStats,
  getMemoryLedgerStats,
  getMemoryPromptStats,
  getMemoryPromotionStats,
  getMemorySearchStats,
} from '../db.js';
import type {
  MemoryEffectiveConfigSnapshot,
  MemoryObservabilitySnapshot,
} from '../types.js';

import {
  MEMORY_SHARED_CONFIG_KEYS,
  type MemorySharedConfigKey,
  parseMemorySharedConfigFromNormalized,
} from './context-config.js';
import { getChatContextConfig } from './chat-context-config.js';

const MEMORY_CONFIG_KEYS = [
  ...MEMORY_SHARED_CONFIG_KEYS,
  'MEMORY_SEARCH_SCOPE_DEFAULT',
  'MEMORY_SEARCH_MAX_RESULTS',
] as const;

function parseIntegerConfigValue(
  value: string,
  fallback: number,
  minValue: number,
  maxValue: number,
): number {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < minValue || parsed > maxValue) {
    return fallback;
  }
  return parsed;
}

export async function getMemoryEffectiveConfig(): Promise<MemoryEffectiveConfigSnapshot> {
  const [config, chatContext] = await Promise.all([
    getConfigValues([...MEMORY_CONFIG_KEYS]),
    getChatContextConfig(),
  ]);
  const normalized = Object.fromEntries(
    MEMORY_CONFIG_KEYS.map((key) => [key, config[key] || DEFAULTS[key] || '']),
  ) as Record<(typeof MEMORY_CONFIG_KEYS)[number], string>;
  const sharedNormalized = Object.fromEntries(
    MEMORY_SHARED_CONFIG_KEYS.map((key) => [
      key,
      normalized[key as MemorySharedConfigKey] || DEFAULTS[key] || '',
    ]),
  ) as Record<MemorySharedConfigKey, string>;
  const shared = parseMemorySharedConfigFromNormalized(sharedNormalized);

  return {
    enabled: shared.memoryEnabled,
    readEnabled: shared.memoryReadEnabled,
    writeEnabled: shared.memoryWriteEnabled,
    writeMode: normalized.MEMORY_WRITE_MODE || 'daily-only',
    globalWriteEnabled: shared.globalWriteEnabled,
    autoSaveEnabled: shared.autoSaveEnabled,
    searchScopeDefault: normalized.MEMORY_SEARCH_SCOPE_DEFAULT || 'group',
    searchMaxResults: parseIntegerConfigValue(
      normalized.MEMORY_SEARCH_MAX_RESULTS,
      5,
      1,
      8,
    ),
    promptInjectionEnabled: shared.promptInjectionEnabled,
    promptMaxSnippets: shared.promptMaxSnippets,
    promptTokenBudget: shared.promptTokenBudget,
    promptRecentRatio: shared.promptRecentRatio,
    promptSummaryRatio: shared.promptSummaryRatio,
    promptRecallRatio: shared.promptRecallRatio,
    compactionEnabled: shared.compactionEnabled,
    compactionTriggerEntries: shared.compactionTriggerEntries,
    compactionKeepRecentEntries: shared.compactionKeepRecentEntries,
    chatContextTokenBudget: chatContext.tokenBudget,
    chatContextRecentChatRatio: chatContext.recentChatRatio,
    chatContextRecentToolRatio: chatContext.recentToolRatio,
    chatContextMemoryRecallRatio: chatContext.memoryRecallRatio,
    chatContextSummaryRatio: chatContext.summaryRatio,
    chatContextRawChatKeepEntries: chatContext.rawChatKeepEntries,
    chatContextRawToolKeepCalls: chatContext.rawToolKeepCalls,
    chatContextChatCompactionTriggerEntries: chatContext.chatCompactionTriggerEntries,
    chatContextChatCompactionKeepRecentEntries:
      chatContext.chatCompactionKeepRecentEntries,
  };
}

export async function getMemoryObservability(): Promise<MemoryObservabilitySnapshot> {
  return {
    config: await getMemoryEffectiveConfig(),
    ledger: await getMemoryLedgerStats(),
    compaction: await getMemoryCompactionStats(),
    promotion: await getMemoryPromotionStats(),
    identity: await getMemoryIdentityStats(),
    search: await getMemorySearchStats(),
    prompt: await getMemoryPromptStats(),
  };
}
