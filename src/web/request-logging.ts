import crypto from 'crypto';
import type express from 'express';

import { createModuleLogger } from '../logger.js';
import {
  runWithRequestContext,
  type RequestContext,
} from '../request-context.js';

const httpLog = createModuleLogger('http');
const STATIC_ASSET_RE = /\.(?:js|css|svg|png|ico|map|woff2?|ttf|txt|html)$/i;
const DEFAULT_HTTP_SLOW_MS = parsePositiveInt(
  process.env.NANOCLAW_LOG_HTTP_SLOW_MS,
  1500,
);
const DEFAULT_QUIET_PATH_PATTERNS = [
  '/api/auth/status',
  '/api/browser/status',
  '/api/repo-reviews/runs-summary',
];

interface HttpRequestLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface HttpRequestLoggingOptions {
  logger?: HttpRequestLogger;
  slowMs?: number;
  quietPathPatterns?: string[];
  generateRequestId?: () => string;
}

export interface HttpRequestLogDecisionInput {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  slowMs?: number;
  quietPathPatterns?: string[];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parsePatternList(raw: string | undefined): string[] {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isReadMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
}

function isStaticOrHealthPath(pathname: string): boolean {
  return (
    pathname === '/healthz' ||
    pathname === '/readyz' ||
    pathname.startsWith('/health') ||
    STATIC_ASSET_RE.test(pathname)
  );
}

function matchQuietPath(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith('*')) {
      return pathname.startsWith(pattern.slice(0, -1));
    }
    return pathname === pattern;
  });
}

function sanitizeIncomingRequestId(raw: string | undefined): string | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 128) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function getClientIp(req: express.Request): string {
  const forwardedFor = req.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || forwardedFor;
  }
  return req.ip || '';
}

export function shouldLogHttpRequest(
  input: HttpRequestLogDecisionInput,
): boolean {
  const slowMs = input.slowMs ?? DEFAULT_HTTP_SLOW_MS;
  const quietPathPatterns = input.quietPathPatterns ?? [
    ...DEFAULT_QUIET_PATH_PATTERNS,
    ...parsePatternList(process.env.NANOCLAW_LOG_HTTP_IGNORE_PATHS),
  ];
  const isRead = isReadMethod(input.method);
  const isSuccess = input.statusCode < 400;
  const isSlow = input.durationMs >= slowMs;

  if (!isSuccess) return true;
  if (isSlow) return true;
  if (isStaticOrHealthPath(input.path)) return false;
  if (isRead && input.statusCode === 304) return false;
  if (!isRead) return true;
  if (matchQuietPath(input.path, quietPathPatterns)) return false;
  return true;
}

export function createHttpRequestLoggingMiddleware(
  options: HttpRequestLoggingOptions = {},
): express.RequestHandler {
  const logger = options.logger || httpLog;
  const slowMs = options.slowMs ?? DEFAULT_HTTP_SLOW_MS;
  const quietPathPatterns = options.quietPathPatterns ?? [
    ...DEFAULT_QUIET_PATH_PATTERNS,
    ...parsePatternList(process.env.NANOCLAW_LOG_HTTP_IGNORE_PATHS),
  ];
  const generateRequestId = options.generateRequestId || crypto.randomUUID;

  return (req, res, next) => {
    const requestId =
      sanitizeIncomingRequestId(req.get('x-request-id')) ||
      sanitizeIncomingRequestId(req.get('x-correlation-id')) ||
      generateRequestId();
    const requestContext: RequestContext = {
      requestId,
      source: 'http',
      method: req.method,
      path: req.path,
      startedAt: Date.now(),
    };

    (req as express.Request & { requestId?: string }).requestId = requestId;
    res.setHeader('x-request-id', requestId);

    runWithRequestContext(requestContext, () => {
      res.on('finish', () => {
        const durationMs = Date.now() - (requestContext.startedAt || Date.now());
        if (!shouldLogHttpRequest({
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs,
          slowMs,
          quietPathPatterns,
        })) {
          return;
        }

        runWithRequestContext(requestContext, () => {
          const logData = {
            requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs,
            clientIp: getClientIp(req),
          };
          if (res.statusCode >= 400 || durationMs >= slowMs) {
            logger.warn(logData, 'HTTP request completed');
          } else {
            logger.info(logData, 'HTTP request completed');
          }
        });
      });

      next();
    });
  };
}
