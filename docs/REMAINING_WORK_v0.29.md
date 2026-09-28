# DeepFish Harbor v3 - Remaining Work Items

**Date:** 2026-09-28  
**Current Status:** Phase 1 complete, Phases 2-3 in progress  
**Next Release:** v0.29.0

---

## What's Actually Complete ✅

Phase 1 board tab integration is **shipping in v0.27.6+**:
- ✅ Unified board panel with 4 tabs (codex/records/logs/feedback)
- ✅ Tab routing via `navigateView('board', tabIndex)`
- ✅ Deep linking: `#/place/board/0`, `#/place/board/1`, etc.
- ✅ Cork background: `#d4c4a8`
- ✅ Paper card styling with shadows and pins
- ✅ Feature guard integration via `pageIdOf()` remapping

**Files completed:**
- `frontend/js/ui.js:204` - boardTab initialization
- `frontend/js/ui.js:779-814` - navigateView/applyTabDeepLink
- `frontend/js/ui.js:9932-9977` - renderBoard wrapper + tab dispatch
- `frontend/css/harbor.css:159-204` - Cork background + card styling

---

## Remaining Work: Phase 2-3 (Visual Verification & Polish)

### 🎯 IMMEDIATE: Board Content Card Wrapping (2-4 hours)

**Current Problem:**
Each board section (codex/records/logs/feedback) appends multiple direct children to `.board-content`:
- codex-summary (stats box)
- inv-cats (sub-tabs)
- codex-grid (main content)

The CSS selector `.board-content > div::before` (the red pin) applies to **ALL** of them, creating multiple pins.

**Design Intent:**
One unified card per board section with a single pin at the top-center (cork board aesthetic).

**Solution:** Wrap all appended elements in a single `<div class="board-card">` container

**Implementation Tasks:**

1. **renderBoardCodex()** (`frontend/js/ui.js:9981`)
   - Wrap summary, tabs, grid in single `board-card` div
   - Test: Only one pin appears, centered at card top

2. **renderBoardRecords()** (`frontend/js/ui.js:10078`)
   - Wrap hero section, h3 headers, record grid in single `board-card` div
   - Test: Pin at card top, content flows below

3. **renderBoardLogs()** (`frontend/js/ui.js:10138`)
   - Wrap log page and footer in single `board-card` div
   - Test: Pin visible above log list

4. **renderBoardFeedback()** (`frontend/js/ui.js:10184`)
   - Wrap form and feedback list in single `board-card` div
   - Test: Pin above form

5. **CSS Update** (`frontend/css/harbor.css:195`)
   - Change `.board-content > div` to `.board-content > .board-card`
   - Ensures styling applies only to intentional cards, not intermediate containers

**Verification:**
```bash
# After changes:
npm run dev
# Open board page, verify:
# - Only 1 pin per tab
# - Pin centered above card
# - No double shadows
# - Scrolling works smoothly
```

---

### 📏 MEDIUM: Responsive Spacing (45 min - 1 hour)

**Current CSS:** Fixed values for all viewports
- Padding: 20px
- Gap between cards: 20px
- Cork panel width: 3% inset on desktop

**Needed Additions to `harbor.css`:**

```css
/* Tablet (768px - 1200px) */
@media (max-width: 1200px) {
  .h-panel[data-place="board"] .board-content {
    gap: 16px;
  }
  .h-panel[data-place="board"] .board-content > .board-card {
    padding: 16px;
    padding-top: 24px;
  }
}

/* Mobile (< 768px) */
@media (max-width: 768px) {
  .h-panel[data-place="board"] .board-content {
    gap: 12px;
  }
  .h-panel[data-place="board"] .board-content > .board-card {
    padding: 12px;
    padding-top: 20px;
  }
  .h-panel[data-place="board"] .board-content > .board-card::before {
    width: 14px;
    height: 14px;
  }
}

/* Large desktop (> 1600px) */
@media (min-width: 1600px) {
  .h-panel[data-place="board"] .board-content {
    gap: 28px;
  }
}
```

**Testing:**
- Desktop (1920px): 20px spacing
- Tablet (1024px): 16px spacing
- Mobile (375px): 12px spacing

---

### 🎨 LOWER: Interaction Polish (1-1.5 hours)

**Card Hover Effects** (add to `harbor.css`):
```css
.h-panel[data-place="board"] .board-content > .board-card {
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}

.h-panel[data-place="board"] .board-content > .board-card:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, .25), 0 2px 4px rgba(0, 0, 0, .12);
  transform: translateY(-2px);
}
```

**Tab Transition** (smooth content switch):
```css
.board-content {
  animation: fadeIn 0.15s ease-in;
}

@keyframes fadeIn {
  from { opacity: 0.8; }
  to { opacity: 1; }
}
```

**Pin Visual Feedback**:
```css
.h-panel[data-place="board"] .board-content > .board-card::before {
  transition: transform 0.3s ease;
}

.h-panel[data-place="board"] .board-content > .board-card:hover::before {
  transform: translateX(-50%) scale(1.1) rotate(5deg);
}
```

---

### ✅ TESTING: Cross-Device Verification

After implementation, verify:

| Device | Check | Expected |
|--------|-------|----------|
| Desktop (1920px) | Cork color, pin centering, card shadows | All visible, crisp |
| Tablet (1024px) | Spacing reduction, responsive layout | Padding 16px, gap 16px |
| Mobile (375px) | Stacking, small pin, readable text | Single column, no overflow |
| Dark mode (if applicable) | Shadow readability | Shadows remain visible |

**Browser DevTools checklist:**
- [ ] No layout shift on tab switch
- [ ] No jank on scroll (60fps)
- [ ] Pin renders without blurring
- [ ] Shadows consistent across zoom levels (75%, 100%, 125%)

---

## Phase 2 Other Pages (Lower Priority)

From gap analysis - visual verification only:

### Workshop Page (Optional verification)
- **Current:** Benches, equipment growth, smelting
- **Check:** Bench layout matches `a-room-workshop.png`
- **Estimate:** 30 min

### Mall Page (Optional verification)
- **Current:** Shop, buyback, market tabs
- **Check:** Trend arrows, player avatars display
- **Estimate:** 30 min

### Voyage Page (Optional verification)
- **Current:** Route visualization, ship animation
- **Check:** Map render quality, animation smoothness
- **Estimate:** 30 min

---

## Release Path to v0.29.0

```
1. [1 hour] Board content card wrapping implementation
2. [30 min] Responsive media queries
3. [45 min] Interaction polish (hover, transitions, pin feedback)
4. [1 hour] Browser testing across devices
5. [30 min] Screenshots for changelog
6. Version bump: v0.27.6 → v0.29.0
```

**Total:** ~4 hours active work

---

## Decision Points

**Q1: Should we wrap each section (summary/tabs/grid) as separate cards?**
- A: No. Single unified card per board view (codex = 1 card, records = 1 card, etc.)

**Q2: Should pin position vary by card height?**
- A: No. Fixed top-center at -10px for consistency

**Q3: Should we add hover animations to inner content (grids, lists)?**
- A: Optional; focus first on card-level polish, then iterate if time allows

---

## Success Criteria

✅ All 4 board tabs render with exactly 1 red pin each
✅ Responsive spacing adjusts at 768px and 1600px breakpoints
✅ Card hover lifts shadow smoothly (no jank)
✅ Responsive tested on Chrome/Firefox at 100%/75%/125% zoom
✅ Mobile layout flows without horizontal scroll
✅ Git history clean (logical commits per phase)

---

**Next:** Start with board card wrapping implementation.
