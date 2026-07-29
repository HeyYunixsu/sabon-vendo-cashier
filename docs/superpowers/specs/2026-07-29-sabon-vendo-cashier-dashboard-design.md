# Sabon Vendo — Cashier Dashboard Design

**Date:** 2026-07-29
**Status:** Approved

## Overview

Convert the sabon_express_dispenser from a coin/voucher-based shared-credit model to a cashier-dashboard-controlled system where credit is pinned per-product-slot. The cashier and vendo machine are separate physical units on the same LAN.

## Architecture Change

**Before:** Customer inserts coins/scans QR → shared credit pool → any button dispenses
**After:** Cashier clicks product(s) on dashboard → per-slot ARM commands → only armed buttons dispense

## What Gets Removed

| Component | Reason |
|-----------|--------|
| `arduino_firmware/` | Coin acceptor/vendo firmware no longer needed |
| `keyboard_monitoring/` | QR scanner input replaced by cashier dashboard |
| `usb_to_coin_module/coin_counter.py` | Arduino coin serial reader replaced |
| `uploaderTransaction/qr_gen.py` | Voucher QR generation removed |
| `iot_dispenser_v2/` | Customer-facing FLTK GUI replaced by dashboard |
| `coin_slot/src/voucher_manager.cpp/.h` | Voucher queue replaced by per-slot armed state |

## What Stays

- `coin_slot` core: pump control, water-level protection, transaction JSON logging, socket server
- `usb_to_coin_module/simple_on_off_led_relay.py`: streetlight control
- `uploaderTransaction/`: water_level_monitoring_v2.py, uploader.py, status_uploader.py

## Core State Model Change

**Old:** `int coinCredit` — single shared pool, any button spends from it
**New:** `int armedQty[7]` — per-slot (1-6, 1-4 active), only armed slots dispense

## Socket Protocol Changes

**Removed:** `COIN,<amount>`, `VOUCHER,<id>,<amount>`
**Added:** `ARM,<productId>,<qty>` — one per product in a sale
**Updated:** `STATUS` response now reports per-slot armed qty + queue depth

## Hardware Changes

- New LED GPIO pins per slot (1-6), driven HIGH while `armedQty[slot] > 0`
- Only slots 1-4 wired initially; 5-6 reserved

## New Component: Cashier Dashboard

- Local web app (HTML + backend TCP client to coin_slot)
- Product grid: 6 tiles, 2 marked "Not Available"
- Sale entry: pick product(s), enter amount, send one ARM per product
- Status bar, armed-slots panel, queue view, alerts

## Implementation Phases

1. **Prep** — backup, baseline build
2. **Remove** — delete payment components, update scripts
3. **State model** — armedQty array, per-slot queues
4. **Hardware config** — LED pins, config.env updates
5. **Socket protocol** — ARM command, updated STATUS
6. **Dispense trigger** — per-slot credit check, LED output, queue handling
7. **Voucher manager** — remove entirely
8. **Tests** — rewrite for new model
9. **Dashboard** — build web app
10. **Verification** — single/multi-product sales, queue behavior, slot-empty protection
