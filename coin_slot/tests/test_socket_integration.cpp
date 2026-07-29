// test_socket_integration.cpp
//
// Protocol Integration / Behavioral Tests
// ----------------------------------------
// These tests exercise the full TCP communication path between the coin_slot
// server and a simulated client.  A real OS socket is bound on a test port
// (9901) and a test-client connects to it, sends protocol messages, and
// verifies both the AppState mutations and the STATUS response payload.
//
// This is the same kind of communication that iot_dispenser_v2 performs:
//   - Client sends:  "COIN,<n>"  / "VOUCHER,<id>,<n>" / "WTRLVL,0,0,0,0" / "Client ACK"
//   - Server sends:  "STATUS:<credit>,<t1>,<t2>,<t3>,<t4>,<wl1>,<wl2>,<wl3>,<wl4>,<pause>"
//
// Protocol: plain TCP SOCK_STREAM on 127.0.0.1:9901 (test port, not 8080)
// Framing:  raw stream, no delimiter — each send() is one logical message
//           (safe here because messages are short and fit one TCP segment)

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

// Short sleep to let the server thread process one loop iteration.
static void yield_to_server()
{
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
}

// Open a TCP client socket connected to the test server.
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

// Send a message and return the server's reply (blocks up to 500 ms).
static std::string send_and_recv(ClientSock sock, const std::string &msg)
{
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    char buf[1024] = {0};
#ifdef _WIN32
    // Set a receive timeout so we don't block forever
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

// Discard the on-connect STATUS push so subsequent reads get fresh responses.
// Call this right after connect_test_client() in any test that issues its own
// STATUS request. Do NOT call in test_integration_server_pushes_status_on_connect
// which specifically verifies the push.
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
    recv(sock, buf, sizeof(buf) - 1, 0);  // read and discard the on-connect push
}

// ------------------------------------------------- integration fixture ---
// All integration tests share one server instance to avoid port-in-use races.
// The fixture starts before the first test and stops after the last.

static std::thread          g_server_thread;
static std::atomic<bool>    g_server_running{false};
static AppState             g_test_state;

static void start_integration_server()
{
    g_test_state = AppState{};
    g_test_state.serverPort    = TEST_PORT;
    g_test_state.maxCoinCredit = 1000;

    server_app_setup(g_test_state);

    g_server_running = true;
    g_server_thread = std::thread([](){
        while (g_server_running)
        {
            server_app_loop(g_test_state);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });

    // Give the server a moment to start accepting
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
    // The server must send STATUS immediately on connect — no ACK required.
    // This eliminates the 5-second startup delay in the iot_dispenser_v2 GUI.
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Do NOT send anything — just read what the server spontaneously pushes
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
    CHECK(std::string(buf).find("STATUS:") == 0);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- STATUS response format ---

void test_integration_unknown_command_returns_status()
{
    // iot_dispenser_v2 sends "Client ACK" every 5 s to get a STATUS response.
    // Any message that is not COIN / VOUCHER / WTRLVL triggers STATUS.
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "Client ACK");
    CHECK(resp.find("STATUS:") == 0);

    CLOSE_CLIENT(sock);
}

void test_integration_status_has_10_fields()
{
    // STATUS:<credit>,<t1>,<t2>,<t3>,<t4>,<wl1>,<wl2>,<wl3>,<wl4>,<pause>
    // That is: 1 field before first comma + 9 commas = 10 fields total.
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "STATUS");

    // Strip "STATUS:" prefix
    std::string body = resp.substr(7);
    int commas = 0;
    for (char c : body) if (c == ',') commas++;
    CHECK_EQ(commas, 9);  // 10 fields → 9 commas

    CLOSE_CLIENT(sock);
}

void test_integration_status_starts_with_zero_credit_initially()
{
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    std::string resp = send_and_recv(sock, "STATUS");
    // "STATUS:0,..."  — credit is the first field after the colon
    CHECK(resp.find("STATUS:0,") == 0);

    CLOSE_CLIENT(sock);
}

// ---------------------------------- COIN command ---

void test_integration_coin_increases_credit()
{
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "COIN,10", 7, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 10);
    CLOSE_CLIENT(sock);
}

void test_integration_coin_accumulates_across_messages()
{
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "COIN,5", 6, 0);
    yield_to_server();
    send(sock, "COIN,3", 6, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 8);
    CLOSE_CLIENT(sock);
}

void test_integration_coin_capped_at_maxCoinCredit()
{
    g_test_state.coinCredit    = 0;
    g_test_state.maxCoinCredit = 100;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    send(sock, "COIN,999", 8, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 100);
    g_test_state.maxCoinCredit = 1000;  // restore
    CLOSE_CLIENT(sock);
}

void test_integration_coin_reflected_in_status_response()
{
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send(sock, "COIN,7", 6, 0);
    yield_to_server();

    std::string resp = send_and_recv(sock, "STATUS");
    CHECK(resp.find("STATUS:7,") == 0);

    g_test_state.coinCredit = 0;  // reset for next tests
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_coin_is_ignored()
{
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Missing comma — should be logged and dropped, credit stays 0
    send(sock, "COIN10", 6, 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 0);
    CLOSE_CLIENT(sock);
}

// ---------------------------------- VOUCHER command ---

void test_integration_voucher_increases_credit()
{
    g_test_state.coinCredit = 0;
    g_test_state.voucherQueue.clear();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "VOUCHER,V-TEST-001,20";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 20);
    CLOSE_CLIENT(sock);
}

void test_integration_voucher_queues_into_appstate()
{
    g_test_state.coinCredit = 0;
    g_test_state.voucherQueue.clear();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "VOUCHER,VCH-XYZ,15";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.voucherQueue.size(), 1);
    CHECK_EQ(g_test_state.voucherQueue[0].voucherId, std::string("VCH-XYZ"));
    CHECK_EQ(g_test_state.voucherQueue[0].amount, 15);

    g_test_state.voucherQueue.clear();
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_voucher_is_ignored()
{
    g_test_state.coinCredit = 0;
    g_test_state.voucherQueue.clear();
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Only 1 comma — should be dropped (needs exactly 2)
    std::string msg = "VOUCHER,BADFORMAT";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    CHECK_EQ((int)g_test_state.coinCredit, 0);
    CHECK(g_test_state.voucherQueue.empty());
    CLOSE_CLIENT(sock);
}

// ---------------------------------- WTRLVL command ---

void test_integration_wtrlvl_sets_flags()
{
    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Set pumps 2 and 4 as water-level-triggered
    std::string msg = "WTRLVL,0,1,0,1";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    CHECK(!g_test_state.WLVL_PRESSED[1]);
    CHECK( g_test_state.WLVL_PRESSED[2]);
    CHECK(!g_test_state.WLVL_PRESSED[3]);
    CHECK( g_test_state.WLVL_PRESSED[4]);

    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = false;
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_all_clear()
{
    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = true;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    std::string msg = "WTRLVL,0,0,0,0";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= 4; i++) CHECK(!g_test_state.WLVL_PRESSED[i]);
    CLOSE_CLIENT(sock);
}

void test_integration_malformed_wtrlvl_is_ignored()
{
    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = false;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;

    // Only 2 commas — needs exactly 4
    std::string msg = "WTRLVL,0,1";
    send(sock, msg.c_str(), (int)msg.length(), 0);
    yield_to_server();

    for (int i = 1; i <= 4; i++) CHECK(!g_test_state.WLVL_PRESSED[i]);
    CLOSE_CLIENT(sock);
}

void test_integration_wtrlvl_reflected_in_status()
{
    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = false;
    g_test_state.coinCredit = 0;
    ClientSock sock = connect_test_client();
    CHECK(sock != INVALID_CLIENT_SOCK);
    if (sock == INVALID_CLIENT_SOCK) return;
    drain_connect_push(sock);

    send(sock, "WTRLVL,1,0,0,0", 15, 0);
    yield_to_server();

    // STATUS: 0,0,0,0,0, 1,0,0,0, 0  (field 6 = WLVL_PRESSED[1] = 1)
    std::string resp = send_and_recv(sock, "STATUS");
    // Parse field 6: after "STATUS:X,t1,t2,t3,t4," the next value should be "1"
    CHECK(resp.find("STATUS:") == 0);
    // Count 5 commas to reach WLVL[1]
    std::string body = resp.substr(7);  // skip "STATUS:"
    size_t pos = 0;
    for (int i = 0; i < 5; i++) pos = body.find(',', pos) + 1;
    CHECK_EQ(body[pos], '1');

    for (int i = 1; i <= 4; i++) g_test_state.WLVL_PRESSED[i] = false;
    CLOSE_CLIENT(sock);
}

// ---------------------------------- multiple clients ---

void test_integration_two_clients_independent()
{
    g_test_state.coinCredit = 0;
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

    // c1 sends COIN — both clients share the same AppState
    send(c1, "COIN,5", 6, 0);
    yield_to_server();
    CHECK_EQ((int)g_test_state.coinCredit, 5);

    // c2 also gets the updated STATUS
    std::string resp = send_and_recv(c2, "STATUS");
    CHECK(resp.find("STATUS:5,") == 0);

    g_test_state.coinCredit = 0;
    CLOSE_CLIENT(c1);
    CLOSE_CLIENT(c2);
}

// ---------------------------------- disconnect / reconnect ---

void test_integration_server_handles_client_disconnect()
{
    // Connect, close without ceremony, then connect again — server must not crash.
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
    RUN_TEST(test_integration_status_has_10_fields);
    RUN_TEST(test_integration_status_starts_with_zero_credit_initially);
    RUN_TEST(test_integration_coin_increases_credit);
    RUN_TEST(test_integration_coin_accumulates_across_messages);
    RUN_TEST(test_integration_coin_capped_at_maxCoinCredit);
    RUN_TEST(test_integration_coin_reflected_in_status_response);
    RUN_TEST(test_integration_malformed_coin_is_ignored);
    RUN_TEST(test_integration_voucher_increases_credit);
    RUN_TEST(test_integration_voucher_queues_into_appstate);
    RUN_TEST(test_integration_malformed_voucher_is_ignored);
    RUN_TEST(test_integration_wtrlvl_sets_flags);
    RUN_TEST(test_integration_wtrlvl_all_clear);
    RUN_TEST(test_integration_malformed_wtrlvl_is_ignored);
    RUN_TEST(test_integration_wtrlvl_reflected_in_status);
    RUN_TEST(test_integration_two_clients_independent);
    RUN_TEST(test_integration_server_handles_client_disconnect);

    stop_integration_server();
}
