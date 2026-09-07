# Offline Reports — Design

**Status: designed, not built.** Approved by the owner on 2026-09-04 and parked
for a future update.

**Goal:** Let the client see their own trading on the machine itself — what was
taken, what sold, and what explains a drawer that does not match — without the
cloud portal and without an internet connection.

**Relationship to earlier work:** `plans/2026-09-03-local-sales-reporting.md`
built the today view and the sales archive, and deliberately deferred anything
beyond one day to the cloud portal on the grounds that an owner checking on
staff wants to look from home. **This design revisits that decision**: the owner
also wants to reconcile the drawer at the counter, which is a local job. It adds
the month range and reconciliation; it does not undo anything that plan built.

---

## The gap

This is a surfacing problem, not a collection problem. The machine already
writes six durable local records and keeps them indefinitely:

| File | Contents |
|---|---|
| `logs/sales/sales-YYYY-MM.jsonl` | every confirmed sale, one file per month |
| `logs/prime_events.jsonl` | every Clear Air |
| `logs/interrupted_sales.jsonl` | dry-tank events, charged in full |
| `logs/unclaimed_credits.jsonl` | credits expired or cancelled |
| `logs/credit_settlements.jsonl` | whether each was re-armed or written off |
| `logs/price_changes.jsonl` | price audit, from and to |

Every dashboard read endpoint is **today-only** — `/api/sales/today`,
`/api/interrupted`, `/api/unclaimed`, `/api/prime`. Months of history sit in
`logs/` that nobody can see without SSH-ing into the Pi and reading JSONL by
hand.

## Decisions

Taken with the owner on 2026-09-04:

- **Purpose:** reconcile the drawer, see what sells, check on staff. Explicitly
  *not* framed as a cloud fallback — this is a first-class local view.
- **Location:** a separate `/reports` page, **no lock**. The cashier has no
  reason to open it and it never appears on the counter screen, but anyone on
  the shop Wi-Fi can reach it. The dashboard has no login by design — the Wi-Fi
  password is the defence, and a PIN was deliberately removed earlier. This does
  not reintroduce one.
- **Range:** **Today** and **This month** only. No 7/30/365 windows, no month
  picker, no custom range.
- **Sections:** Takings & reconciliation, and Product performance. The
  exceptions/audit section and the water/stock section were declined.

## Architecture

Aggregate on request in Node. The current month's sales file is roughly 550 KB
at this machine's volume, so parsing it per request costs single-digit
milliseconds. No precomputed rollups, no scheduled job, no new storage, no new
dependencies.

`/api/sales/today` already performs exactly this aggregation for one day. Lift
its body into one shared function and have both it and a new ranged endpoint
call it, so the two can never disagree.

| File | Responsibility |
|---|---|
| `cashier_dashboard/server.js` | shared aggregator; `GET /api/reports?range=today\|month` |
| `cashier_dashboard/public/reports.html` | the page; reuses the dashboard's CSS |

`/api/sales/today` keeps its current shape — the main dashboard's Today KPI
depends on it.

## The page

Two buttons: **Today** / **This month**. Same stylesheet as the dashboard, so it
inherits the theme and reads on a phone.

### Section 1 — Takings

```
Expected in drawer          ₱4,275
  Recorded sales            ₱4,215   (57 presses)
  Written-off credits          ₱60   (2 credits)
```

**Why the sum, and not just sales.** Money reaches the drawer when the cashier
**arms** a slot, not when the customer presses the button. So cash on hand is
recorded sales *plus* credits that were paid for and never dispensed. Those two
figures currently live in different files and nothing adds them up, which is
precisely how a cashier ends up carrying an unexplained difference.

- **Recorded sales** — `logs/sales/sales-YYYY-MM.jsonl` plus anything still in
  `TRANSACTION_DIR` awaiting upload, de-duplicated on
  `slot|date_created|amount`. A day must be complete even if the link has been
  down since morning.
- **Written-off credits** — entries in `unclaimed_credits.jsonl` with
  `reason: "timeout"` whose settlement in `credit_settlements.jsonl` was
  `writeoff`. The customer paid and received nothing, so that cash is still in
  the drawer.
- **Re-armed credits are excluded.** The customer was given their presses back
  and the resulting dispense is already counted in recorded sales. Adding them
  would double-count.

### Section 2 — Needs explaining

Events that do not change the expected total but mean a customer may have been
short-changed, or that the machine cannot resolve on its own:

- **Interrupted sales** — dry-tank events, charged in full, poured in part.
  Count and pesos, from `interrupted_sales.jsonl`.
- **Re-armed credits** — count, from `credit_settlements.jsonl`. Shown so the
  owner can see the credit was honoured rather than lost.
- **Cancelled credits** — count and pesos, from `unclaimed_credits.jsonl` with
  `reason: "cancelled"`. **Deliberately kept out of the drawer total:** the
  machine cannot know whether the cashier refunded the customer. Folding them in
  would produce a confident figure built on a guess. They are listed so a person
  can decide.

### Section 3 — Product performance

Ranked by takings for the period: product name, presses, pesos, and a share bar.
Same shape as the existing Today panel so it reads as familiar. Names come from
`PRODUCTn_NAME`, so the report is labelled with what is actually in the tanks.

## Record shapes this reads

All dates are local time, `YYYY-MM-DD HH:MM:SS`, matching the controller's
`format_current_time()`. Synthetic examples:

```
sales-2026-09.jsonl        {"machine_id":"23","slot":"2","amount":30,"date_created":"2026-09-04 10:15:38"}
unclaimed_credits.jsonl    {"machine_id":"23","slot":"2","qty":3,"amount":60,"reason":"timeout","date_created":"2026-09-04 16:31:32"}
credit_settlements.jsonl   {"key":"2|2026-09-04 16:31:32","slot":2,"qty":3,"action":"writeoff","date_created":"2026-09-04 16:33:02"}
interrupted_sales.jsonl    {"machine_id":"23","slot":"4","amount":25,"reason":"tank_empty","date_created":"2026-09-04 10:15:38"}
```

A settlement is joined to its credit on `key`, which is `slot|date_created` of
the credit.

## Testing

The aggregation is pure — files in, totals out — so it deserves fixture-based
tests even though this repo has no JavaScript harness today. Standing one up is
a larger decision; if it has not happened by the time this is built, verify by
hand against known fixtures and say so plainly, as the one-tap staging plan did.

At minimum, prove:

- a sale present in both the archive and `TRANSACTION_DIR` counts once
- a written-off credit raises the expected drawer; a re-armed one does not
- a cancelled credit appears in "needs explaining" and **not** in the total
- a malformed line is skipped rather than failing the request
- day and month boundaries use local time, matching the controller's stamps
- an empty month returns zeroes rather than an error

## Out of scope

- **The cloud portal.** Still the multi-machine view. This is the single-machine
  view, and the two are allowed to overlap.
- **Wider ranges.** 7/30/365 and a month picker were declined. A single month
  answers "what sells" only within that month; the range can widen later without
  changing the page's shape, since the month files already exist.
- **Exceptions and audit.** Prime frequency and price-change history were
  declined. The data is on disk and keeps accruing, so it stays available
  whenever it is wanted. Note this leaves the behavioural half of "check on
  staff" uncovered — reconciliation catches money leaving, not patterns like
  twenty primes a day.
- **Retention.** Nothing prunes the logs. At roughly 18 KB a day that is about
  6.6 MB a year, and the page only ever reads the current month, so growth does
  not slow it. Worth capping before these machines have run for years.
- **Export or print.** Revisit once the owner has used the on-screen view and
  knows what they would want to take away.

## Open question for whoever builds this

**Does the owner count cash mid-shift, or only at close?** This design assumes
close. If they reconcile mid-shift, "Today" must mean "since the last count"
rather than "since midnight" — a different and larger feature, since it needs a
recorded count event to measure from.
