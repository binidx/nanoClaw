# NanoClaw Agent Start

NanoClaw uses React + TypeScript on the frontend and Node.js + TypeScript on the backend.

This file is intentionally short because Codex, Claude, Cursor, and repo-local agents may load it automatically. Put detailed rules in the shared harness, feature index, or local skills.

## Behavior Baseline

Follow a Karpathy-style operating model inspired by `forrestchang/andrej-karpathy-skills`:

- Think before coding: state assumptions, ambiguity, and success criteria before changing non-trivial code.
- Simplicity first: do not add speculative features, generic frameworks, or abstractions without a concrete need.
- Surgical changes: every changed line should trace back to the user request.
- Goal-driven execution: finish with the relevant verification command or a clear reason it could not run.

## Read Order

For non-trivial work:

1. Read this file.
2. Read the active tool adapter:
   - Codex: `.codex/README.md`
   - Claude: `.claude/README.md`
   - Cursor: `.cursor/rules/project-harness.mdc`
3. Read `docs/agent-index-guide.md`.
4. Use `docs/repo-feature-map/index.md` only to locate candidate entry files.
5. Read the relevant product/architecture doc only when the task needs it.
6. Read only the matching local skill and implementation files.

## Index Rule

`docs/repo-feature-map/index.md` is a navigation index, not the source of truth.

- Verify listed paths exist before relying on them.
- If the index is stale, trust current code over docs and search in the nearest module directory.
- If your change updates agent guidance or stable feature boundaries, update the feature map and `docs/repo-feature-map/log.md`.
- If a bug reveals a recurring agent failure pattern, record the lesson in `docs/agent-lessons.md` or the relevant skill.

## Skill Triggers

- Backend changes under `src/**`: use `nanoclaw-backend-ts`.
- Frontend changes under `web/src/**`: use `nanoclaw-frontend-ts`.
- Conversation creation, naming, replay, cursor, pending-message, websocket, or duplicate-consumption work: also use `nanoclaw-conversation-flow`.
- Non-trivial code changes: use `nanoclaw-verification` before reporting completion.

## Subagents

Use subagents only when the active tool supports them and the task benefits from disjoint work:

- Small focused fix: main agent only.
- Medium single-domain task: optional explorer before editing.
- Cross-surface or architecture task: planner/explorer recommended.
- Substantial implementation: verifier recommended after changes.

Do not assign overlapping write ownership to multiple workers.

## Verification Ladder

- Quick backend: `npm run build`
- Quick frontend: `npm run build:web`
- Cross-surface: `npm run build:all`
- Feature map freshness: `npm run check:feature-map:freshness`
- Targeted logic: run the relevant Vitest file.
- Merge-ready: `npm run check` and pre-push hooks pass.

## Done Criteria

Do not claim work is ready unless you state:

- what changed
- root cause for non-trivial bug fixes
- what command verified it
- what remains unverified, if anything

## Merge Mode

Only `git add`, `git commit`, and `git push` when the user asks for merge-ready delivery or the current task explicitly requires it. Do not commit or push analysis-only work.
