// =============================================================================
// pump_control.cpp — 6-slot independent button+LED dispense state machine
//
// All pins fully independent — no shared/multiplexed pins.
// Buttons: INPUT + PUD_DOWN, digitalRead every loop.
// LEDs:    OUTPUT, digitalWrite every loop.
// LED7 (Bundle Complete): GPIO26, OUTPUT, driven by state.bundleComplete.
//
// Transaction flow (millis()-driven, non-blocking):
//   IDLE ──ARM_BATCH──> ARMED ──button press──> DISPENSING
//     ^                   │  ▲                      │
//     │                   └── more credit left ─────┘
//     │                          │
//     └── all credits consumed ──┘──> COMPLETE (LED7 on)
//
// Jam protection: armedUnitsReserved tracks in-flight dispenses.
// Post-press deadline expires → refund to armedQty.
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
    bool buttonWasPressedLastFrame = false;
    std::chrono::time_point<std::chrono::steady_clock> pressStartTime{};
    bool processingTrigger = false;
    int armedUnitsReserved = 0;
    std::chrono::time_point<std::chrono::steady_clock> postPressDeadline{};
};

static std::mutex     g_pump_mutex;
static PumpState      pumps[7];          // index 1-6
static AppState      *g_state_ptr = nullptr;
static int            g_pump_start_cooldown_ms = 200;
static std::chrono::time_point<std::chrono::steady_clock> g_last_pump_start =
    std::chrono::steady_clock::now() - std::chrono::seconds(1);

// ------------------------------------------------------------------------------
// Dispense Trigger
// ------------------------------------------------------------------------------
static void executeDispenseTrigger(int pumpIdx) {
    auto current_time = std::chrono::steady_clock::now();

    if (std::chrono::duration_cast<std::chrono::milliseconds>(
            current_time - g_last_pump_start).count() < g_pump_start_cooldown_ms) {
        return;
    }

    PumpState  &pump    = pumps[pumpIdx];
    Product    &product = productMap[pumpIdx];
    int         pump_pin = pin_pump[pumpIdx];
    AppState   &state    = *g_state_ptr;

    int activePumps = 0;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (pumps[i].timer > current_time) activePumps++;

    bool atleast2PumpOn = (activePumps >= 2);
    bool pumpAlreadyOn  = (pump.timer > current_time);
    bool isSlotEmpty    = state.WLVL_PRESSED[pumpIdx];
    bool isMachinePaused = state.state_pause;

    if (state.armedQty[pumpIdx] > 0 && (!atleast2PumpOn || pumpAlreadyOn) &&
        !isSlotEmpty && !isMachinePaused) {

        state.armedQty[pumpIdx]--;
        state.slotBusy[pumpIdx] = true;
        state.phase = TxnPhase::DISPENSING;
        pump.armedUnitsReserved++;
        pump.amount += product.coins;

        int ms = (int)(product.durationSeconds * 1000);
        std::chrono::milliseconds extension(ms);
        if (current_time >= pump.timer)
            pump.timer = current_time + extension;
        else
            pump.timer += extension;

        pump.postPressDeadline = current_time + extension + std::chrono::seconds(30);
        g_last_pump_start = current_time;
        digitalWrite(pump_pin, PUMP_TRIGGER_HIGH);
        saveStateToDisk(state, state.transactionDir);

        log_info("pump", "Slot " + std::to_string(pumpIdx) + ": ACCEPTED"
                  "  armedQty=" + std::to_string(state.armedQty[pumpIdx])
                  + "  reserved=" + std::to_string(pump.armedUnitsReserved)
                  + "  run_ms=" + std::to_string(ms));
    } else {
        std::string reason = isMachinePaused ? "paused" :
                             isSlotEmpty     ? "empty" :
                             (atleast2PumpOn && !pumpAlreadyOn) ? "max_active" :
                             "no_credit";
        log_info("pump", "Slot " + std::to_string(pumpIdx) + ": DENIED  reason=" + reason
                  + "  armedQty=" + std::to_string(state.armedQty[pumpIdx]));
    }
}

// ------------------------------------------------------------------------------
// Per-pump state machine
// ------------------------------------------------------------------------------
static void handlePump(PumpState &pump, AppState &state) {
    if (state.WLVL_PRESSED[pump.id]) {
        if (pump.isPumping)
            log_info("pump", "Pump " + std::to_string(pump.id) + ": STOPPED  reason=empty");
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
            log_info("pump", "Pump " + std::to_string(pump.id) + ": DONE  amount="
                      + std::to_string(pump.amount));
            if (pump.armedUnitsReserved > 0) pump.armedUnitsReserved--;
            processSaving(state, pump.id, pump.amount, "");
            pump.amount = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};
            state.slotBusy[pump.id] = false;

            if (!state.pendingQueue[pump.id].empty()) {
                PendingArm next = state.pendingQueue[pump.id].front();
                state.pendingQueue[pump.id].pop();
                state.armedQty[pump.id] += next.qty;
                log_info("pump", "Slot " + std::to_string(pump.id)
                          + ": dequeued pending  qty=" + std::to_string(next.qty));
            }

            saveStateToDisk(state, state.transactionDir);

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
        pumps[i].id = i;
        pumps[i].timer = std::chrono::steady_clock::now();
        pumps[i].buttonWasPressedLastFrame = false;
        pumps[i].processingTrigger = false;
    }

    std::string binDir = get_binary_dir();
    auto config = loadEnv(binDir + "/../CONFIG/config.env");

    if (config.count("machineId"))       state.machineId  = config["machineId"];
    if (config.count("vendorId"))        state.vendorId   = config["vendorId"];
    if (config.count("SOCKET_PORT"))     state.serverPort = std::stoi(config["SOCKET_PORT"]);
    else if (config.count("SERVER_PORT"))state.serverPort = std::stoi(config["SERVER_PORT"]);
    if (config.count("TRANSACTION_DIR")) state.transactionDir = config["TRANSACTION_DIR"];
    else state.transactionDir = binDir + "/../transaction";
    if (config.count("PUMP_START_COOLDOWN_MS")) g_pump_start_cooldown_ms = std::stoi(config["PUMP_START_COOLDOWN_MS"]);

    log_info("pump", "6-Slot Independent Logic v4.0");
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        log_info("pump", "Slot " + std::to_string(i)
            + ": BTN=" + std::to_string(pin_button[i])
            + " PUMP=" + std::to_string(pin_pump[i])
            + " LED=" + std::to_string(pin_led[i]));
    }
    init_hardware_config(config);
    wiringPiSetupGpio();

    // Buttons: INPUT + pull-down
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_button[i], INPUT);
        pullUpDnControl(pin_button[i], PUD_DOWN);
    }

    // Pumps: OUTPUT, off
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_pump[i], OUTPUT);
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
    }

    // LEDs: OUTPUT, off
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_led[i], OUTPUT);
        digitalWrite(pin_led[i], LOW);
    }

    if (ensureDirectoryExists(state.transactionDir)) {
        log_info("pump", "Transaction dir: " + state.transactionDir);
        if (loadStateFromDisk(state, state.transactionDir))
            log_info("pump", "Restored armed state from disk");
    }
}

void pump_loop(AppState &state) {
    std::lock_guard<std::mutex> lock(g_pump_mutex);
    auto current_time = std::chrono::steady_clock::now();

    // 1. Button scan — 8-sample rolling window (160ms debounce).
    //    Rail sag from LED writes causes transient HIGH reads lasting ~60ms
    //    (3 samples at 20ms/loop). 8-sample window is too wide for transients
    //    to fill, so false triggers are blocked without any capacitor needed.
    static int   sampleBuf[7][8] = {{0}};
    static int   sampleIdx[7]   = {0};

    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        int raw = (digitalRead(pin_button[i]) == HIGH) ? 1 : 0;
        sampleBuf[i][sampleIdx[i]] = raw;
        sampleIdx[i] = (sampleIdx[i] + 1) % 8;

        int sum = 0;
        for (int s = 0; s < 8; s++) sum += sampleBuf[i][s];
        bool pressed = (sum == 8);

        if (pressed) {
            if (!pumps[i].buttonWasPressedLastFrame) {
                pumps[i].buttonWasPressedLastFrame = true;
                pumps[i].pressStartTime = current_time;
                pumps[i].processingTrigger = true;
                // Already pumping → instant re-press
                if (pumps[i].isPumping) {
                    pumps[i].processingTrigger = false;
                    executeDispenseTrigger(i);
                }
            } else if (pumps[i].processingTrigger) {
                auto held = std::chrono::duration_cast<std::chrono::milliseconds>(
                    current_time - pumps[i].pressStartTime).count();
                if (held >= 50) {  // 50ms hold + 160ms filter = ~0.2s total
                    pumps[i].processingTrigger = false;
                    executeDispenseTrigger(i);
                }
            }
        } else {
            pumps[i].buttonWasPressedLastFrame = false;
            pumps[i].processingTrigger = false;
        }
    }

    // 2. LED outputs — staggered 20ms apart to avoid 3.3V rail sag.
    //    Also add 100µF capacitor across Pi pins 1 (3.3V) and 6 (GND).
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > 0) {
            digitalWrite(pin_led[i], HIGH);
            delayMicroseconds(5000);  // 5ms gap — 8-sample filter handles any residual sag
        } else {
            digitalWrite(pin_led[i], LOW);
        }
    }
    delayMicroseconds(3000);  // 3ms rail settle after LED writes
    // 3. Remaining times
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(
            pumps[i].timer - current_time).count();
        state.remaining_time[i] = std::max(0LL, (long long)diff);
    }

    // 4. Pump state machines
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        handlePump(pumps[i], state);

    // 5. Jam timeout detection
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (pumps[i].armedUnitsReserved > 0 &&
            pumps[i].postPressDeadline.time_since_epoch().count() > 0 &&
            current_time > pumps[i].postPressDeadline) {
            state.armedQty[i] += pumps[i].armedUnitsReserved;
            log_error("pump", "Slot " + std::to_string(i) + ": JAM TIMEOUT  refunded "
                      + std::to_string(pumps[i].armedUnitsReserved));
            pumps[i].armedUnitsReserved = 0;
            pumps[i].postPressDeadline = std::chrono::steady_clock::time_point{};
            pumps[i].amount = 0;
            state.slotBusy[i] = false;
            digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
            saveStateToDisk(state, state.transactionDir);
        }
    }

    // 6. Software pause toggle — no physical stop button.
    //    state.state_pause can be set via socket command or dashboard.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
}

void pump_shutdown() {
    if (g_state_ptr) {
        std::string stateFile = g_state_ptr->transactionDir + "/state.dat";
        std::remove(stateFile.c_str());
    }
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
        digitalWrite(pin_led[i], LOW);
    }
}
