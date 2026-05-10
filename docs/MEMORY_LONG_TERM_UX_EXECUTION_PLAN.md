# Memory Long-Term UX Execution Plan

## Goal

Make NanoClaw remember durable user facts in a way that feels natural to end users.

Users should not need to understand:

- `group` vs `global`
- short-term vs long-term memory
- `memory_save`
- memory file paths

They should be able to say things like:

- "我叫 ady，以后都这么称呼我"
- "这个项目里默认中文回复"
- "这次会话里先别用表格"

And the system should decide whether that belongs to:

- session memory
- group durable memory
- global durable memory
- identity memory
- temporary task memory

## Current State

### What exists now

- Session/context persistence already exists in SQLite.
  - [src/db.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/db.ts)
- Durable memory file storage and search already exist.
  - [agent/runner/src/memory-tools.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/agent/runner/src/memory-tools.ts)
  - [src/memory/document-indexing.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory/document-indexing.ts)
  - [src/routes/internal-memory-routes.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/routes/internal-memory-routes.ts)
- Identity tables and conversation bindings already exist, but are not yet the default path for "who am I" facts.
  - [src/memory/identity-service.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory/identity-service.ts)
  - [src/routes/memory-identity-routes.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/routes/memory-identity-routes.ts)
- Search quality observability already exists, including:
  - indexed hits
  - follow-up reads
  - by-scope quality
  - top groups
  - [src/db.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/db.ts)
  - [web/src/pages/SettingsPage.tsx](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/pages/SettingsPage.tsx)

### What is still wrong

- End users still need to think in implementation terms such as `group` and `global`.
- "我是谁" facts are not automatically upgraded into a high-priority identity memory.
- Long-term memory creation still leans on explicit `memory_save`.
- Global memory write is configurable in backend metadata, but not visible in the current frontend settings form.

### Why the frontend currently does not show global memory write

`MEMORY_GLOBAL_WRITE_ENABLED` is defined in config metadata:

- [src/config-store.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/config-store.ts)

But it is not included in the current frontend config ordering:

- [web/src/pages/SettingsPage.tsx](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/pages/SettingsPage.tsx)

Specifically:

- `CORE_CONFIG_ORDER` does not contain memory keys
- there is no dedicated memory settings section yet

So the capability exists, but the admin UI does not expose it.

## Design Principles

1. Users talk naturally. The system decides memory type.
2. Identity facts must have higher priority than daily notes.
3. Durable memory should be created automatically when confidence is high.
4. Scope selection should be internal by default, not user-facing.
5. Explicit "记住这件事" remains as a fallback, not the primary workflow.
6. Retrieval priority must prefer identity and durable memory over raw session residue.

## Reference Direction

The useful lesson here is not "store memory in markdown files".

The useful lesson is:

- dynamic memory is recorded automatically
- durable memory is extracted automatically
- context and memory are separated
- the user does not manage storage structure manually

For NanoClaw, that means:

- keep session persistence
- keep searchable durable memory
- add automatic promotion rules
- add a dedicated identity layer
- hide scope details from normal interaction

## Target Memory Model

### 1. Session Memory

Purpose:

- current conversation continuity
- compaction input
- tool/result traceability

Storage:

- existing `context_entries`

User visibility:

- none

### 2. Working Summary

Purpose:

- compress long sessions
- preserve current task state

Storage:

- existing compaction summary records

User visibility:

- none

### 3. Group Durable Memory

Purpose:

- project-specific or conversation-space-specific facts

Examples:

- "这个项目里默认中文回复"
- "这个仓库里先跑 test:memory 再合并"

Storage:

- existing memory document pipeline

User visibility:

- optional in advanced memory viewer only

### 4. Global Durable Memory

Purpose:

- cross-conversation durable facts

Examples:

- "用户名字是 ady"
- "默认用 ady 称呼用户"
- "用户偏好简洁回复"

Storage:

- existing global memory path plus indexed durable search

### 5. Identity Memory

Purpose:

- highest-priority person facts

Examples:

- name
- preferred address
- language preference
- stable role or identity

Storage:

- extend current person profile usage
- do not rely only on daily memory files for this class of fact

## Product UX Changes

### User-facing language model

Normal users should only need two concepts:

- "记住这个"
- "这次先这样"

System-internal mapping:

- "记住这个" -> classify into identity / group durable / global durable
- "这次先这样" -> session-only

### Transitional admin controls

Before full automation is complete, expose memory controls in settings:

- `MEMORY_ENABLED`
- `MEMORY_READ_ENABLED`
- `MEMORY_WRITE_MODE`
- `MEMORY_GLOBAL_WRITE_ENABLED`
- `MEMORY_AUTO_SAVE_ENABLED`
- `MEMORY_SEARCH_SCOPE_DEFAULT`
- `MEMORY_PROMPT_INJECTION_ENABLED`

This is an admin transition step, not the final user UX.

## Memory Decision Engine

Add an internal classification step for candidate durable facts.

### Output shape

- `none`
- `session`
- `group_durable`
- `global_durable`
- `identity`
- `ttl_task`

### First version

Start with heuristics plus optional LLM fallback.

High-confidence `identity/global` patterns:

- "我叫..."
- "你可以叫我..."
- "以后都这么称呼我"
- "以后默认..."
- "我喜欢简洁回复"
- "默认用中文/英文"

High-confidence `group_durable` patterns:

- "这个项目里..."
- "在这个仓库里..."
- "这个群里..."
- "这个客户沟通里..."

High-confidence `session` patterns:

- "这次先..."
- "当前这轮..."
- "本次会话先..."

## Retrieval Priority

Current retrieval should evolve toward this order:

1. identity memory
2. global durable memory
3. group durable memory
4. recent recall
5. working summary
6. raw recent session entries

This prevents "daily fragment noise" from outranking high-priority user identity facts.

## Execution Phases

### Phase 0: Admin Visibility Fix

Objective:

- expose memory configuration in the frontend settings page

Changes:

- add memory keys into settings rendering order or create a dedicated memory settings section

Files:

- [web/src/pages/SettingsPage.tsx](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/pages/SettingsPage.tsx)
- [web/src/app-types.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/app-types.ts)

Acceptance:

- admins can see and change `MEMORY_GLOBAL_WRITE_ENABLED`
- admins can see memory-related toggles without editing raw DB/config

### Phase 1: Identity Fact Capture

Objective:

- stop treating "user name / how to address user" as ordinary daily notes

Changes:

- define identity fact upsert flow
- when high-confidence identity input is detected, write into identity profile first
- optionally mirror into global durable memory for recall compatibility

Files:

- [src/memory/identity-service.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory/identity-service.ts)
- [src/db.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/db.ts)
- [src/routes/memory-identity-routes.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/routes/memory-identity-routes.ts)

Acceptance:

- if user says "我叫 ady，以后都这么称呼我", new conversations can retrieve `ady` without relying only on group daily memory

### Phase 2: Automatic Durable Promotion

Objective:

- reduce explicit dependence on `memory_save`

Changes:

- add candidate detector on inbound user messages and compaction boundaries
- if confidence is high, auto-save to group/global durable memory
- keep explicit `memory_save` as advanced fallback only

Files:

- [src/memory/promotion.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory/promotion.ts)
- [src/index.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/index.ts)
- [agent/runner/src/memory-tools.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/agent/runner/src/memory-tools.ts)

Acceptance:

- durable facts are captured without requiring user knowledge of `group/global`

### Phase 3: Source-aware Ranking

Objective:

- prevent durable identity/global facts from being drowned out by daily fragments

Changes:

- add `sourceType` and `memoryClass` to search events and recall metadata
- rank by identity/global durable/group durable/daily summary priority

Files:

- [src/db.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/db.ts)
- [src/routes/internal-memory-routes.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/routes/internal-memory-routes.ts)
- [src/memory/search-index.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory/search-index.ts)

Acceptance:

- "你记得我叫什么吗" hits identity/global memory before daily memory

### Phase 4: Memory UX Layer

Objective:

- expose natural memory interactions while hiding implementation detail

Changes:

- add explicit user intents:
  - "记住这个"
  - "只在这次会话记住"
- add optional UI affordance near assistant replies or user messages:
  - "记住"
  - "仅本次"

Files:

- [web/src/pages/ChatPage.tsx](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/pages/ChatPage.tsx)
- [web/src/App.tsx](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/web/src/App.tsx)
- backend route layer as needed

Acceptance:

- normal users no longer need to think about `group/global`

### Phase 5: Evaluation and Safeguards

Objective:

- make memory quality measurable

Changes:

- keep current observability
- add source-aware metrics
- add offline eval set:
  - identity recall
  - preference recall
  - project-rule recall
  - false positive durable writes

Files:

- [src/memory-observability.test.ts](/C:/Users/ady/ensoai/workspaces/nanoclaw/memory/src/memory-observability.test.ts)
- dedicated eval fixtures/tests

Acceptance:

- we can quantify:
  - hit rate
  - follow-up read rate
  - by-scope quality
  - by-group quality
  - by-source quality

## Recommended Implementation Order

Do this in order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 5
6. Phase 4

Reason:

- first remove obvious admin visibility gaps
- then fix identity correctness
- then automate durable writes
- then improve retrieval ranking
- finally polish end-user UX on top of a stable backend model

## Non-Goals For Now

- fully automatic person resolution across all channels without admin or heuristic support
- a heavy external vector DB
- exposing raw memory file paths to end users
- making daily memory the primary identity source

## Success Criteria

The redesign is successful when:

- users no longer need to choose `group` vs `global`
- "我叫 ady" becomes durable and survives new conversations
- project-local instructions stay local
- short-lived instructions do not pollute durable memory
- memory quality is measurable by scope, group, and later by source

