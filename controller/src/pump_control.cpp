// =============================================================================
// pump_control.cpp — 6-slot independent button+LED dispense state machine
//
// All pins fully independent — no shared/multiplexed pins.
// Buttons: INPUT only (active-low, button wired GPIO->GND) — pull-up set at boot via config.txt.
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
#include <sstream>
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
    std::chrono::time_point<std::chrono::steady_clock> armTimestamp{};  // when last armed
    bool firstPressAfterArm = false;  // true = next press needs 100ms hold
    // True while this pump is running a maintenance prime rather than a sale.
    // The completion branch checks it and skips writeTransaction() entirely --
    // not even a zero-peso record, which would still reach the cloud and
    // pollute the revenue report we are trying to keep honest.
    bool isPriming = false;
};

static PumpState      pumps[TOTAL_SLOTS + 1];   // index 1..TOTAL_SLOTS
static AppState      *g_state_ptr = nullptr;
static int            g_pump_start_cooldown_ms = 200;
static double         g_prime_seconds = 3.0;
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
    bool isSlotEmpty    = state.slotEmpty[pumpIdx];
    bool isMachinePaused = state.paused;

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
        // Reset timeout for all armed slots — any press extends the session
        for (int j = 1; j <= TOTAL_SLOTS; j++) {
            if (state.armedQty[j] > 0) pumps[j].armTimestamp = current_time;
        }
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

// A slot that stops being busy must take its next queued ARM with it.
// ARM queues rather than arms while slotBusy is set, so any path that clears
// the flag without draining the queue strands credits a cashier already took
// money for. Returns true if armedQty changed and needs persisting.
static bool releaseSlot(AppState &state, int id)
{
    state.slotBusy[id] = false;
    if (state.pendingQueue[id].empty()) return false;

    PendingArm next = state.pendingQueue[id].front();
    state.pendingQueue[id].pop();
    state.armedQty[id] += next.qty;
    log_info("pump", "Slot " + std::to_string(id)
              + ": dequeued pending  qty=" + std::to_string(next.qty));
    return true;
}

// ------------------------------------------------------------------------------
// Per-pump state machine
// ------------------------------------------------------------------------------
static void handlePump(PumpState &pump, AppState &state) {
    if (state.slotEmpty[pump.id]) {
        if (pump.isPriming) {
            // The sensor read empty mid-prime. Release the slot: priming sets
            // slotBusy, and leaving it set would lock the line out of service
            // until the controller restarts.
            log_info("pump", "Pump " + std::to_string(pump.id) + ": PRIME ABORTED  reason=empty");
            pump.isPriming = false;
            pump.isPumping = false;
            pump.timer = std::chrono::steady_clock::now();
            if (releaseSlot(state, pump.id))
                saveStateToDisk(state, state.transactionDir);
        } else if (pump.isPumping) {
            log_info("pump", "Pump " + std::to_string(pump.id) + ": STOPPED  reason=empty");
        }
        digitalWrite(pin_pump[pump.id], PUMP_TRIGGER_LOW);
    } else if (state.remainingTime[pump.id] > 0) {
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
        if (pump.isPriming) {
            // Checked before isPumping: both are true during a prime, and a
            // prime must never fall through to the sale-recording branch.
            log_info("pump", "Pump " + std::to_string(pump.id) + ": PRIME DONE  (no sale recorded)");
            pump.isPriming = false;
            pump.isPumping = false;
            pump.amount = 0;
            if (releaseSlot(state, pump.id))
                saveStateToDisk(state, state.transactionDir);
        } else if (pump.isPumping) {
            log_info("pump", "Pump " + std::to_string(pump.id) + ": DONE  amount="
                      + std::to_string(pump.amount));
            if (pump.armedUnitsReserved > 0) pump.armedUnitsReserved--;
            writeTransaction(state, pump.id, pump.amount, "");
            pump.amount = 0;
            pump.isPumping = false;
            pump.postPressDeadline = std::chrono::steady_clock::time_point{};
            releaseSlot(state, pump.id);

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
void pump_reset_state() {
    auto now = std::chrono::steady_clock::now();
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pumps[i] = PumpState{};
        pumps[i].id = i;
        pumps[i].timer = now;
    }
}

void pump_setup(AppState &state) {
    g_state_ptr = &state;
    pump_reset_state();

    std::string binDir = get_binary_dir();
    auto config = loadEnv(binDir + "/../CONFIG/config.env");

    if (config.count("machineId"))       state.machineId  = config["machineId"];
    if (config.count("vendorId"))        state.vendorId   = config["vendorId"];
    if (config.count("SOCKET_PORT"))     state.serverPort = std::stoi(config["SOCKET_PORT"]);
    else if (config.count("SERVER_PORT"))state.serverPort = std::stoi(config["SERVER_PORT"]);
    if (config.count("TRANSACTION_DIR")) state.transactionDir = config["TRANSACTION_DIR"];
    else state.transactionDir = binDir + "/../transaction";
    if (config.count("PUMP_START_COOLDOWN_MS")) g_pump_start_cooldown_ms = std::stoi(config["PUMP_START_COOLDOWN_MS"]);
    if (config.count("PRIME_SECONDS")) {
        double v = std::stod(config["PRIME_SECONDS"]);
        // Clamped rather than trusted. A typo here runs a pump unattended:
        // too short is useless, too long empties a gallon onto the floor.
        if (v < 0.5)  { log_error("pump", "PRIME_SECONDS below 0.5 - using 0.5"); v = 0.5; }
        if (v > 15.0) { log_error("pump", "PRIME_SECONDS above 15 - using 15");  v = 15.0; }
        g_prime_seconds = v;
    }

    // Prime events live outside transactionDir on purpose: the uploader sends
    // every file in that directory to the cloud as a sale.
    if (config.count("PRIME_LOG")) state.primeLogPath = config["PRIME_LOG"];
    else state.primeLogPath = binDir + "/../logs/prime_events.jsonl";

    if (config.count("PRICES_FILE")) state.pricesPath = config["PRICES_FILE"];
    else state.pricesPath = binDir + "/../CONFIG/prices.conf";

    if (config.count("PRICE_LOG")) state.priceLogPath = config["PRICE_LOG"];
    else state.priceLogPath = binDir + "/../logs/price_changes.jsonl";

    // Apply config.env pin/calibration overrides BEFORE logging the map,
    // otherwise the startup log reports compiled-in defaults, not real pins.
    init_hardware_config(config);

    // Saved prices last: an edit made on the dashboard must outrank whatever
    // config.env shipped with, or a restart would quietly undo it.
    load_prices_file(state.pricesPath);

    log_info("pump", "6-Slot Independent Logic v4.0");
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        log_info("pump", "Slot " + std::to_string(i)
            + ": BTN=" + std::to_string(pin_button[i])
            + " PUMP=" + std::to_string(pin_pump[i])
            + " LED=" + std::to_string(pin_led[i])
            + " RUN_MS=" + std::to_string((int)(productMap[i].durationSeconds * 1000))
            + " PRICE=" + std::to_string(productMap[i].coins));
    }
    log_info("pump", std::string("Water sensor: empty reads ")
        + (WATER_SENSOR_EMPTY_HIGH ? "HIGH" : "LOW")
        + " (WATER_SENSOR_EMPTY_HIGH=" + std::to_string(WATER_SENSOR_EMPTY_HIGH) + ")");
    wiringPiSetupGpio();

    // Buttons: INPUT only — active-low (button wired GPIO -> GND).
    // Pull-up is configured at boot in /boot/firmware/config.txt (gpio=X=ip,pu),
    // NOT via wiringPi, because wiringPi's pull-up control is unreliable on Debian.
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        pinMode(pin_button[i], INPUT);
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

    if (!state.primeLogPath.empty()) {
        std::string parent = fs::path(state.primeLogPath).parent_path().string();
        if (!parent.empty()) ensureDirectoryExists(parent);
    }
    log_info("pump", "Prime burst: " + std::to_string(g_prime_seconds)
             + "s  log=" + state.primeLogPath);

    if (ensureDirectoryExists(state.transactionDir)) {
        log_info("pump", "Transaction dir: " + state.transactionDir);
        if (loadStateFromDisk(state, state.transactionDir))
            log_info("pump", "Restored armed state from disk");
    }
}

void pump_loop(AppState &state) {
    // No lock needed: main() calls pump_loop() and server_app_loop()
    // sequentially on one thread, and buttons are polled rather than driven by
    // a wiringPi ISR, so nothing here runs concurrently.
    auto current_time = std::chrono::steady_clock::now();

    // 1. Button scan — 4-sample rolling window (80ms debounce).
    //    GPIO conflict (BTN2/LED5 both on GPIO24) was the root cause of
    //    false triggers, not rail sag. Conflict fixed (LED5 → GPIO26).
    //    4 samples is sufficient with 5ms LED stagger.
    static int   sampleBuf[TOTAL_SLOTS + 1][4] = {{0}};
    static int   sampleIdx[TOTAL_SLOTS + 1]   = {0};

    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        int raw = (digitalRead(pin_button[i]) == LOW) ? 1 : 0;
        sampleBuf[i][sampleIdx[i]] = raw;
        sampleIdx[i] = (sampleIdx[i] + 1) % 4;

        int sum = 0;
        for (int s = 0; s < 4; s++) sum += sampleBuf[i][s];
        bool pressed = (sum == 4);

        if (pressed) {
            if (!pumps[i].buttonWasPressedLastFrame) {
                pumps[i].buttonWasPressedLastFrame = true;
                pumps[i].pressStartTime = current_time;
                pumps[i].processingTrigger = true;
                // Already pumping → instant re-press
                if (pumps[i].isPumping || pumps[i].processingTrigger) {
                    pumps[i].processingTrigger = false;
                    pumps[i].firstPressAfterArm = false;
                    executeDispenseTrigger(i);
                }
            }
        } else {
            pumps[i].buttonWasPressedLastFrame = false;
            pumps[i].processingTrigger = false;
        }
    }

    // 1b. Track ARM timestamps + first-press flag
    static int prevArmedQty[TOTAL_SLOTS + 1] = {0};
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > prevArmedQty[i]) {
            pumps[i].armTimestamp = current_time;
            pumps[i].firstPressAfterArm = true;
        }
        prevArmedQty[i] = state.armedQty[i];
    }

    // 1c. 2-minute timeout — clear expired armed slots
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > 0 && !state.slotBusy[i]) {
            auto armedFor = std::chrono::duration_cast<std::chrono::seconds>(
                current_time - pumps[i].armTimestamp).count();
            if (armedFor >= 120) {
                log_info("pump", "Slot " + std::to_string(i) + ": TIMEOUT  refunded "
                          + std::to_string(state.armedQty[i]) + " credits");
                state.armedQty[i] = 0;
                while (!state.pendingQueue[i].empty()) state.pendingQueue[i].pop();
                saveStateToDisk(state, state.transactionDir);
            }
        }
    }

    // 2. LED outputs with blink (last 10s of 120s timeout = 1Hz blink)
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        if (state.armedQty[i] > 0 && !state.slotBusy[i]) {
            auto remaining = 120 - std::chrono::duration_cast<std::chrono::seconds>(
                current_time - pumps[i].armTimestamp).count();
            if (remaining <= 10 && remaining > 0) {
                // Blink every 500ms
                bool on = (std::chrono::duration_cast<std::chrono::milliseconds>(
                    current_time.time_since_epoch()).count() % 1000) < 500;
                digitalWrite(pin_led[i], on ? HIGH : LOW);
            } else {
                digitalWrite(pin_led[i], HIGH);
            }
            if (i > 1) delayMicroseconds(5000);  // stagger
        } else if (state.armedQty[i] > 0 && state.slotBusy[i]) {
            digitalWrite(pin_led[i], HIGH);  // busy = solid on
        } else if (pumps[i].isPriming) {
            digitalWrite(pin_led[i], HIGH);  // priming = solid on, so staff see which line runs
        } else {
            digitalWrite(pin_led[i], LOW);
        }
    }
    delayMicroseconds(3000);  // 3ms rail settle after LED writes
    // 3. Remaining times
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        auto diff = std::chrono::duration_cast<std::chrono::milliseconds>(
            pumps[i].timer - current_time).count();
        state.remainingTime[i] = std::max(0LL, (long long)diff);
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
    //    state.paused can be set via socket command or dashboard.
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
}

// ------------------------------------------------------------------------------
// Prime / purge
// ------------------------------------------------------------------------------

// Wrap a value in JSON quotes. These records are written from a handful of
// known fields, none of which contain quotes or backslashes.
static std::string q(const std::string &v) { return "\"" + v + "\""; }

// Append one non-revenue record. A prime dispenses product and books no sale,
// so if it left no trace "I was only priming" would be an unfalsifiable
// excuse and the honest-revenue number would stop being enforceable.
static void appendPrimeLog(AppState &state, int slot, double seconds)
{
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("seconds")    << ":" << seconds
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.primeLogPath, j.str());
}

const char *prime_result_text(PrimeResult r)
{
    switch (r) {
        case PrimeResult::STARTED:         return "started";
        case PrimeResult::SLOT_INVALID:    return "invalid_slot";
        case PrimeResult::SLOT_BUSY:       return "slot_busy";
        case PrimeResult::SLOT_EMPTY:      return "slot_empty";
        case PrimeResult::MACHINE_PAUSED:  return "paused";
        case PrimeResult::TOO_MANY_ACTIVE: return "max_active";
    }
    return "unknown";
}

double pump_prime_seconds() { return g_prime_seconds; }

// ------------------------------------------------------------------------------
// Prices
// ------------------------------------------------------------------------------

PriceResult pump_set_price(AppState &state, int slot, int pesos)
{
    if (slot < 1 || slot > TOTAL_SLOTS)  return PriceResult::SLOT_INVALID;
    if (pesos < 0 || pesos > MAX_PRICE)  return PriceResult::PRICE_INVALID;

    // A press books productMap[slot].coins at the moment the button is
    // pressed. Changing the price between arming and pressing would charge the
    // customer one figure and record another, so no sale may be in flight.
    if (state.anyArmed()) return PriceResult::SALE_IN_PROGRESS;

    const int previous = productMap[slot].coins;
    if (!set_product_price(slot, pesos)) return PriceResult::PRICE_INVALID;

    // Audit before persistence: if the write fails we still want the attempt
    // on record, and the operator warned rather than left thinking it saved.
    std::ostringstream j;
    j << "{" << q("machine_id") << ":" << q(state.machineId)
      << "," << q("slot")       << ":" << q(std::to_string(slot))
      << "," << q("from")       << ":" << previous
      << "," << q("to")         << ":" << pesos
      << "," << q("date_created") << ":" << q(format_current_time()) << "}";
    appendJsonLine(state.priceLogPath, j.str());

    log_info("pump", "Slot " + std::to_string(slot) + ": PRICE "
             + std::to_string(previous) + " -> " + std::to_string(pesos));

    if (!save_prices_file(state.pricesPath)) {
        log_error("pump", "Price applied but NOT saved -- it will revert on restart");
        return PriceResult::NOT_SAVED;
    }
    return PriceResult::OK;
}

const char *price_result_text(PriceResult r)
{
    switch (r) {
        case PriceResult::OK:               return "ok";
        case PriceResult::SLOT_INVALID:     return "invalid_slot";
        case PriceResult::PRICE_INVALID:    return "invalid_price";
        case PriceResult::SALE_IN_PROGRESS: return "sale_in_progress";
        case PriceResult::NOT_SAVED:        return "not_saved";
    }
    return "unknown";
}

int pump_get_price(int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return 0;
    return productMap[slot].coins;
}

PrimeResult pump_start_prime(AppState &state, int slot)
{
    if (slot < 1 || slot > TOTAL_SLOTS) return PrimeResult::SLOT_INVALID;
    if (state.paused)                   return PrimeResult::MACHINE_PAUSED;

    // Keep the empty-tank guard. Priming a genuinely dry tank runs the pump
    // against air, which is the thing that damages it. The real case is a
    // freshly refilled gallon, where the sensor already reads full.
    if (state.slotEmpty[slot]) return PrimeResult::SLOT_EMPTY;

    // Priming shares pump.timer with dispensing, so starting one mid-sale
    // would extend the customer's run and hand them extra product. A slot
    // that owes anyone anything is off limits -- prime between sales.
    if (state.armedQty[slot] > 0 || state.slotBusy[slot] ||
        !state.pendingQueue[slot].empty())
        return PrimeResult::SLOT_BUSY;

    auto now = std::chrono::steady_clock::now();
    int activePumps = 0;
    for (int i = 1; i <= TOTAL_SLOTS; i++)
        if (pumps[i].timer > now) activePumps++;
    if (activePumps >= 2) return PrimeResult::TOO_MANY_ACTIVE;

    PumpState &pump = pumps[slot];
    pump.isPriming = true;
    pump.amount    = 0;
    pump.timer     = now + std::chrono::milliseconds((int)(g_prime_seconds * 1000));

    // slotBusy keeps a sale from being armed into the middle of the burst.
    // handlePump clears it when the burst ends or aborts.
    state.slotBusy[slot] = true;
    g_last_pump_start    = now;

    appendPrimeLog(state, slot, g_prime_seconds);
    log_info("pump", "Slot " + std::to_string(slot) + ": PRIME START  run_ms="
             + std::to_string((int)(g_prime_seconds * 1000)));
    return PrimeResult::STARTED;
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
