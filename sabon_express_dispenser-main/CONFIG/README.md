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

### Socket server (`coin_slot`)

| Key | Default | Description |
|-----|---------|-------------|
| `SOCKET_IP` | `127.0.0.1` | IP address that clients use to reach `coin_slot` |
| `SOCKET_PORT` | `8080` | TCP port for the `coin_slot` server |

### coin_slot runtime

| Key | Default | Description |
|-----|---------|-------------|
| `SERVER_PORT` | `8080` | Port `coin_slot` binds to (should match `SOCKET_PORT`) |
| `TRANSACTION_DIR` | `../transaction` | Directory where `coin_slot` writes JSON transaction files |
| `MAX_COIN_CREDIT` | `1000` | Maximum credit a customer can accumulate |

### GUI slot display (`iot_dispenser_v2`)

| Key | Example | Description |
|-----|---------|-------------|
| `slotName1`–`slotName4` | `Deesh\nPremium` | Display name for each pump slot (`\n` for line break) |
| `slotColor1`–`slotColor4` | `(100, 224, 25)` | RGB color for each slot button |

### Water level sensors (`uploaderTransaction`)

| Key | Default | Description |
|-----|---------|-------------|
| `WATER_GPIO_PIN_1` | `26` | BCM GPIO pin for slot 1 water sensor |
| `WATER_GPIO_PIN_2` | `20` | BCM GPIO pin for slot 2 water sensor |
| `WATER_GPIO_PIN_3` | `21` | BCM GPIO pin for slot 3 water sensor |
| `WATER_GPIO_PIN_4` | `11` | BCM GPIO pin for slot 4 water sensor |

### USB coin acceptor (`usb_to_coin_module`)

| Key | Default | Description |
|-----|---------|-------------|
| `SERIAL_PORT` | `/dev/ttyACM0` | USB serial port for the Arduino coin acceptor |
| `BAUD_RATE` | `9600` | Serial communication baud rate |

---

## File location

All Python scripts load config using:
```python
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".." / "CONFIG" / "config.env")
```

The `coin_slot` C++ binary loads it via `utils::loadEnv("../CONFIG/config.env")` at startup.
