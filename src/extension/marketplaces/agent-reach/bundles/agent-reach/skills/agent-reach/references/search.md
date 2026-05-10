# Search

Use Exa through `mcporter` when the user wants broad web search, research, or article discovery.

## Preferred Commands

```bash
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'
mcporter call 'exa.answer(query: "query")'
```

## Rules

- Prefer search before scraping random pages directly.
- Keep the query specific and add domains only when the user clearly wants a constrained source set.
- If `mcporter` or `exa` is unavailable, fall back to general web reading plus manual browsing.

## Common Setup

```bash
npm install -g mcporter
mcporter config add exa https://mcp.exa.ai/mcp
agent-reach doctor
```
