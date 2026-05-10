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

function tokenizeSimpleShellCommand(command: string): string[] {
  if (!command.trim()) {
    throw new Error('Empty command');
  }
  if (DISALLOWED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new Error('Unsupported shell syntax');
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
      if (char === "'") quote = null;
      else current += char;
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
    throw new Error('Unterminated escape or quote');
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Empty command');
  }
  return tokens;
}

export function parseBashApprovalAllowlistPrefix(command: string): string[] {
  return tokenizeSimpleShellCommand(command.trim());
}

export function normalizeBashApprovalAllowlist(
  value: unknown,
): BashApprovalAllowRule[] {
  if (!value) return [];
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const rules: BashApprovalAllowRule[] = [];

  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const prefix = Array.isArray(entry.prefix)
      ? entry.prefix.map(normalizeToken).filter(Boolean)
      : [];
    if (prefix.length === 0) continue;
    const dedupeKey = prefix.join('\u0000');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rules.push({
      id: normalizeToken(entry.id) || dedupeKey,
      prefix,
      label: normalizeToken(entry.label) || prefix.join(' '),
      enabled: entry.enabled !== false,
      createdAt: normalizeToken(entry.createdAt) || '',
      createdFrom:
        entry.createdFrom === 'approval' ? 'approval' : 'manual',
    });
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
