#ifndef APP_STATE_H
#define APP_STATE_H

#include <string>
#include <queue>

struct PendingArm {
    int productId;
    int qty;
    PendingArm(int id = 0, int q = 0) : productId(id), qty(q) {}
};

// Transaction-level state machine (non-blocking, millis()-driven)
enum class TxnPhase {
    IDLE,        // no transaction active, all LEDs off
    ARMED,       // one or more slots armed, LEDs lit, buttons live
    DISPENSING,  // at least one slot currently pumping
    COMPLETE     // all armed slots finished — bundle complete, trigger 7th indicator
};

struct AppState {
    // Per-slot armed quantity (indices 1-4)
    volatile int armedQty[7] = {0};

    // Per-slot busy flag — true while a slot is mid-dispense
    bool slotBusy[7] = {false};

    // Per-slot pending queue — ARM requests waiting while slot is busy
    std::queue<PendingArm> pendingQueue[7];

    // Transaction-level phase
    TxnPhase phase = TxnPhase::IDLE;

    // Bundle complete: true when all armed slots reached 0 after a batch ARM
    bool bundleComplete = false;

    std::string machineId = "1";
    std::string vendorId;

    // Configurable at runtime from config.env
    int serverPort = 8080;
    std::string transactionDir = "../transaction";

    long long remaining_time[7] = {0};  // index 1-6
    bool WLVL_PRESSED[7] = {false};     // index 1-6
    bool state_pause = false;

    // Returns true if any slot is armed (armedQty > 0 or busy)
    bool anyArmed() const {
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (armedQty[i] > 0 || slotBusy[i]) return true;
        return false;
    }

    // Returns true if any slot is currently pumping
    bool anyDispensing() const {
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (slotBusy[i]) return true;
        return false;
    }

    // Returns number of slots with armedQty > 0 (not yet dispensed)
    int armedCount() const {
        int c = 0;
        for (int i = 1; i <= TOTAL_SLOTS; i++)
            if (armedQty[i] > 0) c++;
        return c;
    }
};

#endif // APP_STATE_H
