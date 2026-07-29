/**
 * Sabon Vendo — Cashier Dashboard Server (v2)
 *
 * - Serves the tap-based dashboard UI
 * - TCP proxy to coin_slot with auto-reconnect
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
// TCP client to coin_slot
// ---------------------------------------------------------------------------

function connectToCoinSlot() {
  if (coinSocket) { try { coinSocket.destroy(); } catch (_) {} }

  console.log(`[dashboard] Connecting to coin_slot at ${SOCKET_IP}:${SOCKET_PORT}...`);
  coinSocket = new net.Socket();

  coinSocket.connect(SOCKET_PORT, SOCKET_IP, () => {
    console.log(`[dashboard] Connected to coin_slot`);
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
    if (statusBuffer.startsWith('STATUS')) {
      broadcastSSE(statusBuffer);
      statusBuffer = '';
    }
  });

  coinSocket.on('error', (err) => {
    console.error(`[dashboard] coin_slot error: ${err.message}`);
  });

  coinSocket.on('close', () => {
    console.log('[dashboard] coin_slot disconnected — reconnecting in 3s...');
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
    coinSocket.write(command);
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
    try { coinSocket.write(cmd); console.log(`[dashboard] Flushed: ${cmd}`); }
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
function pushUnclaimed(slot, qty, amount) {
  const ts = new Date().toISOString();
  const msg = `UNCLAIMED:${slot},${qty},${amount},${ts}`;
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
    res.write(`data: UNCLAIMED:${u.slot},${u.qty},${u.amount},${u.time}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[dashboard] SSE client disconnected (${sseClients.size} total)`);
  });
});

// ARM endpoint — with sale ID + double-click guard
app.post('/api/arm', (req, res) => {
  const { saleId, items } = req.body;

  if (!saleId) {
    return res.status(400).json({ error: 'Missing saleId' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  // Double-click guard
  if (processedSaleIds.has(saleId)) {
    console.log(`[dashboard] Duplicate sale ignored: ${saleId}`);
    return res.json({ results: [], duplicate: true });
  }
  processedSaleIds.add(saleId);

  // Cleanup old IDs (keep last 1000)
  if (processedSaleIds.size > 1000) {
    const it = processedSaleIds.values();
    for (let i = 0; i < 500; i++) processedSaleIds.delete(it.next().value);
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

// Cancel armed slot
app.post('/api/cancel', (req, res) => {
  const { productId } = req.body;
  // Future: send CANCEL,<productId> to coin_slot
  console.log(`[dashboard] Cancel requested for slot ${productId}`);
  res.json({ success: false, error: 'Cancel command not yet implemented in coin_slot' });
});

// Resolve unclaimed sale
app.post('/api/unclaimed/resolve', (req, res) => {
  const { slot, qty, amount, action } = req.body;
  console.log(`[dashboard] Resolving unclaimed: slot=${slot} qty=${qty} action=${action}`);

  if (action === 'retry') {
    // Re-arm the slot
    sendToCoinSlot(`ARM,${slot},${qty}`);
  }
  // Either way, remove from unclaimed list
  const idx = unclaimedSales.findIndex(u => u.slot === slot && u.qty === qty && u.amount === amount);
  if (idx >= 0) unclaimedSales.splice(idx, 1);
  saveUnclaimed();

  res.json({ success: true });
});

// Track unclaimed sale (called internally or via SSE status parsing)
function trackUnclaimed(slot, qty, amount) {
  const entry = { slot, qty, amount, time: new Date().toISOString() };
  unclaimedSales.push(entry);
  saveUnclaimed();
  pushUnclaimed(slot, qty, amount);
  console.log(`[dashboard] Unclaimed sale tracked: slot=${slot} qty=${qty} amount=${amount}`);
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
  console.log(`[dashboard] Config: coin_slot at ${SOCKET_IP}:${SOCKET_PORT}`);
  connectToCoinSlot();
});
