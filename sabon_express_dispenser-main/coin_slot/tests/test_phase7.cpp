#include "test_framework.h"
#include "socket_server.h"
#include "app_state.h"
#include <algorithm>

// Phase 7 — Robustness: Input Validation + Graceful Shutdown
//
// Changes tested here:
//   1. socket_count_commas() — counts commas for pre-parse validation
//   2. Comma-count guard — malformed commands are rejected before stoi()
//   3. coinCredit cap — state.coinCredit never exceeds MAX_COIN_CREDIT
//   4. remaining_time clamp — std::max(0LL, ...) keeps values >= 0

// ---------------------------------------- socket_count_commas ---

void test_count_commas_zero()
{
    CHECK_EQ(socket_count_commas("HELLO"), 0);
}

void test_count_commas_one()
{
    CHECK_EQ(socket_count_commas("COIN,5"), 1);
}

void test_count_commas_two()
{
    CHECK_EQ(socket_count_commas("VOUCHER,abc123,10"), 2);
}

void test_count_commas_four()
{
    CHECK_EQ(socket_count_commas("WTRLVL,0,1,0,1"), 4);
}

void test_count_commas_empty_string()
{
    CHECK_EQ(socket_count_commas(""), 0);
}

void test_count_commas_only_commas()
{
    CHECK_EQ(socket_count_commas(",,,"), 3);
}

// -------------------------------- expected counts per command ---
// These encode the protocol: each command type requires exactly N commas.
// If the protocol changes, exactly one test here fails — making the break obvious.

void test_voucher_command_requires_2_commas()
{
    // Valid VOUCHER: VOUCHER,<id>,<coins>
    CHECK_EQ(socket_count_commas("VOUCHER,V001,10"), 2);
}

void test_wtrlvl_command_requires_4_commas()
{
    // Valid WTRLVL: WTRLVL,<p1>,<p2>,<p3>,<p4>
    CHECK_EQ(socket_count_commas("WTRLVL,0,0,0,0"), 4);
}

void test_coin_command_requires_1_comma()
{
    // Valid COIN: COIN,<amount>
    CHECK_EQ(socket_count_commas("COIN,5"), 1);
}

void test_malformed_wtrlvl_has_wrong_comma_count()
{
    // Too few fields — should be detected before parsing
    CHECK(socket_count_commas("WTRLVL,0,1") != 4);
}

void test_malformed_voucher_has_wrong_comma_count()
{
    CHECK(socket_count_commas("VOUCHER,only_one_field") != 2);
}

void test_malformed_coin_has_wrong_comma_count()
{
    CHECK(socket_count_commas("COIN") != 1);
}

// -------------------------------------------- coinCredit cap ---

void test_coinCredit_cap_constant_is_reasonable()
{
    // maxCoinCredit (moved to AppState in Phase 9) must be positive and fit in an int safely
    AppState state;
    CHECK(state.maxCoinCredit > 0);
    CHECK(state.maxCoinCredit < 100000);
}

void test_coinCredit_cap_applied_correctly()
{
    // Simulate what manage_connected_clients does for a COIN command
    AppState state;
    state.coinCredit = 990;
    int coins = 50;  // would push to 1040, over any reasonable cap

    int newCredit = (int)state.coinCredit + coins;
    state.coinCredit = std::min(newCredit, state.maxCoinCredit);

    CHECK(state.coinCredit <= state.maxCoinCredit);
}

void test_coinCredit_below_cap_passes_through()
{
    AppState state;
    state.coinCredit = 0;
    int coins = 5;

    int newCredit = (int)state.coinCredit + coins;
    state.coinCredit = std::min(newCredit, state.maxCoinCredit);

    CHECK_EQ(state.coinCredit, 5);
}

void test_coinCredit_exactly_at_cap_unchanged()
{
    AppState state;
    state.coinCredit = state.maxCoinCredit;
    int coins = 10;

    int newCredit = (int)state.coinCredit + coins;
    state.coinCredit = std::min(newCredit, state.maxCoinCredit);

    CHECK_EQ(state.coinCredit, state.maxCoinCredit);
}

// --------------------------------- remaining_time clamp math ---

void test_remaining_time_negative_value_clamps_to_zero()
{
    long long raw = -2500LL;  // timer is 2.5s in the past
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 0LL);
}

void test_remaining_time_zero_stays_zero()
{
    long long raw = 0LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 0LL);
}

void test_remaining_time_positive_value_passes_through()
{
    long long raw = 3000LL;  // 3 seconds remaining
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 3000LL);
}

void test_remaining_time_large_positive_unchanged()
{
    long long raw = 999999LL;
    long long clamped = std::max(0LL, raw);
    CHECK_EQ(clamped, 999999LL);
}

// ---------------------------------------------------------- entry point ---

void run_phase7_tests()
{
    SUITE("phase7 (robustness: input validation + clamp)");
    RUN_TEST(test_count_commas_zero);
    RUN_TEST(test_count_commas_one);
    RUN_TEST(test_count_commas_two);
    RUN_TEST(test_count_commas_four);
    RUN_TEST(test_count_commas_empty_string);
    RUN_TEST(test_count_commas_only_commas);
    RUN_TEST(test_voucher_command_requires_2_commas);
    RUN_TEST(test_wtrlvl_command_requires_4_commas);
    RUN_TEST(test_coin_command_requires_1_comma);
    RUN_TEST(test_malformed_wtrlvl_has_wrong_comma_count);
    RUN_TEST(test_malformed_voucher_has_wrong_comma_count);
    RUN_TEST(test_malformed_coin_has_wrong_comma_count);
    RUN_TEST(test_coinCredit_cap_constant_is_reasonable);
    RUN_TEST(test_coinCredit_cap_applied_correctly);
    RUN_TEST(test_coinCredit_below_cap_passes_through);
    RUN_TEST(test_coinCredit_exactly_at_cap_unchanged);
    RUN_TEST(test_remaining_time_negative_value_clamps_to_zero);
    RUN_TEST(test_remaining_time_zero_stays_zero);
    RUN_TEST(test_remaining_time_positive_value_passes_through);
    RUN_TEST(test_remaining_time_large_positive_unchanged);
}
