# Manual Installation Guide
## Sabon Express Dispenser

This guide mirrors every step that `setup_and_run.sh` performs, broken into
copy-pasteable terminal blocks. Run each section in order.

---

## 0. Set Your Variables First

Run these two lines **before anything else**. Every command below uses them.

```bash
PROJECT_DIR="/home/dgsi/Desktop/sabon_express_dispenser"
DISPLAY_USER="dgsi"
```

> **Change `dgsi`** to your actual Pi username if it differs.  
> Verify with: `echo $USER`

---

## 1. Sanity Check — Confirm Required Tools Exist

```bash
for cmd in make g++ python3 pm2 sudo systemctl; do
  command -v "$cmd" && echo "$cmd OK" || echo "WARNING: $cmd not found"
done
```

If anything is missing, run `install_dependencies.sh` first (requires internet).

---

## 2. Build C++ Projects

### 2a. coin_slot

```bash
cd "$PROJECT_DIR/coin_slot"
make clean
make
```

Expected output ends with: `make — BUILD SUCCESSFUL` (or similar). Confirm the
binary exists:

```bash
ls -lh "$PROJECT_DIR/coin_slot/main"
```

### 2b. iot_dispenser_v2

```bash
cd "$PROJECT_DIR/iot_dispenser_v2"
make clean
make
```

Confirm the binary:

```bash
ls -lh "$PROJECT_DIR/iot_dispenser_v2/main_gui"
```

---

## 3. Set Up Python Virtual Environments

Repeat for each Python module. Each block is self-contained.

### 3a. keyboard_monitoring

```bash
cd "$PROJECT_DIR/keyboard_monitoring"
python3 -m venv venv
venv/bin/pip install --upgrade pip --quiet
venv/bin/pip install -r requirement.txt
```

### 3b. uploaderTransaction

```bash
cd "$PROJECT_DIR/uploaderTransaction"
python3 -m venv venv
venv/bin/pip install --upgrade pip --quiet
venv/bin/pip install -r requirement.txt
```

> `usb_to_coin_module` was removed: it contained no code, and the coin-acceptor
> and street-light processes it described are not part of the dashboard model.

### Check if processes already exist before starting

```bash
sudo pm2 list
```

If a process already exists and just needs restarting, use:
```bash
sudo pm2 restart <name>
```

Otherwise register each one fresh with the commands below.

---

### 4a. 01_Main — coin_slot C++ binary

```bash
sudo pm2 start "$PROJECT_DIR/coin_slot/main" \
  --name "01_Main" \
  --cwd  "$PROJECT_DIR/coin_slot" \
  --log  "$PROJECT_DIR/coin_slot/pm2_01_Main.log" \
  --time
```

### 4b. 02_Coin_Acceptor — USB coin acceptor serial reader

```bash

### 4c. 03_Street_Light — LED relay schedule

```bash

### 4d. 04_QR_Scanner — QR code keyboard monitor

> Requires `DISPLAY` and `XAUTHORITY` so pynput can reach the X server.

```bash
sudo env DISPLAY=:0 XAUTHORITY=/home/${DISPLAY_USER}/.Xauthority \
  pm2 start "$PROJECT_DIR/keyboard_monitoring/qr_code_monitoring.py" \
  --name        "04_QR_Scanner" \
  --interpreter "$PROJECT_DIR/keyboard_monitoring/venv/bin/python3" \
  --cwd         "$PROJECT_DIR/keyboard_monitoring" \
  --log         "$PROJECT_DIR/keyboard_monitoring/pm2_04_QR_Scanner.log" \
  --time
```

### 4e. 05_Water_Level — GPIO water sensor reader

```bash
sudo pm2 start "$PROJECT_DIR/uploaderTransaction/water_level_monitoring_v2.py" \
  --name        "05_Water_Level" \
  --interpreter "$PROJECT_DIR/uploaderTransaction/venv/bin/python3" \
  --cwd         "$PROJECT_DIR/uploaderTransaction" \
  --log         "$PROJECT_DIR/uploaderTransaction/pm2_05_Water_Level.log" \
  --time
```

### 4f. 06_Transaction_Upload — JSON transaction cloud uploader

```bash
sudo pm2 start "$PROJECT_DIR/uploaderTransaction/uploader.py" \
  --name        "06_Transaction_Upload" \
  --interpreter "$PROJECT_DIR/uploaderTransaction/venv/bin/python3" \
  --cwd         "$PROJECT_DIR/uploaderTransaction" \
  --log         "$PROJECT_DIR/uploaderTransaction/pm2_06_Transaction_Upload.log" \
  --time
```

### 4g. 07_Status_Upload — Machine status cloud sync

```bash
sudo pm2 start "$PROJECT_DIR/uploaderTransaction/status_uploader.py" \
  --name        "07_Status_Upload" \
  --interpreter "$PROJECT_DIR/uploaderTransaction/venv/bin/python3" \
  --cwd         "$PROJECT_DIR/uploaderTransaction" \
  --log         "$PROJECT_DIR/uploaderTransaction/pm2_07_Status_Upload.log" \
  --time
```

---

## 5. Save PM2 Process List & Enable Autostart on Boot

```bash
sudo pm2 startup systemd
sudo pm2 save
```

> `pm2 startup` prints a command — you may need to copy-paste and run it.

---

## 6. Configure & Start the GUI (vendo_gui.service)

This installs `iot_dispenser_v2` as a systemd service so it auto-starts with
the desktop session.

### 6a. Write the service file

```bash
sudo tee /etc/systemd/system/vendo_gui.service > /dev/null <<EOF
[Unit]
Description=Sabon Express Vendo GUI
After=graphical.target
Wants=graphical.target

[Service]
User=${DISPLAY_USER}
ExecStartPre=/bin/bash -c 'c=0; until [ -S /tmp/.X11-unix/X0 ]; do sleep 1; c=\$((c+1)); [ \$c -ge 60 ] && exit 1; done; c=0; until DISPLAY=:0 XAUTHORITY=/home/${DISPLAY_USER}/.Xauthority xrandr 2>/dev/null | grep -qF "*"; do sleep 1; c=\$((c+1)); [ \$c -ge 30 ] && break; done'
ExecStart=${PROJECT_DIR}/iot_dispenser_v2/main_gui
WorkingDirectory=${PROJECT_DIR}/iot_dispenser_v2
StandardOutput=journal
StandardError=journal
Restart=always
RestartSec=5

Environment="DISPLAY=:0"
Environment="XAUTHORITY=/home/${DISPLAY_USER}/.Xauthority"

[Install]
WantedBy=graphical.target
EOF
```

### 6b. Reload systemd, enable, and start

```bash
sudo systemctl daemon-reload
sudo systemctl unmask vendo_gui.service 2>/dev/null || true
sudo systemctl enable vendo_gui.service
sudo systemctl restart vendo_gui.service
```

### 6c. Check status

```bash
sudo systemctl status vendo_gui.service --no-pager
```

If it shows `active (running)` — done. If not, check the journal:

```bash
sudo journalctl -u vendo_gui.service -n 50 --no-pager
```

---

## 7. Final Verification

```bash
# All PM2 processes
sudo pm2 list

# Tail logs for a specific process
sudo pm2 logs 0 --lines 30   # 01_Main (coin_slot)
sudo pm2 logs 1 --lines 30   # 02_Coin_Acceptor

# GUI service
sudo systemctl status vendo_gui.service --no-pager
```

Expected PM2 list — all processes should show `online`:

| Name | ID | Status |
|------|----|--------|
| 01_Main | 0 | online |
| 02_Coin_Acceptor | 1 | online |
| 03_Street_Light | 2 | online |
| 04_QR_Scanner | 3 | online |
| 05_Water_Level | 4 | online |
| 06_Transaction_Upload | 5 | online |
| 07_Status_Upload | 6 | online |

---

## Common Troubleshooting

| Symptom | Command |
|---------|---------|
| Process keeps restarting | `sudo pm2 logs <name> --lines 50` |
| GUI not fullscreen on boot | `sudo systemctl restart vendo_gui.service` |
| `config.env` not found | `ls $PROJECT_DIR/CONFIG/config.env` — copy from `config.env.sample` if missing |
| coin_slot won't start | `$PROJECT_DIR/coin_slot/main` — run manually to see raw error |
| PM2 processes lost after reboot | `sudo pm2 save` was not run — repeat step 5 |
| Serial port not found (coin acceptor) | `ls /dev/ttyACM* /dev/ttyUSB*` — check Arduino is plugged in |
