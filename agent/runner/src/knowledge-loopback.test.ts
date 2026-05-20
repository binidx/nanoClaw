import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./codex-mcp-tools.js', () => ({
  listCodexMcpTools: vi.fn(async () => []),
  executeCodexMcpTool: vi.fn(async () => null),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('agent runner knowledge loopback', () => {
  it('semantic_search passes chat_jid and available assistant-bound KB ids', async () => {
    vi.stubEnv('MEMORY_ENABLED', 'false');
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_USER_ID', 'runtime-user');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'assistant-chat@g.us');
    vi.stubEnv(
      'NANOCLAW_AVAILABLE_KB_IDS',
      JSON.stringify(['kb-assistant-private']),
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        wiki: [
          {
            content: 'private-topic details',
            score: 0.91,
            title: 'private-topic',
            kbName: 'Assistant Private KB',
          },
        ],
        chunks: [],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { executeTool } = await import('./codex-tools.js');
    const output = await executeTool(
      'semantic_search',
      { query: 'private-topic', scope: 'knowledge', max_results: 5 },
      process.cwd(),
    );

    expect(output).toContain('Assistant Private KB');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body || '{}'),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: 'private-topic',
      user_id: 'runtime-user',
      chat_jid: 'assistant-chat@g.us',
      kb_ids: ['kb-assistant-private'],
    });
    expect(body.user_id).not.toBe('__system__');
  });

  it('fails closed instead of searching as __system__ when user id is missing', async () => {
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3377');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_USER_ID', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as typeof fetch);

    const { searchKnowledgeBaseViaApi } = await import(
      './internal-memory-api.js'
    );
    const result = await searchKnowledgeBaseViaApi('private-topic', 5);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
