import { getProvider, getVisibleProvidersForUser, type AiProvider } from '../db.js';
import { getProviderAdapter } from '../provider/provider-adapters.js';
import { supportsProviderCapability } from '../provider/provider-registry.js';

/**
 * Credentials and visibility context for KB-scoped LLM calls.
 * Shared by `llm-enhancer.ts` and `wiki-maintainer.ts`.
 */
export interface KbLlmConfig {
  userId: string;
  llmProviderId: string;
}

/**
 * `jsonMode` is accepted for callers that request JSON-shaped replies; provider adapters
 * already receive an instruction-heavy prompt, so this flag is currently a no-op.
 */
export async function callKbLlm(
  config: KbLlmConfig,
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number; jsonMode?: boolean },
): Promise<string> {
  const provider = await getProvider(config.llmProviderId);
  if (!provider) {
    throw new Error(`KB LLM: provider ${config.llmProviderId} not found`);
  }
  const visible = await getVisibleProvidersForUser(config.userId);
  if (!visible.some((p) => p.id === provider.id)) {
    throw new Error('KB LLM: provider not visible to user');
  }
  if (!supportsProviderCapability(provider, 'llm')) {
    throw new Error('KB LLM: provider is not an LLM provider');
  }
  const adapter = getProviderAdapter(provider.type);
  const effective: AiProvider = { ...provider, model: provider.model };
  const result = await adapter.generateText(effective, prompt, {
    maxTokens: opts?.maxTokens ?? 1200,
    temperature: opts?.temperature ?? 0.3,
  });
  return (result.text || '').trim();
}
