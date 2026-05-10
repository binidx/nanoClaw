# Career And LinkedIn

Use public search and page reading first. If a dedicated LinkedIn MCP service is available, use it for richer profile and company detail.

## Commands

```bash
mcporter call 'linkedin.search_jobs(query: "machine learning", location: "remote")'
mcporter call 'linkedin.get_company(slug: "openai")'
```

## Rules

- Treat LinkedIn as an optional unlock. Do not assume the MCP service exists.
- When LinkedIn MCP is unavailable, combine web search, company sites, and public job boards.
- Focus summaries on role, location, team, seniority, and any compensation clues visible from public data.
