#include "hardware_config.h"
#include "utils.h"
#include <cstdio>
#include <string>

// ------------------------------------------------------------------------------
// Final 6-slot pin map (BCM numbering) — all independent, no shared pins
// ------------------------------------------------------------------------------

int BTN1 = 14, BTN2 = 24, BTN3 = 25, BTN4 = 10, BTN5 = 13, BTN6 = 23;
int PUMP1 = 15, PUMP2 = 16, PUMP3 =  6, PUMP4 = 17, PUMP5 = 18, PUMP6 = 12;
int LED1 =  5, LED2 = 27, LED3 =  4, LED4 = 22, LED5 = 19, LED6 =  7;

int PUMP_TRIGGER_HIGH = 0;
int PUMP_TRIGGER_LOW  = 1;

std::map<int, int> pin_pump {
    {1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}, {5, PUMP5}, {6, PUMP6}
};
std::map<int, int> pin_led {
    {1, LED1}, {2, LED2}, {3, LED3}, {4, LED4}, {5, LED5}, {6, LED6}
};
std::map<int, int> pin_button {
    {1, BTN1}, {2, BTN2}, {3, BTN3}, {4, BTN4}, {5, BTN5}, {6, BTN6}
};

std::map<int, Product> productMap {
    {1, {1, 5, 2.777777777777778}},
    {2, {2, 5, 1.363636363636364}},
    {3, {3, 5, 1.25}},
    {4, {4, 5, 2.0}},
    {5, {5, 5, 2.0}},
    {6, {6, 5, 2.0}},
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
    load_int("BTN4", BTN4); load_int("BTN5", BTN5); load_int("BTN6", BTN6);
    load_int("PUMP1", PUMP1); load_int("PUMP2", PUMP2); load_int("PUMP3", PUMP3);
    load_int("PUMP4", PUMP4); load_int("PUMP5", PUMP5); load_int("PUMP6", PUMP6);
    load_int("LED1", LED1); load_int("LED2", LED2); load_int("LED3", LED3);
    load_int("LED4", LED4); load_int("LED5", LED5); load_int("LED6", LED6);
    load_int("PUMP_TRIGGER_HIGH", PUMP_TRIGGER_HIGH);
    load_int("PUMP_TRIGGER_LOW",  PUMP_TRIGGER_LOW);

    pin_pump   = {{1, PUMP1}, {2, PUMP2}, {3, PUMP3}, {4, PUMP4}, {5, PUMP5}, {6, PUMP6}};
    pin_led    = {{1, LED1},  {2, LED2},  {3, LED3},  {4, LED4},  {5, LED5},  {6, LED6}};
    pin_button = {{1, BTN1},  {2, BTN2},  {3, BTN3},  {4, BTN4},  {5, BTN5},  {6, BTN6}};

    static const struct { int coins; double seconds; } defaults[TOTAL_SLOTS + 1] = {
        {},
        {5, 2.777777777777778},
        {5, 1.363636363636364},
        {5, 1.25},
        {5, 2.0},
        {5, 2.0},
        {5, 2.0},
    };

    for (int i = 1; i <= TOTAL_SLOTS; i++) {
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
