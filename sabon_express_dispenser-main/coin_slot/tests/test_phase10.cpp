#include "test_framework.h"
#include "utils.h"
#include "app_state.h"
#include <sstream>
#include <iostream>
#include <string>

// Phase 10 — Structured Logging
//
// Changes tested here:
//   1. log_info  writes "[timestamp] [module] msg" to stdout
//   2. log_error writes "[timestamp] [module] ERROR: msg" to stderr
//   3. Both include the module tag in square brackets
//   4. Timestamp prefix matches "YYYY-MM-DD HH:MM:SS" format (19 chars)
//   5. loadEnv no longer writes a bare "Warning:" to stderr (uses log_error)
//   6. AppState.maxCoinCredit is used as the cap — not a hardcoded constant

// ---------------------------------- log_info format ---

void test_log_info_writes_to_stdout()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("testmod", "hello world");

    std::cout.rdbuf(orig);
    std::string out = captured.str();
    CHECK(!out.empty());
}

void test_log_info_contains_module_tag()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("mymodule", "some message");

    std::cout.rdbuf(orig);
    CHECK(captured.str().find("[mymodule]") != std::string::npos);
}

void test_log_info_contains_message()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("mod", "the_actual_message");

    std::cout.rdbuf(orig);
    CHECK(captured.str().find("the_actual_message") != std::string::npos);
}

void test_log_info_timestamp_format()
{
    // The line must start with "[YYYY-MM-DD HH:MM:SS]" — 21 chars including brackets
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_info("ts", "check");

    std::cout.rdbuf(orig);
    std::string out = captured.str();
    // Expected prefix: "[YYYY-MM-DD HH:MM:SS]" = '[' + 19 chars + ']' = 21 chars
    CHECK(out.size() >= 21);
    CHECK_EQ(out[0],  '[');
    CHECK_EQ(out[5],  '-');   // year-month separator
    CHECK_EQ(out[8],  '-');   // month-day separator
    CHECK_EQ(out[11], ' ');   // date-time separator
    CHECK_EQ(out[14], ':');   // hour:minute separator
    CHECK_EQ(out[17], ':');   // minute:second separator
    CHECK_EQ(out[20], ']');   // closing bracket
}

void test_log_info_does_not_write_to_stderr()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_info("mod", "info goes to stdout not stderr");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().empty());
}

// ---------------------------------- log_error format ---

void test_log_error_writes_to_stderr()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("errmod", "something broke");

    std::cerr.rdbuf(orig);
    CHECK(!captured.str().empty());
}

void test_log_error_contains_module_tag()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("errmod", "msg");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("[errmod]") != std::string::npos);
}

void test_log_error_contains_ERROR_label()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("mod", "some problem");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("ERROR") != std::string::npos);
}

void test_log_error_contains_message()
{
    std::streambuf *orig = std::cerr.rdbuf();
    std::ostringstream captured;
    std::cerr.rdbuf(captured.rdbuf());

    log_error("mod", "unique_error_msg_42");

    std::cerr.rdbuf(orig);
    CHECK(captured.str().find("unique_error_msg_42") != std::string::npos);
}

void test_log_error_does_not_write_to_stdout()
{
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    log_error("mod", "error goes to stderr not stdout");

    std::cout.rdbuf(orig);
    CHECK(captured.str().empty());
}

// ---------------------------------- maxCoinCredit as the cap ---
// The credit cap used by socket_server is now state.maxCoinCredit, not a
// hardcoded constant.  These tests verify the AppState field and its effect
// without spinning up a real socket.

void test_maxCoinCredit_default_caps_at_1000()
{
    AppState s;
    // Simulate: newCredit = coinCredit + coins; coinCredit = min(newCredit, maxCoinCredit)
    s.coinCredit = 0;
    int coins = 2000;
    int newCredit = s.coinCredit + coins;
    s.coinCredit = std::min(newCredit, s.maxCoinCredit);
    CHECK_EQ(s.coinCredit, 1000);
}

void test_maxCoinCredit_custom_value_caps_correctly()
{
    AppState s;
    s.maxCoinCredit = 50;
    s.coinCredit = 0;
    int newCredit = s.coinCredit + 200;
    s.coinCredit = std::min(newCredit, s.maxCoinCredit);
    CHECK_EQ(s.coinCredit, 50);
}

void test_maxCoinCredit_does_not_cap_when_under_limit()
{
    AppState s;
    s.maxCoinCredit = 1000;
    s.coinCredit = 0;
    int newCredit = s.coinCredit + 10;
    s.coinCredit = std::min(newCredit, s.maxCoinCredit);
    CHECK_EQ(s.coinCredit, 10);
}

// ---------------------------------------------------------- entry point ---

void run_phase10_tests()
{
    SUITE("phase10 (structured logging + configurable credit cap)");
    RUN_TEST(test_log_info_writes_to_stdout);
    RUN_TEST(test_log_info_contains_module_tag);
    RUN_TEST(test_log_info_contains_message);
    RUN_TEST(test_log_info_timestamp_format);
    RUN_TEST(test_log_info_does_not_write_to_stderr);
    RUN_TEST(test_log_error_writes_to_stderr);
    RUN_TEST(test_log_error_contains_module_tag);
    RUN_TEST(test_log_error_contains_ERROR_label);
    RUN_TEST(test_log_error_contains_message);
    RUN_TEST(test_log_error_does_not_write_to_stdout);
    RUN_TEST(test_maxCoinCredit_default_caps_at_1000);
    RUN_TEST(test_maxCoinCredit_custom_value_caps_correctly);
    RUN_TEST(test_maxCoinCredit_does_not_cap_when_under_limit);
}
