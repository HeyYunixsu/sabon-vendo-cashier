#ifndef HARDWARE_CONFIG_H
#define HARDWARE_CONFIG_H

#include <wiringPi.h>
#include <map>
#include <string>

// ------------------------------------------------------------------------------
// Pin Variables (BCM numbering)
// Defaults match original hardware wiring.
// Overridable from config.env — call init_hardware_config() once at startup.
// ------------------------------------------------------------------------------

extern int BTN1, BTN2, BTN3, BTN4;
extern int PUMP1, PUMP2, PUMP3, PUMP4;
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

extern std::map<int, int> pin_pump;
extern std::map<int, Product> productMap;

// Applies hardware overrides from a loaded config.env map to pin variables,
// pin_pump, and productMap. Call once in pump_setup() after loadEnv() and
// before wiringPiSetupGpio().
void init_hardware_config(const std::map<std::string, std::string> &config);

#endif // HARDWARE_CONFIG_H
