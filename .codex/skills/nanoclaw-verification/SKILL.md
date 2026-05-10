---
name: nanoclaw-verification
description: Use after non-trivial NanoClaw changes. Runs the project-specific verification sequence for backend, frontend, and targeted Vitest regressions.
---

# NanoClaw Verification

Run this after meaningful code changes unless the user explicitly asks not to verify.

## Order

1. Backend build
2. Targeted backend tests for touched logic
3. Frontend build if `web/**` changed
4. Summarize any remaining gaps

## Commands

- Backend build:
  `npm run build`
- Full backend tests:
  `npx vitest run`
- Single backend test:
  `npx vitest run src/<name>.test.ts`
- Frontend build:
  `cd web && npm run build`

## Expectations

- If the task touched message routing, naming, creation, cursor, or recovery logic, prefer a targeted regression test.
- If a command cannot run because of sandbox or environment restrictions, state exactly what was blocked.
- Do not claim a fix is complete without at least the relevant build passing.

