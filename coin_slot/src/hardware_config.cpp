#include "hardware_config.h"
#include "utils.h"
#include <cstdio>
#include <string>

// ------------------------------------------------------------------------------
// Pin defaults (BCM numbering)
// ------------------------------------------------------------------------------

// Buttons (shared with LEDs — same GPIO serves both)
int BTN1 = 14, BTN2 = 24, BTN3 = 25, BTN4 = 10;
// Pumps
int PUMP1 = 15, PUMP2 = 16, PUMP3 =  6, PUMP4 = 17;
// LEDs: slots 1-2 have separate GPIOs, slots 3-4 share button pins
int LED1 =  5, LED2 =  4, LED3 = 25, LED4 = 10;
int PIN_STOP = 27;
int PUMP_TRIGGER_HIGH = 0;  // LOW  — active-low relay: 0 turns pump ON
int PUMP_TRIGGER_LOW  = 1;  // HIGH — off

std::map<int, int> pin_pump {
    {1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}
};

std::map<int, int> pin_led {
    {1, LED1}, {2, LED2}, {3, LED3}, {4, LED4}
};

std::map<int, int> pin_button {
    {1, BTN1}, {2, BTN2}, {3, BTN3}, {4, BTN4}
};

std::map<int, Product> productMap {
    {1, {1, 5, 2.777777777777778}},
    {2, {2, 5, 1.363636363636364}},
    {3, {3, 5, 1.25}},
    {4, {4, 5, 2.0}},
};

// ------------------------------------------------------------------------------
// Runtime initialisation from config.env
// ------------------------------------------------------------------------------

static bool parse_calibrate(const std::string &val, int &coins, double &secs)
{
    return std::sscanf(val.c_str(), "(%d, %lf)", &coins, &secs) == 2;
}

void init_hardware_config(const std::map<std::string, std::string> &config)
{
    auto load_int = [&](const std::string &key, int &dest) {
        auto it = config.find(key);
        if (it != config.end() && !it->second.empty())
            dest = std::stoi(it->second);
    };

    load_int("BTN1", BTN1); load_int("BTN2", BTN2); load_int("BTN3", BTN3);
    load_int("BTN4", BTN4);
    load_int("PUMP1", PUMP1); load_int("PUMP2", PUMP2); load_int("PUMP3", PUMP3);
    load_int("PUMP4", PUMP4);
    load_int("LED1", LED1); load_int("LED2", LED2); load_int("LED3", LED3);
    load_int("LED4", LED4);
    load_int("PIN_STOP",          PIN_STOP);
    load_int("PUMP_TRIGGER_HIGH", PUMP_TRIGGER_HIGH);
    load_int("PUMP_TRIGGER_LOW",  PUMP_TRIGGER_LOW);

    pin_pump   = {{1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}};
    pin_led    = {{1, LED1},  {2, LED2},  {3, LED3},  {4, LED4}};
    pin_button = {{1, BTN1},  {2, BTN2},  {3, BTN3},  {4, BTN4}};

    static const struct { int coins; double seconds; } defaults[5] = {
        {},
        {5, 2.777777777777778},
        {5, 1.363636363636364},
        {5, 1.25},
        {5, 2.0},
    };

    for (int i = 1; i <= 4; i++) {
        int    coins = defaults[i].coins;
        double secs  = defaults[i].seconds;
        std::string key = "calibrateProduct" + std::to_string(i);
        auto it = config.find(key);
        if (it != config.end()) {
            int c; double s;
            if (parse_calibrate(it->second, c, s)) { coins = c; secs = s; }
            else log_error("hardware", "Could not parse " + key + ": " + it->second);
        }
        productMap[i] = {i, coins, secs};
    }
}
