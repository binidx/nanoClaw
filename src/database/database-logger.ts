import { createModuleLogger } from '../logger.js';
import { getRequestLogFields } from '../request-context.js';

const dbLog = createModuleLogger('db');
const SQL_PREVIEW_LIMIT = 600;
const PARAM_PREVIEW_LIMIT = 240;
const DB_LOG_MODE = normalizeDbLogMode(process.env.NANOCLAW_LOG_DB_MODE);
const DB_SLOW_MS = parsePositiveInt(process.env.NANOCLAW_LOG_DB_SLOW_MS, 200);

type DbLogMode = 'errors' | 'slow' | 'all' | 'off';
type DbOperation = 'queryAll' | 'queryOne' | 'run' | 'exec';

export interface DbQueryLogOptions<T> {
  dialect: string;
  operation: DbOperation;
  sql: string;
  params?: unknown[];
  summarizeResult?: (result: T) => Record<string, unknown>;
}

function normalizeDbLogMode(raw: string | undefined): DbLogMode {
  const normalized = String(raw || '').trim().toLowerCase();
  if (
    normalized === 'errors' ||
    normalized === 'slow' ||
    normalized === 'all' ||
    normalized === 'off'
  ) {
    return normalized;
  }
  return 'slow';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function truncatePreview(value: string, maxLength: number): {
  preview: string;
  totalLength: number;
} {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const totalLength = normalized.length;
  if (totalLength <= maxLength) {
    return { preview: normalized, totalLength };
  }
  return {
    preview: `${normalized.slice(0, Math.max(0, maxLength - 24))}...[truncated]`,
    totalLength,
  };
}

function looksSensitive(value: string): boolean {
  return (
    /^bearer\s+/i.test(value) ||
    /^sk-[A-Za-z0-9_-]{12,}/.test(value) ||
    /^eyJ[A-Za-z0-9_-]{20,}/.test(value) ||
    /^[A-Za-z0-9/+_-]{48,}={0,2}$/.test(value)
  );
}

function summarizeParam(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    if (looksSensitive(value)) return '[REDACTED]';
    const truncated = truncatePreview(value, PARAM_PREVIEW_LIMIT);
    return truncated.totalLength === truncated.preview.length
      ? truncated.preview
      : `${truncated.preview} (${truncated.totalLength} chars)`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return `[array ${value.length}]`;
  if (typeof value === 'object') return '[object]';
  return String(value);
}

function buildSqlFields(sql: string, params: unknown[] = []): Record<string, unknown> {
  const sqlPreview = truncatePreview(sql, SQL_PREVIEW_LIMIT);
  return {
    statementType: sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || 'UNKNOWN',
    sqlPreview: sqlPreview.preview,
    sqlChars: sqlPreview.totalLength,
    paramCount: params.length,
    paramsPreview: params.map((value) => summarizeParam(value)),
  };
}

function shouldLogDbSuccess(durationMs: number): boolean {
  if (DB_LOG_MODE === 'off' || DB_LOG_MODE === 'errors') return false;
  if (DB_LOG_MODE === 'all') return true;
  return durationMs >= DB_SLOW_MS;
}

export async function withDbQueryLogging<T>(
  options: DbQueryLogOptions<T>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    if (shouldLogDbSuccess(durationMs)) {
      const fields = {
        ...getRequestLogFields(),
        kind: 'db_query',
        dialect: options.dialect,
        operation: options.operation,
        durationMs,
        ...buildSqlFields(options.sql, options.params),
        ...(options.summarizeResult ? options.summarizeResult(result) : {}),
      };
      if (durationMs >= DB_SLOW_MS) {
        dbLog.warn(fields, 'DB query slow');
      } else {
        dbLog.info(fields, 'DB query completed');
      }
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    dbLog.error(
      {
        ...getRequestLogFields(),
        kind: 'db_query',
        dialect: options.dialect,
        operation: options.operation,
        durationMs,
        err,
        ...buildSqlFields(options.sql, options.params),
      },
      'DB query failed',
    );
    throw err;
  }
}

export async function withDbTransactionLogging<T>(
  dialect: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  if (DB_LOG_MODE === 'all') {
    dbLog.info(
      {
        ...getRequestLogFields(),
        kind: 'db_transaction',
        dialect,
        phase: 'begin',
      },
      'DB transaction started',
    );
  }

  try {
    const result = await run();
    const durationMs = Date.now() - startedAt;
    if (DB_LOG_MODE === 'all' || (DB_LOG_MODE === 'slow' && durationMs >= DB_SLOW_MS)) {
      const fields = {
        ...getRequestLogFields(),
        kind: 'db_transaction',
        dialect,
        phase: 'commit',
        durationMs,
      };
      if (durationMs >= DB_SLOW_MS) {
        dbLog.warn(fields, 'DB transaction slow');
      } else {
        dbLog.info(fields, 'DB transaction committed');
      }
    }
    return result;
  } catch (err) {
    dbLog.error(
      {
        ...getRequestLogFields(),
        kind: 'db_transaction',
        dialect,
        phase: 'rollback',
        durationMs: Date.now() - startedAt,
        err,
      },
      'DB transaction rolled back',
    );
    throw err;
  }
}
