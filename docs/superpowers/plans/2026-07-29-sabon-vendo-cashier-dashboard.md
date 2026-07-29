# Sabon Vendo — Cashier Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert sabon_express_dispenser from shared coin-credit model to per-slot armed-state model controlled by a cashier dashboard.

**Architecture:** Modify the C++ `coin_slot` TCP server to replace the shared `coinCredit` pool with a per-slot `armedQty` array. Remove all payment-related components (coin acceptor, QR scanner, customer GUI). Add LED GPIO per slot. Build a new cashier dashboard as a local web app.

**Tech Stack:** C++ (coin_slot core), Python (uploader/water-level), HTML/JS (cashier dashboard), Raspberry Pi GPIO (WiringPi)

## Global Constraints

- Only slots 1-4 are physically wired; slots 5-6 are reserved ("Not Available")
- Transaction JSON logging must continue working for cloud upload
- Water-level slot-empty protection must continue working
- Socket server must remain LAN-reachable (already binds INADDR_ANY)
- Config.env is the single config file for all components

---

## File Structure Map

| File | Action | Responsibility |
|------|--------|----------------|
| `coin_slot/includes/app_state.h` | Modify | State: armedQty array, per-slot queues |
| `coin_slot/includes/hardware_config.h` | Modify | LED pin declarations |
| `coin_slot/src/hardware_config.cpp` | Modify | LED pin config loading |
| `coin_slot/src/socket_server.cpp` | Modify | ARM command, updated STATUS |
| `coin_slot/src/pump_control.cpp` | Modify | Per-slot credit check, LED output, queue |
| `coin_slot/src/voucher_manager.cpp` | Delete | No longer needed |
| `coin_slot/includes/voucher_manager.h` | Delete | No longer needed |
| `coin_slot/main.cpp` | Modify | Remove voucher_manager include |
| `coin_slot/Makefile` | Modify | Remove voucher_manager from build |
| `CONFIG/config.env.sample` | Modify | LED pins, remove coin keys |
| `CONFIG/README.md` | Modify | Document new keys |
| `README.md` | Modify | Updated architecture, PM2 table |
| `setup_and_run.sh` | Modify | Remove dead processes |
| `install_dependencies.sh` | Modify | Remove FLTK (no longer needed for GUI) |
| `arduino_firmware/` | Delete | Entire directory |
| `keyboard_monitoring/` | Delete | Entire directory |
| `iot_dispenser_v2/` | Delete | Entire directory |
| `usb_to_coin_module/coin_counter.py` | Delete | Coin acceptor |
| `uploaderTransaction/qr_gen.py` | Delete | QR generation |
| `coin_slot/tests/test_voucher.cpp` | Delete | Voucher tests |
| `coin_slot/tests/test_phase7.cpp` | Modify | Remove voucher-dependent cases |
| `coin_slot/tests/test_phase9.cpp` | Modify | Remove voucher-dependent cases |
| `coin_slot/tests/test_socket_integration.cpp` | Modify | ARM tests, remove COIN/VOUCHER |
| `coin_slot/tests/test_socket_cmd.cpp` | Modify | ARM command parsing tests |
| `coin_slot/tests/run_tests.cpp` | Modify | Remove test_voucher from runner |
| `cashier_dashboard/` | Create | New: dashboard web app |

---

### Task 1: Create working backup

**Files:**
- Create: `docs/superpowers/plans/2026-07-29-sabon-vendo-cashier-dashboard.md` (this file)

- [ ] **Step 1: Create a git backup branch**

```bash
git init
git add -A
git commit -m "chore: baseline before sabon-vendo conversion

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 2: Verify backup exists**

```bash
git log --oneline -1
```

Expected: Shows the baseline commit

---

### Task 2: Remove payment-related components

**Files:**
- Delete: `arduino_firmware/`
- Delete: `keyboard_monitoring/`
- Delete: `iot_dispenser_v2/`
- Delete: `usb_to_coin_module/coin_counter.py`
- Delete: `uploaderTransaction/qr_gen.py`

- [ ] **Step 1: Delete the directories and files**

```bash
rm -rf arduino_firmware/
rm -rf keyboard_monitoring/
rm -rf iot_dispenser_v2/
rm -f usb_to_coin_module/coin_counter.py
rm -f uploaderTransaction/qr_gen.py
```

- [ ] **Step 2: Verify deletions**

```bash
test ! -d arduino_firmware && echo "arduino_firmware removed"
test ! -d keyboard_monitoring && echo "keyboard_monitoring removed"
test ! -d iot_dispenser_v2 && echo "iot_dispenser_v2 removed"
test ! -f usb_to_coin_module/coin_counter.py && echo "coin_counter.py removed"
test ! -f uploaderTransaction/qr_gen.py && echo "qr_gen.py removed"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: remove payment-related components (coin, QR, GUI)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update setup scripts and README

**Files:**
- Modify: `setup_and_run.sh`
- Modify: `install_dependencies.sh`
- Modify: `README.md`
- Modify: `CONFIG/config.env.sample`

- [ ] **Step 1: Update setup_and_run.sh — remove dead PM2 processes**

In `setup_and_run.sh`, remove:
- Lines 246-251: `02_Coin_Acceptor` PM2 registration block
- Lines 260-270: `04_QR_Scanner` PM2 registration block
- Lines 97-98: `build_cpp "iot_dispenser_v2"` call
- Lines 141-143: `setup_venv "keyboard_monitoring"`, `setup_venv "usb_to_coin_module"` calls
- Lines 305-381: Entire Section 4 (vendo_gui.service configuration)

- [ ] **Step 2: Update install_dependencies.sh — remove FLTK**

Remove lines 81-98 (Section 2: FLTK installation) and the FLTK summary line.

- [ ] **Step 3: Update README.md — new architecture diagram and PM2 table**

Replace the architecture overview with the new cashier-dashboard flow. Remove PM2 rows for `02_Coin_Acceptor`, `04_QR_Scanner`. Remove the `iot_dispenser_v2` section. Update the debugging commands.

- [ ] **Step 4: Update config.env.sample — remove coin keys, add LED pins**

Remove: `SERIAL_PORT`, `BAUD_RATE`, `slotName1-4`, `slotColor1-4`, `MAX_COIN_CREDIT`
Add:
```
# --- LED output pins (BCM numbering, one per product slot) ---
LED1 = 5
LED2 = 6
LED3 = 12
LED4 = 13
# LED5 = (reserved)
# LED6 = (reserved)
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: update scripts, README, and config for cashier model

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Modify app_state.h — per-slot armed state

**Files:**
- Modify: `coin_slot/includes/app_state.h`

**Interfaces:**
- Produces: `AppState::armedQty[7]` (int array, indices 1-6), `AppState::pendingQueue[7]` (vector of pending ARM requests per slot), `AppState::slotBusy[7]` (bool array)

- [ ] **Step 1: Replace state model**

Replace the contents of `coin_slot/includes/app_state.h`:

```cpp
#ifndef APP_STATE_H
#define APP_STATE_H

#include <string>
#include <vector>
#include <queue>

struct PendingArm {
    int productId;
    int qty;
    PendingArm(int id = 0, int q = 0) : productId(id), qty(q) {}
};

struct AppState {
    // Per-slot armed quantity (indices 1-6; 1-4 active, 5-6 reserved)
    volatile int armedQty[7] = {0};

    // Per-slot busy flag — true while a slot is mid-dispense or has an active timer
    bool slotBusy[7] = {false};

    // Per-slot pending queue — ARM requests waiting while slot is busy
    std::queue<PendingArm> pendingQueue[7];

    std::string machineId = "1";
    std::string vendorId;

    // Configurable at runtime from config.env
    int serverPort = 8080;
    std::string transactionDir = "../transaction";

    long long remaining_time[5] = {0};  // index 1-4, milliseconds, always >= 0
    bool WLVL_PRESSED[5] = {false};     // index 1-4
    bool state_pause = false;
};

#endif // APP_STATE_H
```

Note: Removed `coinCredit`, `maxCoinCredit`, `voucherQueue`, and the `voucher_manager.h` include.

- [ ] **Step 2: Verify the header compiles**

No separate compilation needed for headers — build will verify in later tasks.

- [ ] **Step 3: Commit**

```bash
git add coin_slot/includes/app_state.h
git commit -m "feat: replace shared coinCredit with per-slot armedQty array

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Modify hardware_config — add LED pins

**Files:**
- Modify: `coin_slot/includes/hardware_config.h`
- Modify: `coin_slot/src/hardware_config.cpp`

**Interfaces:**
- Produces: `extern int LED1, LED2, LED3, LED4;` (BCM pin numbers)
- Produces: `extern std::map<int, int> pin_led;` (maps slot index → LED BCM pin)

- [ ] **Step 1: Add LED declarations to hardware_config.h**

Add after the existing `extern int PUMP_TRIGGER_LOW;` line:

```cpp
extern int LED1, LED2, LED3, LED4;
```

Add after `extern std::map<int, int> pin_pump;`:

```cpp
extern std::map<int, int> pin_led;
```

- [ ] **Step 2: Add LED defaults and config loading to hardware_config.cpp**

Add default pin values after the existing pump pin defaults:

```cpp
int LED1 = 5, LED2 = 6, LED3 = 12, LED4 = 13;
```

Add after `pin_pump` initialization:

```cpp
std::map<int, int> pin_led {
    {1, LED1}, {2, LED2}, {3, LED3}, {4, LED4}
};
```

At the end of `init_hardware_config()`, add LED pin loading and map rebuild:

```cpp
load_int("LED1", LED1);
load_int("LED2", LED2);
load_int("LED3", LED3);
load_int("LED4", LED4);

pin_led = {{1, LED1}, {2, LED2}, {3, LED3}, {4, LED4}};
```

- [ ] **Step 3: Commit**

```bash
git add coin_slot/includes/hardware_config.h coin_slot/src/hardware_config.cpp
git commit -m "feat: add per-slot LED GPIO pin configuration

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Modify socket_server — ARM command, updated STATUS

**Files:**
- Modify: `coin_slot/src/socket_server.cpp`
- Modify: `coin_slot/includes/socket_server.h` (remove MAX_COIN_CREDIT if referenced)
- Modify: `coin_slot/main.cpp`

- [ ] **Step 1: Remove voucher_manager include from socket_server.cpp**

Change line 2 from:
```cpp
#include "voucher_manager.h"
```
to:
```cpp
// voucher_manager removed — per-slot armed state used instead
```

- [ ] **Step 2: Update build_status_response()**

Replace the function (lines 117-129) with:

```cpp
static std::string build_status_response(AppState &state)
{
  // Format: STATUS,armedQty1,armedQty2,armedQty3,armedQty4,
  //         remaining1,remaining2,remaining3,remaining4,
  //         wlvl1,wlvl2,wlvl3,wlvl4,
  //         busy1,busy2,busy3,busy4,
  //         queueDepth1,queueDepth2,queueDepth3,queueDepth4,
  //         paused
  std::string resp = "STATUS";
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.armedQty[i]);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.remaining_time[i]);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.WLVL_PRESSED[i] ? 1 : 0);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.slotBusy[i] ? 1 : 0);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string((int)state.pendingQueue[i].size());
  }
  resp += "," + std::to_string(state.state_pause ? 1 : 0);
  return resp;
}
```

- [ ] **Step 3: Replace COIN/VOUCHER handlers with ARM handler**

In `manage_connected_clients()`, replace the VOUCHER block (lines 190-209) and the COIN block (lines 235-251) with a single ARM handler. The ARM handler should appear first in the if-else chain (before WTRLVL):

```cpp
if (isFirstWordTest(client_buffer, "ARM"))
{
  if (socket_count_commas(client_buffer) != 2)
  {
    log_error("socket", std::string("Malformed ARM (expected 2 commas): ") + client_buffer);
  }
  else
  {
    std::string input_str(client_buffer);
    size_t p1 = input_str.find(',');
    size_t p2 = input_str.find(',', p1 + 1);
    int productId = std::stoi(input_str.substr(p1 + 1, p2 - (p1 + 1)));
    int qty = std::stoi(input_str.substr(p2 + 1));

    if (productId < 1 || productId > 4)
    {
      log_error("socket", std::string("ARM rejected — invalid product ID: ") + std::to_string(productId));
    }
    else if (qty <= 0)
    {
      log_error("socket", std::string("ARM rejected — invalid qty: ") + std::to_string(qty));
    }
    else if (state.slotBusy[productId])
    {
      // Slot is busy — queue the request
      state.pendingQueue[productId].push(PendingArm(productId, qty));
      log_info("socket", "ARM queued for busy slot " + std::to_string(productId) +
               "  qty=" + std::to_string(qty) +
               "  queueDepth=" + std::to_string((int)state.pendingQueue[productId].size()));
    }
    else
    {
      state.armedQty[productId] += qty;
      log_info("socket", "ARM accepted  product=" + std::to_string(productId) +
               "  qty=" + std::to_string(qty) +
               "  totalArmed=" + std::to_string(state.armedQty[productId]));
    }
    broadcast_status(state);
  }
}
```

- [ ] **Step 4: Update main.cpp — remove voucher_manager include**

Remove the line `#include "includes/voucher_manager.h"` if present (check first — it may not be there directly; `app_state.h` previously included it but we already removed that).

- [ ] **Step 5: Commit**

```bash
git add coin_slot/src/socket_server.cpp coin_slot/includes/socket_server.h coin_slot/main.cpp
git commit -m "feat: add ARM command handler, update STATUS protocol

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Modify pump_control — per-slot credit, LED output, queue

**Files:**
- Modify: `coin_slot/src/pump_control.cpp`

**Interfaces:**
- Consumes: `state.armedQty[i]`, `state.slotBusy[i]`, `state.pendingQueue[i]`, `pin_led[i]`
- Produces: Updated `executeDispenseTrigger()`, `handlePump()`, `pump_setup()`

- [ ] **Step 1: Remove voucher_manager include**

Change the include at top from:
```cpp
#include "voucher_manager.h"
```
to:
```cpp
// voucher_manager removed
```

- [ ] **Step 2: Update executeDispenseTrigger()**

Replace the credit check (line 77):
```cpp
if ((state.coinCredit >= product.coins) && (!atleast2PumpOn || pumpAlreadyOn) && !isSlotEmpty && !isMachinePaused) {
    state.coinCredit -= product.coins;
```
with:
```cpp
if ((state.armedQty[pumpIdx] > 0) && (!atleast2PumpOn || pumpAlreadyOn) && !isSlotEmpty && !isMachinePaused) {
    state.armedQty[pumpIdx]--;
```

And update the log message on line 71-73:
```cpp
log_info("pump", "Button " + std::to_string(pumpIdx) + ": TRIGGERED"
          "  armedQty=" + std::to_string(state.armedQty[pumpIdx]) +
          "  required=1");
```

Update the ACCEPTED log (lines 89-90):
```cpp
log_info("pump", "Button " + std::to_string(pumpIdx) + ": ACCEPTED"
          "  armedQty_now=" + std::to_string(state.armedQty[pumpIdx]) + "  added=" + std::to_string(ms) + "ms");
```

Update the DENIED log (lines 100-101):
```cpp
log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=insufficient_credit"
          "  armedQty=" + std::to_string(state.armedQty[pumpIdx]) + "  required=1");
```

- [ ] **Step 3: Update handlePump() — remove voucher splitting, add queue release**

Replace the dispense-complete block (lines 129-145) in `handlePump()`:

```cpp
if (pump.isPumping) {
    log_info("pump", "Pump " + std::to_string(pump.id) + ": STOPPED  dispensed=" + std::to_string(pump.amount) + " coins");
    processSaving(state, pump.id, pump.amount, "");
    pump.amount    = 0;
    pump.isPumping = false;

    // Release this slot: mark idle, then check pending queue
    state.slotBusy[pump.id] = false;

    // If there are pending ARM requests for this slot, arm the next one
    if (!state.pendingQueue[pump.id].empty()) {
        PendingArm next = state.pendingQueue[pump.id].front();
        state.pendingQueue[pump.id].pop();
        state.armedQty[pump.id] += next.qty;
        log_info("pump", "Slot " + std::to_string(pump.id) + ": dequeued pending ARM"
                  "  qty=" + std::to_string(next.qty) +
                  "  totalArmed=" + std::to_string(state.armedQty[pump.id]));
    }
}
```

- [ ] **Step 4: Add LED output in pump_loop()**

After the remaining-time update loop (after line 240), add LED output:

```cpp
// 2b. Update LED outputs — HIGH while armed, LOW when 0
for (int i = 1; i <= 4; i++) {
    digitalWrite(pin_led[i], state.armedQty[i] > 0 ? HIGH : LOW);
}
```

- [ ] **Step 5: Add slotBusy tracking**

In `executeDispenseTrigger()`, after the pump timer extension (after the `digitalWrite(pump_pin, PUMP_TRIGGER_HIGH)` line), add:

```cpp
state.slotBusy[pumpIdx] = true;
```

- [ ] **Step 6: Add LED pin setup in pump_setup()**

In `pump_setup()`, after the pump pin output configuration loop (after line 192), add:

```cpp
for (int i = 1; i <= 4; ++i) {
    pinMode(pin_led[i], OUTPUT);
    digitalWrite(pin_led[i], LOW);
}
```

- [ ] **Step 7: Update pump_shutdown() — turn off LEDs too**

Add after the pump loop in `pump_shutdown()`:

```cpp
for (int i = 1; i <= 4; i++)
    digitalWrite(pin_led[i], LOW);
```

- [ ] **Step 8: Commit**

```bash
git add coin_slot/src/pump_control.cpp
git commit -m "feat: per-slot armed-qty dispense logic with LED output and queue handling

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Remove voucher_manager, update Makefile

**Files:**
- Delete: `coin_slot/src/voucher_manager.cpp`
- Delete: `coin_slot/includes/voucher_manager.h`
- Modify: `coin_slot/Makefile`

- [ ] **Step 1: Delete voucher_manager files**

```bash
rm -f coin_slot/src/voucher_manager.cpp
rm -f coin_slot/includes/voucher_manager.h
```

- [ ] **Step 2: Update Makefile**

Read the Makefile first, then remove `voucher_manager.o` from the OBJS list.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: remove voucher_manager, update Makefile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Update tests for new model

**Files:**
- Delete: `coin_slot/tests/test_voucher.cpp`
- Modify: `coin_slot/tests/run_tests.cpp`
- Modify: `coin_slot/tests/test_socket_cmd.cpp`
- Modify: `coin_slot/tests/test_socket_integration.cpp`

- [ ] **Step 1: Delete test_voucher.cpp**

```bash
rm -f coin_slot/tests/test_voucher.cpp
```

- [ ] **Step 2: Update run_tests.cpp — remove test_voucher registration**

Read `run_tests.cpp` and remove the test_voucher include and registration call.

- [ ] **Step 3: Update test_socket_cmd.cpp — add ARM tests, remove COIN/VOUCHER**

Add ARM command parsing tests. Read the current file first, then add:

```cpp
// Test ARM command parsing
bool test_arm_valid() {
    // Parse "ARM,1,3" → productId=1, qty=3
    // ... implementation depends on whether parse logic is exposed
    return true;  // Placeholder — implement after reading actual test patterns
}

bool test_arm_invalid_product() {
    // "ARM,7,1" → rejected (product 7 out of range)
    return true;
}

bool test_arm_invalid_qty() {
    // "ARM,1,0" → rejected (qty must be > 0)
    return true;
}
```

- [ ] **Step 4: Update test_socket_integration.cpp**

Read `test_socket_integration.cpp`. Replace COIN/VOUCHER integration test cases with ARM command integration tests.

- [ ] **Step 5: Update other test files that reference coinCredit or vouchers**

Check `test_phase7.cpp`, `test_phase9.cpp` for references to `coinCredit`, `voucher`, `VOUCHER`, `COIN`. Remove or update those test cases.

- [ ] **Step 6: Commit**

```bash
git add coin_slot/tests/
git commit -m "test: update tests for ARM command and per-slot armed state

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Build and verify coin_slot compiles

**Files:**
- Verify: `coin_slot/Makefile`

- [ ] **Step 1: Build coin_slot**

```bash
cd coin_slot && make clean && make
```

Expected: Build succeeds with no errors.

- [ ] **Step 2: Run tests**

```bash
cd coin_slot && ./run_tests
```

Expected: All tests pass (or skip gracefully on non-Pi hardware).

- [ ] **Step 3: Commit any build fixes**

```bash
git add -A
git commit -m "build: fix compilation issues from state model changes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Build cashier dashboard

**Files:**
- Create: `cashier_dashboard/package.json`
- Create: `cashier_dashboard/server.js`
- Create: `cashier_dashboard/public/index.html`
- Create: `cashier_dashboard/public/style.css`
- Create: `cashier_dashboard/public/app.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "sabon-cashier-dashboard",
  "version": "1.0.0",
  "description": "Cashier dashboard for Sabon Vendo",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2"
  }
}
```

- [ ] **Step 2: Create server.js**

Node.js Express server that:
- Serves static files from `public/`
- Acts as a TCP client to `coin_slot` on `SOCKET_IP:SOCKET_PORT` (from config.env)
- Forwards `ARM,<productId>,<qty>` commands from the web UI to `coin_slot`
- Parses `STATUS` responses and pushes them to the web UI via SSE or WebSocket
- Proxies status to the frontend

- [ ] **Step 3: Create index.html**

Single-file dashboard with:
- Machine status bar (online/offline, paused/running, last update time)
- Product grid: 6 tiles in a 3×2 grid. Slots 1-4 show product name, current armed qty, busy/idle badge, water-level status. Slots 5-6 show "Not Available" overlay.
- Transaction panel: product selector (checkboxes for multi-product sale), qty input, "Sell" button
- Armed slots panel: shows which products are currently armed with remaining qty, cancel button per product
- Queue view: shows pending orders per slot
- Alerts section: slot empty, jam/error, machine offline

- [ ] **Step 4: Create app.js**

Client-side JavaScript that:
- Connects to server SSE endpoint for live STATUS updates
- Renders product grid, armed slots, queue, alerts
- Handles "Sell" button: sends selected products + qtys to server
- Handles per-product cancel (sends a CANCEL command if implemented, or just updates UI)

- [ ] **Step 5: Create style.css**

Clean, functional dashboard styling — dark header, product grid cards, status badges, alert colors.

- [ ] **Step 6: Commit**

```bash
git add cashier_dashboard/
git commit -m "feat: add cashier dashboard web app

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Add dashboard to PM2 setup

**Files:**
- Modify: `setup_and_run.sh`

- [ ] **Step 1: Add dashboard PM2 registration**

In `setup_and_run.sh`, add a new PM2 registration after `07_Status_Upload`:

```bash
# 08_Cashier_Dashboard — cashier_dashboard Node.js server
pm2_start_node() {
  local pm2_name="$1"
  local script="$2"
  local cwd="$3"
  shift 3

  log "[$pm2_name] Registering Node.js server: $script"

  if [ ! -f "$script" ]; then
    err "[$pm2_name] Script not found: $script"
    return 1
  fi

  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — restarting"
    sudo pm2 restart "$pm2_name"
  else
    log "[$pm2_name] New process — starting for the first time"
    sudo pm2 start "$script" \
      --name "$pm2_name" \
      --cwd "$cwd" \
      --log "$cwd/pm2_${pm2_name}.log" \
      --time
  fi
}

pm2_start_node \
  "08_Cashier_Dashboard" \
  "$SCRIPT_DIR/cashier_dashboard/server.js" \
  "$SCRIPT_DIR/cashier_dashboard"
```

Also run `cd "$SCRIPT_DIR/cashier_dashboard" && npm install` in the setup flow.

- [ ] **Step 2: Update README.md PM2 table**

Add `08_Cashier_Dashboard` row to the PM2 process table.

- [ ] **Step 3: Commit**

```bash
git add setup_and_run.sh README.md
git commit -m "feat: add cashier dashboard to PM2 startup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: End-to-end verification checklist

No code changes — verify each scenario manually:

- [ ] **Single-product sale:** ARM slot 1 with qty=1 → LED1 lights → button 1 dispenses → LED1 off → STATUS updates
- [ ] **Multi-product sale:** ARM slots 1 and 2 simultaneously → both LEDs light → each button only affects its own slot
- [ ] **Queue behavior:** ARM slot 1 qty=2 → press button 1 (first dispense starts) → ARM slot 1 qty=1 (queued) → after first dispense finishes, second arms automatically
- [ ] **Slot-empty protection:** Empty water level sensor → armed slot still refuses to dispense
- [ ] **Cancel armed credit:** (if CANCEL command implemented) — verify armed qty returns to 0
- [ ] **Dashboard status sync:** Dashboard reflects live armed qty, busy/idle, queue depth
