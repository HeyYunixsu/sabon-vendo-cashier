// ---------------------------------------------------------------------------
// coin_acceptor.ino
// Sabon Express Dispenser — Arduino Coin Acceptor Firmware
//
// Pulse-to-coin mapping (HX-616 / CH-926):
//   2 pulses → ₱5
//   4 pulses → ₱10
//   8 pulses → ₱20
//
// Serial output (one line per coin):
//   " Inserted Coins:5.0"
//   " Inserted Coins:10.0"
//   " Inserted Coins:20.0"
//
// ---------------------------------------------------------------------------
// WHAT CHANGED AND WHY (read this before touching the constants below)
// ---------------------------------------------------------------------------
// Symptom from the field log: almost every coin attempt ended as
// "Pulses: 1  Rejected: 1" (or 2), and NO " Inserted Coins:" line was ever
// printed. That means real coins were never being credited — every pulse
// train was being torn apart by the timing filter.
//
// THOUGHT: the original PULSE_MIN_MS/PULSE_MAX_MS window (100–140ms) was
// based on a *textbook* HX-616 pulse rate. If this physical unit's actual
// pulse spacing falls outside that narrow 40ms window even slightly, the
// second pulse of a real coin gets dumped into the "else" (rejected)
// branch instead of being counted — which is exactly the "Pulses:1
// Rejected:1" pattern we saw. A single mis-tuned window can make the
// acceptor blind to every coin while looking like it's "working" (still
// printing debug lines, just never crediting anything).
//
// FIX, part 1 — added a raw pulse logger (RAWPULSE_LOG). This buffers the
// raw interval + classification of every single pulse and prints it from
// loop() (never call Serial.print() inside an ISR — Serial itself depends
// on interrupts, so doing so risks corrupting/hanging the acceptor). Run
// with this on, drop a few real coins of each denomination, and read the
// actual intervals back. That tells you the true PULSE_MIN_MS/MAX_MS to
// use for this specific unit instead of guessing.
//
// FIX, part 2 — widened the default window (60–300ms) and pushed
// COIN_DONE_MS up to 400ms so it stays comfortably above the new
// PULSE_MAX_MS (otherwise a slightly-slow-but-real pulse could trip the
// "new coin" branch instead of "valid pulse", fragmenting one coin into
// multiple false "coins"). These are *starting* values, not finals —
// tighten them once you have real RAWPULSE_LOG numbers, so genuine noise
// keeps getting filtered out.
//
// FIX, part 3 — confirmed (not changed): lastImpulsMs is intentionally
// NOT updated when a pulse is rejected. If it were updated, a single
// noise blip would become the new timing reference and the next *real*
// pulse would be measured against garbage instead of the last confirmed
// pulse, fragmenting the coin further. Leaving it alone means one stray
// blip can't derail the rest of the train. Documented here so nobody
// "fixes" this by accident later.
//
// HOST-SIDE NOTE: your Python/host script should only attempt a float
// conversion on lines that match " Inserted Coins:<number>". Every other
// line ([DEBUG], [RAWPULSE], "Coin acceptor ready.") should just be
// logged/ignored, not parsed as a number.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const byte          interruptPin     = 2;
const int           BAUD_RATE        = 9600;

const unsigned long PULSE_MIN_MS     = 60;
const unsigned long PULSE_MAX_MS     = 300;
const unsigned long COIN_DONE_MS     = 400;
const unsigned long NOISE_TIMEOUT_MS = 10000;
const bool          DEBUG_MODE       = true;
const bool          RAWPULSE_LOG     = true;

// ---------------------------------------------------------------------------
// ISR state
// ---------------------------------------------------------------------------
volatile unsigned long lastImpulsMs  = 0;
volatile int           impulsCount   = 0;
volatile int           rejectedCount = 0;

struct PulseLogEntry {
  unsigned long intervalMs;
  char          tag;
};
const int               RAWLOG_SIZE  = 16;
volatile PulseLogEntry  rawLog[RAWLOG_SIZE];
volatile int            rawLogCount  = 0;

// ---------------------------------------------------------------------------
// Main loop state
// ---------------------------------------------------------------------------
int           processedCount     = 0;
int           noise_buffer_count = 0;
unsigned long noise_start_time   = 0;

// ---------------------------------------------------------------------------
// ISR
// ---------------------------------------------------------------------------
void incomingImpuls() {
  unsigned long now      = millis();
  unsigned long interval = now - lastImpulsMs;

  bool isNewCoin       = (interval >= COIN_DONE_MS);
  bool isValidInterval = (interval >= PULSE_MIN_MS && interval <= PULSE_MAX_MS);

  if (RAWPULSE_LOG && rawLogCount < RAWLOG_SIZE) {
    rawLog[rawLogCount].intervalMs = interval;
    rawLog[rawLogCount].tag        = isNewCoin ? 'N' : (isValidInterval ? 'V' : 'R');
    rawLogCount++;
  }

  if (isNewCoin) {
    impulsCount    = 1;
    processedCount = 0;
    lastImpulsMs   = now;
  } else if (isValidInterval) {
    impulsCount++;
    lastImpulsMs = now;
  } else {
    rejectedCount++;
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(BAUD_RATE);
  pinMode(interruptPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(interruptPin), incomingImpuls, FALLING);
  lastImpulsMs = millis();
  Serial.println("Coin acceptor ready.");
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

  // Drain raw pulse log
  if (RAWPULSE_LOG && rawLogCount > 0) {
    noInterrupts();
    int countSnapshot = rawLogCount;
    PulseLogEntry localCopy[RAWLOG_SIZE];
    for (int i = 0; i < countSnapshot; i++) {
      localCopy[i].intervalMs = rawLog[i].intervalMs;
      localCopy[i].tag        = rawLog[i].tag;
    }
    rawLogCount = 0;
    interrupts();

    for (int i = 0; i < countSnapshot; i++) {
      Serial.print("[RAWPULSE] interval=");
      Serial.print(localCopy[i].intervalMs);
      Serial.print("ms tag=");
      Serial.println(localCopy[i].tag);
    }
  }

  // Coin finalization
  if (impulsCount > processedCount) {
    unsigned long gapMs = now - lastImpulsMs;

    if (gapMs >= COIN_DONE_MS) {
      int pulses = impulsCount - processedCount;

      if (DEBUG_MODE) {
        Serial.print("[DEBUG] Coin done. Pulses: ");
        Serial.print(pulses);
        Serial.print("  Rejected: ");
        Serial.println(rejectedCount);
        rejectedCount = 0;
      }

      if (pulses >= 8) {
        int coins    = pulses / 8;
        int leftover = pulses % 8;
        for (int c = 0; c < coins; c++) {
          Serial.print(" Inserted Coins:");
          Serial.println(20.0, 1);
        }
        processedCount = impulsCount - leftover;
        if (leftover > 0 && DEBUG_MODE) {
          Serial.print("[DEBUG] Leftover after 20: ");
          Serial.println(leftover);
        }
      } else if (pulses >= 4) {
        Serial.print(" Inserted Coins:");
        Serial.println(10.0, 1);
        processedCount = impulsCount - (pulses - 4);
        if ((pulses - 4) > 0 && DEBUG_MODE) {
          Serial.print("[DEBUG] Leftover after 10: ");
          Serial.println(pulses - 4);
        }
      } else if (pulses >= 2) {
        Serial.print(" Inserted Coins:");
        Serial.println(5.0, 1);
        processedCount = impulsCount - (pulses - 2);
        if ((pulses - 2) > 0 && DEBUG_MODE) {
          Serial.print("[DEBUG] Leftover after 5: ");
          Serial.println(pulses - 2);
        }
      } else {
        if (DEBUG_MODE) Serial.println("[DEBUG] Single pulse discarded as noise.");
        processedCount = impulsCount;
      }

      if (processedCount == impulsCount) {
        impulsCount    = 0;
        processedCount = 0;
      }
    }
  }

  // Noise timeout
  int leftover = impulsCount - processedCount;
  if (leftover == 1) {
    if (noise_buffer_count == 0) {
      noise_buffer_count = 1;
      noise_start_time   = now;
    } else if (now - noise_start_time >= NOISE_TIMEOUT_MS) {
      if (DEBUG_MODE) Serial.println("[DEBUG] Noise timeout — discarding leftover pulse.");
      impulsCount        = processedCount;
      noise_buffer_count = 0;
    }
  } else {
    noise_buffer_count = 0;
  }

  delay(10);
}
