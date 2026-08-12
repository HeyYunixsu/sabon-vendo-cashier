# Dashboard Redesign — Icon Tiles + Visual Refresh

**Date:** 2026-08-12
**Status:** approved
**Scope:** CSS rewrite + icon tile implementation; JS logic unchanged

## Summary

Replace the photo-based product cards with inline-SVG icon tiles (§15 of `CASHIER_DASHBOARD.md`), clean up photo-era CSS artifacts, and apply a full visual polish pass across cards, layout spacing, and microinteractions — all within the existing single-file, no-CDN, two-theme architecture.

## What Stays Unchanged

- JS state machine (`S` object, all arrays, indices 1–5)
- SSE protocol and `parse()` function
- All API calls and server endpoints
- Theme system (`data-theme`, localStorage, toggle button)
- Font stack (Poppins + Inter, local woff2)
- Product data constants (`PRODUCT`, `PRODUCT_ML`, `ACTIVE`, `TOTAL`, `MAX_QTY`)
- Demo/skeleton mode timeout
- HTML DOM structure (status bar, KPI row, sale strip, main grid, right panel sections)
- `server.js` — zero changes
- Offline banner, toast, alert card patterns

## 1. Card Structure — Icon Tile Design

### 1.1 Remove photo-era artifacts

- Delete `.photo-zone` CSS block and its `::after` scrim pseudo-element
- Delete `PRODUCT_BG` constant from JS
- Remove `background-image` from `renderGrid()` output

### 1.2 New card layout

Switch from `grid-template-columns: 150px 1fr` to flexbox:

```css
.product-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  min-height: 100px;
}
```

### 1.3 Icon square

Percentage-based so it scales with the card at any viewport:

```css
.product-icon {
  width: 22%;
  max-width: 64px;
  aspect-ratio: 1 / 1;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.product-icon svg {
  width: 55%;
  height: 55%;
}
```

### 1.4 Inline SVGs

Rendered by `renderGrid()` directly into the card HTML. Three icon shapes:

| Category | Slots | Shape |
|----------|-------|-------|
| Droplet | 1, 2 | Teardrop: `M12 3c4.2 4.6 6.5 8.1 6.5 11a6.5 6.5 0 0 1-13 0c0-2.9 2.3-6.4 6.5-11z` |
| Pouch | 3, 4 | Pouch body with cap dashes |
| Jug | 5, 6 | Jug body with spout arc and handle |

`stroke="currentColor"` on all SVGs — color inherits from the icon container's CSS `color`.

### 1.5 Per-product colors

Driven by `data-product="N"` attribute on each `.product-card`. Two palettes via CSS custom properties — light and dark theme both covered.

#### Light theme

| Slot | Data attr | Tile bg | Icon color |
|------|-----------|---------|------------|
| 1 | `data-product="1"` | `#EEEDFE` | `#534AB7` |
| 2 | `data-product="2"` | `#E6F1FB` | `#185FA5` |
| 3 | `data-product="3"` | `#E1F5EE` | `#0F6E56` |
| 4 | `data-product="4"` | `#FAECE7` | `#993C1D` |
| 5 | `data-product="5"` | `#FAEEDA` | `#854F0B` |
| 6 | `data-product="6"` | `#EAF3DE` | `#3B6D11` |

#### Dark theme

| Slot | Tile bg | Icon color |
|------|---------|------------|
| 1 | `#2A2450` | `#8B82E0` |
| 2 | `#1A3050` | `#5B9BD5` |
| 3 | `#1A3A30` | `#4DB89E` |
| 4 | `#3A2018` | `#D4856A` |
| 5 | `#3A2A15` | `#C89240` |
| 6 | `#253A18` | `#6BA830` |

### 1.6 Text panel

Unchanged content stack: SLOT 0X label → product name → armed qty → status row.

Add `text-overflow: ellipsis` to product name for narrow-screen safety.

## 2. Card States — Visual Polish

Each state gets a full visual treatment, not just border color:

| State | Border | Glow (box-shadow) | Icon square | Extra |
|-------|--------|-------------------|-------------|-------|
| Idle | `--border-default` | none | normal tile color | — |
| Selected | `--border-strong` | `0 0 0 3px rgba(59,109,240,.25)` | normal | `transform: scale(1.01)` |
| Armed | `--border-strong` | same blue ring | normal (tile color stays) | qty number pulses once on arm |
| Busy | `--status-caution` | `0 0 0 3px rgba(251,191,36,.25)` | caution-tinted wash | icon + qty pulse |
| Empty | `--status-negative` | `0 0 0 3px rgba(248,113,113,.25)`, tile desaturated 50% | red-tinted | no pointer events |
| Inactive | `--border-default` | none | 30% opacity entire card | no pointer events |

**Transition:** `transition: border-color .2s, box-shadow .2s, transform .2s` on `.product-card`.

**Pulse-on-arm:** one-shot `@keyframes pulse-arm` (scale 1→1.15→1, 400ms) on the armed-qty number. Triggered by adding/removing a class in `renderGrid()`.

**Pulse-busy:** `@keyframes pulse-busy` (opacity 1→.7→1, 800ms infinite) on the icon when `.busy`.

## 3. Layout Refinement

### 3.1 Spacing

- Product grid gap: 10px → 8px
- Card min-height: 150px → 100px (flexbox is more space-efficient)
- Right panel section padding: `16px 20px` → `12px 16px`
- Right panel section gap: 14px → 10px
- Right panel list rows: `padding: 10px 0` → `8px 0`
- Sale strip staged items grid gap: 8px → 6px
- KPI cards: add `min-height: 80px` for consistent row alignment

### 3.2 CSS cleanup

- Remove duplicate `.sale-controls { display: flex; ... }` block
- Remove `.photo-zone` CSS and `::after` scrim
- Consolidate any redundant selectors

### 3.3 Responsive integrity — NO gaps at any size

This is a hard requirement. Every breakpoint gets explicit testing:

**Desktop (default, >768px):**
- Product grid: 3×2, card flex horizontal (icon left, text right)
- Main: two-column (1fr + 260px)
- All cards fill their grid cells — no dead space

**Tablet (≤768px):**
- Product grid: 2×3
- Card: `grid-template-columns: 1fr` (single column) — icon stacks on top, text below, centered
- Card gap: 10px
- Main: single column, right panel full width
- Staged items: 2 per row

**Phone (≤480px):**
- KPIs: 2×2
- Card: icon smaller (width: 20%, max-width: 56px), text font sizes reduced
- Card padding: 12px, gap: 10px
- All interactive elements ≥ 44px touch target

**Gap prevention rules:**
1. Cards use `flex: 1` within grid cells to always fill available width — no empty columns
2. Product name uses `text-overflow: ellipsis` — never overflows
3. Icon uses percentage width (`22%`) — scales with card, never overflows
4. Right panel sections auto-hide when empty — no empty section boxes
5. Grid uses `1fr` tracks — cards distribute evenly, no partial columns
6. `min-height` on cards prevents collapse on empty states
7. Sale strip `flex-wrap: wrap` with proper `flex-basis` fallbacks — controls never overflow off-screen

## 4. Motion & Microinteractions

- **Card hover:** `transform: translateY(-1px)`, border brightens, 150ms transition
- **Staged item enter:** existing `slide-in` keyframe, shortened to 150ms
- **Armed-qty change:** CSS `transition: color .3s` — crossfades between grey/accent/yellow
- **Pulse-on-arm:** one-shot scale animation on qty digit when a slot goes 0→armed
- **Toast:** `transition-delay: 0`, 2.6s auto-hide kept
- **PAUSED indicator:** add subtle scale pulse (`scale(1,1)` → `scale(1.05,1.05)` → `scale(1,1)`, 1.2s) alongside existing opacity pulse

## 5. Implementation Plan

### Files changed
Only one file: `cashier_dashboard/public/index.html`

### JS changes (in `renderGrid()`)
1. Remove `PRODUCT_BG` reference and `background-image` from card HTML
2. Add `data-product="${s}"` attribute to each card
3. Replace `<div class="photo-zone" style="...">` with `<div class="product-icon">` + inline SVG
4. Add `is-pulse-arm` class to armed-qty when `armedQty[s]` just went from 0→>0 (tracked via prev snapshot)

### CSS changes
1. Remove: `.photo-zone` block, `::after` scrim, duplicate `.sale-controls` block
2. Add: `.product-icon` styles, `[data-product="N"]` color blocks for both themes
3. Add: `@keyframes pulse-arm`, `@keyframes pulse-busy`
4. Rewrite: `.product-card` from grid to flexbox
5. Update: spacing values (gaps, paddings), responsive breakpoints
6. Add: motion transitions on card states

### Verification checklist
- [ ] All 6 cards render with correct icons and colors in light theme
- [ ] All 6 cards render with correct icons and colors in dark theme
- [ ] Card states (idle/selected/armed/busy/empty/inactive) all visually distinct
- [ ] No layout gaps at 1920px, 1440px, 1024px, 768px, 480px, 375px widths
- [ ] Sale strip works: stage items, remove items, arm, clear
- [ ] Right panel sections show/hide correctly
- [ ] Demo mode populates correctly after 4s
- [ ] Theme toggle persists across reloads
- [ ] No broken-image fallback needed (SVGs are inline)
- [ ] Text truncation on long product names
- [ ] Touch targets ≥ 44px on mobile
