import {
  deleteStockAnalysisConfigPreset,
  getStockAnalysisConfigHistory,
  getStockAnalysisConfigEntries,
  listStockAnalysisConfigPresets,
  listStockAnalysisConfigHistory,
  getStockAnalysisConfigVersion,
  restoreStockAnalysisConfigHistory,
  upsertStockAnalysisConfigPreset,
  updateStockAnalysisConfigEntries,
  type StockAnalysisConfigEntry,
  type StockAnalysisConfigHistoryRecord,
} from '../db.js';
import { t } from '../i18n/index.js';

export type StockAnalysisConfigValue = string | number | boolean;
export type StockAnalysisConfigMap = Record<string, StockAnalysisConfigValue>;

export interface StockAnalysisConfigFieldOption {
  value: string;
  label: string;
}

export interface StockAnalysisConfigFieldMeta {
  key: keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS;
  title: string;
  type: 'text' | 'number' | 'select' | 'switch' | 'textarea';
  description: string;
  sensitive?: boolean;
  min?: number;
  max?: number;
  options?: StockAnalysisConfigFieldOption[];
  /** Regex pattern for text field validation. */
  pattern?: RegExp;
}

export interface StockAnalysisConfigSectionMeta {
  id: string;
  title: string;
  fields: StockAnalysisConfigFieldMeta[];
}

export interface StockAnalysisConfigPresetMeta {
  id: string;
  title: string;
  description: string;
  values: StockAnalysisConfigMap;
}

export interface StockAnalysisConfigPresetRecord {
  id: string;
  title: string;
  description: string;
  values: StockAnalysisConfigMap;
  createdAt: string;
  updatedAt: string;
}

export interface StockAnalysisConfigHistoryItem {
  id: string;
  version: string;
  config: StockAnalysisConfigMap;
  changedKeys: string[];
  createdAt: string;
}

export const STOCK_ANALYSIS_CONFIG_DEFAULTS = {
  defaultMarketScope: 'both',
  defaultReportType: 'standard',
  defaultStrategyPreset: 'bull_trend',
  maxConcurrentTasks: 2,
  pickerMinScore: 65,
  pickerFreshnessDays: 10,
  feedbackLookaheadDays: 10,
  feedbackWinThresholdPct: 3,
  feedbackLossThresholdPct: -3,
  historyDays: 180,
  maType: 'sma',
  reportCacheTtlMinutes: 30,
  aiSummaryEnabled: true,
  aiSummaryStyle: 'professional',
  newsIntelEnabled: true,
  newsLookbackDays: 7,
  newsMaxReferences: 3,
  bullTrendTrendBonus: 2,
  bullTrendMacdBonus: 1,
  shrinkPullbackBiasLowerPct: -4,
  shrinkPullbackBiasUpperPct: 1,
  shrinkPullbackVolumeRatioMax: 0.95,
  volumeBreakoutVolumeRatioMin: 1.2,
  volumeBreakoutBreakoutRoomMin: -2,
  marketReviewScope: 'both',
  marketReviewIndicesPerMarket: 3,
  dataProvider: 'yahoo',
  dataProviderFailover: true,
  dataProviderPriority: 'yahoo,efinance,akshare',
  requestTimeoutMs: 12000,
  backtestLookaheadDays: 10,
  backtestMaxReports: 120,
  biasSafetyThresholdPct: 5,
} as const;

function createPresetValues(
  overrides: Partial<
    Record<keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS, StockAnalysisConfigValue>
  >,
): StockAnalysisConfigMap {
  return {
    ...STOCK_ANALYSIS_CONFIG_DEFAULTS,
    ...overrides,
  };
}

const STOCK_ANALYSIS_CONFIG_PRESETS: StockAnalysisConfigPresetMeta[] = [
  {
    id: 'balanced',
    title: t('stock.auto_605ca0', {}, undefined),
    description: t('stock.auto_3d911c', {}, undefined),
    values: createPresetValues({}),
  },
  {
    id: 'fast-scan',
    title: t('stock.auto_04ec04', {}, undefined),
    description: t('stock.auto_4bbc04', {}, undefined),
    values: createPresetValues({
      defaultReportType: 'brief',
      defaultStrategyPreset: 'volume_breakout',
      maxConcurrentTasks: 4,
      pickerMinScore: 60,
      pickerFreshnessDays: 7,
      feedbackLookaheadDays: 7,
      historyDays: 120,
      reportCacheTtlMinutes: 60,
      aiSummaryEnabled: false,
      newsIntelEnabled: false,
      aiSummaryStyle: 'concise',
      marketReviewIndicesPerMarket: 2,
      requestTimeoutMs: 8000,
    }),
  },
  {
    id: 'deep-dive',
    title: t('stock.auto_c744a7', {}, undefined),
    description: t('stock.auto_145b6f', {}, undefined),
    values: createPresetValues({
      defaultReportType: 'detailed',
      defaultStrategyPreset: 'shrink_pullback',
      maxConcurrentTasks: 1,
      pickerMinScore: 72,
      pickerFreshnessDays: 14,
      feedbackLookaheadDays: 15,
      feedbackWinThresholdPct: 4,
      historyDays: 365,
      reportCacheTtlMinutes: 10,
      aiSummaryEnabled: true,
      aiSummaryStyle: 'professional',
      newsLookbackDays: 10,
      newsMaxReferences: 4,
      bullTrendTrendBonus: 3,
      shrinkPullbackBiasLowerPct: -5,
      shrinkPullbackVolumeRatioMax: 0.9,
      volumeBreakoutVolumeRatioMin: 1.3,
      marketReviewIndicesPerMarket: 4,
      requestTimeoutMs: 18000,
    }),
  },
];

const STOCK_ANALYSIS_CONFIG_PRESET_IDS = new Set(
  STOCK_ANALYSIS_CONFIG_PRESETS.map((preset) => preset.id),
);

const STOCK_ANALYSIS_CONFIG_FIELDS: StockAnalysisConfigSectionMeta[] = [
  {
    id: 'general',
    title: t('stock.auto_0aeca0', {}, undefined),
    fields: [
      {
        key: 'defaultMarketScope',
        title: t('stock.auto_b67eab', {}, undefined),
        type: 'select',
        description: t('stock.auto_11bad2', {}, undefined),
        options: [
          { value: 'cn', label: t('stock.auto_b455f4', {}, undefined) },
          { value: 'hk', label: t('stock.auto_d82e50', {}, undefined) },
          { value: 'us', label: t('stock.auto_d0df61', {}, undefined) },
          { value: 'both', label: t('stock.auto_5818a2', {}, undefined) },
          { value: 'all', label: t('stock.auto_b2382e', {}, undefined) },
        ],
      },
      {
        key: 'defaultReportType',
        title: t('stock.auto_91da3c', {}, undefined),
        type: 'select',
        description: t('stock.auto_754d39', {}, undefined),
        options: [
          { value: 'brief', label: t('stock.auto_be04ab', {}, undefined) },
          { value: 'standard', label: t('stock.auto_544fac', {}, undefined) },
          { value: 'detailed', label: t('stock.auto_1f0a3a', {}, undefined) },
        ],
      },
      {
        key: 'defaultStrategyPreset',
        title: t('stock.auto_fa09aa', {}, undefined),
        type: 'select',
        description: t('stock.auto_339fba', {}, undefined),
        options: [
          { value: 'bull_trend', label: t('stock.auto_dfedff', {}, undefined) },
          { value: 'shrink_pullback', label: t('stock.auto_f8b8d6', {}, undefined) },
          { value: 'volume_breakout', label: t('stock.auto_de2dbe', {}, undefined) },
          { value: 'ma_golden_cross', label: t('stock.auto_735fd1', {}, undefined) },
          { value: 'box_oscillation', label: t('stock.auto_78e56e', {}, undefined) },
        ],
      },
      {
        key: 'maxConcurrentTasks',
        title: t('stock.auto_15dcdf', {}, undefined),
        type: 'number',
        description: t('stock.auto_841390', {}, undefined),
        min: 1,
        max: 4,
      },
      {
        key: 'pickerMinScore',
        title: t('stock.auto_0d9d42', {}, undefined),
        type: 'number',
        description: t('stock.auto_91d7a2', {}, undefined),
        min: 0,
        max: 100,
      },
      {
        key: 'pickerFreshnessDays',
        title: t('stock.auto_c5c779', {}, undefined),
        type: 'number',
        description: t('stock.auto_5deb71', {}, undefined),
        min: 1,
        max: 30,
      },
      {
        key: 'feedbackLookaheadDays',
        title: t('stock.auto_84ca71', {}, undefined),
        type: 'number',
        description: t('stock.auto_edecaa', {}, undefined),
        min: 3,
        max: 30,
      },
      {
        key: 'historyDays',
        title: t('stock.auto_91bd0b', {}, undefined),
        type: 'number',
        description: t('stock.auto_c25351', {}, undefined),
        min: 60,
        max: 365,
      },
      {
        key: 'maType',
        title: t('stock.auto_37e133', {}, undefined),
        type: 'select',
        description:
          t('stock.auto_33bfac', {}, undefined),
        options: [
          { value: 'sma', label: 'SMA' },
          { value: 'ema', label: 'EMA' },
        ],
      },
      {
        key: 'reportCacheTtlMinutes',
        title: t('stock.auto_a1bb85', {}, undefined),
        type: 'number',
        description:
          t('stock.auto_a3cda1', {}, undefined),
        min: 0,
        max: 1440,
      },
    ],
  },
  {
    id: 'analysis',
    title: t('stock.auto_77cc76', {}, undefined),
    fields: [
      {
        key: 'aiSummaryEnabled',
        title: t('stock.auto_fc3a2e', {}, undefined),
        type: 'switch',
        description:
          t('stock.auto_b1cbfb', {}, undefined),
      },
      {
        key: 'aiSummaryStyle',
        title: t('stock.auto_87cc05', {}, undefined),
        type: 'select',
        description: t('stock.auto_78ac67', {}, undefined),
        options: [
          { value: 'professional', label: t('stock.auto_a7ad35', {}, undefined) },
          { value: 'concise', label: t('stock.auto_e7e07e', {}, undefined) },
          { value: 'trader', label: t('stock.auto_136626', {}, undefined) },
        ],
      },
      {
        key: 'newsIntelEnabled',
        title: t('stock.auto_f658d0', {}, undefined),
        type: 'switch',
        description:
          t('stock.auto_b314c8', {}, undefined),
      },
      {
        key: 'newsLookbackDays',
        title: t('stock.auto_784862', {}, undefined),
        type: 'number',
        description: t('stock.auto_110b45', {}, undefined),
        min: 1,
        max: 30,
      },
      {
        key: 'newsMaxReferences',
        title: t('stock.auto_2cfc09', {}, undefined),
        type: 'number',
        description: t('stock.auto_99f4d7', {}, undefined),
        min: 1,
        max: 5,
      },
      {
        key: 'feedbackWinThresholdPct',
        title: t('stock.auto_537f9e', {}, undefined),
        type: 'number',
        description: t('stock.auto_465333', {}, undefined),
        min: 1,
        max: 15,
      },
      {
        key: 'feedbackLossThresholdPct',
        title: t('stock.auto_d1805b', {}, undefined),
        type: 'number',
        description: t('stock.auto_667fd5', {}, undefined),
        min: -15,
        max: -1,
      },
      {
        key: 'biasSafetyThresholdPct',
        title: t('stock.auto_54413d', {}, undefined),
        type: 'number',
        description:
          t('stock.auto_917f4d', {}, undefined),
        min: 0,
        max: 15,
      },
    ],
  },
  {
    id: 'strategy',
    title: t('stock.auto_dcb30c', {}, undefined),
    fields: [
      {
        key: 'bullTrendTrendBonus',
        title: t('stock.auto_5ab4b3', {}, undefined),
        type: 'number',
        description: t('stock.auto_ae0823', {}, undefined),
        min: 0,
        max: 5,
      },
      {
        key: 'bullTrendMacdBonus',
        title: t('stock.auto_a5ec73', {}, undefined),
        type: 'number',
        description: t('stock.auto_4d71b0', {}, undefined),
        min: 0,
        max: 5,
      },
      {
        key: 'shrinkPullbackBiasLowerPct',
        title: t('stock.auto_a0d7d6', {}, undefined),
        type: 'number',
        description: t('stock.auto_b5e9fa', {}, undefined),
        min: -10,
        max: 0,
      },
      {
        key: 'shrinkPullbackBiasUpperPct',
        title: t('stock.auto_693330', {}, undefined),
        type: 'number',
        description: t('stock.auto_4a4f31', {}, undefined),
        min: 0,
        max: 6,
      },
      {
        key: 'shrinkPullbackVolumeRatioMax',
        title: t('stock.auto_021cb0', {}, undefined),
        type: 'number',
        description: t('stock.auto_1cac37', {}, undefined),
        min: 0.5,
        max: 1.2,
      },
      {
        key: 'volumeBreakoutVolumeRatioMin',
        title: t('stock.auto_f4d6be', {}, undefined),
        type: 'number',
        description: t('stock.auto_fff053', {}, undefined),
        min: 1,
        max: 2.5,
      },
      {
        key: 'volumeBreakoutBreakoutRoomMin',
        title: t('stock.auto_0e0701', {}, undefined),
        type: 'number',
        description: t('stock.auto_1742a6', {}, undefined),
        min: -5,
        max: 8,
      },
    ],
  },
  {
    id: 'marketReview',
    title: t('stock.auto_e3554d', {}, undefined),
    fields: [
      {
        key: 'marketReviewScope',
        title: t('stock.auto_48f25d', {}, undefined),
        type: 'select',
        description: t('stock.auto_48d1e3', {}, undefined),
        options: [
          { value: 'cn', label: t('stock.auto_b455f4', {}, undefined) },
          { value: 'hk', label: t('stock.auto_d82e50', {}, undefined) },
          { value: 'us', label: t('stock.auto_d0df61', {}, undefined) },
          { value: 'both', label: t('stock.auto_5818a2', {}, undefined) },
          { value: 'all', label: t('stock.auto_b2382e', {}, undefined) },
        ],
      },
      {
        key: 'marketReviewIndicesPerMarket',
        title: t('stock.auto_ec1900', {}, undefined),
        type: 'number',
        description: t('stock.auto_caf7d5', {}, undefined),
        min: 1,
        max: 5,
      },
    ],
  },
  {
    id: 'data',
    title: t('stock.auto_c11322', {}, undefined),
    fields: [
      {
        key: 'dataProvider',
        title: t('stock.auto_c987e2', {}, undefined),
        type: 'select',
        description:
          t('stock.auto_913830', {}, undefined),
        options: [
          { value: 'yahoo', label: 'Yahoo Finance' },
          { value: 'efinance', label: t('stock.auto_7fa0ca', {}, undefined) },
          { value: 'akshare', label: t('stock.auto_0daa78', {}, undefined) },
        ],
      },
      {
        key: 'dataProviderFailover',
        title: t('stock.auto_c4bc14', {}, undefined),
        type: 'switch',
        description: t('stock.auto_a537fd', {}, undefined),
      },
      {
        key: 'dataProviderPriority',
        title: t('stock.auto_ab8692', {}, undefined),
        type: 'text',
        description:
          t('stock.auto_6870ec', {}, undefined),
        pattern: /^(yahoo|efinance|akshare)(,(yahoo|efinance|akshare))*$/,
      },
      {
        key: 'requestTimeoutMs',
        title: t('stock.auto_f91322', {}, undefined),
        type: 'number',
        description: t('stock.auto_735aa1', {}, undefined),
        min: 3000,
        max: 30000,
      },
      {
        key: 'backtestLookaheadDays',
        title: t('stock.auto_639f83', {}, undefined),
        type: 'number',
        description: t('stock.auto_f6ad60', {}, undefined),
        min: 3,
        max: 30,
      },
      {
        key: 'backtestMaxReports',
        title: t('stock.auto_890c39', {}, undefined),
        type: 'number',
        description: t('stock.auto_42b313', {}, undefined),
        min: 20,
        max: 500,
      },
    ],
  },
];

function coerceConfigValue(
  key: keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS,
  value: string,
): StockAnalysisConfigValue {
  const defaultValue = STOCK_ANALYSIS_CONFIG_DEFAULTS[key];
  if (typeof defaultValue === 'boolean') {
    return value === 'true';
  }
  if (typeof defaultValue === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
  return value;
}

function validateFieldValue(
  field: StockAnalysisConfigFieldMeta,
  value: StockAnalysisConfigValue,
): void {
  if (field.type === 'number') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${field.title} 必须是数字`);
    }
    if (field.min !== undefined && numeric < field.min) {
      throw new Error(`${field.title} 不能小于 ${field.min}`);
    }
    if (field.max !== undefined && numeric > field.max) {
      throw new Error(`${field.title} 不能大于 ${field.max}`);
    }
    return;
  }

  if (field.type === 'switch' && typeof value !== 'boolean') {
    throw new Error(`${field.title} 必须是布尔值`);
  }

  if (
    field.options &&
    !field.options.some((option) => option.value === value)
  ) {
    throw new Error(`${field.title} 取值无效`);
  }

  if (
    field.pattern &&
    typeof value === 'string' &&
    !field.pattern.test(value)
  ) {
    throw new Error(`${field.title} 格式不正确`);
  }
}

function getStockAnalysisFieldMap(): Map<
  keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS,
  StockAnalysisConfigFieldMeta
> {
  const fieldMap = new Map<
    keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS,
    StockAnalysisConfigFieldMeta
  >();
  for (const section of STOCK_ANALYSIS_CONFIG_FIELDS) {
    for (const field of section.fields) {
      fieldMap.set(field.key, field);
    }
  }
  return fieldMap;
}

function normalizeConfigInput(
  input: Record<string, unknown>,
): {
  effectiveConfig: StockAnalysisConfigMap;
  setValues: Record<string, string>;
  deleteKeys: string[];
} {
  const nextConfig = input || {};
  const fieldMap = getStockAnalysisFieldMap();
  const effectiveConfig: StockAnalysisConfigMap = {
    ...STOCK_ANALYSIS_CONFIG_DEFAULTS,
  };
  const setValues: Record<string, string> = {};
  const deleteKeys: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(nextConfig)) {
    const key = rawKey as keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS;
    const field = fieldMap.get(key);
    if (!field) {
      throw new Error(`不支持的配置项: ${rawKey}`);
    }
    let value: StockAnalysisConfigValue;
    if (field.type === 'number') {
      value = Number(rawValue);
    } else if (field.type === 'switch') {
      // Handle string "false"/"0"/"no" correctly instead of Boolean()
      if (typeof rawValue === 'string') {
        value = rawValue !== 'false' && rawValue !== '0' && rawValue !== 'no' && rawValue !== '';
      } else {
        value = Boolean(rawValue);
      }
    } else {
      value = String(rawValue ?? '').trim();
    }
    validateFieldValue(field, value);
    effectiveConfig[key] = value;
    const defaultValue = STOCK_ANALYSIS_CONFIG_DEFAULTS[key];
    if (value === defaultValue) {
      deleteKeys.push(key);
      continue;
    }
    setValues[key] = String(value);
  }

  return {
    effectiveConfig,
    setValues,
    deleteKeys,
  };
}

function parsePresetConfigJson(input: string): StockAnalysisConfigMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(t('stock.auto_d68c8c', {}, undefined));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(t('stock.auto_d68c8c', {}, undefined));
  }
  return normalizeConfigInput(parsed as Record<string, unknown>).effectiveConfig;
}

function applyRawConfigEntries(entries: Array<{ key: string; value: string }>): {
  config: StockAnalysisConfigMap;
  updatedAt: string | null;
} {
  const config: StockAnalysisConfigMap = {
    ...STOCK_ANALYSIS_CONFIG_DEFAULTS,
  };
  let updatedAt: string | null = null;

  for (const entry of entries) {
    const key = entry.key as keyof typeof STOCK_ANALYSIS_CONFIG_DEFAULTS;
    if (!(key in STOCK_ANALYSIS_CONFIG_DEFAULTS)) continue;
    config[key] = coerceConfigValue(key, entry.value);
    const updatedValue =
      'updated_at' in entry && typeof entry.updated_at === 'string'
        ? entry.updated_at
        : null;
    if (updatedValue && (!updatedAt || updatedValue > updatedAt)) {
      updatedAt = updatedValue;
    }
  }

  return { config, updatedAt };
}

function toConfigHistoryItem(
  record: StockAnalysisConfigHistoryRecord,
): StockAnalysisConfigHistoryItem {
  const entries = JSON.parse(record.config_entries_json) as Array<{
    key: string;
    value: string;
  }>;
  const changedKeys = JSON.parse(record.changed_keys_json) as string[];
  return {
    id: record.id,
    version: String(record.version),
    config: applyRawConfigEntries(entries).config,
    changedKeys: Array.isArray(changedKeys)
      ? changedKeys.filter((value): value is string => typeof value === 'string')
      : [],
    createdAt: record.created_at,
  };
}

export function getStockAnalysisConfigMeta(): {
  sections: StockAnalysisConfigSectionMeta[];
  defaults: StockAnalysisConfigMap;
  presets: StockAnalysisConfigPresetMeta[];
} {
  return {
    sections: STOCK_ANALYSIS_CONFIG_FIELDS,
    defaults: { ...STOCK_ANALYSIS_CONFIG_DEFAULTS },
    presets: STOCK_ANALYSIS_CONFIG_PRESETS.map((preset) => ({
      ...preset,
      values: { ...preset.values },
    })),
  };
}

export async function getStockAnalysisConfig(): Promise<{ config: StockAnalysisConfigMap; configVersion: string; updatedAt: string | null; }> {
  const rawEntries = await getStockAnalysisConfigEntries();
  const { config, updatedAt } = applyRawConfigEntries(rawEntries);

  return {
    config,
    configVersion: await getStockAnalysisConfigVersion(),
    updatedAt,
  };
}

export async function updateStockAnalysisConfig(input: {
  configVersion?: string;
  config?: Record<string, unknown>;
}): Promise<{ ok: true; configVersion: string; }> {
  const normalized = normalizeConfigInput(input.config || {});
  const result = await updateStockAnalysisConfigEntries({
    expectedVersion: input.configVersion,
    setValues: normalized.setValues,
    deleteKeys: normalized.deleteKeys,
  });

  return {
    ok: true,
    configVersion: result.configVersion,
  };
}

export async function listStockAnalysisConfigHistoryItems(input: {
  limit?: number;
} = {}): Promise<{ items: StockAnalysisConfigHistoryItem[]; }> {
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 10));
  return {
    items: (await listStockAnalysisConfigHistory(limit)).map((item) =>
      toConfigHistoryItem(item),
    ),
  };
}

export async function rollbackStockAnalysisConfigHistoryItem(input: {
  id?: string;
  configVersion?: string;
}): Promise<{ ok: true; configVersion: string; historyId: string | null; }> {
  const id = String(input.id || '').trim();
  if (!id) {
    throw new Error(t('stock.auto_d268f1', {}, undefined));
  }
  const existing = await getStockAnalysisConfigHistory(id);
  if (!existing) {
    throw new Error(t('stock.configHistoryNotFound', {}, undefined));
  }
  const result = await restoreStockAnalysisConfigHistory({
    id,
    expectedVersion: input.configVersion,
  });
  return {
    ok: true,
    configVersion: result.configVersion,
    historyId: result.historyId,
  };
}

export async function listStockAnalysisCustomPresets(): Promise<{ items: StockAnalysisConfigPresetRecord[]; }> {
  return {
    items: (await listStockAnalysisConfigPresets()).map((preset) => ({
      id: preset.id,
      title: preset.title,
      description: preset.description || '',
      values: parsePresetConfigJson(preset.config_json),
      createdAt: preset.created_at,
      updatedAt: preset.updated_at,
    })),
  };
}

export async function saveStockAnalysisCustomPreset(input: {
  id?: string;
  title?: string;
  description?: string | null;
  config?: Record<string, unknown>;
}): Promise<{ ok: true; preset: StockAnalysisConfigPresetRecord; }> {
  const title = String(input.title || '').trim();
  if (!title) {
    throw new Error(t('stock.auto_b7079c', {}, undefined));
  }

  const presetId =
    String(input.id || '').trim() ||
    `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (STOCK_ANALYSIS_CONFIG_PRESET_IDS.has(presetId)) {
    throw new Error(t('stock.auto_81a797', {}, undefined));
  }

  const effectiveConfig = normalizeConfigInput(input.config || {}).effectiveConfig;
  await upsertStockAnalysisConfigPreset({
    id: presetId,
    title,
    description: String(input.description || '').trim() || null,
    config_json: JSON.stringify(effectiveConfig),
  });

  const saved = (await listStockAnalysisConfigPresets()).find(
    (preset) => preset.id === presetId,
  );
  if (!saved) {
    throw new Error(t('stock.auto_5a21c7', {}, undefined));
  }

  return {
    ok: true,
    preset: {
      id: saved.id,
      title: saved.title,
      description: saved.description || '',
      values: parsePresetConfigJson(saved.config_json),
      createdAt: saved.created_at,
      updatedAt: saved.updated_at,
    },
  };
}

export async function deleteStockAnalysisCustomPreset(input: { id?: string }): Promise<{ ok: true; }> {
  const presetId = String(input.id || '').trim();
  if (!presetId) {
    throw new Error(t('stock.auto_437eca', {}, undefined));
  }
  if (STOCK_ANALYSIS_CONFIG_PRESET_IDS.has(presetId)) {
    throw new Error(t('stock.auto_676609', {}, undefined));
  }
  await deleteStockAnalysisConfigPreset(presetId);
  return { ok: true };
}
