#include "test_framework.h"
#include "app_state.h"
#include <string>

// Phase 3 replaced all extern globals (coinCredit, machineId, vendorId,
// remaining_time_01..04, WLVL1..4_PRESSED, state_pause) with a single
// AppState struct passed by reference.  These tests pin down the struct's
// initial defaults and verify that every field can be read and written
// independently — proving no aliasing or padding surprises.

// ------------------------------------------- default values ---

void test_appstate_coinCredit_default_zero()
{
    AppState s;
    CHECK_EQ(s.coinCredit, 0);
}

void test_appstate_machineId_default_is_1()
{
    AppState s;
    CHECK_EQ(s.machineId, std::string("1"));
}

void test_appstate_vendorId_default_empty()
{
    AppState s;
    CHECK_EQ(s.vendorId, std::string(""));
}

void test_appstate_remaining_time_all_zero()
{
    AppState s;
    for (int i = 1; i <= 4; i++)
        CHECK_EQ(s.remaining_time[i], 0LL);
}

void test_appstate_WLVL_PRESSED_all_false()
{
    AppState s;
    for (int i = 1; i <= 4; i++)
        CHECK(!s.WLVL_PRESSED[i]);
}

void test_appstate_state_pause_default_false()
{
    AppState s;
    CHECK(!s.state_pause);
}

// -------------------------------------- independent mutation ---

void test_appstate_coinCredit_add_subtract()
{
    AppState s;
    s.coinCredit += 10;
    CHECK_EQ(s.coinCredit, 10);
    s.coinCredit -= 5;
    CHECK_EQ(s.coinCredit, 5);
}

void test_appstate_machineId_and_vendorId_set()
{
    AppState s;
    s.machineId = "machine_99";
    s.vendorId  = "vendor_ABC";
    CHECK_EQ(s.machineId, std::string("machine_99"));
    CHECK_EQ(s.vendorId,  std::string("vendor_ABC"));
}

void test_appstate_remaining_time_per_pump_independent()
{
    AppState s;
    s.remaining_time[1] = 5000;
    s.remaining_time[4] = 3000;
    // Only the written slots should change
    CHECK_EQ(s.remaining_time[1], 5000LL);
    CHECK_EQ(s.remaining_time[2], 0LL);
    CHECK_EQ(s.remaining_time[3], 0LL);
    CHECK_EQ(s.remaining_time[4], 3000LL);
}

void test_appstate_WLVL_PRESSED_per_pump_independent()
{
    AppState s;
    s.WLVL_PRESSED[2] = true;
    s.WLVL_PRESSED[3] = true;
    CHECK(!s.WLVL_PRESSED[1]);
    CHECK( s.WLVL_PRESSED[2]);
    CHECK( s.WLVL_PRESSED[3]);
    CHECK(!s.WLVL_PRESSED[4]);
}

void test_appstate_state_pause_toggle()
{
    AppState s;
    s.state_pause = true;
    CHECK(s.state_pause);
    s.state_pause = false;
    CHECK(!s.state_pause);
}

// ------------------- two AppState instances are independent ---

void test_appstate_two_instances_do_not_share_state()
{
    AppState a, b;
    a.coinCredit = 50;
    b.coinCredit = 0;
    CHECK_EQ(a.coinCredit, 50);
    CHECK_EQ(b.coinCredit, 0);

    b.state_pause = true;
    CHECK(!a.state_pause);
}

// ---------------------------------------------------------- entry point ---

void run_phase3_tests()
{
    SUITE("phase3 (AppState)");
    RUN_TEST(test_appstate_coinCredit_default_zero);
    RUN_TEST(test_appstate_machineId_default_is_1);
    RUN_TEST(test_appstate_vendorId_default_empty);
    RUN_TEST(test_appstate_remaining_time_all_zero);
    RUN_TEST(test_appstate_WLVL_PRESSED_all_false);
    RUN_TEST(test_appstate_state_pause_default_false);
    RUN_TEST(test_appstate_coinCredit_add_subtract);
    RUN_TEST(test_appstate_machineId_and_vendorId_set);
    RUN_TEST(test_appstate_remaining_time_per_pump_independent);
    RUN_TEST(test_appstate_WLVL_PRESSED_per_pump_independent);
    RUN_TEST(test_appstate_state_pause_toggle);
    RUN_TEST(test_appstate_two_instances_do_not_share_state);
}
