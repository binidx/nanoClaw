# Frontend Local Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve visual crowding through targeted local refactoring of Repo Review and Live2D settings, plus a collapsible global sidebar, without altering the global routing architecture.

**Architecture:** Instead of a heavy global tab system, we will use local state to manage "Master-Detail" or "Split Views" within the existing page components (`RepoReviewSettingsPanel.tsx` and `Live2DSettingsTab.tsx`). The `NavSidebar` will become collapsible for space-saving but will strictly remain a top-level navigation component without holding business data.

**Tech Stack:** React, plain CSS (CSS variables).

---

### Task 1: Refactor Repo Review Information Architecture

**Files:**

- Modify: `web/src/components/RepoReviewSettingsPanel.tsx`
- Modify: `web/src/App.css` (if specific local styles are needed)
- **Step 1: Implement Local Tabs/Pills for Repository Switching**
Currently, the repo review panel might be vertically crowded. Implement a local tab or "workspace pill" navigation at the top or side of the `RepoReviewSettingsPanel` to isolate the view to a single selected repository (`selectedRepositoryId`).
- **Step 2: Isolate Detail Sections**
Within the selected repository view, ensure that "Settings", "History", and "Review" are clearly separated, possibly using internal static tabs, so the user isn't overwhelmed by a massive vertical scroll of all configurations at once.

### Task 2: Refactor Live2D Settings to Split View

**Files:**

- Modify: `web/src/components/live2d/Live2DSettingsTab.tsx`
- Modify: `web/src/components/live2d/live2d.css`
- **Step 1: Implement Split View Layout**
Refactor `Live2DSettingsTab.tsx` to use a split-screen layout. The left pane should contain the Model Library (list of available models and upload controls). The right pane should contain the Preview and Configuration for the currently selected model.
- **Step 2: Preserve CompanionPage**
Ensure `web/src/pages/CompanionPage.tsx` remains strictly as the runtime conversational stage and is not polluted with management/configuration UI.

### Task 3: Refactor Navigation Sidebar (Collapsible)

**Files:**

- Modify: `web/src/components/NavSidebar.tsx`
- Modify: `web/src/App.css`
- **Step 1: Add Collapsible State**
Add a toggle button (e.g., at the bottom or top) to collapse/expand the `NavSidebar`. When collapsed, show only the icons. When expanded, show icons and text labels.
- **Step 2: Mobile Responsiveness**
Ensure the sidebar behaves correctly on mobile screens (e.g., hiding completely behind a hamburger menu or stacking as a bottom nav bar, utilizing the existing media queries in `App.css`). Do NOT add repository or Live2D lists into this sidebar.

### Task 4: Incremental Visual Polish

**Files:**

- Modify: `web/src/App.css`
- **Step 1: Refine Existing Variables**
Without doing a massive rewrite, tweak the existing CSS variables (e.g., `--surface-panel`, `--surface-card`, `--radius`) to enhance the clean, glass-like feel. Ensure both light and dark modes remain aligned.
- **Step 2: Spacing and Typography**
Adjust padding and margins within the refactored components (`RepoReviewSettingsPanel` and `Live2DSettingsTab`) to ensure the new split views and tabs have adequate breathing room and clear visual hierarchy.

