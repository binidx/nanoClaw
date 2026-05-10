import { DEFAULTS, getConfigValues } from '../config-store.js';
import { isFeatureEnabled } from '../auth/web-security.js';

/** Config keys whose parsing is shared with `observability.ts` (single clamp / gating rules). */
export const MEMORY_SHARED_CONFIG_KEYS = [
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_MODE',
  'MEMORY_GLOBAL_WRITE_ENABLED',
  'MEMORY_AUTO_SAVE_ENABLED',
  'MEMORY_PROMPT_INJECTION_ENABLED',
  'MEMORY_PROMPT_MAX_SNIPPETS',
  'MEMORY_PROMPT_TOKEN_BUDGET',
  'MEMORY_PROMPT_RECENT_RATIO',
  'MEMORY_PROMPT_SUMMARY_RATIO',
  'MEMORY_PROMPT_RECALL_RATIO',
  'MEMORY_COMPACTION_ENABLED',
  'MEMORY_COMPACTION_TRIGGER_ENTRIES',
  'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
] as const;

export type MemorySharedConfigKey = (typeof MEMORY_SHARED_CONFIG_KEYS)[number];

export interface MemorySharedParsedConfig {
  memoryEnabled: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  globalWriteEnabled: boolean;
  autoSaveEnabled: boolean;
  promptInjectionEnabled: boolean;
  promptMaxSnippets: number;
  promptTokenBudget: number;
  promptRecentRatio: number;
  promptSummaryRatio: number;
  promptRecallRatio: number;
  compactionEnabled: boolean;
  compactionTriggerEntries: number;
  compactionKeepRecentEntries: number;
}

function parseBooleanConfigValue(value: string): boolean {
  return isFeatureEnabled(value);
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

/**
 * Single source of truth for overlapping memory admin + runtime flags and numeric clamps.
 * Callers supply strings already merged with defaults (e.g. from getConfigValues).
 */
export function parseMemorySharedConfigFromNormalized(
  normalized: Record<MemorySharedConfigKey, string>,
): MemorySharedParsedConfig {
  const memoryEnabled = parseBooleanConfigValue(normalized.MEMORY_ENABLED);
  const memoryReadEnabled =
    memoryEnabled &&
    parseBooleanConfigValue(normalized.MEMORY_READ_ENABLED);
  const writeMode = String(normalized.MEMORY_WRITE_MODE || '').trim();
  const writeModeLower = writeMode.toLowerCase();
  const memoryWriteEnabled =
    memoryEnabled &&
    !['disabled', 'disable', 'off', 'none', 'read-only', 'readonly'].includes(
      writeModeLower,
    );
  const globalWriteEnabled =
    memoryWriteEnabled &&
    parseBooleanConfigValue(normalized.MEMORY_GLOBAL_WRITE_ENABLED);
  const autoSaveEnabled =
    memoryReadEnabled &&
    memoryWriteEnabled &&
    parseBooleanConfigValue(normalized.MEMORY_AUTO_SAVE_ENABLED);
  const promptInjectionEnabled =
    memoryReadEnabled &&
    parseBooleanConfigValue(normalized.MEMORY_PROMPT_INJECTION_ENABLED);

  return {
    memoryEnabled,
    memoryReadEnabled,
    memoryWriteEnabled,
    globalWriteEnabled,
    autoSaveEnabled,
    promptInjectionEnabled,
    promptMaxSnippets: parseBoundedInteger(
      normalized.MEMORY_PROMPT_MAX_SNIPPETS,
      3,
      0,
      10,
    ),
    promptTokenBudget: parseBoundedInteger(
      normalized.MEMORY_PROMPT_TOKEN_BUDGET,
      0,
      0,
      12000,
    ),
    promptRecentRatio: parseBoundedInteger(
      normalized.MEMORY_PROMPT_RECENT_RATIO,
      35,
      0,
      100,
    ),
    promptSummaryRatio: parseBoundedInteger(
      normalized.MEMORY_PROMPT_SUMMARY_RATIO,
      25,
      0,
      100,
    ),
    promptRecallRatio: parseBoundedInteger(
      normalized.MEMORY_PROMPT_RECALL_RATIO,
      25,
      0,
      100,
    ),
    compactionEnabled:
      memoryReadEnabled &&
      parseBooleanConfigValue(normalized.MEMORY_COMPACTION_ENABLED),
    compactionTriggerEntries: parseBoundedInteger(
      normalized.MEMORY_COMPACTION_TRIGGER_ENTRIES,
      40,
      10,
      500,
    ),
    compactionKeepRecentEntries: parseBoundedInteger(
      normalized.MEMORY_COMPACTION_KEEP_RECENT_ENTRIES,
      12,
      1,
      100,
    ),
  };
}

export interface MemoryContextConfig {
  memoryEnabled: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  globalWriteEnabled: boolean;
  autoSaveEnabled: boolean;
  promptInjectionEnabled: boolean;
  promptMaxSnippets: number;
  promptTokenBudget: number;
  promptRecentRatio: number;
  promptSummaryRatio: number;
  promptRecallRatio: number;
  compactionEnabled: boolean;
  compactionTriggerEntries: number;
  compactionKeepRecentEntries: number;
}

export async function getMemoryContextConfig(): Promise<MemoryContextConfig> {
  const config = await getConfigValues([...MEMORY_SHARED_CONFIG_KEYS]);
  const normalized = Object.fromEntries(
    MEMORY_SHARED_CONFIG_KEYS.map((key) => [
      key,
      config[key] || DEFAULTS[key] || '',
    ]),
  ) as Record<MemorySharedConfigKey, string>;
  return parseMemorySharedConfigFromNormalized(normalized);
}
