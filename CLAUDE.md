# Sabon Express Dispenser

A six-slot liquid-soap dispenser that runs on a Raspberry Pi. A cashier takes
payment on a tablet, unlocks presses on the machine, and the customer presses a
button to fill their own bottle. Sales upload to a cloud API; the machine keeps
working when that link is down.

Three parts: a C++ controller that owns the hardware, a Node dashboard the
cashier uses, and Python uploaders that talk to the API.

## Commands

```bash
# Controller: build and test (on the Pi; use mingw32-make on Windows)
cd controller && make && make test

# Dashboard: checks (no framework, plain node asserts)
cd cashier_dashboard && npm test

# On a Pi: what is running, and the controller's live log
sudo pm2 list
sudo pm2 logs 01_Dispenser_Controller
```

## The five processes

PM2 runs all of them, registered by `setup_and_run.sh`:

| Process | What it is | Source |
|---|---|---|
| `01_Dispenser_Controller` | Owns pumps, buttons, sensors, sales records | `controller/` |
| `02_Water_Sensors` | Tank empty detection | `uploaders/water_level_monitoring.py` |
| `03_Transaction_Uploader` | Sales to the API, with a local queue | `uploaders/transaction_uploader.py` |
| `04_Status_Uploader` | Machine health to the API | `uploaders/status_uploader.py` |
| `05_Cashier_Dashboard` | Web dashboard for the cashier | `cashier_dashboard/` |

```
cashier tablet ──HTTP/SSE──▶ dashboard server ──TCP 127.0.0.1:8080──▶ controller ──▶ pumps
                                    │                                      │
                                    └──────────── cloud API ◀── uploaders ◀┘ sale files
```

Ports: the controller listens on **8080**, the dashboard serves on **80**
(`DASHBOARD_PORT`). Both are set in `CONFIG/config.env`.

## Where things live

| Path | What |
|---|---|
| `controller/src/pump_control.cpp` | Main loop: buttons, pours, credits, sale records |
| `controller/src/socket_server.cpp` | TCP protocol and STATUS broadcast |
| `controller/src/hardware_config.cpp` | Pin numbers, calibration, prices |
| `cashier_dashboard/server.js` | HTTP routes, SSE stream, controller socket |
| `cashier_dashboard/public/js/v2.js` | The dashboard itself |
| `cashier_dashboard/public/js/tour.js` | First-run tutorial |
| `cashier_dashboard/lib/prime_log.js` | Reads the air-clear log |
| `uploaders/` | The three Python services |
| `CONFIG/config.env.sample` | Every setting, documented |
| `docs/SYSTEM_REFERENCE.md` | Full detail on all of the above |
| `docs/QUICK_INSTALL.md` | Copy-paste setup for a new Pi |

## Rules that cannot be guessed from the code

1. **The six sales fields never change.** A sale file holds exactly
   `machine_id`, `vendor_id`, `voucher_id`, `amount`, `slot`, `date_created`
   (`controller/src/transaction.cpp`). The cloud API matches on them.
2. **`CONFIG/config.env` is per-machine and untracked.** It holds the machine
   and vendor IDs. Never commit it, never paste its values into a doc or a
   commit message. `CONFIG/config.env.sample` is the tracked template.
3. **Buttons are wired to ground, so they need pull-ups.** A press reads LOW.
   Pull-ups come from `/boot/firmware/config.txt`
   (`gpio=10,13,14,23,24,25=ip,pu`), because wiringPi's own pull-up call is
   unreliable on this OS.
4. **Pumps are active-low.** `PUMP_TRIGGER_HIGH = 0`. `config.txt` holds them
   off at boot with `gpio=6,12,15,16,17,18=op,dh`, or every pump runs during
   startup.
5. **The water sensor default is fail-safe.** `WATER_SENSOR_EMPTY_HIGH = 1`. If
   every slot reads backwards, flip it in `config.env` rather than in code.
6. **A press must be held `BUTTON_HOLD_MS` (100 ms)** to start a pour on an idle
   pump. A press on a pump that is already running is instant. This is
   deliberate: it stops a knocked button from pouring, while still letting a
   customer tap quickly for more.
7. **One sale record per press.** Five presses on an unlocked slot write five
   files, not one.
8. **`connected` on the status stream does not mean the machine is alive.** It
   means the web server answered. Only a `STATUS` line proves the machine is
   there. Six seconds of silence marks it offline.
9. **The dashboard has no login, by design.** It runs on a shop LAN.
10. **`.claude/` is gitignored**, so skills and agents in it are local to this
    machine.

## Hardware

BTN pins: 14, 24, 25, 10, 13, 23 (slots 1-6).
PUMP pins: 15, 16, 6, 17, 18, 12.
LED pins: 5, 27, 4, 22, 19, 7.
Defaults live in `controller/src/hardware_config.cpp` and can be overridden per
machine in `config.env`.

Pins these collide with, all disabled in `config.txt`: the serial port on 14
and 15 (`enable_uart=0`, and remove `console=serial0` from `cmdline.txt`), SPI
on 7-11 (`dtparam=spi=off`), audio on 18 and 19 (`dtparam=audio=off`).

Diagnose a pin with `pinctrl get 14`: it must read `hi` at rest and `lo` while
pressed.

## Protocols

**Dashboard to controller**, one line per command over TCP 8080:
`ARM,<slot>,<qty>`, `ARM_BATCH,<slot>:<qty>,…`, `CANCEL`, `CANCEL_ALL`,
`CANCEL_QUEUE`, `PRIME,<slot>`, `SETPRICE,<slot>,<pesos>`, `GETPRICES`,
`STATUS`, `WTRLVL`.

**Controller to dashboard**: a `STATUS` line about twice a second, with 34
comma-separated fields for six slots (armed, remaining, water, busy, queued,
then paused, phase, bundle-complete), plus `PRICES:`, `PRIME_ACK` and
`PRICE_ACK`.

**Dashboard to browser** over `/api/status/stream`: `connected`, the `STATUS`
lines as they arrive, `PRICES:`, `PRIME_ACK`, `PRICE_ACK`, and
`CONTROLLER_OFFLINE` when the controller drops. The browser marks the machine
offline after 6 s of silence and rebuilds the stream every 15 s.

## Deploying

```bash
cd ~/Desktop/sabon-vendo-cashier && git pull
sudo pm2 restart 05_Cashier_Dashboard     # only if server.js changed
cd controller && make                      # only if C++ changed
```

Dashboard HTML, CSS or JS alone: `git pull` and a hard refresh on the tablet.
A full setup, or a new Pi, is `docs/QUICK_INSTALL.md`.

## Known traps

- **Damaged pins on the current Pi.** GPIO 23 and 25 cannot hold a pull-up on
  the deployed board, so BTN3 and BTN6 read LOW forever. Proven by swapping to
  other pins. Fix with a different Pi, or move those buttons to GPIO 0 and 1.
- **The cloud API port.** Sales fail to upload when `API_BASE_URL` names a port
  the backend is not listening on. `Connection refused` in
  `03_Transaction_Uploader` means the port, not the code.
- **A pour that outlives its tank is charged, not refunded.** If the water
  sensor reads empty mid-pour, the controller closes the dispense, writes one
  sale per press **at full price**, and appends the event to
  `interrupted_sales.jsonl` for staff to settle with the customer. Full price
  is deliberate: it is what the customer was charged, and recording less would
  under-report revenue. Nothing is returned to `armedQty`.

## The kiosk product

`../sabon_kiosk` is a separate product built from this repo's machine core: a
self-service kiosk with no cashier. It has its own `CLAUDE.md` and a
`docs/REUSE_MAP.md` recording exactly what was copied and what was left.

The two share no code, by choice — a change here can never break a deployed
kiosk, and vice versa. The cost is that a `controller/` or `uploaders/` fix has
to be applied twice. When that happens, copy the change rather than the file,
and say in the commit message which repo it came from and which commit.
