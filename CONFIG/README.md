# CONFIG — Centralized Configuration

`config.env` is the single configuration file shared by all components in this project. It is **gitignored** — copy `config.env.sample` to create it before running anything.

```bash
cp config.env.sample config.env
# Edit config.env with the correct values for this machine
```

---

## All Available Keys

### Identity

| Key | Example | Description |
|-----|---------|-------------|
| `vendorId` | `abc123` | Vendor identifier, sent with every transaction and API call |
| `machineId` | `5` | Machine identifier, sent with every transaction and API call |

### API

| Key | Default | Description |
|-----|---------|-------------|
| `API_BASE_URL` | `https://office.dynamicglobalsoft.com:1232` | Base URL for all cloud API calls |

### Socket server (`controller`)

| Key | Default | Description |
|-----|---------|-------------|
| `SOCKET_IP` | `127.0.0.1` | IP address that clients use to reach `controller` |
| `SOCKET_PORT` | `8080` | TCP port for the `controller` server |

### controller runtime

| Key | Default | Description |
|-----|---------|-------------|
| `SERVER_PORT` | `8080` | Port `controller` binds to (should match `SOCKET_PORT`) |
| `TRANSACTION_DIR` | `../transaction` | Directory where `controller` writes JSON transaction files |

### Cashier dashboard

| Key | Default | Description |
|-----|---------|-------------|
| `DASHBOARD_PORT` | `80` | HTTP port for the dashboard. 80 needs root, which is why PM2 runs it via sudo |

### Slot hardware (BCM pin numbers)

One button, one LED and one pump relay per slot, all independent.

| Key | Default | Description |
|-----|---------|-------------|
| `BTN1`-`BTN6` | `14 24 25 10 13 23` | Button input per slot. Wired to GND, so each needs `gpio=N=ip,pu` in `/boot/firmware/config.txt` |
| `PUMP1`-`PUMP6` | `15 16 6 17 18 12` | Pump relay output per slot |
| `LED1`-`LED6` | `5 27 4 22 19 7` | Slot LED output |
| `PUMP_TRIGGER_HIGH` | `0` | Level that switches a pump ON (the relays are active-low) |
| `PUMP_TRIGGER_LOW` | `1` | Level that switches a pump OFF |

### Product calibration

| Key | Example | Description |
|-----|---------|-------------|
| `calibrateProduct1`-`calibrateProduct6` | `(5, 2.777778)` | `(coins, seconds)` - how long that slot's pump runs per unit |

### Water level sensors (`uploaders`)

| Key | Default | Description |
|-----|---------|-------------|
| `WATER_GPIO_PIN_1` | `26` | BCM GPIO pin for slot 1 water sensor |
| `WATER_GPIO_PIN_2` | `20` | BCM GPIO pin for slot 2 water sensor |
| `WATER_GPIO_PIN_3` | `21` | BCM GPIO pin for slot 3 water sensor |
| `WATER_GPIO_PIN_4` | `11` | BCM GPIO pin for slot 4 water sensor |
| `WATER_GPIO_PIN_5` | `8` | BCM GPIO pin for slot 5 water sensor |
| `WATER_GPIO_PIN_6` | `9` | BCM GPIO pin for slot 6 water sensor |
| `WATER_SENSOR_EMPTY_HIGH` | `1` | Which level means empty. `1` = empty reads HIGH, `0` = empty reads LOW. Sensors are wired to GND with a pull-up, so a disconnected one reads HIGH; the default therefore treats a dead sensor as empty and blocks the pump rather than letting it run dry |

Sensor pins are read only by `water_level_monitoring.py`, which pulls them
up internally and forwards the raw levels. `WATER_SENSOR_EMPTY_HIGH` is what
`controller` uses to interpret those levels.

---

## File location

All Python scripts load config using:
```python
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".." / "CONFIG" / "config.env")
```

The `controller` C++ binary loads it via `utils::loadEnv("../CONFIG/config.env")` at startup.
