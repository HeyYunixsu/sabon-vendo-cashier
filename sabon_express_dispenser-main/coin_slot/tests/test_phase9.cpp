#include "test_framework.h"
#include "app_state.h"
#include "voucher_manager.h"
#include <sstream>
#include <iostream>

// Phase 9 — Remove Last Global Coupling + Last Debug Cout
//
// Changes tested here:
//   1. listOfVoucher is gone as a global — queue lives in AppState.voucherQueue
//   2. AppState.voucherQueue starts empty and holds unusedVoucher correctly
//   3. enqueueVoucher / dequeueVoucher operate on a local vector — no global side effects
//   4. enqueueVoucher produces NO stdout output
//   5. dequeueVoucher produces NO stdout output
//   6. AppState.maxCoinCredit exists and defaults to 1000
//   7. Two independent AppState instances have independent queues

// ---------------------------------- voucherQueue in AppState ---

void test_appstate_voucherQueue_starts_empty()
{
    AppState s;
    CHECK(s.voucherQueue.empty());
}

void test_appstate_voucherQueue_enqueue_increases_size()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("V001", 10));
    CHECK_EQ((int)s.voucherQueue.size(), 1);
}

void test_appstate_voucherQueue_dequeue_returns_correct_voucher()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("V-ABC", 25));
    unusedVoucher v = dequeueVoucher(s.voucherQueue);
    CHECK_EQ(v.voucherId, std::string("V-ABC"));
    CHECK_EQ(v.amount, 25);
}

void test_appstate_voucherQueue_fifo_order()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("FIRST", 5));
    enqueueVoucher(s.voucherQueue, unusedVoucher("SECOND", 10));
    unusedVoucher first = dequeueVoucher(s.voucherQueue);
    CHECK_EQ(first.voucherId, std::string("FIRST"));
    unusedVoucher second = dequeueVoucher(s.voucherQueue);
    CHECK_EQ(second.voucherId, std::string("SECOND"));
}

void test_appstate_voucherQueue_empty_after_draining()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("V1", 5));
    dequeueVoucher(s.voucherQueue);
    CHECK(s.voucherQueue.empty());
}

// ---------------------------------- getTotalVoucherAmount via AppState ---

void test_getTotalVoucherAmount_via_appstate_queue()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("A", 10));
    enqueueVoucher(s.voucherQueue, unusedVoucher("B", 15));
    CHECK_EQ(getTotalVoucherAmount(s.voucherQueue), 25);
}

void test_getTotalVoucherAmount_empty_queue_is_zero()
{
    AppState s;
    CHECK_EQ(getTotalVoucherAmount(s.voucherQueue), 0);
}

// ---------------------------------- Queue independence between AppState instances ---

void test_two_appstate_queues_are_independent()
{
    AppState s1, s2;
    enqueueVoucher(s1.voucherQueue, unusedVoucher("ONLY_IN_S1", 99));
    CHECK_EQ((int)s1.voucherQueue.size(), 1);
    CHECK(s2.voucherQueue.empty());  // s2 must not be affected
}

// ---------------------------------- No stdout from enqueue/dequeue ---

void test_enqueueVoucher_produces_no_stdout()
{
    AppState s;
    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    enqueueVoucher(s.voucherQueue, unusedVoucher("SILENT", 5));

    std::cout.rdbuf(orig);
    CHECK(captured.str().empty());
}

void test_dequeueVoucher_produces_no_stdout()
{
    AppState s;
    enqueueVoucher(s.voucherQueue, unusedVoucher("SILENT", 5));

    std::streambuf *orig = std::cout.rdbuf();
    std::ostringstream captured;
    std::cout.rdbuf(captured.rdbuf());

    dequeueVoucher(s.voucherQueue);

    std::cout.rdbuf(orig);
    CHECK(captured.str().empty());
}

// ---------------------------------- AppState.maxCoinCredit ---

void test_appstate_maxCoinCredit_default_is_1000()
{
    AppState s;
    CHECK_EQ(s.maxCoinCredit, 1000);
}

void test_appstate_maxCoinCredit_can_be_changed()
{
    AppState s;
    s.maxCoinCredit = 500;
    CHECK_EQ(s.maxCoinCredit, 500);
}

void test_two_appstate_maxCoinCredit_independent()
{
    AppState s1, s2;
    s1.maxCoinCredit = 200;
    CHECK_EQ(s2.maxCoinCredit, 1000);  // s2 must still be at default
}

// ---------------------------------------------------------- entry point ---

void run_phase9_tests()
{
    SUITE("phase9 (voucherQueue in AppState + maxCoinCredit + no debug cout)");
    RUN_TEST(test_appstate_voucherQueue_starts_empty);
    RUN_TEST(test_appstate_voucherQueue_enqueue_increases_size);
    RUN_TEST(test_appstate_voucherQueue_dequeue_returns_correct_voucher);
    RUN_TEST(test_appstate_voucherQueue_fifo_order);
    RUN_TEST(test_appstate_voucherQueue_empty_after_draining);
    RUN_TEST(test_getTotalVoucherAmount_via_appstate_queue);
    RUN_TEST(test_getTotalVoucherAmount_empty_queue_is_zero);
    RUN_TEST(test_two_appstate_queues_are_independent);
    RUN_TEST(test_enqueueVoucher_produces_no_stdout);
    RUN_TEST(test_dequeueVoucher_produces_no_stdout);
    RUN_TEST(test_appstate_maxCoinCredit_default_is_1000);
    RUN_TEST(test_appstate_maxCoinCredit_can_be_changed);
    RUN_TEST(test_two_appstate_maxCoinCredit_independent);
}
