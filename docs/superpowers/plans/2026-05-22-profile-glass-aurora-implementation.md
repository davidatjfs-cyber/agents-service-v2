# Profile Glass Aurora Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the `我的档案` page in `working-fixed.html` so it visually matches the approved Glass Aurora direction without changing data behavior or affecting other modules.

**Architecture:** Keep the implementation inside the existing single-file HTML app. Isolate `#profile-page` from the shared black-gold report skin, strengthen the aurora background and glass layers in the profile-specific CSS block, and convert the most visible inline styles in the profile markup into reusable profile-only classes so the page can actually render the new system consistently.

**Tech Stack:** Static HTML, inline CSS, existing JavaScript page rendering in `hr-management-system/working-fixed.html`, browser-based manual verification

---

### Task 1: Isolate `#profile-page` From the Shared Black-Gold Surface

**Files:**
- Modify: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:10823-11040`
- Test: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:10823-11040`

- [ ] **Step 1: Record the current failure point in the style block**

Confirm that `#profile-page` is declared twice: once in the profile-specific Glass Aurora block and once again in the shared black-gold report block.

```css
/* Current profile-only block */
#profile-page {
  background: #0B0F1E !important;
}

/* Current shared block that re-darkens profile */
#profile-page,
#employees-page,
#attendance-page,
#rewards-page,
#kitchen-page,
#growth-page {
  background:
    radial-gradient(900px 520px at 100% -10%, rgba(45, 212, 191, 0.06), transparent 50%),
    radial-gradient(700px 400px at -10% 20%, var(--rep-gold-glow), transparent 45%),
    linear-gradient(165deg, var(--rep-bg0) 0%, var(--rep-bg1) 55%, #070a10 100%);
}
```

- [ ] **Step 2: Verify the current code contains the shared profile selector**

Run: `rg -n "^\\s*#profile-page," /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: a hit around the shared block beginning near line `10969`, proving profile is still inheriting the darker system background.

- [ ] **Step 3: Remove `#profile-page` from the shared panel skin and strengthen the dedicated profile background**

Update the CSS so the shared black-gold block no longer includes `#profile-page`, then upgrade the profile-only block to the approved three-blob aurora recipe with stronger opacity, larger blobs, and a softer deep-space base.

```css
#profile-page {
  --iris: #6D7CFF;
  --mint: #5EEAD4;
  --coral: #FF7A90;
  --amber: #FFC46B;
  --text: #EEF1FA;
  --dim: #9AA3C7;
  --faint: #5B6597;
  --stroke: rgba(255,255,255,0.12);
  --stroke-hi: rgba(255,255,255,0.22);
  --glass: rgba(255,255,255,0.10);
  background:
    radial-gradient(56rem 30rem at 14% 4%, rgba(109,124,255,0.48), transparent 56%),
    radial-gradient(44rem 24rem at 92% 10%, rgba(255,122,144,0.38), transparent 52%),
    radial-gradient(58rem 28rem at 50% 100%, rgba(94,234,212,0.28), transparent 54%),
    linear-gradient(180deg, #0B0F1E 0%, #121933 56%, #0C1222 100%) !important;
  position: relative;
  overflow-x: hidden;
  color: var(--text) !important;
}

#profile-page .ap-aurora__blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(120px);
}

#profile-page .ap-aurora__blob--1 {
  width: 70vw;
  height: 64vw;
  top: -18%;
  left: -14%;
  background: rgba(109,124,255,0.46);
}

#profile-page .ap-aurora__blob--2 {
  width: 54vw;
  height: 52vw;
  top: -10%;
  right: -14%;
  background: rgba(255,122,144,0.34);
}

#profile-page .ap-aurora__blob--3 {
  width: 74vw;
  height: 58vw;
  bottom: -18%;
  left: 22%;
  background: rgba(94,234,212,0.24);
}

#employees-page,
#attendance-page,
#rewards-page,
#kitchen-page,
#growth-page {
  background:
    radial-gradient(900px 520px at 100% -10%, rgba(45, 212, 191, 0.06), transparent 50%),
    radial-gradient(700px 400px at -10% 20%, var(--rep-gold-glow), transparent 45%),
    linear-gradient(165deg, var(--rep-bg0) 0%, var(--rep-bg1) 55%, #070a10 100%);
}
```

- [ ] **Step 4: Re-run the selector check**

Run: `rg -n "^\\s*#profile-page," /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: no results, confirming the profile page is no longer grouped into the shared dark panel selector.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xieding/HRMS add hr-management-system/working-fixed.html
git -C /Users/xieding/HRMS commit -m "feat: isolate profile page aurora background"
```

### Task 2: Upgrade Profile Glass Surfaces and Reusable Profile Tokens

**Files:**
- Modify: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:10848-10965`
- Test: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:10848-10965`

- [ ] **Step 1: Identify the current weak glass recipe**

Use the existing card styles as the baseline that currently reads too dark and too solid.

```css
#profile-page .card {
  background: rgba(20,26,48,0.52) !important;
  backdrop-filter: blur(20px) saturate(1.4) !important;
  border: 1px solid var(--stroke) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 24px rgba(0,0,0,0.35) !important;
}
```

- [ ] **Step 2: Verify the current card recipe is still the dark one**

Run: `rg -n "#profile-page \\.card|#profile-page \\.pf-quick-card|#profile-page \\.pf-notif-card" /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: hits in the profile style section showing the current `rgba(20,26,48,...)` cards and darker notification/quick-card variants.

- [ ] **Step 3: Replace the card recipes with a stronger glass system and add profile-only utility classes**

Extend the profile CSS block with reusable classes for hero card, section icon chips, metric tiles, summary tiles, and softer glass bands. Keep all selectors namespaced under `#profile-page`.

```css
#profile-page .card,
#profile-page .pf-quick-card,
#profile-page .pf-notif-card,
#profile-page .pf-leave-item,
#profile-page .pf-approval-item {
  background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.07)) !important;
  backdrop-filter: blur(28px) saturate(1.35) !important;
  -webkit-backdrop-filter: blur(28px) saturate(1.35) !important;
  border: 1px solid rgba(255,255,255,0.14) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.30),
    inset 0 -1px 0 rgba(255,255,255,0.04),
    0 16px 40px rgba(7,10,20,0.28) !important;
}

#profile-page .pf-card-hero {
  position: relative;
  overflow: hidden;
}

#profile-page .pf-card-hero::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(255,255,255,0.20), transparent 42%, rgba(255,255,255,0.05) 78%);
  pointer-events: none;
}

#profile-page .pf-icon-chip {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.16);
}

#profile-page .pf-metric-tile,
#profile-page .pf-summary-tile {
  background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05));
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 16px;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

#profile-page .pf-band--amber {
  background: linear-gradient(135deg, rgba(255,196,107,0.18), rgba(255,196,107,0.08));
  border: 1px solid rgba(255,196,107,0.26);
}

#profile-page .pf-band--mint {
  background: linear-gradient(135deg, rgba(94,234,212,0.14), rgba(94,234,212,0.06));
  border: 1px solid rgba(94,234,212,0.20);
}

#profile-page .pf-band--coral {
  background: linear-gradient(135deg, rgba(255,122,144,0.14), rgba(255,122,144,0.06));
  border: 1px solid rgba(255,122,144,0.20);
}
```

- [ ] **Step 4: Verify the new utility selectors exist**

Run: `rg -n "pf-card-hero|pf-icon-chip|pf-metric-tile|pf-summary-tile|pf-band--amber" /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: each selector appears once in the profile style section.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xieding/HRMS add hr-management-system/working-fixed.html
git -C /Users/xieding/HRMS commit -m "feat: strengthen profile glass card system"
```

### Task 3: Apply the New Visual System to the Profile Markup and Verify in Browser

**Files:**
- Modify: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:19006-19217`
- Test: `/Users/xieding/HRMS/hr-management-system/working-fixed.html:19006-19217`

- [ ] **Step 1: Identify the most visible inline surfaces that still hard-code the old look**

Use the profile markup block as the baseline. The key offenders are the hero avatar chip, points banner, notification header icon, metric tiles, summary bands, and the resignation card opacity.

```html
<div class="card" style="margin-bottom: 14px; padding: 20px;">
  <div style="width: 52px; height: 52px; ... background: linear-gradient(135deg, rgba(59,130,246,0.25), rgba(139,92,246,0.25)); ...">👤</div>
</div>

<div style="padding: 11px; border-radius: 12px; background: linear-gradient(135deg, rgba(250,204,21,0.18), rgba(245,158,11,0.08)); ...">
  ...
</div>

<div style="padding: 12px 10px; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); ...">
  ...
</div>
```

- [ ] **Step 2: Verify the old inline surfaces are still present**

Run: `rg -n "rgba\\(255,255,255,0\\.03\\)|rgba\\(59,130,246,0\\.25\\)|rgba\\(250,204,21,0\\.18\\)" /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: hits in the profile markup block around the hero card, points module, and metric tiles.

- [ ] **Step 3: Update the profile markup to use the new profile-only classes**

Keep IDs and JS hooks unchanged, but replace the most visible inline presentation styles with reusable classes from Task 2 so the approved aurora system can actually render. A representative conversion should look like this:

```html
<div class="card pf-card-hero" style="margin-bottom: 14px; padding: 20px;">
  <div style="display:flex; align-items:flex-start; gap: 12px;">
    <div class="pf-avatar-orb">👤</div>
    <div style="flex:1; min-width:0;">
      <div class="pf-hero-name" id="profile-name">--</div>
      <div class="pf-hero-meta"><span id="profile-store">--</span> · <span id="profile-department">--</span> · <span id="profile-position">--</span></div>
    </div>
    <div id="profile-store-rating-badge" class="pf-store-rating-badge" style="display:none;">
      ...
    </div>
  </div>
</div>

<div class="pf-points-banner pf-band--amber" onclick="showPage('points')">
  ...
</div>

<div class="profile-metrics-grid" style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px;">
  <div class="pf-metric-tile">
    <div class="pf-metric-k">级别</div>
    <div class="pf-metric-v" id="profile-level">--</div>
  </div>
  ...
</div>

<div class="pf-quick-card pf-quick-card--muted" onclick="openResignationModal()">
  ...
</div>
```

- [ ] **Step 4: Run a browser/manual verification pass**

Run: `open http://localhost:3000/working-fixed.html`

Expected:
- Profile page no longer reads as black-gold.
- Three aurora blobs are visibly present behind content.
- Hero card, metrics, notifications, attendance, and quick actions all show stronger glass/highlight treatment.
- Text remains readable on mobile-width layout.

- [ ] **Step 5: Commit**

```bash
git -C /Users/xieding/HRMS add hr-management-system/working-fixed.html
git -C /Users/xieding/HRMS commit -m "feat: apply glass aurora styling to profile page"
```

### Task 4: Final Verification and Deployment-Safe Review

**Files:**
- Modify: none
- Test: `/Users/xieding/HRMS/hr-management-system/working-fixed.html`

- [ ] **Step 1: Confirm the planned scope did not spill into other pages**

Run: `git -C /Users/xieding/HRMS diff -- hr-management-system/working-fixed.html | sed -n '1,260p'`

Expected: changes are limited to the profile style block and the profile markup block; no unrelated business logic should be touched.

- [ ] **Step 2: Re-check profile-only selector coverage**

Run: `rg -n "#profile-page|pf-card-hero|pf-metric-tile|pf-quick-card--muted" /Users/xieding/HRMS/hr-management-system/working-fixed.html`

Expected: all new selectors are namespaced to `#profile-page` or start with `pf-`, reducing the chance of leaking into other modules.

- [ ] **Step 3: Do one final visual verification in browser**

Run: `open http://localhost:3000/working-fixed.html`

Expected: the approved “option 1” target feel is present: obvious aurora, real glass cards, and no return to the old heavy black base.

- [ ] **Step 4: Commit the verification-ready state**

```bash
git -C /Users/xieding/HRMS add hr-management-system/working-fixed.html
git -C /Users/xieding/HRMS commit -m "chore: verify profile glass aurora refinement"
```

