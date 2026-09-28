# Harbor v2 Design Migration Status

## Completed ✅

1. **harbor-art.js** - Pixel art renderer (415 lines)
   - Already integrated from v2 design
   - Location: `frontend/js/harbor-art.js`
   
2. **harbor.js** - Shell wrapper (722 lines)
   - Connects to existing `ui.js`
   - Location: `frontend/js/harbor.js`
   
3. **harbor-rooms.js** - Interior content renderer (250 lines)
   - ✅ **COPIED** from v2 design
   - Location: `frontend/js/harbor-rooms.js`
   
4. **harbor.css** - Base styling (581 lines)
   - Partially migrated
   - Location: `frontend/css/harbor.css`

## Remaining Tasks

### 1. Add v2 CSS Patterns to harbor.css

The following CSS patterns from v2 design (lines 179-268) need to be appended to `frontend/css/harbor.css`:

- `.mini` buttons (go, gold, disabled states)
- `.toolbar` (search/filter controls)
- `.room2` (two-column layout)
- `.box`, `.meter`, `.chip` (content containers & resources)
- `.slots`, `.slot` (inventory grid with rarity borders)
- `.rc-*` (rarity color classes)
- `.cards`, `.pcard` (card grids)
- `.bench` (3-column workshop cards)
- `.partmap` (equipment growth radial map)
- `.forge` (smelting UI with arrows)
- `.voy`, `.map` (voyage & world maps)
- `.cork`, `.paper` (bulletin board with pinned paper cards)
- `.envs`, `.env`, `.letter` (mail envelope UI)

### 2. Link harbor-rooms.js in index.html

Add to `frontend/index.html` before the closing `</body>`:

```html
<script src="js/harbor-rooms.js?v=0.27.8" defer></script>
```

### 3. Update CSS Variable References

The v2 design uses these CSS custom properties that need to be defined in `frontend/css/tokens.css` or mapped:

```css
--px: 'FusionPixel', "PingFang SC", "Microsoft YaHei", sans-serif;
--body: "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
--accent: #34e0c0;
--gold: #ffd23e;
--danger: #f87171;
--muted: #8fa6bf;
--r-common: #cbd5e1;
--r-rare: #38bdf8;
--r-epic: #ffd24a;
--r-mythic: #c084fc;
--wood: #6b4631;
--wood-dk: #3a2618;
--wood-hi: #a8744a;
--paper: #efe3c8;
```

## Design Pattern Showcase

The v2 design brings these distinctive visual patterns:

1. **Cork Board** - Radial gradient texture with pinned paper cards that rotate slightly
2. **Paper Cards** - Cream background with red pushpin, subtle rotation for organic feel  
3. **Wooden Slots** - Rarity-based border colors with inset glows (rare/epic/mythic)
4. **Forge UI** - Horizontal flow with arrows showing item transformation
5. **Envelope Mail** - Paper envelope with fold lines and wax seal (red = unread, gray = read)
6. **Equipment Radial Map** - Circular arrangement of upgrade slots around center rod
7. **Mini Buttons** - 3px borders, pressed shadow effect, `.go` (teal) and `.gold` (yellow) variants

## Files Created

- `frontend/js/harbor-rooms.js` ✅
- `frontend/css/harbor-v2-rooms.css` (partial, needs to be merged into harbor.css)

## Next Steps

1. Append v2 CSS patterns to `frontend/css/harbor.css` (lines 582+)
2. Add `<script>` tag for `harbor-rooms.js` in `index.html`  
3. Test the interior panels render with v2 design patterns
4. Verify CSS variables are defined or add fallbacks

