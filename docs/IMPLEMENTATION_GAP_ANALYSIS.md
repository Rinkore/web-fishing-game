# DeepFish Harbor v2 - Implementation Gap Analysis

**Date:** 2026-09-28  
**Design Reference:** `output/design-review/redesign/v2/index.html` Section 8  
**Current Implementation:** `frontend/js/ui.js`, `frontend/js/mail.js`, `frontend/js/house.js`

---

## Executive Summary

The current implementation has all 10 functional pages present, but several need adjustments to match the v2 design doc specifications pixel-perfectly. This document identifies specific gaps and provides implementation priorities.

---

## Gap Analysis by Page

### ✅ 1. Harbor Shell (Frame/HUD/Panel)
**Status:** COMPLETE (Phase G finished per memory)  
**Files:** `frontend/js/harbor.js`, `frontend/css/harbor.css`

**Design Compliance:**
- ✅ Panel frame with wood plank header
- ✅ HUD top/bottom with correct styling
- ✅ Tab navigation (hanging sign style)
- ✅ Breadcrumb support (`港湾 › Place › Tab`)
- ✅ Desktop 3% inset, mobile full width
- ✅ Panel animation (220ms ease-out)

**No gaps identified** - shell is complete per Phase G.

---

### ✅ 2. Fishing Page (栈桥)
**Status:** COMPLETE  
**File:** `frontend/js/ui.js:1495` (renderFishing)

**Design Compliance:**
- ✅ Map with spot pins
- ✅ Last spot highlighting with 📍
- ✅ Locked spots with 🔒 icon
- ✅ Continue button with last spot name
- ✅ Toast notifications

**No gaps identified** - matches spec.

---

### 🔶 3. Inventory Page (仓库)
**Status:** MOSTLY COMPLETE - Minor styling gaps  
**File:** `frontend/js/ui.js:7105` (renderInventory)

**Current Implementation:**
- ✅ Tab system (全部/鱼类/材料/宝匣/组件)
- ✅ Search and sort functionality
- ✅ Grid layout with rarity borders
- ✅ Detail card with stats
- ✅ Capacity bar

**Gaps to Fix:**
1. **Layout verification**: Ensure grid is exactly 8 items per row on desktop
2. **Toolbar layout**: Verify search/sort/view toggle positioning matches prototype
3. **Detail card layout**: Verify kv pairs and button layout match `a-room-inventory.png`
4. **Empty slot styling**: Ensure empty slots complete grid rows properly

**Priority:** LOW - Functional, minor visual adjustments needed

---

### 🔶 4. Workshop Page (工坊)
**Status:** MOSTLY COMPLETE - Tab 1 needs verification  
**File:** `frontend/js/ui.js:9133` (renderWorkshop)

**Current Implementation:**
- ✅ Tab system with hanging signs
- ✅ Smelting tab (Tab 3 in spec = current smelt tab)
- ✅ Gear growth integration

**Gaps to Fix:**
1. **Tab 0 (Bench Overview)**: Verify 3 bench cards layout matches prototype
2. **Tab 1 (Equipment Growth)**: The current gear growth may need 7-part circular layout verification
3. **Tab 2 (Gear Sets)**: Verify set cards display with progress bars

**Priority:** MEDIUM - Core functionality exists, visual layout needs verification

---

### ✅ 5. Chest Page (宝匣)
**Status:** COMPLETE  
**File:** `frontend/js/ui.js:8709` (renderChest)

**Design Compliance:**
- ✅ Chest cards with rarity borders
- ✅ Opening animation (shake effect)
- ✅ Reward flash integration
- ✅ Crafting tab

**No gaps identified** - matches spec.

---

### 🔶 6. Mall Page (集市)
**Status:** MOSTLY COMPLETE - Tab verification needed  
**File:** `frontend/js/ui.js:9801` (renderMall)

**Current Implementation:**
- ✅ Multiple tabs (shop/buyback/market)
- ✅ Limited items with stock tracking
- ✅ Player listings

**Gaps to Fix:**
1. **Tab 0 (Limited Stock)**: Verify refresh timer display
2. **Tab 1 (Buyback)**: Verify trend arrows (▲/▼) display
3. **Tab 2 (Market)**: Verify player avatar display in listings
4. **Sold item banner**: Check if banner with [收下] button exists

**Priority:** MEDIUM - Verify visual elements match prototype

---

### ✅ 7. Tavern Page (酒馆/Ground)
**Status:** COMPLETE  
**File:** `frontend/js/ui.js:3753` (renderGround)

**Design Compliance:**
- ✅ Player cards with avatars
- ✅ Online/Friends/Party tabs
- ✅ Friend request handling
- ✅ Feed display

**No gaps identified** - matches spec.

---

### 🔶 8. Voyage Page (远洋码头/Sea)
**Status:** NEEDS VERIFICATION  
**File:** `frontend/js/ui.js:10751` (renderSea)

**Current Implementation:**
- ✅ Voyage system with map
- ✅ Ship upgrade tab

**Gaps to Fix:**
1. **Map layout**: Verify SVG route path with ship animation
2. **Progress visualization**: Check ship position interpolation along bezier curve
3. **Lighthouse state sync**: Verify harbor beacon forced on during voyage

**Priority:** MEDIUM - Core works, visual sync needs verification

---

### 🔶 9. Board Page (告示板)
**Status:** SPECIAL CASE - Multiple sub-pages  
**Files:** `frontend/js/ui.js` (renderCodex:9920, renderRecords:10188, renderFeedback:10294, renderLogs:10461)

**Current Implementation:**
- ✅ Codex page with fish grid
- ✅ Records page with rankings
- ✅ Feedback page with submission form
- ✅ Logs page with activity feed

**Gaps to Fix:**
1. **Cork background**: May need to add `.cork` background styling
2. **Paper card styling**: Verify white card styling with shadows
3. **Tab integration**: These are separate views but board should show them as tabs per v3 F3

**Priority:** HIGH - Requires tab integration per v3 F3 decision

**Note from memory:** v3 F3 changed board from overlay to panel tabs. Current implementation has separate views (codex/records/logs/feedback) that need to be presented as tabs under one board panel.

---

### ✅ 10. Mail Page (邮筒)
**Status:** COMPLETE  
**File:** `frontend/js/mail.js`

**Design Compliance:**
- ✅ Envelope list with unread dots
- ✅ Letter detail view
- ✅ Attachment chips
- ✅ One-click claim all
- ✅ Wax seal visual (likely CSS)

**No gaps identified** - modern implementation matches spec.

---

### 🔶 11. Character Page (渔屋)
**Status:** MOSTLY COMPLETE - Needs verification  
**Files:** `frontend/js/ui.js:8140` (renderCharacter), `frontend/js/house.js`

**Current Implementation:**
- ✅ 4 tabs (yard/pet/role/rod)
- ✅ Income collection system (yard tab)
- ✅ Pet management (pet tab)
- ✅ Avatar customization (role tab)
- ✅ Gear summary (rod tab)

**Gaps to Fix:**
1. **Scene header**: Verify "🏠 渔屋 Lv.X · 地点" header format
2. **2-column split**: Verify yard tab income/upgrade box split (60/40)
3. **Avatar picker layout**: Verify color swatch positioning

**Priority:** LOW - Functional, minor layout verification

---

## Priority Implementation Plan

### Phase 1: Critical (Board Tab Integration) 🔴
**Estimated Effort:** 4-6 hours

The v3 F3 decision requires board (codex/records/logs/feedback) to appear as tabs within one panel, not separate views. This is the biggest structural gap.

**Tasks:**
1. Create unified board panel container
2. Add tab navigation for 4 sub-pages
3. Update routing to handle `#/board/0` through `#/board/3`
4. Add cork background styling
5. Style papers as white cards with shadows
6. Update navigation metadata to treat board as single place

**Files to modify:**
- `frontend/js/harbor.js` - Add board to PLACES, handle board tab routing
- `frontend/js/ui.js` - Create renderBoard() wrapper, integrate sub-pages as tabs
- `frontend/css/harbor.css` - Add cork background and paper card styles

---

### Phase 2: Medium Priority (Visual Verification) 🟡
**Estimated Effort:** 2-3 hours

Verify and adjust layouts to match reference screenshots pixel-perfectly.

**Tasks:**
1. Workshop: Verify bench overview and part circle layout
2. Mall: Add trend arrows, verify avatar display
3. Voyage: Verify map SVG and ship animation
4. Inventory: Verify toolbar and detail card exact spacing

**Files to modify:**
- `frontend/js/ui.js` - Minor layout adjustments in render functions
- `frontend/css/style.css` - Spacing/sizing adjustments as needed

---

### Phase 3: Low Priority (Polish) 🟢
**Estimated Effort:** 1-2 hours

Minor visual polish to achieve pixel-perfect match.

**Tasks:**
1. Character page header format verification
2. Inventory empty slot styling
3. Final screenshot comparison pass

---

## Testing Checklist

After implementation, verify against:

1. **Reference screenshots** (`a-room-*.png`, `b-room-*.png`, `c-room-*.png`)
2. **Design doc Section 8** specifications
3. **Acceptance criteria** from ACCEPTANCE_SPEC_INTERIORS.md
4. **Deep links**: `#/place/tab` format works for all pages
5. **Mobile layout**: All pages work at mobile width
6. **State synchronization**: Badge updates (workshop smelt, mail unread, etc.)

---

## Implementation Notes

1. **Prototype vs Production**: The `harbor-rooms.js` file in the design review folder is prototype code. Production pages keep their existing logic from `ui.js` while matching the visual spec.

2. **CSS Inheritance**: Harbor CSS provides the frame. Interior content uses existing component styles (`.panel`, `.inv-cats`, `.kv`, etc.)

3. **No Breaking Changes**: All modifications should be additive or refinements. Existing functionality must continue working.

4. **Memory Context**: Per `harbor-v3-decisions.md`, Phase G is complete (classic removed, renderNav migrated). We're now in polish/acceptance phase.

---

## Recommendation

**Start with Phase 1 (Board Tab Integration)** as it's the most significant structural change required to match the v3 F3 design decision. The board integration affects navigation flow and is a prerequisite for full acceptance testing.

After board integration, proceed with visual verification passes (Phase 2-3) using the reference screenshots as ground truth.

---

**End of Gap Analysis**
