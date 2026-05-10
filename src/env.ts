import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

interface EnvFileCacheEntry {
  exists: boolean;
  mtimeMs: number;
  size: number;
  values: Record<string, string>;
}

let envFileCache: EnvFileCacheEntry | null = null;

function loadEnvFileValues(): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let stats: fs.Stats;
  try {
    stats = fs.statSync(envFile);
  } catch (err) {
    if (
      envFileCache &&
      !envFileCache.exists &&
      envFileCache.mtimeMs === 0 &&
      envFileCache.size === 0
    ) {
      return envFileCache.values;
    }
    logger.debug({ err }, '.env file not found, using defaults');
    envFileCache = { exists: false, mtimeMs: 0, size: 0, values: {} };
    return envFileCache.values;
  }

  if (
    envFileCache &&
    envFileCache.exists &&
    envFileCache.mtimeMs === stats.mtimeMs &&
    envFileCache.size === stats.size
  ) {
    return envFileCache.values;
  }

  const content = fs.readFileSync(envFile, 'utf-8');
  const values: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) values[key] = value;
  }

  envFileCache = {
    exists: true,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    values,
  };
  return values;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envValues = loadEnvFileValues();
  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const [key, value] of Object.entries(envValues)) {
    if (wanted.has(key)) {
      result[key] = value;
    }
  }

  return result;
}

export function hydrateProcessEnvFromEnvFile(
  keys: string[],
  target: NodeJS.ProcessEnv = process.env,
): void {
  const envValues = readEnvFile(keys);
  for (const key of keys) {
    if (target[key]) continue;
    const value = envValues[key];
    if (value) {
      target[key] = value;
    }
  }
}

/** @internal - for tests only. */
export function _resetEnvFileCacheForTests(): void {
  envFileCache = null;
}
