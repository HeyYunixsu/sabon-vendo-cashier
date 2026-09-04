# Local Sales Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
- **The uploader owns the archive.** It already holds each confirmed record
  immediately before deleting it, so what is archived is exactly what the cloud
  acknowledged and the two cannot drift. The controller is not involved.
- **Never change the transaction JSON keys** or the uploader's delete-on-confirm
  behaviour. That is the cloud contract. The ledger is a second, separate write.
- Every task must leave `make test` green with no compiler warnings.

---

## Status, 2026-09-04

Reworked after review. The original plan had the controller write a new sales
ledger in C++ and drew both a donut and a monthly chart on the machine. Three
things were wrong with that:

1. **The ledger did not need to be in C++.** `transaction_uploader.py` already
   holds each confirmed record just before deleting it, so appending there is
   a fraction of the work -- and what lands in the archive is exactly what the
   cloud acknowledged, so local and cloud cannot drift.
2. **The monthly chart belongs in the cloud portal.** Every field it needs
   already arrives there, and an owner checking on staff wants to look from
   home across every machine -- not while standing in the shop next to the
   cashier being checked. Building it locally means writing it twice and
   maintaining the copy fewer people use.
3. **Product names were hardcoded in `index.html`.** No machine could label a
   report with what was actually in its tanks, and the cloud only ever receives
   a slot number, so the portal could not either.

**Done:** product names in config, the uploader archive, a local today view,
and the prime-counts-as-a-dispense fix.

**Not done:** the monthly chart, deliberately -- it is the portal's job. The
payload spec for that team is still to write; the client could not reach them
at the time of writing.

---

## Task 1 — Stop counting primes as dispenses — DONE

Solved at the source instead of on the wire. The day's figure now comes from
the sales archive, which only ever contains completed sales, so a prime cannot
appear in it however the pump behaves.

- [x] Today's figure no longer derives from `busy` transitions
- [x] Verified against a live controller: clearing air on slot 4 left the day
      unchanged at 5 presses / ₱108

**Not done, and not needed:** the `priming` field in STATUS. `busy` honestly
means "this pump is running", and the only consumer that reads it for counting
was the dashboard. `status_uploader.py` reads water levels only, indexed from
the front, so it was never affected. Adding fields would have meant a
three-component coordinated change for no gain.

Still true: a slot being primed shows as "Dispensing" on its card. That is
accurate — the pump is running — but a distinct "Clearing air" state would
read better. Deferred; it needs the STATUS field after all.

---

## Task 2 — A durable local sales archive — DONE (in Python, not C++)

- [x] `transaction_uploader.py` appends each confirmed sale immediately before
      `os.remove()`. Archive before delete, so a failed write cannot lose the
      record entirely
- [x] One JSON object per line: `machine_id`, `slot`, `amount`, `date_created`
- [x] Outside `TRANSACTION_DIR`, so nothing sweeps it up
- [x] Configurable via `SALES_ARCHIVE_DIR`, default `<repo>/logs/sales`
- [x] One file per month, named by **the sale's own date** — a record uploaded
      after a night offline lands in the month it was sold, not today
- [x] Never raises: a machine that cannot write its archive must keep selling.
      A failure costs a line of history; stopping the till costs the day's trade
- [x] Unit tested: month splitting, field fidelity, append-not-overwrite, and
      that an unwritable directory is swallowed

**Not done: retention.** Nothing prunes old months. At roughly 18 KB a day this
is about 6.6 MB a year, so it is not urgent, but it grows without limit and
should be capped before these machines have run for years.

**Written in the uploader, not the controller**, which was the original plan.
Cheaper, and the archive is provably what the cloud accepted.

---

## Task 3 — Aggregation endpoint — DONE for today only

- [x] `GET /api/sales/today` — per-product presses and pesos, plus totals
- [x] Reads the archive **and** the transaction queue, so a day is complete even
      if the link has been down since morning
- [x] De-duplicates: a record can briefly exist in both places
- [x] Uses the amount recorded at the time of sale, so changing a price does not
      rewrite earlier takings
- [x] Skips malformed lines rather than failing the request
- [x] Local dates throughout, matching the controller's `localtime` stamps

**Not done:** `range=month` and `range=year`. Those feed the monthly chart,
which belongs in the portal.

---

## Task 4 — The report view — local part DONE

- [x] The "Today" card is tappable (and keyboard-reachable), opening a sheet
- [x] Per-product rows: presses, share of takings, pesos, sorted by takings
- [x] A horizontal mix bar showing each product's share of the day
- [x] Empty state that says "No sales recorded yet today"
- [x] Colour-blind safe: every row is labelled, colour never carries meaning alone
- [x] Explains what the number means — counted on a completed press, excludes
      clearing air, priced at the time of sale

**Not done, deliberately:**

- The donut. A horizontal mix bar says the same thing, reads better at a glance
  on a small panel, and needs no SVG geometry.
- The monthly bar chart. That is the portal's job — every field it needs
  already arrives there, and an owner checking on staff wants to look from home
  across every machine, not from inside the shop.
- The presses/pesos toggle. Both are shown at once, so there is nothing to
  toggle between.

---

## Task 5 — Fix the "Today" card itself — DONE

- [x] The KPI reads from the archive, so it survives a reload and means "today"
      rather than "since this tab opened"
- [x] Shows pesos, which is what the owner actually wants to know
- [x] Refreshes when a pump finishes, and on a slow beat, so a sale archived
      late by a slow link still lands

---

## Task 6 — Product names per machine — DONE (was not in the original plan)

Found while reworking this: `PRODUCT` was a hardcoded constant in `index.html`,
so every machine claimed to sell the same six things whatever was in its tanks,
and no report anywhere could be labelled.

- [x] `PRODUCTn_NAME` and `PRODUCTn_ML` in `config.env`
- [x] Served to the dashboard through `/api/info`
- [x] Used by the grid, the armed list, prices, prime rows and the today report

**Note for whoever builds the portal:** the cloud still receives only the slot
number. It cannot label a chart without a slot-to-product map per machine.

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
