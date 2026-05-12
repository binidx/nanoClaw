import crypto from 'crypto';
import { createModuleLogger } from '../logger.js';

const providerLog = createModuleLogger('provider');
const DEFAULT_TEXT_LOG_LIMIT = 2_000;

export interface AiUsageLog {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

interface AiTextLogFieldsInput {
  requestText?: string;
  systemPrompt?: string;
  stableSystemPrompt?: string;
  volatileSystemPrompt?: string;
  contextText?: string;
  userPrompt?: string;
  providerInput?: string;
  responseText?: string;
  errorBody?: string;
}

interface LogAiRequestOptions extends AiTextLogFieldsInput {
  runtime?: 'direct' | 'agent-runner';
}

interface LogAiResponseOptions extends AiTextLogFieldsInput {
  contentLength?: number;
  usage?: AiUsageLog | null;
  responseId?: string;
  runtime?: 'direct' | 'agent-runner';
}

interface LogAiErrorOptions extends AiTextLogFieldsInput {
  status?: number;
  usage?: AiUsageLog | null;
  responseId?: string;
  runtime?: 'direct' | 'agent-runner';
}

interface TruncatedLogText {
  preview: string;
  totalLength: number;
}

function truncateForLog(
  str: string,
  maxLength: number,
): TruncatedLogText {
  const totalLength = str.length;
  if (totalLength <= maxLength) {
    return { preview: str, totalLength };
  }
  const notice = `...[truncated, total ${totalLength} chars]...`;
  const budget = Math.max(0, maxLength - notice.length);
  const head = Math.ceil(budget * 0.75);
  const tail = Math.max(0, budget - head);
  return {
    preview: `${str.slice(0, head)}${notice}${tail > 0 ? str.slice(-tail) : ''}`,
    totalLength,
  };
}

function buildPreviewFields(input: AiTextLogFieldsInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const entries: Array<[string, string | undefined]> = [
    ['requestText', input.requestText],
    ['systemPrompt', input.systemPrompt],
    ['stableSystemPrompt', input.stableSystemPrompt],
    ['volatileSystemPrompt', input.volatileSystemPrompt],
    ['contextText', input.contextText],
    ['userPrompt', input.userPrompt],
    ['providerInput', input.providerInput],
    ['responseText', input.responseText],
    ['errorBody', input.errorBody],
  ];
  for (const [name, value] of entries) {
    if (typeof value !== 'string') continue;
    const truncated = truncateForLog(value, DEFAULT_TEXT_LOG_LIMIT);
    fields[`${name}Preview`] = truncated.preview;
    fields[`${name}Chars`] = truncated.totalLength;
  }
  return fields;
}

export function logAiRequest(
  provider: string,
  model: string,
  endpoint: string,
  requestText: string,
  isStream: boolean,
  options: LogAiRequestOptions = {},
): string {
  const requestId = crypto.randomUUID();
  providerLog.info(
    {
      kind: 'ai_request',
      requestId,
      provider,
      model,
      endpoint,
      isStream,
      runtime: options.runtime || 'direct',
      ...buildPreviewFields({
        requestText,
        systemPrompt: options.systemPrompt,
        providerInput: options.providerInput,
      }),
    },
    'AI request sent',
  );
  return requestId;
}

export function logAiResponse(
  requestId: string,
  provider: string,
  model: string,
  endpoint: string,
  status: number,
  durationMs: number,
  options: LogAiResponseOptions = {},
): void {
  providerLog.info(
    {
      kind: 'ai_response',
      requestId,
      provider,
      model,
      endpoint,
      status,
      durationMs,
      contentLength: options.contentLength,
      responseId: options.responseId,
      usage: options.usage || null,
      runtime: options.runtime || 'direct',
      ...buildPreviewFields({
        requestText: options.requestText,
        systemPrompt: options.systemPrompt,
        providerInput: options.providerInput,
        responseText: options.responseText,
      }),
    },
    'AI response received',
  );
}

export function logAiError(
  requestId: string,
  provider: string,
  model: string,
  endpoint: string,
  error: Error,
  options: LogAiErrorOptions = {},
): void {
  const errorMessage = truncateForLog(error.message, 500);
  providerLog.error(
    {
      kind: 'ai_error',
      requestId,
      provider,
      model,
      endpoint,
      status: options.status,
      responseId: options.responseId,
      usage: options.usage || null,
      runtime: options.runtime || 'direct',
      error: error.name,
      errorMessage: errorMessage.preview,
      errorTotalChars: errorMessage.totalLength,
      stack: error.stack,
      ...buildPreviewFields({
        requestText: options.requestText,
        systemPrompt: options.systemPrompt,
        providerInput: options.providerInput,
        responseText: options.responseText,
        errorBody: options.errorBody,
      }),
    },
    'AI request failed',
  );
}

export function logAiStreamComplete(
  requestId: string,
  provider: string,
  model: string,
  endpoint: string,
  durationMs: number,
  options: Omit<LogAiResponseOptions, 'contentLength'> = {},
): void {
  providerLog.info(
    {
      kind: 'ai_response',
      requestId,
      provider,
      model,
      endpoint,
      durationMs,
      responseId: options.responseId,
      usage: options.usage || null,
      isStream: true,
      runtime: options.runtime || 'direct',
      ...buildPreviewFields({
        requestText: options.requestText,
        systemPrompt: options.systemPrompt,
        providerInput: options.providerInput,
        responseText: options.responseText,
      }),
    },
    'AI stream completed',
  );
}
