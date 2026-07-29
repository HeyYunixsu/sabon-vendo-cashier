#!./env/bin/python

import os
import RPi.GPIO as GPIO
import time
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv
import sys

current_dir = Path(__file__).parent
env_path = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)

# --- RPi GPIO Configuration (BCM Numbering) ---
# All values loaded from CONFIG/config.env; defaults match original wiring.
LED_PIN  = int(os.getenv("LED_PIN",      18))

# Define the BCM pin mode
GPIO.setmode(GPIO.BCM)

# --- Schedule Configuration (24-Hour Format) ---
ON_HOUR  = int(os.getenv("LED_ON_HOUR",  17))  # 5:00 PM
OFF_HOUR = int(os.getenv("LED_OFF_HOUR",  6))  # 6:00 AM

# Relay trigger levels: 0 = GPIO.LOW, 1 = GPIO.HIGH
ON_STATE  = int(os.getenv("LED_ON_STATE",  GPIO.LOW))   # low-level triggered ON
OFF_STATE = int(os.getenv("LED_OFF_STATE", GPIO.HIGH))  # off

def set_pin_state(state):
    """
    Sets the state of the LED pin and prints a corresponding message.
    """
    GPIO.output(LED_PIN, state)
    
    # Determine the status message based on the physical state (ON/OFF)
    if state == ON_STATE:
        status_message = "ON (Output LOW)"
    else:
        status_message = "OFF (Output HIGH)"
        
    print(f"[{datetime.now().strftime('%H:%M:%S')}] LED State Set: {status_message}")


def check_schedule_and_control():
    """
    Checks the current time and sets the GPIO state accordingly.
    """
    current_hour = datetime.now().hour
    
    # Check if the current time falls within the ON period (5 PM to 6 AM)
    # The condition covers two cases:
    # 1. After 5 PM (17:00) and until midnight (e.g., 17, 18, 19... 23)
    # 2. After midnight (00:00) and before 6 AM (e.g., 0, 1, 2... 5)
    if current_hour >= ON_HOUR or current_hour < OFF_HOUR:
        # Time to turn ON the LED (Set pin to LOW)
        new_state = ON_STATE
    else:
        # Time to turn OFF the LED (Set pin to HIGH)
        new_state = OFF_STATE

    # Read the current physical output state of the pin
    # We read the output state *before* potentially changing it
    current_output = GPIO.input(LED_PIN)
    
    # Only change the state if necessary to reduce unnecessary pin writes and log spam
    if current_output != new_state:
        set_pin_state(new_state)
    # else:
    #     print(f"[{datetime.now().strftime('%H:%M:%S')}] State unchanged.") # Uncomment for verbose debugging

if __name__ == "__main__":
    print("--- RPi LED Schedule Controller Started ---")
    print(f"LED Pin: BCM {LED_PIN} | ON Time: {ON_HOUR:02d}:00 | OFF Time: {OFF_HOUR:02d}:00")
    print(f"Low-Level Trigger: ON={ON_STATE}, OFF={OFF_STATE}")
    
    try:
        # 1. Setup the LED_PIN as an output
        GPIO.setup(LED_PIN, GPIO.OUT)
        
        # 2. Ensure a safe initial state (e.g., OFF)
        GPIO.output(LED_PIN, OFF_STATE)
        print("Initial state set to OFF (HIGH output).")
        
        # 3. Main control loop
        while True:
            # Execute the control logic
            check_schedule_and_control()
            
            # Wait for 60 seconds before checking the time again.
            # Checking once per minute is sufficient for hour-based scheduling.
            time.sleep(60)

    except KeyboardInterrupt:
        print("\nStopping script via KeyboardInterrupt.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)

    finally:
        # CRITICAL: Always clean up GPIO settings
        print("Resetting pin to OFF state and running GPIO cleanup...")
        GPIO.output(LED_PIN, OFF_STATE) # Explicitly turn off the LED before exiting
        GPIO.cleanup()
        print("GPIO cleanup complete. Program terminated.")
        sys.exit(0)
