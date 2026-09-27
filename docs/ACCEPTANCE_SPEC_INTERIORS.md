# DeepFish Harbor v2 - Functional Pages Acceptance Specification

**Document Version:** 1.0  
**Design Reference:** `output/design-review/redesign/v2/index.html` Section 8  
**Screenshot Reference:** `output/design-review/redesign/v2/shots/a-room-*.png`  
**Status:** Ready for Implementation Review

---

## Overview

This document specifies acceptance criteria for all 10 functional interior pages in the Harbor v2 interface. Each page must match the design doc specifications and reference screenshots pixel-perfectly within the harbor panel frame.

### Design Principles (from §8)

All interiors:
- Host inside the **h-panel** frame with wood plank header
- Use **pixel font** (12px/24px) for headers and UI chrome
- Use **system font** (14px) for body text and descriptions
- Maintain **responsive layout** (desktop: inset 3%, mobile: full width)
- Support **tab navigation** where specified (hanging sign style)
- Display **breadcrumbs** in format: `港湾 › [Place] › [Tab]`

---

## 1. 仓库 (Inventory / Bag)

### Layout Structure
```
┌─────────────────────────────────────┐
│ ← 回港湾    📦 仓库    ✕           │ ← Plank header
├─────────────────────────────────────┤
│ [Tabs: 全部 鱼类 材料 宝匣 组件]    │
│ [Search input] [Sort dropdown]      │
│ [格子] [列表]                       │
├──────────────────┬──────────────────┤
│ [8×N Item Grid]  │ [Detail Card]    │
│                  │  - Icon (big)    │
│                  │  - Name (rarity) │
│                  │  - Stats (kv)    │
│                  │  - Actions       │
├──────────────────┴──────────────────┤
│ 已用 X/120 格 [▓▓▓░░] [⚡一键出售]│
│ ⓘ 出售与上架规则 (折叠)            │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-INV-01**: Toolbar contains search input (placeholder: "搜索名称"), sort dropdown (品质/数量/价格), view toggles (格子/列表)
✅ **AC-INV-02**: Grid displays 8 items per row on desktop, auto-fills empty slots to complete rows
✅ **AC-INV-03**: Each slot shows item icon + quantity badge, rarity border color (common/rare/epic/mythic)
✅ **AC-INV-04**: Selected slot highlights with `.sel` class
✅ **AC-INV-05**: Detail card shows: large icon, name (rarity colored), properties (品质/持有/体型/现价/小计), action buttons
✅ **AC-INV-06**: Fish items: "出售 1" / "全部出售" / "上架" buttons; Chest items: "去开箱" button
✅ **AC-INV-07**: Capacity bar shows used/total slots with percentage fill
✅ **AC-INV-08**: Collapsible rules section with ⓘ icon
✅ **AC-INV-09**: Tab counts match filtered items: `鱼类 12`, `材料 8`, etc.

### Visual Match
- Reference: `a-room-inventory.png`
- Grid spacing: 8px gap between slots
- Slot size: 64×64 with 3px rarity border
- Detail card: white box with 12px padding

---

## 2. 工坊 (Workshop)

### Layout Structure (3 Tabs)

**Tab 0: Bench Overview**
```
┌─────────────────────────────────────┐
│ ← 回港湾    ⚒ 工坊    ✕            │
├─────────────────────────────────────┤
│ [装备成长] [钓鱼套装] [熔炼]       │ ← Hanging tabs
├─────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │ [Icon] │ │ [Icon] │ │ [Icon] │   │
│ │ Title  │ │ Title  │ │ Title  │   │
│ │ Desc   │ │ Desc   │ │ Desc   │   │
│ │ Status │ │ Status │ │ Status │   │
│ └────────┘ └────────┘ └────────┘   │
└─────────────────────────────────────┘
```

**Tab 1: Equipment Growth (装备成长)**
```
┌─────────────────────────────────────┐
│        [7-Part Circle Map]          │
│   竿身  卷线器  线组  钩  饵       │
│        配件  护符                   │
│                                     │
│   Selected Part Details:            │
│   竿身 · +6 → +7                   │
│   钓速 +12% → +14%                 │
│   上钩率 +6% → +7%                 │
│                                     │
│   Cost: [航程凭证 2] [精工热量 12] │
│         [金币 1400]                │
│   [强化] [强化到 +10]              │
└─────────────────────────────────────┘
```

**Tab 2: Gear Sets (钓鱼套装)**
```
6 set cards in grid, each showing:
- Core item icons (2 pieces)
- Set name (colored if active)
- Progress: "2/2 · 已激活" or "1/2" or "0/2"
- Progress bar (gold if active)
```

**Tab 3: Smelting (熔炼)**
```
┌─────────────────────────────────────┐
│ [主组件] + [副组件] + [催化 ×2]    │
│     ↓           ↓         ↓         │
│                 → [产物]            │
│                                     │
│ [开始熔炼] or [取出产物] (if ready)│
│ ⓘ 熔炼完成后，港湾里的工坊会亮起「!」│
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-WS-01**: Tab 0 shows 3 bench cards with icons, titles, descriptions, status text
✅ **AC-WS-02**: Bench cards are clickable, navigate to respective tabs
✅ **AC-WS-03**: Tab 1 displays 7 parts in circular layout around center rod icon
✅ **AC-WS-04**: Each part slot shows: item icon, level (+6), part name, rarity border
✅ **AC-WS-05**: Selected part highlights, detail panel shows upgrade stats and costs
✅ **AC-WS-06**: Cost chips turn red when insufficient resources
✅ **AC-WS-07**: Tab 2 displays 6 set cards in 2-column grid
✅ **AC-WS-08**: Active sets show gold progress bar, epic name color
✅ **AC-WS-09**: Tab 3 shows forge slots in sequence: 主+副+催化→产物
✅ **AC-WS-10**: Smelting complete state shows "⚒ 熔炼完成" in gold, triggers harbor workshop glow

### Visual Match
- Reference: `a-room-workshop.png`, `a-room-growth.png`
- Part map: circular layout, 72px radius from center
- Part slots: 64×64 with rarity borders
- Bench cards: 160px width, 120px min-height

---

## 3. 宝匣 (Chests)

### Layout Structure
```
┌─────────────────────────────────────┐
│ ← 回港湾    🎁 宝匣    ✕            │
├─────────────────────────────────────┤
│ [开箱] [合成]                       │ ← Tabs
├─────────────────────────────────────┤
│ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │ [Chest]│ │ [Chest]│ │ [Chest]│   │
│ │  Name  │ │  Name  │ │  Name  │   │
│ │ 持有 ×3│ │ 持有 ×1│ │ 持有 ×0│   │
│ │ [开箱] │ │ [开箱] │ │ [开箱] │   │
│ └────────┘ └────────┘ └────────┘   │
│ ⓘ 开箱先摇三下，再按掉落品质播放光效│
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-CHT-01**: Tab 0 shows chest cards in grid (沉船/深潜/深渊/海王)
✅ **AC-CHT-02**: Each card: chest icon, name (rarity colored), quantity, open button
✅ **AC-CHT-03**: Open button disabled when quantity = 0
✅ **AC-CHT-04**: Chest border matches rarity color (rare/epic/mythic)
✅ **AC-CHT-05**: Opening animation: shake 3 times (650ms), then reward flash
✅ **AC-CHT-06**: Reward flash calls harbor.js `reward()` with icon, name, tier, message
✅ **AC-CHT-07**: Tab 1 (合成) shows crafting UI: recipe + progress bar + ingredients
✅ **AC-CHT-08**: Craft button disabled when ingredients insufficient

### Visual Match
- Reference: `a-room-chest.png`
- Card size: 180px width, rarity border 3px
- Shake animation: `.shake` class, 3 iterations @ 200ms each

---

## 4. 集市 (Mall)

### Layout Structure (3 Tabs)
```
┌─────────────────────────────────────┐
│ ← 回港湾    🏪 集市    ✕            │
├─────────────────────────────────────┤
│ [限购] [收购] [市集]                │
├─────────────────────────────────────┤
│ Tab 0: 🕒 限购 02:14:33 后刷新      │
│ [Card Grid: 4 items with stock bars]│
│                                     │
│ Tab 1: Buyback list with trends    │
│ Tab 2: Player listings with avatars│
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-MAL-01**: Tab 0 shows refresh timer and limited items (4-6 cards)
✅ **AC-MAL-02**: Each limited item: icon, name, stock "剩余 X/Y", progress bar, buy button
✅ **AC-MAL-03**: Buy button shows price or "已售罄" (disabled)
✅ **AC-MAL-04**: Tab 1 shows fish buyback list with dynamic prices and trend arrows (▲/▼)
✅ **AC-MAL-05**: Tab 2 shows player listings: avatar, seller name, item, price, buy button
✅ **AC-MAL-06**: Sold item banner appears at top: "💰 你的挂单「...」已售出，收入 X 金币"
✅ **AC-MAL-07**: Banner includes [收下] button that adds coins and removes banner

### Visual Match
- Reference: `a-room-mall.png`
- Limited items: 2-column grid on desktop
- Stock bar: width matches remaining/max ratio

---

## 5. 酒馆 (Tavern / Ground)

### Layout Structure (3 Tabs)
```
┌─────────────────────────────────────┐
│ ← 回港湾    🍺 酒馆    ✕            │
├─────────────────────────────────────┤
│ [在线] [好友] [组队]                │
├─────────────────────────────────────┤
│ Left: [Player Cards Grid]           │
│ Right: [Feed Box]                   │
│   📢 最新动态                        │
│   - 小张 在 灯塔礁 钓到...          │
│   - 老王 开出...                    │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-GRD-01**: Tab 0 splits into player cards (left) + feed box (right)
✅ **AC-GRD-02**: Player cards show: avatar, name, level, status, [加好友] [组队] buttons
✅ **AC-GRD-03**: Feed box lists recent activities (catches, chests, voyages, records)
✅ **AC-GRD-04**: Tab 1 shows friend request banner (if any) + friend cards
✅ **AC-GRD-05**: Friend request rows: avatar, name, level, [同意] [拒绝] buttons
✅ **AC-GRD-06**: Tab 2 shows 4-slot party grid with [+ 邀请队友] empty slots
✅ **AC-GRD-07**: Note: "编队最多 4 人，同钓场有上钩加成"

### Visual Match
- Reference: `a-room-ground.png`
- 2-column layout: 65% player cards, 35% feed
- Avatar: 64×64 pixel character sprite

---

## 6. 远洋码头 (Voyage / Sea)

### Layout Structure (2 Tabs)
```
┌─────────────────────────────────────┐
│ ← 回港湾    ⛵ 远洋码头    ✕        │
├─────────────────────────────────────┤
│ [远航] [船只]                       │
├─────────────────────────────────────┤
│ Left: [Voyage Map with route]       │
│   ⛵ Ship animates along path       │
│ Right: [Voyage Details]             │
│   Status + Timer + Loot + Actions   │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-SEA-01**: Tab 0 shows SVG voyage map with dotted route path
✅ **AC-SEA-02**: Ship icon positioned based on voyage progress (0-100%)
✅ **AC-SEA-03**: Detail box shows status: "船在港内" / "远航中 · [地点]" / "船已归港"
✅ **AC-SEA-04**: During voyage: countdown timer, progress bar, expected loot chips, [立即返航] button
✅ **AC-SEA-05**: Voyage complete: loot chips, [领取收获] button (gold)
✅ **AC-SEA-06**: Harbor beacon state: lighthouse forced on during voyage
✅ **AC-SEA-07**: Tab 1 shows ship stats, upgrade costs, [升级] button

### Visual Match
- Reference: `a-room-sea.png`
- Map: 100×100 viewBox, path from (18,70) to (78,32)
- Ship: position interpolated along quadratic bezier

---

## 7. 告示板 (Board)

### Layout Structure
```
┌─────────────────────────────────────┐
│ ← 回港湾    📋 告示板    ✕          │
├─────────────────────────────────────┤
│ [图鉴] [记录] [日志] [反馈] [WIKI↗]│
├─────────────────────────────────────┤
│ Cork background with pinned papers  │
│ ┌─────────┐ ┌─────────┐            │
│ │ 📖 图鉴 │ │ 🏆 记录 │            │
│ │ 34/51   │ │ Top 3   │            │
│ │ [Grid]  │ │ Rankings│            │
│ └─────────┘ └─────────┘            │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-BRD-01**: Shows 4 tabs: 图鉴 / 记录 / 日志 / 反馈 (WIKI opens external)
✅ **AC-BRD-02**: Cork texture background (#d4c4a8)
✅ **AC-BRD-03**: Each paper: white card with title, content, shadow
✅ **AC-BRD-04**: Codex paper: progress bar + fish icon grid with locked state
✅ **AC-BRD-05**: Records paper: ordered list of player records
✅ **AC-BRD-06**: Log paper: chronological activity log with timestamps
✅ **AC-BRD-07**: Feedback paper: textarea + [提交] button, reply indicator if new
✅ **AC-BRD-08**: Note: "告示板上钉的纸张数 = 有新内容的栏目"

### Visual Match
- Reference: `a-room-board.png`
- Paper cards: 240px width, 12px padding, 4px shadow
- Cork pins: visual only (CSS ::before)

---

## 8. 邮筒 (Mail)

### Layout Structure
```
┌─────────────────────────────────────┐
│ ← 回港湾    📮 邮筒    ✕            │
├─────────────────────────────────────┤
│ 未读 2 · 共 3 封  [一键领取]       │
├─────────────────────────────────────┤
│ [Envelope List]                     │
│ ┌────────────────────────────────┐  │
│ │🔴 v0.25.3 维护补偿            │  │
│ │   系统 · 今天 09:00            │  │
│ │   [💰 500] [Ballast ×2]       │  │
│ └────────────────────────────────┘  │
│ ...                                 │
│ ⓘ 邮筒的小旗 = 有未读或未领附件    │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-MAI-01**: Toolbar shows unread count, total count, [一键领取] button
✅ **AC-MAI-02**: Envelope list items: unread dot, title, sender, timestamp, attachment chips
✅ **AC-MAI-03**: Unread envelopes have `.unread` class with border/background highlight
✅ **AC-MAI-04**: Click envelope to open letter detail view
✅ **AC-MAI-05**: Letter view: [← 收件箱] button, title, sender/time, body text, attachments
✅ **AC-MAI-06**: Attachments display as chips: coins or item icon + quantity
✅ **AC-MAI-07**: [领取附件] button (gold) adds items to inventory and clears from letter
✅ **AC-MAI-08**: [一键领取] collects all attachments from all letters
✅ **AC-MAI-09**: Reading letter marks as read, updates unread count

### Visual Match
- Reference: `a-room-mail.png`
- Envelope: wax seal visual (::before pseudo-element)
- Unread dot: 8px red circle, left of title

---

## 9. 渔屋 (Character / Fish House)

### Layout Structure (4 Tabs)
```
┌─────────────────────────────────────┐
│ ← 回港湾    🏠 渔屋    ✕            │
├─────────────────────────────────────┤
│ [晒场] [宠物] [角色] [装备]         │
├─────────────────────────────────────┤
│ 🏠 渔屋 Lv.5 · 静水湖               │
│                                     │
│ Left: [Income Box]                  │
│   晒场收益 520 💰                   │
│   [Gold progress bar] 6.5/8小时    │
│   [收取]                            │
│                                     │
│ Right: [Upgrade Box]                │
│   下一级 cost chips [升级]         │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-CHR-01**: Scene header shows house icon + name + level + location
✅ **AC-CHR-02**: Tab 0 splits: income box (left), upgrade box (right)
✅ **AC-CHR-03**: Income shows current coins, progress bar, hours/max, [收取] button (gold)
✅ **AC-CHR-04**: Bar fills to 100% when time maxed, note shows "晒场满了"
✅ **AC-CHR-05**: Upgrade box shows next level costs with chip shortage indicators
✅ **AC-CHR-06**: Tab 1 shows pet cards: emoji icon, name, quantity, location, [派驻] button
✅ **AC-CHR-07**: Tab 2 shows avatar picker: large preview, cloth color swatches, skin tone swatches
✅ **AC-CHR-08**: Avatar changes sync to HUD, harbor scene pier, and tavern cards
✅ **AC-CHR-09**: Tab 3 shows gear summary: rod icon, name, stats, [⚒ 去工坊] button

### Visual Match
- Reference: `a-room-character.png`
- 2-column split: 60/40 on desktop
- Scene tag: `.tag2` style with house emoji

---

## 10. 栈桥 (Fishing / Pier)

### Layout Structure
```
┌─────────────────────────────────────┐
│ ← 回港湾    🎣 栈桥    ✕            │
├─────────────────────────────────────┤
│ [🎣 继续：湖心深水] [收竿]         │
│ ⓘ 这是现有的钓鱼页（海图+实时钓鱼）│
├─────────────────────────────────────┤
│        [Map with Spot Pins]         │
│                                     │
│  [Pin: 湖畔老码头]                 │
│  [Pin: 📍 湖心深水] ← last spot    │
│  [Pin: 🔒 霜月冰窟] ← locked       │
│         ...                         │
└─────────────────────────────────────┘
```

### Acceptance Criteria

✅ **AC-FSH-01**: Toolbar shows [继续] button with last spot name, [收竿] button if fishing
✅ **AC-FSH-02**: Map displays all ground/spot pins with positioning (x%, y%)
✅ **AC-FSH-03**: Last spot pin shows 📍 icon prefix
✅ **AC-FSH-04**: Locked spots show 🔒 icon, display "需要更高等级的船" on click
✅ **AC-FSH-05**: Click available spot: updates lastSpot, sets fishing=true, shows toast
✅ **AC-FSH-06**: [继续] button closes panel and shows toast "继续在 X 钓鱼"
✅ **AC-FSH-07**: [收竿] button sets fishing=false
✅ **AC-FSH-08**: Note explains harbor adaptation: "港湾版只把侧栏换成「⚓ 回港湾」"

### Visual Match
- Reference: `a-room-fishing.png`
- Map: background image of fishing grounds
- Pins: absolute positioned buttons with spot names

---

## Implementation Checklist

### Phase 1: Harbor Panel Integration
- [ ] Verify `h-panel` frame hosts `#main` correctly
- [ ] Plank header displays place name + breadcrumbs
- [ ] Tab navigation uses hanging sign style (h-tabs)
- [ ] Back button (← 回港湾) calls `harbor.closePanel()`
- [ ] Close button (✕) same behavior

### Phase 2: Functional Page Layouts
- [ ] Inventory: grid + detail card layout matches spec
- [ ] Workshop: 3 tabs with bench/growth/sets/smelt
- [ ] Chests: card grid with opening animation
- [ ] Mall: 3 tabs with limited/buyback/market
- [ ] Tavern: player cards + feed split
- [ ] Voyage: map + detail split with ship animation
- [ ] Board: cork background + paper cards
- [ ] Mail: envelope list + letter detail
- [ ] Character: 4 tabs with income/pets/avatar/gear
- [ ] Fishing: map with spot pins

### Phase 3: State Synchronization
- [ ] Workshop smelting complete → harbor workshop badge
- [ ] Voyage away → lighthouse forced on
- [ ] Mail unread → mailbox flag up
- [ ] Board new content → paper pins visible
- [ ] Income full → house glow

### Phase 4: Visual Polish
- [ ] All fonts match: pixel (12/24px) for UI, system (14px) for body
- [ ] Rarity colors applied consistently (common/rare/epic/mythic)
- [ ] Button states: hover (border), active (translateY)
- [ ] Animations: panel-in (220ms), shake (650ms), flash (1.8s)
- [ ] Responsive: desktop 3% inset, mobile full width

### Phase 5: Testing Against Screenshots
- [ ] Compare each page render with a-room-*.png
- [ ] Verify pixel-perfect spacing and alignment
- [ ] Check all interactive states work
- [ ] Test tab navigation and deep links
- [ ] Validate accessibility (focus, labels, ARIA)

---

## Notes

1. **Prototype vs Production**: The design doc's `harbor-rooms.js` is prototype content. Production pages in `ui.js` render* functions must match this spec while keeping their existing logic.

2. **CSS Inheritance**: Harbor CSS (`harbor.css`) provides frame and chrome. Interior content uses existing component styles from `style.css`, `pixel.css`, etc.

3. **Deep Links**: Format `#/place` or `#/place/tab` must work, e.g., `#/workshop/3` opens smelting tab.

4. **Mobile Adaptation**: All interiors must work in mobile layout (full width panel, no side insets).

5. **Motion Preferences**: Respect `prefers-reduced-motion` and `data-motion` attribute for animations.

---

**End of Specification**