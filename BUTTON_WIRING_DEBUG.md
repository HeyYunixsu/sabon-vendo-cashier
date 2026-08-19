# Button Wiring Debug — GPIO↔GND (Active-Low) Buttons Not Working

> **Status:** UNRESOLVED — buttons always read LOW (0), even with pull-up enabled.
> **Priority:** Highest (user explicitly said "fix the button first, that's the priority").
> **Created:** 2026-08-17

This document captures the full context of the button problem so a fresh session can
pick it up without re-reading everything.

---

## 1. System overview

"Sabon Express" vending machine dispenser. Two codebases:

| Component | Path | What it is |
|-----------|------|------------|
| Dashboard | `cashier_dashboard/` | Node.js Express server (`server.js`) + single-file HTML UI (`public/index.html`), SSE for live status. Runs on the same machine as the firmware. |
| Firmware  | `coin_slot/` | C++17 firmware using **wiringPi** (Raspberry Pi GPIO). Runs on the Pi. |

Data flow:

```
browser ──SSE──> cashier_dashboard/server.js ──TCP──> coin_slot firmware (port 8080)
```

- Firmware default socket port: **8080** (`coin_slot/includes/app_state.h` line 42: `int serverPort = 8080;`).
- Dashboard connects to `127.0.0.1:8080` by default (`cashier_dashboard/server.js` line 47).
- Firmware is deployed on the Raspberry Pi via `coin_slot/vendo.service`:
  `ExecStart=/home/dgsi/Desktop/dispenser/coin_slot/main` (user `dgsi`).

---

## 2. The hardware (5 slots)

Each of the 5 slots has an independent **button + LED + pump relay**. The buttons are
**tri-LED illuminated momentary push buttons** — the LED is built into the button, so the
button has two separate groups of terminals:

- **Switch terminals** (the press): used for the button input.
- **LED terminals** (the light): separate; unrelated to button presses.

### Pin map (BCM numbering) — `coin_slot/src/hardware_config.cpp`

| Slot | Button (BTN) | LED | Pump |
|------|-------------|-----|------|
| 1    | **14** (UART TXD!) | 5  | 15 |
| 2    | 24 | 27 | 16 |
| 3    | 25 | 4  | 6  |
| 4    | 10 | 22 | 17 |
| 5    | 13 | 19 | 18 |

- `PUMP_TRIGGER_HIGH = 0`, `PUMP_TRIGGER_LOW = 1` (pumps are **active-low relays**).
- `TOTAL_SLOTS = 5`.
- ⚠️ **BTN1 = GPIO 14 is UART0 TXD** (GPIO 15 = RXD). May conflict if serial console is enabled.

---

## 3. The wiring change that started this

- **Before:** button wired `GPIO → 3V3` (**active-high**). Code used `PUD_DOWN` + `digitalRead == HIGH`.
- **Now:** button wired `GPIO → GND` (**active-low**). User physically rewired the button.
- User's button cable is **only 2 wires: GPIO + GND. No 3V3 wire at the button.**

### Code changes already made (committed)

In `coin_slot/src/pump_control.cpp`:

1. Line 207 — pull-up instead of pull-down:
   ```cpp
   pullUpDnControl(pin_button[i], PUD_UP);   // was PUD_DOWN
   ```
2. Line 241 — active-low read:
   ```cpp
   int raw = (digitalRead(pin_button[i]) == LOW) ? 1 : 0;   // was == HIGH
   ```

LED writes were **not** changed (correct as-is): `digitalWrite(pin_led[i], HIGH)` = ON
for GPIO→GND active-high LED wiring.

### Button scan / debounce logic (unchanged, for reference)

In `pump_loop()` (`pump_control.cpp` ~line 233):
- 4-sample rolling window, `sum == 4` ⇒ "pressed" (~80ms debounce at ~50Hz loop rate).
- Edge-triggered: fires `executeDispenseTrigger(i)` on the rising edge of `pressed`.
- `executeDispenseTrigger` only dispenses if `state.armedQty[i] > 0` (slot must be armed via dashboard first).

---

## 4. The problem

**Buttons don't register presses with the GPIO↔GND wiring.**

Diagnostic result (run directly on the Pi, as user `dgsi`):

```bash
sudo gpio -g mode 14 up      # set BCM 14 as input with internal pull-UP
gpio -g read 14              # → 0   (EXPECTED 1 when button open / not pressed)
```

Even with `sudo`, the pin reads **0** when it should read **1**. This means the pin is
sitting LOW — i.e. **the internal pull-up is not holding it HIGH.**

### Related (separate but confused with this) issue: "demo mode"

The dashboard showed "demo" because the firmware wasn't running → nothing on port 8080 →
no live STATUS. Key facts established:

- `g++` and `make` are **not installed on the Windows dev machine** (verified). The firmware
  must be compiled/run on the Pi.
- `make` only **compiles**; it does not run the binary. Must run `./main` (or `make run`) after.
- On Windows the Makefile builds a **mock** (`main.exe`, mock wiringPi) for UI testing only.
- `CONFIG/config.env` does **not** exist (only `CONFIG/config.env.sample`). Without it the
  firmware falls back to hardcoded BCM pin defaults (the table above) and port 8080.

This "demo" issue is distinct from the button problem, but both stem from "is the new
firmware actually compiled and running on the Pi?"

---

## 5. Root-cause candidates (priority order)

For "pin always reads 0 with pull-up enabled":

1. **Button is shorting GPIO to GND permanently.**
   A 4-leg tactile button wired to two pins on the *same side* (always-connected pair)
   acts as a permanent short → always 0. This exactly matches the symptom.
2. **Internal pull-up is broken.**
   wiringPi's `pullUpDnControl(PUD_UP)` / `gpio mode up` is unreliable on modern Pi OS
   (Bookworm) and **does not work at all on Pi 5** (different RP1 GPIO controller).
   A floating input on the Pi commonly reads LOW (0).
3. (Lower) Pin conflict — BTN1=GPIO14 is UART TXD if the serial console is enabled.

---

## 6. The decisive test (not yet done)

**Disconnect the button completely so the GPIO is bare**, then:

```bash
sudo gpio -g mode 14 up
gpio -g read 14
```

Interpretation:

- **Bare pin reads `1`** → the button is shorting GPIO to GND (same-side tactile pins /
  wrong terminal / NC instead of NO). Fix the button wiring — **no resistor needed.**
  For a 4-leg tactile button: wire GPIO to one corner and GND to the **diagonally opposite**
  corner, not two pins on the same side.
- **Bare pin still reads `0`** → internal pull-up is broken. Fix with a hardware pull-up
  resistor (section 7) or by fixing the pull-up mechanism.

---

## 7. The two fix paths (once the bare-pin result is known)

### Path A — button is shorted (bare pin reads 1)
Rewire the tactile button to opposite/diagonal corners. For a momentary switch: one
switch terminal → GPIO, the other → GND. Ensure it's the NO (normally-open) pair.

### Path B — internal pull-up broken (bare pin reads 0)

**Recommended fix — external 10kΩ pull-up resistor AT THE PI HEADER** (not at the button).
3.3V is always on the Pi header (pins 1 and 17). The button's 2-wire cable stays unchanged:

```
Pi header (all at the Pi):
  3.3V pin (1 or 17) ──[10kΩ]── GPIO pin ── wire out to button ── GND wire
```

- Button open → GPIO pulled to 3.3V through 10k → reads 1.
- Button pressed → GPIO connected to GND → reads 0 (~0.33 mA through resistor, safe).
- Works on every Pi/OS. The firmware's `PUD_UP` line becomes harmless redundancy.

**Alternative — fix the internal pull-up in firmware.** This depends on the Pi model, so
first collect (section 8). If wiringPi's pull-up is confirmed broken, options are to switch
the firmware off wiringPi (e.g. libgpiod/pigpio) or set pull via native tools.

---

## 8. Information still needed from the user

Paste these from the Pi:

```bash
cat /proc/device-tree/model                          # which Raspberry Pi
cat /etc/os-release                                  # OS version
pinctrl get 14 2>/dev/null || raspi-gpio get 14      # real pin pull state (look for pull=UP)
```

And the result of the bare-pin test (section 6).

---

## 9. Other pending work (deferred until buttons are fixed)

- **Click-outside-to-unselect** in the dashboard: when a product card is selected and the
  user clicks somewhere outside the card, unselect it (or add an explicit unselect function).
  This is in `cashier_dashboard/public/index.html` (single-file UI). Not started yet.

---

## 10. Key files

- `coin_slot/src/pump_control.cpp` — button scan, debounce, LED/pump state machine (button changes at lines 207 & 241).
- `coin_slot/src/hardware_config.cpp` + `coin_slot/includes/hardware_config.h` — pin map, `PUMP_TRIGGER_*`, `TOTAL_SLOTS`.
- `coin_slot/includes/app_state.h` — `serverPort = 8080`.
- `coin_slot/Makefile` — Windows→mock/`main.exe`; Linux→real wiringPi/`main`; `make run` target.
- `coin_slot/vendo.service` — systemd unit (deploy path `/home/dgsi/Desktop/dispenser/coin_slot/main`).
- `CONFIG/config.env.sample` — template (no `config.env` exists yet).
- `cashier_dashboard/server.js` — TCP proxy to firmware, SSE broadcaster.
- `cashier_dashboard/public/index.html` — dashboard UI (single file).
