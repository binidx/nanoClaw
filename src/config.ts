import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { hydrateProcessEnvFromEnvFile } from './env.js';

hydrateProcessEnvFromEnvFile([
  'DB_ENGINE',
  'DB_MYSQL_HOST',
  'DB_MYSQL_PORT',
  'DB_MYSQL_USER',
  'DB_MYSQL_PASSWORD',
  'DB_MYSQL_DATABASE',
  'DB_MYSQL_POOL_SIZE',
  'DB_PG_HOST',
  'DB_PG_PORT',
  'DB_PG_USER',
  'DB_PG_PASSWORD',
  'DB_PG_DATABASE',
  'DB_PG_POOL_SIZE',
  'DB_PG_SSL',
  'COOKIE_SECURE',
  'NANOCLAW_FORCE_HYDRATE',
]);

let storedConfigCache: Record<string, string> | null = null;

// Absolute paths used by agent runtime helpers
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never exposed to agents
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const ASSISTANT_NAME = getStartupConfigValue('ASSISTANT_NAME') || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  getStartupConfigValue('ASSISTANT_HAS_OWN_NUMBER') === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const MEMORY_COMPACTION_POLL_INTERVAL = 5000;
export const MEMORY_INDEX_SYNC_POLL_INTERVAL = 300000;

function loadStoredConfig(): Record<string, string> {
  if (storedConfigCache) return storedConfigCache;

  if (process.env.DB_ENGINE === 'mysql' || process.env.DB_ENGINE === 'postgres') {
    storedConfigCache = {};
    return storedConfigCache;
  }

  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    storedConfigCache = {};
    return storedConfigCache;
  }

  try {
    const database = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    const rows = database
      .prepare('SELECT key, value FROM config')
      .all() as Array<{ key: string; value: string }>;
    database.close();

    storedConfigCache = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    return storedConfigCache;
  } catch {
    storedConfigCache = {};
    return storedConfigCache;
  }
}

export function getStartupConfigValue(key: string): string {
  const storeVal = loadStoredConfig()[key];
  if (storeVal) return storeVal;

  return '';
}

export function invalidateStartupConfigCache(): void {
  storedConfigCache = null;
}

export function getStartupConfigValues(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    result[key] = getStartupConfigValue(key);
  }
  return result;
}

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep the agent alive after last result
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
