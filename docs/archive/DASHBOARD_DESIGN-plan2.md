# Sabon Vendo — Cashier Dashboard

> **Comprehensive documentation** for the cashier dashboard subsystem.
> Read this before modifying anything. Intended for developers and Claude instances.

---

## 1. Overview

The cashier dashboard is a **single-page web app** that a cashier uses to sell soap products. Each product has a fixed, pre-calibrated ml volume per press — there is no pricing anywhere in the system. The cashier selects one or more products, sets a press quantity for each, and arms them via a TCP connection to the **C++ `coin_slot` server** (the dispenser machine). Customers then press physical buttons on the vendo machine to dispense — each press consumes one unit of armed credit on that slot and triggers one calibrated pour; the machine pauses after each dispense completes before it accepts the next press.

**Two-machine architecture:**
- **Cashier machine** — serves the dashboard (Node.js + Express on port 80). Browser accessible on LAN.
- **Vendo machine** — runs the C++ `coin_slot` binary (TCP server on port 8080). Controls GPIO pins for buttons, pumps, and LEDs.

Both are on the same LAN. The dashboard is the **bridge** between the cashier's browser and the vendo machine.

---

## 2. File Layout

```
cashier_dashboard/
├── server.js                    # Node.js Express server (port 80)
├── package.json                 # Only dependency: express ^4.21.0
├── CASHIER_DASHBOARD.md         # This file
├── .unclaimed_sales.json        # Persisted unclaimed sales (auto-created)
├── pm2-dashboard.log            # PM2 log (auto-created)
└── public/
    ├── index.html               # THE ENTIRE UI — HTML + CSS + JS in one file (~1068 lines)
    └── fonts/
        ├── inter-v20-latin-regular.woff2
        ├── inter-v20-latin-500.woff2
        ├── inter-v20-latin-600.woff2
        ├── inter-v20-latin-700.woff2
        ├── poppins-v24-latin-regular.woff2
        ├── poppins-v24-latin-500.woff2
        ├── poppins-v24-latin-600.woff2
        └── poppins-v24-latin-700.woff2
```

**Key design choice:** Everything is self-contained in `index.html`. No separate CSS/JS files. No CDN dependencies. The fonts are loaded from `fonts/` directory as `@font-face` with `font-display: swap` — fully offline.

---

## 3. server.js — Node.js Backend

### 3.1 Config Loading

```js
const CONFIG_PATH = path.resolve(__dirname, '..', 'CONFIG', 'config.env');
```

Reads from `CONFIG/config.env` in the parent directory. Key vars:

| Variable | Default | Description |
|---|---|---|
| `SOCKET_IP` | `127.0.0.1` | coin_slot TCP server host |
| `SOCKET_PORT` | `8080` | coin_slot TCP server port |
| `DASHBOARD_PORT` | `80` | HTTP port to serve dashboard |

### 3.2 TCP Proxy

The server maintains a persistent TCP connection to `coin_slot`. It acts as a **proxy** — all ARM/CANCEL commands from the browser go through Node.js → TCP → coin_slot.

**Connection lifecycle:**
1. On startup, `connectToCoinSlot()` opens a TCP socket to `SOCKET_IP:SOCKET_PORT`
2. On connect, flushes any locally queued ARM commands (`flushLocalQueue()`)
3. On disconnect, waits 3 seconds, then reconnects
4. On data received, parses lines — STATUS lines are broadcast to all SSE clients

**Offline queue:** If coin_slot is unreachable when the cashier clicks "Arm", the command is queued in `localArmQueue[]` and automatically flushed on reconnect.

### 3.3 SSE (Server-Sent Events)

**Endpoint:** `GET /api/status/stream`

Every connected browser gets a persistent SSE stream. On first connect:
1. Sends `data: connected\n\n` (triggers a full client-side state reset)
2. Pushes any existing unclaimed sales

Thereafter, every `STATUS` line from coin_slot is forwarded verbatim to all SSE clients.

### 3.4 API Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/arm` | `{saleId, batch}` or `{saleId, items}` | Arm product slots |
| `POST` | `/api/cancel` | `{productId}` | Cancel one armed slot |
| `POST` | `/api/cancel-all` | `{}` | Cancel ALL armed slots + clear all queues |
| `POST` | `/api/cancel-queue` | `{productId}` | Clear pending queue for one slot |
| `POST` | `/api/unclaimed/resolve` | `{slot, qty, action}` | Retry or dismiss unclaimed sale |
| `GET` | `/qr` | — | Redirects to a QR code of the LAN URL |
| `GET` | `/api/status/stream` | — | SSE stream for live STATUS |

**ARM batch mode (preferred):** `{saleId: "SALE-...", batch: "1:3,2:1,3:5"}` → sends `ARM_BATCH,1:3,2:1,3:5` to coin_slot. All slots are armed atomically.

**ARM legacy mode:** `{saleId: "SALE-...", items: [{productId:1,qty:3}, ...]}` → sends individual `ARM,1,3` commands. Still supported but batch is preferred.

**Double-click guard:** `processedSaleIds` Set stores sale IDs. Duplicate sale IDs are rejected with `{success: false, duplicate: true}`. The Set is trimmed when it exceeds 1000 entries.

### 3.5 Unclaimed Sales

When a sale is armed but something goes wrong (e.g. machine goes offline mid-transaction), the sale is tracked in:
- **In-memory:** `unclaimedSales[]` array
- **On-disk:** `.unclaimed_sales.json` (survives server restarts)
- **SSE:** Pushed to all connected browsers as `UNCLAIMED:<slot>,<qty>,<timestamp>`

The dashboard shows these in the "Attention" section with Retry/Dismiss buttons.

### 3.6 LAN URL & QR Code

```js
function getLanUrl() {
  // Scans os.networkInterfaces() for the first non-internal IPv4 address
  // Returns http://<lan-ip>:<port>
}
```

The `/qr` endpoint redirects to a QR code image so the cashier can scan it with a phone to open the dashboard on their phone browser.

---

## 4. index.html — Client-Side UI

### 4.1 Font Stack

**Heading font:** Poppins (used for: KPI labels, KPI values, status bar, product slot labels, product icons, armed quantities, list values, staged quantities, buttons)

**Body font:** Inter (used for: product names, section labels, body text, status dots labels)

Both are loaded as `@font-face` with `font-display: swap` from local `.woff2` files in `public/fonts/`. **Fully offline — no Google Fonts CDN.**

Fallback stack: `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`

### 4.2 Design System (CSS Custom Properties)

**Dark theme (default):**
```css
:root {
  --bg-surface-primary:   #0B0E14;  /* page background */
  --bg-surface-secondary: #141925;  /* card/section background */
  --bg-surface-tertiary:  #1C2333;  /* input/element background */
  --border-default:       #232A3B;  /* subtle borders */
  --border-strong:        #3B6DF0;  /* accent/selected borders — BLUE */
  --text-content-primary: #F5F7FA;  /* primary text */
  --text-content-secondary: #8A93A6; /* secondary/muted text */
  --accent-action:        #3B6DF0;  /* buttons, highlights — BLUE */
  --accent-action-hover:  #507DF4;  /* hover state */
  --status-positive:      #34D399;  /* green — online, in-stock, complete */
  --status-caution:       #FBBF24;  /* yellow — busy, dispensing, paused */
  --status-negative:      #F87171;  /* red — offline, empty, error */
  --status-neutral:       #4B5263;  /* grey — idle, inactive */
}
```

**Light theme (`[data-theme="light"]`):**
Overrides all color tokens. Toggled via the "LIGHT"/"DARK" button in the status bar. Persisted in `localStorage` key `sabon-theme`. Default is light on first visit.

### 4.3 Layout Structure

```
┌────────────────────────────────────────────────────┐
│ STATUS BAR: Online dot | Machine 001 | PAUSED | [THEME] | 14:30:00 │
├────────────────────────────────────────────────────┤
│ OFFLINE BANNER (hidden when online)                 │
├────────────────────────────────────────────────────┤
│ KPI ROW: [Total Armed] [In Stock] [Phase] [Today]  │
├────────────────────────────────────────────────────┤
│ SALE STRIP: [Staged Items Grid] [Qty Stepper]       │
│             [Stage] [Clear] [Arm] [Total Presses]    │
├──────────────────────────────┬─────────────────────┤
│ PRODUCT GRID (3×2)          │ RIGHT PANEL         │
│ ┌──────┐ ┌──────┐ ┌──────┐ │ Armed (list rows)   │
│ │Slot01│ │Slot02│ │Slot03│ │ Dispensing           │
│ └──────┘ └──────┘ └──────┘ │ Attention            │
│ ┌──────┐ ┌──────┐ ┌──────┐ │ Alerts               │
│ │Slot04│ │Slot05│ │Slot06│ │ (all auto-hide when  │
│ └──────┘ └──────┘ └──────┘ │  empty)              │
│ [Select All Products]       │                      │
└──────────────────────────────┴─────────────────────┘
```

**Layout is CSS Grid:**
- Status bar: flexbox, space-between
- KPI row: `grid-template-columns: repeat(4, 1fr)`
- Main content: `grid-template-columns: 1fr 260px` (grid + right panel)
- Product grid: `grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr)` (6 slots in 3×2)
- Sale strip staged items: `grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, auto)` (max 6 staged items, wrap to 2 rows)

### 4.4 Responsive Breakpoints

| Breakpoint | Changes |
|---|---|
| **Desktop (default)** | Status bar one row, all 4 KPIs side-by-side, main two-column (grid + 260px panel), 3×2 product grid, staged items 3-per-row |
| **≤768px (tablet)** | Status bar wraps, main single-column, KPIs stay 4-column, product grid 2×3, staged items 2-per-row, sale controls wrap with order |
| **≤480px (phone)** | KPIs 2×2, product grid 2×3, reduced font/padding on all elements, sale controls wrap into multiple rows |

### 4.5 Product Card States

Each product card (6 total, slot 6 is always inactive) has these visual states:

| State | CSS Class | Border | Icon Border | Qty Color | Status |
|---|---|---|---|---|---|
| Normal/Idle | `product-card` | default | default | grey (`#3A4050`) | "Idle" dot |
| Selected | `+ .selected` | blue (`border-strong`) | — | — | — |
| Armed | `+ .armed` | blue (`border-strong`) | accent | accent blue | "Armed" dot |
| Busy (Dispensing) | `+ .busy` | yellow (`status-caution`) | accent | warning yellow | "Busy" dot |
| Empty (no liquid) | `+ .empty` | red (`status-negative`) | red | red | "Empty" dot |
| Inactive (slot 6) | `+ .inactive` | default | grey | "N/A" | "N/A" dot |

**Slot 6 is always `.inactive`** (30% opacity, no pointer events). Only 5 active slots exist on the machine.

### 4.6 Sale Flow

1. **Select product** — Click a product card (only active, non-empty slots are clickable)
2. **Set quantity** — Use the qty stepper (±1 step, min 1, max `MAX_QTY`) to choose how many presses to arm. Each press dispenses that product's fixed calibrated ml. The stepper shows a read-only computed total (e.g. "3× · 120ml") so the cashier can see the total volume, but the underlying value sent to coin_slot is always the press count, never a ml or peso figure
3. **Item staged** — Click "Stage" to add a card to the sale strip with product name and qty (e.g. "3×"), plus × remove button
4. **Add more products** — Repeat steps 1-3 for different products
5. **"Select All" button** — Selects all active non-empty slots at once (multi-select mode). Setting a quantity and staging then applies that same qty to ALL selected products simultaneously
6. **Arm** — Sends `ARM_BATCH,<slot1>:<qty1>,<slot2>:<qty2>,...` via the server to coin_slot (wire format unchanged — `qty` is now entered directly rather than derived from a peso amount)
7. **Customer dispenses** — Presses physical buttons on the vendo machine; each press consumes one unit of armed credit and triggers one calibrated pour. The machine pauses after each pour completes before the next press is accepted (reflected in the existing `busy` state — see §5.1)

### 4.7 Multi-Select Mode

Triggered by the "Select All Products" button below the grid. In multi-select mode:
- All active non-empty product cards show as "selected" (blue border + glow)
- Setting a quantity on the stepper and confirming stages ALL selected products at that quantity
- Mode exits after staging

### 4.8 Right Panel Sections

All four sections auto-hide when empty (`display: none`):

1. **Armed** (blue left border) — Lists slots with `armedQty > 0` or `busy`. Shows dot, product name, qty count, Cancel button. Includes "Clear All Credits" button at bottom.

2. **Dispensing** (green left border) — Lists slots currently busy (pump running). Shows product name and progress percentage (calculated from `remaining` time).

3. **Attention** (purple left border) — Lists unclaimed sales. Each row has "Retry" (re-arms the slot) and "Dismiss" buttons.

4. **Alerts** (red left border) — Lists empty slots (water level sensor triggered) and offline status. Shows alert count at top. Uses `alert-card` with red-tinted background.

### 4.9 KPI Cards

| KPI | Source | Color Accent |
|---|---|---|
| **Total Armed** | Sum of `armedQty[1..5]` | Blue top border |
| **In Stock** | Count of slots where `wlvl[s] === false` (false = has liquid) | Green top border; color changes: 5=green, 2-4=yellow, 0-1=red |
| **Phase** | `S.phase`: 0=IDLE, 1=ARMED, 2=DISPENSING, 3=COMPLETE | Yellow top border |
| **Today** | `dispenseCount` — incremented when `busy` transitions false→true | Purple top border |

### 4.10 Status Bar

- **Left:** Connection status dot + "Online"/"Offline" + "Machine 001"
- **Center:** "PAUSED" indicator (visible only when `S.paused === true`, yellow, pulsing)
- **Right:** Theme toggle button + last update timestamp (HH:MM:SS)

### 4.11 Offline Banner

Shown when `S.connected === false`. Red-tinted background, "Machine unreachable." message with "Retry connection" link that calls `connectSSE()`.

### 4.12 Toast Notifications

Fixed to bottom-center. Rises up with CSS transition. Three variants: default (dark), `.success` (green border), `.error` (red border). Auto-hides after 2.6 seconds.

---

## 5. JavaScript State Management

### 5.1 Global State Object (`S`)

```js
const S = {
  armedQty:    new Array(7).fill(0),   // [1..5] armed credit per slot
  remaining:   new Array(7).fill(0),   // [1..5] remaining pump time (ms)
  wlvl:        new Array(7).fill(false), // [1..5] water level empty (true = empty)
  busy:        new Array(7).fill(false), // [1..5] pump is running
  queueDepth:  new Array(7).fill(0),   // [1..5] pending queue depth
  paused:      false,                  // machine paused
  phase:       0,                      // 0=IDLE, 1=ARMED, 2=DISPENSING, 3=COMPLETE
  bundleComplete: false,               // all armed credits consumed
  lastUpdate:  null,                   // Date of last STATUS
  connected:   false,                  // SSE connection alive
};
```

**Important:** Array indices 1-5 are used. Index 0 and 6 are unused (reserved for potential 6th slot).

### 5.2 Other State

| Variable | Type | Description |
|---|---|---|
| `selProduct` | `number|null` | Currently selected product slot (1-5) |
| `multiSelect` | `boolean` | Multi-select mode active (from "Select All") |
| `staged` | `Array` | Sale strip staged items: `[{id, name, qty, ml}, ...]` (`ml` is computed `qty × PRODUCT_ML[productId]`, display-only) |
| `unclaimed` | `Array` | Unclaimed sales from SSE: `[{slot, qty, time}, ...]` |
| `saleCtr` | `number` | Incrementing counter for unique sale IDs |
| `dispenseCount` | `number` | Total dispenses this session (incremented on busy transition) |
| `prevArmed` | `Array[7]` | Previous armedQty snapshot (for change detection) |
| `prevBusy` | `Array[7]` | Previous busy snapshot (for dispense counting) |

### 5.3 SSE `parse()` Function

Parses STATUS responses from coin_slot. Expects **28 comma-separated fields**:

```
Field  | Content           | Index in array
-------|-------------------|---------------
1-5    | armedQty[1..5]    | 1-5
6-10   | remaining[1..5]   | 6-10
11-15  | wlvl[1..5]        | 11-15 (1=empty, 0=has liquid)
16-20  | busy[1..5]        | 16-20 (1=dispensing, 0=idle)
21-25  | queueDepth[1..5]  | 21-25
26     | paused            | 26 (1=paused)
27     | phase             | 27 (0=IDLE, 1=ARMED, 2=DISPENSING, 3=COMPLETE)
28     | bundleComplete    | 28 (1=complete)
```

**Length validation:** `if (p.length < 28) return;` — silently ignores malformed STATUS lines.

### 5.4 Water Level Logic

- `wlvl[s] === true` means the slot is **empty** (water level sensor triggered)
- `wlvl[s] === false` means the slot has liquid (normal state)
- Slot 5 always has `wlvl[5] = false` set by coin_slot (no physical sensor for slot 5)
- "In Stock" KPI counts slots where `!S.wlvl[s]`
- Empty slots show red border + "Empty" status on product card
- Alerts section lists empty slots

### 5.5 Demo/Skeleton Mode

If no connection after 4 seconds (`setTimeout`), the page populates dummy data so the UI isn't blank:
- Slot 1: 2 armed
- Slot 2: 1 armed
- Slot 3: busy
- Slot 4: empty (water level)
- Slot 2: queue depth 1

---

## 6. Communication Protocol

### 6.1 Browser → Server (HTTP API)

Standard JSON POST requests. See Section 3.4 for all endpoints.

### 6.2 Server → coin_slot (TCP)

Commands sent as plain text over TCP:

| Command | Format | Effect |
|---|---|---|
| `ARM_BATCH` | `ARM_BATCH,<s1>:<q1>,<s2>:<q2>,...` | Arm multiple slots atomically |
| `ARM` | `ARM,<productId>,<qty>` | Arm one slot (legacy) |
| `CANCEL` | `CANCEL,<productId>` | Clear armed credit for one slot |
| `CANCEL_ALL` | `CANCEL_ALL` | Clear ALL armed credits + all queues |
| `CANCEL_QUEUE` | `CANCEL_QUEUE,<productId>` | Clear pending queue for one slot |

### 6.3 coin_slot → Server → Browser (SSE)

coin_slot broadcasts STATUS every 500ms and on any state change. The dashboard server parses these lines and forwards them via SSE to all browser clients. The format is `STATUS,<28 fields>` (see Section 5.3).

---

## 7. Theme System

### 7.1 How It Works

- The `<html>` element has `data-theme="light"` as default on page load
- On first visit (no `localStorage`), the theme is light
- The theme toggle button reads current theme and shows the opposite: if dark → shows "LIGHT" button; if light → shows "DARK" button
- On toggle: swaps `data-theme` attribute on `<html>`, saves to `localStorage` key `sabon-theme`
- CSS uses `[data-theme="light"]` selector to override all `:root` custom properties

### 7.2 Color Mapping Summary

| Token | Dark | Light |
|---|---|---|
| Page bg | `#0B0E14` | `#F3F4F6` |
| Card bg | `#141925` | `#FFFFFF` |
| Input bg | `#1C2333` | `#F0F1F3` |
| Border | `#232A3B` | `#D1D5DB` |
| Primary text | `#F5F7FA` | `#1A1A1A` |
| Secondary text | `#8A93A6` | `#6B7280` |
| Accent (blue) | `#3B6DF0` | `#3B6DF0` (same) |
| Green | `#34D399` | `#16A34A` |
| Yellow | `#FBBF24` | `#D97706` |
| Red | `#F87171` | `#DC2626` |
| Grey | `#4B5263` | `#9CA3AF` |

---

## 8. Status Dots

All status dots are 8px circles with colored glow (`box-shadow`):

| Class | Color | Glow | Use |
|---|---|---|---|
| `.dot-positive` | green | green glow | Online, In Stock |
| `.dot-negative` | red | red glow | Offline, Empty slot |
| `.dot-accent` | blue | blue glow | Armed slot |
| `.dot-caution` | yellow | yellow glow + `pulse-dot` animation | Busy/Dispensing |
| `.dot-neutral` | grey | none | Idle, N/A, Inactive |

**Pulse animation:** Yellow caution dot pulses opacity 1 → 0.35 → 1 every 1.2 seconds.

---

## 9. Product Data

```js
const PRODUCT = {
  1: 'Detergent 1', 2: 'Detergent 2', 3: 'Fabcon 1',
  4: 'Fabcon 2', 5: 'Zonrox 1', 6: 'Zonrox 2',
};
const PRODUCT_INITIAL = { 1:'D1', 2:'D2', 3:'F1', 4:'F2', 5:'Z1', 6:'Z2' };
const PRODUCT_ML = { 1: 75, 2: 75, 3: 60, 4: 60, 5: 100, 6: 100 };  // ml dispensed per single press — display/label only, see note below
const ACTIVE = 5, TOTAL = 6;
const MAX_QTY = 10;  // max presses per staged item — placeholder, adjust to fit container sizes
```

**Product 6 stays the inactive placeholder slot** (per §4.5, `.inactive`, 30% opacity, no pointer events) — the physical unit for Zonrox 2 isn't wired up yet.

**No unit conversion:** `qty` is now a direct press count typed/stepped by the cashier — there is no amount-to-unit math anymore. `PRODUCT_ML` is used only to compute the read-only "total ml" hint shown on staged items (`qty × PRODUCT_ML[productId]`); it is never sent to coin_slot. The wire-level `qty` sent in `ARM`/`ARM_BATCH` is exactly the press count the cashier chose.

**Important — ml values are labels, not the control mechanism:** actual pour volume is governed by pump run-time (seconds) calibrated on the coin_slot/firmware side, not by anything in this dashboard. `PRODUCT_ML` exists purely so the cashier/customer sees an informational ml figure on the staged item — it has no effect on dispensing. Whenever the pump timing calibration changes, `PRODUCT_ML` must be updated by hand to keep the displayed figure accurate; the dashboard has no way to detect a mismatch.

---

## 10. PM2 Configuration

```js
{
  name: 'dashboard',
  cwd: './cashier_dashboard',
  script: 'server.js',
  interpreter: '/usr/bin/node',
  autorestart: true,
  restart_delay: 3000,
  log_file: './cashier_dashboard/pm2-dashboard.log',
}
```

**Note:** The `cwd` is relative to the project root. PM2 must be started from the project root directory.

---

## 11. Deployment Checklist

1. **Install dependencies:** `cd cashier_dashboard && npm install`
2. **Configure:** Edit `CONFIG/config.env` — set `SOCKET_IP` to the vendo machine's LAN IP
3. **Verify fonts:** All 8 `.woff2` files must exist in `public/fonts/`
4. **Start:** `pm2 start ecosystem.config.js --only dashboard` (or `node server.js` for testing)
5. **Access:** Open browser to `http://<cashier-lan-ip>:80`
6. **Phone access:** Open browser to `http://<cashier-lan-ip>:80` or scan QR at `/qr`

---

## 12. Known Issues & Gotchas

1. **Alert count inaccuracy:** The `renderAlerts()` function counts alerts using `issues.match(/list-row/g).length` — this counts `<div class="list-row">` occurrences in the HTML string. If the rendered HTML differs from what's in the string (e.g. due to DOM manipulation), the count is wrong.

2. **Water level mapping:** The Python script reads pins in order (`WATER_GPIO_PIN_1..4` from `config.env`) and sends them as `WTRLVL,v1,v2,v3,v4`. The C++ server maps these to `WLVL_PRESSED[1..4]`. If the physical sensor-to-slot wiring doesn't match the pin order in config.env, the dashboard shows the wrong slot as empty.

3. **SSE connection reset:** When the SSE reconnects (receives `data: connected`), the entire client state is reset — staged items, selected product, armed counts all go to zero. This is by design but can be jarring if the connection blips.

4. **Sale strip wrap:** On narrow screens, the staged items grid wraps — but `grid-template-rows: repeat(2, auto)` means only 2 rows are defined. If more than 6 items are staged (3 per row × 2 rows), layout may break.

5. **Slot 5 water sensor:** Hardcoded to `false` in coin_slot — slot 5 never shows as empty regardless of actual state.

6. **Demo mode clears on SSE:** The 4-second demo timeout populates dummy data, but it's immediately overwritten when the real SSE connection arrives. This is fine — the demo only shows if the machine is truly unreachable.

---

## 13. Modification Guide

### Adding a new product name
Edit the `PRODUCT` and `PRODUCT_INITIAL` objects in `index.html` (lines 680-683). The initial is shown in the product icon circle (1-2 chars max). Also add the product's calibrated per-press ml value to `PRODUCT_ML`.

### Changing the theme colors
Edit the `:root` block for dark theme, `[data-theme="light"]` block for light theme. All colors use CSS custom properties — change the variable values, not individual element styles.

### Adding a new API endpoint
1. Add the route handler in `server.js`
2. If it needs to reach coin_slot, use `sendToCoinSlot(command)` 
3. If it needs to push to browsers, use `broadcastSSE(data)`

### Changing the quantity stepper
No more preset buttons — quantity is set with a single stepper control (±1 step, min 1, max `MAX_QTY`). Adjust the cap by changing `MAX_QTY` (Section 9). If a product's calibrated volume changes, update its value in `PRODUCT_ML` — this only affects the read-only ml hint shown on staged items, not the `ARM_BATCH` payload.

### Changing font files
Replace `.woff2` files in `public/fonts/` and update the `@font-face` declarations (lines 15-22). Keep `font-display: swap` for performance.

---

## 14. Product Photography Integration

Six studio photos (`slot1.png`–`slot6.png`) replace the flat icon/color card backgrounds with real product shots.

### Slot mapping
Inferred from the marketing grid's reading order (left→right, top→bottom), cross-checked against the dashboard mockup which shows these exact photos already assigned to these exact slots:

| File | Slot | Product | Photo |
|---|---|---|---|
| `slot1.png` | 1 | Detergent 1 | Lavender pump bottle |
| `slot2.png` | 2 | Detergent 2 | Clear pump bottle |
| `slot3.png` | 3 | Fabcon 1 | Blue velvet pouch |
| `slot4.png` | 4 | Fabcon 2 | Copper/rose-gold pouch |
| `slot5.png` | 5 | Zonrox 1 | Cream ceramic jug |
| `slot6.png` | 6 | Zonrox 2 | Green ceramic jug |

Confirm this before implementation if it's not what you intended — it's an inference, not something stated outright.

### A note on `reference.png`
It's an AI-generated mockup, not a real screenshot — some on-screen text is a garbled artifact of that generation and shouldn't be implemented literally: the theme toggle reads "DANK" (should read "Dark"), the top-right button is illegible placeholder text, status reads "Idie" instead of "Idle", and the card watermark reads "SABON-PRO" instead of the actual "SABON-EXPRESS" branding baked into the source photos. Treat the mockup as a layout/style reference only — copy the composition, not the strings.

### Card visual pattern to replicate
- **Photo zone is square, not full-bleed landscape.** The mockup's photos are wide crops from the marketing grid (~1.7:1), but your actual source files are 1:1. Rather than stretching or center-cropping a square image into a landscape card (which will chop off pump tops, jug handles, or pouch caps depending on how each photo is composed), size the photo zone to be a true square matching the card's own height — e.g. if the card is 160px tall, the photo zone is 160×160px. At that ratio, `background-size: cover` and `contain` produce an identical, uncropped result, since the box and image share the same aspect ratio. This is a small deviation from the mockup's proportions (the photo zone reads a bit narrower relative to the text panel) but avoids fighting the source assets.
- Text panel fills the remaining width (card width − card height) to the right of the photo zone.
- A light gradient scrim over the boundary between photo zone and text panel (not the whole card) keeps the "SLOT 0X" label and initial badge legible where they sit close to the photo edge.
- Content sits in the text panel, left-aligned, stacked top to bottom: tiny caps "SLOT 0X" label → circular initial badge (D1/D2/F1/F2/Z1/Z2) → product name (bold) → large armed-qty number → status row (dot + label).
- Text stays dark/near-black. Double check contrast right at the photo/panel boundary specifically, since that's the narrowest part of the scrim.

### Implementation notes
- Place assets at `cashier_dashboard/public/images/slot1.png`…`slot6.png` (adjust to match the actual static-assets convention already in use).
- Use `background-image`, not `<img>` — a missing file then fails gracefully to the card's existing solid pastel background-color instead of showing a broken-image icon. Keep the current per-product background-colors in place as that fallback.
- **Source photos are 1:1 (square)**, confirmed. Don't export/crop them down to a landscape ratio to chase the mockup's proportions exactly — that reintroduces the cropping problem the square photo-zone above avoids. If you'd rather keep the mockup's wider photo-to-text-panel ratio than a square zone gives you, the only way to do that without auto-cropping badly is a manual pre-crop pass per photo (by hand, choosing the framing per product) rather than a single CSS `background-position` value applied to all six — a pump-top bottle and a low, wide jug won't crop the same way.
- **Slot 6 open question:** you'd earlier flagged Zonrox 2 as physically unwired/unavailable, so slot 6 keeps the existing `.inactive` treatment (30% opacity, non-interactive) per §9. The mockup renders it as a fully active card with its own status dot instead — I'd keep it `.inactive` (just with the new photo) unless the machine's actually been wired up since. Say so if that's changed.
