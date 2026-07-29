#!./env/bin/python


# ---------------------------------------------------------------------------
# coin_reader.py
# Sabon Express Dispenser — USB Serial to Socket Bridge (FIXED FOR NOISE)
#
# Reads coin insertion events from the Arduino over USB serial and forwards
# them to the vendo socket server as:   COIN,<amount>
#
# Anti-noise layers:
#   1. Denomination check  — only {5.0, 10.0, 20.0} are accepted
#   2. Adaptive debounce   — 300ms general / 500ms for same denomination repeat
#   3. Rate limiter        — max 10 coins per rolling 60-second window
# ---------------------------------------------------------------------------


import datetime
import serial
import socket
import time
import os
from collections import deque
from dotenv import load_dotenv
from pathlib import Path


current_dir = Path(__file__).parent
env_path    = current_dir / ".." / "CONFIG" / "config.env"
load_dotenv(dotenv_path=env_path)


# ---------------------------------------------------------------------------
# Serial / network configuration
# ---------------------------------------------------------------------------
SERIAL_PORT_CANDIDATES = ['/dev/ttyACM0', '/dev/ttyUSB0']
BAUD_RATE   = int(os.getenv('BAUD_RATE',   '9600'))
SERVER_IP   = os.getenv('SOCKET_IP',   '127.0.0.1')
SERVER_PORT = int(os.getenv('SOCKET_PORT', '8080'))


# ---------------------------------------------------------------------------
# Anti-noise configuration - UPDATED FOR STRONGER FILTERING
# ---------------------------------------------------------------------------
VALID_AMOUNTS      = {5.0, 10.0, 20.0}  # exact per-coin denominations from Arduino
DEBOUNCE_SECONDS   = 0.30               # WAS 0.15: Increased to 300ms (real coin cycle time)
SAME_AMT_DEBOUNCE  = 0.50               # WAS 0.30: Stricter debounce for same denom (500ms)
MAX_COINS_PER_MIN  = 10                 # WAS 15: Reduced limit (10 coins/min is physically hard)
BUFFER_RESET_SECS  = 300               # reset serial buffer after 5 mins idle


print(f"[config] ports={SERIAL_PORT_CANDIDATES}  baud={BAUD_RATE}")
print(f"[config] server={SERVER_IP}:{SERVER_PORT}")
print(f"[config] valid_amounts={VALID_AMOUNTS}")
print(f"[config] debounce={DEBOUNCE_SECONDS}s  same_amt={SAME_AMT_DEBOUNCE}s  rate_limit={MAX_COINS_PER_MIN}/min")




# ---------------------------------------------------------------------------
# Port detection
# ---------------------------------------------------------------------------
def detect_serial_port(candidates):
    for port in candidates:
        if os.path.exists(port):
            print(f"[serial] Found port: {port}")
            return port
    return None




# ---------------------------------------------------------------------------
# Data parsing
# ---------------------------------------------------------------------------
def process_data(text_data: str) -> float | None:
    """
    Parses a serial line from the Arduino.
    Expected format:  " Inserted Coins:<amount>"
    Returns the amount as a float, or None if the line is not a coin event.


    Examples:
      " Inserted Coins:5.0"  → 5.0
      " Inserted Coins:10.0" → 10.0
      " Inserted Coins:20.0" → 20.0
    """
    text_data = text_data.strip()


    if ':' not in text_data:
        return None


    try:
        amount_str  = text_data.split(':', 1)[1].strip()
        amount_float = float(amount_str)
        print(f"✅ Parsed: '{text_data}' → {amount_float}")
        return amount_float
    except ValueError:
        print(f"⚠️  Parse error: cannot convert to float: '{text_data}'")
    except IndexError:
        print(f"⚠️  Parse error: malformed line: '{text_data}'")


    return None




# ---------------------------------------------------------------------------
# Anti-noise filter
# ---------------------------------------------------------------------------
class CoinFilter:
    """
    Three-layer noise guard:
      1. Denomination validation  — rejects non-coin float values
      2. Adaptive debounce        — blocks suspiciously fast repeat pulses
      3. Rate limiter             — caps coins per rolling 60-second window
    """


    def __init__(self):
        self.dt_last_accept = datetime.datetime.min
        self.last_amount    = None
        self.coin_times     = deque()


    def is_valid(self, amount: float) -> bool:
        now = datetime.datetime.now()


        # --- Layer 1: Denomination check ---
        if amount not in VALID_AMOUNTS:
            print(f"🚫 Rejected: {amount} not in valid set {VALID_AMOUNTS}")
            return False


        # --- Layer 2: Adaptive debounce ---
        elapsed   = (now - self.dt_last_accept).total_seconds()
        threshold = SAME_AMT_DEBOUNCE if amount == self.last_amount else DEBOUNCE_SECONDS
        if elapsed < threshold:
            print(f"🚫 Debounced: ₱{amount:.0f} too fast "
                  f"({elapsed*1000:.0f}ms < {threshold*1000:.0f}ms threshold)")
            return False


        # --- Layer 3: Rate limiter ---
        while self.coin_times and (now - self.coin_times[0]).total_seconds() > 60:
            self.coin_times.popleft()
        if len(self.coin_times) >= MAX_COINS_PER_MIN:
            print(f"🚫 Rate limit: {len(self.coin_times)} coins in last 60s — possible noise!")
            return False


        # All layers passed — record and accept
        self.dt_last_accept = now
        self.last_amount    = amount
        self.coin_times.append(now)
        return True




# ---------------------------------------------------------------------------
# Socket sender
# ---------------------------------------------------------------------------
def send_to_socket(data: str):
    """
    Opens a short-lived TCP connection, sends data, then closes.
    Format sent to server:  "COIN,<amount>"
    """
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3)
        print(f"🔄 Connecting to {SERVER_IP}:{SERVER_PORT}...")
        sock.connect((SERVER_IP, SERVER_PORT))


        ts = datetime.datetime.now().strftime("%H:%M:%S")
        print(f"🔗 Connected. [{ts}] Sending: '{data}'")
        sock.sendall(data.encode('utf-8'))
        print(f"⬆️  Sent: '{data}'")


    except ConnectionRefusedError:
        print("❌ Socket: connection refused — is the server running?")
    except TimeoutError:
        print("❌ Socket: connection timed out.")
    except Exception as e:
        print(f"❌ Socket error: {e}")
    finally:
        if sock:
            sock.close()




# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    port = detect_serial_port(SERIAL_PORT_CANDIDATES)
    if port is None:
        print(f"❌ No serial port found. Tried: {SERIAL_PORT_CANDIDATES}")
        return


    print(f"Opening {port} at {BAUD_RATE} baud...")


    coin_filter  = CoinFilter()
    dt_last_data = datetime.datetime.now()


    try:
        ser = serial.Serial(port, BAUD_RATE, timeout=1)
        ser.flushInput()
        print("🔗 Serial port open. Waiting for coins...\n")


        while True:
            raw_line = ser.readline()


            if raw_line:
                text_data    = raw_line.decode('utf-8', errors='ignore').strip()
                dt_last_data = datetime.datetime.now()
                print(f"⬇️  Raw: '{text_data}'")


                amount = process_data(text_data)
                if amount is not None:
                    if coin_filter.is_valid(amount):
                        send_to_socket(f"COIN,{amount}")
                    # rejection reason already logged inside is_valid()


            # Reset input buffer after BUFFER_RESET_SECS of silence
            idle = (datetime.datetime.now() - dt_last_data).total_seconds()
            if idle > BUFFER_RESET_SECS:
                print(f"[{datetime.datetime.now()}] Idle {idle:.0f}s — resetting serial buffer.")
                ser.reset_input_buffer()
                dt_last_data = datetime.datetime.now()


            time.sleep(0.01)


    except serial.SerialException as e:
        print(f"❌ Serial error: {e}")
    except KeyboardInterrupt:
        print("\nStopped by user.")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
    finally:
        if 'ser' in locals() and ser.is_open:
            ser.close()
            print("Serial port closed.")




if __name__ == "__main__":
    main()