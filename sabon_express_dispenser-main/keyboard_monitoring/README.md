# keyboard_monitoring — QR Code Scanner

## Overview

Monitors a USB QR code scanner that presents itself to the OS as a keyboard. When a customer scans a QR voucher, this script captures the keystrokes, validates the code against the cloud API, and sends a `VOUCHER` command to the `coin_slot` TCP socket server to credit the customer's balance.

Runs via PM2 as **`04_QR_Scanner`**.

---

## How It Works

1. Uses `pynput` to listen for global keyboard events (works even when no window is focused).
2. Collects keypresses into a buffer. If there is a gap longer than `INPUT_TIMEOUT_SECONDS` (0.5 s) between keys, the buffer is cleared — this distinguishes fast scanner input from slow human typing.
3. On `Enter`, the buffer is joined into the scanned QR string.
4. POSTs the QR string and `machineId` to `POST /api/v1/auth/validate`.
5. On a successful response, sends `VOUCHER,<voucherId>,<amount>` to the `coin_slot` socket server.

---

## Files

| File | Description |
|------|-------------|
| `qr_code_monitoring.py` | Main script |
| `requirement.txt` | Python dependencies |
| `qr_scanner.service` | Legacy systemd service file (now managed via PM2 in `setup_and_run.sh`) |

---

## Dependencies

Install via the virtual environment created by `setup_and_run.sh`:

```bash
# Handled automatically by setup_and_run.sh
# Manual install:
cd keyboard_monitoring
python3 -m venv venv
venv/bin/pip install -r requirement.txt
```

Key packages: `pynput`, `requests`, `python-dotenv`

---

## Configuration (from `CONFIG/config.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `vendorId` | — | Vendor ID sent to the validation API |
| `machineId` | `1` | Machine ID sent to the validation API |
| `API_BASE_URL` | `https://office.dynamicglobalsoft.com:1232` | Base URL for QR validation API |
| `SOCKET_IP` | `127.0.0.1` | IP address of the `coin_slot` server |
| `SOCKET_PORT` | `8080` | Port of the `coin_slot` server |

---

## API Contract

**Request:** `POST /api/v1/auth/validate`
```
Content-Type: application/x-www-form-urlencoded
qr=<scanned_value>&machineId=<id>
```

**Success response (200):**
```json
{
  "data": {
    "voucherId": "865abf1f-...",
    "amount": 10
  }
}
```

On success, sends `VOUCHER,<voucherId>,<amount>` to the coin_slot socket server.

---

## Running

### Via PM2 (production)

```bash
sudo pm2 logs 04_QR_Scanner           # tail logs
sudo pm2 restart 04_QR_Scanner        # restart
```

`setup_and_run.sh` injects `DISPLAY=:0` and `XAUTHORITY` automatically so `pynput` can connect to the X server even when started over SSH.

### Manual run (for testing)

```bash
cd keyboard_monitoring
DISPLAY=:0 venv/bin/python3 qr_code_monitoring.py
```
