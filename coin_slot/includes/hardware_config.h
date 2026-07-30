#ifndef HARDWARE_CONFIG_H
#define HARDWARE_CONFIG_H

#include <wiringPi.h>
#include <map>
#include <string>

// ------------------------------------------------------------------------------
// Pin Variables (BCM numbering)
// Defaults listed below. Overridable from config.env.
// ------------------------------------------------------------------------------

extern int BTN1, BTN2, BTN3, BTN4;
extern int PUMP1, PUMP2, PUMP3, PUMP4;
extern int LED1, LED2, LED3, LED4;
extern int PIN_STOP;
extern int PUMP_TRIGGER_HIGH;  // Active-low relay: LOW (0) turns pump ON
extern int PUMP_TRIGGER_LOW;   // HIGH (1) turns pump OFF

// ------------------------------------------------------------------------------
// Product Configuration
// ------------------------------------------------------------------------------

struct Product {
    int id;
    int coins;              // Coin cost per dispense cycle
    double durationSeconds; // Seconds the pump runs per dispense cycle
};

// ------------------------------------------------------------------------------
// Shared Hardware-related Variables/Mappings
// ------------------------------------------------------------------------------

extern std::map<int, int> pin_pump;     // slot index → pump BCM pin
extern std::map<int, int> pin_led;      // slot index → LED BCM pin
extern std::map<int, int> pin_button;   // slot index → button BCM pin
extern std::map<int, Product> productMap;

// Per-slot check: true when LED and button share the same GPIO pin
inline bool isSharedPin(int slot) {
    return pin_led.count(slot) && pin_button.count(slot)
        && pin_led[slot] == pin_button[slot];
}

const int TOTAL_SLOTS = 4;  // loop bound for pump_control / socket_server

// Applies hardware overrides from a loaded config.env map.
void init_hardware_config(const std::map<std::string, std::string> &config);

#endif // HARDWARE_CONFIG_H
