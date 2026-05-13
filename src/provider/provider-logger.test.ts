import { afterEach, describe, expect, it, vi } from 'vitest';

const { info, error } = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  createModuleLogger: vi.fn(() => ({ info, error })),
}));

describe('provider-logger', () => {
  afterEach(() => {
    info.mockReset();
    error.mockReset();
    vi.resetModules();
  });

  it('separates requestId from aiRequestId', async () => {
    const { runWithRequestContext } = await import('../request-context.js');
    const {
      logAiRequest,
      logAiResponse,
    } = await import('./provider-logger.js');

    runWithRequestContext(
      {
        requestId: 'http-request-1',
        source: 'http',
      },
      () => {
        const aiRequestId = logAiRequest(
          'openai_compatible',
          'gpt-5.4',
          'https://api.example.com/v1/chat/completions',
          'hello',
          false,
        );
        logAiResponse(
          aiRequestId,
          'openai_compatible',
          'gpt-5.4',
          'https://api.example.com/v1/chat/completions',
          200,
          25,
          { responseText: 'world' },
        );
      },
    );

    expect(info).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestId: 'http-request-1',
        aiRequestId: expect.any(String),
        kind: 'ai_request',
      }),
      'AI request sent',
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestId: 'http-request-1',
        aiRequestId: expect.any(String),
        kind: 'ai_response',
      }),
      'AI response received',
    );
  });
});
