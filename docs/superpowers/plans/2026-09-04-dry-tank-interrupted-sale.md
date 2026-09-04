# Dry-Tank Interrupted Sale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: DONE 2026-09-04.** Verified end to end against a live controller.

**Goal:** When a tank runs dry part-way through a customer's dispense, record the
sale immediately at full price, free the slot, and put the partial pour in front
of a person — instead of recording nothing and locking the line.

**Architecture:** `handlePump()` already has the branch that fires when a tank
reads empty. Today it switches the relay off and logs. It will instead close the
dispense the same way a completed one is closed — write the transaction, clear
the pump state, release the slot — and append a separate non-revenue record so
the event is visible. The transaction path, the JSON keys and the uploader are
untouched.

**Tech Stack:** C++17 (controller), Node/Express (dashboard), `CONFIG/config.env`

## Global Constraints

- **Never change the transaction JSON keys.** `machine_id`, `vendor_id`,
  `voucher_id`, `amount`, `slot`, `date_created` are the cloud contract.
- **Policy: full price, flagged.** Chosen by the owner on 2026-09-04. The
  customer was charged in full, so the record is full. The partial pour is
  surfaced for a human rather than silently guessed at.
- The attention record must live outside `TRANSACTION_DIR` — the uploader POSTs
  every file in there as a sale.
- `make test` green, no compiler warnings.

---

## File Structure

| File | Responsibility |
|---|---|
| `controller/includes/app_state.h` | add `interruptedLogPath` |
| `controller/src/pump_control.cpp` | close the dispense in the empty branch; append the record |
| `controller/tests/test_dry_tank.cpp` | new suite for this behaviour |
| `controller/tests/run_tests.cpp`, `controller/Makefile` | register the suite |
| `cashier_dashboard/server.js` | `GET /api/interrupted` |
| `cashier_dashboard/public/index.html` | show them in Needs Attention |
| `CONFIG/config.env.sample`, `CONFIG/README.md` | document `INTERRUPTED_LOG` |

---

## Task 1: Close the dispense when the tank runs dry

**Files:**
- Modify: `controller/includes/app_state.h`
- Modify: `controller/src/pump_control.cpp` — `handlePump()` empty branch
- Test: `controller/tests/test_dry_tank.cpp`

**Interfaces:**
- Consumes: `releaseSlot(AppState&, int) -> bool`, `writeTransaction(AppState&, int slot, double amount, std::string voucherId = "", int postfix = 0)`, `appendJsonLine(const std::string&, const std::string&) -> bool`
- Produces: `AppState::interruptedLogPath` (std::string), read by Task 3

- [x] **Step 1: Write the failing tests**

```cpp
static void test_dry_tank_records_the_sale_at_full_price()
{
    AppState s = fresh_state();
    s.armedQty[2] = 1;
    start_dispense(s, 2);                 // press, pump running, amount booked

    s.slotEmpty[2] = true;                // gallon runs out mid-pour
    pump_loop(s);

    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
    CHECK(read_only_transaction().find("\"amount\": 20") != std::string::npos);
    CHECK_EQ(s.slotBusy[2], false);       // line is back in service
}

static void test_refilling_does_not_book_the_sale_twice()
{
    AppState s = fresh_state();
    s.armedQty[2] = 1;
    start_dispense(s, 2);

    s.slotEmpty[2] = true;
    pump_loop(s);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);

    s.slotEmpty[2] = false;               // staff refill
    for (int i = 0; i < 10; i++) pump_loop(s);
    CHECK_EQ(count_transactions(TEST_TXN_DIR), 1);
}
```

- [x] **Step 2: Run to verify they fail**

Run: `cd controller && mingw32-make test`
Expected: FAIL — `count_transactions == 1` gets `0`, and `slotBusy` stays `true`.

- [x] **Step 3: Add the log path to AppState**

```cpp
    // Dispenses cut short by an empty tank. Charged in full because the
    // customer was, but the pour was partial, so a person must see it.
    std::string interruptedLogPath;
```

- [x] **Step 4: Close the dispense in the empty branch**

```cpp
        } else if (pump.isPumping) {
            log_info("pump", "Pump " + std::to_string(pump.id)
                      + ": INTERRUPTED  reason=empty  amount="
                      + std::to_string(pump.amount));

            if (pump.armedUnitsReserved > 0) pump.armedUnitsReserved--;
            writeTransaction(state, pump.id, pump.amount, "");
            appendInterruptedLog(state, pump.id, pump.amount);

            pump.amount = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};
            // Zero the timer, or on refill remainingTime is still counting and
            // the completion branch books the same sale a second time.
            pump.timer = std::chrono::steady_clock::now();
            releaseSlot(state, pump.id);
            saveStateToDisk(state, state.transactionDir);
        }
```

- [x] **Step 5: Run to verify they pass**

Run: `cd controller && mingw32-make test`
Expected: PASS, 560+ checks, no warnings.

- [x] **Step 6: Commit**

```bash
git add controller/includes/app_state.h controller/src/pump_control.cpp controller/tests/
git commit -m "fix: record the sale when a tank runs dry mid-dispense"
```

---

## Task 2: Make the event visible

**Files:**
- Modify: `controller/src/pump_control.cpp` — `appendInterruptedLog()`, `pump_setup()`
- Modify: `cashier_dashboard/server.js` — `GET /api/interrupted`
- Modify: `cashier_dashboard/public/index.html` — Needs Attention rows

- [x] **Step 1: Write the record**

```cpp
static void appendInterruptedLog(AppState &state, int slot, double amount)
{
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("amount")     << ":" << amount
      << "," << q("reason")     << ":" << q("tank_empty")
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.interruptedLogPath, j.str());
}
```

- [x] **Step 2: Resolve the path in `pump_setup()`**

```cpp
    if (config.count("INTERRUPTED_LOG")) state.interruptedLogPath = config["INTERRUPTED_LOG"];
    else state.interruptedLogPath = binDir + "/../logs/interrupted_sales.jsonl";
```

- [x] **Step 3: Serve today's entries**

Endpoint returns `{ entries: [{slot, name, amount, date_created}] }`, today only,
newest first, malformed lines skipped.

- [x] **Step 4: Show them in Needs Attention**

One row per event: product, amount charged, time, and the sentence
"tank ran dry mid-pour — check the customer got their product".

- [x] **Step 5: Verify against the live mock, then commit**

---

## Out of scope

- Refunding or re-dispensing. The cashier decides that with the customer in
  front of them; the machine's job is to make sure the event is not invisible.
- Uploading the interrupted record to the cloud. Same blocker as unclaimed
  sales: it needs a non-transaction record type the portal team has to agree.
