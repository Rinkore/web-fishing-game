# UI Layout Refactoring: Webpage to Game HUD

## Completed: v0.28.0 → Compact Game HUD Layout

### Core Changes Made

#### 1. **Harbor Container (#harbor)**
- Removed padding and gaps (was 10px + side margins)
- Changed from flexible gap layout to 0 gap
- Removed large margins around UI elements
- Game world now has maximum screen real estate

#### 2. **Top HUD (.h-hud-top)**
- Reduced from full-width bar to compact header
- Padding: 6px 12px (was 10px)
- Border-bottom: 2px solid (was part of larger panel)
- Player status flex-wrap: nowrap (horizontal scrolling instead of wrapping)
- Font sizes reduced: 12px → 11px

#### 3. **Time Chip (.h-timechip)**
- Border: 2px (was 3px)
- Padding: 3px 6px (was 4px 8px)
- Font-size: 11px (was 12px)
- Icon size: 13px (was 15px)

#### 4. **Bottom HUD (.h-hud-bottom)**
- Changed from flex row layout to fixed positioning
- Buttons positioned as floating corners
- Left buttons (Menu, Settings): Fixed bottom-left
- Right buttons (Backpack, Compass): Fixed bottom-right
- Cast button: Fixed center-bottom (floating primary action)

#### 5. **Control Buttons (.h-btn)**
- Size: 40×40px (was 52×52px)
- Font-size: 18px (was 22px)
- Border: 2px (was 3px)
- Box-shadow: 0 2px 0 (was 0 4px 0)
- Labels positioned absolutely below buttons

#### 6. **Cast Button (.h-cast)**
- Position: Fixed bottom-center
- Compact layout with reduced padding
- Font-size: 18px (was 24px)
- Small text: 10px (was 12px)
- Shadow reduced for floating effect

#### 7. **Interior Panel (.h-panel)**
- Inset: 40px 0 0 (full width, below HUD)
- Border: 2px solid (was 4px + wooden frame styling)
- Removed large side margins (was inset 3%)
- Removed box-shadow effects

#### 8. **Plank & Tabs**
- Plank padding: 5px 10px (was 7px 12px)
- Reduced font sizes across tabs and headers
- Tab borders: 2px (was 3px)
- Removed decorative elements

#### 9. **Compass & Navigation**
- Ring size: 320×320px (was 360×360px)
- Needle: 60×60px (was 76×76px)
- Compass items: 60×52px (was 70×62px)
- All borders: 2px (was 3px)
- Font sizes reduced by 1-2px throughout

#### 10. **Content Area (.h-pbody)**
- Padding: 10px 12px 14px (was 12px 14px 16px)
- Font-size: 13px (was 14px)
- All nested components scaled proportionally

### Visual Hierarchy Changes

**Priority Order (New):**
1. Game World / Map (now ~85% of viewport)
2. Compact Top HUD (compact info bar)
3. Floating Primary Action (Go Fishing button)
4. Corner Controls (Menu, Settings, Backpack, Compass)
5. Interior Panels (full-width when open)

**Previous Structure:**
- Large top bar + Large game area + Large bottom control bar

### Key Improvements

✓ Game world occupies maximum visible space
✓ Removed large bottom control region
✓ Compact floating button layout (no full-width controls)
✓ Reduced text sizes throughout (11-12px UI text)
✓ Consistent 2px borders (no more 3-4px thick borders)
✓ Fixed positioning for corner controls
✓ Full-width interior panels when needed
✓ Streamlined visual hierarchy

### Browser & Responsive Behavior

- Desktop: Full compact HUD with floating controls
- Mobile (≤640px): Further compaction with adjusted button sizes
- All positioning uses fixed/absolute, preserving maximum game viewport
- No hardcoded empty regions for UI

### Files Modified

- `/frontend/css/harbor.css` — Complete refactor of HUD, controls, and layout

### Testing Checklist

- [x] Game map occupies significant screen space
- [x] Bottom control bar completely removed
- [x] Go Fishing is compact floating button
- [x] Top HUD is compact header bar
- [x] Menu & Settings are corner controls (bottom-left)
- [x] Backpack & Compass are corner controls (bottom-right)
- [x] UI overlays game world (no separate regions)
- [x] Interior panels span full width below HUD
- [x] All buttons use 2px borders
- [x] Font sizes reduced throughout
- [x] Mobile layout adapts properly

### Implementation Notes

- All changes purely CSS-based (no HTML modifications)
- Fixed positioning for floating elements
- Z-index management for proper layering
- Media queries preserve responsive behavior
- All existing game functionality preserved
- No breaking changes to existing JS behavior
