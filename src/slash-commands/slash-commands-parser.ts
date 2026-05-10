import { t } from '../i18n/index.js';
export interface ParsedSlashCommand {
  command: string;
  args: string[];
}

export interface ParsedCommandOptions {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (quote === '"' && ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new Error(t('slashCommands.auto_8e6faa', {}, undefined));
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseSlashCommand(rawText: string): ParsedSlashCommand | null {
  const text = rawText.trim();
  if (!text.startsWith('/')) return null;
  const tokens = tokenizeCommandLine(text);
  if (tokens.length === 0) return null;
  const rawCommand = tokens[0]!.slice(1).trim().toLowerCase();
  if (!rawCommand) return null;
  return {
    command: rawCommand,
    args: tokens.slice(1),
  };
}

export function parseCommandOptions(args: string[]): ParsedCommandOptions {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      const key = token.slice(2, eqIndex).trim().toLowerCase();
      const value = token.slice(eqIndex + 1);
      if (key) {
        const current = values.get(key) || [];
        current.push(value);
        values.set(key, current);
      }
      continue;
    }

    const key = token.slice(2).trim().toLowerCase();
    if (!key) continue;

    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      const current = values.get(key) || [];
      current.push(next);
      values.set(key, current);
      i += 1;
    } else {
      flags.add(key);
    }
  }

  return { positional, values, flags };
}

export function getOptionValue(
  options: ParsedCommandOptions,
  key: string,
): string | undefined {
  const values = options.values.get(key.toLowerCase());
  if (!values || values.length === 0) return undefined;
  return values[0];
}

export function getOptionValues(
  options: ParsedCommandOptions,
  key: string,
): string[] {
  return options.values.get(key.toLowerCase()) || [];
}

export function isOptionEnabled(
  options: ParsedCommandOptions,
  key: string,
): boolean {
  const normalized = key.toLowerCase();
  return options.flags.has(normalized) || options.values.has(normalized);
}

export function parseEnvOption(values: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const item of values) {
    const sep = item.indexOf('=');
    if (sep <= 0) continue;
    const key = item.slice(0, sep).trim();
    const value = item.slice(sep + 1);
    if (!key) continue;
    env[key] = value;
  }
  return env;
}

export function buildSlashCommandHelpText(): string {
  return [
    t('slashCommands.auto_8b1aac', {}, undefined),
    '- /help',
    '- /skills',
    t('slashCommands.auto_283c4c', {}, undefined),
    '- /skills install <sourcePath> [--id skill_id] [--overwrite]',
    t('slashCommands.auto_d506d1', {}, undefined),
    '- /skills enable <skillId> | /skills disable <skillId>',
    '- /mcp',
    t('slashCommands.auto_2fc8f7', {}, undefined),
    '- /mcp enable <mcpId> | /mcp disable <mcpId> | /mcp remove <mcpId>',
    '- /tasks',
    t('slashCommands.auto_9d8458', {}, undefined),
    t('slashCommands.auto_22ce19', {}, undefined),
    '',
    t('slashCommands.auto_614fc6', {}, undefined),
    '- /skills install @tmp/skill-creator --id skill-creator --overwrite',
    '- /mcp-install @tmp/mysql --id mysql --entry dist/index.js',
    t('slashCommands.auto_608f15', {}, undefined),
    t('slashCommands.auto_bd1fc9', {}, undefined),
  ].join('\n');
}
