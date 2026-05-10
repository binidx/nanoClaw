# Users Page Workbench Design

Date: 2026-03-26
Scope: `web/src/pages/UsersPage.tsx`
Status: Draft approved in-session, pending final user review

## Goal

Refactor the current users page from a basic table-plus-inline-form layout into a workbench page that matches NanoClaw's existing admin surfaces such as assistants and repo review.

The target outcome is:

- clearer information architecture
- faster user lookup through search, filters, and pagination
- a stable left-list / right-detail mental model
- no backend API contract changes

This is a UI structure improvement, not a user-management feature expansion.

## Non-Goals

- no new backend endpoints
- no role or permission model redesign
- no audit log feature
- no bulk actions
- no multi-step wizard
- no modal-heavy rewrite

## Current Problems

The current page has several structural issues:

- creation form expands at the top of the page and interrupts the main reading flow
- editing is mixed into the table, so view and edit states are visually noisy
- role management is split between row-level controls and separate form state
- there is no clear object-focused work area for the selected user
- the page does not visually align with other NanoClaw admin workbench pages

## Selected Direction

Use a two-column workbench layout.

- Left column: user discovery and selection
- Right column: selected user detail, edit mode, and create mode

This keeps the page aligned with existing NanoClaw patterns:

- object list on one side
- focused detail area on the other
- explicit state changes instead of row-level inline editing

## Page Structure

### Header

Use the existing page header pattern.

- title: `用户管理`
- short description explaining account, status, and role maintenance
- primary action: `新增用户`

Do not include dashboard-style overview metrics at the top. The user explicitly rejected this because paging and filtering are sufficient.

### Main Layout

Use a two-column workbench shell.

- Left column width should favor discovery but remain compact
- Right column should be the main reading and editing area
- On smaller screens, the layout may stack vertically, but desktop should stay two-column

## Left Column Design

The left column is for locating a user, not editing a user.

### Controls

- search input with fuzzy matching on `username`, `displayName`, and `email`
- status filter
- role filter
- pagination controls

### List Items

Replace the plain table-first presentation with selectable user cards or rows that behave like workbench items.

Each item should show:

- username as the primary label
- display name or email as the secondary line
- status badge
- compact role summary

Selection state should be visually obvious and consistent with other management pages.

### Empty States

- no users: encourage creating the first user
- no filter results: prompt the user to adjust search or filters

## Right Column Design

The right column has three top-level states.

### 1. Empty Detail State

When no user is selected and not creating:

- show a structured empty state
- explain that selecting a user will show details and editing tools
- include a prominent `新增用户` action if appropriate

### 2. Detail State

Default state after selecting a user.

Recommended sections:

- basic info
  - username
  - display name
  - email
  - created time
- account state
  - active / disabled
- assigned roles
  - role chips
  - short role descriptions when available
- actions
  - edit
  - delete

The detail view should read as a management summary, not as a form.

### 3. Edit State

Triggered by clicking `编辑` on the selected user.

Edit mode stays in the right column and replaces the detail view.

Editable fields:

- display name
- email
- password
- status
- assigned roles

Bottom actions:

- cancel
- save

Error and success feedback should stay local to the right pane instead of floating globally.

## Create User Flow

Creation should not reopen the legacy top-of-page expansion block.

Instead:

- clicking `新增用户` switches the right column into create mode
- left column remains visible
- create mode uses a clean form with required and optional fields separated clearly

Create fields:

- username
- password
- display name
- email
- initial status
- initial roles

On successful creation:

- reload the list
- select the newly created user
- switch the right pane back to detail state
- show a scoped success message

## Role Management

Role management belongs inside the right-column detail/edit workflow.

### Detail State

- show assigned roles as readable chips or tokens
- include short descriptions when available

### Edit State

- show assigned roles with explicit remove actions
- show an add-role selector that only lists roles not already assigned
- keep role editing within the current selected-user context

Role management should not remain primarily row-level in the left list.

## Interaction Rules

- left column changes selection only
- right column owns view, edit, and create state
- edit is explicit, not inline-by-default
- create and edit states should not be active at the same time
- destructive actions remain confirmed

## Visual Language

The page should follow existing NanoClaw styling conventions rather than inventing a new design system.

Use and adapt existing patterns where possible:

- `page-view`
- `page-header`
- workbench-like split layouts from assistants or repo review
- existing badges, empty states, cards, and button hierarchy

Avoid:

- oversized summary dashboards
- heavy modal dependence
- generic admin template aesthetics
- inline-style-heavy layout code

## Responsive Behavior

Desktop:

- fixed two-column workbench feel

Tablet / narrow widths:

- stacked layout is acceptable
- left column discovery tools should remain accessible before detail content

The mobile fallback does not need to become a separate redesign, but it must remain usable.

## Data and API Constraints

No backend changes are required.

The page continues to use:

- `GET /api/users`
- `GET /api/roles`
- `POST /api/users`
- `PUT /api/users/:id`
- `DELETE /api/users/:id`
- `POST /api/users/:id/roles`
- `DELETE /api/users/:id/roles/:roleId`

Any new UI state should be implemented entirely in the frontend.

## Implementation Notes

Expected implementation focus:

- restructure `UsersPage.tsx`
- move away from top-level inline styles toward reusable CSS classes in `web/src/App.css`
- keep state local unless the current architecture forces extraction
- normalize the selected-user, create-mode, and edit-mode flow so they are mutually coherent

If the page becomes too large during refactor, a small local helper split is acceptable, but avoid a broad component explosion.

## Verification

Minimum verification target:

- frontend build passes
- targeted users-page state and interaction coverage through extracted helper/state logic for:
  - filter and search behavior
  - selection recovery for the right pane after filtering or reload
  - detail-to-edit and create-to-detail pane transitions
  - create flow selecting the created user
  - right-pane role add/remove derivation and available-role calculation

Optional enhancement:

- add a narrow page-level render test only if the repo gains a lightweight DOM test harness that fits existing frontend test patterns

## Acceptance Criteria

This redesign is complete when:

- the users page visually matches NanoClaw's current workbench-style admin surfaces
- the page no longer relies on a top-expanding create form
- user selection and user editing are clearly separated
- role management is centered in the right-side selected-user context
- the page remains functional without backend changes
