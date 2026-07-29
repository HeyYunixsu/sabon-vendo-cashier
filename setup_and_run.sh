#!/bin/bash
# =============================================================================
# setup_and_run.sh
# Sabon Express Dispenser — Full Setup & PM2 Launch Script
#
# Usage:
#   chmod +x setup_and_run.sh
#   ./setup_and_run.sh
#
# Logs are printed with timestamps. Copy/paste the full terminal output for
# debugging. You can also redirect:
#   ./setup_and_run.sh 2>&1 | tee setup_run.log
# =============================================================================

set -euo pipefail

# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PREFIX="[setup_and_run]"

log()  { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] INFO  | $*"; }
warn() { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] WARN  | $*" >&2; }
err()  { echo "${LOG_PREFIX} [$(date '+%Y-%m-%d %H:%M:%S')] ERROR | $*" >&2; }

# Detects the human user running this session — works for any Pi username.
# Priority: SUDO_USER → logname → first human user in /etc/passwd → pi
_detect_display_user() {
    # 1. SUDO_USER is set when the script is invoked via sudo
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
        echo "$SUDO_USER"; return
    fi
    # 2. logname returns the login name of the current session
    local u
    u="$(logname 2>/dev/null || true)"
    if [ -n "$u" ] && [ "$u" != "root" ]; then
        echo "$u"; return
    fi
    # 3. First human user (UID 1000–65533) in /etc/passwd — covers any Pi username
    u="$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd 2>/dev/null || true)"
    if [ -n "$u" ]; then echo "$u"; return; fi
    # 4. Last resort: standard Raspberry Pi OS default
    echo "pi"
}

section() {
  echo ""
  echo "============================================================"
  echo "  $*"
  echo "============================================================"
}

# --------------------------------------------------------------------------- #
# 0. Sanity checks
# --------------------------------------------------------------------------- #
section "0. Sanity checks"

for cmd in make g++ python3 pm2 sudo systemctl; do
  if ! command -v "$cmd" &>/dev/null; then
    warn "'$cmd' not found in PATH — some steps may fail."
  else
    log "'$cmd' found: $(command -v "$cmd")"
  fi
done

# --------------------------------------------------------------------------- #
# 1. Build C++ projects with make
# --------------------------------------------------------------------------- #
section "1. Building C++ projects"

build_cpp() {
  local name="$1"
  local dir="$SCRIPT_DIR/$name"

  log "[$name] Starting make in $dir"
  pushd "$dir" > /dev/null

  # Clean previous artefacts so we always get a fresh build
  if make clean 2>/dev/null; then
    log "[$name] make clean — OK"
  else
    warn "[$name] make clean skipped (no clean target or already clean)"
  fi

  if make; then
    log "[$name] make — BUILD SUCCESSFUL"
  else
    err "[$name] make — BUILD FAILED (check output above)"
    popd > /dev/null
    return 1
  fi

  popd > /dev/null
}

build_cpp "coin_slot"
build_cpp "iot_dispenser_v2"

# --------------------------------------------------------------------------- #
# 2. Create virtual-envs and install requirements
# --------------------------------------------------------------------------- #
section "2. Setting up Python virtual environments"

setup_venv() {
  local name="$1"
  local dir="$SCRIPT_DIR/$name"
  local venv_dir="$dir/venv"

  log "[$name] Setting up venv at $venv_dir"

  if [ ! -d "$venv_dir" ]; then
    python3 -m venv "$venv_dir"
    log "[$name] venv created"
  else
    log "[$name] venv already exists — skipping creation"
  fi

  # Upgrade pip silently
  "$venv_dir/bin/pip" install --upgrade pip --quiet
  log "[$name] pip upgraded"

  # Find requirements file (requirement.txt or requirements.txt)
  local req=""
  for fname in requirements.txt requirement.txt; do
    if [ -f "$dir/$fname" ]; then
      req="$dir/$fname"
      break
    fi
  done

  if [ -n "$req" ]; then
    log "[$name] Installing from $req"
    "$venv_dir/bin/pip" install -r "$req"
    log "[$name] Requirements installed"
  else
    warn "[$name] No requirements file found — skipping pip install"
  fi
}

setup_venv "keyboard_monitoring"
setup_venv "uploaderTransaction"
setup_venv "usb_to_coin_module"

# --------------------------------------------------------------------------- #
# 3. Register processes with PM2
# --------------------------------------------------------------------------- #
section "3. Registering processes with PM2"

# Detect the display user — works for any Pi username (pi, dgsi, etc.)
DISPLAY_USER="$(_detect_display_user)"
DISPLAY_USER_HOME="/home/${DISPLAY_USER}"
log "Display user: $DISPLAY_USER  (home: $DISPLAY_USER_HOME)"

# On Linux the Makefile produces 'main' (no .exe extension)
COIN_SLOT_BIN="$SCRIPT_DIR/coin_slot/main"

pm2_process_exists() {
  # Returns 0 (true) if a PM2 process with this name is already registered
  sudo pm2 describe "$1" &>/dev/null
}

# pm2_start_binary <pm2_name> <binary> <cwd> [KEY=VAL ...]
# Extra KEY=VAL args after position 3 are injected into the process environment
# via `sudo env KEY=VAL pm2 start` — this is the only reliable way to pass
# env vars to PM2 from the CLI without an ecosystem file.
pm2_start_binary() {
  local pm2_name="$1"
  local binary="$2"
  local cwd="$3"
  shift 3
  local extra_env=("$@")   # remaining args are KEY=VAL pairs

  log "[$pm2_name] Registering binary: $binary"
  [ ${#extra_env[@]} -gt 0 ] && log "[$pm2_name] Extra env: ${extra_env[*]}"

  if [ ! -f "$binary" ]; then
    err "[$pm2_name] Binary not found: $binary  — did make succeed?"
    return 1
  fi

  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — restarting"
    sudo pm2 restart "$pm2_name"
  else
    log "[$pm2_name] New process — starting for the first time"
    sudo env "${extra_env[@]}" pm2 start "$binary" \
      --name "$pm2_name" \
      --cwd  "$cwd" \
      --log  "$cwd/pm2_${pm2_name}.log" \
      --time
  fi

  log "[$pm2_name] PM2 entry registered/restarted"
}

# pm2_start_python <pm2_name> <script> <venv_root> <cwd> [KEY=VAL ...]
# Extra KEY=VAL args after position 4 are injected via `sudo env KEY=VAL pm2 start`.
# NOTE: PM2's --env flag selects a named block from an ecosystem file — it does
# NOT set individual environment variables. Use `sudo env` instead.
pm2_start_python() {
  local pm2_name="$1"
  local script="$2"
  local venv_root="$3"   # directory that contains /venv
  local cwd="$4"
  shift 4
  local extra_env=("$@")  # remaining args are KEY=VAL pairs

  local interpreter="$venv_root/venv/bin/python3"
  log "[$pm2_name] Registering Python script: $script"
  log "[$pm2_name] Interpreter: $interpreter"
  [ ${#extra_env[@]} -gt 0 ] && log "[$pm2_name] Extra env: ${extra_env[*]}"

  if [ ! -f "$interpreter" ]; then
    err "[$pm2_name] Interpreter not found: $interpreter"
    return 1
  fi

  if [ ! -f "$script" ]; then
    err "[$pm2_name] Script not found: $script"
    return 1
  fi

  if pm2_process_exists "$pm2_name"; then
    log "[$pm2_name] Already registered — restarting"
    sudo pm2 restart "$pm2_name"
  else
    log "[$pm2_name] New process — starting for the first time"
    sudo env "${extra_env[@]}" pm2 start "$script" \
      --name        "$pm2_name" \
      --interpreter "$interpreter" \
      --cwd         "$cwd" \
      --log         "$cwd/pm2_${pm2_name}.log" \
      --time
  fi

  log "[$pm2_name] PM2 entry registered/restarted"
}

# 01_Main — coin_slot C++ binary
pm2_start_binary \
  "01_Main" \
  "$COIN_SLOT_BIN" \
  "$SCRIPT_DIR/coin_slot"

# 02_Coin_Acceptor — usb_to_coin_module/coin_counter.py
pm2_start_python \
  "02_Coin_Acceptor" \
  "$SCRIPT_DIR/usb_to_coin_module/coin_counter.py" \
  "$SCRIPT_DIR/usb_to_coin_module" \
  "$SCRIPT_DIR/usb_to_coin_module"

# 03_Street_Light — usb_to_coin_module/simple_on_off_led_relay.py
pm2_start_python \
  "03_Street_Light" \
  "$SCRIPT_DIR/usb_to_coin_module/simple_on_off_led_relay.py" \
  "$SCRIPT_DIR/usb_to_coin_module" \
  "$SCRIPT_DIR/usb_to_coin_module"

# 04_QR_Scanner — keyboard_monitoring/qr_code_monitoring.py
# pynput needs DISPLAY=:0 and XAUTHORITY to connect to the Pi's local X server.
# When this script runs over SSH (PuTTY), those vars are not set in the shell,
# so we inject them explicitly via `sudo env` — the only reliable CLI method.
pm2_start_python \
  "04_QR_Scanner" \
  "$SCRIPT_DIR/keyboard_monitoring/qr_code_monitoring.py" \
  "$SCRIPT_DIR/keyboard_monitoring" \
  "$SCRIPT_DIR/keyboard_monitoring" \
  "DISPLAY=:0" \
  "XAUTHORITY=${DISPLAY_USER_HOME}/.Xauthority"

# 05_Water_Level — uploaderTransaction/water_level_monitoring_v2.py
pm2_start_python \
  "05_Water_Level" \
  "$SCRIPT_DIR/uploaderTransaction/water_level_monitoring_v2.py" \
  "$SCRIPT_DIR/uploaderTransaction" \
  "$SCRIPT_DIR/uploaderTransaction"

# 06_Transaction_Upload — uploaderTransaction/uploader.py
pm2_start_python \
  "06_Transaction_Upload" \
  "$SCRIPT_DIR/uploaderTransaction/uploader.py" \
  "$SCRIPT_DIR/uploaderTransaction" \
  "$SCRIPT_DIR/uploaderTransaction"

# 07_Status_Upload — uploaderTransaction/status_uploader.py
pm2_start_python \
  "07_Status_Upload" \
  "$SCRIPT_DIR/uploaderTransaction/status_uploader.py" \
  "$SCRIPT_DIR/uploaderTransaction" \
  "$SCRIPT_DIR/uploaderTransaction"

# Register PM2 as a systemd service so it auto-starts on every reboot.
# This must run BEFORE pm2 save — the save writes the process list that the
# generated pm2-root.service will resurrect on boot.
log "Registering PM2 systemd startup hook..."
sudo pm2 startup systemd
log "PM2 startup hook registered — OK"

# Persist PM2 process list so it survives reboot
log "Saving PM2 process list (sudo pm2 save)..."
sudo pm2 save
log "PM2 list saved"

# --------------------------------------------------------------------------- #
# 4. iot_dispenser_v2 — patch & start vendo_gui.service via systemctl
# --------------------------------------------------------------------------- #
section "4. Configuring vendo_gui.service for iot_dispenser_v2"

SERVICE_FILE="$SCRIPT_DIR/iot_dispenser_v2/vendo_gui.service"
DEST_SERVICE="/etc/systemd/system/vendo_gui.service"
MAIN_GUI_BIN="$SCRIPT_DIR/iot_dispenser_v2/main_gui"
IOT_DIR="$SCRIPT_DIR/iot_dispenser_v2"
# DISPLAY_USER is already set in Section 3
log "Using display user: $DISPLAY_USER"

if [ ! -f "$MAIN_GUI_BIN" ]; then
  err "main_gui binary not found at $MAIN_GUI_BIN — did iot_dispenser_v2 build succeed?"
else
  log "Patching $SERVICE_FILE with current paths"

  # Write a corrected service file (overwrite in-place)
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Sabon Express Vendo GUI
After=graphical.target
Wants=graphical.target

[Service]
User=${DISPLAY_USER}
# Wait up to 60 s for the X server socket to appear before launching the GUI.
# graphical.target is reached before the display manager finishes starting X,
# so without this wait the process starts, cannot open DISPLAY :0, and exits.
ExecStartPre=/bin/bash -c 'c=0; until [ -S /tmp/.X11-unix/X0 ]; do sleep 1; c=\$((c+1)); [ \$c -ge 60 ] && exit 1; done; c=0; until DISPLAY=:0 XAUTHORITY=/home/${DISPLAY_USER}/.Xauthority xrandr 2>/dev/null | grep -qF "*"; do sleep 1; c=\$((c+1)); [ \$c -ge 30 ] && break; done'
ExecStart=${MAIN_GUI_BIN}
WorkingDirectory=${IOT_DIR}
StandardOutput=journal
StandardError=journal
Restart=always
RestartSec=5

Environment="DISPLAY=:0"
Environment="XAUTHORITY=/home/${DISPLAY_USER}/.Xauthority"

[Install]
WantedBy=graphical.target
EOF

  log "vendo_gui.service written — installing to $DEST_SERVICE"
  # Remove any dangling symlink left by a previous 'systemctl enable' before copying
  sudo rm -f "$DEST_SERVICE"
  sudo cp "$SERVICE_FILE" "$DEST_SERVICE"
  sudo systemctl daemon-reload
  log "systemd daemon reloaded"

  # Unmask first — a masked unit cannot be enabled or started
  if systemctl is-enabled vendo_gui.service 2>/dev/null | grep -q "masked"; then
    log "vendo_gui.service is masked — unmasking now"
    sudo systemctl unmask vendo_gui.service
    log "vendo_gui.service unmasked"
  fi

  sudo systemctl enable vendo_gui.service
  log "vendo_gui.service enabled"

  sudo systemctl restart vendo_gui.service
  log "vendo_gui.service restarted"

  # Give the ExecStartPre wait-for-X loop time to finish before reporting status.
  # The X server is usually ready within a few seconds of graphical.target; 10 s
  # is enough for a normal boot.  The service will keep retrying on its own
  # (RestartSec=5) even if this check reports it as not yet active.
  sleep 10
  if systemctl is-active --quiet vendo_gui.service; then
    log "vendo_gui.service — RUNNING"
  else
    warn "vendo_gui.service — NOT running yet (X may still be initialising)."
    warn "Check: sudo journalctl -u vendo_gui.service -n 50"
    warn "The service will auto-restart every 5 s until it succeeds."
  fi
fi

# --------------------------------------------------------------------------- #
# 5. Final status summary
# --------------------------------------------------------------------------- #
section "5. Final status summary"

log "PM2 process list:"
sudo pm2 list

log ""
log "vendo_gui systemd status:"
systemctl status vendo_gui.service --no-pager || true

log ""
log "================================================================"
log "  SETUP COMPLETE"
log "  Useful debugging commands:"
log "    sudo pm2 logs                          # tail all PM2 logs"
log "    sudo pm2 logs <name>                   # tail one process"
log "    sudo pm2 monit                         # live dashboard"
log "    sudo journalctl -u vendo_gui -f        # follow GUI service log"
log "    sudo journalctl -u vendo_gui -n 100    # last 100 lines"
log "================================================================"
