# IM Chat Feature Design

## Overview

NanoClaw IM chat module: unified conversation model where any conversation can be user-to-user, user-to-AI, or a mixed group with both users and AI assistants.

## Architecture: Extension Table Pattern

Keep existing `chats`/`messages`/`conversation_participants` tables unchanged. Add 6 new IM-specific tables as an extension layer linked via `chats.jid`.

## Data Model

### New Tables

1. **im_chat_meta** — IM conversation metadata (chat_type, visibility, owner, notice)
2. **im_memberships** — Group membership with roles (owner/admin/member) and status
3. **user_friends** — Bidirectional friendship (dual-row storage)
4. **friend_requests** — Friend request workflow (pending/accepted/rejected)
5. **im_join_requests** — Group join request workflow
6. **im_message_quotas** — Non-friend daily message quota tracking

### Key Decisions

- IM conversations use `chats.user_id = '__im__'` to indicate membership-based ownership
- DM JIDs: `im_dm_{min(a,b)}_{max(a,b)}` for deterministic uniqueness
- Messages reuse existing `messages` table
- Friends stored as dual rows: `(A,B)` + `(B,A)` for O(1) list queries

## API Design

All IM APIs under `/api/im/` prefix.

### Friend Management
- `GET /api/im/users/search?q=xxx` — search users
- `GET /api/im/friends` — friend list
- `POST /api/im/friends/request` — send friend request
- `GET /api/im/friends/requests` — pending requests
- `POST /api/im/friends/requests/:id/accept` — accept
- `POST /api/im/friends/requests/:id/reject` — reject
- `DELETE /api/im/friends/:friendId` — remove friend

### Conversation Management
- `GET /api/im/conversations` — IM conversation list
- `POST /api/im/conversations/dm` — create/get DM
- `POST /api/im/conversations/group` — create group
- `GET /api/im/conversations/:jid` — conversation detail
- `PATCH /api/im/conversations/:jid` — update group info
- `DELETE /api/im/conversations/:jid` — dissolve group

### Group Management
- `GET/POST /api/im/conversations/:jid/members` — list/add members
- `DELETE /api/im/conversations/:jid/members/:userId` — kick/leave
- `PATCH /api/im/conversations/:jid/members/:userId/role` — set role
- `GET /api/im/groups/search?q=xxx` — search public groups
- `POST/GET /api/im/groups/:jid/join-requests` — join requests

### Messages
- `GET /api/im/conversations/:jid/messages` — history (paginated)
- `POST /api/im/conversations/:jid/messages` — send message

## WebSocket Protocol

Reuse existing `/ws` + `RealtimeEnvelope`. New payload types:
- Client: `im_send`, `im_read`, `im_typing`
- Server: `im_message`, `im_friend_request`, `im_friend_accepted`, `im_join_request`, `im_member_change`, `im_chat_updated`, `im_chat_dissolved`, `im_typing`
- Personal notification channel: virtual JID `__im_user_{userId}`

### Cluster Readiness: BroadcastAdapter Interface
- `LocalBroadcastAdapter` for single-node (in-memory Map)
- `RedisBroadcastAdapter` for future cluster (Redis Pub/Sub)

## Frontend

Independent `/im` page with three-column layout:
- Left: conversation list / contacts / search
- Center: message stream + input
- Right: group info / members (collapsible)

## Phasing

- P0: Schema + friends + DM + groups + text messages + basic UI
- P1: Unread counts, read receipts, online status, typing indicator
- P2: @AI assistant integration in groups
- P3: Images/files, emoji reactions, message recall, quote reply
- P4: Redis broadcast adapter, message archival
