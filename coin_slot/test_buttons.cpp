// test_buttons.cpp — standalone button tester for Sabon Express coin_slot
//
// Reads all 5 buttons (BCM GPIO, active-high: button wired GPIO -> 3V3) and
// prints live press/release events. Completely independent of the dispense
// state machine, so it isolates the button + wiring + pull-down from the app.
//
// Build (on the Pi):
//   g++ -o test_buttons test_buttons.cpp -lwiringPi
//
// Run (pull-down config needs root):
//   sudo ./test_buttons
//
// Expected HEALTHY output:
//   - All 5 buttons print "LOW (0)" when NOT touched.
//   - Each press prints ">>> PRESSED" and each release "<<< RELEASED".
//
// If a button prints "HIGH (1)" while NOT pressed, the signal is stuck high:
//   -> the button is shorting GPIO to 3V3, OR the pull-down is broken.

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

    // Same setup as the firmware: INPUT + internal pull-down (active-high).
    for (int i = 0; i < NUM_BTNS; i++) {
        pinMode(BTN_PINS[i], INPUT);
        pullUpDnControl(BTN_PINS[i], PUD_DOWN);
    }

    printf("Sabon Express — button test (BCM GPIO, active-high). Ctrl+C to quit.\n\n");

    // Initial state dump: the key diagnostic line.
    printf("Initial state (NOT pressing anything):\n");
    int prev[NUM_BTNS];
    for (int i = 0; i < NUM_BTNS; i++) {
        prev[i] = digitalRead(BTN_PINS[i]);
        const char *label = (prev[i] == HIGH) ? "HIGH (1)  <-- STUCK" : "LOW (0) OK";
        printf("  BTN%d  GPIO%-2d  %s\n", i + 1, BTN_PINS[i], label);
    }

    printf("\n");
    printf("Healthy = every button shows LOW (0) above.\n");
    printf("If any shows HIGH (1) while untouched, that button's signal is stuck high.\n\n");
    printf("Now press each button and watch for events:\n\n");

    // Edge-detect loop: print only when a button changes state.
    for (;;) {
        for (int i = 0; i < NUM_BTNS; i++) {
            int cur = digitalRead(BTN_PINS[i]);
            if (cur != prev[i]) {
                if (cur == HIGH)
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
