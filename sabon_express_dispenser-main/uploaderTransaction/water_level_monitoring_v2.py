import os
import time
import sys
import socket # Import the socket module for network communication
import RPi.GPIO as GPIO # Import the RPi.GPIO library
from pathlib import Path
from dotenv import load_dotenv

current_dir = Path(__file__).parent
env_path = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)

# --- RPi GPIO Configuration (BCM Numbering) ---
# Pins are loaded from CONFIG/config.env (WATER_GPIO_PIN_1 .. _4).
GPIO_PIN_1 = int(os.getenv("WATER_GPIO_PIN_1", 26))
GPIO_PIN_2 = int(os.getenv("WATER_GPIO_PIN_2", 20))
GPIO_PIN_3 = int(os.getenv("WATER_GPIO_PIN_3", 21))
GPIO_PIN_4 = int(os.getenv("WATER_GPIO_PIN_4", 11))

# List of GPIO pins to read
INPUT_PINS = [GPIO_PIN_1, GPIO_PIN_2, GPIO_PIN_3, GPIO_PIN_4]

# --- Socket Communication Configuration ---
SOCKET_SERVER_HOST = os.getenv("SOCKET_IP", "127.0.0.1")
SOCKET_SERVER_PORT = int(os.getenv("SOCKET_PORT", 8080))

# Global socket object
client_socket = None

# --- RPi.GPIO Initialization ---
try:
    # Set the GPIO mode to BCM (Broadcom chip-specific pin numbers)
    GPIO.setmode(GPIO.BCM)
    
    # Configure each pin as an input.
    # We do NOT use pull_up_down=GPIO.PUD_UP/DOWN since you have external resistors.
    for pin in INPUT_PINS:
        GPIO.setup(pin, GPIO.IN)
        print(f"Successfully configured BCM pin {pin} as input.")

except Exception as e:
    print(f"An error occurred during RPi.GPIO initialization: {e}", file=sys.stderr)
    GPIO.cleanup() # Clean up all GPIO settings
    sys.exit(1)

# --- Removed I2C Functions: send_command and I2C initialization code ---

def read_gpio_states(): 
    """
    Reads the state of the four configured RPi GPIO input pins.

    Returns:
        tuple: A tuple of 4 integer values (0 or 1) representing the pin states.
    """
    try:
        # GPIO.input() returns GPIO.HIGH (1) or GPIO.LOW (0)
        gpio1_state = GPIO.input(GPIO_PIN_1)
        gpio2_state = GPIO.input(GPIO_PIN_2)
        gpio3_state = GPIO.input(GPIO_PIN_3)
        gpio4_state = GPIO.input(GPIO_PIN_4)

        # The states are already 0 or 1, which is perfect for the data format.
        return gpio1_state, gpio2_state, gpio3_state, gpio4_state

    except Exception as e:
        print(f"An error occurred while reading RPi GPIO data: {e}", file=sys.stderr)
        return 0, 0, 0, 0 # Return default values on error


def connect_to_socket_server():
    """
    Attempts to connect to the predefined socket server.
    Handles creation and assignment to the global client_socket.
    """
    global client_socket
    if client_socket:
        try:
            # Attempt to close any existing socket if it's still open
            client_socket.shutdown(socket.SHUT_RDWR)
            client_socket.close()
        except OSError as e:
            # Ignore error if socket is already closed or not connected
            if e.errno != 107: # Transport endpoint is not connected
                print(f"Error closing existing socket: {e}", file=sys.stderr)
        finally:
            client_socket = None

    try:
        # IPv4, TCP Stream Socket
        client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client_socket.connect((SOCKET_SERVER_HOST, SOCKET_SERVER_PORT))
        print(f"Successfully connected to socket server at {SOCKET_SERVER_HOST}:{SOCKET_SERVER_PORT}")
        return True
    except ConnectionRefusedError:
        print(f"Connection refused by server at {SOCKET_SERVER_HOST}:{SOCKET_SERVER_PORT}. Retrying...", file=sys.stderr)
    except socket.timeout:
        print(f"Socket connection timed out to {SOCKET_SERVER_HOST}:{SOCKET_SERVER_PORT}. Retrying...", file=sys.stderr)
    except Exception as e:
        print(f"An unexpected error occurred during socket connection: {e}. Retrying...", file=sys.stderr)
    
    client_socket = None # Ensure client_socket is None if connection fails
    return False

def send_data_to_socket(data_string : str):
    """
    Sends a string of data over the established socket connection.

    Args:
        data_string (str): The string data to send.
    """
    global client_socket
    if not client_socket:
        print("Socket not connected. Attempting to reconnect...", file=sys.stderr)
        if not connect_to_socket_server():
            return # If reconnection fails, exit

    try:
        # Ensure the data is encoded to bytes before sending
        client_socket.sendall(data_string.encode('utf-8'))
        # print(f"Sent data to socket: '{data_string.strip()}'") # Use .strip() for cleaner log
    except BrokenPipeError:
        print("Socket connection broken (BrokenPipeError). Reconnecting...", file=sys.stderr)
        client_socket = None
        connect_to_socket_server()
    except ConnectionResetError:
        print("Socket connection reset by peer. Reconnecting...", file=sys.stderr)
        client_socket = None
        connect_to_socket_server()
    except socket.timeout:
        print("Socket send timed out. Reconnecting...", file=sys.stderr)
        client_socket = None
        connect_to_socket_server()
    except Exception as e:
        print(f"An unexpected error occurred during socket send: {e}. Reconnecting...", file=sys.stderr)
        client_socket = None
        connect_to_socket_server()


if __name__ == "__main__":
    print("Raspberry Pi GPIO Input and Socket Client started.")

    # --- Initial socket connection attempt ---
    socket_connected = False
    while not socket_connected:
        socket_connected = connect_to_socket_server()
        if not socket_connected:
            time.sleep(5) # Wait before retrying connection
    
    # --- The 'send_command('A')' is no longer needed as there is no Arduino command structure ---

    print("\nMonitoring RPi GPIO input states and sending to socket server...")
    try:
        while True:
            # Read and parse GPIO states from RPi
            gpio_states = read_gpio_states()

            # Format the data into a string to send over the socket
            # Example format: "WTRLVL,1,0,1,0\n"
            data_to_send = (
                f"WTRLVL,{gpio_states[0]},{gpio_states[1]},{gpio_states[2]},{gpio_states[3]}\n"
            )
            
            # Send the processed data to the socket server
            send_data_to_socket(data_to_send)

            # Wait for 1 second before the next read and send
            time.sleep(1)

    except KeyboardInterrupt:
        # Handle Ctrl+C to gracefully exit the loop
        print("\nExiting RPi GPIO Input and Socket Client.")
    except Exception as e:
        print(f"An error occurred in the main loop: {e}", file=sys.stderr)
    finally:
        # CRITICAL: Clean up GPIO settings to avoid issues on future runs
        GPIO.cleanup()
        print("RPi.GPIO cleanup complete.")
        
        # Close the socket connection
        if client_socket:
            try:
                client_socket.shutdown(socket.SHUT_RDWR)
                client_socket.close()
                print("Socket connection closed.")
            except OSError as e:
                if e.errno != 107:
                    print(f"Error closing socket during cleanup: {e}", file=sys.stderr)