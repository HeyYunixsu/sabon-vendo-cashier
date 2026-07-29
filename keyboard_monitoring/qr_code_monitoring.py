import os
import json
from pynput import keyboard # Import Listener and Key from pynput.keyboard
import time                  # Used for time.sleep and timestamps
import socket
import requests
from pathlib import Path
from dotenv import load_dotenv

current_dir = Path(__file__).parent
env_path = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)

vendorId = os.getenv("vendorId", "")
machineId = os.getenv("machineId", 1)
API_BASE_URL = os.getenv("API_BASE_URL", "https://office.dynamicglobalsoft.com:1232")

# Global variables to store the characters typed before 'Enter'
# and to help differentiate fast scanner input from slow human typing.
typed_buffer = []
last_key_press_time = time.time()
# Time in seconds: If there's a gap longer than this between key presses,
# we assume it's a new "scan" or a new typing sequence.
INPUT_TIMEOUT_SECONDS = 0.5
TARGET_SERVER_IP = os.getenv("SOCKET_IP", "127.0.0.1")
TARGET_SERVER_PORT = os.getenv("SOCKET_PORT", 8080)

# API_BASE_URL = "https://office.dynamicglobalsoft.com:1232"
# machineId = 5

def validate_qr_code_api(base_url: str, qr_code_data: str, machine_id: int) -> dict:
    """
    Calls the /api/v1/auth/validate API endpoint with URL-encoded data.

    Args:
        base_url (str): The base URL of your API (e.g., "http://localhost:8000").
        qr_code_data (str): The QR code string to validate.
        machine_id (int): The ID of the machine performing the scan.

    Returns:
        dict: A dictionary containing the validation result.
              - On success: {'status': 'success', 'message': str, 'data': dict}
              - On failure: {'status': 'failure', 'message': str, 'error_code': int}
              - On network/unexpected error: {'status': 'error', 'message': str}
    """
    endpoint = "/api/v1/auth/validate"
    full_url = f"{base_url}{endpoint}"

    # Data for a URL-encoded body is passed as a dictionary to the 'data' parameter.
    # requests will automatically format it as 'qr=value&machineId=value'
    payload = {
        'qr': qr_code_data,
        'machineId': machine_id
    }

    print(f"Calling API: POST {full_url}")
    print(f"Request Body (URL-encoded): {payload}")

    try:
        # Use the 'data' parameter for application/x-www-form-urlencoded
        response = requests.post(full_url, data=payload, timeout=10)

        # Check for HTTP status codes
        if response.status_code == 200:
            try:
                response_json = response.json()
                print(f"API Response (200 OK):\n{json.dumps(response_json, indent=2)}")
                return {
                    'status': 'success',
                    'message': response_json.get('message', 'QR code validated successfully.'),
                    'data': response_json.get('data', {})
                }
            except json.JSONDecodeError:
                print(f"Error: 200 OK but invalid JSON response: {response.text}")
                return {'status': 'error', 'message': 'API returned 200 OK but invalid JSON.'}
        
        elif response.status_code >= 400 and response.status_code < 600:
            # Handle client and server errors (e.g., 403, 500)
            try:
                response_json = response.json()
                print(f"API Response ({response.status_code} Error):\n{json.dumps(response_json, indent=2)}")
                return {
                    'status': 'failure',
                    'message': response_json.get('message', 'Validation failed.'),
                    'error_code': response_json.get('error', response.status_code)
                }
            except json.JSONDecodeError:
                print(f"Error: {response.status_code} but invalid JSON error response: {response.text}")
                return {'status': 'error', 'message': f'API returned {response.status_code} with non-JSON error.'}
        
        else:
            print(f"API Response (Unexpected Status {response.status_code}): {response.text}")
            return {'status': 'error', 'message': f'Unexpected API response status: {response.status_code}'}

    except requests.exceptions.ConnectionError:
        print(f"ERROR: Could not connect to API at {full_url}. Is the server running?")
        return {'status': 'error', 'message': 'Network connection error.'}
    except requests.exceptions.Timeout:
        print(f"ERROR: API request to {full_url} timed out.")
        return {'status': 'error', 'message': 'API request timed out.'}
    except requests.exceptions.RequestException as e:
        print(f"ERROR: An unexpected request error occurred: {e}")
        return {'status': 'error', 'message': f'An unexpected request error occurred: {e}'}
    except Exception as e:
        print(f"ERROR: An unknown error occurred: {e}")
        return {'status': 'error', 'message': f'An unknown error occurred: {e}'}


def push_to_socket_server(server_ip: str, server_port: int, data_to_send: str) -> bool:
    """
    Connects to a socket server, pushes data, and disconnects.
    Checks if reconnection is needed by always attempting a fresh connection.

    Args:
        server_ip (str): The IP address of the socket server.
        server_port (int): The port number of the socket server.
        data_to_send (str): The string data to send to the server.

    Returns:
        bool: True if the data was successfully sent, False otherwise.
    """
    client_socket = None # Initialize socket to None
    try:
        print(f"Attempting to push data to {server_ip}:{server_port}...")
        print(f"Data to send: '{data_to_send}', type: {type(data_to_send)}")
        # 1. Create a new socket for this push operation.
        client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        
        # 2. Attempt to connect to the server.
        # This implicitly acts as a "reconnection" if the previous connection
        # (from a prior call to this function) was closed, or if the server
        # was previously unavailable.
        client_socket.connect((server_ip, server_port if type(server_port) == int else int(server_port)))
        print("Successfully connected to the socket server.")
        
        # 3. Encode and send the data.
        message_bytes = data_to_send.encode('utf-8')
        client_socket.sendall(message_bytes)
        print(f"Data pushed successfully: '{data_to_send}'")
        
        return True # Data sent successfully

    except ConnectionRefusedError:
        print(f"ERROR: Connection refused. Server at {server_ip}:{server_port} might not be running or accessible.")
        return False
    except socket.timeout:
        print(f"ERROR: Connection timed out to {server_ip}:{server_port}.")
        return False
    except socket.error as e:
        print(f"ERROR: Socket error occurred: {e}")
        return False
    except Exception as e:
        print(f"ERROR: An unexpected error occurred: {e}")
        return False
    finally:
        # 4. Ensure the socket is closed, regardless of success or failure.
        if client_socket:
            time.sleep(1)
            client_socket.close()
            # print("Socket closed.") # Uncomment for more verbose logging


def on_press(key):
    """
    This function is called every time a key is pressed.
    """
    global typed_buffer, last_key_press_time

    current_time = time.time()

    # Check for timeout: if too much time has passed since the last key,
    # clear the buffer and start a new sequence.
    if current_time - last_key_press_time > INPUT_TIMEOUT_SECONDS:
        typed_buffer = []
    
    last_key_press_time = current_time # Update the time of the last key press

    try:
        if key == keyboard.Key.enter:
            # 'Enter' key is pressed, process the collected buffer
            processed_value = "".join(typed_buffer).strip() # Join collected chars
            typed_buffer = [] # Clear the buffer for the next input
            print("value recieve.")
            print(processed_value)
            result_valid = validate_qr_code_api(API_BASE_URL, processed_value, machineId)
            print(f"\nResult of validating QR Code Scan: {result_valid}")
            print(type(result_valid))
            print("-" * 30)
            # result_valid = {
            #     'status' : 'success',
            #     'data' : {
            #         'voucherId' : "865abf1f-44fb-11f0-adda-309c23cb09d6",
            #         'amount': 10
            #     }
            # }

            if result_valid.get('status') == 'success':
                
                voucherId = result_valid['data'].get('voucherId','')
                amount = result_valid['data'].get('amount','0')
                amount = amount if type(amount) == str else str(amount)

                success = push_to_socket_server(TARGET_SERVER_IP, TARGET_SERVER_PORT, ",".join(["VOUCHER",voucherId, amount]))
                
                if success:
                    print("Push: Data sent successfully.")
                else:
                    print("Push: Failed to send data.")

                if processed_value: # Only print if there's actual text
                    print(f"--- Detected Input: '{processed_value}' ---")
                else:
                    print("--- Empty input detected (just Enter was pressed) ---")
                
                # If you want to stop the listener after a specific action, you can
                # return False here. For continuous monitoring, don't return False.
                # Example: if processed_value == "EXIT_CODE": return False
            
        elif hasattr(key, 'char') and key.char is not None:
            # If it's a regular character key (like 'a', '1', '!', etc.)
            typed_buffer.append(key.char)
        # You can add more specific key handling if needed.
        # For example, to handle numpad keys if they don't produce 'char':
        # elif key == keyboard.Key.num_lock: pass # Ignore num lock
        # elif key == keyboard.Key.space: typed_buffer.append(' ')
        # etc.
            
    except AttributeError:
        # Special keys (e.g., Shift, Ctrl, Alt, F-keys) don't have a 'char' attribute.
        # You can print them for debugging if needed, but typically you'd ignore them
        # if you're only interested in typed characters.
        # print(f"Special key {key} pressed")
        pass # Ignore special keys for text collection

def start_keyboard_monitor():
    """
    Sets up and starts the global keyboard listener using pynput.
    """
    print("--- pynput Keyboard Input Monitor Started ---")
    print("Type anything and press Enter. This will be captured globally.")
    print("This program runs in the background. Your other applications will still work normally.")
    print("Press Ctrl+C in this terminal to stop.")
    
    # Create a listener object that calls `on_press` when a key is pressed.
    # The `with` statement ensures the listener is properly started and stopped.
    with keyboard.Listener(on_press=on_press) as listener:
        try:
            # Join the listener thread. This blocks the main thread
            # and keeps the listener active until it's stopped.
            listener.join()
        except KeyboardInterrupt:
            # Catch Ctrl+C to allow graceful exit
            print("\n--- Ctrl+C detected. Stopping keyboard monitor. ---")
            listener.stop() # Explicitly stop the listener
        finally:
            print("--- pynput Keyboard listener stopped. Exiting. ---")

if __name__ == "__main__":
    start_keyboard_monitor()