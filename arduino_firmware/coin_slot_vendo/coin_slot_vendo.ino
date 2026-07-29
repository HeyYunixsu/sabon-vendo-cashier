
// variable use to measuer the intervals inbetween impulses
int i = 0;
// Number of impulses detected
int impulsCount = 0;
// Stores the number of leftover pulses (unprocessed noise)
int noise_buffer_count = 0; 

// The time (in milliseconds) when the noise was first detected
unsigned long noise_start_time = 0; 
const unsigned long NOISE_TIMEOUT_MS = 10000; // 10 seconds timeout
int previosu_impulsCount = 0;
// Sum of all the  coins inseted
float total_amount = 0;
const byte interruptPin = 2;

volatile unsigned long lastImpulsTime = 0;
const unsigned long debounceDelay_us = 10000;

void incomingImpuls() {
  unsigned long currentImpulsTime = micros();
  if ((currentImpulsTime - lastImpulsTime) > debounceDelay_us) {
    impulsCount = impulsCount + 1;
    i = 0;
    // Serial.print(impulsCount);
    // Serial.print(' ');
    // Serial.println(currentImpulsTime - lastImpulsTime);
    lastImpulsTime = currentImpulsTime;  // Record the time of this VALID pulse
  }
}

void setup() {
  // pinMode(2, INPUT_PULLUP);
  Serial.begin(9600);

  // Interrupt connected  to PIN D2 executing IncomingImpuls function when signal goes from HIGH to LOW
  pinMode(interruptPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(interruptPin), incomingImpuls, FALLING);
}

void loop() {
  i = (i + 1) % 10000;

  // --- 1. Coin Processing Block (Triggered every 300ms) ---
  if (impulsCount > previosu_impulsCount) {

    if (i >= 30) {

      // Step A: Process all full coins (Same as previous solution)
      while (true) {
        int pulses_to_match = impulsCount - previosu_impulsCount;

        if (pulses_to_match >= 8) {
          total_amount += 20.0;
          previosu_impulsCount += 8;
          continue;
        } else if (pulses_to_match >= 4) {
          total_amount += 10.0;
          previosu_impulsCount += 4;
          continue;
        } else if (pulses_to_match >= 2) {
          total_amount += 5.0;
          previosu_impulsCount += 2;
          continue;
        } else {
          break;  // No more full coins (less than 2 pulses left)
        }
      }

      // Step B: Check for Leftover Noise
      int pulses_leftover = impulsCount - previosu_impulsCount;

      if (pulses_leftover > 0) {
        // If there is leftover noise, move it to the buffer and start the timer
        noise_buffer_count = pulses_leftover;
        previosu_impulsCount = impulsCount;  // "Zero out" the processed count
        noise_start_time = millis();         // Start the 10-second timer

      } else {
        // If the count matched perfectly, reset the noise tracker
        noise_buffer_count = 0;
        noise_start_time = 0;
        previosu_impulsCount = 0;
        impulsCount = 0;
      }

      i = 0;  // Reset the 300ms time window
    }
  }

  // --- 2. Noise Buffer Timeout Check (Non-blocking) ---
  if (noise_buffer_count > 0) {
    if (millis() - noise_start_time >= NOISE_TIMEOUT_MS) {

      // If the noise has sat in the buffer for 10 seconds without increasing,
      // we assume it's noise and discard it.
      // Since we already set previosu_impulsCount = impulsCount in Step B,
      // all we need to do is clear the buffer flags.

    //   Serial.print("--- DISCARDING NOISE: ");  // Debug output
    //   Serial.print(noise_buffer_count);
    //   Serial.println(" pulses timed out. ---");

      noise_buffer_count = 0;  // Clear the noise count
      noise_start_time = 0;    // Clear the timer
      previosu_impulsCount = 0;
      impulsCount = 0;
    }
  }

  // --- 3. Output/Display Logic (Remains the same) ---
  if (i == 0 && total_amount > 0) {
    Serial.print(" Inserted Coins:");
    Serial.println(total_amount);
    total_amount = 0;
  }

  delay(10);
}