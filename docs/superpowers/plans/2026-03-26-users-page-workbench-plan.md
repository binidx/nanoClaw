# Users Page Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the users page into a NanoClaw-style two-column workbench with a selectable user list on the left and detail/edit/create flows on the right.

**Architecture:** Keep all backend contracts unchanged and refactor the frontend around a stable selection model. Move list filtering, paging, and view-model shaping into a small helper module so the page can stay readable and the interaction logic can be tested without introducing new test infrastructure.

**Tech Stack:** React 19, TypeScript, Vite, existing NanoClaw CSS in `web/src/App.css`, Vitest.

---

## File Structure

### Planned file changes

- Modify: `web/src/pages/UsersPage.tsx`
  - Replace the current table-plus-inline-form layout with the two-column workbench page.
- Create: `web/src/pages/users-page-helpers.ts`
  - Hold filtering, pagination, role summary, and right-pane state helpers.
- Create: `web/src/pages/users-page-helpers.test.ts`
  - Verify list filtering, pagination, selected-user fallbacks, and role summary shaping.
- Modify: `web/src/App.css`
  - Add users-page-specific classes that match the visual language of assistants/settings/repo review.
- Modify: `docs/superpowers/specs/2026-03-26-users-page-workbench-design.md` only if implementation constraints force a small spec correction.

## Task 1: Extract Users Page View-Model Helpers

**Files:**
- Create: `web/src/pages/users-page-helpers.ts`
- Create: `web/src/pages/users-page-helpers.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add tests for:

```ts
describe('users-page helpers', () => {
  it('filters users by search text across username, displayName, and email', () => {});
  it('filters users by status and role', () => {});
  it('returns the requested page window and clamps invalid pages', () => {});
  it('builds a compact role summary with overflow count', () => {});
  it('resolves a safe selected user after filtering or deletion', () => {});
});
```

- [ ] **Step 2: Run the helper test file to verify it fails**

Run: `npx vitest run web/src/pages/users-page-helpers.test.ts`

Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

Create `users-page-helpers.ts` with focused functions such as:

```ts
export function filterUsers(...)
export function paginateUsers(...)
export function buildRoleSummary(...)
export function resolveSelectedUserId(...)
```

Keep helpers data-only. No React state inside the helper module.

- [ ] **Step 4: Re-run the helper tests**

Run: `npx vitest run web/src/pages/users-page-helpers.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/users-page-helpers.ts web/src/pages/users-page-helpers.test.ts
git commit -m "test: add users page view-model helpers"
```

## Task 2: Refactor Users Page State Around Selection and Pane Modes

**Files:**
- Modify: `web/src/pages/UsersPage.tsx`
- Use: `web/src/pages/users-page-helpers.ts`

- [ ] **Step 1: Add a failing test or assertion target for selection-state assumptions if practical**

If render testing stays too expensive with current tooling, document the state transitions in comments near the relevant reducer/state helpers and rely on helper tests from Task 1 plus build verification.

- [ ] **Step 2: Introduce explicit pane state in `UsersPage.tsx`**

Refactor local state to make these modes explicit:

```ts
type UsersPaneMode = 'empty' | 'detail' | 'edit' | 'create';
```

Track:

- selected user id
- pane mode
- create form state
- edit form state
- search text
- status filter
- role filter
- current page

- [ ] **Step 3: Remove inline row editing from the left-side list flow**

Delete the current per-row inline edit rendering and switch to:

- selectable list items on the left
- detail/edit/create pane on the right

- [ ] **Step 4: Ensure selection recovery works after mutations**

After create, update, delete, assign-role, revoke-role:

- reload users
- keep or repair selection using `resolveSelectedUserId`
- switch pane mode appropriately

- [ ] **Step 5: Run the helper tests again**

Run: `npx vitest run web/src/pages/users-page-helpers.test.ts`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/UsersPage.tsx web/src/pages/users-page-helpers.ts
git commit -m "refactor: add users page selection workbench state"
```

## Task 3: Build the Two-Column Users Workbench UI

**Files:**
- Modify: `web/src/pages/UsersPage.tsx`
- Modify: `web/src/App.css`

- [ ] **Step 1: Replace the current page shell with the standard page header**

Implement:

- `page-view`
- `page-header`
- page description
- `新增用户` primary action

No top summary metrics.

- [ ] **Step 2: Build the left discovery column**

Include:

- search field
- status filter
- role filter
- paginated selectable user list
- empty-result and no-user states

Each user item should show:

- username
- display name or email
- status badge
- compact role summary

- [ ] **Step 3: Build the right detail pane**

Default detail sections:

- basic info
- account state
- assigned roles
- actions

Use existing NanoClaw card/panel language instead of table cells or large inline style blocks.

- [ ] **Step 4: Build the right edit pane**

Edit mode should include:

- display name
- email
- password
- status
- role management
- cancel/save actions

Keep feedback local to the pane.

- [ ] **Step 5: Build the create pane**

Create mode should appear in the right pane and include:

- username
- password
- display name
- email
- initial status
- initial roles

On success:

- reload list
- select created user
- switch back to detail mode

- [ ] **Step 6: Move page-specific layout styles into `App.css`**

Create a focused class family such as:

```css
.users-page
.users-workbench
.users-sidebar
.users-detail-pane
.users-list
.users-list-item
.users-filter-row
.users-role-chip
.users-empty-state
```

Follow nearby assistants and repo review patterns for spacing, borders, hover states, and panel treatment.

- [ ] **Step 7: Remove leftover inline layout styles**

Keep only tiny dynamic style values if unavoidable; prefer CSS classes for structure and theming.

- [ ] **Step 8: Run the frontend build**

Run: `cmd /c "cd web && npm run build"`

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/UsersPage.tsx web/src/App.css
git commit -m "feat: redesign users page as workbench"
```

## Task 4: Validate Critical Interaction Paths

**Files:**
- Modify: `web/src/pages/users-page-helpers.test.ts`

- [ ] **Step 1: Expand test coverage for post-mutation selection behavior**

Add helper-level tests that simulate:

- create selecting a newly inserted user
- delete moving selection to the next sensible user or empty state
- filter changes clearing invalid selection

- [ ] **Step 2: Cover pane and role-management derivation at the helper/state level**

Add concrete assertions for:

- detail-to-edit transition state
- create-to-detail transition state
- available-role derivation excluding assigned roles
- right-pane empty-state derivation when the filtered result set becomes empty

- [ ] **Step 3: Run the targeted frontend tests**

Run: `npx vitest run web/src/pages/users-page-helpers.test.ts`

Expected: PASS

- [ ] **Step 4: Re-run the frontend build**

Run: `cmd /c "cd web && npm run build"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/users-page-helpers.test.ts
git commit -m "test: verify users page workbench interactions"
```

## Task 5: Final Verification and Diff Review

**Files:**
- Review only

- [ ] **Step 1: Run the full targeted verification set**

Run:

```bash
cmd /c "cd web && npx vitest run src/pages/users-page-helpers.test.ts"
cmd /c "cd web && npm run build"
```

- [ ] **Step 2: Review the final diff for style drift**

Check that the users page:

- matches NanoClaw admin UI tone
- does not reintroduce top-expanding forms
- keeps role management in the right pane
- avoids ad hoc inline layout styling

- [ ] **Step 3: Commit final polish if needed**

```bash
git add web/src/pages/UsersPage.tsx web/src/App.css web/src/pages/users-page-helpers.ts web/src/pages/users-page-helpers.test.ts
git commit -m "chore: finalize users page workbench polish"
```
