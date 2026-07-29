# Sabon Express Dispenser — Cashier Dashboard Edition

An IoT-based liquid soap dispensing machine running on a Raspberry Pi. A cashier at a separate dashboard controls all sales — customers no longer insert coins or scan QR codes. The cashier arms specific product slots, and customers press the lit buttons to dispense. All transactions are recorded locally and synced to a cloud API.

## Architecture Overview

The system is a set of cooperating processes on a Raspberry Pi (or local network), all centered around the `coin_slot` TCP socket server.

```
┌──────────────────────────────────────────────────────────────────┐
│                      Raspberry Pi (Vendo Machine)                │
│                                                                  │
│  ┌──────────────┐   WTRLVL                    ┌─────────────┐   │
│  │ water_level_ │ ──────────────────────────► │             │   │
│  │ monitoring   │                             │  coin_slot  │   │
│  └──────────────┘                             │  C++ server │   │
│  ┌──────────────┐   STATUS (poll)             │  (01_Main)  │   │
│  │status_upload │ ◄────────────────────────── │             │   │
│  └──────────────┘                             │  TCP :8080  │   │
│  ┌──────────────┐                             │             │◄──┤
│  │  uploader.py │   watches ../transaction    │             │   │
│  │  (JSON sync) │ ◄── written by coin_slot    └──────┬──────┘   │
│  └──────────────┘                                    │          │
│                                                      │          │
│  ┌──────────────┐   ARM,<productId>,<qty>            │          │
│  │  Cashier     │ ──────────────────────────────────┘          │
│  │  Dashboard   │                                              │
│  │  (web app)   │   STATUS (push)                              │
│  └──────────────┘ ◄─────────────────────────────────────────── │
│                                                                  │
│  ┌──────────────┐                                                │
│  │ Street Light │  (LED relay, independent)                      │
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
```

**Flow:**
1. Customer pays the cashier directly (GCash, QR, or cash)
2. Cashier clicks the product(s) on the dashboard → sends `ARM,<productId>,<qty>` to `coin_slot`
3. Armed product slots' LEDs light up; unarmed slots stay dark and unresponsive
4. Customer presses the lit button(s) to dispense — each button only affects its own slot
5. Per-slot queue handles overlapping requests on the same product

## Components

### `coin_slot` — Core Controller (C++)
The main application. Manages 4 pumps, per-slot armed quantities, per-slot pending queues, and a TCP socket server. Each button press only dispenses from its own armed slot. Slot-empty protection prevents pump activation when the water level sensor reports empty. LED GPIO pins indicate which slots are armed.
- Runs via PM2 as **`01_Main`**
- See [coin_slot/README.md](coin_slot/README.md) for full architecture and protocol docs

### `cashier_dashboard` — Cashier Dashboard (Node.js / HTML)
A local web app that acts as a TCP client to `coin_slot` over the LAN. The cashier selects product(s), enters the amount paid, and the dashboard sends one `ARM,<productId>,<qty>` per product in the sale. Live status shows armed slots, remaining quantities, queue depth, water level, and alerts.
- Runs via PM2 as **`08_Cashier_Dashboard`**

### `uploaderTransaction` — Data Sync & Sensor Bridge (Python)
Three background scripts:
- **`uploader.py`** — watches `../transaction/` for JSON files written by `coin_slot` and POSTs them to the cloud API. Deletes files on successful upload.
- **`water_level_monitoring_v2.py`** — reads 4 GPIO water level sensor pins and continuously sends `WTRLVL,<p1>,<p2>,<p3>,<p4>` to the socket server.
- **`status_uploader.py`** — subscribes to the socket server's `STATUS` responses and uploads machine/slot status changes to the cloud API.

Runs via PM2 as **`05_Water_Level`**, **`06_Transaction_Upload`**, **`07_Status_Upload`**.
See [uploaderTransaction/README.md](uploaderTransaction/README.md)

### `usb_to_coin_module` — Hardware Interfaces (Python)
- **`simple_on_off_led_relay.py`** — controls the streetlight/LED module via Raspberry Pi GPIO relay.

Runs via PM2 as **`03_Street_Light`**.
See [usb_to_coin_module/README.md](usb_to_coin_module/README.md)

### `CONFIG` — Centralized Configuration
`CONFIG/config.env` (gitignored) is the single config file shared by all components. Copy `CONFIG/config.env.sample` to create it. See [CONFIG/README.md](CONFIG/README.md) for all available keys.

---

## PM2 Process List

| PM2 Name | Script / Binary | Purpose |
|----------|----------------|---------|
| `01_Main` | `coin_slot/main` | Core C++ controller |
| `03_Street_Light` | `usb_to_coin_module/simple_on_off_led_relay.py` | LED relay control |
| `05_Water_Level` | `uploaderTransaction/water_level_monitoring_v2.py` | GPIO water sensors → socket |
| `06_Transaction_Upload` | `uploaderTransaction/uploader.py` | JSON transaction uploader |
| `07_Status_Upload` | `uploaderTransaction/status_uploader.py` | Machine status uploader |
| `08_Cashier_Dashboard` | `cashier_dashboard/server.js` | Cashier web dashboard |

---

## Setup Instructions

### 1. Configure

```bash
cp CONFIG/config.env.sample CONFIG/config.env
# Edit CONFIG/config.env — set vendorId, machineId, API_BASE_URL, LED pins, etc.
```

### 2. Install system dependencies (once, on a fresh Pi)

```bash
chmod +x install_dependencies.sh
./install_dependencies.sh
```

This installs: WiringPi (from source), Node.js v20.x, PM2 v6.x, and journalctl.

### 3. Build, set up venvs, and launch everything

```bash
chmod +x setup_and_run.sh
./setup_and_run.sh 2>&1 | tee setup_run.log
```

This script:
1. Builds `coin_slot` with `make`
2. Installs `cashier_dashboard` npm dependencies
3. Creates Python virtual environments and installs requirements for Python modules
4. Registers and starts all 6 PM2 processes
5. Persists the PM2 process list for auto-start on reboot

---

## Useful Debugging Commands

```bash
# PM2
sudo pm2 list                          # all process status
sudo pm2 logs                          # tail all PM2 logs
sudo pm2 logs 01_Main                  # tail coin_slot logs
sudo pm2 logs 08_Cashier_Dashboard     # tail dashboard logs
sudo pm2 monit                         # live CPU/memory dashboard
sudo pm2 restart 01_Main               # restart the core controller

# Network
nc -zv <pi-ip> 8080                    # check if coin_slot socket is reachable
```
