# Sabon Express Dispenser — Cashier Dashboard Edition

An IoT-based liquid soap dispensing machine running on a Raspberry Pi. A cashier at a separate dashboard controls all sales — customers no longer insert coins or scan QR codes. The cashier arms specific product slots, and customers press the lit buttons to dispense. All transactions are recorded locally and synced to a cloud API.

## Architecture Overview

The system is a set of cooperating processes on a Raspberry Pi (or local network), all centered around the `controller` TCP socket server.

```
┌──────────────────────────────────────────────────────────────────┐
│                      Raspberry Pi (Vendo Machine)                │
│                                                                  │
│  ┌──────────────┐   WTRLVL                    ┌─────────────┐   │
│  │ water_level_ │ ──────────────────────────► │             │   │
│  │ monitoring   │                             │  controller  │   │
│  └──────────────┘                             │  C++ server │   │
│  ┌──────────────┐   STATUS (poll)             │  (01_Dispenser_Controller)  │   │
│  │status_upload │ ◄────────────────────────── │             │   │
│  └──────────────┘                             │  TCP :8080  │   │
│  ┌──────────────┐                             │             │◄──┤
│  │  transaction_uploader.py │   watches ../transaction    │             │   │
│  │  (JSON sync) │ ◄── written by controller    └──────┬──────┘   │
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
2. Cashier clicks the product(s) on the dashboard → sends `ARM,<productId>,<qty>` to `controller`
3. Armed product slots' LEDs light up; unarmed slots stay dark and unresponsive
4. Customer presses the lit button(s) to dispense — each button only affects its own slot
5. Per-slot queue handles overlapping requests on the same product

## Components

### `controller` — Core Controller (C++)
The main application. Manages 6 pumps, per-slot armed quantities, per-slot pending queues, and a TCP socket server. Each button press only dispenses from its own armed slot. Slot-empty protection prevents pump activation when the water level sensor reports empty. LED GPIO pins indicate which slots are armed.
- Runs via PM2 as **`01_Dispenser_Controller`**
- See [controller/README.md](controller/README.md) for full architecture and protocol docs

### `cashier_dashboard` — Cashier Dashboard (Node.js / HTML)
A local web app that acts as a TCP client to `controller` over the LAN. The cashier selects product(s), enters the amount paid, and the dashboard sends one `ARM,<productId>,<qty>` per product in the sale. Live status shows armed slots, remaining quantities, queue depth, water level, and alerts.
- Runs via PM2 as **`05_Cashier_Dashboard`**

### `uploaders` — Data Sync & Sensor Bridge (Python)
Three background scripts:
- **`transaction_uploader.py`** — watches `../transaction/` for JSON files written by `controller` and POSTs them to the cloud API. Deletes files on successful upload.
- **`water_level_monitoring.py`** — reads 6 GPIO water level sensor pins and continuously sends `WTRLVL,<p1>..<p6>` to the socket server.
- **`status_uploader.py`** — subscribes to the socket server's `STATUS` responses and uploads machine/slot status changes to the cloud API.

Runs via PM2 as **`02_Water_Sensors`**, **`03_Transaction_Uploader`**, **`04_Status_Uploader`**.
See [uploaders/README.md](uploaders/README.md)

### `CONFIG` — Centralized Configuration
`CONFIG/config.env` (gitignored) is the single config file shared by all components. Copy `CONFIG/config.env.sample` to create it. See [CONFIG/README.md](CONFIG/README.md) for all available keys.

---

## PM2 Process List

| PM2 Name | Script / Binary | Purpose |
|----------|----------------|---------|
| `01_Dispenser_Controller` | `controller/main` | Core C++ controller |
| `02_Water_Sensors` | `uploaders/water_level_monitoring.py` | GPIO water sensors → socket |
| `03_Transaction_Uploader` | `uploaders/transaction_uploader.py` | JSON transaction uploader |
| `04_Status_Uploader` | `uploaders/status_uploader.py` | Machine status uploader |
| `05_Cashier_Dashboard` | `cashier_dashboard/server.js` | Cashier web dashboard |

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
1. Builds `controller` with `make`
2. Installs `cashier_dashboard` npm dependencies
3. Creates Python virtual environments and installs requirements for Python modules
4. Registers and starts all 6 PM2 processes
5. Persists the PM2 process list for auto-start on reboot

---

## Documentation

| Document | Covers |
|----------|--------|
| [docs/SYSTEM_REFERENCE.md](docs/SYSTEM_REFERENCE.md) | Full system reference: protocol, wire formats, every component |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Manual install steps, for when the scripts are not usable |
| [docs/DASHBOARD_DESIGN.md](docs/DASHBOARD_DESIGN.md) | Cashier dashboard UI design and layout |
| [docs/BUTTON_WIRING_DEBUG.md](docs/BUTTON_WIRING_DEBUG.md) | Button/LED/pump wiring, pin map, active-low notes |
| [CONFIG/README.md](CONFIG/README.md) | Every `config.env` key |
| [controller/README.md](controller/README.md) | C++ controller architecture and socket protocol |

Superseded planning documents are kept in [docs/archive/](docs/archive/).

---

## Useful Debugging Commands

```bash
# PM2
sudo pm2 list                          # all process status
sudo pm2 logs                          # tail all PM2 logs
sudo pm2 logs 01_Dispenser_Controller                  # tail controller logs
sudo pm2 logs 05_Cashier_Dashboard     # tail dashboard logs
sudo pm2 monit                         # live CPU/memory dashboard
sudo pm2 restart 01_Dispenser_Controller               # restart the core controller

# Network
nc -zv <pi-ip> 8080                    # check if controller socket is reachable
```
