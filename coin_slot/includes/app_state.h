#ifndef APP_STATE_H
#define APP_STATE_H

#include <string>
#include <vector>
#include "voucher_manager.h"  // for unusedVoucher

struct AppState {
    volatile int coinCredit = 0;
    std::string machineId = "1";
    std::string vendorId;

    // Configurable at runtime from config.env
    int serverPort = 8080;
    std::string transactionDir = "../transaction";
    int maxCoinCredit = 1000;  // cap on coinCredit; overridable from config.env

    // Voucher queue (moved here from global in Phase 9)
    std::vector<unusedVoucher> voucherQueue;

    long long remaining_time[5] = {0};  // index 1-4, milliseconds, always >= 0
    bool WLVL_PRESSED[5] = {false};     // index 1-4
    bool state_pause = false;
};

#endif // APP_STATE_H
