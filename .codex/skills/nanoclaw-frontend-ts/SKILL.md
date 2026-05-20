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
- For nav-based business pages, prefer a single continuous canvas. Avoid nested white section boxes, hard header/body splits, or obvious layered panels unless the user explicitly asks for them.
- For card-library or list-management pages, keep the page itself focused on the list; open detail and edit flows in modal/drawer overlays, and do not render list and detail as side-by-side primary content in the same page shell.
- The default visual direction for business pages is pale-blue frosted glass. Do not introduce warm orange or peach accent washes unless the user explicitly requests that palette.
- Prefer small component changes over broad page rewrites.
- If a visible style regression has already survived three repair rounds, stop stacking CSS overrides and rewrite the offending component or shell onto the shared global component path instead.
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
