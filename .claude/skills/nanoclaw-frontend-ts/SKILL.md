---
name: nanoclaw-frontend-ts
description: Use when editing NanoClaw frontend code under web/src. Covers React + TypeScript + Vite pages, state flow, conversation UI, dark mode, chat UX, and CSS compatibility.
---

# NanoClaw Frontend TS

Use this skill for changes under `web/src/**`, especially:

- `App.tsx`
- `pages/*.tsx`
- `components/*.tsx`
- `app-helpers.ts`
- `app-types.ts`
- `App.css`

## Stack

- React + TypeScript
- Vite
- Single-page app with central state in `web/src/App.tsx`
- Styling is mostly in `web/src/App.css`

## Working rules

- Preserve existing interaction density. Do not expand layouts or redesign spacing unless the user explicitly asks for it.
- Prefer extending existing helpers such as `getConversationTitle`, `getDisplayContent`, and `formatTime` instead of duplicating logic.
- If a title, name, or label is shown in multiple places, centralize the selection logic instead of patching each view differently.
- When changing visual styles, keep light mode and dark mode in sync.
- Prefer small component changes over broad page rewrites.
- Avoid introducing new state containers unless the current architecture clearly cannot support the change.

## File map

- `web/src/App.tsx`
  Main orchestration, network calls, websocket events, global state.
- `web/src/pages/ChatPage.tsx`
  Chat header, transcript, input area, approval area.
- `web/src/components/ConversationSidebar.tsx`
  Left conversation list and per-conversation metadata.
- `web/src/pages/TasksPage.tsx`
  Task management and conversation selection UI.
- `web/src/App.css`
  Shared styling and dark theme overrides.
- `web/src/app-helpers.ts`
  Shared display and formatting helpers.

## Common patterns

- Title priority should usually be:
  `custom_title -> display_name -> name -> jid`
- If a bug is about duplicate UI rendering, inspect:
  pending messages, optimistic turns, websocket events, and loading indicators together.
- If a bug is about names not showing consistently, inspect:
  sidebar, header, dropdowns, cards, exported text, and helper functions together.

## Verification

- Frontend build:
  `cd web && npm run build`
