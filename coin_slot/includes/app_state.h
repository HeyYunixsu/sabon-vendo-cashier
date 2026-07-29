#ifndef APP_STATE_H
#define APP_STATE_H

#include <string>
#include <queue>

struct PendingArm {
    int productId;
    int qty;
    PendingArm(int id = 0, int q = 0) : productId(id), qty(q) {}
};

struct AppState {
    // Per-slot armed quantity (indices 1-6; 1-4 active, 5-6 reserved for future)
    volatile int armedQty[7] = {0};

    // Per-slot busy flag — true while a slot is mid-dispense
    bool slotBusy[7] = {false};

    // Per-slot pending queue — ARM requests waiting while slot is busy
    std::queue<PendingArm> pendingQueue[7];

    std::string machineId = "1";
    std::string vendorId;

    // Configurable at runtime from config.env
    int serverPort = 8080;
    std::string transactionDir = "../transaction";

    long long remaining_time[7] = {0};  // index 1-6, milliseconds, always >= 0
    bool WLVL_PRESSED[7] = {false};     // index 1-6
    bool state_pause = false;
};

#endif // APP_STATE_H
