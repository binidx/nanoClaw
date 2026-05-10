import { createModuleLogger } from '../logger.js';

export type ModelSerializationFormat = 'json' | 'toon';
export type ModelSerializationMode = 'auto' | 'json' | 'toon';

export interface ModelSerializationHint {
  surface: string;
  mode?: ModelSerializationMode;
  minSavingsRatio?: number;
}

export interface ModelSerializationStats {
  sourceBytes: number;
  jsonBytes: number;
  jsonTokens: number;
  toonBytes: number | null;
  toonTokens: number | null;
  outputBytes: number;
  outputTokens: number;
  savingsRatio: number;
}

export interface ModelSerializationResult {
  format: ModelSerializationFormat;
  text: string;
  stats: ModelSerializationStats;
}

const serializationLog = createModuleLogger('model-serialization');
const DEFAULT_MIN_SAVINGS_RATIO = 0.12;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeStructuredValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredValue(entry));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        entry === undefined ||
        typeof entry === 'function' ||
        typeof entry === 'symbol'
      ) {
        continue;
      }
      output[key] = normalizeStructuredValue(entry);
    }
    return output;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: () => unknown }).toJSON === 'function'
  ) {
    try {
      return normalizeStructuredValue(
        (value as { toJSON: () => unknown }).toJSON(),
      );
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStructuredValue(value));
}

function parseMode(value: string | undefined): ModelSerializationMode {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === 'json' || normalized === 'toon' ? normalized : 'auto';
}

function parseSurfaces(raw: string | undefined): Set<string> | null {
  const normalized = String(raw || '').trim();
  if (!normalized || normalized === '*') return null;
  const items = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function isSurfaceEnabled(surface: string): boolean {
  const allowlist = parseSurfaces(
    process.env.NANOCLAW_MODEL_SERIALIZATION_SURFACES,
  );
  return !allowlist || allowlist.has(surface);
}

function getMinSavingsRatio(override?: number): number {
  if (
    typeof override === 'number' &&
    Number.isFinite(override) &&
    override >= 0
  ) {
    return override;
  }
  const parsed = Number.parseFloat(
    String(process.env.NANOCLAW_MODEL_SERIALIZATION_MIN_SAVINGS_RATIO || ''),
  );
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_MIN_SAVINGS_RATIO;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isSafeBareScalar(value: string, forCell: boolean): boolean {
  if (!value) return false;
  if (value.trim() !== value) return false;
  if (/[\n\r\t]/.test(value)) return false;
  if (forCell) {
    return !/[{},[\]":]/.test(value);
  }
  return !/[{},[\]":]/.test(value);
}

function renderScalar(
  value: string | number | boolean | null,
  forCell: boolean,
): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return isSafeBareScalar(value, forCell) ? value : JSON.stringify(value);
}

function hasUnsafeDelimitedCell(value: string): boolean {
  return /[,\n\r\t]/.test(value);
}

function shouldFallbackDelimitedArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((entry) => isScalar(entry))) {
    return value.some(
      (entry) => typeof entry === 'string' && hasUnsafeDelimitedCell(entry),
    );
  }
  if (!value.every((entry) => isPlainObject(entry))) return false;
  return value.some((entry) =>
    Object.values(entry).some(
      (cell) => typeof cell === 'string' && hasUnsafeDelimitedCell(cell),
    ),
  );
}

function collectUniformObjectArrayKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    for (const [key, cell] of Object.entries(entry)) {
      if (cell !== undefined && !isScalar(cell)) return null;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.length > 0 ? keys : null;
}

function tryRenderUniformObjectArray(
  value: unknown,
  indent = '',
  label?: string,
): string | null {
  const keys = collectUniformObjectArrayKeys(value);
  if (!keys || !Array.isArray(value)) return null;
  for (const entry of value as Record<string, unknown>[]) {
    for (const key of keys) {
      const cell = entry[key];
      if (typeof cell === 'string' && hasUnsafeDelimitedCell(cell)) {
        return null;
      }
    }
  }
  const prefix = label ? `${label}[${value.length}]` : `[${value.length}]`;
  const lines = [`${indent}${prefix}{${keys.join(',')}}:`];
  for (const entry of value as Record<string, unknown>[]) {
    lines.push(
      `${indent}  ${keys
        .map((key) => {
          const cell = entry[key];
          return renderScalar(
            (cell === undefined ? null : cell) as
              | string
              | number
              | boolean
              | null,
            true,
          );
        })
        .join(',')}`,
    );
  }
  return lines.join('\n');
}

function tryRenderScalarArray(
  value: unknown,
  indent = '',
  label?: string,
): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((entry) => isScalar(entry))) return null;
  if (
    value.some(
      (entry) => typeof entry === 'string' && hasUnsafeDelimitedCell(entry),
    )
  ) {
    return null;
  }
  const prefix = label ? `${label}[${value.length}]` : `[${value.length}]`;
  return `${indent}${prefix}: ${(
    value as Array<string | number | boolean | null>
  )
    .map((entry) => renderScalar(entry, true))
    .join(',')}`;
}

function renderToonValue(
  value: unknown,
  indent = '',
  label?: string,
): string | null {
  if (isScalar(value)) {
    if (!label) return null;
    return `${indent}${label}: ${renderScalar(value, false)}`;
  }

  const uniformArray = tryRenderUniformObjectArray(value, indent, label);
  if (uniformArray) return uniformArray;

  const scalarArray = tryRenderScalarArray(value, indent, label);
  if (scalarArray) return scalarArray;

  if (Array.isArray(value)) {
    if (shouldFallbackDelimitedArray(value)) return null;
    if (value.length === 0) {
      return label ? `${indent}${label}[0]:` : `${indent}[0]:`;
    }
    const prefix = label ? `${indent}${label}:` : `${indent}-`;
    const lines = [prefix];
    for (const entry of value) {
      if (isScalar(entry)) {
        lines.push(`${indent}  - ${renderScalar(entry, false)}`);
        continue;
      }
      const nested = renderToonValue(entry, `${indent}    `);
      if (!nested) return null;
      lines.push(`${indent}  -`);
      lines.push(nested);
    }
    return lines.join('\n');
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return label ? `${indent}${label}: {}` : `${indent}{}`;
    }
    const lines: string[] = [];
    if (label) lines.push(`${indent}${label}:`);
    const baseIndent = label ? `${indent}  ` : indent;
    for (const [key, entry] of entries) {
      if (isScalar(entry)) {
        lines.push(`${baseIndent}${key}: ${renderScalar(entry, false)}`);
        continue;
      }
      const nestedUniform = tryRenderUniformObjectArray(entry, baseIndent, key);
      if (nestedUniform) {
        lines.push(nestedUniform);
        continue;
      }
      const nestedScalarArray = tryRenderScalarArray(entry, baseIndent, key);
      if (nestedScalarArray) {
        lines.push(nestedScalarArray);
        continue;
      }
      const nested = renderToonValue(entry, `${baseIndent}  `);
      if (!nested) return null;
      lines.push(`${baseIndent}${key}:`);
      lines.push(nested);
    }
    return lines.join('\n');
  }

  return null;
}

function maybeLogSerialization(
  surface: string,
  format: ModelSerializationFormat,
  stats: ModelSerializationStats,
): void {
  if (process.env.NANOCLAW_MODEL_SERIALIZATION_DEBUG !== '1') return;
  serializationLog.debug(
    {
      surface,
      format,
      sourceBytes: stats.sourceBytes,
      jsonTokens: stats.jsonTokens,
      toonTokens: stats.toonTokens,
      outputTokens: stats.outputTokens,
      savingsRatio: stats.savingsRatio,
    },
    'Structured model serialization',
  );
}

export function serializeForModel(
  value: unknown,
  hint: ModelSerializationHint,
): ModelSerializationResult {
  const normalized = normalizeStructuredValue(value);
  const jsonText = safeJsonStringify(normalized);
  const jsonTokens = estimateTokens(jsonText);
  const sourceBytes = Buffer.byteLength(safeJsonStringify(value), 'utf-8');
  const requestedMode =
    hint.mode || parseMode(process.env.NANOCLAW_MODEL_SERIALIZATION_MODE);
  const minSavingsRatio = getMinSavingsRatio(hint.minSavingsRatio);
  const surfaceEnabled = isSurfaceEnabled(hint.surface);
  const toonText = surfaceEnabled ? renderToonValue(normalized) : null;
  const toonTokens = toonText ? estimateTokens(toonText) : null;
  const toonBytes = toonText ? Buffer.byteLength(toonText, 'utf-8') : null;

  let format: ModelSerializationFormat = 'json';
  let outputText = jsonText;

  if (requestedMode === 'toon' && toonText) {
    format = 'toon';
    outputText = toonText;
  } else if (
    requestedMode === 'auto' &&
    toonText &&
    toonTokens !== null &&
    jsonTokens > 0 &&
    (jsonTokens - toonTokens) / jsonTokens >= minSavingsRatio
  ) {
    format = 'toon';
    outputText = toonText;
  }

  const outputTokens = estimateTokens(outputText);
  const stats: ModelSerializationStats = {
    sourceBytes,
    jsonBytes: Buffer.byteLength(jsonText, 'utf-8'),
    jsonTokens,
    toonBytes,
    toonTokens,
    outputBytes: Buffer.byteLength(outputText, 'utf-8'),
    outputTokens,
    savingsRatio: jsonTokens > 0 ? (jsonTokens - outputTokens) / jsonTokens : 0,
  };
  maybeLogSerialization(hint.surface, format, stats);
  return {
    format,
    text: outputText,
    stats,
  };
}

export function formatStructuredPromptValue(
  value: unknown,
  hint: ModelSerializationHint,
): string {
  const serialized = serializeForModel(value, hint);
  return `[FORMAT: ${serialized.format.toUpperCase()}]\n${serialized.text}`;
}

export const __testing = {
  estimateTokens,
  collectUniformObjectArrayKeys,
  hasUnsafeDelimitedCell,
  normalizeStructuredValue,
  renderToonValue,
  shouldFallbackDelimitedArray,
  tryRenderUniformObjectArray,
  tryRenderScalarArray,
};
