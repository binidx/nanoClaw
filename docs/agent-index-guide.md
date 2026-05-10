# Agent Index Guide

`docs/repo-feature-map/index.md` is a navigation index for agents. It helps locate likely entry files quickly, but current code remains the source of truth.

## How To Use The Index

1. Identify the feature row that best matches the task.
2. Open only the listed entry files that are relevant to the current question.
3. Verify listed paths exist before relying on them.
4. If a listed file is missing, search inside the nearest current module directory before falling back to broad `rg`.
5. If the index is stale and the task changes docs or stable feature boundaries, update:
   - `docs/repo-feature-map/index.md`
   - `docs/repo-feature-map/log.md`

## Freshness Checks

Before trusting a feature row, check:

- whether its listed files exist
- whether `source_head_sha` is close to current `HEAD`
- whether recent commits moved modules
- whether imports in current code point to a newer module path

If code and docs disagree, trust code and fix docs when the task scope includes documentation.

For refactors that move stable entrypoints, run:

```bash
npm run check:feature-map:freshness
```

This command compares the feature map metadata with the latest committed implementation paths. It reports uncommitted relevant changes as a warning and only checks committed history.

## Reading Budget

- Do not read every document referenced by a feature row.
- Do not open historical plans unless the task explicitly asks about the historical design.
- Do not start with whole-repo searches when the index gives a narrow module or route.
- Do not keep following references after you have enough context to make a bounded change.

## Stale Path Fallback

Common post-refactor locations:

- `src/web-server.ts` -> `src/web/web-server.ts`
- `src/runtime-*.ts` -> `src/runtime/runtime-*.ts`
- `src/agent-runner*.ts` -> `src/agent/agent-runner*.ts`
- `src/provider-*.ts` -> `src/provider/provider-*.ts`
- `src/repo-review-*.ts` -> `src/repo-review/repo-review-*.ts`
- `src/code-search*.ts` / `src/code-index*.ts` / `src/code-map*.ts` -> `src/code-intelligence/*`
- `src/slash-commands*.ts` -> `src/slash-commands/*`
- `src/web-search-config.ts` -> `src/config/web-search-config.ts`
