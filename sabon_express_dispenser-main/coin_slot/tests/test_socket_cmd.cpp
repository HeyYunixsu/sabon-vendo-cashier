#include "test_framework.h"
#include "socket_server.h"

// Tests for isFirstWordTest() — the command-parsing helper in socket_server.
// This function decides which command a raw TCP message is (COIN, VOUCHER, etc.)

void test_exact_word_matches() {
    CHECK(isFirstWordTest("COIN", "COIN"));
}

void test_match_with_comma_delimiter() {
    CHECK(isFirstWordTest("COIN,5", "COIN"));
}

void test_match_with_space_delimiter() {
    CHECK(isFirstWordTest("STATUS check", "STATUS"));
}

void test_longer_word_does_not_match() {
    // "COINAGE" must NOT match keyword "COIN"
    CHECK(!isFirstWordTest("COINAGE,5", "COIN"));
}

void test_different_word_does_not_match() {
    CHECK(!isFirstWordTest("VOUCHER,abc,10", "COIN"));
}

void test_voucher_command_matches() {
    CHECK(isFirstWordTest("VOUCHER,abc123,10", "VOUCHER"));
}

void test_wtrlvl_command_matches() {
    CHECK(isFirstWordTest("WTRLVL,0,1,0,1", "WTRLVL"));
}

void test_coin_command_matches() {
    CHECK(isFirstWordTest("COIN,5", "COIN"));
}

void test_empty_string_does_not_match() {
    CHECK(!isFirstWordTest("", "COIN"));
}

void test_shorter_than_keyword_does_not_match() {
    CHECK(!isFirstWordTest("COI", "COIN"));
}

void test_keyword_as_prefix_of_longer_word_no_match() {
    // "VOUCHERED" must NOT match "VOUCHER"
    CHECK(!isFirstWordTest("VOUCHERED,x,5", "VOUCHER"));
}

// ---------------------------------------------------------- entry point ---

void run_socket_cmd_tests() {
    SUITE("socket_server (command parsing)");
    RUN_TEST(test_exact_word_matches);
    RUN_TEST(test_match_with_comma_delimiter);
    RUN_TEST(test_match_with_space_delimiter);
    RUN_TEST(test_longer_word_does_not_match);
    RUN_TEST(test_different_word_does_not_match);
    RUN_TEST(test_voucher_command_matches);
    RUN_TEST(test_wtrlvl_command_matches);
    RUN_TEST(test_coin_command_matches);
    RUN_TEST(test_empty_string_does_not_match);
    RUN_TEST(test_shorter_than_keyword_does_not_match);
    RUN_TEST(test_keyword_as_prefix_of_longer_word_no_match);
}
