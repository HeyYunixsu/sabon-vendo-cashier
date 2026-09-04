# Honest Revenue Reporting — Implementation Plan

**Goal:** The owner sees true per-machine revenue online, without relying on a
cashier's word. Money taken but not handed over becomes visible as a
discrepancy rather than disappearing.

**Architecture:** The controller already records a sale only when a pump
physically completes a run. That number is the anti-theft control: a cashier
cannot fake a pump run, cannot delete the record (the transaction directory is
root-owned and they work from an iPad), and cannot hide it by pulling the
network (transactions queue on disk and upload when the link returns). The work
here is to make that number *correct* and to close the paths where a real
dispense produces no record.

**Tech Stack:** C++ (controller), Python (uploaders), HTML/JS (dashboard),
`CONFIG/config.env`

---

## Already true — no work needed

Verified in the code before planning:

- **Revenue counts on dispense, not on arm.** `writeTransaction()` is called
  only from the branch where `remainingTime` reached zero *and* the pump was
  actually running (`pump_control.cpp:141-145`). Arming a slot records nothing.
  A press that never happens costs nothing. This is the design we want and it
  is already in place.
- **One press produces one transaction.** `pump.amount += product.coins` on an
  accepted press, written and reset to zero on completion.
- **Offline sales are not lost.** `transaction_uploader.py` deletes a file only
  after the API confirms that record.

---

## Global Constraints

- **Never change the transaction JSON keys.** `machine_id`, `vendor_id`,
  `voucher_id`, `amount`, `slot`, `date_created` are the contract with
  `transaction_uploader.py` and the cloud API. Internal C++ names may change;
  those six strings may not.
- **The cloud portal is out of scope.** "Production team sees every deployed
  machine" is built at `office.dynamicglobalsoft.com`. This plan makes each
  machine send correct data and documents the payload; it cannot build that view.
- Every task must leave `make test` green with no compiler warnings.
- Config-only changes must not require a rebuild.

---

## Task 1 — Put the real prices in (DONE 2026-09-04, differently)

Every product reported `amount = 5`, because `amount` came from the first
number of `calibrateProductN`. With 100 ml Fabcon selling at ₱25 the cloud
recorded 5, so the owner saw a fifth of the real revenue.

This was parked waiting for six numbers. It was resolved instead by making the
price a per-client setting rather than something baked into the build:

- [x] Split price from pour calibration: `PRICEn` in `config.env`, falling back
      to `calibrateProductN`'s first value so field machines keep working
- [x] Editable from the dashboard (Settings → Prices), no site visit
- [x] Saved to `PRICES_FILE` and applied over `config.env` at startup, so an
      on-site change is not undone by the next restart
- [x] Every change appended to `PRICE_LOG` with slot, old value, new value and
      time
- [x] Refused while any sale is armed — a price that moved between arming and
      pressing would charge one figure and record another
- [x] Range-checked (0 to `MAX_PRICE`), whole pesos, so a stray zero is refused
      rather than reported to the cloud
- [x] The sale strip shows pesos alongside presses

**The trade this makes.** A cashier who can change prices can lower one, sell
at the old price and pocket the gap — and the cloud would show the lower
figure as truth. The audit log does not prevent that; it makes it visible. That
was the accepted trade for prices being set per client without a site visit.
If it ever bites, the fix is to move price editing back behind the config file
(the plumbing already supports it: delete `PRICES_FILE` and set `PRICEn`).

**Still needed from the owner:** the actual six prices. The machinery no longer
blocks on them, but until someone sets them, every product still reports ₱5.

---

## Task 2 — Close the dry-tank hole

`handlePump()` has a path where a real dispense produces no sale record.
When `slotEmpty[id]` goes true mid-run (`pump_control.cpp:125-128`) the relay is
switched off but `isPumping` is never cleared, no transaction is written, and
`slotBusy` is never released. Consequences:

1. The customer paid and received partial product; **no sale is recorded at the
   time it happened**.
2. The slot stays busy, so further presses on it are refused until refill.
3. When the tank is refilled, `remainingTime` is already zero, so the completion
   branch fires and writes the **full** amount — a sale dated to the refill, not
   the purchase, at full price for partial delivery.
4. If the machine restarts before refill, the sale is lost entirely — pump state
   is not persisted.

This is a genuine hole in the anti-theft number, and it fails in the direction
that hurts the honest cashier: product left the tank and the cash drawer will be
short with nothing to explain it.

- [ ] Decide the policy (see below) and confirm with the owner
- [ ] Write the transaction at the moment of interruption
- [ ] Clear `isPumping` and `slotBusy` so the slot recovers
- [ ] Log it distinctly so it is greppable
- [ ] Test: arm, press, force `slotEmpty` mid-run, assert exactly one
      transaction is written at that moment and the slot frees
- [ ] Test: the same slot accepts a press again after the tank refills

**Policy decision required.** Options:

- **Full price** — the customer was charged in full. Simple, and never
  under-reports. But it books a full sale for a partial pour, and if the cashier
  re-dispenses to make the customer whole that becomes two sales for one payment.
- **Proportional to time actually run** — most honest about product delivered,
  and a re-dispense then adds up to roughly one full sale. Introduces fractional
  amounts the cloud may not expect.
- **Full price, flagged** — record the full amount and surface it on the
  dashboard as needing attention, so the cashier resolves it deliberately.

Recommendation: **full price, flagged.** It never under-reports revenue, keeps
the amount an integer, and puts the partial pour in front of a human instead of
silently guessing.

---

## Task 3 — Show the cashier what the drawer should hold

The dashboard reports "0 presses" and has no concept of price. A cashier cannot
reconcile what they never see, and "I didn't know what to collect" is a defence
worth removing.

- [ ] Serve the per-slot prices to the page (extend the STATUS line, or a small
      `/api/config` route — STATUS is a fixed-width positional format, so a
      separate route is less risky)
- [ ] Show a running peso total for the staged sale instead of a press count
- [ ] Show a shift total: sum of completed dispenses since a reset
- [ ] Keep presses visible alongside pesos — the cashier still needs to know how
      many presses are owed

---

## Task 4 — Upload unclaimed sales

A customer pays, the cashier arms, and the customer leaves without pressing.
Cash drawer up ₱25, cloud shows ₱0 — the reconciliation reads as the cashier
over-declaring when they did nothing wrong. The dashboard already detects this
(`unclaimedSales`, persisted to `.unclaimed_sales.json`) but it never leaves the
Pi.

- [ ] Upload unclaimed events with their own record type
- [ ] Confirm with the cloud team that a non-transaction record type is accepted
      before building it
- [ ] Keep them separate from transactions — they are money taken without
      product delivered, not revenue

Do this only after Tasks 1-3. It is the smallest of the four effects and needs
cloud-side agreement first.

---

## Task 5 — Document the payload for the cloud team

They are building the multi-machine view; they need to know exactly what arrives.

- [ ] Document the transaction JSON, its six fields and when each is emitted
- [ ] State explicitly that a record means a pump completed a run — not that a
      cashier claimed a sale
- [ ] Document the unclaimed record type if Task 4 goes ahead
- [ ] Note that `machine_id` comes from `config.env` and **must be unique per
      Pi** — two machines sharing an id silently merge their revenue

---

## Task 6 — Prime / purge a line without recording a sale (DONE 2026-09-03)

When a gallon is replaced, air enters the hose. The next press dispenses air
instead of product: the customer is charged, the machine records a sale, and
nothing useful comes out. Staff need a way to run a pump until liquid appears,
without that run counting as revenue.

**This is deliberately a hole in the anti-theft number** — it dispenses
product and records no sale, which is exactly what a dishonest cashier wants.
So it must be *non-revenue and visible*, never *unrecorded*.

- [x] `PRIME,<slot>` socket command — runs that pump for `PRIME_SECONDS`
- [x] Fixed short burst, repeatable — **not** hold-to-run. A held button over
      Wi-Fi is a dead-man's switch that fails open: drop the link mid-hold and
      the pump never gets the release
- [x] `isPriming` on the pump state so the completion branch skips
      `writeTransaction()` instead of writing a ₱0 sale
- [x] Refuse only while a dispense is actually in flight, the tank is empty,
      or the machine is paused. **Armed credits deliberately do NOT block a
      prime** (revised 2026-09-04): a gallon running out mid-sale is precisely
      when a waiting customer holds credits on that slot, so refusing there
      sent them a press of air and charged for it — the exact failure this
      feature exists to prevent. Safe because a press landing inside a prime
      is now denied rather than given away for free.
- [x] Keep the empty-tank guard — priming a genuinely dry tank runs the pump
      against air, which is what damages it
- [x] Record every prime to a separate non-revenue log (slot, duration, time)
- [x] Show a prime count per slot on the dashboard so the pattern is visible
- [ ] Upload prime events alongside Task 4's unclaimed records, same cloud
      agreement, same non-transaction record type (deferred with Task 4)

The owner should be able to ask "why was slot 3 primed 40 times last week?"
A prime that leaves no trace makes the honest number unenforceable.

---

## Out of scope

- The cloud portal itself
- Cashier-declared cash counts. The machine number is the control; a
  cashier-entered figure adds a step and can be gamed. Revisit only if the owner
  wants the variance recorded in the system rather than worked out at the till.
- Dashboard authentication. Dropped by decision on 2026-09-03 on the basis that
  the Wi-Fi is hidden. Worth noting for whoever reads this later: anyone with
  the Wi-Fi password can arm slots, which creates revenue no cashier collected
  and points the discrepancy at them. Restorable from git history if that
  becomes a problem.
