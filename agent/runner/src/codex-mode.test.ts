import { describe, expect, it } from 'vitest';

import {
  getCodexResponsesCompatibilityReason,
  isOfficialOpenAiCodexBase,
  parseCodexApiMode,
  resolvePreferredCodexMode,
} from './codex-mode.js';

describe('codex mode selection', () => {
  it('keeps Responses mode for custom codex gateways when native web search is preferred', () => {
    expect(
      resolvePreferredCodexMode({
        configuredMode: 'auto',
        nativeWebSearchPreferred: true,
        baseUrl: 'https://ruoli.dev/',
      }),
    ).toEqual({
      mode: 'responses',
      reason: 'Responses API preferred so Codex can use native web_search',
    });
  });

  it('keeps Responses mode for official OpenAI endpoints when native web search is preferred', () => {
    expect(
      resolvePreferredCodexMode({
        configuredMode: 'auto',
        nativeWebSearchPreferred: true,
        baseUrl: 'https://api.openai.com/',
      }),
    ).toEqual({
      mode: 'responses',
      reason: 'Responses API preferred on official OpenAI endpoint for native web_search',
    });
  });

  it('honors saved chat/completions compatibility state', () => {
    expect(
      resolvePreferredCodexMode({
        configuredMode: 'auto',
        nativeWebSearchPreferred: true,
        baseUrl: 'https://api.openai.com/',
        compatibilityState: {
          mode: 'chat_completions',
          reason: 'Responses API returned HTTP 500',
          updatedAt: '2026-03-18T08:03:24.000Z',
        },
      }),
    ).toEqual({
      mode: 'chat_completions',
      reason: 'Responses API returned HTTP 500',
    });
  });

  it('ignores the old custom-gateway fallback cache after the strategy changed', () => {
    expect(
      resolvePreferredCodexMode({
        configuredMode: 'auto',
        nativeWebSearchPreferred: true,
        baseUrl: 'https://ruoli.dev/',
        compatibilityState: {
          mode: 'chat_completions',
          reason:
            'Custom Codex base URL detected; preferring chat/completions for tool-call reliability',
          updatedAt: '2026-03-18T09:00:50.506Z',
        },
      }),
    ).toEqual({
      mode: 'responses',
      reason: 'Responses API preferred so Codex can use native web_search',
    });
  });
});

describe('codex responses compatibility detection', () => {
  it('treats the local gateway tool-continuation fallback as compatibility-only', () => {
    expect(
      getCodexResponsesCompatibilityReason({
        code: 'responses_local_tools_gateway_fallback',
        message:
          'Responses API local function tool continuation is unsupported on this gateway',
      }),
    ).toBe(
      'Responses API local function tool continuation is unsupported on this gateway',
    );
  });

  it('classifies generic provider processing errors as compatibility failures', () => {
    expect(
      getCodexResponsesCompatibilityReason(
        new Error(
          'An error occurred while processing your request. Please include the request ID x.',
        ),
      ),
    ).toBe('Responses API provider returned a generic processing error');
  });

  it('recognizes official openai base URLs', () => {
    expect(isOfficialOpenAiCodexBase('https://api.openai.com')).toBe(true);
    expect(isOfficialOpenAiCodexBase('https://ruoli.dev')).toBe(false);
  });

  it('parses configured api mode values safely', () => {
    expect(parseCodexApiMode('responses')).toBe('responses');
    expect(parseCodexApiMode('chat_completions')).toBe('chat_completions');
    expect(parseCodexApiMode('unexpected')).toBe('auto');
  });
});
