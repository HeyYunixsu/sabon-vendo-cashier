/**
 * Sabon Vendo — Cashier Dashboard Server (v2)
 *
 * - Serves the tap-based dashboard UI
 * - TCP proxy to controller with auto-reconnect
 * - SSE for live STATUS pushes to the browser
 * - Sale IDs + double-click guard
 * - Local ARM queue (retry on reconnect)
 * - Unclaimed sale tracking
 */

const express = require('express');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv(filepath) {
  const vars = {};
  try {
    const lines = fs.readFileSync(filepath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      let key = trimmed.substring(0, eq).trim();
      let val = trimmed.substring(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key) vars[key] = val;
    }
    return vars;
  } catch (e) {
    console.error(`[dashboard] Could not load config: ${e.message}`);
    return vars;
  }
}

const CONFIG_PATH = path.resolve(__dirname, '..', 'CONFIG', 'config.env');
const config = loadEnv(CONFIG_PATH);
const SOCKET_IP   = config.SOCKET_IP   || '127.0.0.1';
const SOCKET_PORT = parseInt(config.SOCKET_PORT || '8080', 10);
const HTTP_PORT   = parseInt(config.DASHBOARD_PORT || '80', 10);
const DASHBOARD_PIN = (config.DASHBOARD_PIN || '').trim();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const sseClients = new Set();
const processedSaleIds = new Set();      // double-click guard
const localArmQueue = [];                // queued ARM commands (offline retry)
const unclaimedSales = [];               // unclaimed / needs-attention
let coinSocket = null;
let statusBuffer = '';

// Persistence file for unclaimed sales
const UNCLAIMED_FILE = path.resolve(__dirname, '.unclaimed_sales.json');
try {
  if (fs.existsSync(UNCLAIMED_FILE)) {
    const saved = JSON.parse(fs.readFileSync(UNCLAIMED_FILE, 'utf-8'));
    if (Array.isArray(saved)) unclaimedSales.push(...saved);
    console.log(`[dashboard] Loaded ${saved.length} unclaimed sales from disk`);
  }
} catch (e) { /* ignore */ }

function saveUnclaimed() {
  try {
    fs.writeFileSync(UNCLAIMED_FILE, JSON.stringify(unclaimedSales), 'utf-8');
  } catch (e) {
    console.error(`[dashboard] Failed to save unclaimed sales: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// TCP client to controller
// ---------------------------------------------------------------------------

function connectToCoinSlot() {
  if (coinSocket) { try { coinSocket.destroy(); } catch (_) {} }

  console.log(`[dashboard] Connecting to controller at ${SOCKET_IP}:${SOCKET_PORT}...`);
  coinSocket = new net.Socket();

  coinSocket.connect(SOCKET_PORT, SOCKET_IP, () => {
    console.log(`[dashboard] Connected to controller`);
    // Flush any locally queued ARM commands
    flushLocalQueue();
  });

  coinSocket.on('data', (data) => {
    statusBuffer += data.toString();
    const lines = statusBuffer.split('\n');
    statusBuffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('STATUS')) {
        broadcastSSE(line);
      }
    }
    // Whatever is left is an incomplete line. Keep it for the next chunk --
    // broadcasting it here would emit a truncated STATUS and orphan the
    // continuation bytes, corrupting the following parse.
    if (statusBuffer.length > 64 * 1024) {
      console.error('[dashboard] controller sent 64KB with no newline — dropping buffer');
      statusBuffer = '';
    }
  });

  coinSocket.on('error', (err) => {
    console.error(`[dashboard] controller error: ${err.message}`);
  });

  coinSocket.on('close', () => {
    console.log('[dashboard] controller disconnected — reconnecting in 3s...');
    coinSocket = null;
    setTimeout(connectToCoinSlot, 3000);
  });
}

function sendToCoinSlot(command) {
  if (!coinSocket || coinSocket.destroyed) {
    console.log(`[dashboard] Offline — queuing command: ${command}`);
    localArmQueue.push(command);
    return false;
  }
  try {
    // The controller frames on newlines. Without the terminator a command sits
    // in its buffer forever, and two commands sent close together arrive as one.
    coinSocket.write(command.endsWith('\n') ? command : command + '\n');
    console.log(`[dashboard] Sent: ${command}`);
    return true;
  } catch (e) {
    console.error(`[dashboard] Send error: ${e.message}`);
    localArmQueue.push(command);
    return false;
  }
}

function flushLocalQueue() {
  if (localArmQueue.length === 0) return;
  console.log(`[dashboard] Flushing ${localArmQueue.length} queued ARM commands...`);
  while (localArmQueue.length > 0) {
    const cmd = localArmQueue.shift();
    try { coinSocket.write(cmd.endsWith('\n') ? cmd : cmd + '\n'); console.log(`[dashboard] Flushed: ${cmd}`); }
    catch (e) { localArmQueue.unshift(cmd); break; }
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function broadcastSSE(data) {
  const payload = `data: ${data}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

// Push unclaimed sales to SSE clients
function pushUnclaimed(slot, qty) {
  const ts = new Date().toISOString();
  const msg = `UNCLAIMED:${slot},${qty},${ts}`;
  for (const res of sseClients) {
    try { res.write(`data: ${msg}\n\n`); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API authentication
//
// Every /api route can arm a pump, so without this anyone who can reach the
// dashboard's IP can dispense product for free. The static page is left open
// deliberately: it is just the shell, and the PIN prompt it shows is a
// convenience. This middleware is the actual gate.
//
// EventSource cannot set request headers, so the SSE endpoint accepts the PIN
// as a query parameter as well.
//
// A blank DASHBOARD_PIN disables the check, so upgrading an existing machine
// cannot lock the cashier out before the key is added to config.env.
// ---------------------------------------------------------------------------
if (!DASHBOARD_PIN) {
  console.warn('[dashboard] WARNING: DASHBOARD_PIN is not set in CONFIG/config.env.');
  console.warn('[dashboard] The API is unauthenticated — anyone on this network can arm pumps.');
} else {
  console.log('[dashboard] API protected by DASHBOARD_PIN');
}

// Deliberately outside /api and unauthenticated: it reveals only WHETHER a PIN
// is required, never the PIN. The page needs this to decide between showing the
// unlock gate and loading straight through on a machine that has none set.
app.get('/auth-status', (req, res) => res.json({ required: !!DASHBOARD_PIN }));

app.use('/api', (req, res, next) => {
  if (!DASHBOARD_PIN) return next();
  const supplied = req.get('X-Dashboard-Pin') || req.query.pin || '';
  if (supplied === DASHBOARD_PIN) return next();
  console.warn(`[dashboard] Rejected unauthenticated ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ error: 'unauthorized' });
});

// Cheapest possible gated route. The page probes it after a dropped stream to
// tell "the PIN is wrong" apart from "the server restarted" -- EventSource
// reports both as a bare error event with no status code.
app.get('/api/ping', (req, res) => res.json({ ok: true }));

// SSE endpoint
app.get('/api/status/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  console.log(`[dashboard] SSE client connected (${sseClients.size} total)`);

  // Push existing unclaimed sales to new client
  for (const u of unclaimedSales) {
    res.write(`data: UNCLAIMED:${u.slot},${u.qty},${u.time}\n\n`);
  }

  // Keep-alive heartbeat every 15s so the browser doesn't time out
  const keepAlive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`[dashboard] SSE client disconnected (${sseClients.size} total)`);
  });
});

// ARM endpoint — supports batch mode (ARM_BATCH) for simultaneous arming
app.post('/api/arm', (req, res) => {
  const { saleId, items, batch } = req.body;

  if (!saleId) {
    return res.status(400).json({ error: 'Missing saleId' });
  }

  // Double-click guard
  if (processedSaleIds.has(saleId)) {
    console.log(`[dashboard] Duplicate sale ignored: ${saleId}`);
    return res.json({ success: false, duplicate: true });
  }
  processedSaleIds.add(saleId);
  if (processedSaleIds.size > 1000) {
    const it = processedSaleIds.values();
    for (let i = 0; i < 500; i++) processedSaleIds.delete(it.next().value);
  }

  // New batch mode: ARM_BATCH,1:3,2:1,3:5 (atomic, simultaneous)
  if (batch) {
    const command = `ARM_BATCH,${batch}`;
    const sent = sendToCoinSlot(command);
    return res.json({ success: sent, queued: !sent, saleId });
  }

  // Legacy mode: individual ARM per product
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items or batch provided' });
  }

  const results = [];
  for (const item of items) {
    const { productId, qty } = item;
    if (!productId || productId < 1 || productId > 6) {
      results.push({ productId, success: false, error: `Invalid product ID: ${productId}` });
      continue;
    }
    if (!qty || qty < 1) {
      results.push({ productId, success: false, error: `Invalid qty: ${qty}` });
      continue;
    }
    const command = `ARM,${productId},${qty}`;
    const sent = sendToCoinSlot(command);
    results.push({ productId, qty, success: sent, queued: !sent });
  }

  res.json({ saleId, results });
});

// Cancel single armed slot
app.post('/api/cancel', (req, res) => {
  const { productId } = req.body;
  const sent = sendToCoinSlot(`CANCEL,${productId}`);
  console.log(`[dashboard] CANCEL slot ${productId}: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// Cancel all armed slots + clear all queues
app.post('/api/cancel-all', (req, res) => {
  const sent = sendToCoinSlot('CANCEL_ALL');
  console.log(`[dashboard] CANCEL_ALL: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// Cancel queue for a specific slot
app.post('/api/cancel-queue', (req, res) => {
  const { productId } = req.body;
  const sent = sendToCoinSlot(`CANCEL_QUEUE,${productId}`);
  console.log(`[dashboard] CANCEL_QUEUE slot ${productId}: ${sent ? 'sent' : 'queued'}`);
  res.json({ success: sent });
});

// Resolve unclaimed sale
app.post('/api/unclaimed/resolve', (req, res) => {
  const { slot, qty, action } = req.body;
  console.log(`[dashboard] Resolving unclaimed: slot=${slot} qty=${qty} action=${action}`);

  if (action === 'retry') {
    // Re-arm the slot
    sendToCoinSlot(`ARM,${slot},${qty}`);
  }
  // Either way, remove from unclaimed list
  const idx = unclaimedSales.findIndex(u => u.slot === slot && u.qty === qty);
  if (idx >= 0) unclaimedSales.splice(idx, 1);
  saveUnclaimed();

  res.json({ success: true });
});

// Track unclaimed sale (called internally or via SSE status parsing)
function trackUnclaimed(slot, qty) {
  const entry = { slot, qty, time: new Date().toISOString() };
  unclaimedSales.push(entry);
  saveUnclaimed();
  pushUnclaimed(slot, qty);
  console.log(`[dashboard] Unclaimed sale tracked: slot=${slot} qty=${qty}`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// QR code endpoint — encodes current LAN URL so cashier can scan with phone
const os = require('os');
function getLanUrl() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return `http://${iface.address}:${HTTP_PORT}`;
      }
    }
  }
  return `http://localhost:${HTTP_PORT}`;
}

app.get('/qr', (req, res) => {
  const url = getLanUrl();
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  res.redirect(qrApi);
});

app.listen(HTTP_PORT, () => {
  const lanUrl = getLanUrl();
  console.log(`[dashboard] Cashier Dashboard running on ${lanUrl}`);
  console.log(`[dashboard] QR code: ${lanUrl}/qr`);
  console.log(`[dashboard] Config: controller at ${SOCKET_IP}:${SOCKET_PORT}`);
  connectToCoinSlot();
});
