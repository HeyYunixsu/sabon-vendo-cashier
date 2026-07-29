#include "test_framework.h"
#include "voucher_manager.h"
#include <stdexcept>

// Phase 9 removed the global listOfVoucher — each test owns its own vector.

// ---------------------------------------------------- enqueue / dequeue ---

void test_enqueue_increases_size() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 10));
    CHECK_EQ((int)q.size(), 1);
}

void test_enqueue_multiple_increases_size() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 10));
    enqueueVoucher(q, unusedVoucher("V002", 20));
    CHECK_EQ((int)q.size(), 2);
}

void test_dequeue_is_fifo() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 10));
    enqueueVoucher(q, unusedVoucher("V002", 20));
    auto v = dequeueVoucher(q);
    CHECK_EQ(v.voucherId, std::string("V001"));
    CHECK_EQ(v.amount, 10);
}

void test_dequeue_decreases_size() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 10));
    dequeueVoucher(q);
    CHECK_EQ((int)q.size(), 0);
}

void test_dequeue_from_empty_throws() {
    std::vector<unusedVoucher> q;
    bool threw = false;
    try {
        dequeueVoucher(q);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
}

// ------------------------------------------------- getTotalVoucherAmount ---

void test_total_amount_empty_queue() {
    std::vector<unusedVoucher> q;
    CHECK_EQ(getTotalVoucherAmount(q), 0);
}

void test_total_amount_single_voucher() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 15));
    CHECK_EQ(getTotalVoucherAmount(q), 15);
}

void test_total_amount_multiple_vouchers() {
    std::vector<unusedVoucher> q;
    enqueueVoucher(q, unusedVoucher("V001", 10));
    enqueueVoucher(q, unusedVoucher("V002", 25));
    enqueueVoucher(q, unusedVoucher("V003",  5));
    CHECK_EQ(getTotalVoucherAmount(q), 40);
}

// -------------------------------------------------- getAvailableVoucher ---

void test_getAvailableVoucher_selects_minimum_needed() {
    std::vector<unusedVoucher> pool = {
        unusedVoucher("V001", 10),
        unusedVoucher("V002", 10),
        unusedVoucher("V003", 10),
    };
    // Target = 15, needs 2 vouchers (10+10 = 20 >= 15)
    auto selected = getAvailableVoucher(pool, 15);
    CHECK_EQ((int)selected.size(), 2);
    CHECK_EQ(getTotalVoucherAmount(selected), 20);
}

void test_getAvailableVoucher_exact_match() {
    std::vector<unusedVoucher> pool = {
        unusedVoucher("V001", 10),
        unusedVoucher("V002", 10),
    };
    auto selected = getAvailableVoucher(pool, 10);
    CHECK_EQ((int)selected.size(), 1);
    CHECK_EQ(getTotalVoucherAmount(selected), 10);
}

void test_getAvailableVoucher_empty_pool_returns_empty() {
    std::vector<unusedVoucher> pool;
    auto selected = getAvailableVoucher(pool, 10);
    CHECK(selected.empty());
}

void test_getAvailableVoucher_preserves_order() {
    std::vector<unusedVoucher> pool = {
        unusedVoucher("FIRST",  10),
        unusedVoucher("SECOND", 10),
    };
    auto selected = getAvailableVoucher(pool, 10);
    CHECK_EQ(selected[0].voucherId, std::string("FIRST"));
}

// ---------------------------------------------------------- entry point ---

void run_voucher_tests() {
    SUITE("voucher_manager");
    RUN_TEST(test_enqueue_increases_size);
    RUN_TEST(test_enqueue_multiple_increases_size);
    RUN_TEST(test_dequeue_is_fifo);
    RUN_TEST(test_dequeue_decreases_size);
    RUN_TEST(test_dequeue_from_empty_throws);
    RUN_TEST(test_total_amount_empty_queue);
    RUN_TEST(test_total_amount_single_voucher);
    RUN_TEST(test_total_amount_multiple_vouchers);
    RUN_TEST(test_getAvailableVoucher_selects_minimum_needed);
    RUN_TEST(test_getAvailableVoucher_exact_match);
    RUN_TEST(test_getAvailableVoucher_empty_pool_returns_empty);
    RUN_TEST(test_getAvailableVoucher_preserves_order);
}
