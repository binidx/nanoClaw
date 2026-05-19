import type { ConfigEffect, ConfigRisk } from './config-channel-definitions.js';
import { t } from './i18n/index.js';

export const WEB_CONFIG_KEYS = [
  'ASSISTANT_NAME',
  'WEB_PORT',
  'WEB_EXTERNAL_URL',
  'WEB_SHARE_URL',
  'WEB_LOGIN_ENABLED',
  'WEB_REGISTRATION_ENABLED',
  'WEB_STOCK_ANALYSIS_ENABLED',
  'WEB_TERMINAL_ENABLED',
  'WEB_BROWSER_ENABLED',
  'WEB_BROWSER_CONNECTION_MODE',
  'WEB_BROWSER_REMOTE_DEBUG_URL',
  'WEB_BROWSER_HEADLESS',
  'WEB_BROWSER_EXECUTABLE_PATH',
  'WEB_BROWSER_EXTRA_ARGS',
  'WEB_BROWSER_START_URL',
  'WEB_BROWSER_STARTUP_TIMEOUT_MS',
  'WEB_BROWSER_ACTION_TIMEOUT_MS',
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
  'CODEX_MAX_TOOL_ITERATIONS',
  'BASH_APPROVAL_ALLOWLIST',
  'DEFAULT_ACCESS_MODE',
  'MEMORY_ENABLED',
  'MEMORY_READ_ENABLED',
  'MEMORY_WRITE_MODE',
  'MEMORY_GLOBAL_WRITE_ENABLED',
  'MEMORY_AUTO_SAVE_ENABLED',
  'MEMORY_SEARCH_SCOPE_DEFAULT',
  'MEMORY_SEARCH_MAX_RESULTS',
  'MEMORY_PROMPT_INJECTION_ENABLED',
  'MEMORY_PROMPT_MAX_SNIPPETS',
  'MEMORY_PROMPT_TOKEN_BUDGET',
  'MEMORY_PROMPT_RECENT_RATIO',
  'MEMORY_PROMPT_SUMMARY_RATIO',
  'MEMORY_PROMPT_RECALL_RATIO',
  'MEMORY_COMPACTION_ENABLED',
  'MEMORY_COMPACTION_TRIGGER_ENTRIES',
  'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
  'CHAT_CONTEXT_TOKEN_BUDGET',
  'CHAT_CONTEXT_RECENT_CHAT_RATIO',
  'CHAT_CONTEXT_RECENT_TOOL_RATIO',
  'CHAT_CONTEXT_MEMORY_RECALL_RATIO',
  'CHAT_CONTEXT_SUMMARY_RATIO',
  'CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES',
  'CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS',
  'CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES',
  'CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES',
  'ALLOW_INSECURE_TLS',
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
  'allowed_directories',
  'LIVE2D_ENABLED',
  'LIVE2D_EMOTION_ENABLED',
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

export type WebConfigKey = (typeof WEB_CONFIG_KEYS)[number];

export interface ConfigKeyMetadata {
  key: WebConfigKey;
  label: string;
  effect: ConfigEffect;
  summary: string;
  risk?: ConfigRisk;
}

export const WEB_CONFIG_METADATA: Record<WebConfigKey, ConfigKeyMetadata> = {
  ASSISTANT_NAME: {
    key: 'ASSISTANT_NAME',
    label: t('config.auto_f34e9e', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_3647f4', {}, undefined),
  },
  WEB_PORT: {
    key: 'WEB_PORT',
    label: t('config.auto_0e683b', {}, undefined),
    effect: 'restart',
    summary: t('config.auto_40216d', {}, undefined),
  },
  WEB_EXTERNAL_URL: {
    key: 'WEB_EXTERNAL_URL',
    label: t('config.auto_de6939', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_61bdf4', {}, undefined),
  },
  WEB_SHARE_URL: {
    key: 'WEB_SHARE_URL',
    label: t('config.auto_c9af9c', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_e432d6', {}, undefined),
  },
  WEB_LOGIN_ENABLED: {
    key: 'WEB_LOGIN_ENABLED',
    label: t('config.auto_09b161', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_ab7cb3', {}, undefined),
  },
  WEB_REGISTRATION_ENABLED: {
    key: 'WEB_REGISTRATION_ENABLED',
    label: t('config.auto_4df241', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_e036a5', {}, undefined),
    risk: 'dangerous' as ConfigRisk,
  },
  WEB_STOCK_ANALYSIS_ENABLED: {
    key: 'WEB_STOCK_ANALYSIS_ENABLED',
    label: t('config.auto_e44bb4', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_24415f', {}, undefined),
  },
  WEB_TERMINAL_ENABLED: {
    key: 'WEB_TERMINAL_ENABLED',
    label: t('config.auto_23fa94', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_6ad2af', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_ENABLED: {
    key: 'WEB_BROWSER_ENABLED',
    label: t('config.auto_91a471', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_4d2cb4', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_CONNECTION_MODE: {
    key: 'WEB_BROWSER_CONNECTION_MODE',
    label: t('config.auto_9a7450', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_78128c', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_REMOTE_DEBUG_URL: {
    key: 'WEB_BROWSER_REMOTE_DEBUG_URL',
    label: t('config.auto_af022f', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_f5d810', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_HEADLESS: {
    key: 'WEB_BROWSER_HEADLESS',
    label: t('config.auto_e92bde', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_b5fc5f', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_EXECUTABLE_PATH: {
    key: 'WEB_BROWSER_EXECUTABLE_PATH',
    label: t('config.auto_1f234c', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_034064', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_EXTRA_ARGS: {
    key: 'WEB_BROWSER_EXTRA_ARGS',
    label: t('config.auto_e754a7', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_1e30a2', {}, undefined),
    risk: 'dangerous',
  },
  WEB_BROWSER_START_URL: {
    key: 'WEB_BROWSER_START_URL',
    label: t('config.auto_4d8a13', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_7f8959', {}, undefined),
  },
  WEB_BROWSER_STARTUP_TIMEOUT_MS: {
    key: 'WEB_BROWSER_STARTUP_TIMEOUT_MS',
    label: t('config.auto_82ffa3', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_9e9f54', {}, undefined),
  },
  WEB_BROWSER_ACTION_TIMEOUT_MS: {
    key: 'WEB_BROWSER_ACTION_TIMEOUT_MS',
    label: t('config.auto_120d9f', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_481337', {}, undefined),
  },
  WEB_SEARCH_ENABLED: {
    key: 'WEB_SEARCH_ENABLED',
    label: t('config.auto_b2d7ca', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_e51617', {}, undefined),
  },
  WEB_SEARCH_PROVIDER: {
    key: 'WEB_SEARCH_PROVIDER',
    label: t('config.auto_1580d5', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_c0f142', {}, undefined),
  },
  WEB_SEARCH_MAX_RESULTS: {
    key: 'WEB_SEARCH_MAX_RESULTS',
    label: t('config.auto_fc2286', {}, undefined),
    effect: 'new_agent',
    summary: t('config.auto_216f3a', {}, undefined),
  },
  WEB_FETCH_PROVIDER: {
    key: 'WEB_FETCH_PROVIDER',
    label: t('config.auto_faf71f', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_db94c5', {}, undefined),
  },
  WEB_FETCH_USE_BUILTIN_SITE_PROFILES: {
    key: 'WEB_FETCH_USE_BUILTIN_SITE_PROFILES',
    label: t('config.auto_8b311e', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_3076ae', {}, undefined),
  },
  WEB_FETCH_MAX_CHARS: {
    key: 'WEB_FETCH_MAX_CHARS',
    label: t('config.auto_ab5d49', {}, undefined),
    effect: 'new_agent',
    summary: t('config.auto_9a6976', {}, undefined),
  },
  WEB_FETCH_PAGE_SIZE: {
    key: 'WEB_FETCH_PAGE_SIZE',
    label: t('config.auto_ab8576', {}, undefined),
    effect: 'new_agent',
    summary: t('config.auto_4092ba', {}, undefined),
  },
  WEB_FETCH_BROWSER_COMMAND: {
    key: 'WEB_FETCH_BROWSER_COMMAND',
    label: t('config.auto_5daec6', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_ef5b43', {}, undefined),
    risk: 'dangerous',
  },
  WEB_FETCH_BROWSER_SITE_PROFILES: {
    key: 'WEB_FETCH_BROWSER_SITE_PROFILES',
    label: t('config.auto_40d96e', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_292c20', {}, undefined),
    risk: 'dangerous',
  },
  WEB_SEARCH_ALLOWED_DOMAINS: {
    key: 'WEB_SEARCH_ALLOWED_DOMAINS',
    label: t('config.auto_cd1f56', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_5a3f19', {}, undefined),
  },
  WEB_SEARCH_SEARXNG_BASE_URL: {
    key: 'WEB_SEARCH_SEARXNG_BASE_URL',
    label: 'SearXNG Base URL',
    effect: 'new_agent',
    summary:
      t('config.auto_37fb82', {}, undefined),
  },
  WEB_SEARCH_TAVILY_API_KEY: {
    key: 'WEB_SEARCH_TAVILY_API_KEY',
    label: 'Tavily API Key',
    effect: 'new_agent',
    summary: t('config.auto_8d1a8d', {}, undefined),
    risk: 'sensitive',
  },
  CODEX_MAX_TOOL_ITERATIONS: {
    key: 'CODEX_MAX_TOOL_ITERATIONS',
    label: t('config.auto_f935f7', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_36f5e3', {}, undefined),
  },
  BASH_APPROVAL_ALLOWLIST: {
    key: 'BASH_APPROVAL_ALLOWLIST',
    label: t('config.auto_e913e2', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_3ac259', {}, undefined),
    risk: 'dangerous',
  },
  DEFAULT_ACCESS_MODE: {
    key: 'DEFAULT_ACCESS_MODE',
    label: t('config.auto_3fb4ed', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_95e80d', {}, undefined),
    risk: 'dangerous',
  },
  MEMORY_ENABLED: {
    key: 'MEMORY_ENABLED',
    label: t('config.auto_71a3fa', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_f2b15b', {}, undefined),
  },
  MEMORY_READ_ENABLED: {
    key: 'MEMORY_READ_ENABLED',
    label: t('config.auto_5981b4', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_9b827d', {}, undefined),
  },
  MEMORY_WRITE_MODE: {
    key: 'MEMORY_WRITE_MODE',
    label: t('config.auto_29940e', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_405124', {}, undefined),
  },
  MEMORY_GLOBAL_WRITE_ENABLED: {
    key: 'MEMORY_GLOBAL_WRITE_ENABLED',
    label: t('config.auto_fdc7b8', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_c1f4b4', {}, undefined),
  },
  MEMORY_AUTO_SAVE_ENABLED: {
    key: 'MEMORY_AUTO_SAVE_ENABLED',
    label: t('config.auto_58ca33', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_84e247', {}, undefined),
  },
  MEMORY_SEARCH_SCOPE_DEFAULT: {
    key: 'MEMORY_SEARCH_SCOPE_DEFAULT',
    label: t('config.auto_37f1b2', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_15e887', {}, undefined),
  },
  MEMORY_SEARCH_MAX_RESULTS: {
    key: 'MEMORY_SEARCH_MAX_RESULTS',
    label: t('config.auto_7e79ed', {}, undefined),
    effect: 'new_agent',
    summary: t('config.auto_503203', {}, undefined),
  },
  MEMORY_PROMPT_INJECTION_ENABLED: {
    key: 'MEMORY_PROMPT_INJECTION_ENABLED',
    label: t('config.auto_c5c6a3', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_0e872b', {}, undefined),
  },
  MEMORY_PROMPT_MAX_SNIPPETS: {
    key: 'MEMORY_PROMPT_MAX_SNIPPETS',
    label: t('config.auto_f27fe8', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_f17464', {}, undefined),
  },
  MEMORY_PROMPT_TOKEN_BUDGET: {
    key: 'MEMORY_PROMPT_TOKEN_BUDGET',
    label: t('config.auto_0b8308', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_d52794', {}, undefined),
  },
  MEMORY_PROMPT_RECENT_RATIO: {
    key: 'MEMORY_PROMPT_RECENT_RATIO',
    label: t('config.auto_cd558d', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_22c017', {}, undefined),
  },
  MEMORY_PROMPT_SUMMARY_RATIO: {
    key: 'MEMORY_PROMPT_SUMMARY_RATIO',
    label: t('config.auto_608c1f', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_3463b2', {}, undefined),
  },
  MEMORY_PROMPT_RECALL_RATIO: {
    key: 'MEMORY_PROMPT_RECALL_RATIO',
    label: t('config.auto_48f1f5', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_efccd5', {}, undefined),
  },
  MEMORY_COMPACTION_ENABLED: {
    key: 'MEMORY_COMPACTION_ENABLED',
    label: t('config.auto_593d49', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_265d04', {}, undefined),
  },
  MEMORY_COMPACTION_TRIGGER_ENTRIES: {
    key: 'MEMORY_COMPACTION_TRIGGER_ENTRIES',
    label: t('config.auto_2f2d76', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_7831d2', {}, undefined),
  },
  MEMORY_COMPACTION_KEEP_RECENT_ENTRIES: {
    key: 'MEMORY_COMPACTION_KEEP_RECENT_ENTRIES',
    label: t('config.auto_29c934', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_acef38', {}, undefined),
  },
  CHAT_CONTEXT_TOKEN_BUDGET: {
    key: 'CHAT_CONTEXT_TOKEN_BUDGET',
    label: 'Chat Context Token Budget',
    effect: 'new_agent',
    summary: 'Preferred total token budget for ordinary chat context lanes before the current user message.',
  },
  CHAT_CONTEXT_RECENT_CHAT_RATIO: {
    key: 'CHAT_CONTEXT_RECENT_CHAT_RATIO',
    label: 'Recent Chat Ratio',
    effect: 'new_agent',
    summary: 'Share of ordinary chat context budget reserved for recent raw user and assistant turns.',
  },
  CHAT_CONTEXT_RECENT_TOOL_RATIO: {
    key: 'CHAT_CONTEXT_RECENT_TOOL_RATIO',
    label: 'Recent Tool Ratio',
    effect: 'new_agent',
    summary: 'Share of ordinary chat context budget reserved for recent structured tool activity.',
  },
  CHAT_CONTEXT_MEMORY_RECALL_RATIO: {
    key: 'CHAT_CONTEXT_MEMORY_RECALL_RATIO',
    label: 'Memory Recall Ratio',
    effect: 'new_agent',
    summary: 'Share of ordinary chat context budget reserved for explicit memory recall entries.',
  },
  CHAT_CONTEXT_SUMMARY_RATIO: {
    key: 'CHAT_CONTEXT_SUMMARY_RATIO',
    label: 'Compacted Summary Ratio',
    effect: 'new_agent',
    summary: 'Share of ordinary chat context budget reserved for compacted chat and tool summaries.',
  },
  CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES: {
    key: 'CHAT_CONTEXT_RAW_CHAT_KEEP_ENTRIES',
    label: 'Raw Chat Window',
    effect: 'new_agent',
    summary: 'How many recent raw chat entries ordinary chat should prefer to keep before summaries dominate.',
  },
  CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS: {
    key: 'CHAT_CONTEXT_RAW_TOOL_KEEP_CALLS',
    label: 'Raw Tool Window',
    effect: 'new_agent',
    summary: 'How many recent completed tool calls ordinary chat should keep as raw structured context.',
  },
  CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES: {
    key: 'CHAT_CONTEXT_CHAT_COMPACTION_TRIGGER_ENTRIES',
    label: 'Chat Compaction Trigger',
    effect: 'new_agent',
    summary: 'Eligible raw chat entry count that triggers deterministic chat compaction for ordinary conversations.',
  },
  CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES: {
    key: 'CHAT_CONTEXT_CHAT_COMPACTION_KEEP_RECENT_ENTRIES',
    label: 'Chat Compaction Keep Recent',
    effect: 'new_agent',
    summary: 'Number of most recent raw chat entries preserved when deterministic chat compaction runs.',
  },
  ALLOW_INSECURE_TLS: {
    key: 'ALLOW_INSECURE_TLS',
    label: t('config.auto_5f8f59', {}, undefined),
    effect: 'new_agent',
    summary: t('config.auto_c12c6f', {}, undefined),
    risk: 'dangerous',
  },
  WEB_LOGIN_USERNAME: {
    key: 'WEB_LOGIN_USERNAME',
    label: t('config.auto_5e4559', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_ea216b', {}, undefined),
  },
  WEB_LOGIN_PASSWORD: {
    key: 'WEB_LOGIN_PASSWORD',
    label: t('config.auto_aa22ba', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_ea216b', {}, undefined),
    risk: 'sensitive',
  },
  LDAP_ENABLED: {
    key: 'LDAP_ENABLED',
    label: t('config.auto_a518f6', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_22944c', {}, undefined),
  },
  LDAP_URL: {
    key: 'LDAP_URL',
    label: t('config.auto_3f1bdf', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_88ebc7', {}, undefined),
  },
  LDAP_BIND_DN: {
    key: 'LDAP_BIND_DN',
    label: t('config.auto_c381f8', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_122ba3', {}, undefined),
  },
  LDAP_BIND_PASSWORD: {
    key: 'LDAP_BIND_PASSWORD',
    label: t('config.auto_6b6e46', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_baccea', {}, undefined),
    risk: 'sensitive',
  },
  LDAP_SEARCH_BASE: {
    key: 'LDAP_SEARCH_BASE',
    label: t('config.auto_aed16e', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_9b0dab', {}, undefined),
  },
  LDAP_SEARCH_FILTER: {
    key: 'LDAP_SEARCH_FILTER',
    label: t('config.auto_43374a', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_3ed6ca', {}, undefined),
  },
  LDAP_ATTRIBUTE_MAP: {
    key: 'LDAP_ATTRIBUTE_MAP',
    label: t('config.auto_209e46', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_b1c505', {}, undefined),
  },
  LDAP_FALLBACK_LOCAL: {
    key: 'LDAP_FALLBACK_LOCAL',
    label: t('config.auto_d92f50', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_6b7689', {}, undefined),
  },
  LDAP_DEFAULT_ROLE: {
    key: 'LDAP_DEFAULT_ROLE',
    label: t('config.auto_0c6e82', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_fdf40b', {}, undefined),
  },
  allowed_directories: {
    key: 'allowed_directories',
    label: t('config.auto_36c2c8', {}, undefined),
    effect: 'new_agent',
    summary:
      t('config.auto_3923df', {}, undefined),
    risk: 'dangerous',
  },
  LIVE2D_ENABLED: {
    key: 'LIVE2D_ENABLED',
    label: t('config.auto_370979', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_6b5423', {}, undefined),
  },
  LIVE2D_EMOTION_ENABLED: {
    key: 'LIVE2D_EMOTION_ENABLED',
    label: t('config.auto_e9a84c', {}, undefined),
    effect: 'instant',
    summary:
      t('config.auto_1114ea', {}, undefined),
  },
  KB_MAX_FILE_SIZE_MB: {
    key: 'KB_MAX_FILE_SIZE_MB',
    label: t('config.auto_131b5f', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_3853d9', {}, undefined),
  },
  KB_MAX_ZIP_SIZE_MB: {
    key: 'KB_MAX_ZIP_SIZE_MB',
    label: t('config.auto_36ffdb', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_781faf', {}, undefined),
  },
  KB_MAX_ZIP_FILES: {
    key: 'KB_MAX_ZIP_FILES',
    label: t('config.auto_bcb293', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_cf3db4', {}, undefined),
  },
  KB_MAX_IMPORT_PAGES: {
    key: 'KB_MAX_IMPORT_PAGES',
    label: t('config.auto_38f43b', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_d76288', {}, undefined),
  },
  KB_MAX_CRAWL_DEPTH: {
    key: 'KB_MAX_CRAWL_DEPTH',
    label: t('config.auto_dec65f', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_d6bf14', {}, undefined),
  },
  KB_CRAWL_CONCURRENCY: {
    key: 'KB_CRAWL_CONCURRENCY',
    label: t('config.auto_8b69e2', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_8f50ad', {}, undefined),
  },
  KB_LLM_CONCURRENCY: {
    key: 'KB_LLM_CONCURRENCY',
    label: t('config.auto_73cfa6', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_7cd9d1', {}, undefined),
  },
  KB_FETCH_TIMEOUT_MS: {
    key: 'KB_FETCH_TIMEOUT_MS',
    label: t('config.auto_97414b', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_986cc9', {}, undefined),
  },
  KB_JINA_TIMEOUT_MS: {
    key: 'KB_JINA_TIMEOUT_MS',
    label: t('config.auto_2d76cd', {}, undefined),
    effect: 'instant',
    summary: t('config.auto_429368', {}, undefined),
  },
};
