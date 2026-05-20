# Agent Harness

This document is the shared harness policy for NanoClaw repository work across Codex, Claude, Cursor, and repo-local agents. Tool adapter files should stay thin and point here instead of duplicating policy.

## Purpose

Use this harness to improve agent reliability without forcing every task to load every rule. Default-loaded files stay short; detailed rules live in skills or domain docs and are read only when relevant. The focus is:

- clear startup order
- bounded task execution
- progressive disclosure
- mechanical verification
- safe recovery after interruption

## Read Order

Before non-trivial work, read in this order:

1. `AGENTS.md`
2. tool entrypoint for the active tool
   - Codex: `.codex/README.md`
   - Claude: `.claude/README.md`
   - Cursor: `.cursor/rules/project-harness.mdc`
3. `docs/agent-index-guide.md`
4. `docs/repo-feature-map/index.md` for code location only
5. relevant product or architecture doc, if needed
6. relevant local skill
7. implementation files needed for the current task

Do not reread this harness just because an adapter mentions it. Read it when you need shared policy details or when the task is large, ambiguous, architectural, or merge-ready.

For quick repo context, `CLAUDE.md` remains a compact product map, not policy.

## Progressive Disclosure

- Start from `docs/agent-index-guide.md` and `docs/repo-feature-map/index.md` before broad repository search.
- Prefer targeted search with `rg` or equivalent over broad whole-file dumps; scope searches to the feature Map's suggested files/directories first.
- If a search returns too many results, narrow the scope before reading more.
- Open the minimum set of files needed to complete the current bounded task.
- Avoid pasting large irrelevant outputs into the agent context.

## Task Shape

- Default to one bounded task at a time.
- Explore first, edit second.
- For changes spanning backend and frontend, confirm the contract or data flow before touching both sides.
- Use subagents or separate workers for medium and large tasks when ownership is disjoint.
- On the Codex provider, main agents, subagents, and independent web chats do not serialize provider requests by default.
- The supported Codex provider concurrency surface is `NANOCLAW_CODEX_PROVIDER_CONCURRENCY=parallel|limit|global` plus `NANOCLAW_CODEX_PROVIDER_MAX_CONCURRENT=<n>` for `limit` mode.
- `parallel` is the default, `limit` is optional backpressure, and `global` is rollback-only emergency mode.
- Keep provider concurrency and parent timeout handling in sync; do not roll back only one side of that change.
- Codex subagent descendants must inherit the same `NANOCLAW_SUBAGENT_RUNTIME_ROOT` so registry/recovery can find all runtime records from the top-level group root. Recovery also scans legacy nested `.nanoclaw-subagents` directories.
- Do not create overlapping write ownership between workers.

## GStack Workflow

For broad refactors, architecture changes, or multi-step optimization work, prefer the gstack flow when gstack is available in the host.

- Typical sequence: `/office-hours` -> `/autoplan` -> implement -> `/review` -> `/qa` -> `/ship`
- Use gstack for planning, review, QA, and release sequencing on large changes.
- Keep NanoClaw's local `nanoclaw-*` skills for file-scoped implementation work.
- Do not force gstack onto trivial one-file fixes.

## Edit Boundaries

- Backend work under `src/**` should follow backend guidance.
- Frontend work under `web/src/**` should follow frontend guidance.
- Frontend visual baseline for nav-based business pages: one continuous pale-blue frosted-glass canvas, no nested white content boxes, no hard header/body segmentation, and no extra visual hierarchy unless the user explicitly requests it.
- Frontend page responsibility rule: card-library or list-management pages should keep the page itself list-focused; detail and edit belong in modal/drawer overlays, and list plus detail must not appear as side-by-side primary content in one page shell.
- If a frontend style issue has already been patched three times and the page still does not match the requested visual result, rewrite the offending shell or component instead of adding more overrides.
- Conversation creation, naming, replay, cursor, pending-message, or websocket flow changes should also use conversation-flow guidance.
- When code and docs diverge, update the relevant docs in the same change; if a stable feature entry moved, also update `docs/repo-feature-map/index.md` and `docs/repo-feature-map/log.md`.
- Architecture changes (new/modified tables, new modules, data flow changes, search/index mechanism changes, new background tasks) must include corresponding updates to `docs/` and `README.md` in the same commit. Do not split architecture code and documentation updates into separate commits.
- Prefer compact, local edits over broad rewrites unless the user explicitly requests a redesign or refactor.

## Bug Fix Loop

For non-trivial bug fixes:

- State the root cause before changing code, or say what evidence is still missing.
- Add or update a regression test when the failure mode is stable and testable.
- If the bug reveals a recurring agent failure pattern, update `docs/agent-lessons.md`, the relevant skill, feature map, or harness note in the same change.
- If the bug changes user-visible behavior, architecture, API contracts, or operational expectations, update the matching product/architecture doc.
- Final response should include root cause, fix, verification, and any follow-up learning that was recorded.

This is a lightweight learning loop, not a requirement to write a postmortem for every small typo.

## Skill Selection

- `nanoclaw-backend-ts` for `src/**`
- `nanoclaw-frontend-ts` for `web/src/**`
- `nanoclaw-conversation-flow` for cross-surface conversation behavior
- `nanoclaw-verification` after non-trivial changes

If multiple skills apply, use the minimal set that covers the task.

## Verification Matrix

- Backend-only changes: `npm run build`
- Frontend-only changes: `cd web && npm run build`
- Changes spanning frontend and backend: `npm run build:all`
- Logic-heavy fixes should add or run targeted Vitest coverage when practical.
- Feature-map-sensitive refactors should run `npm run check:feature-map:freshness`.
- Meaningful changes should follow the verification skill guidance before being reported as complete.

## Recovery Rules

- If context is lost, restart from the read order in this document.
- If the worktree is dirty and the changes are unrelated, do not revert them.
- If unknown changes directly conflict with the active task, stop and ask the user how to proceed.
- Avoid destructive commands such as `git reset --hard` or path checkout unless the user explicitly requests them.

## Tool Adapters

### Codex

- Use `.codex/README.md` as the Codex-specific entrypoint.
- Reuse `.codex/skills/*` and `.codex/agents/*` for project-local execution guidance.

### Claude

- Use `.claude/README.md` as the Claude-specific entrypoint.
- Reuse `.claude/skills/*` and `.claude/agents/*` for project-local execution guidance.

### Cursor

- Use `.cursor/rules/project-harness.mdc` as the Cursor rule adapter.
- Keep Cursor rules concise and execution-focused.

## Done Criteria

Do not report work as ready until:

- the relevant build or verification step has run successfully, or the blocking reason is stated clearly
- root cause is stated for non-trivial bug fixes
- related docs are updated when behavior or structure changed
- recurring lessons are recorded in `docs/agent-lessons.md` or the relevant skill when applicable
- the final response states what changed, what was verified, and any remaining gaps

## Design Intent

This harness is intentionally balanced rather than strict. It adds structure where agents fail most often:

- searching too broadly
- editing before orienting
- mixing unrelated tasks
- skipping verification
- losing state after interruption

It does not require persistent progress ledgers or machine-updated task files for every session.
