#include "test_framework.h"
#include "hardware_config.h"

// These tests pin down the BCM GPIO numbers assigned to each pump and button.
// If a pin is rewired on the physical board, exactly one of these tests will
// fail, making it obvious which mapping needs updating.

// ----------------------------------------------------------- pump pins ---

void test_pump1_pin_is_15() {
    CHECK_EQ(pin_pump[1], 15);
    CHECK_EQ(pin_pump[1], PUMP1);
}

void test_pump2_pin_is_16() {
    CHECK_EQ(pin_pump[2], 16);
    CHECK_EQ(pin_pump[2], PUMP2);
}

void test_pump3_pin_is_6() {
    CHECK_EQ(pin_pump[3], 6);
    CHECK_EQ(pin_pump[3], PUMP3);
}

void test_pump4_pin_is_17() {
    CHECK_EQ(pin_pump[4], 17);
    CHECK_EQ(pin_pump[4], PUMP4);
}

void test_pin_pump_map_has_exactly_4_entries() {
    CHECK_EQ((int)pin_pump.size(), 4);
}

// -------------------------------------------------- relay polarity ---
// The relay board is active-low: sending LOW turns the pump ON.

void test_pump_trigger_high_is_LOW() {
    CHECK_EQ(PUMP_TRIGGER_HIGH, LOW);
}

void test_pump_trigger_low_is_HIGH() {
    CHECK_EQ(PUMP_TRIGGER_LOW, HIGH);
}

// --------------------------------------------------- button / stop pin ---

void test_stop_pin_is_27() {
    CHECK_EQ(PIN_STOP, 27);
}

void test_btn1_pin_is_14() { CHECK_EQ(BTN1, 14); }
void test_btn2_pin_is_24() { CHECK_EQ(BTN2, 24); }
void test_btn3_pin_is_25() { CHECK_EQ(BTN3, 25); }
void test_btn4_pin_is_10() { CHECK_EQ(BTN4, 10); }

// ---------------------------------------------------------- entry point ---

void run_hardware_tests() {
    SUITE("hardware_config");
    RUN_TEST(test_pump1_pin_is_15);
    RUN_TEST(test_pump2_pin_is_16);
    RUN_TEST(test_pump3_pin_is_6);
    RUN_TEST(test_pump4_pin_is_17);
    RUN_TEST(test_pin_pump_map_has_exactly_4_entries);
    RUN_TEST(test_pump_trigger_high_is_LOW);
    RUN_TEST(test_pump_trigger_low_is_HIGH);
    RUN_TEST(test_stop_pin_is_27);
    RUN_TEST(test_btn1_pin_is_14);
    RUN_TEST(test_btn2_pin_is_24);
    RUN_TEST(test_btn3_pin_is_25);
    RUN_TEST(test_btn4_pin_is_10);
}
