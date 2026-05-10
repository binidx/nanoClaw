# Web Reading

Use plain web reading for pages, blog posts, docs, RSS feeds, and WeChat articles.

## Preferred Commands

```bash
curl -s "https://r.jina.ai/http://example.com/article"
curl -s "https://r.jina.ai/http://mp.weixin.qq.com/..."
```

## RSS

- Read feed URLs directly with the environment's RSS tooling if present
- Otherwise treat the feed as a normal web resource and summarize the latest entries

## Rules

- Prefer cleaned article text over raw HTML.
- For WeChat articles, Exa plus Jina-style reading is usually the lowest-friction path.
- If the page is blocked or incomplete, fall back to search plus alternate mirrors rather than forcing browser automation immediately.
