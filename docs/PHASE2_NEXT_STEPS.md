# Phase 2 Visual Verification - Next Steps

**Date:** 2026-09-28  
**Current Status:** Board page complete (1/10 pages verified)

---

## ✅ Completed Today

### Board Page Implementation
- Fixed CSS selector mismatch (`.board-content > div` → `.board-card, .board-paper`)
- Added paper wrapper to logs tab
- Added paper wrapper to feedback tab
- Simplified paper card styling (removed over-designed pushpin)
- All 4 tabs now have consistent white paper cards over cork background

**Result:** Board page matches design spec AC-BRD-02 and AC-BRD-03

---

## 🎯 Next Session Tasks

### Priority 1: Inventory Page Verification
**File:** `frontend/js/ui.js:7105` (renderInventory)  
**Reference:** `output/design-review/redesign/v2/a-room-inventory.png`

**Checklist:**
- [ ] Open `#/inventory` in browser
- [ ] Count grid columns (must be 8 items per row on desktop)
- [ ] Screenshot toolbar (search/sort/view toggle) and compare
- [ ] Click an item and verify detail card layout matches reference
- [ ] Check empty slot styling completes grid rows
- [ ] Test all 5 tabs: 全部/鱼类/材料/宝匣/组件

**Expected Issues:** Minor spacing/alignment tweaks likely needed

---

### Priority 2: Workshop Page Verification
**File:** `frontend/js/ui.js:9133` (renderWorkshop)  
**Reference:** `output/design-review/redesign/v2/a-room-workshop.png`

**Checklist:**
- [ ] Tab 0 (Bench Overview): Verify 3 bench cards layout
- [ ] Tab 1 (Gear Growth): Verify 7-part circular layout exists
- [ ] Tab 2 (Smelting): Verify queue display and timer
- [ ] Check hanging sign tab styling consistency

**Expected Issues:** Tab 0 bench cards may need layout adjustment

---

### Priority 3: Mall Page Verification
**File:** `frontend/js/ui.js:9801` (renderMall)  
**Reference:** `output/design-review/redesign/v2/a-room-mall.png`

**Checklist:**
- [ ] Tab 0 (Limited): Verify refresh timer display format
- [ ] Tab 1 (Buyback): **Verify trend arrows (▲/▼) appear**
- [ ] Tab 2 (Market): Verify player avatars show in listings
- [ ] Check for sold item banner with [收下] button

**Expected Issues:** Trend arrows may be missing or styled incorrectly

---

## 📋 Verification Protocol

For each page:

1. **Open in browser** with Harbor mode enabled (`?harbor=1` or settings)
2. **Navigate to page** using deep link (e.g., `#/inventory`)
3. **Take screenshots** of each tab state
4. **Side-by-side compare** with reference image from `output/design-review/redesign/v2/`
5. **Document gaps** in a `PHASE2_[PAGE]_GAPS.md` file
6. **Fix gaps** if they're CSS or minor JS changes (< 30 lines)
7. **Re-verify** after fixes
8. **Mark complete** when visual match is confirmed

---

## 🔧 Fix Guidelines

### When to fix immediately:
- Pure CSS changes (spacing, colors, borders)
- Missing classes or wrappers (like today's paper cards)
- Simple conditional rendering fixes

### When to defer:
- Structural logic changes (> 50 lines)
- New features not in current implementation
- Breaking changes that need testing

### How to document:
- Create `PHASE2_[PAGE]_GAPS.md` with screenshots
- List each gap with line numbers
- Prioritize: CRITICAL / MEDIUM / MINOR
- Track fixes in git commits

---

## 📊 Progress Tracking

Update `IMPLEMENTATION_GAP_ANALYSIS_UPDATED.md` after each page:

```markdown
1. ✅ Board Page - COMPLETE (2026-09-28)
2. ✅ Inventory Page - COMPLETE (date)
3. ✅ Workshop Page - COMPLETE (date)
...
```

---

## 🎬 Session Startup Command

```bash
# Open design reference in browser
start output/design-review/redesign/v2/index.html

# Start local dev server if needed
npm run dev

# Open harbor in browser
start http://localhost:3000/?harbor=1#/inventory
```

---

## ⏱️ Time Estimates

| Page | Verification | Fixes | Total |
|------|--------------|-------|-------|
| Inventory | 15 min | 30 min | 45 min |
| Workshop | 20 min | 45 min | 65 min |
| Mall | 15 min | 30 min | 45 min |
| Voyage | 20 min | 30 min | 50 min |
| Character | 15 min | 20 min | 35 min |
| Quick checks (3 pages) | 15 min | 0 min | 15 min |
| **Total** | **2 hours** | **3 hours** | **5 hours** |

---

## 📝 Notes

- Board page took ~2 hours including investigation and documentation
- Following pages should be faster with established protocol
- Some pages (Fishing, Tavern, Mail) likely need no changes
- Focus on high-priority visual elements first (layout, critical UI)
- Polish passes (exact spacing, colors) can come after all pages verified

---

**Ready to continue with Inventory page verification!**
