# Review And Assistant UI Design

**Date:** 2026-03-25

## Goal

Redesign NanoClaw's code review and assistant-related frontend surfaces so they stay close to the current visual style but become much clearer, more task-oriented, and less crowded.

The first priority is the code review page. The second priority is the assistant surface, including the ticket assistant experience.

## Problem

The current frontend has a clarity problem more than a styling problem.

- the code review surface mixes workbench actions, configuration, history, and detail flows in one large page
- the primary object of work is unclear: users see cards, sections, and dialogs before they see the branch they need to act on
- large forms and dense panels are used where small dialogs or drawers would be easier to understand
- assistant configuration, ticket configuration, and ticket run handling are split across multiple pages with inconsistent mental models
- history and full-detail content are shown too early, which competes with the main task instead of supporting it

## Constraints

- Stay within the existing NanoClaw visual language instead of introducing a foreign design system.
- Keep the UI compact and general-purpose.
- Prefer stable list-detail layouts over dense dashboard composition.
- Prefer small dialogs or drawers for short actions and focused edits.
- Preserve existing backend contracts unless implementation later proves a small frontend-facing aggregation is necessary.
- Preserve current dark-mode support and avoid creating a light-mode-only redesign.
- Do not keep code review run history as a first-class section inside the code review page.

## Chosen Approach

Use a unified list-first information architecture across both code review and assistant surfaces:

- primary page = object list + focused detail
- secondary concerns = tabs
- short actions = modal or drawer
- full historical inspection = separate history surface

For code review, the primary object is the branch.

For assistants, the primary object is the assistant, while ticket run handling should mirror the same list-detail hierarchy instead of stacking every panel in one long page.

## Alternative Approaches Considered

### 1. Dense Workbench

Keep the current workbench feel and refine spacing, card hierarchy, and styling.

Rejected because it preserves the core information-architecture problem: too many concerns remain visible at once.

### 2. History-Centered Review Page

Make review runs the primary list and push branch context into filters and detail views.

Rejected because the user's goal is to act on branches, not browse runs. History remains useful, but only as a separate destination.

### 3. Branch-First Workspace

Make branches the main review object, move configuration into a separate tab, and move full run history into the existing history area.

Chosen because it matches the user's preferred interaction model and removes the largest source of page crowding.

## UX Shape

### Code Review

- The code review surface has two tabs:
  - `Branch Workspace`
  - `Configuration`
- Default tab is `Branch Workspace`.
- The page no longer contains a review-run history section.
- History inspection and full review detail live in the existing global history surface.

### Branch Workspace

The stable page layout is:

1. top toolbar
2. branch list
3. fixed right-side branch detail panel

The top toolbar includes only high-value controls:

- repository switcher
- branch search
- status filter
- `only pending manual decision` toggle
- `start review` action

The branch list is the main focus of the page and supports pagination.

Each branch row should show only the information needed for fast triage:

- branch name
- latest commit time
- current review status
- pending-manual indicator
- short latest review summary

Each branch row should expose concise actions:

- review
- rerun
- manual decision when applicable
- more actions

Selecting a branch updates the fixed right-side detail panel.

The detail panel is intentionally summary-oriented and should not become another history page. It shows:

- latest review summary
- baseline / target branch context
- current blocker or pending manual item
- compact quick actions

Detailed timelines and long-form review content are out of scope for this panel and should be opened from history instead.

### Code Review Configuration

The `Configuration` tab replaces the current mixed-in configuration experience.

Inside the tab, content is grouped into three sections:

- repository source
- review profiles
- notifications and auto-sync

The configuration area should prefer:

- compact section cards
- list + lightweight edit modal patterns
- focused drawers for secondary detail

It should avoid:

- one giant mixed editor
- embedding review-run content
- long vertically stacked forms covering unrelated entities

### Assistant Surface

The assistant page should adopt the same structural rules:

- left or primary list of assistants
- focused assistant detail surface
- secondary settings in drawers or tabs

The current resource, permission, and secret drawers are aligned with this direction and should remain drawer-based.

Ticket configuration should no longer behave like a large catch-all modal. It should be reorganized into stable sections or tabs:

- workspace
- profiles
- bindings

Each section should use list-detail or list-modal editing patterns instead of a single long form that switches between different object types.

### Ticket Assistant

The ticket assistant inside chat should remain embedded in the chat flow, but the internal panel hierarchy should be simplified.

The panel should consistently prioritize:

1. create or continue ticket work
2. current conclusion and next step
3. recent run summary

Evidence, search artifacts, publishing actions, and feedback should become secondary sections or drawer-level interactions instead of competing equally in one long vertical flow.

## Information Architecture

### Code Review

- `Code Review`
  - `Branch Workspace`
  - `Configuration`

### Global Surfaces Outside Code Review

- `History`
  - review run history
  - full timeline detail
  - full result inspection

### Assistants

- `Assistants`
  - assistant overview
  - assistant detail
  - resource / permission / secret drawers
  - ticket configuration sections

### Chat

- `Chat`
  - conversation flow
  - embedded ticket assistant panel

## Interaction Rules

- Persistent page regions should remain stable while users switch objects.
- Full-page context should not change for short actions.
- Use modal for short confirmation or quick-submit flows:
  - start review
  - manual decision
  - compact create/edit actions
- Use drawer for secondary context:
  - baseline detail
  - configuration detail
  - artifacts or evidence detail
- Use dedicated pages or tabs for broad management tasks.
- Remove large in-page editing areas when the user only needs a focused edit flow.

## Data And State Boundaries

### Code Review

The code review page should manage only four primary frontend state groups:

- current repository
- filters
- pagination
- selected branch

The branch list data should be branch-oriented, not run-oriented.

Each branch row should be backed by a compact aggregate state:

- current review status
- latest summary
- pending manual flag
- latest activity time

The right-side detail panel may request more branch-specific detail, but it should remain summary-level.

Configuration data should load separately from the branch workspace to keep the default page lighter and easier to reason about.

### Assistants

The assistant page should separate:

- assistant collection state
- selected assistant state
- secondary drawer state
- ticket-configuration editing state

The ticket assistant panel should separate:

- current run state
- recent run summary state
- secondary artifact and feedback state

## Component Responsibilities

This redesign should move away from oversized container files.

### Code Review

Likely split of responsibility:

- branch workspace container
- branch toolbar
- branch list
- branch detail panel
- configuration workspace

Current files likely affected:

- `web/src/components/RepoReviewSettingsPanel.tsx`
- `web/src/components/repo-review/RepoReviewBranchStatusModal.tsx`
- `web/src/components/repo-review/RepoReviewRunDetailModal.tsx`
- `web/src/components/repo-review/RepoReviewProfileSection.tsx`
- `web/src/components/repo-review/ReviewProgressTimeline.tsx`
- `web/src/App.css`

### Assistants

Likely split of responsibility:

- assistant directory panel
- assistant summary panel
- ticket configuration sections
- simplified ticket assistant run panel

Current files likely affected:

- `web/src/pages/AssistantsPage.tsx`
- `web/src/components/tickets/TicketSettingsPanel.tsx`
- `web/src/components/tickets/TicketAssistantPanel.tsx`
- `web/src/pages/ChatPage.tsx`
- `web/src/App.css`

## Pagination

Pagination is appropriate for:

- branch list when repository branch counts are large
- configuration lists with many items
- assistant-related lists when they exceed compact scan range

Pagination is not appropriate for:

- the fixed detail panel
- short action dialogs
- inline current-run summaries

## Visual Direction

- Keep the existing compact NanoClaw feel.
- Reduce the number of simultaneously emphasized cards.
- Use whitespace to establish hierarchy, not large decorative blocks.
- Reserve strong color for status and exceptions.
- Prefer neutral containers and concise section headers.
- Avoid hero-style sections on primary work pages where they compete with the task list.

## Testing Strategy

- Frontend build must pass.
- Targeted frontend tests should be added or updated where component logic changes materially.
- Verification should focus on:
  - branch filtering and pagination behavior
  - branch selection and detail synchronization
  - modal and drawer interaction flow
  - configuration tab isolation
  - assistant page drawer and tab flow
  - ticket assistant hierarchy regressions

## Out Of Scope

- Backend policy or permission model redesign
- Replacing existing backend review or ticket APIs wholesale
- A full visual rebrand for NanoClaw
- Converting the app into a new routing architecture
- Rebuilding global history itself in this change
