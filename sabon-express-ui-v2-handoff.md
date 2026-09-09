# Sabon Express — Kiosk UI v2 Handoff

Redesign of the existing dispenser kiosk screen. **This is a UI/UX + cart-state refactor only.** The
hardware layer (pump channel mapping, dispense timing, serial/GPIO bridge, socket events, stock
sensing) does not change. Do not touch it.

Read the whole "Behavior matrix" before editing anything — several controls look new but are the same
function relocated, and a few keep their label while changing meaning.

---

## 1. Target device

- Samsung tablet / display, **landscape, locked orientation**. Mockup is ~2420×1512 (≈16:10).
- Single breakpoint is acceptable. Do not build a mobile-portrait variant.
- Touch targets: minimum 48×48px. The `−` / `+` steppers are the most-tapped elements on the screen —
  size them for wet/gloved hands, not mouse precision.

---

## 2. Layout change

**v1:** one column. Status bar → empty "Tap a product to add it" area → 3-button row
(Clear List / Unlock Buttons / ₱0) → 6-card product grid → Add One Of Each.

**v2:** two columns under the status bar.

```
┌─ status bar ──────────────────────────────┬─ operator card ─┐
│ Waiting | Stock | Ready | Today ₱0  ▾     │ logo  Jonathan ⚙ 09:46 │
├───────────────────────────────────────────┴─────────────────┤
│  LEFT (≈70%)                    │  RIGHT (≈30%)             │
│  "Product List"                 │  "Your Cart"  [Cancel All]│
│  ┌────┬────┬────┐               │  ┌──────────────────────┐ │
│  │ 3 × 2 product cards          │  │ line items (scroll)  │ │
│  └────┴────┴────┘               │  └──────────────────────┘ │
│  [+ Add One Of Each] [🗑]       │  Total Items / Total Amt  │
│                                 │  [🔒 Unlock Buttons]      │
└─────────────────────────────────┴───────────────────────────┘
```

- Left panel and right panel scroll independently. Cart line items scroll; totals + Unlock button are
  pinned to the bottom of the cart panel and must never scroll out of view.
- Theme accent changes from indigo/blue to **teal**. Centralize it — one Tailwind theme token
  (e.g. `brand`), no hardcoded hex scattered through components.

---

## 3. Product card change

| | v1 | v2 |
|---|---|---|
| Visual | small abstract icon in a tinted square | **full product photo** |
| Index | visible `01`–`06` prefix | removed from UI (keep in data for pump mapping) |
| Volume | not shown | **new** — `75ml` / `60ml` under the name |
| Status | dot + "Ready" text below the name | **green pill badge, top-right of card** |
| Quantity | large number, right side, read-only display | **`−` / qty / `+` stepper** |
| Selected | card border tint | teal border when `qty > 0` |

New per-product fields required: `image_url`, `volume_ml`, `unit_price`. Keep `slot_index` /
`pump_channel` in the payload even though it is no longer rendered.

---

## 4. Behavior matrix

Status legend: **SAME** = keep existing handler, **CHANGED** = same element, different behavior,
**NEW** = build it, **MOVED** = relocated, behavior unchanged.

| Element | v1 behavior | v2 behavior | Status |
|---|---|---|---|
| Status bar: Waiting / Stock / Ready | live machine state | identical | **SAME** |
| `Today ₱0` + caret | period selector for sales total | identical | **SAME** |
| Gear icon | opens settings | identical | **SAME** |
| Clock | live time | identical | **SAME** |
| Operator name + logo | did not exist | display current logged-in operator | **NEW** |
| Tap product card body | **added 1 to the list** | **must NOT change quantity.** Card body is inert (or at most a detail/highlight affordance) | **CHANGED** |
| `+` on card | did not exist | increment qty by 1, blocked when slot not `Ready` or stock 0 | **NEW** |
| `−` on card | did not exist | decrement by 1, floor at 0, removes the cart line when it hits 0 | **NEW** |
| `Add One Of Each` | +1 to every product | identical, now teal with `+` icon | **SAME** |
| `Clear List` (text button) | cleared entire list | replaced by the red **trash icon** beside Add One Of Each | **MOVED** |
| `Cancel All` (cart header) | did not exist | clears entire cart — **same action as the trash icon**, wire both to one handler | **NEW** |
| Per-line `Cancel` | did not exist | removes **that one line** entirely (qty → 0), syncs the card stepper back to 0 | **NEW** |
| `₱0` total (3rd button in row) | looked like a button, displayed running total | replaced by the cart totals block. **Non-interactive** | **CHANGED** |
| `Total Items` | did not exist | sum of quantities | **NEW** |
| `Total Amount` | was the `₱0` button | sum of `qty × unit_price` | **MOVED** |
| `Unlock Buttons` | unlocks physical dispense buttons | **same downstream action**, now the primary CTA in the cart panel | **SAME** |
| Empty state | "Tap a product to add it" centered in the list area | cart-panel empty state: icon + "Your cart is empty" + hint text | **CHANGED** |

**Critical:** the card stepper and the cart line items are two views of one state. Single source of
truth (one cart reducer / store keyed by product id). Do not let the cart panel hold its own copy.

---

## 5. State rules to implement

- `Unlock Buttons` **disabled when `totalItems === 0`.** The mockup renders it teal in the empty state
  — that is a mockup artifact, not the intent. Disabled styling required.
- `Cancel All` and the trash icon hidden or disabled when the cart is empty.
- `+` disabled when that slot's status ≠ `Ready`, or when its stock is depleted.
- Card status pill must reflect all machine states, not just `Ready`: `Ready` (green),
  `Dispensing` (amber), `Empty` (grey), `Error` / `Offline` (red). Card is non-interactive in any
  non-`Ready` state.
- Once unlocked / dispensing, the whole cart locks: no stepper, no cancel, no clear until the
  transaction completes or times out. v1 behavior here carries over — reuse it.
- Cart line items keep insertion order (order the user added them), not product-grid order.

---

## 6. Product rename

`Zonrox Original` → `Bleach Original`, `Zonrox Color Safe` → `Bleach Colored`.

Change the **display label only**. Do not rename the product key / slug / DB identifier — historical
sales rows, reports, and pump mapping all reference it. Add a `display_name` column if one doesn't
exist and read the UI off that.

---

## 7. Open items — confirm before building

1. **Totals don't reconcile.** Mockup shows 6 items at ₱50 each = ₱300, but `Total Amount` reads
   **₱320**. Either the per-item prices differ (60ml Fabcon vs 75ml others) or there's an unshown fee.
   Confirm the pricing rule; do not hardcode ₱50.
2. **Tap-to-add.** v1 users are trained to tap the card. Removing it entirely may slow them down —
   confirm whether card-body tap should still add 1, or be fully inert as specced above.
3. **Operator identity.** Where does "Jonathan" come from — an existing session/auth, or does login
   need to be built? If there's no auth today, this is out of scope for this pass.
4. **Product photos.** The mockup uses branded packaging shots (Fabcon, Bleach). For a
   Samsung-facing build, use the generic bottle renders (like the plain blue/purple ones used for
   Detergent 1 and 2) unless there's a licensing clearance on file.
5. **Cart overflow.** 6 products is the current max, so no scroll is needed today. If quantities can
   push a line item count beyond the panel height, confirm scroll vs. condensed rows.

---

## 8. Do not change

- Pump channel / slot index mapping
- Dispense timing and volume calculations
- Socket / polling contract for machine status, waiting count, and stock
- The unlock → dispense handshake itself
- Settings screen behind the gear icon
