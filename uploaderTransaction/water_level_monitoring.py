import smbus2
import time
import sys
import socket # Import the socket module for network communication

# --- I2C Configuration ---
# The I2C bus number on Raspberry Pi.
# Typically 1 for newer Pis (RPi 2, 3, 4, 5).
# For older Pis (RPi B, B+), it might be 0.
# You can check by running `i2cdetect -y 1` or `i2cdetect -y 0` in your terminal.
I2C_BUS = 1

# The I2C address of the Arduino slave.
# This must match the I2C_SLAVE_ADDRESS defined in your Arduino code (0x08).
ARDUINO_SLAVE_ADDRESS = 0x08

# --- Socket Communication Configuration ---
# The IP address or hostname of your socket server.
# If your server is running on the same Raspberry Pi for testing, use '127.0.0.1'.
# Otherwise, use the actual IP address of your server machine.
SOCKET_SERVER_HOST = '127.0.0.1' # IMPORTANT: Change this to your server's IP address
# The port number your socket server is listening on.
SOCKET_SERVER_PORT = 8080 # IMPORTANT: Ensure this matches your server's port

# Global socket object
client_socket = None

# --- I2C Bus Object ---
# Initialize the SMBus object for I2C communication.
# This allows us to interact with the I2C bus.
try:
    bus = smbus2.SMBus(I2C_BUS)
    print(f"Successfully initialized I2C bus {I2C_BUS}.")
except FileNotFoundError:
    print(f"Error: I2C bus {I2C_BUS} not found. "
          "Make sure I2C is enabled and you have the necessary permissions.", file=sys.stderr)
    print("You might need to run 'sudo raspi-config' -> Interfacing Options -> I2C -> Yes.", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"An unexpected error occurred during I2C bus initialization: {e}", file=sys.stderr)
    sys.exit(1)


def send_command(command_char):
    """
    Sends a single character command to the Arduino slave via I2C.

    Args:
        command_char (str): The character to send (e.g., 'A').
    """
    try:
        # Convert the character to its ASCII byte value.
        data_to_send = ord(command_char)
        # Write a single byte to the slave.
        bus.write_byte(ARDUINO_SLAVE_ADDRESS, data_to_send)
        print(f"Sent command '{command_char}' (0x{data_to_send:02x}) to Arduino.")
    except IOError as e:
        print(f"I/O Error sending command over I2C: {e}", file=sys.stderr)
    except Exception as e:
        print(f"An unexpected error occurred while sending I2C command: {e}", file=sys.stderr)


def read_gpio_states(): 
    """
    Reads a single byte from the Arduino slave and parses it into 4 boolean states.

    Returns:
        tuple: A tuple of 4 boolean values (gpio1, gpio2, gpio3, gpio4).
               Returns (False, False, False, False) on error.
    """
    try:
        # Read a single byte from the Arduino.
        # This will trigger the `requestEvent` on the Arduino side.
        received_byte = bus.read_byte(ARDUINO_SLAVE_ADDRESS)
        # print(f"Received byte from Arduino: 0x{received_byte:02x} (Binary: {bin(received_byte)})") # Uncomment for more verbose I2C debug

        # Parse the byte into 4 boolean values.
        # Each bit represents a GPIO state.
        # Bit 0: gpioState1 (PIN2)
        # Bit 1: gpioState2 (PIN3)
        # Bit 2: gpioState3 (PIN4)
        # Bit 3: gpioState4 (PIN5)
        gpio1 : bool = bool(received_byte & (1 << 0)) # Check if the 0th bit is set
        gpio2 : bool = bool(received_byte & (1 << 1)) # Check if the 1st bit is set
        gpio3 : bool = bool(received_byte & (1 << 2)) # Check if the 2nd bit is set
        gpio4 : bool = bool(received_byte & (1 << 3)) # Check if the 3rd bit is set

        return gpio1, gpio2, gpio3, gpio4

    except IOError as e:
        # This error can occur if the Arduino is not connected,
        # powered, or if its I2C is not properly initialized.
        print(f"I/O Error reading data from Arduino: {e}", file=sys.stderr)
        return False, False, False, False # Return default values on error
    except Exception as e:
        print(f"An unexpected error occurred while reading Arduino data: {e}", file=sys.stderr)
        return False, False, False, False


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
        print(f"Sent data to socket: '{data_string}'")
    except BrokenPipeError:
        print("Socket connection broken (BrokenPipeError). Reconnecting...", file=sys.stderr)
        client_socket = None # Mark socket as disconnected
        connect_to_socket_server() # Attempt immediate reconnection
    except ConnectionResetError:
        print("Socket connection reset by peer. Reconnecting...", file=sys.stderr)
        client_socket = None # Mark socket as disconnected
        connect_to_socket_server() # Attempt immediate reconnection
    except socket.timeout:
        print("Socket send timed out. Reconnecting...", file=sys.stderr)
        client_socket = None # Mark socket as disconnected
        connect_to_socket_server() # Attempt immediate reconnection
    except Exception as e:
        print(f"An unexpected error occurred during socket send: {e}. Reconnecting...", file=sys.stderr)
        client_socket = None # Mark socket as disconnected
        connect_to_socket_server() # Attempt immediate reconnection


if __name__ == "__main__":
    print("Raspberry Pi I2C Master with Socket Client started.")

    # --- Initial socket connection attempt ---
    # Try to connect to the socket server at startup
    socket_connected = False
    while not socket_connected:
        socket_connected = connect_to_socket_server()
        if not socket_connected:
            time.sleep(5) # Wait before retrying connection
    
    # --- Send command 'A' on startup via I2C ---
    # This instructs the Arduino to send its current GPIO states.
    send_command('A')
    time.sleep(0.1) # Give the Arduino a moment to process the command

    print("\nMonitoring Arduino GPIO states and sending to socket server...")
    try:
        while True:
            # Read and parse GPIO states from Arduino
            current_gpio_states = read_gpio_states()

            # Format the data into a string to send over the socket
            # Example format: "PIN2=False,PIN3=True,PIN4=False,PIN5=False\n"
            data_to_send = (
                f"WTRLVL,{1 if current_gpio_states[0] else 0},{1 if current_gpio_states[1] else 0},{1 if current_gpio_states[2] else 0},{1 if current_gpio_states[3] else 0}\n"
            )
            
            # Send the processed data to the socket server
            send_data_to_socket(data_to_send)

            # Wait for 1 second before the next read and send
            # Adjust this delay based on how frequently you need updates.
            time.sleep(1)

    except KeyboardInterrupt:
        # Handle Ctrl+C to gracefully exit the loop
        print("\nExiting I2C Master and Socket Client.")
    except Exception as e:
        print(f"An error occurred in the main loop: {e}", file=sys.stderr)
    finally:
        # It's good practice to close the I2C bus and socket when done.
        bus.close()
        print("I2C bus closed.")
        if client_socket:
            try:
                client_socket.shutdown(socket.SHUT_RDWR)
                client_socket.close()
                print("Socket connection closed.")
            except OSError as e:
                if e.errno != 107: # Transport endpoint is not connected
                    print(f"Error closing socket during cleanup: {e}", file=sys.stderr)
