# Coin Slot Dispenser — Embedded Controller

## Executive Summary

The coin slot dispenser controller is a C++17 application that runs on a Raspberry Pi and manages a 4-pump liquid dispensing machine. Customers insert coins, the system accumulates credit, and each pump runs for a precisely timed duration per 5-coin insert. A GUI (`/iot_dispenser_v2`) communicates with the controller over TCP sockets, and all completed transactions are saved as JSON files for upstream processing.

The codebase was systematically refactored across 11 phases:

| Phase | What Changed |
|-------|-------------|
| 1 | Broke up a 1,629-line monolithic `main.cpp` into modules; added Windows mock layer |
| 2 | Removed dead LCD code, fixed a critical bug where `loop()` was never called |
| 3 | Replaced 7 `extern` globals with a single `AppState` struct passed by reference |
| 4 | Collapsed 4× copy-pasted pump blocks into one `handlePump()` + `PumpState` loop |
| 5 | Moved `Product` config to `hardware_config`, moved transaction saving to `transaction` |
| 6 | Build system polish: Linux EXE name, `.PHONY`, `-Wextra`, `make run` target |
| 7 | Input validation, `remaining_time` clamping, SIGTERM graceful shutdown |
| 8 | Extracted hardcoded config to `config.env`, renamed misleading symbols |
| 9 | Moved `voucherQueue` into `AppState`, removed last debug `cout`, `maxCoinCredit` configurable |
| 10 | Structured logging via `log_info()` / `log_error()` with timestamp and module tag |
| 11 | Slot-empty protection: pump ignores coin credit if the water level sensor is triggered |

---

## Overall Architecture

```
coin_slot/
├── main.cpp                  — Entry point: signal handlers, setup, main loop
├── includes/
│   ├── app_state.h           — AppState struct (single shared state, passed by reference)
│   ├── hardware_config.h     — Pin map, relay polarity, Product struct, productMap
│   ├── pump_control.h        — PumpState struct, pump_setup/loop/shutdown declarations
│   ├── transaction.h         — Transaction struct + processSaving() declaration
│   ├── voucher_manager.h     — Voucher queue (enqueue, dequeue, total)
│   ├── socket_server.h       — TCP server setup/loop, socket_count_commas()
│   └── utils.h               — loadEnv(), trim(), format_current_time(), ensureDirectoryExists(), log_info/error()
├── src/
│   ├── hardware_config.cpp   — pin_pump map, productMap (pump timing per 5-coin insert)
│   ├── pump_control.cpp      — PumpState machine, processTimer(), handlePump(), interrupt handlers
│   ├── transaction.cpp       — saveClassToJsonFileGeneric(), processSaving()
│   ├── voucher_manager.cpp   — Voucher queue implementation
│   ├── socket_server.cpp     — Non-blocking multi-client TCP server, command parser
│   └── utils.cpp             — env file loader, filesystem helpers, time formatter, structured logger
├── mock/                     — Windows stub layer (replaces wiringPi for dev builds)
│   ├── wiringPi.h / .cpp     — GPIO stubs that print [MOCK] output
│   └── wiringPiI2C.h         — I2C stubs
├── tests/
│   ├── test_framework.h      — Minimal CHECK / CHECK_EQ / RUN_TEST / SUITE macros
│   ├── run_tests.cpp         — Test runner entry point
│   ├── test_utils.cpp        — Utils module tests
│   ├── test_voucher.cpp      — Voucher queue tests
│   ├── test_socket_cmd.cpp   — Socket command parsing tests
│   ├── test_mock.cpp         — Mock layer tests
│   ├── test_hardware.cpp     — Hardware config tests
│   ├── test_phase2.cpp       — JSON transaction writing
│   ├── test_phase3.cpp       — AppState defaults and mutation
│   ├── test_phase4.cpp       — productMap values and pump timing
│   ├── test_phase5.cpp       — processSaving reads from AppState
│   ├── test_phase6.cpp       — Build layout and module linkage sentinels
│   ├── test_phase7.cpp       — Input validation, credit cap, remaining_time clamp
│   ├── test_phase8.cpp       — Config extraction, ensureDirectoryExists, no debug stdout
│   ├── test_phase9.cpp       — voucherQueue in AppState, maxCoinCredit default/override
│   ├── test_phase10.cpp      — log_info/log_error stream routing, timestamp format
│   └── test_socket_integration.cpp — Full TCP server integration tests (18 cases)
│   fixtures/
│       └── test.env          — Fixture env file for utils tests
├── CONFIG/
│   └── config.env            — Runtime configuration (gitignored; see config.env.sample)
├── vendo.service             — systemd service unit (managed by setup_and_run.sh)
└── Makefile                  — OS-aware build (Windows mock vs Linux wiringPi)
```

### Data flow

```
Coin inserted
    → GPIO interrupt → processTimer(pumpIdx)           [pump_control.cpp]
    → checks: coinCredit >= cost AND pump slot not empty (WLVL_PRESSED)
    → PumpState.timer set, pump GPIO driven HIGH

pump_loop() [called every 1 ms in main while-loop]
    → handlePump() for each of 4 pumps                 [pump_control.cpp]
    → turns GPIO pin ON/OFF based on timer and pause state
    → calls processSaving() when pump finishes

server_app_loop() [called every 1 ms alongside pump_loop]
    → parses commands from connected TCP clients:       [socket_server.cpp]
        COIN,<n>             — adds credit to AppState.coinCredit
        VOUCHER,<id>,<n>     — enqueues voucher, adds credit
        WTRLVL,<p1..p4>      — updates WLVL_PRESSED flags (slot-empty protection)
        STATUS (or any other) — returns current machine state
```

### Socket protocol

| Command | Format | Effect |
|---------|--------|--------|
| Add coins | `COIN,<amount>` | Increments `coinCredit` (capped at `maxCoinCredit`) |
| Redeem voucher | `VOUCHER,<id>,<amount>` | Enqueues voucher + adds credit |
| Water level | `WTRLVL,<p1>,<p2>,<p3>,<p4>` | Sets water-level-empty flags per pump (1 = empty) |
| Status poll | `STATUS` | Returns `STATUS:<credit>,<t1>,<t2>,<t3>,<t4>,<wl1>,<wl2>,<wl3>,<wl4>,<pause>` |

All commands are validated (comma count checked) before parsing; malformed messages are logged and dropped.

### Slot-empty protection (Phase 11)

Before triggering a pump, `processTimer()` checks `state.WLVL_PRESSED[pumpIdx]`. If the water level sensor for that slot reports empty (`true`), the pump is not activated even if the customer has sufficient credit. Credit is not deducted. This prevents the machine from dispensing air when a soap container runs out.

The `WLVL_PRESSED` flags are set by `water_level_monitoring_v2.py` (in `/uploaderTransaction`) via the `WTRLVL` socket command, and reflected back to clients in the `STATUS` response.

---

## Dependencies and Libraries

### Runtime (Raspberry Pi)

| Library | Purpose | Install |
|---------|---------|---------|
| **WiringPi** | GPIO and I2C control | Built from source via `install_dependencies.sh` |
| **C++17 stdlib** | `std::filesystem`, `std::chrono`, `std::thread` | Included with GCC 8+ |
| **POSIX sockets** | TCP server | Included with Linux libc |

### Development (Windows)

| Tool | Purpose | Install |
|------|---------|---------|
| **MSYS2 MinGW64** | GCC toolchain for Windows | https://www.msys2.org — then `pacman -S mingw-w64-x86_64-gcc` |
| **GNU Make** | Build system | `pacman -S make` in MSYS2 |
| **ws2_32** | Windows sockets (Winsock2) | Bundled with MinGW64 |
| **mock/wiringPi** | GPIO stubs for Windows builds | Included in this repo under `mock/` |

---

## Install / Setup

### On Raspberry Pi (production)

Use the top-level install scripts from the repo root:

```bash
chmod +x install_dependencies.sh
./install_dependencies.sh

chmod +x setup_and_run.sh
./setup_and_run.sh 2>&1 | tee setup_run.log
```

`install_dependencies.sh` installs WiringPi, FLTK, Node.js, PM2, and journalctl.
`setup_and_run.sh` builds all C++ projects, sets up Python venvs, and registers all PM2 processes.

To set up manually:

1. **Create the config file**
   ```bash
   mkdir -p CONFIG
   cp ../CONFIG/config.env.sample CONFIG/config.env
   # Edit CONFIG/config.env: set vendorId, machineId, SERVER_PORT, TRANSACTION_DIR
   ```

2. **Build**
   ```bash
   make
   # Produces: main  (no .exe on Linux)
   ```

3. **Install the systemd service** (handled automatically by `setup_and_run.sh`)
   ```bash
   sudo cp vendo.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable vendo
   ```

### On Windows (development)

1. **Install MSYS2** from https://www.msys2.org

2. **Open MinGW64 terminal** and install tools:
   ```bash
   pacman -S mingw-w64-x86_64-gcc make
   ```

3. **Clone the repository** and navigate to `coin_slot/`

4. **Build** (mock layer is used automatically):
   ```bash
   make
   # Produces: main.exe
   ```

---

## How to Run / Activate

### Raspberry Pi — PM2 (via setup_and_run.sh)

The `coin_slot` binary is registered as PM2 process **`01_Main`**. To manage it:

```bash
sudo pm2 status                   # show all processes
sudo pm2 restart 01_Main          # restart
sudo pm2 logs 01_Main             # tail logs
```

### Raspberry Pi — manual run

```bash
cd /home/dgsi/Desktop/dispenser/coin_slot
./main
```

The process reads `CONFIG/config.env` on startup, binds TCP on the configured port (default `8080`), sets up GPIO interrupt handlers for all 4 pumps, then enters the main loop.

### Raspberry Pi — systemd service (legacy)

```bash
sudo systemctl start vendo
sudo systemctl stop vendo         # sends SIGTERM; all pumps turn OFF before exit
journalctl -u vendo -f            # follow logs
```

### Windows — quick run

```bash
make run
```

GPIO calls are intercepted by the mock layer and print `[MOCK]` output to stdout.

---

## How to Test

Tests run on Windows using the mock WiringPi layer. They do **not** require a Raspberry Pi.

### Run all tests

```bash
# From MinGW64 terminal inside coin_slot/
make test
```

Output format:

```
Coin Slot Unit Tests
====================
[utils] PASS test_trim_basic
...
[phase10 (structured logging)] PASS test_log_info_goes_to_stdout
...
====================
Results: 95 passed, 0 failed
```

A non-zero exit code means at least one test failed.

### Test suites

| Suite | File | What it covers |
|-------|------|---------------|
| `utils` | `test_utils.cpp` | `trim()`, `loadEnv()`, `format_current_time()`, `ensureDirectoryExists()` |
| `voucher` | `test_voucher.cpp` | Voucher queue enqueue/dequeue/total |
| `socket_cmd` | `test_socket_cmd.cpp` | Command parsing, `socket_count_commas()` |
| `mock` | `test_mock.cpp` | Mock wiringPi stubs compile and run without crash |
| `hardware` | `test_hardware.cpp` | `pin_pump` map, relay polarity constants |
| `phase2` | `test_phase2.cpp` | JSON transaction file writing |
| `phase3` | `test_phase3.cpp` | `AppState` defaults, field mutation, independence |
| `phase4` | `test_phase4.cpp` | `productMap` values and millisecond timing derived from `durationSeconds` |
| `phase5` | `test_phase5.cpp` | `processSaving()` reads `machineId`/`vendorId` from `AppState`, not externs |
| `phase6` | `test_phase6.cpp` | Build layout: `tests/fixtures` exists, required headers present |
| `phase7` | `test_phase7.cpp` | Input validation (comma count), credit cap, `remaining_time` clamp math |
| `phase8` | `test_phase8.cpp` | `durationSeconds` field, `serverPort`/`transactionDir` defaults, no debug stdout |
| `phase9` | `test_phase9.cpp` | `voucherQueue` in AppState, FIFO order, `maxCoinCredit` default/override |
| `phase10` | `test_phase10.cpp` | `log_info`/`log_error` stream routing, module tag format, timestamp structure |
| `socket_integration` | `test_socket_integration.cpp` | Full TCP server integration: 18 end-to-end cases |

### Clean build artifacts

```bash
make clean
```

Removes all `.o` files, compiled headers (`.gch`), and the test runner binary.
