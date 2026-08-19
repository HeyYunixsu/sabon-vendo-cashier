// test_buttons.cpp — standalone button tester for Sabon Express coin_slot
//
// Reads all 5 buttons (BCM GPIO, active-low: button wired GPIO -> GND) and
// prints live press/release events. Completely independent of the dispense
// state machine, so it isolates the button + wiring + pull-up from the app.
//
// Build (on the Pi):
//   g++ -o test_buttons test_buttons.cpp -lwiringPi
//
// Run (pull-up config needs root):
//   sudo ./test_buttons
//
// Expected HEALTHY output:
//   - All 5 buttons print "OPEN (1)" when NOT touched.
//   - Each press prints ">>> PRESSED" and each release "<<< RELEASED".
//
// If a button prints "LOW (0)" while NOT pressed, the signal is stuck low:
//   -> the button is shorting GPIO to GND (tactile same-side pins), OR
//   -> the internal pull-up is broken (add a 10k resistor from GPIO to 3.3V).

#include <wiringPi.h>
#include <cstdio>

// BCM pin numbers — MUST match coin_slot/src/hardware_config.cpp
static const int BTN_PINS[5] = {14, 24, 25, 10, 13};   // BTN1 .. BTN5
static const int NUM_BTNS = 5;

int main() {
    if (wiringPiSetupGpio() == -1) {
        printf("FATAL: wiringPiSetupGpio() failed. Are you running with sudo?\n");
        return 1;
    }

    // Same setup as the firmware: INPUT + internal pull-up (active-low).
    for (int i = 0; i < NUM_BTNS; i++) {
        pinMode(BTN_PINS[i], INPUT);
        pullUpDnControl(BTN_PINS[i], PUD_UP);
    }

    printf("Sabon Express — button test (BCM GPIO). Ctrl+C to quit.\n\n");

    // Initial state dump: this is the key diagnostic line.
    printf("Initial state (NOT pressing anything):\n");
    int prev[NUM_BTNS];
    for (int i = 0; i < NUM_BTNS; i++) {
        prev[i] = digitalRead(BTN_PINS[i]);
        const char *label = (prev[i] == LOW) ? "LOW (0)  <-- STUCK" : "OPEN (1) OK";
        printf("  BTN%d  GPIO%-2d  %s\n", i + 1, BTN_PINS[i], label);
    }

    printf("\n");
    printf("Healthy = every button shows OPEN (1) above.\n");
    printf("If any shows LOW (0) while untouched, that button's signal is stuck low.\n\n");
    printf("Now press each button and watch for events:\n\n");

    // Edge-detect loop: print only when a button changes state.
    for (;;) {
        for (int i = 0; i < NUM_BTNS; i++) {
            int cur = digitalRead(BTN_PINS[i]);
            if (cur != prev[i]) {
                if (cur == LOW)
                    printf("  BTN%d (GPIO%d)  >>> PRESSED\n", i + 1, BTN_PINS[i]);
                else
                    printf("  BTN%d (GPIO%d)  <<< RELEASED\n", i + 1, BTN_PINS[i]);
                prev[i] = cur;
            }
        }
        delay(10);   // 10 ms poll
    }

    return 0;
}
