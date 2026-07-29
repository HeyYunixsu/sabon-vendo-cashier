#include "pump_control.h"
#include "hardware_config.h"
#include "transaction.h"
#include "voucher_manager.h"
#include "utils.h"
#include <wiringPi.h>
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
};

static std::mutex     g_pump_mutex;
static PumpState      pumps[5];          // index 1-4
static AppState      *g_state_ptr = nullptr;
static int            g_pump_start_cooldown_ms = 200;
static std::chrono::time_point<std::chrono::steady_clock> g_last_pump_start = std::chrono::steady_clock::now() - std::chrono::seconds(1);

static bool           STOP_PRESSED      = false;
static bool           STOP_BTN_PREVIOUS = false;

// Map pump index to physical button pins safely
static const int BUTTON_PINS[5] = {0, BTN1, BTN2, BTN3, BTN4};

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
    for (int i = 1; i <= 4; i++) {
        if (pumps[i].timer > current_time) activePumps++;
    }

    bool atleast2PumpOn = (activePumps >= 2);
    bool pumpAlreadyOn  = (pump.timer > current_time);
    bool isSlotEmpty = state.WLVL_PRESSED[pumpIdx];

    // CRITICAL FIX: Track if the machine is actively paused
    bool isMachinePaused = state.state_pause;

    log_info("pump", "Button " + std::to_string(pumpIdx) + ": TRIGGERED"
              "  credit=" + std::to_string(state.coinCredit) +
              "  required=" + std::to_string(product.coins) +
              "  paused=" + std::to_string(isMachinePaused));

    // PROTECTION ENFORCED: Added !isMachinePaused to completely freeze credit consumption while paused
    if ((state.coinCredit >= product.coins) && (!atleast2PumpOn || pumpAlreadyOn) && !isSlotEmpty && !isMachinePaused) {
        state.coinCredit -= product.coins;
        pump.amount += product.coins;
        int ms = (int)(product.durationSeconds * 1000);
        std::chrono::milliseconds extension(ms);

        if (current_time >= pump.timer)
            pump.timer = current_time + extension;
        else
            pump.timer += extension;

        g_last_pump_start = current_time;
        log_info("pump", "Button " + std::to_string(pumpIdx) + ": ACCEPTED"
                  "  credit_now=" + std::to_string(state.coinCredit) + "  added=" + std::to_string(ms) + "ms");
        digitalWrite(pump_pin, PUMP_TRIGGER_HIGH);
    } else {
        if (isMachinePaused)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=machine_is_paused (Credit Preserved!)");
        else if (isSlotEmpty)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=slot_empty");
        else if (atleast2PumpOn && !pumpAlreadyOn)
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=max_pumps_active");
        else
            log_info("pump", "Button " + std::to_string(pumpIdx) + ": DENIED  reason=insufficient_credit"
                      "  credit=" + std::to_string(state.coinCredit) + "  required=" + std::to_string(product.coins));
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
            double totalRemaining = pump.amount;
            int postfix = 1;

            while (totalRemaining > 0 && getTotalVoucherAmount(state.voucherQueue) > 0) {
                unusedVoucher v = dequeueVoucher(state.voucherQueue);
                totalRemaining -= v.amount;
                processSaving(state, pump.id, v.amount, v.voucherId, postfix++);
            }

            if (totalRemaining > 0)
                processSaving(state, pump.id, totalRemaining, "");

            pump.amount    = 0;
            pump.isPumping = false;
        }
    }
}

// ------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------
void pump_setup(AppState &state) {
    g_state_ptr = &state;
    for (int i = 1; i <= 4; i++) {
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

    if (config.count("MAX_COIN_CREDIT")) state.maxCoinCredit  = std::stoi(config["MAX_COIN_CREDIT"]);
    if (config.count("PUMP_START_COOLDOWN_MS")) g_pump_start_cooldown_ms = std::stoi(config["PUMP_START_COOLDOWN_MS"]);

    log_info("pump", "Fully Integrated Logic Version 3.0 Live!");
    log_info("pump", "Anti-Surge Setup: 200ms cold hold enforced. Live sessions open for continuous fast-tapping.");

    init_hardware_config(config);
    wiringPiSetupGpio();

    // Configure input buttons safely using internal pull-downs to swallow data-line float
    pinMode(BTN1, INPUT); pullUpDnControl(BTN1, PUD_DOWN);
    pinMode(BTN2, INPUT); pullUpDnControl(BTN2, PUD_DOWN);
    pinMode(BTN3, INPUT); pullUpDnControl(BTN3, PUD_DOWN);
    pinMode(BTN4, INPUT); pullUpDnControl(BTN4, PUD_DOWN);

    for (int i = 1; i <= 4; ++i) {
        pinMode(pin_pump[i], OUTPUT);
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
    }

    pinMode(PIN_STOP, INPUT); pullUpDnControl(PIN_STOP, PUD_DOWN);

    if (ensureDirectoryExists(state.transactionDir))
        log_info("pump", "Transaction dir ready: " + state.transactionDir);
}

void pump_loop(AppState &state) {
    std::lock_guard<std::mutex> lock(g_pump_mutex);
    auto current_time = std::chrono::steady_clock::now();

    // 1. Process Selection Buttons (Hybrid Surge + Hold Logic)
    for (int i = 1; i <= 4; i++) {
        bool isCurrentlyPressed = (digitalRead(BUTTON_PINS[i]) == HIGH);

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

    // 2. Update remaining times safely
    for (int i = 1; i <= 4; i++) {
        auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(pumps[i].timer - current_time).count();
        state.remaining_time[i] = std::max(0LL, (long long)diff);
    }

    // 3. Process Pause/Stop Operations
    STOP_BTN_PREVIOUS = STOP_PRESSED;
    STOP_PRESSED      = digitalRead(PIN_STOP) == HIGH;
    bool isPressPause = (STOP_PRESSED && STOP_PRESSED != STOP_BTN_PREVIOUS);

    if (isPressPause) pauseButtonClicked();

    if (state.state_pause && isPressPause) {
        for (int i = 1; i <= 4; i++) {
            pumps[i].remainingTimeWhenPaused = state.remaining_time[i];
            pumps[i].isPaused = true;
        }
    }

    if (state.state_pause) {
        for (int i = 1; i <= 4; i++)
            pumps[i].timer = current_time + std::chrono::milliseconds(pumps[i].remainingTimeWhenPaused);
    } else if (isPressPause) {
        for (int i = 1; i <= 4; i++) {
            pumps[i].isPaused = false;
            pumps[i].remainingTimeWhenPaused = 0;
        }
    }

    // 4. Tick pump outputs
    for (int i = 1; i <= 4; i++)
        handlePump(pumps[i], state);

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
}
void pump_shutdown() {
    for (int i = 1; i <= 4; i++)
        digitalWrite(pin_pump[i], PUMP_TRIGGER_LOW);
}