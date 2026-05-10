# Codex Adapter

This file is the Codex-specific thin adapter. Shared policy lives in `docs/agent-harness.md`.

## Startup

For non-trivial work:

1. Read `AGENTS.md` if it was not already loaded.
2. Read `docs/agent-index-guide.md`.
3. Use `docs/repo-feature-map/index.md` to locate candidate files.
4. Read `docs/agent-harness.md` only when shared workflow policy is needed.
5. Read the relevant local skill only after the target area is known.

## Local Skills

- Backend `src/**`: `.codex/skills/nanoclaw-backend-ts/SKILL.md`
- Frontend `web/src/**`: `.codex/skills/nanoclaw-frontend-ts/SKILL.md`
- Conversation flow: `.codex/skills/nanoclaw-conversation-flow/SKILL.md`
- Verification: `.codex/skills/nanoclaw-verification/SKILL.md`

## Local Agents

- `.codex/agents/explorer.md`
- `.codex/agents/planner.md`
- `.codex/agents/backend-implementer.md`
- `.codex/agents/frontend-implementer.md`
- `.codex/agents/verifier.md`

Use subagents only when work can stay disjoint and the current tool/session supports them.

## Verification

- Backend-only: `npm run build`
- Frontend-only: `npm run build:web`
- Cross-surface: `npm run build:all`
- Merge-ready: `npm run check`

State exactly what you verified before reporting completion.
