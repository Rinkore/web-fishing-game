# Phase 2: Visual Testing & Verification Checklist

## Overview
Phase 2 focuses on verifying the visual implementation of the harbor v3 board design matches the reference design. This document provides a structured checklist for manual visual testing.

**Reference Design**: `output/design-review/redesign/v2/index.html`
**Target Implementation**: `frontend/css/harbor.css` + board rendering in `frontend/js/ui.js`

---

## Core Visual Elements to Verify

### 1. Cork Board Background ✓
- **CSS Rule**: `.h-panel[data-place="board"] .h-pbody { background: #d4c4a8; }`
- **What to check**: 
  - [ ] Background color is a warm brownish-tan (#d4c4a8)
  - [ ] Background fills the entire board panel area
  - [ ] Background is consistent across all board tabs (图鉴/记录/日志/反馈/WIKI)

### 2. Paper Card Design ✓
- **CSS Rules**: `.h-panel[data-place="board"] .board-content > div`
- **What to check**:
  - [ ] Each section (summary, tabs, grid) appears as a white/cream paper card
  - [ ] Cards have a subtle beige/cream background (#f5f1ed) 
  - [ ] Cards have a 2px solid border (#e8ddf4)
  - [ ] Cards have a drop shadow (0 4px 12px rgba(0,0,0,.2), 0 1px 3px)
  - [ ] Cards have proper padding (20px) with 28px top padding for pin space
  - [ ] Multiple cards stack vertically with 20px gap

### 3. Red Pins (Critical Visual Element) ✓
- **CSS Rule**: `.h-panel[data-place="board"] .board-content > div::before`
- **What to check**:
  - [ ] Each paper card has a red circular pin at the top center
  - [ ] Pin color is #d84c3c (deep red)
  - [ ] Pin size is 16x16px
  - [ ] Pin is positioned 10px above the card (-10px top)
  - [ ] Pin is centered horizontally (left: 50%, translateX(-50%))
  - [ ] Pin has a 3D depth effect with inset shadow
  - [ ] Pin appears on ALL direct children of .board-content (summary, tabs, grid sections)

### 4. Grid Content Area
- **CSS Rules**: `.codex-grid`, `.record-list`, `.feedback-panel`, `.logs-panel`
- **What to check**:
  - [ ] Grids have white background (#fff)
  - [ ] Grids have 14px padding
  - [ ] Grids have 6px border-radius for rounded corners
  - [ ] Grids have subtle shadow (0 3px 6px rgba(0,0,0,.12))
  - [ ] Items are properly spaced within grids

---

## Tab-Specific Verifications

### Board Codex (图鉴)
- [ ] Summary section (caught count / total entries / catch total) appears as paper card with pin
- [ ] Category tabs (鱼类/材料/组件/钓点) appear as paper card with pin
- [ ] Item grid appears as nested paper card with pin
- [ ] All three sections have red pins at top

### Board Records (记录)
- [ ] Hero record section (最新播报/全场最大) appears as paper card with pin
- [ ] Record grid appears as paper card with pin
- [ ] Each record cell displays fish icon and stats properly

### Board Logs (日志)
- [ ] Log filter tabs appear as paper card with pin
- [ ] Log entries appear as paper card with pin
- [ ] Footer info appears as paper card with pin

### Board Feedback (反馈)
- [ ] Feedback form/display appears as paper card with pin
- [ ] Submission status appears clearly

---

## Responsive & Layout Tests

- [ ] Board displays correctly on desktop (1200px+ width)
- [ ] Board displays correctly on tablet (768px-1199px)
- [ ] Board displays correctly on mobile (under 768px)
- [ ] Cork background remains visible and doesn't crop
- [ ] Paper cards maintain layout and pins are visible
- [ ] Pins stay centered on paper cards at all breakpoints

---

## Browser Compatibility

- [ ] Chrome/Edge (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest on macOS/iOS)
- [ ] Mobile browsers (Chrome Mobile, Safari iOS)

---

## Color Accuracy Checklist

| Element | Expected Color | Actual Color | Status |
|---------|---|---|---|
| Cork background | #d4c4a8 | ? | [ ] |
| Paper card bg | #f5f1ed | ? | [ ] |
| Paper card border | #e8dfd4 | ? | [ ] |
| Red pin | #d84c3c | ? | [ ] |
| Grid content bg | #fff | ? | [ ] |

---

## Implementation Status

### CSS Completed ✓
- [x] Cork background styling
- [x] Paper card wrapper styling
- [x] Red pin pseudo-element (::before)
- [x] Grid content styling
- [x] Shadow & border effects

### Still To Verify
- [ ] Visual rendering in browser
- [ ] Pin appearance on all card sections
- [ ] Color accuracy matching design reference
- [ ] Shadow depth and contrast
- [ ] Responsive behavior
- [ ] Cross-browser compatibility

---

## Testing Instructions

### Manual Visual Testing
1. Start the dev server: `npm run wiki:serve` (frontend only)
2. Open `http://localhost:5500` in browser
3. Press F3 to open the board panel
4. Navigate through each tab (图鉴 → 记录 → 日志 → 反馈)
5. Verify each checklist item above
6. Test responsive behavior with browser dev tools
7. Compare with reference design at `output/design-review/redesign/v2/index.html`

### Automated Visual Testing (Future)
- [ ] Set up Playwright/Puppeteer visual regression tests
- [ ] Compare board screenshots against reference baseline
- [ ] Add color sampling tests for CSS values
- [ ] Add responsive layout tests

---

## Known Issues & Workarounds

None yet - to be filled in during testing phase.

---

## Sign-Off

**Phase 2 Complete When:**
- All visual elements verified visually in browser
- Colors match reference design
- Pins appear on all card sections
- Responsive layout works correctly
- No regressions in other panels

**Verified By**: [To be filled]
**Date**: [To be filled]
**Browser**: [To be filled]
