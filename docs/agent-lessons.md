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

No recurring lessons have been recorded since this file was introduced.
