// Phase 3 eliminated all extern globals — modules receive state through
// AppState& parameters, so no stub definitions are needed here.

#include "test_framework.h"
#include <iostream>

// Phase 1 suites
void run_utils_tests();
void run_socket_cmd_tests();
void run_mock_tests();
void run_hardware_tests();

// Phase 2-10 suites
void run_phase2_tests();
void run_phase3_tests();
void run_phase4_tests();
void run_phase5_tests();
void run_phase6_tests();
void run_phase7_tests();
void run_phase8_tests();
void run_phase9_tests();
void run_phase10_tests();

// Socket protocol integration tests (Phase 9/10)
void run_socket_integration_tests();

int main()
{
    std::cout << "Coin Slot Unit Tests\n";
    std::cout << "====================\n";

    run_utils_tests();
    run_socket_cmd_tests();
    run_mock_tests();
    run_hardware_tests();

    run_phase2_tests();
    run_phase3_tests();
    run_phase4_tests();
    run_phase5_tests();
    run_phase6_tests();
    run_phase7_tests();
    run_phase8_tests();
    run_phase9_tests();
    run_phase10_tests();

    // Integration tests run last — they bind a real socket on port 9901
    run_socket_integration_tests();

    std::cout << "\n====================\n";
    std::cout << "Results: "
              << g_passes   << " passed, "
              << g_failures << " failed\n";

    return (g_failures > 0) ? 1 : 0;
}
