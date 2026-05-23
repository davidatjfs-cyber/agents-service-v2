# Knowledge Mobile Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the HRMS knowledge page into a profile-adjacent, mobile-first layout that is easier to browse and reorganize on phones.

**Architecture:** Keep the implementation inside `hr-management-system/working-fixed.html`, because the knowledge UI, state wiring, and viewer actions already live there. Replace the current mixed V2/legacy topbar and list treatment with a single mobile-oriented shell, then add a dedicated admin organizer sheet that uses the existing `/api/knowledge/groups` and `/api/knowledge/:id/group` endpoints so rearranging files is a first-class touch workflow instead of a hidden modal action.

**Tech Stack:** Single-file HTML app, inline CSS, inline browser JavaScript, existing `HRMS_API` request helpers.

---

### Task 1: Refresh The Knowledge Page Shell

**Files:**
- Modify: `hr-management-system/working-fixed.html`

- [ ] Replace the current knowledge list header block with a more mobile-friendly shell that includes:
  - a hero section styled closer to `我的档案`
  - a compact metric strip
  - a sticky search and action region
  - an explicit admin organizer entrypoint

- [ ] Rework the knowledge page CSS block so the page:
  - uses one coherent visual system
  - has larger tap targets
  - uses one-column cards on mobile
  - keeps the most important controls within thumb reach

- [ ] Keep desktop behavior functional by using responsive CSS rather than desktop-specific branching.

### Task 2: Simplify List And Detail Interaction

**Files:**
- Modify: `hr-management-system/working-fixed.html`

- [ ] Update list rendering helpers to support the new shell:
  - show counts in the hero metrics
  - show a clearer empty state
  - keep group browsing and file browsing in the same visual system

- [ ] Improve the detail viewer top area so:
  - back navigation is clearer on phones
  - admin actions are easier to hit
  - metadata presentation is denser and easier to scan

- [ ] Preserve existing item opening and AI summary behavior.

### Task 3: Add A Mobile Organizer For Admins

**Files:**
- Modify: `hr-management-system/working-fixed.html`

- [ ] Add a bottom-sheet style organizer modal for admins.

- [ ] Populate it from existing knowledge groups and group files so admins can:
  - quickly switch groups
  - see files in the current group
  - move a file into another group from a touch-friendly control

- [ ] Reuse `HRMS_API.moveKnowledgeToGroup(...)` so organizer actions stay aligned with the current backend contract.

- [ ] Replace the current ad-hoc transfer dialog path with the new organizer-driven experience while keeping item-level transfer possible from the viewer.

### Task 4: Verify No Regressions In Core Knowledge Flows

**Files:**
- Modify: `hr-management-system/working-fixed.html`

- [ ] Manually verify these flows in code by tracing existing handlers after the markup changes:
  - page load
  - search
  - tab switching
  - opening a group
  - opening a file
  - editing metadata
  - moving a file to another group

- [ ] Run a targeted syntax check against the updated single-file app to catch markup or script breakage before wrapping up.
