// test_socket_integration.cpp
//
// Protocol Integration / Behavioral Tests (updated for cashier-dashboard model)
// ---------------------------------------------------------------------------
// These tests exercise the full TCP communication path between the controller
// server and a simulated client.  A real OS socket is bound on a test port
// (9901) and a test-client connects to it, sends protocol messages, and
// verifies both the AppState mutations and the STATUS response payload.
//
// Protocol messages:
//   - Client sends:  "ARM,<productId>,<qty>" / "WTRLVL,0,0,0,0,0,0" / "Client ACK"
//   - Server sends:  "STATUS,<armedQty>,<t>,<wl>,<busy>,<qDepth>  (TOTAL_SLOTS
//                     values each), <pause>,<phase>,<bundleComplete>"
//
// Protocol: plain TCP SOCK_STREAM on 127.0.0.1:9901 (test port, not 8080)

#include "test_framework.h"
#include "socket_server.h"
#include "app_state.h"
#include <thread>
#include <atomic>
#include <chrono>
#include <string>
#include <cstring>
#include <iostream>
#include <sstream>

// ---------------------------------------------------------------- platform ---

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET ClientSock;
#define INVALID_CLIENT_SOCK INVALID_SOCKET
#define CLOSE_CLIENT(s)     closesocket(s)
#else
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
typedef int ClientSock;
#define INVALID_CLIENT_SOCK (-1)
#define CLOSE_CLIENT(s)     close(s)
#endif

static const int TEST_PORT = 9901;

// ---------------------------------------------------------------- helpers ---

static void yield_to_server()
{
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
}

static ClientSock connect_test_client()
{
    ClientSock sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock == INVALID_CLIENT_SOCK) return INVALID_CLIENT_SOCK;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(TEST_PORT);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) != 0)
    {
        CLOSE_CLIENT(sock);
        return INVALID_CLIENT_SOCK;
    }
    return sock;
}

static std::string send_and_recv(ClientSock sock, const std::string &msg)
{
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 500;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 500000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    if (n <= 0) return "";
    buf[n] = '\0';
    return std::string(buf);
}

static void drain_connect_push(ClientSock sock)
{
    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 300;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 300000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    recv(sock, buf, sizeof(buf) - 1, 0);
}

// ------------------------------------------------- integration fixture ---

static std::thread          g_server_thread;
static std::atomic<bool>    g_server_running{false};
static AppState             g_test_state;

static void start_integration_server()
{
    g_test_state = AppState{};
    g_test_state.serverPort = TEST_PORT;

    server_app_setup(g_test_state);

    g_server_running = true;
    g_server_thread = std::thread([](){
        while (g_server_running)
        {
            server_app_loop(g_test_state);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
}

static void stop_integration_server()
{
    g_server_running = false;
    if (g_server_thread.joinable()) g_server_thread.join();
    cleanup_socket_environment();
}

// =========================================================================
// TESTS
// =========================================================================

// ---------------------------------- connection + immediate STATUS push ---

void test_integration_client_can_connect()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock != INVALID_CLIENT_SOCK) CLOSE_CLIENT(sock);
}

void test_integration_server_pushes_status_on_connect()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    char buf[1024] = {0};
#ifdef _WIN32
    DWORD timeout_ms = 500;
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout_ms, sizeof(timeout_ms));
#else
    struct timeval tv{0, 500000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
#endif
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    CHECK(n > 0);
    buf[n] = '\0';
    CHECK(std::string(buf).find("STATUS") == 0);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- STATUS response format ---

void test_integration_unknown_command_returns_status()
{
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "Client ACK");
    CHECK(resp.find("STATUS") == 0);

    CLOSE_CLIENT(sock);
}

void test_integration_status_field_count()
{
    // STATUS + five per-slot arrays of TOTAL_SLOTS + paused + phase + bundle.
    // Derived from TOTAL_SLOTS so adding a slot cannot leave this stale.
    const int expectedFields = 5 * TOTAL_SLOTS + 4;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "STATUS");
    std::string body = resp.substr(7);  // skip "STATUS,"
    int commas = 0;
    for (char c : body) if (c == ',') commas++;
    // body holds expectedFields - 1 values, so expectedFields - 2 separators
    CHECK_EQ(commas, expectedFields - 2);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- ARM command ---

void test_integration_arm_increases_armedQty()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "ARM,1,5", 7, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 5);
    CHECK_EQ((int)g_test_state.armedQty[2], 0);  // other slots unaffected
    CLOSE_CLIENT(sock);
}

void test_integration_arm_accumulates_for_same_slot()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "ARM,2,3", 7, 0);
    yield_to_server();
    send(sock, "ARM,2,4", 7, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[2], 7);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_different_slots_independent()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "ARM,1,2", 7, 0);
    yield_to_server();
    send(sock, "ARM,3,4", 7, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 2);
    CHECK_EQ((int)g_test_state.armedQty[3], 4);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_reflected_in_status()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send(sock, "ARM,1,7", 7, 0);
    yield_to_server();

    std::string resp = send_and_recv(sock, "STATUS");
    // First field after "STATUS," should be "7"
    CHECK(resp.find("STATUS,7,") == 0);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_arm_is_ignored()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Only 1 comma — needs exactly 2
    send(sock, "ARM,1", 5, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_invalid_product_rejected()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Product ID 7 is out of range (valid: 1..TOTAL_SLOTS)
    send(sock, "ARM,7,1", 7, 0);
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++)
        CHECK_EQ((int)g_test_state.armedQty[i], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_zero_qty_rejected()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "ARM,1,0", 7, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CLOSE_CLIENT(sock);
}

void test_integration_arm_queues_when_slot_busy()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) {
        g_test_state.armedQty[i] = 0;
        while (!g_test_state.pendingQueue[i].empty())
            g_test_state.pendingQueue[i].pop();
    }
    g_test_state.slotBusy[1] = true;  // simulate slot 1 busy

    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "ARM,1,3", 7, 0);
    yield_to_server();

    // armedQty should NOT increase — it's queued
    CHECK_EQ((int)g_test_state.armedQty[1], 0);
    CHECK_EQ((int)g_test_state.pendingQueue[1].size(), 1);

    g_test_state.slotBusy[1] = false;
    while (!g_test_state.pendingQueue[1].empty())
        g_test_state.pendingQueue[1].pop();
    CLOSE_CLIENT(sock);
}

// ---------------------------------- WTRLVL command ---

void test_integration_wtrlvl_sets_flags()
{
    // Legacy 4-value form: slots 5..TOTAL_SLOTS must fall back to "has liquid".
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,1,0,1";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    CHECK(!g_test_state.slotEmpty[1]);
    CHECK( g_test_state.slotEmpty[2]);
    CHECK(!g_test_state.slotEmpty[3]);
    CHECK( g_test_state.slotEmpty[4]);
    for (int i = 5; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_six_sensors()
{
    // Full per-slot form: every slot including 5 and 6 is driven by a sensor.
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,0,0,0,1,1";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= 4; i++) CHECK(!g_test_state.slotEmpty[i]);
    CHECK(g_test_state.slotEmpty[5]);
    CHECK(g_test_state.slotEmpty[6]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_respects_inverted_polarity()
{
    // With WATER_SENSOR_EMPTY_HIGH=0 a LOW reading is the empty one, which is
    // what sensors wired the other way round produce. Every slot's meaning
    // flips; nothing else about the parse changes.
    const int saved = WATER_SENSOR_EMPTY_HIGH;
    WATER_SENSOR_EMPTY_HIGH = 0;

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) { WATER_SENSOR_EMPTY_HIGH = saved; return; }

    std::string msg = "WTRLVL,0,1,0,1,0,1";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    // Inverted: the zeros are the empty slots now, not the ones.
    CHECK( g_test_state.slotEmpty[1]);
    CHECK(!g_test_state.slotEmpty[2]);
    CHECK( g_test_state.slotEmpty[3]);
    CHECK(!g_test_state.slotEmpty[4]);
    CHECK( g_test_state.slotEmpty[5]);
    CHECK(!g_test_state.slotEmpty[6]);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    CLOSE_CLIENT(sock);
    WATER_SENSOR_EMPTY_HIGH = saved;
}

void test_integration_wtrlvl_all_clear()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = true;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,0,0,0";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_wtrlvl_is_ignored()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.slotEmpty[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,1";   // neither 4 nor TOTAL_SLOTS values
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= TOTAL_SLOTS; i++) CHECK(!g_test_state.slotEmpty[i]);
    CLOSE_CLIENT(sock);
}

// ---------------------------------- multiple clients ---

void test_integration_two_clients_independent()
{
    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    ClientSock c1 = connect_test_client();
    ClientSock c2 = connect_test_client();
    CHECK(c1 != INVALID_CLIENT_SOCK);
    CHECK(c2 != INVALID_CLIENT_SOCK);
    if (c1 == INVALID_CLIENT_SOCK || c2 == INVALID_CLIENT_SOCK)
    {
        if (c1 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c1);
        if (c2 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c2);
        return;
    }
    drain_connect_push(c1);
    drain_connect_push(c2);

    // c1 sends ARM — both clients share the same AppState
    send(c1, "ARM,1,5", 7, 0);
    yield_to_server();
    CHECK_EQ((int)g_test_state.armedQty[1], 5);

    // c2 also gets the updated STATUS
    std::string resp = send_and_recv(c2, "STATUS");
    CHECK(resp.find("STATUS,5,") == 0);

    for (int i = 1; i <= TOTAL_SLOTS; i++) g_test_state.armedQty[i] = 0;
    CLOSE_CLIENT(c1);
    CLOSE_CLIENT(c2);
}

// ---------------------------------- disconnect / reconnect ---

void test_integration_server_handles_client_disconnect()
{
    ClientSock c1 = connect_test_client();
    CHECK(c1 != INVALID_CLIENT_SOCK);
    if (c1 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c1);

    yield_to_server();

    ClientSock c2 = connect_test_client();
    CHECK(c2 != INVALID_CLIENT_SOCK);
    if (c2 != INVALID_CLIENT_SOCK) CLOSE_CLIENT(c2);
}

// ========================================================== entry point ---

void run_socket_integration_tests()
{
    SUITE("socket integration (TCP protocol behavioral tests)");

    start_integration_server();

    RUN_TEST(test_integration_client_can_connect);
    RUN_TEST(test_integration_server_pushes_status_on_connect);
    RUN_TEST(test_integration_unknown_command_returns_status);
    RUN_TEST(test_integration_status_field_count);
    RUN_TEST(test_integration_arm_increases_armedQty);
    RUN_TEST(test_integration_arm_accumulates_for_same_slot);
    RUN_TEST(test_integration_arm_different_slots_independent);
    RUN_TEST(test_integration_arm_reflected_in_status);
    RUN_TEST(test_integration_malformed_arm_is_ignored);
    RUN_TEST(test_integration_arm_invalid_product_rejected);
    RUN_TEST(test_integration_arm_zero_qty_rejected);
    RUN_TEST(test_integration_arm_queues_when_slot_busy);
    RUN_TEST(test_integration_wtrlvl_sets_flags);
    RUN_TEST(test_integration_wtrlvl_six_sensors);
    RUN_TEST(test_integration_wtrlvl_respects_inverted_polarity);
    RUN_TEST(test_integration_wtrlvl_all_clear);
    RUN_TEST(test_integration_malformed_wtrlvl_is_ignored);
    RUN_TEST(test_integration_two_clients_independent);
    RUN_TEST(test_integration_server_handles_client_disconnect);

    stop_integration_server();
}
