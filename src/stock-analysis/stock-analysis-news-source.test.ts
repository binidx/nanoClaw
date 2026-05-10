import { describe, expect, it, vi } from 'vitest';

import {
  fetchFallbackNewsSnippets,
  parseBingNewsRss,
  parseYahooFinanceNews,
} from './stock-analysis-news-source.js';

describe('stock-analysis-news-source', () => {
  it('parses Bing RSS items into normalized snippets', () => {
    const publishedAt = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    const rss = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title><![CDATA[白酒板块回暖 - 财联社]]></title>
          <link>https://example.com/news-1</link>
          <description><![CDATA[<p>资金回流，板块走强。</p>]]></description>
          <pubDate>${publishedAt}</pubDate>
        </item>
      </channel></rss>`;

    expect(parseBingNewsRss(rss)).toEqual([
      expect.objectContaining({
        title: '白酒板块回暖',
        source: '财联社',
        url: 'https://example.com/news-1',
        summary: '资金回流，板块走强。',
      }),
    ]);
  });

  it('parses Yahoo finance news payloads and keeps recent snippets only', async () => {
    const freshTime = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
    const staleTime = Math.floor((Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000);

    expect(
      parseYahooFinanceNews({
        news: [
          {
            title: '渠道反馈改善',
            publisher: 'Yahoo Finance',
            providerPublishTime: freshTime,
            summary: '公司层面反馈改善。',
            link: 'https://example.com/yahoo-news-1',
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        title: '渠道反馈改善',
        source: 'Yahoo Finance',
      }),
    ]);

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/finance/search')) {
        return new Response(
          JSON.stringify({
            news: [
              {
                title: '渠道反馈改善',
                publisher: 'Yahoo Finance',
                providerPublishTime: freshTime,
                summary: '公司层面反馈改善。',
                link: 'https://example.com/yahoo-news-1',
              },
              {
                title: '过旧消息',
                publisher: 'Yahoo Finance',
                providerPublishTime: staleTime,
                summary: '已经过期。',
                link: 'https://example.com/yahoo-news-2',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await fetchFallbackNewsSnippets({
      stockCode: 'AAPL',
      stockName: 'Apple',
      market: 'us',
      lookbackDays: 7,
      maxResults: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 2000,
    });

    expect(result.sourceLabel).toContain('Yahoo Finance News');
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]).toMatchObject({
      title: '渠道反馈改善',
      url: 'https://example.com/yahoo-news-1',
    });
    expect(result.rawSnippets).toHaveLength(2);
    expect(result.rawSnippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '渠道反馈改善' }),
        expect.objectContaining({ title: '过旧消息' }),
      ]),
    );
  });

  it('runs the first source queries in parallel and skips lower-priority sources once enough results are found', async () => {
    const freshTime = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
    const deferred: Array<{
      resolve: (value: Response) => void;
    }> = [];
    let yahooCalls = 0;
    let bingCalls = 0;
    const fetchImpl = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes('/v1/finance/search')) {
        yahooCalls += 1;
        if (yahooCalls <= 2) {
          return new Promise<Response>((resolve) => {
            deferred.push({ resolve });
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify({ news: [] }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('bing.com/news/search')) {
        bingCalls += 1;
        return Promise.resolve(
          new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
            headers: { 'Content-Type': 'application/xml' },
          }),
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const runPromise = fetchFallbackNewsSnippets({
      stockCode: 'AAPL',
      stockName: 'Apple',
      market: 'us',
      lookbackDays: 7,
      maxResults: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 2000,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(yahooCalls).toBe(2);
    expect(bingCalls).toBe(0);

    deferred[0]!.resolve(
      new Response(
        JSON.stringify({
          news: [
            {
              title: 'Apple earnings momentum',
              publisher: 'Yahoo Finance',
              providerPublishTime: freshTime,
              summary: 'Fresh earnings signal.',
              link: 'https://example.com/yahoo-parallel-1',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    deferred[1]!.resolve(
      new Response(
        JSON.stringify({
          news: [
            {
              title: 'Apple sector catalyst',
              publisher: 'Yahoo Finance',
              providerPublishTime: freshTime - 1800,
              summary: 'Fresh sector signal.',
              link: 'https://example.com/yahoo-parallel-2',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await runPromise;

    expect(result.sourceLabel).toBe('Yahoo Finance News');
    expect(result.snippets).toHaveLength(2);
    expect(result.snippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Apple earnings momentum' }),
        expect.objectContaining({ title: 'Apple sector catalyst' }),
      ]),
    );
    expect(bingCalls).toBe(0);
  });
});
