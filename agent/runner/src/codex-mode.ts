export type CodexCompatibilityMode = 'responses' | 'chat_completions';

export interface CodexCompatibilityState {
  mode: CodexCompatibilityMode;
  reason?: string;
  updatedAt: string;
}

export type CodexApiMode = 'auto' | 'responses' | 'chat_completions';

type ErrorLike = {
  message?: string;
  status?: number;
  code?: string;
};

const RESPONSES_LOCAL_TOOLS_GATEWAY_FALLBACK_CODE =
  'responses_local_tools_gateway_fallback';

export function parseCodexApiMode(value: unknown): CodexApiMode {
  return value === 'responses' || value === 'chat_completions'
    ? value
    : 'auto';
}

export function isOfficialOpenAiCodexBase(baseUrl: string | undefined): boolean {
  const raw = String(baseUrl || '').trim();
  if (!raw) return false;
  try {
    const normalized = raw.endsWith('/v1') ? raw : `${raw.replace(/\/+$/, '')}/v1`;
    const parsed = new URL(normalized);
    return parsed.hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function shouldHonorCompatibilityState(
  state: CodexCompatibilityState | undefined,
): boolean {
  if (!state || state.mode !== 'chat_completions') return false;
  const reason = String(state.reason || '').trim();
  if (
    reason ===
    'Custom Codex base URL detected; preferring chat/completions for tool-call reliability'
  ) {
    return false;
  }
  return true;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as ErrorLike).message || '');
  }
  return String(error);
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return undefined;
  }
  const status = Number((error as ErrorLike).status);
  return Number.isFinite(status) ? status : undefined;
}

function getErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return '';
  }
  return String((error as ErrorLike).code || '').trim();
}

export function getCodexResponsesCompatibilityReason(
  error: unknown,
): string | null {
  const message = getErrorMessage(error);
  const code = getErrorCode(error);
  if (
    code === RESPONSES_LOCAL_TOOLS_GATEWAY_FALLBACK_CODE ||
    /Responses API local function tool continuation is unsupported on this gateway/i.test(
      message,
    )
  ) {
    return 'Responses API local function tool continuation is unsupported on this gateway';
  }
  if (/No tool call found for function call output/i.test(message)) {
    return 'Responses API rejected function_call_output continuation';
  }
  if (/function_call_output/i.test(message) && /call_id/i.test(message)) {
    return 'Responses API tool continuation is incompatible';
  }
  if (/pre_consume_token_quota_failed/i.test(message)) {
    return 'Responses API provider transaction pre-consume failed';
  }
  if (/无效的令牌/i.test(message) && /数据库查询出错/i.test(message)) {
    return 'Responses API provider authentication lookup failed';
  }
  if (
    /An error occurred while processing your request/i.test(message) ||
    /internal server error/i.test(message)
  ) {
    return 'Responses API provider returned a generic processing error';
  }
  const status = getErrorStatus(error);
  if (status !== undefined) {
    if ([400, 404, 405, 422].includes(status)) {
      return `Responses API returned HTTP ${status}`;
    }
    if (status >= 500) {
      return `Responses API returned HTTP ${status}`;
    }
  }
  return null;
}

export function resolvePreferredCodexMode(input: {
  configuredMode: CodexApiMode;
  compatibilityState?: CodexCompatibilityState;
  nativeWebSearchPreferred: boolean;
  baseUrl: string | undefined;
}): { mode: CodexCompatibilityMode; reason: string } {
  if (input.configuredMode === 'responses') {
    return {
      mode: 'responses',
      reason: 'Configured to use Responses API',
    };
  }
  if (input.configuredMode === 'chat_completions') {
    return {
      mode: 'chat_completions',
      reason: 'Configured to use chat/completions API',
    };
  }
  if (shouldHonorCompatibilityState(input.compatibilityState)) {
    return {
      mode: 'chat_completions',
      reason:
        input.compatibilityState?.reason ||
        'Chat/completions compatibility mode for reliable function tools',
    };
  }
  if (input.nativeWebSearchPreferred) {
    return {
      mode: 'responses',
      reason: isOfficialOpenAiCodexBase(input.baseUrl)
        ? 'Responses API preferred on official OpenAI endpoint for native web_search'
        : 'Responses API preferred so Codex can use native web_search',
    };
  }
  return {
    mode: 'chat_completions',
    reason: 'Chat/completions is the default Codex mode for reliable function tools',
  };
}
