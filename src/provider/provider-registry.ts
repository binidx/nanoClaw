import type { AiProvider } from '../db/assistants.js';
import { decryptValue } from '../crypto.js';
import { getProviderHttpConfig } from './provider-http-config.js';
import { t } from '../i18n/index.js';

export type ProviderCapability = 'llm' | 'embedding';

export type LlmProviderType =
  | 'claude'
  | 'codex'
  | 'openai'
  | 'zhipu'
  | 'gemini'
  | 'cursor'
  | 'openai_compatible';

export type EmbeddingProviderType = 'openai' | 'zhipu' | 'ollama';

export type ProviderType = LlmProviderType | EmbeddingProviderType;
const LEGACY_EMBEDDING_COMPATIBLE_TYPES = new Set<string>([
  'openai',
  'zhipu',
  'openai_compatible',
  'ollama',
]);

export interface ProviderTypeDef {
  type: ProviderType;
  label: string;
  capability: ProviderCapability;
  apiStyle: 'anthropic' | 'openai_compatible';
  defaultBaseUrl: string;
  defaultModel: string;
  requiresBaseUrl: boolean;
  agentEnvMapper: (provider: AiProvider, resolvedModel: string) => Record<string, string>;
}

const LLM_PROVIDER_TYPES: Record<LlmProviderType, ProviderTypeDef> = {
  claude: {
    type: 'claude',
    label: 'Claude (Anthropic)',
    capability: 'llm',
    apiStyle: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    requiresBaseUrl: false,
    agentEnvMapper: (p, model) => {
      const env: Record<string, string> = { AI_PROVIDER: 'claude' };
      if (p.api_key) env.ANTHROPIC_AUTH_TOKEN = p.api_key;
      if (p.base_url) env.ANTHROPIC_BASE_URL = p.base_url;
      if (model) {
        env.ANTHROPIC_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      }
      return env;
    },
  },
  codex: {
    type: 'codex',
    label: 'Codex (OpenAI)',
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: '',
    defaultModel: 'gpt-5.4',
    requiresBaseUrl: true,
    agentEnvMapper: (p, model) => {
      const httpConfig = getProviderHttpConfig(p);
      return {
        AI_PROVIDER: 'codex',
        CODEX_API_KEY: p.api_key || '',
        CODEX_BASE_URL: p.base_url || '',
        CODEX_MODEL: model || 'gpt-5.4',
        ...(httpConfig.userAgent
          ? { CODEX_USER_AGENT: httpConfig.userAgent }
          : {}),
        ...(Object.keys(httpConfig.headers).length > 0
          ? {
            CODEX_EXTRA_HEADERS_JSON: JSON.stringify(httpConfig.headers),
          }
          : {}),
      };
    },
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    requiresBaseUrl: false,
    agentEnvMapper: (p, model) => ({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: p.api_key || '',
      OPENAI_BASE_URL: p.base_url || 'https://api.openai.com/v1',
      OPENAI_MODEL: model || 'gpt-4o',
    }),
  },
  zhipu: {
    type: 'zhipu',
    label: t('errors.auto_ce27ed', {}, undefined),
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    requiresBaseUrl: false,
    agentEnvMapper: (p, model) => ({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: p.api_key || '',
      OPENAI_BASE_URL: p.base_url || 'https://open.bigmodel.cn/api/paas/v4',
      OPENAI_MODEL: model || 'glm-4-plus',
    }),
  },
  gemini: {
    type: 'gemini',
    label: 'Gemini (Google)',
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-pro',
    requiresBaseUrl: false,
    agentEnvMapper: (p, model) => ({
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_API_KEY: p.api_key || '',
      GEMINI_BASE_URL: p.base_url || 'https://generativelanguage.googleapis.com/v1beta/openai',
      GEMINI_MODEL: model || 'gemini-2.5-pro',
    }),
  },
  cursor: {
    type: 'cursor',
    label: 'Cursor API',
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://api2.cursor.sh/v1',
    defaultModel: '',
    requiresBaseUrl: false,
    agentEnvMapper: (p, model) => ({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: p.api_key || '',
      OPENAI_BASE_URL: p.base_url || 'https://api2.cursor.sh/v1',
      OPENAI_MODEL: model || '',
    }),
  },
  openai_compatible: {
    type: 'openai_compatible',
    label: t('errors.auto_1d8923', {}, undefined),
    capability: 'llm',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: '',
    defaultModel: '',
    requiresBaseUrl: true,
    agentEnvMapper: (p, model) => ({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: p.api_key || '',
      OPENAI_BASE_URL: p.base_url || '',
      OPENAI_MODEL: model || '',
    }),
  },
};

const EMBEDDING_PROVIDER_TYPES: Record<EmbeddingProviderType, ProviderTypeDef> = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    capability: 'embedding',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'text-embedding-3-small',
    requiresBaseUrl: false,
    agentEnvMapper: () => ({}),
  },
  zhipu: {
    type: 'zhipu',
    label: t('errors.auto_8c979b', {}, undefined),
    capability: 'embedding',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'embedding-3',
    requiresBaseUrl: false,
    agentEnvMapper: () => ({}),
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama Embedding',
    capability: 'embedding',
    apiStyle: 'openai_compatible',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'nomic-embed-text',
    requiresBaseUrl: false,
    agentEnvMapper: () => ({}),
  },
};

function getProviderTypeMap(capability: ProviderCapability): Record<string, ProviderTypeDef> {
  return capability === 'embedding' ? EMBEDDING_PROVIDER_TYPES : LLM_PROVIDER_TYPES;
}

export function getProviderTypeDef(
  type: string,
  capability: ProviderCapability = 'llm',
): ProviderTypeDef | undefined {
  return getProviderTypeMap(capability)[type];
}

export function getAllProviderTypeDefs(
  capability: ProviderCapability = 'llm',
): ProviderTypeDef[] {
  return Object.values(getProviderTypeMap(capability));
}

export function isValidProviderType(
  type: string,
  capability: ProviderCapability = 'llm',
): type is ProviderType {
  return type in getProviderTypeMap(capability);
}

export function resolveBaseUrl(provider: AiProvider): string {
  const def = getProviderTypeDef(provider.type, provider.capability || 'llm');
  return (provider.base_url || def?.defaultBaseUrl || '').replace(/\/+$/, '');
}

export function resolveModel(provider: AiProvider, override?: string): string {
  const def = getProviderTypeDef(provider.type, provider.capability || 'llm');
  return override || provider.model || def?.defaultModel || '';
}

export function buildAgentEnv(
  provider: AiProvider,
  resolvedModel: string,
  commonEnv: Record<string, string>,
): Record<string, string> {
  const runtimeProvider = withDecryptedProviderSecrets(provider);
  const def = getProviderTypeDef(runtimeProvider.type, runtimeProvider.capability || 'llm');
  if (!def) {
    return { ...commonEnv, AI_PROVIDER: 'claude' };
  }
  return { ...commonEnv, ...def.agentEnvMapper(runtimeProvider, resolvedModel) };
}

export function withDecryptedProviderSecrets<T extends Pick<AiProvider, 'api_key'>>(
  provider: T,
): T {
  if (!provider.api_key) return provider;
  const apiKey = decryptValue(provider.api_key);
  if (apiKey === provider.api_key) return provider;
  return {
    ...provider,
    api_key: apiKey,
  };
}

export function deriveProviderCapability(
  provider: Pick<AiProvider, 'type'> & { capability?: ProviderCapability | null },
): ProviderCapability {
  const explicit = provider.capability;
  if (explicit === 'embedding' || explicit === 'llm') return explicit;
  return 'llm';
}

export function supportsProviderCapability(
  provider: Pick<AiProvider, 'type'> & { capability?: ProviderCapability | null },
  requested: ProviderCapability,
): boolean {
  const explicit = provider.capability;
  if (explicit === 'embedding' || explicit === 'llm') {
    return explicit === requested;
  }
  if (requested === 'llm') return true;
  return LEGACY_EMBEDDING_COMPATIBLE_TYPES.has(provider.type);
}
