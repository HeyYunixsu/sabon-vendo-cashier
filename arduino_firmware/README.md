# arduino_firmware

Arduino sketches for Sabon Express hardware modules.

| Sketch | Status | Hardware | Purpose |
|--------|--------|----------|---------|
| `coin_slot_vendo/` | **Production (deployed)** | CH-926 / HX-616 coin acceptor | Multi-denomination pulse counting → serial output to Pi |
| `coin_acceptor/` | Needs hardware testing | CH-926 / HX-616 coin acceptor | Multi-denomination pulse counting → serial output to Pi |

---

## Comparison: coin_slot_vendo vs coin_acceptor

Both sketches now implement the same multi-denomination logic (2/4/8 pulses → ₱5/₱10/₱20, with a 10s noise buffer for orphaned pulses) and emit the same serial format. They differ in timing strategy and code structure.

### coin_slot_vendo — Production Firmware

**How it works:**
The coin acceptor sends a burst of pulses per coin denomination. A debounced ISR (`micros()`-based, 10 ms guard) counts pulses; the main loop runs a `delay(10)` tick counter and re-evaluates every ~300 ticks (~300 ms), matching the accumulated burst size to a peso amount:

| Pulses in burst | Amount credited |
|----------------|----------------|
| 8 | ₱20 |
| 4 | ₱10 |
| 2 | ₱5 |
| 1 (leftover) | Noise — held in buffer 10 s then discarded |

Serial output format (one line per insertion event):
```
 Inserted Coins:20.0
```

**Pros:**
- Handles ₱5, ₱10, ₱20 denominations in one firmware
- Has a noise buffer: orphaned single pulses are held for 10 seconds before being discarded, preventing phantom credits
- Battle-tested in production

**Cons / known issues:**
- `impulsCount` is modified inside the ISR but is **not declared `volatile`** — technically a race condition on AVR (2-byte int read is not atomic)
- No `noInterrupts()`/`interrupts()` guard when reading `impulsCount` in `loop()` — the ISR could fire between the two bytes being read
- Uses `delay(10)` + a loop counter for timing, which makes the ~300 ms window slightly imprecise and drift under load
- No configuration constants — denomination table and debounce values are hardcoded
- No startup message on Serial
- Commented-out debug lines and a typo (`previosu_impulsCount`) indicate it was developed iteratively without cleanup

---

### coin_acceptor — Timestamp-Gap Variant (needs hardware testing)

**How it works:**
The ISR (`incomingImpuls`) timestamps every pulse with `millis()`. A gap ≥ `COIN_DONE_MS` (350 ms) after the last pulse always starts a new coin window; pulses arriving 100–140 ms apart (the HX-616's measured inter-pulse rate) are counted into the current window, anything else is rejected as noise. The main loop finalises a coin once that gap is observed, matching the pulse total to a denomination — same 2/4/8 → ₱5/₱10/₱20 mapping as `coin_slot_vendo`, plus the same 10 s orphan-pulse noise buffer.

Serial output format (one line per coin):
```
 Inserted Coins:20.0
```

**Pros:**
- Multi-denomination, same mapping and noise handling as the production sketch
- Pure timestamp/gap-based timing instead of a `delay()` tick counter — no drift under load
- Named, documented constants (`PULSE_MIN_MS`, `PULSE_MAX_MS`, `COIN_DONE_MS`, `NOISE_TIMEOUT_MS`) instead of magic numbers
- Rejects out-of-band pulse intervals explicitly (`rejectedCount`) rather than silently counting them
- `DEBUG_MODE` flag prints per-coin diagnostics (pulse count, rejected count, leftover) without needing a recompile to remove — just flip to `false`
- Prints a startup message (`Coin acceptor ready.`)

**Cons / known issues:**
- Same ISR-safety caveat as `coin_slot_vendo`: `impulsCount`/`lastImpulsMs` are read in `loop()` without a `noInterrupts()`/`interrupts()` guard, so a multi-byte read could theoretically tear if the ISR fires mid-read (low risk in practice, but not eliminated)
- **Not yet verified against real hardware** — confirm the 100–140 ms pulse-interval window actually matches your specific HX-616/CH-926 unit before relying on it; out-of-spec modules may need `PULSE_MIN_MS`/`PULSE_MAX_MS` retuned

---

### Which to use

| Question | Answer |
|----------|--------|
| Which is safe to deploy right now? | `coin_slot_vendo` — it is already running in production |
| Which should replace it eventually? | `coin_acceptor` once it's been validated on real hardware — it has cleaner timing and diagnostics |
| Can `coin_acceptor` be used as-is? | Yes for the same CH-926/HX-616 2/4/8-pulse hardware as production, but test it on the bench first |

---

## coin_slot_vendo (Production)

### Hardware wiring

```
Coin Acceptor Module          Arduino Uno / Nano
─────────────────────         ──────────────────
VCC  ──────────────────────►  External 12V supply (shared GND with Arduino)
GND  ──────────────────────►  GND
COIN / SIG  ────────────────►  Pin 2   (INT0, interrupt-capable)
```

> **Power note:** CH-926 and HX-616 modules are rated for 12V and will not reliably accept coins at 5V. Power VCC from an external 12V supply; the signal pin operates at 5V logic regardless of supply voltage.

### Pulse mapping (hardcoded in sketch)

The CH-926 / HX-616 is programmed to pulse the signal line N times per coin:

| Coin | Pulses | Credited |
|------|--------|----------|
| ₱5  | 2 | ₱5 |
| ₱10 | 4 | ₱10 |
| ₱20 | 8 | ₱20 |

> If your acceptor is programmed differently, edit the `if (pulses_to_match >= N)` blocks in `coin_slot_vendo.ino`.

### How it integrates with the Pi

```
Coin inserted
    → coin acceptor pulses COIN pin N times (2 / 4 / 8)
    → Arduino ISR counts pulses (debounce: 10 ms via micros())
    → after ~300 ms window with no new pulses, main loop processes burst
    → maps pulse count to peso amount
    → prints " Inserted Coins:20.0" on USB serial
    → coin_counter.py reads line, splits on ':', parses float (20.0)
    → sends "COIN,20.0" to coin_slot TCP server (127.0.0.1:8080)
    → coin_slot adds 20 to AppState.coinCredit
```

### How to upload

1. **Install Arduino IDE** (https://www.arduino.cc/en/software)
2. Open `coin_slot_vendo/coin_slot_vendo.ino`
3. **Tools → Board → Arduino Uno** (or Nano with correct processor)
4. **Tools → Port → COMx** (Windows) or `/dev/ttyUSBx` / `/dev/ttyACM0` (Linux)
5. Click **Upload**

After upload, open **Serial Monitor** at **9600 baud**, insert a ₱5 coin — you should see:
```
 Inserted Coins:5.0
```

---

## coin_acceptor (Timestamp-Gap Variant — needs hardware testing)

### What it does

Times every pulse with `millis()`, groups pulses into a coin window (new window starts after a ≥350 ms gap), and matches the pulse total in that window to a ₱5/₱10/₱20 denomination — same hardware and mapping as `coin_slot_vendo`.

Serial output format:
```
Coin acceptor ready.
 Inserted Coins:5.0
```

### How to configure

Open `coin_acceptor/coin_acceptor.ino` and edit the constants block at the top:

| Constant | Default | Description |
|----------|---------|-------------|
| `interruptPin` | `2` | Arduino pin connected to the coin acceptor signal (INT0/INT1 — pin 2 or 3 on Uno/Nano) |
| `BAUD_RATE` | `9600` | Must match `BAUD_RATE` in `CONFIG/config.env` |
| `PULSE_MIN_MS` | `100` | Minimum valid interval between pulses within a coin burst |
| `PULSE_MAX_MS` | `140` | Maximum valid interval between pulses within a coin burst |
| `COIN_DONE_MS` | `350` | Gap after the last pulse that marks a coin as finished |
| `NOISE_TIMEOUT_MS` | `10000` | How long a leftover single pulse is held before being discarded as noise |
| `DEBUG_MODE` | `true` | Set to `false` to silence per-coin debug logging once tuning is done |

### Hardware wiring

Same as `coin_slot_vendo` — Pin 2 (INT0), `INPUT_PULLUP`.

### How to upload

Same steps as `coin_slot_vendo` — open `coin_acceptor/coin_acceptor.ino` instead.

---

## Finding the serial port on the Pi

After plugging in the Arduino via USB:
```bash
ls /dev/ttyACM* /dev/ttyUSB*
# or watch dmesg
dmesg | tail -20
```

Set the result in `CONFIG/config.env`:
```
SERIAL_PORT = /dev/ttyACM0
```
