# First-Run Tour — Design

**Date:** 2026-09-22
**Scope:** cashier dashboard v2 (`cashier_dashboard/public/`)

## Goal

When a cashier first opens the dashboard on a device, walk them through the
sale flow with a short spotlight tour on the real controls. Replayable from
Settings.

## Decisions

- **Audience:** the cashier, on the dashboard. No owner/installer doc.
- **Form:** spotlight tour — screen dims, one real control is highlighted,
  a tip card sits beside it with Skip / Next.
- **Trigger:** automatically once per device (browser `localStorage`),
  plus a replay button in Settings. No server change.
- **Build:** hand-written, no library. The tablet may be offline and the tour
  is ~120 lines.

## Steps

| # | Target | Tip |
|---|--------|-----|
| 1 | First `.v2-prod` card | Tap a product to add one press; tap again for more, − to remove. Red glow = machine offline, gray = tank empty. |
| 2 | `#btn-one-each` | Adds one press of every product at once. |
| 3 | `.v2-totals` | Check the quantity and total, then take the cash. |
| 4 | `#btn-arm` | After payment, tap Unlock. The customer presses the machine's buttons — one press, one serving. Unused presses wait under the coin button in the cart header. |
| 5 | `#chip-today` | Today's sales and presses. |
| 6 | `#btn-settings` | Change prices, clear air after a gallon change, and replay this tutorial. |

The last step's primary button reads **Done** instead of Next. The tip card
shows `n / total`, counting only the steps that will actually show.

## Components

- **`public/js/tour.js` (new).** Self-contained IIFE. Holds the step table
  (`{ sel, text }`) and exposes `window.sabonTour.start()`. Auto-starts on
  first load when not yet seen. Loaded after `v2.js`.
- **`public/css/v2.css`.** New tour block: overlay, highlight ring, tip card.
  Colours come from the existing v2 tokens only, so both themes work.
  Motion is disabled under `prefers-reduced-motion`.
- **`public/v2.html`.** One `<script src="js/tour.js">` line after `v2.js`,
  and a **Help** group at the end of the Settings sheet with a
  **Show tutorial** button (`#btn-tour`).
- **`public/js/v2.js`.** One click handler on `#btn-tour`: close Settings,
  then `window.sabonTour.start()`.

## Behaviour

- **Layer.** The tour is drawn in its own element outside the zoomed `#v2`
  shell, like `#v2-fx`, so positions come straight from
  `getBoundingClientRect()` in viewport pixels.
- **Spotlight.** A rounded box over the target, with a huge `box-shadow`
  dimming everything around it. No SVG mask.
- **Tip card.** Placed below the target, or above it if there is no room
  below. Clamped horizontally to the viewport with a 16px margin.
- **Blocking.** A full-screen transparent layer catches every tap while the
  tour is open. The tour only points; it never clicks anything, so it
  cannot add to the cart or unlock a slot.
- **Re-measure.** On `resize` and `orientationchange`, the current step is
  positioned again.
- **First load.** Wait until `#v2-grid` contains a `.v2-prod`: check every
  250 ms and give up after 10 s. Then start, unless
  `localStorage['sabon.tourSeen'] === '1'`.
- **Seen.** Skip, Escape or Done sets `sabon.tourSeen = '1'`. Every storage
  access is wrapped in try/catch, as the theme key already is.
- **Replay.** `start()` always runs, whatever the seen flag says.

## Edge cases

- **Hidden target.** A target that is missing, `hidden`, or 0×0 is skipped
  (for example on a phone layout).
- **Nothing visible.** If no step is visible, the tour closes without
  showing anything.
- **Escape.** Handled on `document` in the capture phase with
  `stopPropagation`, so it does not also close a sheet underneath.
- **Storage fails.** If `localStorage` throws, the tour still works but
  shows again on the next load. Accepted.
- **Replay mid-tour.** Calling `start()` while a tour is open restarts it
  from step 1 and does not stack a second overlay.

## Testing

- Headless Chrome screenshots of `v2.html` at tablet (1280×800) and phone
  (390×844) widths, in dark and light themes, for steps 1, 4 and 6.
- Manual check on the Pi tablet:
  - it runs once after first load, then not on reload;
  - Settings → Show tutorial replays it;
  - Escape closes only the tour.
- There is no JS test harness in the dashboard, so no unit test.

## Out of scope

- Interactive practice sale or demo mode.
- A per-machine seen flag.
- Translations.

---

## Revision 2 — longer tour, air-clear history (2026-09-22)

### Tour: 6 → 9 steps

| # | Target | Tip |
|---|--------|-----|
| 1 | First `.v2-prod` card | *(unchanged)* |
| 2 | `#btn-one-each` | *(unchanged)* |
| 3 | `#btn-clear-cart` | Empties the cart if the customer changes their mind. Only the cart — buttons already unlocked are not touched. |
| 4 | `#v2-cart .v2-totals` | *(unchanged)* |
| 5 | `#btn-arm` | After payment, tap Unlock. The cards turn teal and say Unlocked, and the customer presses the machine's buttons — one press, one serving. |
| 6 | `#btn-credits` (demo) | This appears after Unlock: presses the customer has paid for but not used yet. Tap it to see them. Cancel only if they are not coming back — cancelling writes off money already taken. |
| 7 | `#chip-waiting` | The same count at a glance. It lights up while a customer still has presses left. |
| 8 | `#chip-today` | *(unchanged)* |
| 9 | `#btn-settings` | Change prices, clear air after a gallon change, see every air clear, and replay this tutorial. |

**Demo step.** `#btn-credits` is hidden unless credits are owed, and
`v2.js` re-hides it on every status update. Step 6 therefore works through
CSS, not by changing the button:
- It is marked `demo: true`, so it is never filtered out as hidden.
- While it is on screen, `<html>` has the class `tour-demo`. CSS then forces
  a *hidden* `#btn-credits` to show, with a sample count of "2".
- The class is removed when the step changes and when the tour ends.
- When credits really are owed, the real button and count show unchanged.

### Air clear history

- **`cashier_dashboard/lib/prime_log.js` (new).**
  - `readPrimeRecords(file)` returns every record, oldest first. It skips
    bad lines, and a missing file gives `[]`.
  - `latestPrimeRuns(file, limit = 200)` returns the newest runs first.
  - Record shape (written by the controller): `{machine_id, slot, seconds,
    date_created: "YYYY-MM-DD HH:MM:SS"}`.
- **`server.js`.** `readPrimeCounts()` now uses `readPrimeRecords`, and a new
  endpoint `GET /api/prime/history` returns `{ runs }` (the latest 200,
  newest first).
- **Settings → Maintenance.**
  - Below the pump list: a "Last: <product>  <time>" line and a **View All**
    button. The button is disabled while there are no runs.
  - The line and button reload whenever the prime info reloads (opening
    Settings, and after each run).
- **`#prime-panel` "Air Clears".** Built like Price Changes:
  - one row per run, showing the slot dot, "<product> · Slot n", the time,
    and the seconds;
  - with no runs it shows "No air clears recorded yet.";
  - it sits above Settings, and Escape or tapping the backdrop closes it.
- **Check.** `tests/prime_log.test.js` covers a missing file, skipping a bad
  line, newest-first order, and the 200 cap. `npm test` runs both checks.
