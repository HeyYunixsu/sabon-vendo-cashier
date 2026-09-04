# Unclaimed Credit Accountability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No credit a customer has paid for leaves the machine without a
record. Credits that expire unpressed appear in Needs Attention where the
cashier can re-arm them or write them off; deliberate cancels go to an audit
log.

**Architecture:** The controller zeroes `armedQty` in three places — the
timeout in `pump_loop`, and the `CANCEL` / `CANCEL_ALL` socket handlers. Each
gains an append to a JSONL log outside `TRANSACTION_DIR`, in the same shape
`interrupted_sales.jsonl` already uses. The dashboard reads that log for its
Needs Attention rows, replacing the in-memory `unclaimedSales` array that is
written to but never populated. The timeout becomes configurable and moves to
five minutes.

**Tech Stack:** C++17 (controller), Node/Express (dashboard), vanilla JS,
`CONFIG/config.env`

## Global Constraints

- **Never change the transaction JSON keys.** `machine_id`, `vendor_id`,
  `voucher_id`, `amount`, `slot`, `date_created` are the cloud contract.
- **The unclaimed log lives outside `TRANSACTION_DIR`.** `transaction_uploader.py`
  POSTs every file in that directory as a sale. A file dropped there would book
  unclaimed credits as revenue — the exact opposite of this feature.
- **An unclaimed credit is not a sale.** It must never reach `/api/sales/today`
  or the takings figure.
- **The timeout stays bounded**, clamped to 30..1800 seconds. An armed slot is
  a physically live button; an unbounded timeout is free product for whoever
  walks up to an unattended machine.
- `make test` green, no compiler warnings.

---

## Design decision: expiry and cancel are not the same event

A **timeout** is something nobody chose. Money is in the drawer, the customer
walked off or was too slow, and someone has to decide what happens. It needs a
person, so it goes to Needs Attention.

A **cancel** is a deliberate cashier action, and most of them are innocent — a
mis-tap while staging, a customer changing their mind before paying. Routing
every cancel to Needs Attention would fill the panel with noise and train
staff to swipe it away without reading, which would then hide the timeouts
that matter. Cancels are recorded to the same log for later review, but do not
raise a row.

Both end up in one file with a `reason` field, so a reviewer can see the whole
picture and the dashboard can filter.

---

## File Structure

| File | Responsibility |
|---|---|
| `controller/includes/app_state.h` | add `armTimeoutSeconds`, `unclaimedLogPath` |
| `controller/includes/pump_control.h` | export `clamp_arm_timeout`, `pump_record_unclaimed` |
| `controller/src/pump_control.cpp` | config parsing, timeout write-off, the log writer |
| `controller/src/socket_server.cpp` | record credits dropped by `CANCEL` / `CANCEL_ALL` |
| `controller/tests/test_unclaimed.cpp` | new suite |
| `controller/tests/run_tests.cpp`, `controller/Makefile` | register the suite |
| `cashier_dashboard/server.js` | `GET /api/unclaimed`, rewrite resolve, delete the dead path |
| `cashier_dashboard/public/index.html` | Needs Attention rows, Cancel All confirmation |
| `CONFIG/config.env.sample`, `CONFIG/README.md` | document `ARM_TIMEOUT_SECONDS`, `UNCLAIMED_LOG` |

---

## Task 1: Configurable arm timeout, defaulting to five minutes

The 120-second value is hardcoded twice — the expiry check and the LED blink
countdown that warns of it. Changing one without the other makes the LED lie.

**Files:**
- Modify: `controller/includes/app_state.h`
- Modify: `controller/includes/pump_control.h`
- Modify: `controller/src/pump_control.cpp:276-283` (config), `:404-417` (expiry), `:419-421` (LED)
- Test: `controller/tests/test_unclaimed.cpp`

**Interfaces:**
- Produces: `AppState::armTimeoutSeconds` (int, default 300), read by Task 2
- Produces: `int clamp_arm_timeout(const std::string &raw)` — parses and clamps
  to 30..1800, returns 300 on anything unparseable

- [ ] **Step 1: Write the failing tests**

Create `controller/tests/test_unclaimed.cpp` with this header and these two
tests. The rest of the suite arrives in Task 2.

```cpp
#include "test_framework.h"
#include "pump_control.h"
#include "hardware_config.h"
#include "app_state.h"
#include <wiringPi.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

namespace fs = std::filesystem;

// Credits a customer paid for that never became product.
//
// The old code zeroed armedQty after 120 seconds and logged the word
// "refunded". Nothing was refunded. The credits vanished, and the only trace
// was a prose PM2 line that rotates out after seven days -- so a drawer that
// was 60 pesos heavy than the books had nothing to explain it, and the
// cashier carried the difference.

static const std::string TEST_DIR = "tests/tmp_unclaimed";
static const std::string TEST_LOG = TEST_DIR + "/unclaimed.jsonl";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";

static std::string read_all(const std::string &path)
{
    std::ifstream f(path);
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

static int count_lines(const std::string &path)
{
    std::ifstream f(path);
    int n = 0;
    std::string line;
    while (std::getline(f, line))
        if (!line.empty()) n++;
    return n;
}

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"}, {"PRICE4", "25"}});
    pump_reset_state();

    AppState s;
    s.machineId         = "23";
    s.transactionDir    = TEST_TXN_DIR;
    s.unclaimedLogPath  = TEST_LOG;
    s.armTimeoutSeconds = 1;          // so a test need not wait five minutes
    return s;
}

static void test_timeout_value_is_clamped()
{
    CHECK_EQ(clamp_arm_timeout("300"), 300);
    CHECK_EQ(clamp_arm_timeout("600"), 600);

    // Too short is unusable at the counter; too long leaves a live button on
    // an unattended machine.
    CHECK_EQ(clamp_arm_timeout("5"), 30);
    CHECK_EQ(clamp_arm_timeout("99999"), 1800);

    // A typo in config.env must not take the machine down at boot.
    CHECK_EQ(clamp_arm_timeout("abc"), 300);
    CHECK_EQ(clamp_arm_timeout(""), 300);
}

static void test_credits_expire_at_the_configured_time()
{
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 3;
    pump_loop(s);                     // stamps armTimestamp
    CHECK_EQ(s.armedQty[2], 3);       // not yet

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);
    CHECK_EQ(s.armedQty[2], 0);
}
```

Register the suite at the bottom of the file:

```cpp
void run_unclaimed_tests()
{
    SUITE("Unclaimed credits");

    RUN_TEST(test_timeout_value_is_clamped);
    RUN_TEST(test_credits_expire_at_the_configured_time);

    fs::remove_all(TEST_DIR);
    init_hardware_config({});
}
```

Add the declaration and the call in `controller/tests/run_tests.cpp` next to
`run_dry_tank_tests`, and add `tests/test_unclaimed.o` to the test object list
in `controller/Makefile` next to `tests/test_dry_tank.o`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd controller && mingw32-make test`
Expected: FAIL to compile — `clamp_arm_timeout` is not declared, and
`AppState` has no member `armTimeoutSeconds`.

- [ ] **Step 3: Add the field to AppState**

In `controller/includes/app_state.h`, after `priceLogPath`:

```cpp
    // How long an armed credit stays live before it is written off. The button
    // is physically live for this whole window, so a generous timeout is free
    // product for whoever walks up to an unattended machine. Five minutes is
    // the owner's call, 2026-09-04: long enough to fill several containers.
    int armTimeoutSeconds = 300;
```

- [ ] **Step 4: Add the parser**

Declare in `controller/includes/pump_control.h`:

```cpp
// Parses ARM_TIMEOUT_SECONDS and clamps it to 30..1800. Returns 300 for
// anything unparseable. Exposed so the clamp can be tested without a
// config.env on disk.
int clamp_arm_timeout(const std::string &raw);
```

Define in `controller/src/pump_control.cpp`, above `pump_setup`:

```cpp
int clamp_arm_timeout(const std::string &raw)
{
    int v = 300;
    try {
        v = std::stoi(raw);
    } catch (const std::exception &) {
        log_error("pump", "ARM_TIMEOUT_SECONDS is not a number - using 300");
        return 300;
    }
    if (v < 30)   { log_error("pump", "ARM_TIMEOUT_SECONDS below 30 - using 30");     return 30;   }
    if (v > 1800) { log_error("pump", "ARM_TIMEOUT_SECONDS above 1800 - using 1800"); return 1800; }
    return v;
}
```

Wire it into `pump_setup`, after the `PRIME_SECONDS` block:

```cpp
    if (config.count("ARM_TIMEOUT_SECONDS"))
        state.armTimeoutSeconds = clamp_arm_timeout(config["ARM_TIMEOUT_SECONDS"]);
```

- [ ] **Step 5: Use the field in both hardcoded places**

In `pump_loop` section `1c`, replace `if (armedFor >= 120) {` with:

```cpp
            if (armedFor >= state.armTimeoutSeconds) {
```

In section `2` (LED blink), replace the `auto remaining = 120 - ...` line with:

```cpp
            auto remaining = state.armTimeoutSeconds
                - std::chrono::duration_cast<std::chrono::seconds>(
                      current_time - pumps[i].armTimestamp).count();
```

Update the comment above section 2, which names the old value:

```cpp
    // 2. LED outputs with blink (last 10s before the timeout = 1Hz blink)
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd controller && mingw32-make test`
Expected: PASS. Check total is 583 + 8 or more, no warnings.

- [ ] **Step 7: Document the setting**

In `CONFIG/config.env.sample`, near `PRIME_SECONDS`:

```
# How long an unlocked button stays live before the credits are written off.
# Seconds, clamped to 30..1800, default 300 (five minutes). The button is
# physically live for this whole window -- anyone can press it -- so raise it
# only as far as the counter actually needs.
ARM_TIMEOUT_SECONDS=300
```

Add the same row to the settings table in `CONFIG/README.md`.

- [ ] **Step 8: Commit**

```bash
git add controller/includes/app_state.h controller/includes/pump_control.h \
        controller/src/pump_control.cpp controller/tests/ controller/Makefile \
        CONFIG/config.env.sample CONFIG/README.md
git commit -m "feat: make the arm timeout configurable, default five minutes"
```

---

## Task 2: Record credits the timeout writes off

**Files:**
- Modify: `controller/includes/app_state.h`
- Modify: `controller/includes/pump_control.h`
- Modify: `controller/src/pump_control.cpp` — `pump_setup`, `pump_loop` section 1c
- Test: `controller/tests/test_unclaimed.cpp`

**Interfaces:**
- Consumes: `AppState::armTimeoutSeconds` (Task 1),
  `appendJsonLine(const std::string &path, const std::string &json) -> bool`,
  `pump_get_price(int slot) -> int`, `format_current_time() -> std::string`
- Produces: `AppState::unclaimedLogPath` (std::string), read by Task 4
- Produces: `void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason)`,
  called by Task 3

- [ ] **Step 1: Write the failing tests**

Append to `controller/tests/test_unclaimed.cpp`:

```cpp
static void test_expired_credits_are_recorded()
{
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 3;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 1);

    const std::string body = read_all(TEST_LOG);
    CHECK(body.find("\"slot\":\"2\"") != std::string::npos);
    CHECK(body.find("\"qty\":3") != std::string::npos);
    CHECK(body.find("\"reason\":\"timeout\"") != std::string::npos);
    CHECK(body.find("\"date_created\"") != std::string::npos);

    // The peso figure is what reconciles against the drawer: 3 presses at the
    // slot 2 price of 20.
    CHECK(body.find("\"amount\":60") != std::string::npos);
}

static void test_queued_credits_are_recorded_too()
{
    // ARM queues behind a busy slot. Those credits were paid for exactly like
    // the armed ones, so dropping them on a timeout without a record is the
    // same bug in a quieter place.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 2;
    s.pendingQueue[2].push(PendingArm(2, 4));
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);

    CHECK_EQ(s.armedQty[2], 0);
    CHECK_EQ((int)s.pendingQueue[2].size(), 0);
    CHECK_EQ(count_lines(TEST_LOG), 1);
    CHECK(read_all(TEST_LOG).find("\"qty\":6") != std::string::npos);
}

static void test_one_timeout_writes_one_record()
{
    // The expiry check runs every loop. Without armedQty reaching zero it
    // would append a line on every turn for as long as the machine ran.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[4] = 1;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 20; i++) pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 1);
}

static void test_an_idle_machine_records_nothing()
{
    // By far the common case: nothing armed, nobody at the counter.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 20; i++) pump_loop(s);

    CHECK_EQ(count_lines(TEST_LOG), 0);
}

static void test_a_dispensing_slot_does_not_expire()
{
    // The customer is mid-pour. Writing their credit off underneath them
    // would be worse than the bug this feature fixes.
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 2;
    s.slotBusy[2] = true;
    pump_loop(s);

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    for (int i = 0; i < 10; i++) pump_loop(s);

    CHECK_EQ(s.armedQty[2], 2);
    CHECK_EQ(count_lines(TEST_LOG), 0);
}
```

Add them to `run_unclaimed_tests()`:

```cpp
    RUN_TEST(test_expired_credits_are_recorded);
    RUN_TEST(test_queued_credits_are_recorded_too);
    RUN_TEST(test_one_timeout_writes_one_record);
    RUN_TEST(test_an_idle_machine_records_nothing);
    RUN_TEST(test_a_dispensing_slot_does_not_expire);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd controller && mingw32-make test`
Expected: FAIL to compile — `AppState` has no member `unclaimedLogPath`.

- [ ] **Step 3: Add the log path**

In `controller/includes/app_state.h`, after `interruptedLogPath`:

```cpp
    // Credits a customer paid for that never became product -- expired or
    // cancelled. Outside transactionDir on purpose: the uploader POSTs every
    // file in there as a sale, which would book these as revenue.
    std::string unclaimedLogPath;
```

Resolve it in `pump_setup`, next to the `INTERRUPTED_LOG` block:

```cpp
    if (config.count("UNCLAIMED_LOG")) state.unclaimedLogPath = config["UNCLAIMED_LOG"];
    else state.unclaimedLogPath = binDir + "/../logs/unclaimed_credits.jsonl";
```

- [ ] **Step 4: Write the record**

Declare in `controller/includes/pump_control.h`:

```cpp
// Records credits that were paid for but never dispensed. reason is "timeout"
// or "cancelled". Called from the socket server as well as the pump loop.
void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason);
```

Define in `controller/src/pump_control.cpp`, beside `appendInterruptedLog`:

```cpp
// Money is already in the drawer for these. Recording the qty and the price at
// the time means a written-off credit still reconciles against the till later,
// even after prices move.
void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason)
{
    if (qty <= 0) return;

    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")   << ":" << q(std::to_string(slot))
      << "," << q("qty")    << ":" << qty
      << "," << q("amount") << ":" << (qty * pump_get_price(slot))
      << "," << q("reason") << ":" << q(reason)
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.unclaimedLogPath, j.str());
}
```

- [ ] **Step 5: Record on expiry**

Replace the body of the `if (armedFor >= state.armTimeoutSeconds)` block in
`pump_loop` section 1c:

```cpp
            if (armedFor >= state.armTimeoutSeconds) {
                // Queued credits were paid for exactly like the armed ones,
                // so they are counted before the queue is thrown away.
                int lost = state.armedQty[i];
                while (!state.pendingQueue[i].empty()) {
                    lost += state.pendingQueue[i].front().qty;
                    state.pendingQueue[i].pop();
                }

                // This said "refunded" for as long as the code existed, and
                // nothing was ever refunded.
                log_info("pump", "Slot " + std::to_string(i) + ": TIMEOUT  wrote off "
                          + std::to_string(lost) + " credits");
                pump_record_unclaimed(state, i, lost, "timeout");

                state.armedQty[i] = 0;
                saveStateToDisk(state, state.transactionDir);
            }
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd controller && mingw32-make test`
Expected: PASS, no warnings.

- [ ] **Step 7: Commit**

```bash
git add controller/includes/ controller/src/pump_control.cpp controller/tests/
git commit -m "fix: record credits the arm timeout writes off"
```

---

## Task 3: Record credits a cancel throws away

**Files:**
- Modify: `controller/src/socket_server.cpp:366-376` (`CANCEL_ALL`), `:396-417` (`CANCEL`)
- Test: `controller/tests/test_unclaimed.cpp`

**Interfaces:**
- Consumes: `pump_record_unclaimed(AppState&, int slot, int qty, const std::string &reason)` (Task 2)

`CANCEL_QUEUE` is deliberately untouched — it clears a queue the cashier is
still standing in front of, mid-sale, and the armed credits survive it.

- [ ] **Step 1: Write the failing tests**

The socket handlers are inline in the command loop and not callable from a
test, so test the recording function against the same shape the handlers use.

```cpp
static void test_cancelled_credits_are_recorded()
{
    AppState s = fresh_state();
    pump_record_unclaimed(s, 4, 2, "cancelled");

    CHECK_EQ(count_lines(TEST_LOG), 1);
    const std::string body = read_all(TEST_LOG);
    CHECK(body.find("\"reason\":\"cancelled\"") != std::string::npos);
    CHECK(body.find("\"slot\":\"4\"") != std::string::npos);
    CHECK(body.find("\"amount\":50") != std::string::npos);   // 2 x 25
}

static void test_cancelling_nothing_records_nothing()
{
    // Cancel All on an idle machine is a common stray tap. It must not write
    // a row saying zero credits went missing.
    AppState s = fresh_state();
    pump_record_unclaimed(s, 4, 0, "cancelled");

    CHECK_EQ(count_lines(TEST_LOG), 0);
}
```

Add both to `run_unclaimed_tests()`.

- [ ] **Step 2: Run to verify they pass already**

Run: `cd controller && mingw32-make test`
Expected: PASS — the `qty <= 0` guard from Task 2 covers the second one. These
pin behaviour the handlers depend on; the handler wiring is what follows.

- [ ] **Step 3: Record in the CANCEL handler**

In `controller/src/socket_server.cpp`, replace the body of the
`if (productId >= 1 && productId <= TOTAL_SLOTS)` block inside the `CANCEL`
branch:

```cpp
          if (productId >= 1 && productId <= TOTAL_SLOTS) {
            int lost = state.armedQty[productId];
            while (!state.pendingQueue[productId].empty()) {
              lost += state.pendingQueue[productId].front().qty;
              state.pendingQueue[productId].pop();
            }
            pump_record_unclaimed(state, productId, lost, "cancelled");

            state.armedQty[productId] = 0;
            if (!state.anyArmed()) { state.phase = TxnPhase::IDLE; state.bundleComplete = false; }
            log_info("socket", "CANCEL slot " + std::to_string(productId)
                      + ": cleared " + std::to_string(lost) + " credits");
            broadcast_status(state);
            saveStateToDisk(state, state.transactionDir);
          }
```

- [ ] **Step 4: Record in the CANCEL_ALL handler**

Replace the `CANCEL_ALL` branch body:

```cpp
      else if (isFirstWordTest(client_buffer, "CANCEL_ALL"))
      {
        int total = 0;
        for (int i = 1; i <= TOTAL_SLOTS; i++) {
          int lost = state.armedQty[i];
          while (!state.pendingQueue[i].empty()) {
            lost += state.pendingQueue[i].front().qty;
            state.pendingQueue[i].pop();
          }
          // One row per slot, not one for the batch: the price differs per
          // product, so a single total could not be reconciled back.
          pump_record_unclaimed(state, i, lost, "cancelled");
          state.armedQty[i] = 0;
          total += lost;
        }
        if (!state.anyArmed()) { state.phase = TxnPhase::IDLE; state.bundleComplete = false; }
        log_info("socket", "CANCEL_ALL: cleared " + std::to_string(total) + " credits");
        broadcast_status(state);
        saveStateToDisk(state, state.transactionDir);
      }
```

No new include is needed — `socket_server.cpp` already has `#include "pump_control.h"`
at the top.

- [ ] **Step 5: Run the suite**

Run: `cd controller && mingw32-make test`
Expected: PASS, no warnings.

- [ ] **Step 6: Document the log and commit**

In `CONFIG/config.env.sample`, near `INTERRUPTED_LOG`:

```
# Credits paid for but never dispensed -- expired at the timeout, or cancelled
# by the cashier. Not sales: this file must stay outside TRANSACTION_DIR or the
# uploader will book them as revenue.
UNCLAIMED_LOG=logs/unclaimed_credits.jsonl
```

Add the same row to `CONFIG/README.md`.

```bash
git add controller/src/socket_server.cpp controller/tests/ CONFIG/
git commit -m "fix: record credits a cancel throws away"
```

---

## Task 4: Serve unclaimed credits to the dashboard

The dashboard already has an `unclaimedSales` array, a `.unclaimed_sales.json`
file, a `trackUnclaimed()` function, an SSE push and a resolve route. None of
it runs: `trackUnclaimed` has no callers anywhere in the repo. This task
replaces that in-memory path with the controller's log and deletes the dead
code rather than leaving two half-mechanisms.

**Files:**
- Modify: `cashier_dashboard/server.js` — delete `:95`, `:108-128`, `:253-269`,
  `:282-285`, `:456-464`; rewrite `:439-454`; add the endpoint
- Test: manual, against the live mock

**Interfaces:**
- Consumes: `logs/unclaimed_credits.jsonl` (Task 2), `localDateString(d) -> string`,
  `PRODUCTS[slot].name`, `sendNowOrFail(command) -> boolean`
- Produces: `GET /api/unclaimed` returning
  `{ entries: [{ key, slot, name, qty, amount, date_created }] }`
- Produces: `POST /api/unclaimed/resolve` taking `{ key, action }` where
  `action` is `"rearm"` or `"writeoff"`

- [ ] **Step 1: Add the log path and the resolved-keys store**

Next to `INTERRUPTED_LOG_PATH`:

```js
// Credits paid for but never dispensed. Written by the controller.
const UNCLAIMED_LOG_PATH = config.UNCLAIMED_LOG
  ? path.resolve(__dirname, '..', config.UNCLAIMED_LOG)
  : path.resolve(__dirname, '..', 'logs', 'unclaimed_credits.jsonl');

// Which entries a cashier has already dealt with. The log itself is
// append-only and owned by the controller, so the dashboard keeps its own
// note of what has been settled rather than rewriting history.
const RESOLVED_FILE = path.resolve(__dirname, '.resolved_credits.json');
let resolvedKeys = new Set();
try {
  if (fs.existsSync(RESOLVED_FILE))
    resolvedKeys = new Set(JSON.parse(fs.readFileSync(RESOLVED_FILE, 'utf-8')));
} catch (e) {
  console.error(`[dashboard] Could not read resolved credits: ${e.message}`);
}

function saveResolved() {
  try {
    fs.writeFileSync(RESOLVED_FILE, JSON.stringify([...resolvedKeys]), 'utf-8');
  } catch (e) {
    console.error(`[dashboard] Could not save resolved credits: ${e.message}`);
  }
}
```

- [ ] **Step 2: Serve today's unresolved timeouts**

Add beside `GET /api/interrupted`:

```js
app.get('/api/unclaimed', (req, res) => {
  const entries = [];
  const today = localDateString(new Date());
  try {
    if (fs.existsSync(UNCLAIMED_LOG_PATH)) {
      for (const line of fs.readFileSync(UNCLAIMED_LOG_PATH, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        if (!String(rec.date_created || '').startsWith(today)) continue;
        // Cancels are recorded for review but do not raise a row -- see the
        // design note in the plan. A panel full of routine cancels teaches
        // staff to dismiss it without reading.
        if (rec.reason !== 'timeout') continue;

        const key = rec.slot + '|' + rec.date_created;
        if (resolvedKeys.has(key)) continue;

        const slot = parseInt(rec.slot, 10);
        entries.push({
          key,
          slot,
          name: (PRODUCTS[slot] && PRODUCTS[slot].name) || ('Slot ' + rec.slot),
          qty: Number(rec.qty) || 0,
          amount: Number(rec.amount) || 0,
          date_created: rec.date_created,
        });
      }
    }
  } catch (e) {
    console.error(`[dashboard] Could not read unclaimed log: ${e.message}`);
  }
  res.json({ entries: entries.reverse() });
});
```

- [ ] **Step 3: Rewrite resolve**

Replace the whole `POST /api/unclaimed/resolve` handler:

```js
app.post('/api/unclaimed/resolve', (req, res) => {
  const { key, action } = req.body;
  if (!key) return res.status(400).json({ success: false, error: 'missing key' });

  if (action === 'rearm') {
    const slot = parseInt(String(key).split('|')[0], 10);
    const qty = parseInt(req.body.qty, 10) || 1;
    // PRODUCTS is built from the PRODUCTn_* config keys, so a slot present
    // there is a slot this machine actually has. server.js has no slot-count
    // constant -- it hardcodes 6 in two loops -- and this avoids adding a third.
    if (!PRODUCTS[slot])
      return res.status(400).json({ success: false, error: 'bad slot' });
    // No money changes hands: the customer already paid, the credit expired
    // before they pressed. Fail loudly rather than marking it settled when
    // the controller never heard us.
    if (!sendNowOrFail(`ARM,${slot},${qty}`))
      return res.status(503).json({ success: false, error: 'controller unreachable' });
  }

  resolvedKeys.add(key);
  saveResolved();
  console.log(`[dashboard] Unclaimed settled: ${key} action=${action}`);
  res.json({ success: true });
});
```

- [ ] **Step 4: Delete the dead in-memory path**

Remove all of these — none has a live caller once the above is in:

- `const unclaimedSales = [];` and the `UNCLAIMED_FILE` constant plus the
  `try { ... }` block that loads it
- `function saveUnclaimed()`
- `function pushUnclaimed(slot, qty)`
- `function trackUnclaimed(slot, qty)`
- the `for (const u of unclaimedSales)` seeding loop in the SSE handler

- [ ] **Step 5: Verify by hand**

```bash
node -e "require('./cashier_dashboard/server.js')" &
curl -s localhost:3000/api/unclaimed
```
Expected: `{"entries":[]}` on a machine with no timeouts today.

Confirm nothing still references the deleted names:

```bash
grep -n "unclaimedSales\|trackUnclaimed\|pushUnclaimed\|saveUnclaimed\|UNCLAIMED_FILE" cashier_dashboard/server.js
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add cashier_dashboard/server.js
git commit -m "feat: serve unclaimed credits from the controller log"
```

---

## Task 5: Show them, and confirm before Cancel All

**Files:**
- Modify: `cashier_dashboard/public/index.html` — `renderUnclaimed()` at `:1299`,
  the SSE handler at `:1101`, `cancelAll()` at `:1405`, the poll at `:1978`
- Test: manual, against the live mock

**Interfaces:**
- Consumes: `GET /api/unclaimed`, `POST /api/unclaimed/resolve` (Task 4)

- [ ] **Step 1: Poll the endpoint**

Beside `loadInterrupted()`:

```js
  async function loadUnclaimed() {
    try {
      const d = await (await fetch('/api/unclaimed')).json();
      unclaimed = d.entries || [];
      renderUnclaimed();
    } catch (e) { /* leave the last good list on screen */ }
  }
```

At the bottom, next to `loadInterrupted(); setInterval(loadInterrupted, 60000);`:

```js
  loadUnclaimed();
  setInterval(loadUnclaimed, 30000);
```

Add it to the debounced refresh at `:1082` so a timeout shows up promptly
after a sale settles:

```js
    todayTmr = setTimeout(() => { loadToday(); loadInterrupted(); loadUnclaimed(); }, 1500);
```

Delete the now-dead SSE line at `:1101`:

```js
      if (e.data.startsWith('UNCLAIMED:')) { addUnclaimed(e.data); return; }
```

and the `addUnclaimed` function it calls.

- [ ] **Step 2: Render the rows**

Replace `renderUnclaimed()` entirely:

```js
  function renderUnclaimed() {
    if (!unclaimed.length) {
      $('unclaimed-list').innerHTML = '';
      if (!interrupted.length) $('attention-section').style.display = 'none';
      return;
    }
    let h = '';
    unclaimed.forEach((it) => {
      const at = String(it.date_created || '').slice(11, 16);
      h += '<div class="interrupted-row">'
         + '<div class="i-head"><span>' + it.name + '</span>'
         + '<span>₱' + it.amount + (at ? ' · ' + at : '') + '</span></div>'
         + '<div class="i-why">' + it.qty + ' press' + (it.qty !== 1 ? 'es' : '')
         + ' paid for but never used — the button timed out</div>'
         + '<div class="i-actions">'
         + '<button class="btn btn-sm" data-key="' + it.key + '" data-qty="' + it.qty
         + '" data-act="rearm">Unlock Again</button>'
         + '<button class="btn btn-sm btn-outline" data-key="' + it.key
         + '" data-act="writeoff">Write Off</button>'
         + '</div></div>';
    });
    $('unclaimed-list').innerHTML = h;
    $('attention-section').style.display = 'block';
  }
```

Add the action-row style beside the existing `.i-why` rule:

```css
.interrupted-row .i-actions { display: flex; gap: 6px; margin-top: 6px; }
.interrupted-row .i-actions .btn { flex: 1; height: 32px; font-size: 12px; }
```

- [ ] **Step 3: Wire the buttons by delegation**

The right panel is rebuilt on a 500ms beat, so listeners bound to individual
buttons are destroyed under the user's finger. Bind once to the container,
next to the other delegated listeners:

```js
  $('unclaimed-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const body = { key: b.dataset.key, action: b.dataset.act };
    if (b.dataset.act === 'rearm') body.qty = +b.dataset.qty;
    try {
      const r = await (await fetch('/api/unclaimed/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      if (!r.success) { toast(r.error || 'Could not settle that', 'error'); return; }
      toast(b.dataset.act === 'rearm' ? 'Button unlocked again' : 'Written off', 'success');
      loadUnclaimed();
    } catch (e) { toast('Could not settle that', 'error'); }
  });
```

- [ ] **Step 4: Confirm before Cancel All**

Cancel All is a full-width red button that silently voids every credit on the
machine. Replace `cancelAll()`:

```js
  async function cancelAll() {
    // S.armedQty is an Array(TOTAL + 1) indexed from 1, not a map.
    let n = 0;
    for (let s = 1; s <= TOTAL; s++) n += (S.armedQty[s] || 0);
    if (n > 0 && !confirm('Cancel ' + n + ' press' + (n !== 1 ? 'es' : '')
        + ' the customer has already paid for?')) return;
    try {
      await fetch('/api/cancel-all', { method:'POST', headers:{'Content-Type':'application/json'} });
      toast('All cancelled', 'info');
    } catch(e) { /* silent */ }
  }
```

- [ ] **Step 5: Verify against the live mock**

Start the controller and dashboard. Then:

1. Set `ARM_TIMEOUT_SECONDS=30` in `CONFIG/config.env` and restart the
   controller so the wait is short.
2. Stage two presses of a product, tap Unlock Buttons, press nothing.
3. After 30 seconds: a row appears under Needs Attention naming the product,
   the peso figure and the time.
4. Tap **Unlock Again** — the slot re-arms, the row disappears.
5. Let it expire once more, tap **Write Off** — the row disappears and does
   not come back on the next poll or after a page reload.
6. Confirm `curl -s localhost:3000/api/sales/today` is unchanged throughout:
   an unclaimed credit is not a sale.
7. Stage and unlock again, tap **Cancel All**, confirm the prompt names the
   right number of presses.
8. Restore `ARM_TIMEOUT_SECONDS=300`.

- [ ] **Step 6: Commit**

```bash
git add cashier_dashboard/public/index.html
git commit -m "feat: settle expired credits from Needs Attention"
```

---

## Out of scope

- **Uploading unclaimed credits to the cloud.** Same blocker as the interrupted
  sales: it needs a non-transaction record type the portal team has to agree.
  The file is on the Pi and the shape is stable, so this is additive later.
- **Retention.** `unclaimed_credits.jsonl` grows without limit, like the sales
  archive. Both should be capped in one pass rather than separately.
- **`std::stod` on `PRIME_SECONDS`.** Found while writing Task 1: it is
  unguarded, so `PRIME_SECONDS=abc` in `config.env` throws at boot and the
  controller never starts. Real, pre-existing, and not this feature's job —
  worth its own small fix.
