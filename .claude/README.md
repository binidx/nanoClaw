# Claude Adapter

This file is the Claude-specific thin adapter. Shared policy lives in `docs/agent-harness.md`.

## Startup

For non-trivial work:

1. Read `AGENTS.md` if it was not already loaded.
2. Read `docs/agent-index-guide.md`.
3. Use `docs/repo-feature-map/index.md` to locate candidate files.
4. Read `docs/agent-harness.md` only when shared workflow policy is needed.
5. Read the relevant local skill only after the target area is known.
6. If the task is broad, multi-step, or release-oriented, follow the gstack flow in `docs/agent-harness.md` when gstack is available in the host.

For compact product orientation, use `CLAUDE.md` only when needed.

## Local Skills

- Backend `src/**`: `.claude/skills/nanoclaw-backend-ts/SKILL.md`
- Frontend `web/src/**`: `.claude/skills/nanoclaw-frontend-ts/SKILL.md`
- Conversation flow: `.claude/skills/nanoclaw-conversation-flow/SKILL.md`
- Verification: `.claude/skills/nanoclaw-verification/SKILL.md`

## Local Agents

- `.claude/agents/explorer.md`
- `.claude/agents/planner.md`
- `.claude/agents/backend-implementer.md`
- `.claude/agents/frontend-implementer.md`
- `.claude/agents/verifier.md`

Use subagents only when work can stay disjoint and the current tool/session supports them.

## Verification

- Backend-only: `npm run build`
- Frontend-only: `npm run build:web`
- Cross-surface: `npm run build:all`
- Merge-ready: `npm run check`

State exactly what you verified before reporting completion.
