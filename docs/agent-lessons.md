# Agent Lessons

This file records recurring agent failure patterns that are worth remembering across tasks. It is not a changelog and not a place for every small typo.

## When To Add A Lesson

Add a short entry when a bug fix or review reveals a pattern likely to repeat, such as:

- stale path or feature-map guidance caused wasted exploration
- an optimistic UI, websocket, cursor, or persistence assumption caused a regression
- a database dialect rule was missed
- verification passed but the wrong behavior was tested
- a prompt or agent workflow caused repeated incorrect changes

Do not add an entry when a targeted test or existing skill already captures the lesson well.

## Entry Format

```md
## YYYY-MM-DD - Short Title

- Symptom:
- Root cause:
- Fix:
- Guardrail:
- References:
```

Keep entries short. Link to tests, docs, or skills when possible.

## Current Lessons

## 2026-05-19 - Nav Pages Must Stay Single-Canvas

- Symptom: repeated UI passes left nav-based pages with visible section shells, white inset boxes, or mixed card styles even after a redesign request.
- Root cause: page-level wrappers were updated, but repository/detail sub-panels and page-specific cards kept their own legacy backgrounds and shadows.
- Fix: enforce the single-canvas rule in repo guidance and flatten nested business-page panels instead of only restyling the outer shell.
- Guardrail: when a user asks for integrated canvas UI, audit inner page panels and card grids, not just the page header or outer container.
- References: `AGENTS.md`, `docs/agent-harness.md`, `.codex/skills/nanoclaw-frontend-ts/SKILL.md`
