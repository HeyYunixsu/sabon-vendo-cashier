# Sabon Express Dispenser

An IoT-based liquid soap dispensing machine running on a Raspberry Pi. Customers insert coins or scan QR vouchers to purchase dispensed soap. All transactions are recorded locally and synced to a cloud API.

## Architecture Overview

The system is a set of cooperating processes on a single Raspberry Pi (or local network), all centered around the `coin_slot` TCP socket server.

```
┌─────────────────────────────────────────────────────────────┐
│                      Raspberry Pi                           │
│                                                             │
│  ┌──────────────┐   COIN/VOUCHER/WTRLVL   ┌─────────────┐  │
│  │ fire_and_    │ ──────────────────────► │             │  │
│  │ forget.py    │                         │  coin_slot  │  │
│  │ (Arduino     │                         │  C++ server │  │
│  │  serial)     │                         │  (01_Main)  │  │
│  └──────────────┘   WTRLVL                │             │  │
│  ┌──────────────┐ ──────────────────────► │  TCP :8080  │  │
│  │ water_level_ │                         │             │  │
│  │ monitoring   │   STATUS (poll)         │             │◄─┤
│  └──────────────┘ ◄────────────────────── │             │  │
│  ┌──────────────┐   VOUCHER               │             │  │
│  │ qr_code_     │ ──────────────────────► │             │  │
│  │ monitoring   │                         └──────┬──────┘  │
│  └──────────────┘                                │         │
│  ┌──────────────┐   STATUS (poll)                │ STATUS  │
│  │status_upload │ ◄─────────────────────────────-┤         │
│  └──────────────┘                                │         │
│  ┌──────────────┐                          ┌─────▼──────┐  │
│  │  uploader.py │   watches ../transaction  │ iot_disp-  │  │
│  │  (JSON sync) │ ◄── written by coin_slot  │ enser_v2   │  │
│  └──────────────┘                          │ FLTK GUI   │  │
│                                            └────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Components

### `coin_slot` — Core Controller (C++)
The main application. Manages 4 pumps, coin credit, voucher queue, and a TCP socket server. Interrupt handlers respond to coin insertions and button presses. A slot-empty check prevents pump activation when the water level sensor reports the container is empty.
- Runs via PM2 as **`01_Main`**
- See [coin_slot/README.md](coin_slot/README.md) for full architecture and protocol docs

### `iot_dispenser_v2` — Graphical User Interface (C++ / FLTK)
A fullscreen touchscreen GUI that connects to `coin_slot` as a TCP client. Displays live coin balance, per-pump countdown timers, water level status, and slot names/colors loaded from `config.env`. Customers press the pump buttons here to trigger dispensing.
- Runs via systemd as **`vendo_gui.service`**
- See [iot_dispenser_v2/README.md](iot_dispenser_v2/README.md)

### `keyboard_monitoring` — QR Code Scanner (Python)
Monitors a USB QR code scanner (which behaves as a keyboard) using `pynput`. On a completed scan, validates the QR code against the cloud API and sends a `VOUCHER,<id>,<amount>` command to the `coin_slot` socket server.
- Runs via PM2 as **`04_QR_Scanner`**
- See [keyboard_monitoring/README.md](keyboard_monitoring/README.md)

### `uploaderTransaction` — Data Sync & Sensor Bridge (Python)
Three background scripts:
- **`uploader.py`** — watches `../transaction/` for JSON files written by `coin_slot` and POSTs them to the cloud API. Deletes files on successful upload.
- **`water_level_monitoring_v2.py`** — reads 4 GPIO water level sensor pins and continuously sends `WTRLVL,<p1>,<p2>,<p3>,<p4>` to the socket server.
- **`status_uploader.py`** — subscribes to the socket server's `STATUS` responses and uploads machine/slot status changes to the cloud API.

Runs via PM2 as **`05_Water_Level`**, **`06_Transaction_Upload`**, **`07_Status_Upload`**.
See [uploaderTransaction/README.md](uploaderTransaction/README.md)

### `usb_to_coin_module` — Hardware Interfaces (Python)
- **`coin_counter.py`** — listens to an Arduino coin acceptor over serial USB. Parses inserted coin amounts and sends `COIN,<amount>` to the socket server.
- **`simple_on_off_led_relay.py`** — controls the streetlight/LED module via Raspberry Pi GPIO relay.

Runs via PM2 as **`02_Coin_Acceptor`** and **`03_Street_Light`**.
See [usb_to_coin_module/README.md](usb_to_coin_module/README.md)

### `CONFIG` — Centralized Configuration
`CONFIG/config.env` (gitignored) is the single config file shared by all components. Copy `CONFIG/config.env.sample` to create it. See [CONFIG/README.md](CONFIG/README.md) for all available keys.

---

## PM2 Process List

| PM2 Name | Script / Binary | Purpose |
|----------|----------------|---------|
| `01_Main` | `coin_slot/main` | Core C++ controller |
| `02_Coin_Acceptor` | `usb_to_coin_module/coin_counter.py` | Arduino coin serial reader |
| `03_Street_Light` | `usb_to_coin_module/simple_on_off_led_relay.py` | LED relay control |
| `04_QR_Scanner` | `keyboard_monitoring/qr_code_monitoring.py` | QR voucher scanner |
| `05_Water_Level` | `uploaderTransaction/water_level_monitoring_v2.py` | GPIO water sensors → socket |
| `06_Transaction_Upload` | `uploaderTransaction/uploader.py` | JSON transaction uploader |
| `07_Status_Upload` | `uploaderTransaction/status_uploader.py` | Machine status uploader |

`iot_dispenser_v2` is managed separately as a **systemd** service (`vendo_gui.service`) because it requires a graphical display session.

---

## Setup Instructions

### 1. Configure

```bash
cp CONFIG/config.env.sample CONFIG/config.env
# Edit CONFIG/config.env — set vendorId, machineId, API_BASE_URL, etc.
```

### 2. Install system dependencies (once, on a fresh Pi)

```bash
chmod +x install_dependencies.sh
./install_dependencies.sh
```

This installs: WiringPi (from source), FLTK, Node.js v20.x, PM2 v6.x, and journalctl.

### 3. Build, set up venvs, and launch everything

```bash
chmod +x setup_and_run.sh
./setup_and_run.sh 2>&1 | tee setup_run.log
```

This script:
1. Builds `coin_slot` and `iot_dispenser_v2` with `make`
2. Creates Python virtual environments and installs requirements for all three Python modules
3. Registers and starts all 7 PM2 processes
4. Installs, enables, and starts `vendo_gui.service` via systemd

---

## Useful Debugging Commands

```bash
# PM2
sudo pm2 list                          # all process status
sudo pm2 logs                          # tail all PM2 logs
sudo pm2 logs 01_Main                  # tail coin_slot logs
sudo pm2 monit                         # live CPU/memory dashboard
sudo pm2 restart 01_Main               # restart the core controller

# GUI service
sudo journalctl -u vendo_gui -f        # follow GUI service log
sudo journalctl -u vendo_gui -n 100    # last 100 lines
sudo systemctl status vendo_gui        # service status
```
