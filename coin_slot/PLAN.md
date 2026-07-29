# Coin Slot Refactoring Plan

Goal: Keep the software working at every phase.
Each phase is a self-contained commit that improves the code without breaking anything.

---

## Phase 1 — Modularize the Monolith + Windows Dev Environment
**Status: Partially done (1A committed, 1B uncommitted)**

### 1A — Break up monolithic main.cpp (COMMITTED as `7fa0643`)
The original `main.cpp` was 1,629 lines doing everything.
Split into modules:
- `src/utils.cpp` — env loading, filesystem helpers, time formatting
- `src/hardware_config.cpp` — pin-to-pump mapping
- `src/voucher_manager.cpp` — voucher queue + transaction saving
- `src/socket_server.cpp` — multi-client TCP socket server
- `main.cpp` reduced to ~307 lines (setup, loop, pump logic, interrupt handlers)

### 1B — Add Windows mock + OS-aware Makefile (UNCOMMITTED)
New files in `mock/`:
- `wiringPi.h` / `wiringPi.cpp` — stub GPIO functions that print `[MOCK]` output
- `wiringPiI2C.h` — stub I2C functions

Makefile updated to detect `Windows_NT` and:
- Add `-Imock` so the mock headers are found
- Link `ws2_32` (Windows sockets) instead of `wiringPi`
- Compile `mock/wiringPi.o` as part of the build

Other changes:
- `.gitignore` — added `CONFIG/config.env`
- `coin_slot/config.env.sample` — deleted (superseded by `CONFIG/` dir)
- `coin_slot/lcd.o`, `coin_slot/main.o` — deleted (build artifacts that slipped into git)

**Commit 1B before moving to Phase 2.**

---

## Phase 2 — Remove LCD + Fix Critical Bugs + Remove Dead Code
**Status: DONE**

### Context: LCD is gone
The physical LCD display is no longer used. The GUI has moved to the web-based
`/iot_dispenser_v2` which communicates via the socket server. The LCD was showing
credit balance and pump countdowns — that information is now served over the socket
via the `STATUS:...` response in `socket_server.cpp`.

This means the following are now entirely dead code:
- `includes/lcd.h` and `src/lcd.cpp` — the full LCD driver
- `includes/formatter.h` and `src/formatter.cpp` — `formatCountdown()` and
  `formatCurrency()` were only ever used to format strings for LCD display
- `fd_1` (global LCD I2C handle) in `main.cpp`
- All `lcd_init()`, `lcdLoc()`, `typeln()` calls in `setup()` and `loop()`
- The `#include "includes/lcd.h"` and `#include "includes/formatter.h"` in `main.cpp`
- `I2C_1_ADDR` constant and related LCD constants in `lcd.h` (LINE1..LINE4, etc.)
- The `wiringPiI2CSetup()` call in `setup()` (was only used to get the LCD handle)

### What `loop()` becomes after LCD removal
`loop()` still needs to run — it contains the pump state machine:
- Computes how much time is left on each pump timer
- Reads the STOP/pause button GPIO
- Handles pause and resume for all pumps
- Turns pump GPIO pins ON or OFF based on timer state
- Calls `processSaving()` when a pump finishes dispensing

Without LCD, `loop()` just becomes clean pump control logic with no display calls.

### Bug: `loop()` is never called
`main()` only runs `server_app_loop()` in its while-loop:
```cpp
while (true) {
    server_app_loop();   // socket server only
    sleep_for(1ms);
}
```
`loop()` — which controls pump GPIO — is never invoked.
This means pumps get turned ON by the interrupt handlers but **never turn off**.
`processSaving()` also never runs, so no transactions are ever written to disk.

**Fix:** Call `loop()` inside the `while(true)` after removing all LCD calls from it.

### Dead code in `transaction.cpp`
`transaction.cpp` declares three global variables (`machine_id`, `product_id`, `amount`)
that are never used anywhere. The actual transaction logic lives in `voucher_manager.cpp`.

**Fix:** Remove the orphaned variables. `transaction.h` (the `Transaction` class) stays.

### Build artifacts tracked in git
`includes/formatter.h.gch` and `includes/lcd.h.gch` are precompiled header
binary artifacts that got committed.

**Fix:** Delete them and add `*.gch` to `.gitignore`.

### Files removed from the build entirely in this phase:
- `includes/lcd.h`
- `src/lcd.cpp`
- `includes/formatter.h`
- `src/formatter.cpp`

Update `Makefile` to remove `src/lcd.o` and `src/formatter.o` from `OBJS`.

---

## Phase 3 — Eliminate `extern` Global Coupling
**Status: DONE**

### The Problem
Multiple modules reach into `main.cpp`'s globals via `extern`:

`socket_server.cpp` uses:
```cpp
extern int coinCredit;
extern long long remaining_time_01, remaining_time_02, remaining_time_03, remaining_time_04;
extern bool WLVL1_PRESSED, WLVL2_PRESSED, WLVL3_PRESSED, WLVL4_PRESSED;
extern bool state_pause;
```

`voucher_manager.cpp` uses:
```cpp
extern std::string machineId;
extern std::string vendorId;
```

This is tight hidden coupling. If any global is renamed or moved, only the linker
catches it — at build time, not at design time.

### The Fix: Introduce a shared `AppState` struct

Create `includes/app_state.h`:
```cpp
struct AppState {
    int coinCredit = 0;
    std::string machineId;
    std::string vendorId;

    long long remaining_time[5] = {0};  // index 1-4
    bool WLVL_PRESSED[5] = {false};     // index 1-4
    bool state_pause = false;
};
```

- Define one `AppState g_state` in `main.cpp`
- Pass `AppState&` as a parameter to `server_app_setup()`, `server_app_loop()`,
  and `processSaving()`
- Remove all `extern` declarations from `socket_server.cpp` and `voucher_manager.cpp`

Dependencies become explicit and visible in function signatures.

---

## Phase 4 — Remove Pump Code Duplication
**Status: DONE**

### The Problem
`loop()` in `main.cpp` has four nearly-identical blocks — one per pump.
Each block does the same thing:
1. Check if water level sensor is tripped (stop pump)
2. If timer is running: honor pause state or run pump
3. If timer expired: turn pump off, save transaction if pump was running

This is copy-pasted four times with only the pump index changing.

### The Fix: Loop over a `PumpState` array

Introduce a `PumpState` struct:
```cpp
struct PumpState {
    int id;
    bool isPumping = false;
    bool isPaused = false;
    double amount = 0;
    long long remainingTimeWhenPaused = 0;
    std::chrono::time_point<std::chrono::high_resolution_clock> timer;
};
```

Then `loop()` becomes:
```cpp
for (int i = 1; i <= 4; i++) {
    handlePump(pumps[i], appState);
}
```

Interrupt handlers become:
```cpp
void addTimer1() { processTimer(pumps[1]); }
```

The 4x copy-paste collapses into one `handlePump()` function.

---

## Phase 5 — Separate Mixed Concerns
**Status: DONE**

### Problem A: `Product` is in `voucher_manager.h`
The `Product` struct (pump id, coin cost, seconds of run time) has nothing to do
with vouchers. It belongs with pump/hardware configuration.

**Fix:** Move `Product` struct and `productMap` to `hardware_config.h` / `hardware_config.cpp`.

### Problem B: Transaction saving is in `voucher_manager.cpp`
`saveClassToJsonFileGeneric()` and `processSaving()` are about writing transaction
JSON files, not managing the voucher queue. They live in the wrong file.

**Fix:** Move them to `transaction.cpp`.
`voucher_manager.cpp` should only manage the voucher queue (enqueue, dequeue, total).

### Result after Phase 5 — clear module responsibilities:

| Module            | Responsibility                                              |
|-------------------|-------------------------------------------------------------|
| `hardware_config` | Pin numbers, relay polarity, pump-to-pin map, Product config |
| `utils`           | env loading, filesystem helpers, time formatting            |
| `transaction`     | Transaction struct + saving to JSON files                   |
| `voucher_manager` | Voucher queue only (enqueue, dequeue, total)                |
| `socket_server`   | TCP server, command parsing, state read/write               |
| `main`            | Setup, main loop, pump state machine, interrupt handlers    |

---

## Phase 6 — Build System Polish
**Status: DONE**

### Fix EXE name for Linux
The Makefile hardcodes `EXE = main.exe` in both OS branches.
On Linux (Raspberry Pi) the binary should be `main` with no extension.

```makefile
ifeq ($(OS),Windows_NT)
    EXE = main.exe
else
    EXE = main
endif
```

### Fix inconsistent include paths in `src/transaction.cpp`
`src/transaction.cpp` uses `#include "../includes/transaction.h"` explicit relative paths.
Every other `src/*.cpp` file uses the short form `#include "transaction.h"` because the
Makefile already passes `-Iincludes`. Update `transaction.cpp` to match the rest.

### Compiler warnings and `.PHONY`
- Add `-Wextra` to `CXXFLAGS` to catch more issues
- Add `.PHONY: all clean test` so `make clean` never breaks on a file named `clean`

### `make clean` improvements
- Currently removes `tests/test_runner.exe` — should also handle `tests/test_runner` (Linux)
- Stale comment in `TEST_MODULE_OBJS` block still says "no lcd, no formatter" — update it

### Add `make run` target
Quick local run on Windows without having to type the full path:
```makefile
run: $(EXE)
    ./$(EXE)
```

### Update stale Makefile comment
The `TEST_MODULE_OBJS` comment says "no main.o, no lcd, no formatter".
After Phase 2 lcd/formatter are gone, and after Phase 5 transaction.o was added.
The comment should reflect the current state.

---

## Phase 7 — Robustness: Input Validation + Graceful Shutdown
**Status: DONE**

### Problem A: Socket input is not validated
`manage_connected_clients()` parses raw TCP bytes with no safety:

1. **WTRLVL parsing does not check comma count.**
   If the message has fewer than 4 commas, `pos[i]` is `std::string::npos` and the
   `substr()` calls produce garbage or throw. Example bad message: `"WTRLVL,0,1"`.

2. **`catch(...)` swallows all exceptions silently.**
   No log, no indication to operator that a command was dropped.
   Replace with specific `catch(const std::exception& e)` and log the error.

3. **No upper bound on `coinCredit`.**
   A client sending `COIN,2000000000` (near `INT_MAX`) followed by another
   `COIN,2000000000` causes signed integer overflow (UB). Cap at a safe maximum.

### Fix: validate before parse
Add a helper that counts commas before proceeding:
```cpp
static int count_commas(const char* s) {
    int n = 0; while (*s) { if (*s++ == ',') n++; } return n;
}
```
Use it to guard each branch:
- `VOUCHER`: requires exactly 2 commas
- `WTRLVL`:  requires exactly 4 commas
- `COIN`:    requires exactly 1 comma

Log and skip any message that fails the check.

### Problem B: `remaining_time` can be negative
When no pump is running, `pump.timer` is in the past.
`pump.timer - current_time` is negative, so `remaining_time[i] < 0`.
The `STATUS:` response then sends negative milliseconds to the web UI.

**Fix:** clamp to 0 in `loop()`:
```cpp
g_state.remaining_time[i] = std::max(0LL,
    std::chrono::duration_cast<std::chrono::milliseconds>(
        pumps[i].timer - current_time).count());
```

### Problem C: No graceful shutdown
`main()` loops forever. On `systemctl stop` the process receives SIGTERM and is
killed immediately — any pump running mid-dispense is left ON, and the transaction
is never saved.

**Fix:** add a signal handler (Linux / Pi only):
```cpp
#ifndef _WIN32
#include <signal.h>
static volatile sig_atomic_t g_running = 1;
static void handle_signal(int) { g_running = 0; }
#endif
```

In `main()`:
```cpp
#ifndef _WIN32
signal(SIGTERM, handle_signal);
signal(SIGINT,  handle_signal);
#endif

while (g_running) { ... }

// Shutdown: turn all pumps off before exit
for (int i = 1; i <= 4; i++) digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
cleanup_socket_environment();
```

### Problem D: `vendo.service` needs hardening
Current service file has no restart policy and hardcodes paths:

```ini
[Unit]
Description=Vendo Coin Slot Dispenser
After=network.target

[Service]
Type=simple
ExecStart=/home/dgsi/Desktop/dispenser/coin_slot/main
WorkingDirectory=/home/dgsi/Desktop/dispenser/coin_slot
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

Changes from current:
- `Type=idle` → `Type=simple`
- Add `Restart=on-failure` and `RestartSec=5`
- Add `TimeoutStopSec=10` (gives signal handler time to save before force-kill)
- `StandardOutput=inherit` → `journal` (logs go to `journalctl`)
- Fix EXE name: `main.exe` → `main`
- Add `After=network.target`

### Tests to add
- `test_phase7.cpp`: WTRLVL with missing commas → no crash, command skipped
- COIN with non-numeric value → no crash
- `remaining_time` is always ≥ 0 after clamping
- `coinCredit` never exceeds MAX cap

---

## Phase 8 — Extract Hardcoded Config + Rename Misleading Symbols
**Status: DONE**

### Problem A: Magic numbers are hardcoded in source
Values that belong to a deployment's configuration are baked into `.cpp` files:

| Value | Current location | Problem |
|-------|-----------------|---------|
| `8080` | `socket_server.cpp:23` | Can't change port without recompile |
| `../transaction` | `transaction.cpp:48` | Path must match deployment layout |
| `../CONFIG/config.env` | `main.cpp:168` | Path must match deployment layout |
| `50ms` loop sleep | `main.cpp:217` | Tuning requires recompile |
| product timings (e.g. `2.777…`) | `hardware_config.cpp` | Different machines dispense different products |

**Fix:** Load all of these from `CONFIG/config.env`:
```
SERVER_PORT=8080
TRANSACTION_DIR=../transaction
LOOP_SLEEP_MS=50
```

Product timings are machine-specific. Keep them in code as defaults but allow
`config.env` to override via keys like `PRODUCT_1_SECONDS=2.777`.

### Problem B: `Product.second` is a misleading field name
`struct Product { int id; int coins; double second; }` — the field `second` looks
like it could mean "the second item" or "index 2". It actually means "seconds of
run time per 5-coin insert".

**Fix:** rename `second` → `durationSeconds` everywhere:
- `includes/hardware_config.h` — struct definition
- `src/hardware_config.cpp` — initializers
- `main.cpp` — `product.durationSeconds`

### Problem C: Debug `cout` in `processSaving()` is in production code
`src/transaction.cpp` currently prints:
```cpp
std::cout << "Voucher : " << voucherId << std::endl;
std::cout << "Length : " << std::to_string(voucherId.length()) << std::endl;
```
These were debugging prints that were never removed. On a Pi they flood the
journal log with every dispense.

**Fix:** Remove both lines. The transaction is already written to disk; that is
the definitive record. If logging is needed later (Phase 9+), it should go
through a proper log level system, not raw stdout.

### Problem D: `createDirectoryIfNotExists` return value is inverted
`utils.cpp` returns `false` when the directory already exists, `true` when it
was just created. Callers (and tests) have to remember this unusual semantic.

**Fix:** rename and invert:
```cpp
// Returns true if the directory is ready to use (already existed OR just created)
bool ensureDirectoryExists(const std::string &path);
```
Update the one call site in `main.cpp:setup()` and the two tests in
`test_utils.cpp` that document the current (inverted) behaviour.

### Tests to add
- `test_phase8.cpp`:
  - `Product.durationSeconds` value for each product matches expected ms extension
  - `ensureDirectoryExists` returns `true` for an existing directory (new semantic)
  - `ensureDirectoryExists` returns `true` when it creates a new directory
  - No debug output written to stdout by `processSaving` (redirect stdout and check)

---

---

## Phase 9 — Remove Last Global Coupling + Last Debug Cout
**Status: DONE**

### Problem A: `listOfVoucher` is still a global extern
`voucher_manager.cpp` declared `std::vector<unusedVoucher> listOfVoucher` as a
global and `main.cpp`/`socket_server.cpp` accessed it via `extern`. This is the
same hidden coupling problem Phase 3 fixed for `coinCredit`, `machineId`, etc.
`handlePump()` could not be unit-tested because it depended on this global.

**Fix:** Move `listOfVoucher` into `AppState` as `voucherQueue`. Remove the
`extern` declaration from `voucher_manager.h`. Update all call sites to use
`state.voucherQueue`.

### Problem B: Debug `cout` in `voucher_manager.cpp`
`enqueueVoucher()` printed "Enqueued:" and `dequeueVoucher()` printed "Dequeued:"
on every call — flooding `journalctl` on every dispense. Same class of bug fixed
in Phase 8 for `transaction.cpp`.

**Fix:** Remove all debug `std::cout` from `voucher_manager.cpp`. Also removed
the `print()` method on `unusedVoucher` and `displayVector()` (dead debug helpers).

### Problem C: `handlePump()` accessed `g_state` directly
`handlePump(PumpState&)` reached into the global `g_state` and global
`listOfVoucher`. Changed to `handlePump(PumpState&, AppState&)` so the function
is fully testable in isolation.

### Problem D: `maxCoinCredit` added to `AppState`
`MAX_COIN_CREDIT = 1000` was hardcoded in `socket_server.cpp`. Moved into
`AppState.maxCoinCredit` (default 1000, overridable from `config.env` via
`MAX_COIN_CREDIT=...`). Socket server now uses `state.maxCoinCredit`.

### Tests added
- `test_phase9.cpp`: 13 tests — voucherQueue in AppState, FIFO order,
  queue independence, no stdout from enqueue/dequeue, maxCoinCredit default/override

---

## Phase 10 — Structured Logging
**Status: DONE**

### Problem: Bare `cout`/`cerr` scattered across all modules
Each module hand-rolled its own `[tag]` prefix with no timestamp, no severity,
no consistent format. On the Pi, `journalctl` timestamps by second but cannot
distinguish order within a second or filter by severity.

**Fix:** Added `log_info(module, msg)` and `log_error(module, msg)` to `utils`:
```cpp
void log_info(const std::string &module, const std::string &msg);
void log_error(const std::string &module, const std::string &msg);
```
Each writes `[YYYY-MM-DD HH:MM:SS] [module] msg` (info → stdout,
error → stderr with `ERROR:` label). Uses the existing `format_current_time()`
already in utils. Replaced all bare `std::cout << "[socket]..."` and
`std::cerr << "Warning:..."` in `socket_server.cpp`, `utils.cpp`, and `main.cpp`.

### Tests added
- `test_phase10.cpp`: 13 tests — log_info/log_error stream routing, module tag
  format, timestamp structure, ERROR label, maxCoinCredit cap logic via AppState

---

## Phase 11 — Slot-Empty Protection
**Status: DONE**

### Problem: Pump activates even when the soap container is empty
When `WLVL_PRESSED[pumpIdx]` is `true` (water level sensor tripped = slot empty),
`processTimer()` previously still activated the pump if credit was sufficient.
This caused the machine to deduct credit and "dispense" air when a container ran out.

### Fix: Gate pump activation on slot state
In `src/pump_control.cpp`, inside `processTimer(int pumpIdx)`:

```cpp
// Before
if ((state.coinCredit >= product.coins) && (!atleast2PumpOn || pumpAlreadyOn))

// After
bool isSlotEmpty = state.WLVL_PRESSED[pumpIdx];
if ((state.coinCredit >= product.coins) && (!atleast2PumpOn || pumpAlreadyOn) && !isSlotEmpty)
```

`WLVL_PRESSED[pumpIdx]` is already maintained by the `WTRLVL` socket command
(sent by `water_level_monitoring_v2.py`), so no new state was needed.
Credit is not deducted when a slot is empty.

---

## Socket Protocol Integration Tests
**Added alongside Phase 9/10**

### What these tests do
`tests/test_socket_integration.cpp` spins up the real TCP server on port 9901
in a background thread, then connects a real OS TCP client and sends/receives
actual protocol messages. This tests the full communication path that
`iot_dispenser_v2` uses in production.

**Protocol tested (plain TCP, not WebSocket):**
- `COIN,<n>` → `state.coinCredit` increases (capped at `state.maxCoinCredit`)
- `VOUCHER,<id>,<n>` → credit added + voucher pushed to `state.voucherQueue`
- `WTRLVL,<p1>,<p2>,<p3>,<p4>` → `state.WLVL_PRESSED[1..4]` flags set
- Any other message (e.g. `"Client ACK"` or `"STATUS"`) → server replies
  `STATUS:<credit>,<t1>,<t2>,<t3>,<t4>,<wl1>,<wl2>,<wl3>,<wl4>,<pause>`
- Malformed messages (wrong comma count) → silently dropped, state unchanged

### Tests: 18 total
Connection, STATUS field count, COIN accumulation & cap, COIN reflected in STATUS,
malformed COIN ignored, VOUCHER queued in AppState, malformed VOUCHER ignored,
WTRLVL all combinations, WTRLVL reflected in STATUS, two clients sharing state,
server survives client disconnect + reconnect.

---

## Summary Table

| Phase | What Changes                                       | Risk   |
|-------|----------------------------------------------------|--------|
| 1A    | Modularize main.cpp                                | Done   |
| 1B    | Windows mock + Makefile OS detection               | Done   |
| 2     | Remove LCD/formatter, fix loop() bug, dead code    | Done   |
| 3     | Replace extern globals with AppState struct        | Done   |
| 4     | Replace 4x pump copy-paste with loop + PumpState  | Done   |
| 5     | Move Product + Transaction saving to right modules | Done   |
| 6     | Build system polish                                | Done   |
| 7     | Input validation, remaining_time clamp, shutdown   | Done   |
| 8     | Extract hardcoded config, rename misleading fields | Done   |
| 9     | voucherQueue in AppState, remove last debug cout   | Done   |
| 10    | Structured logging, configurable credit cap        | Done   |
| 11    | Slot-empty protection: block pump when no water    | Done   |
