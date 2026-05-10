# Approval Overlay Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move permission approval UX into a non-blocking overlay so approvals no longer interfere with the chat main flow.

**Architecture:** Keep the existing approval data path and chat timeline logic intact. Add a dedicated overlay component outside the transcript list, wire it to the active conversation approvals, and reduce transcript-embedded approval UI so approval handling no longer depends on the main transcript render path.

**Tech Stack:** React, TypeScript, Vite, existing NanoClaw chat state helpers and approval API

---

### Task 1: Add A Dedicated Approval Overlay Component

**Files:**
- Create: `web/src/components/ApprovalOverlay.tsx`
- Test: `web/src/components/ApprovalOverlay.test.ts`

- [ ] **Step 1: Define the overlay props and any minimal shared types**

Keep types aligned with existing `ApprovalRequest` and `ApprovalScope` definitions. Do not introduce a new approval model.

- [ ] **Step 2: Write a failing focused test for overlay helper behavior**

Cover:
- approval ordering is stable
- countdown calculation is stable
- helper behavior does not depend on chat main-flow state

- [ ] **Step 3: Implement `ApprovalOverlay.tsx`**

Requirements:
- fixed overlay UI
- local countdown timer
- scope selector
- queue indicator when `approvals.length > 1`
- `X` resolves as deny
- resolving state disables buttons

- [ ] **Step 4: Add test coverage for resolve and countdown behavior**

Cover:
- allow forwards `approvalId`, `allow-once`, and selected scope
- deny forwards `approvalId`, `deny`
- countdown reaching zero does not call the resolve API automatically
- expired overlay state disables further actions until backend state catches up

- [ ] **Step 5: Run the component test**

Run: `cd web && npx vitest run src/components/ApprovalOverlay.test.ts`

Expected: PASS

### Task 2: Mount The Overlay Without Touching Chat Flow Logic

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/ChatPage.tsx`
- Modify: `web/src/App.css`
- Test: `web/src/hooks/useConversationRealtime.test.ts`

- [ ] **Step 1: Add a failing integration-oriented test or assertion target if needed**

If no existing test cleanly covers mount wiring, add a small focused test near the overlay component instead of expanding main chat tests unnecessarily.

- [ ] **Step 2: Mount `ApprovalOverlay` as a fixed non-transcript surface**

Wire:
- `activeApprovals`
- current access policy summary
- access dialog opener
- active approval resolve callback

Do not modify:
- `deriveConversationReplyState(...)`
- `buildChatTimelineEntries(...)`
- websocket/realtime handlers

- [ ] **Step 3: Add overlay styles in `App.css`**

Keep styles isolated:
- bottom-right stack
- compact card layout
- red `X`
- no layout shifts in the main transcript

- [ ] **Step 4: Verify no chat-flow logic changed incidentally**

Review the diff to confirm no changes landed in:
- streaming logic
- typing logic
- tool timeline logic

### Task 3: Reduce Transcript Approval Coupling

**Files:**
- Modify: `web/src/pages/ChatPage.tsx`
- Test: `web/src/components/ApprovalOverlay.test.tsx`

- [ ] **Step 1: Identify the minimum transcript changes required**

Goal:
- avoid duplicate primary approval surfaces
- preserve compatibility for approval-related follow-up copy and access guidance

- [ ] **Step 2: Remove or downgrade transcript-embedded approval panels**

Preferred approach:
- keep timeline entries structurally intact
- stop rendering the large primary approval card in the transcript path
- keep approval breadcrumb nodes in the transcript
- keep `entry.approval` attachment on tool-call entries
- do not remove approval data from chat state or from `buildChatTimelineEntries(...)`

- [ ] **Step 3: Verify transcript still renders tool entries and follow-up hints**

Ensure denied-approval follow-up behavior still works where intended.

### Task 4: Verify Main-Flow Safety

**Files:**
- Modify: `web/src/components/ApprovalOverlay.test.ts`
- Modify: `web/src/hooks/useConversationRealtime.test.ts` (only if a focused regression assertion is needed)

- [ ] **Step 1: Add a regression test for overlay independence**

Cover:
- approval presence does not require modifying timeline filtering
- no provider-status special handling is introduced
- approval presence leaves `deriveConversationReplyState(...)` semantics unchanged
- overlay mount does not change timeline entry ordering/count
- no extra `InlineAssistantLoading` appears when approval entries already exist
- resolve API is only called for explicit user actions

- [ ] **Step 2: Run targeted frontend tests**

Run:
- `cd web && npx vitest run src/components/ApprovalOverlay.test.ts`
- `cd web && npx vitest run src/hooks/useConversationRealtime.test.ts`

Expected: PASS

- [ ] **Step 3: Run frontend build**

Run: `cd web && npm run build`

Expected: PASS

- [ ] **Step 4: Review final diff**

Confirm the diff is limited to:
- new overlay component
- chat-surface wiring
- isolated styling
- minimal transcript approval rendering changes
