// =============================================================================
// pump_control.cpp — Non-blocking per-product dispense state machine
//
// Transaction flow (millis()-driven, no blocking):
//
//   IDLE ──ARM_BATCH──> ARMED ──button press──> DISPENSING
//     ^                   │  ▲                      │
//     │                   │  └── more credit left ───┘
//     │                   │
//     │                   └── all credits consumed ──> COMPLETE
//     │                                                    │
//     └────────────────────────────────────────────────────┘
//
// Per-product state (shared GPIO pin = button input + LED output):
//   armedQty > 0  →  LED ON  (OUTPUT HIGH), button live
//   armedQty = 0  →  LED OFF (OUTPUT LOW),  button ignored
//
// Each button press dispenses ONE ₱5 increment:
//   - Decrements armedQty[slot] by 1
//   - Runs pump for base_seconds[slot] (calibrated per product)
//   - ₱15 credit = 3 presses, each running 1× base_seconds
//
// Shared GPIO wiring (isSharedPin(i)):
//   3.3V ── button ── GPIO ── 800Ω ── LED(+) ── LED(-) ── GND
//   OUTPUT HIGH = LED on (current through 800Ω + LED to GND).
//   Every ~20ms: briefly (~1ms) INPUT + internal pull-down to sample button.
//   Button pressed  → 3.3V reaches pin → reads HIGH.
//   Button released → pull-down → reads LOW.
//   Pin switches back to OUTPUT. LED appears solid — flicker invisible.
//
// Jam protection:
//   armedUnitsReserved tracks in-flight dispenses. If postPressDeadline
//   expires without pump completing, credit is refunded to armedQty.
// =============================================================================

#include "pump_control.h"
#include "hardware_config.h"
#include "transaction.h"
#include "utils.h"
#include <wiringPi.h>
#include <cstdio>
#include <chrono>
#include <algorithm>
#include <mutex>
#include <string>
#include <thread>

// ------------------------------------------------------------------------------
// Module-private state
// ------------------------------------------------------------------------------
struct PumpState {
    int id = 0;
    bool isPumping = false;
    bool isPaused = false;
    double amount = 0;
    long long remainingTimeWhenPaused = 0;
    std::chrono::time_point<std::chrono::steady_clock> timer{};

    // --- Added for Smart Anti-Surge & Hold Tracking ---
    bool buttonWasPressedLastFrame = false;
    std::chrono::time_point<std::chrono::steady_clock> pressStartTime{};
    bool processingTrigger = false;

    // --- Jam protection (v2 plan): track reserved units in-flight ---
    // armedQty is decremented on button press but the sale is NOT final
    // until the dispense timer completes (sensor-confirmed via timeout).
    // If the pump jams, reserved units are refunded to armedQty.
    int armedUnitsReserved = 0;
    std::chrono::time_point<std::chrono::steady_clock> postPressDeadline{};
};

static std::mutex     g_pump_mutex;
static PumpState      pumps[7];          // index 1-6
static AppState      *g_state_ptr = nullptr;
static int            g_pump_start_cooldown_ms = 200;
static std::chrono::time_point<std::chrono::steady_clock> g_last_pump_start = std::chrono::steady_clock::now() - std::chrono::seconds(1);

static bool           STOP_PRESSED      = false;
static bool           STOP_BTN_PREVIOUS = false;

// Button pin lookup now uses pin_button map from hardware_config

// ------------------------------------------------------------------------------
// Dispense Trigger Logic
// ------------------------------------------------------------------------------
static void executeDispenseTrigger(int pumpIdx) {
    auto current_time = std::chrono::steady_clock::now();

    // Cross-pump cooldown: suppress spurious relay-noise triggers
    if (std::chrono::duration_cast<std::chrono::milliseconds>(current_time - g_last_pump_start).count() < g_pump_start_cooldown_ms) {
        log_info("pump", "Button " + std::to_string(pumpIdx) + ": COOLDOWN (pump-start suppression)");
        return;
    }

    PumpState &pump   = pumps[pumpIdx];
    Product   &product = productMap[pumpIdx];
    int        pump_pin = pin_pump[pumpIdx];
    AppState  &state    = *g_state_ptr;

    int activePumps = 0;
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (pumps[i].timer > current_time) activePumps++;
    }

    bool atleast2PumpOn = (activePumps >= 2);
    bool pumpAlreadyOn  = (pump.timer > current_time);
    bool isSlotEmpty = state.WLVL_PRESSED[pumpIdx];

    // CRITICAL FIX: Track if the machine is actively paused
    bool isMachinePaused = state.state_pause;

    log_info("pump", "Button " + std::to_string(pumpIdx) + ": TRIGGERED"
              "  armedQty=" + std::to_string(state.armedQty[pumpIdx]) +
              "  required=1" +
              "  paused=" + std::to_string(isMachinePaused));

    // Per-slot armed-qty check: each button press only spends from its own slot
    if ((state.armedQty[pumpIdx] > 0) && (!atleast2PumpOn || pumpAlreadyOn) && !isSlotEmpty && !isMachinePaused) {
        state.armedQty[pumpIdx]--;
        pump.amount += product.coins;
        int ms = (int)(product.durationSeconds * 1000);
        std::chrono::milliseconds extension(ms);

        if (current_time >= pump.timer)
            pump.timer = current_time + extension;
        else
            pump.timer += extension;

        g_last_pump_start = current_time;
        state.slotBusy[pumpIdx] = true;
        state.phase = TxnPhase::DISPENSING;
        pump.armedUnitsReserved++;
        // Post-press deadline: pump duration + 30 s grace for jam detection
        pump.postPressDeadline = current_time + extension + std::chrono::seconds(30);
        log_info("pump", "Button " + std::to_string(pumpIdx) + ": ACCEPTED"
                  "  armedQty_now=" + std::to_string(state.armedQty[pumpIdx]) +
                  "  reserved=" + std::to_string(pump.armedUnitsReserved) +
                  "  added=" + std::to_string(ms) + "ms");
        digitalWrite(pump_pin, PUMP_TRIGGER_HIGH);
        saveStateToDisk(state, state.transactionDir);
    } else {
        if (isMachinePaused)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=machine_is_paused (Credit Preserved!)");
        else if (isSlotEmpty)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=slot_empty");
        else if (atleast2PumpOn && !pumpAlreadyOn)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=max_pumps_active");
        else
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=insufficient_credit"
                      "  armedQty=" + std::to_string(state.armedQty[pumpIdx]) + "  required=1");
    }
}

static void pauseButtonClicked() {
    g_state_ptr->state_pause = !g_state_ptr->state_pause;
}

// ------------------------------------------------------------------------------
// Per-pump state machine
// ------------------------------------------------------------------------------
static void handlePump(PumpState &pump, AppState &state) {
    if (state.WLVL_PRESSED[pump.id]) {
        if (pump.isPumping)
            log_info("pump", "Pump " + std::to_string(pump.id) + ": STOPPED  reason=water_level_empty");
        digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
 } else if (state.remaining_time[pump.id] > 0) {
        if (pump.isPaused) {
            pump.isPumping = false;
            digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
        } else {
            if (!pump.isPumping)
                log_info("pump", "Pump " + std::to_string(pump.id) + ": RUNNING");
            pump.isPumping = true;
            digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_HIGH);
        }
    } else {
        digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
        if (pump.isPumping) {
            log_info("pump", "Pump " + std::to_string(pump.id) + ": STOPPED  dispensed=" + std::to_string(pump.amount) + " coins");
            // Finalize: dispense confirmed via timeout → decrement reserved, log sale
            if (pump.armedUnitsReserved > 0) {
                pump.armedUnitsReserved--;
            }
            processSaving(state, pump.id, pump.amount, "");
            pump.amount    = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};  // clear deadline

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
            saveStateToDisk(state, state.transactionDir);

            // Bundle complete: no slots armed and no slot busy
            if (!state.anyArmed()) {
                state.phase = TxnPhase::COMPLETE;
                state.bundleComplete = true;
                log_info("pump", "BUNDLE COMPLETE — all slots dispensed");
            }
        }
    }
}

// ------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------
void pump_setup(AppState &state) {
    g_state_ptr = &state;
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pumps[i].id    = i;
        pumps[i].id    = i;
        pumps[i].timer = std::chrono::steady_clock::now();
        pumps[i].buttonWasPressedLastFrame = false;
        pumps[i].processingTrigger = false;
    }

    std::string binDir = get_binary_dir();
    auto config = loadEnv(binDir + "/../CONFIG/config.env");

    if (config.count("machineId"))       state.machineId      = config["machineId"];
    if (config.count("vendorId"))        state.vendorId       = config["vendorId"];

    if (config.count("SOCKET_PORT"))     state.serverPort     = std::stoi(config["SOCKET_PORT"]);
    else if (config.count("SERVER_PORT"))state.serverPort     = std::stoi(config["SERVER_PORT"]);

    if (config.count("TRANSACTION_DIR")) state.transactionDir = config["TRANSACTION_DIR"];
    else                                 state.transactionDir = binDir + "/../transaction";

    // maxCoinCredit removed — per-slot armedQty has no global cap
    if (config.count("PUMP_START_COOLDOWN_MS")) g_pump_start_cooldown_ms = std::stoi(config["PUMP_START_COOLDOWN_MS"]);

    log_info("pump", "Fully Integrated Logic Version 3.0 Live!");
    log_info("pump", "Anti-Surge Setup: 200ms cold hold enforced. Live sessions open for continuous fast-tapping.");

    init_hardware_config(config);
    wiringPiSetupGpio();

    // Configure buttons per-slot: shared pins start as OUTPUT (LED off),
    // separate pins stay as INPUT with pull-down.
    for (int i = 1; i <= TOTAL_SLOTS; ++i) {
        if (isSharedPin(i)) {
            pinMode(pin_button[i], OUTPUT);
            digitalWrite(pin_button[i], LOW);
        } else {
            pinMode(pin_button[i], INPUT);
            pullUpDnControl(pin_button[i], PUD_DOWN);
        }
    }

    for (int i = 1; i <= TOTAL_SLOTS; ++i) {
        pinMode(pin_pump[i], OUTPUT);
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
    }

    // LED pins: if shared with button, stays INPUT (pump_loop handles flip).
    // Separate LED pins: set OUTPUT LOW (off until armed).
    for (int i = 1; i <= TOTAL_SLOTS; ++i) {
        if (!isSharedPin(i)) {
            pinMode(pin_led[i], OUTPUT);
            digitalWrite(pin_led[i], LOW);
        }
    }

    pinMode(PIN_STOP, INPUT); pullUpDnControl(PIN_STOP, PUD_DOWN);

    if (ensureDirectoryExists(state.transactionDir)) {
        log_info("pump", "Transaction dir ready: " + state.transactionDir);
        // Restore armedQty from disk (crash persistence)
        if (loadStateFromDisk(state, state.transactionDir)) {
            log_info("pump", "Restored armed state from disk");
        }
    }
}

void pump_loop(AppState &state) {
    std::lock_guard<std::mutex> lock(g_pump_mutex);
    auto current_time = std::chrono::steady_clock::now();

    // 1. Per-product button scan with shared-GPIO multiplexing.
    //
    //    State machine per product (non-blocking, micros-scale):
    //      armedQty > 0 → LED = ON  (pin is OUTPUT, HIGH)
    //      armedQty = 0 → LED = OFF (pin is OUTPUT, LOW)
    //
    //    Shared-pin read sequence (isSharedPin(i), ~1ms INPUT window):
    //      1. pinMode → INPUT + PUD_DOWN   (pull-down holds pin LOW)
    //      2. delayMicroseconds(1000)      (let pin settle)
    //      3. digitalRead                  (button = 3.3V → HIGH, else LOW)
    //      4. pinMode → OUTPUT             (restore LED drive)
    //      5. digitalWrite                 (HIGH if armed, LOW if not)
    //      LED off for ~1ms every ~20ms — invisible at 50Hz.
    //
    //    Debounce via hold-detection: 200ms continuous press required for
    //    idle pumps. Already-running pumps accept instantly (re-press = extra credit).
    // Rotating single-pin sample: one pin per loop iteration.
    // At 20ms/loop, each pin sampled every 80ms (12.5Hz) — plenty fast.
    // Naturally staggered — no two pins are ever in INPUT mode simultaneously.
    static int sampleSlot = 1;
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        int btnPin = pin_button[i];
        bool isCurrentlyPressed;
        if (isSharedPin(i)) {
            if (i == sampleSlot) {
                pinMode(btnPin, INPUT);
                pullUpDnControl(btnPin, PUD_DOWN);
                delayMicroseconds(1000);  // 1ms INPUT window
                isCurrentlyPressed = (digitalRead(btnPin) == HIGH);
                pinMode(btnPin, OUTPUT);
                digitalWrite(btnPin, state.armedQty[i] > 0 ? HIGH : LOW);
            } else {
                // Not this pin's turn — maintain LED state, skip button read
                isCurrentlyPressed = pumps[i].buttonWasPressedLastFrame
                    ? (digitalRead(btnPin) == HIGH)  // re-read only if was pressed
                    : false;
            }
        } else {
            isCurrentlyPressed = (digitalRead(btnPin) == HIGH);
        }

        if (isCurrentlyPressed) {
            if (!pumps[i].buttonWasPressedLastFrame) {
                pumps[i].buttonWasPressedLastFrame = true;
                pumps[i].pressStartTime = current_time;
                pumps[i].processingTrigger = true;

                // INSTANT SESSION PASS: If pump is already active, process their extra coin immediately!
                if (pumps[i].isPumping) {
                    pumps[i].processingTrigger = false;
                    executeDispenseTrigger(i);
                }
            } else if (pumps[i].processingTrigger) {
                // COLD START ENFORCEMENT: If the pump is idle, calculate continuous hold time
                auto heldDuration = std::chrono::duration_cast<std::chrono::milliseconds>(current_time - pumps[i].pressStartTime).count();

                if (heldDuration >= 200) { // Enforce exactly 0.2 seconds hold verification
                    pumps[i].processingTrigger = false;
                    executeDispenseTrigger(i);
                }
            }
        } else {
            // Button released: clear tracking frames instantly
            pumps[i].buttonWasPressedLastFrame = false;
            pumps[i].processingTrigger = false;
        }

    }
    sampleSlot = (sampleSlot % TOTAL_SLOTS) + 1;

    // 2. Update remaining times safely
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(pumps[i].timer - current_time).count();
        state.remaining_time[i] = std::max(0LL, (long long)diff);
    }

    // 2b. Update LED outputs for separate pins (shared pins already set during button read)
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (!isSharedPin(i)) {
            digitalWrite(pin_led[i], state.armedQty[i] > 0 ? HIGH : LOW);
        }
    }

    // 3. Process Pause/Stop Operations
    STOP_BTN_PREVIOUS = STOP_PRESSED;
    STOP_PRESSED      = digitalRead(PIN_STOP) == HIGH;
    bool isPressPause = (STOP_PRESSED && STOP_PRESSED != STOP_BTN_PREVIOUS);

    if (isPressPause) pauseButtonClicked();

    if (state.state_pause && isPressPause) {
        for (int i = 1; i <= TOTAL_SLOTS; i++) {
            pumps[i].remainingTimeWhenPaused = state.remaining_time[i];
            pumps[i].isPaused = true;
        }
    }

    if (state.state_pause) {
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            pumps[i].timer = current_time + std::chrono::milliseconds(pumps[i].remainingTimeWhenPaused);
    } else if (isPressPause) {
        for (int i = 1; i <= TOTAL_SLOTS; i++) {
            pumps[i].isPaused = false;
            pumps[i].remainingTimeWhenPaused = 0;
        }
    }

    // 4. Tick pump outputs
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        handlePump(pumps[i], state);

    // 4b. Jam timeout detection — refund armedQty if post-press deadline passed
    //     without the pump completing (sensor never confirmed)
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (pumps[i].armedUnitsReserved > 0 &&
            pumps[i].postPressDeadline.time_since_epoch().count() > 0 &&
            current_time > pumps[i].postPressDeadline) {
            // Pump jammed or sensor failed — refund the reserved unit
            state.armedQty[i] += pumps[i].armedUnitsReserved;
            log_error("pump", "Slot " + std::to_string(i) + ": JAM TIMEOUT — refunding "
                      + std::to_string(pumps[i].armedUnitsReserved) + " unit(s) to armedQty="
                      + std::to_string(state.armedQty[i]));
            pumps[i].armedUnitsReserved = 0;
            pumps[i].postPressDeadline = std::chrono::steady_clock::time_point{};
            pumps[i].amount = 0;
            state.slotBusy[i] = false;
            digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
            saveStateToDisk(state, state.transactionDir);
        }
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(20));
}
void pump_shutdown() {
    // Clear persisted state on clean shutdown so PM2 restart starts fresh
    if (g_state_ptr) {
        std::string stateFile = g_state_ptr->transactionDir + "/state.dat";
        std::remove(stateFile.c_str());
    }
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
        if (isSharedPin(i)) {
            // Shared pin: set to OUTPUT LOW (LED off, button won't read but we're shutting down)
            pinMode(pin_button[i], OUTPUT);
            digitalWrite(pin_button[i], LOW);
        } else {
            // Separate pins: turn off LED, button stays as-is
            pinMode(pin_led[i], OUTPUT);
            digitalWrite(pin_led[i], LOW);
        }
    }
}