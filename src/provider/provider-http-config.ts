import type { AiProvider } from '../db/assistants.js';

export interface ProviderHttpConfig {
  userAgent: string;
  headers: Record<string, string>;
}

type ProviderHttpConfigSource =
  | Pick<AiProvider, 'extra_config'>
  | Record<string, unknown>
  | string
  | null
  | undefined;

const USER_AGENT_KEYS = ['userAgent', 'user_agent'] as const;
const HEADER_KEYS = ['headers', 'httpHeaders', 'custom_headers'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRawExtraConfig(
  source: ProviderHttpConfigSource | Record<string, unknown>,
): Record<string, unknown> {
  const raw = typeof source === 'string'
    ? source
    : source && 'extra_config' in source
      ? source.extra_config
      : source;

  if (!raw) return {};
  if (isPlainObject(raw)) return { ...raw };
  if (typeof raw !== 'string') return {};

  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainObject(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function normalizeStringRecord(input: unknown): Record<string, string> {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return normalizeStringRecord(parsed);
    } catch {
      throw new Error('custom_headers must be a JSON object');
    }
  }

  if (!isPlainObject(input)) {
    if (input === undefined || input === null || input === '') return {};
    throw new Error('custom_headers must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedValue) continue;
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function stripKnownHttpConfigKeys(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...input };
  for (const key of USER_AGENT_KEYS) {
    delete next[key];
  }
  for (const key of HEADER_KEYS) {
    delete next[key];
  }
  return next;
}

function readFirstKnownValue(
  input: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (key in input) return input[key];
  }
  return undefined;
}

export function getProviderHttpConfig(
  source: ProviderHttpConfigSource,
): ProviderHttpConfig {
  const raw = readRawExtraConfig(source);
  return {
    userAgent: normalizeOptionalString(readFirstKnownValue(raw, USER_AGENT_KEYS)),
    headers: normalizeStringRecord(readFirstKnownValue(raw, HEADER_KEYS)),
  };
}

export function buildProviderFetchHeaders(
  provider: Pick<AiProvider, 'extra_config'>,
  baseHeaders: Record<string, string>,
): Record<string, string> {
  const config = getProviderHttpConfig(provider);
  const nextHeaders = {
    ...baseHeaders,
    ...config.headers,
  };
  if (config.userAgent) {
    nextHeaders['User-Agent'] = config.userAgent;
  }
  return nextHeaders;
}

export function buildProviderExtraConfigValue(
  input: {
    extra_config?: unknown;
    user_agent?: unknown;
    userAgent?: unknown;
    custom_headers?: unknown;
    headers?: unknown;
  },
  currentValue?: string | null,
): string | null {
  const rawBase =
    input.extra_config !== undefined
      ? readRawExtraConfig(input.extra_config as Record<string, unknown>)
      : readRawExtraConfig(currentValue);
  const preserved = stripKnownHttpConfigKeys(rawBase);

  const currentConfig = getProviderHttpConfig(rawBase);
  const hasExplicitUserAgent =
    input.user_agent !== undefined || input.userAgent !== undefined;
  const hasExplicitHeaders =
    input.custom_headers !== undefined || input.headers !== undefined;

  const nextUserAgent = hasExplicitUserAgent
    ? normalizeOptionalString(input.user_agent ?? input.userAgent)
    : currentConfig.userAgent;
  const nextHeaders = hasExplicitHeaders
    ? normalizeStringRecord(input.custom_headers ?? input.headers)
    : currentConfig.headers;

  if (nextUserAgent) {
    preserved.userAgent = nextUserAgent;
  }
  if (Object.keys(nextHeaders).length > 0) {
    preserved.headers = nextHeaders;
  }

  return Object.keys(preserved).length > 0
    ? JSON.stringify(preserved)
    : null;
}

export function serializeProviderForClient<T extends Pick<AiProvider, 'extra_config'>>(
  provider: T,
): T & {
  user_agent: string | null;
  custom_headers: Record<string, string> | null;
} {
  const config = getProviderHttpConfig(provider);
  return {
    ...provider,
    user_agent: config.userAgent || null,
    custom_headers:
      Object.keys(config.headers).length > 0 ? config.headers : null,
  };
}
