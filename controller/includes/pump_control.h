#ifndef PUMP_CONTROL_H
#define PUMP_CONTROL_H

#include "app_state.h"

// Parses ARM_TIMEOUT_SECONDS and clamps it to 30..1800. Returns 300 for
// anything unparseable. Exposed so the clamp can be tested without a
// config.env on disk.
int clamp_arm_timeout(const std::string &raw);

// Initialise GPIO, ISRs, load config.env into state, create transaction dir.
void pump_setup(AppState &state);

// One iteration of the pump state machine — call every loop tick.
void pump_loop(AppState &state);

// Turn all pumps OFF (call before exit).
void pump_shutdown();

// ---------------------------------------------------------------------------
// Prime / purge
//
// Replacing an empty gallon lets air into the hose, so the next customer press
// dispenses air and still charges them. Priming runs one pump for a short
// fixed burst to push that air through.
//
// A prime moves product and records NO sale, which is exactly what a
// dishonest cashier would want, so every prime is appended to a non-revenue
// log instead of vanishing. See docs/superpowers/plans/ Task 6.
// ---------------------------------------------------------------------------
enum class PrimeResult {
    STARTED,
    SLOT_INVALID,
    SLOT_BUSY,        // armed, mid-dispense, or has queued credits
    SLOT_EMPTY,
    MACHINE_PAUSED,
    TOO_MANY_ACTIVE   // two pumps already running — same rail limit as dispensing
};

// Start a prime burst on `slot`. Never writes a transaction.
PrimeResult pump_start_prime(AppState &state, int slot);

// Short machine-readable token for a result, for logs and the PRIME_ACK line.
const char *prime_result_text(PrimeResult r);

// Burst length in seconds, as configured by PRIME_SECONDS.
double pump_prime_seconds();

// ---------------------------------------------------------------------------
// Prices
//
// Set per client from the dashboard rather than compiled in. A change alters
// what every future sale is worth, so each one is written to an append-only
// audit log and persisted immediately.
// ---------------------------------------------------------------------------
enum class PriceResult {
    OK,
    SLOT_INVALID,
    PRICE_INVALID,
    SALE_IN_PROGRESS,   // credits are armed; the price a customer paid is owed
    NOT_SAVED           // applied in memory but the file write failed
};

PriceResult pump_set_price(AppState &state, int slot, int pesos);
const char *price_result_text(PriceResult r);
int pump_get_price(int slot);

// Records credits that were paid for but never dispensed. reason is "timeout"
// or "cancelled". Called from the socket server as well as the pump loop.
void pump_record_unclaimed(AppState &state, int slot, int qty, const std::string &reason);

// Return every pump to its power-on state. pump_setup() calls this; tests call
// it to get a clean slate, because pump state lives in module statics that
// would otherwise leak between cases.
void pump_reset_state();

#endif // PUMP_CONTROL_H
