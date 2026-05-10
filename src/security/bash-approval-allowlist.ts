import crypto from 'crypto';
import { t } from '../i18n/index.js';

export type BashApprovalAllowRuleSource = 'manual' | 'approval';

export interface BashApprovalAllowRule {
  id: string;
  prefix: string[];
  label: string;
  enabled: boolean;
  createdAt: string;
  createdFrom: BashApprovalAllowRuleSource;
}

const DISALLOWED_COMMAND_PATTERNS = [
  /[\r\n]/,
  /;/,
  /&&/,
  /\|\|/,
  /\|/,
  />/,
  /</,
  /`/,
  /\$/,
  /[*?[\]{}~]/,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeSource(
  value: unknown,
  fallback: BashApprovalAllowRuleSource,
): BashApprovalAllowRuleSource {
  return value === 'manual' || value === 'approval' ? value : fallback;
}

function tokenizeSimpleShellCommand(command: string): string[] {
  if (!command.trim()) {
    throw new Error(t('errors.auto_ce02a8', {}, undefined));
  }
  if (DISALLOWED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new Error(
      t('errors.auto_14ced9', {}, undefined),
    );
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) {
    throw new Error(t('errors.auto_12465e', {}, undefined));
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error(t('errors.auto_ce02a8', {}, undefined));
  }
  return tokens;
}

export function parseBashApprovalAllowlistPrefix(command: string): string[] {
  return tokenizeSimpleShellCommand(command.trim());
}

export function formatBashApprovalAllowlistPrefix(prefix: readonly string[]): string {
  return prefix
    .map((token) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/.test(token)
        ? token
        : JSON.stringify(token),
    )
    .join(' ');
}

export function createBashApprovalAllowRule(
  command: string,
  options: {
    label?: string;
    createdFrom?: BashApprovalAllowRuleSource;
    enabled?: boolean;
    id?: string;
    createdAt?: string;
  } = {},
): BashApprovalAllowRule {
  const prefix = parseBashApprovalAllowlistPrefix(command);
  return {
    id: options.id?.trim() || `bash_allow_${crypto.randomUUID()}`,
    prefix,
    label:
      options.label?.trim() || formatBashApprovalAllowlistPrefix(prefix),
    enabled: options.enabled ?? true,
    createdAt: options.createdAt || new Date().toISOString(),
    createdFrom: options.createdFrom || 'manual',
  };
}

export function normalizeBashApprovalAllowlist(
  value: unknown,
): BashApprovalAllowRule[] {
  if (value === null || value === undefined || value === '') return [];

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error(t('errors.auto_75469b', {}, undefined));
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(t('errors.auto_8980f9', {}, undefined));
  }

  const rules: BashApprovalAllowRule[] = [];
  const seen = new Set<string>();

  for (const entry of parsed) {
    if (!isRecord(entry)) {
      throw new Error(t('errors.auto_cb6b75', {}, undefined));
    }

    const rule = createBashApprovalAllowRule(
      formatBashApprovalAllowlistPrefix(
        Array.isArray(entry.prefix) ? entry.prefix.map(normalizeToken) : [],
      ),
      {
        id: normalizeToken(entry.id),
        label: normalizeToken(entry.label),
        enabled: normalizeBoolean(entry.enabled, true),
        createdAt: normalizeToken(entry.createdAt) || undefined,
        createdFrom: normalizeSource(entry.createdFrom, 'manual'),
      },
    );
    const dedupeKey = rule.prefix.join('\u0000');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rules.push(rule);
  }

  return rules;
}

export function commandMatchesBashApprovalAllowlist(
  command: string,
  rules: readonly BashApprovalAllowRule[],
): boolean {
  let argv: string[];
  try {
    argv = parseBashApprovalAllowlistPrefix(command);
  } catch {
    return false;
  }

  return rules.some((rule) => {
    if (!rule.enabled || rule.prefix.length > argv.length) return false;
    return rule.prefix.every((token, index) => argv[index] === token);
  });
}

export function canWhitelistBashCommand(command: string): boolean {
  try {
    return parseBashApprovalAllowlistPrefix(command).length > 0;
  } catch {
    return false;
  }
}
