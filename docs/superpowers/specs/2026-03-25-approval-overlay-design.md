# Approval Overlay Design

**Date:** 2026-03-25

## Goal

Optimize permission approval UX without changing NanoClaw's chat main-flow rendering, streaming pipeline, timeline ordering, or realtime event semantics.

## Problem

Recent permission-flow work exposed a chat-flow regression risk:

- approval/waiting UI and chat timeline behavior became coupled
- provider waiting states became visible in the main transcript path
- duplicate or misplaced loading indicators became possible
- users perceived the chat as blocked even when the underlying issue was approval UX

The system still needs explicit mutation approval, but the approval UI must not participate in main chat rendering decisions.

## Constraints

- Do not change the websocket or realtime event contract for messages, turns, streaming, or tool calls.
- Do not change `deriveConversationReplyState(...)` semantics.
- Do not change `buildChatTimelineEntries(...)` ordering rules.
- Do not add provider-status filtering or any new chat-timeline suppression logic.
- Keep approval resolution behavior compatible with the current backend approval API.
- Keep the existing approval data model (`ApprovalRequest`, approval scope, resolution API).

## Chosen Approach

Add a non-blocking approval overlay that renders independently from the chat transcript. The overlay consumes the current conversation's active approvals and offers the same allow/deny actions plus scope selection, but does not alter realtime data flow, timeline ordering, or loading-state derivation.

## UX Shape

- Approval UI appears as a fixed overlay in the bottom-right area.
- The overlay is independent from the transcript and tool chain.
- If multiple approvals exist, show the earliest pending approval and a queue indicator.
- Actions:
  - Allow
  - Deny
  - Close via a red `X`
- The red `X` is treated as `deny`, not hide-only.
- Scope selector remains:
  - `current_runtime`
  - `current_tool_call`
- A countdown remains visible while approval is pending.
- Countdown expiry must not call the resolve API. Once the timer reaches zero, the overlay only shows an expired disabled state and waits for backend `approval_resolved` or approval-state refresh.
- After approval is resolved and removed from conversation state, the pending overlay disappears.
- The transcript keeps a compact approval breadcrumb so approval-only states do not collapse into generic loading.

## Architecture

### Existing Flow To Preserve

1. Backend emits `approval_request` and `approval_resolved`.
2. Frontend stores approvals in `ConversationChatState.approvals`.
3. `App.tsx` derives `activeApprovals` from the active conversation.
4. Chat timeline continues to render from messages + turns + approvals using the existing helpers.

### New UI Boundary

1. The chat surface mounts a fixed-position `ApprovalOverlay` component outside the transcript list.
2. `ApprovalOverlay` receives:
   - active approvals
   - current access policy summary
   - open access dialog callback
   - resolve approval callback
3. `ApprovalOverlay` manages only presentation details:
   - which approval is currently shown
   - countdown
   - local resolving state
4. Overlay visibility remains a pure function of `activeJid + ConversationChatState.approvals`.
5. Local state may only track selected scope, countdown display, and in-flight resolve disablement.
6. Local state must reset on approval id or conversation change.
7. `ChatPage.tsx` stops being the primary approval interaction surface, but keeps compact transcript approval breadcrumbs.

## File Responsibilities

- `web/src/App.tsx`
  Owns active approval selection and passes approvals into the chat surface.
- `web/src/components/ApprovalOverlay.tsx`
  Owns overlay-only approval presentation and actions.
- `web/src/pages/ChatPage.tsx`
  Keeps timeline rendering intact, mounts the fixed overlay, and renders compact approval breadcrumbs in the transcript.
- `web/src/App.css`
  Owns overlay styling only.

## Safety Rules

- No edits to `useConversationRealtime.ts` for this change.
- No edits to `conversation-realtime.ts` for this change.
- No edits to backend approval payload shape unless verification proves absolutely necessary.
- No edits to stream chunk handling.
- No edits to typing/loading logic used by the chat main flow.
- Do not remove approvals from `buildChatTimelineEntries(...)`.
- Do not remove `entry.approval` attachment from tool-call timeline entries.
- Do not return `null` for approval timeline nodes.

## Testing Strategy

- Component-level verification for overlay rendering and interaction.
- Frontend build must pass.
- Existing realtime/timeline tests must continue to pass if touched.
- Manual smoke target:
  - approval appears in overlay
  - transcript keeps rendering normally
  - tool chain remains visible
  - resolving approval removes overlay without blocking chat

## Out Of Scope

- Reworking provider status emission
- Rewriting approval backend storage
- Multi-window approval synchronization improvements
- New global feedback system for all permission events
