import fs from 'fs';
import path from 'path';

import { SENDER_ALLOWLIST_PATH } from '../config.js';
import { logger } from '../logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

let cachedConfig: SenderAllowlistConfig | null = null;
let cachedConfigPath: string | null = null;

export function invalidateSenderAllowlistCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
}

function cloneDefaultConfig(): SenderAllowlistConfig {
  return {
    default: { ...DEFAULT_CONFIG.default },
    chats: {},
    logDenied: DEFAULT_CONFIG.logDenied,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!isRecord(entry)) return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function assertSenderAllowlistConfigShape(
  input: unknown,
): asserts input is Partial<SenderAllowlistConfig> {
  if (input === null || input === undefined) {
    return;
  }
  if (!isRecord(input)) {
    throw new Error('sender trust config must be an object');
  }

  if (input.default !== undefined && !isValidEntry(input.default)) {
    throw new Error('sender trust default entry is invalid');
  }

  if (input.chats !== undefined) {
    if (!isRecord(input.chats)) {
      throw new Error('sender trust chat overrides must be an object');
    }
    for (const [jid, entry] of Object.entries(input.chats)) {
      if (!jid.trim()) {
        throw new Error('sender trust chat override key cannot be empty');
      }
      if (!isValidEntry(entry)) {
        throw new Error(`sender trust chat override is invalid: ${jid}`);
      }
    }
  }

  if (input.logDenied !== undefined && typeof input.logDenied !== 'boolean') {
    throw new Error('sender trust logDenied must be a boolean');
  }
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  if (!pathOverride && cachedConfig && cachedConfigPath === filePath) {
    return cachedConfig;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return cloneDefaultConfig();
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return cloneDefaultConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return cloneDefaultConfig();
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return cloneDefaultConfig();
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (isRecord(obj.chats)) {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  const result: SenderAllowlistConfig = {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };

  if (!pathOverride) {
    cachedConfig = result;
    cachedConfigPath = filePath;
  }

  return result;
}

export function normalizeSenderAllowlistConfig(
  input: Partial<SenderAllowlistConfig> | null | undefined,
): SenderAllowlistConfig {
  const next = cloneDefaultConfig();
  if (isValidEntry(input?.default)) {
    next.default = {
      allow:
        input.default.allow === '*'
          ? '*'
          : [
              ...new Set(
                input.default.allow
                  .map((entry) => String(entry).trim())
                  .filter(Boolean),
              ),
            ],
      mode: input.default.mode,
    };
  }

  if (input?.chats && typeof input.chats === 'object') {
    for (const [jid, entry] of Object.entries(input.chats)) {
      if (!jid.trim() || !isValidEntry(entry)) continue;
      next.chats[jid.trim()] = {
        allow:
          entry.allow === '*'
            ? '*'
            : [
                ...new Set(
                  entry.allow
                    .map((value) => String(value).trim())
                    .filter(Boolean),
                ),
              ],
        mode: entry.mode,
      };
    }
  }

  next.logDenied = input?.logDenied !== false;
  return next;
}

export function saveSenderAllowlist(
  config: Partial<SenderAllowlistConfig>,
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
  const normalized = normalizeSenderAllowlistConfig(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8',
  );
  invalidateSenderAllowlistCache();
  return normalized;
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}
