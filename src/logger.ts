import fs from 'fs';
import path from 'path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { getRequestContext } from './request-context.js';

/**
 * Minimal inline .env reader for logger bootstrap.
 * Cannot import env.ts here (circular dep: env.ts -> logger.ts).
 * Only reads keys not already present in process.env.
 */
function bootstrapEnvKeys(keys: string[]): void {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try { content = fs.readFileSync(envFile, 'utf-8'); } catch { return; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!keys.includes(key) || process.env[key]) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (value) process.env[key] = value;
  }
}

bootstrapEnvKeys([
  'LOG_LEVEL', 'NANOCLAW_LOG_DIR', 'NANOCLAW_LOG_STDOUT', 'NANOCLAW_LOG_CHANNEL',
  'NANOCLAW_LOG_MAX_SIZE', 'NANOCLAW_LOG_MAX_FILES', 'NANOCLAW_LOG_CONSOLE_FORMAT',
]);

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_CHANNEL = process.env.NANOCLAW_LOG_CHANNEL || 'nanoclaw';

type ConsoleLogFormat = 'pretty' | 'json';

function isStdoutLoggingEnabled(): boolean {
  const raw = String(process.env.NANOCLAW_LOG_STDOUT || '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

function resolveConsoleLogFormat(): ConsoleLogFormat {
  const explicit = String(process.env.NANOCLAW_LOG_CONSOLE_FORMAT || '')
    .trim()
    .toLowerCase();
  if (explicit === 'json') return 'json';
  if (explicit === 'pretty') return 'pretty';

  const legacy = String(process.env.NANOCLAW_LOG_STDOUT || '')
    .trim()
    .toLowerCase();
  if (legacy === 'json') return 'json';
  return 'pretty';
}

const LOG_STDOUT_ENABLED = isStdoutLoggingEnabled();
const LOG_CONSOLE_FORMAT = resolveConsoleLogFormat();

function formatShanghaiTimestamp(date: Date): string {
  const offset = 8 * 60 * 60 * 1000;
  const sh = new Date(date.getTime() + offset);
  const y = sh.getUTCFullYear();
  const mo = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sh.getUTCDate()).padStart(2, '0');
  const h = String(sh.getUTCHours()).padStart(2, '0');
  const mi = String(sh.getUTCMinutes()).padStart(2, '0');
  const s = String(sh.getUTCSeconds()).padStart(2, '0');
  const ms = String(sh.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms}`;
}

function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+)\s*(k|m|g)?b?$/i);
  if (!match) return 50 * 1024 * 1024;
  const num = parseInt(match[1], 10);
  switch ((match[2] || '').toLowerCase()) {
    case 'k': return num * 1024;
    case 'g': return num * 1024 * 1024 * 1024;
    case 'm': default: return num * 1024 * 1024;
  }
}

function resolveLogDir(): string {
  const custom = process.env.NANOCLAW_LOG_DIR;
  const fallback = path.join(process.cwd(), 'logs');
  const candidates = custom ? [custom, fallback] : [fallback];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      if (dir !== fallback) {
        // eslint-disable-next-line no-console
        console.error(`[logger] Cannot write to ${dir}, falling back to ${fallback}`);
      }
    }
  }
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

const LOG_DIR = resolveLogDir();
const LOG_MAX_SIZE = parseSize(process.env.NANOCLAW_LOG_MAX_SIZE || '50m');
const LOG_MAX_FILES = Math.max(1, parseInt(process.env.NANOCLAW_LOG_MAX_FILES || '5', 10) || 5);

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

const PRETTY_LINE_MAX = 420;
const PRETTY_IGNORED_KEYS = new Set([
  'level',
  'log_level',
  'datetime',
  'message',
  'pid',
  'channel',
  'service',
  'module',
  'business',
  'requestId',
]);
const PRETTY_FIELD_ORDER = [
  'method',
  'path',
  'statusCode',
  'durationMs',
  'clientIp',
  'statementType',
  'sqlPreview',
  'paramCount',
  'paramsPreview',
  'provider',
  'model',
  'endpoint',
  'status',
  'usage',
  'aiRequestId',
  'kind',
];

function truncatePrettyValue(text: string, maxLength = PRETTY_LINE_MAX): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 16))}...[truncated]`;
}

function formatPrettyFieldValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(truncatePrettyValue(value));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return truncatePrettyValue(JSON.stringify(value));
  }
  if (typeof value === 'object') {
    return truncatePrettyValue(JSON.stringify(value));
  }
  return JSON.stringify(String(value));
}

function comparePrettyKeys(a: string, b: string): number {
  const aIndex = PRETTY_FIELD_ORDER.indexOf(a);
  const bIndex = PRETTY_FIELD_ORDER.indexOf(b);
  if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
  if (aIndex === -1) return 1;
  if (bIndex === -1) return -1;
  return aIndex - bIndex;
}

export function formatPrettyLogRecord(record: Record<string, unknown>): string {
  const timestamp = String(record.datetime || formatShanghaiTimestamp(new Date()));
  const level = String(record.log_level || 'info').toUpperCase().padEnd(5, ' ');
  const moduleName = String(record.module || record.business || record.service || 'app');
  const requestId = typeof record.requestId === 'string' ? record.requestId : '';
  const message = String(record.message || '');

  const prefixParts = [`${timestamp} ${level}`, `[${moduleName}]`];
  if (requestId) {
    prefixParts.push(`[req:${requestId}]`);
  }

  const extras = Object.entries(record)
    .filter(([key, value]) => !PRETTY_IGNORED_KEYS.has(key) && value !== undefined)
    .sort(([a], [b]) => comparePrettyKeys(a, b))
    .map(([key, value]) => `${key}=${formatPrettyFieldValue(value)}`);

  return [prefixParts.join(' '), message, extras.join(' ')].filter(Boolean).join(' ');
}

/**
 * Writable stream that rotates the underlying file when it exceeds maxSize.
 * Rotation renames file -> file.1, file.1 -> file.2, etc., up to maxFiles.
 */
class RotatingFileStream extends Writable {
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;
  private currentSize: number;
  private stream: fs.WriteStream;

  constructor(filePath: string, maxSize: number, maxFiles: number) {
    super();
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;
    try {
      this.currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    } catch {
      this.currentSize = 0;
    }
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.currentSize += buf.length;

    if (this.currentSize > this.maxSize) {
      this.stream.end((endErr?: Error | null) => {
        if (endErr) { callback(endErr); return; }
        try {
          this.rotate();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
        this.currentSize = buf.length;
        this.stream.write(buf, callback);
      });
      return;
    }

    this.stream.write(buf, callback);
  }

  private rotate(): void {
    const oldest = `${this.filePath}.${this.maxFiles}`;
    try { fs.unlinkSync(oldest); } catch { /* may not exist */ }

    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? `${this.filePath}.1` : `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      try { fs.renameSync(src, dst); } catch { /* may not exist */ }
    }
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // eslint-disable-next-line no-console
      console.error(`[logger] Failed to rotate ${this.filePath}`);
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.stream.end(callback);
  }
}

/**
 * Filters pino JSON lines by level and forwards matching lines
 * to a target writable stream. Supports exact match or minimum level.
 * Buffers partial lines across _write calls and respects backpressure.
 */
class LevelFilterStream extends Writable {
  private target: Writable;
  private minLevel: number | undefined;
  private exactLevel: number | undefined;
  private partial: string = '';

  constructor(target: Writable, opts: { minLevel?: number; exactLevel?: number }) {
    super();
    this.target = target;
    this.minLevel = opts.minLevel;
    this.exactLevel = opts.exactLevel;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const text = this.partial + chunk.toString();
      const segments = text.split('\n');
      this.partial = segments.pop() ?? '';

      let needsDrain = false;
      for (const line of segments) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { level?: number };
          const lvl = parsed.level ?? 0;
          const match = this.exactLevel !== undefined
            ? lvl === this.exactLevel
            : this.minLevel !== undefined && lvl >= this.minLevel;
          if (match) {
            if (!this.target.write(`${line}\n`)) needsDrain = true;
          }
        } catch {
          // non-JSON from pino internals
        }
      }

      if (needsDrain) {
        this.target.once('drain', () => callback());
      } else {
        callback();
      }
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.partial) {
      try {
        const parsed = JSON.parse(this.partial) as { level?: number };
        const lvl = parsed.level ?? 0;
        const match = this.exactLevel !== undefined
          ? lvl === this.exactLevel
          : this.minLevel !== undefined && lvl >= this.minLevel;
        if (match) {
          this.target.write(`${this.partial}\n`);
        }
      } catch {
        // non-JSON remainder
      }
      this.partial = '';
    }
    this.target.end(callback);
  }
}

class PrettyLogStream extends Writable {
  private target: Writable;
  private partial: string = '';

  constructor(target: Writable) {
    super();
    this.target = target;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const text = this.partial + chunk.toString();
      const segments = text.split('\n');
      this.partial = segments.pop() ?? '';

      let needsDrain = false;
      for (const line of segments) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const formatted = `${formatPrettyLogRecord(parsed)}\n`;
          if (!this.target.write(formatted)) needsDrain = true;
        } catch {
          if (!this.target.write(`${line}\n`)) needsDrain = true;
        }
      }

      if (needsDrain) {
        this.target.once('drain', () => callback());
      } else {
        callback();
      }
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.partial) {
      try {
        const parsed = JSON.parse(this.partial) as Record<string, unknown>;
        this.target.write(`${formatPrettyLogRecord(parsed)}\n`);
      } catch {
        this.target.write(`${this.partial}\n`);
      }
      this.partial = '';
    }
    callback();
  }
}

function createLogger() {
  const infoFile = new RotatingFileStream(path.join(LOG_DIR, 'info.log'), LOG_MAX_SIZE, LOG_MAX_FILES);
  const warnFile = new RotatingFileStream(path.join(LOG_DIR, 'warn.log'), LOG_MAX_SIZE, LOG_MAX_FILES);
  const errorFile = new RotatingFileStream(path.join(LOG_DIR, 'error.log'), LOG_MAX_SIZE, LOG_MAX_FILES);

  const streams: pino.StreamEntry[] = [
    { stream: new LevelFilterStream(infoFile, { minLevel: LEVELS.info }) },
    { stream: new LevelFilterStream(warnFile, { exactLevel: LEVELS.warn }) },
    { stream: new LevelFilterStream(errorFile, { minLevel: LEVELS.error }) },
  ];

  if (LOG_STDOUT_ENABLED) {
    const stdoutStream = LOG_CONSOLE_FORMAT === 'pretty'
      ? new PrettyLogStream(process.stdout)
      : process.stdout;
    streams.unshift({ stream: stdoutStream });
  }

  const instance = pino(
    {
      level: LOG_LEVEL,
      messageKey: 'message',
      timestamp: () => `,"datetime":"${formatShanghaiTimestamp(new Date())}"`,
      redact: {
        paths: [
          'errorDetails.apiBody',
        ],
        censor: '[REDACTED]',
      },
      mixin() {
        const requestId = getRequestContext()?.requestId;
        return requestId ? { requestId } : {};
      },
      formatters: {
        level(label, number) {
          return { level: number, log_level: label };
        },
      },
      base: {
        pid: process.pid,
        channel: LOG_CHANNEL,
        service: 'nanoclaw',
      },
    },
    pino.multistream(streams),
  );

  if (LOG_STDOUT_ENABLED) {
    instance.info({ logDir: LOG_DIR, consoleFormat: LOG_CONSOLE_FORMAT }, 'Logger initialized');
  }

  return instance;
}

type AppLogger = ReturnType<typeof createLogger>;

declare global {
  // eslint-disable-next-line no-var
  var __nanoclawLogger: AppLogger | undefined;
  // eslint-disable-next-line no-var
  var __nanoclawLoggerHandlersRegistered: boolean | undefined;
}

export const logger: AppLogger =
  globalThis.__nanoclawLogger || createLogger();
globalThis.__nanoclawLogger = logger;

export type ChildLogger = ReturnType<AppLogger['child']>;

export function createModuleLogger(module: string): ChildLogger {
  return logger.child({ module, business: module });
}

export function createRequestLogger(requestId: string, module?: string): ChildLogger {
  const bindings: Record<string, string> = { requestId };
  if (module) {
    bindings.module = module;
    bindings.business = module;
  }
  return logger.child(bindings);
}

if (!globalThis.__nanoclawLoggerHandlersRegistered) {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });

  globalThis.__nanoclawLoggerHandlersRegistered = true;
}
