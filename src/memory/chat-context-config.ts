import { DEFAULTS, getConfigValues } from '../config-store.js';

import { getMemoryContextConfig } from './context-config.js';

const CHAT_CONTEXT_CONFIG_KEYS = [
  'CHAT_CONTEXT_TOKEN_BUDGET',
  'CHAT_CONTEXT_RECENT_CHAT_RATIO',
  'CHAT_CONTEXT_RECENT_TOOL_RATIO',
  'CHAT_CONTEXT_MEMORY_RECALL_RATIO',
  'CHAT_CONTEXT_SUMMARY_RATIO',
  'CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES',
  'CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS',
  'CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES',
  'CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES',
] as const;

type ChatContextConfigKey = (typeof CHAT_CONTEXT_CONFIG_KEYS)[number];

export interface ChatContextConfig {
  memoryEnabled: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  promptInjectionEnabled: boolean;
  promptMaxSnippets: number;
  tokenBudget: number;
  recentChatRatio: number;
  recentToolRatio: number;
  memoryRecallRatio: number;
  summaryRatio: number;
  rawChatKeepEntries: number;
  rawToolKeepCalls: number;
  compactionEnabled: boolean;
  chatCompactionTriggerEntries: number;
  chatCompactionKeepRecentEntries: number;
}

function parseBoundedInteger(
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

function preferChatContextValue(
  candidate: string,
  fallback: number,
  minValue: number,
  maxValue: number,
): number {
  const trimmed = String(candidate || '').trim();
  if (!trimmed) return fallback;
  return parseBoundedInteger(trimmed, fallback, minValue, maxValue);
}

export async function getChatContextConfig(): Promise<ChatContextConfig> {
  const [memoryConfig, config] = await Promise.all([
    getMemoryContextConfig(),
    getConfigValues([...CHAT_CONTEXT_CONFIG_KEYS]),
  ]);
  const normalized = Object.fromEntries(
    CHAT_CONTEXT_CONFIG_KEYS.map((key) => [key, config[key] || DEFAULTS[key] || '']),
  ) as Record<ChatContextConfigKey, string>;

  const tokenBudget = preferChatContextValue(
    normalized.CHAT_CONTEXT_TOKEN_BUDGET,
    6000,
    0,
    12000,
  );
  const recentChatRatio = preferChatContextValue(
    normalized.CHAT_CONTEXT_RECENT_CHAT_RATIO,
    35,
    0,
    100,
  );
  const recentToolRatio = preferChatContextValue(
    normalized.CHAT_CONTEXT_RECENT_TOOL_RATIO,
    20,
    0,
    100,
  );
  const memoryRecallRatio = preferChatContextValue(
    normalized.CHAT_CONTEXT_MEMORY_RECALL_RATIO,
    30,
    0,
    100,
  );
  const summaryRatio = preferChatContextValue(
    normalized.CHAT_CONTEXT_SUMMARY_RATIO,
    15,
    0,
    100,
  );
  const rawChatKeepEntries = preferChatContextValue(
    normalized.CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES,
    memoryConfig.compactionKeepRecentEntries,
    1,
    100,
  );
  const rawToolKeepCalls = preferChatContextValue(
    normalized.CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS,
    6,
    1,
    50,
  );
  const chatCompactionTriggerEntries = preferChatContextValue(
    normalized.CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES,
    memoryConfig.compactionTriggerEntries,
    10,
    500,
  );
  const chatCompactionKeepRecentEntries = preferChatContextValue(
    normalized.CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES,
    memoryConfig.compactionKeepRecentEntries,
    1,
    100,
  );

  return {
    memoryEnabled: memoryConfig.memoryEnabled,
    memoryReadEnabled: memoryConfig.memoryReadEnabled,
    memoryWriteEnabled: memoryConfig.memoryWriteEnabled,
    promptInjectionEnabled: memoryConfig.promptInjectionEnabled,
    promptMaxSnippets: memoryConfig.promptMaxSnippets,
    tokenBudget,
    recentChatRatio,
    recentToolRatio,
    memoryRecallRatio,
    summaryRatio,
    rawChatKeepEntries,
    rawToolKeepCalls,
    compactionEnabled: memoryConfig.compactionEnabled,
    chatCompactionTriggerEntries,
    chatCompactionKeepRecentEntries,
  };
}
