---
name: nanoclaw-backend-ts
description: Use when editing NanoClaw backend TypeScript under src. Covers Express routes, conversation flow, database persistence, runtime state, providers, scheduler, and agent execution.
---

# NanoClaw Backend TS

Use this skill for backend changes under `src/**`.

## Stack

- Node.js + TypeScript
- Express for Web API
- `better-sqlite3`, MySQL/TiDB, and PostgreSQL via `src/database/*`
- Channel adapters for Web, Feishu, Telegram, Discord, Slack, Gmail, and WhatsApp

## Current Module Map

- `src/index.ts` — process startup and runtime orchestration entry
- `src/runtime/*` — runtime state, dispatch, channel lifecycle, realtime events, persistence, startup hydration
- `src/web/web-server.ts` — Express/WebSocket composition
- `src/web/*` — web support services, uploads, terminal shell, doctor, IPC
- `src/routes/*` — HTTP route contracts and dependency injection
- `src/db.ts`, `src/db/*` — business persistence, schema DDL, SQL adapters, engine access
- `src/database/*` — database engine abstraction and dialect implementations
- `src/agent/agent-runner.ts`, `src/agent/*` — local agent process bridge, mounts, snapshots, workspace cleanup
- `src/subagent/*` — subagent runtime registry, filesystem, lifecycle control, recovery
- `src/provider/*` — provider registry, adapters, API calls, HTTP config, model serialization
- `src/assistant/*` — assistant runtime, config, MCP bindings, repo bindings
- `src/conversation/*` — conversation support, ownership, summaries, output merging, channel metadata
- `src/channels/*` — channel adapters and per-channel metadata
- `src/repo-review.ts`, `src/repo-review/*` — repo review service, executor, budget, digest, git, sync, repository service
- `src/code-intelligence/*` — code search, code index, code map, document search
- `src/config-store.ts`, `src/config/*` — runtime config and web-search config
- `src/slash-commands/*` — slash command parser and handlers
- `src/scheduler/*` — task scheduler, task draft/schedule, trash cleanup
- `src/stock-analysis/*`, `src/soul/*`, `src/extension/live2d-service.ts` — domain services
- `src/types.ts`, `src/types/*` — shared backend types
- tests generally live beside domains or at `src/*.test.ts`

## Working Rules

- Keep transport metadata and user-facing naming separate: channel-discovered names belong in `name`; user-defined labels belong in `custom_title`.
- For conversation creation or routing changes, check route contract, runtime dispatch, persistence, websocket events, and frontend expectations together.
- For restart/recovery bugs, inspect both in-memory state and persisted router state.
- If touching message consumption or replay, verify cursor advancement, pending state, restart behavior, and final reply acknowledgement together.
- Do not silently broaden route contracts. Keep backward compatibility where practical.
- When editing a barrel module, put business logic in the domain submodule and export only stable public API.

## Database Rules

- Schema changes must cover SQLite, MySQL/TiDB, and PostgreSQL:
  - `src/db/schema-sqlite.ts`
  - `src/db/schema-mysql.ts`
  - `src/db/schema-postgres.ts`
- No foreign keys in any dialect; application code owns referential integrity.
- MySQL/TiDB index byte budget is `SUM(varchar_len * 4) <= 3072`.
- Use the smallest reasonable VARCHAR tier:
  - `VARCHAR(64)` for UUID/nanoid and `*_id`
  - `VARCHAR(128)` for medium names, JIDs, scopes, folders, branches, keys
  - `VARCHAR(255)` for long bounded strings such as tokens, idempotency keys, path refs, cache keys, email
  - `TEXT`/`MEDIUMTEXT` for unbounded content and JSON arrays
- Do not add MySQL/TiDB defaults to TEXT/MEDIUMTEXT columns.
- Use `DEFAULT '[]'`, not `DEFAULT ('[]')`, for TiDB-compatible literal defaults.
- Do not use SQL `||` for string concatenation; MySQL treats it as logical OR.
- Business SQL should use `LIMIT ? OFFSET ?`; MySQL inlining is handled by the engine layer.
- New composite-PK tables using `INSERT OR REPLACE` must be registered in `PG_TABLE_PK_COLUMNS`.
- Custom `INSERT OR IGNORE` conflict columns must be registered in `PG_TABLE_IGNORE_CONFLICT_COLUMNS`.

## Verification

- Backend build: `npm run build`
- Targeted test: `npx vitest run src/<name>.test.ts`
- Merge-ready confidence: `npm run check`
