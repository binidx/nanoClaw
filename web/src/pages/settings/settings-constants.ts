import type { AppSelectOption } from '../../components/AppSelect';
import type { SettingsTab } from '../../app-types';
import i18n from '../../i18n/index';

export const CORE_CONFIG_ORDER = [
  'ASSISTANT_NAME',
  'WEB_PORT',
  'WEB_EXTERNAL_URL',
  'WEB_SHARE_URL',
  'WEB_STOCK_ANALYSIS_ENABLED',
  'WEB_TERMINAL_ENABLED',
  'CODEX_MAX_TOOL_ITERATIONS',
  'DEFAULT_ACCESS_MODE',
  'ALLOW_INSECURE_TLS',
] as const;

export const WEB_SEARCH_CONFIG_KEYS = [
  'WEB_SEARCH_ENABLED',
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_MAX_RESULTS',
  'WEB_FETCH_PROVIDER',
  'WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
  'WEB_FETCH_MAX_CHARS',
  'WEB_FETCH_PAGE_SIZE',
  'WEB_FETCH_BROWSER_COMMAND',
  'WEB_FETCH_BROWSER_SITE_PROFILES',
  'WEB_SEARCH_ALLOWED_DOMAINS',
  'WEB_SEARCH_SEARXNG_BASE_URL',
  'WEB_SEARCH_TAVILY_API_KEY',
] as const;

export const AUTH_CONFIG_KEYS = [
  'WEB_LOGIN_ENABLED',
  'WEB_LOGIN_USERNAME',
  'WEB_LOGIN_PASSWORD',
  'LDAP_ENABLED',
  'LDAP_URL',
  'LDAP_BIND_DN',
  'LDAP_BIND_PASSWORD',
  'LDAP_SEARCH_BASE',
  'LDAP_SEARCH_FILTER',
  'LDAP_ATTRIBUTE_MAP',
  'LDAP_FALLBACK_LOCAL',
  'LDAP_DEFAULT_ROLE',
] as const;

export const ADVANCED_WEB_CONFIG_KEYS = [
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_MAX_RESULTS',
  'WEB_FETCH_PROVIDER',
  'WEB_FETCH_MAX_CHARS',
  'WEB_FETCH_PAGE_SIZE',
  'WEB_FETCH_BROWSER_COMMAND',
  'WEB_FETCH_BROWSER_SITE_PROFILES',
  'WEB_SEARCH_ALLOWED_DOMAINS',
  'WEB_SEARCH_SEARXNG_BASE_URL',
  'WEB_SEARCH_TAVILY_API_KEY',
] as const;
export const ADVANCED_WEB_CONFIG_KEY_SET = new Set<string>(ADVANCED_WEB_CONFIG_KEYS);

export const BROWSER_CONTROL_CONFIG_KEYS = [
  'WEB_BROWSER_ENABLED',
  'WEB_BROWSER_CONNECTION_MODE',
  'WEB_BROWSER_REMOTE_DEBUG_URL',
  'WEB_BROWSER_HEADLESS',
  'WEB_BROWSER_EXECUTABLE_PATH',
  'WEB_BROWSER_EXTRA_ARGS',
  'WEB_BROWSER_START_URL',
  'WEB_BROWSER_STARTUP_TIMEOUT_MS',
  'WEB_BROWSER_ACTION_TIMEOUT_MS',
] as const;

export const MEMORY_CONFIG_KEYS = [
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_MODE',
  'MEMORY_GLOBAL_WRITE_ENABLED',
  'MEMORY_AUTO_SAVE_ENABLED',
  'MEMORY_SEARCH_SCOPE_DEFAULT',
  'MEMORY_PROMPT_INJECTION_ENABLED',
] as const;

export const KNOWLEDGE_CONFIG_KEYS = [
  'KB_MAX_FILE_SIZE_MB',
  'KB_MAX_ZIP_SIZE_MB',
  'KB_MAX_ZIP_FILES',
  'KB_MAX_IMPORT_PAGES',
  'KB_MAX_CRAWL_DEPTH',
  'KB_CRAWL_CONCURRENCY',
  'KB_LLM_CONCURRENCY',
  'KB_FETCH_TIMEOUT_MS',
  'KB_JINA_TIMEOUT_MS',
] as const;

export const WEB_SEARCH_PROVIDER_OPTIONS: AppSelectOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'duckduckgo_html', label: 'DuckDuckGo HTML' },
  { value: 'searxng', label: 'SearXNG' },
  { value: 'tavily', label: 'Tavily' },
];

export const WEB_FETCH_PROVIDER_OPTIONS: AppSelectOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'basic', label: 'Basic Fetch' },
  { value: 'browser_cli', label: 'Browser CLI' },
];

export function getMemoryWriteModeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'disabled', label: t('settings.constants.关闭写入') },
    { value: 'daily-only', label: t('settings.constants.仅日记文件') },
  ];
}

export function getMemorySearchScopeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'group', label: t('settings.constants.仅群组') },
    { value: 'global', label: t('settings.constants.仅全局') },
    { value: 'all', label: t('settings.constants.群组_全局') },
  ];
}

export function getBrowserConnectionModeOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'managed', label: t('settings.constants.受管浏览器') },
    { value: 'connect', label: t('settings.constants.附着现有浏览器') },
  ];
}

/* Subagent runtime status options - kept for reference / future filter reuse */
void [
  { value: 'all', label: i18n.t('settings.constants.全部状态') },
  { value: 'spawning', label: i18n.t('settings.constants.创建中') },
  { value: 'idle', label: i18n.t('settings.constants.空闲') },
  { value: 'running', label: i18n.t('settings.constants.运行中') },
  { value: 'stopping', label: i18n.t('settings.constants.停止中') },
  { value: 'completed', label: i18n.t('settings.constants.已完成') },
  { value: 'failed', label: i18n.t('settings.constants.失败') },
  { value: 'stopped', label: i18n.t('settings.constants.已停止') },
];

export const SUBAGENT_MAX_ACTIVE_OPTIONS = [
  { value: 1, label: '1', description: i18n.t('settings.constants.串行委派') },
  { value: 2, label: '2', description: i18n.t('settings.constants.轻量并行') },
  { value: 4, label: '4', description: i18n.t('settings.constants.默认容量') },
  { value: 6, label: '6', description: i18n.t('settings.constants.中等并行') },
  { value: 8, label: '8', description: i18n.t('settings.constants.高并行') },
  { value: 12, label: '12', description: i18n.t('settings.constants.大任务编排') },
  { value: 16, label: '16', description: i18n.t('settings.constants.最大限制') },
] as const;

export function getDefaultAccessPolicyOptions(): readonly {
  value: string;
  label: string;
  description: string;
}[] {
  return [
    {
      value: 'allowall',
      label: i18n.t('settings.constants.允许全部'),
      description: i18n.t('settings.constants.允许全部_描述'),
    },
    {
      value: 'allowlist',
      label: i18n.t('settings.constants.白名单'),
      description: i18n.t('settings.constants.白名单_描述'),
    },
    {
      value: 'readonly',
      label: i18n.t('settings.constants.只读'),
      description: i18n.t('settings.constants.只读_描述'),
    },
  ];
}

export function getDefaultAccessModeOptions(): AppSelectOption[] {
  return getDefaultAccessPolicyOptions().map((option) => ({
    value: option.value,
    label: option.label,
  }));
}

export const ALL_SETTINGS_TABS: ReadonlySet<string> = new Set<SettingsTab>([
  'providers', 'channels', 'prompt', 'web-search', 'general', 'knowledge', 'subagent', 'security',
  'diagnostics', 'browser', 'extensions', 'mcp', 'skills',
  'my-providers', 'my-channels', 'live2d', 'ssh-keys',
]);
