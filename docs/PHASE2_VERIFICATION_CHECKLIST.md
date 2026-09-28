# Phase 2: Visual Verification Checklist
**Status:** In Progress  
**Date Started:** 2026-09-28  
**Reference Location:** `output/design-review/redesign/v2/shots/`

---

## Overview

Phase 2 involves comparing the current implementation against reference screenshots to ensure pixel-perfect compliance. Each functional page has corresponding reference images (a-room-*.png, b-room-*.png, c-room-*.png).

**Legend:**
- ✅ Verified compliant
- 🔶 Needs minor adjustment
- ❌ Major gap found
- ⏳ Pending verification

---

## Page-by-Page Verification Matrix

### 1. Fishing Page (栈桥) - `a-room-fishing.png`
**Priority:** Medium  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Map background rendering matches design
- [ ] Spot pins positioned correctly
- [ ] Last spot indicator (📍) visible and styled
- [ ] Locked spot display (🔒) matches
- [ ] Continue button text and layout
- [ ] Top HUD status display (HP/stamina/time)
- [ ] Bottom action buttons layout

**Reference Files:**
- Desktop: `a-room-fishing.png`, `b-room-fishing.png`, `c-room-fishing.png`
- Mobile: `a-phone-room.png`

**Acceptance Criteria:**
- Map fits within panel bounds with no overflow
- All interactive elements have proper hover states
- Tooltip on hover shows location name
- Button click handler works correctly

**Notes:**
- Verify map SVG scales properly for panel size
- Check touch targets on mobile (min 48px)

---

### 2. Inventory Page (仓库) - `a-room-inventory.png`
**Priority:** High  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Grid layout is exactly 8 items per row (desktop)
- [ ] Item cards have correct rarity borders (common/rare/epic/mythic)
- [ ] Search bar position and styling
- [ ] Sort dropdown layout and options
- [ ] View toggle (grid/list) buttons
- [ ] Detail panel on right side (desktop) or below (mobile)
- [ ] Capacity bar positioning and styling
- [ ] Tab navigation (全部/鱼类/材料/宝匣/组件)

**Reference Files:**
- Desktop: `a-room-inventory.png`, `b-room-inventory.png`, `c-room-inventory.png`
- Mobile: `a-phone-room.png`

**Acceptance Criteria:**
- Grid maintains 8 columns at desktop width (minimum)
- Item gaps/margins are consistent
- Empty slots properly complete rows
- Detail card shows all required fields:
  - Item name and rarity indicator
  - Count/quantity
  - Description text
  - Buttons if applicable

**Measurements to Verify:**
- Grid gap: 6px between items
- Item card size: 58×58px
- Detail panel width: 340px (desktop)

**Notes:**
- Check responsive behavior at common breakpoints
- Verify search doesn't break grid layout
- Confirm tab switching updates grid correctly

---

### 3. Workshop Page (工坊) - `a-room-workshop.png`
**Priority:** High  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Tab navigation with hanging signs (tabs 0-3)
- [ ] Tab 0 (Bench): 3 bench cards layout
- [ ] Tab 1 (Growth): Equipment growth circular path visualization
- [ ] Tab 1 (Growth): Component selector grid
- [ ] Tab 2 (Sets): Set cards with progress bars
- [ ] Tab 3 (Smelt): Smelting interface (if present)
- [ ] All tab content fits within panel height

**Reference Files:**
- Desktop: `a-room-workshop.png`, `b-room-workshop.png`, `c-room-workshop.png`
- Growth detail: `a-room-growth.png`, `b-room-growth.png`, `c-room-growth.png`

**Acceptance Criteria:**
- Tab 0: 3 bench cards arranged in 1×3 or 2+1 layout
- Tab 1: Circular upgrade path with node spacing
- Tab 1: Component grid shows at least 12 items visible
- Tab 2: Set cards have progress bar with percentage
- All tabs have clear labels and icons
- No content cut off when scrolling

**Measurements to Verify:**
- Tab height: 52px with 2px rope indicators
- Bench card width: ≤ (panel-width / 3)
- Circular path diameter: Fits in available space

**Notes:**
- Modern GearUI is more advanced than prototype - compare functionality not pixel-perfect appearance
- Verify component picker filtering works
- Check milestone tracking (副属性/精工/满级/绑定)

---

### 4. Chest Page (宝匣) - `a-room-chest.png`
**Priority:** Medium  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Chest card grid layout (number of columns matches design)
- [ ] Rarity border colors on chest cards
- [ ] Opening animation (shake effect) plays smoothly
- [ ] Reward flash overlay displays correctly
- [ ] Crafting tab content (if present)
- [ ] Progress/level display on cards

**Reference Files:**
- Desktop: `a-room-chest.png`, `b-room-chest.png`, `c-room-chest.png`

**Acceptance Criteria:**
- Chest cards display with correct rarity styling
- Opening animation respects motion preferences
- Reward flash doesn't obscure close button
- Mobile layout shows single column

**Notes:**
- Verify animation doesn't stutter
- Check that opened chests show different visual state
- Confirm crafting ingredients display correctly

---

### 5. Mall Page (集市) - `a-room-mall.png`
**Priority:** High  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Tab navigation (Limited/Buyback/Market tabs)
- [ ] Limited items section with refresh timer
- [ ] Stock counter on each item
- [ ] Buyback section with trend arrows (▲/▼)
- [ ] Market section with player listings
- [ ] Player avatar display in market listings
- [ ] Price displays with currency symbol
- [ ] "Sold" banner appearance when applicable

**Reference Files:**
- Desktop: `a-room-mall.png`, `b-room-mall.png`, `c-room-mall.png`

**Acceptance Criteria:**
- Tab 0 (Limited): Refresh timer visible and counting down
- Tab 0: Item grid shows 4-6 items per row (desktop)
- Tab 1 (Buyback): Trend arrows color-coded (green up, red down)
- Tab 2 (Market): Player avatars displayed
- Tab 2: Search/sort functionality works
- Price columns align properly
- Sold item banner has [收下] claim button

**Measurements to Verify:**
- Limited item card width: 140px (approx)
- Trend arrow colors: Green #4ade80, Red #f87171
- Avatar size: 32×32px

**Notes:**
- Verify trend calculation (price diff display)
- Check that sold items move to different section
- Confirm claim button functionality

---

### 6. Tavern Page (酒馆/Ground) - `a-room-ground.png`
**Priority:** Medium  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Tab navigation (Online/Friends/Party tabs)
- [ ] Player card grid layout
- [ ] Avatar display on cards
- [ ] Online status indicator
- [ ] Player name and level display
- [ ] Friend request button layout
- [ ] Party status display
- [ ] Feed section if present

**Reference Files:**
- Desktop: `a-room-ground.png`, `b-room-ground.png`, `c-room-ground.png`

**Acceptance Criteria:**
- Player cards display in grid (3-4 per row desktop)
- Avatar images load correctly
- Online status clearly indicated (green dot/icon)
- Friend request buttons have proper hover state
- Tab switching updates player list correctly
- Feed messages display with timestamps

**Notes:**
- Verify real-time updates when players come online
- Check friend request success feedback
- Confirm party member indicators work

---

### 7. Voyage Page (远洋码头/Sea) - `a-room-sea.png`
**Priority:** Medium  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Map SVG renders correctly
- [ ] Ship icon displays and animates along route
- [ ] Progress bar shows voyage completion %
- [ ] Waypoint markers visible on map
- [ ] Upgrade tab shows ship level and stats
- [ ] Timer display for journey ETA
- [ ] Beacon lighthouse forced on during voyage

**Reference Files:**
- Desktop: `a-room-sea.png`, `b-room-sea.png`, `c-room-sea.png`

**Acceptance Criteria:**
- Map fits within panel bounds with no overflow
- Ship animates smoothly (bezier interpolation)
- Progress bar reflects actual completion %
- Waypoints are clickable (or display info on hover)
- Mobile map includes horizontal scroll affordance
- Lighthouse beacon state synced with voyage status

**Measurements to Verify:**
- Map viewport: Takes up 60-70% of panel height
- Progress bar height: 10px
- Ship icon size: 32×32px

**Notes:**
- Verify animation frame rate is smooth (60fps)
- Check that route bezier curve is visible
- Confirm ETA updates in real-time

---

### 8. Board Page (告示板) - `a-room-board.png`
**Priority:** Critical  
**Current Status:** Partial (cork background implemented)

**Visual Elements to Verify:**
- [x] Cork background color (#d4c4a8) displays
- [ ] White paper card styling visible
- [ ] Card shadows appear correctly
- [x] Tab navigation (4 tabs: 📖 图鉴 / 🏆 记录 / 📜 日志 / ✍ 反馈)
- [ ] Tab content renders correctly for each sub-view
- [ ] Hanging sign style on tabs
- [ ] Active tab indicator (cyan color, text color change)

**Sub-pages to Verify:**

#### 8a. Codex (图鉴) Tab
- [ ] Fish grid layout (6-8 per row)
- [ ] Rarity color indicators on fish cards
- [ ] Collection summary stats display
- [ ] Category subtabs (鱼类/材料/组件/钓点)

#### 8b. Records (记录) Tab
- [ ] Ranking table layout
- [ ] Player names and scores display
- [ ] Sorting functionality
- [ ] Medal/badge indicators for top ranks

#### 8c. Logs (日志) Tab
- [ ] Activity feed display
- [ ] Timestamps visible
- [ ] User actions logged correctly
- [ ] Pagination or infinite scroll working

#### 8d. Feedback (反馈) Tab
- [ ] Form layout with title/content fields
- [ ] Submit button styling
- [ ] Submitted feedback list display
- [ ] Reply interface if applicable

**Reference Files:**
- Desktop: `a-room-board.png`, `b-room-board.png`, `c-room-board.png`

**Acceptance Criteria:**
- Cork background only appears on board panel (not other places)
- Paper cards have white background with 1px border
- Card shadows are subtle (0 4px 8px)
- Tab switching updates content without page reload
- All 4 tabs are accessible and functional
- Deep links work: `#/board/0`, `#/board/1`, `#/board/2`, `#/board/3`

**Measurements to Verify:**
- Cork bg color: #d4c4a8
- Paper card border: 1px #ddd
- Card box-shadow: 0 4px 8px rgba(0,0,0,.15)
- Card padding: 16px 20px
- Card margin-bottom: 14px

**Notes:**
- Already implemented cork background in Phase 1
- Need to verify paper card styling applies to all content
- Confirm badge display on tabs (unread counts)

---

### 9. Mail Page (邮筒) - `a-room-mail.png`
**Priority:** Medium  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Envelope list layout
- [ ] Unread indicator (red dot/wax seal)
- [ ] Read vs unread visual distinction
- [ ] Sender name and subject preview
- [ ] Date/time display
- [ ] Letter detail view when selected
- [ ] Attachment chips display
- [ ] Claim all button position and styling

**Reference Files:**
- Desktop: `a-room-mail.png`, `b-room-mail.png`, `c-room-mail.png`

**Acceptance Criteria:**
- Envelope cards show unread wax seal (red circle)
- Selected envelope detail appears below or beside
- Attachments display as chips with item icons
- Claim button works and updates state
- Delete button removes mail from list
- "Claim All" button claims all attachments at once

**Notes:**
- Verify wax seal animation if present
- Check that read status persists
- Confirm attachment icons match item rarity

---

### 10. Character Page (渔屋) - `a-room-character.png`
**Priority:** Low  
**Current Status:** Not started

**Visual Elements to Verify:**
- [ ] Header displays "🏠 渔屋 Lv.X · 地点" format
- [ ] Tab navigation (yard/pet/role/rod tabs)
- [ ] Yard tab: Income display and upgrade cards
- [ ] Yard tab: 2-column split (60/40 layout)
- [ ] Pet tab: Pet cards with level/happiness
- [ ] Role tab: Avatar customization with color swatches
- [ ] Rod tab: Gear summary display

**Reference Files:**
- Desktop: `a-room-character.png`, `b-room-character.png`, `c-room-character.png`

**Acceptance Criteria:**
- Yard tab shows daily income collection
- Upgrade cards are clickable (or show disabled state)
- Pet management interface shows current pet status
- Avatar customization allows color selection
- Rod tab displays all equipped gear with stats
- Tab switching updates content correctly

**Layout Details:**
- Yard tab left column (60%): Collection/income info
- Yard tab right column (40%): Upgrade options
- Mobile: Stacked layout (100% width)

**Notes:**
- Verify income auto-collection timer
- Check pet happiness decrease over time
- Confirm avatar color changes apply immediately
- Verify gear stats calculations

---

## Cross-Page Verification

### General Layout Requirements
- [ ] Panel header (plank) displays correctly on all pages
- [ ] Back button (← or ←H-back) visible and functional
- [ ] Close button (×) visible in top right
- [ ] Panel fits within 3% inset margins (desktop)
- [ ] Mobile: Panel extends full width with 3px top border
- [ ] All content scrollable if exceeds panel height
- [ ] Tab switching animations smooth

### Responsive Behavior (Mobile Testing)
- [ ] All pages render at 640px width
- [ ] Grid layouts switch to single/double column
- [ ] Buttons remain touchable (min 48×48px)
- [ ] Horizontal scrolling not needed (no overflow)
- [ ] Top padding accommodates safe-area-inset
- [ ] Bottom padding removed (harbor HUD below)

### Interactive States
- [ ] Hover states work on desktop (color/underline changes)
- [ ] Focus states visible (outline or highlight)
- [ ] Disabled buttons show reduced opacity (0.45)
- [ ] Active/selected indicators clear
- [ ] Loading states (spinners/disabled) functional

### Accessibility
- [ ] Tab order logical (tab key navigation)
- [ ] ARIA labels present on buttons
- [ ] Form inputs have associated labels
- [ ] Color not sole indicator of state
- [ ] Keyboard navigation works (Enter/Space to activate)

### Motion Preferences
- [ ] Animations respect `prefers-reduced-motion`
- [ ] `[data-motion="reduced"]` or `[data-motion="off"]` removes animations
- [ ] Content still functional without animations

---

## Testing Environment Setup

**Browser Testing:**
- [ ] Chrome/Chromium (latest)
- [ ] Firefox (latest)
- [ ] Safari (if on macOS)
- [ ] Edge (if on Windows)

**Device Testing:**
- [ ] Desktop (1920×1080 or similar)
- [ ] Tablet (768×1024)
- [ ] Mobile (375×667)
- [ ] Landscape mobile (667×375)

**Time of Day Testing:**
- [ ] Dawn colors (#0d2138)
- [ ] Day colors (brighter)
- [ ] Dusk colors (warm)
- [ ] Night colors (#081426)

**Color Scheme Testing:**
- [ ] Light mode (if supported)
- [ ] Dark mode (default)
- [ ] High contrast mode

---

## Issue Tracking Template

For each issue found, use this template:

```
### Issue #X: [Brief Title]
**Page:** [Fishing/Inventory/etc]
**Severity:** [Critical/High/Medium/Low]
**Current Behavior:** [What is happening]
**Expected Behavior:** [What should happen per design]
**Reference:** [Screenshot file, line number]
**Reproduction Steps:**
1. [Step 1]
2. [Step 2]

**Possible Cause:** [Likely CSS/JS issue]
**Fix Priority:** [Before/After release]
```

---

## Sign-Off Criteria

Phase 2 is **complete** when:

- [ ] All 10 pages verified against reference screenshots
- [ ] No Critical or High severity issues remaining
- [ ] All Medium issues have mitigation plan or low priority rating
- [ ] Mobile responsive tested at 375px, 640px, 768px widths
- [ ] Accessibility checklist passed
- [ ] All deep links working (#/board/0, etc)
- [ ] Badge updates working (workshop, mail, board)
- [ ] Animation performance verified (60fps)
- [ ] Cross-browser testing passed (at least 2 browsers)

---

## Progress Tracking

| Page | Status | Issues Found | Priority | Est. Fix Time |
|------|--------|--------------|----------|---------------|
| Fishing | ⏳ Pending | - | Medium | - |
| Inventory | ⏳ Pending | - | High | - |
| Workshop | ⏳ Pending | - | High | - |
| Chest | ⏳ Pending | - | Medium | - |
| Mall | ⏳ Pending | - | High | - |
| Tavern | ⏳ Pending | - | Medium | - |
| Voyage | ⏳ Pending | - | Medium | - |
| Board | 🔶 Partial | Cork done | Critical | 1-2h |
| Mail | ⏳ Pending | - | Medium | - |
| Character | ⏳ Pending | - | Low | - |

**Overall Progress:** 10% (Board cork background implemented, paper cards pending)

---

## Next Steps

1. Start with Board page (cork background already done, need paper card verification)
2. Move to High-priority pages (Inventory, Workshop, Mall)
3. Proceed with Medium-priority pages
4. Finish with Low-priority pages
5. Do cross-page verification and accessibility audit
6. Document all issues and create PRs for fixes

---

**End of Phase 2 Verification Checklist**
