# Sabon Vendo — Cashier Dashboard

> **Comprehensive documentation** for the cashier dashboard subsystem.
> Read this before modifying anything. Intended for developers and Claude instances.

---

## 1. Overview

The cashier dashboard is a **single-page web app** that a cashier uses to sell soap products. The cashier selects products, assigns credit amounts in multiples of ₱5, and arms them via a TCP connection to the **C++ `coin_slot` server** (the dispenser machine). Customers then press physical buttons on the vendo machine to dispense — each press consumes one ₱5 unit from the armed credit on that slot.

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
| `POST` | `/api/unclaimed/resolve` | `{slot, qty, amount, action}` | Retry or dismiss unclaimed sale |
| `GET` | `/qr` | — | Redirects to a QR code of the LAN URL |
| `GET` | `/api/status/stream` | — | SSE stream for live STATUS |

**ARM batch mode (preferred):** `{saleId: "SALE-...", batch: "1:3,2:1,3:5"}` → sends `ARM_BATCH,1:3,2:1,3:5` to coin_slot. All slots are armed atomically.

**ARM legacy mode:** `{saleId: "SALE-...", items: [{productId:1,qty:3}, ...]}` → sends individual `ARM,1,3` commands. Still supported but batch is preferred.

**Double-click guard:** `processedSaleIds` Set stores sale IDs. Duplicate sale IDs are rejected with `{success: false, duplicate: true}`. The Set is trimmed when it exceeds 1000 entries.

### 3.5 Unclaimed Sales

When a sale is armed but something goes wrong (e.g. machine goes offline mid-transaction), the sale is tracked in:
- **In-memory:** `unclaimedSales[]` array
- **On-disk:** `.unclaimed_sales.json` (survives server restarts)
- **SSE:** Pushed to all connected browsers as `UNCLAIMED:<slot>,<qty>,<amount>,<timestamp>`

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

**Heading font:** Poppins (used for: KPI labels, KPI values, status bar, product slot labels, product icons, armed quantities, list values, amounts, buttons)

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
│ SALE STRIP: [Staged Items Grid] [Quick Amounts]    │
│             [Add Amount] [Clear] [Arm] [Total]      │
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
2. **Choose amount** — Click P5/P10/P15/P20 quick button, OR click "Add Amount" to open the stepper (custom amount, multiple of ₱5, max ₱50)
3. **Item staged** — Appears as a card in the sale strip with product name, amount (e.g. "P15"), and × remove button
4. **Add more products** — Repeat steps 1-3 for different products
5. **Amount mapping:** `P5=1unit, P10=2units, P15=3units, P20=4units` — each unit is one ₱5 credit / one button press
6. **"Select All" button** — Selects all active non-empty slots at once (multi-select mode). Quick-amount or Add Amount then stages ALL selected products simultaneously
7. **Arm** — Sends `ARM_BATCH,<slot1>:<qty1>,<slot2>:<qty2>,...` via the server to coin_slot
8. **Customer dispenses** — Presses physical buttons on the vendo machine

### 4.7 Multi-Select Mode

Triggered by the "Select All Products" button below the grid. In multi-select mode:
- All active non-empty product cards show as "selected" (blue border + glow)
- Clicking a quick-amount button stages ALL selected products with that amount
- "Add Amount" confirms for all selected products
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
| `staged` | `Array` | Sale strip staged items: `[{id, name, amt, qty}, ...]` |
| `unclaimed` | `Array` | Unclaimed sales from SSE: `[{slot, qty, amount, time}, ...]` |
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
  1: 'Deesh Premium', 2: 'Lanz Blossom', 3: 'Lanz Dainty',
  4: 'Switch', 5: 'Slot 5', 6: 'Slot 6',
};
const PRODUCT_INITIAL = { 1:'D', 2:'LB', 3:'LD', 4:'S', 5:'5', 6:'6' };
const AMOUNT_QTY = { 5:1, 10:2, 15:3, 20:4 };  // ₱ → units
const ACTIVE = 5, TOTAL = 6;
```

**Amount-to-unit mapping:** Every ₱5 = 1 unit. P5→1 unit, P10→2 units, P15→3 units, P20→4 units. Custom amounts follow same rule: `qty = Math.round(amount / 5)`.

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
Edit the `PRODUCT` and `PRODUCT_INITIAL` objects in `index.html` (lines 680-683). The initial is shown in the product icon circle (1-2 chars max).

### Changing the theme colors
Edit the `:root` block for dark theme, `[data-theme="light"]` block for light theme. All colors use CSS custom properties — change the variable values, not individual element styles.

### Adding a new API endpoint
1. Add the route handler in `server.js`
2. If it needs to reach coin_slot, use `sendToCoinSlot(command)` 
3. If it needs to push to browsers, use `broadcastSSE(data)`

### Changing the amount buttons
Edit the quick-amount buttons in the HTML (lines 623-627) and update `AMOUNT_QTY` mapping (line 684). Custom amount stepper uses ±5 step, capped at min 5, max 50.

### Changing font files
Replace `.woff2` files in `public/fonts/` and update the `@font-face` declarations (lines 15-22). Keep `font-display: swap` for performance.
