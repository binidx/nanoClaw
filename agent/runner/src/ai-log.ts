import crypto from 'crypto';

export const AGENT_RUNNER_AI_LOG_PREFIX = '[agent-runner-ai]';
const DEFAULT_TEXT_LOG_LIMIT = 2_000;

export interface AgentRunnerAiUsageLog {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AgentRunnerAiLogContext {
  apiMode?: 'responses' | 'chat_completions';
  chatJid?: string;
  sessionId?: string;
  externalRequestId?: string;
  iteration?: number;
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

interface AgentRunnerAiRequestOptions extends AiTextLogFieldsInput, AgentRunnerAiLogContext {}

interface AgentRunnerAiResponseOptions extends AiTextLogFieldsInput, AgentRunnerAiLogContext {
  status?: number;
  durationMs?: number;
  usage?: AgentRunnerAiUsageLog | null;
  responseId?: string;
}

interface AgentRunnerAiErrorOptions extends AiTextLogFieldsInput, AgentRunnerAiLogContext {
  status?: number;
  usage?: AgentRunnerAiUsageLog | null;
  responseId?: string;
}

type AgentRunnerAiLogKind = 'ai_request' | 'ai_response' | 'ai_error';

function truncateForLog(str: string, maxLength: number): { preview: string; totalLength: number } {
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

function emitLog(kind: AgentRunnerAiLogKind, payload: Record<string, unknown>): void {
  console.error(`${AGENT_RUNNER_AI_LOG_PREFIX}${JSON.stringify({ kind, runtime: 'agent-runner', ...payload })}`);
}

export function emitAiRequestLog(
  provider: string,
  model: string,
  endpoint: string,
  requestText: string,
  isStream: boolean,
  options: AgentRunnerAiRequestOptions = {},
): string {
  const requestId = crypto.randomUUID();
  emitLog('ai_request', {
    requestId,
    provider,
    model,
    endpoint,
    isStream,
    ...options,
    ...buildPreviewFields({
      requestText,
      systemPrompt: options.systemPrompt,
      providerInput: options.providerInput,
    }),
  });
  return requestId;
}

export function emitAiResponseLog(
  requestId: string,
  provider: string,
  model: string,
  endpoint: string,
  options: AgentRunnerAiResponseOptions = {},
): void {
  emitLog('ai_response', {
    requestId,
    provider,
    model,
    endpoint,
    ...options,
    usage: options.usage || null,
    ...buildPreviewFields({
      requestText: options.requestText,
      systemPrompt: options.systemPrompt,
      providerInput: options.providerInput,
      responseText: options.responseText,
    }),
  });
}

export function emitAiErrorLog(
  requestId: string,
  provider: string,
  model: string,
  endpoint: string,
  error: Error,
  options: AgentRunnerAiErrorOptions = {},
): void {
  const truncated = truncateForLog(error.message, 500);
  emitLog('ai_error', {
    requestId,
    provider,
    model,
    endpoint,
    ...options,
    usage: options.usage || null,
    error: error.name,
    errorMessage: truncated.preview,
    errorTotalChars: truncated.totalLength,
    stack: error.stack,
    ...buildPreviewFields({
      requestText: options.requestText,
      systemPrompt: options.systemPrompt,
      providerInput: options.providerInput,
      responseText: options.responseText,
      errorBody: options.errorBody,
    }),
  });
}
