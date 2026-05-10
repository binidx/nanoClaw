import type {
  StockAnalysisConfigField,
  StockAnalysisConfigSection,
  StockAnalysisReportType,
  StockAnalysisSelectOption,
  StockAnalysisStrategyPreset,
  StockMarketScope,
} from './types';

export function getDefaultMarketScopeOptions(
  t: (key: string) => string,
): StockAnalysisSelectOption[] {
  return [
    { value: 'both', label: t('stock.A股港股') },
    { value: 'cn', label: t('stock.A股') },
    { value: 'hk', label: t('stock.港股') },
    { value: 'us', label: t('stock.美股') },
    { value: 'all', label: t('stock.全部市场') },
  ];
}

export function getDefaultReportTypeOptions(
  t: (key: string) => string,
): StockAnalysisSelectOption[] {
  return [
    { value: 'brief', label: t('stock.简版') },
    { value: 'standard', label: t('stock.标准') },
    { value: 'detailed', label: t('stock.详细') },
  ];
}

export function getDefaultStrategyOptions(
  t: (key: string) => string,
): StockAnalysisSelectOption[] {
  return [
    { value: 'bull_trend', label: t('stock.多头趋势') },
    { value: 'shrink_pullback', label: t('stock.缩量回踩') },
    { value: 'volume_breakout', label: t('stock.放量突破') },
    { value: 'ma_golden_cross', label: t('stock.均线金叉') },
    { value: 'box_oscillation', label: t('stock.箱体震荡') },
  ];
}

export function isStockMarketScope(value: unknown): value is StockMarketScope {
  return (
    value === 'cn' ||
    value === 'hk' ||
    value === 'us' ||
    value === 'both' ||
    value === 'all'
  );
}

export function isStockAnalysisReportType(
  value: unknown,
): value is StockAnalysisReportType {
  return value === 'brief' || value === 'standard' || value === 'detailed';
}

export function isStockAnalysisStrategyPreset(
  value: unknown,
): value is StockAnalysisStrategyPreset {
  return (
    value === 'bull_trend' ||
    value === 'shrink_pullback' ||
    value === 'volume_breakout' ||
    value === 'ma_golden_cross' ||
    value === 'box_oscillation'
  );
}

export function resolveConfigMarketScope(
  value: string | number | boolean | undefined,
): StockMarketScope | null {
  return isStockMarketScope(value) ? value : null;
}

export function resolveConfigReportType(
  value: string | number | boolean | undefined,
): StockAnalysisReportType | null {
  return isStockAnalysisReportType(value) ? value : null;
}

export function resolveConfigStrategyPreset(
  value: string | number | boolean | undefined,
): StockAnalysisStrategyPreset | null {
  return isStockAnalysisStrategyPreset(value) ? value : null;
}

function findConfigField(
  sections: StockAnalysisConfigSection[],
  key: string,
): StockAnalysisConfigField | null {
  for (const section of sections) {
    const field = section.fields.find((item) => item.key === key);
    if (field) {
      return field;
    }
  }
  return null;
}

export function resolveSelectOptions(
  sections: StockAnalysisConfigSection[],
  key: string,
  fallback: StockAnalysisSelectOption[],
): StockAnalysisSelectOption[] {
  const options = findConfigField(sections, key)?.options;
  if (!Array.isArray(options) || options.length === 0) {
    return fallback;
  }
  return options;
}
