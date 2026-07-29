#include "socket_server.h"
// voucher_manager removed — per-slot armed state used instead
#include "utils.h"
#include <iostream>
#include <cstring>
#include <algorithm>
#include <chrono>

#ifdef _WIN32
#include <ws2tcpip.h>
#define CLOSESOCKET(s) closesocket(s)
#define GET_LAST_SOCKET_ERROR() WSAGetLastError()
#define SOCKET_ERROR_WOULDBLOCK WSAEWOULDBLOCK
#else
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <arpa/inet.h>
#define CLOSESOCKET(s) close(s)
#define GET_LAST_SOCKET_ERROR() errno
#define SOCKET_ERROR_WOULDBLOCK EAGAIN
#endif

// --- Constants ---
const int MAX_BUFFER_SIZE = 1024;
const int LISTEN_BACKLOG  = 5;

SocketHandle g_server_listening_socket = (SocketHandle)-1;
std::vector<SocketHandle> g_connected_client_sockets;
sockaddr_in g_server_address_info;
socklen_t g_server_addrlen = sizeof(g_server_address_info);

// --- Helpers ---

int socket_count_commas(const char *s)
{
  int n = 0;
  while (*s) { if (*s++ == ',') n++; }
  return n;
}

bool isFirstWordTest(const char *str, const char *target_word)
{
  size_t target_word_len = std::strlen(target_word);
  if (std::strlen(str) < target_word_len || std::strncmp(str, target_word, target_word_len) != 0)
    return false;

  char char_after_word = str[target_word_len];
  return (char_after_word == '\0'
       || std::isspace(static_cast<unsigned char>(char_after_word))
       || char_after_word == ',');
}

void set_socket_non_blocking(SocketHandle sock)
{
#ifdef _WIN32
  u_long mode = 1;
  if (ioctlsocket(sock, FIONBIO, &mode) != 0)
    log_error("socket", "Error setting non-blocking: " + std::to_string(GET_LAST_SOCKET_ERROR()));
#else
  int flags = fcntl(sock, F_GETFL, 0);
  if (flags != -1) fcntl(sock, F_SETFL, flags | O_NONBLOCK);
#endif
}

bool initialize_socket_environment()
{
#ifdef _WIN32
  WSADATA wsaData;
  if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
  {
    log_error("socket", "WSAStartup failed");
    return false;
  }
#endif
  return true;
}

bool create_and_bind_server_socket(int port)
{
  g_server_listening_socket = socket(AF_INET, SOCK_STREAM, 0);
  if (g_server_listening_socket == (SocketHandle)-1)
  {
    log_error("socket", "Failed to create socket");
    return false;
  }

  int opt = 1;
  setsockopt(g_server_listening_socket, SOL_SOCKET, SO_REUSEADDR, (const char *)&opt, sizeof(opt));

  g_server_address_info.sin_family = AF_INET;
  g_server_address_info.sin_addr.s_addr = INADDR_ANY;
  g_server_address_info.sin_port = htons(static_cast<uint16_t>(port));

  if (bind(g_server_listening_socket, (struct sockaddr *)&g_server_address_info, sizeof(g_server_address_info)) < 0)
  {
    log_error("socket", "bind() failed on port " + std::to_string(port));
    CLOSESOCKET(g_server_listening_socket);
    return false;
  }
  return true;
}

bool start_listening_for_connections()
{
  if (listen(g_server_listening_socket, LISTEN_BACKLOG) < 0)
  {
    log_error("socket", "listen() failed");
    CLOSESOCKET(g_server_listening_socket);
    return false;
  }
  set_socket_non_blocking(g_server_listening_socket);
  log_info("socket", "Listening on port " + std::to_string(ntohs(g_server_address_info.sin_port)));
  return true;
}

static std::string build_status_response(AppState &state)
{
  // STATUS format (31 fields):
  //   armedQty1-6, remaining1-6, wlvl1-6, busy1-6, queueDepth1-6, paused
  std::string resp = "STATUS";
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.armedQty[i]);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.remaining_time[i]);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.WLVL_PRESSED[i] ? 1 : 0);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string(state.slotBusy[i] ? 1 : 0);
  }
  for (int i = 1; i <= 4; i++) {
    resp += "," + std::to_string((int)state.pendingQueue[i].size());
  }
  resp += "," + std::to_string(state.state_pause ? 1 : 0);
  resp += "," + std::to_string(static_cast<int>(state.phase));
  resp += "," + std::to_string(state.bundleComplete ? 1 : 0);
  return resp;
}

void accept_new_client_connections(AppState &state)
{
  SocketHandle new_client_socket;
  while (true)
  {
    new_client_socket = accept(g_server_listening_socket,
                               (struct sockaddr *)&g_server_address_info,
                               &g_server_addrlen);
#ifdef _WIN32
    if (new_client_socket == INVALID_SOCKET) break;
#else
    if (new_client_socket == -1) break;
#endif
    set_socket_non_blocking(new_client_socket);
    g_connected_client_sockets.push_back(new_client_socket);
    log_info("socket", "New client: " + std::to_string((int)new_client_socket));

    // Push current state immediately so the GUI doesn't wait for the first
    // 5-second ACK before displaying data.
    std::string initial_status = build_status_response(state);
    send(new_client_socket, initial_status.c_str(), initial_status.length(), 0);
  }
}

static void broadcast_status(AppState &state)
{
  std::string msg = build_status_response(state);
  for (SocketHandle sock : g_connected_client_sockets)
    send(sock, msg.c_str(), msg.length(), 0);
}

void manage_connected_clients(AppState &state)
{
  char client_buffer[MAX_BUFFER_SIZE] = {0};

  for (auto it = g_connected_client_sockets.begin(); it != g_connected_client_sockets.end();)
  {
    SocketHandle current_client_socket = *it;
    memset(client_buffer, 0, MAX_BUFFER_SIZE);
    int bytes_received = recv(current_client_socket, client_buffer, MAX_BUFFER_SIZE - 1, 0);

    if (bytes_received <= 0)
    {
#ifdef _WIN32
      if (bytes_received == SOCKET_ERROR && GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK)
      { ++it; continue; }
#else
      if (bytes_received == -1 && GET_LAST_SOCKET_ERROR() == SOCKET_ERROR_WOULDBLOCK)
      { ++it; continue; }
#endif
      CLOSESOCKET(current_client_socket);
      it = g_connected_client_sockets.erase(it);
      continue;
    }

    client_buffer[bytes_received] = '\0';

    try
    {
      if (isFirstWordTest(client_buffer, "ARM_BATCH"))
      {
        // Format: ARM_BATCH,<slot1>:<qty1>,<slot2>:<qty2>,...
        // Arms all specified slots simultaneously from a single sale.
        std::string input_str(client_buffer);
        size_t start = input_str.find(',');
        if (start == std::string::npos) {
          log_error("socket", "Malformed ARM_BATCH: no slots");
        } else {
          std::string payload = input_str.substr(start + 1);
          int armed = 0;
          size_t pos = 0;
          while (pos < payload.length()) {
            size_t colon = payload.find(':', pos);
            size_t comma = payload.find(',', colon);
            if (colon == std::string::npos) break;
            int slot = std::stoi(payload.substr(pos, colon - pos));
            int qty  = std::stoi(payload.substr(colon + 1, comma == std::string::npos ? std::string::npos : comma - colon - 1));
            if (slot >= 1 && slot <= 4 && qty > 0) {
              if (state.slotBusy[slot]) {
                state.pendingQueue[slot].push(PendingArm(slot, qty));
              } else {
                state.armedQty[slot] += qty;
                armed++;
              }
            }
            if (comma == std::string::npos) break;
            pos = comma + 1;
          }
          if (armed > 0) {
            state.phase = TxnPhase::ARMED;
            state.bundleComplete = false;
          }
          log_info("socket", "ARM_BATCH: " + std::to_string(armed) + " slots armed");
          broadcast_status(state);
          saveStateToDisk(state, state.transactionDir);
        }
      }
      else if (isFirstWordTest(client_buffer, "ARM"))
      {
        if (socket_count_commas(client_buffer) != 2)
        {
          log_error("socket", std::string("Malformed ARM (expected 2 commas): ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t p1 = input_str.find(',');
          size_t p2 = input_str.find(',', p1 + 1);
          int productId = std::stoi(input_str.substr(p1 + 1, p2 - (p1 + 1)));
          int qty = std::stoi(input_str.substr(p2 + 1));

          if (productId < 1 || productId > 4)
          {
            log_error("socket", std::string("ARM rejected — invalid product ID: ") + std::to_string(productId));
          }
          else if (qty <= 0)
          {
            log_error("socket", std::string("ARM rejected — invalid qty: ") + std::to_string(qty));
          }
          else if (state.slotBusy[productId])
          {
            // Slot is busy — queue the request
            state.pendingQueue[productId].push(PendingArm(productId, qty));
            log_info("socket", "ARM queued for busy slot " + std::to_string(productId) +
                     "  qty=" + std::to_string(qty) +
                     "  queueDepth=" + std::to_string((int)state.pendingQueue[productId].size()));
          }
          else
          {
            state.armedQty[productId] += qty;
            state.phase = TxnPhase::ARMED;
            state.bundleComplete = false;
            log_info("socket", "ARM accepted  product=" + std::to_string(productId) +
                     "  qty=" + std::to_string(qty) +
                     "  totalArmed=" + std::to_string(state.armedQty[productId]));
          }
          broadcast_status(state);
          saveStateToDisk(state, state.transactionDir);
        }
      }
      else if (isFirstWordTest(client_buffer, "WTRLVL"))
      {
        if (socket_count_commas(client_buffer) != 4)
        {
          log_error("socket", std::string("Malformed WTRLVL (expected 4 commas): ") + client_buffer);
        }
        else
        {
          std::string input_str(client_buffer);
          size_t pos[5];
          pos[0] = input_str.find(',');
          for (int i = 1; i < 4; ++i) pos[i] = input_str.find(',', pos[i - 1] + 1);

          state.WLVL_PRESSED[1] = std::stoi(input_str.substr(pos[0] + 1, pos[1] - (pos[0] + 1))) == 1;
          state.WLVL_PRESSED[2] = std::stoi(input_str.substr(pos[1] + 1, pos[2] - (pos[1] + 1))) == 1;
          state.WLVL_PRESSED[3] = std::stoi(input_str.substr(pos[2] + 1, pos[3] - (pos[2] + 1))) == 1;
          state.WLVL_PRESSED[4] = std::stoi(input_str.substr(pos[3] + 1)) == 1;
          log_info("socket", std::string("Water level update:") +
              "  slot1=" + (state.WLVL_PRESSED[1] ? "EMPTY" : "ok") +
              "  slot2=" + (state.WLVL_PRESSED[2] ? "EMPTY" : "ok") +
              "  slot3=" + (state.WLVL_PRESSED[3] ? "EMPTY" : "ok") +
              "  slot4=" + (state.WLVL_PRESSED[4] ? "EMPTY" : "ok"));
          broadcast_status(state);  // push updated water level flags immediately
        }
      }
      else
      {
        // Any unrecognised command (e.g. "Client ACK") triggers a STATUS response
        std::string data_to_send = build_status_response(state);
        send(current_client_socket, data_to_send.c_str(), data_to_send.length(), 0);
      }
    }
    catch (const std::exception &e)
    {
      log_error("socket", std::string("Command parse error (") + client_buffer + "): " + e.what());
    }
    ++it;
  }
}

void cleanup_socket_environment()
{
  for (SocketHandle sock : g_connected_client_sockets) CLOSESOCKET(sock);
  g_connected_client_sockets.clear();
  if (g_server_listening_socket != (SocketHandle)-1)
  {
    CLOSESOCKET(g_server_listening_socket);
    g_server_listening_socket = (SocketHandle)-1;
  }
#ifdef _WIN32
  WSACleanup();
#endif
}

void server_app_setup(AppState &state)
{
  if (!initialize_socket_environment()) return;
  if (!create_and_bind_server_socket(state.serverPort)) return;
  start_listening_for_connections();
}

void server_app_loop(AppState &state)
{
  accept_new_client_connections(state);
  manage_connected_clients(state);

  // Broadcast STATUS every 500 ms so the GUI timer stays in sync without
  // waiting for a "Client ACK" (which arrives every 5 seconds).
  static auto last_broadcast = std::chrono::steady_clock::now() - std::chrono::seconds(1);
  auto now_bc = std::chrono::steady_clock::now();
  if (std::chrono::duration_cast<std::chrono::milliseconds>(now_bc - last_broadcast).count() >= 500) {
    last_broadcast = now_bc;
    broadcast_status(state);
  }
}
