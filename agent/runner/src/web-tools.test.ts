import { beforeEach, describe, expect, it, vi } from 'vitest';

function createSseResponse(text: string, model = 'gpt-5.4') {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: text,
          })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`,
        ),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'openai-model': model,
    },
  });
}

describe('web-tools facade', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS;
    delete process.env.NANOCLAW_WEB_SEARCH_SEARXNG_BASE_URL;
    delete process.env.NANOCLAW_WEB_SEARCH_TAVILY_API_KEY;
    delete process.env.CODEX_BASE_URL;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_MODEL;
  });

  it('blocks private fetch targets before any network call', async () => {
    const { fetchUrl } = await import('./web-tools.js');

    await expect(fetchUrl({ url: 'http://127.0.0.1/internal' })).rejects.toThrow(
      'Blocked fetch target',
    );
  });

  it('blocks search results outside the allowed domains list', async () => {
    process.env.NANOCLAW_WEB_SEARCH_ALLOWED_DOMAINS = JSON.stringify([
      'example.com',
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<a class="result__a" href="https://blocked.test/article">Blocked</a>',
      headers: { get: () => 'text/html; charset=utf-8' },
      url: 'https://html.duckduckgo.com/html/',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { searchWeb } = await import('./web-tools.js');
    const text = await searchWeb({ query: 'demo' });

    expect(text).toContain('No results found');
  });

  it('falls back to Codex Responses web_search when local auto provider fails', async () => {
    process.env.CODEX_BASE_URL = 'https://gateway.example.com';
    process.env.CODEX_API_KEY = 'test-key';
    process.env.CODEX_MODEL = 'gpt-5.4';

    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://html.duckduckgo.com/html/')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      if (String(url) === 'https://gateway.example.com/v1/responses') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          tools?: Array<{ type?: string; filters?: { allowed_domains?: string[] } }>;
        };
        expect(body.tools?.[0]).toEqual({
          type: 'web_search',
          external_web_access: true,
          filters: { allowed_domains: ['eastmoney.com'] },
        });
        return Promise.resolve(
          createSseResponse(
            JSON.stringify({
              results: [
                {
                  title: 'Market Wrap',
                  url: 'https://eastmoney.com/a-share',
                  snippet: 'Shanghai and Shenzhen indexes closed higher.',
                },
              ],
            }),
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { searchWeb } = await import('./web-tools.js');
    const text = await searchWeb({
      query: '2026-03-18 中国 A股 市场 行情',
      domains: ['eastmoney.com'],
      maxResults: 5,
    });

    expect(text).toContain('Search provider: codex_web_search');
    expect(text).toContain('https://eastmoney.com/a-share');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports provider context instead of a bare fetch failed error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const { searchWeb } = await import('./web-tools.js');

    await expect(searchWeb({ query: 'demo' })).rejects.toThrow(
      'duckduckgo_html search failed: fetch failed',
    );
  });
});
