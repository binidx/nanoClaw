import { getDefaultProviderForUser } from '../db/assistants.js';
import { getDefaultProvider, type AiProvider } from '../db.js';
import { buildEmbeddingProviderFromAiProvider } from '../embedding/resolve.js';
import { buildProviderFetchHeaders } from './provider-http-config.js';
import { getProviderAdapter } from './provider-adapters.js';
import {
  type AiUsageLog,
  logAiError,
  logAiRequest,
  logAiStreamComplete,
} from './provider-logger.js';
import { recordPromptTrace } from '../prompt/prompt-service.js';
import type { PromptSegment, PromptSourceResolution } from '../types/prompt.js';

import type {
  ProviderConnectivityResult,
  ProviderGeneratedTextResult,
} from './provider-adapters.js';
import { t } from '../i18n/index.js';

export type {
  ProviderConnectivityResult,
  ProviderGeneratedTextResult,
} from './provider-adapters.js';

export function normalizeCodexApiBase(baseUrl: string): string {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('Codex provider base URL is required');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

interface CodexResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

function normalizeCodexUsage(
  usage: CodexResponsesUsage | undefined,
): AiUsageLog | null {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

export async function readFirstCodexChatCompletionText(
  resp: Response,
): Promise<{ text: string; model?: string }> {
  const payload = (await resp.json()) as {
    model?: string;
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return { text: content.trim(), model: payload.model };
  }

  if (Array.isArray(content)) {
    return {
      text: content
        .filter((entry) => typeof entry?.text === 'string')
        .map((entry) => entry.text || '')
        .join('')
        .trim(),
      model: payload.model,
    };
  }

  return { text: '', model: payload.model };
}

export async function readFirstCodexResponseText(
  resp: Response,
): Promise<{ text: string; model?: string; usage?: AiUsageLog | null; responseId?: string }> {
  if (!resp.body) {
    throw new Error('Codex Responses API returned no stream body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputText = '';
  let resolvedModel: string | undefined;
  let usage: AiUsageLog | null = null;
  let responseId: string | undefined;

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data || data === '[DONE]') return false;

    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      item?: {
        type?: string;
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      };
      response?: {
        id?: string;
        error?: { message?: string };
        usage?: CodexResponsesUsage;
      };
    };

    if (event.type === 'response.failed') {
      throw new Error(
        event.response?.error?.message || 'Codex response.failed',
      );
    }

    if (event.type === 'response.output_text.delta' && event.delta) {
      outputText += event.delta;
      return false;
    }

    if (
      event.type === 'response.output_item.done' &&
      event.item?.type === 'message'
    ) {
      const text = (event.item.content || [])
        .filter(
          (entry) =>
            entry.type === 'output_text' && typeof entry.text === 'string',
        )
        .map((entry) => entry.text || '')
        .join('');
      if (text && !outputText) outputText = text;
    }

    if (event.type === 'response.completed') {
      responseId = event.response?.id;
      usage = normalizeCodexUsage(event.response?.usage);
      return true;
    }

    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      const separatorLength = separatorMatch ? separatorMatch[0].length : 2;
      buffer = buffer.slice(boundary + separatorLength);
      if (processBlock(rawEvent)) {
        resolvedModel = resp.headers.get('openai-model') || undefined;
        return {
          text: outputText.trim(),
          model: resolvedModel,
          usage,
          responseId,
        };
      }
      boundary = buffer.search(/\r?\n\r?\n/);
    }

    if (done) break;
  }

  resolvedModel = resp.headers.get('openai-model') || undefined;
  return {
    text: outputText.trim(),
    model: resolvedModel,
    usage,
    responseId,
  };
}

export async function generateTextWithDefaultProvider(
  prompt: string,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    promptTrace?: {
      promptKey?: string | null;
      featureScope: string;
      targetUserId?: string;
      chatJid?: string | null;
      stableSystemPrompt?: string | null;
      volatileSystemPrompt?: string | null;
      contextBlocks?: PromptSegment[];
      systemPromptText?: string | null;
      segments?: PromptSegment[];
      resolution?: PromptSourceResolution[];
      metadata?: Record<string, unknown>;
    };
  },
  userId?: string,
): Promise<string> {
  const provider = userId
    ? await getDefaultProviderForUser(userId)
    : await getDefaultProvider();
  if (!provider) throw new Error('No default AI provider configured');
  const adapter = getProviderAdapter(provider.type);
  const result = await adapter.generateText(provider, prompt, opts);
  if (opts?.promptTrace) {
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: opts.promptTrace.promptKey ?? null,
      featureScope: opts.promptTrace.featureScope,
      targetUserId: opts.promptTrace.targetUserId ?? userId ?? '',
      chatJid: opts.promptTrace.chatJid ?? null,
      provider: provider.type,
      model: result.model || provider.model || null,
      stableSystemPrompt: opts.promptTrace.stableSystemPrompt ?? null,
      volatileSystemPrompt: opts.promptTrace.volatileSystemPrompt ?? null,
      systemPromptText: opts.promptTrace.systemPromptText ?? null,
      userPromptText: prompt,
      providerInputText: prompt,
      contextBlocks: opts.promptTrace.contextBlocks,
      segments: opts.promptTrace.segments,
      resolution: opts.promptTrace.resolution,
      metadata: opts.promptTrace.metadata,
    });
  }
  return result.text;
}

export async function generateTextStreamWithDefaultProvider(
  prompt: string,
  opts?: {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    promptTrace?: {
      promptKey?: string | null;
      featureScope: string;
      targetUserId?: string;
      chatJid?: string | null;
      stableSystemPrompt?: string | null;
      volatileSystemPrompt?: string | null;
      contextBlocks?: PromptSegment[];
      segments?: PromptSegment[];
      resolution?: PromptSourceResolution[];
      metadata?: Record<string, unknown>;
    };
  },
  userId?: string,
): Promise<AsyncIterable<string>> {
  const provider = userId
    ? await getDefaultProviderForUser(userId)
    : await getDefaultProvider();
  if (!provider) throw new Error('No default AI provider configured');
  const adapter = getProviderAdapter(provider.type);
  if (opts?.promptTrace) {
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: opts.promptTrace.promptKey ?? null,
      featureScope: opts.promptTrace.featureScope,
      targetUserId: opts.promptTrace.targetUserId ?? userId ?? '',
      chatJid: opts.promptTrace.chatJid ?? null,
      provider: provider.type,
      model: provider.model || null,
      stableSystemPrompt: opts.promptTrace.stableSystemPrompt ?? null,
      volatileSystemPrompt: opts.promptTrace.volatileSystemPrompt ?? null,
      systemPromptText: opts.systemPrompt ?? null,
      userPromptText: prompt,
      providerInputText: prompt,
      contextBlocks: opts.promptTrace.contextBlocks,
      segments: opts.promptTrace.segments,
      resolution: opts.promptTrace.resolution,
      metadata: opts.promptTrace.metadata,
    });
  }
  return adapter.generateTextStream(provider, prompt, opts);
}

export async function generateWebSearchTextWithDefaultProvider(
  prompt: string,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    promptTrace?: {
      promptKey?: string | null;
      featureScope: string;
      targetUserId?: string;
      chatJid?: string | null;
      stableSystemPrompt?: string | null;
      volatileSystemPrompt?: string | null;
      contextBlocks?: PromptSegment[];
      segments?: PromptSegment[];
      resolution?: PromptSourceResolution[];
      metadata?: Record<string, unknown>;
    };
  } = {},
  userId?: string,
): Promise<ProviderGeneratedTextResult> {
  const provider = userId
    ? await getDefaultProviderForUser(userId)
    : await getDefaultProvider();
  if (!provider) {
    throw new Error('No default AI provider configured');
  }
  if (provider.type !== 'codex') {
    throw new Error('Default AI provider does not support built-in web search');
  }

  const apiBase = normalizeCodexApiBase(provider.base_url || '');
  const model = provider.model || 'gpt-5.4';
  const endpoint = `${apiBase}/responses`;
  const startTime = Date.now();
  const requestId = logAiRequest(provider.type, model, endpoint, prompt, true);
  
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: buildProviderFetchHeaders(provider, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.api_key}`,
      }),
      body: JSON.stringify({
        model: model,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        ],
        tools: [{ type: 'web_search', external_web_access: true }],
        store: false,
        stream: true,
        max_output_tokens: opts.maxTokens || 700,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    });
  } catch (err) {
    logAiError(
      requestId,
      provider.type,
      model,
      endpoint,
      err instanceof Error ? err : new Error(String(err)),
      { requestText: prompt },
    );
    throw err;
  }
  
  if (!resp.ok) {
    const errorText = await resp.text();
    logAiError(
      requestId,
      provider.type,
      model,
      endpoint,
      new Error(`API error ${resp.status}: ${errorText.slice(0, 500)}`),
      { status: resp.status, requestText: prompt, errorBody: errorText },
    );
    throw new Error(
      `AI web search request failed: ${resp.status} ${errorText.slice(0, 500)}`,
    );
  }
  
  const result = await readFirstCodexResponseText(resp);
  const durationMs = Date.now() - startTime;
  logAiStreamComplete(requestId, provider.type, model, endpoint, durationMs, {
    requestText: prompt,
    responseText: result.text,
    usage: result.usage,
    responseId: result.responseId,
  });
  if (opts.promptTrace) {
    await recordPromptTrace({
      traceKind: 'direct_provider',
      promptKey: opts.promptTrace.promptKey ?? null,
      featureScope: opts.promptTrace.featureScope,
      targetUserId: opts.promptTrace.targetUserId ?? userId ?? '',
      chatJid: opts.promptTrace.chatJid ?? null,
      provider: provider.type,
      model: result.model || model,
      stableSystemPrompt: opts.promptTrace.stableSystemPrompt ?? null,
      volatileSystemPrompt: opts.promptTrace.volatileSystemPrompt ?? null,
      userPromptText: prompt,
      providerInputText: prompt,
      contextBlocks: opts.promptTrace.contextBlocks,
      segments: opts.promptTrace.segments,
      resolution: opts.promptTrace.resolution,
      metadata: opts.promptTrace.metadata,
    });
  }
  
  return result;
}

export async function testAiProviderConnection(
  provider: AiProvider,
  timeoutMs = 5000,
): Promise<ProviderConnectivityResult> {
  if ((provider.capability || 'llm') === 'embedding') {
    const embeddingProvider = buildEmbeddingProviderFromAiProvider(provider);
    if (!embeddingProvider) {
      return {
        ok: false,
        message: t('errors.auto_83e291', {}, undefined),
        model: provider.model || undefined,
      };
    }
    const startedAt = Date.now();
    try {
      await Promise.race([
        embeddingProvider.embedQuery('ping'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Embedding test timeout')), timeoutMs),
        ),
      ]);
      return {
        ok: true,
        message: 'embedding ok',
        model: provider.model || undefined,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Embedding test failed',
        model: provider.model || undefined,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
  const adapter = getProviderAdapter(provider.type);
  return adapter.testConnection(provider, timeoutMs);
}
