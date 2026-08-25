#ifndef HARDWARE_CONFIG_H
#define HARDWARE_CONFIG_H

#include <wiringPi.h>
#include <map>
#include <string>

// ------------------------------------------------------------------------------
// Final 6-slot pin map — every slot has independent button + LED + pump GPIOs.
// No shared/multiplexed pins anywhere. BCM numbering.
// ------------------------------------------------------------------------------

extern int BTN1, BTN2, BTN3, BTN4, BTN5, BTN6;
extern int PUMP1, PUMP2, PUMP3, PUMP4, PUMP5, PUMP6;
extern int LED1, LED2, LED3, LED4, LED5, LED6;

extern int PUMP_TRIGGER_HIGH;  // Active-low relay: LOW (0) turns pump ON
extern int PUMP_TRIGGER_LOW;   // HIGH (1) turns pump OFF

struct Product {
    int id;
    int coins;
    double durationSeconds;
};

extern std::map<int, int> pin_pump;
extern std::map<int, int> pin_led;
extern std::map<int, int> pin_button;
extern std::map<int, Product> productMap;

const int TOTAL_SLOTS = 6;

void init_hardware_config(const std::map<std::string, std::string> &config);

#endif
