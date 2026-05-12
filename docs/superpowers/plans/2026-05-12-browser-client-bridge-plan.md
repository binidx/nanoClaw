# Browser Client-Bridge Migration TODO Plan

> **For agentic workers:** Use this document as the execution checklist. Keep steps small, preserve backward compatibility where practical, and do not collapse the client-bridge path back into server-local browser control.

**Goal:** Replace the current server-local browser-control model with a multi-user-safe browser workbench that primarily controls each user's own browser through a client bridge, while keeping the existing server CDP path as a compatibility/debug fallback.

**Architecture:** The browser UI shown inside NanoClaw is only a product surface. Real automation should come from a user-owned bridge layer, not from assuming the host page can directly automate arbitrary cross-origin sites. The primary runtime becomes `client_bridge`; the existing `/api/browser/*` CDP flow remains as `server_cdp` for single-machine and admin/debug scenarios.

**Tech Stack:** Existing NanoClaw backend and frontend, browser extension first, optional local companion if extension-only access is not sufficient for CDP/screenshot/complex interaction requirements.

---

## Summary

- The current browser-control feature is tied to server-local or localhost CDP assumptions and does not scale cleanly to multi-user deployment.
- A plain embedded `iframe` is not a sufficient automation substrate for arbitrary sites because the host page cannot generally read or control cross-origin DOM.
- The new primary model is:
  - NanoClaw frontend provides the browser workbench UI.
  - A browser extension owns local browser execution, page instrumentation, and recording.
  - Backend owns auth, permission checks, session metadata, command routing, history, and audit.
  - Each user gets an isolated browser session.
- Existing `server_cdp` stays available as a non-default fallback for compatibility and troubleshooting.

## Non-Goals

- Do not attempt a pure zero-install browser-only automation solution for arbitrary third-party sites.
- Do not expose one user's local browser session to another user.
- Do not remove the existing browser routes before the bridge path is stable.
- Do not redesign unrelated agent/web-search features in this migration.

## Public Interfaces and Contracts

- Introduce a provider split for browser execution:
  - `server_cdp`
  - `client_bridge`
- Introduce session concepts that are explicitly user-scoped:
  - `BrowserBridgeSession`
  - `BrowserBridgeClientInfo`
  - `BrowserCommandEnvelope`
  - `BrowserCommandResult`
  - `BrowserRecordingEvent`
- Keep command semantics aligned with current browser actions where possible:
  - `navigate`
  - `click`
  - `type`
  - `press`
  - `wait`
  - `waitFor`
  - `hover`
  - `scrollIntoView`
  - `select`
  - `scroll`
  - `screenshot`
  - `snapshot`
  - `role_snapshot`
- Add bridge-oriented APIs/events rather than overloading the current single-runtime API shape.

## Planned File Structure

### Backend

- Modify: `src/routes/browser-routes.ts`
  - Keep existing routes working, then add bridge session and command endpoints.
- Create: `src/browser/bridge-types.ts`
  - Shared types for bridge sessions, commands, and events.
- Create: `src/browser/bridge-service.ts`
  - Session registry, command dispatch, result correlation, heartbeat handling.
- Create: `src/browser/bridge-auth.ts`
  - Browser bridge token issuance and validation.
- Modify: `src/browser/service.ts`
  - Add provider-aware abstraction instead of assuming a single CDP runtime.
- Modify: `src/auth/local-capability-policy.ts`
  - Preserve `browser.control` permission semantics but separate local-host execution from bridge usage.
- Create or modify tests near the browser/auth modules.

### Frontend

- Create: `web/src/pages/BrowserWorkbenchPage.tsx`
  - Product browser workbench page.
- Create: `web/src/components/browser-workbench/*`
  - Workbench UI sections: session header, action list, recent actions, embedded viewport, recorder state.
- Modify: `web/src/App.tsx`
  - Route and navigation wiring for the new page.
- Modify: `web/src/components/BrowserControlPanel.tsx`
  - Reduce it to debug/admin compatibility use if retained.
- Modify: `web/src/app-types.ts`
  - Add bridge session and command/result types.
- Modify styles under `web/src/styles/*` or `web/src/App.css`
  - Add workbench-specific layout and responsive behavior.

### Browser Extension / Companion

- Create: `browser-extension/`
  - Extension manifest, background service worker, content scripts, command executor, bridge transport.
- Optional later: `browser-companion/`
  - Local helper only if extension-only access cannot satisfy CDP/screenshot/advanced tab management requirements.

### Docs

- Modify: `docs/浏览器自动化与Web能力.md`
  - Document the split between `client_bridge` and `server_cdp`.
- Modify: `README.md`
  - Add the new browser workbench capability and client dependency notes.
- Modify if stable feature boundaries change:
  - `docs/repo-feature-map/index.md`
  - `docs/repo-feature-map/log.md`

## Execution Plan

### Task 1: Freeze the target architecture and data contracts

**Files:**
- Create: `src/browser/bridge-types.ts`
- Modify: `src/browser/types.ts`
- Modify: `web/src/app-types.ts`

- [ ] Define the provider model and name it consistently in backend and frontend types.
- [ ] Define a user-scoped bridge session record with:
  - session id
  - user id
  - client instance id
  - provider
  - connection status
  - last heartbeat timestamp
  - active tab metadata
- [ ] Define command envelopes with:
  - command id
  - session id
  - target tab id
  - action payload
  - created at
  - timeout metadata
- [ ] Define result payloads with:
  - command id
  - terminal status
  - action-specific metadata
  - error code/message/suggestion
- [ ] Define recording events for user-driven capture and replay generation.
- [ ] Keep existing action naming compatible with current browser automation vocabulary unless there is a strong reason to rename.

### Task 2: Introduce backend bridge session infrastructure

**Files:**
- Create: `src/browser/bridge-service.ts`
- Create: `src/browser/bridge-auth.ts`
- Modify: `src/routes/browser-routes.ts`
- Modify: `src/browser/service.ts`

- [ ] Add a bridge session registry keyed by user and session id.
- [ ] Add connect/disconnect/heartbeat flows for bridge clients.
- [ ] Add command submission and result-correlation flows.
- [ ] Add expiration and stale-session cleanup behavior.
- [ ] Keep route-level permission enforcement on `browser.control`.
- [ ] Ensure the backend can distinguish:
  - no bridge connected
  - bridge connected but tab missing
  - command timed out
  - bridge rejected action
- [ ] Preserve or adapt the existing browser route responses so fallback mode remains usable.

### Task 3: Build a browser bridge auth and transport model

**Files:**
- Create: `src/browser/bridge-auth.ts`
- Create: extension-side transport files under `browser-extension/`

- [ ] Decide and implement a bridge authentication model that binds the local bridge to the signed-in NanoClaw user.
- [ ] Mint short-lived bridge tokens or equivalent connection credentials.
- [ ] Require every bridge command/result channel to be tied to one authenticated user session.
- [ ] Prevent a bridge instance from subscribing to another user's command stream.
- [ ] Define reconnect behavior for browser restart, tab close, and transient network loss.

### Task 4: Create the browser extension MVP

**Files:**
- Create: `browser-extension/manifest.json`
- Create: `browser-extension/src/background/*`
- Create: `browser-extension/src/content/*`
- Create: `browser-extension/src/shared/*`

- [ ] Implement extension bootstrap and authenticated pairing with NanoClaw.
- [ ] Implement managed-tab creation and binding.
- [ ] Implement action execution for:
  - navigate
  - click
  - type
  - press
  - wait / waitFor
  - hover
  - scroll / scrollIntoView
  - select
- [ ] Implement page snapshot and role snapshot collection.
- [ ] Implement screenshot capture if extension APIs can do so reliably.
- [ ] Implement manual-action recording for click/input/navigation events.
- [ ] Emit structured command results and recording events back to NanoClaw.
- [ ] Record clearly which actions require content-script injection versus background-tab APIs.

### Task 5: Evaluate the need for an optional local companion

**Files:**
- Create only if required: `browser-companion/`
- Modify docs and backend provider selection if adopted

- [ ] Test whether the extension-only MVP can support screenshots, cross-frame interaction, and stable page instrumentation.
- [ ] If extension-only support is insufficient, add a local companion process with a narrow role:
  - CDP connection
  - richer screenshot capture
  - advanced tab/window/session introspection
- [ ] Keep the companion optional and do not make it the first dependency unless required by verified gaps.

### Task 6: Build the frontend browser workbench

**Files:**
- Create: `web/src/pages/BrowserWorkbenchPage.tsx`
- Create: `web/src/components/browser-workbench/*`
- Modify: `web/src/App.tsx`
- Modify styles

- [ ] Add a first-class browser workbench page instead of burying the feature in settings.
- [ ] Implement a layout with:
  - session and connection status
  - tab/address controls
  - embedded viewport or preview panel
  - action palette
  - recent actions / recording timeline
- [ ] Show bridge-install and bridge-disconnected empty states.
- [ ] Distinguish between:
  - live interactive view
  - screenshot/preview fallback
  - debug/admin fallback mode
- [ ] Keep mobile behavior functional even if the full workbench is desktop-first.

### Task 7: Reposition the existing BrowserControlPanel

**Files:**
- Modify: `web/src/components/BrowserControlPanel.tsx`
- Modify: `web/src/pages/settings/SettingsBrowserTab.tsx`

- [ ] Decide whether the existing panel remains as:
  - admin/debug surface for `server_cdp`
  - compatibility tool for single-machine deployments
- [ ] Remove product ambiguity by clearly labeling it as debug/compatibility if retained.
- [ ] Route normal users to the new browser workbench instead of the settings-only control flow.

### Task 8: Integrate Agent and Workflow usage

**Files:**
- Modify candidate files in:
  - `src/prompt/*`
  - `src/agent/*`
  - `src/workflow/*`

- [ ] Prefer the current user's active `client_bridge` session when an agent/browser tool needs interactive automation.
- [ ] Keep `server_cdp` as fallback only when policy allows it and no bridge session is available.
- [ ] Make failure reasons explicit to the user or operator:
  - no eligible browser session
  - permission denied
  - bridge offline
  - fallback disabled
- [ ] Do not silently downgrade interactive automation to a fake success path.

### Task 9: Add persistence, audit, and history

**Files:**
- Modify or create DB-layer modules only if needed
- Modify browser-related routes/services/tests

- [ ] Persist browser session metadata if session recovery or history views require it.
- [ ] Persist command history and execution outcomes needed for the recent-actions UI.
- [ ] Log security-sensitive events:
  - bridge pairing
  - bridge disconnect
  - command rejection
  - permission failure
- [ ] Keep per-user isolation intact in all reads and writes.

### Task 10: Document and migrate

**Files:**
- Modify: `docs/浏览器自动化与Web能力.md`
- Modify: `README.md`
- Modify feature-map docs if stable entrypoints move

- [ ] Document the new recommended deployment mode.
- [ ] Document extension installation and pairing flow.
- [ ] Document when `server_cdp` is still useful and when it is not.
- [ ] Document multi-user isolation guarantees and known limitations.
- [ ] Update architectural docs in the same implementation PRs that change stable behavior.

## PR Breakdown

### PR A: Contracts and backend bridge skeleton

- [ ] Add shared types and provider split.
- [ ] Add bridge session/connect/heartbeat primitives.
- [ ] Keep old browser routes working.

### PR B: Frontend browser workbench shell

- [ ] Add route, page shell, status UI, and placeholder command flow.
- [ ] Keep debug/admin controls separate from the main workbench.

### PR C: Extension MVP

- [ ] Implement pairing, tab binding, command execution, and event return.
- [ ] Validate one end-to-end action path from NanoClaw UI to local browser and back.

### PR D: History, recording, and agent/workflow integration

- [ ] Add recent actions and recording feed.
- [ ] Wire the bridge session into agent/browser execution policy.

### PR E: Cleanup and documentation

- [ ] Clarify naming, remove product ambiguity, and update docs/README/feature-map as needed.

## Test Plan

- [ ] Backend tests for session connect/disconnect/heartbeat and permission checks.
- [ ] Backend tests for command submission, timeout, rejection, and stale-session handling.
- [ ] Frontend tests for workbench state transitions and empty/disconnected/install-required states.
- [ ] Extension tests for command dispatch, content-script execution, and result propagation where practical.
- [ ] End-to-end validation for:
  - user pairs local browser
  - NanoClaw opens or binds a tab
  - action executes
  - result appears in recent actions
- [ ] Multi-user validation proving one user cannot read or control another user's browser session.
- [ ] Compatibility validation proving `server_cdp` still works in explicit fallback mode.

## Risks and Open Questions

- [ ] Verify whether extension APIs alone can provide reliable screenshots and frame-aware instrumentation.
- [ ] Verify whether cross-origin iframe scenarios require explicit degraded behavior in the UI.
- [ ] Decide whether bridge transport should be frontend-mediated, backend WebSocket-mediated, or support both.
- [ ] Decide whether session history requires persistent storage in v1 or if in-memory plus audit logs is sufficient.
- [ ] Decide whether extension distribution targets Chromium only first or includes Firefox later.

## Acceptance Criteria

- [ ] A normal multi-user deployment no longer depends on the server machine owning a usable browser runtime for the primary browser-control experience.
- [ ] A user with `browser.control` can pair a local browser and run real actions from NanoClaw.
- [ ] Another user cannot observe or control that session.
- [ ] The UI makes it clear when it is using `client_bridge` versus `server_cdp`.
- [ ] The old debug path remains available until the bridge path is proven stable.
