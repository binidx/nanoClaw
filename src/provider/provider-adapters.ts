import type { AiProvider } from '../db/assistants.js';
import { buildProviderFetchHeaders } from './provider-http-config.js';
import {
  getProviderTypeDef,
  resolveBaseUrl,
  resolveModel,
  withDecryptedProviderSecrets,
} from './provider-registry.js';
import {
  type AiUsageLog,
  logAiError,
  logAiRequest,
  logAiResponse,
  logAiStreamComplete,
} from './provider-logger.js';

export interface ProviderConnectivityResult {
  ok: boolean;
  status:
    | 'success'
    | 'http_error'
    | 'timeout'
    | 'network_error'
    | 'configuration_error'
    | 'unknown_error';
  message: string;
  model?: string;
  latencyMs?: number;
  endpoint?: string;
  httpStatus?: number;
  providerType?: string;
  capability?: 'llm' | 'embedding';
}

export interface ProviderGeneratedTextResult {
  text: string;
  model?: string;
}

export interface ProviderApiAdapter {
  testConnection(provider: AiProvider, timeoutMs?: number): Promise<ProviderConnectivityResult>;
  generateText(
    provider: AiProvider,
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<ProviderGeneratedTextResult>;
  generateTextStream(
    provider: AiProvider,
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
  ): AsyncIterable<string>;
}

interface AnthropicResponsePayload {
  content?: Array<{ text?: string }>;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface OpenAiCompatiblePayload {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

function normalizeAnthropicUsage(
  usage: AnthropicResponsePayload['usage'] | undefined,
): AiUsageLog | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens =
    typeof inputTokens === 'number' || typeof outputTokens === 'number'
      ? (inputTokens || 0) + (outputTokens || 0)
      : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function normalizeOpenAiUsage(
  usage: OpenAiCompatiblePayload['usage'] | undefined,
): AiUsageLog | null {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    totalTokens: usage.total_tokens,
  };
}

function extractOpenAiText(payload: OpenAiCompatiblePayload): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((entry) => typeof entry?.text === 'string')
      .map((entry) => entry.text || '')
      .join('')
      .trim();
  }
  return '';
}

class AnthropicAdapter implements ProviderApiAdapter {
  async testConnection(provider: AiProvider, timeoutMs = 5000): Promise<ProviderConnectivityResult> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const endpoint = `${baseUrl}/v1/messages`;
    const requestText = 'Say "ok" in one word';
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, requestText, false);
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (provider.api_key) baseHeaders['x-api-key'] = provider.api_key;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 20,
          messages: [{ role: 'user', content: requestText }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        err instanceof Error ? err : new Error(String(err)),
        { requestText },
      );
      throw err;
    }
    const latencyMs = Date.now() - startTime;
    const contentLength = Number(resp.headers.get('content-length')) || 0;
    if (!resp.ok) {
      const errorText = await resp.text();
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        new Error(`API error ${resp.status}: ${errorText.slice(0, 500)}`),
        { status: resp.status, requestText, errorBody: errorText },
      );
      return {
        ok: false,
        status: 'http_error',
        message: `API error ${resp.status}: ${errorText.slice(0, 200)}`,
        model,
        latencyMs,
        endpoint,
        httpStatus: resp.status,
      };
    }
    const data = (await resp.json()) as AnthropicResponsePayload;
    const responseText = data.content?.[0]?.text?.trim() || 'ok';
    logAiResponse(requestId, provider.type, model, endpoint, resp.status, latencyMs, {
      contentLength,
      requestText,
      responseText,
      usage: normalizeAnthropicUsage(data.usage),
    });
    return {
      ok: true,
      status: 'success',
      message: responseText,
      model: data.model,
      latencyMs,
      endpoint,
      httpStatus: resp.status,
    };
  }

  async generateText(
    provider: AiProvider,
    prompt: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<ProviderGeneratedTextResult> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const endpoint = `${baseUrl}/v1/messages`;
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, prompt, false);
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (provider.api_key) baseHeaders['x-api-key'] = provider.api_key;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: opts.maxTokens || 300,
          messages: [{ role: 'user', content: prompt }],
        }),
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
    const durationMs = Date.now() - startTime;
    const contentLength = Number(resp.headers.get('content-length')) || 0;
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
      throw new Error(`AI request failed: ${resp.status} ${errorText.slice(0, 500)}`);
    }
    const data = (await resp.json()) as AnthropicResponsePayload;
    const responseText = data.content?.[0]?.text?.trim() || '';
    logAiResponse(requestId, provider.type, model, endpoint, resp.status, durationMs, {
      contentLength,
      requestText: prompt,
      responseText,
      usage: normalizeAnthropicUsage(data.usage),
    });
    return { text: responseText, model: data.model };
  }

  async *generateTextStream(
    provider: AiProvider,
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {},
  ): AsyncIterable<string> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const endpoint = `${baseUrl}/v1/messages`;
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, prompt, true, {
      systemPrompt: opts.systemPrompt,
    });
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (provider.api_key) baseHeaders['x-api-key'] = provider.api_key;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: opts.maxTokens || 4096,
          stream: true,
          ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (err) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        err instanceof Error ? err : new Error(String(err)),
        { requestText: prompt, systemPrompt: opts.systemPrompt },
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
        {
          status: resp.status,
          requestText: prompt,
          systemPrompt: opts.systemPrompt,
          errorBody: errorText,
        },
      );
      throw new Error(`AI stream request failed: ${resp.status} ${errorText}`);
    }
    if (!resp.body) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        new Error('No stream body returned'),
        { requestText: prompt, systemPrompt: opts.systemPrompt },
      );
      throw new Error('No stream body returned');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            finished = true;
            break;
          }
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              evt.type === 'content_block_delta' &&
              evt.delta?.type === 'text_delta' &&
              evt.delta.text
            ) {
              responseText += evt.delta.text;
              yield evt.delta.text;
            }
          } catch {
            // skip malformed lines
          }
        }
        if (finished || done) break;
      }
    } finally {
      reader.releaseLock();
    }
    const durationMs = Date.now() - startTime;
    logAiStreamComplete(requestId, provider.type, model, endpoint, durationMs, {
      requestText: prompt,
      systemPrompt: opts.systemPrompt,
      responseText,
    });
  }
}

class OpenAICompatibleAdapter implements ProviderApiAdapter {
  async testConnection(provider: AiProvider, timeoutMs = 5000): Promise<ProviderConnectivityResult> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const endpoint = `${apiBase}/chat/completions`;
    const requestText = 'Say "ok" in one word';
    const systemPrompt = 'Reply in one short word.';
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, requestText, false, {
      systemPrompt,
    });
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (provider.api_key) baseHeaders['Authorization'] = `Bearer ${provider.api_key}`;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'gpt-4o',
          stream: false,
          max_tokens: 20,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: requestText },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        err instanceof Error ? err : new Error(String(err)),
        { requestText, systemPrompt },
      );
      throw err;
    }
    const latencyMs = Date.now() - startTime;
    const contentLength = Number(resp.headers.get('content-length')) || 0;
    if (!resp.ok) {
      const errorText = await resp.text();
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        new Error(`API error ${resp.status}: ${errorText.slice(0, 500)}`),
        { status: resp.status, requestText, systemPrompt, errorBody: errorText },
      );
      return {
        ok: false,
        status: 'http_error',
        message: `API error ${resp.status}: ${errorText.slice(0, 200)}`,
        model,
        latencyMs,
        endpoint,
        httpStatus: resp.status,
      };
    }
    const payload = (await resp.json()) as OpenAiCompatiblePayload;
    const responseText = extractOpenAiText(payload) || 'ok';
    logAiResponse(requestId, provider.type, model, endpoint, resp.status, latencyMs, {
      contentLength,
      requestText,
      systemPrompt,
      responseText,
      usage: normalizeOpenAiUsage(payload.usage),
    });
    return {
      ok: true,
      status: 'success',
      message: responseText,
      model: payload.model,
      latencyMs,
      endpoint,
      httpStatus: resp.status,
    };
  }

  async generateText(
    provider: AiProvider,
    prompt: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<ProviderGeneratedTextResult> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const endpoint = `${apiBase}/chat/completions`;
    const systemPrompt = 'Return only valid JSON.';
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, prompt, false, {
      systemPrompt,
    });
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (provider.api_key) baseHeaders['Authorization'] = `Bearer ${provider.api_key}`;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'gpt-4o',
          stream: false,
          max_tokens: opts.maxTokens || 300,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (err) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        err instanceof Error ? err : new Error(String(err)),
        { requestText: prompt, systemPrompt },
      );
      throw err;
    }
    const durationMs = Date.now() - startTime;
    const contentLength = Number(resp.headers.get('content-length')) || 0;
    if (!resp.ok) {
      const errorText = await resp.text();
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        new Error(`API error ${resp.status}: ${errorText.slice(0, 500)}`),
        { status: resp.status, requestText: prompt, systemPrompt, errorBody: errorText },
      );
      throw new Error(`AI request failed: ${resp.status} ${errorText.slice(0, 500)}`);
    }
    const payload = (await resp.json()) as OpenAiCompatiblePayload;
    const responseText = extractOpenAiText(payload);
    logAiResponse(requestId, provider.type, model, endpoint, resp.status, durationMs, {
      contentLength,
      requestText: prompt,
      systemPrompt,
      responseText,
      usage: normalizeOpenAiUsage(payload.usage),
    });
    return { text: responseText, model: payload.model };
  }

  async *generateTextStream(
    provider: AiProvider,
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {},
  ): AsyncIterable<string> {
    const baseUrl = resolveBaseUrl(provider);
    const model = resolveModel(provider);
    const apiBase = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const endpoint = `${apiBase}/chat/completions`;
    const startTime = Date.now();
    const requestId = logAiRequest(provider.type, model, endpoint, prompt, true, {
      systemPrompt: opts.systemPrompt,
    });
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (provider.api_key) baseHeaders['Authorization'] = `Bearer ${provider.api_key}`;
    const headers = buildProviderFetchHeaders(provider, baseHeaders);

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'gpt-4o',
          stream: true,
          max_tokens: opts.maxTokens || 4096,
          messages,
        }),
      });
    } catch (err) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        err instanceof Error ? err : new Error(String(err)),
        { requestText: prompt, systemPrompt: opts.systemPrompt },
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
        {
          status: resp.status,
          requestText: prompt,
          systemPrompt: opts.systemPrompt,
          errorBody: errorText,
        },
      );
      throw new Error(`AI stream request failed: ${resp.status} ${errorText}`);
    }
    if (!resp.body) {
      logAiError(
        requestId,
        provider.type,
        model,
        endpoint,
        new Error('No stream body returned'),
        { requestText: prompt, systemPrompt: opts.systemPrompt },
      );
      throw new Error('No stream body returned');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            finished = true;
            break;
          }
          try {
            const evt = JSON.parse(raw) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) {
              responseText += delta;
              yield delta;
            }
          } catch {
            // skip malformed lines
          }
        }
        if (finished || done) break;
      }
    } finally {
      reader.releaseLock();
    }
    const durationMs = Date.now() - startTime;
    logAiStreamComplete(requestId, provider.type, model, endpoint, durationMs, {
      requestText: prompt,
      systemPrompt: opts.systemPrompt,
      responseText,
    });
  }
}

const anthropicAdapter = new AnthropicAdapter();
const openaiAdapter = new OpenAICompatibleAdapter();

function withRuntimeSecrets(adapter: ProviderApiAdapter): ProviderApiAdapter {
  return {
    testConnection(provider, timeoutMs) {
      return adapter.testConnection(withDecryptedProviderSecrets(provider), timeoutMs);
    },
    generateText(provider, prompt, opts) {
      return adapter.generateText(withDecryptedProviderSecrets(provider), prompt, opts);
    },
    generateTextStream(provider, prompt, opts) {
      return adapter.generateTextStream(withDecryptedProviderSecrets(provider), prompt, opts);
    },
  };
}

const runtimeAnthropicAdapter = withRuntimeSecrets(anthropicAdapter);
const runtimeOpenaiAdapter = withRuntimeSecrets(openaiAdapter);

export function getProviderAdapter(providerType: string): ProviderApiAdapter {
  const def = getProviderTypeDef(providerType);
  return def?.apiStyle === 'anthropic' ? runtimeAnthropicAdapter : runtimeOpenaiAdapter;
}
