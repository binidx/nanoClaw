# Cross-Tool Harness Design

> Scope: NanoClaw repository harness rules shared across Codex, Claude, and Cursor.

## Goal

Add a balanced default harness for this repository that improves agent reliability without forcing heavyweight per-session state files. The harness should support Codex, Claude, and Cursor through a shared project policy plus tool-specific adapters that are safe to commit to git.

## Decisions

### 1. Shared policy plus tool adapters

The repository will have one shared harness document that defines the project-wide operating model:

- read order
- progressive disclosure rules
- edit boundaries
- verification rules
- recovery rules
- done criteria

Each tool will also have its own entrypoint file:

- `.codex/README.md`
- `.claude/README.md`
- `.cursor/rules/project-harness.mdc`

These files will not be one-line redirects. They will restate the project workflow in the language that best fits the tool while remaining aligned with the shared harness document.

### 2. No dynamic progress or task ledgers

This harness will not add repo-level progress logs or mutable task ledgers. The repository should only gain static policy documents and tool adapters in this change.

This keeps the maintenance burden low while still adding the core behavior the article recommends:

- bounded task execution
- progressive disclosure
- mechanical verification
- recovery after interruption

### 3. Keep existing project-specific skills and agent roles

`.codex/skills/*` and `.codex/agents/*` already encode valuable project knowledge. This change will keep them and add parity on the Claude side so Claude is no longer missing local skills and local agent-role prompts.

Cursor will not receive a full duplicate skill system. It will get a concise project rule file that points to the authoritative repository guidance.

## File Layout

### Shared documents

- `docs/agent-harness.md`
- `docs/superpowers/specs/2026-03-24-cross-tool-harness-design.md`
- `docs/superpowers/plans/2026-03-24-cross-tool-harness.md`

### Tool-specific entrypoints

- `.codex/README.md`
- `.claude/README.md`
- `.cursor/rules/project-harness.mdc`

### Claude parity files

- `.claude/agents/frontend-implementer.md`
- `.claude/agents/backend-implementer.md`
- `.claude/agents/regression-reviewer.md`
- `.claude/skills/nanoclaw-backend-ts/SKILL.md`
- `.claude/skills/nanoclaw-frontend-ts/SKILL.md`
- `.claude/skills/nanoclaw-conversation-flow/SKILL.md`
- `.claude/skills/nanoclaw-verification/SKILL.md`

### Updated repository entrypoints

- `AGENTS.md`
- `CLAUDE.md`
- `.gitignore`

## Shared Harness Rules

### Read order

All supported agents should read in this order before non-trivial work:

1. `AGENTS.md`
2. tool entrypoint for the active tool
3. `docs/agent-harness.md`
4. relevant product or architecture docs
5. relevant skill files

### Progressive disclosure

- Start from entrypoints and indexes before opening implementation files.
- Prefer targeted search over whole-file dumps.
- Narrow search scope when results are noisy instead of pasting large outputs into context.
- Read only the modules necessary for the current bounded task.

### Task shape

- Default to one bounded task at a time.
- Explore first, then edit.
- For multi-surface work, confirm the contract or data flow before editing both sides.
- Use subagents for medium and large tasks when ownership can be kept disjoint.

### Edit boundaries

- Backend work under `src/**` uses backend guidance.
- Frontend work under `web/src/**` uses frontend guidance.
- Cross-surface conversation behavior uses conversation-flow guidance in addition to frontend or backend guidance.
- When docs and code diverge, update both in the same change.

### Verification

- Backend-only changes: `npm run build`
- Frontend-only changes: `cd web && npm run build`
- Cross-surface changes: `npm run build:all`
- Meaningful changes should also follow the project verification skill guidance.
- Do not claim completion without stating what was verified and what was not.

### Recovery

- If context is lost, restart from the read-order contract.
- Do not revert unrelated dirty worktree changes.
- If unknown changes conflict directly with the active task, stop and ask the user.
- Avoid destructive git commands unless the user explicitly asks for them.

### Done criteria

- Relevant build passes.
- Relevant docs are updated if behavior or structure changed.
- The final report states the outcome, verification performed, and any remaining gaps.

## Expected Outcome

After this change, the repo will have a clear harness that is:

- shared enough to avoid instruction drift
- tool-specific enough to be usable in Codex, Claude, and Cursor
- static and git-friendly
- aligned with the harness article's core principles without introducing unnecessary workflow overhead
