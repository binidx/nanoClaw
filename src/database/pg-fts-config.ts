import type { DbEngine } from './engine.js';
import { logger } from '../logger.js';

let cachedConfig: string | null = null;

const PREFERRED_CONFIGS = ['jiebacfg', 'jieba', 'zhparser'] as const;
const FALLBACK_CONFIG = 'simple';
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function configExistsInPg(engine: DbEngine, name: string): Promise<boolean> {
  try {
    const row = await engine.queryOne<{ cfgname: string }>(
      `SELECT cfgname FROM pg_ts_config WHERE cfgname = ?`,
      [name],
    );
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Detects the best available PostgreSQL text search configuration.
 * Priority: env PG_FTS_CONFIG (validated) > jieba > zhparser > simple.
 */
export async function detectPgFtsConfig(engine: DbEngine): Promise<string> {
  if (cachedConfig) return cachedConfig;

  const envOverride = process.env.PG_FTS_CONFIG?.trim();
  if (envOverride) {
    if (!SAFE_IDENTIFIER.test(envOverride)) {
      logger.warn({ value: envOverride }, 'PG_FTS_CONFIG contains invalid characters, ignoring');
    } else if (!(await configExistsInPg(engine, envOverride))) {
      logger.warn({ value: envOverride }, 'PG_FTS_CONFIG references a non-existent text search config, ignoring');
    } else {
      cachedConfig = envOverride;
      logger.info({ ftsConfig: cachedConfig }, 'PG FTS config set from PG_FTS_CONFIG env');
      return cachedConfig;
    }
  }

  for (const name of PREFERRED_CONFIGS) {
    if (await configExistsInPg(engine, name)) {
      cachedConfig = name;
      logger.info({ ftsConfig: name }, 'PG FTS config detected');
      return name;
    }
  }

  cachedConfig = FALLBACK_CONFIG;
  logger.info({ ftsConfig: FALLBACK_CONFIG }, 'PG FTS config: no CJK tokenizer found, using simple');
  return FALLBACK_CONFIG;
}

export function getPgFtsConfig(): string {
  return cachedConfig ?? FALLBACK_CONFIG;
}

export function resetPgFtsConfigCache(): void {
  cachedConfig = null;
}
