# Local Sales Reporting — Implementation Plan

**Goal:** Tap the "Today" card and see what actually sold — today's product mix
as a pie, and a month-by-month trend. The owner reads performance off the
machine itself, without waiting on the cloud portal or trusting a spoken
figure.

**Tech Stack:** C++ (controller), Node/Express (dashboard), vanilla JS + inline
SVG (charts), `CONFIG/config.env`

---

## The blocking discovery: there is no local sales history

Nothing on the Pi remembers a sale for longer than a few seconds. Verified in
the code before planning:

1. **Transaction files are deleted.** `transaction_uploader.py` calls
   `os.remove(p)` on every record the cloud confirms. On a healthy machine the
   transaction directory is empty within seconds of a sale.
2. **The "Today" counter is per-browser-tab.** `dispenseCount` is a variable in
   `index.html`, incremented on a `busy` false→true transition and reset to `0`
   on every SSE `connected` event. Reload the page and "Today: 43" becomes
   "Today: 0". The label is already a lie — it means "since this tab opened",
   not "today".
3. **Nothing else persists.** PM2 logs rotate at 7 days and are prose, not data.

So a pie of today or a graph of the month **cannot be built from anything that
exists**. The first real task is a durable local ledger. `prime_events.jsonl`
already proved the pattern on this machine: append-only JSONL, written by the
controller, living outside the transaction directory so the uploader never
touches it.

---

## Bug to fix before any of this

**Priming counts as a dispense.** `pump_start_prime()` sets `slotBusy`, which
the dashboard reads as "a customer pressed the button". Verified on the wire
against a live controller: the busy field goes `000000` → `010000` on a prime.

Introduced 2026-09-03 with the prime feature. It must be fixed before reporting
is layered on top, or every chart launches already wrong — and wrong in the
direction that hides theft, since a prime would pad the sales figure.

---

## Global Constraints

- **No CDN, no chart library.** The dashboard has zero external dependencies
  and the machine may have no internet at all. Charts are hand-drawn inline
  SVG. A pie and a bar chart are about 60 lines each; a library is not worth
  breaking the offline guarantee for.
- **The controller owns the ledger.** The dashboard can be restarted, opened in
  several tabs, or reloaded mid-sale. Only the controller sees a dispense
  complete exactly once.
- **Never change the transaction JSON keys** or the uploader's delete-on-confirm
  behaviour. That is the cloud contract. The ledger is a second, separate write.
- Every task must leave `make test` green with no compiler warnings.

---

## Task 1 — Stop counting primes as dispenses

- [ ] Distinguish a maintenance run from a sale on the wire. Options: a
      separate `priming` field in STATUS, or exclude priming slots from `busy`
- [ ] Prefer adding a field: `busy` genuinely means "this pump is running", and
      other consumers (`status_uploader.py`) may rely on that
- [ ] STATUS is a fixed-width positional format — bump the field count in
      `build_status_response()`, `index.html` (`STATUS_FIELDS`) and
      `status_uploader.py` together, or they silently mis-parse
- [ ] Test: a prime does not increment the dashboard's dispense count

---

## Task 2 — A durable local sales ledger

- [ ] Append every completed dispense to `logs/sales.jsonl` from
      `writeTransaction()` — the single point where a real sale is recorded
- [ ] One JSON object per line: `slot`, `amount`, `date_created`, `machine_id`
- [ ] Outside `TRANSACTION_DIR`, so the uploader never deletes it
- [ ] Configurable via `SALES_LOG`, defaulting to `<repo>/logs/sales.jsonl`
- [ ] Roll monthly (`sales-2026-09.jsonl`) so a year of history is not one file
      that must be read end to end to answer "what sold today"
- [ ] Retention: keep 13 months so year-on-year comparison works, delete older
- [ ] Test: a completed dispense appends exactly one line; a prime appends none;
      an interrupted dispense appends none

Size is not a concern: 200 dispenses a day at ~90 bytes is 18 KB/day, about
6.6 MB a year.

---

## Task 3 — Aggregation endpoint

- [ ] `GET /api/sales?range=today` → per-slot counts and peso totals
- [ ] `GET /api/sales?range=month` → daily totals for the current month
- [ ] `GET /api/sales?range=year` → monthly totals for the last 12 months
- [ ] Read only the month files the range needs
- [ ] Skip malformed lines rather than failing the whole request — one bad line
      must not hide the day's trading
- [ ] Local dates throughout, matching the controller's `localtime` timestamps

---

## Task 4 — The report view

- [ ] Make the "Today" KPI card tappable, opening a sheet (reuse the settings
      sheet pattern — backdrop, Esc, tap-outside all already work)
- [ ] Donut: today's share by product, with counts and a legend. A donut over a
      pie: the centre holds the day's total, and slices are easier to compare
- [ ] Bar chart: daily totals for the current month, with a month picker
- [ ] Toggle between **presses** and **pesos**
- [ ] Empty state that says "no sales recorded yet today", not an empty circle
- [ ] Colour-blind-safe palette, and never colour alone — label every slice
- [ ] Readable on the iPad in daylight: large type, high contrast

---

## Task 5 — Fix the "Today" card itself

- [ ] Feed the KPI from the ledger, not the in-tab counter, so it survives a
      reload and means what it says
- [ ] Keep it live: bump optimistically on a completed dispense, reconcile from
      the ledger periodically

---

## Decisions needed

1. **Presses or pesos as the default view?** Recommend **presses** until
   prices are set. Every product currently reports `amount = 5`
   (`2026-09-03-honest-revenue-reporting.md` Task 1, parked). A peso chart built
   on that is wrong by 5x for Fabcon and would look authoritative while lying.
   Counts are honest today.
2. **How long to keep history?** Recommend **13 months**.
3. **Show primes and unclaimed sales in the report?** Recommend **no** on the
   main chart — they are not sales. A small "also today: 3 lines cleared"
   footnote keeps them visible without polluting the figures.

---

## Out of scope

- The cloud portal. This is the local view; the multi-machine view is still
  `office.dynamicglobalsoft.com`.
- Backfilling history. Nothing survives to backfill from — charts start from
  the day the ledger ships, and the first month will look sparse.
- Exporting to CSV or printing. Worth revisiting once the owner has used the
  on-screen view and knows what they actually want to take away.
