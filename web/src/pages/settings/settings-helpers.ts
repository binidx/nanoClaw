import type {
  BashApprovalAllowRule,
  BasicConfigState,
  ConfigKeyMetadata,
  ExtensionMarketplaceSource,
  ManagedMcpServer,
  ManagedSkill,
  ManagedSkillDetail,
  SenderTrustEntry,
  SubagentRuntimeEntry,
} from '../../app-types';

import type { ExtensionMarketplaceSourceDraft, SubagentRunItem } from './settings-types';
import i18n from '../../i18n/index';

export function describeProviderCapabilities(provider: {
  canSpawn: boolean;
  canPersistentSession: boolean;
  canListRuntime: boolean;
  canStopRuntime: boolean;
  canResumeAfterRestart: boolean;
}): string {
  return [
    provider.canSpawn ? i18n.t('settings.helpers.可创建') : i18n.t('settings.helpers.不可创建'),
    provider.canPersistentSession ? i18n.t('settings.helpers.支持持久会话') : i18n.t('settings.helpers.不支持持久会话'),
    provider.canListRuntime ? i18n.t('settings.helpers.可列出运行时') : i18n.t('settings.helpers.不提供运行时列表'),
    provider.canStopRuntime ? i18n.t('settings.helpers.可停止运行时') : i18n.t('settings.helpers.不可停止运行时'),
    provider.canResumeAfterRestart ? i18n.t('settings.helpers.支持重启恢复') : i18n.t('settings.helpers.不支持重启恢复'),
  ].join(' / ');
}

export function formatSubagentProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'claude') return 'Claude';
  if (!normalized) return 'Unknown';
  return provider;
}

export function isSensitiveKey(key: string, metadata?: ConfigKeyMetadata): boolean {
  return (
    metadata?.risk === 'sensitive' ||
    /(SECRET|PASSWORD|TOKEN|API_KEY)$/i.test(key)
  );
}

export function parseBrowserSiteProfilesDraft(value: string): {
  profiles: Array<Record<string, unknown>>;
  error: string | null;
} {
  const text = value.trim();
  if (!text) return { profiles: [], error: null };

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        profiles: [],
        error: i18n.t('settings.helpers.当前自定义规则不是JSON数组'),
      };
    }
    if (
      !parsed.every(
        (item) => !!item && typeof item === 'object' && !Array.isArray(item),
      )
    ) {
      return {
        profiles: [],
        error: i18n.t('settings.helpers.当前自定义规则数组包含非对象项'),
      };
    }
    return {
      profiles: parsed as Array<Record<string, unknown>>,
      error: null,
    };
  } catch {
    return {
      profiles: [],
      error: i18n.t('settings.helpers.当前自定义规则不是合法JSON'),
    };
  }
}

export function getStringValue(config: BasicConfigState, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

export function getBooleanValue(config: BasicConfigState, key: string): boolean {
  return config[key] === true;
}

export function parseAllowedDirectoriesDraft(value: string): {
  directories: string[];
  error: string | null;
} {
  const raw = value.trim();
  if (!raw) {
    return { directories: [], error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      directories: [],
      error: i18n.t('settings.helpers.默认目录模板必须是JSON字符串数组'),
    };
  }

  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry) => typeof entry === 'string')
  ) {
    return {
      directories: [],
      error: i18n.t('settings.helpers.默认目录模板必须是JSON字符串数组'),
    };
  }

  return {
    directories: Array.from(
      new Set(parsed.map((entry) => entry.trim()).filter(Boolean)),
    ),
    error: null,
  };
}

export function formatIsoTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function formatRatePercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '-';
  }
  return `${Math.round(value * 100)}%`;
}

export function parseEnvInput(value: string): Record<string, string> {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const env: Record<string, string> = {};
  for (const line of lines) {
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const val = line.slice(sep + 1).trim();
    if (!key) continue;
    env[key] = val;
  }
  return env;
}

export function mapSubagentRunToRuntimeEntry(
  item: SubagentRunItem,
): SubagentRuntimeEntry {
  return {
    ...item,
    id: item.runtimeId || item.runId,
  };
}

const BASH_APPROVAL_DISALLOWED_PATTERNS = [
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
] as const;

export function parseBashApprovalPrefixInput(value: string): {
  prefix: string[];
  error: string | null;
} {
  const command = value.trim();
  if (!command) {
    return { prefix: [], error: i18n.t('settings.helpers.命令前缀不能为空') };
  }
  if (BASH_APPROVAL_DISALLOWED_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      prefix: [],
      error: i18n.t('settings.helpers.命令包含复杂shell结构'),
    };
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
    return {
      prefix: [],
      error: i18n.t('settings.helpers.命令包含未闭合的引号'),
    };
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) {
    return { prefix: [], error: i18n.t('settings.helpers.命令前缀不能为空') };
  }
  return { prefix: tokens, error: null };
}

export function formatBashApprovalPrefix(prefix: readonly string[]): string {
  return prefix
    .map((token) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/.test(token)
        ? token
        : JSON.stringify(token),
    )
    .join(' ');
}

export function isValidBashApprovalAllowRule(value: unknown): value is BashApprovalAllowRule {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.prefix) &&
    value.prefix.every((entry) => typeof entry === 'string' && entry.trim()) &&
    typeof value.label === 'string' &&
    typeof value.enabled === 'boolean' &&
    typeof value.createdAt === 'string' &&
    (value.createdFrom === 'manual' || value.createdFrom === 'approval')
  );
}

export function parseBashApprovalAllowlistDraft(value: string): {
  rules: BashApprovalAllowRule[];
  error: string | null;
} {
  const text = value.trim();
  if (!text) return { rules: [], error: null };

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return { rules: [], error: i18n.t('settings.helpers.Bash审批白名单必须是JSON数组') };
    }
    const rules = parsed.filter(isValidBashApprovalAllowRule);
    if (rules.length !== parsed.length) {
      return { rules: [], error: i18n.t('settings.helpers.Bash审批白名单包含无效规则') };
    }
    return { rules, error: null };
  } catch {
    return { rules: [], error: i18n.t('settings.helpers.Bash审批白名单不是合法JSON') };
  }
}

export function envToText(env: Record<string, string>): string {
  return Object.entries(env || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isValidSenderTrustEntry(value: unknown): value is SenderTrustEntry {
  if (!isPlainObject(value)) return false;
  const mode = value.mode;
  const allow = value.allow;
  return (
    (mode === 'trigger' || mode === 'drop') &&
    (allow === '*' ||
      (Array.isArray(allow) &&
        allow.every((entry) => typeof entry === 'string')))
  );
}

export function parseSenderTrustOverrides(value: string): {
  overrides: Record<string, SenderTrustEntry>;
  error: string | null;
} {
  const raw = value.trim();
  if (!raw) {
    return { overrides: {}, error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides: {}, error: i18n.t('settings.helpers.按会话覆盖必须是合法JSON') };
  }

  if (!isPlainObject(parsed)) {
    return {
      overrides: {},
      error: i18n.t('settings.helpers.按会话覆盖必须是JSONObject'),
    };
  }

  const overrides: Record<string, SenderTrustEntry> = {};
  for (const [chatJid, entry] of Object.entries(parsed)) {
    if (!chatJid.trim()) {
      return { overrides: {}, error: i18n.t('settings.helpers.按会话覆盖里存在空chat_jid') };
    }
    if (!isValidSenderTrustEntry(entry)) {
      return {
        overrides: {},
        error: i18n.t('settings.helpers.会话策略无效', { chatJid }),
      };
    }
    overrides[chatJid.trim()] = {
      allow:
        entry.allow === '*'
          ? '*'
          : entry.allow.map((item) => item.trim()).filter(Boolean),
      mode: entry.mode,
    };
  }

  return { overrides, error: null };
}

export function normalizeManagedMcpServer(
  server: Partial<ManagedMcpServer> | null | undefined,
): ManagedMcpServer {
  const args = Array.isArray(server?.args) ? server.args : [];
  const rawEnv =
    server?.env && typeof server.env === 'object' ? server.env : {};

  return {
    id: typeof server?.id === 'string' ? server.id : '',
    name: typeof server?.name === 'string' ? server.name : '',
    command: typeof server?.command === 'string' ? server.command : '',
    args: args.map((arg) => String(arg ?? '')),
    env: Object.fromEntries(
      Object.entries(rawEnv).map(
        ([key, value]) => [key, String(value ?? '')] as const,
      ),
    ),
    enabled: server?.enabled !== false,
  };
}

export function createManagedMcpDraft(): ManagedMcpServer {
  return normalizeManagedMcpServer({
    id: `server_${Date.now()}`,
    name: '',
    command: '',
    args: [],
    env: {},
    enabled: true,
  });
}

export function slugifyMarketplaceSourceId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `marketplace_${Date.now()}`
  );
}

export function createMarketplaceDraftKey(): string {
  return `marketplace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function toMarketplaceSourceDraft(
  entry: ExtensionMarketplaceSource,
): ExtensionMarketplaceSourceDraft {
  return {
    ...entry,
    draftKey: createMarketplaceDraftKey(),
    persistedId: entry.id,
    persistedSource: entry.source,
    persistedEnabled: entry.enabled !== false,
  };
}

export function createMarketplaceSourceDraft(): ExtensionMarketplaceSourceDraft {
  return {
    draftKey: createMarketplaceDraftKey(),
    persistedId: null,
    persistedSource: null,
    persistedEnabled: null,
    id: `marketplace_${Date.now()}`,
    name: '',
    source: '',
    enabled: true,
  };
}

export function isMarketplaceSourceDraftDirty(
  entry: ExtensionMarketplaceSourceDraft,
): boolean {
  if (!entry.persistedId) return true;
  return (
    entry.persistedId.trim() !== entry.id.trim() ||
    (entry.persistedSource || '').trim() !== entry.source.trim() ||
    (entry.persistedEnabled ?? true) !== (entry.enabled !== false)
  );
}

export function slugifyManagedMcpId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || `server_${Date.now()}`
  );
}

export function normalizeImportedManagedMcpServer(
  value: unknown,
  fallbackId = '',
): ManagedMcpServer {
  const raw = isPlainObject(value) ? value : {};
  const normalized = normalizeManagedMcpServer(raw);
  const id = normalized.id.trim() || slugifyManagedMcpId(fallbackId);
  const enabled =
    typeof raw.enabled === 'boolean'
      ? raw.enabled
      : raw.disabled === true
        ? false
        : normalized.enabled;
  return {
    ...normalized,
    id,
    name: normalized.name.trim() || id,
    enabled,
  };
}

export function parseManagedMcpJson(value: string): {
  servers: ManagedMcpServer[];
  error: string | null;
} {
  const raw = value.trim();
  if (!raw) {
    return { servers: [], error: i18n.t('settings.helpers.请先输入MCP_JSON') };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { servers: [], error: i18n.t('settings.helpers.MCP_JSON不是合法JSON') };
  }

  if (Array.isArray(parsed)) {
    return {
      servers: parsed.map((item, index) =>
        normalizeImportedManagedMcpServer(item, `server_${index + 1}`),
      ),
      error: null,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      servers: [],
      error: i18n.t('settings.helpers.MCP_JSON必须是对象'),
    };
  }

  if (Array.isArray(parsed.servers)) {
    return {
      servers: parsed.servers.map((item, index) =>
        normalizeImportedManagedMcpServer(item, `server_${index + 1}`),
      ),
      error: null,
    };
  }

  if (
    typeof parsed.command === 'string' ||
    Array.isArray(parsed.args) ||
    typeof parsed.id === 'string'
  ) {
    return {
      servers: [
        normalizeImportedManagedMcpServer(
          parsed,
          typeof parsed.id === 'string' ? parsed.id : 'server_1',
        ),
      ],
      error: null,
    };
  }

  const source = isPlainObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const entries = Object.entries(source).filter(([, entry]) =>
    isPlainObject(entry),
  );
  if (entries.length === 0) {
    return {
      servers: [],
      error:
        i18n.t('settings.helpers.没有解析到MCP条目'),
    };
  }

  return {
    servers: entries.map(([id, entry]) =>
      normalizeImportedManagedMcpServer(entry, id),
    ),
    error: null,
  };
}

export function validateManagedMcpDraft(servers: ManagedMcpServer[]): string | null {
  for (const [index, server] of servers.entries()) {
    const id = server.id.trim();
    const name = server.name.trim();
    const command = server.command.trim();
    const hasArgs = server.args.some((arg) => arg.trim());
    const hasEnv = Object.keys(server.env || {}).length > 0;
    const hasGeneratedIdOnly = /^server_\d+$/i.test(id);
    const hasMeaningfulContent = Boolean(name || command || hasArgs || hasEnv);

    if (!hasMeaningfulContent && hasGeneratedIdOnly) {
      return i18n.t('settings.helpers.MCP还是空的', { index: index + 1 });
    }
    if (hasMeaningfulContent && !command) {
      return i18n.t('settings.helpers.MCP缺少命令', { index: index + 1 });
    }
    if (hasMeaningfulContent && !name && hasGeneratedIdOnly) {
      return i18n.t('settings.helpers.MCP缺少名称', { index: index + 1 });
    }
  }
  return null;
}

export function getCollapsedSkillSummary(
  skill: ManagedSkill,
  detail?: ManagedSkillDetail,
): string {
  const source = (skill.description || detail?.summary || '').trim();
  if (!source) return i18n.t('settings.helpers.展开查看SKILL摘要与路径');
  return source.length > 96 ? `${source.slice(0, 96).trim()}...` : source;
}

export function providerVisibilityBadgeLabel(visibility?: string): string {
  switch (visibility) {
    case 'private':
      return i18n.t('settings.helpers.创建者专属');
    case 'restricted':
      return i18n.t('settings.helpers.按角色授权');
    case 'public':
    default:
      return i18n.t('settings.helpers.公开');
  }
}
