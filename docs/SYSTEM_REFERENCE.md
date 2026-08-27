# Sabon Express Dispenser — Complete System Reference

> **Audience:** Developers and Claude instances picking up this codebase with zero prior context.
> **Last updated:** 2026-08-25
> **Covers:** Cashier dashboard (web UI + Node.js server), controller (C++ dispenser), water-level monitoring (Python), PM2 process management.

---

## 1. System Architecture

```
┌─────────────────────────┐     TCP (port 8080)     ┌──────────────────────┐
│   VENDO MACHINE (RPi)   │ ◄──────────────────────► │  CASHIER MACHINE      │
│                         │                          │                       │
│  controller (C++ binary) │                          │  dashboard server     │
│  - GPIO: buttons, pumps │                          │  (Node.js :80)        │
│  - GPIO: LEDs, sensors  │                          │  - HTTP API           │
│  - TCP server :8080     │                          │  - SSE stream         │
│  - STATUS every 500ms   │                          │  - TCP proxy          │
│                         │                          │                       │
│  water_level_monitoring │                          │  Browser (cashier)    │
│  (Python, reads GPIO)   │                          │  - index.html         │
│  - WTRLVL output        │                          │  - fully offline      │
└─────────────────────────┘                          └──────────────────────┘
```

**Two physical machines on the same LAN:**

| Machine | Role | Software |
|---------|------|----------|
| **Vendo (Raspberry Pi)** | Physical dispenser | `controller` C++ binary (TCP :8080), `water_level_monitoring_v2.py` |
| **Cashier (RPi or any machine)** | Sales terminal | Node.js Express server (:80), browser-based dashboard |

The dashboard server is the **bridge**: browsers connect to it via HTTP/SSE, and it proxies commands to `controller` over TCP. The browser never talks directly to the vendo machine.

---

## 2. Complete File Layout

```
sabon-vendo-cashier/
├── docs/                            # All documentation (this file lives here)
│
├── CONFIG/
│   └── config.env.sample            # Pin mappings, calibration, IP/port config
│
├── controller/                       # C++ dispenser controller
│   └── main                         # Compiled binary (TCP server :8080)
│
├── cashier_dashboard/
│   ├── server.js                    # Node.js Express server (port 80)
│   ├── package.json                 # Single dependency: express ^4.21.0
│   ├── CASHIER_DASHBOARD.md         # Older dashboard doc (some sections outdated)
│   ├── .unclaimed_sales.json        # Persisted unclaimed sales (auto-created)
│   ├── pm2-dashboard.log            # PM2 log (auto-created)
│   │
│   └── public/
│       ├── index.html               # THE ENTIRE UI — HTML + CSS + JS (~1000 lines)
│       │
│       │   ├── slot1.png            # Product photos, 1024×1024 PNG
│       │   ├── slot2.png
│       │   ├── slot3.png
│       │   ├── slot4.png
│       │   ├── slot5.png
│       │   └── slot6.png
│       │
│       └── fonts/
│           ├── inter-v20-latin-regular.woff2
│           ├── inter-v20-latin-500.woff2
│           ├── inter-v20-latin-600.woff2
│           ├── inter-v20-latin-700.woff2
│           ├── poppins-v24-latin-regular.woff2
│           ├── poppins-v24-latin-500.woff2
│           ├── poppins-v24-latin-600.woff2
│           └── poppins-v24-latin-700.woff2
│
│
├── CASHIER_DASHBOARDMOD.md          # Spec: sale flow redesign (implemented)
├── CASHIER_DASHBOARDplan2.md        # Spec: photo integration plan (implemented)
└── PRODUCT_CARD_LAYOUT_FIX.md       # Spec: badge removal + padding fix (implemented)
```

**Key design choice:** The dashboard UI is a single self-contained `index.html`. No separate CSS/JS files. No CDN dependencies. Fonts are local `.woff2` files loaded via `@font-face` with `font-display: swap`. Product images are local PNGs. Everything works fully offline.

---

## 3. Configuration (`CONFIG/config.env`)

Loaded by `server.js` at startup. Format is `KEY = VALUE` (or `KEY=VALUE`). Values can be quoted.

| Variable | Default | Used By | Description |
|----------|---------|---------|-------------|
| `SOCKET_IP` | `127.0.0.1` | server.js | controller TCP host |
| `SOCKET_PORT` | `8080` | server.js | controller TCP port |
| `DASHBOARD_PORT` | `80` | server.js | HTTP port for dashboard |
| `vendorId` | — | controller | Vendor identifier |
| `machineId` | `1` | controller | Machine identifier |
| `BTN1`–`BTN6` | 14,24,25,10,13,23 | controller | Button GPIO pins (BCM) |
| `PUMP1`–`PUMP6` | 15,16,6,17,18,12 | controller | Pump GPIO pins (BCM) |
| `LED1`–`LED6` | 5,27,4,22,19,7 | controller | LED GPIO pins (BCM) |
| `PUMP_TRIGGER_HIGH` | `0` | controller | Pump active-high/low |
| `WATER_GPIO_PIN_1`–`_6` | 26,20,21,11,8,9 | water_level | Water sensor GPIO pins (BCM), one per slot |
| `calibrateProduct1`–`6` | compiled defaults (5, 2.77), (5, 1.36), (5, 1.25), (5, 2.0), (5, 2.0), (5, 2.0) | controller | Pump calibration (units, ml-per-sec). Slot 6 mirrors slot 5. |
| `TRANSACTION_DIR` | — | controller | Transaction log directory |
| `API_BASE_URL` | — | controller | Cloud API endpoint |
| `PUMP_START_COOLDOWN_MS` | `200` | controller | Delay between pump starts |

---

## 4. PM2 Process Registration

There is no ecosystem file. `setup_and_run.sh` registers every process with
the PM2 CLI directly, under root (`sudo pm2`), and `sudo pm2 save` persists
the list so the systemd hook resurrects it on boot.

| PM2 name | Runs |
|----------|------|
| `01_Dispenser_Controller` | `controller/main` |
| `02_Water_Sensors` | `uploaderTransaction/water_level_monitoring_v2.py` |
| `03_Transaction_Uploader` | `uploaderTransaction/uploader.py` |
| `04_Status_Uploader` | `uploaderTransaction/status_uploader.py` |
| `05_Cashier_Dashboard` | `cashier_dashboard/server.js` |

Python processes run under `uploaderTransaction/venv/bin/python3`. The
dashboard binds `DASHBOARD_PORT` (default 80), which is why it needs root.

---

## 5. Server — `cashier_dashboard/server.js`

### 5.1 Overview

A Node.js Express server (port 80) that:
- Serves the static dashboard UI from `public/`
- Maintains a persistent TCP connection to `controller` (port 8080)
- Proxies ARM/CANCEL commands from browser → controller over TCP
- Broadcasts controller STATUS lines to all browsers via SSE
- Tracks unclaimed sales (persisted to disk)
- Provides a QR code endpoint for phone access

### 5.2 TCP Proxy to controller

```
Browser ──HTTP POST──► server.js ──TCP write──► controller (:8080)
```

**Connection lifecycle:**
1. `connectToCoinSlot()` opens a TCP socket on startup
2. On connect: flushes `localArmQueue[]` (offline-queued commands)
3. On data: splits on `\n`, broadcasts any line starting with `STATUS` to all SSE clients
4. On error: logs and continues
5. On close: waits 3 seconds, then reconnects

**Offline queue:** If `controller` is unreachable when a command is sent, the command is pushed to `localArmQueue[]` and automatically flushed when the connection is re-established.

### 5.3 SSE (Server-Sent Events)

**Endpoint:** `GET /api/status/stream`

On client connect:
1. Sends `data: connected\n\n` — triggers a full client-side state reset
2. Pushes any existing unclaimed sales as `UNCLAIMED:slot,qty,timestamp`
3. Starts a 15-second keep-alive heartbeat (`:keepalive\n\n`) to prevent browser timeout
4. On `req.on('close')`: clears the keep-alive interval, removes client from `sseClients` Set

Thereafter, every `STATUS` line from controller is forwarded verbatim to all connected SSE clients.

`broadcastSSE(data)` writes to every response object in `sseClients`. Failed writes are silently caught.

### 5.4 API Endpoints

| Method | Path | Request Body | Response | Description |
|--------|------|-------------|----------|-------------|
| `POST` | `/api/arm` | `{saleId, batch}` or `{saleId, items}` | `{success, queued?, saleId}` | Arm product slots |
| `POST` | `/api/cancel` | `{productId}` | `{success}` | Cancel one armed slot |
| `POST` | `/api/cancel-all` | `{}` | `{success}` | Cancel ALL armed slots + queues |
| `POST` | `/api/cancel-queue` | `{productId}` | `{success}` | Clear pending queue for one slot |
| `POST` | `/api/unclaimed/resolve` | `{slot, qty, action}` | `{success}` | Retry or dismiss unclaimed sale |
| `GET` | `/api/status/stream` | — | SSE stream | Live STATUS + UNCLAIMED events |
| `GET` | `/qr` | — | 302 redirect | QR code of LAN URL |

**`/api/arm` — Batch mode (preferred):**
```json
// Request
{ "saleId": "SALE-1692000000000-1", "batch": "1:3,2:1,3:5" }
// Sends to controller: ARM_BATCH,1:3,2:1,3:5
// Response
{ "success": true, "saleId": "SALE-1692000000000-1" }
```

**`/api/arm` — Legacy mode:**
```json
// Request
{ "saleId": "...", "items": [{ "productId": 1, "qty": 3 }] }
// Sends to controller: ARM,1,3
// Response
{ "saleId": "...", "results": [{ "productId": 1, "qty": 3, "success": true }] }
```

**Double-click guard:** `processedSaleIds` is a Set of sale IDs. Duplicate `saleId` values return `{success: false, duplicate: true}`. The set is trimmed to 500 entries when it exceeds 1000.

### 5.5 Unclaimed Sales

When a sale can't be completed (e.g., machine goes offline mid-transaction):
- Stored in memory: `unclaimedSales[]` — each entry is `{slot, qty, time}`
- Persisted to disk: `.unclaimed_sales.json` (loaded on startup)
- Pushed to SSE clients: `UNCLAIMED:slot,qty,timestamp`
- Resolved via `/api/unclaimed/resolve` with action `"retry"` (re-arms) or `"dismiss"` (removes)

**Note:** The `amount` field was removed — qty is now a direct press count, not a peso amount.

---

## 6. Client — `cashier_dashboard/public/index.html`

### 6.1 Font Stack

| Role | Font | Weights | Fallback |
|------|------|---------|----------|
| Headings, KPIs, labels, quantities | Poppins | 400, 500, 600, 700 | `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` |
| Body text, product names | Inter | 400, 500, 600, 700 | `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` |

All 8 `.woff2` files loaded via `@font-face` with `font-display: swap`. Fully offline — no Google Fonts CDN.

### 6.2 Design System (CSS Custom Properties)

**Dark theme (`:root` — default):**

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-surface-primary` | `#0B0E14` | Page background |
| `--bg-surface-secondary` | `#141925` | Card/section background |
| `--bg-surface-tertiary` | `#1C2333` | Input/element background |
| `--border-default` | `#232A3B` | Subtle borders |
| `--border-strong` | `#3B6DF0` | Accent/selected borders (BLUE) |
| `--text-content-primary` | `#F5F7FA` | Primary text |
| `--text-content-secondary` | `#8A93A6` | Secondary/muted text |
| `--accent-action` | `#3B6DF0` | Buttons, highlights (BLUE) |
| `--accent-action-hover` | `#507DF4` | Button hover |
| `--status-positive` | `#34D399` | Green — online, in-stock |
| `--status-caution` | `#FBBF24` | Yellow — busy, dispensing |
| `--status-negative` | `#F87171` | Red — offline, empty |
| `--status-neutral` | `#4B5263` | Grey — idle, inactive |
| `--radius-container` | `14px` | Section border radius |
| `--radius-element` | `8px` | Button/input border radius |
| `--radius-pill` | `999px` | Pill button border radius |

**Light theme (`[data-theme="light"]`):**

| Token | Light Value |
|-------|-------------|
| `--bg-surface-primary` | `#F3F4F6` |
| `--bg-surface-secondary` | `#FFFFFF` |
| `--bg-surface-tertiary` | `#F0F1F3` |
| `--border-default` | `#D1D5DB` |
| `--text-content-primary` | `#1A1A1A` |
| `--text-content-secondary` | `#6B7280` |
| `--status-positive` | `#16A34A` |
| `--status-caution` | `#D97706` |
| `--status-negative` | `#DC2626` |
| `--status-neutral` | `#9CA3AF` |

Theme toggle persists in `localStorage` key `sabon-theme`. Default on first visit is light (`data-theme="light"` on `<html>`).

### 6.3 Layout Structure

```
┌──────────────────────────────────────────────────────────────┐
│ STATUS BAR    ● Online │ Machine 001 │ [PAUSED] │ [DARK] │ 14:30:00 │
├──────────────────────────────────────────────────────────────┤
│ OFFLINE BANNER (hidden when online, red background)          │
├──────────────────────────────────────────────────────────────┤
│ KPI ROW   [Total Armed] [In Stock] [Phase] [Today]           │
├──────────────────────────────────────────────────────────────┤
│ SALE STRIP  [Staged Items Grid]  [− 1 +] [Stage] [Clear] [Arm] [0 presses] │
├───────────────────────────────────────┬──────────────────────┤
│ PRODUCT GRID (3×2, photo cards)      │ RIGHT PANEL          │
│ ┌────────┬──────────┐ ┌────────┬───┐ │ Armed (auto-hide)    │
│ │ PHOTO  │ SLOT 01  │ │ PHOTO  │ … │ │ Dispensing (auto-hide)│
│ │ ZONE   │ Detergent│ │ ZONE   │   │ │ Attention (auto-hide) │
│ │150px □ │ 1        │ │        │   │ │ Alerts (auto-hide)    │
│ │        │     2    │ │        │   │ │                       │
│ │        │ ● Armed  │ │        │   │ │                       │
│ └────────┴──────────┘ └────────┴───┘ │                       │
│ [same for slots 3-6, 2 rows of 3]    │                       │
│ [Select All Products] button         │                       │
└───────────────────────────────────────┴──────────────────────┘
```

### 6.4 Product Card Design (Photo Cards)

Each card is a **CSS Grid**: `grid-template-columns: 150px 1fr` — photo zone + text panel.

```
┌──────────────┬─────────────────────┐
│              │ SLOT 01             │  ← slot-num (8px Poppins, uppercase)
│   PHOTO      │                     │
│   ZONE       │ Detergent 1         │  ← product-name (13px Inter, semibold)
│  150px □     │                     │
│  bg-image    │      2              │  ← armed-qty (32px Poppins, bold)
│  + fallback  │                     │
│  color       │ ● Armed             │  ← status-row (10px, colored dot + label)
│              │                     │
│  ← scrim →   │                     │  ← 40px gradient fade at boundary
└──────────────┴─────────────────────┘
```

**Photo zone:**
- `background-image: url(images/slotN.png)` with `background-size: cover`
- Fallback: `background-color` per product (see Section 7)
- Gradient scrim (`::after` pseudo-element): 40px fade from transparent → card background at the photo/text boundary
- Square aspect: photo zone width matches card height (no explicit height — fills the grid row)

**Text panel:**
- `padding: 12px 14px 12px 28px` — 28px left padding gives breathing room from photo edge
- Stacked vertically with `gap: 1px`
- Elements: slot-num → product-name → armed-qty → status-row
- **No circular initial badge** — removed as redundant (product photo + name identify the slot)

**Card states:**

| State | CSS Class | Border | Qty Color | Status Dot |
|-------|-----------|--------|-----------|------------|
| Idle | `.product-card` | default grey | `#3A4050` (grey) | Grey "Idle" |
| Selected | `+ .selected` | blue + glow | — | — |
| Armed | `+ .armed` | blue | accent blue | Blue "Armed" |
| Busy | `+ .busy` | yellow | caution yellow | Yellow pulsing "Busy" |
| Empty | `+ .empty` | red | — | Red "Empty" |
| Inactive | `+ .inactive` | default grey (30% opacity) | "N/A" | Grey "N/A" |

**Empty state note:** `.product-card.empty` has `pointer-events: none` and a red border, but **no opacity reduction** — the product photo remains fully visible so cashiers can still identify the product.

### 6.5 Responsive Breakpoints

| Breakpoint | Changes |
|------------|---------|
| **Default (>768px)** | 3×2 product grid, photo zone 150px, main two-column (grid + 260px panel), 4-column KPIs |
| **≤768px** | Main single-column, 2×3 product grid, photo zone 120px, KPIs stay 4-column, sale controls wrap |
| **≤480px** | KPIs 2×2, photo zone 100px, reduced font/padding throughout, sale controls multi-row |

### 6.6 JavaScript — State Management

#### Global State Object `S`

```js
const S = {
  armedQty:    new Array(TOTAL + 1).fill(0),   // [1..6] armed press count per slot (index 0 unused)
  remaining:   new Array(TOTAL + 1).fill(0),   // [1..6] remaining pump time in ms
  wlvl:        new Array(TOTAL + 1).fill(false), // [1..6] water level empty (true = empty/out of stock)
  busy:        new Array(TOTAL + 1).fill(false), // [1..6] pump is currently running
  queueDepth:  new Array(TOTAL + 1).fill(0),   // [1..6] pending button-press queue depth
  paused:      false,                  // machine paused state
  phase:       0,                      // 0=IDLE, 1=ARMED, 2=DISPENSING, 3=COMPLETE
  bundleComplete: false,               // all armed credits consumed
  lastUpdate:  null,                   // Date of last STATUS received (null = no data yet)
  connected:   false,                  // SSE connection is alive
};
```

**Important:** All arrays are index 1–6 for slots. Index 0 is unused padding.

#### Other State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `selProduct` | `number\|null` | Currently selected product slot (1–6), or null |
| `multiSelect` | `boolean` | "Select All" mode active |
| `staged` | `Array` | Items staged for sale: `[{id, name, qty, ml}, ...]` |
| `unclaimed` | `Array` | From SSE: `[{slot, qty, time}, ...]` |
| `currentQty` | `number` | Stepper value (1–MAX_QTY=10) |
| `saleCtr` | `number` | Incrementing counter for unique sale IDs |
| `dispenseCount` | `number` | Total dispenses this session (counter) |
| `prevBusy` | `Array[7]` | Previous busy snapshot for dispense edge detection |

### 6.7 SSE `parse()` — STATUS Format

Parses comma-separated STATUS lines from controller. Expects **at least 34 fields**
(`5 * TOTAL_SLOTS + 4`, with `TOTAL_SLOTS = 6`):

```
STATUS,<armedQty1..6>,
       <remaining1..6>,
       <wlvl1..6>,
       <busy1..6>,
       <queueDepth1..6>,
       <paused>,<phase>,<bundleComplete>
```

| Field Group | Indices | Values |
|-------------|---------|--------|
| armedQty[1..6] | 1–6 | Integer (press count) |
| remaining[1..6] | 7–12 | Integer (ms remaining) |
| wlvl[1..6] | 13–18 | `0` = has liquid, `1` = empty |
| busy[1..6] | 19–24 | `0` = idle, `1` = dispensing |
| queueDepth[1..6] | 25–30 | Integer (pending presses) |
| paused | 31 | `0` = normal, `1` = paused |
| phase | 32 | `0`=IDLE, `1`=ARMED, `2`=DISPENSING, `3`=COMPLETE |
| bundleComplete | 33 | `0` = not complete, `1` = complete |

Lines with fewer than 34 fields are silently ignored
(`if (p.length < STATUS_FIELDS) return`, where `STATUS_FIELDS = 5 * ACTIVE + 4`).

**Three parsers share this layout** and must change together: `build_status_response()`
in `controller/src/socket_server.cpp`, `parse()` in `public/index.html`, and
`preprocess_data()` in `uploaderTransaction/status_uploader.py`.

### 6.8 UNCLAIMED Format (SSE)

```
UNCLAIMED:<slot>,<qty>,<timestamp>
```

Example: `UNCLAIMED:3,5,2026-08-12T06:30:00.000Z`

Note: No `amount` field — qty is the direct press count.

### 6.9 SSE Connection Lifecycle

1. `connectSSE()` creates an `EventSource` to `/api/status/stream`
2. On `message` event with `data: connected` → resets all state to zero, calls `refresh()`
3. On `message` event with `STATUS,...` → calls `parse()` → updates `S` → calls `refresh()`
4. On `message` event with `UNCLAIMED:...` → calls `addUnclaimed()`
5. On `error` event → sets `S.connected = false`, calls `refresh()` (shows offline banner)
6. 15-second server-side keep-alive (`:keepalive\n\n`) prevents idle timeout

### 6.10 Demo/Skeleton Mode

If no STATUS data arrives after **4 seconds** (`!S.lastUpdate`), the dashboard populates demo data so the UI isn't blank:

| Slot | State |
|------|-------|
| 1 | Armed (qty=2) |
| 2 | Armed (qty=1), queueDepth=1 |
| 3 | Busy (dispensing) |
| 4 | Empty (water level) |
| 5 | Idle |
| 6 | Armed (qty=3) + busy |

**Trigger changed from `!S.connected` to `!S.lastUpdate`** (2026-08-12) because the SSE connection succeeds immediately even without a controller — it's the absence of STATUS data that indicates nothing is running.

### 6.11 Sale Flow

1. **Select product** — Click a product card (only active, non-empty slots are clickable). Card gets blue border + glow.
2. **Set quantity** — Use the ± stepper (1 to MAX_QTY=10). Default is 1 press.
3. **Stage** — Click "Stage" button. Item appears as a card in the sale strip showing product name + "N× · Xml".
4. **Merge behavior** — Staging the same product again adds to its existing qty (doesn't create a duplicate card).
5. **Multi-select** — "Select All Products" button selects all active non-empty slots. Staging then stages ALL selected products at once.
6. **Clear** — Removes all staged items.
7. **Arm** — Sends `ARM_BATCH,slot1:qty1,slot2:qty2,...` via `/api/arm`. On success, clears staged items. On failure, shows error toast.
8. **Customer dispenses** — Presses physical buttons on the vendo machine.

**Qty is press count, not peso amount.** There is no pricing logic in the dashboard. Each unit = one button press = one dispense cycle.

### 6.12 Right Panel Sections

All four sections auto-hide (`display: none`) when they have no content:

| Section | Left Border | Shows | Content |
|---------|-------------|-------|---------|
| Armed | Blue | When any slot has `armedQty > 0` or `busy` | Per-slot: dot, name, qty count, Cancel button. "Clear All Credits" at bottom. |
| Dispensing | Green | When any slot has `busy = true` | Per-slot: name, progress % (from `remaining`). |
| Attention | Purple | When `unclaimed[]` is non-empty | Per-entry: slot, qty, "Retry" and "Dismiss" buttons. |
| Alerts | Red | When empty slots or offline | Alert count heading, per-issue row (empty slots, offline). |

### 6.13 KPI Cards

| KPI | Source | Top Border |
|-----|--------|------------|
| **Total Armed** | `sum(armedQty[1..6])` | Blue |
| **In Stock** | `count(slots 1..6 where !wlvl[s])` | Green; color: 6=green, 3–5=yellow, 0–2=red |
| **Phase** | `S.phase` → "IDLE"/"ARMED"/"DISPENSING"/"COMPLETE" | Yellow |
| **Today** | `dispenseCount` (incremented on busy false→true edge) | Purple |

### 6.14 Status Dots

All 8px circles with colored `box-shadow` glow:

| Class | Color | Glow | Animation | Used For |
|-------|-------|------|-----------|----------|
| `.dot-positive` | Green | Green | None | Online, In Stock |
| `.dot-negative` | Red | Red | None | Offline, Empty slot |
| `.dot-accent` | Blue | Blue | None | Armed slot |
| `.dot-caution` | Yellow | Yellow | `pulse-dot` (1.2s) | Busy/Dispensing |
| `.dot-neutral` | Grey | None | None | Idle, N/A |

### 6.15 Toast Notifications

Fixed to bottom-center. Three variants: default (dark bg), `.success` (green border), `.error` (red border). Auto-hides after 2.6 seconds via `setTimeout`.

### 6.16 Key Helper Functions

| Function | Purpose |
|----------|---------|
| `$(id)` | Shorthand for `document.getElementById(id)` |
| `toast(msg, type)` | Show toast notification |
| `refresh()` | Master refresh — calls all render functions + status + KPIs |
| `connectSSE()` | Create EventSource, wire message/error handlers |
| `parse(raw)` | Parse STATUS CSV line into `S` object |
| `renderGrid()` | Generate product card HTML, attach click handlers |
| `selectProduct(id)` | Select a product slot (exits multi-select mode) |
| `stageItem(id)` | Add/merge product into staged array |
| `renderStaged()` | Render staged items in sale strip |
| `removeStaged(i)` | Remove staged item by index |
| `updateArm()` | Enable/disable Arm button, update its label |
| `executeArm()` | POST to `/api/arm` with ARM_BATCH payload |
| `cancelSlot(id)` | POST to `/api/cancel` for one slot |
| `cancelAll()` | POST to `/api/cancel-all` |
| `renderArmed()` | Right panel — armed slots list |
| `renderQueue()` | Right panel — dispensing slots list |
| `renderAlerts()` | Right panel — empty slots + offline alerts |
| `renderUnclaimed()` | Right panel — unclaimed sales list |
| `addUnclaimed(raw)` | Parse UNCLAIMED SSE message |
| `resolveUnclaimed(idx, action)` | POST to `/api/unclaimed/resolve` |

---

## 7. Product Data

```js
const PRODUCT = {
  1: 'Detergent 1', 2: 'Detergent 2', 3: 'Fabcon 1',
  4: 'Fabcon 2', 5: 'Zonrox 1', 6: 'Zonrox 2',
};

const PRODUCT_INITIAL = { 1:'D1', 2:'D2', 3:'F1', 4:'F2', 5:'Z1', 6:'Z2' };
// NOTE: PRODUCT_INITIAL is currently unused in the rendered UI
// (the circular badge was removed). Kept for potential future use.

const PRODUCT_ML = { 1: 75, 2: 75, 3: 60, 4: 60, 5: 100, 6: 100 };
// Milliliters per press — shown in staged item cards (display only, not sent to controller)

const PRODUCT_BG = {
  1: '#C7B3E5',  // lavender
  2: '#D6EAF8',  // light blue
  3: '#A9CCE3',  // blue
  4: '#E8C4A2',  // copper
  5: '#F5F0E6',  // cream
  6: '#C5D5C0',  // sage green
};
// Fallback background colors for product cards when images are missing

const ACTIVE = 6;  // All 6 physical slots are wired and live
const TOTAL = 6;   // Display 6 cards
const MAX_QTY = 10; // Maximum press count per staging operation

// STATUS field count, derived so it cannot drift from the C++ wire format
const STATUS_FIELDS = 5 * ACTIVE + 4;  // 34
```

---

## 8. Communication Protocol Summary

### 8.1 Browser → Server (HTTP JSON)

All POSTs to `/api/*` with `Content-Type: application/json`. See Section 5.4 for full endpoint specs.

### 8.2 Server → controller (TCP Plain Text)

| Command | Format | Effect |
|---------|--------|--------|
| `ARM_BATCH` | `ARM_BATCH,s1:q1,s2:q2,...` | Arm multiple slots atomically |
| `ARM` | `ARM,productId,qty` | Arm one slot (legacy, still supported) |
| `CANCEL` | `CANCEL,productId` | Cancel armed credit for one slot |
| `CANCEL_ALL` | `CANCEL_ALL` | Cancel ALL armed credits + clear all queues |
| `CANCEL_QUEUE` | `CANCEL_QUEUE,productId` | Clear pending queue for one slot |

Qty values represent **press count** (not peso amount).

### 8.3 controller → Server (TCP, STATUS broadcast)

controller sends `STATUS,...` lines every ~500ms and on state changes. Format documented in Section 6.7.

### 8.4 Server → Browser (SSE)

- `data: connected\n\n` — sent once on SSE connect
- `data: STATUS,...\n\n` — forwarded from controller
- `data: UNCLAIMED:slot,qty,time\n\n` — unclaimed sale notification
- `:keepalive\n\n` — heartbeat every 15s (SSE comment, ignored by browser)

---

## 9. Water Level Monitoring

A separate Python script (`water_level_monitoring_v2.py`) runs on the Pi, reads 6 GPIO pins (BCM 26, 20, 21, 11, 8, 9 per config), and outputs `WTRLVL,v1,...,v6` values. The controller C++ binary reads these and maps them to `WLVL_PRESSED[1..6]` which become the `wlvl[1..6]` fields in the STATUS broadcast.

**Sensor count is negotiated by field count.** `controller` accepts either 6 values (one per slot, current wiring) or the legacy 4. With 4, slots 5 and 6 fall back to "has liquid" so they are never blocked from dispensing. Any other count is logged as malformed and ignored.

---

## 10. controller — C++ Core Controller

The central dispenser controller. A C++ TCP server (port 8080) that manages all hardware and dispense logic.

### 10.1 Source Structure

```
controller/
├── main.cpp                    # Entry point: signal handlers, main loop (1ms tick)
├── Makefile                    # OS-aware build (Linux wiringPi / Windows mock)
├── main                        # Compiled binary
├── includes/
│   ├── app_state.h             # AppState struct, TxnPhase enum
│   ├── hardware_config.h       # Pin map, Product struct, TOTAL_SLOTS=6
│   ├── pump_control.h          # Pump state machine, GPIO interrupts
│   ├── socket_server.h         # Non-blocking multi-client TCP server
│   ├── transaction.h           # JSON transaction file writing
│   ├── utils.h                 # Config loader, logging, state persistence
│   └── voucher_manager.h       # Legacy voucher queue (retained for compatibility)
├── src/                        # Corresponding .cpp implementations
├── mock/wiringPi.{h,cpp}       # Windows GPIO stubs
└── tests/                      # 17 test files, 95+ unit tests
    └── fixtures/test.env
```

### 10.2 AppState (core state struct)

```cpp
struct AppState {
    int armedQty[TOTAL_SLOTS + 1];           // [1..6] armed press count per slot
    bool slotBusy[TOTAL_SLOTS + 1];          // [1..6] pump is running
    std::queue<PendingArm> pendingQueue[TOTAL_SLOTS + 1]; // per-slot pending ARM queue
    TxnPhase phase;            // IDLE, ARMED, DISPENSING, COMPLETE
    bool bundleComplete;       // all armed slots reached 0 after batch ARM
    bool WLVL_PRESSED[TOTAL_SLOTS + 1];      // [1..6] water level empty sensors
    int remaining_time[TOTAL_SLOTS + 1];     // [1..6] remaining pump ms
    // ... plus persistent state save/load
};
```

### 10.3 TCP Commands Accepted

| Command | Format | Effect |
|---------|--------|--------|
| `ARM_BATCH` | `ARM_BATCH,s1:q1,s2:q2,...` | Arm multiple slots atomically |
| `ARM` | `ARM,productId,qty` | Arm one slot (legacy) |
| `CANCEL` | `CANCEL,productId` | Clear armed credit for one slot |
| `CANCEL_ALL` | `CANCEL_ALL` | Clear ALL armed credits + queues |
| `CANCEL_QUEUE` | `CANCEL_QUEUE,productId` | Clear pending queue for one slot |
| `WTRLVL` | `WTRLVL,p1,...,p6` | Water level sensor states (1=empty); 4 values also accepted |

STATUS is broadcast every ~500ms and on any state change (34 comma-separated fields, documented in Section 6.7).

### 10.4 Hardware

- **6 buttons** (BCM: 14, 24, 25, 10, 13, 23) — customer dispense triggers
- **6 pumps** (BCM: 15, 16, 6, 17, 18, 12) — active-low relays
- **6 LEDs** (BCM: 5, 27, 4, 22, 19, 7) — arm-status indicators
- **6 water level sensors** (BCM: 26, 20, 21, 11, 8, 9) — slot-empty detection

All 18 button/pump/LED pins are distinct; `test_no_gpio_pin_is_used_twice` in `tests/test_hardware.cpp` enforces this.

**Slot-empty protection:** Pump activation is blocked when `WLVL_PRESSED[pumpIdx]` is true.

### 10.5 Crash Persistence

controller saves `armedQty` + `pendingQueue` to `transaction/state.json` and reloads on startup.

---

## 11. uploaderTransaction — Python Background Services

Three Python scripts running on the Pi, managed by PM2:

| Script | PM2 Name | Purpose |
|--------|----------|---------|
| `water_level_monitoring_v2.py` | 02_Water_Sensors | Reads 6 GPIO water level sensor pins, sends `WTRLVL,v1,...,v6` to controller TCP every 1s |
| `uploader.py` | 03_Transaction_Uploader | Watches `transaction/` for JSON files written by controller, batches up to 20, POSTs to cloud API, deletes on confirmed success |
| `status_uploader.py` | 04_Status_Uploader | Persistent TCP client to controller, parses STATUS lines, posts water-level changes to cloud API |

### Cloud API Endpoints

| Endpoint | Caller | Method | Purpose |
|----------|--------|--------|---------|
| `POST /api/v1/auth/machine/transaction` | uploader.py | POST | Batch transaction upload |
| `POST /api/v1/auth/machine/status` | status_uploader.py | POST | Machine status (water level changes) |

Base URL: `https://office.dynamicglobalsoft.com:1232` (from `config.env` `API_BASE_URL`)

---

## 12. Full PM2 Process List

The deployment script `setup_and_run.sh` registers **5 PM2 processes**:

| PM2 Name | Script | Language | Restart |
|----------|--------|----------|---------|
| 01_Dispenser_Controller | `controller/main` | C++ binary | 2s delay |
| 02_Water_Sensors | `uploaderTransaction/water_level_monitoring_v2.py` | Python (venv) | 5s delay |
| 03_Transaction_Uploader | `uploaderTransaction/uploader.py` | Python (venv) | — |
| 04_Status_Uploader | `uploaderTransaction/status_uploader.py` | Python (venv) | — |
| 05_Cashier_Dashboard | `cashier_dashboard/server.js` | Node.js | 3s delay |

**Note:** all five processes are registered by `setup_and_run.sh` via the PM2 CLI and persisted with `sudo pm2 save`. Legacy processes 02_Coin_Acceptor, 03_Street_Light and 04_QR_Scanner were removed from the active deployment.

---

## 13. Deployment

### Prerequisites
- Raspberry Pi with WiringPi GPIO library
- Node.js (the Pi uses `/usr/bin/node`)
- PM2 (`npm install -g pm2`)
- Python 3 with venv (for uploaderTransaction)
- C++ build toolchain (g++, make)

### Automated Setup
1. `./install_dependencies.sh` — Installs WiringPi (from source), Node.js v20.x (NodeSource), PM2, journalctl with persistent storage
2. `./setup_and_run.sh` — Builds controller (`make`), sets up Python venv + pip deps, installs npm deps for dashboard, registers all 5 PM2 processes, saves PM2 list for auto-start on boot

### Manual Steps
1. **Install dashboard dependencies:** `cd cashier_dashboard && npm install`
2. **Configure:** Copy `CONFIG/config.env.sample` to `CONFIG/config.env` and set values (especially `SOCKET_IP` to the vendo machine's LAN IP)
3. **Verify assets:** all 8 `.woff2` files in `public/fonts/` (product icons are inline SVG, no image files needed)
4. **Start all processes:** `./setup_and_run.sh` from the project root
5. **Access dashboard:** `http://<cashier-machine-lan-ip>:80`
6. **Phone access:** Scan QR at `http://<cashier-machine-lan-ip>:80/qr`

### Testing Without a Pi
Run `node server.js` from `cashier_dashboard/`. The dashboard loads at `http://localhost:80`. After 4 seconds, demo/skeleton data populates showing all card states (armed, busy, empty, idle, inactive).

---

## 14. Legacy Subsystems (Nested Project Copy)

A nested `sabon_express_dispenser-main/` directory inside the project root contains the **complete legacy system** — modules that were removed from the active root-level project when the system was converted from a coin-acceptor model to the cashier-dashboard model:

| Module | Purpose | Why Removed |
|--------|---------|-------------|
| `arduino_firmware/` | Arduino coin acceptor firmware (2 sketches: `controller_vendo.ino`, `coin_acceptor.ino`) | Coin model replaced by dashboard |
| `usb_to_coin_module/` | USB-serial coin bridge + LED relay control | Coin model replaced by dashboard |
| `keyboard_monitoring/` | QR code scanner via `pynput` global keyboard listener | Voucher system removed |
| `iot_dispenser_v2/` | FLTK C++ touchscreen GUI for customers (~1359 lines) | Replaced by browser dashboard |
| `uploaderTransaction/water_level_monitoring.py` | v1 I2C-based water sensor reader | Replaced by GPIO-based v2 |
| `uploaderTransaction/qr_gen.py` | QR code generation utility | No longer needed |

The root-level active project contains only what's needed for the current cashier-dashboard architecture. The nested copy is historical reference.

---

## 11. Known Issues & Gotchas

1. **Demo mode timeout:** Changed from `!S.connected` to `!S.lastUpdate` (2026-08-12). The SSE "connected" event fires immediately even without a controller, so checking connection state alone doesn't work for demo triggering.

2. **SSE reconnection resets everything:** When the SSE receives `data: connected`, the entire client state resets — staged items, selected products, armed counts all zero. This is by design (fresh state on reconnect) but can be jarring if the connection blips.

3. **Water level sensor mapping:** Python reads pins in config order. C++ maps them internally. If the physical sensor-to-slot wiring doesn't match the pin order in `config.env`, the wrong slot shows as empty.

4. **Water level sensor count is negotiated:** controller accepts a `WTRLVL` line with 6 values (current wiring) or 4 (legacy). Under the legacy form, slots 5 and 6 report "has liquid" and are never blocked. If the Pi is running an old `water_level_monitoring_v2.py`, those two slots will dispense even when actually empty.

5. **All 6 slots are active:** `ACTIVE = TOTAL = 6`. The `.inactive` CSS class in `index.html` is now unused — it is kept only for the case where a slot is taken out of service.

6. **Product icons:** the dashboard renders inline SVG icons. The PNG photo sets (`product pictures/` and `public/images/`) were removed as unused duplicates.

7. **`PRODUCT_INITIAL` is unused:** The circular badge (D1/D2/etc.) was removed per `PRODUCT_CARD_LAYOUT_FIX.md`. The `PRODUCT_INITIAL` object remains in the code but has no rendered element. It's safe to remove if desired.

8. **Alert count uses regex on HTML string:** `renderAlerts()` counts issues by matching `/list-row/g` on the built HTML string. If DOM manipulation changes the rendered output, the count in the heading may not match.

9. **Single-file architecture:** Everything is in `index.html`. No build step, no module system, no framework. Changes to layout, styling, or behavior all happen in one file. This is intentional for simplicity but means the file is ~1000 lines.

10. **Image fallback:** Product images use CSS `background-image` with a `background-color` fallback. If an image fails to load, the solid pastel color still identifies the slot. There's no JavaScript image error handling — the fallback is purely CSS.

---

## 12. Modification Guide

### Changing product names
Edit the `PRODUCT` object in `index.html` (~line 629). Update `PRODUCT_ML` if volumes change.

### Changing per-press volume
Edit `PRODUCT_ML` in `index.html` (~line 634). This is display-only — actual pump duration is calibrated in `config.env` (`calibrateProduct1`–`5`).

### Adding/removing product slots
1. Update `TOTAL_SLOTS` in `controller/includes/hardware_config.h` — every C++ loop,
   array bound and the STATUS field count derive from it
2. Add the `BTNn`/`PUMPn`/`LEDn` globals, `pin_*` map entries, `load_int()` calls and
   the `defaults[]` row in `controller/src/hardware_config.cpp`
3. Update `ACTIVE` and `TOTAL` in `index.html` (`STATUS_FIELDS` follows automatically)
4. Update `PRODUCT`, `PRODUCT_ML`, `PRODUCT_ICON` objects
5. Update `TOTAL_SLOTS` in `uploaderTransaction/water_level_monitoring_v2.py` and
   `uploaderTransaction/status_uploader.py`
6. Update `config.env`: `BTNn`, `PUMPn`, `LEDn`, `WATER_GPIO_PIN_n`, `calibrateProductn`
7. Rebuild controller (`cd controller && make`) and restart PM2

### Adding a product photo
1. Place a 1024×1024 PNG in `public/images/` named `slotN.png`
2. Update `PRODUCT_BG[N]` with a matching fallback color
3. No code changes needed — `renderGrid()` generates `background-image:url(images/slotN.png)` for all slots 1–TOTAL

### Changing theme colors
Edit the `:root` block for dark theme, `[data-theme="light"]` block for light theme. All colors use CSS custom properties — change the variable values, not individual element styles.

### Adding an API endpoint
1. Add route handler in `server.js`
2. If it needs to reach controller, use `sendToCoinSlot(command)`
3. If it needs to push to browsers, use `broadcastSSE(data)`

### Changing fonts
Replace `.woff2` files in `public/fonts/` and update `@font-face` declarations at the top of `index.html`. Keep `font-display: swap`.
