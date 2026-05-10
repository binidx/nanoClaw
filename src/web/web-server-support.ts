import type { Request } from 'express';

import {
  getConfigKeyMetadata,
  getEffectiveWebConfig,
  WEB_CONFIG_KEYS,
} from '../config-store.js';
import { isFeatureEnabled, isTrustedRequestOrigin } from '../auth/web-security.js';

export function hasTrustedOrigin(
  req: Pick<Request, 'headers'>,
  isTrustedOrigin: typeof isTrustedRequestOrigin = isTrustedRequestOrigin,
): boolean {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin) {
    return isTrustedOrigin(origin, req.headers.host);
  }

  const refererHeader = req.headers.referer;
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  if (referer) {
    try {
      return isTrustedOrigin(new URL(referer).origin, req.headers.host);
    } catch {
      return false;
    }
  }

  return true;
}

export function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function parseBoundedInteger(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, parsed));
}

export function createAuditMutation(deps: {
  logger: { info: (obj: object, msg: string) => void };
  getAuthenticatedUsername: (cookieHeader?: string) => string | null;
  getRequestClientKey: (
    req: Pick<Request, 'ip' | 'headers' | 'socket'>,
  ) => string;
}) {
  return function auditMutation(
    req: Request,
    operation: string,
    risk: 'normal' | 'high' = 'normal',
  ): void {
    deps.logger.info(
      {
        operation,
        risk,
        actor: deps.getAuthenticatedUsername(req.headers.cookie),
        client: deps.getRequestClientKey(req),
        method: req.method,
        path: req.path,
      },
      'Protected mutation request',
    );
  };
}

export function applyProcessConfigSideEffects(
  entries: Record<string, string | null | undefined>,
  deps: {
    isFeatureEnabledFn?: typeof isFeatureEnabled;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const isEnabled = deps.isFeatureEnabledFn || isFeatureEnabled;
  const env = deps.env || process.env;
  if ('ALLOW_INSECURE_TLS' in entries) {
    const enabled = isEnabled(entries.ALLOW_INSECURE_TLS);
    if (enabled) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    else delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}

export function summarizeConfigEffects(
  keys: string[],
  deps: {
    webConfigKeys?: readonly string[];
    getConfigKeyMetadataFn?: typeof getConfigKeyMetadata;
  } = {},
) {
  const webConfigKeys = deps.webConfigKeys || WEB_CONFIG_KEYS;
  const getMetadata = deps.getConfigKeyMetadataFn || getConfigKeyMetadata;
  const summary: Record<'instant' | 'new_agent' | 'restart', string[]> = {
    instant: [],
    new_agent: [],
    restart: [],
  };

  for (const key of keys) {
    if (!webConfigKeys.includes(key)) continue;
    const metadata = getMetadata(key as (typeof WEB_CONFIG_KEYS)[number]);
    summary[metadata.effect].push(metadata.label);
  }

  return summary;
}

export async function getSanitizedWebConfig(
  sensitiveConfigKeys: ReadonlySet<string>,
  getEffectiveWebConfigFn: typeof getEffectiveWebConfig = getEffectiveWebConfig,
): Promise<Record<string, string>> {
  const config = await getEffectiveWebConfigFn();
  for (const key of sensitiveConfigKeys) {
    if (key in config) config[key] = '';
  }
  return config;
}
