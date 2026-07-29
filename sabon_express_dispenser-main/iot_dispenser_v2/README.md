# iot_dispenser_v2 — Touchscreen GUI

## Overview

A fullscreen C++ GUI application built with the FLTK library. It runs on the Raspberry Pi's graphical session and displays live machine state to customers: coin balance, per-pump countdown timers, water level (slot empty) indicators, and slot name/color labels.

The GUI is a **TCP client** — it connects to the `coin_slot` socket server and polls it every ~50 ms for updated `STATUS` data. Customers interact with the pump buttons directly on the touchscreen to trigger dispensing (the button press sends a coin-triggered interrupt on the hardware side; the GUI reflects the resulting timer changes).

---

## How It Works

1. On startup, reads `CONFIG/config.env` for slot names, slot colors, socket IP, and socket port.
2. Connects to `coin_slot` TCP server (default `127.0.0.1:8080`).
3. Every 5 seconds sends an acknowledgement to keep the connection alive.
4. Parses `STATUS:<credit>,<t1>,<t2>,<t3>,<t4>,<wl1>,<wl2>,<wl3>,<wl4>,<pause>` responses and updates the UI.

### STATUS response fields

| Field | Description |
|-------|-------------|
| `credit` | Current coin credit |
| `t1`–`t4` | Remaining pump timer in milliseconds (0 = idle) |
| `wl1`–`wl4` | Water level empty flag per slot (1 = empty, 0 = OK) |
| `pause` | Global pause state (1 = paused) |

Timers are displayed in `MMM:SS` format (e.g., `001:30`). Slots where `wl=1` show an empty/disabled indicator so customers know not to select that slot.

---

## Dependencies

| Library | Purpose | Install |
|---------|---------|---------|
| **FLTK 1.3** | GUI toolkit | `sudo apt install libfltk1.3-dev` (handled by `install_dependencies.sh`) |
| **C++17 stdlib** | `std::thread`, `std::chrono`, `std::filesystem` | GCC 8+ |
| **POSIX / Winsock2** | TCP client socket | OS-provided |

---

## Build

### On Raspberry Pi (Linux)

```bash
cd iot_dispenser_v2
make
# Produces: main_gui
```

### On Windows (development)

```bash
# From MinGW64 terminal inside iot_dispenser_v2/
fltk-config --compile ./main.cpp
# or
make
```

Both builds use the same `main.cpp`. On Windows, Winsock2 is used for sockets; on Linux, POSIX sockets are used.

### Compile manually (reference)

```bash
fltk-config --compile ./main.cpp
```

---

## Configuration (from `CONFIG/config.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `SOCKET_IP` | `127.0.0.1` | IP address of the `coin_slot` server |
| `SOCKET_PORT` | `8080` | Port of the `coin_slot` server |
| `slotName1`–`slotName4` | — | Display name for each pump slot (supports `\n` for line breaks) |
| `slotColor1`–`slotColor4` | — | RGB color for each slot button, format: `(r, g, b)` |

---

## Running

### Via systemd (production — managed by `setup_and_run.sh`)

```bash
sudo systemctl status vendo_gui       # check status
sudo systemctl restart vendo_gui      # restart
sudo journalctl -u vendo_gui -f       # follow logs
sudo journalctl -u vendo_gui -n 50    # last 50 lines
```

The service is configured with `Restart=always` and runs as the display user with `DISPLAY=:0` so it appears on the Pi's screen.

### Manual run (for testing)

```bash
cd iot_dispenser_v2
DISPLAY=:0 ./main_gui
```

---

## Resources directory

PNG images used by the GUI (e.g., `Logo.png`) are loaded from `./Resources/` relative to the binary's working directory. The working directory is set to the `iot_dispenser_v2/` folder in the systemd service file.
