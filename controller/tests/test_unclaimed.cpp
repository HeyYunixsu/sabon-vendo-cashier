#include "test_framework.h"
#include "pump_control.h"
#include "hardware_config.h"
#include "app_state.h"
#include <wiringPi.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

namespace fs = std::filesystem;

// Credits a customer paid for that never became product.
//
// The old code zeroed armedQty after 120 seconds and logged the word
// "refunded". Nothing was refunded. The credits vanished, and the only trace
// was a prose PM2 line that rotates out after seven days -- so a drawer that
// was 60 pesos heavy than the books had nothing to explain it, and the
// cashier carried the difference.

static const std::string TEST_DIR = "tests/tmp_unclaimed";
static const std::string TEST_TXN_DIR = TEST_DIR + "/transaction";

static AppState fresh_state()
{
    fs::remove_all(TEST_DIR);
    fs::create_directories(TEST_TXN_DIR);

    init_hardware_config({{"PRICE2", "20"}, {"PRICE4", "25"}});
    pump_reset_state();

    AppState s;
    s.machineId         = "23";
    s.transactionDir    = TEST_TXN_DIR;
    s.armTimeoutSeconds = 1;          // so a test need not wait five minutes
    return s;
}

static void test_timeout_value_is_clamped()
{
    CHECK_EQ(clamp_arm_timeout("300"), 300);
    CHECK_EQ(clamp_arm_timeout("600"), 600);

    // Too short is unusable at the counter; too long leaves a live button on
    // an unattended machine.
    CHECK_EQ(clamp_arm_timeout("5"), 30);
    CHECK_EQ(clamp_arm_timeout("99999"), 1800);

    // A typo in config.env must not take the machine down at boot.
    CHECK_EQ(clamp_arm_timeout("abc"), 300);
    CHECK_EQ(clamp_arm_timeout(""), 300);
}

static void test_credits_expire_at_the_configured_time()
{
    AppState s = fresh_state();
    s.armTimeoutSeconds = 1;
    s.armedQty[2] = 3;
    pump_loop(s);                     // stamps armTimestamp
    CHECK_EQ(s.armedQty[2], 3);       // not yet

    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    pump_loop(s);
    CHECK_EQ(s.armedQty[2], 0);
}

void run_unclaimed_tests()
{
    SUITE("Unclaimed credits");

    RUN_TEST(test_timeout_value_is_clamped);
    RUN_TEST(test_credits_expire_at_the_configured_time);

    fs::remove_all(TEST_DIR);
    init_hardware_config({});
}
