---
name: nanoclaw-conversation-flow
description: Use for bugs or features involving conversation naming, creation, routing, cursors, pending messages, websocket updates, duplicate consumption, and cross-channel chat flow in NanoClaw.
---

# NanoClaw Conversation Flow

Use this skill when the task spans frontend and backend conversation behavior.

Typical cases:

- new conversation name not taking effect
- sidebar, header, task page, and exports showing different names
- manual `chat_id` unexpectedly required for Web-created conversations
- duplicate assistant messages or duplicate pending bubbles
- restart causes old messages to be consumed again
- websocket events and persisted messages disagree

## Investigation checklist

Check these layers in order:

1. API payload created by frontend
2. Backend route contract in `src/web/web-server.ts` and `src/routes/conversation-*-routes.ts`
3. Runtime creation / routing logic in `src/index.ts` and `src/runtime/runtime-dispatch.ts`
4. Persistence semantics in `src/db.ts`
5. Frontend title/render helper usage in `web/src/app-helpers.ts`
6. Actual UI surfaces that read the data

## Naming rules

- `name` is source or transport-oriented metadata
- `custom_title` is user-defined and must win in UI
- `display_name` is derived presentation data, not the long-term source of truth

## Replay / cursor rules

- A reply being visible to the user does not guarantee the cursor was committed
- Successful completion paths must commit pending cursor state
- Recovery must read the effective cursor, not only the last committed cursor

## Verification

- Backend build: `npm run build`
- Frontend build: `cd web && npm run build`
- Prefer a targeted regression test for replay, creation, or cursor bugs
