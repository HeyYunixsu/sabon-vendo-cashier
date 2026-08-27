#include "wiringPi.h"
#include <iostream>
#include <thread>
#include <chrono>

int wiringPiSetup(void) { std::cout << "[MOCK] wiringPiSetup called" << std::endl; return 0; }
int wiringPiSetupGpio(void) { std::cout << "[MOCK] wiringPiSetupGpio called" << std::endl; return 0; }
int wiringPiSetupPhys(void) { std::cout << "[MOCK] wiringPiSetupPhys called" << std::endl; return 0; }
int wiringPiSetupSys(void) { std::cout << "[MOCK] wiringPiSetupSys called" << std::endl; return 0; }
int wiringPiSetupPinType(int pinType) { std::cout << "[MOCK] wiringPiSetupPinType(" << pinType << ") called" << std::endl; return 0; }

void pinMode(int pin, int mode) { std::cout << "[MOCK] pinMode(pin=" << pin << ", mode=" << mode << ") called" << std::endl; }
void pullUpDnControl(int pin, int pud) { std::cout << "[MOCK] pullUpDnControl(pin=" << pin << ", pud=" << pud << ") called" << std::endl; }
void digitalWrite(int pin, int value) { /* std::cout << "[MOCK] digitalWrite(pin=" << pin << ", value=" << value << ")" << std::endl; */ }
int digitalRead(int pin) { return LOW; }

void delay(unsigned int howLong) { std::this_thread::sleep_for(std::chrono::milliseconds(howLong)); }
void delayMicroseconds(unsigned int howLong) { std::this_thread::sleep_for(std::chrono::microseconds(howLong)); }

int wiringPiISR(int pin, int mode, void (*function)(void)) {
    std::cout << "[MOCK] wiringPiISR(pin=" << pin << ", mode=" << mode << ") registered" << std::endl;
    return 0;
}

// wiringPiI2C Mocks
#include "wiringPiI2C.h"
int wiringPiI2CSetup(int devId) { std::cout << "[MOCK] wiringPiI2CSetup(devId=" << devId << ")" << std::endl; return 100; }
int wiringPiI2CRead(int fd) { return 0; }
int wiringPiI2CReadReg8(int fd, int reg) { return 0; }
int wiringPiI2CReadReg16(int fd, int reg) { return 0; }
int wiringPiI2CWrite(int fd, int data) { return 0; }
int wiringPiI2CWriteReg8(int fd, int reg, int data) { return 0; }
int wiringPiI2CWriteReg16(int fd, int reg, int data) { return 0; }
