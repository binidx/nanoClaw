import type { EmbeddingProvider, EmbeddingProviderConfig } from './provider.js';
import { OpenAIEmbeddingProvider } from './providers/openai.js';
import { ZhipuEmbeddingProvider } from './providers/zhipu.js';
import { OllamaEmbeddingProvider } from './providers/ollama.js';
import { getConfigValue } from '../config-store.js';
import { createModuleLogger } from '../logger.js';
import type { AiProvider } from '../db.js';
import { supportsProviderCapability } from '../provider/provider-registry.js';

const logger = createModuleLogger('embedding');

let cachedProvider: EmbeddingProvider | null | undefined;

export async function getEmbeddingConfig(): Promise<EmbeddingProviderConfig> {
  const provider = await getConfigValue('EMBEDDING_PROVIDER').catch(() => 'none');
  const apiKey = await getConfigValue('EMBEDDING_API_KEY').catch(() => '');
  const model = await getConfigValue('EMBEDDING_MODEL').catch(() => '');
  const baseUrl = await getConfigValue('EMBEDDING_BASE_URL').catch(() => '');
  const dims = await getConfigValue('EMBEDDING_DIMENSIONS').catch(() => '');
  return {
    provider: provider || 'none',
    apiKey: apiKey || undefined,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    dimensions: dims ? parseInt(dims, 10) : undefined,
  };
}

export function buildEmbeddingProvider(cfg: EmbeddingProviderConfig): EmbeddingProvider | null {
  const providerName = (cfg.provider || 'none').toLowerCase().trim();
  switch (providerName) {
    case 'openai': {
      if (!cfg.apiKey) {
        logger.warn('EMBEDDING_API_KEY required for OpenAI provider');
        return null;
      }
      return new OpenAIEmbeddingProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        dimensions: cfg.dimensions,
        configKey: `${providerName}:${cfg.baseUrl || ''}:${cfg.model || ''}:${cfg.dimensions ?? ''}`,
      });
    }
    case 'zhipu': {
      if (!cfg.apiKey) {
        logger.warn('EMBEDDING_API_KEY required for Zhipu provider');
        return null;
      }
      return new ZhipuEmbeddingProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        dimensions: cfg.dimensions,
        configKey: `${providerName}:${cfg.baseUrl || ''}:${cfg.model || ''}:${cfg.dimensions ?? ''}`,
      });
    }
    case 'ollama':
      return new OllamaEmbeddingProvider({
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        dimensions: cfg.dimensions,
        configKey: `${providerName}:${cfg.baseUrl || ''}:${cfg.model || ''}:${cfg.dimensions ?? ''}`,
      });
    case 'none':
    case '':
      return null;
    default:
      logger.warn({ provider: cfg.provider }, 'Unknown embedding provider');
      return null;
  }
}

export function buildEmbeddingProviderFromAiProvider(
  provider: Pick<AiProvider, 'id' | 'type' | 'capability' | 'api_key' | 'base_url' | 'model' | 'dimensions' | 'updated_at'>,
): EmbeddingProvider | null {
  if (!supportsProviderCapability(provider, 'embedding')) {
    logger.warn({ providerId: provider.id, capability: provider.capability }, 'Attempted to build embedding provider from non-embedding record');
    return null;
  }

  const configKey = `${provider.id}:${provider.updated_at}:${provider.type}:${provider.base_url || ''}:${provider.model || ''}:${provider.dimensions ?? ''}`;
  switch (provider.type) {
    case 'openai':
    case 'openai_compatible':
      if (!provider.api_key) return null;
      return new OpenAIEmbeddingProvider({
        apiKey: provider.api_key,
        model: provider.model || undefined,
        baseUrl: provider.base_url || undefined,
        dimensions: provider.dimensions ?? undefined,
        configKey,
      });
    case 'zhipu':
      if (!provider.api_key) return null;
      return new ZhipuEmbeddingProvider({
        apiKey: provider.api_key,
        model: provider.model || undefined,
        baseUrl: provider.base_url || undefined,
        dimensions: provider.dimensions ?? undefined,
        configKey,
      });
    case 'ollama':
      return new OllamaEmbeddingProvider({
        model: provider.model || undefined,
        baseUrl: provider.base_url || undefined,
        dimensions: provider.dimensions ?? undefined,
        configKey,
      });
    default:
      logger.warn({ providerId: provider.id, type: provider.type }, 'Unknown embedding provider type');
      return null;
  }
}

export async function resolveEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  if (cachedProvider !== undefined) return cachedProvider;
  const cfg = await getEmbeddingConfig();
  cachedProvider = buildEmbeddingProvider(cfg);
  if (cachedProvider) {
    logger.info(
      { provider: cachedProvider.name, dimensions: cachedProvider.dimensions },
      'Embedding provider initialized',
    );
  }
  return cachedProvider;
}

export function resetEmbeddingProviderCache(): void {
  cachedProvider = undefined;
}
