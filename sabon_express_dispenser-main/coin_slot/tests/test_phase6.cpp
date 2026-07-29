#include "test_framework.h"
#include "utils.h"
#include "hardware_config.h"
#include "voucher_manager.h"
#include "socket_server.h"
#include "transaction.h"
#include "app_state.h"
#include <filesystem>
#include <vector>

namespace fs = std::filesystem;

// Phase 6 — Build System Polish
//
// All Phase 6 changes are in the build system, not in C++ logic, so there is
// nothing to unit-test directly.  This suite instead acts as a regression
// guard: if a module was accidentally dropped from TEST_MODULE_OBJS, or if
// -Wextra caused a compile error that blocked the build, this binary simply
// won't exist — and the suite won't run.
//
// The tests below confirm:
//   1. The binary is running from the expected working directory (coin_slot/)
//   2. The test fixture created for Phase 6 is present
//   3. Every compiled module exposes at least one callable symbol

// ------------------------------------------ working directory layout ---

void test_cwd_has_src_directory()
{
    CHECK(fs::exists("src"));
}

void test_cwd_has_includes_directory()
{
    CHECK(fs::exists("includes"));
}

void test_cwd_has_tests_directory()
{
    CHECK(fs::exists("tests"));
}

void test_fixture_file_exists()
{
    CHECK(fs::exists("tests/fixtures/test.env"));
}

// ------------------------------------------ module linkage sentinels ---
// Each test calls one function from each compiled module.
// A missing module produces a link error, not a runtime failure.

void test_utils_module_links()
{
    CHECK_EQ(trim("  hi  "), std::string("hi"));
}

void test_hardware_module_links()
{
    CHECK_EQ((int)pin_pump.size(), 4);
}

void test_voucher_module_links()
{
    std::vector<unusedVoucher> q;
    CHECK_EQ(getTotalVoucherAmount(q), 0);
}

void test_socket_module_links()
{
    CHECK(isFirstWordTest("COIN,5", "COIN"));
}

void test_transaction_module_links()
{
    // saveClassToJsonFileGeneric is in transaction.cpp.
    // Write to a bad path just to exercise the symbol — expect false.
    Transaction t;
    t.machine_id = "smoke"; t.vendorId = ""; t.voucherId = "";
    t.amount = 0; t.slot = "1"; t.dateCreated = "2024-01-01 00:00:00";
    CHECK(!saveClassToJsonFileGeneric(t, "/no_such_dir/smoke.json"));
}

// ---------------------------------------------------------- entry point ---

void run_phase6_tests()
{
    SUITE("phase6 (build polish)");
    RUN_TEST(test_cwd_has_src_directory);
    RUN_TEST(test_cwd_has_includes_directory);
    RUN_TEST(test_cwd_has_tests_directory);
    RUN_TEST(test_fixture_file_exists);
    RUN_TEST(test_utils_module_links);
    RUN_TEST(test_hardware_module_links);
    RUN_TEST(test_voucher_module_links);
    RUN_TEST(test_socket_module_links);
    RUN_TEST(test_transaction_module_links);
}
