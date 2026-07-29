# usb_to_coin_module — Hardware Interfaces

## Overview

Two Python scripts that bridge physical hardware to the `coin_slot` TCP socket server.

| PM2 Name | Script | Role |
|----------|--------|------|
| `02_Coin_Acceptor` | `coin_counter.py` | Arduino coin acceptor → sends `COIN` to socket |
| `03_Street_Light` | `simple_on_off_led_relay.py` | GPIO relay control for the LED/streetlight |

---

## Scripts

### `coin_counter.py`

Listens to an Arduino-based coin acceptor module connected over USB serial. The Arduino sends lines like `Inserted Coin: 5.00` when a coin is detected. This script parses the amount and sends `COIN,<amount>` to the `coin_slot` socket server.

**Flow:**
1. Opens the serial port (`SERIAL_PORT` from config, e.g., `/dev/ttyACM0`) at `BAUD_RATE`.
2. Reads lines via `serial.readline()` (blocks up to 1 second per read).
3. Parses amount from `Inserted Coin: <value>` format.
4. Connects to the socket server, sends `COIN,<amount>`, and closes the connection.
5. If no coin is inserted for 5 minutes, flushes the serial input buffer to prevent stale data.

The socket connection is opened fresh per coin event (fire-and-forget) — no persistent connection is maintained.

---

### `simple_on_off_led_relay.py`

Controls the machine's streetlight/LED module via a Raspberry Pi GPIO relay pin. Provides scheduled on/off behavior for the display lighting.

---

## Dependencies

```bash
# Handled automatically by setup_and_run.sh
# Manual install:
cd usb_to_coin_module
python3 -m venv venv
venv/bin/pip install -r requirement.txt
```

Key packages: `pyserial`, `python-dotenv`

---

## Configuration (from `CONFIG/config.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `SERIAL_PORT` | `/dev/ttyACM0` | USB serial port for the Arduino coin acceptor |
| `BAUD_RATE` | `9600` | Serial baud rate |
| `SOCKET_IP` | `127.0.0.1` | IP address of the `coin_slot` server |
| `SOCKET_PORT` | `8080` | Port of the `coin_slot` server |

To find the correct serial port on the Pi:
```bash
ls /dev/ttyACM* /dev/ttyUSB*
# or
dmesg | grep tty
```

---

## Running

### Via PM2 (production)

```bash
sudo pm2 logs 02_Coin_Acceptor        # coin acceptor logs
sudo pm2 logs 03_Street_Light         # LED relay logs
sudo pm2 restart 02_Coin_Acceptor     # restart coin acceptor
```

### Manual run (for testing)

```bash
cd usb_to_coin_module
venv/bin/python3 coin_counter.py
```

---

## Notes

- The Arduino must be connected and the coin acceptor module powered before starting this script. If the serial port is not found, the script will exit with a `SerialException`.
- If `SOCKET_IP`/`SOCKET_PORT` are not set in `config.env`, the script will raise an error on startup (these keys have no fallback default in this script).
