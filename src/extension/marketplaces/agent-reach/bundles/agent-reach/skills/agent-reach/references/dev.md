# GitHub

Use `gh` first for public GitHub lookups and authenticated actions.

## Commands

```bash
gh repo view OWNER/REPO
gh search repos "query" --sort stars --limit 10
gh issue list --repo OWNER/REPO
gh pr list --repo OWNER/REPO
```

## Rules

- Prefer `gh repo view` or `gh api` over scraping HTML.
- If the user needs private repos or write actions, confirm `gh auth status` first.
- Summaries should include repo purpose, star/fork scale, recent activity, and any issues or PRs the user explicitly asked about.
