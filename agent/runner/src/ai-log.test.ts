import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUNNER_AI_LOG_PREFIX,
  emitAiErrorLog,
  emitAiRequestLog,
  emitAiResponseLog,
} from './ai-log.js';

describe('agent runner ai-log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits request and response logs with structured previews', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const requestId = emitAiRequestLog(
      'codex',
      'gpt-5.4',
      'https://api.example.com/v1/responses',
      'user prompt',
      true,
      {
        systemPrompt: 'system prompt',
        apiMode: 'responses',
      },
    );

    emitAiResponseLog(requestId, 'codex', 'gpt-5.4', 'https://api.example.com/v1/responses', {
      apiMode: 'responses',
      responseText: 'assistant output',
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    });

    expect(consoleError).toHaveBeenCalledTimes(2);
    const requestLine = consoleError.mock.calls[0]?.[0];
    const responseLine = consoleError.mock.calls[1]?.[0];
    expect(typeof requestLine).toBe('string');
    expect(typeof responseLine).toBe('string');
    expect(String(requestLine).startsWith(AGENT_RUNNER_AI_LOG_PREFIX)).toBe(true);
    expect(String(responseLine).startsWith(AGENT_RUNNER_AI_LOG_PREFIX)).toBe(true);

    const requestPayload = JSON.parse(
      String(requestLine).slice(AGENT_RUNNER_AI_LOG_PREFIX.length),
    ) as Record<string, unknown>;
    const responsePayload = JSON.parse(
      String(responseLine).slice(AGENT_RUNNER_AI_LOG_PREFIX.length),
    ) as Record<string, unknown>;

    expect(requestPayload.kind).toBe('ai_request');
    expect(requestPayload.requestTextPreview).toBe('user prompt');
    expect(requestPayload.systemPromptPreview).toBe('system prompt');
    expect(responsePayload.kind).toBe('ai_response');
    expect(responsePayload.responseTextPreview).toBe('assistant output');
    expect(responsePayload.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    });
  });

  it('emits structured error logs', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    emitAiErrorLog(
      'req-1',
      'codex',
      'gpt-5.4',
      'https://api.example.com/v1/responses',
      new Error('boom'),
      {
        requestText: 'user prompt',
        errorBody: 'upstream error body',
      },
    );

    const line = consoleError.mock.calls[0]?.[0];
    expect(String(line).startsWith(AGENT_RUNNER_AI_LOG_PREFIX)).toBe(true);
    const payload = JSON.parse(
      String(line).slice(AGENT_RUNNER_AI_LOG_PREFIX.length),
    ) as Record<string, unknown>;
    expect(payload.kind).toBe('ai_error');
    expect(payload.errorMessage).toBe('boom');
    expect(payload.errorBodyPreview).toBe('upstream error body');
  });
});
