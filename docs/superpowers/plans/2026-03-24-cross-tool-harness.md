# Cross-Tool Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a git-tracked, cross-tool harness for Codex, Claude, and Cursor with shared project rules and tool-specific entrypoints.

**Architecture:** Create one shared repository harness document and keep tool-specific adapters thin but complete. Reuse the existing `.codex` skills and agents, mirror the missing Claude assets, add a concise Cursor rule file, and update top-level repo entrypoints so all three tools converge on the same workflow.

**Tech Stack:** Markdown, Cursor `.mdc` rules, existing NanoClaw repository docs and agent config.

---

### Task 1: Add shared harness documentation

**Files:**
- Create: `docs/agent-harness.md`
- Create: `docs/superpowers/specs/2026-03-24-cross-tool-harness-design.md`
- Create: `docs/superpowers/plans/2026-03-24-cross-tool-harness.md`

- [ ] **Step 1: Write the shared harness document**

Include:

- read order
- progressive disclosure rules
- bounded task execution
- edit boundaries
- verification matrix
- recovery rules
- done criteria

- [ ] **Step 2: Ensure the rules match existing repo constraints**

Check against:

- `AGENTS.md`
- `CLAUDE.md`
- existing `.codex/skills/*`

- [ ] **Step 3: Save the design and plan artifacts**

Use:

- `docs/superpowers/specs/2026-03-24-cross-tool-harness-design.md`
- `docs/superpowers/plans/2026-03-24-cross-tool-harness.md`

### Task 2: Add tool-specific entrypoints

**Files:**
- Create: `.codex/README.md`
- Create: `.claude/README.md`
- Create: `.cursor/rules/project-harness.mdc`

- [ ] **Step 1: Write the Codex entrypoint**

Cover:

- read order
- skill selection rules
- subagent usage expectations
- verification expectations

- [ ] **Step 2: Write the Claude entrypoint**

Cover:

- repo context source
- read order
- local skills and agents
- verification expectations

- [ ] **Step 3: Write the Cursor rule file**

Cover:

- compact execution constraints
- small diffs
- explore before edit
- verify before claiming completion

### Task 3: Add Claude parity files

**Files:**
- Create: `.claude/agents/frontend-implementer.md`
- Create: `.claude/agents/backend-implementer.md`
- Create: `.claude/agents/regression-reviewer.md`
- Create: `.claude/skills/nanoclaw-backend-ts/SKILL.md`
- Create: `.claude/skills/nanoclaw-frontend-ts/SKILL.md`
- Create: `.claude/skills/nanoclaw-conversation-flow/SKILL.md`
- Create: `.claude/skills/nanoclaw-verification/SKILL.md`

- [ ] **Step 1: Mirror the existing role prompts from `.codex/agents/*`**

Keep file ownership boundaries unchanged.

- [ ] **Step 2: Mirror the project skill files from `.codex/skills/*`**

Keep instructions semantically aligned so Codex and Claude do not drift.

- [ ] **Step 3: Keep wording tool-agnostic where possible**

Avoid unnecessary duplication of platform-specific details.

### Task 4: Update repository entrypoints and git tracking

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `.gitignore`

- [ ] **Step 1: Update `AGENTS.md`**

Add:

- shared harness references
- explicit read order
- cross-tool orientation

- [ ] **Step 2: Update `CLAUDE.md`**

Keep it short and make it point to:

- `.claude/README.md`
- `docs/agent-harness.md`

- [ ] **Step 3: Update `.gitignore`**

Allow the committed `.claude/` files to be tracked.

### Task 5: Verify documentation consistency

**Files:**
- Review: `docs/agent-harness.md`
- Review: `AGENTS.md`
- Review: `CLAUDE.md`
- Review: `.codex/README.md`
- Review: `.claude/README.md`
- Review: `.cursor/rules/project-harness.mdc`

- [ ] **Step 1: Review for duplicated or conflicting rules**

Ensure the shared document is the source of truth and tool entrypoints are adapters.

- [ ] **Step 2: Check git status**

Run:

```bash
git status --short
```

Expected:

- new `.claude/` files visible
- new `.cursor/` files visible
- shared harness docs visible

- [ ] **Step 3: Run non-code verification**

Run:

```bash
npm run build
cd web && npm run build
```

Expected:

- no regressions caused by the documentation/config change

